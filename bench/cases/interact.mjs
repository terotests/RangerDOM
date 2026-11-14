// SPDX-License-Identifier: MIT
export default {
  area: "Drag / resize (pointer events)",
  lib: "interactjs 1.10.28",
  about: "interact.js draggable + resizable with restrictRect: pointer events dispatched by the page (down, 10 moves, up), transforms and sizes set by the listeners. Probe = the boxes after each drag.",
  page: (ctx) => ({
    css: "body{margin:0;font:13px Arial}#area{position:absolute;left:20px;top:20px;width:900px;height:600px;border:2px dashed #999}.drag{position:absolute;width:140px;height:90px;background:#29e;color:#fff;border-radius:6px;padding:6px;box-sizing:border-box;touch-action:none;user-select:none}",
    body: '<div id="area"><div id="d1" class="drag" style="left:20px;top:20px">Drag 1</div><div id="d2" class="drag" style="left:220px;top:40px">Drag 2</div><div id="d3" class="drag" style="left:420px;top:60px">Resize 3</div></div>',
    scripts: [ctx.bundle("interact", ctx.file("pages/interact.js"))],
  }),
};
