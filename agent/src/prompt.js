'use strict';

function compactPostActionResult(result) {
  if (!result || typeof result !== 'object') return '';
  const parts = [];
  if (typeof result.ok === 'boolean') parts.push(`ok=${result.ok}`);
  if (typeof result.screenshotChanged === 'boolean') parts.push(`screenshot_changed=${result.screenshotChanged}`);
  if (typeof result.captureCount === 'number') parts.push(`captures=${result.captureCount}`);
  if (result.error) parts.push(`error=${String(result.error).slice(0, 120)}`);
  return parts.length ? `; post_action=${parts.join(',')}` : '';
}

function compactOutcomeSummary(outcomeSummary) {
  const text = String(outcomeSummary || '').trim();
  return text ? `; outcome="${text.slice(0, 220)}"` : '';
}

function compactHistory(history, limit = 8) {
  return history
    .slice(-limit)
    .map((item) => {
      const controls = [
        ...(item.commands || []).map((command) => command.key),
        ...(item.clicks || []).map((click) => `click(${click.x},${click.y})`),
        ...(item.drags || []).map((drag) => `drag(${drag.from.x},${drag.from.y}->${drag.to.x},${drag.to.y},${drag.mode})`),
        ...(item.cursorMoves || []).map((move) => `cursor(${move.to.x},${move.to.y})`),
        ...(item.viewMoves || []).map((move) => `view(${move.dx},${move.dy})`),
      ];
      return `step ${item.step}: ${item.summary || item.rationale || 'no summary'}; controls=${controls.join(',') || 'none'}${compactPostActionResult(item.result)}${compactOutcomeSummary(item.outcomeSummary)}`;
    })
    .join('\n');
}

function roundedPoint(value, quantum = 20) {
  return Math.round(Number(value || 0) / quantum) * quantum;
}

function actionControls(item) {
  return {
    commands: (item.commands || []).map((command) => command.key).filter(Boolean),
    clicks: (item.clicks || []).map((click) => `${roundedPoint(click.x)},${roundedPoint(click.y)}`),
    drags: (item.drags || []).map(
      (drag) =>
        `${roundedPoint(drag.from.x)},${roundedPoint(drag.from.y)}->${roundedPoint(drag.to.x)},${roundedPoint(drag.to.y)}`
    ),
    cursorMoves: (item.cursorMoves || []).map((move) => `${roundedPoint(move.to.x)},${roundedPoint(move.to.y)}`),
    viewMoves: (item.viewMoves || []).map((move) => `${roundedPoint(move.dx)},${roundedPoint(move.dy)}`),
  };
}

function actionSignature(item) {
  const controls = actionControls(item);
  if (!Object.values(controls).some((values) => values.length)) return '';
  return [
    controls.commands.join(','),
    controls.clicks.join(','),
    controls.drags.join(','),
    controls.cursorMoves.join(','),
    controls.viewMoves.join(','),
  ].join('|');
}

function actionLabel(item) {
  const controls = actionControls(item);
  const labels = [
    ...controls.commands,
    ...controls.clicks.map((click) => `click(${click})`),
    ...controls.drags.map((drag) => `drag(${drag})`),
    ...controls.cursorMoves.map((move) => `cursor(${move})`),
    ...controls.viewMoves.map((move) => `view(${move})`),
  ];
  return labels.join('+') || 'no controls';
}

function repeatedControlCycle(history, maxPeriod = 5) {
  const signatures = history.map(actionSignature);
  const max = Math.min(maxPeriod, Math.floor(signatures.length / 2));
  for (let period = 1; period <= max; period += 1) {
    const repeatCount = period === 1 ? 3 : 2;
    const required = period * repeatCount;
    if (signatures.length < required) continue;

    const start = signatures.length - required;
    const cycle = signatures.slice(signatures.length - period);
    if (!cycle.some(Boolean)) continue;

    let matched = true;
    for (let offset = 0; offset < required; offset += 1) {
      if (signatures[start + offset] !== cycle[offset % period]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return {
        period,
        labels: history.slice(history.length - period).map(actionLabel),
      };
    }
  }
  return null;
}

function repeatedHistoryWarning(history) {
  const cycle = repeatedControlCycle(history, 5);
  if (cycle && cycle.period === 1) {
    return 'Warning: the recent actions repeated the same controls. Switch strategy now instead of trying the same input again.';
  }
  if (cycle) {
    return `Warning: the recent actions repeated a ${cycle.period}-step control cycle (${cycle.labels.join(' -> ')}). Break the loop now with a different route, a longer committed move, or a different strategy instead of continuing the cycle.`;
  }

  const recent = history.slice(-3);
  if (recent.length < 3) return '';
  const summaries = recent.map((item) => String(item.summary || '').toLowerCase());
  if (summaries.every((summary) => summary.includes('paused'))) {
    return 'Warning: the game still appears paused. Try a different visible resume/control input instead of repeating the same click.';
  }
  if (summaries.every((summary) => summary.includes('menu') || summary.includes('title') || summary.includes('start'))) {
    return 'Warning: the recent actions did not clearly leave the menu/title flow. Use the visible start instruction or a different common confirm key.';
  }
  return '';
}

function buildPlaytesterPrompt({ job, elapsedMs, maxMs, viewport, state, history }) {
  const secondsLeft = Math.max(0, Math.round((maxMs - elapsedMs) / 1000));
  const controls = job.agentControls || [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Space',
    'Enter',
    'Escape',
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
  ];
  const warning = repeatedHistoryWarning(history);

  return [
    'You are an agentic browser-game playtester. Your job is to create a useful gameplay video, not to judge the game.',
    '',
    'High-level goals:',
    '- If the game is on a menu/title/start screen, get into real gameplay.',
    '- If movement is possible, always strive to explore as much as possible.',
    '- If there is no movement, perform meaningful game actions repeatedly.',
    '- Try to chain multiple senseible commands at once rather than a single command each time.',
    '- Do not stop early unless the recording already shows enough real gameplay.',
    '',
    `Time remaining: ${secondsLeft}s.`,
    `Viewport: ${viewport.width}x${viewport.height}. The screenshot has an 8x8 red mark grid labeled 0 through 63, row-major from top-left to bottom-right.`,
    `Available common controls: ${controls.join(', ')}. You may use literal Playwright keys.`,
    '',
    'Action guidance:',
    '- Prefer grid-cell targeting over raw x/y coordinates. For pointer actions, choose up to 4 relevant grid cell IDs using "cells": [id].',
    '- Put every input in the "commands" array. Each command must have a "type": "key", "click", "multi_click", "drag", "cursor_move", or "view_move".',
    '- Use type "click" for a single click in the selected cell area. Use type "multi_click" when a target is imprecise or repeated clicking/tapping is useful; it sends quick clicks at random points inside the selected cells.',
    '- Use type "drag" for drag/swipe games with from_cells and to_cells. Use mode "mouse" for canvas or pointer games; use mode "html5" for browser-native drag/drop elements such as match-3 candy boards.',
    '- Use type "cursor_move" for cursor movement without clicking. Use type "view_move" only for relative camera/mouse-look movement where dx/dy matters.',
    '- If the game says paused, resume, continue, start, or shows tutorial controls, follow that visible instruction before doing anything else.',
    '- On menus, prefer options that clearly enter gameplay: Play, Start, New Game, Single Player, Campaign, Level 1, Continue, Resume, or a default character/level choice.',
    '- Avoid Options, Settings, Credits, Help, Leaderboard, and Multiplayer unless they are the only visible path into gameplay.',
    '- If one menu choice does not enter gameplay, go back or try a different start-like choice on the next step. Do not spend turns only describing or waiting on a menu.',
    '- Common resume/confirm keys are Space, Enter, Escape, and P. Use them when the screen suggests a paused/menu state and clicks are not working.',
    '- If the state JSON reports a canvas, treat that canvas rectangle as the active game area unless the screenshot clearly shows otherwise.',
    '- If you die, reset, or return to a map/title screen, re-enter gameplay and change strategy instead of repeating the same failed action.',
    '- Avoid idle waiting. Each step should do something visible or useful for the gameplay video.',
    '- In previous_action_outcome, summarize what visibly happened after the most recent prior step. If a prior control moved the player, camera, board, score, menu, or level state, say that clearly. On the first step, use an empty string.',
    '',
    warning ? `${warning}\n` : '',
    'Recent history:',
    compactHistory(history) || 'none',
    '',
    'Browser/game state JSON:',
    JSON.stringify(state || {}, null, 2).slice(0, 5000),
    '',
    'Return only JSON with this shape:',
    '{',
    '  "summary": "one sentence describing what is visible now and what happened recently",',
    '  "previous_action_outcome": "one sentence describing the visible outcome of the previous step, or empty on the first step",',
    '  "duration_ms": 3000,',
    '  "commands": [',
    '    {"type": "key", "from": 0, "to": 300, "key": "ArrowRight"},',
    '    {"type": "key", "from": 200, "to": 700, "key": "ArrowDown"},',
    '    {"type": "click", "at": 100, "cells": [27]},',
    '    {"type": "multi_click", "at": 100, "cells": [27, 28], "count": 10},',
    '    {"type": "drag", "at": 100, "from_cells": [34], "to_cells": [35], "mode": "mouse", "steps": 12},',
    '    {"type": "cursor_move", "at": 100, "cells": [27], "steps": 8},',
    '    {"type": "view_move", "from": 0, "to": 800, "dx": 120, "dy": 0, "steps": 8}',
    '  ],',
    '  "should_stop": false,',
    '  "rationale": "why this is the next useful playtest action."',
    '}',
    '',
    'Use duration_ms between 500 and 8000. Use an empty commands array when no input is needed.',
  ].join('\n');
}

module.exports = {
  buildPlaytesterPrompt,
  compactHistory,
};
