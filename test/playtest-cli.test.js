'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_VIEWPORT,
  parseArgs,
  parseSize,
  resolvePlaytestOptions,
} = require('../bin/runwave-playtest');

function makeGameDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-playtest-cli-'));
  fs.writeFileSync(path.join(dir, 'start.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(dir, 'playtest.md'), 'Play the game.\n');
  return dir;
}

function baseArgs(gameDir) {
  return {
    gameDir,
    outDir: path.join(gameDir, 'out'),
    port: 4317,
    verbose: false,
  };
}

test('playtest CLI resolves a default viewport without metadata', () => {
  const gameDir = makeGameDir();
  const options = resolvePlaytestOptions(baseArgs(gameDir), { OPENROUTER_API_KEY: 'key' });

  assert.deepEqual(options.viewport, DEFAULT_VIEWPORT);
  assert.deepEqual(options.startOverrides, {});
  assert.equal(options.metadataPath, null);
});

test('playtest CLI accepts explicit viewport and video size flags', () => {
  const gameDir = makeGameDir();
  const args = parseArgs([
    'node',
    'runwave-playtest',
    '--game-dir',
    gameDir,
    '--out-dir',
    path.join(gameDir, 'out'),
    '--port',
    '4321',
    '--viewport',
    '1280x720',
    '--video-size',
    '1024x576',
    '--verbose',
  ]);

  const options = resolvePlaytestOptions(args, { OPENROUTER_API_KEY: 'key' });

  assert.equal(options.port, 4321);
  assert.equal(options.verbose, true);
  assert.deepEqual(options.viewport, { width: 1280, height: 720 });
  assert.deepEqual(options.startOverrides.videoSize, { width: 1024, height: 576 });
});

test('playtest CLI reads optional game metadata when present', () => {
  const gameDir = makeGameDir();
  const metadataPath = path.join(gameDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify({
    viewport: { width: 900, height: 700 },
    videoSize: { width: 900, height: 700 },
    startOverrides: {
      keyAliases: { jump: 'Space' },
      gridScreenshots: false,
    },
  }));

  const options = resolvePlaytestOptions(baseArgs(gameDir), { OPENROUTER_API_KEY: 'key' });

  assert.equal(options.metadataPath, metadataPath);
  assert.deepEqual(options.viewport, { width: 900, height: 700 });
  assert.deepEqual(options.startOverrides, {
    keyAliases: { jump: 'Space' },
    gridScreenshots: false,
    videoSize: { width: 900, height: 700 },
  });
});

test('playtest CLI explicit metadata path overrides game-dir metadata', () => {
  const gameDir = makeGameDir();
  const metadataPath = path.join(os.tmpdir(), `runwave-explicit-${Date.now()}.json`);
  fs.writeFileSync(path.join(gameDir, 'metadata.json'), JSON.stringify({
    viewport: { width: 111, height: 222 },
  }));
  fs.writeFileSync(metadataPath, JSON.stringify({
    viewport: { width: 333, height: 444 },
  }));

  const options = resolvePlaytestOptions({
    ...baseArgs(gameDir),
    metadata: metadataPath,
  }, { OPENROUTER_API_KEY: 'key' });

  assert.equal(options.metadataPath, metadataPath);
  assert.deepEqual(options.viewport, { width: 333, height: 444 });
});

test('playtest CLI rejects invalid viewport sizes', () => {
  assert.throws(() => parseSize('1280-720', '--viewport'), /WIDTHxHEIGHT/);
  assert.throws(() => parseSize('0x720', '--viewport'), /positive integer/);

  const gameDir = makeGameDir();
  fs.writeFileSync(path.join(gameDir, 'metadata.json'), JSON.stringify({
    viewport: { width: 'wide', height: 720 },
  }));

  assert.throws(
    () => resolvePlaytestOptions(baseArgs(gameDir), { OPENROUTER_API_KEY: 'key' }),
    /metadata\.viewport/
  );
});
