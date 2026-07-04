'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { PNG } = require('pngjs');

const { normalizeSequence } = require('../agent/src/action-parser');
const { decideNextSequence, runAgenticPlaytest } = require('../agent/src/agent-player');
const { chatCompletion, parseJsonResponse } = require('../agent/src/model-client');
const { buildPlaytesterPrompt, compactHistory } = require('../agent/src/prompt');
const { drawMarkGridOnScreenshot } = require('../harness/src/grid-overlay');
const { normalizeStep } = require('../harness/src/step-normalizer');

test('normalizes model sequences into harness steps', () => {
  const sequence = normalizeSequence(
    {
      actions: [
        { type: 'key', start: 0, end: 5000, key: 'ArrowRight' },
        { type: 'key', start: 100, end: 900, key: 'Shift+ArrowRight+Space' },
        { type: 'click', start: 50, x: 0.5, y: 0.25 },
        { type: 'drag', start: 100, from: { x: 0.2, y: 0.25 }, to: { x: 0.4, y: 0.25 }, mode: 'html5' },
        { type: 'view_move', start: 0, end: 500, dx: 50, dy: -10 },
      ],
      should_stop: true,
      summary: 'menu is visible',
      previous_sequence_outcome: 'Enter opened the menu.',
    },
    { viewport: { width: 1000, height: 600 } }
  );

  assert.equal(sequence.durationMs, 5000);
  assert.deepEqual(sequence.actions.filter((action) => action.type === 'key'), [
    { type: 'key', start: 0, end: 5000, key: 'ArrowRight' },
    { type: 'key', start: 100, end: 900, key: 'Shift' },
    { type: 'key', start: 100, end: 900, key: 'ArrowRight' },
    { type: 'key', start: 100, end: 900, key: 'Space' },
  ]);
  const click = sequence.actions.find((action) => action.type === 'click');
  const drag = sequence.actions.find((action) => action.type === 'drag');
  const viewMove = sequence.actions.find((action) => action.type === 'view_move');
  assert.equal(click.x, 500);
  assert.equal(click.y, 150);
  assert.equal(click.end, 100);
  assert.deepEqual(drag, {
    type: 'drag',
    start: 100,
    end: 150,
    from: { x: 200, y: 150 },
    to: { x: 400, y: 150 },
    button: 'left',
    mode: 'html5',
    steps: 12,
  });
  assert.equal(viewMove.dx, 50);
  assert.equal(sequence.shouldStop, true);
  assert.equal(sequence.previousSequenceOutcome, 'Enter opened the menu.');
});

test('normalizes grid-cell model actions into concrete pointer events', () => {
  const sequence = normalizeSequence(
    {
      actions: [
        { type: 'click', start: 100, cells: [9] },
        { type: 'multi_click', start: 200, cells: [18, 19], count: 10 },
        { type: 'drag', start: 300, from_cells: [34], to_cells: [35], mode: 'mouse' },
        { type: 'cursor_move', start: 400, cells: [27] },
      ],
    },
    { viewport: { width: 800, height: 800 }, config: { markGridRows: 8, markGridCols: 8 } }
  );

  const clicks = sequence.actions.filter((action) => action.type === 'click');
  const drag = sequence.actions.find((action) => action.type === 'drag');
  const cursorMove = sequence.actions.find((action) => action.type === 'cursor_move');
  assert.equal(clicks.length, 11);
  assert.ok(clicks.every((click) => !Object.hasOwn(click, 'clickMode')));
  assert.equal(clicks[0].cells[0], 9);
  assert.equal(clicks[0].end, 150);
  assert.ok(clicks[0].x >= 100 && clicks[0].x <= 199);
  assert.ok(clicks[0].y >= 100 && clicks[0].y <= 199);
  assert.deepEqual(clicks.slice(1).map((click) => click.start), [200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
  assert.deepEqual(clicks.slice(1).map((click) => click.end), [250, 350, 450, 550, 650, 750, 850, 950, 1050, 1150]);
  assert.ok(clicks.slice(1).every((click) => click.x >= 200 && click.x <= 400));
  assert.ok(clicks.slice(1).every((click) => click.y >= 200 && click.y <= 300));
  assert.deepEqual(drag.from.cells, [34]);
  assert.deepEqual(drag.to.cells, [35]);
  assert.equal(drag.end, 350);
  assert.deepEqual(cursorMove.cells, [27]);
  assert.equal(cursorMove.end, 450);

  const step = normalizeStep({ actions: sequence.actions }, { viewport: { width: 800, height: 800 } }, 1);
  assert.equal(step.clicks.length, 11);
});

test('normalizes row and column grid targets into concrete pointer events', () => {
  const sequence = normalizeSequence(
    {
      actions: [
        { type: 'click', start: 100, cell: { row: 1, col: 2 } },
        { type: 'multi_click', start: 200, cells: [{ row: 2, col: 0 }, { row: 2, col: 1 }], count: 2 },
        { type: 'drag', start: 300, from: { row: 3, col: 4 }, to: { row: 3, col: 5 }, mode: 'mouse' },
        { type: 'cursor_move', start: 400, cell: { row: 0, col: 7 } },
      ],
    },
    { viewport: { width: 800, height: 800 }, config: { markGridRows: 8, markGridCols: 8 } }
  );

  const clicks = sequence.actions.filter((action) => action.type === 'click');
  const drag = sequence.actions.find((action) => action.type === 'drag');
  const cursorMove = sequence.actions.find((action) => action.type === 'cursor_move');
  assert.equal(clicks[0].cells[0], 10);
  assert.ok(clicks[0].x >= 200 && clicks[0].x <= 299);
  assert.ok(clicks[0].y >= 100 && clicks[0].y <= 199);
  assert.deepEqual(clicks.slice(1).flatMap((click) => click.cells), [16, 17, 16, 17]);
  assert.deepEqual(drag.from.cells, [28]);
  assert.deepEqual(drag.to.cells, [29]);
  assert.deepEqual(cursorMove.cells, [7]);
});

test('rejects model sequence fields outside the canonical schema', () => {
  assert.throws(
    () => normalizeSequence({ summary: 'ok', actions: [], extra: true }, { viewport: { width: 800, height: 800 } }),
    /unknown field "extra"/
  );
  assert.throws(
    () => normalizeSequence({ actions: [{ type: 'key', start: 0, end: 100, key: 'Enter', power: 2 }] }, { viewport: { width: 800, height: 800 } }),
    /unknown field "power"/
  );
  assert.throws(
    () => normalizeSequence({ actions: [{ type: 'wait', start: 0 }] }, { viewport: { width: 800, height: 800 } }),
    /unknown sequence action type: wait/
  );
});

test('drops model actions with invalid short-action timing', () => {
  const sequence = normalizeSequence(
    {
      actions: [
        { type: 'click', start: 0, end: 500, x: 10, y: 10 },
        { type: 'drag', start: 0, end: 2501, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
        { type: 'cursor_move', start: 0, end: 2501, to: { x: 10, y: 10 } },
        { type: 'key', start: 0, end: 5000, key: 'ArrowRight' },
      ],
    },
    { viewport: { width: 800, height: 800 } }
  );

  assert.deepEqual(sequence.actions.map((action) => action.type), ['key']);
  assert.equal(sequence.durationMs, 5000);
});

test('normalizes agent plain clicks to a single physical click', () => {
  const sequence = normalizeSequence(
    { actions: [{ type: 'click', start: 100, x: 10, y: 10, clickCount: 3 }] },
    { viewport: { width: 800, height: 800 } }
  );

  assert.equal(sequence.actions.length, 1);
  assert.ok(!Object.hasOwn(sequence.actions[0], 'clickCount'));
  assert.equal(sequence.actions[0].end, 150);
});

test('normalizes harness grid-cell steps into concrete pointer events', () => {
  const step = normalizeStep(
    {
      actions: [
        { type: 'click', start: 100, cells: [0] },
        { type: 'multi_click', start: 200, cells: [63], count: 3 },
        { type: 'drag', start: 300, from_cells: [8], to_cells: [15] },
        { type: 'cursor_move', start: 400, cells: [7] },
      ],
    },
    { viewport: { width: 800, height: 800 }, markGridRows: 8, markGridCols: 8 },
    1
  );

  assert.equal(step.duration, 450);
  assert.equal(step.clicks.length, 4);
  assert.deepEqual(step.clicks.slice(1).map((click) => click.start), [200, 300, 400]);
  assert.deepEqual(step.clicks.slice(1).map((click) => click.end), [250, 350, 450]);
  assert.ok(step.clicks[0].x >= 0 && step.clicks[0].x <= 99);
  assert.ok(step.clicks[0].y >= 0 && step.clicks[0].y <= 99);
  assert.ok(step.clicks.slice(1).every((click) => click.x >= 700 && click.x <= 799));
  assert.ok(step.clicks.slice(1).every((click) => click.y >= 700 && click.y <= 799));
  assert.deepEqual(step.drags[0].from.cells, [8]);
  assert.deepEqual(step.drags[0].to.cells, [15]);
  assert.deepEqual(step.cursorMoves[0].to.cells, [7]);
});

test('normalizes harness row and column grid steps in strict mode', () => {
  const step = normalizeStep(
    {
      actions: [
        { type: 'click', start: 100, cell: { row: 1, col: 2 } },
        { type: 'multi_click', start: 200, cells: [{ row: 2, col: 0 }, { row: 2, col: 1 }], count: 2 },
        { type: 'drag', start: 300, from: { row: 3, col: 4 }, to: { row: 3, col: 5 } },
        { type: 'cursor_move', start: 400, cell: { row: 0, col: 7 } },
      ],
    },
    { viewport: { width: 800, height: 800 }, markGridRows: 8, markGridCols: 8 },
    1
  );

  assert.equal(step.duration, 450);
  assert.equal(step.clicks[0].cells[0], 10);
  assert.ok(step.clicks[0].x >= 200 && step.clicks[0].x <= 299);
  assert.ok(step.clicks[0].y >= 100 && step.clicks[0].y <= 199);
  assert.deepEqual(step.clicks.slice(1).flatMap((click) => click.cells), [16, 17, 16, 17]);
  assert.deepEqual(step.drags[0].from.cells, [28]);
  assert.deepEqual(step.drags[0].to.cells, [29]);
  assert.deepEqual(step.cursorMoves[0].to.cells, [7]);
});

test('infers harness duration from action timing fields only', () => {
  const step = normalizeStep(
    {
      actions: [
        { type: 'drag', start: 100, from: { x: 854, y: 156 }, to: { x: 1012, y: 158 }, mode: 'mouse' },
        { type: 'cursor_move', start: 500, to: { x: 347, y: 345 }, steps: 5 },
        { type: 'drag', start: 1000, from: { x: 609, y: 331 }, to: { x: 605, y: 202 }, mode: 'mouse' },
      ],
    },
    { viewport: { width: 1280, height: 720 } },
    1
  );

  assert.equal(step.duration, 1050);
  assert.deepEqual(step.captures, [1000, 1050]);
  assert.equal(step.drags.length, 2);
  assert.equal(step.cursorMoves.length, 1);
});

test('infers harness duration from key ends and multi-click intervals', () => {
  const keyStep = normalizeStep(
    { actions: [{ type: 'key', start: 0, end: 700, key: 'Space' }] },
    {},
    1
  );
  const multiClickStep = normalizeStep(
    { actions: [{ type: 'multi_click', start: 200, x: 100, y: 100, count: 4, intervalMs: 150 }] },
    { viewport: { width: 800, height: 800 } },
    2
  );

  assert.equal(keyStep.duration, 700);
  assert.equal(multiClickStep.duration, 700);
  assert.deepEqual(multiClickStep.clicks.map((click) => click.start), [200, 350, 500, 650]);
  assert.deepEqual(multiClickStep.clicks.map((click) => click.end), [250, 400, 550, 700]);
});

test('drops compressed multi-clicks that would have zero duration', () => {
  const sequence = normalizeSequence(
    { actions: [{ type: 'multi_click', start: 7900, cells: [575], count: 10 }] },
    { viewport: { width: 240, height: 240 }, maxDurationMs: 8000 }
  );
  const clicks = sequence.actions.filter((action) => action.type === 'click');

  assert.ok(clicks.length > 0);
  assert.ok(clicks.every((click) => click.end > click.start));
  assert.ok(clicks.every((click) => click.end <= 8000));
});

test('default mark grid is dense enough for fine pointer targets', () => {
  const sequence = normalizeSequence(
    { actions: [{ type: 'click', start: 0, cells: [575] }] },
    { viewport: { width: 240, height: 240 } }
  );
  const click = sequence.actions[0];

  assert.deepEqual(click.cells, [575]);
  assert.ok(click.x >= 230 && click.x <= 239);
  assert.ok(click.y >= 230 && click.y <= 239);
});

test('mark grid overlay keeps labels in the margins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-grid-overlay-test-'));
  const file = path.join(dir, 'screen.png');
  const png = new PNG({ width: 240, height: 160 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (png.width * y + x) << 2;
      png.data[index] = x % 256;
      png.data[index + 1] = y % 256;
      png.data[index + 2] = (x + y) % 256;
      png.data[index + 3] = 255;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));

  drawMarkGridOnScreenshot(file, { markGridRows: 24, markGridCols: 24 });
  const output = PNG.sync.read(fs.readFileSync(file));
  const marginX = (output.width - png.width) / 2;
  const marginY = (output.height - png.height) / 2;
  const cellWidth = png.width / 24;
  const cellHeight = png.height / 24;

  assert.ok(output.width > 240);
  assert.ok(output.height > 160);
  assert.equal(output.width - 240, output.height - 160);
  assert.equal(marginX, marginY);
  assert.ok(marginX > 0);

  for (let y = 1; y < png.height - 1; y += 1) {
    for (let x = 1; x < png.width - 1; x += 1) {
      const nearVerticalLine = Math.abs((x / cellWidth) - Math.round(x / cellWidth)) < 0.08;
      const nearHorizontalLine = Math.abs((y / cellHeight) - Math.round(y / cellHeight)) < 0.12;
      if (nearVerticalLine || nearHorizontalLine) continue;

      const sourceIndex = (png.width * y + x) << 2;
      const outputIndex = (output.width * (y + marginY) + x + marginX) << 2;
      assert.equal(output.data[outputIndex], png.data[sourceIndex]);
      assert.equal(output.data[outputIndex + 1], png.data[sourceIndex + 1]);
      assert.equal(output.data[outputIndex + 2], png.data[sourceIndex + 2]);
    }
  }
});

test('rejects harness short actions with impossible end timings', () => {
  assert.throws(
    () => normalizeStep({ actions: [{ type: 'click', start: 0, end: 500, x: 1, y: 1 }] }, { viewport: { width: 800, height: 800 } }, 1),
    /click action duration exceeds 100ms/
  );
  assert.throws(
    () => normalizeStep(
      { actions: [{ type: 'drag', start: 0, end: 2501, from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }] },
      { viewport: { width: 800, height: 800 } },
      1
    ),
    /drag action duration exceeds 2000ms/
  );
});

test('browser clicks hold the mouse down for the normalized click interval', async (t) => {
  let BrowserSession;
  try {
    ({ BrowserSession } = require('../harness/src/browser-session'));
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('playwright')) {
      t.skip('playwright is not installed');
      return;
    }
    throw error;
  }

  const session = new BrowserSession({ url: 'about:blank' }, { runDir: os.tmpdir() });
  const calls = [];
  session.page = {
    mouse: {
      move: async (x, y) => calls.push({ type: 'move', x, y }),
      down: async (options) => calls.push({ type: 'down', options, at: Date.now() }),
      up: async (options) => calls.push({ type: 'up', options, at: Date.now() }),
    },
  };

  const startedAt = Date.now();
  await session.click({ type: 'click', start: 100, end: 150, x: 321, y: 222, button: 'left', clickCount: 1 });

  assert.deepEqual(calls.map((call) => call.type), ['move', 'down', 'up']);
  assert.deepEqual(calls[0], { type: 'move', x: 321, y: 222 });
  assert.deepEqual(calls[1].options, { button: 'left', clickCount: 1 });
  assert.deepEqual(calls[2].options, { button: 'left', clickCount: 1 });
  assert.ok(Date.now() - startedAt >= 45);
  assert.deepEqual(session.mousePosition, { x: 321, y: 222 });
});

test('rejects harness step fields outside the canonical schema', () => {
  const explicit = normalizeStep({ duration: 1000, actions: [], captures: [1000], autoCaptures: false }, {}, 1);
  const verbose = normalizeStep({ duration: 1000, actions: [], captures: [1000], __runwaveVerbose: true }, {}, 2);
  assert.equal(explicit.duration, 1000);
  assert.deepEqual(explicit.captures, [1000]);
  assert.equal(verbose.duration, 1000);
  assert.deepEqual(verbose.captures, [1000]);

  assert.throws(
    () => normalizeStep({ actions: [], surprise: true }, {}, 1),
    /unknown field "surprise"/
  );
  assert.throws(
    () => normalizeStep({ actions: [{ type: 'key', start: 100, end: 400, key: 'right', power: 2 }] }, {}, 1),
    /unknown field "power"/
  );
  assert.throws(
    () => normalizeStep({ actions: [{ type: 'click', start: 100, x: 10, y: 10, clickCount: 3 }] }, { viewport: { width: 800, height: 800 } }, 1),
    /unknown field "clickCount"/
  );
  assert.throws(
    () => normalizeStep({ actions: [{ type: 'wait', start: 0 }] }, {}, 1),
    /unknown sequence action type: wait/
  );
});

test('agent playtest loop calls model and executes returned sequence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-agent-test-'));
  const screenshot = path.join(dir, 'screen.png');
  const afterScreenshot = path.join(dir, 'after-screen.png');
  fs.writeFileSync(
    screenshot,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  );
  fs.writeFileSync(afterScreenshot, 'different screenshot bytes');

  const harnessSteps = [];
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
        actions: [
          { type: 'click', start: 0, x: 320, y: 180 },
          { type: 'drag', start: 50, from: { x: 100, y: 100 }, to: { x: 130, y: 100 }, mode: 'mouse' },
          { type: 'key', start: 0, end: 500, key: 'Enter' },
        ],
        should_stop: true,
      },
    }),
    runAction: async (step) => {
      harnessSteps.push(step);
      return { ok: true, captures: [{ path: afterScreenshot }], endState: { ok: true } };
    },
  });

  assert.equal(result.steps, 1);
  assert.equal(harnessSteps.length, 1);
  assert.equal(harnessSteps[0].action, 'step');
  assert.equal(harnessSteps[0].duration, 500);
  assert.deepEqual(harnessSteps[0].captures, [500]);
  assert.equal(harnessSteps[0].actions.find((action) => action.type === 'key').key, 'Enter');
  assert.equal(harnessSteps[0].actions.find((action) => action.type === 'drag').mode, 'mouse');
  assert.equal(harnessSteps[0].actions.find((action) => action.type === 'drag').end, 100);
  assert.equal(result.history[0].result.ok, true);
  assert.equal(result.history[0].result.screenshot, afterScreenshot);
  assert.equal(result.history[0].result.screenshotChanged, true);
  assert.deepEqual(result.history[0].result.state, { ok: true });
  const promptLog = fs
    .readFileSync(path.join(dir, 'agent', 'agent-prompts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(promptLog.length, 1);
  assert.equal(promptLog[0].step, 1);
  assert.equal(promptLog[0].screenshot, screenshot);
  assert.match(promptLog[0].prompt, /You are an agentic browser-game playtester/);
  assert.equal(fs.existsSync(path.join(dir, 'agent', 'agent-summary.json')), true);
});

test('decideNextSequence retries when parsed model JSON has invalid sequence fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-agent-schema-retry-test-'));
  const screenshot = path.join(dir, 'screen.png');
  fs.writeFileSync(
    screenshot,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  );

  let call = 0;
  const messagesByCall = [];
  const result = await decideNextSequence({
    job: {
      viewport: { width: 640, height: 360 },
      agentSchemaAttempts: 2,
    },
    screenshot,
    state: { url: 'http://example.test' },
    history: [],
    elapsedMs: 0,
    maxMs: 120000,
    modelClient: async ({ messages }) => {
      call += 1;
      messagesByCall.push(messages);
      if (call === 1) {
        return {
          model: 'fake-model',
          text: '{"summary":"menu is visible","actions":[],"and survive.\\"":true}',
          usage: { total_tokens: 1 },
          json: {
            summary: 'menu is visible',
            actions: [],
            'and survive."': true,
          },
        };
      }
      return {
        model: 'fake-model',
        text: '{"summary":"press enter","actions":[{"type":"key","start":0,"end":500,"key":"Enter"}],"should_stop":false}',
        usage: { total_tokens: 1 },
        json: {
          summary: 'press enter',
          actions: [{ type: 'key', start: 0, end: 500, key: 'Enter' }],
          should_stop: false,
        },
      };
    },
  });

  assert.equal(call, 2);
  assert.equal(result.sequence.actions[0].key, 'Enter');
  assert.match(messagesByCall[1][2].content, /did not match the required sequence schema/);
  assert.match(messagesByCall[1][2].content, /Top-level keys must be exactly/);
  assert.match(messagesByCall[1][2].content, /\{"type":"drag","start":100/);
});

test('agent playtest loop fails invalid model output without fallback actions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-agent-schema-fail-test-'));
  const screenshot = path.join(dir, 'screen.png');
  fs.writeFileSync(
    screenshot,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  );

  const harnessSteps = [];
  let call = 0;
  const result = await runAgenticPlaytest({
    job: {
      playtestDurationMs: 8000,
      agentMinPlaytestMs: 0,
      viewport: { width: 640, height: 360 },
      agentSchemaAttempts: 2,
    },
    initialResponse: {
      screenshot,
      state: { url: 'http://example.test' },
    },
    outputDir: path.join(dir, 'agent'),
    modelClient: async () => {
      call += 1;
      return {
        model: 'fake-model',
        text: '{"summary":"menu is visible","actions":[],"and survive.\\"":true}',
        usage: { total_tokens: 1 },
        json: {
          summary: 'menu is visible',
          actions: [],
          'and survive."': true,
        },
      };
    },
    runAction: async (step) => {
      harnessSteps.push(step);
      return { ok: true, captures: [{ path: screenshot }], endState: { ok: true } };
    },
  }).then(
    () => assert.fail('runAgenticPlaytest should reject invalid model output after schema retries'),
    (error) => error
  );

  assert.equal(call, 2);
  assert.equal(harnessSteps.length, 0);
  assert.equal(result.code, 'RUNWAVE_MODEL_SEQUENCE_INVALID');
});

test('parses fenced nested JSON responses from vision models', () => {
  const parsed = parseJsonResponse(`
Here is the next sequence:
\`\`\`json
{
  "summary": "title screen is visible",
  "actions": [
    {"type": "key", "start": 0, "end": 500, "key": "Enter"},
    {"type": "click", "start": 100, "x": 320, "y": 180}
  ],
  "should_stop": false
}
\`\`\`
`);

  assert.equal(parsed.summary, 'title screen is visible');
  assert.equal(parsed.actions[0].key, 'Enter');
  assert.equal(parsed.actions[1].x, 320);
});

test('recovers JSON with bare repeated string fragments before the closing brace', () => {
  const parsed = parseJsonResponse(`{
  "summary": "The board changed.",
  "previous_sequence_outcome": "The previous ArrowRight move shifted the board.",
  "actions": [
    {"type": "key", "start": 0, "end": 300, "key": "ArrowRight"},
    {"type": "key", "start": 400, "end": 700, "key": "ArrowDown"}
  ],
  "should_stop": false,
  "rationale": "Sliding right and down will merge tiles in the bottom-right corner."
."
right corner."
 corner."
}`);

  assert.equal(parsed.summary, 'The board changed.');
  assert.equal(parsed.previous_sequence_outcome, 'The previous ArrowRight move shifted the board.');
  assert.equal(parsed.actions[0].key, 'ArrowRight');
  assert.equal(parsed.rationale, 'Sliding right and down will merge tiles in the bottom-right corner.');
});

test('recovers JSON with repeated bare rationale continuation lines', () => {
  const parsed = parseJsonResponse(`{
  "summary": "The menu is still visible.",
  "actions": [
    {
      "type": "click",
      "start": 100,
      "x": 500,
      "y": 660
    }
  ],
  "should_stop": false,
  "rationale": "I will try clicking it again."
clicking it again."
to see if it registers."
}`);

  assert.equal(parsed.summary, 'The menu is still visible.');
  assert.equal(parsed.actions[0].x, 500);
  assert.equal(parsed.rationale, 'I will try clicking it again.');
});

test('recovers JSON by dropping duplicated content after a bare fragment tail', () => {
  const parsed = parseJsonResponse(`{
  "summary": "The player ship is on the bottom right.",
  "actions": [
    {"type": "key", "start": 0, "end": 500, "key": "ArrowLeft"},
    {"type": "key", "start": 600, "end": 800, "key": "Space"}
  ],
  "should_stop": false,
  "rationale": "Moving left while shooting to clear them."
clear them."
[
  {
    "summary": "duplicate response",
    "actions": []
  }
]`);

  assert.equal(parsed.summary, 'The player ship is on the bottom right.');
  assert.equal(parsed.actions.length, 2);
  assert.equal(parsed.rationale, 'Moving left while shooting to clear them.');
});

test('tags malformed model JSON parse errors', () => {
  assert.throws(
    () => parseJsonResponse('{"summary": "almost valid", "actions": [] trailing'),
    (error) => {
      assert.equal(error.code, 'RUNWAVE_MODEL_JSON_PARSE');
      assert.match(error.message, /JSON/);
      return true;
    }
  );
});

test('playtester prompt warns when recent sequences repeat', () => {
  const prompt = buildPlaytesterPrompt({
    job: {},
    elapsedMs: 10000,
    maxMs: 120000,
    viewport: { width: 1280, height: 720 },
    state: {},
    history: [
      { step: 1, summary: 'game is paused', actions: [{ type: 'click', x: 960, y: 719 }] },
      { step: 2, summary: 'game is paused', actions: [{ type: 'click', x: 963, y: 719 }] },
      { step: 3, summary: 'game is paused', actions: [{ type: 'click', x: 963, y: 719 }] },
    ],
  });

  assert.match(prompt, /Warning:/);
  assert.match(prompt, /Space, Enter, Escape, and P/);
  assert.match(prompt, /\{"type":"drag","start":100/);
  assert.match(prompt, /Single Player/);
  assert.match(prompt, /Do not spend turns only describing or waiting on a menu/);
  assert.match(prompt, /If several recent actions produced no visible change/);
  assert.match(prompt, /the move itself may be invalid/);
  assert.match(prompt, /24x24 red mark grid/);
  assert.match(prompt, /Column labels are in the top\/bottom margins/);
  assert.match(prompt, /"cell":\{"row":12,"col":12\}/);
  assert.match(prompt, /"from":\{"row":12,"col":12\},"to":\{"row":12,"col":13\}/);
  assert.match(prompt, /"type":"multi_click"/);
  assert.match(prompt, /Top-level keys must be exactly/);
  assert.match(prompt, /Timing rules:/);
  assert.match(prompt, /"actions"/);
  assert.match(prompt, /"start":0/);
  assert.match(prompt, /"end":500/);
  assert.doesNotMatch(prompt, /"commands":/);
  assert.doesNotMatch(prompt, /duration_ms/);
  assert.doesNotMatch(prompt, /"clicks":/);
  assert.doesNotMatch(prompt, /"multi_clicks":/);
});

test('playtester prompt describes custom mark grid dimensions', () => {
  const prompt = buildPlaytesterPrompt({
    job: { markGridRows: 12, markGridCols: 10 },
    elapsedMs: 0,
    maxMs: 120000,
    viewport: { width: 1000, height: 600 },
    state: {},
    history: [],
  });

  assert.match(prompt, /12x10 red mark grid/);
  assert.match(prompt, /"cell":\{"row":6,"col":5\}/);
  assert.doesNotMatch(prompt, /"cell":\{"row":12,"col":12\}/);
});

test('playtester prompt warns when recent sequences repeat a control cycle up to 5 steps', () => {
  const cycle = ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'];
  const prompt = buildPlaytesterPrompt({
    job: {},
    elapsedMs: 10000,
    maxMs: 120000,
    viewport: { width: 1280, height: 720 },
    state: {},
    history: cycle.concat(cycle).map((key, index) => ({
      step: index + 1,
      summary: 'ball is still in the central maze area',
      actions: [{ type: 'key', key }],
    })),
  });

  assert.match(prompt, /Warning: the recent sequences repeated a 4-step control cycle/);
  assert.match(prompt, /ArrowRight -> ArrowUp -> ArrowLeft -> ArrowDown/);
  assert.match(prompt, /Break the loop now/);
});

test('compact history includes post-sequence result signals', () => {
  const text = compactHistory([
    {
      step: 1,
      summary: 'ball moved through a corridor',
      actions: [{ type: 'key', key: 'ArrowRight' }],
      result: { ok: true, screenshotChanged: true, captureCount: 1 },
      outcomeSummary: 'The ball rolled right and the camera followed into a new corridor.',
    },
  ]);

  assert.match(text, /controls=ArrowRight/);
  assert.match(text, /post_sequence=ok=true,screenshot_changed=true,captures=1/);
  assert.match(text, /outcome="The ball rolled right and the camera followed into a new corridor\."/);
});

test('agent loop attaches previous sequence outcome to the prior history step', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-agent-outcome-test-'));
  const screenshot = path.join(dir, 'screen.png');
  fs.writeFileSync(
    screenshot,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  );

  let calls = 0;
  const result = await runAgenticPlaytest({
    job: {
      playtestDurationMs: 9000,
      agentMinPlaytestMs: 0,
      viewport: { width: 640, height: 360 },
    },
    initialResponse: {
      screenshot,
      state: { url: 'http://example.test' },
    },
    outputDir: path.join(dir, 'agent'),
    modelClient: async () => {
      calls += 1;
      return {
        model: 'fake-model',
        usage: { total_tokens: 1 },
        json: calls === 1
          ? {
              summary: 'ball is in a corridor',
              previous_sequence_outcome: '',
              actions: [{ type: 'key', start: 0, end: 500, key: 'ArrowRight' }],
              should_stop: false,
            }
          : {
              summary: 'ball has moved into the next corridor',
              previous_sequence_outcome: 'ArrowRight rolled the ball into a new visible corridor.',
              actions: [{ type: 'key', start: 0, end: 500, key: 'ArrowRight' }],
              should_stop: true,
            },
      };
    },
    runAction: async () => ({ ok: true, captures: [{ path: screenshot }], endState: { ok: true } }),
  });

  assert.equal(result.steps, 2);
  assert.equal(result.history[0].outcomeSummary, 'ArrowRight rolled the ball into a new visible corridor.');
  assert.equal(result.history[1].outcomeSummary, undefined);
});

test('chat completion honors explicit retry attempts for malformed JSON', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let calls = 0;
  const requestBodies = [];
  process.env.OPENROUTER_API_KEY = 'test-key';
  global.fetch = async (_url, options) => {
    calls += 1;
    requestBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: calls === 1 ? '{"summary": "bad" trailing' : '{"summary": "ok", "actions": []}',
              },
            },
          ],
          usage: { total_tokens: 1 },
        }),
    };
  };

  try {
    const result = await chatCompletion({
      messages: [{ role: 'user', content: 'return JSON' }],
      attempts: 2,
      timeoutMs: 1000,
    });

    assert.equal(calls, 2);
    assert.equal(result.json.summary, 'ok');
    assert.equal(requestBodies[1].messages.length, 2);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});
