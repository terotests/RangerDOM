// SPDX-License-Identifier: MIT
// Motion (vanilla animate): 120 boxes animated with transforms and opacity
// (Motion picks the Web Animations API when Element.animate exists, else
// its own frame loop), a spring, a stagger and a layout-ish width change.
import { animate, stagger } from 'motion';
const host = document.getElementById('app');
let els = [];
const fin = (a) => (a && a.finished ? a.finished : Promise.resolve());
window.__benchCase = {
  setup() { let s = ''; for (let i = 0; i < 120; i++) s += '<div class="b" style="left:' + (i % 15) * 74 + 'px;top:' + Math.floor(i / 15) * 80 + 'px">' + i + '</div>'; host.innerHTML = s; els = Array.from(host.children); },
  steps: [
    { name: 'tween x + rotate (0.4 s)', run: () => fin(animate(els, { x: 40, rotate: 90 }, { duration: 0.4 })) },
    { name: 'spring scale', run: () => fin(animate(els, { scale: [1, 1.3, 1] }, { type: 'spring', duration: 0.5 })) },
    { name: 'stagger opacity', run: () => fin(animate(els, { opacity: [1, 0.3] }, { delay: stagger(0.003), duration: 0.3 })) },
    { name: 'width (layout) 0.3 s', run: () => fin(animate(els.slice(0, 30), { width: '60px' }, { duration: 0.3 })) }
  ],
  probe() { const cs = getComputedStyle(els[7]); return { opacity: Math.round(parseFloat(cs.opacity) * 10) / 10, w: Math.round(els[0].getBoundingClientRect().width), tf: !!els[7].style.transform || cs.transform !== 'none' }; },
};
