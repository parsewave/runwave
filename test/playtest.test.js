'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAgentJob } = require('../playtest/playtest');

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

