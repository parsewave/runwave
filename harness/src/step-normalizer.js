const defaultKeyAliases = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  jump: 'Space',
  space: 'Space',
  enter: 'Enter',
  esc: 'Escape',
};

const {
  cellsFromObject,
  clickBurstTimes,
  markGridFromConfig,
  randomPointInCells,
  viewportFromConfig,
} = require('./mark-grid');

function readNumber(value, fallback) {
  return Number(value ?? fallback);
}

function normalizeDuration(input) {
  const duration = readNumber(input.duration, input.ms ?? 1000);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error('duration must be a non-negative number of milliseconds');
  }
  return duration;
}

function normalizeCommand(command, aliases) {
  const from = readNumber(command.from, command.start ?? command[0]);
  const to = readNumber(command.to, command.end ?? command[1]);
  const keyName = command.key ?? command.button ?? command[2];
  const key = aliases[keyName] || keyName;

  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
    throw new Error(`invalid command interval: ${JSON.stringify(command)}`);
  }
  if (!key) throw new Error(`command is missing key: ${JSON.stringify(command)}`);

  return { from, to, keyName, key };
}

function normalizeGridPoint(object, config, label) {
  const grid = markGridFromConfig(config);
  const cells = cellsFromObject(object, grid, 4);
  if (!cells.length) return null;
  try {
    return randomPointInCells(cells, viewportFromConfig(config), grid);
  } catch (error) {
    throw new Error(`${label} ${error.message}`);
  }
}

function normalizePointOrCells(point, label, config) {
  const gridPoint = normalizeGridPoint(point, config, label);
  if (gridPoint) return { x: gridPoint.x, y: gridPoint.y, cells: gridPoint.cells };
  return normalizePoint(point, label);
}

function normalizeClick(click, duration, config, forceMulti = false) {
  const at = readNumber(click.at, click.from ?? 0);
  const gridPoint = normalizeGridPoint(click, config, 'click');
  const x = gridPoint ? gridPoint.x : Number(click.x);
  const y = gridPoint ? gridPoint.y : Number(click.y);

  if (!Number.isFinite(at) || at < 0 || at > duration) {
    throw new Error(`invalid click time: ${JSON.stringify(click)}`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`click requires numeric x and y: ${JSON.stringify(click)}`);
  }

  const base = {
    at,
    x,
    y,
    button: click.button || 'left',
    clickCount: Number(click.clickCount || 1),
  };
  if (!gridPoint && !forceMulti && click.click_mode !== 'multi' && click.clickMode !== 'multi') return [base];

  const mode = forceMulti || click.click_mode === 'multi' || click.clickMode === 'multi' ? 'multi' : 'single';
  const count = mode === 'multi' ? readNumber(click.count, click.clicks ?? 10) : 1;
  return clickBurstTimes(at, duration, count, click.intervalMs ?? click.interval_ms ?? 100).map((clickAt) => {
    const point = gridPoint ? normalizeGridPoint(click, config, 'click') : { x, y };
    return {
      ...base,
      at: clickAt,
      x: point.x,
      y: point.y,
      clickCount: 1,
      ...(gridPoint ? { cells: gridPoint.cells, clickMode: mode } : {}),
    };
  });
}

function normalizePoint(point, label) {
  const x = Number(point && point.x);
  const y = Number(point && point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} requires numeric x and y: ${JSON.stringify(point)}`);
  }
  return { x, y };
}

function normalizeDrag(drag, duration, config) {
  const at = readNumber(drag.at, drag.fromAt ?? drag.startAt ?? 0);
  const from = normalizePointOrCells(
    drag.from || drag.start || { x: drag.x1, y: drag.y1, cells: drag.from_cells ?? drag.fromCells },
    'drag.from',
    config
  );
  const to = normalizePointOrCells(
    drag.to || drag.end || { x: drag.x2, y: drag.y2, cells: drag.to_cells ?? drag.toCells },
    'drag.to',
    config
  );
  const steps = Math.max(1, Math.min(80, Math.round(readNumber(drag.steps, 12))));

  if (!Number.isFinite(at) || at < 0 || at > duration) {
    throw new Error(`invalid drag time: ${JSON.stringify(drag)}`);
  }

  return {
    at,
    from,
    to,
    button: drag.button || 'left',
    mode: drag.mode === 'html5' ? 'html5' : 'mouse',
    steps,
  };
}

function normalizeCursorMove(cursorMove, duration, config) {
  const at = readNumber(cursorMove.at, cursorMove.from ?? cursorMove.start ?? 0);
  const to = normalizePointOrCells(cursorMove.to || cursorMove.target || cursorMove, 'cursor_move.to', config);
  const steps = Math.max(1, Math.min(80, Math.round(readNumber(cursorMove.steps, 8))));

  if (!Number.isFinite(at) || at < 0 || at > duration) {
    throw new Error(`invalid cursor move time: ${JSON.stringify(cursorMove)}`);
  }

  return { at, to, steps };
}

function normalizeViewMove(viewMove, duration) {
  const from = readNumber(viewMove.from, viewMove.start ?? viewMove.at ?? 0);
  const to = readNumber(viewMove.to, viewMove.end ?? from);
  const dx = Number(viewMove.dx ?? viewMove.deltaX ?? viewMove.delta_x ?? 0);
  const dy = Number(viewMove.dy ?? viewMove.deltaY ?? viewMove.delta_y ?? 0);
  const steps = Math.max(1, Math.min(80, Math.round(readNumber(viewMove.steps, 12))));

  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || to > duration) {
    throw new Error(`invalid view move interval: ${JSON.stringify(viewMove)}`);
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    throw new Error(`view move requires numeric dx or dy: ${JSON.stringify(viewMove)}`);
  }

  return { from, to, dx, dy, steps };
}

function addCapture(captures, capture, duration) {
  const at = Number(capture);
  if (Number.isFinite(at) && at >= 0 && at <= duration) {
    captures.add(Math.round(at));
  }
}

function normalizeCaptures(input, config, duration) {
  const captures = new Set();
  const requestedCaptures = input.captures ? input.captures.map(Number) : [duration];
  for (const capture of requestedCaptures) addCapture(captures, capture, duration);

  const autoCaptures = input.autoCaptures !== false && config.autoCaptures !== false;
  const captureIntervalMs = readNumber(input.captureIntervalMs, config.captureIntervalMs ?? 1000);
  if (autoCaptures && Number.isFinite(captureIntervalMs) && captureIntervalMs > 0) {
    for (let at = captureIntervalMs; at < duration; at += captureIntervalMs) {
      addCapture(captures, at, duration);
    }
    addCapture(captures, duration, duration);
  }

  if (!captures.size) addCapture(captures, duration, duration);
  return Array.from(captures).sort((a, b) => a - b);
}

function normalizeStep(input, config, nextStepIndex) {
  const aliases = { ...defaultKeyAliases, ...(config.keyAliases || {}) };
  const duration = normalizeDuration(input);
  const viewMoves = input.viewMoves || input.view_moves || input.mouseMoves || input.mouse_moves || [];
  const drags = input.drags || input.drag || [];
  const cursorMoves = input.cursorMoves || input.cursor_moves || input.cursorMove || input.cursor_move || [];
  const multiClicks = input.multiClicks || input.multi_clicks || [];

  return {
    index: nextStepIndex,
    name: String(input.name || `step-${String(nextStepIndex).padStart(3, '0')}`),
    duration,
    commands: (input.commands || []).map((command) => normalizeCommand(command, aliases)),
    clicks: [
      ...(input.clicks || []).flatMap((click) => normalizeClick(click, duration, config)),
      ...(Array.isArray(multiClicks) ? multiClicks : [multiClicks]).flatMap((click) => normalizeClick(click, duration, config, true)),
    ],
    drags: (Array.isArray(drags) ? drags : [drags]).map((drag) => normalizeDrag(drag, duration, config)),
    cursorMoves: (Array.isArray(cursorMoves) ? cursorMoves : [cursorMoves]).map((move) =>
      normalizeCursorMove(move, duration, config)
    ),
    viewMoves: viewMoves.map((viewMove) => normalizeViewMove(viewMove, duration)),
    captures: normalizeCaptures(input, config, duration),
  };
}

module.exports = {
  normalizeStep,
};
