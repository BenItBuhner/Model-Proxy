#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.bluegreen.yml"
ACTIVE_FILE="$ROOT_DIR/deploy/caddy/upstreams/active.caddy"
STATE_FILE="$ROOT_DIR/deploy/bluegreen-state.env"
COMPOSE_PROJECT="${MODEL_PROXY_COMPOSE_PROJECT:-model-proxy-bluegreen}"

DEFAULT_READY_TIMEOUT_SECONDS=120
DEFAULT_STOP_TIMEOUT_SECONDS=300

compose() {
  docker compose -p "$COMPOSE_PROJECT" --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" "$@"
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-model-proxy.sh <command>

Commands:
  status      Show active color, frontdoor health, and compose service status.
  bootstrap   Start the current active color and Caddy frontdoor.
  deploy      Build a new image, start the inactive color, switch Caddy, drain old.
  rollback    Switch back to the previous color/image recorded during deploy.

Environment:
  MODEL_PROXY_IMAGE_TAG         Override the image tag built during deploy.
  MODEL_PROXY_READY_TIMEOUT     Seconds to wait for readiness (default: 120).
  MODEL_PROXY_STOP_TIMEOUT      Seconds to let the old color drain (default: 300).
EOF
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required tool: $1" >&2
    exit 1
  fi
}

require_tools() {
  require_tool docker
  require_tool curl
}

read_active_color() {
  if grep -q "proxy-green:9876" "$ACTIVE_FILE"; then
    printf "green"
    return
  fi
  if grep -q "proxy-blue:9876" "$ACTIVE_FILE"; then
    printf "blue"
    return
  fi
  echo "unable to detect active color from $ACTIVE_FILE" >&2
  exit 1
}

other_color() {
  case "$1" in
    blue) printf "green" ;;
    green) printf "blue" ;;
    *) echo "invalid color: $1" >&2; exit 1 ;;
  esac
}

backend_port() {
  case "$1" in
    blue) printf "9877" ;;
    green) printf "9878" ;;
    *) echo "invalid color: $1" >&2; exit 1 ;;
  esac
}

backend_url() {
  printf "http://127.0.0.1:%s" "$(backend_port "$1")"
}

write_active_upstream() {
  local color="$1"
  local tmp="$ACTIVE_FILE.tmp"
  cat >"$tmp" <<EOF
# This file is rewritten by scripts/deploy-model-proxy.sh during blue/green
# cutovers. It must name exactly one active backend so storage stays effectively
# single-writer during normal operation.
reverse_proxy proxy-$color:9876 {
	health_uri /health
	health_interval 5s
	health_timeout 8s
	flush_interval -1
}
EOF
  mv "$tmp" "$ACTIVE_FILE"
}

reload_frontdoor() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if compose exec -T frontdoor caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
      return
    fi
    sleep 1
  done
  echo "failed to reload Caddy frontdoor" >&2
  exit 1
}

wait_ready() {
  local color="$1"
  local timeout="${2:-$DEFAULT_READY_TIMEOUT_SECONDS}"
  local url
  url="$(backend_url "$color")/health/ready"
  local deadline=$((SECONDS + timeout))

  echo "waiting for proxy-$color readiness at $url"
  until curl -fsS "$url" >/dev/null; do
    if (( SECONDS >= deadline )); then
      echo "proxy-$color did not become ready within ${timeout}s" >&2
      curl -sS "$url" || true
      echo >&2
      exit 1
    fi
    sleep 1
  done
}

wait_frontdoor_color() {
  local color="$1"
  local deadline=$((SECONDS + 30))
  until curl -fsS http://127.0.0.1:9876/health/detailed | grep -q "\"instance_color\":\"$color\""; do
    if (( SECONDS >= deadline )); then
      echo "frontdoor did not report active color '$color' within 30s" >&2
      curl -sS http://127.0.0.1:9876/health/detailed || true
      echo >&2
      exit 1
    fi
    sleep 1
  done
}

# Poll the backend's /health until its tracked in-flight requests (including
# active SSE streams) reach zero, so `compose stop` never cuts a live stream.
wait_drained() {
  local color="$1"
  local timeout="${2:-$DEFAULT_STOP_TIMEOUT_SECONDS}"
  local url
  url="$(backend_url "$color")/health"
  local deadline=$((SECONDS + timeout))
  local active

  echo "waiting for proxy-$color in-flight requests to finish (up to ${timeout}s)"
  while (( SECONDS < deadline )); do
    active="$(curl -fsS "$url" 2>/dev/null | sed -n 's/.*"active_requests":\([0-9]\+\).*/\1/p' || true)"
    if [[ -z "$active" ]]; then
      # Backend unreachable or old build without active_requests — fall back to timed stop.
      echo "proxy-$color did not report active_requests; falling back to container stop grace"
      return
    fi
    if [[ "$active" == "0" ]]; then
      echo "proxy-$color has no in-flight requests; safe to stop"
      return
    fi
    echo "proxy-$color still has $active in-flight request(s); waiting..."
    sleep 2
  done
  echo "proxy-$color still busy after ${timeout}s; proceeding with container stop grace" >&2
}

env_client_key() {
  if [[ -n "${CLIENT_API_KEY:-}" ]]; then
    printf "%s" "$CLIENT_API_KEY"
    return
  fi
  if [[ -f "$ROOT_DIR/.env" ]]; then
    local value
    value="$(sed -n 's/^CLIENT_API_KEY=//p' "$ROOT_DIR/.env" | tail -n 1 | tr -d '\r')"
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    printf "%s" "$value"
  fi
}

smoke_models() {
  local color="$1"
  local key
  key="$(env_client_key)"
  if [[ -z "$key" ]]; then
    echo "CLIENT_API_KEY not found; skipping /v1/models smoke test"
    return
  fi
  curl -fsS -H "Authorization: Bearer $key" "$(backend_url "$color")/v1/models" >/dev/null
}

container_image() {
  docker inspect --format '{{.Config.Image}}' "model-proxy-$1" 2>/dev/null || true
}

container_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "model-proxy-$1" 2>/dev/null || true)" == "true" ]]
}

frontdoor_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' model-proxy-frontdoor 2>/dev/null || true)" == "true" ]]
}

legacy_container_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' model-proxy 2>/dev/null || true)" == "true" ]]
}

write_state() {
  local active="$1"
  local active_image="$2"
  local previous="$3"
  local previous_image="$4"
  cat >"$STATE_FILE" <<EOF
ACTIVE_COLOR=$active
ACTIVE_IMAGE=$active_image
PREVIOUS_COLOR=$previous
PREVIOUS_IMAGE=$previous_image
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

state_value() {
  local key="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    return
  fi
  sed -n "s/^$key=//p" "$STATE_FILE" | tail -n 1
}

build_id() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  if git -C "$ROOT_DIR" rev-parse --short HEAD >/dev/null 2>&1; then
    printf "%s-%s" "$(git -C "$ROOT_DIR" rev-parse --short HEAD)" "$stamp"
  else
    printf "%s" "$stamp"
  fi
}

cmd_status() {
  local active
  active="$(read_active_color)"
  echo "active color: $active"
  echo "active backend: proxy-$active on $(backend_url "$active")"
  echo
  if [[ -f "$STATE_FILE" ]]; then
    echo "state:"
    sed 's/^/  /' "$STATE_FILE"
    echo
  fi
  if frontdoor_running; then
    echo "frontdoor health:"
  else
    echo "frontdoor health (Caddy is not running yet; this may be the legacy single-container service):"
  fi
  curl -fsS http://127.0.0.1:9876/health/detailed || true
  echo
  echo
  compose ps
}

cmd_bootstrap() {
  local active="${MODEL_PROXY_ACTIVE_COLOR:-$(read_active_color)}"
  local image="${MODEL_PROXY_IMAGE:-model-proxy:v2}"
  local id="${MODEL_PROXY_BUILD_ID:-bootstrap}"

  echo "bootstrapping proxy-$active with image $image"
  write_active_upstream "$active"
  MODEL_PROXY_IMAGE="$image" MODEL_PROXY_BUILD_ID="$id" compose up -d --no-deps "proxy-$active"
  wait_ready "$active" "${MODEL_PROXY_READY_TIMEOUT:-$DEFAULT_READY_TIMEOUT_SECONDS}"
  if ! frontdoor_running && legacy_container_running; then
    cat >&2 <<EOF
proxy-$active is ready, but legacy container 'model-proxy' still owns host port 9876.
Stop the legacy container during the one-time migration window, then rerun:

  docker stop model-proxy
  scripts/deploy-model-proxy.sh bootstrap

After that first cutover, future 'deploy' runs switch blue/green without the port gap.
EOF
    exit 1
  fi
  compose up -d frontdoor
  reload_frontdoor
  wait_frontdoor_color "$active"
  write_state "$active" "$image" "$(other_color "$active")" ""
  echo "bootstrap complete: frontdoor is serving proxy-$active"
}

cmd_deploy() {
  local active inactive old_image id new_image ready_timeout stop_timeout
  active="$(read_active_color)"
  inactive="$(other_color "$active")"
  old_image="$(container_image "$active")"
  id="$(build_id)"
  new_image="${MODEL_PROXY_IMAGE_TAG:-model-proxy:$id}"
  ready_timeout="${MODEL_PROXY_READY_TIMEOUT:-$DEFAULT_READY_TIMEOUT_SECONDS}"
  stop_timeout="${MODEL_PROXY_STOP_TIMEOUT:-$DEFAULT_STOP_TIMEOUT_SECONDS}"

  echo "active color: $active"
  echo "deploying new image $new_image to proxy-$inactive"
  docker build -t "$new_image" "$ROOT_DIR"

  MODEL_PROXY_IMAGE="$new_image" MODEL_PROXY_BUILD_ID="$id" \
    compose up -d --no-deps --force-recreate "proxy-$inactive"
  wait_ready "$inactive" "$ready_timeout"
  smoke_models "$inactive"

  echo "switching frontdoor to proxy-$inactive"
  write_active_upstream "$inactive"
  compose up -d frontdoor
  reload_frontdoor
  wait_frontdoor_color "$inactive"

  write_state "$inactive" "$new_image" "$active" "$old_image"

  if container_running "$active"; then
    wait_drained "$active" "$stop_timeout"
    echo "stopping old proxy-$active (grace ${stop_timeout}s)"
    compose stop -t "$stop_timeout" "proxy-$active"
  else
    echo "old proxy-$active is not running; nothing to drain"
  fi

  echo "deploy complete: frontdoor is serving proxy-$inactive ($new_image)"
}

cmd_rollback() {
  local active target image ready_timeout stop_timeout
  active="$(read_active_color)"
  target="$(state_value PREVIOUS_COLOR)"
  image="$(state_value PREVIOUS_IMAGE)"
  ready_timeout="${MODEL_PROXY_READY_TIMEOUT:-$DEFAULT_READY_TIMEOUT_SECONDS}"
  stop_timeout="${MODEL_PROXY_STOP_TIMEOUT:-$DEFAULT_STOP_TIMEOUT_SECONDS}"

  if [[ -z "$target" ]]; then
    target="$(other_color "$active")"
  fi
  if [[ -z "$image" ]]; then
    image="$(container_image "$target")"
  fi
  if [[ -z "$image" ]]; then
    echo "no previous image recorded for proxy-$target; cannot rollback safely" >&2
    exit 1
  fi

  echo "rolling back from proxy-$active to proxy-$target using $image"
  MODEL_PROXY_IMAGE="$image" MODEL_PROXY_BUILD_ID="rollback-$(build_id)" \
    compose up -d --no-deps "proxy-$target"
  wait_ready "$target" "$ready_timeout"

  write_active_upstream "$target"
  compose up -d frontdoor
  reload_frontdoor
  wait_frontdoor_color "$target"

  write_state "$target" "$image" "$active" "$(container_image "$active")"

  if container_running "$active"; then
    wait_drained "$active" "$stop_timeout"
    echo "stopping former active proxy-$active (grace ${stop_timeout}s)"
    compose stop -t "$stop_timeout" "proxy-$active"
  fi

  echo "rollback complete: frontdoor is serving proxy-$target"
}

main() {
  require_tools
  case "${1:-}" in
    status) cmd_status ;;
    bootstrap) cmd_bootstrap ;;
    deploy) cmd_deploy ;;
    rollback) cmd_rollback ;;
    -h|--help|help|"") usage ;;
    *) echo "unknown command: $1" >&2; usage; exit 1 ;;
  esac
}

main "$@"
