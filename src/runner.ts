// Runner: spawn the Claude Code CLI headless against the capsule workspace.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Capsule } from './capsule.js';

export interface RunnerOptions {
  readonly agentBin: string;          // e.g. "node /path/cli-node.js" or "claude"
  readonly agentModel: string | undefined;
  readonly mcpConfigPath: string;
  readonly timeoutMs: number;         // step budget, from the dispatch/step config
  readonly onProgress: (summary: string) => void;
  /** Native engine session to continue (Claude Code --resume). */
  readonly resumeSessionId: string | undefined;
  /** Fires as soon as the engine reports its session id (stream-json init). */
  readonly onSessionId: ((sessionId: string) => void) | undefined;
}

export interface RunnerResult {
  readonly success: boolean;
  readonly summary: string;
  readonly error: string | undefined;
  readonly sessionId: string | undefined;
}

/** Optional alternative engine: a local Claude Code build runnable via `node <cli.js>`. */
const CCB_FALLBACK = join(homedir(), 'project/claude-code-best/claude-code/dist/cli-node.js');

/**
 * Resolve the engine command.
 * - "default" (or empty) → official `claude` CLI on PATH; falls back to a local
 *   build path when present (useful during development).
 * - "node::<path>"      → `node <path>`.
 * - anything else        → used verbatim as command + args (e.g. "npx -y @qoder/qoder-cli").
 */
function resolveAgentCommand(agentBin: string): { command: string; args: string[] } {
  if (agentBin === 'default' || agentBin === 'node::default' || agentBin.length === 0) {
    if (existsSync(CCB_FALLBACK)) return { command: 'node', args: [CCB_FALLBACK] };
    return { command: 'claude', args: [] };
  }
  if (agentBin.startsWith('node::')) {
    return { command: 'node', args: [agentBin.slice('node::'.length)] };
  }
  const parts = agentBin.split(/\s+/);
  const command = parts[0];
  if (command === undefined || command.length === 0) return { command: 'claude', args: [] };
  return { command, args: parts.slice(1) };
}

export async function runAgent(capsule: Capsule, prompt: string, options: RunnerOptions): Promise<RunnerResult> {
  await mkdir(capsule.workspaceDir, { recursive: true });
  await mkdir(join(capsule.artifactsDir, 'deliverables'), { recursive: true });

  const { command, args: binArgs } = resolveAgentCommand(options.agentBin);
  const args = [
    ...binArgs,
    '-p', prompt,
    '--mcp-config', options.mcpConfigPath,
    '--allowedTools', 'mcp__autowonder__* Read Write Edit Bash LS Grep Glob',
    '--permission-mode', 'bypassPermissions',
    // stream-json gives us the engine session id up front (for crash-resume
    // via --resume) plus structured progress and a machine-readable result.
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  if (options.agentModel) args.push('--model', options.agentModel);

  options.onProgress(
    `agent.started bin=${command} model=${options.agentModel ?? 'default'}`
    + (options.resumeSessionId ? ` resume=${options.resumeSessionId}` : ''));


  return await new Promise<RunnerResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: capsule.root, // agent works inside the capsule; deliverables under artifacts/
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';          // raw fallback when no parsable result event
    let stderr = '';
    let stdoutTail = '';      // line buffer for stream-json events
    let sessionId: string | undefined;
    let resultText: string | undefined;
    let resultIsError = false;
    let resultErrors = '';
    const startedAt = Date.now();
    let lastProgressAt = 0;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // engine banner / non-JSON noise
      }
      if (typeof event.session_id === 'string' && sessionId === undefined) {
        sessionId = event.session_id;
        options.onSessionId?.(sessionId);
      }
      if (event.type === 'assistant') {
        const message = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const text = message?.content?.find((part) => part.type === 'text')?.text;
        if (text && Date.now() - lastProgressAt > 5_000) {
          lastProgressAt = Date.now();
          options.onProgress(`agent.turn ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
        }
      }
      if (event.type === 'result') {
        if (typeof event.result === 'string') resultText = resultText ?? event.result;
        if (event.is_error === true) resultIsError = true;
        // Engines report early failures (e.g. --resume target missing) on the
        // result event's errors[] with exit code 0 — surface them verbatim.
        if (Array.isArray(event.errors)) {
          resultErrors = event.errors.filter((e) => typeof e === 'string').join('; ').slice(0, 500);
        }
      }
    };

    const timer = setTimeout(() => {
      options.onProgress('agent.timeout budget exceeded, killing');
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      stdoutTail += text;
      const lines = stdoutTail.split('\n');
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ success: false, summary: `agent spawn failed: ${error.message}`, error: error.message, sessionId });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      consumeLine(stdoutTail); // final unterminated event, if any
      const durationS = Math.round((Date.now() - startedAt) / 1000);
      if (code === 0 && !resultIsError) {
        options.onProgress(`agent.finished exit=0 duration=${durationS}s session=${sessionId ?? '?'}`);
        resolve({
          success: true,
          summary: (resultText ?? stdout.trim() ?? '').slice(0, 2000) || 'agent completed with no output',
          error: undefined,
          sessionId,
        });
      } else {
        options.onProgress(`agent.finished exit=${code} duration=${durationS}s session=${sessionId ?? '?'}`);
        resolve({
          success: false,
          summary: (resultText ?? stdout.trim() ?? '').slice(0, 1000),
          error: resultIsError
            ? (resultErrors || `agent reported error: ${(resultText ?? '').slice(0, 500)}`)
            : `agent exited ${code}: ${stderr.trim().slice(0, 500)}`,
          sessionId,
        });
      }
    });
  });
}

/** Read handoff-proposal.json written by the agent, if any. */
export async function readHandoffProposal(capsule: Capsule): Promise<{ to: string; toType: string; nextRole: string; reason: string } | undefined> {
  try {
    const raw = await import('node:fs/promises').then((m) => m.readFile(join(capsule.artifactsDir, 'handoff-proposal.json'), 'utf8'));
    const parsed = JSON.parse(raw) as { nextOwner?: unknown; nextRole?: unknown; summary?: unknown; toType?: unknown };
    if (typeof parsed.nextOwner !== 'string' || parsed.nextOwner.length === 0) return undefined;
    return {
      to: parsed.nextOwner,
      toType: parsed.toType === 'HUMAN' ? 'HUMAN' : 'AGENT',
      nextRole: typeof parsed.nextRole === 'string' ? parsed.nextRole : parsed.nextOwner,
      reason: typeof parsed.summary === 'string' ? parsed.summary : '',
    };
  } catch {
    return undefined;
  }
}
