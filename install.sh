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
USER_HOME="${HOME}"
PATH_VALUE="${PATH}"

echo "This will clean, install packages, build, install the package globally, install/update the user service, kill old bridge processes, and restart the service."
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
PACK_FILE="$(npm pack --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['filename'])")"
npm install -g "./${PACK_FILE}"
rm -f "${PACK_FILE}"

BIN_PATH="$(command -v codex-feishu-bridge || true)"
if [[ -z "${BIN_PATH}" ]]; then
  echo "codex-feishu-bridge not found on PATH after npm install -g ." >&2
  exit 1
fi

mkdir -p "${CONFIG_DIR}" "${SYSTEMD_DIR}"

if [[ ! -f "${ENV_PATH}" ]]; then
  cp "${ENV_TEMPLATE}" "${ENV_PATH}"
  python3 - "${ENV_PATH}" "${USER_HOME}" "${ROOT_DIR}" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
user_home = sys.argv[2]
root_dir = sys.argv[3]
text = env_path.read_text()
text = text.replace("$HOME", user_home)
text = text.replace("DEFAULT_PROJECT=" + user_home, "DEFAULT_PROJECT=" + root_dir)
text = text.replace("PROJECT_ALLOWED_ROOTS=" + user_home, "PROJECT_ALLOWED_ROOTS=" + root_dir)
env_path.write_text(text)
PY
fi

if [[ ! -f "${JSON_PATH}" ]]; then
  cp "${JSON_TEMPLATE}" "${JSON_PATH}"
fi

sed \
  -e "s|@BIN_PATH@|${BIN_PATH}|g" \
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
systemctl --user kill --signal=SIGKILL "${UNIT_NAME}" || true
systemctl --user daemon-reload
systemctl --user reset-failed "${UNIT_NAME}" || true
systemctl --user start "${UNIT_NAME}"

echo "verifying service..."
systemctl --user is-active "${UNIT_NAME}" >/dev/null
systemctl --user show "${UNIT_NAME}" -p MainPID -p ExecMainPID -p ActiveEnterTimestamp -p SubState
