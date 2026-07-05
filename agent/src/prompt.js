'use strict';

const { markGridFromConfig } = require('../../controller/src/mark-grid');

function gridExampleCells(grid) {
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(grid.rows / 2)));
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(grid.cols / 2)));
  const center = row * grid.cols + col;
  const right = row * grid.cols + Math.min(grid.cols - 1, col + 1);
  const above = Math.max(0, row - 1) * grid.cols + col;
  return { center, right, above };
}

function sequenceSchemaGuide(grid = markGridFromConfig({})) {
  const examples = gridExampleCells(grid);
  return [
    'JSON output contract:',
    'Return exactly one JSON object. No markdown, no prose outside JSON.',
    'Top-level keys must be exactly: "summary", "previous_sequence_outcome", "actions", "should_stop", "rationale".',
    'Actions must match one of these shapes; do not add extra fields:',
    '{"type":"key","start":0,"end":500,"key":"ArrowRight"}',
    `{"type":"click","start":100,"cell":${examples.center}}`,
    `{"type":"multi_click","start":100,"cells":[${examples.center},${examples.right}],"count":8}`,
    `{"type":"drag","start":100,"from_cells":[${examples.center}],"to_cells":[${examples.right}],"mode":"mouse","steps":12}`,
    `{"type":"cursor_move","start":100,"cell":${examples.above},"steps":8}`,
    '{"type":"view_move","start":0,"end":800,"dx":120,"dy":0,"steps":8}',
    'Timing rules: use milliseconds; click <=100ms if end is provided; drag/cursor_move <=2000ms if end is provided; key/view_move may be longer; whole sequence must stay under 8000ms.',
    `Click, multi_click, drag, and cursor_move may omit end; RunWave adds a short default. Prefer numbered grid cells 0-${grid.rows * grid.cols - 1} over raw x/y.`,
  ].join('\n');
}

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
  if (action.type === 'failed_action') return `failed_action(${String(action.error || '').slice(0, 80)})`;
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

function playtestInstructionsSection(job) {
  const instructions = String(job.playtestInstructions || '').trim();
  if (!instructions) return [];
  return [
    'Game-specific playtest.md:',
    instructions.slice(0, 8000),
    '',
    'Use these game-specific controls when they apply. If they conflict with visible in-game instructions, follow the visible current screen.',
    '',
  ];
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
    sequenceSchemaGuide(grid),
    '',
    `Time remaining: ${secondsLeft}s.`,
    `Viewport: ${viewport.width}x${viewport.height}. The screenshot has a light ${grid.rows}x${grid.cols} red mark grid labeled 0 through ${grid.rows * grid.cols - 1}, row-major from top-left to bottom-right.`,
    `Available common controls: ${controls.join(', ')}. You may use literal Playwright keys.`,
    '',
    ...playtestInstructionsSection(job),
    'Sequence guidance:',
    '- Prefer grid-cell targeting over raw x/y coordinates. For pointer actions, choose up to 4 relevant grid cell IDs using "cells": [id].',
    '- Put every input in the "actions" array. Each action must have a "type": "key", "click", "multi_click", "drag", "cursor_move", or "view_move".',
    '- Use "start" and "end" times in milliseconds. Instant actions such as click, multi_click, drag, and cursor_move only need "start".',
    '- The sequence duration is inferred from the latest action "end", or from "start" for instant actions. The runner will send that duration explicitly to the browser controller.',
    '- For pointer-only sequences, do not put the final pointer action exactly at the end of the sequence. Leave at least 100ms after the final click, drag, multi_click, or cursor_move by scheduling it before the latest action end/start.',
    '- Never use a pointer action start time beyond the sequence duration. Keep all click, multi_click, drag, and cursor_move start times strictly before the latest end/start in the sequence.',
    '- Use type "click" for a single click in the selected cell area. Use type "multi_click" when a target is imprecise or repeated clicking/tapping is useful; it sends quick clicks at random points inside the selected cells.',
    '- Use type "drag" for drag/swipe games with "from_cells" and "to_cells". Use mode "mouse" for canvas or pointer games; use mode "html5" for browser-native drag/drop elements such as match-3 candy boards.',
    '- If the game says paused, resume, continue, start, or shows tutorial controls, follow that visible instruction before doing anything else.',
    '- On menus, prefer options that clearly enter gameplay: Play, Start, New Game, Single Player, Campaign, Level 1, Continue, Resume, or a default character/level choice.',
    '- Avoid Options, Settings, Credits, Help, Leaderboard, and Multiplayer unless they are the only visible path into gameplay.',
    '- If one menu choice does not enter gameplay, go back or try a different start-like choice on the next step. Do not spend turns only describing or waiting on a menu.',
    '- Common resume/confirm keys are Space, Enter, Escape, and P. Use them when the screen suggests a paused/menu state and clicks are not working.',
    '- If the state JSON reports a canvas, treat that canvas rectangle as the active game area unless the screenshot clearly shows otherwise.',
    '- If you die, reset, or return to a map/title screen, re-enter gameplay and change strategy instead of repeating the same failed action.',
    '- If the same thing has failed about 3-5 times with no visible progress, say that in previous_sequence_outcome and try a different target, route, control, or strategy.',
    '- If an action or strategy visibly worked, learn the pattern and try a similar follow-up, but do not blindly repeat the exact same input unless the game clearly needs repetition.',
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
    'Return the next JSON sequence now. Use an empty actions array only when no input is needed.',
  ].join('\n');
}

module.exports = {
  buildPlaytesterPrompt,
  compactHistory,
  sequenceSchemaGuide,
};
