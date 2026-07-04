const path = require('path');
const { safeName, writeJson } = require('./file-utils');
const { executeTimeline } = require('./step-executor');
const { normalizeStep } = require('./step-normalizer');
const { buildStepTimeline } = require('./step-timeline');

function resultFileName(stepIndex, actionName) {
  return `${String(stepIndex).padStart(3, '0')}-${safeName(actionName)}`;
}

function summarizeCommands(commands) {
  return commands.map(({ from, to, keyName, key }) => ({ from, to, key: keyName, resolvedKey: key }));
}

async function runStep({ input, config, browser, outputDir, nextStepIndex, actionName, profiler }) {
  const timeSync = (event, fields, fn) => (profiler ? profiler.timeSync(event, fields, fn) : fn());
  const time = (event, fields, fn) => (profiler ? profiler.time(event, fields, fn) : fn());

  const step = timeSync('step.normalize', { actionName, nextStepIndex }, () => normalizeStep(input, config, nextStepIndex));
  const prefix = timeSync('step.result_prefix', { actionName, stepIndex: step.index }, () => resultFileName(step.index, actionName));
  const startState = await time('step.start_state', { actionName, stepIndex: step.index }, () => browser.state(input.stateExpression));
  const events = timeSync('step.build_timeline', { actionName, stepIndex: step.index }, () => buildStepTimeline(step));
  if (profiler) {
    profiler.mark('step.timeline_built', {
      actionName,
      stepIndex: step.index,
      duration: step.duration,
      eventCount: events.length,
      commandCount: step.commands.length,
      clickCount: step.clicks.length,
      dragCount: step.drags.length,
      cursorMoveCount: step.cursorMoves.length,
      viewMoveCount: step.viewMoves.length,
      captureCount: events.filter((event) => event.type === 'capture').length,
    });
  }
  const captures = await time('step.execute_timeline', { actionName, stepIndex: step.index, eventCount: events.length }, () =>
    executeTimeline({
      browser,
      events,
      duration: step.duration,
      outputDir,
      prefix,
      stateExpression: input.stateExpression,
      profiler: profiler ? profiler.child('step-executor') : null,
    })
  );

  const endState = await time('step.end_state', { actionName, stepIndex: step.index }, () => browser.state(input.stateExpression));
  const result = {
    action: 'step',
    ok: true,
    step: step.index,
    action_name: actionName,
    name: step.name,
    duration: step.duration,
    startState,
    endState,
    captures,
    commands: summarizeCommands(step.commands),
    clicks: step.clicks,
    drags: step.drags,
    cursorMoves: step.cursorMoves,
    viewMoves: step.viewMoves,
  };
  result.resultPath = path.join(outputDir, `${prefix}.json`);
  timeSync('step.write_result_json', { actionName, resultPath: result.resultPath }, () => writeJson(result.resultPath, result));
  return result;
}

module.exports = {
  runStep,
};
