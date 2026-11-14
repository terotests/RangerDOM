// SPDX-License-Identifier: MIT
//
// The playground's engine as WebAssembly (playground/wasm, built Ranger tree
// -> cargo -> wasm32-wasip1): the same methods as rangerdom_pg.js's
// Playground, so main.js drives either. WASI gets what the module asks of
// it: the clock, random bytes, stdout/stderr to the console.

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function loadWasmPlayground(url) {
  let memory = null;
  const view = () => new DataView(memory.buffer);
  const wasi = {
    clock_time_get(_id, _precision, out) {
      view().setBigUint64(out, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)), true);
      return 0;
    },
    random_get(ptr, len) {
      crypto.getRandomValues(new Uint8Array(memory.buffer, ptr, len));
      return 0;
    },
    environ_sizes_get(count, size) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    environ_get() { return 0; },
    fd_write(fd, iovs, n, written) {
      const v = view();
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
  const res = await fetch(url);
  const { instance } = typeof WebAssembly.instantiateStreaming === "function" && (res.headers.get("content-type") || "").includes("wasm")
    ? await WebAssembly.instantiateStreaming(res, { wasi_snapshot_preview1: wasi })
    : await WebAssembly.instantiate(await res.arrayBuffer(), { wasi_snapshot_preview1: wasi });
  const x = instance.exports;
  memory = x.memory;
  if (x._initialize) x._initialize();

  // a string into a buffer the module owns (it takes it back)
  const put = (s) => {
    const b = enc.encode(String(s));
    if (!b.length) return [0, 0];
    const p = x.pg_alloc(b.length);
    new Uint8Array(memory.buffer, p, b.length).set(b);
    return [p, b.length];
  };
  const out = (n) => (n ? dec.decode(new Uint8Array(memory.buffer, x.pg_out_ptr(), n)) : "");

  class WasmPlayground {
    reset() { x.pg_reset(); }
    addScript(url, text) { const [a, b] = put(url), [c, d] = put(text); x.pg_add_script(a, b, c, d); }
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
