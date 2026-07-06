'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildJobs, parseArgs } = require('../orchestrate-playtests');
const { defaultSshKey } = require('../lib/ssh-key');

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

test('fleet jobs carry mark grid dimensions', () => {
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
    '--mark-grid-rows',
    '16',
    '--mark-grid-cols',
    '24',
  ]);

  const [job] = buildJobs(args, ['mario-html5']);

  assert.equal(job.markGridRows, 16);
  assert.equal(job.markGridCols, 24);
});

test('fleet jobs use WebGL launch args for every game', () => {
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
  ]);

  const [job] = buildJobs(args, ['mario-html5']);

  assert.equal(Object.prototype.hasOwnProperty.call(job, 'requiresHardwareWebgl'), false);
  assert.equal(job.chromiumArgsMode, 'replace');
  assert.ok(job.chromiumArgs.includes('--use-gl=egl'));
  assert.ok(job.chromiumArgs.includes('--enable-unsafe-swiftshader'));
});

test('all fleet jobs receive the same WebGL launch args', () => {
  const args = parseArgs([
    'node',
    'ops/orchestrate-playtests.js',
    '--inventory',
    'inventory.json',
    '--s3-uri',
    's3://example/runwave',
    '--games',
    'mario-html5,2048',
  ]);

  const jobs = buildJobs(args, ['mario-html5', '2048']);

  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].chromiumArgs, jobs[1].chromiumArgs);
  assert.ok(jobs.every((job) => job.chromiumArgsMode === 'replace'));
  assert.ok(jobs.every((job) => !Object.prototype.hasOwnProperty.call(job, 'requiresHardwareWebgl')));
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

test('default ssh key helper prefers RUNWAVE_SSH_KEY over SSH_KEY', () => {
  const key = defaultSshKey({
    env: {
      RUNWAVE_SSH_KEY: '/tmp/runwave-key',
      SSH_KEY: '/tmp/ssh-key',
    },
    homeDir: '/home/tester',
    existsSync: () => false,
  });

  assert.equal(key, '/tmp/runwave-key');
});

test('default ssh key helper falls back to local id_ed25519', () => {
  const key = defaultSshKey({
    env: {},
    homeDir: '/home/tester',
    existsSync: (file) => file === '/home/tester/.ssh/id_ed25519',
  });

  assert.equal(key, '/home/tester/.ssh/id_ed25519');
});

test('default ssh key helper falls back to id_ed25519 path when no key exists', () => {
  const key = defaultSshKey({
    env: {},
    homeDir: '/home/tester',
    existsSync: () => false,
  });

  assert.equal(key, '/home/tester/.ssh/id_ed25519');
});
