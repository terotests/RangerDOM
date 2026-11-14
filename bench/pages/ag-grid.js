// SPDX-License-Identifier: MIT
// AG Grid Community: 2 000 rows x 8 columns with its Quartz theme (CSS put
// in by the grid's theming code), row and column virtualisation, sort,
// quick filter, scroll, column resize, row selection.
import { createGrid, ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
ModuleRegistry.registerModules([AllCommunityModule]);
const makes = ['Toyota', 'Ford', 'Porsche', 'Volvo', 'Saab', 'BMW', 'Fiat', 'Skoda'];
const rows = [];
for (let i = 0; i < 2000; i++) rows.push({ id: i, make: makes[i % 8], model: 'M' + ((i * 13) % 97), price: 10000 + (i * 7919) % 90000, year: 1990 + (i % 35), km: (i * 3571) % 300000, electric: i % 4 === 0, city: ['Oulu', 'Turku', 'Espoo', 'Tampere'][i % 4] });
let api;
const body = () => document.querySelector('.ag-body-viewport');
function wait(pred, ms) { const end = Date.now() + (ms || 3000); return new Promise((ok) => { (function f() { if (pred() || Date.now() > end) ok(); else setTimeout(f, 20); })(); }); }
window.__benchCase = {
  setup() {
    api = createGrid(document.getElementById('grid'), {
      rowData: rows, columnDefs: [{ field: 'id', width: 80 }, { field: 'make' }, { field: 'model' }, { field: 'price', valueFormatter: (p) => p.value.toLocaleString('en-US') + ' $' }, { field: 'year' }, { field: 'km' }, { field: 'electric' }, { field: 'city' }],
      defaultColDef: { sortable: true, filter: true, resizable: true }, rowSelection: { mode: 'singleRow' }, animateRows: false,
    });
    return wait(() => document.querySelectorAll('.ag-row').length > 5);
  },
  steps: [
    { name: 'sort by price', run: () => { api.applyColumnState({ state: [{ colId: 'price', sort: 'desc' }] }); return wait(() => true); } },
    { name: 'scroll to row 1000', run: () => { api.ensureIndexVisible(1000, 'top'); return wait(() => !!document.querySelector('.ag-row[row-index="1000"]')); } },
    { name: 'quick filter "Volvo"', run: () => { api.setGridOption('quickFilterText', 'Volvo'); return wait(() => api.getDisplayedRowCount() === 250); } },
    { name: 'select first row', run: () => { api.getDisplayedRowAtIndex(0).setSelected(true); } },
    { name: 'resize model column', run: () => { api.setColumnWidths([{ key: 'model', newWidth: 260 }]); } },
    { name: 'clear filter, scroll top', run: () => { api.setGridOption('quickFilterText', ''); api.ensureIndexVisible(0, 'top'); return wait(() => api.getDisplayedRowCount() === 2000); } }
  ],
  probe() {
    const r = Array.from(document.querySelectorAll('.ag-center-cols-container .ag-row, .ag-grid-scrolling-container .ag-row')).sort((a, b) => a.getAttribute('row-index') - b.getAttribute('row-index'));
    const cell = (row, col) => { const c = row && row.querySelector('[col-id="' + col + '"]'); return c ? c.textContent : null; };
    return { displayed: api.getDisplayedRowCount(), domRows: r.length > 0 && r.length < 80, firstIndex: r[0] ? r[0].getAttribute('row-index') : null, firstPrice: cell(r[0], 'price'), selected: document.querySelectorAll('.ag-row-selected').length, modelW: api.getColumn('model').getActualWidth() };
  },
};
