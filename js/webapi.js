// SPDX-License-Identifier: MIT
//
// The Web API for a script engine without a browser: the DOM (nodes,
// elements, attributes, events, focus, selectors, innerHTML), the window's
// objects a page uses (timers, MessageChannel, requestAnimationFrame,
// observers, storage, matchMedia, getComputedStyle), and the CSS cascade
// that gives each element its computed style. It runs after prelude.js
// (the global object, timers on the host's clock, the host's outbox) and
// takes over `document`. It came from terotests/MFilesAPI (web/dom/js),
// where it runs UI extension pages; nothing in it is specific to that.
//
// The engine has no host functions: the host drives the page by calling
//
//   __page(html, url)     parse the page and make it the document
//   __addStyle(css, url)  a style sheet of the page (<link rel=stylesheet>)
//   __loaded()            DOMContentLoaded and load, after the scripts
//   __render()            JSON text: the rendered tree (elements with their
//                         computed style, text), see renderNode
//   __layout(json)        the boxes the host laid out: {"id": [x, y, w, h]}
//                         and {"viewport": [w, h]}
//   __input(json)         an event from the user, see hostInput
//   __resume()            the realm was started from a snapshot taken
//                         earlier: its clock (performance) starts now
//
// and reads the scripts to run from __scripts() after __page.

(function (G) {
  'use strict';

  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var nextNodeId = 1;
  // bumped by every change to what the page shows (render, childNodes)
  var generation = 1;
  // bumped by every change that can change a computed style: not by a
  // text's change that keeps its element's :empty (a count-up's numbers),
  // so the styles are not cascaded again for every animation frame
  var styleGen = 1;
  // inside textContent's set: its text nodes' moves are judged at its end
  var textEdit = 0;
  var boxes = {};
  var viewport = { w: 1024, h: 768 };
  var doc = null;

  function changed() { generation++; styleGen++; }
  // the last text or attribute change: an element renders again when one
  // was under it (_rv), the rest of the page comes from the last render
  // (renderJson)
  var textStamp = 0;
  // An attribute of el changed: when no selector of the page looks up the
  // tree (:has()) or counts siblings by their attributes (:nth-child(.. of
  // S)), only el and what is under it are styled again, and its following
  // siblings when a selector has a + or ~ combinator; else the whole page
  // (changed)
  function attrChanged(el) {
    var reach = el.isConnected && doc && el.ownerDocument === doc && el !== doc.documentElement ? selectorReach() : 0;
    if (!reach) { changed(); return; }
    generation++;
    textStamp++;
    for (var p = el; p; p = p.parentNode) p._rv = textStamp;
    if (computedCache.gen !== styleGen) return;
    var drop = function (e) { delete computedCache.map[e.__id]; e._rj = null; };
    drop(el);
    eachElement(el, drop);
    if (reach === 2 && el.parentNode) {
      var sib = el.parentNode._c;
      for (var i = sib.indexOf(el) + 1; i < sib.length; i++) if (sib[i].nodeType === 1) { drop(sib[i]); eachElement(sib[i], drop); }
    }
  }
  // 1: an element's style depends only on it and its ancestors; 2: on its
  // preceding siblings too (+, ~); 0: on more
  var reachCache = { gen: -1, reach: 0 };
  function selectorReach() {
    if (reachCache.gen === styleGen) return reachCache.reach;
    var reach = 1;
    var sheets = [ua()].concat(cascadeSheets(doc));
    for (var i = 0; i < sheets.length && reach; i++) {
      var rules = sheets[i]._rules || [];
      for (var j = 0; j < rules.length; j++) {
        var t = String(rules[j].text || '');
        if (/:has\(|\sof\s/i.test(t)) { reach = 0; break; }
        if (/[+~]/.test(t)) reach = 2;
      }
    }
    reachCache = { gen: styleGen, reach: reach };
    return reach;
  }
  // n scrolled: a new offset of what it shows, no style or box changes,
  // so only n and its ancestors render again (the rest of the page, its
  // canvases' drawings too, comes from the last render) and the host moves
  // what was laid out
  function scrolled(n) {
    generation++;
    textStamp++;
    for (; n; n = n.parentNode) n._rv = textStamp;
  }
  // a text changed under n: n and its ancestors render again
  function textChanged(n) {
    // a style sheet's text is its rules
    if (n && n.localName === 'style') { changed(); return; }
    generation++;
    textStamp++;
    for (; n; n = n.parentNode) n._rv = textStamp;
  }
  function emptyEl(n) {
    for (var e = 0; e < n._c.length; e++) { var c = n._c[e]; if (c.nodeType === 1 || ((c.nodeType === 3 || c.nodeType === 4) && c._data.length)) return false; }
    return true;
  }
  function isText(c) { return c.nodeType === 3 || c.nodeType === 4 || c.nodeType === 8; }

  // ---- DOMException --------------------------------------------------------

  function DOMException(message, name) {
    var e = new Error(message);
    Object.setPrototypeOf(e, DOMException.prototype);
    e.name = name || 'Error';
    return e;
  }
  DOMException.prototype = Object.create(Error.prototype);
  DOMException.prototype.constructor = DOMException;

  // ---- events --------------------------------------------------------------

  class Event {
    constructor(type, init) {
      init = init || {};
      this.type = String(type);
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.composed = !!init.composed;
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
      this.srcElement = null;
      this.eventPhase = 0;
      this.isTrusted = false;
      this.timeStamp = now();
      this._stop = false;
      this._stopNow = false;
      this._path = [];
    }
    preventDefault() { if (this.cancelable && !this._passive) this.defaultPrevented = true; }
    stopPropagation() { this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
    composedPath() { return this._path.slice(); }
    get returnValue() { return !this.defaultPrevented; }
    set returnValue(v) { if (!v) this.preventDefault(); }
    get cancelBubble() { return this._stop; }
    set cancelBubble(v) { if (v) this._stop = true; }
    initEvent(type, bubbles, cancelable) { this.type = String(type); this.bubbles = !!bubbles; this.cancelable = !!cancelable; }
  }
  Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;

  class CustomEvent extends Event {
    constructor(type, init) { super(type, init); this.detail = init && init.detail !== undefined ? init.detail : null; }
  }
  class UIEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.view = init.view || null; this.detail = init.detail || 0; }
  }
  class FocusEvent extends UIEvent {
    constructor(type, init) { super(type, init); this.relatedTarget = (init && init.relatedTarget) || null; }
  }
  class MouseEvent extends UIEvent {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.clientX = init.clientX || 0; this.clientY = init.clientY || 0;
      this.screenX = init.screenX || this.clientX; this.screenY = init.screenY || this.clientY;
      this.pageX = this.clientX; this.pageY = this.clientY;
      this.offsetX = init.offsetX || 0; this.offsetY = init.offsetY || 0;
      this.button = init.button || 0; this.buttons = init.buttons || 0;
      this.ctrlKey = !!init.ctrlKey; this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey;
      this.relatedTarget = init.relatedTarget || null;
      this.movementX = 0; this.movementY = 0;
    }
    getModifierState(k) { return (k === 'Shift' && this.shiftKey) || (k === 'Control' && this.ctrlKey) || (k === 'Alt' && this.altKey) || (k === 'Meta' && this.metaKey); }
  }
  class PointerEvent extends MouseEvent {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.pointerId = init.pointerId || 1; this.pointerType = init.pointerType || 'mouse';
      this.isPrimary = init.isPrimary !== undefined ? !!init.isPrimary : true;
      this.width = 1; this.height = 1; this.pressure = init.pressure || 0;
    }
  }
  class WheelEvent extends MouseEvent {
    constructor(type, init) { super(type, init); init = init || {}; this.deltaX = init.deltaX || 0; this.deltaY = init.deltaY || 0; this.deltaZ = 0; this.deltaMode = init.deltaMode || 0; }
  }
  class KeyboardEvent extends UIEvent {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.key = init.key || ''; this.code = init.code || '';
      this.ctrlKey = !!init.ctrlKey; this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey;
      this.repeat = !!init.repeat; this.isComposing = !!init.isComposing; this.location = 0;
      this.keyCode = init.keyCode || keyCodeOf(this.key); this.which = this.keyCode;
      this.charCode = type === 'keypress' && this.key.length === 1 ? this.key.charCodeAt(0) : 0;
    }
    getModifierState(k) { return MouseEvent.prototype.getModifierState.call(this, k); }
  }
  class InputEvent extends UIEvent {
    constructor(type, init) { super(type, init); init = init || {}; this.data = init.data === undefined ? null : init.data; this.inputType = init.inputType || ''; this.isComposing = false; }
  }
  class CompositionEvent extends UIEvent {
    constructor(type, init) { super(type, init); this.data = (init && init.data) || ''; }
  }
  class MessageEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.data = init.data; this.origin = init.origin || ''; this.source = init.source || null; this.ports = init.ports || []; }
  }
  class ProgressEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.loaded = init.loaded || 0; this.total = init.total || 0; this.lengthComputable = !!init.lengthComputable; }
  }
  class ErrorEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.message = init.message || ''; this.error = init.error || null; }
  }
  class AnimationEvent extends Event {}
  class TransitionEvent extends Event {}
  class ClipboardEvent extends Event {
    constructor(type, init) { super(type, init); this.clipboardData = (init && init.clipboardData) || null; }
  }
  class DragEvent extends MouseEvent {
    constructor(type, init) { super(type, init); this.dataTransfer = (init && init.dataTransfer) || null; }
  }

  var KEY_CODES = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, F2: 113 };
  function keyCodeOf(k) {
    if (KEY_CODES[k] !== undefined) return KEY_CODES[k];
    if (k.length === 1) return k.toUpperCase().charCodeAt(0);
    return 0;
  }

  class EventTarget {
    constructor() { this._ls = null; }
    addEventListener(type, fn, opts) {
      if (!fn) return;
      var capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      var once = !!(opts && typeof opts === 'object' && opts.once);
      var passive = !!(opts && typeof opts === 'object' && opts.passive);
      var signal = opts && typeof opts === 'object' ? opts.signal : null;
      if (signal && signal.aborted) return;
      if (!this._ls) this._ls = {};
      var list = this._ls[type] || (this._ls[type] = []);
      for (var i = 0; i < list.length; i++) if (list[i].fn === fn && list[i].capture === capture) return;
      var l = { fn: fn, capture: capture, once: once, passive: passive, removed: false };
      list.push(l);
      if (signal) { var self = this; signal.addEventListener('abort', function () { self.removeEventListener(type, fn, capture); }); }
    }
    removeEventListener(type, fn, opts) {
      if (!this._ls || !this._ls[type]) return;
      var capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      var list = this._ls[type];
      for (var i = 0; i < list.length; i++) {
        if (list[i].fn === fn && list[i].capture === capture) { list[i].removed = true; list.splice(i, 1); return; }
      }
    }
    dispatchEvent(ev) {
      if (!(ev instanceof Event)) throw new TypeError("Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'.");
      return dispatch(this, ev);
    }
  }

  function parentForEvent(t) {
    if (t instanceof Node) {
      if (t.parentNode) return t.parentNode;
      if (t.nodeType === 9) return G;
      return null;
    }
    return null;
  }

  function invoke(t, ev, phase) {
    if (!t._ls) return;
    var list = t._ls[ev.type];
    if (!list || !list.length) return;
    list = list.slice();
    ev.currentTarget = t;
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (l.removed) continue;
      if (phase === 1 && !l.capture) continue;
      if (phase === 3 && l.capture) continue;
      if (l.once) t.removeEventListener(ev.type, l.fn, l.capture);
      ev._passive = l.passive;
      try {
        if (typeof l.fn === 'function') l.fn.call(t, ev);
        else if (l.fn && typeof l.fn.handleEvent === 'function') l.fn.handleEvent(ev);
      } catch (e) {
        reportError(e);
      }
      ev._passive = false;
      if (ev._stopNow) return;
    }
  }

  function invokeHandler(t, ev) {
    // an onclick property or attribute
    var h = t['on' + ev.type];
    if (typeof h === 'function') {
      ev.currentTarget = t;
      try {
        var r = h.call(t, ev);
        if (r === false) ev.preventDefault();
      } catch (e) { reportError(e); }
    }
  }

  function dispatch(target, ev) {
    var path = [];
    for (var t = target; t; t = parentForEvent(t)) path.push(t);
    ev.target = target;
    ev.srcElement = target;
    ev._path = path;
    ev._stop = false;
    ev._stopNow = false;
    var prevEvent = G.event;
    G.event = ev;
    for (var i = path.length - 1; i > 0 && !ev._stop; i--) {
      ev.eventPhase = 1;
      invoke(path[i], ev, 1);
    }
    if (!ev._stop) {
      ev.eventPhase = 2;
      invoke(target, ev, 2);
      if (!ev._stopNow) invokeHandler(target, ev);
    }
    if (ev.bubbles) {
      for (var j = 1; j < path.length && !ev._stop; j++) {
        ev.eventPhase = 3;
        invoke(path[j], ev, 3);
        if (!ev._stopNow) invokeHandler(path[j], ev);
      }
    }
    ev.eventPhase = 0;
    ev.currentTarget = null;
    G.event = prevEvent;
    return !ev.defaultPrevented;
  }

  function reportError(e) {
    if (typeof __error === 'function') __error('event listener', e);
    try { var ev = new ErrorEvent('error', { message: String((e && e.message) || e), error: e }); invoke(G, ev, 2); } catch (x) {}
  }

  // ---- nodes ---------------------------------------------------------------

  function NodeList(arr) {
    var l = arr || [];
    l.item = function (i) { return this[i] === undefined ? null : this[i]; };
    return l;
  }

  class Node extends EventTarget {
    constructor() {
      super();
      this.__id = nextNodeId++;
      this.parentNode = null;
      this._c = NodeList([]);
      this.ownerDocument = doc;
    }
    get childNodes() { return this._c; }
    get firstChild() { return this._c.length ? this._c[0] : null; }
    get lastChild() { return this._c.length ? this._c[this._c.length - 1] : null; }
    get parentElement() { var p = this.parentNode; return p && p.nodeType === 1 ? p : null; }
    get nextSibling() {
      var p = this.parentNode; if (!p) return null;
      var i = p._c.indexOf(this); return i >= 0 && i + 1 < p._c.length ? p._c[i + 1] : null;
    }
    get previousSibling() {
      var p = this.parentNode; if (!p) return null;
      var i = p._c.indexOf(this); return i > 0 ? p._c[i - 1] : null;
    }
    get isConnected() {
      for (var n = this; n; n = n.parentNode) if (n.nodeType === 9) return true;
      return false;
    }
    get nodeValue() { return null; }
    set nodeValue(v) {}
    get baseURI() { return doc ? doc.URL : ''; }
    hasChildNodes() { return this._c.length > 0; }
    getRootNode() { var n = this; while (n.parentNode) n = n.parentNode; return n; }
    contains(o) { for (var n = o; n; n = n.parentNode) if (n === this) return true; return false; }
    isSameNode(o) { return o === this; }
    isEqualNode(o) { return !!o && o.nodeType === this.nodeType && serialize(o, true) === serialize(this, true); }
    compareDocumentPosition(o) {
      if (o === this) return 0;
      if (this.contains(o)) return 20;
      if (o.contains(this)) return 10;
      if (this.getRootNode() !== o.getRootNode()) return 1 | 32;
      var a = treeOrder(this), b = treeOrder(o);
      return a < b ? 4 : 2;
    }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, ref) {
      if (!(c instanceof Node)) throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.");
      if (ref && ref.parentNode !== this) throw DOMException("The node before which the new node is to be inserted is not a child of this node.", 'NotFoundError');
      if (c.contains(this)) throw DOMException('The new child element contains the parent.', 'HierarchyRequestError');
      if (c.nodeType === 11) {
        var kids = c._c.slice();
        for (var i = 0; i < kids.length; i++) this.insertBefore(kids[i], ref);
        return c;
      }
      if (c === ref) return c;
      var wasConnected = c.isConnected;
      if (c.parentNode) detach(c);
      var at = ref ? this._c.indexOf(ref) : this._c.length;
      var wasEmpty = isText(c) ? emptyEl(this) : false;
      this._c.splice(at, 0, c);
      c.parentNode = this;
      adopt(c, this.ownerDocument || this);
      if (isText(c) && (textEdit || wasEmpty === emptyEl(this))) textChanged(this);
      else changed();
      queueMutation(this, 'childList', { addedNodes: [c], removedNodes: [], previousSibling: at > 0 ? this._c[at - 1] : null, nextSibling: ref || null });
      if (!wasConnected && c.isConnected) connected(c);
      return c;
    }
    removeChild(c) {
      if (!c || c.parentNode !== this) throw DOMException('The node to be removed is not a child of this node.', 'NotFoundError');
      detach(c);
      return c;
    }
    replaceChild(n, old) {
      if (!old || old.parentNode !== this) throw DOMException('The node to be replaced is not a child of this node.', 'NotFoundError');
      var ref = old.nextSibling;
      this.removeChild(old);
      this.insertBefore(n, ref);
      return old;
    }
    cloneNode(deep) {
      var c = cloneOne(this);
      if (deep) for (var i = 0; i < this._c.length; i++) c.appendChild(this._c[i].cloneNode(true));
      return c;
    }
    normalize() {
      for (var i = 0; i < this._c.length; i++) {
        var n = this._c[i];
        if (n.nodeType === 3) {
          while (n.nextSibling && n.nextSibling.nodeType === 3) { n.data += n.nextSibling.data; this.removeChild(n.nextSibling); }
          if (!n.data) { this.removeChild(n); i--; }
        } else n.normalize();
      }
    }
    get textContent() {
      var out = '';
      (function walk(n) {
        for (var i = 0; i < n._c.length; i++) {
          var k = n._c[i];
          if (k.nodeType === 3 || k.nodeType === 4) out += k.data;
          else if (k.nodeType === 1 || k.nodeType === 11) walk(k);
        }
      })(this);
      return out;
    }
    set textContent(v) {
      // only texts replaced by a text: the styles stay (styleGen)
      var styled = false;
      for (var i = 0; i < this._c.length; i++) if (!isText(this._c[i])) styled = true;
      var wasEmpty = emptyEl(this);
      textEdit++;
      try {
        removeAll(this);
        v = v === null || v === undefined ? '' : String(v);
        if (v) this.appendChild(this.ownerDocument.createTextNode(v));
      } finally {
        textEdit--;
      }
      if (styled || wasEmpty !== emptyEl(this)) changed();
    }
    lookupNamespaceURI() { return null; }
  }
  Node.ELEMENT_NODE = 1; Node.ATTRIBUTE_NODE = 2; Node.TEXT_NODE = 3; Node.CDATA_SECTION_NODE = 4;
  Node.PROCESSING_INSTRUCTION_NODE = 7; Node.COMMENT_NODE = 8; Node.DOCUMENT_NODE = 9;
  Node.DOCUMENT_TYPE_NODE = 10; Node.DOCUMENT_FRAGMENT_NODE = 11;
  Node.DOCUMENT_POSITION_DISCONNECTED = 1; Node.DOCUMENT_POSITION_PRECEDING = 2; Node.DOCUMENT_POSITION_FOLLOWING = 4;
  Node.DOCUMENT_POSITION_CONTAINS = 8; Node.DOCUMENT_POSITION_CONTAINED_BY = 16; Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32;
  for (var nk in { ELEMENT_NODE: 1, TEXT_NODE: 1, COMMENT_NODE: 1, DOCUMENT_NODE: 1, DOCUMENT_FRAGMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 1, DOCUMENT_POSITION_PRECEDING: 1, DOCUMENT_POSITION_CONTAINED_BY: 1, DOCUMENT_POSITION_CONTAINS: 1 }) Node.prototype[nk] = Node[nk];

  function treeOrder(n) {
    // a sortable key: the indexes from the root
    var key = [];
    for (; n.parentNode; n = n.parentNode) key.unshift(n.parentNode._c.indexOf(n));
    var s = '';
    for (var i = 0; i < key.length; i++) s += String(100000 + key[i]);
    return s;
  }

  function adopt(n, d) {
    if (d && d.nodeType !== 9) d = d.ownerDocument;
    if (!d || n.ownerDocument === d) return;
    n.ownerDocument = d;
    for (var i = 0; i < n._c.length; i++) adopt(n._c[i], d);
  }

  function detach(c) {
    var p = c.parentNode;
    var i = p._c.indexOf(c);
    var wasConnected = c.isConnected;
    if (wasConnected && doc && doc._active && c.contains(doc._active)) doc._active = null;
    var wasEmpty = isText(c) ? emptyEl(p) : false;
    p._c.splice(i, 1);
    c.parentNode = null;
    if (isText(c) && (textEdit || wasEmpty === emptyEl(p))) textChanged(p);
    else changed();
    queueMutation(p, 'childList', { addedNodes: [], removedNodes: [c], previousSibling: i > 0 ? p._c[i - 1] : null, nextSibling: p._c[i] || null });
    if (wasConnected) disconnected(c);
  }

  function removeAll(n) {
    while (n._c.length) detach(n._c[n._c.length - 1]);
  }

  function connected(n) {
    if (n.nodeType === 1) {
      if (n._connected) n._connected();
      for (var i = 0; i < n._c.length; i++) connected(n._c[i]);
    }
  }
  function disconnected(n) {
    if (n.nodeType === 1) {
      if (n._disconnected) n._disconnected();
      for (var i = 0; i < n._c.length; i++) disconnected(n._c[i]);
    }
  }

  function cloneOne(n) {
    var d = n.ownerDocument || doc;
    if (n.nodeType === 3) return d.createTextNode(n.data);
    if (n.nodeType === 8) return d.createComment(n.data);
    if (n.nodeType === 11) return d.createDocumentFragment();
    if (n.nodeType === 1) {
      var e = d.createElementNS(n.namespaceURI, n._qname);
      for (var i = 0; i < n._attrs.length; i++) e.setAttribute(n._attrs[i].name, n._attrs[i].value);
      if (n._value !== undefined) e._value = n._value;
      if (n._checked !== undefined) e._checked = n._checked;
      // a clone of a script that ran does not run (HTML's "already started")
      if (n._started && n.localName === 'script') e._started = true;
      return e;
    }
    if (n.nodeType === 9) return new Document();
    throw DOMException('cannot clone', 'NotSupportedError');
  }

  class CharacterData extends Node {
    constructor(data) { super(); this._data = String(data); }
    get data() { return this._data; }
    set data(v) {
      var old = this._data;
      var p = this.parentNode;
      var wasEmpty = p ? emptyEl(p) : false;
      this._data = v === null || v === undefined ? '' : String(v);
      if (!p || textEdit || wasEmpty === emptyEl(p)) textChanged(p);
      else changed();
      queueMutation(this, 'characterData', { oldValue: old });
    }
    get nodeValue() { return this._data; }
    set nodeValue(v) { this.data = v; }
    get textContent() { return this._data; }
    set textContent(v) { this.data = v; }
    get length() { return this._data.length; }
    appendData(s) { this.data = this._data + s; }
    substringData(o, n) { return this._data.substr(o, n); }
    insertData(o, s) { this.data = this._data.slice(0, o) + s + this._data.slice(o); }
    deleteData(o, n) { this.data = this._data.slice(0, o) + this._data.slice(o + n); }
    replaceData(o, n, s) { this.data = this._data.slice(0, o) + s + this._data.slice(o + n); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    before() { insertNodes(this.parentNode, this, arguments, this.ownerDocument); }
    after() { insertNodes(this.parentNode, this.nextSibling, arguments, this.ownerDocument); }
    replaceWith() { var p = this.parentNode; if (!p) return; var next = this.nextSibling; p.removeChild(this); insertNodes(p, next, arguments, this.ownerDocument); }
    get nextElementSibling() { return siblingElement(this, 1); }
    get previousElementSibling() { return siblingElement(this, -1); }
  }

  class Text extends CharacterData {
    get nodeType() { return 3; }
    get nodeName() { return '#text'; }
    get wholeText() { return this._data; }
    splitText(o) {
      var rest = this.ownerDocument.createTextNode(this._data.slice(o));
      this.data = this._data.slice(0, o);
      if (this.parentNode) this.parentNode.insertBefore(rest, this.nextSibling);
      return rest;
    }
  }
  class CDATASection extends Text {
    get nodeType() { return 4; }
    get nodeName() { return '#cdata-section'; }
  }
  class Comment extends CharacterData {
    get nodeType() { return 8; }
    get nodeName() { return '#comment'; }
  }
  class ProcessingInstruction extends CharacterData {
    get nodeType() { return 7; }
  }

  function siblingElement(n, dir) {
    var p = n.parentNode; if (!p) return null;
    for (var i = p._c.indexOf(n) + dir; i >= 0 && i < p._c.length; i += dir) if (p._c[i].nodeType === 1) return p._c[i];
    return null;
  }

  function insertNodes(parent, ref, args, d) {
    if (!parent) return;
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      parent.insertBefore(a instanceof Node ? a : d.createTextNode(String(a)), ref);
    }
  }

  // ParentNode
  var ParentNode = {
    get children() { return NodeList(this._c.filter(function (n) { return n.nodeType === 1; })); },
    get childElementCount() { var k = 0; for (var i = 0; i < this._c.length; i++) if (this._c[i].nodeType === 1) k++; return k; },
    get firstElementChild() { for (var i = 0; i < this._c.length; i++) if (this._c[i].nodeType === 1) return this._c[i]; return null; },
    get lastElementChild() { for (var i = this._c.length - 1; i >= 0; i--) if (this._c[i].nodeType === 1) return this._c[i]; return null; },
    append: function () { insertNodes(this, null, arguments, this.ownerDocument || this); },
    prepend: function () { insertNodes(this, this.firstChild, arguments, this.ownerDocument || this); },
    replaceChildren: function () { removeAll(this); insertNodes(this, null, arguments, this.ownerDocument || this); },
    querySelector: function (s) { return querySelectorAll(this, s, true)[0] || null; },
    querySelectorAll: function (s) { return NodeList(querySelectorAll(this, s, false)); },
    getElementsByTagName: function (t) {
      var root = this, all = t === '*', want = String(t).toLowerCase();
      return liveCollection(function () {
        var out = [];
        eachElement(root, function (e) { if (all || e.localName === want || e._qname === t) out.push(e); });
        return out;
      });
    },
    getElementsByClassName: function (c) {
      var root = this, want = String(c).split(/\s+/).filter(Boolean);
      return liveCollection(function () {
        var out = [];
        if (!want.length) return out;
        eachElement(root, function (e) {
          var have = (e.getAttribute('class') || '').split(/\s+/);
          for (var i = 0; i < want.length; i++) if (have.indexOf(want[i]) < 0) return;
          out.push(e);
        });
        return out;
      });
    }
  };
  // an HTMLCollection: the elements list() finds, found again after any
  // change to the tree (generation)
  function liveCollection(list) {
    var cache = null, at = 0;
    function now() {
      if (!cache || at !== generation) { cache = NodeList(list()); at = generation; }
      return cache;
    }
    return new Proxy([], {
      get: function (t, k) {
        var l = now();
        if (k === 'namedItem') return function (n) { for (var i = 0; i < l.length; i++) if (l[i].id === n || l[i].getAttribute('name') === n) return l[i]; return null; };
        var v = l[k];
        return typeof v === 'function' ? v.bind(l) : v;
      },
      has: function (t, k) { return k in now(); }
    });
  }
  function mixin(cls, obj) {
    var names = Object.getOwnPropertyNames(obj);
    for (var i = 0; i < names.length; i++) Object.defineProperty(cls.prototype, names[i], Object.getOwnPropertyDescriptor(obj, names[i]));
  }

  function eachElement(root, fn) {
    var stack = [];
    for (var i = root._c.length - 1; i >= 0; i--) stack.push(root._c[i]);
    while (stack.length) {
      var n = stack.pop();
      if (n.nodeType !== 1) continue;
      if (fn(n) === true) return;
      for (var j = n._c.length - 1; j >= 0; j--) stack.push(n._c[j]);
    }
  }

  class DocumentFragment extends Node {
    get nodeType() { return 11; }
    get nodeName() { return '#document-fragment'; }
    getElementById(id) { var f = null; eachElement(this, function (e) { if (e.id === id) { f = e; return true; } }); return f; }
  }
  mixin(DocumentFragment, ParentNode);

  class DocumentType extends Node {
    constructor(name) { super(); this.name = name; this.publicId = ''; this.systemId = ''; }
    get nodeType() { return 10; }
    get nodeName() { return this.name; }
  }

  // ---- attributes ----------------------------------------------------------

  class Attr {
    constructor(name, value, owner) { this.name = name; this._v = value; this.ownerElement = owner; this.namespaceURI = null; this.prefix = null; this.specified = true; }
    get localName() { return this.name; }
    get value() { return this._v; }
    set value(v) { if (this.ownerElement) this.ownerElement.setAttribute(this.name, v); else this._v = String(v); }
    get nodeValue() { return this._v; }
    get nodeType() { return 2; }
    get nodeName() { return this.name; }
  }

  function NamedNodeMap(el) {
    var list = el._attrs;
    return new Proxy(list, {
      get: function (t, k) {
        if (k === 'getNamedItem') return function (n) { return el.getAttributeNode(n); };
        if (k === 'item') return function (i) { return list[i] || null; };
        if (k === 'removeNamedItem') return function (n) { var a = el.getAttributeNode(n); el.removeAttribute(n); return a; };
        if (k === 'setNamedItem') return function (a) { el.setAttribute(a.name, a.value); return null; };
        if (typeof k === 'string' && !/^\d+$/.test(k) && k !== 'length' && !(k in Array.prototype)) return el.getAttributeNode(k) || undefined;
        return t[k];
      }
    });
  }

  class DOMTokenList {
    constructor(el, attr) { this._el = el; this._attr = attr; }
    _list() { var v = this._el.getAttribute(this._attr); return v ? v.split(/[ \t\n\f\r]+/).filter(Boolean) : []; }
    _set(l) { this._el.setAttribute(this._attr, l.join(' ')); }
    get length() { return this._list().length; }
    get value() { return this._el.getAttribute(this._attr) || ''; }
    set value(v) { this._el.setAttribute(this._attr, v); }
    item(i) { var l = this._list(); return i < l.length ? l[i] : null; }
    contains(t) { return this._list().indexOf(String(t)) >= 0; }
    add() {
      var l = this._list(), before = l.length;
      for (var i = 0; i < arguments.length; i++) { var t = String(arguments[i]); checkToken(t); if (l.indexOf(t) < 0) l.push(t); }
      if (l.length !== before || this._el.getAttribute(this._attr) === null) this._set(l);
    }
    remove() {
      var l = this._list(), before = l.length;
      for (var i = 0; i < arguments.length; i++) { var t = String(arguments[i]); checkToken(t); var k = l.indexOf(t); while (k >= 0) { l.splice(k, 1); k = l.indexOf(t); } }
      if (l.length !== before) this._set(l);
    }
    toggle(t, force) {
      t = String(t);
      var has = this.contains(t);
      if (force === undefined ? has : !force) { if (has) this.remove(t); return false; }
      if (!has) this.add(t);
      return true;
    }
    replace(a, b) { var l = this._list(), k = l.indexOf(a); if (k < 0) return false; l[k] = b; this._set(l); return true; }
    supports() { return true; }
    forEach(fn, thisArg) { var l = this._list(); for (var i = 0; i < l.length; i++) fn.call(thisArg, l[i], i, this); }
    entries() { return this._list().entries(); }
    keys() { return this._list().keys(); }
    values() { return this._list().values(); }
    toString() { return this.value; }
  }
  DOMTokenList.prototype[Symbol.iterator] = function () { return this._list()[Symbol.iterator](); };
  function checkToken(t) {
    if (t === '') throw DOMException('The token provided must not be empty.', 'SyntaxError');
    if (/\s/.test(t)) throw DOMException("The token provided ('" + t + "') contains HTML space characters, which are not valid in tokens.", 'InvalidCharacterError');
  }

  // ---- style declarations --------------------------------------------------

  function kebab(n) {
    if (n.slice(0, 2) === '--') return n;
    if (n === 'cssFloat') return 'float';
    var s = n.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
    if (/^(webkit|moz|ms)-/.test(s)) s = '-' + s;
    return s;
  }
  function camel(n) { return n.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); }

  class CSSStyleDeclaration {
    constructor(owner) { this._p = {}; this._prio = {}; this._order = []; this._owner = owner || null; this._readonly = false; this.parentRule = null; }
    get length() { return this._order.length; }
    item(i) { return this._order[i] || ''; }
    getPropertyValue(n) { n = String(n); if (n.slice(0, 2) !== '--') n = n.toLowerCase(); var v = this._p[n]; return v === undefined ? '' : v; }
    getPropertyPriority(n) { return this._prio[String(n).toLowerCase()] ? 'important' : ''; }
    setProperty(n, v, prio) {
      if (this._readonly) throw DOMException('read-only', 'NoModificationAllowedError');
      n = String(n);
      if (n.slice(0, 2) !== '--') n = n.toLowerCase();
      if (v === null || v === undefined || v === '') { this.removeProperty(n); return; }
      v = String(v).trim();
      var longhands = expandShorthand(n, v);
      if (longhands) {
        for (var k in longhands) this._set(k, longhands[k], prio);
        this._sync();
        return;
      }
      this._set(n, v, prio);
      this._sync();
    }
    _set(n, v, prio) {
      if (this._p[n] === undefined) this._order.push(n);
      this._p[n] = v;
      if (prio === 'important') this._prio[n] = true; else delete this._prio[n];
    }
    removeProperty(n) {
      n = String(n);
      if (n.slice(0, 2) !== '--') n = n.toLowerCase();
      var old = this.getPropertyValue(n);
      var names = shorthandParts(n) || [n];
      var hit = false;
      for (var j = 0; j < names.length; j++) {
        var i = this._order.indexOf(names[j]);
        if (i >= 0) { this._order.splice(i, 1); delete this._p[names[j]]; delete this._prio[names[j]]; hit = true; }
      }
      if (hit) this._sync();
      return old;
    }
    get cssText() {
      var out = [];
      for (var i = 0; i < this._order.length; i++) {
        var n = this._order[i];
        out.push(n + ': ' + this._p[n] + (this._prio[n] ? ' !important' : '') + ';');
      }
      return out.join(' ');
    }
    set cssText(t) {
      this._p = {}; this._prio = {}; this._order = [];
      var decls = parseDeclarations(String(t || ''));
      for (var i = 0; i < decls.length; i++) {
        var lh = expandShorthand(decls[i].name, decls[i].value);
        if (lh) for (var k in lh) this._set(k, lh[k], decls[i].important ? 'important' : '');
        else this._set(decls[i].name, decls[i].value, decls[i].important ? 'important' : '');
      }
      this._sync();
    }
    _sync() {
      if (!this._owner) return;
      this._owner._styleSync = true;
      var t = this.cssText;
      if (t) this._owner.setAttribute('style', t); else this._owner.removeAttribute('style');
      this._owner._styleSync = false;
    }
  }
  CSSStyleDeclaration.prototype[Symbol.iterator] = function () { return this._order.slice()[Symbol.iterator](); };

  // camelCase and kebab-case properties (style.backgroundColor, style['margin-top'])
  function styleProxy(decl) {
    return new Proxy(decl, {
      get: function (t, k) {
        if (typeof k !== 'string' || k in t) { var v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
        if (/^\d+$/.test(k)) return t._order[+k];
        return t.getPropertyValue(kebab(k));
      },
      set: function (t, k, v) {
        if (typeof k !== 'string' || k in t || k.charAt(0) === '_') { t[k] = v; return true; }
        t.setProperty(kebab(k), v === null || v === undefined ? '' : String(v));
        return true;
      },
      has: function (t, k) { return k in t || (typeof k === 'string' && /^[a-zA-Z-]+$/.test(k)); }
    });
  }

  var SIDES = ['top', 'right', 'bottom', 'left'];
  function boxSides(v) {
    var p = splitValue(v);
    if (p.length === 1) return [p[0], p[0], p[0], p[0]];
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 3) return [p[0], p[1], p[2], p[1]];
    return [p[0], p[1], p[2], p[3]];
  }
  function splitValue(v) {
    // spaces outside parentheses
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i);
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth === 0 && /\s/.test(c)) { if (cur) out.push(cur); cur = ''; } else cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }
  function splitComma(v) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i);
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  var BORDER_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/;
  function isColorWord(t) { return /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|var\()/.test(t) || NAMED_COLORS[t.toLowerCase()] !== undefined || t === 'transparent' || t === 'currentcolor' || t === 'currentColor'; }
  function isLength(t) { return /^-?[\d.]+(px|em|rem|%|vh|vw|vmin|vmax|pt|ch|ex)?$/.test(t) || /^(calc|min|max|clamp)\(/.test(t) || t === 'thin' || t === 'medium' || t === 'thick'; }
  function shorthandParts(n) {
    if (n === 'margin' || n === 'padding') return SIDES.map(function (s) { return n + '-' + s; });
    if (n === 'inset') return SIDES.slice();
    if (n === 'border-width' || n === 'border-style' || n === 'border-color') { var w = n.slice(7); return SIDES.map(function (s) { return 'border-' + s + '-' + w; }); }
    if (n === 'border') return [].concat(shorthandParts('border-width'), shorthandParts('border-style'), shorthandParts('border-color'));
    if (/^border-(top|right|bottom|left)$/.test(n)) return [n + '-width', n + '-style', n + '-color'];
    if (n === 'border-radius') return ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
    if (n === 'flex') return ['flex-grow', 'flex-shrink', 'flex-basis'];
    if (n === 'gap') return ['row-gap', 'column-gap'];
    if (n === 'overflow') return ['overflow-x', 'overflow-y'];
    if (n === 'flex-flow') return ['flex-direction', 'flex-wrap'];
    if (n === 'place-items') return ['align-items', 'justify-items'];
    if (n === 'place-content') return ['align-content', 'justify-content'];
    if (n === 'place-self') return ['align-self', 'justify-self'];
    if (n === 'grid-gap') return ['row-gap', 'column-gap'];
    if (n === 'grid-row-gap') return ['row-gap'];
    if (n === 'grid-column-gap') return ['column-gap'];
    if (n === 'grid-template') return ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'];
    if (n === 'grid') return ['grid-template-rows', 'grid-template-columns', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-rows', 'grid-auto-columns'];
    if (n === 'outline') return ['outline-width', 'outline-style', 'outline-color'];
    if (n === 'font') return ['font-style', 'font-variant', 'font-weight', 'font-size', 'line-height', 'font-family'];
    return null;
  }
  // a shorthand's longhands, or null; values with var() stay whole (their
  // parts are known only when computed)
  // the logical properties (margin-inline, padding-block, inset-inline,
  // border-inline-start, ...) as their logical longhands (margin-inline-
  // start, border-block-end-width, ...): which physical side each is
  // depends on the element's writing mode and direction, known when its
  // style is computed (physicalOf)
  function logicalLonghands(n, v) {
    var m = /^(margin|padding|inset|border)-(inline|block)(?:-(start|end))?(-width|-style|-color)?$/.exec(n);
    if (!m) return null;
    var base = m[1], axis = m[2], side = m[3], part = m[4] || '';
    var out = {};
    if (side) {
      if (base !== 'border' || part) return null;
      var bs = expandShorthand('border-left', v);
      for (var kb0 in bs) out[n + kb0.slice('border-left'.length)] = bs[kb0];
      return out;
    }
    if (/var\(/.test(v)) { out[n] = v; return out; }
    var ends = [base + '-' + axis + '-start' + part, base + '-' + axis + '-end' + part];
    if (base === 'border' && !part) {
      var a = logicalLonghands(ends[0], v), b = logicalLonghands(ends[1], v);
      for (var ka in a) out[ka] = a[ka];
      for (var kb in b) out[kb] = b[kb];
      return out;
    }
    var vals = splitValue(v);
    out[ends[0]] = vals[0];
    out[ends[1]] = vals.length > 1 ? vals[1] : vals[0];
    return out;
  }
  // a logical longhand's physical property for an element in writing mode
  // wm and direction dir (CSS Logical 4), or null for any other name
  function physicalOf(n, wm, dir) {
    var sz = /^(min-|max-)?(inline|block)-size$/.exec(n);
    var vert = /^(vertical|sideways)/.test(wm || '');
    if (sz) return (sz[1] || '') + ((sz[2] === 'inline') !== vert ? 'width' : 'height');
    var m = /^(margin|padding|inset|border)-(inline|block)-(start|end)(-width|-style|-color)?$/.exec(n);
    if (!m) return null;
    var side;
    if (m[2] === 'block') {
      var rl = wm === 'vertical-rl' || wm === 'sideways-rl';
      side = !vert ? (m[3] === 'start' ? 'top' : 'bottom') : ((m[3] === 'start') === rl ? 'right' : 'left');
    } else {
      var fwd = (m[3] === 'start') === (dir !== 'rtl');
      side = vert ? (fwd ? 'top' : 'bottom') : (fwd ? 'left' : 'right');
    }
    return m[1] === 'inset' ? side : m[1] + '-' + side + (m[4] || '');
  }
  // grid-template: rows / columns, or the areas form ("a b" 10px "c d" /
  // 1fr 1fr); grid: the same, or an auto-flow side (CSS Grid 7.4, 7.8)
  function gridLonghands(n, v) {
    var out = { 'grid-template-rows': 'none', 'grid-template-columns': 'none', 'grid-template-areas': 'none' };
    if (n === 'grid') { out['grid-auto-flow'] = 'row'; out['grid-auto-rows'] = 'auto'; out['grid-auto-columns'] = 'auto'; }
    var t = v.trim();
    if (/^(none|initial|unset|inherit|revert)$/i.test(t)) return out;
    var depth = 0, cut = -1, quote = '';
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '/' && depth === 0) { cut = i; break; }
    }
    var left = (cut < 0 ? t : t.slice(0, cut)).trim(), right = cut < 0 ? '' : t.slice(cut + 1).trim();
    if (n === 'grid' && /\bauto-flow\b/.test(left)) {
      out['grid-auto-flow'] = /\bdense\b/.test(left) ? 'row dense' : 'row';
      var ar = left.replace(/\bauto-flow\b/, '').replace(/\bdense\b/, '').trim();
      if (ar) out['grid-auto-rows'] = ar;
      if (right) out['grid-template-columns'] = right;
      return out;
    }
    if (n === 'grid' && /\bauto-flow\b/.test(right)) {
      out['grid-auto-flow'] = /\bdense\b/.test(right) ? 'column dense' : 'column';
      var ac = right.replace(/\bauto-flow\b/, '').replace(/\bdense\b/, '').trim();
      if (ac) out['grid-auto-columns'] = ac;
      if (left) out['grid-template-rows'] = left;
      return out;
    }
    if (/["']/.test(left)) {
      // the areas form: each string a row, the size after it the row's
      var areas = [], rows = [], re = /(\[[^\]]*\]\s*)?(["'])([^"']*)\2\s*([^"'\[]*?)?\s*(\[[^\]]*\])?\s*(?=["'\[]|$)/g, m;
      while ((m = re.exec(left)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        areas.push('"' + m[3] + '"');
        rows.push((m[4] || '').trim() || 'auto');
      }
      out['grid-template-areas'] = areas.join(' ');
      out['grid-template-rows'] = rows.join(' ');
      if (right) out['grid-template-columns'] = right;
      return out;
    }
    out['grid-template-rows'] = left;
    if (right) out['grid-template-columns'] = right;
    return out;
  }
  function expandShorthand(n, v) {
    var logical = logicalLonghands(n, v);
    if (logical) return logical;
    var parts = shorthandParts(n);
    if (!parts) {
      if (n === 'background') {
        var bg = splitValue(v), color = null, image = null;
        for (var i = 0; i < bg.length; i++) {
          if (isColorWord(bg[i]) && !/^var\(/.test(bg[i])) color = bg[i];
          else if (/^(url|linear-gradient|radial-gradient|repeating-|conic-gradient)/.test(bg[i])) image = bg[i];
          else if (/^var\(/.test(bg[i]) && bg.length === 1) color = bg[i];
        }
        var o = { 'background-color': color || 'transparent', 'background-image': image || 'none' };
        return o;
      }
      return null;
    }
    if (/var\(/.test(v)) {
      var o2 = {};
      o2[n] = v;
      return o2;
    }
    var out = {};
    var low = v.toLowerCase();
    if (n === 'margin' || n === 'padding' || n === 'inset' || n === 'border-width' || n === 'border-style' || n === 'border-color' || n === 'border-radius') {
      var s = boxSides(n === 'border-radius' ? v.split('/')[0].trim() : v);
      for (var k = 0; k < 4; k++) out[parts[k]] = s[k];
      return out;
    }
    if (n === 'border' || /^border-(top|right|bottom|left)$/.test(n) || n === 'outline') {
      var w = 'medium', st = 'none', c = 'currentcolor';
      var toks = splitValue(v);
      for (var t = 0; t < toks.length; t++) {
        if (BORDER_STYLES.test(toks[t])) st = toks[t];
        else if (isLength(toks[t])) w = toks[t];
        else c = toks[t];
      }
      if (low === 'none' || low === '0') { st = 'none'; w = low === '0' ? '0' : 'medium'; }
      if (n === 'border') {
        for (var q = 0; q < 4; q++) { out['border-' + SIDES[q] + '-width'] = w; out['border-' + SIDES[q] + '-style'] = st; out['border-' + SIDES[q] + '-color'] = c; }
      } else { out[n + '-width'] = w; out[n + '-style'] = st; out[n + '-color'] = c; }
      return out;
    }
    if (n === 'flex') {
      var f = splitValue(v);
      if (low === 'none') { out['flex-grow'] = '0'; out['flex-shrink'] = '0'; out['flex-basis'] = 'auto'; }
      else if (low === 'auto') { out['flex-grow'] = '1'; out['flex-shrink'] = '1'; out['flex-basis'] = 'auto'; }
      else if (low === 'initial') { out['flex-grow'] = '0'; out['flex-shrink'] = '1'; out['flex-basis'] = 'auto'; }
      else {
        out['flex-grow'] = '1'; out['flex-shrink'] = '1'; out['flex-basis'] = '0%';
        var nums = [];
        for (var z = 0; z < f.length; z++) { if (/^[\d.]+$/.test(f[z])) nums.push(f[z]); else out['flex-basis'] = f[z]; }
        if (nums.length) out['flex-grow'] = nums[0];
        if (nums.length > 1) out['flex-shrink'] = nums[1];
      }
      return out;
    }
    if (n === 'font') {
      // [style] [variant] [weight] size[/line-height] family; a keyword for all
      if (/^(inherit|initial|unset|revert)$/.test(low)) { for (var fp = 0; fp < parts.length; fp++) out[parts[fp]] = low; return out; }
      var fm = /^(.*?)\b([\d.]+(?:px|em|rem|%|pt|vh|vw)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*(\S+))?\s+(\S.*)$/.exec(v.trim());
      if (!fm) return {};
      out['font-style'] = 'normal'; out['font-variant'] = 'normal'; out['font-weight'] = 'normal';
      var pre = splitValue(fm[1]);
      for (var fq = 0; fq < pre.length; fq++) {
        if (/^(italic|oblique)$/.test(pre[fq])) out['font-style'] = pre[fq];
        else if (pre[fq] === 'small-caps') out['font-variant'] = pre[fq];
        else if (/^(bold|bolder|lighter|\d{3})$/.test(pre[fq])) out['font-weight'] = pre[fq];
      }
      out['font-size'] = fm[2]; out['line-height'] = fm[3] || 'normal'; out['font-family'] = fm[4];
      return out;
    }
    if (n === 'gap' || n === 'grid-gap') { var g = splitValue(v); out['row-gap'] = g[0]; out['column-gap'] = g[1] || g[0]; return out; }
    if (n === 'grid-row-gap') { out['row-gap'] = v.trim(); return out; }
    if (n === 'grid-column-gap') { out['column-gap'] = v.trim(); return out; }
    if (n === 'grid-template' || n === 'grid') return gridLonghands(n, v);
    if (n === 'overflow') { var ov = splitValue(v); out['overflow-x'] = ov[0]; out['overflow-y'] = ov[1] || ov[0]; return out; }
    if (n === 'flex-flow') {
      var ff = splitValue(v);
      out['flex-direction'] = 'row'; out['flex-wrap'] = 'nowrap';
      for (var y = 0; y < ff.length; y++) { if (/wrap/.test(ff[y])) out['flex-wrap'] = ff[y]; else out['flex-direction'] = ff[y]; }
      return out;
    }
    var pp = splitValue(v);
    out[parts[0]] = pp[0];
    out[parts[1]] = pp[1] || pp[0];
    return out;
  }

  // ---- elements ------------------------------------------------------------

  class Element extends Node {
    constructor(qname, ns) {
      super();
      this._qname = qname;
      this.namespaceURI = ns === undefined ? HTML_NS : ns;
      var c = qname.indexOf(':');
      this.prefix = c > 0 ? qname.slice(0, c) : null;
      this.localName = c > 0 ? qname.slice(c + 1) : qname;
      this._attrs = [];
      this._style = null;
      this._styleSync = false;
      this.scrollTop = 0;
      this.scrollLeft = 0;
      this.shadowRoot = null;
    }
    get nodeType() { return 1; }
    get nodeName() { return this.tagName; }
    get tagName() { return this.namespaceURI === HTML_NS ? this._qname.toUpperCase() : this._qname; }
    get attributes() { return NamedNodeMap(this); }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get classList() { return this._cl || (this._cl = new DOMTokenList(this, 'class')); }
    get slot() { return this.getAttribute('slot') || ''; }
    _norm(n) { n = String(n); return this.namespaceURI === HTML_NS ? n.toLowerCase() : n; }
    _find(n) { for (var i = 0; i < this._attrs.length; i++) if (this._attrs[i].name === n) return i; return -1; }
    getAttribute(n) { var i = this._find(this._norm(n)); return i < 0 ? null : this._attrs[i]._v; }
    getAttributeNS(ns, n) { return this.getAttribute(n); }
    getAttributeNode(n) { var i = this._find(this._norm(n)); return i < 0 ? null : this._attrs[i]; }
    getAttributeNames() { return this._attrs.map(function (a) { return a.name; }); }
    hasAttribute(n) { return this._find(this._norm(n)) >= 0; }
    hasAttributeNS(ns, n) { return this.hasAttribute(n); }
    hasAttributes() { return this._attrs.length > 0; }
    setAttribute(n, v) {
      n = this._norm(n);
      if (!/^[^\s"'>\/=\0]+$/.test(n)) throw DOMException("Failed to execute 'setAttribute' on 'Element': '" + n + "' is not a valid attribute name.", 'InvalidCharacterError');
      v = String(v);
      var i = this._find(n);
      var old = i < 0 ? null : this._attrs[i]._v;
      if (i < 0) this._attrs.push(new Attr(n, v, this)); else this._attrs[i]._v = v;
      this._attrChanged(n, old, v);
    }
    setAttributeNS(ns, n, v) {
      var c = String(n).indexOf(':');
      this.setAttribute(c > 0 && ns !== 'http://www.w3.org/1999/xlink' ? String(n).slice(c + 1) : n, v);
    }
    removeAttribute(n) {
      n = this._norm(n);
      var i = this._find(n);
      if (i < 0) return;
      var old = this._attrs[i]._v;
      this._attrs.splice(i, 1);
      this._attrChanged(n, old, null);
    }
    removeAttributeNS(ns, n) { this.removeAttribute(n); }
    toggleAttribute(n, force) {
      var has = this.hasAttribute(n);
      if (force === undefined ? has : !force) { this.removeAttribute(n); return false; }
      if (!has) this.setAttribute(n, '');
      return true;
    }
    setAttributeNode(a) { this.setAttribute(a.name, a.value); return null; }
    _attrChanged(n, old, v) {
      attrChanged(this);
      if (n === 'style' && !this._styleSync && this._style) {
        this._styleSync = true;
        this._style.cssText = v || '';
        this._styleSync = false;
      }
      if (this._attrHook) this._attrHook(n, old, v);
      queueMutation(this, 'attributes', { attributeName: n, oldValue: old });
    }
    get style() {
      if (!this._style) {
        var d = new CSSStyleDeclaration(this);
        var s = this.getAttribute('style');
        if (s) { this._styleSync = true; d.cssText = s; this._styleSync = false; }
        this._styleProxy = styleProxy(d);
        this._style = d;
      }
      return this._styleProxy;
    }
    set style(v) { this.style.cssText = v; }
    get innerHTML() { return serializeChildren(this); }
    set innerHTML(v) {
      removeAll(this);
      var frag = parseFragment(String(v === null || v === undefined ? '' : v), this);
      this.appendChild(frag);
    }
    get outerHTML() { return serialize(this, false); }
    set outerHTML(v) {
      var p = this.parentNode;
      if (!p) return;
      var frag = parseFragment(String(v), p.nodeType === 1 ? p : null);
      p.replaceChild(frag, this);
    }
    insertAdjacentHTML(where, html) { this.insertAdjacentElement(where, parseFragment(String(html), this)); }
    insertAdjacentText(where, text) { this.insertAdjacentElement(where, this.ownerDocument.createTextNode(text)); }
    insertAdjacentElement(where, el) {
      where = String(where).toLowerCase();
      if (where === 'beforebegin') { if (this.parentNode) this.parentNode.insertBefore(el, this); }
      else if (where === 'afterbegin') this.insertBefore(el, this.firstChild);
      else if (where === 'beforeend') this.appendChild(el);
      else if (where === 'afterend') { if (this.parentNode) this.parentNode.insertBefore(el, this.nextSibling); }
      else throw DOMException("The value provided ('" + where + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.", 'SyntaxError');
      return el;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    before() { insertNodes(this.parentNode, this, arguments, this.ownerDocument); }
    after() { insertNodes(this.parentNode, this.nextSibling, arguments, this.ownerDocument); }
    replaceWith() { var p = this.parentNode; if (!p) return; var next = this.nextSibling; p.removeChild(this); insertNodes(p, next, arguments, this.ownerDocument); }
    get nextElementSibling() { return siblingElement(this, 1); }
    get previousElementSibling() { return siblingElement(this, -1); }
    matches(s) { return matchesSelector(this, s); }
    webkitMatchesSelector(s) { return matchesSelector(this, s); }
    closest(s) {
      var list = parseSelectorList(s);
      for (var n = this; n && n.nodeType === 1; n = n.parentNode) if (matchList(n, list)) return n;
      return null;
    }
    getBoundingClientRect() { return rectOf(this); }
    getClientRects() { var r = rectOf(this); return r.width || r.height ? [r] : []; }
    get clientWidth() { return sizeOf(this, 'cw'); }
    get clientHeight() { return sizeOf(this, 'ch'); }
    get clientTop() { return 0; }
    get clientLeft() { return 0; }
    get scrollWidth() { return sizeOf(this, 'sw'); }
    get scrollHeight() { return sizeOf(this, 'sh'); }
    scrollTo(x, y) { if (typeof x === 'object' && x) { y = x.top; x = x.left; } if (x !== undefined) this.scrollLeft = +x || 0; if (y !== undefined) this.scrollTop = +y || 0; }
    scroll(x, y) { this.scrollTo(x, y); }
    scrollBy(x, y) { if (typeof x === 'object' && x) { y = x.top; x = x.left; } this.scrollLeft += +x || 0; this.scrollTop += +y || 0; }
    scrollIntoView() {}
    attachShadow(init) {
      var r = new ShadowRoot(this, init);
      this.shadowRoot = init && init.mode === 'closed' ? null : r;
      return r;
    }
    animate() { return { finished: Promise.resolve(), cancel: function () {}, play: function () {}, pause: function () {}, onfinish: null, addEventListener: function () {} }; }
    getAnimations() { return []; }
    requestPointerLock() {}
    setPointerCapture(id) { this._capture = id; }
    releasePointerCapture(id) { this._capture = undefined; }
    hasPointerCapture(id) { return this._capture === id; }
    toString() { return '[object ' + (this.constructor.name || 'Element') + ']'; }
  }
  mixin(Element, ParentNode);

  class ShadowRoot extends DocumentFragment {
    constructor(host, init) { super(); this.host = host; this.mode = (init && init.mode) || 'open'; }
    get innerHTML() { return serializeChildren(this); }
    set innerHTML(v) { removeAll(this); this.appendChild(parseFragment(String(v), null)); }
  }

  class HTMLElement extends Element {
    constructor(qname) { super(qname, HTML_NS); this.dataset = datasetOf(this); }
    get title() { return this.getAttribute('title') || ''; }
    set title(v) { this.setAttribute('title', v); }
    get lang() { return this.getAttribute('lang') || ''; }
    set lang(v) { this.setAttribute('lang', v); }
    get dir() { return this.getAttribute('dir') || ''; }
    set dir(v) { this.setAttribute('dir', v); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { this.toggleAttribute('hidden', !!v); }
    get inert() { return this.hasAttribute('inert'); }
    set inert(v) { this.toggleAttribute('inert', !!v); }
    get tabIndex() {
      var t = this.getAttribute('tabindex');
      if (t !== null && /^-?\d+$/.test(t.trim())) return parseInt(t, 10);
      return focusableByDefault(this) ? 0 : -1;
    }
    set tabIndex(v) { this.setAttribute('tabindex', String(v | 0)); }
    get accessKey() { return this.getAttribute('accesskey') || ''; }
    get draggable() { return this.getAttribute('draggable') === 'true'; }
    set draggable(v) { this.setAttribute('draggable', v ? 'true' : 'false'); }
    get contentEditable() { return this.getAttribute('contenteditable') || 'inherit'; }
    set contentEditable(v) { this.setAttribute('contenteditable', v); }
    get isContentEditable() { for (var n = this; n && n.nodeType === 1; n = n.parentNode) { var c = n.getAttribute('contenteditable'); if (c === '' || c === 'true') return true; if (c === 'false') return false; } return false; }
    get spellcheck() { return this.getAttribute('spellcheck') !== 'false'; }
    set spellcheck(v) { this.setAttribute('spellcheck', v ? 'true' : 'false'); }
    get innerText() { return innerTextOf(this); }
    set innerText(v) { this.textContent = v; }
    get outerText() { return this.innerText; }
    get offsetParent() { for (var n = this.parentNode; n && n.nodeType === 1; n = n.parentNode) { var p = computedOf(n).position; if (p && p !== 'static') return n; } return doc ? doc.body : null; }
    get offsetTop() { var r = rectOf(this), p = this.offsetParent; return r.top - (p && p !== this ? rectOf(p).top : 0); }
    get offsetLeft() { var r = rectOf(this), p = this.offsetParent; return r.left - (p && p !== this ? rectOf(p).left : 0); }
    get offsetWidth() { return Math.round(layoutSize(this)[0]); }
    get offsetHeight() { return Math.round(layoutSize(this)[1]); }
    focus(opts) { focusElement(this, opts); }
    blur() { if (doc && doc._active === this) focusElement(null); }
    click() {
      if (this.disabled) return;
      var ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: G, detail: 1 });
      activatedClick(this, ev);
    }
  }

  function datasetOf(el) {
    function name(k) { return 'data-' + String(k).replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }
    return new Proxy({}, {
      get: function (t, k) { if (typeof k !== 'string') return undefined; var v = el.getAttribute(name(k)); return v === null ? undefined : v; },
      set: function (t, k, v) { el.setAttribute(name(k), v); return true; },
      deleteProperty: function (t, k) { el.removeAttribute(name(k)); return true; },
      has: function (t, k) { return el.hasAttribute(name(k)); },
      ownKeys: function () { return el._attrs.filter(function (a) { return a.name.slice(0, 5) === 'data-'; }).map(function (a) { return camel(a.name.slice(5)); }); },
      getOwnPropertyDescriptor: function (t, k) { var v = el.getAttribute(name(k)); return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true }; }
    });
  }

  function reflect(cls, props) {
    // string attributes as properties
    props.forEach(function (p) {
      var a = p.toLowerCase();
      Object.defineProperty(cls.prototype, p, {
        get: function () { return this.getAttribute(a) || ''; },
        set: function (v) { this.setAttribute(a, v); },
        configurable: true, enumerable: true
      });
    });
  }
  function reflectBool(cls, props) {
    props.forEach(function (p) {
      var a = p.toLowerCase();
      Object.defineProperty(cls.prototype, p, {
        get: function () { return this.hasAttribute(a); },
        set: function (v) { this.toggleAttribute(a, !!v); },
        configurable: true, enumerable: true
      });
    });
  }
  function urlProp(cls, props) {
    props.forEach(function (p) {
      var a = p.toLowerCase();
      Object.defineProperty(cls.prototype, p, {
        get: function () { var v = this.getAttribute(a); return v === null ? '' : resolveURL(v); },
        set: function (v) { this.setAttribute(a, v); },
        configurable: true, enumerable: true
      });
    });
  }

  class HTMLDivElement extends HTMLElement {}
  class HTMLSpanElement extends HTMLElement {}
  class HTMLParagraphElement extends HTMLElement {}
  class HTMLHeadingElement extends HTMLElement {}
  class HTMLPreElement extends HTMLElement {}
  class HTMLQuoteElement extends HTMLElement {}
  class HTMLBRElement extends HTMLElement {}
  class HTMLHRElement extends HTMLElement {}
  class HTMLUListElement extends HTMLElement {}
  class HTMLOListElement extends HTMLElement {}
  class HTMLLIElement extends HTMLElement {}
  class HTMLDListElement extends HTMLElement {}
  class HTMLTableElement extends HTMLElement {
    get rows() {
      var t = this;
      return liveCollection(function () {
        var out = [], sec = { thead: [], tbody: [], tfoot: [] };
        t.children.forEach(function (c) {
          if (c.localName === 'tr') sec.tbody.push(c);
          else if (sec[c.localName]) c.children.forEach(function (r) { if (r.localName === 'tr') sec[c.localName].push(r); });
        });
        return out.concat(sec.thead, sec.tbody, sec.tfoot);
      });
    }
    get tBodies() { var t = this; return liveCollection(function () { return t.children.filter(function (c) { return c.localName === 'tbody'; }); }); }
  }
  class HTMLTableSectionElement extends HTMLElement { get rows() { var t = this; return liveCollection(function () { return t.children.filter(function (c) { return c.localName === 'tr'; }); }); } }
  class HTMLTableRowElement extends HTMLElement { get cells() { return NodeList(this.children.filter(function (c) { return c.localName === 'td' || c.localName === 'th'; })); } }
  class HTMLTableCellElement extends HTMLElement {
    get colSpan() { return parseInt(this.getAttribute('colspan') || '1', 10) || 1; }
    set colSpan(v) { this.setAttribute('colspan', v); }
    get rowSpan() { return parseInt(this.getAttribute('rowspan') || '1', 10) || 1; }
    set rowSpan(v) { this.setAttribute('rowspan', v); }
  }
  class HTMLTableColElement extends HTMLElement {}
  class HTMLTableCaptionElement extends HTMLElement {}
  class HTMLHtmlElement extends HTMLElement {}
  class HTMLHeadElement extends HTMLElement {}
  class HTMLBodyElement extends HTMLElement {}
  class HTMLTitleElement extends HTMLElement {
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
  }
  class HTMLMetaElement extends HTMLElement {}
  reflect(HTMLMetaElement, ['name', 'content', 'charset']);
  class HTMLBaseElement extends HTMLElement {}
  class HTMLStyleElement extends HTMLElement {
    constructor(q) { super(q); this._sheet = null; }
    get sheet() { return this.isConnected ? sheetOfStyle(this) : null; }
    _connected() { changed(); }
  }
  reflect(HTMLStyleElement, ['media', 'type']);
  class HTMLLinkElement extends HTMLElement {
    get sheet() { return null; }
    get relList() { return new DOMTokenList(this, 'rel'); }
  }
  reflect(HTMLLinkElement, ['rel', 'type', 'media', 'as', 'crossOrigin', 'integrity']);
  urlProp(HTMLLinkElement, ['href']);
  class HTMLScriptElement extends HTMLElement {
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
    _connected() { if (this._parser) return; scriptInserted(this); }
  }
  reflect(HTMLScriptElement, ['type', 'charset', 'crossOrigin', 'integrity', 'nonce']);
  reflectBool(HTMLScriptElement, ['async', 'defer', 'noModule']);
  urlProp(HTMLScriptElement, ['src']);
  class HTMLAnchorElement extends HTMLElement {
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
    get relList() { return new DOMTokenList(this, 'rel'); }
  }
  reflect(HTMLAnchorElement, ['target', 'rel', 'download', 'hreflang', 'type', 'referrerPolicy']);
  urlProp(HTMLAnchorElement, ['href']);
  ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(function (k) {
    Object.defineProperty(HTMLAnchorElement.prototype, k, { get: function () { var u = parseURL(this.href); return u ? u[k] : ''; }, configurable: true });
  });
  class HTMLImageElement extends HTMLElement {
    constructor(q) { super(q); this.complete = true; }
    get naturalWidth() { return this.width; }
    get naturalHeight() { return this.height; }
    get width() { var a = this.getAttribute('width'); return a !== null ? parseInt(a, 10) || 0 : rectOf(this).width; }
    set width(v) { this.setAttribute('width', v); }
    get height() { var a = this.getAttribute('height'); return a !== null ? parseInt(a, 10) || 0 : rectOf(this).height; }
    set height(v) { this.setAttribute('height', v); }
    get currentSrc() { return this.src; }
    decode() { return Promise.resolve(); }
    _connected() {
      var self = this;
      if (this.getAttribute('src')) setTimeout(function () { dispatch(self, new Event('load')); }, 0);
    }
  }
  reflect(HTMLImageElement, ['alt', 'srcset', 'sizes', 'crossOrigin', 'useMap', 'loading', 'decoding', 'referrerPolicy']);
  urlProp(HTMLImageElement, ['src']);
  class HTMLIFrameElement extends HTMLElement {
    get contentWindow() { return null; }
    get contentDocument() { return null; }
  }
  reflect(HTMLIFrameElement, ['name', 'sandbox', 'allow', 'width', 'height']);
  urlProp(HTMLIFrameElement, ['src']);
  class HTMLCanvasElement extends HTMLElement {
    getContext(type, opts) { return canvasContext(this, type, opts); }
    toDataURL() { var c = this.getContext('2d'); return c._pixelMode() ? c._png() : 'data:,'; }
    toBlob(cb) { setTimeout(function () { cb(new Blob([], { type: 'image/png' })); }, 0); }
    get width() { return parseInt(this.getAttribute('width') || '300', 10); }
    set width(v) { this.setAttribute('width', v); if (this._ctx) this._ctx.reset(); }
    get height() { return parseInt(this.getAttribute('height') || '150', 10); }
    set height(v) { this.setAttribute('height', v); if (this._ctx) this._ctx.reset(); }
  }

  // ---- canvas 2D -----------------------------------------------------------
  //
  // A canvas keeps what is drawn on it as vector shapes, not pixels: each
  // fill and stroke is a path in the canvas's own coordinates (the current
  // transform applied), each fillText a run of text there. The render tree
  // gives a drawn canvas two kinds of children (canvasRender): one inline
  // SVG picture with the shapes, which the host draws with its SVG painter
  // as any <svg>, and the text runs as absolutely placed spans (the SVG
  // painter has no <text>). So a chart library draws through the same
  // display list as the rest of the page, and the native renderer needs
  // nothing new.
  //
  // Not kept as shapes: clipping (shapes are drawn whole), shadows,
  // compositing other than source-over, and the turn of rotated text (it is
  // drawn level at its place). A gradient paints the average of its stops.
  // Text is measured with Helvetica's advance widths (the window draws
  // Arial as Open Sans).
  //
  // Pixels: a canvas whose page reads or copies them (getImageData,
  // putImageData, drawImage, createPattern, toDataURL, or a context asked
  // for with willReadFrequently) turns into a bitmap for good, if the
  // engine has CErXes's rasterizer (__cerRaster, a premultiplied RGBA
  // Float64Array the context keeps). Its shapes so far are drawn into it,
  // and from then on each fill and stroke is a few numbers in a queue that
  // is drawn when the pixels are needed (read, copied, or the page
  // rendered); clipping, compositing, gradients and patterns are then
  // kept. The render tree gives it a PNG (made once per change) with the
  // text still as spans over it. A canvas that never reads pixels stays
  // vector shapes and costs nothing more.

  var CANVAS_W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
    667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556,
    500, 722, 500, 500, 500, 334, 260, 334, 584];
  function canvasFont(f) { return memo(fontMemo, String(f), parseCanvasFont); }
  function parseCanvasFont(f) {
    var o = { style: 'normal', weight: '400', size: 10, family: 'sans-serif', text: '10px sans-serif' };
    var m = /^\s*((?:[a-z-]+\s+|\d{3}\s+)*)([\d.]+)(px|pt|em|rem|%)(?:\s*\/\s*[^\s]+)?\s+(.+?)\s*$/i.exec(String(f));
    if (!m) return null;
    var size = parseFloat(m[2]), unit = m[3].toLowerCase();
    o.size = unit === 'pt' ? size * 4 / 3 : unit === 'em' || unit === 'rem' ? size * 16 : unit === '%' ? size * 0.16 : size;
    o.family = m[4];
    (m[1] || '').trim().split(/\s+/).forEach(function (t) {
      t = t.toLowerCase();
      if (t === 'italic' || t === 'oblique') o.style = t;
      else if (t === 'bold' || t === 'bolder') o.weight = '700';
      else if (t === 'lighter') o.weight = '300';
      else if (/^\d{3}$/.test(t)) o.weight = t;
    });
    o.text = (o.style !== 'normal' ? o.style + ' ' : '') + (o.weight !== '400' ? (o.weight === '700' ? 'bold ' : o.weight + ' ') : '') + fmtNum(o.size) + 'px ' + o.family;
    return o;
  }
  function canvasTextWidth(s, font) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 32 && c <= 126) w += CANVAS_W[c - 32];
      else if (c >= 0xc0 && c <= 0x24f) {
        // a Latin letter with a mark: as wide as the letter without it
        var base = s.charAt(i).normalize ? s.charAt(i).normalize('NFD').charCodeAt(0) : 0;
        w += base >= 32 && base <= 126 ? CANVAS_W[base - 32] : 556;
      } else if (c >= 0x2e80 && c <= 0x9fff || c >= 0xac00 && c <= 0xd7af || c >= 0xff00 && c <= 0xffef) w += 1000;
      else if (c >= 0xdc00 && c <= 0xdfff) continue;
      else w += 556;
    }
    w = w * font.size / 1000;
    if (parseInt(font.weight, 10) >= 600) w *= 1.06;
    return w;
  }
  function fmtNum(v) { return String(Math.round(v * 100) / 100); }
  // a paint as [#rrggbb, alpha], or null for none
  function canvasPaint(p) {
    if (p instanceof CanvasGradient) {
      if (!p._stops.length) return null;
      var r = 0, g = 0, b = 0, a = 0;
      for (var i = 0; i < p._stops.length; i++) { var q = p._stops[i][1]; r += q[0]; g += q[1]; b += q[2]; a += q[3]; }
      var n = p._stops.length;
      return rgbHex([r / n, g / n, b / n, a / n]);
    }
    if (typeof p !== 'string') return null;
    return memo(paintMemo, p, function (k) { var c = colorRGBA(k); return c ? rgbHex(c) : null; });
  }
  // a chart sets the same few colours and fonts for every shape: each
  // string is parsed once (the results are not changed by their users)
  var colorMemo = new Map(), fontMemo = new Map(), paintMemo = new Map();
  function memo(m, k, f) {
    var v = m.get(k);
    if (v === undefined) {
      if (m.size > 500) m.clear();
      v = f(k);
      m.set(k, v);
    }
    return v;
  }
  function colorRGBA(s) { return memo(colorMemo, String(s), parseRGBA); }
  function parseRGBA(s) {
    var m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(normalizeColor(s));
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  }
  function rgbHex(c) {
    var h = '#';
    for (var i = 0; i < 3; i++) { var v = Math.max(0, Math.min(255, Math.round(c[i]))); h += (v < 16 ? '0' : '') + v.toString(16); }
    return [h, c[3]];
  }
  class CanvasGradient {
    constructor(kind, geo) { this._stops = []; this._kind = kind || ''; this._geo = geo || []; }
    addColorStop(offset, color) {
      var c = colorRGBA(color);
      if (!c) throw new DOMException('The value provided (\'' + color + '\') could not be parsed as a color.', 'SyntaxError');
      this._stops.push([+offset, c]);
    }
  }
  class CanvasPattern {
    constructor(src, rep) {
      this._src = src || null; this._m = [1, 0, 0, 1, 0, 0];
      rep = rep === null || rep === undefined || rep === '' ? 'repeat' : String(rep);
      this._rx = rep === 'repeat' || rep === 'repeat-x'; this._ry = rep === 'repeat' || rep === 'repeat-y';
    }
    setTransform(m) { if (m) this._m = [m.a !== undefined ? m.a : 1, m.b || 0, m.c || 0, m.d !== undefined ? m.d : 1, m.e || 0, m.f || 0]; }
  }
  function canvasContext(el, type, opts) {
    if (String(type) !== '2d') return null;
    if (!el._ctx) {
      el._ctx = new CanvasRenderingContext2D(el);
      if (opts && opts.willReadFrequently) { el._ctx._wrf = true; el._ctx._pixelMode(); }
    }
    return el._ctx;
  }
  // a canvas's pixels as a source to draw from: a copy, or null when it
  // has none (no rasterizer, an <img>: pictures are not decoded here)
  function canvasSource(img) {
    if (img && img._px instanceof Float64Array) return { px: img._px, w: img.width, h: img.height };
    if (!(img instanceof HTMLCanvasElement || img instanceof OffscreenCanvas)) return null;
    var w = img.width, h = img.height, c = img._ctx;
    if (!w || !h || typeof __cerRaster !== 'function') return null;
    if (!c) return { px: new Float64Array(w * h * 4), w: w, h: h };
    if (!c._pixelMode()) return null;
    c._flush();
    return { px: c._px.slice(), w: w, h: h };
  }
  // the rasterizer's command codes (ComponentEngine cer/src/raster.rs)
  var COMPOSITE_OPS = { 'source-over': 0, 'source-in': 1, 'source-out': 2, 'source-atop': 3, 'destination-over': 4, 'destination-in': 5,
    'destination-out': 6, 'destination-atop': 7, lighter: 8, copy: 9, xor: 10 };
  var RASTER_PATH = { M: 1, L: 2, C: 3, Z: 5 };
  // a path's d (absolute M, L, C, Z, as CanvasPath writes it) as commands
  function rasterPath(q, d) {
    q.push(0);
    var re = /([MLCZ])([^MLCZ]*)/g, m;
    while ((m = re.exec(d))) {
      q.push(RASTER_PATH[m[1]]);
      if (m[1] === 'Z') continue;
      var a = m[2].trim().split(/[\s,]+/);
      for (var i = 0; i < a.length; i++) q.push(+a[i]);
    }
  }
  // an axis-aligned rectangle's d (CanvasPath.rect) as [x0, y0, x1, y1]
  function pathRect(d) {
    var m = /^M(\S+) (\S+)L(\S+) (\S+)L(\S+) (\S+)L(\S+) (\S+)Z$/.exec(d);
    if (!m) return null;
    var v = m.slice(1).map(Number);
    var across = v[1] === v[3] && v[2] === v[4] && v[5] === v[7] && v[6] === v[0];
    var down = v[0] === v[2] && v[3] === v[5] && v[4] === v[6] && v[7] === v[1];
    if (!across && !down) return null;
    return [Math.min(v[0], v[4]), Math.min(v[1], v[5]), Math.max(v[0], v[4]), Math.max(v[1], v[5])];
  }
  function invert(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function mul(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  }
  // an SVG path (Path2D's string) drawn into a CanvasPath through m
  function svgPathInto(p, m, str) {
    var t = String(str).match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    var i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0, prev = '';
    function num() { return +t[i++]; }
    while (i < t.length) {
      if (/[a-z]/i.test(t[i])) cmd = t[i++];
      var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
      if (C === 'Z') { p.close(); x = sx; y = sy; prev = C; continue; }
      if (i >= t.length || /[a-z]/i.test(t[i])) break;
      if (C === 'M') { x = ox + num(); y = oy + num(); p.moveTo(m, x, y); sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') { x = ox + num(); y = oy + num(); p.lineTo(m, x, y); }
      else if (C === 'H') { x = ox + num(); p.lineTo(m, x, y); }
      else if (C === 'V') { y = oy + num(); p.lineTo(m, x, y); }
      else if (C === 'C' || C === 'S') {
        var x1, y1;
        if (C === 'C') { x1 = ox + num(); y1 = oy + num(); } else if (prev === 'C' || prev === 'S') { x1 = 2 * x - cx; y1 = 2 * y - cy; } else { x1 = x; y1 = y; }
        cx = ox + num(); cy = oy + num(); x = ox + num(); y = oy + num();
        p.curve(m, x1, y1, cx, cy, x, y);
      } else if (C === 'Q' || C === 'T') {
        if (C === 'Q') { qx = ox + num(); qy = oy + num(); } else if (prev === 'Q' || prev === 'T') { qx = 2 * x - qx; qy = 2 * y - qy; } else { qx = x; qy = y; }
        x = ox + num(); y = oy + num();
        p.quad(m, qx, qy, x, y);
      } else if (C === 'A') {
        // an arc as the line to its end
        i += 5; x = ox + num(); y = oy + num(); p.lineTo(m, x, y);
      } else break;
      prev = C;
    }
  }
  class ImageData {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c || a.length / 4 / b; }
      this.colorSpace = 'srgb';
    }
  }
  class TextMetrics {
    constructor(w, size, align) {
      this.width = w;
      this.actualBoundingBoxLeft = align === 'center' ? w / 2 : align === 'right' || align === 'end' ? w : 0;
      this.actualBoundingBoxRight = w - this.actualBoundingBoxLeft;
      this.actualBoundingBoxAscent = size * 0.716;
      this.actualBoundingBoxDescent = size * 0.016;
      this.fontBoundingBoxAscent = size * 0.905;
      this.fontBoundingBoxDescent = size * 0.212;
      this.emHeightAscent = size * 0.81;
      this.emHeightDescent = size * 0.19;
      this.alphabeticBaseline = 0;
      this.hangingBaseline = size * 0.65;
      this.ideographicBaseline = -size * 0.19;
    }
  }
  // the transform of a context, a DOMMatrix's 2D part
  function matrixOf(m) {
    return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5], m11: m[0], m12: m[1], m21: m[2], m22: m[3], m41: m[4], m42: m[5], is2D: true,
      isIdentity: m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 };
  }
  // a path in canvas coordinates (SVG path data), built with the
  // transform at the time of each call
  class CanvasPath {
    constructor() { this.d = []; this.cur = null; this.start = null; this.user = null; }
    pt(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
    moveTo(m, x, y) { var p = this.pt(m, x, y); this.d.push('M' + fmtNum(p[0]) + ' ' + fmtNum(p[1])); this.cur = p; this.start = p; this.user = [x, y]; }
    lineTo(m, x, y) {
      if (!this.cur) { this.moveTo(m, x, y); return; }
      var p = this.pt(m, x, y);
      this.d.push('L' + fmtNum(p[0]) + ' ' + fmtNum(p[1])); this.cur = p; this.user = [x, y];
    }
    curve(m, x1, y1, x2, y2, x, y) {
      if (!this.cur) this.moveTo(m, x1, y1);
      var a = this.pt(m, x1, y1), b = this.pt(m, x2, y2), p = this.pt(m, x, y);
      this.d.push('C' + fmtNum(a[0]) + ' ' + fmtNum(a[1]) + ' ' + fmtNum(b[0]) + ' ' + fmtNum(b[1]) + ' ' + fmtNum(p[0]) + ' ' + fmtNum(p[1]));
      this.cur = p; this.user = [x, y];
    }
    quad(m, cx, cy, x, y) {
      if (!this.cur) this.moveTo(m, cx, cy);
      var u = this.user;
      this.curve(m, u[0] + 2 / 3 * (cx - u[0]), u[1] + 2 / 3 * (cy - u[1]), x + 2 / 3 * (cx - x), y + 2 / 3 * (cy - y), x, y);
    }
    close() { if (this.cur) { this.d.push('Z'); this.cur = this.start; } }
    rect(m, x, y, w, h) { this.moveTo(m, x, y); this.lineTo(m, x + w, y); this.lineTo(m, x + w, y + h); this.lineTo(m, x, y + h); this.close(); this.user = [x, y]; }
    // an elliptical arc as cubic Béziers of at most a quarter turn
    ellipse(m, x, y, rx, ry, rot, a0, a1, ccw) {
      if (rx < 0 || ry < 0) throw new DOMException('The radius provided is negative.', 'IndexSizeError');
      var T = Math.PI * 2, sweep = a1 - a0;
      if (!ccw && sweep >= T || ccw && -sweep >= T) sweep = ccw ? -T : T;
      else if (!ccw) { sweep = sweep % T; if (sweep < 0) sweep += T; }
      else { sweep = sweep % T; if (sweep > 0) sweep -= T; }
      var cr = Math.cos(rot), sr = Math.sin(rot);
      function at(t) { var ex = rx * Math.cos(t), ey = ry * Math.sin(t); return [x + ex * cr - ey * sr, y + ex * sr + ey * cr]; }
      function tan(t) { var ex = -rx * Math.sin(t), ey = ry * Math.cos(t); return [ex * cr - ey * sr, ex * sr + ey * cr]; }
      var p0 = at(a0);
      if (this.cur) this.lineTo(m, p0[0], p0[1]); else this.moveTo(m, p0[0], p0[1]);
      var n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)), step = sweep / n, k = 4 / 3 * Math.tan(step / 4);
      for (var i = 0; i < n; i++) {
        var t0 = a0 + i * step, t1 = t0 + step, s = at(t0), e = at(t1), d0 = tan(t0), d1 = tan(t1);
        this.curve(m, s[0] + k * d0[0], s[1] + k * d0[1], e[0] - k * d1[0], e[1] - k * d1[1], e[0], e[1]);
      }
    }
    arcTo(m, x1, y1, x2, y2, r) {
      if (!this.cur) { this.moveTo(m, x1, y1); return; }
      var x0 = this.user[0], y0 = this.user[1];
      var ax = x0 - x1, ay = y0 - y1, bx = x2 - x1, by = y2 - y1;
      var la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      var cross = ax * by - ay * bx;
      if (!r || !la || !lb || Math.abs(cross) < 1e-9) { this.lineTo(m, x1, y1); return; }
      var cos = (ax * bx + ay * by) / (la * lb), half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
      var dist = r / Math.tan(half);
      var t0 = [x1 + ax / la * dist, y1 + ay / la * dist], t1 = [x1 + bx / lb * dist, y1 + by / lb * dist];
      var ux = ax / la + bx / lb, uy = ay / la + by / lb, ul = Math.hypot(ux, uy), cd = r / Math.sin(half);
      var cx = x1 + ux / ul * cd, cy = y1 + uy / ul * cd;
      this.lineTo(m, t0[0], t0[1]);
      this.ellipse(m, cx, cy, r, r, 0, Math.atan2(t0[1] - cy, t0[0] - cx), Math.atan2(t1[1] - cy, t1[0] - cx), cross > 0);
    }
    roundRect(m, x, y, w, h, radii) {
      var r = Array.isArray(radii) ? radii : [radii === undefined ? 0 : radii];
      var rr = r.map(function (v) { return typeof v === 'object' && v ? +v.x || 0 : +v || 0; });
      var tl = rr[0], tr = rr.length > 1 ? rr[1] : tl, br = rr.length > 2 ? rr[2] : tl, bl = rr.length > 3 ? rr[3] : tr;
      if (rr.length === 2) { br = tl; bl = tr; }
      if (rr.length === 3) bl = tr;
      var H = Math.PI / 2;
      this.moveTo(m, x + tl, y);
      this.lineTo(m, x + w - tr, y); if (tr) this.ellipse(m, x + w - tr, y + tr, tr, tr, 0, -H, 0, false);
      this.lineTo(m, x + w, y + h - br); if (br) this.ellipse(m, x + w - br, y + h - br, br, br, 0, 0, H, false);
      this.lineTo(m, x + bl, y + h); if (bl) this.ellipse(m, x + bl, y + h - bl, bl, bl, 0, H, Math.PI, false);
      this.lineTo(m, x, y + tl); if (tl) this.ellipse(m, x + tl, y + tl, tl, tl, 0, Math.PI, Math.PI * 1.5, false);
      this.close();
    }
  }
  // the path methods of a context and of Path2D
  var PATH_OPS = {
    moveTo: function (p, m, a) { p.moveTo(m, +a[0], +a[1]); },
    lineTo: function (p, m, a) { p.lineTo(m, +a[0], +a[1]); },
    bezierCurveTo: function (p, m, a) { p.curve(m, +a[0], +a[1], +a[2], +a[3], +a[4], +a[5]); },
    quadraticCurveTo: function (p, m, a) { p.quad(m, +a[0], +a[1], +a[2], +a[3]); },
    closePath: function (p) { p.close(); },
    rect: function (p, m, a) { p.rect(m, +a[0], +a[1], +a[2], +a[3]); },
    roundRect: function (p, m, a) { p.roundRect(m, +a[0], +a[1], +a[2], +a[3], a[4]); },
    arc: function (p, m, a) { p.ellipse(m, +a[0], +a[1], +a[2], +a[2], 0, +a[3], +a[4], !!a[5]); },
    ellipse: function (p, m, a) { p.ellipse(m, +a[0], +a[1], +a[2], +a[3], +a[4], +a[5], +a[6], !!a[7]); },
    arcTo: function (p, m, a) { p.arcTo(m, +a[0], +a[1], +a[2], +a[3], +a[4]); }
  };
  class Path2D {
    constructor(from) {
      this._ops = [];
      if (from instanceof Path2D) this._ops = from._ops.slice();
      else if (typeof from === 'string') this._ops.push(['svg', from]);
    }
    addPath(p) { if (p instanceof Path2D) this._ops = this._ops.concat(p._ops); }
  }
  Object.keys(PATH_OPS).forEach(function (k) { Path2D.prototype[k] = function () { this._ops.push([k, Array.prototype.slice.call(arguments)]); }; });
  var CANVAS_STATE = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0,
    globalAlpha: 1, globalCompositeOperation: 'source-over', font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', direction: 'inherit',
    letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto', fontStretch: 'normal', fontVariantCaps: 'normal', textRendering: 'auto',
    shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true, imageSmoothingQuality: 'low', filter: 'none' };
  class CanvasRenderingContext2D {
    constructor(canvas) { this.canvas = canvas; this.reset(); }
    reset() {
      this._s = {};
      for (var k in CANVAS_STATE) this._s[k] = CANVAS_STATE[k];
      this._s.dash = [];
      this._s.m = [1, 0, 0, 1, 0, 0];
      this._s.fontParsed = canvasFont(CANVAS_STATE.font);
      this._stack = [];
      this._path = new CanvasPath();
      this._items = [];
      if (this._px || this._wrf) { this._px = null; this._pixelMode(); }
      this._drawn();
    }
    _drawn() { this._v = (this._v || 0) + 1; changed(); }
    getContextAttributes() { return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: !!this._wrf }; }
    save() { var c = {}; for (var k in this._s) c[k] = this._s[k]; c.m = this._s.m.slice(); c.dash = this._s.dash.slice(); this._stack.push(c); }
    restore() {
      if (!this._stack.length) return;
      if (this._px && this._stack[this._stack.length - 1].clip !== this._s.clip) this._flush();
      this._s = this._stack.pop();
    }
    isContextLost() { return false; }
    // transforms
    transform(a, b, c, d, e, f) {
      var m = this._s.m;
      if (![a, b, c, d, e, f].every(isFinite)) return;
      this._s.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
    }
    setTransform(a, b, c, d, e, f) {
      if (a && typeof a === 'object') { var o = a; this._s.m = [o.a !== undefined ? o.a : 1, o.b || 0, o.c || 0, o.d !== undefined ? o.d : 1, o.e || 0, o.f || 0]; return; }
      if (a === undefined) { this._s.m = [1, 0, 0, 1, 0, 0]; return; }
      if (![a, b, c, d, e, f].every(isFinite)) return;
      this._s.m = [+a, +b, +c, +d, +e, +f];
    }
    resetTransform() { this._s.m = [1, 0, 0, 1, 0, 0]; }
    getTransform() { return matrixOf(this._s.m); }
    translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
    scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
    rotate(a) { var c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
    // paint and line styles
    get fillStyle() { return this._s.fillStyle; }
    set fillStyle(v) { this._s.fillStyle = this._style(v, this._s.fillStyle); }
    get strokeStyle() { return this._s.strokeStyle; }
    set strokeStyle(v) { this._s.strokeStyle = this._style(v, this._s.strokeStyle); }
    _style(v, old) {
      if (v instanceof CanvasGradient || v instanceof CanvasPattern) return v;
      var c = colorRGBA(v);
      if (!c) return old;
      return c[3] === 1 ? rgbHex(c)[0] : 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + c[3] + ')';
    }
    get font() { return this._s.font; }
    set font(v) { var f = canvasFont(v); if (f) { this._s.font = f.text; this._s.fontParsed = f; } }
    setLineDash(a) { if (!Array.isArray(a) || !a.every(function (x) { return isFinite(x) && x >= 0; })) return; this._s.dash = a.length % 2 ? a.concat(a) : a.slice(); }
    getLineDash() { return this._s.dash.slice(); }
    createLinearGradient(x0, y0, x1, y1) { return new CanvasGradient('linear', [+x0, +y0, +x1, +y1]); }
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      if (r0 < 0 || r1 < 0) throw new DOMException('The radius provided is negative.', 'IndexSizeError');
      return new CanvasGradient('radial', [+x0, +y0, +r0, +x1, +y1, +r1]);
    }
    createConicGradient() { return new CanvasGradient(); }
    createPattern(img, rep) {
      this._pixelMode();
      var src = canvasSource(img);
      var p = new CanvasPattern(src, rep);
      if (src && src.px === img._px) p._src = { px: src.px.slice(), w: src.w, h: src.h };
      return p;
    }
    // paths
    beginPath() { this._path = new CanvasPath(); }
    _pathOf(p) {
      if (!(p instanceof Path2D)) return this._path;
      var out = new CanvasPath(), m = this._s.m;
      for (var i = 0; i < p._ops.length; i++) {
        var op = p._ops[i];
        if (op[0] === 'svg') { svgPathInto(out, m, op[1]); continue; }
        PATH_OPS[op[0]](out, m, op[1]);
      }
      return out;
    }
    fill(a, b) {
      var p = this._pathOf(a), rule = typeof a === 'string' ? a : b;
      if (this._px) { if (p.d.length) this._rdraw(p.d.join(''), this._s.fillStyle, [10, rule === 'evenodd' ? 1 : 0]); return; }
      var paint = canvasPaint(this._s.fillStyle);
      if (!p.d.length || !paint) return;
      this._items.push({ d: p.d.join(''), fill: paint[0], alpha: paint[1] * this._s.globalAlpha, rule: rule === 'evenodd' ? 'evenodd' : '' });
      this._drawn();
    }
    stroke(a) {
      var p = this._pathOf(a), s = this._s, k = Math.sqrt(Math.abs(s.m[0] * s.m[3] - s.m[1] * s.m[2]));
      if (this._px) {
        if (!p.d.length || !(s.lineWidth > 0)) return;
        var tail = [12, s.dash.length, s.lineDashOffset * k].concat(s.dash.map(function (x) { return x * k; }));
        tail.push(11, s.lineWidth * k, s.lineCap === 'round' ? 1 : s.lineCap === 'square' ? 2 : 0, s.lineJoin === 'round' ? 1 : s.lineJoin === 'bevel' ? 2 : 0, s.miterLimit);
        this._rdraw(p.d.join(''), s.strokeStyle, tail);
        return;
      }
      var paint = canvasPaint(s.strokeStyle);
      if (!p.d.length || !paint || !(s.lineWidth > 0)) return;
      this._items.push({ d: p.d.join(''), stroke: paint[0], alpha: paint[1] * s.globalAlpha, width: s.lineWidth * k,
        dash: s.dash.length ? s.dash.map(function (x) { return fmtNum(x * k); }).join(' ') : '', dashOffset: s.lineDashOffset * k });
      this._drawn();
    }
    clip(a, b) {
      if (!this._px) return;
      var p = this._pathOf(a), rule = typeof a === 'string' ? a : b, W = this._pw, H = this._ph;
      this._flush();
      // a rectangle (a chart's plot area) narrows the clip rectangle, no
      // mask; any other path makes a mask of the clip so far
      var d = p.d.join(''), cur = this._s.clip || { m: null, r: null }, r = pathRect(d);
      if (r && !cur.m) {
        if (cur.r) r = [Math.max(r[0], cur.r[0]), Math.max(r[1], cur.r[1]), Math.min(r[2], cur.r[2]), Math.min(r[3], cur.r[3])];
        this._s.clip = { m: null, r: r };
        return;
      }
      var q = [], c = new Float64Array(W * H);
      rasterPath(q, d);
      __cerRaster(1, c, W, H, new Float64Array(q), rule === 'evenodd' ? 1 : 0, cur.m || undefined, cur.r || undefined);
      this._s.clip = { m: c, r: null };
    }
    isPointInPath() { return false; }
    isPointInStroke() { return false; }
    fillRect(x, y, w, h) { var p = new CanvasPath(); p.rect(this._s.m, x, y, w, h); var keep = this._path; this._path = p; this.fill(); this._path = keep; }
    strokeRect(x, y, w, h) { var p = new CanvasPath(); p.rect(this._s.m, x, y, w, h); var keep = this._path; this._path = p; this.stroke(); this._path = keep; }
    clearRect(x, y, w, h) {
      // what is under a cleared rectangle that covers the canvas goes;
      // a smaller one cannot cut the shapes and keeps them
      var m = this._s.m, W = this.canvas.width, H = this.canvas.height;
      if (this._px) {
        var r = new CanvasPath(); r.rect(m, x, y, w, h);
        var q = this._q; rasterPath(q, r.d.join('')); q.push(13, 6, 20, 0, 0, 0, 1, 10, 0);
        if (!m[1] && !m[2] && Math.min(m[0] * x, m[0] * (x + w)) + m[4] <= 0 && Math.min(m[3] * y, m[3] * (y + h)) + m[5] <= 0 &&
          Math.max(m[0] * x, m[0] * (x + w)) + m[4] >= W && Math.max(m[3] * y, m[3] * (y + h)) + m[5] >= H) this._items = [];
        this._drawn();
        return;
      }
      if (m[1] || m[2]) return;
      var x0 = Math.min(m[0] * x + m[4], m[0] * (x + w) + m[4]), x1 = Math.max(m[0] * x + m[4], m[0] * (x + w) + m[4]);
      var y0 = Math.min(m[3] * y + m[5], m[3] * (y + h) + m[5]), y1 = Math.max(m[3] * y + m[5], m[3] * (y + h) + m[5]);
      if (x0 <= 0 && y0 <= 0 && x1 >= W && y1 >= H && this._items.length) { this._items = []; this._drawn(); }
    }
    // text
    measureText(t) { var f = this._s.fontParsed; return new TextMetrics(canvasTextWidth(String(t), f), f.size, this._s.textAlign); }
    _text(t, x, y, maxWidth, paintOf) {
      var s = this._s, f = s.fontParsed, paint = canvasPaint(paintOf);
      t = String(t).replace(/[\t\n\f\r]/g, ' ');
      if (!paint || !t || !isFinite(x) || !isFinite(y)) return;
      var w = canvasTextWidth(t, f), size = f.size;
      if (maxWidth !== undefined && maxWidth < w) { if (!(maxWidth > 0)) return; size = size * maxWidth / w; w = maxWidth; }
      var al = s.textAlign, rtl = s.direction === 'rtl';
      var left = al === 'center' ? x - w / 2 : al === 'right' || al === 'end' && !rtl || al === 'start' && rtl ? x - w : x;
      // the alphabetic baseline under y, from the em box
      var bl = s.textBaseline, base = bl === 'top' ? y + size * 0.81 : bl === 'hanging' ? y + size * 0.65 : bl === 'middle' ? y + size * 0.31 : bl === 'bottom' || bl === 'ideographic' ? y - size * 0.19 : y;
      var m = s.m, k = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
      var px = m[0] * left + m[2] * base + m[4], py = m[1] * left + m[3] * base + m[5];
      if (m[1] || m[2]) {
        // turned text: drawn level, centred where its middle would be
        var mx = left + w / 2, my = base - size * 0.31;
        var cx = m[0] * mx + m[2] * my + m[4], cy = m[1] * mx + m[3] * my + m[5];
        px = cx - w * k / 2; py = cy + size * k * 0.31;
      }
      this._items.push({ text: t, x: px, y: py, size: size * k, family: f.family, weight: f.weight, style: f.style, color: paint[0], alpha: paint[1] * s.globalAlpha });
      this._drawn();
    }
    fillText(t, x, y, maxWidth) { this._text(t, x, y, maxWidth, this._s.fillStyle); }
    strokeText(t, x, y, maxWidth) { this._text(t, x, y, maxWidth, this._s.strokeStyle); }
    // ---- pixels (see the note above)
    // turns the canvas into a bitmap, its shapes so far drawn in; false
    // without the rasterizer
    _pixelMode() {
      if (this._px) return true;
      if (typeof __cerRaster !== 'function') return false;
      var W = this.canvas.width, H = this.canvas.height;
      this._pw = W; this._ph = H;
      this._px = new Float64Array(W * H * 4); this._q = []; this._qi = [];
      var kept = [], q = this._q;
      for (var i = 0; i < this._items.length; i++) {
        var it = this._items[i], hex = it.fill || it.stroke;
        if (it.text !== undefined) { kept.push(it); continue; }
        rasterPath(q, it.d);
        q.push(13, 0, 20, parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, it.alpha);
        if (it.fill) q.push(10, it.rule ? 1 : 0);
        else {
          var dash = it.dash ? it.dash.split(' ').map(Number) : [];
          q.push(12, dash.length, it.dash ? it.dashOffset : 0);
          for (var j = 0; j < dash.length; j++) q.push(dash[j]);
          q.push(11, it.width, 0, 0, 10);
        }
      }
      this._items = kept;
      return true;
    }
    // one fill or stroke queued: the path, the composition, the paint and
    // what draws it (tail)
    _rdraw(d, style, tail) {
      var q = this._q, at = q.length, s = this._s;
      rasterPath(q, d);
      q.push(13, COMPOSITE_OPS[s.globalCompositeOperation] || 0);
      if (!this._rpaint(style)) { q.length = at; return; }
      for (var i = 0; i < tail.length; i++) q.push(tail[i]);
      this._drawn();
    }
    _rpaint(p) {
      var q = this._q, s = this._s, ga = s.globalAlpha, inv;
      if (typeof p === 'string') {
        var c = colorRGBA(p);
        if (!c) return false;
        q.push(20, c[0] / 255, c[1] / 255, c[2] / 255, c[3] * ga);
        return true;
      }
      if (p instanceof CanvasGradient) {
        if (!p._stops.length) return false;
        inv = invert(s.m);
        if (!p._kind || !inv) { var avg = canvasPaint(p); return this._rpaint('rgba(' + colorRGBA(avg[0]).slice(0, 3).join(',') + ',' + avg[1] + ')'); }
        var stops = p._stops.slice().sort(function (a, b) { return a[0] - b[0]; });
        q.push(p._kind === 'linear' ? 21 : 22, ga);
        q.push.apply(q, inv); q.push.apply(q, p._geo);
        q.push(stops.length);
        for (var i = 0; i < stops.length; i++) { var t = stops[i]; q.push(t[0], t[1][0] / 255, t[1][1] / 255, t[1][2] / 255, t[1][3]); }
        return true;
      }
      if (p instanceof CanvasPattern) {
        inv = invert(mul(s.m, p._m));
        if (!p._src || !inv) return false;
        var k = this._qi.push([p._src.px, p._src.w, p._src.h]) - 1;
        q.push(23, ga, k); q.push.apply(q, inv);
        q.push(p._rx ? 1 : 0, p._ry ? 1 : 0, s.imageSmoothingEnabled ? 1 : 0);
        return true;
      }
      return false;
    }
    // the queue drawn into the pixels
    _flush() {
      if (!this._px || !this._q.length) return;
      var q = this._q, imgs = this._qi;
      this._q = []; this._qi = [];
      var clip = this._s.clip;
      __cerRaster(0, this._px, this._pw, this._ph, new Float64Array(q), clip ? clip.m || undefined : undefined, imgs, clip ? clip.r || undefined : undefined);
    }
    // the pixels as a PNG data: URL, made again only after a change
    _png() {
      this._flush();
      if (this._pngV !== this._v) { this._pngU = __cerRaster(4, this._px, this._pw, this._ph); this._pngV = this._v; }
      return this._pngU;
    }
    drawImage(img) {
      var a = Array.prototype.slice.call(arguments, 1).map(Number);
      if (!this._pixelMode()) return;
      var src = canvasSource(img);
      if (!src) return;
      var sx = 0, sy = 0, sw = src.w, sh = src.h, dx, dy, dw = src.w, dh = src.h;
      if (a.length >= 8) { sx = a[0]; sy = a[1]; sw = a[2]; sh = a[3]; dx = a[4]; dy = a[5]; dw = a[6]; dh = a[7]; }
      else { dx = a[0]; dy = a[1]; if (a.length >= 4) { dw = a[2]; dh = a[3]; } }
      if (!sw || !sh || !dw || !dh || ![sx, sy, sw, sh, dx, dy, dw, dh].every(isFinite)) return;
      var s = this._s, inv = invert(mul(s.m, [dw / sw, 0, 0, dh / sh, dx - sx * dw / sw, dy - sy * dh / sh]));
      if (!inv) return;
      var r = new CanvasPath(); r.rect(s.m, dx, dy, dw, dh);
      var q = this._q, k = this._qi.push([src.px === img._px ? src.px.slice() : src.px, src.w, src.h]) - 1;
      rasterPath(q, r.d.join(''));
      q.push(13, COMPOSITE_OPS[s.globalCompositeOperation] || 0, 23, s.globalAlpha, k);
      q.push.apply(q, inv);
      q.push(0, 0, s.imageSmoothingEnabled ? 1 : 0, 10, 0);
      this._drawn();
    }
    createImageData(w, h) { return typeof w === 'object' ? new ImageData(w.width, w.height) : new ImageData(Math.abs(w), Math.abs(h)); }
    getImageData(x, y, w, h) {
      if (!w || !h) throw new DOMException('The source width is 0.', 'IndexSizeError');
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      x = Math.floor(x); y = Math.floor(y); w = Math.ceil(w); h = Math.ceil(h);
      var out = new ImageData(w, h);
      if (!this._pixelMode()) return out;
      this._flush();
      __cerRaster(2, this._px, this._pw, this._ph, x, y, w, h, out.data);
      return out;
    }
    putImageData(img, dx, dy, ox, oy, ow, oh) {
      if (!(img instanceof ImageData) || !this._pixelMode()) return;
      dx = Math.floor(dx); dy = Math.floor(dy);
      var data = img.data, iw = img.width, ih = img.height;
      if (ow !== undefined) {
        // the dirty rectangle: that part of the image only
        if (ow < 0) { ox += ow; ow = -ow; }
        if (oh < 0) { oy += oh; oh = -oh; }
        var x0 = Math.max(0, Math.floor(ox)), y0 = Math.max(0, Math.floor(oy)), x1 = Math.min(iw, Math.floor(ox + ow)), y1 = Math.min(ih, Math.floor(oy + oh));
        if (x1 <= x0 || y1 <= y0) return;
        var part = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
        for (var y = y0; y < y1; y++) part.set(data.subarray((y * iw + x0) * 4, (y * iw + x1) * 4), (y - y0) * (x1 - x0) * 4);
        data = part; dx += x0; dy += y0; iw = x1 - x0; ih = y1 - y0;
      }
      this._flush();
      __cerRaster(3, this._px, this._pw, this._ph, dx, dy, iw, ih, data);
      this._drawn();
    }
    drawFocusIfNeeded() {}
    scrollPathIntoView() {}
  }
  Object.keys(PATH_OPS).forEach(function (k) { CanvasRenderingContext2D.prototype[k] = function () { PATH_OPS[k](this._path, this._s.m, arguments); }; });
  Object.keys(CANVAS_STATE).forEach(function (k) {
    if (Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, k)) return;
    Object.defineProperty(CanvasRenderingContext2D.prototype, k, {
      get: function () { return this._s[k]; },
      set: function (v) {
        var d = CANVAS_STATE[k];
        if (typeof d === 'number') { v = +v; if (!isFinite(v) || (k === 'lineWidth' || k === 'miterLimit') && v <= 0 || k === 'globalAlpha' && (v < 0 || v > 1)) return; }
        else if (typeof d === 'boolean') v = !!v;
        else v = String(v);
        this._s[k] = v;
      },
      configurable: true, enumerable: true
    });
  });
  // a canvas of its own, not on the page (drawn into, never shown)
  class OffscreenCanvas extends EventTarget {
    constructor(w, h) { super(); this._w = w >>> 0; this._h = h >>> 0; this._ctx = null; }
    get width() { return this._w; }
    set width(v) { this._w = v >>> 0; if (this._ctx) this._ctx.reset(); }
    get height() { return this._h; }
    set height(v) { this._h = v >>> 0; if (this._ctx) this._ctx.reset(); }
    getContext(type, opts) { return canvasContext(this, type, opts); }
    convertToBlob() { return Promise.resolve(new Blob([], { type: 'image/png' })); }
    transferToImageBitmap() {
      var src = canvasSource(this), bm = { width: this._w, height: this._h, close: function () {} };
      if (src) { bm._px = src.px; if (this._ctx) this._ctx.reset(); }
      return bm;
    }
  }
  // a drawn canvas in the render tree: the shapes as one SVG picture, the
  // text as spans over it, in the box the canvas has on the page (its
  // pixels stretched to the CSS size, as a browser shows them)
  function canvasRender(n, o, cs) {
    var ctx = n._ctx, W = n.width, H = n.height;
    if (!ctx || !W || !H || !ctx._px && !ctx._items.length) return;
    var cw = /^[\d.]+px$/.test(cs.width || '') ? parseFloat(cs.width) : W, ch = /^[\d.]+px$/.test(cs.height || '') ? parseFloat(cs.height) : H;
    var kx = cw / W, ky = ch / H;
    var svg = '<svg xmlns="' + SVG_NS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">', texts = [];
    for (var i = 0; i < ctx._items.length; i++) {
      var it = ctx._items[i];
      if (it.text !== undefined) { texts.push(it); continue; }
      if (it.fill) svg += '<path d="' + it.d + '" fill="' + it.fill + '"' + (it.alpha < 1 ? ' fill-opacity="' + fmtNum(it.alpha) + '"' : '') + (it.rule ? ' fill-rule="evenodd"' : '') + ' stroke="none"/>';
      else svg += '<path d="' + it.d + '" fill="none" stroke="' + it.stroke + '" stroke-width="' + fmtNum(it.width) + '"' + (it.alpha < 1 ? ' stroke-opacity="' + fmtNum(it.alpha) + '"' : '') +
        (it.dash ? ' stroke-dasharray="' + it.dash + '"' + (it.dashOffset ? ' stroke-dashoffset="' + fmtNum(it.dashOffset) + '"' : '') : '') + '/>';
    }
    svg += '</svg>';
    var box = { display: 'block', position: 'absolute', left: '0px', top: '0px', width: fmtNum(cw) + 'px', height: fmtNum(ch) + 'px' };
    var kids = [ctx._px ? { i: n.__id + 'c0', t: 'img', s: box, a: {}, png: ctx._png() } : { i: n.__id + 'c0', t: 'svg:svg', s: box, a: { viewBox: '0 0 ' + W + ' ' + H }, svg: svg }];
    for (var j = 0; j < texts.length; j++) {
      var t = texts[j], size = t.size * ky;
      var s = { display: 'block', position: 'absolute', left: fmtNum(t.x * kx) + 'px', top: fmtNum(t.y * ky - size * 0.89) + 'px', 'font-size': fmtNum(size) + 'px',
        'line-height': fmtNum(size) + 'px', 'font-family': t.family, color: t.alpha < 1 ? 'rgba(' + parseInt(t.color.slice(1, 3), 16) + ', ' + parseInt(t.color.slice(3, 5), 16) + ', ' + parseInt(t.color.slice(5, 7), 16) + ', ' + fmtNum(t.alpha) + ')' : normalizeColor(t.color),
        'white-space': 'pre' };
      if (t.weight !== '400') s['font-weight'] = t.weight;
      if (t.style !== 'normal') s['font-style'] = t.style;
      kids.push({ i: n.__id + 'c' + (j + 1), t: 'span', s: s, c: [{ i: n.__id + 'c' + (j + 1) + 't', x: t.text }] });
    }
    if (!o.s.position || o.s.position === 'static') o.s.position = 'relative';
    o.s.overflow = 'hidden';
    o.c = kids;
  }
  class HTMLMediaElement extends HTMLElement {
    play() { return Promise.resolve(); }
    pause() {}
    load() {}
    canPlayType() { return ''; }
  }
  class HTMLVideoElement extends HTMLMediaElement {}
  class HTMLAudioElement extends HTMLMediaElement {}
  class HTMLSourceElement extends HTMLElement {}
  class HTMLTemplateElement extends HTMLElement {
    constructor(q) { super(q); this._content = null; }
    get content() { return this._content || (this._content = (this.ownerDocument || doc).createDocumentFragment()); }
    get innerHTML() { return serializeChildren(this.content); }
    set innerHTML(v) { removeAll(this.content); this.content.appendChild(parseFragment(String(v), null)); }
  }
  class HTMLSlotElement extends HTMLElement { assignedNodes() { return []; } assignedElements() { return []; } }
  class HTMLDialogElement extends HTMLElement {
    show() { this.open = true; }
    showModal() { this.open = true; }
    close(rv) { if (!this.open) return; this.open = false; this.returnValue = rv === undefined ? this.returnValue : String(rv); dispatch(this, new Event('close')); }
  }
  reflectBool(HTMLDialogElement, ['open']);
  class HTMLDetailsElement extends HTMLElement {}
  reflectBool(HTMLDetailsElement, ['open']);
  class HTMLLabelElement extends HTMLElement {
    get htmlFor() { return this.getAttribute('for') || ''; }
    set htmlFor(v) { this.setAttribute('for', v); }
    get control() {
      var f = this.getAttribute('for');
      if (f) return (this.ownerDocument || doc).getElementById(f);
      return this.querySelector('input,select,textarea,button');
    }
    get form() { return formOf(this); }
  }
  class HTMLFieldSetElement extends HTMLElement {}
  reflectBool(HTMLFieldSetElement, ['disabled']);
  class HTMLLegendElement extends HTMLElement {}
  class HTMLFormElement extends HTMLElement {
    get elements() { return this.querySelectorAll('input,select,textarea,button,fieldset,output,object'); }
    get length() { return this.elements.length; }
    submit() {}
    requestSubmit() {
      var ev = new Event('submit', { bubbles: true, cancelable: true });
      dispatch(this, ev);
    }
    reset() {
      this.elements.forEach(function (e) {
        if (e._value !== undefined) e._value = undefined;
        if (e._checked !== undefined) e._checked = undefined;
      });
      dispatch(this, new Event('reset', { bubbles: true, cancelable: true }));
    }
    checkValidity() { return true; }
    reportValidity() { return true; }
  }
  reflect(HTMLFormElement, ['name', 'method', 'target', 'enctype', 'autocomplete']);
  urlProp(HTMLFormElement, ['action']);
  reflectBool(HTMLFormElement, ['noValidate']);

  function formOf(el) {
    var f = el.getAttribute('form');
    if (f) return (el.ownerDocument || doc).getElementById(f);
    for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'form') return n;
    return null;
  }

  var validity = { valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: false };

  class HTMLButtonElement extends HTMLElement {
    get type() { var t = (this.getAttribute('type') || '').toLowerCase(); return t === 'reset' || t === 'button' ? t : 'submit'; }
    set type(v) { this.setAttribute('type', v); }
    get form() { return formOf(this); }
    get labels() { return labelsOf(this); }
    get validity() { return validity; }
    checkValidity() { return true; }
    setCustomValidity() {}
  }
  reflect(HTMLButtonElement, ['name', 'value']);
  reflectBool(HTMLButtonElement, ['disabled', 'autofocus']);

  function labelsOf(el) {
    var out = [];
    var id = el.id;
    if (doc) eachElement(doc, function (l) { if (l.localName === 'label' && ((id && l.getAttribute('for') === id) || (!l.getAttribute('for') && l.contains(el)))) out.push(l); });
    return NodeList(out);
  }

  // a form control's value: its own (_value) once set, else the attribute
  class HTMLInputElement extends HTMLElement {
    constructor(q) { super(q); this._value = undefined; this._checked = undefined; this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; this.indeterminate = false; this.files = null; }
    get type() {
      var t = (this.getAttribute('type') || 'text').toLowerCase();
      return /^(hidden|text|search|tel|url|email|password|date|month|week|time|datetime-local|number|range|color|checkbox|radio|file|submit|image|reset|button)$/.test(t) ? t : 'text';
    }
    set type(v) { this.setAttribute('type', v); }
    get value() {
      var t = this.type;
      if (t === 'checkbox' || t === 'radio') { var a = this.getAttribute('value'); return a === null ? 'on' : a; }
      if (this._value !== undefined) return this._value;
      return this.getAttribute('value') || '';
    }
    set value(v) {
      v = v === null || v === undefined ? '' : String(v);
      var t = this.type;
      if (t === 'checkbox' || t === 'radio') { this.setAttribute('value', v); return; }
      if (t !== 'file') v = v.replace(/[\r\n]/g, '');
      this._value = v;
      this.selectionStart = this.selectionEnd = v.length;
      changed();
    }
    get defaultValue() { return this.getAttribute('value') || ''; }
    set defaultValue(v) { this.setAttribute('value', v); }
    get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
    set checked(v) {
      this._checked = !!v;
      if (v && this.type === 'radio') uncheckGroup(this);
      changed();
    }
    get defaultChecked() { return this.hasAttribute('checked'); }
    set defaultChecked(v) { this.toggleAttribute('checked', !!v); }
    get valueAsNumber() { var n = parseFloat(this.value); return isNaN(n) ? NaN : n; }
    set valueAsNumber(n) { this.value = String(n); }
    get form() { return formOf(this); }
    get labels() { return labelsOf(this); }
    get validity() { return validity; }
    get validationMessage() { return ''; }
    get willValidate() { return true; }
    get list() { var l = this.getAttribute('list'); return l ? (this.ownerDocument || doc).getElementById(l) : null; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; dispatch(this, new Event('select', { bubbles: true })); }
    setSelectionRange(s, e, d) { var l = this.value.length; this.selectionStart = Math.min(s, l); this.selectionEnd = Math.min(e === undefined ? s : e, l); this.selectionDirection = d || 'none'; }
    setRangeText(t, s, e) {
      var v = this.value;
      if (s === undefined) { s = this.selectionStart; e = this.selectionEnd; }
      this._value = v.slice(0, s) + t + v.slice(e);
      this.selectionStart = this.selectionEnd = s + t.length;
    }
    checkValidity() { return true; }
    reportValidity() { return true; }
    setCustomValidity() {}
    showPicker() {}
    stepUp() {}
    stepDown() {}
  }
  reflect(HTMLInputElement, ['name', 'placeholder', 'accept', 'alt', 'autocomplete', 'dirName', 'inputMode', 'max', 'min', 'pattern', 'step', 'enterKeyHint']);
  reflectBool(HTMLInputElement, ['disabled', 'readOnly', 'required', 'multiple', 'autofocus']);
  ['maxLength', 'minLength', 'size'].forEach(function (p) {
    var a = p.toLowerCase();
    Object.defineProperty(HTMLInputElement.prototype, p, { get: function () { var v = this.getAttribute(a); return v === null ? (p === 'size' ? 20 : -1) : parseInt(v, 10); }, set: function (v) { this.setAttribute(a, v); }, configurable: true });
  });

  function uncheckGroup(el) {
    var name = el.getAttribute('name');
    if (!name) return;
    var root = formOf(el) || el.getRootNode();
    eachElement(root, function (o) {
      if (o !== el && o.localName === 'input' && o.type === 'radio' && o.getAttribute('name') === name) o._checked = false;
    });
  }

  class HTMLTextAreaElement extends HTMLElement {
    constructor(q) { super(q); this._value = undefined; this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; }
    get type() { return 'textarea'; }
    get value() { return this._value !== undefined ? this._value : this.textContent; }
    set value(v) { v = v === null || v === undefined ? '' : String(v); this._value = v; this.selectionStart = this.selectionEnd = v.length; changed(); }
    get defaultValue() { return this.textContent; }
    set defaultValue(v) { this.textContent = v; }
    get textLength() { return this.value.length; }
    get form() { return formOf(this); }
    get labels() { return labelsOf(this); }
    get validity() { return validity; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setSelectionRange(s, e, d) { var l = this.value.length; this.selectionStart = Math.min(s, l); this.selectionEnd = Math.min(e === undefined ? s : e, l); this.selectionDirection = d || 'none'; }
    setRangeText(t, s, e) {
      var v = this.value;
      if (s === undefined) { s = this.selectionStart; e = this.selectionEnd; }
      this._value = v.slice(0, s) + t + v.slice(e);
      this.selectionStart = this.selectionEnd = s + t.length;
    }
    checkValidity() { return true; }
    reportValidity() { return true; }
    setCustomValidity() {}
  }
  reflect(HTMLTextAreaElement, ['name', 'placeholder', 'wrap', 'autocomplete', 'dirName', 'inputMode', 'enterKeyHint']);
  reflectBool(HTMLTextAreaElement, ['disabled', 'readOnly', 'required', 'autofocus']);
  ['rows', 'cols', 'maxLength', 'minLength'].forEach(function (p) {
    var a = p.toLowerCase();
    var dflt = p === 'rows' ? 2 : p === 'cols' ? 20 : -1;
    Object.defineProperty(HTMLTextAreaElement.prototype, p, { get: function () { var v = this.getAttribute(a); return v === null ? dflt : parseInt(v, 10); }, set: function (v) { this.setAttribute(a, v); }, configurable: true });
  });

  class HTMLOptionElement extends HTMLElement {
    constructor(q) { super(q); this._selected = undefined; }
    get value() { var v = this.getAttribute('value'); return v === null ? this.text : v; }
    set value(v) { this.setAttribute('value', v); }
    get text() { return this.textContent.replace(/\s+/g, ' ').trim(); }
    set text(v) { this.textContent = v; }
    get label() { return this.getAttribute('label') || this.text; }
    get selected() {
      if (this._selected !== undefined) return this._selected;
      if (this.hasAttribute('selected')) return true;
      var s = selectOf(this);
      if (s && !s.multiple) { var opts = s.options; for (var i = 0; i < opts.length; i++) if (opts[i]._selected || opts[i].hasAttribute('selected')) return false; return opts[0] === this; }
      return false;
    }
    set selected(v) {
      var s = selectOf(this);
      if (v && s && !s.multiple) s.options.forEach(function (o) { o._selected = false; });
      this._selected = !!v;
      changed();
    }
    get defaultSelected() { return this.hasAttribute('selected'); }
    set defaultSelected(v) { this.toggleAttribute('selected', !!v); }
    get index() { var s = selectOf(this); return s ? s.options.indexOf(this) : 0; }
    get form() { var s = selectOf(this); return s ? s.form : null; }
  }
  reflectBool(HTMLOptionElement, ['disabled']);
  function selectOf(o) { for (var n = o.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'select') return n; return null; }
  class HTMLOptGroupElement extends HTMLElement {}
  reflectBool(HTMLOptGroupElement, ['disabled']);
  class HTMLSelectElement extends HTMLElement {
    get type() { return this.multiple ? 'select-multiple' : 'select-one'; }
    get options() { var out = []; eachElement(this, function (e) { if (e.localName === 'option') out.push(e); }); out = NodeList(out); var self = this; out.add = function (o, b) { self.add(o, b); }; out.remove = function (i) { self.remove(i); }; Object.defineProperty(out, 'selectedIndex', { get: function () { return self.selectedIndex; } }); return out; }
    get length() { return this.options.length; }
    get selectedOptions() { return NodeList(this.options.filter(function (o) { return o.selected; })); }
    get selectedIndex() { var o = this.options; for (var i = 0; i < o.length; i++) if (o[i].selected) return i; return -1; }
    set selectedIndex(i) { var o = this.options; for (var k = 0; k < o.length; k++) o[k]._selected = k === i; changed(); }
    get value() { var i = this.selectedIndex; return i < 0 ? '' : this.options[i].value; }
    set value(v) { var o = this.options, hit = false; for (var k = 0; k < o.length; k++) { var on = !hit && o[k].value === String(v); o[k]._selected = on; if (on) hit = true; } changed(); }
    get form() { return formOf(this); }
    get labels() { return labelsOf(this); }
    get validity() { return validity; }
    item(i) { return this.options[i] || null; }
    namedItem(n) { return this.options.find(function (o) { return o.id === n || o.getAttribute('name') === n; }) || null; }
    add(o, before) { this.insertBefore(o, typeof before === 'number' ? this.options[before] || null : before || null); }
    remove(i) { if (i === undefined) { Element.prototype.remove.call(this); return; } var o = this.options[i]; if (o) o.remove(); }
    checkValidity() { return true; }
    reportValidity() { return true; }
    setCustomValidity() {}
  }
  reflect(HTMLSelectElement, ['name', 'autocomplete']);
  reflectBool(HTMLSelectElement, ['disabled', 'required', 'multiple', 'autofocus']);
  Object.defineProperty(HTMLSelectElement.prototype, 'size', { get: function () { return parseInt(this.getAttribute('size') || '0', 10); }, set: function (v) { this.setAttribute('size', v); }, configurable: true });

  class HTMLOutputElement extends HTMLElement { get value() { return this.textContent; } set value(v) { this.textContent = v; } }
  class HTMLProgressElement extends HTMLElement {
    get value() { return parseFloat(this.getAttribute('value') || '0'); }
    set value(v) { this.setAttribute('value', v); }
    get max() { return parseFloat(this.getAttribute('max') || '1'); }
    set max(v) { this.setAttribute('max', v); }
  }
  class HTMLMeterElement extends HTMLProgressElement {}
  class HTMLUnknownElement extends HTMLElement {}
  class HTMLDataElement extends HTMLElement {}
  reflect(HTMLDataElement, ['value']);
  class HTMLTimeElement extends HTMLElement {}
  reflect(HTMLTimeElement, ['dateTime']);
  class HTMLModElement extends HTMLElement {}
  class HTMLPictureElement extends HTMLElement {}
  class HTMLMapElement extends HTMLElement {}
  class HTMLAreaElement extends HTMLElement {}
  class HTMLEmbedElement extends HTMLElement {}
  class HTMLObjectElement extends HTMLElement {}
  class HTMLMenuElement extends HTMLElement {}

  class SVGElement extends Element {
    constructor(q) { super(q, SVG_NS); this.dataset = datasetOf(this); }
    get className() { var el = this; return { get baseVal() { return el.getAttribute('class') || ''; }, set baseVal(v) { el.setAttribute('class', v); }, get animVal() { return el.getAttribute('class') || ''; }, toString: function () { return el.getAttribute('class') || ''; } }; }
    set className(v) { this.setAttribute('class', v); }
    get ownerSVGElement() { for (var n = this.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'svg') return n; return null; }
    get viewportElement() { return this.ownerSVGElement; }
    get tabIndex() { var t = this.getAttribute('tabindex'); return t === null ? -1 : parseInt(t, 10); }
    set tabIndex(v) { this.setAttribute('tabindex', v); }
    focus(opts) { focusElement(this, opts); }
    blur() { if (doc && doc._active === this) focusElement(null); }
    getBBox() {
      if (this.localName === 'text') {
        // its run's extent (svgTextRuns measures it as it is drawn)
        var cs = computedOf(this), size = parseFloat(cs['font-size']) || 16, txt = this.textContent;
        var w = canvasTextWidth(txt, { size: size, weight: cs['font-weight'] || '400' });
        var len = function (v) { if (!v) return 0; v = String(v).trim().split(/[\s,]+/)[0]; return /em$/.test(v) ? parseFloat(v) * size : parseFloat(v) || 0; };
        var x = len(this.getAttribute('x')) + len(this.getAttribute('dx')), y = len(this.getAttribute('y')) + len(this.getAttribute('dy'));
        var anchor = this.getAttribute('text-anchor') || cs['text-anchor'];
        if (anchor === 'middle') x -= w / 2; else if (anchor === 'end') x -= w;
        return DOMRect(x, y - size * 0.89, w, size * 1.15);
      }
      var r = rectOf(this);
      return { x: 0, y: 0, width: r.width, height: r.height };
    }
    getTotalLength() { return 0; }
    // user units to the svg's (no viewBox scale) and to the page's: the
    // outer svg's box gives the shift
    getCTM() { return new DOMMatrix(); }
    getScreenCTM() { var s = this.localName === 'svg' ? this : this.ownerSVGElement || this; var r = rectOf(s); return new DOMMatrix([1, 0, 0, 1, r.left, r.top]); }
  }
  class SVGGraphicsElement extends SVGElement {}
  class SVGSVGElement extends SVGGraphicsElement {
    createSVGPoint() { return new DOMPoint(); }
    createSVGMatrix() { return new DOMMatrix(); }
  }
  class SVGPathElement extends SVGGraphicsElement {}

  var TAGS = {
    div: HTMLDivElement, span: HTMLSpanElement, p: HTMLParagraphElement, h1: HTMLHeadingElement, h2: HTMLHeadingElement,
    h3: HTMLHeadingElement, h4: HTMLHeadingElement, h5: HTMLHeadingElement, h6: HTMLHeadingElement, pre: HTMLPreElement,
    blockquote: HTMLQuoteElement, q: HTMLQuoteElement, br: HTMLBRElement, hr: HTMLHRElement, ul: HTMLUListElement,
    ol: HTMLOListElement, li: HTMLLIElement, dl: HTMLDListElement, table: HTMLTableElement, thead: HTMLTableSectionElement,
    tbody: HTMLTableSectionElement, tfoot: HTMLTableSectionElement, tr: HTMLTableRowElement, td: HTMLTableCellElement,
    th: HTMLTableCellElement, col: HTMLTableColElement, colgroup: HTMLTableColElement, caption: HTMLTableCaptionElement,
    html: HTMLHtmlElement, head: HTMLHeadElement, body: HTMLBodyElement, title: HTMLTitleElement, meta: HTMLMetaElement,
    base: HTMLBaseElement, style: HTMLStyleElement, link: HTMLLinkElement, script: HTMLScriptElement, a: HTMLAnchorElement,
    img: HTMLImageElement, iframe: HTMLIFrameElement, canvas: HTMLCanvasElement, video: HTMLVideoElement, audio: HTMLAudioElement,
    source: HTMLSourceElement, template: HTMLTemplateElement, slot: HTMLSlotElement, dialog: HTMLDialogElement,
    details: HTMLDetailsElement, label: HTMLLabelElement, fieldset: HTMLFieldSetElement, legend: HTMLLegendElement,
    form: HTMLFormElement, button: HTMLButtonElement, input: HTMLInputElement, textarea: HTMLTextAreaElement,
    option: HTMLOptionElement, optgroup: HTMLOptGroupElement, select: HTMLSelectElement, output: HTMLOutputElement,
    progress: HTMLProgressElement, meter: HTMLMeterElement, data: HTMLDataElement, time: HTMLTimeElement,
    ins: HTMLModElement, del: HTMLModElement, picture: HTMLPictureElement, map: HTMLMapElement, area: HTMLAreaElement,
    embed: HTMLEmbedElement, object: HTMLObjectElement, menu: HTMLMenuElement
  };
  var KNOWN = /^(abbr|address|article|aside|b|bdi|bdo|cite|code|dd|dfn|dt|em|figcaption|figure|footer|header|hgroup|i|kbd|main|mark|nav|noscript|rp|rt|ruby|s|samp|search|section|small|strong|sub|summary|sup|u|var|wbr|center|font|nobr|strike|tt|big)$/;

  function makeElement(d, name, ns) {
    var e;
    if (ns === SVG_NS) {
      var l = name.indexOf(':') > 0 ? name.slice(name.indexOf(':') + 1) : name;
      e = l === 'svg' ? new SVGSVGElement(name) : l === 'path' ? new SVGPathElement(name) : /^(g|circle|rect|line|polyline|polygon|ellipse|text|use|image|tspan)$/.test(l) ? new SVGGraphicsElement(name) : new SVGElement(name);
    } else if (ns === HTML_NS || ns === undefined) {
      var lower = name.toLowerCase();
      var C = TAGS[lower];
      if (C) e = new C(lower);
      else if (KNOWN.test(lower) || lower.indexOf('-') > 0) e = new HTMLElement(lower);
      else e = new HTMLUnknownElement(lower);
      var ce = customElementsRegistry[lower];
      if (ce) {
        try { var x = Reflect.construct(ce, [], ce); x._qname = lower; x.localName = lower; e = x; } catch (err) { reportError(err); }
      }
    } else {
      e = new Element(name, ns === null ? null : ns);
    }
    e.ownerDocument = d;
    return e;
  }

  // ---- documents -----------------------------------------------------------

  class Document extends Node {
    constructor() {
      super();
      this.ownerDocument = null;
      this._active = null;
      this._url = 'about:blank';
      this.readyState = 'loading';
      this.visibilityState = 'visible';
      this.hidden = false;
      this.compatMode = 'CSS1Compat';
      this.characterSet = 'UTF-8';
      this.charset = 'UTF-8';
      this.inputEncoding = 'UTF-8';
      this.contentType = 'text/html';
      this.designMode = 'off';
      this.dir = '';
      this.fonts = { ready: Promise.resolve(), check: function () { return true; }, load: function () { return Promise.resolve([]); }, add: function () {}, addEventListener: function () {}, removeEventListener: function () {}, status: 'loaded', forEach: function () {} };
      this.implementation = {
        createHTMLDocument: function (title) { var d = new Document(); var h = d.createElement('html'); d.appendChild(h); h.appendChild(d.createElement('head')); h.appendChild(d.createElement('body')); if (title !== undefined) d.title = title; return d; },
        createDocument: function () { return new Document(); },
        createDocumentType: function (n) { return new DocumentType(n); },
        hasFeature: function () { return true; }
      };
      this._cookie = '';
      this.currentScript = null;
      this.adoptedStyleSheets = [];
    }
    get nodeType() { return 9; }
    get nodeName() { return '#document'; }
    get documentElement() { return this.firstElementChild; }
    get head() { var h = this.documentElement; if (!h) return null; for (var i = 0; i < h._c.length; i++) if (h._c[i].localName === 'head') return h._c[i]; return null; }
    get body() { var h = this.documentElement; if (!h) return null; for (var i = 0; i < h._c.length; i++) if (h._c[i].localName === 'body') return h._c[i]; return null; }
    get title() { var t = this.querySelector('title'); return t ? t.textContent.replace(/\s+/g, ' ').trim() : ''; }
    set title(v) { var t = this.querySelector('title'); if (!t) { t = this.createElement('title'); if (this.head) this.head.appendChild(t); } t.textContent = v; }
    get URL() { return this._url; }
    get documentURI() { return this._url; }
    get location() { return this === doc ? G.location : null; }
    get defaultView() { return this === doc ? G : null; }
    get activeElement() {
      var a = this._active;
      if (a && a.isConnected) return a;
      return this.body || this.documentElement;
    }
    get styleSheets() { return styleSheetsOf(this); }
    get scrollingElement() { return this.documentElement; }
    get forms() { return this.getElementsByTagName('form'); }
    get images() { return this.getElementsByTagName('img'); }
    get links() { return this.querySelectorAll('a[href],area[href]'); }
    get scripts() { return this.getElementsByTagName('script'); }
    get doctype() { for (var i = 0; i < this._c.length; i++) if (this._c[i].nodeType === 10) return this._c[i]; return null; }
    get cookie() { return this._cookie; }
    set cookie(v) {
      var kv = String(v).split(';')[0];
      var name = kv.split('=')[0].trim();
      var parts = this._cookie ? this._cookie.split('; ') : [];
      parts = parts.filter(function (p) { return p.split('=')[0] !== name; });
      if (!/max-age=0|expires=Thu, 01 Jan 1970/i.test(String(v))) parts.push(kv.trim());
      this._cookie = parts.join('; ');
    }
    get referrer() { return ''; }
    get domain() { var u = parseURL(this._url); return u ? u.hostname : ''; }
    get lastModified() { return new Date().toString(); }
    get fullscreenElement() { return null; }
    get pointerLockElement() { return null; }
    get childElementCount() { return this.documentElement ? 1 : 0; }
    hasFocus() { return true; }
    createElement(name, opts) {
      name = String(name);
      if (!/^[a-zA-Z][^\s\/>]*$/.test(name)) throw DOMException("Failed to execute 'createElement' on 'Document': The tag name provided ('" + name + "') is not a valid name.", 'InvalidCharacterError');
      var is = opts && typeof opts === 'object' ? opts.is : undefined;
      var e = makeElement(this, name, HTML_NS);
      if (is) e.setAttribute('is', is);
      return e;
    }
    createElementNS(ns, name) { return makeElement(this, String(name), ns === null || ns === undefined || ns === '' ? null : ns); }
    createTextNode(t) { var n = new Text(t); n.ownerDocument = this; return n; }
    createComment(t) { var n = new Comment(t); n.ownerDocument = this; return n; }
    createCDATASection(t) { var n = new CDATASection(t); n.ownerDocument = this; return n; }
    createProcessingInstruction(target, t) { var n = new ProcessingInstruction(t); n.target = target; n.ownerDocument = this; return n; }
    createDocumentFragment() { var n = new DocumentFragment(); n.ownerDocument = this; return n; }
    createAttribute(n) { return new Attr(String(n).toLowerCase(), '', null); }
    createEvent(kind) {
      var k = String(kind).toLowerCase().replace(/s$/, '');
      var C = { event: Event, htmlevent: Event, customevent: CustomEvent, uievent: UIEvent, mouseevent: MouseEvent, keyboardevent: KeyboardEvent, focusevent: FocusEvent, messageevent: MessageEvent }[k];
      if (!C) throw DOMException("The provided event type ('" + kind + "') is invalid.", 'NotSupportedError');
      var e = new C('');
      if (C === CustomEvent) e.initCustomEvent = function (t, b, c, d) { this.initEvent(t, b, c); this.detail = d; };
      if (C === MouseEvent) e.initMouseEvent = function (t, b, c) { this.initEvent(t, b, c); };
      return e;
    }
    createRange() { return new Range(this); }
    createTreeWalker(root, what, filter) { return new TreeWalker(root, what === undefined ? 0xFFFFFFFF : what, filter || null); }
    createNodeIterator(root, what, filter) { return new NodeIterator(root, what === undefined ? 0xFFFFFFFF : what, filter || null); }
    importNode(n, deep) { var c = n.cloneNode(!!deep); adopt(c, this); return c; }
    adoptNode(n) { if (n.parentNode) n.parentNode.removeChild(n); adopt(n, this); return n; }
    getElementById(id) {
      id = String(id);
      var f = null;
      eachElement(this, function (e) { if (e.getAttribute('id') === id) { f = e; return true; } });
      return f;
    }
    getElementsByName(n) { var out = []; eachElement(this, function (e) { if (e.getAttribute('name') === n) out.push(e); }); return NodeList(out); }
    elementFromPoint(x, y) { return hitTest(x, y); }
    elementsFromPoint(x, y) { var e = hitTest(x, y), out = []; for (; e && e.nodeType === 1; e = e.parentNode) out.push(e); return out; }
    getSelection() { return selection; }
    execCommand(cmd, ui, value) {
      if (cmd === 'copy') return true;
      if (cmd === 'insertText') { var a = this._active; if (a && a._value !== undefined || (a && /^(input|textarea)$/.test(a.localName))) { a.setRangeText(String(value)); dispatch(a, new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' })); return true; } }
      return false;
    }
    queryCommandSupported() { return false; }
    queryCommandEnabled() { return false; }
    open() { removeAll(this); return this; }
    close() {}
    write(html) { var b = this.body; if (b) b.insertAdjacentHTML('beforeend', html); }
    writeln(html) { this.write(html + '\n'); }
    exitFullscreen() { return Promise.resolve(); }
    exitPointerLock() {}
    startViewTransition(cb) { var p = Promise.resolve().then(function () { return cb && cb(); }); return { finished: p, ready: p, updateCallbackDone: p, skipTransition: function () {} }; }
  }
  mixin(Document, ParentNode);
  class HTMLDocument extends Document {}
  class XMLDocument extends Document {}

  function innerTextOf(el) {
    var cs = computedOf(el);
    if (cs.display === 'none') return el.textContent;
    var out = '';
    (function walk(n) {
      for (var i = 0; i < n._c.length; i++) {
        var k = n._c[i];
        if (k.nodeType === 3) out += k.data.replace(/\s+/g, ' ');
        else if (k.nodeType === 1) {
          var d = computedOf(k).display;
          if (d === 'none') continue;
          if (k.localName === 'br') { out += '\n'; continue; }
          var block = d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table' || d === 'table-row';
          if (block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
          walk(k);
          if (block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        }
      }
    })(el);
    return out.replace(/ *\n */g, '\n').replace(/^\n+|\n+$/g, '');
  }

  // ---- event handler properties (GlobalEventHandlers) ---------------------

  // onclick, oninput, ...: null until set; a page (React) tests for them
  // with `'oninput' in document` before it listens
  var HANDLER_EVENTS = ('abort auxclick beforeinput blur cancel canplay change click close contextmenu copy cut dblclick drag dragend dragenter ' +
    'dragleave dragover dragstart drop error focus focusin focusout formdata input invalid keydown keypress keyup load loadend loadstart ' +
    'mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup paste pointercancel pointerdown pointerenter pointerleave ' +
    'pointermove pointerout pointerover pointerup progress reset resize scroll scrollend select selectionchange selectstart submit toggle ' +
    'touchcancel touchend touchmove touchstart transitionend animationend animationstart wheel').split(' ');
  function defineHandlers(proto, extra) {
    var names = HANDLER_EVENTS.concat(extra || []);
    names.forEach(function (type) {
      Object.defineProperty(proto, 'on' + type, {
        configurable: true, enumerable: true,
        get: function () {
          if (this._on && this._on[type]) return this._on[type];
          // an onclick="..." attribute, compiled once per text
          var src = this.getAttribute ? this.getAttribute('on' + type) : null;
          if (src === null || src === undefined) return null;
          if (!this._onAttr) this._onAttr = {};
          var c = this._onAttr[type];
          if (!c || c.src !== src) {
            try { c = { src: src, fn: new Function('event', src) }; } catch (e) { reportError(e); c = { src: src, fn: null }; }
            this._onAttr[type] = c;
          }
          return c.fn;
        },
        set: function (f) { if (!this._on) this._on = {}; this._on[type] = typeof f === 'function' ? f : null; }
      });
    });
  }
  defineHandlers(HTMLElement.prototype);
  defineHandlers(SVGElement.prototype);
  defineHandlers(Document.prototype, ['readystatechange', 'visibilitychange', 'DOMContentLoaded']);

  // ---- traversal, ranges, selection ----------------------------------------

  var NodeFilter = {
    FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
    SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 0x1, SHOW_ATTRIBUTE: 0x2, SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8,
    SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80, SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200, SHOW_DOCUMENT_FRAGMENT: 0x400
  };
  function acceptNode(w, n) {
    if (!((1 << (n.nodeType - 1)) & w.whatToShow)) return 3;
    var f = w.filter;
    if (!f) return 1;
    var r = typeof f === 'function' ? f(n) : f.acceptNode(n);
    return r === undefined ? 1 : r;
  }
  class TreeWalker {
    constructor(root, what, filter) { this.root = root; this.whatToShow = what >>> 0; this.filter = filter; this.currentNode = root; }
    parentNode() {
      for (var n = this.currentNode; n && n !== this.root;) {
        n = n.parentNode;
        if (n && acceptNode(this, n) === 1) { this.currentNode = n; return n; }
      }
      return null;
    }
    _child(first) {
      var n = first ? this.currentNode.firstChild : this.currentNode.lastChild;
      while (n) {
        var r = acceptNode(this, n);
        if (r === 1) { this.currentNode = n; return n; }
        if (r === 3) { var c = first ? n.firstChild : n.lastChild; if (c) { n = c; continue; } }
        while (n) {
          var s = first ? n.nextSibling : n.previousSibling;
          if (s) { n = s; break; }
          var p = n.parentNode;
          if (!p || p === this.root || p === this.currentNode) return null;
          n = p;
        }
      }
      return null;
    }
    firstChild() { return this._child(true); }
    lastChild() { return this._child(false); }
    _sibling(next) {
      var n = this.currentNode;
      if (n === this.root) return null;
      for (;;) {
        var s = next ? n.nextSibling : n.previousSibling;
        while (s) {
          n = s;
          var r = acceptNode(this, n);
          if (r === 1) { this.currentNode = n; return n; }
          s = next ? n.firstChild : n.lastChild;
          if (r === 2 || !s) s = next ? n.nextSibling : n.previousSibling;
        }
        n = n.parentNode;
        if (!n || n === this.root) return null;
        if (acceptNode(this, n) === 1) return null;
      }
    }
    nextSibling() { return this._sibling(true); }
    previousSibling() { return this._sibling(false); }
    nextNode() {
      var n = this.currentNode;
      for (;;) {
        var r = 1;
        while (r !== 2 && n.firstChild) {
          n = n.firstChild;
          r = acceptNode(this, n);
          if (r === 1) { this.currentNode = n; return n; }
        }
        var s = null;
        for (var t = n; t && t !== this.root; t = t.parentNode) { if (t.nextSibling) { s = t.nextSibling; break; } }
        if (!s) return null;
        n = s;
        r = acceptNode(this, n);
        if (r === 1) { this.currentNode = n; return n; }
        if (r === 2) {
          // skip the subtree: continue from its next node
          var nx = null;
          for (var u = n; u && u !== this.root; u = u.parentNode) { if (u.nextSibling) { nx = u.nextSibling; break; } }
          if (!nx) return null;
          n = nx;
          r = acceptNode(this, n);
          if (r === 1) { this.currentNode = n; return n; }
        }
      }
    }
    previousNode() {
      var n = this.currentNode;
      while (n && n !== this.root) {
        var s = n.previousSibling;
        while (s) {
          n = s;
          var r = acceptNode(this, n);
          while (r !== 2 && n.lastChild) { n = n.lastChild; r = acceptNode(this, n); }
          if (r === 1) { this.currentNode = n; return n; }
          s = n.previousSibling;
        }
        if (n === this.root || !n.parentNode) return null;
        n = n.parentNode;
        if (acceptNode(this, n) === 1) { this.currentNode = n; return n; }
      }
      return null;
    }
  }
  class NodeIterator {
    constructor(root, what, filter) { this.root = root; this.whatToShow = what >>> 0; this.filter = filter; this.referenceNode = root; this._before = true; }
    _list() { var out = [this.root]; (function walk(n) { for (var i = 0; i < n._c.length; i++) { out.push(n._c[i]); walk(n._c[i]); } })(this.root); return out; }
    nextNode() {
      var l = this._list(), i = l.indexOf(this.referenceNode);
      if (!this._before) i++;
      for (; i < l.length; i++) if (acceptNode(this, l[i]) === 1) { this.referenceNode = l[i]; this._before = false; return l[i]; }
      return null;
    }
    previousNode() {
      var l = this._list(), i = l.indexOf(this.referenceNode);
      if (this._before) i--;
      for (; i >= 0; i--) if (acceptNode(this, l[i]) === 1) { this.referenceNode = l[i]; this._before = true; return l[i]; }
      return null;
    }
    detach() {}
  }

  class Range {
    constructor(d) { this.startContainer = d; this.startOffset = 0; this.endContainer = d; this.endOffset = 0; }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() { var a = this.startContainer; while (a && !a.contains(this.endContainer)) a = a.parentNode; return a; }
    setStart(n, o) { this.startContainer = n; this.startOffset = o; }
    setEnd(n, o) { this.endContainer = n; this.endOffset = o; }
    setStartBefore(n) { this.setStart(n.parentNode, n.parentNode._c.indexOf(n)); }
    setStartAfter(n) { this.setStart(n.parentNode, n.parentNode._c.indexOf(n) + 1); }
    setEndBefore(n) { this.setEnd(n.parentNode, n.parentNode._c.indexOf(n)); }
    setEndAfter(n) { this.setEnd(n.parentNode, n.parentNode._c.indexOf(n) + 1); }
    selectNode(n) { this.setStartBefore(n); this.setEndAfter(n); }
    selectNodeContents(n) { this.setStart(n, 0); this.setEnd(n, n.nodeType === 3 ? n.data.length : n._c.length); }
    collapse(toStart) { if (toStart) this.setEnd(this.startContainer, this.startOffset); else this.setStart(this.endContainer, this.endOffset); }
    cloneRange() { var r = new Range(doc); r.setStart(this.startContainer, this.startOffset); r.setEnd(this.endContainer, this.endOffset); return r; }
    detach() {}
    toString() { var s = this.startContainer; if (s === this.endContainer && s.nodeType === 3) return s.data.slice(this.startOffset, this.endOffset); return s.textContent || ''; }
    getBoundingClientRect() { var n = this.startContainer; return rectOf(n.nodeType === 1 ? n : n.parentNode); }
    getClientRects() { return [this.getBoundingClientRect()]; }
    createContextualFragment(html) { return parseFragment(String(html), this.startContainer.nodeType === 1 ? this.startContainer : null); }
    deleteContents() {}
    extractContents() { return doc.createDocumentFragment(); }
    insertNode(n) { var c = this.startContainer; if (c.nodeType === 3) { var rest = c.splitText(this.startOffset); c.parentNode.insertBefore(n, rest); } else c.insertBefore(n, c._c[this.startOffset] || null); }
    surroundContents(n) { this.insertNode(n); }
    compareBoundaryPoints() { return 0; }
    intersectsNode() { return false; }
    isPointInRange() { return false; }
  }
  Range.START_TO_START = 0; Range.START_TO_END = 1; Range.END_TO_END = 2; Range.END_TO_START = 3;
  class StaticRange extends Range {}

  var selection = {
    _ranges: [],
    get rangeCount() { return this._ranges.length; },
    get anchorNode() { return this._ranges.length ? this._ranges[0].startContainer : null; },
    get anchorOffset() { return this._ranges.length ? this._ranges[0].startOffset : 0; },
    get focusNode() { return this._ranges.length ? this._ranges[0].endContainer : null; },
    get focusOffset() { return this._ranges.length ? this._ranges[0].endOffset : 0; },
    get isCollapsed() { return !this._ranges.length || this._ranges[0].collapsed; },
    get type() { return !this._ranges.length ? 'None' : this._ranges[0].collapsed ? 'Caret' : 'Range'; },
    getRangeAt: function (i) { if (!this._ranges[i]) throw DOMException('The index provided is invalid.', 'IndexSizeError'); return this._ranges[i]; },
    addRange: function (r) { this._ranges = [r]; },
    removeRange: function () { this._ranges = []; },
    removeAllRanges: function () { this._ranges = []; },
    empty: function () { this._ranges = []; },
    collapse: function (n, o) { if (!n) { this._ranges = []; return; } var r = new Range(doc); r.setStart(n, o || 0); r.collapse(true); this._ranges = [r]; },
    collapseToStart: function () {}, collapseToEnd: function () {},
    extend: function (n, o) { if (this._ranges.length) this._ranges[0].setEnd(n, o || 0); },
    setBaseAndExtent: function (a, ao, f, fo) { var r = new Range(doc); r.setStart(a, ao); r.setEnd(f, fo); this._ranges = [r]; },
    selectAllChildren: function (n) { var r = new Range(doc); r.selectNodeContents(n); this._ranges = [r]; },
    containsNode: function () { return false; },
    deleteFromDocument: function () {},
    modify: function () {},
    toString: function () { return this._ranges.length ? this._ranges[0].toString() : ''; }
  };

  // ---- focus ---------------------------------------------------------------

  function focusableByDefault(el) {
    var n = el.localName;
    if (n === 'a' || n === 'area') return el.hasAttribute('href');
    if (/^(input|select|textarea|button|iframe|summary)$/.test(n)) return !el.disabled && !(n === 'input' && el.type === 'hidden');
    return el.isContentEditable;
  }
  function focusable(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if (el.disabled) return false;
    if (el.hasAttribute('tabindex') || focusableByDefault(el)) {
      for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
        if (n.hasAttribute('inert')) return false;
        if (computedOf(n).display === 'none') return false;
      }
      return computedOf(el).visibility !== 'hidden';
    }
    return false;
  }
  function focusElement(el, opts) {
    if (!doc) return;
    if (el && !focusable(el)) return;
    var old = doc._active && doc._active.isConnected ? doc._active : null;
    if (old === el) return;
    if (old) {
      doc._active = null;
      dispatch(old, new FocusEvent('blur', { relatedTarget: el, view: G }));
      dispatch(old, new FocusEvent('focusout', { bubbles: true, relatedTarget: el, view: G }));
    }
    doc._active = el;
    changed();
    if (el) {
      dispatch(el, new FocusEvent('focus', { relatedTarget: old, view: G }));
      dispatch(el, new FocusEvent('focusin', { bubbles: true, relatedTarget: old, view: G }));
    }
  }
  function tabOrder() {
    var out = [];
    if (doc) eachElement(doc, function (e) { if (focusable(e) && e.tabIndex >= 0) out.push(e); });
    var pos = out.filter(function (e) { return e.tabIndex > 0; }).sort(function (a, b) { return a.tabIndex - b.tabIndex; });
    return pos.concat(out.filter(function (e) { return e.tabIndex === 0; }));
  }

  // a click with its activation: a checkbox or radio changes before the
  // listeners see the click and is put back if the click is canceled. The
  // checkedness is set as the browser does, not through the checked setter
  // (React's value tracker wraps it and would miss the change).
  function activatedClick(el, ev) {
    var box = el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio') ? el : null;
    var was = box && checkedness(box), prev = null;
    if (box && box.type === 'radio' && !was && box.getAttribute('name')) {
      eachElement(formOf(box) || box.getRootNode(), function (o) {
        if (o !== box && o.localName === 'input' && o.type === 'radio' && checkedness(o) && o.getAttribute('name') === box.getAttribute('name')) prev = o;
      });
    }
    if (box) {
      box._checked = box.type === 'checkbox' ? !was : true;
      if (box._checked && box.type === 'radio') uncheckGroup(box);
      changed();
    }
    var ok = dispatch(el, ev);
    if (!ok) {
      if (box) { box._checked = was; if (prev) prev._checked = true; changed(); }
      return;
    }
    if (box) { if (box._checked !== was) fireChange(box); return; }
    activationBehavior(el, ev);
  }
  function checkedness(o) { return o._checked !== undefined ? o._checked : o.hasAttribute('checked'); }
  function activationBehavior(el, ev) {
    // what a click does after the listeners: links, labels, form controls
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      var l = n.localName;
      if (l === 'input') {
        var t = n.type;
        if (t === 'submit' || t === 'image') submitForm(n);
        else if (t === 'reset') { var rf = n.form; if (rf) rf.reset(); }
        return;
      }
      if (l === 'button') {
        if (n.disabled) return;
        if (n.type === 'submit') submitForm(n);
        else if (n.type === 'reset') { var f2 = n.form; if (f2) f2.reset(); }
        return;
      }
      if (l === 'label') {
        var c = n.control;
        if (c && c !== el && !c.contains(el)) { c.focus(); c.click(); }
        return;
      }
      if (l === 'a' && n.hasAttribute('href')) {
        var href = n.getAttribute('href');
        if (href && href.charAt(0) !== '#' && !/^javascript:/i.test(href)) G.open(resolveURL(href), n.getAttribute('target') || '_self');
        return;
      }
      if (l === 'summary' && n.parentNode && n.parentNode.localName === 'details') { n.parentNode.open = !n.parentNode.open; dispatch(n.parentNode, new Event('toggle')); return; }
    }
  }
  function fireChange(n) {
    dispatch(n, new InputEvent('input', { bubbles: true, composed: true }));
    dispatch(n, new Event('change', { bubbles: true }));
  }
  function submitForm(btn) {
    var f = btn.form;
    if (!f) return;
    var ev = new Event('submit', { bubbles: true, cancelable: true });
    ev.submitter = btn;
    dispatch(f, ev);
  }

  // ---- mutation observers --------------------------------------------------

  var observers = [];
  var mutationQueued = false;
  class MutationRecord {
    constructor(type, target, x) {
      this.type = type; this.target = target;
      this.addedNodes = NodeList(x.addedNodes || []); this.removedNodes = NodeList(x.removedNodes || []);
      this.previousSibling = x.previousSibling || null; this.nextSibling = x.nextSibling || null;
      this.attributeName = x.attributeName || null; this.attributeNamespace = null;
      this.oldValue = x.oldValue === undefined ? null : x.oldValue;
    }
  }
  class MutationObserver {
    constructor(cb) { if (typeof cb !== 'function') throw new TypeError("Failed to construct 'MutationObserver': parameter 1 is not of type 'MutationCallback'."); this._cb = cb; this._targets = []; this._records = []; }
    observe(target, opts) {
      opts = opts || {};
      if (opts.attributeFilter || opts.attributeOldValue) opts.attributes = true;
      if (opts.characterDataOldValue) opts.characterData = true;
      for (var i = 0; i < this._targets.length; i++) if (this._targets[i].node === target) { this._targets[i].opts = opts; return; }
      this._targets.push({ node: target, opts: opts });
      if (observers.indexOf(this) < 0) observers.push(this);
    }
    disconnect() { this._targets = []; this._records = []; var i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1); }
    takeRecords() { var r = this._records; this._records = []; return r; }
  }
  function queueMutation(target, type, x) {
    if (!observers.length) return;
    for (var i = 0; i < observers.length; i++) {
      var o = observers[i];
      for (var j = 0; j < o._targets.length; j++) {
        var t = o._targets[j], op = t.opts;
        if (t.node !== target && !(op.subtree && t.node.contains(target))) continue;
        if (type === 'childList' && !op.childList) continue;
        if (type === 'attributes' && (!op.attributes || (op.attributeFilter && op.attributeFilter.indexOf(x.attributeName) < 0))) continue;
        if (type === 'characterData' && !op.characterData) continue;
        var keepOld = (type === 'attributes' && op.attributeOldValue) || (type === 'characterData' && op.characterDataOldValue);
        var rec = new MutationRecord(type, target, keepOld ? x : { addedNodes: x.addedNodes, removedNodes: x.removedNodes, previousSibling: x.previousSibling, nextSibling: x.nextSibling, attributeName: x.attributeName });
        o._records.push(rec);
        break;
      }
    }
    if (!mutationQueued) {
      mutationQueued = true;
      Promise.resolve().then(deliverMutations);
    }
  }
  function deliverMutations() {
    mutationQueued = false;
    var list = observers.slice();
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o._records.length) continue;
      var r = o.takeRecords();
      try { o._cb.call(o, r, o); } catch (e) { reportError(e); }
    }
  }

  // ---- geometry: DOMMatrix, DOMPoint ---------------------------------------

  // a 4x4 matrix in column-major m11..m44, a..f its 2D part; built from
  // nothing, 6 or 16 numbers, or a CSS transform list (the computed
  // `matrix(...)` or what a page writes: translate, scale, rotate, skew)
  var M_KEYS = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'];
  function cssAngle(s) {
    var v = parseFloat(s) || 0;
    if (/turn$/.test(s)) return v * 2 * Math.PI;
    if (/grad$/.test(s)) return v * Math.PI / 200;
    if (/rad$/.test(s)) return v;
    return v * Math.PI / 180;
  }
  function transformList(s) {
    var m = new DOMMatrix();
    s = String(s).trim();
    if (s === '' || s === 'none') return m;
    var re = /([a-zA-Z0-9]+)\(([^)]*)\)/g, f, any = false;
    while ((f = re.exec(s))) {
      any = true;
      var name = f[1], raw = f[2].split(/\s*,\s*|\s+/).filter(function (x) { return x !== ''; });
      var n = raw.map(function (x) { return parseFloat(x) || 0; });
      var t;
      if (name === 'matrix') t = new DOMMatrix(n.slice(0, 6));
      else if (name === 'matrix3d') t = new DOMMatrix(n.slice(0, 16));
      else if (name === 'translate') t = new DOMMatrix([1, 0, 0, 1, n[0] || 0, n[1] || 0]);
      else if (name === 'translateX') t = new DOMMatrix([1, 0, 0, 1, n[0] || 0, 0]);
      else if (name === 'translateY') t = new DOMMatrix([1, 0, 0, 1, 0, n[0] || 0]);
      else if (name === 'translate3d') t = new DOMMatrix().translate(n[0], n[1], n[2]);
      else if (name === 'scale') t = new DOMMatrix([n[0], 0, 0, n.length > 1 ? n[1] : n[0], 0, 0]);
      else if (name === 'scaleX') t = new DOMMatrix([n[0], 0, 0, 1, 0, 0]);
      else if (name === 'scaleY') t = new DOMMatrix([1, 0, 0, n[0], 0, 0]);
      else if (name === 'rotate' || name === 'rotateZ') { var a = cssAngle(raw[0] || '0'); t = new DOMMatrix([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); }
      else if (name === 'skewX') t = new DOMMatrix([1, 0, Math.tan(cssAngle(raw[0] || '0')), 1, 0, 0]);
      else if (name === 'skewY') t = new DOMMatrix([1, Math.tan(cssAngle(raw[0] || '0')), 0, 1, 0, 0]);
      else if (name === 'skew') t = new DOMMatrix([1, Math.tan(cssAngle(raw[1] || '0')), Math.tan(cssAngle(raw[0] || '0')), 1, 0, 0]);
      else throw new SyntaxError("Failed to construct 'DOMMatrix': Failed to parse '" + s + "'.");
      m.multiplySelf(t);
    }
    if (!any) throw new SyntaxError("Failed to construct 'DOMMatrix': Failed to parse '" + s + "'.");
    return m;
  }
  class DOMMatrix {
    constructor(init) {
      var v = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      this.is2D = true;
      if (typeof init === 'string') {
        var p = transformList(init);
        v = M_KEYS.map(function (k) { return p[k]; });
        this.is2D = p.is2D;
      } else if (init && init.length === 6) {
        v[0] = +init[0]; v[1] = +init[1]; v[4] = +init[2]; v[5] = +init[3]; v[12] = +init[4]; v[13] = +init[5];
      } else if (init && init.length === 16) {
        v = Array.prototype.map.call(init, Number);
        this.is2D = false;
      } else if (init !== undefined && init !== null && !(init.length === 0)) {
        throw new TypeError("Failed to construct 'DOMMatrix': The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.");
      }
      for (var i = 0; i < 16; i++) this[M_KEYS[i]] = v[i];
    }
    get a() { return this.m11; } set a(x) { this.m11 = x; }
    get b() { return this.m12; } set b(x) { this.m12 = x; }
    get c() { return this.m21; } set c(x) { this.m21 = x; }
    get d() { return this.m22; } set d(x) { this.m22 = x; }
    get e() { return this.m41; } set e(x) { this.m41 = x; }
    get f() { return this.m42; } set f(x) { this.m42 = x; }
    get isIdentity() { var me = this; return M_KEYS.every(function (k, i) { return me[k] === (i % 5 === 0 ? 1 : 0); }); }
    static fromMatrix(o) { o = o || {}; if (o instanceof DOMMatrix) return new DOMMatrix(M_KEYS.map(function (k) { return o[k]; })); return new DOMMatrix([o.a === undefined ? 1 : o.a, o.b || 0, o.c || 0, o.d === undefined ? 1 : o.d, o.e || 0, o.f || 0]); }
    static fromFloat32Array(a) { return new DOMMatrix(Array.from(a)); }
    static fromFloat64Array(a) { return new DOMMatrix(Array.from(a)); }
    // this = this × o (o applied first to a point)
    multiplySelf(o) {
      if (!(o instanceof DOMMatrix)) o = DOMMatrix.fromMatrix(o);
      var a = M_KEYS.map(function (k) { return this[k]; }, this), b = M_KEYS.map(function (k) { return o[k]; }), r = [];
      for (var col = 0; col < 4; col++) for (var row = 0; row < 4; row++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
        r[col * 4 + row] = s;
      }
      for (var i = 0; i < 16; i++) this[M_KEYS[i]] = r[i];
      this.is2D = this.is2D && o.is2D;
      return this;
    }
    preMultiplySelf(o) { var r = DOMMatrix.fromMatrix(o).multiplySelf(this); for (var i = 0; i < 16; i++) this[M_KEYS[i]] = r[M_KEYS[i]]; this.is2D = r.is2D; return this; }
    translateSelf(x, y, z) { var t = new DOMMatrix(); t.m41 = x || 0; t.m42 = y || 0; t.m43 = z || 0; if (z) t.is2D = false; return this.multiplySelf(t); }
    scaleSelf(sx, sy, sz, ox, oy, oz) {
      if (sx === undefined) sx = 1;
      if (sy === undefined) sy = sx;
      if (sz === undefined) sz = 1;
      ox = ox || 0; oy = oy || 0; oz = oz || 0;
      var t = new DOMMatrix([sx, 0, 0, sy, 0, 0]); t.m33 = sz; if (sz !== 1 || oz) t.is2D = false;
      return this.translateSelf(ox, oy, oz).multiplySelf(t).translateSelf(-ox, -oy, -oz);
    }
    rotateSelf(rx, ry, rz) {
      if (ry === undefined && rz === undefined) { rz = rx; rx = 0; ry = 0; }
      var a = (rz || 0) * Math.PI / 180;
      return this.multiplySelf(new DOMMatrix([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]));
    }
    skewXSelf(s) { return this.multiplySelf(new DOMMatrix([1, 0, Math.tan((s || 0) * Math.PI / 180), 1, 0, 0])); }
    skewYSelf(s) { return this.multiplySelf(new DOMMatrix([1, Math.tan((s || 0) * Math.PI / 180), 0, 1, 0, 0])); }
    invertSelf() {
      // 2D inverse (what pages ask of a CSS transform); 3D through the adjugate
      var m = M_KEYS.map(function (k) { return this[k]; }, this), inv = [];
      inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
      inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
      inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
      inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
      inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
      inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
      inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
      inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
      inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
      inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
      inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
      inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
      inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
      inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
      inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
      inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
      var det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
      for (var i = 0; i < 16; i++) this[M_KEYS[i]] = det ? inv[i] / det : NaN;
      if (!det) this.is2D = false;
      return this;
    }
    multiply(o) { return DOMMatrix.fromMatrix(this).multiplySelf(o); }
    translate(x, y, z) { return DOMMatrix.fromMatrix(this).translateSelf(x, y, z); }
    scale(sx, sy, sz, ox, oy, oz) { return DOMMatrix.fromMatrix(this).scaleSelf(sx, sy, sz, ox, oy, oz); }
    scaleNonUniform(sx, sy) { return this.scale(sx, sy === undefined ? 1 : sy); }
    rotate(rx, ry, rz) { return DOMMatrix.fromMatrix(this).rotateSelf(rx, ry, rz); }
    skewX(s) { return DOMMatrix.fromMatrix(this).skewXSelf(s); }
    skewY(s) { return DOMMatrix.fromMatrix(this).skewYSelf(s); }
    inverse() { return DOMMatrix.fromMatrix(this).invertSelf(); }
    flipX() { return this.multiply(new DOMMatrix([-1, 0, 0, 1, 0, 0])); }
    flipY() { return this.multiply(new DOMMatrix([1, 0, 0, -1, 0, 0])); }
    transformPoint(p) {
      p = p || {};
      var x = p.x || 0, y = p.y || 0, z = p.z || 0, w = p.w === undefined ? 1 : p.w;
      return new DOMPoint(
        this.m11 * x + this.m21 * y + this.m31 * z + this.m41 * w,
        this.m12 * x + this.m22 * y + this.m32 * z + this.m42 * w,
        this.m13 * x + this.m23 * y + this.m33 * z + this.m43 * w,
        this.m14 * x + this.m24 * y + this.m34 * z + this.m44 * w);
    }
    toFloat64Array() { var me = this; return new Float64Array(M_KEYS.map(function (k) { return me[k]; })); }
    toFloat32Array() { var me = this; return new Float32Array(M_KEYS.map(function (k) { return me[k]; })); }
    toJSON() { var o = { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f, is2D: this.is2D, isIdentity: this.isIdentity }; for (var i = 0; i < 16; i++) o[M_KEYS[i]] = this[M_KEYS[i]]; return o; }
    toString() {
      var me = this;
      if (this.is2D) return 'matrix(' + [this.a, this.b, this.c, this.d, this.e, this.f].join(', ') + ')';
      return 'matrix3d(' + M_KEYS.map(function (k) { return me[k]; }).join(', ') + ')';
    }
  }
  class DOMPoint {
    constructor(x, y, z, w) { this.x = +(x || 0); this.y = +(y || 0); this.z = +(z || 0); this.w = w === undefined ? 1 : +w; }
    static fromPoint(p) { p = p || {}; return new DOMPoint(p.x, p.y, p.z, p.w); }
    matrixTransform(m) { return (m instanceof DOMMatrix ? m : DOMMatrix.fromMatrix(m)).transformPoint(this); }
    toJSON() { return { x: this.x, y: this.y, z: this.z, w: this.w }; }
  }

  // ---- layout feedback: boxes, observers -----------------------------------

  function DOMRect(x, y, w, h) {
    x = x || 0; y = y || 0; w = w || 0; h = h || 0;
    return { x: x, y: y, width: w, height: h, top: Math.min(y, y + h), left: Math.min(x, x + w), right: Math.max(x, x + w), bottom: Math.max(y, y + h), toJSON: function () { return { x: x, y: y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h }; } };
  }
  DOMRect.fromRect = function (r) { r = r || {}; return DOMRect(r.x, r.y, r.width, r.height); };
  function rectOf(el) {
    var b = boxes[el.__id];
    if (!b) return DOMRect(0, 0, 0, 0);
    var sx = 0, sy = 0;
    for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) { sx += n.scrollLeft || 0; sy += n.scrollTop || 0; }
    return DOMRect(b[0] - sx, b[1] - sy, b[2], b[3]);
  }
  // an element's laid-out border box size: under a scale (a zoomed
  // viewport) the host sends it after the drawn box (boxes[id][8..9]);
  // offsetWidth and ResizeObserver report it, getBoundingClientRect the
  // drawn box
  function layoutSize(el) {
    var b = boxes[el.__id];
    if (!b) return [0, 0];
    return b[8] !== undefined ? [b[8], b[9]] : [b[2], b[3]];
  }
  function sizeOf(el, what) {
    var b = boxes[el.__id];
    if (el === (doc && doc.documentElement) && (what === 'cw' || what === 'ch')) return what === 'cw' ? viewport.w : viewport.h;
    if (!b) return 0;
    // client size: the padding box (the border box without its borders)
    if (what === 'cw') return Math.round(b[4] !== undefined ? b[4] : b[2] - edgesOf(el).bx);
    if (what === 'ch') return Math.round(b[5] !== undefined ? b[5] : b[3] - edgesOf(el).by);
    if (what === 'sw') return Math.round(b[6] !== undefined ? b[6] : b[2]);
    return Math.round(b[7] !== undefined ? b[7] : b[3]);
  }
  // an element's padding and border widths in px, and their sums across
  // (bx, by: borders; px, py: paddings)
  function edgesOf(el) {
    var cs = computedOf(el), n = function (k) { var v = parseFloat(cs[k]); return isFinite(v) ? v : 0; };
    var bs = function (side) { var st = cs['border-' + side + '-style']; return !st || st === 'none' || st === 'hidden' ? 0 : n('border-' + side + '-width'); };
    var e = { pl: n('padding-left'), pr: n('padding-right'), pt: n('padding-top'), pb: n('padding-bottom'), bl: bs('left'), br: bs('right'), bt: bs('top'), bb: bs('bottom') };
    e.bx = e.bl + e.br; e.by = e.bt + e.bb; e.px = e.pl + e.pr; e.py = e.pt + e.pb;
    return e;
  }
  function hittable(e) {
    var cs = computedOf(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs['pointer-events'] !== 'none';
  }
  function under(e, x, y) {
    if (!boxes[e.__id]) return true;
    var r = rectOf(e);
    return x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1;
  }
  // e or an ancestor has a transform: the host's hit test does not see it
  function transformedUnder(e) {
    for (var n = e; n && n.nodeType === 1; n = n.parentNode) {
      var tr = computedOf(n).transform;
      if (tr && tr !== 'none') return true;
    }
    return false;
  }
  function hitTest(x, y) {
    var best = null;
    if (!doc) return null;
    eachElement(doc, function (e) {
      var r = rectOf(e);
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom && hittable(e)) best = e;
    });
    return best;
  }

  var resizeObservers = [];
  class ResizeObserver {
    constructor(cb) { this._cb = cb; this._els = []; }
    observe(el, opts) { if (this._els.some(function (x) { return x.el === el; })) return; this._els.push({ el: el, last: null }); if (resizeObservers.indexOf(this) < 0) resizeObservers.push(this); scheduleResize(); }
    unobserve(el) { this._els = this._els.filter(function (x) { return x.el !== el; }); }
    disconnect() { this._els = []; var i = resizeObservers.indexOf(this); if (i >= 0) resizeObservers.splice(i, 1); }
  }
  var resizeQueued = false;
  function scheduleResize() { if (resizeQueued) return; resizeQueued = true; setTimeout(fireResize, 0); }
  function fireResize() {
    resizeQueued = false;
    var list = resizeObservers.slice();
    for (var i = 0; i < list.length; i++) {
      var o = list[i], entries = [];
      for (var j = 0; j < o._els.length; j++) {
        var x = o._els[j], ls = layoutSize(x.el), r = { width: ls[0], height: ls[1] };
        var key = r.width + 'x' + r.height;
        if (x.last === key) continue;
        x.last = key;
        // contentRect and contentBoxSize are the content box: the border
        // box without padding and borders (a chart sizes its canvas by it)
        var e = edgesOf(x.el), cw = Math.max(0, r.width - e.bx - e.px), ch = Math.max(0, r.height - e.by - e.py);
        var border = [{ inlineSize: r.width, blockSize: r.height }], content = [{ inlineSize: cw, blockSize: ch }];
        entries.push({ target: x.el, contentRect: DOMRect(e.pl, e.pt, cw, ch), borderBoxSize: border, contentBoxSize: content, devicePixelContentBoxSize: content });
      }
      if (entries.length) { try { o._cb.call(o, entries, o); } catch (e) { reportError(e); } }
    }
  }
  var intersectionObservers = [];
  class IntersectionObserver {
    constructor(cb, opts) { this._cb = cb; this._els = []; this.root = (opts && opts.root) || null; this.rootMargin = (opts && opts.rootMargin) || '0px'; this.thresholds = [].concat((opts && opts.threshold) || 0); }
    observe(el) { this._els.push({ el: el, last: null }); if (intersectionObservers.indexOf(this) < 0) intersectionObservers.push(this); scheduleIntersect(); }
    unobserve(el) { this._els = this._els.filter(function (x) { return x.el !== el; }); }
    disconnect() { this._els = []; var i = intersectionObservers.indexOf(this); if (i >= 0) intersectionObservers.splice(i, 1); }
    takeRecords() { return []; }
  }
  var intersectQueued = false;
  function scheduleIntersect() { if (intersectQueued) return; intersectQueued = true; setTimeout(fireIntersect, 0); }
  function fireIntersect() {
    intersectQueued = false;
    var list = intersectionObservers.slice();
    for (var i = 0; i < list.length; i++) {
      var o = list[i], entries = [];
      for (var j = 0; j < o._els.length; j++) {
        var x = o._els[j], r = rectOf(x.el);
        var inside = r.bottom > 0 && r.right > 0 && r.top < viewport.h && r.left < viewport.w && r.width * r.height > 0;
        if (x.last === inside) continue;
        x.last = inside;
        entries.push({ target: x.el, isIntersecting: inside, intersectionRatio: inside ? 1 : 0, boundingClientRect: r, intersectionRect: inside ? r : DOMRect(0, 0, 0, 0), rootBounds: DOMRect(0, 0, viewport.w, viewport.h), time: now() });
      }
      if (entries.length) { try { o._cb.call(o, entries, o); } catch (e) { reportError(e); } }
    }
  }

  // ---- HTML parsing and serialization --------------------------------------

  var VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
  var RAW = /^(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/;
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', divide: '\u00f7', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', sect: '\u00a7', deg: '\u00b0', plusmn: '\u00b1', para: '\u00b6', larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193', auml: '\u00e4', ouml: '\u00f6', uuml: '\u00fc', Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc', aring: '\u00e5', Aring: '\u00c5', szlig: '\u00df', eacute: '\u00e9', egrave: '\u00e8', zwj: '\u200d', zwnj: '\u200c', shy: '\u00ad', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', check: '\u2713' };
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, function (m, e) {
      if (e.charAt(0) === '#') {
        var cp = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!(cp > 0 && cp < 0x110000)) return '\ufffd';
        return String.fromCodePoint(cp);
      }
      var v = ENTITIES[e];
      return v === undefined ? m : v;
    });
  }
  // the elements a start tag closes (a small part of the tree builder)
  var CLOSES = {
    p: /^(address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|main|menu|nav|ol|p|pre|section|table|ul)$/,
    li: /^li$/, dt: /^(dt|dd)$/, dd: /^(dt|dd)$/, option: /^(option|optgroup)$/, optgroup: /^optgroup$/
  };
  var TABLE_PART = { td: /^(td|th)$/, th: /^(td|th)$/, tr: /^tr$/, tbody: /^(tbody|thead|tfoot)$/, thead: /^(tbody|thead|tfoot)$/, tfoot: /^(tbody|thead|tfoot)$/ };
  function parseInto(html, root, d, svgRoot) {
    var stack = [root];
    var i = 0, n = html.length;
    function cur() { return stack[stack.length - 1]; }
    function text(t) {
      if (!t) return;
      var c = cur();
      var last = c.lastChild;
      if (last && last.nodeType === 3) last._data += t;
      else c.appendChild(d.createTextNode(t));
    }
    while (i < n) {
      var lt = html.indexOf('<', i);
      if (lt < 0) { text(decodeEntities(html.slice(i))); break; }
      if (lt > i) text(decodeEntities(html.slice(i, lt)));
      i = lt;
      if (html.substr(i, 4) === '<!--') {
        var end = html.indexOf('-->', i + 4);
        if (end < 0) end = n;
        cur().appendChild(d.createComment(html.slice(i + 4, end)));
        i = end + 3;
        continue;
      }
      if (html.substr(i, 9).toUpperCase() === '<!DOCTYPE') {
        var e2 = html.indexOf('>', i);
        if (root.nodeType === 9) root.appendChild(new DocumentType('html'));
        i = e2 < 0 ? n : e2 + 1;
        continue;
      }
      if (html.substr(i, 9) === '<![CDATA[') {
        var e3 = html.indexOf(']]>', i);
        if (e3 < 0) e3 = n;
        text(html.slice(i + 9, e3));
        i = e3 + 3;
        continue;
      }
      if (html.charAt(i + 1) === '/') {
        var m = /^<\/([a-zA-Z][^\s\/>]*)\s*>/.exec(html.slice(i, i + 200));
        if (!m) { text('<'); i++; continue; }
        var name = m[1].toLowerCase();
        for (var k = stack.length - 1; k > 0; k--) {
          var q = stack[k];
          // template content stands on the stack for its template
          var qn = q.nodeType === 11 ? 'template' : q.localName;
          if (qn === name || (q.namespaceURI !== HTML_NS && qn.toLowerCase() === name)) { stack.length = k; break; }
        }
        i += m[0].length;
        continue;
      }
      var tm = /^<([a-zA-Z][^\s\/>]*)/.exec(html.slice(i, i + 200));
      if (!tm || html.charAt(i + 1) === '!' || html.charAt(i + 1) === '?') {
        if (html.charAt(i + 1) === '!' || html.charAt(i + 1) === '?') { var e4 = html.indexOf('>', i); i = e4 < 0 ? n : e4 + 1; continue; }
        text('<'); i++; continue;
      }
      var tag = tm[1];
      var j = i + tm[0].length;
      var attrs = [];
      var selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(html.charAt(j))) j++;
        if (j >= n) break;
        var ch = html.charAt(j);
        if (ch === '>') { j++; break; }
        if (ch === '/' && html.charAt(j + 1) === '>') { selfClose = true; j += 2; break; }
        if (ch === '/') { j++; continue; }
        var am = /^[^\s"'>\/=]+/.exec(html.slice(j, j + 300));
        if (!am) { j++; continue; }
        var an = am[0];
        j += an.length;
        while (j < n && /\s/.test(html.charAt(j))) j++;
        var av = '';
        if (html.charAt(j) === '=') {
          j++;
          while (j < n && /\s/.test(html.charAt(j))) j++;
          var qc = html.charAt(j);
          if (qc === '"' || qc === "'") {
            var qe = html.indexOf(qc, j + 1);
            if (qe < 0) qe = n;
            av = html.slice(j + 1, qe);
            j = qe + 1;
          } else {
            var um = /^[^\s>]*/.exec(html.slice(j, j + 2000));
            av = um[0];
            j += av.length;
          }
          av = decodeEntities(av);
        }
        attrs.push([an, av]);
      }
      i = j;
      var parent = cur();
      var inSvg = parent.namespaceURI === SVG_NS && parent.localName !== 'foreignObject';
      var lower = tag.toLowerCase();
      var ns = inSvg || lower === 'svg' ? SVG_NS : HTML_NS;
      if (ns === HTML_NS) {
        // implied end tags
        var closes = CLOSES[lower];
        // a cell, row or section start closes the open one, up to its table
        var tbl = TABLE_PART[lower];
        if (tbl) {
          for (var s3 = stack.length - 1; s3 > 0 && stack[s3].nodeType === 1 && stack[s3].localName !== 'table'; s3--) {
            if (tbl.test(stack[s3].localName)) { stack.length = s3; break; }
          }
        }
        for (var s2 = stack.length - 1; s2 > 0 && !tbl; s2--) {
          var top = stack[s2];
          if (lower === 'li' && top.localName === 'li') { stack.length = s2; break; }
          if (top.localName === 'p' && CLOSES.p.test(lower)) { stack.length = s2; break; }
          if (closes && closes.test(top.localName) && lower !== 'p') { stack.length = s2; break; }
          if (top.nodeType === 11 || /^(div|ul|ol|table|body|html|dl|select|tbody|thead|tfoot|tr|td|th)$/.test(top.localName)) break;
        }
        // the sections and rows a table implies
        if (/^(tr|td|th)$/.test(lower) && cur().localName === 'table') stack.push(cur().appendChild(d.createElement('tbody')));
        if (/^(td|th)$/.test(lower) && /^(tbody|thead|tfoot)$/.test(cur().localName)) stack.push(cur().appendChild(d.createElement('tr')));
        if (root.nodeType === 9 && (lower === 'html' || lower === 'head' || lower === 'body')) {
          var have = lower === 'html' ? d.documentElement : lower === 'head' ? d.head : d.body;
          if (have) {
            for (var a = 0; a < attrs.length; a++) if (!have.hasAttribute(attrs[a][0])) have.setAttribute(attrs[a][0], attrs[a][1]);
            if (stack.indexOf(have) < 0) stack.push(have);
            continue;
          }
        }
      }
      var el = d.createElementNS(ns, ns === HTML_NS ? lower : svgName(tag));
      for (var b = 0; b < attrs.length; b++) {
        try { el.setAttribute(ns === SVG_NS ? svgAttr(attrs[b][0]) : attrs[b][0], attrs[b][1]); } catch (x) {}
      }
      if (lower === 'script') el._parser = true;
      cur().appendChild(el);
      if (ns === HTML_NS && RAW.test(lower)) {
        var close = new RegExp('</' + lower + '\\s*>', 'i');
        var rest = html.slice(i);
        var cm = close.exec(rest);
        var body = cm ? rest.slice(0, cm.index) : rest;
        if (body) {
          var target = lower === 'template' ? el.content : el;
          target.appendChild(d.createTextNode(lower === 'textarea' || lower === 'title' ? decodeEntities(body.replace(/^\n/, '')) : body));
        }
        i += cm ? cm.index + cm[0].length : rest.length;
        continue;
      }
      if (selfClose && ns !== HTML_NS) continue;
      if (ns === HTML_NS && VOID.test(lower)) continue;
      if (lower === 'template') { stack.push(el.content); continue; }
      stack.push(el);
    }
  }
  var SVG_NAMES = { clippath: 'clipPath', lineargradient: 'linearGradient', radialgradient: 'radialGradient', foreignobject: 'foreignObject', textpath: 'textPath', fegaussianblur: 'feGaussianBlur', feoffset: 'feOffset', femerge: 'feMerge', femergenode: 'feMergeNode', feblend: 'feBlend', fecolormatrix: 'feColorMatrix', feflood: 'feFlood', fecomposite: 'feComposite', animatetransform: 'animateTransform' };
  function svgName(t) { return SVG_NAMES[t.toLowerCase()] || t; }
  var SVG_ATTRS = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', patternunits: 'patternUnits', stddeviation: 'stdDeviation', clippathunits: 'clipPathUnits', markerwidth: 'markerWidth', markerheight: 'markerHeight', refx: 'refX', refy: 'refY' };
  function svgAttr(a) { return SVG_ATTRS[a.toLowerCase()] || a; }

  function parseFragment(html, context) {
    var d = (context && context.ownerDocument) || doc;
    var frag = d.createDocumentFragment();
    var holder = context && context.namespaceURI === SVG_NS ? d.createElementNS(SVG_NS, 'g') : d.createElement(context && context.localName === 'template' ? 'div' : 'div');
    parseInto(html, holder, d);
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    return frag;
  }

  function escapeText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;'); }
  function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;'); }
  function serialize(n, inner) {
    if (n.nodeType === 3) {
      var p = n.parentNode;
      if (p && p.nodeType === 1 && p.namespaceURI === HTML_NS && /^(script|style|xmp|iframe|noembed|noframes|plaintext|noscript)$/.test(p.localName)) return n.data;
      return escapeText(n.data);
    }
    if (n.nodeType === 4) return '<![CDATA[' + n.data + ']]>';
    if (n.nodeType === 8) return '<!--' + n.data + '-->';
    if (n.nodeType === 10) return '<!DOCTYPE ' + n.name + '>';
    if (n.nodeType === 9 || n.nodeType === 11) return serializeChildren(n);
    var tag = n._qname;
    var s = '<' + tag;
    for (var i = 0; i < n._attrs.length; i++) s += ' ' + n._attrs[i].name + '="' + escapeAttr(n._attrs[i]._v) + '"';
    s += '>';
    if (n.namespaceURI === HTML_NS && VOID.test(tag)) return s;
    s += serializeChildren(n.localName === 'template' ? n.content : n);
    return s + '</' + tag + '>';
  }
  function serializeChildren(n) {
    var s = '';
    for (var i = 0; i < n._c.length; i++) s += serialize(n._c[i], false);
    return s;
  }

  class DOMParser {
    parseFromString(text, type) {
      var d = new Document();
      d.contentType = type || 'text/html';
      if (/xml|svg/.test(type || '') && !/html/.test(type || '')) {
        parseInto(String(text), d, d);
        return d;
      }
      var html = d.createElement('html'); d.appendChild(html);
      html.appendChild(d.createElement('head')); html.appendChild(d.createElement('body'));
      parseInto(String(text), d, d);
      for (var i = 0; i < d._c.length; i++) if (d._c[i].nodeType === 3) { d.body.appendChild(d._c[i]); i--; }
      return d;
    }
  }
  class XMLSerializer {
    serializeToString(n) { return serialize(n, false); }
  }

  // ---- selectors -----------------------------------------------------------

  var selectorCache = {};
  function parseSelectorList(text) {
    text = String(text);
    var c = selectorCache[text];
    if (c) return c;
    var list = [];
    var parts = splitComma(text);
    for (var i = 0; i < parts.length; i++) {
      var s = parseComplex(parts[i]);
      if (!s) throw DOMException("Failed to execute 'querySelectorAll' on 'Document': '" + text + "' is not a valid selector.", 'SyntaxError');
      list.push(s);
    }
    selectorCache[text] = list;
    return list;
  }
  // a complex selector: compounds right to left, each with the combinator
  // to the one on its left; spec = [a, b, c]
  function parseComplex(text) {
    var t = text.trim();
    if (!t) return null;
    var comps = [];
    var i = 0, n = t.length;
    var comb = '';
    var pseudoEl = null;
    while (i < n) {
      var ws = false;
      while (i < n && /\s/.test(t.charAt(i))) { i++; ws = true; }
      if (i >= n) break;
      var ch = t.charAt(i);
      if (ch === '>' || ch === '+' || ch === '~') { comb = ch; i++; continue; }
      if (comps.length && !comb && ws) comb = ' ';
      var r = parseCompound(t, i);
      if (!r) return null;
      if (r.pseudoElement) pseudoEl = r.pseudoElement;
      comps.push({ c: r.c, comb: comps.length ? comb || ' ' : '' });
      comb = '';
      i = r.end;
    }
    if (!comps.length) return null;
    var spec = [0, 0, 0];
    for (var k = 0; k < comps.length; k++) addSpec(spec, comps[k].c);
    if (pseudoEl) spec[2]++;
    comps.reverse();
    // comb of comps[k] says how comps[k] relates to comps[k+1] (its left)
    var out = [];
    for (var m = 0; m < comps.length; m++) out.push({ c: comps[m].c, comb: m + 1 < comps.length ? comps[m === 0 ? 0 : m].comb : '' });
    for (var q = 0; q < comps.length; q++) out[q].comb = comps[q].comb;
    return { parts: out, spec: spec, pseudo: pseudoEl, key: keyOf(out[0].c) };
  }
  function addSpec(spec, c) {
    for (var i = 0; i < c.length; i++) {
      var s = c[i];
      if (s.t === 'id') spec[0]++;
      else if (s.t === 'class' || s.t === 'attr') spec[1]++;
      else if (s.t === 'tag') spec[2]++;
      else if (s.t === 'pseudo') {
        if (s.n === 'where') continue;
        if ((s.n === 'not' || s.n === 'is' || s.n === 'has' || s.n === 'matches') && s.list) {
          var best = [0, 0, 0];
          for (var j = 0; j < s.list.length; j++) { var sp = s.list[j].spec; if (cmpSpec(sp, best) > 0) best = sp; }
          spec[0] += best[0]; spec[1] += best[1]; spec[2] += best[2];
        } else if (s.n === 'nth-child' || s.n === 'nth-last-child') {
          spec[1]++;
          if (s.of) { var b2 = [0, 0, 0]; for (var k = 0; k < s.of.length; k++) if (cmpSpec(s.of[k].spec, b2) > 0) b2 = s.of[k].spec; spec[0] += b2[0]; spec[1] += b2[1]; spec[2] += b2[2]; }
        } else spec[1]++;
      }
    }
  }
  function cmpSpec(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }
  function keyOf(c) {
    for (var i = 0; i < c.length; i++) if (c[i].t === 'id') return '#' + c[i].v;
    for (var j = 0; j < c.length; j++) if (c[j].t === 'class') return '.' + c[j].v;
    for (var k = 0; k < c.length; k++) if (c[k].t === 'tag') return c[k].v;
    return '*';
  }
  var IDENT = /^-?(?:[a-zA-Z_\u00a0-\uffff]|\\.)(?:[a-zA-Z0-9_\-\u00a0-\uffff]|\\[0-9a-fA-F]{1,6}\s?|\\.)*/;
  function unescapeIdent(s) {
    return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, function (m, hex, c) { return hex ? String.fromCodePoint(parseInt(hex, 16)) : c; });
  }
  function parseCompound(t, i) {
    var c = [];
    var n = t.length;
    var pseudoElement = null;
    var start = i;
    while (i < n) {
      var ch = t.charAt(i);
      var m;
      if (ch === '*') { i++; continue; }
      if (ch === '#') {
        m = IDENT.exec(t.slice(i + 1)) || /^[a-zA-Z0-9_\-]+/.exec(t.slice(i + 1));
        if (!m) return null;
        c.push({ t: 'id', v: unescapeIdent(m[0]) }); i += 1 + m[0].length; continue;
      }
      if (ch === '.') {
        m = IDENT.exec(t.slice(i + 1));
        if (!m) return null;
        c.push({ t: 'class', v: unescapeIdent(m[0]) }); i += 1 + m[0].length; continue;
      }
      if (ch === '[') {
        var close = findClose(t, i, '[', ']');
        if (close < 0) return null;
        var inner = t.slice(i + 1, close).trim();
        var am = /^([^\s~|^$*!=\]]+)\s*(?:([~|^$*!]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]]+)))?\s*([iIsS])?$/.exec(inner);
        if (!am) return null;
        var val = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : am[5];
        c.push({ t: 'attr', n: unescapeIdent(am[1]).replace(/^\*\|/, '').toLowerCase(), op: am[2] || '', v: val === undefined ? undefined : unescapeIdent(val), i: am[6] === 'i' || am[6] === 'I' });
        i = close + 1; continue;
      }
      if (ch === ':') {
        var dbl = t.charAt(i + 1) === ':';
        var p0 = i + (dbl ? 2 : 1);
        m = /^[a-zA-Z\-]+/.exec(t.slice(p0));
        if (!m) return null;
        var name = m[0].toLowerCase();
        var j = p0 + m[0].length;
        var arg = null;
        if (t.charAt(j) === '(') {
          var cl = findClose(t, j, '(', ')');
          if (cl < 0) return null;
          arg = t.slice(j + 1, cl);
          j = cl + 1;
        }
        if (dbl || /^(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button|-webkit-|-moz-)/.test(name)) {
          pseudoElement = name;
          c.push({ t: 'pseudoel', n: name });
          i = j; continue;
        }
        var s = { t: 'pseudo', n: name };
        if (name === 'not' || name === 'is' || name === 'where' || name === 'matches' || name === '-webkit-any' || name === 'has') {
          var subs = splitComma(arg || '');
          s.list = [];
          for (var k = 0; k < subs.length; k++) {
            var sub = name === 'has' ? parseRelative(subs[k]) : parseComplex(subs[k]);
            if (sub) s.list.push(sub);
          }
          if (name === 'matches' || name === '-webkit-any') s.n = 'is';
        } else if (/^nth-/.test(name)) {
          var ofm = /^(.*?)\s+of\s+(.*)$/.exec(arg || '');
          var ab = parseNth(ofm ? ofm[1] : arg || '');
          if (!ab) return null;
          s.a = ab[0]; s.b = ab[1];
          if (ofm) s.of = parseSelectorList(ofm[2]);
        } else if (arg !== null) {
          s.arg = arg.trim();
        }
        c.push(s);
        i = j; continue;
      }
      m = IDENT.exec(t.slice(i));
      if (m && i === start) {
        var tg = unescapeIdent(m[0]);
        if (t.charAt(i + m[0].length) === '|') { i += m[0].length + 1; continue; }
        c.push({ t: 'tag', v: tg.toLowerCase(), raw: tg }); i += m[0].length; continue;
      }
      if (ch === '|') { i++; continue; }
      break;
    }
    if (i === start) return null;
    return { c: c, end: i, pseudoElement: pseudoElement };
  }
  function parseRelative(text) {
    var t = text.trim();
    var comb = ' ';
    if (/^[>+~]/.test(t)) { comb = t.charAt(0); t = t.slice(1); }
    var s = parseComplex(t);
    if (!s) return null;
    s.rel = comb;
    return s;
  }
  function findClose(t, i, open, close) {
    var depth = 0, q = null;
    for (var k = i; k < t.length; k++) {
      var ch = t.charAt(k);
      if (q) { if (ch === '\\') { k++; continue; } if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '\\') { k++; continue; }
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) return k; }
    }
    return -1;
  }
  function parseNth(s) {
    s = s.replace(/\s+/g, '').toLowerCase();
    if (s === 'odd') return [2, 1];
    if (s === 'even') return [2, 0];
    var m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
    if (m) {
      var a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10);
      return [a, m[2] ? parseInt(m[2], 10) : 0];
    }
    if (/^[+-]?\d+$/.test(s)) return [0, parseInt(s, 10)];
    return null;
  }
  function nthMatch(a, b, pos) {
    if (a === 0) return pos === b;
    var k = (pos - b) / a;
    return k >= 0 && Math.floor(k) === k;
  }

  function matchList(el, list) {
    for (var i = 0; i < list.length; i++) if (!list[i].pseudo && matchComplex(el, list[i], null)) return true;
    return false;
  }
  function matchesSelector(el, s) { return matchList(el, parseSelectorList(s)); }

  function matchComplex(el, sel, scope) {
    return matchFrom(el, sel.parts, 0, scope);
  }
  function matchFrom(el, parts, k, scope) {
    if (!matchCompound(el, parts[k].c, scope)) return false;
    if (k + 1 >= parts.length) return true;
    var comb = parts[k].comb;
    if (comb === '>') { var p = el.parentNode; return !!p && p.nodeType === 1 && matchFrom(p, parts, k + 1, scope); }
    if (comb === ' ') {
      for (var a = el.parentNode; a && a.nodeType === 1; a = a.parentNode) if (matchFrom(a, parts, k + 1, scope)) return true;
      return false;
    }
    if (comb === '+') { var s = siblingElement(el, -1); return !!s && matchFrom(s, parts, k + 1, scope); }
    if (comb === '~') {
      for (var t = siblingElement(el, -1); t; t = siblingElement(t, -1)) if (matchFrom(t, parts, k + 1, scope)) return true;
      return false;
    }
    return false;
  }
  function attrValue(el, name) {
    if (el.namespaceURI !== HTML_NS) {
      for (var i = 0; i < el._attrs.length; i++) if (el._attrs[i].name.toLowerCase() === name) return el._attrs[i]._v;
      return null;
    }
    return el.getAttribute(name);
  }
  function matchCompound(el, c, scope) {
    for (var i = 0; i < c.length; i++) {
      var s = c[i];
      switch (s.t) {
        case 'tag':
          if (el.namespaceURI === HTML_NS ? el.localName !== s.v : el.localName !== s.raw && el.localName.toLowerCase() !== s.v) return false;
          break;
        case 'id':
          if (el.getAttribute('id') !== s.v) return false;
          break;
        case 'class': {
          var cls = el.getAttribute('class');
          if (!cls) return false;
          if (cls === s.v) break;
          if ((' ' + cls.replace(/[\t\n\f\r]/g, ' ') + ' ').indexOf(' ' + s.v + ' ') < 0) return false;
          break;
        }
        case 'attr': {
          var v = attrValue(el, s.n);
          if (v === null) return false;
          if (!s.op) break;
          var want = s.v, have = v;
          if (s.i) { want = want.toLowerCase(); have = have.toLowerCase(); }
          if (s.op === '=' && have !== want) return false;
          if (s.op === '~=' && (!want || (' ' + have.replace(/\s+/g, ' ') + ' ').indexOf(' ' + want + ' ') < 0)) return false;
          if (s.op === '|=' && have !== want && have.indexOf(want + '-') !== 0) return false;
          if (s.op === '^=' && (!want || have.indexOf(want) !== 0)) return false;
          if (s.op === '$=' && (!want || have.slice(-want.length) !== want)) return false;
          if (s.op === '*=' && (!want || have.indexOf(want) < 0)) return false;
          if (s.op === '!=' && have === want) return false;
          break;
        }
        case 'pseudo':
          if (!matchPseudo(el, s, scope)) return false;
          break;
        case 'pseudoel':
          break;
      }
    }
    return true;
  }
  function childIndex(el, fromEnd, ofType, ofList) {
    var p = el.parentNode;
    if (!p) return 1;
    var k = 0;
    var kids = p._c;
    if (fromEnd) {
      for (var i = kids.length - 1; i >= 0; i--) {
        var n = kids[i];
        if (n.nodeType !== 1) continue;
        if (ofType && n.localName !== el.localName) continue;
        if (ofList && !matchList(n, ofList)) continue;
        k++;
        if (n === el) return k;
      }
    } else {
      for (var j = 0; j < kids.length; j++) {
        var m = kids[j];
        if (m.nodeType !== 1) continue;
        if (ofType && m.localName !== el.localName) continue;
        if (ofList && !matchList(m, ofList)) continue;
        k++;
        if (m === el) return k;
      }
    }
    return k;
  }
  function isDisabled(el) {
    if (!/^(button|input|select|textarea|optgroup|option|fieldset)$/.test(el.localName)) return false;
    if (el.hasAttribute('disabled')) return true;
    for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'fieldset' && n.hasAttribute('disabled')) return true;
    return false;
  }
  function matchPseudo(el, s, scope) {
    switch (s.n) {
      case 'not': for (var i = 0; i < s.list.length; i++) if (matchComplex(el, s.list[i], scope)) return false; return true;
      case 'is': case 'where': for (var j = 0; j < s.list.length; j++) if (matchComplex(el, s.list[j], scope)) return true; return false;
      case 'has':
        for (var h = 0; h < s.list.length; h++) {
          var rel = s.list[h], found = false;
          if (rel.rel === '+' || rel.rel === '~') {
            for (var sb = siblingElement(el, 1); sb && !found; sb = rel.rel === '~' ? siblingElement(sb, 1) : null) if (matchComplex(sb, rel, el)) found = true;
          } else {
            eachElement(el, function (d) {
              if ((rel.rel !== '>' || d.parentNode === el) && matchComplex(d, rel, el)) { found = true; return true; }
            });
          }
          if (found) return true;
        }
        return false;
      case 'root': return !!el.parentNode && el.parentNode.nodeType === 9;
      case 'scope': return scope ? el === scope : !!el.parentNode && el.parentNode.nodeType === 9;
      case 'empty': for (var e = 0; e < el._c.length; e++) { var c = el._c[e]; if (c.nodeType === 1 || ((c.nodeType === 3 || c.nodeType === 4) && c.data.length)) return false; } return true;
      case 'first-child': return childIndex(el, false) === 1;
      case 'last-child': return childIndex(el, true) === 1;
      case 'only-child': return childIndex(el, false) === 1 && childIndex(el, true) === 1;
      case 'first-of-type': return childIndex(el, false, true) === 1;
      case 'last-of-type': return childIndex(el, true, true) === 1;
      case 'only-of-type': return childIndex(el, false, true) === 1 && childIndex(el, true, true) === 1;
      case 'nth-child': if (s.of && !matchList(el, s.of)) return false; return nthMatch(s.a, s.b, childIndex(el, false, false, s.of));
      case 'nth-last-child': if (s.of && !matchList(el, s.of)) return false; return nthMatch(s.a, s.b, childIndex(el, true, false, s.of));
      case 'nth-of-type': return nthMatch(s.a, s.b, childIndex(el, false, true));
      case 'nth-last-of-type': return nthMatch(s.a, s.b, childIndex(el, true, true));
      case 'checked': return (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio') && el.checked) || (el.localName === 'option' && el.selected);
      case 'indeterminate': return el.localName === 'input' && !!el.indeterminate;
      case 'disabled': return isDisabled(el);
      case 'enabled': return /^(button|input|select|textarea|optgroup|option|fieldset)$/.test(el.localName) && !isDisabled(el);
      case 'read-only': return !matchPseudo(el, { n: 'read-write' }, scope);
      case 'read-write': return (/^(input|textarea)$/.test(el.localName) && !el.hasAttribute('readonly') && !isDisabled(el)) || el.isContentEditable;
      case 'required': return /^(input|select|textarea)$/.test(el.localName) && el.hasAttribute('required');
      case 'optional': return /^(input|select|textarea)$/.test(el.localName) && !el.hasAttribute('required');
      case 'placeholder-shown': return /^(input|textarea)$/.test(el.localName) && el.hasAttribute('placeholder') && !el.value;
      case 'link': case 'any-link': return /^(a|area)$/.test(el.localName) && el.hasAttribute('href');
      case 'visited': return false;
      case 'target': return false;
      case 'defined': return true;
      case 'focus': return !!doc && doc._active === el;
      case 'focus-visible': return !!doc && doc._active === el && doc._focusVisible !== false;
      case 'focus-within': return !!doc && !!doc._active && el.contains(doc._active);
      case 'hover': return !!hoverEl && el.contains(hoverEl);
      case 'active': return !!activeEl && el.contains(activeEl);
      case 'valid': return /^(input|select|textarea|form|fieldset)$/.test(el.localName);
      case 'invalid': case 'user-invalid': return false;
      case 'in-range': case 'out-of-range': return false;
      case 'lang': { for (var l = el; l && l.nodeType === 1; l = l.parentNode) { var lg = l.getAttribute('lang'); if (lg !== null) return lg.toLowerCase().indexOf(String(s.arg).toLowerCase()) === 0; } return false; }
      case 'dir': return String(s.arg) === 'ltr';
      case 'open': return el.hasAttribute('open');
      case 'modal': return false;
      case 'popover-open': return false;
      case 'fullscreen': return false;
      case 'autofill': case '-webkit-autofill': return false;
      case 'host': return false;
      default: return false;
    }
  }

  function querySelectorAll(root, s, firstOnly) {
    var list = parseSelectorList(s);
    var out = [];
    var scope = root.nodeType === 1 ? root : null;
    eachElement(root, function (el) {
      for (var i = 0; i < list.length; i++) {
        if (!list[i].pseudo && matchComplex(el, list[i], scope)) { out.push(el); return firstOnly ? true : undefined; }
      }
    });
    return out;
  }

  var hoverEl = null;
  var activeEl = null;

  // ---- CSS: style sheets ---------------------------------------------------

  // a rule: {sel: complex selector, decls: [{name, value, important}],
  // order, media: condition text or ''}
  var sheets = [];
  var sheetOrder = 0;

  function stripComments(css) {
    if (css.indexOf('/*') < 0) return css;
    // copied in pieces: a string grown a character at a time is copied
    // again for every character
    var out = [], i = 0, from = 0, n = css.length, q = null;
    while (i < n) {
      var ch = css.charAt(i);
      if (q) { if (ch === '\\') { i += 2; continue; } if (ch === q) q = null; i++; continue; }
      if (ch === '"' || ch === "'") { q = ch; i++; continue; }
      if (ch === '/' && css.charAt(i + 1) === '*') {
        out.push(css.slice(from, i));
        var e = css.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
        from = i;
        continue;
      }
      i++;
    }
    out.push(css.slice(from));
    return out.join('');
  }
  function parseDeclarations(text) {
    var out = [];
    var parts = [], depth = 0, cur = '', q = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (q) { cur += ch; if (ch === '\\') { cur += text.charAt(i + 1); i++; } else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === ';' && depth <= 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      var c = p.indexOf(':');
      if (c < 0) continue;
      var name = p.slice(0, c).trim();
      var value = p.slice(c + 1).trim();
      if (!name) continue;
      if (name.slice(0, 2) !== '--') name = name.toLowerCase();
      var important = false;
      var im = /\s*!\s*important\s*$/i.exec(value);
      if (im) { important = true; value = value.slice(0, im.index).trim(); }
      if (value === '' && name.slice(0, 2) !== '--') continue;
      if (!sizeValueOk(name, value) || (name === 'display' && !displayOk(value))) continue;
      out.push({ name: name, value: value, important: important });
    }
    return out;
  }
  // a size property with a keyword it does not know is an invalid
  // declaration, which is dropped (`width: max-width`)
  var SIZE_PROPS = /^(min-|max-)?(width|height|inline-size|block-size)$/;
  var SIZE_KW = /^(auto|none|min-content|max-content|fit-content|stretch|-webkit-fill-available|-moz-available|-webkit-min-content|-webkit-max-content|-webkit-fit-content|-moz-min-content|-moz-max-content|-moz-fit-content|inherit|initial|unset|revert|revert-layer)$/i;
  function sizeValueOk(name, value) {
    if (!SIZE_PROPS.test(name) || !/^-?[a-z][a-z-]*$/i.test(value)) return true;
    if (!SIZE_KW.test(value)) return false;
    return value.toLowerCase() !== 'none' || name.slice(0, 4) === 'max-';
  }

  // a display value the layout does not know (grid-lanes, as the
  // browsers do not either yet) is an invalid declaration
  var DISPLAY_KW = /^(none|contents|block|inline|inline-block|flow-root|list-item|flex|inline-flex|grid|inline-grid|table|inline-table|table-row-group|table-header-group|table-footer-group|table-row|table-cell|table-column-group|table-column|table-caption|ruby|ruby-base|ruby-text|ruby-base-container|ruby-text-container|run-in|math|inline-math|-webkit-box|-webkit-inline-box|inherit|initial|unset|revert|revert-layer)$/i;
  function displayOk(value) {
    if (/var\(/.test(value)) return true;
    var ws = value.trim().split(/\s+/);
    if (ws.length === 1) return DISPLAY_KW.test(ws[0]);
    return ws.every(function (w) { return /^(block|inline|run-in|flow|flow-root|flex|grid|table|ruby|math|list-item)$/i.test(w); });
  }

  class CSSRule {
    constructor(type, text) { this.type = type; this._text = text; this.parentStyleSheet = null; this.parentRule = null; }
    get cssText() { return this._text; }
  }
  CSSRule.STYLE_RULE = 1; CSSRule.MEDIA_RULE = 4; CSSRule.FONT_FACE_RULE = 5; CSSRule.KEYFRAMES_RULE = 7; CSSRule.SUPPORTS_RULE = 12;
  class CSSStyleRule extends CSSRule {
    constructor(selectorText, decls) {
      super(1, '');
      this.selectorText = selectorText;
      var st = new CSSStyleDeclaration(null);
      for (var i = 0; i < decls.length; i++) st._set(decls[i].name, decls[i].value, decls[i].important ? 'important' : '');
      this.style = styleProxy(st);
      this._decls = decls;
    }
    get cssText() { return this.selectorText + ' { ' + this.style.cssText + ' }'; }
  }
  class CSSMediaRule extends CSSRule {
    constructor(cond, rules) { super(4, ''); this.conditionText = cond; this.media = { mediaText: cond, length: 1 }; this.cssRules = rules; }
  }
  class CSSStyleSheet {
    constructor(owner) { this.ownerNode = owner || null; this.cssRules = []; this.disabled = false; this.href = null; this.type = 'text/css'; this.title = null; this.media = { mediaText: '', length: 0 }; this._rules = []; this._order = sheetOrder++; }
    get rules() { return this.cssRules; }
    insertRule(text, index) {
      index = index === undefined ? 0 : index;
      var tmp = parseSheetText(String(text), this);
      if (!tmp.cssRules.length && !/^\s*@/.test(text)) throw DOMException("Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '" + text + "'.", 'SyntaxError');
      Array.prototype.splice.apply(this.cssRules, [index, 0].concat(tmp.cssRules));
      this._rebuild();
      return index;
    }
    deleteRule(index) { this.cssRules.splice(index, 1); this._rebuild(); }
    addRule(sel, body, index) { return this.insertRule(sel + '{' + body + '}', index === undefined ? this.cssRules.length : index); }
    removeRule(i) { this.deleteRule(i); }
    replaceSync(text) { var tmp = parseSheetText(String(text), this); this.cssRules = tmp.cssRules; this._rebuild(); }
    replace(text) { this.replaceSync(text); return Promise.resolve(this); }
    _rebuild() {
      this._rules = [];
      var self = this;
      (function add(rules, media) {
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          if (r.type === 1) {
            var list;
            try { list = parseSelectorList(r.selectorText); } catch (e) { continue; }
            for (var k = 0; k < list.length; k++) self._rules.push({ sel: list[k], decls: r._decls, media: media, text: r.selectorText });
          } else if (r.type === 4) add(r.cssRules, media ? media + ' and ' + r.conditionText : r.conditionText);
          else if (r.type === 12 && r._ok) add(r.cssRules, media);
          else if (r._layer) add(r.cssRules, media);
        }
      })(this.cssRules, '');
      indexSheet(this);
      changed();
    }
  }

  function parseSheetText(css, sheet) {
    var out = { cssRules: [] };
    var text = stripComments(css);
    parseRulesInto(text, out.cssRules, sheet);
    return out;
  }
  function parseRulesInto(text, rules, sheet) {
    var i = 0, n = text.length;
    while (i < n) {
      while (i < n && /\s/.test(text.charAt(i))) i++;
      if (i >= n) break;
      if (text.charAt(i) === '}') { i++; continue; }
      // the prelude up to { or ;
      var j = i, q = null, depth = 0;
      while (j < n) {
        var ch = text.charAt(j);
        if (q) { if (ch === '\\') j++; else if (ch === q) q = null; j++; continue; }
        if (ch === '"' || ch === "'") { q = ch; j++; continue; }
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (depth === 0 && (ch === '{' || ch === ';')) break;
        j++;
      }
      var prelude = text.slice(i, j).trim();
      if (j >= n) break;
      if (text.charAt(j) === ';') { i = j + 1; continue; }
      var close = findClose(text, j, '{', '}');
      if (close < 0) close = n;
      var body = text.slice(j + 1, close);
      i = close + 1;
      if (prelude.charAt(0) === '@') {
        var am = /^@([a-zA-Z\-]+)\s*([\s\S]*)$/.exec(prelude);
        var at = am ? am[1].toLowerCase() : '';
        var cond = am ? am[2].trim() : '';
        if (at === 'media') {
          var sub = [];
          parseRulesInto(body, sub, sheet);
          var mr = new CSSMediaRule(cond, sub);
          mr.parentStyleSheet = sheet;
          rules.push(mr);
        } else if (at === 'supports') {
          var sub2 = [];
          parseRulesInto(body, sub2, sheet);
          var sr = new CSSRule(12, '');
          sr.cssRules = sub2; sr.conditionText = cond; sr._ok = supportsCondition(cond);
          rules.push(sr);
        } else if (at === 'layer' || at === 'container' || at === 'scope' || at === 'document' || at === '-moz-document') {
          var sub3 = [];
          parseRulesInto(body, sub3, sheet);
          var lr = new CSSRule(at === 'layer' ? 18 : 0, '');
          lr.cssRules = sub3; lr._layer = at === 'layer' || at === 'scope';
          rules.push(lr);
        } else {
          var other = new CSSRule(at === 'font-face' ? 5 : at === 'keyframes' || at === '-webkit-keyframes' ? 7 : 0, prelude + '{' + body + '}');
          other.name = cond;
          rules.push(other);
        }
        continue;
      }
      // nested rules (CSS nesting) are flattened: `&` is the parent
      var decls = [];
      var nested = [];
      splitNested(body, decls, nested);
      var r = new CSSStyleRule(prelude, parseDeclarations(decls.join(';')));
      r.parentStyleSheet = sheet;
      rules.push(r);
      for (var k = 0; k < nested.length; k++) {
        var np = nested[k].prelude;
        var selText = splitComma(np).map(function (s) {
          return splitComma(prelude).map(function (p) { return s.indexOf('&') >= 0 ? s.replace(/&/g, p) : p + ' ' + s; }).join(', ');
        }).join(', ');
        if (np.charAt(0) === '@') { var sub4 = []; parseRulesInto(prelude + '{' + nested[k].body + '}', sub4, sheet); var mr2 = new CSSMediaRule(np.replace(/^@media\s*/i, ''), sub4); rules.push(mr2); continue; }
        parseRulesInto(selText + '{' + nested[k].body + '}', rules, sheet);
      }
    }
  }
  function splitNested(body, decls, nested) {
    var i = 0, n = body.length, start = 0, q = null, depth = 0;
    while (i < n) {
      var ch = body.charAt(i);
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; i++; continue; }
      if (ch === '"' || ch === "'") { q = ch; i++; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0 && ch === ';') { decls.push(body.slice(start, i)); start = i + 1; }
      if (depth === 0 && ch === '{') {
        var close = findClose(body, i, '{', '}');
        if (close < 0) close = n;
        var pre = body.slice(start, i).trim();
        // `--x: { ... }` is a value, not a rule
        if (/^--[\w-]+\s*:/.test(pre)) { i = close + 1; continue; }
        nested.push({ prelude: pre, body: body.slice(i + 1, close) });
        i = close + 1; start = i; continue;
      }
      i++;
    }
    if (start < n) decls.push(body.slice(start));
  }
  function supportsCondition(c) {
    c = c.trim();
    if (/^not\s/i.test(c)) return !supportsCondition(c.slice(4));
    if (/^selector\(/i.test(c)) return true;
    var m = /^\(\s*([a-zA-Z\-]+)\s*:\s*(.*)\)$/.exec(c);
    if (m) return !/^(-webkit-|-moz-|-ms-)/.test(m[1]) || m[1] === '-webkit-backdrop-filter';
    return true;
  }

  // rules by the key of their rightmost compound (id, class, tag or *)
  function indexSheet(sheet) {
    var idx = {};
    for (var i = 0; i < sheet._rules.length; i++) {
      var r = sheet._rules[i];
      r.order = i;
      var k = r.sel.key;
      (idx[k] || (idx[k] = [])).push(r);
      if (r.sel.pseudo === 'before' || r.sel.pseudo === 'after' || r.sel.pseudo === 'first-letter' || r.sel.pseudo === 'first-line') sheet._pseudo = true;
    }
    sheet._index = idx;
  }

  function sheetOfStyle(el) {
    if (el._sheet && el._sheetText === el.textContent) return el._sheet;
    var s = el._sheet || new CSSStyleSheet(el);
    s.cssRules = parseSheetText(el.textContent, s).cssRules;
    s._rebuild();
    el._sheet = s;
    el._sheetText = el.textContent;
    return s;
  }
  var linkSheets = [];
  // the document's <style> and <link> sheets for the cascade, found once per
  // style change (styleGen) rather than by a walk of the page per element
  var sheetsCache = { gen: -1, d: null, list: null };
  function cascadeSheets(d) {
    if (sheetsCache.gen !== styleGen || sheetsCache.d !== d) {
      // without the adopted sheets: assigning the list is no change
      var all = styleSheetsOf(d);
      sheetsCache = { gen: styleGen, d: d, list: all.slice(0, all.length - (d.adoptedStyleSheets || []).length) };
    }
    return sheetsCache.list.concat(d.adoptedStyleSheets || []);
  }
  function styleSheetsOf(d) {
    var out = [];
    eachElement(d, function (e) {
      if (e.localName === 'style' && e.namespaceURI === HTML_NS) out.push(sheetOfStyle(e));
      else if (e.localName === 'link') { for (var i = 0; i < linkSheets.length; i++) if (linkSheets[i].ownerNode === e) out.push(linkSheets[i]); }
    });
    for (var j = 0; j < linkSheets.length; j++) if (!linkSheets[j].ownerNode || !linkSheets[j].ownerNode.isConnected) { if (!linkSheets[j].ownerNode) out.push(linkSheets[j]); }
    var adopted = d.adoptedStyleSheets || [];
    for (var k = 0; k < adopted.length; k++) out.push(adopted[k]);
    out.item = function (i) { return this[i] || null; };
    return out;
  }

  // ---- CSS: media queries --------------------------------------------------

  var mediaCache = {};
  function mediaMatches(q) {
    if (!q) return true;
    var key = q + '|' + viewport.w + 'x' + viewport.h;
    if (mediaCache[key] !== undefined) return mediaCache[key];
    var r = evalMedia(q);
    mediaCache[key] = r;
    return r;
  }
  function evalMedia(q) {
    q = q.trim().toLowerCase();
    if (!q || q === 'all' || q === 'screen') return true;
    var alts = splitComma(q);
    if (alts.length > 1) { for (var i = 0; i < alts.length; i++) if (evalMedia(alts[i])) return true; return false; }
    var neg = false;
    if (/^not\s+/.test(q)) { neg = true; q = q.replace(/^not\s+/, ''); }
    q = q.replace(/^only\s+/, '');
    var parts = q.split(/\s+and\s+/);
    var ok = true;
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k].trim();
      if (p === 'screen' || p === 'all') continue;
      if (p === 'print' || p === 'speech') { ok = false; break; }
      var m = /^\(\s*([a-z\-]+)\s*(?::\s*([^)]+))?\)$/.exec(p);
      if (!m) {
        // range syntax: (width >= 640px), (640px <= width <= 1024px)
        var rm = /^\(\s*([a-z\-]+)\s*(<=|>=|<|>|=)\s*([^)]+)\)$/.exec(p);
        if (rm) { if (!rangeFeature(rm[1], rm[2], rm[3])) { ok = false; break; } continue; }
        var rm2 = /^\(\s*([^<>=]+?)\s*(<=|<)\s*([a-z\-]+)\s*(<=|<)\s*([^)]+)\)$/.exec(p);
        if (rm2) { if (!rangeFeature(rm2[3], rm2[2] === '<=' ? '>=' : '>', rm2[1]) || !rangeFeature(rm2[3], rm2[4], rm2[5])) { ok = false; break; } continue; }
        ok = false; break;
      }
      if (!mediaFeature(m[1], m[2] ? m[2].trim() : null)) { ok = false; break; }
    }
    return neg ? !ok : ok;
  }
  function mediaPx(v) {
    v = v.trim();
    var n = parseFloat(v);
    if (/em$/.test(v)) return n * 16;
    return n;
  }
  function rangeFeature(f, op, v) {
    var have = f === 'width' ? viewport.w : f === 'height' ? viewport.h : f === 'aspect-ratio' ? viewport.w / viewport.h : NaN;
    var want = f === 'aspect-ratio' ? (function () { var r = v.split('/'); return parseFloat(r[0]) / parseFloat(r[1] || '1'); })() : mediaPx(v);
    if (op === '>=') return have >= want;
    if (op === '>') return have > want;
    if (op === '<=') return have <= want;
    if (op === '<') return have < want;
    return have === want;
  }
  function mediaFeature(f, v) {
    switch (f) {
      case 'min-width': return viewport.w >= mediaPx(v);
      case 'max-width': return viewport.w <= mediaPx(v);
      case 'min-height': return viewport.h >= mediaPx(v);
      case 'max-height': return viewport.h <= mediaPx(v);
      case 'width': return v === null || viewport.w === mediaPx(v);
      case 'height': return v === null || viewport.h === mediaPx(v);
      case 'orientation': return v === (viewport.w >= viewport.h ? 'landscape' : 'portrait');
      case 'prefers-color-scheme': return v === 'light';
      case 'prefers-reduced-motion': return v === 'reduce';
      case 'prefers-contrast': return v === 'no-preference';
      case 'prefers-reduced-transparency': return v === 'no-preference';
      case 'forced-colors': return v === 'none';
      case 'hover': return v === null || v === 'hover';
      case 'any-hover': return v === null || v === 'hover';
      case 'pointer': case 'any-pointer': return v === null || v === 'fine';
      case 'color': return true;
      case 'min-resolution': case 'resolution': case 'max-resolution': return f !== 'min-resolution' || parseFloat(v) <= 1;
      case '-webkit-min-device-pixel-ratio': case 'min-device-pixel-ratio': return parseFloat(v) <= 1;
      case 'display-mode': return v === 'browser';
      case 'scripting': return v === 'enabled';
      case 'update': return v === 'fast';
      default: return false;
    }
  }

  class MediaQueryList extends EventTarget {
    constructor(q) { super(); this.media = q; this._last = mediaMatches(q); mediaLists.push(this); this.onchange = null; }
    get matches() { return evalMedia(this.media); }
    addListener(fn) { this.addEventListener('change', fn); }
    removeListener(fn) { this.removeEventListener('change', fn); }
  }
  var mediaLists = [];
  function mediaChanged() {
    for (var i = 0; i < mediaLists.length; i++) {
      var m = mediaLists[i], now2 = evalMedia(m.media);
      if (now2 !== m._last) {
        m._last = now2;
        var ev = new Event('change');
        ev.matches = now2; ev.media = m.media;
        dispatch(m, ev);
      }
    }
  }

  // ---- CSS: the cascade ----------------------------------------------------

  var INHERITED = {
    'color': 1, 'font-family': 1, 'font-size': 1, 'font-weight': 1, 'font-style': 1, 'font-variant': 1, 'font-stretch': 1,
    'line-height': 1, 'letter-spacing': 1, 'word-spacing': 1, 'text-align': 1, 'text-indent': 1, 'text-transform': 1,
    'white-space': 1, 'word-break': 1, 'overflow-wrap': 1, 'word-wrap': 1, 'hyphens': 1, 'visibility': 1, 'cursor': 1,
    'direction': 1, 'list-style-type': 1, 'list-style-position': 1, 'list-style-image': 1, 'quotes': 1, 'tab-size': 1,
    'text-shadow': 1, 'caret-color': 1, 'pointer-events': 1, 'user-select': 1, '-webkit-user-select': 1, 'border-collapse': 1,
    'border-spacing': 1, 'empty-cells': 1, 'caption-side': 1, 'writing-mode': 1, 'text-orientation': 1, 'text-rendering': 1, '-webkit-font-smoothing': 1,
    'font-feature-settings': 1, 'font-variation-settings': 1, 'color-scheme': 1, 'accent-color': 1, 'text-decoration-skip-ink': 1,
    'line-break': 1, 'text-wrap': 1, '-webkit-text-fill-color': 1, 'paint-order': 1, 'fill': 1, 'stroke': 1, 'stroke-width': 1, 'fill-rule': 1
  };
  var INITIAL = {
    'display': 'inline', 'position': 'static', 'color': 'rgb(0, 0, 0)', 'font-size': '16px', 'font-weight': '400',
    'font-style': 'normal', 'font-family': 'Times New Roman', 'line-height': 'normal', 'visibility': 'visible',
    'opacity': '1', 'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'z-index': 'auto',
    'overflow-x': 'visible', 'overflow-y': 'visible', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'flex-grow': '0',
    'flex-shrink': '1', 'flex-basis': 'auto', 'justify-content': 'normal', 'align-items': 'normal', 'align-self': 'auto',
    'align-content': 'normal', 'width': 'auto', 'height': 'auto', 'min-width': 'auto', 'min-height': 'auto',
    'max-width': 'none', 'max-height': 'none', 'top': 'auto', 'right': 'auto', 'bottom': 'auto', 'left': 'auto',
    'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
    'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
    'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
    'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none',
    'border-top-color': 'currentcolor', 'border-right-color': 'currentcolor', 'border-bottom-color': 'currentcolor', 'border-left-color': 'currentcolor',
    'border-top-left-radius': '0px', 'border-top-right-radius': '0px', 'border-bottom-right-radius': '0px', 'border-bottom-left-radius': '0px',
    'text-align': 'start', 'white-space': 'normal', 'cursor': 'auto', 'pointer-events': 'auto', 'box-sizing': 'content-box',
    'transform': 'none', 'box-shadow': 'none', 'text-decoration-line': 'none', 'row-gap': 'normal', 'column-gap': 'normal',
    'letter-spacing': 'normal', 'text-transform': 'none', 'float': 'none', 'clear': 'none', 'transition-duration': '0s',
    'animation-name': 'none', 'list-style-type': 'disc', 'vertical-align': 'baseline', 'outline-style': 'none', 'outline-width': '0px',
    'text-overflow': 'clip', 'word-break': 'normal', 'overflow-wrap': 'normal', 'grid-template-columns': 'none', 'grid-template-rows': 'none',
    'direction': 'ltr', 'object-fit': 'fill', 'user-select': 'auto', 'filter': 'none', 'backdrop-filter': 'none', 'content': 'normal',
    'fill': 'rgb(0, 0, 0)', 'stroke': 'none', 'inset': 'auto', 'stop-color': 'rgb(0, 0, 0)', 'stop-opacity': '1'
  };

  // the user agent's sheet: display and the few looks a page relies on
  var UA_CSS = [
    'html,address,blockquote,body,dd,div,dl,dt,fieldset,form,frame,frameset,h1,h2,h3,h4,h5,h6,noframes,ol,p,ul,center,dir,hr,menu,pre,article,aside,footer,header,hgroup,main,nav,section,search,figure,figcaption,details,summary,legend,dialog,optgroup{display:block}',
    'head,script,style,link,meta,title,template,noscript,datalist,param,base,[hidden]:not([hidden=until-found]),area,map{display:none}',
    'li{display:list-item}table{display:table;border-collapse:separate;border-spacing:2px}tr{display:table-row}thead{display:table-header-group}tbody{display:table-row-group}tfoot{display:table-footer-group}td,th{display:table-cell;padding:1px}th{font-weight:700;text-align:center}caption{display:table-caption;text-align:center}col{display:table-column}colgroup{display:table-column-group}',
    'body{margin:8px}p,blockquote,figure,dl,pre{margin-top:1em;margin-bottom:1em}ul,ol,menu{margin-top:1em;margin-bottom:1em;padding-left:40px}ol{list-style-type:decimal}ul ul,ol ul,ul ol,ol ol{margin-top:0;margin-bottom:0}dd{margin-left:40px}blockquote,figure{margin-left:40px;margin-right:40px}',
    'h1{font-size:2em;margin-top:.67em;margin-bottom:.67em;font-weight:700}h2{font-size:1.5em;margin-top:.83em;margin-bottom:.83em;font-weight:700}h3{font-size:1.17em;margin-top:1em;margin-bottom:1em;font-weight:700}h4{margin-top:1.33em;margin-bottom:1.33em;font-weight:700}h5{font-size:.83em;margin-top:1.67em;margin-bottom:1.67em;font-weight:700}h6{font-size:.67em;margin-top:2.33em;margin-bottom:2.33em;font-weight:700}',
    'b,strong{font-weight:700}i,em,cite,var,dfn,address{font-style:italic}u,ins{text-decoration:underline}s,del,strike{text-decoration:line-through}small{font-size:smaller}sub{vertical-align:sub;font-size:smaller}sup{vertical-align:super;font-size:smaller}code,kbd,samp,pre,tt{font-family:monospace}pre{white-space:pre}',
    'a:any-link{color:rgb(0,0,238);text-decoration:underline;cursor:pointer}hr{border-top:1px inset rgb(128,128,128);margin-top:.5em;margin-bottom:.5em}',
    'input,select,textarea,button{display:inline-block;font-size:13.333px;font-family:Arial;letter-spacing:normal;word-spacing:normal;line-height:normal;text-transform:none;text-indent:0;text-shadow:none;text-align:start;color:rgb(0,0,0)}',
    'input,textarea,select{background-color:rgb(255,255,255);border:2px inset rgb(118,118,118)}input{padding:1px 2px}textarea{padding:2px;white-space:pre-wrap}button,input[type=button],input[type=submit],input[type=reset]{padding:1px 6px;border:2px outset rgb(118,118,118);background-color:rgb(239,239,239);text-align:center;cursor:default}input[type=hidden]{display:none}input[type=checkbox]{margin:3px 3px 3px 4px}input[type=radio]{margin:3px 3px 0 5px}button:disabled,input[type=button]:disabled,input[type=submit]:disabled,input[type=reset]:disabled{color:rgba(16,16,16,0.3);border-color:rgba(118,118,118,0.3);background-color:rgba(239,239,239,0.3)}button,select,input[type=button],input[type=submit],input[type=reset],input[type=color],input[type=checkbox],input[type=radio]{box-sizing:border-box}',
    'img,svg,video,canvas,iframe,embed,object{display:inline-block}iframe{border:2px inset rgb(118,118,118)}fieldset{margin-left:2px;margin-right:2px;padding:.35em .75em .625em;border:2px groove rgb(192,192,192)}legend{padding-left:2px;padding-right:2px}',
    'dialog:not([open]){display:none}dialog{position:absolute;left:0;right:0;margin:auto;border:solid;padding:1em;background-color:white;color:black}mark{background-color:yellow;color:black}center{text-align:center}'
  ].join('\n');
  var uaSheet = null;
  function ua() {
    if (!uaSheet) { uaSheet = new CSSStyleSheet(null); uaSheet._ua = true; uaSheet.cssRules = parseSheetText(UA_CSS, uaSheet).cssRules; uaSheet._rebuild(); }
    return uaSheet;
  }

  function candidates(sheet, el, out) {
    var idx = sheet._index;
    if (!idx) return;
    function take(k) { var l = idx[k]; if (l) for (var i = 0; i < l.length; i++) out.push(l[i]); }
    var id = el.getAttribute('id');
    if (id) take('#' + id);
    var cls = el.getAttribute('class');
    if (cls) {
      var cl = cls.split(/[ \t\n\f\r]+/);
      for (var i = 0; i < cl.length; i++) if (cl[i]) take('.' + cl[i]);
    }
    take(el.localName);
    if (el.namespaceURI !== HTML_NS && el.localName !== el.localName.toLowerCase()) take(el.localName.toLowerCase());
    take('*');
  }

  // the cascaded declarations of an element: {name: value} after
  // origin, importance, specificity and order
  // (pe: the declarations of its ::before or ::after box instead)
  function cascade(el, pe) {
    var d = el.ownerDocument || doc;
    var list = [ua()].concat(d === doc ? cascadeSheets(d).filter(function (s) { return !s.disabled; }) : []);
    var hits = [];
    for (var s = 0; s < list.length; s++) {
      var sheet = list[s];
      if (pe && !sheet._pseudo) continue;
      var cand = [];
      candidates(sheet, el, cand);
      for (var i = 0; i < cand.length; i++) {
        var r = cand[i];
        if (pe ? r.sel.pseudo !== pe : r.sel.pseudo) continue;
        if (r.media && !mediaMatches(r.media)) continue;
        if (!matchComplex(el, r.sel, null)) continue;
        hits.push({ r: r, sheet: s, ua: !!sheet._ua });
      }
    }
    hits.sort(function (a, b) { return (a.ua === b.ua ? 0 : a.ua ? -1 : 1) || cmpSpec(a.r.sel.spec, b.r.sel.spec) || a.sheet - b.sheet || a.r.order - b.r.order; });
    // (seq: when each key was last set, for computeStyle to tell a logical
    // longhand and the physical property it maps to apart, the later winning)
    var out = {}, imp = {}, seq = {}, nseq = 0;
    Object.defineProperty(out, '_seq', { value: seq, enumerable: false });
    function put(name, value, important, uaOrigin) {
      if (imp[name] && !important) return;
      var lh = expandShorthand(name, value);
      if (lh) { for (var k in lh) { if (imp[k] && !important) continue; out[k] = lh[k]; seq[k] = ++nseq; if (important) imp[k] = uaOrigin ? 1 : 2; } if (name in out && lh[name] === undefined) delete out[name]; return; }
      out[name] = value;
      seq[name] = ++nseq;
      if (important) imp[name] = uaOrigin ? 1 : 2;
    }
    for (var h = 0; h < hits.length; h++) {
      var decls = hits[h].r.decls;
      for (var j = 0; j < decls.length; j++) put(decls[j].name, decls[j].value, decls[j].important && false, hits[h].ua);
    }
    if (pe) return hits.length ? out : null;
    // inline style
    if (el._style || el.hasAttribute('style')) {
      var st = el._style;
      if (!st) { el.style; st = el._style; }
      for (var q = 0; q < st._order.length; q++) { var nm = st._order[q]; if (!imp[nm]) { out[nm] = st._p[nm]; seq[nm] = ++nseq; } }
    }
    // !important: author important over inline over normal
    for (var h2 = 0; h2 < hits.length; h2++) {
      var ds = hits[h2].r.decls;
      for (var j2 = 0; j2 < ds.length; j2++) if (ds[j2].important) put(ds[j2].name, ds[j2].value, true, hits[h2].ua);
    }
    if (el._style) {
      var st2 = el._style;
      for (var q2 = 0; q2 < st2._order.length; q2++) { var n2 = st2._order[q2]; if (st2._prio[n2]) { out[n2] = st2._p[n2]; seq[n2] = ++nseq; } }
    }
    presentationalHints(el, out);
    return out;
  }
  function presentationalHints(el, out) {
    if (el.namespaceURI === SVG_NS) {
      var pres = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'display', 'visibility', 'transform', 'fill-rule', 'stroke-linecap', 'stroke-linejoin', 'stop-color', 'stop-opacity'];
      for (var i = 0; i < pres.length; i++) { var v = el.getAttribute(pres[i]); if (v !== null && out[pres[i]] === undefined) out[pres[i]] = v; }
      if (el.localName === 'svg') {
        var w = el.getAttribute('width'), h = el.getAttribute('height');
        if (w !== null && out.width === undefined) out.width = /^[\d.]+$/.test(w) ? w + 'px' : w;
        if (h !== null && out.height === undefined) out.height = /^[\d.]+$/.test(h) ? h + 'px' : h;
      }
      return;
    }
    var l = el.localName;
    // (a canvas's width and height are its bitmap's, not presentational)
    if (l === 'img' || l === 'video' || l === 'iframe' || l === 'td' || l === 'th' || l === 'table') {
      var aw = el.getAttribute('width'), ah = el.getAttribute('height');
      if (aw !== null && out.width === undefined) out.width = /^[\d.]+$/.test(aw) ? aw + 'px' : aw;
      if (ah !== null && out.height === undefined) out.height = /^[\d.]+$/.test(ah) ? ah + 'px' : ah;
    }
    var al = el.getAttribute('align');
    if (al && out['text-align'] === undefined && /^(div|p|h[1-6]|td|th|tr)$/.test(l)) out['text-align'] = al;
    var bg = el.getAttribute('bgcolor');
    if (bg && out['background-color'] === undefined) out['background-color'] = bg;
    // <br clear>: all and both clear both sides
    if (l === 'br' && out.clear === undefined) {
      var cl = (el.getAttribute('clear') || '').toLowerCase();
      if (cl === 'all' || cl === 'both') out.clear = 'both';
      else if (cl === 'left' || cl === 'right') out.clear = cl;
    }
  }

  // computed styles: cached per element until a style can change
  // (styleGen; an attribute drops only the elements it reaches, attrChanged)
  var computedCache = { gen: 0, map: {} };
  function computedOf(el) {
    if (computedCache.gen !== styleGen) { computedCache = { gen: styleGen, map: {} }; }
    var c = computedCache.map[el.__id];
    if (c) return c;
    var parent = el.parentNode && el.parentNode.nodeType === 1 ? computedOf(el.parentNode) : null;
    c = computeStyle(el, parent);
    computedCache.map[el.__id] = c;
    return c;
  }

  function computeStyle(el, parent, pe) {
    var spec = pe ? cascade(el, pe) : cascade(el);
    var out = {};
    var vars = {};
    if (parent) for (var pv in parent._vars) vars[pv] = parent._vars[pv];
    for (var n in spec) if (n.slice(0, 2) === '--') vars[n] = spec[n];
    // custom properties may use each other
    for (var vn in vars) if (vars[vn].indexOf('var(') >= 0) vars[vn] = resolveVars(vars[vn], vars, 0);
    out._vars = vars;
    // inherited from the parent first
    if (parent) for (var ip in INHERITED) if (parent[ip] !== undefined) out[ip] = parent[ip];
    var fontPx = parent ? parent._fontPx : 16;
    var rootPx = rootFontPx();
    // font-size first: em in other properties depend on it
    var fsRaw = spec['font-size'];
    if (fsRaw !== undefined) {
      var fs = resolveVars(fsRaw, vars, 0);
      if (fs === 'inherit') fs = parent ? parent['font-size'] : '16px';
      var px = fontSizePx(fs, fontPx, rootPx);
      out['font-size'] = fmtPx(px);
      out._fontPx = px;
      out._fsKw = /^(xx?-small|small|medium|large|xx?-large|xxx-large|smaller|larger|initial)$/.test(fs) && (parent ? parent._fsKw !== false : true);
    } else {
      out._fontPx = fontPx;
      out._fsKw = parent ? parent._fsKw !== false : true;
      // a size from the keywords is 13px, not 16px, in the monospace
      // generic family (as browsers do)
      var famOf = function (f) { return String(f || '').trim() === 'monospace'; };
      var mono = famOf(spec['font-family'] !== undefined ? spec['font-family'] : (parent ? parent['font-family'] : ''));
      var pMono = parent ? famOf(parent['font-family']) : false;
      if (out._fsKw && mono !== pMono) {
        out._fontPx = mono ? fontPx * 13 / 16 : fontPx * 16 / 13;
        out['font-size'] = fmtPx(out._fontPx);
      }
      if (!out['font-size']) out['font-size'] = fmtPx(fontPx);
    }
    var ctx = { em: out._fontPx, rem: el === (doc && doc.documentElement) ? out._fontPx : rootPx, vw: viewport.w / 100, vh: viewport.h / 100 };
    // ch is the face's "0" and ex its x-height: Ahem's are 1em and 0.8em,
    // a monospace face's 0 is 0.6em, other faces' about half an em
    var fam0 = String(spec['font-family'] !== undefined ? spec['font-family'] : (parent ? parent['font-family'] || '' : '')).toLowerCase();
    if (/ahem/.test(fam0)) { ctx.ch = ctx.em; ctx.ex = ctx.em * 0.8; }
    else if (/mono|courier|consolas/.test(fam0)) ctx.ch = ctx.em * 0.6021;
    // (logical longhands go to the physical side of the element's own
    // writing mode and direction)
    var wmOf = function (k) { var w = spec[k] !== undefined ? resolveVars(spec[k], vars, 0) : ''; return w && !/^(inherit|unset)$/.test(w) ? (w === 'initial' ? INITIAL[k] : w) : (parent ? parent[k] : INITIAL[k]); };
    var ownWm = wmOf('writing-mode'), ownDir = wmOf('direction');
    var sq = spec._seq || {}, physFrom = {};
    for (var ln in spec) { var pn = physicalOf(ln, ownWm, ownDir); if (pn && (physFrom[pn] === undefined || (sq[ln] || 0) > (sq[physFrom[pn]] || 0))) physFrom[pn] = ln; }
    for (var name0 in spec) {
      if (name0.slice(0, 2) === '--' || name0 === 'font-size') continue;
      var v = spec[name0];
      var name = physicalOf(name0, ownWm, ownDir) || name0;
      // (of a logical longhand and its physical property, the one set later)
      var rival = name === name0 ? physFrom[name] : (physFrom[name] === name0 && spec[name] !== undefined ? name : undefined);
      if (rival !== undefined && rival !== name0 && (sq[rival] || 0) > (sq[name0] || 0)) continue;
      if (v.indexOf('var(') >= 0) {
        v = resolveVars(v, vars, 0);
        var lh = expandShorthand(name, v);
        if (lh && !(name in lh)) { for (var k0 in lh) { var k = physicalOf(k0, ownWm, ownDir) || k0; out[k] = computeValue(k, lh[k0], ctx, parent, out); } continue; }
      }
      var kw = v.toLowerCase();
      if (kw === 'inherit') { out[name] = parent && parent[name] !== undefined ? parent[name] : INITIAL[name]; continue; }
      if (kw === 'initial' || kw === 'revert' || kw === 'revert-layer') { out[name] = INITIAL[name]; continue; }
      if (kw === 'unset') { out[name] = INHERITED[name] && parent ? parent[name] : INITIAL[name]; continue; }
      out[name] = computeValue(name, v, ctx, parent, out);
    }
    if (out.display === undefined) out.display = 'inline';
    // a translation's percentages are of the element's own border box (the
    // host's transform takes lengths): `translate(-50%, -50%)` centres a
    // handle on its point
    if (out.transform && out.transform.indexOf('%') >= 0) out.transform = transformPercents(el, out);
    // currentcolor in colors
    var color = out.color || 'rgb(0, 0, 0)';
    for (var cn in out) if (typeof out[cn] === 'string' && /currentcolor/i.test(out[cn]) && cn !== 'color') out[cn] = out[cn].replace(/currentcolor/ig, color);
    // a floated or absolutely positioned element is a block
    if ((out.position === 'absolute' || out.position === 'fixed') && /^inline/.test(out.display)) out.display = out.display === 'inline-flex' ? 'flex' : out.display === 'inline-grid' ? 'grid' : 'block';
    if (parent && (parent.display === 'flex' || parent.display === 'inline-flex' || parent.display === 'grid' || parent.display === 'inline-grid') && /^inline/.test(out.display)) out.display = out.display === 'inline-flex' ? 'flex' : out.display === 'inline-grid' ? 'grid' : out.display === 'inline-block' || out.display === 'inline' ? 'block' : out.display;
    return out;
  }
  function transformPercents(el, out) {
    var px = function (k) { var m = /^(-?[\d.]+)px$/.exec(out[k] || ''); return m ? parseFloat(m[1]) : null; };
    var side = function (dim, a, b) {
      var v = px(dim);
      if (v === null) { var bx = boxes[el.__id]; return bx ? (dim === 'width' ? bx[2] : bx[3]) : 0; }
      if (out['box-sizing'] !== 'border-box') v += (px('padding-' + a) || 0) + (px('padding-' + b) || 0) + (px('border-' + a + '-width') || 0) + (px('border-' + b + '-width') || 0);
      return v;
    };
    var w = side('width', 'left', 'right'), h = side('height', 'top', 'bottom');
    return out.transform.replace(/(translate[XY3d]*)\(([^)]*)\)/g, function (m, fn, args) {
      var k = 0;
      return fn + '(' + args.split(',').map(function (a) {
        var axis = fn === 'translateY' ? 'y' : fn === 'translateX' ? 'x' : k++ === 0 ? 'x' : 'y';
        return a.replace(/(-?[\d.]+)%/, function (q, n) { return fmtPx(parseFloat(n) / 100 * (axis === 'x' ? w : h)); });
      }).join(',') + ')';
    });
  }
  function rootFontPx() {
    var r = doc && doc.documentElement;
    if (!r) return 16;
    var c = computedCache.map[r.__id];
    return c ? c._fontPx : 16;
  }
  function resolveVars(v, vars, depth) {
    if (depth > 20 || v.indexOf('var(') < 0) return v;
    var out = '', i = 0;
    for (;;) {
      var k = v.indexOf('var(', i);
      if (k < 0) { out += v.slice(i); break; }
      out += v.slice(i, k);
      var close = findClose(v, k + 3, '(', ')');
      if (close < 0) { out += v.slice(k); break; }
      var inner = v.slice(k + 4, close);
      var comma = inner.indexOf(',');
      var name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      var fb = comma < 0 ? undefined : inner.slice(comma + 1).trim();
      var val = vars[name];
      if (val === undefined || val === 'initial') val = fb === undefined ? '' : fb;
      out += resolveVars(val, vars, depth + 1);
      i = close + 1;
    }
    return out.trim();
  }
  function fmtPx(n) { return (Math.round(n * 1000) / 1000) + 'px'; }
  var FONT_SIZES = { 'xx-small': 9, 'x-small': 10, 'small': 13, 'medium': 16, 'large': 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
  function fontSizePx(v, parentPx, rootPx) {
    v = String(v).trim().toLowerCase();
    if (FONT_SIZES[v] !== undefined) return FONT_SIZES[v];
    if (v === 'smaller') return parentPx / 1.2;
    if (v === 'larger') return parentPx * 1.2;
    var l = lengthPx(v, { em: parentPx, rem: rootPx, vw: viewport.w / 100, vh: viewport.h / 100, pct: parentPx });
    return l === null ? parentPx : l;
  }
  // a length in px, or null (auto, %, a keyword)
  function lengthPx(v, ctx) {
    v = String(v).trim();
    var m = /^(-?[\d.]+(?:e-?\d+)?)(px|em|rem|vw|vh|vmin|vmax|pt|pc|in|cm|mm|ch|ex|q|%)?$/i.exec(v);
    if (m) {
      var n = parseFloat(m[1]);
      var u = (m[2] || '').toLowerCase();
      switch (u) {
        case '': return n === 0 ? 0 : n;
        case 'px': return n;
        case 'em': return n * ctx.em;
        case 'rem': return n * ctx.rem;
        case 'vw': return n * ctx.vw;
        case 'vh': return n * ctx.vh;
        case 'vmin': return n * Math.min(ctx.vw, ctx.vh);
        case 'vmax': return n * Math.max(ctx.vw, ctx.vh);
        case 'pt': return n * 4 / 3;
        case 'pc': return n * 16;
        case 'in': return n * 96;
        case 'cm': return n * 96 / 2.54;
        case 'mm': return n * 96 / 25.4;
        case 'q': return n * 96 / 101.6;
        case 'ch': return n * (ctx.ch !== undefined ? ctx.ch : ctx.em / 2);
        case 'ex': return n * (ctx.ex !== undefined ? ctx.ex : ctx.em / 2);
        case '%': return ctx.pct !== undefined ? n * ctx.pct / 100 : null;
      }
    }
    if (/^(calc|min|max|clamp)\(/i.test(v)) return calcPx(v, ctx);
    return null;
  }
  // calc() with px-convertible terms; a % keeps it unresolved (null)
  function calcPx(v, ctx) {
    var s = v.replace(/^calc\(/i, '(');
    var toks = [];
    var re = /\s*(-?[\d.]+(?:e-?\d+)?[a-z%]*|[()+\-*\/,]|min\(|max\(|clamp\(|calc\()\s*/gi;
    var m, pos = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index !== pos) return null;
      toks.push(m[1].toLowerCase());
      pos = re.lastIndex;
    }
    if (pos !== s.length) return null;
    var i = 0;
    function primary() {
      var t = toks[i++];
      if (t === '(' || t === 'calc(') { var e = expr(); i++; return e; }
      if (t === 'min(' || t === 'max(' || t === 'clamp(') {
        var args = [expr()];
        while (toks[i] === ',') { i++; args.push(expr()); }
        i++;
        if (args.some(function (a) { return a === null; })) return null;
        if (t === 'min(') return Math.min.apply(null, args);
        if (t === 'max(') return Math.max.apply(null, args);
        return Math.max(args[0], Math.min(args[1], args[2]));
      }
      if (t === '-') { var p = primary(); return p === null ? null : -p; }
      if (/^-?[\d.]/.test(t)) {
        if (/^-?[\d.]+(e-?\d+)?$/.test(t)) return { num: parseFloat(t) };
        return lengthPx(t, ctx);
      }
      return null;
    }
    function term() {
      var a = primary();
      while (toks[i] === '*' || toks[i] === '/') {
        var op = toks[i++];
        var b = primary();
        if (a === null || b === null) return null;
        var av = typeof a === 'object' ? a.num : a, bv = typeof b === 'object' ? b.num : b;
        var bothNum = typeof a === 'object' && typeof b === 'object';
        var r = op === '*' ? av * bv : av / bv;
        a = bothNum ? { num: r } : r;
      }
      return a;
    }
    function expr() {
      var a = term();
      while (toks[i] === '+' || toks[i] === '-') {
        var op = toks[i++];
        var b = term();
        if (a === null || b === null) return null;
        var av = typeof a === 'object' ? a.num : a, bv = typeof b === 'object' ? b.num : b;
        a = op === '+' ? av + bv : av - bv;
      }
      return a;
    }
    var r = expr();
    if (r === null || r === undefined) return null;
    return typeof r === 'object' ? r.num : r;
  }
  var LENGTH_PROPS = /^(width|height|min-width|min-height|max-width|max-height|top|right|bottom|left|margin-(top|right|bottom|left)|padding-(top|right|bottom|left)|border-(top|right|bottom|left)-width|border-(top|bottom)-(left|right)-radius|row-gap|column-gap|flex-basis|letter-spacing|word-spacing|text-indent|outline-width|outline-offset|line-height|gap)$/;
  function computeValue(name, v, ctx, parent, out) {
    v = v.trim();
    if (name === 'line-height') {
      if (/^[\d.]+$/.test(v)) return v;
      if (v === 'normal') return v;
      var lh = lengthPx(v, { em: ctx.em, rem: ctx.rem, vw: ctx.vw, vh: ctx.vh, pct: ctx.em });
      return lh === null ? v : fmtPx(lh);
    }
    if (/-width$/.test(name) && /^border-|^outline-/.test(name)) {
      if (v === 'thin') return '1px';
      if (v === 'medium') return '3px';
      if (v === 'thick') return '5px';
    }
    if (LENGTH_PROPS.test(name)) {
      if (/%/.test(v) && !/^(calc|min|max|clamp)\(/.test(v)) return v;
      var px = lengthPx(v, ctx);
      if (px !== null) return fmtPx(px);
      return v;
    }
    // the thumb's colour, then the track's, each as its own computed colour
    if (name === 'scrollbar-color') {
      if (/^auto$/i.test(v.trim())) return 'auto';
      return (v.match(/[a-z-]+\([^)]*\)|[^\s()]+/gi) || []).map(normalizeColor).join(' ');
    }
    if (name === 'color' || /-color$/.test(name) || name === 'fill' || name === 'stroke') {
      if (/^currentcolor$/i.test(v)) return name === 'color' ? (parent ? parent.color : 'rgb(0, 0, 0)') : v;
      return normalizeColor(v);
    }
    if (name === 'font-weight') {
      if (v === 'normal') return '400';
      if (v === 'bold') return '700';
      if (v === 'bolder') return String(Math.min(900, (parent ? parseInt(parent['font-weight'], 10) || 400 : 400) + 300));
      if (v === 'lighter') return String(Math.max(100, (parent ? parseInt(parent['font-weight'], 10) || 400 : 400) - 300));
      return v;
    }
    if (name === 'box-shadow' || name === 'transform' || name === 'text-shadow') return v.replace(/(-?[\d.]+)(rem|em)\b/g, function (m, n, u) { return fmtPx(parseFloat(n) * (u === 'rem' ? ctx.rem : ctx.em)); });
    return v;
  }

  var NAMED_COLORS = { black: '0,0,0', white: '255,255,255', red: '255,0,0', green: '0,128,0', blue: '0,0,255', yellow: '255,255,0', gray: '128,128,128', grey: '128,128,128', silver: '192,192,192', maroon: '128,0,0', purple: '128,0,128', fuchsia: '255,0,255', lime: '0,255,0', olive: '128,128,0', navy: '0,0,128', teal: '0,128,128', aqua: '0,255,255', orange: '255,165,0', pink: '255,192,203', transparent: null, lightgray: '211,211,211', lightgrey: '211,211,211', darkgray: '169,169,169', darkgrey: '169,169,169', whitesmoke: '245,245,245', gainsboro: '220,220,220', dimgray: '105,105,105', lightblue: '173,216,230', darkblue: '0,0,139', cornflowerblue: '100,149,237', royalblue: '65,105,225', dodgerblue: '30,144,255', steelblue: '70,130,180', skyblue: '135,206,235', crimson: '220,20,60', tomato: '255,99,71', coral: '255,127,80', gold: '255,215,0', khaki: '240,230,140', beige: '245,245,220', ivory: '255,255,240', lavender: '230,230,250', violet: '238,130,238', indigo: '75,0,130', brown: '165,42,42', chocolate: '210,105,30', tan: '210,180,140', salmon: '250,128,114', orchid: '218,112,214', plum: '221,160,221', turquoise: '64,224,208', cyan: '0,255,255', magenta: '255,0,255', darkgreen: '0,100,0', lightgreen: '144,238,144', seagreen: '46,139,87', forestgreen: '34,139,34', darkred: '139,0,0', firebrick: '178,34,34', darkorange: '255,140,0', slategray: '112,128,144', lightslategray: '119,136,153', aliceblue: '240,248,255', ghostwhite: '248,248,255', snow: '255,250,250', linen: '250,240,230', mintcream: '245,255,250', honeydew: '240,255,240', azure: '240,255,255', midnightblue: '25,25,112', darkslategray: '47,79,79', rebeccapurple: '102,51,153' };
  function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
    if (s === 0) { var g = l * 255; return [g, g, g]; }
    function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    var q2 = l < 0.5 ? l * (1 + s) : l + s - l * s, p2 = 2 * l - q2;
    return [hue(p2, q2, h + 1 / 3) * 255, hue(p2, q2, h) * 255, hue(p2, q2, h - 1 / 3) * 255];
  }
  function rgbString(r, g, b, a) {
    if (a === undefined || a >= 1) return 'rgb(' + clamp255(r) + ', ' + clamp255(g) + ', ' + clamp255(b) + ')';
    return 'rgba(' + clamp255(r) + ', ' + clamp255(g) + ', ' + clamp255(b) + ', ' + (Math.round(Math.max(0, a) * 1000) / 1000) + ')';
  }
  function channel(t, scale) { t = t.trim(); if (t === 'none') return 0; if (/%$/.test(t)) return parseFloat(t) / 100 * scale; return parseFloat(t); }
  function alphaOf(t) { if (t === undefined) return 1; t = t.trim(); if (t === 'none') return 0; return /%$/.test(t) ? parseFloat(t) / 100 : parseFloat(t); }
  function normalizeColor(v) {
    var s = v.trim();
    var low = s.toLowerCase();
    if (low === 'transparent') return 'rgba(0, 0, 0, 0)';
    if (NAMED_COLORS[low]) { var p = NAMED_COLORS[low].split(','); return rgbString(+p[0], +p[1], +p[2]); }
    var m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length !== 6 && h.length !== 8) return s;
      return rgbString(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
    }
    var fm = /^(rgba?|hsla?)\((.*)\)$/i.exec(s);
    if (fm) {
      var body = fm[2].trim();
      var parts, alpha;
      if (body.indexOf(',') >= 0) { parts = body.split(','); alpha = parts[3]; parts = parts.slice(0, 3); }
      else { var sl = body.split('/'); parts = sl[0].trim().split(/\s+/); alpha = sl[1]; }
      if (parts.length < 3) return s;
      if (/^rgb/i.test(fm[1])) return rgbString(channel(parts[0], 255), channel(parts[1], 255), channel(parts[2], 255), alphaOf(alpha));
      var rgb = hslToRgb(parseFloat(parts[0]), channel(parts[1], 1) / (/%$/.test(parts[1].trim()) ? 1 : 100), channel(parts[2], 1) / (/%$/.test(parts[2].trim()) ? 1 : 100));
      return rgbString(rgb[0], rgb[1], rgb[2], alphaOf(alpha));
    }
    var om = /^oklch\((.*)\)$/i.exec(s);
    if (om) {
      var ob = om[1].split('/');
      var op = ob[0].trim().split(/\s+/);
      var L = /%$/.test(op[0]) ? parseFloat(op[0]) / 100 : parseFloat(op[0]);
      var C = /%$/.test(op[1]) ? parseFloat(op[1]) / 100 * 0.4 : parseFloat(op[1]);
      var H = parseFloat(op[2]) || 0;
      var a2 = C * Math.cos(H * Math.PI / 180), b2 = C * Math.sin(H * Math.PI / 180);
      var c3 = oklabToRgb(L, a2, b2);
      return rgbString(c3[0], c3[1], c3[2], alphaOf(ob[1]));
    }
    return s;
  }
  function oklabToRgb(L, a, b) {
    var l = L + 0.3963377774 * a + 0.2158037573 * b;
    var m = L - 0.1055613458 * a - 0.0638541728 * b;
    var s = L - 0.0894841775 * a - 1.2914855480 * b;
    l = l * l * l; m = m * m * m; s = s * s * s;
    var r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    var bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    function gam(x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }
    return [gam(r) * 255, gam(g) * 255, gam(bb) * 255];
  }

  function getComputedStyle(el, pseudo) {
    if (!el || el.nodeType !== 1) throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.");
    var c = el.isConnected ? computedOf(el) : { display: 'block', _vars: {} };
    var decl = new CSSStyleDeclaration(null);
    for (var k in INITIAL) decl._set(k, c[k] !== undefined ? c[k] : INITIAL[k], '');
    for (var n in c) if (n.charAt(0) !== '_') decl._set(n, c[n], '');
    for (var v in c._vars) decl._set(v, c._vars[v], '');
    var b = boxes[el.__id];
    if (b && el.isConnected && c.display !== 'none') {
      if (!/^\d/.test(decl._p.width) || decl._p.width === 'auto') decl._p.width = fmtPx(b[2]);
      if (!/^\d/.test(decl._p.height) || decl._p.height === 'auto') decl._p.height = fmtPx(b[3]);
    }
    decl._readonly = true;
    return styleProxy(decl);
  }

  // ---- rendering for the host ----------------------------------------------

  // what the host lays out: each element {i, t, s: computed style (the
  // properties that differ from the initial value), a: attributes the host
  // shows, c: children}, each text {i, x}
  var RENDER_ATTRS = { src: 1, alt: 1, href: 1, placeholder: 1, type: 1, role: 1, 'aria-label': 1, 'aria-hidden': 1, 'aria-expanded': 1, 'aria-selected': 1, 'aria-checked': 1, title: 1, viewBox: 1, d: 1, points: 1, cx: 1, cy: 1, r: 1, rx: 1, ry: 1, x: 1, y: 1, x1: 1, y1: 1, x2: 1, y2: 1, width: 1, height: 1, transform: 1, 'fill-rule': 1, 'clip-rule': 1, 'stroke-linecap': 1, 'stroke-linejoin': 1, tabindex: 1, contenteditable: 1, id: 1, class: 1, style: 1, rows: 1, clear: 1 };
  function renderNode(n, parentStyle, asJson) {
    if (n.nodeType === 3) {
      if (!n._data) return null;
      return { i: n.__id, x: n._data };
    }
    if (n.nodeType !== 1) return null;
    var cs = computedOf(n);
    if (cs.display === 'none' || cs.display === 'contents' && !n._c.length) return null;
    var o = { i: n.__id, t: n.namespaceURI === SVG_NS ? 'svg:' + n.localName : n.localName };
    var s = {};
    for (var k in cs) {
      if (k.charAt(0) === '_') continue;
      var v = cs[k];
      if (INHERITED[k] && parentStyle && parentStyle[k] === v) continue;
      if (!INHERITED[k] && INITIAL[k] === v) continue;
      s[k] = v;
    }
    o.s = s;
    var a = null;
    for (var i = 0; i < n._attrs.length; i++) {
      var an = n._attrs[i].name;
      if (RENDER_ATTRS[an] || an.slice(0, 5) === 'data-' && an === 'data-testid') { if (!a) a = {}; a[an] = n._attrs[i]._v; }
    }
    if (n.localName === 'input' || n.localName === 'textarea' || n.localName === 'select') {
      if (!a) a = {};
      a.value = n.localName === 'select' ? (n.selectedOptions[0] ? n.selectedOptions[0].text : '') : n.type === 'password' ? n.value.replace(/./g, '\u2022') : n.value;
      if (n.type === 'checkbox' || n.type === 'radio') a.checked = n.checked;
      if (n.disabled) a.disabled = true;
      // the text before the caret, and before each end of the selection,
      // where the host draws them (prefixes: the host counts its own units)
      if (doc && doc._active === n && isTextControl(n)) {
        var ss = Math.min(n.selectionStart, a.value.length), se = Math.min(n.selectionEnd, a.value.length);
        a.caret = a.value.slice(0, n.selectionDirection === 'backward' ? ss : se);
        if (ss < se) a.sel = [a.value.slice(0, ss), a.value.slice(0, se)];
      }
    }
    if (n.localName === 'button' && n.disabled) { if (!a) a = {}; a.disabled = true; }
    if (doc && doc._active === n) { if (!a) a = {}; a.focused = true; }
    if (a) o.a = a;
    if (n.scrollTop || n.scrollLeft) o.sc = [n.scrollLeft, n.scrollTop];
    if (o.t === 'svg:svg') {
      // an inline picture: its markup, drawn by the host's SVG painter,
      // with currentColor as the element's color
      o.svg = serializeSvg(n, true);
      svgTexts(n, o);
      return o;
    }
    if (n.localName === 'img' && a && a.src) a.src = resolveURL(a.src);
    var kids = [];
    var src = n.localName === 'template' ? [] : n._c;
    if (/^(input|textarea|select|img|br|hr|iframe|canvas|video|audio|svg:?)$/.test(n.localName) && n.namespaceURI === HTML_NS) src = n.localName === 'select' ? [] : src;
    if (n.localName === 'canvas' && n.namespaceURI === HTML_NS) {
      // a canvas shows what is drawn on it, not its fallback content
      canvasRender(n, o, cs);
      return o;
    }
    if (n.localName === 'textarea') src = [];
    src = paintOrder(src);
    // (a replaced element has no ::before or ::after box)
    var leaf = /^(input|textarea|select|img|br|hr|iframe|video|audio)$/.test(n.localName);
    var pb = leaf ? null : pseudoBox(n, cs, 'before'), pa = leaf ? null : pseudoBox(n, cs, 'after');
    var fl = leaf || (pb && pb.c) ? null : firstLetter(n, cs, src, 'first-letter') || firstLetter(n, cs, src, 'first-line');
    if (asJson) {
      // the children as JSON text, each from the last render when nothing
      // under it changed since
      if (pb) kids.push(JSON.stringify(pb));
      for (var jj = 0; jj < src.length; jj++) {
        if (fl && src[jj] === fl.node) { kids.push(JSON.stringify(fl.box)); if (fl.rest) kids.push(JSON.stringify(fl.rest)); if (!fl.zw) continue; }
        var rj = renderJson(src[jj], cs);
        if (rj) kids.push(rj);
      }
      if (pa) kids.push(JSON.stringify(pa));
      var own = JSON.stringify(o);
      return kids.length ? own.slice(0, -1) + ',"c":[' + kids.join(',') + ']}' : own;
    }
    if (pb) kids.push(pb);
    for (var j = 0; j < src.length; j++) {
      if (fl && src[j] === fl.node) { kids.push(fl.box); if (fl.rest) kids.push(fl.rest); if (!fl.zw) continue; }
      var r = renderNode(src[j], cs);
      if (r) kids.push(r);
    }
    if (pa) kids.push(pa);
    if (kids.length) o.c = kids;
    return o;
  }
  // an element's ::before or ::after box: a span of the style its rules
  // give it, inheriting from the element, holding the text of its content
  // (strings and attr(); counters and images are left out)
  function pseudoBox(n, cs, pe) {
    var d = n.ownerDocument || doc;
    if (d !== doc) return null;
    var any = false, list = cascadeSheets(d);
    for (var q = 0; q < list.length; q++) if (list[q]._pseudo && !list[q].disabled) { any = true; break; }
    if (!any || !cascade(n, pe)) return null;
    var ps = computeStyle(n, cs, pe);
    var content = (ps.content || 'normal').trim();
    if (content === 'normal' || content === 'none' || ps.display === 'none') return null;
    var text = '', re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)/g, m;
    while ((m = re.exec(content))) {
      if (m[3] !== undefined) text += n.getAttribute(m[3]) || '';
      else text += (m[1] !== undefined ? m[1] : m[2]).replace(/\\([0-9a-fA-F]{1,6})\s?/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); }).replace(/\\(.)/g, '$1');
    }
    var o = { i: n.__id + (pe === 'before' ? 'pb' : 'pa'), t: 'span', pe: 1 };
    var s = {};
    for (var k in ps) {
      if (k.charAt(0) === '_' || k === 'content') continue;
      var v = ps[k];
      if (INHERITED[k] && cs[k] === v) continue;
      if (!INHERITED[k] && INITIAL[k] === v) continue;
      s[k] = v;
    }
    if (!s.display) s.display = 'inline';
    o.s = s;
    if (text) o.c = [{ i: o.i + 't', x: text }];
    return o;
  }
  // a block container's ::first-letter box: the first letter (with the
  // punctuation around it) of its first text, when that text is a direct
  // child, as a span of the pseudo's style; the rest of the text follows.
  // (::first-line: where the line breaks is not known here, so its box
  // holds the first word only, which gives the first line its line-height)
  function firstLetter(n, cs, src, pe) {
    if (!/^(block|inline-block|list-item|table-cell|table-caption|flow-root)$/.test(cs.display || '')) return null;
    var d = n.ownerDocument || doc;
    if (d !== doc) return null;
    var t = null;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (c.nodeType === 3) { if (/\S/.test(c._data || '')) { t = c; break; } continue; }
      if (c.nodeType !== 1) continue;
      var ccs = computedOf(c);
      if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed' || (ccs.float && ccs.float !== 'none')) continue;
      // (a line that starts with an inline-level box: ::first-line's box
      // is a zero-width space before it)
      if (pe === 'first-line' && /^inline/.test(ccs.display || 'inline')) { t = { _data: '\u200b', __id: n.__id + 'plz', zw: c }; break; }
      return null;
    }
    if (!t) return null;
    var any = false, list = cascadeSheets(d);
    for (var q = 0; q < list.length; q++) if (list[q]._pseudo && !list[q].disabled) { any = true; break; }
    if (!any || !cascade(n, pe)) return null;
    var m = pe === 'first-line' ? /^(\s*\S+)/.exec(t._data) : /^(\s*[\p{P}]*\s*[^\s\p{P}][\p{P}]*)/u.exec(t._data);
    if (!m) return null;
    var ps = computeStyle(n, cs, pe);
    var s = {};
    for (var k in ps) {
      if (k.charAt(0) === '_' || k === 'content') continue;
      var v = ps[k];
      if (INHERITED[k] && cs[k] === v) continue;
      if (!INHERITED[k] && INITIAL[k] === v) continue;
      s[k] = v;
    }
    s.display = pe === 'first-letter' && ps.float && ps.float !== 'none' ? 'block' : 'inline';
    if (pe === 'first-line') delete s.float;
    var box = { i: n.__id + 'pl', t: 'span', pe: 1, s: s, c: [{ i: n.__id + 'plt', x: m[1] }] };
    var rest = t._data.slice(m[1].length);
    if (t.zw) return { node: t.zw, box: box, rest: null, zw: true };
    return { node: t, box: box, rest: rest ? { i: t.__id, x: rest } : null };
  }
  // the children in the order they are painted: an absolutely placed one
  // with a z-index goes below the others (negative) or above them, as the
  // host draws in tree order and knows no z-index (React Flow's background
  // comes after its z-index: 2 viewport, a selected node gets 1000). In-flow
  // children keep their order, so the layout does not change.
  function paintOrder(src) {
    var keyed = null;
    for (var i = 0; i < src.length; i++) {
      var e = src[i];
      if (e.nodeType !== 1) continue;
      var cs = computedOf(e);
      if ((cs.position === 'absolute' || cs.position === 'fixed') && cs['z-index'] && cs['z-index'] !== 'auto') {
        var z = parseInt(cs['z-index'], 10) || 0;
        if (z !== 0) { if (!keyed) keyed = []; keyed[i] = z; }
      }
    }
    if (!keyed) return src;
    var idx = src.map(function (_, k) { return k; });
    idx.sort(function (a, b) { return ((keyed[a] || 0) - (keyed[b] || 0)) || a - b; });
    return idx.map(function (k) { return src[k]; });
  }
  // renderNode as JSON text; an element's text is kept with the styles it
  // was rendered with (styleGen: every change but a text's) and the last
  // text change under it (_rv), so a count-up's frame renders only the
  // numbers' paths, not the whole page
  function renderJson(n, parentStyle) {
    if (n.nodeType === 3) return n._data ? JSON.stringify({ i: n.__id, x: n._data }) : '';
    if (n.nodeType !== 1) return '';
    var k = n._rj;
    // a script's scrollTop is no change (generation): the box's own say
    var sc = (n.scrollTop || 0) + ',' + (n.scrollLeft || 0);
    if (k && k.sg === styleGen && k.rv === n._rv && k.ps === parentStyle && k.sc === sc) return k.json;
    var r = renderNode(n, parentStyle, true);
    var json = r === null ? '' : typeof r === 'string' ? r : JSON.stringify(r);
    n._rj = { sg: styleGen, rv: n._rv, ps: parentStyle, sc: sc, json: json };
    return json;
  }
  // an inline <svg> as markup for the host's painter, each shape with the
  // paint the cascade gives it: a page's style sheet often sets fill and
  // stroke (`.icon path { fill: currentColor }`), which the markup alone
  // does not carry
  var SVG_PAINT = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity', 'fill-rule', 'stroke-linecap', 'stroke-linejoin'];
  var SVG_STOP = ['stop-color', 'stop-opacity'];
  // an outer <svg> without a viewBox draws its user units as pixels from
  // its top-left corner (and past its box: React Flow's edges are paths in
  // a 300 x 150 svg); written with its size in pixels, so the host's painter
  // does not fit the drawing's bounds into the box instead
  function svgUsedSize(n, cs, name, dflt) {
    var c = /^(-?[\d.]+)px$/.exec(cs[name] || '');
    if (c) return parseFloat(c[1]);
    var at = n.getAttribute(name);
    if (at !== null && /^\s*[\d.]+(px)?\s*$/.test(at)) return parseFloat(at);
    if (at !== null || (cs[name] && cs[name] !== 'auto')) return null;
    return dflt;
  }
  // svgs whose markup took their laid-out size (a pattern tiled over a
  // `100%` rect): drawn again when the size changes
  var boxSvgs = [];
  function svgBoxSize(svg) {
    var cs = computedOf(svg);
    var w = svgUsedSize(svg, cs, 'width', 300), h = svgUsedSize(svg, cs, 'height', 150);
    var b = boxes[svg.__id];
    if ((w === null || h === null) && !b) return null;
    if (boxSvgs.indexOf(svg) < 0) boxSvgs.push(svg);
    var r = { w: w !== null ? w : b[2], h: h !== null ? h : b[3] };
    svg._usedBox = r.w + ',' + r.h;
    return r;
  }
  function svgLength(v, total) {
    if (v === null || v === undefined || v === '') return 0;
    v = String(v).trim();
    return /%$/.test(v) ? parseFloat(v) / 100 * total : parseFloat(v) || 0;
  }
  // a shape filled with a <pattern> (userSpaceOnUse, its patternTransform a
  // translation), as React Flow's background dots, lines and crosses: the
  // pattern written out before the shape with its lengths resolved, its
  // translation in x and y, and its content serialized; the host's painter
  // keeps it as one command (EVG keepPatterns) where a tiling of the box
  // was thousands. '' when the tile has no size (the shape is not drawn),
  // null when the fill names no pattern.
  function patternDef(n, cs, outerSvg) {
    var m = /^url\(\s*["']?#([^"')]+)["']?\s*\)$/.exec(cs.fill || '');
    if (!m || !outerSvg) return null;
    var pat = null;
    eachElement(outerSvg, function (e) { if (!pat && e.localName === 'pattern' && e.getAttribute('id') === m[1]) pat = e; });
    if (!pat) return null;
    var size = svgBoxSize(outerSvg);
    if (!size) return '';
    var pw = svgLength(pat.getAttribute('width'), size.w), ph = svgLength(pat.getAttribute('height'), size.h);
    if (!(pw > 0.5) || !(ph > 0.5)) return '';
    var ox = svgLength(pat.getAttribute('x'), size.w), oy = svgLength(pat.getAttribute('y'), size.h);
    var pt = /translate\(\s*(-?[\d.e-]+)[\s,]*(-?[\d.e-]+)?\s*\)/.exec(pat.getAttribute('patternTransform') || '');
    if (pt) { ox += parseFloat(pt[1]) || 0; oy += parseFloat(pt[2]) || 0; }
    var body = '';
    for (var c = 0; c < pat._c.length; c++) body += serializeSvg(pat._c[c]);
    return '<pattern id="' + escapeAttr(m[1]) + '" patternUnits="userSpaceOnUse" x="' + fmtNum(ox) + '" y="' + fmtNum(oy) + '" width="' + fmtNum(pw) + '" height="' + fmtNum(ph) + '">' + body + '</pattern>';
  }
  // an svg's <text> (React Flow's edge labels): the host's SVG painter has
  // no text, so each one is a span placed over the picture where its
  // baseline is (x, y, dx, dy, text-anchor; the translations of the groups
  // around it), and the svg a box holding both
  function svgTextRuns(svg) {
    var runs = [];
    (function walk(e, m) {
      for (var i = 0; i < e._c.length; i++) {
        var c = e._c[i];
        if (c.nodeType !== 1 || c.localName === 'pattern' || c.localName === 'defs' || c.localName === 'clipPath' || c.localName === 'mask') continue;
        var cs = computedOf(c);
        if (cs.display === 'none') continue;
        var t = c.getAttribute('transform');
        var cm = m;
        if (t) { try { cm = m.multiply(new DOMMatrix(t)); } catch (err) { cm = m; } }
        if (c.localName === 'text') {
          if (cs.visibility === 'hidden') continue;
          var txt = c.textContent;
          if (!txt) continue;
          var size = parseFloat(cs['font-size']) || 16;
          var len = function (v) { if (!v) return 0; v = String(v).trim().split(/[\s,]+/)[0]; return /em$/.test(v) ? parseFloat(v) * size : parseFloat(v) || 0; };
          var x = len(c.getAttribute('x')) + len(c.getAttribute('dx')), y = len(c.getAttribute('y')) + len(c.getAttribute('dy'));
          var w = canvasTextWidth(txt, { size: size, weight: cs['font-weight'] || '400' });
          var anchor = c.getAttribute('text-anchor') || cs['text-anchor'];
          if (anchor === 'middle') x -= w / 2; else if (anchor === 'end') x -= w;
          var p = cm.transformPoint({ x: x, y: y });
          runs.push({ el: c, x: p.x, y: p.y, w: w, size: size * Math.sqrt(Math.abs(cm.a * cm.d - cm.b * cm.c)), cs: cs, text: txt });
        } else walk(c, cm);
      }
    })(svg, new DOMMatrix());
    return runs;
  }
  function svgTexts(n, o) {
    var runs = svgTextRuns(n);
    if (!runs.length) return;
    var size = svgBoxSize(n) || { w: 300, h: 150 };
    var box = { display: 'block', position: 'absolute', left: '0px', top: '0px', width: fmtNum(size.w) + 'px', height: fmtNum(size.h) + 'px' };
    var kids = [{ i: n.__id + 'c0', t: 'svg:svg', s: box, a: o.a && o.a.viewBox ? { viewBox: o.a.viewBox } : {}, svg: o.svg }];
    for (var j = 0; j < runs.length; j++) {
      var r = runs[j], cs = r.cs;
      var fill = cs.fill && !/^(none|url\()/.test(cs.fill) ? cs.fill : 'rgb(0, 0, 0)';
      var st = { display: 'block', position: 'absolute', left: fmtNum(r.x) + 'px', top: fmtNum(r.y - r.size * 0.89) + 'px', 'font-size': fmtNum(r.size) + 'px',
        'line-height': fmtNum(r.size) + 'px', 'font-family': cs['font-family'] || 'Arial', color: normalizeColor(fill), 'white-space': 'pre' };
      if (cs['font-weight'] && cs['font-weight'] !== '400') st['font-weight'] = cs['font-weight'];
      if (cs['font-style'] && cs['font-style'] !== 'normal') st['font-style'] = cs['font-style'];
      if (cs['fill-opacity'] && cs['fill-opacity'] !== '1') st.opacity = cs['fill-opacity'];
      kids.push({ i: n.__id + 'c' + (j + 1), t: 'span', s: st, c: [{ i: n.__id + 'c' + (j + 1) + 't', x: r.text }] });
    }
    delete o.svg;
    o.t = 'div';
    o.s = o.s || {};
    if (!o.s.position || o.s.position === 'static') o.s.position = 'relative';
    if (!o.s.display || o.s.display === 'inline') o.s.display = 'inline-block';
    o.s.width = fmtNum(size.w) + 'px';
    o.s.height = fmtNum(size.h) + 'px';
    o.c = kids;
  }
  // a path's marker-start / marker-end (React Flow's arrowheads, defined
  // in another svg of the page): the marker's content drawn at the path's
  // end, turned along it (orient auto), its viewBox fitted to markerWidth x
  // markerHeight, in stroke widths for markerUnits strokeWidth, as the
  // host's painter draws no markers
  function svgMarkers(n, cs) {
    if (n.localName !== 'path' && n.localName !== 'line' && n.localName !== 'polyline') return '';
    var out = '';
    var ends = { 'marker-start': 0, 'marker-end': 1 };
    for (var k in ends) {
      var ref = n.getAttribute(k) || cs[k];
      var m = /url\(\s*["']?#([^"')]+)["']?\s*\)/.exec(ref || '');
      if (!m || !doc) continue;
      var mk = doc.getElementById(m[1]);
      if (!mk || mk.localName !== 'marker') continue;
      var pts = svgEndPoints(n);
      if (!pts) continue;
      // the path's direction there; auto-start-reverse turns a start's round
      var at = ends[k] ? pts.end : pts.start;
      var ang = ends[k] ? Math.atan2(pts.end.y - pts.beforeEnd.y, pts.end.x - pts.beforeEnd.x) : Math.atan2(pts.afterStart.y - pts.start.y, pts.afterStart.x - pts.start.x);
      var orient = mk.getAttribute('orient') || '0';
      if (orient === 'auto-start-reverse' && !ends[k]) ang += Math.PI;
      else if (orient !== 'auto' && orient !== 'auto-start-reverse') ang = (parseFloat(orient) || 0) * Math.PI / 180;
      var vb = (mk.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat);
      var mw = parseFloat(mk.getAttribute('markerWidth')) || 3, mh = parseFloat(mk.getAttribute('markerHeight')) || 3;
      var unit = mk.getAttribute('markerUnits') === 'userSpaceOnUse' ? 1 : parseFloat(cs['stroke-width']) || 1;
      var sx = vb.length === 4 && vb[2] > 0 ? mw / vb[2] : 1, sy = vb.length === 4 && vb[3] > 0 ? mh / vb[3] : 1, sc = Math.min(sx, sy) * unit;
      var rx = parseFloat(mk.getAttribute('refX')) || 0, ry = parseFloat(mk.getAttribute('refY')) || 0;
      var c = Math.cos(ang) * sc, si = Math.sin(ang) * sc;
      // at the end point, turned and scaled, the marker's ref point on it
      var e = at.x - (c * rx - si * ry), f = at.y - (si * rx + c * ry);
      var body = '';
      for (var j = 0; j < mk._c.length; j++) body += serializeSvg(mk._c[j]);
      out += '<g transform="matrix(' + [c, si, -si, c, e, f].map(fmtNum).join(' ') + ')">' + body + '</g>';
    }
    return out;
  }
  // a path's first and last points and the ones beside them (its
  // direction there): from the numbers of its d, pairs as written (a curve's
  // control point gives the tangent)
  function svgEndPoints(n) {
    var nums;
    if (n.localName === 'line') nums = ['x1', 'y1', 'x2', 'y2'].map(function (a) { return parseFloat(n.getAttribute(a)) || 0; });
    else {
      var d = n.localName === 'path' ? n.getAttribute('d') : n.getAttribute('points');
      // (relative, H, V and A commands: not read)
      if (!d || /[aAhHvV]|[b-df-z]/.test(d)) return null;
      nums = (d.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(parseFloat);
    }
    if (nums.length < 4) return null;
    var p = function (i) { return { x: nums[i], y: nums[i + 1] }; };
    var L = nums.length - 2;
    var start = p(0), end = p(L);
    var afterStart = start, beforeEnd = end;
    for (var i = 2; i <= L; i += 2) { var q = p(i); if (q.x !== start.x || q.y !== start.y) { afterStart = q; break; } }
    for (var j = L - 2; j >= 0; j -= 2) { var r = p(j); if (r.x !== end.x || r.y !== end.y) { beforeEnd = r; break; } }
    return { start: start, end: end, afterStart: afterStart, beforeEnd: beforeEnd };
  }
  var SVG_PCT = { x: 'x', y: 'y', width: 'x', height: 'y', cx: 'x', cy: 'y', x1: 'x', x2: 'x', y1: 'y', y2: 'y', rx: 'x', ry: 'y', r: 'd' };
  function serializeSvg(n, outer) {
    if (n.nodeType === 3) return escapeText(n.data);
    if (n.nodeType !== 1) return '';
    if (n.localName === 'title' || n.localName === 'desc' || n.localName === 'style' || n.localName === 'script') return '';
    // a pattern is written before the shape filled with it (patternDef);
    // text goes over the picture as spans (svgTexts)
    if (n.localName === 'pattern' || n.localName === 'text' || n.localName === 'marker') return '';
    var cs = computedOf(n);
    if (cs.display === 'none') return '';
    var def = '';
    if (!outer && /^url\(/.test(cs.fill || '')) {
      def = patternDef(n, cs, n.ownerSVGElement && (function (o) { while (o.ownerSVGElement) o = o.ownerSVGElement; return o; })(n.ownerSVGElement));
      if (def === '') return '';
      if (def === null) def = '';
    }
    var color = cs.color || 'rgb(0, 0, 0)';
    var markers = svgMarkers(n, cs);
    var s = def + '<' + n._qname;
    var sized = false;
    if (outer && n.getAttribute('viewBox') === null) {
      var uw = svgUsedSize(n, cs, 'width', 300), uh = svgUsedSize(n, cs, 'height', 150);
      if (uw !== null && uh !== null) { s += ' width="' + uw + '" height="' + uh + '"'; sized = true; }
    }
    var box = null;
    for (var i = 0; i < n._attrs.length; i++) {
      var an = n._attrs[i].name;
      if (an === 'class' || an === 'style' || SVG_PAINT.indexOf(an) >= 0 || SVG_STOP.indexOf(an) >= 0) continue;
      if (sized && (an === 'width' || an === 'height')) continue;
      var av = n._attrs[i]._v;
      // a shape's length in % (React Flow's background rect, 100%) of the
      // outer svg's size, which the host's SVG parser does not resolve
      if (!outer && SVG_PCT[an] && /%\s*$/.test(av)) {
        if (box === null) { var o = n; while (o.ownerSVGElement) o = o.ownerSVGElement; var vb = (o.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat); box = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : svgBoxSize(o) || { w: 300, h: 150 }; }
        var tot = SVG_PCT[an] === 'x' ? box.w : SVG_PCT[an] === 'y' ? box.h : Math.sqrt((box.w * box.w + box.h * box.h) / 2);
        av = fmtNum(svgLength(av, tot));
      }
      s += ' ' + an + '="' + escapeAttr(av.replace(/currentColor/gi, color)) + '"';
    }
    // a gradient's <stop> takes its colour from the cascade too
    var paint = n.localName === 'stop' ? SVG_STOP : SVG_PAINT;
    for (var p = 0; p < paint.length; p++) {
      var v = cs[paint[p]];
      if (v === undefined || v === '') continue;
      if (/^currentcolor$/i.test(v)) v = color;
      s += ' ' + paint[p] + '="' + escapeAttr(String(v)) + '"';
    }
    s += '>';
    for (var j = 0; j < n._c.length; j++) s += serializeSvg(n._c[j]);
    return s + '</' + n._qname + '>' + markers;
  }
  function render() {
    if (!doc || !doc.documentElement) return JSON.stringify({ v: generation, root: null });
    var root = renderJson(doc.documentElement, null);
    return '{"v":' + generation + ',"w":' + JSON.stringify(viewport.w) + ',"h":' + JSON.stringify(viewport.h) + ',"root":' + (root || 'null') + ',"title":' + JSON.stringify(doc.title) + '}';
  }

  // ---- input from the host -------------------------------------------------

  var nodesById = {};
  function nodeById(id) {
    var found = null;
    if (!doc) return null;
    // a piece of a drawn canvas (canvasRender): the canvas
    if (typeof id === 'string' && /^\d+c\d+t?$/.test(id)) id = parseInt(id, 10);
    if (doc.__id === id) return doc;
    (function walk(n) {
      if (found) return;
      if (n.__id === id) { found = n; return; }
      for (var i = 0; i < n._c.length && !found; i++) walk(n._c[i]);
    })(doc);
    return found;
  }
  function elementOf(n) { while (n && n.nodeType !== 1) n = n.parentNode; return n; }
  var clickCount = 0, lastDown = 0, downTarget = null;
  function mods(m) { return { ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta }; }
  function mouseInit(m, extra) {
    var o = mods(m);
    o.bubbles = true; o.cancelable = true; o.composed = true; o.view = G;
    o.clientX = m.x || 0; o.clientY = m.y || 0; o.button = m.button || 0; o.buttons = m.buttons || 0;
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  function hostInput(m) {
    var target = m.target !== undefined ? elementOf(nodeById(m.target)) : null;
    // the host's node may not take the pointer (pointer-events: none, e.g.
    // a faded-out slide stacked over the shown one): the one under it does
    // or is not under the point at all: the host's hit test does not see
    // transforms (a node of a zoomed React Flow viewport), the boxes do
    if (m.x !== undefined && (!target || !hittable(target) || (transformedUnder(target) && !under(target, m.x, m.y)))) target = hitTest(m.x, m.y) || target;
    var t = m.type;
    // a release without the host's node ends the press where it began,
    // unless that is in transformed content (where the boxes are the truth)
    if (t === 'up' && m.target === undefined && downTarget && downTarget.isConnected && !transformedUnder(downTarget)) target = downTarget;
    // a press, release or key is a user gesture (window.open may follow)
    if ((t === 'down' || t === 'up' || t === 'key') && typeof G.__activate === 'function') G.__activate();
    if (t === 'move') {
      var over = target || (doc && doc.documentElement);
      if (over !== hoverEl) {
        var old = hoverEl;
        hoverEl = over;
        changed();
        if (old && old.isConnected) { dispatch(old, new PointerEvent('pointerout', mouseInit(m, { relatedTarget: over }))); dispatch(old, new MouseEvent('mouseout', mouseInit(m, { relatedTarget: over }))); leaveEnter(old, over, m); }
        else leaveEnter(null, over, m);
        if (over) { dispatch(over, new PointerEvent('pointerover', mouseInit(m, { relatedTarget: old }))); dispatch(over, new MouseEvent('mouseover', mouseInit(m, { relatedTarget: old }))); }
      }
      if (over) { dispatch(over, new PointerEvent('pointermove', mouseInit(m, {}))); dispatch(over, new MouseEvent('mousemove', mouseInit(m, {}))); }
      return 'ok';
    }
    if (t === 'down') {
      if (!target) return 'no target';
      var nowT = now();
      clickCount = nowT - lastDown < 500 && downTarget === target ? clickCount + 1 : 1;
      lastDown = nowT;
      downTarget = target;
      activeEl = target;
      changed();
      var okp = dispatch(target, new PointerEvent('pointerdown', mouseInit(m, { buttons: 1, detail: clickCount })));
      var okm = okp && dispatch(target, new MouseEvent('mousedown', mouseInit(m, { buttons: 1, detail: clickCount })));
      if (okm) {
        // focus moves to the focusable element under the pointer
        var f = target;
        while (f && f.nodeType === 1 && !focusable(f)) f = f.parentNode;
        doc._focusVisible = false;
        if (f && f.nodeType === 1) focusElement(f); else if (doc._active) focusElement(null);
      }
      return 'ok';
    }
    if (t === 'up') {
      var tgt = target || downTarget;
      if (!tgt) return 'no target';
      dispatch(tgt, new PointerEvent('pointerup', mouseInit(m, { detail: clickCount })));
      dispatch(tgt, new MouseEvent('mouseup', mouseInit(m, { detail: clickCount })));
      activeEl = null;
      changed();
      var same = downTarget && (downTarget === tgt || downTarget.contains(tgt) || tgt.contains(downTarget));
      var clickOn = same ? (downTarget.contains(tgt) ? tgt : downTarget) : null;
      downTarget = null;
      if (clickOn && (m.button || 0) === 0) {
        if (!clickOn.disabled) {
          var ev = new PointerEvent('click', mouseInit(m, { detail: clickCount }));
          activatedClick(clickOn, ev);
          if (clickCount === 2) dispatch(clickOn, new MouseEvent('dblclick', mouseInit(m, { detail: 2 })));
        }
      } else if (clickOn && m.button === 2) {
        dispatch(clickOn, new MouseEvent('contextmenu', mouseInit(m, { button: 2 })));
      }
      return 'ok';
    }
    if (t === 'wheel') {
      var w = target || (doc && doc.body);
      if (!w) return 'ok';
      var okw = dispatch(w, new WheelEvent('wheel', mouseInit(m, { deltaX: m.dx || 0, deltaY: m.dy || 0 })));
      if (okw) scrollBy(w, m.dx || 0, m.dy || 0);
      return 'ok';
    }
    if (t === 'key' || t === 'keyup') {
      var k = doc && doc._active && doc._active.isConnected ? doc._active : doc && (doc.body || doc.documentElement);
      if (!k) return 'ok';
      var init = mods(m);
      init.key = m.key; init.code = m.code || codeOf(m.key); init.bubbles = true; init.cancelable = true; init.composed = true; init.view = G;
      if (t === 'keyup') { dispatch(k, new KeyboardEvent('keyup', init)); return 'ok'; }
      doc._focusVisible = true;
      var okd = dispatch(k, new KeyboardEvent('keydown', init));
      if (!okd) return 'ok';
      // a printable key types its character; `text` is what a key typed
      // when the host knows it (a character outside one UTF-16 unit)
      var typed = m.text !== undefined ? m.text : m.key.length === 1 && !m.ctrl && !m.meta ? m.key : null;
      if (typed !== null) {
        if (dispatch(k, new KeyboardEvent('keypress', init))) typeText(k, typed);
        return 'ok';
      }
      keyDefault(k, m);
      return 'ok';
    }
    if (t === 'text' || t === 'paste') {
      var a2 = doc && doc._active;
      if (!a2) return 'ok';
      if (t === 'paste') {
        var dt = new DataTransfer();
        dt.setData('text/plain', m.text);
        if (!dispatch(a2, new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))) return 'ok';
      }
      typeText(a2, m.text, t === 'paste' ? 'insertFromPaste' : 'insertText');
      return 'ok';
    }
    if (t === 'set') {
      // a form control's value from the host (an editor outside the page)
      if (!target) return 'no target';
      if (m.value !== undefined) target._value = String(m.value);
      if (m.checked !== undefined) target._checked = !!m.checked;
      changed();
      fireChange(target);
      return 'ok';
    }
    if (t === 'select') {
      // a text field's selection from the host (a click, a drag, a double
      // click on a word): the text before its anchor and before its focus
      if (!target || !isTextControl(target)) return 'no target';
      var tv = target.value;
      var fa = Math.min(String(m.focus || '').length, tv.length);
      var an = m.anchor === undefined ? fa : Math.min(String(m.anchor).length, tv.length);
      if (m.all) { an = 0; fa = tv.length; }
      if (m.word) {
        var isW = function (c) { return !/[\s.,;:!?()\[\]{}"'<>\/\\|+=*&^%$#@~`-]/.test(c); };
        an = fa; fa = an;
        if (an < tv.length && isW(tv.charAt(an)) || an > 0 && isW(tv.charAt(an - 1))) {
          while (an > 0 && isW(tv.charAt(an - 1))) an--;
          while (fa < tv.length && isW(tv.charAt(fa))) fa++;
        } else if (fa < tv.length) fa++;
      }
      if (doc._active !== target) focusElement(target);
      selectRange(target, an, fa);
      changed();
      if (an !== fa) dispatch(target, new Event('select', { bubbles: true }));
      return 'ok';
    }
    if (t === 'focus') { if (target) { doc._focusVisible = true; focusElement(target); } else focusElement(null); return 'ok'; }
    if (t === 'scroll') {
      if (target) { target.scrollLeft = m.left || 0; target.scrollTop = m.top || 0; dispatch(target, new Event('scroll', { bubbles: false })); scrolled(target); }
      return 'ok';
    }
    return 'unknown input ' + t;
  }
  function leaveEnter(from, to, m) {
    var fromChain = [], toChain = [];
    for (var a = from; a && a.nodeType === 1; a = a.parentNode) fromChain.push(a);
    for (var b = to; b && b.nodeType === 1; b = b.parentNode) toChain.push(b);
    for (var i = 0; i < fromChain.length; i++) if (toChain.indexOf(fromChain[i]) < 0) { dispatch(fromChain[i], new PointerEvent('pointerleave', mouseInit(m, { bubbles: false, relatedTarget: to }))); dispatch(fromChain[i], new MouseEvent('mouseleave', Object.assign(mouseInit(m, { relatedTarget: to }), { bubbles: false }))); }
    for (var j = toChain.length - 1; j >= 0; j--) if (fromChain.indexOf(toChain[j]) < 0) { dispatch(toChain[j], new PointerEvent('pointerenter', Object.assign(mouseInit(m, { relatedTarget: from }), { bubbles: false }))); dispatch(toChain[j], new MouseEvent('mouseenter', Object.assign(mouseInit(m, { relatedTarget: from }), { bubbles: false }))); }
  }
  function scrollBy(el, dx, dy) {
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      var cs = computedOf(n);
      var b = boxes[n.__id];
      if (!b) continue;
      var can = (cs['overflow-y'] === 'auto' || cs['overflow-y'] === 'scroll') && (b[7] || 0) > (b[5] || b[3]);
      if (can) {
        var max = (b[7] || 0) - (b[5] || b[3]);
        var top = Math.max(0, Math.min(max, n.scrollTop + dy));
        if (top !== n.scrollTop) { n.scrollTop = top; scrolled(n); dispatch(n, new Event('scroll')); return; }
      }
    }
    // then the page itself (the viewport, whose scroll is the root's)
    var root = doc && doc.documentElement;
    if (!root || (computedOf(root)['overflow-y'] || '') === 'hidden') return;
    var dmax = Math.max(0, pageHeight() - viewport.h);
    var dtop = Math.max(0, Math.min(dmax, root.scrollTop + dy));
    if (dtop !== root.scrollTop) { root.scrollTop = dtop; scrolled(root); dispatch(doc, new Event('scroll')); }
  }
  // how tall the page's content is: the root's box and the body's bottom
  function pageHeight() {
    var root = doc && doc.documentElement, h = 0;
    var b = root && boxes[root.__id];
    if (b) h = Math.max(b[3] || 0, b[7] || 0);
    var body = doc && doc.body;
    var bb = body && boxes[body.__id];
    if (bb) h = Math.max(h, (bb[1] || 0) + (bb[3] || 0) + (parseFloat(computedOf(body)['margin-bottom']) || 0));
    return h;
  }
  function codeOf(k) {
    if (/^[a-zA-Z]$/.test(k)) return 'Key' + k.toUpperCase();
    if (/^\d$/.test(k)) return 'Digit' + k;
    if (k === ' ') return 'Space';
    return k;
  }
  function isTextControl(el) {
    if (!el) return false;
    if (el.localName === 'textarea') return true;
    if (el.localName === 'input') return /^(text|search|tel|url|email|password|number|date|time|datetime-local|month|week)$/.test(el.type);
    return false;
  }
  // anchor and focus as a range with its direction
  function selectRange(el, anchor, focus) {
    el.selectionStart = Math.min(anchor, focus);
    el.selectionEnd = Math.max(anchor, focus);
    el.selectionDirection = focus < anchor ? 'backward' : anchor === focus ? 'none' : 'forward';
  }
  function typeText(el, text, kind) {
    kind = kind || 'insertText';
    if (isTextControl(el)) {
      if (el.readOnly || el.disabled) return;
      var before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, data: text, inputType: kind });
      if (!dispatch(el, before)) return;
      var v = el.value;
      var s = Math.min(el.selectionStart, v.length), e = Math.min(el.selectionEnd, v.length);
      if (el.localName === 'input') text = text.replace(/[\r\n]/g, '');
      var max = el.maxLength;
      if (max >= 0 && v.length - (e - s) + text.length > max) text = text.slice(0, Math.max(0, max - (v.length - (e - s))));
      el._value = v.slice(0, s) + text + v.slice(e);
      el.selectionStart = el.selectionEnd = s + text.length;
      changed();
      dispatch(el, new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: kind }));
      return;
    }
    if (el.isContentEditable) {
      el.appendChild(el.ownerDocument.createTextNode(text));
      dispatch(el, new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: kind }));
    }
  }
  function keyDefault(el, m) {
    var k = m.key;
    if (k === 'Tab') {
      var order = tabOrder();
      if (!order.length) return;
      var i = order.indexOf(el);
      var next = m.shift ? order[(i <= 0 ? order.length : i) - 1] : order[(i + 1) % order.length];
      focusElement(next);
      return;
    }
    if (isTextControl(el)) {
      var v = el.value, s = el.selectionStart, e = el.selectionEnd;
      if (k === 'Backspace' || k === 'Delete') {
        if (el.readOnly || el.disabled) return;
        if (s === e) { if (k === 'Backspace' && s > 0) s--; else if (k === 'Delete' && e < v.length) e++; }
        if (s === e) return;
        var kind = k === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward';
        if (!dispatch(el, new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: kind }))) return;
        el._value = v.slice(0, s) + v.slice(e);
        el.selectionStart = el.selectionEnd = s;
        changed();
        dispatch(el, new InputEvent('input', { bubbles: true, composed: true, inputType: kind }));
        return;
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
        var back = el.selectionDirection === 'backward';
        var focusAt = back ? s : e, anchorAt = back ? e : s;
        var to = k === 'Home' ? 0 : k === 'End' ? v.length : k === 'ArrowLeft' ? (m.shift || s === e ? focusAt - 1 : s) : (m.shift || s === e ? focusAt + 1 : e);
        to = Math.max(0, Math.min(v.length, to));
        // Shift extends the selection from its anchor; else the caret moves
        if (m.shift) selectRange(el, anchorAt, to);
        else { el.selectionStart = el.selectionEnd = to; el.selectionDirection = 'none'; }
        changed();
        return;
      }
      if (k === 'Enter') {
        if (el.localName === 'textarea') { typeText(el, '\n', 'insertLineBreak'); return; }
        var f = el.form;
        if (f) { var sub = f.querySelector('button:not([type]),button[type=submit],input[type=submit]'); if (sub) sub.click(); else submitForm(el); }
        return;
      }
      if (m.ctrl || m.meta) {
        if (k === 'a') { el.selectionStart = 0; el.selectionEnd = v.length; changed(); }
      }
      return;
    }
    if ((k === 'Enter' && (el.localName === 'button' || el.localName === 'a' || (el.localName === 'input' && /^(button|submit|reset|checkbox|radio)$/.test(el.type) && el.type !== 'checkbox'))) || (k === ' ' && (el.localName === 'button' || (el.localName === 'input' && /^(button|submit|reset|checkbox|radio)$/.test(el.type))))) {
      el.click();
      return;
    }
    if (el.localName === 'select' && (k === 'ArrowDown' || k === 'ArrowUp')) {
      var opts = el.options, idx = el.selectedIndex + (k === 'ArrowDown' ? 1 : -1);
      if (idx >= 0 && idx < opts.length) { el.selectedIndex = idx; fireChange(el); }
    }
  }

  class DataTransfer {
    constructor() { this._d = {}; this.dropEffect = 'none'; this.effectAllowed = 'all'; this.files = []; this.items = []; }
    get types() { return Object.keys(this._d); }
    setData(t, v) { this._d[String(t).toLowerCase()] = String(v); }
    getData(t) { t = String(t).toLowerCase(); if (t === 'text') t = 'text/plain'; return this._d[t] || ''; }
    clearData(t) { if (t) delete this._d[t]; else this._d = {}; }
    setDragImage() {}
  }

  // ---- scripts -------------------------------------------------------------

  // a script element a page script inserted runs here: its text at once,
  // its src when the host has answered the fetch (__fetchResource; without
  // a host that fetches, it fails), then load or
  // error on the element, as in a browser
  function scriptInserted(el) {
    if (el.getAttribute('type') && !/^(text\/javascript|application\/javascript|module|text\/babel)$/i.test(el.getAttribute('type'))) return;
    if (el._started) return;
    el._started = true;
    var src = el.getAttribute('src');
    if (src === null) { runScript(el, el.textContent); return; }
    loadResource(resolveURL(src), function (status, text) {
      if (status < 200 || status > 299) {
        if (G.console) G.console.warn('script ' + resolveURL(src) + ' not loaded: ' + (status ? 'HTTP ' + status : 'no network'));
        dispatch(el, new Event('error'));
        return;
      }
      // a page, not a script (an HTML answer for a path that is not a
      // script): an error, not a JavaScript syntax error from evaluating it
      if (/^\s*</.test(String(text))) {
        if (G.console) G.console.warn('script ' + resolveURL(src) + ' not loaded: it is an HTML page, not JavaScript');
        dispatch(el, new Event('error'));
        return;
      }
      runScript(el, text);
      dispatch(el, new Event('load'));
    });
  }
  function runScript(el, text) {
    var prev = doc.currentScript;
    doc.currentScript = el;
    // in the global scope, as a classic script
    try { (0, eval)(String(text)); } catch (e) { reportError(e); }
    doc.currentScript = prev;
  }
  function scriptsOfPage() {
    var out = [];
    if (!doc) return '[]';
    eachElement(doc, function (e) {
      if (e.localName !== 'script' || e.namespaceURI !== HTML_NS) return;
      var type = e.getAttribute('type');
      if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type)) return;
      var src = e.getAttribute('src');
      var isModule = !!type && type.toLowerCase() === 'module';
      out.push({ id: e.__id, src: src, url: src ? resolveURL(src) : null, text: src ? null : e.textContent, defer: e.hasAttribute('defer') || isModule, async: e.hasAttribute('async'), module: isModule });
    });
    // classic scripts in order, deferred ones after
    return JSON.stringify(out.filter(function (s) { return !s.defer; }).concat(out.filter(function (s) { return s.defer; })));
  }
  function stylesOfPage() {
    var out = [];
    if (!doc) return '[]';
    eachElement(doc, function (e) {
      if (e.localName === 'link' && /(^|\s)stylesheet(\s|$)/i.test(e.getAttribute('rel') || '') && e.getAttribute('href')) out.push({ id: e.__id, href: e.getAttribute('href'), url: resolveURL(e.getAttribute('href')) });
    });
    return JSON.stringify(out);
  }

  // ---- URLs ----------------------------------------------------------------

  function parseURL(u) {
    var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)(?:\/\/(?:([^:@\/]*)(?::([^@\/]*))?@)?([^:\/?#]*)(?::(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(u));
    if (!m) return null;
    var protocol = m[1].toLowerCase();
    var host = m[4] || '';
    var port = m[5] || '';
    var special = /^(https?|ftp|wss?|file):$/.test(protocol);
    var path = m[6] || (special ? '/' : '');
    if (special) path = normalizePath(path);
    return {
      protocol: protocol, username: m[2] || '', password: m[3] || '', hostname: host.toLowerCase(), port: port,
      host: host.toLowerCase() + (port ? ':' + port : ''), pathname: path, search: m[7] && m[7] !== '?' ? m[7] : '', hash: m[8] && m[8] !== '#' ? m[8] : '',
      origin: special && protocol !== 'file:' ? protocol + '//' + host.toLowerCase() + (port ? ':' + port : '') : 'null', special: special, hasAuthority: m[4] !== undefined
    };
  }
  function normalizePath(p) {
    var segs = p.split('/'), out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === '..') { if (out.length > 1) out.pop(); if (i === segs.length - 1) out.push(''); }
      else if (s === '.') { if (i === segs.length - 1) out.push(''); }
      else out.push(s);
    }
    var r = out.join('/');
    return r.charAt(0) === '/' ? r : '/' + r;
  }
  function joinURL(rel, base) {
    rel = String(rel).trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(rel)) return rel;
    var b = parseURL(base);
    if (!b) return rel;
    var prefix = b.protocol + (b.hasAuthority || b.special ? '//' + (b.username ? b.username + (b.password ? ':' + b.password : '') + '@' : '') + b.host : '');
    if (rel.slice(0, 2) === '//') return b.protocol + rel;
    if (rel.charAt(0) === '#') return prefix + b.pathname + b.search + rel;
    if (rel.charAt(0) === '?') return prefix + b.pathname + rel;
    if (rel === '') return prefix + b.pathname + b.search;
    if (rel.charAt(0) === '/') return prefix + rel;
    var dir = b.pathname.replace(/[^\/]*$/, '');
    return prefix + dir + rel;
  }
  function resolveURL(u) {
    var base = doc ? doc._base || doc._url : 'about:blank';
    var j = joinURL(u, base);
    var p = parseURL(j);
    if (!p) return j;
    return p.protocol + (p.hasAuthority || p.special ? '//' + p.host : '') + p.pathname + p.search + p.hash;
  }

  class URLSearchParams {
    constructor(init) {
      this._l = [];
      if (init === undefined || init === null) return;
      if (typeof init === 'string') { this._parse(init); return; }
      if (init instanceof URLSearchParams) { this._l = init._l.map(function (p) { return p.slice(); }); return; }
      if (Array.isArray(init) || (init && typeof init[Symbol.iterator] === 'function')) { for (var p of init) this._l.push([String(p[0]), String(p[1])]); return; }
      for (var k in init) this._l.push([k, String(init[k])]);
    }
    _parse(s) {
      s = s.replace(/^\?/, '');
      if (!s) return;
      var parts = s.split('&');
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var e = parts[i].indexOf('=');
        var k = e < 0 ? parts[i] : parts[i].slice(0, e), v = e < 0 ? '' : parts[i].slice(e + 1);
        this._l.push([decodeForm(k), decodeForm(v)]);
      }
    }
    _update() { if (this._url) { var s = this.toString(); this._url._search = s ? '?' + s : ''; } }
    get size() { return this._l.length; }
    append(k, v) { this._l.push([String(k), String(v)]); this._update(); }
    delete(k, v) { this._l = this._l.filter(function (p) { return p[0] !== String(k) || (v !== undefined && p[1] !== String(v)); }); this._update(); }
    get(k) { for (var i = 0; i < this._l.length; i++) if (this._l[i][0] === String(k)) return this._l[i][1]; return null; }
    getAll(k) { return this._l.filter(function (p) { return p[0] === String(k); }).map(function (p) { return p[1]; }); }
    has(k, v) { return this._l.some(function (p) { return p[0] === String(k) && (v === undefined || p[1] === String(v)); }); }
    set(k, v) {
      k = String(k); v = String(v);
      var hit = false;
      this._l = this._l.filter(function (p) { if (p[0] !== k) return true; if (hit) return false; hit = true; p[1] = v; return true; });
      if (!hit) this._l.push([k, v]);
      this._update();
    }
    sort() { this._l.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); this._update(); }
    forEach(fn, t) { for (var i = 0; i < this._l.length; i++) fn.call(t, this._l[i][1], this._l[i][0], this); }
    keys() { return this._l.map(function (p) { return p[0]; })[Symbol.iterator](); }
    values() { return this._l.map(function (p) { return p[1]; })[Symbol.iterator](); }
    entries() { return this._l.map(function (p) { return [p[0], p[1]]; })[Symbol.iterator](); }
    toString() { return this._l.map(function (p) { return encodeForm(p[0]) + '=' + encodeForm(p[1]); }).join('&'); }
  }
  URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
  function decodeForm(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } }
  function encodeForm(s) { return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }

  class URL {
    constructor(u, base) {
      var s = String(u);
      if (base !== undefined) {
        var bp = parseURL(String(base));
        if (!bp) throw new TypeError("Failed to construct 'URL': Invalid base URL");
        s = joinURL(s, String(base));
      }
      var p = parseURL(s);
      if (!p || (p.special && p.protocol !== 'file:' && !p.hostname)) throw new TypeError("Failed to construct 'URL': Invalid URL");
      this._p = p;
      this._search = p.search;
      this._sp = null;
    }
    get protocol() { return this._p.protocol; }
    set protocol(v) { this._p.protocol = String(v).replace(/:?$/, ':'); }
    get username() { return this._p.username; }
    get password() { return this._p.password; }
    get host() { return this._p.host; }
    set host(v) { var m = String(v).split(':'); this._p.hostname = m[0]; this._p.port = m[1] || ''; this._p.host = String(v); }
    get hostname() { return this._p.hostname; }
    set hostname(v) { this._p.hostname = String(v); this._p.host = this._p.hostname + (this._p.port ? ':' + this._p.port : ''); }
    get port() { return this._p.port; }
    set port(v) { this._p.port = String(v); this._p.host = this._p.hostname + (this._p.port ? ':' + this._p.port : ''); }
    get pathname() { return this._p.pathname; }
    set pathname(v) { v = String(v); this._p.pathname = this._p.special ? normalizePath(v.charAt(0) === '/' ? v : '/' + v) : v; }
    get search() { return this._search; }
    set search(v) { v = String(v); this._search = v && v !== '?' ? (v.charAt(0) === '?' ? v : '?' + v) : ''; if (this._sp) { this._sp._l = []; this._sp._parse(this._search); } }
    get searchParams() { if (!this._sp) { this._sp = new URLSearchParams(this._search); this._sp._url = this; } return this._sp; }
    get hash() { return this._p.hash; }
    set hash(v) { v = String(v); this._p.hash = v && v !== '#' ? (v.charAt(0) === '#' ? v : '#' + v) : ''; }
    get origin() { return this._p.origin; }
    get href() {
      var p = this._p;
      var auth = p.hasAuthority || p.special ? '//' + (p.username ? p.username + (p.password ? ':' + p.password : '') + '@' : '') + p.host : '';
      return p.protocol + auth + p.pathname + this._search + p.hash;
    }
    set href(v) { var n = new URL(v); this._p = n._p; this._search = n._search; this._sp = null; }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  URL.canParse = function (u, b) { try { new URL(u, b); return true; } catch (e) { return false; } };
  URL.parse = function (u, b) { try { return new URL(u, b); } catch (e) { return null; } };
  var blobUrls = {};
  var blobId = 1;
  URL.createObjectURL = function (b) { var u = 'blob:' + (G.location ? G.location.origin : 'null') + '/' + (blobId++); blobUrls[u] = b; return u; };
  URL.revokeObjectURL = function (u) { delete blobUrls[u]; };

  // ---- text encoding, base64 -----------------------------------------------

  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s) {
      s = s === undefined ? '' : String(s);
      var out = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { var d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd; }
        else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
    encodeInto(s, dest) { var b = this.encode(s); var n = Math.min(b.length, dest.length); for (var i = 0; i < n; i++) dest[i] = b[i]; return { read: s.length, written: n }; }
  }
  class TextDecoder {
    constructor(label, opts) { this._enc = String(label || 'utf-8').toLowerCase(); this.fatal = !!(opts && opts.fatal); this.ignoreBOM = !!(opts && opts.ignoreBOM); }
    get encoding() { return this._enc === 'utf8' ? 'utf-8' : this._enc; }
    decode(buf) {
      if (!buf) return '';
      var b = buf instanceof Uint8Array ? buf : buf.buffer ? new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength) : new Uint8Array(buf);
      if (this._enc === 'latin1' || this._enc === 'iso-8859-1' || this._enc === 'ascii' || this._enc === 'windows-1252') { var o = ''; for (var x = 0; x < b.length; x++) o += String.fromCharCode(b[x]); return o; }
      var out = '', i = 0;
      if (!this.ignoreBOM && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
      while (i < b.length) {
        var c = b[i++];
        var cp;
        if (c < 0x80) cp = c;
        else if (c >= 0xc2 && c < 0xe0 && i < b.length && (b[i] & 0xc0) === 0x80) { cp = ((c & 31) << 6) | (b[i++] & 63); }
        else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length && (b[i] & 0xc0) === 0x80 && (b[i + 1] & 0xc0) === 0x80) { cp = ((c & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63); i += 2; if (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000)) cp = -1; }
        else if (c >= 0xf0 && c < 0xf5 && i + 2 < b.length && (b[i] & 0xc0) === 0x80 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) { cp = ((c & 7) << 18) | ((b[i] & 63) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; if (cp < 0x10000 || cp > 0x10ffff) cp = -1; }
        else cp = -1;
        if (cp < 0) { if (this.fatal) throw new TypeError('The encoded data was not valid for encoding utf-8'); cp = 0xfffd; }
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function btoa(s) {
    s = String(s);
    var out = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw DOMException("Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.", 'InvalidCharacterError');
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63) + (i + 1 < s.length ? B64.charAt((n >> 6) & 63) : '=') + (i + 2 < s.length ? B64.charAt(n & 63) : '=');
    }
    return out;
  }
  function atob(s) {
    s = String(s).replace(/[\t\n\f\r ]/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+\/]/.test(s)) throw DOMException("Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.", 'InvalidCharacterError');
    var out = '', bits = 0, acc = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 6) | B64.indexOf(s.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); }
    }
    return out;
  }

  // ---- blobs, files, abort -------------------------------------------------

  class Blob {
    constructor(parts, opts) {
      this.type = (opts && opts.type) || '';
      var s = '';
      parts = parts || [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p instanceof Blob) s += p._s;
        else if (p instanceof ArrayBuffer || ArrayBuffer.isView(p)) s += new TextDecoder('latin1').decode(p);
        else s += unescape(encodeURIComponent(String(p)));
      }
      this._s = s;
    }
    get size() { return this._s.length; }
    text() { return Promise.resolve(new TextDecoder().decode(this._bytes())); }
    arrayBuffer() { return Promise.resolve(this._bytes().buffer); }
    _bytes() { var b = new Uint8Array(this._s.length); for (var i = 0; i < this._s.length; i++) b[i] = this._s.charCodeAt(i); return b; }
    slice(a, b, type) { var x = new Blob([], { type: type || this.type }); x._s = this._s.slice(a, b); return x; }
  }
  class File extends Blob {
    constructor(parts, name, opts) { super(parts, opts); this.name = String(name); this.lastModified = (opts && opts.lastModified) || Date.now(); }
  }
  class FileReader extends EventTarget {
    constructor() { super(); this.result = null; this.readyState = 0; this.error = null; }
    _done(r) { var self = this; setTimeout(function () { self.result = r; self.readyState = 2; var ev = new ProgressEvent('load'); if (self.onload) self.onload(ev); dispatch(self, ev); var e2 = new ProgressEvent('loadend'); if (self.onloadend) self.onloadend(e2); dispatch(self, e2); }, 0); }
    readAsText(b) { this._done(new TextDecoder().decode(b._bytes())); }
    readAsDataURL(b) { this._done('data:' + (b.type || 'application/octet-stream') + ';base64,' + btoa(b._s)); }
    readAsArrayBuffer(b) { this._done(b._bytes().buffer); }
    readAsBinaryString(b) { this._done(b._s); }
    abort() {}
  }
  class AbortSignal extends EventTarget {
    constructor() { super(); this.aborted = false; this.reason = undefined; this.onabort = null; }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static abort(reason) { var c = new AbortController(); c.abort(reason); return c.signal; }
    static timeout(ms) { var c = new AbortController(); setTimeout(function () { c.abort(DOMException('signal timed out', 'TimeoutError')); }, ms); return c.signal; }
    static any(list) { var c = new AbortController(); list.forEach(function (s) { if (s.aborted) c.abort(s.reason); else s.addEventListener('abort', function () { c.abort(s.reason); }); }); return c.signal; }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason) {
      var s = this.signal;
      if (s.aborted) return;
      s.aborted = true;
      s.reason = reason === undefined ? DOMException('signal is aborted without reason', 'AbortError') : reason;
      var ev = new Event('abort');
      if (s.onabort) s.onabort(ev);
      dispatch(s, ev);
    }
  }

  // ---- messaging, timers, frames -------------------------------------------

  var t0 = Date.now();
  function now() { return Date.now() - t0; }
  var performance = {
    now: now, timeOrigin: t0,
    mark: function (n) { return { name: n, startTime: now(), entryType: 'mark', duration: 0 }; },
    measure: function (n) { return { name: n, startTime: 0, duration: now(), entryType: 'measure' }; },
    getEntriesByName: function () { return []; }, getEntriesByType: function () { return []; }, getEntries: function () { return []; },
    clearMarks: function () {}, clearMeasures: function () {}, timing: { navigationStart: t0 }, navigation: { type: 0 }
  };
  // a realm started from a snapshot of an earlier one (the host's code
  // cache): its clock starts now, not when the snapshot was taken
  G.__resume = function () {
    t0 = Date.now();
    performance.timeOrigin = t0;
    performance.timing.navigationStart = t0;
    return 'ok';
  };

  class MessagePort extends EventTarget {
    constructor() { super(); this._other = null; this._started = false; this._queue = []; this._closed = false; this._onmessage = null; }
    get onmessage() { return this._onmessage; }
    set onmessage(fn) { this._onmessage = fn; this.start(); }
    postMessage(data) {
      var o = this._other;
      if (!o || this._closed) return;
      var copy = structuredCloneImpl(data);
      setTimeout(function () { o._receive(copy); }, 0);
    }
    _receive(data) {
      if (this._closed) return;
      if (!this._started) { this._queue.push(data); return; }
      var ev = new MessageEvent('message', { data: data });
      if (this._onmessage) { try { this._onmessage.call(this, ev); } catch (e) { reportError(e); } }
      invoke(this, ev, 2);
    }
    start() { if (this._started) return; this._started = true; var q = this._queue; this._queue = []; for (var i = 0; i < q.length; i++) this._receive(q[i]); }
    close() { this._closed = true; }
  }
  class MessageChannel {
    constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); this.port1._other = this.port2; this.port2._other = this.port1; }
  }
  class BroadcastChannel extends EventTarget {
    constructor(name) { super(); this.name = name; this.onmessage = null; }
    postMessage() {}
    close() {}
  }

  function structuredCloneImpl(v, seen) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'symbol') throw DOMException((typeof v === 'function' ? (v.name || 'function') : 'Symbol()') + ' could not be cloned.', 'DataCloneError');
      return v;
    }
    seen = seen || new Map();
    if (seen.has(v)) return seen.get(v);
    var out;
    if (v instanceof Date) out = new Date(v.getTime());
    else if (v instanceof RegExp) out = new RegExp(v.source, v.flags);
    else if (v instanceof Map) { out = new Map(); seen.set(v, out); v.forEach(function (x, k) { out.set(structuredCloneImpl(k, seen), structuredCloneImpl(x, seen)); }); return out; }
    else if (v instanceof Set) { out = new Set(); seen.set(v, out); v.forEach(function (x) { out.add(structuredCloneImpl(x, seen)); }); return out; }
    else if (v instanceof ArrayBuffer) out = v.slice(0);
    else if (ArrayBuffer.isView(v)) out = new v.constructor(v);
    else if (v instanceof Error) { out = new (G[v.name] || Error)(v.message); if (v.stack) out.stack = v.stack; }
    else if (v instanceof Blob) out = v;
    else if (v instanceof Node) throw DOMException('Failed to execute \'postMessage\': ' + v.toString() + ' object could not be cloned.', 'DataCloneError');
    else if (Array.isArray(v)) { out = []; seen.set(v, out); for (var i = 0; i < v.length; i++) out[i] = structuredCloneImpl(v[i], seen); return out; }
    else {
      out = {};
      seen.set(v, out);
      var keys = Object.keys(v);
      for (var k = 0; k < keys.length; k++) out[keys[k]] = structuredCloneImpl(v[keys[k]], seen);
      return out;
    }
    seen.set(v, out);
    return out;
  }

  var frameCallbacks = [];
  var frameId = 1;
  function requestAnimationFrame(fn) {
    var id = frameId++;
    frameCallbacks.push({ id: id, fn: fn });
    if (frameCallbacks.length === 1) setTimeout(runFrame, 16);
    return id;
  }
  function cancelAnimationFrame(id) { for (var i = 0; i < frameCallbacks.length; i++) if (frameCallbacks[i].id === id) { frameCallbacks.splice(i, 1); return; } }
  function runFrame() {
    var list = frameCallbacks;
    frameCallbacks = [];
    var t = now();
    for (var i = 0; i < list.length; i++) { try { list[i].fn(t); } catch (e) { reportError(e); } }
  }
  var idleId = 1;
  function requestIdleCallback(fn) { var id = idleId++; setTimeout(function () { fn({ didTimeout: false, timeRemaining: function () { return 50; } }); }, 1); return id; }
  function cancelIdleCallback() {}

  // ---- storage -------------------------------------------------------------

  function makeStorage() {
    var data = {};
    var s = {
      get length() { return Object.keys(data).length; },
      key: function (i) { var k = Object.keys(data); return i < k.length ? k[i] : null; },
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = {}; }
    };
    return s;
  }

  // ---- custom elements -----------------------------------------------------

  var customElementsRegistry = {};
  var customElements = {
    define: function (name, cls) {
      if (customElementsRegistry[name]) throw DOMException("Failed to execute 'define' on 'CustomElementRegistry': the name \"" + name + '" has already been used with this registry', 'NotSupportedError');
      customElementsRegistry[name] = cls;
      var p = cls.prototype;
      var conn = p.connectedCallback, disc = p.disconnectedCallback, attr = p.attributeChangedCallback;
      var observed = cls.observedAttributes || [];
      if (conn) p._connected = function () { conn.call(this); };
      if (disc) p._disconnected = function () { disc.call(this); };
      if (attr) p._attrHook = function (n, o, v) { if (observed.indexOf(n) >= 0) attr.call(this, n, o, v); };
    },
    get: function (name) { return customElementsRegistry[name]; },
    whenDefined: function () { return Promise.resolve(); },
    upgrade: function () {}
  };

  // ---- the window ----------------------------------------------------------

  function locationOf(url) {
    var l = {
      get href() { return doc ? doc._url : 'about:blank'; },
      set href(v) { G.open(resolveURL(v), '_self'); },
      assign: function (v) { G.open(resolveURL(v), '_self'); },
      replace: function (v) { G.open(resolveURL(v), '_self'); },
      reload: function () {},
      toString: function () { return this.href; }
    };
    ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(function (k) {
      Object.defineProperty(l, k, {
        get: function () { var p = parseURL(doc ? doc._url : 'about:blank'); return p ? p[k] : ''; },
        set: function (v) { if (k === 'hash' && doc) { var p = parseURL(doc._url); var old = doc._url; doc._url = old.replace(/#.*$/, '') + (v ? (String(v).charAt(0) === '#' ? v : '#' + v) : ''); var ev = new Event('hashchange'); ev.oldURL = old; ev.newURL = doc._url; setTimeout(function () { dispatch(G, ev); }, 0); } },
        enumerable: true, configurable: true
      });
    });
    return l;
  }
  var historyStates = [{ state: null }];
  var history = {
    get length() { return historyStates.length; },
    get state() { return historyStates[historyStates.length - 1].state; },
    scrollRestoration: 'auto',
    pushState: function (st, t, url) { historyStates.push({ state: st }); if (url !== undefined && url !== null && doc) doc._url = resolveURL(url); },
    replaceState: function (st, t, url) { historyStates[historyStates.length - 1] = { state: st }; if (url !== undefined && url !== null && doc) doc._url = resolveURL(url); },
    back: function () { if (historyStates.length > 1) { historyStates.pop(); var ev = new Event('popstate'); ev.state = this.state; setTimeout(function () { dispatch(G, ev); }, 0); } },
    forward: function () {},
    go: function (n) { if (n < 0) this.back(); }
  };
  var navigator = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 RangerDOM/0.1',
    appName: 'Netscape', appVersion: '5.0', appCodeName: 'Mozilla', product: 'Gecko', vendor: 'Google Inc.', platform: 'Linux x86_64',
    language: 'en-US', languages: ['en-US', 'en'], onLine: true, cookieEnabled: true, hardwareConcurrency: 4, maxTouchPoints: 0,
    doNotTrack: null, webdriver: false, pdfViewerEnabled: false,
    userAgentData: { brands: [{ brand: 'Chromium', version: '130' }], mobile: false, platform: 'Linux', getHighEntropyValues: function () { return Promise.resolve({}); } },
    clipboard: {
      writeText: function (t) { if (typeof __out !== 'undefined') __out.push(JSON.stringify({ tag: '__Clipboard', text: String(t) })); return Promise.resolve(); },
      readText: function () { return Promise.reject(DOMException('Read permission denied.', 'NotAllowedError')); },
      write: function () { return Promise.resolve(); },
      read: function () { return Promise.reject(DOMException('Read permission denied.', 'NotAllowedError')); }
    },
    permissions: { query: function () { return Promise.resolve({ state: 'denied', addEventListener: function () {}, onchange: null }); } },
    mediaDevices: { getUserMedia: function () { return Promise.reject(DOMException('Permission denied', 'NotAllowedError')); }, enumerateDevices: function () { return Promise.resolve([]); }, addEventListener: function () {} },
    serviceWorker: undefined,
    storage: { estimate: function () { return Promise.resolve({ quota: 0, usage: 0 }); }, persist: function () { return Promise.resolve(false); } },
    sendBeacon: function () { return false; },
    vibrate: function () { return false; },
    share: function () { return Promise.reject(DOMException('Share canceled', 'AbortError')); },
    canShare: function () { return false; },
    javaEnabled: function () { return false; },
    locks: { request: function (n, o, cb) { var f = typeof o === 'function' ? o : cb; return Promise.resolve().then(function () { return f({ name: n }); }); } }
  };

  var screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0, addEventListener: function () {}, removeEventListener: function () {} } };

  // the window is an EventTarget: keep prelude's 'message' listeners
  var preludeAdd = G.addEventListener, preludeRemove = G.removeEventListener;
  G._ls = null;
  G.addEventListener = function (type, fn, opts) {
    if (type === 'message' && preludeAdd) { preludeAdd(type, fn); return; }
    EventTarget.prototype.addEventListener.call(G, type, fn, opts);
  };
  G.removeEventListener = function (type, fn, opts) {
    if (type === 'message' && preludeRemove) { preludeRemove(type, fn); return; }
    EventTarget.prototype.removeEventListener.call(G, type, fn, opts);
  };
  G.dispatchEvent = function (ev) { return dispatch(G, ev); };

  function install(name, v) { G[name] = v; }
  var exportsList = {
    DOMException: DOMException, Event: Event, CustomEvent: CustomEvent, UIEvent: UIEvent, FocusEvent: FocusEvent, MouseEvent: MouseEvent,
    PointerEvent: PointerEvent, WheelEvent: WheelEvent, KeyboardEvent: KeyboardEvent, InputEvent: InputEvent, CompositionEvent: CompositionEvent,
    MessageEvent: MessageEvent, ProgressEvent: ProgressEvent, ErrorEvent: ErrorEvent, AnimationEvent: AnimationEvent, TransitionEvent: TransitionEvent,
    ClipboardEvent: ClipboardEvent, DragEvent: DragEvent, EventTarget: EventTarget, Node: Node, CharacterData: CharacterData, Text: Text,
    CDATASection: CDATASection, Comment: Comment, DocumentFragment: DocumentFragment, DocumentType: DocumentType, ShadowRoot: ShadowRoot,
    Attr: Attr, DOMTokenList: DOMTokenList, CSSStyleDeclaration: CSSStyleDeclaration, Element: Element, HTMLElement: HTMLElement,
    SVGElement: SVGElement, SVGGraphicsElement: SVGGraphicsElement, SVGSVGElement: SVGSVGElement, SVGPathElement: SVGPathElement,
    Document: Document, HTMLDocument: HTMLDocument, XMLDocument: XMLDocument, NodeFilter: NodeFilter, TreeWalker: TreeWalker,
    NodeIterator: NodeIterator, Range: Range, StaticRange: StaticRange, MutationObserver: MutationObserver, MutationRecord: MutationRecord,
    ResizeObserver: ResizeObserver, IntersectionObserver: IntersectionObserver, DOMRect: DOMRect, DOMRectReadOnly: DOMRect, DOMMatrix: DOMMatrix, DOMMatrixReadOnly: DOMMatrix, WebKitCSSMatrix: DOMMatrix, DOMPoint: DOMPoint, DOMPointReadOnly: DOMPoint, SVGMatrix: DOMMatrix, SVGPoint: DOMPoint, DOMParser: DOMParser,
    XMLSerializer: XMLSerializer, CSSRule: CSSRule, CSSStyleRule: CSSStyleRule, CSSMediaRule: CSSMediaRule, CSSStyleSheet: CSSStyleSheet,
    StyleSheet: CSSStyleSheet, MediaQueryList: MediaQueryList, URL: URL, URLSearchParams: URLSearchParams, TextEncoder: TextEncoder,
    TextDecoder: TextDecoder, Blob: Blob, File: File, FileReader: FileReader, AbortController: AbortController, AbortSignal: AbortSignal,
    MessageChannel: MessageChannel, MessagePort: MessagePort, BroadcastChannel: BroadcastChannel, DataTransfer: DataTransfer,
    CanvasRenderingContext2D: CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D: CanvasRenderingContext2D, OffscreenCanvas: OffscreenCanvas,
    Path2D: Path2D, CanvasGradient: CanvasGradient, CanvasPattern: CanvasPattern, ImageData: ImageData, TextMetrics: TextMetrics,
    HTMLCollection: Array, NodeList: Array, NamedNodeMap: Object
  };
  for (var tagName in TAGS) exportsList[TAGS[tagName].name] = TAGS[tagName];
  exportsList.HTMLUnknownElement = HTMLUnknownElement;
  exportsList.HTMLMediaElement = HTMLMediaElement;
  for (var en in exportsList) install(en, exportsList[en]);
  install('CSS', {
    supports: function (a, b) { if (b === undefined) return supportsCondition(String(a).charAt(0) === '(' ? a : '(' + a + ')'); return supportsCondition('(' + a + ':' + b + ')'); },
    escape: function (s) { return String(s).replace(/([^\w-])/g, '\\$1').replace(/^(\d)/, '\\3$1 '); }
  });
  install('getComputedStyle', getComputedStyle);
  install('matchMedia', function (q) { return new MediaQueryList(String(q)); });
  install('requestAnimationFrame', requestAnimationFrame);
  install('cancelAnimationFrame', cancelAnimationFrame);
  install('requestIdleCallback', requestIdleCallback);
  install('cancelIdleCallback', cancelIdleCallback);
  install('structuredClone', function (v) { return structuredCloneImpl(v); });
  install('atob', atob);
  install('btoa', btoa);
  install('performance', performance);
  install('navigator', navigator);
  install('screen', screen);
  install('history', history);
  install('localStorage', makeStorage());
  install('sessionStorage', makeStorage());
  install('customElements', customElements);
  install('devicePixelRatio', 1);
  install('origin', '');
  install('isSecureContext', true);
  install('frames', G);
  install('length', 0);
  install('opener', null);
  install('frameElement', null);
  install('name', '');
  install('closed', false);
  install('event', undefined);
  install('getSelection', function () { return selection; });
  function scrollPage(x, y, by) {
    var root = doc && doc.documentElement;
    if (!root) return;
    if (typeof x === 'object' && x) { y = x.top; x = x.left; }
    var top = (by ? root.scrollTop : 0) + (+y || 0);
    top = Math.max(0, Math.min(Math.max(0, pageHeight() - viewport.h), top));
    if (top !== root.scrollTop) { root.scrollTop = top; scrolled(root); dispatch(doc, new Event('scroll')); }
  }
  install('scrollTo', function (x, y) { scrollPage(x, y, false); });
  install('scroll', function (x, y) { scrollPage(x, y, false); });
  install('scrollBy', function (x, y) { scrollPage(x, y, true); });
  install('focus', function () {});
  install('blur', function () {});
  install('print', function () {});
  install('stop', function () {});
  install('alert', function (m) { if (typeof console !== 'undefined') console.log(String(m)); });
  install('confirm', function () { return false; });
  install('prompt', function () { return null; });
  install('postMessage', function (m) { var parentPost = G.parent && G.parent.postMessage; if (parentPost) parentPost(m); });
  install('reportError', reportError);
  // ---- fetch and XMLHttpRequest ------------------------------------------
  // The host answers what it can (its __fetchResource hook); without one
  // every request is a network error.
  var resources = {}, resourceId = 1;
  function loadResource(url, done) {
    var id = resourceId++;
    resources[id] = done;
    if (typeof G.__fetchResource === 'function') G.__fetchResource(id, url);
    else setTimeout(function () { __resource(id, 0, ''); }, 0);
    return id;
  }
  function __resource(id, status, text, type) {
    var done = resources[id];
    delete resources[id];
    if (done) done(status, text, type || '');
  }
  G.__resource = __resource;
  var STATUS_TEXT = { 200: 'OK', 404: 'Not Found' };
  class Headers {
    constructor(init) {
      this._h = {};
      if (init instanceof Headers) init = init._h;
      if (Array.isArray(init)) for (var i = 0; i < init.length; i++) this.append(init[i][0], init[i][1]);
      else if (init) for (var k in init) this.append(k, init[k]);
    }
    append(k, v) { k = String(k).toLowerCase(); this._h[k] = this._h[k] === undefined ? String(v) : this._h[k] + ', ' + v; }
    set(k, v) { this._h[String(k).toLowerCase()] = String(v); }
    get(k) { var v = this._h[String(k).toLowerCase()]; return v === undefined ? null : v; }
    has(k) { return this._h[String(k).toLowerCase()] !== undefined; }
    delete(k) { delete this._h[String(k).toLowerCase()]; }
    forEach(fn, self) { for (var k in this._h) fn.call(self, this._h[k], k, this); }
    entries() { var h = this._h; return Object.keys(h).sort().map(function (k) { return [k, h[k]]; })[Symbol.iterator](); }
    keys() { return Object.keys(this._h).sort()[Symbol.iterator](); }
    values() { var h = this._h; return Object.keys(h).sort().map(function (k) { return h[k]; })[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
  }
  function bodyText(b) {
    if (b === undefined || b === null) return '';
    if (typeof b === 'string') return b;
    if (b instanceof Blob) return new TextDecoder().decode(b._bytes());
    if (b instanceof URLSearchParams) return b.toString();
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
    return String(b);
  }
  class Body {
    _read() {
      if (this.bodyUsed) return Promise.reject(new TypeError('body already used'));
      this.bodyUsed = true;
      return Promise.resolve(this._body);
    }
    text() { return this._read(); }
    json() { return this._read().then(function (t) { return JSON.parse(t); }); }
    arrayBuffer() { return this._read().then(function (t) { return new TextEncoder().encode(t).buffer; }); }
    blob() { var type = this.headers.get('content-type') || ''; return this._read().then(function (t) { return new Blob([t], { type: type }); }); }
    formData() { return Promise.reject(new TypeError('formData is not supported')); }
  }
  class Response extends Body {
    constructor(body, init) {
      super();
      init = init || {};
      this._body = bodyText(body);
      this.bodyUsed = false;
      this.status = init.status === undefined ? 200 : init.status;
      this.statusText = init.statusText !== undefined ? String(init.statusText) : STATUS_TEXT[this.status] || '';
      this.headers = new Headers(init.headers);
      this.url = init.url || '';
      this.type = init.type || 'default';
      this.redirected = false;
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    get body() { return null; }
    clone() { if (this.bodyUsed) throw new TypeError('body already used'); return new Response(this._body, this); }
    static json(v, init) { var r = new Response(JSON.stringify(v), init); r.headers.set('content-type', 'application/json'); return r; }
    static error() { return new Response('', { status: 0, type: 'error' }); }
  }
  class Request extends Body {
    constructor(input, init) {
      super();
      init = init || {};
      var from = input instanceof Request ? input : null;
      this.url = from ? from.url : resolveURL(String(input));
      this.method = String(init.method || (from && from.method) || 'GET').toUpperCase();
      this.headers = new Headers(init.headers || (from && from.headers));
      this.signal = init.signal || (from && from.signal) || null;
      this._body = bodyText(init.body !== undefined ? init.body : from && from._body);
      this.bodyUsed = false;
    }
    clone() { return new Request(this); }
  }
  function abortError(signal) { return signal && signal.reason !== undefined ? signal.reason : DOMException('The operation was aborted.', 'AbortError'); }
  function contentType(url, type) {
    if (type) return type;
    var m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url);
    var t = m && { js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', html: 'text/html', css: 'text/css', svg: 'image/svg+xml', txt: 'text/plain', xml: 'application/xml' }[m[1].toLowerCase()];
    return t || 'application/octet-stream';
  }
  install('fetch', function fetch(input, init) {
    var req;
    try { req = new Request(input, init); } catch (e) { return Promise.reject(e); }
    var signal = req.signal;
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(abortError(signal)); return; }
      var settled = false;
      function onAbort() { if (!settled) { settled = true; delete resources[id]; reject(abortError(signal)); } }
      var id = loadResource(req.url, function (status, text, type) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!status) { reject(new TypeError('Failed to fetch')); return; }
        resolve(new Response(text, { status: status, url: req.url, type: 'basic', headers: { 'content-type': contentType(req.url, type) } }));
      });
      if (signal) signal.addEventListener('abort', onAbort);
    });
  });
  install('Headers', Headers);
  install('Request', Request);
  install('Response', Response);
  class XMLHttpRequest extends EventTarget {
    constructor() {
      super();
      this.readyState = 0; this.status = 0; this.statusText = ''; this.responseText = ''; this.response = '';
      this.responseType = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false;
      this.upload = new EventTarget();
      this._id = 0; this._type = '';
    }
    open(method, url) { this._method = String(method).toUpperCase(); this._url = resolveURL(String(url)); this._id = 0; this._state(1); }
    setRequestHeader() {}
    getAllResponseHeaders() { return this.readyState >= 2 && this.status ? 'content-type: ' + this._type + '\r\n' : ''; }
    getResponseHeader(k) { return this.readyState >= 2 && this.status && String(k).toLowerCase() === 'content-type' ? this._type : null; }
    overrideMimeType() {}
    _state(n) { this.readyState = n; this._fire('readystatechange', Event); }
    _fire(type, Cls) { var ev = new Cls(type); var h = this['on' + type]; if (typeof h === 'function') { try { h.call(this, ev); } catch (e) { reportError(e); } } this.dispatchEvent(ev); }
    send() {
      if (this.readyState !== 1) throw DOMException('The object is not open', 'InvalidStateError');
      var self = this;
      this._fire('loadstart', ProgressEvent);
      this._id = loadResource(this._url, function (status, text, type) {
        self._id = 0;
        if (!status) { self._state(4); self._fire('error', ProgressEvent); self._fire('loadend', ProgressEvent); return; }
        self.status = status; self.statusText = STATUS_TEXT[status] || ''; self.responseURL = self._url;
        self._type = contentType(self._url, type);
        self._state(2); self._state(3);
        self.responseText = text;
        var rt = self.responseType;
        try { self.response = rt === 'json' ? JSON.parse(text) : rt === 'arraybuffer' ? new TextEncoder().encode(text).buffer : rt === 'blob' ? new Blob([text], { type: self._type }) : text; } catch (e) { self.response = null; }
        self._state(4);
        self._fire('load', ProgressEvent);
        self._fire('loadend', ProgressEvent);
      });
    }
    abort() {
      if (!this._id) return;
      delete resources[this._id];
      this._id = 0;
      this._state(4);
      this.readyState = 0;
      this._fire('abort', ProgressEvent);
      this._fire('loadend', ProgressEvent);
    }
  }
  XMLHttpRequest.UNSENT = 0; XMLHttpRequest.OPENED = 1; XMLHttpRequest.HEADERS_RECEIVED = 2; XMLHttpRequest.LOADING = 3; XMLHttpRequest.DONE = 4;
  install('XMLHttpRequest', XMLHttpRequest);
  install('Image', function Image(w, h) { var i = doc.createElement('img'); if (w !== undefined) i.width = w; if (h !== undefined) i.height = h; return i; });
  install('Option', function Option(text, value, ds, sel) { var o = doc.createElement('option'); if (text !== undefined) o.text = text; if (value !== undefined) o.value = value; if (ds) o.defaultSelected = true; if (sel) o.selected = true; return o; });
  if (!G.queueMicrotask) install('queueMicrotask', function (fn) { Promise.resolve().then(fn); });
  Object.defineProperty(G, 'innerWidth', { get: function () { return viewport.w; }, configurable: true });
  Object.defineProperty(G, 'innerHeight', { get: function () { return viewport.h; }, configurable: true });
  Object.defineProperty(G, 'outerWidth', { get: function () { return viewport.w; }, configurable: true });
  Object.defineProperty(G, 'outerHeight', { get: function () { return viewport.h; }, configurable: true });
  Object.defineProperty(G, 'scrollX', { get: function () { return 0; }, configurable: true });
  Object.defineProperty(G, 'scrollY', { get: function () { return doc && doc.documentElement ? doc.documentElement.scrollTop : 0; }, configurable: true });
  Object.defineProperty(G, 'pageXOffset', { get: function () { return 0; }, configurable: true });
  Object.defineProperty(G, 'pageYOffset', { get: function () { return doc && doc.documentElement ? doc.documentElement.scrollTop : 0; }, configurable: true });
  Object.defineProperty(G, 'screenX', { get: function () { return 0; }, configurable: true });
  Object.defineProperty(G, 'screenY', { get: function () { return 0; }, configurable: true });
  ['onload', 'onerror', 'onresize', 'onscroll', 'onfocus', 'onblur', 'onmessage', 'onunhandledrejection', 'onpopstate', 'onhashchange', 'onbeforeunload', 'onunload'].forEach(function (k) { if (G[k] === undefined) G[k] = null; });
  if (!G.location || !G.location.assign) install('location', locationOf());

  // ---- the host's entry points ---------------------------------------------

  function newDocument(url) {
    var d = new HTMLDocument();
    d._url = url || 'about:blank';
    return d;
  }
  G.__page = function (html, url) {
    doc = newDocument(url || 'about:blank');
    install('document', doc);
    parseInto(String(html || ''), doc, doc);
    // <html>, <head> and <body> are optional in the markup: implied ones,
    // which the stray nodes go into
    var h = null;
    for (var j = 0; j < doc._c.length; j++) if (doc._c[j].nodeType === 1 && doc._c[j].localName === 'html') { h = doc._c[j]; break; }
    if (!h) h = doc.appendChild(doc.createElement('html'));
    var head = null, body = null;
    for (var k = 0; k < h._c.length; k++) {
      if (h._c[k].localName === 'head' && !head) head = h._c[k];
      else if (h._c[k].localName === 'body' && !body) body = h._c[k];
    }
    // <head> and <body> tags beside an implied <html>
    for (var m = 0; m < doc._c.length; m++) {
      var sn = doc._c[m];
      if (sn.nodeType !== 1 || sn === h) continue;
      if (sn.localName === 'head' && !head) { head = h.insertBefore(sn, h.firstChild); m--; }
      else if (sn.localName === 'body' && !body) { body = h.appendChild(sn); m--; }
    }
    if (!head) head = h.insertBefore(doc.createElement('head'), h.firstChild);
    if (!body) body = h.appendChild(doc.createElement('body'));
    // stray nodes in <html> beside <head> and <body>: metadata before any
    // content into <head>, the rest into <body> (before its own nodes when
    // they come before it)
    var hBody = false, hIn = false, bFirst = body.firstChild;
    for (var q = 0; q < h._c.length; q++) {
      var hn = h._c[q];
      if (hn === head) continue;
      if (hn === body) { hBody = true; continue; }
      if (hn.nodeType === 8) continue;
      if (hn.nodeType === 3 && !hIn && !/\S/.test(hn._data)) { if (hBody) continue; h.removeChild(hn); q--; continue; }
      if (!hIn && !hBody && hn.nodeType === 1 && /^(meta|title|link|style|script|base|noscript|template)$/.test(hn.localName)) { head.appendChild(hn); q--; continue; }
      hIn = true;
      if (hBody) body.appendChild(hn); else body.insertBefore(hn, bFirst);
      q--;
    }
    // stray nodes beside <html>: into <body> or, metadata before any
    // content, <head>
    var inBody = false;
    for (var i = 0; i < doc._c.length; i++) {
      var n = doc._c[i];
      if (n === h || n.nodeType === 10 || n.nodeType === 8) continue;
      if (n.nodeType === 3 && !inBody && !/\S/.test(n._data)) { doc.removeChild(n); i--; continue; }
      if (!inBody && n.nodeType === 1 && /^(meta|title|link|style|script|base)$/.test(n.localName)) head.appendChild(n);
      else { inBody = true; body.appendChild(n); }
      i--;
    }
    // with <html> first, before stray nodes after it
    if (doc.firstElementChild !== h) doc.appendChild(h);
    var base = doc.querySelector('base[href]');
    if (base && base.getAttribute('href')) doc._base = joinURL(base.getAttribute('href'), doc._url);
    // the page's own scripts are the host's to run (__scripts): already
    // started, so moving one later does not run it again
    eachElement(doc, function (e) { if (e._parser) { e._parser = false; if (e.localName === 'script') e._started = true; } });
    doc.readyState = 'loading';
    return 'ok';
  };
  G.__scripts = scriptsOfPage;
  G.__styles = stylesOfPage;
  G.__beginScript = function (id) { doc.currentScript = nodeById(id) || null; return 'ok'; };
  G.__endScript = function (id, ok) {
    var el = nodeById(id);
    doc.currentScript = null;
    if (el && el.getAttribute('src')) setTimeout(function () { dispatch(el, new Event(ok === false ? 'error' : 'load')); }, 0);
    return 'ok';
  };
  G.__addStyle = function (css, linkId) {
    var owner = linkId !== undefined && linkId !== null ? nodeById(linkId) : null;
    var s = new CSSStyleSheet(owner);
    s.href = owner ? owner.href : null;
    s.cssRules = parseSheetText(String(css || ''), s).cssRules;
    s._rebuild();
    linkSheets.push(s);
    if (owner) setTimeout(function () { dispatch(owner, new Event('load')); }, 0);
    return String(s._rules.length);
  };
  G.__loaded = function () {
    doc.readyState = 'interactive';
    dispatch(doc, new Event('readystatechange'));
    dispatch(doc, new Event('DOMContentLoaded', { bubbles: true }));
    doc.readyState = 'complete';
    dispatch(doc, new Event('readystatechange'));
    var ev = new Event('load');
    // <body onload="...">: the window's handler
    if (typeof G.onload !== 'function' && doc.body && doc.body.hasAttribute('onload')) G.onload = doc.body.onload;
    if (typeof G.onload === 'function') { try { G.onload(ev); } catch (e) { reportError(e); } }
    invoke(G, ev, 2);
    return 'ok';
  };
  G.__render = render;
  G.__generation = function () { return String(generation); };
  G.__layout = function (json) {
    var m = typeof json === 'string' ? JSON.parse(json) : json;
    var sizeChanged = false;
    if (m.viewport) {
      if (m.viewport[0] !== viewport.w || m.viewport[1] !== viewport.h) { viewport = { w: m.viewport[0], h: m.viewport[1] }; mediaCache = {}; sizeChanged = true; changed(); }
    }
    if (m.boxes) {
      boxes = m.boxes;
      boxSvgs = boxSvgs.filter(function (e) { return e.isConnected; });
      for (var bs = 0; bs < boxSvgs.length; bs++) {
        var sv = boxSvgs[bs], sb = boxes[sv.__id];
        if (!sb) continue;
        var scs = computedOf(sv), uw = svgUsedSize(sv, scs, 'width', 300), uh = svgUsedSize(sv, scs, 'height', 150);
        if (sv._usedBox !== (uw !== null ? uw : sb[2]) + ',' + (uh !== null ? uh : sb[3])) textChanged(sv);
      }
    }
    if (sizeChanged) { mediaChanged(); invoke(G, new UIEvent('resize', { view: G }), 2); if (typeof G.onresize === 'function') G.onresize(new UIEvent('resize')); }
    if (resizeObservers.length) fireResize();
    if (intersectionObservers.length) fireIntersect();
    return 'ok';
  };
  G.__input = function (json) {
    var m = typeof json === 'string' ? JSON.parse(json) : json;
    try { return hostInput(m); } catch (e) { reportError(e); return 'error ' + (e && e.message); }
  };
  G.__querySelector = function (s) { var e = doc && doc.querySelector(s); return e ? String(e.__id) : ''; };
  G.__webdom = { computedOf: computedOf, cascade: cascade, parseSelectorList: parseSelectorList, normalizeColor: normalizeColor, resolveURL: resolveURL, nodeById: nodeById, lengthPx: lengthPx };

  // until __page: an empty document
  doc = newDocument('about:blank');
  parseInto('<html><head></head><body></body></html>', doc, doc);
  install('document', doc);
})(this);
