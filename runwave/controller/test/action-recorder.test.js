'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ActionRecorder } = require('../src/action-recorder');

test('action recorder removes frames captured after the segment boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-recorder-boundary-'));
  const cdp = { on() {}, off() {} };
  const recorder = new ActionRecorder(cdp, root);
  fs.mkdirSync(recorder.directory, { recursive: true });
  recorder.begin('move', Buffer.from('initial'));
  const endAt = recorder.current.startedAt + 100;
  recorder.append(Buffer.from('late'), 200, 'jpg');
  const lateFile = path.join(recorder.directory, '0000001.jpg');
  recorder.end(Buffer.from('final'), null, endAt);
  await recorder.pending;

  assert.deepEqual(recorder.frames.map((frame) => frame.atMs), [0, 100]);
  assert.equal(fs.readFileSync(lateFile, 'utf8'), 'final');
  fs.rmSync(root, { recursive: true, force: true });
});
