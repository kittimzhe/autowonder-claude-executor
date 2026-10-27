// awce — AutoWonder community-edition executor with a Claude Code engine.
// M1: full frame round-trip (DISPATCH→ACK→PROGRESS→RESULT) without the engine.

import { authenticatedWsUrl, loadConfig } from './config.js';
import { WsClient } from './ws.js';
import type { TaskDispatchFrame } from './frames.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function makeLogger(threshold: 'debug' | 'info' | 'warn' | 'error') {
  return (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
    if (LEVELS[level] >= LEVELS[threshold]) {
      const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
      (level === 'error' ? console.error : console.log)(line);
    }
  };
}

/** Dispatches already seen in this process — protocol requires idempotency by dispatchId. */
const seenDispatches = new Set<number>();

async function handleDispatch(client: WsClient, frame: TaskDispatchFrame, log: ReturnType<typeof makeLogger>): Promise<void> {
  if (seenDispatches.has(frame.dispatchId)) {
    log('warn', `duplicate TASK_DISPATCH ${frame.dispatchId} ignored (idempotent)`);
    return;
  }
  seenDispatches.add(frame.dispatchId);

  log('info', `TASK_DISPATCH dispatch=${frame.dispatchId} workitem=${frame.workitemId} attempt=${frame.attempt} step=${frame.sdlcStepId} package=${frame.size}B policy(commit=${frame.allowCommit},push=${frame.allowPush},net=${frame.allowNetwork}) mcpToken=${frame.dispatchMcpToken.slice(0, 12)}…`);

  client.send({ type: 'TASK_ACK', dispatchId: frame.dispatchId });
  client.send({ type: 'TASK_PROGRESS', dispatchId: frame.dispatchId, resultSummary: 'awce M1 stub: dispatch received, engine not wired yet' });

  // M1 closes the loop honestly: report failure so the server-side SDLC
  // retry/stop logic can act, instead of letting the dispatch hit onTimeout.
  client.send({
    type: 'TASK_RESULT',
    dispatchId: frame.dispatchId,
    success: false,
    resultSummary: 'awce M1 stub received the dispatch; execution engine lands in M3',
    error: 'NOT_IMPLEMENTED: runner pending (see docs/SPEC.md milestones)',
  });
}

function main(): void {
  const config = loadConfig();
  const log = makeLogger(config.logLevel);
  log('info', `awce starting executor=${config.executorId} ws=${config.wsUrl} engine=${config.agentBin}${config.agentModel ? ` model=${config.agentModel}` : ''}`);

  const client = new WsClient(
    authenticatedWsUrl(config),
    {
      onDispatch: (frame) => { void handleDispatch(client, frame, log); },
      onStateChange: (state, detail) => log('info', `executor ${state}${detail ? ` (${detail})` : ''}`),
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
