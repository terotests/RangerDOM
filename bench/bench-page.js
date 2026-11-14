// SPDX-License-Identifier: MIT
//
// The page side of bench/: the same in RangerDOM (webapi.js on CEr) and in
// the browser. A case script sets
//
//   window.__benchCase = {
//     setup()            once, after load (may return a promise)
//     steps: [{ name, run() }]   run() may return a promise
//     probe()            what the page shows, as JSON (compared between
//                        the two engines: same probe = same behaviour)
//   }
//
// Each result is a console line "[bench] {json}" with a sequence number:
// {"seq","step","name","js","total","error","probe"}; js is the step's
// synchronous part, total until its promise settled (performance.now()).
// The playground calls __bench.start() and __bench.run(k) in both; a host
// that can only press may press #__bn instead. Errors from the page come as
// {"seq","error"} lines, so a missing Web API is reported, not hidden.
(function () {
  var seq = 0;
  var B = (window.__bench = { next: 0, busy: false });
  function out(o) {
    o.seq = ++seq;
    try { console.log('[bench] ' + JSON.stringify(o)); } catch (e) { console.log('[bench] {"seq":' + seq + ',"error":"unserialisable result"}'); }
  }
  B.out = out;
  function text(e) { return String((e && (e.stack || e.message)) || e).slice(0, 600); }
  window.addEventListener('error', function (ev) { out({ error: text(ev.error || ev.message) }); });
  window.addEventListener('unhandledrejection', function (ev) { out({ error: 'unhandled rejection: ' + text(ev.reason) }); });
  function probe(c) {
    try { return c.probe ? c.probe() : null; } catch (e) { return { probeError: text(e) }; }
  }
  // step k; resolves with its result line
  B.run = function (k) {
    var c = window.__benchCase;
    return new Promise(function (ok) {
      if (!c || !c.steps[k]) { var r0 = { step: k, error: c ? 'no step ' + k : 'no __benchCase' }; out(r0); ok(r0); return; }
      var s = c.steps[k], err = null, r, t0 = performance.now();
      try { r = s.run(); } catch (e) { err = text(e); }
      var t1 = performance.now();
      function done() {
        var line = { step: k, name: s.name, js: t1 - t0, total: performance.now() - t0, error: err, probe: probe(c) };
        // web/dom timed inside (profile-webapi.mjs): what the step cost
        // until now, then from zero for the next one
        if (window.__prof) { line.prof = JSON.parse(JSON.stringify(window.__prof)); window.__profReset(); }
        out(line);
        ok(line);
      }
      if (r && typeof r.then === 'function') r.then(done, function (e) { err = text(e); done(); });
      else done();
    });
  };
  B.start = function () {
    var c = window.__benchCase, err = null, r, t0 = performance.now();
    if (!c) { out({ ready: false, error: 'no __benchCase' }); return Promise.resolve(); }
    try { r = c.setup ? c.setup() : null; } catch (e) { err = text(e); }
    function done() { var l = { ready: true, setup: performance.now() - t0, steps: c.steps.map(function (s) { return s.name; }), error: err, probe: probe(c) }; out(l); return l; }
    if (r && typeof r.then === 'function') return r.then(done, function (e) { err = text(e); return done(); });
    return Promise.resolve(done());
  };
  // web/dom: the first press on the step button sets the case up (after
  // the host's first layout, as a page's scripts run in a browser), each
  // press after it runs the next step
  var started = false;
  function wire() {
    var b = document.getElementById('__bn');
    // (the step runs outside the press's click: a document click listener,
    // such as Bootstrap's that closes open dropdowns, must not see it)
    if (b) b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (B.busy) return;
      B.busy = true;
      setTimeout(function () {
        var p = started ? B.run(B.next++) : B.start();
        started = true;
        p.then(function () { B.busy = false; });
      }, 0);
    });
  }
  // a press on the probe button: what the page shows now, after the host
  // laid the step's changes out (a step's own probe reads the boxes of the
  // layout before it: web/dom has no synchronous layout)
  B.settled = function (k) {
    var l = { settled: k, probe: probe(window.__benchCase || {}) };
    if (window.__prof) { l.prof = JSON.parse(JSON.stringify(window.__prof)); window.__profReset(); }
    out(l);
    return l;
  };
  function wireProbe() {
    var b = document.getElementById('__bp');
    if (b) b.addEventListener('click', function (ev) { ev.stopPropagation(); setTimeout(function () { B.settled(B.next - 1); }, 0); });
  }
  function loaded() { wire(); wireProbe(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loaded);
  else loaded();
  // a frame later (rAF twice: the frame after the change is drawn)
  B.frames = function (n) {
    return new Promise(function (ok) {
      var k = 0;
      function f() { if (++k >= n) ok(); else requestAnimationFrame(f); }
      requestAnimationFrame(f);
    });
  };
  B.sleep = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
})();
