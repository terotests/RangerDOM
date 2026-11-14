// SPDX-License-Identifier: MIT
// Web API behaviour checks, one step each; the probe holds every step's
// result so far (the driver compares it with Chromium's).
(function () {
  var r = {};
  function oklab2rgb(L, A, B) {
    var l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3), m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3), s = Math.pow(L - 0.0894841775 * A - 1.2914855480 * B, 3);
    var g = function (x) { return Math.max(0, Math.min(255, Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255))); };
    return [g(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), g(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  }
  // a computed colour as [r, g, b, alpha] (alpha to 2 decimals)
  function rgbOf(c) {
    var m = /^(rgba?|oklch|oklab)\(([^)]*)\)$/.exec(String(c).trim());
    if (!m) return c;
    var parts = m[2].replace(/\//, ' / ').split(/[\s,]+/).filter(function (x) { return x && x !== '/'; }).map(parseFloat);
    var rgb, al = parts.length > 3 ? parts[3] : 1;
    if (m[1] === 'oklch') rgb = oklab2rgb(parts[0], parts[1] * Math.cos(parts[2] * Math.PI / 180), parts[1] * Math.sin(parts[2] * Math.PI / 180));
    else if (m[1] === 'oklab') rgb = oklab2rgb(parts[0], parts[1], parts[2]);
    else rgb = parts.slice(0, 3).map(Math.round);
    return rgb.concat([Math.round(al * 100) / 100]).join(',');
  }
  window.__benchCase = {
    setup: function () {
      var s = '';
      for (var i = 0; i < 100; i++) s += '<div id="row' + i + '">row ' + i + '</div>';
      document.getElementById('list').innerHTML = s;
    },
    steps: [
      { name: 'custom element defined after it is in the page', run: function () {
        var log = [];
        var waited = customElements.whenDefined('x-later').then(function (c) { log.push('whenDefined:' + (c === XLater)); });
        class XLater extends HTMLElement {
          static get observedAttributes() { return ['greeting']; }
          constructor() { super(); this.made = true; log.push('ctor'); }
          attributeChangedCallback(n, o, v) { log.push('attr:' + n + '=' + v + ':' + o); }
          connectedCallback() { log.push('connected'); }
          hello() { return 'hello ' + this.getAttribute('greeting'); }
        }
        customElements.define('x-later', XLater);
        var el = document.getElementById('xl');
        return waited.then(function () {
          r.upgrade = { log: log.join(','), isClass: el instanceof XLater, hello: typeof el.hello === 'function' ? el.hello() : null, made: el.made === true, getName: customElements.getName ? customElements.getName(XLater) : 'n/a' };
        });
      } },
      { name: 'scrollIntoView row 50', run: function () {
        var list = document.getElementById('list');
        document.getElementById('row50').scrollIntoView();
        r.scrollIntoView = { top: list.scrollTop };
        document.getElementById('row80').scrollIntoView({ block: 'end' });
        r.scrollIntoView.end = list.scrollTop;
      } },
      { name: ':invalid with required', run: function () {
        var req = document.getElementById('req'), opt = document.getElementById('opt');
        r.invalid = {
          req: req.matches(':invalid'), opt: opt.matches(':invalid'), form: document.getElementById('f').matches(':invalid'),
          valid: req.validity.valueMissing, color: getComputedStyle(req).borderTopColor,
        };
        req.value = 'x';
        r.invalid.afterValue = req.matches(':invalid');
        r.invalid.colorAfter = getComputedStyle(req).borderTopColor;
      } },
      { name: 'getComputedStyle shorthands', run: function () {
        var cs = getComputedStyle(document.getElementById('sh'));
        r.shorthands = { margin: cs.margin, padding: cs.padding, borderColor: cs.borderColor, borderWidth: cs.borderWidth, borderStyle: cs.borderStyle, border: cs.border, borderTop: cs.borderTop };
      } },
      { name: 'style.transform serialisation', run: function () {
        var st = document.getElementById('tr').style;
        st.transform = 'translate(10px,20px) rotate(5deg)';
        var a = st.transform;
        st.transform = 'scale(1.5,  2)  translateX( 4px )';
        r.transform = { a: a, b: st.transform, css: st.cssText };
      } }
,
      { name: 'CSS animations', run: function () {
        var ev = [], a1 = document.getElementById('an1'), a2 = document.getElementById('an2'), a3 = document.getElementById('an3');
        [a1, a2, a3].forEach(function (e) { ['animationstart', 'animationiteration', 'animationend'].forEach(function (t) { e.addEventListener(t, function (x) { ev.push(e.id + ':' + t + ':' + x.animationName); }); }); });
        a1.className = 'anim'; a2.className = 'anim2'; a3.className = 'anim3';
        return window.__bench.sleep(600).then(function () {
          var c1 = getComputedStyle(a1), c2 = getComputedStyle(a2), c3 = getComputedStyle(a3);
          r.animations = { fwdOpacity: c1.opacity, fwdBg: c1.backgroundColor, alternateEnd: c2.marginLeft, backwardsOpacity: c3.opacity, events: ev.sort().join(',') };
        });
      } },
      { name: 'Element.animate (Web Animations)', run: function () {
        var el = document.getElementById('tr'), ev = [];
        var a = el.animate([{ opacity: 1, marginLeft: '0px' }, { opacity: 0.2, marginLeft: '30px' }], { duration: 120, fill: 'forwards', easing: 'ease-in' });
        a.onfinish = function () { ev.push('onfinish'); };
        a.addEventListener('finish', function () { ev.push('finish'); });
        var b = el.animate({ transform: ['translateX(0px)', 'translateX(50px)'] }, 1000);
        var info = { state0: a.playState, kf: JSON.stringify(a.effect.getKeyframes().map(function (k) { return [k.offset, k.opacity]; })), timing: a.effect.getTiming().duration, count: el.getAnimations().length };
        var bDone = b.finished.catch(function (e) { return e.name; });
        b.cancel();
        return Promise.all([a.finished, bDone]).then(function (res) { return window.__bench.sleep(50).then(function () { return res; }); }).then(function (res) {
          var cs = getComputedStyle(el);
          info.cancelled = res[1]; info.state = a.playState; info.opacity = cs.opacity; info.margin = cs.marginLeft; info.events = ev.sort().join(','); info.after = el.getAnimations().length;
          a.cancel();
          info.opacityAfterCancel = getComputedStyle(el).opacity;
          r.waapi = info;
        });
      } },
      { name: 'Tailwind v4 patterns', run: function () {
        var a = getComputedStyle(document.getElementById('tw')), b = getComputedStyle(document.getElementById('tw2'));
        // (colours compared as the sRGB they show: Chromium keeps oklch /
        // oklab in getComputedStyle, web/dom gives rgb)
        r.tailwind = { padding: a.paddingTop, fontSize: a.fontSize, lineHeight: a.lineHeight, bg: rgbOf(a.backgroundColor), width: a.width, radius: a.borderTopLeftRadius, mix: rgbOf(b.backgroundColor), gap: b.columnGap };
      } },
      { name: 'template attributes (Lit parts)', run: function () {
        var t = document.createElement('template');
        t.innerHTML = '<div part$lit$="base lit$9$" .value$lit$="lit$9$" class$lit$="lit$9$" id="q" ?disabled$lit$="" @click$lit$="lit$9$" aria-label$lit$=lit$9$ @sl-change$lit$=lit$9$><span lit$9$7="">x</span><!--?lit$9$--></div>';
        var d = t.content.firstChild;
        var w = document.createTreeWalker(t.content, 129), seen = [];
        while (w.nextNode()) seen.push(w.currentNode.nodeType + ':' + (w.currentNode.nodeType === 1 ? w.currentNode.localName + '[' + w.currentNode.getAttributeNames().join('|') + ']' : w.currentNode.data));
        r.template = { names: d.getAttributeNames().join('|'), cls: d.getAttribute('class$lit$'), part: d.getAttribute('part$lit$'), walk: seen.join(' ; '), html: t.innerHTML };
      } },
      { name: 'elementFromPoint in a scaled viewport', run: function () {
        // React Flow's shape: nodes placed by translate() inside a pane
        // whose viewport is translate + scale about its top left
        var pts = [[75, 30], [225, 130], [20, 10], [80, 34], [300, 250]], pane = document.getElementById('pane').getBoundingClientRect();
        r.scaledHit = pts.map(function (p) { var e = document.elementFromPoint(pane.left + p[0], pane.top + p[1]); return e ? e.id || e.tagName : '-'; }).join(',');
      } },
      { name: 'Shadow DOM', run: function () {
        // a host with a shadow tree: :host, ::slotted(), slots (named,
        // default, fallback), inheritance through the host, composed
        // events and retargeting, slotchange, hit testing into it
        var host = document.getElementById('sh-host');
        var sr = host.attachShadow({ mode: 'open' });
        sr.innerHTML = '<style>:host{display:block;color:rgb(0,0,200);padding:3px}:host([big]){padding:9px}.in{font-weight:700;border:1px solid red}::slotted(span){color:rgb(0,150,0)}::slotted(.x){text-decoration:underline}slot[name=n]::slotted(*){margin-left:7px}</style><div class="in" id="in1">inner <slot name="n"><b id="fb">fallback</b></slot><slot></slot></div><button id="ib">btn</button>';
        var log = [];
        sr.addEventListener('slotchange', function (e) { log.push('slotchange:' + (e.target.name || 'default')); });
        host.addEventListener('click', function (e) { log.push('host-click:' + e.target.id + ':' + e.composedPath().length); });
        document.body.addEventListener('custom', function (e) { log.push('body-custom:' + e.target.id); });
        sr.getElementById('ib').addEventListener('click', function (e) { log.push('inner-click:' + e.target.id); });
        host.setAttribute('big', '');
        var span = document.createElement('span'); span.className = 'x'; span.id = 'sp'; span.textContent = 'slotted'; host.appendChild(span);
        var named = document.createElement('i'); named.slot = 'n'; named.id = 'ni'; named.textContent = 'named'; host.appendChild(named);
        return window.__bench.frames(2).then(function () {
          var ib = sr.getElementById('ib');
          ib.click();
          ib.dispatchEvent(new Event('custom', { bubbles: true, composed: true }));
          ib.dispatchEvent(new Event('custom', { bubbles: true }));
          var cin = getComputedStyle(sr.getElementById('in1')), csp = getComputedStyle(span), cni = getComputedStyle(named), ch = getComputedStyle(host);
          r.shadow = {
            hostPad: ch.paddingTop, inColor: cin.color, inWeight: cin.fontWeight, spanColor: csp.color, spanDeco: csp.textDecorationLine, niMargin: cni.marginLeft, niColor: cni.color,
            assigned: sr.querySelector('slot:not([name])').assignedNodes().map(function (n) { return n.id || n.nodeName; }).join(','),
            named: sr.querySelector('slot[name=n]').assignedElements().map(function (n) { return n.id; }).join(','),
            slotOf: span.assignedSlot ? span.assignedSlot.name || 'default' : null,
            connected: sr.getElementById('in1').isConnected, root: sr.getElementById('in1').getRootNode() === sr, composedRoot: sr.getElementById('in1').getRootNode({ composed: true }) === document,
            qs: document.querySelector('#in1') === null, active: (ib.focus(), document.activeElement.id + '/' + (sr.activeElement && sr.activeElement.id)),
            log: log.join(' ; ')
          };
        });
      } },
      { name: 'Shadow DOM hit test', run: function () {
        // (a step of its own: the window lays the shadow tree out between
        // steps)
        var host = document.getElementById('sh-host'), sr = host.shadowRoot, ib = sr.getElementById('ib');
        var b = ib.getBoundingClientRect(), e1 = document.elementFromPoint(b.left + 2, b.top + 2), e2 = sr.elementFromPoint(b.left + 2, b.top + 2);
        r.shadowHit = { hit: (e1 && e1.id) + '/' + (e2 && e2.id), sized: b.height > 0 && host.getBoundingClientRect().height > b.height };
      } }
    ],
    probe: function () { return r; }
  };
})();
