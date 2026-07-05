const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { AudioVideoRecorder } = require('./audio-recorder');
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

function videoSize(config = {}) {
  const size = config.videoSize || config.viewport || {};
  const width = Number(size.width);
  const height = Number(size.height);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 1024,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 620,
  };
}

function isRecording(config = {}) {
  return Boolean(config.record || config.recordAudio);
}

function chromiumLaunchArgs(config = {}, env = process.env) {
  const args = chromiumArgs(config, env);
  if (!isRecording(config)) return args;
  const size = videoSize(config);
  return [
    ...args,
    '--window-position=0,0',
    `--window-size=${size.width},${size.height}`,
    '--kiosk',
    '--start-fullscreen',
    '--disable-infobars',
  ];
}

function browserViewportStabilizerScript() {
  const installStyle = () => {
    if (!document.documentElement) return;
    let style = document.getElementById('__runwave_capture_viewport_stabilizer__');
    if (!style) {
      style = document.createElement('style');
      style.id = '__runwave_capture_viewport_stabilizer__';
      style.textContent = 'html,body{overflow:hidden!important;}';
      document.documentElement.appendChild(style);
    }
    window.scrollTo(0, 0);
  };

  const scrollingKeys = new Set([
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'End',
    'Home',
    'PageDown',
    'PageUp',
    ' ',
    'Space',
  ]);

  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const tagName = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target?.isContentEditable) return;
    if (scrollingKeys.has(event.key) || scrollingKeys.has(event.code)) event.preventDefault();
  }, true);

  window.addEventListener('scroll', () => window.scrollTo(0, 0), true);
  installStyle();
  document.addEventListener('DOMContentLoaded', installStyle, { once: true });
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
    this.audioDir = undefined;
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
    const record = isRecording(this.config);
    if (record) {
      this.videoDir = this.timeSync('browser.start.ensure_video_dir', () => ensureDir(path.join(this.paths.runDir, 'video')));
      this.audioRecorder = new AudioVideoRecorder(
        this.config,
        this.paths.runDir,
        this.profiler ? this.profiler.child('audio-video-recorder') : null
      );
    }

    const launchOptions = {
      headless: this.config.headless !== false,
      args: chromiumLaunchArgs(this.config),
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
      record,
    }, () =>
      this.browser.newContext({
        viewport: this.config.viewport || { width: 1024, height: 620 },
        deviceScaleFactor: Number(this.config.deviceScaleFactor ?? 1),
      })
    );
    if (record) {
      await this.time('browser.start.capture_viewport_stabilizer', () =>
        this.context.addInitScript(browserViewportStabilizerScript)
      );
    }
    this.page = await this.time('browser.start.new_page', () => this.context.newPage());
    if (this.audioRecorder) {
      await this.time('browser.start.audio_video_recorder_start', () => this.audioRecorder.start());
    }
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
    const holdMs = Math.max(0, Number(click.end ?? click.start) - Number(click.start ?? 0));
    const clickCount = Math.max(1, Math.round(Number(click.clickCount || 1)));
    await this.time('browser.mouse.click', {
      x: click.x,
      y: click.y,
      button: click.button,
      clickCount,
      holdMs,
    }, async () => {
      await this.page.mouse.move(click.x, click.y);
      for (let index = 0; index < clickCount; index += 1) {
        const eventClickCount = index + 1;
        await this.page.mouse.down({ button: click.button, clickCount: eventClickCount });
        if (holdMs > 0) await sleep(holdMs);
        await this.page.mouse.up({ button: click.button, clickCount: eventClickCount });
      }
    });
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
    let audioVideoPath = null;
    if (this.audioRecorder) {
      audioVideoPath = await this.time('browser.close.audio_video_stop', () => this.audioRecorder.stop());
    }
    if (this.context) await this.time('browser.close.context_close', () => this.context.close());
    if (this.browser) await this.time('browser.close.browser_close', () => this.browser.close());
    return {
      video: audioVideoPath,
      audioVideo: audioVideoPath || undefined,
    };
  }
}

module.exports = {
  BrowserSession,
  browserViewportStabilizerScript,
  chromiumArgs,
  chromiumLaunchArgs,
};
