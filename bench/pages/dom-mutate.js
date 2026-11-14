// SPDX-License-Identifier: MIT
// DOM mutation on 1 000 rows: texts and classes, every 10th row, swap,
// remove, reverse (synthetic test 2).
(function () {
  var host = document.getElementById('app');
  var rows = [];
  function row(i) {
    var r = document.createElement('div'); r.className = 'row';
    r.innerHTML = '<span class="id">' + i + '</span><span class="label">Row ' + i + '</span><span class="tag">new</span>';
    return r;
  }
  window.__benchCase = {
    setup: function () { for (var i = 0; i < 1000; i++) { rows.push(row(i)); host.appendChild(rows[i]); } },
    steps: [
      { name: 'update all texts + classes', run: function () { for (var i = 0; i < rows.length; i++) { rows[i].children[1].textContent = 'Changed ' + i; rows[i].className = 'row ' + (i % 3 === 0 ? 'hot' : 'cold'); } } },
      { name: 'update every 10th', run: function () { for (var i = 0; i < rows.length; i += 10) rows[i].children[1].textContent += ' !!!'; } },
      { name: 'swap rows 1 and 998', run: function () { var a = rows[1], b = rows[998], an = a.nextSibling; host.insertBefore(a, b.nextSibling); host.insertBefore(b, an); rows[1] = b; rows[998] = a; } },
      { name: 'remove row 500', run: function () { host.removeChild(rows[500]); rows.splice(500, 1); } },
      { name: 'reverse order', run: function () { for (var i = rows.length - 1; i >= 0; i--) host.appendChild(rows[i]); rows.reverse(); } },
      { name: 'toggle class on all', run: function () { for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', i % 2 === 0); } },
      { name: 'set style on all', run: function () { for (var i = 0; i < rows.length; i++) rows[i].style.paddingLeft = (i % 5) * 4 + 'px'; } }
    ],
    probe: function () { var c = host.children; return { rows: c.length, first: c[0].textContent, second: c[1].textContent, last: c[c.length - 1].textContent, hot: host.querySelectorAll('.hot').length, sel: host.querySelectorAll('.sel').length }; }
  };
})();
