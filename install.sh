#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="codex-feishu-bridge.service"

echo "This will clean, install packages, build, install/update the user service, kill old bridge processes, and restart the service."
echo "repo: ${ROOT_DIR}"
read -r -p "Continue? [y/N] " CONFIRM
if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
  echo "aborted"
  exit 1
fi

cd "${ROOT_DIR}"

rm -rf dist
npm install
npm run build

systemctl --user stop "${UNIT_NAME}" || true
pkill -f "${ROOT_DIR}/dist/index.js" || true

"${ROOT_DIR}/scripts/install-user-unit.sh" --yes

echo "verifying service..."
systemctl --user is-active "${UNIT_NAME}" >/dev/null
systemctl --user show "${UNIT_NAME}" -p MainPID -p ExecMainPID -p ActiveEnterTimestamp -p SubState
