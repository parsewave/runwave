#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

need_node_install=0
if ! command -v node >/dev/null 2>&1; then
  need_node_install=1
else
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major}" -lt 20 ]; then
    need_node_install=1
  fi
fi

apt-get update
apt-get install -y ca-certificates curl ffmpeg gnupg git jq pulseaudio pulseaudio-utils python3 python3-pip rsync unzip

if [ "${need_node_install}" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v aws >/dev/null 2>&1; then
  arch="$(uname -m)"
  case "${arch}" in
    x86_64|amd64) aws_arch="x86_64" ;;
    aarch64|arm64) aws_arch="aarch64" ;;
    *)
      echo "Unsupported architecture for AWS CLI installer: ${arch}" >&2
      exit 1
      ;;
  esac
  tmp_dir="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o "${tmp_dir}/awscliv2.zip"
  unzip -q "${tmp_dir}/awscliv2.zip" -d "${tmp_dir}"
  "${tmp_dir}/aws/install" --update
  rm -rf "${tmp_dir}"
fi

install -d -m 0755 /opt/runwave/bin /opt/runwave/games /var/lib/runwave/jobs /var/log/runwave
install -m 0755 /tmp/run-playtest.js /opt/runwave/bin/run-playtest.js
install -m 0600 /tmp/runwave-runner.env /etc/runwave-runner.env

# shellcheck disable=SC1091
source /etc/runwave-runner.env

rm -rf /opt/runwave/games/*
if [ -n "${GAMES_S3_URI:-}" ]; then
  aws s3 sync "${GAMES_S3_URI%/}/" /opt/runwave/games/ --delete --only-show-errors
elif [ -f /tmp/games.tar.gz ]; then
  tar -xzf /tmp/games.tar.gz -C /opt/runwave/games
else
  echo "Missing GAMES_S3_URI and /tmp/games.tar.gz" >&2
  exit 1
fi

# Install browser system dependencies once; each job installs the exact runwave
# package and browser revision requested by that runwave checkout.
npx -y playwright@1.61.1 install-deps chromium

node --version
npm --version
aws --version
echo "Installed games:"
find /opt/runwave/games -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort

echo "Installing per-game npm dependencies:"
while IFS= read -r package_json; do
  game_dir="$(dirname "${package_json}")"
  echo "npm install in ${game_dir}"
  npm install --prefix "${game_dir}"
done < <(find /opt/runwave/games -mindepth 2 -maxdepth 2 -name package.json | sort)
