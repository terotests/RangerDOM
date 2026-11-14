// SPDX-License-Identifier: MIT
// js-framework-benchmark, keyed vanilla JS (written here after the
// benchmark's spec: the same table, row template and operations).
(function () {
  var tbody = document.getElementById('tbody'), data = [], rows = [], selected = null;
  var tpl = document.createElement('tr');
  tpl.innerHTML = '<td class="col-md-1"></td><td class="col-md-4"><a class="lbl"></a></td><td class="col-md-1"><a class="remove"><span class="remove glyphicon glyphicon-remove" aria-hidden="true"></span></a></td><td class="col-md-6"></td>';
  function make(d) { var tr = tpl.cloneNode(true); tr.firstChild.textContent = d.id; tr.childNodes[1].firstChild.textContent = d.label; tr.data = d; return tr; }
  function clear() { tbody.textContent = ''; data = []; rows = []; selected = null; }
  function append(n) { var f = document.createDocumentFragment(); var d = jsfbData(n); for (var i = 0; i < n; i++) { var r = make(d[i]); rows.push(r); f.appendChild(r); } data = data.concat(d); tbody.appendChild(f); }
  var act = {
    run: function () { clear(); append(1000); },
    runLots: function () { clear(); append(10000); },
    add: function () { append(1000); },
    update: function () { for (var i = 0; i < data.length; i += 10) { data[i].label += ' !!!'; rows[i].childNodes[1].firstChild.firstChild.nodeValue = data[i].label; } },
    clear: clear,
    swapRows: function () { if (rows.length > 998) { var a = rows[1], b = rows[998]; var an = a.nextSibling; tbody.insertBefore(a, b.nextSibling); tbody.insertBefore(b, an); rows[1] = b; rows[998] = a; var t = data[1]; data[1] = data[998]; data[998] = t; } },
    select: function (i) { if (selected) selected.className = ''; selected = rows[i]; selected.className = 'danger'; },
    remove: function (i) { tbody.removeChild(rows[i]); rows.splice(i, 1); data.splice(i, 1); }
  };
  window.__benchCase = { steps: jsfbSteps(act), probe: jsfbProbe };
})();
