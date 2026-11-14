// SPDX-License-Identifier: MIT
// js-framework-benchmark, keyed Preact with hooks (the React version's
// components on preact; updates flushed with options.debounceRendering).
import { h, render, options, Fragment } from 'preact';
import { useReducer } from 'preact/hooks';
import { memo } from 'preact/compat';

let queue = [];
options.debounceRendering = (cb) => queue.push(cb);
const flush = () => { while (queue.length) queue.shift()(); };
function reducer(s, a) {
  switch (a.t) {
    case 'run': return { data: jsfbData(1000), selected: 0 };
    case 'lots': return { data: jsfbData(10000), selected: 0 };
    case 'add': return { data: s.data.concat(jsfbData(1000)), selected: s.selected };
    case 'update': { const d = s.data.slice(); for (let i = 0; i < d.length; i += 10) d[i] = { id: d[i].id, label: d[i].label + ' !!!' }; return { data: d, selected: s.selected }; }
    case 'clear': return { data: [], selected: 0 };
    case 'swap': { if (s.data.length <= 998) return s; const d = s.data.slice(); const t = d[1]; d[1] = d[998]; d[998] = t; return { data: d, selected: s.selected }; }
    case 'remove': { const d = s.data.slice(); d.splice(a.i, 1); return { data: d, selected: s.selected }; }
    case 'select': return { data: s.data, selected: s.data[a.i].id };
  }
  return s;
}
const Row = memo(function Row({ item, selected }) {
  return <tr className={selected ? 'danger' : ''}>
    <td className="col-md-1">{item.id}</td>
    <td className="col-md-4"><a>{item.label}</a></td>
    <td className="col-md-1"><a><span className="glyphicon glyphicon-remove" aria-hidden="true" /></a></td>
    <td className="col-md-6" />
  </tr>;
});
let dispatchRef = null;
function Main() {
  const [s, dispatch] = useReducer(reducer, { data: [], selected: 0 });
  dispatchRef = dispatch;
  return <>{s.data.map((item) => <Row key={item.id} item={item} selected={s.selected === item.id} />)}</>;
}
render(<Main />, document.getElementById('tbody'));
flush();
const go = (a) => () => { dispatchRef(a); flush(); };
window.__benchCase = {
  setup: () => { flush(); },
  steps: jsfbSteps({ run: go({ t: 'run' }), runLots: go({ t: 'lots' }), add: go({ t: 'add' }), update: go({ t: 'update' }), clear: go({ t: 'clear' }), swapRows: go({ t: 'swap' }),
    select: (i) => go({ t: 'select', i })(), remove: (i) => go({ t: 'remove', i })() }),
  probe: jsfbProbe,
};
