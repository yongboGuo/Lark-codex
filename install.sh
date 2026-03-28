#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="lark-codex.service"
PLIST_NAME="com.lark-codex.bridge.plist"
PLIST_LABEL="com.lark-codex.bridge"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="${CONFIG_HOME}/lark-codex"
SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
UNIT_TEMPLATE="${ROOT_DIR}/deploy/systemd/${UNIT_NAME}.in"
UNIT_PATH="${SYSTEMD_DIR}/${UNIT_NAME}"
LAUNCHD_DIR="${HOME}/Library/LaunchAgents"
PLIST_TEMPLATE="${ROOT_DIR}/deploy/launchd/${PLIST_NAME}.in"
PLIST_PATH="${LAUNCHD_DIR}/${PLIST_NAME}"
ENV_TEMPLATE="${ROOT_DIR}/deploy/config/bridge.env.example"
JSON_TEMPLATE="${ROOT_DIR}/deploy/config/config.json"
ENV_PATH="${CONFIG_DIR}/bridge.env"
JSON_PATH="${CONFIG_DIR}/config.json"
RUNNER_PATH="${CONFIG_DIR}/run-lark-codex.sh"
LOG_DIR="${CONFIG_DIR}/logs"
STDOUT_PATH="${LOG_DIR}/stdout.log"
STDERR_PATH="${LOG_DIR}/stderr.log"
USER_HOME="${HOME}"
PATH_VALUE="${PATH}"
SERVICE_MANAGER="systemd"
SERVICE_PATH="${UNIT_PATH}"
PREPARE_ONLY=0
AUTO_CONFIRM=0

for arg in "$@"; do
  case "${arg}" in
    --prepare-only)
      PREPARE_ONLY=1
      ;;
    --yes|-y)
      AUTO_CONFIRM=1
      ;;
    *)
      echo "unsupported option: ${arg}" >&2
      echo "usage: ./install.sh [--prepare-only] [--yes]" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" == "Darwin" ]]; then
  SERVICE_MANAGER="launchd"
  SERVICE_PATH="${PLIST_PATH}"
fi

echo "This will clean, install packages, build, install the package globally, install/update the user service, kill old bridge processes, and restart the service."
echo "service manager: ${SERVICE_MANAGER}"
echo "repo: ${ROOT_DIR}"
echo "service: ${SERVICE_PATH}"
echo "config: ${ENV_PATH}"
echo "config: ${JSON_PATH}"
echo "note: config.json is the primary bridge config; bridge.env is only for secrets and process env."
if [[ "${PREPARE_ONLY}" -eq 1 ]]; then
  echo "note: --prepare-only was requested, so the service will not be started."
fi
if [[ -f "${JSON_PATH}" ]]; then
  echo "note: existing config.json will be preserved; checked-in defaults like backendMode/app-server are only applied on first install."
fi

if [[ "${AUTO_CONFIRM}" -ne 1 ]]; then
  read -r -p "Continue? [y/N] " CONFIRM
  if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
    echo "aborted"
    exit 1
  fi
fi

cd "${ROOT_DIR}"

rm -rf dist
npm install
npm run build
PACK_FILE="$(npm pack --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['filename'])")"
GLOBAL_PREFIX="$(npm prefix -g)"
GLOBAL_ROOT="$(npm root -g)"
GLOBAL_PKG_DIR="${GLOBAL_ROOT}/lark-codex"
GLOBAL_BIN_DIR="${GLOBAL_PREFIX}/bin"

mkdir -p "${GLOBAL_ROOT}" "${GLOBAL_BIN_DIR}"
mv "${GLOBAL_PKG_DIR}" "${GLOBAL_PKG_DIR}.bak.$(date +%s)" 2>/dev/null || true
mkdir -p "${GLOBAL_PKG_DIR}"
tar -xzf "./${PACK_FILE}" -C "${GLOBAL_PKG_DIR}" --strip-components=1
cp -a node_modules "${GLOBAL_PKG_DIR}/"
ln -sf "${GLOBAL_PKG_DIR}/bin/lark-codex.js" "${GLOBAL_BIN_DIR}/lark-codex"
chmod +x "${GLOBAL_PKG_DIR}/bin/lark-codex.js" "${GLOBAL_BIN_DIR}/lark-codex"
rm -f "${PACK_FILE}"

BIN_PATH="$(command -v lark-codex || true)"
if [[ -z "${BIN_PATH}" ]]; then
  echo "lark-codex not found on PATH after npm install -g ." >&2
  exit 1
fi

mkdir -p "${CONFIG_DIR}" "${LOG_DIR}"
if [[ "${SERVICE_MANAGER}" == "systemd" ]]; then
  mkdir -p "${SYSTEMD_DIR}"
else
  mkdir -p "${LAUNCHD_DIR}"
fi

if [[ ! -f "${ENV_PATH}" ]]; then
  cp "${ENV_TEMPLATE}" "${ENV_PATH}"
  python3 - "${ENV_PATH}" "${USER_HOME}" "${ROOT_DIR}" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
user_home = sys.argv[2]
text = env_path.read_text()
text = text.replace("$HOME", user_home)
env_path.write_text(text)
PY
fi

if [[ ! -f "${JSON_PATH}" ]]; then
  cp "${JSON_TEMPLATE}" "${JSON_PATH}"
  python3 - "${JSON_PATH}" "${USER_HOME}" "${ROOT_DIR}" <<'PY'
from pathlib import Path
import json
import sys

json_path = Path(sys.argv[1])
user_home = sys.argv[2]
root_dir = sys.argv[3]
data = json.loads(json_path.read_text())

def replace_home(value):
    if isinstance(value, str):
        return value.replace("$HOME", user_home)
    if isinstance(value, list):
        return [replace_home(item) for item in value]
    if isinstance(value, dict):
        return {key: replace_home(item) for key, item in value.items()}
    return value

data = replace_home(data)
project = data.setdefault("project", {})
allowed_roots = project.setdefault("allowedRoots", [user_home])
if root_dir not in allowed_roots:
    allowed_roots.append(root_dir)
project["defaultPath"] = root_dir
json_path.write_text(json.dumps(data, indent=2) + "\n")
PY
fi

MISSING_FEISHU_VARS="$(python3 - "${ENV_PATH}" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BOT_OPEN_ID"]
values = {}
for line in env_path.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key.strip()] = value.strip()
missing = [key for key in required if not values.get(key) or values[key] == "replace-me"]
print(",".join(missing))
PY
)"

if [[ "${SERVICE_MANAGER}" == "systemd" ]]; then
  sed \
    -e "s|@BIN_PATH@|${BIN_PATH}|g" \
    -e "s|@HOME@|${USER_HOME}|g" \
    -e "s|@PATH@|${PATH_VALUE}|g" \
    "${UNIT_TEMPLATE}" > "${UNIT_PATH}"
else
  cat > "${RUNNER_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="${USER_HOME}"
export PATH="${PATH_VALUE}"
export TMPDIR="/tmp"
if [[ -f "${ENV_PATH}" ]]; then
  set -a
  source "${ENV_PATH}"
  set +a
fi
exec "${BIN_PATH}"
EOF
  chmod +x "${RUNNER_PATH}"

  sed \
    -e "s|@RUNNER_PATH@|${RUNNER_PATH}|g" \
    -e "s|@WORKDIR@|${USER_HOME}|g" \
    -e "s|@HOME@|${USER_HOME}|g" \
    -e "s|@PATH@|${PATH_VALUE}|g" \
    -e "s|@STDOUT_PATH@|${STDOUT_PATH}|g" \
    -e "s|@STDERR_PATH@|${STDERR_PATH}|g" \
    "${PLIST_TEMPLATE}" > "${PLIST_PATH}"
fi

if [[ "${PREPARE_ONLY}" -eq 1 ]]; then
  echo "prepared config and service files only."
elif [[ -n "${MISSING_FEISHU_VARS}" ]]; then
  echo "service files were installed, but startup was skipped."
  echo "missing Feishu env vars in ${ENV_PATH}: ${MISSING_FEISHU_VARS}"
  echo "fill them in, then rerun ./install.sh --yes"
else
  if [[ "${SERVICE_MANAGER}" == "systemd" ]]; then
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
  else
    launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
    launchctl kickstart -k "gui/$(id -u)/${PLIST_LABEL}"
    echo "verifying service..."
    launchctl print "gui/$(id -u)/${PLIST_LABEL}" | sed -n '1,40p'
  fi
fi

if [[ -f "${JSON_PATH}" ]]; then
  python3 - "${JSON_PATH}" <<'PY'
from pathlib import Path
import json
import sys

json_path = Path(sys.argv[1])
data = json.loads(json_path.read_text())
codex = data.get("codex", {}) if isinstance(data, dict) else {}
backend = codex.get("backendMode", "(missing)")
sandbox = codex.get("sandboxMode", "(missing)")
approval_timeout = codex.get("approvalTimeoutMs", "(missing)")
print(f"config backendMode={backend}")
print(f"config sandboxMode={sandbox}")
print(f"config approvalTimeoutMs={approval_timeout}")
PY
fi
