'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAgentJob,
  loadGameMetadata,
  runPlaytest,
  validateRecordingArtifact,
} = require('../playtest/playtest');

test('playtest agent job inherits mark grid dimensions from the start action', () => {
  const job = buildAgentJob({
    maxDuration: 180000,
    minDuration: 120000,
    viewport: { width: 1280, height: 720 },
    playtestInstructions: '# Controls\n\n- Start: Enter.\n',
    start: {
      markGridRows: 16,
      markGridCols: 24,
    },
  });

  assert.equal(job.maxDuration, 180000);
  assert.equal(job.minDuration, 120000);
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

test('playtest metadata is loaded from the game directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-metadata-'));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    viewport: { width: 656.4, height: 496.2 },
  }));

  assert.deepEqual(loadGameMetadata(dir), {
    viewport: { width: 656, height: 496 },
  });
});

test('playtest metadata viewport errors are explicit', () => {
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-metadata-missing-'));
  assert.throws(
    () => loadGameMetadata(missingDir),
    /missing metadata\.json/
  );

  const invalidJsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-metadata-json-'));
  fs.writeFileSync(path.join(invalidJsonDir, 'metadata.json'), '{ nope');
  assert.throws(
    () => loadGameMetadata(invalidJsonDir),
    /invalid JSON/
  );

  const invalidViewportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-metadata-viewport-'));
  fs.writeFileSync(path.join(invalidViewportDir, 'metadata.json'), JSON.stringify({
    viewport: { width: 640 },
  }));
  assert.throws(
    () => loadGameMetadata(invalidViewportDir),
    /viewport \{width,height\} is required/
  );
});

test('runPlaytest rejects caller-provided viewport options', async () => {
  await assert.rejects(
    () => runPlaytest({
      gameDir: '/tmp/game',
      outDir: '/tmp/out',
      port: 7777,
      openRouterApiKey: 'key',
      viewport: { width: 640, height: 480 },
    }),
    /viewport must be defined in game metadata\.json/
  );
});
