// SPDX-License-Identifier: MIT
export default {
  area: "Animation library",
  lib: "motion 14.13.0",
  about: "Motion's vanilla animate() on 120 boxes: x + rotate tween, spring scale, staggered opacity, width animation. Each step waits for the animation's finished promise.",
  page: (ctx) => ({
    css: "body{margin:0;font:12px Arial}#app{position:relative;width:1180px;height:780px}.b{position:absolute;width:56px;height:56px;border-radius:8px;background:#7a5cff;color:#fff;display:flex;align-items:center;justify-content:center}",
    body: '<div id="app"></div>',
    scripts: [ctx.bundle("motion", ctx.file("pages/motion.js"))],
  }),
};
