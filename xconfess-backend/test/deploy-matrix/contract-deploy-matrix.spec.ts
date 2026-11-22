import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
  validateCommittedManifests,
} = require('../../../scripts/validate-deployment-manifests');

/**
 * Deploy Boundary Matrix Compatibility Test Suite (Issue #110)
 *
 * Verifies compatibility across deployed backend, frontend proxy, cookies,
 * WebSockets, generated clients, and contract manifests.
 */

export interface DeployMatrixConfig {
  contractVersion: string;
  contractWasmSha256: string;
  apiSchemaVersion: string;
  cookiePolicy: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'strict' | 'lax' | 'none';
  };
  wsProtocol: string;
  clientVersion: string;
}

export interface CompatibilityDiagnostic {
  layer: 'contracts' | 'api' | 'cookies' | 'websockets' | 'client';
  code: string;
  message: string;
  expected: any;
  actual: any;
}

export interface MatrixValidationResult {
  compatible: boolean;
  diagnostics: CompatibilityDiagnostic[];
}

export const SUPPORTED_DEPLOY_MATRIX = {
  contractVersions: ['1.0.0'],
  knownWasmHashes: [
    '38c3d5d76bc026a1a3d25dabc473d9b37a2dd60787145400a1bb327624b76928', // anonymous-tipping
  ],
  apiSchemaVersions: ['v1', 'v2'],
  wsProtocols: ['v1.xconfess', 'v2.xconfess'],
  minimumClientVersion: '1.0.0',
};

export function validateDeployMatrix(config: DeployMatrixConfig): MatrixValidationResult {
  const diagnostics: CompatibilityDiagnostic[] = [];

  // 1. Contract manifest validation
  if (!SUPPORTED_DEPLOY_MATRIX.contractVersions.includes(config.contractVersion)) {
    diagnostics.push({
      layer: 'contracts',
      code: 'ERR_CONTRACT_VERSION_UNSUPPORTED',
      message: `Contract version ${config.contractVersion} is not supported by backend runtime.`,
      expected: SUPPORTED_DEPLOY_MATRIX.contractVersions,
      actual: config.contractVersion,
    });
  }

  if (
    config.contractWasmSha256 &&
    !SUPPORTED_DEPLOY_MATRIX.knownWasmHashes.includes(config.contractWasmSha256)
  ) {
    diagnostics.push({
      layer: 'contracts',
      code: 'ERR_CONTRACT_WASM_MISMATCH',
      message: `WASM SHA-256 hash ${config.contractWasmSha256} does not match verified deployment manifests.`,
      expected: SUPPORTED_DEPLOY_MATRIX.knownWasmHashes,
      actual: config.contractWasmSha256,
    });
  }

  // 2. API Schema validation
  if (!SUPPORTED_DEPLOY_MATRIX.apiSchemaVersions.includes(config.apiSchemaVersion)) {
    diagnostics.push({
      layer: 'api',
      code: 'ERR_API_SCHEMA_MISMATCH',
      message: `API schema version ${config.apiSchemaVersion} is incompatible with current gateway routes.`,
      expected: SUPPORTED_DEPLOY_MATRIX.apiSchemaVersions,
      actual: config.apiSchemaVersion,
    });
  }

  // 3. Cookie boundary validation (Frontend Proxy <-> Backend)
  if (!config.cookiePolicy.httpOnly) {
    diagnostics.push({
      layer: 'cookies',
      code: 'ERR_COOKIE_SECURITY_VIOLATION',
      message: 'Auth session cookie must enforce httpOnly across deploy proxy boundary.',
      expected: true,
      actual: config.cookiePolicy.httpOnly,
    });
  }

  if (config.cookiePolicy.sameSite === 'none' && !config.cookiePolicy.secure) {
    diagnostics.push({
      layer: 'cookies',
      code: 'ERR_COOKIE_INSECURE_SAMESITE_NONE',
      message: 'SameSite=None requires Secure attribute to prevent browser rejection.',
      expected: 'secure: true with sameSite: none',
      actual: 'secure: false',
    });
  }

  // 4. WebSocket protocol validation
  if (!SUPPORTED_DEPLOY_MATRIX.wsProtocols.includes(config.wsProtocol)) {
    diagnostics.push({
      layer: 'websockets',
      code: 'ERR_WS_PROTOCOL_UNSUPPORTED',
      message: `WebSocket subprotocol ${config.wsProtocol} is not accepted by reactions/notifications gateways.`,
      expected: SUPPORTED_DEPLOY_MATRIX.wsProtocols,
      actual: config.wsProtocol,
    });
  }

  // 5. Generated client version check
  const semverParts = config.clientVersion.split('.').map(Number);
  const minParts = SUPPORTED_DEPLOY_MATRIX.minimumClientVersion.split('.').map(Number);
  const isOutdated =
    semverParts[0] < minParts[0] ||
    (semverParts[0] === minParts[0] && semverParts[1] < minParts[1]);

  if (isOutdated) {
    diagnostics.push({
      layer: 'client',
      code: 'ERR_CLIENT_VERSION_DEPRECATED',
      message: `Generated client ${config.clientVersion} is below minimum supported version ${SUPPORTED_DEPLOY_MATRIX.minimumClientVersion}.`,
      expected: `>= ${SUPPORTED_DEPLOY_MATRIX.minimumClientVersion}`,
      actual: config.clientVersion,
    });
  }

  return {
    compatible: diagnostics.length === 0,
    diagnostics,
  };
}

describe('Contract Deploy Boundaries Integration Matrix (Issue #110)', () => {
  const deploymentsDir = path.resolve(__dirname, '../../../deployments');

  describe('Contract Manifest Integrity', () => {
    it('should verify contract-wasm-manifest.json exists and has valid contracts', () => {
      const wasmManifestPath = path.join(deploymentsDir, 'contract-wasm-manifest.json');
      expect(fs.existsSync(wasmManifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(wasmManifestPath, 'utf-8'));
      expect(manifest.contracts).toBeDefined();
      expect(manifest.contracts['anonymous-tipping']).toBeDefined();
      expect(manifest.contracts['anonymous-tipping'].sha256).toBe(
        '38c3d5d76bc026a1a3d25dabc473d9b37a2dd60787145400a1bb327624b76928',
      );
    });

    it('should verify contract-abi-manifest.json contains required entrypoints', () => {
      const abiManifestPath = path.join(deploymentsDir, 'contract-abi-manifest.json');
      expect(fs.existsSync(abiManifestPath)).toBe(true);
      const abiManifest = JSON.parse(fs.readFileSync(abiManifestPath, 'utf-8'));
      expect(abiManifest.contracts).toBeDefined();
      expect(abiManifest.contracts['anonymous-tipping']).toBeDefined();
      expect(abiManifest.contracts['anonymous-tipping'].version).toBe('1.0.0');
    });

    it('should validate all committed deployment metadata and ABI digests', () => {
      const result = validateCommittedManifests();
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should fail closed for mismatched contract IDs and invalid fixture digests', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xconfess-manifest-'));
      try {
        fs.cpSync(deploymentsDir, path.join(tempRoot, 'deployments'), {
          recursive: true,
        });
        fs.cpSync(path.resolve(deploymentsDir, '../xconfess-contracts'), path.join(tempRoot, 'xconfess-contracts'), {
          recursive: true,
        });
        const snapshotPath = path.join(tempRoot, 'deployments', 'fixtures', 'contract-deployment-snapshots.json');
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        snapshot.contracts['confession-anchor'].contract_id = 'INVALID';
        snapshot.contracts['anonymous-tipping'].sha256 = 'not-a-digest';
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

        const result = validateCommittedManifests({ root: tempRoot });
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
          expect.stringContaining('confession-anchor: invalid contract_id'),
          expect.stringContaining('fixture snapshot anonymous-tipping sha256'),
        ]));
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('Deploy Matrix Compatibility Combinations', () => {
    it('should pass with verified production combination', () => {
      const validConfig: DeployMatrixConfig = {
        contractVersion: '1.0.0',
        contractWasmSha256: '38c3d5d76bc026a1a3d25dabc473d9b37a2dd60787145400a1bb327624b76928',
        apiSchemaVersion: 'v1',
        cookiePolicy: {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
        },
        wsProtocol: 'v1.xconfess',
        clientVersion: '1.0.2',
      };

      const result = validateDeployMatrix(validConfig);
      expect(result.compatible).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it('should fail with explicit diagnostics when contract WASM hash is drifted', () => {
      const driftedConfig: DeployMatrixConfig = {
        contractVersion: '1.0.0',
        contractWasmSha256: 'deadbeef00000000000000000000000000000000000000000000000000000000',
        apiSchemaVersion: 'v1',
        cookiePolicy: { httpOnly: true, secure: true, sameSite: 'lax' },
        wsProtocol: 'v1.xconfess',
        clientVersion: '1.0.0',
      };

      const result = validateDeployMatrix(driftedConfig);
      expect(result.compatible).toBe(false);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'contracts',
            code: 'ERR_CONTRACT_WASM_MISMATCH',
          }),
        ]),
      );
    });

    it('should fail with explicit diagnostics when cookie policy violates security boundaries', () => {
      const insecureCookieConfig: DeployMatrixConfig = {
        contractVersion: '1.0.0',
        contractWasmSha256: '63fc6e4e5eb24a737f141bf4d4850550f24fefc66579fc928f6236b3f7bf285f',
        apiSchemaVersion: 'v1',
        cookiePolicy: { httpOnly: false, secure: false, sameSite: 'none' },
        wsProtocol: 'v1.xconfess',
        clientVersion: '1.0.0',
      };

      const result = validateDeployMatrix(insecureCookieConfig);
      expect(result.compatible).toBe(false);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'cookies',
            code: 'ERR_COOKIE_SECURITY_VIOLATION',
          }),
          expect.objectContaining({
            layer: 'cookies',
            code: 'ERR_COOKIE_INSECURE_SAMESITE_NONE',
          }),
        ]),
      );
    });

    it('should fail with explicit diagnostics on incompatible WebSocket protocol version', () => {
      const legacyWsConfig: DeployMatrixConfig = {
        contractVersion: '1.0.0',
        contractWasmSha256: '63fc6e4e5eb24a737f141bf4d4850550f24fefc66579fc928f6236b3f7bf285f',
        apiSchemaVersion: 'v1',
        cookiePolicy: { httpOnly: true, secure: true, sameSite: 'lax' },
        wsProtocol: 'legacy-raw',
        clientVersion: '1.0.0',
      };

      const result = validateDeployMatrix(legacyWsConfig);
      expect(result.compatible).toBe(false);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'websockets',
            code: 'ERR_WS_PROTOCOL_UNSUPPORTED',
          }),
        ]),
      );
    });

    it('should fail with explicit diagnostics when client version is deprecated', () => {
      const outdatedClientConfig: DeployMatrixConfig = {
        contractVersion: '1.0.0',
        contractWasmSha256: '63fc6e4e5eb24a737f141bf4d4850550f24fefc66579fc928f6236b3f7bf285f',
        apiSchemaVersion: 'v1',
        cookiePolicy: { httpOnly: true, secure: true, sameSite: 'lax' },
        wsProtocol: 'v1.xconfess',
        clientVersion: '0.9.1',
      };

      const result = validateDeployMatrix(outdatedClientConfig);
      expect(result.compatible).toBe(false);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'client',
            code: 'ERR_CLIENT_VERSION_DEPRECATED',
          }),
        ]),
      );
    });
  });
});
