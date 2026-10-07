const { BrowserSession } = require('./browser-session');
const { LinuxSession } = require('./linux-session');
const { SteppedBrowserSession } = require('./stepped-session');
const { targetKind } = require('./protocol');
const { readGameManifest } = require('./game-manifest');

function createSession(config, paths, profiler = null) {
  const kind = targetKind(config);
  if (kind === 'linux') return new LinuxSession(config, paths, profiler);
  const mode = config.executionMode || 'stepped';
  if (!['stepped', 'realtime'].includes(mode)) throw new Error(`unknown executionMode: ${mode}`);
  if (mode === 'stepped') return new SteppedBrowserSession({ ...readGameManifest(config.gameDir), ...config }, paths, profiler);
  return new BrowserSession(config, paths, profiler);
}

module.exports = {
  createSession,
};
