// SPDX-License-Identifier: MIT
//
// The global scope of a RangerDOM realm, before webapi.js: the window, its
// timers on the host's clock, and the outbox through which the page asks
// the host for anything outside the realm. There are no host functions: the
// host (src/DomRealm.rgr) evaluates scripts and reads what they leave here.
//
//   __tick(ms)        the host's clock moved ms on: the timers that are due
//                     run, in the order of their due times (setInterval
//                     repeats), at most 500 of them; answers how many ran
//   __dueIn()         ms until the next timer, -1 without timers
//   __drain()         the outbox as JSON text, emptied: {tag: "open", url,
//                     target}, {tag: "fetch", id, url}, {tag: "console",
//                     level, text}, {tag: "error", text}
//
// The clock of the timers is the host's (__tick), so a realm whose host is
// paused or that is driven by a test runs its timers in a known order; the
// wall clock (Date.now, performance.now) is the engine's own.

var window = this;
var self = window;
var top = window;
var __out = [];
var __timers = [];
var __timerId = 1;
var __clock = 0;

function __post(m) { __out.push(m); }
function __drain() { var o = __out; __out = []; return JSON.stringify(o); }

function __text(a) {
  var parts = [];
  for (var i = 0; i < a.length; i++) {
    var v = a[i];
    if (typeof v === 'string') parts.push(v);
    else if (v instanceof Error) parts.push(v.name + ': ' + v.message);
    else { try { parts.push(JSON.stringify(v)); } catch (e) { parts.push(String(v)); } }
  }
  return parts.join(' ');
}
var console = {};
['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
  console[level] = function () { __post({ tag: 'console', level: level, text: __text(arguments) }); };
});
console.trace = console.debug;
console.table = console.log;
console.group = console.groupCollapsed = console.groupEnd = function () {};
console.time = console.timeEnd = console.timeLog = function () {};
console.assert = function (c) { if (!c) console.error('Assertion failed'); };
window.console = console;

function __add(fn, ms, args, every) {
  var id = __timerId++;
  ms = Math.max(0, Number(ms) || 0);
  __timers.push({ id: id, fn: fn, args: args, due: __clock + ms, every: every ? Math.max(1, ms) : 0 });
  return id;
}
function setTimeout(fn, ms) { return __add(fn, ms, Array.prototype.slice.call(arguments, 2), false); }
function setInterval(fn, ms) { return __add(fn, ms, Array.prototype.slice.call(arguments, 2), true); }
function clearTimeout(id) {
  for (var i = 0; i < __timers.length; i++) if (__timers[i].id === id) { __timers.splice(i, 1); return; }
}
var clearInterval = clearTimeout;
window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
window.setInterval = setInterval; window.clearInterval = clearInterval;
window.queueMicrotask = function (fn) { Promise.resolve().then(fn); };

function __tick(ms) {
  var until = __clock + Math.max(0, Number(ms) || 0);
  var n = 0;
  while (n < 500) {
    var best = -1;
    for (var i = 0; i < __timers.length; i++) {
      if (__timers[i].due <= until && (best < 0 || __timers[i].due < __timers[best].due)) best = i;
    }
    if (best < 0) break;
    var t = __timers[best];
    if (t.due > __clock) __clock = t.due;
    if (t.every) t.due += t.every; else __timers.splice(best, 1);
    try {
      if (typeof t.fn === 'function') t.fn.apply(window, t.args);
    } catch (e) {
      __post({ tag: 'error', text: String((e && e.message) || e) });
    }
    n++;
  }
  if (until > __clock) __clock = until;
  return n;
}
function __dueIn() {
  var best = -1;
  for (var i = 0; i < __timers.length; i++) {
    var d = Math.max(0, __timers[i].due - __clock);
    if (best < 0 || d < best) best = d;
  }
  return best;
}
// window.open and a link's default action (webapi.js calls G.open): the
// host decides whether to go there
// window.postMessage (webapi.js sends it to parent.postMessage): a top-level
// page's parent is itself, so the message comes back as a message event
window.parent = {
  postMessage: function (m) {
    setTimeout(function () {
      if (typeof MessageEvent === 'function' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new MessageEvent('message', { data: m, source: window }));
    }, 0);
  }
};
window.open = function (url, target) {
  __post({ tag: 'open', url: String(url === undefined ? '' : url), target: String(target === undefined ? '' : target) });
  return null;
};
// fetch, XMLHttpRequest and inserted <script src> (webapi.js): the host
// fetches, under its own rules, and answers with __resource(id, status,
// text, type); a host that does not answers 0 (no network)
window.__fetchResource = function (id, url) { __post({ tag: 'fetch', id: id, url: String(url) }); };

var crypto = {
  getRandomValues: function (a) {
    for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return a;
  },
  randomUUID: function () {
    var h = '0123456789abcdef', s = '';
    for (var i = 0; i < 36; i++) s += (i === 8 || i === 13 || i === 18 || i === 23) ? '-' : (i === 14 ? '4' : h[Math.floor(Math.random() * 16)]);
    return s;
  }
};
window.crypto = crypto;
