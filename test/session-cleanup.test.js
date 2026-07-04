const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createProfiler } = require('../harness/src/profiler');
const { stopExistingSessionForForce } = require('../harness/src/cli');

function writeSession(dir, session) {
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
  return file;
}

function profiler() {
  return createProfiler({ enabled: false, source: 'test' });
}

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
