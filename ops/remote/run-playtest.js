#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--job') out.job = argv[++i];
    else if (arg.startsWith('--job=')) out.job = arg.slice('--job='.length);
  }
  return out;
}

function loadEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/);
    if (match) env[match[1]] = match[2].replace(/'"'"'/g, "'");
  }
  return env;
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function runnerPaths(env = process.env) {
  return {
    gamesRoot: env.RUNWAVE_GAMES_ROOT || '/opt/runwave/games',
    jobsRoot: env.RUNWAVE_JOBS_ROOT || '/var/lib/runwave/jobs',
  };
}

function run(command, args, options = {}) {
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

function spawnLong(command, args, options = {}) {
  log('process.start', { command, args, cwd: options.cwd });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('close', (code) => log('process.end', { command, code }));
  return child;
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

async function checkoutRunwave(job, runwaveDir, env = process.env) {
  await run('git', ['clone', job.runwaveRepo || 'https://github.com/parsewave/runwave', runwaveDir], { env });
  if (job.runwaveRef) {
    await run('git', ['fetch', '--depth', '1', 'origin', job.runwaveRef], { cwd: runwaveDir, env });
    await run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: runwaveDir, env });
  }
  if (fs.existsSync(path.join(runwaveDir, 'package-lock.json'))) {
    await run('npm', ['ci'], { cwd: runwaveDir, env });
  } else {
    await run('npm', ['install'], { cwd: runwaveDir, env });
  }
  if (job.skipPlaywrightInstall || env.RUNWAVE_SKIP_PLAYWRIGHT_INSTALL === '1') {
    log('playwright.install.skip', { runwaveDir });
    return;
  }
  await run('npx', ['playwright', 'install', 'chromium'], { cwd: runwaveDir, env });
}

function defaultPlan(durationMs = 120000) {
  const totalDuration = Math.max(5000, Number(durationMs) || 120000);
  const focusDuration = Math.min(2500, Math.max(1000, Math.round(totalDuration * 0.02)));
  const remaining = Math.max(1000, totalDuration - focusDuration);
  const segmentMs = 10000;
  const patterns = [
    [
      { from: 0, to: 6200, key: 'ArrowRight' },
      { from: 1200, to: 7600, key: 'ArrowUp' },
      { from: 8200, to: 8450, key: 'Space' },
    ],
    [
      { from: 0, to: 5200, key: 'ArrowLeft' },
      { from: 2500, to: 9200, key: 'ArrowDown' },
      { from: 5600, to: 5750, key: 'Enter' },
    ],
    [
      { from: 0, to: 6500, key: 'KeyW' },
      { from: 1000, to: 8200, key: 'KeyD' },
      { from: 7800, to: 8050, key: 'Space' },
    ],
    [
      { from: 0, to: 6000, key: 'KeyA' },
      { from: 2600, to: 8600, key: 'KeyS' },
      { from: 7000, to: 7250, key: 'Space' },
    ],
  ];

  const actions = [
    {
      action: 'screenshot',
      action_name: 'screen-001-open',
      name: 'open',
    },
    {
      action: 'step',
      action_name: 'step-002-focus-start',
      duration: 900,
      clicks: [{ at: 100, x: 640, y: 360 }],
      commands: [
        { from: 250, to: 350, key: 'Space' },
        { from: 500, to: 650, key: 'Enter' },
      ],
      duration: focusDuration,
      captures: [focusDuration],
      autoCaptures: false,
    },
  ];

  let elapsed = 0;
  let segmentIndex = 0;
  while (elapsed < remaining) {
    const duration = Math.min(segmentMs, remaining - elapsed);
    const pattern = patterns[segmentIndex % patterns.length]
      .map((command) => ({
        ...command,
        to: Math.min(command.to, Math.max(0, duration - 200)),
      }))
      .filter((command) => command.to > command.from);
    actions.push({
      action: 'step',
      action_name: `step-${String(segmentIndex + 3).padStart(3, '0')}-play`,
      duration,
      commands: pattern,
      clicks: segmentIndex % 3 === 2 ? [{ at: Math.min(500, duration), x: 640, y: 360 }] : [],
      view_moves: segmentIndex % 4 === 1 ? [{ from: 800, to: Math.min(2500, duration), dx: 180, dy: -35, steps: 12 }] : [],
      captures: [duration],
      autoCaptures: false,
    });
    elapsed += duration;
    segmentIndex += 1;
  }

  actions.push(
    {
      action: 'screenshot',
      action_name: 'screen-final',
      name: 'final',
    },
  );
  return actions;
}

function parseActionResponse(result, action) {
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`runwave returned non-JSON output for ${action.action_name || action.action}: ${result.stdout.slice(-2000)}`);
  }
  if (!response || response.ok === false) {
    throw new Error(`runwave action failed for ${action.action_name || action.action}: ${JSON.stringify(response).slice(0, 2000)}`);
  }
  return response;
}

function runwaveCliArgs(base, action, job) {
  const args = [base[1]];
  if (job.verboseRunwave || process.env.RUNWAVE_VERBOSE === '1') args.push('-v');
  args.push(JSON.stringify(action));
  return args;
}

async function runRunwaveAction(base, dirs, env, job, action) {
  const result = await run(base[0], runwaveCliArgs(base, action, job), { cwd: dirs.workspace, env });
  return parseActionResponse(result, action);
}

function useAgentMode(job) {
  return job.playMode === 'agent' || job.agent === true;
}

async function runAgentPlan(job, dirs, initialResponse, runAction) {
  const agentModule = path.join(dirs.runwave, 'agent', 'src', 'agent-player.js');
  const { runAgenticPlaytest } = require(agentModule);
  return runAgenticPlaytest({
    job,
    initialResponse,
    runAction,
    outputDir: path.join(dirs.workspace, 'artifacts', 'agent'),
    log,
  });
}

async function runRunwave(job, dirs, url, runnerEnv = process.env) {
  const runwaveBin = path.join(dirs.runwave, 'bin', 'runwave.js');
  const env = {
    ...runnerEnv,
    RUNWAVE_WORKSPACE: dirs.workspace,
    RUNWAVE_SESSION_FILE: path.join(dirs.workspace, '.runwave-session.json'),
  };
  const base = ['node', runwaveBin];
  const start = {
    action: 'start',
    action_name: 'start',
    url,
    record: true,
    headless: true,
    channel: job.channel,
    executablePath: job.executablePath,
    viewport: job.viewport || { width: 1280, height: 720 },
    videoSize: job.videoSize || job.viewport || { width: 1280, height: 720 },
    outputRoot: 'artifacts/state/output',
    outDir: 'artifacts/recordings/session',
    initialScreenshot: true,
    gridScreenshots: job.gridScreenshots,
    keyAliases: job.keyAliases,
    force: true,
    sessionWaitMs: 120000,
  };

  const runAction = (action) => runRunwaveAction(base, dirs, env, job, action);
  const initialResponse = await runAction(start);
  let playtestResult = null;
  try {
    if (useAgentMode(job)) {
      playtestResult = await runAgentPlan(job, dirs, initialResponse, runAction);
    } else {
      const plan = Array.isArray(job.actionPlan) && job.actionPlan.length ? job.actionPlan : defaultPlan(job.playtestDurationMs);
      for (const action of plan) {
        await runAction(action);
      }
    }
  } finally {
    await runAction({ action: 'stop', action_name: 'stop' }).catch((error) => {
      log('runwave.stop.error', { error: error.message });
    });
  }
  return playtestResult;
}

async function uploadWorkspace(job, dirs, env) {
  if (!job.s3Uri) return null;
  const s3Uri = job.s3Uri.replace(/\/+$/, '');
  await run('aws', ['s3', 'sync', dirs.workspace, s3Uri, '--only-show-errors'], {
    cwd: dirs.workspace,
    env: { ...process.env, ...env },
  });
  return s3Uri;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.job) throw new Error('usage: run-playtest.js --job /path/job.json');

  const job = JSON.parse(fs.readFileSync(args.job, 'utf8'));
  const envFile = loadEnvFile('/etc/runwave-runner.env');
  Object.assign(process.env, envFile);
  const runnerEnv = { ...process.env, ...envFile };
  const runner = runnerPaths(runnerEnv);
  const jobId = safeName(job.jobId || `${job.game}-attempt-${job.attempt || 1}-${Date.now()}`);
  const port = Number(job.port || 8800 + Math.floor(Math.random() * 800));
  const root = path.join(runner.jobsRoot, jobId);
  const dirs = {
    root,
    workspace: path.join(root, 'workspace'),
    runwave: path.join(root, 'runwave'),
  };
  mkdirp(dirs.workspace);

  const summary = {
    jobId,
    game: job.game,
    runwaveRepo: job.runwaveRepo,
    runwaveRef: job.runwaveRef,
    startedAt: new Date().toISOString(),
    status: 'running',
  };
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(job, null, 2));
  fs.writeFileSync(path.join(dirs.workspace, 'summary.json'), JSON.stringify(summary, null, 2));

  const gameDir = path.join(runner.gamesRoot, job.game);
  if (!fs.existsSync(path.join(gameDir, 'start.sh'))) {
    throw new Error(`game has no start.sh: ${job.game}`);
  }

  let gameProcess = null;
  try {
    log('job.start', { jobId, game: job.game, port });
    await checkoutRunwave(job, dirs.runwave, runnerEnv);

    gameProcess = spawnLong('bash', ['start.sh'], {
      cwd: gameDir,
      env: { ...runnerEnv, PORT: String(port) },
    });
    const url = `http://127.0.0.1:${port}/`;
    await waitForHttp(url, Number(job.httpTimeoutMs || 60000));

    const playtest = await runRunwave(job, dirs, url, runnerEnv);
    if (playtest) {
      summary.playtest = {
        mode: playtest.mode,
        steps: playtest.steps,
        elapsedMs: playtest.elapsedMs,
        stoppedByAgent: playtest.stoppedByAgent,
        outputDir: playtest.outputDir,
      };
    }
    summary.status = 'passed';
  } catch (error) {
    summary.status = 'failed';
    summary.error = error.message;
    summary.stack = error.stack;
    log('job.error', { jobId, error: error.message });
  } finally {
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dirs.workspace, 'summary.json'), JSON.stringify(summary, null, 2));
    if (gameProcess && !gameProcess.killed) gameProcess.kill('SIGTERM');
    if (job.s3Uri) summary.uploadedTo = job.s3Uri.replace(/\/+$/, '');
    fs.writeFileSync(path.join(dirs.workspace, 'summary.json'), JSON.stringify(summary, null, 2));
    const uploadedTo = await uploadWorkspace(job, dirs, runnerEnv).catch((error) => {
      log('upload.error', { jobId, error: error.message });
      summary.uploadError = error.message;
      fs.writeFileSync(path.join(dirs.workspace, 'summary.json'), JSON.stringify(summary, null, 2));
      return null;
    });
    if (uploadedTo) summary.uploadedTo = uploadedTo;
    fs.writeFileSync(path.join(dirs.workspace, 'summary.json'), JSON.stringify(summary, null, 2));
    log('job.end', { jobId, status: summary.status, uploadedTo });
  }

  if (summary.status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  log('fatal', { error: error.message, stack: error.stack });
  process.exit(1);
});
