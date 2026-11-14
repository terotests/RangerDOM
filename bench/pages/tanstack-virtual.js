// SPDX-License-Identifier: MIT
// TanStack Virtual (virtual-core, no framework): 10 000 rows of different
// heights in a scrolled box; the virtualizer measures rows (measureElement,
// ResizeObserver), keeps ~20 in the DOM and moves them as the box scrolls.
import { Virtualizer, observeElementRect, observeElementOffset, elementScroll, measureElement } from '@tanstack/virtual-core';
const box = document.getElementById('box'), inner = document.getElementById('inner');
const count = 10000;
const text = (i) => 'Row ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(1 + (i * 7) % 5);
let v, drawing = false, again = false;
// (measureElement can call onChange while a draw is putting rows in: that
// draw runs again after, not inside, or rows would be made twice)
function draw() {
  if (drawing) { again = true; return; }
  drawing = true;
  try { do { again = false; drawOnce(); } while (again); } finally { drawing = false; }
}
function drawOnce() {
  const items = v.getVirtualItems();
  inner.style.height = v.getTotalSize() + 'px';
  const keep = new Map();
  for (const el of Array.from(inner.children)) keep.set(Number(el.dataset.index), el);
  const seen = new Set();
  for (const it of items) {
    let el = keep.get(it.index);
    if (!el) { el = document.createElement('div'); el.className = 'r' + (it.index % 2 ? ' odd' : ''); el.dataset.index = it.index; el.textContent = text(it.index); inner.appendChild(el); v.measureElement(el); }
    el.style.transform = 'translateY(' + it.start + 'px)';
    seen.add(it.index);
  }
  for (const [i, el] of keep) if (!seen.has(i)) el.remove();
}
function wait(pred, ms) { const end = Date.now() + (ms || 3000); return new Promise((ok) => { (function f() { if (pred() || Date.now() > end) ok(); else setTimeout(f, 20); })(); }); }
window.__benchCase = {
  setup() {
    v = new Virtualizer({ count, getScrollElement: () => box, estimateSize: () => 40, overscan: 5, observeElementRect, observeElementOffset, scrollToFn: elementScroll, measureElement, onChange: draw });
    v._didMount();
    v._willUpdate();
    draw();
  },
  steps: [
    { name: 'scroll to index 5000', run: () => { v.scrollToIndex(5000, { align: 'start' }); return wait(() => inner.querySelector('[data-index="5000"]')); } },
    { name: '20 frames of +150px', run: () => { let k = 0; return new Promise((ok) => { (function f() { box.scrollTop += 150; if (++k < 20) requestAnimationFrame(f); else setTimeout(ok, 50); })(); requestAnimationFrame(() => {}); }); } },
    { name: 'scroll to end', run: () => { v.scrollToIndex(count - 1, { align: 'end' }); return wait(() => inner.querySelector('[data-index="' + (count - 1) + '"]')); } },
    { name: 'scroll to top', run: () => { box.scrollTop = 0; return wait(() => inner.querySelector('[data-index="0"]')); } }
  ],
  probe() {
    const idx = Array.from(inner.children).map((e) => Number(e.dataset.index)).sort((a, b) => a - b);
    return { inDom: idx.length > 0 && idx.length < 60, firstShown: idx[0], total: Math.round(v.getTotalSize() / 100), top: Math.round(box.scrollTop / 100) };
  },
};
