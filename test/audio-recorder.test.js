const assert = require('node:assert/strict');
const test = require('node:test');

const { defaultAudioInputFormat, ffmpegAudioArgs, ffmpegMuxArgs } = require('../harness/src/audio-recorder');

test('default audio input format follows platform recorder conventions', () => {
  assert.equal(defaultAudioInputFormat('linux'), 'pulse');
  assert.equal(defaultAudioInputFormat('darwin'), 'avfoundation');
  assert.equal(defaultAudioInputFormat('win32'), 'dshow');
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
