#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PROCESS_STOP_WAIT_MS = 5000;
const DEFAULT_PROCESS_KILL_WAIT_MS = 5000;
const DEFAULT_AUDIO_VIDEO_CAPTURE_Y = 94;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function safeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function runnerPaths(env = process.env) {
  return {
    gamesRoot: env.RUNWAVE_GAMES_ROOT || '/opt/runwave/games',
    jobsRoot: env.RUNWAVE_JOBS_ROOT || '/var/lib/runwave/jobs',
  };
}

function shouldRunJobInContainer(job = {}, env = process.env, platform = process.platform) {
  if (platform !== 'linux') return false;
  if (env.RUNWAVE_IN_CONTAINER === '1') return false;
  if (env.RUNWAVE_PLAYTEST_CONTAINER === '0') return false;
  if (job.containerized === false || job.runInContainer === false) return false;
  return true;
}

function dockerEnvNames(env = process.env) {
  const allowed = [
    /^AWS_/,
    /^OPENAI_/,
    /^ANTHROPIC_/,
    /^OPENROUTER_/,
    /^PARSEWAVE_/,
    /^GITHUB_/,
    /^GH_TOKEN$/,
    /^RUNWAVE_AGENT_/,
    /^RUNWAVE_AUDIO_/,
    /^RUNWAVE_CHROMIUM_ARGS(_MODE)?$/,
    /^RUNWAVE_FFMPEG$/,
    /^RUNWAVE_SKIP_PLAYWRIGHT_INSTALL$/,
    /^RUNWAVE_VERBOSE$/,
    /^RUNWAVE_VIDEO_/,
    /^RUNWAVE_VLM_VIEWPORT_PREFLIGHT$/,
    /^RUNWAVE_XVFB_/,
    /^RUNWAVE_PROCESS_(STOP|KILL)_WAIT_MS$/,
    /^HTTP_PROXY$/i,
    /^HTTPS_PROXY$/i,
    /^NO_PROXY$/i,
    /^ALL_PROXY$/i,
  ];
  return Object.keys(env)
    .filter((name) => allowed.some((pattern) => pattern.test(name)))
    .sort();
}

function dockerMountArgs(mounts) {
  const args = [];
  for (const mount of mounts) {
    args.push('-v', `${mount.source}:${mount.target}${mount.readonly ? ':ro' : ''}`);
  }
  return args;
}

function dockerRunArgs(args, job, runner, options = {}) {
  const jobPath = path.resolve(args.job);
  const jobDir = path.dirname(jobPath);
  const jobBase = path.basename(jobPath);
  const image = job.containerImage || options.env?.RUNWAVE_PLAYTEST_IMAGE || 'runwave-playtest-runner:latest';
  const jobsRoot = path.resolve(runner.jobsRoot);
  const gamesRoot = path.resolve(runner.gamesRoot);
  const scriptPath = path.resolve(options.scriptPath || __filename);
  const envFile = options.envFile || '/etc/runwave-runner.env';
  const containerName = `runwave-${safeName(job.jobId || `${job.game || 'job'}-${Date.now()}`)}`;
  const mounts = [
    { source: gamesRoot, target: '/opt/runwave/games', readonly: true },
    { source: jobsRoot, target: '/var/lib/runwave/jobs' },
    { source: jobDir, target: '/runwave/job', readonly: true },
    { source: scriptPath, target: '/opt/runwave/bin/run-playtest.js', readonly: true },
  ];
  if (job.runwaveRepo && path.isAbsolute(String(job.runwaveRepo))) {
    const runwaveRepo = path.resolve(String(job.runwaveRepo));
    mounts.push({ source: runwaveRepo, target: runwaveRepo, readonly: true });
  }
  if (fs.existsSync(envFile)) {
    mounts.push({ source: envFile, target: '/etc/runwave-runner.env', readonly: true });
  }

  const dockerArgs = [
    'run',
    '--rm',
    '--init',
    '--ipc=host',
    '--shm-size=1g',
    '--name',
    containerName,
    ...dockerMountArgs(mounts),
    '-e',
    'RUNWAVE_IN_CONTAINER=1',
    '-e',
    'RUNWAVE_GAMES_ROOT=/opt/runwave/games',
    '-e',
    'RUNWAVE_JOBS_ROOT=/var/lib/runwave/jobs',
  ];
  if (fs.existsSync('/dev/dri')) {
    dockerArgs.push('--device', '/dev/dri');
  }
  for (const name of dockerEnvNames(options.env || process.env)) {
    dockerArgs.push('-e', name);
  }
  dockerArgs.push(image, '--job', `/runwave/job/${jobBase}`);
  return dockerArgs;
}

async function runJobInContainer(args, job, runner, env = process.env) {
  if (!fs.existsSync(runner.gamesRoot)) {
    throw new Error(`games root does not exist for container mount: ${runner.gamesRoot}`);
  }
  mkdirp(runner.jobsRoot);
  await run('docker', dockerRunArgs(args, job, runner, { env }), { env });
}

function loadPlaytestInstructions(gameDir, game) {
  const entries = fs.readdirSync(gameDir, { withFileTypes: true });
  const playtestEntry = entries.find((entry) => entry.isFile() && entry.name === 'playtest.md');
  if (!playtestEntry) {
    throw new Error(`game has no playtest.md: ${game}`);
  }

  const playtestPath = path.join(gameDir, 'playtest.md');
  return fs.readFileSync(playtestPath, 'utf8');
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

async function prepareAudioCaptureEnv(env, job) {
  const recordAudio = job.recordAudio !== false && process.platform === 'linux';
  if (!recordAudio) return { env, recordAudio: false };

  const sink = job.audioSink || env.RUNWAVE_AUDIO_SINK || 'runwave_sink';
  const audioEnv = {
    ...env,
    PULSE_SINK: sink,
  };

  await run('pulseaudio', ['--start', '--exit-idle-time=-1'], { env: audioEnv });
  const modules = await run('pactl', ['list', 'short', 'modules'], { env: audioEnv });
  for (const line of modules.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === 'module-suspend-on-idle') {
      await run('pactl', ['unload-module', fields[0]], { env: audioEnv });
    }
  }
  const activeModules = await run('pactl', ['list', 'short', 'modules'], { env: audioEnv });
  if (!activeModules.stdout.includes(`sink_name=${sink}`)) {
    await run('pactl', [
      'load-module',
      'module-null-sink',
      `sink_name=${sink}`,
      `sink_properties=device.description=${sink}`,
    ], { env: audioEnv });
  }
  await run('pactl', ['set-default-sink', sink], { env: audioEnv });

  return {
    env: audioEnv,
    recordAudio: true,
    audioInputFormat: job.audioInputFormat || 'pulse',
    audioSource: job.audioSource || `${sink}.monitor`,
  };
}

async function startXvfbForAudio(job, env) {
  if (job.audioXvfb === false) return { env, process: null, display: env.DISPLAY || null };
  const display = job.xvfbDisplay || env.RUNWAVE_XVFB_DISPLAY || `:${100 + (Number(job.port || 0) % 500)}`;
  const captureSize = job.videoSize || job.viewport || { width: 1280, height: 720 };
  const captureWidth = positiveInteger(captureSize.width, 1280);
  const captureHeight = positiveInteger(captureSize.height, 720);
  const captureX = nonNegativeInteger(
    job.audioVideoCaptureX ?? job.audioVideoCaptureOffsetX ?? env.RUNWAVE_AUDIO_VIDEO_CAPTURE_X ?? env.RUNWAVE_VIDEO_X,
    0
  );
  const captureY = nonNegativeInteger(
    job.audioVideoCaptureY ?? job.audioVideoCaptureYOffset ?? env.RUNWAVE_AUDIO_VIDEO_CAPTURE_Y ?? env.RUNWAVE_VIDEO_Y,
    DEFAULT_AUDIO_VIDEO_CAPTURE_Y
  );
  const screenWidth = positiveInteger(job.xvfbWidth ?? env.RUNWAVE_XVFB_WIDTH, captureWidth + captureX);
  const screenHeight = positiveInteger(job.xvfbHeight ?? env.RUNWAVE_XVFB_HEIGHT, captureHeight + captureY);
  const screen = job.xvfbScreen || env.RUNWAVE_XVFB_SCREEN || `${screenWidth}x${screenHeight}x24`;
  const xvfb = spawnLong('Xvfb', [display, '-screen', '0', screen, '-nolisten', 'tcp'], {
    env,
  });
  const waitMs = Number(job.xvfbStartWaitMs ?? env.RUNWAVE_XVFB_START_WAIT_MS ?? 500);
  if (waitMs > 0) await sleep(waitMs);
  if (processHasClosed(xvfb)) {
    throw new Error(`Xvfb exited during startup for display ${display}`);
  }
  return {
    env: {
      ...env,
      DISPLAY: display,
      NO_AT_BRIDGE: env.NO_AT_BRIDGE || '1',
      RUNWAVE_VIDEO_X: String(captureX),
      RUNWAVE_VIDEO_Y: String(captureY),
    },
    process: xvfb,
    display,
  };
}

function spawnLong(command, args, options = {}) {
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

function signalLongProcess(child, signal, options = {}) {
  if (!child || !child.pid) return false;
  const kill = options.kill || process.kill;
  const platform = options.platform || process.platform;
  const target = platform === 'win32' ? child.pid : -child.pid;
  try {
    kill(target, signal);
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
    const done = (closed) => {
      if (timer) clearTimeout(timer);
      child.off('close', onClose);
      resolve(closed);
    };
    const onClose = () => done(true);
    child.once('close', onClose);
    timer = setTimeout(() => done(processHasClosed(child)), Math.max(0, timeoutMs));
  });
}

async function stopLongProcess(child, options = {}) {
  if (!child) return { stopped: false, reason: 'no-process' };
  if (processHasClosed(child)) return { stopped: true, reason: 'already-closed', pid: child.pid };

  const label = options.label || 'process';
  const termWaitMs = Math.max(0, Number(options.termWaitMs ?? DEFAULT_PROCESS_STOP_WAIT_MS));
  const killWaitMs = Math.max(0, Number(options.killWaitMs ?? DEFAULT_PROCESS_KILL_WAIT_MS));
  const writeLog = options.log || log;
  writeLog('process.stop.start', { label, pid: child.pid, termWaitMs, killWaitMs });

  const termSent = signalLongProcess(child, 'SIGTERM', options);
  if (!termSent) {
    writeLog('process.stop.not_running', { label, pid: child.pid, signal: 'SIGTERM' });
    return { stopped: true, reason: 'not-running', pid: child.pid };
  }

  if (await waitForProcessClose(child, termWaitMs)) {
    writeLog('process.stop.end', { label, pid: child.pid, signal: 'SIGTERM', escalated: false });
    return { stopped: true, reason: 'terminated', pid: child.pid, signal: 'SIGTERM', escalated: false };
  }

  writeLog('process.stop.escalate', { label, pid: child.pid, signal: 'SIGKILL' });
  const killSent = signalLongProcess(child, 'SIGKILL', options);
  if (!killSent) {
    writeLog('process.stop.not_running', { label, pid: child.pid, signal: 'SIGKILL' });
    return { stopped: true, reason: 'not-running-after-term', pid: child.pid, signal: 'SIGTERM', escalated: true };
  }

  const stopped = await waitForProcessClose(child, killWaitMs);
  writeLog('process.stop.end', { label, pid: child.pid, signal: 'SIGKILL', escalated: true, stopped });
  return { stopped, reason: stopped ? 'killed' : 'kill-timeout', pid: child.pid, signal: 'SIGKILL', escalated: true };
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const DEFAULT_CHROMIUM_ARGS = ['--no-sandbox', '--enable-unsafe-swiftshader'];
const HARDWARE_WEBGL_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  '--use-gl=egl',
  '--autoplay-policy=no-user-gesture-required',
];

function parseArgList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // Fall through to whitespace parsing.
    }
  }
  return text.split(/\s+/).filter(Boolean);
}

function chromiumArgs(job = {}, env = process.env) {
  const configured = parseArgList(job.chromiumArgs ?? env.RUNWAVE_CHROMIUM_ARGS);
  const mode = String(job.chromiumArgsMode || env.RUNWAVE_CHROMIUM_ARGS_MODE || 'append').toLowerCase();
  if (mode === 'replace') return configured;
  return [...DEFAULT_CHROMIUM_ARGS, ...configured];
}

function chromiumLaunchOptions(job = {}, env = process.env, extra = {}) {
  const launchOptions = {
    ...extra,
    args: chromiumArgs(job, env),
  };
  if (job.channel) launchOptions.channel = String(job.channel);
  if (job.executablePath) launchOptions.executablePath = String(job.executablePath);
  return launchOptions;
}

function responseBody(response) {
  if (!response || typeof response !== 'object') return {};
  return response.output && typeof response.output === 'object' ? response.output : response;
}

function webglFromResponse(response) {
  const body = responseBody(response);
  const state = body.state || body.endState || {};
  return state.generic && state.generic.webgl ? state.generic.webgl : null;
}

function isSwiftShaderWebgl(webgl) {
  const renderer = `${webgl && (webgl.unmaskedRenderer || webgl.renderer || '')}`;
  return /swiftshader/i.test(renderer);
}

function assertHardwareWebgl(job, response) {
  if (!job.requiresHardwareWebgl) return null;
  const webgl = webglFromResponse(response);
  if (!webgl || webgl.supported === false) {
    throw new Error(`hardware WebGL required for ${job.game || job.jobId || 'job'}, but WebGL renderer metadata is unavailable`);
  }
  if (isSwiftShaderWebgl(webgl)) {
    throw new Error(
      `hardware WebGL required for ${job.game || job.jobId || 'job'}, but Chromium is using ${webgl.unmaskedRenderer || webgl.renderer}`
    );
  }
  return webgl;
}

function even(value) {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function chooseViewportFromProbe(probe, fallback = { width: 1280, height: 720 }) {
  const viewport = probe.viewport || fallback;
  const canvases = Array.isArray(probe.canvases) ? probe.canvases : [];
  const largestCanvas = canvases
    .filter((canvas) => canvas.width > 0 && canvas.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];

  if (largestCanvas) {
    const coversViewport = largestCanvas.width >= viewport.width * 0.85 && largestCanvas.height >= viewport.height * 0.85;
    if (coversViewport) {
      return {
        viewport: { width: even(viewport.width), height: even(viewport.height) },
        reason: 'canvas-covers-viewport',
        canvas: largestCanvas,
      };
    }
    return {
      viewport: {
        width: even(clamp(largestCanvas.width + 16, 480, 1280)),
        height: even(clamp(largestCanvas.height + 16, 360, 1000)),
      },
      reason: 'fit-largest-canvas',
      canvas: largestCanvas,
    };
  }

  const visible = probe.visibleBounds || {};
  const neededHeight = Math.max(
    Number(probe.scrollHeight || 0),
    Number(visible.bottom || 0) + 16,
    viewport.height
  );
  if (neededHeight > viewport.height + 24) {
    return {
      viewport: {
        width: even(clamp(viewport.width, 640, 1280)),
        height: even(clamp(neededHeight, viewport.height, 1400)),
      },
      reason: 'fit-page-height',
      visibleBounds: visible,
    };
  }

  return {
    viewport: { width: even(viewport.width), height: even(viewport.height) },
    reason: 'default-viewport',
  };
}

function normalizeViewport(viewport, limits = {}) {
  const minWidth = Number(limits.minWidth || 480);
  const maxWidth = Number(limits.maxWidth || 1280);
  const minHeight = Number(limits.minHeight || 360);
  const maxHeight = Number(limits.maxHeight || 1400);
  return {
    width: even(clamp(Number(viewport.width || 0), minWidth, maxWidth)),
    height: even(clamp(Number(viewport.height || 0), minHeight, maxHeight)),
  };
}

function largestCanvasFromProbe(probe) {
  const canvases = Array.isArray(probe.canvases) ? probe.canvases : [];
  return canvases
    .filter((canvas) => canvas.width > 0 && canvas.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
}

function viewportCandidatesFromProbe(probe, fallback = { width: 1280, height: 720 }) {
  const baseViewport = normalizeViewport(probe.viewport || fallback);
  const deterministic = chooseViewportFromProbe(probe, baseViewport);
  const visible = probe.visibleBounds || {};
  const neededHeight = Math.max(
    Number(probe.scrollHeight || 0),
    Number(visible.bottom || 0) + 16,
    baseViewport.height
  );
  const largestCanvas = largestCanvasFromProbe(probe);
  const candidates = [
    {
      id: 'default',
      reason: 'default browser viewport',
      viewport: baseViewport,
    },
    {
      id: 'probe-choice',
      reason: deterministic.reason,
      viewport: normalizeViewport(deterministic.viewport),
    },
  ];

  if (largestCanvas) {
    candidates.push({
      id: 'canvas-fit',
      reason: 'largest canvas plus a small margin',
      viewport: normalizeViewport({
        width: largestCanvas.width + 16,
        height: largestCanvas.height + 16,
      }, { maxHeight: 1000 }),
    });
  }

  if (neededHeight > baseViewport.height + 24) {
    candidates.push({
      id: 'page-fit',
      reason: 'full visible page height',
      viewport: normalizeViewport({
        width: baseViewport.width,
        height: neededHeight,
      }),
    });
  }

  if (visible.width > 0 && visible.height > 0) {
    candidates.push({
      id: 'content-fit',
      reason: 'visible content bounds with reduced horizontal whitespace',
      viewport: normalizeViewport({
        width: visible.width + 160,
        height: Math.max(visible.height + Math.max(visible.top, 0) + 32, baseViewport.height),
      }),
    });
  }

  candidates.push({
    id: 'square-compact',
    reason: 'compact square-ish viewport for centered games',
    viewport: normalizeViewport({ width: 900, height: 900 }),
  });

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.viewport.width}x${candidate.viewport.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

async function captureViewportCandidateScreenshots(job, dirs, url, env, candidates) {
  const outputDir = path.join(dirs.workspace, 'artifacts', 'viewport-preflight');
  mkdirp(outputDir);
  const { chromium } = require(path.join(dirs.runwave, 'node_modules', 'playwright'));
  const launchOptions = chromiumLaunchOptions(job, env, { headless: true });

  const browser = await chromium.launch(launchOptions);
  try {
    const captured = [];
    for (const candidate of candidates) {
      const context = await browser.newContext({
        viewport: candidate.viewport,
        deviceScaleFactor: Number(job.deviceScaleFactor ?? 1),
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: job.waitUntil || 'load' });
      await new Promise((resolve) => setTimeout(resolve, Number(job.waitAfterLoad ?? 700)));
      const screenshot = path.join(outputDir, `${candidate.id}-${candidate.viewport.width}x${candidate.viewport.height}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      captured.push({ ...candidate, screenshot });
      await context.close();
    }
    return captured;
  } finally {
    await browser.close();
  }
}

function normalizeVlmViewportChoice(raw, candidates, fallbackChoice) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const choiceId = String(data.choice_id || data.choiceId || data.id || '').trim();
  const byId = candidates.find((candidate) => candidate.id === choiceId);
  if (byId) {
    return {
      viewport: byId.viewport,
      reason: data.reason || byId.reason,
      selectedCandidateId: byId.id,
      confidence: Number(data.confidence || 0) || null,
      source: 'vlm',
    };
  }

  const requested = data.viewport && typeof data.viewport === 'object' ? normalizeViewport(data.viewport) : null;
  const byViewport = requested
    ? candidates.find((candidate) => candidate.viewport.width === requested.width && candidate.viewport.height === requested.height)
    : null;
  if (byViewport) {
    return {
      viewport: byViewport.viewport,
      reason: data.reason || byViewport.reason,
      selectedCandidateId: byViewport.id,
      confidence: Number(data.confidence || 0) || null,
      source: 'vlm',
    };
  }

  return {
    ...fallbackChoice,
    selectedCandidateId: 'probe-choice',
    source: 'fallback',
    vlmError: choiceId ? `unknown candidate id: ${choiceId}` : 'missing candidate id',
  };
}

function buildViewportPreflightPrompt(candidates, probe) {
  const lines = [
    'You are choosing the viewport for recording and playing a browser game.',
    'Pick the single candidate whose screenshot best shows the playable game area.',
    '',
    'Criteria:',
    '- No important controls, HUD, board, canvas, or instructions are clipped.',
    '- The game should not be unnecessarily zoomed out with lots of empty page whitespace.',
    '- Text/buttons should remain readable.',
    '- Prefer the viewport that would help a VLM game-playing agent understand what to do next.',
    '',
    'Return only JSON:',
    '{ "choice_id": "candidate id", "reason": "short reason", "confidence": 0.0 }',
    '',
    'Probe metadata:',
    JSON.stringify({
      viewport: probe.viewport,
      canvases: probe.canvases,
      scrollWidth: probe.scrollWidth,
      scrollHeight: probe.scrollHeight,
      visibleBounds: probe.visibleBounds,
    }, null, 2),
    '',
    'Candidates:',
    ...candidates.map((candidate) => `${candidate.id}: ${candidate.viewport.width}x${candidate.viewport.height} (${candidate.reason})`),
  ];
  return lines.join('\n');
}

async function chooseViewportWithVlm(job, dirs, url, env, probe) {
  const candidates = await captureViewportCandidateScreenshots(
    job,
    dirs,
    url,
    env,
    viewportCandidatesFromProbe(probe, job.probeViewport || { width: 1280, height: 720 })
  );
  const fallbackChoice = {
    viewport: probe.choice.viewport,
    reason: probe.choice.reason,
    selectedCandidateId: 'probe-choice',
    source: 'probe',
  };
  const { chatCompletion, dataUrl } = require(path.join(dirs.runwave, 'agent', 'src', 'model-client.js'));
  const content = [{ type: 'text', text: buildViewportPreflightPrompt(candidates, probe) }];
  for (const candidate of candidates) {
    content.push({
      type: 'text',
      text: `Candidate ${candidate.id}: ${candidate.viewport.width}x${candidate.viewport.height}`,
    });
    content.push({
      type: 'image_url',
      image_url: { url: dataUrl(candidate.screenshot) },
    });
  }

  const startedAt = Date.now();
  const attempts = Math.max(1, Math.round(Number(job.viewportPreflightAttempts || job.viewportPreflightModelAttempts || 2)));
  try {
    const result = await chatCompletion({
      messages: [{ role: 'user', content }],
      maxTokens: Number(job.viewportPreflightMaxTokens || 700),
      timeoutMs: Number(job.viewportPreflightTimeoutMs || 120000),
      temperature: Number(job.viewportPreflightTemperature ?? 0),
      attempts,
    });
    const choice = normalizeVlmViewportChoice(result.json, candidates, fallbackChoice);
    return {
      enabled: true,
      elapsedMs: Date.now() - startedAt,
      attempts,
      model: result.model,
      choice,
      rawChoice: result.json,
      usage: result.usage || null,
      candidates,
    };
  } catch (error) {
    return {
      enabled: true,
      elapsedMs: Date.now() - startedAt,
      attempts,
      choice: fallbackChoice,
      error: error.message,
      candidates,
    };
  }
}

async function probeViewport(job, dirs, url, env = process.env) {
  const viewport = job.probeViewport || { width: 1280, height: 720 };
  const { chromium } = require(path.join(dirs.runwave, 'node_modules', 'playwright'));
  const launchOptions = chromiumLaunchOptions(job, env, { headless: true });

  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: Number(job.deviceScaleFactor ?? 1),
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: job.waitUntil || 'load' });
    await new Promise((resolve) => setTimeout(resolve, Number(job.waitAfterLoad ?? 700)));
    const probe = await page.evaluate(() => {
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      };
      const canvases = Array.from(document.querySelectorAll('canvas')).map((canvas, index) => {
        const rect = canvas.getBoundingClientRect();
        return {
          index,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        };
      });

      const visibleElements = Array.from(document.body.querySelectorAll('*')).filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width >= 4 && rect.height >= 4;
      });
      const bounds = visibleElements.reduce(
        (acc, element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: Math.min(acc.left, rect.left),
            top: Math.min(acc.top, rect.top),
            right: Math.max(acc.right, rect.right),
            bottom: Math.max(acc.bottom, rect.bottom),
          };
        },
        { left: Infinity, top: Infinity, right: 0, bottom: 0 }
      );
      const visibleBounds = Number.isFinite(bounds.left)
        ? {
            left: Math.round(bounds.left),
            top: Math.round(bounds.top),
            right: Math.round(bounds.right),
            bottom: Math.round(bounds.bottom),
            width: Math.round(bounds.right - bounds.left),
            height: Math.round(bounds.bottom - bounds.top),
          }
        : null;
      return {
        viewport,
        canvases,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
        scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
        visibleBounds,
      };
    });
    const choice = chooseViewportFromProbe(probe, viewport);
    return { ...probe, choice };
  } finally {
    await browser.close();
  }
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
      { type: 'key', start: 0, end: 6200, key: 'ArrowRight' },
      { type: 'key', start: 1200, end: 7600, key: 'ArrowUp' },
      { type: 'key', start: 8200, end: 8450, key: 'Space' },
    ],
    [
      { type: 'key', start: 0, end: 5200, key: 'ArrowLeft' },
      { type: 'key', start: 2500, end: 9200, key: 'ArrowDown' },
      { type: 'key', start: 5600, end: 5750, key: 'Enter' },
    ],
    [
      { type: 'key', start: 0, end: 6500, key: 'KeyW' },
      { type: 'key', start: 1000, end: 8200, key: 'KeyD' },
      { type: 'key', start: 7800, end: 8050, key: 'Space' },
    ],
    [
      { type: 'key', start: 0, end: 6000, key: 'KeyA' },
      { type: 'key', start: 2600, end: 8600, key: 'KeyS' },
      { type: 'key', start: 7000, end: 7250, key: 'Space' },
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
      actions: [
        { type: 'click', start: 100, x: 640, y: 360 },
        { type: 'key', start: 250, end: 350, key: 'Space' },
        { type: 'key', start: 500, end: 650, key: 'Enter' },
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
      .map((action) => ({
        ...action,
        end: Math.min(action.end, Math.max(0, duration - 200)),
      }))
      .filter((action) => action.end > action.start);
    actions.push({
      action: 'step',
      action_name: `step-${String(segmentIndex + 3).padStart(3, '0')}-play`,
      actions: [
        ...pattern,
        ...(segmentIndex % 3 === 2 ? [{ type: 'click', start: Math.min(500, duration), x: 640, y: 360 }] : []),
        ...(segmentIndex % 4 === 1
          ? [{ type: 'view_move', start: 800, end: Math.min(2500, duration), dx: 180, dy: -35, steps: 12 }]
          : []),
      ],
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
  const payload = {
    ...action,
    session_id: action.session_id || action.sessionId || job.runwaveSessionId,
  };
  const result = await run(base[0], runwaveCliArgs(base, payload, job), { cwd: dirs.workspace, env });
  return parseActionResponse(result, payload);
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
  let env = {
    ...runnerEnv,
    RUNWAVE_WORKSPACE: dirs.workspace,
    RUNWAVE_SESSION_DIR: path.join(dirs.workspace, '.runwave-sessions'),
  };
  job.runwaveSessionId = job.runwaveSessionId || job.sessionId || job.jobId || `${job.game || 'runwave'}-${Date.now()}`;
  const audioCapture = await prepareAudioCaptureEnv(env, job);
  env = audioCapture.env;
  let xvfb = null;
  if (audioCapture.recordAudio) {
    const xvfbSession = await startXvfbForAudio(job, env);
    env = xvfbSession.env;
    xvfb = xvfbSession.process;
    if (xvfbSession.display) log('xvfb.ready', { display: xvfbSession.display });
  }
  const base = ['node', runwaveBin];
  const start = {
    action: 'start',
    action_name: 'start',
    session_id: job.runwaveSessionId,
    url,
    record: true,
    recordAudio: audioCapture.recordAudio,
    audioVideoRecorder: job.audioVideoRecorder,
    audioInputFormat: audioCapture.audioInputFormat,
    audioSource: audioCapture.audioSource,
    gstreamerPath: job.gstreamerPath,
    headless: job.headless ?? (audioCapture.recordAudio ? false : true),
    channel: job.channel,
    executablePath: job.executablePath,
    chromiumArgs: job.chromiumArgs,
    chromiumArgsMode: job.chromiumArgsMode,
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
  let initialResponse = null;
  let playtestResult = null;
  try {
    initialResponse = await runAction(start);
    job._runwaveInitialWebgl = webglFromResponse(initialResponse);
    assertHardwareWebgl(job, initialResponse);
    if (useAgentMode(job)) {
      playtestResult = await runAgentPlan(job, dirs, initialResponse, runAction);
    } else {
      const plan = Array.isArray(job.actionPlan) && job.actionPlan.length ? job.actionPlan : defaultPlan(job.playtestDurationMs);
      for (const action of plan) {
        await runAction(action);
      }
    }
  } finally {
    if (initialResponse) {
      await runAction({ action: 'stop', action_name: 'stop', session_id: job.runwaveSessionId }).catch((error) => {
        log('runwave.stop.error', { error: error.message });
      });
    }
    if (xvfb) {
      await stopLongProcess(xvfb, {
        label: 'xvfb',
        termWaitMs: Number(job.processStopWaitMs ?? DEFAULT_PROCESS_STOP_WAIT_MS),
        killWaitMs: Number(job.processKillWaitMs ?? DEFAULT_PROCESS_KILL_WAIT_MS),
      }).catch((error) => {
        log('xvfb.stop.error', { error: error.message });
      });
    }
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
  if (shouldRunJobInContainer(job, runnerEnv)) {
    await runJobInContainer(args, job, runner, runnerEnv);
    return;
  }

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

  let gameProcess = null;
  try {
    if (!fs.existsSync(path.join(gameDir, 'start.sh'))) {
      throw new Error(`game has no start.sh: ${job.game}`);
    }
    job.playtestInstructions = loadPlaytestInstructions(gameDir, job.game);
    summary.playtestInstructions = {
      path: path.join(gameDir, 'playtest.md'),
      bytes: Buffer.byteLength(job.playtestInstructions, 'utf8'),
    };
    fs.writeFileSync(path.join(dirs.workspace, 'summary.json'), JSON.stringify(summary, null, 2));

    log('job.start', { jobId, game: job.game, port });
    await checkoutRunwave(job, dirs.runwave, runnerEnv);

    gameProcess = spawnLong('bash', ['start.sh'], {
      cwd: gameDir,
      env: { ...runnerEnv, PORT: String(port) },
    });
    const url = `http://127.0.0.1:${port}/`;
    await waitForHttp(url, Number(job.httpTimeoutMs || 60000));

    if (!job.viewport && job.autoViewport !== false) {
      const probe = await probeViewport(job, dirs, url, runnerEnv);
      let viewportChoice = probe.choice;
      if (job.vlmViewportPreflight || runnerEnv.RUNWAVE_VLM_VIEWPORT_PREFLIGHT === '1') {
        const preflight = await chooseViewportWithVlm(job, dirs, url, runnerEnv, probe);
        summary.viewportVlmPreflight = preflight;
        viewportChoice = preflight.choice || viewportChoice;
        log('viewport.vlm_preflight', {
          jobId,
          choice: viewportChoice,
          error: preflight.error,
          elapsedMs: preflight.elapsedMs,
        });
      }
      job.viewport = viewportChoice.viewport;
      job.videoSize = job.videoSize || viewportChoice.viewport;
      summary.viewportProbe = probe;
      summary.viewportChoice = viewportChoice;
      fs.writeFileSync(path.join(dirs.workspace, 'summary.json'), JSON.stringify(summary, null, 2));
      log('viewport.probe', { jobId, choice: probe.choice });
    }

    if (job.viewportOnly || job.viewportPreflightOnly) {
      summary.viewportOnly = true;
      log('viewport.only.done', { jobId, viewport: job.viewport });
    } else {
      const playtest = await runRunwave(job, dirs, url, runnerEnv);
      if (job._runwaveInitialWebgl) summary.webgl = job._runwaveInitialWebgl;
      if (playtest) {
        summary.playtest = {
          mode: playtest.mode,
          steps: playtest.steps,
          elapsedMs: playtest.elapsedMs,
          stoppedByAgent: playtest.stoppedByAgent,
          outputDir: playtest.outputDir,
        };
      }
    }
    summary.status = 'passed';
  } catch (error) {
    summary.status = 'failed';
    if (job._runwaveInitialWebgl) summary.webgl = job._runwaveInitialWebgl;
    summary.error = error.message;
    summary.stack = error.stack;
    log('job.error', { jobId, error: error.message });
  } finally {
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dirs.workspace, 'summary.json'), JSON.stringify(summary, null, 2));
    if (gameProcess) {
      summary.gameProcessCleanup = await stopLongProcess(gameProcess, {
        label: 'game',
        termWaitMs: Number(job.processStopWaitMs ?? runnerEnv.RUNWAVE_PROCESS_STOP_WAIT_MS ?? DEFAULT_PROCESS_STOP_WAIT_MS),
        killWaitMs: Number(job.processKillWaitMs ?? runnerEnv.RUNWAVE_PROCESS_KILL_WAIT_MS ?? DEFAULT_PROCESS_KILL_WAIT_MS),
      }).catch((error) => {
        log('process.stop.error', { jobId, error: error.message });
        return { stopped: false, reason: 'error', error: error.message };
      });
    }
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

if (require.main === module) {
  main().catch((error) => {
    log('fatal', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

module.exports = {
  assertHardwareWebgl,
  chooseViewportFromProbe,
  chromiumArgs,
  dockerRunArgs,
  isSwiftShaderWebgl,
  loadPlaytestInstructions,
  normalizeVlmViewportChoice,
  shouldRunJobInContainer,
  signalLongProcess,
  stopLongProcess,
  viewportCandidatesFromProbe,
  waitForProcessClose,
};
