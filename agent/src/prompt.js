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
      ];
      return `step ${item.step}: ${item.summary || item.rationale || 'no summary'}; controls=${controls.join(',') || 'none'}${compactPostActionResult(item.result)}${compactOutcomeSummary(item.outcomeSummary)}`;
    })
    .join('\n');
}

function repeatedHistoryWarning(history) {
  const recent = history.slice(-3);
  if (recent.length < 3) return '';
  const signatures = recent.map((item) => {
    const commands = (item.commands || []).map((command) => command.key).join(',');
    const clicks = (item.clicks || []).map((click) => `${Math.round(click.x / 20) * 20},${Math.round(click.y / 20) * 20}`).join(',');
    const drags = (item.drags || [])
      .map((drag) => `${Math.round(drag.from.x / 20) * 20},${Math.round(drag.from.y / 20) * 20}->${Math.round(drag.to.x / 20) * 20},${Math.round(drag.to.y / 20) * 20}`)
      .join(',');
    return `${commands}|${clicks}|${drags}`;
  });
  if (signatures[0] && signatures.every((signature) => signature === signatures[0])) {
    return 'Warning: the recent actions repeated the same controls. Switch strategy now instead of trying the same input again.';
  }

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
    '- If movement is possible, explore new screens and avoid staying in one place.',
    '- If there is no movement, perform meaningful game actions repeatedly.',
    '- Prefer steady, understandable play over random key mashing.',
    '- Do not stop early unless the recording already shows enough real gameplay.',
    '',
    `Time remaining: ${secondsLeft}s.`,
    `Viewport: ${viewport.width}x${viewport.height}. Click coordinates use this pixel space with origin at top-left.`,
    `Available common controls: ${controls.join(', ')}. You may use literal Playwright keys.`,
    '',
    'Action guidance:',
    '- You may use normalized click coordinates from 0 to 1. For example, x=0.5 and y=0.5 means the center of the current viewport.',
    '- For drag/swipe games, use drags. Use mode "mouse" for canvas or pointer games; use mode "html5" for browser-native drag/drop elements such as match-3 candy boards.',
    '- If a click did not change the screen, do not repeat the exact same click more than twice. Pick a meaningfully different visible target or try a keyboard control shown by the game.',
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
    '  "commands": [{"from": 0, "to": 3000, "key": "ArrowRight"}],',
    '  "clicks": [{"at": 100, "x": 640, "y": 360}],',
    '  "drags": [{"at": 100, "from": {"x": 400, "y": 300}, "to": {"x": 480, "y": 300}, "mode": "mouse", "steps": 12}],',
    '  "view_moves": [{"from": 0, "to": 800, "dx": 120, "dy": 0, "steps": 8}],',
    '  "should_stop": false,',
    '  "rationale": "why this is the next useful playtest action."',
    '}',
    '',
    'Use duration_ms between 500 and 8000. Use empty arrays when no clicks, drags, or view movement are needed.',
  ].join('\n');
}

module.exports = {
  buildPlaytesterPrompt,
  compactHistory,
};
