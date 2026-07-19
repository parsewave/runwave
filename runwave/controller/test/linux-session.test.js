const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LinuxSession,
  buttonToXdotool,
  displayCaptureEnv,
  displayCaptureGeometry,
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
      launchSettleMs: 12000,
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
      launchSettleMs: 12000,
      resizeWindow: true,
    }
  );
});

test('linux launch config defaults game directories to start.sh', () => {
  assert.deepEqual(
    linuxLaunchConfig({
      gameDir: '/tmp/native-game',
    }),
    {
      command: 'bash',
      args: ['start.sh'],
      cwd: '/tmp/native-game',
      env: null,
      windowId: null,
      windowTitle: null,
      windowClass: null,
      windowWaitMs: 15000,
      launchSettleMs: 30000,
      resizeWindow: true,
    }
  );
});

test('linux display capture geometry uses viewport and display origin', () => {
  assert.deepEqual(
    displayCaptureGeometry(
      { viewport: { width: 1280, height: 720 }, videoSource: ':99+10,20' },
      { DISPLAY: ':88' }
    ),
    { displayName: ':99', x: 10, y: 20, width: 1280, height: 720 }
  );
});

test('linux display capture env gives start.sh a generic size hint', () => {
  assert.deepEqual(displayCaptureEnv({ x: 10, y: 20, width: 1280, height: 720 }), {
    RUNWAVE_VIEWPORT_WIDTH: '1280',
    RUNWAVE_VIEWPORT_HEIGHT: '720',
    RUNWAVE_CAPTURE_X: '10',
    RUNWAVE_CAPTURE_Y: '20',
    RUNWAVE_CAPTURE_WIDTH: '1280',
    RUNWAVE_CAPTURE_HEIGHT: '720',
  });
});

test('linux screen points are display-relative, not window-relative', () => {
  const session = new LinuxSession(
    { viewport: { width: 1280, height: 720 }, videoSource: ':99+10,20' },
    { runDir: '/tmp/runwave-test' }
  );
  session.geometry = { id: '123', x: 90, y: 51, width: 1099, height: 618 };
  session.captureGeometry = displayCaptureGeometry(session.config, { DISPLAY: ':99' });

  assert.deepEqual(session.screenPoint({ x: 100, y: 50 }), { x: 110, y: 70 });
});

test('linux window fitting moves and resizes toward the display capture area', () => {
  const calls = [];
  const session = new LinuxSession(
    { viewport: { width: 1280, height: 720 }, videoSource: ':99+10,20' },
    { runDir: '/tmp/runwave-test' }
  );
  session.windowId = '123';
  session.geometry = { id: '123', x: 90, y: 51, width: 1099, height: 618 };
  session.captureGeometry = displayCaptureGeometry(session.config, { DISPLAY: ':99' });
  session.xdotool = (args) => {
    calls.push(args);
    return '';
  };
  session.windowGeometry = () => ({ id: '123', x: 10, y: 20, width: 1280, height: 720 });

  assert.equal(session.fitWindowToCapture(), true);
  assert.deepEqual(calls, [
    ['windowmove', '123', '10', '20'],
    ['windowsize', '123', '1280', '720'],
  ]);
  assert.deepEqual(session.geometry, { id: '123', x: 10, y: 20, width: 1280, height: 720 });

  calls.length = 0;
  assert.equal(session.fitWindowToCapture(), false);
  assert.deepEqual(calls, []);
});

test('linux state keeps capture viewport separate from focused window geometry', async () => {
  const session = new LinuxSession(
    { viewport: { width: 1280, height: 720 }, videoSource: ':99+0,0' },
    { runDir: '/tmp/runwave-test' }
  );
  session.windowId = '123';
  session.captureGeometry = displayCaptureGeometry(session.config, { DISPLAY: ':99' });
  session.currentWindowGeometry = () => ({ id: '123', x: 90, y: 51, width: 1099, height: 618 });

  assert.deepEqual(await session.state(), {
    display: ':99',
    viewport: { width: 1280, height: 720 },
    capture: { x: 0, y: 0, width: 1280, height: 720 },
    window: { id: '123', x: 90, y: 51, width: 1099, height: 618 },
    process: null,
  });
});

test('linux drag reports that drag is unavailable for the session', async () => {
  const session = new LinuxSession(
    { viewport: { width: 1280, height: 720 } },
    { runDir: '/tmp/runwave-test' }
  );

  await assert.rejects(
    () => session.drag({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, button: 'left' }),
    /drag action is not available for this game session/
  );
});

test('linux gstreamer screenshot args can capture a full display viewport', () => {
  const args = gstScreenshotArgs(
    { viewport: { width: 1280, height: 720 } },
    '/tmp/shot.png',
    { x: 0, y: 0, width: 1280, height: 720 },
    { DISPLAY: ':99' }
  );

  assert.ok(args.includes('ximagesrc'));
  assert.ok(args.includes('display-name=:99'));
  assert.ok(args.includes('startx=0'));
  assert.ok(args.includes('starty=0'));
  assert.ok(args.includes('endx=1279'));
  assert.ok(args.includes('endy=719'));
  assert.ok(args.includes('pngenc'));
  assert.ok(args.includes('location=/tmp/shot.png'));
});
