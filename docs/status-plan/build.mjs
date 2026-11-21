#!/usr/bin/env node
// Builds the Flux Status & Plan hub from docs/status-plan/steps.json,
// docs/status-plan/template.html, docs/status-plan/boards/*.html, and BACKLOG.md.
//
// Usage:
//   node docs/status-plan/build.mjs
//   node docs/status-plan/build.mjs --artifact /path/to/flux-status-plan.html
//
// Always writes docs/status-plan/index.html (the local repo copy).
// When --artifact <path> is given, also writes a self-contained HTML copy
// (CSP-safe, inline images, gzip-embedded design boards) for Antigravity.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BOARDS_DIR = path.join(HERE, 'boards');
const MEDIA_DIR = path.join(REPO, 'docs', 'media');

const args = process.argv.slice(2);
let artifactOut = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--artifact' && args[i + 1]) {
    artifactOut = path.resolve(args[++i]);
  }
}

const VALID_STATUS = new Set(['todo', 'doing', 'done', 'skipped']);

function runGit(cmd, fallback = '') {
  try {
    return execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function md(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|[\s(])_([^_]+?)_(?=[\s).,:;]|$)/g, '$1<i>$2</i>');
}

function plain(s) {
  return s.replace(/\*\*|`|~~|\[\[|\]\]/g, '');
}

// ── 1. Parse BACKLOG.md into the live Backlog section & vital stats ──────────
function buildBacklog() {
  const src = fs.readFileSync(path.join(REPO, 'BACKLOG.md'), 'utf8');
  const head = runGit('git log -1 --format=%h -- BACKLOG.md', 'HEAD');
  const when = runGit('git log -1 --format=%cd --date=format:"%-d %b" -- BACKLOG.md', 'today');

  const STATUS = {
    P0: { key: 'p0', label: 'P0', cls: 'crit', rank: 0 },
    P1: { key: 'p1', label: 'P1', cls: 'warn', rank: 1 },
    '◐': { key: 'wip', label: 'In progress', cls: 'info', rank: 2 },
    P2: { key: 'p2', label: 'P2', cls: 'muted', rank: 3 },
    P3: { key: 'p3', label: 'P3', cls: 'muted', rank: 4 },
    decision: { key: 'decision', label: 'Decision', cls: 'muted', rank: 5 },
  };

  function split(text) {
    const b = text.match(/^(.*?)\*\*(.+?)\*\*(.*)$/s);
    if (b && b[1].length < 40) {
      const lead = b[1].trim();
      return {
        title: plain(b[2]).replace(/[.:]$/, ''),
        rest: ((lead ? lead + ' ' : '') + b[3].replace(/^\s*[—:-]\s*/, '')).trim(),
      };
    }
    const m = text.match(/^(.{12,110}?)(?: — |\. |: |\? )(.*)$/s);
    if (m) return { title: plain(m[1]), rest: m[2].trim() };
    return { title: plain(text.slice(0, 110)), rest: text.slice(110) };
  }

  const groups = [];
  let group = null;
  let bullet = null;
  const flush = () => {
    if (bullet && !/^✅|^~~/.test(bullet.trim())) {
      const { title, rest } = split(bullet.trim());
      group.items.push({ n: null, status: STATUS.decision, title, rest });
    }
    bullet = null;
  };

  for (const line of src.split('\n')) {
    const h = line.match(/^## (.+)/);
    if (h) {
      if (group && group.decisions) flush();
      group = {
        name: h[1].replace(/^Epic:\s*/, ''),
        items: [],
        done: 0,
        decisions: /^Decisions/.test(h[1]),
      };
      groups.push(group);
      continue;
    }
    if (!group) continue;
    if (group.decisions) {
      if (/^- /.test(line)) {
        flush();
        bullet = line.slice(2);
      } else if (bullet !== null && /^\s+\S/.test(line)) {
        bullet += ' ' + line.trim();
      } else if (bullet !== null && !line.trim()) {
        flush();
      }
      continue;
    }
    const row = line.match(/^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*(.*)\|\s*$/);
    if (!row) continue;
    const st = STATUS[row[2]];
    if (!st) {
      group.done++;
      continue;
    }
    const { title, rest } = split(row[3].trim());
    group.items.push({ n: +row[1], status: st, title, rest });
  }
  if (group && group.decisions) flush();

  const shown = groups.filter((g) => g.items.length);
  shown.forEach((g) => g.items.sort((a, b) => a.status.rank - b.status.rank || (a.n || 0) - (b.n || 0)));
  const all = shown.flatMap((g) => g.items);
  const tally = (k) => all.filter((i) => i.status.key === k).length;
  const done = groups.reduce((s, g) => s + g.done, 0);

  const CUT = 230;
  function body(rest) {
    if (!rest) return '';
    if (rest.length <= CUT + 40) return `<p class="bl-text">${md(rest)}</p>`;
    const at = rest.lastIndexOf(' ', CUT);
    const cutAt = at > 80 ? at : CUT;
    return `<p class="bl-text">${md(rest.slice(0, cutAt))}…</p><details class="bl-more"><summary>All of it</summary><p class="bl-text">${md(rest)}</p></details>`;
  }

  const itemHtml = (i) => `            <li class="bl-item" data-status="${i.status.key}">
              <div class="bl-head">${i.n ? `<span class="bl-n">#${i.n}</span>` : ''}<span class="pill ${i.status.cls}">${i.status.label}</span><h5>${esc(i.title)}</h5></div>
              ${body(i.rest)}
            </li>`;

  const cardHtml = (g) => `        <div class="bl-group paper" data-group>
          <span class="legend">${esc(g.name)}</span>
          <ul class="bl-list">
${g.items.map(itemHtml).join('\n')}
          </ul>
        </div>`;

  const chip = (key, label, n, on) =>
    `<button class="chip-btn" type="button" data-value="${key}" aria-pressed="${on}">${label}${n == null ? '' : ` <span class="n">${n}</span>`}</button>`;

  const nonDecisionOpen = all.length - tally('decision');
  const html = `  <!-- ═══════════════════ BACKLOG (generated by docs/status-plan/build.mjs from BACKLOG.md) ═══════════════════ -->
  <section class="part" id="backlog" aria-labelledby="backlog-h">
    <div class="part-head">
      <span class="eyebrow kicker">Backlog · BACKLOG.md at ${esc(head)}, ${esc(when)}</span>
      <h2 class="display" id="backlog-h">What's left after the plan</h2>
      <p>Everything still open in the repo's backlog: ${nonDecisionOpen} items, ${tally('wip')} of them in progress, and ${tally('decision')} decisions not yet taken. The ${done} done items stay in the file. Numbers match the <code>BACKLOG #n</code> comments in the code.</p>
    </div>
    <div class="filters" role="group" aria-label="Filter the backlog">
      <div class="filter-group" data-filter="status">
        <span>Status</span>
        ${chip('all', 'All', null, true)}
        ${['p0', 'p1', 'wip', 'p2', 'p3', 'decision']
          .filter((k) => tally(k))
          .map((k) => chip(k, Object.values(STATUS).find((s) => s.key === k).label, tally(k), false))
          .join('\n        ')}
      </div>
      <input class="cheat-search" id="bl-filter" type="search" placeholder="Filter: try “agent” or “#197”" aria-label="Filter the backlog" autocomplete="off" spellcheck="false">
      <span class="count" id="bl-count" aria-live="polite"></span>
    </div>
    <p class="cheat-empty" id="bl-empty" hidden>Nothing open matches.</p>
    <div class="bl-grid" id="bl-grid">
${shown.map(cardHtml).join('\n')}
    </div>
  </section>`;

  const parts = [];
  if (tally('p0')) parts.push(`${tally('p0')} P0`);
  if (tally('p1')) parts.push(`${tally('p1')} P1`);
  if (tally('p2')) parts.push(`${tally('p2')} P2`);
  if (tally('p3')) parts.push(`${tally('p3')} P3`);
  const priText = parts.length ? parts.join(', ') : 'No unstarted P0–P3';
  const summary = `${priText}, plus ${tally('wip')} in progress and ${tally('decision')} open decisions.`;

  return {
    html,
    head,
    when,
    openCount: nonDecisionOpen,
    summary,
    doneCount: done,
    groupsCount: shown.length,
  };
}

// ── 2. Build Media section (local relative paths vs inline artifact data URIs)
function encodeJpegResized(filePath, maxWidth = 1200) {
  if (!fs.existsSync(filePath)) return null;
  const tmpOut = path.join(os.tmpdir(), `flux-hub-${path.basename(filePath)}-${process.pid}.jpg`);
  try {
    execSync(
      `sips -s format jpeg -s formatOptions 78 -Z ${maxWidth} "${filePath}" --out "${tmpOut}"`,
      { stdio: 'ignore' },
    );
    const buf = fs.readFileSync(tmpOut);
    fs.unlinkSync(tmpOut);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    try {
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    } catch {}
    return `data:image/jpeg;base64,${fs.readFileSync(filePath).toString('base64')}`;
  }
}

function buildMediaSection(isArtifact) {
  if (!isArtifact) {
    return `  <!-- ═══════════════════ MEDIA ═══════════════════ -->
  <section class="part" id="media" aria-labelledby="media-h">
    <div class="part-head">
      <span class="eyebrow kicker">Media · 13 Nov 2026</span>
      <h2 class="display" id="media-h">Flux on screen</h2>
      <p>Captured from the installed build, full screen around the notch, in a workspace with nothing personal in it. The same files live in <code>docs/media/</code> and the README.</p>
    </div>
    <figure class="paper media-fig">
      <span class="legend">Start page · the liquid background</span>
      <video src="../media/start-waves.mp4" autoplay muted loop playsinline poster="../media/start.jpg" aria-label="The start page's background waves drifting, six seconds, looping"></video>
      <figcaption>Six seconds of the start page's background, looping. <a href="../media/start-waves.mp4">MP4</a> · <a href="../media/start-waves.gif">GIF for GitHub</a></figcaption>
    </figure>
    <div class="media-grid">
      <figure class="paper media-fig">
        <span class="legend">Start page</span>
        <a href="../media/start.jpg"><img src="../media/start.jpg" alt="Flux's start page in Liquid Silk, full screen around the notch: the tabs pane on the left, the clock, shortcuts and tasks over the wave background." loading="lazy"></a>
      </figure>
      <figure class="paper media-fig">
        <span class="legend">Agent · Fairy</span>
        <a href="../media/agent.jpg"><img src="../media/agent.jpg" alt="Flux with the agent panel open on a new chat with Fairy: the drawn icon buttons, the scope switch and the composer." loading="lazy"></a>
      </figure>
    </div>
  </section>`;
  }

  const startUri = encodeJpegResized(path.join(MEDIA_DIR, 'start.jpg'), 1200) || '';
  const agentUri = encodeJpegResized(path.join(MEDIA_DIR, 'agent.jpg'), 1200) || '';

  return `  <!-- ═══════════════════ MEDIA ═══════════════════ -->
  <section class="part" id="media" aria-labelledby="media-h">
    <div class="part-head">
      <span class="eyebrow kicker">Media · 13 Nov 2026</span>
      <h2 class="display" id="media-h">Flux on screen</h2>
      <p>Captured from the installed build, full screen around the notch, in a workspace with nothing personal in it. The stills below are embedded for offline viewing; the looping 6-second video lives in <code>docs/media/start-waves.mp4</code> and plays directly in the local repo copy (<code>docs/status-plan/index.html</code>).</p>
    </div>
    <div class="media-grid">
      <figure class="paper media-fig">
        <span class="legend">Start page · Liquid Silk</span>
        <img src="${startUri}" alt="Flux's start page in Liquid Silk, full screen around the notch: the tabs pane on the left, the clock, shortcuts and tasks over the wave background.">
        <figcaption>Start page in Liquid Silk (full screen around the notch). Looping video: <code>docs/media/start-waves.mp4</code>.</figcaption>
      </figure>
      <figure class="paper media-fig">
        <span class="legend">Agent · Fairy</span>
        <img src="${agentUri}" alt="Flux with the agent panel open on a new chat with Fairy: the drawn icon buttons, the scope switch and the composer.">
        <figcaption>Agent panel open on a new chat with Fairy.</figcaption>
      </figure>
    </div>
  </section>`;
}

// ── 3. Build gzip-base64 embedded boards map for self-contained artifact ─────
function buildEmbeddedBoards() {
  const map = {};
  if (!fs.existsSync(BOARDS_DIR)) return map;
  for (const fn of fs.readdirSync(BOARDS_DIR).sort()) {
    if (!fn.endsWith('.html')) continue;
    const id = fn.replace(/\.html$/, '');
    let html = fs.readFileSync(path.join(BOARDS_DIR, fn), 'utf8');
    // Strip external Google Fonts links in sandboxed artifact boards to avoid CSP warnings
    html = html.replace(/<link[^>]+fonts\.googleapis\.com[^>]*>/gi, '');
    html = html.replace(/<link[^>]+fonts\.gstatic\.com[^>]*>/gi, '');
    const gz = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 9 });
    map[id] = gz.toString('base64');
  }
  return map;
}

// ── 4. Assemble HTML ─────────────────────────────────────────────────────────
const stepsDoc = JSON.parse(fs.readFileSync(path.join(HERE, 'steps.json'), 'utf8'));
const stepsMap = stepsDoc.steps || {};
for (const [k, v] of Object.entries(stepsMap)) {
  if (!VALID_STATUS.has(v.status)) {
    throw new Error(`Invalid status "${v.status}" for step "${k}" in steps.json`);
  }
}

const template = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
const backlog = buildBacklog();

const repoHead = runGit('git rev-parse --short HEAD', 'main');
const repoDate = runGit('git log -1 --format=%cd --date=format:"%-d %b"', 'today');
const rawCommits = runGit('git rev-list --count HEAD', '0');
const repoCommits = Number(rawCommits).toLocaleString('en-US');
const syncDate = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const LOCAL_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Fraunces:opsz,wght,SOFT@9..144,400..600,0..100&family=JetBrains+Mono:wght@400;500&display=swap">`;

function renderPage({ isArtifact }) {
  const embeddedBoards = isArtifact ? buildEmbeddedBoards() : null;
  const sourceMeta = {
    mode: isArtifact ? 'artifact' : 'local',
    syncLabel: isArtifact
      ? `Synced · Antigravity copy (${syncDate})`
      : `Synced · steps.json (${syncDate})`,
  };

  let out = template;
  const replaceOnce = (needle, value) => {
    const idx = out.indexOf(needle);
    if (idx === -1) throw new Error(`Missing template placeholder: ${needle}`);
    out = out.slice(0, idx) + value + out.slice(idx + needle.length);
  };

  replaceOnce('<!-- __FONTS__ -->', isArtifact ? '' : LOCAL_FONTS);
  replaceOnce('__REPO_HEAD__', esc(repoHead));
  replaceOnce('__REPO_DATE__', esc(repoDate));
  replaceOnce('__REPO_COMMITS__', esc(repoCommits));
  replaceOnce('__SYNC_DATE__', esc(syncDate));
  replaceOnce('__BACKLOG_OPEN__', esc(backlog.openCount));
  replaceOnce('__BACKLOG_SUMMARY__', esc(backlog.summary));
  replaceOnce('__BACKLOG_HEAD__', esc(backlog.head));
  replaceOnce('__BACKLOG_WHEN__', esc(backlog.when));
  replaceOnce('<!-- __BACKLOG_SECTION__ -->', backlog.html);
  replaceOnce('<!-- __MEDIA_SECTION__ -->', buildMediaSection(isArtifact));
  replaceOnce('__INITIAL_STEPS__', safeJson(stepsMap));
  replaceOnce('__EMBEDDED_BOARDS__', safeJson(embeddedBoards));
  replaceOnce('__SOURCE_META__', safeJson(sourceMeta));

  return out;
}

const localHtml = renderPage({ isArtifact: false });
const localPath = path.join(HERE, 'index.html');
fs.writeFileSync(localPath, localHtml);

const doneCount = Object.values(stepsMap).filter((s) => s.status === 'done').length;
console.log(
  `Built local copy: ${path.relative(REPO, localPath)} (${(localHtml.length / 1024).toFixed(1)} KB) — ` +
    `${doneCount}/${Object.keys(stepsMap).length} steps done, ${backlog.openCount} open backlog items (${backlog.doneCount} done).`,
);

if (artifactOut) {
  fs.mkdirSync(path.dirname(artifactOut), { recursive: true });
  const artHtml = renderPage({ isArtifact: true });
  fs.writeFileSync(artifactOut, artHtml);
  console.log(
    `Built Antigravity artifact: ${artifactOut} (${(artHtml.length / 1024).toFixed(1)} KB, self-contained).`,
  );
}
