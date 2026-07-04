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

const {
  cellsFromObject,
  clickBurstTimes,
  markGridFromConfig,
  randomPointInCells,
  viewportFromConfig,
} = require('./mark-grid');

const removedStepFields = [
  'commands',
  'duration',
  'duration_ms',
  'durationMs',
  'ms',
  'clicks',
  'multi_clicks',
  'multiClicks',
  'drags',
  'drag',
  'cursor_moves',
  'cursorMoves',
  'cursor_move',
  'cursorMove',
  'view_moves',
  'viewMoves',
  'mouse_moves',
  'mouseMoves',
];

function readNumber(value, fallback) {
  return Number(value ?? fallback);
}

function rejectRemovedFields(object, fields, label) {
  for (const field of fields) {
    if (object && Object.prototype.hasOwnProperty.call(object, field)) {
      throw new Error(`${label} uses removed field "${field}"`);
    }
  }
}

function actionStart(action, fallback = 0) {
  return readNumber(action.start, fallback);
}

function actionEnd(action, fallback) {
  return readNumber(action.end, fallback);
}

function rawActionEnd(action) {
  if (!action || typeof action !== 'object') return null;
  const value = action.end ?? action.start;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;

  const type = String(action.type || '').trim().toLowerCase();
  if (type === 'multi_click') {
    const count = Math.max(1, Math.round(readNumber(action.count, 10)));
    const intervalMs = readNumber(action.intervalMs, 100);
    if (Number.isFinite(intervalMs) && intervalMs > 0) return number + (count - 1) * intervalMs;
  }

  return number;
}

function inferDuration(input) {
  const times = [];
  for (const action of input.actions || []) {
    const end = rawActionEnd(action);
    if (end !== null) times.push(end);
  }

  return times.length ? Math.max(...times) : 0;
}

function normalizeDuration(input) {
  const duration = inferDuration(input);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error('sequence duration must be a non-negative number of milliseconds');
  }
  return duration;
}

function normalizeKeyAction(action, aliases) {
  rejectRemovedFields(action, ['from', 'to', 'at', 'button', 'press'], 'key action');
  const start = actionStart(action);
  const end = actionEnd(action, start);
  const keyName = action.key;
  const key = aliases[keyName] || keyName;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    throw new Error(`invalid key action interval: ${JSON.stringify(action)}`);
  }
  if (!key) throw new Error(`key action is missing key: ${JSON.stringify(action)}`);

  return { type: 'key', start, end, keyName, key };
}

function normalizeGridPoint(object, config, label) {
  const grid = markGridFromConfig(config);
  const cells = cellsFromObject(object, grid, 4);
  if (!cells.length) return null;
  try {
    return randomPointInCells(cells, viewportFromConfig(config), grid);
  } catch (error) {
    throw new Error(`${label} ${error.message}`);
  }
}

function normalizePointOrCells(point, label, config) {
  const gridPoint = normalizeGridPoint(point, config, label);
  if (gridPoint) return { x: gridPoint.x, y: gridPoint.y, cells: gridPoint.cells };
  return normalizePoint(point, label);
}

function normalizeClick(click, duration, config, forceMulti = false) {
  rejectRemovedFields(click, ['at', 'from', 'to', 'click_mode', 'clickMode'], 'click action');
  const start = actionStart(click);
  const gridPoint = normalizeGridPoint(click, config, 'click');
  const x = gridPoint ? gridPoint.x : Number(click.x);
  const y = gridPoint ? gridPoint.y : Number(click.y);

  if (!Number.isFinite(start) || start < 0 || start > duration) {
    throw new Error(`invalid click start time: ${JSON.stringify(click)}`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`click action requires numeric x and y: ${JSON.stringify(click)}`);
  }

  const base = {
    type: 'click',
    start,
    x,
    y,
    button: click.button || 'left',
    clickCount: Number(click.clickCount || 1),
  };
  if (!gridPoint && !forceMulti && click.click_mode !== 'multi' && click.clickMode !== 'multi') return [base];

  const mode = forceMulti ? 'multi' : 'single';
  const count = mode === 'multi' ? readNumber(click.count, 10) : 1;
  return clickBurstTimes(start, duration, count, click.intervalMs ?? 100).map((clickStart) => {
    const point = gridPoint ? normalizeGridPoint(click, config, 'click') : { x, y };
    return {
      ...base,
      start: clickStart,
      x: point.x,
      y: point.y,
      clickCount: 1,
      ...(gridPoint ? { cells: gridPoint.cells, clickMode: mode } : {}),
    };
  });
}

function normalizePoint(point, label) {
  const x = Number(point && point.x);
  const y = Number(point && point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} requires numeric x and y: ${JSON.stringify(point)}`);
  }
  return { x, y };
}

function normalizeDrag(drag, duration, config) {
  rejectRemovedFields(drag, ['at', 'fromCells', 'toCells', 'x1', 'y1', 'x2', 'y2'], 'drag action');
  const start = actionStart(drag);
  const from = normalizePointOrCells(
    drag.from || { cells: drag.from_cells },
    'drag.from',
    config
  );
  const to = normalizePointOrCells(
    drag.to || { cells: drag.to_cells },
    'drag.to',
    config
  );
  const steps = Math.max(1, Math.min(80, Math.round(readNumber(drag.steps, 12))));

  if (!Number.isFinite(start) || start < 0 || start > duration) {
    throw new Error(`invalid drag start time: ${JSON.stringify(drag)}`);
  }

  return {
    type: 'drag',
    start,
    from,
    to,
    button: drag.button || 'left',
    mode: drag.mode === 'html5' ? 'html5' : 'mouse',
    steps,
  };
}

function normalizeCursorMove(cursorMove, duration, config) {
  rejectRemovedFields(cursorMove, ['at', 'from', 'target'], 'cursor_move action');
  const start = actionStart(cursorMove);
  const to = normalizePointOrCells(cursorMove.to || cursorMove, 'cursor_move.to', config);
  const steps = Math.max(1, Math.min(80, Math.round(readNumber(cursorMove.steps, 8))));

  if (!Number.isFinite(start) || start < 0 || start > duration) {
    throw new Error(`invalid cursor move start time: ${JSON.stringify(cursorMove)}`);
  }

  return { type: 'cursor_move', start, to, steps };
}

function normalizeViewMove(viewMove, duration) {
  rejectRemovedFields(viewMove, ['from', 'to', 'deltaX', 'delta_x', 'deltaY', 'delta_y'], 'view_move action');
  const start = actionStart(viewMove);
  const end = actionEnd(viewMove, start);
  const dx = Number(viewMove.dx ?? 0);
  const dy = Number(viewMove.dy ?? 0);
  const steps = Math.max(1, Math.min(80, Math.round(readNumber(viewMove.steps, 12))));

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration) {
    throw new Error(`invalid view move interval: ${JSON.stringify(viewMove)}`);
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    throw new Error(`view move action requires numeric dx or dy: ${JSON.stringify(viewMove)}`);
  }

  return { type: 'view_move', start, end, dx, dy, steps };
}

function typedActionType(action) {
  const type = String(action.type || '').trim().toLowerCase();
  if (type) return type;
  return '';
}

function normalizeTypedActions(actions, duration, config, aliases) {
  const result = {
    keyActions: [],
    clicks: [],
    drags: [],
    cursorMoves: [],
    viewMoves: [],
  };

  for (const action of actions || []) {
    if (!action || typeof action !== 'object') continue;
    const type = typedActionType(action);
    if (type === 'key') {
      result.keyActions.push(normalizeKeyAction(action, aliases));
    } else if (type === 'click') {
      result.clicks.push(...normalizeClick(action, duration, config));
    } else if (type === 'multi_click') {
      result.clicks.push(...normalizeClick(action, duration, config, true));
    } else if (type === 'drag') {
      result.drags.push(normalizeDrag(action, duration, config));
    } else if (type === 'cursor_move') {
      result.cursorMoves.push(normalizeCursorMove(action, duration, config));
    } else if (type === 'view_move') {
      result.viewMoves.push(normalizeViewMove(action, duration));
    } else {
      throw new Error(`unknown sequence action type: ${type || '(missing)'}`);
    }
  }

  return result;
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

function normalizeStep(input, config, nextStepIndex) {
  rejectRemovedFields(input, removedStepFields, 'step sequence');
  const aliases = { ...defaultKeyAliases, ...(config.keyAliases || {}) };
  const duration = normalizeDuration(input);
  const typed = normalizeTypedActions(input.actions || [], duration, config, aliases);

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
