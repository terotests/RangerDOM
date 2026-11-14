// SPDX-License-Identifier: MIT
// The CSS cascade on a 5 000-node tree with ~200 rules (descendant, child,
// attribute, :nth-child, :not, :is, :hover-free) and one subject :has()
// rule of Monaco's kind (li:has(input[type=checkbox])): class changes at
// the root and deep inside, an attribute, a checkbox, a new rule
// (synthetic test 6). Probe = computed styles of a few nodes.
(function () {
  var host = document.getElementById('app');
  var deep = null, box = null;
  function sheet() {
    var s = [];
    for (var i = 0; i < 40; i++) {
      s.push('.t' + i + ' li.c' + i + ' > span { color: rgb(' + (i * 6) + ', 40, 90); }');
      s.push('ul.l' + (i % 5) + ' li:nth-child(' + (i + 2) + 'n) { padding-left: ' + (i % 7) + 'px; }');
      s.push('[data-k="' + i + '"] .v { font-weight: ' + (i % 2 ? 700 : 400) + '; }');
      s.push('.dark li:not(.c' + i + ') > em.e' + i + ' { color: #ddd; }');
      s.push(':is(.a' + i + ', .b' + i + ') li span.s { margin-left: ' + (i % 4) + 'px; }');
    }
    s.push('.rendered li:has(input[type=checkbox]) { list-style: none; background: #eef; }');
    s.push('.dark { background: #222; color: #eee; } li[aria-selected=true] > span { outline: 1px solid red; }');
    return s.join('\n');
  }
  window.__benchCase = {
    setup: function () {
      var st = document.createElement('style'); st.textContent = sheet(); document.head.appendChild(st);
      var h = '';
      for (var a = 0; a < 25; a++) {
        h += '<ul class="l' + (a % 5) + ' t' + a + ' a' + a + '" data-k="' + a + '">';
        for (var b = 0; b < 20; b++) {
          h += '<li class="c' + (b % 40) + '"><span class="s">' + a + '.' + b + '</span> <em class="e' + b + '">e</em> <i class="v">v</i>';
          h += '<ul class="l' + (b % 5) + '">';
          for (var c = 0; c < 2; c++) h += '<li class="c' + c + '"><span class="s">' + a + '.' + b + '.' + c + '</span>' + (c === 1 && b % 5 === 0 ? ' <input type="text">' : '') + '</li>';
          h += '</ul></li>';
        }
        h += '</ul>';
      }
      host.innerHTML = h;
      deep = host.children[12].children[10].querySelector('ul li:last-child');
      box = deep.querySelector('input');
    },
    steps: [
      { name: 'theme class on root', run: function () { host.classList.add('dark'); } },
      { name: 'class on a deep li', run: function () { deep.className = 'c7 picked'; } },
      { name: 'attribute on a deep li', run: function () { deep.setAttribute('aria-selected', 'true'); } },
      { name: 'make deep input a checkbox (:has)', run: function () { box.type = 'checkbox'; } },
      { name: ':has page, 20 deep class changes', run: function () { host.classList.add('rendered'); for (var i = 0; i < 20; i++) host.children[i].children[3].className = 'c' + (i % 9); } },
      { name: 'add a rule', run: function () { var st = document.createElement('style'); st.textContent = 'li span.s { letter-spacing: 1px; }'; document.head.appendChild(st); } }
    ],
    probe: function () {
      var g = function (e, p) { return getComputedStyle(e)[p]; };
      var sp = deep.querySelector('span');
      return { n: host.querySelectorAll('*').length, bg: g(host, 'backgroundColor'), deepColor: g(sp, 'color'), outline: g(sp, 'outlineStyle'), liBg: g(deep, 'backgroundColor'), ls: g(sp, 'letterSpacing'), pad: g(host.children[3].children[4], 'paddingLeft') };
    }
  };
})();
