'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeDecision } = require('./action-parser');
const { AgentRecorder } = require('./history');
const { chatCompletion, dataUrl, isModelJsonParseError } = require('./model-client');
const { buildPlaytesterPrompt } = require('./prompt');

const STOP_RESERVE_MS = 5000;

function responseBody(response) {
  if (!response || typeof response !== 'object') return {};
  return response.output && typeof response.output === 'object' ? response.output : response;
}

function latestScreenshot(response) {
  const body = responseBody(response);
  const captures = Array.isArray(body.captures) ? body.captures : [];
  const capture = captures.length ? captures[captures.length - 1] : null;
  return (capture && capture.path) || body.screenshot || null;
}

function responseState(response) {
  const body = responseBody(response);
  return body.endState || body.state || {};
}

function viewportFor(job) {
  return job.viewport || job.videoSize || { width: 1280, height: 720 };
}

function fileHash(file) {
  if (!file) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function screenshotChanged(beforeScreenshot, afterScreenshot) {
  if (!beforeScreenshot || !afterScreenshot) return null;
  const beforeHash = fileHash(beforeScreenshot);
  const afterHash = fileHash(afterScreenshot);
  if (!beforeHash || !afterHash) return null;
  return beforeHash !== afterHash;
}

function postActionResult(response, beforeScreenshot) {
  const body = responseBody(response);
  const captures = Array.isArray(body.captures) ? body.captures : [];
  const afterScreenshot = latestScreenshot(response);
  const result = {
    ok: typeof body.ok === 'boolean' ? body.ok : null,
    screenshot: afterScreenshot,
    screenshotChanged: screenshotChanged(beforeScreenshot, afterScreenshot),
    captureCount: captures.length,
    state: responseState(response),
  };
  if (body.error) result.error = String(body.error).slice(0, 500);
  return result;
}

async function decideNextAction({ job, screenshot, state, history, elapsedMs, maxMs, modelClient }) {
  if (!screenshot) throw new Error('agent cannot decide without a screenshot');
  const viewport = viewportFor(job);
  const prompt = buildPlaytesterPrompt({ job, elapsedMs, maxMs, viewport, state, history });
  const modelStartedAt = Date.now();
  const result = await modelClient({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl(screenshot) } },
        ],
      },
    ],
    maxTokens: Number(job.agentMaxTokens || 2400),
    timeoutMs: Number(job.agentTimeoutMs || 120000),
    temperature: Number(job.agentTemperature ?? 0.2),
  });

  return {
    decision: normalizeDecision(result.json, {
      viewport,
      maxDurationMs: Number(job.agentMaxActionMs || 8000),
    }),
    model: result.model,
    modelElapsedMs: Date.now() - modelStartedAt,
    rawText: String(result.text || '').slice(0, 8000),
    usage: result.usage,
  };
}

function fallbackDecisionAfterInvalidJson({ history, viewport, error }) {
  const lastWithCommands = history
    .slice()
    .reverse()
    .find((item) => Array.isArray(item.commands) && item.commands.length);
  const commands = lastWithCommands
    ? lastWithCommands.commands.slice(0, 2).map((command) => ({
        from: 0,
        to: Math.max(500, Math.min(1500, Number(command.to || 1000) - Number(command.from || 0))),
        key: command.key,
      }))
    : [{ from: 0, to: 600, key: 'Space' }];

  return normalizeDecision(
    {
      summary: 'The model returned invalid JSON, so the harness is continuing with a conservative fallback action.',
      duration_ms: 1000,
      commands,
      clicks: [],
      drags: [],
      cursor_moves: [],
      view_moves: [],
      should_stop: false,
      rationale: `Avoid ending the playtest because of a malformed model response: ${String(error.message || error).slice(0, 200)}`,
    },
    { viewport }
  );
}

async function runAgenticPlaytest({ job, initialResponse, runAction, outputDir, modelClient = chatCompletion, log = () => {} }) {
  const maxMs = Number(job.playtestDurationMs ?? 120000);
  const minMs = Number(job.agentMinPlaytestMs ?? Math.min(30000, maxMs));
  const recorder = new AgentRecorder(outputDir || path.join(process.cwd(), 'artifacts', 'agent'));
  const history = [];
  const startedAt = Date.now();
  let lastResponse = initialResponse;
  let step = 0;
  let stoppedByAgent = false;
  let modelErrorCount = 0;
  let consecutiveModelErrors = 0;
  const maxModelFallbacks = Math.max(1, Math.round(Number(job.agentMaxModelFallbacks || 3)));

  while (Date.now() - startedAt < maxMs - STOP_RESERVE_MS) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = maxMs - elapsedMs - STOP_RESERVE_MS;
    if (remainingMs <= 0) break;

    const screenshot = latestScreenshot(lastResponse);
    const state = responseState(lastResponse);
    recorder.observation({ step, elapsedMs, screenshot, state });

    let decision;
    let model;
    let modelElapsedMs;
    let rawText;
    let usage;
    try {
      ({ decision, model, modelElapsedMs, rawText, usage } = await decideNextAction({
        job,
        screenshot,
        state,
        history,
        elapsedMs,
        maxMs,
        modelClient,
      }));
      consecutiveModelErrors = 0;
    } catch (error) {
      if (!isModelJsonParseError(error)) throw error;
      modelErrorCount += 1;
      consecutiveModelErrors += 1;
      log('agent.model_json_error', {
        step: step + 1,
        consecutiveModelErrors,
        error: String(error.message || error).slice(0, 500),
      });
      decision = fallbackDecisionAfterInvalidJson({ history, viewport: viewportFor(job), error });
      model = 'fallback-after-invalid-json';
      modelElapsedMs = 0;
      rawText = String(error.responseText || error.message || '').slice(0, 8000);
      usage = null;
    }

    if (history.length && decision.previousActionOutcome) {
      history[history.length - 1].outcomeSummary = decision.previousActionOutcome;
    }

    const duration = Math.max(100, Math.min(decision.durationMs, remainingMs));
    step += 1;
    const action = {
      action: 'step',
      action_name: `agent-step-${String(step).padStart(3, '0')}`,
      duration,
      commands: decision.commands,
      clicks: decision.clicks,
      drags: decision.drags,
      cursor_moves: decision.cursorMoves,
      view_moves: decision.viewMoves,
      captures: [duration],
      autoCaptures: false,
    };

    recorder.action({
      step,
      elapsedMs,
      screenshot,
      decision,
      action,
      model,
      modelElapsedMs,
      rawText,
      usage,
    });
    log('agent.action', {
      step,
      duration,
      model,
      modelElapsedMs,
      commandCount: action.commands.length,
      clickCount: action.clicks.length,
      dragCount: action.drags.length,
      cursorMoveCount: action.cursor_moves.length,
      viewMoveCount: action.view_moves.length,
    });

    lastResponse = await runAction(action);
    const result = postActionResult(lastResponse, screenshot);
    history.push({
      step,
      summary: decision.summary,
      rationale: decision.rationale,
      commands: decision.commands,
      clicks: decision.clicks,
      drags: decision.drags,
      cursorMoves: decision.cursorMoves,
      result,
    });

    if (consecutiveModelErrors >= maxModelFallbacks) break;

    if (decision.shouldStop && Date.now() - startedAt >= minMs) {
      stoppedByAgent = true;
      break;
    }
  }

  const summary = {
    mode: 'agent',
    steps: step,
    elapsedMs: Date.now() - startedAt,
    stoppedByAgent,
    maxMs,
    minMs,
    modelErrorCount,
    history,
  };
  recorder.summary(summary);
  return {
    ...summary,
    lastResponse,
    outputDir: recorder.outputDir,
  };
}

module.exports = {
  decideNextAction,
  fallbackDecisionAfterInvalidJson,
  latestScreenshot,
  postActionResult,
  responseState,
  runAgenticPlaytest,
};
