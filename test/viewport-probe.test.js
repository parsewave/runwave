'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { chooseViewportFromProbe } = require('../ops/remote/run-playtest');

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
