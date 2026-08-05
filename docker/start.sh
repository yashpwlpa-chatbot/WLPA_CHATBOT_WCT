#!/usr/bin/env bash
set -Eeuo pipefail

TRANSCRIPTION_HOST="${TRANSCRIPTION_HOST:-127.0.0.1}"
TRANSCRIPTION_PORT="${TRANSCRIPTION_PORT:-5000}"
TRANSCRIPTION_SERVICE_URL="${TRANSCRIPTION_SERVICE_URL:-http://${TRANSCRIPTION_HOST}:${TRANSCRIPTION_PORT}}"
TRANSCRIPTION_STARTUP_TIMEOUT_SECONDS="${TRANSCRIPTION_STARTUP_TIMEOUT_SECONDS:-300}"
TRANSCRIPTION_STARTUP_INTERVAL_SECONDS="${TRANSCRIPTION_STARTUP_INTERVAL_SECONDS:-2}"

export TRANSCRIPTION_HOST
export TRANSCRIPTION_PORT
export TRANSCRIPTION_SERVICE_URL

log() {
  printf '[container] %s\n' "$*"
}

PYTHON_BIN="${PYTHON_BIN:-${VIRTUAL_ENV:-/opt/venv}/bin/python}"
PIP_BIN="${PIP_BIN:-${VIRTUAL_ENV:-/opt/venv}/bin/pip}"

if [[ ! -x "${PYTHON_BIN}" || ! -x "${PIP_BIN}" ]]; then
  log "Configured Python virtual environment is unavailable"
  log "python=${PYTHON_BIN}"
  log "pip=${PIP_BIN}"
  exit 1
fi

log "Python executable: ${PYTHON_BIN}"
log "pip executable: ${PIP_BIN}"
"${PYTHON_BIN}" - <<'PY'
import site
import sys

print(f"[container] Python version: {sys.version.split()[0]}")
print(f"[container] sys.executable: {sys.executable}")
print(f"[container] sys.path: {sys.path}")
print(f"[container] site-packages: {site.getsitepackages()}")
PY
"${PIP_BIN}" show requests
"${PIP_BIN}" freeze
"${PYTHON_BIN}" -c "import requests; from faster_whisper import WhisperModel; print('[container] Python imports verified: requests=' + requests.__version__)"

transcription_pid=""
node_pid=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "${node_pid}" ]] && kill -0 "${node_pid}" 2>/dev/null; then
    log "Stopping Node.js process (${node_pid})"
    kill -TERM "${node_pid}" 2>/dev/null || true
  fi

  if [[ -n "${transcription_pid}" ]] && kill -0 "${transcription_pid}" 2>/dev/null; then
    log "Stopping transcription process (${transcription_pid})"
    kill -TERM "${transcription_pid}" 2>/dev/null || true
  fi

  if [[ -n "${node_pid}" ]]; then
    wait "${node_pid}" 2>/dev/null || true
  fi
  if [[ -n "${transcription_pid}" ]]; then
    wait "${transcription_pid}" 2>/dev/null || true
  fi

  exit "${status}"
}

trap cleanup EXIT
trap 'exit 143' INT TERM

log "Starting faster-whisper on ${TRANSCRIPTION_HOST}:${TRANSCRIPTION_PORT}"
"${PYTHON_BIN}" -u transcription_service/app.py &
transcription_pid=$!

ready=0
elapsed=0
health_url="http://${TRANSCRIPTION_HOST}:${TRANSCRIPTION_PORT}/health"

while (( elapsed < TRANSCRIPTION_STARTUP_TIMEOUT_SECONDS )); do
  if ! kill -0 "${transcription_pid}" 2>/dev/null; then
    log "Transcription service exited before becoming ready"
    exit 1
  fi

  if curl --fail --silent --show-error --max-time 3 "${health_url}" >/dev/null 2>&1; then
    ready=1
    break
  fi

  sleep "${TRANSCRIPTION_STARTUP_INTERVAL_SECONDS}"
  elapsed=$((elapsed + TRANSCRIPTION_STARTUP_INTERVAL_SECONDS))
done

if (( ready == 0 )); then
  log "Transcription service did not become ready within ${TRANSCRIPTION_STARTUP_TIMEOUT_SECONDS}s"
  exit 1
fi

log "Transcription service is ready"
log "Starting Node.js application"
npm start &
node_pid=$!

if wait -n "${node_pid}" "${transcription_pid}"; then
  child_status=0
else
  child_status=$?
fi

if kill -0 "${node_pid}" 2>/dev/null; then
  log "Transcription service exited with status ${child_status}"
  exit 1
fi

log "Node.js application exited with status ${child_status}"
exit "${child_status}"
