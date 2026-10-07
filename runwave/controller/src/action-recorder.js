'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

class ActionRecorder {
  constructor(cdp, directory, config = {}) {
    this.cdp = cdp;
    this.directory = path.join(directory, 'active-recording');
    this.ffmpeg = config.ffmpegPath || 'ffmpeg';
    this.frames = [];
    this.segments = [];
    this.durationMs = 0;
    this.current = null;
    this.error = null;
    this.pending = Promise.resolve();
    this.lastCdpTimestampMs = null;
  }

  async start() {
    await exec(this.ffmpeg, ['-version']);
    fs.mkdirSync(this.directory, { recursive: true });
    this.listener = (event) => {
      // ACK even discarded frames, otherwise Chromium stops the stream.
      this.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch((error) => { this.error ||= error; });
      const cdpTimestampMs = Number(event.metadata?.timestamp) * 1000;
      const segment = this.current;
      if (Number.isFinite(cdpTimestampMs)) this.lastCdpTimestampMs = cdpTimestampMs;
      if (!segment) return;
      // CDP's timestamp is a compositor monotonic clock. Anchor it at the
      // active segment boundary so frame times remain tied to this session.
      let elapsed = performance.now() - segment.startedAt;
      if (Number.isFinite(cdpTimestampMs)) {
        if (!Number.isFinite(segment.cdpStartedAtMs)) segment.cdpStartedAtMs = cdpTimestampMs;
        elapsed = cdpTimestampMs - segment.cdpStartedAtMs;
      }
      if (elapsed < 0) return;
      this.append(Buffer.from(event.data, 'base64'), segment.startMs + Math.max(0, elapsed), 'jpg');
    };
    this.cdp.on('Page.screencastFrame', this.listener);
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
  }

  append(data, atMs, extension) {
    const name = `${String(this.frames.length).padStart(7, '0')}.${extension}`;
    this.frames.push({ file: name, atMs });
    this.pending = this.pending.then(() => fs.promises.writeFile(path.join(this.directory, name), data))
      .catch((error) => { this.error ||= error; });
  }

  begin(action, initialImage) {
    if (this.current) throw new Error('recording action already active');
    this.current = {
      action, startMs: this.durationMs, startedAt: performance.now(), wallStartedAt: Date.now(),
      // The first compositor frame after resume establishes this active
      // segment's CDP time origin; using a pre-resume timestamp would include
      // the model-thinking gap.
      cdpStartedAtMs: Number.NaN, events: [],
    };
    this.append(initialImage, this.durationMs, 'jpg');
  }

  event(event) {
    if (this.current) this.current.events.push({ ...event, videoTimeMs: this.current.startMs + performance.now() - this.current.startedAt });
  }

  end(finalImage, error = null) {
    const segment = this.current;
    if (!segment) return;
    this.current = null;
    this.durationMs = segment.startMs + performance.now() - segment.startedAt;
    this.append(finalImage, this.durationMs, 'jpg');
    this.segments.push({
      action: segment.action, startMs: segment.startMs, endMs: this.durationMs,
      wallStartedAt: segment.wallStartedAt, events: segment.events,
      ...(error ? { error: String(error.message || error) } : {}),
    });
  }

  async stop({ skipCdpStop = false } = {}) {
    let stopError = null;
    try { if (!skipCdpStop) await this.cdp.send('Page.stopScreencast'); }
    catch (error) { stopError = error; }
    finally { this.cdp.off('Page.screencastFrame', this.listener); }
    await this.pending;
    const timeline = path.join(this.directory, 'timeline.json');
    fs.writeFileSync(timeline, JSON.stringify({
      schema: 'runwave/active-timeline/1', timebase: 'active_cdp_monotonic_ms', audio: false,
      timestampNote: 'Same-session CDP compositor frame deltas and host input dispatch times; not engine simulation ticks.',
      durationMs: this.durationMs, segments: this.segments, frames: this.frames,
      ...(stopError ? { warning: `screencast stop failed: ${stopError.message}` } : {}),
    }, null, 2));
    const recordingError = this.error;
    if (!this.frames.length) throw new Error('no active recording frames');
    const ordered = this.frames.slice().sort((a, b) => a.atMs - b.atMs);
    const lines = ['ffconcat version 1.0'];
    for (let index = 0; index < ordered.length; index++) {
      const frame = ordered[index];
      const next = ordered[index + 1];
      lines.push(`file '${frame.file}'`, `duration ${Math.max(0.001, ((next?.atMs ?? frame.atMs + 40) - frame.atMs) / 1000)}`);
    }
    lines.push(`file '${ordered.at(-1).file}'`);
    fs.writeFileSync(path.join(this.directory, 'frames.ffconcat'), lines.join('\n') + '\n');
    const video = path.join(this.directory, 'gameplay.webm');
    await exec(this.ffmpeg, [
      '-y', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', 'frames.ffconcat',
      '-vf', 'scale=in_range=full:out_range=tv,pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-fps_mode', 'vfr', '-c:v', 'libvpx', '-deadline', 'realtime',
      '-cpu-used', '4', '-b:v', '2M', '-an', video,
    ], { cwd: this.directory, timeout: 120000, maxBuffer: 1024 * 1024 });
    if (recordingError) throw recordingError;
    return {
      video, timeline, audio: false, durationMs: this.durationMs,
      ...(stopError ? { warning: stopError.message } : {}),
    };
  }
}

module.exports = { ActionRecorder };
