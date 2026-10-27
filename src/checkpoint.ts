// Checkpoint channel: mid-run RECOVERY snapshots + COMPLETION receipt (V2 results).
// Contract (DaemonCheckpointController):
//   POST {checkpointUploadPath}?token&checkpointSeq&provider&providerSessionId
//        &runtimeId&activeStepId&purpose=RECOVERY|COMPLETION&resultId
//   multipart file part "checkpoint" (bytes). 409 on identity conflict.
// A V2 success TASK_RESULT is only accepted when it pins the seq+sha256 of a
// COMPLETION checkpoint stored under the same resultId.

import { createHash } from 'node:crypto';
import type { TaskDispatchFrame } from './frames.js';

export interface CheckpointReceipt {
  readonly checkpointSeq: number;
  readonly sha256: string; // "sha256:<hex>" as returned by the server
  readonly sizeBytes: number;
}

export interface RecoveryState {
  readonly phase: string;
  readonly attempt: number;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

export async function uploadCheckpoint(
  frame: TaskDispatchFrame,
  httpBase: string,
  executorToken: string,
  options: {
    readonly seq: number;
    readonly state: RecoveryState;
    readonly provider: string;
    readonly providerSessionId: string;
    readonly runtimeId?: string;
    readonly activeStepId?: string;
    readonly purpose?: 'RECOVERY' | 'COMPLETION';
    readonly resultId?: string;
  },
): Promise<CheckpointReceipt> {
  const bytes = Buffer.from(JSON.stringify(options.state, null, 2), 'utf8');
  const params = new URLSearchParams({
    token: executorToken,
    checkpointSeq: String(options.seq),
    provider: options.provider,
    providerSessionId: options.providerSessionId,
  });
  if (options.runtimeId) params.set('runtimeId', options.runtimeId);
  if (options.activeStepId) params.set('activeStepId', options.activeStepId);
  if (options.purpose) params.set('purpose', options.purpose);
  if (options.resultId) params.set('resultId', options.resultId);

  const boundary = `awce-ckpt-${frame.dispatchId}-${options.seq}-${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="checkpoint"; filename="state.json"\r\n`
      + `Content-Type: application/json\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await fetch(`${httpBase}${frame.checkpointUploadPath}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
  if (!response.ok) {
    throw new Error(`checkpoint upload failed: HTTP ${response.status} ${await response.text()}`);
  }
  const receipt = JSON.parse(await response.text()) as CheckpointReceipt;
  return receipt;
}

/** Download and sha256-verify a resume checkpoint referenced by a dispatch frame. */
export async function downloadCheckpoint(
  downloadUrl: string,
  expectedSha256: string | undefined,
): Promise<Buffer> {
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`checkpoint download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (expectedSha256) {
    const actual = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const expected = expectedSha256.toLowerCase().startsWith('sha256:') ? expectedSha256.toLowerCase() : 'sha256:' + expectedSha256.toLowerCase();
    if (actual !== expected) throw new Error(`resume checkpoint sha256 mismatch: ${expected} vs ${actual}`);
  }
  return bytes;
}
