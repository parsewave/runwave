const assert = require('node:assert/strict');
const os = require('os');
const test = require('node:test');

const {
  BrowserSession,
  browserViewportStabilizerScript,
  chromiumLaunchArgs,
  launchHeadless,
  pageViewportVideoSource,
} = require('../controller/src/browser-session');

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
