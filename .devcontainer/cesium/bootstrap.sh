#!/usr/bin/env bash
# Cesium engine bootstrap for GitHub Codespaces.
# Managed by Cesium - do not edit by hand; rerun Codespace setup to refresh.
# cesium-template-version: 1
set -uo pipefail

CESIUM_ROOT="/workspaces/.cesium"
LOG_DIR="${CESIUM_ROOT}/logs"
INSTALL_MARKER="${CESIUM_ROOT}/.bootstrap-installed"
INSTALLER_URL="${CESIUM_INSTALLER_URL:-https://raw.githubusercontent.com/BenItBuhner/Cesium/main/scripts/install-cesium-server.sh}"
ENGINE_PORT=9100

mkdir -p "${CESIUM_ROOT}" "${LOG_DIR}"

log() { printf '[cesium-bootstrap] %s\n' "$*"; }

install_engine() {
  if [[ -x "${CESIUM_ROOT}/home/bin/cesium-server" && -f "${INSTALL_MARKER}" ]]; then
    log "Engine already installed."
    return 0
  fi
  if [[ -z "${CESIUM_AUTH_PASSWORD:-}" ]]; then
    log "WARNING: CESIUM_AUTH_PASSWORD codespace secret is missing; the engine"
    log "will generate its own password and Cesium clients cannot sign in"
    log "automatically. Re-run Codespace setup from Cesium to fix this."
  fi
  log "Installing the Cesium engine (log: ${LOG_DIR}/install.log)..."
  if env \
    CESIUM_HOME="${CESIUM_ROOT}/home" \
    CESIUM_STATE_DIR="${CESIUM_ROOT}/state" \
    CESIUM_WORKSPACE_ROOT="/workspaces" \
    CESIUM_PORT="${ENGINE_PORT}" \
    CESIUM_AUTH_USERNAME="${CESIUM_AUTH_USERNAME:-cesium}" \
    CESIUM_AUTH_PASSWORD="${CESIUM_AUTH_PASSWORD:-}" \
    CESIUM_SKIP_TUNNEL=1 \
    CESIUM_RENDEZVOUS_REQUIRED=0 \
    CESIUM_SERVICE_MANAGER=detached \
    CESIUM_SKIP_AUTOSTART=1 \
    CESIUM_SERVER_LABEL="Codespace ${GITHUB_REPOSITORY:-}" \
    bash -c "curl -fsSL '${INSTALLER_URL}' | bash" >>"${LOG_DIR}/install.log" 2>&1; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"${INSTALL_MARKER}"
    log "Engine installed."
    return 0
  fi
  log "Engine install FAILED; see ${LOG_DIR}/install.log"
  return 1
}

# Codespaces secrets only apply to new sessions; refresh the stored engine
# credentials on every start so a rotated secret takes effect after restart.
sync_auth() {
  local env_file="${CESIUM_ROOT}/home/server.env"
  [[ -f "${env_file}" && -n "${CESIUM_AUTH_PASSWORD:-}" ]] || return 0
  local tmp="${env_file}.tmp.$$"
  grep -v -e '^OPENCURSOR_AUTH_USERNAME=' -e '^OPENCURSOR_AUTH_PASSWORD=' \
    "${env_file}" >"${tmp}" || true
  printf 'OPENCURSOR_AUTH_USERNAME=%q\n' "${CESIUM_AUTH_USERNAME:-cesium}" >>"${tmp}"
  printf 'OPENCURSOR_AUTH_PASSWORD=%q\n' "${CESIUM_AUTH_PASSWORD}" >>"${tmp}"
  mv "${tmp}" "${env_file}"
  chmod 600 "${env_file}"
}

start_engine() {
  sync_auth
  log "Starting the Cesium engine (log: ${LOG_DIR}/engine.log)..."
  if "${CESIUM_ROOT}/home/bin/cesium-server" run >>"${LOG_DIR}/engine.log" 2>&1; then
    log "Engine is healthy on port ${ENGINE_PORT}."
    return 0
  fi
  log "Engine FAILED to start; see ${LOG_DIR}/engine.log"
  return 1
}

# Browser clients cannot attach auth headers to WebSockets, so the forwarded
# port must be public; the engine's own password auth is the access gate.
publish_port() {
  if [[ -z "${CODESPACE_NAME:-}" ]] || ! command -v gh >/dev/null 2>&1; then
    log "Not in a codespace (or gh is missing); skipping port visibility."
    return 0
  fi
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if gh codespace ports visibility "${ENGINE_PORT}:public" \
      -c "${CODESPACE_NAME}" >>"${LOG_DIR}/ports.log" 2>&1; then
      log "Port ${ENGINE_PORT} is public: https://${CODESPACE_NAME}-${ENGINE_PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
      return 0
    fi
    sleep $((attempt * 5))
  done
  log "Could not publish port ${ENGINE_PORT}. Run manually:"
  log "  gh codespace ports visibility ${ENGINE_PORT}:public -c ${CODESPACE_NAME}"
  return 1
}

case "${1:-start}" in
  install)
    install_engine
    ;;
  start)
    if install_engine && start_engine; then
      publish_port
    else
      exit 1
    fi
    ;;
  *)
    printf 'Usage: bootstrap.sh {install|start}\n' >&2
    exit 2
    ;;
esac
