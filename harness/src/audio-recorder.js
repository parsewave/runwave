const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensureDir, sleep } = require('./file-utils');

const DEFAULT_STOP_WAIT_MS = 3000;
const DEFAULT_START_PROBE_MS = 500;
const DEFAULT_MUX_OFFSET_THRESHOLD_MS = 1;
const DEFAULT_VIDEO_FRAMERATE = 25;
const DEFAULT_INPUT_THREAD_QUEUE_SIZE = 512;

function audioVideoRecorderBackend(config = {}, env = process.env) {
  return String(config.audioVideoRecorder || env.RUNWAVE_AUDIO_VIDEO_RECORDER || 'ffmpeg').toLowerCase();
}

function defaultAudioInputFormat(platform = process.platform) {
  if (platform === 'darwin') return 'avfoundation';
  if (platform === 'win32') return 'dshow';
  return 'pulse';
}

function defaultVideoInputFormat(platform = process.platform) {
  if (platform === 'darwin') return 'avfoundation';
  if (platform === 'win32') return 'gdigrab';
  return 'x11grab';
}

function defaultVideoSource(platform = process.platform, env = process.env) {
  if (platform === 'win32') return 'desktop';
  if (platform === 'darwin') return '1:none';
  const display = env.DISPLAY || ':0';
  const x = Number(env.RUNWAVE_VIDEO_X || 0);
  const y = Number(env.RUNWAVE_VIDEO_Y || 0);
  return `${display}+${Number.isFinite(x) ? x : 0},${Number.isFinite(y) ? y : 0}`;
}

function parseX11VideoSource(source, env = process.env) {
  const fallbackDisplay = env.DISPLAY || ':0';
  const match = String(source || '').match(/^(.*)\+(-?\d+),(-?\d+)$/);
  if (!match) {
    return {
      displayName: String(source || fallbackDisplay),
      x: 0,
      y: 0,
    };
  }
  return {
    displayName: match[1] || fallbackDisplay,
    x: Number(match[2]),
    y: Number(match[3]),
  };
}

function normalizedVideoSize(config) {
  const size = config.videoSize || config.viewport || {};
  const width = Number(size.width);
  const height = Number(size.height);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 1024,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 620,
  };
}

function ffmpegAudioVideoArgs(config, outputPath, platform = process.platform, env = process.env) {
  const audioFormat = config.audioInputFormat || env.RUNWAVE_AUDIO_INPUT_FORMAT || defaultAudioInputFormat(platform);
  const audioSource = config.audioSource || env.RUNWAVE_AUDIO_SOURCE || 'default';
  const videoFormat = config.videoInputFormat || env.RUNWAVE_VIDEO_INPUT_FORMAT || defaultVideoInputFormat(platform);
  const videoSource = config.videoSource || env.RUNWAVE_VIDEO_SOURCE || defaultVideoSource(platform, env);
  const videoSize = normalizedVideoSize(config);
  const framerate = Number(config.videoFramerate || env.RUNWAVE_VIDEO_FRAMERATE || DEFAULT_VIDEO_FRAMERATE);
  const outputFramerate = String(Number.isFinite(framerate) && framerate > 0 ? framerate : DEFAULT_VIDEO_FRAMERATE);
  const queueSize = String(config.inputThreadQueueSize || env.RUNWAVE_INPUT_THREAD_QUEUE_SIZE || DEFAULT_INPUT_THREAD_QUEUE_SIZE);
  const constantFrameRate = config.audioVideoConstantFrameRate !== false &&
    env.RUNWAVE_AUDIO_VIDEO_CFR !== '0';
  const cfrArgs = constantFrameRate ? ['-vf', `fps=${outputFramerate}`, '-r', outputFramerate] : [];
  const useWallclockTimestamps = config.audioVideoWallclockTimestamps === true ||
    env.RUNWAVE_AUDIO_VIDEO_WALLCLOCK_TIMESTAMPS === '1';
  const timestampArgs = useWallclockTimestamps ? ['-use_wallclock_as_timestamps', '1'] : [];
  const outputTimestampArgs = useWallclockTimestamps ? ['-copyts', '-start_at_zero'] : [];
  const pointerArgs = videoFormat === 'x11grab' ? ['-draw_mouse', '0'] : [];
  return [
    '-hide_banner',
    '-loglevel',
    config.audioLogLevel || config.videoLogLevel || 'error',
    '-y',
    '-thread_queue_size',
    queueSize,
    '-f',
    videoFormat,
    ...timestampArgs,
    '-framerate',
    outputFramerate,
    ...pointerArgs,
    '-video_size',
    `${videoSize.width}x${videoSize.height}`,
    '-i',
    videoSource,
    '-thread_queue_size',
    queueSize,
    '-f',
    audioFormat,
    ...timestampArgs,
    '-i',
    audioSource,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    config.videoCodec || 'libvpx',
    ...cfrArgs,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    config.audioCodec || 'libopus',
    ...outputTimestampArgs,
    outputPath,
  ];
}

function gstreamerAudioVideoArgs(config, outputPath, platform = process.platform, env = process.env) {
  if (platform !== 'linux') {
    throw new Error('gstreamer audio/video recording is currently supported only on linux');
  }
  const audioSource = config.audioSource || env.RUNWAVE_AUDIO_SOURCE || 'default';
  const videoSource = config.videoSource || env.RUNWAVE_VIDEO_SOURCE || defaultVideoSource(platform, env);
  const videoSize = normalizedVideoSize(config);
  const framerate = Number(config.videoFramerate || env.RUNWAVE_VIDEO_FRAMERATE || DEFAULT_VIDEO_FRAMERATE);
  const outputFramerate = String(Number.isFinite(framerate) && framerate > 0 ? framerate : DEFAULT_VIDEO_FRAMERATE);
  const capture = parseX11VideoSource(videoSource, env);

  return [
    '-e',
    'ximagesrc',
    `display-name=${capture.displayName}`,
    `startx=${capture.x}`,
    `starty=${capture.y}`,
    `endx=${capture.x + videoSize.width - 1}`,
    `endy=${capture.y + videoSize.height - 1}`,
    'use-damage=false',
    'show-pointer=false',
    '!',
    `video/x-raw,framerate=${outputFramerate}/1,width=${videoSize.width},height=${videoSize.height}`,
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
    `device=${audioSource}`,
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
    `location=${outputPath}`,
  ];
}

function ffmpegAudioArgs(config, audioPath, platform = process.platform) {
  const format = config.audioInputFormat || process.env.RUNWAVE_AUDIO_INPUT_FORMAT || defaultAudioInputFormat(platform);
  const source = config.audioSource || process.env.RUNWAVE_AUDIO_SOURCE || 'default';
  const codec = config.audioCodec || 'libopus';
  return [
    '-hide_banner',
    '-loglevel',
    config.audioLogLevel || 'error',
    '-y',
    '-f',
    format,
    '-i',
    source,
    '-vn',
    '-c:a',
    codec,
    audioPath,
  ];
}

function formatSeconds(ms) {
  return (Math.abs(ms) / 1000).toFixed(6);
}

function ffmpegMuxArgs(config, videoPath, audioPath, outputPath, options = {}) {
  const offsetMs = Number(options.audioOffsetMs ?? config.audioMuxOffsetMs ?? 0);
  const thresholdMs = Number(config.audioMuxOffsetThresholdMs ?? DEFAULT_MUX_OFFSET_THRESHOLD_MS);
  const audioInputArgs = [];
  if (Number.isFinite(offsetMs) && Math.abs(offsetMs) >= thresholdMs) {
    if (offsetMs > 0) {
      audioInputArgs.push('-itsoffset', formatSeconds(offsetMs));
    } else {
      audioInputArgs.push('-ss', formatSeconds(offsetMs));
    }
  }

  return [
    '-hide_banner',
    '-loglevel',
    config.audioLogLevel || 'error',
    '-y',
    '-i',
    videoPath,
    ...audioInputArgs,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    config.audioCodec || 'libopus',
    '-shortest',
    outputPath,
  ];
}

class AudioVideoRecorder {
  constructor(config, runDir, profiler = null, env = process.env) {
    this.config = config;
    this.runDir = runDir;
    this.profiler = profiler;
    this.env = env;
    this.proc = null;
    this.closed = null;
    this.exit = null;
    this.stderr = [];
    this.videoDir = path.join(runDir, 'video');
    this.videoPath = path.join(this.videoDir, config.audioVideoFileName || '000-runwave-with-audio.webm');
  }

  timeSync(event, fields, fn) {
    if (this.profiler) return this.profiler.timeSync(event, fields, fn);
    if (typeof fields === 'function') return fields();
    return fn();
  }

  async time(event, fields, fn) {
    if (this.profiler) return this.profiler.time(event, fields, fn);
    if (typeof fields === 'function') return fields();
    return fn();
  }

  stderrText() {
    return Buffer.concat(this.stderr).toString('utf8').trim();
  }

  async start() {
    this.timeSync('audio_video.start.ensure_video_dir', { dir: this.videoDir }, () => ensureDir(this.videoDir));
    const backend = audioVideoRecorderBackend(this.config, this.env);
    const command = backend === 'gstreamer'
      ? this.config.gstreamerPath || this.env.RUNWAVE_GSTREAMER || 'gst-launch-1.0'
      : this.config.ffmpegPath || this.env.RUNWAVE_FFMPEG || 'ffmpeg';
    const args = backend === 'gstreamer'
      ? gstreamerAudioVideoArgs(this.config, this.videoPath, process.platform, this.env)
      : ffmpegAudioVideoArgs(this.config, this.videoPath, process.platform, this.env);
    this.backend = backend;
    this.proc = this.timeSync('audio_video.start.spawn_recorder', { backend, command, args }, () =>
      spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'], env: this.env })
    );
    this.proc.stderr.on('data', (chunk) => this.stderr.push(Buffer.from(chunk)));
    this.closed = new Promise((resolve) => {
      this.proc.on('error', (error) => {
        this.exit = { code: null, signal: null, error };
        resolve(this.exit);
      });
      this.proc.on('close', (code, signal) => {
        this.exit = { code, signal, error: null };
        resolve(this.exit);
      });
    });

    const probeMs = Number(this.config.audioStartProbeMs ?? DEFAULT_START_PROBE_MS);
    if (probeMs > 0) await this.time('audio_video.start.probe_wait', { probeMs }, () => sleep(probeMs));
    if (this.exit) {
      throw new Error(`${backend} audio/video recorder exited during startup: ${this.exitSummary()}`);
    }
    return this.videoPath;
  }

  exitSummary() {
    if (!this.exit) return 'still running';
    const pieces = [];
    if (this.exit.error) pieces.push(this.exit.error.message);
    if (this.exit.code !== null && this.exit.code !== undefined) pieces.push(`code ${this.exit.code}`);
    if (this.exit.signal) pieces.push(`signal ${this.exit.signal}`);
    const stderr = this.stderrText();
    if (stderr) pieces.push(stderr.slice(-1000));
    return pieces.join(': ') || 'unknown exit';
  }

  async waitForClose(timeoutMs) {
    if (!this.proc || this.exit) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closed.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async stop() {
    if (!this.proc) return null;
    const waitMs = Number(this.config.audioStopWaitMs ?? DEFAULT_STOP_WAIT_MS);

    if (this.backend === 'gstreamer') {
      if (!this.exit) {
        this.timeSync('audio_video.stop.sigint', () => this.proc.kill('SIGINT'));
      }
      if (!(await this.time('audio_video.stop.wait_for_sigint', { waitMs }, () => this.waitForClose(waitMs)))) {
        this.timeSync('audio_video.stop.sigkill', () => this.proc.kill('SIGKILL'));
        await this.closed;
      }
    } else if (!this.exit && this.proc.stdin && !this.proc.stdin.destroyed) {
      this.timeSync('audio_video.stop.request_quit', () => this.proc.stdin.write('q'));

      if (!(await this.time('audio_video.stop.wait_for_quit', { waitMs }, () => this.waitForClose(waitMs)))) {
        this.timeSync('audio_video.stop.sigint', () => this.proc.kill('SIGINT'));
      }
      if (!(await this.time('audio_video.stop.wait_for_sigint', { waitMs }, () => this.waitForClose(waitMs)))) {
        this.timeSync('audio_video.stop.sigkill', () => this.proc.kill('SIGKILL'));
        await this.closed;
      }
    }

    if (this.exit && this.exit.error) {
      throw new Error(`${this.backend || 'recorder'} audio/video recorder failed: ${this.exitSummary()}`);
    }
    if (this.exit && this.exit.code !== 0 && !fs.existsSync(this.videoPath)) {
      throw new Error(`${this.backend || 'recorder'} audio/video recorder failed: ${this.exitSummary()}`);
    }
    return fs.existsSync(this.videoPath) ? this.videoPath : null;
  }
}

module.exports = {
  AudioRecorder: AudioVideoRecorder,
  AudioVideoRecorder,
  audioVideoRecorderBackend,
  defaultAudioInputFormat,
  defaultVideoInputFormat,
  defaultVideoSource,
  ffmpegAudioArgs,
  ffmpegAudioVideoArgs,
  ffmpegMuxArgs,
  gstreamerAudioVideoArgs,
  parseX11VideoSource,
};
