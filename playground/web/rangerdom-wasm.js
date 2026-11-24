// SPDX-License-Identifier: MIT
//
// The playground's engine as WebAssembly (playground/wasm, built Ranger tree
// -> cargo -> wasm32-wasip1): the same methods as rangerdom_pg.js's
// Playground, so main.js drives either. WASI gets what the module asks of
// it: the clock, random bytes, stdout/stderr to the console.

const enc = new TextEncoder();
const dec = new TextDecoder();

// CEr's baseline JIT, the host's side (as ComponentEngine's playground has
// it): CEr hands over a module's bytes (cerxes_jit.install), which is
// instantiated against this module's memory and function table, and its
// functions f0, f1, … go into consecutive table slots. The first module is
// the runtime (look, gone, …) the others import.
const JIT_HELPERS = ["get_elem", "set_elem", "get_prop", "set_prop", "op", "call", "slow", "ret"];
function jitHost(getExports) {
  let helpers = null, rt = null;
  return {
    // an evicted module's slots get the runtime's `gone` (back to the
    // interpreter at once), so that nothing holds the module any more
    release(base, n) {
      const t = getExports().__indirect_function_table;
      for (let k = 0; k < n; k++) t.set(base + k, rt.gone);
    },
    install(ptr, len) {
      const x = getExports();
      const t = x.__indirect_function_table;
      if (!t) return -1;
      const m = new WebAssembly.Module(new Uint8Array(x.memory.buffer, ptr >>> 0, len).slice());
      // (the helpers from the table: a wasip1 export runs the constructors
      // and destructors around every call)
      if (!helpers) helpers = JIT_HELPERS.map((_, k) => t.get(x.cerxes_jit_helper(k)));
      const env = { memory: x.memory, table: t };
      JIT_HELPERS.forEach((h, k) => (env[h] = helpers[k]));
      const inst = new WebAssembly.Instance(m, rt ? { env, rt } : { env });
      if (inst.exports.look) { rt = inst.exports; return 0; }
      let n = 0;
      while (inst.exports["f" + n]) n++;
      const idx = t.grow(n);
      for (let k = 0; k < n; k++) t.set(idx + k, inst.exports["f" + k]);
      return idx;
    },
  };
}

// opts.jit: the JIT's hotness threshold (back edges before a function is
// compiled) for a module built with it (rangerdom_pg-jit.wasm); 0 off
// opts.measure(family, text, size, bold): a run's width in the face the
// painter draws it with (main.js); without it a canvas with the family as
// given
export async function loadWasmPlayground(url, opts = {}) {
  let memory = null;
  const view = () => new DataView(memory.buffer);
  const wasi = {
    clock_time_get(_id, _precision, out) {
      view().setBigUint64(out >>> 0, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)), true);
      return 0;
    },
    random_get(ptr, len) {
      crypto.getRandomValues(new Uint8Array(memory.buffer, ptr >>> 0, len));
      return 0;
    },
    environ_sizes_get(count, size) {
      view().setUint32(count >>> 0, 0, true);
      view().setUint32(size >>> 0, 0, true);
      return 0;
    },
    environ_get() { return 0; },
    fd_write(fd, iovs, n, written) {
      const v = view();
      iovs >>>= 0; written >>>= 0;
      let total = 0, text = "";
      for (let i = 0; i < n; i++) {
        const p = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true);
        text += dec.decode(new Uint8Array(memory.buffer, p, l));
        total += l;
      }
      v.setUint32(written, total, true);
      if (text.trim()) (fd === 2 ? console.warn : console.log)("[rangerdom wasm] " + text.trimEnd());
      return 0;
    },
    proc_exit(code) { throw new Error("rangerdom wasm exited (" + code + ")"); },
  };
  let mctx = null;
  const measure = opts.measure || ((family, text, size, bold) => {
    if (!mctx) mctx = (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas")).getContext("2d");
    mctx.font = `${bold ? "bold " : ""}${size}px ${family}`;
    return mctx.measureText(text).width;
  });
  const rangerdom = {
    pg_measure(fp, fl, tp, tl, size, bold) {
      const s = (p, l) => (l ? dec.decode(new Uint8Array(memory.buffer, p >>> 0, l)) : "");
      return measure(s(fp, fl), s(tp, tl), size, bold !== 0);
    },
  };
  let x = null;
  const jh = jitHost(() => x);
  const imports = { wasi_snapshot_preview1: wasi, rangerdom, cerxes_jit: { install: (p, n) => jh.install(p, n), release: (b, n) => jh.release(b, n) } };
  const res = await fetch(url);
  const { instance } = typeof WebAssembly.instantiateStreaming === "function" && (res.headers.get("content-type") || "").includes("wasm")
    ? await WebAssembly.instantiateStreaming(res, imports)
    : await WebAssembly.instantiate(await res.arrayBuffer(), imports);
  x = instance.exports;
  memory = x.memory;
  if (x._initialize) x._initialize();

  // a string into a buffer the module owns (it takes it back)
  const put = (s) => {
    const b = enc.encode(String(s));
    if (!b.length) return [0, 0];
    // (>>> 0: past 2 GB of memory a pointer comes back negative)
    const p = x.pg_alloc(b.length) >>> 0;
    new Uint8Array(memory.buffer, p, b.length).set(b);
    return [p, b.length];
  };
  const out = (n) => (n ? dec.decode(new Uint8Array(memory.buffer, x.pg_out_ptr() >>> 0, n)) : "");

  // the compiled js/ scripts (build.mjs writes them beside the module):
  // without them, or with ?units=0, every page compiles webapi.js
  const useUnits = new URLSearchParams(location.search).get("units") !== "0";
  if (useUnits && x.pg_add_unit) {
    try {
      const r = await fetch(String(url).replace(/(-jit)?\.wasm$/, ".units.json"));
      if (r.ok) {
        const units = await r.json();
        for (const k of Object.keys(units)) { const [a, b] = put(k), [c, d] = put(units[k]); x.pg_add_unit(a, b, c, d); }
      }
    } catch (_) {}
  }

  // Date's local time: the browser's zone (CEr's is UTC until told)
  if (x.pg_set_time_zone) {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) { const [a, b] = put(tz); x.pg_set_time_zone(a, b); }
    } catch (_) {}
  }

  // (false: this module has no JIT)
  const jitOn = !!(opts.jit && x.pg_jit && x.pg_jit(1, opts.jit));

  class WasmPlayground {
    static get jit() { return jitOn; }
    // the JIT's counters ({compiled, refused, dropped, bytes, entries}), or null
    static jitStats() { return jitOn && x.pg_jit_stats ? JSON.parse(out(x.pg_jit_stats())) : null; }
    reset() { x.pg_reset(); }
    addScript(url, text) { const [a, b] = put(url), [c, d] = put(text); x.pg_add_script(a, b, c, d); }
    // a script's compiled unit (cases/<name>/<script>.unit), when the build made one
    addUnit(url, text) { if (!useUnits || !x.pg_add_unit) return; const [a, b] = put(url), [c, d] = put(text); x.pg_add_unit(a, b, c, d); }
    start(html, url, w, h) { const [a, b] = put(html), [c, d] = put(url); x.pg_start(a, b, c, d, w, h); }
    runScripts() { x.pg_run_scripts(); }
    dirty() { return x.pg_dirty() !== 0; }
    render() { return out(x.pg_render()); }
    layout() { return out(x.pg_layout()); }
    paint() { return out(x.pg_paint()); }
    a11y(focusId, gen) { const [a, b] = put(focusId || ""); return out(x.pg_a11y(a, b, gen)); }
    input(json) { const [a, b] = put(json); return out(x.pg_input(a, b)); }
    tick(ms) { return Number(x.pg_tick(ms)); }
    dueIn() { return x.pg_due_in(); }
    eval(src) { const [a, b] = put(src); return out(x.pg_eval(a, b)); }
    messages() { return out(x.pg_messages()); }
    // the page's whole state as text, and the page put back in it (false:
    // not a snapshot); a module built before them has neither
    snapshot() { return x.pg_snapshot ? out(x.pg_snapshot()) : ""; }
    restore(text) { if (!x.pg_restore) return false; const [a, b] = put(text); return x.pg_restore(a, b) !== 0; }
    get canSnapshot() { return !!x.pg_snapshot; }
    memoryBytes() { return memory.buffer.byteLength; }
  }
  return WasmPlayground;
}
