// The form controls a browser draws itself, driven by the pointer and keys
// as the playground drives them (tests/RealmTest.rgr "controls"): boxes
// given by hand, then __input. Answers one line of results.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var b = {}, box = function (id, r) { b[$(id).__id] = r; };
  box('r', [0, 0, 116, 20]); box('m', [0, 30, 100, 40]); box('ce', [0, 100, 200, 20]); box('t', [0, 140, 100, 20]);
  box('d', [0, 170, 150, 20]); box('tm', [0, 200, 150, 20]); box('c', [0, 230, 40, 20]); box('f', [0, 260, 200, 20]);
  __layout(JSON.stringify({ boxes: b }));
  var inp = function (o) { return __input(JSON.stringify(o)); };
  var press = function (el, x, y, mods) { var o = { type: 'down', target: el.__id, x: x, y: y }; for (var k in mods || {}) o[k] = mods[k]; inp(o); o.type = 'up'; inp(o); };
  var pick = function (text) { var p = document.querySelector('[data-rd-picker]'), hit = null; if (!p) return null; (function walk(n) { for (var i = 0; i < n.children.length; i++) { var c = n.children[i]; if (c._pickAct && c.textContent === text && !hit) hit = c; walk(c); } })(p); return hit; };
  var o = [];
  // range: a press at the middle, a drag to the end; input at each change, change at the release
  var ev = [];
  $('r').addEventListener('input', function () { ev.push('i' + $('r').value); });
  $('r').addEventListener('change', function () { ev.push('c' + $('r').value); });
  inp({ type: 'down', target: $('r').__id, x: 58, y: 10 }); inp({ type: 'move', x: 108, y: 10 }); inp({ type: 'up', target: $('r').__id, x: 108, y: 10 });
  o.push(ev.join(' '));
  // the keys step it
  $('r').focus(); inp({ type: 'key', key: 'ArrowLeft' }); o.push($('r').value);
  // a list box: a press selects the row, Ctrl adds, Shift selects from the last
  var sel = function () { return [].map.call($('m').selectedOptions, function (x) { return x.value; }).join(''); };
  press($('m'), 5, 35); o.push(sel());
  press($('m'), 5, 55, { ctrl: true }); o.push(sel());
  press($('m'), 5, 65, { shift: true }); o.push(sel());
  // an editing host: the caret at the press, typing and keys there, its box drawn
  press($('ce'), 0, 110);
  inp({ type: 'key', key: 'X' }); inp({ type: 'key', key: 'ArrowRight' }); inp({ type: 'key', key: 'Backspace' });
  o.push($('ce').textContent, /"rdcaret"/.test(__render()));
  // a text field: the caret at the press ("he" is 11.12px at 10px)
  press($('t'), 11, 150); o.push($('t').selectionStart);
  // a number field's arrows step it
  $('n').focus(); inp({ type: 'key', key: 'ArrowUp' }); o.push($('n').value);
  // a date field opens its calendar; a day sets it and closes it
  press($('d'), 10, 180); var day = pick('20'); o.push(!!day);
  if (day) press(day, 0, 0);
  o.push($('d').value, !document.querySelector('[data-rd-picker]'));
  // a time field's columns: an hour, then a minute, the picker staying open
  press($('tm'), 10, 210); var h = pick('03'); if (h) press(h, 0, 0); var mi = pick('30'); if (mi) press(mi, 0, 0);
  o.push($('tm').value, !!document.querySelector('[data-rd-picker]'));
  inp({ type: 'key', key: 'Escape' }); o.push(!document.querySelector('[data-rd-picker]'));
  // a color field's swatches
  press($('c'), 10, 240); var sw = document.querySelector('[data-rd-picker]'), first = sw && sw.firstChild && sw.firstChild.firstChild;
  if (first) press(first, 0, 0); o.push($('c').value);
  // a file field asks the host, which answers with the files
  press($('f'), 10, 270); o.push(/"pick-file"/.test(__drain()));
  __setFiles($('f').__id, JSON.stringify([{ name: 'a.txt', type: 'text/plain', b64: 'aGk=' }]));
  o.push($('f').files[0].name + ':' + $('f').files[0].size);
  return o.join(',');
})()
