'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { signalLongProcess, stopLongProcess } = require('../ops/remote/run-playtest');

function fakeChild(pid = 12345) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function closeWithSignal(child, signal) {
  child.signalCode = signal;
  child.emit('close', null, signal);
}

test('remote process signaling targets the detached process group on unix', () => {
  const calls = [];
  const child = fakeChild(23456);

  const sent = signalLongProcess(child, 'SIGTERM', {
    platform: 'linux',
    kill: (target, signal) => calls.push({ target, signal }),
  });

  assert.equal(sent, true);
  assert.deepEqual(calls, [{ target: -23456, signal: 'SIGTERM' }]);
});

test('remote process cleanup stops after a clean SIGTERM close', async () => {
  const calls = [];
  const child = fakeChild(23456);

  const result = await stopLongProcess(child, {
    label: 'test-game',
    log: () => {},
    platform: 'linux',
    termWaitMs: 100,
    killWaitMs: 100,
    kill: (target, signal) => {
      calls.push({ target, signal });
      if (signal === 'SIGTERM') setImmediate(() => closeWithSignal(child, signal));
    },
  });

  assert.deepEqual(calls, [{ target: -23456, signal: 'SIGTERM' }]);
  assert.deepEqual(result, {
    stopped: true,
    reason: 'terminated',
    pid: 23456,
    signal: 'SIGTERM',
    escalated: false,
  });
});

test('remote process cleanup escalates to SIGKILL after SIGTERM timeout', async () => {
  const calls = [];
  const child = fakeChild(23456);

  const result = await stopLongProcess(child, {
    label: 'test-game',
    log: () => {},
    platform: 'linux',
    termWaitMs: 1,
    killWaitMs: 100,
    kill: (target, signal) => {
      calls.push({ target, signal });
      if (signal === 'SIGKILL') setImmediate(() => closeWithSignal(child, signal));
    },
  });

  assert.deepEqual(calls, [
    { target: -23456, signal: 'SIGTERM' },
    { target: -23456, signal: 'SIGKILL' },
  ]);
  assert.deepEqual(result, {
    stopped: true,
    reason: 'killed',
    pid: 23456,
    signal: 'SIGKILL',
    escalated: true,
  });
});
