'use strict';

const { markGridFromConfig } = require('../../harness/src/mark-grid');

function compactPostSequenceResult(result) {
  if (!result || typeof result !== 'object') return '';
  const parts = [];
  if (typeof result.ok === 'boolean') parts.push(`ok=${result.ok}`);
  if (typeof result.screenshotChanged === 'boolean') parts.push(`screenshot_changed=${result.screenshotChanged}`);
  if (typeof result.captureCount === 'number') parts.push(`captures=${result.captureCount}`);
  if (result.error) parts.push(`error=${String(result.error).slice(0, 120)}`);
  return parts.length ? `; post_sequence=${parts.join(',')}` : '';
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
        ...sequenceActions(item).map(actionLabelPart),
      ];
      return `step ${item.step}: ${item.summary || item.rationale || 'no summary'}; controls=${controls.join(',') || 'none'}${compactPostSequenceResult(item.result)}${compactOutcomeSummary(item.outcomeSummary)}`;
    })
    .join('\n');
}

function roundedPoint(value, quantum = 20) {
  return Math.round(Number(value || 0) / quantum) * quantum;
}

function sequenceActions(item) {
  return Array.isArray(item.actions) ? item.actions : [];
}

function actionLabelPart(action) {
  if (action.type === 'key') return action.key;
  if (action.type === 'click') return `click(${action.x},${action.y})`;
  if (action.type === 'drag') return `drag(${action.from.x},${action.from.y}->${action.to.x},${action.to.y},${action.mode})`;
  if (action.type === 'cursor_move') return `cursor(${action.to.x},${action.to.y})`;
  if (action.type === 'view_move') return `view(${action.dx},${action.dy})`;
  return action.type || 'unknown';
}

function actionControls(item) {
  const actions = sequenceActions(item);
  return {
    keys: actions.filter((action) => action.type === 'key').map((action) => action.key).filter(Boolean),
    clicks: actions.filter((action) => action.type === 'click').map((click) => `${roundedPoint(click.x)},${roundedPoint(click.y)}`),
    drags: actions
      .filter((action) => action.type === 'drag')
      .map((drag) => `${roundedPoint(drag.from.x)},${roundedPoint(drag.from.y)}->${roundedPoint(drag.to.x)},${roundedPoint(drag.to.y)}`),
    cursorMoves: actions
      .filter((action) => action.type === 'cursor_move')
      .map((move) => `${roundedPoint(move.to.x)},${roundedPoint(move.to.y)}`),
    viewMoves: actions.filter((action) => action.type === 'view_move').map((move) => `${roundedPoint(move.dx)},${roundedPoint(move.dy)}`),
  };
}

function actionSignature(item) {
  const controls = actionControls(item);
  if (!Object.values(controls).some((values) => values.length)) return '';
  return [
    controls.keys.join(','),
    controls.clicks.join(','),
    controls.drags.join(','),
    controls.cursorMoves.join(','),
    controls.viewMoves.join(','),
  ].join('|');
}

function actionLabel(item) {
  const controls = actionControls(item);
  const labels = [
    ...controls.keys,
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
    return 'Warning: the recent sequences repeated the same controls. Switch strategy now instead of trying the same input again.';
  }
  if (cycle) {
    return `Warning: the recent sequences repeated a ${cycle.period}-step control cycle (${cycle.labels.join(' -> ')}). Break the loop now with a different route, a longer committed move, or a different strategy instead of continuing the cycle.`;
  }

  const recent = history.slice(-3);
  if (recent.length < 3) return '';
  const summaries = recent.map((item) => String(item.summary || '').toLowerCase());
  if (summaries.every((summary) => summary.includes('paused'))) {
    return 'Warning: the game still appears paused. Try a different visible resume/control input instead of repeating the same click.';
  }
  if (summaries.every((summary) => summary.includes('menu') || summary.includes('title') || summary.includes('start'))) {
    return 'Warning: the recent sequences did not clearly leave the menu/title flow. Use the visible start instruction or a different common confirm key.';
  }
  return '';
}

function gridExampleCells(grid) {
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(grid.rows / 2)));
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(grid.cols / 2)));
  const center = { row, col };
  const right = { row, col: Math.min(grid.cols - 1, col + 1) };
  const below = { row: Math.min(grid.rows - 1, row + 1), col };
  return { center, right, below };
}

function cellJson(cell) {
  return `{"row": ${cell.row}, "col": ${cell.col}}`;
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
  const grid = markGridFromConfig(job || {});
  const examples = gridExampleCells(grid);

  return [
    'You are an agentic browser-game playtester. Your job is to create a useful gameplay video, not to judge the game.',
    '',
    'High-level goals:',
    '- If the game is on a menu/title/start screen, get into real gameplay.',
    '- If movement is possible, always strive to explore as much as possible.',
    '- If there is no movement, perform meaningful game actions repeatedly.',
    '- Try to chain multiple sensible actions in one sequence rather than a single action each time.',
    '- Do not stop early unless the recording already shows enough real gameplay.',
    '',
    `Time remaining: ${secondsLeft}s.`,
    `Viewport: ${viewport.width}x${viewport.height}. The screenshot has a light ${grid.rows}x${grid.cols} red mark grid over the inner game area. Column labels are in the top/bottom margins and row labels are in the left/right margins.`,
    `Available common controls: ${controls.join(', ')}. You may use literal Playwright keys.`,
    '',
    'Sequence guidance:',
    '- Prefer row/column grid targeting over raw x/y coordinates. For a single pointer target use "cell": {"row": r, "col": c}; for up to 4 possible targets use "cells": [{"row": r, "col": c}].',
    '- Only use raw x/y if the grid is not enough. Raw x/y coordinates are inside the inner game viewport only; ignore the label margins and do not use full-image pixel coordinates.',
    '- Put every input in the "actions" array. Each action must have a "type": "key", "click", "multi_click", "drag", "cursor_move", or "view_move".',
    '- Use "start" and "end" times in milliseconds. Instant actions such as click, multi_click, drag, and cursor_move only need "start".',
    '- The sequence duration is inferred from the latest action "end", or from "start" for instant actions.',
    '- Use type "click" for a single click in the selected cell area. Use type "multi_click" when a target is imprecise or repeated clicking/tapping is useful; it sends quick clicks at random points inside the selected cells.',
    '- Use type "drag" for drag/swipe games with "from" and "to" row/column objects. Use mode "mouse" for canvas or pointer games; use mode "html5" for browser-native drag/drop elements such as match-3 candy boards.',
    '- Use type "cursor_move" for cursor movement without clicking. Use type "view_move" only for relative camera/mouse-look movement where dx/dy matters.',
    '- If the game says paused, resume, continue, start, or shows tutorial controls, follow that visible instruction before doing anything else.',
    '- On menus, prefer options that clearly enter gameplay: Play, Start, New Game, Single Player, Campaign, Level 1, Continue, Resume, or a default character/level choice.',
    '- Avoid Options, Settings, Credits, Help, Leaderboard, and Multiplayer unless they are the only visible path into gameplay.',
    '- If one menu choice does not enter gameplay, go back or try a different start-like choice on the next step. Do not spend turns only describing or waiting on a menu.',
    '- Common resume/confirm keys are Space, Enter, Escape, and P. Use them when the screen suggests a paused/menu state and clicks are not working.',
    '- If the state JSON reports a canvas, treat that canvas rectangle as the active game area unless the screenshot clearly shows otherwise.',
    '- If you die, reset, or return to a map/title screen, re-enter gameplay and change strategy instead of repeating the same failed action.',
    '- Avoid idle waiting. Each step should do something visible or useful for the gameplay video.',
    '- In previous_sequence_outcome, summarize what visibly happened after the most recent prior sequence. If a prior control moved the player, camera, board, score, menu, or level state, say that clearly. On the first sequence, use an empty string.',
    '',
    warning ? `${warning}\n` : '',
    'Recent history:',
    compactHistory(history) || 'none',
    '',
    'Browser/game state JSON:',
    JSON.stringify(state || {}, null, 2).slice(0, 5000),
    '',
    'Return only JSON for the next sequence with this shape:',
    '{',
    '  "summary": "one sentence describing what is visible now and what happened recently",',
    '  "previous_sequence_outcome": "one sentence describing the visible outcome of the previous sequence, or empty on the first sequence",',
    '  "actions": [',
    '    {"type": "key", "start": 0, "end": 300, "key": "ArrowRight"},',
    '    {"type": "key", "start": 200, "end": 700, "key": "ArrowDown"},',
    `    {"type": "click", "start": 100, "cell": ${cellJson(examples.center)}},`,
    `    {"type": "multi_click", "start": 100, "cells": [${cellJson(examples.center)}, ${cellJson(examples.right)}], "count": 10},`,
    `    {"type": "drag", "start": 100, "from": ${cellJson(examples.center)}, "to": ${cellJson(examples.right)}, "mode": "mouse", "steps": 12},`,
    `    {"type": "cursor_move", "start": 100, "cell": ${cellJson(examples.below)}, "steps": 8},`,
    '    {"type": "view_move", "start": 0, "end": 800, "dx": 120, "dy": 0, "steps": 8}',
    '  ],',
    '  "should_stop": false,',
    '  "rationale": "why this is the next useful playtest sequence."',
    '}',
    '',
    'Keep the latest action end/start between 500 and 8000. Use an empty actions array only when no input is needed.',
  ].join('\n');
}

module.exports = {
  buildPlaytesterPrompt,
  compactHistory,
};
