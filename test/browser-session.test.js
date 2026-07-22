const assert = require('node:assert/strict');
const test = require('node:test');

const {
  browserViewportStabilizerScript,
  chromiumLaunchArgs,
  isRepeatedFrameRemovalEnabled,
  repeatedFrameRemovalOptions,
} = require('../controller/src/browser-session');
const { rawVideoPath } = require('../controller/src/repeated-frame-remover');

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

test('browser viewport stabilizer hides overflow and prevents scrolling keys', () => {
  const source = browserViewportStabilizerScript.toString();

  assert.match(source, /overflow:hidden/);
  assert.match(source, /window\.scrollTo\(0, 0\)/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /preventDefault/);
});

test('repeated frame removal config is opt-in', () => {
  assert.equal(isRepeatedFrameRemovalEnabled({ record: true }), false);
  assert.equal(isRepeatedFrameRemovalEnabled({ record: true, repeatedFrameRemoval: true }), true);
  assert.equal(isRepeatedFrameRemovalEnabled({ record: true, repeatedFrameRemoval: { similarityThreshold: 0.98 } }), true);
  assert.equal(isRepeatedFrameRemovalEnabled({ record: true, repeatedFrameRemoval: false }), false);
});

test('repeated frame removal options pass through supported settings', () => {
  assert.deepEqual(repeatedFrameRemovalOptions({
    ffmpegPath: '/opt/ffmpeg',
    repeatedFrameRemoval: {
      edgeFrameCount: 10,
      similarityThreshold: 0.98,
      pixelTolerance: 3,
      comparisonWidth: 160,
    },
  }), {
    edgeFrameCount: 10,
    similarityThreshold: 0.98,
    pixelTolerance: 3,
    comparisonWidth: 160,
    ffmpegPath: '/opt/ffmpeg',
    ffprobePath: undefined,
  });
});

test('rawVideoPath appends raw suffix before extension', () => {
  assert.equal(rawVideoPath('/tmp/video/000-runwave-with-audio.webm'), '/tmp/video/000-runwave-with-audio_raw.webm');
});
