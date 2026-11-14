// SPDX-License-Identifier: MIT
// js-framework-benchmark's data (krausest/js-framework-benchmark: rows of
// id + "adjective colour noun"), with a seeded random so both engines make
// the same rows, and its operations as steps for every implementation.
(function (G) {
  var A = ['pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome', 'plain', 'quaint', 'clean', 'elegant', 'easy', 'angry', 'crazy', 'helpful', 'mushy', 'odd', 'unsightly', 'adorable', 'important', 'inexpensive', 'cheap', 'expensive', 'fancy'];
  var C = ['red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'brown', 'white', 'black', 'orange'];
  var N = ['table', 'chair', 'house', 'bbq', 'desk', 'car', 'pony', 'cookie', 'sandwich', 'burger', 'pizza', 'mouse', 'keyboard'];
  var seed = 1, nextId = 1;
  function rnd(n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }
  G.jsfbData = function (count) {
    var d = new Array(count);
    for (var i = 0; i < count; i++) d[i] = { id: nextId++, label: A[rnd(A.length)] + ' ' + C[rnd(C.length)] + ' ' + N[rnd(N.length)] };
    return d;
  };
  // the benchmark's operations, on an implementation's actions
  G.jsfbSteps = function (act, after) {
    var w = function (f) { return function () { f(); return after ? after() : undefined; }; };
    return [
      { name: 'create 1000 rows', run: w(act.run) },
      { name: 'replace all 1000 rows', run: w(act.run) },
      { name: 'partial update (every 10th)', run: w(act.update) },
      { name: 'select row', run: w(function () { act.select(3); }) },
      { name: 'swap rows', run: w(act.swapRows) },
      { name: 'remove row', run: w(function () { act.remove(5); }) },
      { name: 'create 10000 rows', run: w(act.runLots) },
      { name: 'append 1000 rows', run: w(act.add) },
      { name: 'clear rows', run: w(act.clear) }
    ];
  };
  G.jsfbProbe = function () {
    var rows = document.querySelectorAll('#tbody > tr');
    var t = function (r) { return r ? r.children[0].textContent + ' ' + r.children[1].textContent : null; };
    var sel = document.querySelector('#tbody > tr.danger');
    return { rows: rows.length, first: t(rows[0]), second: t(rows[1]), r998: t(rows[998]), last: t(rows[rows.length - 1]), selected: sel ? sel.children[0].textContent : null };
  };
})(window);
