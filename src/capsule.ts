// Capsule: download the task package, verify integrity, extract for the runner.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TaskDispatchFrame } from './frames.js';
import { verifyDispatchSignature } from './signature.js';

export interface CapsuleManifest {
  readonly schemaVersion: string; // autoWonder.taskPackage.v1
  readonly packageId: string;
  readonly tenantId: string;
  readonly workitemId: string;
  readonly dispatchId: string;
  readonly attempt: number;
  readonly fileDigests?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export interface Capsule {
  readonly root: string;
  /** Stable per-(workitem, step) dir shared across attempts: native engine
   *  sessions are keyed by cwd, so retries must run from the SAME directory
   *  for Claude Code --resume to find the dead attempt's conversation. */
  readonly sessionDir: string;
  readonly packageDir: string;
  readonly workspaceDir: string;
  readonly artifactsDir: string;
  readonly manifest: CapsuleManifest;
}

async function unzipInto(zipBytes: Buffer, targetDir: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const os = await import('node:os');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const tmpZip = join(os.tmpdir(), `awce-${Date.now()}.zip`);
  writeFileSync(tmpZip, zipBytes);
  try {
    // Task packages may contain non-ASCII paths (e.g. teammates/开发工程师/…).
    // macOS's bundled Info-ZIP `unzip` mishandles UTF-8 entry names ("Illegal
    // byte sequence"), so prefer Python's zipfile (correct EFS handling) and
    // keep `unzip` only as a fallback where python3 is absent.
    try {
      await run('python3', ['-m', 'zipfile', '-e', tmpZip, targetDir]);
    } catch {
      await run('unzip', ['-o', '-q', tmpZip, '-d', targetDir]);
    }
  } finally {
    unlinkSync(tmpZip);
  }
}

export async function buildCapsule(
  frame: TaskDispatchFrame,
  workspaceRoot: string,
  log: (message: string) => void,
  httpBase: string = '',
  executorToken: string = '',
): Promise<Capsule> {
  const root = join(workspaceRoot, String(frame.tenantId), String(frame.workitemId), String(frame.dispatchId), `attempt-${frame.attempt}`);
  const sessionDir = join(workspaceRoot, String(frame.tenantId), String(frame.workitemId), `session-${frame.sdlcStepId}`);
  const packageDir = join(root, 'package');
  const workspaceDir = join(root, 'workspace');
  const artifactsDir = join(root, 'artifacts');

  await rm(root, { recursive: true, force: true });
  await mkdir(packageDir, { recursive: true });
  await mkdir(join(artifactsDir, 'deliverables'), { recursive: true });

  // 1. Download. Presigned URLs expire (10 min TTL) — on failure refresh once
  //    via the frame-provided packageRefreshPath (same executor-token auth).
  log(`downloading ${frame.size}B package ${frame.packageId}`);
  let downloadUrl = frame.downloadUrl;
  let response = await fetch(downloadUrl);
  if (!response.ok && frame.packageRefreshPath) {
    log(`download failed (HTTP ${response.status}); refreshing package URL`);
    const refreshed = await fetch(`${httpBase}${frame.packageRefreshPath}?token=${encodeURIComponent(executorToken)}`, { method: 'POST' });
    if (refreshed.ok) {
      const body = await refreshed.json().catch(() => undefined) as { downloadUrl?: string } | undefined;
      if (typeof body?.downloadUrl === 'string' && body.downloadUrl.length > 0) {
        downloadUrl = body.downloadUrl;
        log(`package URL refreshed, retrying`);
        response = await fetch(downloadUrl);
      }
    } else {
      log(`package URL refresh failed: HTTP ${refreshed.status}`);
    }
  }
  if (!response.ok) throw new Error(`package download failed: HTTP ${response.status}`);
  const zipBytes = Buffer.from(await response.arrayBuffer());
  if (zipBytes.length !== frame.size) {
    throw new Error(`package size mismatch: expected ${frame.size}, got ${zipBytes.length}`);
  }

  // 2. Whole-archive md5 (the only hard verification in Phase 1).
  const md5 = createHash('md5').update(zipBytes).digest('hex');
  if (md5 !== frame.md5.toLowerCase()) {
    throw new Error(`package md5 mismatch: expected ${frame.md5}, got ${md5}`);
  }

  // 2b. TASK_PACKAGE_SIGNATURE_V1: sha256 checksum + Ed25519 envelope verification.
  const signature = verifyDispatchSignature(frame, zipBytes);
  if (!signature.ok) {
    throw new Error(`package signature rejected: ${signature.reason}`);
  }
  const signatureNote = signature.reason ?? 'verified (sha256:' + signature.archiveSha256.slice(0, 12) + '…)';
  log(`signature check: ${signatureNote}`);

  // 3. Extract.
  await unzipInto(zipBytes, packageDir);
  log(`extracted package to ${packageDir}`);

  // 4. Manifest + per-file sha256 digests (best-effort hardening beyond Phase 1).
  const manifestPath = join(packageDir, 'manifest.json');
  let manifest: CapsuleManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CapsuleManifest;
  } catch {
    throw new Error('manifest.json missing or invalid');
  }
  if (manifest.schemaVersion !== 'autoWonder.taskPackage.v1') {
    log(`warning: unexpected schemaVersion ${manifest.schemaVersion}`);
  }
  const digests = manifest.fileDigests ?? {};
  let verified = 0;
  for (const [relPath, expected] of Object.entries(digests)) {
    const filePath = join(packageDir, relPath);
    if (!filePath.startsWith(packageDir)) continue; // path traversal guard
    try {
      const sha256 = createHash('sha256').update(await readFile(filePath)).digest('hex');
      const expectedHex = String(expected).replace(/^sha256:/, '');
      if (sha256 !== expectedHex) throw new Error(`sha256 mismatch for ${relPath}`);
      verified += 1;
    } catch (error) {
      throw new Error(`digest verification failed for ${relPath}: ${(error as Error).message}`);
    }
  }
  log(`capsule ready: ${verified}/${Object.keys(digests).length} file digests verified`);

  return { root, sessionDir, packageDir, workspaceDir, artifactsDir, manifest };
}

/** Render the per-dispatch MCP config for the agent process. */
export async function writeMcpConfig(capsule: Capsule, httpBase: string, dispatchMcpToken: string): Promise<string> {
  const config = {
    mcpServers: {
      autowonder: {
        type: 'http' as const,
        url: `${httpBase}/api/mcp`,
        headers: { Authorization: `Bearer ${dispatchMcpToken}` },
      },
    },
  };
  const path = join(capsule.root, 'mcp.config.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

