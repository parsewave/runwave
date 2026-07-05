async function readDefaultState(page) {
  return page.evaluate(() => {
    const webglRenderer = () => {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl') || canvas.getContext('webgl2');
        if (!gl) return { supported: false };
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          supported: true,
          version: gl.getParameter(gl.VERSION),
          shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          vendor: gl.getParameter(gl.VENDOR),
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
        };
      } catch (error) {
        return {
          supported: false,
          error: error.message,
        };
      }
    };
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
      webgl: webglRenderer(),
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
