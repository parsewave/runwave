const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ensureDir, safeName, sleep, timestamp } = require('./file-utils');
const { drawGridOnScreenshot } = require('./grid-overlay');
const { targetUrl } = require('./protocol');
const { readPageState } = require('./state-reader');

class BrowserSession {
  constructor(config, paths) {
    this.config = config;
    this.paths = paths;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchUrl = targetUrl(config);
    this.stateExpression = config.stateExpression || null;
    this.videoDir = null;
    this.mousePosition = { x: 0, y: 0 };
  }

  async start() {
    ensureDir(this.paths.runDir);
    if (this.config.record) {
      this.videoDir = ensureDir(path.join(this.paths.runDir, 'video'));
    }

    const launchOptions = {
      headless: this.config.headless !== false,
      args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
    };
    if (this.config.channel) launchOptions.channel = String(this.config.channel);
    if (this.config.executablePath) launchOptions.executablePath = String(this.config.executablePath);

    this.browser = await chromium.launch(launchOptions);
    this.context = await this.browser.newContext({
      viewport: this.config.viewport || { width: 1024, height: 620 },
      deviceScaleFactor: Number(this.config.deviceScaleFactor ?? 1),
      ...(this.config.record
        ? {
            recordVideo: {
              dir: this.videoDir,
              size: this.config.videoSize || this.config.viewport || { width: 1024, height: 620 },
            },
          }
        : {}),
    });
    this.page = await this.context.newPage();
    this.page.on('console', (msg) => {
      fs.appendFileSync(path.join(this.paths.runDir, 'browser-console.log'), `${msg.type()} ${msg.text()}\n`);
    });
    await this.navigate({ url: this.launchUrl, waitAfterLoad: this.config.waitAfterLoad });
  }

  async navigate(input) {
    const url = input.url || (input.file ? targetUrl(input) : this.launchUrl);
    const waitUntil = input.waitUntil || this.config.waitUntil || 'load';
    await this.page.goto(url, { waitUntil });
    await sleep(Number(input.waitAfterLoad ?? this.config.waitAfterLoad ?? 700));
  }

  async screenshot(outputDir, name) {
    const fileName = `${safeName(name || `capture-${timestamp()}`)}.png`;
    const file = path.join(outputDir, fileName);
    await this.page.screenshot({
      path: file,
      fullPage: Boolean(this.config.fullPageScreenshots),
      scale: 'css',
    });
    if (this.config.gridScreenshots !== false) {
      drawGridOnScreenshot(file);
    }
    return file;
  }

  async keyDown(key) {
    await this.page.keyboard.down(key);
  }

  async keyUp(key) {
    await this.page.keyboard.up(key);
  }

  async click(click) {
    await this.page.mouse.click(click.x, click.y, {
      button: click.button,
      clickCount: click.clickCount,
    });
    this.mousePosition = { x: click.x, y: click.y };
  }

  async moveView(move) {
    const viewport = this.page.viewportSize() || this.config.viewport || { width: 1024, height: 620 };
    const x = Math.max(0, Math.min(viewport.width - 1, this.mousePosition.x + move.dx));
    const y = Math.max(0, Math.min(viewport.height - 1, this.mousePosition.y + move.dy));
    await this.page.mouse.move(x, y);
    await this.page.evaluate(({ dx, dy, x, y }) => {
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
    }, { dx: move.dx, dy: move.dy, x, y });
    this.mousePosition = { x, y };
  }

  async state(expression) {
    return readPageState(this.page, expression || this.stateExpression);
  }

  async close() {
    const video = this.page ? this.page.video() : null;
    if (this.context) await this.context.close();
    const videoPath = video ? await video.path() : null;
    if (this.browser) await this.browser.close();
    return videoPath;
  }
}

module.exports = {
  BrowserSession,
};
