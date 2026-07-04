const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { postJson } = require('./http-json');
const { readJson, removeFileIfExists, sleep } = require('./file-utils');
const { sessionFile, workspaceRoot } = require('./paths');
const { createProfiler } = require('./profiler');
const { assertActionName, parseCliInput, targetUrl, usage } = require('./protocol');

const DEFAULT_SESSION_WAIT_MS = 60000;
const DEFAULT_FORCE_STOP_WAIT_MS = 5000;

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

function forceStopWaitMs(input) {
  return positiveNumber(input.forceStopWaitMs ?? process.env.RUNWAVE_FORCE_STOP_WAIT_MS, DEFAULT_FORCE_STOP_WAIT_MS);
}

function isPidRunning(pid, kill = process.kill) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    kill(parsed, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (error && error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForPidExit(pid, timeoutMs, sleepFn = sleep, kill = process.kill) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return true;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidRunning(parsed, kill)) return true;
    await sleepFn(100);
  }
  return !isPidRunning(parsed, kill);
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

async function stopExistingSessionForForce(input, profiler, options = {}) {
  const file = options.sessionFilePath || sessionFile;
  const exists = options.existsSync || fs.existsSync;
  const read = options.readJson || readJson;
  const remove = options.removeFileIfExists || removeFileIfExists;
  const post = options.postJson || postJson;
  const sleepFn = options.sleep || sleep;
  const kill = options.kill || process.kill;

  if (!exists(file)) return { stopped: false, reason: 'no-session' };

  let session;
  try {
    session = read(file);
  } catch (error) {
    profiler.mark('cli.force_stop.invalid_session_file', { sessionFile: file, error: error.message });
    remove(file);
    return { stopped: false, reason: 'invalid-session-file' };
  }

  const pid = Number(session.pid);
  const waitMs = forceStopWaitMs(input);
  const runningBeforeStop = isPidRunning(pid, kill);
  profiler.mark('cli.force_stop.session_found', {
    sessionFile: file,
    pid: session.pid,
    port: session.port,
    running: runningBeforeStop,
    waitMs,
  });

  let stopResponse = null;
  let stopError = null;
  if (session.port) {
    try {
      stopResponse = await profiler.time('cli.force_stop.post_stop', { port: session.port }, () =>
        post(session.port, {
          action: 'stop',
          action_name: `${input.action_name}-force-stop`,
          finalScreenshot: false,
          __runwaveVerbose: input.__runwaveVerbose,
        })
      );
      if (!stopResponse || stopResponse.ok === false) {
        throw new Error(`forced stop failed: ${JSON.stringify(stopResponse).slice(0, 500)}`);
      }
    } catch (error) {
      stopError = error;
      profiler.mark('cli.force_stop.post_stop_error', { port: session.port, error: error.message });
    }
  }

  if (Number.isInteger(pid) && pid > 0) {
    const exited = await profiler.time('cli.force_stop.wait_for_exit', { pid, waitMs }, () =>
      waitForPidExit(pid, waitMs, sleepFn, kill)
    );
    if (!exited) {
      const message = stopError
        ? `existing runwave session pid ${pid} is still running after forced stop failed: ${stopError.message}`
        : `existing runwave session pid ${pid} did not exit within ${waitMs}ms`;
      throw new Error(message);
    }
  } else if (stopError) {
    remove(file);
    return { stopped: false, reason: 'stale-unreachable-session', error: stopError.message };
  }

  remove(file);
  return {
    stopped: Boolean(stopResponse && stopResponse.ok !== false),
    reason: stopResponse ? 'stopped' : 'stale-session',
    session,
  };
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
  if (input.force) {
    await profiler.time('cli.start.force_stop_existing_session', { sessionFile }, () =>
      stopExistingSessionForForce(input, profiler)
    );
  }
  const existing = await profiler.time('cli.start.existing_session', () => existingSessionStart(input, profiler));
  if (existing) return existing;

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
  forceStopWaitMs,
  isPidRunning,
  stopExistingSessionForForce,
  waitForPidExit,
  cliArgs,
};
