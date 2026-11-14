// SPDX-License-Identifier: MIT
// PrimeReact 10 (styled, Lara theme): DataTable with sorting, paging, global
// filter and row selection, Dropdown overlay, Dialog with mask, InputText,
// Button, Tag, ProgressBar.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PrimeReactProvider } from 'primereact/api';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Dropdown } from 'primereact/dropdown';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';

const names = ['Amy', 'Bernardo', 'Elwin', 'Ioni', 'Ivan', 'Onyama', 'Stephen', 'Xuxue', 'Asiya', 'Anna'];
const countries = ['Finland', 'Sweden', 'Norway', 'Germany', 'France', 'Spain', 'Italy', 'Japan'];
const statuses = ['qualified', 'new', 'negotiation', 'unqualified', 'renewal'];
const sev = { qualified: 'success', new: 'info', negotiation: 'warning', unqualified: 'danger', renewal: null };
const rows = [];
for (let i = 0; i < 200; i++) rows.push({ id: 1000 + i, name: names[i % 10] + ' ' + String.fromCharCode(65 + (i * 7) % 26) + '.', country: countries[(i * 3) % 8], status: statuses[(i * 5) % 5], balance: (i * 7919) % 100000, activity: (i * 37) % 100 });

let api = {};
function App() {
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState(null);
  const [first, setFirst] = useState(0);
  const [sortField, setSortField] = useState(null);
  const [sortOrder, setSortOrder] = useState(null);
  const [city, setCity] = useState(null);
  const [dialog, setDialog] = useState(false);
  api = { setFilter, setSel, setFirst, setSort: (f, o) => { setSortField(f); setSortOrder(o); }, setDialog };
  return <PrimeReactProvider value={{ ripple: false }}>
    <div className="p-3">
      <div className="flex-bar">
        <span className="p-input-icon-left"><InputText id="q" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Global search" /></span>
        <Dropdown inputId="city" value={city} onChange={(e) => setCity(e.value)} options={countries} placeholder="Country" className="w-12rem" />
        <Button id="open" label="Details" onClick={() => setDialog(true)} />
      </div>
      <DataTable value={rows} paginator rows={10} first={first} onPage={(e) => setFirst(e.first)} sortField={sortField} sortOrder={sortOrder}
        onSort={(e) => { setSortField(e.sortField); setSortOrder(e.sortOrder); }} globalFilter={filter} selectionMode="single" selection={sel}
        onSelectionChange={(e) => setSel(e.value)} dataKey="id" size="small" stripedRows tableStyle={{ minWidth: '50rem' }}>
        <Column field="id" header="Id" sortable />
        <Column field="name" header="Name" sortable />
        <Column field="country" header="Country" sortable />
        <Column field="status" header="Status" body={(r) => <Tag value={r.status} severity={sev[r.status]} />} />
        <Column field="balance" header="Balance" sortable body={(r) => r.balance.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} />
        <Column field="activity" header="Activity" body={(r) => <ProgressBar value={r.activity} showValue={false} style={{ height: '6px' }} />} />
      </DataTable>
      <Dialog header="Customer" visible={dialog} style={{ width: '30rem' }} onHide={() => setDialog(false)}>
        <p className="m-0">Selected: {sel ? sel.name : 'none'}</p>
      </Dialog>
    </div>
  </PrimeReactProvider>;
}
const root = createRoot(document.getElementById('app'));
flushSync(() => root.render(<App />));
const $ = (s) => document.querySelector(s);
// (then a moment: PrimeReact applies the filter and drops the selection in effects)
const settle = () => new Promise((ok) => setTimeout(ok, 300));
const sync = (f) => () => { flushSync(f); return settle(); };
function wait(pred, ms) { const end = Date.now() + (ms || 3000); return new Promise((ok) => { (function f() { if (pred() || Date.now() > end) ok(); else setTimeout(f, 20); })(); }); }
window.__benchCase = {
  steps: [
    { name: 'sort by balance', run: sync(() => api.setSort('balance', -1)) },
    { name: 'next page', run: sync(() => api.setFirst(10)) },
    { name: 'global filter "Ivan"', run: sync(() => { api.setFirst(0); api.setFilter('Ivan'); }) },
    { name: 'select a row', run: () => { const tr = $('.p-datatable-tbody > tr'); tr.click(); return settle(); } },
    { name: 'open dropdown overlay', run: () => { $('.p-dropdown').click(); return wait(() => !!$('.p-dropdown-panel')); } },
    { name: 'pick an option', run: () => { const li = document.querySelectorAll('.p-dropdown-item')[2]; if (li) li.click(); return wait(() => !$('.p-dropdown-panel')).then(settle); } },
    { name: 'open dialog', run: () => { $('#open').click(); return wait(() => !!$('.p-dialog') && !!$('.p-dialog-mask')); } },
    { name: 'close dialog', run: () => { const b = $('.p-dialog-header-close'); if (b) b.click(); return wait(() => !$('.p-dialog'), 2000); } }
  ],
  probe: () => {
    const tr = document.querySelectorAll('.p-datatable-tbody > tr');
    return { rows: tr.length, first: tr[0] ? tr[0].children[0].textContent + ' ' + tr[0].children[1].textContent : null, selected: !!$('.p-datatable-tbody > tr.p-highlight'),
      page: ($('.p-paginator-page.p-highlight') || {}).textContent || null, dropdown: ($('.p-dropdown-label') || {}).textContent || null, panel: !!$('.p-dropdown-panel'), dialog: !!$('.p-dialog') };
  },
};
