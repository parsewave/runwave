# Runwave

Runwave is a reusable Playwright CLI for browser games and canvas apps.

This package is the task-neutral version of the PR145 browser runner. It only
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
RUN npm install -g https://github.com/parsewave/runwave.git
RUN npx playwright install --with-deps chromium
```

The installed CLI is:

```sh
runwave '<json>'
```

Use verbose mode to create profiling logs:

```sh
runwave -v '{"action":"start","action_name":"run-start","file":"game/index.html"}'
runwave -v '{"action":"state","action_name":"turn-001-state"}'
```

Verbose mode writes newline-delimited JSON timing events to
`<sessionDir>/runwave-verbose.ndjson` and includes that path as `verboseLog` in
verbose operation responses. The log records CLI, daemon, browser, output writing,
state, screenshot, navigation, step timeline, input-event, capture, and cleanup
timings.

## Workspace And Outputs

Relative `file`, `outputRoot`, and `outDir` paths resolve from:

1. `RUNWAVE_WORKSPACE`, when set.
2. The current working directory.

Useful environment variables:

- `RUNWAVE_WORKSPACE`: base directory for relative paths.
- `RUNWAVE_SESSION_FILE`: active session JSON path. Defaults to
  `<workspace>/.runwave-session.json`.
- `RUNWAVE_SESSION_WAIT_MS`: startup wait for the daemon session file.
  Defaults to `60000`.

Each operation must include `action_name`. By default, operation artifacts are
written under:

```text
state/output/<action_name>/
```

## Start

Start from a local file:

```sh
runwave '{
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
runwave '{
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
- `outDir`: defaults to `recordings/runwave-run-<timestamp>`.
- `sessionWaitMs`: overrides daemon startup wait for this start operation.

## Sequences And Actions

Inspect state:

```sh
runwave '{"action":"state","action_name":"turn-001-state"}'
```

Capture a screenshot:

```sh
runwave '{"action":"screenshot","action_name":"turn-001-screen","name":"screen"}'
```

Execute timed keyboard controls:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-002-jump-right",
  "actions": [
    { "type": "key", "start": 0, "end": 900, "key": "right" },
    { "type": "key", "start": 150, "end": 230, "key": "jump" }
  ],
  "captures": [900],
  "autoCaptures": false
}'
```

For `step`, the payload is a sequence. The sequence duration is inferred from
the latest action `end`, or from `start` for instant actions.

Click:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-003-click-start",
  "actions": [
    { "type": "click", "start": 100, "end": 150, "x": 512, "y": 310 }
  ]
}'
```

Screenshots include a 12x12 red mark grid by default. Each cell is labeled with
a number in the center, starting at 0 in the top-left and increasing row-major
to 143 in the bottom-right. Pointer actions may use these numbered cells instead
of exact pixels. Raw `x`/`y` coordinates are still supported and refer to the
browser viewport.

Single grid-cell click:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-003-click-start-cell",
  "actions": [
    { "type": "click", "start": 100, "cell": 78 }
  ]
}'
```

Multi-click sends quick clicks at random points inside the selected cells:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-003-multi-click",
  "actions": [
    { "type": "multi_click", "start": 100, "cells": [78, 79], "count": 10 }
  ]
}'
```

Drag:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-004-drag",
  "actions": [
    { "type": "drag", "start": 100, "end": 700, "from": { "x": 420, "y": 300 }, "to": { "x": 500, "y": 300 }, "mode": "mouse", "steps": 12 }
  ]
}'
```

Use `mode: "mouse"` for canvas and pointer-based games. Use `mode: "html5"`
for browser-native draggable/drop elements.
Drag endpoints can also use grid cells:

```json
{ "type": "drag", "start": 100, "from_cells": [78], "to_cells": [79], "mode": "mouse" }
```

Move the cursor without clicking:

```json
{ "action": "step", "action_name": "turn-005-hover", "actions": [{ "type": "cursor_move", "start": 100, "end": 150, "cell": 66 }] }
```

Move the mouse without clicking for camera control:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-005-look-around",
  "actions": [
    { "type": "view_move", "start": 200, "end": 900, "dx": 260, "dy": -40, "steps": 16 }
  ]
}'
```

`view_move` actions use relative CSS-pixel deltas. Positive `dx` moves right,
negative `dx` moves left, positive `dy` moves down, and negative `dy` moves up.

Navigate or reset:

```sh
runwave '{"action":"reset","action_name":"reset-001"}'
```

Stop and finalize the recording:

```sh
runwave '{"action":"stop","action_name":"run-stop"}'
```

## State

Every response includes generic browser state:

- URL and title.
- Viewport dimensions.
- Active element summary.
- Pointer-lock element summary.
- Canvas positions and sizes.

For game-specific state, pass a `stateExpression` on `start` or an individual
operation:

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
- `*.png`: screenshots captured during that operation.
- `NNN-<action_name>.json`: detailed sequence log for `step` operations.

The active session is tracked in `.runwave-session.json` by default and
is removed by `stop`.
