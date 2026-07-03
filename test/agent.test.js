'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { normalizeDecision } = require('../agent/src/action-parser');
const { runAgenticPlaytest } = require('../agent/src/agent-player');

test('normalizes model actions into harness steps', () => {
  const decision = normalizeDecision(
    {
      duration_ms: 9000,
      commands: [{ from: 0, to: 5000, key: 'ArrowRight' }],
      clicks: [{ at: 50, x: 0.5, y: 0.25 }],
      view_moves: [{ from: 0, to: 500, dx: 50, dy: -10 }],
      should_stop: true,
      summary: 'menu is visible',
    },
    { viewport: { width: 1000, height: 600 } }
  );

  assert.equal(decision.durationMs, 8000);
  assert.deepEqual(decision.commands, [{ from: 0, to: 5000, key: 'ArrowRight' }]);
  assert.equal(decision.clicks[0].x, 500);
  assert.equal(decision.clicks[0].y, 150);
  assert.equal(decision.viewMoves[0].dx, 50);
  assert.equal(decision.shouldStop, true);
});

test('agent playtest loop calls model and executes returned action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-agent-test-'));
  const screenshot = path.join(dir, 'screen.png');
  fs.writeFileSync(
    screenshot,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  );

  const actions = [];
  const result = await runAgenticPlaytest({
    job: {
      playtestDurationMs: 7000,
      agentMinPlaytestMs: 0,
      viewport: { width: 640, height: 360 },
    },
    initialResponse: {
      screenshot,
      state: { url: 'http://example.test' },
    },
    outputDir: path.join(dir, 'agent'),
    modelClient: async () => ({
      model: 'fake-model',
      usage: { total_tokens: 1 },
      json: {
        summary: 'start screen is visible',
        duration_ms: 500,
        clicks: [{ at: 0, x: 320, y: 180 }],
        commands: [{ from: 0, to: 500, key: 'Enter' }],
        should_stop: true,
      },
    }),
    runAction: async (action) => {
      actions.push(action);
      return { captures: [{ path: screenshot }], endState: { ok: true } };
    },
  });

  assert.equal(result.steps, 1);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'step');
  assert.equal(actions[0].commands[0].key, 'Enter');
  assert.equal(fs.existsSync(path.join(dir, 'agent', 'agent-summary.json')), true);
});
