// SPDX-License-Identifier: MIT
// Golden Layout 2: a docking layout of rows, columns and stacks of tabs;
// components added, a stack's tab switched, the container resized, an item
// removed (each a new geometry for every panel).
import { GoldenLayout } from 'golden-layout';
const host = document.getElementById('gl');
let gl;
const config = { root: { type: 'row', content: [
  { type: 'column', width: 30, content: [{ type: 'component', componentType: 'panel', title: 'Files', componentState: { n: 1 } }, { type: 'component', componentType: 'panel', title: 'Outline', componentState: { n: 2 } }] },
  { type: 'stack', width: 45, content: [{ type: 'component', componentType: 'panel', title: 'Editor A', componentState: { n: 3 } }, { type: 'component', componentType: 'panel', title: 'Editor B', componentState: { n: 4 } }] },
  { type: 'column', width: 25, content: [{ type: 'component', componentType: 'panel', title: 'Console', componentState: { n: 5 } }] }] } };
function wait(pred, ms) { const end = Date.now() + (ms || 3000); return new Promise((ok) => { (function f() { if (pred() || Date.now() > end) ok(); else setTimeout(f, 20); })(); }); }
window.__benchCase = {
  setup() {
    gl = new GoldenLayout(host);
    gl.resizeWithContainerAutomatically = false;
    gl.registerComponentFactoryFunction('panel', (container, state) => { const d = document.createElement('div'); d.className = 'pane'; d.textContent = container.title + ' #' + state.n; container.element.appendChild(d); });
    gl.loadLayout(config);
    gl.setSize(1100, 700);
  },
  steps: [
    { name: 'add a component', run: () => { gl.addComponent('panel', { n: 6 }, 'Terminal'); } },
    { name: 'switch tab in stack', run: () => { const tabs = host.querySelectorAll('.lm_tab'); const b = Array.from(tabs).find((t) => /Editor B/.test(t.textContent)); if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true })); } },
    { name: 'resize to 900 x 600', run: () => { host.style.width = '900px'; host.style.height = '600px'; gl.setSize(900, 600); } },
    { name: 'remove first panel', run: () => { const c = gl.rootItem.contentItems[0].contentItems[0]; c.remove(); } },
    { name: 'resize to 1100 x 700', run: () => { host.style.width = '1100px'; host.style.height = '700px'; gl.setSize(1100, 700); } }
  ],
  probe() {
    const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    const panes = Array.from(host.querySelectorAll('.lm_content')).filter((e) => e.offsetParent !== null || getComputedStyle(e).display !== 'none');
    return { tabs: host.querySelectorAll('.lm_tab').length, active: Array.from(host.querySelectorAll('.lm_tab.lm_active')).map((t) => t.textContent.trim()).join('|'), boxes: panes.slice(0, 6).map(r) };
  },
};
