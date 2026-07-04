const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensureDir, sleep } = require('./file-utils');

const DEFAULT_STOP_WAIT_MS = 3000;
const DEFAULT_START_PROBE_MS = 500;

function defaultAudioInputFormat(platform = process.platform) {
  if (platform === 'darwin') return 'avfoundation';
  if (platform === 'win32') return 'dshow';
  return 'pulse';
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

function ffmpegMuxArgs(config, videoPath, audioPath, outputPath) {
  return [
    '-hide_banner',
    '-loglevel',
    config.audioLogLevel || 'error',
    '-y',
    '-i',
    videoPath,
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

class AudioRecorder {
  constructor(config, runDir, profiler = null) {
    this.config = config;
    this.runDir = runDir;
    this.profiler = profiler;
    this.proc = null;
    this.closed = null;
    this.exit = null;
    this.stderr = [];
    this.audioDir = path.join(runDir, 'audio');
    this.audioPath = path.join(this.audioDir, config.audioFileName || 'runwave-audio.webm');
    this.combinedPath = null;
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
    this.timeSync('audio.start.ensure_audio_dir', { dir: this.audioDir }, () => ensureDir(this.audioDir));
    const ffmpeg = this.config.ffmpegPath || process.env.RUNWAVE_FFMPEG || 'ffmpeg';
    const args = ffmpegAudioArgs(this.config, this.audioPath);
    this.proc = this.timeSync('audio.start.spawn_ffmpeg', { ffmpeg, args }, () =>
      spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
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
    if (probeMs > 0) await this.time('audio.start.probe_wait', { probeMs }, () => sleep(probeMs));
    if (this.exit) {
      throw new Error(`ffmpeg audio recorder exited during startup: ${this.exitSummary()}`);
    }
    return this.audioPath;
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
    if (!this.exit && this.proc.stdin && !this.proc.stdin.destroyed) {
      this.timeSync('audio.stop.request_quit', () => this.proc.stdin.write('q'));
    }

    const waitMs = Number(this.config.audioStopWaitMs ?? DEFAULT_STOP_WAIT_MS);
    if (!(await this.time('audio.stop.wait_for_quit', { waitMs }, () => this.waitForClose(waitMs)))) {
      this.timeSync('audio.stop.sigint', () => this.proc.kill('SIGINT'));
    }
    if (!(await this.time('audio.stop.wait_for_sigint', { waitMs }, () => this.waitForClose(waitMs)))) {
      this.timeSync('audio.stop.sigkill', () => this.proc.kill('SIGKILL'));
      await this.closed;
    }

    if (this.exit && this.exit.error) {
      throw new Error(`ffmpeg audio recorder failed: ${this.exitSummary()}`);
    }
    if (this.exit && this.exit.code !== 0 && !fs.existsSync(this.audioPath)) {
      throw new Error(`ffmpeg audio recorder failed: ${this.exitSummary()}`);
    }
    return fs.existsSync(this.audioPath) ? this.audioPath : null;
  }

  async mux(videoPath, audioPath) {
    if (!videoPath || !audioPath) return null;
    this.combinedPath = path.join(path.dirname(videoPath), this.config.audioVideoFileName || '000-runwave-with-audio.webm');
    const ffmpeg = this.config.ffmpegPath || process.env.RUNWAVE_FFMPEG || 'ffmpeg';
    const args = ffmpegMuxArgs(this.config, videoPath, audioPath, this.combinedPath);
    await this.time('audio.mux.ffmpeg', { ffmpeg, args }, () =>
      new Promise((resolve, reject) => {
        const stderr = [];
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        proc.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg mux exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim().slice(-1000)}`));
        });
      })
    );
    return this.combinedPath;
  }
}

module.exports = {
  AudioRecorder,
  defaultAudioInputFormat,
  ffmpegAudioArgs,
  ffmpegMuxArgs,
};
