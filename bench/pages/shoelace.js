// SPDX-License-Identifier: MIT
// Shoelace: Web Components (customElements, Shadow DOM, slots, adopted
// styles via Lit, CSS custom properties from its light theme): buttons,
// inputs, a tab group, a details panel, a dialog shown and hidden.
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js';
import '@shoelace-style/shoelace/dist/components/tab/tab.js';
import '@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js';
import '@shoelace-style/shoelace/dist/components/details/details.js';
import '@shoelace-style/shoelace/dist/components/dialog/dialog.js';
import '@shoelace-style/shoelace/dist/components/badge/badge.js';
import '@shoelace-style/shoelace/dist/components/switch/switch.js';
import { setAnimation } from '@shoelace-style/shoelace/dist/utilities/animation-registry.js';
const $ = (s) => document.querySelector(s);
function wait(pred, ms) { const end = Date.now() + (ms || 3000); return new Promise((ok) => { (function f() { if (pred() || Date.now() > end) ok(); else setTimeout(f, 20); })(); }); }
const ready = () => Promise.all(['sl-button', 'sl-input', 'sl-tab-group', 'sl-details', 'sl-dialog'].map((t) => customElements.whenDefined(t)));
window.__benchCase = {
  setup() { return ready().then(() => wait(() => $('sl-button') && $('sl-button').shadowRoot && $('sl-button').shadowRoot.querySelector('button'))); },
  steps: [
    { name: 'switch tab', run: () => { $('sl-tab-group').show('custom'); return wait(() => $('sl-tab-panel[name=custom]').active); } },
    { name: 'open details', run: () => { const d = $('sl-details'); d.show(); return wait(() => d.open, 2000).then(() => window.__bench.sleep(400)); } },
    { name: 'type into input', run: () => { const i = $('sl-input'); i.value = 'Hello'; i.dispatchEvent(new Event('sl-input')); return i.updateComplete; } },
    { name: 'open dialog', run: () => { const d = $('sl-dialog'); return d.show(); } },
    { name: 'close dialog', run: () => { const d = $('sl-dialog'); return d.hide(); } },
    { name: 'add 50 buttons', run: () => { const h = $('#more'); for (let i = 0; i < 50; i++) { const b = document.createElement('sl-button'); b.variant = ['default', 'primary', 'success', 'danger'][i % 4]; b.size = 'small'; b.textContent = 'B' + i; h.appendChild(b); } return Promise.all(Array.from(h.children).map((b) => b.updateComplete)); } }
  ],
  probe() {
    const b = $('sl-button'), inner = b && b.shadowRoot ? b.shadowRoot.querySelector('button') : null;
    const r = inner ? inner.getBoundingClientRect() : null;
    return { defined: !!customElements.get('sl-button'), shadow: !!inner, btnBg: inner ? getComputedStyle(inner).backgroundColor : null, btnH: r ? Math.round(r.height) : null,
      tab: ($('sl-tab[active]') || {}).panel || null, details: $('sl-details').open, input: $('sl-input').value, dialog: $('sl-dialog').open, more: $('#more').children.length };
  },
};
// no motion (as prefers-reduced-motion): the steps wait on promises, not animations
for (const n of ['dialog.show', 'dialog.hide', 'dialog.overlay.show', 'dialog.overlay.hide', 'dialog.denyClose', 'details.show', 'details.hide']) setAnimation(document.body, n, null);
