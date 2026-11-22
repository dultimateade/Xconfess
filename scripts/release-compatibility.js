#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUPPORTED_VERSIONS = require('./supported-service-versions');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'release-compatibility-report.json');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const ENCRYPTION_KEY = /^(?!0{64}$)[a-fA-F0-9]{64}$/;
const CONTRACT_ENV_KEYS = {
  'confession-anchor': 'CONFESSION_ANCHOR_CONTRACT_ID',
  'reputation-badges': 'REPUTATION_BADGES_CONTRACT_ID',
  'anonymous-tipping': 'TIPPING_SYSTEM_CONTRACT_ID',
};

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, deployment: false, skipDriftChecks: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--deployment') {
      options.deployment = true;
    } else if (argv[index] === '--skip-drift-checks') {
      options.skipDriftChecks = true;
    } else if (argv[index] === '--output') {
      const output = argv[++index];
      if (!output || output.startsWith('--')) throw new Error('--output requires a file path.');
      options.output = path.resolve(ROOT, output);
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (options.skipDriftChecks && !options.deployment) {
    throw new Error('--skip-drift-checks requires --deployment.');
  }
  return options;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  try {
    return { value: JSON.parse(fs.readFileSync(absolutePath, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: `${relativePath}: ${error.message}` };
  }
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function addCheck(checks, name, passed, details = '') {
  checks.push({ name, status: passed ? 'passed' : 'blocked', ...(details ? { details } : {}) });
}

function compareContractManifests(abiContracts, wasmContracts) {
  const validMap = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const abiNames = validMap(abiContracts) ? Object.keys(abiContracts).sort() : [];
  const wasmNames = validMap(wasmContracts) ? Object.keys(wasmContracts).sort() : [];
  const namesMatch = abiNames.length > 0 && JSON.stringify(abiNames) === JSON.stringify(wasmNames);
  const versionsMatch = namesMatch && abiNames.every((name) =>
    typeof abiContracts[name]?.version === 'string' &&
    SEMVER.test(abiContracts[name].version) &&
    abiContracts[name].version === wasmContracts[name]?.version,
  );
  return { names: abiNames, namesMatch, versionsMatch };
}

function parseDeploymentEnvironment(contents) {
  const values = Object.create(null);
  const errors = [];
  for (const [index, rawLine] of String(contents).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      errors.push(`line ${index + 1} is not a KEY=VALUE assignment`);
      continue;
    }
    const [, name, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      errors.push(`line ${index + 1} repeats ${name}`);
      continue;
    }
    let value = rawValue.trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value.at(-1) !== quote) {
        errors.push(`line ${index + 1} has an unterminated quoted value`);
        continue;
      }
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return { values, errors };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateDeploymentEnvironment(checks, contents, externalEnv = process.env) {
  const isEnvFile = typeof contents === 'string';
  const isEnvObject = contents && typeof contents === 'object' && !Array.isArray(contents);
  if ((!isEnvFile || contents.trim() === '') && !isEnvObject) {
    addCheck(checks, 'deployment environment provided', false, 'BACKEND_ENV_FILE is missing or empty');
    return null;
  }
  addCheck(checks, 'deployment environment provided', true);

  const { values, errors } = isEnvFile
    ? parseDeploymentEnvironment(contents)
    : { values: contents, errors: [] };
  addCheck(
    checks,
    'deployment environment syntax valid',
    errors.length === 0,
    errors.length ? errors.join('; ') : isEnvFile ? 'KEY=VALUE format' : 'Provider environment variables',
  );

  const applicationKeys = [
    'NODE_ENV',
    'BACKEND_URL',
    'FRONTEND_URL',
    'JWT_SECRET',
    'APP_SECRET',
    'CONFESSION_ENCRYPTION_KEY',
    'ENCRYPTION_CURRENT_KEY_VERSION',
    'ENCRYPTION_MASTER_KEY_v1',
    'TYPEORM_SYNCHRONIZE',
    'TYPEORM_MIGRATIONS_RUN',
  ];
  const databaseKeys = ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME'];
  const redisKeys = ['REDIS_HOST', 'REDIS_PORT'];
  const missing = (keys) => keys.filter((key) => !values[key]?.trim());
  const missingApplication = missing(applicationKeys);
  const missingDatabase = missing(databaseKeys);
  const missingRedis = missing(redisKeys);
  addCheck(checks, 'required application settings configured', missingApplication.length === 0,
    missingApplication.length ? `Missing: ${missingApplication.join(', ')}` : 'Required application settings are present');
  addCheck(checks, 'database connection settings configured', missingDatabase.length === 0,
    missingDatabase.length ? `Missing: ${missingDatabase.join(', ')}` : 'Required database settings are present');
  addCheck(checks, 'Redis connection settings configured', missingRedis.length === 0,
    missingRedis.length ? `Missing: ${missingRedis.join(', ')}` : 'Required Redis settings are present');

  const configuredVersions = {
    node: values.DEPLOY_NODE_MAJOR_VERSION || null,
    postgres: values.DEPLOY_POSTGRES_MAJOR_VERSION || null,
    redis: values.DEPLOY_REDIS_MAJOR_VERSION || null,
  };
  const versionMismatches = Object.entries(SUPPORTED_VERSIONS)
    .filter(([component, supported]) => configuredVersions[component] !== String(supported))
    .map(([component, supported]) => `${component} must be ${supported}`);
  addCheck(checks, 'deployment runtime and service majors match supported versions',
    versionMismatches.length === 0,
    versionMismatches.length ? versionMismatches.join('; ') : 'Node.js, PostgreSQL, and Redis majors match');

  const activeKeyVersion = values.ENCRYPTION_CURRENT_KEY_VERSION;
  const encryptionKeysValid =
    typeof values.JWT_SECRET === 'string' && values.JWT_SECRET.length >= 32 &&
    typeof values.APP_SECRET === 'string' && values.APP_SECRET.length >= 32 &&
    ENCRYPTION_KEY.test(values.CONFESSION_ENCRYPTION_KEY || '') &&
    ENCRYPTION_KEY.test(values.ENCRYPTION_MASTER_KEY_v1 || '') &&
    /^v\d+$/.test(activeKeyVersion || '') &&
    (activeKeyVersion === 'v1' || ENCRYPTION_KEY.test(values[`ENCRYPTION_MASTER_KEY_${activeKeyVersion}`] || ''));
  addCheck(checks, 'application secrets and encryption key versions valid', encryptionKeysValid,
    encryptionKeysValid ? 'Required secret formats and active encryption key are valid' :
      'JWT_SECRET, APP_SECRET, encryption keys, or ENCRYPTION_CURRENT_KEY_VERSION are invalid');

  const databasePort = Number(values.DB_PORT);
  const redisPort = Number(values.REDIS_PORT);
  const servicesValid =
    /^\d+$/.test(values.DB_PORT || '') &&
    Number.isInteger(databasePort) && databasePort > 0 && databasePort <= 65535 &&
    /^\d+$/.test(values.REDIS_PORT || '') &&
    Number.isInteger(redisPort) && redisPort > 0 && redisPort <= 65535;
  addCheck(checks, 'database and Redis ports valid', servicesValid,
    servicesValid ? 'Configured ports are valid' : 'DB_PORT and REDIS_PORT must be valid TCP ports');

  const productionSettingsValid =
    ['production', 'staging'].includes(values.NODE_ENV) &&
    ['false', '0', 'no', 'off'].includes(String(values.TYPEORM_SYNCHRONIZE).toLowerCase()) &&
    ['true', '1', 'yes', 'on'].includes(String(values.TYPEORM_MIGRATIONS_RUN).toLowerCase());
  addCheck(checks, 'production migration settings safe', productionSettingsValid,
    productionSettingsValid ? 'Production mode, schema synchronization off, migrations on' :
      'NODE_ENV must be production/staging, TYPEORM_SYNCHRONIZE off, and TYPEORM_MIGRATIONS_RUN on');

  const externalApiUrlsPresent = Boolean(externalEnv.BACKEND_API_URL || externalEnv.NEXT_PUBLIC_API_URL);
  const externalApiUrlsRequired = isEnvFile;
  const externalApiUrlsValid = externalApiUrlsRequired || externalApiUrlsPresent
    ? isHttpUrl(externalEnv.BACKEND_API_URL || '') && isHttpUrl(externalEnv.NEXT_PUBLIC_API_URL || '')
    : true;
  const urlsValid = isHttpUrl(values.BACKEND_URL || '') && isHttpUrl(values.FRONTEND_URL || '') &&
    externalApiUrlsValid;
  const apiUrls = [externalEnv.BACKEND_API_URL, externalEnv.NEXT_PUBLIC_API_URL];
  const apiPathsValid = !externalApiUrlsRequired && !externalApiUrlsPresent || apiUrls.every((value) => {
    if (!isHttpUrl(value || '')) return false;
    return new URL(value).pathname.replace(/\/+$/, '').endsWith('/api');
  });
  addCheck(checks, 'application deployment URLs valid', urlsValid && apiPathsValid,
    urlsValid && apiPathsValid ? 'Backend, frontend, and API URLs are configured' :
      'Backend/frontend URLs must be HTTP(S), and API URLs must include /api');

  let contractSettingsValid = true;
  let contractDetails = 'On-chain features disabled';
  if (String(values.STELLAR_FEATURES_ENABLED).toLowerCase() === 'true') {
    const contractNetwork = values.STELLAR_CONTRACT_NETWORK;
    const network = values.STELLAR_NETWORK;
    const idsValid = Object.values(CONTRACT_ENV_KEYS).every((key) => CONTRACT_ID.test(values[key] || ''));
    const productionDeployment = ['production', 'staging'].includes(values.NODE_ENV);
    const signerConfigured = Boolean(values.STELLAR_SERVER_SECRET);
    const signerValid = productionDeployment
      ? /^S[A-Z2-7]{55}$/.test(values.STELLAR_SERVER_SECRET || '')
      : !signerConfigured || /^S[A-Z2-7]{55}$/.test(values.STELLAR_SERVER_SECRET || '');
    contractSettingsValid = ['testnet', 'mainnet'].includes(network) &&
      contractNetwork === network && idsValid && signerValid &&
      (!productionDeployment || network === 'mainnet');
    contractDetails = contractSettingsValid
      ? 'Contract IDs and declared network are configured'
      : 'Contract IDs must match their network; production/staging also requires a mainnet network and valid signer';

    if (contractSettingsValid) {
      const metadataPath = values.DEPLOYMENT_METADATA_PATH || `deployments/${network === 'mainnet' ? 'public' : network}.json`;
      const resolvedMetadataPath = path.resolve(ROOT, metadataPath);
      const relativeMetadataPath = path.relative(ROOT, resolvedMetadataPath);
      if (relativeMetadataPath.startsWith('..') || path.isAbsolute(relativeMetadataPath)) {
        contractSettingsValid = false;
        contractDetails = 'DEPLOYMENT_METADATA_PATH must resolve inside the repository';
      } else {
        const metadata = readJson(relativeMetadataPath);
        if (metadata.error || metadata.value?.network !== network) {
          contractSettingsValid = false;
          contractDetails = 'matching contract deployment metadata is missing or invalid';
        } else {
          const deployed = metadata.value.contracts || {};
          const abiContracts = readJson('deployments/contract-abi-manifest.json').value?.contracts || {};
          const wasmContracts = readJson('deployments/contract-wasm-manifest.json').value?.contracts || {};
          const idsMatch = Object.entries(CONTRACT_ENV_KEYS).every(([contract, key]) =>
            deployed[contract]?.contract_id === values[key] &&
            typeof deployed[contract]?.version === 'string' &&
            deployed[contract].version === abiContracts[contract]?.version &&
            deployed[contract].version === wasmContracts[contract]?.version,
          );
          contractSettingsValid = idsMatch;
          contractDetails = idsMatch ? 'Contract IDs and versions match deployment metadata and manifests' :
            'Configured contract IDs or versions do not match deployment metadata and manifests';
        }
      }
    }
  } else if (String(values.STELLAR_FEATURES_ENABLED).toLowerCase() !== 'false') {
    contractSettingsValid = false;
    contractDetails = 'STELLAR_FEATURES_ENABLED must be explicitly true or false';
  }
  addCheck(checks, 'contract deployment settings compatible', contractSettingsValid, contractDetails);

  return {
    configuredVersions,
    stellarFeaturesEnabled: String(values.STELLAR_FEATURES_ENABLED).toLowerCase() === 'true',
  };
}

function runDriftCheck(name, args, env = process.env) {
  const result = spawnSync('bash', args, { cwd: ROOT, encoding: 'utf8', env });
  const remediation = args[0] === 'scripts/check-openapi-drift.sh'
    ? 'Run npm run check:openapi-drift and update the generated API client/snapshot.'
    : 'Run npm run check:abi-drift and reconcile contract source, ABI, and manifests.';
  return {
    name,
    status: result.status === 0 ? 'passed' : 'blocked',
    exitCode: result.status ?? 1,
    ...(result.status === 0 ? {} : { remediation }),
  };
}

function buildReport({
  output = DEFAULT_OUTPUT,
  now = new Date(),
  deployment = false,
  skipDriftChecks = false,
  deploymentEnvContent,
  externalEnv = process.env,
} = {}) {
  const checks = [];
  const rootPackage = readJson('package.json');
  const backendPackage = readJson('xconfess-backend/package.json');
  const frontendPackage = readJson('xconfess-frontend/package.json');
  const apiSnapshot = readJson('scripts/.api-snapshot.json');
  const abiManifest = readJson('deployments/contract-abi-manifest.json');
  const wasmManifest = readJson('deployments/contract-wasm-manifest.json');

  const versions = {
    root: rootPackage.value?.version ?? null,
    backend: backendPackage.value?.version ?? null,
    frontend: frontendPackage.value?.version ?? null,
  };
  addCheck(checks, 'application versions recorded',
    Object.values(versions).every((version) => typeof version === 'string' && SEMVER.test(version)));

  const versionFiles = {
    compose: readText('compose.yaml'),
    backendDockerfile: readText('Dockerfile.backend'),
    frontendDockerfile: readText('Dockerfile.frontend'),
    ci: readText('.github/workflows/ci.yml'),
    release: readText('.github/workflows/release-pipeline.yml'),
    cd: readText('.github/workflows/cd.yml'),
    render: readText('render.yaml'),
  };
  const renderMajorMatches = (key, major) =>
    new RegExp(`- key:\\s*${key}\\s*\\n\\s*value:\\s*["']?${major}["']?\\s*(?:\\n|$)`)
      .test(versionFiles.render);
  const deploymentVersionsValid =
    new RegExp(`node-version:\\s*${SUPPORTED_VERSIONS.node}\\b`).test(versionFiles.ci) &&
    new RegExp(`node-version:\\s*${SUPPORTED_VERSIONS.node}\\b`).test(versionFiles.release) &&
    new RegExp(`node-version:\\s*${SUPPORTED_VERSIONS.node}\\b`).test(versionFiles.cd) &&
    new RegExp(`FROM\\s+node:${SUPPORTED_VERSIONS.node}-alpine`).test(versionFiles.backendDockerfile) &&
    new RegExp(`FROM\\s+node:${SUPPORTED_VERSIONS.node}-alpine`).test(versionFiles.frontendDockerfile) &&
    new RegExp(`image:\\s*postgres:${SUPPORTED_VERSIONS.postgres}-alpine`).test(versionFiles.compose) &&
    new RegExp(`image:\\s*postgres:${SUPPORTED_VERSIONS.postgres}-alpine`).test(versionFiles.ci) &&
    new RegExp(`image:\\s*postgres:${SUPPORTED_VERSIONS.postgres}-alpine`).test(versionFiles.release) &&
    new RegExp(`image:\\s*redis:${SUPPORTED_VERSIONS.redis}-alpine`).test(versionFiles.compose) &&
    new RegExp(`image:\\s*redis:${SUPPORTED_VERSIONS.redis}-alpine`).test(versionFiles.ci) &&
    new RegExp(`image:\\s*redis:${SUPPORTED_VERSIONS.redis}-alpine`).test(versionFiles.release) &&
    new RegExp(`postgresMajorVersion:\\s*["']${SUPPORTED_VERSIONS.postgres}["']`).test(versionFiles.render) &&
    renderMajorMatches('DEPLOY_NODE_MAJOR_VERSION', SUPPORTED_VERSIONS.node) &&
    renderMajorMatches('DEPLOY_POSTGRES_MAJOR_VERSION', SUPPORTED_VERSIONS.postgres) &&
    renderMajorMatches('DEPLOY_REDIS_MAJOR_VERSION', SUPPORTED_VERSIONS.redis) &&
    /buildCommand:\s*node scripts\/check-node-version\.js &&/.test(versionFiles.render);
  addCheck(checks, 'deployment configurations declare supported service versions', deploymentVersionsValid,
    deploymentVersionsValid ? 'Node.js, PostgreSQL, and Redis declarations match supported majors' :
      'A CI, release, CD, Compose, or Render version declaration is missing or incompatible');

  const snapshotPath = path.join(ROOT, 'scripts/.api-snapshot.json');
  const routeCount = apiSnapshot.value?.controllerRouteCount;
  addCheck(checks, 'OpenAPI snapshot available', !apiSnapshot.error && Number.isInteger(routeCount) && routeCount > 0,
    apiSnapshot.error || (Number.isInteger(routeCount) ? `${routeCount} controller routes` : 'invalid controller route count'));

  addCheck(checks, 'contract manifests available', !abiManifest.error && !wasmManifest.error,
    abiManifest.error || wasmManifest.error || 'ABI and WASM manifests parsed');

  const abiContracts = abiManifest.value?.contracts;
  const wasmContracts = wasmManifest.value?.contracts;
  const contractComparison = compareContractManifests(abiContracts, wasmContracts);
  addCheck(checks, 'ABI and WASM contract sets match', contractComparison.namesMatch);
  addCheck(checks, 'ABI and WASM contract versions match', contractComparison.versionsMatch);

  const artifactPaths = [
    'scripts/.api-snapshot.json',
    'deployments/contract-abi-manifest.json',
    'deployments/contract-wasm-manifest.json',
  ];
  const artifacts = artifactPaths.map((relativePath) => ({
    path: relativePath,
    sha256: fs.existsSync(path.join(ROOT, relativePath)) ? sha256(path.join(ROOT, relativePath)) : null,
  }));

  if (skipDriftChecks) {
    addCheck(checks, 'source drift checks completed before deployment', true);
  } else {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xconfess-release-compat-'));
    try {
      checks.push(
        runDriftCheck('OpenAPI source/client drift', ['scripts/check-openapi-drift.sh']),
        runDriftCheck('Contract ABI/source drift', ['xconfess-contracts/scripts/check-abi-drift.sh'], {
          ...process.env,
          ABI_REPORT_PATH: path.join(tempDir, 'abi-compat-report.json'),
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const deploymentSummary = deployment
    ? validateDeploymentEnvironment(checks, deploymentEnvContent, externalEnv)
    : null;
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    candidate: { commit: commit.status === 0 ? commit.stdout.trim() : 'unknown', versions },
    api: {
      snapshot: 'scripts/.api-snapshot.json',
      routeCount: Number.isInteger(routeCount) ? routeCount : null,
      snapshotSha256: fs.existsSync(snapshotPath) ? sha256(snapshotPath) : null,
    },
    contracts: {
      names: contractComparison.names,
      abiManifestVersion: abiManifest.value?.manifest_version ?? null,
      wasmManifestVersion: wasmManifest.value?.schema_version ?? null,
      abiManifestSha256: artifacts[1].sha256,
      wasmManifestSha256: artifacts[2].sha256,
    },
    ...(deployment ? { deployment: deploymentSummary } : {}),
    artifacts,
    checks,
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    reportPath: path.relative(ROOT, output),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = buildReport({
    ...options,
    deploymentEnvContent: options.deployment
      ? Object.prototype.hasOwnProperty.call(process.env, 'BACKEND_ENV_FILE')
        ? process.env.BACKEND_ENV_FILE
        : process.env
      : undefined,
  });
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Release compatibility report: ${path.relative(ROOT, options.output)}`);
  for (const check of report.checks) {
    console.log(`${check.status.toUpperCase()}: ${check.name}${check.details ? ` (${check.details})` : ''}`);
  }
  return report.status === 'passed' ? 0 : 1;
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
  buildReport,
  compareContractManifests,
  parseArgs,
  parseDeploymentEnvironment,
  validateDeploymentEnvironment,
};