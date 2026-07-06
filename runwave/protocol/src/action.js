'use strict';

const CELL_FIELDS = [
  'cells',
  'grid_cells',
  'gridCells',
  'grid_ids',
  'gridIds',
  'cell',
  'grid_id',
  'overlay_row',
  'overlay_col',
  'row',
  'col',
];

const POINT_FIELDS = new Set(['x', 'y', ...CELL_FIELDS]);

const ACTION_FIELDS = {
  key: new Set(['type', 'start', 'end', 'key']),
  click: new Set(['type', 'start', 'end', 'x', 'y', ...CELL_FIELDS, 'button', 'clickCount']),
  multi_click: new Set(['type', 'start', 'end', 'x', 'y', ...CELL_FIELDS, 'button', 'count', 'intervalMs']),
  drag: new Set(['type', 'start', 'end', 'from', 'to', 'from_cells', 'to_cells', 'button', 'mode', 'steps']),
  cursor_move: new Set(['type', 'start', 'end', 'to', 'x', 'y', ...CELL_FIELDS, 'steps']),
  view_move: new Set(['type', 'start', 'end', 'dx', 'dy', 'steps']),
};

const DEFAULT_IMPLICIT_END_MS = 50;
const DEFAULT_MULTI_CLICK_INTERVAL_MS = 100;
const MAX_ACTION_SPAN_MS = {
  click: 100,
  drag: 2000,
  cursor_move: 2000,
};

module.exports = {
  ACTION_FIELDS,
  CELL_FIELDS,
  DEFAULT_IMPLICIT_END_MS,
  DEFAULT_MULTI_CLICK_INTERVAL_MS,
  MAX_ACTION_SPAN_MS,
  POINT_FIELDS,
};
