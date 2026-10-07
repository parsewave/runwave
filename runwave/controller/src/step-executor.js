const { sleep } = require('./file-utils');

function elapsedSince(startedAt) {
  return Date.now() - startedAt;
}

async function waitUntil(startedAt, offsetMs, profiler, fields = {}) {
  const wait = offsetMs - elapsedSince(startedAt);
  if (wait > 0) {
    if (profiler) await profiler.time('timeline.wait', { ...fields, offsetMs, waitMs: wait }, () => sleep(wait));
    else await sleep(wait);
  } else if (profiler) {
    profiler.mark('timeline.wait.skipped', { ...fields, offsetMs, waitMs: wait });
  }
}

async function captureAt({ browser, outputDir, prefix, stateExpression, at, profiler }) {
  return {
    at,
    path: profiler
      ? await profiler.time('timeline.capture.screenshot', { at }, () =>
          browser.screenshot(outputDir, `${prefix}-${String(at).padStart(5, '0')}ms`)
        )
      : await browser.screenshot(outputDir, `${prefix}-${String(at).padStart(5, '0')}ms`),
    state: profiler
      ? await profiler.time('timeline.capture.state', { at }, () => browser.state(stateExpression))
      : await browser.state(stateExpression),
  };
}

async function releasePressedKeys(browser, pressed, profiler) {
  for (const key of pressed) {
    const event = { type: 'up', at: null, action: { key } };
    browser.recordInput?.({ phase: 'dispatch', cleanup: true, ...event });
    if (profiler) await profiler.time('timeline.cleanup.key_up', { key }, () => browser.keyUp(key));
    else await browser.keyUp(key);
    browser.recordInput?.({ phase: 'completed', cleanup: true, ...event });
  }
}

async function executeTimeline({ browser, events, duration, outputDir, prefix, stateExpression, profiler }) {
  if (browser.stepped) return executeSteppedTimeline({ browser, events, duration });
  const pressed = new Set();
  const captures = [];
  const startedAt = Date.now();

  try {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const fields = { eventIndex: index, type: event.type, at: event.at };
      if (profiler) profiler.mark('timeline.event.ready', fields);
      await waitUntil(startedAt, event.at, profiler, fields);
      if (browser.recordInput && event.type !== 'capture') browser.recordInput({ phase: 'dispatch', ...event });

      if (event.type === 'down') {
        if (profiler) await profiler.time('timeline.event.key_down', { ...fields, key: event.action.key }, () => browser.keyDown(event.action.key));
        else await browser.keyDown(event.action.key);
        pressed.add(event.action.key);
      } else if (event.type === 'up') {
        if (profiler) await profiler.time('timeline.event.key_up', { ...fields, key: event.action.key }, () => browser.keyUp(event.action.key));
        else await browser.keyUp(event.action.key);
        pressed.delete(event.action.key);
      } else if (event.type === 'click') {
        if (profiler) {
          await profiler.time('timeline.event.click', { ...fields, x: event.click.x, y: event.click.y }, () => browser.click(event.click));
        } else {
          await browser.click(event.click);
        }
      } else if (event.type === 'cursor_move') {
        if (profiler) {
          await profiler.time('timeline.event.cursor_move', {
            ...fields,
            x: event.cursorMove.to.x,
            y: event.cursorMove.to.y,
            steps: event.cursorMove.steps,
          }, () => browser.moveCursor(event.cursorMove));
        } else {
          await browser.moveCursor(event.cursorMove);
        }
      } else if (event.type === 'drag') {
        if (profiler) {
          await profiler.time('timeline.event.drag', {
            ...fields,
            fromX: event.drag.from.x,
            fromY: event.drag.from.y,
            toX: event.drag.to.x,
            toY: event.drag.to.y,
            mode: event.drag.mode,
          }, () => browser.drag(event.drag));
        } else {
          await browser.drag(event.drag);
        }
      } else if (event.type === 'view_move') {
        if (profiler) {
          await profiler.time('timeline.event.view_move', {
            ...fields,
            dx: event.viewMove.dx,
            dy: event.viewMove.dy,
            steps: event.viewMove.steps,
          }, () => browser.moveView(event.viewMove));
        } else {
          await browser.moveView(event.viewMove);
        }
      } else if (event.type === 'capture') {
        captures.push(await (profiler
          ? profiler.time('timeline.event.capture', fields, () =>
              captureAt({ browser, outputDir, prefix, stateExpression, at: event.at, profiler })
            )
          : captureAt({ browser, outputDir, prefix, stateExpression, at: event.at })));
      }
      if (profiler) profiler.mark('timeline.event.done', { ...fields, elapsedMs: elapsedSince(startedAt) });
      if (browser.recordInput && event.type !== 'capture') browser.recordInput({ phase: 'completed', ...event });
    }

    await waitUntil(startedAt, duration, profiler, { type: 'duration_end' });
  } finally {
    if (profiler) profiler.mark('timeline.cleanup.start', { pressedKeyCount: pressed.size });
    await releasePressedKeys(browser, pressed, profiler);
    if (profiler) profiler.mark('timeline.cleanup.end');
  }

  if (profiler) profiler.mark('timeline.complete', { duration, elapsedMs: elapsedSince(startedAt), captureCount: captures.length });
  return captures;
}

async function executeSteppedTimeline({ browser, events, duration }) {
  const startedAt = performance.now();
  const pressed = new Set();
  let failure = null;
  const wait = async (at) => {
    const remaining = at - (performance.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  };
  const drive = async (selected) => {
    for (const event of selected) {
      await wait(event.at);
      if (failure) return;
      browser.recordInput?.({ phase: 'dispatch', ...event });
      try {
        if (event.type === 'down') { await browser.keyDown(event.action.key); pressed.add(event.action.key); }
        if (event.type === 'up') { await browser.keyUp(event.action.key); pressed.delete(event.action.key); }
        if (event.type === 'click') await browser.click(event.click);
        if (event.type === 'drag') await browser.drag(event.drag);
        if (event.type === 'cursor_move') await browser.moveCursor(event.cursorMove);
        if (event.type === 'view_move') await browser.moveView(event.viewMove);
        browser.recordInput?.({ phase: 'completed', ...event });
      } catch (error) { failure ||= error; return; }
    }
  };
  try {
    // Pointer operations can take time. They must not postpone key-up deadlines.
    await Promise.all([
      drive(events.filter((event) => ['down', 'up'].includes(event.type))),
      drive(events.filter((event) => !['down', 'up', 'capture'].includes(event.type))),
    ]);
    if (failure) throw failure;
    await wait(duration);
  } finally {
    await releasePressedKeys(browser, pressed);
  }
  return [];
}

module.exports = {
  executeTimeline,
  executeSteppedTimeline,
};
