'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeSequence } = require('./action-parser');
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

async function decideNextSequence({ job, screenshot, state, history, elapsedMs, maxMs, modelClient, promptStep = null, onPrompt = null }) {
  if (!screenshot) throw new Error('agent cannot decide without a screenshot');
  const viewport = viewportFor(job);
  const prompt = buildPlaytesterPrompt({ job, elapsedMs, maxMs, viewport, state, history });
  if (typeof onPrompt === 'function') {
    onPrompt({
      step: promptStep,
      elapsedMs,
      screenshot,
      viewport,
      prompt,
    });
  }
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
    sequence: normalizeSequence(result.json, {
      viewport,
      maxDurationMs: Number(job.agentMaxActionMs || 8000),
    }),
    model: result.model,
    modelElapsedMs: Date.now() - modelStartedAt,
    rawText: String(result.text || '').slice(0, 8000),
    usage: result.usage,
  };
}

function fallbackSequenceAfterInvalidJson({ history, viewport, error }) {
  const lastWithKeyActions = history
    .slice()
    .reverse()
    .find((item) => Array.isArray(item.actions) && item.actions.some((action) => action.type === 'key'));
  const actions = lastWithKeyActions
    ? lastWithKeyActions.actions
        .filter((action) => action.type === 'key')
        .slice(0, 2)
        .map((action) => ({
          type: 'key',
          start: 0,
          end: Math.max(500, Math.min(1500, Number(action.end || 1000) - Number(action.start || 0))),
          key: action.key,
        }))
    : [{ type: 'key', start: 0, end: 600, key: 'Space' }];

  return normalizeSequence(
    {
      summary: 'The model returned invalid JSON, so the harness is continuing with a conservative fallback sequence.',
      actions,
      should_stop: false,
      rationale: `Avoid ending the playtest because of a malformed model response: ${String(error.message || error).slice(0, 200)}`,
    },
    { viewport }
  );
}

function actionsByType(actions, type) {
  return actions.filter((action) => action.type === type);
}

function sequenceBuckets(actions) {
  return {
    clicks: actionsByType(actions, 'click'),
    drags: actionsByType(actions, 'drag'),
    cursorMoves: actionsByType(actions, 'cursor_move'),
    viewMoves: actionsByType(actions, 'view_move'),
  };
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

    let sequence;
    let model;
    let modelElapsedMs;
    let rawText;
    let usage;
    try {
      ({ sequence, model, modelElapsedMs, rawText, usage } = await decideNextSequence({
        job,
        screenshot,
        state,
        history,
        elapsedMs,
        maxMs,
        modelClient,
        promptStep: step + 1,
        onPrompt: (payload) => recorder.prompt(payload),
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
      sequence = fallbackSequenceAfterInvalidJson({ history, viewport: viewportFor(job), error });
      model = 'fallback-after-invalid-json';
      modelElapsedMs = 0;
      rawText = String(error.responseText || error.message || '').slice(0, 8000);
      usage = null;
    }

    if (history.length && sequence.previousSequenceOutcome) {
      history[history.length - 1].outcomeSummary = sequence.previousSequenceOutcome;
    }

    const duration = Math.max(100, Math.min(sequence.durationMs, remainingMs));
    step += 1;
    const harnessStep = {
      action: 'step',
      action_name: `agent-step-${String(step).padStart(3, '0')}`,
      actions: sequence.actions,
      captures: [duration],
      autoCaptures: false,
    };
    const buckets = sequenceBuckets(sequence.actions);

    recorder.sequence({
      step,
      elapsedMs,
      screenshot,
      sequence,
      harnessStep,
      model,
      modelElapsedMs,
      rawText,
      usage,
    });
    log('agent.sequence', {
      step,
      duration,
      model,
      modelElapsedMs,
      actionCount: sequence.actions.length,
      keyActionCount: actionsByType(sequence.actions, 'key').length,
      clickCount: buckets.clicks.length,
      dragCount: buckets.drags.length,
      cursorMoveCount: buckets.cursorMoves.length,
      viewMoveCount: buckets.viewMoves.length,
    });

    lastResponse = await runAction(harnessStep);
    const result = postActionResult(lastResponse, screenshot);
    history.push({
      step,
      summary: sequence.summary,
      rationale: sequence.rationale,
      actions: sequence.actions,
      clicks: buckets.clicks,
      drags: buckets.drags,
      cursorMoves: buckets.cursorMoves,
      viewMoves: buckets.viewMoves,
      result,
    });

    if (consecutiveModelErrors >= maxModelFallbacks) break;

    if (sequence.shouldStop && Date.now() - startedAt >= minMs) {
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
  decideNextSequence,
  decideNextAction: decideNextSequence,
  fallbackSequenceAfterInvalidJson,
  fallbackDecisionAfterInvalidJson: fallbackSequenceAfterInvalidJson,
  latestScreenshot,
  postActionResult,
  responseState,
  runAgenticPlaytest,
};
