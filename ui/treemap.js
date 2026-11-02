// Pure helpers shared by the UI and the tests: tree utilities, formatting and the treemap layout.
// Nodes come from the backend as { n: name, s: size, f: files, c?: children, g?: smallItemsBucket }
// and get a non-serialized parent pointer `p` via link().

/** Human-readable size using decimal units, like Finder. */
export function fmt(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let b = Math.max(0, bytes), i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return (i === 0 ? String(b) : b.toFixed(b < 10 ? 2 : b < 100 ? 1 : 0)) + ' ' + units[i];
}

export const isDir = (n) => !!n.c;

/** Lowercase extension, '' when none, null for directories and buckets. Mirrors scanner::ext_of. */
export function extOf(n) {
  if (isDir(n) || n.g) return null;
  const i = n.n.lastIndexOf('.');
  return i > 0 && n.n.length - i - 1 <= 10 ? n.n.slice(i + 1).toLowerCase() : '';
}

/** Set parent pointers on the whole tree. */
export function link(n, p = null) {
  const stack = [[n, p]];
  while (stack.length) {
    const [node, parent] = stack.pop();
    node.p = parent;
    if (node.c) for (const k of node.c) stack.push([k, node]);
  }
}

/** The node itself followed by its parents up to the root. */
export function ancestors(n) {
  const a = [];
  for (let x = n; x; x = x.p) a.push(x);
  return a;
}

/** Absolute path of a node. The root's name is its absolute path. */
export function pathOf(n) {
  const parts = ancestors(n).reverse().map((x) => x.n);
  if (parts.length === 1) return parts[0];
  return parts[0].replace(/\/+$/, '') + '/' + parts.slice(1).join('/');
}

/** Items without any ancestor in the list, so nested picks aren't counted or acted on twice. */
export function topLevel(nodes) {
  const set = new Set(nodes);
  return nodes.filter((n) => !ancestors(n).slice(1).some((a) => set.has(a)));
}

/** Visible files below a node (or the node itself), used to keep per-kind totals in sync. */
export function* files(n) {
  if (!isDir(n)) { if (!n.g) yield n; return; }
  for (const k of n.c) yield* files(k);
}

/**
 * Remove a node from the tree and update the sizes and file counts of its ancestors.
 * Returns the parent.
 */
export function detach(n) {
  const parent = n.p;
  const i = parent.c.indexOf(n);
  if (i >= 0) parent.c.splice(i, 1);
  for (let a = parent; a; a = a.p) { a.s -= n.s; a.f -= n.f; }
  n.p = null;
  return parent;
}

// ---------- squarified treemap (Bruls, Huizing, van Wijk) ----------

function worst(sum, max, min, side, scale) {
  const a = sum * scale, s2 = side * side;
  return Math.max((s2 * max * scale) / (a * a), (a * a) / (s2 * min * scale));
}

/**
 * Lay out `root` in a w×h rectangle. Returns rects in draw order (parents before children):
 * [{ x, y, w, h, node, depth }]. Directories leave `pad` pixels around their contents so
 * borders can be drawn; nothing smaller than `minSide` pixels is subdivided further.
 */
export function layout(root, w, h, { pad = 2, minSide = 3 } = {}) {
  const rects = [];
  const visit = (node, x, y, w, h, depth) => {
    rects.push({ x, y, w, h, node, depth });
    if (!node.c || w < minSide || h < minSide) return;
    const p = depth > 0 && w > 4 * pad && h > 4 * pad ? pad : 0;
    x += p; y += p; w -= 2 * p; h -= 2 * p;
    const kids = node.c.filter((k) => k.s > 0).sort((a, b) => b.s - a.s);
    let total = kids.reduce((a, k) => a + k.s, 0);
    let i = 0;
    while (i < kids.length && w > 0.5 && h > 0.5) {
      const side = Math.min(w, h), scale = (w * h) / total;
      let sum = kids[i].s, j = i + 1;
      let best = worst(sum, kids[i].s, kids[i].s, side, scale);
      while (j < kids.length) {
        const s = sum + kids[j].s;
        const wv = worst(s, kids[i].s, kids[j].s, side, scale);
        if (wv > best) break;
        best = wv; sum = s; j++;
      }
      const thick = (sum * scale) / side;
      let off = 0;
      for (let k = i; k < j; k++) {
        const len = (kids[k].s * scale) / thick;
        if (w >= h) visit(kids[k], x, y + off, thick, len, depth + 1);
        else visit(kids[k], x + off, y, len, thick, depth + 1);
        off += len;
      }
      if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
      total -= sum; i = j;
    }
  };
  visit(root, 0, 0, w, h, 0);
  return rects;
}

const contains = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/**
 * Deepest laid-out node under (x, y). Walks down from `root` using a node→rect map,
 * which is far cheaper than scanning every rect on each mouse move.
 */
export function hitTest(rectOf, root, x, y) {
  const r = rectOf.get(root);
  if (!r || !contains(r, x, y)) return null;
  let node = root;
  for (;;) {
    if (!node.c) return node;
    let next = null;
    for (const k of node.c) {
      const kr = rectOf.get(k);
      if (kr && contains(kr, x, y)) { next = k; break; }
    }
    if (!next) return node;
    node = next;
  }
}
