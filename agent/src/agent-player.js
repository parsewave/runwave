'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeSequence } = require('./action-parser');
const { AgentRecorder } = require('./history');
const { chatCompletion, dataUrl } = require('./model-client');
const { buildPlaytesterPrompt, sequenceSchemaGuide } = require('./prompt');

const STOP_RESERVE_MS = 5000;
const MODEL_SEQUENCE_INVALID = 'RUNWAVE_MODEL_SEQUENCE_INVALID';

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

function postSequenceResult(response, beforeScreenshot) {
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

function modelOutputSchemaError(error, responseText) {
  const wrapped = new Error(`model response did not match the sequence schema: ${error.message}`);
  wrapped.code = MODEL_SEQUENCE_INVALID;
  wrapped.responseText = responseText;
  wrapped.cause = error;
  return wrapped;
}

function schemaCorrectionMessage(error) {
  return [
    'The previous JSON object was parseable, but it did not match the required sequence schema.',
    `Validation error: ${String(error.message || error).slice(0, 500)}`,
    '',
    sequenceSchemaGuide(),
    '',
    'Return a corrected JSON object for the same screenshot and same game state. Do not include markdown, prose, comments, trailing text, or extra keys.',
  ].join('\n');
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
  const firstMessage = {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: dataUrl(screenshot) } },
    ],
  };
  let messages = [firstMessage];
  const schemaAttempts = Math.max(1, Math.round(Number(job.agentSchemaAttempts || 2)));
  let lastSchemaError = null;

  for (let attempt = 1; attempt <= schemaAttempts; attempt += 1) {
    const result = await modelClient({
      messages,
      maxTokens: Number(job.agentMaxTokens || 2400),
      timeoutMs: Number(job.agentTimeoutMs || 120000),
      temperature: Number(job.agentTemperature ?? 0.2),
    });

    try {
      const sequence = normalizeSequence(result.json, {
        viewport,
        config: job,
        maxDurationMs: Number(job.agentMaxActionMs || 8000),
      });

      return {
        sequence,
        model: result.model,
        modelElapsedMs: Date.now() - modelStartedAt,
        rawText: String(result.text || '').slice(0, 8000),
        usage: result.usage,
      };
    } catch (error) {
      lastSchemaError = modelOutputSchemaError(error, result.text);
      if (attempt >= schemaAttempts) throw lastSchemaError;

      messages = [
        firstMessage,
        { role: 'assistant', content: String(result.text || '').slice(0, 4000) },
        { role: 'user', content: schemaCorrectionMessage(error) },
      ];
    }
  }

  throw lastSchemaError || new Error('model response did not match the sequence schema');
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

    if (history.length && sequence.previousSequenceOutcome) {
      history[history.length - 1].outcomeSummary = sequence.previousSequenceOutcome;
    }

    const duration = Math.max(100, Math.min(sequence.durationMs, remainingMs));
    step += 1;
    const harnessStep = {
      action: 'step',
      action_name: `agent-step-${String(step).padStart(3, '0')}`,
      duration,
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
    const result = postSequenceResult(lastResponse, screenshot);
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
  latestScreenshot,
  modelOutputSchemaError,
  postSequenceResult,
  responseState,
  runAgenticPlaytest,
  schemaCorrectionMessage,
};
