const eventPriority = {
  up: 0,
  down: 1,
  click: 2,
  drag: 3,
  view_move: 4,
  capture: 5,
};

function compareEvents(left, right) {
  return left.at - right.at || (eventPriority[left.type] ?? 9) - (eventPriority[right.type] ?? 9);
}

function buildStepTimeline(step) {
  const events = [];

  for (const command of step.commands) {
    events.push({ at: command.from, type: 'down', command });
    events.push({ at: command.to, type: 'up', command });
  }
  for (const click of step.clicks) {
    events.push({ at: click.at, type: 'click', click });
  }
  for (const drag of step.drags) {
    events.push({ at: drag.at, type: 'drag', drag });
  }
  for (const viewMove of step.viewMoves) {
    const steps = Math.max(1, viewMove.steps);
    for (let index = 0; index < steps; index += 1) {
      const progress = steps === 1 ? 0 : index / (steps - 1);
      const at = Math.round(viewMove.from + (viewMove.to - viewMove.from) * progress);
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
