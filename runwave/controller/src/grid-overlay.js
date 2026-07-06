const fs = require('fs');
const { PNG } = require('pngjs');
const { markGridFromConfig } = require('../../protocol/src/mark-grid');

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

function drawVerticalSegment(png, x, top, bottom, color) {
  const px = Math.round(x);
  const start = Math.max(0, Math.round(top));
  const end = Math.min(png.height - 1, Math.round(bottom));
  for (let y = start; y <= end; y += 1) blendPixel(png, px, y, color);
}

function drawHorizontalSegment(png, y, left, right, color) {
  const py = Math.round(y);
  const start = Math.max(0, Math.round(left));
  const end = Math.min(png.width - 1, Math.round(right));
  for (let x = start; x <= end; x += 1) blendPixel(png, x, py, color);
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

function copyImage(source, target, offsetX, offsetY) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sourceIndex = (source.width * y + x) << 2;
      const targetIndex = (target.width * (y + offsetY) + x + offsetX) << 2;
      target.data[targetIndex] = source.data[sourceIndex];
      target.data[targetIndex + 1] = source.data[sourceIndex + 1];
      target.data[targetIndex + 2] = source.data[sourceIndex + 2];
      target.data[targetIndex + 3] = source.data[sourceIndex + 3];
    }
  }
}

function fillImage(png, color) {
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = color[3];
    }
  }
}

function labelMetrics(text, scale, padding) {
  return {
    width: textWidth(text, scale) + padding * 2,
    height: 5 * scale + padding * 2,
  };
}

function gridLabelStyle(grid, sourceWidth, sourceHeight) {
  const maxLabel = String(Math.max(grid.rows - 1, grid.cols - 1));
  const minCell = Math.min(sourceWidth / grid.cols, sourceHeight / grid.rows);
  const scale = minCell < textWidth(maxLabel, 2) + 4 ? 1 : 2;
  const padding = scale === 1 ? 1 : 2;
  const metrics = labelMetrics(maxLabel, scale, padding);
  const margin = Math.max(24, metrics.width + 8, metrics.height + 8);
  return { scale, padding, margin };
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
  const source = PNG.sync.read(fs.readFileSync(file));
  const grid = markGridFromConfig(config);
  const { scale, padding, margin } = gridLabelStyle(grid, source.width, source.height);
  const png = new PNG({ width: source.width + margin * 2, height: source.height + margin * 2 });
  fillImage(png, [18, 18, 18, 255]);
  copyImage(source, png, margin, margin);

  const rows = grid.rows;
  const cols = grid.cols;
  const cellWidth = source.width / cols;
  const cellHeight = source.height / rows;
  const gameLeft = margin;
  const gameTop = margin;
  const gameRight = margin + source.width;
  const gameBottom = margin + source.height;
  const lineColor = [255, 36, 36, 0.18];
  const labelBg = [0, 0, 0, 0.3];
  const labelText = [255, 255, 255, 0.86];
  const borderColor = [255, 255, 255, 0.38];

  for (let col = 0; col <= cols; col += 1) {
    drawVerticalSegment(png, gameLeft + col * cellWidth, gameTop, gameBottom, lineColor);
  }
  for (let row = 0; row <= rows; row += 1) {
    drawHorizontalSegment(png, gameTop + row * cellHeight, gameLeft, gameRight, lineColor);
  }

  for (let col = 0; col < cols; col += 1) {
    const text = String(col);
    const metrics = labelMetrics(text, scale, padding);
    const x = Math.round(gameLeft + col * cellWidth + (cellWidth - metrics.width) / 2);
    const topY = Math.round((margin - metrics.height) / 2);
    const bottomY = Math.round(gameBottom + (margin - metrics.height) / 2);
    fillRect(png, x, topY, metrics.width, metrics.height, labelBg);
    drawText(png, text, x + padding, topY + padding, labelText, scale);
    fillRect(png, x, bottomY, metrics.width, metrics.height, labelBg);
    drawText(png, text, x + padding, bottomY + padding, labelText, scale);
  }

  for (let row = 0; row < rows; row += 1) {
    const text = String(row);
    const metrics = labelMetrics(text, scale, padding);
    const y = Math.round(gameTop + row * cellHeight + (cellHeight - metrics.height) / 2);
    const leftX = Math.round((margin - metrics.width) / 2);
    const rightX = Math.round(gameRight + (margin - metrics.width) / 2);
    fillRect(png, leftX, y, metrics.width, metrics.height, labelBg);
    drawText(png, text, leftX + padding, y + padding, labelText, scale);
    fillRect(png, rightX, y, metrics.width, metrics.height, labelBg);
    drawText(png, text, rightX + padding, y + padding, labelText, scale);
  }

  drawRect(png, gameLeft, gameTop, source.width, source.height, borderColor, 1);
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
