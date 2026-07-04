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

function timingStart(action, fallback = 0) {
  return finiteNumber(action.start ?? action.at ?? action.from, fallback);
}

function timingEnd(action, fallback = null) {
  return finiteNumber(action.end ?? action.to, fallback);
}

function cleanKeyAction(action, maxDurationMs) {
  if (!action || typeof action !== 'object') return [];
  const key = cleanKey(action.key ?? action.button ?? action.press);
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
    ...(point.cells ? { cells: point.cells, clickMode: click.click_mode || click.clickMode || 'single' } : {}),
  };
}

function cleanClickIntent(click, maxDurationMs, viewport, forceMulti = false) {
  const base = cleanClick(click, maxDurationMs, viewport);
  if (!base) return [];
  const mode = forceMulti || click.click_mode === 'multi' || click.clickMode === 'multi' || click.mode === 'multi' ? 'multi' : 'single';
  if (mode !== 'multi') return [{ ...base, clickCount: 1, clickMode: base.cells ? 'single' : base.clickMode }];

  const count = clamp(Math.round(finiteNumber(click.count ?? click.clicks, 10)), 1, 20);
  const times = clickBurstTimes(base.start, maxDurationMs, count, click.interval_ms ?? click.intervalMs ?? 100);
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
  const legacyStartPoint = drag.start && typeof drag.start === 'object' ? drag.start : null;
  const legacyEndPoint = drag.end && typeof drag.end === 'object' ? drag.end : null;
  const from = cleanPointOrGrid(
    drag.from || legacyStartPoint || { x: drag.x1, y: drag.y1, cells: drag.from_cells ?? drag.fromCells },
    viewport
  );
  const to = cleanPointOrGrid(
    drag.to || legacyEndPoint || { x: drag.x2, y: drag.y2, cells: drag.to_cells ?? drag.toCells },
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
  const point = cleanPointOrGrid(move.to || move.target || move, viewport);
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
  const dx = finiteNumber(move.dx ?? move.deltaX ?? move.delta_x, 0);
  const dy = finiteNumber(move.dy ?? move.deltaY ?? move.delta_y, 0);
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

function unwrapSequence(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (raw.sequence && typeof raw.sequence === 'object') return { ...raw.sequence, ...raw };
  if (raw.action && typeof raw.action === 'object') return { ...raw.action, ...raw };
  if (raw.next_sequence && typeof raw.next_sequence === 'object') return { ...raw.next_sequence, ...raw };
  if (raw.next_action && typeof raw.next_action === 'object') return { ...raw.next_action, ...raw };
  return raw;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function typedActionType(action) {
  const type = String(action.type || action.kind || action.action || '').trim().toLowerCase();
  if (type) return type.replace(/-/g, '_');
  return cleanKey(action.key ?? action.button ?? action.press) ? 'key' : '';
}

function normalizeTypedActions(items, maxDurationMs, viewport) {
  const actions = [];

  for (const item of asArray(items)) {
    if (!item || typeof item !== 'object') continue;
    const type = typedActionType(item);
    if (type === 'key' || type === 'keyboard' || type === 'press') {
      actions.push(...cleanKeyAction(item, maxDurationMs));
    } else if (type === 'click' || type === 'single_click' || type === 'tap') {
      actions.push(...cleanClickIntent(item, maxDurationMs, viewport));
    } else if (type === 'multi_click' || type === 'multiclick' || type === 'multi_tap' || type === 'tap_burst') {
      actions.push(...cleanClickIntent(item, maxDurationMs, viewport, true));
    } else if (type === 'drag' || type === 'swipe') {
      const drag = cleanDrag(item, maxDurationMs, viewport);
      if (drag) actions.push(drag);
    } else if (type === 'cursor_move' || type === 'cursor' || type === 'move_cursor') {
      const move = cleanCursorMove(item, maxDurationMs, viewport);
      if (move) actions.push(move);
    } else if (type === 'view_move' || type === 'view' || type === 'mouse_move' || type === 'look') {
      const move = cleanViewMove(item, maxDurationMs);
      if (move) actions.push(move);
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
  const data = unwrapSequence(raw);
  const typedActions = normalizeTypedActions(data.actions || data.commands, maxDurationMs, viewport);
  const legacyActions = [
    ...(data.clicks || []).flatMap((click) => cleanClickIntent(click, maxDurationMs, viewport)),
    ...asArray(data.multi_clicks || data.multiClicks).flatMap((click) => cleanClickIntent(click, maxDurationMs, viewport, true)),
    ...asArray(data.drags || data.drag).map((drag) => cleanDrag(drag, maxDurationMs, viewport)).filter(Boolean),
    ...asArray(data.cursor_moves || data.cursorMoves || data.cursor_move || data.cursorMove)
      .map((move) => cleanCursorMove(move, maxDurationMs, viewport))
      .filter(Boolean),
    ...asArray(data.view_moves || data.viewMoves).map((move) => cleanViewMove(move, maxDurationMs)).filter(Boolean),
  ];
  const actions = [...typedActions, ...legacyActions];

  return {
    durationMs: inferDurationMs(actions, finiteNumber(data.duration_ms ?? data.durationMs ?? data.duration, DEFAULT_DURATION_MS)),
    actions,
    shouldStop: Boolean(data.should_stop ?? data.shouldStop),
    summary: String(data.summary || data.observation_summary || '').trim().slice(0, 500),
    previousSequenceOutcome: String(
      data.previous_sequence_outcome ??
        data.previousSequenceOutcome ??
        data.sequence_outcome ??
        data.previous_action_outcome ??
        data.previousActionOutcome ??
        data.action_outcome ??
        data.outcome_summary ??
        ''
    ).trim().slice(0, 500),
    rationale: String(data.rationale || data.reason || '').trim().slice(0, 1000),
  };
}

module.exports = {
  normalizeSequence,
  normalizeDecision: normalizeSequence,
};
