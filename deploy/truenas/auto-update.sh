#!/usr/bin/env bash
# Pull-based auto-update for the book-writer-mcp stack on TrueNAS.
#
# Run from a TrueNAS cron job (root, every 5 minutes, stdout hidden, stderr
# shown so failures are mailed). For each service in SERVICES, a run:
#   1. pulls the service's image, unless it was checked less than its
#      CHECK_INTERVALS entry ago (Docker Hub rate-limits anonymous pulls)
#   2. moves on quietly when the running container already uses that image
#   3. skips images that failed their health check before (.bad-image)
#   4. snapshots the ZFS dataset holding ./data, for SNAPSHOT_SERVICES only
#   5. recreates the container and waits for it to become healthy
#   6. rolls back to the previous image and reports on stderr when it doesn't
# One service failing doesn't stop the others from being checked.
#
# Every setting can be overridden from the environment.
set -euo pipefail

# Default: the nearest directory at or above this script holding docker-compose.yml,
# so the script works both copied next to the compose file and from a git clone.
find_stack_dir() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$dir" != "/" ]; do
    [ -f "$dir/docker-compose.yml" ] && { echo "$dir"; return; }
    dir="$(dirname "$dir")"
  done
}
STACK_DIR="${STACK_DIR:-$(find_stack_dir)}"
SERVICES="${SERVICES:-book-writer-mcp book-preview cloudflared}"
SNAPSHOT_SERVICES="${SNAPSHOT_SERVICES:-book-writer-mcp}"
# service=seconds; unlisted services are checked on every run
CHECK_INTERVALS="${CHECK_INTERVALS:-cloudflared=21600}"
DATA_DIR="${DATA_DIR:-$STACK_DIR/data}"
LOG="${LOG:-/var/log/book-writer-mcp-update.log}"
BAD_LIST="${BAD_LIST:-$STACK_DIR/.bad-image}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
KEEP_SNAPSHOTS="${KEEP_SNAPSHOTS:-10}"
SNAP_PREFIX="pre-book-mcp-"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
# Logs and reports on stderr (mailed by cron); the caller returns non-zero
report() { log "ERROR $1: $2"; printf '%s auto-update: %s\n' "$1" "$2" >&2; }

[ -n "$STACK_DIR" ] || { echo "$0: no docker-compose.yml found; set STACK_DIR" >&2; exit 1; }

# Never let two runs overlap (a slow pull can outlast the cron interval)
exec 9> "$STACK_DIR/.auto-update.lock"
flock -n 9 || exit 0

cd "$STACK_DIR"
compose() { docker compose "$@"; }

check_interval() {
  local entry
  for entry in $CHECK_INTERVALS; do
    [ "${entry%%=*}" = "$1" ] && { echo "${entry#*=}"; return; }
  done
  echo 0
}

# Short version for the log: the commit for our image, the release for others
version() {
  local v
  v="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null | cut -c1-7)"
  [ -n "$v" ] || v="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null)"
  echo "${v:-${1:7:12}}"
}

wait_healthy() {
  local service="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) id status
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(compose ps -q "$service")"
    if [ -n "$id" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
      case "$status" in
        healthy) return 0 ;;
        unhealthy|exited|dead) return 1 ;;
      esac
    fi
    sleep 5
  done
  return 1
}

snapshot_data() {
  local service="$1" rev="$2" dataset snap
  dataset="$(df --output=source "$DATA_DIR" 2>/dev/null | tail -n1)"
  if [ -z "$dataset" ] || ! zfs list -H -o name "$dataset" > /dev/null 2>&1; then
    log "WARN $DATA_DIR is not on a ZFS dataset; no snapshot taken"
    return 0
  fi
  snap="$dataset@${SNAP_PREFIX}$(date '+%Y%m%d-%H%M%S')-$rev"
  zfs snapshot "$snap" || { report "$service" "zfs snapshot $snap failed; update not applied"; return 1; }
  log "snapshot $snap"
  zfs list -H -t snapshot -o name -s creation -d 1 "$dataset" \
    | { grep -F "@$SNAP_PREFIX" || true; } \
    | head -n "-$KEEP_SNAPSHOTS" \
    | while read -r old; do zfs destroy "$old" && log "pruned $old"; done
}

# Called in an `||` context, where bash ignores `set -e`, so every step
# that matters checks its own result.
update_service() {
  local service="$1" image_ref pull_out new_id container_id running_id="" old_previous=""
  local previous_tag="$service:previous" stamp="$STACK_DIR/.last-check-$service" interval new_ver

  interval="$(check_interval "$service")"
  if [ "$interval" -gt 0 ] && [ -f "$stamp" ] \
     && [ $(( $(date +%s) - $(cat "$stamp") )) -lt "$interval" ]; then
    return 0
  fi

  # A compose file that predates the service (not copied over yet) must not
  # abort the run or the services after it
  if ! compose config --services | grep -qxF "$service"; then
    report "$service" "not in docker-compose.yml; copy the current compose file to $STACK_DIR"
    return 1
  fi

  # Not `config --images`: for a service with depends_on it also lists the
  # dependencies' images, in no fixed order
  image_ref="$(compose config --format json \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["services"][sys.argv[1]].get("image", ""))' "$service")"
  [ -n "$image_ref" ] || { report "$service" "no image configured"; return 1; }

  # Pull output is only logged when it fails; this runs every few minutes
  if ! pull_out="$(compose pull --quiet "$service" 2>&1)"; then
    printf '%s\n' "$pull_out" >> "$LOG"
    report "$service" "pull of $image_ref failed"
    return 1
  fi
  date +%s > "$stamp"

  new_id="$(docker image inspect --format '{{.Id}}' "$image_ref")" \
    || { report "$service" "cannot inspect $image_ref"; return 1; }
  container_id="$(compose ps -q "$service")"
  [ -n "$container_id" ] && running_id="$(docker inspect --format '{{.Image}}' "$container_id")"

  [ "$new_id" = "$running_id" ] && return 0
  # Already reported once; stay quiet until a newer image is published
  [ -f "$BAD_LIST" ] && grep -qxF "$new_id" "$BAD_LIST" && return 0

  new_ver="$(version "$new_id")"
  log "update $service: ${running_id:0:19} -> ${new_id:0:19} ($new_ver)"

  case " $SNAPSHOT_SERVICES " in
    *" $service "*) snapshot_data "$service" "$new_ver" || return 1 ;;
  esac

  if [ -n "$running_id" ]; then
    old_previous="$(docker image inspect --format '{{.Id}}' "$previous_tag" 2>/dev/null || true)"
    docker tag "$running_id" "$previous_tag"
  fi

  compose up -d --no-build --no-deps "$service" >> "$LOG" 2>&1 || true
  if wait_healthy "$service"; then
    log "ok $service is healthy on $new_ver"
    # The image that was :previous until now is superseded; it is ours to remove
    if [ -n "$old_previous" ] && [ "$old_previous" != "$running_id" ] && [ "$old_previous" != "$new_id" ]; then
      docker rmi "$old_previous" > /dev/null 2>&1 || true
    fi
    return 0
  fi

  # Roll back: point the compose tag at the previous image and recreate
  echo "$new_id" >> "$BAD_LIST"
  compose logs --tail 50 "$service" >> "$LOG" 2>&1 || true
  if [ -z "$running_id" ]; then
    report "$service" "$new_ver did not become healthy and there is no previous image to roll back to"
    return 1
  fi
  docker tag "$previous_tag" "$image_ref"
  compose up -d --no-build --no-deps "$service" >> "$LOG" 2>&1 || true
  if wait_healthy "$service"; then
    report "$service" "$new_ver did not become healthy; rolled back to $(version "$running_id"). See $LOG"
  else
    report "$service" "$new_ver did not become healthy and the rollback is unhealthy too. See $LOG"
  fi
  return 1
}

status=0
for service in $SERVICES; do
  update_service "$service" || status=1
done
exit "$status"
