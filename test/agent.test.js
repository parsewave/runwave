'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { normalizeDecision } = require('../agent/src/action-parser');
const { fallbackDecisionAfterInvalidJson, runAgenticPlaytest } = require('../agent/src/agent-player');
const { chatCompletion, parseJsonResponse } = require('../agent/src/model-client');
const { buildPlaytesterPrompt, compactHistory } = require('../agent/src/prompt');
const { normalizeStep } = require('../harness/src/step-normalizer');

test('normalizes model actions into harness steps', () => {
  const decision = normalizeDecision(
    {
      duration_ms: 9000,
      commands: [{ from: 0, to: 5000, key: 'ArrowRight' }, { from: 100, to: 900, key: 'Shift+ArrowRight+Space' }],
      clicks: [{ at: 50, x: 0.5, y: 0.25 }],
      drags: [{ at: 100, from: { x: 0.2, y: 0.25 }, to: { x: 0.4, y: 0.25 }, mode: 'html5' }],
      view_moves: [{ from: 0, to: 500, dx: 50, dy: -10 }],
      should_stop: true,
      summary: 'menu is visible',
      previous_action_outcome: 'Enter opened the menu.',
    },
    { viewport: { width: 1000, height: 600 } }
  );

  assert.equal(decision.durationMs, 8000);
  assert.deepEqual(decision.commands, [
    { from: 0, to: 5000, key: 'ArrowRight' },
    { from: 100, to: 900, key: 'Shift' },
    { from: 100, to: 900, key: 'ArrowRight' },
    { from: 100, to: 900, key: 'Space' },
  ]);
  assert.equal(decision.clicks[0].x, 500);
  assert.equal(decision.clicks[0].y, 150);
  assert.deepEqual(decision.drags[0], {
    at: 100,
    from: { x: 200, y: 150 },
    to: { x: 400, y: 150 },
    button: 'left',
    mode: 'html5',
    steps: 12,
  });
  assert.equal(decision.viewMoves[0].dx, 50);
  assert.equal(decision.shouldStop, true);
  assert.equal(decision.previousActionOutcome, 'Enter opened the menu.');
});

test('normalizes grid-cell model actions into concrete pointer events', () => {
  const decision = normalizeDecision(
    {
      duration_ms: 1500,
      clicks: [{ at: 100, cells: [9] }],
      multi_clicks: [{ at: 200, cells: [18, 19], count: 10 }],
      drags: [{ at: 300, from_cells: [34], to_cells: [35], mode: 'mouse' }],
      cursor_moves: [{ at: 400, cells: [27] }],
    },
    { viewport: { width: 800, height: 800 } }
  );

  assert.equal(decision.clicks.length, 11);
  assert.equal(decision.clicks[0].clickMode, 'single');
  assert.equal(decision.clicks[0].cells[0], 9);
  assert.ok(decision.clicks[0].x >= 100 && decision.clicks[0].x <= 199);
  assert.ok(decision.clicks[0].y >= 100 && decision.clicks[0].y <= 199);
  assert.deepEqual(decision.clicks.slice(1).map((click) => click.at), [200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
  assert.ok(decision.clicks.slice(1).every((click) => click.clickMode === 'multi'));
  assert.ok(decision.clicks.slice(1).every((click) => click.x >= 200 && click.x <= 399));
  assert.ok(decision.clicks.slice(1).every((click) => click.y >= 200 && click.y <= 299));
  assert.ok(decision.drags[0].from.x >= 200 && decision.drags[0].from.x <= 299);
  assert.ok(decision.drags[0].from.y >= 400 && decision.drags[0].from.y <= 499);
  assert.ok(decision.drags[0].to.x >= 300 && decision.drags[0].to.x <= 399);
  assert.ok(decision.drags[0].to.y >= 400 && decision.drags[0].to.y <= 499);
  assert.ok(decision.cursorMoves[0].to.x >= 300 && decision.cursorMoves[0].to.x <= 399);
  assert.ok(decision.cursorMoves[0].to.y >= 300 && decision.cursorMoves[0].to.y <= 399);
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
  assert.deepEqual(step.clicks.slice(1).map((click) => click.at), [200, 300, 400]);
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

test('agent playtest loop calls model and executes returned action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-agent-test-'));
  const screenshot = path.join(dir, 'screen.png');
  const afterScreenshot = path.join(dir, 'after-screen.png');
  fs.writeFileSync(
    screenshot,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  );
  fs.writeFileSync(afterScreenshot, 'different screenshot bytes');

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
        drags: [{ at: 50, from: { x: 100, y: 100 }, to: { x: 130, y: 100 }, mode: 'mouse' }],
        commands: [{ from: 0, to: 500, key: 'Enter' }],
        should_stop: true,
      },
    }),
    runAction: async (action) => {
      actions.push(action);
      return { ok: true, captures: [{ path: afterScreenshot }], endState: { ok: true } };
    },
  });

  assert.equal(result.steps, 1);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'step');
  assert.equal(actions[0].commands[0].key, 'Enter');
  assert.equal(actions[0].drags[0].mode, 'mouse');
  assert.equal(result.history[0].result.ok, true);
  assert.equal(result.history[0].result.screenshot, afterScreenshot);
  assert.equal(result.history[0].result.screenshotChanged, true);
  assert.deepEqual(result.history[0].result.state, { ok: true });
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

test('builds a conservative fallback action after invalid model JSON', () => {
  const decision = fallbackDecisionAfterInvalidJson({
    viewport: { width: 640, height: 360 },
    error: Object.assign(new Error('bad JSON'), { code: 'RUNWAVE_MODEL_JSON_PARSE' }),
    history: [
      {
        step: 1,
        summary: 'board changed',
        commands: [{ from: 0, to: 1000, key: 'ArrowLeft' }],
        clicks: [],
      },
    ],
  });

  assert.equal(decision.durationMs, 1000);
  assert.equal(decision.commands[0].key, 'ArrowLeft');
  assert.equal(decision.clicks.length, 0);
  assert.equal(decision.drags.length, 0);
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
  assert.match(prompt, /drags/);
  assert.match(prompt, /Single Player/);
  assert.match(prompt, /Do not spend turns only describing or waiting on a menu/);
  assert.match(prompt, /8x8 red mark grid/);
  assert.match(prompt, /multi_clicks/);
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

test('agent loop attaches previous action outcome to the prior history step', async () => {
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
              previous_action_outcome: '',
              duration_ms: 500,
              commands: [{ from: 0, to: 500, key: 'ArrowRight' }],
              should_stop: false,
            }
          : {
              summary: 'ball has moved into the next corridor',
              previous_action_outcome: 'ArrowRight rolled the ball into a new visible corridor.',
              duration_ms: 500,
              commands: [{ from: 0, to: 500, key: 'ArrowRight' }],
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
