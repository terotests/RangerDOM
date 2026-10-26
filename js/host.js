// SPDX-License-Identifier: MIT
//
// After webapi.js: what a host that keeps its own copy of the page needs.
//
//   __snapshot()   the document as HTML, as it is now: every element with
//                  data-rd="<node id>" (the id __input's targets take),
//                  form controls with their current value and checkedness,
//                  <style> with the rules it has now (CSS-in-JS inserts
//                  them with insertRule), scripts without their text
//   __changed()    "1" when the page changed since the last __snapshot
//
// and the default actions a browser has and webapi.js leaves to its host:
// a GET form that is submitted and not cancelled goes to its action with
// its fields as the query (an "open" message, as a link's click is).

(function (G) {
  'use strict';

  var VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/;
  var RAW = /^(style|script|xmp|iframe|noembed|noframes|noscript|textarea|title)$/;
  var lastGen = '';

  function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  function sheetText(el) {
    var sh = el.sheet;
    if (sh && sh.cssRules && sh.cssRules.length) {
      var out = [];
      for (var i = 0; i < sh.cssRules.length; i++) out.push(sh.cssRules[i].cssText);
      return out.join('\n');
    }
    return el.textContent;
  }

  function attrsOf(el, skip) {
    var s = '';
    var a = el.attributes;
    for (var i = 0; i < a.length; i++) {
      var n = a[i].name;
      if (skip && skip[n]) continue;
      s += ' ' + n + '="' + escAttr(a[i].value) + '"';
    }
    return s;
  }

  function el2html(el, out) {
    var tag = el.localName;
    var skip = null;
    var extra = ' data-rd="' + el.__id + '"';
    if (tag === 'input') {
      var t = String(el.type || 'text').toLowerCase();
      skip = { value: 1, checked: 1 };
      if (t === 'checkbox' || t === 'radio') {
        if (el.checked) extra += ' checked=""';
        if (el.hasAttribute('value')) extra += ' value="' + escAttr(el.getAttribute('value')) + '"';
      } else {
        extra += ' value="' + escAttr(el.value) + '"';
      }
    } else if (tag === 'option') {
      skip = { selected: 1 };
      if (el.selected) extra += ' selected=""';
    }
    out.push('<' + tag + attrsOf(el, skip) + extra + '>');
    if (VOID.test(tag)) return;
    if (tag === 'textarea') out.push(escText(el.value));
    else if (tag === 'style') out.push(sheetText(el));
    else if (tag === 'script') { /* run already, in the realm */ }
    else if (RAW.test(tag)) out.push(escText(el.textContent));
    else {
      var kids = el.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType === 1) el2html(k, out);
        else if (k.nodeType === 3 || k.nodeType === 4) out.push(escText(k.data));
      }
    }
    out.push('</' + tag + '>');
  }

  G.__snapshot = function () {
    lastGen = G.__generation();
    var root = document.documentElement;
    if (!root) return '';
    var out = ['<!DOCTYPE html>'];
    el2html(root, out);
    return out.join('');
  };
  G.__changed = function () { return G.__generation() !== lastGen ? '1' : ''; };

  // a GET form's submission, when no listener cancelled it
  function formQuery(form) {
    var parts = [];
    var els = form.elements || [];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var name = e.getAttribute && e.getAttribute('name');
      if (!name || e.disabled) continue;
      var t = String(e.type || '').toLowerCase();
      if ((t === 'checkbox' || t === 'radio') && !e.checked) continue;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'file' || t === 'image') continue;
      parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(e.value == null ? '' : e.value));
    }
    return parts.join('&');
  }
  G.__installDefaults = function () {
    document.addEventListener('submit', function (ev) {
      if (ev.defaultPrevented) return;
      var form = ev.target;
      if (!form || form.localName !== 'form') return;
      var method = String(form.getAttribute('method') || 'get').toLowerCase();
      if (method !== 'get') return;
      var action = form.getAttribute('action') || location.href;
      var u = new URL(action, location.href);
      u.search = '?' + formQuery(form);
      u.hash = '';
      G.open(u.href, '_self');
    });
    return 'ok';
  };
})(this);
