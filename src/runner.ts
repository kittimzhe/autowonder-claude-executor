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
}

export interface RunnerResult {
  readonly success: boolean;
  readonly summary: string;
  readonly error: string | undefined;
}

const CCB_DEFAULT = join(homedir(), 'project/claude-code-best/claude-code/dist/cli-node.js');

/** Resolve "node::default" to the ccb build present on this machine. */
function resolveAgentCommand(agentBin: string): { command: string; args: string[] } {
  if (agentBin === 'node::default') {
    return existsSync(CCB_DEFAULT)
      ? { command: 'node', args: [CCB_DEFAULT] }
      : { command: 'claude', args: [] };
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
    '--output-format', 'text',
  ];
  if (options.agentModel) args.push('--model', options.agentModel);

  options.onProgress(`agent.started bin=${command} model=${options.agentModel ?? 'default'}`);

  return await new Promise<RunnerResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: capsule.root, // agent works inside the capsule; deliverables under artifacts/
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();
    let lastProgressAt = 0;

    const timer = setTimeout(() => {
      options.onProgress('agent.timeout budget exceeded, killing');
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Date.now() - lastProgressAt > 5_000) {
        lastProgressAt = Date.now();
        options.onProgress(`agent.running stdoutBytes=${stdout.length}`);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ success: false, summary: `agent spawn failed: ${error.message}`, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationS = Math.round((Date.now() - startedAt) / 1000);
      if (code === 0) {
        options.onProgress(`agent.finished exit=0 duration=${durationS}s`);
        resolve({
          success: true,
          summary: (stdout.trim() || 'agent completed with no output').slice(0, 2000),
          error: undefined,
        });
      } else {
        options.onProgress(`agent.finished exit=${code} duration=${durationS}s`);
        resolve({
          success: false,
          summary: (stdout.trim() || '').slice(0, 1000),
          error: `agent exited ${code}: ${stderr.trim().slice(0, 500)}`,
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
