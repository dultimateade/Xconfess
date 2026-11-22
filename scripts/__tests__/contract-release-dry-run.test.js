'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createReport, outputPathFor, parseArgs, validateManifests } = require('../contract-release-dry-run');

const artifactContent = 'release wasm bytes';
const digest = crypto.createHash('sha256').update(artifactContent).digest('hex');
const abiContent = '{"version":"1.0.0","functions":[]}\n';
const abiDigest = crypto.createHash('sha256').update(abiContent).digest('hex');
const abiManifest = {
  contracts: {
    alpha: {
      version: '1.0.0',
      functions: ['read', 'write'],
      function_signatures: { read: 'read() -> u32', write: 'write(u32) -> void' },
    },
  },
};
const wasmManifest = {
  contracts: {
    alpha: { version: '1.0.0', sha256: digest, abi_sha256: abiDigest, wasm_file: 'target/release/alpha.wasm' },
  },
};
const migrationManifest = {
  schema_version: 1,
  contracts: {
    alpha: {
      initial_schema_version: 1,
      target_schema_version: 2,
      entrypoint: 'migrate',
      authorized_role: 'contract owner',
      changes: ['Add a field'],
    },
  },
};

test('dry-run report includes the target, digests, migration and pending approvals without secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-test-'));
  try {
    const artifactPath = path.join(root, 'xconfess-contracts', 'target', 'release', 'alpha.wasm');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, artifactContent);
    const abiPath = path.join(root, 'xconfess-contracts', 'contracts', 'alpha', 'abi.json');
    fs.mkdirSync(path.dirname(abiPath), { recursive: true });
    fs.writeFileSync(abiPath, abiContent);
    const report = createReport({
      network: 'testnet',
      abiManifest,
      wasmManifest,
      migrationManifest,
      deployment: { network: 'testnet', source: 'private-key-alias', contracts: {
        alpha: {
          contract_id: 'C123',
          version: '0.9.0',
          sha256: digest,
          storage_schema_version: 1,
          functions: ['read', 'write'],
          function_signatures: { read: 'read() -> u32', write: 'write(u32) -> void' },
        },
      } },
      commit: 'abc123',
      root,
      now: new Date('2026-01-02T03:04:05.000Z'),
    });

    assert.equal(report.status, 'ready_for_approval');
    assert.equal(report.target.network, 'testnet');
    assert.equal(report.candidate.contracts[0].wasm.sha256, digest);
    assert.equal(report.candidate.contracts[0].wasm.verification, 'verified');
    assert.equal(report.abiCompatibility.status, 'compatible');
    assert.equal(report.storageMigrations.contracts[0].required, true);
    const upgradeStep = report.steps.findIndex((step) => step.action === 'upload-and-upgrade-contracts-to-candidate-wasm');
    const migrationStep = report.steps.findIndex((step) => step.action === 'invoke-migrate-as-contract-owner');
    const verifyStep = report.steps.findIndex((step) => step.action === 'verify-post-migration-schema-and-state');
    assert.ok(upgradeStep < migrationStep && migrationStep < verifyStep);
    assert.ok(report.requiredApprovals.every((approval) => approval.status === 'pending'));
    assert.equal(JSON.stringify(report).includes('private-key-alias'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing prior ABI and schema evidence is reported for operator review', () => {
  const report = createReport({
    network: 'testnet',
    abiManifest,
    wasmManifest,
    migrationManifest,
    deployment: { contracts: { alpha: { version: '1.0.0' } } },
    commit: 'abc123',
    root: '/definitely/missing',
  });
  assert.equal(report.status, 'review_required');
  assert.equal(report.storageMigrations.contracts[0].fromSchemaVersion, null);
  assert.equal(report.storageMigrations.contracts[0].assumedFromSchemaVersion, 1);
  assert.equal(report.abiCompatibility.contracts[0].status, 'review_required');
});

test('blocks removals in a recorded prior ABI and mismatched contract sets', () => {
  const report = createReport({
    network: 'testnet',
    abiManifest,
    wasmManifest,
    migrationManifest,
    deployment: { contracts: { alpha: {
      version: '0.9.0',
      functions: ['read', 'write', 'old'],
      function_signatures: { read: 'read() -> i32', write: 'write(u32) -> void', old: 'old() -> void' },
    }, beta: {} } },
    commit: 'abc123',
    root: '/definitely/missing',
  });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.abiCompatibility.contracts[0].removedFunctions, ['old']);
  assert.deepEqual(report.abiCompatibility.contracts[0].changedSignatures, ['read']);
  assert.equal(report.checks.find((item) => item.name === 'target contract set').status, 'blocked');
});

test('blocks a candidate whose local artifact digest differs from its manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-test-'));
  try {
    const artifactPath = path.join(root, 'xconfess-contracts', 'target', 'release', 'alpha.wasm');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'tampered wasm');
    const report = createReport({
      network: 'testnet',
      abiManifest,
      wasmManifest,
      migrationManifest,
      deployment: { contracts: { alpha: {
        version: '0.9.0',
        storage_schema_version: 1,
        functions: ['read', 'write'],
        function_signatures: { read: 'read() -> u32', write: 'write(u32) -> void' },
      } } },
      commit: 'abc123',
      root,
    });
    assert.equal(report.candidate.contracts[0].wasm.verification, 'mismatch');
    assert.equal(report.status, 'blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('blocks a candidate whose ABI artifact digest differs from its manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-test-'));
  try {
    const abiPath = path.join(root, 'xconfess-contracts', 'contracts', 'alpha', 'abi.json');
    fs.mkdirSync(path.dirname(abiPath), { recursive: true });
    fs.writeFileSync(abiPath, '{"version":"1.0.0","functions":["tampered"]}\n');
    const report = createReport({
      network: 'testnet',
      abiManifest,
      wasmManifest,
      migrationManifest,
      deployment: { contracts: { alpha: { version: '0.9.0' } } },
      commit: 'abc123',
      root,
    });
    assert.equal(report.candidate.contracts[0].abi.verification, 'mismatch');
    assert.equal(report.status, 'blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects invalid networks, malformed manifest sets, and output overwrites', () => {
  assert.throws(() => parseArgs(['--network', '../testnet']), /valid --network/);
  assert.throws(() => validateManifests(abiManifest, { contracts: {} }, migrationManifest), /same non-empty contract set/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-test-'));
  try {
    fs.mkdirSync(path.join(root, 'deployments'));
    fs.writeFileSync(path.join(root, 'deployments', 'testnet.json'), '{}');
    assert.throws(() => outputPathFor(root, path.join(root, 'deployments', 'testnet.json')), /must not overwrite/);
    assert.throws(() => outputPathFor(root, path.join(root, 'deployments', 'new-report.json')), /must not overwrite/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
