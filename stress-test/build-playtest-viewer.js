#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { exclude: new Set() };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--artifacts') args.artifacts = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--exclude') {
      for (const game of next().split(',')) {
        const trimmed = game.trim();
        if (trimmed) args.exclude.add(trimmed);
      }
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.artifacts) throw new Error('usage: build-playtest-viewer.js --artifacts <dir> [--out <file>] [--exclude game-a,game-b]');
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

function pickVideo(videos) {
  const normalized = videos.map((file) => ({
    file,
    rel: file.split(path.sep).join('/'),
  }));
  return normalized.find(({ rel: file }) => file.endsWith('/recordings/session/video/000-runwave-with-audio.webm'))?.file
    || normalized.find(({ rel: file }) => file.includes('/recordings/session/video/') && file.endsWith('.webm'))?.file
    || normalized.find(({ rel: file }) => !file.includes('/recordings/session/audio/') && file.endsWith('.webm'))?.file
    || videos[0];
}

function isCleanScreenshot(file) {
  return file.endsWith('.png') && !file.endsWith('.grid.png');
}

function collectRuns(artifacts, outFile, options = {}) {
  const summaries = walk(artifacts, (file) => path.basename(file) === 'summary.json');
  return summaries.map((summaryPath) => {
    const attemptDir = path.dirname(summaryPath);
    const relative = path.relative(artifacts, attemptDir).split(path.sep);
    const summary = readJson(summaryPath);
    const game = relative[0] || summary.game || 'unknown';
    const videos = walk(attemptDir, (file) => file.endsWith('.webm')).sort();
    const video = pickVideo(videos);
    const screenshots = walk(attemptDir, isCleanScreenshot).sort();
    return {
      game,
      attempt: relative[1] || 'attempt',
      status: summary.status || 'unknown',
      startedAt: summary.startedAt || '',
      finishedAt: summary.finishedAt || '',
      uploadedTo: summary.uploadedTo || '',
      video: video ? rel(outFile, video) : '',
      poster: screenshots[0] ? rel(outFile, screenshots[0]) : '',
      screenshots: screenshots.map((file) => rel(outFile, file)),
      summary: rel(outFile, summaryPath),
    };
  })
    .filter((run) => !options.exclude?.has(run.game))
    .sort((a, b) => `${a.game}/${a.attempt}`.localeCompare(`${b.game}/${b.attempt}`));
}

function render(runs, artifacts) {
  const cards = runs.map((run, index) => `
    <article class="card" data-index="${index}" data-game="${escapeHtml(run.game)}" data-status="${escapeHtml(run.status)}" data-volume="on">
      <header>
        <div>
          <h2>${escapeHtml(run.game)}</h2>
          <p>${escapeHtml(run.attempt)} · ${escapeHtml(run.status)}</p>
        </div>
        <div class="card-actions">
          <button type="button" class="volume active" data-action="volume" aria-pressed="true">Volume On</button>
          <a href="${escapeHtml(run.summary)}">summary</a>
        </div>
      </header>
      <div class="media">
        ${run.video ? `<video playsinline preload="metadata" src="${escapeHtml(run.video)}" ${run.poster ? `poster="${escapeHtml(run.poster)}"` : ''}></video>` : '<div class="missing">No video found</div>'}
      </div>
      <div class="transport">
        <button type="button" data-action="play">Play</button>
        <button type="button" data-action="pause">Pause</button>
        <button type="button" data-action="fullscreen">Fullscreen</button>
        <input class="seek" type="range" min="0" max="1000" value="0" step="1" data-action="seek" aria-label="Seek ${escapeHtml(run.game)}" disabled>
        <span class="time" aria-live="off">0:00 / 0:00</span>
      </div>
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
    .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    input[type="search"] { width: min(360px, 42vw); padding: 8px 10px; border: 1px solid #444; border-radius: 6px; background: #0d0d0d; color: #f4f4f4; }
    input.seek { flex: 1 1 120px; min-width: 80px; max-width: none; padding: 0; accent-color: #79a7ff; }
    button, a { color: #f4f4f4; }
    button { padding: 7px 10px; border: 1px solid #555; border-radius: 6px; background: #242424; cursor: pointer; }
    button.active { border-color: #79a7ff; background: #1f4f97; }
    button:disabled { cursor: not-allowed; opacity: 0.5; }
    main { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: 10px; padding: 10px; }
    .card { border: 1px solid #333; border-radius: 8px; background: #181818; overflow: hidden; }
    .card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px; }
    .card-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    .card-actions a { font-size: 12px; }
    h2 { margin: 0; font-size: 13px; font-weight: 650; line-height: 1.2; }
    p { margin: 3px 0 0; color: #aaa; font-size: 12px; }
    .media { aspect-ratio: 16 / 9; background: #000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    video { display: block; width: 100%; height: 100%; background: #000; object-fit: contain; }
    .missing { display: grid; place-items: center; width: 100%; height: 100%; background: #050505; color: #aaa; }
    .transport { display: flex; align-items: center; gap: 8px; padding: 8px 9px; }
    .transport .time { color: #aaa; flex: 0 0 auto; font-size: 11px; min-width: 80px; text-align: right; white-space: nowrap; }
    .hidden { display: none; }
    @media (max-width: 1180px) {
      main { grid-template-columns: repeat(3, minmax(220px, 1fr)); }
    }
    @media (max-width: 860px) {
      main { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
    }
    @media (max-width: 560px) {
      header.page { align-items: stretch; flex-direction: column; }
      main { grid-template-columns: 1fr; padding: 8px; }
      input[type="search"] { width: 100%; box-sizing: border-box; }
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
      <div id="pageStatus" class="meta" role="status" aria-live="polite"></div>
    </div>
  </header>
  <main>${cards}</main>
  <script>
    const PAGE_SIZE = 4;
    const cards = [...document.querySelectorAll('.card')];
    const videos = [...document.querySelectorAll('video')];
    const filter = document.querySelector('#filter');
    const pauseAll = document.querySelector('#pauseAll');
    const pageStatus = document.querySelector('#pageStatus');
    let seekingVideo = null;

    const matchingCards = () => {
      const q = filter.value.trim().toLowerCase();
      return cards.filter((card) => !q || card.dataset.game.toLowerCase().includes(q));
    };

    const applyCardVolume = (card) => {
      const video = card?.querySelector('video');
      const button = card?.querySelector('[data-action="volume"]');
      const on = card?.dataset.volume !== 'off';
      if (video) {
        video.muted = !on;
        video.volume = on ? 1 : 0;
      }
      if (button) {
        button.textContent = on ? 'Volume On' : 'Volume Off';
        button.setAttribute('aria-pressed', String(on));
        button.classList.toggle('active', on);
      }
    };

    const formatTime = (seconds) => {
      if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
      const total = Math.floor(seconds);
      const minutes = Math.floor(total / 60);
      const remainder = String(total % 60).padStart(2, '0');
      return \`\${minutes}:\${remainder}\`;
    };

    const updateSeekState = (video) => {
      if (!video) return;
      const card = video.closest('.card');
      const seek = card?.querySelector('.seek');
      const time = card?.querySelector('.time');
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (seek && seekingVideo !== video) {
        seek.disabled = duration <= 0;
        seek.value = duration > 0 ? String(Math.round((video.currentTime / duration) * 1000)) : '0';
      }
      if (time) time.textContent = \`\${formatTime(video.currentTime)} / \${formatTime(duration)}\`;
    };

    const playVideo = async (video) => {
      if (!video) return false;
      applyCardVolume(video.closest('.card'));
      video.playsInline = true;
      try {
        await video.play();
        return true;
      } catch {
        return false;
      }
    };

    const fullscreenVideo = async (video) => {
      if (!video) return false;
      applyCardVolume(video.closest('.card'));
      try {
        if (video.requestFullscreen) {
          await video.requestFullscreen();
          return true;
        }
        if (video.webkitEnterFullscreen) {
          video.webkitEnterFullscreen();
          return true;
        }
      } catch {
        return false;
      }
      return false;
    };

    const renderGrid = () => {
      const matches = matchingCards();
      const visible = new Set(matches);

      for (const card of cards) {
        const show = visible.has(card);
        card.classList.toggle('hidden', !show);
        if (!show) card.querySelector('video')?.pause();
      }

      pageStatus.textContent = matches.length
        ? \`Showing \${matches.length} of \${cards.length} · 4 columns on wide screens\`
        : 'No matching games';
    };

    filter.addEventListener('input', () => {
      renderGrid();
    });
    pauseAll.addEventListener('click', () => {
      for (const video of videos) video.pause();
      pauseAll.blur();
    });
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button || button.dataset.action === 'seek') return;
      const card = button.closest('.card');
      const video = card?.querySelector('video');
      if (button.dataset.action === 'play') playVideo(video);
      if (button.dataset.action === 'pause') video?.pause();
      if (button.dataset.action === 'fullscreen') fullscreenVideo(video);
      if (button.dataset.action === 'volume') {
        card.dataset.volume = card.dataset.volume === 'off' ? 'on' : 'off';
        applyCardVolume(card);
      }
    });
    document.addEventListener('input', (event) => {
      const seek = event.target.closest('.seek');
      if (!seek) return;
      const video = seek.closest('.card')?.querySelector('video');
      if (!video) return;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (duration > 0) video.currentTime = (Number(seek.value) / 1000) * duration;
      updateSeekState(video);
    });
    document.addEventListener('pointerdown', (event) => {
      const seek = event.target.closest('.seek');
      if (seek) seekingVideo = seek.closest('.card')?.querySelector('video') || null;
    });
    document.addEventListener('pointerup', () => {
      if (seekingVideo) updateSeekState(seekingVideo);
      seekingVideo = null;
    });
    for (const video of videos) {
      applyCardVolume(video.closest('.card'));
      video.addEventListener('loadedmetadata', () => updateSeekState(video));
      video.addEventListener('durationchange', () => updateSeekState(video));
      video.addEventListener('timeupdate', () => updateSeekState(video));
      video.addEventListener('seeked', () => updateSeekState(video));
      video.addEventListener('play', () => applyCardVolume(video.closest('.card')));
    }
    renderGrid();
  </script>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv);
  const runs = collectRuns(args.artifacts, args.out, { exclude: args.exclude });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, render(runs, args.artifacts));
  console.log(JSON.stringify({ out: args.out, runs: runs.length }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  collectRuns,
  isCleanScreenshot,
  pickVideo,
  render,
};
