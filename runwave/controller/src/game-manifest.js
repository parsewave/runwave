'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readGameManifest(gameDir) {
  const file = gameDir && path.join(gameDir, 'webgame.json');
  if (!file || !fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('webgame.json must be an object');
  const controls = raw.controls ?? [];
  if (!Array.isArray(controls) || controls.length > 100) throw new Error('manifest controls must be an array of at most 100 controls');
  const names = new Set();
  for (const control of controls) {
    if (!control || !/^[a-zA-Z][\w-]{0,63}$/.test(control.name) || names.has(control.name)) throw new Error('manifest control names must be unique identifiers');
    names.add(control.name);
    if (!['key', 'mouse_click', 'mouse_move', 'wait'].includes(control.type)) throw new Error(`unsupported manifest control: ${control.type}`);
    if (control.type === 'key' && (typeof control.key !== 'string' || !control.key.trim())) throw new Error('key control needs a key');
    for (const field of control.type === 'mouse_click' ? ['x', 'y'] : control.type === 'mouse_move' ? ['dx', 'dy'] : []) {
      if (!Number.isFinite(control[field])) throw new Error(`manifest control needs finite ${field}`);
      if (['x', 'y'].includes(field) && (control[field] < 0 || control[field] > 1)) throw new Error('manifest click coordinates must be normalized 0..1');
    }
    if (control.button !== undefined && !['left', 'middle', 'right'].includes(control.button)) throw new Error('invalid manifest mouse button');
    if (control.duration_ms !== undefined && (!Number.isFinite(control.duration_ms) || control.duration_ms <= 0 || control.duration_ms > 8000)) throw new Error('control duration must be 1..8000ms');
  }
  const config = { publicControls: controls.map(({ name, type, key, x, y, dx, dy, button, description, duration_ms }) =>
    ({ name, type, key, x, y, dx, dy, button, description, duration_ms })) };
  for (const [source, target] of Object.entries({ canvas_selector: 'canvasSelector', ready_selector: 'readySelector', ready_check_script: 'readyCheckScript' })) {
    if (raw[source] !== undefined) {
      if (typeof raw[source] !== 'string' || !raw[source]) throw new Error(`manifest ${source} must be a string`);
      config[target] = raw[source];
    }
  }
  for (const [source, target] of Object.entries({ ready_timeout_ms: 'readyTimeoutMs', ready_settle_ms: 'readySettleMs', action_window_ms: 'actionWindowMs' })) {
    if (raw[source] !== undefined) {
      if (!Number.isFinite(raw[source]) || raw[source] < 0 || raw[source] > 120000) throw new Error(`invalid manifest ${source}`);
      config[target] = raw[source];
    }
  }
  if (raw.clock?.post_action_settle_ms !== undefined) config.postActionSettleMs = raw.clock.post_action_settle_ms;
  return config;
}

function namedControlStep(input, controls, canvas, defaultDuration = 250) {
  const control = controls?.find((item) => item.name === input.control);
  if (!control) throw new Error(`unknown control: ${input.control}`);
  const duration = input.duration ?? control.duration_ms ?? defaultDuration;
  if (!Number.isFinite(duration) || duration < 1 || duration > 8000) throw new Error('control duration must be 1..8000ms');
  let actions = [];
  if (control.type === 'key') actions = [{ type: 'key', start: 0, end: duration, key: control.key }];
  if (control.type === 'mouse_move') actions = [{ type: 'view_move', start: 0, end: duration, dx: control.dx, dy: control.dy, steps: 1 }];
  if (control.type === 'mouse_click') {
    if (!canvas) throw new Error('manifest click needs a visible canvas');
    actions = [{ type: 'click', start: 0, end: Math.min(50, duration), button: control.button || 'left',
      x: canvas.x + control.x * canvas.width, y: canvas.y + control.y * canvas.height }];
  }
  return { action: 'step', action_name: input.action_name, session_id: input.session_id,
    name: control.name, duration, actions, autoCaptures: false };
}

module.exports = { readGameManifest, namedControlStep };
