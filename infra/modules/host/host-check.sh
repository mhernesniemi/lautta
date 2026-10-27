#!/usr/bin/env bash
# Runs every 5 minutes from a systemd timer. Pings the server's Better Stack heartbeat when all
# is well, or its /fail URL with the reasons when not. Silence (a dead server) alerts too.
set -euo pipefail
# shellcheck source=/dev/null
. /etc/lautta/host-check.env
: "${HEARTBEAT_URL:?}" "${DISK_LIMIT:=85}" "${MEMORY_MIN:=10}"

problems=()

disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$disk" -lt "$DISK_LIMIT" ] || problems+=("disk ${disk}% full")

memory=$(awk '/MemTotal/ { t = $2 } /MemAvailable/ { a = $2 } END { printf "%d", a * 100 / t }' /proc/meminfo)
[ "$memory" -ge "$MEMORY_MIN" ] || problems+=("only ${memory}% memory available")

unhealthy=$(docker ps --filter health=unhealthy --format '{{.Names}}' | paste -sd, -)
[ -z "$unhealthy" ] || problems+=("unhealthy: $unhealthy")

restarting=$(docker ps --filter status=restarting --format '{{.Names}}' | paste -sd, -)
[ -z "$restarting" ] || problems+=("restarting: $restarting")

# Every Litestream accessory must be running and replicating without errors.
for name in $(docker ps -a --filter name=litestream --format '{{.Names}}'); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
    problems+=("$name stopped")
  elif docker logs --since 10m "$name" 2>&1 | grep -q 'level=ERROR'; then
    problems+=("$name logged errors")
  fi
done

if [ ${#problems[@]} -eq 0 ]; then
  curl -fsS -m 10 -o /dev/null "$HEARTBEAT_URL"
else
  message="$(hostname): $(IFS=';'; echo "${problems[*]}")"
  echo "$message" >&2
  curl -fsS -m 10 -o /dev/null --data-raw "$message" "$HEARTBEAT_URL/fail"
fi
