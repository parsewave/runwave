#!/usr/bin/env bash

runwave_bootstrap_init() {
  local usage="$1"

  if [ -z "${INVENTORY}" ] || [ ! -f "${INVENTORY}" ]; then
    echo "Usage: ${usage}" >&2
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

  tmp_dir="$(mktemp -d)"
  cleanup() {
    rm -rf "${tmp_dir}"
  }
  trap cleanup EXIT

  env_file="${tmp_dir}/runwave-runner.env"
  games_tar=""

  runwave_bootstrap_prepare_games
  runwave_bootstrap_write_env
  server_count="$(jq '.servers | length' "${INVENTORY}")"
}

runwave_bootstrap_prepare_games() {
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
}

runwave_bootstrap_write_env() {
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
}

runwave_bootstrap_server_rows() {
  jq -r '.servers[] | [.name, .ipv4] | @tsv' "${INVENTORY}"
}

runwave_bootstrap_one() {
  local name="$1"
  local ip="$2"
  local ssh_opts=(-i "${SSH_KEY}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=15)
  local scp_files=(
    "${ROOT_DIR}/ops/remote/bootstrap-runner.sh"
    "${ROOT_DIR}/ops/remote/run-playtest.js"
    "${env_file}"
  )
  if [ -n "${games_tar}" ]; then
    scp_files+=("${games_tar}")
  fi

  echo "Bootstrapping ${name} (${ip})"
  scp "${ssh_opts[@]}" "${scp_files[@]}" "${SSH_USER}@${ip}:/tmp/"
  ssh -n "${ssh_opts[@]}" "${SSH_USER}@${ip}" "GAMES_S3_URI='${GAMES_S3_URI}' bash /tmp/bootstrap-runner.sh"
}
