'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { PNG } = require('pngjs');
const { SteppedBrowserSession } = require('../src/stepped-session');
const { runStep } = require('../src/step-runner');

const fixture = `<!doctype html><style>html,body{margin:0}canvas{display:block}</style><canvas width="640" height="360"></canvas><script>
const c=document.querySelector('canvas'), ctx=c.getContext('2d');
window.probe={frames:0, x:40, clicks:0, keyHeld:false, delta:0, timer:false, seed:Math.random()};
let last=performance.now();
setTimeout(()=>probe.timer=true,2000);
addEventListener('keydown',e=>{if(e.key==='ArrowRight')probe.keyHeld=true});
addEventListener('keyup',e=>{if(e.key==='ArrowRight')probe.keyHeld=false});
addEventListener('click',()=>probe.clicks++);
function draw(t){probe.frames++;probe.delta=Math.max(probe.delta,t-last);last=t;if(probe.keyHeld)probe.x+=2;
ctx.fillStyle='#123456';ctx.fillRect(0,0,640,360);ctx.fillStyle='red';ctx.fillRect(probe.x,80,35,35);requestAnimationFrame(draw)}
requestAnimationFrame(draw);
</script>`;

async function setup(t, record = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-stepped-'));
  const file = path.join(root, 'game.html');
  fs.writeFileSync(file, fixture);
  const config = { file, viewport: { width: 640, height: 360 }, record, waitAfterLoad: 50, stateExpression: 'window.probe' };
  const session = new SteppedBrowserSession(config, { runDir: path.join(root, 'run') });
  t.after(async () => { await session.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { root, session, config };
}

test('browser remains frozen across thinking; inputs, clocks and clean observations resume correctly', { timeout: 30000 }, async (t) => {
  const { root, session, config } = await setup(t);
  const initial = await session.state();
  const image = await session.screenshot(root, 'before');
  await delay(2200);
  const frozen = await session.state();
  assert.deepEqual(frozen.custom, initial.custom);
  const again = await session.screenshot(root, 'after-thinking');
  assert.deepEqual(fs.readFileSync(image), fs.readFileSync(again));
  const input = { action_name: 'move', duration: 300, actions: [{ type: 'key', start: 0, end: 250, key: 'ArrowRight' }] };
  await session.runActive(input, () => runStep({ input, config, browser: session, outputDir: root, nextStepIndex: 1, actionName: 'move' }));
  const final = await session.state();
  assert.equal(final.timing.paused, true);
  assert.equal(final.timing.gameplayTimeMs, 350);
  assert.ok(final.custom.x > initial.custom.x);
  assert.equal(final.custom.keyHeld, false);
  assert.equal(final.custom.timer, false);
  assert.ok(final.custom.delta < 1000, `rAF jumped by ${final.custom.delta}ms`);
  assert.equal(final.custom.seed, initial.custom.seed);
  const marked = await session.screenshot(root, 'moved');
  assert.equal(PNG.sync.read(fs.readFileSync(marked.replace('.grid.png', '.png'))).width, 640);
  assert.ok(PNG.sync.read(fs.readFileSync(marked)).width > 640);
});

test('same-session active recording excludes thinking and contains the action timeline', { timeout: 30000 }, async (t) => {
  const { session } = await setup(t, true);
  await delay(1200);
  await session.runActive({ action_name: 'click' }, async () => {
    session.recordInput({ phase: 'dispatch', type: 'click' });
    await session.click({ x: 100, y: 100, start: 0, end: 50, button: 'left' });
    await delay(300);
    return { duration: 350 };
  });
  await delay(1300);
  await session.runActive({ action_name: 'wait' }, async () => { await delay(300); return { duration: 300 }; });
  const result = await session.close();
  assert.ok(fs.statSync(result.video).size > 1000);
  const media = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', result.video], { encoding: 'utf8' }));
  const duration = Number(media.format.duration) * 1000;
  assert.ok(Math.abs(duration - result.durationMs) < 250, `video=${duration} timeline=${result.durationMs}`);
  assert.ok(duration < 2300, `thinking leaked into ${duration}ms video`);
  assert.equal(media.streams.length, 1);
  assert.equal(media.streams[0].width, 640);
  const timeline = JSON.parse(fs.readFileSync(result.timeline));
  assert.equal(timeline.segments.length, 2);
  assert.equal(timeline.segments[0].events[0].type, 'click');
  assert.ok(timeline.frames.length > 4);
});
