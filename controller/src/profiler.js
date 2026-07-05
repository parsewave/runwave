const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

function nowIso() {
  return new Date().toISOString();
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

class Profiler {
  constructor({ enabled = false, logPath = null, source = 'runwave', state = null } = {}) {
    this.state = state || {
      enabled: Boolean(enabled),
      logPath,
      buffer: [],
    };
    this.source = source;
  }

  get enabled() {
    return this.state.enabled;
  }

  get logPath() {
    return this.state.logPath;
  }

  enable(logPath = this.state.logPath) {
    this.state.enabled = true;
    if (logPath) this.setLogPath(logPath);
  }

  setLogPath(logPath) {
    this.state.logPath = logPath;
    if (!this.state.enabled || !this.state.logPath) return;
    this.flush();
  }

  child(source) {
    return new Profiler({ source, state: this.state });
  }

  mark(event, fields = {}) {
    this.write({
      type: 'mark',
      event,
      at: nowIso(),
      fields,
    });
  }

  timeSync(event, fields, fn) {
    if (typeof fields === 'function') {
      fn = fields;
      fields = {};
    }

    const startedAt = nowIso();
    const started = performance.now();
    try {
      const result = fn();
      this.measure(event, startedAt, started, fields, { ok: true });
      return result;
    } catch (error) {
      this.measure(event, startedAt, started, fields, { ok: false, error: error.message });
      throw error;
    }
  }

  async time(event, fields, fn) {
    if (typeof fields === 'function') {
      fn = fields;
      fields = {};
    }

    const startedAt = nowIso();
    const started = performance.now();
    try {
      const result = await fn();
      this.measure(event, startedAt, started, fields, { ok: true });
      return result;
    } catch (error) {
      this.measure(event, startedAt, started, fields, { ok: false, error: error.message });
      throw error;
    }
  }

  measure(event, startedAt, started, fields = {}, outcome = {}) {
    const endedAt = nowIso();
    this.write({
      type: 'measure',
      event,
      startedAt,
      endedAt,
      durationMs: roundMs(performance.now() - started),
      fields,
      ...outcome,
    });
  }

  write(entry) {
    if (!this.enabled) return;
    const payload = {
      ts: nowIso(),
      pid: process.pid,
      source: this.source,
      ...entry,
    };

    if (!this.state.logPath) {
      this.state.buffer.push(payload);
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.state.logPath), { recursive: true });
      if (this.state.buffer.length) {
        fs.appendFileSync(this.state.logPath, this.state.buffer.map((item) => JSON.stringify(item)).join('\n') + '\n');
        this.state.buffer.length = 0;
      }
      fs.appendFileSync(this.state.logPath, `${JSON.stringify(payload)}\n`);
    } catch {
      // Profiling should never change operation behavior.
    }
  }

  flush() {
    if (!this.state.enabled || !this.state.logPath || !this.state.buffer.length) return;
    try {
      fs.mkdirSync(path.dirname(this.state.logPath), { recursive: true });
      fs.appendFileSync(this.state.logPath, this.state.buffer.map((item) => JSON.stringify(item)).join('\n') + '\n');
      this.state.buffer.length = 0;
    } catch {
      // Profiling should never change operation behavior.
    }
  }
}

function createProfiler(options) {
  return new Profiler(options);
}

module.exports = {
  createProfiler,
};
