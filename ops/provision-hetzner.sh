#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVENTORY_DIR="${ROOT_DIR}/ops/inventory"
SERVER_TYPE="${SERVER_TYPE:-ccx43}"
SERVER_COUNT="${SERVER_COUNT:-8}"
LOCATION="${LOCATION:-hel1}"
IMAGE="${IMAGE:-ubuntu-24.04}"
SSH_KEY_NAME="${SSH_KEY_NAME:-hetzner-id_louka}"
BATCH="${BATCH:-runwave-$(date -u +%Y%m%d-%H%M%S)}"

token_from_yaml() {
  awk -F':[[:space:]]*' '/HETZNER_API_KEY/ {
    gsub(/^[[:space:]"'\''"]+|[[:space:]"'\''"]+$/, "", $2);
    print $2;
    exit
  }' "${HOME}/.c.yaml"
}

HCLOUD_TOKEN="${HCLOUD_TOKEN:-$(token_from_yaml)}"
if [ -z "${HCLOUD_TOKEN}" ]; then
  echo "Missing HCLOUD_TOKEN and HETZNER_API_KEY in ~/.c.yaml" >&2
  exit 1
fi

command -v hcloud >/dev/null 2>&1 || {
  echo "hcloud CLI is required" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}

mkdir -p "${INVENTORY_DIR}"

echo "Creating ${SERVER_COUNT} ${SERVER_TYPE} servers in ${LOCATION} for batch ${BATCH}"

server_ids=()
for i in $(seq 1 "${SERVER_COUNT}"); do
  name="${BATCH}-$(printf '%02d' "${i}")"
  echo "Creating ${name}"
  create_json="$(
    HCLOUD_TOKEN="${HCLOUD_TOKEN}" hcloud server create \
      --name "${name}" \
      --type "${SERVER_TYPE}" \
      --image "${IMAGE}" \
      --location "${LOCATION}" \
      --ssh-key "${SSH_KEY_NAME}" \
      --label role=runwave-playtester \
      --label batch="${BATCH}" \
      --start-after-create \
      -o json
  )"
  server_ids+=("$(printf '%s' "${create_json}" | jq -r '.server.id')")
done

servers_json="[]"
for id in "${server_ids[@]}"; do
  server_json="$(HCLOUD_TOKEN="${HCLOUD_TOKEN}" hcloud server describe "${id}" -o json)"
  servers_json="$(
    jq -n \
      --argjson list "${servers_json}" \
      --argjson server "${server_json}" \
      '$list + [{
        id: $server.id,
        name: $server.name,
        ipv4: $server.public_net.ipv4.ip,
        type: $server.server_type.name,
        location: $server.datacenter.location.name
      }]'
  )"
done

inventory="${INVENTORY_DIR}/${BATCH}.json"
jq -n \
  --arg batch "${BATCH}" \
  --arg server_type "${SERVER_TYPE}" \
  --arg location "${LOCATION}" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson servers "${servers_json}" \
  '{batch:$batch, serverType:$server_type, location:$location, createdAt:$created_at, servers:$servers}' \
  > "${inventory}"

echo "Wrote ${inventory}"
jq -r '.servers[] | "\(.name) \(.ipv4) \(.type) \(.location)"' "${inventory}"
