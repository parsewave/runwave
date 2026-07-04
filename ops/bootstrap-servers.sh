#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVENTORY="${1:-}"
SSH_USER="${SSH_USER:-root}"
GAMES_S3_URI="${GAMES_S3_URI:-s3://pw-cruft/games}"
GAMES_DIR="${GAMES_DIR:-${ROOT_DIR}/cruft/games}"

source "${ROOT_DIR}/ops/lib/bootstrap-servers.sh"

runwave_bootstrap_init "ops/bootstrap-servers.sh ops/inventory/<batch>.json"
echo "Bootstrapping ${server_count} servers"

while IFS=$'\t' read -r name ip; do
  runwave_bootstrap_one "${name}" "${ip}"
done < <(runwave_bootstrap_server_rows)

echo "Bootstrap complete"
