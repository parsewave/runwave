const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { AudioVideoRecorder, defaultVideoSource, parseX11VideoSource } = require('./audio-recorder');
const { ensureDir, safeName, sleep, timestamp } = require('./file-utils');
const { drawGridOnScreenshot } = require('./grid-overlay');
const { parseArgList } = require('./protocol');

const DEFAULT_WINDOW_WAIT_MS = 15000;
const DEFAULT_TOOL_TIMEOUT_MS = 5000;
const DEFAULT_VIEWPORT = { width: 1024, height: 620 };

function normalizedViewport(config = {}) {
  const size = config.viewport || config.videoSize || {};
  const width = Number(size.width);
  const height = Number(size.height);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_VIEWPORT.width,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_VIEWPORT.height,
  };
}

function linuxLaunchConfig(config = {}) {
  const launch = config.launch && typeof config.launch === 'object' ? config.launch : {};
  return {
    command: config.command || config.launchCommand || launch.command || null,
    args: parseArgList(config.args ?? config.launchArgs ?? launch.args),
    cwd: config.cwd || config.launchCwd || launch.cwd || process.cwd(),
    env: launch.env || config.env || null,
    windowId: config.windowId || config.window_id || null,
    windowTitle: config.windowTitle || config.window_title || null,
    windowClass: config.windowClass || config.window_class || null,
    windowWaitMs: Number(config.windowWaitMs ?? config.window_wait_ms ?? DEFAULT_WINDOW_WAIT_MS),
    resizeWindow: config.resizeWindow !== false,
  };
}

function commandFailure(command, args, result) {
  const stderr = result.stderr ? String(result.stderr).trim() : '';
  const stdout = result.stdout ? String(result.stdout).trim() : '';
  const reason = result.error ? result.error.message : `exit ${result.status}`;
  const detail = [stderr, stdout].filter(Boolean).join('\n').slice(0, 1000);
  return new Error(`${command} ${args.join(' ')} failed: ${reason}${detail ? `: ${detail}` : ''}`);
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args.map(String), {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: Number(options.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw commandFailure(command, args, result);
  return result.stdout || '';
}

function parseWindowIds(stdout) {
  return String(stdout || '')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => /^\d+$/.test(part));
}

function parseWindowGeometry(stdout) {
  const out = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(-?\d+)$/.exec(line.trim());
    if (match) out[match[1].toLowerCase()] = Number(match[2]);
  }
  const id = out.window;
  const x = out.x;
  const y = out.y;
  const width = out.width;
  const height = out.height;
  if (![id, x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error(`could not parse X11 window geometry: ${String(stdout || '').slice(0, 200)}`);
  }
  return { id: String(id), x, y, width, height };
}

function buttonToXdotool(button) {
  const text = String(button || 'left').toLowerCase();
  if (text === 'left' || text === '1') return '1';
  if (text === 'middle' || text === '2') return '2';
  if (text === 'right' || text === '3') return '3';
  throw new Error(`unsupported mouse button for linux target: ${button}`);
}

function keyToXdotool(key) {
  const text = String(key || '').trim();
  const aliases = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Space: 'space',
    Enter: 'Return',
    Escape: 'Escape',
    Backspace: 'BackSpace',
    Delete: 'Delete',
    Tab: 'Tab',
    Shift: 'Shift_L',
    Control: 'Control_L',
    Ctrl: 'Control_L',
    Alt: 'Alt_L',
    Meta: 'Super_L',
    PageUp: 'Page_Up',
    PageDown: 'Page_Down',
    Home: 'Home',
    End: 'End',
  };
  if (aliases[text]) return aliases[text];
  const keyMatch = /^Key([A-Z])$/.exec(text);
  if (keyMatch) return keyMatch[1].toLowerCase();
  const digitMatch = /^Digit([0-9])$/.exec(text);
  if (digitMatch) return digitMatch[1];
  const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(text);
  if (functionMatch) return text;
  if (text.length === 1) return text;
  return text;
}

function gstScreenshotArgs(config, outputPath, geometry, env = process.env) {
  const source = parseX11VideoSource(config.videoSource || defaultVideoSource(process.platform, env), env);
  const x = Number.isFinite(Number(geometry && geometry.x)) ? Number(geometry.x) : source.x;
  const y = Number.isFinite(Number(geometry && geometry.y)) ? Number(geometry.y) : source.y;
  const size = normalizedViewport({ viewport: geometry || config.viewport || config.videoSize });
  return [
    '-q',
    'ximagesrc',
    `display-name=${source.displayName}`,
    `startx=${x}`,
    `starty=${y}`,
    `endx=${x + size.width - 1}`,
    `endy=${y + size.height - 1}`,
    'use-damage=false',
    'show-pointer=false',
    'num-buffers=1',
    '!',
    `video/x-raw,width=${size.width},height=${size.height},framerate=1/1`,
    '!',
    'videoconvert',
    '!',
    'pngenc',
    '!',
    'filesink',
    `location=${outputPath}`,
  ];
}

function processHasClosed(child) {
  return Boolean(child && (child.exitCode !== null || child.signalCode !== null));
}

function signalProcessGroup(child, signal) {
  if (!child || !child.pid) return false;
  const target = process.platform === 'win32' ? child.pid : -child.pid;
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessClose(child, timeoutMs) {
  if (!child || processHasClosed(child)) return true;
  return new Promise((resolve) => {
    let timer = null;
    const onClose = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
    timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(processHasClosed(child));
    }, Math.max(0, timeoutMs));
  });
}

class LinuxSession {
  constructor(config, paths, profiler = null) {
    this.config = config;
    this.paths = paths;
    this.profiler = profiler;
    this.launch = linuxLaunchConfig(config);
    this.process = null;
    this.windowId = this.launch.windowId ? String(this.launch.windowId) : null;
    this.geometry = null;
    this.videoDir = null;
    this.audioDir = undefined;
    this.audioRecorder = null;
    this.processError = null;
    this.mousePosition = { x: 0, y: 0 };
    this.launchUrl = null;
  }

  timeSync(event, fields, fn) {
    if (this.profiler) return this.profiler.timeSync(event, fields, fn);
    if (typeof fields === 'function') return fields();
    return fn();
  }

  async time(event, fields, fn) {
    if (this.profiler) return this.profiler.time(event, fields, fn);
    if (typeof fields === 'function') return fields();
    return fn();
  }

  xdotool(args, options = {}) {
    return runCommand('xdotool', args, {
      env: process.env,
      cwd: this.launch.cwd,
      timeoutMs: options.timeoutMs,
    });
  }

  startProcess() {
    if (!this.launch.command) return null;
    const stdout = fs.openSync(path.join(this.paths.runDir, 'linux-game.stdout.log'), 'a');
    const stderr = fs.openSync(path.join(this.paths.runDir, 'linux-game.stderr.log'), 'a');
    this.process = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: { ...process.env, ...(this.launch.env || {}) },
      detached: true,
      stdio: ['ignore', stdout, stderr],
    });
    const closeLogs = () => {
      try { fs.closeSync(stdout); } catch {}
      try { fs.closeSync(stderr); } catch {}
    };
    this.process.on('error', (error) => {
      this.processError = error;
      closeLogs();
    });
    this.process.on('close', closeLogs);
    return this.process;
  }

  candidateWindows() {
    const candidates = [];
    const add = (stdout) => {
      for (const id of parseWindowIds(stdout)) {
        if (!candidates.includes(id)) candidates.push(id);
      }
    };
    const addId = (id) => {
      const text = String(id || '').trim();
      if (text && !candidates.includes(text)) candidates.push(text);
    };
    const tryAdd = (fn) => {
      try {
        add(fn());
      } catch {
        // A search with no matches exits non-zero; the wait loop will retry.
      }
    };

    const hasExplicitSelector = Boolean(this.windowId || this.launch.windowTitle || this.launch.windowClass);
    if (this.windowId) addId(this.windowId);
    if (this.launch.windowTitle) {
      tryAdd(() => this.xdotool(['search', '--onlyvisible', '--name', this.launch.windowTitle]));
    }
    if (this.launch.windowClass) {
      tryAdd(() => this.xdotool(['search', '--onlyvisible', '--class', this.launch.windowClass]));
    }
    if (this.process && this.process.pid) {
      tryAdd(() => this.xdotool(['search', '--onlyvisible', '--pid', String(this.process.pid)]));
    }
    if (!candidates.length && !hasExplicitSelector) {
      add(this.xdotool(['search', '--onlyvisible', '--name', '.']));
    }
    return candidates;
  }

  windowGeometry(windowId) {
    return parseWindowGeometry(this.xdotool(['getwindowgeometry', '--shell', windowId]));
  }

  chooseWindow() {
    const candidates = this.candidateWindows();
    let best = null;
    for (const id of candidates) {
      try {
        const geometry = this.windowGeometry(id);
        if (geometry.width < 50 || geometry.height < 50) continue;
        if (!best || geometry.width * geometry.height > best.width * best.height) best = geometry;
      } catch {
        // Ignore stale or non-window ids returned by xdotool.
      }
    }
    if (!best) throw new Error('no visible Linux game window found');
    return best;
  }

  async waitForWindow() {
    const waitMs = Number.isFinite(this.launch.windowWaitMs) && this.launch.windowWaitMs > 0
      ? this.launch.windowWaitMs
      : DEFAULT_WINDOW_WAIT_MS;
    const startedAt = Date.now();
    let lastError = null;
    let processExitedBeforeWindow = false;
    while (Date.now() - startedAt < waitMs) {
      if (this.processError) throw new Error(`Linux game process failed to start: ${this.processError.message}`);
      if (this.process && processHasClosed(this.process)) processExitedBeforeWindow = true;
      try {
        return this.chooseWindow();
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    const processHint = processExitedBeforeWindow ? '; launch process exited while waiting' : '';
    throw new Error(`timed out waiting for Linux game window${processHint}${lastError ? `: ${lastError.message}` : ''}`);
  }

  focusWindow() {
    if (!this.windowId) return;
    try {
      this.xdotool(['windowactivate', '--sync', this.windowId], { timeoutMs: 2000 });
    } catch {
      this.xdotool(['windowfocus', this.windowId], { timeoutMs: 2000 });
    }
  }

  resizeWindow() {
    if (!this.windowId || this.launch.resizeWindow === false) return;
    const viewport = normalizedViewport(this.config);
    try { this.xdotool(['windowmove', this.windowId, '0', '0']); } catch {}
    try { this.xdotool(['windowsize', this.windowId, String(viewport.width), String(viewport.height)]); } catch {}
  }

  async start() {
    this.timeSync('linux.start.ensure_run_dir', { dir: this.paths.runDir }, () => ensureDir(this.paths.runDir));
    this.timeSync('linux.start.launch_process', () => this.startProcess());
    this.geometry = await this.time('linux.start.wait_for_window', () => this.waitForWindow());
    this.windowId = this.geometry.id;
    this.timeSync('linux.start.resize_window', () => this.resizeWindow());
    this.timeSync('linux.start.focus_window', () => this.focusWindow());
    this.geometry = this.timeSync('linux.start.geometry_after_focus', () => this.windowGeometry(this.windowId));
    this.config.viewport = { width: this.geometry.width, height: this.geometry.height };
    this.config.videoSize = { width: this.geometry.width, height: this.geometry.height };

    if (this.config.record || this.config.recordAudio) {
      this.videoDir = this.timeSync('linux.start.ensure_video_dir', () => ensureDir(path.join(this.paths.runDir, 'video')));
      const display = process.env.DISPLAY || ':0';
      this.audioRecorder = new AudioVideoRecorder(
        {
          ...this.config,
          videoSource: this.config.videoSource || `${display}+${this.geometry.x},${this.geometry.y}`,
          videoSize: { width: this.geometry.width, height: this.geometry.height },
        },
        this.paths.runDir,
        this.profiler ? this.profiler.child('audio-video-recorder') : null
      );
      await this.time('linux.start.audio_video_recorder_start', () => this.audioRecorder.start());
    }
  }

  async navigate() {
    throw new Error('navigate/reset is not supported for linux sessions; stop and start a new session instead');
  }

  screenPoint(point) {
    const geometry = this.geometry || { x: 0, y: 0 };
    return {
      x: Math.round(geometry.x + Number(point.x || 0)),
      y: Math.round(geometry.y + Number(point.y || 0)),
    };
  }

  async screenshot(outputDir, name) {
    const fileName = `${safeName(name || `capture-${timestamp()}`)}.png`;
    const file = path.join(outputDir, fileName);
    ensureDir(outputDir);
    this.geometry = this.timeSync('linux.screenshot.geometry', () => this.windowGeometry(this.windowId));
    const args = gstScreenshotArgs(
      { ...this.config, videoSource: `${process.env.DISPLAY || ':0'}+${this.geometry.x},${this.geometry.y}` },
      file,
      this.geometry,
      process.env
    );
    this.timeSync('linux.screenshot.capture', { file }, () =>
      runCommand(this.config.gstreamerPath || process.env.RUNWAVE_GSTREAMER || 'gst-launch-1.0', args, { timeoutMs: 10000 })
    );
    if (this.config.gridScreenshots !== false) {
      this.timeSync('linux.screenshot.grid_overlay', { file }, () => drawGridOnScreenshot(file, this.config));
    }
    return file;
  }

  async keyDown(key) {
    const mapped = keyToXdotool(key);
    await this.time('linux.keyboard.down', { key, mapped }, async () => {
      this.focusWindow();
      this.xdotool(['keydown', mapped]);
    });
  }

  async keyUp(key) {
    const mapped = keyToXdotool(key);
    await this.time('linux.keyboard.up', { key, mapped }, async () => {
      this.focusWindow();
      this.xdotool(['keyup', mapped]);
    });
  }

  async click(click) {
    const holdMs = Math.max(0, Number(click.end ?? click.start) - Number(click.start ?? 0));
    const clickCount = Math.max(1, Math.round(Number(click.clickCount || 1)));
    const button = buttonToXdotool(click.button);
    const point = this.screenPoint(click);
    await this.time('linux.mouse.click', {
      x: click.x,
      y: click.y,
      screenX: point.x,
      screenY: point.y,
      button,
      clickCount,
      holdMs,
    }, async () => {
      this.focusWindow();
      this.xdotool(['mousemove', String(point.x), String(point.y)]);
      for (let index = 0; index < clickCount; index += 1) {
        this.xdotool(['mousedown', button]);
        if (holdMs > 0) await sleep(holdMs);
        this.xdotool(['mouseup', button]);
      }
    });
    this.mousePosition = { x: click.x, y: click.y };
  }

  async moveCursor(move) {
    const point = this.screenPoint(move.to);
    await this.time('linux.mouse.cursor_move', {
      x: move.to.x,
      y: move.to.y,
      screenX: point.x,
      screenY: point.y,
      steps: move.steps,
    }, async () => {
      this.focusWindow();
      this.xdotool(['mousemove', String(point.x), String(point.y)]);
    });
    this.mousePosition = { x: move.to.x, y: move.to.y };
  }

  async drag(drag) {
    const from = this.screenPoint(drag.from);
    const to = this.screenPoint(drag.to);
    const button = buttonToXdotool(drag.button);
    await this.time('linux.mouse.drag', {
      fromX: drag.from.x,
      fromY: drag.from.y,
      toX: drag.to.x,
      toY: drag.to.y,
      mode: drag.mode,
      button,
      steps: drag.steps,
    }, async () => {
      this.focusWindow();
      this.xdotool(['mousemove', String(from.x), String(from.y)]);
      this.xdotool(['mousedown', button]);
      this.xdotool(['mousemove', '--sync', String(to.x), String(to.y)]);
      this.xdotool(['mouseup', button]);
    });
    this.mousePosition = { x: drag.to.x, y: drag.to.y };
  }

  async moveView(move) {
    await this.time('linux.mouse.view_move', {
      dx: move.dx,
      dy: move.dy,
      steps: move.steps,
    }, async () => {
      this.focusWindow();
      this.xdotool(['mousemove_relative', '--sync', '--', String(Math.round(move.dx)), String(Math.round(move.dy))]);
    });
    const viewport = normalizedViewport(this.config);
    this.mousePosition = {
      x: Math.max(0, Math.min(viewport.width - 1, this.mousePosition.x + move.dx)),
      y: Math.max(0, Math.min(viewport.height - 1, this.mousePosition.y + move.dy)),
    };
  }

  async state() {
    let geometry = this.geometry;
    if (this.windowId) {
      try {
        geometry = this.timeSync('linux.state.geometry', () => this.windowGeometry(this.windowId));
        this.geometry = geometry;
      } catch {}
    }
    return {
      targetKind: 'linux',
      display: process.env.DISPLAY || null,
      viewport: geometry
        ? { width: geometry.width, height: geometry.height }
        : normalizedViewport(this.config),
      window: geometry
        ? {
            id: geometry.id,
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
          }
        : null,
      process: this.process
        ? {
            pid: this.process.pid,
            running: !processHasClosed(this.process),
          }
        : null,
    };
  }

  async close() {
    let audioVideoPath = null;
    if (this.audioRecorder) {
      audioVideoPath = await this.time('linux.close.audio_video_stop', () => this.audioRecorder.stop());
    }
    if (this.process && !processHasClosed(this.process)) {
      await this.time('linux.close.terminate_process', async () => {
        signalProcessGroup(this.process, 'SIGTERM');
        if (!(await waitForProcessClose(this.process, 5000))) {
          signalProcessGroup(this.process, 'SIGKILL');
          await waitForProcessClose(this.process, 5000);
        }
      });
    } else if (this.windowId) {
      try {
        this.timeSync('linux.close.window_close', () => this.xdotool(['windowclose', this.windowId], { timeoutMs: 1000 }));
      } catch {}
    }
    return {
      video: audioVideoPath,
      audioVideo: audioVideoPath || undefined,
    };
  }
}

module.exports = {
  LinuxSession,
  buttonToXdotool,
  gstScreenshotArgs,
  keyToXdotool,
  linuxLaunchConfig,
  normalizedViewport,
  parseWindowGeometry,
  parseWindowIds,
};
