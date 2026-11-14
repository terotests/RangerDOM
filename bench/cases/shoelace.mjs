// SPDX-License-Identifier: MIT
export default {
  area: "Web Components",
  lib: "@shoelace-style/shoelace 2.20.1",
  about: "Shoelace Web Components on Lit: customElements, attachShadow, slots, adoptedStyleSheets/constructable styles, CSS custom properties of its light theme; tab group, details, input, dialog show/hide, 50 new buttons upgraded.",
  page: (ctx) => ({
    css: ctx.nm("@shoelace-style/shoelace/dist/themes/light.css") + "\nbody{margin:0;padding:16px;font-family:Arial}.row{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}",
    body: `<div class="row"><sl-button variant="primary">Primary</sl-button><sl-button>Default</sl-button><sl-button variant="danger" outline>Danger</sl-button><sl-badge variant="success">New</sl-badge><sl-switch checked>Switch</sl-switch></div>
<div class="row"><sl-input label="Name" placeholder="Your name" style="width:300px"></sl-input></div>
<sl-tab-group style="width:700px"><sl-tab slot="nav" panel="general">General</sl-tab><sl-tab slot="nav" panel="custom">Custom</sl-tab><sl-tab slot="nav" panel="advanced">Advanced</sl-tab>
<sl-tab-panel name="general">General settings.</sl-tab-panel><sl-tab-panel name="custom">Custom settings panel.</sl-tab-panel><sl-tab-panel name="advanced">Advanced.</sl-tab-panel></sl-tab-group>
<sl-details summary="Toggle me" style="width:700px;margin-top:12px">Details content shown when open.</sl-details>
<sl-dialog label="Dialog">Hello from a dialog.<sl-button slot="footer" variant="primary">Close</sl-button></sl-dialog>
<div id="more" class="row" style="margin-top:12px"></div>`,
    scripts: [ctx.bundle("shoelace", ctx.file("pages/shoelace.js"))],
  }),
};
