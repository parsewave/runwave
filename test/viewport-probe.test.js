'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  chooseViewportFromProbe,
  normalizeVlmViewportChoice,
  viewportCandidatesFromProbe,
} = require('../ops/remote/run-playtest');

test('viewport probe fits a small canvas game', () => {
  const result = chooseViewportFromProbe({
    viewport: { width: 1280, height: 720 },
    canvases: [{ index: 0, x: 8, y: 8, width: 640, height: 480 }],
    scrollHeight: 720,
  });

  assert.equal(result.reason, 'fit-largest-canvas');
  assert.deepEqual(result.viewport, { width: 656, height: 496 });
});

test('viewport probe keeps a full viewport canvas game', () => {
  const result = chooseViewportFromProbe({
    viewport: { width: 1280, height: 720 },
    canvases: [{ index: 0, x: 0, y: 0, width: 1280, height: 720 }],
    scrollHeight: 720,
  });

  assert.equal(result.reason, 'canvas-covers-viewport');
  assert.deepEqual(result.viewport, { width: 1280, height: 720 });
});

test('viewport probe grows height for tall non-canvas games', () => {
  const result = chooseViewportFromProbe({
    viewport: { width: 1280, height: 720 },
    canvases: [],
    scrollHeight: 860,
    visibleBounds: { left: 390, top: 80, right: 890, bottom: 840, width: 500, height: 760 },
  });

  assert.equal(result.reason, 'fit-page-height');
  assert.deepEqual(result.viewport, { width: 1280, height: 860 });
});

test('viewport probe fits 2048-style tall pages without clipping the bottom', () => {
  const result = chooseViewportFromProbe({
    viewport: { width: 1280, height: 720 },
    canvases: [],
    scrollHeight: 1220,
    visibleBounds: { left: 390, top: 80, right: 890, bottom: 1140, width: 500, height: 1060 },
  });

  assert.equal(result.reason, 'fit-page-height');
  assert.deepEqual(result.viewport, { width: 1280, height: 1220 });
});

test('viewport preflight candidates include compact content and page-fit options', () => {
  const candidates = viewportCandidatesFromProbe({
    viewport: { width: 1280, height: 720 },
    canvases: [],
    scrollHeight: 1220,
    visibleBounds: { left: 390, top: 80, right: 890, bottom: 1140, width: 500, height: 1060 },
  });

  assert.ok(candidates.some((candidate) => candidate.viewport.width === 1280 && candidate.viewport.height === 1220));
  assert.ok(candidates.some((candidate) => candidate.id === 'content-fit' && candidate.viewport.width < 1280));
});

test('viewport preflight candidates include canvas-fit for small canvas games', () => {
  const candidates = viewportCandidatesFromProbe({
    viewport: { width: 1280, height: 720 },
    canvases: [{ index: 0, x: 8, y: 8, width: 640, height: 480 }],
    scrollHeight: 720,
    visibleBounds: { left: 8, top: 8, right: 648, bottom: 488, width: 640, height: 480 },
  });

  assert.ok(candidates.some((candidate) => candidate.viewport.width === 656 && candidate.viewport.height === 496));
});

test('normalizes VLM viewport choices to known candidates', () => {
  const candidates = [
    { id: 'default', viewport: { width: 1280, height: 720 }, reason: 'default' },
    { id: 'canvas-fit', viewport: { width: 656, height: 496 }, reason: 'canvas' },
  ];
  const fallback = { viewport: { width: 1280, height: 720 }, reason: 'default', source: 'probe' };
  const choice = normalizeVlmViewportChoice(
    { choice_id: 'canvas-fit', reason: 'best canvas framing', confidence: 0.9 },
    candidates,
    fallback
  );

  assert.deepEqual(choice.viewport, { width: 656, height: 496 });
  assert.equal(choice.selectedCandidateId, 'canvas-fit');
  assert.equal(choice.source, 'vlm');
});
