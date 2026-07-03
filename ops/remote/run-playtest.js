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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  };
  if (job.channel) launchOptions.channel = String(job.channel);
  if (job.executablePath) launchOptions.executablePath = String(job.executablePath);

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
  try {
    const result = await chatCompletion({
      messages: [{ role: 'user', content }],
      maxTokens: Number(job.viewportPreflightMaxTokens || 700),
      timeoutMs: Number(job.viewportPreflightTimeoutMs || 120000),
      temperature: Number(job.viewportPreflightTemperature ?? 0),
    });
    const choice = normalizeVlmViewportChoice(result.json, candidates, fallbackChoice);
    return {
      enabled: true,
      elapsedMs: Date.now() - startedAt,
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
      choice: fallbackChoice,
      error: error.message,
      candidates,
    };
  }
}

async function probeViewport(job, dirs, url, env = process.env) {
  const viewport = job.probeViewport || { width: 1280, height: 720 };
  const { chromium } = require(path.join(dirs.runwave, 'node_modules', 'playwright'));
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  };
  if (job.channel) launchOptions.channel = String(job.channel);
  if (job.executablePath) launchOptions.executablePath = String(job.executablePath);

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

if (require.main === module) {
  main().catch((error) => {
    log('fatal', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

module.exports = {
  chooseViewportFromProbe,
  normalizeVlmViewportChoice,
  viewportCandidatesFromProbe,
};
