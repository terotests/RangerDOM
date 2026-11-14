// SPDX-License-Identifier: MIT
// DOM creation and removal: rows of a table-like list made with
// createElement / textContent / appendChild, then removed.
(function () {
  var host = document.getElementById('app');
  function make(n, from) {
    var f = document.createDocumentFragment();
    for (var i = 0; i < n; i++) {
      var r = document.createElement('div'); r.className = 'row' + (i % 2 ? ' odd' : '');
      var a = document.createElement('span'); a.className = 'id'; a.textContent = String(from + i);
      var b = document.createElement('span'); b.className = 'label'; b.textContent = 'Item number ' + (from + i);
      var c = document.createElement('a'); c.href = '#'; c.className = 'del'; c.textContent = 'x';
      r.appendChild(a); r.appendChild(b); r.appendChild(c); f.appendChild(r);
    }
    host.appendChild(f);
  }
  window.__benchCase = {
    steps: [
      { name: 'create 1000', run: function () { make(1000, 0); } },
      { name: 'clear 1000', run: function () { host.textContent = ''; } },
      { name: 'create 10000', run: function () { make(10000, 0); } },
      { name: 'append 1000', run: function () { make(1000, 10000); } },
      { name: 'clear 11000', run: function () { while (host.lastChild) host.removeChild(host.lastChild); } },
      { name: 'innerHTML 2000', run: function () { var s = ''; for (var i = 0; i < 2000; i++) s += '<div class="row"><span class="id">' + i + '</span><span class="label">Html ' + i + '</span><a class="del" href="#">x</a></div>'; host.innerHTML = s; } }
    ],
    probe: function () { var r = host.children; return { rows: r.length, first: r.length ? r[0].textContent : '', last: r.length ? r[r.length - 1].textContent : '' }; }
  };
})();
