#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = {
    gamesDir: path.resolve(process.cwd(), 'cruft/games'),
    sshKey: path.join(os.homedir(), '.ssh/id_louka'),
    sshUser: 'root',
    runwaveRepo: 'https://github.com/parsewave/runwave',
    runwaveRef: 'main',
    attemptsPerGame: 1,
    totalAttempts: 0,
    concurrencyPerServer: 3,
    requiredConcurrency: 20,
    basePort: 8900,
    runId: `run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--inventory') args.inventory = next();
    else if (arg === '--s3-uri') args.s3Uri = next();
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
    else if (arg === '--run-id') args.runId = next();
    else if (arg === '--include-nonbrowser') args.includeNonbrowser = true;
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
    '  --runwave-ref REF',
    '  --concurrency-per-server N',
    '  --require-concurrency N',
    '  --base-port N',
    '  --dry-run',
  ].join('\n');
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

function buildJobs(args, games) {
  const jobs = [];
  const addJob = (game, attempt) => {
    const jobId = `${args.runId}-${game}-attempt-${String(attempt).padStart(3, '0')}`;
    jobs.push({
      jobId,
      runId: args.runId,
      game,
      attempt,
      runwaveRepo: args.runwaveRepo,
      runwaveRef: args.runwaveRef,
      s3Uri: `${args.s3Uri.replace(/\/+$/, '')}/${args.runId}/${game}/attempt-${String(attempt).padStart(3, '0')}`,
    });
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
  const capacity = fleetCapacity(args, servers);
  if (jobs.length >= args.requiredConcurrency && capacity < args.requiredConcurrency) {
    throw new Error(
      `fleet capacity ${capacity} is below required concurrency ${args.requiredConcurrency}; ` +
      `add servers or raise --concurrency-per-server`
    );
  }
  console.log(`Run id: ${args.runId}`);
  console.log(`Servers: ${servers.map((server) => `${server.name}=${server.ip}`).join(', ')}`);
  console.log(`Games: ${games.join(', ')}`);
  console.log(`Jobs: ${jobs.length}; concurrency per server: ${args.concurrencyPerServer}; fleet capacity: ${capacity}`);
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
