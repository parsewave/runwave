const eventPriority = {
  up: 0,
  down: 1,
  cursor_move: 2,
  click: 3,
  drag: 4,
  view_move: 5,
  capture: 6,
};

function compareEvents(left, right) {
  return left.at - right.at || (eventPriority[left.type] ?? 9) - (eventPriority[right.type] ?? 9);
}

function buildStepTimeline(step) {
  const events = [];

  for (const action of step.keyActions) {
    events.push({ at: action.start, type: 'down', action });
    events.push({ at: action.end, type: 'up', action });
  }
  for (const click of step.clicks) {
    events.push({ at: click.start, type: 'click', click });
  }
  for (const cursorMove of step.cursorMoves) {
    events.push({ at: cursorMove.start, type: 'cursor_move', cursorMove });
  }
  for (const drag of step.drags) {
    events.push({ at: drag.start, type: 'drag', drag });
  }
  for (const viewMove of step.viewMoves) {
    const steps = Math.max(1, viewMove.steps);
    for (let index = 0; index < steps; index += 1) {
      const progress = steps === 1 ? 0 : index / (steps - 1);
      const at = Math.round(viewMove.start + (viewMove.end - viewMove.start) * progress);
      events.push({
        at,
        type: 'view_move',
        viewMove: {
          dx: viewMove.dx / steps,
          dy: viewMove.dy / steps,
        },
      });
    }
  }
  for (const at of step.captures) {
    events.push({ at, type: 'capture' });
  }

  return events.sort(compareEvents);
}

module.exports = {
  buildStepTimeline,
};
