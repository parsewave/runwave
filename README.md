# Runwave

Runwave is an agentic harness which allows a VLM to play video games

![](/assets/architecture.png)

It includes remote stress testing code (`./stress-test`) as a first class component to prevent regression and enable quick development cycles. It can scale horizontally to play hundreds of games at once.

![Runwave playing 12 games](/assets/12-games.gif)

## Requirements

Runwave's recording pipeline is **gstreamer-only** as other methods lead to audio/video mismatches. This entails:

- **Linux.** gstreamer's `ximagesrc` and `pulsesrc` elements only work on Linux.
- **gstreamer 1.x** with `ximagesrc`, `pulsesrc`, `vp8enc`, `opusenc`,
  `webmmux`, and `filesink` available on `PATH` as `gst-launch-1.0` (override
  via the `RUNWAVE_GSTREAMER` env var or the `gstreamerPath` start option).
- **An X server or Xvfb.** `DISPLAY` must be set to a display that Chromium
  can render into and that `ximagesrc` can read.
- **PulseAudio running.** `pactl info` must succeed. Chromium's audio must be
  routed to a sink whose `.monitor` source is captured by `pulsesrc`. On
  headless servers, load a null-sink (e.g. `runwave_sink`) and set
  `PULSE_SINK` before starting Chromium; pass `audioSource: "runwave_sink.monitor"`
  (or `RUNWAVE_AUDIO_SOURCE`) to the start action.

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
    pulseaudio xvfb
RUN npm install -g https://github.com/parsewave/runwave.git
RUN npx playwright install --with-deps chromium
```

The public CLI runs an end-to-end playtest:

```sh
runwave --game-dir ./game --out-dir ./artifacts --port 3000 --viewport 1280x720
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
