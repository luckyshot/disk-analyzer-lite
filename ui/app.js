import { fmt, isDir, extOf, link, ancestors, pathOf, topLevel, files, detach, layout, hitTest } from './treemap.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;

const $ = (id) => document.getElementById(id);
// Three stacked canvases: the treemap, a dimming mask (selected folder, file-type filter) and
// hover/selection outlines. Hovering only repaints the top one.
const map = $('map'), mask = $('mask'), overlay = $('overlay');
const ctx = map.getContext('2d'), mctx = mask.getContext('2d'), octx = overlay.getContext('2d');
const IS_MAC = navigator.userAgent.includes('Mac');

let data = null;             // { path, root, kinds, errors, millis }
let view = null;             // node currently zoomed into
let selected = null;         // primary (last clicked) selected node
const selection = new Set(); // all selected nodes
let treeRows = [];           // visible tree rows in order, for Shift-click ranges
const rowEl = new Map();     // node -> tree row element
let hovered = null;
let kindFilter = null;
let rects = [];              // layout of the current view, parents first
let rectOf = new Map();      // node -> rect
let scanning = false;
let trashing = false;
let trashed = 0;             // bytes moved to the Trash from the app since the last scan
let baseAvailable = null;    // free space when the last scan finished
const expanded = new Set();
const colors = new Map();
let kindByExt = new Map();   // ext -> entry in data.kinds

const PALETTE = ['#4f7fe6', '#e2524f', '#44b36d', '#e6a23c', '#9b59d0', '#2fb5b5', '#e86fb4', '#8bbf3f',
  '#d9773a', '#5c6bc0', '#c0a33a', '#3f9ad9', '#b8524f', '#6fcf97', '#a77ad9', '#d4d44a', '#4fb3a0', '#e08a8a'];
const OTHER = '#8a8a92', GROUP = '#5a5a62';

const num = (n) => n.toLocaleString();
const status = (text) => { $('status').textContent = text; };
const colorOf = (n) => (n.g ? GROUP : colors.get(extOf(n)) || OTHER);

function shade(hex, f) {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.max(0, Math.min(255, Math.round(((v >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
// Light and dark gradient stops per color, computed once instead of for every tile
const cushion = new Map();
const cushionOf = (c) => {
  let v = cushion.get(c);
  if (!v) cushion.set(c, (v = [shade(c, 1.35), shade(c, 0.55)]));
  return v;
};

// ---------- drawing ----------
function sizeCanvas(c) {
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  return r;
}

function draw() {
  if (!view) return;
  const r = sizeCanvas(map); sizeCanvas(mask); sizeCanvas(overlay);
  rects = layout(view, r.width, r.height);
  rectOf = new Map(rects.map((q) => [q.node, q]));
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--map-bg');
  ctx.fillRect(0, 0, r.width, r.height);
  for (const { x, y, w, h, node } of rects) {
    if (isDir(node)) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x, y, w, h);
      continue;
    }
    const c = colorOf(node);
    if (w * h > 60 && w > 3 && h > 3) {
      // cushion-like shading: light top-left to dark bottom-right
      const [light, dark] = cushionOf(c);
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, light); g.addColorStop(0.5, c); g.addColorStop(1, dark);
      ctx.fillStyle = g;
      ctx.fillRect(x + 0.5, y + 0.5, w - 1, h - 1);
    } else {
      ctx.fillStyle = c;
      ctx.fillRect(x, y, w, h);
    }
  }
  // Directory borders: light grey at the top level, darker the deeper they go.
  // Parents are drawn first so nested (darker) borders stay visible on top.
  ctx.lineWidth = 1.5;
  for (const { x, y, w, h, node, depth } of rects) {
    if (!isDir(node) || depth === 0 || w < 6 || h < 6) continue;
    const v = Math.max(55, 215 - (depth - 1) * 32);
    ctx.strokeStyle = `rgb(${v},${v},${v})`;
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
  }
  drawOverlay();
}

/** Repaint the dimming mask and the outlines (after selection, filter or layout changes). */
function drawOverlay() {
  const r = mask.getBoundingClientRect();
  mctx.clearRect(0, 0, r.width, r.height);
  // Fade everything outside the selected directory
  const sr = selection.size === 1 && isDir(selected) && selected !== view && rectOf.get(selected);
  if (sr) {
    mctx.fillStyle = 'rgba(0,0,0,0.45)';
    mctx.fillRect(0, 0, r.width, r.height);
    mctx.clearRect(sr.x, sr.y, sr.w, sr.h);
  }
  if (kindFilter !== null) {
    mctx.fillStyle = 'rgba(0,0,0,0.6)';
    mctx.fillRect(0, 0, r.width, r.height);
    for (const { x, y, w, h, node } of rects) {
      if (extOf(node) === kindFilter) mctx.clearRect(x, y, w, h);
    }
  }
  drawOutlines();
}

/** Repaint only the hover and selection outlines; cheap enough for every mouse move. */
function drawOutlines() {
  const r = overlay.getBoundingClientRect();
  octx.clearRect(0, 0, r.width, r.height);
  const box = (n, color, lw) => {
    const rc = rectOf.get(n);
    if (!rc) return;
    octx.strokeStyle = color; octx.lineWidth = lw;
    octx.strokeRect(rc.x + lw / 2, rc.y + lw / 2, Math.max(0, rc.w - lw), Math.max(0, rc.h - lw));
  };
  if (hovered && !selection.has(hovered)) box(hovered, 'rgba(255,255,255,0.8)', 1);
  for (const n of selection) box(n, '#ffe600', 2);
}

const hit = (x, y) => (view ? hitTest(rectOf, view, x, y) : null);

// ---------- tree panel ----------
function renderTree() {
  const rows = [];
  const walk = (n, depth) => {
    rows.push({ n, depth });
    if (n.c && expanded.has(n)) for (const k of n.c) walk(k, depth + 1);
  };
  walk(data.root, 0);
  treeRows = rows.map((r) => r.n);
  rowEl.clear();
  const total = data.root.s || 1;
  const frag = document.createDocumentFragment();
  for (const { n, depth } of rows) {
    const d = document.createElement('div');
    d.className = 'row' + (n.c ? ' dir' : '') + (selection.has(n) ? ' sel' : '') + (n.g ? ' group' : '');
    d.style.paddingLeft = 4 + depth * 14 + 'px';
    const icon = n.c ? (expanded.has(n) ? '▼' : '▶') : '';
    d.innerHTML = `<span class="tw">${icon}</span><span class="nm"></span><span class="bar"><i style="width:${Math.min(100, (n.s / total) * 100)}%"></i></span><span class="sz">${fmt(n.s)}</span>`;
    d.querySelector('.nm').textContent = n.n;
    d.title = n.g ? `${n.n} (${num(n.f)} files)` : pathOf(n);
    d.querySelector('.tw').onclick = (e) => { e.stopPropagation(); toggle(n); };
    d.onclick = (e) => select(n, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'single');
    d.ondblclick = () => zoomTo(n);
    d.oncontextmenu = (e) => { e.preventDefault(); if (!selection.has(n)) select(n); showMenu(e); };
    rowEl.set(n, d);
    frag.appendChild(d);
  }
  $('tree').replaceChildren(frag);
  rowEl.get(selected)?.scrollIntoView({ block: 'nearest' });
}

/** Update highlighted rows without rebuilding the tree. */
function refreshTreeSelection() {
  for (const [n, d] of rowEl) d.classList.toggle('sel', selection.has(n));
  rowEl.get(selected)?.scrollIntoView({ block: 'nearest' });
}

function toggle(n) {
  if (expanded.has(n)) expanded.delete(n); else expanded.add(n);
  renderTree();
}

// ---------- kinds panel ----------
function renderKinds() {
  const frag = document.createDocumentFragment();
  for (const k of data.kinds) {
    if (k.count <= 0) continue;
    if (frag.childNodes.length >= 300) break;
    const d = document.createElement('div');
    d.className = 'krow' + (kindFilter === k.ext ? ' sel' : '');
    d.innerHTML = `<span class="sw" style="background:${colors.get(k.ext) || OTHER}"></span><span class="nm"></span><span class="sz">${fmt(k.size)}</span><span class="ct">${num(k.count)}</span>`;
    d.querySelector('.nm').textContent = k.ext === '' ? '(no extension)' : k.ext;
    d.onclick = () => { kindFilter = kindFilter === k.ext ? null : k.ext; renderKinds(); drawOverlay(); };
    frag.appendChild(d);
  }
  $('kinds').replaceChildren(frag);
}

// ---------- selection / navigation ----------
// mode: 'single' replaces the selection, 'toggle' (Cmd/Ctrl-click) adds or removes,
// 'range' (Shift-click in the tree) selects every visible row between the last click and this one.
function select(n, mode = 'single') {
  if (mode === 'toggle') {
    if (selection.has(n)) {
      selection.delete(n);
      selected = selection.size ? [...selection].pop() : null;
    } else { selection.add(n); selected = n; }
  } else if (mode === 'range' && selected && treeRows.includes(selected) && treeRows.includes(n)) {
    const a = treeRows.indexOf(selected), b = treeRows.indexOf(n);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selection.add(treeRows[i]);
  } else {
    if (mode !== 'range') selection.clear();
    selection.add(n); selected = n;
  }

  let rebuild = false;
  if (selected) {
    for (const a of ancestors(selected).slice(1)) if (!expanded.has(a)) { expanded.add(a); rebuild = true; }
    if (!ancestors(selected).includes(view)) { view = selected.c ? selected.p || selected : selected.p; draw(); }
  }
  if (rebuild) renderTree(); else refreshTreeSelection();
  drawOverlay(); updateButtons();

  if (selection.size > 1) {
    const total = topLevel([...selection]).reduce((a, x) => a + x.s, 0);
    status(`${selection.size} items selected — ${fmt(total)}`);
  } else if (selected) {
    const s = selected;
    status(s.g ? `${s.n} — ${fmt(s.s)} in ${num(s.f)} files (too small to show individually)`
      : `${pathOf(s)} — ${fmt(s.s)}${s.c ? ` · ${num(s.f)} files` : ''}`);
  }
}

/** Selected items that refer to a real path that can be acted on. */
const actionable = () => topLevel([...selection]).filter((n) => !n.g);

function zoomTo(n) {
  if (!n || !n.c) return;
  view = n;
  if (!expanded.has(n)) { expanded.add(n); renderTree(); }
  draw(); updateButtons();
}

function updateButtons() {
  const has = !!data && !scanning;
  $('btn-open').disabled = scanning;
  $('btn-rescan').disabled = !has;
  $('btn-up').disabled = !has || !view.p;
  $('btn-zoom').disabled = !has || selection.size !== 1 || !selected.c || selected === view;
  const items = has ? actionable() : [];
  $('btn-reveal').disabled = !items.length;
  $('btn-trash').disabled = !items.some((n) => n.p);
  const c = document.createElement('bdi');
  $('crumbs').replaceChildren(c);
  if (!view) return;
  ancestors(view).reverse().forEach((a, i) => {
    if (i) c.append(' › ');
    const s = document.createElement('span');
    s.textContent = a.n;
    s.onclick = () => zoomTo(a);
    c.append(s);
  });
}

// ---------- scanning ----------
async function startScan(path) {
  if (!path || scanning) return;
  scanning = true; updateButtons();
  $('welcome').hidden = true; $('progress').hidden = false;
  $('progress-text').textContent = 'Scanning ' + path + '…';
  status('Scanning ' + path);
  try {
    load(await invoke('scan', { path }));
  } catch (e) {
    status(String(e));
    if (!data) $('welcome').hidden = false;
  } finally {
    scanning = false;
    $('progress').hidden = true;
    updateButtons();
  }
}

function load(res) {
  data = res;
  link(data.root);
  colors.clear();
  kindByExt = new Map(data.kinds.map((k) => [k.ext, k]));
  data.kinds.slice(0, PALETTE.length).forEach((k, i) => colors.set(k.ext, PALETTE[i]));
  view = data.root; selected = null; selection.clear(); kindFilter = null; hovered = null;
  expanded.clear(); expanded.add(data.root);
  trashed = 0; baseAvailable = null;
  updateDisk();
  draw(); renderTree(); renderKinds(); updateButtons();
  status(`${data.path}: ${fmt(data.root.s)} in ${num(data.root.f)} files · scanned in ${(data.millis / 1000).toFixed(1)}s` +
    (data.errors ? ` · ${num(data.errors)} items unreadable (permissions)` : ''));
}

async function pickFolder() {
  if (scanning) return;
  const p = await dialog.open({ directory: true, multiple: false, title: 'Choose a folder to scan' });
  if (p) startScan(p);
}

// ---------- trash ----------
function forget(n) {
  // Keep per-kind totals in sync (files merged into "small items" buckets are not tracked individually)
  for (const f of files(n)) {
    const k = kindByExt.get(extOf(f));
    if (k) { k.size -= f.s; k.count -= 1; }
  }
  const parent = detach(n);
  if (ancestors(view).includes(n) || view === n) view = parent;
}

async function trashSelected() {
  if (scanning || trashing) return;
  const items = actionable().filter((n) => n.p);
  if (!items.length) return;
  const total = items.reduce((a, n) => a + n.s, 0);
  const what = items.length === 1 ? `"${items[0].n}"` : `${items.length} items`;
  const list = items.slice(0, 8).map(pathOf).join('\n') + (items.length > 8 ? `\n…and ${items.length - 8} more` : '');
  if (!(await dialog.confirm(`Move ${what} (${fmt(total)}) to the Trash?\n\n${list}`, { title: 'Move to Trash', kind: 'warning' }))) return;
  const paths = items.map(pathOf);
  trashing = true;
  status(`Moving ${what} to the Trash…`);
  let errors;
  try {
    errors = await invoke('move_to_trash', { paths });
  } catch (e) {
    errors = paths.map(() => String(e));
  } finally {
    trashing = false;
  }
  const failed = [];
  let moved = 0, movedSize = 0;
  items.forEach((n, i) => {
    if (errors[i]) { failed.push(`${paths[i]}: ${errors[i]}`); return; }
    moved++; movedSize += n.s; trashed += n.s;
    forget(n);
  });
  selection.clear(); selected = null;
  updateDisk();
  draw(); renderTree(); renderKinds(); updateButtons();
  status(`Moved ${moved} item${moved === 1 ? '' : 's'} to the Trash (${fmt(movedSize)})` + (failed.length ? ` · ${failed.length} failed` : ''));
  if (failed.length) await dialog.message(failed.join('\n'), { title: 'Some items could not be moved to the Trash', kind: 'error' });
}

// ---------- sidebars ----------
function setSidebar(side, on) {
  $('btn-' + side).classList.toggle('on', on);
  document.querySelector('main').classList.toggle('no-' + side, !on);
  try { localStorage.setItem('sidebar-' + side, on ? '1' : '0'); } catch {}
  draw();
}
for (const side of ['left', 'right']) {
  let on = true;
  try { on = localStorage.getItem('sidebar-' + side) !== '0'; } catch {}
  $('btn-' + side).onclick = () => setSidebar(side, !$('btn-' + side).classList.contains('on'));
  if (!on) setSidebar(side, false);
}

// ---------- disk usage ----------
async function updateDisk() {
  if (!data) return;
  let u;
  try { u = await invoke('disk_usage', { path: data.path }); } catch { return; }
  if (!u.total) return;
  if (baseAvailable === null) baseAvailable = u.available;
  const used = u.total - u.available;
  // Space actually freed since the scan, from this app or anywhere else (Finder, Terminal, emptying the Trash)
  const freed = Math.max(0, u.available - baseAvailable);
  // Items trashed here that still occupy the disk until the Trash is emptied
  const pending = Math.min(Math.max(0, trashed - freed), used);
  const pct = (x) => (x / u.total) * 100 + '%';
  const usedEl = $('disk-used');
  usedEl.style.width = pct(used - pending);
  usedEl.className = used / u.total > 0.95 ? 'crit' : used / u.total > 0.85 ? 'warn' : '';
  $('disk-trash').style.width = pct(pending);
  $('disk-freed').style.width = pct(freed);
  $('disk-text').innerHTML = `${fmt(u.available)} free of ${fmt(u.total)}` +
    (freed >= 1e6 ? ` · <b>${fmt(freed)} freed</b>` : '') +
    (pending >= 1e6 ? ` · <em>${fmt(pending)} in Trash</em>` : '');
  $('disk').title = `Used: ${fmt(used)} (${((used / u.total) * 100).toFixed(1)}%)\nFree: ${fmt(u.available)}` +
    `\nFreed since scan (anywhere on this disk): ${fmt(freed)}` +
    (pending ? `\nIn Trash, not yet freed: ${fmt(pending)} (empty the Trash to reclaim it)` : '');
  $('disk').hidden = false;
}
// Refresh only when returning to the app (e.g. after deleting files in Finder) — no polling
window.addEventListener('focus', updateDisk);

// ---------- events ----------
document.querySelectorAll('[data-scan]').forEach((b) => b.onclick = async () => {
  const k = b.dataset.scan;
  if (k === 'home') startScan(await invoke('home_dir'));
  else if (k === 'disk') startScan(IS_MAC ? '/System/Volumes/Data' : '/');
  else pickFolder();
});
$('btn-open').onclick = pickFolder;
$('btn-rescan').onclick = () => data && startScan(data.path);
$('btn-cancel').onclick = () => invoke('cancel_scan');
$('btn-up').onclick = () => view?.p && zoomTo(view.p);
$('btn-zoom').onclick = () => selection.size === 1 && zoomTo(selected);
$('btn-reveal').onclick = () => { for (const n of actionable().slice(0, 20)) invoke('reveal', { path: pathOf(n) }); };
$('btn-trash').onclick = trashSelected;

overlay.addEventListener('mousemove', (e) => {
  const n = hit(e.offsetX, e.offsetY);
  const tip = $('tooltip');
  if (n !== hovered) { hovered = n; drawOutlines(); }
  if (!n) { tip.style.display = 'none'; return; }
  tip.innerHTML = '<b></b><span></span>';
  tip.querySelector('b').textContent = n.n;
  tip.querySelector('span').textContent = fmt(n.s) + (n.c || n.g ? ` · ${num(n.f)} files` : '');
  tip.style.display = 'block';
  const pw = overlay.clientWidth, ph = overlay.clientHeight;
  let tx = e.offsetX + 14, ty = e.offsetY + 14;
  if (tx + tip.offsetWidth > pw) tx = e.offsetX - tip.offsetWidth - 8;
  if (ty + tip.offsetHeight > ph) ty = e.offsetY - tip.offsetHeight - 8;
  tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
});
overlay.addEventListener('mouseleave', () => { hovered = null; $('tooltip').style.display = 'none'; drawOutlines(); });
overlay.addEventListener('click', (e) => {
  const n = hit(e.offsetX, e.offsetY);
  if (n) select(n, e.metaKey || e.ctrlKey || e.shiftKey ? 'toggle' : 'single');
});
overlay.addEventListener('dblclick', (e) => {
  const n = hit(e.offsetX, e.offsetY);
  if (n) zoomTo(n.c ? n : n.p);
});
overlay.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const n = hit(e.offsetX, e.offsetY);
  if (n) { if (!selection.has(n)) select(n); showMenu(e); }
});

// ---------- context menu ----------
const menu = $('ctxmenu');
// Platform wording: Finder and ⌘ on macOS, file manager and Ctrl on Linux
if (!IS_MAC) {
  menu.querySelector('[data-act=reveal]').textContent = 'Show in File Manager';
  $('btn-reveal').title = 'Show in file manager';
  $('btn-trash').title = 'Move selection to Trash (Ctrl+Backspace)';
  $('hint').textContent = 'Tip: "Whole disk" covers the root filesystem only. Scan /home or other mount points separately.';
}
function showMenu(e) {
  const items = actionable();
  const copy = menu.querySelector('[data-act=copy]');
  copy.textContent = items.length > 1 ? `Copy ${items.length} Absolute Paths` : 'Copy Absolute Path';
  copy.classList.toggle('disabled', !items.length);
  menu.querySelector('[data-act=reveal]').classList.toggle('disabled', !items.length);
  menu.querySelector('[data-act=trash]').classList.toggle('disabled', scanning || !items.some((n) => n.p));
  menu.hidden = false;
  const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 4);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 4);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.webkitUserSelect = t.style.userSelect = 'text';
    document.body.appendChild(t); t.select();
    document.execCommand('copy'); t.remove();
  }
}
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
menu.addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  menu.hidden = true;
  if (act === 'copy') {
    const paths = actionable().map(pathOf);
    await copyText(paths.join('\n'));
    status(paths.length > 1 ? `Copied ${paths.length} paths` : 'Copied: ' + paths[0]);
  } else if (act === 'reveal') $('btn-reveal').click();
  else if (act === 'trash') trashSelected();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) { menu.hidden = true; return; }
  if (!data || scanning) return;
  if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); trashSelected(); }
  else if (e.key === 'Backspace' || e.key === 'Escape') { if (view.p) zoomTo(view.p); }
  else if (e.key === 'Enter') { if (selection.size === 1) zoomTo(selected); }
  else if (e.key === 'ArrowUp' && selected?.p) select(selected.p);
});

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(draw, 80); });

listen('scan-progress', (ev) => {
  $('progress-text').textContent = `${num(ev.payload.files)} files · ${fmt(ev.payload.bytes)}`;
});

invoke('initial_path').then((p) => p && startScan(p));
