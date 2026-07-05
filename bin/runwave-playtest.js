#!/usr/bin/env node
'use strict';

const path = require('path');
const { runPlaytest } = require('../playtest/playtest');

function usage() {
  return [
    'Usage:',
    '  runwave-playtest --game-dir <path> --out-dir <path> --port <n> [options]',
    '',
    'Required:',
    '  --game-dir <path>            directory containing start.sh and playtest.md',
    '  --out-dir <path>             directory for artifacts (video, screenshots, agent history, summary.json)',
    '  --port <n>                   port passed to start.sh via PORT= and used as http://127.0.0.1:<port>/',
    '',
    'Environment:',
    '  OPENROUTER_API_KEY           required; forwarded to the agent',
    '  OPENROUTER_MODEL             optional model override (or use --model)',
    '',
    'Options:',
    '  --playtest-duration-ms <n>   max playtest wall time in ms (default 150000)',
    '  --min-playtest-ms <n>        floor before the agent may self-stop (default duration - 10000)',
    '  --model <slug>               OpenRouter model slug (sets RUNWAVE_AGENT_MODEL)',
    '  --verbose, -v                forward verbose flag to the runwave harness',
    '  --help, -h                   show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { verbose: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--verbose' || arg === '-v') { out.verbose = true; continue; }
    if (arg === '--game-dir') { out.gameDir = next(); continue; }
    if (arg === '--out-dir') { out.outDir = next(); continue; }
    if (arg === '--port') { out.port = Number(next()); continue; }
    if (arg === '--playtest-duration-ms') { out.playtestDurationMs = Number(next()); continue; }
    if (arg === '--min-playtest-ms') { out.minPlaytestMs = Number(next()); continue; }
    if (arg === '--model') { out.model = next(); continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const missing = [];
  if (!args.gameDir) missing.push('--game-dir');
  if (!args.outDir) missing.push('--out-dir');
  if (!args.port) missing.push('--port');
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) missing.push('OPENROUTER_API_KEY');
  if (missing.length) {
    process.stderr.write(`missing required: ${missing.join(', ')}\n\n${usage()}\n`);
    process.exit(2);
  }

  const summary = await runPlaytest({
    gameDir: path.resolve(args.gameDir),
    outDir: path.resolve(args.outDir),
    port: args.port,
    openRouterApiKey,
    playtestDurationMs: args.playtestDurationMs,
    minPlaytestMs: args.minPlaytestMs,
    model: args.model,
    verbose: args.verbose,
  });

  process.exit(summary.status === 'passed' ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
