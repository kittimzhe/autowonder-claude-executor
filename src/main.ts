// awce — AutoWonder community-edition executor with a Claude Code engine.
// Full pipeline: DISPATCH → ACK → capsule → prompt → agent → artifacts → RESULT (+HANDOFF).

import { authenticatedWsUrl, httpBase, loadConfig, type AwceConfig } from './config.js';
import { buildCapsule, writeMcpConfig } from './capsule.js';
import { buildPrompt } from './prompt.js';
import { readHandoffProposal, runAgent } from './runner.js';
import { uploadArtifacts } from './artifacts.js';
import { WsClient } from './ws.js';
import type { TaskDispatchFrame } from './frames.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

function makeLogger(threshold: 'debug' | 'info' | 'warn' | 'error'): Log {
  return (level, message) => {
    if (LEVELS[level] >= LEVELS[threshold]) {
      const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
      (level === 'error' ? console.error : console.log)(line);
    }
  };
}

const AWCE_VERSION = '0.3.0';

/** Dispatches already seen in this process — protocol requires idempotency by dispatchId. */
const seenDispatches = new Set<number>();
let inFlight = false; // single-slot concurrency for the MVP

/** Inventory state reported via HEARTBEAT (dispatch_inventory_v1). */
const runningDispatches = new Set<number>();
const ownedDispatches = new Set<number>();

async function handleDispatch(client: WsClient, config: AwceConfig, frame: TaskDispatchFrame, log: Log): Promise<void> {
  if (seenDispatches.has(frame.dispatchId)) {
    log('warn', `duplicate TASK_DISPATCH ${frame.dispatchId} ignored (idempotent)`);
    return;
  }
  seenDispatches.add(frame.dispatchId);
  ownedDispatches.add(frame.dispatchId);
  if (inFlight) {
    // Honest single-slot rejection: the server will retry/stop per its onFail policy.
    client.send({ type: 'TASK_RESULT', dispatchId: frame.dispatchId, success: false, resultSummary: 'awce busy', error: 'BUSY: single-slot MVP' });
    return;
  }
  inFlight = true;
  runningDispatches.add(frame.dispatchId);

  const stage = (name: string) => log('info', `[d${frame.dispatchId}] ${name}`);
  const progress = (summary: string) => client.send({ type: 'TASK_PROGRESS', dispatchId: frame.dispatchId, resultSummary: summary });

  try {
    stage(`dispatch received workitem=${frame.workitemId} attempt=${frame.attempt} policy(commit=${frame.allowCommit},push=${frame.allowPush},net=${frame.allowNetwork})`);
    client.send({ type: 'TASK_ACK', dispatchId: frame.dispatchId });

    const capsule = await buildCapsule(frame, config.workspaceRoot, (m) => { stage(m); progress(`capsule ${m}`); });
    const mcpConfigPath = await writeMcpConfig(capsule, httpBase(config), frame.dispatchMcpToken);
    stage(`mcp-config ready (${mcpConfigPath})`);

    const prompt = await buildPrompt(capsule);
    stage(`prompt assembled (${prompt.length} chars)`);

    const result = await runAgent(capsule, prompt, {
      agentBin: config.agentBin,
      agentModel: config.agentModel,
      mcpConfigPath,
      timeoutMs: 30 * 60 * 1000,
      onProgress: progress,
    });
    stage(`agent done success=${result.success}`);

    const upload = await uploadArtifacts(frame, httpBase(config), config.executorToken, capsule.artifactsDir, (m) => stage(`artifacts: ${m}`));

    // Community edition note: SdlcDriver.onSuccess is a stub (always stop) and the
    // packaged sdlc.json omits onSuccess — TASK_HANDOFF is THE relay mechanism, so
    // any agent-written proposal is sent unconditionally.
    const handoff = await readHandoffProposal(capsule);
    if (handoff) stage(`handoff proposal: to=${handoff.to} (${handoff.toType})`);

    client.send({
      type: 'TASK_RESULT',
      dispatchId: frame.dispatchId,
      success: result.success && upload.ok,
      resultSummary: `${result.summary}\n[awce] artifacts: ${upload.receipts.filter((r) => r.status === 'ACCEPTED').length} accepted`,
      ...(result.success
        ? (upload.ok ? {} : { error: `artifact upload failed (HTTP ${upload.httpStatus})` })
        : { error: result.error ?? 'agent step failed' }),
    });
    if (handoff) {
      client.send({
        type: 'TASK_HANDOFF',
        dispatchId: frame.dispatchId,
        workitemId: frame.workitemId,
        to: handoff.to,
        toType: handoff.toType === 'HUMAN' ? 'HUMAN' : 'AGENT',
        nextRole: handoff.nextRole,
        reason: handoff.reason,
      });
    }
    stage('result sent');
  } catch (error) {
    log('error', `[d${frame.dispatchId}] pipeline failed: ${(error as Error).message}`);
    client.send({
      type: 'TASK_RESULT',
      dispatchId: frame.dispatchId,
      success: false,
      resultSummary: 'awce pipeline error',
      error: (error as Error).message.slice(0, 500),
    });
  } finally {
    runningDispatches.delete(frame.dispatchId);
    inFlight = false;
  }
}

function main(): void {
  const config = loadConfig();
  const log = makeLogger(config.logLevel);
  log('info', `awce starting executor=${config.executorId} ws=${config.wsUrl} engine=${config.agentBin}${config.agentModel ? ` model=${config.agentModel}` : ''}`);

  const client = new WsClient(
    authenticatedWsUrl(config),
    {
      onDispatch: (frame) => { void handleDispatch(client, config, frame, log); },
      onFrame: (frame) => {
        if (frame.type === 'TASK_HANDOFF_RESULT') {
          log('info', `handoff result d${frame.dispatchId}: status=${frame.status ?? '?'}`
            + `${frame.downstreamDispatchId ? ` downstream=d${frame.downstreamDispatchId}` : ''}`
            + `${frame.reasonCode ? ` reason=${frame.reasonCode}` : ''}${frame.message ? ` (${frame.message})` : ''}`);
        } else if (frame.type === 'TASK_RESULT_ACK') {
          log('info', `result ack d${frame.dispatchId}: accepted=${frame.accepted ?? '?'}`);
        }
      },
      onStateChange: (state) => log('info', `executor ${state}`),
      // dispatch_inventory_v1: report capacity + running/owned dispatch ids so the
      // server renews active leases (renewActiveLeases) instead of reclaiming
      // long-running steps as dead.
      getInventory: () => ({
        maxConcurrentDispatches: config.maxConcurrent,
        dispatchInventoryReady: true,
        runningDispatchIds: [...runningDispatches],
        ownedDispatchIds: [...ownedDispatches].slice(-1000), // newest 1000, server cap
        runningConversationTurnIds: [],
      }),
      getVersion: () => AWCE_VERSION,
      getModel: () => config.agentModel ?? 'default',
    },
    (level, message) => log(level, message),
  );

  const shutdown = (signal: string) => {
    log('info', `received ${signal}, shutting down`);
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  client.start();
}

main();
