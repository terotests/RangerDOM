// SPDX-License-Identifier: MIT
// js-framework-benchmark's page (its table in a Bootstrap container, with
// Bootstrap 5's style sheet as the page's) for the jsfb-* cases.
export function jsfbPage(ctx, scripts) {
  return {
    css: ctx.nm("bootstrap/dist/css/bootstrap.min.css") + "\n.preloadicon{display:none}.glyphicon-remove:before{content:'\\00d7'}#main{height:800px;overflow:hidden}",
    body: '<div id="main"><div class="container"><div class="jumbotron"><div class="row"><div class="col-md-6"><h1>js-framework-benchmark</h1></div></div></div>' +
      '<table class="table table-hover table-striped test-data"><tbody id="tbody"></tbody></table></div></div>',
    scripts: [ctx.file("pages/jsfb/data.js")].concat(scripts),
  };
}
