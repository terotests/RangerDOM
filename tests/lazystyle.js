// getComputedStyle read one property at a time (ComputedDecl) and filled
// whole; an SVG shape's geometry that no selector reads (drawn again, not
// styled again) and one a selector reads; several inline properties as one
// change (CSSStyleDeclaration _setMany); an <svg>'s markup for a paint
// patch (__webdom.svgMarkup) is the render tree's, after its shapes changed
(function () {
  var o = [];
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return k + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function same() { var a = canon(JSON.parse(__render()).root); __webdom.restyleAll(); return a === canon(JSON.parse(__render()).root); }
  var w = document.getElementById('w'), p = document.getElementById('p'), c = document.getElementById('c');
  var lazy = getComputedStyle(w), full = getComputedStyle(w), names = [];
  for (var i = 0; i < full.length; i++) names.push(full.item(i));
  names = names.concat(['margin', 'border', 'inset', 'gap', 'overflow', 'width', 'line-height', '--v', 'nope']);
  var bad = 0;
  for (i = 0; i < names.length; i++) if (getComputedStyle(w).getPropertyValue(names[i]) !== full.getPropertyValue(names[i])) bad++;
  o.push(names.length > 60, bad, lazy.marginLeft, lazy.margin, lazy.getPropertyValue('--v'), lazy.length === full.length);
  __render();
  p.setAttribute('d', 'M0 0 L7 7');
  var t = __render();
  o.push(/7 7/.test(t), same());
  c.setAttribute('r', '5');
  o.push(getComputedStyle(c).stroke, same());
  w.style._setMany(['width', 'height', 'margin-left'], ['20px', '7px', '']);
  o.push(w.getAttribute('style'), getComputedStyle(w).height, same());
  function svgOf(n) {
    if (!n || typeof n !== 'object') return null;
    if (n.t === 'svg:svg') return n.svg;
    var c = n.c || [];
    for (var k = 0; k < c.length; k++) { var f = svgOf(c[k]); if (f !== null) return f; }
    return null;
  }
  var svg = p.ownerSVGElement;
  p.setAttribute('d', 'M1 1 L2 9');
  p.setAttribute('stroke', 'rgb(7,8,9)');
  var m = __webdom.svgMarkup(svg);
  o.push(m === svgOf(JSON.parse(__render()).root), /L2 9/.test(m) && /rgb\(7, 8, 9\)/.test(m));
  return o.join(',');
})()
