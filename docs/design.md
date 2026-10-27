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
| ~600 lines of workflows + ops scripts live in the project               | 20 copies drift; every fix is 20 PRs                                      | One reusable workflow in a central repo, referenced by tag (`@v1`). Project keeps ~30 lines                |
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

Kide is the CMS for client projects that need one: an Astro app on SQLite + Drizzle. Projects
start from `create-kide-app` (Node target), and `lautta init --stack kide` adds the platform
files on top. Kide v0.35+ has everything the platform needs, so the stack is settings only:

| Need                    | Kide setting (set by the template)                                   |
| ----------------------- | -------------------------------------------------------------------- |
| Database on the volume  | `CMS_DATABASE_URL=/data/cms.db`, backed up by Litestream            |
| Migrations at boot      | `CMS_MIGRATE_ON_BOOT=1`; `src/cms/migrations` ships in the image     |
| Scheduled publishing    | `CMS_SCHEDULER=1` (in-process; overlapping deploys publish once)     |
| Health check            | `/api/cms/health`                                                    |
| Uploads                 | S3 storage profile → UpCloud Object Storage (`S3_*` from the infra item) |
| Image cache             | `CMS_CACHE_DIR=/data/cache`                                          |
| CI                      | `db:check` → `kide migrate --check`                                  |

Content editors work on production; a later `copy-content-to-staging` ops command can copy
production's database to staging, never the other way round.

### Projects with Hoikka

Hoikka is the e-commerce platform: a SvelteKit app (storefront + admin) on SQLite + Drizzle.
Projects start from `create-hoikka-app` (Node target), and `lautta init --stack hoikka` adds the
platform files. Like Kide, it's settings only:

| Need                   | Hoikka setting (set by the template)                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| Database on the volume | `DATABASE_URL=/data/hoikka.db`, backed up by Litestream                   |
| Migrations at boot     | Built in; `drizzle/` ships in the image; foreign keys off while migrating |
| Scheduler              | Built in, safe with overlapping containers                                 |
| Health check           | `/api/health`                                                              |
| Uploads                | S3 backend → UpCloud Object Storage (`S3_*` from the infra item)          |
| Image cache            | `CACHE_DIR=/data/cache`                                                    |
| Large downloads        | `BODY_SIZE_LIMIT=209715200`; check kamal-proxy's request size limit       |
| Behind kamal-proxy     | `ORIGIN` and `PUBLIC_STORE_URL` per environment                            |
| CI                     | `db:check`                                                                 |

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
  `<project>.staging.<agency-domain>`. Apps get `LAUTTA_ENV=staging` and must send `noindex`
  (and add a password if the client needs one).
- **Production**: deployed by `pnpm release` (date tag), promoting the image staging already ran.
- **PR previews**: skip for now. Revisit once the rest is stable; they're the most work per value.

## Pipeline

One reusable workflow, [`app.yml`](../.github/workflows/app.yml). A project's two workflow files
just call it: `pipeline.yml` (push, pull request, release tag) and `ops.yml` (the Run workflow
buttons, which pass a `command`).

1. **quality**: `lint`, `check` and `db:check` scripts when present; Kamal config parses.
2. **test**: `test`, then `test:e2e` (Playwright) when present.
3. **image** (needs 1–2): build, smoke test the health check and `smoke-paths`; on main, push
   `<image>:<commit>`. Only tested commits reach the registry, so an image there means the commit
   passed.
4. **deploy**: main → staging. A release tag waits for main's image of that commit (or fails if
   main's pipeline failed), tags it with the release name and deploys it to production, then
   writes the GitHub Release notes.
5. **Ops commands** (`command` set): rollback, restore-database, redeploy, setup, backups, logs.

Secrets come from 1Password: `.lautta/secrets.<environment>` lists `op://` references, loaded by
1Password's GitHub action with the repo's only secret, `OP_SERVICE_ACCOUNT_TOKEN`. The deploy SSH
key and the servers' known_hosts come from the shared ops vault.

Projects can tune the pipeline with inputs (`e2e`, `smoke-paths`, `smoke-env`) but not fork it.
`@v1` moves for fixes; breaking changes go to `@v2`, and Renovate brings projects along.

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

## This repo's layout

```
lautta/
  README.md                    day-to-day use
  docs/design.md, runbook.md   this document; what to do when things go wrong
  .github/workflows/app.yml    the reusable pipeline and ops commands
  cli/                         `lautta` CLI: init, doctor, update, release
  templates/                   common/ (Kamal, Litestream, secrets, workflows), node/ and static/
                               Dockerfiles, and a stack.json per stack
  infra/modules/host           server + cloud-init (deploy user, firewall, updates, host-check)
  infra/modules/project        buckets, scoped keys → 1Password, DNS, uptime monitors
  examples/fleet               the private fleet repo: fleet.yml + main.tf
  renovate/default.json        shared preset
```

`fleet.yml` lists real clients and servers, so it lives in a private repo, not here.
`lautta doctor` compares a project's files to the templates it was made from and lists drift;
`lautta update` takes template changes for files the project hasn't edited.

## Roadmap

**Done**

- Reusable pipeline with gated images, staging on main, releases and ops commands
- Templates for SvelteKit, Hoikka, Kide and static Astro; images built and run locally for
  Hoikka, Kide and static Astro
- `lautta` CLI: init, doctor, update, release
- OpenTofu modules for hosts and projects, example fleet with encrypted state
- Server hardening, host-check heartbeats, Renovate preset, runbook

**Next**

1. First real deploy: one shared prod and one staging server, one Hoikka and one Kide project.
   Settle what only a live run shows (Kamal's first `setup`, restore, the 1Password load).
2. Tag `v1` once that works; projects pin `@v1`.
3. Move the feedback tool onto lautta.
4. Weekly restore-test workflow, GHCR retention, Slack deploy notifications, Sentry in the
   Kide and Hoikka templates.
5. Claude Code skill on top of the CLI.
6. Later, if wanted: PR previews, Tailscale-only SSH, a self-hosted runner.

## Open questions

1. **Shared or dedicated hosts by default?** Proposal: shared, dedicated on request/for heavy apps.
2. **Postgres**: any upcoming projects that already need it? Decides how soon the Postgres path gets built.
3. **SLAs**: any clients needing guaranteed uptime → dedicated tier + on-call rules.
