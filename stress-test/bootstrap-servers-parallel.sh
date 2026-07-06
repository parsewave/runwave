#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVENTORY="${1:-}"
SSH_USER="${SSH_USER:-root}"
GAMES_S3_URI="${GAMES_S3_URI:-s3://pw-cruft/games}"
GAMES_DIR="${GAMES_DIR:-${ROOT_DIR}/cruft/games}"

source "${ROOT_DIR}/stress-test/lib/bootstrap-servers.sh"

runwave_bootstrap_init "stress-test/bootstrap-servers-parallel.sh cruft/inventory/<batch>.json"
batch="$(basename "${INVENTORY}" .json)"
LOG_DIR="${RUNWAVE_BOOTSTRAP_LOG_DIR:-${ROOT_DIR}/cruft/playtests/_bootstrap-logs/${batch}}"
mkdir -p "${LOG_DIR}"

echo "Bootstrapping ${server_count} servers in parallel"
echo "Logs: ${LOG_DIR}"

bootstrap_one() {
  local name="$1"
  local ip="$2"
  local log="${LOG_DIR}/${name}.log"

  {
    runwave_bootstrap_one "${name}" "${ip}"
  } > "${log}" 2>&1
}

pids=()
while IFS=$'\t' read -r name ip; do
  bootstrap_one "${name}" "${ip}" &
  pids+=("$!")
done < <(runwave_bootstrap_server_rows)

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
