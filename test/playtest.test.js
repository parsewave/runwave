'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildAgentJob, validateRecordingArtifact } = require('../runwave');

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

  assert.equal(job.playtestDurationMs, 180000);
  assert.equal(job.agentMinPlaytestMs, 120000);
  assert.deepEqual(job.viewport, { width: 1280, height: 720 });
  assert.deepEqual(job.videoSize, { width: 1280, height: 720 });
  assert.equal(job.playtestInstructions, '# Controls\n\n- Start: Enter.\n');
  assert.equal(job.markGridRows, 16);
  assert.equal(job.markGridCols, 24);
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
