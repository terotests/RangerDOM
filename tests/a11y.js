// What elements are to a screen reader (tests/RealmTest.rgr "a11y"): roles,
// names and states from HTML and ARIA, as __axTree() lists them. Answers
// one line: role:name[:states] per node, "|" between.
(function () {
  var t = JSON.parse(__axTree());
  return t.map(function (n) {
    var st = [];
    ['ck', 'ex', 'se', 'pr', 'di', 'lv', 'hp', 'v', 'vn', 'rq', 'd'].forEach(function (k) { if (n[k] !== undefined) st.push(k + '=' + n[k]); });
    return n.r + ':' + (n.n || '') + (st.length ? ':' + st.join(',') : '');
  }).join('|');
})()
