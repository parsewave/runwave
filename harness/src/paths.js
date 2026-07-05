const path = require('path');

const runwaveRoot = path.resolve(__dirname, '..');
const workspaceRoot = process.env.RUNWAVE_WORKSPACE
  ? path.resolve(process.env.RUNWAVE_WORKSPACE)
  : process.cwd();
const sessionDir = process.env.RUNWAVE_SESSION_DIR
  ? path.resolve(process.env.RUNWAVE_SESSION_DIR)
  : path.join(workspaceRoot, '.runwave-sessions');

function safeSessionId(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function sessionFileForId(id) {
  return path.join(sessionDir, `${safeSessionId(id)}.json`);
}

module.exports = {
  runwaveRoot,
  workspaceRoot,
  sessionDir,
  sessionFileForId,
  defaultOutputRoot: path.join(workspaceRoot, 'state', 'output'),
  defaultRecordingRoot: path.join(workspaceRoot, 'recordings'),
};
