#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { verifyManifest } = require('./contract-release-manifest');

const ROOT = path.resolve(__dirname, '..');
const ABI_MANIFEST = 'deployments/contract-abi-manifest.json';
const WASM_MANIFEST = 'deployments/contract-wasm-manifest.json';
const MIGRATION_MANIFEST = 'deployments/contract-storage-migrations.json';
const DEFAULT_OUTPUT = path.join(ROOT, 'contract-release-dry-run-report.json');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--network') {
      options.network = argv[++index];
      if (!options.network || options.network.startsWith('--')) {
        throw new Error('--network requires a network name.');
      }
    } else if (argument === '--output') {
      const output = argv[++index];
      if (!output || output.startsWith('--')) throw new Error('--output requires a file path.');
      options.output = path.resolve(ROOT, output);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.network || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.network)) {
    throw new Error('A valid --network name is required (letters, digits, "_" and "-" only).');
  }
  return options;
}

function readJson(root, relativePath) {
  const filePath = path.join(root, relativePath);
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${relativePath}: ${error.message}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function safeArtifactPath(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) return null;
  const contractsRoot = path.resolve(root, 'xconfess-contracts');
  const fullPath = path.resolve(contractsRoot, relativePath);
  if (!isWithin(contractsRoot, fullPath)) return null;
  if (!fs.existsSync(fullPath)) return fullPath;
  const realContractsRoot = fs.realpathSync(contractsRoot);
  const realFilePath = fs.realpathSync(fullPath);
  return isWithin(realContractsRoot, realFilePath) ? realFilePath : null;
}

function validateManifests(abiManifest, wasmManifest, migrationManifest) {
  const abiContracts = abiManifest?.contracts;
  const wasmContracts = wasmManifest?.contracts;
  const migrations = migrationManifest?.contracts;
  if (migrationManifest?.schema_version !== 1
    || !abiContracts || typeof abiContracts !== 'object' || Array.isArray(abiContracts)
    || !wasmContracts || typeof wasmContracts !== 'object' || Array.isArray(wasmContracts)
    || !migrations || typeof migrations !== 'object' || Array.isArray(migrations)) {
    throw new Error('ABI, WASM, and storage migration manifests must each contain a contracts object.');
  }
  const names = Object.keys(wasmContracts).sort();
  if (!names.length || JSON.stringify(names) !== JSON.stringify(Object.keys(abiContracts).sort())
    || JSON.stringify(names) !== JSON.stringify(Object.keys(migrations).sort())) {
    throw new Error('ABI, WASM, and storage migration manifests must declare the same non-empty contract set.');
  }
  for (const name of names) {
    const wasm = wasmContracts[name];
    const abi = abiContracts[name];
    const migration = migrations[name];
    if (!wasm || !abi || !migration
      || typeof wasm.version !== 'string' || !wasm.version
      || typeof abi.version !== 'string' || !abi.version
      || wasm.version !== abi.version
      || !SHA256_PATTERN.test(wasm.sha256 || '')
      || !SHA256_PATTERN.test(wasm.abi_sha256 || '')
      || !Array.isArray(abi.functions)
      || abi.functions.some((functionName) => typeof functionName !== 'string')
      || (abi.function_signatures !== undefined && (
        !abi.function_signatures
        || typeof abi.function_signatures !== 'object'
        || Array.isArray(abi.function_signatures)
        || JSON.stringify(Object.keys(abi.function_signatures).sort()) !== JSON.stringify([...abi.functions].sort())
        || Object.keys(abi.function_signatures).some((functionName) =>
            typeof abi.function_signatures[functionName] !== 'string'
            || !abi.function_signatures[functionName].trim()
            || !abi.functions.includes(functionName))
      ))
      || (migration.changes && migration.changes.some((change) => typeof change !== 'string'))
      || !Number.isInteger(migration.initial_schema_version)
      || !Number.isInteger(migration.target_schema_version)
      || migration.initial_schema_version < 1
      || migration.target_schema_version < migration.initial_schema_version
      || typeof migration.entrypoint !== 'string'
      || !migration.entrypoint
      || typeof migration.authorized_role !== 'string'
      || !migration.authorized_role
      || !Array.isArray(migration.changes)) {
      throw new Error(`Malformed or inconsistent release metadata for contract '${name}'.`);
    }
  }
  return names;
}

function createReport({ network, abiManifest, wasmManifest, migrationManifest, deployment, commit, root = ROOT, now = new Date() }) {
  const names = validateManifests(abiManifest, wasmManifest, migrationManifest);
  const checks = [];
  const check = (name, status, details) => checks.push({ name, status, details });
  const deployedContracts = deployment?.contracts && typeof deployment.contracts === 'object'
    ? deployment.contracts
    : null;
  const deploymentNetworkMatches = !deployment?.network || deployment.network === network;
  check('deployment network metadata', deploymentNetworkMatches ? 'passed' : 'blocked',
    deploymentNetworkMatches ? `deployment metadata matches ${network}` : `deployment metadata declares ${deployment.network}, not ${network}.`);
  const deployedNames = deployedContracts ? Object.keys(deployedContracts).sort() : [];
  const deployedSetMatches = Boolean(deployedContracts
    && JSON.stringify(names) === JSON.stringify(deployedNames));
  check('target deployment metadata', deployedContracts ? 'passed' : 'review_required',
    deployedContracts ? `${deployedNames.length} deployed contracts recorded` : 'No deployment record; first-deployment approval and baseline review are required.');
  check('target contract set', deployedSetMatches ? 'passed' : (deployedContracts ? 'blocked' : 'review_required'),
    deployedContracts ? (deployedSetMatches ? 'candidate and target contract sets match' : 'candidate and target contract sets differ') : 'No prior contract set is available.');

  const artifactResults = names.map((name) => {
    const metadata = wasmManifest.contracts[name];
    const artifactPath = safeArtifactPath(root, metadata.wasm_file);
    const exists = Boolean(artifactPath && fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile());
    const actualDigest = exists ? sha256(artifactPath) : null;
    const digestMatches = exists && actualDigest === metadata.sha256;
    const abiPath = safeArtifactPath(root, `contracts/${name}/abi.json`);
    const abiExists = Boolean(abiPath && fs.existsSync(abiPath) && fs.statSync(abiPath).isFile());
    const actualAbiDigest = abiExists ? sha256(abiPath) : null;
    const abiVersion = abiExists ? readJson(root, `xconfess-contracts/contracts/${name}/abi.json`).version : null;
    const abiMatches = abiExists && actualAbiDigest === metadata.abi_sha256
      && abiVersion === abiManifest.contracts[name].version
      && abiVersion === metadata.version;
    return {
      contract: name,
      version: metadata.version,
      wasm: {
        path: metadata.wasm_file,
        sha256: metadata.sha256,
        verification: !artifactPath ? 'invalid_path' : !exists ? 'not_available' : digestMatches ? 'verified' : 'mismatch',
        ...(actualDigest ? { actualSha256: actualDigest } : {}),
      },
      abi: {
        sha256: metadata.abi_sha256,
        verification: !abiPath ? 'invalid_path' : !abiExists ? 'not_available' : abiMatches ? 'verified' : 'mismatch',
        ...(actualAbiDigest ? { actualSha256: actualAbiDigest } : {}),
        functions: [...abiManifest.contracts[name].functions].sort(),
      },
    };
  });
  const artifactStatus = artifactResults.every((artifact) =>
    artifact.wasm.verification === 'verified' && artifact.abi.verification === 'verified')
    ? 'passed'
    : artifactResults.some((artifact) => artifact.wasm.verification === 'mismatch'
      || artifact.wasm.verification === 'invalid_path'
      || artifact.abi.verification === 'mismatch'
      || artifact.abi.verification === 'invalid_path') ? 'blocked' : 'review_required';
  check('candidate artifact digests', artifactStatus,
    artifactStatus === 'passed' ? 'all candidate WASM and ABI digests and versions verified against local artifacts'
      : 'one or more local WASM or ABI artifacts are unavailable or mismatch their release metadata; build/reconcile artifacts before deployment.');

  const signedManifestPath = path.join(root, 'deployments', `contract-release-manifest-${network}-${commit}.json`);
  if (fs.existsSync(signedManifestPath)) {
    try {
      const signedManifest = JSON.parse(fs.readFileSync(signedManifestPath, 'utf8'));
      verifyManifest({
        root,
        manifest: signedManifest,
        network,
        sourceRevision: commit,
        trustedPublicKey: process.env.XCONFESS_RELEASE_TRUSTED_PUBLIC_KEY,
        networkOverrides: {
          id: process.env.XCONFESS_NETWORK_ID,
          environment: process.env.XCONFESS_RELEASE_ENVIRONMENT,
          passphrase: process.env.XCONFESS_NETWORK_PASSPHRASE,
        },
      });
      check('signed release manifest', 'passed', 'signature, network, source revision, ABI versions, and artifact digests verified');
    } catch (error) {
      check('signed release manifest', 'blocked', error.message);
    }
  } else {
    check('signed release manifest', 'not_available', 'no signed release manifest exists for this candidate and network yet');
  }

  const abiContracts = names.map((name) => {
    const prior = deployedContracts?.[name];
    const priorFunctions = prior && Array.isArray(prior.functions) ? prior.functions : null;
    const candidateFunctions = abiManifest.contracts[name].functions;
    const priorSignatures = prior?.function_signatures;
    const candidateSignatures = abiManifest.contracts[name].function_signatures;
    const priorSignaturesComplete = priorSignatures && priorFunctions
      && JSON.stringify(Object.keys(priorSignatures).sort()) === JSON.stringify([...priorFunctions].sort())
      && Object.values(priorSignatures).every((signature) => typeof signature === 'string');
    const removedFunctions = priorFunctions
      ? priorFunctions.filter((functionName) => !candidateFunctions.includes(functionName)).sort()
      : [];
    const changedSignatures = priorSignatures && candidateSignatures
      ? Object.keys(priorSignatures)
        .filter((functionName) => candidateFunctions.includes(functionName)
          && candidateSignatures[functionName] !== priorSignatures[functionName])
        .sort()
      : [];
    const status = !prior || !priorFunctions
      ? 'review_required'
      : removedFunctions.length || changedSignatures.length ? 'blocked'
        : priorSignaturesComplete && candidateSignatures
          && Object.values(candidateSignatures).every((signature) => signature.trim())
          ? 'compatible' : 'review_required';
    return {
      contract: name,
      fromVersion: prior?.version ?? null,
      toVersion: wasmManifest.contracts[name].version,
      status,
      removedFunctions,
      changedSignatures,
      candidateFunctions: [...candidateFunctions].sort(),
      ...(candidateSignatures ? { candidateFunctionSignatures: candidateSignatures } : {}),
      ...(priorSignatures ? {} : { note: 'Complete prior and candidate ABI signatures are unavailable; compare the deployed ABI before approval.' }),
    };
  });
  const abiStatus = abiContracts.some((contract) => contract.status === 'blocked')
    ? 'blocked' : abiContracts.some((contract) => contract.status === 'review_required') ? 'review_required' : 'compatible';
  check('ABI compatibility', abiStatus,
    abiStatus === 'compatible' ? 'no prior exported functions were removed or changed'
      : abiStatus === 'blocked' ? 'candidate removes or changes one or more previously recorded exported functions'
        : 'complete prior/candidate ABI signatures are unavailable; manual compatibility review is required.');

  const migrationContracts = names.map((name) => {
    const plan = migrationManifest.contracts[name];
    const prior = deployedContracts?.[name];
    const fromSchemaVersion = Number.isInteger(prior?.storage_schema_version)
      ? prior.storage_schema_version : null;
    const effectiveFromVersion = fromSchemaVersion ?? plan.initial_schema_version;
    const required = plan.target_schema_version > effectiveFromVersion;
    const downgrade = fromSchemaVersion !== null && fromSchemaVersion > plan.target_schema_version;
    return {
      contract: name,
      fromSchemaVersion,
      assumedFromSchemaVersion: fromSchemaVersion === null ? plan.initial_schema_version : undefined,
      toSchemaVersion: plan.target_schema_version,
      required,
      entrypoint: plan.entrypoint,
      authorizedRole: plan.authorized_role,
      changes: plan.changes,
      status: downgrade ? 'blocked' : fromSchemaVersion === null ? 'review_required' : required ? 'required' : 'not_required',
    };
  });
  const schemaUnknown = migrationContracts.some((migration) => migration.fromSchemaVersion === null);
  const migrationsRequired = migrationContracts.some((migration) => migration.required);
  const migrationDowngrade = migrationContracts.some((migration) => migration.status === 'blocked');
  check('storage migration plan', migrationDowngrade ? 'blocked' : schemaUnknown ? 'review_required' : 'passed',
    migrationDowngrade ? 'candidate storage schema is older than the recorded target; downgrade is blocked.'
      : schemaUnknown ? 'target deployment does not record storage schema versions; confirm on-chain versions before finalizing steps.'
      : migrationsRequired ? 'one or more contracts require the listed authorized migration entrypoint'
        : 'no schema migration is required for the recorded target versions.');

  const requiredApprovals = [
    { name: 'release-review', required: true, status: 'pending', reason: 'Review candidate versions, artifact digests, and compatibility evidence.' },
    { name: 'deployment-operator', required: true, status: 'pending', reason: `Authorize and execute the release on ${network}.` },
  ];
  if (migrationsRequired || schemaUnknown) {
    requiredApprovals.push({
      name: 'migration-owner',
      required: true,
      status: 'pending',
      reason: 'Confirm on-chain schema versions, migration rehearsal, and rollback constraints.',
    });
  }
  if (['mainnet', 'public'].includes(network.toLowerCase())) {
    requiredApprovals.push({
      name: 'production-approver',
      required: true,
      status: 'pending',
      reason: 'Approve the production network change window and rollback plan.',
    });
  }

  const steps = [
    { order: 1, action: 'confirm-target-network-and-deployed-contract-ids', status: 'not_run' },
    { order: 2, action: 'verify-candidate-wasm-and-abi-digests', status: 'not_run' },
    { order: 3, action: 'review-abi-compatibility-and-approve-release', status: 'not_run' },
    { order: 4, action: 'back-up-current-contract-state-and-confirm-schema-versions', status: 'not_run' },
    { order: 5, action: 'upload-and-upgrade-contracts-to-candidate-wasm', status: 'not_run' },
    ...migrationContracts.filter((migration) => migration.required).map((migration) => ({
      order: 6,
      contract: migration.contract,
      action: `invoke-${migration.entrypoint}-as-${migration.authorizedRole.replaceAll(' ', '-')}`,
      fromSchemaVersion: migration.fromSchemaVersion,
      assumedFromSchemaVersion: migration.assumedFromSchemaVersion,
      toSchemaVersion: migration.toSchemaVersion,
      status: 'not_run',
    })),
    { order: 7, action: 'verify-post-migration-schema-and-state', status: 'not_run' },
  ];
  steps.forEach((step, index) => { step.order = index + 1; });

  const statuses = checks.map((item) => item.status);
  const status = statuses.includes('blocked') ? 'blocked'
    : statuses.includes('review_required') ? 'review_required'
      : 'ready_for_approval';
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    target: {
      network,
      previousDeployment: deployedContracts ? {
        found: true,
        contractCount: deployedNames.length,
      } : { found: false, contractCount: 0 },
    },
    candidate: {
      ...(commit ? { commit } : {}),
      contracts: artifactResults,
    },
    abiCompatibility: { status: abiStatus, contracts: abiContracts },
    storageMigrations: { status: migrationDowngrade ? 'blocked' : schemaUnknown ? 'review_required' : 'known', contracts: migrationContracts },
    steps,
    requiredApprovals,
    checks,
    status,
  };
}

function outputPathFor(root, output) {
  const deploymentsDirectory = path.resolve(root, 'deployments');
  const protectedPaths = [
    path.resolve(root, ABI_MANIFEST),
    path.resolve(root, WASM_MANIFEST),
    path.resolve(root, MIGRATION_MANIFEST),
  ];
  const resolvedOutput = path.resolve(output);
  let existingPath = resolvedOutput;
  while (!fs.existsSync(existingPath) && existingPath !== path.dirname(existingPath)) {
    existingPath = path.dirname(existingPath);
  }
  const physicalOutput = path.resolve(fs.realpathSync(existingPath), path.relative(existingPath, resolvedOutput));
  const canonicalProtectedPaths = protectedPaths.map((protectedPath) =>
    fs.existsSync(protectedPath) ? fs.realpathSync(protectedPath) : protectedPath);
  const physicalDeploymentsDirectory = fs.existsSync(deploymentsDirectory)
    ? fs.realpathSync(deploymentsDirectory) : deploymentsDirectory;
  if (physicalOutput === physicalDeploymentsDirectory || isWithin(physicalDeploymentsDirectory, physicalOutput)
    || canonicalProtectedPaths.includes(physicalOutput)) {
    throw new Error('Report output must not overwrite deployment or release input metadata.');
  }
  return resolvedOutput;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const deploymentPath = `deployments/${options.network}.json`;
  const abiManifest = readJson(ROOT, ABI_MANIFEST);
  const wasmManifest = readJson(ROOT, WASM_MANIFEST);
  const migrationManifest = readJson(ROOT, MIGRATION_MANIFEST);
  const deploymentFile = path.join(ROOT, deploymentPath);
  const deployment = fs.existsSync(deploymentFile) ? readJson(ROOT, deploymentPath) : null;
  const output = outputPathFor(ROOT, options.output);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const report = createReport({
    network: options.network,
    abiManifest,
    wasmManifest,
    migrationManifest,
    deployment,
    commit,
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
  const displayPath = isWithin(ROOT, output) ? path.relative(ROOT, output) : output;
  console.log(`Contract release dry-run report: ${displayPath}`);
  console.log(`Target: ${options.network}; status: ${report.status}`);
  for (const item of report.checks) console.log(`${item.status.toUpperCase()}: ${item.name} (${item.details})`);
  return report.status === 'ready_for_approval' ? 0 : report.status === 'blocked' ? 1 : 2;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createReport, outputPathFor, parseArgs, validateManifests };
