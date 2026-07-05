const assert = require('node:assert/strict');
const test = require('node:test');

const {
  audioVideoRecorderBackend,
  defaultAudioInputFormat,
  defaultVideoInputFormat,
  defaultVideoSource,
  ffmpegAudioArgs,
  ffmpegAudioVideoArgs,
  ffmpegMuxArgs,
  gstreamerAudioVideoArgs,
  parseX11VideoSource,
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

test('audio/video recorder backend defaults to ffmpeg and can select gstreamer', () => {
  assert.equal(audioVideoRecorderBackend({}, {}), 'ffmpeg');
  assert.equal(audioVideoRecorderBackend({ audioVideoRecorder: 'gstreamer' }, {}), 'gstreamer');
  assert.equal(audioVideoRecorderBackend({}, { RUNWAVE_AUDIO_VIDEO_RECORDER: 'gstreamer' }), 'gstreamer');
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
    '-draw_mouse',
    '0',
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
    '-vf',
    'fps=30',
    '-r',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'libopus',
    '/tmp/combined.webm',
  ]);
});

test('ffmpeg audio/video args can disable constant frame rate output', () => {
  const args = ffmpegAudioVideoArgs(
    {
      audioInputFormat: 'pulse',
      audioSource: 'runwave_sink.monitor',
      videoInputFormat: 'x11grab',
      videoSource: ':501+0,0',
      videoSize: { width: 656, height: 496 },
      audioVideoConstantFrameRate: false,
    },
    '/tmp/combined.webm',
    'linux',
    {}
  );

  assert.equal(args.includes('-vf'), false);
  assert.equal(args.includes('-r'), false);
});

test('ffmpeg audio/video args can opt into shared wallclock timestamps', () => {
  const args = ffmpegAudioVideoArgs(
    {
      audioInputFormat: 'pulse',
      audioSource: 'runwave_sink.monitor',
      videoInputFormat: 'x11grab',
      videoSource: ':501+0,0',
      videoSize: { width: 656, height: 496 },
      audioVideoWallclockTimestamps: true,
    },
    '/tmp/combined.webm',
    'linux',
    {}
  );

  assert.equal(args.filter((arg) => arg === '-use_wallclock_as_timestamps').length, 2);
  assert.equal(args.includes('-copyts'), true);
  assert.equal(args.includes('-start_at_zero'), true);
});

test('gstreamer audio/video args capture display and pulse audio into webm', () => {
  const args = gstreamerAudioVideoArgs(
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

test('gstreamer audio/video args honor x11 capture origin', () => {
  const args = gstreamerAudioVideoArgs(
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
