const {
  assertAllowedFields,
  inferDurationFromRawActions,
  normalizeActions,
  readNumber,
} = require('./action-normalizer');

const defaultKeyAliases = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  jump: 'Space',
  space: 'Space',
  enter: 'Enter',
  esc: 'Escape',
};

const STEP_FIELDS = new Set([
  'action',
  'action_name',
  'name',
  'actions',
  'captures',
  'autoCaptures',
  'captureIntervalMs',
  'duration',
]);

function normalizeDuration(input) {
  const hasExplicitDuration = Object.prototype.hasOwnProperty.call(input, 'duration');
  const explicit = hasExplicitDuration ? readNumber(input.duration) : null;
  const duration = hasExplicitDuration ? explicit : inferDurationFromRawActions(input.actions);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error('sequence duration must be a non-negative number of milliseconds');
  }
  return duration;
}

function addCapture(captures, capture, duration) {
  const start = Number(capture);
  if (Number.isFinite(start) && start >= 0 && start <= duration) {
    captures.add(Math.round(start));
  }
}

function normalizeCaptures(input, config, duration) {
  const captures = new Set();
  const requestedCaptures = input.captures ? input.captures.map(Number) : [duration];
  for (const capture of requestedCaptures) addCapture(captures, capture, duration);

  const autoCaptures = input.autoCaptures !== false && config.autoCaptures !== false;
  const captureIntervalMs = readNumber(input.captureIntervalMs, config.captureIntervalMs ?? 1000);
  if (autoCaptures && Number.isFinite(captureIntervalMs) && captureIntervalMs > 0) {
    for (let start = captureIntervalMs; start < duration; start += captureIntervalMs) {
      addCapture(captures, start, duration);
    }
    addCapture(captures, duration, duration);
  }

  if (!captures.size) addCapture(captures, duration, duration);
  return Array.from(captures).sort((a, b) => a - b);
}

function bucketActions(actions) {
  const result = {
    keyActions: [],
    clicks: [],
    drags: [],
    cursorMoves: [],
    viewMoves: [],
  };

  for (const action of actions) {
    if (action.type === 'key') result.keyActions.push(action);
    else if (action.type === 'click') result.clicks.push(action);
    else if (action.type === 'drag') result.drags.push(action);
    else if (action.type === 'cursor_move') result.cursorMoves.push(action);
    else if (action.type === 'view_move') result.viewMoves.push(action);
  }

  return result;
}

function normalizeStep(input, config, nextStepIndex) {
  assertAllowedFields(input, STEP_FIELDS, 'step sequence');
  const aliases = { ...defaultKeyAliases, ...(config.keyAliases || {}) };
  const duration = normalizeDuration(input);
  const typed = bucketActions(normalizeActions(input.actions, duration, {
    strict: true,
    config,
    aliases,
    includeKeyName: true,
    cursorCellsOnTarget: true,
  }));

  return {
    index: nextStepIndex,
    name: String(input.name || `step-${String(nextStepIndex).padStart(3, '0')}`),
    duration,
    keyActions: typed.keyActions,
    clicks: typed.clicks,
    drags: typed.drags,
    cursorMoves: typed.cursorMoves,
    viewMoves: typed.viewMoves,
    captures: normalizeCaptures(input, config, duration),
  };
}

module.exports = {
  normalizeStep,
};
