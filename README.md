# MM Action Harness

Reusable Playwright CLI harness for browser games and canvas apps.

This package is the task-neutral version of the PR145 action harness. It only
provides browser control and artifact capture. It does not include a VLM
playtester, frame picker, or judge.

## Install

From a local checkout:

```sh
npm install
npm test
```

From a private GitHub repo in a task Dockerfile:

```dockerfile
RUN npm install -g git+ssh://git@github.com/OWNER/mm-action-harness.git
RUN npx playwright install --with-deps chromium
```

The installed CLI is:

```sh
action-harness '<json>'
```

## Workspace And Outputs

Relative `file`, `outputRoot`, and `outDir` paths resolve from:

1. `ACTION_HARNESS_WORKSPACE`, when set.
2. The current working directory.

Useful environment variables:

- `ACTION_HARNESS_WORKSPACE`: base directory for relative paths.
- `ACTION_HARNESS_SESSION_FILE`: active session JSON path. Defaults to
  `<workspace>/.action-harness-session.json`.
- `ACTION_HARNESS_SESSION_WAIT_MS`: startup wait for the daemon session file.
  Defaults to `60000`.

Each command must include `action_name`. By default, command artifacts are
written under:

```text
state/output/<action_name>/
```

## Start

Start from a local file:

```sh
action-harness '{
  "action": "start",
  "action_name": "run-start",
  "file": "game/index.html",
  "record": true,
  "viewport": { "width": 1024, "height": 620 },
  "videoSize": { "width": 1024, "height": 620 },
  "keyAliases": {
    "left": "a",
    "right": "d",
    "jump": "w"
  }
}'
```

Start from a URL:

```sh
action-harness '{
  "action": "start",
  "action_name": "run-start",
  "url": "http://localhost:3000",
  "record": true
}'
```

Useful `start` options:

- `url` or `file`: required target.
- `record`: enable Playwright WebM recording.
- `headless`: defaults to `true`; set `false` to watch the browser.
- `channel`: optional Playwright browser channel, such as `chrome` or `msedge`.
- `executablePath`: optional explicit browser executable path.
- `viewport`: defaults to `{ "width": 1024, "height": 620 }`.
- `videoSize`: defaults to the viewport.
- `keyAliases`: maps semantic names used in steps to real Playwright keys.
- `stateExpression`: optional JavaScript expression evaluated in the page.
- `outputRoot`: defaults to `state/output`.
- `outDir`: defaults to `recordings/action-harness-run-<timestamp>`.
- `sessionWaitMs`: overrides daemon startup wait for this start command.

## Commands

Inspect state:

```sh
action-harness '{"action":"state","action_name":"turn-001-state"}'
```

Capture a screenshot:

```sh
action-harness '{"action":"screenshot","action_name":"turn-001-screen","name":"screen"}'
```

Execute timed keyboard controls:

```sh
action-harness '{
  "action": "step",
  "action_name": "turn-002-jump-right",
  "duration": 1200,
  "commands": [
    { "from": 0, "to": 900, "key": "right" },
    { "from": 150, "to": 230, "key": "jump" }
  ],
  "captures": [1200],
  "autoCaptures": false
}'
```

Click:

```sh
action-harness '{
  "action": "step",
  "action_name": "turn-003-click-start",
  "duration": 500,
  "clicks": [
    { "at": 100, "x": 512, "y": 310 }
  ]
}'
```

Move the mouse without clicking for camera control:

```sh
action-harness '{
  "action": "step",
  "action_name": "turn-004-look-around",
  "duration": 1200,
  "view_moves": [
    { "from": 200, "to": 900, "dx": 260, "dy": -40, "steps": 16 }
  ]
}'
```

`view_moves` use relative CSS-pixel deltas. Positive `dx` moves right,
negative `dx` moves left, positive `dy` moves down, and negative `dy` moves up.
The harness also accepts `viewMoves`, `mouse_moves`, and `mouseMoves`.

Navigate or reset:

```sh
action-harness '{"action":"reset","action_name":"reset-001"}'
```

Stop and finalize the recording:

```sh
action-harness '{"action":"stop","action_name":"run-stop"}'
```

## State

Every response includes generic browser state:

- URL and title.
- Viewport dimensions.
- Active element summary.
- Pointer-lock element summary.
- Canvas positions and sizes.

For game-specific state, pass a `stateExpression` on `start` or an individual
command:

```json
{
  "stateExpression": "() => ({ score: window.score, lives: window.lives })"
}
```

If the expression throws, the response still includes generic state plus
`customError`.

## Output Layout

Each turn writes:

- `response.json`: the main CLI response.
- `*.png`: screenshots captured during that command.
- `NNN-<action_name>.json`: detailed step log for `step` actions.

The active session is tracked in `.action-harness-session.json` by default and
is removed by `stop`.
