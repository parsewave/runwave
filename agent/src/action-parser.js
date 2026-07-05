'use strict';

const {
  actionEnd,
  assertAllowedFields,
  normalizeActions,
} = require('../../harness/src/action-normalizer');

const DEFAULT_DURATION_MS = 500;
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 8000;

const AGENT_SEQUENCE_FIELDS = new Set([
  'summary',
  'previous_sequence_outcome',
  'actions',
  'should_stop',
  'rationale',
]);

function inferDurationMs(actions, fallback = DEFAULT_DURATION_MS) {
  const latest = actions.reduce((max, action) => Math.max(max, actionEnd(action)), 0);
  return Math.max(MIN_DURATION_MS, latest || fallback);
}

function normalizeSequence(raw, options = {}) {
  const viewport = options.viewport || null;
  const maxDurationMs = Number(options.maxDurationMs || MAX_DURATION_MS);
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  assertAllowedFields(data, AGENT_SEQUENCE_FIELDS, 'sequence');

  const actions = normalizeActions(data.actions, maxDurationMs, {
    strict: false,
    viewport,
    config: options.config || {},
    maxDurationMs,
    scaleUnitPoints: true,
    clampToViewport: true,
    roundPoints: true,
    roundTimes: true,
    splitKeyChords: true,
    cursorCellsOnTarget: false,
  });

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
