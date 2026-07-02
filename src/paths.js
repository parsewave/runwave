const path = require('path');

const harnessRoot = path.resolve(__dirname, '..');
const workspaceRoot = process.env.ACTION_HARNESS_WORKSPACE
  ? path.resolve(process.env.ACTION_HARNESS_WORKSPACE)
  : process.cwd();
const sessionFile = process.env.ACTION_HARNESS_SESSION_FILE
  ? path.resolve(process.env.ACTION_HARNESS_SESSION_FILE)
  : path.join(workspaceRoot, '.action-harness-session.json');

module.exports = {
  harnessRoot,
  workspaceRoot,
  sessionFile,
  defaultOutputRoot: path.join(workspaceRoot, 'state', 'output'),
  defaultRecordingRoot: path.join(workspaceRoot, 'recordings'),
};
