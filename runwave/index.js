'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeTargetKind } = require('./controller/src/protocol');

const DEFAULT_PLAYTEST_DURATION_MS = 150000;

function defaultLog(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

function responseState(response) {
  return (response && response.output && response.output.state) || (response && response.state) || null;
}

function effectiveViewport(response, fallback) {
  const state = responseState(response);
  const viewport = state && state.viewport;
  if (
    viewport
    && Number.isFinite(Number(viewport.width))
    && Number(viewport.width) > 0
    && Number.isFinite(Number(viewport.height))
    && Number(viewport.height) > 0
  ) {
    return { width: Math.round(Number(viewport.width)), height: Math.round(Number(viewport.height)) };
  }
  return fallback;
}

function buildStartAction({
  targetKind,
  runwaveSessionId,
  viewport,
  startOverrides = {},
  absoluteGameDir,
  port,
}) {
  return {
    ...startOverrides,
    action: 'start',
    action_name: 'start',
    session_id: runwaveSessionId,
    kind: targetKind,
    gameDir: absoluteGameDir,
    ...(port ? { port } : {}),
    record: true,
    viewport,
    videoSize: startOverrides.videoSize || viewport,
    outputRoot: 'state/output',
    outDir: 'recordings/session',
    initialScreenshot: true,
    force: true,
    sessionWaitMs: 120000,
  };
}

function controllerArgs(controllerBin, action, verbose) {
  const args = [controllerBin];
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
    viewport,
    startOverrides = {},
    env: envOverrides = {},
    onInitialResponse,
    kind,
    targetKind: requestedTargetKind,
    gameKind,
  } = options || {};

  const targetKind = normalizeTargetKind(kind ?? requestedTargetKind ?? gameKind ?? startOverrides.kind ?? startOverrides.targetKind);
  if (!gameDir) throw new Error('runPlaytest: gameDir is required');
  if (!outDir) throw new Error('runPlaytest: outDir is required');
  if (targetKind === 'web' && !port) throw new Error('runPlaytest: port is required for web games');
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

  const controllerBin = path.join(__dirname, 'controller.js');
  const agentPlayerPath = path.join(__dirname, 'agent', 'src', 'agent-player.js');
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
    targetKind,
    ...(targetKind === 'web' ? { port } : {}),
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

  let controllerStarted = false;
  let failure = null;

  const runControllerAction = async (action) => {
    const payload = { ...action, session_id: action.session_id || runwaveSessionId };
    const result = await run('node', controllerArgs(controllerBin, payload, verbose), { cwd: absoluteOutDir, env }, log);
    return parseActionResponse(result, payload);
  };

  try {
    log('playtest.start', { gameDir: absoluteGameDir, targetKind, port: targetKind === 'web' ? port : undefined, playtestDurationMs });

    const start = buildStartAction({
      targetKind,
      runwaveSessionId,
      viewport,
      startOverrides,
      absoluteGameDir,
      port,
    });

    const initialResponse = await runControllerAction(start);
    controllerStarted = true;

    if (typeof onInitialResponse === 'function') {
      await onInitialResponse(initialResponse);
    }

    const job = buildAgentJob({
      playtestDurationMs,
      viewport: effectiveViewport(initialResponse, viewport),
      playtestInstructions,
      start,
      minPlaytestMs,
    });

    const playtest = await runAgenticPlaytest({
      job,
      initialResponse,
      runAction: runControllerAction,
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
    summary.viewport = job.viewport;
    summary.status = 'passed';
  } catch (error) {
    failure = error;
    summary.status = 'failed';
    summary.error = error.message;
    summary.stack = error.stack;
    log('playtest.error', { error: error.message });
  } finally {
    if (controllerStarted) {
      try {
        const stopResponse = await runControllerAction({ action: 'stop', action_name: 'stop', session_id: runwaveSessionId });
        summary.recording = validateRecordingArtifact(stopResponse);
      } catch (error) {
        if (!failure) failure = error;
        summary.status = 'failed';
        summary.error = summary.error || error.message;
        summary.recordingError = error.message;
        log('controller.stop.error', { error: error.message });
      }
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
  buildStartAction,
  effectiveViewport,
  runPlaytest,
  validateRecordingArtifact,
};
