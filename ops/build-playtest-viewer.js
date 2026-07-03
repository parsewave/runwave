#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--artifacts') args.artifacts = next();
    else if (arg === '--out') args.out = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.artifacts) throw new Error('usage: build-playtest-viewer.js --artifacts <dir> [--out <file>]');
  args.artifacts = path.resolve(args.artifacts);
  args.out = path.resolve(args.out || path.join(args.artifacts, 'index.html'));
  return args;
}

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, predicate, out);
    else if (predicate(file)) out.push(file);
  }
  return out;
}

function rel(from, to) {
  return path.relative(path.dirname(from), to).split(path.sep).join('/');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function collectRuns(artifacts, outFile) {
  const summaries = walk(artifacts, (file) => path.basename(file) === 'summary.json');
  return summaries.map((summaryPath) => {
    const attemptDir = path.dirname(summaryPath);
    const relative = path.relative(artifacts, attemptDir).split(path.sep);
    const summary = readJson(summaryPath);
    const videos = walk(attemptDir, (file) => file.endsWith('.webm')).sort();
    const screenshots = walk(attemptDir, (file) => file.endsWith('.png')).sort();
    return {
      game: relative[0] || summary.game || 'unknown',
      attempt: relative[1] || 'attempt',
      status: summary.status || 'unknown',
      startedAt: summary.startedAt || '',
      finishedAt: summary.finishedAt || '',
      uploadedTo: summary.uploadedTo || '',
      video: videos[0] ? rel(outFile, videos[0]) : '',
      poster: screenshots[0] ? rel(outFile, screenshots[0]) : '',
      screenshots: screenshots.map((file) => rel(outFile, file)),
      summary: rel(outFile, summaryPath),
    };
  }).sort((a, b) => `${a.game}/${a.attempt}`.localeCompare(`${b.game}/${b.attempt}`));
}

function render(runs, artifacts) {
  const cards = runs.map((run, index) => `
    <article class="card" data-game="${escapeHtml(run.game)}" data-status="${escapeHtml(run.status)}">
      <header>
        <div>
          <h2>${escapeHtml(run.game)}</h2>
          <p>${escapeHtml(run.attempt)} · ${escapeHtml(run.status)}</p>
        </div>
        <a href="${escapeHtml(run.summary)}">summary</a>
      </header>
      ${run.video ? `<video controls preload="metadata" ${run.poster ? `poster="${escapeHtml(run.poster)}"` : ''} src="${escapeHtml(run.video)}"></video>` : '<div class="missing">No video found</div>'}
      <div class="strip">
        ${run.screenshots.slice(0, 8).map((shot) => `<a href="${escapeHtml(shot)}"><img src="${escapeHtml(shot)}" loading="lazy" alt=""></a>`).join('')}
      </div>
      <footer>
        <button type="button" data-play="${index}">Play</button>
        <button type="button" data-pause="${index}">Pause</button>
        <span>${escapeHtml(run.finishedAt || run.startedAt)}</span>
      </footer>
    </article>
  `).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Runwave Playtest Viewer</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #111; color: #f4f4f4; }
    header.page { position: sticky; top: 0; z-index: 2; display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 14px 18px; background: #181818; border-bottom: 1px solid #333; }
    h1 { margin: 0; font-size: 18px; font-weight: 650; }
    .meta { color: #bbb; font-size: 13px; }
    .controls { display: flex; gap: 8px; align-items: center; }
    input { width: min(360px, 42vw); padding: 8px 10px; border: 1px solid #444; border-radius: 6px; background: #0d0d0d; color: #f4f4f4; }
    button, a { color: #f4f4f4; }
    button { padding: 7px 10px; border: 1px solid #555; border-radius: 6px; background: #242424; cursor: pointer; }
    main { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; padding: 14px; }
    .card { border: 1px solid #333; border-radius: 8px; background: #181818; overflow: hidden; }
    .card header, .card footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; }
    h2 { margin: 0; font-size: 15px; font-weight: 650; }
    p { margin: 3px 0 0; color: #aaa; font-size: 12px; }
    video { display: block; width: 100%; max-height: 72vh; background: #000; object-fit: contain; }
    .missing { display: grid; place-items: center; width: 100%; aspect-ratio: 16 / 9; background: #050505; color: #aaa; }
    .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; padding: 2px; background: #0b0b0b; }
    .strip a { align-items: center; aspect-ratio: 16 / 9; background: #050505; display: flex; justify-content: center; overflow: hidden; }
    .strip img { display: block; max-height: 100%; max-width: 100%; object-fit: contain; }
    footer span { color: #aaa; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hidden { display: none; }
    @media (max-width: 640px) {
      header.page { align-items: stretch; flex-direction: column; }
      main { grid-template-columns: 1fr; padding: 8px; }
      input { width: 100%; box-sizing: border-box; }
    }
  </style>
</head>
<body>
  <header class="page">
    <div>
      <h1>Runwave Playtest Viewer</h1>
      <div class="meta">${runs.length} playtests · ${escapeHtml(artifacts)}</div>
    </div>
    <div class="controls">
      <input id="filter" type="search" placeholder="Filter games">
      <button id="pauseAll" type="button">Pause All</button>
    </div>
  </header>
  <main>${cards}</main>
  <script>
    const cards = [...document.querySelectorAll('.card')];
    const videos = [...document.querySelectorAll('video')];
    document.querySelector('#filter').addEventListener('input', (event) => {
      const q = event.target.value.toLowerCase();
      for (const card of cards) card.classList.toggle('hidden', !card.dataset.game.toLowerCase().includes(q));
    });
    document.querySelector('#pauseAll').addEventListener('click', () => videos.forEach((video) => video.pause()));
    document.addEventListener('click', (event) => {
      const play = event.target.closest('[data-play]');
      const pause = event.target.closest('[data-pause]');
      if (play) videos[Number(play.dataset.play)]?.play();
      if (pause) videos[Number(pause.dataset.pause)]?.pause();
    });
  </script>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv);
  const runs = collectRuns(args.artifacts, args.out);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, render(runs, args.artifacts));
  console.log(JSON.stringify({ out: args.out, runs: runs.length }, null, 2));
}

main();
