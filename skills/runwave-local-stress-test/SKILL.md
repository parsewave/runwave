---
name: runwave-local-stress-test
description: Run exactly one local runwave browser-game stress-test smoke using stress-test/remote/run-playtest.js, a local S3-synced game cache, Docker runner isolation, and the Radius Raid example game from s3://pw-cruft/games/radius-raid. Use when asked to run, debug, reproduce, or document a one-game local stress test instead of the full 20+ game remote Hetzner fleet.
---

# Runwave Local Stress Test

Use this skill for the smallest local stress-test path: one agentic runwave
playtest against one browser game, using the same `stress-test/remote` runner
and Docker container shape as fleet jobs. Use `runwave-stress-test` for the
20+ game remote batch.

## Defaults

- Game: `radius-raid`
- Game source: `s3://pw-cruft/games/radius-raid/`
- Local game cache: `cruft/playtests/_games-cache/radius-raid/`
- Job spec: `stress-test/examples/job-agent-radius-raid.local.json`
- Job root: `cruft/playtests/local-agent-smoke/jobs/`
- Runner: `stress-test/remote/run-playtest.js`
- Docker image: `runwave-playtest-runner:latest`
- Playtest duration: `30000` ms
- Minimum agent play time: `15000` ms
- Radius Raid is the repo's one-game smoke example. Treat the example as
  approved game content for this workflow; do not use the skill as a license
  determination.

## Preflight

From the repo root:

```sh
node --check stress-test/remote/run-playtest.js
bash -n cruft/playtests/_games-cache/radius-raid/start.sh 2>/dev/null || true
```

Required credentials:

- `OPENROUTER_API_KEY` for agent mode.
- AWS credentials only to refresh the S3 game cache.

If Chrome is installed locally and Playwright browser downloads are blocked,
keep `skipPlaywrightInstall: true` and `channel: "chrome"` in the local job
JSON.

## Run One Local Game

1. Refresh only Radius Raid from S3:

```sh
mkdir -p cruft/playtests/_games-cache/radius-raid
aws s3 sync s3://pw-cruft/games/radius-raid/ \
  cruft/playtests/_games-cache/radius-raid/ \
  --delete --only-show-errors
```

2. Install game dependencies if `package.json` is present:

```sh
if [ -f cruft/playtests/_games-cache/radius-raid/package.json ]; then
  npm install --prefix cruft/playtests/_games-cache/radius-raid --no-audit --no-fund
fi
```

3. Build or refresh the local runner image:

```sh
docker build -f stress-test/remote/playtest-runner.Dockerfile \
  -t runwave-playtest-runner:latest \
  stress-test/remote
```

4. Run the single local job:

```sh
RUNWAVE_GAMES_ROOT="$PWD/cruft/playtests/_games-cache" \
RUNWAVE_JOBS_ROOT="$PWD/cruft/playtests/local-agent-smoke/jobs" \
node stress-test/remote/run-playtest.js --job stress-test/examples/job-agent-radius-raid.local.json
```

On Linux, the runner launches the playtest inside Docker by default. Set
`RUNWAVE_PLAYTEST_CONTAINER=0` only when debugging the runner directly on the
host.

## Verify

Inspect the local workspace:

```sh
RUN_ID=local-agent-smoke
JOB_ID=local-agent-radius-raid
jq '{jobId, game, status, viewport, error}' "cruft/playtests/$RUN_ID/jobs/$JOB_ID/workspace/summary.json"
find "cruft/playtests/$RUN_ID/jobs/$JOB_ID/workspace" -name '*.webm' -o -name '*.png'
```

Report the summary path, final status, video path if present, screenshot count,
and whether the run used Docker or `RUNWAVE_PLAYTEST_CONTAINER=0`.

## Failure Handling

- If `metadata.json` is missing, rerun the S3 sync for `radius-raid`; stale
  local caches may predate game metadata.
- If Docker is unavailable, either install/start Docker or set
  `RUNWAVE_PLAYTEST_CONTAINER=0` for direct host debugging.
- If the agent cannot call the model, verify `OPENROUTER_API_KEY` or the
  project secret-loading path used by `stress-test/remote/run-playtest.js`.
- If upload is needed, add `s3Uri` to a copied job spec. Keep the default local
  example upload-free so one-game smoke tests do not require S3 writes.
