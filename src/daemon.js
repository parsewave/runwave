#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { BrowserSession } = require('./browser-session');
const { OutputWriter } = require('./output-writer');
const { handleAction } = require('./action-handler');
const { readRequestJson, writeResponse } = require('./http-json');
const { defaultOutputRoot, defaultRecordingRoot, sessionFile, workspaceRoot } = require('./paths');
const { assertActionName, targetUrl } = require('./protocol');
const { ensureDir, timestamp, writeJson } = require('./file-utils');

function buildPaths(config) {
  const runDir = config.outDir
    ? path.resolve(workspaceRoot, config.outDir)
    : path.join(defaultRecordingRoot, `action-harness-run-${timestamp()}`);
  const outputRoot = config.outputRoot ? path.resolve(workspaceRoot, config.outputRoot) : defaultOutputRoot;
  return { runDir, outputRoot };
}

async function main() {
  const config = JSON.parse(process.argv[2] || '{}');
  assertActionName(config);
  targetUrl(config);

  const paths = buildPaths(config);
  ensureDir(paths.runDir);
  ensureDir(paths.outputRoot);

  const output = new OutputWriter(paths.outputRoot);
  const browser = new BrowserSession(config, paths);
  await browser.start();

  const runtime = {
    config,
    paths,
    output,
    browser,
    stepIndex: 0,
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        return writeResponse(res, 405, { ok: false, error: 'POST only' });
      }
      const input = await readRequestJson(req);
      const result = await handleAction(runtime, input);
      return writeResponse(res, 200, result);
    } catch (error) {
      return writeResponse(res, 500, { ok: false, error: error.message, stack: error.stack });
    }
  });

  server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const outputDir = output.actionDir(config.action_name);
    const payload = {
      ok: true,
      action: 'start',
      action_name: config.action_name,
      sessionDir: paths.runDir,
      outputRoot: paths.outputRoot,
      videoDir: browser.videoDir,
      state: await browser.state(),
    };
    if (config.initialScreenshot !== false) {
      payload.screenshot = await browser.screenshot(outputDir, '000-initial');
    }
    const startResponse = output.response(config.action_name, payload);
    writeJson(sessionFile, {
      pid: process.pid,
      port,
      sessionDir: paths.runDir,
      outputRoot: paths.outputRoot,
      videoDir: browser.videoDir,
      launchUrl: browser.launchUrl,
      initialOutputDir: outputDir,
      initialResponsePath: startResponse.responsePath,
      startedAt: new Date().toISOString(),
    });
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
