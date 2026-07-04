#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVENTORY="${1:-}"
SSH_USER="${SSH_USER:-root}"
GAMES_S3_URI="${GAMES_S3_URI:-s3://pw-cruft/games}"
GAMES_DIR="${GAMES_DIR:-${ROOT_DIR}/cruft/games}"

if [ -z "${INVENTORY}" ] || [ ! -f "${INVENTORY}" ]; then
  echo "Usage: ops/bootstrap-servers-parallel.sh cruft/inventory/<batch>.json" >&2
  exit 1
fi
if [ -z "${GAMES_S3_URI}" ] && [ ! -d "${GAMES_DIR}" ]; then
  echo "Missing games directory: ${GAMES_DIR}" >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}

SSH_KEY="$(node "${ROOT_DIR}/ops/lib/ssh-key.js")"
batch="$(basename "${INVENTORY}" .json)"
LOG_DIR="${RUNWAVE_BOOTSTRAP_LOG_DIR:-${ROOT_DIR}/cruft/playtests/_bootstrap-logs/${batch}}"
mkdir -p "${LOG_DIR}"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

env_file="${tmp_dir}/runwave-runner.env"
games_tar=""

if [ -z "${GAMES_S3_URI}" ]; then
  games_tar="${tmp_dir}/games.tar.gz"
  echo "Packing games from ${GAMES_DIR}"
  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='Library' \
    --exclude='Temp' \
    -czf "${games_tar}" \
    -C "${GAMES_DIR}" .
else
  echo "Remote servers will sync games from ${GAMES_S3_URI}"
fi

awk -F':[[:space:]]*' '
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*$/ { next }
  {
    key=$1
    val=$2
    gsub(/^[[:space:]"'\''"]+|[[:space:]"'\''"]+$/, "", key)
    gsub(/^[[:space:]"'\''"]+|[[:space:]"'\''"]+$/, "", val)
    if (key ~ /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_DEFAULT_REGION|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|PARSEWAVE_API_TOKEN|PARSEWAVE_API_TOKEN3|PARSEWAVE_API_TOKEN4|PARSEWAVE_API_TOKEN5|GH_TOKEN|GITHUB_ACCESS_TOKEN)$/ && val != "") {
      gsub(/'\''/, "'\''\"'\''\"'\''", val)
      printf "export %s='\''%s'\''\n", key, val
    }
  }
' "${HOME}/.c.yaml" > "${env_file}"

if ! grep -q '^export AWS_DEFAULT_REGION=' "${env_file}"; then
  echo "export AWS_DEFAULT_REGION='us-east-1'" >> "${env_file}"
fi

server_count="$(jq '.servers | length' "${INVENTORY}")"
echo "Bootstrapping ${server_count} servers in parallel"
echo "Logs: ${LOG_DIR}"

bootstrap_one() {
  local name="$1"
  local ip="$2"
  local log="${LOG_DIR}/${name}.log"
  local ssh_opts=(-i "${SSH_KEY}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=15)
  local scp_files=(
    "${ROOT_DIR}/ops/remote/bootstrap-runner.sh"
    "${ROOT_DIR}/ops/remote/run-playtest.js"
    "${env_file}"
  )
  if [ -n "${games_tar}" ]; then
    scp_files+=("${games_tar}")
  fi

  {
    echo "Bootstrapping ${name} (${ip})"
    scp "${ssh_opts[@]}" "${scp_files[@]}" "${SSH_USER}@${ip}:/tmp/"
    ssh -n "${ssh_opts[@]}" "${SSH_USER}@${ip}" "GAMES_S3_URI='${GAMES_S3_URI}' bash /tmp/bootstrap-runner.sh"
  } > "${log}" 2>&1
}

pids=()
while IFS=$'\t' read -r name ip; do
  bootstrap_one "${name}" "${ip}" &
  pids+=("$!")
done < <(jq -r '.servers[] | [.name, .ipv4] | @tsv' "${INVENTORY}")

exit_code=0
for pid in "${pids[@]}"; do
  if ! wait "${pid}"; then
    exit_code=1
  fi
done

if [ "${exit_code}" -eq 0 ]; then
  echo "Bootstrap complete"
else
  echo "One or more bootstrap jobs failed; inspect ${LOG_DIR}" >&2
fi
exit "${exit_code}"
