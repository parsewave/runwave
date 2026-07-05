#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVENTORY_DIR="${INVENTORY_DIR:-${ROOT_DIR}/cruft/inventory}"
SERVER_TYPE="${SERVER_TYPE:-ccx43}"
SERVER_COUNT="${SERVER_COUNT:-8}"
PROVISION_CONCURRENCY="${PROVISION_CONCURRENCY:-4}"
LOCATION="${LOCATION:-hel1}"
IMAGE="${IMAGE:-ubuntu-24.04}"
SSH_KEY_NAME="${RUNWAVE_SSH_KEY_NAME:-${SSH_KEY_NAME:-}}"
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

ssh_key_name_from_local_key() {
  local key pub fingerprint
  key="$(node "${ROOT_DIR}/ops/lib/ssh-key.js")"
  pub="${key}.pub"
  if [ ! -f "${pub}" ]; then
    return 1
  fi
  fingerprint="$(ssh-keygen -E md5 -lf "${pub}" | awk '{print $2}' | sed 's/^MD5://')"
  if [ -z "${fingerprint}" ]; then
    return 1
  fi
  HCLOUD_TOKEN="${HCLOUD_TOKEN}" hcloud ssh-key list -o json |
    jq -r --arg fingerprint "${fingerprint}" 'first(.[] | select(.fingerprint == $fingerprint) | .name) // empty'
}

if [ -z "${SSH_KEY_NAME}" ]; then
  command -v ssh-keygen >/dev/null 2>&1 || {
    echo "ssh-keygen is required to infer RUNWAVE_SSH_KEY_NAME from a local public key" >&2
    exit 1
  }
  SSH_KEY_NAME="$(ssh_key_name_from_local_key || true)"
fi
if [ -z "${SSH_KEY_NAME}" ]; then
  echo "Missing RUNWAVE_SSH_KEY_NAME/SSH_KEY_NAME and could not infer it from the local SSH public key" >&2
  exit 1
fi
if ! [[ "${PROVISION_CONCURRENCY}" =~ ^[0-9]+$ ]] || [ "${PROVISION_CONCURRENCY}" -lt 1 ]; then
  echo "PROVISION_CONCURRENCY must be a positive integer" >&2
  exit 1
fi

mkdir -p "${INVENTORY_DIR}"

echo "Creating ${SERVER_COUNT} ${SERVER_TYPE} servers in ${LOCATION} for batch ${BATCH}"
echo "Provisioning concurrency: ${PROVISION_CONCURRENCY}"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

create_one() {
  local i="$1"
  local name="${BATCH}-$(printf '%02d' "${i}")"
  local create_json

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
  printf '%s\n' "${create_json}" > "${tmp_dir}/server-${i}.json"
  printf '%s\n' "${create_json}" | jq -r '.server.id' > "${tmp_dir}/server-${i}.id"
}

wait_batch() {
  local exit_code=0
  local pid

  for pid in "$@"; do
    if ! wait "${pid}"; then
      exit_code=1
    fi
  done
  return "${exit_code}"
}

pids=()
for i in $(seq 1 "${SERVER_COUNT}"); do
  create_one "${i}" &
  pids+=("$!")
  if [ "${#pids[@]}" -ge "${PROVISION_CONCURRENCY}" ]; then
    wait_batch "${pids[@]}" || {
      echo "One or more server creates failed" >&2
      exit 1
    }
    pids=()
  fi
done

if [ "${#pids[@]}" -gt 0 ]; then
  wait_batch "${pids[@]}" || {
    echo "One or more server creates failed" >&2
    exit 1
  }
fi

server_ids=()
for i in $(seq 1 "${SERVER_COUNT}"); do
  server_ids+=("$(<"${tmp_dir}/server-${i}.id")")
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
