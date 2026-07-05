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
- `RUNWAVE_SESSION_DIR`: directory for session JSON files. Defaults to
  `<workspace>/.runwave-sessions`.
- `RUNWAVE_SESSION_WAIT_MS`: startup wait for the daemon session file.
  Defaults to `60000`.

Each browser operation must include `action_name` and `session_id`. Use the same
`session_id` for `start`, subsequent actions, and `stop`. By default, operation
artifacts are written under:

```text
state/output/<action_name>/
```

## Start

Start from a local file:

```sh
runwave '{
  "action": "start",
  "action_name": "run-start",
  "session_id": "playtest-001",
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
  "session_id": "playtest-001",
  "url": "http://localhost:3000",
  "record": true
}'
```

Useful `start` options:

- `url` or `file`: required target.
- `session_id`: required session identifier. Reuse it for all actions targeting
  the same browser session.
- `record`: enable Playwright WebM recording.
- `recordAudio`: enable one browser audio/video recording. This implies video
  recording and writes the final WebM directly. On Linux, GStreamer captures the
  X11 viewport plus PulseAudio `default`; override sources with `videoSource`
  and `audioSource`.
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
runwave '{"action":"state","action_name":"turn-001-state","session_id":"playtest-001"}'
```

Capture a screenshot:

```sh
runwave '{"action":"screenshot","action_name":"turn-001-screen","session_id":"playtest-001","name":"screen"}'
```

Execute timed keyboard controls:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-002-jump-right",
  "session_id": "playtest-001",
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
  "session_id": "playtest-001",
  "actions": [
    { "type": "click", "start": 100, "end": 500, "x": 512, "y": 310 }
  ]
}'
```

Screenshots include an 8x8 red mark grid by default. Pointer actions may use
up to 4 grid cell IDs instead of exact pixels. Cell IDs run row-major from `0`
at the top-left to `63` at the bottom-right.

Single grid-cell click:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-003-click-start-cell",
  "session_id": "playtest-001",
  "actions": [
    { "type": "click", "start": 100, "end": 500, "cells": [27] }
  ]
}'
```

Multi-click sends quick clicks at random points inside the selected cells:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-003-multi-click",
  "session_id": "playtest-001",
  "actions": [
    { "type": "multi_click", "start": 100, "cells": [27, 28], "count": 10 }
  ]
}'
```

Drag:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-004-drag",
  "session_id": "playtest-001",
  "actions": [
    { "type": "drag", "start": 100, "end": 700, "from": { "x": 420, "y": 300 }, "to": { "x": 500, "y": 300 }, "mode": "mouse", "steps": 12 }
  ]
}'
```

Use `mode: "mouse"` for canvas and pointer-based games. Use `mode: "html5"`
for browser-native draggable/drop elements.
Drag endpoints can also use grid cells:

```json
{ "type": "drag", "start": 100, "from_cells": [34], "to_cells": [35], "mode": "mouse" }
```

Move the cursor without clicking:

```json
{ "action": "step", "action_name": "turn-005-hover", "session_id": "playtest-001", "actions": [{ "type": "cursor_move", "start": 100, "end": 500, "cells": [27] }] }
```

Move the mouse without clicking for camera control:

```sh
runwave '{
  "action": "step",
  "action_name": "turn-005-look-around",
  "session_id": "playtest-001",
  "actions": [
    { "type": "view_move", "start": 200, "end": 900, "dx": 260, "dy": -40, "steps": 16 }
  ]
}'
```

`view_move` actions use relative CSS-pixel deltas. Positive `dx` moves right,
negative `dx` moves left, positive `dy` moves down, and negative `dy` moves up.

Navigate or reset:

```sh
runwave '{"action":"reset","action_name":"reset-001","session_id":"playtest-001"}'
```

Stop and finalize the recording:

```sh
runwave '{"action":"stop","action_name":"run-stop","session_id":"playtest-001"}'
```

List known sessions:

```sh
runwave '{"action":"sessions"}'
```

When `recordAudio` is enabled, `stop` returns `video` and `audioVideo` pointing
at the same recorded audio/video WebM. The machine running runwave must have
GStreamer, an X11 video capture source, and an audio capture source. For Linux
workers, X11 display capture plus a PulseAudio monitor source such as
`runwave_sink.monitor` is the recommended setup.

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
- `video/*.webm`: final recordings. With audio enabled,
  `video/000-runwave-with-audio.webm` is recorded directly by GStreamer.

Active sessions are tracked as JSON files in `.runwave-sessions/` by default.
The matching session file is removed by `stop`.
