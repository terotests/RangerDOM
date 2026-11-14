// SPDX-License-Identifier: MIT
// Bootstrap 5 components with its own script (bootstrap.bundle: Popper
// dropdown, collapse, tabs, modal with backdrop and transitions).
(function () {
  var $ = function (s) { return document.querySelector(s); };
  function shown(s) { var e = $(s); return !!e && e.classList.contains('show'); }
  // (then the transitions' end: Bootstrap's fades and collapses take 0.15-0.35 s)
  function wait(pred, ms) { var end = Date.now() + (ms || 3000); return new Promise(function (ok) { (function f() { if (pred() || Date.now() > end) setTimeout(ok, 400); else setTimeout(f, 20); })(); }); }
  window.__benchCase = {
    setup: function () {
      var c = '', st = ['Paid', 'Open', 'Late'], cls = ['success', 'warning', 'danger'];
      for (var i = 0; i < 6; i++) c += '<div class="col"><div class="card h-100 shadow-sm"><div class="card-body"><h6 class="card-subtitle text-body-secondary">Metric ' + i + '</h6><p class="card-text fs-4 fw-semibold mb-0">' + (i * 1234 % 9999) + '</p><span class="badge text-bg-' + cls[i % 3] + '">' + st[i % 3] + '</span></div></div></div>';
      $('#cards').innerHTML = c;
      var r = '';
      for (var k = 0; k < 40; k++) r += '<tr><td>' + (1000 + k) + '</td><td>Customer ' + k + '</td><td><span class="badge text-bg-' + cls[k % 3] + '">' + st[k % 3] + '</span></td><td class="text-end">' + (k * 37.5).toFixed(2) + ' &euro;</td></tr>';
      $('#rows').innerHTML = r;
    },
    steps: [
      { name: 'open dropdown (Popper)', run: function () { bootstrap.Dropdown.getOrCreateInstance($('#dd')).show(); return wait(function () { return shown('.dropdown-menu'); }); } },
      { name: 'close dropdown', run: function () { bootstrap.Dropdown.getOrCreateInstance($('#dd')).hide(); return wait(function () { return !shown('.dropdown-menu'); }); } },
      { name: 'accordion: open second', run: function () { bootstrap.Collapse.getOrCreateInstance('#c2').show(); return wait(function () { return shown('#c2') && !$('#c2').classList.contains('collapsing'); }); } },
      { name: 'tab: form', run: function () { bootstrap.Tab.getOrCreateInstance($('#tab2')).show(); return wait(function () { return shown('#p2'); }); } },
      { name: 'form validation styles', run: function () { $('#form').classList.add('was-validated'); } },
      { name: 'open modal', run: function () { bootstrap.Modal.getOrCreateInstance('#m').show(); return wait(function () { return shown('#m') && !!$('.modal-backdrop.show'); }); } },
      { name: 'close modal', run: function () { bootstrap.Modal.getOrCreateInstance('#m').hide(); return wait(function () { return !$('.modal-backdrop'); }); } }
    ],
    probe: function () {
      var menu = $('.dropdown-menu'), r = menu.getBoundingClientRect();
      return { menu: shown('.dropdown-menu'), menuAt: shown('.dropdown-menu') ? [Math.round(r.left), Math.round(r.top)] : null, c2: shown('#c2'), p2: shown('#p2'), modal: shown('#m'), backdrop: !!$('.modal-backdrop'),
        body: document.body.className, invalid: getComputedStyle($('#fn')).borderTopColor };
    }
  };
})();
