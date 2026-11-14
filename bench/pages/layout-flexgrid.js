// SPDX-License-Identifier: MIT
// Flexbox and grid layout of ~2 000 nested boxes: cards in an auto-fill
// grid, each a flex column with a flex row header and wrapping chips
// (synthetic test 3). The steps change what layout depends on.
(function () {
  var host = document.getElementById('app');
  window.__benchCase = {
    setup: function () {
      var s = '';
      for (var i = 0; i < 150; i++) {
        s += '<div class="card"><div class="head"><span class="dot"></span><b>Card ' + i + '</b><span class="grow"></span><i>' + (i * 7 % 100) + '%</i></div>' +
          '<div class="chips">';
        for (var k = 0; k < 8; k++) s += '<span class="chip">tag' + k + '</span>';
        s += '</div><div class="foot"><span>' + i + ' items</span><span class="grow"></span><button>Open</button></div></div>';
      }
      host.innerHTML = s;
    },
    steps: [
      { name: 'narrow container', run: function () { host.style.width = '700px'; } },
      { name: 'wide container', run: function () { host.style.width = '1180px'; } },
      { name: 'cards as flex-wrap', run: function () { host.className = 'flex'; } },
      { name: 'column direction heads', run: function () { host.classList.add('colhead'); } },
      { name: 'root font-size 16px', run: function () { document.body.style.fontSize = '16px'; } },
      { name: 'grid fixed 4 columns', run: function () { host.className = 'grid4'; } }
    ],
    probe: function () {
      var c = host.querySelectorAll('.card');
      var a = c[0].getBoundingClientRect(), b = c[c.length - 1].getBoundingClientRect(), ch = c[5].querySelector('.chip:last-child').getBoundingClientRect();
      var r = function (x) { return [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]; };
      return { cards: c.length, first: r(a), last: r(b), chip: r(ch) };
    }
  };
})();
