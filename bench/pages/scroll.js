// SPDX-License-Identifier: MIT
// Scrolling a long list in an overflow:auto box: scrollTop jumps, then 20
// frames of smooth scrolling (synthetic test 4). Probe = scrollTop and the
// row under the box's middle (elementFromPoint).
(function () {
  var box = document.getElementById('box');
  window.__benchCase = {
    setup: function () { var s = ''; for (var i = 0; i < 3000; i++) s += '<div class="r" id="r' + i + '"><b>' + i + '</b> Row with some text ' + i + ' <span>' + (i * 13 % 997) + '</span></div>'; box.innerHTML = s; },
    steps: [
      { name: 'scrollTop 2000', run: function () { box.scrollTop = 2000; } },
      { name: 'scrollTop 30000', run: function () { box.scrollTop = 30000; } },
      { name: 'scrollTop 0', run: function () { box.scrollTop = 0; } },
      { name: '20 frames +100px', run: function () { var k = 0; return new Promise(function (ok) { function f() { box.scrollTop += 100; if (++k < 20) requestAnimationFrame(f); else ok(); } requestAnimationFrame(f); }); } },
      { name: 'scrollIntoView row 2500', run: function () { document.getElementById('r2500').scrollIntoView(); } }
    ],
    probe: function () {
      var r = box.getBoundingClientRect();
      var e = document.elementFromPoint(r.left + 40, r.top + r.height / 2);
      while (e && e.className !== 'r') e = e.parentElement;
      return { top: Math.round(box.scrollTop), height: box.scrollHeight, mid: e ? e.id : null };
    }
  };
})();
