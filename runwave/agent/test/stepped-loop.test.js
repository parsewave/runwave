'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { runAgenticPlaytest } = require('../src/agent-player');
const { normalizeSequence } = require('../src/action-parser');
const { buildPlaytesterPrompt } = require('../src/prompt');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-step-loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = path.join(root, 'screen.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
  return { outputDir: root, initialResponse: { screenshot: png, state: { timing: { mode: 'stepped', paused: true, gameplayTimeMs: 0 } } } };
}

test('slow model calls do not consume stepped gameplay budget', async (t) => {
  const options = setup(t);
  let active = 0;
  const summary = await runAgenticPlaytest({ ...options,
    job: { executionMode: 'stepped', playtestDurationMs: 200, agentMinPlaytestMs: 200, wallTimeoutMs: 3000 },
    modelClient: async () => { await delay(140); return { json: { actions: [{ type: 'wait', start: 0, end: 100 }] } }; },
    runAction: async (request) => {
      active += request.duration;
      return { ...options.initialResponse, timing: { paused: true, gameplayTimeMs: active } };
    },
  });
  assert.equal(summary.steps, 2);
  assert.equal(summary.gameplayTimeMs, 200);
  assert.ok(summary.thinkingTimeMs >= 260);
});

test('invalid outputs retry on the frozen observation without fallback inputs', async (t) => {
  const options = setup(t);
  let calls = 0;
  let actions = 0;
  const result = await runAgenticPlaytest({ ...options,
    job: { executionMode: 'stepped', playtestDurationMs: 100, agentMinPlaytestMs: 100, wallTimeoutMs: 2000 },
    modelClient: async () => ({ json: ++calls === 1 ? [] : { actions: [{ type: 'wait', start: 0, end: 100 }] } }),
    runAction: async () => { actions++; return { ...options.initialResponse, timing: { paused: true, gameplayTimeMs: 100 } }; },
  });
  assert.equal(calls, 2);
  assert.equal(actions, 1);
  assert.equal(result.history[0].failedAction, true);
});

test('repeated stop requests before the minimum count as failed model decisions', async (t) => {
  const options = setup(t);
  let calls = 0;
  await assert.rejects(runAgenticPlaytest({ ...options,
    job: {
      executionMode: 'stepped', playtestDurationMs: 200, agentMinPlaytestMs: 200,
      wallTimeoutMs: 2000, agentMaxModelFallbacks: 3,
    },
    modelClient: async () => { calls += 1; return { json: { actions: [], should_stop: true } }; },
    runAction: async () => assert.fail('stop requests must not dispatch input'),
  }), /before minimum gameplay time: invalid-model-output/);
  assert.equal(calls, 3);
});

test('consecutive invalid model outputs stop after the configured retry limit', async (t) => {
  const options = setup(t);
  let calls = 0;
  await assert.rejects(runAgenticPlaytest({ ...options,
    job: {
      executionMode: 'stepped', playtestDurationMs: 200, agentMinPlaytestMs: 200,
      wallTimeoutMs: 2000, agentMaxModelFallbacks: 3,
    },
    modelClient: async () => { calls += 1; return { json: [] }; },
    runAction: async () => assert.fail('invalid output must not dispatch input'),
  }), /before minimum gameplay time: invalid-model-output/);
  assert.equal(calls, 3);
});

test('wall timeout does not dispatch a late decision or silently pass a short playtest', async (t) => {
  const options = setup(t);
  await assert.rejects(runAgenticPlaytest({ ...options,
    job: { executionMode: 'stepped', playtestDurationMs: 200, agentMinPlaytestMs: 200, wallTimeoutMs: 20 },
    modelClient: async () => { await delay(50); return { json: { actions: [{ type: 'wait', start: 0, end: 100 }] } }; },
    runAction: async () => assert.fail('must not dispatch after wall timeout'),
  }), /before minimum gameplay time: wall-timeout/);
});

test('stepped prompt describes freezing, explicit waits, public controls and short actions', () => {
  const prompt = buildPlaytesterPrompt({ job: { executionMode: 'stepped' }, elapsedMs: 0, maxMs: 120000,
    viewport: { width: 640, height: 360 }, state: { publicControls: [{ name: 'forward', key: 'w' }] }, history: [] });
  assert.match(prompt, /not an in-game pause/);
  assert.match(prompt, /100-500ms/);
  assert.match(prompt, /"key":"w"/);
  assert.doesNotMatch(prompt, /chain multiple/);
  assert.equal(normalizeSequence({ actions: [{ type: 'wait', start: 0, end: 120 }] }, { config: { executionMode: 'stepped' } }).durationMs, 120);
});
