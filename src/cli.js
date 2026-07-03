const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { postJson } = require('./http-json');
const { readJson, removeFileIfExists, sleep } = require('./file-utils');
const { sessionFile, workspaceRoot } = require('./paths');
const { createProfiler } = require('./profiler');
const { assertActionName, parseCliInput, targetUrl, usage } = require('./protocol');

const DEFAULT_SESSION_WAIT_MS = 60000;

function cliArgs() {
  const args = process.argv.slice(2);
  let verbose = false;
  const inputArgs = [];
  for (const arg of args) {
    if (arg === '-v' || arg === '--verbose') {
      verbose = true;
    } else {
      inputArgs.push(arg);
    }
  }
  return { inputArgs, verbose };
}

function readInput(inputArgs) {
  const arg = inputArgs.join(' ').trim();
  if (arg) return Promise.resolve(arg);
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw.trim()));
  });
}

function currentSession() {
  if (!fs.existsSync(sessionFile)) {
    throw new Error('runwave is not running; start it first');
  }
  return readJson(sessionFile);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sessionWaitMs(input) {
  return positiveNumber(input.sessionWaitMs ?? process.env.RUNWAVE_SESSION_WAIT_MS, DEFAULT_SESSION_WAIT_MS);
}

async function waitForSession(pid, timeoutMs = DEFAULT_SESSION_WAIT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(sessionFile)) {
      const session = readJson(sessionFile);
      if (!pid || session.pid === pid) return session;
    }
    await sleep(100);
  }
  throw new Error('timed out waiting for runwave session');
}

async function existingSessionStart(input, profiler) {
  if (!fs.existsSync(sessionFile) || input.force) return null;
  const session = currentSession();
  try {
    const ping = await profiler.time('cli.existing_session.ping', { port: session.port }, () =>
      postJson(session.port, { action: 'ping', action_name: input.action_name, __runwaveVerbose: input.__runwaveVerbose })
    );
    const state = await profiler.time('cli.existing_session.state', { port: session.port }, () =>
      postJson(session.port, { action: 'state', action_name: input.action_name, __runwaveVerbose: input.__runwaveVerbose })
    );
    return {
      ok: true,
      action: 'start',
      action_name: input.action_name,
      alreadyRunning: true,
      session,
      ping,
      output: state,
      ...(input.__runwaveVerbose && session.verboseLogPath ? { verboseLog: session.verboseLogPath } : {}),
    };
  } catch {
    removeFileIfExists(sessionFile);
    return null;
  }
}

async function start(input, profiler) {
  profiler.timeSync('cli.start.target_url', () => targetUrl(input));
  const existing = await profiler.time('cli.start.existing_session', () => existingSessionStart(input, profiler));
  if (existing) return existing;
  if (input.force) profiler.timeSync('cli.start.remove_session_file', { sessionFile }, () => removeFileIfExists(sessionFile));

  const daemon = path.resolve(__dirname, 'daemon.js');
  const child = profiler.timeSync('cli.start.spawn_daemon', { daemon }, () =>
    spawn(process.execPath, [daemon, JSON.stringify(input)], {
      cwd: workspaceRoot,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  );
  child.unref();

  const waitMs = sessionWaitMs(input);
  const session = await profiler.time('cli.start.wait_for_session', { pid: child.pid, timeoutMs: waitMs }, () =>
    waitForSession(child.pid, waitMs)
  );
  if (session.verboseLogPath) profiler.setLogPath(session.verboseLogPath);
  profiler.mark('cli.start.session_ready', { sessionFile, sessionDir: session.sessionDir });
  const output = profiler.timeSync('cli.start.read_initial_response', { path: session.initialResponsePath }, () =>
    readJson(session.initialResponsePath)
  );
  return {
    ok: true,
    action: 'start',
    action_name: input.action_name,
    session,
    output,
    ...(input.__runwaveVerbose && session.verboseLogPath ? { verboseLog: session.verboseLogPath } : {}),
  };
}

async function dispatch(input, profiler) {
  profiler.timeSync('cli.dispatch.assert_action_name', () => assertActionName(input));
  if (input.action === 'start') return start(input, profiler);
  const session = profiler.timeSync('cli.dispatch.current_session', { sessionFile }, () => currentSession());
  if (session.verboseLogPath) profiler.setLogPath(session.verboseLogPath);
  return profiler.time('cli.dispatch.post_json', { action: input.action, action_name: input.action_name, port: session.port }, () =>
    postJson(session.port, input)
  );
}

async function main() {
  const { inputArgs, verbose } = cliArgs();
  const profiler = createProfiler({ enabled: verbose, source: 'cli' });
  try {
    profiler.mark('cli.start', { argv: inputArgs, verbose });
    const raw = await profiler.time('cli.read_input', { fromArgv: inputArgs.length > 0 }, () => readInput(inputArgs));
    const input = profiler.timeSync('cli.parse_input', () => parseCliInput(raw));
    if (!input) {
      console.log(JSON.stringify(usage(), null, 2));
      return;
    }
    if (verbose) input.__runwaveVerbose = true;
    const response = await profiler.time('cli.dispatch', { action: input.action, action_name: input.action_name }, () =>
      dispatch(input, profiler)
    );
    if (response.verboseLog) profiler.setLogPath(response.verboseLog);
    if (response.output && response.output.verboseLog) profiler.setLogPath(response.output.verboseLog);
    profiler.mark('cli.response_ready', { action: input.action, action_name: input.action_name });
    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    profiler.mark('cli.error', { error: error.message });
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  } finally {
    profiler.mark('cli.end');
    profiler.flush();
  }
}

module.exports = {
  main,
  sessionWaitMs,
  cliArgs,
};
