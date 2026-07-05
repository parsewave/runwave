const DEFAULT_MARK_GRID = {
  rows: 24,
  cols: 24,
};

function markGridFromConfig(config = {}) {
  const rows = Number(config.markGridRows ?? config.gridRows ?? DEFAULT_MARK_GRID.rows);
  const cols = Number(config.markGridCols ?? config.gridCols ?? DEFAULT_MARK_GRID.cols);
  return {
    rows: Number.isFinite(rows) && rows > 0 ? Math.round(rows) : DEFAULT_MARK_GRID.rows,
    cols: Number.isFinite(cols) && cols > 0 ? Math.round(cols) : DEFAULT_MARK_GRID.cols,
  };
}

function viewportFromConfig(config = {}) {
  return config.viewport || config.videoSize || null;
}

function parseCellId(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const number = Number(trimmed);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

function normalizeCellList(value, grid = DEFAULT_MARK_GRID, limit = 4) {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const max = grid.rows * grid.cols;
  const cells = [];
  for (const item of raw) {
    const id = parseCellId(item);
    if (id === null || id < 0 || id >= max) return [];
    cells.push(id);
    if (cells.length >= limit) break;
  }
  return cells;
}

function cellsFromObject(object, grid = DEFAULT_MARK_GRID, limit = 4) {
  if (!object || typeof object !== 'object') return [];
  return normalizeCellList(
    object.cells ?? object.grid_cells ?? object.gridCells ?? object.grid_ids ?? object.gridIds ?? object.cell ?? object.grid_id,
    grid,
    limit
  );
}

function cellBounds(cell, viewport, grid = DEFAULT_MARK_GRID) {
  if (!viewport || !Number.isFinite(Number(viewport.width)) || !Number.isFinite(Number(viewport.height))) {
    throw new Error('grid cell actions require a viewport with numeric width and height');
  }
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  const id = parseCellId(cell);
  if (id === null || id < 0 || id >= grid.rows * grid.cols) {
    throw new Error(`invalid grid cell id: ${cell}`);
  }
  const row = Math.floor(id / grid.cols);
  const col = id % grid.cols;
  return {
    id,
    row,
    col,
    left: (col * width) / grid.cols,
    top: (row * height) / grid.rows,
    right: ((col + 1) * width) / grid.cols,
    bottom: ((row + 1) * height) / grid.rows,
  };
}

function randomPointInCells(cells, viewport, grid = DEFAULT_MARK_GRID, rng = Math.random) {
  const normalized = normalizeCellList(cells, grid, 4);
  if (!normalized.length) {
    throw new Error('grid cell action requires at least one valid cell id');
  }
  const cell = normalized[Math.floor(rng() * normalized.length)];
  const bounds = cellBounds(cell, viewport, grid);
  const x = bounds.left + rng() * Math.max(1, bounds.right - bounds.left);
  const y = bounds.top + rng() * Math.max(1, bounds.bottom - bounds.top);
  return {
    x: Math.max(0, Math.min(Math.round(x), Math.round(Number(viewport.width)) - 1)),
    y: Math.max(0, Math.min(Math.round(y), Math.round(Number(viewport.height)) - 1)),
    cells: normalized,
  };
}

function clickBurstTimes(at, duration, count = 10, intervalMs = 100) {
  const start = Math.max(0, Math.min(Number(at) || 0, duration));
  const clicks = Math.max(1, Math.min(20, Math.round(Number(count) || 10)));
  if (clicks === 1) return [Math.round(start)];

  const requestedInterval = Math.max(20, Math.min(500, Math.round(Number(intervalMs) || 100)));
  const available = Math.max(0, duration - start);
  const interval = available >= requestedInterval * (clicks - 1) ? requestedInterval : available / (clicks - 1);
  return Array.from({ length: clicks }, (_, index) => Math.round(start + interval * index));
}

module.exports = {
  DEFAULT_MARK_GRID,
  parseCellId,
  markGridFromConfig,
  viewportFromConfig,
  normalizeCellList,
  cellsFromObject,
  cellBounds,
  randomPointInCells,
  clickBurstTimes,
};
