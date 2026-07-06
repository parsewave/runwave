const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { cliArgs } = require('../controller/src/api');
const { createProfiler } = require('../controller/src/profiler');

test('CLI strips verbose flags before JSON input is parsed', () => {
  const originalArgv = process.argv;
  try {
    process.argv = ['node', 'runwave', '-v', '{"action":"state","action_name":"profile"}'];
    assert.deepEqual(cliArgs(), {
      inputArgs: ['{"action":"state","action_name":"profile"}'],
      verbose: true,
    });

    process.argv = ['node', 'runwave', '--verbose'];
    assert.deepEqual(cliArgs(), {
      inputArgs: [],
      verbose: true,
    });
  } finally {
    process.argv = originalArgv;
  }
});

test('profiler writes machine-readable timing events', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-profiler-'));
  const logPath = path.join(tmpDir, 'runwave-verbose.ndjson');
  const profiler = createProfiler({ enabled: true, logPath, source: 'test' });

  try {
    profiler.mark('unit.mark', { value: 1 });
    await profiler.time('unit.async', { value: 2 }, async () => 'ok');
    profiler.timeSync('unit.sync', { value: 3 }, () => 'ok');
    profiler.flush();

    const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 3);
    assert.equal(entries[0].type, 'mark');
    assert.equal(entries[0].event, 'unit.mark');
    assert.equal(entries[1].type, 'measure');
    assert.equal(entries[1].event, 'unit.async');
    assert.equal(entries[1].ok, true);
    assert.equal(typeof entries[1].durationMs, 'number');
    assert.equal(entries[2].event, 'unit.sync');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('profiler children share late verbose enablement', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-profiler-child-'));
  const logPath = path.join(tmpDir, 'runwave-verbose.ndjson');
  const profiler = createProfiler({ enabled: false, source: 'parent' });
  const child = profiler.child('child');

  try {
    profiler.enable(logPath);
    child.mark('child.enabled_late');
    profiler.flush();

    const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, 'child');
    assert.equal(entries[0].event, 'child.enabled_late');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
