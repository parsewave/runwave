'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  chromiumArgs,
} = require('../ops/remote/run-playtest');
const { readPageState } = require('../controller/src/state-reader');

test('chromium args can replace default WebGL launch args', () => {
  const args = chromiumArgs({
    chromiumArgsMode: 'replace',
    chromiumArgs: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-gl=egl'],
  }, {});

  assert.deepEqual(args, ['--no-sandbox', '--ignore-gpu-blocklist', '--use-gl=egl']);
});

test('default chromium args allow SwiftShader fallback', () => {
  const args = chromiumArgs({}, {});

  assert.ok(args.includes('--enable-unsafe-swiftshader'));
});

test('WebGL renderer probe is cached and releases its temporary context', async () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousLocation = global.location;
  let contextCount = 0;
  let loseContextCount = 0;

  try {
    global.window = {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
    };
    global.location = { href: 'http://example.test/' };
    global.document = {
      title: 'probe test',
      activeElement: null,
      pointerLockElement: null,
      querySelectorAll: () => [],
      createElement: () => ({
        getContext: () => {
          contextCount += 1;
          return {
            VERSION: 'VERSION',
            SHADING_LANGUAGE_VERSION: 'SHADING_LANGUAGE_VERSION',
            VENDOR: 'VENDOR',
            RENDERER: 'RENDERER',
            getExtension(name) {
              if (name === 'WEBGL_debug_renderer_info') {
                return {
                  UNMASKED_VENDOR_WEBGL: 'UNMASKED_VENDOR_WEBGL',
                  UNMASKED_RENDERER_WEBGL: 'UNMASKED_RENDERER_WEBGL',
                };
              }
              if (name === 'WEBGL_lose_context') {
                return {
                  loseContext() {
                    loseContextCount += 1;
                  },
                };
              }
              return null;
            },
            getParameter(parameter) {
              return {
                VERSION: 'WebGL 1.0',
                SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0',
                VENDOR: 'WebKit',
                RENDERER: 'WebKit WebGL',
                UNMASKED_VENDOR_WEBGL: 'Google Inc.',
                UNMASKED_RENDERER_WEBGL: 'ANGLE SwiftShader',
              }[parameter];
            },
          };
        },
      }),
    };

    const page = { evaluate: async (fn) => fn() };
    const first = await readPageState(page);
    const second = await readPageState(page);

    assert.equal(first.generic.webgl.unmaskedRenderer, 'ANGLE SwiftShader');
    assert.equal(second.generic.webgl.unmaskedRenderer, 'ANGLE SwiftShader');
    assert.equal(contextCount, 1);
    assert.equal(loseContextCount, 1);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.location = previousLocation;
  }
});
