const { sleep } = require('./file-utils');

function elapsedSince(startedAt) {
  return Date.now() - startedAt;
}

async function waitUntil(startedAt, offsetMs) {
  const wait = offsetMs - elapsedSince(startedAt);
  if (wait > 0) await sleep(wait);
}

async function captureAt({ browser, outputDir, prefix, stateExpression, at }) {
  return {
    at,
    path: await browser.screenshot(outputDir, `${prefix}-${String(at).padStart(5, '0')}ms`),
    state: await browser.state(stateExpression),
  };
}

async function releasePressedKeys(browser, pressed) {
  for (const key of pressed) await browser.keyUp(key);
}

async function executeTimeline({ browser, events, duration, outputDir, prefix, stateExpression }) {
  const pressed = new Set();
  const captures = [];
  const startedAt = Date.now();

  try {
    for (const event of events) {
      await waitUntil(startedAt, event.at);

      if (event.type === 'down') {
        await browser.keyDown(event.command.key);
        pressed.add(event.command.key);
      } else if (event.type === 'up') {
        await browser.keyUp(event.command.key);
        pressed.delete(event.command.key);
      } else if (event.type === 'click') {
        await browser.click(event.click);
      } else if (event.type === 'view_move') {
        await browser.moveView(event.viewMove);
      } else if (event.type === 'capture') {
        captures.push(await captureAt({ browser, outputDir, prefix, stateExpression, at: event.at }));
      }
    }

    await waitUntil(startedAt, duration);
  } finally {
    await releasePressedKeys(browser, pressed);
  }

  return captures;
}

module.exports = {
  executeTimeline,
};
