// SPDX-License-Identifier: MIT
// Hit testing: overlapping, z-indexed, clipped (overflow:hidden), rotated
// and pointer-events:none boxes; elementFromPoint over a 40 x 25 grid of
// points, and clicks dispatched at points (synthetic test 7). Probe = the
// ids hit (compared with Chromium's) and their count.
(function () {
  var host = document.getElementById('app');
  function hits() {
    var out = [];
    for (var y = 0; y < 25; y++) for (var x = 0; x < 40; x++) { var e = document.elementFromPoint(10 + x * 28, 10 + y * 28); out.push(e ? (e.id || e.tagName) : '-'); }
    return out;
  }
  var last = [];
  window.__benchCase = {
    setup: function () {
      var s = '';
      for (var i = 0; i < 60; i++) {
        var x = (i * 97) % 1000, y = (i * 53) % 600;
        var cls = i % 6 === 0 ? 'rot' : i % 6 === 1 ? 'clip' : i % 6 === 2 ? 'none' : '';
        s += '<div id="b' + i + '" class="b ' + cls + '" style="left:' + x + 'px;top:' + y + 'px;z-index:' + (i % 4) + '">' + (cls === 'clip' ? '<div id="in' + i + '" class="inner"></div>' : i) + '</div>';
      }
      host.innerHTML = s;
    },
    steps: [
      { name: 'elementFromPoint x1000', run: function () { last = hits(); } },
      { name: 'move boxes, x1000 again', run: function () { for (var i = 0; i < 60; i += 3) host.children[i].style.left = (parseInt(host.children[i].style.left) + 40) + 'px'; return window.__bench.frames(2).then(function () { last = hits(); }); } }
    ],
    probe: function () { var n = {}; last.forEach(function (h) { n[h] = 1; }); return { distinct: Object.keys(n).length, hits: last.join(',') }; }
  };
})();
