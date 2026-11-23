// an inline place and size computed over the style the boxes alike share
// (inlineOverlay) gives what the whole cascade gives: compared with the
// overlay off. SVG paths alike but in d share their style; a declaration
// list parsed once (declsMemo) keeps an invalid one dropped.
(function () {
  var o = [];
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return k + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  var root = document.getElementById('r'), SVG = 'http://www.w3.org/2000/svg';
  var css = ['position: absolute; left: 5px; top: 6px; width: 20px; height: 10px; background-color: red',
    'position: absolute; left: 7px; top: 8px; width: 2em; height: 10px',
    'display: inline-block; width: 30px; margin-inline-start: 4px; margin-left: 9px',
    'margin-left: 9px; margin-inline-start: 4px; width: 31px',
    'left: 3px; top: 4px; position: relative; transform: translate(10%, 2px)',
    'width: -5px; height: 12px; left: 1px !important',
    'width: -5px; height: 13px; z-index: 2; opacity: 0.5'];
  var els = [];
  for (var i = 0; i < css.length; i++) {
    var d = document.createElement('div'); d.className = i % 2 ? 'b' : 'a'; d.style.cssText = css[i];
    var s = document.createElement('span'); s.textContent = 'x' + i; d.appendChild(s);
    root.appendChild(d); els.push(d);
  }
  var svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 10 10'); svg.setAttribute('width', '10'); svg.setAttribute('height', '10');
  for (i = 0; i < 3; i++) { var p = document.createElementNS(SVG, 'path'); p.setAttribute('d', 'M0 0 L' + i + ' 5'); p.setAttribute('fill', i === 2 ? 'blue' : 'green'); svg.appendChild(p); }
  root.appendChild(svg);
  var props = ['left', 'top', 'width', 'height', 'margin-left', 'background-color', 'transform', 'z-index', 'opacity', 'position', 'display', 'color', 'font-size'];
  function styles() { return els.map(function (e) { var c = getComputedStyle(e); return props.map(function (n) { return c.getPropertyValue(n); }).join('|') + '/' + getComputedStyle(e.firstChild).color; }).join(';'); }
  var a = canon(JSON.parse(__render()).root), sa = styles();
  var paths = svg.querySelectorAll('path'), cs0 = __webdom.computedOf(paths[0]);
  o.push(cs0 === __webdom.computedOf(paths[1]), cs0 !== __webdom.computedOf(paths[2]), __webdom.computedOf(paths[2]).fill);
  o.push(els[0].style.cssText, els[5].style.cssText, els[6].style.cssText);
  __webdom.overlay(false);
  var b = canon(JSON.parse(__render()).root), sb = styles();
  __webdom.overlay(true);
  o.push(a === b, sa === sb, getComputedStyle(els[1]).left, getComputedStyle(els[1]).width, getComputedStyle(els[3]).marginLeft, getComputedStyle(els[0]).color);
  return o.join(',');
})()
