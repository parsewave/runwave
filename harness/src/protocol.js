const path = require('path');
const { pathToFileURL } = require('url');
const { workspaceRoot } = require('./paths');

function usage() {
  return {
    usage: `runwave '<json>'`,
    notes: [
      'Every harness operation must include action_name.',
      'Use start with either url or file.',
      'Each operation writes artifacts to state/output/<action_name>/ by default.',
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
        actions: [
          { type: 'key', start: 0, end: 900, key: 'right' },
          { type: 'key', start: 150, end: 230, key: 'jump' },
        ],
        captures: [900],
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
    throw new Error('action_name is required for every runwave operation');
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
