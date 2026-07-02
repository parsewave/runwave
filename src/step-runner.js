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

async function runStep({ input, config, browser, outputDir, nextStepIndex, actionName }) {
  const step = normalizeStep(input, config, nextStepIndex);
  const prefix = resultFileName(step.index, actionName);
  const startState = await browser.state(input.stateExpression);
  const captures = await executeTimeline({
    browser,
    events: buildStepTimeline(step),
    duration: step.duration,
    outputDir,
    prefix,
    stateExpression: input.stateExpression,
  });

  const endState = await browser.state(input.stateExpression);
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
    viewMoves: step.viewMoves,
  };
  result.resultPath = path.join(outputDir, `${prefix}.json`);
  writeJson(result.resultPath, result);
  return result;
}

module.exports = {
  runStep,
};
