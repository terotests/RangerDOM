// SPDX-License-Identifier: MIT
// js-framework-benchmark, keyed React with hooks (written here after the
// benchmark's react-hooks implementation: one reducer, memoised rows).
import { memo, useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

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
const Row = memo(function Row({ item, selected, dispatch }) {
  return <tr className={selected ? 'danger' : ''}>
    <td className="col-md-1">{item.id}</td>
    <td className="col-md-4"><a onClick={() => dispatch({ t: 'select', id: item.id })}>{item.label}</a></td>
    <td className="col-md-1"><a onClick={() => dispatch({ t: 'remove', id: item.id })}><span className="glyphicon glyphicon-remove" aria-hidden="true" /></a></td>
    <td className="col-md-6" />
  </tr>;
});
let dispatchRef = null;
function Main() {
  const [s, dispatch] = useReducer(reducer, { data: [], selected: 0 });
  dispatchRef = dispatch;
  return <>{s.data.map((item) => <Row key={item.id} item={item} selected={s.selected === item.id} dispatch={dispatch} />)}</>;
}
const root = createRoot(document.getElementById('tbody'));
flushSync(() => root.render(<Main />));
const go = (a) => () => flushSync(() => dispatchRef(a));
window.__benchCase = {
  steps: jsfbSteps({ run: go({ t: 'run' }), runLots: go({ t: 'lots' }), add: go({ t: 'add' }), update: go({ t: 'update' }), clear: go({ t: 'clear' }), swapRows: go({ t: 'swap' }),
    select: (i) => go({ t: 'select', i })(), remove: (i) => go({ t: 'remove', i })() }),
  probe: jsfbProbe,
};
