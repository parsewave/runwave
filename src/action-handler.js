const { removeFileIfExists } = require('./file-utils');
const { sessionFile } = require('./paths');
const { assertActionName } = require('./protocol');
const { runStep } = require('./step-runner');

async function readState(browser, input) {
  return browser.state(input.stateExpression);
}

async function writeStateResponse(runtime, input) {
  const { browser, output, paths } = runtime;
  return output.response(input.action_name, {
    ok: true,
    action: 'state',
    action_name: input.action_name,
    sessionDir: paths.runDir,
    state: await readState(browser, input),
  });
}

async function writeScreenshotResponse(runtime, input) {
  const { browser, output, paths } = runtime;
  const outputDir = output.actionDir(input.action_name);
  return output.response(input.action_name, {
    ok: true,
    action: 'screenshot',
    action_name: input.action_name,
    sessionDir: paths.runDir,
    screenshot: await browser.screenshot(outputDir, input.name || 'screenshot'),
    state: await readState(browser, input),
  });
}

async function writeNavigateResponse(runtime, input) {
  const { browser, output, paths } = runtime;
  const isReset = input.action === 'reset';
  const outputDir = output.actionDir(input.action_name);

  await browser.navigate(isReset ? { url: browser.launchUrl } : input);
  if (isReset) runtime.stepIndex = 0;

  return output.response(input.action_name, {
    ok: true,
    action: input.action,
    action_name: input.action_name,
    sessionDir: paths.runDir,
    screenshot: await browser.screenshot(outputDir, '000-after-navigate'),
    state: await readState(browser, input),
  });
}

async function writeStepResponse(runtime, input) {
  const { browser, config, output, paths } = runtime;
  const actionName = input.action_name;
  const outputDir = output.actionDir(actionName);

  runtime.stepIndex += 1;
  const result = await runStep({
    input,
    config,
    browser,
    outputDir,
    nextStepIndex: runtime.stepIndex,
    actionName,
  });

  return output.response(actionName, {
    ...result,
    sessionDir: paths.runDir,
  });
}

async function writeStopResponse(runtime, input) {
  const { browser, config, output, paths } = runtime;
  const outputDir = output.actionDir(input.action_name);
  const finalState = await readState(browser, input);
  const screenshot =
    input.finalScreenshot === false || config.finalScreenshot === false
      ? null
      : await browser.screenshot(outputDir, '999-final');
  const video = await browser.close();

  removeFileIfExists(sessionFile);
  const payload = {
    ok: true,
    action: 'stop',
    action_name: input.action_name,
    sessionDir: paths.runDir,
    state: finalState,
    video,
  };
  if (screenshot) payload.screenshot = screenshot;
  const response = output.response(input.action_name, payload);

  setTimeout(() => process.exit(0), 20);
  return response;
}

async function handleAction(runtime, input) {
  assertActionName(input);

  if (input.action === 'ping') {
    return runtime.output.response(input.action_name, {
      ok: true,
      action: 'ping',
      action_name: input.action_name,
      sessionDir: runtime.paths.runDir,
    });
  }
  if (input.action === 'state') return writeStateResponse(runtime, input);
  if (input.action === 'screenshot') return writeScreenshotResponse(runtime, input);
  if (input.action === 'navigate' || input.action === 'reset') return writeNavigateResponse(runtime, input);
  if (input.action === 'step') return writeStepResponse(runtime, input);
  if (input.action === 'stop') return writeStopResponse(runtime, input);

  throw new Error(`unknown action: ${input.action}`);
}

module.exports = {
  handleAction,
};
