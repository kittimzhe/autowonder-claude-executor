// Assemble the agent prompt from capsule materials.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capsule } from './capsule.js';

async function readIfExists(path: string, limitBytes = 64 * 1024): Promise<string | undefined> {
  try {
    const buffer = await readFile(path);
    return buffer.subarray(0, limitBytes).toString('utf8');
  } catch {
    return undefined;
  }
}

export async function buildPrompt(capsule: Capsule): Promise<string> {
  const pkg = capsule.packageDir;
  const parts: string[] = [];

  // 1. Identity.
  const identityRaw = await readIfExists(join(pkg, 'identity.json'));
  const identity = identityRaw ? safeJson(identityRaw) : undefined;
  parts.push(
    identity
      ? `You are ${identity.roleName ?? 'a developer'} (role: ${identity.roleCode ?? 'developer'}), a digital worker on the AutoWonder platform.\n${identity.agentMd ?? identity.responsibilities ?? identity.businessBackground ?? ''}`
      : 'You are a digital worker on the AutoWonder platform executing one SDLC step.',
  );

  // 2. Current SDLC step.
  const sdlcRaw = await readIfExists(join(pkg, 'sdlc.json'));
  const sdlc = sdlcRaw ? safeJson(sdlcRaw) : undefined;
  const steps = Array.isArray(sdlc?.steps) ? sdlc.steps : [];
  const currentStep = typeof sdlc?.currentStepId === 'number'
    ? steps.find((s: { id?: number }) => s.id === sdlc.currentStepId)
    : steps[0];
  if (currentStep) {
    parts.push(
      `## Your task for THIS step\nStep: ${currentStep.name ?? 'implement'} (${currentStep.kind ?? ''})\n`
      + `${currentStep.instructionMd ?? ''}\n`
      + `${currentStep.checklistJson ? `Checklist: ${typeof currentStep.checklistJson === 'string' ? currentStep.checklistJson : JSON.stringify(currentStep.checklistJson)}\n` : ''}`,
    );
  }

  // 3. Workitem body + comments.
  const workitem = await readIfExists(join(pkg, 'workitem.md'));
  if (workitem) parts.push(`## Workitem\n${workitem}`);
  const comments = await readIfExists(join(pkg, 'comments.md')) ?? await readIfExists(join(pkg, 'context/comments-index.md'));
  if (comments) parts.push(`## Comments\n${comments}`);

  // 4. Memory (bounded).
  const memoryDir = join(pkg, 'memory');
  const memoryFiles = (await readdir(memoryDir).catch(() => []))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .slice(0, 50);
  if (memoryFiles.length > 0) {
    const chunks: string[] = [];
    for (const file of memoryFiles) {
      const text = await readIfExists(join(memoryDir, file), 16 * 1024);
      if (text) chunks.push(`### ${file}\n${text}`);
    }
    if (chunks.length > 0) parts.push(`## Relevant memory\n${chunks.join('\n\n')}`);
  }

  // 5. Teammate conclusions (previous rounds).
  const teammatesDir = join(pkg, 'teammates');
  const teammateDirs = await readdir(teammatesDir, { withFileTypes: true }).catch(() => []);
  const conclusions: string[] = [];
  for (const entry of teammateDirs) {
    if (!entry.isDirectory()) continue;
    const text = await readIfExists(join(teammatesDir, entry.name, 'conclusion.md'), 16 * 1024);
    if (text) conclusions.push(`### ${entry.name}\n${text}`);
  }
  if (conclusions.length > 0) parts.push(`## Previous rounds (teammates)\n${conclusions.join('\n\n')}`);

  // 6. Roster (for handoff decisions).
  const roster = await readIfExists(join(pkg, 'roster.json'));
  if (roster) parts.push(`## Team roster (for handoff decisions)\n${roster}`);

  // 7. Output contract.
  parts.push(
    `## Output contract\n`
    + `- Work in the current directory; it is your private workspace for this dispatch.\n`
    + `- Write deliverable files into \`artifacts/deliverables/\` (create subdirectories as needed).\n`
    + `- If the work should continue with another agent (e.g. review after implementation), write \`artifacts/handoff-proposal.json\` with fields: nextOwner (a role code such as "developer" or "reviewer"), toType ("AGENT" or "HUMAN"), summary. Your platform relays it to the next worker.\n`
    + `- When done, reply with a short summary of what you delivered.\n`
    + `- You may use the \`autowonder\` MCP tools (memory, workitem context) when helpful.\n`
    + `- The platform's policy for this dispatch: commit/push/network may be disabled — do local work only unless explicitly allowed.`,
  );

  return parts.join('\n\n---\n\n');
}


function safeJson(raw: string): Record<string, unknown> | undefined {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
}
