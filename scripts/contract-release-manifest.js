#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ABI_MANIFEST = 'deployments/contract-abi-manifest.json';
const WASM_MANIFEST = 'deployments/contract-wasm-manifest.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NETWORKS = {
  test: { id: 'testnet', environment: 'staging', passphrase: 'Test SDF Network ; September 2015' },
  testnet: { id: 'testnet', environment: 'staging', passphrase: 'Test SDF Network ; September 2015' },
  futurenet: { id: 'futurenet', environment: 'development', passphrase: 'Test SDF Future Network ; October 2018' },
  public: { id: 'mainnet', environment: 'production', passphrase: 'Public Global Stellar Network ; September 2015' },
  pubnet: { id: 'mainnet', environment: 'production', passphrase: 'Public Global Stellar Network ; September 2015' },
  mainnet: { id: 'mainnet', environment: 'production', passphrase: 'Public Global Stellar Network ; September 2015' },
};

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readJson(root, relativePath) {
  const filePath = path.join(root, relativePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read valid JSON from ${relativePath}: ${error.message}`);
  }
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeFile(root, relativePath, label) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error(`${label} path must be relative to xconfess-contracts.`);
  }
  const contractsRoot = path.resolve(root, 'xconfess-contracts');
  const fullPath = path.resolve(contractsRoot, relativePath);
  if (!isWithin(contractsRoot, fullPath)) throw new Error(`${label} path escapes xconfess-contracts.`);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`${label} artifact is missing: ${relativePath}`);
  }
  const realContractsRoot = fs.realpathSync(contractsRoot);
  const realFilePath = fs.realpathSync(fullPath);
  if (!isWithin(realContractsRoot, realFilePath)) throw new Error(`${label} path resolves outside xconfess-contracts.`);
  return realFilePath;
}

function resolveNetwork(network, overrides = {}) {
  if (typeof network !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(network)) {
    throw new Error('A valid network alias is required.');
  }
  const known = NETWORKS[network.toLowerCase()];
  if (known && Object.entries({
    id: overrides.id,
    environment: overrides.environment,
    passphrase: overrides.passphrase,
  }).some(([key, value]) => value && value !== known[key])) {
    throw new Error(`Network metadata overrides conflict with the configured '${network}' network.`);
  }
  const id = overrides.id || known?.id;
  const environment = overrides.environment || known?.environment;
  const passphrase = overrides.passphrase || known?.passphrase;
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)
    || !['development', 'staging', 'production'].includes(environment)
    || typeof passphrase !== 'string' || !passphrase.trim()) {
    throw new Error(`Network '${network}' is not configured. Set XCONFESS_NETWORK_ID, XCONFESS_RELEASE_ENVIRONMENT, and XCONFESS_NETWORK_PASSPHRASE for custom aliases.`);
  }
  return { alias: network, id, environment, passphrase };
}

function collectContractEvidence(root) {
  const abiManifest = readJson(root, ABI_MANIFEST);
  const wasmManifest = readJson(root, WASM_MANIFEST);
  const abiContracts = abiManifest?.contracts;
  const wasmContracts = wasmManifest?.contracts;
  if (!abiContracts || typeof abiContracts !== 'object' || Array.isArray(abiContracts)
    || !wasmContracts || typeof wasmContracts !== 'object' || Array.isArray(wasmContracts)) {
    throw new Error('ABI and WASM manifests must contain contracts objects.');
  }
  const names = Object.keys(wasmContracts).sort();
  if (!names.length || JSON.stringify(names) !== JSON.stringify(Object.keys(abiContracts).sort())) {
    throw new Error('ABI and WASM manifests must declare the same non-empty contract set.');
  }

  const contracts = {};
  for (const name of names) {
    const wasm = wasmContracts[name];
    const abi = abiContracts[name];
    if (!wasm || !abi || typeof wasm.version !== 'string' || !wasm.version
      || wasm.version !== abi.version || !SHA256_PATTERN.test(wasm.sha256 || '')
      || !SHA256_PATTERN.test(wasm.abi_sha256 || '')) {
      throw new Error(`Malformed or inconsistent release metadata for contract '${name}'.`);
    }
    const wasmPath = safeFile(root, wasm.wasm_file, `${name} WASM`);
    const abiRelativePath = `contracts/${name}/abi.json`;
    const abiPath = safeFile(root, abiRelativePath, `${name} ABI`);
    const abiDocument = readJson(path.join(root, 'xconfess-contracts'), abiRelativePath);
    if (abiDocument.version !== abi.version || abiDocument.version !== wasm.version) {
      throw new Error(`ABI version mismatch for contract '${name}'.`);
    }
    const actualWasmSha256 = sha256(fs.readFileSync(wasmPath));
    const actualAbiSha256 = sha256(fs.readFileSync(abiPath));
    if (actualWasmSha256 !== wasm.sha256) {
      throw new Error(`WASM digest mismatch for contract '${name}'.`);
    }
    if (actualAbiSha256 !== wasm.abi_sha256) {
      throw new Error(`ABI digest mismatch for contract '${name}'.`);
    }
    contracts[name] = {
      abi: { path: abiRelativePath, sha256: actualAbiSha256, version: abi.version },
      wasm: {
        bytes: fs.statSync(wasmPath).size,
        path: wasm.wasm_file,
        sha256: actualWasmSha256,
      },
    };
  }
  return contracts;
}

function keyId(publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release signing key must be Ed25519.');
  return `sha256:${sha256(key.export({ type: 'spki', format: 'der' }))}`;
}

function createManifest({
  root = ROOT,
  network,
  sourceRevision,
  privateKey,
  trustedPublicKey,
  now = new Date(),
  networkOverrides = {},
}) {
  if (typeof privateKey !== 'string' || !privateKey.trim()) {
    throw new Error('XCONFESS_RELEASE_SIGNING_KEY is required to create a signed release manifest.');
  }
  if (typeof trustedPublicKey !== 'string' || !trustedPublicKey.trim()) {
    throw new Error('XCONFESS_RELEASE_TRUSTED_PUBLIC_KEY is required to sign and verify a release manifest.');
  }
  if (!REVISION_PATTERN.test(sourceRevision || '')) throw new Error('Source revision must be a full 40- or 64-character Git commit.');
  const networkMetadata = resolveNetwork(network, networkOverrides);
  const publicKey = crypto.createPublicKey(privateKey);
  const signerKeyId = keyId(publicKey);
  if (signerKeyId !== keyId(trustedPublicKey)) {
    throw new Error('Signing key does not match the configured trusted release public key.');
  }
  const payload = {
    schema_version: 1,
    generated_at_utc: now.toISOString(),
    source_revision: sourceRevision,
    network: networkMetadata,
    contracts: collectContractEvidence(root),
    signer: { algorithm: 'Ed25519', key_id: signerKeyId },
  };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64');
  return { ...payload, signature };
}

function verifyManifest({
  root = ROOT,
  manifest,
  network,
  sourceRevision,
  trustedPublicKey,
  networkOverrides = {},
}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Release manifest must be a JSON object.');
  }
  if (typeof trustedPublicKey !== 'string' || !trustedPublicKey.trim()) {
    throw new Error('XCONFESS_RELEASE_TRUSTED_PUBLIC_KEY is required to verify a release manifest.');
  }
  const { signature, ...payload } = manifest;
  const trustedKeyId = keyId(trustedPublicKey);
  if (manifest.schema_version !== 1 || manifest.signer?.algorithm !== 'Ed25519'
    || manifest.signer?.key_id !== trustedKeyId
    || typeof signature !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error('Release manifest signature metadata is missing, malformed, or untrusted.');
  }
  let validSignature = false;
  try {
    validSignature = crypto.verify(
      null,
      Buffer.from(canonicalJson(payload)),
      trustedPublicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) throw new Error('Release manifest signature verification failed.');
  if (!REVISION_PATTERN.test(manifest.source_revision || '')) {
    throw new Error('Release manifest source_revision is invalid.');
  }
  if (sourceRevision && manifest.source_revision !== sourceRevision) {
    throw new Error('Release manifest source revision does not match the expected revision.');
  }
  if (!Number.isFinite(Date.parse(manifest.generated_at_utc || ''))) {
    throw new Error('Release manifest generated_at_utc is invalid.');
  }
  if (network) {
    const expectedNetwork = resolveNetwork(network, networkOverrides);
    if (canonicalJson(manifest.network) !== canonicalJson(expectedNetwork)) {
      throw new Error('Release manifest network metadata does not match the requested network.');
    }
  }
  const actualContracts = collectContractEvidence(root);
  if (canonicalJson(manifest.contracts) !== canonicalJson(actualContracts)) {
    throw new Error('Release manifest contract artifacts or ABI versions do not match the current release inputs.');
  }
  return { keyId: trustedKeyId, sourceRevision: manifest.source_revision, network: manifest.network };
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!['create', 'verify'].includes(command)) throw new Error('Usage: contract-release-manifest.js <create|verify> --network <name> [--manifest <path>].');
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--network' || argument === '--manifest') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      options[argument === '--network' ? 'network' : 'manifestPath'] = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.network) throw new Error('--network is required.');
  resolveNetwork(options.network, {
    id: process.env.XCONFESS_NETWORK_ID,
    environment: process.env.XCONFESS_RELEASE_ENVIRONMENT,
    passphrase: process.env.XCONFESS_NETWORK_PASSPHRASE,
  });
  return { command, options };
}

function currentRevision(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  const networkOverrides = {
    id: process.env.XCONFESS_NETWORK_ID,
    environment: process.env.XCONFESS_RELEASE_ENVIRONMENT,
    passphrase: process.env.XCONFESS_NETWORK_PASSPHRASE,
  };
  const revision = currentRevision(ROOT);
  const manifestPath = options.manifestPath
    ? path.resolve(ROOT, options.manifestPath)
    : path.join(ROOT, 'deployments', `contract-release-manifest-${options.network}-${revision}.json`);
  const deploymentsDirectory = path.resolve(ROOT, 'deployments');
  const realRoot = fs.realpathSync(ROOT);
  const realDeployments = fs.realpathSync(deploymentsDirectory);
  let existingParent = path.dirname(manifestPath);
  while (!fs.existsSync(existingParent) && existingParent !== path.dirname(existingParent)) {
    existingParent = path.dirname(existingParent);
  }
  const physicalManifestPath = path.resolve(
    fs.realpathSync(existingParent),
    path.relative(existingParent, manifestPath),
  );
  if (!isWithin(realRoot, realDeployments)
    || !isWithin(realDeployments, physicalManifestPath)
    || (fs.existsSync(manifestPath) && !isWithin(realDeployments, fs.realpathSync(manifestPath)))) {
    throw new Error('Release manifest path must be inside deployments/.');
  }
  const trustedPublicKey = process.env.XCONFESS_RELEASE_TRUSTED_PUBLIC_KEY;
  if (command === 'create') {
    const manifest = createManifest({
      root: ROOT,
      network: options.network,
      sourceRevision: revision,
      privateKey: process.env.XCONFESS_RELEASE_SIGNING_KEY,
      trustedPublicKey,
      networkOverrides,
    });
    verifyManifest({
      root: ROOT, manifest, network: options.network, sourceRevision: revision,
      trustedPublicKey, networkOverrides,
    });
    if (fs.existsSync(manifestPath)) {
      const existing = readJson(ROOT, path.relative(ROOT, manifestPath));
      verifyManifest({
        root: ROOT, manifest: existing, network: options.network, sourceRevision: revision,
        trustedPublicKey, networkOverrides,
      });
      console.log(`Verified existing contract release manifest: ${path.relative(ROOT, manifestPath)}`);
      return 0;
    }
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    console.log(`Signed contract release manifest: ${path.relative(ROOT, manifestPath)}`);
    return 0;
  }
  const manifest = readJson(ROOT, path.relative(ROOT, manifestPath));
  const result = verifyManifest({
    root: ROOT,
    manifest,
    network: options.network,
    sourceRevision: revision,
    trustedPublicKey,
    networkOverrides,
  });
  console.log(`Verified ${result.network.id} contract release manifest for ${result.sourceRevision}.`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  canonicalJson,
  createManifest,
  resolveNetwork,
  verifyManifest,
};
