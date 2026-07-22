const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_EDGE_FRAME_COUNT,
  DEFAULT_PIXEL_TOLERANCE,
  buildVideoFilter,
  buildAudioFilter,
  findRepeatedFrameRemovalRanges,
  frameSimilarity,
  parseFrameMd5Line,
} = require('../src/repeated-frame-remover');

test('parseFrameMd5Line reads frame hash rows', () => {
  assert.deepEqual(
    parseFrameMd5Line('0,          7,          7,        1,  1382400, 4ac1f0bdba53f0f96e5cb4aaa499dfac'),
    {
      streamIndex: 0,
      dts: 7,
      pts: 7,
      duration: 1,
      size: 1382400,
      hash: '4ac1f0bdba53f0f96e5cb4aaa499dfac',
    }
  );
  assert.equal(parseFrameMd5Line('#stream#, dts, pts, duration, size, hash'), null);
});

test('findRepeatedFrameRemovalRanges honors explicit edge frame counts', () => {
  const hashes = [
    ...Array(5).fill('a'),
    ...Array(6).fill('b'),
    ...Array(10).fill('c'),
    ...Array(11).fill('d'),
    ...Array(14).fill('e'),
    'f',
  ];

  assert.deepEqual(findRepeatedFrameRemovalRanges(hashes, { edgeFrameCount: 5 }), [
    {
      start: 26,
      end: 26,
      removedFrames: 1,
      runStart: 21,
      runEnd: 31,
      runLength: 11,
      hash: 'd',
    },
    {
      start: 37,
      end: 40,
      removedFrames: 4,
      runStart: 32,
      runEnd: 45,
      runLength: 14,
      hash: 'e',
    },
  ]);
});

test('buildVideoFilter removes frame ranges and closes timestamps at the original fps', () => {
  assert.equal(
    buildVideoFilter([
      { start: 5, end: 9 },
      { start: 20, end: 22 },
    ], '25'),
    'select=not(between(n\\,5\\,9)+between(n\\,20\\,22)),setpts=N/(25)/TB'
  );
  assert.equal(buildVideoFilter([], '25'), 'setpts=N/(25)/TB');
});

test('frameSimilarity scores normalized byte similarity', () => {
  assert.equal(DEFAULT_EDGE_FRAME_COUNT, 10);
  assert.equal(DEFAULT_SIMILARITY_THRESHOLD, 0.98);
  assert.equal(DEFAULT_PIXEL_TOLERANCE, 3);
  assert.equal(frameSimilarity(Buffer.from([0, 100]), Buffer.from([0, 110])), 0.5);
  assert.equal(frameSimilarity(Buffer.from([0, 100]), Buffer.from([0, 110]), { pixelTolerance: 10 }), 1);
});

test('buildAudioFilter removes matching time spans for removed video frames', () => {
  assert.equal(
    buildAudioFilter([{ start: 5, end: 9 }], '25'),
    'aselect=not(gte(t\\,0.2)*lt(t\\,0.4)),asetpts=N/SR/TB'
  );
});
