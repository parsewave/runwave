'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { normalizeDecision } = require('../agent/src/action-parser');
const { fallbackDecisionAfterInvalidJson, runAgenticPlaytest } = require('../agent/src/agent-player');
const { chatCompletion, parseJsonResponse } = require('../agent/src/model-client');
const { buildPlaytesterPrompt } = require('../agent/src/prompt');

test('normalizes model actions into harness steps', () => {
  const decision = normalizeDecision(
    {
      duration_ms: 9000,
      commands: [{ from: 0, to: 5000, key: 'ArrowRight' }],
      clicks: [{ at: 50, x: 0.5, y: 0.25 }],
      drags: [{ at: 100, from: { x: 0.2, y: 0.25 }, to: { x: 0.4, y: 0.25 }, mode: 'html5' }],
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
        drags: [{ at: 50, from: { x: 100, y: 100 }, to: { x: 130, y: 100 }, mode: 'mouse' }],
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
  assert.equal(actions[0].drags[0].mode, 'mouse');
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
