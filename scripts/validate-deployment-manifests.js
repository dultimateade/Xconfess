#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_NAMES = [
  'confession-anchor',
  'confession-registry',
  'anonymous-tipping',
  'reputation-badges',
];
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NETWORK_PASSPHRASES = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

function readJson(relativePath, root = ROOT) {
  const filePath = path.join(root, relativePath);
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath };
  } catch (error) {
    return { error: `${relativePath}: ${error.code === 'ENOENT' ? 'file is missing' : error.message}`, filePath };
  }
}

function manifestNetwork(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.id || value.network_id || null;
  return null;
}

function manifestPassphrase(value) {
  return value && typeof value === 'object' ? (value.passphrase || value.network_passphrase || null) : null;
}

function validateCommittedManifests({ root = ROOT } = {}) {
  const errors = [];
  const warnings = [];
  const abi = readJson('deployments/contract-abi-manifest.json', root);
  const wasm = readJson('deployments/contract-wasm-manifest.json', root);
  const snapshots = readJson('deployments/fixtures/contract-deployment-snapshots.json', root);
  const deployment = readJson('deployments/testnet.json', root);

  for (const item of [abi, wasm, snapshots, deployment]) {
    if (item.error) errors.push(item.error);
  }
  if (errors.length) return { valid: false, errors, warnings };

  const abiValue = abi.value;
  const wasmValue = wasm.value;
  const snapshotValue = snapshots.value;
  const deploymentValue = deployment.value;
  const abiContracts = abiValue.contracts;
  const wasmContracts = wasmValue.contracts;
  const snapshotContracts = snapshotValue.contracts;
  const deployedContracts = deploymentValue.contracts;

  for (const [label, value] of [
    ['ABI manifest', abiValue],
    ['WASM manifest', wasmValue],
    ['fixture snapshots', snapshotValue],
  ]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${label}: top-level JSON must be an object`);
    }
  }

  if (!abiContracts || typeof abiContracts !== 'object' || Array.isArray(abiContracts)) {
    errors.push('ABI manifest: missing contracts dictionary');
  }
  if (!wasmContracts || typeof wasmContracts !== 'object' || Array.isArray(wasmContracts)) {
    errors.push('WASM manifest: missing contracts dictionary');
  }
  if (!snapshotContracts || typeof snapshotContracts !== 'object' || Array.isArray(snapshotContracts)) {
    errors.push('Fixture snapshots: missing contracts dictionary');
  }
  if (!deployedContracts || typeof deployedContracts !== 'object' || Array.isArray(deployedContracts)) {
    errors.push('Deployment testnet.json: missing contracts dictionary');
  }
  if (errors.length) return { valid: false, errors, warnings };

  const abiNetwork = manifestNetwork(abiValue.network);
  const wasmNetwork = manifestNetwork(wasmValue.network);
  const snapshotNetwork = typeof snapshotValue.network === 'string' ? snapshotValue.network : null;
  const deploymentNetwork = typeof deploymentValue.network === 'string' ? deploymentValue.network : null;

  if (!snapshotValue.snapshot_version) errors.push('Fixture snapshots: missing snapshot_version');
  if (!snapshotValue.generated_at_utc) errors.push('Fixture snapshots: missing generated_at_utc');
  if (!deploymentValue.generated_at_utc) errors.push('Deployment testnet.json: missing generated_at_utc');
  if (!deploymentValue.environment) errors.push('Deployment testnet.json: missing environment');
  if (!deploymentValue.target) errors.push('Deployment testnet.json: missing target');

  for (const [label, network] of [
    ['ABI manifest', abiNetwork],
    ['WASM manifest', wasmNetwork],
    ['fixture snapshots', snapshotNetwork],
    ['deployment testnet.json', deploymentNetwork],
  ]) {
    if (!network) errors.push(`${label}: missing network`);
    else if (!NETWORK_PASSPHRASES[network]) errors.push(`${label}: unsupported network "${network}"`);
  }

  const networks = [abiNetwork, wasmNetwork, snapshotNetwork, deploymentNetwork].filter(Boolean);
  if (networks.length && new Set(networks).size !== 1) {
    errors.push(`Network mismatch across committed metadata: ${[...new Set(networks)].join(', ')}`);
  }
  const network = networks[0];
  if (network) {
    const abiPassphrase = manifestPassphrase(abiValue.network);
    const wasmPassphrase = manifestPassphrase(wasmValue.network);
    for (const [label, passphrase] of [['ABI manifest', abiPassphrase], ['WASM manifest', wasmPassphrase]]) {
      if (passphrase && passphrase !== NETWORK_PASSPHRASES[network]) {
        errors.push(`${label}: network passphrase does not match ${network}`);
      }
    }
  }

  const contractSets = [
    ['ABI manifest', Object.keys(abiContracts).sort()],
    ['WASM manifest', Object.keys(wasmContracts).sort()],
    ['fixture snapshots', Object.keys(snapshotContracts).sort()],
    ['deployment testnet.json', Object.keys(deployedContracts).sort()],
  ];
  for (const [label, names] of contractSets) {
    const missing = CONTRACT_NAMES.filter((name) => !names.includes(name));
    if (missing.length) warnings.push(`${label}: missing expected contract entries: ${missing.join(', ')}`);
  }
  const firstSet = contractSets[0][1];
  for (const [label, names] of contractSets.slice(1)) {
    if (JSON.stringify(names) !== JSON.stringify(firstSet)) {
      errors.push(`${label}: contract set differs from ABI manifest`);
    }
  }

  for (const name of CONTRACT_NAMES) {
    const abiContract = abiContracts[name];
    const wasmContract = wasmContracts[name];
    const snapshot = snapshotContracts[name];
    const deployed = deployedContracts[name];

    if (!abiContract || typeof abiContract !== 'object') continue;
    if (!wasmContract || typeof wasmContract !== 'object') continue;

    for (const [label, contract] of [
      [`ABI manifest ${name}`, abiContract],
      [`WASM manifest ${name}`, wasmContract],
      [`fixture snapshot ${name}`, snapshot],
      [`deployment ${name}`, deployed],
    ]) {
      if (!contract || typeof contract !== 'object') continue;
      if (contract.contract_id && !CONTRACT_ID_PATTERN.test(contract.contract_id)) {
        errors.push(`${label}: invalid contract_id "${contract.contract_id}"`);
      }
      if (contract.contract_id && contract.contract_id !== abiContract.contract_id
          && contract !== abiContract) {
        errors.push(`${label}: contract_id differs from ABI manifest`);
      }
    }

    for (const [label, digest] of [
      [`ABI manifest ${name} abi_sha256`, abiContract.abi_sha256],
      [`WASM manifest ${name} abi_sha256`, wasmContract.abi_sha256],
    ]) {
      if (!digest || !SHA256_PATTERN.test(digest)) errors.push(`${label}: missing or invalid ABI SHA-256`);
    }
    if (abiContract.abi_sha256 && wasmContract.abi_sha256
        && abiContract.abi_sha256 !== wasmContract.abi_sha256) {
      errors.push(`${name}: ABI digest differs between ABI and WASM manifests`);
    }
      if (abiContract.wasm_sha256) {
        if (!SHA256_PATTERN.test(abiContract.wasm_sha256)) {
          errors.push(`ABI manifest ${name} wasm_sha256: missing or invalid SHA-256`);
        } else if (abiContract.wasm_sha256 !== wasmContract.sha256) {
          errors.push(`${name}: WASM digest differs between ABI and WASM manifests`);
        }
      } else {
        errors.push(`ABI manifest ${name}: missing wasm_sha256`);
      }
    for (const [label, digest] of [
      [`WASM manifest ${name} sha256`, wasmContract.sha256],
      [`fixture snapshot ${name} sha256`, snapshot?.sha256],
      [`deployment ${name} sha256`, deployed?.sha256],
    ]) {
      if (!digest || !SHA256_PATTERN.test(digest)) errors.push(`${label}: missing or invalid SHA-256`);
    }
    if (wasmContract.sha256 && snapshot?.sha256 && wasmContract.sha256 !== snapshot.sha256) {
      errors.push(`${name}: WASM digest differs between WASM manifest and fixture snapshot`);
    }
    if (wasmContract.sha256 && deployed?.sha256 && wasmContract.sha256 !== deployed.sha256) {
      errors.push(`${name}: WASM digest differs between WASM manifest and deployment`);
    }
    if (typeof abiContract.version === 'string' && typeof wasmContract.version === 'string'
        && abiContract.version !== wasmContract.version) {
      errors.push(`${name}: version differs between ABI and WASM manifests`);
    }
    if (abiContract.contract_id && deployed?.contract_id
        && abiContract.contract_id !== deployed.contract_id) {
      errors.push(`${name}: contract_id differs between ABI manifest and deployment`);
    }
    if (abiContract.contract_id && snapshot?.contract_id
        && abiContract.contract_id !== snapshot.contract_id) {
      errors.push(`${name}: contract_id differs between ABI manifest and fixture snapshot`);
    }

    if (!snapshot?.contract_id || !CONTRACT_ID_PATTERN.test(snapshot.contract_id)) {
      errors.push(`Fixture snapshot ${name}: missing or invalid contract_id`);
    }
    if (!snapshot?.version || typeof snapshot.version !== 'string') {
      errors.push(`Fixture snapshot ${name}: missing required version`);
    }
    if (!snapshot?.schema_version || !Number.isInteger(snapshot.schema_version)) {
      errors.push(`Fixture snapshot ${name}: missing required schema_version`);
    }
    if (!deployed?.contract_id || !CONTRACT_ID_PATTERN.test(deployed.contract_id)) {
      errors.push(`Deployment ${name}: missing or invalid contract_id`);
    }
    if (!deployed?.wasm_file || typeof deployed.wasm_file !== 'string' || !deployed.wasm_file.endsWith('.wasm')) {
      errors.push(`Deployment ${name}: missing valid wasm_file`);
    }
    if (!deployed?.version || typeof deployed.version !== 'string') {
      errors.push(`Deployment ${name}: missing required version`);
    }
    if (!deployed?.source || typeof deployed.source !== 'string') {
      errors.push(`Deployment ${name}: missing required source`);
    }

    const abiPath = path.join(root, 'xconfess-contracts', 'contracts', name, 'abi.json');
    if (abiContract.abi_sha256 && fs.existsSync(abiPath)) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(abiPath)).digest('hex');
      if (actual !== abiContract.abi_sha256) {
        errors.push(`${name}: ABI digest does not match ${path.relative(root, abiPath)}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateDeploymentManifest(manifest, label = 'deployment manifest') {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: [`${label}: must be a JSON object`] };
  }
  const network = typeof manifest.network === 'string' ? manifest.network : null;
  if (!network || !NETWORK_PASSPHRASES[network]) {
    errors.push(`${label}: missing or unsupported network`);
  }
  if (!manifest.environment) errors.push(`${label}: missing environment`);
  if (!manifest.generated_at_utc) errors.push(`${label}: missing generated_at_utc`);
  if (!manifest.target) errors.push(`${label}: missing target`);
  if (!manifest.contracts || typeof manifest.contracts !== 'object' || Array.isArray(manifest.contracts)) {
    errors.push(`${label}: missing contracts dictionary`);
  } else {
    for (const [name, contract] of Object.entries(manifest.contracts)) {
      if (!contract || typeof contract !== 'object') {
        errors.push(`${label}: contract "${name}" must be an object`);
        continue;
      }
      if (!CONTRACT_ID_PATTERN.test(contract.contract_id || '')) {
        errors.push(`${label}: contract "${name}" has missing or invalid contract_id`);
      }
      if (!SHA256_PATTERN.test(contract.sha256 || '')) {
        errors.push(`${label}: contract "${name}" has missing or invalid sha256`);
      }
      if (!contract.wasm_file || !contract.wasm_file.endsWith('.wasm')) {
        errors.push(`${label}: contract "${name}" has missing or invalid wasm_file`);
      }
      if (!contract.version) errors.push(`${label}: contract "${name}" is missing version`);
      if (!contract.source) errors.push(`${label}: contract "${name}" is missing source`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseArgs(argv) {
  const result = { all: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--manifest') result.manifest = argv[++index];
    else if (argv[index] === '--root') result.root = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  if (options.manifest) {
    const relative = path.relative(ROOT, path.resolve(options.manifest));
    if (!relative || relative.startsWith('..')) {
      console.error(`Manifest must be inside the repository: ${options.manifest}`);
      return 1;
    }
    const manifestPath = path.resolve(options.manifest);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      console.error(`FAIL: cannot read manifest ${options.manifest}: ${error.message}`);
      return 1;
    }
    const result = validateDeploymentManifest(manifest, path.relative(ROOT, manifestPath));
    if (result.valid) {
      console.log(`Deployment manifest is valid: ${path.relative(ROOT, manifestPath)}`);
    } else {
      for (const error of result.errors) console.error(`FAIL: ${error}`);
    }
    return result.valid ? 0 : 1;
  }
  const result = validateCommittedManifests({ root: options.root || ROOT });
  if (result.valid) {
    console.log('Committed deployment manifests and fixture snapshots are valid.');
  } else {
    for (const error of result.errors) console.error(`FAIL: ${error}`);
  }
  for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
  return result.valid ? 0 : 1;
}

module.exports = {
  validateCommittedManifests,
  validateDeploymentManifests: validateCommittedManifests,
  validateDeploymentManifest,
};

if (require.main === module) process.exitCode = main();
