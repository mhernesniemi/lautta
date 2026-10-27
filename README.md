# Lautta

Build, ship and run client web apps on UpCloud, the same way every time.

Each project gets:

- **A pipeline**: checks and tests on pull requests; main deploys to staging; `pnpm release`
  ships the same tested image to production.
- **Zero-downtime deploys** with [Kamal](https://kamal-deploy.org), HTTPS included.
- **SQLite backed up continuously** to Object Storage with Litestream.
- **Ops buttons** in GitHub Actions: rollback, restore the database, logs.
- **Secrets from 1Password**, never typed into GitHub.

Stacks: `sveltekit`, `hoikka`, `kide`, `astro-static`.

## Start a project

```sh
pnpm dlx github:mhernesniemi/lautta init --stack hoikka --vault client \
  --production-domain shop.client.fi --production-host 203.0.113.10 \
  --staging-domain client-shop.staging.example.fi --staging-host 203.0.113.20
pnpm install
```

Then:

1. Add the project to the fleet (see [Servers](#servers)) and apply: buckets, DNS and monitors.
2. In 1Password, fill in `<service>-production` and `<service>-staging` in the client's vault.
3. Give the repo the secret `OP_SERVICE_ACCOUNT_TOKEN`.
4. Push to main, then run **Actions → Ops → setup** once per environment.

## Release

```sh
pnpm release
```

Tags main as `vYYYY.MM.DD` and deploys it to production once main's pipeline has passed.

## When something goes wrong

**Actions → Ops → Run workflow**, pick the command and the environment.

| Problem                 | Command            |
| ----------------------- | ------------------ |
| A release broke the app | `rollback`         |
| Data is broken or lost  | `restore-database` |
| Need to see what's up   | `logs`             |
| Backups stopped         | `backups`          |

More in the [runbook](docs/runbook.md).

## Keep projects up to date

Renovate bumps lautta in every project. Then `pnpm lautta doctor` shows what changed, and
`pnpm lautta update` takes the new templates for files the project hasn't edited.

## Servers

[`infra/modules`](infra/modules) has OpenTofu modules for servers and projects;
[`examples/fleet`](examples/fleet) shows the private fleet repo that uses them.

## The app contract

- Pins pnpm with `packageManager` and Node with `.node-version`
- Listens on port 3000 and has a health check
- Logs to stdout; all config from env vars
- Runs its migrations at start
- Keeps data only in `/data` or Object Storage

The why behind all of this: [docs/design.md](docs/design.md).
