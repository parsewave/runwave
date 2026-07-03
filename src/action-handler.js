const { removeFileIfExists } = require('./file-utils');
const { sessionFile } = require('./paths');
const { assertActionName } = require('./protocol');
const { runStep } = require('./step-runner');

async function readState(runtime, input) {
  return runtime.profiler.time('action.state.read', { action_name: input.action_name }, () =>
    runtime.browser.state(input.stateExpression)
  );
}

function withVerboseLog(runtime, payload) {
  if (!runtime.profiler.enabled) return payload;
  return {
    ...payload,
    verboseLog: runtime.paths.verboseLogPath,
  };
}

async function writeStateResponse(runtime, input) {
  const { output, paths } = runtime;
  const payload = await runtime.profiler.time('action.state.build_payload', { action_name: input.action_name }, async () =>
    withVerboseLog(runtime, {
      ok: true,
      action: 'state',
      action_name: input.action_name,
      sessionDir: paths.runDir,
      state: await readState(runtime, input),
    })
  );
  return runtime.profiler.timeSync('action.state.write_response', { action_name: input.action_name }, () =>
    output.response(input.action_name, payload)
  );
}

async function writeScreenshotResponse(runtime, input) {
  const { browser, output, paths } = runtime;
  const outputDir = runtime.profiler.timeSync('action.screenshot.action_dir', { action_name: input.action_name }, () =>
    output.actionDir(input.action_name)
  );
  const payload = withVerboseLog(runtime, {
    ok: true,
    action: 'screenshot',
    action_name: input.action_name,
    sessionDir: paths.runDir,
    screenshot: await runtime.profiler.time('action.screenshot.capture', { action_name: input.action_name }, () =>
      browser.screenshot(outputDir, input.name || 'screenshot')
    ),
    state: await readState(runtime, input),
  });
  return runtime.profiler.timeSync('action.screenshot.write_response', { action_name: input.action_name }, () =>
    output.response(input.action_name, payload)
  );
}

async function writeNavigateResponse(runtime, input) {
  const { browser, output, paths } = runtime;
  const isReset = input.action === 'reset';
  const outputDir = runtime.profiler.timeSync('action.navigate.action_dir', { action_name: input.action_name }, () =>
    output.actionDir(input.action_name)
  );

  await runtime.profiler.time('action.navigate.browser_navigate', { action: input.action, action_name: input.action_name }, () =>
    browser.navigate(isReset ? { url: browser.launchUrl } : input)
  );
  if (isReset) runtime.stepIndex = 0;

  const payload = withVerboseLog(runtime, {
    ok: true,
    action: input.action,
    action_name: input.action_name,
    sessionDir: paths.runDir,
    screenshot: await runtime.profiler.time('action.navigate.screenshot', { action_name: input.action_name }, () =>
      browser.screenshot(outputDir, '000-after-navigate')
    ),
    state: await readState(runtime, input),
  });
  return runtime.profiler.timeSync('action.navigate.write_response', { action_name: input.action_name }, () =>
    output.response(input.action_name, payload)
  );
}

async function writeStepResponse(runtime, input) {
  const { browser, config, output, paths } = runtime;
  const actionName = input.action_name;
  const outputDir = runtime.profiler.timeSync('action.step.action_dir', { action_name: actionName }, () => output.actionDir(actionName));

  runtime.stepIndex += 1;
  runtime.profiler.mark('action.step.index_incremented', { action_name: actionName, stepIndex: runtime.stepIndex });
  const result = await runtime.profiler.time('action.step.run_step', { action_name: actionName, stepIndex: runtime.stepIndex }, () =>
    runStep({
      input,
      config,
      browser,
      outputDir,
      nextStepIndex: runtime.stepIndex,
      actionName,
      profiler: runtime.profiler.child('step-runner'),
    })
  );

  return runtime.profiler.timeSync('action.step.write_response', { action_name: actionName }, () =>
    output.response(actionName, withVerboseLog(runtime, {
      ...result,
      sessionDir: paths.runDir,
    }))
  );
}

async function writeStopResponse(runtime, input) {
  const { browser, config, output, paths } = runtime;
  const outputDir = runtime.profiler.timeSync('action.stop.action_dir', { action_name: input.action_name }, () =>
    output.actionDir(input.action_name)
  );
  const finalState = await readState(runtime, input);
  const screenshot =
    input.finalScreenshot === false || config.finalScreenshot === false
      ? null
      : await runtime.profiler.time('action.stop.screenshot', { action_name: input.action_name }, () =>
          browser.screenshot(outputDir, '999-final')
        );
  const video = await runtime.profiler.time('action.stop.browser_close', { action_name: input.action_name }, () => browser.close());

  runtime.profiler.timeSync('action.stop.remove_session_file', { sessionFile }, () => removeFileIfExists(sessionFile));
  const payload = withVerboseLog(runtime, {
    ok: true,
    action: 'stop',
    action_name: input.action_name,
    sessionDir: paths.runDir,
    state: finalState,
    video,
  });
  if (screenshot) payload.screenshot = screenshot;
  const response = runtime.profiler.timeSync('action.stop.write_response', { action_name: input.action_name }, () =>
    output.response(input.action_name, payload)
  );

  setTimeout(() => process.exit(0), 20);
  return response;
}

async function handleAction(runtime, input) {
  if (input.__runwaveVerbose) runtime.profiler.enable(runtime.paths.verboseLogPath);
  return runtime.profiler.time('action.handle', { action: input.action, action_name: input.action_name }, async () => {
    runtime.profiler.timeSync('action.assert_action_name', { action: input.action }, () => assertActionName(input));

    if (input.action === 'ping') {
      return runtime.profiler.timeSync('action.ping.write_response', { action_name: input.action_name }, () =>
        runtime.output.response(input.action_name, withVerboseLog(runtime, {
          ok: true,
          action: 'ping',
          action_name: input.action_name,
          sessionDir: runtime.paths.runDir,
        }))
      );
    }
    if (input.action === 'state') return writeStateResponse(runtime, input);
    if (input.action === 'screenshot') return writeScreenshotResponse(runtime, input);
    if (input.action === 'navigate' || input.action === 'reset') return writeNavigateResponse(runtime, input);
    if (input.action === 'step') return writeStepResponse(runtime, input);
    if (input.action === 'stop') return writeStopResponse(runtime, input);

    throw new Error(`unknown action: ${input.action}`);
  });
}

module.exports = {
  handleAction,
};
