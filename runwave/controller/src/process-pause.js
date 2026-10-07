'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const exec = promisify(execFile);

async function processTable() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { timeout: 2000 });
  return stdout.trim().split('\n').map((line) => {
    const [pid, parent, group, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), state };
  });
}

function descendants(table, root) {
  const ids = new Set([root]);
  let size;
  do {
    size = ids.size;
    for (const process of table) if (ids.has(process.parent)) ids.add(process.pid);
  } while (ids.size !== size);
  return table.filter((process) => ids.has(process.pid) && !/[ZX]/.test(process.state));
}

// Only a browser launched by this session, in its own process group, may be
// signalled. Neither the agent, its HTTP server, nor the recorder is stopped.
class ProcessPause {
  constructor(child) {
    this.child = child;
    this.paused = false;
  }

  async tree() {
    if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error('browser process has exited');
    }
    const table = await processTable();
    const root = table.find((item) => item.pid === this.child.pid);
    if (!root || root.group !== root.pid || root.pid === process.pid) {
      throw new Error('browser must have its own isolated process group');
    }
    return descendants(table, root.pid);
  }

  async signal(signal) {
    const tree = await this.tree();
    process.kill(-this.child.pid, signal);
    for (const item of tree) {
      if (item.group === this.child.pid) continue;
      try { process.kill(item.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }

  // Timeout handling must stop the browser immediately; taking another
  // process-table snapshot could itself be blocked by the timed operation.
  forcePause() {
    if (!this.child?.pid) throw new Error('browser process has no pid');
    process.kill(-this.child.pid, 'SIGSTOP');
    this.paused = true;
  }

  async verify(stopped, timeoutMs = 1500) {
    const deadline = performance.now() + timeoutMs;
    do {
      const tree = await this.tree();
      if (tree.length && tree.every((item) => /[Tt]/.test(item.state) === stopped)) return;
      await delay(10);
    } while (performance.now() < deadline);
    throw new Error(`browser ${stopped ? 'pause' : 'resume'} could not be confirmed`);
  }

  async pause() {
    if (this.paused) return this.verify(true);
    await this.signal('SIGSTOP');
    this.paused = true;
    await this.verify(true);
  }

  async resume() {
    if (!this.paused) return this.verify(false);
    await this.signal('SIGCONT');
    this.paused = false;
    await this.verify(false);
  }

  async assertPaused() {
    if (!this.paused) throw new Error('browser observation boundary is not paused');
    await this.verify(true, 100);
  }
}

module.exports = { ProcessPause, descendants };
