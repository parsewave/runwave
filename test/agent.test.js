'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { normalizeSequence } = require('../agent/src/action-parser');
const { fallbackSequenceAfterInvalidJson, runAgenticPlaytest } = require('../agent/src/agent-player');
const { chatCompletion, parseJsonResponse } = require('../agent/src/model-client');
const { buildPlaytesterPrompt, compactHistory } = require('../agent/src/prompt');
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
  assert.deepEqual(drag, {
    type: 'drag',
    start: 100,
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
    { viewport: { width: 800, height: 800 } }
  );

  const clicks = sequence.actions.filter((action) => action.type === 'click');
  const drag = sequence.actions.find((action) => action.type === 'drag');
  const cursorMove = sequence.actions.find((action) => action.type === 'cursor_move');
  assert.equal(clicks.length, 11);
  assert.equal(clicks[0].clickMode, 'single');
  assert.equal(clicks[0].cells[0], 9);
  assert.ok(clicks[0].x >= 100 && clicks[0].x <= 199);
  assert.ok(clicks[0].y >= 100 && clicks[0].y <= 199);
  assert.deepEqual(clicks.slice(1).map((click) => click.start), [200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
  assert.ok(clicks.slice(1).every((click) => click.clickMode === 'multi'));
  assert.ok(clicks.slice(1).every((click) => click.x >= 200 && click.x <= 399));
  assert.ok(clicks.slice(1).every((click) => click.y >= 200 && click.y <= 299));
  assert.ok(drag.from.x >= 200 && drag.from.x <= 299);
  assert.ok(drag.from.y >= 400 && drag.from.y <= 499);
  assert.ok(drag.to.x >= 300 && drag.to.x <= 399);
  assert.ok(drag.to.y >= 400 && drag.to.y <= 499);
  assert.ok(cursorMove.to.x >= 300 && cursorMove.to.x <= 399);
  assert.ok(cursorMove.to.y >= 300 && cursorMove.to.y <= 399);
});

test('normalizes legacy top-level pointer actions for compatibility', () => {
  const sequence = normalizeSequence(
    {
      duration_ms: 1500,
      clicks: [{ at: 100, cells: [9] }],
      multi_clicks: [{ at: 200, cells: [18], count: 2 }],
      drags: [{ at: 300, from_cells: [34], to_cells: [35], mode: 'mouse' }],
      cursor_moves: [{ at: 400, cells: [27] }],
      view_moves: [{ from: 500, to: 800, dx: 10, dy: -5 }],
    },
    { viewport: { width: 800, height: 800 } }
  );

  assert.equal(sequence.actions.filter((action) => action.type === 'click').length, 3);
  assert.equal(sequence.actions.filter((action) => action.type === 'drag').length, 1);
  assert.equal(sequence.actions.filter((action) => action.type === 'cursor_move').length, 1);
  assert.deepEqual(sequence.actions.find((action) => action.type === 'view_move'), {
    type: 'view_move',
    start: 500,
    end: 800,
    dx: 10,
    dy: -5,
    steps: 12,
  });
});

test('normalizes harness grid-cell steps into concrete pointer events', () => {
  const step = normalizeStep(
    {
      duration: 1200,
      clicks: [{ at: 100, cells: [0] }],
      multi_clicks: [{ at: 200, cells: [63], count: 3 }],
      drags: [{ at: 300, from_cells: [8], to_cells: [15] }],
      cursor_moves: [{ at: 400, cells: [7] }],
    },
    { viewport: { width: 800, height: 800 } },
    1
  );

  assert.equal(step.clicks.length, 4);
  assert.deepEqual(step.clicks.slice(1).map((click) => click.start), [200, 300, 400]);
  assert.ok(step.clicks[0].x >= 0 && step.clicks[0].x <= 99);
  assert.ok(step.clicks[0].y >= 0 && step.clicks[0].y <= 99);
  assert.ok(step.clicks.slice(1).every((click) => click.x >= 700 && click.x <= 799));
  assert.ok(step.clicks.slice(1).every((click) => click.y >= 700 && click.y <= 799));
  assert.ok(step.drags[0].from.x >= 0 && step.drags[0].from.x <= 99);
  assert.ok(step.drags[0].from.y >= 100 && step.drags[0].from.y <= 199);
  assert.ok(step.drags[0].to.x >= 700 && step.drags[0].to.x <= 799);
  assert.ok(step.drags[0].to.y >= 100 && step.drags[0].to.y <= 199);
  assert.ok(step.cursorMoves[0].to.x >= 700 && step.cursorMoves[0].to.x <= 799);
  assert.ok(step.cursorMoves[0].to.y >= 0 && step.cursorMoves[0].to.y <= 99);
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
  assert.equal(harnessSteps[0].actions.find((action) => action.type === 'key').key, 'Enter');
  assert.equal(harnessSteps[0].actions.find((action) => action.type === 'drag').mode, 'mouse');
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

test('parses fenced nested JSON responses from vision models', () => {
  const parsed = parseJsonResponse(`
Here is the next action:
\`\`\`json
{
  "summary": "title screen is visible",
  "duration_ms": 1000,
  "commands": [{"from": 0, "to": 500, "key": "Enter"}],
  "clicks": [{"at": 100, "x": 320, "y": 180}],
  "should_stop": false
}
\`\`\`
`);

  assert.equal(parsed.summary, 'title screen is visible');
  assert.equal(parsed.commands[0].key, 'Enter');
  assert.equal(parsed.clicks[0].x, 320);
});

test('recovers JSON with bare repeated string fragments before the closing brace', () => {
  const parsed = parseJsonResponse(`{
  "summary": "The board changed.",
  "previous_action_outcome": "The previous ArrowRight move shifted the board.",
  "duration_ms": 1500,
  "commands": [
    {"from": 0, "to": 300, "key": "ArrowRight"},
    {"from": 400, "to": 700, "key": "ArrowDown"}
  ],
  "clicks": [],
  "drags": [],
  "view_moves": [],
  "should_stop": false,
  "rationale": "Sliding right and down will merge tiles in the bottom-right corner."
."
right corner."
 corner."
}`);

  assert.equal(parsed.summary, 'The board changed.');
  assert.equal(parsed.previous_action_outcome, 'The previous ArrowRight move shifted the board.');
  assert.equal(parsed.commands[0].key, 'ArrowRight');
  assert.equal(parsed.rationale, 'Sliding right and down will merge tiles in the bottom-right corner.');
});

test('recovers JSON with repeated bare rationale continuation lines', () => {
  const parsed = parseJsonResponse(`{
  "summary": "The menu is still visible.",
  "duration_ms": 1000,
  "commands": [],
  "clicks": [
    {
      "at": 100,
      "x": 500,
      "y": 660
    }
  ],
  "drags": [],
  "view_moves": [],
  "should_stop": false,
  "rationale": "I will try clicking it again."
clicking it again."
to see if it registers."
}`);

  assert.equal(parsed.summary, 'The menu is still visible.');
  assert.equal(parsed.clicks[0].x, 500);
  assert.equal(parsed.rationale, 'I will try clicking it again.');
});

test('recovers JSON by dropping duplicated content after a bare fragment tail', () => {
  const parsed = parseJsonResponse(`{
  "summary": "The player ship is on the bottom right.",
  "duration_ms": 2000,
  "commands": [
    {"from": 0, "to": 500, "key": "ArrowLeft"},
    {"from": 600, "to": 800, "key": "Space"}
  ],
  "clicks": [],
  "drags": [],
  "view_moves": [],
  "should_stop": false,
  "rationale": "Moving left while shooting to clear them."
clear them."
[
  {
    "summary": "duplicate response",
    "duration_ms": 2000,
    "commands": []
  }
]`);

  assert.equal(parsed.summary, 'The player ship is on the bottom right.');
  assert.equal(parsed.commands.length, 2);
  assert.equal(parsed.rationale, 'Moving left while shooting to clear them.');
});

test('tags malformed model JSON parse errors', () => {
  assert.throws(
    () => parseJsonResponse('{"summary": "almost valid", "commands": [] trailing'),
    (error) => {
      assert.equal(error.code, 'RUNWAVE_MODEL_JSON_PARSE');
      assert.match(error.message, /JSON/);
      return true;
    }
  );
});

test('builds a conservative fallback sequence after invalid model JSON', () => {
  const sequence = fallbackSequenceAfterInvalidJson({
    viewport: { width: 640, height: 360 },
    error: Object.assign(new Error('bad JSON'), { code: 'RUNWAVE_MODEL_JSON_PARSE' }),
    history: [
      {
        step: 1,
        summary: 'board changed',
        actions: [{ type: 'key', start: 0, end: 1000, key: 'ArrowLeft' }],
        clicks: [],
      },
    ],
  });

  assert.equal(sequence.durationMs, 1000);
  assert.equal(sequence.actions[0].key, 'ArrowLeft');
  assert.equal(sequence.actions.filter((action) => action.type === 'click').length, 0);
  assert.equal(sequence.actions.filter((action) => action.type === 'drag').length, 0);
});

test('playtester prompt warns when recent actions repeat', () => {
  const prompt = buildPlaytesterPrompt({
    job: {},
    elapsedMs: 10000,
    maxMs: 120000,
    viewport: { width: 1280, height: 720 },
    state: {},
    history: [
      { step: 1, summary: 'game is paused', commands: [], clicks: [{ x: 960, y: 719 }] },
      { step: 2, summary: 'game is paused', commands: [], clicks: [{ x: 963, y: 719 }] },
      { step: 3, summary: 'game is paused', commands: [], clicks: [{ x: 963, y: 719 }] },
    ],
  });

  assert.match(prompt, /Warning:/);
  assert.match(prompt, /Space, Enter, Escape, and P/);
  assert.match(prompt, /"type": "drag"/);
  assert.match(prompt, /Single Player/);
  assert.match(prompt, /Do not spend turns only describing or waiting on a menu/);
  assert.match(prompt, /8x8 red mark grid/);
  assert.match(prompt, /"type": "multi_click"/);
  assert.match(prompt, /Each action must have a "type"/);
  assert.match(prompt, /"actions":/);
  assert.match(prompt, /"start": 0/);
  assert.match(prompt, /"end": 300/);
  assert.doesNotMatch(prompt, /"commands":/);
  assert.doesNotMatch(prompt, /duration_ms/);
  assert.doesNotMatch(prompt, /"clicks":/);
  assert.doesNotMatch(prompt, /"multi_clicks":/);
});

test('playtester prompt warns when recent actions repeat a control cycle up to 5 steps', () => {
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
      commands: [{ key }],
      clicks: [],
      drags: [],
    })),
  });

  assert.match(prompt, /Warning: the recent sequences repeated a 4-step control cycle/);
  assert.match(prompt, /ArrowRight -> ArrowUp -> ArrowLeft -> ArrowDown/);
  assert.match(prompt, /Break the loop now/);
});

test('compact history includes post-action result signals', () => {
  const text = compactHistory([
    {
      step: 1,
      summary: 'ball moved through a corridor',
      commands: [{ key: 'ArrowRight' }],
      clicks: [],
      drags: [],
      result: { ok: true, screenshotChanged: true, captureCount: 1 },
      outcomeSummary: 'The ball rolled right and the camera followed into a new corridor.',
    },
  ]);

  assert.match(text, /controls=ArrowRight/);
  assert.match(text, /post_action=ok=true,screenshot_changed=true,captures=1/);
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
                content: calls === 1 ? '{"summary": "bad" trailing' : '{"summary": "ok", "commands": []}',
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
