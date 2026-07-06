---
name: runwave-playtest-fleet
description: Run 20 or more simultaneous browser-game playtests with runwave using games from s3://pw-cruft/games, WebGL-oriented Chromium launch flags for every game with SwiftShader allowed as a CPU fallback, Hetzner workers or a local fallback, S3 artifact upload/download, and a generated browser video viewer. Use when asked to launch, test, orchestrate, monitor, or review a many-game runwave playtest batch.
---

# Runwave Playtest Fleet

Use this skill to run an agentic many-game browser playtest batch end to end:
discover games from S3, run one isolated OpenRouter-planned runwave job per
game, upload artifacts to S3, download artifacts into `cruft/playtests`, and
build a video viewer. Scripted mode is only for local smoke tests and controller
debugging, not for real fleet results.

## Defaults

- Game source: `s3://pw-cruft/games`
- Result S3 prefix: `s3://pw-cruft/playtests/<run-id>/`
- Local artifact root: `cruft/playtests/<run-id>/`
- Viewer path: `cruft/playtests/<run-id>/viewer/index.html`
- Playtest duration: `120000` ms per game
- Fleet size target: `8` workers, `3` jobs per server, `24` concurrent slots
- Every Linux playtest job runs inside a dedicated Docker container by default
  so each game, Chromium instance, Xvfb session, PulseAudio null sink,
  GStreamer recorder, and upload process has isolated runtime state.
- Runwave repo: `https://github.com/parsewave/runwave`
- SSH key: `RUNWAVE_SSH_KEY` / `SSH_KEY`, or an auto-detected local
  `~/.ssh/id_ed25519` / `~/.ssh/id_rsa`
- Secrets may come from environment variables, local shell profiles, CI secrets,
  or `~/.c.yaml`; never print secret values
- WebGL launch policy: every game uses WebGL-oriented Chromium flags. SwiftShader
  is allowed as a CPU fallback, and the fleet does not track WebGL-sensitive
  games separately.

## Required Secrets

Required for S3 game discovery, artifact upload, and artifact download:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_DEFAULT_REGION`, optional but recommended; use `us-east-1` when absent
- `AWS_SESSION_TOKEN`, only when using temporary AWS credentials

Required for Hetzner provisioning:

- `HCLOUD_TOKEN` or `HETZNER_API_KEY`

Required for SSH access to workers:

- Private key path via `RUNWAVE_SSH_KEY` or `SSH_KEY`
- Hetzner SSH key name via `RUNWAVE_SSH_KEY_NAME` / `SSH_KEY_NAME`, or inferred
  from the matching local public key

Required by the current agentic playtester:

- `OPENROUTER_API_KEY`

Sometimes required by runwave-adjacent tooling, depending on the selected
planner/model or private repo access:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `PARSEWAVE_API_TOKEN`
- `GITHUB_ACCESS_TOKEN` or `GH_TOKEN`, if private runwave refs/repos are used

Prefer already-exported environment variables. If they are not set and a
project-specific secret file exists, source or parse only the keys needed for the
current operation.

## Preflight

From the repo root:

```sh
node --check ops/orchestrate-playtests.js
node --check ops/remote/run-playtest.js
node --check ops/build-playtest-viewer.js
bash -n ops/provision-hetzner.sh
bash -n ops/bootstrap-servers.sh
bash -n ops/bootstrap-servers-parallel.sh
bash -n ops/remote/bootstrap-runner.sh
```

Check S3 game discovery after AWS credentials are available:

```sh
AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}
export AWS_DEFAULT_REGION
aws s3api list-objects-v2 --bucket pw-cruft --prefix games/ --delimiter / --output json |
  jq -r '.CommonPrefixes[].Prefix'
```

Skip hidden prefixes such as `games/.run/`. Schedule only directories with a `start.sh` that serves HTTP unless explicitly told otherwise.

WebGL preflight:

- All jobs launch Chromium with WebGL-oriented flags.
- SwiftShader is acceptable; do not fail a job only because
  `webgl.unmaskedRenderer` or `webgl.renderer` contains `SwiftShader`.
- Inspect WebGL metadata after runs only to debug rendering issues, not to gate
  scheduling.

## Preferred Remote Run

Use this path when Hetzner creation and SSH are working.

1. Provision the fleet:

```sh
export RUNWAVE_SSH_KEY="$HOME/.ssh/id_ed25519"
# Optional if the Hetzner key name cannot be inferred from RUNWAVE_SSH_KEY.pub:
# export RUNWAVE_SSH_KEY_NAME="<hetzner-ssh-key-name>"
SERVER_TYPE=<worker-type> SERVER_COUNT=8 LOCATION=hel1 ops/provision-hetzner.sh
```

2. Bootstrap servers in parallel. This syncs `s3://pw-cruft/games` to
   `/opt/runwave/games` on every worker, installs runner dependencies, installs
   Docker, and builds the `runwave-playtest-runner:latest` image used by each
   job.

```sh
ops/bootstrap-servers-parallel.sh cruft/inventory/<batch>.json
```

If any worker fails, inspect `cruft/playtests/_bootstrap-logs/<batch>/<worker>.log`.
The bootstrap is idempotent enough to rerun for failed workers after apt/dpkg has
settled.

3. Launch one playtest per discovered browser game:

```sh
export RUNWAVE_SSH_KEY="$HOME/.ssh/id_ed25519"
node ops/orchestrate-playtests.js \
  --inventory cruft/inventory/<batch>.json \
  --s3-uri s3://pw-cruft/playtests \
  --games-s3-uri s3://pw-cruft/games \
  --runwave-ref runwave-agentic-player \
  --playtest-duration-ms 120000 \
  --agent-min-playtest-ms 110000 \
  --ssh-key "$RUNWAVE_SSH_KEY" \
  --agent \
  --concurrency-per-server 3
```

The orchestrator refuses a 20-job run if capacity is below `20`. It assigns
unique ports per server and uploads each job to:

```text
s3://pw-cruft/playtests/<run-id>/<game>/attempt-001/
```

For agent jobs, if `--agent-min-playtest-ms` is omitted, the orchestrator sets
it to `--playtest-duration-ms - 10000`. A 120 second run therefore requires
about 110 seconds of agent play before early stop is allowed.

## Local Fallback

Use the local fallback when Hetzner is not provisionable, public IPs are blocked, or SSH is unavailable. Keep concurrency conservative, usually `4`.

1. Sync games locally:

```sh
mkdir -p cruft/playtests/_games-cache
aws s3 sync s3://pw-cruft/games/ cruft/playtests/_games-cache/ --delete --only-show-errors
```

2. Install per-game npm dependencies:

```sh
while IFS= read -r package_json; do
  game_dir=$(dirname "$package_json")
  npm install --prefix "$game_dir" --no-audit --no-fund
done < <(find cruft/playtests/_games-cache -mindepth 2 -maxdepth 2 -name package.json | sort)
```

3. Generate job JSON files under `cruft/playtests/<run-id>/job-specs`. Each job needs:

```json
{
  "jobId": "<run-id>-<game>-attempt-001",
  "runId": "<run-id>",
  "game": "<game>",
  "attempt": 1,
  "port": 9300,
  "runwaveRepo": "https://github.com/parsewave/runwave",
  "runwaveRef": "main",
  "playMode": "agent",
  "playtestDurationMs": 120000,
  "s3Uri": "s3://pw-cruft/playtests/<run-id>/<game>/attempt-001"
}
```

Remote jobs read `viewport` and `videoSize` from the game's `metadata.json`.
Do not put those fields in normal fleet job specs.

4. Run jobs with:

```sh
docker build -f ops/remote/playtest-runner.Dockerfile \
  -t runwave-playtest-runner:latest \
  ops/remote

RUNWAVE_GAMES_ROOT="$PWD/cruft/playtests/_games-cache" \
RUNWAVE_JOBS_ROOT="$PWD/cruft/playtests/<run-id>/local-jobs" \
node ops/remote/run-playtest.js --job cruft/playtests/<run-id>/job-specs/<job>.json
```

For local parallel execution, spawn up to four of these commands at a time. Capture each job’s stdout/stderr to `cruft/playtests/<run-id>/<jobId>.log`, and write a `results.json` containing `{jobId, game, code, log, s3Uri}` for every job.
On Linux, the runner launches the actual playtest inside Docker by default. Set
`RUNWAVE_PLAYTEST_CONTAINER=0` only when debugging a single job directly on the
host.

## Download And Viewer

After all jobs finish, download artifacts:

```sh
aws s3 sync \
  s3://pw-cruft/playtests/<run-id>/ \
  cruft/playtests/<run-id>/s3-artifacts/ \
  --delete --only-show-errors
```

S3 downloads can hit transient network, proxy, or incomplete-read failures. If
sync reports errors such as `Failed to connect to proxy URL` or
`IncompleteRead`, rerun the sync once with proxy variables unset, then rebuild
the viewer:

```sh
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
  aws s3 sync \
    s3://pw-cruft/playtests/<run-id>/ \
    cruft/playtests/<run-id>/s3-artifacts/ \
    --delete --only-show-errors
```

Build the viewer:

```sh
node ops/build-playtest-viewer.js \
  --artifacts cruft/playtests/<run-id>/s3-artifacts \
  --out cruft/playtests/<run-id>/viewer/index.html
```

The viewer is static HTML with filterable cards, embedded WebM videos,
fullscreen controls, poster screenshots, and links to each `summary.json`.

## Verification

Before reporting success, verify:

```sh
RUN_ID=<run-id>
jq '{total:length, failed: map(select(.code != 0))}' "cruft/playtests/$RUN_ID/results.json"
find "cruft/playtests/$RUN_ID/s3-artifacts" -name summary.json | wc -l
find "cruft/playtests/$RUN_ID/s3-artifacts" -name '*.webm' | wc -l
find "cruft/playtests/$RUN_ID/s3-artifacts" -name '*.png' | wc -l
```

Validate viewer links:

```sh
node - "$RUN_ID" <<'NODE'
const fs = require('fs');
const path = require('path');
const runId = process.argv[2];
const viewer = path.resolve('cruft/playtests', runId, 'viewer/index.html');
const html = fs.readFileSync(viewer, 'utf8');
const refs = [...html.matchAll(/(?:data-src|src|poster|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((value) => value && !value.startsWith('#'));
const missing = refs.filter((ref) => !fs.existsSync(path.resolve(path.dirname(viewer), ref)));
console.log(JSON.stringify({ viewer, refs: refs.length, missing: missing.length, sampleMissing: missing.slice(0, 5) }, null, 2));
process.exit(missing.length ? 1 : 0);
NODE
```

Report the run id, S3 result prefix, local artifact folder, viewer path, job count, failure count, WebM count, screenshot count, and whether the run used remote workers or local fallback.

## Failure Handling

- If Hetzner returns `permission denied`, do not keep retrying provisioning. Use local fallback and report that fleet provisioning is blocked by token permissions.
- If existing Hetzner servers have blocked public IPs or SSH timeouts, use local fallback and report that remote workers are unreachable.
- If a job fails, leave its local workspace and log intact, download whatever uploaded, and include the failed job ids in the result.
- If S3 has more than 20 runnable browser games, prefer running all of them unless the user explicitly requests exactly 20.
- If artifact download fails with transient proxy/network errors, do not treat
  the playtest run as failed immediately. Retry `aws s3 sync` with proxy
  variables unset and verify viewer links after the retry.
