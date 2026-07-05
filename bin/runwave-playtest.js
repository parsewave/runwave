#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runPlaytest } = require('../playtest/playtest');

const DEFAULT_VIEWPORT = Object.freeze({ width: 1024, height: 620 });

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
    '  --viewport <WxH>            browser viewport (default 1024x620, or metadata viewport)',
    '  --video-size <WxH>          recording size (default viewport, or metadata videoSize)',
    '  --metadata <path>           optional metadata JSON path (defaults to game-dir/metadata.json if present)',
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
    if (arg === '--viewport') { out.viewport = parseSize(next(), '--viewport'); continue; }
    if (arg === '--video-size') { out.videoSize = parseSize(next(), '--video-size'); continue; }
    if (arg === '--metadata') { out.metadata = next(); continue; }
    if (arg === '--playtest-duration-ms') { out.playtestDurationMs = Number(next()); continue; }
    if (arg === '--min-playtest-ms') { out.minPlaytestMs = Number(next()); continue; }
    if (arg === '--model') { out.model = next(); continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function parseSize(value, label) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(`${label} must be formatted as WIDTHxHEIGHT`);
  }
  return normalizeSize({ width: Number(match[1]), height: Number(match[2]) }, label);
}

function normalizeSize(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object with width and height`);
  }
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${label} must include positive integer width and height`);
  }
  return { width, height };
}

function optionalObject(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return { ...value };
}

function metadataPathForArgs(gameDir, metadataPath) {
  if (metadataPath) return path.resolve(metadataPath);
  const candidate = path.join(path.resolve(gameDir), 'metadata.json');
  return fs.existsSync(candidate) ? candidate : null;
}

function loadMetadata(gameDir, metadataPath) {
  const resolvedPath = metadataPathForArgs(gameDir, metadataPath);
  if (!resolvedPath) return { metadata: {}, metadataPath: null };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to read playtest metadata ${resolvedPath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`playtest metadata must be a JSON object: ${resolvedPath}`);
  }
  return { metadata: parsed, metadataPath: resolvedPath };
}

function resolvePlaytestOptions(args, env = process.env) {
  const gameDir = path.resolve(args.gameDir);
  const { metadata, metadataPath } = loadMetadata(gameDir, args.metadata);

  const metadataStartOverrides = optionalObject(metadata.startOverrides, 'metadata.startOverrides');
  const viewport = args.viewport
    || (metadata.viewport ? normalizeSize(metadata.viewport, 'metadata.viewport') : null)
    || { ...DEFAULT_VIEWPORT };
  const videoSize = args.videoSize
    || (metadata.videoSize ? normalizeSize(metadata.videoSize, 'metadata.videoSize') : null)
    || (metadataStartOverrides.videoSize ? normalizeSize(metadataStartOverrides.videoSize, 'metadata.startOverrides.videoSize') : null);

  const startOverrides = { ...metadataStartOverrides };
  if (videoSize) startOverrides.videoSize = videoSize;

  return {
    gameDir,
    outDir: path.resolve(args.outDir),
    port: args.port,
    openRouterApiKey: env.OPENROUTER_API_KEY,
    playtestDurationMs: args.playtestDurationMs,
    minPlaytestMs: args.minPlaytestMs,
    model: args.model,
    verbose: args.verbose,
    viewport,
    startOverrides,
    metadataPath,
  };
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

  const summary = await runPlaytest(resolvePlaytestOptions(args));

  process.exit(summary.status === 'passed' ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_VIEWPORT,
  loadMetadata,
  normalizeSize,
  parseArgs,
  parseSize,
  resolvePlaytestOptions,
};
