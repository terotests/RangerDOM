// SPDX-License-Identifier: MIT
export default {
  area: "Web API behaviour",
  about: "One step per Web API fix found by the battery, each a probe compared with Chromium: custom element upgrade at define + whenDefined, scrollIntoView, :invalid with required, getComputedStyle shorthands, style.transform serialisation, CSS @keyframes animations (fill-mode, iterations, events), template attribute parsing, elementFromPoint inside a translate + scale viewport (React Flow), Shadow DOM (:host, ::slotted, slots, composed events, slotchange), Range contents and comparisons, Selection direction, FormData, ElementInternals with :state(), ARIA reflection, manual slots, getHTML and declarative shadow roots, @property / CSS.registerProperty, event, media and SVG members.",
  page: (ctx) => ({
    css: "body{margin:0;font:14px Arial}#list{height:200px;overflow:auto;border:1px solid #888;width:300px}#list div{height:30px}" +
      "input{border:2px solid rgb(0,128,0)}input:invalid{border-color:rgb(220,0,0)}#sh{margin:1px 2px 3px 4px;padding:5px;border:3px solid rgb(10,20,30)}" +
      "@keyframes fadein{from{opacity:0;background-color:rgba(0,0,0,0)}to{opacity:1;background-color:rgba(0,0,0,.4)}}@keyframes slide{0%{margin-left:0}100%{margin-left:40px}}" +
      "@layer theme{:root{--spacing:.25rem;--text-sm:.875rem;--text-sm--line-height:calc(1.25 / .875);--color-x:oklch(0.6 0.2 250);--radius:.625rem}}" +
      "@property --tw-leading{syntax:\"*\";inherits:false}@layer utilities{.tw-p-4{padding:calc(var(--spacing) * 4)}.tw-text-sm{font-size:var(--text-sm);line-height:var(--tw-leading,var(--text-sm--line-height))}.tw-bg{background-color:var(--color-x)}.tw-mix{background-color:color-mix(in oklab, var(--color-x) 50%, transparent)}.tw-w{width:calc(var(--spacing) * 10)}.tw-r{border-radius:calc(var(--radius) - 2px)}.tw-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:calc(var(--spacing) * 2)}}" +
      ".anim{animation:fadein 150ms forwards}.anim2{animation:slide 100ms ease-out 2 alternate}.anim3{animation:fadein 100ms 5s backwards}" +
      "#pane{position:absolute;left:600px;top:300px;width:400px;height:300px;overflow:hidden}.vp{position:absolute;left:0;top:0;transform:translate(50px,20px) scale(0.5);transform-origin:0 0}.nd{position:absolute;left:0;top:0;width:100px;height:40px}",
    body: '<x-later id="xl" greeting="hei">x</x-later><div id="list"></div><form id="f"><input id="req" required><input id="opt"></form><div id="sh">shorthands</div><div id="tr">transform</div><div id="tw" class="tw-p-4 tw-text-sm tw-bg tw-w tw-r">tw</div><div id="tw2" class="tw-mix tw-grid">tw2</div><div id="an1">a1</div><div id="an2">a2</div><div id="an3">a3</div><div id="pane"><div class="vp" id="vp"><div class="nd" id="n1" style="transform:translate(0px,0px)"><span id="n1t">n1</span></div><div class="nd" id="n2" style="transform:translate(300px,200px)">n2</div></div></div><div id="sh-host"></div>',
    scripts: [ctx.file("pages/webapi-checks.js")],
  }),
};
