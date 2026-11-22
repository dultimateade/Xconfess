# Supported Runtime and Service Versions

The repository supports the major versions below. The minimum supported major
and the major currently declared in local development, CI, and deployment
configuration are the same; older majors are not an implicit fallback.

| Component | Minimum supported | Declared validation/runtime | Notes |
| --- | --- | --- | --- |
| Node.js | 22.x | 22.x | `npm run setup:check` rejects a different major; npm 9 or newer is required. |
| PostgreSQL | 16 | 16 | Used by Compose, CI service containers, and the Render database declaration. |
| Redis | 7 | 7 | Used by Compose and CI. Production's managed Redis-compatible service must report major version 7. |

CI exercises the declared PostgreSQL 16 and Redis 7 service images and runs
under Node.js 22. This is a single supported-major configuration, not a claim
that every patch release has an independent test matrix. Revisit this table and
the deployment declarations together when changing a supported major.

## Configuration Guardrails

- The repository governance checks compare the version declarations in Compose,
  Dockerfiles, CI, and Render configuration with this supported set.
- Render runs `scripts/check-node-version.js` before dependency installation so
  an unsupported Node.js major fails before the application build.
- The Render-managed Redis service does not declare its engine major in
  `render.yaml`. `DEPLOY_REDIS_MAJOR_VERSION=7` is an expected-version
  declaration consumed by the release compatibility gate, not a version
  reported by the provider. Verify the selected managed service actually
  reports Redis 7 before rollout; the gate does not connect to production.
- Deployment environment files must declare
  `DEPLOY_NODE_MAJOR_VERSION=22`, `DEPLOY_POSTGRES_MAJOR_VERSION=16`, and
  `DEPLOY_REDIS_MAJOR_VERSION=7`. These declarations are compared with this
  supported set before release; deployment owners remain responsible for
  keeping them aligned with the actual managed service configuration.
- Do not upgrade a service image or deployment major independently. Update this
  matrix, all affected declarations, and any compatibility or migration notes
  in the same change.

Run `npm run deploy:preflight` to check the repository's deployment and service
version declarations. This check does not build the application or contact
production services.