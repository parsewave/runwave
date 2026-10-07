'use strict';

// Installed before page code. Process suspension alone does not stop Date or
// performance clocks: without this shim the first resumed frame can jump.
function installActiveClock() {
  const NativeDate = Date;
  const now = performance.now.bind(performance);
  const timeout = setTimeout.bind(window);
  const clear = clearTimeout.bind(window);
  const raf = requestAnimationFrame.bind(window);
  const caf = cancelAnimationFrame.bind(window);
  let offset = 0;
  let pausedAt = null;
  let nextId = 1;
  const timers = new Map();
  const frames = new Map();
  const animations = new Set();
  const logicalNow = () => (pausedAt ?? now()) - offset;
  const epoch = NativeDate.now() - now();

  function LogicalDate(...args) {
    if (!new.target) return new NativeDate(epoch + logicalNow()).toString();
    return Reflect.construct(NativeDate, args.length ? args : [epoch + logicalNow()], new.target);
  }
  Object.setPrototypeOf(LogicalDate, NativeDate);
  LogicalDate.prototype = NativeDate.prototype;
  LogicalDate.now = () => Math.floor(epoch + logicalNow());
  window.Date = LogicalDate;
  Object.defineProperty(performance, 'now', { configurable: true, value: logicalNow });

  function scheduleTimer(record) {
    if (pausedAt !== null) return;
    record.native = timeout(() => {
      if (!timers.has(record.id)) return;
      if (!record.repeat) timers.delete(record.id);
      try {
        if (typeof record.callback === 'function') record.callback(...record.args);
        else (0, eval)(String(record.callback));
      } finally {
        if (record.repeat && timers.has(record.id)) {
          record.due = logicalNow() + record.delay;
          scheduleTimer(record);
        }
      }
    }, Math.max(0, record.due - logicalNow()));
  }
  function timer(callback, delay, repeat, args) {
    const id = nextId++;
    const ms = Math.max(repeat ? 1 : 0, Number(delay) || 0);
    const record = { id, callback, delay: ms, due: logicalNow() + ms, repeat, args };
    timers.set(id, record);
    scheduleTimer(record);
    return id;
  }
  window.setTimeout = (fn, ms, ...args) => timer(fn, ms, false, args);
  window.setInterval = (fn, ms, ...args) => timer(fn, ms, true, args);
  window.clearTimeout = window.clearInterval = (id) => {
    if (timers.has(id)) clear(timers.get(id).native);
    timers.delete(id);
  };
  function scheduleFrame(record) {
    if (pausedAt !== null) return;
    record.native = raf(() => {
      if (!frames.delete(record.id)) return;
      record.callback(logicalNow());
    });
  }
  window.requestAnimationFrame = (callback) => {
    const id = nextId++;
    const record = { id, callback };
    frames.set(id, record);
    scheduleFrame(record);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (frames.has(id)) caf(frames.get(id).native);
    frames.delete(id);
  };
  window.__runwaveActiveClock = {
    pause() {
      if (pausedAt !== null) return;
      pausedAt = now();
      for (const record of timers.values()) clear(record.native);
      for (const record of frames.values()) caf(record.native);
      for (const animation of document.getAnimations()) {
        if (animation.playState === 'running') { animations.add(animation); animation.pause(); }
      }
    },
    resume() {
      if (pausedAt === null) return;
      offset += now() - pausedAt;
      pausedAt = null;
      for (const record of timers.values()) scheduleTimer(record);
      for (const record of frames.values()) scheduleFrame(record);
      for (const animation of animations) if (animation.playState === 'paused') animation.play();
      animations.clear();
    },
    isPaused: () => pausedAt !== null,
  };
}

module.exports = { installActiveClock };
