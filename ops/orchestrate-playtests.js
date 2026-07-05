#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { defaultSshKey } = require('./lib/ssh-key');

const DEFAULT_HARDWARE_WEBGL_GAMES = new Set(['aether-outpost-patrol']);
const HARDWARE_WEBGL_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  '--use-gl=egl',
  '--autoplay-policy=no-user-gesture-required',
];

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    gamesDir: path.resolve(process.cwd(), 'cruft/games'),
    gamesS3Uri: 's3://pw-cruft/games',
    sshKey: defaultSshKey(),
    sshUser: 'root',
    runwaveRepo: 'https://github.com/parsewave/runwave',
    runwaveRef: 'main',
    attemptsPerGame: 1,
    totalAttempts: 0,
    concurrencyPerServer: 3,
    requiredConcurrency: 20,
    basePort: 8900,
    playtestDurationMs: 120000,
    agentMinPlaytestMs: null,
    markGridRows: null,
    markGridCols: null,
    vlmViewportPreflight: false,
    viewportPreflightAttempts: null,
    playMode: 'scripted',
    skipPlaywrightInstall: false,
    hardwareWebglGames: new Set(DEFAULT_HARDWARE_WEBGL_GAMES),
    hardwareWebglChromiumArgs: [...HARDWARE_WEBGL_CHROMIUM_ARGS],
    runId: `run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--inventory') args.inventory = next();
    else if (arg === '--s3-uri') args.s3Uri = next();
    else if (arg === '--games-s3-uri') args.gamesS3Uri = next();
    else if (arg === '--games-dir') args.gamesDir = path.resolve(next());
    else if (arg === '--games') args.games = next().split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--ssh-key') args.sshKey = next();
    else if (arg === '--ssh-user') args.sshUser = next();
    else if (arg === '--runwave-repo') args.runwaveRepo = next();
    else if (arg === '--runwave-ref') args.runwaveRef = next();
    else if (arg === '--attempts-per-game') args.attemptsPerGame = Number(next());
    else if (arg === '--total-attempts') args.totalAttempts = Number(next());
    else if (arg === '--concurrency-per-server') args.concurrencyPerServer = Number(next());
    else if (arg === '--require-concurrency') args.requiredConcurrency = Number(next());
    else if (arg === '--base-port') args.basePort = Number(next());
    else if (arg === '--playtest-duration-ms') args.playtestDurationMs = Number(next());
    else if (arg === '--agent-min-playtest-ms') args.agentMinPlaytestMs = Number(next());
    else if (arg === '--mark-grid-rows') args.markGridRows = Number(next());
    else if (arg === '--mark-grid-cols') args.markGridCols = Number(next());
    else if (arg === '--vlm-viewport-preflight') args.vlmViewportPreflight = true;
    else if (arg === '--viewport-preflight-attempts') args.viewportPreflightAttempts = Number(next());
    else if (arg === '--play-mode') args.playMode = next();
    else if (arg === '--agent') args.playMode = 'agent';
    else if (arg === '--skip-playwright-install') args.skipPlaywrightInstall = true;
    else if (arg === '--hardware-webgl-games') args.hardwareWebglGames = new Set(parseList(next()));
    else if (arg === '--no-default-hardware-webgl-games') args.hardwareWebglGames = new Set();
    else if (arg === '--run-id') args.runId = next();
    else if (arg === '--include-nonbrowser') args.includeNonbrowser = true;
    else if (arg === '--local-games') args.gamesS3Uri = '';
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node ops/orchestrate-playtests.js --inventory ops/inventory/<batch>.json --s3-uri s3://bucket/prefix [options]',
    '',
    'Options:',
    '  --total-attempts N',
    '  --attempts-per-game N',
    '  --games game-a,game-b',
    '  --games-s3-uri s3://bucket/prefix',
    '  --local-games',
    '  --ssh-key PATH',
    '  --runwave-ref REF',
    '  --concurrency-per-server N',
    '  --require-concurrency N',
    '  --base-port N',
    '  --playtest-duration-ms N',
    '  --agent-min-playtest-ms N',
    '  --mark-grid-rows N',
    '  --mark-grid-cols N',
    '  --vlm-viewport-preflight',
    '  --viewport-preflight-attempts N',
    '  --play-mode scripted|agent',
    '  --agent',
    '  --hardware-webgl-games game-a,game-b',
    '  --no-default-hardware-webgl-games',
    '  --skip-playwright-install',
    '  --dry-run',
  ].join('\n');
}

function loadCredentialEnv() {
  const file = path.join(os.homedir(), '.c.yaml');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:\s*"?([^"]*)"?\s*$/);
    if (!match) continue;
    if (/^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_DEFAULT_REGION)$/.test(match[1])) {
      env[match[1]] = match[2].trim();
    }
  }
  if (!env.AWS_DEFAULT_REGION) env.AWS_DEFAULT_REGION = 'us-east-1';
  return env;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...loadCredentialEnv(), ...(options.env || {}) },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function parseS3Uri(uri) {
  const match = String(uri || '').match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!match) throw new Error(`invalid S3 URI: ${uri}`);
  return {
    bucket: match[1],
    prefix: match[2].replace(/^\/+|\/+$/g, ''),
  };
}

function loadInventory(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const servers = Array.isArray(raw) ? raw : raw.servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error(`inventory has no servers: ${file}`);
  }
  return servers.map((server) => ({
    name: server.name,
    ip: server.ipv4 || server.ip || server.publicIp,
  })).filter((server) => server.ip);
}

function discoverGames(args) {
  if (args.gamesS3Uri) return discoverS3Games(args);

  const entries = fs.readdirSync(args.gamesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const requested = args.games ? new Set(args.games) : null;
  const games = [];
  const skipped = [];
  for (const name of entries) {
    if (requested && !requested.has(name)) continue;
    const dir = path.join(args.gamesDir, name);
    const start = path.join(dir, 'start.sh');
    if (!fs.existsSync(start)) {
      skipped.push({ name, reason: 'missing start.sh' });
      continue;
    }
    const script = fs.readFileSync(start, 'utf8');
    const browserGame = script.includes('http.server') || script.includes('localhost') || script.includes('127.0.0.1');
    if (!browserGame && !args.includeNonbrowser) {
      skipped.push({ name, reason: 'not an HTTP browser start script' });
      continue;
    }
    games.push(name);
  }
  if (requested) {
    for (const name of requested) {
      if (!entries.includes(name)) skipped.push({ name, reason: 'not found' });
    }
  }
  return { games, skipped };
}

function discoverS3Games(args) {
  const { bucket, prefix } = parseS3Uri(args.gamesS3Uri);
  const normalizedPrefix = prefix ? `${prefix}/` : '';
  const result = runCapture('aws', [
    's3api',
    'list-objects-v2',
    '--bucket',
    bucket,
    '--prefix',
    normalizedPrefix,
    '--delimiter',
    '/',
    '--output',
    'json',
  ]);
  const payload = JSON.parse(result.stdout || '{}');
  const requested = args.games ? new Set(args.games) : null;
  const entries = (payload.CommonPrefixes || [])
    .map((item) => item.Prefix)
    .filter(Boolean)
    .map((item) => item.slice(normalizedPrefix.length).replace(/\/+$/g, ''))
    .filter(Boolean)
    .sort();

  const games = [];
  const skipped = [];
  for (const name of entries) {
    if (requested && !requested.has(name)) continue;
    if (name.startsWith('.')) {
      skipped.push({ name, reason: 'hidden S3 prefix' });
      continue;
    }
    const startUri = `${args.gamesS3Uri.replace(/\/+$/, '')}/${name}/start.sh`;
    const start = runCapture('aws', ['s3', 'cp', startUri, '-'], { allowFailure: true });
    if (start.status !== 0) {
      skipped.push({ name, reason: 'missing start.sh' });
      continue;
    }
    const browserGame =
      start.stdout.includes('http.server') ||
      start.stdout.includes('localhost') ||
      start.stdout.includes('127.0.0.1');
    if (!browserGame && !args.includeNonbrowser) {
      skipped.push({ name, reason: 'not an HTTP browser start script' });
      continue;
    }
    games.push(name);
  }

  if (requested) {
    for (const name of requested) {
      if (!entries.includes(name)) skipped.push({ name, reason: 'not found in S3 prefix' });
    }
  }

  return { games, skipped };
}

function agentMinPlaytestMs(args) {
  if (Number.isFinite(args.agentMinPlaytestMs)) return Math.max(0, args.agentMinPlaytestMs);
  const durationMs = Number.isFinite(args.playtestDurationMs) ? args.playtestDurationMs : 120000;
  return Math.max(0, durationMs - 10000);
}

function buildJobs(args, games) {
  const jobs = [];
  const addJob = (game, attempt) => {
    const jobId = `${args.runId}-${game}-attempt-${String(attempt).padStart(3, '0')}`;
    const job = {
      jobId,
      runId: args.runId,
      game,
      attempt,
      runwaveRepo: args.runwaveRepo,
      runwaveRef: args.runwaveRef,
      playMode: args.playMode,
      skipPlaywrightInstall: args.skipPlaywrightInstall,
      playtestDurationMs: args.playtestDurationMs,
      s3Uri: `${args.s3Uri.replace(/\/+$/, '')}/${args.runId}/${game}/attempt-${String(attempt).padStart(3, '0')}`,
    };
    if (args.hardwareWebglGames && args.hardwareWebglGames.has(game)) {
      job.requiresHardwareWebgl = true;
      job.chromiumArgs = [...args.hardwareWebglChromiumArgs];
      job.chromiumArgsMode = 'replace';
      job.headless = true;
      job.audioXvfb = false;
    }
    if (args.playMode === 'agent') job.agentMinPlaytestMs = agentMinPlaytestMs(args);
    if (Number.isFinite(args.markGridRows)) job.markGridRows = Math.max(1, Math.round(args.markGridRows));
    if (Number.isFinite(args.markGridCols)) job.markGridCols = Math.max(1, Math.round(args.markGridCols));
    if (args.vlmViewportPreflight) job.vlmViewportPreflight = true;
    if (Number.isFinite(args.viewportPreflightAttempts)) {
      job.viewportPreflightAttempts = Math.max(1, Math.round(args.viewportPreflightAttempts));
    }
    jobs.push(job);
  };

  if (args.totalAttempts > 0) {
    const counts = new Map(games.map((game) => [game, 0]));
    for (let i = 0; i < args.totalAttempts; i += 1) {
      const game = games[i % games.length];
      const attempt = counts.get(game) + 1;
      counts.set(game, attempt);
      addJob(game, attempt);
    }
  } else {
    for (const game of games) {
      for (let attempt = 1; attempt <= args.attemptsPerGame; attempt += 1) addJob(game, attempt);
    }
  }
  return jobs;
}

function sshCommand(args, server, remoteCommand) {
  return spawn('ssh', [
    '-i', args.sshKey,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=15',
    `${args.sshUser}@${server.ip}`,
    remoteCommand,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function uploadJob(args, server, job) {
  return new Promise((resolve, reject) => {
    const remoteJob = `/var/lib/runwave/jobs/${job.jobId}.json`;
    const command = `cat > ${remoteJob} && node /opt/runwave/bin/run-playtest.js --job ${remoteJob}`;
    const child = sshCommand(args, server, command);
    child.stdin.end(JSON.stringify(job, null, 2));
    child.stdout.on('data', (chunk) => process.stdout.write(`[${server.name} ${job.jobId}] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[${server.name} ${job.jobId}] ${chunk}`));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ job, server, code });
      else reject(Object.assign(new Error(`${job.jobId} failed on ${server.name} with exit ${code}`), {
        job,
        server,
        code,
      }));
    });
  });
}

function fleetCapacity(args, servers) {
  return servers.length * args.concurrencyPerServer;
}

async function runQueue(args, servers, jobs) {
  const pending = [...jobs];
  const activeByServer = new Map(servers.map((server) => [server.name, 0]));
  const nextPortByServer = new Map(servers.map((server) => [server.name, args.basePort]));
  const results = [];
  const failures = [];
  let serverCursor = 0;

  const nextAvailableServer = () => {
    for (let offset = 0; offset < servers.length; offset += 1) {
      const index = (serverCursor + offset) % servers.length;
      const server = servers[index];
      if (activeByServer.get(server.name) < args.concurrencyPerServer) {
        serverCursor = (index + 1) % servers.length;
        return server;
      }
    }
    return null;
  };

  return new Promise((resolve) => {
    const pump = () => {
      while (pending.length > 0) {
        const server = nextAvailableServer();
        if (!server) break;
        const job = pending.shift();
        job.port = nextPortByServer.get(server.name);
        nextPortByServer.set(server.name, job.port + 1);
        activeByServer.set(server.name, activeByServer.get(server.name) + 1);
        console.log(`Starting ${job.jobId} on ${server.name} (${server.ip}) port ${job.port}`);
        uploadJob(args, server, job)
          .then((result) => results.push(result))
          .catch((error) => {
            failures.push(error);
            console.error(error.message);
          })
          .finally(() => {
            activeByServer.set(server.name, activeByServer.get(server.name) - 1);
            pump();
          });
      }
      const active = [...activeByServer.values()].reduce((sum, value) => sum + value, 0);
      if (pending.length === 0 && active === 0) resolve({ results, failures });
    };
    pump();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.inventory || !args.s3Uri) {
    console.error(usage());
    process.exit(2);
  }
  const servers = loadInventory(args.inventory);
  const { games, skipped } = discoverGames(args);
  if (skipped.length) {
    for (const item of skipped) console.error(`Skipping ${item.name}: ${item.reason}`);
  }
  if (games.length === 0) throw new Error('no browser games discovered');
  const jobs = buildJobs(args, games);
  const hardwareJobs = jobs.filter((job) => job.requiresHardwareWebgl);
  const capacity = fleetCapacity(args, servers);
  if (jobs.length >= args.requiredConcurrency && capacity < args.requiredConcurrency) {
    throw new Error(
      `fleet capacity ${capacity} is below required concurrency ${args.requiredConcurrency}; ` +
      `add servers or raise --concurrency-per-server`
    );
  }
  console.log(`Run id: ${args.runId}`);
  console.log(`Servers: ${servers.map((server) => `${server.name}=${server.ip}`).join(', ')}`);
  if (args.gamesS3Uri) console.log(`Game source: ${args.gamesS3Uri}`);
  else console.log(`Game source: ${args.gamesDir}`);
  console.log(`Games: ${games.join(', ')}`);
  console.log(
    `Jobs: ${jobs.length}; concurrency per server: ${args.concurrencyPerServer}; ` +
    `fleet capacity: ${capacity}; playtest duration: ${args.playtestDurationMs}ms`
  );
  if (hardwareJobs.length) {
    console.log(`Hardware WebGL jobs: ${hardwareJobs.map((job) => job.game).join(', ')}`);
  }
  if (args.dryRun) {
    let serverIndex = 0;
    const ports = new Map(servers.map((server) => [server.name, args.basePort]));
    for (const job of jobs) {
      const server = servers[serverIndex % servers.length];
      const port = ports.get(server.name);
      ports.set(server.name, port + 1);
      serverIndex += 1;
      console.log(`${job.jobId} -> ${server.name}:${port} -> ${job.s3Uri}`);
    }
    return;
  }
  const { results, failures } = await runQueue(args, servers, jobs);
  console.log(`Completed ${results.length}/${jobs.length} jobs`);
  if (failures.length) {
    console.error(`${failures.length} jobs failed`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  agentMinPlaytestMs,
  buildJobs,
  parseArgs,
};
