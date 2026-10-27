// Artifact upload via the daemon HTTP relay channel.
// Contract: POST {artifactUploadPath}?token=… multipart/form-data
//   files[] (multipart filename = relative path, e.g. "deliverables/poem.md")
//   filesMetadata (optional JSON array), idempotencyKey (optional)
// Response: per-file ACCEPTED/REJECTED receipts. Max 200 files / 50MB each.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { TaskDispatchFrame } from './frames.js';

interface FileMetadata {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface UploadReceipt {
  readonly index: number;
  readonly path: string | null;
  readonly status: string;
  readonly reason?: string;
}

export interface UploadOutcome {
  readonly ok: boolean;
  readonly httpStatus: number;
  readonly receipts: readonly UploadReceipt[];
}

async function walkFiles(dir: string, base: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full));
  }
}

export async function uploadArtifacts(
  frame: TaskDispatchFrame,
  httpBase: string,
  executorToken: string,
  artifactsDir: string,
  log: (message: string) => void,
): Promise<UploadOutcome> {
  const relPaths: string[] = [];
  await walkFiles(artifactsDir, artifactsDir, relPaths);
  if (relPaths.length === 0) {
    log('no artifacts to upload');
    return { ok: true, httpStatus: 0, receipts: [] };
  }
  if (relPaths.length > 200) throw new Error(`too many artifacts: ${relPaths.length} > 200`);

  const metadata: FileMetadata[] = [];
  const blobs: { name: string; path: string; bytes: Buffer }[] = [];
  for (const rel of relPaths.sort()) {
    const bytes = await readFile(join(artifactsDir, rel));
    if (bytes.length > 50 * 1024 * 1024) throw new Error(`artifact too large: ${rel}`);
    metadata.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length });
    blobs.push({ name: rel, path: join(artifactsDir, rel), bytes });
  }

  // Hand-rolled multipart (no dependency): deterministic boundary, one part per file.
  const boundary = `awce-${frame.dispatchId}-${Date.now()}`;
  const parts: Buffer[] = [];
  for (const blob of blobs) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${blob.name.replace(/"/g, '')}"\r\n`
      + `Content-Type: application/octet-stream\r\n\r\n`,
    ));
    parts.push(blob.bytes);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="filesMetadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="idempotencyKey"\r\n\r\nawce-${frame.dispatchId}\r\n`
    + `--${boundary}--\r\n`,
  ));
  const body = Buffer.concat(parts);

  const url = `${httpBase}${frame.artifactUploadPath}?token=${encodeURIComponent(executorToken)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
  const raw = await response.text();
  let receipts: UploadReceipt[] = [];
  try {
    const parsed = JSON.parse(raw) as { receipts?: UploadReceipt[]; files?: UploadReceipt[] } | UploadReceipt[];
    receipts = Array.isArray(parsed) ? parsed : parsed.receipts ?? parsed.files ?? [];
  } catch { /* non-JSON body; receipts stay empty */ }
  const rejected = receipts.filter((r) => String(r.status).toUpperCase() !== 'ACCEPTED');
  log(`artifact upload HTTP ${response.status}: ${receipts.length - rejected.length}/${receipts.length} accepted`);
  for (const bad of rejected) log(`rejected: ${bad.path} (${bad.reason})`);
  return { ok: response.ok && rejected.length === 0, httpStatus: response.status, receipts };
}

// stat is re-exported to keep the import list honest for future size-based filtering.
export { stat };
