import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, extOf, link, ancestors, pathOf, topLevel, files, detach, layout, hitTest } from '../../ui/treemap.js';

function tree() {
  const root = {
    n: '/Users/me', s: 1000, f: 5, c: [
      { n: 'Movies', s: 600, f: 2, c: [{ n: 'a.MP4', s: 400, f: 1 }, { n: 'b.mov', s: 200, f: 1 }] },
      { n: 'notes.txt', s: 300, f: 1 },
      { n: 'Docs', s: 100, f: 2, c: [{ n: 'x.pdf', s: 90, f: 1 }, { n: '1 small item', s: 10, f: 1, g: true }] },
    ],
  };
  link(root);
  return root;
}
const find = (root, name) => {
  const stack = [root];
  while (stack.length) { const n = stack.pop(); if (n.n === name) return n; if (n.c) stack.push(...n.c); }
};

test('fmt uses decimal units', () => {
  assert.equal(fmt(0), '0 B');
  assert.equal(fmt(999), '999 B');
  assert.equal(fmt(1000), '1.00 KB');
  assert.equal(fmt(15_300_000), '15.3 MB');
  assert.equal(fmt(250e9), '250 GB');
  assert.equal(fmt(-5), '0 B');
});

test('extOf mirrors the scanner rules', () => {
  assert.equal(extOf({ n: 'a.MP4' }), 'mp4');
  assert.equal(extOf({ n: '.bashrc' }), '');
  assert.equal(extOf({ n: 'Makefile' }), '');
  assert.equal(extOf({ n: 'x.thisisnotanext' }), '');
  assert.equal(extOf({ n: 'x.abcdefghij' }), 'abcdefghij');
  assert.equal(extOf({ n: 'dir', c: [] }), null);
  assert.equal(extOf({ n: '3 small items', g: true }), null);
});

test('pathOf builds absolute paths, including from /', () => {
  const root = tree();
  assert.equal(pathOf(root), '/Users/me');
  assert.equal(pathOf(find(root, 'a.MP4')), '/Users/me/Movies/a.MP4');
  const slash = { n: '/', s: 1, f: 1, c: [{ n: 'etc', s: 1, f: 1, c: [] }] };
  link(slash);
  assert.equal(pathOf(slash.c[0]), '/etc');
});

test('topLevel drops items whose ancestor is also selected', () => {
  const root = tree();
  const movies = find(root, 'Movies'), a = find(root, 'a.MP4'), notes = find(root, 'notes.txt');
  assert.deepEqual(topLevel([a, movies, notes]), [movies, notes]);
});

test('files skips directories and small-item buckets', () => {
  const root = tree();
  assert.deepEqual([...files(root)].map((f) => f.n), ['a.MP4', 'b.mov', 'notes.txt', 'x.pdf']);
});

test('detach updates ancestor totals', () => {
  const root = tree();
  const a = find(root, 'a.MP4');
  const parent = detach(a);
  assert.equal(parent.n, 'Movies');
  assert.equal(parent.s, 200);
  assert.equal(parent.f, 1);
  assert.equal(root.s, 600);
  assert.equal(root.f, 4);
  assert.ok(!parent.c.includes(a));
});

test('layout fills the area proportionally and stays in bounds', () => {
  const root = tree();
  const W = 400, H = 300;
  const rects = layout(root, W, H, { pad: 0 });
  assert.equal(rects[0].node, root);
  const byName = new Map(rects.map((r) => [r.node.n, r]));
  for (const r of rects) {
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6, `${r.node.n} out of bounds`);
  }
  for (const name of ['Movies', 'notes.txt', 'Docs']) {
    const r = byName.get(name);
    assert.ok(Math.abs((r.w * r.h) / (W * H) - r.node.s / root.s) < 1e-9, `${name} area`);
  }
  // squarified rectangles should not be extreme slivers
  for (const r of rects) assert.ok(Math.max(r.w / r.h, r.h / r.w) < 6, `${r.node.n} aspect ratio`);
});

test('layout skips empty items and does not subdivide tiny rects', () => {
  const root = { n: '/', s: 10, f: 2, c: [{ n: 'a', s: 10, f: 1 }, { n: 'empty', s: 0, f: 1 }] };
  link(root);
  assert.deepEqual(layout(root, 100, 100).map((r) => r.node.n), ['/', 'a']);
  assert.equal(layout(root, 2, 2).length, 1);
});

test('layout records depth with parents before children', () => {
  const root = tree();
  const rects = layout(root, 400, 300);
  const idx = new Map(rects.map((r, i) => [r.node, i]));
  for (const r of rects) {
    assert.equal(r.depth, ancestors(r.node).length - 1);
    if (r.node.p) assert.ok(idx.get(r.node.p) < idx.get(r.node));
  }
});

test('hitTest returns the deepest node under the point', () => {
  const root = tree();
  const rects = layout(root, 400, 300);
  const rectOf = new Map(rects.map((r) => [r.node, r]));
  for (const r of rects.filter((r) => !r.node.c)) {
    assert.equal(hitTest(rectOf, root, r.x + r.w / 2, r.y + r.h / 2), r.node);
  }
  assert.equal(hitTest(rectOf, root, -5, 10), null);
  assert.equal(hitTest(rectOf, root, 400, 10), null);
});
