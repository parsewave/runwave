const assert = require('node:assert/strict');
const test = require('node:test');

const {
  defaultAudioInputFormat,
  defaultVideoInputFormat,
  defaultVideoSource,
  ffmpegAudioArgs,
  ffmpegAudioVideoArgs,
  ffmpegMuxArgs,
} = require('../harness/src/audio-recorder');

test('default audio input format follows platform recorder conventions', () => {
  assert.equal(defaultAudioInputFormat('linux'), 'pulse');
  assert.equal(defaultAudioInputFormat('darwin'), 'avfoundation');
  assert.equal(defaultAudioInputFormat('win32'), 'dshow');
});

test('default video input format follows platform recorder conventions', () => {
  assert.equal(defaultVideoInputFormat('linux'), 'x11grab');
  assert.equal(defaultVideoInputFormat('darwin'), 'avfoundation');
  assert.equal(defaultVideoInputFormat('win32'), 'gdigrab');
});

test('default linux video source uses display and capture origin', () => {
  assert.equal(defaultVideoSource('linux', { DISPLAY: ':501' }), ':501+0,0');
  assert.equal(defaultVideoSource('linux', { DISPLAY: ':501.0', RUNWAVE_VIDEO_X: '12', RUNWAVE_VIDEO_Y: '34' }), ':501.0+12,34');
});

test('ffmpeg audio args record only audio from configured source', () => {
  const args = ffmpegAudioArgs(
    {
      audioInputFormat: 'pulse',
      audioSource: 'runwave_sink.monitor',
      audioCodec: 'libopus',
      audioLogLevel: 'warning',
    },
    '/tmp/runwave-audio.webm',
    'linux'
  );

  assert.deepEqual(args, [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-f',
    'pulse',
    '-i',
    'runwave_sink.monitor',
    '-vn',
    '-c:a',
    'libopus',
    '/tmp/runwave-audio.webm',
  ]);
});

test('ffmpeg audio/video args capture display and audio in one process', () => {
  const args = ffmpegAudioVideoArgs(
    {
      audioInputFormat: 'pulse',
      audioSource: 'runwave_sink.monitor',
      audioCodec: 'libopus',
      videoInputFormat: 'x11grab',
      videoSource: ':501+0,0',
      videoCodec: 'libvpx',
      videoFramerate: 30,
      videoSize: { width: 656, height: 496 },
      audioLogLevel: 'warning',
    },
    '/tmp/combined.webm',
    'linux',
    {}
  );

  assert.deepEqual(args, [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-thread_queue_size',
    '512',
    '-f',
    'x11grab',
    '-framerate',
    '30',
    '-video_size',
    '656x496',
    '-i',
    ':501+0,0',
    '-thread_queue_size',
    '512',
    '-f',
    'pulse',
    '-i',
    'runwave_sink.monitor',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libvpx',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'libopus',
    '/tmp/combined.webm',
  ]);
});

test('ffmpeg mux args copy video and add opus audio', () => {
  const args = ffmpegMuxArgs(
    { audioCodec: 'libopus' },
    '/tmp/raw.webm',
    '/tmp/audio.webm',
    '/tmp/combined.webm'
  );

  assert.deepEqual(args, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    '/tmp/raw.webm',
    '-i',
    '/tmp/audio.webm',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'libopus',
    '-shortest',
    '/tmp/combined.webm',
  ]);
});

test('ffmpeg mux args delay audio that starts after video', () => {
  const args = ffmpegMuxArgs(
    { audioCodec: 'libopus' },
    '/tmp/raw.webm',
    '/tmp/audio.webm',
    '/tmp/combined.webm',
    { audioOffsetMs: 735 }
  );

  assert.deepEqual(args.slice(6, 11), [
    '-itsoffset',
    '0.735000',
    '-i',
    '/tmp/audio.webm',
    '-map',
  ]);
});

test('ffmpeg mux args trim audio that starts before video', () => {
  const args = ffmpegMuxArgs(
    { audioCodec: 'libopus' },
    '/tmp/raw.webm',
    '/tmp/audio.webm',
    '/tmp/combined.webm',
    { audioOffsetMs: -512 }
  );

  assert.deepEqual(args.slice(6, 11), [
    '-ss',
    '0.512000',
    '-i',
    '/tmp/audio.webm',
    '-map',
  ]);
});
