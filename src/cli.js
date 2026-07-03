const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { postJson } = require('./http-json');
const { readJson, removeFileIfExists, sleep } = require('./file-utils');
const { sessionFile, workspaceRoot } = require('./paths');
const { assertActionName, parseCliInput, targetUrl, usage } = require('./protocol');

const DEFAULT_SESSION_WAIT_MS = 60000;

function readInput() {
  const arg = process.argv.slice(2).join(' ').trim();
  if (arg) return Promise.resolve(arg);
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw.trim()));
  });
}

function currentSession() {
  if (!fs.existsSync(sessionFile)) {
    throw new Error('runwave is not running; start it first');
  }
  return readJson(sessionFile);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sessionWaitMs(input) {
  return positiveNumber(input.sessionWaitMs ?? process.env.RUNWAVE_SESSION_WAIT_MS, DEFAULT_SESSION_WAIT_MS);
}

async function waitForSession(pid, timeoutMs = DEFAULT_SESSION_WAIT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(sessionFile)) {
      const session = readJson(sessionFile);
      if (!pid || session.pid === pid) return session;
    }
    await sleep(100);
  }
  throw new Error('timed out waiting for runwave session');
}

async function existingSessionStart(input) {
  if (!fs.existsSync(sessionFile) || input.force) return null;
  const session = currentSession();
  try {
    const ping = await postJson(session.port, { action: 'ping', action_name: input.action_name });
    const state = await postJson(session.port, { action: 'state', action_name: input.action_name });
    return {
      ok: true,
      action: 'start',
      action_name: input.action_name,
      alreadyRunning: true,
      session,
      ping,
      output: state,
    };
  } catch {
    removeFileIfExists(sessionFile);
    return null;
  }
}

async function start(input) {
  targetUrl(input);
  const existing = await existingSessionStart(input);
  if (existing) return existing;
  if (input.force) removeFileIfExists(sessionFile);

  const daemon = path.resolve(__dirname, 'daemon.js');
  const child = spawn(process.execPath, [daemon, JSON.stringify(input)], {
    cwd: workspaceRoot,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();

  const session = await waitForSession(child.pid, sessionWaitMs(input));
  return {
    ok: true,
    action: 'start',
    action_name: input.action_name,
    session,
    output: readJson(session.initialResponsePath),
  };
}

async function dispatch(input) {
  assertActionName(input);
  if (input.action === 'start') return start(input);
  const session = currentSession();
  return postJson(session.port, input);
}

async function main() {
  try {
    const input = parseCliInput(await readInput());
    if (!input) {
      console.log(JSON.stringify(usage(), null, 2));
      return;
    }
    console.log(JSON.stringify(await dispatch(input), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  sessionWaitMs,
};
