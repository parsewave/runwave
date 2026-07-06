const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { PNG } = require('pngjs');

const {
  BrowserSession,
  browserViewportStabilizerScript,
  chromiumLaunchArgs,
  launchHeadless,
  pageViewportVideoSource,
} = require('../src/browser-session');

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

test('browser screenshot artifacts always keep clean and grid images separate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-browser-screenshot-'));
  const session = new BrowserSession(
    { url: 'about:blank', markGridRows: 4, markGridCols: 4 },
    { runDir: dir }
  );
  session.page = {
    screenshot: async ({ path: file }) => {
      const png = new PNG({ width: 40, height: 30 });
      for (let index = 0; index < png.data.length; index += 4) {
        png.data[index] = 30;
        png.data[index + 1] = 70;
        png.data[index + 2] = 120;
        png.data[index + 3] = 255;
      }
      fs.writeFileSync(file, PNG.sync.write(png));
    },
  };

  try {
    const artifact = await session.screenshotArtifact(dir, 'screen');

    assert.equal(artifact.path, path.join(dir, 'screen.png'));
    assert.equal(artifact.gridPath, path.join(dir, 'screen.grid.png'));
    assert.ok(fs.existsSync(artifact.path));
    assert.ok(fs.existsSync(artifact.gridPath));

    const clean = PNG.sync.read(fs.readFileSync(artifact.path));
    const grid = PNG.sync.read(fs.readFileSync(artifact.gridPath));
    assert.equal(clean.width, 40);
    assert.equal(clean.height, 30);
    assert.ok(grid.width > clean.width);
    assert.ok(grid.height > clean.height);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser screenshot returns the clean screenshot path for compatibility', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-browser-screenshot-'));
  const session = new BrowserSession({ url: 'about:blank' }, { runDir: dir });
  session.page = {
    screenshot: async ({ path: file }) => {
      const png = new PNG({ width: 20, height: 20 });
      fs.writeFileSync(file, PNG.sync.write(png));
    },
  };

  try {
    const screenshot = await session.screenshot(dir, 'compat');

    assert.equal(screenshot, path.join(dir, 'compat.png'));
    assert.ok(fs.existsSync(screenshot));
    assert.ok(fs.existsSync(path.join(dir, 'compat.grid.png')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
