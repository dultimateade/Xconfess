# Release-Time Environment Compatibility

`npm run check:release-compatibility` writes
`release-compatibility-report.json` for the current Git candidate. It checks
application package versions, API and contract artifacts, contract manifest
versions, and the Node.js/PostgreSQL/Redis versions declared by CI, Compose,
Render, and the release workflows. A missing, malformed, or incompatible
declaration blocks the command.

The staging/production release workflows and the CD workflow also run the
deployment mode before syncing or restarting services. Render runs it during
the build preflight using provider environment variables directly:

```bash
node scripts/release-compatibility.js --deployment --skip-drift-checks
```

For the GitHub workflows, `BACKEND_ENV_FILE` must contain one `KEY=VALUE`
assignment per line and `BACKEND_API_URL` and `NEXT_PUBLIC_API_URL` must be set
in the process environment. The Render build checks its provider environment
directly. Both modes require application security and migration settings,
database and Redis connection keys, and these explicit deployment
major-version declarations:

```dotenv
DEPLOY_NODE_MAJOR_VERSION=22
DEPLOY_POSTGRES_MAJOR_VERSION=16
DEPLOY_REDIS_MAJOR_VERSION=7
```

Set the declared service majors to the versions configured by the deployment
provider. The gate compares these declarations with the supported versions in
`docs/supported-service-versions.md` and the repository deployment files; it
does not connect to production to discover provider-side versions. Stellar
contract IDs are required when `STELLAR_FEATURES_ENABLED=true` and must match
the selected deployment metadata and network. Production and staging also
require a mainnet network and a valid signer; testnet settings block rollout.

The report contains package/service versions, check statuses, key names in
failure details, and artifact digests only. It never writes environment values,
secret lengths, secret digests, or the contents of `BACKEND_ENV_FILE`. A blocked
check exits non-zero before rollout; fix the named configuration or artifact
issue and rerun the workflow. Deployment checks skip source drift only because
the same release candidate has already passed those checks in the build stage.
The deployment report is retained as a workflow artifact with the release
evidence.
