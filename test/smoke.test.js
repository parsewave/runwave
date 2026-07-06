const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const cli = path.join(packageRoot, 'controller', 'bin', 'runwave.js');

function recordingPrerequisitesMissing() {
  if (process.platform !== 'linux') return 'not linux';
  if (!process.env.DISPLAY) return 'DISPLAY not set';
  if (spawnSync('which', ['gst-launch-1.0'], { encoding: 'utf8' }).status !== 0) return 'gst-launch-1.0 not on PATH';
  if (spawnSync('pactl', ['info'], { encoding: 'utf8' }).status !== 0) return 'pactl info failed (pulseaudio not running)';
  return null;
}

async function chromiumLaunchConfig(t) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (error) {
    t.skip(`playwright is not installed: ${error.message}`);
    return null;
  }

  const launchCandidates = [
    {},
    { channel: 'chrome' },
    { channel: 'msedge' },
  ];
  const errors = [];

  for (const launchConfig of launchCandidates) {
    try {
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...launchConfig });
      await browser.close();
      return launchConfig;
    } catch (error) {
      errors.push(error.message);
    }
  }

  t.skip(`playwright chromium is not installed or cannot launch: ${errors[0]}`);
  return null;
}

function runwaveLaunchOptions(launchConfig) {
  if (launchConfig.channel) return { channel: launchConfig.channel };
  if (launchConfig.executablePath) return { executablePath: launchConfig.executablePath };
  return {};
}

test('CLI opens a page, clicks, captures state, and finalizes recording', async (t) => {
  const missing = recordingPrerequisitesMissing();
  if (missing) {
    t.skip(`recording prerequisites missing: ${missing}`);
    return;
  }
  const launchConfig = await chromiumLaunchConfig(t);
  if (!launchConfig) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-smoke-'));
  const sessionId = 'smoke-session';
  const sessionDir = path.join(tmpDir, 'sessions');
  const env = {
    ...process.env,
    RUNWAVE_SESSION_DIR: sessionDir,
    RUNWAVE_WORKSPACE: packageRoot,
  };
  const outputRoot = path.join(tmpDir, 'state');
  const recordingDir = path.join(tmpDir, 'recording');
  const stateExpression =
    "() => ({ clicks: window.clicks || 0, drags: window.drags || 0, status: document.getElementById('status').textContent })";

  try {
    const start = runCli(
      {
        action: 'start',
        action_name: 'smoke-start',
        session_id: sessionId,
        file: 'test/fixtures/click-target.html',
        force: true,
        record: true,
        headless: true,
        viewport: { width: 640, height: 420 },
        videoSize: { width: 640, height: 420 },
        waitAfterLoad: 100,
        outputRoot,
        outDir: recordingDir,
        initialScreenshot: true,
        finalScreenshot: false,
        gridScreenshots: false,
        stateExpression,
        sessionWaitMs: 20000,
        ...runwaveLaunchOptions(launchConfig),
      },
      { cwd: tmpDir, env }
    );
    assert.equal(start.ok, true);
    assert.equal(start.session.sessionId, sessionId);
    assert.ok(fs.existsSync(start.output.screenshot));

    const sessions = runCli({ action: 'sessions' }, { cwd: tmpDir, env });
    assert.equal(sessions.ok, true);
    assert.equal(sessions.sessions.some((session) => session.session_id === sessionId), true);

    const step = runCli(
      {
        action: 'step',
        action_name: 'smoke-click',
        session_id: sessionId,
        actions: [{ type: 'click', start: 50, end: 100, x: 320, y: 210 }],
        captures: [300],
        autoCaptures: false,
      },
      { cwd: tmpDir, env }
    );
    assert.equal(step.ok, true);
    assert.equal(step.endState.custom.clicks, 1);
    assert.equal(step.endState.custom.status, 'Clicks: 1');
    assert.ok(step.captures.length >= 1);
    assert.ok(fs.existsSync(step.captures[0].path));

    const drag = runCli(
      {
        action: 'step',
        action_name: 'smoke-drag',
        session_id: sessionId,
        actions: [{ type: 'drag', start: 50, end: 300, from: { x: 260, y: 210 }, to: { x: 380, y: 210 }, mode: 'mouse', steps: 6 }],
        captures: [300],
        autoCaptures: false,
      },
      { cwd: tmpDir, env }
    );
    assert.equal(drag.ok, true);
    assert.equal(drag.endState.custom.drags, 1);
    assert.equal(drag.actions.find((action) => action.type === 'drag').mode, 'mouse');

    const stop = runCli(
      {
        action: 'stop',
        action_name: 'smoke-stop',
        session_id: sessionId,
        finalScreenshot: false,
      },
      { cwd: tmpDir, env }
    );
    assert.equal(stop.ok, true);
    assert.ok(stop.video);
    assert.ok(fs.existsSync(stop.video));
  } finally {
    if (fs.existsSync(path.join(sessionDir, `${sessionId}.json`))) {
      try {
        runCli({ action: 'stop', action_name: 'smoke-cleanup', session_id: sessionId, finalScreenshot: false }, { cwd: tmpDir, env });
      } catch {
        fs.rmSync(path.join(sessionDir, `${sessionId}.json`), { force: true });
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function runCli(payload, options) {
  const proc = spawnSync(process.execPath, [cli, JSON.stringify(payload)], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 45000,
  });

  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return JSON.parse(proc.stdout);
}
