# Lautta — design

A shared way to build, ship, run and watch 20+ client web apps (Node + Vite, Astro or SvelteKit) on
UpCloud, with a small team. Built from what works in `new-feedback-tool`, minus the parts that
won't survive being copied 20 times.

## Goals

1. **A new project is live in under an hour**: repo, staging and production, TLS, backups,
   error tracking, uptime alerts. Mostly one command.
2. **Every project works the same way.** Anyone on the team can deploy, roll back or restore any
   client's app without reading its README first.
3. **Fixes land everywhere.** Improving the pipeline once improves all projects; no copy-paste drift.
4. **Humans need only git and a browser.** Deploys, rollbacks and restores run in GitHub Actions
   (as now). Only whoever provisions servers needs extra tools.
5. **Boring, cheap, EU-hosted.** Few moving parts, no Kubernetes, SaaS only where self-hosting
   costs more than it saves.

## Decided

- **UpCloud** is the only hosting target (PaaS options such as Railway were considered and ruled out).
- **Kamal 2** deploys every app.
- **OpenTofu** (not Terraform) for infrastructure as code, with encrypted state.
- **SQLite + Litestream** by default, UpCloud Managed PostgreSQL as an option; Drizzle and its
  migrations in every app.
- **Kide CMS** when a project needs a CMS; **Hoikka** for e-commerce.
- **Monitoring:** Sentry (app) + Better Stack (infrastructure), plans sized below.
- **We own client repos and domains**: repos in our GitHub org, domains in our DNS account.
- **1Password** is the source of truth for secrets.

## What to keep from new-feedback-tool

It's a good foundation. These parts carry over almost as they are:

| Piece                                             | Why it's right                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| Kamal 2 + kamal-proxy                             | Zero-downtime deploys, automatic Let's Encrypt, no orchestrator to run |
| Multi-stage Dockerfile, non-root, `/up` check     | Small image, healthcheck gates traffic                                 |
| Build once in CI, deploy that exact image         | What was tested is what ships                                          |
| Smoke test of the real container in CI            | Catches broken builds before they reach a server                       |
| `pnpm release` → date tag → deploy → release note | Simple, readable versions; needs only git                              |
| Ops commands as workflow_dispatch buttons         | rollback / restore / setup without local tooling                       |
| SQLite + Litestream to Object Storage (other DC)  | Point-in-time restore for pennies; perfect for small apps              |
| Sentry with hidden source maps, release tagging   | Readable stack traces, errors tied to a release                        |
| Docker log caps                                   | Disks don't fill up silently                                           |
| Config from env, secrets never in the image       | Same image for staging and production                                  |

## What to change for 20+ projects

| Today                                                                   | Problem at scale                                                          | Change                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| ~600 lines of workflows + ops scripts live in the project               | 20 copies drift; every fix is 20 PRs                                      | Reusable workflows + composite actions in a central repo, referenced by tag (`@v1`). Project keeps ~30 lines |
| Ops scripts hardcode `colleague_feedback_data`, container names         | Not reusable                                                              | Parametrize by service name; derive volume/container names                                                  |
| Server created by hand, then `kamal setup`                              | Unrepeatable, no hardening, nobody knows what's running where             | OpenTofu (UpCloud provider) + cloud-init; a fleet registry lists every project                              |
| `ssh: root`, `ssh-keyscan` fallback                                     | Root SSH everywhere; trust-on-first-use host keys                         | `deploy` user, root login off, firewall; provisioning outputs known_hosts                                   |
| Production only                                                         | Clients need a place to review before go-live                             | Staging per project (Kamal destination) on a shared staging host; main → staging automatically              |
| CI image push isn't gated on the test job; deploy polls CI for 20 min   | Image exists ≠ tests passed; polling is slow and fragile                  | One pipeline: test → image → deploy staging; release tag only *promotes* an already-tested image            |
| `ci-passed` branch to let `release.sh` check CI with plain git          | Clever, but extra moving part                                             | Keep the idea, or check the tested image tag exists; decide once centrally                                  |
| Secrets typed into each repo's GitHub environment                       | 20 repos × 2 envs × ~10 secrets; no source of truth, painful rotation      | 1Password vault per client; Kamal fetches secrets from it at deploy time                                    |
| Monitoring = Sentry + "check /up yourself"                              | Nobody notices a dead site, a full disk or a stopped backup               | External uptime checks, host metrics, backup restore tests, all alerting to Slack                           |
| Litestream and restore steps tied to one app                            | Every project needs the same backups and restores                         | Generic Litestream accessory, restore commands and a weekly restore test (see Data)                         |
| Image tags per commit in GHCR forever                                   | Registry bloat                                                            | Retention job: keep release tags + last N commits                                                           |

## The app contract

The platform only stays generic if every app follows the same contract. Templates set this up; CI
checks what it can.

- Listens on `PORT` (default `3000`), one process, adapter `@sveltejs/adapter-node` or
  `@astrojs/node` (standalone). Static Astro sites ship as a tiny static-server image instead.
- `GET /up` returns 200 when the app can serve (DB reachable).
- Shuts down cleanly on `SIGTERM` within the drain timeout.
- Logs to stdout, JSON in production (one line per event), never to files.
- All config via env vars; `.env.example` lists every one.
- Migrations run on start-up (or a `migrate` command Kamal runs before boot).
- Persistent state only in `/data` (SQLite) or external services — never in the container.
- User uploads go to Object Storage, or (Kide and Hoikka for now) to the volume with its own backup.
- Sentry initialised from `SENTRY_DSN`; release from `SENTRY_RELEASE`. No DSN → no reporting.
- `.node-version` + `packageManager` pinned; pnpm.

## Architecture

```
GitHub (agency org)                         UpCloud
┌──────────────────────────┐                ┌───────────────────────────────────────────┐
│ lautta (this repo) │                │ fi-hel1                                    │
│  reusable workflows  @v1  │                │  ┌ prod-1 ┐ ┌ prod-2 ┐ ┌ client-x (dedicated)┐│
│  templates, CLI, renovate │                │  │ proxy  │ │ proxy  │ │ proxy               ││
│  opentofu, fleet.yml      │                │  │ app a  │ │ app d  │ │ app x               ││
└────────────┬─────────────┘                │  │ app b… │ │ app e… │ └─────────────────────┘│
             │ uses: …@v1                    │  └────────┘ └────────┘ ┌ staging-1 ─────────┐ │
┌────────────▼─────────────┐   SSH (Kamal)  │                        │ all staging apps    │ │
│ client-project repo      ├───────────────►│                        └─────────────────────┘ │
│  ~30 lines of workflow   │                │ fi-hel2 / de-fra1                              │
│  config/deploy.yml       │◄── GHCR image  │  Object Storage: backups, uploads              │
└──────────────────────────┘                │                                                │
                                            └───────────────────────────────────────────┘
External: Sentry (app), Better Stack (infra), Slack alerts, DNS provider, 1Password
```

### Hosting tiers

Kamal 2 runs many apps on one host behind a shared kamal-proxy, routed by hostname. Use that:

| Tier          | When                                                         | Where                               |
| ------------- | ------------------------------------------------------------ | ----------------------------------- |
| **Shared**    | Default. Brochure sites, small apps, most of the 20          | `prod-N` hosts, ~5–8 apps per host  |
| **Dedicated** | Heavy traffic, SLA, client pays for isolation or data rules  | Own server, maybe own UpCloud sub-account |
| **Staging**   | Every project                                                | One or two shared `staging-N` hosts |

Trade-off of shared hosts: one noisy app or a bad host update affects several clients. Mitigate
with per-container memory/CPU limits in Kamal, host metrics alerts, and moving an app to its own
host when it outgrows sharing (a change to `fleet.yml` + DNS, no app changes).

### Data

**Drizzle in every app**, with the same migration flow whichever database it runs on.

#### Default: SQLite + Litestream

Apps use **SQLite on the `/data` volume + Litestream** to Object Storage in another zone, as the
feedback tool does, unless there's a reason below to pick Postgres. No database server to run or
pay for, and one set of backup, restore and restore-test tooling covers most projects.

What that commits an app to (the template bakes it in):

- **One app container per environment.** An app that outgrows its share moves to a bigger or
  dedicated host; vertical scaling goes far with SQLite.
- **WAL mode, `busy_timeout`, foreign keys on**, set once in a shared DB helper.
- **Litestream is mandatory**: the pipeline refuses a production deploy without the Litestream
  accessory configured. One bucket path per database file.
- **Weekly restore test**: restore the latest replica, run `PRAGMA integrity_check`, alert on
  failure.
- **Generic ops commands**: `restore-database` (with point in time), `backup` snapshot and
  `reset-demo` from the feedback tool, parametrized.

#### Option: UpCloud Managed PostgreSQL

Pick it when an app needs more than one app container, heavy concurrent writes, direct
reporting/BI access, or the client requires it.

- Provisioned by the OpenTofu `project` module, in the same zone as the app host, reached over
  a private network; credentials as `DATABASE_URL` secret.
- Backups and point-in-time recovery are UpCloud's; `restore-database` for these apps points to
  the UpCloud restore/fork flow instead of Litestream.
- Local dev and tests use PGlite (Drizzle supports it), so no Docker Postgres is needed.
- Staging gets its own small database, never a schema in production's.
- Moving an app from SQLite to Postgres later is a real migration (schema dialects differ in
  Drizzle), so decide at project start.

#### Migrations (both)

- Schema in `src/lib/server/db/schema.ts`; `pnpm db:generate` (drizzle-kit) writes SQL migrations,
  which are committed and reviewed like code. No `drizzle-kit push` outside local dev.
- The app runs pending migrations on start-up with Drizzle's migrator, before `/up` turns
  healthy, so a failed migration fails the deploy and the old version keeps serving.
- Postgres apps with several containers take a `pg_advisory_lock` around the migration so only
  one runs it.
- **Backward-compatible migrations**: during a deploy the old and new versions run side by side
  briefly, so a migration must not break the running version (expand now, contract in a later
  release).
- CI checks that `drizzle-kit generate` produces nothing new (schema and migrations agree) and
  runs all migrations against an empty database.
- Generated `DROP TABLE` + recreate migrations on SQLite cascade-delete child rows: the template's
  docs and a CI check flag them for review (lesson from the feedback tool).

Around it:

| Need           | Choice                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| File uploads   | **UpCloud Object Storage**, bucket per project, scoped keys            |
| Cache / queues | Avoid; a database table goes a long way. Valkey accessory if ever needed |
| CMS            | **Kide CMS** when a project needs one (below); no headless CMSes     |
| E-commerce     | **Hoikka** (below)                                                     |

### Projects with Kide CMS

Kide is the CMS for client projects that need one. It's an Astro app on SQLite + Drizzle, so it
fits the default stack; these are the places where it needs platform support or Kide changes.
Projects start from `create-kide-app` (Node target), and `lautta init` adds the platform files on
top, rather than a separate template duplicating Kide's.

| Kide on Node today                                                    | Platform answer                                                                                      | Kide change worth making                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| DB at `CMS_DATABASE_URL` (default `./data/cms.db`)                    | `CMS_DATABASE_URL=/data/cms.db` on the volume; Litestream as for any app. Always SQLite, never Postgres | —                                                                               |
| Uploads in `CMS_UPLOADS_DIR` (default `public/uploads/`)              | `/data/uploads` on the volume, backed up by a restic/rclone accessory to Object Storage (Litestream covers only the DB) | S3-compatible storage adapter (UpCloud Object Storage), so uploads leave the server |
| Schema via `pnpm cms:push` before start; no schema work at boot       | Container start runs the schema sync, then the server; a failed sync fails `/up`, so the old version keeps serving | Committed Drizzle migrations applied at boot (as the D1 target already does), in line with the rule above |
| Scheduled publishing and tasks need `/api/cms/cron/*` polled each minute | Small per-app cron accessory calling both endpoints over the internal Docker network with `CRON_SECRET` | Opt-in in-process scheduler for Node, removing the accessory                   |
| Standalone Node adapter doesn't compress                              | Verify what kamal-proxy does; otherwise middleware mode + compression in the template                | Compression built in for the Node target                                        |
| No health endpoint documented                                         | Template adds `/up` (DB reachable)                                                                   | Ship `/up` in Kide                                                              |
| Secrets: `KIDE_AUTH_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`, SSO     | Standard secrets in the client's 1Password vault; `CMS_TRUSTED_ORIGIN` from `fleet.yml`     | —                                                                               |

Sharp's image cache should live on the volume too, so renditions survive deploys. Content
editors work on production; staging gets a copy of production's DB and uploads on demand
(`ops: copy-content-to-staging`), never the other way round.

### Projects with Hoikka

Hoikka is the e-commerce platform: a SvelteKit app (storefront + admin) on SQLite + Drizzle.
Projects start from `create-hoikka-app` (Node target), and `lautta init` adds the platform files.
It already fits the platform better than Kide does:

| Hoikka on Node today                                                       | Platform answer                                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| SQLite at `./data/hoikka.db`, Drizzle migrations at boot                   | Fits the contract as is; Litestream as for any app. Always SQLite, never Postgres                   |
| Uploads and image cache under `./data/uploads/` (paths relative to the app) | Mount the volume at `/app/data`; uploads backed up by the same accessory as Kide, skipping `.cache` |
| In-process scheduler (outbox + tasks every minute), started on first request | No cron accessory needed; the `/up` health check starts it. Outbox claims rows, so the brief overlap of old and new containers during a deploy is safe |
| `BODY_SIZE_LIMIT` up to 200 MB for digital-product uploads                 | Raise kamal-proxy's request size limit to match for Hoikka apps                                     |
| No health endpoint                                                         | Template adds `/up` (DB reachable); worth shipping in Hoikka itself                                 |
| Storage adapters `fs` and `r2`                                              | An S3-compatible adapter (UpCloud Object Storage) would move uploads off the server, as for Kide   |

Secrets: `BETTER_AUTH_SECRET`, `ADMIN_SETUP_SECRET` (removed after first setup), `TASKS_SECRET`,
`RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, SSO pairs. `PUBLIC_STORE_URL` comes
from `fleet.yml`.

Shops handle money, so they get more than the baseline:

- **Stripe per environment**: staging uses test-mode keys and its own webhook endpoint;
  production keys only in the production environment. Mock payments never enabled in production.
- **Monitoring**: Better Stack uptime checks on a product page and on checkout, Sentry alert
  rules on checkout and payment errors. Stripe's webhook failure emails go to the ops mailbox.
- **Releases**: no deploys during the client's peak hours or campaigns; the pipeline can block
  production deploys in a freeze window set in `fleet.yml`.
- **Dedicated host** for shops with real volume; small shops can share.
- **Restore drill** before go-live: restore production from backup into staging and place a
  test order.

### Environments

- **Local**: `pnpm dev`, seeded data, no external services required (mock adapters as in the
  feedback tool's HiBob/email outbox — a good pattern to keep).
- **Staging**: deployed automatically on every push to `main` that passes CI.
  `<project>.staging.<agency-domain>`, behind a shared password or IP allow list, `noindex`.
- **Production**: deployed by `pnpm release` (date tag), promoting the image staging already ran.
- **PR previews**: skip for now. Revisit once the rest is stable; they're the most work per value.

## Pipeline

One reusable workflow per stage, all in this repo. A project's whole workflow:

```yaml
# .github/workflows/pipeline.yml in a client project
name: Pipeline
on:
  push: { branches: [main], tags: ['v*'] }
  pull_request:
jobs:
  pipeline:
    uses: mhernesniemi/lautta/.github/workflows/node-app.yml@v1
    with:
      service: client-x-site
    secrets: inherit
```

```yaml
# .github/workflows/ops.yml — the "Run workflow" buttons
name: Ops
on:
  workflow_dispatch:
    inputs:
      command: { type: choice, options: [rollback, restore-database, setup, backups, logs] }
      environment: { type: choice, options: [staging, production] }
      # …
jobs:
  ops:
    uses: mhernesniemi/lautta/.github/workflows/ops.yml@v1
    with: { command: '${{ inputs.command }}', environment: '${{ inputs.environment }}' }
    secrets: inherit
```

`node-app.yml` runs:

1. **quality**: `pnpm lint`, `pnpm check` (svelte-check / astro check), Kamal config parse.
2. **test**: `pnpm test:unit --run`, Playwright e2e (browsers cached).
3. **image** (needs 1–2): build, smoke test `/up` + project-defined URLs, push `:<sha>` to GHCR,
   upload source maps. Trivy scan for critical CVEs (warn first, fail later).
4. **staging** (main only, needs 3): `kamal deploy -d staging --skip-push --version <sha>`.
5. **production** (tag only): verify `:<sha>` exists (= passed), retag as the release, deploy,
   write release notes, mark the Sentry release deployed.

The project can override steps via inputs (e.g. `e2e: false`, `smoke-paths: '/ /login'`) but not
fork the pipeline. Workflow versioning: `@v1` moves for fixes; breaking changes go to `@v2` and
projects upgrade through Renovate.

## Infrastructure as code

- **OpenTofu** with the `UpCloudLtd/upcloud` provider, state in UpCloud Object Storage (S3 backend).
  Client-side state encryption on, since the state holds secrets (Object Storage keys, database
  passwords, Better Stack tokens); the encryption key lives in 1Password and CI
  secrets. Version pinned in `.opentofu-version` and in CI (`opentofu/setup-opentofu`).
- Modules: `host` (server + firewall + cloud-init), `project` (backup and upload buckets + scoped keys,
  optional managed Postgres, DNS records).
- **cloud-init** on every host: `deploy` user with team SSH keys, root login and passwords off,
  UFW/UpCloud firewall (22, 80, 443), unattended security upgrades with a scheduled reboot window,
  Docker installed, Better Stack collector, `host-check` timer (pings the host's heartbeat
  when disk, containers and backups are fine), swap, timezone UTC.
- **`fleet.yml`** — the single source of truth for what runs where:

```yaml
hosts:
  prod-1: { zone: fi-hel1, plan: 2xCPU-4GB, role: shared }
  staging-1: { zone: fi-hel1, plan: 1xCPU-2GB, role: staging }
projects:
  client-x-site:
    client: Client X
    repo: mhernesniemi/client-x-site
    stack: astro-kide # astro-static | astro-kide | sveltekit | hoikka
    host: prod-1
    domains: [www.client-x.fi, client-x.fi]
    db: none # sqlite | postgres | none
    sentry: client-x-site
    owner: matti
```

From it, generate: OpenTofu inputs, Better Stack monitors, the team-facing project list, and each
repo's `DEPLOY_HOST`/`APP_HOST` variables. Label UpCloud resources with `client` for cost reports.

## Monitoring and alerting

Two providers, split by job: **Sentry for the app, Better Stack for the infrastructure.** Both
alert into one Slack channel (`#ops-alerts`), with a clear owner per project in `fleet.yml`.

| What                                       | Tool                                                        | Notes                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Errors (server + browser)                  | **Sentry** (sentry.io, EU region), project per app          | Already wired; source maps + releases work                                                |
| Performance, web vitals                    | **Sentry** tracing, sampled low                             | Per-client need                                                                           |
| Uptime, TLS expiry                         | **Better Stack Uptime**                                     | Checks from outside our infra on `/up` and key pages                                      |
| Status pages                               | **Better Stack**                                            | Only for clients who want one                                                             |
| Heartbeats (backups, restore test, cron)   | **Better Stack heartbeats**                                 | Alert when an expected ping doesn't arrive: Litestream, uploads backup, weekly restore test, Kide cron |
| Logs                                       | **Better Stack Logs**, shipped by its collector on each host | Search across all containers and hosts without SSH                                        |
| Host metrics (disk, RAM, CPU, containers)  | **Better Stack**, from the same collector                   | Graphs plus threshold alerts                                                              |
| Deploy notifications                       | Pipeline posts to Slack, marks the Sentry release deployed  | Team sees what shipped where                                                              |

Monitors, heartbeats and status pages are created from `fleet.yml` with Better Stack's provider
in OpenTofu, so a new project gets the full set without clicking. The collector is installed by
cloud-init.

Heartbeats are aggregated so they don't scale with the number of apps: one per host (its
`host-check` confirms every app's Litestream and uploads backup are current), one for the weekly
restore-test workflow (which loops over all projects), and one per Kide app for scheduled
publishing. Staging isn't uptime-monitored; it alerts no one.

#### Plans (list prices as of 2026-10, annual billing)

| Service      | Plan                                                                                           | ~per month |
| ------------ | ---------------------------------------------------------------------------------------------- | ---------- |
| Sentry       | **Team** (unlimited seats, 50k errors, 5M spans, 90-day lookback), EU region; on-demand budget capped at $25 | $26 + ≤ $25 |
| Better Stack | **Uptime**: 10 included + one 50-monitor pack = 60 (≈ 20 prod apps × 2–3 checks)               | $21        |
|              | **Heartbeats**: 10 included + one 10-pack = 20 (hosts, restore test, Kide crons)               | $17        |
|              | **Logs + metrics**: Europe region, Nano bundle (40 GB, 30-day log retention); 30 GB metrics included | $25        |
|              | **Seats**: team members free; no responder seats until we promise out-of-hours response        | $0         |
|              | **Status pages**: 1 included; extra ones only on client request, billed to that client         | —          |
| **Total**    |                                                                                                | **≈ $90–115** (≈ $5 per project) |

Not bought: Sentry's own cron/uptime monitors and logs (Better Stack covers them), Sentry
Business (only needed for SAML/SSO and advanced quotas), Better Stack error tracking. Review
usage after three months; the first things to grow are monitors (more projects) and log volume.

Not recommended: self-hosted monitoring (one more thing that can quietly break), Prometheus +
Grafana + Loki, ELK.

## Security and maintenance

- **Renovate** with a shared preset from this repo: grouped weekly updates, automerge
  patch/minor dev dependencies when CI is green, Node and base-image bumps in one PR, majors manual.
  Also bumps `lautta@vX` references.
- GitHub org: branch protection on `main` (CI required), secret scanning, Dependabot alerts.
- Image scanning (Trivy) in the pipeline; `pnpm audit` as a non-blocking report.
- Host OS: unattended-upgrades; monthly maintenance workflow updates kamal-proxy and checks
  all hosts' disk, uptime and pending reboots.
- Secrets: **1Password** vault per client (items per environment) is the only place secrets
  are typed in. `.kamal/secrets` fetches them at deploy time with Kamal's 1Password adapter, using
  a read-only 1Password service account scoped to that client's vault; its token is the only
  per-repo GitHub secret. Shared ones (Sentry auth token, Slack webhook, OpenTofu state key) in a
  shared ops vault. Scoped Object Storage keys per project. Rotation = change it in 1Password,
  redeploy.
- GDPR: everything in EU zones; Sentry EU with PII scrubbing (as the feedback tool does);
  list sub-processors per client in `fleet.yml` for DPAs.
- Client handover (rare, since we own repos and domains): transfer the repo and DNS zone, and
  `lautta vendor` copies the shared workflows into the repo.

## Other tools worth adopting

| Need                       | Suggestion                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| Transactional email        | Resend (Kide already supports it); one account, verified sending domain per client |
| DNS                        | Cloudflare (DNS-only mode for kamal-proxy's Let's Encrypt), managed in OpenTofu; every client domain lives in our account |
| Forms spam protection      | Cloudflare Turnstile                                             |
| Analytics                  | Plausible or Umami (cookie-less, no consent banner needed)      |
| Feature flags / search     | Per project; not part of the platform                            |
| Load testing               | k6 script template (the feedback tool has a `load-test.js` start) |
| Claude Code                | A skill that drives the CLI (`new project`, `provision`, `go live`) — the postponed `upcloud-kamal-deploy` idea fits here |

## This repo's layout (target)

```
lautta/
  SETUP.md                     this document
  README.md                    how to use it, day to day
  .github/workflows/           reusable: node-app.yml, ops.yml, restore-test.yml, maintenance.yml
  actions/                     composite actions: setup-node-pnpm, kamal, smoke-test, slack-notify
  templates/
    shared/                    .kamal/secrets, config/deploy.yml, .dockerignore, renovate.json, pipeline.yml, ops.yml
    sveltekit/                 Dockerfile, /up route, hooks with Sentry
    astro-kide/                additions on top of create-kide-app: Dockerfile, /up, cron + uploads backup accessories
    hoikka/                    additions on top of create-hoikka-app: Dockerfile, /up, uploads backup, proxy body limit
    astro-static/              Dockerfile (static server), healthcheck
  cli/                         `lautta` CLI (Node): init, provision, secrets, doctor, vendor
  infra/tofu/                  modules/host, modules/project, fleet/ (reads fleet.yml)
  infra/cloud-init/            host.yaml
  fleet.yml                    every host and project
  renovate/default.json        shared preset
  runbooks/                    rollback, restore, server lost, new client, go-live checklist
  skill/                       Claude Code skill wrapping the CLI
```

`lautta doctor` in a project compares its files to the template version it was generated from and
lists drift — the cheap alternative to keeping templates and projects in sync by hand.

## Roadmap

**Phase 1 — extract (1–2 weeks)**

1. Move feedback tool's workflows into reusable `node-app.yml` + `ops.yml`, parametrized.
2. Fix the gaps found above (image gated on tests, non-root deploy user, known_hosts).
3. Templates for SvelteKit, static Astro, Astro + Kide and Hoikka, with the app contract.
   Deploy one Kide and one Hoikka project end to end to settle schema sync, cron and uploads backup.
4. Switch the feedback tool to the reusable workflows as the first consumer.

**Phase 2 — fleet (2–3 weeks)**

5. OpenTofu + cloud-init for hosts (check first that the UpCloud and Better Stack providers
   resolve in the OpenTofu registry); `fleet.yml`; first shared prod and staging hosts.
6. Staging environment via Kamal destinations; main → staging automatically.
7. Monitoring: Sentry alert rules; Better Stack monitors, heartbeats and collector from `fleet.yml`; Slack alerts.
8. Renovate preset, restore-test workflow, GHCR retention.

**Phase 3 — speed (ongoing)**

9. `lautta` CLI: `init`, `provision`, `doctor`, `vendor`.
10. Claude Code skill on top of the CLI.
11. Runbooks; go-live checklist (DNS, TLS, backups verified, monitors on, Sentry alerts, robots).
12. Later, if wanted: PR previews, Tailscale-only SSH with the Tailscale GitHub Action, a
    self-hosted runner on UpCloud if Actions minutes become a cost.

## Open questions

1. **Shared or dedicated hosts by default?** Proposal: shared, dedicated on request/for heavy apps.
2. **Postgres**: any upcoming projects that already need it? Decides how soon the Postgres path gets built.
3. **SLAs**: any clients needing guaranteed uptime → dedicated tier + on-call rules.
