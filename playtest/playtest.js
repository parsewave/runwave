'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PLAYTEST_DURATION_MS = 150000;
const DEFAULT_PROCESS_STOP_WAIT_MS = 5000;
const DEFAULT_PROCESS_KILL_WAIT_MS = 5000;
const DEFAULT_HTTP_TIMEOUT_MS = 60000;

function defaultLog(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function assertGameDir(gameDir) {
  const startScript = path.join(gameDir, 'start.sh');
  const playtestMd = path.join(gameDir, 'playtest.md');
  if (!fs.existsSync(startScript)) throw new Error(`game directory missing start.sh: ${startScript}`);
  if (!fs.existsSync(playtestMd)) throw new Error(`game directory missing playtest.md: ${playtestMd}`);
  return { startScript, playtestMd };
}

function loadPlaytestInstructions(playtestMd) {
  return fs.readFileSync(playtestMd, 'utf8');
}

function run(command, args, options = {}, log = defaultLog) {
  return new Promise((resolve, reject) => {
    log('command.start', { command, args, cwd: options.cwd });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      log('command.end', { command, code });
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else {
        const error = new Error(`${command} exited ${code}`);
        error.result = result;
        reject(error);
      }
    });
  });
}

function spawnLong(command, args, options = {}, log = defaultLog) {
  log('process.start', { command, args, cwd: options.cwd });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: options.detached !== false,
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('close', (code) => log('process.end', { command, code }));
  return child;
}

function processHasClosed(child) {
  return Boolean(child && (child.exitCode !== null || child.signalCode !== null));
}

function signalLongProcess(child, signal) {
  if (!child || !child.pid) return false;
  const target = process.platform === 'win32' ? child.pid : -child.pid;
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function waitForProcessClose(child, timeoutMs) {
  if (!child || processHasClosed(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const onClose = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
    timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(processHasClosed(child));
    }, Math.max(0, timeoutMs));
  });
}

async function stopLongProcess(child, options = {}, log = defaultLog) {
  if (!child || processHasClosed(child)) return { stopped: true, reason: 'already-closed' };
  const termWaitMs = Math.max(0, Number(options.termWaitMs ?? DEFAULT_PROCESS_STOP_WAIT_MS));
  const killWaitMs = Math.max(0, Number(options.killWaitMs ?? DEFAULT_PROCESS_KILL_WAIT_MS));
  const label = options.label || 'process';
  log('process.stop.start', { label, pid: child.pid, termWaitMs, killWaitMs });
  if (!signalLongProcess(child, 'SIGTERM')) return { stopped: true, reason: 'not-running' };
  if (await waitForProcessClose(child, termWaitMs)) {
    log('process.stop.end', { label, pid: child.pid, escalated: false });
    return { stopped: true, reason: 'terminated' };
  }
  log('process.stop.escalate', { label, pid: child.pid });
  signalLongProcess(child, 'SIGKILL');
  const stopped = await waitForProcessClose(child, killWaitMs);
  log('process.stop.end', { label, pid: child.pid, escalated: true, stopped });
  return { stopped, reason: stopped ? 'killed' : 'kill-timeout' };
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`timed out waiting for ${url}`));
      else setTimeout(check, 500);
    };
    check();
  });
}

function parseActionResponse(result, action) {
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error(`runwave returned non-JSON output for ${action.action_name || action.action}: ${result.stdout.slice(-2000)}`);
  }
  if (!response || response.ok === false) {
    throw new Error(`runwave action failed for ${action.action_name || action.action}: ${JSON.stringify(response).slice(0, 2000)}`);
  }
  return response;
}

function validateRecordingArtifact(stopResponse) {
  const video = stopResponse && (stopResponse.audioVideo || stopResponse.video);
  if (!video || typeof video !== 'string') {
    throw new Error('runwave stop did not return an audio/video recording path');
  }
  let stat;
  try {
    stat = fs.statSync(video);
  } catch (error) {
    throw new Error(`runwave recording is missing: ${video}`);
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`runwave recording is empty or invalid: ${video}`);
  }
  return { path: video, bytes: stat.size };
}

function buildAgentJob({ playtestDurationMs, minPlaytestMs, viewport, playtestInstructions, start = {} }) {
  return {
    playtestDurationMs,
    agentMinPlaytestMs: minPlaytestMs ?? Math.max(0, playtestDurationMs - 10000),
    viewport,
    videoSize: viewport,
    playtestInstructions,
    markGridRows: start.markGridRows,
    markGridCols: start.markGridCols,
  };
}

function harnessArgs(runwaveBin, action, verbose) {
  const args = [runwaveBin];
  if (verbose) args.push('-v');
  args.push(JSON.stringify(action));
  return args;
}

async function runPlaytest(options) {
  const {
    gameDir,
    outDir,
    port,
    openRouterApiKey,
    playtestDurationMs = DEFAULT_PLAYTEST_DURATION_MS,
    minPlaytestMs,
    model,
    verbose = false,
    onLog,
    sessionId,
    httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
    processStopWaitMs = DEFAULT_PROCESS_STOP_WAIT_MS,
    processKillWaitMs = DEFAULT_PROCESS_KILL_WAIT_MS,
    viewport,
    startOverrides = {},
    env: envOverrides = {},
    onInitialResponse,
  } = options || {};

  if (!gameDir) throw new Error('runPlaytest: gameDir is required');
  if (!outDir) throw new Error('runPlaytest: outDir is required');
  if (!port) throw new Error('runPlaytest: port is required');
  if (!openRouterApiKey) throw new Error('runPlaytest: openRouterApiKey is required');
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error('runPlaytest: viewport {width,height} is required');
  }

  const log = typeof onLog === 'function' ? onLog : defaultLog;
  const absoluteGameDir = path.resolve(gameDir);
  const absoluteOutDir = path.resolve(outDir);
  mkdirp(absoluteOutDir);

  const { playtestMd } = assertGameDir(absoluteGameDir);
  const playtestInstructions = loadPlaytestInstructions(playtestMd);

  const runwaveRoot = path.resolve(__dirname, '..');
  const runwaveBin = path.join(runwaveRoot, 'bin', 'runwave.js');
  const agentPlayerPath = path.join(runwaveRoot, 'agent', 'src', 'agent-player.js');
  const { runAgenticPlaytest } = require(agentPlayerPath);

  const env = {
    ...process.env,
    ...envOverrides,
    OPENROUTER_API_KEY: openRouterApiKey,
    RUNWAVE_WORKSPACE: absoluteOutDir,
    RUNWAVE_SESSION_DIR: path.join(absoluteOutDir, '.runwave-sessions'),
  };
  if (model) env.RUNWAVE_AGENT_MODEL = String(model);
  if (verbose) env.RUNWAVE_VERBOSE = '1';

  const runwaveSessionId = sessionId || `playtest-${Date.now()}`;
  const summary = {
    gameDir: absoluteGameDir,
    outDir: absoluteOutDir,
    port,
    playtestDurationMs,
    minPlaytestMs: minPlaytestMs ?? Math.max(0, playtestDurationMs - 10000),
    model: model || env.RUNWAVE_AGENT_MODEL || env.OPENROUTER_MODEL || null,
    sessionId: runwaveSessionId,
    startedAt: new Date().toISOString(),
    status: 'running',
    playtestInstructionsBytes: Buffer.byteLength(playtestInstructions, 'utf8'),
  };
  const summaryPath = path.join(absoluteOutDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  let gameProcess = null;
  let harnessStarted = false;
  let failure = null;

  const runHarnessAction = async (action) => {
    const payload = { ...action, session_id: action.session_id || runwaveSessionId };
    const result = await run('node', harnessArgs(runwaveBin, payload, verbose), { cwd: absoluteOutDir, env }, log);
    return parseActionResponse(result, payload);
  };

  try {
    log('playtest.start', { gameDir: absoluteGameDir, port, playtestDurationMs });

    gameProcess = spawnLong('bash', ['start.sh'], {
      cwd: absoluteGameDir,
      env: { ...env, PORT: String(port) },
    }, log);

    const url = `http://127.0.0.1:${port}/`;
    await waitForHttp(url, httpTimeoutMs);
    log('game.ready', { url });

    const start = {
      ...startOverrides,
      action: 'start',
      action_name: 'start',
      session_id: runwaveSessionId,
      url,
      record: true,
      headless: false,
      viewport,
      videoSize: startOverrides.videoSize || viewport,
      outputRoot: 'state/output',
      outDir: 'recordings/session',
      initialScreenshot: true,
      force: true,
      sessionWaitMs: 120000,
    };

    const initialResponse = await runHarnessAction(start);
    harnessStarted = true;

    if (typeof onInitialResponse === 'function') {
      await onInitialResponse(initialResponse);
    }

    const job = buildAgentJob({
      playtestDurationMs,
      viewport,
      playtestInstructions,
      start,
      minPlaytestMs,
    });

    const playtest = await runAgenticPlaytest({
      job,
      initialResponse,
      runAction: runHarnessAction,
      outputDir: path.join(absoluteOutDir, 'agent'),
      log,
    });

    summary.playtest = {
      mode: playtest.mode,
      steps: playtest.steps,
      elapsedMs: playtest.elapsedMs,
      stoppedByAgent: playtest.stoppedByAgent,
      outputDir: playtest.outputDir,
    };
    summary.viewport = viewport;
    summary.status = 'passed';
  } catch (error) {
    failure = error;
    summary.status = 'failed';
    summary.error = error.message;
    summary.stack = error.stack;
    log('playtest.error', { error: error.message });
  } finally {
    if (harnessStarted) {
      try {
        const stopResponse = await runHarnessAction({ action: 'stop', action_name: 'stop', session_id: runwaveSessionId });
        summary.recording = validateRecordingArtifact(stopResponse);
      } catch (error) {
        if (!failure) failure = error;
        summary.status = 'failed';
        summary.error = summary.error || error.message;
        summary.recordingError = error.message;
        log('harness.stop.error', { error: error.message });
      }
    }
    if (gameProcess) {
      summary.gameProcessCleanup = await stopLongProcess(gameProcess, {
        label: 'game',
        termWaitMs: processStopWaitMs,
        killWaitMs: processKillWaitMs,
      }, log).catch((error) => {
        log('game.stop.error', { error: error.message });
        return { stopped: false, reason: 'error', error: error.message };
      });
    }
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    log('playtest.end', { status: summary.status });
  }

  if (failure) throw Object.assign(failure, { summary });
  return summary;
}

module.exports = {
  buildAgentJob,
  runPlaytest,
  validateRecordingArtifact,
};
