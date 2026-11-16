// SPDX-License-Identifier: MIT
//
// The playground's engine as WebAssembly (playground/wasm, built Ranger tree
// -> cargo -> wasm32-wasip1): the same methods as rangerdom_pg.js's
// Playground, so main.js drives either. WASI gets what the module asks of
// it: the clock, random bytes, stdout/stderr to the console.

const enc = new TextEncoder();
const dec = new TextDecoder();

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
  const res = await fetch(url);
  const { instance } = typeof WebAssembly.instantiateStreaming === "function" && (res.headers.get("content-type") || "").includes("wasm")
    ? await WebAssembly.instantiateStreaming(res, { wasi_snapshot_preview1: wasi, rangerdom })
    : await WebAssembly.instantiate(await res.arrayBuffer(), { wasi_snapshot_preview1: wasi, rangerdom });
  const x = instance.exports;
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
      const r = await fetch(String(url).replace(/\.wasm$/, ".units.json"));
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

  class WasmPlayground {
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
    input(json) { const [a, b] = put(json); return out(x.pg_input(a, b)); }
    tick(ms) { return Number(x.pg_tick(ms)); }
    dueIn() { return x.pg_due_in(); }
    eval(src) { const [a, b] = put(src); return out(x.pg_eval(a, b)); }
    messages() { return out(x.pg_messages()); }
    memoryBytes() { return memory.buffer.byteLength; }
  }
  return WasmPlayground;
}
