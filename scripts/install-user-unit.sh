#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="${CONFIG_HOME}/codex-feishu-bridge"
SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
UNIT_NAME="codex-feishu-bridge.service"
UNIT_TEMPLATE="${REPO_ROOT}/deploy/systemd/${UNIT_NAME}.in"
UNIT_PATH="${SYSTEMD_DIR}/${UNIT_NAME}"
ENV_TEMPLATE="${REPO_ROOT}/deploy/config/bridge.env.example"
JSON_TEMPLATE="${REPO_ROOT}/deploy/config/config.json"
ENV_PATH="${CONFIG_DIR}/bridge.env"
JSON_PATH="${CONFIG_DIR}/config.json"

NODE_BIN="$(command -v node)"
USER_HOME="${HOME}"
PATH_VALUE="${PATH}"

if [[ ! -x "${NODE_BIN}" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

AUTO_YES=0
if [[ $# -gt 1 ]]; then
  echo "usage: $0 [--yes]" >&2
  exit 1
fi
if [[ $# -eq 1 ]]; then
  if [[ "${1}" != "--yes" ]]; then
    echo "usage: $0 [--yes]" >&2
    exit 1
  fi
  AUTO_YES=1
fi

echo "This will install or update the user service, reload systemd, enable it, and hard-restart it."
echo "repo: ${REPO_ROOT}"
echo "unit: ${UNIT_PATH}"
echo "config: ${ENV_PATH}"
echo "config: ${JSON_PATH}"
if [[ "${AUTO_YES}" -eq 0 ]]; then
  read -r -p "Continue? [y/N] " CONFIRM
  if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
    echo "aborted"
    exit 1
  fi
fi

mkdir -p "${CONFIG_DIR}" "${SYSTEMD_DIR}"

if [[ ! -f "${ENV_PATH}" ]]; then
  cp "${ENV_TEMPLATE}" "${ENV_PATH}"
  sed -i \
    -e "s|\$HOME|${USER_HOME}|g" \
    -e "s|/volumes/ws/codex-feishu-bridge|${REPO_ROOT}|g" \
    "${ENV_PATH}"
fi

if [[ ! -f "${JSON_PATH}" ]]; then
  cp "${JSON_TEMPLATE}" "${JSON_PATH}"
fi

sed \
  -e "s|@WORKDIR@|${REPO_ROOT}|g" \
  -e "s|@NODE_BIN@|${NODE_BIN}|g" \
  -e "s|@HOME@|${USER_HOME}|g" \
  -e "s|@PATH@|${PATH_VALUE}|g" \
  "${UNIT_TEMPLATE}" > "${UNIT_PATH}"

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}" >/dev/null

hard_restart() {
  systemctl --user stop "${UNIT_NAME}" || true
  for _ in $(seq 1 50); do
    if ! systemctl --user is-active --quiet "${UNIT_NAME}"; then
      break
    fi
    sleep 0.2
  done
  pkill -f "${REPO_ROOT}/dist/index.js" || true
  systemctl --user daemon-reload
  systemctl --user reset-failed "${UNIT_NAME}" || true
  systemctl --user start "${UNIT_NAME}"
}

hard_restart

systemctl --user is-active "${UNIT_NAME}" >/dev/null

echo "installed: ${UNIT_PATH}"
echo "config: ${ENV_PATH}"
echo "config: ${JSON_PATH}"
systemctl --user show "${UNIT_NAME}" -p ExecMainPID -p ActiveEnterTimestamp
