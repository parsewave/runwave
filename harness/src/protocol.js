const path = require('path');
const { pathToFileURL } = require('url');
const { workspaceRoot } = require('./paths');

function usage() {
  return {
    usage: `runwave '<json>'`,
    notes: [
      'Every command must include action_name.',
      'Use start with either url or file.',
      'Each command writes artifacts to state/output/<action_name>/ by default.',
      'Relative file and output paths resolve from RUNWAVE_WORKSPACE or the current working directory.',
    ],
    examples: [
      {
        action: 'start',
        action_name: 'start-run',
        file: 'sunnyland-platformer/index.html',
        record: true,
        keyAliases: { right: 'd', left: 'a', jump: 'w' },
      },
      {
        action: 'step',
        action_name: 'move-right-001',
        duration: 1200,
        commands: [
          { from: 0, to: 900, key: 'right' },
          { from: 150, to: 230, key: 'jump' },
        ],
        clicks: [{ at: 400, x: 512, y: 310 }],
        view_moves: [{ from: 500, to: 900, dx: 180, dy: -20, steps: 12 }],
        captures: [1200],
        captureIntervalMs: 1000,
      },
      { action: 'screenshot', action_name: 'inspect-001', name: 'screen' },
      { action: 'state', action_name: 'state-001' },
      { action: 'stop', action_name: 'stop-run' },
    ],
  };
}

function assertActionName(input) {
  if (!input || !input.action_name) {
    throw new Error('action_name is required for every runwave command');
  }
}

function targetUrl(input) {
  if (input.url) return String(input.url);
  if (input.file) {
    const filePath = path.resolve(workspaceRoot, input.file);
    return pathToFileURL(filePath).href;
  }
  throw new Error('start/navigate requires either url or file');
}

function parseCliInput(raw) {
  if (!raw || raw === '--help' || raw === 'help') return null;
  return JSON.parse(raw);
}

module.exports = {
  usage,
  assertActionName,
  targetUrl,
  parseCliInput,
};
