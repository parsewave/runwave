const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { handleAction } = require('../src/action-handler');
const { OutputWriter } = require('../src/output-writer');
const { createProfiler } = require('../src/profiler');

function testRuntime(tmpDir, browserOverrides = {}) {
  const browser = {
    screenshotArtifact: async (outputDir, name) => ({
      path: path.join(outputDir, `${name}.png`),
      gridPath: path.join(outputDir, `${name}.grid.png`),
    }),
    state: async () => ({ ready: true }),
    click: async () => {},
    keyUp: async () => {},
    ...browserOverrides,
  };

  return {
    sessionId: 'session-001',
    sessionFile: path.join(tmpDir, 'session.json'),
    stepIndex: 0,
    config: {
      autoCaptures: false,
      captureIntervalMs: 1000,
      keyAliases: {},
    },
    browser,
    output: new OutputWriter(tmpDir),
    paths: { runDir: tmpDir },
    profiler: createProfiler({ enabled: false, source: 'test' }),
  };
}

test('screenshot action response exposes clean and grid screenshot fields', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-action-handler-'));

  try {
    const response = await handleAction(testRuntime(tmpDir), {
      action: 'screenshot',
      action_name: 'inspect',
      session_id: 'session-001',
      name: 'current',
    });

    assert.equal(response.screenshot, path.join(response.outputDir, 'current.png'));
    assert.equal(response.gridScreenshot, path.join(response.outputDir, 'current.grid.png'));
    assert.equal(response.state.ready, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('step action captures expose clean and grid screenshot fields', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-action-handler-'));

  try {
    const response = await handleAction(testRuntime(tmpDir), {
      action: 'step',
      action_name: 'click-step',
      session_id: 'session-001',
      duration: 1,
      autoCaptures: false,
      captures: [1],
      actions: [{ type: 'click', start: 0, end: 1, x: 10, y: 12 }],
    });

    assert.equal(response.captures.length, 1);
    assert.equal(response.captures[0].path, path.join(response.outputDir, '001-click-step-00001ms.png'));
    assert.equal(response.captures[0].gridPath, path.join(response.outputDir, '001-click-step-00001ms.grid.png'));
    assert.equal(response.startState.ready, true);
    assert.equal(response.endState.ready, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
