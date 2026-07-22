const fs = require('fs');
const path = require('path');
const { removeRepeatedFrames } = require('../src/repeated-frame-remover');

const SOURCE_DIRS = [
  '/Users/plato/code/mm-sapphire/cruft/af4809-playtests/videos',
  '/Users/plato/code/mm-sapphire/cruft/pr501-playtests/videos',
];

const OUTPUT_ROOT = path.resolve(__dirname, '..', '..', 'cruft', 'repeated-frame-removal-examples');
const SIMILARITY_THRESHOLD = 0.98;
const EDGE_FRAME_COUNT = 10;
const CONCURRENCY = Number(process.env.REPEATED_FRAME_REMOVAL_CONCURRENCY || 4);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'video';
}

function listSourceVideos() {
  return SOURCE_DIRS.flatMap((dir) => {
    const group = safeName(path.basename(path.dirname(dir)));
    return fs.readdirSync(dir)
      .filter((entry) => /\.(webm|mp4|mov|mkv)$/i.test(entry))
      .sort()
      .map((entry) => ({
        group,
        name: path.basename(entry, path.extname(entry)),
        ext: path.extname(entry),
        sourcePath: path.join(dir, entry),
      }));
  });
}

function elapsedMs(startedAt) {
  return Number((process.hrtime.bigint() - startedAt) / 1000000n);
}

async function processVideo(video) {
  const startedAt = process.hrtime.bigint();
  const videoDir = ensureDir(path.join(OUTPUT_ROOT, `${video.group}-${safeName(video.name)}`));
  const inputPath = path.join(videoDir, `input${video.ext}`);
  const outputPath = path.join(videoDir, 'output.mp4');
  const reportPath = path.join(videoDir, 'report.json');

  fs.copyFileSync(video.sourcePath, inputPath);
  console.log(`Processing ${video.group}/${video.name}${video.ext}`);
  const summary = await removeRepeatedFrames(inputPath, outputPath, {
    similarityThreshold: SIMILARITY_THRESHOLD,
    edgeFrameCount: EDGE_FRAME_COUNT,
  });
  const durationMs = elapsedMs(startedAt);
  const report = {
    sourcePath: video.sourcePath,
    durationMs,
    ...summary,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  removed ${summary.removedFrameCount}/${summary.frameCount} frames in ${durationMs}ms -> ${outputPath}`);
  return report;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function main() {
  ensureDir(OUTPUT_ROOT);

  const startedAt = process.hrtime.bigint();
  const startedAtIso = new Date().toISOString();
  const videos = listSourceVideos();
  const summaries = await mapWithConcurrency(videos, CONCURRENCY, (video) => processVideo(video));
  const durationMs = elapsedMs(startedAt);

  const indexPath = path.join(OUTPUT_ROOT, 'summary.json');
  fs.writeFileSync(indexPath, JSON.stringify({
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    durationMs,
    videoCount: summaries.length,
    concurrency: Math.max(1, Math.min(videos.length, Math.floor(CONCURRENCY) || 1)),
    similarityThreshold: SIMILARITY_THRESHOLD,
    edgeFrameCount: EDGE_FRAME_COUNT,
    videos: summaries,
  }, null, 2));
  console.log(`Wrote ${indexPath} after ${durationMs}ms`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
