// TASK_PACKAGE_SIGNATURE_V1 — Ed25519 verification of the dispatch envelope.
//
// Signed payload (UTF-8, six lines, each terminated by "\n"):
//   autowonder.taskPackage.signature.v1
//   {issuer}            e.g. "autowonder-server"
//   {signatureRef}      "sha256:" + hex(sha256(publicKeySpki))
//   {expiresAt}         Instant.toString()
//   {packageId}         e.g. "pkg_10009"
//   sha256:{archiveSha256Hex}
//
// The signer is process-scoped; the public key travels in the frame
// (signaturePublicKey, base64 SPKI), so verification is self-contained.

import { createHash, createPublicKey, verify } from 'node:crypto';
import type { TaskDispatchFrame } from './frames.js';

export interface SignatureVerification {
  readonly ok: boolean;
  readonly reason?: string;
  readonly archiveSha256: string;
}

function normalizeDigest(digest: string | undefined): string {
  const value = (digest ?? '').trim().toLowerCase();
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function buildPayload(frame: TaskDispatchFrame, archiveSha256Hex: string): Buffer {
  return Buffer.from(
    'autowonder.taskPackage.signature.v1\n'
    + `${frame.issuer ?? ''}\n`
    + `${frame.signatureRef ?? ''}\n`
    + `${frame.expiresAt ?? ''}\n`
    + `${frame.packageId}\n`
    + `${normalizeDigest(archiveSha256Hex)}\n`,
    'utf8',
  );
}

export function verifyDispatchSignature(frame: TaskDispatchFrame, zipBytes: Buffer): SignatureVerification {
  const archiveSha256 = createHash('sha256').update(zipBytes).digest('hex');

  // 1. Frame-carried whole-archive checksum (always present).
  if (frame.checksum && normalizeDigest(frame.checksum) !== `sha256:${archiveSha256}`) {
    return { ok: false, reason: `archive sha256 mismatch: frame=${frame.checksum} actual=sha256:${archiveSha256}`, archiveSha256 };
  }

  // 2. Signed envelope — present when this executor declared TASK_PACKAGE_SIGNATURE_V1.
  if (!frame.signature) {
    return { ok: true, reason: 'unsigned (feature not negotiated for this dispatch)', archiveSha256 };
  }
  if (frame.signatureAlgorithm !== 'ed25519') {
    return { ok: false, reason: `unsupported signatureAlgorithm ${frame.signatureAlgorithm}`, archiveSha256 };
  }
  if (!frame.signaturePublicKey || !frame.issuer || !frame.signatureRef || !frame.expiresAt) {
    return { ok: false, reason: 'incomplete signature block', archiveSha256 };
  }
  if (Date.parse(frame.expiresAt) < Date.now()) {
    return { ok: false, reason: `signature expired at ${frame.expiresAt}`, archiveSha256 };
  }
  // signatureRef pins the key: sha256 of the SPKI bytes must match.
  const spki = Buffer.from(frame.signaturePublicKey, 'base64');
  const spkiSha256 = createHash('sha256').update(spki).digest('hex');
  if (frame.signatureRef !== `sha256:${spkiSha256}`) {
    return { ok: false, reason: `signatureRef does not pin the provided key (${frame.signatureRef})`, archiveSha256 };
  }

  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const valid = verify(null, buildPayload(frame, archiveSha256), key, Buffer.from(frame.signature, 'base64'));
  return valid
    ? { ok: true, archiveSha256 }
    : { ok: false, reason: 'ed25519 signature invalid', archiveSha256 };
}
