'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectRuns, isCleanScreenshot } = require('../build-playtest-viewer');

test('playtest viewer treats grid screenshots as playtester-only artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-viewer-test-'));
  const attempt = path.join(dir, 'candy-crush', 'attempt-001');
  fs.mkdirSync(attempt, { recursive: true });
  fs.writeFileSync(path.join(attempt, 'summary.json'), JSON.stringify({ status: 'passed' }));
  fs.writeFileSync(path.join(attempt, 'play.webm'), 'video');
  fs.writeFileSync(path.join(attempt, '000-initial.grid.png'), 'grid image');
  fs.writeFileSync(path.join(attempt, '000-initial.png'), 'clean image');

  try {
    const out = path.join(dir, 'index.html');
    const runs = collectRuns(dir, out);

    assert.equal(isCleanScreenshot(path.join(attempt, '000-initial.png')), true);
    assert.equal(isCleanScreenshot(path.join(attempt, '000-initial.grid.png')), false);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].poster, 'candy-crush/attempt-001/000-initial.png');
    assert.deepEqual(runs[0].screenshots, ['candy-crush/attempt-001/000-initial.png']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
