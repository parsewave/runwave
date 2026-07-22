const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_EDGE_FRAME_COUNT = 10;
const DEFAULT_SIMILARITY_THRESHOLD = 0.98;
const DEFAULT_PIXEL_TOLERANCE = 3;

function isRepeatedFrameRemovalEnabled(config = {}) {
  return Boolean(config.record || config.recordAudio) && config.repeatedFrameRemoval !== false;
}

function repeatedFrameRemovalOptions() {
  return {
    edgeFrameCount: DEFAULT_EDGE_FRAME_COUNT,
    similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    pixelTolerance: DEFAULT_PIXEL_TOLERANCE,
    comparisonWidth: 160,
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function spawnChecked(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...options,
    });
    const stderr = [];

    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') });
        return;
      }

      const tail = Buffer.concat(stderr).toString('utf8').trim().slice(-2000);
      reject(new Error(`${command} failed with ${signal || `exit code ${code}`}${tail ? `:\n${tail}` : ''}`));
    });
  });
}

function parseFrameMd5Line(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const parts = trimmed.split(',').map((part) => part.trim());
  const hash = parts[parts.length - 1];
  if (!/^[a-f0-9]{32}$/i.test(hash)) return null;

  return {
    streamIndex: Number(parts[0]),
    dts: Number(parts[1]),
    pts: Number(parts[2]),
    duration: Number(parts[3]),
    size: Number(parts[4]),
    hash: hash.toLowerCase(),
  };
}

function collectFrameHashes(inputPath, options = {}) {
  const ffmpegPath = options.ffmpegPath || 'ffmpeg';
  const args = [
    '-hide_banner',
    '-v',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-an',
    '-f',
    'framemd5',
    '-',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const frames = [];
    const stderr = [];
    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const frame = parseFrameMd5Line(line);
        if (frame) frames.push(frame);
      }
    });

    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (buffer) {
        const frame = parseFrameMd5Line(buffer);
        if (frame) frames.push(frame);
      }

      if (code === 0) {
        resolve(frames);
        return;
      }

      const tail = Buffer.concat(stderr).toString('utf8').trim().slice(-2000);
      reject(new Error(`${ffmpegPath} framemd5 failed with ${signal || `exit code ${code}`}${tail ? `:\n${tail}` : ''}`));
    });
  });
}

function findRepeatedFrameRemovalRanges(frames, options = {}) {
  const edgeFrameCount = Number(options.edgeFrameCount ?? DEFAULT_EDGE_FRAME_COUNT);
  if (!Number.isInteger(edgeFrameCount) || edgeFrameCount < 1) {
    throw new Error(`edgeFrameCount must be a positive integer, got ${options.edgeFrameCount}`);
  }

  const hashes = frames.map((frame) => (typeof frame === 'string' ? frame : frame.hash));
  const ranges = [];
  let runStart = 0;

  for (let index = 1; index <= hashes.length; index += 1) {
    if (index < hashes.length && hashes[index] === hashes[runStart]) continue;

    pushRemovalRangeForRun(ranges, runStart, index - 1, edgeFrameCount, { hash: hashes[runStart] });

    runStart = index;
  }

  return ranges;
}

function pushRemovalRangeForRun(ranges, runStart, runEnd, edgeFrameCount, extra = {}) {
  const runLength = runEnd - runStart + 1;
  const removeStart = runStart + edgeFrameCount;
  const removeEnd = runEnd - edgeFrameCount;

  if (removeStart <= removeEnd) {
    ranges.push({
      start: removeStart,
      end: removeEnd,
      removedFrames: removeEnd - removeStart + 1,
      runStart,
      runEnd,
      runLength,
      ...extra,
    });
  }
}

function normalizeSimilarityThreshold(value) {
  const threshold = Number(value ?? DEFAULT_SIMILARITY_THRESHOLD);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`similarityThreshold must be between 0 and 1, got ${value}`);
  }
  return threshold;
}

function comparisonSize(mediaInfo, options = {}) {
  const width = Number(mediaInfo.width);
  const height = Number(mediaInfo.height);
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    throw new Error(`could not determine video dimensions`);
  }

  const requestedWidth = Number(options.comparisonWidth ?? 160);
  const comparisonWidth = Math.max(1, Math.min(width, Math.round(requestedWidth)));
  const comparisonHeight = Math.max(1, Math.round(height * (comparisonWidth / width)));

  return {
    width: comparisonWidth,
    height: comparisonHeight,
    frameByteLength: comparisonWidth * comparisonHeight,
  };
}

function normalizePixelTolerance(value) {
  const tolerance = Number(value ?? DEFAULT_PIXEL_TOLERANCE);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new Error(`pixelTolerance must be between 0 and 255, got ${value}`);
  }
  return tolerance;
}

function frameSimilarity(a, b, options = {}) {
  if (a.length !== b.length) throw new Error(`cannot compare frames with different sizes`);

  const pixelTolerance = normalizePixelTolerance(options.pixelTolerance);
  let matchingPixels = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs(a[index] - b[index]) <= pixelTolerance) matchingPixels += 1;
  }

  return matchingPixels / a.length;
}

async function findSimilarFrameRemovalRanges(inputPath, options = {}) {
  const ffmpegPath = options.ffmpegPath || 'ffmpeg';
  const mediaInfo = options.mediaInfo || await readMediaInfo(inputPath, options);
  const edgeFrameCount = Number(options.edgeFrameCount ?? DEFAULT_EDGE_FRAME_COUNT);
  if (!Number.isInteger(edgeFrameCount) || edgeFrameCount < 1) {
    throw new Error(`edgeFrameCount must be a positive integer, got ${options.edgeFrameCount}`);
  }

  const similarityThreshold = normalizeSimilarityThreshold(options.similarityThreshold);
  const pixelTolerance = normalizePixelTolerance(options.pixelTolerance);
  const size = comparisonSize(mediaInfo, options);
  const args = [
    '-hide_banner',
    '-v',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    `scale=${size.width}:${size.height},format=gray`,
    '-f',
    'rawvideo',
    '-',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    const removalRanges = [];
    let buffered = Buffer.alloc(0);
    let anchor = null;
    let frameIndex = 0;
    let runStart = 0;
    let weakestSimilarity = 1;

    function finishRun(runEnd) {
      pushRemovalRangeForRun(removalRanges, runStart, runEnd, edgeFrameCount, {
        weakestSimilarity: Number(weakestSimilarity.toFixed(6)),
      });
    }

    function processFrame(frame) {
      if (!anchor) {
        anchor = Buffer.from(frame);
        frameIndex += 1;
        return;
      }

      const similarity = frameSimilarity(anchor, frame, { pixelTolerance });
      if (similarity >= similarityThreshold) {
        weakestSimilarity = Math.min(weakestSimilarity, similarity);
        frameIndex += 1;
        return;
      }

      finishRun(frameIndex - 1);
      anchor = Buffer.from(frame);
      runStart = frameIndex;
      weakestSimilarity = 1;
      frameIndex += 1;
    }

    child.stdout.on('data', (chunk) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      while (buffered.length >= size.frameByteLength) {
        processFrame(buffered.subarray(0, size.frameByteLength));
        buffered = buffered.subarray(size.frameByteLength);
      }
    });

    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const tail = Buffer.concat(stderr).toString('utf8').trim().slice(-2000);
        reject(new Error(`${ffmpegPath} raw frame decode failed with ${signal || `exit code ${code}`}${tail ? `:\n${tail}` : ''}`));
        return;
      }

      if (buffered.length) {
        reject(new Error(`raw frame decode ended with ${buffered.length} trailing bytes; expected whole ${size.frameByteLength}-byte frames`));
        return;
      }

      if (frameIndex > 0) finishRun(frameIndex - 1);
      resolve({
        frameCount: frameIndex,
        mediaInfo,
        removalRanges,
        detection: {
          mode: 'similarity',
          similarityThreshold,
          pixelTolerance,
          comparisonWidth: size.width,
          comparisonHeight: size.height,
          pixelFormat: 'gray',
        },
      });
    });
  });
}

function escapeSelectFunction(name, values) {
  return `${name}(${values.join('\\,')})`;
}

function buildVideoRemovalExpression(removalRanges) {
  return removalRanges
    .map((range) => escapeSelectFunction('between', ['n', range.start, range.end]))
    .join('+');
}

function buildVideoFilter(removalRanges, fps) {
  const safeFps = String(fps || '').trim();
  if (!safeFps || safeFps === '0/0') throw new Error(`invalid fps for setpts: ${fps}`);

  const setPts = `setpts=N/(${safeFps})/TB`;
  if (!removalRanges.length) return setPts;

  return `select=not(${buildVideoRemovalExpression(removalRanges)}),${setPts}`;
}

function fpsToNumber(fps) {
  const text = String(fps || '').trim();
  const match = text.match(/^(\d+)\/(\d+)$/);
  if (match) {
    const denominator = Number(match[2]);
    return denominator ? Number(match[1]) / denominator : NaN;
  }
  return Number(text);
}

function fixedSeconds(value) {
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
}

function buildAudioRemovalExpression(removalRanges, fps) {
  const fpsNumber = fpsToNumber(fps);
  if (!Number.isFinite(fpsNumber) || fpsNumber <= 0) {
    throw new Error(`invalid fps for audio trimming: ${fps}`);
  }

  return removalRanges
    .map((range) => {
      const start = fixedSeconds(range.start / fpsNumber);
      const end = fixedSeconds((range.end + 1) / fpsNumber);
      return `${escapeSelectFunction('gte', ['t', start])}*${escapeSelectFunction('lt', ['t', end])}`;
    })
    .join('+');
}

function buildAudioFilter(removalRanges, fps) {
  const setPts = 'asetpts=N/SR/TB';
  if (!removalRanges.length) return setPts;
  return `aselect=not(${buildAudioRemovalExpression(removalRanges, fps)}),${setPts}`;
}

function parseRate(rate) {
  const text = String(rate || '').trim();
  const match = text.match(/^(\d+)\/(\d+)$/);
  if (!match) return text;

  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!denominator) return '';
  return denominator === 1 ? String(numerator) : `${numerator}/${denominator}`;
}

async function readVideoFps(inputPath, options = {}) {
  const mediaInfo = await readMediaInfo(inputPath, options);
  return mediaInfo.fps;
}

async function readMediaInfo(inputPath, options = {}) {
  const ffprobePath = options.ffprobePath || 'ffprobe';
  const args = [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height,avg_frame_rate,r_frame_rate',
    '-of',
    'json',
    inputPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const tail = Buffer.concat(stderr).toString('utf8').trim().slice(-2000);
        reject(new Error(`${ffprobePath} failed with ${signal || `exit code ${code}`}${tail ? `:\n${tail}` : ''}`));
        return;
      }

      const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8'));
      const streams = parsed.streams || [];
      const videoStream = streams.find((stream) => stream.codec_type === 'video');
      const fps = parseRate(videoStream?.avg_frame_rate) || parseRate(videoStream?.r_frame_rate);
      if (!fps) reject(new Error(`could not determine video frame rate for ${inputPath}`));
      else {
        resolve({
          fps,
          width: videoStream.width,
          height: videoStream.height,
          hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
        });
      }
    });
  });
}

async function encodeWithoutRepeatedFrames(inputPath, outputPath, removalRanges, options = {}) {
  const ffmpegPath = options.ffmpegPath || 'ffmpeg';
  const mediaInfo = options.mediaInfo || await readMediaInfo(inputPath, options);
  const fps = options.fps || mediaInfo.fps;
  const videoFilter = buildVideoFilter(removalRanges, fps);
  const shouldIncludeAudio = options.includeAudio ?? mediaInfo.hasAudio;
  const outputExt = path.extname(outputPath).toLowerCase();
  const isMp4 = outputExt === '.mp4' || outputExt === '.m4v' || outputExt === '.mov';
  const videoCodec = options.videoCodec || (isMp4 ? 'libx264' : 'libvpx');
  ensureDir(path.dirname(outputPath));

  const args = [
    '-hide_banner',
    '-y',
    '-v',
    options.logLevel || 'error',
    '-i',
    inputPath,
  ];

  if (shouldIncludeAudio && mediaInfo.hasAudio) {
    args.push(
      '-filter_complex',
      `[0:v:0]${videoFilter}[v];[0:a:0]${buildAudioFilter(removalRanges, fps)}[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]'
    );
  } else {
    args.push(
      '-map',
      '0:v:0',
      '-an',
      '-vf',
      videoFilter
    );
  }

  args.push(
    '-fps_mode',
    'cfr',
    '-r',
    fps,
    '-c:v',
    videoCodec
  );

  if (videoCodec === 'libvpx') {
    args.push(
      '-deadline',
      options.deadline || 'realtime',
      '-cpu-used',
      String(options.cpuUsed ?? 8),
      '-crf',
      String(options.crf ?? 30),
      '-b:v',
      String(options.videoBitrate ?? '0')
    );
  } else if (videoCodec === 'libx264') {
    args.push(
      '-preset',
      options.preset || 'veryfast',
      '-crf',
      String(options.crf ?? 23),
      '-pix_fmt',
      'yuv420p'
    );
  } else {
    args.push(
      '-crf',
      String(options.crf ?? 30)
    );
  }

  if (shouldIncludeAudio && mediaInfo.hasAudio) {
    args.push(
      '-c:a',
      options.audioCodec || (isMp4 ? 'aac' : 'libopus'),
      '-b:a',
      String(options.audioBitrate || '64k')
    );
  }

  args.push(
    outputPath,
  );

  await spawnChecked(ffmpegPath, args);
  return {
    outputPath,
    fps,
    videoFilter,
  };
}

async function removeRepeatedFrames(inputPath, outputPath, options = {}) {
  const analysis = await findSimilarFrameRemovalRanges(inputPath, options);
  const removalRanges = analysis.removalRanges;
  const removedFrameCount = removalRanges.reduce((sum, range) => sum + range.removedFrames, 0);
  const encode = await encodeWithoutRepeatedFrames(inputPath, outputPath, removalRanges, {
    ...options,
    mediaInfo: analysis.mediaInfo,
  });

  return {
    inputPath,
    outputPath,
    frameCount: analysis.frameCount,
    keptFrameCount: analysis.frameCount - removedFrameCount,
    removedFrameCount,
    removalRanges,
    detection: analysis.detection,
    fps: encode.fps,
    videoFilter: encode.videoFilter,
  };
}

function rawVideoPath(videoPath, options = {}) {
  const parsed = path.parse(videoPath);
  const suffix = options.rawSuffix || '_raw';
  const preferred = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
  if (!fs.existsSync(preferred)) return preferred;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}${suffix}-${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`could not find available raw video name for ${videoPath}`);
}

async function removeRepeatedFramesInPlace(videoPath, options = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return null;
  }

  const rawPath = options.rawPath || rawVideoPath(videoPath, options);
  fs.renameSync(videoPath, rawPath);

  try {
    const summary = await removeRepeatedFrames(rawPath, videoPath, options);
    return {
      video: videoPath,
      rawVideo: rawPath,
      repeatedFrameRemoval: summary,
    };
  } catch (error) {
    if (!fs.existsSync(videoPath) && fs.existsSync(rawPath)) {
      fs.renameSync(rawPath, videoPath);
    }
    throw error;
  }
}

function printUsage() {
  console.error('Usage: node runwave/controller/bin/remove-repeated-frames.js <input-video> <output-video>');
}

async function main(argv) {
  const args = [...argv];
  const inputPath = args.shift();
  const outputPath = args.shift();
  if (!inputPath || !outputPath) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (args.length) {
    throw new Error(`unknown argument: ${args[0]}`);
  }

  const summary = await removeRepeatedFrames(inputPath, outputPath, repeatedFrameRemovalOptions());
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_EDGE_FRAME_COUNT,
  DEFAULT_PIXEL_TOLERANCE,
  DEFAULT_SIMILARITY_THRESHOLD,
  buildAudioFilter,
  buildVideoFilter,
  collectFrameHashes,
  encodeWithoutRepeatedFrames,
  findRepeatedFrameRemovalRanges,
  findSimilarFrameRemovalRanges,
  frameSimilarity,
  isRepeatedFrameRemovalEnabled,
  main,
  parseFrameMd5Line,
  rawVideoPath,
  readMediaInfo,
  readVideoFps,
  repeatedFrameRemovalOptions,
  removeRepeatedFrames,
  removeRepeatedFramesInPlace,
};
