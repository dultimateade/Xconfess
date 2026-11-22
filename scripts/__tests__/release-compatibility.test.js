'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildReport,
  compareContractManifests,
  parseArgs,
  parseDeploymentEnvironment,
  validateDeploymentEnvironment,
} = require('../release-compatibility');

const API_URL = 'https://api.example.test/api';
const DEPLOYMENT_ENV = [
  'NODE_ENV=production',
  'BACKEND_URL=https://api.example.test',
  'FRONTEND_URL=https://app.example.test',
  'JWT_SECRET=private-jwt-secret-that-is-long-enough',
  'APP_SECRET=private-app-secret-that-is-long-enough',
  `CONFESSION_ENCRYPTION_KEY=${'a'.repeat(64)}`,
  'ENCRYPTION_CURRENT_KEY_VERSION=v1',
  `ENCRYPTION_MASTER_KEY_v1=${'b'.repeat(64)}`,
  'TYPEORM_SYNCHRONIZE=false',
  'TYPEORM_MIGRATIONS_RUN=true',
  'DB_HOST=db.internal',
  'DB_PORT=5432',
  'DB_USERNAME=app',
  'DB_PASSWORD=private-db-password',
  'DB_NAME=xconfess',
  'REDIS_HOST=redis.internal',
  'REDIS_PORT=6379',
  'DEPLOY_NODE_MAJOR_VERSION=22',
  'DEPLOY_POSTGRES_MAJOR_VERSION=16',
  'DEPLOY_REDIS_MAJOR_VERSION=7',
  'STELLAR_FEATURES_ENABLED=false',
].join('\n');

function findCheck(checks, name) {
  return checks.find((check) => check.name === name);
}

test('contract compatibility requires identical manifest sets and versions', () => {
  const abi = { alpha: { version: '1.0.0' }, beta: { version: '2.0.0' } };
  const wasm = { beta: { version: '2.0.0' }, alpha: { version: '1.0.0' } };
  assert.deepEqual(compareContractManifests(abi, wasm), {
    names: ['alpha', 'beta'],
    namesMatch: true,
    versionsMatch: true,
  });
});

test('contract compatibility blocks a missing contract and a version mismatch', () => {
  assert.equal(compareContractManifests({ alpha: { version: '1.0.0' } }, {}).namesMatch, false);
  assert.equal(compareContractManifests(
    { alpha: { version: '1.0.0' } },
    { alpha: { version: '2.0.0' } },
  ).versionsMatch, false);
});

test('deployment env parser rejects malformed and duplicate assignments without echoing values', () => {
  const parsed = parseDeploymentEnvironment('DB_PASSWORD=hidden\nDB_PASSWORD=other\nnot-an-assignment');
  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.errors.some((error) => error.includes('hidden') || error.includes('other')), false);
});

test('deployment compatibility accepts required settings and keeps secret values out of the report', () => {
  const report = buildReport({
    deployment: true,
    skipDriftChecks: true,
    deploymentEnvContent: DEPLOYMENT_ENV,
    externalEnv: { BACKEND_API_URL: API_URL, NEXT_PUBLIC_API_URL: API_URL },
  });
  assert.equal(findCheck(report.checks, 'required application settings configured').status, 'passed');
  assert.equal(findCheck(report.checks, 'database connection settings configured').status, 'passed');
  assert.equal(findCheck(report.checks, 'Redis connection settings configured').status, 'passed');
  assert.equal(findCheck(report.checks, 'deployment runtime and service majors match supported versions').status, 'passed');
  assert.equal(findCheck(report.checks, 'contract deployment settings compatible').status, 'passed');
  const serialized = JSON.stringify(report);
  for (const secret of ['private-jwt-secret', 'private-app-secret', 'private-db-password', 'a'.repeat(64), 'b'.repeat(64)]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('provider environment mode validates settings without requiring GitHub-only API URL secrets', () => {
  const { values } = parseDeploymentEnvironment(DEPLOYMENT_ENV);
  const checks = [];
  validateDeploymentEnvironment(checks, values, {});

  assert.equal(findCheck(checks, 'deployment environment syntax valid').status, 'passed');
  assert.equal(findCheck(checks, 'application deployment URLs valid').status, 'passed');
  assert.equal(findCheck(checks, 'database connection settings configured').status, 'passed');
});

test('deployment compatibility blocks missing keys, mismatched versions, and unsafe DB migration settings', () => {
  const env = DEPLOYMENT_ENV
    .replace('REDIS_HOST=redis.internal\n', '')
    .replace('DEPLOY_REDIS_MAJOR_VERSION=7', 'DEPLOY_REDIS_MAJOR_VERSION=6')
    .replace('TYPEORM_SYNCHRONIZE=false', 'TYPEORM_SYNCHRONIZE=true');
  const checks = [];
  validateDeploymentEnvironment(checks, env, {
    BACKEND_API_URL: API_URL,
    NEXT_PUBLIC_API_URL: API_URL,
  });

  assert.equal(findCheck(checks, 'Redis connection settings configured').status, 'blocked');
  assert.equal(findCheck(checks, 'deployment runtime and service majors match supported versions').status, 'blocked');
  assert.equal(findCheck(checks, 'production migration settings safe').status, 'blocked');
});

test('enabled Stellar features require contract IDs matching the deployment record', () => {
  const contractEnv = [
    'STELLAR_FEATURES_ENABLED=true',
    'STELLAR_NETWORK=testnet',
    'STELLAR_CONTRACT_NETWORK=testnet',
    'CONFESSION_ANCHOR_CONTRACT_ID=CB5XMDHT66EISB4WXM4YGNDHYRMZDX42TOHZEAENIUTSSMRFHJSFRNHB',
    'REPUTATION_BADGES_CONTRACT_ID=CDAN4HZHY6XNQR3TRPLPJKVKNURVMMQMF7XNZ6AUNJNFLR77J4DNAEYI',
    'TIPPING_SYSTEM_CONTRACT_ID=CC74UWNAAYDTPEPVKR4CPANWJSF6GI2PCI7BLN6M46KB6CSQYVYLHIWM',
  ].join('\n');
  const enabledDeploymentEnv = DEPLOYMENT_ENV
    .replace('NODE_ENV=production', 'NODE_ENV=development')
    .replace('STELLAR_FEATURES_ENABLED=false', 'STELLAR_FEATURES_ENABLED=true');
  const checks = [];
  validateDeploymentEnvironment(checks, `${enabledDeploymentEnv}\n${contractEnv}`, {
    BACKEND_API_URL: API_URL,
    NEXT_PUBLIC_API_URL: API_URL,
  });
  assert.equal(findCheck(checks, 'contract deployment settings compatible').status, 'passed');

  const productionChecks = [];
  validateDeploymentEnvironment(productionChecks,
    `${DEPLOYMENT_ENV.replace('STELLAR_FEATURES_ENABLED=false', 'STELLAR_FEATURES_ENABLED=true')}\n${contractEnv.replace('STELLAR_FEATURES_ENABLED=true\n', '')}\nSTELLAR_SERVER_SECRET=S${'A'.repeat(55)}`,
    { BACKEND_API_URL: API_URL, NEXT_PUBLIC_API_URL: API_URL });
  assert.equal(findCheck(productionChecks, 'contract deployment settings compatible').status, 'blocked');

  const mismatchedChecks = [];
  validateDeploymentEnvironment(mismatchedChecks,
    `${enabledDeploymentEnv}\n${contractEnv.replace('CB5XMDHT66EISB4WXM4YGNDHYRMZDX42TOHZEAENIUTSSMRFHJSFRNHB', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM')}`,
    { BACKEND_API_URL: API_URL, NEXT_PUBLIC_API_URL: API_URL });
  assert.equal(findCheck(mismatchedChecks, 'contract deployment settings compatible').status, 'blocked');
});

test('release compatibility report output can be selected explicitly', () => {
  assert.equal(parseArgs(['--output', 'tmp/report.json']).output.endsWith('/tmp/report.json'), true);
});

test('deployment mode and prevalidated drift mode are explicit CLI options', () => {
  assert.deepEqual(parseArgs(['--deployment', '--skip-drift-checks']), {
    output: require('node:path').resolve(__dirname, '../..', 'release-compatibility-report.json'),
    deployment: true,
    skipDriftChecks: true,
  });
});