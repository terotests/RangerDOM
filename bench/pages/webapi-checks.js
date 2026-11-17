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
      ,
      { name: 'Range: contents, compare, toString', run: function () {
        var host = document.createElement('div');
        host.innerHTML = '<p id="rp1">Hello <b>bold</b> world</p><p id="rp2">second <i>it</i> end</p>';
        document.body.appendChild(host);
        var p1 = host.firstChild, p2 = host.lastChild, t1 = p1.firstChild, t2 = p2.firstChild;
        var rg = document.createRange();
        rg.setStart(t1, 2); rg.setEnd(p2.lastChild, 2);
        var o = { str: rg.toString(), clone: (function () { var d = document.createElement('div'); d.appendChild(rg.cloneContents()); return d.innerHTML; })() };
        o.cmpPt = [rg.comparePoint(t1, 0), rg.comparePoint(p1.childNodes[1], 0), rg.comparePoint(p2.lastChild, 4)].join(',');
        o.inRange = [rg.isPointInRange(t1, 1), rg.isPointInRange(t2, 3)].join(',');
        o.inter = [rg.intersectsNode(p1), rg.intersectsNode(host), rg.intersectsNode(document.getElementById('list'))].join(',');
        var r2 = document.createRange(); r2.selectNodeContents(p2);
        o.cbp = [rg.compareBoundaryPoints(Range.START_TO_START, r2), rg.compareBoundaryPoints(Range.END_TO_END, r2), rg.compareBoundaryPoints(Range.START_TO_END, r2)].join(',');
        var ex = rg.extractContents(), d2 = document.createElement('div'); d2.appendChild(ex);
        o.extracted = d2.innerHTML; o.after = host.innerHTML; o.collapsed = rg.collapsed + ':' + (rg.startContainer === host) + ':' + rg.startOffset;
        var r3 = document.createRange(); r3.setStart(host.firstChild.firstChild, 0); r3.setEnd(host.firstChild.firstChild, 2);
        var em = document.createElement('em'); r3.surroundContents(em); o.surround = host.innerHTML;
        r3.selectNodeContents(host); r3.deleteContents(); o.deleted = host.innerHTML + '|' + host.childNodes.length;
        var r4 = document.createRange(); r4.setStart(t2, 0); r4.setEnd(t1, 0); o.backwards = r4.collapsed;
        try { r4.setStart(t1, 999); o.badOffset = 'none'; } catch (e) { o.badOffset = e.name; }
        host.remove();
        r.range = o;
      } },
      { name: 'Selection: direction, extend, containsNode', run: function () {
        var host = document.createElement('div');
        host.innerHTML = '<span id="s1">abc</span><span id="s2">def</span><span id="s3">ghi</span>';
        document.body.appendChild(host);
        var sel = getSelection(), a = host.childNodes[0].firstChild, c = host.childNodes[2].firstChild;
        sel.setBaseAndExtent(c, 2, a, 1);
        var o = { anchor: sel.anchorNode.data + sel.anchorOffset, focus: sel.focusNode.data + sel.focusOffset, text: sel.toString(), type: sel.type, rc: sel.rangeCount, rStart: sel.getRangeAt(0).startContainer.data };
        o.contains = [sel.containsNode(host.childNodes[1]), sel.containsNode(host.childNodes[0]), sel.containsNode(host.childNodes[0], true)].join(',');
        sel.collapseToStart(); o.collapsed = sel.isCollapsed + ':' + sel.anchorNode.data + sel.anchorOffset;
        sel.extend(c, 1); o.extended = sel.toString();
        sel.selectAllChildren(host); o.all = sel.toString();
        sel.deleteFromDocument(); o.del = host.innerHTML;
        sel.removeAllRanges(); o.none = sel.type + sel.rangeCount;
        o.cls = sel instanceof Selection;
        host.remove();
        r.selection = o;
      } },
      { name: 'FormData', run: function () {
        var f = document.createElement('form');
        f.innerHTML = '<input name="a" value="1"><input name="b" type="checkbox" checked><input name="c" type="checkbox"><input name="d" type="radio" value="x"><input name="d" type="radio" value="y" checked>' +
          '<select name="s" multiple><option selected>o1</option><option>o2</option><option selected value="v3">o3</option></select><textarea name="t">line</textarea><input name="dis" disabled value="no"><button name="btn" value="go">b</button><input type="submit" name="sub" value="S">';
        document.body.appendChild(f);
        var fd = new FormData(f), o = {};
        o.entries = Array.from(fd.entries()).map(function (e) { return e[0] + '=' + e[1]; }).join('&');
        var fd2 = new FormData(f, f.querySelector('button'));
        o.withSubmitter = fd2.getAll('btn').join(',');
        fd.append('a', '2'); fd.set('s', 'only'); fd.delete('t');
        o.after = Array.from(fd).map(function (e) { return e[0] + '=' + e[1]; }).join('&') + '|' + fd.get('a') + '|' + fd.getAll('a').join(',') + '|' + fd.has('t') + '|' + fd.get('nope');
        fd.append('file', new Blob(['xyz'], { type: 'text/plain' }), 'n.txt');
        var file = fd.get('file');
        o.file = (file instanceof File) + ':' + file.name + ':' + file.size + ':' + file.type;
        o.tag = Object.prototype.toString.call(fd);
        var keys = []; fd.forEach(function (v, k) { keys.push(k); }); o.keys = keys.join(',');
        o.usp = new URLSearchParams(new FormData(f)).toString();
        f.remove();
        r.formData = o;
      } },
      { name: 'ElementInternals and :state()', run: function () {
        var log = [];
        class XField extends HTMLElement {
          static get formAssociated() { return true; }
          constructor() { super(); this.i = this.attachInternals(); this.i.role = 'textbox'; }
        }
        customElements.define('x-field', XField);
        var css = document.createElement('style'); css.textContent = 'x-field{display:block;color:rgb(1,2,3)}x-field:state(on){color:rgb(200,0,0)}form:invalid{outline:1px solid rgb(9,9,9)}';
        document.head.appendChild(css);
        var f = document.createElement('form'); f.innerHTML = '<x-field name="xf"></x-field><input name="n" value="v">';
        document.body.appendChild(f);
        var xf = f.firstChild, i = xf.i, o = {};
        o.form = i.form === f; o.role = i.role; o.labels = i.labels.length; o.willValidate = i.willValidate;
        i.setFormValue('hello');
        o.fd = Array.from(new FormData(f)).map(function (e) { return e[0] + '=' + e[1]; }).join('&');
        o.color0 = getComputedStyle(xf).color;
        i.states.add('on'); o.color1 = getComputedStyle(xf).color; o.has = i.states.has('on') + ':' + i.states.size; o.matches = xf.matches(':state(on)');
        i.states.delete('on'); o.color2 = getComputedStyle(xf).color;
        i.setValidity({ valueMissing: true }, 'fill me');
        o.validity = i.validity.valid + ':' + i.validity.valueMissing + ':' + i.validationMessage;
        xf.addEventListener('invalid', function () { log.push('invalid'); });
        o.check = i.checkValidity(); o.formInvalid = f.matches(':invalid');
        i.setValidity({});
        o.valid = i.validity.valid + ':' + f.matches(':invalid');
        try { document.createElement('div').attachInternals(); o.plain = 'none'; } catch (e) { o.plain = e.name; }
        try { xf.attachInternals(); o.twice = 'none'; } catch (e) { o.twice = e.name; }
        o.log = log.join(',');
        f.remove(); css.remove();
        r.internals = o;
      } },
      { name: 'ARIA reflection and attribute APIs', run: function () {
        var d = document.createElement('div'), o = {};
        d.innerHTML = '<span id="lb1">L1</span><span id="lb2">L2</span><button id="ab">x</button>';
        document.body.appendChild(d);
        var b = d.querySelector('#ab');
        o.empty = [b.role, b.ariaLabel, b.ariaExpanded].join(',');
        b.role = 'switch'; b.ariaChecked = 'true'; b.ariaLabel = 'Toggle'; b.ariaHidden = 'false'; b.ariaValueNow = 5;
        o.attrs = b.getAttributeNames().join(',') + '|' + b.getAttribute('aria-valuenow');
        b.setAttribute('aria-labelledby', 'lb1 lb2 nope');
        o.labelledBy = b.ariaLabelledByElements.map(function (e) { return e.id; }).join(',');
        b.ariaDescribedByElements = [d.querySelector('#lb2')];
        o.describedBy = b.getAttribute('aria-describedby') + ':' + b.ariaDescribedByElements.map(function (e) { return e.id; }).join(',');
        b.ariaLabel = null; o.removed = b.hasAttribute('aria-label');
        var at = b.getAttributeNode('role'); b.removeAttributeNode(at); o.removedNode = b.hasAttribute('role') + ':' + at.value;
        b.part.add('p1'); b.part.add('p2'); o.part = b.getAttribute('part');
        b.inputMode = 'numeric'; b.enterKeyHint = 'send'; o.hints = b.inputMode + ',' + b.enterKeyHint + ',' + b.getAttribute('inputmode') + ',' + b.translate;
        d.setAttribute('translate', 'no'); o.translate = b.translate;
        b.nonce = 'abc'; o.nonce = b.nonce + ':' + b.getAttribute('nonce');
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('xmlns:xl', 'http://www.w3.org/1999/xlink'); d.appendChild(svg);
        o.ns = [svg.lookupPrefix('http://www.w3.org/1999/xlink'), svg.isDefaultNamespace('http://www.w3.org/2000/svg'), d.isDefaultNamespace('http://www.w3.org/1999/xhtml'), document.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'svg').length > 0, d.getElementsByTagNameNS('*', 'span').length].join(',');
        o.visible = [b.checkVisibility(), (d.style.display = 'none', b.checkVisibility())].join(',');
        d.style.display = ''; b.style.opacity = '0'; o.opacity = [b.checkVisibility(), b.checkVisibility({ checkOpacity: true })].join(',');
        d.remove();
        r.aria = o;
      } },
      { name: 'Shadow DOM: manual slots, getHTML, setHTMLUnsafe', run: function () {
        var h = document.createElement('div'); h.innerHTML = '<span id="m1">one</span><span id="m2">two</span>'; document.body.appendChild(h);
        var sr = h.attachShadow({ mode: 'open', slotAssignment: 'manual', serializable: true });
        sr.innerHTML = '<slot id="sa"></slot>|<slot id="sb"></slot>';
        var sa = sr.getElementById('sa'), sb = sr.getElementById('sb'), m1 = h.children[0], m2 = h.children[1], o = {};
        o.mode = sr.slotAssignment + ':' + sr.serializable + ':' + sr.clonable;
        o.before = sa.assignedNodes().length + ':' + (m1.assignedSlot === null);
        sa.assign(m2); sb.assign(m1);
        o.assigned = sa.assignedNodes().map(function (n) { return n.id; }).join(',') + '/' + sb.assignedElements().map(function (n) { return n.id; }).join(',') + '/' + (m1.assignedSlot === sb);
        sb.assign(m2);
        o.moved = sa.assignedNodes().length + ':' + sb.assignedNodes().map(function (n) { return n.id; }).join(',') + ':' + (m1.assignedSlot === null);
        var w = document.createElement('div'); w.appendChild(h);
        o.html = w.getHTML({ serializableShadowRoots: true });
        o.plain = w.getHTML();
        var t = document.createElement('div');
        t.setHTMLUnsafe('<p id="dh"><template shadowrootmode="open"><b>in shadow</b><slot></slot></template>light</p>');
        var dh = t.firstChild;
        o.declarative = !!dh.shadowRoot + ':' + (dh.shadowRoot && dh.shadowRoot.innerHTML) + ':' + dh.innerHTML;
        r.shadowMore = o;
      } },
      { name: 'Events, media, SVG and window members', run: function () {
        var o = {};
        var me = new MouseEvent('mousedown', { clientX: 10, clientY: 20, button: 2 });
        o.mouse = [me.x, me.y, me.which, me.layerX].join(',');
        var pe = new PointerEvent('pointermove', { tiltX: 5, twist: 30, pressure: 0.5 });
        o.pointer = [pe.tiltX, pe.tiltY, pe.twist, pe.tangentialPressure, pe.getCoalescedEvents().length, pe.getPredictedEvents().length].join(',');
        var ps = new PopStateEvent('popstate', { state: { a: 1 } }), hc = new HashChangeEvent('hashchange', { oldURL: 'a', newURL: 'b' }), se = new StorageEvent('storage', { key: 'k', newValue: 'v' });
        o.events = [ps.state.a, hc.oldURL + hc.newURL, se.key + se.newValue + se.oldValue, new PageTransitionEvent('pageshow', { persisted: true }).persisted, typeof TouchEvent].join(',');
        o.ifaces = [navigator instanceof Navigator, history instanceof History, localStorage instanceof Storage, performance instanceof Performance, screen instanceof Screen, customElements instanceof CustomElementRegistry, location instanceof Location, visualViewport instanceof VisualViewport, typeof performance.toJSON().timeOrigin].join(',');
        o.vv = [visualViewport.width === innerWidth, visualViewport.scale, visualViewport.offsetTop].join(',');
        var v = document.createElement('video');
        o.media = [v.paused, isNaN(v.duration), v.currentTime, v.readyState, v.networkState, v.muted, v.volume, v.playbackRate, v.loop, v.ended, v.src, v.buffered.length].join(',');
        v.loop = true; v.muted = true; v.volume = 0.5; v.currentTime = 3;
        o.media2 = [v.hasAttribute('loop'), v.muted, v.hasAttribute('muted'), v.volume, v.currentTime].join(',');
        try { v.volume = 2; } catch (e) { o.volErr = e.name; }
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 100 50'); svg.setAttribute('width', '200');
        o.svg = [svg.viewBox.baseVal.x, svg.viewBox.baseVal.width, svg.viewBox.baseVal.height, svg.width.baseVal.value, svg.width.baseVal.valueAsString].join(',');
        var dlg = document.createElement('dialog'); document.body.appendChild(dlg); dlg.show(); var ev = [];
        dlg.addEventListener('cancel', function () { ev.push('cancel'); }); dlg.addEventListener('close', function () { ev.push('close'); });
        dlg.requestClose('rv'); o.dialog = [dlg.open, dlg.returnValue, ev.join('+')].join(','); dlg.remove();
        o.blob = typeof new Blob(['a']).stream().getReader + ',' + typeof new Blob(['a']).bytes;
        var hd = new Headers(); hd.append('Set-Cookie', 'a=1'); hd.append('Set-Cookie', 'b=2; Path=/'); o.cookies = hd.getSetCookie().join('|');
        o.mediaList = (function () { var s = new CSSStyleSheet({ media: 'screen' }); s.media.appendMedium('print'); return s.media.mediaText + ':' + s.media.length + ':' + s.ownerRule; })();
        CSS.registerProperty({ name: '--wc-reg', syntax: '<length>', inherits: false, initialValue: '7px' });
        o.registered = getComputedStyle(document.body).getPropertyValue('--wc-reg').trim();
        try { CSS.registerProperty({ name: '--wc-reg', syntax: '*', inherits: false }); } catch (e) { o.regTwice = e.name; }
        r.misc = o;
      } }
    ],
    probe: function () { return r; }
  };
})();
