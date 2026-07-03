'use strict';

const path = require('path');
const { normalizeDecision } = require('./action-parser');
const { AgentRecorder } = require('./history');
const { chatCompletion, dataUrl } = require('./model-client');
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

async function decideNextAction({ job, screenshot, state, history, elapsedMs, maxMs, modelClient }) {
  if (!screenshot) throw new Error('agent cannot decide without a screenshot');
  const viewport = viewportFor(job);
  const prompt = buildPlaytesterPrompt({ job, elapsedMs, maxMs, viewport, state, history });
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
    maxTokens: Number(job.agentMaxTokens || 1200),
    timeoutMs: Number(job.agentTimeoutMs || 120000),
    temperature: Number(job.agentTemperature ?? 0.2),
  });

  return {
    decision: normalizeDecision(result.json, {
      viewport,
      maxDurationMs: Number(job.agentMaxActionMs || 8000),
    }),
    model: result.model,
    usage: result.usage,
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

    const { decision, model, usage } = await decideNextAction({
      job,
      screenshot,
      state,
      history,
      elapsedMs,
      maxMs,
      modelClient,
    });

    const duration = Math.max(100, Math.min(decision.durationMs, remainingMs));
    step += 1;
    const action = {
      action: 'step',
      action_name: `agent-step-${String(step).padStart(3, '0')}`,
      duration,
      commands: decision.commands,
      clicks: decision.clicks,
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
      usage,
    });
    log('agent.action', { step, duration, commandCount: action.commands.length, clickCount: action.clicks.length });

    lastResponse = await runAction(action);
    history.push({
      step,
      summary: decision.summary,
      rationale: decision.rationale,
      commands: decision.commands,
      clicks: decision.clicks,
    });

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
  latestScreenshot,
  responseState,
  runAgenticPlaytest,
};
