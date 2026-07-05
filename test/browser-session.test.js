const assert = require('node:assert/strict');
const test = require('node:test');

const {
  browserViewportStabilizerScript,
  chromiumLaunchArgs,
  shouldStabilizeBrowserViewport,
} = require('../harness/src/browser-session');

test('chromium launch args leave non-audio runs unchanged', () => {
  const args = chromiumLaunchArgs({ recordAudio: false }, {});

  assert.equal(args.includes('--kiosk'), false);
  assert.equal(args.includes('--start-fullscreen'), false);
  assert.equal(args.some((arg) => arg.startsWith('--window-size=')), false);
});

test('chromium launch args hide browser chrome for audio/video capture', () => {
  const args = chromiumLaunchArgs(
    {
      recordAudio: true,
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

test('chromium launch args can keep browser chrome for debugging', () => {
  const args = chromiumLaunchArgs(
    {
      recordAudio: true,
      viewport: { width: 656, height: 496 },
      audioVideoBrowserChrome: true,
    },
    {}
  );

  assert.ok(args.includes('--window-size=656,496'));
  assert.equal(args.includes('--kiosk'), false);
  assert.equal(args.includes('--start-fullscreen'), false);
});

test('audio/video capture stabilizes browser viewport by default', () => {
  assert.equal(shouldStabilizeBrowserViewport({ recordAudio: true }, {}), true);
  assert.equal(shouldStabilizeBrowserViewport({ recordAudio: false }, {}), false);
  assert.equal(shouldStabilizeBrowserViewport({ recordAudio: true, audioVideoStabilizeViewport: false }, {}), false);
  assert.equal(shouldStabilizeBrowserViewport({ recordAudio: true }, { RUNWAVE_AUDIO_VIDEO_STABILIZE_VIEWPORT: '0' }), false);
});

test('browser viewport stabilizer hides overflow and prevents scrolling keys', () => {
  const source = browserViewportStabilizerScript.toString();

  assert.match(source, /overflow:hidden/);
  assert.match(source, /window\.scrollTo\(0, 0\)/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /preventDefault/);
});
