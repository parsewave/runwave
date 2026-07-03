'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildJobs, parseArgs } = require('../ops/orchestrate-playtests');

test('agent fleet jobs default minimum play time to near full duration', () => {
  const args = parseArgs([
    'node',
    'ops/orchestrate-playtests.js',
    '--inventory',
    'inventory.json',
    '--s3-uri',
    's3://example/runwave',
    '--games',
    'mario-html5',
    '--agent',
    '--playtest-duration-ms',
    '120000',
  ]);

  const [job] = buildJobs(args, ['mario-html5']);

  assert.equal(job.playMode, 'agent');
  assert.equal(job.playtestDurationMs, 120000);
  assert.equal(job.agentMinPlaytestMs, 110000);
});

test('agent fleet jobs allow explicit minimum play time override', () => {
  const args = parseArgs([
    'node',
    'ops/orchestrate-playtests.js',
    '--inventory',
    'inventory.json',
    '--s3-uri',
    's3://example/runwave',
    '--games',
    'mario-html5',
    '--agent',
    '--playtest-duration-ms',
    '180000',
    '--agent-min-playtest-ms',
    '170000',
  ]);

  const [job] = buildJobs(args, ['mario-html5']);

  assert.equal(job.playMode, 'agent');
  assert.equal(job.playtestDurationMs, 180000);
  assert.equal(job.agentMinPlaytestMs, 170000);
});
