#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { BrowserSession } = require('./browser-session');
const { OutputWriter } = require('./output-writer');
const { handleAction } = require('./action-handler');
const { readRequestJson, writeResponse } = require('./http-json');
const { defaultOutputRoot, defaultRecordingRoot, sessionFileForId, workspaceRoot } = require('./paths');
const { createProfiler } = require('./profiler');
const { assertActionName, assertSessionId, sessionId, startSessionConfig, targetUrl } = require('./protocol');
const { ensureDir, timestamp, writeJson } = require('./file-utils');

function buildPaths(config) {
  const runDir = config.outDir
    ? path.resolve(workspaceRoot, config.outDir)
    : path.join(defaultRecordingRoot, `runwave-run-${timestamp()}`);
  const outputRoot = config.outputRoot ? path.resolve(workspaceRoot, config.outputRoot) : defaultOutputRoot;
  return { runDir, outputRoot, verboseLogPath: path.join(runDir, 'runwave-verbose.ndjson') };
}

async function main() {
  const config = JSON.parse(process.argv[2] || '{}');
  const paths = buildPaths(config);
  const profiler = createProfiler({
    enabled: Boolean(config.__runwaveVerbose || config.verbose),
    logPath: paths.verboseLogPath,
    source: 'daemon',
  });
  profiler.mark('daemon.start', { action: config.action, action_name: config.action_name });

  profiler.timeSync('daemon.assert_action_name', () => assertActionName(config));
  profiler.timeSync('daemon.assert_session_id', () => assertSessionId(config));
  const id = sessionId(config);
  const sessionFile = sessionFileForId(id);
  profiler.timeSync('daemon.target_url', () => targetUrl(config));
  profiler.timeSync('daemon.ensure_run_dir', { dir: paths.runDir }, () => ensureDir(paths.runDir));
  profiler.timeSync('daemon.ensure_output_root', { dir: paths.outputRoot }, () => ensureDir(paths.outputRoot));

  const output = profiler.timeSync('daemon.output_writer', { outputRoot: paths.outputRoot }, () =>
    new OutputWriter(paths.outputRoot, profiler.child('output-writer'))
  );
  const browser = profiler.timeSync('daemon.browser_session_create', () =>
    new BrowserSession(config, paths, profiler.child('browser-session'))
  );
  await profiler.time('daemon.browser_start', () => browser.start());

  const runtime = {
    config,
    paths,
    output,
    browser,
    profiler,
    sessionId: id,
    sessionFile,
    stepIndex: 0,
  };

  const server = http.createServer(async (req, res) => {
    try {
      const requestStartedAt = Date.now();
      if (req.method !== 'POST') {
        return writeResponse(res, 405, { ok: false, error: 'POST only' });
      }
      const input = await profiler.time('daemon.request.read_json', { method: req.method }, () => readRequestJson(req));
      if (input.__runwaveVerbose) profiler.enable(paths.verboseLogPath);
      profiler.mark('daemon.request.received', {
        action: input.action,
        action_name: input.action_name,
        elapsedSinceRequestMs: Date.now() - requestStartedAt,
      });
      const result = await profiler.time(
        'daemon.request.handle_action',
        { action: input.action, action_name: input.action_name },
        () => handleAction(runtime, input)
      );
      return profiler.timeSync('daemon.request.write_response', { action: input.action, action_name: input.action_name }, () =>
        writeResponse(res, 200, result)
      );
    } catch (error) {
      profiler.mark('daemon.request.error', { error: error.message });
      return writeResponse(res, 500, { ok: false, error: error.message, stack: error.stack });
    }
  });

  server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    profiler.mark('daemon.server.listening', { port });
    const outputDir = profiler.timeSync('daemon.start_response.action_dir', { action_name: config.action_name }, () =>
      output.actionDir(config.action_name)
    );
    const payload = {
      ok: true,
      action: 'start',
      action_name: config.action_name,
      session_id: id,
      sessionDir: paths.runDir,
      outputRoot: paths.outputRoot,
      videoDir: browser.videoDir,
      audioDir: browser.audioDir,
      verboseLog: profiler.enabled ? paths.verboseLogPath : undefined,
      state: await profiler.time('daemon.start_response.state', () => browser.state()),
    };
    if (config.initialScreenshot !== false) {
      const screenshot = await profiler.time('daemon.start_response.screenshot', () =>
        browser.screenshotArtifact(outputDir, '000-initial')
      );
      payload.screenshot = screenshot.path;
      if (screenshot.gridPath) payload.gridScreenshot = screenshot.gridPath;
    }
    if (!payload.verboseLog) delete payload.verboseLog;
    const startResponse = profiler.timeSync('daemon.start_response.write_output', () =>
      output.response(config.action_name, payload)
    );
    profiler.timeSync('daemon.session_file.write', { sessionFile }, () => writeJson(sessionFile, {
      pid: process.pid,
      port,
      sessionDir: paths.runDir,
      outputRoot: paths.outputRoot,
      videoDir: browser.videoDir,
      audioDir: browser.audioDir,
      verboseLogPath: paths.verboseLogPath,
      sessionId: id,
      launchUrl: browser.launchUrl,
      startConfig: startSessionConfig(config),
      initialOutputDir: outputDir,
      initialResponsePath: startResponse.responsePath,
      startedAt: new Date().toISOString(),
    }));
    profiler.mark('daemon.ready', { sessionFile, sessionDir: paths.runDir });
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
