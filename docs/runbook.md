# Runbook

All ops commands: **GitHub → the project → Actions → Ops → Run workflow**. Pick the command and
the environment. After any of them, check the site's health URL.

## A release broke the app

Run `rollback`. It switches to the version that ran before, in seconds. To go further back,
put the version (e.g. `v2026.10.05`) in `version`. Data is untouched.

## Data is broken or lost

Run `restore-database`. It restores the latest backup and restarts the app. To go back to
before the damage, put a UTC time in `restore_to`, e.g. `2026-10-07T12:00:00Z` (up to 14
days back). The replaced database stays in the volume as `<file>.before-restore-<time>`.

## A server is gone

1. In the fleet repo, `tofu apply` (it recreates the missing server; with a new IP, DNS
   follows). The known_hosts item in 1Password updates too.
2. If the IP changed, update `config/deploy.<environment>.yml` in each project on it.
3. In each project: Ops → `setup`, then `restore-database`.

## Backups stopped

Better Stack's host-check heartbeat says which Litestream container. Run `backups` for that
project and environment. If it keeps failing, check the bucket keys in its `-infra` item.

## New server

Add it under `hosts` in `fleet.yml` and `tofu apply`. It comes up with Docker, the `deploy`
user, a firewall (22, 80, 443), automatic security updates and host-check.

## New project

See the README. The first deploy of each environment is Ops → `setup`; after that, pushes and
releases deploy themselves.

## Go-live checklist

- [ ] Production domain in `fleet.yml`, DNS applied, HTTPS works
- [ ] Production secrets in 1Password; staging uses test keys (Stripe test mode)
- [ ] `restore-database` tried on staging
- [ ] Better Stack monitors green; Sentry receiving errors
- [ ] The app sends `noindex` on staging (`LAUTTA_ENV=staging`)
