'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createManifest, resolveNetwork, verifyManifest } = require('../contract-release-manifest');

const revision = 'a'.repeat(40);

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-contract-release-'));
  const contractsRoot = path.join(root, 'xconfess-contracts');
  const wasmPath = path.join(contractsRoot, 'target', 'release', 'alpha.wasm');
  const abiPath = path.join(contractsRoot, 'contracts', 'alpha', 'abi.json');
  const wasmBytes = Buffer.from('release wasm bytes');
  const abiBytes = Buffer.from('{"version":"1.0.0","functions":["read"]}\n');
  fs.mkdirSync(path.dirname(wasmPath), { recursive: true });
  fs.mkdirSync(path.dirname(abiPath), { recursive: true });
  fs.mkdirSync(path.join(root, 'deployments'), { recursive: true });
  fs.writeFileSync(wasmPath, wasmBytes);
  fs.writeFileSync(abiPath, abiBytes);
  const wasmSha = crypto.createHash('sha256').update(wasmBytes).digest('hex');
  const abiSha = crypto.createHash('sha256').update(abiBytes).digest('hex');
  fs.writeFileSync(path.join(root, 'deployments', 'contract-abi-manifest.json'), JSON.stringify({
    contracts: { alpha: { version: '1.0.0' } },
  }));
  fs.writeFileSync(path.join(root, 'deployments', 'contract-wasm-manifest.json'), JSON.stringify({
    contracts: {
      alpha: {
        version: '1.0.0',
        sha256: wasmSha,
        abi_sha256: abiSha,
        wasm_file: 'target/release/alpha.wasm',
      },
    },
  }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    root,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('signs and verifies WASM, ABI version, source revision, and network metadata', () => {
  const fixture = createFixture();
  try {
    const manifest = createManifest({
      root: fixture.root,
      network: 'testnet',
      sourceRevision: revision,
      privateKey: fixture.privateKey,
      trustedPublicKey: fixture.publicKey,
      now: new Date('2026-01-02T03:04:05.000Z'),
    });
    const result = verifyManifest({
      root: fixture.root,
      manifest,
      network: 'testnet',
      sourceRevision: revision,
      trustedPublicKey: fixture.publicKey,
    });
    assert.equal(result.network.passphrase, 'Test SDF Network ; September 2015');
    assert.equal(manifest.contracts.alpha.abi.version, '1.0.0');
    assert.match(manifest.contracts.alpha.wasm.sha256, /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
});

test('rejects altered signatures, wrong network, and wrong source revision', () => {
  const fixture = createFixture();
  try {
    const manifest = createManifest({
      root: fixture.root,
      network: 'testnet',
      sourceRevision: revision,
      privateKey: fixture.privateKey,
      trustedPublicKey: fixture.publicKey,
    });
    assert.throws(() => verifyManifest({
      root: fixture.root,
      manifest: { ...manifest, source_revision: 'b'.repeat(40) },
      trustedPublicKey: fixture.publicKey,
    }), /signature verification failed/);
    assert.throws(() => verifyManifest({
      root: fixture.root,
      manifest,
      network: 'mainnet',
      trustedPublicKey: fixture.publicKey,
    }), /network metadata/);
    assert.throws(() => verifyManifest({
      root: fixture.root,
      manifest,
      sourceRevision: 'b'.repeat(40),
      trustedPublicKey: fixture.publicKey,
    }), /source revision/);
  } finally {
    fixture.cleanup();
  }
});

test('rejects tampered WASM and ABI artifacts after signature verification', () => {
  const fixture = createFixture();
  try {
    const manifest = createManifest({
      root: fixture.root,
      network: 'testnet',
      sourceRevision: revision,
      privateKey: fixture.privateKey,
      trustedPublicKey: fixture.publicKey,
    });
    fs.appendFileSync(path.join(fixture.root, 'xconfess-contracts', 'target', 'release', 'alpha.wasm'), 'tampered');
    assert.throws(() => verifyManifest({
      root: fixture.root, manifest, trustedPublicKey: fixture.publicKey,
    }), /WASM digest mismatch/);
  } finally {
    fixture.cleanup();
  }

  const abiFixture = createFixture();
  try {
    const manifest = createManifest({
      root: abiFixture.root,
      network: 'testnet',
      sourceRevision: revision,
      privateKey: abiFixture.privateKey,
      trustedPublicKey: abiFixture.publicKey,
    });
    fs.appendFileSync(path.join(abiFixture.root, 'xconfess-contracts', 'contracts', 'alpha', 'abi.json'), ' ');
    assert.throws(() => verifyManifest({
      root: abiFixture.root, manifest, trustedPublicKey: abiFixture.publicKey,
    }), /ABI digest mismatch/);
  } finally {
    abiFixture.cleanup();
  }
});

test('rejects mismatched signing and trusted keys or inconsistent ABI versions', () => {
  const fixture = createFixture();
  const otherKeys = crypto.generateKeyPairSync('ed25519');
  try {
    assert.throws(() => createManifest({
      root: fixture.root,
      network: 'testnet',
      sourceRevision: revision,
      privateKey: fixture.privateKey,
      trustedPublicKey: otherKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    }), /does not match/);
    fs.writeFileSync(
      path.join(fixture.root, 'xconfess-contracts', 'contracts', 'alpha', 'abi.json'),
      '{"version":"2.0.0","functions":["read"]}\n',
    );
    assert.throws(() => createManifest({
      root: fixture.root,
      network: 'testnet',
      sourceRevision: revision,
      privateKey: fixture.privateKey,
      trustedPublicKey: fixture.publicKey,
    }), /ABI version mismatch/);
  } finally {
    fixture.cleanup();
  }
});

test('rejects standard network aliases with conflicting metadata overrides', () => {
  assert.throws(() => resolveNetwork('testnet', {
    passphrase: 'Public Global Stellar Network ; September 2015',
  }), /overrides conflict/);
});
