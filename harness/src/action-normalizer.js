'use strict';

const {
  cellsFromObject,
  clickBurstTimes,
  markGridFromConfig,
  randomPointInCells,
  viewportFromConfig,
} = require('./mark-grid');

const CELL_FIELDS = ['cells', 'grid_cells', 'gridCells', 'grid_ids', 'gridIds', 'cell', 'grid_id'];
const POINT_FIELDS = new Set(['x', 'y', ...CELL_FIELDS]);

const ACTION_FIELDS = {
  key: new Set(['type', 'start', 'end', 'key']),
  click: new Set(['type', 'start', 'end', 'x', 'y', ...CELL_FIELDS, 'button', 'clickCount']),
  multi_click: new Set(['type', 'start', 'end', 'x', 'y', ...CELL_FIELDS, 'button', 'count', 'intervalMs']),
  drag: new Set(['type', 'start', 'end', 'from', 'to', 'from_cells', 'to_cells', 'button', 'mode', 'steps']),
  cursor_move: new Set(['type', 'start', 'end', 'to', 'x', 'y', ...CELL_FIELDS, 'steps']),
  view_move: new Set(['type', 'start', 'end', 'dx', 'dy', 'steps']),
};

function assertAllowedFields(object, allowedFields, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return;
  for (const field of Object.keys(object)) {
    if (!allowedFields.has(field)) {
      throw new Error(`${label} contains unknown field "${field}"`);
    }
  }
}

function readNumber(value, fallback = null) {
  return Number(value ?? fallback);
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, number));
}

function actionType(action) {
  return String((action && action.type) || '').trim().toLowerCase();
}

function assertActionFields(action) {
  const type = actionType(action);
  const allowed = ACTION_FIELDS[type];
  if (!allowed) throw new Error(`unknown sequence action type: ${type || '(missing)'}`);
  assertAllowedFields(action, allowed, `${type} action`);
  return type;
}

function asActionArray(actions) {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions)) throw new Error('sequence actions must be an array');
  return actions;
}

function splitKeyChord(key) {
  return String(key)
    .split('+')
    .map((part) => String(part || '').trim())
    .filter(Boolean);
}

function timingStart(action, fallback = 0) {
  return readNumber(action.start, fallback);
}

function timingEnd(action, fallback = null) {
  return readNumber(action.end, fallback);
}

function actionEnd(action) {
  const end = finiteNumber(action.end, null);
  if (end !== null) return end;
  return finiteNumber(action.start, 0);
}

function actionStartEnd(action) {
  const start = finiteNumber(action.start, null);
  const end = finiteNumber(action.end, null);
  if (end !== null) return end;
  return start;
}

function rawActionEnd(action) {
  if (!action || typeof action !== 'object') return null;
  const type = actionType(action);

  if (type === 'multi_click') {
    const start = finiteNumber(action.start, null);
    if (start === null || start < 0) return null;
    const count = Math.max(1, Math.round(finiteNumber(action.count, 10)));
    const intervalMs = finiteNumber(action.intervalMs, 100);
    if (Number.isFinite(intervalMs) && intervalMs > 0) return start + (count - 1) * intervalMs;
    return start;
  }

  if (type === 'key' || type === 'view_move' || type === 'click' || type === 'drag' || type === 'cursor_move') {
    const end = actionStartEnd(action);
    return Number.isFinite(end) && end >= 0 ? end : null;
  }

  return null;
}

function inferDurationFromRawActions(actions) {
  const times = [];
  for (const action of asActionArray(actions)) {
    const end = rawActionEnd(action);
    if (end !== null) times.push(end);
  }
  return times.length ? Math.max(...times) : 0;
}

function pickPointerFields(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const field of ['x', 'y', ...CELL_FIELDS]) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
  }
  return out;
}

function normalizePoint(point, label, options) {
  assertAllowedFields(point, POINT_FIELDS, label);

  const grid = markGridFromConfig(options.config || {});
  const viewport = options.viewport || viewportFromConfig(options.config || {});
  const cells = cellsFromObject(point, grid, 4);
  if (cells.length) {
    try {
      return randomPointInCells(cells, viewport, grid);
    } catch (error) {
      if (options.strict) throw new Error(`${label} ${error.message}`);
      return null;
    }
  }

  if (!point || typeof point !== 'object') {
    if (options.strict) throw new Error(`${label} requires numeric x and y: ${JSON.stringify(point)}`);
    return null;
  }

  let x = finiteNumber(point.x, null);
  let y = finiteNumber(point.y, null);
  if (x === null || y === null) {
    if (options.strict) throw new Error(`${label} requires numeric x and y: ${JSON.stringify(point)}`);
    return null;
  }

  if (options.scaleUnitPoints && viewport && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
    x *= Number(viewport.width);
    y *= Number(viewport.height);
  }

  if (options.clampToViewport && viewport) {
    x = clamp(x, 0, Number(viewport.width) - 1);
    y = clamp(y, 0, Number(viewport.height) - 1);
  }

  return options.roundPoints ? { x: Math.round(x), y: Math.round(y) } : { x, y };
}

function normalizePointerActionPoint(action, label, options) {
  return normalizePoint(pickPointerFields(action), label, options);
}

function validStart(start, duration) {
  return Number.isFinite(start) && start >= 0 && start <= duration;
}

function normalizeKeyAction(action, options) {
  const keyName = action.key;
  const key = (options.aliases || {})[keyName] || keyName;
  if (!key) {
    if (options.strict) throw new Error(`key action is missing key: ${JSON.stringify(action)}`);
    return [];
  }

  const start = options.strict ? timingStart(action) : clamp(finiteNumber(action.start, 0), 0, options.maxDurationMs);
  const end = options.strict ? timingEnd(action, start) : clamp(finiteNumber(action.end, start), start, options.maxDurationMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    if (options.strict) throw new Error(`invalid key action interval: ${JSON.stringify(action)}`);
    return [];
  }
  if (!options.strict && end <= start) return [];

  const parts = options.splitKeyChords ? splitKeyChord(key) : [key];
  return parts.map((part) => {
    const normalized = {
      type: 'key',
      start: options.roundTimes ? Math.round(start) : start,
      end: options.roundTimes ? Math.round(end) : end,
    };
    if (options.includeKeyName) normalized.keyName = keyName;
    normalized.key = part;
    return normalized;
  });
}

function normalizeClickAction(click, duration, options, forceMulti = false) {
  const start = options.strict ? timingStart(click) : clamp(finiteNumber(click.start, 0), 0, options.maxDurationMs);
  if (options.strict && !validStart(start, duration)) {
    throw new Error(`invalid click start time: ${JSON.stringify(click)}`);
  }

  const point = normalizePointerActionPoint(click, 'click', options);
  if (!point) return [];

  const base = {
    type: 'click',
    start: options.roundTimes ? Math.round(start) : start,
    x: point.x,
    y: point.y,
    button: click.button || 'left',
    clickCount: forceMulti ? 1 : Math.max(1, Math.round(finiteNumber(click.clickCount, 1))),
  };
  if (point.cells) {
    base.cells = point.cells;
  }

  if (!forceMulti) return [base];

  const times = clickBurstTimes(start, duration, finiteNumber(click.count, 10), finiteNumber(click.intervalMs, 100));
  return times.map((clickStart) => {
    const nextPoint = normalizePointerActionPoint(click, 'click', options) || point;
    const action = {
      type: 'click',
      start: clickStart,
      x: nextPoint.x,
      y: nextPoint.y,
      button: base.button,
      clickCount: 1,
    };
    if (nextPoint.cells) {
      action.cells = nextPoint.cells;
    }
    return action;
  });
}

function normalizeDragAction(drag, duration, options) {
  const start = options.strict ? timingStart(drag) : clamp(finiteNumber(drag.start, 0), 0, options.maxDurationMs);
  if (options.strict && !validStart(start, duration)) {
    throw new Error(`invalid drag start time: ${JSON.stringify(drag)}`);
  }

  const from = normalizePoint(drag.from || { cells: drag.from_cells }, 'drag.from', options);
  const to = normalizePoint(drag.to || { cells: drag.to_cells }, 'drag.to', options);
  if (!from || !to) return [];

  return [{
    type: 'drag',
    start: options.roundTimes ? Math.round(start) : start,
    from,
    to,
    button: drag.button || 'left',
    mode: drag.mode === 'html5' ? 'html5' : 'mouse',
    steps: clamp(Math.round(finiteNumber(drag.steps, 12)), 1, 80),
  }];
}

function normalizeCursorMoveAction(move, duration, options) {
  const start = options.strict ? timingStart(move) : clamp(finiteNumber(move.start, 0), 0, options.maxDurationMs);
  if (options.strict && !validStart(start, duration)) {
    throw new Error(`invalid cursor move start time: ${JSON.stringify(move)}`);
  }

  const point = normalizePoint(move.to || pickPointerFields(move), 'cursor_move.to', options);
  if (!point) return [];

  const action = {
    type: 'cursor_move',
    start: options.roundTimes ? Math.round(start) : start,
    to: options.cursorCellsOnTarget ? point : { x: point.x, y: point.y },
    steps: clamp(Math.round(finiteNumber(move.steps, 8)), 1, 80),
  };
  if (!options.cursorCellsOnTarget && point.cells) action.cells = point.cells;
  return [action];
}

function normalizeViewMoveAction(move, duration, options) {
  const start = options.strict ? timingStart(move) : clamp(finiteNumber(move.start, 0), 0, options.maxDurationMs);
  const end = options.strict ? timingEnd(move, start) : clamp(finiteNumber(move.end, start), start, options.maxDurationMs);
  const dx = options.strict ? readNumber(move.dx, 0) : finiteNumber(move.dx, 0);
  const dy = options.strict ? readNumber(move.dy, 0) : finiteNumber(move.dy, 0);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || (options.strict && end > duration)) {
    if (options.strict) throw new Error(`invalid view move interval: ${JSON.stringify(move)}`);
    return [];
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    if (options.strict) throw new Error(`view move action requires numeric dx or dy: ${JSON.stringify(move)}`);
    return [];
  }
  if (!options.strict && end <= start) return [];

  return [{
    type: 'view_move',
    start: options.roundTimes ? Math.round(start) : start,
    end: options.roundTimes ? Math.round(end) : end,
    dx: options.roundPoints ? Math.round(dx) : dx,
    dy: options.roundPoints ? Math.round(dy) : dy,
    steps: clamp(Math.round(finiteNumber(move.steps, 12)), 1, 80),
  }];
}

function normalizeAction(action, duration, options) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    if (options.strict) throw new Error(`invalid sequence action: ${JSON.stringify(action)}`);
    return [];
  }

  const type = assertActionFields(action);
  if (type === 'key') return normalizeKeyAction(action, options);
  if (type === 'click') return normalizeClickAction(action, duration, options);
  if (type === 'multi_click') return normalizeClickAction(action, duration, options, true);
  if (type === 'drag') return normalizeDragAction(action, duration, options);
  if (type === 'cursor_move') return normalizeCursorMoveAction(action, duration, options);
  if (type === 'view_move') return normalizeViewMoveAction(action, duration, options);
  return [];
}

function normalizeActions(actions, duration, options) {
  const normalized = [];
  for (const action of asActionArray(actions)) {
    normalized.push(...normalizeAction(action, duration, options));
  }
  return normalized;
}

module.exports = {
  assertAllowedFields,
  actionEnd,
  asActionArray,
  inferDurationFromRawActions,
  normalizeActions,
  readNumber,
};
