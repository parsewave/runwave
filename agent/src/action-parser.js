'use strict';

const {
  actionEnd,
  assertAllowedFields,
  asActionArray,
  normalizeActions,
} = require('../../controller/src/action-normalizer');

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

function assertPlainSequence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('model sequence must be a plain object');
  }
  return raw;
}

function normalizeShouldStop(data) {
  if (!Object.prototype.hasOwnProperty.call(data, 'should_stop')) return false;
  if (typeof data.should_stop !== 'boolean') {
    throw new Error('sequence should_stop must be a boolean');
  }
  return data.should_stop === true;
}

function normalizeSequence(raw, options = {}) {
  const viewport = options.viewport || null;
  const maxDurationMs = Number(options.maxDurationMs || MAX_DURATION_MS);
  const data = assertPlainSequence(raw);
  assertAllowedFields(data, AGENT_SEQUENCE_FIELDS, 'sequence');

  const shouldStop = normalizeShouldStop(data);
  const rawActions = asActionArray(data.actions);
  if (!shouldStop && !rawActions.length) {
    throw new Error('sequence actions must contain at least one action unless should_stop is true');
  }
  const actions = normalizeActions(rawActions, maxDurationMs, {
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
  if (rawActions.length && !actions.length) {
    throw new Error('all model actions were invalid after normalization');
  }

  return {
    durationMs: inferDurationMs(actions, DEFAULT_DURATION_MS),
    actions,
    shouldStop,
    summary: String(data.summary || '').trim().slice(0, 500),
    previousSequenceOutcome: String(data.previous_sequence_outcome ?? '').trim().slice(0, 500),
    rationale: String(data.rationale || '').trim().slice(0, 1000),
  };
}

module.exports = {
  normalizeSequence,
};
