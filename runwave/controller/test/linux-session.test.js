const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buttonToXdotool,
  gstScreenshotArgs,
  keyToXdotool,
  linuxLaunchConfig,
  parseWindowGeometry,
  parseWindowIds,
} = require('../src/linux-session');

test('linux key mapping accepts common RunWave key names', () => {
  assert.equal(keyToXdotool('ArrowLeft'), 'Left');
  assert.equal(keyToXdotool('ArrowRight'), 'Right');
  assert.equal(keyToXdotool('Space'), 'space');
  assert.equal(keyToXdotool('Enter'), 'Return');
  assert.equal(keyToXdotool('KeyW'), 'w');
  assert.equal(keyToXdotool('Digit7'), '7');
  assert.equal(keyToXdotool('F5'), 'F5');
});

test('linux mouse button mapping rejects unknown buttons', () => {
  assert.equal(buttonToXdotool('left'), '1');
  assert.equal(buttonToXdotool('middle'), '2');
  assert.equal(buttonToXdotool('right'), '3');
  assert.throws(() => buttonToXdotool('side'), /unsupported mouse button/);
});

test('linux window helpers parse xdotool output', () => {
  assert.deepEqual(parseWindowIds('123\n456 789\n'), ['123', '456', '789']);
  assert.deepEqual(
    parseWindowGeometry('WINDOW=123\nX=10\nY=20\nWIDTH=1280\nHEIGHT=720\nSCREEN=0\n'),
    { id: '123', x: 10, y: 20, width: 1280, height: 720 }
  );
  assert.throws(() => parseWindowGeometry('WINDOW=1\nWIDTH=0\n'), /could not parse/);
});

test('linux launch config reads command, args, cwd, and window selectors', () => {
  assert.deepEqual(
    linuxLaunchConfig({
      command: './game',
      args: ['--windowed', '--safe'],
      cwd: '/tmp/game',
      windowTitle: 'Game',
      windowClass: 'GameClass',
      windowWaitMs: 25000,
    }),
    {
      command: './game',
      args: ['--windowed', '--safe'],
      cwd: '/tmp/game',
      env: null,
      windowId: null,
      windowTitle: 'Game',
      windowClass: 'GameClass',
      windowWaitMs: 25000,
      resizeWindow: true,
    }
  );
});

test('linux gstreamer screenshot args crop the selected X11 window', () => {
  const args = gstScreenshotArgs(
    { viewport: { width: 1280, height: 720 } },
    '/tmp/shot.png',
    { x: 12, y: 34, width: 640, height: 480 },
    { DISPLAY: ':99' }
  );

  assert.ok(args.includes('ximagesrc'));
  assert.ok(args.includes('display-name=:99'));
  assert.ok(args.includes('startx=12'));
  assert.ok(args.includes('starty=34'));
  assert.ok(args.includes('endx=651'));
  assert.ok(args.includes('endy=513'));
  assert.ok(args.includes('pngenc'));
  assert.ok(args.includes('location=/tmp/shot.png'));
});
