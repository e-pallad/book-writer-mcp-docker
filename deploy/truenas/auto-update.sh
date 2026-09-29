#!/usr/bin/env bash
# Pull-based auto-update for the book-writer-mcp stack on TrueNAS.
#
# Run from a TrueNAS cron job (root, every 5 minutes, stdout hidden, stderr
# shown so failures are mailed). Each run:
#   1. pulls the service's image (ghcr.io/...:latest unless BOOK_MCP_TAG pins it)
#   2. exits quietly when the running container already uses that image
#   3. skips images that failed their health check before (.bad-image)
#   4. snapshots the ZFS dataset holding ./data
#   5. recreates the container and waits for it to become healthy
#   6. rolls back to the previous image and reports on stderr when it doesn't
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
SERVICE="${SERVICE:-book-writer-mcp}"
DATA_DIR="${DATA_DIR:-$STACK_DIR/data}"
LOG="${LOG:-/var/log/book-writer-mcp-update.log}"
BAD_LIST="${BAD_LIST:-$STACK_DIR/.bad-image}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
KEEP_SNAPSHOTS="${KEEP_SNAPSHOTS:-10}"
SNAP_PREFIX="pre-book-mcp-"
PREVIOUS_TAG="$SERVICE:previous"
IMAGE_SOURCE="${IMAGE_SOURCE:-https://github.com/e-pallad/book-writer-mcp-docker}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
fail() { log "ERROR $*"; printf '%s: %s\n' "$SERVICE auto-update" "$*" >&2; exit 1; }

[ -n "$STACK_DIR" ] || { echo "$0: no docker-compose.yml found; set STACK_DIR" >&2; exit 1; }

# Never let two runs overlap (a slow pull can outlast the cron interval)
exec 9> "$STACK_DIR/.auto-update.lock"
flock -n 9 || exit 0

cd "$STACK_DIR"
compose() { docker compose "$@"; }

image_ref="$(compose config --images "$SERVICE" | head -n1)"
[ -n "$image_ref" ] || fail "no image configured for service $SERVICE"

# Pull output is only logged when it fails; this runs every few minutes
if ! pull_out="$(compose pull --quiet "$SERVICE" 2>&1)"; then
  printf '%s\n' "$pull_out" >> "$LOG"
  fail "pull of $image_ref failed"
fi

new_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
container_id="$(compose ps -q "$SERVICE")"
running_id=""
[ -n "$container_id" ] && running_id="$(docker inspect --format '{{.Image}}' "$container_id")"

[ "$new_id" = "$running_id" ] && exit 0

if [ -f "$BAD_LIST" ] && grep -qxF "$new_id" "$BAD_LIST"; then
  # Already reported once; stay quiet until a newer image is published
  exit 0
fi

revision() { docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null | cut -c1-7; }
new_rev="$(revision "$new_id")"
log "update $SERVICE: ${running_id:0:19} -> ${new_id:0:19} (revision ${new_rev:-unknown})"

# Snapshot the book data before a new version gets to touch it
dataset="$(df --output=source "$DATA_DIR" 2>/dev/null | tail -n1)"
if [ -n "$dataset" ] && zfs list -H -o name "$dataset" > /dev/null 2>&1; then
  snap="$dataset@${SNAP_PREFIX}$(date '+%Y%m%d-%H%M%S')-${new_rev:-new}"
  zfs snapshot "$snap" || fail "zfs snapshot $snap failed; update not applied"
  log "snapshot $snap"
  zfs list -H -t snapshot -o name -s creation -d 1 "$dataset" \
    | { grep -F "@$SNAP_PREFIX" || true; } \
    | head -n "-$KEEP_SNAPSHOTS" \
    | while read -r old; do zfs destroy "$old" && log "pruned $old"; done
else
  log "WARN $DATA_DIR is not on a ZFS dataset; no snapshot taken"
fi

[ -n "$running_id" ] && docker tag "$running_id" "$PREVIOUS_TAG"

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) id status
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(compose ps -q "$SERVICE")"
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

compose up -d --no-build "$SERVICE" >> "$LOG" 2>&1 || true
if wait_healthy; then
  log "ok $SERVICE is healthy on revision ${new_rev:-unknown}"
  # Only this project's superseded images; other stacks' images are not ours to prune
  docker image prune -f --filter "label=org.opencontainers.image.source=$IMAGE_SOURCE" > /dev/null 2>&1 || true
  exit 0
fi

# Roll back: point the compose tag at the previous image and recreate
echo "$new_id" >> "$BAD_LIST"
compose logs --tail 50 "$SERVICE" >> "$LOG" 2>&1 || true
if [ -z "$running_id" ]; then
  fail "revision ${new_rev:-unknown} did not become healthy and there is no previous image to roll back to"
fi
docker tag "$PREVIOUS_TAG" "$image_ref"
compose up -d --no-build "$SERVICE" >> "$LOG" 2>&1 || true
if wait_healthy; then
  fail "revision ${new_rev:-unknown} did not become healthy; rolled back to $(revision "$running_id" || true). See $LOG"
fi
fail "revision ${new_rev:-unknown} did not become healthy and the rollback is unhealthy too. See $LOG"
