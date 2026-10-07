'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const { runPlaytest } = require('..');
const exec = promisify(execFile);

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

test('real public API runs the browser controller, frozen model boundary and active video end to end', { timeout: 45000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-full-step-'));
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir);
  fs.writeFileSync(path.join(gameDir, 'start.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(gameDir, 'playtest.md'), 'Click the red button once.');
  const game = http.createServer((_req, res) => res.end('<button onclick="this.textContent=\'Clicked\';this.style.background=\'green\'" style="position:absolute;left:20px;top:20px;width:180px;height:80px;background:red">Start</button>'));
  const port = await listen(game);
  let modelCalls = 0;
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.headers.authorization, 'Bearer local-test-only');
    assert.match(request.messages[0].content[0].text, /controller freezes/);
    modelCalls++;
    await new Promise((resolve) => setTimeout(resolve, 500));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      actions: [{ type: 'click', start: 0, end: 50, x: 60, y: 50 }, { type: 'wait', start: 50, end: 150 }],
      summary: 'Click start and inspect.', should_stop: true,
    }) } }] }));
  });
  const modelPort = await listen(model);
  t.after(async () => {
    await new Promise((resolve) => model.close(resolve));
    await new Promise((resolve) => game.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const summary = await runPlaytest({
    gameDir, outDir: path.join(root, 'out'), port, viewport: { width: 640, height: 360 },
    apiKey: 'local-test-only', baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'fixture-model',
    playtestDurationMs: 400, minPlaytestMs: 100, wallTimeoutMs: 5000, onLog: () => {},
    startOverrides: { waitAfterLoad: 50 },
  });
  assert.equal(summary.status, 'passed');
  assert.equal(modelCalls, 1);
  assert.equal(summary.playtest.steps, 1);
  assert.equal(summary.playtest.gameplayTimeMs, 200);
  assert.equal(summary.recording.audio, false);
  assert.ok(fs.statSync(summary.recording.timeline).size > 0);
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', summary.recording.path]);
  assert.equal(JSON.parse(stdout).streams[0].width, 640);
  const timeline = JSON.parse(fs.readFileSync(summary.recording.timeline));
  assert.equal(timeline.segments.length, 1);
  assert.ok(timeline.segments[0].events.some((event) => event.type === 'click'));
});
