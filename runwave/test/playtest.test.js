'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildAgentJob, buildStartAction, effectiveViewport, validateRecordingArtifact } = require('..');

test('playtest agent job inherits mark grid dimensions from the start action', () => {
  const job = buildAgentJob({
    playtestDurationMs: 180000,
    minPlaytestMs: 120000,
    viewport: { width: 1280, height: 720 },
    playtestInstructions: '# Controls\n\n- Start: Enter.\n',
    start: {
      markGridRows: 16,
      markGridCols: 24,
    },
  });

  assert.equal(Object.prototype.hasOwnProperty.call(job, 'targetKind'), false);
  assert.equal(job.playtestDurationMs, 180000);
  assert.equal(job.agentMinPlaytestMs, 120000);
  assert.deepEqual(job.viewport, { width: 1280, height: 720 });
  assert.deepEqual(job.videoSize, { width: 1280, height: 720 });
  assert.equal(job.playtestInstructions, '# Controls\n\n- Start: Enter.\n');
  assert.equal(job.markGridRows, 16);
  assert.equal(job.markGridCols, 24);
});

test('playtests pass target kind and game directory only to the controller start action', () => {
  const start = buildStartAction({
    targetKind: 'linux',
    runwaveSessionId: 'linux-session',
    viewport: { width: 1280, height: 720 },
    absoluteGameDir: '/games/native',
    startOverrides: {
      windowTitle: 'Native Game',
      windowWaitMs: 30000,
    },
  });

  assert.equal(start.kind, 'linux');
  assert.equal(start.gameDir, '/games/native');
  assert.equal(start.command, undefined);
  assert.equal(start.args, undefined);
  assert.equal(start.cwd, undefined);
  assert.equal(start.windowTitle, 'Native Game');
  assert.equal(start.windowWaitMs, 30000);
  assert.equal(start.url, undefined);
  assert.equal(start.record, true);
  assert.equal(start.force, true);
});

test('agent viewport follows the effective controller state when available', () => {
  assert.deepEqual(
    effectiveViewport({ output: { state: { viewport: { width: 801.3, height: 599.7 } } } }, { width: 1280, height: 720 }),
    { width: 801, height: 600 }
  );
  assert.deepEqual(
    effectiveViewport({ output: { state: {} } }, { width: 1280, height: 720 }),
    { width: 1280, height: 720 }
  );
});

test('playtest recording validation requires a non-empty WebM artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-recording-validation-'));
  const video = path.join(dir, 'play.webm');
  fs.writeFileSync(video, 'webm bytes');

  assert.deepEqual(validateRecordingArtifact({ audioVideo: video }), {
    path: video,
    bytes: 10,
  });
  assert.throws(
    () => validateRecordingArtifact({ video: path.join(dir, 'missing.webm') }),
    /recording is missing/
  );
  assert.throws(
    () => validateRecordingArtifact({}),
    /did not return an audio\/video recording path/
  );
});
