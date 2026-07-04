const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const cli = path.join(packageRoot, 'bin', 'runwave.js');

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
  const launchConfig = await chromiumLaunchConfig(t);
  if (!launchConfig) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-smoke-'));
  const env = {
    ...process.env,
    RUNWAVE_SESSION_FILE: path.join(tmpDir, 'session.json'),
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
    assert.ok(fs.existsSync(start.output.screenshot));

    const step = runCli(
      {
        action: 'step',
        action_name: 'smoke-click',
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
        finalScreenshot: false,
      },
      { cwd: tmpDir, env }
    );
    assert.equal(stop.ok, true);
    assert.ok(stop.video);
    assert.ok(fs.existsSync(stop.video));
  } finally {
    if (fs.existsSync(env.RUNWAVE_SESSION_FILE)) {
      try {
        runCli({ action: 'stop', action_name: 'smoke-cleanup', finalScreenshot: false }, { cwd: tmpDir, env });
      } catch {
        fs.rmSync(env.RUNWAVE_SESSION_FILE, { force: true });
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
