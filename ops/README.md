# Runwave Playtest Fleet

This directory contains the local orchestration and remote worker scripts for
running many browser-game playtests across Hetzner servers.

## Shape

- Fleet: 8 x `ccx43` by default.
- Capacity: 24 concurrent playtests at the default `3` jobs per server, sized
  for 20 simultaneous playtests plus headroom.
- Games: synced from `s3://pw-cruft/games` to every server at
  `/opt/runwave/games`.
- Runner: installed at `/opt/runwave/bin/run-playtest.js`.
- Per playtest: clone the requested runwave repo/ref, install dependencies, run
  a browser playtest in an isolated workspace for 2 minutes by default, then
  upload the full workspace to S3.
- SSH: set `RUNWAVE_SSH_KEY` to the local private key used for workers. During
  provisioning, set `RUNWAVE_SSH_KEY_NAME` if the Hetzner key name cannot be
  inferred from the matching local public key.

The runner can drive the browser harness with either the default scripted
exploration plan or an agentic OpenRouter planner. The harness still only
controls the browser; the agent planner lives separately under `agent/`.

## Provision

Create the maximum-safety fleet:

```sh
export RUNWAVE_SSH_KEY="$HOME/.ssh/id_ed25519"
# Optional if the Hetzner key name cannot be inferred from RUNWAVE_SSH_KEY.pub:
# export RUNWAVE_SSH_KEY_NAME="<hetzner-ssh-key-name>"
SERVER_TYPE=ccx43 SERVER_COUNT=8 LOCATION=hel1 ops/provision-hetzner.sh
```

Defaults:

- `SERVER_TYPE=ccx43`
- `SERVER_COUNT=8`
- `LOCATION=hel1`
- `RUNWAVE_SSH_KEY_NAME` / `SSH_KEY_NAME`, or inferred from
  `RUNWAVE_SSH_KEY.pub` / `SSH_KEY.pub`

The script writes an inventory file under `ops/inventory/`.

## Bootstrap

Install dependencies and sync all browser games from S3 to each server:

```sh
ops/bootstrap-servers.sh ops/inventory/<batch>.json
```

This reads credentials from `~/.c.yaml` and writes them to
`/etc/runwave-runner.env` on each server with mode `0600`.

The default game source is `s3://pw-cruft/games`. Override it with:

```sh
GAMES_S3_URI=s3://OTHER_BUCKET/other-prefix ops/bootstrap-servers.sh ops/inventory/<batch>.json
```

## Run

Run one attempt per detected browser game:

```sh
node ops/orchestrate-playtests.js \
  --inventory ops/inventory/<batch>.json \
  --s3-uri s3://pw-cruft/playtests \
  --games-s3-uri s3://pw-cruft/games \
  --runwave-ref runwave-agentic-player \
  --agent
```

With 22 browser games in `s3://pw-cruft/games`, that command schedules one
playtest per discovered browser game. By default the local orchestrator discovers that game list from
`s3://pw-cruft/games`, not from the local checkout.

Run one agentic attempt for every discovered browser game:

```sh
export RUNWAVE_SSH_KEY="$HOME/.ssh/id_ed25519"
node ops/orchestrate-playtests.js \
  --inventory ops/inventory/<batch>.json \
  --s3-uri s3://pw-cruft/playtests \
  --games-s3-uri s3://pw-cruft/games \
  --runwave-ref runwave-agentic-player \
  --play-mode agent \
  --playtest-duration-ms 120000 \
  --agent-min-playtest-ms 110000 \
  --vlm-viewport-preflight \
  --viewport-preflight-attempts 2 \
  --ssh-key "$RUNWAVE_SSH_KEY" \
  --concurrency-per-server 3
```

With 8 servers and `--concurrency-per-server 3`, the fleet can start 24 jobs at
once. The orchestrator refuses a 20-job run if the inventory cannot provide at
least 20 concurrent slots.

Only browser games whose `start.sh` serves HTTP are scheduled by default.
Unity/editor-only projects are installed on the machines but skipped because
runwave drives browser targets.

For agent jobs, if `--agent-min-playtest-ms` is not provided, the orchestrator
sets it to `--playtest-duration-ms - 10000`. A 120 second run therefore requires
about 110 seconds of play before the agent is allowed to stop.

Add `--vlm-viewport-preflight` to let the model choose among viewport candidate
screenshots before gameplay starts. The generated job sets
`vlmViewportPreflight: true`; `--viewport-preflight-attempts 2` gives the model
one retry before falling back to the deterministic viewport probe.

## Agent Mode

Agent mode uses the browser harness as the hands and the `agent/` package as the
model-calling planner. The planner currently uses OpenRouter, reading
`OPENROUTER_API_KEY` from the environment or `~/.c.yaml`. Override the model with
`RUNWAVE_AGENT_MODEL` or `OPENROUTER_MODEL`.

For a single local game smoke:

```sh
aws s3 sync s3://pw-cruft/games/mario-html5/ \
  cruft/playtests/_games-cache/mario-html5/ \
  --delete --only-show-errors

RUNWAVE_GAMES_ROOT="$PWD/cruft/playtests/_games-cache" \
RUNWAVE_JOBS_ROOT="$PWD/cruft/playtests/local-agent-smoke/jobs" \
node ops/remote/run-playtest.js --job ops/examples/job-agent-mario.local.json
```

On machines with Chrome already installed and Playwright downloads blocked, set
`skipPlaywrightInstall: true` and `channel: "chrome"` in the job JSON.

For a server-side one-game agent run, use
`ops/examples/job-agent-mario.server.json`. It runs agent mode for a 3-minute
safety window and enables verbose harness timing logs.

## Viewer

After downloading artifacts, build a local video viewer:

![Runwave playtest viewer showing multiple recorded game videos](assets/playtest-viewer.png)

```sh
node ops/build-playtest-viewer.js \
  --artifacts cruft/playtests/<run-id>/s3-artifacts \
  --out cruft/playtests/<run-id>/viewer/index.html
```
