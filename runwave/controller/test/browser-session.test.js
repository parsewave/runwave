const assert = require('node:assert/strict');
const os = require('os');
const test = require('node:test');

const {
  BrowserSession,
  browserViewportStabilizerScript,
  chromiumLaunchArgs,
  launchHeadless,
  pageViewportVideoSource,
  webLaunchConfig,
} = require('../src/browser-session');
const {
  isRepeatedFrameRemovalEnabled,
  rawVideoPath,
  repeatedFrameRemovalOptions,
} = require('../src/repeated-frame-remover');

test('chromium launch args leave non-recording runs unchanged', () => {
  const args = chromiumLaunchArgs({ record: false }, {});

  assert.equal(args.includes('--kiosk'), false);
  assert.equal(args.includes('--start-fullscreen'), false);
  assert.equal(args.some((arg) => arg.startsWith('--window-size=')), false);
});

test('chromium launch args hide browser chrome for gstreamer capture', () => {
  const args = chromiumLaunchArgs(
    {
      record: true,
      viewport: { width: 656, height: 496 },
      videoSize: { width: 656, height: 496 },
    },
    {}
  );

  assert.ok(args.includes('--window-position=0,0'));
  assert.ok(args.includes('--window-size=656,496'));
  assert.ok(args.includes('--kiosk'));
  assert.ok(args.includes('--start-fullscreen'));
  assert.ok(args.includes('--disable-infobars'));
});

test('recording sessions force a visible headed browser', () => {
  assert.equal(launchHeadless({ record: true }), false);
  assert.equal(launchHeadless({ record: true, headless: true }), false);
  assert.equal(launchHeadless({ record: false }), true);
  assert.equal(launchHeadless({ record: false, headless: false }), false);
});

test('browser launch config defaults game directories to start.sh', () => {
  assert.deepEqual(webLaunchConfig({ gameDir: '/tmp/web-game', port: 4123 }), {
    command: 'bash',
    args: ['start.sh'],
    cwd: '/tmp/web-game',
    env: null,
    port: 4123,
    httpTimeoutMs: 60000,
  });
});

test('page viewport video source crops past browser chrome', async () => {
  const page = {
    evaluate: async () => ({
      screenX: 0,
      screenY: 0,
      outerWidth: 1296,
      outerHeight: 812,
      innerWidth: 1280,
      innerHeight: 720,
    }),
  };

  assert.equal(await pageViewportVideoSource(page, { DISPLAY: ':123' }), ':123+8,92');
});

test('browser viewport stabilizer hides overflow and prevents scrolling keys', () => {
  const source = browserViewportStabilizerScript.toString();

  assert.match(source, /overflow:hidden/);
  assert.match(source, /window\.scrollTo\(0, 0\)/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /preventDefault/);
});

test('repeated frame removal config defaults on for recordings', () => {
  assert.equal(isRepeatedFrameRemovalEnabled({ record: true }), true);
  assert.equal(isRepeatedFrameRemovalEnabled({ recordAudio: true }), true);
  assert.equal(isRepeatedFrameRemovalEnabled({ record: false }), false);
  assert.equal(isRepeatedFrameRemovalEnabled({ record: true, repeatedFrameRemoval: true }), true);
  assert.equal(isRepeatedFrameRemovalEnabled({ record: true, repeatedFrameRemoval: false }), false);
});

test('repeated frame removal options are hard-coded', () => {
  assert.deepEqual(repeatedFrameRemovalOptions(), {
    edgeFrameCount: 10,
    similarityThreshold: 0.98,
    pixelTolerance: 3,
    comparisonWidth: 160,
  });
});

test('rawVideoPath appends raw suffix before extension', () => {
  assert.equal(rawVideoPath('/tmp/video/000-runwave-with-audio.webm'), '/tmp/video/000-runwave-with-audio_raw.webm');
});

test('browser clicks hold the mouse down for the normalized click interval', async () => {
  const session = new BrowserSession({ url: 'about:blank' }, { runDir: os.tmpdir() });
  const calls = [];
  session.page = {
    mouse: {
      move: async (x, y) => calls.push({ type: 'move', x, y }),
      down: async (options) => calls.push({ type: 'down', options, at: Date.now() }),
      up: async (options) => calls.push({ type: 'up', options, at: Date.now() }),
    },
  };

  const startedAt = Date.now();
  await session.click({ type: 'click', start: 100, end: 150, x: 321, y: 222, button: 'left', clickCount: 1 });

  assert.deepEqual(calls.map((call) => call.type), ['move', 'down', 'up']);
  assert.deepEqual(calls[0], { type: 'move', x: 321, y: 222 });
  assert.deepEqual(calls[1].options, { button: 'left', clickCount: 1 });
  assert.deepEqual(calls[2].options, { button: 'left', clickCount: 1 });
  assert.ok(Date.now() - startedAt >= 45);
  assert.deepEqual(session.mousePosition, { x: 321, y: 222 });
});
