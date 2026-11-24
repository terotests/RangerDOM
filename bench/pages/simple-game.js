// SPDX-License-Identifier: MIT
// A small game-like screen with simple CSS (class selectors only): what a
// page that uses no special feature costs.
(function () {
  var game = document.getElementById('game');
  var score = null, board = null, sprite = null, trail = null, tiles = [], points = 0;
  function frame() { return new Promise(function (ok) { requestAnimationFrame(function () { ok(); }); }); }
  function makeBoard(n, seed) {
    board.innerHTML = '';
    tiles = [];
    for (var i = 0; i < n; i++) {
      var t = document.createElement('div');
      t.className = 'tile';
      var l = document.createElement('span'); l.className = 'label'; l.textContent = 'Tile ' + (i + seed);
      t.appendChild(l);
      board.appendChild(t);
      tiles.push(t);
    }
    sprite = document.createElement('div'); sprite.className = 'sprite';
    board.appendChild(sprite);
    // a shape a game moves by its d (drawn again, nothing laid out)
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'trail'); svg.setAttribute('viewBox', '0 0 200 100');
    trail = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    trail.setAttribute('d', 'M0 0 L10 10'); trail.setAttribute('fill', 'none'); trail.setAttribute('stroke', '#fd3');
    svg.appendChild(trail);
    board.appendChild(svg);
  }
  window.__benchCase = {
    setup: function () {
      game.innerHTML = '<div class="bar"><span>Level 1</span><span class="score">0</span><span>Lives 3</span></div><div class="board"></div>';
      score = game.querySelector('.score'); board = game.querySelector('.board');
      makeBoard(60, 0);
    },
    steps: [
      { name: 'tap a tile', run: function () { tiles[7].classList.add('hit'); points += 10; score.textContent = String(points); } },
      { name: 'score text x10', run: function () { var p = Promise.resolve(); for (var i = 0; i < 10; i++) p = p.then(function () { points++; score.textContent = String(points); return frame(); }); return p; } },
      { name: 'sprite 30 frames', run: function () { var p = Promise.resolve(); for (var i = 0; i < 30; i++) (function (i) { p = p.then(function () { sprite.style.transform = 'translate(' + (i * 20) + 'px,' + (i * 10) + 'px)'; return frame(); }); })(i); return p; } },
      { name: 'path 30 frames', run: function () { var p = Promise.resolve(); for (var i = 0; i < 30; i++) (function (i) { p = p.then(function () { trail.setAttribute('d', 'M0 0 L' + (i * 6) + ' ' + (i * 3) + ' L' + (200 - i * 6) + ' 100 Z'); if (i === 15) trail.setAttribute('stroke', '#e84'); return frame(); }); })(i); return p; } },
      { name: 'mark 10 tiles done', run: function () { for (var i = 0; i < 10; i++) tiles[i * 3].classList.add('done'); } },
      { name: 'new board', run: function () { makeBoard(60, 100); } }
    ],
    probe: function () { return { tiles: board.querySelectorAll('.tile').length, hit: board.querySelectorAll('.hit').length, done: board.querySelectorAll('.done').length, score: score.textContent, sprite: sprite.style.transform, trail: trail.getAttribute('d') }; }
  };
})();
