# Lautta — design

A shared way to build, ship and run many client web apps (Node + Vite, Astro or SvelteKit) on
UpCloud, with a small team.

## Goals

1. **A new project is live in under an hour**: staging and production, TLS, backups, monitoring.
2. **Every project works the same way.** Anyone can deploy, roll back or restore any app.
3. **Fixes land everywhere.** Improve the pipeline once, every project gets it.
4. **Git and a browser are enough** for day-to-day work: deploys and ops run in GitHub Actions.
5. **Boring, cheap, EU-hosted.** Few moving parts, no Kubernetes.

## Choices

| Choice                                      | Why                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------- |
| UpCloud                                     | EU hosting, simple servers and Object Storage                        |
| Kamal 2 + kamal-proxy                       | Zero-downtime deploys, Let's Encrypt, no orchestrator to run         |
| Many apps per server, routed by hostname    | Cheap; an app that outgrows it moves to its own server               |
| Build once, deploy that exact image         | What was tested is what ships                                        |
| One reusable workflow, pinned by tag (`@v1`) | One fix reaches every project; a project keeps ~60 lines of workflow |
| SQLite + Litestream                         | No database server; point-in-time restore for pennies                |
| OpenTofu + cloud-init                       | Servers, buckets, DNS and monitors are repeatable and written down   |
| 1Password                                   | One place to type, rotate and revoke secrets                         |
| Sentry + Better Stack                       | Sentry for app errors, Better Stack for everything outside the app   |

## The app contract

- Listens on port 3000 with a health check that returns 200 when the app can serve.
- Shuts down cleanly on `SIGTERM`.
- Logs to stdout; all config from env vars.
- Runs its migrations on start-up.
- Keeps state only in `/data` (SQLite) or Object Storage.
- Pins Node in `.node-version` and pnpm in `packageManager`.

Templates set this up; `lautta doctor` and CI check what they can.

## Data

- **SQLite on the `/data` volume** by default, streamed by Litestream (a Kamal accessory) to
  Object Storage in another zone. One app container per environment.
- **UpCloud Managed PostgreSQL** when an app needs several containers, heavy concurrent writes
  or BI access. Decide at project start; switching later is a real migration.
- **Drizzle** in every app. Migrations are generated, committed and reviewed; the app applies
  them before its health check turns healthy, so a failed migration fails the deploy.
- Migrations stay backward compatible, since old and new versions run side by side briefly.
- Uploads go to a per-project bucket with its own keys.

Kide and Hoikka meet the contract with settings only; each stack's `stack.json` lists them.

## Environments

- **Staging**: every push to `main` that passes CI. Runs with `LAUTTA_ENV=staging` and must
  send `noindex`.
- **Production**: `pnpm release` tags main (`vYYYY.MM.DD`) and promotes the image staging ran.

## Pipeline

One reusable workflow, [`app.yml`](../.github/workflows/app.yml), called by each project's
`pipeline.yml` and `ops.yml`.

1. **quality**: `lint`, `check` and `db:check` when present; Kamal config parses.
2. **test**: `test`, then `test:e2e` when present.
3. **image**: build and smoke-test the container; on main, push `<image>:<commit>`. An image in
   the registry means its commit passed.
4. **deploy**: main → staging. A release tag retags main's tested image and deploys it to
   production, then writes release notes.
5. **ops**: rollback, restore-database, redeploy, setup, backups, logs.

Secrets are `op://` references in `.lautta/secrets.<environment>`, loaded with the repo's only
GitHub secret, `OP_SERVICE_ACCOUNT_TOKEN`.

## Infrastructure

A private fleet repo holds `fleet.yml` (every server and project) and the OpenTofu root that
applies it; [`examples/fleet`](../examples/fleet) is its template. State is encrypted
client-side and kept in Object Storage.

- **`host` module**: an UpCloud server whose cloud-init sets up a `deploy` user only, a firewall
  (22, 80, 443), automatic security updates, Docker, swap, and a `host-check` timer that pings
  Better Stack when disk, memory, containers and backups are fine. Host keys come from OpenTofu,
  so known_hosts is known in advance.
- **`project` module**: buckets and scoped keys per environment (written to 1Password),
  Cloudflare DNS records and Better Stack uptime monitors.

## Monitoring

- **Sentry** (EU): errors from server and browser, tied to releases.
- **Better Stack**: uptime checks on production, one heartbeat per server, logs and host
  metrics from its collector. Heartbeats don't grow with the number of apps.

## Secrets

- A 1Password vault per client, with an item per environment, is the only place secrets are
  typed in. OpenTofu writes storage keys into separate `-infra` items.
- Each repo's service account reads its client's vault and the shared ops vault (deploy key,
  known_hosts).
- Rotate by changing the value in 1Password and redeploying.
- Handover: transfer the repo, the DNS zone and the vault's contents.
