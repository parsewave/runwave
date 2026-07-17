# Runwave

Runwave is an agentic harness which allows a VLM to play video games

![](/assets/architecture.png)

It includes remote stress testing code (`./stress-test`) as a first class component to prevent regression and enable quick development cycles. It can scale horizontally to play hundreds of games at once.

![Runwave playing 12 games](/assets/12-games.gif)

Runwave supports two target types:

- browser games served to Chromium
- native Linux games that open an X11 window

## Limitations

Runwave is still best suited to games that:

- can run in a browser or in a normal Linux/X11 window
- can run on the available server graphics stack
- do not involve a lot of precise clicks
- do not require reaction speeds of < 2 seconds

Currently the agent can only use openrouter as its model provider.

## Requirements

Runwave's recording pipeline is **gstreamer-only** as other methods lead to audio/video mismatches. This entails:

- **Linux.** gstreamer's `ximagesrc` and `pulsesrc` elements only work on Linux.
- **gstreamer 1.x** with `ximagesrc`, `pulsesrc`, `vp8enc`, `opusenc`,
  `webmmux`, and `filesink` available on `PATH` as `gst-launch-1.0` (override
  via the `RUNWAVE_GSTREAMER` env var or the `gstreamerPath` start option).
- **An X server or Xvfb.** `DISPLAY` must be set to a display that Chromium
  or a native Linux game can render into and that `ximagesrc` can read.
- **PulseAudio running.** `pactl info` must succeed. Chromium's audio must be
  routed to a sink whose `.monitor` source is captured by `pulsesrc`. On
  headless servers, load a null-sink (e.g. `runwave_sink`) and set
  `PULSE_SINK` before starting Chromium; pass `audioSource: "runwave_sink.monitor"`
  (or `RUNWAVE_AUDIO_SOURCE`) to the start action.
- **`xdotool` for native Linux games.** Runwave uses it to find/focus the game
  window and send keyboard/mouse input.

The controller checks these prerequisites before spawning gstreamer and fails
fast with a message naming the missing piece.


## Install

From a local checkout:

```sh
npm install
npm test
```

From a private GitHub repo in a task Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y \
    gstreamer1.0-tools gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly gstreamer1.0-x gstreamer1.0-pulseaudio \
    pulseaudio xvfb xdotool
RUN npm install -g https://github.com/parsewave/runwave.git
RUN npx playwright install --with-deps chromium
```

The public CLI runs an end-to-end playtest:

```sh
runwave --game-dir ./game --out-dir ./artifacts --port 3000 --viewport 1280x720
```

For a native Linux game, put a `start.sh` beside `playtest.md`. The script
should launch the game in the current X11 display and keep running until the
game exits. `--port` is not used:

```sh
runwave --kind linux --game-dir ./linux-game --out-dir ./artifacts --viewport 1280x720
```

For Linux targets, `--viewport` is the virtual display capture size. Runwave
records and screenshots that full display area, then focuses the detected game
window for input. The game window may be smaller than the display; it should not
be larger than the display or important UI may be cropped. Runwave also moves
and resizes the detected window toward the capture area when the game allows it.
`start.sh` receives `RUNWAVE_VIEWPORT_WIDTH` and `RUNWAVE_VIEWPORT_HEIGHT` so
wrappers can pass engine-specific size flags without hardcoding dimensions.

If the server has multiple visible windows, pass a selector:

```sh
runwave --kind linux --game-dir ./linux-game --out-dir ./artifacts \
  --viewport 1280x720 --window-title "A Date with Death"
```

The package also includes a low-level controller CLI for direct browser actions:

```sh
runwave-controller '<json>'
```

Detailed controller action docs are in [runwave/controller/README.md](runwave/controller/README.md).

Use controller verbose mode to create profiling logs:

```sh
runwave-controller -v '{"action":"start","action_name":"run-start","file":"game/index.html"}'
runwave-controller -v '{"action":"state","action_name":"turn-001-state"}'
```

Controller verbose mode writes newline-delimited JSON timing events to
`<sessionDir>/runwave-verbose.ndjson` and includes that path as `verboseLog` in
verbose operation responses. The log records CLI, daemon, browser, output writing,
state, screenshot, navigation, step timeline, input-event, capture, and cleanup
timings.


## Test Locally

A good first step is to run a single playtest using the example game. This will create a local recording. See the skill `skills/runwave-local-stress-test` for more details.
