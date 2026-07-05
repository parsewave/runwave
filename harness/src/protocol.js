const path = require('path');
const { pathToFileURL } = require('url');
const { workspaceRoot } = require('./paths');

function usage() {
  return {
    usage: `runwave '<json>'`,
    notes: [
      'Every browser operation must include action_name and session_id.',
      'Use {"action":"sessions"} to list known sessions.',
      'Use start with either url or file.',
      'Each operation writes artifacts to state/output/<action_name>/ by default.',
      'Relative file and output paths resolve from RUNWAVE_WORKSPACE or the current working directory.',
    ],
    examples: [
      {
        action: 'start',
        action_name: 'start-run',
        session_id: 'playtest-001',
        file: 'sunnyland-platformer/index.html',
        record: true,
        keyAliases: { right: 'd', left: 'a', jump: 'w' },
      },
      {
        action: 'step',
        action_name: 'move-right-001',
        session_id: 'playtest-001',
        actions: [
          { type: 'key', start: 0, end: 900, key: 'right' },
          { type: 'key', start: 150, end: 230, key: 'jump' },
        ],
        captures: [900],
        captureIntervalMs: 1000,
      },
      { action: 'screenshot', action_name: 'inspect-001', session_id: 'playtest-001', name: 'screen' },
      { action: 'state', action_name: 'state-001', session_id: 'playtest-001' },
      { action: 'sessions' },
      { action: 'stop', action_name: 'stop-run', session_id: 'playtest-001' },
    ],
  };
}

function assertActionName(input) {
  if (!input || !input.action_name) {
    throw new Error('action_name is required for every runwave operation');
  }
}

function sessionId(input) {
  const value = input && (input.session_id ?? input.sessionId);
  const text = String(value ?? '').trim();
  if (!text) throw new Error('session_id is required for start, stop, and browser actions');
  return text;
}

function assertSessionId(input) {
  sessionId(input);
}

function targetUrl(input, options = {}) {
  if (input.url) return String(input.url);
  if (input.file) {
    const filePath = path.resolve(options.workspaceRoot || workspaceRoot, input.file);
    return pathToFileURL(filePath).href;
  }
  throw new Error('start/navigate requires either url or file');
}

function parseArgList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // Fall through to whitespace parsing.
    }
  }
  return text.split(/\s+/).filter(Boolean);
}

function normalizeSize(value, fallback) {
  const width = Number(value && value.width);
  const height = Number(value && value.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallback.width,
    height: Number.isFinite(height) && height > 0 ? height : fallback.height,
  };
}

function sortedObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function optionalString(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function optionalNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function startSessionConfig(input, options = {}) {
  const viewport = normalizeSize(input.viewport, { width: 1024, height: 620 });
  const recordAudio = Boolean(input.recordAudio);
  const recordVideo = Boolean(input.record || recordAudio);
  return {
    launchUrl: targetUrl(input, options),
    browser: {
      headless: input.headless !== false,
      channel: optionalString(input.channel),
      executablePath: optionalString(input.executablePath),
      chromiumArgsMode: String(input.chromiumArgsMode || process.env.RUNWAVE_CHROMIUM_ARGS_MODE || 'append').toLowerCase(),
      chromiumArgs: parseArgList(input.chromiumArgs ?? process.env.RUNWAVE_CHROMIUM_ARGS),
    },
    context: {
      viewport,
      deviceScaleFactor: optionalNumber(input.deviceScaleFactor, 1),
      recordVideo,
      recordAudio,
      videoSize: recordVideo ? normalizeSize(input.videoSize || input.viewport, viewport) : null,
    },
    navigation: {
      waitUntil: String(input.waitUntil || 'load'),
      waitAfterLoad: optionalNumber(input.waitAfterLoad, 700),
    },
    defaults: {
      keyAliases: sortedObject(input.keyAliases),
      stateExpression: optionalString(input.stateExpression),
      autoCaptures: input.autoCaptures !== false,
      captureIntervalMs: optionalNumber(input.captureIntervalMs, 1000),
      finalScreenshot: input.finalScreenshot !== false,
      fullPageScreenshots: Boolean(input.fullPageScreenshots),
      gridScreenshots: input.gridScreenshots !== false,
      markGridRows: optionalNumber(input.markGridRows ?? input.gridRows, 20),
      markGridCols: optionalNumber(input.markGridCols ?? input.gridCols, 20),
    },
  };
}

function isListSessionsAction(input) {
  return input && (input.action === 'sessions' || input.action === 'list_sessions');
}

function diffStartSessionConfig(requested, existing) {
  if (!existing || typeof existing !== 'object') return ['startConfig'];
  const differences = [];
  for (const key of Object.keys(requested)) {
    if (!sameCanonicalValue(requested[key], existing[key])) differences.push(key);
  }
  for (const key of Object.keys(existing)) {
    if (!Object.prototype.hasOwnProperty.call(requested, key)) differences.push(key);
  }
  return [...new Set(differences)];
}

function parseCliInput(raw) {
  if (!raw || raw === '--help' || raw === 'help') return null;
  return JSON.parse(raw);
}

module.exports = {
  usage,
  assertActionName,
  assertSessionId,
  sessionId,
  targetUrl,
  parseArgList,
  startSessionConfig,
  diffStartSessionConfig,
  isListSessionsAction,
  parseCliInput,
};
