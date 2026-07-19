const { BrowserSession } = require('./browser-session');
const { LinuxSession } = require('./linux-session');
const { targetKind } = require('./protocol');

function createSession(config, paths, profiler = null) {
  const kind = targetKind(config);
  if (kind === 'linux') return new LinuxSession(config, paths, profiler);
  return new BrowserSession(config, paths, profiler);
}

module.exports = {
  createSession,
};
