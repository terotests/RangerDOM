// the style table (__wire): a host that reads the delta render with its
// styles as references (a base sent once, the placing members with the
// node) puts together the page the whole render gives, frame after frame:
// new boxes, a moved one (movedJson), an inline <svg>, and a host that
// lost what it kept (a new epoch).
(function () {
  var o = [];
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(function (k) { return k !== 'n'; }).map(function (k) { return k + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  // what DomPage does with it
  var byN = {}, table = {}, epoch = -1, defs = 0, refs = 0;
  function node(v) {
    if (!v || typeof v !== 'object') return v;
    if (v.r !== undefined) return byN[v.r];
    var out = {};
    for (var k in v) {
      var x = v[k];
      if (k === 's' && (typeof x === 'number' || Array.isArray(x))) {
        refs++;
        var id = typeof x === 'number' ? x : x[0], b = table[id], m = {};
        if (!b) return 'missing ' + id;
        for (var bk in b) m[bk] = b[bk];
        if (Array.isArray(x)) for (var ok in x[1]) m[ok] = x[1][ok];
        out.s = m;
      } else if (k === 'c') out.c = x.map(node);
      else out[k] = x;
    }
    if (v.n !== undefined) byN[v.n] = out;
    return out;
  }
  function take(text) {
    var j = JSON.parse(text);
    if (j.d !== epoch) { byN = {}; table = {}; epoch = j.d; }
    if (j.st) { o.push(j.st.e === j.d); j.st.d.forEach(function (d) { table[d[0]] = d[1]; defs++; }); }
    return node(j.root);
  }
  // the whole page, its style attributes left out (the table's are)
  function whole() {
    var r = JSON.parse(__render()).root;
    (function strip(v) { if (!v || typeof v !== 'object') return; if (v.a && v.a.style !== undefined) { delete v.a.style; } (v.c || []).forEach(strip); })(r);
    return canon(r);
  }
  __deltaRender(true);
  o.push(__wire(true));
  var root = document.getElementById('r'), boxes = [];
  for (var i = 0; i < 6; i++) {
    var d = document.createElement('div');
    d.style.cssText = 'position: absolute; left: ' + (i * 11) + 'px; top: ' + (i * 3) + 'px; width: 10px; height: 10px; background-color: rgb(' + i + ', 0, 0)';
    d.className = 'box';
    d.appendChild(document.createTextNode('b' + i));
    root.appendChild(d); boxes.push(d);
  }
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '10'); svg.setAttribute('height', '10');
  svg.innerHTML = '<path d="M0 0 L5 5"/>';
  root.appendChild(svg);
  var t1 = __renderDelta(), p1 = take(t1);
  o.push(canon(p1) === whole(), defs > 0 && defs < 6, /"style":/.test(t1) ? 'style sent' : 'no style');
  // a box moved by its transform, another by its left, one more box
  boxes[1].style.transform = 'rotate(10deg)';
  take(__renderDelta());
  boxes[1].style.transform = 'rotate(20deg)';
  boxes[2].style.left = '70px';
  var e = document.createElement('div'); e.style.cssText = 'position: absolute; left: 1px; top: 40px; width: 12px; height: 5px'; e.className = 'box'; root.appendChild(e);
  var d0 = defs, t2 = __renderDelta(), p2 = take(t2);
  o.push(canon(p2) === whole(), defs === d0, t2.length < t1.length);
  // the host lost what it kept: everything again, the table too
  var t3 = __renderDelta(1), p3 = take(t3);
  o.push(canon(p3) === whole(), refs > 0);
  // (without the table the style attributes go too)
  o.push(__wire(false), canon(take(__renderDelta())) === canon(JSON.parse(__render()).root));
  return o.join(',');
})()
