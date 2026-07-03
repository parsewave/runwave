async function readDefaultState(page) {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas')).map((canvas, index) => {
      const rect = canvas.getBoundingClientRect();
      return {
        index,
        width: canvas.width,
        height: canvas.height,
        clientWidth: Math.round(rect.width),
        clientHeight: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
      };
    });
    const active = document.activeElement;
    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      activeElement: active
        ? {
            tagName: active.tagName,
            id: active.id || null,
            className: typeof active.className === 'string' ? active.className : null,
          }
        : null,
      pointerLockElement: document.pointerLockElement
        ? {
            tagName: document.pointerLockElement.tagName,
            id: document.pointerLockElement.id || null,
            className:
              typeof document.pointerLockElement.className === 'string' ? document.pointerLockElement.className : null,
          }
        : null,
      canvases,
      timestamp: new Date().toISOString(),
    };
  });
}

async function readCustomState(page, expression) {
  if (!expression) return null;
  return page.evaluate((source) => {
    const evaluated = (0, eval)(`(${source})`);
    return typeof evaluated === 'function' ? evaluated() : evaluated;
  }, expression);
}

async function readPageState(page, expression) {
  const generic = await readDefaultState(page);
  if (!expression) return { generic };

  try {
    return {
      generic,
      custom: await readCustomState(page, expression),
    };
  } catch (error) {
    return {
      generic,
      customError: error.message,
    };
  }
}

module.exports = {
  readPageState,
};
