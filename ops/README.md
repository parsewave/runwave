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

The current runner drives the runwave browser harness directly with a default
exploration plan. If a separate detective/VLM planner is added later, plug it in
at the runner boundary where the action plan is produced.

## Provision

Create the maximum-safety fleet:

```sh
ops/provision-hetzner.sh
```

Defaults:

- `SERVER_TYPE=ccx43`
- `SERVER_COUNT=8`
- `LOCATION=hel1`
- `SSH_KEY_NAME=hetzner-id_louka`

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
  --s3-uri s3://YOUR_BUCKET/runwave-playtests \
  --runwave-ref main
```

With 20 browser games in `s3://pw-cruft/games`, that command schedules 20
playtests.
By default the local orchestrator discovers that game list from
`s3://pw-cruft/games`, not from the local checkout.

Run 20 total attempts spread over the detected browser games:

```sh
node ops/orchestrate-playtests.js \
  --inventory ops/inventory/<batch>.json \
  --s3-uri s3://YOUR_BUCKET/runwave-playtests \
  --runwave-ref main \
  --total-attempts 20 \
  --playtest-duration-ms 120000 \
  --concurrency-per-server 3
```

With 8 servers and `--concurrency-per-server 3`, the fleet can start 24 jobs at
once. The orchestrator refuses a 20-job run if the inventory cannot provide at
least 20 concurrent slots.

Only browser games whose `start.sh` serves HTTP are scheduled by default.
Unity/editor-only projects are installed on the machines but skipped because
runwave drives browser targets.

## Viewer

After downloading artifacts, build a local video viewer:

```sh
node ops/build-playtest-viewer.js \
  --artifacts cruft/playtests/<run-id>/s3-artifacts \
  --out cruft/playtests/<run-id>/viewer/index.html
```
