// SPDX-License-Identifier: MIT
// interact.js: draggable and resizable boxes driven by pointer events the
// page dispatches (pointerdown, 10 pointermoves, pointerup), positions kept
// in transform; a drag inside a restricted parent, a resize from an edge.
import interact from 'interactjs';
const $ = (s) => document.querySelector(s);
function pointer(el, type, x, y) {
  const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 };
  el.dispatchEvent(new PointerEvent(type, o));
}
function drag(el, dx, dy, at) {
  const r = el.getBoundingClientRect();
  const x0 = r.left + (at ? at[0] : r.width / 2), y0 = r.top + (at ? at[1] : r.height / 2);
  pointer(el, 'pointerdown', x0, y0);
  for (let i = 1; i <= 10; i++) pointer(document, 'pointermove', x0 + dx * i / 10, y0 + dy * i / 10);
  pointer(document, 'pointerup', x0 + dx, y0 + dy);
}
const pos = {};
window.__benchCase = {
  setup() {
    interact('.drag').draggable({ listeners: { move(e) { const p = pos[e.target.id] || (pos[e.target.id] = { x: 0, y: 0 }); p.x += e.dx; p.y += e.dy; e.target.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)'; } },
      modifiers: [interact.modifiers.restrictRect({ restriction: 'parent' })] })
      .resizable({ edges: { right: true, bottom: true }, listeners: { move(e) { e.target.style.width = e.rect.width + 'px'; e.target.style.height = e.rect.height + 'px'; } } });
  },
  steps: [
    { name: 'drag box 1 by (200, 120)', run: () => drag($('#d1'), 200, 120) },
    { name: 'drag box 2 past the parent', run: () => drag($('#d2'), 900, 900) },
    { name: 'resize box 3 from its corner', run: () => { const r = $('#d3').getBoundingClientRect(); drag($('#d3'), 80, 60, [r.width - 2, r.height - 2]); } }
  ],
  probe() { const r = (s) => { const b = $(s).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { d1: r('#d1'), d2: r('#d2'), d3: r('#d3') }; },
};
