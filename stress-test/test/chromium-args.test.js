'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { chromiumArgs } = require('../remote/run-playtest');

test('chromium args can replace default WebGL launch args', () => {
  const args = chromiumArgs({
    chromiumArgsMode: 'replace',
    chromiumArgs: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-gl=egl'],
  }, {});

  assert.deepEqual(args, ['--no-sandbox', '--ignore-gpu-blocklist', '--use-gl=egl']);
});

test('default chromium args allow SwiftShader fallback', () => {
  const args = chromiumArgs({}, {});

  assert.ok(args.includes('--use-gl=angle'));
  assert.ok(args.includes('--use-angle=swiftshader'));
  assert.ok(args.includes('--enable-unsafe-swiftshader'));
});
