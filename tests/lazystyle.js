// getComputedStyle read one property at a time (ComputedDecl) and filled
// whole; an SVG shape's geometry that no selector reads (drawn again, not
// styled again) and one a selector reads; several inline properties as one
// change (CSSStyleDeclaration _setMany)
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
  return o.join(',');
})()
