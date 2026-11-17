// Focus and the keyboard as a browser does them (tests/RealmTest.rgr
// "focus"): sequential order through shadow trees and slots, a host that
// delegates focus, a modal dialog's inert outside, :focus-visible after a
// press, the UA focus ring, the pointer leaving the view, the cursor.
// Answers one line of results.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var inp = function (o) { return __input(JSON.stringify(o)); };
  var b = {}, box = function (el, r) { b[el.__id] = r; };
  // a shadow host with a button inside and a slot for a light input
  var h = $('h'), sr = h.attachShadow({ mode: 'open' });
  sr.innerHTML = '<button id=in1>in</button><slot></slot>';
  // a host that delegates focus (Shoelace's sl-button)
  var d = $('d'), dsr = d.attachShadow({ mode: 'open', delegatesFocus: true });
  dsr.innerHTML = '<span>x</span><button id=inner>inner</button>';
  box($('a'), [0, 0, 50, 20]); box($('t'), [0, 30, 100, 20]); box(d, [0, 60, 80, 20]); box(dsr.getElementById('inner'), [10, 60, 60, 20]);
  __layout(JSON.stringify({ boxes: b }));
  var name = function () { var e = document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; return e ? (e.id || e.localName) : 'none'; };
  var o = [], seq = [];
  // Tab through the page from nothing focused
  for (var i = 0; i < 6; i++) { inp({ type: 'key', key: 'Tab' }); seq.push(name()); }
  o.push(seq.join(' '));
  inp({ type: 'key', key: 'Tab', shift: true }); o.push(name());
  // focus() on the delegating host lands inside it
  $('a').focus(); d.focus(); o.push(name());
  // the UA ring on a keyboard-focused link, none after a press on a button
  inp({ type: 'key', key: 'Tab' }); $('a').focus();
  var cs = getComputedStyle($('a'));
  o.push(cs.outlineStyle + ' ' + cs.outlineWidth);
  inp({ type: 'down', target: $('a').__id, x: 5, y: 5 }); inp({ type: 'up', target: $('a').__id, x: 5, y: 5 });
  o.push($('a').matches(':focus-visible'));
  // a press on a text field: :focus-visible (it takes typed text)
  inp({ type: 'down', target: $('t').__id, x: 5, y: 35 }); inp({ type: 'up', target: $('t').__id, x: 5, y: 35 });
  o.push(name() + ':' + $('t').matches(':focus-visible'));
  // a modal dialog: its first control takes the focus, Tab stays in it,
  // Escape closes it and the focus goes back
  $('dlg').showModal(); o.push(name());
  var dl = []; for (i = 0; i < 3; i++) { inp({ type: 'key', key: 'Tab' }); dl.push(name()); }
  o.push(dl.join(' '));
  inp({ type: 'key', key: 'Escape' }); o.push($('dlg').open + ':' + name());
  // hover, then the pointer leaves the view; the cursor over the link
  inp({ type: 'move', target: $('a').__id, x: 5, y: 5 }); o.push($('a').matches(':hover') + ':' + __cursor());
  inp({ type: 'leave' }); o.push($('a').matches(':hover') + ':' + __cursor());
  return o.join(',');
})()
