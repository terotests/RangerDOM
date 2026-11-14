// SPDX-License-Identifier: MIT
// 500 elements moved with transform every animation frame for 30 frames
// (synthetic test 5). The step's total time / 30 is the frame time the
// page sees; probe = frames run and the first box's transform.
(function () {
  var host = document.getElementById('app'), els = [], frames = 0;
  window.__benchCase = {
    setup: function () {
      for (var i = 0; i < 500; i++) { var e = document.createElement('div'); e.className = 'b'; e.style.left = (i % 25) * 46 + 'px'; e.style.top = Math.floor(i / 25) * 38 + 'px'; e.textContent = i; host.appendChild(e); els.push(e); }
    },
    steps: [1, 2].map(function (round) {
      return { name: '30 frames (' + round + ')', run: function () {
        var k = 0;
        return new Promise(function (ok) {
          function f() {
            frames++; k++;
            for (var i = 0; i < els.length; i++) els[i].style.transform = 'translate(' + ((k * 3 + i) % 20) + 'px,' + ((k * 2) % 12) + 'px) rotate(' + ((k * 6 + i) % 360) + 'deg)';
            if (k < 30) requestAnimationFrame(f); else ok();
          }
          requestAnimationFrame(f);
        });
      } };
    }).concat([{ name: 'opacity fade 30 frames', run: function () {
      var k = 0;
      return new Promise(function (ok) { function f() { k++; for (var i = 0; i < els.length; i++) els[i].style.opacity = String(1 - k / 40); if (k < 30) requestAnimationFrame(f); else ok(); } requestAnimationFrame(f); });
    } }]),
    probe: function () { return { frames: frames, t0: els[0].style.transform.replace(/\s/g, ''), o: els[0].style.opacity }; }
  };
})();
