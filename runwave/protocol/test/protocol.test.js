'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const protocol = require('../src');

test('protocol barrel exports action constants and mark-grid helpers', () => {
  assert.equal(protocol.DEFAULT_IMPLICIT_END_MS, 50);
  assert.equal(protocol.DEFAULT_MULTI_CLICK_INTERVAL_MS, 100);
  assert.deepEqual(protocol.DEFAULT_MARK_GRID, { rows: 16, cols: 16 });
  assert.equal(typeof protocol.markGridFromConfig, 'function');
  assert.equal(typeof protocol.randomPointInCells, 'function');
  assert.equal(typeof protocol.clickBurstTimes, 'function');
});

test('action field schema accepts every pointer grid alias used by agent and controller', () => {
  for (const field of [
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
  ]) {
    assert.equal(protocol.CELL_FIELDS.includes(field), true, field);
    assert.equal(protocol.POINT_FIELDS.has(field), true, field);
    assert.equal(protocol.ACTION_FIELDS.click.has(field), true, field);
    assert.equal(protocol.ACTION_FIELDS.cursor_move.has(field), true, field);
  }

  assert.deepEqual([...protocol.ACTION_FIELDS.key].sort(), ['end', 'key', 'start', 'type']);
  assert.equal(protocol.ACTION_FIELDS.drag.has('from_cells'), true);
  assert.equal(protocol.ACTION_FIELDS.drag.has('to_cells'), true);
  assert.equal(protocol.MAX_ACTION_SPAN_MS.click, 100);
  assert.equal(protocol.MAX_ACTION_SPAN_MS.drag, 2000);
  assert.equal(protocol.MAX_ACTION_SPAN_MS.cursor_move, 2000);
});

test('mark grid config uses legacy aliases and falls back for invalid dimensions', () => {
  assert.deepEqual(protocol.markGridFromConfig({ markGridRows: 12.4, markGridCols: 7.6 }), {
    rows: 12,
    cols: 8,
  });
  assert.deepEqual(protocol.markGridFromConfig({ gridRows: '9', gridCols: '5' }), {
    rows: 9,
    cols: 5,
  });
  assert.deepEqual(protocol.markGridFromConfig({ markGridRows: 0, markGridCols: -2 }), {
    rows: 16,
    cols: 16,
  });
});

test('cell helpers normalize row-column objects and clamp invalid cell lists', () => {
  const grid = { rows: 3, cols: 4 };

  assert.equal(protocol.cellFromRowCol({ overlay_row: 2, overlay_col: 3 }, grid), 11);
  assert.equal(protocol.cellFromRowCol({ row: 1, col: 2 }, grid), 6);
  assert.equal(protocol.cellFromRowCol({ row: 1.2, col: 2 }, grid), null);
  assert.equal(protocol.cellFromRowCol({ row: 3, col: 0 }, grid), null);

  assert.deepEqual(protocol.normalizeCellList([-1, 0.2, '3', 99, 4.7, 5, 6], grid, 3), [0, 3, 5]);
  assert.deepEqual(protocol.cellsFromObject({ grid_ids: [2, 3, 4, 5, 6] }, grid, 4), [2, 3, 4, 5]);
  assert.deepEqual(protocol.cellsFromObject({ overlay_row: 1, overlay_col: 1 }, grid), [5]);
});

test('cellBounds and randomPointInCells map cells into viewport pixels safely', () => {
  const viewport = { width: 400, height: 300 };
  const grid = { rows: 3, cols: 4 };

  assert.deepEqual(protocol.cellBounds(6, viewport, grid), {
    id: 6,
    row: 1,
    col: 2,
    left: 200,
    top: 100,
    right: 300,
    bottom: 200,
  });

  const point = protocol.randomPointInCells([6], viewport, grid, () => 0.5, 0.5);
  assert.deepEqual(point, { x: 250, y: 150, cells: [6] });

  assert.throws(
    () => protocol.cellBounds(0, null, grid),
    /viewport with numeric width and height/
  );
  assert.throws(
    () => protocol.randomPointInCells([], viewport, grid),
    /at least one valid cell id/
  );
});

test('clickBurstTimes spaces clicks inside available duration', () => {
  assert.deepEqual(protocol.clickBurstTimes(10, 1000, 1, 100), [10]);
  assert.deepEqual(protocol.clickBurstTimes(10, 500, 4, 100), [10, 110, 210, 310]);
  assert.deepEqual(protocol.clickBurstTimes(900, 1000, 4, 100), [900, 933, 967, 1000]);
  assert.deepEqual(protocol.clickBurstTimes(-50, 100, 3, 5), [0, 20, 40]);
  assert.equal(protocol.clickBurstTimes(0, 1000, 100, 100).length, 20);
});
