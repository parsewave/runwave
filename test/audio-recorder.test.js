const assert = require('node:assert/strict');
const test = require('node:test');

const {
  audioVideoArgs,
  defaultVideoSource,
  parseX11VideoSource,
} = require('../harness/src/audio-recorder');

test('default linux video source uses display and capture origin', () => {
  assert.equal(defaultVideoSource('linux', { DISPLAY: ':501' }), ':501+0,0');
  assert.equal(defaultVideoSource('linux', { DISPLAY: ':501.0', RUNWAVE_VIDEO_X: '12', RUNWAVE_VIDEO_Y: '34' }), ':501.0+12,34');
});

test('x11 video source parsing separates display and capture origin', () => {
  assert.deepEqual(parseX11VideoSource(':501+12,34', {}), {
    displayName: ':501',
    x: 12,
    y: 34,
  });
  assert.deepEqual(parseX11VideoSource(':501.0+0,94', {}), {
    displayName: ':501.0',
    x: 0,
    y: 94,
  });
  assert.deepEqual(parseX11VideoSource('', { DISPLAY: ':777' }), {
    displayName: ':777',
    x: 0,
    y: 0,
  });
});

test('audio/video args capture display and pulse audio into webm', () => {
  const args = audioVideoArgs(
    {
      audioSource: 'runwave_sink.monitor',
      videoSource: ':501+0,0',
      videoFramerate: 30,
      videoSize: { width: 656, height: 496 },
    },
    '/tmp/combined.webm',
    'linux',
    {}
  );

  assert.deepEqual(args, [
    '-e',
    'ximagesrc',
    'display-name=:501',
    'startx=0',
    'starty=0',
    'endx=655',
    'endy=495',
    'use-damage=false',
    'show-pointer=false',
    '!',
    'video/x-raw,framerate=30/1,width=656,height=496',
    '!',
    'queue',
    '!',
    'videoconvert',
    '!',
    'vp8enc',
    'deadline=1',
    '!',
    'queue',
    '!',
    'mux.',
    'pulsesrc',
    'device=runwave_sink.monitor',
    '!',
    'audio/x-raw,rate=48000,channels=2',
    '!',
    'queue',
    '!',
    'audioconvert',
    '!',
    'audioresample',
    '!',
    'opusenc',
    '!',
    'queue',
    '!',
    'mux.',
    'webmmux',
    'name=mux',
    '!',
    'filesink',
    'location=/tmp/combined.webm',
  ]);
});

test('audio/video args honor x11 capture origin', () => {
  const args = audioVideoArgs(
    {
      audioSource: 'runwave_sink.monitor',
      videoSource: ':501+0,94',
      videoFramerate: 25,
      videoSize: { width: 656, height: 496 },
    },
    '/tmp/combined.webm',
    'linux',
    {}
  );

  assert.deepEqual(args.slice(0, 8), [
    '-e',
    'ximagesrc',
    'display-name=:501',
    'startx=0',
    'starty=94',
    'endx=655',
    'endy=589',
    'use-damage=false',
  ]);
});
