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

test('fleet jobs can enable VLM viewport preflight', () => {
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
    '--vlm-viewport-preflight',
    '--viewport-preflight-attempts',
    '2',
  ]);

  const [job] = buildJobs(args, ['mario-html5']);

  assert.equal(job.vlmViewportPreflight, true);
  assert.equal(job.viewportPreflightAttempts, 2);
});

test('orchestrator can take ssh key from environment', () => {
  const previousRunwaveKey = process.env.RUNWAVE_SSH_KEY;
  const previousSshKey = process.env.SSH_KEY;
  process.env.RUNWAVE_SSH_KEY = '/tmp/runwave-test-key';
  delete process.env.SSH_KEY;
  try {
    const args = parseArgs([
      'node',
      'ops/orchestrate-playtests.js',
      '--inventory',
      'inventory.json',
      '--s3-uri',
      's3://example/runwave',
    ]);
    assert.equal(args.sshKey, '/tmp/runwave-test-key');
  } finally {
    if (previousRunwaveKey === undefined) delete process.env.RUNWAVE_SSH_KEY;
    else process.env.RUNWAVE_SSH_KEY = previousRunwaveKey;
    if (previousSshKey === undefined) delete process.env.SSH_KEY;
    else process.env.SSH_KEY = previousSshKey;
  }
});
