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

function normalizeClick(click, duration) {
  const at = readNumber(click.at, click.from ?? 0);
  const x = Number(click.x);
  const y = Number(click.y);

  if (!Number.isFinite(at) || at < 0 || at > duration) {
    throw new Error(`invalid click time: ${JSON.stringify(click)}`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`click requires numeric x and y: ${JSON.stringify(click)}`);
  }

  return {
    at,
    x,
    y,
    button: click.button || 'left',
    clickCount: Number(click.clickCount || 1),
  };
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

  return {
    index: nextStepIndex,
    name: String(input.name || `step-${String(nextStepIndex).padStart(3, '0')}`),
    duration,
    commands: (input.commands || []).map((command) => normalizeCommand(command, aliases)),
    clicks: (input.clicks || []).map((click) => normalizeClick(click, duration)),
    viewMoves: viewMoves.map((viewMove) => normalizeViewMove(viewMove, duration)),
    captures: normalizeCaptures(input, config, duration),
  };
}

module.exports = {
  normalizeStep,
};
