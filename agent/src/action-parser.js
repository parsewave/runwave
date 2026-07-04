'use strict';

const {
  cellsFromObject,
  clickBurstTimes,
  markGridFromConfig,
  randomPointInCells,
} = require('../../harness/src/mark-grid');

const DEFAULT_DURATION_MS = 500;
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 8000;
const removedSequenceFields = [
  'commands',
  'duration_ms',
  'durationMs',
  'duration',
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
  'previous_action_outcome',
  'previousActionOutcome',
  'action_outcome',
  'outcome_summary',
];

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, number));
}

function cleanKey(value) {
  const key = String(value || '').trim();
  return key || null;
}

function splitKeyChord(key) {
  return String(key)
    .split('+')
    .map((part) => cleanKey(part))
    .filter(Boolean);
}

function rejectRemovedFields(object, fields, label) {
  for (const field of fields) {
    if (object && Object.prototype.hasOwnProperty.call(object, field)) {
      throw new Error(`${label} uses removed field "${field}"`);
    }
  }
}

function timingStart(action, fallback = 0) {
  return finiteNumber(action.start, fallback);
}

function timingEnd(action, fallback = null) {
  return finiteNumber(action.end, fallback);
}

function cleanKeyAction(action, maxDurationMs) {
  if (!action || typeof action !== 'object') return [];
  rejectRemovedFields(action, ['from', 'to', 'at', 'button', 'press'], 'key action');
  const key = cleanKey(action.key);
  if (!key) return [];

  const start = clamp(timingStart(action, 0), 0, maxDurationMs);
  const end = clamp(timingEnd(action, start), start, maxDurationMs);
  if (end <= start) return [];
  return splitKeyChord(key).map((part) => ({ type: 'key', start: Math.round(start), end: Math.round(end), key: part }));
}

function cleanPoint(point, viewport) {
  if (!point || typeof point !== 'object') return null;
  let x = finiteNumber(point.x);
  let y = finiteNumber(point.y);
  if (x === null || y === null) return null;

  if (viewport && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
    x *= viewport.width;
    y *= viewport.height;
  }

  if (viewport) {
    x = clamp(x, 0, viewport.width - 1);
    y = clamp(y, 0, viewport.height - 1);
  }

  return { x: Math.round(x), y: Math.round(y) };
}

function cleanGridPoint(point, viewport) {
  if (!point || typeof point !== 'object' || !viewport) return null;
  const grid = markGridFromConfig({});
  const cells = cellsFromObject(point, grid, 4);
  if (!cells.length) return null;
  try {
    return randomPointInCells(cells, viewport, grid);
  } catch {
    return null;
  }
}

function cleanPointOrGrid(point, viewport) {
  return cleanGridPoint(point, viewport) || cleanPoint(point, viewport);
}

function cleanClick(click, maxDurationMs, viewport) {
  if (!click || typeof click !== 'object') return null;
  rejectRemovedFields(click, ['at', 'from', 'to', 'click_mode', 'clickMode'], 'click action');
  const point = cleanPointOrGrid(click, viewport);
  if (!point) return null;

  const start = clamp(timingStart(click, 0), 0, maxDurationMs);
  return {
    type: 'click',
    start: Math.round(start),
    x: point.x,
    y: point.y,
    button: click.button || 'left',
    clickCount: Math.max(1, Math.round(finiteNumber(click.clickCount, 1))),
    ...(point.cells ? { cells: point.cells, clickMode: 'single' } : {}),
  };
}

function cleanClickIntent(click, maxDurationMs, viewport, forceMulti = false) {
  const base = cleanClick(click, maxDurationMs, viewport);
  if (!base) return [];
  const mode = forceMulti || click.mode === 'multi' ? 'multi' : 'single';
  if (mode !== 'multi') return [{ ...base, clickCount: 1, clickMode: base.cells ? 'single' : base.clickMode }];

  const count = clamp(Math.round(finiteNumber(click.count, 10)), 1, 20);
  const times = clickBurstTimes(base.start, maxDurationMs, count, click.intervalMs ?? 100);
  return times.map((start) => {
    const point = cleanPointOrGrid(click, viewport) || base;
    return {
      type: 'click',
      start,
      x: point.x,
      y: point.y,
      button: base.button,
      clickCount: 1,
      ...(point.cells ? { cells: point.cells, clickMode: 'multi' } : {}),
    };
  });
}

function cleanDrag(drag, maxDurationMs, viewport) {
  if (!drag || typeof drag !== 'object') return null;
  rejectRemovedFields(drag, ['at', 'fromCells', 'toCells', 'x1', 'y1', 'x2', 'y2'], 'drag action');
  const from = cleanPointOrGrid(
    drag.from || { cells: drag.from_cells },
    viewport
  );
  const to = cleanPointOrGrid(
    drag.to || { cells: drag.to_cells },
    viewport
  );
  if (!from || !to) return null;

  const start = clamp(timingStart(drag, 0), 0, maxDurationMs);
  return {
    type: 'drag',
    start: Math.round(start),
    from,
    to,
    button: drag.button || 'left',
    mode: drag.mode === 'html5' ? 'html5' : 'mouse',
    steps: clamp(Math.round(finiteNumber(drag.steps, 12)), 1, 80),
  };
}

function cleanCursorMove(move, maxDurationMs, viewport) {
  if (!move || typeof move !== 'object') return null;
  rejectRemovedFields(move, ['at', 'from', 'target'], 'cursor_move action');
  const point = cleanPointOrGrid(move.to || move, viewport);
  if (!point) return null;

  const start = clamp(timingStart(move, 0), 0, maxDurationMs);
  return {
    type: 'cursor_move',
    start: Math.round(start),
    to: { x: point.x, y: point.y },
    steps: clamp(Math.round(finiteNumber(move.steps, 8)), 1, 80),
    ...(point.cells ? { cells: point.cells } : {}),
  };
}

function cleanViewMove(move, maxDurationMs) {
  if (!move || typeof move !== 'object') return null;
  rejectRemovedFields(move, ['from', 'to', 'deltaX', 'delta_x', 'deltaY', 'delta_y'], 'view_move action');
  const dx = finiteNumber(move.dx, 0);
  const dy = finiteNumber(move.dy, 0);
  if (!dx && !dy) return null;

  const start = clamp(timingStart(move, 0), 0, maxDurationMs);
  const end = clamp(timingEnd(move, start), start, maxDurationMs);
  if (end <= start) return null;

  return {
    type: 'view_move',
    start: Math.round(start),
    end: Math.round(end),
    dx: Math.round(dx),
    dy: Math.round(dy),
    steps: clamp(Math.round(finiteNumber(move.steps, 12)), 1, 80),
  };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function typedActionType(action) {
  const type = String(action.type || '').trim().toLowerCase();
  if (type) return type;
  return '';
}

function normalizeTypedActions(items, maxDurationMs, viewport) {
  const actions = [];

  for (const item of asArray(items)) {
    if (!item || typeof item !== 'object') continue;
    const type = typedActionType(item);
    if (type === 'key') {
      actions.push(...cleanKeyAction(item, maxDurationMs));
    } else if (type === 'click') {
      actions.push(...cleanClickIntent(item, maxDurationMs, viewport));
    } else if (type === 'multi_click') {
      actions.push(...cleanClickIntent(item, maxDurationMs, viewport, true));
    } else if (type === 'drag') {
      const drag = cleanDrag(item, maxDurationMs, viewport);
      if (drag) actions.push(drag);
    } else if (type === 'cursor_move') {
      const move = cleanCursorMove(item, maxDurationMs, viewport);
      if (move) actions.push(move);
    } else if (type === 'view_move') {
      const move = cleanViewMove(item, maxDurationMs);
      if (move) actions.push(move);
    } else {
      throw new Error(`unknown sequence action type: ${type || '(missing)'}`);
    }
  }

  return actions;
}

function actionEnd(action) {
  return Number(action.end ?? action.start ?? 0);
}

function inferDurationMs(actions, fallback = DEFAULT_DURATION_MS) {
  const latest = actions.reduce((max, action) => Math.max(max, actionEnd(action)), 0);
  return Math.max(MIN_DURATION_MS, latest || fallback);
}

function normalizeSequence(raw, options = {}) {
  const viewport = options.viewport || null;
  const maxDurationMs = Number(options.maxDurationMs || MAX_DURATION_MS);
  const data = raw && typeof raw === 'object' ? raw : {};
  rejectRemovedFields(data, removedSequenceFields, 'sequence');
  const actions = normalizeTypedActions(data.actions, maxDurationMs, viewport);

  return {
    durationMs: inferDurationMs(actions, DEFAULT_DURATION_MS),
    actions,
    shouldStop: Boolean(data.should_stop),
    summary: String(data.summary || '').trim().slice(0, 500),
    previousSequenceOutcome: String(data.previous_sequence_outcome ?? '').trim().slice(0, 500),
    rationale: String(data.rationale || '').trim().slice(0, 1000),
  };
}

module.exports = {
  normalizeSequence,
};
