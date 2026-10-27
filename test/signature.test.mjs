// Ed25519 envelope verification tests (run against the compiled dist/).
// Mirrors TaskPackageSigner.java byte-for-byte: same six-line payload, same
// SPKI key encoding, so a signature produced by the Java server verifies here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign, createHash } from 'node:crypto';
import { verifyDispatchSignature } from '../dist/signature.js';

function makeFrame(overrides = {}) {
  return {
    type: 'TASK_DISPATCH',
    dispatchId: 42, executorId: 7, tenantId: 1, workitemId: 2, agentId: 3,
    agentVersionId: 4, sdlcStepId: 5, attempt: 1,
    downloadUrl: 'http://x/pkg.zip', md5: '0'.repeat(32), size: 10,
    packageId: 'pkg_42',
    allowCommit: false, allowPush: false, allowNetwork: false,
    packageRefreshPath: '/p', artifactUploadPath: '/a', checkpointUploadPath: '/c',
    memorySnapshotPath: '/m/s', memoryChangesPath: '/m/c', memoryMutationPath: '/m/m',
    memoryRecallPath: '/m/r', memoryStartingRevisions: {},
    dispatchMcpToken: 'awdispatch_x',
    ...overrides,
  };
}

function javaCompatibleSignature(frame, zipBytes, keyPair, opts = {}) {
  const archiveSha256 = createHash('sha256').update(zipBytes).digest('hex');
  const spki = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const signatureRef = 'sha256:' + createHash('sha256').update(spki).digest('hex');
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 3600_000).toISOString();
  const issuer = opts.issuer ?? frame.issuer ?? 'autowonder-server';
  const payload = Buffer.from(
    'autowonder.taskPackage.signature.v1\n'
    + `${issuer}\n${signatureRef}\n${expiresAt}\n${frame.packageId}\n`
    + `sha256:${opts.digestOverride ?? archiveSha256}\n`,
    'utf8',
  );
  return { signature: edSign(null, payload, keyPair.privateKey), signatureRef, expiresAt, issuer, spki };
}

const ZIP = Buffer.from('fake-zip-bytes');
const KEY = generateKeyPairSync('ed25519');

function signedFrame(extra = {}) {
  const base = makeFrame();
  const s = javaCompatibleSignature(base, ZIP, KEY);
  return [makeFrame({
    checksum: 'sha256:' + createHash('sha256').update(ZIP).digest('hex'),
    issuer: s.issuer, signatureRef: s.signatureRef, expiresAt: s.expiresAt,
    signatureAlgorithm: 'ed25519',
    signaturePublicKey: s.spki.toString('base64'),
    signature: s.signature.toString('base64'),
    ...extra.frame,
  }), s];
}

test('valid Java-format signature verifies', () => {
  const [frame] = signedFrame();
  const result = verifyDispatchSignature(frame, ZIP);
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

test('unsigned frame (community edition) passes with note', () => {
  const result = verifyDispatchSignature(makeFrame(), ZIP);
  assert.equal(result.ok, true);
  assert.match(result.reason, /unsigned/);
});

test('tampered archive fails checksum before signature', () => {
  const [frame] = signedFrame();
  const result = verifyDispatchSignature(frame, Buffer.from('tampered'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /sha256 mismatch/);
});

test('signature over a different archive fails', () => {
  // Server signs digest A but frame.checksum/bytes are B.
  const [frame] = signedFrame();
  const result = verifyDispatchSignature(frame, Buffer.concat([ZIP, Buffer.from('x')]));
  assert.equal(result.ok, false);
});

test('expired envelope fails', () => {
  const base = makeFrame();
  const s = javaCompatibleSignature(base, ZIP, KEY, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const frame = makeFrame({
    issuer: s.issuer, signatureRef: s.signatureRef, expiresAt: s.expiresAt,
    signatureAlgorithm: 'ed25519', signaturePublicKey: s.spki.toString('base64'),
    signature: s.signature.toString('base64'),
  });
  const result = verifyDispatchSignature(frame, ZIP);
  assert.equal(result.ok, false);
  assert.match(result.reason, /expired/);
});

test('key substitution (signatureRef does not pin key) fails', () => {
  const [frame, s] = signedFrame();
  const otherKey = generateKeyPairSync('ed25519');
  // Re-sign with attacker key but keep the honest signatureRef.
  const payload = Buffer.from(
    'autowonder.taskPackage.signature.v1\n'
    + `${frame.issuer}\n${frame.signatureRef}\n${frame.expiresAt}\n${frame.packageId}\n`
    + `sha256:${createHash('sha256').update(ZIP).digest('hex')}\n`,
    'utf8',
  );
  const frameBad = { ...frame, signaturePublicKey: otherKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signature: edSign(null, payload, otherKey.privateKey).toString('base64') };
  void s;
  const result = verifyDispatchSignature(frameBad, ZIP);
  assert.equal(result.ok, false);
  assert.match(result.reason, /signatureRef/);
});
