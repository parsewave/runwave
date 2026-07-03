const path = require('path');

const runwaveRoot = path.resolve(__dirname, '..');
const workspaceRoot = process.env.RUNWAVE_WORKSPACE
  ? path.resolve(process.env.RUNWAVE_WORKSPACE)
  : process.cwd();
const sessionFile = process.env.RUNWAVE_SESSION_FILE
  ? path.resolve(process.env.RUNWAVE_SESSION_FILE)
  : path.join(workspaceRoot, '.runwave-session.json');

module.exports = {
  runwaveRoot,
  workspaceRoot,
  sessionFile,
  defaultOutputRoot: path.join(workspaceRoot, 'state', 'output'),
  defaultRecordingRoot: path.join(workspaceRoot, 'recordings'),
};
