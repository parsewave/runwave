const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { AudioRecorder } = require('./audio-recorder');
const { ensureDir, safeName, sleep, timestamp } = require('./file-utils');
const { drawGridOnScreenshot } = require('./grid-overlay');
const { parseArgList, targetUrl } = require('./protocol');
const { readPageState } = require('./state-reader');

const DEFAULT_CHROMIUM_ARGS = ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];

function chromiumArgs(config = {}, env = process.env) {
  const configured = parseArgList(config.chromiumArgs ?? env.RUNWAVE_CHROMIUM_ARGS);
  const mode = String(config.chromiumArgsMode || env.RUNWAVE_CHROMIUM_ARGS_MODE || 'append').toLowerCase();
  if (mode === 'replace') return configured;
  return [...DEFAULT_CHROMIUM_ARGS, ...configured];
}

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

class BrowserSession {
  constructor(config, paths, profiler = null) {
    this.config = config;
    this.paths = paths;
    this.profiler = profiler;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchUrl = targetUrl(config);
    this.stateExpression = config.stateExpression || null;
    this.videoDir = null;
    this.videoStartedAtMs = null;
    this.audioDir = null;
    this.audioRecorder = null;
    this.mousePosition = { x: 0, y: 0 };
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

  async start() {
    this.timeSync('browser.start.ensure_run_dir', { dir: this.paths.runDir }, () => ensureDir(this.paths.runDir));
    const recordVideo = Boolean(this.config.record || this.config.recordAudio);
    if (recordVideo) {
      this.videoDir = this.timeSync('browser.start.ensure_video_dir', () => ensureDir(path.join(this.paths.runDir, 'video')));
    }
    if (this.config.recordAudio) {
      this.audioRecorder = new AudioRecorder(this.config, this.paths.runDir, this.profiler ? this.profiler.child('audio-recorder') : null);
      this.audioDir = this.audioRecorder.audioDir;
    }

    const launchOptions = {
      headless: this.config.headless !== false,
      args: chromiumArgs(this.config),
    };
    if (this.config.channel) launchOptions.channel = String(this.config.channel);
    if (this.config.executablePath) launchOptions.executablePath = String(this.config.executablePath);

    this.browser = await this.time('browser.start.chromium_launch', {
      headless: launchOptions.headless,
      channel: launchOptions.channel,
      executablePath: launchOptions.executablePath,
    }, () => chromium.launch(launchOptions));
    this.context = await this.time('browser.start.new_context', {
      viewport: this.config.viewport || { width: 1024, height: 620 },
      record: recordVideo,
    }, () =>
      this.browser.newContext({
        viewport: this.config.viewport || { width: 1024, height: 620 },
        deviceScaleFactor: Number(this.config.deviceScaleFactor ?? 1),
        ...(recordVideo
          ? {
              recordVideo: {
                dir: this.videoDir,
                size: this.config.videoSize || this.config.viewport || { width: 1024, height: 620 },
              },
            }
          : {}),
      })
    );
    if (this.audioRecorder) {
      await this.time('browser.start.audio_recorder_start', () => this.audioRecorder.start());
    }
    this.page = await this.time('browser.start.new_page', () => this.context.newPage());
    if (recordVideo) this.videoStartedAtMs = monotonicMs();
    if (this.audioRecorder) this.audioRecorder.setVideoStartedAt(this.videoStartedAtMs);
    this.timeSync('browser.start.attach_console_logger', () => this.page.on('console', (msg) => {
      fs.appendFileSync(path.join(this.paths.runDir, 'browser-console.log'), `${msg.type()} ${msg.text()}\n`);
    }));
    await this.time('browser.start.initial_navigate', { url: this.launchUrl }, () =>
      this.navigate({ url: this.launchUrl, waitAfterLoad: this.config.waitAfterLoad })
    );
  }

  async navigate(input) {
    const url = input.url || (input.file ? targetUrl(input) : this.launchUrl);
    const waitUntil = input.waitUntil || this.config.waitUntil || 'load';
    await this.time('browser.navigate.goto', { url, waitUntil }, () => this.page.goto(url, { waitUntil }));
    const waitAfterLoad = Number(input.waitAfterLoad ?? this.config.waitAfterLoad ?? 700);
    await this.time('browser.navigate.wait_after_load', { waitAfterLoad }, () => sleep(waitAfterLoad));
  }

  async screenshot(outputDir, name) {
    const fileName = `${safeName(name || `capture-${timestamp()}`)}.png`;
    const file = path.join(outputDir, fileName);
    await this.time('browser.screenshot.capture', { file, fullPage: Boolean(this.config.fullPageScreenshots) }, () =>
      this.page.screenshot({
        path: file,
        fullPage: Boolean(this.config.fullPageScreenshots),
        scale: 'css',
      })
    );
    if (this.config.gridScreenshots !== false) {
      this.timeSync('browser.screenshot.grid_overlay', { file }, () => drawGridOnScreenshot(file, this.config));
    }
    return file;
  }

  async keyDown(key) {
    await this.time('browser.keyboard.down', { key }, () => this.page.keyboard.down(key));
  }

  async keyUp(key) {
    await this.time('browser.keyboard.up', { key }, () => this.page.keyboard.up(key));
  }

  async click(click) {
    await this.time('browser.mouse.click', {
      x: click.x,
      y: click.y,
      button: click.button,
      clickCount: click.clickCount,
    }, () =>
      this.page.mouse.click(click.x, click.y, {
        button: click.button,
        clickCount: click.clickCount,
      })
    );
    this.mousePosition = { x: click.x, y: click.y };
  }

  async moveCursor(move) {
    await this.time('browser.mouse.cursor_move', {
      x: move.to.x,
      y: move.to.y,
      steps: move.steps,
    }, () => this.page.mouse.move(move.to.x, move.to.y, { steps: move.steps }));
    this.mousePosition = { x: move.to.x, y: move.to.y };
  }

  async drag(drag) {
    if (drag.mode === 'html5') {
      await this.time('browser.drag.html5', {
        fromX: drag.from.x,
        fromY: drag.from.y,
        toX: drag.to.x,
        toY: drag.to.y,
      }, () =>
        this.page.evaluate(({ from, to }) => {
          const elementAt = (point) => document.elementFromPoint(point.x, point.y) || document.body;
          const source = elementAt(from);
          const target = elementAt(to);
          const dataTransfer = new DataTransfer();
          const eventOptions = (point) => ({
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: point.x,
            clientY: point.y,
            screenX: point.x,
            screenY: point.y,
            dataTransfer,
          });

          source.dispatchEvent(new MouseEvent('mousedown', eventOptions(from)));
          source.dispatchEvent(new DragEvent('dragstart', eventOptions(from)));
          target.dispatchEvent(new DragEvent('dragenter', eventOptions(to)));
          target.dispatchEvent(new DragEvent('dragover', eventOptions(to)));
          target.dispatchEvent(new DragEvent('drop', eventOptions(to)));
          source.dispatchEvent(new DragEvent('dragend', eventOptions(to)));
          target.dispatchEvent(new MouseEvent('mouseup', eventOptions(to)));
        }, { from: drag.from, to: drag.to })
      );
    } else {
      await this.time('browser.mouse.drag', {
        fromX: drag.from.x,
        fromY: drag.from.y,
        toX: drag.to.x,
        toY: drag.to.y,
        button: drag.button,
        steps: drag.steps,
      }, async () => {
        await this.page.mouse.move(drag.from.x, drag.from.y);
        await this.page.mouse.down({ button: drag.button });
        await this.page.mouse.move(drag.to.x, drag.to.y, { steps: drag.steps });
        await this.page.mouse.up({ button: drag.button });
      });
    }
    this.mousePosition = { x: drag.to.x, y: drag.to.y };
  }

  async moveView(move) {
    const viewport = this.page.viewportSize() || this.config.viewport || { width: 1024, height: 620 };
    const x = Math.max(0, Math.min(viewport.width - 1, this.mousePosition.x + move.dx));
    const y = Math.max(0, Math.min(viewport.height - 1, this.mousePosition.y + move.dy));
    await this.time('browser.mouse.move', { x, y, dx: move.dx, dy: move.dy }, () => this.page.mouse.move(x, y));
    await this.time('browser.mouse.dispatch_view_move_events', { x, y, dx: move.dx, dy: move.dy }, () =>
      this.page.evaluate(({ dx, dy, x, y }) => {
        const target = document.pointerLockElement || document.activeElement || document.querySelector('canvas') || document.body;
        const targets = Array.from(new Set([target, document, window].filter(Boolean)));
        const eventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          movementX: dx,
          movementY: dy,
          buttons: 0,
        };
        const defineMovement = (event) => {
          for (const [name, value] of [
            ['movementX', dx],
            ['movementY', dy],
          ]) {
            if (event[name] !== value) {
              Object.defineProperty(event, name, { value, configurable: true });
            }
          }
          return event;
        };

        for (const eventTarget of targets) {
          eventTarget.dispatchEvent(defineMovement(new MouseEvent('mousemove', eventInit)));

          if (typeof PointerEvent === 'function') {
            eventTarget.dispatchEvent(
              defineMovement(
                new PointerEvent('pointermove', {
                  ...eventInit,
                  pointerId: 1,
                  pointerType: 'mouse',
                  isPrimary: true,
                })
              )
            );
          }
        }
      }, { dx: move.dx, dy: move.dy, x, y })
    );
    this.mousePosition = { x, y };
  }

  async state(expression) {
    return this.time('browser.state.read', { customExpression: Boolean(expression || this.stateExpression) }, () =>
      readPageState(this.page, expression || this.stateExpression)
    );
  }

  async close() {
    const video = this.timeSync('browser.close.get_video_handle', () => (this.page ? this.page.video() : null));
    if (this.context) await this.time('browser.close.context_close', () => this.context.close());
    const videoPath = video ? await this.time('browser.close.video_path', () => video.path()) : null;
    let audioPath = null;
    let audioVideoPath = null;
    if (this.audioRecorder) {
      audioPath = await this.time('browser.close.audio_stop', () => this.audioRecorder.stop());
    }
    if (this.browser) await this.time('browser.close.browser_close', () => this.browser.close());
    if (this.audioRecorder) {
      audioVideoPath = await this.time('browser.close.audio_mux', () => this.audioRecorder.mux(videoPath, audioPath));
    }
    return {
      video: audioVideoPath || videoPath,
      rawVideo: audioVideoPath ? videoPath : undefined,
      audio: audioPath,
      audioVideo: audioVideoPath || undefined,
      audioVideoOffsetMs: this.audioRecorder ? this.audioRecorder.audioOffsetMs : undefined,
    };
  }
}

module.exports = {
  BrowserSession,
  chromiumArgs,
};
