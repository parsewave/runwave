'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertHardwareWebgl,
  chromiumArgs,
  isSwiftShaderWebgl,
} = require('../ops/remote/run-playtest');

test('chromium args can replace SwiftShader-friendly defaults for hardware WebGL jobs', () => {
  const args = chromiumArgs({
    chromiumArgsMode: 'replace',
    chromiumArgs: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-gl=egl'],
  }, {});

  assert.deepEqual(args, ['--no-sandbox', '--ignore-gpu-blocklist', '--use-gl=egl']);
});

test('hardware WebGL gate rejects SwiftShader renderers', () => {
  assert.equal(isSwiftShaderWebgl({
    unmaskedRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)',
  }), true);

  assert.throws(() => assertHardwareWebgl(
    { game: 'aether-outpost-patrol', requiresHardwareWebgl: true },
    {
      output: {
        state: {
          generic: {
            webgl: {
              supported: true,
              unmaskedRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)',
            },
          },
        },
      },
    }
  ), /hardware WebGL required/);
});

test('hardware WebGL gate allows non-SwiftShader renderers', () => {
  const webgl = assertHardwareWebgl(
    { game: 'aether-outpost-patrol', requiresHardwareWebgl: true },
    {
      output: {
        state: {
          generic: {
            webgl: {
              supported: true,
              unmaskedRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro)',
            },
          },
        },
      },
    }
  );

  assert.match(webgl.unmaskedRenderer, /Metal Renderer/);
});
