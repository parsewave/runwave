'use strict';

const DEFAULT_DURATION_MS = 2500;
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

function cleanCommand(command, durationMs) {
  if (!command || typeof command !== 'object') return null;
  const key = cleanKey(command.key ?? command.button ?? command.press);
  if (!key) return null;

  const from = clamp(finiteNumber(command.from ?? command.start, 0), 0, durationMs);
  const to = clamp(finiteNumber(command.to ?? command.end, durationMs), from, durationMs);
  if (to <= from) return null;
  return splitKeyChord(key).map((part) => ({ from: Math.round(from), to: Math.round(to), key: part }));
}

function cleanClick(click, durationMs, viewport) {
  if (!click || typeof click !== 'object') return null;
  const point = cleanPoint(click, viewport);
  if (!point) return null;

  const at = clamp(finiteNumber(click.at ?? click.from, 0), 0, durationMs);
  return {
    at: Math.round(at),
    x: point.x,
    y: point.y,
    button: click.button || 'left',
    clickCount: Math.max(1, Math.round(finiteNumber(click.clickCount, 1))),
  };
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

function cleanDrag(drag, durationMs, viewport) {
  if (!drag || typeof drag !== 'object') return null;
  const from = cleanPoint(drag.from || drag.start || { x: drag.x1, y: drag.y1 }, viewport);
  const to = cleanPoint(drag.to || drag.end || { x: drag.x2, y: drag.y2 }, viewport);
  if (!from || !to) return null;

  const at = clamp(finiteNumber(drag.at ?? drag.fromAt ?? drag.startAt, 0), 0, durationMs);
  return {
    at: Math.round(at),
    from,
    to,
    button: drag.button || 'left',
    mode: drag.mode === 'html5' ? 'html5' : 'mouse',
    steps: clamp(Math.round(finiteNumber(drag.steps, 12)), 1, 80),
  };
}

function cleanViewMove(move, durationMs) {
  if (!move || typeof move !== 'object') return null;
  const dx = finiteNumber(move.dx ?? move.deltaX ?? move.delta_x, 0);
  const dy = finiteNumber(move.dy ?? move.deltaY ?? move.delta_y, 0);
  if (!dx && !dy) return null;

  const from = clamp(finiteNumber(move.from ?? move.start ?? move.at, 0), 0, durationMs);
  const to = clamp(finiteNumber(move.to ?? move.end, durationMs), from, durationMs);
  if (to <= from) return null;

  return {
    from: Math.round(from),
    to: Math.round(to),
    dx: Math.round(dx),
    dy: Math.round(dy),
    steps: clamp(Math.round(finiteNumber(move.steps, 12)), 1, 80),
  };
}

function unwrapDecision(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (raw.action && typeof raw.action === 'object') return { ...raw.action, ...raw };
  if (raw.next_action && typeof raw.next_action === 'object') return { ...raw.next_action, ...raw };
  return raw;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeDecision(raw, options = {}) {
  const viewport = options.viewport || null;
  const maxDurationMs = Number(options.maxDurationMs || MAX_DURATION_MS);
  const data = unwrapDecision(raw);
  const durationMs = clamp(
    Math.round(finiteNumber(data.duration_ms ?? data.durationMs ?? data.duration, DEFAULT_DURATION_MS)),
    MIN_DURATION_MS,
    maxDurationMs
  );

  return {
    durationMs,
    commands: (data.commands || []).flatMap((command) => cleanCommand(command, durationMs) || []),
    clicks: (data.clicks || []).map((click) => cleanClick(click, durationMs, viewport)).filter(Boolean),
    drags: asArray(data.drags || data.drag).map((drag) => cleanDrag(drag, durationMs, viewport)).filter(Boolean),
    viewMoves: asArray(data.view_moves || data.viewMoves).map((move) => cleanViewMove(move, durationMs)).filter(Boolean),
    shouldStop: Boolean(data.should_stop ?? data.shouldStop),
    summary: String(data.summary || data.observation_summary || '').trim().slice(0, 500),
    previousActionOutcome: String(
      data.previous_action_outcome ?? data.previousActionOutcome ?? data.action_outcome ?? data.outcome_summary ?? ''
    ).trim().slice(0, 500),
    rationale: String(data.rationale || data.reason || '').trim().slice(0, 1000),
  };
}

module.exports = {
  normalizeDecision,
};
