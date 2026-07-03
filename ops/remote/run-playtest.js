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

async function checkoutRunwave(job, runwaveDir) {
  await run('git', ['clone', job.runwaveRepo || 'https://github.com/parsewave/runwave', runwaveDir]);
  if (job.runwaveRef) {
    await run('git', ['fetch', '--depth', '1', 'origin', job.runwaveRef], { cwd: runwaveDir });
    await run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: runwaveDir });
  }
  if (fs.existsSync(path.join(runwaveDir, 'package-lock.json'))) {
    await run('npm', ['ci'], { cwd: runwaveDir });
  } else {
    await run('npm', ['install'], { cwd: runwaveDir });
  }
  await run('npx', ['playwright', 'install', 'chromium'], { cwd: runwaveDir });
}

function defaultPlan() {
  return [
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
      captures: [900],
    },
    {
      action: 'step',
      action_name: 'step-003-right-up',
      duration: 2500,
      commands: [
        { from: 0, to: 1800, key: 'ArrowRight' },
        { from: 400, to: 2300, key: 'ArrowUp' },
      ],
      captures: [1250, 2500],
    },
    {
      action: 'step',
      action_name: 'step-004-left-down',
      duration: 2500,
      commands: [
        { from: 0, to: 1600, key: 'ArrowLeft' },
        { from: 700, to: 2400, key: 'ArrowDown' },
      ],
      captures: [1250, 2500],
    },
    {
      action: 'step',
      action_name: 'step-005-wasd-action',
      duration: 3000,
      commands: [
        { from: 0, to: 1200, key: 'KeyW' },
        { from: 600, to: 2200, key: 'KeyD' },
        { from: 1600, to: 2900, key: 'KeyA' },
        { from: 2300, to: 2450, key: 'Space' },
      ],
      captures: [1500, 3000],
    },
    {
      action: 'screenshot',
      action_name: 'screen-006-final',
      name: 'final',
    },
  ];
}

async function runRunwave(job, dirs, url) {
  const runwaveBin = path.join(dirs.runwave, 'bin', 'runwave.js');
  const env = {
    ...process.env,
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
    viewport: job.viewport || { width: 1280, height: 720 },
    videoSize: job.videoSize || job.viewport || { width: 1280, height: 720 },
    outputRoot: 'artifacts/state/output',
    outDir: 'artifacts/recordings/session',
    initialScreenshot: true,
    force: true,
    sessionWaitMs: 120000,
  };

  await run(base[0], [base[1], JSON.stringify(start)], { cwd: dirs.workspace, env });
  const plan = Array.isArray(job.actionPlan) && job.actionPlan.length ? job.actionPlan : defaultPlan();
  for (const action of plan) {
    await run(base[0], [base[1], JSON.stringify(action)], { cwd: dirs.workspace, env });
  }
  await run(base[0], [base[1], JSON.stringify({ action: 'stop', action_name: 'stop' })], {
    cwd: dirs.workspace,
    env,
  });
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
  const jobId = safeName(job.jobId || `${job.game}-attempt-${job.attempt || 1}-${Date.now()}`);
  const port = Number(job.port || 8800 + Math.floor(Math.random() * 800));
  const root = path.join('/var/lib/runwave/jobs', jobId);
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

  const gameDir = path.join('/opt/runwave/games', job.game);
  if (!fs.existsSync(path.join(gameDir, 'start.sh'))) {
    throw new Error(`game has no start.sh: ${job.game}`);
  }

  let gameProcess = null;
  try {
    log('job.start', { jobId, game: job.game, port });
    await checkoutRunwave(job, dirs.runwave);

    gameProcess = spawnLong('bash', ['start.sh'], {
      cwd: gameDir,
      env: { ...process.env, PORT: String(port) },
    });
    const url = `http://127.0.0.1:${port}/`;
    await waitForHttp(url, Number(job.httpTimeoutMs || 60000));

    await runRunwave(job, dirs, url);
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
    const uploadedTo = await uploadWorkspace(job, dirs, envFile).catch((error) => {
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
