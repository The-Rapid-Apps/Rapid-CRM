# Self-host Rapid with containers

Rapid ships a standard Docker image and a Docker Compose stack with the web
app, scheduled jobs, MySQL 8.4, and Redis. Only the web app needs a public
domain. The databases stay on the private Compose network, and named volumes
preserve their data across redeploys.

The stack works on a Docker server or a deployment platform supporting Docker
Compose. Platforms that run individual containers can use the same application
image with their own database, networking, and scheduling configuration.

## Deploy with Docker Compose

Requires Docker Compose v2 and Node 22.22+ only for the one-time secret generator.
The published image supports AMD64 and ARM64:

```text
ghcr.io/the-rapid-apps/rapid-crm:latest
```

Run from the repository directory:

```sh
node docker/setup.mjs
# Edit .env.compose: set APP_URL and SEED_ADMIN_EMAIL.
docker compose --env-file .env.compose -f compose.yaml -f compose.local.yaml up -d --wait
```

Open `http://localhost:3000/login`. Use `SEED_ADMIN_EMAIL` and the generated
`SERVICE_PASSWORD_64_ADMIN` from `.env.compose` to sign in. The generator
refuses to overwrite existing secrets, and the file is gitignored. It leaves
the development `.env` untouched.

The web container runs as a non-root user. Before serving requests it applies
Prisma migrations and creates the initial admin. Repeated starts do not reset
an existing admin's password or create another organization. Deploy one web
service and one scheduler per database; additional schedulers duplicate jobs.

For public deployment, set `APP_URL` to your HTTPS origin and put an HTTPS
reverse proxy on the Compose network. `compose.local.yaml` binds the web port
to loopback; use `compose.yaml` alone when your platform or proxy handles routing.

### Deploy through a Compose dashboard

1. Import this repository's `compose.yaml` into a Docker Compose resource.
2. Run `node docker/setup.mjs` locally and supply the generated values through
   the resource's environment settings. Some dashboards can generate the
   `SERVICE_PASSWORD_*` values themselves; preserve them on later deployments.
3. Set `SEED_ADMIN_EMAIL` and `APP_URL` to your email and public HTTPS origin.
4. Route the public domain to the `rapid` service on internal port **3000**.
   Leave `mysql`, `redis`, and `scheduler` without public ports or domains.
5. Deploy and wait for `/healthz` to become healthy, then sign in at `/login`.

This resource pulls the prebuilt image; it does not build on the deployment
server. Keep `compose.local.yaml` out of dashboard deployments that supply
container networking and a reverse proxy.

### First publication, forks, and private registries

The image is published after a successful `main` CI run. Wait for **CI** and
**Publish container** to succeed before pulling the first release. Forks publish
under their own lowercased repository name; set `RAPID_IMAGE` to that image.

New GHCR packages are private by default. After the first publication, make the
package public in GitHub's package settings, or authenticate Docker on each
deployment server with a GitHub token with `read:packages`. Keep registry tokens
out of Compose and application environment variables. See
[GitHub's registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

To build from source before the GHCR package exists:

```sh
docker build -t rapid:local .
# Add RAPID_IMAGE=rapid:local to .env.compose.
docker compose --env-file .env.compose -f compose.yaml -f compose.local.yaml up -d --pull never --wait
```

## Updates and optional automatic deployment

Update to the newest tested release:

```sh
docker compose --env-file .env.compose -f compose.yaml -f compose.local.yaml pull
docker compose --env-file .env.compose -f compose.yaml -f compose.local.yaml up -d --wait
```

On a deployment dashboard, select its redeploy action after image publication.
`pull_policy: always` fetches the current image at deployment time. Updating a
GHCR tag alone does not update a running container.

For automatic deployment, configure GitHub repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_WEBHOOK` | Optional deployment endpoint accepting an HTTP POST after publication |
| `DEPLOY_TOKEN` | Optional token sent as `Authorization: Bearer ...` |

Use the hosting platform's authenticated deploy hook. Signed webhook URLs can
work without a separate bearer token; keep the whole URL in the secret. If the
platform requires a different payload or authentication method, adapt the final
workflow step. With neither secret configured, image publication still works.
A token without a webhook URL is treated as a configuration error.

Disable direct Git push deployment when using this hook, so the host waits for
the new image to be published instead of pulling the previous release. The
publisher runs only after successful `main` CI, ignores pull requests and
superseded commits, and publishes both `latest` and `sha-<full-commit>` tags.

To pin a version, set:

```text
RAPID_IMAGE=ghcr.io/the-rapid-apps/rapid-crm:sha-<full-commit>
```

Back up MySQL before updating. An older image may need an older database
schema; restore a matching backup if a migration changed it incompatibly.

## Other container platforms

The image is portable; the complete stack requires a platform supporting the
Compose network, persistent database volumes, and a continuously running
scheduler. For example, [Dokploy supports Compose](https://docs.dokploy.com/docs/core/docker-compose)
and can import the supplied stack directly. Other container hosts need their
own resource definitions.

The local smoke test verifies the Docker Compose installation. The following
platform mappings describe additional configuration, rather than deployment
paths validated by that test.

### Render

Use the image for a web service and native scheduled jobs, and provide persistent
MySQL and Redis separately. A `render.yaml` Blueprint can describe these
resources. See [Docker deployment](https://render.com/docs/docker) and
[multi-service architecture](https://render.com/docs/multi-service-architecture).

### Google Cloud Run

Cloud Run's Compose deployment translates a subset of Compose into one service
with multiple containers. It is not equivalent to running this stack on a Docker
host. Mirror the application image to Artifact Registry, use Cloud SQL for MySQL
and a reachable Redis service, and configure scheduled work through Cloud
Scheduler and Cloud Run Jobs. Google's Compose guide recommends Terraform for
production infrastructure configuration. See
[Cloud Run's Compose support and limitations](https://docs.cloud.google.com/run/docs/deploy-run-compose).

### Configuration when deploying individual containers

- Supply `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `SESSION_SECRET`,
  `CREDENTIAL_ENCRYPTION_KEY`, `CRON_SECRET`, `SEED_ADMIN_EMAIL`, and
  `SEED_ADMIN_PASSWORD` directly. Compose normally maps `SERVICE_PASSWORD_*`
  to these application keys; passing only the generated names to a standalone
  web service is insufficient.
- Set `HOST=0.0.0.0` and the platform's listening `PORT`. For a port other than
  3000, configure the platform's health probe for `/healthz` on that port rather
  than using the Docker image's default port-3000 health check.
- Provide persistent MySQL storage or managed MySQL, and Redis reachable through
  private networking. MySQL's data directory needs database-compatible storage,
  not ephemeral container storage or an object-storage filesystem.
- Run the schedules in `docker/crontabs/root` through native scheduled jobs.
  Each job can use this image with a command such as
  `node --import tsx scripts/sync-shopify.ts`. Set `APP_INTERNAL_URL` to the
  reachable web service origin and supply the web app's `CRON_SECRET`.
  The default `web` command does not start scheduled work.
- If the platform also requires service-level authentication, HTTP-driven jobs
  must supply that authentication in addition to the application's cron secret.
- For multiple web instances, run `npm run db:deploy` and `npm run db:seed` once
  in a separate initialization job before release. Start each web instance with
  `node --import tsx server.js`; the default `web` command performs migrations
  and seeding at every container start.

## Configuration and maintenance

| Value | Purpose |
| --- | --- |
| `APP_URL` | Public HTTPS origin for billing callbacks and password reset links |
| `SEED_ADMIN_EMAIL` | Initial dashboard admin email |
| `SERVICE_PASSWORD_64_ADMIN` | Initial password; changing it does not reset an existing account |
| `SERVICE_PASSWORD_MYSQL` / `SERVICE_PASSWORD_MYSQLROOT` | Database credentials; preserve after first deployment |
| `SERVICE_PASSWORD_64_SESSION` | Session signing key |
| `SERVICE_PASSWORD_64_ENCRYPTION` | Token encryption key; preserve for the lifetime of the database |
| `SERVICE_PASSWORD_64_CRON` | Authenticates the scheduler's internal HTTP requests |
| `RAPID_IMAGE` | Defaults to the upstream repository's GHCR `latest` image |
| `POSTMARK_SERVER_TOKEN` / `MAIL_FROM_ADDRESS` | Optional transactional email, using a verified sender |
| `FLEX_PARTNER_CREDITS_ENABLED` | Defaults to false; enable only after adding Partner credentials |

Secrets used in the Compose database URL must be alphanumeric; the generator
uses hex. Shopify credentials are configured inside the app under **Apps** and
**Connections**, and are not needed to start the platform.

For GA4/BigQuery, configure the GCP values from `.env.example` on your platform
and mount the service-account JSON read-only into both `rapid` and `scheduler`.
Set `GOOGLE_APPLICATION_CREDENTIALS` to that container path. Keys are never
included in the image; these integrations are optional at startup.

The scheduler runs in UTC: Shopify sync and logo-churn snapshots every five
minutes, live-discount checks hourly at minute 20, and API-log cleanup Sunday
at 03:00. It uses the same jobs as the bare-metal PM2 setup. Both containers
must run the same image. Inspect scheduler logs if analytics stop advancing.

Back up MySQL and the environment secrets before updating. Keep the encryption
key with the backup: the database alone cannot decrypt stored Partner tokens.
Preserve named volumes when redeploying. `down` preserves data;
`down --volumes` deletes it.

Inspect status and logs (add the local override when using it):

```sh
docker compose --env-file .env.compose ps
docker compose --env-file .env.compose logs --tail 100 rapid scheduler
```

For contributors, verify a fresh disposable installation with:

```sh
docker build -t rapid:smoke .
node docker/smoke-test.mjs
```

The smoke test checks migrations, readiness, admin login, the dashboard, each
scheduled job, and a restart using the same data. It removes only its own
temporary test stack and volumes.
