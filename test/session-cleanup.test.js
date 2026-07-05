const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createProfiler } = require('../controller/src/profiler');
const { existingSessionStart, stopExistingSessionForForce } = require('../controller/src/cli');
const { startSessionConfig } = require('../controller/src/protocol');

function writeSession(dir, session) {
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
  return file;
}

function profiler() {
  return createProfiler({ enabled: false, source: 'test' });
}

test('start reuses a live session only when the start configuration matches', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-compatible-start-'));
  const start = {
    action: 'start',
    action_name: 'start-again',
    url: 'http://127.0.0.1:3000/',
    viewport: { width: 640, height: 420 },
    record: true,
    headless: true,
    chromiumArgs: ['--no-sandbox'],
  };
  const sessionFile = writeSession(tmpDir, {
    pid: 12345,
    port: 43210,
    startConfig: startSessionConfig(start),
  });
  const posted = [];

  try {
    const result = await existingSessionStart(start, profiler(), {
      sessionFilePath: sessionFile,
      postJson: async (port, payload) => {
        posted.push({ port, payload });
        return payload.action === 'ping'
          ? { ok: true, action: 'ping' }
          : { ok: true, action: 'state', state: { generic: { url: start.url } } };
      },
    });

    assert.equal(result.alreadyRunning, true);
    assert.equal(result.session.port, 43210);
    assert.deepEqual(posted.map((entry) => entry.payload.action), ['ping', 'state']);
    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('start rejects a live session with a different target instead of silently reusing it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-target-mismatch-'));
  const originalStart = {
    action: 'start',
    action_name: 'old-start',
    url: 'http://127.0.0.1:3000/old',
    viewport: { width: 640, height: 420 },
  };
  const sessionFile = writeSession(tmpDir, {
    pid: 12345,
    port: 43210,
    startConfig: startSessionConfig(originalStart),
  });
  const posted = [];

  try {
    await assert.rejects(
      existingSessionStart(
        {
          ...originalStart,
          action_name: 'new-start',
          url: 'http://127.0.0.1:3000/new',
        },
        profiler(),
        {
          sessionFilePath: sessionFile,
          postJson: async (port, payload) => {
            posted.push({ port, payload });
            return { ok: true, action: payload.action };
          },
        }
      ),
      /different start configuration \(launchUrl\).*"force": true/
    );

    assert.deepEqual(posted.map((entry) => entry.payload.action), ['ping']);
    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('start rejects a live session with different viewport or launch options', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-config-mismatch-'));
  const originalStart = {
    action: 'start',
    action_name: 'old-start',
    url: 'http://127.0.0.1:3000/',
    viewport: { width: 640, height: 420 },
    chromiumArgs: ['--no-sandbox'],
  };
  const sessionFile = writeSession(tmpDir, {
    pid: 12345,
    port: 43210,
    startConfig: startSessionConfig(originalStart),
  });

  try {
    await assert.rejects(
      existingSessionStart(
        {
          ...originalStart,
          action_name: 'new-start',
          viewport: { width: 800, height: 600 },
          chromiumArgs: ['--no-sandbox', '--disable-gpu'],
        },
        profiler(),
        {
          sessionFilePath: sessionFile,
          postJson: async (port, payload) => ({ ok: true, action: payload.action }),
        }
      ),
      /different start configuration \(browser, context\).*"force": true/
    );

    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('force start stops an existing live session before removing the session file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-force-stop-'));
  const sessionFile = writeSession(tmpDir, { pid: 12345, port: 43210 });
  const posted = [];
  let running = true;

  try {
    const result = await stopExistingSessionForForce(
      { action_name: 'new-start', forceStopWaitMs: 1000 },
      profiler(),
      {
        sessionFilePath: sessionFile,
        postJson: async (port, payload) => {
          posted.push({ port, payload });
          running = false;
          return { ok: true, action: 'stop' };
        },
        kill: (pid, signal) => {
          assert.equal(pid, 12345);
          assert.equal(signal, 0);
          if (!running) {
            const error = new Error('not running');
            error.code = 'ESRCH';
            throw error;
          }
          return true;
        },
        sleep: async () => {},
      }
    );

    assert.equal(result.reason, 'stopped');
    assert.equal(result.stopped, true);
    assert.equal(fs.existsSync(sessionFile), false);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].port, 43210);
    assert.deepEqual(posted[0].payload, {
      action: 'stop',
      action_name: 'new-start-force-stop',
      finalScreenshot: false,
      __runwaveVerbose: undefined,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('force start keeps the session file and fails when the old daemon stays alive', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-force-stop-live-'));
  const sessionFile = writeSession(tmpDir, { pid: 12345, port: 43210 });

  try {
    await assert.rejects(
      stopExistingSessionForForce(
        { action_name: 'new-start', forceStopWaitMs: 1 },
        profiler(),
        {
          sessionFilePath: sessionFile,
          postJson: async () => {
            throw new Error('connection refused');
          },
          kill: () => true,
          sleep: async () => {},
        }
      ),
      /still running after forced stop failed/
    );

    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('force start removes a stale unreachable session file when no PID is alive', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-force-stop-stale-'));
  const sessionFile = writeSession(tmpDir, { pid: 12345, port: 43210 });

  try {
    const result = await stopExistingSessionForForce(
      { action_name: 'new-start', forceStopWaitMs: 1 },
      profiler(),
      {
        sessionFilePath: sessionFile,
        postJson: async () => {
          throw new Error('connection refused');
        },
        kill: () => {
          const error = new Error('not running');
          error.code = 'ESRCH';
          throw error;
        },
        sleep: async () => {},
      }
    );

    assert.equal(result.reason, 'stale-session');
    assert.equal(fs.existsSync(sessionFile), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
