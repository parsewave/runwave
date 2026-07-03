'use strict';

function compactHistory(history, limit = 8) {
  return history
    .slice(-limit)
    .map((item) => {
      const controls = [
        ...(item.commands || []).map((command) => command.key),
        ...(item.clicks || []).map((click) => `click(${click.x},${click.y})`),
      ];
      return `step ${item.step}: ${item.summary || item.rationale || 'no summary'}; controls=${controls.join(',') || 'none'}`;
    })
    .join('\n');
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
    'Recent history:',
    compactHistory(history) || 'none',
    '',
    'Browser/game state JSON:',
    JSON.stringify(state || {}, null, 2).slice(0, 5000),
    '',
    'Return only JSON with this shape:',
    '{',
    '  "summary": "one sentence describing what is visible now and what happened recently",',
    '  "duration_ms": 3000,',
    '  "commands": [{"from": 0, "to": 3000, "key": "ArrowRight"}],',
    '  "clicks": [{"at": 100, "x": 640, "y": 360}],',
    '  "view_moves": [{"from": 0, "to": 800, "dx": 120, "dy": 0, "steps": 8}],',
    '  "should_stop": false,',
    '  "rationale": "why this is the next useful playtest action"',
    '}',
    '',
    'Use duration_ms between 500 and 8000. Use empty arrays when no clicks or view movement are needed.',
  ].join('\n');
}

module.exports = {
  buildPlaytesterPrompt,
};
