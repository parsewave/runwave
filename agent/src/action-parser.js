'use strict';

const {
  actionEnd,
  assertAllowedFields,
  normalizeActions,
} = require('../../harness/src/action-normalizer');
const { markGridFromConfig, parseCellId } = require('../../harness/src/mark-grid');

const DEFAULT_DURATION_MS = 500;
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 8000;
const CELL_FIELDS = ['cells', 'grid_cells', 'gridCells', 'grid_ids', 'gridIds', 'cell', 'grid_id', 'from_cells', 'to_cells'];

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

function sanitizeAgentActions(actions) {
  if (!Array.isArray(actions)) return actions;
  return actions.map((action) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
    if (String(action.type || '').trim().toLowerCase() !== 'click') return action;
    const { clickCount, ...singleClick } = action;
    return singleClick;
  });
}

function validateCellId(value, label, grid) {
  const id = parseCellId(value);
  const max = grid.rows * grid.cols;
  if (id === null) {
    throw new Error(`${label} must be an integer grid cell id`);
  }
  if (id < 0 || id >= max) {
    throw new Error(`${label} must be between 0 and ${max - 1}`);
  }
}

function validateCellValue(value, label, grid) {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) {
    throw new Error(`${label} must include at least one integer grid cell id`);
  }
  values.forEach((item, index) => validateCellId(item, Array.isArray(value) ? `${label}[${index}]` : label, grid));
}

function validateCellFields(object, label, grid) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return;
  for (const field of CELL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(object, field)) {
      validateCellValue(object[field], `${label}.${field}`, grid);
    }
  }
}

function validateAgentCellTargets(actions, config) {
  if (!Array.isArray(actions)) return;
  const grid = markGridFromConfig(config);
  actions.forEach((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return;
    const label = `actions[${index}]`;
    validateCellFields(action, label, grid);
    validateCellFields(action.from, `${label}.from`, grid);
    validateCellFields(action.to, `${label}.to`, grid);
  });
}

function normalizeSequence(raw, options = {}) {
  const viewport = options.viewport || null;
  const maxDurationMs = Number(options.maxDurationMs || MAX_DURATION_MS);
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  assertAllowedFields(data, AGENT_SEQUENCE_FIELDS, 'sequence');
  validateAgentCellTargets(data.actions, options.config || {});

  const actions = normalizeActions(sanitizeAgentActions(data.actions), maxDurationMs, {
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
