#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="codex-feishu-bridge.service"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="${CONFIG_HOME}/codex-feishu-bridge"
SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
UNIT_TEMPLATE="${ROOT_DIR}/deploy/systemd/${UNIT_NAME}.in"
UNIT_PATH="${SYSTEMD_DIR}/${UNIT_NAME}"
ENV_TEMPLATE="${ROOT_DIR}/deploy/config/bridge.env.example"
JSON_TEMPLATE="${ROOT_DIR}/deploy/config/config.json"
ENV_PATH="${CONFIG_DIR}/bridge.env"
JSON_PATH="${CONFIG_DIR}/config.json"
NODE_BIN="$(command -v node)"
USER_HOME="${HOME}"
PATH_VALUE="${PATH}"

if [[ ! -x "${NODE_BIN}" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

echo "This will clean, install packages, build, install/update the user service, kill old bridge processes, and restart the service."
echo "repo: ${ROOT_DIR}"
echo "unit: ${UNIT_PATH}"
echo "config: ${ENV_PATH}"
echo "config: ${JSON_PATH}"
echo "note: fresh installs default CODEX_SANDBOX_MODE to danger-full-access via ${JSON_PATH}"
read -r -p "Continue? [y/N] " CONFIRM
if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
  echo "aborted"
  exit 1
fi

cd "${ROOT_DIR}"

rm -rf dist
npm install
npm run build

mkdir -p "${CONFIG_DIR}" "${SYSTEMD_DIR}"

if [[ ! -f "${ENV_PATH}" ]]; then
  cp "${ENV_TEMPLATE}" "${ENV_PATH}"
  sed -i \
    -e "s|\$HOME|${USER_HOME}|g" \
    -e "s|/volumes/ws/codex-feishu-bridge|${ROOT_DIR}|g" \
    "${ENV_PATH}"
fi

if [[ ! -f "${JSON_PATH}" ]]; then
  cp "${JSON_TEMPLATE}" "${JSON_PATH}"
fi

sed \
  -e "s|@WORKDIR@|${ROOT_DIR}|g" \
  -e "s|@NODE_BIN@|${NODE_BIN}|g" \
  -e "s|@HOME@|${USER_HOME}|g" \
  -e "s|@PATH@|${PATH_VALUE}|g" \
  "${UNIT_TEMPLATE}" > "${UNIT_PATH}"

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}" >/dev/null

systemctl --user stop "${UNIT_NAME}" || true
for _ in $(seq 1 50); do
  if ! systemctl --user is-active --quiet "${UNIT_NAME}"; then
    break
  fi
  sleep 0.2
done
pkill -f "${ROOT_DIR}/dist/index.js" || true
systemctl --user daemon-reload
systemctl --user reset-failed "${UNIT_NAME}" || true
systemctl --user start "${UNIT_NAME}"

echo "verifying service..."
systemctl --user is-active "${UNIT_NAME}" >/dev/null
systemctl --user show "${UNIT_NAME}" -p MainPID -p ExecMainPID -p ActiveEnterTimestamp -p SubState
