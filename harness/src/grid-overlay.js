const fs = require('fs');
const { PNG } = require('pngjs');

const FONT = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  x: ['101', '101', '010', '101', '101'],
  y: ['101', '101', '111', '001', '111'],
  '=': ['000', '111', '000', '111', '000'],
  '-': ['000', '000', '111', '000', '000'],
};

function blendChannel(base, overlay, alpha) {
  return Math.round(overlay * alpha + base * (1 - alpha));
}

function blendPixel(png, x, y, color) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  const alpha = color[3];
  png.data[idx] = blendChannel(png.data[idx], color[0], alpha);
  png.data[idx + 1] = blendChannel(png.data[idx + 1], color[1], alpha);
  png.data[idx + 2] = blendChannel(png.data[idx + 2], color[2], alpha);
  png.data[idx + 3] = 255;
}

function fillRect(png, x, y, width, height, color) {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(png.width, Math.round(x + width));
  const bottom = Math.min(png.height, Math.round(y + height));
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      blendPixel(png, px, py, color);
    }
  }
}

function drawVerticalLine(png, x, color) {
  const px = Math.round(x);
  for (let y = 0; y < png.height; y += 1) blendPixel(png, px, y, color);
}

function drawHorizontalLine(png, y, color) {
  const py = Math.round(y);
  for (let x = 0; x < png.width; x += 1) blendPixel(png, x, py, color);
}

function drawRect(png, x, y, width, height, color, lineWidth = 1) {
  for (let offset = 0; offset < lineWidth; offset += 1) {
    for (let px = x + offset; px < x + width - offset; px += 1) {
      blendPixel(png, px, y + offset, color);
      blendPixel(png, px, y + height - 1 - offset, color);
    }
    for (let py = y + offset; py < y + height - offset; py += 1) {
      blendPixel(png, x + offset, py, color);
      blendPixel(png, x + width - 1 - offset, py, color);
    }
  }
}

function textWidth(text, scale) {
  return Array.from(text).reduce((width, char) => {
    const glyph = FONT[char] || FONT['-'];
    return width + glyph[0].length * scale + scale;
  }, 0);
}

function drawText(png, text, x, y, color, scale = 2) {
  let cursor = x;
  for (const char of Array.from(text)) {
    const glyph = FONT[char] || FONT['-'];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] !== '1') continue;
        fillRect(png, cursor + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += glyph[0].length * scale + scale;
  }
}

function drawLabel(png, text, x, y) {
  const scale = 2;
  const padding = 4;
  const width = textWidth(text, scale) + padding * 2;
  const height = 5 * scale + padding * 2;
  fillRect(png, x, y, width, height, [0, 0, 0, 0.62]);
  drawText(png, text, x + padding, y + padding, [255, 255, 255, 0.9], scale);
}

function drawCoordinateGridOnScreenshot(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const xStep = Math.max(80, Math.floor(png.width / 8));
  const yStep = Math.max(60, Math.floor(png.height / 8));

  for (let x = 0; x < png.width; x += xStep) {
    drawVerticalLine(png, x, [86, 228, 255, 0.42]);
    drawLabel(png, `x=${x}`, x + 2, 2);
  }
  for (let y = 0; y < png.height; y += yStep) {
    drawHorizontalLine(png, y, [243, 221, 91, 0.42]);
    drawLabel(png, `y=${y}`, 2, y + 2);
  }

  drawRect(png, 1, 1, png.width - 2, png.height - 2, [255, 255, 255, 0.75], 2);
  fs.writeFileSync(file, PNG.sync.write(png));
}

function drawMarkGridOnScreenshot(file, config = {}) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const rows = Math.max(1, Math.round(Number(config.markGridRows ?? config.gridRows ?? 8)));
  const cols = Math.max(1, Math.round(Number(config.markGridCols ?? config.gridCols ?? 8)));
  const cellWidth = png.width / cols;
  const cellHeight = png.height / rows;
  const lineColor = [255, 36, 36, 0.48];
  const labelBg = [0, 0, 0, 0.68];
  const labelText = [255, 255, 255, 0.94];

  for (let col = 0; col <= cols; col += 1) {
    drawVerticalLine(png, col * cellWidth, lineColor);
  }
  for (let row = 0; row <= rows; row += 1) {
    drawHorizontalLine(png, row * cellHeight, lineColor);
  }

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const id = row * cols + col;
      const text = String(id);
      const scale = 2;
      const padding = 4;
      const labelWidth = textWidth(text, scale) + padding * 2;
      const labelHeight = 5 * scale + padding * 2;
      const x = Math.round(col * cellWidth + (cellWidth - labelWidth) / 2);
      const y = Math.round(row * cellHeight + (cellHeight - labelHeight) / 2);
      fillRect(png, x, y, labelWidth, labelHeight, labelBg);
      drawText(png, text, x + padding, y + padding, labelText, scale);
    }
  }

  drawRect(png, 1, 1, png.width - 2, png.height - 2, [255, 255, 255, 0.75], 2);
  fs.writeFileSync(file, PNG.sync.write(png));
}

function drawGridOnScreenshot(file, config = {}) {
  if (config.gridOverlay === 'coordinate') {
    drawCoordinateGridOnScreenshot(file);
    return;
  }
  drawMarkGridOnScreenshot(file, config);
}

module.exports = {
  drawGridOnScreenshot,
  drawMarkGridOnScreenshot,
  drawCoordinateGridOnScreenshot,
};
