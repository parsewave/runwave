'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { executeSteppedTimeline } = require('../src/step-executor');
const { readGameManifest, namedControlStep } = require('../src/game-manifest');

test('slow pointer calls do not extend held keyboard input', async () => {
  const start = performance.now();
  let released;
  await executeSteppedTimeline({ duration: 200,
    browser: { keyDown: async () => {}, keyUp: async () => { released = performance.now() - start; }, click: async () => delay(250) },
    events: [{ type: 'down', at: 0, action: { key: 'w' } }, { type: 'click', at: 0, click: {} }, { type: 'up', at: 70, action: { key: 'w' } }],
  });
  assert.ok(released < 180, `key released at ${released}ms`);
});

test('optional manifest validates public controls and maps named clicks to the canvas', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readGameManifest(root), {});
  fs.writeFileSync(path.join(root, 'webgame.json'), JSON.stringify({ canvas_selector: '#game', ready_selector: '#game',
    controls: [{ name: 'start', type: 'mouse_click', x: 0.5, y: 0.5, duration_ms: 300 }] }));
  const config = readGameManifest(root);
  const step = namedControlStep({ control: 'start', action_name: 'start-game' }, config.publicControls, { x: 100, y: 20, width: 400, height: 200 });
  assert.equal(step.duration, 300);
  assert.equal(step.actions[0].x, 300);
  assert.equal(step.actions[0].y, 120);
  assert.throws(() => namedControlStep({ control: 'bad' }, config.publicControls), /unknown control/);
  fs.writeFileSync(path.join(root, 'webgame.json'), '{"controls":[{"name":"x","type":"mouse_click","x":3,"y":0}]}');
  assert.throws(() => readGameManifest(root), /normalized/);
});
