'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { BrowserSession, chromiumArgs, browserPointerLockCompatibilityScript } = require('./browser-session');
const { ProcessPause } = require('./process-pause');
const { installActiveClock } = require('./active-clock');
const { ActionRecorder } = require('./action-recorder');
const { withDeadline } = require('./deadline');
const { drawGridOnScreenshot } = require('./grid-overlay');
const { ensureDir, safeName, sleep } = require('./file-utils');

class SteppedBrowserSession extends BrowserSession {
  constructor(config, paths, profiler) {
    super(config, paths, profiler);
    this.stepped = true;
    this.gate = null;
    this.cached = null;
    this.recorder = null;
    this.fault = null;
    this.closing = false;
    this.startedAt = performance.now();
    this.gameplayTimeMs = 0;
    this.activeWallTimeMs = 0;
    this.steps = 0;
    this.settleMs = config.postActionSettleMs ?? 50;
    if (!Number.isFinite(this.settleMs) || this.settleMs < 0 || this.settleMs > 2000) {
      throw new Error('postActionSettleMs must be between 0 and 2000');
    }
  }

  async start() {
    if (process.platform === 'win32') throw new Error('stepped browser mode requires Linux or macOS process signals');
    ensureDir(this.paths.runDir);
    try {
      await this.startGameProcess();
      this.browserServer = await chromium.launchServer({
        headless: this.config.headless !== false,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: chromiumArgs(this.config),
        ...(this.config.channel ? { channel: this.config.channel } : {}),
        ...(this.config.executablePath ? { executablePath: this.config.executablePath } : {}),
      });
      this.gate = new ProcessPause(this.browserServer.process());
      await this.gate.tree();
      this.browser = await chromium.connect(this.browserServer.wsEndpoint());
      this.context = await this.browser.newContext({
        viewport: this.config.viewport || { width: 1280, height: 720 }, deviceScaleFactor: 1,
      });
      this.context.setDefaultTimeout(10000);
      await this.context.addInitScript(installActiveClock);
      if (this.config.pointerLockCompatibility || process.env.RUNWAVE_POINTER_LOCK_COMPAT === '1') {
        await this.context.addInitScript(browserPointerLockCompatibilityScript);
      }
      this.page = await this.context.newPage();
      this.page.on('console', (message) => fs.appendFileSync(path.join(this.paths.runDir, 'browser-console.log'), `${message.type()} ${message.text()}\n`));
      this.cdp = await this.context.newCDPSession(this.page);
      await super.navigate({ url: this.launchUrl });
      if (this.config.readySelector) await this.page.locator(this.config.readySelector).first().waitFor({ timeout: this.config.readyTimeoutMs || 120000 });
      if (this.config.readyCheckScript) await this.page.waitForFunction(this.config.readyCheckScript, null, { timeout: this.config.readyTimeoutMs || 120000 });
      await sleep(this.config.readySettleMs ?? 0);
      if (this.config.record || this.config.recordAudio) {
        if (this.config.recordAudio) throw new Error('stepped recording is video-only; use realtime mode for audio');
        this.recorder = new ActionRecorder(this.cdp, this.paths.runDir, this.config);
        await this.recorder.start();
        this.videoDir = this.recorder.directory;
      }
      await this.freezeWithDeadline('initial observation');
      this.startedAt = performance.now();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  timing() {
    const wallElapsedMs = performance.now() - this.startedAt;
    return {
      mode: 'stepped', paused: Boolean(this.gate?.paused), steps: this.steps,
      gameplayTimeMs: this.gameplayTimeMs, activeWallTimeMs: this.activeWallTimeMs,
      wallElapsedMs, thinkingTimeMs: Math.max(0, wallElapsedMs - this.activeWallTimeMs),
      timebase: 'requested_action_ms', postActionSettleMs: this.settleMs,
      ...(this.fault ? { fault: this.fault.message } : {}),
    };
  }

  async pageClock(method) {
    for (const frame of this.page.frames()) {
      await frame.evaluate((method) => {
        if (!window.__runwaveActiveClock) throw new Error('active clock was not installed');
        window.__runwaveActiveClock[method]();
      }, method);
    }
  }

  async freeze() {
    try {
      await this.pageClock('pause');
      const state = await super.state();
      if (this.config.canvasSelector) {
        state.canvas = await this.page.locator(this.config.canvasSelector).first().boundingBox();
      }
      state.publicControls = this.config.publicControls || [];
      const screenshot = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const replay = this.recorder ? await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: false }) : null;
      this.cached = { state, png: Buffer.from(screenshot.data, 'base64'), jpeg: replay ? Buffer.from(replay.data, 'base64') : null };
    } finally {
      if (!this.closing) await this.gate.pause();
    }
  }

  async freezeWithDeadline(label) {
    try {
      return await withDeadline(() => this.freeze(), 15000, label);
    } catch (error) {
      // The timed operation cannot be cancelled. Stop the browser process
      // group before returning so it cannot continue acting after failure.
      try { this.gate?.forcePause(); } catch (pauseError) { error.pauseError = pauseError; }
      this.fault ||= error;
      throw error;
    }
  }

  async state(expression) {
    if (this.gate?.paused) {
      await this.gate.assertPaused();
      if (expression) throw new Error('custom state expressions are unavailable at frozen observations');
      return { ...this.cached?.state, timing: this.timing() };
    }
    return super.state(expression);
  }

  async screenshot(outputDir, name) {
    let png;
    if (this.gate?.paused) {
      await this.gate.assertPaused();
      png = this.cached.png;
    } else {
      const response = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      png = Buffer.from(response.data, 'base64');
    }
    ensureDir(outputDir);
    const file = path.join(outputDir, `${safeName(name || 'observation')}.png`);
    fs.writeFileSync(file, png);
    const marked = file.replace(/\.png$/, '.grid.png');
    fs.copyFileSync(file, marked);
    drawGridOnScreenshot(marked, this.config);
    return marked;
  }

  async runActive(input, operation) {
    if (this.fault) throw new Error(`session faulted: ${this.fault.message}`);
    await this.gate.assertPaused();
    const start = performance.now();
    let result;
    let failure;
    try {
      await this.gate.resume();
      this.recorder?.begin(input.action_name, this.cached.jpeg);
      await this.pageClock('resume');
      result = await withDeadline(operation, 20000, 'action execution');
      await sleep(this.settleMs);
    } catch (error) {
      failure = error;
      this.fault = error;
    } finally {
      if (failure) {
        try { this.gate?.forcePause(); } catch (pauseError) { failure ||= pauseError; this.fault ||= pauseError; }
      } else {
        try {
          await this.freezeWithDeadline('action observation');
        } catch (error) {
          failure ||= error;
          this.fault ||= error;
        }
      }
      this.activeWallTimeMs += performance.now() - start;
      if (!failure) this.gameplayTimeMs += Number(result?.duration ?? 0) + this.settleMs;
      this.steps += 1;
      this.recorder?.end(this.cached.jpeg, failure);
    }
    if (failure) throw failure;
    return result;
  }

  recordInput(event) { this.recorder?.event(event); }

  async navigate(input) {
    return super.navigate(input);
  }

  namedControl(input) {
    const { namedControlStep } = require('./game-manifest');
    return namedControlStep(input, this.config.publicControls, this.cached?.state.canvas, this.config.actionWindowMs);
  }

  async close() {
    if (!this.closePromise) this.closePromise = this.finishClose();
    return this.closePromise;
  }

  async finishClose() {
    this.closing = true;
    let recording = { video: null };
    let error = null;
    try {
      if (!this.fault && this.gate?.paused) await this.gate.resume();
      if (!this.fault && this.recorder && this.cached) {
        if (!this.recorder.frames.length) {
          this.recorder.begin('initial-observation', this.cached.jpeg);
          this.recorder.end(this.cached.jpeg);
        }
        recording = await withDeadline(() => this.recorder.stop(), 135000, 'recording finalization');
      }
    } catch (failure) { error = failure; }
    try {
      if (this.browserServer) {
        if (this.fault) await this.browserServer.kill().catch(() => {});
        else await withDeadline(() => this.browserServer.close(), 5000, 'browser close');
      }
    } catch (failure) {
      error ||= failure;
      await this.browserServer.kill().catch(() => {});
    }
    try { await this.stopGameProcess(); } catch (failure) { error ||= failure; }
    if (error) throw error;
    return recording;
  }
}

module.exports = { SteppedBrowserSession };
