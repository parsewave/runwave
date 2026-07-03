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

function cleanCommand(command, durationMs) {
  if (!command || typeof command !== 'object') return null;
  const key = cleanKey(command.key ?? command.button ?? command.press);
  if (!key) return null;

  const from = clamp(finiteNumber(command.from ?? command.start, 0), 0, durationMs);
  const to = clamp(finiteNumber(command.to ?? command.end, durationMs), from, durationMs);
  if (to <= from) return null;
  return { from: Math.round(from), to: Math.round(to), key };
}

function cleanClick(click, durationMs, viewport) {
  if (!click || typeof click !== 'object') return null;
  let x = finiteNumber(click.x);
  let y = finiteNumber(click.y);
  if (x === null || y === null) return null;

  if (viewport && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
    x *= viewport.width;
    y *= viewport.height;
  }

  if (viewport) {
    x = clamp(x, 0, viewport.width - 1);
    y = clamp(y, 0, viewport.height - 1);
  }

  const at = clamp(finiteNumber(click.at ?? click.from, 0), 0, durationMs);
  return {
    at: Math.round(at),
    x: Math.round(x),
    y: Math.round(y),
    button: click.button || 'left',
    clickCount: Math.max(1, Math.round(finiteNumber(click.clickCount, 1))),
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
    commands: (data.commands || []).map((command) => cleanCommand(command, durationMs)).filter(Boolean),
    clicks: (data.clicks || []).map((click) => cleanClick(click, durationMs, viewport)).filter(Boolean),
    viewMoves: (data.view_moves || data.viewMoves || []).map((move) => cleanViewMove(move, durationMs)).filter(Boolean),
    shouldStop: Boolean(data.should_stop ?? data.shouldStop),
    summary: String(data.summary || data.observation_summary || '').trim().slice(0, 500),
    rationale: String(data.rationale || data.reason || '').trim().slice(0, 1000),
  };
}

module.exports = {
  normalizeDecision,
};
