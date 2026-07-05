FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV DEBIAN_FRONTEND=noninteractive
ENV RUNWAVE_IN_CONTAINER=1
ENV RUNWAVE_GAMES_ROOT=/opt/runwave/games
ENV RUNWAVE_JOBS_ROOT=/var/lib/runwave/jobs

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-pulseaudio \
    gstreamer1.0-tools \
    jq \
    pulseaudio \
    pulseaudio-utils \
    python3 \
    python3-pip \
    rsync \
    unzip \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN arch="$(uname -m)" \
  && case "${arch}" in \
    x86_64|amd64) aws_arch="x86_64" ;; \
    aarch64|arm64) aws_arch="aarch64" ;; \
    *) echo "Unsupported architecture for AWS CLI installer: ${arch}" >&2; exit 1 ;; \
  esac \
  && tmp_dir="$(mktemp -d)" \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o "${tmp_dir}/awscliv2.zip" \
  && unzip -q "${tmp_dir}/awscliv2.zip" -d "${tmp_dir}" \
  && "${tmp_dir}/aws/install" \
  && rm -rf "${tmp_dir}"

RUN install -d -m 0755 /opt/runwave/bin /opt/runwave/games /var/lib/runwave/jobs /var/log/runwave
COPY run-playtest.js /opt/runwave/bin/run-playtest.js
RUN chmod 0755 /opt/runwave/bin/run-playtest.js

ENTRYPOINT ["node", "/opt/runwave/bin/run-playtest.js"]
