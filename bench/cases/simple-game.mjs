// SPDX-License-Identifier: MIT
export default {
  area: "Simple page",
  about: "A small game-like screen (about 200 elements, class selectors only): tap a tile, score text, a sprite moved by transform for 30 frames, a new board. What a page with no special CSS features costs.",
  page: (ctx) => ({
    css: "body{margin:0;font:16px Arial;background:#123}#game{display:flex;flex-direction:column;height:800px}.bar{display:flex;justify-content:space-between;padding:8px 16px;background:#246;color:#fff}.score{font-weight:bold}.board{display:flex;flex-wrap:wrap;gap:8px;padding:16px;position:relative;flex:1}.tile{width:120px;height:80px;background:#4a8;color:#fff;border-radius:12px;display:flex;align-items:center;justify-content:center}.tile.hit{background:#e84}.tile.done{opacity:.5}.sprite{position:absolute;left:0;top:0;width:48px;height:48px;border-radius:24px;background:#fd3}.label{font-size:14px}",
    body: '<div id="game"></div>',
    scripts: [ctx.file("pages/simple-game.js")],
  }),
};
