// SPDX-License-Identifier: MIT
export default {
  area: "Web API behaviour",
  about: "Which Web APIs are there: globals and the members of the prototypes UI libraries use, compared with the browser (the probe lists what is missing). Left out on purpose, as they need what the host does not give: Worker, WebSocket, EventSource, indexedDB, caches, speechSynthesis, createImageBitmap, OffscreenCanvas transfer, CSS Typed OM (computedStyleMap, attributeStyleMap, CSS.px...), navigator.share.",
  page: (ctx) => ({ css: "body{margin:0;font:14px Arial}", body: "<div id=x>survey</div>", scripts: [ctx.file("pages/webapi-survey.js")] }),
};
