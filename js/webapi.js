// SPDX-License-Identifier: MIT
//
// web/dom's Web API for a script engine without a browser (CErXes in
// bin/mfiles-uix): the DOM (nodes, elements, attributes, events, focus,
// selectors, innerHTML), the window's objects a page uses (timers,
// MessageChannel, requestAnimationFrame, observers, storage, matchMedia,
// getComputedStyle), and the CSS cascade that gives each element its
// computed style. It runs after prelude.js (the sandbox's postMessage and
// timers) and takes over `document`.
//
// The engine has no host functions: the host drives the page by calling
//
//   __page(html, url)     parse the page and make it the document
//   __addStyle(css, url)  a style sheet of the page (<link rel=stylesheet>)
//   __loaded()            DOMContentLoaded and load, after the scripts
//   __render()            JSON text: the rendered tree (elements with their
//                         computed style, text), see renderNode
//   __deltaRender(on)     the host keeps the last page: __renderDelta() and a
//                         forced layout (__hostSync) send what changed, the
//                         rest named ({"r": n}); see renderJson
//   __renderDelta(again)  __render() for such a host; again: it lost what
//                         it kept, the whole page is sent
//   __styleCheck()        a test's: '' when the page with every style found
//                         again is the page the kept styles give
//   __layout(json)        the boxes the host laid out: {"id": [x, y, w, h]}
//                         and {"viewport": [w, h]}
//   __input(json)         an event from the user, see hostInput
//   __resume()            the realm was started from a snapshot taken
//                         earlier: its clock (performance) starts now
//
// and reads the scripts to run from __scripts() after __page.

(function (G) {
  'use strict';

  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var nextNodeId = 1;
  // bumped by every change to what the page shows (render, childNodes)
  var generation = 1;
  // bumped by every change that can change a computed style: not by a
  // text's change that keeps its element's :empty (a count-up's numbers),
  // so the styles are not cascaded again for every animation frame
  var styleGen = 1;
  // inside textContent's set: its text nodes' moves are judged at its end
  var textEdit = 0;
  var boxes = {};
  var viewport = { w: 1024, h: 768 };
  var doc = null;

  function changed() { generation++; styleGen++; sheetGen++; ancEpoch++; sigEpoch++; }
  // bumped with styleGen, and alone when a <style> came, went or changed
  // with rules that only some elements can match (styleSheetChanged): what
  // is read from the sheets (their list, rule sets, selectorReach, the
  // features, keyframes) is kept per sheetGen, a computed style per styleGen
  var sheetGen = 1;
  // registered custom properties (@property, CSS.registerProperty): name ->
  // { inh, init }; the first registration of a name stands, the API's over
  // a rule's
  var regProps = null, regNoInherit = false;
  function registerProp(name, inh, init, api) {
    var had = regProps && regProps[name], iv = init === undefined || init === null ? undefined : String(init).trim();
    if (had && had.api && !api) return false;
    if (had && had.inh === !!inh && had.init === iv) { had.api = had.api || !!api; return false; }
    (regProps || (regProps = {}))[name] = { inh: !!inh, init: iv, api: !!api };
    regNoInherit = false;
    for (var k in regProps) if (!regProps[k].inh) regNoInherit = true;
    changed();
    return true;
  }
  // moves when any attribute but style, or the tree, changes: an element's
  // signature (sigOf) is as of one value of it
  var sigEpoch = 1;
  // moves when an element's class or id or the tree changes: what an
  // element keeps of its ancestors' names (ancOf) is as of one value of it
  var ancEpoch = 1;
  // the top layer (CSS Position 4, 3): open popovers and modal dialogs, in
  // the order they went in; rendered after everything else, each a box of
  // the initial containing block
  var topLayer = [], topNow = null;
  function topAdd(el) { if (topLayer.indexOf(el) < 0 && overlayLingers(el)) { changed(); return; } var i = topLayer.indexOf(el); if (i >= 0) topLayer.splice(i, 1); topLayer.push(el); el._top = true; changed(); }
  // (an element whose overlay transitions stays in the top layer until the
  // transition ends, CSS Position 4, 3.2: the end is not reached here)
  function overlayLingers(el) {
    var cs = computedOf(el), tp = String(cs['transition-property'] || cs.transition || '');
    if (!/(^|[\s,])(overlay|all)([\s,]|$)/.test(tp) && !/(^|[\s,])overlay\s/.test(String(cs.transition || ''))) return false;
    return /[1-9]/.test(String(cs['transition-duration'] || cs.transition || ''));
  }
  function topRemove(el) { if (overlayLingers(el)) return; var i = topLayer.indexOf(el); if (i >= 0) topLayer.splice(i, 1); el._top = false; changed(); }
  // the last text or attribute change: an element renders again when one
  // was under it (_rv), the rest of the page comes from the last render
  // (renderJson)
  var textStamp = 0;
  // An attribute of el changed: when no selector of the page looks up the
  // tree (:has()) or counts siblings by their attributes (:nth-child(.. of
  // S)), only el and what is under it are styled again, and its following
  // siblings when a selector has a + or ~ combinator; else the whole page
  // (changed)
  function attrChanged(el, name, was, now) {
    if (name === 'class' || name === 'id' || name === undefined) ancEpoch++;
    if (name !== 'style') sigEpoch++;
    var conn = el.isConnected;
    if (shadowCount && conn && inShadowScope(el)) { changed(); if (name === 'slot' || name === 'name') scheduleSlots(name === 'slot' ? assignedSlotOf(el) : null); return; }
    // an element not in the page (React sets a new element's attributes
    // before it inserts it): nothing shown changes; what it kept goes
    if (!conn && doc && el.ownerDocument === doc) {
      // (el._es: el or something under it was styled at some time, see
      // computedOf. A grid builds each row out of the page, attribute by
      // attribute: nothing there is kept, and each change walked the row.)
      if (computedCache.gen === styleGen && (el._es || shadowCount)) { dropStyle(el); eachElement(el, dropStyle); }
      return;
    }
    // (the root's inline style too: what matches stays, what its children
    // take from it is inheritDown's. vaul sets the root's style for each
    // drawer that opens or closes.)
    var reach = conn && doc && el.ownerDocument === doc && (el !== doc.documentElement || name === 'style') ? selectorReach() : 0;
    if (!reach) { changed(); return; }
    generation++;
    textStamp++;
    // (el._tfv: el's own transform was the last change at or under it,
    // el._tf0: what el._rv was before the first of such changes in a row;
    // a render of el from then on has only el's transform to change,
    // movedJson)
    if (name === 'style' && el._styleSync && el._styleChg && el._styleChg.length === 1 && (el._styleChg[0] === 'transform' || el._styleChg[0] === 'opacity')) { if (el._rv !== el._tfv || el._tfn !== el._styleChg[0]) { el._tf0 = el._rv || 0; el._tfn = el._styleChg[0]; } el._tfv = textStamp; }
    for (var p = el; p; p = p.parentNode) p._rv = textStamp;
    if (computedCache.gen !== styleGen) return;
    var old = computedCache.map[el.__id];
    // (an inline style change leaves what matched el, unless a selector
    // reads the style attribute)
    var keepHits = name === 'style' && !(featureIndex(), fxCache.styleRead) ? el._hm : null;
    var pc = el._pc;
    dropStyle(el);
    if (keepHits) el._hm = keepHits;
    if (name === 'style') {
      // (only el.style.transform, opacity... set, see patchedStyle: the
      // style el had is kept to be patched, with the names that changed)
      var chg = el._styleSync ? el._styleChg : null;
      if (keepHits && chg && (old || (pc && pc.gen === styleGen))) {
        var pel0 = el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
        if (old) pc = { gen: styleGen, cs: old, parent: pel0 ? computedCache.map[pel0.__id] || null : null, names: {} };
        for (var ci = 0; ci < chg.length; ci++) pc.names[chg[ci]] = 1;
        el._pc = pc;
      }
      // (nothing under el takes a style from it: el is styled when it is
      // next asked for, not here. 500 boxes moved by their transform each
      // frame were each styled twice a frame)
      var kidEl = !!el._sr;
      for (var ke = 0; ke < el._c.length && !kidEl; ke++) kidEl = el._c[ke].nodeType === 1;
      if (!kidEl) { hasReached(el.parentNode); return; }
      // (an inline style names no selector's feature: only what el's
      // children take from it can change under it)
      // (and the same rules match them as before, unless a selector reads
      // the style attribute: AG Grid sets a custom property on its
      // viewport after the first layout, which matched 210 elements again)
      if (!(old && (ownStyleOnly(old, computedOf(el), el) || kidsKept(el, old, computedOf(el), fxCache.styleRead ? dropStyle : dropComputed)))) {
        if (old && !fxCache.styleRead) inheritDown(el, old, computedOf(el));
        else eachElement(el, fxCache.styleRead ? dropStyle : dropComputed);
      }
    }
    // :lang() and :dir() follow the attribute down the tree, a disabled
    // fieldset's :disabled its controls
    else if (name === 'lang' || name === 'dir' || name === 'xml:lang' || (name === 'disabled' && /^(fieldset|optgroup)$/.test(el.localName))) eachElement(el, dropStyle);
    // (what the attribute does to the selectors under el is the features'
    // part below: here only what they take from el's style)
    else if (!old) eachElement(el, dropStyle);
    else if (!(sameBelow(el, old, computedOf(el)) || kidsKept(el, old, computedOf(el), dropStyle))) inheritDown(el, old, computedOf(el));
    // what the features' sets reach: the descendants that can be a
    // selector's subject under el, the following siblings
    if (name !== 'style') invalidateFeatures(el, changedFeatures(name, was, now));
    hasReached(el.parentNode);
  }
  // a text control's value changed: as an attribute of it (its
  // :placeholder-shown, what follows it for + and ~, ancestors for :has())
  function valueChanged(el) { attrChanged(el); validityChanged(el); }
  // a control's value or a constraint changed: its form and fieldsets may
  // go :valid / :invalid (each styled again with what is under it)
  function validityChanged(el) {
    if (!el || !el.isConnected) return;
    for (var p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.localName === 'form' || p.localName === 'fieldset') attrChanged(p);
  }
  var VALIDATION_ATTRS = { required: 1, pattern: 1, min: 1, max: 1, step: 1, type: 1, multiple: 1, disabled: 1, readonly: 1, value: 1, checked: 1 };
  // e keeps a style or the rules that matched it: noted on it and on what
  // it is in (_es), so a subtree never styled is known by its root
  function styledNow(e) { for (; e && !e._es; e = e.parentNode) e._es = true; }
  // (and not from its style without animations: e._abKeep, animRestyle)
  function dropStyle(e) { keepOld(e); delete computedCache.map[e.__id]; e._rj = null; e._hm = null; e._pc = null; e._abKeep = false; }
  // the style e had when it was dropped, until it has one again: what is
  // under it was styled from that one (styling a child styles its parent
  // first), so restyle and inheritDown compare with it. Without it, an
  // element dropped on its own (its inline style, an attribute) and then
  // restyled for a :has() or a child put in took all under it along.
  function keepOld(e) { var o = computedCache.map[e.__id]; if (o && computedCache.gen === styleGen) { e._ocs = o; e._ocg = styleGen; } }
  function oldStyle(e) { return computedCache.map[e.__id] || (e._ocg === styleGen ? e._ocs : undefined); }
  // e's computed style goes, the rules that matched it stay (cascade1's
  // _hm): for a change that alters no selector's answer for e
  function dropComputed(e) { keepOld(e); delete computedCache.map[e.__id]; e._rj = null; e._pc = null; e._abKeep = false; }
  // e styled again; what is under it too unless e's style changed only in
  // what its children do not take from it
  function restyle(e) {
    var old = oldStyle(e);
    dropStyle(e);
    if (old && (sameBelow(e, old, computedOf(e)) || kidsKept(e, old, computedOf(e), dropStyle))) return true;
    if (old) inheritDown(e, old, computedOf(e));
    else eachElement(e, dropStyle);
    return false;
  }
  // el's style went from a to b and what matches under el is as it was
  // (the change was el's own: its inline style, an attribute whose
  // selectors the features reach, a :has() of it, its place): each
  // child's style is found again from the rules it matched (its _hm kept),
  // and one that comes out alike keeps its style object and all under it,
  // the others pass the question on. Radix sets body's pointer-events and
  // react-remove-scroll's data-scroll-locked on every dialog and menu:
  // each matched all 2 500 elements of the page again.
  function inheritDown(el, a, b) {
    var kids = el._sr ? null : el._c;
    if (!kids || shadowCount) { eachElement(el, dropStyle); return; }
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c._attrs === undefined) continue;
      var cc = oldStyle(c), pc = c._pc;
      if (!cc || pc || c._ab) { dropStyle(c); eachElement(c, dropStyle); continue; }
      dropComputed(c);
      var nc = computedOf(c);
      // (alike: what is under c keeps its styles, and its renders take
      // c's new style object as their parent's, sameStyle. c's own render
      // goes: it writes what c inherits as it differs from el's, which
      // changed)
      if (nc === cc || sameStyle(cc, nc, c)) continue;
      inheritDown(c, cc, nc);
    }
  }
  // e's animations moved on (a frame): when nothing else dropped its style
  // since, the style it has without them is kept (e._ab) and only the
  // animations are applied again; otherwise as restyle
  function animRestyle(e) {
    var old = computedCache.map[e.__id], ab = e._ab;
    // (already to be made from the kept style: a frame and an animation's
    // end in one tick; restyled whole, Motion's 120 boxes each went
    // through the cascade when their tween ended)
    if (e === waapiEl || (!old && ab && e._abKeep && ab.gen === styleGen)) return true;
    // (its inline style just set, to be patched, patchedStyle: kept;
    // Motion sets each box's start value, then animates it)
    if (!old && e._pc) {
      eachElement(e, dropStyle);
      return false;
    }
    // (its first animation: the style it has is the one without)
    if (old && !ab && !shadowCount && !e._anims && !(old.animation && old.animation !== 'none') && !(old['animation-name'] && old['animation-name'] !== 'none')) {
      var pel = e.parentNode && e.parentNode.nodeType === 1 ? e.parentNode : null, ps = pel ? computedCache.map[pel.__id] : null;
      if (ps && old.display !== 'table-cell') ab = e._ab = { gen: styleGen, parent: ps, base: old, out: old, t: animNow() };
    }
    if (!old || !ab || ab.gen !== styleGen || ab.out !== old) return restyle(e);
    delete computedCache.map[e.__id];
    e._rj = null; e._pc = null;
    e._abKeep = true;
    // (nothing under it takes a style from it: no element, no shadow tree)
    if (!e._sr) {
      var kid = false;
      for (var ki = 0; ki < e._c.length && !kid; ki++) kid = e._c[ki]._attrs !== undefined;
      if (!kid) return true;
    }
    if (sameBelow(e, old, computedOf(e))) return true;
    eachElement(e, dropStyle);
    return false;
  }
  // a computed style's copy, its hidden properties too (_sid new)
  function copyStyle(c) {
    var out = {};
    for (var k in c) out[k] = c[k];
    var names = Object.getOwnPropertyNames(c);
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (n === '_sid' || Object.prototype.propertyIsEnumerable.call(c, n)) continue;
      Object.defineProperty(out, n, { value: c[n], enumerable: false, configurable: true, writable: true });
    }
    Object.defineProperty(out, '_sid', { value: ++styleUid, enumerable: false });
    return out;
  }
  // what nothing renders, only getComputedStyle reads (the host keeps its own
  // cursor): React Flow's pane gets cursor: grabbing for a drag, which every
  // node, edge and label under it would take
  var UNSHOWN = { cursor: 1 };
  // two elements' custom properties alike (most often the one object)
  function varsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    var n = 0;
    for (var k in a) { if (a[k] !== b[k]) return false; n++; }
    for (var k2 in b) n--;
    return n === 0;
  }
  function unshownOnly(a, b) {
    for (var k in a) if (k.charAt(0) !== '_' && a[k] !== b[k] && !UNSHOWN[k]) return false;
    for (var k2 in b) if (k2.charAt(0) !== '_' && a[k2] === undefined && b[k2] !== undefined && !UNSHOWN[k2]) return false;
    return a._fontPx === b._fontPx && varsEqual(a._vars, b._vars);
  }
  // el's style went from a to b (b in the cache): true when what is under it
  // keeps its rendering; a change in UNSHOWN goes down to the children that
  // took it from el, each styled again, their own rendering kept
  function sameBelow(el, a, b) {
    if (sameStyle(a, b, el)) return true;
    if (!unshownOnly(a, b)) return false;
    var map = computedCache.map;
    for (var i = 0; i < el._c.length; i++) {
      var c = el._c[i];
      if (c.nodeType !== 1) continue;
      var cc = map[c.__id];
      if (!cc) { dropStyle(c); eachElement(c, dropStyle); continue; }
      var took = false;
      for (var k in UNSHOWN) if (a[k] !== b[k] && cc[k] === a[k]) took = true;
      if (!took) { if (c._rj && c._rj.ps === a) c._rj.ps = b; continue; }
      // c renders again (its kept JSON holds its children's); what is
      // under it as sameBelow says
      dropStyle(c);
      if (!sameBelow(c, cc, computedOf(c))) eachElement(c, dropStyle);
    }
    return true;
  }
  // what of a box's style nothing under it takes, in its style or in how
  // it is rendered: its own size, spacing, paint and how it places its
  // children (the host lays them out again)
  var BOX_ONLY = { width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1, 'box-sizing': 1, 'aspect-ratio': 1,
    'margin-top': 1, 'margin-right': 1, 'margin-bottom': 1, 'margin-left': 1, 'padding-top': 1, 'padding-right': 1, 'padding-bottom': 1, 'padding-left': 1,
    'border-top-width': 1, 'border-right-width': 1, 'border-bottom-width': 1, 'border-left-width': 1, 'border-top-style': 1, 'border-right-style': 1, 'border-bottom-style': 1, 'border-left-style': 1,
    'border-top-color': 1, 'border-right-color': 1, 'border-bottom-color': 1, 'border-left-color': 1,
    'border-top-left-radius': 1, 'border-top-right-radius': 1, 'border-bottom-left-radius': 1, 'border-bottom-right-radius': 1,
    'background-color': 1, 'background-image': 1, 'background-position': 1, 'background-size': 1, 'background-repeat': 1, 'background-origin': 1, 'background-clip': 1, 'box-shadow': 1,
    'outline-color': 1, 'outline-style': 1, 'outline-width': 1, 'outline-offset': 1,
    gap: 1, 'row-gap': 1, 'column-gap': 1, 'flex-basis': 1, 'flex-grow': 1, 'flex-shrink': 1, order: 1, 'align-self': 1, 'justify-self': 1,
    'flex-wrap': 1, 'flex-direction': 1, 'align-items': 1, 'justify-content': 1, 'align-content': 1, 'justify-items': 1,
    'grid-template-columns': 1, 'grid-template-rows': 1, 'grid-template-areas': 1, 'grid-auto-rows': 1, 'grid-auto-columns': 1, 'grid-auto-flow': 1,
    'grid-row-start': 1, 'grid-row-end': 1, 'grid-column-start': 1, 'grid-column-end': 1 };
  var KEPT_NOT = /^(inline-)?table|^table-|^contents$|^none$/;
  // el's style went from a to b (b in the cache), alike in what its
  // children inherit and different only in BOX_ONLY, OWN_ONLY and the
  // display: each child is styled again (its display follows el's, its
  // declarations may say `inherit`), and one whose style comes out alike
  // keeps all under it, and its own rendering when el's display stayed.
  // The others are dropped with what is under them (drop). False when el's
  // change is of another kind: nothing done. (A grid whose width or
  // template changed styled and rendered its 2 850 descendants again, to
  // the same styles and the same text.)
  function kidsKept(el, a, b, drop) {
    if (shadowCount || a._fontPx !== b._fontPx || a._fsKw !== b._fsKw || !varsEqual(a._vars, b._vars)) return false;
    if (KEPT_NOT.test(a.display || '') || KEPT_NOT.test(b.display || '')) return false;
    for (var k in a) if (k.charCodeAt(0) !== 95 && a[k] !== b[k] && !BOX_ONLY[k] && !OWN_ONLY[k] && k !== 'display') return false;
    for (var k2 in b) if (k2.charCodeAt(0) !== 95 && a[k2] === undefined && b[k2] !== undefined && !BOX_ONLY[k2] && !OWN_ONLY[k2] && k2 !== 'display') return false;
    var disp = a.display !== b.display, map = computedCache.map;
    for (var i = 0; i < el._c.length; i++) {
      var c = el._c[i];
      if (c.nodeType !== 1) continue;
      var cc = map[c.__id], rj = c._rj;
      drop(c);
      if (!cc) { eachElement(c, drop); continue; }
      var nc = computedOf(c);
      if (nc === cc || sameStyle(cc, nc, c)) {
        // (a text field's width in a flex row follows the row's, renderNode)
        if (!disp && rj && rj.ps === a && c.localName !== 'input') { rj.ps = b; c._rj = rj; }
        continue;
      }
      // (its own box only: the same question for its children)
      if (!kidsKept(c, cc, nc, drop)) eachElement(c, drop);
    }
    return true;
  }
  // An element went into p or out of it (c: the one put in): when no
  // selector looks up the tree, only p and its children are styled again
  // (their :empty, :last-child; their children only when one's style
  // changed), the following ones whole for a + or ~ combinator, all of
  // them whole when a structural pseudo-class is not the subject's; else the
  // whole page (changed). React Flow puts its nodes in one parent, so a node
  // added or moved restyled every node.
  // (detach: gone, the element taken out, and at, where it was)
  function treeChanged(p, c, gone, at) {
    ancEpoch++; sigEpoch++;
    // (a styled element put under ones never styled: they hold one now)
    if (c && c._es) for (var es = p; es && !es._es; es = es.parentNode) es._es = true;
    if (shadowCount && (p.nodeType === 11 && p.host || inShadowScope(p))) { changed(); scheduleSlots(p._sr && (c || gone) ? assignedSlotOf(c || gone) : null); return; }
    // not in the page (a fragment, a parsed document): nothing shown
    if (!doc || (p !== doc && (p.ownerDocument !== doc || !p.isConnected))) { generation++; return; }
    // (a style sheet's text is its rules)
    if (p.localName === 'style') { if (p.isConnected) styleSheetChanged(p, p._sheet); else changed(); return; }
    var reach = p !== doc && p !== doc.documentElement ? selectorReach() : 0;
    if (!reach) { changed(); return; }
    generation++;
    textStamp++;
    for (var q = p; q; q = q.parentNode) q._rv = textStamp;
    if (computedCache.gen !== styleGen) return;
    if (c && c.nodeType === 1 && (c._es || shadowCount)) { dropStyle(c); eachElement(c, dropStyle); }
    // what the change does to p's other children is found once for all the
    // changes to p before the next style is read (flushTree): a loop that
    // puts in or takes out 1 000 rows went through all the rows each time
    var kids = p._c, i = c ? indexIn(c) : at;
    var r = treePending.get(p);
    if (!r) { r = { p: p, from: i, touched: [], sibItems: [], whole: false }; treePending.set(p, r); }
    if (i < r.from) r.from = i;
    // a + or ~ reaches the siblings after the change only when the element
    // put in or taken out, or the one before it, can match their left side
    if (reach === 2) {
      featureIndex();
      var sl = fxCache.sibs, lefts = c ? [c, prevElement(kids, i)] : [gone, prevElement(kids, at)];
      for (var li = 0; li < lefts.length; li++) {
        var le = lefts[li];
        if (!le || le.nodeType !== 1) continue;
        var hit = sibHits(le, sl);
        for (var si = 0; si < hit.length; si++) if (r.sibItems.indexOf(hit[si]) < 0) r.sibItems.push(hit[si]);
      }
    }
    if (!c && at === undefined) r.whole = true;
    // the elements next to the change, of all and of its type: the ones
    // whose :first-child, :last-child (-of-type) can change with it
    if (reachCache.struct) {
      var t = c ? c.localName : gone && gone.localName;
      for (var dir = -1; dir <= 1; dir += 2) {
        var any = null, same = null;
        for (var j = c ? i + dir : (dir < 0 ? i - 1 : i); j >= 0 && j < kids.length && !(any && same); j += dir) {
          var k = kids[j];
          if (k === c || k.nodeType !== 1) continue;
          if (!any) any = k;
          if (!same && k.localName === t) same = k;
        }
        if (any) r.touched.push(any);
        if (same && same !== any) r.touched.push(same);
      }
    }
  }
  // the left sides of + and ~ an element matches (sl: fxCache.sibs; their
  // compounds hold no pseudo-class, so elements of the same tag, classes,
  // id and attributes match the same ones: remembered by those)
  var sibMemo = { sl: null, map: new Map(), n: 0 };
  function sibHits(el, sl) {
    if (sibMemo.sl !== sl || sibMemo.n > 5000) sibMemo = { sl: sl, map: new Map(), n: 0 };
    var key = el.namespaceURI === HTML_NS ? el.localName : el.namespaceURI + ' ' + el.localName, at = el._attrs;
    for (var a = 0; a < at.length; a++) key += '\u0001' + at[a].name + '\u0002' + (at[a].name === 'class' || at[a].name === 'id' || sibAttrs(sl)[at[a].name.toLowerCase()] ? at[a].value : '');
    var hit = sibMemo.map.get(key);
    if (hit) return hit;
    hit = [];
    for (var i = 0; i < sl.length; i++) if (matchCompound(el, sl[i].comp, null)) hit.push(sl[i]);
    sibMemo.map.set(key, hit);
    sibMemo.n++;
    return hit;
  }
  function sibAttrs(sl) {
    if (sl._attrs) return sl._attrs;
    var o = {};
    for (var i = 0; i < sl.length; i++) for (var j = 0; j < sl[i].comp.length; j++) if (sl[i].comp[j].t === 'attr') o[sl[i].comp[j].n] = true;
    Object.defineProperty(sl, '_attrs', { value: o, enumerable: false });
    return o;
  }
  var treePending = new Map(), treeFlushing = false;
  // the changes to the children of each parent since the last style read:
  // p styled again, and the children the change can reach: those after it
  // for + and ~, the first and last ones and those next to a change for
  // :first-child and the like, all of them for :nth-child() (counted)
  function flushTree() {
    if (!treePending.size || treeFlushing) return;
    treeFlushing = true;
    var list = Array.from(treePending.values());
    treePending.clear();
    if (computedCache.gen === styleGen) for (var n = 0; n < list.length; n++) {
      var r = list[n], p = r.p;
      if (p !== doc && !p.isConnected) continue;
      var st = reachCache.gen === sheetGen ? reachCache.struct : (selectorReach(), reachCache.struct);
      if (p.nodeType === 1) restyle(p);
      var kids = p._c;
      // Monaco's view lines and overlays: dozens of children, a line in or
      // out on each change, and only :first-child / :last-child in its
      // sheet (some above a subject: those children are styled again whole)
      var edges = st && !reachCache.counted ? edgeChildren(p).concat(r.touched) : null;
      // with :nth-child() and the like: the children whose place (among
      // all, among their type, from either end) is not the one their style
      // was found with (a swap of two rows: those two)
      if (st && reachCache.counted) { p._kv = undefined; kidPositions(p); }
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType !== 1) continue;
        var edge = !edges || edges.indexOf(k) >= 0;
        if (st && reachCache.counted) {
          var pos = k._posE + ',' + k._posT + ',' + k._posEE + ',' + k._posTE;
          edge = k._posS !== pos;
          k._posS = pos;
        }
        var sib = false;
        if (r.sibItems.length && (r.whole || i >= r.from)) for (var sj = 0; sj < r.sibItems.length && !sib; sj++) sib = r.sibItems[sj].deep || keyFits(k, r.sibItems[sj].keys);
        if ((st === 2 && edge) || sib) { dropStyle(k); eachElement(k, dropStyle); }
        else if (st && edge) restyle(k);
      }
      hasReached(p.nodeType === 1 ? p.parentNode : null);
      // (p itself can be the compound with the :has())
      if (p.nodeType === 1) hasAbove(p);
    }
    treeFlushing = false;
  }
  // An element's inline style changed only in what its children do not
  // take from it (a pan's or a drag's transform, left and top): what is
  // under it keeps its styles and its last render, which takes the new
  // style as the parent it was rendered under (React Flow's viewport holds
  // every node and edge; each pointer move sets its transform)
  var OWN_ONLY = { transform: 1, 'transform-origin': 1, translate: 1, scale: 1, rotate: 1, left: 1, top: 1, right: 1, bottom: 1, 'z-index': 1, opacity: 1, 'will-change': 1 };
  function ownStyleOnly(a, b, el) { return sameStyle(a, b, el, OWN_ONLY); }
  // a and b alike for el's children (but in `own`); then the children's
  // last render takes b as the parent it was made under
  function sameStyle(a, b, el, own) {
    own = own || {};
    for (var k in a) if (k.charAt(0) !== '_' && a[k] !== b[k] && !own[k]) return false;
    // (a name held with no value, `scrollbar-width: var(--unset)`, is in both:
    // AG Grid has it on every element, and each change of a parent's
    // children styled all under it again)
    for (var k2 in b) if (k2.charAt(0) !== '_' && a[k2] === undefined && b[k2] !== undefined && !own[k2]) return false;
    if (a._fontPx !== b._fontPx || !varsEqual(a._vars, b._vars)) return false;
    for (var i = 0; i < el._c.length; i++) {
      var c = el._c[i];
      if (c._rj && c._rj.ps === a) c._rj.ps = b;
    }
    return true;
  }
  // 1: an element's style depends only on it and its ancestors; 2: on its
  // preceding siblings too (+, ~); 0: on more
  // and struct: 0 no structural pseudo-class (:last-child, :nth-child(),
  // :empty...), 1 only on a selector's subject, 2 elsewhere too
  // and hover: the same for :hover and :active, focus for :focus...
  var reachCache = { gen: -1, reach: 0, struct: 0, hover: 0, focus: 0, focusWithin: 0, has: 0, sib: [] };
  // the compounds left of a + or ~ in a selector list (`.a.b + .c`: .a.b),
  // each as its type, id and classes (what can only narrow it, attributes
  // and pseudo-classes, left out: `complex` says it had some). Only an
  // element one of them can match changes what its following siblings
  // match; Monaco's sheet has two (.monaco-button.secondary + ...), and
  // without this a view line's style or a line put in styled every line
  // after it again.
  function siblingLefts(t) {
    var out = [], depth = 0, q = '';
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (q) { if (ch === '\\') i++; else if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '\\') { i++; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0 && (ch === '+' || ch === '~')) {
        var e = i - 1;
        while (e >= 0 && /\s/.test(t.charAt(e))) e--;
        var b = e, d = 0;
        for (; b >= 0; b--) {
          var c = t.charAt(b);
          if (c === ')' || c === ']') d++;
          else if (c === '(' || c === '[') d--;
          else if (d === 0 && /[\s>+~,]/.test(c)) break;
        }
        out.push(looseCompound(t.slice(b + 1, e + 1)));
      }
    }
    return out;
  }
  function looseCompound(src) {
    var flat = '', d = 0;
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (ch === '(' || ch === '[') { if (!d) flat += ch === '[' ? '[' : ':'; d++; continue; }
      if (ch === ')' || ch === ']') { d--; continue; }
      if (!d) flat += ch;
    }
    // (an escape, a namespace or a name past ASCII: taken as any element)
    if (/[\\|]|[^\x00-\x7f]/.test(flat)) return { tag: '', id: '', cls: [], complex: true };
    var tag = /^([a-zA-Z][\w-]*)/.exec(flat), id = /#([\w-]+)/.exec(flat), cls = [], m, re = /\.([\w-]+)/g;
    while ((m = re.exec(flat))) cls.push(m[1].toLowerCase());
    return { tag: tag ? tag[1].toLowerCase() : '', id: id ? id[1].toLowerCase() : '', cls: cls, complex: /[[:]/.test(flat) };
  }
  function prevElement(kids, at) {
    for (var i = at - 1; i >= 0; i--) if (kids[i].nodeType === 1) return kids[i];
    return null;
  }
  // a selector's subject has :has(): what changed under el can change
  // whether el's ancestors match, so they are styled again (each one's
  // subtree only when its style changed). Monaco's style sheet has
  // `.rendered-markdown li:has(input[type=checkbox])`; without this each
  // blink of its cursor styled and rendered the whole page again.
  function hasReached(el) {
    if (!reachCache.has || computedCache.gen !== styleGen) return;
    // (only an ancestor that a :has() rule's subject can be: by the rules'
    // keys, hasSubj. Tailwind's `has-[>svg]:px-3` is on buttons; every
    // ancestor of each change was styled again, and one whose style had
    // been dropped took everything under it along: the page)
    var hs = reachCache.hasAll ? null : reachCache.hasSubj;
    for (var a = el; a && a.nodeType === 1; a = a.parentNode) if (!hs || keyedBy(a, hs)) restyle(a);
    hasAbove(el);
  }
  // :has() above a selector's subject (PrimeReact's
  // `.p-checkbox:has(.p-checkbox-input:hover) .p-checkbox-box`): what
  // changed at or under el can change the style of anything under an
  // element that such a compound can match (hasAnchors: by its tag, id or
  // classes), so the topmost one of those above is styled again with all
  // under it. Before, one such selector made every change of an attribute
  // or of the tree style the whole page again.
  function hasAbove(el) {
    if (reachCache.has !== 2 || computedCache.gen !== styleGen) return;
    var hk = reachCache.hasKeys, sk = hk.sibOn ? hk.sib : null, top = null;
    for (var a = el; a && a.nodeType === 1; a = a.parentNode) {
      if (hasKeyHit(a, hk)) top = a;
      // (`.step:has(~ .on) .line`: the compound is a sibling of what
      // changed, or of something above it, so the parent's subtree)
      else if (sk) for (var k = 0; k < a._c.length; k++) if (a._c[k].nodeType === 1 && hasKeyHit(a._c[k], sk)) { top = a; break; }
    }
    if (top) { dropStyle(top); eachElement(top, dropStyle); }
  }
  function hasKeyHit(a, hk) {
    if (hk.tag[a.localName] === 1 || (a.id && hk.id[String(a.id).toLowerCase()] === 1)) return true;
    var cl = a.getAttribute('class');
    if (cl) { var cs = cl.split(/\s+/); for (var j = 0; j < cs.length; j++) if (hk.cls[cs[j].toLowerCase()] === 1) return true; }
    return false;
  }
  // The compounds that have :has() above their selector's subject, as
  // keys (looseCompound). null when one has no tag, id or class, or a + or
  // ~ follows it (what it reaches is not under it): the page then.
  function hasAnchors(t, sib) {
    var out = [], src = String(t).split('{')[0], sels = [], d = 0, from = 0, i;
    for (i = 0; i < src.length; i++) {
      var c = src.charAt(i);
      if (c === '(' || c === '[') d++;
      else if (c === ')' || c === ']') d--;
      else if (c === ',' && d === 0) { sels.push(src.slice(from, i)); from = i + 1; }
    }
    sels.push(src.slice(from));
    for (var si = 0; si < sels.length; si++) {
      var sl = sels[si].trim(), comps = [], combs = [], cur = '';
      d = 0;
      for (i = 0; i < sl.length; i++) {
        var ch = sl.charAt(i);
        if (ch === '(' || ch === '[') d++;
        else if (ch === ')' || ch === ']') d--;
        if (d === 0 && /[\s>+~]/.test(ch)) {
          var comb = ' ';
          while (i < sl.length && /[\s>+~]/.test(sl.charAt(i))) { if (!/\s/.test(sl.charAt(i))) comb = sl.charAt(i); i++; }
          i--;
          comps.push(cur); combs.push(comb); cur = '';
          continue;
        }
        cur += ch;
      }
      comps.push(cur);
      for (var k = 0; k < comps.length - (sib ? 0 : 1); k++) {
        if (!/:has\(/i.test(comps[k])) continue;
        // (sib, `:has(~ x)`: the compound's parent's subtree is styled
        // again, and what follows a + or ~ is in it)
        for (var q = k; q < combs.length && !sib; q++) if (combs[q] === '+' || combs[q] === '~') return null;
        var key = looseCompound(comps[k]);
        if (!key.tag && !key.id && !key.cls.length) return null;
        out.push(key);
      }
    }
    return out;
  }
  var HOVER = /:(hover|active)\b/;
  // focus: :focus and :focus-visible, focusWithin: :focus-within
  var FOCUS = /:focus(-visible)?(?![\w-])/;
  var FOCUS_WITHIN = /:focus-within\b/;
  var STRUCT = /:(first-child|last-child|only-child|nth-child|nth-last-child|first-of-type|last-of-type|only-of-type|nth-of-type|nth-last-of-type|empty)\b/;
  // the structural pseudo-classes that count siblings (any position can
  // change); without them only the first and last ones (of each type) can
  var COUNTED = /:(nth-child|nth-last-child|nth-of-type|nth-last-of-type)\b/;
  // p's element children that :first-child, :last-child, :only-child and
  // their -of-type forms can see change when one goes in or out: the first
  // two and last two, of all and of each type
  function edgeChildren(p) {
    var out = [], all = [], byType = {};
    for (var i = 0; i < p._c.length; i++) { var k = p._c[i]; if (k.nodeType !== 1) continue; all.push(k); (byType[k.localName] = byType[k.localName] || []).push(k); }
    var take = function (l) { for (var j = 0; j < l.length; j++) if (j < 2 || j >= l.length - 2) out.push(l[j]); };
    take(all);
    for (var t in byType) take(byType[t]);
    return out;
  }
  // where a selector's last compound starts: after its last combinator
  // outside () and []
  function subjectStart(sel) {
    var depth = 0;
    for (var i = sel.length - 1; i >= 0; i--) {
      var ch = sel.charAt(i);
      if (ch === ')' || ch === ']') depth++;
      else if (ch === '(' || ch === '[') depth--;
      else if (depth === 0 && /[\s>+~]/.test(ch)) return i + 1;
    }
    return 0;
  }
  // 1 when the pseudo-class is only in the selectors' subjects, else 2
  function pseudoPlace(t, re) {
    var sels = String(t).split('{')[0].split(','), place = 0;
    for (var si = 0; si < sels.length; si++) {
      var sl = sels[si].trim();
      var m = re.exec(sl);
      if (!m) continue;
      place = Math.max(place, m.index < subjectStart(sl) ? 2 : 1);
    }
    return place;
  }
  // the pointer's element changed (:hover, :active; focus: the focused one,
  // :focus, :focus-within): the elements on the two chains of ancestors are
  // styled again when no selector has those above its subject; none when no
  // selector has them. React Flow focuses its pane on a drag's start; its
  // `.react-flow__edge.selectable:focus .react-flow__edge-path` has :focus
  // above the subject: what is under the two is styled again too.
  function pointerStateChanged(a, b, focus) {
    if (shadowCount && (inShadowScope(a) || inShadowScope(b))) { changed(); return; }
    var reach = doc ? selectorReach() : 0;
    var h = focus ? Math.max(reachCache.focus, reachCache.focusWithin) : reachCache.hover;
    if (!reach) { changed(); return; }
    generation++;
    // the focused element renders as such: its chain renders again
    if (!h && !focus) return;
    var style = h && computedCache.gen === styleGen;
    // above a subject (`.x:hover .y`, `.x:focus-within .y`): the elements
    // whose state changed (:focus a and b, :hover, :active and
    // :focus-within those on one chain only) pass it on through the
    // features' invalidation sets, after they are styled again below
    var apart = [];
    if (computedCache.gen === styleGen && (focus ? reachCache.focus === 2 || reachCache.focusWithin === 2 : h === 2)) {
      var ca = [], cb = [];
      for (var x = a; x && x.nodeType === 1; x = x.parentNode) ca.push(x);
      for (var y = b; y && y.nodeType === 1; y = y.parentNode) cb.push(y);
      if (!focus || reachCache.focusWithin === 2) {
        for (var i1 = 0; i1 < ca.length; i1++) if (cb.indexOf(ca[i1]) < 0) apart.push(ca[i1]);
        for (var i2 = 0; i2 < cb.length; i2++) if (ca.indexOf(cb[i2]) < 0) apart.push(cb[i2]);
      }
      if (focus && reachCache.focus === 2) [a, b].forEach(function (e) { if (e && e.nodeType === 1 && apart.indexOf(e) < 0) apart.push(e); });
    }
    textStamp++;
    var seen = [];
    [a, b].forEach(function (e) {
      for (; e && e.nodeType === 1; e = e.parentNode) {
        if (seen.indexOf(e) >= 0) continue;
        seen.push(e);
        e._rv = textStamp;
        if (style && e.isConnected) restyle(e);
      }
    });
    // (:hover or :focus in a :has() above a subject)
    if (reachCache.has === 2) [a, b].forEach(function (e) { if (e && e.nodeType === 1) hasAbove(e.parentNode); });
    if (!apart.length) return;
    // (a focused element's :focus-visible goes with its :focus)
    var fs = focus ? ['p:focus', 'p:focus-visible', 'p:focus-within'] : ['p:hover', 'p:active'];
    for (var j = 0; j < apart.length; j++) {
      var el = apart[j];
      if (!el.isConnected) continue;
      if (!computedCache.map[el.__id]) restyle(el);
      invalidateFeatures(el, fs);
    }
  }
  function selectorReach() {
    if (reachCache.gen === sheetGen) return reachCache.reach;
    var reach = 1, struct = 0, hover = 0, focus = 0, within = 0, has = 0, counted = 0, sib = [], hasSubj = {}, hasAll = false;
    var hasKeys = { cls: {}, id: {}, tag: {}, sibOn: false, sib: { cls: {}, id: {}, tag: {} } };
    var sheets = [ua()].concat(cascadeSheets(doc));
    for (var i = 0; i < sheets.length && reach; i++) {
      var sr = sheetReach(sheets[i]);
      if (!sr.reach) { reach = 0; break; }
      if (sr.reach === 2) { reach = 2; sib = sib.concat(sr.sib); }
      if (sr.struct > struct) struct = sr.struct;
      if (sr.hover > hover) hover = sr.hover;
      if (sr.focus > focus) focus = sr.focus;
      if (sr.focusWithin > within) within = sr.focusWithin;
      if (sr.has > has) has = sr.has;
      if (sr.has === 2) {
        var hks = sr.hasKeys;
        ['cls', 'id', 'tag'].forEach(function (hn) { for (var hv in hks[hn]) hasKeys[hn][hv] = 1; for (var hw in hks.sib[hn]) hasKeys.sib[hn][hw] = 1; });
        if (hks.sibOn) hasKeys.sibOn = true;
      }
      if (sr.counted) counted = 1;
      if (sr.hasAll) hasAll = true;
      for (var hsk in sr.hasSubj) hasSubj[hsk] = 1;
    }
    reachCache = { gen: sheetGen, reach: reach, struct: struct, hover: hover, focus: focus, focusWithin: within, has: has, counted: counted, sib: sib, hasKeys: hasKeys, hasSubj: hasSubj, hasAll: hasAll };
    return reach;
  }
  // one sheet's part of selectorReach, read from its rules once (until
  // _rebuild gives it new ones): a page that puts in its sheets one by one
  // (AG Grid's theme: 25) read every rule of all of them again for each,
  // and a selector list's text once for each selector in it
  function sheetReach(sheet) {
    var rules = sheet._rules || [];
    if (sheet._reach && sheet._reachOf === rules) return sheet._reach;
    var reach = 1, struct = 0, hover = 0, focus = 0, within = 0, has = 0, counted = 0, sib = [], last = null, hasSubj = {}, hasAll = false;
    var hasKeys = { cls: {}, id: {}, tag: {}, sibOn: false, sib: { cls: {}, id: {}, tag: {} } };
    for (var j = 0; j < rules.length; j++) {
      var t = rules[j].text;
      // (the subjects a :has() can be, hasReached: each selector of a
      // list, so before the list's text is passed over)
      if (t && t.indexOf(':has(') >= 0 && !hasAll) { var hk0 = ruleKeys(rules[j]); if (!hk0) hasAll = true; else for (var hq = 0; hq < hk0.length; hq++) hasSubj[hk0[hq]] = 1; }
      // (the selectors of one list follow each other with the list's text)
      if (t === last) continue;
      last = t;
      var traw = String(t || '');
      // (an escaped character is a name's: Tailwind's
      // `.\[\&_tr\:last-child\]\:border-0 tr:last-child` has a
      // :last-child in its class name, which read as one above the subject
      // had every child put in or taken out restyle its siblings whole)
      t = traw.indexOf('\\') >= 0 ? traw.replace(/\\[0-9a-fA-F]{1,6}\s?|\\[^]/g, '_') : traw;
      // (every test below needs a pseudo-class or a + or ~)
      if (t.indexOf(':') < 0 && t.indexOf('+') < 0 && t.indexOf('~') < 0) continue;
      if (/\sof\s/i.test(t)) { reach = 0; break; }
      // :has() of what is under the subject (li:has(input)): a change
      // reaches the changed element's ancestors too (hasReached); one
      // relative to siblings (:has(+ x)) or above the subject: the page
      if (/:has\(/i.test(t)) {
        var sibHas = /:has\(\s*[+~]/i.test(t);
        if (sibHas || pseudoPlace(t, /:has\(/i) === 2) {
          // (above the subject: what is under the compound it is in; with
          // a + or ~ first in it: what is under the compound's parent)
          var an = hasAnchors(traw, sibHas), into = sibHas ? hasKeys.sib : hasKeys;
          if (!an) { reach = 0; break; }
          if (sibHas) hasKeys.sibOn = true;
          for (var ai = 0; ai < an.length; ai++) {
            if (an[ai].cls.length) for (var ac = 0; ac < an[ai].cls.length; ac++) into.cls[an[ai].cls[ac]] = 1;
            else if (an[ai].id) into.id[an[ai].id] = 1;
            else into.tag[an[ai].tag] = 1;
          }
          has = 2;
        } else if (!has) has = 1;
      }
      if (/[+~]/.test(t)) { var sl = siblingLefts(traw); if (sl.length) { reach = 2; sib = sib.concat(sl); } }
      if (struct < 2 && STRUCT.test(t)) struct = Math.max(struct, pseudoPlace(t, STRUCT));
      if (!counted && COUNTED.test(t)) counted = 1;
      if (hover < 2 && HOVER.test(t)) hover = Math.max(hover, pseudoPlace(t, HOVER));
      if (focus < 2 && FOCUS.test(t)) focus = Math.max(focus, pseudoPlace(t, FOCUS));
      if (within < 2 && FOCUS_WITHIN.test(t)) within = Math.max(within, pseudoPlace(t, FOCUS_WITHIN));
    }
    sheet._reachOf = rules;
    sheet._reach = { reach: reach, struct: struct, hover: hover, focus: focus, focusWithin: within, has: has, counted: counted, sib: sib, hasKeys: hasKeys, hasSubj: hasSubj, hasAll: hasAll };
    return sheet._reach;
  }
  // Invalidation sets (as Blink's): what a change of one feature of an
  // element (a class, an id, an attribute, a state pseudo-class) can change
  // beyond the element itself, read from the parsed selectors once per
  // style change. A feature in a compound above a selector's subject
  // (`.focused .x`) reaches the descendants that can be the subject (their
  // key: .x), a feature left of + or ~ the following siblings. Each entry
  // keeps its compound without the feature, so only an element that can
  // match it either way (a `tr` for `tr:hover > *`) passes the change on.
  // Without this, a class change on a jsfb row restyled every row after it
  // (Bootstrap's `.btn-check:checked + .btn` matched as "complex") and the
  // pointer moving restyled the page (`.table-hover > tbody > tr:hover > *`).
  //   fx[feature] = { desc: [{ comp, keys }], sib: [{ comp, adj, keys, deep }] }
  // keys: the subjects' keys ('.x', '#y', 'tag', '*'); deep: the siblings'
  // subtrees too (something under them is the subject)
  var fxCache = { gen: -1, fx: null };
  // the pseudo-classes an attribute or a control's state decides
  var STATE_PC = /^(checked|disabled|enabled|default|indeterminate|required|optional|valid|invalid|user-valid|user-invalid|in-range|out-of-range|read-only|read-write|placeholder-shown|autofill|link|any-link|local-link|visited|target|open|closed|popover-open|modal|lang|dir|defined|blank|fullscreen|playing|paused|muted)$/;
  function featuresOf(c, out, nested) {
    for (var i = 0; i < c.length; i++) {
      var s = c[i], f = null;
      if (s.t === 'class') f = 'c:' + s.v;
      else if (s.t === 'id') f = 'i:' + s.v;
      else if (s.t === 'attr') f = 'a:' + s.n;
      else if (s.t === 'pseudo') {
        if (s.list) { for (var j = 0; j < s.list.length; j++) for (var k = 0; k < s.list[j].parts.length; k++) featuresOf(s.list[j].parts[k].c, out, true); continue; }
        f = 'p:' + s.n;
      }
      if (f) out.push({ f: f, s: nested ? null : s });
    }
  }
  function featureIndex() {
    if (fxCache.gen === sheetGen) return fxCache.fx;
    var fx = {}, sibs = [], styleRead = false;
    var sheets = [ua()].concat(cascadeSheets(doc));
    function entry(f) { return fx[f] || (fx[f] = { desc: [], sib: [] }); }
    for (var i = 0; i < sheets.length; i++) {
      var rules = sheets[i]._rules || [];
      for (var j = 0; j < rules.length; j++) {
        var sel = rules[j].sel;
        if (!sel || !sel.parts) continue;
        var parts = sel.parts, key = sel.key;
        // (a selector that reads the style attribute, anywhere in it: an
        // inline style change can then change what matches)
        if (!styleRead) for (var ks = 0; ks < parts.length && !styleRead; ks++) { var fst = []; featuresOf(parts[ks].c, fst, false); for (var ns = 0; ns < fst.length; ns++) if (fst[ns].f === 'a:style') styleRead = true; }
        // every compound left of a + or ~, loose (its pseudo-classes left
        // out): an element put in or taken out that can match one changes
        // what the following siblings that fit the subject's key match
        for (var k0 = 1; k0 < parts.length; k0++) {
          var cb = parts[k0 - 1].comb;
          if (cb !== '+' && cb !== '~') continue;
          var rest0 = '';
          for (var q0 = k0 - 2; q0 >= 0; q0--) rest0 += parts[q0].comb;
          sibs.push({ comp: parts[k0].c.filter(function (x) { return x.t !== 'pseudo'; }), keys: rest0 ? '*' : key, deep: /[ >]/.test(rest0) });
        }
        for (var k = 1; k < parts.length; k++) {
          var feats = [];
          featuresOf(parts[k].c, feats, false);
          if (!feats.length) continue;
          // how compound k reaches the subject: the combinator right of it
          // first (parts[k - 1].comb), then the rest
          var first = parts[k - 1].comb, rest = '';
          for (var q = k - 2; q >= 0; q--) rest += parts[q].comb;
          for (var n = 0; n < feats.length; n++) {
            var ft = feats[n], comp = ft.s ? parts[k].c.filter(function (x) { return x !== ft.s; }) : null;
            var e = entry(ft.f);
            if (first === '+' || first === '~') {
              var deep = /[ >]/.test(rest);
              e.sib.push({ comp: comp, adj: first === '+' && !rest, keys: rest ? '*' : key, deep: deep });
            } else {
              // (`.a .b + .c`: the subject is a descendant's sibling, so a
              // descendant: any of them)
              e.desc.push({ comp: comp, keys: /[+~]/.test(rest) ? '*' : key });
            }
          }
        }
      }
    }
    fxCache = { gen: sheetGen, fx: fx, sibs: sibs, styleRead: styleRead };
    return fx;
  }
  // an attribute's value by its stored name (class, id, style: the same in
  // every namespace), without getAttribute's normalising
  // el's classes as a set, split again only when the attribute changed
  function classSet(el) {
    var v = attrOf(el, 'class');
    if (el._clsV !== v || !el._clsSet) {
      var set = Object.create(null);
      if (v) { var l = v.split(/[ \t\n\f\r]+/); for (var i = 0; i < l.length; i++) if (l[i]) set[l[i]] = true; }
      el._clsV = v;
      el._clsSet = set;
    }
    return el._clsSet;
  }
  function attrOf(el, n) {
    var a = el._attrs;
    for (var i = 0; i < a.length; i++) if (a[i].name === n) return a[i]._v;
    return null;
  }
  function keyFits(el, key) {
    if (key === '*') return true;
    var c0 = key.charAt(0);
    if (c0 === '.') return hasClass(el, key.slice(1));
    if (c0 === '#') return attrOf(el, 'id') === key.slice(1);
    return el.localName === key || String(el.localName).toLowerCase() === key;
  }
  function hasClass(el, c) { return !!classSet(el)[c]; }
  // the features a change of attribute `name` of el touches (was / now: a
  // class or id's values); name undefined: a control's state (value,
  // checkedness)
  function changedFeatures(name, was, now) {
    var fs = [];
    if (name === 'class') {
      var a = String(was || '').split(/[ \t\n\f\r]+/), b = String(now || '').split(/[ \t\n\f\r]+/);
      for (var i = 0; i < a.length; i++) if (a[i] && b.indexOf(a[i]) < 0) fs.push('c:' + a[i]);
      for (var j = 0; j < b.length; j++) if (b[j] && a.indexOf(b[j]) < 0) fs.push('c:' + b[j]);
    } else if (name === 'id') {
      if (was) fs.push('i:' + was);
      if (now) fs.push('i:' + now);
    }
    if (name !== undefined) fs.push('a:' + String(name).toLowerCase());
    if (name !== 'class' && name !== 'id' && name !== 'style') fs.push('state');
    return fs;
  }
  // el's features `fs` changed (el already styled again): the descendants
  // and following siblings their sets reach are styled again. Returns false
  // when it could not tell (the caller restyles el's subtree whole).
  function invalidateFeatures(el, fs) {
    var fx = featureIndex(), desc = [], sib = [];
    for (var i = 0; i < fs.length; i++) {
      if (fs[i] === 'state') {
        for (var f in fx) if (f.slice(0, 2) === 'p:' && STATE_PC.test(f.slice(2))) { desc = desc.concat(fx[f].desc); sib = sib.concat(fx[f].sib); }
        continue;
      }
      var e = fx[fs[i]];
      if (e) { desc = desc.concat(e.desc); sib = sib.concat(e.sib); }
    }
    var keys = null;
    for (var d = 0; d < desc.length; d++) {
      var it = desc[d];
      if (it.comp && !matchCompound(el, it.comp, null)) continue;
      if (it.keys === '*') { keys = '*'; break; }
      (keys || (keys = [])).indexOf(it.keys) < 0 && keys.push(it.keys);
    }
    if (keys === '*') eachElement(el, dropStyle);
    else if (keys) restyleUnder(el, keys);
    if (sib.length && el.parentNode) {
      var kids = el.parentNode._c, at = indexIn(el);
      for (var s = 0; s < sib.length; s++) {
        var si = sib[s];
        if (si.comp && !matchCompound(el, si.comp, null)) continue;
        for (var k = at + 1; k < kids.length; k++) {
          var x = kids[k];
          if (x.nodeType !== 1) continue;
          if (si.deep) { dropStyle(x); eachElement(x, dropStyle); }
          else if (keyFits(x, si.keys)) restyle(x);
          if (si.adj) break;
        }
      }
    }
    return true;
  }
  // the elements under el that fit one of keys styled again (with what is
  // under each, when its style changed for its children)
  function restyleUnder(el, keys) {
    var map = computedCache.map;
    (function walk(n) {
      for (var i = 0; i < n._c.length; i++) {
        var c = n._c[i];
        if (c.nodeType !== 1) continue;
        var fit = false;
        for (var k = 0; k < keys.length && !fit; k++) fit = keyFits(c, keys[k]);
        if (fit) {
          var kept = map[c.__id] ? restyle(c) : (dropStyle(c), eachElement(c, dropStyle), false);
          // (what is between el and c renders again: its kept render holds c's)
          for (var p = c.parentNode; p && p !== el; p = p.parentNode) p._rj = null;
          // (one that fits under c: when c's change left what is under it)
          if (kept) walk(c);
          continue;
        }
        walk(c);
      }
    })(el);
  }
  // n scrolled: a new offset of what it shows, no style or box changes,
  // so only n and its ancestors render again (the rest of the page, its
  // canvases' drawings too, comes from the last render) and the host moves
  // what was laid out
  function scrolled(n) {
    generation++;
    scrollBumps++;
    textStamp++;
    if (shadowCount) { stampUp(n); return; }
    for (; n; n = n.parentNode) n._rv = textStamp;
    if (virts.length) virtCheck(false);
  }
  // a text changed under n: n and its ancestors render again
  function textChanged(n) {
    // a style sheet's text is its rules
    if (n && n.localName === 'style') { if (n.isConnected) styleSheetChanged(n, n._sheet); else changed(); return; }
    generation++;
    textStamp++;
    if (shadowCount) { stampUp(n); return; }
    for (; n; n = n.parentNode) n._rv = textStamp;
  }
  function emptyEl(n) {
    for (var e = 0; e < n._c.length; e++) { var c = n._c[e]; if (c.nodeType === 1 || ((c.nodeType === 3 || c.nodeType === 4) && c._data.length)) return false; }
    return true;
  }
  function isText(c) { return c.nodeType === 3 || c.nodeType === 4 || c.nodeType === 8; }

  // ---- DOMException --------------------------------------------------------

  function DOMException(message, name) {
    var e = new Error(message);
    Object.setPrototypeOf(e, DOMException.prototype);
    e.name = name || 'Error';
    return e;
  }
  DOMException.prototype = Object.create(Error.prototype);
  DOMException.prototype.constructor = DOMException;

  // ---- events --------------------------------------------------------------

  class Event {
    constructor(type, init) {
      init = init || {};
      this.type = String(type);
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.composed = !!init.composed;
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
      this.srcElement = null;
      this.eventPhase = 0;
      this.isTrusted = !!init._host;
      this.timeStamp = now();
      this._stop = false;
      this._stopNow = false;
      this._path = [];
    }
    preventDefault() { if (this.cancelable && !this._passive) this.defaultPrevented = true; }
    stopPropagation() { this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
    composedPath() { return this._path.slice(); }
    get returnValue() { return !this.defaultPrevented; }
    set returnValue(v) { if (!v) this.preventDefault(); }
    get cancelBubble() { return this._stop; }
    set cancelBubble(v) { if (v) this._stop = true; }
    initEvent(type, bubbles, cancelable) { this.type = String(type); this.bubbles = !!bubbles; this.cancelable = !!cancelable; }
  }
  Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;

  class CustomEvent extends Event {
    constructor(type, init) { super(type, init); this.detail = init && init.detail !== undefined ? init.detail : null; }
  }
  class UIEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.view = init.view || null; this.detail = init.detail || 0; }
  }
  class FocusEvent extends UIEvent {
    constructor(type, init) { super(type, init); this.relatedTarget = (init && init.relatedTarget) || null; }
  }
  class MouseEvent extends UIEvent {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.clientX = init.clientX || 0; this.clientY = init.clientY || 0;
      this.screenX = init.screenX || this.clientX; this.screenY = init.screenY || this.clientY;
      this.pageX = this.clientX; this.pageY = this.clientY;
      this.offsetX = init.offsetX || 0; this.offsetY = init.offsetY || 0;
      this.button = init.button || 0; this.buttons = init.buttons || 0;
      this.ctrlKey = !!init.ctrlKey; this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey;
      this.relatedTarget = init.relatedTarget || null;
      this.movementX = 0; this.movementY = 0;
    }
    getModifierState(k) { return (k === 'Shift' && this.shiftKey) || (k === 'Control' && this.ctrlKey) || (k === 'Alt' && this.altKey) || (k === 'Meta' && this.metaKey); }
    get x() { return this.clientX; }
    get y() { return this.clientY; }
    get layerX() { return this.pageX; }
    get layerY() { return this.pageY; }
    get which() { return this.button + 1; }
    initMouseEvent(type, bubbles, cancelable, view, detail, sx, sy, cx, cy, ctrl, alt, shift, meta, button, related) {
      this.initEvent(type, bubbles, cancelable); this.view = view || null; this.detail = detail || 0;
      this.screenX = sx || 0; this.screenY = sy || 0; this.clientX = this.pageX = cx || 0; this.clientY = this.pageY = cy || 0;
      this.ctrlKey = !!ctrl; this.altKey = !!alt; this.shiftKey = !!shift; this.metaKey = !!meta; this.button = button || 0; this.relatedTarget = related || null;
    }
  }
  class PointerEvent extends MouseEvent {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.pointerId = init.pointerId || 1; this.pointerType = init.pointerType || 'mouse';
      this.isPrimary = init.isPrimary !== undefined ? !!init.isPrimary : true;
      this.width = init.width || 1; this.height = init.height || 1; this.pressure = init.pressure || 0;
      this.tangentialPressure = init.tangentialPressure || 0; this.tiltX = init.tiltX || 0; this.tiltY = init.tiltY || 0; this.twist = init.twist || 0;
      this.altitudeAngle = init.altitudeAngle !== undefined ? init.altitudeAngle : Math.PI / 2; this.azimuthAngle = init.azimuthAngle || 0;
      this._coalesced = init.coalescedEvents || null; this._predicted = init.predictedEvents || null;
    }
    // (a page's own event has none; one from the host is its own only one)
    getCoalescedEvents() { return this._coalesced ? this._coalesced.slice() : this.isTrusted && (this.type === 'pointermove' || this.type === 'pointerrawupdate') ? [this] : []; }
    getPredictedEvents() { return this._predicted ? this._predicted.slice() : []; }
  }
  class WheelEvent extends MouseEvent {
    constructor(type, init) { super(type, init); init = init || {}; this.deltaX = init.deltaX || 0; this.deltaY = init.deltaY || 0; this.deltaZ = 0; this.deltaMode = init.deltaMode || 0; }
  }
  class KeyboardEvent extends UIEvent {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.key = init.key || ''; this.code = init.code || '';
      this.ctrlKey = !!init.ctrlKey; this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey;
      this.repeat = !!init.repeat; this.isComposing = !!init.isComposing; this.location = 0;
      this.keyCode = init.keyCode || keyCodeOf(this.key); this.which = this.keyCode;
      this.charCode = type === 'keypress' && this.key.length === 1 ? this.key.charCodeAt(0) : 0;
    }
    getModifierState(k) { return MouseEvent.prototype.getModifierState.call(this, k); }
  }
  class InputEvent extends UIEvent {
    constructor(type, init) { super(type, init); init = init || {}; this.data = init.data === undefined ? null : init.data; this.inputType = init.inputType || ''; this.isComposing = false; }
  }
  class CompositionEvent extends UIEvent {
    constructor(type, init) { super(type, init); this.data = (init && init.data) || ''; }
  }
  class MessageEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.data = init.data; this.origin = init.origin || ''; this.source = init.source || null; this.ports = init.ports || []; }
  }
  class ProgressEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.loaded = init.loaded || 0; this.total = init.total || 0; this.lengthComputable = !!init.lengthComputable; }
  }
  class ErrorEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.message = init.message || ''; this.error = init.error || null; }
  }
  class AnimationEvent extends Event {}
  class TransitionEvent extends Event {}
  class PopStateEvent extends Event {
    constructor(type, init) { super(type, init); this.state = init && init.state !== undefined ? init.state : null; this.hasUAVisualTransition = false; }
  }
  class HashChangeEvent extends Event {
    constructor(type, init) { super(type, init); init = init || {}; this.oldURL = init.oldURL || ''; this.newURL = init.newURL || ''; }
  }
  class PageTransitionEvent extends Event {
    constructor(type, init) { super(type, init); this.persisted = !!(init && init.persisted); }
  }
  class StorageEvent extends Event {
    constructor(type, init) {
      super(type, init); init = init || {};
      this.key = init.key === undefined ? null : init.key; this.oldValue = init.oldValue === undefined ? null : init.oldValue;
      this.newValue = init.newValue === undefined ? null : init.newValue; this.url = init.url || ''; this.storageArea = init.storageArea || null;
    }
  }
  class Touch {
    constructor(init) {
      init = init || {};
      this.identifier = init.identifier || 0; this.target = init.target || null;
      this.clientX = init.clientX || 0; this.clientY = init.clientY || 0; this.screenX = init.screenX || 0; this.screenY = init.screenY || 0;
      this.pageX = init.pageX || this.clientX; this.pageY = init.pageY || this.clientY;
      this.radiusX = init.radiusX || 0; this.radiusY = init.radiusY || 0; this.rotationAngle = init.rotationAngle || 0; this.force = init.force || 0;
    }
  }
  class TouchEvent extends UIEvent {
    constructor(type, init) {
      super(type, init); init = init || {};
      this.touches = init.touches || []; this.targetTouches = init.targetTouches || []; this.changedTouches = init.changedTouches || [];
      this.ctrlKey = !!init.ctrlKey; this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey;
    }
  }
  class ClipboardEvent extends Event {
    constructor(type, init) { super(type, init); this.clipboardData = (init && init.clipboardData) || null; }
  }
  class DragEvent extends MouseEvent {
    constructor(type, init) { super(type, init); this.dataTransfer = (init && init.dataTransfer) || null; }
  }

  var KEY_CODES = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
    // a printable key's keyCode is its key's on a US keyboard, not the
    // character's code ("'" is 222; 39 would be ArrowRight)
    ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, '_': 189, '.': 190, '>': 190, '/': 191, '?': 191, '`': 192, '~': 192,
    '[': 219, '{': 219, '\\': 220, '|': 220, ']': 221, '}': 221, "'": 222, '"': 222,
    '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48 };
  function keyCodeOf(k) {
    if (KEY_CODES[k] !== undefined) return KEY_CODES[k];
    if (k.length === 1 && /[a-z0-9]/i.test(k)) return k.toUpperCase().charCodeAt(0);
    return 0;
  }

  class EventTarget {
    constructor() { this._ls = null; }
    addEventListener(type, fn, opts) {
      if (!fn) return;
      var capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      var once = !!(opts && typeof opts === 'object' && opts.once);
      var passive = !!(opts && typeof opts === 'object' && opts.passive);
      var signal = opts && typeof opts === 'object' ? opts.signal : null;
      if (signal && signal.aborted) return;
      if (!this._ls) this._ls = {};
      var list = this._ls[type] || (this._ls[type] = []);
      for (var i = 0; i < list.length; i++) if (list[i].fn === fn && list[i].capture === capture) return;
      var l = { fn: fn, capture: capture, once: once, passive: passive, removed: false };
      list.push(l);
      if (signal) { var self = this; signal.addEventListener('abort', function () { self.removeEventListener(type, fn, capture); }); }
    }
    removeEventListener(type, fn, opts) {
      if (!this._ls || !this._ls[type]) return;
      var capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      var list = this._ls[type];
      for (var i = 0; i < list.length; i++) {
        if (list[i].fn === fn && list[i].capture === capture) { list[i].removed = true; list.splice(i, 1); return; }
      }
    }
    dispatchEvent(ev) {
      if (!(ev instanceof Event)) throw new TypeError("Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'.");
      return dispatch(this, ev);
    }
  }

  function parentForEvent(t) {
    if (t instanceof Node) {
      if (t.parentNode) return t.parentNode;
      if (t.nodeType === 9) return G;
      return null;
    }
    return null;
  }

  function invoke(t, ev, phase) {
    if (!t._ls) return;
    var list = t._ls[ev.type];
    if (!list || !list.length) return;
    list = list.slice();
    ev.currentTarget = t;
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (l.removed) continue;
      if (phase === 1 && !l.capture) continue;
      if (phase === 3 && l.capture) continue;
      if (l.once) t.removeEventListener(ev.type, l.fn, l.capture);
      ev._passive = l.passive;
      try {
        if (typeof l.fn === 'function') l.fn.call(t, ev);
        else if (l.fn && typeof l.fn.handleEvent === 'function') l.fn.handleEvent(ev);
      } catch (e) {
        reportError(e);
      }
      ev._passive = false;
      if (ev._stopNow) return;
    }
  }

  function invokeHandler(t, ev) {
    // an onclick property or attribute
    var h = t['on' + ev.type];
    if (typeof h === 'function') {
      ev.currentTarget = t;
      try {
        var r = h.call(t, ev);
        if (r === false) ev.preventDefault();
      } catch (e) { reportError(e); }
    }
  }

  // the target as a listener at t sees it: a node in a shadow tree t is
  // not in shows as that tree's host (DOM 4.2.2 retarget)
  function retarget(a, t) {
    for (;;) {
      var r = a instanceof Node ? shadowRootOf(a) : null;
      if (!r) return a;
      if (t instanceof Node) { for (var q = t; q; q = q.nodeType === 11 && q.host ? q.host : q.parentNode) if (q === r) return a; }
      a = r.host;
    }
  }
  var scrollQueue = [];
  // the elements scrolled away from their start, for the layout to bring
  // back into range when their content shrinks (a grid filtered from 2 000
  // rows to 250 while scrolled to row 1 000: the browser clamps scrollTop
  // to the new end and sends a scroll event, and the grid draws the rows
  // there)
  var scrollers = [];
  function keptScroll(el) { if (!el._scl && (el._sTop || el._sLeft)) { el._scl = true; scrollers.push(el); } }
  function clampScrolls() {
    var keep = [];
    for (var i = 0; i < scrollers.length; i++) {
      var e = scrollers[i];
      if (!e.isConnected || (!e._sTop && !e._sLeft)) { e._scl = false; continue; }
      keep.push(e);
      // (the page's own scroll: within the page's height, as a browser
      // keeps it)
      if (e === (doc && doc.documentElement)) {
        var rmt = Math.max(0, Math.round(pageHeight()) - viewport.h), rml = Math.max(0, pageWidth() - viewport.w);
        if (e._sTop > rmt || e._sLeft > rml) { e._sTop = Math.min(e._sTop, rmt); e._sLeft = Math.min(e._sLeft, rml); scriptScrolled(e); }
        continue;
      }
      if (!boxes[e.__id]) continue;
      if (clampScroll(e)) scriptScrolled(e);
    }
    scrollers = keep;
  }
  // e's offsets brought into its range as the boxes have it: true when
  // one moved
  function clampScroll(e) {
    var mt = Math.max(0, sizeNow(e, 'sh') - sizeNow(e, 'ch')), ml = Math.max(0, sizeNow(e, 'sw') - sizeNow(e, 'cw')), moved = false;
    if (e._sTop > mt) { e._sTop = mt; moved = true; }
    if (e._sLeft > ml) { e._sLeft = ml; moved = true; }
    return moved;
  }
  // When only scroll offsets moved since the layout (scrollBumps: the
  // changes that were scrolls) the boxes' sizes stand, and so do the scroll
  // ranges: a size or a scroll offset read then needs no layout, a position
  // does (a sticky box moves). AG Grid reads scrollLeft, scrollTop and
  // offsetHeight in its scroll handlers, which laid the page out twice per
  // wheel turn for nothing.
  var scrollBumps = 0, layoutSb = 0;
  function sizesStand() { return layoutGen !== generation && generation - layoutGen === scrollBumps - layoutSb; }
  // a scroll offset read: the layout first when the page changed, as for a
  // size, since the range may have (clampScrolls)
  function scrollRead(e) {
    if (!syncLayout) return;
    if (sizesStand() && boxes[e.__id] && e !== (doc && doc.documentElement)) {
      if (clampScroll(e)) scriptScrolled(e);
      return;
    }
    reflow();
  }
  function scriptScrolled(el) {
    if (el._sq) return;
    el._sq = true;
    scrollQueue.push(el);
    if (scrollQueue.length === 1) setTimeout(function () {
      var q = scrollQueue; scrollQueue = [];
      for (var i = 0; i < q.length; i++) {
        var e = q[i];
        if (!e._sq) continue;
        e._sq = false;
        if (!e.isConnected) continue;
        scrolled(e);
        dispatch(e === (doc && doc.documentElement) ? doc : e, new Event('scroll', { bubbles: e === (doc && doc.documentElement) }));
      }
    }, 0);
  }
  function dispatch(target, ev) {
    // (the host's own scroll sends its event now: none more at the frame)
    if (ev && ev.type === 'scroll') { if (target._sq) target._sq = false; else if (target === doc && doc.documentElement) doc.documentElement._sq = false; }
    var path = [];
    for (var t = target; t; ) {
      path.push(t);
      if (shadowCount && t.nodeType === 11 && t.host) { if (!ev.composed) break; t = t.host; continue; }
      var asl = shadowCount && t.parentNode && t.parentNode._sr ? assignedSlotOf(t) : null;
      t = asl || parentForEvent(t);
    }
    if (shadowCount && path.length > 1) { ev._orig = target; dispatchShadow(target, ev, path); return !ev.defaultPrevented; }
    ev.target = target;
    ev.srcElement = target;
    ev._path = path;
    ev._stop = false;
    ev._stopNow = false;
    var prevEvent = G.event;
    G.event = ev;
    for (var i = path.length - 1; i > 0 && !ev._stop; i--) {
      ev.eventPhase = 1;
      invoke(path[i], ev, 1);
    }
    if (!ev._stop) {
      ev.eventPhase = 2;
      invoke(target, ev, 2);
      if (!ev._stopNow) invokeHandler(target, ev);
    }
    if (ev.bubbles) {
      for (var j = 1; j < path.length && !ev._stop; j++) {
        ev.eventPhase = 3;
        invoke(path[j], ev, 3);
        if (!ev._stopNow) invokeHandler(path[j], ev);
      }
    }
    ev.eventPhase = 0;
    ev.currentTarget = null;
    G.event = prevEvent;
    return !ev.defaultPrevented;
  }

  // dispatch along a path through shadow trees: each listener sees the
  // target retargeted for it
  function dispatchShadow(target, ev, path) {
    ev.srcElement = target;
    ev._path = path;
    ev._stop = false;
    ev._stopNow = false;
    var prevEvent = G.event;
    G.event = ev;
    for (var i = path.length - 1; i > 0 && !ev._stop; i--) {
      ev.target = retarget(target, path[i]);
      ev.eventPhase = ev.target === path[i] ? 2 : 1;
      invoke(path[i], ev, 1);
    }
    if (!ev._stop) {
      ev.target = target;
      ev.eventPhase = 2;
      invoke(target, ev, 2);
      if (!ev._stopNow) invokeHandler(target, ev);
    }
    for (var j = 1; j < path.length && !ev._stop; j++) {
      ev.target = retarget(target, path[j]);
      // (a host is its tree's event at target: non-bubbling ones too)
      if (ev.target === path[j]) { ev.eventPhase = 2; invoke(path[j], ev, 3); if (!ev._stopNow) invokeHandler(path[j], ev); continue; }
      if (!ev.bubbles) continue;
      ev.eventPhase = 3;
      invoke(path[j], ev, 3);
      if (!ev._stopNow) invokeHandler(path[j], ev);
    }
    ev.target = retarget(target, doc);
    ev.eventPhase = 0;
    ev.currentTarget = null;
    G.event = prevEvent;
  }

  function reportError(e) {
    if (typeof __error === 'function') __error('event listener', e);
    try { var ev = new ErrorEvent('error', { message: String((e && e.message) || e), error: e }); invoke(G, ev, 2); } catch (x) {}
  }

  // ---- nodes ---------------------------------------------------------------

  function NodeList(arr) {
    var l = arr || [];
    l.item = function (i) { return this[i] === undefined ? null : this[i]; };
    return l;
  }

  class Node extends EventTarget {
    constructor() {
      super();
      this.__id = nextNodeId++;
      this.parentNode = null;
      this._c = NodeList([]);
      this.ownerDocument = doc;
    }
    get childNodes() { return this._c; }
    get firstChild() { return this._c.length ? this._c[0] : null; }
    get lastChild() { return this._c.length ? this._c[this._c.length - 1] : null; }
    get parentElement() { var p = this.parentNode; return p && p.nodeType === 1 ? p : null; }
    get nextSibling() {
      var p = this.parentNode; if (!p) return null;
      var i = indexIn(this); return i >= 0 && i + 1 < p._c.length ? p._c[i + 1] : null;
    }
    get previousSibling() {
      var p = this.parentNode; if (!p) return null;
      var i = indexIn(this); return i > 0 ? p._c[i - 1] : null;
    }
    get isConnected() {
      // (up to the top of the tree: the document, or a shadow root, from
      // whose host it goes on. Asked at every attribute change)
      for (var n = this; n;) {
        var p = n.parentNode;
        if (p) { n = p; continue; }
        var t = n.nodeType;
        if (t === 9) return true;
        if (t !== 11 || !n.host) return false;
        n = n.host;
      }
      return false;
    }
    get assignedSlot() { return shadowCount ? assignedSlotOf(this) : null; }
    get nodeValue() { return null; }
    set nodeValue(v) {}
    get baseURI() { return doc ? doc.URL : ''; }
    hasChildNodes() { return this._c.length > 0; }
    getRootNode(o) { var n = this; for (;;) { while (n.parentNode) n = n.parentNode; if (o && o.composed && n.nodeType === 11 && n.host) n = n.host; else return n; } }
    contains(o) { for (var n = o; n; n = n.parentNode) if (n === this) return true; return false; }
    isSameNode(o) { return o === this; }
    isEqualNode(o) { return !!o && o.nodeType === this.nodeType && serialize(o, true) === serialize(this, true); }
    compareDocumentPosition(o) {
      if (o === this) return 0;
      if (this.contains(o)) return 20;
      if (o.contains(this)) return 10;
      if (this.getRootNode() !== o.getRootNode()) return 1 | 32;
      var a = treeOrder(this), b = treeOrder(o);
      return a < b ? 4 : 2;
    }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, ref) {
      if (!(c instanceof Node)) throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.");
      if (ref && ref.parentNode !== this) throw DOMException("The node before which the new node is to be inserted is not a child of this node.", 'NotFoundError');
      // (a node with no children holds only itself)
      if (c === this || (c._c && c._c.length && c.contains(this))) throw DOMException('The new child element contains the parent.', 'HierarchyRequestError');
      if (c.nodeType === 11) {
        // (the fragment emptied at once: its children taken one at a time
        // from its front made 10 000 rows quadratic, a splice and a new
        // index for each)
        var kids = c._c;
        c._c = [];
        c._cv = (c._cv || 0) + 1;
        for (var k0 = 0; k0 < kids.length; k0++) kids[k0].parentNode = null;
        if (kids.length) { treeChanged(c, null, kids[0], 0); queueMutation(c, 'childList', { addedNodes: [], removedNodes: kids.slice(), previousSibling: null, nextSibling: null }); }
        for (var i = 0; i < kids.length; i++) this.insertBefore(kids[i], ref);
        return c;
      }
      if (c === ref) return c;
      // (a node with no parent is not in the page; once put in, it is where
      // this is: two walks to the root less for each of 80 000 nodes)
      var wasConnected = c.parentNode ? c.isConnected : false, nowConnected = this.isConnected;
      if (c.parentNode) detach(c);
      var at = ref ? indexIn(ref) : this._c.length;
      var wasEmpty = isText(c) ? emptyEl(this) : false;
      this._c.splice(at, 0, c);
      this._cv = (this._cv || 0) + 1;
      if (!ref) c._i = at;
      c.parentNode = this;
      adopt(c, this.ownerDocument || this);
      if (isText(c) && (textEdit || wasEmpty === emptyEl(this))) textChanged(this);
      else treeChanged(this, c);
      queueMutation(this, 'childList', { addedNodes: [c], removedNodes: [], previousSibling: at > 0 ? this._c[at - 1] : null, nextSibling: ref || null });
      if (!wasConnected && nowConnected) connected(c);
      return c;
    }
    removeChild(c) {
      if (!c || c.parentNode !== this) throw DOMException('The node to be removed is not a child of this node.', 'NotFoundError');
      detach(c);
      return c;
    }
    replaceChild(n, old) {
      if (!old || old.parentNode !== this) throw DOMException('The node to be replaced is not a child of this node.', 'NotFoundError');
      var ref = old.nextSibling;
      this.removeChild(old);
      this.insertBefore(n, ref);
      return old;
    }
    cloneNode(deep) {
      var c = cloneOne(this);
      if (deep) for (var i = 0; i < this._c.length; i++) c.appendChild(this._c[i].cloneNode(true));
      return c;
    }
    normalize() {
      for (var i = 0; i < this._c.length; i++) {
        var n = this._c[i];
        if (n.nodeType === 3) {
          while (n.nextSibling && n.nextSibling.nodeType === 3) { n.data += n.nextSibling.data; this.removeChild(n.nextSibling); }
          if (!n.data) { this.removeChild(n); i--; }
        } else n.normalize();
      }
    }
    get textContent() {
      var out = '';
      (function walk(n) {
        for (var i = 0; i < n._c.length; i++) {
          var k = n._c[i];
          if (k.nodeType === 3 || k.nodeType === 4) out += k.data;
          else if (k.nodeType === 1 || k.nodeType === 11) walk(k);
        }
      })(this);
      return out;
    }
    set textContent(v) {
      // a style sheet given the text it has (PrimeReact's useStyle, at
      // every render of every component): the rules stay, and so does every
      // style of the page
      if (this.localName === 'style' && this._c.length === 1 && this._c[0].nodeType === 3 && this._c[0]._data === (v === null || v === undefined ? '' : String(v))) return;
      // only texts replaced by a text: the styles stay (styleGen)
      var styled = false;
      for (var i = 0; i < this._c.length; i++) if (!isText(this._c[i])) styled = true;
      var wasEmpty = emptyEl(this);
      textEdit++;
      try {
        removeAll(this);
        v = v === null || v === undefined ? '' : String(v);
        if (v) this.appendChild(this.ownerDocument.createTextNode(v));
      } finally {
        textEdit--;
      }
      // the elements under it went or it is :empty now: it and its siblings
      // are styled again (treeChanged), not the page
      if (styled || wasEmpty !== emptyEl(this)) treeChanged(this, null);
    }
    lookupNamespaceURI() { return null; }
  }
  Node.ELEMENT_NODE = 1; Node.ATTRIBUTE_NODE = 2; Node.TEXT_NODE = 3; Node.CDATA_SECTION_NODE = 4;
  Node.PROCESSING_INSTRUCTION_NODE = 7; Node.COMMENT_NODE = 8; Node.DOCUMENT_NODE = 9;
  Node.DOCUMENT_TYPE_NODE = 10; Node.DOCUMENT_FRAGMENT_NODE = 11;
  Node.DOCUMENT_POSITION_DISCONNECTED = 1; Node.DOCUMENT_POSITION_PRECEDING = 2; Node.DOCUMENT_POSITION_FOLLOWING = 4;
  Node.DOCUMENT_POSITION_CONTAINS = 8; Node.DOCUMENT_POSITION_CONTAINED_BY = 16; Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32;
  for (var nk in { ELEMENT_NODE: 1, TEXT_NODE: 1, COMMENT_NODE: 1, DOCUMENT_NODE: 1, DOCUMENT_FRAGMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 1, DOCUMENT_POSITION_PRECEDING: 1, DOCUMENT_POSITION_CONTAINED_BY: 1, DOCUMENT_POSITION_CONTAINS: 1 }) Node.prototype[nk] = Node[nk];

  function treeOrder(n) {
    // a sortable key: the indexes from the root
    var key = [];
    for (; n.parentNode; n = n.parentNode) key.unshift(n.parentNode._c.indexOf(n));
    var s = '';
    for (var i = 0; i < key.length; i++) s += String(100000 + key[i]);
    return s;
  }

  function adopt(n, d) {
    if (d && d.nodeType !== 9) d = d.ownerDocument;
    if (!d || n.ownerDocument === d) return;
    n.ownerDocument = d;
    for (var i = 0; i < n._c.length; i++) adopt(n._c[i], d);
  }

  function detach(c) {
    var p = c.parentNode;
    var i = indexIn(c);
    var wasConnected = c.isConnected;
    if (wasConnected && doc && doc._active && c.contains(doc._active)) doc._active = null;
    var wasEmpty = isText(c) ? emptyEl(p) : false;
    p._c.splice(i, 1);
    p._cv = (p._cv || 0) + 1;
    c.parentNode = null;
    if (isText(c) && (textEdit || wasEmpty === emptyEl(p))) textChanged(p);
    else treeChanged(p, null, c, i);
    queueMutation(p, 'childList', { addedNodes: [], removedNodes: [c], previousSibling: i > 0 ? p._c[i - 1] : null, nextSibling: p._c[i] || null });
    if (wasConnected) disconnected(c);
  }

  function removeAll(n) {
    while (n._c.length) detach(n._c[n._c.length - 1]);
  }

  function connected(n) {
    if (n.nodeType === 1) {
      if (n._connected) n._connected();
      for (var i = 0; i < n._c.length; i++) connected(n._c[i]);
    }
  }
  // the elements taken out of the page since the last render: the render
  // tells the host ("gone"), which lets go of what it kept for them then
  // (10 000 rows cleared: 0.7 GB held as long as the page lived)
  var goneEls = 0;
  function disconnected(n) {
    if (n.nodeType === 1) {
      goneEls++;
      if (n._disconnected) n._disconnected();
      for (var i = 0; i < n._c.length; i++) disconnected(n._c[i]);
    }
  }

  function cloneOne(n) {
    var d = n.ownerDocument || doc;
    if (n.nodeType === 3) return d.createTextNode(n.data);
    if (n.nodeType === 8) return d.createComment(n.data);
    if (n.nodeType === 11) return d.createDocumentFragment();
    if (n.nodeType === 1) {
      var e = d.createElementNS(n.namespaceURI, n._qname);
      for (var i = 0; i < n._attrs.length; i++) e.setAttribute(n._attrs[i].name, n._attrs[i].value);
      if (n._value !== undefined) e._value = n._value;
      if (n._checked !== undefined) e._checked = n._checked;
      // a clone of a script that ran does not run (HTML's "already started")
      if (n._started && n.localName === 'script') e._started = true;
      return e;
    }
    if (n.nodeType === 9) return new Document();
    throw DOMException('cannot clone', 'NotSupportedError');
  }

  class CharacterData extends Node {
    constructor(data) { super(); this._data = String(data); }
    get data() { return this._data; }
    set data(v) {
      var old = this._data;
      var p = this.parentNode;
      var wasEmpty = p ? emptyEl(p) : false;
      this._data = v === null || v === undefined ? '' : String(v);
      if (!p || textEdit || wasEmpty === emptyEl(p)) textChanged(p);
      else changed();
      queueMutation(this, 'characterData', { oldValue: old });
    }
    get nodeValue() { return this._data; }
    set nodeValue(v) { this.data = v; }
    get textContent() { return this._data; }
    set textContent(v) { this.data = v; }
    get length() { return this._data.length; }
    appendData(s) { this.data = this._data + s; }
    substringData(o, n) { return this._data.substr(o, n); }
    insertData(o, s) { this.data = this._data.slice(0, o) + s + this._data.slice(o); }
    deleteData(o, n) { this.data = this._data.slice(0, o) + this._data.slice(o + n); }
    replaceData(o, n, s) { this.data = this._data.slice(0, o) + s + this._data.slice(o + n); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    before() { insertNodes(this.parentNode, this, arguments, this.ownerDocument); }
    after() { insertNodes(this.parentNode, this.nextSibling, arguments, this.ownerDocument); }
    replaceWith() { var p = this.parentNode; if (!p) return; var next = this.nextSibling; p.removeChild(this); insertNodes(p, next, arguments, this.ownerDocument); }
    get nextElementSibling() { return siblingElement(this, 1); }
    get previousElementSibling() { return siblingElement(this, -1); }
  }

  class Text extends CharacterData {
    get nodeType() { return 3; }
    get nodeName() { return '#text'; }
    get wholeText() { return this._data; }
    splitText(o) {
      var rest = this.ownerDocument.createTextNode(this._data.slice(o));
      this.data = this._data.slice(0, o);
      if (this.parentNode) this.parentNode.insertBefore(rest, this.nextSibling);
      return rest;
    }
  }
  class CDATASection extends Text {
    get nodeType() { return 4; }
    get nodeName() { return '#cdata-section'; }
  }
  class Comment extends CharacterData {
    get nodeType() { return 8; }
    get nodeName() { return '#comment'; }
  }
  class ProcessingInstruction extends CharacterData {
    get nodeType() { return 7; }
  }

  function siblingElement(n, dir) {
    var p = n.parentNode; if (!p) return null;
    for (var i = indexIn(n) + dir; i >= 0 && i < p._c.length; i += dir) if (p._c[i].nodeType === 1) return p._c[i];
    return null;
  }
  // n's index in its parent's child list: the one it was found at last
  // when it is still there (a removal from the end, an append keep it),
  // else every child's found again at once. A framework walks the children
  // by nextSibling: an indexOf for each step made that quadratic.
  function indexIn(n) {
    var p = n.parentNode, k = p._c;
    if (k[n._i] === n) return n._i;
    // (the last one: a loop appending 10 000 rows numbered them all at
    // each row)
    if (k[k.length - 1] === n) return (n._i = k.length - 1);
    for (var i = 0; i < k.length; i++) k[i]._i = i;
    return k[n._i] === n ? n._i : -1;
  }
  // the positions :nth-child() and the others count, of every element
  // child of p at once, kept until p's children change (_cv): _posE its place
  // among the elements, _posT among those of its type, _posEE and _posTE from the end
  function kidPositions(p) {
    if (p._kv === (p._cv || 0) && p._kv !== undefined) return;
    var k = p._c, e = 0, types = {};
    for (var i = 0; i < k.length; i++) {
      var n = k[i];
      n._i = i;
      if (n.nodeType !== 1) continue;
      n._posE = ++e;
      n._posT = types[n.localName] = (types[n.localName] || 0) + 1;
    }
    for (var j = 0; j < k.length; j++) {
      var m = k[j];
      if (m.nodeType !== 1) continue;
      m._posEE = e - m._posE + 1;
      m._posTE = types[m.localName] - m._posT + 1;
    }
    p._kv = p._cv || 0;
  }

  function insertNodes(parent, ref, args, d) {
    if (!parent) return;
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      parent.insertBefore(a instanceof Node ? a : d.createTextNode(String(a)), ref);
    }
  }

  // ParentNode
  var ParentNode = {
    get children() { return NodeList(this._c.filter(function (n) { return n.nodeType === 1; })); },
    get childElementCount() { var k = 0; for (var i = 0; i < this._c.length; i++) if (this._c[i].nodeType === 1) k++; return k; },
    get firstElementChild() { for (var i = 0; i < this._c.length; i++) if (this._c[i].nodeType === 1) return this._c[i]; return null; },
    get lastElementChild() { for (var i = this._c.length - 1; i >= 0; i--) if (this._c[i].nodeType === 1) return this._c[i]; return null; },
    append: function () { insertNodes(this, null, arguments, this.ownerDocument || this); },
    prepend: function () { insertNodes(this, this.firstChild, arguments, this.ownerDocument || this); },
    replaceChildren: function () { removeAll(this); insertNodes(this, null, arguments, this.ownerDocument || this); },
    querySelector: function (s) { return querySelectorAll(this, s, true)[0] || null; },
    querySelectorAll: function (s) { return NodeList(querySelectorAll(this, s, false)); },
    getElementsByTagName: function (t) {
      var root = this, all = t === '*', want = String(t).toLowerCase();
      return liveCollection(function () {
        var out = [];
        eachElement(root, function (e) { if (all || e.localName === want || e._qname === t) out.push(e); });
        return out;
      });
    },
    getElementsByClassName: function (c) {
      var root = this, want = String(c).split(/\s+/).filter(Boolean);
      return liveCollection(function () {
        var out = [];
        if (!want.length) return out;
        eachElement(root, function (e) {
          var have = (e.getAttribute('class') || '').split(/\s+/);
          for (var i = 0; i < want.length; i++) if (have.indexOf(want[i]) < 0) return;
          out.push(e);
        });
        return out;
      });
    }
  };
  // an HTMLCollection: the elements list() finds, found again after any
  // change to the tree (generation)
  function liveCollection(list) {
    var cache = null, at = 0;
    function now() {
      if (!cache || at !== generation) { cache = NodeList(list()); at = generation; }
      return cache;
    }
    return new Proxy([], {
      get: function (t, k) {
        var l = now();
        if (k === 'namedItem') return function (n) { for (var i = 0; i < l.length; i++) if (l[i].id === n || l[i].getAttribute('name') === n) return l[i]; return null; };
        var v = l[k];
        return typeof v === 'function' ? v.bind(l) : v;
      },
      has: function (t, k) { return k in now(); }
    });
  }
  function mixin(cls, obj) {
    var names = Object.getOwnPropertyNames(obj);
    for (var i = 0; i < names.length; i++) Object.defineProperty(cls.prototype, names[i], Object.getOwnPropertyDescriptor(obj, names[i]));
  }

  function eachElement(root, fn) {
    var stack = [];
    for (var i = root._c.length - 1; i >= 0; i--) stack.push(root._c[i]);
    while (stack.length) {
      var n = stack.pop();
      // (an element: only they have _attrs; nodeType is a getter)
      if (n._attrs === undefined) continue;
      if (fn(n) === true) return;
      for (var j = n._c.length - 1; j >= 0; j--) stack.push(n._c[j]);
    }
  }

  // ---- Shadow DOM: the flat tree (DOM 4.2.2, CSS Scoping 2) -------------
  // A host renders its shadow tree in place of its children; a <slot> in
  // it renders the host's children assigned to it (by their slot
  // attribute; the first slot of a name takes them), else its own. Styles
  // inherit along this tree, events pass from a shadow tree to its host,
  // the shadow root's sheets style only its tree (and :host, ::slotted()).
  // shadowCount: no shadow root anywhere, none of this is looked at.
  var shadowCount = 0, shadowRoots = [];
  function shadowRootOf(n) {
    for (var q = n; q; q = q.parentNode) if (q.nodeType === 11 && q.host) return q;
    return null;
  }
  // n in a shadow tree, a host's child or a host: its style is not the
  // page's selectors' business alone (changed() restyles the page)
  function inShadowScope(n) {
    if (!shadowCount || !n) return false;
    if (n._sr) return true;
    var p = n.parentNode;
    if (p && p._sr) return true;
    return !!shadowRootOf(n);
  }
  function slotNameOf(n) { return n.nodeType === 1 ? (attrOf(n, 'slot') || '') : ''; }
  // the first slot of each name in sr, found once per change
  function slotsOf(sr) {
    if (sr._slotGen === generation && sr._slots) return sr._slots;
    var m = {}, all = [];
    eachElement(sr, function (e) { if (e.localName === 'slot' && e.namespaceURI === HTML_NS) { all.push(e); var nm = attrOf(e, 'name') || ''; if (!m[nm]) m[nm] = e; } });
    m._all = all;
    sr._slots = m; sr._slotGen = generation;
    return m;
  }
  function assignedSlotOf(n) {
    var p = n.parentNode;
    if (!p || !p._sr || (n.nodeType !== 1 && n.nodeType !== 3)) return null;
    if (p._sr._slotMode === 'manual') { var ms = n._manualSlot; return ms && shadowRootOf(ms) === p._sr && ms.isConnected && (ms._manual || []).indexOf(n) >= 0 ? ms : null; }
    return slotsOf(p._sr)[slotNameOf(n)] || null;
  }
  function slotted(slot) {
    var sr = shadowRootOf(slot);
    if (!sr) return [];
    if (sr._slotMode === 'manual') { var host = sr.host; return (slot._manual || []).filter(function (n) { return n.parentNode === host && n._manualSlot === slot; }); }
    var nm = attrOf(slot, 'name') || '';
    if (slotsOf(sr)[nm] !== slot) return [];
    var out = [], kids = sr.host._c;
    for (var i = 0; i < kids.length; i++) { var k = kids[i]; if ((k.nodeType === 1 || k.nodeType === 3) && slotNameOf(k) === nm) out.push(k); }
    return out;
  }
  function flatten(slot, out) {
    var a = slotted(slot);
    if (!a.length) a = slot._c;
    for (var i = 0; i < a.length; i++) {
      var k = a[i];
      if (k.nodeType === 1 && k.localName === 'slot' && shadowRootOf(k)) flatten(k, out); else out.push(k);
    }
    return out;
  }
  // the focused element is in el's shadow tree (or one inside it): the host
  // matches :focus (CSS Scoping 3.1.1)
  function focusInShadow(el) {
    for (var r = shadowRootOf(doc._active); r; r = shadowRootOf(r.host)) if (r.host === el) return true;
    return false;
  }
  function upFlat(n) { return shadowCount ? flatParent(n) : n.parentNode; }
  // the children n renders
  function flatKids(n) {
    if (!shadowCount) return n._c;
    if (n._sr) return n._sr._c;
    if (n.localName === 'slot' && n.namespaceURI === HTML_NS && shadowRootOf(n)) { var a = slotted(n); return a.length ? a : n._c; }
    return n._c;
  }
  // the element n is rendered in (its style's parent), null at the top
  function flatParent(n) {
    var p = n.parentNode;
    if (!p) return null;
    if (shadowCount) {
      if (p.nodeType === 11 && p.host) return p.host;
      if (p._sr) return assignedSlotOf(n) || p;
    }
    return p.nodeType === 1 ? p : null;
  }
  // elements in rendering order: shadow trees in place of their hosts'
  // children, slots with what they take
  function eachFlat(root, fn) {
    var stack = [];
    var top = flatKids(root);
    for (var i = top.length - 1; i >= 0; i--) stack.push(top[i]);
    while (stack.length) {
      var n = stack.pop();
      // (an element: only they have _attrs; nodeType is a getter)
      if (n._attrs === undefined) continue;
      if (fn(n) === true) return;
      var k = flatKids(n);
      for (var j = k.length - 1; j >= 0; j--) stack.push(k[j]);
    }
  }
  // n and what renders it render again (a text or scroll change): across
  // a shadow root to its host, from a host's child to its slot
  function stampUp(n) {
    for (var q = n; q; ) {
      q._rv = textStamp;
      if (shadowCount && q._sr) { var sl = slotsOf(q._sr)._all; for (var i = 0; i < sl.length; i++) for (var u = sl[i]; u && u !== q._sr; u = u.parentNode) u._rv = textStamp; }
      q = q.nodeType === 11 && q.host ? q.host : q.parentNode;
    }
  }
  // slotchange (DOM 4.2.2.5): each slot whose assigned nodes are not the
  // ones they were, after the change (a microtask)
  var slotCheckQueued = false, slotHints = [];
  // (hint: a slot the change is for, signalled first, in change order)
  function scheduleSlots(hint) {
    if (hint && slotHints.indexOf(hint) < 0) slotHints.push(hint);
    if (slotCheckQueued || !shadowCount) return;
    slotCheckQueued = true;
    Promise.resolve().then(function () {
      slotCheckQueued = false;
      var hints = slotHints;
      slotHints = [];
      for (var r = -1; r < shadowRoots.length; r++) {
        var all = r < 0 ? hints : slotsOf(shadowRoots[r])._all;
        for (var i = 0; i < all.length; i++) {
          var sl = all[i], sig = slotted(sl).map(function (k) { return k.__id; }).join(',');
          if (sl._slotSig === undefined) { sl._slotSig = sig; if (!sig) continue; }
          else if (sl._slotSig === sig) continue;
          sl._slotSig = sig;
          dispatch(sl, new Event('slotchange', { bubbles: true }));
        }
      }
    });
  }

  class DocumentFragment extends Node {
    get nodeType() { return 11; }
    get nodeName() { return '#document-fragment'; }
    getElementById(id) { var f = null; eachElement(this, function (e) { if (e.id === id) { f = e; return true; } }); return f; }
  }
  mixin(DocumentFragment, ParentNode);

  class DocumentType extends Node {
    constructor(name) { super(); this.name = name; this.publicId = ''; this.systemId = ''; }
    get nodeType() { return 10; }
    get nodeName() { return this.name; }
  }

  // ---- attributes ----------------------------------------------------------

  class Attr {
    constructor(name, value, owner) { this.name = name; this._v = value; this.ownerElement = owner; this.namespaceURI = null; this.prefix = null; this.specified = true; }
    get localName() { return this.name; }
    get value() { return this._v; }
    set value(v) { if (this.ownerElement) this.ownerElement.setAttribute(this.name, v); else this._v = String(v); }
    get nodeValue() { return this._v; }
    get nodeType() { return 2; }
    get nodeName() { return this.name; }
  }

  function NamedNodeMap(el) {
    var list = el._attrs;
    return new Proxy(list, {
      get: function (t, k) {
        if (k === 'getNamedItem') return function (n) { return el.getAttributeNode(n); };
        if (k === 'item') return function (i) { return list[i] || null; };
        if (k === 'removeNamedItem') return function (n) { var a = el.getAttributeNode(n); el.removeAttribute(n); return a; };
        if (k === 'setNamedItem') return function (a) { el.setAttribute(a.name, a.value); return null; };
        if (typeof k === 'string' && !/^\d+$/.test(k) && k !== 'length' && !(k in Array.prototype)) return el.getAttributeNode(k) || undefined;
        return t[k];
      }
    });
  }

  var attrLower = Object.create(null), attrLowerN = 0, attrValid = Object.create(null), attrValidN = 0;
  class DOMTokenList {
    constructor(el, attr) { this._el = el; this._attr = attr; this._tv = undefined; this._tl = null; }
    // (the attribute's tokens, split once per value it has: a grid toggles
    // a few classes on every cell it shows, and each toggle split the
    // text twice. The list is kept as it is; a change works on a copy)
    _tok() {
      var v = attrOf(this._el, this._attr);
      if (v === this._tv && this._tl) return this._tl;
      var l = v ? (v.indexOf(' ') < 0 && !/[\t\n\f\r]/.test(v) ? [v] : v.split(/[ \t\n\f\r]+/).filter(Boolean)) : [];
      this._tv = v;
      this._tl = l;
      return l;
    }
    _list() { return this._tok().slice(); }
    _set(l) {
      var s = l.join(' ');
      this._el.setAttribute(this._attr, s);
      // (what was set, when no hook made it something else)
      if (attrOf(this._el, this._attr) === s) { this._tv = s; this._tl = l; }
    }
    get length() { return this._tok().length; }
    get value() { return this._el.getAttribute(this._attr) || ''; }
    set value(v) { this._el.setAttribute(this._attr, v); }
    item(i) { var l = this._tok(); return i < l.length ? l[i] : null; }
    contains(t) { return this._tok().indexOf(String(t)) >= 0; }
    add() {
      var cur = this._tok(), l = null;
      for (var i = 0; i < arguments.length; i++) { var t = String(arguments[i]); checkToken(t); if ((l || cur).indexOf(t) < 0) { if (!l) l = cur.slice(); l.push(t); } }
      if (l || attrOf(this._el, this._attr) === null) this._set(l || cur.slice());
    }
    remove() {
      var cur = this._tok(), l = null;
      for (var i = 0; i < arguments.length; i++) { var t = String(arguments[i]); checkToken(t); var k = (l || cur).indexOf(t); while (k >= 0) { if (!l) l = cur.slice(); l.splice(k, 1); k = l.indexOf(t); } }
      if (l) this._set(l);
    }
    toggle(t, force) {
      t = String(t);
      var has = this._tok().indexOf(t) >= 0;
      if (force === undefined ? has : !force) { if (has) this.remove(t); return false; }
      if (!has) this.add(t);
      return true;
    }
    replace(a, b) { var l = this._list(), k = l.indexOf(a); if (k < 0) return false; l[k] = b; this._set(l); return true; }
    supports() { return true; }
    forEach(fn, thisArg) { var l = this._list(); for (var i = 0; i < l.length; i++) fn.call(thisArg, l[i], i, this); }
    entries() { return this._list().entries(); }
    keys() { return this._list().keys(); }
    values() { return this._list().values(); }
    toString() { return this.value; }
  }
  DOMTokenList.prototype[Symbol.iterator] = function () { return this._list()[Symbol.iterator](); };
  // (tokens that passed: the same few class names come again and again)
  var tokenOk = Object.create(null), tokenOkN = 0;
  function checkToken(t) {
    if (tokenOk[t] === true) return;
    if (t === '') throw DOMException('The token provided must not be empty.', 'SyntaxError');
    if (/\s/.test(t)) throw DOMException("The token provided ('" + t + "') contains HTML space characters, which are not valid in tokens.", 'InvalidCharacterError');
    if (tokenOkN < 4096) { tokenOkN++; tokenOk[t] = true; }
  }

  // ---- style declarations --------------------------------------------------

  function kebab(n) {
    if (n.slice(0, 2) === '--') return n;
    if (n === 'cssFloat') return 'float';
    var s = n.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
    if (/^(webkit|moz|ms)-/.test(s)) s = '-' + s;
    return s;
  }
  function camel(n) { return n.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); }

  class CSSStyleDeclaration {
    constructor(owner) { this._p = {}; this._prio = {}; this._order = []; this._owner = owner || null; this._readonly = false; this.parentRule = null; }
    get length() { return this._order.length; }
    item(i) { return this._order[i] || ''; }
    getPropertyValue(n) { n = String(n); if (n.slice(0, 2) !== '--') n = n.toLowerCase(); var v = this._p[n]; return v === undefined ? '' : v; }
    getPropertyPriority(n) { return this._prio[String(n).toLowerCase()] ? 'important' : ''; }
    setProperty(n, v, prio) {
      if (this._readonly) throw DOMException('read-only', 'NoModificationAllowedError');
      n = String(n);
      if (n.slice(0, 2) !== '--') n = n.toLowerCase();
      if (v === null || v === undefined || v === '') { this.removeProperty(n); return; }
      v = specifiedText(n, String(v).trim());
      var longhands = expandShorthand(n, v);
      if (longhands) {
        for (var k in longhands) this._set(k, longhands[k], prio);
        this._sync();
        return;
      }
      // (one property set: attrChanged may patch the element's style,
      // patchedStyle; a removed one takes the cascade's value, all styled)
      this._set(n, v, prio);
      this._sync(n);
    }
    _set(n, v, prio) {
      // (a shorthand's longhand it gave no value: not set, as a browser
      // drops an invalid declaration; AG Grid's styles had one, and its
      // computed style threw)
      if (v === undefined || v === null) return;
      if (this._p[n] === undefined) this._order.push(n);
      this._p[n] = v;
      if (prio === 'important') this._prio[n] = true; else delete this._prio[n];
    }
    removeProperty(n) {
      n = String(n);
      if (n.slice(0, 2) !== '--') n = n.toLowerCase();
      var old = this.getPropertyValue(n);
      var names = shorthandParts(n) || [n];
      var hit = false;
      for (var j = 0; j < names.length; j++) {
        var i = this._order.indexOf(names[j]);
        if (i >= 0) { this._order.splice(i, 1); delete this._p[names[j]]; delete this._prio[names[j]]; hit = true; }
      }
      if (hit) this._sync();
      return old;
    }
    get cssText() {
      var out = [];
      for (var i = 0; i < this._order.length; i++) {
        var n = this._order[i];
        out.push(n + ': ' + this._p[n] + (this._prio[n] ? ' !important' : '') + ';');
      }
      return out.join(' ');
    }
    set cssText(t) {
      this._p = {}; this._prio = {}; this._order = [];
      var decls = parseDeclarations(String(t || ''));
      for (var i = 0; i < decls.length; i++) {
        var dv = specifiedText(decls[i].name, decls[i].value);
        var lh = expandShorthand(decls[i].name, dv);
        if (lh) for (var k in lh) this._set(k, lh[k], decls[i].important ? 'important' : '');
        else this._set(decls[i].name, dv, decls[i].important ? 'important' : '');
      }
      this._sync();
    }
    _sync(one) {
      if (!this._owner) return;
      this._owner._styleSync = true;
      this._owner._styleChg = one !== undefined ? [one] : null;
      var t = this.cssText;
      if (t) this._owner.setAttribute('style', t); else this._owner.removeAttribute('style');
      this._owner._styleSync = false;
      this._owner._styleChg = null;
    }
  }
  // a declared value as CSSOM serialises it (CSSOM 6.7.2, as Chromium
  // does): one space between components, none inside a function's
  // parentheses, ", " between arguments; strings and url() as written.
  // A custom property keeps its tokens.
  function specifiedText(n, v) {
    if (n.slice(0, 2) === '--' || !/[,(]|\s\s|\s\)/.test(v)) return v;
    // (no string and no url(): the same by four replaces. A transform set
    // on 500 elements each frame spent half its time in the loop below)
    if (!/["'\\]|url\(|,\s*,/i.test(v)) return v.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ?, ?/g, ', ').trim();
    var out = '', depth = 0, i = 0, len = v.length;
    while (i < len) {
      var c = v.charAt(i);
      if (c === '"' || c === "'") {
        var j = i + 1;
        while (j < len && v.charAt(j) !== c) j += v.charAt(j) === '\\' ? 2 : 1;
        out += v.slice(i, j + 1); i = j + 1; continue;
      }
      if (/\s/.test(c)) {
        while (i < len && /\s/.test(v.charAt(i))) i++;
        var nx = v.charAt(i);
        if (i < len && nx !== ')' && nx !== ',' && out.slice(-1) !== '(' && out.slice(-1) !== ' ') out += ' ';
        continue;
      }
      if (c === '(') {
        // url(...) unquoted: as written
        if (/url$/i.test(out)) { var e = v.indexOf(')', i); if (e < 0) e = len - 1; out += v.slice(i, e + 1); i = e + 1; continue; }
        depth++; out += c; i++; continue;
      }
      if (c === ')') { depth--; out += c; i++; continue; }
      if (c === ',') { out = out.replace(/ $/, '') + ', '; i++; while (i < len && /\s/.test(v.charAt(i))) i++; continue; }
      out += c; i++;
    }
    return out.trim();
  }
  CSSStyleDeclaration.prototype[Symbol.iterator] = function () { return this._order.slice()[Symbol.iterator](); };

  // camelCase and kebab-case properties (style.backgroundColor, style['margin-top'])
  function styleProxy(decl) {
    return new Proxy(decl, {
      get: function (t, k) {
        if (typeof k !== 'string' || k in t) { var v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
        if (/^\d+$/.test(k)) return t._order[+k];
        return t.getPropertyValue(kebab(k));
      },
      set: function (t, k, v) {
        if (typeof k !== 'string' || k in t || k.charAt(0) === '_') { t[k] = v; return true; }
        t.setProperty(kebab(k), v === null || v === undefined ? '' : String(v));
        return true;
      },
      has: function (t, k) { return k in t || (typeof k === 'string' && /^[a-zA-Z-]+$/.test(k)); }
    });
  }

  var SIDES = ['top', 'right', 'bottom', 'left'];
  function boxSides(v) {
    var p = splitValue(v);
    if (p.length === 1) return [p[0], p[0], p[0], p[0]];
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 3) return [p[0], p[1], p[2], p[1]];
    return [p[0], p[1], p[2], p[3]];
  }
  function splitValue(v) {
    // spaces outside parentheses
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i);
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth === 0 && /\s/.test(c)) { if (cur) out.push(cur); cur = ''; } else cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }
  function splitComma(v) {
    if (v.indexOf(',') < 0) return [v.trim()];
    var out = [], depth = 0, start = 0, n = v.length;
    for (var i = 0; i < n; i++) {
      var c = v.charCodeAt(i);
      if (c === 40) depth++;
      else if (c === 41) depth--;
      else if (c === 44 && depth === 0) { out.push(v.slice(start, i).trim()); start = i + 1; }
    }
    out.push(v.slice(start).trim());
    return out;
  }
  var BORDER_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/;
  function isColorWord(t) { return /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|var\()/.test(t) || NAMED_COLORS[t.toLowerCase()] !== undefined || t === 'transparent' || t === 'currentcolor' || t === 'currentColor'; }
  function isLength(t) { return /^[+-]?[\d.]+(px|em|rem|%|vh|vw|vmin|vmax|pt|pc|in|cm|mm|q|ch|ex)?$/i.test(t) || /^(calc|min|max|clamp)\(/.test(t) || t === 'thin' || t === 'medium' || t === 'thick'; }
  function shorthandParts(n) {
    if (n === 'margin' || n === 'padding') return SIDES.map(function (s) { return n + '-' + s; });
    if (n === 'inset') return SIDES.slice();
    if (n === 'border-width' || n === 'border-style' || n === 'border-color') { var w = n.slice(7); return SIDES.map(function (s) { return 'border-' + s + '-' + w; }); }
    if (n === 'border') return [].concat(shorthandParts('border-width'), shorthandParts('border-style'), shorthandParts('border-color'));
    if (/^border-(top|right|bottom|left)$/.test(n)) return [n + '-width', n + '-style', n + '-color'];
    if (n === 'border-radius') return ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
    if (n === 'flex') return ['flex-grow', 'flex-shrink', 'flex-basis'];
    if (n === 'gap') return ['row-gap', 'column-gap'];
    if (n === 'overflow') return ['overflow-x', 'overflow-y'];
    if (n === 'flex-flow') return ['flex-direction', 'flex-wrap'];
    if (n === 'place-items') return ['align-items', 'justify-items'];
    if (n === 'place-content') return ['align-content', 'justify-content'];
    if (n === 'place-self') return ['align-self', 'justify-self'];
    if (n === 'grid-gap') return ['row-gap', 'column-gap'];
    if (n === 'grid-row-gap') return ['row-gap'];
    if (n === 'grid-column-gap') return ['column-gap'];
    if (n === 'grid-template') return ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'];
    if (n === 'grid') return ['grid-template-rows', 'grid-template-columns', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-rows', 'grid-auto-columns'];
    if (n === 'outline') return ['outline-width', 'outline-style', 'outline-color'];
    if (n === 'list-style') return ['list-style-type', 'list-style-position', 'list-style-image'];
    if (n === 'font') return ['font-style', 'font-variant', 'font-weight', 'font-size', 'line-height', 'font-family'];
    return null;
  }
  // a shorthand's longhands, or null; values with var() stay whole (their
  // parts are known only when computed)
  // the logical properties (margin-inline, padding-block, inset-inline,
  // border-inline-start, ...) as their logical longhands (margin-inline-
  // start, border-block-end-width, ...): which physical side each is
  // depends on the element's writing mode and direction, known when its
  // style is computed (physicalOf)
  function logicalLonghands(n, v) {
    var m = /^(margin|padding|inset|border)-(inline|block)(?:-(start|end))?(-width|-style|-color)?$/.exec(n);
    if (!m) return null;
    var base = m[1], axis = m[2], side = m[3], part = m[4] || '';
    var out = {};
    if (side) {
      if (base !== 'border' || part) return null;
      var bs = expandShorthand('border-left', v);
      for (var kb0 in bs) out[n + kb0.slice('border-left'.length)] = bs[kb0];
      return out;
    }
    if (/var\(/.test(v)) { out[n] = v; return out; }
    var ends = [base + '-' + axis + '-start' + part, base + '-' + axis + '-end' + part];
    if (base === 'border' && !part) {
      var a = logicalLonghands(ends[0], v), b = logicalLonghands(ends[1], v);
      for (var ka in a) out[ka] = a[ka];
      for (var kb in b) out[kb] = b[kb];
      return out;
    }
    var vals = splitValue(v);
    out[ends[0]] = vals[0];
    out[ends[1]] = vals.length > 1 ? vals[1] : vals[0];
    return out;
  }
  // a logical longhand's physical property for an element in writing mode
  // wm and direction dir (CSS Logical 4), or null for any other name
  function physicalOf(n, wm, dir) {
    var sz = /^(min-|max-)?(inline|block)-size$/.exec(n);
    var vert = /^(vertical|sideways)/.test(wm || '');
    if (sz) return (sz[1] || '') + ((sz[2] === 'inline') !== vert ? 'width' : 'height');
    var m = /^(margin|padding|inset|border)-(inline|block)-(start|end)(-width|-style|-color)?$/.exec(n);
    if (!m) return null;
    var side;
    if (m[2] === 'block') {
      var rl = wm === 'vertical-rl' || wm === 'sideways-rl';
      side = !vert ? (m[3] === 'start' ? 'top' : 'bottom') : ((m[3] === 'start') === rl ? 'right' : 'left');
    } else {
      var fwd = (m[3] === 'start') === (dir !== 'rtl');
      side = vert ? (fwd ? 'top' : 'bottom') : (fwd ? 'left' : 'right');
    }
    return m[1] === 'inset' ? side : m[1] + '-' + side + (m[4] || '');
  }
  // grid-template: rows / columns, or the areas form ("a b" 10px "c d" /
  // 1fr 1fr); grid: the same, or an auto-flow side (CSS Grid 7.4, 7.8)
  function gridLonghands(n, v) {
    var out = { 'grid-template-rows': 'none', 'grid-template-columns': 'none', 'grid-template-areas': 'none' };
    if (n === 'grid') { out['grid-auto-flow'] = 'row'; out['grid-auto-rows'] = 'auto'; out['grid-auto-columns'] = 'auto'; }
    var t = v.trim();
    if (/^(none|initial|unset|inherit|revert)$/i.test(t)) return out;
    var depth = 0, cut = -1, quote = '';
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '/' && depth === 0) { cut = i; break; }
    }
    var left = (cut < 0 ? t : t.slice(0, cut)).trim(), right = cut < 0 ? '' : t.slice(cut + 1).trim();
    if (n === 'grid' && /\bauto-flow\b/.test(left)) {
      out['grid-auto-flow'] = /\bdense\b/.test(left) ? 'row dense' : 'row';
      var ar = left.replace(/\bauto-flow\b/, '').replace(/\bdense\b/, '').trim();
      if (ar) out['grid-auto-rows'] = ar;
      if (right) out['grid-template-columns'] = right;
      return out;
    }
    if (n === 'grid' && /\bauto-flow\b/.test(right)) {
      out['grid-auto-flow'] = /\bdense\b/.test(right) ? 'column dense' : 'column';
      var ac = right.replace(/\bauto-flow\b/, '').replace(/\bdense\b/, '').trim();
      if (ac) out['grid-auto-columns'] = ac;
      if (left) out['grid-template-rows'] = left;
      return out;
    }
    if (/["']/.test(left)) {
      // the areas form: each string a row, the size after it the row's
      var areas = [], rows = [], re = /(\[[^\]]*\]\s*)?(["'])([^"']*)\2\s*([^"'\[]*?)?\s*(\[[^\]]*\])?\s*(?=["'\[]|$)/g, m;
      while ((m = re.exec(left)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        areas.push('"' + m[3] + '"');
        rows.push((m[4] || '').trim() || 'auto');
      }
      out['grid-template-areas'] = areas.join(' ');
      out['grid-template-rows'] = rows.join(' ');
      if (right) out['grid-template-columns'] = right;
      return out;
    }
    out['grid-template-rows'] = left;
    if (right) out['grid-template-columns'] = right;
    return out;
  }
  function expandShorthand(n, v) {
    var logical = logicalLonghands(n, v);
    if (logical) return logical;
    var parts = shorthandParts(n);
    // list-style: a position, an image and a type in any order; none is
    // the image's, then the type's (CSS Lists 3)
    if (n === 'list-style') {
      var lt = splitValue(v), nones = 0;
      var lo = { 'list-style-type': 'disc', 'list-style-position': 'outside', 'list-style-image': 'none' };
      for (var li = 0; li < lt.length; li++) {
        var lv = lt[li];
        if (/^(inside|outside)$/i.test(lv)) lo['list-style-position'] = lv.toLowerCase();
        else if (/^(url|image|linear-gradient|radial-gradient)\(/i.test(lv)) lo['list-style-image'] = lv;
        else if (/^none$/i.test(lv)) nones++;
        else lo['list-style-type'] = lv;
      }
      if (nones && (nones > 1 || lo['list-style-image'] !== 'none' || !lt.some(function (t) { return !/^(none|inside|outside)$/i.test(t) && !/\(/.test(t); }))) lo['list-style-type'] = 'none';
      return lo;
    }
    if (!parts) {
      // (a var() in it is substituted first, when the style is computed:
      // Bootstrap's btn-close, `transparent var(--bs-btn-close-bg) center/1em auto no-repeat`)
      if (n === 'background' && /var\(/.test(v)) { var ob = {}; ob[n] = v; return ob; }
      if (n === 'background') {
        var bg = [], color = null, image = null, rep = [], pos = [], size = null, att = null;
        splitValue(v).forEach(function (t) {
          if (/\(/.test(t) || t.indexOf('/') < 0) { bg.push(t); return; }
          t.split('/').forEach(function (u, j) { if (j) bg.push('/'); if (u) bg.push(u); });
        });
        for (var i = 0; i < bg.length; i++) {
          if (/^(repeat|repeat-x|repeat-y|no-repeat|space|round)$/i.test(bg[i])) rep.push(bg[i].toLowerCase());
          else if (/^(scroll|fixed|local)$/i.test(bg[i])) att = bg[i].toLowerCase();
          else if (bg[i] === '/' && i + 1 < bg.length) { size = bg[i + 1]; i++; if (i + 1 < bg.length && /^([\d.]+[a-z%]*|auto)$/i.test(bg[i + 1])) { size += ' ' + bg[i + 1]; i++; } }
          else if (/^(left|right|top|bottom|center)$/i.test(bg[i]) || /^-?[\d.]+([a-z]+|%)?$/i.test(bg[i])) pos.push(bg[i].toLowerCase());
          else if (isColorWord(bg[i]) && !/^var\(/.test(bg[i])) color = bg[i];
          else if (/^(url|linear-gradient|radial-gradient|repeating-|conic-gradient)/.test(bg[i])) image = bg[i];
          else if (/^var\(/.test(bg[i]) && bg.length === 1) color = bg[i];
        }
        var o = { 'background-color': color || 'transparent', 'background-image': image || 'none',
          'background-repeat': rep.length ? rep.join(' ') : 'repeat', 'background-position': pos.length ? pos.join(' ') : '0% 0%',
          'background-size': size || 'auto', 'background-attachment': att || 'scroll' };
        return o;
      }
      return null;
    }
    if (/var\(/.test(v)) {
      var o2 = {};
      o2[n] = v;
      return o2;
    }
    var out = {};
    var low = v.toLowerCase();
    // (a CSS-wide keyword is every longhand's: `border-left: inherit`)
    if (/^(inherit|initial|unset|revert|revert-layer)$/.test(low.trim()) && (n === 'border' || /^border-(top|right|bottom|left)$/.test(n) || n === 'outline')) {
      var wl = low.trim(), sides = n === 'border' ? SIDES.map(function (x) { return 'border-' + x; }) : [n];
      sides.forEach(function (b) { out[b + '-width'] = wl; out[b + '-style'] = wl; out[b + '-color'] = wl; });
      return out;
    }
    if (n === 'margin' || n === 'padding' || n === 'inset' || n === 'border-width' || n === 'border-style' || n === 'border-color' || n === 'border-radius') {
      var s = boxSides(n === 'border-radius' ? v.split('/')[0].trim() : v);
      for (var k = 0; k < 4; k++) out[parts[k]] = s[k];
      return out;
    }
    if (n === 'border' || /^border-(top|right|bottom|left)$/.test(n) || n === 'outline') {
      var w = 'medium', st = 'none', c = 'currentcolor';
      var toks = splitValue(v);
      for (var t = 0; t < toks.length; t++) {
        if (BORDER_STYLES.test(toks[t]) || (n === 'outline' && toks[t] === 'auto')) st = toks[t];
        else if (isLength(toks[t])) w = toks[t];
        else c = toks[t];
      }
      if (low === 'none' || low === '0') { st = 'none'; w = low === '0' ? '0' : 'medium'; }
      if (n === 'border') {
        for (var q = 0; q < 4; q++) { out['border-' + SIDES[q] + '-width'] = w; out['border-' + SIDES[q] + '-style'] = st; out['border-' + SIDES[q] + '-color'] = c; }
      } else { out[n + '-width'] = w; out[n + '-style'] = st; out[n + '-color'] = c; }
      return out;
    }
    if (n === 'flex') {
      var f = splitValue(v);
      if (low === 'none') { out['flex-grow'] = '0'; out['flex-shrink'] = '0'; out['flex-basis'] = 'auto'; }
      else if (low === 'auto') { out['flex-grow'] = '1'; out['flex-shrink'] = '1'; out['flex-basis'] = 'auto'; }
      else if (low === 'initial') { out['flex-grow'] = '0'; out['flex-shrink'] = '1'; out['flex-basis'] = 'auto'; }
      else {
        out['flex-grow'] = '1'; out['flex-shrink'] = '1'; out['flex-basis'] = '0%';
        var nums = [];
        for (var z = 0; z < f.length; z++) { if (/^[\d.]+$/.test(f[z])) nums.push(f[z]); else out['flex-basis'] = f[z]; }
        // a third number is the basis, valid only as 0 (a unitless
        // non-zero basis makes the declaration invalid)
        if (nums.length > 3 || (nums.length === 3 && (out['flex-basis'] !== '0%' || parseFloat(nums[2]) !== 0))) return {};
        if (nums.length === 3) out['flex-basis'] = '0px';
        if (nums.length) out['flex-grow'] = nums[0];
        if (nums.length > 1) out['flex-shrink'] = nums[1];
      }
      return out;
    }
    if (n === 'font') {
      // [style] [variant] [weight] size[/line-height] family; a keyword for all
      if (/^(inherit|initial|unset|revert)$/.test(low)) { for (var fp = 0; fp < parts.length; fp++) out[parts[fp]] = low; return out; }
      var fm = /^(.*?)\b((?:calc|min|max|clamp)\([^()]*(?:\([^()]*\)[^()]*)*\)|[\d.]+(?:px|em|rem|%|pt|pc|in|cm|mm|q|ex|ch|vh|vw)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*(\S+))?\s+(\S.*)$/.exec(v.trim());
      if (!fm) return {};
      out['font-style'] = 'normal'; out['font-variant'] = 'normal'; out['font-weight'] = 'normal';
      var pre = splitValue(fm[1]);
      for (var fq = 0; fq < pre.length; fq++) {
        if (/^(italic|oblique)$/.test(pre[fq])) out['font-style'] = pre[fq];
        else if (pre[fq] === 'small-caps') out['font-variant'] = pre[fq];
        else if (/^(bold|bolder|lighter|\d{3})$/.test(pre[fq])) out['font-weight'] = pre[fq];
      }
      out['font-size'] = fm[2]; out['line-height'] = fm[3] || 'normal'; out['font-family'] = fm[4];
      return out;
    }
    if (n === 'gap' || n === 'grid-gap') { var g = splitValue(v); out['row-gap'] = g[0]; out['column-gap'] = g[1] || g[0]; return out; }
    if (n === 'grid-row-gap') { out['row-gap'] = v.trim(); return out; }
    if (n === 'grid-column-gap') { out['column-gap'] = v.trim(); return out; }
    if (n === 'grid-template' || n === 'grid') return gridLonghands(n, v);
    if (n === 'overflow') { var ov = splitValue(v); out['overflow-x'] = ov[0]; out['overflow-y'] = ov[1] || ov[0]; return out; }
    if (n === 'flex-flow') {
      var ff = splitValue(v);
      out['flex-direction'] = 'row'; out['flex-wrap'] = 'nowrap';
      for (var y = 0; y < ff.length; y++) { if (/wrap|balance/.test(ff[y])) out['flex-wrap'] = ff[y]; else out['flex-direction'] = ff[y]; }
      return out;
    }
    var pp = splitValue(v);
    out[parts[0]] = pp[0];
    out[parts[1]] = pp[1] || pp[0];
    return out;
  }

  // ---- elements ------------------------------------------------------------

  class Element extends Node {
    constructor(qname, ns) {
      super();
      this._qname = qname;
      this.namespaceURI = ns === undefined ? HTML_NS : ns;
      var c = qname.indexOf(':');
      this.prefix = c > 0 ? qname.slice(0, c) : null;
      this.localName = c > 0 ? qname.slice(c + 1) : qname;
      this._attrs = [];
      this._style = null;
      this._styleSync = false;
      this._sTop = 0;
      this._sLeft = 0;
      this.shadowRoot = null;
    }
    get nodeType() { return 1; }
    // a script's scroll: a scroll event at the next frame, as a browser
    // sends it (TanStack Virtual's scrollToIndex waits for it)
    // (a scrolled box's offset is clamped by a layout: read after its
    // content shrank, it is laid out first)
    // (an offset of 0 stays 0 whatever the range has become: no layout for it)
    get scrollTop() { if (this._scl && this._sTop) scrollRead(this); return this._sTop; }
    set scrollTop(v) { v = Math.max(0, +v || 0); if (this === (doc && doc.documentElement) && doc.body && boxes[doc.body.__id]) v = Math.min(v, Math.max(0, Math.round(pageHeight()) - viewport.h)); if (v === this._sTop) return; this._sTop = v; keptScroll(this); scriptScrolled(this); }
    get scrollLeft() { if (this._scl && this._sLeft) scrollRead(this); return this._sLeft; }
    set scrollLeft(v) { v = +v || 0; if (v === this._sLeft) return; this._sLeft = v; keptScroll(this); scriptScrolled(this); }
    get nodeName() { return this.tagName; }
    get tagName() { return this.namespaceURI === HTML_NS ? this._qname.toUpperCase() : this._qname; }
    get attributes() { return NamedNodeMap(this); }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get classList() { return this._cl || (this._cl = new DOMTokenList(this, 'class')); }
    get slot() { return this.getAttribute('slot') || ''; }
    set slot(v) { this.setAttribute('slot', v); }
    // (attribute names as HTML takes them, lower case, and the names that
    // are valid ones: both kept for the names seen, a page uses a few
    // dozen and reads or sets them all the time)
    _norm(n) {
      if (typeof n !== 'string') n = String(n);
      if (this.namespaceURI !== HTML_NS) return n;
      var l = attrLower[n];
      if (l === undefined) { l = n.toLowerCase(); if (attrLowerN < 4096) { attrLowerN++; attrLower[n] = l; } }
      return l;
    }
    _find(n) { for (var i = 0; i < this._attrs.length; i++) if (this._attrs[i].name === n) return i; return -1; }
    getAttribute(n) { n = this._norm(n); var a = this._attrs; for (var i = 0; i < a.length; i++) if (a[i].name === n) return a[i]._v; return null; }
    getAttributeNS(ns, n) { return this.getAttribute(n); }
    getAttributeNode(n) { var i = this._find(this._norm(n)); return i < 0 ? null : this._attrs[i]; }
    getAttributeNames() { return this._attrs.map(function (a) { return a.name; }); }
    hasAttribute(n) { return this._find(this._norm(n)) >= 0; }
    hasAttributeNS(ns, n) { return this.hasAttribute(n); }
    hasAttributes() { return this._attrs.length > 0; }
    setAttribute(n, v) {
      n = this._norm(n);
      if (attrValid[n] !== true) {
        if (!/^[^\s"'>\/=\0]+$/.test(n)) throw DOMException("Failed to execute 'setAttribute' on 'Element': '" + n + "' is not a valid attribute name.", 'InvalidCharacterError');
        if (attrValidN < 4096) { attrValidN++; attrValid[n] = true; }
      }
      if (typeof v !== 'string') v = String(v);
      var i = this._find(n);
      var old = i < 0 ? null : this._attrs[i]._v;
      if (i < 0) this._attrs.push(new Attr(n, v, this)); else this._attrs[i]._v = v;
      this._attrChanged(n, old, v);
    }
    setAttributeNS(ns, n, v) {
      var c = String(n).indexOf(':');
      this.setAttribute(c > 0 && ns !== 'http://www.w3.org/1999/xlink' ? String(n).slice(c + 1) : n, v);
    }
    removeAttribute(n) {
      n = this._norm(n);
      var i = this._find(n);
      if (i < 0) return;
      var old = this._attrs[i]._v;
      this._attrs.splice(i, 1);
      this._attrChanged(n, old, null);
    }
    removeAttributeNS(ns, n) { this.removeAttribute(n); }
    toggleAttribute(n, force) {
      var has = this.hasAttribute(n);
      if (force === undefined ? has : !force) { this.removeAttribute(n); return false; }
      if (!has) this.setAttribute(n, '');
      return true;
    }
    setAttributeNode(a) { this.setAttribute(a.name, a.value); return null; }
    _attrChanged(n, old, v) {
      // (the value it had: no selector or inline style changes, nothing is
      // styled or drawn again. AG Grid sets the same style text on its
      // root at every resize; each one restyled the whole grid)
      if (old !== v) attrChanged(this, n, old, v);
      if (VALIDATION_ATTRS[n] && /^(input|select|textarea|button|option)$/.test(this.localName)) validityChanged(this.localName === 'option' ? this.parentNode : this);
      if (n === 'style' && !this._styleSync && this._style) {
        this._styleSync = true;
        this._style.cssText = v || '';
        this._styleSync = false;
      }
      if (this._attrHook) this._attrHook(n, old, v);
      queueMutation(this, 'attributes', { attributeName: n, oldValue: old });
    }
    get style() {
      if (!this._style) {
        var d = new CSSStyleDeclaration(this);
        var s = this.getAttribute('style');
        if (s) { this._styleSync = true; d.cssText = s; this._styleSync = false; }
        this._styleProxy = styleProxy(d);
        this._style = d;
      }
      return this._styleProxy;
    }
    set style(v) { this.style.cssText = v; }
    get innerHTML() { return serializeChildren(this); }
    set innerHTML(v) {
      removeAll(this);
      var frag = parseFragment(String(v === null || v === undefined ? '' : v), this);
      this.appendChild(frag);
    }
    get outerHTML() { return serialize(this, false); }
    set outerHTML(v) {
      var p = this.parentNode;
      if (!p) return;
      var frag = parseFragment(String(v), p.nodeType === 1 ? p : null);
      p.replaceChild(frag, this);
    }
    insertAdjacentHTML(where, html) { this.insertAdjacentElement(where, parseFragment(String(html), this)); }
    insertAdjacentText(where, text) { this.insertAdjacentElement(where, this.ownerDocument.createTextNode(text)); }
    insertAdjacentElement(where, el) {
      where = String(where).toLowerCase();
      if (where === 'beforebegin') { if (this.parentNode) this.parentNode.insertBefore(el, this); }
      else if (where === 'afterbegin') this.insertBefore(el, this.firstChild);
      else if (where === 'beforeend') this.appendChild(el);
      else if (where === 'afterend') { if (this.parentNode) this.parentNode.insertBefore(el, this.nextSibling); }
      else throw DOMException("The value provided ('" + where + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.", 'SyntaxError');
      return el;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    before() { insertNodes(this.parentNode, this, arguments, this.ownerDocument); }
    after() { insertNodes(this.parentNode, this.nextSibling, arguments, this.ownerDocument); }
    replaceWith() { var p = this.parentNode; if (!p) return; var next = this.nextSibling; p.removeChild(this); insertNodes(p, next, arguments, this.ownerDocument); }
    get nextElementSibling() { return siblingElement(this, 1); }
    get previousElementSibling() { return siblingElement(this, -1); }
    matches(s) { return matchesSelector(this, s); }
    webkitMatchesSelector(s) { return matchesSelector(this, s); }
    closest(s) {
      var list = parseSelectorList(s);
      for (var n = this; n && n.nodeType === 1; n = n.parentNode) if (matchList(n, list)) return n;
      return null;
    }
    getBoundingClientRect() { reflow(); if (!boxes[this.__id] && virts.length && virtBoxOf(this) === null && virtPin(this)) reflow(); return boxes[this.__id] || (virts.length && virtBoxOf(this)) ? rectOf(this) : estimatedRect(this) || rectOf(this); }
    getClientRects() { var r = this.getBoundingClientRect(); return r.width || r.height ? [r] : []; }
    get clientWidth() { return sizeOf(this, 'cw'); }
    get clientHeight() { return sizeOf(this, 'ch'); }
    get clientTop() { return 0; }
    get clientLeft() { return 0; }
    get scrollWidth() { return sizeOf(this, 'sw'); }
    get scrollHeight() { return sizeOf(this, 'sh'); }
    scrollTo(x, y) { if (typeof x === 'object' && x) { y = x.top; x = x.left; } if (x !== undefined) this.scrollLeft = +x || 0; if (y !== undefined) this.scrollTop = +y || 0; }
    scroll(x, y) { this.scrollTo(x, y); }
    scrollBy(x, y) { if (typeof x === 'object' && x) { y = x.top; x = x.left; } this.scrollLeft += +x || 0; this.scrollTop += +y || 0; }
    scrollIntoView(arg) { scrollIntoView(this, arg); }
    scrollIntoViewIfNeeded(center) { scrollIntoView(this, { block: center === false ? 'nearest' : 'center', inline: 'nearest' }); }
    attachShadow(init) {
      if (this._sr) throw DOMException("Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.", 'NotSupportedError');
      var r = new ShadowRoot(this, init);
      this.shadowRoot = init && init.mode === 'closed' ? null : r;
      this._sr = r;
      shadowCount++;
      shadowRoots.push(r);
      changed();
      return r;
    }
    animate(keyframes, options) { var a = new Animation(new KeyframeEffect(this, keyframes, options)); a.play(); return a; }
    // (the relevant ones: running, paused or filling, Web Animations 1 5.6)
    getAnimations() { return (this._waapi || []).filter(animationRelevant); }
    requestPointerLock() {}
    setPointerCapture(id) { this._capture = id; }
    releasePointerCapture(id) { this._capture = undefined; }
    hasPointerCapture(id) { return this._capture === id; }
    toString() { return '[object ' + (this.constructor.name || 'Element') + ']'; }
  }
  mixin(Element, ParentNode);

  class ShadowRoot extends DocumentFragment {
    constructor(host, init) { super(); this.host = host; this.mode = (init && init.mode) || 'open'; this.delegatesFocus = !!(init && init.delegatesFocus); this._adopted = []; }
    get adoptedStyleSheets() { return this._adopted; }
    set adoptedStyleSheets(v) { this._adopted = Array.from(v || []); changed(); }
    get activeElement() {
      var a = doc && doc._active;
      for (; a; a = shadowRootOf(a) ? shadowRootOf(a).host : null) if (shadowRootOf(a) === this) return a;
      return null;
    }
    get styleSheets() { var out = []; eachElement(this, function (e) { if (e.localName === 'style' && e.namespaceURI === HTML_NS) out.push(sheetOfStyle(e)); }); return out; }
    elementFromPoint(x, y) { var e = hitTest(x, y); for (; e; e = shadowRootOf(e) ? shadowRootOf(e).host : null) if (shadowRootOf(e) === this) return e; return null; }
    get innerHTML() { return serializeChildren(this); }
    set innerHTML(v) { removeAll(this); this.appendChild(parseFragment(String(v), null)); }
  }

  class HTMLElement extends Element {
    // (a custom element's class calls super() with no name: its name is the
    // one it was defined with)
    // (an upgrade, customElements.define of a name already in the page:
    // the class's constructor gets the element that is there, HTML 4.13.5)
    constructor(qname) {
      if (qname === undefined && upgrading) { var u = upgrading; upgrading = null; return u; }
      super(qname === undefined ? customName(new.target) : qname, HTML_NS);
    }
    // (made the first time it is asked for: a Proxy and its handler's
    // seven functions for every element were a third of a 10 000-row
    // table's objects)
    get dataset() { return this._ds || (this._ds = datasetOf(this)); }
    get title() { return this.getAttribute('title') || ''; }
    set title(v) { this.setAttribute('title', v); }
    get lang() { return this.getAttribute('lang') || ''; }
    set lang(v) { this.setAttribute('lang', v); }
    get dir() { return this.getAttribute('dir') || ''; }
    set dir(v) { this.setAttribute('dir', v); }
    get popover() { var v = this.getAttribute('popover'); return v === null ? null : (v === 'manual' || v === 'hint' ? v : 'auto'); }
    set popover(v) { if (v === null || v === undefined) this.removeAttribute('popover'); else this.setAttribute('popover', String(v)); }
    showPopover() {
      if (!this.hasAttribute('popover')) throw new DOMException('Not a popover', 'NotSupportedError');
      if (this._popOpen) return;
      this._popOpen = true; topAdd(this);
    }
    hidePopover() {
      if (!this._popOpen) return;
      this._popOpen = false; topRemove(this);
    }
    togglePopover(force) {
      var on = force === undefined ? !this._popOpen : !!force;
      if (on) this.showPopover(); else this.hidePopover();
      return !!this._popOpen;
    }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { this.toggleAttribute('hidden', !!v); }
    get inert() { return this.hasAttribute('inert'); }
    set inert(v) { this.toggleAttribute('inert', !!v); }
    get tabIndex() {
      var t = this.getAttribute('tabindex');
      if (t !== null && /^-?\d+$/.test(t.trim())) return parseInt(t, 10);
      return focusableByDefault(this) ? 0 : -1;
    }
    set tabIndex(v) { this.setAttribute('tabindex', String(v | 0)); }
    get accessKey() { return this.getAttribute('accesskey') || ''; }
    get draggable() { return this.getAttribute('draggable') === 'true'; }
    set draggable(v) { this.setAttribute('draggable', v ? 'true' : 'false'); }
    get contentEditable() { return this.getAttribute('contenteditable') || 'inherit'; }
    set contentEditable(v) { this.setAttribute('contenteditable', v); }
    get isContentEditable() { for (var n = this; n && n.nodeType === 1; n = n.parentNode) { var c = n.getAttribute('contenteditable'); if (c === '' || c === 'true') return true; if (c === 'false') return false; } return false; }
    get spellcheck() { return this.getAttribute('spellcheck') !== 'false'; }
    set spellcheck(v) { this.setAttribute('spellcheck', v ? 'true' : 'false'); }
    get innerText() { return innerTextOf(this); }
    set innerText(v) { this.textContent = v; }
    get outerText() { return this.innerText; }
    get offsetParent() { for (var n = this.parentNode; n && n.nodeType === 1; n = n.parentNode) { var p = computedOf(n).position; if (p && p !== 'static') return n; } return doc ? doc.body : null; }
    get offsetTop() { var r = rectOf(this), p = this.offsetParent; return r.top - (p && p !== this ? rectOf(p).top : 0); }
    get offsetLeft() { var r = rectOf(this), p = this.offsetParent; return r.left - (p && p !== this ? rectOf(p).left : 0); }
    get offsetWidth() { return Math.round(layoutSize(this)[0]); }
    get offsetHeight() { return Math.round(layoutSize(this)[1]); }
    focus(opts) { focusElement(this, opts); }
    blur() { if (doc && doc._active === this) focusElement(null); }
    click() {
      if (this.disabled) return;
      var ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: G, detail: 1 });
      activatedClick(this, ev);
    }
  }

  function datasetOf(el) {
    function name(k) { return 'data-' + String(k).replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }
    return new Proxy({}, {
      get: function (t, k) { if (typeof k !== 'string') return undefined; var v = el.getAttribute(name(k)); return v === null ? undefined : v; },
      set: function (t, k, v) { el.setAttribute(name(k), v); return true; },
      deleteProperty: function (t, k) { el.removeAttribute(name(k)); return true; },
      has: function (t, k) { return el.hasAttribute(name(k)); },
      ownKeys: function () { return el._attrs.filter(function (a) { return a.name.slice(0, 5) === 'data-'; }).map(function (a) { return camel(a.name.slice(5)); }); },
      getOwnPropertyDescriptor: function (t, k) { var v = el.getAttribute(name(k)); return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true }; }
    });
  }

  function reflect(cls, props) {
    // string attributes as properties
    props.forEach(function (p) {
      var a = p.toLowerCase();
      Object.defineProperty(cls.prototype, p, {
        get: function () { return this.getAttribute(a) || ''; },
        set: function (v) { this.setAttribute(a, v); },
        configurable: true, enumerable: true
      });
    });
  }
  function reflectBool(cls, props) {
    props.forEach(function (p) {
      var a = p.toLowerCase();
      Object.defineProperty(cls.prototype, p, {
        get: function () { return this.hasAttribute(a); },
        set: function (v) { this.toggleAttribute(a, !!v); },
        configurable: true, enumerable: true
      });
    });
  }
  function urlProp(cls, props) {
    props.forEach(function (p) {
      var a = p.toLowerCase();
      Object.defineProperty(cls.prototype, p, {
        get: function () { var v = this.getAttribute(a); return v === null ? '' : resolveURL(v); },
        set: function (v) { this.setAttribute(a, v); },
        configurable: true, enumerable: true
      });
    });
  }

  class HTMLDivElement extends HTMLElement {}
  class HTMLSpanElement extends HTMLElement {}
  class HTMLParagraphElement extends HTMLElement {}
  class HTMLHeadingElement extends HTMLElement {}
  class HTMLPreElement extends HTMLElement {}
  class HTMLQuoteElement extends HTMLElement {}
  class HTMLBRElement extends HTMLElement {}
  class HTMLHRElement extends HTMLElement {}
  class HTMLUListElement extends HTMLElement {}
  class HTMLOListElement extends HTMLElement {}
  class HTMLLIElement extends HTMLElement {}
  class HTMLDListElement extends HTMLElement {}
  class HTMLTableElement extends HTMLElement {
    get rows() {
      var t = this;
      return liveCollection(function () {
        var out = [], sec = { thead: [], tbody: [], tfoot: [] };
        t.children.forEach(function (c) {
          if (c.localName === 'tr') sec.tbody.push(c);
          else if (sec[c.localName]) c.children.forEach(function (r) { if (r.localName === 'tr') sec[c.localName].push(r); });
        });
        return out.concat(sec.thead, sec.tbody, sec.tfoot);
      });
    }
    get tBodies() { var t = this; return liveCollection(function () { return t.children.filter(function (c) { return c.localName === 'tbody'; }); }); }
  }
  class HTMLTableSectionElement extends HTMLElement { get rows() { var t = this; return liveCollection(function () { return t.children.filter(function (c) { return c.localName === 'tr'; }); }); } }
  class HTMLTableRowElement extends HTMLElement { get cells() { return NodeList(this.children.filter(function (c) { return c.localName === 'td' || c.localName === 'th'; })); } }
  class HTMLTableCellElement extends HTMLElement {
    get colSpan() { return parseInt(this.getAttribute('colspan') || '1', 10) || 1; }
    set colSpan(v) { this.setAttribute('colspan', v); }
    get rowSpan() { return parseInt(this.getAttribute('rowspan') || '1', 10) || 1; }
    set rowSpan(v) { this.setAttribute('rowspan', v); }
  }
  class HTMLTableColElement extends HTMLElement {}
  class HTMLTableCaptionElement extends HTMLElement {}
  class HTMLHtmlElement extends HTMLElement {}
  class HTMLHeadElement extends HTMLElement {}
  class HTMLBodyElement extends HTMLElement {}
  class HTMLTitleElement extends HTMLElement {
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
  }
  class HTMLMetaElement extends HTMLElement {}
  reflect(HTMLMetaElement, ['name', 'content', 'charset']);
  class HTMLBaseElement extends HTMLElement {}
  class HTMLStyleElement extends HTMLElement {
    constructor(q) { super(q); this._sheet = null; }
    get sheet() { return this.isConnected ? sheetOfStyle(this) : null; }
    // (HTML 4.2.6: the element's disabled is its sheet's)
    get disabled() { var sh = this.sheet; return sh ? sh.disabled : false; }
    set disabled(v) { var sh = this.sheet; if (sh) sh.disabled = v; }
    // (one with no text yet has no rules: PrimeReact puts each component's
    // <style> in empty and gives it its text after, and an empty one for
    // its focus trap when a dialog opens: the whole page was styled again)
    _connected() { if (this._c.length) styleSheetChanged(this, null); }
    _disconnected() { if (this._c.length) styleSheetChanged(this, this._sheet); }
  }
  reflect(HTMLStyleElement, ['media', 'type']);
  class HTMLLinkElement extends HTMLElement {
    get sheet() { return null; }
    get relList() { return new DOMTokenList(this, 'rel'); }
  }
  reflect(HTMLLinkElement, ['rel', 'type', 'media', 'as', 'crossOrigin', 'integrity']);
  urlProp(HTMLLinkElement, ['href']);
  class HTMLScriptElement extends HTMLElement {
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
    _connected() { if (this._parser) return; scriptInserted(this); }
  }
  reflect(HTMLScriptElement, ['type', 'charset', 'crossOrigin', 'integrity', 'nonce']);
  reflectBool(HTMLScriptElement, ['async', 'defer', 'noModule']);
  urlProp(HTMLScriptElement, ['src']);
  class HTMLAnchorElement extends HTMLElement {
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
    get relList() { return new DOMTokenList(this, 'rel'); }
  }
  reflect(HTMLAnchorElement, ['target', 'rel', 'download', 'hreflang', 'type', 'referrerPolicy']);
  urlProp(HTMLAnchorElement, ['href']);
  ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(function (k) {
    Object.defineProperty(HTMLAnchorElement.prototype, k, { get: function () { var u = parseURL(this.href); return u ? u[k] : ''; }, configurable: true });
  });
  class HTMLImageElement extends HTMLElement {
    constructor(q) { super(q); this.complete = true; }
    // (the picture's own size where its data says it, a data: URL's SVG,
    // PNG or GIF; else the laid-out box)
    get naturalWidth() { var n = intrinsicOf(this.getAttribute('src')); return n ? n[0] : this.width; }
    get naturalHeight() { var n = intrinsicOf(this.getAttribute('src')); return n ? n[1] : this.height; }
    get width() { var a = this.getAttribute('width'); return a !== null ? parseInt(a, 10) || 0 : rectOf(this).width; }
    set width(v) { this.setAttribute('width', v); }
    get height() { var a = this.getAttribute('height'); return a !== null ? parseInt(a, 10) || 0 : rectOf(this).height; }
    set height(v) { this.setAttribute('height', v); }
    get currentSrc() { return this.src; }
    decode() { return Promise.resolve(); }
    _connected() {
      var self = this;
      if (this.getAttribute('src')) setTimeout(function () { dispatch(self, new Event('load')); }, 0);
    }
  }
  reflect(HTMLImageElement, ['alt', 'srcset', 'sizes', 'crossOrigin', 'useMap', 'loading', 'decoding', 'referrerPolicy']);
  urlProp(HTMLImageElement, ['src']);
  // an image out of the page loads all the same (new Image(), as Radix's
  // Avatar does to know whether to show the picture or its fallback)
  (function () {
    var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: d.get,
      set: function (v) {
        d.set.call(this, v);
        if (this.isConnected || !String(v)) return;
        var self = this;
        self.complete = false;
        setTimeout(function () { self.complete = true; dispatch(self, new Event('load')); }, 0);
      },
      configurable: true, enumerable: true
    });
  })();
  var intrinsicMemo = { src: null, v: null };
  function intrinsicOf(src) {
    if (!src || src.slice(0, 5) !== 'data:') return null;
    if (intrinsicMemo.src === src) return intrinsicMemo.v;
    var v = null;
    try {
      var comma = src.indexOf(','), head = src.slice(5, comma), body = src.slice(comma + 1);
      var b64 = /;base64$/i.test(head);
      if (/^image\/svg\+xml/i.test(head)) {
        var t = b64 ? atob(body) : decodeURIComponent(body);
        var m = /<svg\b[^>]*>/i.exec(t);
        if (m) {
          var w = /\swidth\s*=\s*["']?([\d.]+)(px)?["'\s>]/i.exec(m[0]), h = /\sheight\s*=\s*["']?([\d.]+)(px)?["'\s>]/i.exec(m[0]);
          var vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(m[0]);
          var W = w ? +w[1] : 0, H = h ? +h[1] : 0;
          if (vb && (!W || !H)) { var vw = +vb[1], vh = +vb[2]; if (!W && !H) { W = vw; H = vh; } else if (!W) W = vh ? H * vw / vh : 0; else H = vw ? W * vh / vw : 0; }
          if (!W && !H) { W = 300; H = 150; }
          v = [Math.round(W), Math.round(H)];
        }
      } else if (b64) {
        var bin = atob(body.slice(0, 64));
        var u8 = function (i) { return bin.charCodeAt(i) & 255; };
        if (bin.slice(1, 4) === 'PNG') v = [(u8(16) << 24 | u8(17) << 16 | u8(18) << 8 | u8(19)) >>> 0, (u8(20) << 24 | u8(21) << 16 | u8(22) << 8 | u8(23)) >>> 0];
        else if (bin.slice(0, 3) === 'GIF') v = [u8(6) | u8(7) << 8, u8(8) | u8(9) << 8];
      }
    } catch (e) { v = null; }
    intrinsicMemo.src = src; intrinsicMemo.v = v;
    return v;
  }
  class HTMLIFrameElement extends HTMLElement {
    get contentWindow() { return null; }
    get contentDocument() { return null; }
  }
  reflect(HTMLIFrameElement, ['name', 'sandbox', 'allow', 'width', 'height']);
  urlProp(HTMLIFrameElement, ['src']);
  class HTMLCanvasElement extends HTMLElement {
    getContext(type, opts) { return canvasContext(this, type, opts); }
    toDataURL() { var c = this.getContext('2d'); return c._pixelMode() ? c._png() : 'data:,'; }
    toBlob(cb) { setTimeout(function () { cb(new Blob([], { type: 'image/png' })); }, 0); }
    get width() { return parseInt(this.getAttribute('width') || '300', 10); }
    set width(v) { this.setAttribute('width', v); if (this._ctx) this._ctx.reset(); }
    get height() { return parseInt(this.getAttribute('height') || '150', 10); }
    set height(v) { this.setAttribute('height', v); if (this._ctx) this._ctx.reset(); }
  }

  // ---- canvas 2D -----------------------------------------------------------
  //
  // A canvas keeps what is drawn on it as vector shapes, not pixels: each
  // fill and stroke is a path in the canvas's own coordinates (the current
  // transform applied), each fillText a run of text there. The render tree
  // gives a drawn canvas two kinds of children (canvasRender): one inline
  // SVG picture with the shapes, which the host draws with its SVG painter
  // as any <svg>, and the text runs as absolutely placed spans (the SVG
  // painter has no <text>). So a chart library draws through the same
  // display list as the rest of the page, and the native renderer needs
  // nothing new.
  //
  // Not kept as shapes: clipping (shapes are drawn whole), shadows,
  // compositing other than source-over, and the turn of rotated text (it is
  // drawn level at its place). A gradient paints the average of its stops.
  // Text is measured with Helvetica's advance widths (the window draws
  // Arial as Open Sans).
  //
  // Pixels: a canvas whose page reads or copies them (getImageData,
  // putImageData, drawImage, createPattern, toDataURL, or a context asked
  // for with willReadFrequently) turns into a bitmap for good, if the
  // engine has CErXes's rasterizer (__cerRaster, a premultiplied RGBA
  // Float64Array the context keeps). Its shapes so far are drawn into it,
  // and from then on each fill and stroke is a few numbers in a queue that
  // is drawn when the pixels are needed (read, copied, or the page
  // rendered); clipping, compositing, gradients and patterns are then
  // kept. The render tree gives it a PNG (made once per change) with the
  // text still as spans over it. A canvas that never reads pixels stays
  // vector shapes and costs nothing more.

  var CANVAS_W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
    667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556,
    500, 722, 500, 500, 500, 334, 260, 334, 584];
  function canvasFont(f) { return memo(fontMemo, String(f), parseCanvasFont); }
  function parseCanvasFont(f) {
    var o = { style: 'normal', weight: '400', size: 10, family: 'sans-serif', text: '10px sans-serif' };
    var m = /^\s*((?:[a-z-]+\s+|\d{3}\s+)*)([\d.]+)(px|pt|em|rem|%)(?:\s*\/\s*[^\s]+)?\s+(.+?)\s*$/i.exec(String(f));
    if (!m) return null;
    var size = parseFloat(m[2]), unit = m[3].toLowerCase();
    o.size = unit === 'pt' ? size * 4 / 3 : unit === 'em' || unit === 'rem' ? size * 16 : unit === '%' ? size * 0.16 : size;
    o.family = m[4];
    (m[1] || '').trim().split(/\s+/).forEach(function (t) {
      t = t.toLowerCase();
      if (t === 'italic' || t === 'oblique') o.style = t;
      else if (t === 'bold' || t === 'bolder') o.weight = '700';
      else if (t === 'lighter') o.weight = '300';
      else if (/^\d{3}$/.test(t)) o.weight = t;
    });
    o.text = (o.style !== 'normal' ? o.style + ' ' : '') + (o.weight !== '400' ? (o.weight === '700' ? 'bold ' : o.weight + ' ') : '') + fmtNum(o.size) + 'px ' + o.family;
    return o;
  }
  function canvasTextWidth(s, font) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 32 && c <= 126) w += CANVAS_W[c - 32];
      else if (c >= 0xc0 && c <= 0x24f) {
        // a Latin letter with a mark: as wide as the letter without it
        var base = s.charAt(i).normalize ? s.charAt(i).normalize('NFD').charCodeAt(0) : 0;
        w += base >= 32 && base <= 126 ? CANVAS_W[base - 32] : 556;
      } else if (c >= 0x2e80 && c <= 0x9fff || c >= 0xac00 && c <= 0xd7af || c >= 0xff00 && c <= 0xffef) w += 1000;
      else if (c >= 0xdc00 && c <= 0xdfff) continue;
      else w += 556;
    }
    w = w * font.size / 1000;
    if (parseInt(font.weight, 10) >= 600) w *= 1.06;
    return w;
  }
  function fmtNum(v) { return String(Math.round(v * 100) / 100); }
  // a paint as [#rrggbb, alpha], or null for none
  function canvasPaint(p) {
    if (p instanceof CanvasGradient) {
      if (!p._stops.length) return null;
      var r = 0, g = 0, b = 0, a = 0;
      for (var i = 0; i < p._stops.length; i++) { var q = p._stops[i][1]; r += q[0]; g += q[1]; b += q[2]; a += q[3]; }
      var n = p._stops.length;
      return rgbHex([r / n, g / n, b / n, a / n]);
    }
    if (typeof p !== 'string') return null;
    return memo(paintMemo, p, function (k) { var c = colorRGBA(k); return c ? rgbHex(c) : null; });
  }
  // a chart sets the same few colours and fonts for every shape: each
  // string is parsed once (the results are not changed by their users)
  var colorMemo = new Map(), fontMemo = new Map(), paintMemo = new Map();
  function memo(m, k, f) {
    var v = m.get(k);
    if (v === undefined) {
      if (m.size > 500) m.clear();
      v = f(k);
      m.set(k, v);
    }
    return v;
  }
  function colorRGBA(s) { return memo(colorMemo, String(s), parseRGBA); }
  function parseRGBA(s) {
    var m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(normalizeColor(s));
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  }
  function rgbHex(c) {
    var h = '#';
    for (var i = 0; i < 3; i++) { var v = Math.max(0, Math.min(255, Math.round(c[i]))); h += (v < 16 ? '0' : '') + v.toString(16); }
    return [h, c[3]];
  }
  class CanvasGradient {
    constructor(kind, geo) { this._stops = []; this._kind = kind || ''; this._geo = geo || []; }
    addColorStop(offset, color) {
      var c = colorRGBA(color);
      if (!c) throw new DOMException('The value provided (\'' + color + '\') could not be parsed as a color.', 'SyntaxError');
      this._stops.push([+offset, c]);
    }
  }
  class CanvasPattern {
    constructor(src, rep) {
      this._src = src || null; this._m = [1, 0, 0, 1, 0, 0];
      rep = rep === null || rep === undefined || rep === '' ? 'repeat' : String(rep);
      this._rx = rep === 'repeat' || rep === 'repeat-x'; this._ry = rep === 'repeat' || rep === 'repeat-y';
    }
    setTransform(m) { if (m) this._m = [m.a !== undefined ? m.a : 1, m.b || 0, m.c || 0, m.d !== undefined ? m.d : 1, m.e || 0, m.f || 0]; }
  }
  function canvasContext(el, type, opts) {
    if (String(type) !== '2d') return null;
    if (!el._ctx) {
      el._ctx = new CanvasRenderingContext2D(el);
      if (opts && opts.willReadFrequently) { el._ctx._wrf = true; el._ctx._pixelMode(); }
    }
    return el._ctx;
  }
  // a canvas's pixels as a source to draw from: a copy, or null when it
  // has none (no rasterizer, an <img>: pictures are not decoded here)
  function canvasSource(img) {
    if (img && img._px instanceof Float64Array) return { px: img._px, w: img.width, h: img.height };
    if (!(img instanceof HTMLCanvasElement || img instanceof OffscreenCanvas)) return null;
    var w = img.width, h = img.height, c = img._ctx;
    if (!w || !h || typeof __cerRaster !== 'function') return null;
    if (!c) return { px: new Float64Array(w * h * 4), w: w, h: h };
    if (!c._pixelMode()) return null;
    c._flush();
    return { px: c._px.slice(), w: w, h: h };
  }
  // the rasterizer's command codes (ComponentEngine cer/src/raster.rs)
  var COMPOSITE_OPS = { 'source-over': 0, 'source-in': 1, 'source-out': 2, 'source-atop': 3, 'destination-over': 4, 'destination-in': 5,
    'destination-out': 6, 'destination-atop': 7, lighter: 8, copy: 9, xor: 10 };
  var RASTER_PATH = { M: 1, L: 2, C: 3, Z: 5 };
  // a path's d (absolute M, L, C, Z, as CanvasPath writes it) as commands
  function rasterPath(q, d) {
    q.push(0);
    var re = /([MLCZ])([^MLCZ]*)/g, m;
    while ((m = re.exec(d))) {
      q.push(RASTER_PATH[m[1]]);
      if (m[1] === 'Z') continue;
      var a = m[2].trim().split(/[\s,]+/);
      for (var i = 0; i < a.length; i++) q.push(+a[i]);
    }
  }
  // an axis-aligned rectangle's d (CanvasPath.rect) as [x0, y0, x1, y1]
  function pathRect(d) {
    var m = /^M(\S+) (\S+)L(\S+) (\S+)L(\S+) (\S+)L(\S+) (\S+)Z$/.exec(d);
    if (!m) return null;
    var v = m.slice(1).map(Number);
    var across = v[1] === v[3] && v[2] === v[4] && v[5] === v[7] && v[6] === v[0];
    var down = v[0] === v[2] && v[3] === v[5] && v[4] === v[6] && v[7] === v[1];
    if (!across && !down) return null;
    return [Math.min(v[0], v[4]), Math.min(v[1], v[5]), Math.max(v[0], v[4]), Math.max(v[1], v[5])];
  }
  function invert(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function mul(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  }
  // an SVG path (Path2D's string) drawn into a CanvasPath through m
  function svgPathInto(p, m, str) {
    var t = String(str).match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    var i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0, prev = '';
    function num() { return +t[i++]; }
    while (i < t.length) {
      if (/[a-z]/i.test(t[i])) cmd = t[i++];
      var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
      if (C === 'Z') { p.close(); x = sx; y = sy; prev = C; continue; }
      if (i >= t.length || /[a-z]/i.test(t[i])) break;
      if (C === 'M') { x = ox + num(); y = oy + num(); p.moveTo(m, x, y); sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') { x = ox + num(); y = oy + num(); p.lineTo(m, x, y); }
      else if (C === 'H') { x = ox + num(); p.lineTo(m, x, y); }
      else if (C === 'V') { y = oy + num(); p.lineTo(m, x, y); }
      else if (C === 'C' || C === 'S') {
        var x1, y1;
        if (C === 'C') { x1 = ox + num(); y1 = oy + num(); } else if (prev === 'C' || prev === 'S') { x1 = 2 * x - cx; y1 = 2 * y - cy; } else { x1 = x; y1 = y; }
        cx = ox + num(); cy = oy + num(); x = ox + num(); y = oy + num();
        p.curve(m, x1, y1, cx, cy, x, y);
      } else if (C === 'Q' || C === 'T') {
        if (C === 'Q') { qx = ox + num(); qy = oy + num(); } else if (prev === 'Q' || prev === 'T') { qx = 2 * x - qx; qy = 2 * y - qy; } else { qx = x; qy = y; }
        x = ox + num(); y = oy + num();
        p.quad(m, qx, qy, x, y);
      } else if (C === 'A') {
        // an arc as the line to its end
        i += 5; x = ox + num(); y = oy + num(); p.lineTo(m, x, y);
      } else break;
      prev = C;
    }
  }
  class ImageData {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c || a.length / 4 / b; }
      this.colorSpace = 'srgb';
    }
  }
  class TextMetrics {
    constructor(w, size, align) {
      this.width = w;
      this.actualBoundingBoxLeft = align === 'center' ? w / 2 : align === 'right' || align === 'end' ? w : 0;
      this.actualBoundingBoxRight = w - this.actualBoundingBoxLeft;
      this.actualBoundingBoxAscent = size * 0.716;
      this.actualBoundingBoxDescent = size * 0.016;
      this.fontBoundingBoxAscent = size * 0.905;
      this.fontBoundingBoxDescent = size * 0.212;
      this.emHeightAscent = size * 0.81;
      this.emHeightDescent = size * 0.19;
      this.alphabeticBaseline = 0;
      this.hangingBaseline = size * 0.65;
      this.ideographicBaseline = -size * 0.19;
    }
  }
  // the transform of a context, a DOMMatrix's 2D part
  function matrixOf(m) {
    return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5], m11: m[0], m12: m[1], m21: m[2], m22: m[3], m41: m[4], m42: m[5], is2D: true,
      isIdentity: m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 };
  }
  // a path in canvas coordinates (SVG path data), built with the
  // transform at the time of each call
  class CanvasPath {
    constructor() { this.d = []; this.cur = null; this.start = null; this.user = null; }
    pt(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
    moveTo(m, x, y) { var p = this.pt(m, x, y); this.d.push('M' + fmtNum(p[0]) + ' ' + fmtNum(p[1])); this.cur = p; this.start = p; this.user = [x, y]; }
    lineTo(m, x, y) {
      if (!this.cur) { this.moveTo(m, x, y); return; }
      var p = this.pt(m, x, y);
      this.d.push('L' + fmtNum(p[0]) + ' ' + fmtNum(p[1])); this.cur = p; this.user = [x, y];
    }
    curve(m, x1, y1, x2, y2, x, y) {
      if (!this.cur) this.moveTo(m, x1, y1);
      var a = this.pt(m, x1, y1), b = this.pt(m, x2, y2), p = this.pt(m, x, y);
      this.d.push('C' + fmtNum(a[0]) + ' ' + fmtNum(a[1]) + ' ' + fmtNum(b[0]) + ' ' + fmtNum(b[1]) + ' ' + fmtNum(p[0]) + ' ' + fmtNum(p[1]));
      this.cur = p; this.user = [x, y];
    }
    quad(m, cx, cy, x, y) {
      if (!this.cur) this.moveTo(m, cx, cy);
      var u = this.user;
      this.curve(m, u[0] + 2 / 3 * (cx - u[0]), u[1] + 2 / 3 * (cy - u[1]), x + 2 / 3 * (cx - x), y + 2 / 3 * (cy - y), x, y);
    }
    close() { if (this.cur) { this.d.push('Z'); this.cur = this.start; } }
    rect(m, x, y, w, h) { this.moveTo(m, x, y); this.lineTo(m, x + w, y); this.lineTo(m, x + w, y + h); this.lineTo(m, x, y + h); this.close(); this.user = [x, y]; }
    // an elliptical arc as cubic Béziers of at most a quarter turn
    ellipse(m, x, y, rx, ry, rot, a0, a1, ccw) {
      if (rx < 0 || ry < 0) throw new DOMException('The radius provided is negative.', 'IndexSizeError');
      var T = Math.PI * 2, sweep = a1 - a0;
      if (!ccw && sweep >= T || ccw && -sweep >= T) sweep = ccw ? -T : T;
      else if (!ccw) { sweep = sweep % T; if (sweep < 0) sweep += T; }
      else { sweep = sweep % T; if (sweep > 0) sweep -= T; }
      var cr = Math.cos(rot), sr = Math.sin(rot);
      function at(t) { var ex = rx * Math.cos(t), ey = ry * Math.sin(t); return [x + ex * cr - ey * sr, y + ex * sr + ey * cr]; }
      function tan(t) { var ex = -rx * Math.sin(t), ey = ry * Math.cos(t); return [ex * cr - ey * sr, ex * sr + ey * cr]; }
      var p0 = at(a0);
      if (this.cur) this.lineTo(m, p0[0], p0[1]); else this.moveTo(m, p0[0], p0[1]);
      var n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)), step = sweep / n, k = 4 / 3 * Math.tan(step / 4);
      for (var i = 0; i < n; i++) {
        var t0 = a0 + i * step, t1 = t0 + step, s = at(t0), e = at(t1), d0 = tan(t0), d1 = tan(t1);
        this.curve(m, s[0] + k * d0[0], s[1] + k * d0[1], e[0] - k * d1[0], e[1] - k * d1[1], e[0], e[1]);
      }
    }
    arcTo(m, x1, y1, x2, y2, r) {
      if (!this.cur) { this.moveTo(m, x1, y1); return; }
      var x0 = this.user[0], y0 = this.user[1];
      var ax = x0 - x1, ay = y0 - y1, bx = x2 - x1, by = y2 - y1;
      var la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      var cross = ax * by - ay * bx;
      if (!r || !la || !lb || Math.abs(cross) < 1e-9) { this.lineTo(m, x1, y1); return; }
      var cos = (ax * bx + ay * by) / (la * lb), half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
      var dist = r / Math.tan(half);
      var t0 = [x1 + ax / la * dist, y1 + ay / la * dist], t1 = [x1 + bx / lb * dist, y1 + by / lb * dist];
      var ux = ax / la + bx / lb, uy = ay / la + by / lb, ul = Math.hypot(ux, uy), cd = r / Math.sin(half);
      var cx = x1 + ux / ul * cd, cy = y1 + uy / ul * cd;
      this.lineTo(m, t0[0], t0[1]);
      this.ellipse(m, cx, cy, r, r, 0, Math.atan2(t0[1] - cy, t0[0] - cx), Math.atan2(t1[1] - cy, t1[0] - cx), cross > 0);
    }
    roundRect(m, x, y, w, h, radii) {
      var r = Array.isArray(radii) ? radii : [radii === undefined ? 0 : radii];
      var rr = r.map(function (v) { return typeof v === 'object' && v ? +v.x || 0 : +v || 0; });
      var tl = rr[0], tr = rr.length > 1 ? rr[1] : tl, br = rr.length > 2 ? rr[2] : tl, bl = rr.length > 3 ? rr[3] : tr;
      if (rr.length === 2) { br = tl; bl = tr; }
      if (rr.length === 3) bl = tr;
      var H = Math.PI / 2;
      this.moveTo(m, x + tl, y);
      this.lineTo(m, x + w - tr, y); if (tr) this.ellipse(m, x + w - tr, y + tr, tr, tr, 0, -H, 0, false);
      this.lineTo(m, x + w, y + h - br); if (br) this.ellipse(m, x + w - br, y + h - br, br, br, 0, 0, H, false);
      this.lineTo(m, x + bl, y + h); if (bl) this.ellipse(m, x + bl, y + h - bl, bl, bl, 0, H, Math.PI, false);
      this.lineTo(m, x, y + tl); if (tl) this.ellipse(m, x + tl, y + tl, tl, tl, 0, Math.PI, Math.PI * 1.5, false);
      this.close();
    }
  }
  // the path methods of a context and of Path2D
  var PATH_OPS = {
    moveTo: function (p, m, a) { p.moveTo(m, +a[0], +a[1]); },
    lineTo: function (p, m, a) { p.lineTo(m, +a[0], +a[1]); },
    bezierCurveTo: function (p, m, a) { p.curve(m, +a[0], +a[1], +a[2], +a[3], +a[4], +a[5]); },
    quadraticCurveTo: function (p, m, a) { p.quad(m, +a[0], +a[1], +a[2], +a[3]); },
    closePath: function (p) { p.close(); },
    rect: function (p, m, a) { p.rect(m, +a[0], +a[1], +a[2], +a[3]); },
    roundRect: function (p, m, a) { p.roundRect(m, +a[0], +a[1], +a[2], +a[3], a[4]); },
    arc: function (p, m, a) { p.ellipse(m, +a[0], +a[1], +a[2], +a[2], 0, +a[3], +a[4], !!a[5]); },
    ellipse: function (p, m, a) { p.ellipse(m, +a[0], +a[1], +a[2], +a[3], +a[4], +a[5], +a[6], !!a[7]); },
    arcTo: function (p, m, a) { p.arcTo(m, +a[0], +a[1], +a[2], +a[3], +a[4]); }
  };
  class Path2D {
    constructor(from) {
      this._ops = [];
      if (from instanceof Path2D) this._ops = from._ops.slice();
      else if (typeof from === 'string') this._ops.push(['svg', from]);
    }
    addPath(p) { if (p instanceof Path2D) this._ops = this._ops.concat(p._ops); }
  }
  Object.keys(PATH_OPS).forEach(function (k) { Path2D.prototype[k] = function () { this._ops.push([k, Array.prototype.slice.call(arguments)]); }; });
  var CANVAS_STATE = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0,
    globalAlpha: 1, globalCompositeOperation: 'source-over', font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', direction: 'inherit',
    letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto', fontStretch: 'normal', fontVariantCaps: 'normal', textRendering: 'auto',
    shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true, imageSmoothingQuality: 'low', filter: 'none' };
  class CanvasRenderingContext2D {
    constructor(canvas) { this.canvas = canvas; this.reset(); }
    reset() {
      this._s = {};
      for (var k in CANVAS_STATE) this._s[k] = CANVAS_STATE[k];
      this._s.dash = [];
      this._s.m = [1, 0, 0, 1, 0, 0];
      this._s.fontParsed = canvasFont(CANVAS_STATE.font);
      this._stack = [];
      this._path = new CanvasPath();
      this._items = [];
      if (this._px || this._wrf) { this._px = null; this._pixelMode(); }
      this._drawn();
    }
    // a drawing changes only the canvas's own rendering (it and its
    // ancestors render again, no style changes)
    _drawn() { this._v = (this._v || 0) + 1; var c = this.canvas; if (c && c.nodeType === 1) textChanged(c); else generation++; }
    getContextAttributes() { return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: !!this._wrf }; }
    save() { var c = {}; for (var k in this._s) c[k] = this._s[k]; c.m = this._s.m.slice(); c.dash = this._s.dash.slice(); this._stack.push(c); }
    restore() {
      if (!this._stack.length) return;
      if (this._px && this._stack[this._stack.length - 1].clip !== this._s.clip) this._flush();
      this._s = this._stack.pop();
    }
    isContextLost() { return false; }
    // transforms
    transform(a, b, c, d, e, f) {
      var m = this._s.m;
      if (![a, b, c, d, e, f].every(isFinite)) return;
      this._s.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
    }
    setTransform(a, b, c, d, e, f) {
      if (a && typeof a === 'object') { var o = a; this._s.m = [o.a !== undefined ? o.a : 1, o.b || 0, o.c || 0, o.d !== undefined ? o.d : 1, o.e || 0, o.f || 0]; return; }
      if (a === undefined) { this._s.m = [1, 0, 0, 1, 0, 0]; return; }
      if (![a, b, c, d, e, f].every(isFinite)) return;
      this._s.m = [+a, +b, +c, +d, +e, +f];
    }
    resetTransform() { this._s.m = [1, 0, 0, 1, 0, 0]; }
    getTransform() { return matrixOf(this._s.m); }
    translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
    scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
    rotate(a) { var c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
    // paint and line styles
    get fillStyle() { return this._s.fillStyle; }
    set fillStyle(v) { this._s.fillStyle = this._style(v, this._s.fillStyle); }
    get strokeStyle() { return this._s.strokeStyle; }
    set strokeStyle(v) { this._s.strokeStyle = this._style(v, this._s.strokeStyle); }
    _style(v, old) {
      if (v instanceof CanvasGradient || v instanceof CanvasPattern) return v;
      var c = colorRGBA(v);
      if (!c) return old;
      return c[3] === 1 ? rgbHex(c)[0] : 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + c[3] + ')';
    }
    get font() { return this._s.font; }
    set font(v) { var f = canvasFont(v); if (f) { this._s.font = f.text; this._s.fontParsed = f; } }
    setLineDash(a) { if (!Array.isArray(a) || !a.every(function (x) { return isFinite(x) && x >= 0; })) return; this._s.dash = a.length % 2 ? a.concat(a) : a.slice(); }
    getLineDash() { return this._s.dash.slice(); }
    createLinearGradient(x0, y0, x1, y1) { return new CanvasGradient('linear', [+x0, +y0, +x1, +y1]); }
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      if (r0 < 0 || r1 < 0) throw new DOMException('The radius provided is negative.', 'IndexSizeError');
      return new CanvasGradient('radial', [+x0, +y0, +r0, +x1, +y1, +r1]);
    }
    createConicGradient() { return new CanvasGradient(); }
    createPattern(img, rep) {
      this._pixelMode();
      var src = canvasSource(img);
      var p = new CanvasPattern(src, rep);
      if (src && src.px === img._px) p._src = { px: src.px.slice(), w: src.w, h: src.h };
      return p;
    }
    // paths
    beginPath() { this._path = new CanvasPath(); }
    _pathOf(p) {
      if (!(p instanceof Path2D)) return this._path;
      var out = new CanvasPath(), m = this._s.m;
      for (var i = 0; i < p._ops.length; i++) {
        var op = p._ops[i];
        if (op[0] === 'svg') { svgPathInto(out, m, op[1]); continue; }
        PATH_OPS[op[0]](out, m, op[1]);
      }
      return out;
    }
    fill(a, b) {
      var p = this._pathOf(a), rule = typeof a === 'string' ? a : b;
      if (this._px) { if (p.d.length) this._rdraw(p.d.join(''), this._s.fillStyle, [10, rule === 'evenodd' ? 1 : 0]); return; }
      var paint = canvasPaint(this._s.fillStyle);
      if (!p.d.length || !paint) return;
      this._items.push({ d: p.d.join(''), fill: paint[0], alpha: paint[1] * this._s.globalAlpha, rule: rule === 'evenodd' ? 'evenodd' : '' });
      this._drawn();
    }
    stroke(a) {
      var p = this._pathOf(a), s = this._s, k = Math.sqrt(Math.abs(s.m[0] * s.m[3] - s.m[1] * s.m[2]));
      if (this._px) {
        if (!p.d.length || !(s.lineWidth > 0)) return;
        var tail = [12, s.dash.length, s.lineDashOffset * k].concat(s.dash.map(function (x) { return x * k; }));
        tail.push(11, s.lineWidth * k, s.lineCap === 'round' ? 1 : s.lineCap === 'square' ? 2 : 0, s.lineJoin === 'round' ? 1 : s.lineJoin === 'bevel' ? 2 : 0, s.miterLimit);
        this._rdraw(p.d.join(''), s.strokeStyle, tail);
        return;
      }
      var paint = canvasPaint(s.strokeStyle);
      if (!p.d.length || !paint || !(s.lineWidth > 0)) return;
      this._items.push({ d: p.d.join(''), stroke: paint[0], alpha: paint[1] * s.globalAlpha, width: s.lineWidth * k,
        dash: s.dash.length ? s.dash.map(function (x) { return fmtNum(x * k); }).join(' ') : '', dashOffset: s.lineDashOffset * k,
        cap: s.lineCap, join: s.lineJoin, miter: s.miterLimit });
      this._drawn();
    }
    clip(a, b) {
      if (!this._px) return;
      var p = this._pathOf(a), rule = typeof a === 'string' ? a : b, W = this._pw, H = this._ph;
      this._flush();
      // a rectangle (a chart's plot area) narrows the clip rectangle, no
      // mask; any other path makes a mask of the clip so far
      var d = p.d.join(''), cur = this._s.clip || { m: null, r: null }, r = pathRect(d);
      if (r && !cur.m) {
        if (cur.r) r = [Math.max(r[0], cur.r[0]), Math.max(r[1], cur.r[1]), Math.min(r[2], cur.r[2]), Math.min(r[3], cur.r[3])];
        this._s.clip = { m: null, r: r };
        return;
      }
      var q = [], c = new Float64Array(W * H);
      rasterPath(q, d);
      __cerRaster(1, c, W, H, new Float64Array(q), rule === 'evenodd' ? 1 : 0, cur.m || undefined, cur.r || undefined);
      this._s.clip = { m: c, r: null };
    }
    isPointInPath() { return false; }
    isPointInStroke() { return false; }
    fillRect(x, y, w, h) { var p = new CanvasPath(); p.rect(this._s.m, x, y, w, h); var keep = this._path; this._path = p; this.fill(); this._path = keep; }
    strokeRect(x, y, w, h) { var p = new CanvasPath(); p.rect(this._s.m, x, y, w, h); var keep = this._path; this._path = p; this.stroke(); this._path = keep; }
    clearRect(x, y, w, h) {
      // what is under a cleared rectangle that covers the canvas goes;
      // a smaller one cannot cut the shapes and keeps them
      var m = this._s.m, W = this.canvas.width, H = this.canvas.height;
      if (this._px) {
        var r = new CanvasPath(); r.rect(m, x, y, w, h);
        var q = this._q; rasterPath(q, r.d.join('')); q.push(13, 6, 20, 0, 0, 0, 1, 10, 0);
        if (!m[1] && !m[2] && Math.min(m[0] * x, m[0] * (x + w)) + m[4] <= 0 && Math.min(m[3] * y, m[3] * (y + h)) + m[5] <= 0 &&
          Math.max(m[0] * x, m[0] * (x + w)) + m[4] >= W && Math.max(m[3] * y, m[3] * (y + h)) + m[5] >= H) this._items = [];
        this._drawn();
        return;
      }
      if (m[1] || m[2]) return;
      var x0 = Math.min(m[0] * x + m[4], m[0] * (x + w) + m[4]), x1 = Math.max(m[0] * x + m[4], m[0] * (x + w) + m[4]);
      var y0 = Math.min(m[3] * y + m[5], m[3] * (y + h) + m[5]), y1 = Math.max(m[3] * y + m[5], m[3] * (y + h) + m[5]);
      if (x0 <= 0 && y0 <= 0 && x1 >= W && y1 >= H && this._items.length) { this._items = []; this._drawn(); }
    }
    // text
    measureText(t) { var f = this._s.fontParsed; return new TextMetrics(canvasTextWidth(String(t), f), f.size, this._s.textAlign); }
    _text(t, x, y, maxWidth, paintOf) {
      var s = this._s, f = s.fontParsed, paint = canvasPaint(paintOf);
      t = String(t).replace(/[\t\n\f\r]/g, ' ');
      if (!paint || !t || !isFinite(x) || !isFinite(y)) return;
      var w = canvasTextWidth(t, f), size = f.size;
      if (maxWidth !== undefined && maxWidth < w) { if (!(maxWidth > 0)) return; size = size * maxWidth / w; w = maxWidth; }
      var al = s.textAlign, rtl = s.direction === 'rtl';
      var left = al === 'center' ? x - w / 2 : al === 'right' || al === 'end' && !rtl || al === 'start' && rtl ? x - w : x;
      // the alphabetic baseline under y, from the em box
      var bl = s.textBaseline, base = bl === 'top' ? y + size * 0.81 : bl === 'hanging' ? y + size * 0.65 : bl === 'middle' ? y + size * 0.31 : bl === 'bottom' || bl === 'ideographic' ? y - size * 0.19 : y;
      var m = s.m, k = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
      var px = m[0] * left + m[2] * base + m[4], py = m[1] * left + m[3] * base + m[5];
      if (m[1] || m[2]) {
        // turned text: drawn level, centred where its middle would be
        var mx = left + w / 2, my = base - size * 0.31;
        var cx = m[0] * mx + m[2] * my + m[4], cy = m[1] * mx + m[3] * my + m[5];
        px = cx - w * k / 2; py = cy + size * k * 0.31;
      }
      this._items.push({ text: t, x: px, y: py, size: size * k, family: f.family, weight: f.weight, style: f.style, color: paint[0], alpha: paint[1] * s.globalAlpha });
      this._drawn();
    }
    fillText(t, x, y, maxWidth) { this._text(t, x, y, maxWidth, this._s.fillStyle); }
    strokeText(t, x, y, maxWidth) { this._text(t, x, y, maxWidth, this._s.strokeStyle); }
    // ---- pixels (see the note above)
    // turns the canvas into a bitmap, its shapes so far drawn in; false
    // without the rasterizer
    _pixelMode() {
      if (this._px) return true;
      if (typeof __cerRaster !== 'function') return false;
      var W = this.canvas.width, H = this.canvas.height;
      this._pw = W; this._ph = H;
      this._px = new Float64Array(W * H * 4); this._q = []; this._qi = [];
      var kept = [], q = this._q;
      for (var i = 0; i < this._items.length; i++) {
        var it = this._items[i], hex = it.fill || it.stroke;
        if (it.text !== undefined) { kept.push(it); continue; }
        rasterPath(q, it.d);
        q.push(13, 0, 20, parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, it.alpha);
        if (it.fill) q.push(10, it.rule ? 1 : 0);
        else {
          var dash = it.dash ? it.dash.split(' ').map(Number) : [];
          q.push(12, dash.length, it.dash ? it.dashOffset : 0);
          for (var j = 0; j < dash.length; j++) q.push(dash[j]);
          q.push(11, it.width, 0, 0, 10);
        }
      }
      this._items = kept;
      return true;
    }
    // one fill or stroke queued: the path, the composition, the paint and
    // what draws it (tail)
    _rdraw(d, style, tail) {
      var q = this._q, at = q.length, s = this._s;
      rasterPath(q, d);
      q.push(13, COMPOSITE_OPS[s.globalCompositeOperation] || 0);
      if (!this._rpaint(style)) { q.length = at; return; }
      for (var i = 0; i < tail.length; i++) q.push(tail[i]);
      this._drawn();
    }
    _rpaint(p) {
      var q = this._q, s = this._s, ga = s.globalAlpha, inv;
      if (typeof p === 'string') {
        var c = colorRGBA(p);
        if (!c) return false;
        q.push(20, c[0] / 255, c[1] / 255, c[2] / 255, c[3] * ga);
        return true;
      }
      if (p instanceof CanvasGradient) {
        if (!p._stops.length) return false;
        inv = invert(s.m);
        if (!p._kind || !inv) { var avg = canvasPaint(p); return this._rpaint('rgba(' + colorRGBA(avg[0]).slice(0, 3).join(',') + ',' + avg[1] + ')'); }
        var stops = p._stops.slice().sort(function (a, b) { return a[0] - b[0]; });
        q.push(p._kind === 'linear' ? 21 : 22, ga);
        q.push.apply(q, inv); q.push.apply(q, p._geo);
        q.push(stops.length);
        for (var i = 0; i < stops.length; i++) { var t = stops[i]; q.push(t[0], t[1][0] / 255, t[1][1] / 255, t[1][2] / 255, t[1][3]); }
        return true;
      }
      if (p instanceof CanvasPattern) {
        inv = invert(mul(s.m, p._m));
        if (!p._src || !inv) return false;
        var k = this._qi.push([p._src.px, p._src.w, p._src.h]) - 1;
        q.push(23, ga, k); q.push.apply(q, inv);
        q.push(p._rx ? 1 : 0, p._ry ? 1 : 0, s.imageSmoothingEnabled ? 1 : 0);
        return true;
      }
      return false;
    }
    // the queue drawn into the pixels
    _flush() {
      if (!this._px || !this._q.length) return;
      var q = this._q, imgs = this._qi;
      this._q = []; this._qi = [];
      var clip = this._s.clip;
      __cerRaster(0, this._px, this._pw, this._ph, new Float64Array(q), clip ? clip.m || undefined : undefined, imgs, clip ? clip.r || undefined : undefined);
    }
    // the pixels as a PNG data: URL, made again only after a change
    _png() {
      this._flush();
      if (this._pngV !== this._v) { this._pngU = __cerRaster(4, this._px, this._pw, this._ph); this._pngV = this._v; }
      return this._pngU;
    }
    drawImage(img) {
      var a = Array.prototype.slice.call(arguments, 1).map(Number);
      if (!this._pixelMode()) return;
      var src = canvasSource(img);
      if (!src) return;
      var sx = 0, sy = 0, sw = src.w, sh = src.h, dx, dy, dw = src.w, dh = src.h;
      if (a.length >= 8) { sx = a[0]; sy = a[1]; sw = a[2]; sh = a[3]; dx = a[4]; dy = a[5]; dw = a[6]; dh = a[7]; }
      else { dx = a[0]; dy = a[1]; if (a.length >= 4) { dw = a[2]; dh = a[3]; } }
      if (!sw || !sh || !dw || !dh || ![sx, sy, sw, sh, dx, dy, dw, dh].every(isFinite)) return;
      var s = this._s, inv = invert(mul(s.m, [dw / sw, 0, 0, dh / sh, dx - sx * dw / sw, dy - sy * dh / sh]));
      if (!inv) return;
      var r = new CanvasPath(); r.rect(s.m, dx, dy, dw, dh);
      var q = this._q, k = this._qi.push([src.px === img._px ? src.px.slice() : src.px, src.w, src.h]) - 1;
      rasterPath(q, r.d.join(''));
      q.push(13, COMPOSITE_OPS[s.globalCompositeOperation] || 0, 23, s.globalAlpha, k);
      q.push.apply(q, inv);
      q.push(0, 0, s.imageSmoothingEnabled ? 1 : 0, 10, 0);
      this._drawn();
    }
    createImageData(w, h) { return typeof w === 'object' ? new ImageData(w.width, w.height) : new ImageData(Math.abs(w), Math.abs(h)); }
    getImageData(x, y, w, h) {
      if (!w || !h) throw new DOMException('The source width is 0.', 'IndexSizeError');
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      x = Math.floor(x); y = Math.floor(y); w = Math.ceil(w); h = Math.ceil(h);
      var out = new ImageData(w, h);
      if (!this._pixelMode()) return out;
      this._flush();
      __cerRaster(2, this._px, this._pw, this._ph, x, y, w, h, out.data);
      return out;
    }
    putImageData(img, dx, dy, ox, oy, ow, oh) {
      if (!(img instanceof ImageData) || !this._pixelMode()) return;
      dx = Math.floor(dx); dy = Math.floor(dy);
      var data = img.data, iw = img.width, ih = img.height;
      if (ow !== undefined) {
        // the dirty rectangle: that part of the image only
        if (ow < 0) { ox += ow; ow = -ow; }
        if (oh < 0) { oy += oh; oh = -oh; }
        var x0 = Math.max(0, Math.floor(ox)), y0 = Math.max(0, Math.floor(oy)), x1 = Math.min(iw, Math.floor(ox + ow)), y1 = Math.min(ih, Math.floor(oy + oh));
        if (x1 <= x0 || y1 <= y0) return;
        var part = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
        for (var y = y0; y < y1; y++) part.set(data.subarray((y * iw + x0) * 4, (y * iw + x1) * 4), (y - y0) * (x1 - x0) * 4);
        data = part; dx += x0; dy += y0; iw = x1 - x0; ih = y1 - y0;
      }
      this._flush();
      __cerRaster(3, this._px, this._pw, this._ph, dx, dy, iw, ih, data);
      this._drawn();
    }
    drawFocusIfNeeded() {}
    scrollPathIntoView() {}
  }
  Object.keys(PATH_OPS).forEach(function (k) { CanvasRenderingContext2D.prototype[k] = function () { PATH_OPS[k](this._path, this._s.m, arguments); }; });
  Object.keys(CANVAS_STATE).forEach(function (k) {
    if (Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, k)) return;
    Object.defineProperty(CanvasRenderingContext2D.prototype, k, {
      get: function () { return this._s[k]; },
      set: function (v) {
        var d = CANVAS_STATE[k];
        if (typeof d === 'number') { v = +v; if (!isFinite(v) || (k === 'lineWidth' || k === 'miterLimit') && v <= 0 || k === 'globalAlpha' && (v < 0 || v > 1)) return; }
        else if (typeof d === 'boolean') v = !!v;
        else v = String(v);
        this._s[k] = v;
      },
      configurable: true, enumerable: true
    });
  });
  // a canvas of its own, not on the page (drawn into, never shown)
  class OffscreenCanvas extends EventTarget {
    constructor(w, h) { super(); this._w = w >>> 0; this._h = h >>> 0; this._ctx = null; }
    get width() { return this._w; }
    set width(v) { this._w = v >>> 0; if (this._ctx) this._ctx.reset(); }
    get height() { return this._h; }
    set height(v) { this._h = v >>> 0; if (this._ctx) this._ctx.reset(); }
    getContext(type, opts) { return canvasContext(this, type, opts); }
    convertToBlob() { return Promise.resolve(new Blob([], { type: 'image/png' })); }
    transferToImageBitmap() {
      var src = canvasSource(this), bm = { width: this._w, height: this._h, close: function () {} };
      if (src) { bm._px = src.px; if (this._ctx) this._ctx.reset(); }
      return bm;
    }
  }
  // a drawn canvas in the render tree: the shapes as one SVG picture, the
  // text as spans over it, in the box the canvas has on the page (its
  // pixels stretched to the CSS size, as a browser shows them)
  function canvasRender(n, o, cs) {
    var ctx = n._ctx, W = n.width, H = n.height;
    if (!ctx || !W || !H || !ctx._px && !ctx._items.length) return;
    var cw = /^[\d.]+px$/.test(cs.width || '') ? parseFloat(cs.width) : W, ch = /^[\d.]+px$/.test(cs.height || '') ? parseFloat(cs.height) : H;
    var kx = cw / W, ky = ch / H;
    var svg = '<svg xmlns="' + SVG_NS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">', texts = [];
    for (var i = 0; i < ctx._items.length; i++) {
      var it = ctx._items[i];
      if (it.text !== undefined) { texts.push(it); continue; }
      if (it.fill) svg += '<path d="' + it.d + '" fill="' + it.fill + '"' + (it.alpha < 1 ? ' fill-opacity="' + fmtNum(it.alpha) + '"' : '') + (it.rule ? ' fill-rule="evenodd"' : '') + ' stroke="none"/>';
      else svg += '<path d="' + it.d + '" fill="none" stroke="' + it.stroke + '" stroke-width="' + fmtNum(it.width) + '"' + (it.alpha < 1 ? ' stroke-opacity="' + fmtNum(it.alpha) + '"' : '') +
        (it.dash ? ' stroke-dasharray="' + it.dash + '"' + (it.dashOffset ? ' stroke-dashoffset="' + fmtNum(it.dashOffset) + '"' : '') : '') +
          (it.cap && it.cap !== 'butt' ? ' stroke-linecap="' + it.cap + '"' : '') + (it.join && it.join !== 'miter' ? ' stroke-linejoin="' + it.join + '"' : '') +
          (it.miter !== undefined && it.miter !== 4 ? ' stroke-miterlimit="' + fmtNum(it.miter) + '"' : '') + '/>';
    }
    svg += '</svg>';
    var box = { display: 'block', position: 'absolute', left: '0px', top: '0px', width: fmtNum(cw) + 'px', height: fmtNum(ch) + 'px' };
    var kids = [ctx._px ? { i: n.__id + 'c0', t: 'img', s: box, a: {}, png: ctx._png() } : { i: n.__id + 'c0', t: 'svg:svg', s: box, a: { viewBox: '0 0 ' + W + ' ' + H }, svg: svg }];
    for (var j = 0; j < texts.length; j++) {
      var t = texts[j], size = t.size * ky;
      var s = { display: 'block', position: 'absolute', left: fmtNum(t.x * kx) + 'px', top: fmtNum(t.y * ky - size * 0.89) + 'px', 'font-size': fmtNum(size) + 'px',
        'line-height': fmtNum(size) + 'px', 'font-family': t.family, color: t.alpha < 1 ? 'rgba(' + parseInt(t.color.slice(1, 3), 16) + ', ' + parseInt(t.color.slice(3, 5), 16) + ', ' + parseInt(t.color.slice(5, 7), 16) + ', ' + fmtNum(t.alpha) + ')' : normalizeColor(t.color),
        'white-space': 'pre' };
      if (t.weight !== '400') s['font-weight'] = t.weight;
      if (t.style !== 'normal') s['font-style'] = t.style;
      kids.push({ i: n.__id + 'c' + (j + 1), t: 'span', s: s, c: [{ i: n.__id + 'c' + (j + 1) + 't', x: t.text }] });
    }
    // (the picture in flow, so the canvas paints where an image would; its
    // texts over it need the canvas for their containing block)
    if (!texts.length) { box = { display: 'block', width: box.width, height: box.height }; kids[0].s = box; }
    else if (!o.s.position || o.s.position === 'static') o.s.position = 'relative';
    o.s.overflow = 'hidden';
    o.s['overflow-x'] = 'hidden';
    o.s['overflow-y'] = 'hidden';
    o.c = kids;
  }
  class HTMLMediaElement extends HTMLElement {
    play() { return Promise.resolve(); }
    pause() {}
    load() {}
    canPlayType() { return ''; }
  }
  class HTMLVideoElement extends HTMLMediaElement {}
  class HTMLAudioElement extends HTMLMediaElement {}
  class HTMLSourceElement extends HTMLElement {}
  class HTMLTemplateElement extends HTMLElement {
    constructor(q) { super(q); this._content = null; }
    get content() { return this._content || (this._content = (this.ownerDocument || doc).createDocumentFragment()); }
    get innerHTML() { return serializeChildren(this.content); }
    set innerHTML(v) { removeAll(this.content); this.content.appendChild(parseFragment(String(v), null)); }
  }
  class HTMLSlotElement extends HTMLElement {
    get name() { return this.getAttribute('name') || ''; }
    set name(v) { this.setAttribute('name', v); }
    assignedNodes(o) { return o && o.flatten ? flatten(this, []).filter(function (n) { return o.flatten || true; }) : slotted(this); }
    assignedElements(o) { return (o && o.flatten ? flatten(this, []) : slotted(this)).filter(function (n) { return n.nodeType === 1; }); }
  }
  class HTMLDialogElement extends HTMLElement {
    show() { this.open = true; }
    showModal() {
      if (this.open && this._modal) return;
      this.open = true; this._modal = true; topAdd(this);
      this._returnFocus = doc && doc._active;
      // dialog focusing steps: autofocus, else the first focusable, else the dialog
      var inside = [];
      tabWalk(this, inside, true);
      var af = inside.filter(function (e) { return e.hasAttribute('autofocus'); })[0] || inside[0];
      if (af) focusElement(af); else if (doc && doc._active && !composedContains(this, doc._active)) focusElement(null);
    }
    close(rv) { if (!this.open) return; if (this._modal) { this._modal = false; topRemove(this); } this.open = false; this.returnValue = rv === undefined ? this.returnValue : String(rv); var rf = this._returnFocus; this._returnFocus = null; if (rf && rf.isConnected && doc && (!doc._active || composedContains(this, doc._active))) focusElement(rf, { preventScroll: true }); var self = this; setTimeout(function () { dispatch(self, new Event('close')); }, 0); }
  }
  reflectBool(HTMLDialogElement, ['open']);
  class HTMLDetailsElement extends HTMLElement {}
  reflectBool(HTMLDetailsElement, ['open']);
  class HTMLLabelElement extends HTMLElement {
    get htmlFor() { return this.getAttribute('for') || ''; }
    set htmlFor(v) { this.setAttribute('for', v); }
    get control() {
      var f = this.getAttribute('for');
      if (f) return (this.ownerDocument || doc).getElementById(f);
      return this.querySelector('input,select,textarea,button');
    }
    get form() { return formOf(this); }
  }
  class HTMLFieldSetElement extends HTMLElement {}
  reflectBool(HTMLFieldSetElement, ['disabled']);
  class HTMLLegendElement extends HTMLElement {}
  class HTMLFormElement extends HTMLElement {
    // (and the form-associated custom elements in it, HTML 4.13.7)
    get elements() { var out = []; eachElement(this, function (e) { if (LISTED_RE.test(e.localName) || (e._internals && e.constructor.formAssociated)) out.push(e); }); return NodeList(out); }
    get length() { return this.elements.length; }
    submit() {}
    requestSubmit() {
      var ev = new Event('submit', { bubbles: true, cancelable: true });
      dispatch(this, ev);
    }
    reset() {
      // (the event first: a listener can cancel the reset, HTML 4.10.21.4)
      if (!dispatch(this, new Event('reset', { bubbles: true, cancelable: true }))) return;
      this.elements.forEach(function (e) {
        if (e.localName === 'select') { e.options.forEach(function (o) { o._selected = undefined; }); return; }
        if (e._checked !== undefined) e._checked = undefined;
        if (e.localName === 'input' && e.type === 'file') e._files = null;
        var was = e.value;
        if (e._value !== undefined) e._value = undefined;
        if (e._ss !== undefined && e.value !== was) { var l = e.value.length; e._ss = e._se = l; e._sd = 'none'; }
        e._dirty = false;
        valueChanged(e);
      });
      changed();
    }
    checkValidity() { return true; }
    reportValidity() { return true; }
  }
  reflect(HTMLFormElement, ['name', 'method', 'target', 'enctype', 'autocomplete']);
  urlProp(HTMLFormElement, ['action']);
  reflectBool(HTMLFormElement, ['noValidate']);

  var LISTED_RE = /^(input|select|textarea|button|fieldset|output|object)$/;
  function formOf(el) {
    var f = el.getAttribute('form');
    if (f) return (el.ownerDocument || doc).getElementById(f);
    for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'form') return n;
    return null;
  }

  var validity = { valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: false };

  class HTMLButtonElement extends HTMLElement {
    get type() { var t = (this.getAttribute('type') || '').toLowerCase(); return t === 'reset' || t === 'button' ? t : 'submit'; }
    set type(v) { this.setAttribute('type', v); }
    get form() { return formOf(this); }
    get labels() { return labelsOf(this); }
    get validity() { return validity; }
    checkValidity() { return true; }
    setCustomValidity() {}
  }
  reflect(HTMLButtonElement, ['name', 'value']);
  reflectBool(HTMLButtonElement, ['disabled', 'autofocus']);

  function labelsOf(el) {
    var out = [];
    var id = el.id;
    if (doc) eachElement(doc, function (l) { if (l.localName === 'label' && ((id && l.getAttribute('for') === id) || (!l.getAttribute('for') && l.contains(el)))) out.push(l); });
    return NodeList(out);
  }

  // a form control's value: its own (_value) once set, else the attribute
  class HTMLInputElement extends HTMLElement {
    constructor(q) { super(q); this._value = undefined; this._checked = undefined; this._ss = 0; this._se = 0; this._sd = 'none'; this.indeterminate = false; this._files = null; }
    get files() { return this.type === 'file' ? (this._files || (this._files = fileList([]))) : null; }
    set files(v) { if (this.type === 'file' && v) this._files = v; }
    get type() {
      var t = (this.getAttribute('type') || 'text').toLowerCase();
      return /^(hidden|text|search|tel|url|email|password|date|month|week|time|datetime-local|number|range|color|checkbox|radio|file|submit|image|reset|button)$/.test(t) ? t : 'text';
    }
    set type(v) { this.setAttribute('type', v); }
    get value() {
      var t = this.type;
      if (t === 'checkbox' || t === 'radio') { var a = this.getAttribute('value'); return a === null ? 'on' : a; }
      if (t === 'file') return this._files && this._files.length ? 'C:\\fakepath\\' + this._files[0].name : '';
      // (what the user typed is the value as it is; a set one, the
      // default, and a range's or colour's, whose bounds may change, go
      // through the type's sanitization)
      if (this._value !== undefined && !/^(range|color)$/.test(t)) return this._value;
      return sanitizeValue(this, this._value !== undefined ? this._value : this.getAttribute('value') || '');
    }
    set value(v) {
      v = v === null || v === undefined ? '' : String(v);
      var t = this.type;
      if (t === 'checkbox' || t === 'radio') { this.setAttribute('value', v); return; }
      if (t === 'file') { if (v !== '') throw new DOMException('This input element accepts a filename, which may only be programmatically set to the empty string.', 'InvalidStateError'); this._files = null; valueChanged(this); return; }
      var was = this.value;
      v = sanitizeValue(this, v);
      this._value = v;
      // (the caret goes to the end only when the value is another, HTML 4.10.5.4)
      if (v !== was) { this._ss = this._se = v.length; this._sd = 'none'; }
      valueChanged(this);
    }
    get defaultValue() { return this.getAttribute('value') || ''; }
    set defaultValue(v) { this.setAttribute('value', v); }
    get selectionStart() { return hasSelectionApi(this) ? this._ss : null; }
    set selectionStart(v) { selectionGuard(this); this.setSelectionRange(v, Math.max(v, this._se), this._sd); }
    get selectionEnd() { return hasSelectionApi(this) ? this._se : null; }
    set selectionEnd(v) { selectionGuard(this); this.setSelectionRange(Math.min(this._ss, v), v, this._sd); }
    get selectionDirection() { return hasSelectionApi(this) ? this._sd : null; }
    set selectionDirection(v) { selectionGuard(this); this.setSelectionRange(this._ss, this._se, v); }
    get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
    set checked(v) {
      // (a state change of this element, as a value's: AG Grid sets every
      // new row's checkbox, and each one styled the whole page again)
      var was = this.checked;
      this._checked = !!v;
      if (v && this.type === 'radio') { uncheckGroup(this); changed(); return; }
      if (was !== !!v) attrChanged(this);
    }
    get defaultChecked() { return this.hasAttribute('checked'); }
    set defaultChecked(v) { this.toggleAttribute('checked', !!v); }
    get valueAsNumber() { return valueAsNumberOf(this); }
    set valueAsNumber(n) {
      if (!/^(number|range|date|month|week|time|datetime-local)$/.test(this.type)) throw new DOMException('This input element does not support Number values.', 'InvalidStateError');
      this.value = formatNumberValue(this, +n);
    }
    get valueAsDate() { if (!/^(date|month|week|time)$/.test(this.type)) return null; var n = valueAsNumberOf(this); return isNaN(n) ? null : new Date(n); }
    set valueAsDate(d) {
      if (!/^(date|month|week|time)$/.test(this.type)) throw new DOMException('This input element does not support Date values.', 'InvalidStateError');
      this.value = d === null ? '' : formatNumberValue(this, this.type === 'month' ? (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth() : d.getTime());
    }
    get form() { return formOf(this); }
    get labels() { return labelsOf(this); }
    get validity() { return validity; }
    get validationMessage() { return ''; }
    get willValidate() { return true; }
    get list() { var l = this.getAttribute('list'); return l ? (this.ownerDocument || doc).getElementById(l) : null; }
    select() { if (!hasSelectionApi(this) && !/^(email|number|date|month|week|time|datetime-local|color)$/.test(this.type)) return; this._ss = 0; this._se = this.value.length; this._sd = 'none'; selectionChanged(this); }
    setSelectionRange(s, e, d) { selectionGuard(this); setSelection(this, s, e, d); }
    setRangeText(t, s, e, mode) { selectionGuard(this); rangeText(this, t, s, e, mode); }
    showPicker() {
      if (this.disabled || this.readOnly) throw new DOMException("Failed to execute 'showPicker' on 'HTMLInputElement': HTMLInputElement::showPicker() cannot be used on immutable controls.", 'InvalidStateError');
      if (this.type === 'file') askFiles(this); else popOpen(this);
    }
    stepUp(n) { stepValue(this, n === undefined ? 1 : +n); }
    stepDown(n) { stepValue(this, -(n === undefined ? 1 : +n)); }
  }
  reflect(HTMLInputElement, ['name', 'placeholder', 'accept', 'alt', 'autocomplete', 'dirName', 'inputMode', 'max', 'min', 'pattern', 'step', 'enterKeyHint']);
  reflectBool(HTMLInputElement, ['disabled', 'readOnly', 'required', 'multiple', 'autofocus']);
  ['maxLength', 'minLength', 'size'].forEach(function (p) {
    var a = p.toLowerCase();
    Object.defineProperty(HTMLInputElement.prototype, p, { get: function () { var v = this.getAttribute(a); return v === null ? (p === 'size' ? 20 : -1) : parseInt(v, 10); }, set: function (v) { this.setAttribute(a, v); }, configurable: true });
  });

  // the selection API is there for these types only (HTML 4.10.5.2): an
  // email, number or date field answers null and throws on a set
  function hasSelectionApi(el) { return el.localName === 'textarea' || /^(text|search|url|tel|password)$/.test(el.type); }
  function selectionGuard(el) { if (!hasSelectionApi(el)) throw new DOMException("Failed to execute 'setSelectionRange' on 'HTMLInputElement': The input element's type ('" + el.type + "') does not support selection.", 'InvalidStateError'); }
  // (a select event is queued, as a task, for each change of the selection
  // by the API: HTML 4.10.5.2.10)
  function selectionChanged(el) {
    // (the focused control renders again with its caret and selection; no
    // style follows from where they are)
    if (doc && doc._active === el) textChanged(el);
    if (el._selQueued) return;
    el._selQueued = true;
    setTimeout(function () { el._selQueued = false; dispatch(el, new Event('select', { bubbles: true })); }, 0);
  }
  function setSelection(el, s, e, d) {
    var l = el.value.length;
    s = Math.max(0, Math.min(+s || 0, l));
    e = e === undefined ? s : Math.max(0, Math.min(+e || 0, l));
    if (e < s) s = e;
    el._ss = s; el._se = e; el._sd = d === 'forward' || d === 'backward' ? d : 'none';
    selectionChanged(el);
  }
  function rangeText(el, t, s, e, mode) {
    var v = el.value, l = v.length;
    t = String(t);
    if (s === undefined) { s = el._ss; e = el._se; mode = 'preserve'; }
    s = Math.min(+s || 0, l); e = Math.min(+e || 0, l);
    if (s > e) throw new DOMException('The provided start value (' + s + ') is larger than the provided end value (' + e + ').', 'IndexSizeError');
    el._value = v.slice(0, s) + t + v.slice(e);
    var ss = el._ss, se = el._se, d = t.length - (e - s), ne = s + t.length;
    mode = mode || 'preserve';
    if (mode === 'select') { el._ss = s; el._se = ne; }
    else if (mode === 'start') { el._ss = el._se = s; }
    else if (mode === 'end') { el._ss = el._se = ne; }
    else {
      var fix = function (x) { return x > e ? x + d : x > s ? s : x; };
      el._ss = fix(ss); el._se = ss === s && se === e ? ne : fix(se);
      if (ss === s && se === e) el._ss = s;
    }
    el._sd = 'none';
    valueChanged(el);
    selectionChanged(el);
  }
  // HTML 4.10.5.1: the value sanitization algorithm of each type
  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/;
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function dateOk(str) { var m = /^(\d{4,})-(\d\d)-(\d\d)$/.exec(str); return !!m && +m[1] > 0 && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= daysIn(+m[1], +m[2]); }
  function weeksIn(y) { var j1 = new Date(Date.UTC(y, 0, 1)).getUTCDay(), leap = daysIn(y, 2) === 29; return j1 === 4 || (leap && j1 === 3) ? 53 : 52; }
  function validFloat(str) { return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(str); }
  function rangeBounds(el) {
    var mn = parseFloat(el.getAttribute('min')), mx = parseFloat(el.getAttribute('max'));
    if (!validFloat(String(el.getAttribute('min')))) mn = 0;
    if (!validFloat(String(el.getAttribute('max')))) mx = 100;
    if (mx < mn) mx = mn;
    return [mn, mx];
  }
  function stepOf(el) {
    var t = el.type, st = el.getAttribute('step');
    var dflt = t === 'time' || t === 'datetime-local' ? 60 : 1;
    if (st !== null && st.toLowerCase() === 'any') return null;
    var n = parseFloat(st);
    if (st === null || !validFloat(st.trim()) || !(n > 0)) n = dflt;
    // (in the units of valueAsNumber)
    return n * (t === 'date' ? 86400000 : t === 'week' ? 604800000 : t === 'time' || t === 'datetime-local' ? 1000 : 1);
  }
  function sanitizeValue(el, v) {
    var t = el.type;
    switch (t) {
      case 'text': case 'search': case 'tel': case 'password': case 'hidden': return t === 'hidden' ? v : v.replace(/[\r\n]/g, '');
      case 'url': case 'email': return v.replace(/[\r\n]/g, '').replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
      case 'number': return validFloat(v) && isFinite(parseFloat(v)) ? v : '';
      case 'range': {
        var b = rangeBounds(el), x = validFloat(v) ? parseFloat(v) : NaN;
        if (isNaN(x)) x = b[1] < b[0] ? b[0] : b[0] + (b[1] - b[0]) / 2;
        x = Math.max(b[0], Math.min(b[1], x));
        var stp = stepOf(el);
        if (stp) {
          var base = validFloat(String(el.getAttribute('min'))) ? b[0] : 0, k = Math.round((x - base) / stp);
          x = base + k * stp;
          if (x > b[1]) x = base + Math.floor((b[1] - base) / stp) * stp;
          if (x < b[0]) x = base + Math.ceil((b[0] - base) / stp) * stp;
        }
        return String(Math.round(x * 1e10) / 1e10);
      }
      case 'color': {
        if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
        var c = v.trim() ? colorRGBA(v) : null;
        return c ? rgbHex(c)[0] : '#000000';
      }
      case 'date': return dateOk(v) ? v : '';
      case 'month': { var mm = /^(\d{4,})-(\d\d)$/.exec(v); return mm && +mm[1] > 0 && +mm[2] >= 1 && +mm[2] <= 12 ? v : ''; }
      case 'week': { var wm = /^(\d{4,})-W(\d\d)$/.exec(v); return wm && +wm[1] > 0 && +wm[2] >= 1 && +wm[2] <= weeksIn(+wm[1]) ? v : ''; }
      case 'time': return TIME_RE.test(v) ? v : '';
      case 'datetime-local': {
        var dm = /^(\d{4,}-\d\d-\d\d)[T ](.*)$/.exec(v);
        if (!dm || !dateOk(dm[1]) || !TIME_RE.test(dm[2])) return '';
        // (the normalized form: a T, no zero seconds or fraction)
        return dm[1] + 'T' + dm[2].replace(/\.0+$/, '').replace(/^(\d\d:\d\d):00$/, '$1');
      }
      default: return v;
    }
  }
  function clockMs(str) { var m = TIME_RE.exec(str); return m ? ((+m[1] * 60 + +m[2]) * 60 + +(m[3] || 0)) * 1000 + (m[4] ? +(m[4] + '00').slice(0, 3) : 0) : NaN; }
  function valueAsNumberOf(el) {
    var t = el.type, v = el.value;
    if (v === '') return NaN;
    switch (t) {
      case 'number': case 'range': return parseFloat(v);
      case 'date': { var d = v.split('-'); return Date.UTC(+d[0], +d[1] - 1, +d[2]); }
      case 'month': { var m = v.split('-'); return (+m[0] - 1970) * 12 + (+m[1] - 1); }
      case 'week': {
        var w = /^(\d+)-W(\d+)$/.exec(v), y = +w[1], j4 = new Date(Date.UTC(y, 0, 4)), dow = (j4.getUTCDay() + 6) % 7;
        return Date.UTC(y, 0, 4 - dow) + (+w[2] - 1) * 604800000;
      }
      case 'time': return clockMs(v);
      case 'datetime-local': { var p = v.split('T'), dd = p[0].split('-'); return Date.UTC(+dd[0], +dd[1] - 1, +dd[2]) + clockMs(p[1]); }
      default: return NaN;
    }
  }
  function pad(n, k) { n = String(n); while (n.length < k) n = '0' + n; return n; }
  function timeText(ms) {
    var s = Math.floor(ms / 1000) % 60, mi = Math.floor(ms / 60000) % 60, h = Math.floor(ms / 3600000) % 24, f = ms % 1000;
    return pad(h, 2) + ':' + pad(mi, 2) + (s || f ? ':' + pad(s, 2) + (f ? '.' + pad(f, 3).replace(/0+$/, '') : '') : '');
  }
  function formatNumberValue(el, n) {
    if (!isFinite(n)) return '';
    var t = el.type;
    switch (t) {
      case 'number': case 'range': return String(n);
      case 'date': { var d = new Date(n); return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2); }
      case 'month': { var y = 1970 + Math.floor(n / 12), m = ((Math.floor(n) % 12) + 12) % 12; return pad(y, 4) + '-' + pad(m + 1, 2); }
      case 'week': {
        var dt = new Date(n + 3 * 86400000), yy = dt.getUTCFullYear(), j4 = new Date(Date.UTC(yy, 0, 4)), mon = Date.UTC(yy, 0, 4 - (j4.getUTCDay() + 6) % 7);
        return pad(yy, 4) + '-W' + pad(Math.floor((Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - mon) / 604800000) + 1, 2);
      }
      case 'time': return timeText(((n % 86400000) + 86400000) % 86400000);
      case 'datetime-local': { var dd = new Date(n); return pad(dd.getUTCFullYear(), 4) + '-' + pad(dd.getUTCMonth() + 1, 2) + '-' + pad(dd.getUTCDate(), 2) + 'T' + timeText(((n % 86400000) + 86400000) % 86400000); }
      default: return String(n);
    }
  }
  // stepUp(n) / stepDown(n), HTML 4.10.5.4
  function stepValue(el, n) {
    var t = el.type;
    if (!/^(number|range|date|month|week|time|datetime-local)$/.test(t)) throw new DOMException("This form element is not steppable.", 'InvalidStateError');
    var st = stepOf(el);
    if (st === null) throw new DOMException("This form element does not have an allowed value step.", 'InvalidStateError');
    var mnA = el.getAttribute('min'), mxA = el.getAttribute('max');
    var num = function (a) { if (a === null) return NaN; var tmp = { type: t, value: sanitizeValue({ type: t, getAttribute: function () { return null; } }, a) }; return t === 'number' || t === 'range' ? (validFloat(a) ? parseFloat(a) : NaN) : valueAsNumberOf(tmp); };
    var mn = num(mnA), mx = num(mxA);
    if (t === 'range') { var b = rangeBounds(el); mn = b[0]; mx = b[1]; }
    if (!isNaN(mn) && !isNaN(mx) && mn > mx) return;
    var base = !isNaN(mn) ? mn : !isNaN(num(el.getAttribute('value'))) ? num(el.getAttribute('value')) : 0;
    var v = valueAsNumberOf(el);
    if (isNaN(v)) v = 0;
    var q = (v - base) / st;
    if (Math.abs(q - Math.round(q)) > 1e-9) v = base + (n > 0 ? Math.ceil(q) : Math.floor(q)) * st;
    else v = v + n * st;
    if (!isNaN(mn) && v < mn) v = base + Math.ceil((mn - base) / st) * st;
    if (!isNaN(mx) && v > mx) v = base + Math.floor((mx - base) / st) * st;
    v = Math.round(v * 1e10) / 1e10;
    el.value = formatNumberValue(el, v);
  }
  // a date or time value as Chromium shows it in en-US, or the pattern it
  // shows in an empty field
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dateShown(t, v) {
    var tm = function (x) { var m = TIME_RE.exec(x); if (!m) return '--:-- --'; var h = +m[1]; return pad(h % 12 || 12, 2) + ':' + m[2] + (m[3] ? ':' + m[3] : '') + ' ' + (h < 12 ? 'AM' : 'PM'); };
    var dt = function (x) { var p = x.split('-'); return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : 'mm/dd/yyyy'; };
    if (!v) return t === 'date' ? 'mm/dd/yyyy' : t === 'time' ? '--:-- --' : t === 'datetime-local' ? 'mm/dd/yyyy, --:-- --' : t === 'month' ? '--------- ----' : 'Week --, ----';
    if (t === 'date') return dt(v);
    if (t === 'time') return tm(v);
    if (t === 'datetime-local') { var q = v.split('T'); return dt(q[0]) + ', ' + tm(q[1]); }
    if (t === 'month') { var mm = v.split('-'); return MONTHS[+mm[1] - 1] + ' ' + mm[0]; }
    var w = /^(\d+)-W(\d+)$/.exec(v);
    return w ? 'Week ' + w[2] + ', ' + w[1] : v;
  }
  function fileList(files) {
    var l = files.slice();
    l.item = function (i) { return l[i] || null; };
    return l;
  }
  function uncheckGroup(el) {
    var name = el.getAttribute('name');
    if (!name) return;
    var root = formOf(el) || el.getRootNode();
    eachElement(root, function (o) {
      if (o !== el && o.localName === 'input' && o.type === 'radio' && o.getAttribute('name') === name) o._checked = false;
    });
  }

  class HTMLTextAreaElement extends HTMLElement {
    constructor(q) { super(q); this._value = undefined; this._ss = 0; this._se = 0; this._sd = 'none'; }
    get type() { return 'textarea'; }
    get value() { return this._value !== undefined ? this._value : this.textContent; }
    set value(v) { v = v === null || v === undefined ? '' : String(v).replace(/\r\n?/g, '\n'); var was = this.value; this._value = v; if (v !== was) { this._ss = this._se = v.length; this._sd = 'none'; } valueChanged(this); }
    get selectionStart() { return this._ss; }
    set selectionStart(v) { this.setSelectionRange(v, Math.max(v, this._se), this._sd); }
    get selectionEnd() { return this._se; }
    set selectionEnd(v) { this.setSelectionRange(Math.min(this._ss, v), v, this._sd); }
    get selectionDirection() { return this._sd; }
    set selectionDirection(v) { this.setSelectionRange(this._ss, this._se, v); }
    get defaultValue() { return this.textContent; }
    set defaultValue(v) { this.textContent = v; }
    get textLength() { return this.value.length; }
    get form() { return formOf(this); }
    get labels() { return labelsOf(this); }
    get validity() { return validity; }
    select() { this._ss = 0; this._se = this.value.length; this._sd = 'none'; selectionChanged(this); }
    setSelectionRange(s, e, d) { setSelection(this, s, e, d); }
    setRangeText(t, s, e, mode) { rangeText(this, t, s, e, mode); }
  }
  reflect(HTMLTextAreaElement, ['name', 'placeholder', 'wrap', 'autocomplete', 'dirName', 'inputMode', 'enterKeyHint']);
  reflectBool(HTMLTextAreaElement, ['disabled', 'readOnly', 'required', 'autofocus']);
  ['rows', 'cols', 'maxLength', 'minLength'].forEach(function (p) {
    var a = p.toLowerCase();
    var dflt = p === 'rows' ? 2 : p === 'cols' ? 20 : -1;
    Object.defineProperty(HTMLTextAreaElement.prototype, p, { get: function () { var v = this.getAttribute(a); return v === null ? dflt : parseInt(v, 10); }, set: function (v) { this.setAttribute(a, v); }, configurable: true });
  });

  class HTMLOptionElement extends HTMLElement {
    constructor(q) { super(q); this._selected = undefined; }
    get value() { var v = this.getAttribute('value'); return v === null ? this.text : v; }
    set value(v) { this.setAttribute('value', v); }
    get text() { return this.textContent.replace(/\s+/g, ' ').trim(); }
    set text(v) { this.textContent = v; }
    get label() { return this.getAttribute('label') || this.text; }
    get selected() {
      if (this._selected !== undefined) return this._selected;
      if (this.hasAttribute('selected')) return true;
      var s = selectOf(this);
      if (s && !s.multiple) { var opts = s.options; for (var i = 0; i < opts.length; i++) if (opts[i]._selected || opts[i].hasAttribute('selected')) return false; return opts[0] === this; }
      return false;
    }
    set selected(v) {
      var s = selectOf(this);
      if (v && s && !s.multiple) s.options.forEach(function (o) { o._selected = false; });
      this._selected = !!v;
      changed();
    }
    get defaultSelected() { return this.hasAttribute('selected'); }
    set defaultSelected(v) { this.toggleAttribute('selected', !!v); }
    get index() { var s = selectOf(this); return s ? s.options.indexOf(this) : 0; }
    get form() { var s = selectOf(this); return s ? s.form : null; }
  }
  reflectBool(HTMLOptionElement, ['disabled']);
  function selectOf(o) { for (var n = o.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'select') return n; return null; }
  class HTMLOptGroupElement extends HTMLElement {}
  reflectBool(HTMLOptGroupElement, ['disabled']);
  class HTMLSelectElement extends HTMLElement {
    get type() { return this.multiple ? 'select-multiple' : 'select-one'; }
    get options() { var out = []; eachElement(this, function (e) { if (e.localName === 'option') out.push(e); }); out = NodeList(out); var self = this; out.add = function (o, b) { self.add(o, b); }; out.remove = function (i) { self.remove(i); }; Object.defineProperty(out, 'selectedIndex', { get: function () { return self.selectedIndex; } }); return out; }
    get length() { return this.options.length; }
    get selectedOptions() { return NodeList(this.options.filter(function (o) { return o.selected; })); }
    get selectedIndex() { var o = this.options; for (var i = 0; i < o.length; i++) if (o[i].selected) return i; return -1; }
    set selectedIndex(i) { var o = this.options; for (var k = 0; k < o.length; k++) o[k]._selected = k === i; changed(); }
    get value() { var i = this.selectedIndex; return i < 0 ? '' : this.options[i].value; }
    set value(v) { var o = this.options, hit = false; for (var k = 0; k < o.length; k++) { var on = !hit && o[k].value === String(v); o[k]._selected = on; if (on) hit = true; } changed(); }
    get form() { return formOf(this); }
    get labels() { return labelsOf(this); }
    get validity() { return validity; }
    item(i) { return this.options[i] || null; }
    namedItem(n) { return this.options.find(function (o) { return o.id === n || o.getAttribute('name') === n; }) || null; }
    add(o, before) { this.insertBefore(o, typeof before === 'number' ? this.options[before] || null : before || null); }
    remove(i) { if (i === undefined) { Element.prototype.remove.call(this); return; } var o = this.options[i]; if (o) o.remove(); }
    checkValidity() { return true; }
    reportValidity() { return true; }
    setCustomValidity() {}
  }
  reflect(HTMLSelectElement, ['name', 'autocomplete']);
  reflectBool(HTMLSelectElement, ['disabled', 'required', 'multiple', 'autofocus']);
  Object.defineProperty(HTMLSelectElement.prototype, 'size', { get: function () { return parseInt(this.getAttribute('size') || '0', 10); }, set: function (v) { this.setAttribute('size', v); }, configurable: true });

  class HTMLOutputElement extends HTMLElement { get value() { return this.textContent; } set value(v) { this.textContent = v; } }
  class HTMLProgressElement extends HTMLElement {
    get value() { return parseFloat(this.getAttribute('value') || '0'); }
    set value(v) { this.setAttribute('value', v); }
    get max() { return parseFloat(this.getAttribute('max') || '1'); }
    set max(v) { this.setAttribute('max', v); }
  }
  class HTMLMeterElement extends HTMLProgressElement {}
  class HTMLUnknownElement extends HTMLElement {}
  class HTMLDataElement extends HTMLElement {}
  reflect(HTMLDataElement, ['value']);
  class HTMLTimeElement extends HTMLElement {}
  reflect(HTMLTimeElement, ['dateTime']);
  class HTMLModElement extends HTMLElement {}
  class HTMLPictureElement extends HTMLElement {}
  class HTMLMapElement extends HTMLElement {}
  class HTMLAreaElement extends HTMLElement {}
  class HTMLEmbedElement extends HTMLElement {}
  class HTMLObjectElement extends HTMLElement {}
  class HTMLMenuElement extends HTMLElement {}

  class SVGElement extends Element {
    constructor(q) { super(q, SVG_NS); }
    get dataset() { return this._ds || (this._ds = datasetOf(this)); }
    get className() { var el = this; return { get baseVal() { return el.getAttribute('class') || ''; }, set baseVal(v) { el.setAttribute('class', v); }, get animVal() { return el.getAttribute('class') || ''; }, toString: function () { return el.getAttribute('class') || ''; } }; }
    set className(v) { this.setAttribute('class', v); }
    get ownerSVGElement() { for (var n = this.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'svg') return n; return null; }
    get viewportElement() { return this.ownerSVGElement; }
    get tabIndex() { var t = this.getAttribute('tabindex'); return t === null ? -1 : parseInt(t, 10); }
    set tabIndex(v) { this.setAttribute('tabindex', v); }
    focus(opts) { focusElement(this, opts); }
    blur() { if (doc && doc._active === this) focusElement(null); }
    getBBox() {
      if (this.localName === 'text') {
        // its run's extent (svgTextRuns measures it as it is drawn)
        var cs = computedOf(this), size = parseFloat(cs['font-size']) || 16, txt = this.textContent;
        var w = canvasTextWidth(txt, { size: size, weight: cs['font-weight'] || '400' });
        var len = function (v) { if (!v) return 0; v = String(v).trim().split(/[\s,]+/)[0]; return /em$/.test(v) ? parseFloat(v) * size : parseFloat(v) || 0; };
        var x = len(this.getAttribute('x')) + len(this.getAttribute('dx')), y = len(this.getAttribute('y')) + len(this.getAttribute('dy'));
        var anchor = this.getAttribute('text-anchor') || cs['text-anchor'];
        if (anchor === 'middle') x -= w / 2; else if (anchor === 'end') x -= w;
        return DOMRect(x, y - size * 0.89, w, size * 1.15);
      }
      var r = rectOf(this);
      return { x: 0, y: 0, width: r.width, height: r.height };
    }
    getTotalLength() { return 0; }
    // user units to the svg's (no viewBox scale) and to the page's: the
    // outer svg's box gives the shift
    getCTM() { return new DOMMatrix(); }
    getScreenCTM() { var s = this.localName === 'svg' ? this : this.ownerSVGElement || this; var r = rectOf(s); return new DOMMatrix([1, 0, 0, 1, r.left, r.top]); }
  }
  class SVGGraphicsElement extends SVGElement {}
  class SVGSVGElement extends SVGGraphicsElement {
    createSVGPoint() { return new DOMPoint(); }
    createSVGMatrix() { return new DOMMatrix(); }
  }
  class SVGPathElement extends SVGGraphicsElement {}

  var TAGS = {
    div: HTMLDivElement, span: HTMLSpanElement, p: HTMLParagraphElement, h1: HTMLHeadingElement, h2: HTMLHeadingElement,
    h3: HTMLHeadingElement, h4: HTMLHeadingElement, h5: HTMLHeadingElement, h6: HTMLHeadingElement, pre: HTMLPreElement,
    blockquote: HTMLQuoteElement, q: HTMLQuoteElement, br: HTMLBRElement, hr: HTMLHRElement, ul: HTMLUListElement,
    ol: HTMLOListElement, li: HTMLLIElement, dl: HTMLDListElement, table: HTMLTableElement, thead: HTMLTableSectionElement,
    tbody: HTMLTableSectionElement, tfoot: HTMLTableSectionElement, tr: HTMLTableRowElement, td: HTMLTableCellElement,
    th: HTMLTableCellElement, col: HTMLTableColElement, colgroup: HTMLTableColElement, caption: HTMLTableCaptionElement,
    html: HTMLHtmlElement, head: HTMLHeadElement, body: HTMLBodyElement, title: HTMLTitleElement, meta: HTMLMetaElement,
    base: HTMLBaseElement, style: HTMLStyleElement, link: HTMLLinkElement, script: HTMLScriptElement, a: HTMLAnchorElement,
    img: HTMLImageElement, iframe: HTMLIFrameElement, canvas: HTMLCanvasElement, video: HTMLVideoElement, audio: HTMLAudioElement,
    source: HTMLSourceElement, template: HTMLTemplateElement, slot: HTMLSlotElement, dialog: HTMLDialogElement,
    details: HTMLDetailsElement, label: HTMLLabelElement, fieldset: HTMLFieldSetElement, legend: HTMLLegendElement,
    form: HTMLFormElement, button: HTMLButtonElement, input: HTMLInputElement, textarea: HTMLTextAreaElement,
    option: HTMLOptionElement, optgroup: HTMLOptGroupElement, select: HTMLSelectElement, output: HTMLOutputElement,
    progress: HTMLProgressElement, meter: HTMLMeterElement, data: HTMLDataElement, time: HTMLTimeElement,
    ins: HTMLModElement, del: HTMLModElement, picture: HTMLPictureElement, map: HTMLMapElement, area: HTMLAreaElement,
    embed: HTMLEmbedElement, object: HTMLObjectElement, menu: HTMLMenuElement
  };
  var KNOWN = /^(abbr|address|article|aside|b|bdi|bdo|cite|code|dd|dfn|dt|em|figcaption|figure|footer|header|hgroup|i|kbd|main|mark|nav|noscript|rp|rt|ruby|s|samp|search|section|small|strong|sub|summary|sup|u|var|wbr|center|font|nobr|strike|tt|big)$/;

  function makeElement(d, name, ns) {
    var e;
    if (ns === SVG_NS) {
      var l = name.indexOf(':') > 0 ? name.slice(name.indexOf(':') + 1) : name;
      e = l === 'svg' ? new SVGSVGElement(name) : l === 'path' ? new SVGPathElement(name) : /^(g|circle|rect|line|polyline|polygon|ellipse|text|use|image|tspan)$/.test(l) ? new SVGGraphicsElement(name) : new SVGElement(name);
    } else if (ns === HTML_NS || ns === undefined) {
      var lower = name.toLowerCase();
      var C = TAGS[lower];
      if (C) e = new C(lower);
      else if (KNOWN.test(lower) || lower.indexOf('-') > 0) e = new HTMLElement(lower);
      else e = new HTMLUnknownElement(lower);
      var ce = customElementsRegistry[lower];
      if (ce) {
        try { var x = Reflect.construct(ce, [], ce); x._qname = lower; x.localName = lower; x._ce = true; e = x; } catch (err) { reportError(err); }
      }
    } else {
      e = new Element(name, ns === null ? null : ns);
    }
    e.ownerDocument = d;
    return e;
  }

  // ---- documents -----------------------------------------------------------

  class Document extends Node {
    constructor() {
      super();
      this.ownerDocument = null;
      this._active = null;
      this._url = 'about:blank';
      this.readyState = 'loading';
      this.visibilityState = 'visible';
      this.hidden = false;
      this.compatMode = 'CSS1Compat';
      this.characterSet = 'UTF-8';
      this.charset = 'UTF-8';
      this.inputEncoding = 'UTF-8';
      this.contentType = 'text/html';
      this.designMode = 'off';
      this.dir = '';
      this.fonts = { ready: Promise.resolve(), check: function () { return true; }, load: function () { return Promise.resolve([]); }, add: function () {}, addEventListener: function () {}, removeEventListener: function () {}, status: 'loaded', forEach: function () {} };
      this.implementation = {
        createHTMLDocument: function (title) { var d = new Document(); var h = d.createElement('html'); d.appendChild(h); h.appendChild(d.createElement('head')); h.appendChild(d.createElement('body')); if (title !== undefined) d.title = title; return d; },
        createDocument: function () { return new Document(); },
        createDocumentType: function (n) { return new DocumentType(n); },
        hasFeature: function () { return true; }
      };
      this._cookie = '';
      this.currentScript = null;
      this._adopted = [];
    }
    // (on the prototype: Lit shares one constructed sheet between all the
    // shadow roots of a component only when 'adoptedStyleSheets' is in
    // Document.prototype, and gives every root its own <style> otherwise,
    // parsed again for each element)
    get adoptedStyleSheets() { return this._adopted; }
    set adoptedStyleSheets(v) { this._adopted = Array.from(v || []); changed(); }
    get nodeType() { return 9; }
    get nodeName() { return '#document'; }
    get documentElement() { return this.firstElementChild; }
    get head() { var h = this.documentElement; if (!h) return null; for (var i = 0; i < h._c.length; i++) if (h._c[i].localName === 'head') return h._c[i]; return null; }
    get body() { var h = this.documentElement; if (!h) return null; for (var i = 0; i < h._c.length; i++) if (h._c[i].localName === 'body') return h._c[i]; return null; }
    get title() { var t = this.querySelector('title'); return t ? t.textContent.replace(/\s+/g, ' ').trim() : ''; }
    set title(v) { var t = this.querySelector('title'); if (!t) { t = this.createElement('title'); if (this.head) this.head.appendChild(t); } t.textContent = v; }
    get URL() { return this._url; }
    get documentURI() { return this._url; }
    get location() { return this === doc ? G.location : null; }
    get defaultView() { return this === doc ? G : null; }
    get activeElement() {
      var a = this._active;
      // (one in a shadow tree: its host, as the page sees it)
      while (a && shadowCount && shadowRootOf(a)) a = shadowRootOf(a).host;
      if (a && a.isConnected) return a;
      return this.body || this.documentElement;
    }
    get styleSheets() { return styleSheetsOf(this); }
    get scrollingElement() { return this.documentElement; }
    get forms() { return this.getElementsByTagName('form'); }
    get images() { return this.getElementsByTagName('img'); }
    get links() { return this.querySelectorAll('a[href],area[href]'); }
    get scripts() { return this.getElementsByTagName('script'); }
    get doctype() { for (var i = 0; i < this._c.length; i++) if (this._c[i].nodeType === 10) return this._c[i]; return null; }
    get cookie() { return this._cookie; }
    set cookie(v) {
      var kv = String(v).split(';')[0];
      var name = kv.split('=')[0].trim();
      var parts = this._cookie ? this._cookie.split('; ') : [];
      parts = parts.filter(function (p) { return p.split('=')[0] !== name; });
      if (!/max-age=0|expires=Thu, 01 Jan 1970/i.test(String(v))) parts.push(kv.trim());
      this._cookie = parts.join('; ');
    }
    get referrer() { return ''; }
    get domain() { var u = parseURL(this._url); return u ? u.hostname : ''; }
    get lastModified() { return new Date().toString(); }
    get fullscreenElement() { return null; }
    get pointerLockElement() { return null; }
    get childElementCount() { return this.documentElement ? 1 : 0; }
    hasFocus() { return true; }
    createElement(name, opts) {
      name = String(name);
      if (!/^[a-zA-Z][^\s\/>]*$/.test(name)) throw DOMException("Failed to execute 'createElement' on 'Document': The tag name provided ('" + name + "') is not a valid name.", 'InvalidCharacterError');
      var is = opts && typeof opts === 'object' ? opts.is : undefined;
      var e = makeElement(this, name, HTML_NS);
      if (is) e.setAttribute('is', is);
      return e;
    }
    createElementNS(ns, name) { return makeElement(this, String(name), ns === null || ns === undefined || ns === '' ? null : ns); }
    createTextNode(t) { var n = new Text(t); n.ownerDocument = this; return n; }
    createComment(t) { var n = new Comment(t); n.ownerDocument = this; return n; }
    createCDATASection(t) { var n = new CDATASection(t); n.ownerDocument = this; return n; }
    createProcessingInstruction(target, t) { var n = new ProcessingInstruction(t); n.target = target; n.ownerDocument = this; return n; }
    createDocumentFragment() { var n = new DocumentFragment(); n.ownerDocument = this; return n; }
    createAttribute(n) { return new Attr(String(n).toLowerCase(), '', null); }
    createEvent(kind) {
      var k = String(kind).toLowerCase().replace(/s$/, '');
      var C = { event: Event, htmlevent: Event, customevent: CustomEvent, uievent: UIEvent, mouseevent: MouseEvent, keyboardevent: KeyboardEvent, focusevent: FocusEvent, messageevent: MessageEvent }[k];
      if (!C) throw DOMException("The provided event type ('" + kind + "') is invalid.", 'NotSupportedError');
      var e = new C('');
      if (C === CustomEvent) e.initCustomEvent = function (t, b, c, d) { this.initEvent(t, b, c); this.detail = d; };
      if (C === MouseEvent) e.initMouseEvent = function (t, b, c) { this.initEvent(t, b, c); };
      return e;
    }
    createRange() { return new Range(this); }
    createTreeWalker(root, what, filter) { return new TreeWalker(root, what === undefined ? 0xFFFFFFFF : what, filter || null); }
    createNodeIterator(root, what, filter) { return new NodeIterator(root, what === undefined ? 0xFFFFFFFF : what, filter || null); }
    importNode(n, deep) { var c = n.cloneNode(!!deep); adopt(c, this); return c; }
    adoptNode(n) { if (n.parentNode) n.parentNode.removeChild(n); adopt(n, this); return n; }
    getElementById(id) {
      id = String(id);
      var f = null;
      eachElement(this, function (e) { if (e.getAttribute('id') === id) { f = e; return true; } });
      return f;
    }
    getElementsByName(n) { var out = []; eachElement(this, function (e) { if (e.getAttribute('name') === n) out.push(e); }); return NodeList(out); }
    elementFromPoint(x, y) { var e = hitTest(x, y); return shadowCount && e ? retarget(e, this) : e; }
    caretRangeFromPoint(x, y) {
      var e = hitTest(x, y);
      if (!e) return null;
      var c = caretIn(e, x), r = new Range(this);
      if (c) { r.setStart(c[0], c[1]); r.setEnd(c[0], c[1]); } else { r.setStart(e, 0); r.setEnd(e, 0); }
      return r;
    }
    caretPositionFromPoint(x, y) { var r = this.caretRangeFromPoint(x, y); return r ? { offsetNode: r.startContainer, offset: r.startOffset, getClientRect: function () { return r.getBoundingClientRect(); } } : null; }
    elementsFromPoint(x, y) { var e = hitTest(x, y), out = []; if (shadowCount && e) e = retarget(e, this); for (; e && e.nodeType === 1; e = upFlat(e)) if (!shadowCount || !shadowRootOf(e)) out.push(e); return out; }
    getSelection() { return selection; }
    get timeline() { return documentTimeline; }
    getAnimations() { var out = []; eachElement(this, function (e) { if (e._waapi) e._waapi.forEach(function (a) { if (animationRelevant(a)) out.push(a); }); }); return out; }
    execCommand(cmd, ui, value) {
      cmd = String(cmd).toLowerCase();
      if (cmd === 'copy') return true;
      if (/^(inserttext|insertlinebreak|insertparagraph|delete|forwarddelete|selectall)$/.test(cmd)) return editCommand(this._active, cmd, value === undefined || value === null ? '' : String(value));
      return false;
    }
    queryCommandSupported() { return false; }
    queryCommandEnabled() { return false; }
    open() { removeAll(this); return this; }
    close() {}
    write(html) { var b = this.body; if (b) b.insertAdjacentHTML('beforeend', html); }
    writeln(html) { this.write(html + '\n'); }
    exitFullscreen() { return Promise.resolve(); }
    exitPointerLock() {}
    startViewTransition(cb) { var p = Promise.resolve().then(function () { return cb && cb(); }); return { finished: p, ready: p, updateCallbackDone: p, skipTransition: function () {} }; }
  }
  mixin(Document, ParentNode);
  class HTMLDocument extends Document {}
  class XMLDocument extends Document {}

  function innerTextOf(el) {
    var cs = computedOf(el);
    if (cs.display === 'none') return el.textContent;
    var out = '';
    (function walk(n) {
      for (var i = 0; i < n._c.length; i++) {
        var k = n._c[i];
        if (k.nodeType === 3) out += k.data.replace(/\s+/g, ' ');
        else if (k.nodeType === 1) {
          var d = computedOf(k).display;
          if (d === 'none') continue;
          if (k.localName === 'br') { out += '\n'; continue; }
          var block = d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table' || d === 'table-row';
          if (block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
          walk(k);
          if (block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        }
      }
    })(el);
    return out.replace(/ *\n */g, '\n').replace(/^\n+|\n+$/g, '');
  }

  // ---- event handler properties (GlobalEventHandlers) ---------------------

  // onclick, oninput, ...: null until set; a page (React) tests for them
  // with `'oninput' in document` before it listens
  var HANDLER_EVENTS = ('abort auxclick beforeinput blur cancel canplay change click close contextmenu copy cut dblclick drag dragend dragenter ' +
    'dragleave dragover dragstart drop error focus focusin focusout formdata input invalid keydown keypress keyup load loadend loadstart ' +
    'mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup paste pointercancel pointerdown pointerenter pointerleave ' +
    'pointermove pointerout pointerover pointerup progress reset resize scroll scrollend select selectionchange selectstart submit toggle ' +
    'touchcancel touchend touchmove touchstart transitionend animationend animationstart wheel').split(' ');
  function defineHandlers(proto, extra) {
    var names = HANDLER_EVENTS.concat(extra || []);
    names.forEach(function (type) {
      Object.defineProperty(proto, 'on' + type, {
        configurable: true, enumerable: true,
        get: function () {
          if (this._on && this._on[type]) return this._on[type];
          // an onclick="..." attribute, compiled once per text
          var src = this.getAttribute ? this.getAttribute('on' + type) : null;
          if (src === null || src === undefined) return null;
          if (!this._onAttr) this._onAttr = {};
          var c = this._onAttr[type];
          if (!c || c.src !== src) {
            exposeIds();
            try { c = { src: src, fn: new Function('event', src) }; } catch (e) { reportError(e); c = { src: src, fn: null }; }
            this._onAttr[type] = c;
          }
          return c.fn;
        },
        set: function (f) { if (!this._on) this._on = {}; this._on[type] = typeof f === 'function' ? f : null; }
      });
    });
  }
  defineHandlers(HTMLElement.prototype);
  defineHandlers(SVGElement.prototype);
  defineHandlers(Document.prototype, ['readystatechange', 'visibilitychange', 'DOMContentLoaded']);

  // ---- traversal, ranges, selection ----------------------------------------

  var NodeFilter = {
    FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
    SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 0x1, SHOW_ATTRIBUTE: 0x2, SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8,
    SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80, SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200, SHOW_DOCUMENT_FRAGMENT: 0x400
  };
  function acceptNode(w, n) {
    if (!((1 << (n.nodeType - 1)) & w.whatToShow)) return 3;
    var f = w.filter;
    if (!f) return 1;
    var r = typeof f === 'function' ? f(n) : f.acceptNode(n);
    return r === undefined ? 1 : r;
  }
  class TreeWalker {
    constructor(root, what, filter) { this.root = root; this.whatToShow = what >>> 0; this.filter = filter; this.currentNode = root; }
    parentNode() {
      for (var n = this.currentNode; n && n !== this.root;) {
        n = n.parentNode;
        if (n && acceptNode(this, n) === 1) { this.currentNode = n; return n; }
      }
      return null;
    }
    _child(first) {
      var n = first ? this.currentNode.firstChild : this.currentNode.lastChild;
      while (n) {
        var r = acceptNode(this, n);
        if (r === 1) { this.currentNode = n; return n; }
        if (r === 3) { var c = first ? n.firstChild : n.lastChild; if (c) { n = c; continue; } }
        while (n) {
          var s = first ? n.nextSibling : n.previousSibling;
          if (s) { n = s; break; }
          var p = n.parentNode;
          if (!p || p === this.root || p === this.currentNode) return null;
          n = p;
        }
      }
      return null;
    }
    firstChild() { return this._child(true); }
    lastChild() { return this._child(false); }
    _sibling(next) {
      var n = this.currentNode;
      if (n === this.root) return null;
      for (;;) {
        var s = next ? n.nextSibling : n.previousSibling;
        while (s) {
          n = s;
          var r = acceptNode(this, n);
          if (r === 1) { this.currentNode = n; return n; }
          s = next ? n.firstChild : n.lastChild;
          if (r === 2 || !s) s = next ? n.nextSibling : n.previousSibling;
        }
        n = n.parentNode;
        if (!n || n === this.root) return null;
        if (acceptNode(this, n) === 1) return null;
      }
    }
    nextSibling() { return this._sibling(true); }
    previousSibling() { return this._sibling(false); }
    nextNode() {
      var n = this.currentNode;
      for (;;) {
        var r = 1;
        while (r !== 2 && n.firstChild) {
          n = n.firstChild;
          r = acceptNode(this, n);
          if (r === 1) { this.currentNode = n; return n; }
        }
        var s = null;
        for (var t = n; t && t !== this.root; t = t.parentNode) { if (t.nextSibling) { s = t.nextSibling; break; } }
        if (!s) return null;
        n = s;
        r = acceptNode(this, n);
        if (r === 1) { this.currentNode = n; return n; }
        if (r === 2) {
          // skip the subtree: continue from its next node
          var nx = null;
          for (var u = n; u && u !== this.root; u = u.parentNode) { if (u.nextSibling) { nx = u.nextSibling; break; } }
          if (!nx) return null;
          n = nx;
          r = acceptNode(this, n);
          if (r === 1) { this.currentNode = n; return n; }
        }
      }
    }
    previousNode() {
      var n = this.currentNode;
      while (n && n !== this.root) {
        var s = n.previousSibling;
        while (s) {
          n = s;
          var r = acceptNode(this, n);
          while (r !== 2 && n.lastChild) { n = n.lastChild; r = acceptNode(this, n); }
          if (r === 1) { this.currentNode = n; return n; }
          s = n.previousSibling;
        }
        if (n === this.root || !n.parentNode) return null;
        n = n.parentNode;
        if (acceptNode(this, n) === 1) { this.currentNode = n; return n; }
      }
      return null;
    }
  }
  class NodeIterator {
    constructor(root, what, filter) { this.root = root; this.whatToShow = what >>> 0; this.filter = filter; this.referenceNode = root; this._before = true; }
    _list() { var out = [this.root]; (function walk(n) { for (var i = 0; i < n._c.length; i++) { out.push(n._c[i]); walk(n._c[i]); } })(this.root); return out; }
    nextNode() {
      var l = this._list(), i = l.indexOf(this.referenceNode);
      if (!this._before) i++;
      for (; i < l.length; i++) if (acceptNode(this, l[i]) === 1) { this.referenceNode = l[i]; this._before = false; return l[i]; }
      return null;
    }
    previousNode() {
      var l = this._list(), i = l.indexOf(this.referenceNode);
      if (this._before) i--;
      for (; i >= 0; i--) if (acceptNode(this, l[i]) === 1) { this.referenceNode = l[i]; this._before = true; return l[i]; }
      return null;
    }
    detach() {}
  }

  // ---- ranges (DOM 5) -------------------------------------------------------
  function nodeLen(n) { return n.nodeType === 10 ? 0 : n._c && n.nodeType !== 3 && n.nodeType !== 4 && n.nodeType !== 8 && n.nodeType !== 7 ? n._c.length : (n.data || '').length; }
  function isChars(n) { return n.nodeType === 3 || n.nodeType === 4 || n.nodeType === 8 || n.nodeType === 7; }
  function idxOf(n) { return n.parentNode ? n.parentNode._c.indexOf(n) : 0; }
  // the position of (a, ao) against (b, bo): -1 before, 0 equal, 1 after
  function bpCompare(a, ao, b, bo) {
    if (a === b) return ao === bo ? 0 : ao < bo ? -1 : 1;
    if (a.compareDocumentPosition(b) & 2) return -bpCompare(b, bo, a, ao);
    if (a.contains(b)) {
      var ch = b;
      while (ch.parentNode !== a) ch = ch.parentNode;
      if (idxOf(ch) < ao) return 1;
    }
    return -1;
  }
  function rangeRoot(n) { while (n.parentNode) n = n.parentNode; return n; }
  class AbstractRange {
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
  }
  class Range extends AbstractRange {
    constructor(d) { super(); d = d || doc; this.startContainer = d; this.startOffset = 0; this.endContainer = d; this.endOffset = 0; }
    get commonAncestorContainer() { var a = this.startContainer; while (a && !a.contains(this.endContainer)) a = a.parentNode; return a; }
    _check(n, o) {
      if (n.nodeType === 10) throw DOMException("The node provided is a doctype.", 'InvalidNodeTypeError');
      if (o > nodeLen(n)) throw DOMException("The offset " + o + " is larger than the node's length (" + nodeLen(n) + ").", 'IndexSizeError');
    }
    setStart(n, o) {
      o = o >>> 0; this._check(n, o);
      this.startContainer = n; this.startOffset = o;
      if (rangeRoot(n) !== rangeRoot(this.endContainer) || bpCompare(n, o, this.endContainer, this.endOffset) > 0) { this.endContainer = n; this.endOffset = o; }
    }
    setEnd(n, o) {
      o = o >>> 0; this._check(n, o);
      this.endContainer = n; this.endOffset = o;
      if (rangeRoot(n) !== rangeRoot(this.startContainer) || bpCompare(n, o, this.startContainer, this.startOffset) < 0) { this.startContainer = n; this.startOffset = o; }
    }
    setStartBefore(n) { this.setStart(n.parentNode, idxOf(n)); }
    setStartAfter(n) { this.setStart(n.parentNode, idxOf(n) + 1); }
    setEndBefore(n) { this.setEnd(n.parentNode, idxOf(n)); }
    setEndAfter(n) { this.setEnd(n.parentNode, idxOf(n) + 1); }
    selectNode(n) { var p = n.parentNode, i = idxOf(n); this.startContainer = this.endContainer = p; this.startOffset = i; this.endOffset = i + 1; }
    selectNodeContents(n) { this.startContainer = this.endContainer = n; this.startOffset = 0; this.endOffset = nodeLen(n); }
    collapse(toStart) { if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; } else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; } }
    cloneRange() { var r = new Range(doc); r.startContainer = this.startContainer; r.startOffset = this.startOffset; r.endContainer = this.endContainer; r.endOffset = this.endOffset; return r; }
    detach() {}
    toString() {
      var s = this.startContainer, e = this.endContainer;
      if (s === e && (s.nodeType === 3 || s.nodeType === 4)) return s.data.slice(this.startOffset, this.endOffset);
      var out = '';
      if (s.nodeType === 3 || s.nodeType === 4) out += s.data.slice(this.startOffset);
      var self = this;
      eachNodeIn(this.commonAncestorContainer, function (n) {
        if ((n.nodeType === 3 || n.nodeType === 4) && n !== s && n !== e && self._contains(n)) out += n.data;
      });
      if (e.nodeType === 3 || e.nodeType === 4) out += e.data.slice(0, this.endOffset);
      return out;
    }
    _contains(n) { return rangeRoot(n) === rangeRoot(this.startContainer) && bpCompare(n, 0, this.startContainer, this.startOffset) > 0 && bpCompare(n, nodeLen(n), this.endContainer, this.endOffset) < 0; }
    getBoundingClientRect() {
      var a = pointX(this.startContainer, this.startOffset), b = pointX(this.endContainer, this.endOffset);
      if (a && b) { var l = Math.min(a.x, b.x), t = Math.min(a.y, b.y); return DOMRect(l, t, Math.abs(b.x - a.x), Math.max(a.y + a.h, b.y + b.h) - t); }
      var n = this.startContainer; return rectOf(n.nodeType === 1 ? n : n.parentNode);
    }
    getClientRects() { return [this.getBoundingClientRect()]; }
    createContextualFragment(html) { return parseFragment(String(html), this.startContainer.nodeType === 1 ? this.startContainer : null); }
    // DOM 5.5: clone, extract (mode 1) or delete (mode 2) what the range holds
    _contents(mode) {
      var od = this.startContainer.ownerDocument || this.startContainer, frag = (od.nodeType === 9 ? od : doc).createDocumentFragment();
      if (this.collapsed) return frag;
      var sn = this.startContainer, so = this.startOffset, en = this.endContainer, eo = this.endOffset, c;
      if (sn === en && isChars(sn)) {
        c = sn.cloneNode(false); c.data = sn.data.slice(so, eo); if (mode !== 2) frag.appendChild(c);
        if (mode) sn.replaceData(so, eo - so, '');
        return frag;
      }
      var common = sn;
      while (!common.contains(en)) common = common.parentNode;
      var first = null, last = null, kids = common._c.slice(), i;
      if (!sn.contains(en)) for (i = 0; i < kids.length; i++) if (kids[i].contains(sn)) { first = kids[i]; break; }
      if (!en.contains(sn)) for (i = kids.length - 1; i >= 0; i--) if (kids[i].contains(en)) { last = kids[i]; break; }
      var self = this, contained = kids.filter(function (k) { return self._contains(k); });
      for (i = 0; i < contained.length; i++) if (contained[i].nodeType === 10) throw DOMException('A doctype in the range.', 'HierarchyRequestError');
      var newNode, newOffset;
      if (sn.contains(en)) { newNode = sn; newOffset = so; }
      else { var ref = sn; while (ref.parentNode && !ref.parentNode.contains(en)) ref = ref.parentNode; newNode = ref.parentNode; newOffset = idxOf(ref) + 1; }
      var sub;
      if (first && isChars(first)) {
        c = first.cloneNode(false); c.data = sn.data.slice(so); if (mode !== 2) frag.appendChild(c);
        if (mode) sn.replaceData(so, sn.data.length - so, '');
      } else if (first) {
        c = first.cloneNode(false); if (mode !== 2) frag.appendChild(c);
        sub = new Range(doc); sub.startContainer = sn; sub.startOffset = so; sub.endContainer = first; sub.endOffset = nodeLen(first);
        var sf = sub._contents(mode); if (mode !== 2) c.appendChild(sf);
      }
      for (i = 0; i < contained.length; i++) {
        if (mode === 0) frag.appendChild(contained[i].cloneNode(true));
        else if (mode === 1) frag.appendChild(contained[i]);
        else common.removeChild(contained[i]);
      }
      if (last && isChars(last)) {
        c = last.cloneNode(false); c.data = en.data.slice(0, eo); if (mode !== 2) frag.appendChild(c);
        if (mode) en.replaceData(0, eo, '');
      } else if (last) {
        c = last.cloneNode(false); if (mode !== 2) frag.appendChild(c);
        sub = new Range(doc); sub.startContainer = last; sub.startOffset = 0; sub.endContainer = en; sub.endOffset = eo;
        var lf = sub._contents(mode); if (mode !== 2) c.appendChild(lf);
      }
      if (mode) { this.startContainer = this.endContainer = newNode; this.startOffset = this.endOffset = newOffset; }
      return frag;
    }
    cloneContents() { return this._contents(0); }
    extractContents() { return this._contents(1); }
    deleteContents() { this._contents(2); }
    insertNode(n) {
      var c = this.startContainer, so = this.startOffset, wasCollapsed = this.collapsed, p, ref;
      if (c.nodeType === 3) { var rest = c.splitText(so); p = c.parentNode; ref = rest; }
      else { p = c; ref = c._c[so] || null; }
      if (n.parentNode) n.parentNode.removeChild(n);
      var at = ref ? p._c.indexOf(ref) : p._c.length, count = n.nodeType === 11 ? n._c.length : 1;
      p.insertBefore(n, ref);
      if (c.nodeType === 3) { if (wasCollapsed) { this.endContainer = p; this.endOffset = at + count; } }
      else if (wasCollapsed) { this.endContainer = p; this.endOffset = at + count; }
      else if (this.endContainer === p && this.endOffset >= at) this.endOffset += count;
    }
    surroundContents(n) {
      var frag = this.extractContents();
      while (n.firstChild) n.removeChild(n.firstChild);
      this.insertNode(n);
      n.appendChild(frag);
      this.selectNode(n);
    }
    compareBoundaryPoints(how, src) {
      if (how === 0) return bpCompare(this.startContainer, this.startOffset, src.startContainer, src.startOffset);
      if (how === 1) return bpCompare(this.endContainer, this.endOffset, src.startContainer, src.startOffset);
      if (how === 2) return bpCompare(this.endContainer, this.endOffset, src.endContainer, src.endOffset);
      if (how === 3) return bpCompare(this.startContainer, this.startOffset, src.endContainer, src.endOffset);
      throw DOMException('The comparison method provided must be one of START_TO_START, START_TO_END, END_TO_END, or END_TO_START.', 'NotSupportedError');
    }
    comparePoint(n, o) {
      if (rangeRoot(n) !== rangeRoot(this.startContainer)) throw DOMException('The node provided and the Range are not in the same tree.', 'WrongDocumentError');
      this._check(n, o);
      if (bpCompare(n, o, this.startContainer, this.startOffset) < 0) return -1;
      if (bpCompare(n, o, this.endContainer, this.endOffset) > 0) return 1;
      return 0;
    }
    isPointInRange(n, o) {
      if (rangeRoot(n) !== rangeRoot(this.startContainer)) return false;
      this._check(n, o);
      return bpCompare(n, o, this.startContainer, this.startOffset) >= 0 && bpCompare(n, o, this.endContainer, this.endOffset) <= 0;
    }
    intersectsNode(n) {
      if (rangeRoot(n) !== rangeRoot(this.startContainer)) return false;
      var p = n.parentNode;
      if (!p) return true;
      var i = idxOf(n);
      return bpCompare(p, i, this.endContainer, this.endOffset) < 0 && bpCompare(p, i + 1, this.startContainer, this.startOffset) > 0;
    }
  }
  Range.START_TO_START = 0; Range.START_TO_END = 1; Range.END_TO_END = 2; Range.END_TO_START = 3;
  class StaticRange extends AbstractRange {
    constructor(init) {
      super();
      if (!init || !init.startContainer || !init.endContainer) throw new TypeError("Failed to construct 'StaticRange': required member startContainer is undefined.");
      this.startContainer = init.startContainer; this.startOffset = init.startOffset >>> 0; this.endContainer = init.endContainer; this.endOffset = init.endOffset >>> 0;
    }
  }
  function eachNodeIn(root, fn) { var st = [root]; while (st.length) { var n = st.pop(); fn(n); if (n._c) for (var i = n._c.length - 1; i >= 0; i--) st.push(n._c[i]); } }

  class Selection {
    constructor() { this._ranges = []; this._back = false; }
    get rangeCount() { return this._ranges.length; }
    get anchorNode() { var r = this._ranges[0]; return r ? (this._back ? r.endContainer : r.startContainer) : null; }
    get anchorOffset() { var r = this._ranges[0]; return r ? (this._back ? r.endOffset : r.startOffset) : 0; }
    get focusNode() { var r = this._ranges[0]; return r ? (this._back ? r.startContainer : r.endContainer) : null; }
    get focusOffset() { var r = this._ranges[0]; return r ? (this._back ? r.startOffset : r.endOffset) : 0; }
    get isCollapsed() { return !this._ranges.length || this._ranges[0].collapsed; }
    get type() { return !this._ranges.length ? 'None' : this._ranges[0].collapsed ? 'Caret' : 'Range'; }
    get direction() { return !this._ranges.length || this._ranges[0].collapsed ? 'none' : this._back ? 'backward' : 'forward'; }
    getRangeAt(i) { if (!this._ranges[i]) throw DOMException('The index provided is invalid.', 'IndexSizeError'); return this._ranges[i]; }
    getComposedRanges() { return this._ranges.map(function (r) { return new StaticRange(r); }); }
    addRange(r) { if (!this._ranges.length) { this._ranges = [r]; this._back = false; } }
    removeRange(r) { if (this._ranges[0] === r) this._ranges = []; }
    removeAllRanges() { this._ranges = []; }
    empty() { this._ranges = []; }
    collapse(n, o) { if (!n) { this._ranges = []; return; } var r = new Range(doc); r.setStart(n, o || 0); r.collapse(true); this._ranges = [r]; this._back = false; }
    setPosition(n, o) { this.collapse(n, o); }
    collapseToStart() { var r = this._ranges[0]; if (!r) throw DOMException('There is no selection to collapse.', 'InvalidStateError'); this.collapse(r.startContainer, r.startOffset); }
    collapseToEnd() { var r = this._ranges[0]; if (!r) throw DOMException('There is no selection to collapse.', 'InvalidStateError'); this.collapse(r.endContainer, r.endOffset); }
    extend(n, o) {
      var r = this._ranges[0];
      if (!r) throw DOMException('This Selection object doesn\'t have any Ranges.', 'InvalidStateError');
      o = o || 0;
      var an = this.anchorNode, ao = this.anchorOffset, nr = new Range(doc);
      if (bpCompare(n, o, an, ao) < 0) { nr.setStart(n, o); nr.setEnd(an, ao); this._back = true; }
      else { nr.setStart(an, ao); nr.setEnd(n, o); this._back = false; }
      this._ranges = [nr];
    }
    setBaseAndExtent(a, ao, f, fo) {
      var r = new Range(doc);
      if (bpCompare(f, fo, a, ao) < 0) { r.setStart(f, fo); r.setEnd(a, ao); this._back = true; }
      else { r.setStart(a, ao); r.setEnd(f, fo); this._back = false; }
      this._ranges = [r];
    }
    selectAllChildren(n) { var r = new Range(doc); r.selectNodeContents(n); this._ranges = [r]; this._back = false; }
    containsNode(n, partial) {
      var r = this._ranges[0];
      if (!r || rangeRoot(n) !== rangeRoot(r.startContainer)) return false;
      if (partial) return r.intersectsNode(n);
      var p = n.parentNode;
      if (!p) return false;
      var i = idxOf(n);
      return bpCompare(p, i, r.startContainer, r.startOffset) >= 0 && bpCompare(p, i + 1, r.endContainer, r.endOffset) <= 0;
    }
    deleteFromDocument() { if (this._ranges[0]) this._ranges[0].deleteContents(); }
    modify() {}
    toString() { return this._ranges.length ? this._ranges[0].toString() : ''; }
  }
  var selection = new Selection();


  // ---- focus ---------------------------------------------------------------

  function focusableByDefault(el) {
    var n = el.localName;
    if (n === 'a' || n === 'area') return el.hasAttribute('href');
    if (/^(input|select|textarea|button|iframe|summary)$/.test(n)) return !el.disabled && !(n === 'input' && el.type === 'hidden');
    return el.isContentEditable;
  }
  function focusable(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if (el.disabled) return false;
    if (el.hasAttribute('tabindex') || focusableByDefault(el)) {
      for (var n = el; n && n.nodeType === 1; n = composedParent(n)) {
        if (n.hasAttribute('inert')) return false;
        if (computedOf(n).display === 'none') return false;
      }
      if (blockedByModal(el)) return false;
      return computedOf(el).visibility !== 'hidden';
    }
    return false;
  }
  // the parent in the composed tree: a shadow root's child goes on to its host
  function composedParent(n) {
    var p = n.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : p;
  }
  function composedContains(a, n) {
    for (; n; n = composedParent(n)) if (n === a) return true;
    return false;
  }
  // an open modal dialog makes everything outside it inert (HTML 6.2,
  // "blocked by a modal dialog"): the topmost one in the top layer
  function topModal() {
    for (var i = topLayer.length - 1; i >= 0; i--) { var t = topLayer[i]; if (t._modal && t.isConnected) return t; }
    return null;
  }
  function blockedByModal(el) {
    var m = topModal();
    if (!m) return false;
    if (composedContains(m, el)) return false;
    // (what a popover or another top-layer box above the dialog holds is not blocked)
    for (var i = topLayer.indexOf(m) + 1; i < topLayer.length; i++) if (composedContains(topLayer[i], el)) return false;
    return true;
  }
  // a host whose shadow root delegates focus: the first focusable element
  // in its shadow tree, in sequential order, takes the focus (HTML 6.6.4)
  function delegateTarget(host) {
    var out = [];
    tabWalk(host._sr, out, true);
    for (var i = 0; i < out.length; i++) if (out[i].hasAttribute('autofocus')) return out[i];
    return out[0] || null;
  }
  function focusElement(el, opts) {
    if (!doc) return;
    if (el && el._sr && el._sr.delegatesFocus) {
      var a = doc._active;
      // (the focus already in its shadow tree stays where it is)
      if (a && a !== el && composedContains(el, a)) return;
      var dt = delegateTarget(el);
      if (dt) el = dt;
    }
    if (el && !focusable(el)) return;
    if (opts && opts.focusVisible !== undefined) doc._focusVisible = !!opts.focusVisible;
    var old = doc._active && doc._active.isConnected ? doc._active : null;
    if (old === el) return;
    if (old) {
      // (a value the user changed since the field took the focus is
      // committed as it loses it: change, before blur, HTML 4.10.5.5)
      if (old._dirty) { old._dirty = false; dispatch(old, new Event('change', { bubbles: true })); }
      doc._active = null;
      dispatch(old, new FocusEvent('blur', { relatedTarget: el, view: G }));
      dispatch(old, new FocusEvent('focusout', { bubbles: true, relatedTarget: el, view: G }));
    }
    doc._active = el;
    if (el) el._dirty = false;
    pointerStateChanged(old, el, true);
    // (the focused element is scrolled into view unless the caller says
    // not to; Chromium centers it when it is not already in view)
    if (el && !(opts && opts.preventScroll)) { try { scrollIntoView(el, { block: 'if-needed', inline: 'if-needed' }); } catch (e) {} }
    if (el) {
      dispatch(el, new FocusEvent('focus', { relatedTarget: old, view: G }));
      dispatch(el, new FocusEvent('focusin', { bubbles: true, relatedTarget: old, view: G }));
    }
  }
  // sequential focus order (HTML 6.6.3): the flat tree, a host's shadow
  // tree where the host is, a slot's assigned nodes where the slot is; a
  // host that delegates focus is not a stop of its own
  function tabWalk(n, out, all) {
    var kids = n._c;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k._attrs === undefined) continue;
      if (k.localName === 'slot' && shadowRootOf(k)) {
        var f = flatten(k, []);
        for (var j = 0; j < f.length; j++) if (f[j]._attrs !== undefined) tabVisit(f[j], out, all);
        continue;
      }
      tabVisit(k, out, all);
    }
  }
  function tabVisit(e, out, all) {
    if (!(e._sr && e._sr.delegatesFocus) && focusable(e) && (all || e.tabIndex >= 0)) out.push(e);
    tabWalk(e._sr || e, out, all);
  }
  function tabOrder() {
    var out = [];
    if (doc) tabWalk(doc, out, false);
    var pos = out.filter(function (e) { return e.tabIndex > 0; }).sort(function (a, b) { return a.tabIndex - b.tabIndex; });
    return pos.concat(out.filter(function (e) { return e.tabIndex === 0; }));
  }

  // a click with its activation: a checkbox or radio changes before the
  // listeners see the click and is put back if the click is canceled. The
  // checkedness is set as the browser does, not through the checked setter
  // (React's value tracker wraps it and would miss the change).
  function activatedClick(el, ev) {
    var box = el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio') ? el : null;
    var was = box && checkedness(box), prev = null;
    if (box && box.type === 'radio' && !was && box.getAttribute('name')) {
      eachElement(formOf(box) || box.getRootNode(), function (o) {
        if (o !== box && o.localName === 'input' && o.type === 'radio' && checkedness(o) && o.getAttribute('name') === box.getAttribute('name')) prev = o;
      });
    }
    if (box) {
      box._checked = box.type === 'checkbox' ? !was : true;
      if (box._checked && box.type === 'radio') uncheckGroup(box);
      changed();
    }
    var ok = dispatch(el, ev);
    if (!ok) {
      if (box) { box._checked = was; if (prev) prev._checked = true; changed(); }
      return;
    }
    if (box) { if (box._checked !== was) fireChange(box); return; }
    activationBehavior(el, ev);
  }
  function checkedness(o) { return o._checked !== undefined ? o._checked : o.hasAttribute('checked'); }
  function activationBehavior(el, ev) {
    // what a click does after the listeners: links, labels, form controls
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      var l = n.localName;
      if (l === 'input') {
        var t = n.type;
        if (t === 'file' && !n.disabled) { askFiles(n); return; }
        if (t === 'submit' || t === 'image') submitForm(n);
        else if (t === 'reset') { var rf = n.form; if (rf) rf.reset(); }
        return;
      }
      if (l === 'button') {
        if (n.disabled) return;
        if (n.type === 'submit') submitForm(n);
        else if (n.type === 'reset') { var f2 = n.form; if (f2) f2.reset(); }
        return;
      }
      if (l === 'label') {
        var c = n.control;
        if (c && c !== el && !c.contains(el)) { c.focus(); c.click(); }
        return;
      }
      if (l === 'a' && n.hasAttribute('href')) {
        var href = n.getAttribute('href');
        if (href && href.charAt(0) !== '#' && !/^javascript:/i.test(href)) G.open(resolveURL(href), n.getAttribute('target') || '_self');
        return;
      }
      if (l === 'summary' && n.parentNode && n.parentNode.localName === 'details') { n.parentNode.open = !n.parentNode.open; dispatch(n.parentNode, new Event('toggle')); return; }
    }
  }
  function fireChange(n) {
    dispatch(n, new InputEvent('input', { bubbles: true, composed: true }));
    dispatch(n, new Event('change', { bubbles: true }));
  }
  // a select's option list, as a browser shows it on a press: a box of the
  // options under the select, over the page (the last element of body), closed by a choice, a press
  // elsewhere or Escape
  var picker = null;
  function pickerOpenFor(sel) {
    pickerClose();
    var r = sel.getBoundingClientRect(), cs = getComputedStyle(sel);
    var box = doc.createElement('div');
    box.setAttribute('data-rd-picker', '');
    box.style.cssText = 'position:fixed;z-index:2147483647;box-sizing:border-box;background:#fff;border:1px solid #767676;border-radius:4px;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.25);padding:2px 0;color:#000;white-space:nowrap;overflow:hidden;' +
      'font-family:' + (cs.fontFamily || 'sans-serif').replace(/;/g, '') + ';font-size:' + (cs.fontSize || '16px') + ';line-height:1.25;' +
      'left:' + Math.round(r.left) + 'px;top:' + Math.round(r.bottom + 1) + 'px;width:' + Math.round(r.width) + 'px';
    var opts = sel.options, items = [];
    for (var i = 0; i < opts.length; i++) {
      var it = doc.createElement('div');
      it.textContent = opts[i].text || ' ';
      it.style.cssText = 'padding:2px 8px;' + (opts[i].disabled ? 'color:#888;' : '');
      it._pickIndex = i;
      box.appendChild(it);
      items.push(it);
    }
    (doc.body || doc.documentElement).appendChild(box);
    picker = { sel: sel, box: box, items: items, at: sel.selectedIndex, kind: 'select' };
    pickerMark(picker.at);
  }
  function pickerMark(i) {
    if (!picker) return;
    picker.at = i;
    for (var k = 0; k < picker.items.length; k++) {
      picker.items[k].style.backgroundColor = k === i ? 'rgb(30, 144, 255)' : '';
      picker.items[k].style.color = k === i ? '#fff' : (picker.sel.options[k] && picker.sel.options[k].disabled ? '#888' : '');
    }
  }
  function pickerClose() {
    if (!picker) return;
    if (picker.box.parentNode) picker.box.parentNode.removeChild(picker.box);
    picker = null;
  }
  function pickerChoose(i) {
    if (!picker || picker.kind !== 'select') { pickerClose(); return; }
    var sel = picker.sel, o = sel.options[i];
    pickerClose();
    if (o && !o.disabled && sel.selectedIndex !== i) { sel.selectedIndex = i; fireChange(sel); }
  }
  function pickerItemOf(t) {
    for (var n = t; n && n.nodeType === 1; n = n.parentNode) if ((n._pickIndex !== undefined || n._pickAct) && picker && picker.box.contains(n)) return n;
    return null;
  }
  // ---- the pickers of the input types a browser draws itself ---------------
  // (date, datetime-local, week, month: a calendar; time: hour, minute and
  // AM/PM columns; color: swatches), as Chromium opens them on a press: a
  // box under the field over the page, en-US as the field shows its value,
  // closed by a choice that ends it, a press elsewhere or Escape
  var POP_BLUE = 'rgb(26, 115, 232)';
  function popOpen(ctl) {
    var t = ctl.type;
    if (t === 'date' || t === 'datetime-local' || t === 'week' || t === 'month') calOpen(ctl);
    else if (t === 'time') timeOpen(ctl);
    else if (t === 'color') colorOpen(ctl);
  }
  function popBox(ctl, w) {
    pickerClose();
    var r = ctl.getBoundingClientRect();
    var box = doc.createElement('div');
    box.setAttribute('data-rd-picker', '');
    box.style.cssText = 'position:fixed;z-index:2147483647;box-sizing:border-box;background:#fff;border:1px solid #c6c6c6;border-radius:4px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25);color:#000;font:13px Arial,sans-serif;line-height:normal;white-space:nowrap;text-align:left;' +
      'left:' + Math.round(r.left) + 'px;top:' + Math.round(r.bottom + 1) + 'px;' + (w ? 'width:' + w + 'px;' : '');
    (doc.body || doc.documentElement).appendChild(box);
    picker = { sel: ctl, box: box, items: [], at: -1, kind: ctl.type };
    return box;
  }
  function popEl(parent, css, text, act) {
    var e = doc.createElement('div');
    if (css) e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    if (act) e._pickAct = act;
    parent.appendChild(e);
    return e;
  }
  function popClear(box) { while (box.firstChild) box.removeChild(box.firstChild); }
  // the control's value set as a choice in its picker sets it
  function popSet(ctl, v, close) {
    if (close) pickerClose();
    if (ctl.value !== v) { ctl.value = v; fireChange(ctl); }
  }
  function popToday() { var d = new Date(); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() }; }
  function ymd(y, m, d) { return pad(y, 4) + '-' + pad(m + 1, 2) + '-' + pad(d, 2); }
  function popRange(ctl) {
    var t = ctl.type, mn = ctl.getAttribute('min') || '', mx = ctl.getAttribute('max') || '';
    // (a datetime-local's bounds: their dates; a week's: a day of it)
    var day = function (s) { if (t === 'datetime-local') return s.split('T')[0]; if (t === 'week' && s) { var tmp = { type: 'week', value: s }; var n = valueAsNumberOf(tmp); return isNaN(n) ? '' : formatNumberValue({ type: 'date' }, n); } return s; };
    return [day(mn), day(mx)];
  }
  // a calendar: the month shown (picker.view), its days, today's outline,
  // the chosen day (or week) on blue; the title's ▾ shows the months of a
  // year (and a month field shows nothing else)
  function calOpen(ctl) {
    var t = ctl.type, v = ctl.value, td = popToday(), y = td.y, m = td.m;
    if (v) {
      if (t === 'week') { var wd = new Date(valueAsNumberOf(ctl)); y = wd.getUTCFullYear(); m = wd.getUTCMonth(); }
      else { var p = v.split('T')[0].split('-'); y = +p[0]; m = +p[1] - 1; }
    }
    popBox(ctl, t === 'datetime-local' ? 420 : t === 'week' ? 296 : t === 'month' ? 250 : 266);
    picker.view = { y: y, m: m, months: t === 'month' };
    calDraw();
  }
  function calDraw() {
    var p = picker, ctl = p.sel, t = ctl.type, vw = p.view, box = p.box;
    popClear(box);
    var row = popEl(box, 'display:flex;align-items:stretch');
    var cal = popEl(row, 'flex:1 1 auto;padding:8px 10px 6px');
    var head = popEl(cal, 'display:flex;align-items:center;height:30px;margin-bottom:4px');
    var title = vw.months ? String(vw.y) : MONTHS[vw.m] + ' ' + vw.y;
    popEl(head, 'flex:1 1 auto;font-weight:bold;font-size:15px;padding-left:4px', title + (t === 'month' ? '' : ' ▾'), t === 'month' ? null : function () { vw.months = !vw.months; calDraw(); });
    var step = function (k) { return function () { if (vw.months) vw.y += k; else { vw.m += k; if (vw.m < 0) { vw.m = 11; vw.y--; } else if (vw.m > 11) { vw.m = 0; vw.y++; } } calDraw(); }; };
    popEl(head, 'width:30px;text-align:center;font-size:20px', '↑', step(-1));
    popEl(head, 'width:30px;text-align:center;font-size:20px', '↓', step(1));
    var lim = popRange(ctl), td = popToday(), v = ctl.value;
    if (vw.months) {
      // the months of the year shown
      var grid = popEl(cal, 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px 0');
      var cur = t === 'month' ? v : v ? v.slice(0, 7) : '';
      for (var mi = 0; mi < 12; mi++) {
        var key = pad(vw.y, 4) + '-' + pad(mi + 1, 2), on = key === cur;
        var off = (lim[0] && key < lim[0].slice(0, 7)) || (lim[1] && key > lim[1].slice(0, 7));
        popEl(grid, 'height:34px;line-height:34px;text-align:center;border-radius:3px;' + (on ? 'background:' + POP_BLUE + ';color:#fff;font-weight:bold;' : off ? 'color:#bbb;' : ''),
          MONTHS[mi].slice(0, 3), off ? null : (function (k, mm) { return function () { if (t === 'month') popSet(ctl, k, true); else { vw.m = mm; vw.months = false; calDraw(); } }; })(key, mi));
      }
    } else {
      // the days: weeks from Sunday (a week field's from Monday, its number first)
      var iso = t === 'week', cols = iso ? 8 : 7;
      var grid2 = popEl(cal, 'display:grid;grid-template-columns:repeat(' + cols + ',1fr);row-gap:2px');
      var names = iso ? ['', 'M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      for (var ni = 0; ni < names.length; ni++) popEl(grid2, 'height:28px;line-height:28px;text-align:center;font-weight:bold' + (iso && !ni ? ';color:#777;font-weight:normal' : ''), names[ni]);
      var first = new Date(Date.UTC(vw.y, vw.m, 1)).getUTCDay(), lead = iso ? (first + 6) % 7 : first;
      var start = Date.UTC(vw.y, vw.m, 1) - lead * 86400000;
      var chosenDay = t === 'date' ? v : t === 'datetime-local' ? v.split('T')[0] : '';
      var chosenWeek = t === 'week' ? v : '';
      for (var w = 0; w < 6; w++) {
        var wk = formatNumberValue({ type: 'week' }, start + w * 7 * 86400000);
        if (iso) popEl(grid2, 'height:30px;line-height:30px;text-align:center;color:#777;font-size:11px', String(+wk.split('W')[1]));
        for (var dd = 0; dd < 7; dd++) {
          var at = new Date(start + (w * 7 + dd) * 86400000), Y = at.getUTCFullYear(), M = at.getUTCMonth(), D = at.getUTCDate(), key2 = ymd(Y, M, D);
          var inMonth = M === vw.m, isToday = Y === td.y && M === td.m && D === td.d;
          var sel = key2 === chosenDay || (chosenWeek && wk === chosenWeek);
          var out = (lim[0] && key2 < lim[0]) || (lim[1] && key2 > lim[1]);
          var css = 'height:30px;line-height:28px;text-align:center;box-sizing:border-box;border:1px solid transparent;border-radius:3px;';
          if (sel) css += 'background:' + POP_BLUE + ';color:#fff;font-weight:bold;';
          else if (out) css += 'color:#c8c8c8;';
          else if (!inMonth) css += 'color:#767676;';
          if (isToday && !sel) css += 'border-color:#767676;';
          popEl(grid2, css, String(D), out ? null : (function (k, wkey) { return function () { calPick(k, wkey); }; })(key2, wk));
        }
      }
    }
    // Clear and Today (This week, This month)
    var foot = popEl(cal, 'display:flex;justify-content:space-between;padding:6px 4px 2px;color:' + POP_BLUE);
    popEl(foot, '', 'Clear', function () { popSet(ctl, '', true); });
    popEl(foot, '', t === 'week' ? 'This week' : t === 'month' ? 'This month' : 'Today', function () {
      var tn = popToday(), tk = ymd(tn.y, tn.m, tn.d);
      if (t === 'month') popSet(ctl, tk.slice(0, 7), true);
      else calPick(tk, formatNumberValue({ type: 'week' }, Date.UTC(tn.y, tn.m, tn.d)));
    });
    // a datetime-local's time: the clock's columns beside the calendar
    if (t === 'datetime-local') { var side = popEl(row, 'border-left:1px solid #e0e0e0;display:flex'); clockColumns(side, ctl); }
  }
  function calPick(day, week) {
    var ctl = picker.sel, t = ctl.type;
    if (t === 'date') popSet(ctl, day, true);
    else if (t === 'week') popSet(ctl, week, true);
    else if (t === 'datetime-local') {
      var tm = ctl.value ? ctl.value.split('T')[1] : (function () { var n = popToday(); return pad(n.h, 2) + ':' + pad(n.mi, 2); })();
      popSet(ctl, day + 'T' + tm, false);
      var p = day.split('-');
      picker.view.y = +p[0]; picker.view.m = +p[1] - 1;
      calDraw();
    }
  }
  // a time's columns: hours 01-12, minutes, AM/PM, each scrolled to the
  // chosen one; a press sets that part and leaves the picker open
  function timeOpen(ctl) {
    var box = popBox(ctl, 3 * 62 + 2);
    var row = popEl(box, 'display:flex');
    clockColumns(row, ctl);
  }
  var CLOCK_ROW = 32;
  function clockParts(ctl) {
    var v = ctl.type === 'datetime-local' ? (ctl.value.split('T')[1] || '') : ctl.value, m = TIME_RE.exec(v);
    if (!m) return null;
    return { h: +m[1], mi: +m[2], rest: v.slice(5) };
  }
  function clockColumns(row, ctl) {
    var cols = [], parts = clockParts(ctl);
    var col = function (labels, which) {
      var c = popEl(row, 'width:56px;height:' + (CLOCK_ROW * 7) + 'px;overflow-y:auto;scrollbar-width:none;padding:4px 3px;box-sizing:content-box');
      var cells = [];
      for (var i = 0; i < labels.length; i++) cells.push(popEl(c, 'height:' + (CLOCK_ROW - 2) + 'px;line-height:' + (CLOCK_ROW - 2) + 'px;margin-bottom:2px;text-align:center;border-radius:3px;font-size:15px', labels[i], (function (k) { return function () { clockSet(ctl, which, k); }; })(i)));
      cols.push({ el: c, cells: cells, which: which });
    };
    var hrs = [], mins = [];
    for (var h = 1; h <= 12; h++) hrs.push(pad(h, 2));
    for (var mm = 0; mm < 60; mm++) mins.push(pad(mm, 2));
    col(hrs, 'h'); col(mins, 'm'); col(['AM', 'PM'], 'ap');
    picker.clock = cols;
    clockMark(ctl, true);
  }
  function clockMark(ctl, scroll) {
    var parts = clockParts(ctl), cols = picker && picker.clock;
    if (!cols) return;
    for (var ci = 0; ci < cols.length; ci++) {
      var c = cols[ci], at = -1;
      if (parts) at = c.which === 'h' ? (parts.h % 12 || 12) - 1 : c.which === 'm' ? parts.mi : parts.h < 12 ? 0 : 1;
      for (var k = 0; k < c.cells.length; k++) {
        c.cells[k].style.backgroundColor = k === at ? POP_BLUE : '';
        c.cells[k].style.color = k === at ? '#fff' : '';
        c.cells[k].style.fontWeight = k === at ? 'bold' : '';
      }
      if (scroll && at >= 0 && c.which !== 'ap') c.el.scrollTop = at * CLOCK_ROW;
    }
  }
  function clockSet(ctl, which, k) {
    var p = clockParts(ctl) || { h: 0, mi: 0, rest: '' }, h = p.h, mi = p.mi;
    if (which === 'h') h = (k + 1) % 12 + (h >= 12 ? 12 : 0);
    else if (which === 'm') mi = k;
    else h = h % 12 + (k ? 12 : 0);
    var tm = pad(h, 2) + ':' + pad(mi, 2) + p.rest;
    if (ctl.type === 'datetime-local') {
      var day = ctl.value ? ctl.value.split('T')[0] : (function () { var n = popToday(); return ymd(n.y, n.m, n.d); })();
      popSet(ctl, day + 'T' + tm, false);
    } else popSet(ctl, tm, false);
    clockMark(ctl, false);
  }
  // a color's swatches, the chosen one outlined, and its hex value
  var SWATCHES = ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#efefef', '#ffffff',
    '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff',
    '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3',
    '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc', '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599',
    '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd', '#cc4125', '#e06666',
    '#3366cc', '#3c78d8', '#6aa84f', '#45818e', '#1155cc', '#674ea7', '#a61c00', '#85200c'];
  function colorOpen(ctl) {
    var box = popBox(ctl, 8 * 22 + 7 * 4 + 22);
    var grid = popEl(box, 'display:grid;grid-template-columns:repeat(8,22px);gap:4px;padding:10px');
    for (var i = 0; i < SWATCHES.length; i++) {
      var on = SWATCHES[i] === ctl.value;
      popEl(grid, 'width:22px;height:22px;box-sizing:border-box;border-radius:2px;background:' + SWATCHES[i] + ';border:' + (on ? '2px solid #000' : '1px solid rgba(0,0,0,.2)'), undefined, (function (c) { return function () { popSet(ctl, c, true); }; })(SWATCHES[i]));
    }
    var foot = popEl(box, 'display:flex;align-items:center;gap:8px;padding:0 10px 10px');
    popEl(foot, 'width:34px;height:22px;border:1px solid #999;box-sizing:border-box;background:' + ctl.value);
    popEl(foot, 'font:13px monospace', ctl.value.toUpperCase());
  }
  // a range's thumb follows a press and a drag: the value at x, snapped
  // to the step, an input event at each change and change at the release
  // (the thumb 16px wide, Chromium's, its centre on the value)
  var rangeDrag = null;
  function rangeAt(el, x) {
    var r = el.getBoundingClientRect(), b = rangeBounds(el), f = r.width > 16 ? (x - r.left - 8) / (r.width - 16) : 0;
    f = Math.max(0, Math.min(1, f));
    var was = el.value;
    el.value = String(b[0] + f * (b[1] - b[0]));
    if (el.value !== was) dispatch(el, new InputEvent('input', { bubbles: true, composed: true }));
  }
  // a list box (select multiple, or size > 1): the option under a press,
  // by its line; Ctrl (Cmd) toggles it, Shift selects from the last one
  // pressed, else it alone is selected
  function listPress(el, m) {
    var r = el.getBoundingClientRect(), e = edgesOf(el), cs = computedOf(el);
    var fs = parseFloat(cs['font-size']) || 13.333, lh = parseFloat(cs['line-height']);
    if (!(lh > 0)) lh = Math.round(fs * 1.15);
    var i = Math.floor((m.y - r.top - e.bt - e.pt + (el.scrollTop || 0)) / lh), opts = el.options;
    if (i < 0 || i >= opts.length || opts[i].disabled) return;
    var before = opts.map(function (o) { return o.selected; }).join();
    if (el.multiple && (m.ctrl || m.meta)) { opts[i].selected = !opts[i].selected; el._anchor = i; }
    else if (el.multiple && m.shift && el._anchor !== undefined) {
      var a = Math.min(el._anchor, i), z = Math.max(el._anchor, i);
      for (var k = 0; k < opts.length; k++) opts[k].selected = k >= a && k <= z && !opts[k].disabled;
    } else {
      for (var k2 = 0; k2 < opts.length; k2++) opts[k2].selected = k2 === i;
      el._anchor = i;
    }
    if (opts.map(function (o) { return o.selected; }).join() !== before) fireChange(el);
  }
  // an editing host's caret: where a press puts it (the text offset
  // nearest x in the element pressed), and the box drawn for it over the
  // page while the host has focus and the selection is a caret in it
  function editPress(t, m) {
    var host = t;
    while (host && host.nodeType === 1 && !(host.isContentEditable && (!host.parentNode || host.parentNode.nodeType !== 1 || !host.parentNode.isContentEditable))) host = host.parentNode;
    if (!host || host.nodeType !== 1) return;
    var c = caretIn(t, m.x) || caretIn(host, m.x);
    if (c) selection.collapse(c[0], c[1]);
    else { var rr = new Range(doc); rr.selectNodeContents(t); rr.collapse(false); selection.removeAllRanges(); selection.addRange(rr); }
    changed();
  }
  var caretDrawn = null;
  function editCaretBox() {
    var el = doc && doc._active;
    if (!el || el.nodeType !== 1 || !el.isContentEditable || !el.isConnected || !selection._ranges.length) return null;
    var r = selection._ranges[0];
    if (!r.collapsed || !el.contains(r.startContainer)) return null;
    var p = pointX(r.startContainer, r.startOffset);
    if (!p) return null;
    var tp = r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer;
    if (!tp || tp.nodeType !== 1 || !boxes[tp.__id]) return null;
    var cs = computedOf(tp), e = edgesOf(tp), rr = rectOf(tp);
    var fs = parseFloat(cs['font-size']) || 16, lh = parseFloat(cs['line-height']);
    if (!(lh > 0)) lh = fs * 1.15;
    var h = Math.round(Math.min(lh, fs * 1.2)), top = rr.top + e.bt + e.pt + Math.max(0, (lh - h) / 2);
    var col = cs['caret-color'] && cs['caret-color'] !== 'auto' ? cs['caret-color'] : cs.color || '#000';
    return { i: 'rdcaret', t: 'div', s: { display: 'block', position: 'fixed', left: Math.round(p.x) + 'px', top: Math.round(top) + 'px', width: '1px', height: h + 'px', 'background-color': col } };
  }
  // the caret moved by Left, Right, Home and End: through the host's text
  function editMove(host, k, shift) {
    var texts = [];
    (function walk(n) { for (var i = 0; i < n._c.length; i++) { var c = n._c[i]; if (c.nodeType === 3) texts.push(c); else if (c.nodeType === 1) walk(c); } })(host);
    if (!texts.length) return;
    var r = selection._ranges[0], at = 0, total = 0, pos = -1;
    for (var i = 0; i < texts.length; i++) { if (r && texts[i] === r.endContainer) pos = total + r.endOffset; total += texts[i].data.length; }
    if (pos < 0) pos = total;
    var to = k === 'Home' ? 0 : k === 'End' ? total : k === 'ArrowLeft' ? pos - 1 : pos + 1;
    to = Math.max(0, Math.min(total, to));
    for (var j = 0; j < texts.length; j++) {
      var len = texts[j].data.length;
      if (to <= at + len || j === texts.length - 1) { selection.collapse(texts[j], to - at); break; }
      at += len;
    }
    changed();
  }
  // a file field's chooser is the host's: it is asked for files
  // ({tag: "pick-file", id, multiple, accept}) and answers with __setFiles
  function askFiles(el) {
    if (typeof G.__post === 'function') G.__post({ tag: 'pick-file', id: el.__id, multiple: el.hasAttribute('multiple'), accept: el.getAttribute('accept') || '' });
  }
  // a text field's caret at a press: the offset nearest x (a textarea's on
  // the line at y), as its text is drawn from the content box's left
  function fieldPress(el, m) {
    var v = el.type === 'password' ? el.value.replace(/./g, '\u2022') : el.value;
    var r = el.getBoundingClientRect(), e = edgesOf(el), cs = computedOf(el);
    var fs = parseFloat(cs['font-size']) || 13.333, w8 = cs['font-weight'] || '400';
    var lineStart = 0, line = v;
    if (el.localName === 'textarea') {
      var lh = parseFloat(cs['line-height']);
      if (!(lh > 0)) lh = Math.round(fs * 1.15);
      var lines = v.split('\n'), li = Math.max(0, Math.min(lines.length - 1, Math.floor((m.y - r.top - e.bt - e.pt + (el.scrollTop || 0)) / lh)));
      for (var q = 0; q < li; q++) lineStart += lines[q].length + 1;
      line = lines[li];
    }
    var x0 = r.left + e.bl + e.pl - (el.scrollLeft || 0), best = 0, bestD = Infinity;
    for (var o = 0; o <= line.length; o++) {
      var d = Math.abs(x0 + canvasTextWidth(line.slice(0, o), { size: fs, weight: w8 }) - m.x);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (m.shift && doc._active === el) selectRange(el, el._sd === 'backward' ? el._se : el._ss, lineStart + best);
    else { el._ss = el._se = lineStart + best; el._sd = 'none'; }
    changed();
  }
  function submitForm(btn) {
    var f = btn.form;
    if (!f) return;
    var ev = new Event('submit', { bubbles: true, cancelable: true });
    ev.submitter = btn;
    dispatch(f, ev);
  }

  // ---- mutation observers --------------------------------------------------

  var observers = [];
  var mutationQueued = false;
  class MutationRecord {
    constructor(type, target, x) {
      this.type = type; this.target = target;
      this.addedNodes = NodeList(x.addedNodes || []); this.removedNodes = NodeList(x.removedNodes || []);
      this.previousSibling = x.previousSibling || null; this.nextSibling = x.nextSibling || null;
      this.attributeName = x.attributeName || null; this.attributeNamespace = null;
      this.oldValue = x.oldValue === undefined ? null : x.oldValue;
    }
  }
  class MutationObserver {
    constructor(cb) { if (typeof cb !== 'function') throw new TypeError("Failed to construct 'MutationObserver': parameter 1 is not of type 'MutationCallback'."); this._cb = cb; this._targets = []; this._records = []; }
    observe(target, opts) {
      opts = opts || {};
      if (opts.attributeFilter || opts.attributeOldValue) opts.attributes = true;
      if (opts.characterDataOldValue) opts.characterData = true;
      for (var i = 0; i < this._targets.length; i++) if (this._targets[i].node === target) { this._targets[i].opts = opts; return; }
      this._targets.push({ node: target, opts: opts });
      if (observers.indexOf(this) < 0) observers.push(this);
    }
    disconnect() { this._targets = []; this._records = []; var i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1); }
    takeRecords() { var r = this._records; this._records = []; return r; }
  }
  function queueMutation(target, type, x) {
    if (!observers.length) return;
    for (var i = 0; i < observers.length; i++) {
      var o = observers[i];
      for (var j = 0; j < o._targets.length; j++) {
        var t = o._targets[j], op = t.opts;
        if (t.node !== target && !(op.subtree && t.node.contains(target))) continue;
        if (type === 'childList' && !op.childList) continue;
        if (type === 'attributes' && (!op.attributes || (op.attributeFilter && op.attributeFilter.indexOf(x.attributeName) < 0))) continue;
        if (type === 'characterData' && !op.characterData) continue;
        var keepOld = (type === 'attributes' && op.attributeOldValue) || (type === 'characterData' && op.characterDataOldValue);
        var rec = new MutationRecord(type, target, keepOld ? x : { addedNodes: x.addedNodes, removedNodes: x.removedNodes, previousSibling: x.previousSibling, nextSibling: x.nextSibling, attributeName: x.attributeName });
        o._records.push(rec);
        break;
      }
    }
    if (!mutationQueued) {
      mutationQueued = true;
      Promise.resolve().then(deliverMutations);
    }
  }
  function deliverMutations() {
    mutationQueued = false;
    var list = observers.slice();
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o._records.length) continue;
      var r = o.takeRecords();
      try { o._cb.call(o, r, o); } catch (e) { reportError(e); }
    }
  }

  // ---- geometry: DOMMatrix, DOMPoint ---------------------------------------

  // a 4x4 matrix in column-major m11..m44, a..f its 2D part; built from
  // nothing, 6 or 16 numbers, or a CSS transform list (the computed
  // `matrix(...)` or what a page writes: translate, scale, rotate, skew)
  var M_KEYS = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'];
  function cssAngle(s) {
    var v = parseFloat(s) || 0;
    if (/turn$/.test(s)) return v * 2 * Math.PI;
    if (/grad$/.test(s)) return v * Math.PI / 200;
    if (/rad$/.test(s)) return v;
    return v * Math.PI / 180;
  }
  function transformList(s) {
    var m = new DOMMatrix();
    s = String(s).trim();
    if (s === '' || s === 'none') return m;
    var re = /([a-zA-Z0-9]+)\(([^)]*)\)/g, f, any = false;
    while ((f = re.exec(s))) {
      any = true;
      var name = f[1], raw = f[2].split(/\s*,\s*|\s+/).filter(function (x) { return x !== ''; });
      var n = raw.map(function (x) { return parseFloat(x) || 0; });
      var t;
      if (name === 'matrix') t = new DOMMatrix(n.slice(0, 6));
      else if (name === 'matrix3d') t = new DOMMatrix(n.slice(0, 16));
      else if (name === 'translate') t = new DOMMatrix([1, 0, 0, 1, n[0] || 0, n[1] || 0]);
      else if (name === 'translateX') t = new DOMMatrix([1, 0, 0, 1, n[0] || 0, 0]);
      else if (name === 'translateY') t = new DOMMatrix([1, 0, 0, 1, 0, n[0] || 0]);
      else if (name === 'translate3d') t = new DOMMatrix().translate(n[0], n[1], n[2]);
      else if (name === 'scale') t = new DOMMatrix([n[0], 0, 0, n.length > 1 ? n[1] : n[0], 0, 0]);
      else if (name === 'scaleX') t = new DOMMatrix([n[0], 0, 0, 1, 0, 0]);
      else if (name === 'scaleY') t = new DOMMatrix([1, 0, 0, n[0], 0, 0]);
      else if (name === 'rotate' || name === 'rotateZ') { var a = cssAngle(raw[0] || '0'); t = new DOMMatrix([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); }
      else if (name === 'skewX') t = new DOMMatrix([1, 0, Math.tan(cssAngle(raw[0] || '0')), 1, 0, 0]);
      else if (name === 'skewY') t = new DOMMatrix([1, Math.tan(cssAngle(raw[0] || '0')), 0, 1, 0, 0]);
      else if (name === 'skew') t = new DOMMatrix([1, Math.tan(cssAngle(raw[1] || '0')), Math.tan(cssAngle(raw[0] || '0')), 1, 0, 0]);
      else throw new SyntaxError("Failed to construct 'DOMMatrix': Failed to parse '" + s + "'.");
      m.multiplySelf(t);
    }
    if (!any) throw new SyntaxError("Failed to construct 'DOMMatrix': Failed to parse '" + s + "'.");
    return m;
  }
  class DOMMatrix {
    constructor(init) {
      var v = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      this.is2D = true;
      if (typeof init === 'string') {
        var p = transformList(init);
        v = M_KEYS.map(function (k) { return p[k]; });
        this.is2D = p.is2D;
      } else if (init && init.length === 6) {
        v[0] = +init[0]; v[1] = +init[1]; v[4] = +init[2]; v[5] = +init[3]; v[12] = +init[4]; v[13] = +init[5];
      } else if (init && init.length === 16) {
        v = Array.prototype.map.call(init, Number);
        this.is2D = false;
      } else if (init !== undefined && init !== null && !(init.length === 0)) {
        throw new TypeError("Failed to construct 'DOMMatrix': The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.");
      }
      for (var i = 0; i < 16; i++) this[M_KEYS[i]] = v[i];
    }
    get a() { return this.m11; } set a(x) { this.m11 = x; }
    get b() { return this.m12; } set b(x) { this.m12 = x; }
    get c() { return this.m21; } set c(x) { this.m21 = x; }
    get d() { return this.m22; } set d(x) { this.m22 = x; }
    get e() { return this.m41; } set e(x) { this.m41 = x; }
    get f() { return this.m42; } set f(x) { this.m42 = x; }
    get isIdentity() { var me = this; return M_KEYS.every(function (k, i) { return me[k] === (i % 5 === 0 ? 1 : 0); }); }
    static fromMatrix(o) { o = o || {}; if (o instanceof DOMMatrix) return new DOMMatrix(M_KEYS.map(function (k) { return o[k]; })); return new DOMMatrix([o.a === undefined ? 1 : o.a, o.b || 0, o.c || 0, o.d === undefined ? 1 : o.d, o.e || 0, o.f || 0]); }
    static fromFloat32Array(a) { return new DOMMatrix(Array.from(a)); }
    static fromFloat64Array(a) { return new DOMMatrix(Array.from(a)); }
    // this = this × o (o applied first to a point)
    multiplySelf(o) {
      if (!(o instanceof DOMMatrix)) o = DOMMatrix.fromMatrix(o);
      var a = M_KEYS.map(function (k) { return this[k]; }, this), b = M_KEYS.map(function (k) { return o[k]; }), r = [];
      for (var col = 0; col < 4; col++) for (var row = 0; row < 4; row++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
        r[col * 4 + row] = s;
      }
      for (var i = 0; i < 16; i++) this[M_KEYS[i]] = r[i];
      this.is2D = this.is2D && o.is2D;
      return this;
    }
    preMultiplySelf(o) { var r = DOMMatrix.fromMatrix(o).multiplySelf(this); for (var i = 0; i < 16; i++) this[M_KEYS[i]] = r[M_KEYS[i]]; this.is2D = r.is2D; return this; }
    translateSelf(x, y, z) { var t = new DOMMatrix(); t.m41 = x || 0; t.m42 = y || 0; t.m43 = z || 0; if (z) t.is2D = false; return this.multiplySelf(t); }
    scaleSelf(sx, sy, sz, ox, oy, oz) {
      if (sx === undefined) sx = 1;
      if (sy === undefined) sy = sx;
      if (sz === undefined) sz = 1;
      ox = ox || 0; oy = oy || 0; oz = oz || 0;
      var t = new DOMMatrix([sx, 0, 0, sy, 0, 0]); t.m33 = sz; if (sz !== 1 || oz) t.is2D = false;
      return this.translateSelf(ox, oy, oz).multiplySelf(t).translateSelf(-ox, -oy, -oz);
    }
    rotateSelf(rx, ry, rz) {
      if (ry === undefined && rz === undefined) { rz = rx; rx = 0; ry = 0; }
      var a = (rz || 0) * Math.PI / 180;
      return this.multiplySelf(new DOMMatrix([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]));
    }
    skewXSelf(s) { return this.multiplySelf(new DOMMatrix([1, 0, Math.tan((s || 0) * Math.PI / 180), 1, 0, 0])); }
    skewYSelf(s) { return this.multiplySelf(new DOMMatrix([1, Math.tan((s || 0) * Math.PI / 180), 0, 1, 0, 0])); }
    invertSelf() {
      // 2D inverse (what pages ask of a CSS transform); 3D through the adjugate
      var m = M_KEYS.map(function (k) { return this[k]; }, this), inv = [];
      inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
      inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
      inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
      inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
      inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
      inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
      inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
      inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
      inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
      inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
      inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
      inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
      inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
      inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
      inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
      inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
      var det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
      for (var i = 0; i < 16; i++) this[M_KEYS[i]] = det ? inv[i] / det : NaN;
      if (!det) this.is2D = false;
      return this;
    }
    multiply(o) { return DOMMatrix.fromMatrix(this).multiplySelf(o); }
    translate(x, y, z) { return DOMMatrix.fromMatrix(this).translateSelf(x, y, z); }
    scale(sx, sy, sz, ox, oy, oz) { return DOMMatrix.fromMatrix(this).scaleSelf(sx, sy, sz, ox, oy, oz); }
    scaleNonUniform(sx, sy) { return this.scale(sx, sy === undefined ? 1 : sy); }
    rotate(rx, ry, rz) { return DOMMatrix.fromMatrix(this).rotateSelf(rx, ry, rz); }
    skewX(s) { return DOMMatrix.fromMatrix(this).skewXSelf(s); }
    skewY(s) { return DOMMatrix.fromMatrix(this).skewYSelf(s); }
    inverse() { return DOMMatrix.fromMatrix(this).invertSelf(); }
    flipX() { return this.multiply(new DOMMatrix([-1, 0, 0, 1, 0, 0])); }
    flipY() { return this.multiply(new DOMMatrix([1, 0, 0, -1, 0, 0])); }
    transformPoint(p) {
      p = p || {};
      var x = p.x || 0, y = p.y || 0, z = p.z || 0, w = p.w === undefined ? 1 : p.w;
      return new DOMPoint(
        this.m11 * x + this.m21 * y + this.m31 * z + this.m41 * w,
        this.m12 * x + this.m22 * y + this.m32 * z + this.m42 * w,
        this.m13 * x + this.m23 * y + this.m33 * z + this.m43 * w,
        this.m14 * x + this.m24 * y + this.m34 * z + this.m44 * w);
    }
    toFloat64Array() { var me = this; return new Float64Array(M_KEYS.map(function (k) { return me[k]; })); }
    toFloat32Array() { var me = this; return new Float32Array(M_KEYS.map(function (k) { return me[k]; })); }
    toJSON() { var o = { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f, is2D: this.is2D, isIdentity: this.isIdentity }; for (var i = 0; i < 16; i++) o[M_KEYS[i]] = this[M_KEYS[i]]; return o; }
    toString() {
      var me = this;
      if (this.is2D) return 'matrix(' + [this.a, this.b, this.c, this.d, this.e, this.f].join(', ') + ')';
      return 'matrix3d(' + M_KEYS.map(function (k) { return me[k]; }).join(', ') + ')';
    }
  }
  class DOMPoint {
    constructor(x, y, z, w) { this.x = +(x || 0); this.y = +(y || 0); this.z = +(z || 0); this.w = w === undefined ? 1 : +w; }
    static fromPoint(p) { p = p || {}; return new DOMPoint(p.x, p.y, p.z, p.w); }
    matrixTransform(m) { return (m instanceof DOMMatrix ? m : DOMMatrix.fromMatrix(m)).transformPoint(this); }
    toJSON() { return { x: this.x, y: this.y, z: this.z, w: this.w }; }
  }

  // ---- layout feedback: boxes, observers -----------------------------------

  function DOMRect(x, y, w, h) {
    x = x || 0; y = y || 0; w = w || 0; h = h || 0;
    return { x: x, y: y, width: w, height: h, top: Math.min(y, y + h), left: Math.min(x, x + w), right: Math.max(x, x + w), bottom: Math.max(y, y + h), toJSON: function () { return { x: x, y: y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h }; } };
  }
  DOMRect.fromRect = function (r) { r = r || {}; return DOMRect(r.x, r.y, r.width, r.height); };
  // A size read after a change lays the page out now, as a browser's forced
  // layout does, when the host can (__hostSync with the render tree: the
  // boxes back). Golden Layout sizes its panes from the header it has just
  // inserted, and laid out a frame late every pane came out 2 px wide.
  var syncLayout = false, layoutGen = -1, reflowing = false;
  // The host's boxes: all of them, or what changed since the ones it sent
  // last ({"~":1,"set":{id:box},"gone":[ids]}; a host that keeps them,
  // DomView.boxesSince). A page of 4 000 boxes was 100 KB of JSON for every
  // forced layout and every frame, whatever changed.
  var boxesGone = 0, boxSeq = 0;
  function takeBoxes(m) {
    boxSeq++;
    if (m['~'] !== 1) { boxes = m; boxesGone = 0; return; }
    var set = m.set, gone = m.gone, k, i;
    for (k in set) boxes[k] = set[k];
    for (i = 0; i < gone.length; i++) boxes[gone[i]] = undefined;
    boxesGone += gone.length;
    // (the ids let go are taken out once they are many)
    if (boxesGone > 20000) {
      var keep = {};
      for (k in boxes) if (boxes[k] !== undefined) keep[k] = boxes[k];
      boxes = keep; boxesGone = 0;
    }
  }
  function reflow() {
    // (a script's scroll is drawn at the next frame, but what it reads now
    // is where the scroll took the box: rows left out that the viewport
    // reaches now render before the read)
    if (virts.length && scrollQueue.length && !reflowing) virtCheck(false);
    if (!syncLayout || reflowing || layoutGen === generation || !doc || !doc.documentElement) return;
    reflowing = true;
    try {
      // (again while virtual rows find the heights they guessed other)
      for (var vr = 0; vr < 4; vr++) {
        var json = render(deltaOn), g = generation, sb = scrollBumps, out = __hostSync(json);
        // (a host that does not have a node the delta names: everything again)
        if (out === '!' && deltaOn) { deltaEpoch++; json = render(true); out = __hostSync(json); if (out === '!') out = ''; }
        if (out) { takeBoxes(JSON.parse(out)); layoutGen = g; layoutSb = sb; if (scrollers.length) clampScrolls(); if (virts.length) virtCheck(true); }
        if (!virtAgain || layoutGen === generation) break;
        virtAgain = false;
      }
    } catch (e) { syncLayout = false; reportError(e); }
    reflowing = false;
  }
  function rectOf(el) {
    reflow();
    var b = boxes[el.__id];
    var vb = !b && virts.length ? virtBoxOf(el) : null;
    if (vb) b = vb;
    else if (vb === null && !b && virts.length && virtPin(el)) { reflow(); b = boxes[el.__id]; }
    if (!b) return DOMRect(0, 0, 0, 0);
    var sx = 0, sy = 0;
    // (the offsets as they are: the layout above has clamped them)
    for (var n = el.parentNode; n && n._attrs !== undefined; n = n.parentNode) { sx += n._sLeft || 0; sy += n._sTop || 0; }
    return DOMRect(b[0] - sx, b[1] - sy, b[2], b[3]);
  }
  // an element's laid-out border box size: under a scale (a zoomed
  // viewport) the host sends it after the drawn box (boxes[id][8..9]);
  // offsetWidth and ResizeObserver report it, getBoundingClientRect the
  // drawn box
  function layoutSize(el) {
    if (!sizesStand()) reflow();
    var b = boxes[el.__id];
    var vb = !b && virts.length ? virtBoxOf(el) : null;
    if (vb) b = vb;
    else if (vb === null && !b && virts.length && virtPin(el)) { reflow(); b = boxes[el.__id]; }
    if (!b) return textOnlySize(el);
    return b[8] !== undefined ? [b[8], b[9]] : [b[2], b[3]];
  }
  // an inline element (or an absolutely placed one of auto width) holding
  // only text and inline elements that the host has not laid out yet
  // (inserted since the last layout): its text measured in the face the
  // window draws it with, as a browser's synchronous layout would give it. Monaco reads its character widths from spans it inserts
  // and removes before any layout, and caches a line's width read right
  // after the line is written. Monospace is DejaVu Sans Mono in the window,
  // every glyph 1233/2048 em (desktop/app/dom_view.rs); other text by the
  // Helvetica table. [0, 0] for anything else.
  function textOnlySize(el) {
    if (!el.isConnected || !el._c || !el._c.length) return [0, 0];
    var r = inlineRun(el);
    if (!r && el.parentNode && el.parentNode.nodeType === 1 && boxes[el.parentNode.__id]) r = textBlockSize(el, computedOf(el), el.parentNode);
    return r || [0, 0];
  }
  function inlineRun(el, inner) {
    var cs = computedOf(el);
    // an inline box, or (outermost) an absolutely placed one of auto width,
    // which shrinks to its inline content
    var abs = !inner && (cs.position === 'absolute' || cs.position === 'fixed') && (!cs.width || cs.width === 'auto');
    if (cs.display !== 'inline' && !abs) return null;
    var size = parseFloat(cs['font-size']) || 16, ls = parseFloat(cs['letter-spacing']) || 0;
    var mono = /(^|,)\s*['"]?(monospace|dejavu sans mono)['"]?\s*(,|$)/i.test(cs['font-family'] || '');
    var lh = parseFloat(cs['line-height']), w = 0, h = isFinite(lh) && /px$/.test(cs['line-height']) ? lh : size * 1.2;
    for (var i = 0; i < el._c.length; i++) {
      var c = el._c[i];
      if (c.nodeType === 3) w += (mono ? c.data.length * size * 1233 / 2048 : canvasTextWidth(c.data, { size: size, weight: cs['font-weight'] || '400' })) + ls * c.data.length;
      else if (c.nodeType === 1) {
        var b = boxes[c.__id], k = b ? (b[8] !== undefined ? [b[8], b[9]] : [b[2], b[3]]) : inlineRun(c, true);
        if (!k) return null;
        w += k[0]; h = Math.max(h, k[1]);
      } else if (c.nodeType !== 8) return null;
    }
    return [w, h];
  }
  // a new block of text only, of a px or % width, under a laid-out parent:
  // its lines wrapped word by word at that width, as many line heights
  // tall (a virtual list measures a row the moment it puts it in, before
  // the host has laid it out: TanStack Virtual's measureElement)
  function textBlockSize(el, cs, p) {
    if (!/^(block|flow-root|list-item)$/.test(cs.display || '') || (cs.float && cs.float !== 'none')) return null;
    var txt = '';
    for (var i = 0; i < el._c.length; i++) { var c = el._c[i]; if (c.nodeType === 3) txt += c.data; else if (c.nodeType !== 8) return null; }
    var pe = edgesOf(p), pw = boxes[p.__id][2] - pe.bl - pe.br - pe.pl - pe.pr, wv = cs.width || 'auto', w;
    if (/px$/.test(wv)) w = parseFloat(wv);
    else if (/^[\d.]+%$/.test(wv)) w = pw * parseFloat(wv) / 100;
    else if (wv === 'auto' && cs.position !== 'absolute' && cs.position !== 'fixed') w = pw - (parseFloat(cs['margin-left']) || 0) - (parseFloat(cs['margin-right']) || 0);
    else return null;
    var ee = edgesOf(el), hx = ee.px + ee.bx, vx = ee.py + ee.by;
    var bw = cs['box-sizing'] === 'border-box' || wv === 'auto' ? w : w + hx, inner = bw - hx;
    if (!(inner > 0)) return null;
    var size = parseFloat(cs['font-size']) || 16, lh = parseFloat(cs['line-height']), lineH = isFinite(lh) && /px$/.test(cs['line-height']) ? lh : size * 1.15;
    var font = { size: size, weight: cs['font-weight'] || '400' }, lines = 0;
    var words = txt.replace(/\s+/g, ' ').trim();
    if (words) {
      var nowrap = /^(nowrap|pre)$/.test(cs['white-space'] || ''), parts = nowrap ? [words] : words.split(' '), cur = 0, space = canvasTextWidth(' ', font);
      lines = 1;
      for (var k = 0; k < parts.length; k++) {
        var ww = canvasTextWidth(parts[k], font);
        if (cur > 0 && cur + space + ww > inner + 0.01) { lines++; cur = ww; } else cur += (cur > 0 ? space : 0) + ww;
      }
    }
    var hv = cs.height || 'auto', h = /px$/.test(hv) ? parseFloat(hv) + (cs['box-sizing'] === 'border-box' ? 0 : vx) : lines * lineH + vx;
    return [bw, h];
  }
  // where such an element would be drawn: from its nearest laid-out
  // ancestor's content box, across the inline content before it (an
  // absolutely placed one at its left / top in px). Only for runs of inline
  // text, a few levels deep; null otherwise.
  function estimatedRect(el, depth) {
    depth = depth || 0;
    var p = el.parentNode;
    if (depth > 8 || !p || p.nodeType !== 1 || !el.isConnected) return null;
    var x, y;
    if (boxes[p.__id]) { var pr = rectOf(p), pe = edgesOf(p); x = pr.left + pe.bl + pe.pl; y = pr.top + pe.bt + pe.pt; }
    else { var er = estimatedRect(p, depth + 1); if (!er) return null; x = er.left; y = er.top; }
    var cs = computedOf(el), size = inlineRun(el);
    if (!size && boxes[p.__id]) size = textBlockSize(el, cs, p);
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      var l = parseFloat(cs.left), t = parseFloat(cs.top);
      x += isFinite(l) ? l : 0; y += isFinite(t) ? t : 0;
      if (!size) { var w = parseFloat(cs.width), h = parseFloat(cs.height); size = [isFinite(w) ? w : 0, isFinite(h) ? h : 0]; }
    } else {
      if (!size) return null;
      var pcs = computedOf(p), psize = parseFloat(pcs['font-size']) || 16;
      var pmono = /(^|,)\s*['"]?(monospace|dejavu sans mono)['"]?\s*(,|$)/i.test(pcs['font-family'] || '');
      for (var i = 0; i < p._c.length && p._c[i] !== el; i++) {
        var c = p._c[i];
        if (c.nodeType === 3) x += pmono ? c.data.length * psize * 1233 / 2048 : canvasTextWidth(c.data, { size: psize, weight: pcs['font-weight'] || '400' });
        else if (c.nodeType === 1) { var k = layoutSize(c); if (!boxes[c.__id] && !inlineRun(c, true)) return null; x += k[0]; }
      }
    }
    return DOMRect(x, y, size[0], size[1]);
  }
  function sizeOf(el, what) {
    if (!sizesStand()) reflow();
    return sizeNow(el, what);
  }
  // (as the boxes have it now, no layout)
  function sizeNow(el, what) {
    var b = boxes[el.__id];
    if (el === (doc && doc.documentElement) && (what === 'cw' || what === 'ch')) return what === 'cw' ? viewport.w : viewport.h;
    // (the page's scrolling area: the viewport, or the body past it, as
    // the wheel scrolls it, scrollBy)
    if (!b && el === (doc && doc.documentElement) && (what === 'sw' || what === 'sh')) return what === 'sw' ? Math.max(viewport.w, pageWidth()) : Math.round(Math.max(viewport.h, pageHeight()));
    if (!b) return 0;
    // client size: the padding box (the border box without its borders)
    if (what === 'cw') return Math.round(b[4] !== undefined ? b[4] : b[2] - edgesOf(el).bx);
    if (what === 'ch') return Math.round(b[5] !== undefined ? b[5] : b[3] - edgesOf(el).by);
    if (what === 'sw') return Math.round(b[6] !== undefined ? b[6] : b[2]);
    return Math.round(b[7] !== undefined ? b[7] : b[3]);
  }
  // an element's padding and border widths in px, and their sums across
  // (bx, by: borders; px, py: paddings)
  function edgesOf(el) {
    var cs = computedOf(el), n = function (k) { var v = parseFloat(cs[k]); return isFinite(v) ? v : 0; };
    var bs = function (side) { var st = cs['border-' + side + '-style']; return !st || st === 'none' || st === 'hidden' ? 0 : n('border-' + side + '-width'); };
    var e = { pl: n('padding-left'), pr: n('padding-right'), pt: n('padding-top'), pb: n('padding-bottom'), bl: bs('left'), br: bs('right'), bt: bs('top'), bb: bs('bottom') };
    e.bx = e.bl + e.br; e.by = e.bt + e.bb; e.px = e.pl + e.pr; e.py = e.pt + e.pb;
    return e;
  }
  function hittable(e) {
    var cs = computedOf(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs['pointer-events'] !== 'none';
  }
  function under(e, x, y) {
    if (!boxes[e.__id]) return true;
    var r = rectOf(e);
    return x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1;
  }
  // e or an ancestor has a transform: the host's hit test does not see it
  function transformedUnder(e) {
    for (var n = e; n && n.nodeType === 1; n = upFlat(n)) {
      var tr = computedOf(n).transform;
      if (tr && tr !== 'none') return true;
    }
    return false;
  }
  // Text geometry inside laid-out boxes (Range rects, caretRangeFromPoint):
  // the host lays out elements, not characters, so a text node's characters
  // share its parent's content box by their advance widths: equal widths in
  // a monospaced face (exact there), the Helvetica table's proportions
  // otherwise. One line per parent (no wrapping inside it).
  function monospaced(el) { return /mono|courier|consolas|menlo/i.test(computedOf(el)['font-family'] || ''); }
  function textParent(n) { var el = n.parentNode; return el && el.nodeType === 1 && (boxes[el.__id] || estimatedRect(el)) ? el : null; }
  // [left, top, width, height] of el's content box and its text measured,
  // with the text before node in el
  function textFrame(el) {
    var r = boxes[el.__id] ? rectOf(el) : estimatedRect(el), e = edgesOf(el);
    var cs = computedOf(el);
    return { x: r.left + e.bl + e.pl, y: r.top, w: Math.max(0, r.width - e.bx - e.px), h: r.height, mono: monospaced(el), text: el.textContent || '', fs: parseFloat(cs['font-size']) || 16, align: cs['text-align'] || 'start', weight: cs['font-weight'] || '400' };
  }
  // the x of the text before a point: its own width when the text fits on
  // its line (where text-align puts it), else its share of the line
  function textX(f, before) {
    var px = function (s) { return f.mono ? s.length * f.fs * 0.6 : canvasTextWidth(s, { size: f.fs, weight: f.weight }); };
    var all = px(f.text);
    if (all <= f.w + 0.5) {
      var lead = f.align === 'center' ? (f.w - all) / 2 : f.align === 'right' || f.align === 'end' ? f.w - all : 0;
      return f.x + lead + px(before);
    }
    var a2 = textWidthOf(f.text, f);
    return f.x + (a2 ? f.w * textWidthOf(before, f) / a2 : 0);
  }
  function textWidthOf(s, f) { return f.mono ? s.length : canvasTextWidth(s, { size: 1000, weight: '400' }); }
  function textBefore(el, node, offset) {
    var out = '', done = false;
    (function walk(n) {
      for (var i = 0; i < n._c.length && !done; i++) {
        var c = n._c[i];
        if (c === node) { out += c.data.slice(0, offset); done = true; return; }
        if (c.nodeType === 3) out += c.data; else if (c.nodeType === 1) walk(c);
      }
    })(el);
    return out;
  }
  // the x of a boundary point (container, offset); null when not laid out
  function pointX(container, offset) {
    if (container.nodeType === 3) {
      var el = textParent(container);
      if (!el) return null;
      var f = textFrame(el);
      return { x: textX(f, textBefore(el, container, offset)), y: f.y, h: f.h };
    }
    if (container.nodeType !== 1 || !boxes[container.__id]) return null;
    var kids = container._c, r;
    if (offset < kids.length) {
      var k = kids[offset];
      if (k.nodeType === 3) return pointX(k, 0);
      if (k.nodeType === 1 && boxes[k.__id]) { r = rectOf(k); return { x: r.left, y: r.top, h: r.height }; }
    }
    r = rectOf(container);
    return { x: offset ? r.right : r.left, y: r.top, h: r.height };
  }
  // the text offset in a laid-out element nearest to x: [text node, offset]
  function caretIn(el, x) {
    var f = textFrame(el), all = textWidthOf(f.text, f), texts = [];
    (function walk(n) { for (var i = 0; i < n._c.length; i++) { var c = n._c[i]; if (c.nodeType === 3) texts.push(c); else if (c.nodeType === 1) walk(c); } })(el);
    if (!texts.length) return null;
    var before = '', best = [texts[0], 0], bestD = Infinity;
    for (var t = 0; t < texts.length; t++) {
      var d = texts[t].data;
      for (var o = 0; o <= d.length; o++) {
        var px = textX(f, before + d.slice(0, o)), dist = Math.abs(px - x);
        if (dist < bestD) { bestD = dist; best = [texts[t], o]; }
      }
      before += d;
    }
    return best;
  }
  // The topmost element at a point (CSSOM View 5 elementFromPoint): of the
  // boxes under it that take pointer events and that no overflow clips
  // away there, the one painted last (CSS 2.1 Appendix E: stacking
  // contexts by z-index, positioned boxes over the flow, then tree order).
  // A transformed box is hit inside its own rectangle mapped by its
  // transform (about its transform-origin), not its bounding box.
  function hitTest(x, y) {
    var best = null, bestKey = null, order = 0;
    if (!doc) return null;
    var orderOf = {};
    if (shadowCount) {
      eachFlat(doc, function (e) {
        orderOf[e.__id] = order++;
        var r = rectOf(e);
        if (!(x >= r.left && x < r.right && y >= r.top && y < r.bottom) || !hittable(e)) return;
        if (!insideTransformed(e, x, y) || clippedAway(e, x, y)) return;
        var key = paintKey(e, orderOf);
        if (!best || keyAfter(key, bestKey)) { best = e; bestKey = key; }
      });
      return best;
    }
    // No shadow trees: the same walk carrying the scroll offsets above each
    // element, which rectOf adds up per element (a wheel event over AG
    // Grid's 1 000 elements read 30 000 offsets).
    reflow();
    var f = hitList(), els = f.els, ls = f.ls, ts = f.ts, ws = f.ws, hs = f.hs;
    orderOf = f.orderOf;
    for (var i = 0; i < els.length; i++) {
      var l = ls[i], t = ts[i];
      if (x >= l && x < l + ws[i] && y >= t && y < t + hs[i]) {
        var n = els[i];
        if (hittable(n) && insideTransformed(n, x, y) && !clippedAway(n, x, y)) {
          var key = paintKey(n, orderOf);
          if (!best || keyAfter(key, bestKey)) { best = n; bestKey = key; }
        }
      }
    }
    return best;
  }
  // The elements with a box in tree order, each box where the scroll
  // offsets above it put it, and every element's place in that order: kept
  // while the tree, the boxes and the scroll offsets are the same, so a
  // run of hit tests on a still page (elementFromPoint over a grid of
  // points, the moves of a pointer) walks the tree once.
  var hitFlat = null;
  function hitList() {
    if (hitFlat && hitFlat.g === generation && hitFlat.b === boxSeq && hitFlat.s === scrollBumps && hitFlat.d === doc) return hitFlat;
    var els = [], ls = [], ts = [], ws = [], hs = [], orderOf = {}, order = 0;
    var stack = [], sxs = [], sys = [], top = doc._c;
    for (var i = top.length - 1; i >= 0; i--) { stack.push(top[i]); sxs.push(0); sys.push(0); }
    while (stack.length) {
      var n = stack.pop(), sx = sxs.pop(), sy = sys.pop();
      if (n._attrs === undefined) continue;
      orderOf[n.__id] = order++;
      var b = boxes[n.__id];
      if (b) { els.push(n); ls.push(b[0] - sx); ts.push(b[1] - sy); ws.push(b[2]); hs.push(b[3]); }
      var kx = sx + (n._sLeft || 0), ky = sy + (n._sTop || 0), kids = n._c;
      // (children left out by virtual rows have no box drawn: none of
      // their elements is hit, and a box left from an earlier render is
      // not where they are now)
      var vp = n._virt && n._virt.plan, von = vp && vp.src.length === kids.length ? vp.on : null;
      for (var j = kids.length - 1; j >= 0; j--) { if (von && !von[j] && vp.src[j] === kids[j]) continue; stack.push(kids[j]); sxs.push(kx); sys.push(ky); }
    }
    hitFlat = { g: generation, b: boxSeq, s: scrollBumps, d: doc, els: els, ls: ls, ts: ts, ws: ws, hs: hs, orderOf: orderOf };
    return hitFlat;
  }
  function positionedOf(cs) { return cs.position && cs.position !== 'static'; }
  function zOf(cs) { var z = cs['z-index']; return z === undefined || z === 'auto' ? null : parseInt(z, 10) || 0; }
  // makes a stacking context (CSS 2.1 9.9.1, CSS Positioned 3 and the
  // properties that also make one)
  function stackingContext(e, cs) {
    if (e === doc.documentElement) return true;
    if (positionedOf(cs) && zOf(cs) !== null) return true;
    if (cs.position === 'fixed' || cs.position === 'sticky') return true;
    if (cs.opacity !== undefined && parseFloat(cs.opacity) < 1) return true;
    if ((cs.transform && cs.transform !== 'none') || (cs.filter && cs.filter !== 'none') || (cs.isolation === 'isolate')) return true;
    var p = e.parentNode && e.parentNode.nodeType === 1 ? computedOf(e.parentNode) : null;
    if (p && /flex|grid/.test(p.display || '') && zOf(cs) !== null) return true;
    return false;
  }
  // e's place in painting order: per stacking level from the root's, its
  // layer (0 negative z, 1 the flow, 2 positioned with z auto or 0, 3
  // positive z), its z-index and its tree order
  function paintKey(e, orderOf) {
    var chain = [];
    for (var n = e; n && n.nodeType === 1; n = upFlat(n)) chain.push(n);
    chain.reverse();
    var key = [];
    for (var i = 0; i < chain.length; i++) {
      var n2 = chain[i], cs = computedOf(n2), z = zOf(cs), pos = positionedOf(cs), sc = stackingContext(n2, cs);
      var layer = 1;
      if (pos || sc) layer = z === null || z === 0 ? 2 : z < 0 ? 0 : 3;
      if (n2._top) layer = 4;
      // a box that is neither positioned nor a stacking context paints in
      // its parent's level, in tree order
      if (layer === 1 && i < chain.length - 1) continue;
      key.push([layer, z || 0, orderOf[n2.__id] || 0]);
    }
    return key;
  }
  function keyAfter(a, b) {
    for (var i = 0; i < a.length && i < b.length; i++) {
      for (var j = 0; j < 3; j++) if (a[i][j] !== b[i][j]) return a[i][j] > b[i][j];
    }
    return a.length >= b.length;
  }
  // an ancestor's overflow other than visible clips e at (x, y) when the
  // point is outside the ancestor's padding box; an absolutely placed e
  // escapes clippers below its containing block, a fixed one all of them
  function clippedAway(e, x, y) {
    var cs = computedOf(e), escape = cs.position === 'absolute' ? 1 : cs.position === 'fixed' ? 2 : 0;
    for (var n = upFlat(e); n && n.nodeType === 1 && n !== doc.documentElement; n = upFlat(n)) {
      var ncs = computedOf(n);
      if (escape === 2) { if (ncs.transform && ncs.transform !== 'none') escape = 0; else continue; }
      // (the containing block's own overflow clips: it and what is above)
      if (escape === 1 && (positionedOf(ncs) || (ncs.transform && ncs.transform !== 'none'))) escape = 0;
      var clips = (ncs['overflow-x'] && ncs['overflow-x'] !== 'visible') || (ncs['overflow-y'] && ncs['overflow-y'] !== 'visible') || (ncs.overflow && ncs.overflow !== 'visible');
      if (clips && escape === 0 && boxes[n.__id]) {
        var r = rectOf(n), ed = edgesOf(n);
        if (x < r.left + ed.bl || x >= r.right - ed.br || y < r.top + ed.bt || y >= r.bottom - ed.bb) return true;
      }
    }
    return false;
  }
  // a 2D matrix [a, b, c, d, e, f] from a transform list (translate,
  // scale, rotate, skew, matrix)
  function transform2d(v) {
    var m = [1, 0, 0, 1, 0, 0], re = /([a-zA-Z0-9]+)\(([^)]*)\)/g, f;
    var mul = function (n) { m = [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; };
    var ang = function (a) { var n = parseFloat(a); return /grad$/.test(a) ? n * Math.PI / 200 : /rad$/.test(a) ? n : /turn$/.test(a) ? n * 2 * Math.PI : n * Math.PI / 180; };
    while ((f = re.exec(String(v)))) {
      var fn = f[1].toLowerCase(), a = f[2].split(',').map(function (x) { return x.trim(); }), n = a.map(parseFloat);
      if (fn === 'translate') mul([1, 0, 0, 1, n[0] || 0, n[1] || 0]);
      else if (fn === 'translatex') mul([1, 0, 0, 1, n[0] || 0, 0]);
      else if (fn === 'translatey') mul([1, 0, 0, 1, 0, n[0] || 0]);
      else if (fn === 'scale') mul([n[0], 0, 0, a.length > 1 ? n[1] : n[0], 0, 0]);
      else if (fn === 'scalex') mul([n[0], 0, 0, 1, 0, 0]);
      else if (fn === 'scaley') mul([1, 0, 0, n[0], 0, 0]);
      else if (fn === 'rotate' || fn === 'rotatez') { var t = ang(a[0]); mul([Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0]); }
      else if (fn === 'skew') mul([1, Math.tan(ang(a[1] || '0')), Math.tan(ang(a[0])), 1, 0, 0]);
      else if (fn === 'skewx') mul([1, 0, Math.tan(ang(a[0])), 1, 0, 0]);
      else if (fn === 'skewy') mul([1, Math.tan(ang(a[0])), 0, 1, 0, 0]);
      else if (fn === 'matrix' && n.length === 6) mul(n);
    }
    return m;
  }
  // (x, y) inside e's own rectangle as its transforms (and its
  // ancestors') place it. The host's boxes are drawn coordinates: e's box
  // is the bounding box of its transformed rectangle, so under a
  // translate or scale (axis aligned) it is exact. Under a rotation or a
  // skew the rectangle is a parallelogram centred on the box's centre (an
  // affine map keeps centres, whatever the transform-origin), so the
  // point is mapped back by the composed linear part about that centre
  // and tested against e's untransformed size.
  function insideTransformed(e, x, y) {
    var chain = [];
    for (var n = e; n && n.nodeType === 1; n = upFlat(n)) { var tr = computedOf(n).transform; if (tr && tr !== 'none') chain.push(tr); }
    if (!chain.length || !boxes[e.__id]) return true;
    var m = [1, 0, 0, 1];
    for (var i = chain.length - 1; i >= 0; i--) {
      var t = transform2d(chain[i]);
      m = [m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1], m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3]];
    }
    if (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) return true;
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det) return false;
    var r = rectOf(e), ls = layoutSize(e);
    var dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    var lx = (m[3] * dx - m[2] * dy) / det, ly = (-m[1] * dx + m[0] * dy) / det;
    return Math.abs(lx) <= ls[0] / 2 + 0.5 && Math.abs(ly) <= ls[1] / 2 + 0.5;
  }

  var resizeObservers = [];
  class ResizeObserver {
    constructor(cb) { this._cb = cb; this._els = []; }
    observe(el, opts) { if (this._els.some(function (x) { return x.el === el; })) return; this._els.push({ el: el, last: null }); if (resizeObservers.indexOf(this) < 0) resizeObservers.push(this); scheduleResize(); }
    unobserve(el) { this._els = this._els.filter(function (x) { return x.el !== el; }); }
    disconnect() { this._els = []; var i = resizeObservers.indexOf(this); if (i >= 0) resizeObservers.splice(i, 1); }
  }
  var resizeQueued = false;
  function scheduleResize() { if (resizeQueued) return; resizeQueued = true; setTimeout(fireResize, 0); }
  function fireResize() {
    resizeQueued = false;
    var list = resizeObservers.slice();
    for (var i = 0; i < list.length; i++) {
      var o = list[i], entries = [];
      for (var j = 0; j < o._els.length; j++) {
        var x = o._els[j], ls = layoutSize(x.el), r = { width: ls[0], height: ls[1] };
        var key = r.width + 'x' + r.height;
        if (x.last === key) continue;
        x.last = key;
        // contentRect and contentBoxSize are the content box: the border
        // box without padding and borders (a chart sizes its canvas by it)
        var e = edgesOf(x.el), cw = Math.max(0, r.width - e.bx - e.px), ch = Math.max(0, r.height - e.by - e.py);
        var border = [{ inlineSize: r.width, blockSize: r.height }], content = [{ inlineSize: cw, blockSize: ch }];
        entries.push({ target: x.el, contentRect: DOMRect(e.pl, e.pt, cw, ch), borderBoxSize: border, contentBoxSize: content, devicePixelContentBoxSize: content });
      }
      if (entries.length) { try { o._cb.call(o, entries, o); } catch (e) { reportError(e); } }
    }
  }
  var intersectionObservers = [];
  class IntersectionObserver {
    constructor(cb, opts) { this._cb = cb; this._els = []; this.root = (opts && opts.root) || null; this.rootMargin = (opts && opts.rootMargin) || '0px'; this.thresholds = [].concat((opts && opts.threshold) || 0); }
    observe(el) { this._els.push({ el: el, last: null }); if (intersectionObservers.indexOf(this) < 0) intersectionObservers.push(this); scheduleIntersect(); }
    unobserve(el) { this._els = this._els.filter(function (x) { return x.el !== el; }); }
    disconnect() { this._els = []; var i = intersectionObservers.indexOf(this); if (i >= 0) intersectionObservers.splice(i, 1); }
    takeRecords() { return []; }
  }
  var intersectQueued = false;
  function scheduleIntersect() { if (intersectQueued) return; intersectQueued = true; setTimeout(fireIntersect, 0); }
  function fireIntersect() {
    intersectQueued = false;
    var list = intersectionObservers.slice();
    for (var i = 0; i < list.length; i++) {
      var o = list[i], entries = [];
      for (var j = 0; j < o._els.length; j++) {
        var x = o._els[j], r = rectOf(x.el);
        var inside = r.bottom > 0 && r.right > 0 && r.top < viewport.h && r.left < viewport.w && r.width * r.height > 0;
        if (x.last === inside) continue;
        x.last = inside;
        entries.push({ target: x.el, isIntersecting: inside, intersectionRatio: inside ? 1 : 0, boundingClientRect: r, intersectionRect: inside ? r : DOMRect(0, 0, 0, 0), rootBounds: DOMRect(0, 0, viewport.w, viewport.h), time: now() });
      }
      if (entries.length) { try { o._cb.call(o, entries, o); } catch (e) { reportError(e); } }
    }
  }

  // ---- HTML parsing and serialization --------------------------------------

  var VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
  var RAW = /^(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/;
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', divide: '\u00f7', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', sect: '\u00a7', deg: '\u00b0', plusmn: '\u00b1', para: '\u00b6', larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193', auml: '\u00e4', ouml: '\u00f6', uuml: '\u00fc', Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc', aring: '\u00e5', Aring: '\u00c5', szlig: '\u00df', eacute: '\u00e9', egrave: '\u00e8', zwj: '\u200d', zwnj: '\u200c', shy: '\u00ad', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', check: '\u2713' };
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, function (m, e) {
      if (e.charAt(0) === '#') {
        var cp = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!(cp > 0 && cp < 0x110000)) return '\ufffd';
        return String.fromCodePoint(cp);
      }
      var v = ENTITIES[e];
      return v === undefined ? m : v;
    });
  }
  // the elements a start tag closes (a small part of the tree builder)
  var CLOSES = {
    p: /^(address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|main|menu|nav|ol|p|pre|section|table|ul)$/,
    li: /^li$/, dt: /^(dt|dd)$/, dd: /^(dt|dd)$/, option: /^(option|optgroup)$/, optgroup: /^optgroup$/
  };
  var TABLE_PART = { td: /^(td|th)$/, th: /^(td|th)$/, tr: /^tr$/, tbody: /^(tbody|thead|tfoot)$/, thead: /^(tbody|thead|tfoot)$/, tfoot: /^(tbody|thead|tfoot)$/ };
  function parseInto(html, root, d, svgRoot, xml) {
    var xmlPrefixes = {};
    // xml: an XHTML page, whose XML parser closes every `<x/>` and implies
    // no end tags or table sections
    var stack = [root];
    var i = 0, n = html.length;
    function cur() { return stack[stack.length - 1]; }
    function text(t) {
      if (!t) return;
      var c = cur();
      var last = c.lastChild;
      if (last && last.nodeType === 3) last._data += t;
      else c.appendChild(d.createTextNode(t));
    }
    while (i < n) {
      var lt = html.indexOf('<', i);
      if (lt < 0) { text(decodeEntities(html.slice(i))); break; }
      if (lt > i) text(decodeEntities(html.slice(i, lt)));
      i = lt;
      if (html.substr(i, 4) === '<!--') {
        // (<!--> and <!---> close at once: an empty comment)
        var abrupt = html.charAt(i + 4) === '>' ? 5 : html.substr(i + 4, 2) === '->' ? 6 : 0;
        if (abrupt) { cur().appendChild(d.createComment('')); i += abrupt; continue; }
        var end = html.indexOf('-->', i + 4);
        if (end < 0) end = n;
        cur().appendChild(d.createComment(html.slice(i + 4, end)));
        i = end + 3;
        continue;
      }
      if (html.substr(i, 9).toUpperCase() === '<!DOCTYPE') {
        var e2 = html.indexOf('>', i);
        if (root.nodeType === 9) root.appendChild(new DocumentType('html'));
        i = e2 < 0 ? n : e2 + 1;
        continue;
      }
      if (html.substr(i, 9) === '<![CDATA[') {
        var e3 = html.indexOf(']]>', i);
        if (e3 < 0) e3 = n;
        text(html.slice(i + 9, e3));
        i = e3 + 3;
        continue;
      }
      if (html.charAt(i + 1) === '/') {
        var m = /^<\/([a-zA-Z][^\s\/>]*)[^>]*>/.exec(html.slice(i, i + 200));
        if (!m) {
          // </> is dropped; </ and anything but a letter is a bogus
          // comment up to the next > (HTML tokenizer: end tag open state)
          if (html.charAt(i + 2) === '>') { i += 3; continue; }
          if (i + 2 >= n) { text('</'); i = n; continue; }
          var eb = html.indexOf('>', i + 2);
          if (eb < 0) eb = n;
          if (!xml) cur().appendChild(d.createComment(html.slice(i + 2, eb)));
          i = eb + 1;
          continue;
        }
        var name = m[1].toLowerCase();
        // (an XML prefix the page declared: the local name)
        if (xml && name.indexOf(':') > 0 && xmlPrefixes[name.split(':')[0]]) name = name.slice(name.indexOf(':') + 1);
        for (var k = stack.length - 1; k > 0; k--) {
          var q = stack[k];
          // template content stands on the stack for its template
          var qn = q.nodeType === 11 ? 'template' : q.localName;
          if (qn === name || (q.namespaceURI !== HTML_NS && qn.toLowerCase() === name)) { stack.length = k; break; }
        }
        i += m[0].length;
        continue;
      }
      var tm = /^<([a-zA-Z][^\s\/>]*)/.exec(html.slice(i, i + 200));
      if (!tm || html.charAt(i + 1) === '!' || html.charAt(i + 1) === '?') {
        if (html.charAt(i + 1) === '!' || html.charAt(i + 1) === '?') {
          // a bogus comment (HTML tokenizer): <? keeps its ?, <! drops the
          // !; Lit writes its child markers as <?lit$123$>. (XML: a
          // processing instruction or declaration, skipped)
          var e4 = html.indexOf('>', i);
          if (e4 < 0) e4 = n;
          if (!xml) cur().appendChild(d.createComment(html.slice(html.charAt(i + 1) === '?' ? i + 1 : i + 2, e4)));
          i = e4 + 1;
          continue;
        }
        text('<'); i++; continue;
      }
      var tag = tm[1];
      var j = i + tm[0].length;
      var attrs = [];
      var selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(html.charAt(j))) j++;
        if (j >= n) break;
        var ch = html.charAt(j);
        if (ch === '>') { j++; break; }
        if (ch === '/' && html.charAt(j + 1) === '>') { selfClose = true; j += 2; break; }
        if (ch === '/') { j++; continue; }
        var am = /^[^\s"'>\/=]+/.exec(html.slice(j, j + 300));
        if (!am) { j++; continue; }
        var an = am[0];
        j += an.length;
        while (j < n && /\s/.test(html.charAt(j))) j++;
        var av = '';
        if (html.charAt(j) === '=') {
          j++;
          while (j < n && /\s/.test(html.charAt(j))) j++;
          var qc = html.charAt(j);
          if (qc === '"' || qc === "'") {
            var qe = html.indexOf(qc, j + 1);
            if (qe < 0) qe = n;
            av = html.slice(j + 1, qe);
            j = qe + 1;
          } else {
            var um = /^[^\s>]*/.exec(html.slice(j, j + 2000));
            av = um[0];
            j += av.length;
          }
          av = decodeEntities(av);
        }
        attrs.push([an, av]);
      }
      i = j;
      var parent = cur();
      var inSvg = parent.namespaceURI === SVG_NS && parent.localName !== 'foreignObject';
      var pfxNs = null;
      if (xml) {
        // XML namespace prefixes (xmlns:svg="...", then <svg:rect>)
        for (var xa = 0; xa < attrs.length; xa++) if (/^xmlns:/i.test(attrs[xa][0])) xmlPrefixes[attrs[xa][0].slice(6).toLowerCase()] = attrs[xa][1];
        var ci = tag.indexOf(':');
        if (ci > 0 && xmlPrefixes[tag.slice(0, ci).toLowerCase()]) { pfxNs = xmlPrefixes[tag.slice(0, ci).toLowerCase()]; tag = tag.slice(ci + 1); }
      }
      var lower = tag.toLowerCase();
      var ns = pfxNs === SVG_NS ? SVG_NS : pfxNs === HTML_NS ? HTML_NS : inSvg || lower === 'svg' ? SVG_NS : HTML_NS;
      if (ns === HTML_NS) {
        // implied end tags
        var closes = xml ? null : CLOSES[lower];
        // a cell, row or section start closes the open one, up to its table
        var tbl = xml ? null : TABLE_PART[lower];
        if (tbl) {
          for (var s3 = stack.length - 1; s3 > 0 && stack[s3].nodeType === 1 && stack[s3].localName !== 'table'; s3--) {
            if (tbl.test(stack[s3].localName)) { stack.length = s3; break; }
          }
        }
        for (var s2 = stack.length - 1; s2 > 0 && !tbl && !xml; s2--) {
          var top = stack[s2];
          if (lower === 'li' && top.localName === 'li') { stack.length = s2; break; }
          if (top.localName === 'p' && CLOSES.p.test(lower)) { stack.length = s2; break; }
          if (closes && closes.test(top.localName) && lower !== 'p') { stack.length = s2; break; }
          if (top.nodeType === 11 || /^(div|ul|ol|table|body|html|dl|select|tbody|thead|tfoot|tr|td|th)$/.test(top.localName)) break;
        }
        // the sections and rows a table implies
        if (!xml && /^(tr|td|th)$/.test(lower) && cur().localName === 'table') stack.push(cur().appendChild(d.createElement('tbody')));
        if (!xml && /^(td|th)$/.test(lower) && /^(tbody|thead|tfoot)$/.test(cur().localName)) stack.push(cur().appendChild(d.createElement('tr')));
        if (root.nodeType === 9 && (lower === 'html' || lower === 'head' || lower === 'body')) {
          var have = lower === 'html' ? d.documentElement : lower === 'head' ? d.head : d.body;
          // (a stray element before <html>, such as a <meta>, is not it)
          if (have && have.localName !== lower) have = null;
          if (have) {
            for (var a = 0; a < attrs.length; a++) if (!have.hasAttribute(attrs[a][0])) have.setAttribute(attrs[a][0], attrs[a][1]);
            if (stack.indexOf(have) < 0) stack.push(have);
            continue;
          }
        }
      }
      var el = d.createElementNS(ns, ns === HTML_NS ? lower : svgName(tag));
      for (var b = 0; b < attrs.length; b++) {
        try { el.setAttribute(ns === SVG_NS ? svgAttr(attrs[b][0]) : attrs[b][0], attrs[b][1]); } catch (x) {}
      }
      if (lower === 'script') el._parser = true;
      cur().appendChild(el);
      if (selfClose && xml) continue;
      if (ns === HTML_NS && RAW.test(lower)) {
        var close = new RegExp('</' + lower + '\\s*>', 'i');
        var rest = html.slice(i);
        var cm = close.exec(rest);
        var body = cm ? rest.slice(0, cm.index) : rest;
        // (an XHTML page's script in <![CDATA[ ]]>, which its XML parser
        // takes away; in HTML that script would not even parse)
        if (lower === 'script') {
          var cd = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(body);
          if (cd) body = cd[1];
        }
        // (in XML a sheet's or script's text has its entities, &gt;,
        // decoded outside CDATA sections; the sections stay as they are)
        if (xml && (lower === 'style' || lower === 'script') && body.indexOf('&') >= 0) {
          body = body.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map(function (part) { return part.indexOf('<![CDATA[') === 0 ? part : decodeEntities(part); }).join('');
        }
        // (and its comments, <!-- -->, are the XML's: not in the text)
        if (xml && (lower === 'style' || lower === 'script') && body.indexOf('<!--') >= 0) {
          body = body.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map(function (part) { return part.indexOf('<![CDATA[') === 0 ? part : part.replace(/<!--[\s\S]*?-->/g, ''); }).join('');
        }
        if (body) {
          var target = lower === 'template' ? el.content : el;
          target.appendChild(d.createTextNode(lower === 'textarea' || lower === 'title' ? decodeEntities(body.replace(/^\n/, '')) : body));
        }
        i += cm ? cm.index + cm[0].length : rest.length;
        continue;
      }
      if (selfClose && ns !== HTML_NS) continue;
      if (ns === HTML_NS && VOID.test(lower)) continue;
      if (lower === 'template') { stack.push(el.content); continue; }
      stack.push(el);
    }
  }
  var SVG_NAMES = { clippath: 'clipPath', lineargradient: 'linearGradient', radialgradient: 'radialGradient', foreignobject: 'foreignObject', textpath: 'textPath', fegaussianblur: 'feGaussianBlur', feoffset: 'feOffset', femerge: 'feMerge', femergenode: 'feMergeNode', feblend: 'feBlend', fecolormatrix: 'feColorMatrix', feflood: 'feFlood', fecomposite: 'feComposite', animatetransform: 'animateTransform' };
  function svgName(t) { return SVG_NAMES[t.toLowerCase()] || t; }
  var SVG_ATTRS = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', patternunits: 'patternUnits', stddeviation: 'stdDeviation', clippathunits: 'clipPathUnits', markerwidth: 'markerWidth', markerheight: 'markerHeight', refx: 'refX', refy: 'refY' };
  function svgAttr(a) { return SVG_ATTRS[a.toLowerCase()] || a; }

  function parseFragment(html, context) {
    var d = (context && context.ownerDocument) || doc;
    var frag = d.createDocumentFragment();
    var holder = context && context.namespaceURI === SVG_NS ? d.createElementNS(SVG_NS, 'g') : d.createElement(context && context.localName === 'template' ? 'div' : 'div');
    parseInto(html, holder, d);
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    return frag;
  }

  function escapeText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;'); }
  function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;'); }
  function serialize(n, inner) {
    if (n.nodeType === 3) {
      var p = n.parentNode;
      if (p && p.nodeType === 1 && p.namespaceURI === HTML_NS && /^(script|style|xmp|iframe|noembed|noframes|plaintext|noscript)$/.test(p.localName)) return n.data;
      return escapeText(n.data);
    }
    if (n.nodeType === 4) return '<![CDATA[' + n.data + ']]>';
    if (n.nodeType === 8) return '<!--' + n.data + '-->';
    if (n.nodeType === 10) return '<!DOCTYPE ' + n.name + '>';
    if (n.nodeType === 9 || n.nodeType === 11) return serializeChildren(n);
    var tag = n._qname;
    var s = '<' + tag;
    for (var i = 0; i < n._attrs.length; i++) s += ' ' + n._attrs[i].name + '="' + escapeAttr(n._attrs[i]._v) + '"';
    s += '>';
    if (n.namespaceURI === HTML_NS && VOID.test(tag)) return s;
    s += serializeChildren(n.localName === 'template' ? n.content : n);
    return s + '</' + tag + '>';
  }
  function serializeChildren(n) {
    var s = '';
    for (var i = 0; i < n._c.length; i++) s += serialize(n._c[i], false);
    return s;
  }

  class DOMParser {
    parseFromString(text, type) {
      var d = new Document();
      d.contentType = type || 'text/html';
      if (/xml|svg/.test(type || '') && !/html/.test(type || '')) {
        parseInto(String(text), d, d);
        return d;
      }
      var html = d.createElement('html'); d.appendChild(html);
      html.appendChild(d.createElement('head')); html.appendChild(d.createElement('body'));
      parseInto(String(text), d, d);
      for (var i = 0; i < d._c.length; i++) if (d._c[i].nodeType === 3) { d.body.appendChild(d._c[i]); i--; }
      return d;
    }
  }
  class XMLSerializer {
    serializeToString(n) { return serialize(n, false); }
  }

  // ---- selectors -----------------------------------------------------------

  var selectorCache = {};
  function parseSelectorList(text) {
    text = String(text);
    var c = selectorCache[text];
    if (c) return c;
    var list = [];
    var parts = splitComma(text);
    for (var i = 0; i < parts.length; i++) {
      var s = parseComplex(parts[i]);
      if (!s) throw DOMException("Failed to execute 'querySelectorAll' on 'Document': '" + text + "' is not a valid selector.", 'SyntaxError');
      list.push(s);
    }
    selectorCache[text] = list;
    return list;
  }
  // a complex selector: compounds right to left, each with the combinator
  // to the one on its left; spec = [a, b, c]
  function parseComplex(text) {
    var t = text.trim();
    if (!t) return null;
    var comps = [];
    var i = 0, n = t.length;
    var comb = '';
    var pseudoEl = null;
    while (i < n) {
      var ws = false;
      while (i < n && /\s/.test(t.charAt(i))) { i++; ws = true; }
      if (i >= n) break;
      var ch = t.charAt(i);
      if (ch === '>' || ch === '+' || ch === '~') { comb = ch; i++; continue; }
      if (comps.length && !comb && ws) comb = ' ';
      var r = parseCompound(t, i);
      if (!r) return null;
      if (r.pseudoElement) pseudoEl = r.pseudoElement;
      comps.push({ c: r.c, comb: comps.length ? comb || ' ' : '' });
      comb = '';
      i = r.end;
    }
    if (!comps.length) return null;
    var spec = [0, 0, 0];
    for (var k = 0; k < comps.length; k++) addSpec(spec, comps[k].c);
    if (pseudoEl) spec[2]++;
    comps.reverse();
    // comb of comps[k] says how comps[k] relates to comps[k+1] (its left)
    var out = [];
    for (var m = 0; m < comps.length; m++) out.push({ c: comps[m].c, comb: m + 1 < comps.length ? comps[m === 0 ? 0 : m].comb : '' });
    for (var q = 0; q < comps.length; q++) out[q].comb = comps[q].comb;
    return { parts: out, spec: spec, pseudo: pseudoEl, key: keyOf(out[0].c) };
  }
  function addSpec(spec, c) {
    for (var i = 0; i < c.length; i++) {
      var s = c[i];
      if (s.t === 'id') spec[0]++;
      else if (s.t === 'class' || s.t === 'attr') spec[1]++;
      else if (s.t === 'tag') spec[2]++;
      else if (s.t === 'pseudo') {
        if (s.n === 'where') continue;
        if ((s.n === 'not' || s.n === 'is' || s.n === 'has' || s.n === 'matches') && s.list) {
          var best = [0, 0, 0];
          for (var j = 0; j < s.list.length; j++) { var sp = s.list[j].spec; if (cmpSpec(sp, best) > 0) best = sp; }
          spec[0] += best[0]; spec[1] += best[1]; spec[2] += best[2];
        } else if (s.n === 'nth-child' || s.n === 'nth-last-child') {
          spec[1]++;
          if (s.of) { var b2 = [0, 0, 0]; for (var k = 0; k < s.of.length; k++) if (cmpSpec(s.of[k].spec, b2) > 0) b2 = s.of[k].spec; spec[0] += b2[0]; spec[1] += b2[1]; spec[2] += b2[2]; }
        } else spec[1]++;
      }
    }
  }
  function cmpSpec(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }
  function keyOf(c) {
    for (var i = 0; i < c.length; i++) if (c[i].t === 'id') return '#' + c[i].v;
    for (var j = 0; j < c.length; j++) if (c[j].t === 'class') return '.' + c[j].v;
    for (var k = 0; k < c.length; k++) if (c[k].t === 'tag') return c[k].v;
    return '*';
  }
  var IDENT = /^-?(?:[a-zA-Z_\u00a0-\uffff]|\\.)(?:[a-zA-Z0-9_\-\u00a0-\uffff]|\\[0-9a-fA-F]{1,6}\s?|\\.)*/;
  function unescapeIdent(s) {
    // (a backslash before a newline, in a string, is the newline gone; a
    // code point that is none, 0, a surrogate or past U+10FFFF, is U+FFFD)
    return s.replace(/\\([0-9a-fA-F]{1,6})(\r\n|\s)?|\\(\r\n|\n|\r|\f)|\\(.)/g, function (m, hex, ws, nl, c) {
      if (nl) return '';
      if (!hex) return c;
      var cp = parseInt(hex, 16);
      return String.fromCodePoint(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp);
    });
  }
  var HTML_CI_ATTRS = /^(accept|accept-charset|align|alink|axis|bgcolor|charset|checked|clear|codetype|color|compact|declare|defer|dir|direction|disabled|enctype|face|frame|hreflang|http-equiv|lang|language|link|media|method|multiple|nohref|noresize|noshade|nowrap|readonly|rel|rev|rules|scope|scrolling|selected|shape|target|text|type|valign|valuetype|vlink)$/;
  var KNOWN_PE = /^(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button|cue|cue-region|part|slotted|highlight|spelling-error|grammar-error|target-text|search-text|view-transition(-[a-z-]+)?|details-content|scroll-marker(-group)?|scroll-button|column|checkmark|picker-icon|picker|-webkit-.*|-moz-.*|-ms-.*)$/;
  var KNOWN_PC = /^(root|empty|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|nth-child|nth-last-child|nth-of-type|nth-last-of-type|nth-col|nth-last-col|not|is|where|matches|has|hover|active|focus|focus-visible|focus-within|visited|link|any-link|local-link|checked|disabled|enabled|default|indeterminate|required|optional|valid|invalid|user-valid|user-invalid|in-range|out-of-range|read-only|read-write|placeholder-shown|autofill|target|target-within|target-current|lang|dir|scope|defined|fullscreen|modal|popover-open|open|closed|playing|paused|seeking|buffering|stalled|muted|volume-locked|picture-in-picture|host|host-context|state|blank|current|past|future|heading|has-slotted|active-view-transition(-type)?|xr-overlay|-webkit-.*|-moz-.*|-ms-.*)$/;
  function parseCompound(t, i) {
    var c = [];
    var n = t.length;
    var pseudoElement = null;
    var start = i;
    while (i < n) {
      var ch = t.charAt(i);
      var m;
      if (ch === '*') { i++; continue; }
      if (ch === '#') {
        m = IDENT.exec(t.slice(i + 1));
        if (!m) return null;
        c.push({ t: 'id', v: unescapeIdent(m[0]) }); i += 1 + m[0].length; continue;
      }
      if (ch === '.') {
        m = IDENT.exec(t.slice(i + 1));
        if (!m) return null;
        c.push({ t: 'class', v: unescapeIdent(m[0]) }); i += 1 + m[0].length; continue;
      }
      if (ch === '[') {
        var close = findClose(t, i, '[', ']');
        if (close < 0) return null;
        var inner = t.slice(i + 1, close).trim();
        var am = /^([^\s~|^$*!=\]]+)\s*(?:([~|^$*!]?=)\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^\s\]]+)))?\s*([iIsS])?$/.exec(inner);
        if (!am) return null;
        var val = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : am[5];
        c.push({ t: 'attr', n: unescapeIdent(am[1]).replace(/^\*\|/, '').toLowerCase(), op: am[2] || '', v: val === undefined ? undefined : unescapeIdent(val), i: am[6] === 'i' || am[6] === 'I' });
        i = close + 1; continue;
      }
      if (ch === ':') {
        var dbl = t.charAt(i + 1) === ':';
        var p0 = i + (dbl ? 2 : 1);
        m = /^[a-zA-Z\-]+/.exec(t.slice(p0));
        if (!m) return null;
        var name = m[0].toLowerCase();
        var j = p0 + m[0].length;
        var arg = null;
        if (t.charAt(j) === '(') {
          var cl = findClose(t, j, '(', ')');
          if (cl < 0) return null;
          arg = t.slice(j + 1, cl);
          j = cl + 1;
        }
        if (dbl || /^(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button)$|^-webkit-|^-moz-/.test(name)) {
          // (a pseudo-element or pseudo-class nobody knows makes the
          // whole selector invalid, CSS Selectors 3.9)
          if (!KNOWN_PE.test(name)) return null;
          pseudoElement = name;
          c.push(arg !== null ? { t: 'pseudoel', n: name, arg: arg.trim() } : { t: 'pseudoel', n: name });
          i = j; continue;
        }
        if (!KNOWN_PC.test(name)) return null;
        var s = { t: 'pseudo', n: name };
        if (name === 'not' || name === 'is' || name === 'where' || name === 'matches' || name === '-webkit-any' || name === 'has') {
          var subs = splitComma(arg || '');
          s.list = [];
          for (var k = 0; k < subs.length; k++) {
            var sub = name === 'has' ? parseRelative(subs[k]) : parseComplex(subs[k]);
            if (sub) s.list.push(sub);
          }
          if (name === 'matches' || name === '-webkit-any') s.n = 'is';
        } else if (/^nth-/.test(name)) {
          var ofm = /^(.*?)\s+of\s+(.*)$/.exec(arg || '');
          var ab = parseNth(ofm ? ofm[1] : arg || '');
          if (!ab) return null;
          s.a = ab[0]; s.b = ab[1];
          if (ofm) s.of = parseSelectorList(ofm[2]);
        } else if (arg !== null) {
          s.arg = arg.trim();
        }
        c.push(s);
        i = j; continue;
      }
      m = IDENT.exec(t.slice(i));
      if (m && i === start) {
        var tg = unescapeIdent(m[0]);
        if (t.charAt(i + m[0].length) === '|') { i += m[0].length + 1; continue; }
        c.push({ t: 'tag', v: tg.toLowerCase(), raw: tg }); i += m[0].length; continue;
      }
      if (ch === '|') { i++; continue; }
      break;
    }
    if (i === start) return null;
    return { c: c, end: i, pseudoElement: pseudoElement };
  }
  function parseRelative(text) {
    var t = text.trim();
    var comb = ' ';
    if (/^[>+~]/.test(t)) { comb = t.charAt(0); t = t.slice(1); }
    var s = parseComplex(t);
    if (!s) return null;
    s.rel = comb;
    return s;
  }
  function findClose(t, i, open, close) {
    var depth = 0, q = 0, o = open.charCodeAt(0), c = close.charCodeAt(0), n = t.length;
    for (var k = i; k < n; k++) {
      var ch = t.charCodeAt(k);
      if (q) { if (ch === 92) { k++; continue; } if (ch === q) q = 0; continue; }
      if (ch === 34 || ch === 39) { q = ch; continue; }
      if (ch === 92) { k++; continue; }
      if (ch === o) depth++;
      else if (ch === c) { depth--; if (depth === 0) return k; }
    }
    return -1;
  }
  function parseNth(s) {
    s = s.replace(/\s+/g, '').toLowerCase();
    if (s === 'odd') return [2, 1];
    if (s === 'even') return [2, 0];
    var m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
    if (m) {
      var a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10);
      return [a, m[2] ? parseInt(m[2], 10) : 0];
    }
    if (/^[+-]?\d+$/.test(s)) return [0, parseInt(s, 10)];
    return null;
  }
  function nthMatch(a, b, pos) {
    if (a === 0) return pos === b;
    var k = (pos - b) / a;
    return k >= 0 && Math.floor(k) === k;
  }

  function matchList(el, list) {
    for (var i = 0; i < list.length; i++) if (!list[i].pseudo && matchComplex(el, list[i], null)) return true;
    return false;
  }
  function matchesSelector(el, s) { return matchList(el, parseSelectorList(s)); }

  function matchComplex(el, sel, scope) {
    return matchFrom(el, sel.parts, 0, scope);
  }
  // the shadow root whose sheet's selectors are being matched (null: the
  // document's): their combinators go up to its host, which only a
  // compound with :host matches
  var shadowCtx = null;
  function upEl(n) {
    var p = n.parentNode;
    if (p && p.nodeType === 1) return p;
    return p && shadowCtx && p === shadowCtx ? p.host : null;
  }
  function matchFrom(el, parts, k, scope) {
    if (!matchCompound(el, parts[k].c, scope)) return false;
    if (k + 1 >= parts.length) return true;
    var comb = parts[k].comb;
    if (comb === '>') { var p = upEl(el); return !!p && matchFrom(p, parts, k + 1, scope); }
    if (comb === ' ') {
      for (var a = upEl(el); a; a = upEl(a)) if (matchFrom(a, parts, k + 1, scope)) return true;
      return false;
    }
    if (comb === '+') { var s = siblingElement(el, -1); return !!s && matchFrom(s, parts, k + 1, scope); }
    if (comb === '~') {
      for (var t = siblingElement(el, -1); t; t = siblingElement(t, -1)) if (matchFrom(t, parts, k + 1, scope)) return true;
      return false;
    }
    return false;
  }
  function attrValue(el, name) {
    if (el.namespaceURI !== HTML_NS) {
      for (var i = 0; i < el._attrs.length; i++) if (el._attrs[i].name.toLowerCase() === name) return el._attrs[i]._v;
      return null;
    }
    // (a selector's attribute names are lower case, as an HTML element's are)
    return attrOf(el, name);
  }
  function hasHostPseudo(c) {
    if (c._host === undefined) { var h = false; for (var i = 0; i < c.length; i++) if (c[i].t === 'pseudo' && (c[i].n === 'host' || c[i].n === 'host-context')) h = true; Object.defineProperty(c, '_host', { value: h, enumerable: false }); }
    return c._host;
  }
  function matchCompound(el, c, scope) {
    // (the host, from inside its shadow tree, is only :host; elsewhere
    // :host is nothing)
    if (shadowCtx && el === shadowCtx.host ? !hasHostPseudo(c) : hasHostPseudo(c) && !shadowCtx) return false;
    for (var i = 0; i < c.length; i++) {
      var s = c[i];
      switch (s.t) {
        case 'tag':
          if (el.namespaceURI === HTML_NS ? el.localName !== s.v : el.localName !== s.raw && el.localName.toLowerCase() !== s.v) return false;
          break;
        case 'id':
          if (attrOf(el, 'id') !== s.v) return false;
          break;
        case 'class':
          if (!classSet(el)[s.v]) return false;
          break;
        case 'attr': {
          var v = attrValue(el, s.n);
          if (v === null) return false;
          if (!s.op) break;
          var want = s.v, have = v;
          // (in an HTML document these attributes' values match in any
          // ASCII case, HTML 4.16.2)
          var ci = s.i || (HTML_CI_ATTRS.test(s.n) && el.namespaceURI === HTML_NS && (el.ownerDocument || doc).contentType !== 'application/xhtml+xml');
          if (ci) { want = want.toLowerCase(); have = have.toLowerCase(); }
          if (s.op === '=' && have !== want) return false;
          if (s.op === '~=' && (!want || (' ' + have.replace(/\s+/g, ' ') + ' ').indexOf(' ' + want + ' ') < 0)) return false;
          if (s.op === '|=' && have !== want && have.indexOf(want + '-') !== 0) return false;
          if (s.op === '^=' && (!want || have.indexOf(want) !== 0)) return false;
          if (s.op === '$=' && (!want || have.slice(-want.length) !== want)) return false;
          if (s.op === '*=' && (!want || have.indexOf(want) < 0)) return false;
          if (s.op === '!=' && have === want) return false;
          break;
        }
        case 'pseudo':
          if (!matchPseudo(el, s, scope)) return false;
          break;
        case 'pseudoel':
          break;
      }
    }
    return true;
  }
  function childIndex(el, fromEnd, ofType, ofList) {
    var p = el.parentNode;
    if (!p) return 1;
    if (!ofList && p._c) { kidPositions(p); return ofType ? (fromEnd ? el._posTE : el._posT) : (fromEnd ? el._posEE : el._posE); }
    var k = 0;
    var kids = p._c;
    if (fromEnd) {
      for (var i = kids.length - 1; i >= 0; i--) {
        var n = kids[i];
        if (n.nodeType !== 1) continue;
        if (ofType && n.localName !== el.localName) continue;
        if (ofList && !matchList(n, ofList)) continue;
        k++;
        if (n === el) return k;
      }
    } else {
      for (var j = 0; j < kids.length; j++) {
        var m = kids[j];
        if (m.nodeType !== 1) continue;
        if (ofType && m.localName !== el.localName) continue;
        if (ofList && !matchList(m, ofList)) continue;
        k++;
        if (m === el) return k;
      }
    }
    return k;
  }
  function isDisabled(el) {
    if (!/^(button|input|select|textarea|optgroup|option|fieldset)$/.test(el.localName)) return false;
    if (el.hasAttribute('disabled')) return true;
    for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'fieldset' && n.hasAttribute('disabled')) return true;
    return false;
  }
  function matchPseudo(el, s, scope) {
    switch (s.n) {
      case 'not': for (var i = 0; i < s.list.length; i++) if (matchComplex(el, s.list[i], scope)) return false; return true;
      case 'is': case 'where': for (var j = 0; j < s.list.length; j++) if (matchComplex(el, s.list[j], scope)) return true; return false;
      case 'has':
        for (var h = 0; h < s.list.length; h++) {
          var rel = s.list[h], found = false;
          if (rel.rel === '+' || rel.rel === '~') {
            for (var sb = siblingElement(el, 1); sb && !found; sb = rel.rel === '~' ? siblingElement(sb, 1) : null) if (matchComplex(sb, rel, el)) found = true;
          } else {
            eachElement(el, function (d) {
              if ((rel.rel !== '>' || d.parentNode === el) && matchComplex(d, rel, el)) { found = true; return true; }
            });
          }
          if (found) return true;
        }
        return false;
      case 'root': return !!el.parentNode && el.parentNode.nodeType === 9;
      case 'scope': return scope ? el === scope : !!el.parentNode && el.parentNode.nodeType === 9;
      case 'empty': for (var e = 0; e < el._c.length; e++) { var c = el._c[e]; if (c.nodeType === 1 || ((c.nodeType === 3 || c.nodeType === 4) && c.data.length)) return false; } return true;
      case 'first-child': return childIndex(el, false) === 1;
      case 'last-child': return childIndex(el, true) === 1;
      case 'only-child': return childIndex(el, false) === 1 && childIndex(el, true) === 1;
      case 'first-of-type': return childIndex(el, false, true) === 1;
      case 'last-of-type': return childIndex(el, true, true) === 1;
      case 'only-of-type': return childIndex(el, false, true) === 1 && childIndex(el, true, true) === 1;
      case 'nth-child': if (s.of && !matchList(el, s.of)) return false; return nthMatch(s.a, s.b, childIndex(el, false, false, s.of));
      case 'nth-last-child': if (s.of && !matchList(el, s.of)) return false; return nthMatch(s.a, s.b, childIndex(el, true, false, s.of));
      case 'nth-of-type': return nthMatch(s.a, s.b, childIndex(el, false, true));
      case 'nth-last-of-type': return nthMatch(s.a, s.b, childIndex(el, true, true));
      case 'checked': return (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio') && el.checked) || (el.localName === 'option' && el.selected);
      case 'indeterminate': return el.localName === 'input' && !!el.indeterminate;
      case 'disabled': return isDisabled(el);
      case 'enabled': return /^(button|input|select|textarea|optgroup|option|fieldset)$/.test(el.localName) && !isDisabled(el);
      case 'read-only': return !matchPseudo(el, { n: 'read-write' }, scope);
      case 'read-write': return ((el.localName === 'textarea' || (el.localName === 'input' && /^(text|search|url|tel|email|password|date|month|week|time|datetime-local|number)$/.test(el.type))) && !el.hasAttribute('readonly') && !isDisabled(el)) || !!el.isContentEditable;
      case 'required': return /^(input|select|textarea)$/.test(el.localName) && el.hasAttribute('required');
      case 'optional': return /^(input|select|textarea)$/.test(el.localName) && !el.hasAttribute('required');
      case 'placeholder-shown': return /^(input|textarea)$/.test(el.localName) && el.hasAttribute('placeholder') && !el.value;
      case 'link': case 'any-link': return /^(a|area)$/.test(el.localName) && el.hasAttribute('href');
      case 'visited': return false;
      case 'target': return false;
      case 'defined': return true;
      case 'focus': return !!doc && (doc._active === el || (shadowCount && !!el._sr && focusInShadow(el)));
      case 'focus-visible': return !!doc && doc._active === el && (doc._focusVisible !== false || textEntry(el));
      case 'focus-within':
        if (!doc || !doc._active) return false;
        if (!shadowCount) return el.contains(doc._active);
        for (var fw = doc._active; fw; fw = fw.parentNode && fw.parentNode.nodeType === 11 && fw.parentNode.host ? fw.parentNode.host : fw.parentNode) if (fw === el) return true;
        return false;
      case 'hover': return !!hoverEl && el.contains(hoverEl);
      case 'active': return !!activeEl && el.contains(activeEl);
      case 'valid': case 'invalid': {
        var ln = el.localName, bad;
        if (ln === 'form' || ln === 'fieldset') bad = groupInvalid(el);
        else if (/^(input|select|textarea|button)$/.test(ln) && willValidateOf(el)) bad = !validityOf(el).valid;
        else return false;
        return s.n === 'invalid' ? bad : !bad;
      }
      case 'user-invalid': case 'user-valid': return false;
      case 'in-range': case 'out-of-range': {
        if (el.localName !== 'input' || !/^(number|range|date|month|week|time|datetime-local)$/.test(el.type) || !willValidateOf(el)) return false;
        if (!el.hasAttribute('min') && !el.hasAttribute('max') && el.type !== 'range') return false;
        var vr = validityOf(el), out = vr.rangeUnderflow || vr.rangeOverflow;
        return s.n === 'out-of-range' ? out : !out;
      }
      case 'lang': { for (var l = el; l && l.nodeType === 1; l = l.parentNode) { var lg = l.getAttributeNS ? l.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang') : null; if (lg === null) lg = l.getAttribute('xml:lang'); if (lg === null) lg = l.getAttribute('lang'); if (lg !== null) return lg.toLowerCase().indexOf(String(s.arg).toLowerCase()) === 0; } return false; }
      case 'dir': return String(s.arg) === 'ltr';
      case 'open': return el.hasAttribute('open');
      case 'modal': return !!el._modal;
      case 'popover-open': return !!el._popOpen;
      case 'state': return !!el._internals && el._internals.states.has(String(s.arg));
      case 'fullscreen': return false;
      case 'autofill': case '-webkit-autofill': return false;
      case 'host': case 'host-context': {
        if (!shadowCtx || el !== shadowCtx.host) return false;
        if (s.arg === undefined || s.arg === null || s.arg === '') return s.n === 'host';
        var sv = shadowCtx, ok = false;
        shadowCtx = null;
        try {
          var ls = parseSelectorList(s.arg);
          if (s.n === 'host') ok = matchList(el, ls);
          else for (var hc = el; hc && !ok; hc = flatParent(hc)) ok = matchList(hc, ls);
        } catch (e) { ok = false; }
        shadowCtx = sv;
        return ok;
      }
      default: return false;
    }
  }

  function querySelectorAll(root, s, firstOnly) {
    var list = parseSelectorList(s);
    var out = [];
    var scope = root.nodeType === 1 ? root : null;
    eachElement(root, function (el) {
      for (var i = 0; i < list.length; i++) {
        if (!list[i].pseudo && matchComplex(el, list[i], scope)) { out.push(el); return firstOnly ? true : undefined; }
      }
    });
    return out;
  }

  var hoverEl = null;
  var activeEl = null;

  // ---- CSS: style sheets ---------------------------------------------------

  // a rule: {sel: complex selector, decls: [{name, value, important}],
  // order, media: condition text or ''}
  var sheets = [];
  var sheetOrder = 0;

  function stripComments(css) {
    if (css.indexOf('/*') < 0) return css;
    // copied in pieces: a string grown a character at a time is copied
    // again for every character
    var out = [], i = 0, from = 0, n = css.length, q = null;
    while (i < n) {
      var ch = css.charAt(i);
      if (q) { if (ch === '\\') { i += 2; continue; } if (ch === q) q = null; i++; continue; }
      if (ch === '"' || ch === "'") { q = ch; i++; continue; }
      // (an unquoted url( ... ) has no comments in it)
      if ((ch === 'l' || ch === 'L') && css.charAt(i + 1) === '(' && /url$/i.test(css.slice(i - 2, i + 1)) && /^\(\s*[^\s"']/.test(css.slice(i + 1, i + 40))) {
        i += 2;
        while (i < n && css.charAt(i) !== ')') { if (css.charAt(i) === '\\') i++; i++; }
        continue;
      }
      if (ch === '/' && css.charAt(i + 1) === '*') {
        out.push(css.slice(from, i));
        var e = css.indexOf('*/', i + 2);
        // (a comment still parts two tokens: `1/**/0px` is no `10px`)
        if (e >= 0 && /[\w.%-]/.test(css.charAt(i - 1)) && /[\w.%-]/.test(css.charAt(e + 2)) && /^[\d.]/.test(css.charAt(e + 2))) out.push(' ');
        i = e < 0 ? n : e + 2;
        from = i;
        continue;
      }
      i++;
    }
    out.push(css.slice(from));
    return out.join('');
  }
  function urlsQuoted(v) {
    var out = '', i = 0, re = /(^|[^\w-])url\(\s*(?=[^\s"'])/ig, m;
    while ((m = re.exec(v))) {
      var a = m.index + m[0].length, k = a;
      while (k < v.length && v.charAt(k) !== ')') { if (v.charAt(k) === '\\') k++; k++; }
      var raw = v.slice(a, k).replace(/\s+$/, '');
      if (/[\s"'(]/.test(raw.replace(/\\[\s\S]/g, 'x')) || /[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(raw)) return null;
      out += v.slice(i, m.index + m[1].length) + 'url(';
      out += raw.indexOf('\\') >= 0 ? '"' + unescapeIdent(raw).replace(/["\\]/g, '\\$&') + '"' : raw;
      out += ')';
      i = k + 1;
      re.lastIndex = i;
    }
    return out + v.slice(i);
  }
  function parseDeclarations(text) {
    var out = [];
    // (split at the semicolons outside strings, escapes and blocks)
    var parts = [];
    for (var i = 0; i <= text.length;) {
      var e = cssScan(text, i, ';');
      parts.push(text.slice(i, e));
      i = e + 1;
    }
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      var c = p.indexOf(':');
      if (c < 0) continue;
      var name = p.slice(0, c).trim();
      var value = p.slice(c + 1).trim();
      if (!name) continue;
      // (escapes in the name, and in a value outside its strings, stand
      // for their characters: one that stands for a delimiter is not one)
      if (name.indexOf('\\') >= 0) name = unescapeIdent(name);
      // (an unquoted url(...) with escapes is its address, quoted; one
      // with a quote, a bracket or white space inside is a bad url, and
      // the declaration with it invalid)
      if (/url\(/i.test(value) && name.slice(0, 2) !== '--') {
        var uv = urlsQuoted(value);
        if (uv === null) continue;
        value = uv;
      }
      if (value.indexOf('\\') >= 0 && name.slice(0, 2) !== '--') {
        var vs = value.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
        for (var vi = 0; vi < vs.length; vi += 2) vs[vi] = unescapeIdent(vs[vi]);
        var bare = vs.filter(function (x, xi) { return xi % 2 === 0; }).join('');
        if (/[;{}]/.test(bare)) continue;
        // (an escaped space is part of its identifier: `\0020yellow` is
        // no colour name)
        var rawBare = value.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/).filter(function (x, xi) { return xi % 2 === 0; }).join('');
        if (/\\(0{0,4}(20|9|a|c|d)(?![0-9a-f])|[ \t])/i.test(rawBare) && !/url\(/i.test(rawBare)) continue;
        value = vs.join('').replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, '\ufffd');
      }
      if (name.slice(0, 2) !== '--') name = name.toLowerCase();
      // (url( is url( in any case, `U\Rl(` too)
      if (/url\(/i.test(value) && name.slice(0, 2) !== '--') value = value.replace(/(^|[^\w-])url\(/ig, '$1url(');
      var important = false;
      var im = /\s*!\s*important\s*$/i.exec(value);
      if (im) { important = true; value = value.slice(0, im.index).trim(); }
      // (any other `!` outside a string makes the declaration invalid:
      // `200!invalid`)
      if (value.indexOf('!') >= 0 && name.slice(0, 2) !== '--' && /!/.test(value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ''))) continue;
      if (value === '' && name.slice(0, 2) !== '--') continue;
      if (!sizeValueOk(name, value) || (name === 'display' && !displayOk(value)) || !lengthsOk(name, value) || (name === 'font-family' && !familiesOk(value)) || (name === 'background-image' && !imagesOk(value)) || (/^border(-(top|right|bottom|left))?$/.test(name) && !borderOk(value)) || ((name === 'color' || name === 'background-color') && !colorOk(value)) || (name === 'background' && !backgroundOk(value)) || (name === 'font' && !fontOk(value)) || ((name === 'text-decoration' || name === 'text-decoration-line') && !decorationOk(value))) continue;
      out.push({ name: name, value: value, important: important });
    }
    return out;
  }
  // a colour value: a name, a system colour, #hex of 3, 4, 6 or 8 digits,
  // or a colour function; anything else is an invalid declaration
  var SYS_COLORS = /^(activeborder|activecaption|appworkspace|background|buttonborder|buttonface|buttonhighlight|buttonshadow|buttontext|canvas|canvastext|captiontext|field|fieldtext|graytext|highlight|highlighttext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|linktext|mark|marktext|menu|menutext|scrollbar|selecteditem|selecteditemtext|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|visitedtext|window|windowframe|windowtext|accentcolor|accentcolortext|activetext)$/i;
  function colorTokOk(t) {
    var low = t.toLowerCase();
    if (/^#/.test(t)) return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t);
    if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|var|env|attr)\(/i.test(t)) return true;
    return NAMED_COLORS[low] !== undefined || low === 'currentcolor' || SYS_COLORS.test(low);
  }
  // a value's top-level tokens (functions and strings whole)
  function valueTokens(v) {
    var out = [], cur = '', depth = 0, q = null;
    for (var i = 0; i < v.length; i++) {
      var ch = v.charAt(i);
      if (q) { cur += ch; if (ch === '\\') { cur += v.charAt(++i); } else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0 && (/\s/.test(ch) || ch === '/' || ch === ',')) { if (cur) out.push(cur); cur = ''; if (ch === '/' || ch === ',') out.push(ch); continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  var WIDE = /^(inherit|initial|unset|revert|revert-layer)$/i;
  function colorOk(v) {
    var t = valueTokens(v.trim());
    if (t.length !== 1) return /var\(|env\(/i.test(v);
    return WIDE.test(t[0]) || colorTokOk(t[0]);
  }
  var BG_WORDS = /^(none|repeat|repeat-x|repeat-y|no-repeat|space|round|scroll|fixed|local|left|right|top|bottom|center|auto|cover|contain|border-box|padding-box|content-box|text)$/i;
  function backgroundOk(v) {
    if (/var\(|env\(/i.test(v)) return true;
    var t = valueTokens(v.trim());
    if (t.length === 1 && WIDE.test(t[0])) return true;
    for (var i = 0; i < t.length; i++) {
      var k = t[i];
      if (k === '/' || k === ',') continue;
      if (/^["']/.test(k) || WIDE.test(k)) return false;
      if (BG_WORDS.test(k) || colorTokOk(k)) continue;
      if (/^(url|image|image-set|cross-fade|element|paint|(repeating-)?(linear|radial|conic)-gradient|-webkit-[a-z-]+)\(/i.test(k)) continue;
      if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?([a-z]+|%)?$/i.test(k)) {
        var num = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(k);
        if (num && parseFloat(k) !== 0) return false;
        continue;
      }
      if (/^(calc|min|max|clamp)\(/i.test(k)) continue;
      return false;
    }
    return true;
  }
  // a length property's value with a number that is not a length (a
  // non-zero number with no unit) or, where lengths cannot be negative
  // (padding, border widths, sizes), a negative one is invalid, and the
  // declaration is dropped (CSS 2.1 4.2, 8.4)
  var LEN_PROPS = /^(padding(-(top|right|bottom|left))?|margin(-(top|right|bottom|left))?|(min-|max-)?(width|height)|top|right|bottom|left|border(-(top|right|bottom|left))?-width|outline-width|letter-spacing|word-spacing|text-indent|font-size|flex-basis)$/;
  var LEN_UNIT = /^(%|px|em|ex|ch|rem|rex|rch|ic|ric|cap|rcap|lh|rlh|vw|vh|vi|vb|vmin|vmax|[sld]v(w|h|i|b|min|max)|cq(w|h|i|b|min|max)|cm|mm|q|in|pt|pc)$/i;
  var NONNEG_PROPS = /^(padding|border|outline|font-size$|line-height$|(min-|max-)?(width|height)$|flex-basis$)/;
  function lengthsOk(name, value) {
    // (a line height is a number or a length, neither negative)
    if (name === 'line-height' && /^\s*-(\d|\.\d)/.test(value) && parseFloat(value) < 0) return false;
    if (!LEN_PROPS.test(name) || /[(]/.test(value)) return true;
    var ws = value.trim().split(/\s+/);
    for (var i = 0; i < ws.length; i++) {
      // (a string, or a sign standing alone, is no length: `"auto"`, `+ 10px`)
      if (/^["']/.test(ws[i]) || ws[i] === '+' || ws[i] === '-') return false;
      var m = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(ws[i]);
      // (a border width is a length or thin, medium, thick: `funny` or `px`
      // is none)
      if (!m && /-width$/.test(name) && /^(border|outline)/.test(name) && !/^(thin|medium|thick|inherit|initial|unset|revert|revert-layer)$/i.test(ws[i])) return false;
      if (!m) continue;
      if (!m[2] && parseFloat(m[1]) !== 0) return false;
      // (a unit no length has: `50zu`)
      if (m[2] && !LEN_UNIT.test(m[2])) return false;
      if (parseFloat(m[1]) < 0 && NONNEG_PROPS.test(name)) return false;
    }
    return true;
  }
  // a border shorthand: a width, a style and a colour, each at most once
  var BORDER_STYLE = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i;
  function borderOk(value) {
    if (/var\(/.test(value)) return true;
    var ws = splitValue(value), w = 0, st = 0, c = 0;
    if (ws.length === 1 && /^(inherit|initial|unset|revert|revert-layer)$/i.test(ws[0])) return true;
    for (var i = 0; i < ws.length; i++) {
      if (BORDER_STYLE.test(ws[i])) st++;
      else if (/^(thin|medium|thick)$/i.test(ws[i]) || /^[+-]?[\d.]+[a-z%]*$/i.test(ws[i]) || /^calc\(/i.test(ws[i])) w++;
      else c++;
    }
    return w <= 1 && st <= 1 && c <= 1;
  }
  // a background-image: none or images, comma separated (`url(a) repeat`
  // is not one)
  function imagesOk(value) {
    if (/var\(/.test(value)) return true;
    var ws = splitValue(value.replace(/,/g, ' , '));
    for (var i = 0; i < ws.length; i++) {
      if (ws[i] !== ',' && !/^(none|inherit|initial|unset|revert)$/i.test(ws[i]) && !/^[a-z-]+\(/i.test(ws[i])) return false;
    }
    return true;
  }
  // a font-family list: each family a string or a run of identifiers
  // (`test!foo` is neither, and the whole declaration is dropped)
  function familiesOk(value) {
    if (/var\(/.test(value)) return true;
    var parts = value.split(',');
    for (var i = 0; i < parts.length; i++) {
      var f = parts[i].trim();
      if (/^(["']).*\1$/.test(f)) continue;
      if (!/^(-?([_a-z\u00a0-\uffff]|\\.)([-_a-z0-9\u00a0-\uffff]|\\.)*)(\s+-?([_a-z\u00a0-\uffff]|\\.)([-_a-z0-9\u00a0-\uffff]|\\.)*)*$/i.test(f)) return false;
    }
    return true;
  }
  // a font shorthand: style, variant, weight and stretch words, a size
  // (with a line height), then the families (`bold highlighted 100%` is
  // not one, CSS 2.1 15.8)
  var FONT_PRE = /^(normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded)$/i;
  var FONT_SIZE = /^((xx?-|xxx-)?(small|large)|medium|smaller|larger|0|[+]?(\d+\.?\d*|\.\d+)([a-z]+|%))(\/.+)?$/i;
  function fontOk(value) {
    if (/var\(|env\(/i.test(value)) return true;
    var v = value.trim();
    if (/^(caption|icon|menu|message-box|small-caption|status-bar|inherit|initial|unset|revert|revert-layer|-webkit-[a-z-]+)$/i.test(v)) return true;
    var ws = v.split(/\s+/);
    for (var i = 0; i < ws.length; i++) {
      if (FONT_SIZE.test(ws[i]) || /^(calc|clamp|min|max)\(/i.test(ws[i])) return i < ws.length - 1;
      if (ws[i] === '/' ) return false;
      if (!FONT_PRE.test(ws[i])) return false;
    }
    return false;
  }
  // text-decoration: lines, a style, a colour, a thickness
  var DECO_WORDS = /^(none|underline|overline|line-through|blink|solid|double|dotted|dashed|wavy|auto|from-font|spelling-error|grammar-error|inherit|initial|unset|revert|revert-layer)$/i;
  function decorationOk(value) {
    if (/var\(|env\(/i.test(value)) return true;
    var t = valueTokens(value.trim());
    for (var i = 0; i < t.length; i++) {
      if (DECO_WORDS.test(t[i]) || colorTokOk(t[i]) || /^[+-]?(\d+\.?\d*|\.\d+)([a-z]+|%)?$/i.test(t[i]) || /^(calc|min|max|clamp)\(/i.test(t[i])) continue;
      return false;
    }
    return true;
  }
  // a size property with a keyword it does not know is an invalid
  // declaration, which is dropped (`width: max-width`)
  var SIZE_PROPS = /^(min-|max-)?(width|height|inline-size|block-size)$/;
  var SIZE_KW = /^(auto|none|min-content|max-content|fit-content|stretch|-webkit-fill-available|-moz-available|-webkit-min-content|-webkit-max-content|-webkit-fit-content|-moz-min-content|-moz-max-content|-moz-fit-content|inherit|initial|unset|revert|revert-layer)$/i;
  function sizeValueOk(name, value) {
    if (!SIZE_PROPS.test(name) || !/^-?[a-z][a-z-]*$/i.test(value)) return true;
    if (!SIZE_KW.test(value)) return false;
    return value.toLowerCase() !== 'none' || name.slice(0, 4) === 'max-';
  }

  // a display value the layout does not know is an invalid declaration
  var DISPLAY_KW = /^(none|contents|block|inline|inline-block|flow-root|list-item|flex|inline-flex|grid|inline-grid|grid-lanes|inline-grid-lanes|table|inline-table|table-row-group|table-header-group|table-footer-group|table-row|table-cell|table-column-group|table-column|table-caption|ruby|ruby-base|ruby-text|ruby-base-container|ruby-text-container|run-in|math|inline-math|-webkit-box|-webkit-inline-box|inherit|initial|unset|revert|revert-layer)$/i;
  function displayOk(value) {
    if (/var\(/.test(value)) return true;
    var ws = value.trim().split(/\s+/);
    if (ws.length === 1) return DISPLAY_KW.test(ws[0]);
    return ws.every(function (w) { return /^(block|inline|run-in|flow|flow-root|flex|grid|grid-lanes|table|ruby|math|list-item)$/i.test(w); });
  }

  class CSSRule {
    constructor(type, text) { this.type = type; this._text = text; this.parentStyleSheet = null; this.parentRule = null; }
    get cssText() { return this._text; }
  }
  CSSRule.STYLE_RULE = 1; CSSRule.MEDIA_RULE = 4; CSSRule.FONT_FACE_RULE = 5; CSSRule.KEYFRAMES_RULE = 7; CSSRule.SUPPORTS_RULE = 12;
  class CSSStyleRule extends CSSRule {
    constructor(selectorText, decls) {
      super(1, '');
      this.selectorText = selectorText;
      var st = new CSSStyleDeclaration(null);
      for (var i = 0; i < decls.length; i++) st._set(decls[i].name, decls[i].value, decls[i].important ? 'important' : '');
      this.style = styleProxy(st);
      this._decls = decls;
    }
    get cssText() { return this.selectorText + ' { ' + this.style.cssText + ' }'; }
  }
  class CSSMediaRule extends CSSRule {
    constructor(cond, rules) { super(4, ''); this.conditionText = cond; this.media = { mediaText: cond, length: 1 }; this.cssRules = rules; }
  }
  class CSSStyleSheet {
    constructor(owner) { var opts = owner && !(owner instanceof Node) ? owner : null; if (opts) owner = null; this._opts = opts; this.ownerNode = owner || null; this.cssRules = []; this._disabled = false; this.href = null; this.type = 'text/css'; this.title = null; this.media = { mediaText: '', length: 0 }; this._rules = []; this._order = sheetOrder++; if (opts) { if (opts.media) this.media = typeof opts.media === 'string' ? opts.media : opts.media.mediaText || ''; if (opts.disabled) this._disabled = true; } }
    get rules() { return this.cssRules; }
    // (a sheet switched off or on restyles the page, CSSOM 6.1)
    get disabled() { return this._disabled; }
    set disabled(v) { v = !!v; if (v !== this._disabled) { this._disabled = v; changed(); } }
    insertRule(text, index) {
      index = index === undefined ? 0 : index;
      var tmp = parseSheetText(String(text), this);
      if (!tmp.cssRules.length && !/^\s*@/.test(text)) throw DOMException("Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '" + text + "'.", 'SyntaxError');
      Array.prototype.splice.apply(this.cssRules, [index, 0].concat(tmp.cssRules));
      this._rebuild();
      return index;
    }
    deleteRule(index) { this.cssRules.splice(index, 1); this._rebuild(); }
    addRule(sel, body, index) { return this.insertRule(sel + '{' + body + '}', index === undefined ? this.cssRules.length : index); }
    removeRule(i) { this.deleteRule(i); }
    replaceSync(text) { var tmp = parseSheetText(String(text), this); this.cssRules = tmp.cssRules; this._rebuild(); }
    replace(text) { this.replaceSync(text); return Promise.resolve(this); }
    _rebuild() {
      this._rules = [];
      var self = this;
      (function add(rules, media) {
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          if (r.type === 1) {
            var list;
            try { list = parseSelectorList(r.selectorText); } catch (e) { continue; }
            for (var k = 0; k < list.length; k++) self._rules.push({ sel: list[k], decls: r._decls, media: media, text: r.selectorText });
          } else if (r.type === 4) add(r.cssRules, media ? media + ' and ' + r.conditionText : r.conditionText);
          else if (r.type === 12 && r._ok) add(r.cssRules, media);
          else if (r._layer) add(r.cssRules, media);
        }
      })(this.cssRules, '');
      indexSheet(this);
      if (!sheetQuiet) changed();
    }
  }

  function parseSheetText(css, sheet) {
    var out = { cssRules: [] };
    // (CDO and CDC, `<!--` `-->`, are nothing at a sheet's top level, and
    // an XHTML page's `<![CDATA[` `]]>` around its sheet is markup the XML
    // parser takes away)
    var text = stripComments(css).replace(/<!\[CDATA\[|\]\]>|<!--|-->/g, ' ');
    parseRulesInto(text, out.cssRules, sheet);
    return out;
  }
  function parseRulesInto(text, rules, sheet) {
    // (a long text is cut at its top-level rules first, each parsed on its
    // own: the engine keeps one string's UTF-16 units for its regular
    // expressions and characters, and every switch between a 75 000
    // character theme and a declaration made them again)
    if (text.length > 4096) {
      var chunks = cssChunks(text);
      if (chunks.length > 1) {
        for (var ci = 0; ci < chunks.length; ci++) parseRulesInto(chunks[ci], rules, sheet);
        return;
      }
    }
    var i = 0, n = text.length;
    while (i < n) {
      while (i < n && /\s/.test(text.charAt(i))) i++;
      if (i >= n) break;
      if (text.charAt(i) === '}') { i++; continue; }
      // the prelude up to { or ; (a semicolon ends an at-rule's prelude;
      // a style rule's runs on to its block, CSS Syntax 5.4.3)
      var j = cssScan(text, i, text.charAt(i) === '@' ? ';{' : '{');
      var prelude = text.slice(i, j).trim();
      if (j >= n) break;
      if (text.charAt(j) === ';') { i = j + 1; continue; }
      if (prelude.charAt(0) !== '@') {
        // a style rule: its declarations and nested rules are split off
        // in the same walk that finds the block's end
        var decls = [];
        var nested = [];
        i = splitNestedIn(text, j + 1, decls, nested) + 1;
        styleRuleInto(prelude, decls, nested, rules, sheet);
        continue;
      }
      var close = cssBlockEnd(text, j);
      if (close < 0) close = n;
      var body = text.slice(j + 1, close);
      i = close + 1;
      if (prelude.charAt(0) === '@') {
        var am = /^@([a-zA-Z\-]+)\s*([\s\S]*)$/.exec(prelude);
        var at = am ? am[1].toLowerCase() : '';
        var cond = am ? am[2].trim() : '';
        if (at === 'media') {
          var sub = [];
          parseRulesInto(body, sub, sheet);
          var mr = new CSSMediaRule(cond, sub);
          mr.parentStyleSheet = sheet;
          rules.push(mr);
        } else if (at === 'supports') {
          var sub2 = [];
          parseRulesInto(body, sub2, sheet);
          var sr = new CSSRule(12, '');
          sr.cssRules = sub2; sr.conditionText = cond; sr._ok = supportsCondition(cond);
          rules.push(sr);
        } else if (at === 'layer' || at === 'container' || at === 'scope' || at === 'document' || at === '-moz-document') {
          var sub3 = [];
          parseRulesInto(body, sub3, sheet);
          var lr = new CSSRule(at === 'layer' ? 18 : 0, '');
          lr.cssRules = sub3; lr._layer = at === 'layer' || at === 'scope';
          rules.push(lr);
        } else if (at === 'property' && cond.slice(0, 2) === '--') {
          // (CSS Properties and Values API 1, 3: a registered custom
          // property; ignored without syntax and inherits, or without an
          // initial value when its syntax is not "*")
          var pd = {}, pm, PDRE = /(syntax|inherits|initial-value)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^;]*)/gi;
          while ((pm = PDRE.exec(body))) pd[pm[1].toLowerCase()] = pm[2].trim();
          var psyn = pd.syntax ? pd.syntax.replace(/^["']|["']$/g, '') : null, pinh = pd.inherits ? pd.inherits.toLowerCase() : null;
          var prule = new CSSRule(0, prelude + '{' + body + '}');
          prule.name = cond; prule.syntax = psyn || ''; prule.inherits = pinh === 'true'; prule.initialValue = pd['initial-value'] !== undefined ? pd['initial-value'] : null;
          if (psyn !== null && (pinh === 'true' || pinh === 'false') && (psyn === '*' || pd['initial-value'] !== undefined)) registerProp(cond, pinh === 'true', pd['initial-value'], false);
          rules.push(prule);
        } else {
          var other = new CSSRule(at === 'font-face' ? 5 : at === 'keyframes' || at === '-webkit-keyframes' ? 7 : 0, prelude + '{' + body + '}');
          other.name = cond;
          rules.push(other);
        }
        continue;
      }
    }
  }
  function styleRuleInto(prelude, decls, nested, rules, sheet) {
    {
      // nested rules (CSS nesting) are flattened: `&` is the parent
      // (white space to JavaScript that is not CSS's: a vertical tab is
      // invalid there and the others are name characters, so the
      // selector matches nothing)
      if (/[\v\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(prelude)) return;
      var r = new CSSStyleRule(prelude, parseDeclarations(decls.join(';')));
      r.parentStyleSheet = sheet;
      rules.push(r);
      for (var k = 0; k < nested.length; k++) {
        var np = nested[k].prelude;
        var selText = splitComma(np).map(function (s) {
          return splitComma(prelude).map(function (p) { return s.indexOf('&') >= 0 ? s.replace(/&/g, p) : p + ' ' + s; }).join(', ');
        }).join(', ');
        if (np.charAt(0) === '@') { var sub4 = []; parseRulesInto(prelude + '{' + nested[k].body + '}', sub4, sheet); var mr2 = new CSSMediaRule(np.replace(/^@media\s*/i, ''), sub4); rules.push(mr2); continue; }
        parseRulesInto(selText + '{' + nested[k].body + '}', rules, sheet);
      }
    }
  }
  // t cut after each of its top-level blocks, in one walk that touches no
  // other string (cssScan's rules for strings, escapes, url( and blocks)
  function cssChunks(t) {
    var out = [], re = /["'\\()\[\]{}]|url\(/gi, st = [], n = t.length, start = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      var k = m.index, ch = m[0];
      if (ch === '"' || ch === "'") {
        var q = ch.charCodeAt(0);
        k++;
        while (k < n) { var cc = t.charCodeAt(k); if (cc === q || cc === 10) break; if (cc === 92) k++; k++; }
        re.lastIndex = k + 1;
        continue;
      }
      if (ch === '\\') { re.lastIndex = k + 2; continue; }
      if (ch.length > 1) { re.lastIndex = cssUrlEnd(t, k); continue; }
      if (ch === '(') st.push(')');
      else if (ch === '[') st.push(']');
      else if (ch === '{') st.push('}');
      else if (st.length && ch === st[st.length - 1]) {
        st.pop();
        if (ch === '}' && st.length === 0) { out.push(t.slice(start, k + 1)); start = k + 1; }
      }
    }
    if (start < n) out.push(t.slice(start));
    return out;
  }
  // where the walk goes on after `url(` at k: past its `)` when it is an
  // unquoted url (no quote after the white space, no name character
  // before), else at its `(`
  function cssUrlEnd(t, k) {
    var n = t.length, u = k + 4;
    while (u < n && (t.charCodeAt(u) === 32 || (t.charCodeAt(u) >= 9 && t.charCodeAt(u) <= 13))) u++;
    var uc = u < n ? t.charCodeAt(u) : 34;
    var pc = k > 0 ? t.charCodeAt(k - 1) : 32;
    var named = (pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122) || pc === 95 || pc === 45;
    if (u >= k + 64 || uc === 34 || uc === 39 || named) return k + 3;
    k += 4;
    while (k < n && t.charCodeAt(k) !== 41) { if (t.charCodeAt(k) === 92) k++; k++; }
    return k + 1;
  }
  // where the first of `stops` is in t from i on, outside strings, escapes
  // and the blocks ( [ { (each closed only by its own closer; a closer
  // with no block open is a token like any other, CSS Syntax 5.4.7);
  // t.length if none is. A string ends at its quote or at a newline.
  function cssScan(t, i, stops) {
    // (a regular expression finds the next character that matters, so the
    // text between is not walked one character at a time: a theme's
    // 75 000 characters of CSS took the walk 0.3 s in the engine)
    if (!cssScanRes) cssScanRes = {};
    var re = cssScanRes[stops];
    if (!re) re = cssScanRes[stops] = new RegExp('["\'\\\\()\\[\\]{}' + stops.replace(/[\]\\^\-]/g, '\\$&') + ']|url\\(', 'gi');
    var n = t.length, st = [];
    re.lastIndex = i;
    for (;;) {
      var m = re.exec(t);
      if (!m) return n;
      var k = m.index, ch = m[0];
      if (ch === '"' || ch === "'") {
        var q = ch.charCodeAt(0);
        k++;
        while (k < n) { var cc = t.charCodeAt(k); if (cc === q || cc === 10) break; if (cc === 92) k++; k++; }
        re.lastIndex = k + 1;
        continue;
      }
      if (ch === '\\') { re.lastIndex = k + 2; continue; }
      // (an unquoted url( ... ) is one token, brackets and all)
      if (ch.length > 1) { re.lastIndex = cssUrlEnd(t, k); continue; }
      if (st.length === 0 && stops.indexOf(ch) >= 0) return k;
      if (ch === '(') st.push(')');
      else if (ch === '[') st.push(']');
      else if (ch === '{') st.push('}');
      else if (st.length && ch === st[st.length - 1]) st.pop();
    }
  }
  var cssScanRes = null;
  // the closer of the block opened at t[i] (t.length when none)
  function cssBlockEnd(t, i) {
    var c = t.charAt(i) === '(' ? ')' : t.charAt(i) === '[' ? ']' : '}';
    return cssScan(t, i + 1, c);
  }
  // splitNested over t's block from `from` on: the index of the block's
  // closing brace (t.length when it has none)
  function splitNestedIn(t, from, decls, nested) {
    var i = from, n = t.length, start = from;
    function decl(seg) { if (!/^\s*@/.test(seg)) decls.push(seg); }
    while (i < n) {
      var k = cssScan(t, i, ';{}');
      if (k >= n) break;
      var c = t.charAt(k);
      if (c === '}') { decl(t.slice(start, k)); return k; }
      if (c === ';') { decl(t.slice(start, k)); start = i = k + 1; continue; }
      var close = cssBlockEnd(t, k);
      var pre = t.slice(start, k).trim();
      // `--x: { ... }` is a value, not a rule
      if (/^--[\w-]+\s*:/.test(pre)) { i = close + 1; continue; }
      nested.push({ prelude: pre, body: t.slice(k + 1, close) });
      i = close + 1; start = i;
    }
    if (start < n) decl(t.slice(start));
    return n;
  }
  function splitNested(body, decls, nested) {
    var i = 0, n = body.length, start = 0;
    // (an at-rule in a declaration list, `@import ...;`, is no
    // declaration: it runs to its semicolon or its block)
    function decl(seg) { if (!/^\s*@/.test(seg)) decls.push(seg); }
    while (i < n) {
      var k = cssScan(body, i, ';{');
      if (k >= n) break;
      if (body.charAt(k) === ';') { decl(body.slice(start, k)); start = i = k + 1; continue; }
      var close = cssBlockEnd(body, k);
      var pre = body.slice(start, k).trim();
      // `--x: { ... }` is a value, not a rule
      if (/^--[\w-]+\s*:/.test(pre)) { i = close + 1; continue; }
      nested.push({ prelude: pre, body: body.slice(k + 1, close) });
      i = close + 1; start = i;
    }
    if (start < n) decl(body.slice(start));
  }
  function supportsCondition(c) {
    c = c.trim();
    if (/^not\s/i.test(c)) return !supportsCondition(c.slice(4));
    if (/^selector\(/i.test(c)) return true;
    var m = /^\(\s*([a-zA-Z\-]+)\s*:\s*(.*)\)$/.exec(c);
    if (m) return !/^(-webkit-|-moz-|-ms-)/.test(m[1]) || m[1] === '-webkit-backdrop-filter';
    return true;
  }

  // rules by the key of their rightmost compound (id, class, tag or *)
  function indexSheet(sheet) {
    // (a pseudo-element's rules apart, by its name: an element's cascade
    // and its ::before's each go through their own only)
    var idx = {}, pidx = {};
    for (var i = 0; i < sheet._rules.length; i++) {
      var r = sheet._rules[i];
      r.order = i;
      var k = r.sel.key;
      // (a subject that is only :is() or :where(), as a theme's
      // `:where(.ag-row:not(.x))`, by the keys of what is inside: a grid's
      // theme had 100 of them tried on every element)
      var keys = k === '*' ? subjectKeys(r.sel.parts[0].c, 0) : null;
      if (k === '*' && !keys) k = attrKey(r.sel.parts[0].c);
      var into = r.sel.pseudo ? (pidx[r.sel.pseudo] || (pidx[r.sel.pseudo] = {})) : idx;
      if (keys) {
        r._multi = keys.length > 1;
        for (var ki = 0; ki < keys.length; ki++) (into[keys[ki]] || (into[keys[ki]] = [])).push(r);
      } else {
        (into[k] || (into[k] = [])).push(r);
      }
      if (r.sel.pseudo === 'before' || r.sel.pseudo === 'after' || r.sel.pseudo === 'first-letter' || r.sel.pseudo === 'first-line') sheet._pseudo = true;
      if (r.sel.pseudo === 'backdrop') sheet._backdrop = true;
    }
    sheet._index = idx;
    sheet._pindex = pidx;
  }
  // the keys (#id, .class, tag) of a compound whose own are only in its
  // :is() or :where(): one per selector of the list, null when one of them
  // has none
  function subjectKeys(c, depth) {
    var k = keyOf(c);
    if (k !== '*') return [k];
    if (depth > 3) return null;
    for (var i = 0; i < c.length; i++) {
      var p = c[i];
      if (p.t !== 'pseudo' || (p.n !== 'is' && p.n !== 'where') || !p.list || !p.list.length) continue;
      var out = [], ok = true;
      for (var j = 0; j < p.list.length && ok; j++) {
        var sk = subjectKeys(p.list[j].parts[0].c, depth + 1);
        if (!sk) ok = false;
        else for (var q = 0; q < sk.length; q++) if (out.indexOf(sk[q]) < 0) out.push(sk[q]);
      }
      if (ok) return out;
    }
    return null;
  }
  // (a subject with no id, class or tag: by :root or by an attribute it
  // needs, so that Bootstrap's [data-bs-theme=dark] and [type=button] are
  // not tried on every element)
  function attrKey(c) {
    for (var i = 0; i < c.length; i++) if (c[i].t === 'pseudo' && c[i].n === 'root') return ':root';
    for (var j = 0; j < c.length; j++) if (c[j].t === 'attr' && c[j].n.indexOf('|') < 0) return '[' + c[j].n;
    return '*';
  }

  var sheetQuiet = 0;
  // A <style> came into the page, went, or got a new text: when every rule
  // of its sheet, before and after, is a plain style rule (no at-rule but
  // @media, no pseudo-element) whose subject has a key (a tag, an id, a
  // class, an attribute), only the elements with one of those keys can
  // match one, so only they are styled again (and what is under them when
  // their style changed in what it hands down, restyle); else the whole
  // page. react-remove-scroll's <style> (body[data-scroll-locked], four
  // class names) came and went with every Radix dialog, sheet, select and
  // menu, and restyled 2 500 elements twice each time.
  function styleSheetChanged(el, was) {
    if (!doc || el.ownerDocument !== doc || shadowCount || el.namespaceURI !== HTML_NS) { changed(); return; }
    var keys = {}, any = false;
    function take(sh) {
      if (!sh) return true;
      if (sh.disabled) return true;
      if (!plainRules(sh.cssRules)) return false;
      for (var k in sh._index) { if (k === '*') return false; keys[k] = 1; any = true; }
      // (a pseudo-element's rules by the keys of their elements: Radix
      // Select's `[data-radix-select-viewport]::-webkit-scrollbar`)
      for (var pn in sh._pindex) for (var pk in sh._pindex[pn]) { if (pk === '*') return false; keys[pk] = 1; any = true; }
      return true;
    }
    // (the keys of the rules it had before its new text is read: the sheet
    // object is the same one, sheetOfStyle)
    if (!take(was)) { changed(); return; }
    if (!take(el.isConnected ? sheetOfStyle(el) : null)) { changed(); return; }
    sheetGen++;
    generation++;
    lastPseudo = NO_PSEUDO;
    if (!any || computedCache.gen !== styleGen) return;
    textStamp++;
    var hit = [];
    eachElement(doc, function (e) { if (keyedBy(e, keys)) hit.push(e); });
    for (var i = 0; i < hit.length; i++) {
      var e = hit[i];
      for (var p = e; p && p._rv !== textStamp; p = p.parentNode) p._rv = textStamp;
      // (each one: one above it whose style came out the same kept what
      // is under it)
      restyle(e);
    }
  }
  function plainRules(rules) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.type === 1) continue;
      if (r.type === 4 && !r._layer && plainRules(r.cssRules)) continue;
      return false;
    }
    return true;
  }
  // the index keys of a rule's subject (as indexSheet files it), null for
  // one with none
  function ruleKeys(r) {
    var k = r.sel && r.sel.key;
    if (!k) return null;
    if (k !== '*') return [k];
    var keys = subjectKeys(r.sel.parts[0].c, 0);
    if (keys) return keys;
    k = attrKey(r.sel.parts[0].c);
    return k === '*' ? null : [k];
  }
  // e has one of the index keys (indexSheet): its tag, #id, .class, [attr,
  // :root
  function keyedBy(e, keys) {
    if (keys[e.localName] || (e === doc.documentElement && keys[':root'])) return true;
    var id = e.getAttribute('id');
    if (id && keys['#' + id]) return true;
    var at = e._attrs;
    for (var i = 0; i < at.length; i++) {
      var n = at[i].name;
      if (keys['[' + n]) return true;
      if (n === 'class') { var cl = String(at[i].value).split(/\s+/); for (var j = 0; j < cl.length; j++) if (cl[j] && keys['.' + cl[j]]) return true; }
    }
    return false;
  }
  function sheetOfStyle(el) {
    if (el._sheet && el._sheetText === el.textContent) return el._sheet;
    var s = el._sheet || new CSSStyleSheet(el);
    s.cssRules = parseSheetText(el.textContent, s).cssRules;
    // (the change that gave it this text has been told: its coming, its
    // text, styleSheetChanged. Told again here, in the middle of a cascade
    // that asked for the sheets, every style found so far was thrown away.)
    sheetQuiet++;
    try { s._rebuild(); } finally { sheetQuiet--; }
    el._sheet = s;
    el._sheetText = el.textContent;
    return s;
  }
  var linkSheets = [];
  // the document's <style> and <link> sheets for the cascade, found once per
  // style change (styleGen) rather than by a walk of the page per element
  var sheetsCache = { gen: -1, d: null, list: null };
  function cascadeSheets(d) {
    if (sheetsCache.gen !== sheetGen || sheetsCache.d !== d) {
      // without the adopted sheets: assigning the list is no change
      var all = styleSheetsOf(d);
      sheetsCache = { gen: sheetGen, d: d, list: all.slice(0, all.length - (d.adoptedStyleSheets || []).length) };
    }
    return sheetsCache.list.concat(d.adoptedStyleSheets || []);
  }
  function styleSheetsOf(d) {
    var out = [];
    eachElement(d, function (e) {
      if (e.localName === 'style' && e.namespaceURI === HTML_NS) out.push(sheetOfStyle(e));
      else if (e.localName === 'link') { for (var i = 0; i < linkSheets.length; i++) if (linkSheets[i].ownerNode === e) out.push(linkSheets[i]); }
    });
    for (var j = 0; j < linkSheets.length; j++) if (!linkSheets[j].ownerNode || !linkSheets[j].ownerNode.isConnected) { if (!linkSheets[j].ownerNode) out.push(linkSheets[j]); }
    var adopted = d.adoptedStyleSheets || [];
    for (var k = 0; k < adopted.length; k++) out.push(adopted[k]);
    out.item = function (i) { return this[i] || null; };
    return out;
  }

  // ---- CSS: media queries --------------------------------------------------

  var mediaCache = {};
  function mediaMatches(q) {
    if (!q) return true;
    var key = q + '|' + viewport.w + 'x' + viewport.h;
    if (mediaCache[key] !== undefined) return mediaCache[key];
    var r = evalMedia(q);
    mediaCache[key] = r;
    return r;
  }
  function evalMedia(q) {
    q = q.trim().toLowerCase();
    if (!q || q === 'all' || q === 'screen') return true;
    var alts = splitComma(q);
    if (alts.length > 1) { for (var i = 0; i < alts.length; i++) if (evalMedia(alts[i])) return true; return false; }
    var neg = false;
    if (/^not\s+/.test(q)) { neg = true; q = q.replace(/^not\s+/, ''); }
    q = q.replace(/^only\s+/, '');
    var parts = q.split(/\s+and\s+/);
    var ok = true;
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k].trim();
      if (p === 'screen' || p === 'all') continue;
      if (p === 'print' || p === 'speech') { ok = false; break; }
      var m = /^\(\s*([a-z\-]+)\s*(?::\s*([^)]+))?\)$/.exec(p);
      if (!m) {
        // range syntax: (width >= 640px), (640px <= width <= 1024px)
        var rm = /^\(\s*([a-z\-]+)\s*(<=|>=|<|>|=)\s*([^)]+)\)$/.exec(p);
        if (rm) { if (!rangeFeature(rm[1], rm[2], rm[3])) { ok = false; break; } continue; }
        var rm2 = /^\(\s*([^<>=]+?)\s*(<=|<)\s*([a-z\-]+)\s*(<=|<)\s*([^)]+)\)$/.exec(p);
        if (rm2) { if (!rangeFeature(rm2[3], rm2[2] === '<=' ? '>=' : '>', rm2[1]) || !rangeFeature(rm2[3], rm2[4], rm2[5])) { ok = false; break; } continue; }
        ok = false; break;
      }
      if (!mediaFeature(m[1], m[2] ? m[2].trim() : null)) { ok = false; break; }
    }
    return neg ? !ok : ok;
  }
  function mediaPx(v) {
    v = v.trim();
    var n = parseFloat(v);
    if (/em$/.test(v)) return n * 16;
    return n;
  }
  function rangeFeature(f, op, v) {
    var have = f === 'width' ? viewport.w : f === 'height' ? viewport.h : f === 'aspect-ratio' ? viewport.w / viewport.h : NaN;
    var want = f === 'aspect-ratio' ? (function () { var r = v.split('/'); return parseFloat(r[0]) / parseFloat(r[1] || '1'); })() : mediaPx(v);
    if (op === '>=') return have >= want;
    if (op === '>') return have > want;
    if (op === '<=') return have <= want;
    if (op === '<') return have < want;
    return have === want;
  }
  function mediaFeature(f, v) {
    switch (f) {
      case 'min-width': return viewport.w >= mediaPx(v);
      case 'max-width': return viewport.w <= mediaPx(v);
      case 'min-height': return viewport.h >= mediaPx(v);
      case 'max-height': return viewport.h <= mediaPx(v);
      case 'width': return v === null || viewport.w === mediaPx(v);
      case 'height': return v === null || viewport.h === mediaPx(v);
      case 'orientation': return v === (viewport.w >= viewport.h ? 'landscape' : 'portrait');
      case 'prefers-color-scheme': return v === 'light';
      case 'prefers-reduced-motion': return v === 'no-preference';
      case 'prefers-contrast': return v === 'no-preference';
      case 'prefers-reduced-transparency': return v === 'no-preference';
      case 'forced-colors': return v === 'none';
      case 'hover': return v === null || v === 'hover';
      case 'any-hover': return v === null || v === 'hover';
      case 'pointer': case 'any-pointer': return v === null || v === 'fine';
      case 'color': return true;
      case 'min-resolution': case 'resolution': case 'max-resolution': return f !== 'min-resolution' || parseFloat(v) <= 1;
      case '-webkit-min-device-pixel-ratio': case 'min-device-pixel-ratio': return parseFloat(v) <= 1;
      case 'display-mode': return v === 'browser';
      case 'scripting': return v === 'enabled';
      case 'update': return v === 'fast';
      default: return false;
    }
  }

  class MediaQueryList extends EventTarget {
    constructor(q) { super(); this.media = q; this._last = mediaMatches(q); mediaLists.push(this); this.onchange = null; }
    get matches() { return evalMedia(this.media); }
    addListener(fn) { this.addEventListener('change', fn); }
    removeListener(fn) { this.removeEventListener('change', fn); }
  }
  var mediaLists = [];
  function mediaChanged() {
    for (var i = 0; i < mediaLists.length; i++) {
      var m = mediaLists[i], now2 = evalMedia(m.media);
      if (now2 !== m._last) {
        m._last = now2;
        var ev = new Event('change');
        ev.matches = now2; ev.media = m.media;
        dispatch(m, ev);
      }
    }
  }

  // ---- CSS: the cascade ----------------------------------------------------

  var INHERITED = {
    'color': 1, 'font-family': 1, 'font-size': 1, 'font-weight': 1, 'font-style': 1, 'font-variant': 1, 'font-stretch': 1,
    'line-height': 1, 'letter-spacing': 1, 'word-spacing': 1, 'text-align': 1, 'text-indent': 1, 'text-transform': 1,
    'white-space': 1, 'word-break': 1, 'overflow-wrap': 1, 'word-wrap': 1, 'hyphens': 1, 'visibility': 1, 'cursor': 1,
    'direction': 1, 'list-style-type': 1, 'list-style-position': 1, 'list-style-image': 1, 'quotes': 1, 'tab-size': 1,
    'text-shadow': 1, 'caret-color': 1, 'pointer-events': 1, 'user-select': 1, '-webkit-user-select': 1, 'border-collapse': 1,
    'border-spacing': 1, 'empty-cells': 1, 'caption-side': 1, 'writing-mode': 1, 'text-orientation': 1, 'text-rendering': 1, '-webkit-font-smoothing': 1,
    'font-feature-settings': 1, 'font-variation-settings': 1, 'color-scheme': 1, 'accent-color': 1, 'text-decoration-skip-ink': 1,
    'line-break': 1, 'text-wrap': 1, '-webkit-text-fill-color': 1, 'paint-order': 1, 'fill': 1, 'stroke': 1, 'stroke-width': 1, 'fill-rule': 1
  };
  var INITIAL = {
    'display': 'inline', 'position': 'static', 'color': 'rgb(0, 0, 0)', 'font-size': '16px', 'font-weight': '400',
    'font-style': 'normal', 'font-family': 'Times New Roman', 'line-height': 'normal', 'visibility': 'visible',
    'opacity': '1', 'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'z-index': 'auto',
    'background-repeat': 'repeat', 'background-position': '0% 0%', 'background-size': 'auto', 'background-attachment': 'scroll',
    'overflow-x': 'visible', 'overflow-y': 'visible', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'flex-grow': '0',
    'flex-shrink': '1', 'flex-basis': 'auto', 'justify-content': 'normal', 'align-items': 'normal', 'align-self': 'auto',
    'align-content': 'normal', 'width': 'auto', 'height': 'auto', 'min-width': 'auto', 'min-height': 'auto',
    'max-width': 'none', 'max-height': 'none', 'top': 'auto', 'right': 'auto', 'bottom': 'auto', 'left': 'auto',
    'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
    'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
    'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
    'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none',
    'border-top-color': 'currentcolor', 'border-right-color': 'currentcolor', 'border-bottom-color': 'currentcolor', 'border-left-color': 'currentcolor',
    'border-top-left-radius': '0px', 'border-top-right-radius': '0px', 'border-bottom-right-radius': '0px', 'border-bottom-left-radius': '0px',
    'text-align': 'start', 'white-space': 'normal', 'cursor': 'auto', 'pointer-events': 'auto', 'box-sizing': 'content-box',
    'transform': 'none', 'box-shadow': 'none', 'text-decoration-line': 'none', 'row-gap': 'normal', 'column-gap': 'normal',
    'letter-spacing': 'normal', 'text-transform': 'none', 'float': 'none', 'clear': 'none', 'transition-duration': '0s',
    'animation-name': 'none', 'animation-duration': '0s', 'animation-delay': '0s', 'animation-timing-function': 'ease', 'animation-iteration-count': '1', 'animation-direction': 'normal', 'animation-fill-mode': 'none', 'animation-play-state': 'running', 'list-style-type': 'disc', 'vertical-align': 'baseline', 'outline-style': 'none', 'outline-width': '0px',
    'text-overflow': 'clip', 'word-break': 'normal', 'overflow-wrap': 'normal', 'grid-template-columns': 'none', 'grid-template-rows': 'none',
    'direction': 'ltr', 'object-fit': 'fill', 'user-select': 'auto', 'filter': 'none', 'backdrop-filter': 'none', 'content': 'normal',
    'fill': 'rgb(0, 0, 0)', 'stroke': 'none', 'inset': 'auto', 'stop-color': 'rgb(0, 0, 0)', 'stop-opacity': '1'
  };

  // the user agent's sheet: display and the few looks a page relies on
  var UA_CSS = [
    'html,address,blockquote,body,dd,div,dl,dt,fieldset,form,frame,frameset,h1,h2,h3,h4,h5,h6,noframes,ol,p,ul,center,dir,hr,menu,pre,article,aside,footer,header,hgroup,main,nav,section,search,figure,figcaption,details,summary,legend,dialog,optgroup{display:block}',
    'head,script,style,link,meta,title,template,noscript,datalist,param,base,[hidden]:not([hidden=until-found]),area,map{display:none}slot{display:contents}',
    'li{display:list-item}table{display:table;border-collapse:separate;border-spacing:2px;box-sizing:border-box}tr{display:table-row}thead{display:table-header-group}tbody{display:table-row-group}tfoot{display:table-footer-group}td,th{display:table-cell;padding:1px;vertical-align:inherit}thead,tbody,tfoot,tr{vertical-align:middle}th{font-weight:700;text-align:center}caption{display:table-caption;text-align:center}col{display:table-column}colgroup{display:table-column-group}',
    'body{margin:8px}p,blockquote,figure,dl,pre{margin-top:1em;margin-bottom:1em}ul,ol,menu{margin-top:1em;margin-bottom:1em;padding-left:40px}ol{list-style-type:decimal}ul ul,ol ul,ul ol,ol ol{margin-top:0;margin-bottom:0}ul ul,ol ul,menu ul,ul menu{list-style-type:circle}ul ul ul,ul ol ul,ol ul ul,ol ol ul,ul ul menu{list-style-type:square}dd{margin-left:40px}blockquote,figure{margin-left:40px;margin-right:40px}',
    'h1{font-size:2em;margin-top:.67em;margin-bottom:.67em;font-weight:700}h2{font-size:1.5em;margin-top:.83em;margin-bottom:.83em;font-weight:700}h3{font-size:1.17em;margin-top:1em;margin-bottom:1em;font-weight:700}h4{margin-top:1.33em;margin-bottom:1.33em;font-weight:700}h5{font-size:.83em;margin-top:1.67em;margin-bottom:1.67em;font-weight:700}h6{font-size:.67em;margin-top:2.33em;margin-bottom:2.33em;font-weight:700}',
    'b,strong{font-weight:700}i,em,cite,var,dfn,address{font-style:italic}u,ins{text-decoration:underline}s,del,strike{text-decoration:line-through}small{font-size:smaller}sub{vertical-align:sub;font-size:smaller}sup{vertical-align:super;font-size:smaller}code,kbd,samp,pre,tt{font-family:monospace}pre{white-space:pre}',
    'a:any-link{color:rgb(0,0,238);text-decoration:underline;cursor:pointer}hr{border-top:1px inset rgb(128,128,128);margin-top:.5em;margin-bottom:.5em}',
    'input,select,textarea,button{display:inline-block;font-size:13.333px;font-family:Arial;letter-spacing:normal;word-spacing:normal;line-height:normal;text-transform:none;text-indent:0;text-shadow:none;text-align:start;color:rgb(0,0,0)}',
    'input,textarea,select{background-color:rgb(255,255,255);border:2px inset rgb(118,118,118)}input{padding:1px 2px}textarea{padding:2px;white-space:pre-wrap}button,input[type=button],input[type=submit],input[type=reset]{padding:1px 6px;border:2px outset rgb(118,118,118);background-color:rgb(239,239,239);text-align:center;cursor:default}input[type=hidden]{display:none}input[type=color]{width:50px;height:27px;padding:1px 2px;border:1px solid rgb(118,118,118);border-radius:2px;background-color:rgb(239,239,239)}input[type=range]{width:129px;height:16px;margin:2px;padding:0;border:0;background-color:transparent}input[type=file]{padding:0;border:0;background-color:transparent}input[type=checkbox]{margin:3px 3px 3px 4px}input[type=radio]{margin:3px 3px 0 5px}button:disabled,input[type=button]:disabled,input[type=submit]:disabled,input[type=reset]:disabled{color:rgba(16,16,16,0.3);border-color:rgba(118,118,118,0.3);background-color:rgba(239,239,239,0.3)}button,select,input[type=button],input[type=submit],input[type=reset],input[type=color],input[type=checkbox],input[type=radio]{box-sizing:border-box}',
    'img,svg,video,canvas,iframe,embed,object{display:inline-block}svg:not(:root){overflow:hidden}iframe{border:2px inset rgb(118,118,118)}fieldset{margin-left:2px;margin-right:2px;padding:.35em .75em .625em;border:2px groove rgb(192,192,192)}legend{padding-left:2px;padding-right:2px}',
    '[dir=rtl]{direction:rtl}[dir=ltr]{direction:ltr}',
    ':focus-visible{outline:auto 1px rgb(16,16,16)}',
    '[popover]:not(:popover-open):not(dialog[open]){display:none}[popover]{position:fixed;inset:0;width:fit-content;height:fit-content;margin:auto;border:solid;padding:.25em;overflow:auto;color:black;background-color:white}dialog:modal{position:fixed;top:0;bottom:0;max-width:calc(100% - 6px - 2em);max-height:calc(100% - 6px - 2em);overflow:auto}',
    'dialog:not([open]){display:none}dialog{position:absolute;left:0;right:0;width:fit-content;height:fit-content;margin:auto;border:solid;padding:1em;background-color:white;color:black}mark{background-color:yellow;color:black}center{text-align:center}'
  ].join('\n');
  var uaSheet = null;
  function ua() {
    if (!uaSheet) { uaSheet = new CSSStyleSheet(null); uaSheet._ua = true; uaSheet.cssRules = parseSheetText(UA_CSS, uaSheet).cssRules; uaSheet._rebuild(); }
    return uaSheet;
  }

  var candStamp = 0;
  function candidates(sheet, el, out, pe) {
    var idx = pe ? sheet._pindex && sheet._pindex[pe] : sheet._index;
    if (!idx) return;
    // (a rule under more than one key once)
    var stamp = ++candStamp;
    function take(k) {
      var l = idx[k];
      if (l) for (var i = 0; i < l.length; i++) {
        var r = l[i];
        if (r._multi) { if (r._cs === stamp) continue; r._cs = stamp; }
        out.push(r);
      }
    }
    var id = attrOf(el, 'id');
    if (id) take('#' + id);
    var cls = attrOf(el, 'class');
    if (cls) {
      var cl = cls.split(/[ \t\n\f\r]+/);
      for (var i = 0; i < cl.length; i++) if (cl[i]) take('.' + cl[i]);
    }
    take(el.localName);
    if (el.namespaceURI !== HTML_NS && el.localName !== el.localName.toLowerCase()) take(el.localName.toLowerCase());
    take('*');
    if (el.parentNode && el.parentNode.nodeType === 9) take(':root');
    for (var a = 0; a < el._attrs.length; a++) take('[' + el._attrs[a].name.toLowerCase());
  }

  // the cascaded declarations of an element: {name: value} after
  // origin, importance, specificity and order
  // (pe: the declarations of its ::before or ::after box instead)
  // (a pseudo-element's declarations asked for twice in a row, by
  // pseudoBox and then computeStyle: made once)
  var NO_PSEUDO = { el: null, pe: '', gen: -1, out: null }, lastPseudo = NO_PSEUDO;
  function cascade(el, pe) {
    // (good for the very next call only)
    var lp = lastPseudo;
    lastPseudo = NO_PSEUDO;
    if (pe && lp.el === el && lp.pe === pe && lp.gen === styleGen) return lp.out;
    if (pe) { var po = cascade1(el, pe); lastPseudo = { el: el, pe: pe, gen: styleGen, out: po }; return po; }
    return cascade1(el);
  }
  // a shadow root's sheets: its <style>s, then its adopted ones
  function shadowSheets(sr) {
    if (sr._sheetGen === sheetGen && sr._sheets) return sr._sheets;
    var out = [];
    eachElement(sr, function (e) { if (e.localName === 'style' && e.namespaceURI === HTML_NS) out.push(sheetOfStyle(e)); });
    for (var i = 0; i < sr._adopted.length; i++) out.push(sr._adopted[i]);
    out = out.filter(function (x) { return x && !x.disabled; });
    sr._sheets = out; sr._sheetGen = sheetGen;
    return out;
  }
  // the rules of a shadow tree's sheets for the tree's host (:host) and
  // for the host's children its slots take (::slotted()): below the
  // page's rules in the cascade (CSS Scoping 3.3, the outer context wins)
  function innerHits(el, pe, hits) {
    var sv = shadowCtx;
    if (el._sr && !pe) {
      var hs = shadowSheets(el._sr);
      shadowCtx = el._sr;
      for (var s = 0; s < hs.length; s++) {
        var cand = [];
        candidates(hs[s], el, cand, null);
        for (var i = 0; i < cand.length; i++) {
          var r = cand[i];
          if (r.sel.pseudo || !hasHostPseudo(r.sel.parts[0].c)) continue;
          if (r.media && !mediaMatches(r.media)) continue;
          if (matchComplex(el, r.sel, null)) hits.push({ r: r, sheet: -1000 + s, ua: false, inner: true });
        }
      }
    }
    var slot = !pe && el.parentNode && el.parentNode._sr ? assignedSlotOf(el) : null;
    if (slot) {
      var ss = shadowSheets(el.parentNode._sr);
      shadowCtx = el.parentNode._sr;
      for (var t = 0; t < ss.length; t++) {
        var pidx = ss[t]._pindex && ss[t]._pindex.slotted;
        if (!pidx) continue;
        for (var key in pidx) for (var j = 0; j < pidx[key].length; j++) {
          var sr2 = pidx[key][j];
          if (sr2.media && !mediaMatches(sr2.media)) continue;
          var c0 = sr2.sel.parts[0].c, pel = null;
          for (var q = 0; q < c0.length; q++) if (c0[q].t === 'pseudoel' && c0[q].n === 'slotted') pel = c0[q];
          if (!pel || pel.arg === undefined) continue;
          var inner = shadowCtx;
          shadowCtx = null;
          var okArg = false;
          try { okArg = matchList(el, parseSelectorList(pel.arg)); } catch (e) { okArg = false; }
          shadowCtx = inner;
          if (!okArg) continue;
          var slotSide = { parts: [{ c: c0.filter(function (x) { return x !== pel; }), comb: sr2.sel.parts[0].comb }].concat(sr2.sel.parts.slice(1)) };
          if (matchComplex(slot, slotSide, null)) hits.push({ r: sr2, sheet: -500 + t, ua: false, inner: true });
        }
      }
    }
    shadowCtx = sv;
  }
  // The sheets of one scope (the document's, a shadow root's) as one rule
  // set: every sheet's rules under their keys in one index, each rule with
  // its sheet's place in the list. An element's candidates are one lookup
  // per key, not one per key and sheet (AG Grid's theme is 25 sheets; a
  // CSS-in-JS page has more). Kept while the list and each sheet's rules
  // are the same ones, so a change that leaves the sheets alone (styleGen)
  // costs a comparison of the lists (each scope keeps its last set).
  var ruleSetBuild = 0;
  function ruleSetOf(list, have) {
    if (have && have.list.length === list.length) {
      var same = true;
      for (var q = 0; q < list.length && same; q++) same = have.list[q] === list[q] && have.of[q] === list[q]._index;
      if (same) return have;
    }
    // (another scope's set of the same sheets: its index is this one's
    // too. The shadow roots of one component share their constructed
    // sheets, and 50 new buttons made the same index 50 times.)
    for (var g = sigSets.length - 1; g >= 0; g--) {
      var o = sigSets[g];
      if (o.list.length !== list.length) continue;
      var eq = true;
      for (var q2 = 0; q2 < list.length && eq; q2++) eq = o.list[q2] === list[q2] && o.of[q2] === list[q2]._index;
      if (!eq) continue;
      var sh = { list: o.list, of: o.of, idx: o.idx, pidx: o.pidx, _sc: new Map(), _sa: o._sa, _base: o };
      sigSets.push(sh); if (sigSets.length > 8) sigSets.shift();
      return sh;
    }
    var rs = { list: list.slice(), of: [], idx: Object.create(null), pidx: Object.create(null), _sc: new Map(), _sa: null };
    sigSets.push(rs); if (sigSets.length > 8) sigSets.shift();
    var build = ++ruleSetBuild;
    function merge(from, into, s, sheet) {
      for (var k in from) {
        var l = from[k], to = into[k] || (into[k] = []);
        for (var i = 0; i < l.length; i++) {
          var r = l[i];
          // (a rule under several keys: one entry, taken once per element)
          if (r._wb !== build || r._ws !== s) { r._wb = build; r._ws = s; r._w = { r: r, sheet: s, ua: !!sheet._ua, sh: sheet, multi: !!r._multi, cs: 0 }; }
          to.push(r._w);
        }
      }
    }
    for (var s = 0; s < list.length; s++) {
      var sheet = list[s];
      rs.of.push(sheet._index);
      if (sheet._index) merge(sheet._index, rs.idx, s, sheet);
      if (sheet._pindex) for (var pn in sheet._pindex) merge(sheet._pindex[pn], rs.pidx[pn] || (rs.pidx[pn] = Object.create(null)), s, sheet);
    }
    return rs;
  }
  var docRuleSet = { gen: -1, d: null, rs: null };
  function scopeRuleSet(d, esr) {
    if (esr) {
      if (esr._rsGen !== sheetGen || !esr._rs) { esr._rs = ruleSetOf([ua()].concat(shadowSheets(esr)), esr._rs); esr._rsGen = sheetGen; }
      return esr._rs;
    }
    if (docRuleSet.gen !== sheetGen || docRuleSet.d !== d) {
      docRuleSet = { gen: sheetGen, d: d, rs: ruleSetOf([ua()].concat(d === doc ? cascadeSheets(d).filter(function (x) { return !x.disabled; }) : []), docRuleSet.rs) };
    }
    return docRuleSet.rs;
  }
  // A selector is plain when what it answers for an element follows from
  // the element's and its ancestors' types, ids, classes and attributes
  // alone: compounds of those with descendant and child combinators, and
  // :is(), :where(), :not() of such, :root. Not one with a state or a
  // structural pseudo-class, + or ~, :has(), or one that reads the style
  // attribute.
  function plainList(list) { for (var i = 0; i < list.length; i++) if (!plainParts(list[i], true)) return false; return true; }
  function plainParts(sel, inner) {
    var parts = sel.parts;
    if (!parts) return false;
    for (var k = 0; k < parts.length; k++) {
      var cb = parts[k].comb;
      if (k + 1 < parts.length && cb !== ' ' && cb !== '>') return false;
      var c = parts[k].c;
      for (var q = 0; q < c.length; q++) {
        var x = c[q];
        if (x.t === 'tag' || x.t === 'id' || x.t === 'class') continue;
        if (x.t === 'attr') { if (x.n === 'style') return false; continue; }
        if (x.t === 'pseudo' && x.n === 'root') continue;
        if (x.t === 'pseudo' && (x.n === 'is' || x.n === 'where' || x.n === 'not') && x.list && plainList(x.list)) continue;
        // (the selector's own ::before or ::after: the rules are kept per
        // pseudo-element, and matching does not read it)
        if (x.t === 'pseudoel' && !inner && (x.n === 'before' || x.n === 'after') && k === 0) continue;
        return false;
      }
    }
    return true;
  }
  // the states a selector needs some element to be in to match at all:
  // 1 focus (:focus, :focus-visible, :focus-within), 2 :hover, 4 :active;
  // 0 when it can match with no element in any. :is() and :where() need
  // what every one of their alternatives needs.
  function stateNeedOf(sel) {
    var parts = sel.parts;
    if (!parts) return 0;
    for (var k = 0; k < parts.length; k++) {
      var c = parts[k].c;
      for (var q = 0; q < c.length; q++) {
        var x = c[q];
        if (x.t !== 'pseudo') continue;
        if (x.n === 'focus' || x.n === 'focus-visible' || x.n === 'focus-within') return 1;
        if (x.n === 'hover') return 2;
        if (x.n === 'active') return 4;
        if ((x.n === 'is' || x.n === 'where') && x.list && x.list.length) {
          var u = 0;
          for (var i = 0; i < x.list.length; i++) { var a = stateNeedOf(x.list[i]); if (!a) { u = 0; break; } u |= a; }
          if (u) return u;
        }
      }
    }
    return 0;
  }
  function stateNeed(sel) {
    var n = stateNeedOf(sel);
    Object.defineProperty(sel, '_sn', { value: n, enumerable: false, writable: true });
    return n;
  }
  function plainSel(sel) {
    var pl = plainParts(sel);
    Object.defineProperty(sel, '_plain', { value: pl, enumerable: false, writable: true });
    return pl;
  }
  // the attribute names the selectors of a rule set read, and the ids they
  // name ('#' + the id in lower case)
  function selAttrsOf(rs) {
    var names = Object.create(null);
    function ofList(list) { for (var i = 0; i < list.length; i++) ofSel(list[i]); }
    function ofSel(sel) {
      var parts = sel && sel.parts;
      if (!parts) return;
      for (var k = 0; k < parts.length; k++) {
        var c = parts[k].c;
        for (var q = 0; q < c.length; q++) { if (c[q].t === 'attr') names[c[q].n] = 1; else if (c[q].t === 'id') names['#' + String(c[q].v).toLowerCase()] = 1; else if (c[q].list) ofList(c[q].list); }
      }
    }
    function ofIdx(idx) { for (var key in idx) { var l = idx[key]; for (var i = 0; i < l.length; i++) ofSel(l[i].r.sel); } }
    ofIdx(rs.idx);
    for (var pn in rs.pidx) ofIdx(rs.pidx[pn]);
    return names;
  }
  // An element's signature in a rule set: a number that two elements share
  // when they are alike in type, id, class and the attributes the selectors
  // read, and their parents share one too. The plain selectors then match
  // both or neither (cascade1 keeps what the first matched): a grid's cells
  // and a table's rows are matched once per kind, not once each. A parent's
  // is kept with it until an attribute or the tree changes (sigEpoch).
  var sigIds = new Map(), sigUid = 0;
  function sigOf(el, rs) {
    var sa = rs._sa;
    if (!sa) { sa = rs._sa = (rs._base && rs._base._sa) || selAttrsOf(rs); if (rs._base && !rs._base._sa) rs._base._sa = sa; }
    var p = el.parentNode, ps = 'x';
    if (p) {
      if (p.nodeType === 1) {
        if (p._sgE === sigEpoch && p._sgR === rs) ps = p._sg;
        else { ps = sigOf(p, rs); p._sg = ps; p._sgE = sigEpoch; p._sgR = rs; }
      } else ps = p.nodeType === 9 ? 'r' : 'f';
    }
    var html = el.namespaceURI === HTML_NS;
    var key = ps + '\u0001' + el.localName + (html ? '' : '\u0001' + el.namespaceURI);
    var at = el._attrs;
    for (var a = 0; a < at.length; a++) {
      var an = at[a].name;
      if (an === 'style') continue;
      if (!html) an = an.toLowerCase();
      // (an id no selector names tells elements apart for no rule: AG Grid
      // gives every checkbox one of its own, a new signature per row)
      if (an === 'class' || sa[an] === 1 || (an === 'id' && sa['#' + String(at[a]._v).toLowerCase()] === 1)) key += '\u0001' + an + '\u0002' + at[a]._v;
    }
    var id = sigIds.get(key);
    if (id === undefined) {
      if (sigIds.size >= 100000) { sigIds.clear(); sigEpoch++; resetSigCaches(); }
      id = ++sigUid; sigIds.set(key, id);
    }
    return id;
  }
  var sigSets = [];
  function resetSigCaches() { for (var i = 0; i < sigSets.length; i++) sigSets[i]._sc.clear(); }
  function setCandidates(rs, el, out, pe) {
    var idx = pe ? rs.pidx[pe] : rs.idx;
    if (!idx) return;
    var stamp = ++candStamp, l, i, w;
    var id = attrOf(el, 'id');
    if (id && (l = idx['#' + id])) for (i = 0; i < l.length; i++) { w = l[i]; if (w.multi) { if (w.cs === stamp) continue; w.cs = stamp; } out.push(w); }
    var cls = attrOf(el, 'class');
    if (cls) {
      var set = classSet(el);
      for (var cn in set) if ((l = idx['.' + cn])) for (i = 0; i < l.length; i++) { w = l[i]; if (w.multi) { if (w.cs === stamp) continue; w.cs = stamp; } out.push(w); }
    }
    var ln = el.localName;
    if ((l = idx[ln])) for (i = 0; i < l.length; i++) { w = l[i]; if (w.multi) { if (w.cs === stamp) continue; w.cs = stamp; } out.push(w); }
    if (el.namespaceURI !== HTML_NS && ln !== ln.toLowerCase() && (l = idx[ln.toLowerCase()])) for (i = 0; i < l.length; i++) { w = l[i]; if (w.multi) { if (w.cs === stamp) continue; w.cs = stamp; } out.push(w); }
    if ((l = idx['*'])) for (i = 0; i < l.length; i++) { w = l[i]; if (w.multi) { if (w.cs === stamp) continue; w.cs = stamp; } out.push(w); }
    if (el.parentNode && el.parentNode.nodeType === 9 && (l = idx[':root'])) for (i = 0; i < l.length; i++) { w = l[i]; if (w.multi) { if (w.cs === stamp) continue; w.cs = stamp; } out.push(w); }
    var at = el._attrs;
    for (var a = 0; a < at.length; a++) if ((l = idx['[' + at[a].name.toLowerCase()])) for (i = 0; i < l.length; i++) { w = l[i]; if (w.multi) { if (w.cs === stamp) continue; w.cs = stamp; } out.push(w); }
  }
  // The names a selector needs among its subject's ancestors: the classes,
  // ids and types of its compounds that a descendant or child combinator
  // leads to ('c:x', 'i:x', 't:x'), null when none. An element with an
  // ancestor chain that lacks one cannot match, whatever else the selector
  // says (WebKit's and Blink's ancestor filter): of the 497 000 rule
  // checks for 1000 Bootstrap table rows, 84 % end here.
  function needOf(sel) {
    var parts = sel.parts, need = null;
    if (parts) for (var k = 1; k < parts.length; k++) {
      var cb = parts[k - 1].comb;
      if (cb !== ' ' && cb !== '>') continue;
      var c = parts[k].c;
      for (var q = 0; q < c.length; q++) {
        var x = c[q];
        if (x.t === 'class') (need || (need = [])).push('c:' + x.v);
        else if (x.t === 'id') (need || (need = [])).push('i:' + x.v);
        else if (x.t === 'tag' && x.v !== '*') (need || (need = [])).push('t:' + x.v);
        // (:is() or :where() on an ancestor: one name of each alternative's
        // own compound, any one of which the chain must have. Without it
        // `:is(.a, .b) li span` went up every span's chain for every such
        // rule of the sheet.)
        else if (x.t === 'pseudo' && (x.n === 'is' || x.n === 'where') && x.list && x.list.length) {
          var any = [];
          for (var ai = 0; ai < x.list.length && any; ai++) {
            var ap = x.list[ai].parts, ac = ap && ap.length ? ap[0].c : null, nm = null;
            if (ac) for (var aq = 0; aq < ac.length && !nm; aq++) {
              if (ac[aq].t === 'class') nm = 'c:' + ac[aq].v; else if (ac[aq].t === 'id') nm = 'i:' + ac[aq].v; else if (ac[aq].t === 'tag' && ac[aq].v !== '*') nm = 't:' + ac[aq].v;
            }
            if (nm) any.push(nm); else any = null;
          }
          if (any) (need || (need = [])).push(any.length === 1 ? any[0] : any);
        }
      }
    }
    Object.defineProperty(sel, '_need', { value: need, enumerable: false, writable: true });
    return need;
  }
  function lacksNeed(anc, need) {
    for (var i = 0; i < need.length; i++) {
      var n = need[i];
      if (typeof n === 'string') { if (anc[n] !== 1) return true; continue; }
      var one = false;
      for (var j = 0; j < n.length && !one; j++) if (anc[n[j]] === 1) one = true;
      if (!one) return true;
    }
    return false;
  }
  // the names of el's ancestors (their classes, ids, types in lower case),
  // one object for all the children of a parent, kept until the tree or a
  // class or an id changes (ancEpoch)
  var NO_ANC = {};
  function ancOf(el) {
    var p = el.parentNode;
    if (!p || p.nodeType !== 1) return NO_ANC;
    if (p._kaE === ancEpoch) return p._ka;
    var up = ancOf(p), set = {};
    for (var k in up) set[k] = 1;
    set['t:' + String(p.localName).toLowerCase()] = 1;
    var id = attrOf(p, 'id');
    if (id) set['i:' + id] = 1;
    var cl = attrOf(p, 'class');
    if (cl) { var cs = classSet(p); for (var ck in cs) set['c:' + ck] = 1; }
    p._ka = set; p._kaE = ancEpoch;
    return set;
  }
  function cascade1(el, pe) {
    var d = el.ownerDocument || doc;
    var esr = shadowCount ? shadowRootOf(el) : null;
    // the rules that match el (or its pseudo-element), kept with it until
    // its style is dropped (dropStyle) or any sheet changes: an element
    // styled again for what its parent hands down matches the same rules
    var hm = el._hm, hmk = pe || '', kept = hm && hm.gen === styleGen ? hm.m[hmk] : undefined;
    var hits = kept !== undefined ? kept.slice() : [];
    var svCtx = shadowCtx;
    shadowCtx = esr;
    var cand = [], rs = null, sg = 0, sc = null, dyn = null, nPlain = 0, scw = null;
    if (kept === undefined) {
      rs = scopeRuleSet(d, esr);
      // (elements alike in what the plain selectors read, see sigOf: the
      // rules found for the first one; only the others are tried)
      if (!shadowCount && d === doc) {
        // (kept with the element as for a parent: its ::before and ::after
        // ask again)
        if (el._sgE === sigEpoch && el._sgR === rs) sg = el._sg;
        else { sg = sigOf(el, rs); el._sg = sg; el._sgE = sigEpoch; el._sgR = rs; }
        var sck = pe ? sg + ':' + pe : sg;
        sc = rs._sc.get(sck);
        // (kept for the viewport its media rules were answered for)
        if (sc && (sc.vw !== viewport.w || sc.vh !== viewport.h)) sc = undefined;
        // (a pseudo-element of elements alike with plain rules only: the
        // declarations found for the first one. Bootstrap's `*, ::before,
        // ::after` gives every element two, asked again whenever its
        // style is dropped.)
        if (sc && pe && !sc.dyn.length) {
          if (sc.og === styleGen) { shadowCtx = svCtx; return sc.out; }
          scw = sc;
        }
        if (sc) { for (var sh = 0; sh < sc.plain.length; sh++) hits.push(sc.plain[sh]); cand = sc.dyn; }
        else { setCandidates(rs, el, cand, pe); dyn = []; }
      } else setCandidates(rs, el, cand, pe);
    }
    var anc = shadowCount || !cand.length ? null : ancOf(el);
    // (the states some element is in: a rule that needs one no element is
    // in, :focus-visible with nothing focused, is not tried)
    var stOn = shadowCount || d !== doc ? 7 : (doc._active ? 1 : 0) | (hoverEl ? 2 : 0) | (activeEl ? 4 : 0);
    for (var i = 0; i < cand.length; i++) {
      var w = cand[i], r = w.r;
      if (pe ? r.sel.pseudo !== pe || !(pe === 'backdrop' ? w.sh._backdrop : w.sh._pseudo) : r.sel.pseudo) continue;
      var sn = r.sel._sn;
      if (sn === undefined) sn = stateNeed(r.sel);
      if (sn && !(sn & stOn)) { if (dyn) dyn.push(w); continue; }
      if (dyn) {
        var pl = r.sel._plain;
        if (pl === undefined) pl = plainSel(r.sel);
        if (!pl) { dyn.push(w); continue; }
      }
      if (anc) {
        var need = r.sel._need;
        if (need === undefined) need = needOf(r.sel);
        if (need && lacksNeed(anc, need)) continue;
      }
      if (r.media) {
        // (kept with the rule for the viewport it was answered for)
        if (r._mqW !== viewport.w || r._mqH !== viewport.h) { r._mqW = viewport.w; r._mqH = viewport.h; r._mq = mediaMatches(r.media); }
        if (!r._mq) continue;
      }
      if (!matchComplex(el, r.sel, null)) continue;
      hits.push(w);
    }
    if (dyn) {
      // (the plain ones first, then the others: the same order as from the
      // kept ones, so that elements alike get the same key below)
      var plain = hits.slice();
      if (rs._sc.size >= 20000) rs._sc.clear();
      var scn = { plain: plain, dyn: dyn, vw: viewport.w, vh: viewport.h, og: -1, out: null };
      rs._sc.set(pe ? sg + ':' + pe : sg, scn);
      if (pe && !dyn.length) scw = scn;
      for (var di = 0; di < dyn.length; di++) {
        var w2 = dyn[di], r2 = w2.r;
        if (r2.sel._sn && !(r2.sel._sn & stOn)) continue;
        if (anc) {
          var need2 = r2.sel._need;
          if (need2 === undefined) need2 = needOf(r2.sel);
          if (need2 && lacksNeed(anc, need2)) continue;
        }
        if (r2.media) {
          if (r2._mqW !== viewport.w || r2._mqH !== viewport.h) { r2._mqW = viewport.w; r2._mqH = viewport.h; r2._mq = mediaMatches(r2.media); }
          if (!r2._mq) continue;
        }
        if (matchComplex(el, r2.sel, null)) hits.push(w2);
      }
    }
    shadowCtx = svCtx;
    if (kept === undefined) {
      if (shadowCount && !pe) innerHits(el, pe, hits);
      if (!hm || hm.gen !== styleGen) { hm = el._hm = { gen: styleGen, m: {} }; if (!el._es) styledNow(el); }
      hm.m[hmk] = hits.slice();
    }
    // (a pseudo-element no rule names: none, nothing built)
    if (pe && !hits.length) { if (scw) { scw.out = null; scw.og = styleGen; } return null; }
    // the same rules, inline style and presentational attributes give the
    // same declarations: elements alike (a table's rows and cells) share
    // one object, which computeStyle then knows them by (_sid)
    var ckey = null;
    if (!pe) {
      ckey = el.localName;
      for (var hk = 0; hk < hits.length; hk++) ckey += ',' + (hits[hk].r._uid || (hits[hk].r._uid = ++ruleUid)) + ':' + hits[hk].sheet;
      ckey += '|' + (attrOf(el, 'style') || '');
      if (el._style) { var est = el._style; for (var eq = 0; eq < est._order.length; eq++) ckey += ';' + est._order[eq] + ':' + est._p[est._order[eq]] + (est._prio[est._order[eq]] ? '!' : ''); }
      if (el.namespaceURI !== HTML_NS) ckey += '|' + el.namespaceURI;
      // (of an HTML element only the attributes presentationalHints reads:
      // AG Grid gives every cell a comp-id of its own, so no two cells
      // shared their declarations)
      var html = el.namespaceURI === HTML_NS;
      for (var ak = 0; ak < el._attrs.length; ak++) {
        var an = el._attrs[ak].name;
        if (html ? !HINT_ATTRS[an.toLowerCase()] : an === 'class' || an === 'id' || an === 'style' || an.slice(0, 5) === 'data-' || an.slice(0, 5) === 'aria-') continue;
        ckey += '|' + an + '=' + el._attrs[ak]._v;
      }
      // (a cell's hints come from its table's attributes too)
      if (html && (el.localName === 'td' || el.localName === 'th')) {
        var tb0 = el.parentNode;
        while (tb0 && tb0.nodeType === 1 && tb0.localName !== 'table') tb0 = tb0.parentNode;
        if (tb0 && tb0.nodeType === 1) ckey += '|t:' + tb0.getAttribute('cellpadding') + ',' + tb0.getAttribute('border');
      }
      var inl = !!(el._style && el._style._order.length) || !!attrOf(el, 'style');
      if (specCache.gen !== styleGen) specCache = { gen: styleGen, map: {}, n: 0 };
      if (inl && (specInline.gen !== styleGen || specInline.n >= INLINE_KEPT)) { specInline = { gen: styleGen, map: {}, n: 0 }; sharedInline = { gen: styleGen, map: {}, n: 0 }; }
      var hit = (inl ? specInline : specCache).map[ckey];
      if (hit) return hit;
    }
    // (a pseudo-element's declarations come from its rules alone: one
    // object for all with the same rules, as specCache is for elements. A
    // page's `*, ::before, ::after` rule gives every element two, and each
    // was sorted and expanded again at every render.)
    var pek = null;
    if (pe) {
      pek = pe;
      for (var pk = 0; pk < hits.length; pk++) pek += ',' + (hits[pk].r._uid || (hits[pk].r._uid = ++ruleUid)) + ':' + hits[pk].sheet;
      if (peSpec.gen !== styleGen) peSpec = { gen: styleGen, map: {}, n: 0 };
      var peHit = peSpec.map[pek];
      if (peHit) { if (scw) { scw.out = peHit; scw.og = styleGen; } return peHit; }
    }
    hits.sort(function (a, b) { return (a.ua === b.ua ? 0 : a.ua ? -1 : 1) || (!a.inner === !b.inner ? 0 : a.inner ? -1 : 1) || cmpSpec(a.r.sel.spec, b.r.sel.spec) || a.sheet - b.sheet || a.r.order - b.r.order; });
    // (seq: when each key was last set, for computeStyle to tell a logical
    // longhand and the physical property it maps to apart, the later winning)
    var out = {}, imp = {}, seq = {}, nseq = 0, auth = {};
    Object.defineProperty(out, '_seq', { value: seq, enumerable: false });
    // (auth: the keys an author rule or the style attribute set; the
    // presentational hints of HTML attributes override only the UA's)
    Object.defineProperty(out, '_auth', { value: auth, enumerable: false });
    function put(name, value, important, uaOrigin) {
      if (imp[name] && !important) return;
      var lh = expandShorthand(name, value);
      if (lh) { for (var k in lh) { if (lh[k] === undefined || (imp[k] && !important)) continue; out[k] = lh[k]; seq[k] = ++nseq; if (!uaOrigin) auth[k] = 1; if (important) imp[k] = uaOrigin ? 1 : 2; } if (name in out && lh[name] === undefined) delete out[name]; return; }
      out[name] = value;
      seq[name] = ++nseq;
      if (!uaOrigin) auth[name] = 1;
      if (important) imp[name] = uaOrigin ? 1 : 2;
    }
    for (var h = 0; h < hits.length; h++) {
      var decls = hits[h].r.decls;
      for (var j = 0; j < decls.length; j++) put(decls[j].name, decls[j].value, decls[j].important && false, hits[h].ua);
    }
    if (pe) {
      // (a pseudo-element has no inline style: its !important ones last)
      for (var hp = 0; hp < hits.length; hp++) {
        var dp = hits[hp].r.decls;
        for (var jp = 0; jp < dp.length; jp++) if (dp[jp].important) put(dp[jp].name, dp[jp].value, true, hits[hp].ua);
      }
      if (peSpec.n < 20000) { Object.defineProperty(out, '_sid', { value: ++specUid, enumerable: false }); peSpec.map[pek] = out; peSpec.n++; if (scw) { scw.out = out; scw.og = styleGen; } }
      return out;
    }
    // inline style
    if (el._style || attrOf(el, 'style') !== null) {
      var st = el._style;
      if (!st) { el.style; st = el._style; }
      for (var q = 0; q < st._order.length; q++) { var nm = st._order[q]; if (!imp[nm]) { out[nm] = st._p[nm]; seq[nm] = ++nseq; auth[nm] = 1; } }
    }
    // !important: author important over inline over normal
    for (var h2 = 0; h2 < hits.length; h2++) {
      var ds = hits[h2].r.decls;
      for (var j2 = 0; j2 < ds.length; j2++) if (ds[j2].important) put(ds[j2].name, ds[j2].value, true, hits[h2].ua);
    }
    if (el._style) {
      var st2 = el._style;
      for (var q2 = 0; q2 < st2._order.length; q2++) { var n2 = st2._order[q2]; if (st2._prio[n2]) { out[n2] = st2._p[n2]; seq[n2] = ++nseq; auth[n2] = 1; } }
    }
    presentationalHints(el, out);
    if (ckey !== null && (inl || specCache.n < 20000)) {
      Object.defineProperty(out, '_sid', { value: ++specUid, enumerable: false });
      if (inl) { Object.defineProperty(out, '_inl', { value: true, enumerable: false }); specInline.map[ckey] = out; specInline.n++; }
      else { specCache.map[ckey] = out; specCache.n++; }
    }
    return out;
  }
  var ruleUid = 0, specUid = 0, styleUid = 0;
  var specCache = { gen: -1, map: {}, n: 0 }, peSpec = { gen: -1, map: {}, n: 0 };
  // computed styles by declarations (_sid) and parent style (_sid): an
  // element with the same declarations as its sibling, under the same
  // parent style, has the same computed style (Blink's matched properties
  // cache); the object is shared, so nothing may change it afterwards
  var sharedCache = { gen: -1, map: {}, n: 0 };
  // the same two caches for elements with an inline style, emptied when
  // full: inline styles that change every frame (a transform, a position)
  // make declarations no other element has, and thousands of them kept
  // until the next sheet change made every collection of the heap slower
  var specInline = { gen: -1, map: {}, n: 0 }, sharedInline = { gen: -1, map: {}, n: 0 };
  var INLINE_KEPT = 3000;
  // the attributes presentationalHints reads from an HTML element
  var HINT_ATTRS = { width: 1, height: 1, align: 1, bgcolor: 1, valign: 1, cellspacing: 1, cellpadding: 1, border: 1, clear: 1 };
  // what a child's computed style takes from its parent's, as a number:
  // the custom properties, the font size and the inherited properties
  // (and display: a flex or grid container's children are blocks). Two
  // parents alike in these give their children with the same declarations
  // the same style, whatever else differs (a grid's rows differ in their
  // transform only, and none of their cells shared a style).
  var ikMap = {}, ikUid = 0, varsUid = 0, varsMemo = { gen: -1, map: {}, n: 0 };
  function varsId(vars) {
    var vid = vars._vid;
    if (vid === undefined) { vid = ++varsUid; Object.defineProperty(vars, '_vid', { value: vid, enumerable: false }); }
    return vid;
  }
  function inheritKey(ps) {
    var k = ps._ik;
    if (k !== undefined) return k;
    var t = (ps._vars ? varsId(ps._vars) : 0) + '\u0001' + ps._fontPx + '\u0001' + (ps._fsKw === false ? 0 : 1) + '\u0001' + ps.display;
    for (var ip in INHERITED) { var v = ps[ip]; t += '\u0001'; if (v !== undefined) t += v; }
    k = ikMap[t];
    if (k === undefined) k = ikMap[t] = ++ikUid;
    Object.defineProperty(ps, '_ik', { value: k, enumerable: false });
    return k;
  }
  function presentationalHints(el, out) {
    if (el.namespaceURI === SVG_NS) {
      var pres = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'display', 'visibility', 'transform', 'fill-rule', 'stroke-linecap', 'stroke-linejoin', 'stop-color', 'stop-opacity'];
      for (var i = 0; i < pres.length; i++) { var v = el.getAttribute(pres[i]); if (v !== null && out[pres[i]] === undefined) out[pres[i]] = v; }
      if (el.localName === 'svg') {
        var w = el.getAttribute('width'), h = el.getAttribute('height');
        if (w !== null && out.width === undefined) out.width = /^[\d.]+$/.test(w) ? w + 'px' : w;
        if (h !== null && out.height === undefined) out.height = /^[\d.]+$/.test(h) ? h + 'px' : h;
      }
      return;
    }
    // (an attribute gives way to an author rule or the style attribute only)
    var au = out._auth || {};
    function free(n) { return !au[n]; }
    function setFree(n, v) { if (free(n)) out[n] = v; }
    var l = el.localName;
    // (a canvas's width and height are its bitmap's, not presentational)
    if (l === 'img' || l === 'video' || l === 'iframe' || l === 'td' || l === 'th' || l === 'table') {
      var aw = el.getAttribute('width'), ah = el.getAttribute('height');
      if (aw !== null && free('width')) out.width = /^[\d.]+$/.test(aw) ? aw + 'px' : aw;
      if (ah !== null && free('height')) out.height = /^[\d.]+$/.test(ah) ? ah + 'px' : ah;
    }
    var al = el.getAttribute('align');
    if (al && free('text-align') && /^(div|p|h[1-6]|td|th|tr)$/.test(l)) out['text-align'] = al;
    var bg = el.getAttribute('bgcolor');
    if (bg && free('background-color')) out['background-color'] = bg;
    var va = el.getAttribute('valign');
    if (va && /^(td|th|tr|tbody|thead|tfoot)$/.test(l) && free('vertical-align')) out['vertical-align'] = va.toLowerCase();
    if (l === 'table') {
      var csp = el.getAttribute('cellspacing');
      if (csp !== null && /^\s*\d/.test(csp)) setFree('border-spacing', parseInt(csp, 10) + 'px');
      var tb = el.getAttribute('border');
      if (tb !== null) {
        var tbw = tb === '' ? 1 : parseInt(tb, 10);
        if (!(tbw >= 0)) tbw = 1;
        ['top', 'right', 'bottom', 'left'].forEach(function (sd) {
          setFree('border-' + sd + '-width', tbw + 'px');
          setFree('border-' + sd + '-style', 'outset');
          setFree('border-' + sd + '-color', 'gray');
        });
      }
    }
    if (l === 'td' || l === 'th') {
      var tbl = el.parentNode;
      while (tbl && tbl.nodeType === 1 && tbl.localName !== 'table') tbl = tbl.parentNode;
      if (tbl && tbl.nodeType === 1) {
        var cp = tbl.getAttribute('cellpadding');
        if (cp !== null && /^\s*\d/.test(cp)) ['top', 'right', 'bottom', 'left'].forEach(function (sd) { setFree('padding-' + sd, parseInt(cp, 10) + 'px'); });
        var cb = tbl.getAttribute('border');
        if (cb !== null && !(parseInt(cb, 10) === 0)) ['top', 'right', 'bottom', 'left'].forEach(function (sd) {
          setFree('border-' + sd + '-width', '1px');
          setFree('border-' + sd + '-style', 'inset');
          setFree('border-' + sd + '-color', 'gray');
        });
      }
    }
    // <br clear>: all and both clear both sides
    if (l === 'br' && out.clear === undefined) {
      var cl = (el.getAttribute('clear') || '').toLowerCase();
      if (cl === 'all' || cl === 'both') out.clear = 'both';
      else if (cl === 'left' || cl === 'right') out.clear = cl;
    }
  }

  // computed styles: cached per element until a style can change
  // (styleGen; an attribute drops only the elements it reaches, attrChanged)
  var computedCache = { gen: 0, map: {} };
  // ---- CSS animations (CSS Animations 1) -----------------------------------

  // An element's animation-name list starts its animations when it first
  // gets them (each keeps its start time on the element); each frame while
  // one runs, the element is styled again with its keyframes' values for
  // the time: the computed styles of the two keyframes around it,
  // interpolated (numbers in like values, colours, transform lists; other
  // values flip at the half), after the timing function. A finished
  // animation leaves its last keyframe with fill-mode forwards / both.
  // animationstart, animationiteration and animationend are dispatched.
  var keyframesCache = { gen: -1, map: {} };
  function keyframesNamed(name) {
    if (keyframesCache.gen !== sheetGen) {
      var map = {};
      var walk = function (rules) {
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          if (r.type === 7 && r.name) map[String(r.name).trim()] = r;
          else if (r.cssRules && r.cssRules.length) walk(r.cssRules);
        }
      };
      if (doc) { var sheets = cascadeSheets(doc); for (var si = 0; si < sheets.length; si++) walk(sheets[si].cssRules || sheets[si]._rules || []); }
      keyframesCache = { gen: sheetGen, map: map, parsed: {} };
    }
    if (keyframesCache.parsed[name] !== undefined) return keyframesCache.parsed[name];
    var rule = keyframesCache.map[name], out = null;
    if (rule) {
      var text = String(rule.cssText || rule.text || ''), body = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}'));
      var frames = [], i = 0;
      while (i < body.length) {
        var o = body.indexOf('{', i);
        if (o < 0) break;
        var c = body.indexOf('}', o);
        if (c < 0) break;
        var sels = body.slice(i, o).split(','), decls = {}, timing = null;
        parseDeclarations(body.slice(o + 1, c)).forEach(function (d) {
          if (d.important) return;
          if (d.name === 'animation-timing-function') { timing = d.value; return; }
          var lh = expandShorthand(d.name, d.value);
          if (lh) { for (var k in lh) if (lh[k] !== undefined) decls[k] = lh[k]; } else decls[d.name] = d.value;
        });
        sels.forEach(function (sl) {
          sl = sl.trim().toLowerCase();
          var off = sl === 'from' ? 0 : sl === 'to' ? 1 : /^[\d.]+%$/.test(sl) ? parseFloat(sl) / 100 : NaN;
          if (!isNaN(off)) frames.push({ off: off, decls: decls, timing: timing });
        });
        i = c + 1;
      }
      frames.sort(function (a, b) { return a.off - b.off; });
      if (frames.length) out = frames;
    }
    keyframesCache.parsed[name] = out;
    return out;
  }
  function splitTop(v, sep) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < v.length; i++) {
      var ch = v.charAt(i);
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (depth === 0 && ch === sep) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim() || out.length) out.push(cur.trim());
    return out;
  }
  function timeMs(t) { t = String(t || '').trim(); var n = parseFloat(t); return isNaN(n) ? 0 : /ms$/i.test(t) ? n : n * 1000; }
  var EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|(cubic-bezier|steps|linear)\(.*\))$/i;
  // the animations a computed style asks for: from the animation shorthand
  // (each comma part's tokens by kind, CSS Animations 1 3.10) and then the
  // longhands set after it
  function animationList(c) {
    var names = [], list = [];
    var sh = c.animation && c.animation !== 'none' ? splitTop(String(c.animation), ',') : [];
    sh.forEach(function (part) {
      var a = { name: 'none', duration: 0, delay: 0, timing: 'ease', count: 1, direction: 'normal', fill: 'none', play: 'running' }, times = 0;
      splitValue(part).forEach(function (tk) {
        var lo = tk.toLowerCase();
        if (/^-?[\d.]+m?s$/.test(lo)) { if (times++ === 0) a.duration = timeMs(lo); else a.delay = timeMs(lo); }
        else if (EASING.test(lo)) a.timing = lo;
        else if (lo === 'infinite') a.count = Infinity;
        else if (/^[\d.]+$/.test(lo)) a.count = parseFloat(lo);
        else if (/^(normal|reverse|alternate|alternate-reverse)$/.test(lo) && a.direction === 'normal') a.direction = lo;
        else if (/^(none|forwards|backwards|both)$/.test(lo) && a.fill === 'none' && lo !== 'none') a.fill = lo;
        else if (/^(running|paused)$/.test(lo)) a.play = lo;
        else a.name = tk.replace(/^["']|["']$/g, '');
      });
      list.push(a);
    });
    var ln = c['animation-name'];
    if (ln && ln !== 'none') {
      names = splitTop(String(ln), ',');
      var get = function (k, i, d) { var v = c[k]; if (!v) return d; var p = splitTop(String(v), ','); return p[i % p.length]; };
      list = names.map(function (nm, i) {
        var base = list[i] || {};
        var cnt = get('animation-iteration-count', i, null);
        return {
          name: nm.replace(/^["']|["']$/g, ''),
          duration: c['animation-duration'] ? timeMs(get('animation-duration', i, '0s')) : base.duration || 0,
          delay: c['animation-delay'] ? timeMs(get('animation-delay', i, '0s')) : base.delay || 0,
          timing: c['animation-timing-function'] ? get('animation-timing-function', i, 'ease') : base.timing || 'ease',
          count: cnt === null ? (base.count === undefined ? 1 : base.count) : cnt === 'infinite' ? Infinity : parseFloat(cnt),
          direction: c['animation-direction'] ? get('animation-direction', i, 'normal') : base.direction || 'normal',
          fill: c['animation-fill-mode'] ? get('animation-fill-mode', i, 'none') : base.fill || 'none',
          play: c['animation-play-state'] ? get('animation-play-state', i, 'running') : base.play || 'running'
        };
      });
    }
    return list.filter(function (a) { return a.name && a.name !== 'none'; });
  }
  function bezier(x1, y1, x2, y2) {
    return function (x) {
      if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1;
      var lo = 0, hi = 1, t = x;
      for (var i = 0; i < 40; i++) {
        var cx = 3 * x1 * t * (1 - t) * (1 - t) + 3 * x2 * t * t * (1 - t) + t * t * t;
        if (Math.abs(cx - x) < 1e-6) break;
        if (cx < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return 3 * y1 * t * (1 - t) * (1 - t) + 3 * y2 * t * t * (1 - t) + t * t * t;
    };
  }
  function easingFn(t) {
    t = String(t || 'ease').trim().toLowerCase();
    var m;
    if (t === 'linear') return function (x) { return x; };
    if (t === 'ease') return bezier(0.25, 0.1, 0.25, 1);
    if (t === 'ease-in') return bezier(0.42, 0, 1, 1);
    if (t === 'ease-out') return bezier(0, 0, 0.58, 1);
    if (t === 'ease-in-out') return bezier(0.42, 0, 0.58, 1);
    if ((m = /^cubic-bezier\(([^)]*)\)$/.exec(t))) { var b = m[1].split(',').map(parseFloat); return bezier(b[0], b[1], b[2], b[3]); }
    if (t === 'step-start') t = 'steps(1, jump-start)';
    if (t === 'step-end') t = 'steps(1, jump-end)';
    if ((m = /^steps\(\s*(\d+)\s*(?:,\s*([\w-]+))?\s*\)$/.exec(t))) {
      var n = parseInt(m[1], 10), pos = m[2] || 'end';
      return function (x) {
        var jumps = pos === 'jump-none' ? n - 1 : pos === 'jump-both' ? n + 1 : n;
        var k = Math.floor(x * n) + (pos === 'start' || pos === 'jump-start' || pos === 'jump-both' ? 1 : 0);
        if (x >= 1) k = pos === 'jump-none' ? n - 1 : n;
        return Math.min(1, Math.max(0, k / Math.max(1, jumps)));
      };
    }
    return function (x) { return x; };
  }
  var NUM_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
  function rgbaForm(v) { return v.replace(/rgb\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+)\)/g, 'rgba($1, $2, $3, 1)'); }
  var IDENTITY = { scale: 1, scalex: 1, scaley: 1, scalez: 1, scale3d: 1 };
  // a transform list for none: the other list's functions at their identity
  function identityOf(v) {
    return v.replace(/([a-zA-Z0-9]+)\(([^)]*)\)/g, function (all, fn, args) {
      var one = IDENTITY[fn.toLowerCase()] ? '1' : '0';
      return fn + '(' + args.split(',').map(function (a) { var u = (a.trim().match(/[a-z%]+$/i) || [''])[0]; return (one === '1' ? '1' : '0' + (fn.toLowerCase() === 'matrix' ? '' : u)); }).join(', ') + ')';
    }).replace(/matrix\(0, 0, 0, 0, 0, 0\)/g, 'matrix(1, 0, 0, 1, 0, 0)');
  }
  function interpolateValue(prop, a, b, t) {
    if (a === b || a === undefined || b === undefined) return t < 0.5 ? a : b;
    a = String(a); b = String(b);
    // (one form for both: `translate(0,-50px)` as written, `translate(0, 0px)`)
    if (a.indexOf(',') >= 0 || b.indexOf(',') >= 0) { a = a.replace(/\s*,\s*/g, ', '); b = b.replace(/\s*,\s*/g, ', '); }
    if (prop === 'transform' || prop === 'translate' || prop === 'rotate' || prop === 'scale') {
      if (a === 'none') a = identityOf(b);
      else if (b === 'none') b = identityOf(a);
    }
    // colours apart: each rgb()/rgba() a placeholder, its channels
    var colA = [], colB = [];
    var take = function (list) { return function (m, x) { var c = x.split(',').map(parseFloat); if (c.length === 3) c.push(1); list.push(c); return '\u0001'; }; };
    var ra = rgbaForm(a).replace(/rgba\(([^)]*)\)/g, take(colA)), rb = rgbaForm(b).replace(/rgba\(([^)]*)\)/g, take(colB));
    var sa = ra.replace(NUM_RE, '#'), sb = rb.replace(NUM_RE, '#');
    if (sa !== sb || colA.length !== colB.length) return t < 0.5 ? a : b;
    var na = ra.match(NUM_RE) || [], nb = rb.match(NUM_RE) || [], k = 0, ci = 0;
    var out = sa.replace(/#/g, function () { var x = parseFloat(na[k]), y = parseFloat(nb[k++]); return String(+(x + (y - x) * t).toFixed(4)); });
    return out.replace(/\u0001/g, function () {
      // (premultiplied, CSS Color 4 12.3: transparent to red stays red
      // as it fades in, not a dark red)
      var x = colA[ci], y = colB[ci++];
      var alr = Math.max(0, Math.min(1, x[3] + (y[3] - x[3]) * t)), al = +alr.toFixed(4);
      var ch = [0, 1, 2].map(function (q) { var v = alr > 0 ? (x[q] * x[3] + (y[q] * y[3] - x[q] * x[3]) * t) / alr : x[q] + (y[q] - x[q]) * t; return Math.round(Math.max(0, Math.min(255, v))); });
      return al === 1 ? 'rgb(' + ch.join(', ') + ')' : 'rgba(' + ch.join(', ') + ', ' + al + ')';
    });
  }
  // CSS animations' clock: the host's timer clock (prelude.js __clock)
  // where there is one, so a page's timers and its CSS animations see the
  // same time however fast the host moves its clock. Web Animations keep
  // the wall clock: pages set their start times from performance.now and
  // frame timestamps
  function animNow() { return typeof __clock === 'number' ? __clock : now(); }
  // a timer of webapi.js's own that reads nothing of the page's (an
  // animation's end): the host's tick runs no frames to catch up to it
  // (prelude.js __tick)
  function quietTimeout(fn, ms) {
    var id = setTimeout(fn, ms);
    if (typeof __timers !== 'undefined' && __timers.length && __timers[__timers.length - 1].id === id) __timers[__timers.length - 1].quiet = true;
    return id;
  }
  var animating = [], animTick = false;
  function scheduleAnimationFrame(el) {
    if (animating.indexOf(el) < 0) animating.push(el);
    if (animTick) return;
    animTick = true;
    // (an animation frame is the page's frame, with its requestAnimationFrame
    // callbacks: one a tick, so the host draws between two of them; on 16 ms
    // timers a host whose tick was long ran a whole animation inside one
    // tick and drew only its end)
    requestAnimationFrame(function animFrame() {
      animTick = false;
      var list = animating;
      animating = [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e.isConnected) continue;
        generation++;
        textStamp++;
        for (var p = e; p; p = p.parentNode) p._rv = textStamp;
        if (computedCache.gen === styleGen) animRestyle(e);
      }
    });
  }
  function animEvent(el, type, a, elapsed) {
    setTimeout(function () {
      var ev = new AnimationEvent(type, { bubbles: true });
      ev.animationName = a.name; ev.elapsedTime = elapsed / 1000; ev.pseudoElement = '';
      dispatch(el, ev);
    }, 0);
  }
  // c: el's computed style without animations; gives it its animations'
  // values now
  function applyAnimations(el, c, parent) {
    var list = animationList(c), st = el._anims || (el._anims = {}), keep = {}, t = animNow(), again = false;
    for (var i = 0; i < list.length; i++) {
      var a = list[i], frames = keyframesNamed(a.name);
      if (!frames) continue;
      var key = a.name + '|' + i;
      keep[key] = true;
      var s = st[key];
      if (!s) s = st[key] = { start: t, iter: 0, done: false, started: false };
      if (a.play === 'paused') { if (s.pausedAt === undefined) s.pausedAt = t; } else if (s.pausedAt !== undefined) { s.start += t - s.pausedAt; s.pausedAt = undefined; }
      var elapsed = (s.pausedAt !== undefined ? s.pausedAt : t) - s.start - a.delay;
      var dur = Math.max(0, a.duration), total = dur * a.count;
      var progress, iter;
      // (animationstart once its delay is over, CSS Animations 1 4.2)
      if (elapsed >= 0 && !s.started) { s.started = true; animEvent(el, 'animationstart', a, 0); }
      if (elapsed < 0) {
        if (a.fill !== 'backwards' && a.fill !== 'both') { again = true; continue; }
        progress = 0; iter = 0;
      } else if (elapsed >= total || dur === 0) {
        if (!s.done) { s.done = true; animEvent(el, 'animationend', a, total); }
        if (a.fill !== 'forwards' && a.fill !== 'both') continue;
        iter = a.count === Infinity ? 0 : Math.max(0, Math.ceil(a.count) - 1);
        progress = a.count % 1 && dur ? a.count % 1 : 1;
      } else {
        iter = Math.floor(elapsed / dur);
        progress = (elapsed - iter * dur) / dur;
        if (iter > s.iter) { s.iter = iter; animEvent(el, 'animationiteration', a, iter * dur); }
        again = true;
      }
      var rev = a.direction === 'reverse' || (a.direction === 'alternate' && iter % 2 === 1) || (a.direction === 'alternate-reverse' && iter % 2 === 0);
      if (rev) progress = 1 - progress;
      // (0% and 100% the style itself when the rule does not name them)
      applyFrames(el, c, parent, frames, progress, a.timing);
    }
    for (var sk in st) if (!keep[sk]) delete st[sk];
    if (again) scheduleAnimationFrame(el);
  }
  // ---- CSS transitions (CSS Transitions 1) ---------------------------------

  // the transitions a style asks for: [{prop, dur, delay, timing}] from the
  // transition shorthand or its longhands, the list's lengths repeated as
  // the property list's (3.)
  function transitionList(c) {
    var out = [];
    var tp = c['transition-property'], td = c['transition-duration'];
    if (c.transition && c.transition !== 'none' && !(tp && td)) {
      splitTop(String(c.transition), ',').forEach(function (part) {
        var t = { prop: 'all', dur: 0, delay: 0, timing: 'ease' }, times = 0;
        splitValue(part).forEach(function (tk) {
          var lo = tk.toLowerCase();
          if (/^-?[\d.]+m?s$/.test(lo)) { if (times++ === 0) t.dur = timeMs(lo); else t.delay = timeMs(lo); }
          else if (EASING.test(lo)) t.timing = lo;
          else if (lo !== 'normal' && lo !== 'allow-discrete') t.prop = lo;
        });
        out.push(t);
      });
      return out;
    }
    if (!td || !/[1-9]/.test(String(td))) return out;
    var props = splitTop(String(tp || 'all'), ',');
    var get = function (k, i, d) { var v = c[k]; if (!v) return d; var q = splitTop(String(v), ','); return q[i % q.length]; };
    for (var i = 0; i < props.length; i++) out.push({ prop: props[i].trim().toLowerCase(), dur: timeMs(get('transition-duration', i, '0s')), delay: timeMs(get('transition-delay', i, '0s')), timing: get('transition-timing-function', i, 'ease').trim() });
    return out;
  }
  // el's style went from its last one (_trBase) to c (without animations):
  // each property its transitions name that changed starts one, from the
  // value it shows now; a running one whose end changed starts again from
  // where it is. Not for an element that was not rendered (display none,
  // just made): it has no style to go from.
  function startTransitions(el, c) {
    var prev = el._trBase, shown = el._trOut;
    el._trBase = c;
    if (!prev || prev === c) return;
    if (c.display === 'none' || prev.display === 'none' || !el.isConnected) { el._tr = null; return; }
    var run = el._tr, list = transitionList(c);
    if (!list.length && !run) return;
    var spec = {}, all = null;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.prop === 'none') continue;
      if (t.prop === 'all') { all = t; continue; }
      var parts = shorthandParts(t.prop) || [t.prop];
      for (var j = 0; j < parts.length; j++) spec[parts[j]] = t;
    }
    var names = {};
    for (var sn in spec) names[sn] = 1;
    if (all) { for (var k in c) if (k.charAt(0) !== '_' && k.slice(0, 2) !== '--') names[k] = 1; for (var k2 in prev) if (k2.charAt(0) !== '_' && k2.slice(0, 2) !== '--') names[k2] = 1; }
    if (run) for (var rk in run) names[rk] = 1;
    var now0 = animNow();
    for (var n in names) {
      // (a property a style leaves out has its initial value)
      var nv = c[n] !== undefined ? c[n] : INITIAL[n], pv = prev[n] !== undefined ? prev[n] : INITIAL[n], r = run && run[n], sp = spec[n] || all;
      if (r) {
        if (r.to === nv) continue;
        if (!sp || sp.dur <= 0 || nv === undefined) { delete run[n]; continue; }
        var cur = shown && shown[n] !== undefined ? shown[n] : INITIAL[n] !== undefined ? INITIAL[n] : r.to;
        run[n] = { from: cur, to: nv, start: now0, dur: sp.dur, delay: sp.delay, timing: sp.timing };
        continue;
      }
      if (!sp || sp.dur <= 0 || pv === nv || pv === undefined || nv === undefined) continue;
      // (only what interpolates: a discrete value changes at once)
      if (n !== 'visibility' && interpolateValue(n, pv, nv, 0.5) === nv) continue;
      if (!run) run = el._tr = {};
      run[n] = { from: shown && shown[n] !== undefined ? shown[n] : pv, to: nv, start: now0, dur: sp.dur, delay: sp.delay, timing: sp.timing };
    }
  }
  function transitionLonghands(out, spec) {
    var v = String(out.transition || '');
    var sec = function (ms) { return +(ms / 1000).toFixed(4) + 's'; };
    var parts = v && v !== 'none' ? splitTop(v, ',') : ['all 0s ease 0s'];
    var pr = [], du = [], de = [], ti = [];
    parts.forEach(function (part) {
      var p = 'all', d = 0, dl = 0, tf = 'ease', times = 0;
      splitValue(part).forEach(function (tk) {
        var lo = tk.toLowerCase();
        if (/^-?[\d.]+m?s$/.test(lo)) { if (times++ === 0) d = timeMs(lo); else dl = timeMs(lo); }
        else if (EASING.test(lo)) tf = lo;
        else if (lo !== 'normal' && lo !== 'allow-discrete') p = lo;
      });
      pr.push(p); du.push(sec(d)); de.push(sec(dl)); ti.push(tf);
    });
    if (spec['transition-property'] === undefined) out['transition-property'] = pr.join(', ');
    if (spec['transition-duration'] === undefined) out['transition-duration'] = du.join(', ');
    if (spec['transition-delay'] === undefined) out['transition-delay'] = de.join(', ');
    if (spec['transition-timing-function'] === undefined) out['transition-timing-function'] = ti.join(', ');
  }
  function hasTransitions(el) { if (!el._tr) return false; for (var k in el._tr) return true; el._tr = null; return false; }
  // the running transitions onto c; transitionend for each that ended
  function applyTransitions(el, c) {
    var tr = el._tr, t = animNow(), again = false;
    for (var p in tr) {
      var r = tr[p], e = t - r.start - r.delay;
      if (e >= r.dur) { delete tr[p]; transitionEnd(el, p, r.dur); continue; }
      again = true;
      if (frameKeys) frameKeys[p] = 1;
      if (e < 0) { c[p] = r.from; continue; }
      // (visibility: visible while either end is, CSS Transitions 1, 6.2)
      c[p] = p === 'visibility' ? (r.from === 'visible' || r.to === 'visible' ? 'visible' : r.to) : interpolateValue(p, r.from, r.to, easingFn(r.timing)(e / r.dur));
    }
    if (again) scheduleAnimationFrame(el);
    else el._tr = null;
  }
  function transitionEnd(el, prop, dur) {
    setTimeout(function () {
      var ev = new TransitionEvent('transitionend', { bubbles: true, cancelable: false });
      ev.propertyName = prop; ev.elapsedTime = dur / 1000; ev.pseudoElement = '';
      dispatch(el, ev);
    }, 0);
  }
  // ---- Web Animations (Element.animate) ------------------------------------

  // keyframes as an array of {prop: value, offset?, easing?} or an object
  // of {prop: [values]} (Web Animations 1 5.3.3), properties camelCase or
  // kebab-case; offsets spaced evenly where none is given
  function waapiFrames(kf) {
    var list = [];
    if (Array.isArray(kf)) list = kf.map(function (f) { return Object.assign({}, f); });
    else if (kf && typeof kf === 'object') {
      var n = 0, keys = Object.keys(kf).filter(function (k) { return k !== 'offset' && k !== 'easing' && k !== 'composite'; });
      keys.forEach(function (k) { var v = kf[k]; n = Math.max(n, Array.isArray(v) ? v.length : 1); });
      for (var i = 0; i < n; i++) list.push({});
      keys.forEach(function (k) {
        var v = Array.isArray(kf[k]) ? kf[k] : [kf[k]];
        if (v.length === 1) { list[n - 1][k] = v[0]; return; }
        v.forEach(function (x, j) { list[Math.round(j * (n - 1) / (v.length - 1))][k] = x; });
      });
      if (Array.isArray(kf.offset)) kf.offset.forEach(function (o, j) { if (list[j]) list[j].offset = o; });
      if (kf.easing !== undefined) list.forEach(function (f, j) { f.easing = Array.isArray(kf.easing) ? kf.easing[j % kf.easing.length] : kf.easing; });
    }
    var m = list.length;
    var frames = list.map(function (f, j) {
      var decls = {};
      for (var k in f) {
        if (k === 'offset' || k === 'easing' || k === 'composite' || f[k] === null || f[k] === undefined) continue;
        var name = k === 'cssFloat' ? 'float' : k === 'cssOffset' ? 'offset' : k.slice(0, 2) === '--' ? k : kebab(k);
        var val = String(f[k]), lh = expandShorthand(name, val);
        if (lh) { for (var q in lh) if (lh[q] !== undefined) decls[q] = lh[q]; } else decls[name] = val;
      }
      return { off: typeof f.offset === 'number' ? f.offset : NaN, given: typeof f.offset === 'number' ? f.offset : null, decls: decls, timing: f.easing || null, idx: j };
    });
    if (m === 1) { frames[0].off = 1; return frames; }
    // (missing offsets: evenly between their neighbours, 5.3.3 step 4)
    if (m && isNaN(frames[0].off)) frames[0].off = 0;
    if (m && isNaN(frames[m - 1].off)) frames[m - 1].off = 1;
    for (var a = 0; a < m;) {
      var b = a + 1;
      while (b < m && isNaN(frames[b].off)) b++;
      for (var c = a + 1; c < b; c++) frames[c].off = frames[a].off + (frames[b].off - frames[a].off) * (c - a) / (b - a);
      a = b;
    }
    return frames;
  }
  function timingOf(o) {
    if (typeof o === 'number') o = { duration: o };
    o = o || {};
    var d = o.duration === 'auto' || o.duration === undefined ? 0 : +o.duration || 0;
    return { delay: +o.delay || 0, endDelay: +o.endDelay || 0, duration: d, iterations: o.iterations === undefined ? 1 : +o.iterations, direction: o.direction || 'normal', fill: o.fill || 'auto', easing: o.easing || 'linear', iterationStart: +o.iterationStart || 0 };
  }
  class AnimationEffect {
    getTiming() { return Object.assign({}, this._timing); }
    updateTiming(t) { Object.assign(this._timing, timingOf(Object.assign(this.getTiming(), t || {}))); if (this._anim) this._anim._touch(); }
    getComputedTiming() {
      var t = this._timing, active = t.duration * t.iterations, a = this._anim, local = a ? a.currentTime : null;
      var r = { delay: t.delay, endDelay: t.endDelay, fill: t.fill === 'auto' ? 'none' : t.fill, iterationStart: t.iterationStart, iterations: t.iterations, duration: t.duration, direction: t.direction, easing: t.easing, activeDuration: active, endTime: Math.max(0, t.delay + active + t.endDelay), localTime: local, progress: null, currentIteration: null };
      var p = this._progress();
      if (p) { r.progress = p.progress; r.currentIteration = p.iter; }
      return r;
    }
    // where the effect is: {progress, iter} or null when it shows nothing
    _progress() {
      var a = this._anim;
      if (!a || a.currentTime === null) return null;
      var t = this._timing, fill = t.fill === 'auto' ? 'none' : t.fill, el = a.currentTime - t.delay, active = t.duration * t.iterations;
      var p, iter;
      if (el < 0) { if (fill !== 'backwards' && fill !== 'both') return null; p = 0; iter = 0; }
      else if (el >= active) {
        if (fill !== 'forwards' && fill !== 'both') return null;
        iter = t.iterations === Infinity ? 0 : Math.max(0, Math.ceil(t.iterations) - 1);
        p = t.iterations % 1 && t.duration ? t.iterations % 1 : 1;
      } else { iter = t.duration ? Math.floor(el / t.duration) : 0; p = t.duration ? (el - iter * t.duration) / t.duration : 1; }
      var rev = t.direction === 'reverse' || (t.direction === 'alternate' && iter % 2 === 1) || (t.direction === 'alternate-reverse' && iter % 2 === 0);
      if (rev) p = 1 - p;
      return { progress: easingFn(t.easing)(p), iter: iter };
    }
  }
  class KeyframeEffect extends AnimationEffect {
    constructor(target, keyframes, options) {
      super();
      this.target = target || null;
      this._timing = timingOf(options);
      this._frames = waapiFrames(keyframes);
      this._raw = keyframes;
      this.composite = (options && options.composite) || 'replace';
      this.pseudoElement = (options && options.pseudoElement) || null;
      this._anim = null;
    }
    getKeyframes() { return this._frames.map(function (f) { var o = { offset: f.given === undefined ? null : f.given, computedOffset: f.off, easing: f.timing || 'linear', composite: 'auto' }; for (var k in f.decls) o[camel(k)] = f.decls[k]; return o; }); }
    setKeyframes(k) { this._frames = waapiFrames(k); if (this._anim) this._anim._touch(); }
  }
  var animationIds = 0;
  class Animation extends EventTarget {
    constructor(effect, timeline) {
      super();
      this.id = '';
      this._effect = null;
      this._start = null; this._hold = null; this._rate = 1; this._state = 'idle'; this._seq = ++animationIds;
      this.onfinish = null; this.oncancel = null; this.onremove = null;
      this.timeline = timeline || documentTimeline;
      this.replaceState = 'active';
      this._newFinished();
      this.ready = Promise.resolve(this);
      this.effect = effect || null;
    }
    get effect() { return this._effect; }
    set effect(e) { if (this._effect) this._effect._anim = null; this._effect = e; if (e) e._anim = this; this._touch(); }
    _newFinished() { var self = this; this.finished = new Promise(function (ok, no) { self._ok = ok; self._no = no; }); this.finished.catch(function () {}); }
    get playbackRate() { return this._rate; }
    set playbackRate(r) { var ct = this.currentTime; this._rate = +r; if (ct !== null) this.currentTime = ct; }
    updatePlaybackRate(r) { this.playbackRate = r; }
    get currentTime() {
      if (this._hold !== null) return this._hold;
      if (this._start === null) return null;
      return (now() - this._start) * this._rate;
    }
    set currentTime(t) {
      if (t === null) return;
      if (this._state === 'running') this._start = now() - t / (this._rate || 1); else this._hold = +t;
      this._touch();
    }
    get startTime() { return this._start; }
    // (setting a start time plays the animation, Web Animations 1 4.4.6)
    set startTime(t) {
      this._start = t === null ? null : +t; this._hold = null;
      if (t !== null) { if (this._done) { this._done = false; this._newFinished(); } this._state = 'running'; this._track(); this._timer(); }
      this._touch();
    }
    get pending() { return false; }
    _end() { var e = this._effect; if (!e) return 0; var t = e._timing; return Math.max(0, t.delay + t.duration * t.iterations + t.endDelay); }
    get playState() {
      if (this._state === 'idle') return 'idle';
      if (this._state === 'paused') return 'paused';
      var ct = this.currentTime;
      if (ct !== null && ((this._rate > 0 && ct >= this._end()) || (this._rate < 0 && ct <= 0))) return 'finished';
      return 'running';
    }
    play() {
      var ct = this.currentTime, end = this._end();
      if (this._rate > 0 && (ct === null || ct < 0 || ct >= end)) ct = 0;
      else if (this._rate < 0 && (ct === null || ct <= 0 || ct > end)) ct = end;
      if (this._state === 'finished' || this._done) { this._done = false; this._newFinished(); }
      this._state = 'running'; this._hold = null;
      this._start = now() - ct / (this._rate || 1);
      this._track();
      this._touch();
      this._timer();
    }
    // (finish comes on time even when nothing styles the target)
    _timer() {
      var self = this, ct = this.currentTime, left = this._rate > 0 ? this._end() - ct : ct;
      if (ct === null) return;
      if (isFinite(left) && this._rate) quietTimeout(function () { if (self._state === 'running') self._check(); }, Math.max(0, left / Math.abs(this._rate)) + 1);
    }
    pause() { var ct = this.currentTime; this._hold = ct === null ? 0 : ct; this._state = 'paused'; this._start = null; this._touch(); }
    finish() {
      if (!this._rate || (this._rate > 0 && this._end() === Infinity)) throw DOMException('Animation is infinite', 'InvalidStateError');
      var t = this._rate > 0 ? this._end() : 0;
      this._state = 'running'; this._hold = null; this._start = now() - t / this._rate;
      this._touch(); this._check();
    }
    cancel() {
      if (this._state === 'idle') return;
      this._state = 'idle'; this._start = null; this._hold = null; this._untrack();
      if (!this._done) { this._no(DOMException('The user aborted a request.', 'AbortError')); }
      this._done = false;
      this._newFinished();
      var ev = new Event('cancel'); ev.currentTime = null; ev.timelineTime = now();
      var self = this;
      setTimeout(function () { fireAnimationEvent(self, ev); }, 0);
      this._touch();
    }
    reverse() { this._rate = -this._rate; this.play(); }
    persist() { this.replaceState = 'persisted'; }
    commitStyles() {
      var e = this._effect, el = e && e.target, p = e && e._progress();
      if (!el || !p) return;
      var cs = computedOf(el);
      for (var k in waapiProps(e)) if (cs[k] !== undefined) el.style.setProperty(k, cs[k]);
    }
    _track() { var el = this._effect && this._effect.target; if (!el) return; var l = el._waapi || (el._waapi = []); if (l.indexOf(this) < 0) l.push(this); }
    _untrack() { var el = this._effect && this._effect.target; if (el && el._waapi) { var i = el._waapi.indexOf(this); if (i >= 0) el._waapi.splice(i, 1); } }
    // the target styled again now (and each frame while it runs)
    _touch() {
      var el = this._effect && this._effect.target;
      if (!el || !el.isConnected) return;
      generation++; textStamp++;
      for (var p = el; p; p = p.parentNode) p._rv = textStamp;
      if (computedCache.gen === styleGen) animRestyle(el);
    }
    _check() {
      if (this._done || this.playState !== 'finished') return;
      this._done = true;
      var self = this, ev = new Event('finish');
      ev.currentTime = this.currentTime; ev.timelineTime = now();
      // (an effect that fills nothing leaves the target)
      var e = this._effect;
      if (e && (e._timing.fill === 'auto' || e._timing.fill === 'none' || e._timing.fill === 'backwards')) this._untrack();
      this._touch();
      // (the promise first, the event in a task after it, 4.4.15)
      Promise.resolve().then(function () { self._ok(self); });
      setTimeout(function () { fireAnimationEvent(self, ev); }, 0);
    }
  }
  // (dispatchEvent also calls the animation's onfinish / oncancel)
  function fireAnimationEvent(a, ev) {
    try { a.dispatchEvent(ev); } catch (e) { reportError(e); }
  }
  function animationRelevant(a) {
    var st = a.playState;
    if (st === 'running' || st === 'paused') return true;
    var f = a._effect && a._effect._timing.fill;
    return st === 'finished' && (f === 'forwards' || f === 'both');
  }
  function waapiProps(e) { var props = {}; e._frames.forEach(function (f) { for (var k in f.decls) props[k] = true; }); return props; }
  var documentTimeline = { get currentTime() { return now(); }, duration: null, phase: 'active' };
  // el's Element.animate effects over its computed style c, in the order
  // they were made; running ones keep frames coming
  // (the element whose style applyWaapi makes: an animation ending there
  // asks for it again, animRestyle, which it is being made now)
  var waapiEl = null;
  function applyWaapi(el, c, parent) {
    var was = waapiEl;
    waapiEl = el;
    try { applyWaapi1(el, c, parent); } finally { waapiEl = was; }
  }
  function applyWaapi1(el, c, parent) {
    var list = el._waapi.slice(), again = false;
    for (var i = 0; i < list.length; i++) {
      var a = list[i], e = a._effect;
      if (!e) continue;
      if (a.playState === 'running') again = true;
      a._check();
      var p = e._progress();
      if (!p) continue;
      applyFrames(el, c, parent, e._frames, p.progress, null);
    }
    if (again) scheduleAnimationFrame(el);
  }
  // a keyframe's computed style for el: the same from frame to frame while
  // el's style without animations (el._ab) and its parent's are the same
  function frameStyle(el, parent, fr) {
    var ab = el._ab, k = fr._cs;
    if (k && ab && k.ab === ab && k.el === el && ab.gen === styleGen && ab.parent === parent) return k.cs;
    var cs = ab && fr.decls ? frameValues(ab.base, parent, fr.decls) : null;
    if (!cs) cs = computeStyle(el, parent, undefined, fr.decls);
    if (fr.decls && ab) fr._cs = { ab: ab, el: el, cs: cs };
    return cs;
  }
  // a keyframe's own properties computed over el's style without
  // animations (only what applyFrames reads), when each is a plain value of
  // a longhand: no var(), percentage, keyword or font size (null otherwise,
  // the whole style is computed then). A spring's keyframes are many, each
  // met once: a whole style for each was 0.4 ms an element a frame.
  function frameValues(base, parent, decls) {
    var out = null, ctx = null;
    for (var n in decls) {
      var v = decls[n];
      if (typeof v !== 'string' || base[n] === undefined || n === 'font-size' || n === 'font' || n.slice(0, 2) === '--' || v.indexOf('var(') >= 0 || v.indexOf('%') >= 0 || /^\s*(inherit|initial|unset|revert|revert-layer|currentcolor)\s*$/i.test(v) || /\d(ch|ex|cap|ic|lh|rlh)\b|currentcolor/i.test(v)) return null;
      if (!out) { out = {}; ctx = { em: base._fontPx, rem: rootFontPx(), vw: viewport.w / 100, vh: viewport.h / 100 }; }
      out[n] = computeValue(n, v, ctx, parent, base);
    }
    return out || {};
  }
  // keyframes at progress (0..1, eased) onto c: the computed styles of the
  // two keyframes around it, interpolated
  // (the properties the frames set, while computedOf notes them: frameKeys)
  var frameKeys = null;
  function applyFrames(el, c, parent, frames, progress, easing) {
    var from = null, to = null;
    for (var f = 0; f < frames.length; f++) { if (frames[f].off <= progress) from = frames[f]; if (frames[f].off >= progress && !to) to = frames[f]; }
    var A = from || { off: 0, decls: {} }, B = to || { off: 1, decls: {} };
    var local = B.off > A.off ? (progress - A.off) / (B.off - A.off) : 0;
    local = easingFn(A.timing || easing || 'linear')(local);
    var props = {};
    frames.forEach(function (fr) { for (var k in fr.decls) props[k] = true; });
    // (a property a keyframe leaves out: the underlying value there)
    var ca = frameStyle(el, parent, A), cb = A === B ? ca : frameStyle(el, parent, B);
    for (var pk in props) {
      if (pk.slice(0, 2) === '--') continue;
      if (frameKeys) frameKeys[pk] = 1;
      c[pk] = interpolateValue(pk, A.decls[pk] !== undefined || !from ? ca[pk] : c[pk], B.decls[pk] !== undefined || !to ? cb[pk] : c[pk], local);
    }
  }
  // c is the style `base` with only `keys` changed (renderNode then takes
  // base's own properties and looks at those only: 120 boxes animated,
  // each walked its 250 properties a frame)
  function diffFrom(c, base, keys) {
    Object.defineProperty(c, '_dfrom', { value: { base: base, keys: keys }, enumerable: false, configurable: true, writable: true });
  }
  // An element whose inline style changed only in properties that nothing
  // else is computed from (PATCHED), under the same parent style and the
  // same rules: the style it had with those properties computed again, or
  // null when that cannot be told (computeStyle then). A transform or an
  // opacity set on 500 elements every frame cost a whole cascade each.
  // (sizes and offsets too: Motion's width tween, a drag's left and top;
  // a percentage is not patched)
  var PATCHED = { transform: 1, opacity: 1, 'z-index': 1, translate: 1, rotate: 1, scale: 1, width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1, left: 1, top: 1, right: 1, bottom: 1, 'margin-top': 1, 'margin-right': 1, 'margin-bottom': 1, 'margin-left': 1, 'padding-top': 1, 'padding-right': 1, 'padding-bottom': 1, 'padding-left': 1, 'background-color': 1 };
  function patchedStyle(el, parent) {
    var pc = el._pc, st = el._style, old = pc.cs;
    if (pc.gen !== styleGen || pc.parent !== parent || !parent || !st || shadowCount) return null;
    if (el._anims) return null;
    // (an element with Web Animations: the style it had without them is
    // the one patched, computedOf applies them again)
    var ab = el._ab;
    if (ab) {
      if (old === ab.out && ab.gen === styleGen && ab.parent === parent) old = ab.base;
      else if (old !== ab.base) return null;
    }
    var tr = old.transition, tp = old['transition-property'], td = old['transition-duration'];
    if ((tr && tr !== 'none' && /[1-9]/.test(tr)) || (td && /[1-9]/.test(td)) || (old.animation && old.animation !== 'none') || (old['animation-name'] && old['animation-name'] !== 'none')) return null;
    if (old.display === 'table-cell' || old.transform && typeof old.transform === 'string' && old._boxDep) return null;
    // (an !important declaration of a matched rule wins over the inline one)
    var hm = el._hm, hits = hm && hm.gen === styleGen ? hm.m[''] : null;
    if (!hits) return null;
    if (hm.imp === undefined) {
      var imp = null;
      for (var h = 0; h < hits.length; h++) { var ds = hits[h].r.decls; for (var j = 0; j < ds.length; j++) if (ds[j].important) (imp || (imp = {}))[ds[j].name] = 1; }
      hm.imp = imp;
    }
    var vals = {};
    for (var n in pc.names) {
      if (!PATCHED[n] || st._prio[n] || (hm.imp && (hm.imp[n] || hm.imp.all))) return null;
      var v = st._p[n];
      if (v === undefined || v.indexOf('var(') >= 0 || v.indexOf('%') >= 0 || /^(inherit|initial|unset|revert|revert-layer)$/i.test(v) || /\d(ch|ex|cap|ic|lh|rlh)\b|currentcolor/i.test(v)) return null;
      vals[n] = v;
    }
    var out = {};
    for (var k in old) out[k] = old[k];
    var ctx = { em: old._fontPx, rem: rootFontPx(), vw: viewport.w / 100, vh: viewport.h / 100 };
    for (var n2 in vals) out[n2] = computeValue(n2, vals[n2], ctx, parent, out);
    diffFrom(out, old, vals);
    if (old._cc) Object.defineProperty(out, '_cc', { value: old._cc, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(out, '_sid', { value: ++styleUid, enumerable: false });
    return out;
  }
  function computedOf(el) {
    if (treePending.size) flushTree();
    if (computedCache.gen !== styleGen) { computedCache = { gen: styleGen, map: {} }; treePending.clear(); }
    var c = computedCache.map[el.__id];
    if (c) {
      // (an animated style read after the clock moved on, between two
      // frames: getComputedStyle sees the animations now)
      var ab0 = el._ab;
      if (!ab0 || ab0.out !== c || ab0.t === animNow()) return c;
      delete computedCache.map[el.__id];
      el._rj = null;
      el._abKeep = true;
    }
    var pel = shadowCount ? flatParent(el) : el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
    var parent = pel ? computedOf(pel) : null;
    // (an animation frame: the style without the animations kept, animRestyle)
    var ab = el._ab, keep = el._abKeep;
    el._abKeep = false;
    if (keep && ab && ab.gen === styleGen && ab.parent === parent) c = copyStyle(ab.base);
    else c = (el._pc ? patchedStyle(el, parent) : null) || computeStyle(el, parent);
    el._pc = null;
    // (a new style without animations: the transitions it starts)
    if (!(keep && ab && ab.gen === styleGen && ab.parent === parent)) {
      if (el._tr || (c.transition && c.transition !== 'none') || (c['transition-duration'] && /[1-9]/.test(c['transition-duration']))) startTransitions(el, c);
      else el._trBase = c;
    }
    var cssAnim = (c.animation && c.animation !== 'none') || (c['animation-name'] && c['animation-name'] !== 'none'), waapi = el._waapi && el._waapi.length, trans = hasTransitions(el);
    if (cssAnim || waapi || trans) {
      if (!(keep && ab && ab.gen === styleGen && ab.parent === parent)) { ab = el._ab = { gen: styleGen, parent: parent, base: c, out: null }; c = copyStyle(c); }
      var fk = frameKeys;
      frameKeys = {};
      try {
        if (trans) applyTransitions(el, c);
        if (cssAnim) applyAnimations(el, c, parent);
        if (waapi) applyWaapi(el, c, parent);
        diffFrom(c, ab.base, frameKeys);
      } finally { frameKeys = fk; }
      ab.out = c;
      ab.t = animNow();
    } else el._ab = null;
    if (!cssAnim && el._anims) el._anims = null;
    computedCache.map[el.__id] = c;
    el._ocs = null;
    el._trOut = c;
    // (styled: its ancestors are noted with it, so one never styled has
    // nothing styled under it; treeChanged keeps that true for a move)
    if (!el._es) styledNow(el);
    if (c.display === 'table-cell') { var cb = columnBackground(el, c); if (cb) { c = cb; computedCache.map[el.__id] = c; } }
    return c;
  }
  function noBg(cs) { var v = cs['background-color']; return !v || v === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(v); }
  // CSS 2.1 17.5.1: a column's (or column group's) background shows under
  // the cells of that column where the cell, its row and its row group
  // have none (so the cell takes it as its own)
  // a cell's span less its collapsed columns: -1 when none is collapsed,
  // 0 when all are (CSS 2.1 17.5.5)
  function collapsedSpan(el) {
    var p = el.parentNode, tbl = null;
    if (!p || p.nodeType !== 1) return -1;
    var pd = computedOf(p).display;
    if (/^(inline-)?table$/.test(pd)) tbl = p;
    else if (pd === 'table-row') {
      var g = p.parentNode;
      if (!g || g.nodeType !== 1) return -1;
      var gd = computedOf(g).display;
      if (/^(inline-)?table$/.test(gd)) tbl = g;
      else if (/^table-(row|header|footer)-group$/.test(gd)) {
        var t2 = g.parentNode;
        if (t2 && t2.nodeType === 1 && /^(inline-)?table$/.test(computedOf(t2).display)) tbl = t2;
      }
    }
    if (!tbl) return -1;
    var gone = [], anyGone = false;
    var span = function (e) { return Math.max(1, parseInt(e.getAttribute('span') || '1', 10) || 1); };
    for (var k = tbl.firstChild; k; k = k.nextSibling) {
      if (k.nodeType !== 1) continue;
      var kc = computedOf(k), kd = kc.display, gc = kc.visibility === 'collapse';
      if (kd === 'table-column') { for (var s1 = span(k); s1 > 0; s1--) { gone.push(gc); anyGone = anyGone || gc; } }
      else if (kd === 'table-column-group') {
        var any = false;
        for (var q = k.firstChild; q; q = q.nextSibling) if (q.nodeType === 1 && computedOf(q).display === 'table-column') { any = true; var qc = gc || computedOf(q).visibility === 'collapse'; for (var s2 = span(q); s2 > 0; s2--) { gone.push(qc); anyGone = anyGone || qc; } }
        if (!any) for (var s3 = span(k); s3 > 0; s3--) { gone.push(gc); anyGone = anyGone || gc; }
      }
    }
    if (!anyGone) return -1;
    var col = 0;
    for (var sb = el.previousSibling; sb; sb = sb.previousSibling) {
      if (sb.nodeType !== 1 || computedOf(sb).display !== 'table-cell') continue;
      col += Math.max(1, parseInt(sb.getAttribute('colspan') || '1', 10) || 1);
    }
    var n = Math.max(1, parseInt(el.getAttribute('colspan') || '1', 10) || 1), left = 0;
    for (var i = col; i < col + n; i++) if (!gone[i]) left++;
    return left === n ? -1 : left;
  }
  function columnBackground(el, c) {
    if (!noBg(c) || (c['background-image'] && c['background-image'] !== 'none')) return;
    var p = el.parentNode, tbl = null;
    if (!p || p.nodeType !== 1) return;
    var pd = computedOf(p).display;
    if (/^(inline-)?table$/.test(pd)) tbl = p;
    else if (pd === 'table-row') {
      if (!noBg(computedOf(p))) return;
      var g = p.parentNode;
      if (!g || g.nodeType !== 1) return;
      var gd = computedOf(g).display;
      if (/^(inline-)?table$/.test(gd)) tbl = g;
      else if (/^table-(row|header|footer)-group$/.test(gd)) {
        if (!noBg(computedOf(g))) return;
        var t2 = g.parentNode;
        if (t2 && t2.nodeType === 1 && /^(inline-)?table$/.test(computedOf(t2).display)) tbl = t2;
      }
    }
    if (!tbl) return;
    // the cell's column: the cells before it in its row (colspan)
    var col = 0;
    for (var sb = el.previousSibling; sb; sb = sb.previousSibling) {
      if (sb.nodeType !== 1) continue;
      var sd = computedOf(sb).display;
      if (sd !== 'table-cell') { if (p === tbl) break; continue; }
      col += Math.max(1, parseInt(sb.getAttribute('colspan') || '1', 10) || 1);
    }
    // the table's columns, each with its group
    var cols = [];
    for (var k = tbl.firstChild; k; k = k.nextSibling) {
      if (k.nodeType !== 1) continue;
      var kd = computedOf(k).display;
      var span = function (e) { return Math.max(1, parseInt(e.getAttribute('span') || '1', 10) || 1); };
      if (kd === 'table-column') { for (var s1 = span(k); s1 > 0; s1--) cols.push({ c: k, g: null }); }
      else if (kd === 'table-column-group') {
        var any = false;
        for (var q = k.firstChild; q; q = q.nextSibling) if (q.nodeType === 1 && computedOf(q).display === 'table-column') { any = true; for (var s2 = span(q); s2 > 0; s2--) cols.push({ c: q, g: k }); }
        if (!any) for (var s3 = span(k); s3 > 0; s3--) cols.push({ c: null, g: k });
      }
    }
    var e = cols[col];
    if (!e) return;
    var src = e.c && !noBg(computedOf(e.c)) ? computedOf(e.c) : e.g && !noBg(computedOf(e.g)) ? computedOf(e.g) : null;
    if (!src) return;
    // (a copy: c may be shared with the cells alike)
    var o = {};
    for (var ck in c) o[ck] = c[ck];
    if (c._cc) Object.defineProperty(o, '_cc', { value: c._cc, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(o, '_sid', { value: ++styleUid, enumerable: false });
    o['background-color'] = src['background-color'];
    return o;
  }

  function computeStyle(el, parent, pe, extra) {
    var spec = pe ? cascade(el, pe) : cascade(el);
    var skey = null, ikey = null, tookOwn = false;
    // (a pseudo-element's style too: it takes nothing from its element but
    // the element's style, its parent here)
    if (!extra && spec && spec._sid && el !== (doc && doc.documentElement) && (!parent || parent._sid) && !(el._waapi && el._waapi.length)) {
      skey = spec._sid + ':' + (parent ? parent._sid : 0);
      if (sharedCache.gen !== styleGen) { sharedCache = { gen: styleGen, map: {}, n: 0 }; ikMap = {}; }
      if (sharedInline.gen !== styleGen) sharedInline = { gen: styleGen, map: {}, n: 0 };
      var scache = spec._inl ? sharedInline : sharedCache;
      var shared = scache.map[skey];
      // (or by what the parent hands down, when the declarations take
      // nothing else from it: no `inherit`)
      if (!shared && parent) { ikey = spec._sid + ';' + inheritKey(parent); shared = scache.map[ikey]; }
      if (shared) { if (!pe) el._ia = shared._ia0; return shared; }
    }
    // (an animation's keyframe: its declarations over the cascade's)
    if (extra) { var sp2 = {}; for (var sk0 in spec) sp2[sk0] = spec[sk0]; for (var ek in extra) sp2[ek] = extra[ek]; spec = sp2; }
    var out = {};
    // (custom properties: the parent's object itself when the element sets
    // none; Bootstrap's 200 --bs-* were copied to every element)
    var vars, ownVar = false;
    for (var n0 in spec) if (n0.charCodeAt(0) === 45 && n0.charCodeAt(1) === 45) { ownVar = true; break; }
    // (a registered property that does not inherit starts again at its
    // initial value: the parent's object only when it has those)
    if (regNoInherit && parent && parent._vars && !ownVar) for (var rn0 in regProps) { var rp0 = regProps[rn0]; if (!rp0.inh && parent._vars[rn0] !== rp0.init) { ownVar = true; break; } }
    if (parent && !ownVar && parent._vars) vars = parent._vars;
    else {
      // (the same parent's properties and the same own ones: the same
      // object, made once; a grid's rows each set a few, and their cells
      // then shared no style, see inheritKey)
      var vkey = String(parent && parent._vars ? varsId(parent._vars) : 0);
      for (var nk in spec) if (nk.charCodeAt(0) === 45 && nk.charCodeAt(1) === 45) vkey += '\u0001' + nk + '\u0002' + spec[nk];
      if (varsMemo.gen !== styleGen) varsMemo = { gen: styleGen, map: {}, n: 0 };
      vars = varsMemo.map[vkey];
    }
    if (!vars) {
      vars = {};
      if (varsMemo.n < 20000) { varsMemo.map[vkey] = vars; varsMemo.n++; }
      if (parent) for (var pv in parent._vars) vars[pv] = parent._vars[pv];
      if (regProps) for (var rn in regProps) { var rp = regProps[rn]; if (!parent || !rp.inh || !parent._vars) { if (rp.init === undefined) delete vars[rn]; else vars[rn] = rp.init; } }
      for (var n in spec) if (n.slice(0, 2) === '--') vars[n] = spec[n];
      // custom properties may use each other
      // (one that refers to an unset property with no fallback is
      // guaranteed-invalid, i.e. unset itself, CSS Variables 1, 3: a
      // child's var() of it takes its fallback, AG Grid's theme params)
      for (var vn in vars) if (vars[vn].indexOf('var(') >= 0) { varInvalid = false; var rv = resolveVars(vars[vn], vars, 0); if (varInvalid) delete vars[vn]; else vars[vn] = rv; }
    }
    out._vars = vars;
    // inherited from the parent first
    if (parent) for (var ip in INHERITED) if (parent[ip] !== undefined) out[ip] = parent[ip];
    var fontPx = parent ? parent._fontPx : 16;
    var rootPx = rootFontPx();
    // font-size first: em in other properties depend on it
    var fsRaw = spec['font-size'];
    if (fsRaw !== undefined) {
      var fs = resolveVars(fsRaw, vars, 0);
      if (fs === 'inherit') fs = parent ? parent['font-size'] : '16px';
      var px = fontSizePx(fs, fontPx, rootPx);
      out['font-size'] = fmtPx(px);
      out._fontPx = px;
      out._fsKw = /^(xx?-small|small|medium|large|xx?-large|xxx-large|smaller|larger|initial)$/.test(fs) && (parent ? parent._fsKw !== false : true);
    } else {
      out._fontPx = fontPx;
      out._fsKw = parent ? parent._fsKw !== false : true;
      // a size from the keywords is 13px, not 16px, in the monospace
      // generic family (as browsers do)
      var famOf = function (f) { return String(f || '').trim() === 'monospace'; };
      var mono = famOf(spec['font-family'] !== undefined ? spec['font-family'] : (parent ? parent['font-family'] : ''));
      var pMono = parent ? famOf(parent['font-family']) : false;
      if (out._fsKw && mono !== pMono) {
        out._fontPx = mono ? fontPx * 13 / 16 : fontPx * 16 / 13;
        out['font-size'] = fmtPx(out._fontPx);
      }
      if (!out['font-size']) out['font-size'] = fmtPx(fontPx);
    }
    var ctx = { em: out._fontPx, rem: el === (doc && doc.documentElement) ? out._fontPx : rootPx, vw: viewport.w / 100, vh: viewport.h / 100 };
    // ch is the face's "0" and ex its x-height: Ahem's are 1em and 0.8em,
    // a monospace face's 0 is 0.6em, other faces' about half an em
    var fam0 = String(spec['font-family'] !== undefined ? spec['font-family'] : (parent ? parent['font-family'] || '' : '')).toLowerCase();
    if (/ahem/.test(fam0)) { ctx.ch = ctx.em; ctx.ex = ctx.em * 0.8; }
    else if (/mono|courier|consolas/.test(fam0)) ctx.ch = ctx.em * 0.6021;
    // (logical longhands go to the physical side of the element's own
    // writing mode and direction)
    var wmOf = function (k) { var w = spec[k] !== undefined ? resolveVars(spec[k], vars, 0) : ''; return w && !/^(inherit|unset)$/.test(w) ? (w === 'initial' ? INITIAL[k] : w) : (parent ? parent[k] : INITIAL[k]); };
    var ownWm = wmOf('writing-mode'), ownDir = wmOf('direction');
    var sq = spec._seq || {}, physFrom = {};
    for (var ln in spec) { var pn = physicalOf(ln, ownWm, ownDir); if (pn && (physFrom[pn] === undefined || (sq[ln] || 0) > (sq[physFrom[pn]] || 0))) physFrom[pn] = ln; }
    for (var name0 in spec) {
      if (name0.slice(0, 2) === '--' || name0 === 'font-size') continue;
      var v = spec[name0];
      var name = physicalOf(name0, ownWm, ownDir) || name0;
      // (of a logical longhand and its physical property, the one set later)
      var rival = name === name0 ? physFrom[name] : (physFrom[name] === name0 && spec[name] !== undefined ? name : undefined);
      if (rival !== undefined && rival !== name0 && (sq[rival] || 0) > (sq[name0] || 0)) continue;
      if (v.indexOf('var(') >= 0) {
        v = resolveVars(v, vars, 0);
        var lh = expandShorthand(name, v);
        if (lh && !(name in lh)) { for (var k0 in lh) { if (lh[k0] === undefined) continue; var k = physicalOf(k0, ownWm, ownDir) || k0; out[k] = computeValue(k, lh[k0], ctx, parent, out); } continue; }
      }
      var kw = v.toLowerCase();
      if (kw === 'inherit') { tookOwn = true; out[name] = parent && parent._cc && parent._cc[name] ? 'currentcolor' : parent && parent[name] !== undefined ? parent[name] : INITIAL[name]; continue; }
      if (kw === 'initial' || kw === 'revert' || kw === 'revert-layer') { out[name] = INITIAL[name]; continue; }
      if (kw === 'unset') { out[name] = INHERITED[name] && parent ? parent[name] : INITIAL[name]; continue; }
      out[name] = computeValue(name, v, ctx, parent, out);
    }
    // (the animation shorthand and its longhands, kept apart: the one set
    // later wins. Radix's Collapsible sets animation-name: none inline over
    // tw-animate's animation: accordion-down to measure its open height,
    // which came out 0 while the class's animation ran on)
    if (spec.animation !== undefined) {
      for (var an in spec) {
        if (an.slice(0, 10) !== 'animation-' || spec[an] === undefined) continue;
        if ((sq[an] || 0) < (sq.animation || 0)) delete out[an];
        else if (an === 'animation-name' && out[an] === 'none') out.animation = 'none';
      }
    }
    if (out.display === undefined) out.display = 'inline';
    // the transition shorthand's longhands, as getComputedStyle gives them
    // (Bootstrap waits transitionDuration for a modal's fade)
    if (spec.transition !== undefined) transitionLonghands(out, spec);
    // (a side with a style and no width has the initial one, medium)
    for (var bsd = 0; bsd < 4; bsd++) {
      var bsn = ['top', 'right', 'bottom', 'left'][bsd], bst = out['border-' + bsn + '-style'];
      if (bst && bst !== 'none' && bst !== 'hidden' && out['border-' + bsn + '-width'] === undefined) out['border-' + bsn + '-width'] = '3px';
    }
    // the two-keyword forms as the one-keyword ones (CSS Display 2.7)
    if (/\s/.test(out.display.trim())) {
      var dws = out.display.trim().toLowerCase().split(/\s+/);
      var dIn = dws.indexOf('inline') >= 0;
      var dInner = dws.filter(function (w) { return w !== 'inline' && w !== 'block' && w !== 'run-in'; })[0] || 'flow';
      if (dInner === 'flow') out.display = dIn ? 'inline' : 'block';
      else if (dInner === 'flow-root') out.display = dIn ? 'inline-block' : 'flow-root';
      else if (/^(flex|grid|grid-lanes|table)$/.test(dInner)) out.display = dIn ? 'inline-' + dInner : dInner;
      else if (dInner === 'list-item') out.display = 'list-item';
    }
    // a translation's percentages are of the element's own border box (the
    // host's transform takes lengths): `translate(-50%, -50%)` centres a
    // handle on its point
    var boxDep = false;
    if (out.transform && out.transform.indexOf('%') >= 0) { out.transform = transformPercents(el, out); boxDep = true; }
    if (boxDep) Object.defineProperty(out, '_boxDep', { value: true, enumerable: false });
    // currentcolor in colors
    var color = out.color || 'rgb(0, 0, 0)';
    // (a property that is currentcolor is inherited as currentcolor, which
    // the child's own colour resolves: `border-color: inherit`)
    var ccs = null;
    for (var cn in out) if (typeof out[cn] === 'string' && /currentcolor/i.test(out[cn]) && cn !== 'color') { if (/^currentcolor$/i.test(out[cn])) (ccs || (ccs = {}))[cn] = true; out[cn] = out[cn].replace(/currentcolor/ig, color); }
    if (ccs) Object.defineProperty(out, '_cc', { value: ccs, enumerable: false, configurable: true, writable: true });
    // a floated or absolutely positioned element is a block
    // (an inline-level one's static position is on a line: the tree says
    // so, "ia")
    if (el && el.nodeType === 1 && !pe) el._ia = (out.position === 'absolute' || out.position === 'fixed') && /^inline/.test(out.display);
    if ((out.position === 'absolute' || out.position === 'fixed') && /^inline/.test(out.display)) out.display = out.display === 'inline-flex' ? 'flex' : out.display === 'inline-grid' ? 'grid' : out.display === 'inline-grid-lanes' ? 'grid-lanes' : 'block';
    if (parent && /^(inline-)?(flex|grid|grid-lanes)$/.test(parent.display) && /^inline/.test(out.display)) out.display = out.display === 'inline-flex' ? 'flex' : out.display === 'inline-grid' ? 'grid' : out.display === 'inline-grid-lanes' ? 'grid-lanes' : out.display === 'inline-block' || out.display === 'inline' ? 'block' : out.display;
    // (shared with the elements alike: not one that a box's size went into,
    // or that computedOf goes on to change, animated)
    if (skey !== null && (scache === sharedInline || sharedCache.n < 20000) && !boxDep &&
        !((out.animation && out.animation !== 'none') || (out['animation-name'] && out['animation-name'] !== 'none')) && !(el._waapi && el._waapi.length)) {
      Object.defineProperty(out, '_sid', { value: ++styleUid, enumerable: false });
      Object.defineProperty(out, '_ia0', { value: el._ia, enumerable: false });
      scache.map[ikey !== null && !tookOwn ? ikey : skey] = out;
      scache.n++;
    } else Object.defineProperty(out, '_sid', { value: ++styleUid, enumerable: false });
    return out;
  }
  function individualTransforms(el, cs) {
    var parts = [], sp = function (v) { return splitValue(String(v).trim()); };
    if (cs.translate && cs.translate !== 'none') { var tv = sp(cs.translate); parts.push(tv.length > 2 ? 'translate3d(' + tv[0] + ', ' + tv[1] + ', ' + tv[2] + ')' : 'translate(' + tv[0] + ', ' + (tv[1] || '0px') + ')'); }
    if (cs.rotate && cs.rotate !== 'none') {
      var rv = sp(cs.rotate), ang = rv[rv.length - 1];
      if (rv.length === 1) parts.push('rotate(' + ang + ')');
      else if (rv[0] === 'z' || rv.length === 4 && parseFloat(rv[0]) === 0 && parseFloat(rv[1]) === 0) parts.push('rotate(' + ang + ')');
      else if (rv[0] === 'x') parts.push('rotateX(' + ang + ')');
      else if (rv[0] === 'y') parts.push('rotateY(' + ang + ')');
      else if (rv.length === 4) parts.push('rotate3d(' + rv.join(', ') + ')');
    }
    if (cs.scale && cs.scale !== 'none') { var sv = sp(cs.scale); parts.push(sv.length > 2 ? 'scale3d(' + sv.join(', ') + ')' : 'scale(' + sv[0] + ', ' + (sv[1] || sv[0]) + ')'); }
    if (cs.transform && cs.transform !== 'none') parts.push(cs.transform);
    var list = parts.join(' ');
    if (list.indexOf('%') < 0) return list;
    var tmp = Object.create(cs); tmp.transform = list;
    return transformPercents(el, tmp);
  }
  var pctTransforms = [];
  function transformPercents(el, out) {
    var px = function (k) { var m = /^(-?[\d.]+)px$/.exec(out[k] || ''); return m ? parseFloat(m[1]) : null; };
    var side = function (dim, a, b) {
      var v = px(dim);
      if (v === null) { var bx = boxes[el.__id]; return bx ? (dim === 'width' ? bx[2] : bx[3]) : 0; }
      if (out['box-sizing'] !== 'border-box') v += (px('padding-' + a) || 0) + (px('padding-' + b) || 0) + (px('border-' + a + '-width') || 0) + (px('border-' + b + '-width') || 0);
      return v;
    };
    var w = side('width', 'left', 'right'), h = side('height', 'top', 'bottom');
    // (the size came from the last layout: __layout styles el again when
    // its box comes back another size)
    if (el && el.__id !== undefined && (px('width') === null || px('height') === null)) {
      el._pctBox = w + ',' + h;
      if (pctTransforms.indexOf(el) < 0) pctTransforms.push(el);
    }
    // (each argument's percentages of the box, then its calc() in px:
    // Tailwind's translate-x-[calc(100%-2px)] and -translate-x-1/2,
    // calc(calc(1 / 2 * 100%) * -1), were left as they were)
    var t = out.transform, res = '', i = 0, re = /(translate(?:X|Y|3d)?)\(/g, m;
    var ctx = { em: parseFloat(out['font-size']) || 16, rem: rootFontPx(), vw: viewport.w / 100, vh: viewport.h / 100 };
    while ((m = re.exec(t)) !== null) {
      var open = m.index + m[1].length, close = findClose(t, open, '(', ')');
      if (close < 0) break;
      var fn = m[1], k = 0;
      var args = splitTop(t.slice(open + 1, close), ',').map(function (a) {
        var axis = fn === 'translateY' ? 'y' : fn === 'translateX' ? 'x' : k++ === 0 ? 'x' : 'y';
        a = a.trim().replace(/(-?[\d.]+(?:e-?\d+)?)%/g, function (q, n) { return fmtPx(parseFloat(n) / 100 * (axis === 'x' ? w : h)); });
        return /calc\(|min\(|max\(|clamp\(/i.test(a) ? calcLengths(a, ctx) : a;
      });
      res += t.slice(i, m.index) + fn + '(' + args.join(', ') + ')';
      i = close + 1; re.lastIndex = i;
    }
    return res + t.slice(i);
  }
  function rootFontPx() {
    var r = doc && doc.documentElement;
    if (!r) return 16;
    var c = computedCache.map[r.__id];
    return c ? c._fontPx : 16;
  }
  var varInvalid = false;
  function resolveVars(v, vars, depth) {
    if (depth > 20 || v.indexOf('var(') < 0) return v;
    var out = '', i = 0;
    for (;;) {
      var k = v.indexOf('var(', i);
      if (k < 0) { out += v.slice(i); break; }
      out += v.slice(i, k);
      var close = findClose(v, k + 3, '(', ')');
      if (close < 0) { out += v.slice(k); break; }
      var inner = v.slice(k + 4, close);
      var comma = inner.indexOf(',');
      var name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      var fb = comma < 0 ? undefined : inner.slice(comma + 1).trim();
      var val = vars[name];
      if (val === undefined || val === 'initial') { if (fb === undefined) varInvalid = true; val = fb === undefined ? '' : fb; }
      out += resolveVars(val, vars, depth + 1);
      i = close + 1;
    }
    return out.trim();
  }
  function fmtPx(n) { return (Math.round(n * 1000) / 1000) + 'px'; }
  var FONT_SIZES = { 'xx-small': 9, 'x-small': 10, 'small': 13, 'medium': 16, 'large': 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
  function fontSizePx(v, parentPx, rootPx) {
    v = String(v).trim().toLowerCase();
    if (FONT_SIZES[v] !== undefined) return FONT_SIZES[v];
    if (v === 'smaller') return parentPx / 1.2;
    if (v === 'larger') return parentPx * 1.2;
    var l = lengthPx(v, { em: parentPx, rem: rootPx, vw: viewport.w / 100, vh: viewport.h / 100, pct: parentPx });
    return l === null ? parentPx : l;
  }
  // a length in px, or null (auto, %, a keyword)
  function lengthPx(v, ctx) {
    v = String(v).trim();
    var m = /^([+-]?[\d.]+(?:e-?\d+)?)(px|em|rem|vw|vh|vmin|vmax|pt|pc|in|cm|mm|ch|ex|q|%)?$/i.exec(v);
    if (m) {
      var n = parseFloat(m[1]);
      var u = (m[2] || '').toLowerCase();
      switch (u) {
        case '': return n === 0 ? 0 : n;
        case 'px': return n;
        case 'em': return n * ctx.em;
        case 'rem': return n * ctx.rem;
        case 'vw': return n * ctx.vw;
        case 'vh': return n * ctx.vh;
        case 'vmin': return n * Math.min(ctx.vw, ctx.vh);
        case 'vmax': return n * Math.max(ctx.vw, ctx.vh);
        case 'pt': return n * 4 / 3;
        case 'pc': return n * 16;
        case 'in': return n * 96;
        case 'cm': return n * 96 / 2.54;
        case 'mm': return n * 96 / 25.4;
        case 'q': return n * 96 / 101.6;
        case 'ch': return n * (ctx.ch !== undefined ? ctx.ch : ctx.em / 2);
        case 'ex': return n * (ctx.ex !== undefined ? ctx.ex : ctx.em / 2);
        case '%': return ctx.pct !== undefined ? n * ctx.pct / 100 : null;
      }
    }
    if (/^(calc|min|max|clamp)\(/i.test(v)) return calcPx(v, ctx);
    return null;
  }
  // each calc()/min()/max() in v that has px-convertible terms, in px
  function calcLengths(v, ctx) {
    var out = '', i = 0, re = /(calc|min|max|clamp)\(/gi, m;
    while ((m = re.exec(v)) !== null) {
      if (m.index < i) continue;
      var close = findClose(v, m.index + m[1].length, '(', ')');
      if (close < 0) break;
      var px = calcPx(v.slice(m.index, close + 1), ctx);
      out += v.slice(i, m.index) + (px === null ? v.slice(m.index, close + 1) : fmtPx(px));
      i = close + 1; re.lastIndex = i;
    }
    return out + v.slice(i);
  }
  // calc() with px-convertible terms; a % keeps it unresolved (null)
  function calcPx(v, ctx) {
    var s = v.replace(/^calc\(/i, '(');
    var toks = [];
    var re = /\s*(-?[\d.]+(?:e-?\d+)?[a-z%]*|[()+\-*\/,]|min\(|max\(|clamp\(|calc\()\s*/gi;
    var m, pos = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index !== pos) return null;
      toks.push(m[1].toLowerCase());
      pos = re.lastIndex;
    }
    if (pos !== s.length) return null;
    var i = 0;
    function primary() {
      var t = toks[i++];
      if (t === '(' || t === 'calc(') { var e = expr(); i++; return e; }
      if (t === 'min(' || t === 'max(' || t === 'clamp(') {
        var args = [expr()];
        while (toks[i] === ',') { i++; args.push(expr()); }
        i++;
        if (args.some(function (a) { return a === null; })) return null;
        if (t === 'min(') return Math.min.apply(null, args);
        if (t === 'max(') return Math.max.apply(null, args);
        return Math.max(args[0], Math.min(args[1], args[2]));
      }
      if (t === '-') { var p = primary(); return p === null ? null : -p; }
      if (/^-?[\d.]/.test(t)) {
        if (/^-?[\d.]+(e-?\d+)?$/.test(t)) return { num: parseFloat(t) };
        return lengthPx(t, ctx);
      }
      return null;
    }
    function term() {
      var a = primary();
      while (toks[i] === '*' || toks[i] === '/') {
        var op = toks[i++];
        var b = primary();
        if (a === null || b === null) return null;
        var av = typeof a === 'object' ? a.num : a, bv = typeof b === 'object' ? b.num : b;
        var bothNum = typeof a === 'object' && typeof b === 'object';
        var r = op === '*' ? av * bv : av / bv;
        a = bothNum ? { num: r } : r;
      }
      return a;
    }
    function expr() {
      var a = term();
      while (toks[i] === '+' || toks[i] === '-') {
        var op = toks[i++];
        var b = term();
        if (a === null || b === null) return null;
        var av = typeof a === 'object' ? a.num : a, bv = typeof b === 'object' ? b.num : b;
        a = op === '+' ? av + bv : av - bv;
      }
      return a;
    }
    var r = expr();
    if (r === null || r === undefined) return null;
    return typeof r === 'object' ? r.num : r;
  }
  var LENGTH_PROPS = /^(width|height|min-width|min-height|max-width|max-height|top|right|bottom|left|margin-(top|right|bottom|left)|padding-(top|right|bottom|left)|border-(top|right|bottom|left)-width|border-(top|bottom)-(left|right)-radius|row-gap|column-gap|flex-basis|letter-spacing|word-spacing|text-indent|outline-width|outline-offset|line-height|gap)$/;
  function computeValue(name, v, ctx, parent, out) {
    v = v.trim();
    if (name === 'line-height') {
      if (/^\+?[\d.]+$/.test(v)) return v.replace(/^\+/, '');
      // (a calc() of plain numbers is a number: Tailwind's
      // calc(1.25 / 0.875) line heights)
      var un = unitlessCalc(v);
      if (un !== null) return String(+un.toFixed(6));
      if (v === 'normal') return v;
      var lh = lengthPx(v, { em: ctx.em, rem: ctx.rem, vw: ctx.vw, vh: ctx.vh, pct: ctx.em });
      return lh === null ? v : fmtPx(lh);
    }
    if (/-width$/.test(name) && /^border-|^outline-/.test(name)) {
      if (v === 'thin') return '1px';
      if (v === 'medium') return '3px';
      if (v === 'thick') return '5px';
    }
    // (the lengths of each layer in px, calc() worked out where it has no
    // percentage: Bootstrap's `calc(.75em + .375rem)` icon sizes, 1.25rem)
    if (name === 'background-size' || name === 'background-position') {
      if (/calc\(|min\(|max\(|clamp\(/i.test(v)) v = calcLengths(v, ctx);
      return v.replace(/(^|[\s,])([+-]?(?:\d+\.?\d*|\.\d+))(rem|em|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q)(?=$|[\s,])/gi, function (m, pre, n, u) {
        var q = lengthPx(n + u, ctx);
        return q === null ? m : pre + fmtPx(q);
      });
    }
    // (one or two lengths, each in px)
    if (name === 'border-spacing') {
      return v.trim().split(/\s+/).map(function (w) { var q = lengthPx(w, ctx); return q === null ? w : fmtPx(q); }).join(' ');
    }
    if (LENGTH_PROPS.test(name)) {
      if (/%/.test(v) && !/^(calc|min|max|clamp)\(/.test(v)) return v;
      var px = lengthPx(v, ctx);
      if (px !== null) return fmtPx(px);
      // (a calc() with a percentage stays one, its other lengths in px)
      if (/^(calc|min|max|clamp)\(/i.test(v)) return v.replace(/(^|[\s(,*\/+-])([+-]?(?:\d+\.?\d*|\.\d+))(rem|em|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q|ch|ex|px)\b/gi, function (m, pre, n, u) {
        var q = lengthPx(n + u, ctx);
        return q === null ? m : pre + fmtPx(q);
      });
      return v;
    }
    // the thumb's colour, then the track's, each as its own computed colour
    if (name === 'scrollbar-color') {
      if (/^auto$/i.test(v.trim())) return 'auto';
      return (v.match(/[a-z-]+\([^)]*\)|[^\s()]+/gi) || []).map(normalizeColor).join(' ');
    }
    if (name === 'color' || /-color$/.test(name) || name === 'fill' || name === 'stroke') {
      if (/^currentcolor$/i.test(v)) return name === 'color' ? (parent ? parent.color : 'rgb(0, 0, 0)') : v;
      return normalizeColor(v);
    }
    if (name === 'font-weight') {
      if (v === 'normal') return '400';
      if (v === 'bold') return '700';
      if (v === 'bolder') return String(Math.min(900, (parent ? parseInt(parent['font-weight'], 10) || 400 : 400) + 300));
      if (v === 'lighter') return String(Math.max(100, (parent ? parseInt(parent['font-weight'], 10) || 400 : 400) - 300));
      return v;
    }
    // (a translation's calc() in px when it has no percentage: the host's
    // transform takes lengths, Shoelace's switch thumb)
    if ((name === 'translate' || name === 'transform') && /calc\(|min\(|max\(/i.test(v)) v = calcLengths(v, ctx);
    if (name === 'translate') return v.replace(/(-?[\d.]+)(rem|em)\b/g, function (m, n, u) { return fmtPx(parseFloat(n) * (u === 'rem' ? ctx.rem : ctx.em)); });
    if (name === 'box-shadow' || name === 'transform' || name === 'text-shadow') return v.replace(/(-?[\d.]+)(rem|em)\b/g, function (m, n, u) { return fmtPx(parseFloat(n) * (u === 'rem' ? ctx.rem : ctx.em)); });
    return v;
  }

  var NAMED_COLORS = { aliceblue: '240,248,255', antiquewhite: '250,235,215', aqua: '0,255,255', aquamarine: '127,255,212', azure: '240,255,255', beige: '245,245,220', bisque: '255,228,196', black: '0,0,0', blanchedalmond: '255,235,205', blue: '0,0,255', blueviolet: '138,43,226', brown: '165,42,42', burlywood: '222,184,135', cadetblue: '95,158,160', chartreuse: '127,255,0', chocolate: '210,105,30', coral: '255,127,80', cornflowerblue: '100,149,237', cornsilk: '255,248,220', crimson: '220,20,60', cyan: '0,255,255', darkblue: '0,0,139', darkcyan: '0,139,139', darkgoldenrod: '184,134,11', darkgray: '169,169,169', darkgreen: '0,100,0', darkgrey: '169,169,169', darkkhaki: '189,183,107', darkmagenta: '139,0,139', darkolivegreen: '85,107,47', darkorange: '255,140,0', darkorchid: '153,50,204', darkred: '139,0,0', darksalmon: '233,150,122', darkseagreen: '143,188,143', darkslateblue: '72,61,139', darkslategray: '47,79,79', darkslategrey: '47,79,79', darkturquoise: '0,206,209', darkviolet: '148,0,211', deeppink: '255,20,147', deepskyblue: '0,191,255', dimgray: '105,105,105', dimgrey: '105,105,105', dodgerblue: '30,144,255', firebrick: '178,34,34', floralwhite: '255,250,240', forestgreen: '34,139,34', fuchsia: '255,0,255', gainsboro: '220,220,220', ghostwhite: '248,248,255', gold: '255,215,0', goldenrod: '218,165,32', gray: '128,128,128', green: '0,128,0', greenyellow: '173,255,47', grey: '128,128,128', honeydew: '240,255,240', hotpink: '255,105,180', indianred: '205,92,92', indigo: '75,0,130', ivory: '255,255,240', khaki: '240,230,140', lavender: '230,230,250', lavenderblush: '255,240,245', lawngreen: '124,252,0', lemonchiffon: '255,250,205', lightblue: '173,216,230', lightcoral: '240,128,128', lightcyan: '224,255,255', lightgoldenrodyellow: '250,250,210', lightgray: '211,211,211', lightgreen: '144,238,144', lightgrey: '211,211,211', lightpink: '255,182,193', lightsalmon: '255,160,122', lightseagreen: '32,178,170', lightskyblue: '135,206,250', lightslategray: '119,136,153', lightslategrey: '119,136,153', lightsteelblue: '176,196,222', lightyellow: '255,255,224', lime: '0,255,0', limegreen: '50,205,50', linen: '250,240,230', magenta: '255,0,255', maroon: '128,0,0', mediumaquamarine: '102,205,170', mediumblue: '0,0,205', mediumorchid: '186,85,211', mediumpurple: '147,112,219', mediumseagreen: '60,179,113', mediumslateblue: '123,104,238', mediumspringgreen: '0,250,154', mediumturquoise: '72,209,204', mediumvioletred: '199,21,133', midnightblue: '25,25,112', mintcream: '245,255,250', mistyrose: '255,228,225', moccasin: '255,228,181', navajowhite: '255,222,173', navy: '0,0,128', oldlace: '253,245,230', olive: '128,128,0', olivedrab: '107,142,35', orange: '255,165,0', orangered: '255,69,0', orchid: '218,112,214', palegoldenrod: '238,232,170', palegreen: '152,251,152', paleturquoise: '175,238,238', palevioletred: '219,112,147', papayawhip: '255,239,213', peachpuff: '255,218,185', peru: '205,133,63', pink: '255,192,203', plum: '221,160,221', powderblue: '176,224,230', purple: '128,0,128', rebeccapurple: '102,51,153', red: '255,0,0', rosybrown: '188,143,143', royalblue: '65,105,225', saddlebrown: '139,69,19', salmon: '250,128,114', sandybrown: '244,164,96', seagreen: '46,139,87', seashell: '255,245,238', sienna: '160,82,45', silver: '192,192,192', skyblue: '135,206,235', slateblue: '106,90,205', slategray: '112,128,144', slategrey: '112,128,144', snow: '255,250,250', springgreen: '0,255,127', steelblue: '70,130,180', tan: '210,180,140', teal: '0,128,128', thistle: '216,191,216', tomato: '255,99,71', turquoise: '64,224,208', violet: '238,130,238', wheat: '245,222,179', white: '255,255,255', whitesmoke: '245,245,245', yellow: '255,255,0', yellowgreen: '154,205,50', transparent: null };
  function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
    if (s === 0) { var g = l * 255; return [g, g, g]; }
    function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    var q2 = l < 0.5 ? l * (1 + s) : l + s - l * s, p2 = 2 * l - q2;
    return [hue(p2, q2, h + 1 / 3) * 255, hue(p2, q2, h) * 255, hue(p2, q2, h - 1 / 3) * 255];
  }
  function rgbString(r, g, b, a) {
    if (a === undefined || a >= 1) return 'rgb(' + clamp255(r) + ', ' + clamp255(g) + ', ' + clamp255(b) + ')';
    return 'rgba(' + clamp255(r) + ', ' + clamp255(g) + ', ' + clamp255(b) + ', ' + (Math.round(Math.max(0, a) * 1000) / 1000) + ')';
  }
  function channel(t, scale) { t = t.trim(); if (t === 'none') return 0; if (/%$/.test(t)) return parseFloat(t) / 100 * scale; return parseFloat(t); }
  function alphaOf(t) { if (t === undefined) return 1; t = t.trim(); if (t === 'none') return 0; return /%$/.test(t) ? parseFloat(t) / 100 : parseFloat(t); }
  function normalizeColor(v) {
    var s = v.trim().replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",");
    var low = s.toLowerCase();
    if (low === 'transparent') return 'rgba(0, 0, 0, 0)';
    if (NAMED_COLORS[low]) { var p = NAMED_COLORS[low].split(','); return rgbString(+p[0], +p[1], +p[2]); }
    var m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length !== 6 && h.length !== 8) return s;
      return rgbString(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
    }
    var fm = /^(rgba?|hsla?)\((.*)\)$/i.exec(s);
    if (fm) {
      var body = fm[2].trim();
      var parts, alpha;
      if (body.indexOf(',') >= 0) { parts = body.split(','); alpha = parts[3]; parts = parts.slice(0, 3); }
      else { var sl = body.split('/'); parts = sl[0].trim().split(/\s+/); alpha = sl[1]; }
      if (parts.length < 3) return s;
      if (/^rgb/i.test(fm[1])) return rgbString(channel(parts[0], 255), channel(parts[1], 255), channel(parts[2], 255), alphaOf(alpha));
      var rgb = hslToRgb(parseFloat(parts[0]), channel(parts[1], 1) / (/%$/.test(parts[1].trim()) ? 1 : 100), channel(parts[2], 1) / (/%$/.test(parts[2].trim()) ? 1 : 100));
      return rgbString(rgb[0], rgb[1], rgb[2], alphaOf(alpha));
    }
    var mx = /^color-mix\((.*)\)$/i.exec(s);
    if (mx) { var mixed = colorMix(mx[1]); if (mixed) return mixed; }
    var lab = /^oklab\((.*)\)$/i.exec(s);
    if (lab) {
      var lb = lab[1].split('/'), lp = lb[0].trim().split(/\s+/);
      var c4 = oklabToRgb(/%$/.test(lp[0]) ? parseFloat(lp[0]) / 100 : parseFloat(lp[0]), /%$/.test(lp[1]) ? parseFloat(lp[1]) / 100 * 0.4 : parseFloat(lp[1]), /%$/.test(lp[2]) ? parseFloat(lp[2]) / 100 * 0.4 : parseFloat(lp[2]));
      return rgbString(c4[0], c4[1], c4[2], alphaOf(lb[1]));
    }
    var om = /^oklch\((.*)\)$/i.exec(s);
    if (om) {
      var ob = om[1].split('/');
      var op = ob[0].trim().split(/\s+/);
      var L = /%$/.test(op[0]) ? parseFloat(op[0]) / 100 : parseFloat(op[0]);
      var C = /%$/.test(op[1]) ? parseFloat(op[1]) / 100 * 0.4 : parseFloat(op[1]);
      var H = parseFloat(op[2]) || 0;
      var a2 = C * Math.cos(H * Math.PI / 180), b2 = C * Math.sin(H * Math.PI / 180);
      var c3 = oklabToRgb(L, a2, b2);
      return rgbString(c3[0], c3[1], c3[2], alphaOf(ob[1]));
    }
    return s;
  }
  // a calc()/min()/max()/clamp() of plain numbers (no units), else null
  function unitlessCalc(v) {
    if (!/^(calc|min|max|clamp)\(/i.test(v) || /[a-z%]\s*[\d.]*\s*$|\d[a-z%]/i.test(v.replace(/^(calc|min|max|clamp)\(|\b(calc|min|max|clamp)\(/gi, '('))) return null;
    var src = v.replace(/\b(calc)\(/gi, '('), i = 0;
    function ws() { while (i < src.length && /\s/.test(src.charAt(i))) i++; }
    function atom() {
      ws();
      var m = /^(min|max|clamp)\(/i.exec(src.slice(i));
      if (m) { i += m[0].length; var args = [expr()]; ws(); while (src.charAt(i) === ',') { i++; args.push(expr()); ws(); } if (src.charAt(i) !== ')') throw 0; i++; var f = m[1].toLowerCase(); return f === 'min' ? Math.min.apply(null, args) : f === 'max' ? Math.max.apply(null, args) : Math.min(Math.max(args[0], args[1]), args[2]); }
      if (src.charAt(i) === '(') { i++; var e = expr(); ws(); if (src.charAt(i) !== ')') throw 0; i++; return e; }
      var n = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
      if (!n) throw 0;
      i += n[0].length;
      return parseFloat(n[0]);
    }
    function term() { var x = atom(); for (;;) { ws(); var c = src.charAt(i); if (c === '*') { i++; x *= atom(); } else if (c === '/') { i++; x /= atom(); } else return x; } }
    function expr() { var x = term(); for (;;) { ws(); var c = src.charAt(i); if (c === '+' || c === '-') { i++; var y = term(); x = c === '+' ? x + y : x - y; } else return x; } }
    try { var r = expr(); ws(); return i === src.length && isFinite(r) ? r : null; } catch (e) { return null; }
  }
  function rgbToOklab(r, g, b) {
    var lin = function (x) { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    r = lin(r); g = lin(g); b = lin(b);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function rgbaParts(c) {
    var m = /^rgba?\(([^)]*)\)$/.exec(c);
    if (!m) return null;
    var p = m[1].split(',').map(parseFloat);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  // color-mix(in <space>, a [p], b [p]) (CSS Color 5 2): the two colours
  // premultiplied by alpha and mixed in srgb, srgb-linear, oklab, oklch,
  // hsl or lab (as oklab); percentages normalised, a sum under 100 % thins
  // the alpha
  function colorMix(body) {
    var parts = splitTop(body, ',');
    if (parts.length !== 3) return null;
    var space = (/^in\s+([a-z-]+)/i.exec(parts[0]) || [])[1];
    if (!space) return null;
    space = space.toLowerCase();
    var cs = [], ps = [];
    for (var i = 1; i < 3; i++) {
      var t = parts[i].trim(), pm = /\s+(-?[\d.]+)%$/.exec(t) || /^(-?[\d.]+)%\s+/.exec(t), pct = null;
      if (pm) { pct = parseFloat(pm[1]) / 100; t = t.replace(pm[0], '').trim(); }
      var c = rgbaParts(normalizeColor(t));
      if (!c) return null;
      cs.push(c); ps.push(pct);
    }
    var p1 = ps[0], p2 = ps[1];
    if (p1 === null && p2 === null) { p1 = p2 = 0.5; }
    else if (p1 === null) p1 = 1 - p2;
    else if (p2 === null) p2 = 1 - p1;
    var sum = p1 + p2;
    if (sum <= 0) return null;
    var mult = Math.min(1, sum), w2 = p2 / sum;
    var to, from;
    if (space === 'srgb' || space === 'hsl' || space === 'hwb') { to = function (c) { return [c[0], c[1], c[2]]; }; from = function (v) { return v; }; }
    else if (space === 'srgb-linear') { var lin = function (x) { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }, gam = function (x) { return (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255; }; to = function (c) { return [lin(c[0]), lin(c[1]), lin(c[2])]; }; from = function (v) { return [gam(v[0]), gam(v[1]), gam(v[2])]; }; }
    else if (space === 'oklch' || space === 'lch') {
      to = function (c) { var o = rgbToOklab(c[0], c[1], c[2]); return [o[0], Math.sqrt(o[1] * o[1] + o[2] * o[2]), Math.atan2(o[2], o[1]) * 180 / Math.PI]; };
      from = function (v) { return oklabToRgb(v[0], v[1] * Math.cos(v[2] * Math.PI / 180), v[1] * Math.sin(v[2] * Math.PI / 180)); };
    } else { to = function (c) { return rgbToOklab(c[0], c[1], c[2]); }; from = function (v) { return oklabToRgb(v[0], v[1], v[2]); }; }
    var A = to(cs[0]), B = to(cs[1]), a1 = cs[0][3], a2 = cs[1][3];
    var alpha = a1 * (1 - w2) + a2 * w2;
    var out = [0, 0, 0];
    for (var k = 0; k < 3; k++) {
      var hueCh = (space === 'oklch' || space === 'lch') && k === 2;
      if (hueCh) {
        // (shorter hue; a colour with no chroma takes the other's hue)
        var h1 = A[2], h2 = B[2];
        if (A[1] < 1e-6) h1 = h2; if (B[1] < 1e-6) h2 = h1;
        var d = h2 - h1; if (d > 180) h1 += 360; else if (d < -180) h2 += 360;
        out[k] = h1 * (1 - w2) + h2 * w2;
      } else out[k] = alpha ? (A[k] * a1 * (1 - w2) + B[k] * a2 * w2) / alpha : 0;
    }
    var rgb = from(out);
    return rgbString(rgb[0], rgb[1], rgb[2], alpha * mult);
  }
  function oklabToRgb(L, a, b) {
    var l = L + 0.3963377774 * a + 0.2158037573 * b;
    var m = L - 0.1055613458 * a - 0.0638541728 * b;
    var s = L - 0.0894841775 * a - 1.2914855480 * b;
    l = l * l * l; m = m * m * m; s = s * s * s;
    var r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    var bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    function gam(x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }
    return [gam(r) * 255, gam(g) * 255, gam(bb) * 255];
  }

  function getComputedStyle(el, pseudo) {
    if (!el || el.nodeType !== 1) throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.");
    var c = el.isConnected ? computedOf(el) : { display: 'block', _vars: {} };
    var decl = new CSSStyleDeclaration(null);
    for (var k in INITIAL) decl._set(k, c[k] !== undefined ? c[k] : INITIAL[k], '');
    for (var n in c) if (n.charAt(0) !== '_') decl._set(n, c[n], '');
    for (var v in c._vars) decl._set(v, c._vars[v], '');
    // (text-decoration as a shorthand: its line longhand, which the
    // cascade keeps under the shorthand's name)
    if (c['text-decoration'] && !c['text-decoration-line']) {
      var tdl = String(c['text-decoration']).split(/\s+/).filter(function (w) { return /^(underline|overline|line-through|blink)$/.test(w); });
      decl._set('text-decoration-line', tdl.length ? tdl.join(' ') : 'none', '');
    }
    // (the animation shorthand's longhands, which the cascade keeps
    // under the shorthand's name)
    if (c.animation && c.animation !== 'none') {
      var al = animationList(c);
      if (al.length) {
        var aj = function (f) { return al.map(f).join(', '); };
        var ms = function (v) { return (v / 1000) + 's'; };
        decl._set('animation-name', aj(function (a) { return a.name; }), '');
        decl._set('animation-duration', aj(function (a) { return ms(a.duration); }), '');
        decl._set('animation-delay', aj(function (a) { return ms(a.delay); }), '');
        decl._set('animation-timing-function', aj(function (a) { return a.timing; }), '');
        decl._set('animation-iteration-count', aj(function (a) { return a.count === Infinity ? 'infinite' : String(a.count); }), '');
        decl._set('animation-direction', aj(function (a) { return a.direction; }), '');
        decl._set('animation-fill-mode', aj(function (a) { return a.fill; }), '');
        decl._set('animation-play-state', aj(function (a) { return a.play; }), '');
      }
    }
    var b = boxes[el.__id];
    if (b && el.isConnected && c.display !== 'none') {
      if (!/^\d/.test(decl._p.width) || decl._p.width === 'auto') decl._p.width = fmtPx(b[2]);
      if (!/^\d/.test(decl._p.height) || decl._p.height === 'auto') decl._p.height = fmtPx(b[3]);
    }
    // (a subgrid's tracks: "subgrid" and the line names of each line it
    // spans, [] where it names none, as Chromium resolves them)
    if (el.isConnected && /^(inline-)?grid$/.test(c.display || '') && el.parentNode && el.parentNode.nodeType === 1) {
      var pd = computedOf(el.parentNode).display || '';
      if (/^(inline-)?grid(-lanes)?$/.test(pd)) {
        ['columns', 'rows'].forEach(function (ax) {
          var tv = String(c['grid-template-' + ax] || '').trim();
          if (!/^subgrid\b/.test(tv)) return;
          var span = subgridSpan(String(c[ax === 'columns' ? 'grid-column' : 'grid-row'] || 'auto'));
          if (span < 1) return;
          var names = subgridNames(tv.replace(/^subgrid/, ''), span + 1);
          if (!names) return;
          var out = 'subgrid';
          for (var li = 0; li <= span; li++) out += ' ' + (names[li] || '[]');
          decl._p['grid-template-' + ax] = out;
        });
      }
    }
    // (a number line-height resolves to its px, as Chromium reports it)
    if (/^[\d.]+$/.test(decl._p['line-height'] || '') && c._fontPx) decl._p['line-height'] = fmtPx(parseFloat(decl._p['line-height']) * c._fontPx);
    computedShorthands(decl._p);
    decl._readonly = true;
    return styleProxy(decl);
  }
  // a resolved style's shorthands from its longhands (CSSOM 6.7.2 resolved
  // values, as Chromium serialises them): four sides collapse to fewer when
  // alike, a border side is width style color, border only when its four
  // sides are alike (else "")
  function sides4(t, r, b, l) {
    if (t === undefined || r === undefined || b === undefined || l === undefined) return undefined;
    if (r === l) return t === b ? (t === r ? t : t + ' ' + r) : t + ' ' + r + ' ' + b;
    return t + ' ' + r + ' ' + b + ' ' + l;
  }
  function computedShorthands(p) {
    var S = ['top', 'right', 'bottom', 'left'];
    function put(k, v) { if (v !== undefined && !p[k]) p[k] = v; }
    function four(pre, post) { return sides4.apply(null, S.map(function (sd) { return p[pre + sd + post]; })); }
    put('margin', four('margin-', ''));
    put('padding', four('padding-', ''));
    put('inset', sides4(p.top, p.right, p.bottom, p.left));
    put('border-width', four('border-', '-width'));
    put('border-style', four('border-', '-style'));
    put('border-color', four('border-', '-color'));
    var side = {};
    S.forEach(function (sd) {
      var w = p['border-' + sd + '-width'], st = p['border-' + sd + '-style'], co = p['border-' + sd + '-color'];
      if (w !== undefined && st !== undefined && co !== undefined) { side[sd] = w + ' ' + st + ' ' + co; put('border-' + sd, side[sd]); }
    });
    if (side.top !== undefined) put('border', side.top === side.right && side.top === side.bottom && side.top === side.left ? side.top : '');
    var rad = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map(function (c) { return p['border-' + c + '-radius']; });
    if (rad.every(function (x) { return x !== undefined && !/\s/.test(x); })) put('border-radius', sides4(rad[0], rad[1], rad[2], rad[3]));
    var rg = p['row-gap'], cg = p['column-gap'];
    if (rg !== undefined && cg !== undefined) put('gap', rg === cg ? rg : rg + ' ' + cg);
    var ox = p['overflow-x'], oy = p['overflow-y'];
    if (ox !== undefined && oy !== undefined) put('overflow', ox === oy ? ox : ox + ' ' + oy);
  }
  // a subgrid's line name list as one "[...]" per line: repeat(N, ...)
  // N times, repeat(auto-fill, ...) as many times as the lines left over
  // hold (CSS Grid 2 9); null when it does not parse
  function subgridNames(v, lines) {
    var head = [], fill = null, tail = [], i = 0, m;
    var grp = function (t) { var o = [], re = /\[([^\]]*)\]/g, g; while ((g = re.exec(t))) o.push('[' + g[1].trim().split(/\s+/).filter(Boolean).join(' ') + ']'); return o; };
    var re = /\s*(\[[^\]]*\]|repeat\(\s*([^,]+?)\s*,((?:\s*\[[^\]]*\])+)\s*\))/g;
    v = v.trim();
    while (i < v.length) {
      re.lastIndex = i;
      m = re.exec(v);
      if (!m || m.index !== i) return null;
      i = re.lastIndex;
      var list = m[2] ? grp(m[3]) : grp(m[1]);
      var into = fill ? tail : head;
      if (m[2] === 'auto-fill') { if (fill) return null; fill = list; continue; }
      var n = m[2] ? parseInt(m[2], 10) : 1;
      if (!(n >= 1)) return null;
      for (var r = 0; r < n && into.length < 10000; r++) Array.prototype.push.apply(into, list);
      while (i < v.length && /\s/.test(v.charAt(i))) i++;
    }
    var out = head.slice();
    if (fill && fill.length) for (var left = lines - head.length - tail.length; left >= fill.length; left -= fill.length) Array.prototype.push.apply(out, fill);
    return out.concat(tail);
  }
  // how many tracks an item's grid-column or grid-row spans, when its
  // lines are numbers or a span (0 when they are names)
  function subgridSpan(v) {
    var parts = v.split('/').map(function (x) { return x.trim(); });
    var a = parts[0] || 'auto', b = parts.length > 1 ? parts[1] : 'auto';
    var sp = /^span\s+(\d+)$/;
    if (sp.test(b)) return parseInt(sp.exec(b)[1], 10);
    if (sp.test(a)) return b === 'auto' ? parseInt(sp.exec(a)[1], 10) : 0;
    if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) { var d = parseInt(b, 10) - parseInt(a, 10); return d > 0 && parseInt(a, 10) > 0 ? d : 0; }
    if (/^-?\d+$/.test(a) && b === 'auto') return 1;
    if (a === 'auto' && b === 'auto') return 1;
    return 0;
  }

  // ---- rendering for the host ----------------------------------------------

  // what the host lays out: each element {i, t, s: computed style (the
  // properties that differ from the initial value), a: attributes the host
  // shows, c: children}, each text {i, x}
  // ACCESSIBILITY. What each element is to a screen reader (WAI-ARIA 1.2,
  // HTML-AAM, Accessible Name and Description 1.2), computed where the
  // element renders and sent with it as `ax`: r role, n name, d
  // description and the states. The host's view puts them on its boxes
  // (DomView: EVG's a11y fields), from which EVGA11yFromTree builds the tree
  // a host mirrors (evg-a11y.js) or hands to the platform. Only elements
  // with a role a reader stops on carry one; text in a box with none is a
  // "text" node (static text). Roles are the ones EVGA11yFromTree knows: an
  // ARIA role it lacks is mapped to the nearest it has.
  var AX_ROLES = /^(group|text|heading|button|checkbox|radio|textbox|img|link|navigation|form|rowgroup|log|combobox|listbox|option|grid|tabpanel|tablist|tab|toolbar|menu|menubar|menuitem|menuitemcheckbox|menuitemradio|separator|dialog|alertdialog|tooltip|status|region|banner|main|paragraph|list|listitem|table|row|columnheader|rowheader|cell|gridcell|switch|radiogroup|slider|spinbutton|progressbar|tree|treeitem)$/;
  var AX_ALIAS = { searchbox: 'textbox', image: 'img', alert: 'status', timer: 'status', marquee: 'status', meter: 'progressbar', treegrid: 'grid', scrollbar: 'slider',
    article: 'group', complementary: 'region', contentinfo: 'region', search: 'region', figure: 'group', document: 'group', application: 'group', feed: 'group', note: 'group', blockquote: 'group', definition: 'group', term: 'group', directory: 'list', caption: 'text', math: 'img' };
  // roles named by their content (accname 4.3.2, step 2F)
  var AX_FROM_CONTENT = /^(button|cell|checkbox|columnheader|gridcell|heading|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|rowheader|switch|tab|tooltip|treeitem)$/;
  function axImplicit(n) {
    var t = n.localName;
    if (n.namespaceURI !== HTML_NS) return t === 'svg' && (n.getAttribute('aria-label') || n.getAttribute('aria-labelledby')) ? 'img' : '';
    switch (t) {
      case 'a': case 'area': return n.hasAttribute('href') ? 'link' : '';
      case 'button': case 'summary': return 'button';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'img': return n.getAttribute('alt') === '' ? '' : 'img';
      case 'input':
        var ty = n.type;
        if (ty === 'hidden') return '';
        if (/^(button|submit|reset|image)$/.test(ty)) return 'button';
        if (ty === 'checkbox') return n.hasAttribute('switch') ? 'switch' : 'checkbox';
        if (ty === 'radio') return 'radio';
        if (ty === 'range') return 'slider';
        if (ty === 'number') return 'spinbutton';
        if (/^(color|file|date|time|datetime-local|month|week)$/.test(ty)) return ty === 'file' ? 'button' : 'textbox';
        return n.hasAttribute('list') ? 'combobox' : 'textbox';
      case 'textarea': return 'textbox';
      case 'select': return n.multiple || n.size > 1 ? 'listbox' : 'combobox';
      case 'option': return 'option';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return axInSection(n) ? '' : 'banner';
      case 'footer': return axInSection(n) ? '' : 'region';
      case 'aside': return 'region';
      case 'section': return axHasName(n) ? 'region' : '';
      case 'form': return axHasName(n) ? 'form' : '';
      case 'article': case 'fieldset': case 'details': case 'figure': case 'blockquote': return 'group';
      case 'dialog': return 'dialog';
      case 'p': return 'paragraph';
      case 'hr': return 'separator';
      case 'table': return 'table';
      case 'thead': case 'tbody': case 'tfoot': return 'rowgroup';
      case 'tr': return 'row';
      case 'td': return axGridTable(n) ? 'gridcell' : 'cell';
      case 'th': var sc = n.getAttribute('scope'); return sc === 'row' || sc === 'rowgroup' ? 'rowheader' : 'columnheader';
      case 'progress': case 'meter': return 'progressbar';
      case 'output': return 'status';
    }
    return '';
  }
  function axInSection(n) { for (var p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) if (/^(article|aside|main|nav|section)$/.test(p.localName)) return true; return false; }
  function axHasName(n) { return !!(n.getAttribute('aria-label') || n.getAttribute('aria-labelledby') || n.getAttribute('title')); }
  function axGridTable(n) { for (var p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.localName === 'table') { var r = (p.getAttribute('role') || '').trim(); return r === 'grid' || r === 'treegrid'; } return false; }
  function axRoleOf(n) {
    var ra = n.getAttribute('role');
    if (ra === null && n._internals && n._internals.role) ra = String(n._internals.role);
    if (ra !== null) {
      var toks = ra.trim().toLowerCase().split(/\s+/);
      for (var i = 0; i < toks.length; i++) {
        var r = toks[i];
        // (none/presentation is ignored on a focusable element, ARIA 9.2)
        if (r === 'none' || r === 'presentation') { if (focusableByDefault(n) || n.hasAttribute('tabindex')) continue; return ''; }
        if (r === 'generic') return '';
        if (AX_ROLES.test(r)) return r;
        if (AX_ALIAS[r]) return AX_ALIAS[r];
      }
    }
    return axImplicit(n);
  }
  function axAttr(n, a) {
    var v = n.getAttribute(a);
    if (v === null && n._internals) { var p = 'aria' + a.slice(5).replace(/(^|-)([a-z])/g, function (m, d, c) { return c.toUpperCase(); }); var iv = n._internals[p]; if (iv !== null && iv !== undefined) v = String(iv); }
    return v;
  }
  function axHidden(n) {
    if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden') && n.getAttribute('hidden') !== 'until-found') return true;
    var cs = computedOf(n);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }
  function axSquash(t) { return t.replace(/\s+/g, ' ').trim(); }
  // the text of an element as a name (accname 4.3.2 steps 2B-2G): what
  // it holds, each child by its own name, hidden parts left out
  function axText(n, depth, seen) {
    if (depth > 30) return '';
    var out = '';
    for (var i = 0; i < n._c.length; i++) {
      var k = n._c[i];
      if (k.nodeType === 3) { out += k.data; continue; }
      if (k.nodeType !== 1 || seen.indexOf(k) >= 0) continue;
      if (axHidden(k)) continue;
      var lab = axAttr(k, 'aria-label');
      if (lab && lab.trim()) { out += ' ' + lab + ' '; continue; }
      var t = k.localName;
      if (t === 'img' || (t === 'input' && k.type === 'image') || t === 'area') { out += ' ' + (k.getAttribute('alt') || '') + ' '; continue; }
      if (t === 'input' || t === 'textarea') { out += ' ' + (k.type === 'password' ? '' : /^(checkbox|radio)$/.test(k.type) ? '' : k.value) + ' '; continue; }
      if (t === 'select') { out += ' ' + (k.selectedOptions && k.selectedOptions[0] ? k.selectedOptions[0].text : '') + ' '; continue; }
      if (t === 'script' || t === 'style' || t === 'template') continue;
      // (a slot: what is assigned to it, else its own content)
      if (t === 'slot' && shadowRootOf(k)) { var fl = flatten(k, []), ft = ''; for (var fi = 0; fi < fl.length; fi++) ft += fl[fi].nodeType === 3 ? fl[fi].data : fl[fi].nodeType === 1 && !axHidden(fl[fi]) ? ' ' + axText(fl[fi], depth + 1, seen) + ' ' : ''; out += ft; continue; }
      var cs = computedOf(k), inl = !cs.display || /^inline/.test(cs.display) || cs.display === 'contents';
      var bt = k._sr ? axText(k._sr, depth + 1, seen) : axText(k, depth + 1, seen);
      out += inl ? bt : ' ' + bt + ' ';
    }
    return out;
  }
  function axRefs(n, attr) {
    var ids = (n.getAttribute(attr) || '').trim();
    if (!ids) return '';
    var root = n.getRootNode ? n.getRootNode() : doc, out = [];
    ids.split(/\s+/).forEach(function (id) {
      var e = root.getElementById ? root.getElementById(id) : doc.getElementById(id);
      if (!e) return;
      var l = axAttr(e, 'aria-label');
      out.push(l && l.trim() ? l : axSquash(axText(e, 0, [n])));
    });
    return axSquash(out.join(' '));
  }
  function axLabelText(n) {
    // <label for=id> and an enclosing <label>, the control's own text left out
    var out = [];
    var id = n.getAttribute('id'), root = n.getRootNode ? n.getRootNode() : doc;
    if (id && root.querySelectorAll) { var ls = root.querySelectorAll('label[for]'); for (var i = 0; i < ls.length; i++) if (ls[i].getAttribute('for') === id) out.push(axText(ls[i], 0, [n])); }
    for (var p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.localName === 'label' && !p.hasAttribute('for')) { out.push(axText(p, 0, [n])); break; }
    return axSquash(out.join(' '));
  }
  function axName(n, role) {
    var v = axRefs(n, 'aria-labelledby');
    if (v) return v;
    v = axAttr(n, 'aria-label');
    if (v && v.trim()) return axSquash(v);
    var t = n.localName;
    if (t === 'input' || t === 'textarea' || t === 'select' || t === 'meter' || t === 'progress' || t === 'output') {
      if (t === 'input' && /^(button|submit|reset)$/.test(n.type)) return n.value || (n.type === 'submit' ? 'Submit' : n.type === 'reset' ? 'Reset' : '');
      if (t === 'input' && n.type === 'image') return n.getAttribute('alt') || 'Submit';
      v = axLabelText(n);
      if (v) return v;
    }
    if (t === 'img' || t === 'area') { v = n.getAttribute('alt'); if (v) return axSquash(v); }
    if (t === 'fieldset' || t === 'figure' || t === 'table') {
      var cap = t === 'fieldset' ? 'legend' : t === 'figure' ? 'figcaption' : 'caption';
      for (var i = 0; i < n._c.length; i++) if (n._c[i].localName === cap) return axSquash(axText(n._c[i], 0, []));
    }
    if (t === 'svg') { for (var j = 0; j < n._c.length; j++) if (n._c[j].localName === 'title') return axSquash(n._c[j].textContent); }
    if (AX_FROM_CONTENT.test(role)) { v = axSquash(axText(n._sr || n, 0, [])); if (v) return v.length > 400 ? v.slice(0, 400) : v; }
    v = n.getAttribute('title');
    if (v && v.trim()) return axSquash(v);
    if ((role === 'textbox' || role === 'combobox' || role === 'spinbutton') && n.getAttribute('placeholder')) return axSquash(n.getAttribute('placeholder'));
    return '';
  }
  function axTri(v) { return v === 'true' ? 2 : v === 'false' ? 1 : v === 'mixed' ? 3 : 0; }
  // the render tree's `ax` for an element, or null (no role, nothing to say)
  function axOf(n) {
    if (n.getAttribute('aria-hidden') === 'true') return { h: 1 };
    var role = axRoleOf(n), o = null;
    if (!role) {
      // static text: a box with text of its own and no role, outside a
      // role that is named by its content (it is that role's name already)
      var own = '';
      for (var i = 0; i < n._c.length; i++) if (n._c[i].nodeType === 3) own += n._c[i].data;
      if (!own.trim()) return null;
      for (var p = composedParent(n); p && p.nodeType === 1; p = composedParent(p)) {
        var pr = axRoleOf(p);
        if (pr && AX_FROM_CONTENT.test(pr)) return null;
        if (pr) break;
      }
      return { r: 'text', n: axSquash(own).slice(0, 2000) };
    }
    o = { r: role };
    var nm = axName(n, role);
    // (a paragraph's or list item's text as its name: EVG's tree has no
    // static text under a role, so what it holds is said as its name)
    if (!nm && (role === 'paragraph' || role === 'listitem')) { nm = axSquash(axText(n, 0, [])); if (nm.length > 2000) nm = nm.slice(0, 2000); }
    if (nm) o.n = nm;
    var ds = axRefs(n, 'aria-describedby') || axAttr(n, 'aria-description') || (nm !== axSquash(n.getAttribute('title') || '') ? axSquash(n.getAttribute('title') || '') : '');
    if (ds) o.d = ds;
    var t = n.localName;
    // states
    var ch = axTri(axAttr(n, 'aria-checked'));
    if (t === 'input' && (n.type === 'checkbox' || n.type === 'radio')) ch = n.indeterminate ? 3 : n.checked ? 2 : 1;
    else if (!ch && /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role)) ch = 1;
    if (ch) o.ck = ch;
    var pr2 = axTri(axAttr(n, 'aria-pressed')); if (pr2 && role === 'button') o.pr = pr2;
    var ex = axTri(axAttr(n, 'aria-expanded'));
    if (t === 'details') ex = n.open ? 2 : 1;
    else if (t === 'summary' && n.parentNode && n.parentNode.localName === 'details') ex = n.parentNode.open ? 2 : 1;
    if (ex) o.ex = ex;
    var se = axTri(axAttr(n, 'aria-selected'));
    if (t === 'option') se = n.selected ? 2 : 1;
    if (se === 2) o.se = 2;
    if (n.disabled || axAttr(n, 'aria-disabled') === 'true') o.di = 1;
    if (focusableByDefault(n) || n.hasAttribute('tabindex')) o.fo = 1;
    if ((t === 'dialog' && n._modal) || axAttr(n, 'aria-modal') === 'true') o.mo = 1;
    var lv = parseInt(axAttr(n, 'aria-level'), 10);
    if (!(lv > 0) && role === 'heading' && /^h[1-6]$/.test(t)) lv = +t.charAt(1);
    if (!(lv > 0) && role === 'heading') lv = 2;
    if (lv > 0) o.lv = lv;
    var hp = axAttr(n, 'aria-haspopup'); if (hp && hp !== 'false') o.hp = hp === 'true' ? 'menu' : hp;
    if (t === 'select' && role === 'combobox') o.hp = 'listbox';
    var cu = axAttr(n, 'aria-current'); if (cu && cu !== 'false') o.cu = cu;
    if (n.required || axAttr(n, 'aria-required') === 'true') o.rq = 1;
    if (axAttr(n, 'aria-invalid') && axAttr(n, 'aria-invalid') !== 'false') o.iv = 1;
    if (n.readOnly || axAttr(n, 'aria-readonly') === 'true') o.ro = 1;
    var or = axAttr(n, 'aria-orientation'); if (or) o.or = or;
    var rd = axAttr(n, 'aria-roledescription'); if (rd) o.rd = rd;
    var ps = parseInt(axAttr(n, 'aria-posinset'), 10), sz = parseInt(axAttr(n, 'aria-setsize'), 10);
    if (ps > 0) o.ps = ps;
    if (sz > 0) o.sz = sz;
    // value: a field's text, a select's choice, a range's number
    if (role === 'textbox' || role === 'combobox' || role === 'spinbutton') {
      var val = t === 'select' ? (n.selectedOptions && n.selectedOptions[0] ? n.selectedOptions[0].text : '') : (t === 'input' || t === 'textarea') ? (n.type === 'password' ? n.value.replace(/./g, '•') : n.value) : '';
      if (val) o.v = val;
    }
    if (role === 'slider' || role === 'spinbutton' || role === 'progressbar' || role === 'separator' && o.fo) {
      var vn = parseFloat(axAttr(n, 'aria-valuenow')), vmin = parseFloat(axAttr(n, 'aria-valuemin')), vmax = parseFloat(axAttr(n, 'aria-valuemax'));
      if (t === 'input') { vn = parseFloat(n.value); var rb = n.type === 'range' ? rangeBounds(n) : null; if (rb) { vmin = rb[0]; vmax = rb[1]; } }
      if ((t === 'progress' || t === 'meter') && n.hasAttribute('value')) { vn = parseFloat(n.getAttribute('value')); vmin = parseFloat(n.getAttribute('min')) || 0; vmax = parseFloat(n.getAttribute('max')) || 1; }
      if (!isNaN(vn)) o.vn = vn;
      if (!isNaN(vmin) && !isNaN(vmax)) { o.vmin = vmin; o.vmax = vmax; }
      var vt = axAttr(n, 'aria-valuetext'); if (vt) o.v = vt;
    }
    return o;
  }
  // every element's ax in document order, for a host without a view and for
  // tests against Chromium's accessibility tree
  G.__axTree = function () {
    var out = [];
    function walk(n, depth) {
      for (var i = 0; i < n._c.length; i++) {
        var k = n._c[i];
        if (k._attrs === undefined) continue;
        if (axHidden(k)) continue;
        var ax = axOf(k);
        if (ax && ax.h) continue;
        if (ax) { var e = { depth: depth }; for (var q in ax) e[q] = ax[q]; out.push(e); }
        walk(k._sr || k, depth + (ax ? 1 : 0));
      }
    }
    if (doc && doc.body) walk(doc.body, 0);
    return JSON.stringify(out);
  };
  var RENDER_ATTRS = { src: 1, alt: 1, href: 1, placeholder: 1, type: 1, role: 1, 'aria-label': 1, 'aria-hidden': 1, 'aria-expanded': 1, 'aria-selected': 1, 'aria-checked': 1, title: 1, viewBox: 1, d: 1, points: 1, cx: 1, cy: 1, r: 1, rx: 1, ry: 1, x: 1, y: 1, x1: 1, y1: 1, x2: 1, y2: 1, width: 1, height: 1, transform: 1, 'fill-rule': 1, 'clip-rule': 1, 'stroke-linecap': 1, 'stroke-linejoin': 1, tabindex: 1, contenteditable: 1, id: 1, class: 1, style: 1, rows: 1, clear: 1, colspan: 1, rowspan: 1, span: 1 };
  // a grid-lanes container goes to the layout as a grid that says which
  // axis its lanes are across (grid-lanes: column | row, fill-reverse,
  // track-reverse) and its flow-tolerance in px (lanes-tolerance)
  function lanesStyle(cs, s) {
    s.display = cs.display === 'grid-lanes' ? 'grid' : 'inline-grid';
    var gld = String(cs['grid-lanes-direction'] || 'normal').trim().toLowerCase();
    var row = /\brow\b/.test(gld);
    if (!/\b(row|column)\b/.test(gld)) {
      var tc = cs['grid-template-columns'], tr = cs['grid-template-rows'];
      row = /\bcolumn\b/.test(cs['grid-auto-flow'] || '') || ((!tc || tc === 'none') && !!tr && tr !== 'none');
    }
    s['grid-lanes'] = (row ? 'row' : 'column') + (/fill-reverse/.test(gld) ? ' fill-reverse' : '') + (/track-reverse/.test(gld) ? ' track-reverse' : '');
    var ft = String(cs['flow-tolerance'] || 'normal').trim().toLowerCase();
    if (ft === 'infinite') s['lanes-tolerance'] = '1000000';
    else if (/^-?[\d.]+px$/.test(ft)) s['lanes-tolerance'] = String(parseFloat(ft));
    else if (/^0$/.test(ft)) s['lanes-tolerance'] = '0';
    else if (/^[\d.]+r?em$/.test(ft)) s['lanes-tolerance'] = String(parseFloat(ft) * (parseFloat(/rem$/.test(ft) ? rootFontPx() : cs['font-size']) || 16));
    // (grid-lanes-pack: dense packs as grid-auto-flow dense does)
    if (/\bdense\b/.test(String(cs['grid-lanes-pack'] || '')) && !/\bdense\b/.test(String(s['grid-auto-flow'] || ''))) s['grid-auto-flow'] = ((s['grid-auto-flow'] || '') + ' dense').trim();
    delete s['grid-lanes-direction'];
    delete s['flow-tolerance'];
    delete s['grid-lanes-pack'];
  }
  // a text in small-caps (font-variant, CSS Fonts 3 6.5): with no
  // small-caps glyphs in the face, lower-case letters are drawn as capitals
  // at 0.7 of the size, to the whole pixel, as Chromium synthesizes them
  // white-space: pre-line (CSS Text 3 4.1): spaces collapse, a newline
  // is a forced break; the text as pieces with a line break between
  function preLineParts(id, t) {
    var lines = t.replace(/[ \t]*\n[ \t]*/g, '\n').split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) out.push({ i: id + 'pl' + i, t: 'br', s: {} });
      if (lines[i]) out.push({ i: id + 'px' + i, x: lines[i] });
    }
    return out;
  }
  function smallCapsText(n, parentStyle) {
    var t = transformed(n._data, parentStyle);
    if (parentStyle && parentStyle['white-space'] === 'pre-line' && t.indexOf('\n') >= 0)
      return { i: n.__id, t: 'span', s: { display: 'inline' }, c: preLineParts(n.__id, t) };
    var fv = parentStyle && (parentStyle['font-variant-caps'] || parentStyle['font-variant']);
    if (!fv || !/small-caps/.test(fv) || !/\p{Ll}/u.test(t)) return { i: n.__id, x: t };
    var px = parseFloat(parentStyle['font-size']) || 16;
    var parts = [], re = /(\p{Ll}+)|([^\p{Ll}]+)/gu, m, k = 0;
    while ((m = re.exec(t))) {
      var id = n.__id + 'sc' + (k++);
      if (m[1]) parts.push({ i: id, t: 'span', s: { display: 'inline', 'font-size': Math.round(px * 0.7) + 'px' }, c: [{ i: id + 't', x: m[1].toUpperCase() }] });
      else parts.push({ i: id, x: m[2] });
    }
    return { i: n.__id, t: 'span', s: { display: 'inline' }, c: parts };
  }
  var SIDES4 = ['top', 'right', 'bottom', 'left'];
  // renderNode's own properties of cs from those of the style it was made
  // from (diffFrom): false when a changed one is one the loop there does
  // more with (a border's colour, an inset shadow)
  function ownFromBase(s, cs, parentStyle, df) {
    var keys = df.keys, b = df.base._own;
    for (var k in keys) if (k === 'color' || k === 'box-shadow' || k.slice(0, 7) === 'border-' || k.charAt(0) === '_') return false;
    for (var bk in b) s[bk] = b[bk];
    for (var k2 in keys) {
      var v = cs[k2];
      delete s[k2];
      if (v === undefined) continue;
      if (INHERITED[k2] && parentStyle && parentStyle[k2] === v) continue;
      if (!INHERITED[k2] && INITIAL[k2] === v) continue;
      s[k2] = typeof v === 'string' && v.charCodeAt(0) === 99 && v.slice(0, 5) === 'calc(' ? flatCalc(v) : v;
    }
    return true;
  }
  function renderNode(n, parentStyle, asJson) {
    if (n.nodeType === 3) {
      if (!n._data) return null;
      return smallCapsText(n, parentStyle);
    }
    if (n.nodeType !== 1) return null;
    // (a box of the top layer is rendered at the end of the root's, render)
    if (n._top && n !== topNow) return null;
    var cs = computedOf(n);
    if (cs.display === 'none' || cs.display === 'contents' && !flatKids(n).length) return null;
    // a collapsed table row or row group takes no room (CSS 2.1 17.5.5)
    if (cs.visibility === 'collapse' && /^table-(row|row-group|header-group|footer-group)$/.test(cs.display)) return null;
    // a collapsed column takes no room either, nor the cells wholly in it
    if (cs.visibility === 'collapse' && cs.display === 'table-column') return null;
    if (cs.display === 'table-column-group' && cs.visibility === 'collapse') return null;
    n._colCut = 0;
    if (cs.display === 'table-cell') { var cut = collapsedSpan(n); if (cut === 0) return null; if (cut > 0) n._colCut = cut; }
    var o = { i: n.__id, t: n.namespaceURI === SVG_NS ? 'svg:' + n.localName : n.localName };
    // what of cs differs from the parent's (inherited) and the initial
    // values: found once for a style and the parent style it is under
    // (shared styles: a table's rows and cells), copied for this element
    var s = {}, base = cs._own && cs._ownPs === parentStyle ? cs._own : null, df = cs._dfrom;
    if (base) { for (var bk in base) s[bk] = base[bk]; }
    else if (df && df.base._own && df.base._ownPs === parentStyle && ownFromBase(s, cs, parentStyle, df)) {
      var own0 = {};
      for (var ok0 in s) own0[ok0] = s[ok0];
      Object.defineProperty(cs, '_own', { value: own0, enumerable: false, configurable: true, writable: true });
      Object.defineProperty(cs, '_ownPs', { value: parentStyle, enumerable: false, configurable: true, writable: true });
    }
    else {
      for (var k in cs) {
        if (k.charAt(0) === '_') continue;
        var v = cs[k];
        if (INHERITED[k] && parentStyle && parentStyle[k] === v) continue;
        if (!INHERITED[k] && INITIAL[k] === v) continue;
        s[k] = typeof v === 'string' && v.charCodeAt(0) === 99 && v.slice(0, 5) === 'calc(' ? flatCalc(v) : v;
      }
      // (a border with no colour of its own is in the element's colour)
      if (cs.color) for (var sdi = 0; sdi < 4; sdi++) {
        var sd = SIDES4[sdi], bst = s['border-' + sd + '-style'], bco = s['border-' + sd + '-color'];
        if (bst && bst !== 'none' && bst !== 'hidden' && (!bco || bco === 'currentcolor')) s['border-' + sd + '-color'] = cs.color;
      }
      // an inset shadow with no offset or blur and a spread past any box
      // (Bootstrap's striped and hovered cells: inset 0 0 0 9999px) fills
      // the padding box over the background: the host draws no shadows, so
      // it is the background it makes
      if (s['box-shadow'] && s['box-shadow'].indexOf('inset') >= 0) insetFill(s);
      // the outer layers as the host draws them: rings and one drop shadow
      if (s['box-shadow'] && s['box-shadow'] !== 'none') shadowLayers(s, cs.color);
      var own = {};
      for (var ok in s) own[ok] = s[ok];
      Object.defineProperty(cs, '_own', { value: own, enumerable: false, configurable: true, writable: true });
      Object.defineProperty(cs, '_ownPs', { value: parentStyle, enumerable: false, configurable: true, writable: true });
    }
    o.s = s;
    // the individual transforms (translate, rotate, scale) before the
    // transform list, CSS Transforms 2, 6.1: the host takes one list
    if ((cs.translate && cs.translate !== 'none') || (cs.rotate && cs.rotate !== 'none') || (cs.scale && cs.scale !== 'none')) s.transform = individualTransforms(n, cs);
    // (a top layer box's static position is the initial containing block's
    // start corner in the root's writing mode, CSS Position 3, 4.1)
    if (n._top && (cs.position === 'absolute' || cs.position === 'fixed') && ['top', 'right', 'bottom', 'left'].every(function (k) { return !cs[k] || cs[k] === 'auto'; })) {
      var rcs = computedOf(doc.documentElement), rwm = rcs['writing-mode'] || 'horizontal-tb', rtl = rcs.direction === 'rtl';
      var bs = /^(vertical-rl|sideways-rl|tb-rl|tb)$/.test(rwm) ? 'right' : /^(vertical-lr|sideways-lr)$/.test(rwm) ? 'left' : 'top';
      var is = bs === 'top' ? (rtl ? 'right' : 'left') : rwm === 'sideways-lr' ? (rtl ? 'top' : 'bottom') : (rtl ? 'bottom' : 'top');
      s[bs] = '0px'; s[is] = '0px';
    }
    // (the root's first body child gives its overflow to the viewport when
    // the root's is visible, and is visible itself, CSS Overflow 3, 3.3)
    if (n.localName === 'body' && n.parentNode && n.parentNode.localName === 'html' && n.parentNode.parentNode && n.parentNode.parentNode.nodeType === 9 && (s['overflow-x'] || s['overflow-y'])) {
      var rootCs = computedOf(n.parentNode), firstBody = null;
      for (var bi = 0; bi < n.parentNode._c.length && !firstBody; bi++) if (n.parentNode._c[bi].localName === 'body') firstBody = n.parentNode._c[bi];
      if (firstBody === n && (rootCs['overflow-x'] || 'visible') === 'visible' && (rootCs['overflow-y'] || 'visible') === 'visible') { delete s['overflow-x']; delete s['overflow-y']; }
    }
    if (/^(inline-)?grid-lanes$/.test(cs.display)) lanesStyle(cs, s);
    // (width does not apply to rows and row groups, height not to columns
    // and column groups, CSS 2 10.2 and 10.5)
    var tblBox = (!cs.float || cs.float === 'none') && cs.position !== 'absolute' && cs.position !== 'fixed' && !(parentStyle && /flex|grid/.test(parentStyle.display || ''));
    if (!tblBox) {}
    else if (/^table-(row|row-group|header-group|footer-group)$/.test(cs.display)) { delete s.width; delete s['min-width']; delete s['max-width']; }
    else if (/^table-column(-group)?$/.test(cs.display)) { delete s.height; delete s['min-height']; delete s['max-height']; }
    // a text field with an auto width is as wide as its size (20) in
    // characters, as Chromium measures them: 0.6em each and 1.275em more
    // (0.75em more in a monospace font), in a line only: a flex or grid
    // item and a positioned field keep stretching
    if (n.localName === 'input' && (!cs.width || cs.width === 'auto') && cs.display === 'inline-block' && /^(text|search|tel|url|email|password|number)$/.test(n.type) &&
        (!cs.position || cs.position === 'static' || cs.position === 'relative') && !(parentStyle && /flex|grid/.test(parentStyle.display || ''))) {
      var fsz = parseFloat(cs['font-size']) || 13.333, fsize = parseInt(n.getAttribute('size'), 10);
      if (!(fsize > 0)) fsize = 20;
      var fw = fsz * (0.6 * fsize + (/monospace/.test(cs['font-family'] || '') ? 0.75 : 1.275));
      if (cs['box-sizing'] === 'border-box') fw += (parseFloat(cs['padding-left']) || 0) + (parseFloat(cs['padding-right']) || 0) + (parseFloat(cs['border-left-width']) || 0) + (parseFloat(cs['border-right-width']) || 0);
      s.width = (Math.round(fw * 100) / 100) + 'px';
    }
    // (a percentage-wide text field in a flex row that is itself as wide
    // as its content: the row's width is the field's size in characters,
    // which the percentage then fills, Bootstrap's navbar search)
    else if (n.localName === 'input' && /%$/.test(cs.width || '') && /^(text|search|tel|url|email|password|number)$/.test(n.type) && parentStyle && /^(inline-)?flex$/.test(parentStyle.display || '') &&
        (!parentStyle.width || parentStyle.width === 'auto') && !/column/.test(parentStyle['flex-direction'] || '') && (!cs['min-width'] || cs['min-width'] === 'auto')) {
      var fsz2 = parseFloat(cs['font-size']) || 13.333, fsize2 = parseInt(n.getAttribute('size'), 10);
      if (!(fsize2 > 0)) fsize2 = 20;
      var fw2 = fsz2 * (0.6 * fsize2 + (/monospace/.test(cs['font-family'] || '') ? 0.75 : 1.275));
      if (cs['box-sizing'] === 'border-box') fw2 += (parseFloat(cs['padding-left']) || 0) + (parseFloat(cs['padding-right']) || 0) + (parseFloat(cs['border-left-width']) || 0) + (parseFloat(cs['border-right-width']) || 0);
      s['min-width'] = (Math.round(fw2 * 100) / 100) + 'px';
    }
    var a = null;
    for (var i = 0; i < n._attrs.length; i++) {
      var an = n._attrs[i].name;
      // (data-expected-* and data-offset-*: WPT check-layout's answers, which
      // css-layout.mjs checks a page Chromium cannot lay out against)
      if (RENDER_ATTRS[an] || an.slice(0, 5) === 'data-' && (an === 'data-testid' || /^data-(expected|offset)-/.test(an))) { if (!a) a = {}; a[an] = n._attrs[i]._v; }
    }
    if (n.localName === 'input' || n.localName === 'textarea' || n.localName === 'select') {
      if (!a) a = {};
      a.value = n.localName === 'select' ? (n.selectedOptions[0] ? n.selectedOptions[0].text : '') : n.type === 'password' ? n.value.replace(/./g, '\u2022') : n.value;
      if (n.type === 'checkbox' || n.type === 'radio') a.checked = n.checked;
      if (n.disabled) a.disabled = true;
      // the text before the caret, and before each end of the selection,
      // where the host draws them (prefixes: the host counts its own units)
      // what Chromium shows for the types it draws itself (en-US): a
      // date's own format, a range's thumb, a file's button text, a
      // list box's options
      if (n.localName === 'input') {
        var ity = n.type;
        if (ity === 'range') { var rgb0 = rangeBounds(n); a.rf = rgb0[1] > rgb0[0] ? (parseFloat(n.value) - rgb0[0]) / (rgb0[1] - rgb0[0]) : 0; }
        else if (/^(date|time|datetime-local|month|week)$/.test(ity)) { a.value = dateShown(ity, n.value); a.picker = ity === 'time' ? 'clock' : 'calendar'; if (!n.value) { a.placeholder = a.value; a.value = ''; } }
        else if (ity === 'file') { var fl0 = n._files || []; a.value = fl0.length ? (fl0.length === 1 ? fl0[0].name : fl0.length + ' files') : 'No file chosen'; }
      }
      if (n.localName === 'select' && (n.multiple || n.size > 1)) a.opts = n.options.map(function (o) { return [o.text, o.selected ? 1 : 0]; });
      if (doc && doc._active === n && isTextControl(n) && !/^(date|time|datetime-local|month|week)$/.test(n.type) && !(n.readOnly && n._ss === n._se)) {
        var ss = Math.min(n._ss, a.value.length), se = Math.min(n._se, a.value.length);
        a.caret = a.value.slice(0, n._sd === 'backward' ? ss : se);
        if (ss < se) a.sel = [a.value.slice(0, ss), a.value.slice(0, se)];
      }
    }
    if (n.localName === 'button' && n.disabled) { if (!a) a = {}; a.disabled = true; }
    if (doc && doc._active === n) { if (!a) a = {}; a.focused = true; }
    // (a cell over collapsed columns spans only the others; one wholly
    // in them is dropped above)
    if (cs.display === 'table-cell' && n._colCut) { if (!a) a = {}; a.colspan = String(n._colCut); }
    if (a) o.a = a;
    var ax = axOf(n);
    if (ax) o.ax = ax;
    if (n._ia) o.ia = 1;
    if (n.scrollTop || n.scrollLeft) o.sc = [n.scrollLeft, n.scrollTop];
    if (o.t === 'svg:svg') {
      // an inline picture: its markup, drawn by the host's SVG painter,
      // with currentColor as the element's color
      o.svg = serializeSvg(n, true);
      svgTexts(n, o);
      return o;
    }
    // a picture an <object> or <embed> shows, or an <img>'s <picture>
    // source: drawn as an <img> (the fallback content is not)
    var picUrl = null;
    if ((n.localName === 'object' || n.localName === 'embed') && n.namespaceURI === HTML_NS) {
      var du = n.getAttribute(n.localName === 'object' ? 'data' : 'src');
      if (du && /^data:image\//i.test(du.trim())) picUrl = du.trim();
    }
    if (n.localName === 'img' && (!a || !a.src) && n.parentNode && n.parentNode.localName === 'picture') {
      for (var pi = 0; pi < n.parentNode._c.length && !picUrl; pi++) {
        var ps = n.parentNode._c[pi];
        if (ps === n) break;
        if (ps.nodeType !== 1 || ps.localName !== 'source') continue;
        var sset = (ps.getAttribute('srcset') || '').trim().split(/\s*,\s+|\s+/)[0];
        if (sset && /^data:image\//i.test(sset)) picUrl = sset;
      }
    }
    if (picUrl) { if (!a) a = {}; a.src = picUrl; o.t = 'img'; }
    var isImg = o.t === 'img';
    if (isImg && a && a.src) a.src = resolveURL(a.src);
    // an SVG picture as a data: URL: its shapes' lengths in % of the
    // viewBox (else the root's size), which the host's SVG parser does not
    // resolve
    if (isImg && a && typeof a.src === 'string' && /^data:image\/svg\+xml/i.test(a.src)) a.src = svgUrlPercents(a.src);
    // a PNG in a data: URL (mfiles:three's frames) is drawn as a canvas's
    // pixels are: the picture goes in "png", the window decodes it once
    if (isImg && a && typeof a.src === 'string' && a.src.indexOf('data:image/png;base64,') === 0) { o.png = a.src; a.src = 'data:image/png;base64,'; }
    // a .tsx document's <scene3d> the window's page draws on the GPU
    // (desktop/uix/js/tsx.js): the scene's JSON (a string, so a frame's
    // change goes as splices), the size it is drawn at, its textures (the
    // same list from frame to frame, so not sent again)
    if (isImg && n.__s3d) { o.s3d = n.__s3d.j; o.s3w = n.__s3d.w; o.s3h = n.__s3d.h; o.s3t = n.__s3d.t; }
    var kids = [];
    var src = n.localName === 'template' || picUrl ? [] : flatKids(n);
    if (/^(input|textarea|select|img|br|hr|iframe|canvas|video|audio|svg:?)$/.test(n.localName) && n.namespaceURI === HTML_NS) src = n.localName === 'select' ? [] : src;
    if (n.localName === 'canvas' && n.namespaceURI === HTML_NS) {
      // a canvas shows what is drawn on it, not its fallback content
      canvasRender(n, o, cs);
      return o;
    }
    if (n.localName === 'textarea') src = [];
    // (the children far from the viewport, virtWindow, first: their
    // styles are not looked at for the painting order, they are of a
    // signature that is not positioned)
    var vw0 = asJson ? virtWindow(n, cs, src) : null, src0 = src;
    src = paintOrder(src, vw0);
    if (vw0 && src !== src0) { virtDrop(n); vw0 = null; }
    // (a replaced element has no ::before or ::after box)
    var leaf = /^(input|textarea|select|img|br|hr|iframe|video|audio)$/.test(n.localName) || !!picUrl;
    if (cs.display !== 'none') ctrApply(cs, n.parentNode, n);
    var pb = leaf ? null : pseudoBox(n, cs, 'before'), pa = null;
    var pm = leaf ? null : insideMarker(n, cs);
    var fl = leaf || (pb && pb.c) ? null : firstLetter(n, cs, src, 'first-letter') || firstLetter(n, cs, src, 'first-line');
    if (asJson) {
      // the children as JSON text, each from the last render when nothing
      // under it changed since
      // (kdj: the same children as the host is sent them in a delta
      // render, renderDelta: one it has already is only named. Where the
      // children are changed on the way, a table's reordered or wrapped
      // parts, collapsed borders, a split inline, they go whole.)
      var collapsed = deltaOn && cs['border-collapse'] === 'collapse' && /^(inline-)?table$/.test(cs.display);
      var kd = [], kel = [], kdj = deltaOn && !deltaOff && !collapsed ? [] : null, dm0 = marks.length, kn0;
      if (collapsed) deltaOff++;
      if (pm) { kids.push(JSON.stringify(pm)); kd.push(pm.s.display); kel.push(null); }
      if (pb) { kids.push(JSON.stringify(pb)); kd.push(pb.s && pb.s.display); kel.push(null); }
      if (kdj) for (kn0 = 0; kn0 < kids.length; kn0++) kdj.push(kids[kn0]);
      // (the children far from the viewport: runs of them as boxes of
      // their height, virtWindow)
      var vw = vw0, vrun = -1;
      for (var jj = 0; jj < src.length; jj++) {
        if (vw) {
          if (!vw.on[jj]) { if (vrun < 0) vrun = jj; continue; }
          if (vrun >= 0) { kids.push(virtSpacer(vw, vrun, jj)); kd.push(vw.tbl ? 'table-row' : 'block'); kel.push(null); if (kdj) kdj.push(kids[kids.length - 1]); vrun = -1; }
        }
        if (fl && src[jj] === fl.node) { kids.push(JSON.stringify(fl.box)); kd.push(''); kel.push(null); if (kdj) kdj.push(kids[kids.length - 1]); if (fl.rest) { kids.push(JSON.stringify(fl.rest)); kd.push(''); kel.push(null); if (kdj) kdj.push(kids[kids.length - 1]); } if (!fl.zw) continue; }
        var dmk = marks.length;
        var rj = renderJson(src[jj], cs), dj = lastDelta;
        if (rj && (holdsBlock(src[jj]) || rjPseudoBlock(src[jj], rj))) {
          var sp = splitInline(JSON.parse(rj));
          unmark(dmk);
          for (var sq = 0; sq < sp.length; sq++) { kids.push(JSON.stringify(sp[sq])); kd.push(sp[sq].s.display); kel.push(null); if (kdj) kdj.push(kids[kids.length - 1]); }
          continue;
        }
        if (rj) { kids.push(rj); kd.push(kidDisplay(src[jj])); kel.push(src[jj]); if (kdj) kdj.push(dj); }
      }
      if (vw && vrun >= 0) { kids.push(virtSpacer(vw, vrun, src.length)); kd.push(vw.tbl ? 'table-row' : 'block'); kel.push(null); if (kdj) kdj.push(kids[kids.length - 1]); }
      if (collapsed) deltaOff--;
      pa = leaf ? null : pseudoBox(n, cs, 'after');
      ctrLeave(n);
      if (pa) { kids.push(JSON.stringify(pa)); kd.push(pa.s && pa.s.display); kel.push(null); if (kdj) kdj.push(kids[kids.length - 1]); }
      if (/^(inline-)?table$/.test(cs.display)) { var ro = groupOrder(kd); kids = ro.map(function (x) { return kids[x]; }); kd = ro.map(function (x) { return kd[x]; }); kel = ro.map(function (x) { return kel[x]; }); kdj = null; }
      var kids0 = kids;
      kids = anonTables(cs.display, kids, kd, o.i, true);
      if (kids !== kids0) { kel = null; kdj = null; }
      if (cs['border-collapse'] === 'collapse' && /^(inline-)?table$/.test(cs.display)) { pjDelta = deltaOn && !deltaOff; kids = collapseTable(o, kids, true, cs.color, kel); pjDelta = false; kdj = collapseDj; collapseDj = null; }
      var own = JSON.stringify(o);
      var kj = kids.join(',');
      if (deltaOn) {
        if (kdj) { renderDj = own.slice(1, -1) + (kids.length ? ',"c":[' + kdj.join(',') + ']}' : '}'); if (kel && !pm && !pb && !pa && !fl) renderOwn = { el: n, own: own, kids: kids, kel: kel, cs: cs, st: null }; }
        else { unmark(dm0); renderDj = null; }
      }
      // (a table part's own members and children, for its table's border
      // collapse: collapseTable takes them instead of parsing the JSON)
      renderParts = cs.display === 'table-cell' ? { o: o, raw: kj } : kel && /^table-(row|row-group|header-group|footer-group)$/.test(cs.display) ? { o: o, kids: kids, kel: kel } : null;
      return kids.length ? own.slice(0, -1) + ',"c":[' + kj + ']}' : own;
    }
    var kd2 = [];
    if (pm) { kids.push(pm); kd2.push(pm.s.display); }
    if (pb) { kids.push(pb); kd2.push(pb.s && pb.s.display); }
    for (var j = 0; j < src.length; j++) {
      if (fl && src[j] === fl.node) { kids.push(fl.box); kd2.push(''); if (fl.rest) { kids.push(fl.rest); kd2.push(''); } if (!fl.zw) continue; }
      var r = renderNode(src[j], cs);
      if (r && (holdsBlock(src[j]) || pseudoBlock(r))) {
        var sp2 = splitInline(r);
        for (var sq2 = 0; sq2 < sp2.length; sq2++) { kids.push(sp2[sq2]); kd2.push(sp2[sq2].s.display); }
        continue;
      }
      if (r) { kids.push(r); kd2.push(kidDisplay(src[j])); }
    }
    pa = leaf ? null : pseudoBox(n, cs, 'after');
    ctrLeave(n);
    if (pa) { kids.push(pa); kd2.push(pa.s && pa.s.display); }
    if (/^(inline-)?table$/.test(cs.display)) { var ro2 = groupOrder(kd2); kids = ro2.map(function (x) { return kids[x]; }); kd2 = ro2.map(function (x) { return kd2[x]; }); }
    kids = anonTables(cs.display, kids, kd2, o.i, false);
    if (cs['border-collapse'] === 'collapse' && /^(inline-)?table$/.test(cs.display)) kids = collapseTable(o, kids, false, cs.color);
    if (kids.length) o.c = kids;
    return o;
  }
  // CSS 2.1 9.2.1.1: an inline box holding an in-flow block-level box (at
  // any depth of inlines) is broken around it: what is before and after
  // are pieces of the inline (the left side on the first, the right on the
  // last), the blocks go in anonymous blocks between them
  var BLOCK_LEVEL = /^(block|list-item|table|flex|grid|flow-root|grid-lanes)$/;
  function holdsBlock(k) {
    if (k.nodeType !== 1 || k.namespaceURI !== HTML_NS) return false;
    var kcs = computedOf(k);
    if (kcs.display !== 'inline' || kcs.position === 'absolute' || kcs.position === 'fixed') return false;
    if (/^(img|input|textarea|select|button|br|iframe|video|audio|canvas|svg)$/.test(k.localName)) return false;
    for (var i = 0; i < k._c.length; i++) {
      var c = k._c[i];
      if (c.nodeType !== 1) continue;
      var ccs = computedOf(c);
      if (ccs.position === 'absolute' || ccs.position === 'fixed' || (ccs.float && ccs.float !== 'none')) continue;
      if (BLOCK_LEVEL.test(ccs.display) || holdsBlock(c)) return true;
    }
    return false;
  }
  // (an inline's ::before or ::after made a block: one at any depth of
  // inlines)
  // a child's JSON holds a block-level ::before or ::after in an inline
  // (pseudoBlock): only an inline can, and the answer is kept with the
  // child's render (the page's tables went through this scan whole, each
  // ancestor of a change, every render)
  function rjPseudoBlock(k, rj) {
    if (k.nodeType !== 1) return false;
    var d = computedOf(k).display;
    // (a `display: contents` box is written as one: not an inline, so
    // pseudoBlock says no; ag-grid's three roots are such, and the whole
    // grid's JSON was parsed for each at every render)
    if (d && d !== 'inline') return false;
    var c = k._rj;
    if (c && c.json === rj) {
      if (c.pbk === undefined) c.pbk = rj.indexOf('"pe":1') >= 0 && pseudoBlock(JSON.parse(rj));
      return c.pbk;
    }
    return rj.indexOf('"pe":1') >= 0 && pseudoBlock(JSON.parse(rj));
  }
  function pseudoBlock(o) {
    if (!o || !o.s || (o.s.display || 'inline') !== 'inline' || !o.c || o.s.position === 'absolute' || o.s.position === 'fixed') return false;
    for (var i = 0; i < o.c.length; i++) {
      var k = o.c[i];
      if (!k.s) continue;
      if (k.pe && BLOCK_LEVEL.test(k.s.display) && !(k.s.position === 'absolute' || k.s.position === 'fixed' || (k.s.float && k.s.float !== 'none'))) return true;
      if ((k.s.display || 'inline') === 'inline' && pseudoBlock(k)) return true;
    }
    return false;
  }
  function splitInline(o) {
    var kids = o.c || [], out = [], run = [], runBlock = null, part = 0, inline = [];
    var isBlock = function (k) { return k.s && BLOCK_LEVEL.test(k.s.display) && !(k.s.position === 'absolute' || k.s.position === 'fixed' || (k.s.float && k.s.float !== 'none')); };
    var flush = function () {
      if (!run.length) return;
      if (runBlock) {
        // (the blocks go in the container's flow as they are, CSS 2.1
        // 9.2.1.1, with what they inherit from the inline and its
        // relative offset; no box of their own around them, so a
        // percentage height and the direction stay the container's)
        var rel = o.s && o.s.position === 'relative';
        for (var r = 0; r < run.length; r++) {
          var bk = run[r], c = {};
          for (var q in bk) c[q] = bk[q];
          c.s = {};
          for (var k in o.s) if (INHERITED[k]) c.s[k] = o.s[k];
          for (var q3 in bk.s) c.s[q3] = bk.s[q3];
          if (rel && (!bk.s.position || bk.s.position === 'static')) {
            c.s.position = 'relative';
            ['top', 'right', 'bottom', 'left'].forEach(function (sd) { if (o.s[sd] !== undefined && bk.s[sd] === undefined) c.s[sd] = o.s[sd]; });
          } else if (rel && bk.s.position === 'relative') {
            // (a relative block in a relative inline moves by both offsets:
            // the inline's go along as rel-top and so on, MfdDomView.relOff)
            ['top', 'right', 'bottom', 'left'].forEach(function (sd) { if (o.s[sd] !== undefined) c.s['rel-' + sd] = o.s[sd]; });
          }
          if (o.s.opacity !== undefined && bk.s.opacity === undefined) c.s.opacity = o.s.opacity;
          out.push(c);
        }
      } else {
        var blank = run.every(function (k) { return k.x !== undefined && /^[ \t\n\r\f]*$/.test(k.x); });
        if (!blank) { var f = {}; for (var q in o) if (q !== 'c') f[q] = o[q]; f.s = {}; for (var q2 in o.s) f.s[q2] = o.s[q2]; f.c = run; f.i = inline.length ? o.i + 'f' + part++ : o.i; inline.push(f); out.push(f); }
      }
      run = [];
    };
    for (var i = 0; i < kids.length; i++) {
      // (a nested inline holding a block is broken first, its pieces in
      // this one's list)
      var pieces = kids[i].s && (kids[i].s.display || 'inline') === 'inline' && !kids[i].x && (kids[i].c || []).some(isBlock) ? splitInline(kids[i]) : [kids[i]];
      for (var p = 0; p < pieces.length; p++) {
        var b = isBlock(pieces[p]);
        if (run.length && b !== runBlock) flush();
        runBlock = b;
        run.push(pieces[p]);
      }
    }
    flush();
    // the left side only on the first piece, the right only on the last
    for (var n = 0; n < inline.length; n++) {
      for (var key in inline[n].s) {
        if (n > 0 && /^(border-left|padding-left|margin-left)/.test(key)) delete inline[n].s[key];
        if (n < inline.length - 1 && /^(border-right|padding-right|margin-right)/.test(key)) delete inline[n].s[key];
      }
    }
    return out;
  }
  // a child's display ('#ws' for a text of white space only)
  function kidDisplay(k) {
    if (k.nodeType === 3) return /^[ \t\n\r\f]*$/.test(k._data || '') ? '#ws' : '';
    return k.nodeType === 1 ? computedOf(k).display : '';
  }
  // CSS 2.1 17.2.1: table cells and rows whose parent is not the table
  // part they belong in are wrapped in anonymous ones (a run of cells in
  // a row, a run of rows in a table); white space between them goes
  var TABLE_IN = /^(table|inline-table|table-row-group|table-header-group|table-footer-group)$/;
  // (row groups, captions and columns outside a table get one too, with
  // the cells and rows around them)
  var TABLE_GROUP = /^table-(row-group|header-group|footer-group|caption|column|column-group)$/;
  // CSS 2.1 17.2: a table's first header group goes before its rows and
  // its first footer group after them (the order of the indices of kd)
  function groupOrder(kd) {
    var h = kd.indexOf('table-header-group'), f = kd.indexOf('table-footer-group');
    var ix = [];
    for (var i = 0; i < kd.length; i++) ix.push(i);
    if (h < 0 && f < 0) return ix;
    var mid = ix.filter(function (i) { return i !== h && i !== f; });
    // (columns and captions stay ahead of the header)
    var lead = 0;
    while (lead < mid.length && /^(#ws|table-column|table-column-group|table-caption)$/.test(kd[mid[lead]])) lead++;
    var outI = mid.slice(0, lead);
    if (h >= 0) outI.push(h);
    outI = outI.concat(mid.slice(lead));
    if (f >= 0) outI.push(f);
    return outI;
  }
  // the collapsing border model (CSS 2.1 17.6.2): each grid line's border
  // is the one that wins the conflict between the cells, rows, row groups,
  // columns, column groups and table along it (17.6.2.1); a cell is given
  // half of each, the table half of its outer ones, and rows, groups and
  // columns draw none of their own
  var BSTYLE_RANK = { double: 8, solid: 7, dashed: 6, dotted: 5, ridge: 4, outset: 3, groove: 2, inset: 1 };
  // a table part's JSON as collapseTable reads it: from its render's parts
  // when that is the render this JSON is (rows and groups by their
  // children, a cell's children kept as JSON text, _raw), else parsed
  var renderParts = null;
  function partsOf(str, el) {
    var c = el && el._rj;
    var p = c && c.json === str ? c.parts : null;
    if (!p) return JSON.parse(str);
    var o = Object.assign({}, p.o);
    Object.defineProperty(o, '_p', { value: p, enumerable: false, writable: true });
    // (a cell: its children are p.raw, JSON text)
    if (p.raw !== undefined) return o;
    // (cw: a row's cells as collapseTable left them untouched, the row
    // having gone out as it did before)
    o.c = p.cw || p.kids.map(function (k, i) { return partsOf(k, p.kel[i]); });
    return o;
  }
  // (pjDelta: a delta render's text of the same part is left in pjLast. A
  // row with its borders settled is a numbered part of its own: one that
  // came out as the host has it is only named, so a change in one row of a
  // table with collapsed borders sends that row and not the table. A
  // table's 1000 rows went whole for one row's class.)
  var pjDelta = false, pjLast = '', collapseDj = null;
  function rowDelta(p, out) {
    if (!p) return out;
    var f = p.fin;
    if (!f || f.de !== deltaEpoch || f.json !== out) f = p.fin = { json: out, n: ++deltaSerial, sent: 0, de: deltaEpoch, dj: null };
    deltaOf(f);
    return lastDelta;
  }
  function partsJson(o) {
    var p = o._p, rw = p ? p.raw : undefined;
    if (rw === undefined) {
      if (o._cmOut !== undefined) { pjLast = pjDelta ? rowDelta(p, o._cmOut) : o._cmOut; return o._cmOut; }
      if (!o.c || !o.c.length || typeof o.c[0] !== 'object') { var j0 = JSON.stringify(o); pjLast = j0; return j0; }
      var cs0 = o.c; delete o.c;
      // (a row or group's own members are stripped of borders the same way
      // each time its parts are the same)
      var own = p ? p.ownJson || (p.ownJson = JSON.stringify(o)) : JSON.stringify(o);
      if (!pjDelta) { var nj = own.slice(0, -1) + ',"c":[' + cs0.map(partsJson).join(',') + ']}'; if (o._cmRec) o._cmRec.out = nj; return nj; }
      if (o.s && o.s.display === 'table-row') {
        pjDelta = false;
        var rj = own.slice(0, -1) + ',"c":[' + cs0.map(partsJson).join(',') + ']}';
        pjDelta = true;
        if (o._cmRec) o._cmRec.out = rj;
        pjLast = rowDelta(p, rj);
        return rj;
      }
      // (a row group is numbered too: the host takes the parts under a
      // numbered one only)
      var js = [], ds = [], dm = marks.length;
      for (var i = 0; i < cs0.length; i++) { js.push(partsJson(cs0[i])); ds.push(pjLast); }
      var gj = own.slice(0, -1) + ',"c":[' + js.join(',') + ']}';
      if (!p) { unmark(dm); pjLast = gj; return gj; }
      var f = p.fin;
      if (!f || f.de !== deltaEpoch || f.json !== gj) f = p.fin = { json: gj, n: ++deltaSerial, sent: 0, de: deltaEpoch, dj: null };
      if (f.sent === deltaEpoch) { unmark(dm); pjLast = '{"r":' + f.n + '}'; }
      else { f.dj = '{"n":' + f.n + ',' + own.slice(1, -1) + ',"c":[' + ds.join(',') + ']}'; deltaOf(f); pjLast = lastDelta; }
      return gj;
    }
    if (p && o._key !== undefined && p.clKey === o._key) { pjLast = p.clOut; return p.clOut; }
    var extra = o.c; if (extra) delete o.c;
    var own2 = JSON.stringify(o);
    var raw = rw + (extra && extra.length ? (rw ? ',' : '') + extra.map(function (k) { return JSON.stringify(k); }).join(',') : '');
    var out = raw ? own2.slice(0, -1) + ',"c":[' + raw + ']}' : own2;
    if (p && o._key !== undefined) { p.clKey = o._key; p.clOut = out; }
    pjLast = out;
    return out;
  }
  function collapseTable(tbl, kids, json, tcolor, kel) {
    var objs = kids.map(function (k, i) { return typeof k === 'string' ? partsOf(k, kel && kel[i]) : k; });
    var rows = [], cols = [];
    collapseDj = null;
    var colOf = function (c, grp) { var n = Math.max(1, parseInt(c.a && c.a.span, 10) || 1); for (var q = 0; q < n; q++) cols.push({ col: c, grp: grp }); };
    objs.forEach(function (k) {
      var d = k.s && k.s.display;
      if (d === 'table-row') rows.push({ row: k, grp: null });
      else if (/^table-(row|header|footer)-group$/.test(d)) (k.c || []).forEach(function (r) { if (r.s && r.s.display === 'table-row') rows.push({ row: r, grp: k }); });
      else if (d === 'table-column') colOf(k, null);
      else if (d === 'table-column-group') { var any = false; (k.c || []).forEach(function (c) { if (c.s && c.s.display === 'table-column') { colOf(c, k); any = true; } }); if (!any) colOf(k, k); }
    });
    if (!rows.length) return kids;
    // A table with no columns and no cell that spans rows (lazy): a row's
    // cells are at the columns its own cells give (ci, kept with the row's
    // parts), and only the rows whose borders are settled again, and the
    // ones next to them, have their cells put in the grid (need). A table
    // of 1 000 rows went through its 4 000 cells five times for one
    // row's change.
    var lazy = !!json && !cols.length;
    for (var li = 0; li < rows.length && lazy; li++) {
      var lr = rows[li], lp = lr.row._p, inf = lp && lp.ci;
      if (!inf) {
        inf = { n: 0, w: 0, span: false, at: [], c: [], cs: [] };
        var lc = lr.row.c || [];
        for (var lk = 0; lk < lc.length; lk++) {
          var lo = lc[lk];
          if (!lo.s || lo.s.display !== 'table-cell') continue;
          var lcs = Math.max(1, parseInt(lo.a && lo.a.colspan, 10) || 1);
          if ((parseInt(lo.a && lo.a.rowspan, 10) || 1) > 1) inf.span = true;
          inf.at.push(lk); inf.c.push(inf.w); inf.cs.push(lcs); inf.w += lcs; inf.n++;
        }
        if (lp) lp.ci = inf;
      }
      if (inf.span) lazy = false;
      lr.info = inf;
    }
    // the grid: which cell is at each slot
    var grid = [], cells = [], anySpan = false;
    var need = function (ri) {
      var r = rows[ri];
      if (!r || r.cells) return r ? r.cells : null;
      var ni = r.info, rc = r.row.c, out = [], g = [];
      for (var k = 0; k < ni.n; k++) {
        var cell = { o: rc[ni.at[k]], r: ri, c: ni.c[k], rs: 1, cs: ni.cs[k], rowo: r, k: k };
        out.push(cell);
        for (var x = 0; x < cell.cs; x++) g[cell.c + x] = cell;
      }
      grid[ri] = g; r.cells = out;
      return out;
    };
    if (!lazy) rows.forEach(function (r, ri) {
      r.n = 0; r.m = null; r.ok = false;
      grid[ri] = grid[ri] || [];
      var ci = 0;
      (r.row.c || []).forEach(function (c) {
        if (!c.s || c.s.display !== 'table-cell') return;
        while (grid[ri][ci]) ci++;
        var cs = Math.max(1, parseInt(c.a && c.a.colspan, 10) || 1), rs = Math.max(1, parseInt(c.a && c.a.rowspan, 10) || 1);
        rs = Math.min(rs, rows.length - ri);
        var cell = { o: c, r: ri, c: ci, rs: rs, cs: cs, rowo: r, k: r.n++ };
        if (rs > 1) anySpan = true;
        cells.push(cell);
        for (var y = 0; y < rs; y++) { grid[ri + y] = grid[ri + y] || []; for (var x = 0; x < cs; x++) grid[ri + y][ci + x] = cell; }
        ci += cs;
      });
    });
    var ncols = 0; grid.forEach(function (g) { if (g.length > ncols) ncols = g.length; });
    if (lazy) for (var lz = 0; lz < rows.length; lz++) { var lzr = rows[lz]; lzr.n = lzr.info.n; lzr.m = null; lzr.ok = false; lzr.cells = null; if (lzr.info.w > ncols) ncols = lzr.info.w; }
    var colorOf = function (o, inh) { return (o && o.s && o.s.color) || inh; };
    var side = function (o, sd, rank, inh) {
      var s = (o && o.s) || null;
      // (kept on the style object: a row's or cell's from its render's
      // parts is the same one from render to render)
      var memo = s && s._sides, mk = sd + '|' + inh;
      var m = memo && memo[mk];
      if (!m) {
        var s0 = s || {}, st = s0['border-' + sd + '-style'] || 'none';
        var w = st === 'none' || st === 'hidden' ? 0 : (parseFloat(s0['border-' + sd + '-width']) || 0);
        var col = s0['border-' + sd + '-color'];
        if (!col || col === 'currentcolor') col = colorOf(o, inh);
        m = { w: w, st: st, c: col };
        if (s) {
          if (!memo) { memo = {}; Object.defineProperty(s, '_sides', { value: memo, enumerable: false }); }
          memo[mk] = m;
        }
      }
      return { w: m.w, st: m.st, c: m.c, rank: rank };
    };
    var better = function (a, b) {
      if (!b) return a; if (!a) return b;
      if (a.st === 'hidden' || b.st === 'hidden') return a.st === 'hidden' ? a : b;
      if (a.st === 'none' && b.st !== 'none') return b;
      if (b.st === 'none') return a;
      if (a.w !== b.w) return a.w > b.w ? a : b;
      if ((BSTYLE_RANK[a.st] || 0) !== (BSTYLE_RANK[b.st] || 0)) return (BSTYLE_RANK[a.st] || 0) > (BSTYLE_RANK[b.st] || 0) ? a : b;
      if (a.rank !== b.rank) return a.rank > b.rank ? a : b;
      return a;
    };
    // (of two of a kind the one to the left, or above, wins, 17.6.2.1 4)
    var before = function (a, b) { var w = better(a, b); return w === a && b && a && a.w === b.w && a.st === b.st && a.rank === b.rank ? b : w; };
    var tc = colorOf(tbl, tcolor);
    // the winner on one side of a cell (sd), against what is across
    var edge = function (cell, sd) {
      var rc = colorOf(cell.rowo.row, colorOf(cell.rowo.grp, tc)), cc = colorOf(cell.o, rc);
      var opp = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[sd];
      var w = side(cell.o, sd, 6, rc);
      var horiz = sd === 'left' || sd === 'right';
      var r0 = cell.r, r1 = cell.r + cell.rs - 1, c0 = cell.c, c1 = cell.c + cell.cs - 1;
      // the row(s) and groups along it
      if (horiz) {
        for (var y = r0; y <= r1; y++) {
          var ro = rows[y];
          if ((sd === 'left' && c0 === 0) || (sd === 'right' && c1 === ncols - 1)) { w = better(w, side(ro.row, sd, 5, colorOf(ro.grp, tc))); if (ro.grp) w = better(w, side(ro.grp, sd, 4, tc)); }
        }
        var cx = sd === 'left' ? c0 : c1, co = cols[cx];
        if (co) { w = better(w, side(co.col, sd, 3, tc)); if (co.grp && ((sd === 'left' && (cx === 0 || !cols[cx - 1] || cols[cx - 1].grp !== co.grp)) || (sd === 'right' && (!cols[cx + 1] || cols[cx + 1].grp !== co.grp)))) w = better(w, side(co.grp, sd, 2, tc)); }
        var nx = sd === 'left' ? c0 - 1 : c1 + 1;
        if (nx < 0 || nx >= ncols) { w = better(w, side(tbl, sd, 1, tcolor)); return w; }
        var nb = grid[r0] && grid[r0][nx];
        var ahead = sd === 'left' ? before : better;
        if (nb) { w = ahead(w, side(nb.o, opp, 6, colorOf(nb.rowo.row, tc))); var nco = cols[nx]; if (nco) { w = ahead(w, side(nco.col, opp, 3, tc)); if (nco.grp && nco.grp !== nco.col && (!co || co.grp !== nco.grp)) w = ahead(w, side(nco.grp, opp, 2, tc)); } }
        return w;
      }
      var ro2 = rows[sd === 'top' ? r0 : r1];
      w = better(w, side(ro2.row, sd, 5, colorOf(ro2.grp, tc)));
      var ny = sd === 'top' ? r0 - 1 : r1 + 1;
      if (ro2.grp && (ny < 0 || ny >= rows.length || rows[ny].grp !== ro2.grp)) w = better(w, side(ro2.grp, sd, 4, tc));
      for (var x = c0; x <= c1; x++) { var co2 = cols[x]; if (co2 && (ny < 0 || ny >= rows.length)) { w = better(w, side(co2.col, sd, 3, tc)); if (co2.grp) w = better(w, side(co2.grp, sd, 2, tc)); } }
      if (ny < 0 || ny >= rows.length) { w = better(w, side(tbl, sd, 1, tcolor)); return w; }
      var nr = rows[ny];
      var above = sd === 'top' ? before : better;
      w = above(w, side(nr.row, opp, 5, colorOf(nr.grp, tc)));
      if (nr.grp && nr.grp !== ro2.grp) w = above(w, side(nr.grp, opp, 4, tc));
      var nb2 = grid[ny] && grid[ny][c0];
      if (nb2) w = above(w, side(nb2.o, opp, 6, colorOf(nb2.rowo.row, tc)));
      return w;
    };
    var outer = { left: null, right: null, top: null, bottom: null };
    var put = function (s, sd, b, half) {
      if (!b || b.st === 'hidden' || b.st === 'none' || !b.w) { delete s['border-' + sd + '-style']; delete s['border-' + sd + '-width']; delete s['border-' + sd + '-color']; return; }
      s['border-' + sd + '-style'] = b.st; s['border-' + sd + '-width'] = (half ? b.w / 2 : b.w) + 'px'; s['border-' + sd + '-color'] = b.c;
    };
    // (a table with a caption draws no border: the table's box holds the
    // caption too, so its outer cells take the outer borders whole)
    var capt = objs.some(function (k) { return k.s && k.s.display === 'table-caption'; });
    // A row's borders follow from the row, the rows above and below it,
    // their groups and the table: while those are the renders they were
    // (their parts, _p), the borders its cells won and the row's JSON are
    // as last time (cm, kept with the row's parts). One row's class changed
    // in a table of 1000 settled four edges of every cell again. Not in a
    // table with columns or a cell that spans rows.
    var memoOn = !!json && !cols.length && !anySpan, tsig = '';
    if (memoOn) {
      tsig = (capt ? 'c' : '') + ncols + '|' + tc + '|' + tcolor;
      var ts0 = tbl.s || {};
      for (var tq = 0; tq < 4; tq++) tsig += '|' + ts0['border-' + SIDES4[tq] + '-style'] + ' ' + ts0['border-' + SIDES4[tq] + '-width'] + ' ' + ts0['border-' + SIDES4[tq] + '-color'];
      // (a group by its own style, and whether a neighbour is in the same
      // one: the group is rendered again whenever a row of it is)
      var NOP = {}, partOf = function (ro) { return ro ? ro.row._p || NOP : null; };
      var gsOf = function (g) { if (!g) return ''; if (g._gs === undefined) Object.defineProperty(g, '_gs', { value: JSON.stringify(g.s || null), enumerable: false }); return g._gs; };
      var grpOf = function (ro, of) { return !ro ? '-' : of && ro.grp === of.grp ? '=' : gsOf(ro.grp); };
      for (var mr = 0; mr < rows.length; mr++) {
        var ro0 = rows[mr], rp = ro0.row._p;
        if (!rp) continue;
        var pv = partOf(rows[mr - 1]), nx0 = partOf(rows[mr + 1]), g0 = grpOf(ro0, null), g1 = grpOf(rows[mr - 1], ro0), g2 = grpOf(rows[mr + 1], ro0);
        if (pv === NOP || nx0 === NOP) continue;
        var cm = rp.cm;
        if (cm && cm.tsig === tsig && cm.prev === pv && cm.next === nx0 && cm.grp === g0 && cm.pg === g1 && cm.ng === g2 && cm.won.length === ro0.n) { ro0.m = cm; ro0.ok = true; }
        else ro0.m = rp.cm = { tsig: tsig, prev: pv, next: nx0, grp: g0, pg: g1, ng: g2, won: [], out: undefined };
      }
    }
    var won = null;
    var SD = ['left', 'right', 'top', 'bottom'];
    var outerOf = function (cell, sd) { return (sd === 'left' && cell.c === 0) || (sd === 'right' && cell.c + cell.cs === ncols) || (sd === 'top' && cell.r === 0) || (sd === 'bottom' && cell.r + cell.rs === rows.length); };
    var mixed = {};
    if (!lazy) {
    won = cells.map(function (cell) {
      var ro = cell.rowo;
      if (ro.ok) return ro.m.won[cell.k];
      var w4 = [edge(cell, 'left'), edge(cell, 'right'), edge(cell, 'top'), edge(cell, 'bottom')];
      if (ro.m) ro.m.won[cell.k] = w4;
      return w4;
    });
    // (the cells along the table's sides only: one of 4 000 cells inside
    // asked nothing here)
    var nrows = rows.length, atSide = function (cell) { return cell.c === 0 || cell.c + cell.cs === ncols || cell.r === 0 || cell.r + cell.rs === nrows; };
    for (var ox = 0; ox < cells.length; ox++) {
      var oc = cells[ox];
      if (!atSide(oc)) continue;
      for (var os = 0; os < 4; os++) {
        var ob = won[ox][os], osd = SD[os];
        if (outerOf(oc, osd) && ob && ob.st !== 'hidden' && ob.w && (!outer[osd] || ob.w > outer[osd].w)) outer[osd] = ob;
      }
    }
    // (outer edges that differ along a side: the table's border keeps the
    // widest for layout, unpainted, and each outer cell paints its own
    // outer half with a positioned strip over it)
    if (!capt) for (var mx = 0; mx < cells.length; mx++) {
      var mc = cells[mx];
      if (!atSide(mc)) continue;
      for (var ms = 0; ms < 4; ms++) {
        var msd = SD[ms];
        if (!outerOf(mc, msd) || !outer[msd]) continue;
        var mb = won[mx][ms];
        if (!mb || mb.st !== outer[msd].st || mb.w !== outer[msd].w || mb.c !== outer[msd].c) mixed[msd] = true;
      }
    }
    } else {
      var nrl = rows.length;
      for (var wr = 0; wr < nrl; wr++) {
        var wro = rows[wr];
        if (wro.ok) { wro.won = wro.m.won; continue; }
        need(wr - 1); need(wr + 1);
        var wcs = need(wr), ww = [];
        for (var wk = 0; wk < wcs.length; wk++) ww.push([edge(wcs[wk], 'left'), edge(wcs[wk], 'right'), edge(wcs[wk], 'top'), edge(wcs[wk], 'bottom')]);
        wro.won = ww;
        if (wro.m) wro.m.won = ww;
      }
      // (the cells along the table's sides, in the order of the cells:
      // all of the first and the last row, the first and the last cell of
      // the others)
      var eachSide = function (fn) {
        for (var ri = 0; ri < nrl; ri++) {
          var r = rows[ri], ei = r.info, n = ei.n, top = ri === 0, bot = ri === nrl - 1;
          for (var k = 0; k < n; k++) {
            if (!top && !bot && k > 0 && k < n - 1) { k = n - 2; continue; }
            var c0 = ei.c[k], w4 = r.won[k];
            if (c0 === 0) fn(0, w4[0]);
            if (c0 + ei.cs[k] === ncols) fn(1, w4[1]);
            if (top) fn(2, w4[2]);
            if (bot) fn(3, w4[3]);
          }
        }
      };
      eachSide(function (si, ob) { var osd = SD[si]; if (ob && ob.st !== 'hidden' && ob.w && (!outer[osd] || ob.w > outer[osd].w)) outer[osd] = ob; });
      if (!capt) eachSide(function (si, mb) {
        var msd = SD[si];
        if (!outer[msd]) return;
        if (!mb || mb.st !== outer[msd].st || mb.w !== outer[msd].w || mb.c !== outer[msd].c) mixed[msd] = true;
      });
    }
    var anyMixed = mixed.left || mixed.right || mixed.top || mixed.bottom;
    // (a row settled as last time goes out as it did, partsJson)
    var useOut = function (ro) { return ro.ok && !anyMixed && ro.m.out !== undefined; };
    var settle = function (cell, cw) {
      // (a cell from its render's parts whose borders won as last time:
      // its JSON as last time, partsJson)
      var p = cell.o._p, key = null;
      if (p && !anyMixed) {
        key = '';
        for (var si = 0; si < 4; si++) { var b0 = cw[si]; key += (b0 ? b0.st + ' ' + b0.w + ' ' + b0.c : '-') + (capt && outerOf(cell, SD[si]) ? '!' : '') + '|'; }
        Object.defineProperty(cell.o, '_key', { value: key, enumerable: false, writable: true });
        if (p.clKey === key) return;
      }
      var s = cell.o.s = Object.assign({}, cell.o.s);
      SD.forEach(function (sd, si) { put(s, sd, cw[si], !(capt && outerOf(cell, sd))); });
    };
    if (!lazy) cells.forEach(function (cell, ix) { if (!useOut(cell.rowo)) settle(cell, won[ix]); });
    else {
      for (var ar = 0; ar < rows.length; ar++) {
        var aro = rows[ar];
        if (useOut(aro)) continue;
        var acs = need(ar);
        for (var ak = 0; ak < acs.length; ak++) settle(acs[ak], aro.won[ak]);
      }
      // (differing outer edges: every cell is asked below)
      if (anyMixed) { cells = []; won = []; for (var fr = 0; fr < rows.length; fr++) { var fcs = need(fr); for (var fk = 0; fk < fcs.length; fk++) { cells.push(fcs[fk]); won.push(rows[fr].won[fk]); } } }
    }
    // rows, groups and columns draw no borders of their own
    var strip = function (o) { if (!o || !o.s) return; o.s = Object.assign({}, o.s); ['left', 'right', 'top', 'bottom'].forEach(function (sd) { delete o.s['border-' + sd + '-style']; delete o.s['border-' + sd + '-width']; }); };
    var stripped = [];
    rows.forEach(function (r) {
      var rp1 = r.row._p;
      if (rp1) rp1.cw = useOut(r) ? r.row.c : null;
      if (useOut(r)) Object.defineProperty(r.row, '_cmOut', { value: r.m.out, enumerable: false });
      else { strip(r.row); if (r.m) { r.m.out = undefined; if (!anyMixed) Object.defineProperty(r.row, '_cmRec', { value: r.m, enumerable: false }); } }
      if (r.grp && stripped.indexOf(r.grp) < 0) { strip(r.grp); stripped.push(r.grp); }
    });
    cols.forEach(function (c) { strip(c.col); strip(c.grp); });
    tbl.s = Object.assign({}, tbl.s);
    ['left', 'right', 'top', 'bottom'].forEach(function (sd) {
      put(tbl.s, sd, capt ? null : outer[sd], true);
      if (mixed[sd]) tbl.s['border-' + sd + '-color'] = 'transparent';
      delete tbl.s['padding-' + sd];
    });
    if (mixed.left || mixed.right || mixed.top || mixed.bottom) cells.forEach(function (cell, ix) {
      var s = cell.o.s, strips = [];
      var bw = function (sd) { return parseFloat(s['border-' + sd + '-width']) || 0; };
      ['left', 'right', 'top', 'bottom'].forEach(function (sd, si) {
        if (!mixed[sd]) return;
        var isOuter = (sd === 'left' && cell.c === 0) || (sd === 'right' && cell.c + cell.cs === ncols) || (sd === 'top' && cell.r === 0) || (sd === 'bottom' && cell.r + cell.rs === rows.length);
        var b = won[ix][si];
        if (!isOuter || !b || b.st === 'hidden' || b.st === 'none' || !b.w) return;
        var h = b.w / 2, horiz = sd === 'left' || sd === 'right', st = { position: 'absolute', 'box-sizing': 'border-box' };
        st[sd] = -(bw(sd) + h) + 'px';
        st[horiz ? 'width' : 'height'] = h + 'px';
        var a0 = horiz ? 'top' : 'left', a1 = horiz ? 'bottom' : 'right';
        var atEdge = function (e) { return (e === 'left' && cell.c === 0) || (e === 'right' && cell.c + cell.cs === ncols) || (e === 'top' && cell.r === 0) || (e === 'bottom' && cell.r + cell.rs === rows.length); };
        var ext = function (e) { return atEdge(e) && outer[e] ? outer[e].w / 2 : 0; };
        st[a0] = -(bw(a0) + ext(a0)) + 'px'; st[a1] = -(bw(a1) + ext(a1)) + 'px';
        st['border-' + sd + '-style'] = b.st; st['border-' + sd + '-width'] = h + 'px'; st['border-' + sd + '-color'] = b.c;
        strips.push({ i: (cell.o.i || '') + 'cb' + sd.charAt(0), t: 'div', s: st, c: [] });
      });
      if (!strips.length) return;
      if (!s.position || s.position === 'static') s.position = 'relative';
      cell.o.c = (cell.o.c || []).concat(strips);
    });
    if (!json) return objs;
    var outs = [], djs = pjDelta ? [] : null;
    for (var oi = 0; oi < objs.length; oi++) { outs.push(partsJson(objs[oi])); if (djs) djs.push(pjLast); }
    collapseDj = djs;
    return outs;
  }
  function anonTables(pd, kids, kd, id, json) {
    if (pd === 'table-row') return anonCells(kids, kd, id, json);
    // (a column group's columns are its own, not wrapped in a table)
    if (pd === 'table-column-group') return kids;
    // (a flex or grid item is blockified, not wrapped)
    if (/^(inline-)?(flex|grid)$/.test(pd || '')) return kids;
    // (in a table or a row group, cells only are wrapped: in a row)
    var inTable = TABLE_IN.test(pd || '');
    var has = false;
    for (var i = 0; i < kd.length; i++) if (kd[i] === 'table-cell' || (!inTable && (kd[i] === 'table-row' || TABLE_GROUP.test(kd[i] || '')))) { has = true; break; }
    if (!has) return kids;
    var out = [], k = 0;
    while (k < kids.length) {
      if (kd[k] !== 'table-cell' && (inTable || (kd[k] !== 'table-row' && !TABLE_GROUP.test(kd[k] || '')))) { out.push(kids[k]); k++; continue; }
      var run = [], rows = [], cells = [], n = 0;
      var flush = function () { if (cells.length) { rows.push({ cells: cells }); cells = []; } };
      while (k < kids.length && (kd[k] === 'table-cell' || (!inTable && (kd[k] === 'table-row' || TABLE_GROUP.test(kd[k] || ''))) || kd[k] === '#ws')) {
        if (kd[k] === 'table-cell') cells.push(kids[k]);
        else if (kd[k] !== '#ws') { flush(); rows.push({ row: kids[k], d: kd[k] }); }
        k++;
      }
      flush();
      if (!inTable) { var go = groupOrder(rows.map(function (r) { return r.d || 'table-row'; })); rows = go.map(function (x) { return rows[x]; }); }
      // (white space after the run is the block's again)
      var parts = rows.map(function (r, ri) {
        if (r.row) return r.row;
        var rid = id + 'ar' + out.length + '-' + ri;
        return json ? '{"i":' + JSON.stringify(rid) + ',"t":"div","s":{"display":"table-row"},"c":[' + r.cells.join(',') + ']}'
                    : { i: rid, t: 'div', s: { display: 'table-row' }, c: r.cells };
      });
      if (inTable) { for (var pi = 0; pi < parts.length; pi++) out.push(parts[pi]); continue; }
      var tid = id + 'at' + out.length;
      var tdisp = pd === 'inline' ? 'inline-table' : 'table';
      out.push(json ? '{"i":' + JSON.stringify(tid) + ',"t":"div","s":{"display":"' + tdisp + '"},"c":[' + parts.join(',') + ']}'
                    : { i: tid, t: 'div', s: { display: tdisp }, c: parts });
    }
    return out;
  }
  // what is not a cell in a row, a run of it, is in an anonymous cell
  // (CSS 2.1 17.2.1 rule 2.1); white space between two cells goes
  function anonCells(kids, kd, id, json) {
    // (not the table parts, which the table model places on its own)
    var other = function (d) { return d !== 'table-cell' && d !== '#ws' && d !== 'none' && d !== 'table-row' && !TABLE_GROUP.test(d || ''); };
    var any = false;
    for (var i = 0; i < kd.length; i++) if (other(kd[i])) { any = true; break; }
    if (!any) return kids;
    var out = [], k = 0;
    while (k < kids.length) {
      // (white space before a run is in it: only that between two cells goes)
      var nx = k;
      while (nx < kids.length && kd[nx] === '#ws') nx++;
      if (!(nx < kids.length && other(kd[nx]))) { if (kd[k] !== '#ws') out.push(kids[k]); k++; continue; }
      var run = [];
      while (k < kids.length && kd[k] !== 'table-cell') { run.push(kids[k]); k++; }
      var cid = id + 'ac' + out.length;
      out.push(json ? '{"i":' + JSON.stringify(cid) + ',"t":"div","s":{"display":"table-cell"},"c":[' + run.join(',') + ']}'
                    : { i: cid, t: 'div', s: { display: 'table-cell' }, c: run });
    }
    return out;
  }
  // an element's ::before or ::after box: a span of the style its rules
  // give it, inheriting from the element, holding the text of its content
  // CSS 2.1 12.4 counters: per name, its instances from the outermost in;
  // an instance a counter-reset made is in scope for the element's later
  // siblings and what is in them, and goes when their parent ends
  // (ctrTouch: counted up by each counter or quote a render sets or reads;
  // a subtree whose render left it alone takes its last render whatever
  // came before it, renderJson)
  var ctr = {}, ctrUsed = false, qDepth = 0, ctrTouch = 0;
  // a quotes value as its open and close pairs (auto: the curly ones)
  function quotePairs(v) {
    v = String(v || 'auto').trim();
    if (v === 'none') return [];
    if (v === 'auto' || v === 'initial' || !v) return [['\u201c', '\u201d'], ['\u2018', '\u2019']];
    var out = [], re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g, m, cur = [];
    while ((m = re.exec(v))) {
      cur.push((m[1] !== undefined ? m[1] : m[2]).replace(/\\([0-9a-fA-F]{1,6})\s?/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); }).replace(/\\(.)/g, '$1'));
      if (cur.length === 2) { out.push(cur); cur = []; }
    }
    return out;
  }
  function ctrPairs(v, dflt) {
    var out = [], t = String(v || '').trim().split(/\s+/);
    if (!t[0] || t[0] === 'none') return out;
    for (var i = 0; i < t.length; i++) {
      var name = t[i], num = dflt;
      if (!/^-?[_a-zA-Z][\w-]*$/.test(name)) return [];
      if (i + 1 < t.length && /^[+-]?\d+$/.test(t[i + 1])) { num = parseInt(t[i + 1], 10); i++; }
      out.push([name, num]);
    }
    return out;
  }
  // (a counter used with none in scope is reset to 0 there)
  function ctrStack(name, owner) {
    ctrTouch++;
    var st = ctr[name] || (ctr[name] = []);
    if (!st.length) st.push({ v: 0, owner: owner });
    return st;
  }
  function ctrApply(cs, owner, el) {
    var r = cs['counter-reset'], inc = cs['counter-increment'];
    // (CSS Lists 4.4: <ol>, <ul> and <menu> reset list-item, an <ol> to
    // start - 1, and a list item adds 1 to it unless it names list-item)
    if (el && /^(ol|ul|menu)$/.test(el.localName) && !/(^|\s)list-item(\s|$)/.test(r || '')) {
      var lst = 0;
      if (el.localName === 'ol' && el.hasAttribute('start')) lst = (parseInt(el.getAttribute('start'), 10) || 1) - 1;
      r = (r && r !== 'none' ? r + ' ' : '') + 'list-item ' + lst;
    }
    if (el && cs.display === 'list-item' && !/(^|\s)list-item(\s|$)/.test(inc || '')) inc = (inc && inc !== 'none' ? inc + ' ' : '') + 'list-item 1';
    if (r && r !== 'none') {
      ctrUsed = true;
      ctrTouch++;
      ctrPairs(r, 0).forEach(function (p) {
        var st = ctr[p[0]] || (ctr[p[0]] = []);
        if (st.length && st[st.length - 1].owner === owner) st[st.length - 1].v = p[1];
        else st.push({ v: p[1], owner: owner });
      });
    }
    if (inc && inc !== 'none') {
      ctrUsed = true;
      ctrPairs(inc, 1).forEach(function (p) { var st = ctrStack(p[0], owner); st[st.length - 1].v += p[1]; });
    }
  }
  function ctrLeave(n) {
    if (!ctrUsed) return;
    for (var k in ctr) { var st = ctr[k]; while (st.length && st[st.length - 1].owner === n) st.pop(); }
  }
  function roman(v) { var r = '', tb = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; for (var q = 0; q < tb.length; q++) while (v >= tb[q][0]) { r += tb[q][1]; v -= tb[q][0]; } return r; }
  function alpha(v, base) { var r = ''; while (v > 0) { v--; r = String.fromCharCode(base + v % 26) + r; v = Math.floor(v / 26); } return r; }
  var GREEK = 'αβγδεζηθικλμνξοπρστυφχψω';
  var ADDITIVE = {
    georgian: [19999, 10000, 'ჵ', 9000, 'ჰ', 8000, 'ჯ', 7000, 'ჴ', 6000, 'ხ', 5000, 'ჭ', 4000, 'წ', 3000, 'ძ', 2000, 'ც', 1000, 'ჩ', 900, 'შ', 800, 'ყ', 700, 'ღ', 600, 'ქ', 500, 'ფ', 400, 'ჳ', 300, 'ტ', 200, 'ს', 100, 'რ', 90, 'ჟ', 80, 'პ', 70, 'ო', 60, 'ჲ', 50, 'ნ', 40, 'მ', 30, 'ლ', 20, 'კ', 10, 'ი', 9, 'თ', 8, 'ჱ', 7, 'ზ', 6, 'ვ', 5, 'ე', 4, 'დ', 3, 'გ', 2, 'ბ', 1, 'ა'],
    'upper-armenian': [9999, 9000, 'Ք', 8000, 'Փ', 7000, 'Ւ', 6000, 'Ց', 5000, 'Ր', 4000, 'Տ', 3000, 'Վ', 2000, 'Ս', 1000, 'Ռ', 900, 'Ջ', 800, 'Պ', 700, 'Չ', 600, 'Ո', 500, 'Շ', 400, 'Ն', 300, 'Յ', 200, 'Մ', 100, 'Ճ', 90, 'Ղ', 80, 'Ձ', 70, 'Հ', 60, 'Կ', 50, 'Ծ', 40, 'Խ', 30, 'Լ', 20, 'Ի', 10, 'Ժ', 9, 'Թ', 8, 'Ը', 7, 'Է', 6, 'Զ', 5, 'Ե', 4, 'Դ', 3, 'Գ', 2, 'Բ', 1, 'Ա'],
    'lower-armenian': [9999, 9000, 'ք', 8000, 'փ', 7000, 'ւ', 6000, 'ց', 5000, 'ր', 4000, 'տ', 3000, 'վ', 2000, 'ս', 1000, 'ռ', 900, 'ջ', 800, 'պ', 700, 'չ', 600, 'ո', 500, 'շ', 400, 'ն', 300, 'յ', 200, 'մ', 100, 'ճ', 90, 'ղ', 80, 'ձ', 70, 'հ', 60, 'կ', 50, 'ծ', 40, 'խ', 30, 'լ', 20, 'ի', 10, 'ժ', 9, 'թ', 8, 'ը', 7, 'է', 6, 'զ', 5, 'ե', 4, 'դ', 3, 'գ', 2, 'բ', 1, 'ա']
  };
  function fmtCounter(v, style) {
    style = String(style || 'decimal').toLowerCase();
    if (style === 'none') return '';
    if (style === 'disc') return '•';
    if (style === 'circle') return '◦';
    if (style === 'square') return '▪';
    if (style === 'decimal-leading-zero') return (v < 0 ? '-' : '') + (Math.abs(v) < 10 ? '0' : '') + Math.abs(v);
    if (v > 0 && v < 4000 && (style === 'lower-roman' || style === 'upper-roman')) return style === 'upper-roman' ? roman(v).toUpperCase() : roman(v);
    if (v > 0 && (style === 'lower-alpha' || style === 'lower-latin')) return alpha(v, 97);
    if (v > 0 && (style === 'upper-alpha' || style === 'upper-latin')) return alpha(v, 65);
    // (additive systems, CSS Counter Styles 7.1; out of range: decimal)
    var add = ADDITIVE[style === 'armenian' ? 'upper-armenian' : style];
    if (add && v > 0 && v <= add[0]) {
      var out = '';
      for (var ai = 1; ai < add.length; ai += 2) while (v >= add[ai]) { out += add[ai + 1]; v -= add[ai]; }
      return out;
    }
    if (v > 0 && style === 'lower-greek') { var g = ''; while (v > 0) { v--; g = GREEK.charAt(v % 24) + g; v = Math.floor(v / 24); } return g; }
    return String(v);
  }
  // a list item's marker inside it (list-style-position: inside): the
  // first box of its first line, as Chromium makes it: a symbol in a box
  // 1.3em + 2px wide, or the number and a dot
  function insideMarker(n, cs) {
    if (cs.display !== 'list-item' || cs['list-style-position'] !== 'inside') return null;
    var ty = cs['list-style-type'] || 'disc';
    if (ty === 'none') return null;
    var id = n.__id + 'pm';
    var fs = parseFloat(cs['font-size']) || 16;
    var sym = { disc: '•', circle: '◦', square: '▪' }[ty];
    if (sym) return { i: id, t: 'span', pe: 1, s: { display: 'inline-block', width: Math.round(fs * 1.3 + 2) + 'px' }, c: [{ i: id + 't', x: sym }] };
    // (the item's number among its parent's items, from an <ol>'s start)
    var no = 1, par = n.parentNode;
    if (par && par.localName === 'ol' && par.hasAttribute('start')) no = parseInt(par.getAttribute('start'), 10) || 1;
    if (par) for (var k = 0; k < par._c.length && par._c[k] !== n; k++) if (par._c[k].nodeType === 1 && computedOf(par._c[k]).display === 'list-item') no++;
    var txt = String(no);
    if (ty === 'lower-alpha' || ty === 'lower-latin') txt = String.fromCharCode(96 + no);
    if (ty === 'upper-alpha' || ty === 'upper-latin') txt = String.fromCharCode(64 + no);
    if (ty === 'lower-roman' || ty === 'upper-roman') { var r = '', v = no, tb = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; for (var q = 0; q < tb.length; q++) while (v >= tb[q][0]) { r += tb[q][1]; v -= tb[q][0]; } txt = ty === 'upper-roman' ? r.toUpperCase() : r; }
    return { i: id, t: 'span', pe: 1, s: { display: 'inline' }, c: [{ i: id + 't', x: txt + '. ' }] };
  }
  // (strings and attr(); counters and images are left out)
  // a top layer element's ::backdrop: a fixed box of the viewport under it
  // (CSS Position 4, 3.1), styled as the page's ::backdrop rules say, its
  // inherited properties the element's
  function backdropBox(n) {
    var cs = computedOf(n);
    if (cs.display === 'none') return null;
    var ps = cascade(n, 'backdrop') ? computeStyle(n, cs, 'backdrop') : {};
    if (ps.display === 'none') return null;
    var s = {};
    for (var k in ps) {
      if (k.charAt(0) === '_' || k === 'content') continue;
      var v = ps[k];
      if (INHERITED[k] && cs[k] === v) continue;
      if (!INHERITED[k] && INITIAL[k] === v) continue;
      s[k] = v;
    }
    s.display = 'block';
    s.position = 'fixed';
    ['top', 'right', 'bottom', 'left'].forEach(function (e) { if (!s[e] || s[e] === 'auto') s[e] = '0px'; });
    if (!s['background-color'] && n.localName === 'dialog' && n._modal) s['background-color'] = 'rgba(0, 0, 0, 0.1)';
    return { i: n.__id + 'bd', t: 'div', s: s };
  }
  // calc() of % and px terms only, with numbers multiplying them, as one
  // value: `calc(50% - 30%*.5)` is 35% (the host reads one % and one px
  // term at most); anything else as it was
  // box-shadow's outer layers for the host (it draws no CSS shadows):
  // "box-ring" the layers with no offset and no blur but a spread, as a
  // focus ring is (Bootstrap's 0 0 0 .25rem, Tailwind's ring-*), "spread
  // rgba(...)" by ", " topmost first; "box-drop" the first blurred or
  // offset one, "dx dy blur rgba(...)" (EVG has one shadow per box)
  function shadowLayers(s, color) {
    var layers = splitComma(s['box-shadow']), rings = [], drop = null;
    for (var i = 0; i < layers.length; i++) {
      var toks = splitValue(layers[i]), lens = [], col = null, inset = false;
      for (var j = 0; j < toks.length; j++) {
        var t = toks[j];
        if (t === 'inset') { inset = true; continue; }
        if (/^calc\(/.test(t)) t = flatCalc(t);
        if (/^-?[\d.]+(px)?$/.test(t)) { lens.push(parseFloat(t)); continue; }
        col = t;
      }
      if (inset || lens.length < 2) continue;
      var c = colorRGBA(!col || col === 'currentcolor' ? color || 'rgb(0, 0, 0)' : col);
      if (!c || !(c[3] > 0)) continue;
      var rgba = 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (Math.round(c[3] * 1000) / 1000) + ')';
      var dx = lens[0], dy = lens[1], blur = lens[2] || 0, spread = lens[3] || 0;
      if (!dx && !dy && !blur) { if (spread > 0) rings.push(fmtPx(spread) + ' ' + rgba); }
      else if (!drop) drop = fmtPx(dx) + ' ' + fmtPx(dy) + ' ' + fmtPx(blur) + ' ' + rgba;
    }
    if (rings.length) s['box-ring'] = rings.join(', ');
    if (drop) s['box-drop'] = drop;
  }
  function insetFill(s) {
    var v = s['box-shadow'].trim(), m = /^inset\s+(.*)$/.exec(v) || /^(.*?)\s+inset$/.exec(v);
    if (!m || v.indexOf(',', v.lastIndexOf(')') + 1) >= 0) return;
    var rest = m[1], col = null;
    rest = rest.replace(/(rgba?|hsla?)\([^)]*\)|#[0-9a-f]{3,8}\b|\b(transparent|[a-z]+)\b/gi, function (c) { col = c; return ' '; }).trim();
    var len = rest.split(/\s+/);
    if (len.length !== 4 || parseFloat(len[0]) || parseFloat(len[1]) || parseFloat(len[2]) || !(parseFloat(len[3]) >= 1000)) return;
    var c = col ? colorRGBA(col) : null;
    if (!c || c[3] === 0) { delete s['box-shadow']; return; }
    var b = s['background-color'] ? colorRGBA(s['background-color']) : null;
    if (!b) b = [0, 0, 0, 0];
    var a = c[3] + b[3] * (1 - c[3]);
    var mix = function (k) { return Math.round((c[k] * c[3] + b[k] * b[3] * (1 - c[3])) / a); };
    s['background-color'] = a >= 1 ? 'rgb(' + mix(0) + ', ' + mix(1) + ', ' + mix(2) + ')' : 'rgba(' + mix(0) + ', ' + mix(1) + ', ' + mix(2) + ', ' + (Math.round(a * 1000) / 1000) + ')';
    delete s['box-shadow'];
  }
  function flatCalc(v) {
    var m = /^calc\((.*)\)$/.exec(v);
    if (!m || /calc|var|\(/.test(m[1])) return v;
    var body = m[1].replace(/(-?[\d.]+)(%|px)\s*\*\s*(-?[\d.]+)(?![\w%])/g, function (_, a, u, b) { return (parseFloat(a) * parseFloat(b)) + u; })
      .replace(/(-?[\d.]+)\s*\*\s*(-?[\d.]+)(%|px)/g, function (_, a, b, u) { return (parseFloat(a) * parseFloat(b)) + u; });
    var re = /\s*([+-])?\s*(-?[\d.]+)(%|px)\s*/g, t, pc = 0, px = 0, at = 0, first = true;
    while ((t = re.exec(body)) && t.index === at) {
      if (!first && !t[1]) return v;
      var n = parseFloat(t[2]) * (t[1] === '-' ? -1 : 1);
      if (t[3] === '%') pc += n; else px += n;
      at = re.lastIndex; first = false;
    }
    if (at !== body.length || first) return v;
    var r = function (x) { return Math.round(x * 10000) / 10000; };
    if (!px) return r(pc) + '%';
    if (!pc) return r(px) + 'px';
    return 'calc(' + r(pc) + '% ' + (px < 0 ? '- ' : '+ ') + r(Math.abs(px)) + 'px)';
  }
  // A BOX WITH AN SVG MASK OVER ITS BACKGROUND COLOUR IS THAT SVG IN THE
  // COLOUR. The host draws no masks; an icon set made of `background-color:
  // currentColor` pseudo-elements masked by SVG pictures (a data grid's sort
  // and filter icons, a checkbox's tick) drew as squares of the colour.
  // Every colour the SVG paints becomes the background colour (a mask takes
  // only its alpha), and the box becomes that picture: an img of it, which
  // the host draws scaled into the box. The SVG as a data: URL, '' when the
  // mask is not one; s loses its background colour when it is.
  function maskAsImage(s) {
    var mi = s['mask-image'] || s['-webkit-mask-image'];
    if (!mi || mi === 'none') return '';
    // (encodeURIComponent leaves ( ) ' alone: a quoted url runs to its quote)
    var m = /^url\(\s*(['"])(data:image\/svg\+xml[\s\S]*)\1\s*\)$/i.exec(mi.trim()) || /^url\(\s*()(data:image\/svg\+xml[^)]*)\)$/i.exec(mi.trim());
    var bg = s['background-color'];
    if (!m || !bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return '';
    var uri = m[2], comma = uri.indexOf(','), svg;
    if (comma < 0) return '';
    try { svg = /;base64$/i.test(uri.slice(0, comma)) ? atob(uri.slice(comma + 1)) : decodeURIComponent(uri.slice(comma + 1)); } catch (e) { return ''; }
    svg = svg.replace(/\b(fill|stroke|stop-color)\s*=\s*(["'])(?!none\2)[^"']*\2/gi, '$1="' + bg + '"')
      .replace(/\b(fill|stroke|stop-color)\s*:\s*(?!none)[^;"'}]+/gi, '$1:' + bg);
    var tag = /<svg\b[^>]*>/i.exec(svg);
    if (tag && !/\sfill\s*=/i.test(tag[0])) svg = svg.replace(/<svg\b/i, '<svg fill="' + bg + '"');
    delete s['background-color'];
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  // An empty box drawn by its borders alone, some sides transparent: a
  // CSS triangle (Bootstrap's dropdown caret, a tooltip's arrow), whose
  // sides meet on the diagonals. The host fills each side as a rectangle,
  // so the box goes as an SVG picture of the four sides (mitered), its
  // borders taken off. '' when it is not such a box.
  function borderPicture(s, color) {
    var sides = ['top', 'right', 'bottom', 'left'], w = {}, col = {}, clear = 0, shown = 0;
    for (var i = 0; i < 4; i++) {
      var k = sides[i], st = s['border-' + k + '-style'], bw = parseFloat(s['border-' + k + '-width']) || 0;
      w[k] = st && st !== 'none' && st !== 'hidden' ? bw : 0;
      var c = s['border-' + k + '-color'] || s.color || color || 'rgb(0, 0, 0)';
      col[k] = c;
      if (!w[k]) continue;
      if (st !== 'solid') return '';
      if (c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c)) clear++; else shown++;
    }
    if (!clear || !shown) return '';
    var cw = s.width && s.width !== 'auto' ? parseFloat(s.width) : 0, ch = s.height && s.height !== 'auto' ? parseFloat(s.height) : 0;
    if (cw || ch || (s['background-color'] && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(s['background-color']))) return '';
    var W = w.left + w.right, H = w.top + w.bottom;
    if (W <= 0 || H <= 0) return '';
    var f = function (x) { return +x.toFixed(3); };
    var pts = {
      top: [[0, 0], [W, 0], [W - w.right, w.top], [w.left, w.top]],
      right: [[W, 0], [W, H], [W - w.right, H - w.bottom], [W - w.right, w.top]],
      bottom: [[0, H], [W, H], [W - w.right, H - w.bottom], [w.left, H - w.bottom]],
      left: [[0, 0], [0, H], [w.left, H - w.bottom], [w.left, w.top]]
    };
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + f(W) + '" height="' + f(H) + '" viewBox="0 0 ' + f(W) + ' ' + f(H) + '">';
    for (var j = 0; j < 4; j++) {
      var sd = sides[j], cc = col[sd];
      if (!w[sd] || cc === 'transparent' || /^rgba\(.*,\s*0\)$/.test(cc)) continue;
      svg += '<polygon fill="' + cc + '" points="' + pts[sd].map(function (p) { return f(p[0]) + ',' + f(p[1]); }).join(' ') + '"/>';
    }
    svg += '</svg>';
    for (var q = 0; q < 4; q++) { delete s['border-' + sides[q] + '-width']; delete s['border-' + sides[q] + '-style']; delete s['border-' + sides[q] + '-color']; }
    s.width = f(W) + 'px'; s.height = f(H) + 'px';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  function pseudoBox(n, cs, pe) {
    var d = n.ownerDocument || doc;
    if (d !== doc) return null;
    var any = false, list = cascadeSheets(d);
    for (var q = 0; q < list.length; q++) if (list[q]._pseudo && !list[q].disabled) { any = true; break; }
    if (!any) return null;
    var spec = cascade(n, pe);
    // (no content declared, or none: no box, its style not computed; a
    // page's `*, ::before, ::after` rule reaches every element's two)
    if (!spec || spec.content === undefined || /^\s*(normal|none)\s*$/.test(spec.content)) return null;
    lastPseudo = { el: n, pe: pe, gen: styleGen, out: spec };
    var ps = computeStyle(n, cs, pe);
    var content = (ps.content || 'normal').trim();
    if (content === 'normal' || content === 'none' || ps.display === 'none') return null;
    if (ps['counter-reset'] || ps['counter-increment']) ctrApply(ps, n, null);
    var text = '', re = /(no-)?(open|close)-quote|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)|counter\(\s*([\w-]+)\s*(?:,\s*([\w-]+)\s*)?\)|counters\(\s*([\w-]+)\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*(?:,\s*([\w-]+)\s*)?\)/g, m;
    while ((m = re.exec(content))) {
      // (CSS 2.1 12.3.2: quotes by nesting depth, in document order)
      if (m[2] !== undefined) {
        var qs = quotePairs(ps.quotes), open = m[2] === 'open';
        ctrTouch++;
        if (open) { if (!m[1] && qs.length) text += qs[Math.min(qDepth, qs.length - 1)][0]; qDepth++; }
        else if (qDepth > 0) { qDepth--; if (!m[1] && qs.length) text += qs[Math.min(qDepth, qs.length - 1)][1]; }
        continue;
      }
      if (m[6] !== undefined) { ctrUsed = true; text += fmtCounter(ctrStack(m[6], n).slice(-1)[0].v, m[7] || 'decimal'); continue; }
      if (m[8] !== undefined) { ctrUsed = true; text += ctrStack(m[8], n).map(function (c) { return fmtCounter(c.v, m[11] || 'decimal'); }).join(m[9] !== undefined ? m[9] : m[10]); continue; }
      if (m[5] !== undefined) {
        // (an XML document's names are case-sensitive)
        if (d.contentType === 'application/xhtml+xml' && m[5] !== m[5].toLowerCase()) {
          var at = n.attributes || [];
          for (var ai = 0; ai < at.length; ai++) if (at[ai].name === m[5]) text += at[ai].value || '';
        } else text += n.getAttribute(m[5]) || '';
      }
      else text += (m[3] !== undefined ? m[3] : m[4]).replace(/\\([0-9a-fA-F]{1,6})\s?/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); }).replace(/\\(.)/g, '$1');
    }
    var o = { i: n.__id + (pe === 'before' ? 'pb' : 'pa'), t: 'span', pe: 1 };
    var s = {};
    for (var k in ps) {
      if (k.charAt(0) === '_' || k === 'content') continue;
      var v = ps[k];
      if (INHERITED[k] && cs[k] === v) continue;
      if (!INHERITED[k] && INITIAL[k] === v) continue;
      s[k] = typeof v === 'string' && v.slice(0, 5) === 'calc(' ? flatCalc(v) : v;
    }
    if (!s.display) s.display = 'inline';
    var mask = text ? '' : maskAsImage(s) || borderPicture(s, ps.color);
    if (mask) { o.t = 'img'; o.a = { src: mask }; }
    o.s = s;
    if (text) o.c = ps['white-space'] === 'pre-line' && text.indexOf('\n') >= 0 ? preLineParts(o.i + 't', text) : [{ i: o.i + 't', x: text }];
    return o;
  }
  // a block container's ::first-letter box: the first letter (with the
  // punctuation around it) of its first text, when that text is a direct
  // child, as a span of the pseudo's style; the rest of the text follows.
  // (::first-line: where the line breaks is not known here, so its box
  // holds the first word only, which gives the first line its line-height)
  function firstLetter(n, cs, src, pe) {
    if (!/^(block|inline-block|list-item|table-cell|table-caption|flow-root)$/.test(cs.display || '')) return null;
    var d = n.ownerDocument || doc;
    if (d !== doc) return null;
    var t = null;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (c.nodeType === 3) { if (/\S/.test(c._data || '')) { t = c; break; } continue; }
      if (c.nodeType !== 1) continue;
      var ccs = computedOf(c);
      if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed' || (ccs.float && ccs.float !== 'none')) continue;
      // (a line that starts with an inline-level box: ::first-line's box
      // is a zero-width space before it)
      if (pe === 'first-line' && /^inline/.test(ccs.display || 'inline')) { t = { _data: '\u200b', __id: n.__id + 'plz', zw: c }; break; }
      return null;
    }
    if (!t) return null;
    var any = false, list = cascadeSheets(d);
    for (var q = 0; q < list.length; q++) if (list[q]._pseudo && !list[q].disabled) { any = true; break; }
    if (!any || !cascade(n, pe)) return null;
    var m = pe === 'first-line' ? /^(\s*\S+)/.exec(t._data) : /^(\s*[\p{P}]*\s*[^\s\p{P}][\p{P}]*)/u.exec(t._data);
    // (a line that does not wrap is the text's first line whole, up to a
    // preserved newline)
    var ws0 = cs['white-space'] || '';
    if (pe === 'first-line' && m && /^(nowrap|pre)$/.test(ws0)) m = ws0 === 'pre' ? /^([^\n]+)/.exec(t._data) : /^([\s\S]+)/.exec(t._data);
    if (!m) return null;
    var ps = computeStyle(n, cs, pe);
    var s = {};
    for (var k in ps) {
      if (k.charAt(0) === '_' || k === 'content') continue;
      var v = ps[k];
      if (INHERITED[k] && cs[k] === v) continue;
      if (!INHERITED[k] && INITIAL[k] === v) continue;
      s[k] = v;
    }
    s.display = pe === 'first-letter' && ps.float && ps.float !== 'none' ? 'block' : 'inline';
    if (pe === 'first-line') delete s.float;
    var box = { i: n.__id + 'pl', t: 'span', pe: 1, s: s, c: [{ i: n.__id + 'plt', x: m[1] }] };
    var rest = t._data.slice(m[1].length);
    if (t.zw) return { node: t.zw, box: box, rest: null, zw: true };
    return { node: t, box: box, rest: rest ? { i: t.__id, x: rest } : null };
  }
  // the children in the order they are painted: an absolutely placed one
  // with a z-index goes below the others (negative) or above them, as the
  // host draws in tree order and knows no z-index (React Flow's background
  // comes after its z-index: 2 viewport, a selected node gets 1000). In-flow
  // children keep their order, so the layout does not change.
  function paintOrder(src, vw) {
    var keyed = null;
    for (var i = 0; i < src.length; i++) {
      var e = src[i];
      if (vw && !vw.on[i] || e.nodeType !== 1) continue;
      var cs = computedOf(e);
      // (one with neither top nor bottom keeps its place: its static
      // position is under the boxes before it)
      var staticY = (!cs.top || cs.top === 'auto') && (!cs.bottom || cs.bottom === 'auto');
      if ((cs.position === 'absolute' || cs.position === 'fixed') && cs['z-index'] && cs['z-index'] !== 'auto' && !staticY) {
        var z = parseInt(cs['z-index'], 10) || 0;
        if (z !== 0) { if (!keyed) keyed = []; keyed[i] = z; }
      }
    }
    if (!keyed) return src;
    var idx = src.map(function (_, k) { return k; });
    idx.sort(function (a, b) { return ((keyed[a] || 0) - (keyed[b] || 0)) || a - b; });
    return idx.map(function (k) { return src[k]; });
  }
  // renderNode as JSON text; an element's text is kept with the styles it
  // was rendered with (styleGen: every change but a text's) and the last
  // text change under it (_rv), so a count-up's frame renders only the
  // numbers' paths, not the whole page
  // a text as its parent's text-transform draws it (CSS Text 3 2.1)
  function transformed(t, cs) {
    var tt = cs && cs['text-transform'];
    if (!tt || tt === 'none') return t;
    if (/uppercase/.test(tt)) t = t.toUpperCase();
    else if (/lowercase/.test(tt)) t = t.toLowerCase();
    else if (/capitalize/.test(tt)) t = t.replace(/(^|[^\p{L}\p{N}\p{M}'\u2019_])(\p{L})/gu, function (m, a, c) { return a + c.toUpperCase(); });
    if (/full-width/.test(tt)) t = t.replace(/[\u0021-\u007e ]/g, function (c) { return c === ' ' ? '\u3000' : String.fromCharCode(c.charCodeAt(0) + 0xfee0); });
    return t;
  }
  // ---- a delta render (renderDelta, for a host that keeps the last page) --
  // Each element's rendered text has a number ("n", in the delta's text of
  // it only). Once the host has been sent an element's text, a later render
  // in which nothing under it changed names it ({"r": number}) where the
  // whole subtree's text would be; the host puts the node it kept there.
  // So a frame's JSON is as long as what changed, not as the page, and the
  // host parses and compares that much.
  //   deltaOn      the host asked for delta renders
  //   deltaEpoch   what the host holds is counted from here (a host that
  //                lost a node asks for everything again: the next epoch)
  //   lastDelta    the delta text of what renderJson returned last
  //   renderDj     the delta text renderNode left for its element (no "n")
  //   marks        the renders whose text this render sends, noted as sent
  //                when the render is given to the host
  //   deltaCheck   a test's: the whole page goes along ("whole"), for the
  //                host to compare what it put together with
  var deltaCheck = false;
  //   deltaOff     > 0 under an element known to go whole (a table with
  //                collapsed borders): no delta texts are made under it
  var deltaOn = false, deltaEpoch = 1, deltaSerial = 0, lastDelta = '', renderDj = null, marks = [], deltaOff = 0;
  function deltaOf(k) {
    if (!k.json || deltaOff) { lastDelta = ''; return; }
    if (k.sent === deltaEpoch) { lastDelta = '{"r":' + k.n + '}'; return; }
    // (no delta text of its own: its whole text under its number)
    lastDelta = k.dj || '{"n":' + k.n + ',' + k.json.slice(1);
    marks.push(k);
  }
  // the renders noted since `from` are not sent as they are (their parent
  // goes whole): their delta texts are let go
  function unmark(from) {
    for (var i = from; i < marks.length; i++) marks[i].dj = null;
    marks.length = from;
  }
  // n's kept render (k) with a new transform: el.style.transform was the
  // only change at or under n since (attrChanged), and its style is the one
  // k was rendered with but for the transform (patchedStyle). The text k
  // has of n itself with the two values replaced, the children as they
  // are. 500 boxes moved each frame were each rendered whole (30 ms of a
  // frame natively). null: not so, renderNode then.
  var renderOwn = null, fastCheck = null;
  // (a style patched from another lists its properties in another order:
  // the same render)
  function sortedJson(t) {
    var srt = function (v) { if (Array.isArray(v)) return v.map(srt); if (v && typeof v === 'object') { var o = {}; Object.keys(v).sort().forEach(function (k) { o[k] = srt(v[k]); }); return o; } return v; };
    try { return JSON.stringify(srt(JSON.parse(t))); } catch (e) { return t; }
  }
  function movedJson(n, k, parentStyle, sc) {
    var fp = k.fp, cs = computedOf(n), df = cs._dfrom;
    if (!df || df.base !== fp.cs) return null;
    var pn = n._tfn;
    for (var dn in df.keys) if (dn !== pn) return null;
    var a = fp.cs[pn], b = cs[pn], st = n.getAttribute('style');
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || PLAIN_TEXT.test(b) || PLAIN_TEXT.test(st || '"') || fp.st === null) return null;
    // (with a transform, and less than opaque, before and after)
    if (pn === 'transform' ? a === 'none' || b === 'none' : !(parseFloat(a) < 1 && parseFloat(b) < 1 && parseFloat(a) > 0 && parseFloat(b) > 0)) return null;
    // (cut: fp.own around its two values, found once and the same for each
    // render after it)
    var cut = fp.cut && fp.cut.pn === pn ? fp.cut : null;
    if (!cut) {
      var own0 = fp.own, ta = '"' + pn + '":' + JSON.stringify(a), sa = '"style":' + JSON.stringify(fp.st);
      var i = own0.indexOf(ta), j = own0.indexOf(sa);
      if (i < 0 || j < i || own0.indexOf(ta, i + 1) >= 0 || own0.indexOf(sa, j + 1) >= 0) return null;
      cut = { pn: pn, pre: own0.slice(0, i) + '"' + pn + '":"', mid: '"' + own0.slice(i + ta.length, j) + '"style":"', post: '"' + own0.slice(j + sa.length, -1), kj: null, kd: null };
      var kids0 = fp.kids, kel0 = fp.kel, plain = true;
      for (var q0 = 0; q0 < kids0.length && plain; q0++) plain = !kel0[q0] || kel0[q0].nodeType !== 1;
      cut.kj = kids0.length ? ',"c":[' + kids0.join(',') + ']}' : '}';
      // (no element among the children: their delta text is their text)
      if (plain) cut.kd = cut.kj;
    }
    var open = cut.pre + b + cut.mid + st + cut.post, dm = marks.length, kd = cut.kd;
    if (kd === null) {
      var kids = fp.kids, kel = fp.kel, kdj = [];
      for (var q = 0; q < kids.length; q++) {
        var ke = kel[q];
        if (!ke || ke.nodeType !== 1) { kdj.push(kids[q]); continue; }
        var kk = ke._rj;
        if (!kk || kk.json !== kids[q] || kk.de !== deltaEpoch) { marks.length = dm; return null; }
        deltaOf(kk);
        kdj.push(lastDelta);
      }
      kd = ',"c":[' + kdj.join(',') + ']}';
    }
    var json = open + cut.kj;
    var nk = { sg: styleGen, rv: n._rv, ps: parentStyle, sc: sc, json: json, ct: false, parts: null, fp: { el: n, own: open + '}', kids: fp.kids, kel: fp.kel, cs: cs, st: st, cut: cut }, _dm: dm };
    nk.n = ++deltaSerial;
    nk.dj = '{"n":' + nk.n + ',' + open.slice(1) + kd;
    nk.sent = 0; nk.de = deltaEpoch;
    n._rjl = nk; n._rj = nk;
    deltaOf(nk);
    return json;
  }
  // (a text JSON.stringify would write otherwise than between two quotes)
  var PLAIN_TEXT = /["\\\x00-\x1f\u2028\u2029%]/;
  // VIRTUAL ROWS. The children of a box that stacks them one under the
  // other (block flow, a table's row group) whose boxes are more than a
  // viewport from the visible part of the page are not rendered: a run of
  // them stands as one box of their height (a spacer). Nothing else may
  // tell them apart from rendered ones, so a child is left out only when
  // its height is known exactly and nothing about it can reach the
  // viewport or change another box:
  // - its height: its own pitch (its top to the next one's) from the last
  //   layout, the subtree unchanged and laid at the same width since; else
  //   the pitch of a laid-out child of the same signature (virtSig: tags,
  //   classes, style attributes, the attributes selectors or layout look
  //   at), when no rule that depends on a child's position (nth-child, +,
  //   ~, :has, ...) and sets a property that changes boxes can match in it
  //   and each of its lines of text fits on one line with room to spare
  //   (virtFits), as the laid-out child's do;
  // - nothing in it is positioned, floated or transformed (it would draw
  //   outside its band), and its width cannot change the box's or a
  //   column's (the box's width does not come from its content; a table's
  //   columns are fixed or all in percentages, and its text fits them).
  // A child without a known height is rendered. On a first render none is
  // known: the first two of each signature and the ones near the viewport
  // by a guess are rendered, the others guessed (st.guess); the layout
  // then gives the heights and the box renders again before it is painted
  // (__virtAgain, the host's frame; reflow for a script's reads). After
  // every layout and scroll the plan is made again from the new boxes: a
  // child near the viewport left out, or a height other than the one used,
  // renders the box again. An element a script asks the geometry of is
  // rendered where it is (virtPin), as is the focused one.
  // A host turns them on (__virtRows(true)) when its frame renders again
  // while __virtAgain() says so, before it paints.
  var VIRT_GUESS = 24, virts = [], virtOn = false, virtAgain = false, virtR = { gen: -1 };
  G.__virtRows = function (on) { virtOn = !!on; changed(); return String(virtOn); };
  var vstat = { sig: 0, plan: 0, base: 0, again: 0, info: 0, rules: 0, why: [] };
  G.__virtStats = function () { var o = JSON.stringify(vstat); vstat = { sig: 0, plan: 0, base: 0, again: 0, info: 0, rules: 0, why: [] }; return o; };
  G.__virtAgain = function () { var a = virtAgain; virtAgain = false; return a ? '1' : ''; };
  G.__virtDbg = function () {
    var o = [];
    virts.forEach(function (st) {
      var p = st.plan; if (!p || p.on.length < 100) return;
      var cnt = {}, mode = 0, mc = 0;
      p.pitch.forEach(function (v) { cnt[v] = (cnt[v] || 0) + 1; if (cnt[v] > mc) { mc = cnt[v]; mode = v; } });
      var odd = []; p.pitch.forEach(function (v, i) { if (v !== mode && p.src[i]._attrs !== undefined) odd.push(i + ':' + v); });
      var runs = [], a = -1; for (var i = 0; i <= p.on.length; i++) { var on = i < p.on.length && p.on[i]; if (on && a < 0) a = i; if (!on && a >= 0) { runs.push(a + '-' + (i - 1)); a = -1; } }
      o.push('mode ' + mode + ' odd ' + odd.slice(0, 20).join(' ') + ' on ' + runs.join(','));
    });
    return o.join(' | ');
  };
  G.__virtState = function () {
    return JSON.stringify(virts.map(function (st) {
      var k = 0, p = st.plan;
      if (p) for (var i = 0; i < p.on.length; i++) if (p.on[i]) k++;
      var rf = {};
      for (var sg in st.refs) { var rr = st.refs[sg], f0 = p && p.src[0]; rf[sg.slice(0, 60)] = { pitch: rr.pitch, plain: rr.info.plain, W: rr.info.W, extra: rr.info.extra, fits0: f0 && f0._vsg ? virtFits(f0, rr.info) : null, t0: f0 && f0._vsg ? f0._vsg.t : null }; }
      return { n: p ? p.on.length : 0, rendered: k, guess: p ? p.guess : null, top: st.top, refs: p && p.on.length > 100 ? rf : Object.keys(st.refs).length, why: st.why };
    }));
  };
  // (properties that change no box: what only paints)
  var VIRT_PAINT = /^(color|opacity|cursor|visibility|caret-color|accent-color|fill|fill-opacity|stroke|stroke-opacity|stroke-width|filter|backdrop-filter|mix-blend-mode|isolation|clip-path|pointer-events|user-select|-webkit-user-select|-webkit-tap-highlight-color|will-change|text-shadow|box-shadow|z-index|transition|transition-[a-z-]+|background|background-[a-z-]+|outline|outline-[a-z-]+|text-decoration|text-decoration-[a-z-]+|border-color|border-(top|right|bottom|left)-color|border-radius|border-(top|bottom)-(left|right)-radius|border-(start|end)-(start|end)-radius|border-style|border-(top|right|bottom|left)-style|scrollbar-color|scrollbar-gutter)$/;
  var VIRT_POS = /^(nth-child|nth-last-child|nth-of-type|nth-last-of-type|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|has|empty)$/;
  // the page's rules as virtual rows see them: the ids and attributes
  // selectors look at, and the rules that depend on an element's place and
  // change boxes (matched by virtMatch)
  function virtRules() {
    if (virtR.gen === styleGen) return virtR;
    // (a class set somewhere restyles the page, styleGen: the rules are
    // the same, and so is what was learnt from them, fp)
    var rules = [], sheets = cascadeSheets(doc), fp = viewport.w + 'x' + viewport.h;
    for (var s = 0; s < sheets.length; s++) {
      var sh = sheets[s];
      if (!sh || sh.disabled || !sh._rules) continue;
      var tl = 0;
      for (var i = 0; i < sh._rules.length; i++) { var r = sh._rules[i]; tl += r.decls.length + (r.text ? r.text.length : 0); if (!r.media || mediaMatches(r.media)) rules.push(r); }
      fp += ',' + sh._order + ':' + sh._rules.length + ':' + tl;
    }
    if (virtR.fp === fp) { virtR.gen = styleGen; return virtR; }
    vstat.rules++;
    var R = { gen: styleGen, fp: fp, ids: {}, attrs: {}, pos: [] };
    // custom properties a box-changing property uses (and those they use)
    var geomVars = {}, deps = {}, VREF = /var\(\s*(--[A-Za-z0-9_-]+)/g, m, d, j;
    for (i = 0; i < rules.length; i++) {
      for (j = 0; j < rules[i].decls.length; j++) {
        d = rules[i].decls[j];
        var v = String(d.value);
        if (v.indexOf('var(') < 0) continue;
        VREF.lastIndex = 0;
        if (d.name.charCodeAt(0) === 45 && d.name.charCodeAt(1) === 45) { var dl = deps[d.name] || (deps[d.name] = []); while ((m = VREF.exec(v))) dl.push(m[1]); }
        else if (!VIRT_PAINT.test(d.name)) while ((m = VREF.exec(v))) geomVars[m[1]] = true;
      }
    }
    for (var more = true; more;) { more = false; for (var gv in geomVars) { var dd = deps[gv]; if (dd) for (j = 0; j < dd.length; j++) if (!geomVars[dd[j]]) { geomVars[dd[j]] = true; more = true; } } }
    for (i = 0; i < rules.length; i++) {
      var rr = rules[i], pos = { p: false };
      virtWalkSel(rr.sel, R, pos);
      if (!pos.p) {
        // (a ::before or ::after showing an attribute or a counter: as
        // wide as what it shows)
        if (!rr.sel.pseudo) continue;
        var shows = false;
        for (j = 0; j < rr.decls.length; j++) if (rr.decls[j].name === 'content' && /attr\(|counter/.test(String(rr.decls[j].value))) shows = true;
        if (!shows) continue;
      } else {
        var geom = false;
        for (j = 0; j < rr.decls.length && !geom; j++) {
          d = rr.decls[j];
          if (d.name.charCodeAt(0) === 45 && d.name.charCodeAt(1) === 45) geom = !!geomVars[d.name];
          else geom = !VIRT_PAINT.test(d.name);
        }
        if (!geom) continue;
      }
      R.pos.push(rr.sel);
    }
    virtR = R;
    return R;
  }
  function virtWalkSel(sel, R, pos) {
    for (var k = 0; k < sel.parts.length; k++) {
      var p = sel.parts[k];
      if (p.comb === '+' || p.comb === '~') pos.p = true;
      for (var q = 0; q < p.c.length; q++) {
        var s = p.c[q];
        if (s.t === 'id') R.ids[s.v] = true;
        else if (s.t === 'attr') R.attrs[s.n] = true;
        else if (s.t === 'pseudo') {
          if (VIRT_POS.test(s.n)) pos.p = true;
          if (s.list) for (var l = 0; l < s.list.length; l++) if (s.list[l] && s.list[l].parts) virtWalkSel(s.list[l], R, pos);
          if (s.of) for (var o = 0; o < s.of.length; o++) if (s.of[o] && s.of[o].parts) virtWalkSel(s.of[o], R, pos);
        }
      }
    }
  }
  function virtPosIn(sel) { var pos = { p: false }; virtWalkSel(sel, { ids: {}, attrs: {} }, pos); return pos.p; }
  // whether sel can match el, the child e (and the children reps stand
  // for, the others of its box) taken in any place: what depends on their
  // place (:nth-child() and the like, a :not(), :is() or :has() holding
  // one) left out of their compounds, a sibling before them by + or ~ any
  // of reps. Inside a child the places are the same in every child of its
  // signature, so they are matched as they are.
  function virtMatch(el, parts, k, e, reps) {
    var free = el === e || reps.indexOf(el) >= 0, c = parts[k].c;
    if (free) c = virtFree(c);
    if (!matchCompound(el, c, null)) return false;
    if (k + 1 >= parts.length) return true;
    var comb = parts[k].comb;
    if (comb === '>') { var p = upEl(el); return !!p && virtMatch(p, parts, k + 1, e, reps); }
    if (comb === ' ') {
      for (var a = upEl(el); a; a = upEl(a)) if (virtMatch(a, parts, k + 1, e, reps)) return true;
      return false;
    }
    if (free) {
      if (reps.over) return true;
      for (var r = 0; r < reps.length; r++) if (reps[r] !== el && virtMatch(reps[r], parts, k + 1, e, reps)) return true;
      return false;
    }
    if (comb === '+') { var s = siblingElement(el, -1); return !!s && virtMatch(s, parts, k + 1, e, reps); }
    if (comb === '~') {
      for (var t = siblingElement(el, -1); t; t = siblingElement(t, -1)) if (virtMatch(t, parts, k + 1, e, reps)) return true;
      return false;
    }
    return false;
  }
  function virtFree(c) {
    if (c._vfree) return c._vfree;
    var out = [];
    for (var q = 0; q < c.length; q++) {
      var s = c[q];
      if (s.t === 'pseudo' && (VIRT_POS.test(s.n) || ((s.list || s.of) && virtListPos(s)))) continue;
      out.push(s);
    }
    Object.defineProperty(c, '_vfree', { value: out, enumerable: false });
    return out;
  }
  function virtListPos(s) {
    var l = (s.list || []).concat(s.of || []);
    for (var i = 0; i < l.length; i++) if (l[i] && l[i].parts && virtPosIn(l[i])) return true;
    return false;
  }
  // a child's signature: what decides its style and boxes, other than its
  // place and its texts (null: one that cannot stand for another or be
  // stood for: a picture, a control, text in another script...). Its texts
  // go in c._vsg.t as [element index, width at 1000px, has a newline].
  var VIRT_ATTRS = { colspan: 1, rowspan: 1, width: 1, height: 1, size: 1, cols: 1, rows: 1, span: 1, align: 1, valign: 1, nowrap: 1, hidden: 1, dir: 1, lang: 1, type: 1, border: 1, cellpadding: 1, cellspacing: 1, start: 1, value: 1, face: 1, 'xml:lang': 1 };
  var VIRT_LEAF = { img: 1, input: 1, textarea: 1, select: 1, button: 1, br: 1, hr: 1, iframe: 1, canvas: 1, video: 1, audio: 1, svg: 1, object: 1, embed: 1, picture: 1, math: 1, slot: 1, template: 1, details: 1, dialog: 1, marquee: 1, progress: 1, meter: 1 };
  // a text's width at 1000px in the Helvetica table, its runs of white
  // space as one (-1: a character outside it)
  function virtTextW(t) {
    var w = 0, sp = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charCodeAt(i);
      if (ch === 32 || ch === 10 || ch === 9 || ch === 13 || ch === 12) { if (!sp) { w += CANVAS_W[0]; sp = true; } continue; }
      sp = false;
      if (ch > 32 && ch <= 126) w += CANVAS_W[ch - 32];
      else if (ch < 0x250 && ch >= 0xa0 || ch >= 0x2000 && ch <= 0x206f) w += canvasTextWidth(t.charAt(i), { size: 1000, weight: '400' });
      else return -1;
    }
    return w;
  }
  function virtSig(c, R) {
    var k = c._vsg;
    if (k && k.rv === c._rv && k.g === R.fp) return k.s;
    vstat.sig++;
    var out = '', texts = [], els = 0, ok = true;
    (function walk(e, pi) {
      if (!ok) return;
      var at = e._attrs;
      if (at === undefined) {
        var nt = e.nodeType;
        if (nt !== 3 && nt !== 4) return;
        var t = e._data;
        if (!t) return;
        var tw = virtTextW(t);
        if (tw < 0) { ok = false; return; }
        texts.push([pi, tw, t.indexOf('\n') >= 0]);
        out += '#' + pi;
        return;
      }
      // (a child of more than a few hundred elements is no row: a page's
      // table under its wrapper, walked at every render)
      if (els > 300 || e.namespaceURI !== HTML_NS || VIRT_LEAF[e.localName] === 1 || e._sr || e._ab || (e._waapi && e._waapi.length)) { ok = false; return; }
      var me = els++, s = '<' + e.localName;
      for (var a = 0; a < at.length; a++) {
        var nm = at[a].name, v = at[a]._v;
        if (nm === 'class') s += ' class=' + v;
        else if (nm === 'style') { if (v.indexOf('var(') >= 0) { ok = false; return; } s += ' style=' + v; }
        else if (nm === 'id') { if (R.ids[v]) s += ' id=' + v; }
        else { nm = nm.toLowerCase(); if (R.attrs[nm] || VIRT_ATTRS[nm] || nm === 'contenteditable') s += ' ' + nm + '=' + v; }
      }
      out += s;
      var kids = e._c;
      for (var j = 0; j < kids.length; j++) walk(kids[j], me);
      out += '>';
    })(c, -1);
    var sig = ok ? out : null;
    c._vsg = { rv: c._rv, g: R.fp, s: sig, t: texts };
    return sig;
  }
  function virtPx(v) { var f = parseFloat(v); return isFinite(f) ? f : 0; }
  // what a laid-out child of a signature tells the others: whether one may
  // stand for it (plain) and, per element, the width its lines have
  // (W, for a block's) and what takes room in them besides the text
  // (extra), the font of its text
  function virtRefInfo(e, R, tbl, reps) {
    vstat.info++;
    var els = [], ok = true;
    (function walk(x) {
      if (x.nodeType !== 1) return;
      els.push(x);
      for (var j = 0; j < x._c.length; j++) walk(x._c[j]);
    })(e);
    var info = { plain: false, W: [], extra: [], blockOf: [], fs: [], bold: [], pre: [] }, frow = [], free = [];
    for (var i = 0; i < els.length && ok; i++) {
      var x = els[i], c = computedOf(x), disp = c.display || 'inline';
      var tf = c.transform;
      if ((c.position && c.position !== 'static' && c.position !== 'relative') || (c.float && c.float !== 'none') || (tf && tf !== 'none') || (c.translate && c.translate !== 'none') || (c.rotate && c.rotate !== 'none') || (c.scale && c.scale !== 'none')) ok = false;
      if (c.position === 'relative' && ((c.top && c.top !== 'auto' && virtPx(c.top)) || (c.bottom && c.bottom !== 'auto' && virtPx(c.bottom)))) ok = false;
      if (disp === 'list-item' && c['list-style-position'] === 'inside') ok = false;
      // (a flex box of one line, in a row: as high as its highest item,
      // each item one line while all of them fit side by side)
      var fx = /^(inline-)?flex$/.test(disp) && /^row/.test(c['flex-direction'] || 'row') && (c['flex-wrap'] || 'nowrap') === 'nowrap';
      if (fx) frow[i] = 1;
      if (!fx && /^(inline-)?(flex|grid)$/.test(disp) || disp === 'contents' || /^ruby/.test(disp) || (c.columns && c.columns !== 'auto auto') || (c['column-count'] && c['column-count'] !== 'auto')) ok = false;
      // a rule that depends on the place and changes boxes, where it could match
      for (var r = 0; r < R.pos.length && ok; r++) if (virtMatch(x, R.pos[r].parts, 0, e, reps)) ok = false;
      var pi = i === 0 ? -1 : els.indexOf(x.parentNode);
      var item = pi >= 0 && frow[pi] && disp !== 'none', inl = !item && (disp === 'inline' || disp === 'inline-block');
      // (a block under an item as wide as its content: not known)
      if (pi >= 0 && free[pi] && !inl && disp !== 'none') ok = false;
      info.blockOf[i] = inl && pi >= 0 ? info.blockOf[pi] : i;
      info.fs[i] = virtPx(c['font-size']) || 16;
      info.bold[i] = parseInt(c['font-weight'], 10) >= 600;
      info.pre[i] = /^(pre|pre-wrap|pre-line|break-spaces)$/.test(c['white-space'] || '');
      var hor = virtPx(c['padding-left']) + virtPx(c['padding-right']) + virtPx(c['border-left-width']) + virtPx(c['border-right-width']);
      if (item) {
        // an item: its own block when its width is set, else its text is
        // counted in the flex box's line; the flex box's line holds each
        // item's outer width and the gaps between them
        var mar = Math.max(0, virtPx(c['margin-left'])) + Math.max(0, virtPx(c['margin-right']));
        var fw = /px$/.test(c.width || '') ? c.width : /px$/.test(c['flex-basis'] || '') ? c['flex-basis'] : null;
        var bb = c['box-sizing'] === 'border-box', pc = computedOf(x.parentNode), gap = virtPx(pc['column-gap'] || pc.gap);
        var outer = mar + (frow[pi]++ > 1 ? gap : 0);
        if (fw !== null) {
          var px = virtPx(fw);
          info.W[i] = bb ? px - hor : px;
          outer += bb ? px : px + hor;
          info.extra[i] = 0;
        } else {
          info.blockOf[i] = info.blockOf[pi];
          free[i] = true;
          outer += hor;
        }
        info.extra[pi] = (info.extra[pi] || 0) + outer;
      } else if (!inl) {
        var b = boxes[x.__id];
        // (a row of a collapsed table has no box: its cells have)
        if (!b) { if (disp !== 'none' && !/^table-row/.test(disp)) ok = false; info.W[i] = /^table-row/.test(disp) ? Infinity : 0; }
        else info.W[i] = b[2] - hor;
        info.extra[i] = 0;
      } else if (pi >= 0) {
        if (disp === 'inline-block' && /px$/.test(c.width || '')) ok = false;
        info.extra[info.blockOf[i]] = (info.extra[info.blockOf[i]] || 0) + hor + Math.max(0, virtPx(c['margin-left'])) + Math.max(0, virtPx(c['margin-right']));
      }
      // (what a ::before or ::after shows, as wide as it may be)
      if (pi >= -1 && ok) {
        for (var pk = 0; pk < 2; pk++) {
          var ps = cascade(x, pk ? 'after' : 'before'), ct = ps && ps.content;
          if (!ct || ct === 'none' || ct === 'normal') continue;
          var lit = /^(["'])(.*)\1$/.exec(String(ct).trim());
          if (!lit) { ok = false; break; }
          var w = 0, str = lit[2].replace(/\\([0-9a-fA-F]{1,6})\s?/g, function (m0, hx) { return String.fromCodePoint(parseInt(hx, 16)); }).replace(/\\(.)/g, '$1');
          for (var q = 0; q < str.length; q++) w += str.charCodeAt(q) < 0x250 ? canvasTextWidth(str.charAt(q), { size: 1000, weight: '400' }) : 1000;
          info.extra[info.blockOf[i]] = (info.extra[info.blockOf[i]] || 0) + w * info.fs[i] / 1000 * 1.5;
        }
      }
    }
    if (!ok) return info;
    // the child itself: a row of the table, or a box of the block flow
    // with no margins above or below (they would join with the spacer's)
    var rc = computedOf(e);
    if (tbl) {
      if (rc.display !== 'table-row') return info;
      // the columns: fixed, or every cell's width a percentage, together
      // the table's (their content then does not set them while it fits)
      var table = e.parentNode && e.parentNode.parentNode, tcs = table && table.nodeType === 1 ? computedOf(table) : null;
      if (!tcs || !/^(inline-)?table$/.test(tcs.display) || !(/(%|px)$/.test(tcs.width || '')) || !virtWidthStands(table.parentNode)) return info;
      if (tcs['table-layout'] !== 'fixed') {
        var sum = 0;
        for (var ci = 0; ci < e._c.length; ci++) {
          var cell = e._c[ci];
          if (cell.nodeType !== 1) continue;
          var cw = computedOf(cell).width || 'auto';
          if (!/%$/.test(cw)) return info;
          sum += parseFloat(cw);
        }
        if (sum < 99.9) return info;
      }
    } else {
      if (!/^(block|flow-root|list-item|table|flex)$/.test(rc.display) || virtPx(rc['margin-top']) || virtPx(rc['margin-bottom'])) return info;
    }
    info.plain = true;
    return info;
  }
  // a child of the signature info is for whose lines fit as one each
  function virtFits(c, info) {
    var t = c._vsg && c._vsg.t;
    if (!t) return false;
    // (the same texts against the same laid-out child: the same answer)
    var m = c._vft;
    if (m && m[0] === t && m[1] === info) return m[2];
    var r = virtFitsNow(t, info);
    c._vft = [t, info, r];
    return r;
  }
  function virtFitsNow(t, info) {
    var sum = [];
    for (var i = 0; i < t.length; i++) {
      var pi = t[i][0];
      if (pi < 0) return false;
      if (t[i][2] && info.pre[pi]) return false;
      var bk = info.blockOf[pi];
      sum[bk] = (sum[bk] || 0) + t[i][1] * info.fs[pi] / 1000 * (info.bold[pi] ? 1.06 : 1) * 1.5;
    }
    for (var b in sum) if (sum[b] + (info.extra[b] || 0) > info.W[b]) return false;
    // (an inline box with no text but what it shows: its own line)
    for (var e in info.extra) if (sum[e] === undefined && info.extra[e] > info.W[e]) return false;
    return true;
  }
  // a box whose width does not come from its content, all the way up
  function virtWidthStands(q) {
    for (; q && q.nodeType === 1 && q !== doc.documentElement; q = q.parentNode) {
      var c = computedOf(q), d = c.display || 'block';
      var p = q.parentNode && q.parentNode.nodeType === 1 ? computedOf(q.parentNode) : null, pd = p ? p.display || 'block' : 'block';
      if (/px$/.test(c.width || '')) return true;
      if ((c.position === 'absolute' || c.position === 'fixed') || (c.float && c.float !== 'none') || /^inline|^table-(cell|caption)|^table$/.test(d) && !/%$/.test(c.width || '')) return false;
      if (/^(inline-)?grid$/.test(pd)) return false;
      if (/^(inline-)?flex$/.test(pd)) {
        var col = /^column/.test(p['flex-direction'] || 'row');
        if (col) { if (!/^(normal|stretch)$/.test(p['align-items'] || 'normal') || !/^(auto|stretch|normal)$/.test(c['align-self'] || 'auto')) return false; }
        else if (!/^(0|0px|0%|[0-9.]+px)$/.test(c['flex-basis'] || 'auto')) return false;
      }
    }
    return true;
  }
  // what the box hands down to its children's boxes (a restyle makes new
  // style objects of the same values)
  var VIRT_INH = ['font-size', 'font-family', 'font-weight', 'font-style', 'line-height', 'white-space', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent', 'border-collapse', 'border-spacing', 'direction', 'writing-mode', 'visibility'];
  function virtInh(cs) { var o = ''; for (var i = 0; i < VIRT_INH.length; i++) o += (cs[VIRT_INH[i]] || '') + ';'; return o; }
  function virtDrop(n) { if (n._virt) n._virt = null; return null; }
  // the width the children were laid at (the nearest laid-out box's)
  function virtWidth(n) {
    for (var q = n; q && q.nodeType === 1; q = q.parentNode) { var b = boxes[q.__id]; if (b) return Math.round(b[2] * 100) / 100; }
    return -1;
  }
  // a child's band: [top, bottom] of its box, or of its children's (a row
  // of a collapsed table has none of its own)
  function virtBand(e) {
    var b = boxes[e.__id];
    if (b) return [b[1], b[1] + b[3]];
    var t = Infinity, u = -Infinity;
    for (var i = 0; i < e._c.length; i++) {
      var k = e._c[i];
      if (k.nodeType !== 1) continue;
      var kb = boxes[k.__id];
      if (kb) { if (kb[1] < t) t = kb[1]; if (kb[1] + kb[3] > u) u = kb[1] + kb[3]; }
    }
    return t <= u ? [t, u] : null;
  }
  // what the plan knows of each child apart from where the viewport is:
  // kept while the children, their subtrees, the width, the rules and what
  // the layouts told (st.ver) are the same, so a scroll over 10 000 rows
  // does not look into each of them again
  function virtBase(n, cs, src, st, R, wk, ctx) {
    var b = st.base, len = src.length, ws = cs['white-space'] || '', i, e;
    if (b && b.wk === wk && b.ctx === ctx && b.ver === st.ver && b.len === len && b.ws === ws) {
      for (i = 0; i < len; i++) { e = src[i]; if (b.src[i] !== e || b.rv[i] !== (e._attrs !== undefined ? e._rv : e._data)) break; }
      if (i === len) { vstat.base++; return b; }
    }
    var cull = new Array(len), pitch = new Array(len), pos = new Array(len + 1), unk = [], sigs = new Array(len), rv = new Array(len), seen = {}, guess = false;
    // (the guess for a child of no known height: one of the known ones)
    var g = VIRT_GUESS, tk = '|' + wk + '|' + ctx, tried = st.tried[tk];
    for (var rk in st.refs) { g = st.refs[rk].pitch; break; }
    pos[0] = 0;
    for (i = 0; i < len; i++) {
      e = src[i];
      var p = -1, cu = false;
      if (e._attrs === undefined) {
        rv[i] = e._data;
        // (white space between the rows: nothing; anything else: all of them)
        if ((e.nodeType === 3 || e.nodeType === 4) && !/[^ \t\n\r\f]/.test(e._data) && !/^pre|^break/.test(ws)) { cull[i] = true; pitch[i] = 0; pos[i + 1] = pos[i]; sigs[i] = null; continue; }
        st.base = null;
        return null;
      }
      rv[i] = e._rv;
      var sig = virtSig(e, R), ref = sig !== null ? st.refs[sig] : null;
      sigs[i] = sig;
      if (ref && (ref.wk !== wk || ref.ctx !== ctx)) ref = null;
      if (e._vp !== undefined && e._vpr === e._rv && e._vpk === tk) p = e._vp;
      if (ref && ref.info.plain && virtFits(e, ref.info)) { cu = true; if (p < 0) p = ref.pitch; }
      else if (sig !== null && !ref) {
        // (none of its kind laid out yet: the first two render, the
        // others are guessed until they are)
        var sn = seen[sig] = (seen[sig] || 0) + 1;
        if (sn > 2 && !(tried && tried[sig])) { cu = true; guess = true; if (p < 0) p = g; }
      }
      if (p < 0) { p = g; guess = true; unk[i] = true; }
      cull[i] = cu;
      e._vpi = i;
      pitch[i] = p;
      pos[i + 1] = pos[i] + p;
    }
    b = st.base = { wk: wk, ctx: ctx, ver: st.ver, len: len, ws: ws, src: src.slice(), rv: rv, cull: cull, pitch: pitch, pos: pos, unk: unk, sigs: sigs, guess: guess };
    return b;
  }
  function virtSameKids(a, b) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // which children render: the plan for n's children src now
  function virtPlan(n, cs, src, st) {
    vstat.plan++;
    var R = virtRules(), tbl = cs.display === 'table-row-group', len = src.length, i;
    var wk = virtWidth(n), act = doc._active, h = viewport.h, ctx = R.fp + '|' + virtInh(cs);
    var sv = tbl && st.sv ? st.sv : 0;
    var base = virtBase(n, cs, src, st, R, wk, ctx);
    if (!base) return null;
    var pitch = base.pitch, pos = base.pos, guess = base.guess, unk = base.unk, on = new Array(len);
    for (i = 0; i < len; i++) on[i] = !base.cull[i];
    // (a child a script asked the geometry of, and the one holding the
    // focused element: rendered)
    for (i = 0; i < st.pins.length; i++) { var pe = st.pins[i]; if (src[pe._vpi] === pe) on[pe._vpi] = true; }
    if (act) { for (var q = act; q && q.parentNode !== n; q = q.parentNode); if (q && src[q._vpi] === q) on[q._vpi] = true; }
    var top = st.top !== null ? st.top : (boxes[n.__id] ? boxes[n.__id][1] : null);
    var y0 = top === null ? null : scrollAbove(n) - top;
    // (the children rendered last still cover the viewport and half a
    // viewport either way: the same ones, so that a scroll renders the
    // rows again only every half viewport, not at each wheel turn)
    var last = st.plan;
    if (y0 !== null && last && last.wk === wk && virtSameKids(last.src, src)) {
      var lo2 = y0 - h / 2, hi2 = y0 + 1.5 * h, keep = true;
      for (i = 0; i < len && keep; i++) if (!last.on[i] && pos[i + 1] > lo2 && pos[i] < hi2 && src[i]._attrs !== undefined) keep = false;
      if (keep) { for (i = 0; i < len; i++) if (last.on[i]) on[i] = true; }
      else last = null;
    } else last = null;
    // near the viewport: a viewport above it to one below
    if (last) {}
    else if (y0 !== null) {
      var lo = y0 - h, hi = y0 + 2 * h;
      for (i = 0; i < len; i++) if (!on[i] && pos[i + 1] > lo && pos[i] < hi && src[i]._attrs !== undefined) on[i] = true;
    } else {
      // (where the box is not known yet: its first viewports, by the guess)
      for (i = 0; i < len && pos[i] < 2 * h; i++) if (src[i]._attrs !== undefined) on[i] = true;
      guess = true;
    }
    // (a rendered child of no known pitch: the next one renders too, so
    // that the layout gives its pitch)
    for (i in unk) { i = +i; if (on[i]) for (var nk = i + 1; nk < len; nk++) if (src[nk]._attrs !== undefined) { on[nk] = true; break; } }
    // the runs left out, as their heights: what the plan is known by
    var runs = [], a = -1;
    for (i = 0; i <= len; i++) {
      var off = i < len && !on[i];
      if (off && a < 0) a = i;
      if (!off && a >= 0) { runs.push(a + ':' + i + ':' + Math.round((pos[i] - pos[a]) * 100)); a = -1; }
    }
    return { on: on, pitch: pitch, pos: pos, guess: guess, wk: wk, sv: sv, key: runs.join(','), tbl: tbl, src: base.src, cs: cs, base: base };
  }
  // the spacer for children [a, b) of the plan
  function virtSpacer(plan, a, b) {
    var hgt = plan.pos[b] - plan.pos[a] - (plan.tbl ? plan.sv : 0);
    return '{"t":"div","s":{"display":"' + (plan.tbl ? 'table-row' : 'block') + '","height":"' + (Math.round(Math.max(0, hgt) * 100) / 100) + 'px"}}';
  }
  // the scroll offsets above (and of) n: a child at unscrolled y is in view
  // for y in [scrollAbove(n), scrollAbove(n) + viewport.h)
  function scrollAbove(n) {
    var sy = 0;
    for (var q = n; q && q._attrs !== undefined; q = q.parentNode) sy += q._sTop || 0;
    return sy;
  }
  // n's children at a render: the plan, or null for all of them
  function virtWindow(n, cs, src) {
    if (!virtOn || shadowCount || src.length < 2 || !doc) return virtDrop(n);
    var tbl = cs.display === 'table-row-group';
    if (!tbl && !/^(block|flow-root|list-item)$/.test(cs.display)) return virtDrop(n);
    if (!tbl && !virtWidthStands(n)) return virtDrop(n);
    // (under a transform the viewport is not where the boxes say)
    for (var q = n; q && q.nodeType === 1; q = q.parentNode) { var qc = computedOf(q), tf = qc.transform; if ((tf && tf !== 'none') || (qc.zoom && qc.zoom !== '1' && qc.zoom !== 'normal')) return virtDrop(n); }
    var st = n._virt;
    if (!st) { st = n._virt = { el: n, top: null, refs: {}, tried: {}, pins: [], plan: null, base: null, ver: 0, sv: 0, why: '' }; virts.push(st); }
    if (tbl) { var tb = n.parentNode && n.parentNode.nodeType === 1 ? computedOf(n.parentNode) : null; st.sv = tb && tb['border-collapse'] !== 'collapse' ? virtPx(String(tb['border-spacing'] || '0').split(/\s+/).pop()) : 0; }
    var plan = virtPlan(n, cs, src, st);
    if (!plan) return virtDrop(n);
    st.plan = plan;
    return plan;
  }
  // after a layout (measure) or a scroll: what the boxes say of the plans
  function virtCheck(measure) {
    for (var i = virts.length - 1; i >= 0; i--) {
      var st = virts[i], n = st.el, plan = st.plan;
      if (n._virt !== st || !n.isConnected) { virts.splice(i, 1); continue; }
      if (!plan) continue;
      var again = false, src = plan.src, len = src.length, R = virtRules();
      if (measure) {
        var wk = virtWidth(n), bands = new Array(len), j, reps = [], rseen = {}, ctx = R.fp + '|' + virtInh(computedOf(n)), tk = '|' + wk + '|' + ctx;
        // (the others of the box, one of each signature)
        var sigs = plan.base && plan.base.src === src ? plan.base.sigs : null;
        for (j = 0; j < len && !reps.over; j++) {
          var se = src[j];
          if (se._attrs === undefined) continue;
          var ss = sigs ? sigs[j] : virtSig(se, R);
          if (ss !== null && rseen[ss]) continue;
          if (ss !== null) rseen[ss] = true;
          reps.push(se);
          if (reps.length > 40) reps.over = true;
        }
        for (j = 0; j < len; j++) if (plan.on[j] && src[j]._attrs !== undefined) bands[j] = virtBand(src[j]);
        // where the box starts: a rendered child's top less what is above it
        st.top = null;
        for (j = 0; j < len; j++) if (bands[j]) { st.top = bands[j][0] - plan.pos[j]; break; }
        if (st.top === null && boxes[n.__id]) st.top = boxes[n.__id][1];
        // each rendered child's pitch: to the next one's top, or its height
        for (j = 0; j < len; j++) {
          if (!plan.on[j]) continue;
          var bd = bands[j], e = src[j];
          if (e._attrs === undefined) continue;
          var sig = virtSig(e, R), same = e._vpr === e._rv && e._vpk === tk;
          if (sig !== null) { var tr = st.tried[tk] || (st.tried[tk] = {}); if (!tr[sig]) { tr[sig] = true; st.ver++; } }
          // (nothing laid out: nothing to its height)
          if (!bd) { if (!boxes[e.__id] && (e._vp !== 0 || !same)) { e._vp = 0; e._vpr = e._rv; e._vpk = tk; st.ver++; } continue; }
          var nx = -1;
          for (var k = j + 1; k < len; k++) { if (!plan.on[k]) break; if (src[k]._attrs !== undefined) { nx = k; break; } }
          // (the last before a run left out: its height is not its pitch in
          // a collapsed table, the border below it is shared; the plan
          // renders the next one too while its pitch is not known)
          var p = nx >= 0 && bands[nx] ? bands[nx][0] - bd[0] : nx < 0 && k >= len ? bd[1] - bd[0] + st.sv : -1;
          // (the first after a run left out, in a table: the border above
          // it is not shared with a row as it is in the full table, so the
          // top of its band is not where it is there)
          if (p >= 0 && plan.tbl) { for (var pv = j - 1; pv >= 0 && src[pv]._attrs === undefined; pv--); if (pv >= 0 && !plan.on[pv]) p = -1; }
          if (p < 0) continue;
          if (e._vp !== p || !same) { e._vp = p; e._vpr = e._rv; e._vpk = tk; st.ver++; }
          if (sig === null) continue;
          var ref = st.refs[sig];
          if (!ref || ref.wk !== wk || ref.ctx !== ctx || !ref.info.plain) {
            var info = virtRefInfo(e, R, plan.tbl, reps);
            if (!ref || ref.wk !== wk || ref.ctx !== ctx || info.plain && virtFits(e, info)) { st.refs[sig] = { pitch: p, wk: wk, ctx: ctx, info: info, rel: virtRel(e, bd[0]) }; st.ver++; }
          }
        }
      }
      // the plan again from what is known now (a scroll changes nothing
      // that the plan is made of: no plan again for it)
      var np = measure ? virtPlan(n, plan.cs, src, st) : plan;
      if (!np) again = true;
      // (the same runs of the same heights: the render would be the same)
      else if (measure) again = np.key !== plan.key;
      else {
        // (a scroll: only when the viewport, half a viewport either way,
        // reaches a child left out)
        var y0 = st.top === null ? 0 : scrollAbove(n) - st.top, lo = y0 - viewport.h / 2, hi = y0 + 1.5 * viewport.h;
        for (j = 0; j < len && !again; j++) if (!plan.on[j] && plan.pos[j + 1] > lo && plan.pos[j] < hi && src[j]._attrs !== undefined) again = true;
      }
      if (again) {
        st.why = measure ? 'layout' : 'scroll';
        vstat.again++; if (vstat.why.length < 10) vstat.why.push(measure ? (np ? (np.key === plan.key ? 'g' : 'k') : 'n') : 's');
        generation++;
        textStamp++;
        for (var q = n; q; q = q.parentNode) q._rv = textStamp;
        if (measure) virtAgain = true;
      }
    }
  }
  // the boxes of a child's elements (in the order of virtSig's walk),
  // from its band's top: what a child of its signature left out has
  function virtRel(e, top) {
    var out = [];
    (function walk(x) {
      if (x.nodeType !== 1) return;
      // (an inline box is as wide as its text: none to lend; 0 asks for
      // the child to be rendered)
      var b = boxes[x.__id];
      out.push(/^inline/.test(computedOf(x).display || 'inline') ? 0 : b ? [b[0], b[1] - top, b[2], b[3]] : null);
      for (var j = 0; j < x._c.length; j++) walk(x._c[j]);
    })(e);
    return out;
  }
  // the box of an element in a child left out: its signature's laid-out
  // child's, where this child stands (null: not in one; false: one that
  // has no box, as the laid-out one's element had none)
  function virtBoxOf(el) {
    for (var q = el; q && q.parentNode && q.parentNode.nodeType === 1; q = q.parentNode) {
      var st = q.parentNode._virt;
      if (!st || !st.plan || st.top === null) continue;
      var plan = st.plan, ix = plan.src[q._vpi] === q ? q._vpi : -1;
      if (ix < 0 || plan.on[ix]) return null;
      var sig = q._vsg && q._vsg.s, ref = sig ? st.refs[sig] : null;
      if (!ref || !ref.rel) return null;
      var k = -1, found = false;
      (function walk(x) {
        if (found || x.nodeType !== 1) return;
        k++;
        if (x === el) { found = true; return; }
        for (var j = 0; j < x._c.length && !found; j++) walk(x._c[j]);
      })(q);
      if (!found) return null;
      var r = ref.rel[k];
      return r ? [r[0], st.top + plan.pos[ix] + r[1], r[2], r[3]] : r === 0 ? null : false;
    }
    return null;
  }
  // an element a script asks the geometry of, in a child left out: that
  // child renders (true: a layout is due)
  function virtPin(el) {
    for (var q = el; q && q.parentNode && q.parentNode.nodeType === 1; q = q.parentNode) {
      var st = q.parentNode._virt;
      if (!st || !st.plan) continue;
      var ix = st.plan.src[q._vpi] === q ? q._vpi : -1;
      if (ix < 0 || st.plan.on[ix]) continue;
      st.pins.push(q);
      if (st.pins.length > 64) st.pins.shift();
      generation++;
      textStamp++;
      for (var u = q.parentNode; u; u = u.parentNode) u._rv = textStamp;
      return true;
    }
    return false;
  }
  function renderJson(n, parentStyle) {
    if (n.nodeType === 3) { var tj = n._data ? JSON.stringify(smallCapsText(n, parentStyle)) : ''; lastDelta = tj; return tj; }
    if (n.nodeType !== 1) { lastDelta = ''; return ''; }
    var k = n._rj;
    // a script's scrollTop is no change (generation): the box's own say
    var sc = n._sTop || n._sLeft ? (n._sTop || 0) + ',' + (n._sLeft || 0) : '0,0';
    // (one whose render set or read a counter or a quote renders again:
    // what it shows and leaves to what follows depends on what came before;
    // a <ul> anywhere no longer renders the whole page again each frame)
    if (k && !k.ct && k.sg === styleGen && k.rv === n._rv && k.ps === parentStyle && k.sc === sc && (!deltaOn || k.de === deltaEpoch)) {
      if (deltaOn) deltaOf(k);
      return k.json;
    }
    // (kf: the last render of n, which a style change lets go of as _rj)
    var kf = deltaOn && n._tfv === n._rv ? n._rjl : null;
    if (kf && kf.fp && !deltaOff && !kf.ct && !kf.parts && kf.sg === styleGen && kf.ps === parentStyle && kf.sc === sc && kf.de === deltaEpoch && kf.rv >= n._tf0) {
      var moved = movedJson(n, kf, parentStyle, sc);
      if (moved !== null) {
        if (fastCheck) { var mdj = lastDelta, mk = n._rj; n._rj = null; n._rjl = null; n._tfv = 0; marks.length = mk._dm; var slow = renderJson(n, parentStyle); n._tfv = n._rv; fastCheck.n++; if (sortedJson(slow) !== sortedJson(moved) || sortedJson(lastDelta.replace(/^\{"n":\d+,/, '{')) !== sortedJson(mdj.replace(/^\{"n":\d+,/, '{'))) { fastCheck.bad++; if (!fastCheck.first) fastCheck.first = moved.slice(0, 400) + ' /// ' + slow.slice(0, 400) + ' /// ' + mdj.slice(0, 300) + ' /// ' + lastDelta.slice(0, 300); } return slow; }
        return moved;
      }
    }
    var t0 = ctrTouch;
    renderParts = null; renderDj = null; renderOwn = null;
    var dm = marks.length;
    var r = renderNode(n, parentStyle, true);
    var json = r === null ? '' : typeof r === 'string' ? r : JSON.stringify(r);
    var nk = { sg: styleGen, rv: n._rv, ps: parentStyle, sc: sc, json: json, ct: ctrTouch !== t0, parts: typeof r === 'string' ? renderParts : null, fp: typeof r === 'string' && renderOwn && renderOwn.el === n ? renderOwn : null };
    if (nk.fp) nk.fp.st = n.getAttribute('style');
    renderOwn = null;
    if (deltaOn) {
      // (rendered again to the same text, a restyle that changed nothing:
      // what the host has of it holds, under the number it had)
      var was = n._rjl;
      if (was && was.de === deltaEpoch && was.json === json) { nk.n = was.n; nk.dj = was.dj; nk.sent = was.sent; marks.length = dm; }
      else { nk.n = json ? ++deltaSerial : 0; nk.dj = json && renderDj !== null && typeof r === 'string' ? '{"n":' + nk.n + ',' + renderDj : null; nk.sent = 0; }
      nk.de = deltaEpoch;
      n._rjl = nk;
    }
    n._rj = nk;
    renderParts = null; renderDj = null;
    if (deltaOn) deltaOf(nk);
    return json;
  }
  // an inline <svg> as markup for the host's painter, each shape with the
  // paint the cascade gives it: a page's style sheet often sets fill and
  // stroke (`.icon path { fill: currentColor }`), which the markup alone
  // does not carry
  var SVG_PAINT = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity', 'fill-rule', 'stroke-linecap', 'stroke-linejoin'];
  var SVG_STOP = ['stop-color', 'stop-opacity'];
  // an outer <svg> without a viewBox draws its user units as pixels from
  // its top-left corner (and past its box: React Flow's edges are paths in
  // a 300 x 150 svg); written with its size in pixels, so the host's painter
  // does not fit the drawing's bounds into the box instead
  function svgUsedSize(n, cs, name, dflt) {
    var c = /^(-?[\d.]+)px$/.exec(cs[name] || '');
    if (c) return parseFloat(c[1]);
    var at = n.getAttribute(name);
    if (at !== null && /^\s*[\d.]+(px)?\s*$/.test(at)) return parseFloat(at);
    if (at !== null || (cs[name] && cs[name] !== 'auto')) return null;
    return dflt;
  }
  // svgs whose markup took their laid-out size (a pattern tiled over a
  // `100%` rect): drawn again when the size changes
  var boxSvgs = [];
  function svgBoxSize(svg) {
    var cs = computedOf(svg);
    var w = svgUsedSize(svg, cs, 'width', 300), h = svgUsedSize(svg, cs, 'height', 150);
    var b = boxes[svg.__id];
    if ((w === null || h === null) && !b) return null;
    if (boxSvgs.indexOf(svg) < 0) boxSvgs.push(svg);
    var r = { w: w !== null ? w : b[2], h: h !== null ? h : b[3] };
    svg._usedBox = r.w + ',' + r.h;
    return r;
  }
  function svgLength(v, total) {
    if (v === null || v === undefined || v === '') return 0;
    v = String(v).trim();
    return /%$/.test(v) ? parseFloat(v) / 100 * total : parseFloat(v) || 0;
  }
  // a shape filled with a <pattern> (userSpaceOnUse, its patternTransform a
  // translation), as React Flow's background dots, lines and crosses: the
  // pattern written out before the shape with its lengths resolved, its
  // translation in x and y, and its content serialized; the host's painter
  // keeps it as one command (EVG keepPatterns) where a tiling of the box
  // was thousands. '' when the tile has no size (the shape is not drawn),
  // null when the fill names no pattern.
  function patternDef(n, cs, outerSvg) {
    var m = /^url\(\s*["']?#([^"')]+)["']?\s*\)$/.exec(cs.fill || '');
    if (!m || !outerSvg) return null;
    var pat = null;
    eachElement(outerSvg, function (e) { if (!pat && e.localName === 'pattern' && e.getAttribute('id') === m[1]) pat = e; });
    if (!pat) return null;
    var size = svgBoxSize(outerSvg);
    if (!size) return '';
    var pw = svgLength(pat.getAttribute('width'), size.w), ph = svgLength(pat.getAttribute('height'), size.h);
    if (!(pw > 0.5) || !(ph > 0.5)) return '';
    var ox = svgLength(pat.getAttribute('x'), size.w), oy = svgLength(pat.getAttribute('y'), size.h);
    var pt = /translate\(\s*(-?[\d.e-]+)[\s,]*(-?[\d.e-]+)?\s*\)/.exec(pat.getAttribute('patternTransform') || '');
    if (pt) { ox += parseFloat(pt[1]) || 0; oy += parseFloat(pt[2]) || 0; }
    var body = '';
    for (var c = 0; c < pat._c.length; c++) body += serializeSvg(pat._c[c]);
    return '<pattern id="' + escapeAttr(m[1]) + '" patternUnits="userSpaceOnUse" x="' + fmtNum(ox) + '" y="' + fmtNum(oy) + '" width="' + fmtNum(pw) + '" height="' + fmtNum(ph) + '">' + body + '</pattern>';
  }
  // an svg's <text> (React Flow's edge labels): the host's SVG painter has
  // no text, so each one is a span placed over the picture where its
  // baseline is (x, y, dx, dy, text-anchor; the translations of the groups
  // around it), and the svg a box holding both
  function svgTextRuns(svg) {
    var runs = [];
    (function walk(e, m) {
      for (var i = 0; i < e._c.length; i++) {
        var c = e._c[i];
        if (c.nodeType !== 1 || c.localName === 'pattern' || c.localName === 'defs' || c.localName === 'clipPath' || c.localName === 'mask') continue;
        var cs = computedOf(c);
        if (cs.display === 'none') continue;
        var t = c.getAttribute('transform');
        var cm = m;
        if (t) { try { cm = m.multiply(new DOMMatrix(t)); } catch (err) { cm = m; } }
        if (c.localName === 'text') {
          if (cs.visibility === 'hidden') continue;
          var txt = c.textContent;
          if (!txt) continue;
          var size = parseFloat(cs['font-size']) || 16;
          var len = function (v) { if (!v) return 0; v = String(v).trim().split(/[\s,]+/)[0]; return /em$/.test(v) ? parseFloat(v) * size : parseFloat(v) || 0; };
          var x = len(c.getAttribute('x')) + len(c.getAttribute('dx')), y = len(c.getAttribute('y')) + len(c.getAttribute('dy'));
          var w = canvasTextWidth(txt, { size: size, weight: cs['font-weight'] || '400' });
          var anchor = c.getAttribute('text-anchor') || cs['text-anchor'];
          if (anchor === 'middle') x -= w / 2; else if (anchor === 'end') x -= w;
          var p = cm.transformPoint({ x: x, y: y });
          runs.push({ el: c, x: p.x, y: p.y, w: w, size: size * Math.sqrt(Math.abs(cm.a * cm.d - cm.b * cm.c)), cs: cs, text: txt });
        } else walk(c, cm);
      }
    })(svg, new DOMMatrix());
    return runs;
  }
  function svgTexts(n, o) {
    var runs = svgTextRuns(n);
    if (!runs.length) return;
    var size = svgBoxSize(n) || { w: 300, h: 150 };
    var box = { display: 'block', position: 'absolute', left: '0px', top: '0px', width: fmtNum(size.w) + 'px', height: fmtNum(size.h) + 'px' };
    var kids = [{ i: n.__id + 'c0', t: 'svg:svg', s: box, a: o.a && o.a.viewBox ? { viewBox: o.a.viewBox } : {}, svg: o.svg }];
    for (var j = 0; j < runs.length; j++) {
      var r = runs[j], cs = r.cs;
      var fill = cs.fill && !/^(none|url\()/.test(cs.fill) ? cs.fill : 'rgb(0, 0, 0)';
      var st = { display: 'block', position: 'absolute', left: fmtNum(r.x) + 'px', top: fmtNum(r.y - r.size * 0.89) + 'px', 'font-size': fmtNum(r.size) + 'px',
        'line-height': fmtNum(r.size) + 'px', 'font-family': cs['font-family'] || 'Arial', color: normalizeColor(fill), 'white-space': 'pre' };
      if (cs['font-weight'] && cs['font-weight'] !== '400') st['font-weight'] = cs['font-weight'];
      if (cs['font-style'] && cs['font-style'] !== 'normal') st['font-style'] = cs['font-style'];
      if (cs['fill-opacity'] && cs['fill-opacity'] !== '1') st.opacity = cs['fill-opacity'];
      kids.push({ i: n.__id + 'c' + (j + 1), t: 'span', s: st, c: [{ i: n.__id + 'c' + (j + 1) + 't', x: r.text }] });
    }
    delete o.svg;
    o.t = 'div';
    o.s = o.s || {};
    if (!o.s.position || o.s.position === 'static') o.s.position = 'relative';
    if (!o.s.display || o.s.display === 'inline') o.s.display = 'inline-block';
    o.s.width = fmtNum(size.w) + 'px';
    o.s.height = fmtNum(size.h) + 'px';
    o.c = kids;
  }
  // a path's marker-start / marker-end (React Flow's arrowheads, defined
  // in another svg of the page): the marker's content drawn at the path's
  // end, turned along it (orient auto), its viewBox fitted to markerWidth x
  // markerHeight, in stroke widths for markerUnits strokeWidth, as the
  // host's painter draws no markers
  function svgMarkers(n, cs) {
    if (n.localName !== 'path' && n.localName !== 'line' && n.localName !== 'polyline') return '';
    var out = '';
    var ends = { 'marker-start': 0, 'marker-end': 1 };
    for (var k in ends) {
      var ref = n.getAttribute(k) || cs[k];
      var m = /url\(\s*["']?#([^"')]+)["']?\s*\)/.exec(ref || '');
      if (!m || !doc) continue;
      var mk = doc.getElementById(m[1]);
      if (!mk || mk.localName !== 'marker') continue;
      var pts = svgEndPoints(n);
      if (!pts) continue;
      // the path's direction there; auto-start-reverse turns a start's round
      var at = ends[k] ? pts.end : pts.start;
      var ang = ends[k] ? Math.atan2(pts.end.y - pts.beforeEnd.y, pts.end.x - pts.beforeEnd.x) : Math.atan2(pts.afterStart.y - pts.start.y, pts.afterStart.x - pts.start.x);
      var orient = mk.getAttribute('orient') || '0';
      if (orient === 'auto-start-reverse' && !ends[k]) ang += Math.PI;
      else if (orient !== 'auto' && orient !== 'auto-start-reverse') ang = (parseFloat(orient) || 0) * Math.PI / 180;
      var vb = (mk.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat);
      var mw = parseFloat(mk.getAttribute('markerWidth')) || 3, mh = parseFloat(mk.getAttribute('markerHeight')) || 3;
      var unit = mk.getAttribute('markerUnits') === 'userSpaceOnUse' ? 1 : parseFloat(cs['stroke-width']) || 1;
      var sx = vb.length === 4 && vb[2] > 0 ? mw / vb[2] : 1, sy = vb.length === 4 && vb[3] > 0 ? mh / vb[3] : 1, sc = Math.min(sx, sy) * unit;
      var rx = parseFloat(mk.getAttribute('refX')) || 0, ry = parseFloat(mk.getAttribute('refY')) || 0;
      var c = Math.cos(ang) * sc, si = Math.sin(ang) * sc;
      // at the end point, turned and scaled, the marker's ref point on it
      var e = at.x - (c * rx - si * ry), f = at.y - (si * rx + c * ry);
      var body = '';
      for (var j = 0; j < mk._c.length; j++) body += serializeSvg(mk._c[j]);
      out += '<g transform="matrix(' + [c, si, -si, c, e, f].map(fmtNum).join(' ') + ')">' + body + '</g>';
    }
    return out;
  }
  // a path's first and last points and the ones beside them (its
  // direction there): from the numbers of its d, pairs as written (a curve's
  // control point gives the tangent)
  function svgEndPoints(n) {
    var nums;
    if (n.localName === 'line') nums = ['x1', 'y1', 'x2', 'y2'].map(function (a) { return parseFloat(n.getAttribute(a)) || 0; });
    else {
      var d = n.localName === 'path' ? n.getAttribute('d') : n.getAttribute('points');
      // (relative, H, V and A commands: not read)
      if (!d || /[aAhHvV]|[b-df-z]/.test(d)) return null;
      nums = (d.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(parseFloat);
    }
    if (nums.length < 4) return null;
    var p = function (i) { return { x: nums[i], y: nums[i + 1] }; };
    var L = nums.length - 2;
    var start = p(0), end = p(L);
    var afterStart = start, beforeEnd = end;
    for (var i = 2; i <= L; i += 2) { var q = p(i); if (q.x !== start.x || q.y !== start.y) { afterStart = q; break; } }
    for (var j = L - 2; j >= 0; j -= 2) { var r = p(j); if (r.x !== end.x || r.y !== end.y) { beforeEnd = r; break; } }
    return { start: start, end: end, afterStart: afterStart, beforeEnd: beforeEnd };
  }
  var SVG_PCT = { x: 'x', y: 'y', width: 'x', height: 'y', cx: 'x', cy: 'y', x1: 'x', x2: 'x', y1: 'y', y2: 'y', rx: 'x', ry: 'y', r: 'd' };
  function svgUrlPercents(url) {
    var comma = url.indexOf(',');
    if (comma < 0) return url;
    var head = url.slice(0, comma), body = url.slice(comma + 1), text;
    try { text = /;base64/i.test(head) ? atob(body) : decodeURIComponent(body.replace(/%(?![0-9a-fA-F]{2})/g, '%25')); } catch (e) { return url; }
    var at = text.indexOf('<svg');
    if (at < 0) return url;
    var end = text.indexOf('>', at);
    if (end < 0 || text.indexOf('%', end) < 0) return url;
    var root = text.slice(at, end);
    var attr = function (k) { var m = new RegExp('\\s' + k + '\\s*=\\s*([\'"])([^\'"]*)\\1').exec(root); return m ? m[2] : null; };
    var vb = (attr('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat), w, h;
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
    else { w = parseFloat(attr('width')) || 300; h = parseFloat(attr('height')) || 150; }
    var rest = text.slice(end).replace(/(\s)(x|y|width|height|cx|cy|r|rx|ry|x1|x2|y1|y2)(\s*=\s*)(['"])\s*(-?[\d.]+)%\s*\4/g, function (m, sp, k, eq, q, v) {
      var tot = /^(x|width|cx|rx|x1|x2)$/.test(k) ? w : /^(y|height|cy|ry|y1|y2)$/.test(k) ? h : Math.sqrt((w * w + h * h) / 2);
      return sp + k + eq + q + fmtNum(parseFloat(v) * tot / 100) + q;
    });
    return 'data:image/svg+xml,' + encodeURIComponent(text.slice(0, end) + rest);
  }
  function serializeSvg(n, outer) {
    if (n.nodeType === 3) return escapeText(n.data);
    if (n.nodeType !== 1) return '';
    if (n.localName === 'title' || n.localName === 'desc' || n.localName === 'style' || n.localName === 'script') return '';
    // a pattern is written before the shape filled with it (patternDef);
    // text goes over the picture as spans (svgTexts)
    if (n.localName === 'pattern' || n.localName === 'text' || n.localName === 'marker') return '';
    var cs = computedOf(n);
    if (cs.display === 'none') return '';
    var def = '';
    if (!outer && /^url\(/.test(cs.fill || '')) {
      def = patternDef(n, cs, n.ownerSVGElement && (function (o) { while (o.ownerSVGElement) o = o.ownerSVGElement; return o; })(n.ownerSVGElement));
      if (def === '') return '';
      if (def === null) def = '';
    }
    var color = cs.color || 'rgb(0, 0, 0)';
    var markers = svgMarkers(n, cs);
    var s = def + '<' + n._qname;
    var sized = false;
    if (outer && n.getAttribute('viewBox') === null) {
      var uw = svgUsedSize(n, cs, 'width', 300), uh = svgUsedSize(n, cs, 'height', 150);
      if (uw !== null && uh !== null) { s += ' width="' + uw + '" height="' + uh + '"'; sized = true; }
    }
    var box = null;
    for (var i = 0; i < n._attrs.length; i++) {
      var an = n._attrs[i].name;
      if (an === 'class' || an === 'style' || SVG_PAINT.indexOf(an) >= 0 || SVG_STOP.indexOf(an) >= 0) continue;
      if (sized && (an === 'width' || an === 'height')) continue;
      var av = n._attrs[i]._v;
      // a shape's length in % (React Flow's background rect, 100%) of the
      // outer svg's size, which the host's SVG parser does not resolve
      if (!outer && SVG_PCT[an] && /%\s*$/.test(av)) {
        if (box === null) { var o = n; while (o.ownerSVGElement) o = o.ownerSVGElement; var vb = (o.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat); box = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : svgBoxSize(o) || { w: 300, h: 150 }; }
        var tot = SVG_PCT[an] === 'x' ? box.w : SVG_PCT[an] === 'y' ? box.h : Math.sqrt((box.w * box.w + box.h * box.h) / 2);
        av = fmtNum(svgLength(av, tot));
      }
      s += ' ' + an + '="' + escapeAttr(av.replace(/currentColor/gi, color)) + '"';
    }
    // a gradient's <stop> takes its colour from the cascade too
    var paint = n.localName === 'stop' ? SVG_STOP : SVG_PAINT;
    for (var p = 0; p < paint.length; p++) {
      var v = cs[paint[p]];
      if (v === undefined || v === '') continue;
      if (/^currentcolor$/i.test(v)) v = color;
      s += ' ' + paint[p] + '="' + escapeAttr(String(v)) + '"';
    }
    s += '>';
    for (var j = 0; j < n._c.length; j++) s += serializeSvg(n._c[j]);
    return s + '</' + n._qname + '>' + markers;
  }
  function render(delta) {
    if (!doc || !doc.documentElement) return JSON.stringify({ v: generation, root: null });
    flushTree();
    ctr = {}; qDepth = 0;
    marks = []; deltaOff = 0;
    var root = renderJson(doc.documentElement, null);
    var rk = doc.documentElement._rj, dmr = marks.length, topsJson = '';
    // an editing host's caret, over everything (the top layer's place)
    var cb = editCaretBox();
    caretDrawn = cb ? JSON.stringify(cb) : null;
    // the top layer's boxes after everything else, children of the root
    if (root && (topLayer.length || cb)) {
      var rcs = computedOf(doc.documentElement), tops = [];
      for (var ti = 0; ti < topLayer.length; ti++) {
        var te = topLayer[ti];
        if (!te.isConnected || te.ownerDocument !== doc) continue;
        topNow = te;
        var bd = backdropBox(te);
        if (bd) { bd.tl = 1; tops.push(JSON.stringify(bd)); }
        var tr = renderNode(te, rcs, true);
        topNow = null;
        if (tr) { var to = typeof tr === 'string' ? JSON.parse(tr) : tr; to.tl = 1; tops.push(JSON.stringify(to)); }
      }
      if (cb) { cb.tl = 1; tops.push(JSON.stringify(cb)); }
      // (a top layer box goes whole each time, with what is under it)
      unmark(dmr);
      if (tops.length) {
        root = root.slice(-2) === ']}' ? root.slice(0, -2) + ',' + tops.join(',') + ']}' : root.slice(0, -1) + ',"c":[' + tops.join(',') + ']}';
        if (delta) topsJson = tops.join(',');
      }
    }
    if (delta) {
      var whole = deltaCheck ? root : '';
      // the page as the host is sent it: its root named when nothing
      // changed, else with every part the host has only named
      // (the top layer's boxes apart: the host puts them after the root's
      // children, as they are in the whole page)
      if (rk && rk.json) root = (rk.sent === deltaEpoch ? '{"r":' + rk.n + '}' : rk.dj || '{"n":' + rk.n + ',' + rk.json.slice(1)) + (topsJson ? ',"tops":[' + topsJson + ']' : '');
      for (var mi = 0; mi < marks.length; mi++) { var mk = marks[mi]; mk.sent = deltaEpoch; mk.dj = null; }
      marks = [];
      root = (root || 'null') + (whole ? ',"whole":' + whole : '') + ',"d":' + deltaEpoch;
    }
    var gone = goneEls ? ',"gone":' + goneEls : '';
    goneEls = 0;
    return '{"v":' + generation + gone + ',"w":' + JSON.stringify(viewport.w) + ',"h":' + JSON.stringify(viewport.h) + ',"root":' + (root || 'null') + ',"title":' + JSON.stringify(doc.title) + (doc.compatMode === 'BackCompat' ? ',"quirks":true' : '') + (browserFonts ? ',"fm":"' + (browserFonts === 'measure' ? 'measure' : 'browser') + '"' : '') + '}';
  }

  // ---- input from the host -------------------------------------------------

  var nodesById = {};
  function nodeById(id) {
    var found = null;
    if (!doc) return null;
    // a piece of a drawn canvas (canvasRender): the canvas
    if (typeof id === 'string' && /^\d+c\d+t?$/.test(id)) id = parseInt(id, 10);
    if (doc.__id === id) return doc;
    (function walk(n) {
      if (found) return;
      if (n.__id === id) { found = n; return; }
      for (var i = 0; i < n._c.length && !found; i++) walk(n._c[i]);
      if (n._sr && !found) walk(n._sr);
    })(doc);
    return found;
  }
  function elementOf(n) { while (n && n.nodeType !== 1) n = n.parentNode; return n; }
  // the pointer's cursor over the hovered element (CSS UI 4 cursor; auto is
  // text over a text field or text, default elsewhere, as a host draws it)
  G.__cursor = function () {
    var e = hoverEl;
    if (!e || !e.isConnected) return 'default';
    var c = String(computedOf(e).cursor || 'auto').split(',').pop().trim();
    if (c !== 'auto') return c;
    if (textEntry(e)) return 'text';
    return 'default';
  };
  var clickCount = 0, lastDown = 0, downTarget = null;
  function mods(m) { return { ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta }; }
  function mouseInit(m, extra) {
    var o = mods(m);
    o.bubbles = true; o.cancelable = true; o.composed = true; o.view = G; o._host = true;
    o.clientX = m.x || 0; o.clientY = m.y || 0; o.button = m.button || 0; o.buttons = m.buttons || 0;
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  function hostInput(m) {
    var target = m.target !== undefined ? elementOf(nodeById(m.target)) : null;
    // the host's node may not take the pointer (pointer-events: none, e.g.
    // a faded-out slide stacked over the shown one): the one under it does
    // or is not under the point at all: the host's hit test does not see
    // transforms (a node of a zoomed React Flow viewport), the boxes do
    if (m.x !== undefined && (!target || !hittable(target) || (transformedUnder(target) && !under(target, m.x, m.y)))) target = hitTest(m.x, m.y) || target;
    var t = m.type;
    // a release without the host's node ends the press where it began,
    // unless that is in transformed content (where the boxes are the truth)
    if (t === 'up' && m.target === undefined && downTarget && downTarget.isConnected && !transformedUnder(downTarget)) target = downTarget;
    // a press, release or key is a user gesture (window.open may follow)
    if ((t === 'down' || t === 'up' || t === 'key') && typeof G.__activate === 'function') G.__activate();
    if (t === 'leave') {
      // the pointer left the host's view: nothing is hovered
      if (hoverEl) {
        var gone = hoverEl;
        hoverEl = null;
        pointerStateChanged(gone, null);
        if (gone.isConnected) { dispatch(gone, new PointerEvent('pointerout', mouseInit(m, {}))); dispatch(gone, new MouseEvent('mouseout', mouseInit(m, {}))); leaveEnter(gone, null, m); }
      }
      return 'ok';
    }
    if (t === 'move') {
      if (picker && target && picker.kind === 'select') { var pmi = pickerItemOf(target); if (pmi && pmi._pickIndex !== undefined && pmi._pickIndex !== picker.at) pickerMark(pmi._pickIndex); }
      if (rangeDrag && rangeDrag.el.isConnected && m.x !== undefined) rangeAt(rangeDrag.el, m.x);
      var over = target || (doc && doc.documentElement);
      if (over !== hoverEl) {
        var old = hoverEl;
        hoverEl = over;
        pointerStateChanged(old, over);
        if (old && old.isConnected) { dispatch(old, new PointerEvent('pointerout', mouseInit(m, { relatedTarget: over }))); dispatch(old, new MouseEvent('mouseout', mouseInit(m, { relatedTarget: over }))); leaveEnter(old, over, m); }
        else leaveEnter(null, over, m);
        if (over) { dispatch(over, new PointerEvent('pointerover', mouseInit(m, { relatedTarget: old }))); dispatch(over, new MouseEvent('mouseover', mouseInit(m, { relatedTarget: old }))); }
      }
      if (over) { dispatch(over, new PointerEvent('pointermove', mouseInit(m, {}))); dispatch(over, new MouseEvent('mousemove', mouseInit(m, {}))); }
      return 'ok';
    }
    if (t === 'down' && picker) {
      var pit = target && pickerItemOf(target);
      if (pit && pit._pickAct) { pit._pickAct(); return 'ok'; }
      if (pit) { pickerChoose(pit._pickIndex); return 'ok'; }
      var onPicker = target && picker.box.contains(target), again = target && (target === picker.sel || picker.sel.contains(target));
      // (a calendar's or clock's own space between its choices keeps it)
      if (onPicker && picker.kind !== 'select') return 'ok';
      pickerClose();
      if (onPicker) return 'ok';
      if (again) return 'ok';
    }
    if (t === 'down') {
      if (!target) return 'no target';
      var nowT = now();
      clickCount = nowT - lastDown < 500 && downTarget === target ? clickCount + 1 : 1;
      lastDown = nowT;
      downTarget = target;
      var wasActive = activeEl;
      activeEl = target;
      pointerStateChanged(wasActive, target);
      var okp = dispatch(target, new PointerEvent('pointerdown', mouseInit(m, { buttons: 1, detail: clickCount })));
      var okm = okp && dispatch(target, new MouseEvent('mousedown', mouseInit(m, { buttons: 1, detail: clickCount })));
      if (okm) {
        // focus moves to the focusable element under the pointer
        var f = target;
        while (f && f.nodeType === 1 && !focusable(f) && !(f._sr && f._sr.delegatesFocus)) f = composedParent(f);
        doc._focusVisible = false;
        if (f && f.nodeType === 1) focusElement(f); else if (doc._active) focusElement(null);
        // (a select opens its option list)
        var ps = target;
        while (ps && ps.nodeType === 1 && ps.localName !== 'select') ps = ps.parentNode;
        if (ps && ps.nodeType === 1 && !ps.disabled && !ps.multiple && !(ps.size > 1)) pickerOpenFor(ps);
        else if (ps && ps.nodeType === 1 && !ps.disabled && (m.button || 0) === 0) listPress(ps, m);
        // (a date, time or color field opens its picker; a range's thumb
        // goes to the press; an editing host's caret to it)
        if (target.localName === 'input' && !target.disabled && (m.button || 0) === 0) {
          if (/^(date|time|datetime-local|month|week|color)$/.test(target.type) && !target.readOnly) popOpen(target);
          else if (target.type === 'range') { rangeDrag = { el: target, from: target.value }; rangeAt(target, m.x); }
        } else if (target.isContentEditable) editPress(target, m);
        if (isTextControl(target) && !/^(date|time|datetime-local|month|week)$/.test(target.type) && (m.button || 0) === 0) fieldPress(target, m);
      }
      return 'ok';
    }
    if (t === 'up') {
      var tgt = target || downTarget;
      if (!tgt) return 'no target';
      if (rangeDrag) { var rd = rangeDrag; rangeDrag = null; if (rd.el.isConnected && rd.el.value !== rd.from) dispatch(rd.el, new Event('change', { bubbles: true })); }
      dispatch(tgt, new PointerEvent('pointerup', mouseInit(m, { detail: clickCount })));
      dispatch(tgt, new MouseEvent('mouseup', mouseInit(m, { detail: clickCount })));
      var wasActive = activeEl;
      activeEl = null;
      pointerStateChanged(wasActive, null);
      var same = downTarget && (downTarget === tgt || downTarget.contains(tgt) || tgt.contains(downTarget));
      var clickOn = same ? (downTarget.contains(tgt) ? tgt : downTarget) : null;
      downTarget = null;
      if (clickOn && (m.button || 0) === 0) {
        if (!clickOn.disabled) {
          var ev = new PointerEvent('click', mouseInit(m, { detail: clickCount }));
          activatedClick(clickOn, ev);
          if (clickCount === 2) dispatch(clickOn, new MouseEvent('dblclick', mouseInit(m, { detail: 2 })));
        }
      } else if (clickOn && m.button === 2) {
        dispatch(clickOn, new MouseEvent('contextmenu', mouseInit(m, { button: 2 })));
      }
      return 'ok';
    }
    if (t === 'wheel') {
      var w = target || (doc && doc.body);
      if (!w) return 'ok';
      var okw = dispatch(w, new WheelEvent('wheel', mouseInit(m, { deltaX: m.dx || 0, deltaY: m.dy || 0 })));
      if (okw) scrollBy(w, m.dx || 0, m.dy || 0);
      return 'ok';
    }
    if (t === 'key' || t === 'keyup') {
      var k = doc && doc._active && doc._active.isConnected ? doc._active : doc && (doc.body || doc.documentElement);
      if (!k) return 'ok';
      var init = mods(m);
      init.key = m.key; init.code = m.code || codeOf(m.key); init.bubbles = true; init.cancelable = true; init.composed = true; init.view = G;
      if (t === 'keyup') { dispatch(k, new KeyboardEvent('keyup', init)); return 'ok'; }
      doc._focusVisible = true;
      var okd = dispatch(k, new KeyboardEvent('keydown', init));
      if (!okd) return 'ok';
      // a printable key types its character; `text` is what a key typed
      // when the host knows it (a character outside one UTF-16 unit)
      var typed = m.text !== undefined ? m.text : m.key.length === 1 && !m.ctrl && !m.meta ? m.key : null;
      if (typed !== null) {
        if (dispatch(k, new KeyboardEvent('keypress', init))) typeText(k, typed);
        return 'ok';
      }
      keyDefault(k, m);
      return 'ok';
    }
    if (t === 'text' || t === 'paste') {
      var a2 = doc && doc._active;
      if (!a2) return 'ok';
      if (t === 'paste') {
        var dt = new DataTransfer();
        dt.setData('text/plain', m.text);
        if (!dispatch(a2, new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))) return 'ok';
      }
      typeText(a2, m.text, t === 'paste' ? 'insertFromPaste' : 'insertText');
      return 'ok';
    }
    if (t === 'set') {
      // a form control's value from the host (an editor outside the page)
      if (!target) return 'no target';
      if (m.value !== undefined) target._value = String(m.value);
      if (m.checked !== undefined) target._checked = !!m.checked;
      changed();
      fireChange(target);
      return 'ok';
    }
    if (t === 'select') {
      // a text field's selection from the host (a click, a drag, a double
      // click on a word): the text before its anchor and before its focus
      if (!target || !isTextControl(target)) return 'no target';
      var tv = target.value;
      var fa = Math.min(String(m.focus || '').length, tv.length);
      var an = m.anchor === undefined ? fa : Math.min(String(m.anchor).length, tv.length);
      if (m.all) { an = 0; fa = tv.length; }
      if (m.word) {
        var isW = function (c) { return !/[\s.,;:!?()\[\]{}"'<>\/\\|+=*&^%$#@~`-]/.test(c); };
        an = fa; fa = an;
        if (an < tv.length && isW(tv.charAt(an)) || an > 0 && isW(tv.charAt(an - 1))) {
          while (an > 0 && isW(tv.charAt(an - 1))) an--;
          while (fa < tv.length && isW(tv.charAt(fa))) fa++;
        } else if (fa < tv.length) fa++;
      }
      if (doc._active !== target) focusElement(target);
      selectRange(target, an, fa);
      changed();
      if (an !== fa) dispatch(target, new Event('select', { bubbles: true }));
      return 'ok';
    }
    if (t === 'focus') { if (target) { doc._focusVisible = true; focusElement(target); } else focusElement(null); return 'ok'; }
    if (t === 'scroll') {
      if (target) { target.scrollLeft = m.left || 0; target.scrollTop = m.top || 0; dispatch(target, new Event('scroll', { bubbles: false })); scrolled(target); }
      return 'ok';
    }
    return 'unknown input ' + t;
  }
  function leaveEnter(from, to, m) {
    var fromChain = [], toChain = [];
    for (var a = from; a && a.nodeType === 1; a = a.parentNode) fromChain.push(a);
    for (var b = to; b && b.nodeType === 1; b = b.parentNode) toChain.push(b);
    for (var i = 0; i < fromChain.length; i++) if (toChain.indexOf(fromChain[i]) < 0) { dispatch(fromChain[i], new PointerEvent('pointerleave', mouseInit(m, { bubbles: false, relatedTarget: to }))); dispatch(fromChain[i], new MouseEvent('mouseleave', Object.assign(mouseInit(m, { relatedTarget: to }), { bubbles: false }))); }
    for (var j = toChain.length - 1; j >= 0; j--) if (fromChain.indexOf(toChain[j]) < 0) { dispatch(toChain[j], new PointerEvent('pointerenter', Object.assign(mouseInit(m, { relatedTarget: from }), { bubbles: false }))); dispatch(toChain[j], new MouseEvent('mouseenter', Object.assign(mouseInit(m, { relatedTarget: from }), { bubbles: false }))); }
  }
  // CSSOM View 7.1 scroll into view: each scroll container el is in, from
  // the nearest out, then the viewport, scrolls el's box to its block and
  // inline position (start, center, end, nearest), within its scroll range.
  // Boxes are the last layout's, in page coordinates before any scroll.
  function scrollIntoView(el, arg) {
    // (where it is now: cmdk scrolls its selected item into view in the
    // layout effect after Radix's accordion set its open height, and the
    // page came out 36 px short of the browser's)
    if (el.isConnected) reflow();
    var b = el.isConnected ? boxes[el.__id] : null;
    if (!b) return;
    var o = arg === false ? { block: 'end', inline: 'nearest' } : arg && typeof arg === 'object' ? arg : {};
    var block = o.block || 'start', inline = o.inline || 'nearest';
    function pos(start, size, view, cur, how, max) {
      var t;
      if (how === 'start') t = start;
      else if (how === 'end') t = start + size - view;
      else if (how === 'center') t = start + size / 2 - view / 2;
      else if (how === 'if-needed') t = start < cur || start + size > cur + view ? start + size / 2 - view / 2 : cur;
      else if (start < cur) t = size > view ? start + size - view : start;
      else if (start + size > cur + view) t = size > view ? start : start + size - view;
      else t = cur;
      return Math.max(0, Math.min(max, Math.round(t)));
    }
    // scroll between el and the container (what the inner containers moved)
    var inner = [];
    for (var n = composedParent(el); n && n.nodeType === 1; n = composedParent(n)) {
      var nb = boxes[n.__id];
      if (n === doc.documentElement || !nb) { inner.push(n); continue; }
      var cs = computedOf(n), oy = cs['overflow-y'] || 'visible', ox = cs['overflow-x'] || 'visible';
      if (/^(auto|scroll|hidden)$/.test(oy) || /^(auto|scroll|hidden)$/.test(ox)) {
        var e = edgesOf(n), sx = 0, sy = 0;
        for (var k = 0; k < inner.length; k++) { sx += inner[k].scrollLeft || 0; sy += inner[k].scrollTop || 0; }
        var top = b[1] - sy - nb[1] - e.bt, left = b[0] - sx - nb[0] - e.bl;
        var ch = sizeOf(n, 'ch'), cw = sizeOf(n, 'cw');
        var ny = /^(auto|scroll|hidden)$/.test(oy) ? pos(top, b[3], ch, n.scrollTop || 0, block, Math.max(0, sizeOf(n, 'sh') - ch)) : n.scrollTop || 0;
        var nx = /^(auto|scroll|hidden)$/.test(ox) ? pos(left, b[2], cw, n.scrollLeft || 0, inline, Math.max(0, sizeOf(n, 'sw') - cw)) : n.scrollLeft || 0;
        if (ny !== (n.scrollTop || 0) || nx !== (n.scrollLeft || 0)) { n.scrollTop = ny; n.scrollLeft = nx; scrolled(n); dispatch(n, new Event('scroll')); }
      }
      inner.push(n);
      // (a fixed box is the viewport's: what is around it and the page do
      // not move it. Radix Select scrolls its chosen item into view in its
      // fixed list, and the page jumped)
      if (nb && n !== doc.documentElement && computedOf(n).position === 'fixed') return;
    }
    if (computedOf(el).position === 'fixed') return;
    var root = doc && doc.documentElement;
    if (!root || (computedOf(root)['overflow-y'] || '') === 'hidden') return;
    var ry = 0;
    for (var m = composedParent(el); m && m.nodeType === 1 && m !== root; m = composedParent(m)) ry += m.scrollTop || 0;
    var dtop = pos(b[1] - ry, b[3], viewport.h, root.scrollTop || 0, block, Math.max(0, pageHeight() - viewport.h));
    if (dtop !== (root.scrollTop || 0)) { root.scrollTop = dtop; scrolled(root); dispatch(doc, new Event('scroll')); }
  }
  function scrollBy(el, dx, dy) {
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      var cs = computedOf(n);
      var b = boxes[n.__id];
      if (!b) continue;
      var can = (cs['overflow-y'] === 'auto' || cs['overflow-y'] === 'scroll') && (b[7] || 0) > (b[5] || b[3]);
      // (a list box scrolls its options, a line each)
      if (n.localName === 'select' && (n.multiple || n.size > 1)) {
        var le = edgesOf(n), lfs = parseFloat(cs['font-size']) || 13.333, llh = parseFloat(cs['line-height']);
        if (!(llh > 0)) llh = Math.round(lfs * 1.15);
        var lmax = Math.max(0, n.options.length * llh - (b[3] - le.by - le.py));
        var ltop = Math.max(0, Math.min(lmax, n.scrollTop + (dy > 0 ? Math.max(llh, Math.round(dy / llh) * llh) : Math.min(-llh, Math.round(dy / llh) * llh))));
        if (lmax > 0) { if (ltop !== n.scrollTop) { n.scrollTop = ltop; scrolled(n); dispatch(n, new Event('scroll')); } return; }
      }
      if (can) {
        var max = (b[7] || 0) - (b[5] || b[3]);
        var top = Math.max(0, Math.min(max, n.scrollTop + dy));
        if (top !== n.scrollTop) { n.scrollTop = top; scrolled(n); dispatch(n, new Event('scroll')); return; }
      }
    }
    // then the page itself (the viewport, whose scroll is the root's)
    var root = doc && doc.documentElement;
    if (!root || (computedOf(root)['overflow-y'] || '') === 'hidden') return;
    var dmax = Math.max(0, pageHeight() - viewport.h);
    var dtop = Math.max(0, Math.min(dmax, root.scrollTop + dy));
    if (dtop !== root.scrollTop) { root.scrollTop = dtop; scrolled(root); dispatch(doc, new Event('scroll')); }
  }
  // how tall the page's content is: the root's box and the body's bottom
  function pageHeight() {
    var root = doc && doc.documentElement, h = 0;
    var b = root && boxes[root.__id];
    if (b) h = Math.max(b[3] || 0, b[7] || 0);
    var body = doc && doc.body;
    var bb = body && boxes[body.__id];
    if (bb) h = Math.max(h, (bb[1] || 0) + (bb[3] || 0) + (parseFloat(computedOf(body)['margin-bottom']) || 0));
    return h;
  }
  function pageWidth() {
    var body = doc && doc.body, bb = body && boxes[body.__id];
    return bb ? Math.round(bb[0] + bb[2] + (parseFloat(computedOf(body)['margin-right']) || 0)) : 0;
  }
  function codeOf(k) {
    if (/^[a-zA-Z]$/.test(k)) return 'Key' + k.toUpperCase();
    if (/^\d$/.test(k)) return 'Digit' + k;
    if (k === ' ') return 'Space';
    return k;
  }
  // a control a press focuses with :focus-visible (it takes typed text)
  function textEntry(el) { return isTextControl(el) || !!(el && el.isContentEditable); }
  function isTextControl(el) {
    if (!el) return false;
    if (el.localName === 'textarea') return true;
    if (el.localName === 'input') return /^(text|search|tel|url|email|password|number|date|time|datetime-local|month|week)$/.test(el.type);
    return false;
  }
  // anchor and focus as a range with its direction
  function selectRange(el, anchor, focus) {
    el._ss = Math.min(anchor, focus);
    el._se = Math.max(anchor, focus);
    el._sd = focus < anchor ? 'backward' : anchor === focus ? 'none' : 'forward';
  }
  function typeText(el, text, kind) {
    kind = kind || 'insertText';
    if (isTextControl(el)) {
      if (el.readOnly || el.disabled) return;
      var before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, data: text, inputType: kind });
      if (!dispatch(el, before)) return;
      var v = el.value;
      var s = Math.min(el._ss, v.length), e = Math.min(el._se, v.length);
      if (el.localName === 'input') text = text.replace(/[\r\n]/g, '');
      var max = el.maxLength;
      if (max >= 0 && v.length - (e - s) + text.length > max) text = text.slice(0, Math.max(0, max - (v.length - (e - s))));
      el._value = v.slice(0, s) + text + v.slice(e);
      el._ss = el._se = s + text.length;
      el._sd = 'none';
      el._dirty = true;
      valueChanged(el);
      dispatch(el, new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: kind }));
      return;
    }
    if (el.isContentEditable) {
      if (!dispatch(el, new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, data: text, inputType: kind }))) return;
      editCommand(el, kind === 'insertText' ? 'inserttext' : kind === 'insertLineBreak' ? 'insertlinebreak' : 'insertparagraph', text);
    }
  }
  // document.execCommand's editing in the focused field or editing host,
  // as the browser's own typing (the value set as the browser sets it, not
  // through the value setter, which React's value tracker wraps)
  function editCommand(el, cmd, text) {
    if (!el) return false;
    if (el.localName === 'textarea' || (el.localName === 'input' && /^(text|search|tel|url|email|password|number)$/.test(el.type))) {
      if (el.readOnly || el.disabled) return false;
      var v = el.value, s = Math.min(el._ss, v.length), e = Math.min(el._se, v.length), kind = 'insertText';
      if (cmd === 'selectall') { el._ss = 0; el._se = v.length; el._sd = 'none'; selectionChanged(el); return true; }
      if (cmd === 'delete' || cmd === 'forwarddelete') {
        if (s === e) { if (cmd === 'delete' && s > 0) s--; else if (cmd === 'forwarddelete' && e < v.length) e++; }
        if (s === e) return true;
        text = '';
        kind = cmd === 'delete' ? 'deleteContentBackward' : 'deleteContentForward';
      } else if (cmd !== 'inserttext') { if (el.localName !== 'textarea') return false; text = '\n'; kind = cmd === 'insertlinebreak' ? 'insertLineBreak' : 'insertParagraph'; }
      if (el.localName === 'input') text = text.replace(/[\r\n]/g, '');
      if (el.type === 'number') text = text.replace(/[^0-9eE+\-.]/g, '');
      var max = el.maxLength;
      if (max >= 0 && v.length - (e - s) + text.length > max) text = text.slice(0, Math.max(0, max - (v.length - (e - s))));
      if (!text && s === e) return true;
      el._value = v.slice(0, s) + text + v.slice(e);
      el._ss = el._se = s + text.length;
      el._sd = 'none';
      el._dirty = true;
      valueChanged(el);
      // (Chromium gives no data for a line break typed as text)
      dispatch(el, new InputEvent('input', { bubbles: true, composed: true, data: kind === 'insertText' && text.indexOf('\n') < 0 ? text : null, inputType: kind }));
      return true;
    }
    if (el.isContentEditable) {
      if (cmd === 'selectall') { selection.selectAllChildren(el); return true; }
      var r = selection._ranges[0];
      if (!r || !el.contains(r.startContainer)) { r = new Range(el.ownerDocument || doc); r.selectNodeContents(el); r.collapse(false); }
      if (!r.collapsed && r.deleteContents) r.deleteContents();
      if (cmd === 'delete' || cmd === 'forwarddelete') {
        var tn = r.startContainer;
        if (tn.nodeType === 3) {
          var o = r.startOffset;
          if (cmd === 'delete' && o > 0) { tn.data = tn.data.slice(0, o - 1) + tn.data.slice(o); o--; }
          else if (cmd === 'forwarddelete' && o < tn.data.length) tn.data = tn.data.slice(0, o) + tn.data.slice(o + 1);
          selection.collapse(tn, o);
        }
        dispatch(el, new InputEvent('input', { bubbles: true, composed: true, inputType: cmd === 'delete' ? 'deleteContentBackward' : 'deleteContentForward' }));
        return true;
      }
      if (cmd !== 'inserttext') {
        var br = (el.ownerDocument || doc).createElement('br');
        r.insertNode ? r.insertNode(br) : el.appendChild(br);
        selection.collapse(br.parentNode, Array.prototype.indexOf.call(br.parentNode.childNodes, br) + 1);
        dispatch(el, new InputEvent('input', { bubbles: true, composed: true, inputType: cmd === 'insertlinebreak' ? 'insertLineBreak' : 'insertParagraph' }));
        return true;
      }
      var at = r.startContainer, off = r.startOffset, node;
      if (at.nodeType === 3) { at.data = at.data.slice(0, off) + text + at.data.slice(off); node = at; off += text.length; }
      else {
        var before = at.childNodes[off - 1];
        if (before && before.nodeType === 3) { node = before; off = before.data.length + text.length; before.data += text; }
        else { node = (el.ownerDocument || doc).createTextNode(text); at.insertBefore(node, at.childNodes[off] || null); off = text.length; }
      }
      selection.collapse(node, off);
      dispatch(el, new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      return true;
    }
    return false;
  }
  function keyDefault(el, m) {
    var k = m.key;
    // (Escape cancels the topmost modal dialog: cancel, then close)
    if (k === 'Escape' && !picker) {
      var md = topModal();
      if (md) { if (dispatch(md, new Event('cancel', { cancelable: true }))) md.close(); return; }
    }
    if (picker && picker.kind !== 'select' && (k === 'Escape' || k === 'Enter' || k === 'Tab')) { pickerClose(); if (k !== 'Tab') return; }
    if (k === 'Tab') {
      var order = tabOrder();
      if (!order.length) return;
      var i = order.indexOf(el);
      // (from an element that is no stop, a host's inner one or a
      // tabindex=-1 box: the stop it is in, else the next one after it)
      if (i < 0 && el && el.nodeType === 1 && el !== doc.body) {
        for (var q = 0; q < order.length; q++) if (composedContains(order[q], el) || composedContains(el, order[q])) { i = q; break; }
        if (i < 0) { for (q = 0; q < order.length; q++) if (el.compareDocumentPosition && (el.compareDocumentPosition(order[q]) & 4)) break; i = m.shift ? q : q - 1; }
      }
      var next = m.shift ? order[(i <= 0 ? order.length : i) - 1] : order[(i + 1) % order.length];
      focusElement(next);
      return;
    }
    if (el.localName === 'input' && el.type === 'number' && (k === 'ArrowUp' || k === 'ArrowDown') && !el.readOnly && !el.disabled) {
      var nw = el.value;
      try { stepValue(el, k === 'ArrowUp' ? 1 : -1); } catch (e0) {}
      if (el.value !== nw) fireChange(el);
      return;
    }
    if (isTextControl(el)) {
      var v = el.value, s = el._ss, e = el._se;
      if (k === 'Backspace' || k === 'Delete') {
        if (el.readOnly || el.disabled) return;
        if (s === e) { if (k === 'Backspace' && s > 0) s--; else if (k === 'Delete' && e < v.length) e++; }
        if (s === e) return;
        var kind = k === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward';
        if (!dispatch(el, new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: kind }))) return;
        el._value = v.slice(0, s) + v.slice(e);
        el._ss = el._se = s;
        el._dirty = true;
        valueChanged(el);
        dispatch(el, new InputEvent('input', { bubbles: true, composed: true, inputType: kind }));
        return;
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
        var back = el._sd === 'backward';
        var focusAt = back ? s : e, anchorAt = back ? e : s;
        var to = k === 'Home' ? 0 : k === 'End' ? v.length : k === 'ArrowLeft' ? (m.shift || s === e ? focusAt - 1 : s) : (m.shift || s === e ? focusAt + 1 : e);
        to = Math.max(0, Math.min(v.length, to));
        // Shift extends the selection from its anchor; else the caret moves
        if (m.shift) selectRange(el, anchorAt, to);
        else { el._ss = el._se = to; el._sd = 'none'; }
        changed();
        return;
      }
      if (k === 'Enter') {
        if (el.localName === 'textarea') { typeText(el, '\n', 'insertLineBreak'); return; }
        var f = el.form;
        if (f) { var sub = f.querySelector('button:not([type]),button[type=submit],input[type=submit]'); if (sub) sub.click(); else submitForm(el); }
        return;
      }
      if (m.ctrl || m.meta) {
        if (k === 'a') { el._ss = 0; el._se = v.length; changed(); }
      }
      return;
    }
    if (el.localName === 'input' && el.type === 'range' && !el.disabled && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(k)) {
      var rb = rangeBounds(el), was = el.value;
      if (k === 'Home') el.value = String(rb[0]);
      else if (k === 'End') el.value = String(rb[1]);
      else { try { stepValue(el, (k === 'ArrowRight' || k === 'ArrowUp' || k === 'PageUp' ? 1 : -1) * (/^Page/.test(k) ? Math.max(1, Math.round((rb[1] - rb[0]) / (stepOf(el) || 1) / 10)) : 1)); } catch (e) {} }
      if (el.value !== was) fireChange(el);
      return;
    }
    if (el.localName === 'input' && /^(date|time|datetime-local|month|week|color)$/.test(el.type) && !el.disabled && !el.readOnly && (k === ' ' || (m.alt && k === 'ArrowDown'))) { popOpen(el); return; }
    if (el.isContentEditable) {
      if (k === 'Backspace' || k === 'Delete') { editCommand(el, k === 'Backspace' ? 'delete' : 'forwarddelete'); return; }
      if (k === 'Enter') { editCommand(el, 'insertparagraph'); return; }
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') { editMove(el, k, m.shift); return; }
      if ((m.ctrl || m.meta) && k === 'a') { editCommand(el, 'selectall'); changed(); return; }
    }
    if ((k === 'Enter' && (el.localName === 'button' || el.localName === 'a' || (el.localName === 'input' && /^(button|submit|reset|checkbox|radio|file)$/.test(el.type) && el.type !== 'checkbox'))) || (k === ' ' && (el.localName === 'button' || (el.localName === 'input' && /^(button|submit|reset|checkbox|radio|file)$/.test(el.type))))) {
      el.click();
      return;
    }
    if (picker && picker.sel === el && picker.kind !== 'select') {
      if (k === 'Escape' || k === 'Enter') { pickerClose(); return; }
    }
    if (picker && picker.sel === el && picker.kind === 'select') {
      if (k === 'Escape') { pickerClose(); return; }
      if (k === 'Enter' || k === ' ') { pickerChoose(picker.at); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        var pi = picker.at + (k === 'ArrowDown' ? 1 : -1);
        if (pi >= 0 && pi < picker.items.length) pickerMark(pi);
        return;
      }
    }
    if (el.localName === 'select' && (k === 'Enter' || k === ' ' || (m.alt && (k === 'ArrowDown' || k === 'ArrowUp')))) { pickerOpenFor(el); return; }
    if (el.localName === 'select' && (k === 'ArrowDown' || k === 'ArrowUp')) {
      var opts = el.options, idx = el.selectedIndex + (k === 'ArrowDown' ? 1 : -1);
      if (idx >= 0 && idx < opts.length) { el.selectedIndex = idx; fireChange(el); }
    }
  }

  class DataTransfer {
    constructor() { this._d = {}; this.dropEffect = 'none'; this.effectAllowed = 'all'; this.files = []; this.items = []; }
    get types() { return Object.keys(this._d); }
    setData(t, v) { this._d[String(t).toLowerCase()] = String(v); }
    getData(t) { t = String(t).toLowerCase(); if (t === 'text') t = 'text/plain'; return this._d[t] || ''; }
    clearData(t) { if (t) delete this._d[t]; else this._d = {}; }
    setDragImage() {}
  }

  // ---- scripts -------------------------------------------------------------

  // a script element a page script inserted runs here: its text at once,
  // its src when the host has answered the fetch (the application's own
  // file; the sandbox has no network, so another URL fails), then load or
  // error on the element, as in a browser
  function scriptInserted(el) {
    if (el.getAttribute('type') && !/^(text\/javascript|application\/javascript|module|text\/babel)$/i.test(el.getAttribute('type'))) return;
    if (el._started) return;
    el._started = true;
    var src = el.getAttribute('src');
    if (src === null) { runScript(el, el.textContent); return; }
    loadResource(resolveURL(src), function (status, text) {
      if (status < 200 || status > 299) {
        if (G.console) G.console.warn('script ' + resolveURL(src) + ' not loaded: ' + (status ? 'HTTP ' + status : 'no network (a dashboard loads scripts from its application\'s own files)'));
        dispatch(el, new Event('error'));
        return;
      }
      // a page, not a script (an HTML answer for a path that is not a
      // script): an error, not a JavaScript syntax error from evaluating it
      if (/^\s*</.test(String(text))) {
        if (G.console) G.console.warn('script ' + resolveURL(src) + ' not loaded: it is an HTML page, not JavaScript');
        dispatch(el, new Event('error'));
        return;
      }
      runScript(el, text);
      dispatch(el, new Event('load'));
    });
  }
  // window's named properties: an element's id as a global (HTML
  // 7.2.2.3), for the names the global does not have already; looked up
  // when read, so a later element with that id is found too
  var namedIds = {};
  function exposeIds() {
    if (!doc) return;
    eachElement(doc, function (e) {
      var id = e.id;
      if (!id || namedIds[id] || !/^[A-Za-z_$][\w$]*$/.test(id) || id in G) return;
      namedIds[id] = true;
      try {
        Object.defineProperty(G, id, {
          configurable: true, enumerable: false,
          get: function () { var x = doc.getElementById(id); return x === null ? undefined : x; },
          set: function (v) { Object.defineProperty(G, id, { configurable: true, enumerable: true, writable: true, value: v }); }
        });
      } catch (err) { /* (a global that cannot be shadowed) */ }
    });
  }
  function runScript(el, text) {
    exposeIds();
    var prev = doc.currentScript;
    doc.currentScript = el;
    // in the global scope, as a classic script
    try { (0, eval)(String(text)); } catch (e) { reportError(e); }
    doc.currentScript = prev;
  }
  function scriptsOfPage() {
    var out = [];
    if (!doc) return '[]';
    exposeIds();
    eachElement(doc, function (e) {
      if (e.localName !== 'script' || e.namespaceURI !== HTML_NS) return;
      var type = e.getAttribute('type');
      if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type)) return;
      var src = e.getAttribute('src');
      var isModule = !!type && type.toLowerCase() === 'module';
      out.push({ id: e.__id, src: src, url: src ? resolveURL(src) : null, text: src ? null : e.textContent, defer: e.hasAttribute('defer') || isModule, async: e.hasAttribute('async'), module: isModule });
    });
    // classic scripts in order, deferred ones after
    return JSON.stringify(out.filter(function (s) { return !s.defer; }).concat(out.filter(function (s) { return s.defer; })));
  }
  function stylesOfPage() {
    var out = [];
    if (!doc) return '[]';
    eachElement(doc, function (e) {
      if (e.localName === 'link' && /(^|\s)stylesheet(\s|$)/i.test(e.getAttribute('rel') || '') && e.getAttribute('href')) out.push({ id: e.__id, href: e.getAttribute('href'), url: resolveURL(e.getAttribute('href')) });
    });
    return JSON.stringify(out);
  }

  // ---- URLs ----------------------------------------------------------------

  function parseURL(u) {
    var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)(?:\/\/(?:([^:@\/]*)(?::([^@\/]*))?@)?([^:\/?#]*)(?::(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(u));
    if (!m) return null;
    var protocol = m[1].toLowerCase();
    var host = m[4] || '';
    var port = m[5] || '';
    var special = /^(https?|ftp|wss?|file):$/.test(protocol);
    var path = m[6] || (special ? '/' : '');
    if (special) path = normalizePath(path);
    return {
      protocol: protocol, username: m[2] || '', password: m[3] || '', hostname: host.toLowerCase(), port: port,
      host: host.toLowerCase() + (port ? ':' + port : ''), pathname: path, search: m[7] && m[7] !== '?' ? m[7] : '', hash: m[8] && m[8] !== '#' ? m[8] : '',
      origin: special && protocol !== 'file:' ? protocol + '//' + host.toLowerCase() + (port ? ':' + port : '') : 'null', special: special, hasAuthority: m[4] !== undefined
    };
  }
  function normalizePath(p) {
    var segs = p.split('/'), out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === '..') { if (out.length > 1) out.pop(); if (i === segs.length - 1) out.push(''); }
      else if (s === '.') { if (i === segs.length - 1) out.push(''); }
      else out.push(s);
    }
    var r = out.join('/');
    return r.charAt(0) === '/' ? r : '/' + r;
  }
  function joinURL(rel, base) {
    rel = String(rel).trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(rel)) return rel;
    var b = parseURL(base);
    if (!b) return rel;
    var prefix = b.protocol + (b.hasAuthority || b.special ? '//' + (b.username ? b.username + (b.password ? ':' + b.password : '') + '@' : '') + b.host : '');
    if (rel.slice(0, 2) === '//') return b.protocol + rel;
    if (rel.charAt(0) === '#') return prefix + b.pathname + b.search + rel;
    if (rel.charAt(0) === '?') return prefix + b.pathname + rel;
    if (rel === '') return prefix + b.pathname + b.search;
    if (rel.charAt(0) === '/') return prefix + rel;
    var dir = b.pathname.replace(/[^\/]*$/, '');
    return prefix + dir + rel;
  }
  function resolveURL(u) {
    var base = doc ? doc._base || doc._url : 'about:blank';
    var j = joinURL(u, base);
    var p = parseURL(j);
    if (!p) return j;
    return p.protocol + (p.hasAuthority || p.special ? '//' + p.host : '') + p.pathname + p.search + p.hash;
  }

  class URLSearchParams {
    constructor(init) {
      this._l = [];
      if (init === undefined || init === null) return;
      if (typeof init === 'string') { this._parse(init); return; }
      if (init instanceof URLSearchParams) { this._l = init._l.map(function (p) { return p.slice(); }); return; }
      if (Array.isArray(init) || (init && typeof init[Symbol.iterator] === 'function')) { for (var p of init) this._l.push([String(p[0]), String(p[1])]); return; }
      for (var k in init) this._l.push([k, String(init[k])]);
    }
    _parse(s) {
      s = s.replace(/^\?/, '');
      if (!s) return;
      var parts = s.split('&');
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var e = parts[i].indexOf('=');
        var k = e < 0 ? parts[i] : parts[i].slice(0, e), v = e < 0 ? '' : parts[i].slice(e + 1);
        this._l.push([decodeForm(k), decodeForm(v)]);
      }
    }
    _update() { if (this._url) { var s = this.toString(); this._url._search = s ? '?' + s : ''; } }
    get size() { return this._l.length; }
    append(k, v) { this._l.push([String(k), String(v)]); this._update(); }
    delete(k, v) { this._l = this._l.filter(function (p) { return p[0] !== String(k) || (v !== undefined && p[1] !== String(v)); }); this._update(); }
    get(k) { for (var i = 0; i < this._l.length; i++) if (this._l[i][0] === String(k)) return this._l[i][1]; return null; }
    getAll(k) { return this._l.filter(function (p) { return p[0] === String(k); }).map(function (p) { return p[1]; }); }
    has(k, v) { return this._l.some(function (p) { return p[0] === String(k) && (v === undefined || p[1] === String(v)); }); }
    set(k, v) {
      k = String(k); v = String(v);
      var hit = false;
      this._l = this._l.filter(function (p) { if (p[0] !== k) return true; if (hit) return false; hit = true; p[1] = v; return true; });
      if (!hit) this._l.push([k, v]);
      this._update();
    }
    sort() { this._l.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); this._update(); }
    forEach(fn, t) { for (var i = 0; i < this._l.length; i++) fn.call(t, this._l[i][1], this._l[i][0], this); }
    keys() { return this._l.map(function (p) { return p[0]; })[Symbol.iterator](); }
    values() { return this._l.map(function (p) { return p[1]; })[Symbol.iterator](); }
    entries() { return this._l.map(function (p) { return [p[0], p[1]]; })[Symbol.iterator](); }
    toString() { return this._l.map(function (p) { return encodeForm(p[0]) + '=' + encodeForm(p[1]); }).join('&'); }
  }
  URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
  function decodeForm(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } }
  function encodeForm(s) { return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }

  class URL {
    constructor(u, base) {
      var s = String(u);
      if (base !== undefined) {
        var bp = parseURL(String(base));
        if (!bp) throw new TypeError("Failed to construct 'URL': Invalid base URL");
        s = joinURL(s, String(base));
      }
      var p = parseURL(s);
      if (!p || (p.special && p.protocol !== 'file:' && !p.hostname)) throw new TypeError("Failed to construct 'URL': Invalid URL");
      this._p = p;
      this._search = p.search;
      this._sp = null;
    }
    get protocol() { return this._p.protocol; }
    set protocol(v) { this._p.protocol = String(v).replace(/:?$/, ':'); }
    get username() { return this._p.username; }
    get password() { return this._p.password; }
    get host() { return this._p.host; }
    set host(v) { var m = String(v).split(':'); this._p.hostname = m[0]; this._p.port = m[1] || ''; this._p.host = String(v); }
    get hostname() { return this._p.hostname; }
    set hostname(v) { this._p.hostname = String(v); this._p.host = this._p.hostname + (this._p.port ? ':' + this._p.port : ''); }
    get port() { return this._p.port; }
    set port(v) { this._p.port = String(v); this._p.host = this._p.hostname + (this._p.port ? ':' + this._p.port : ''); }
    get pathname() { return this._p.pathname; }
    set pathname(v) { v = String(v); this._p.pathname = this._p.special ? normalizePath(v.charAt(0) === '/' ? v : '/' + v) : v; }
    get search() { return this._search; }
    set search(v) { v = String(v); this._search = v && v !== '?' ? (v.charAt(0) === '?' ? v : '?' + v) : ''; if (this._sp) { this._sp._l = []; this._sp._parse(this._search); } }
    get searchParams() { if (!this._sp) { this._sp = new URLSearchParams(this._search); this._sp._url = this; } return this._sp; }
    get hash() { return this._p.hash; }
    set hash(v) { v = String(v); this._p.hash = v && v !== '#' ? (v.charAt(0) === '#' ? v : '#' + v) : ''; }
    get origin() { return this._p.origin; }
    get href() {
      var p = this._p;
      var auth = p.hasAuthority || p.special ? '//' + (p.username ? p.username + (p.password ? ':' + p.password : '') + '@' : '') + p.host : '';
      return p.protocol + auth + p.pathname + this._search + p.hash;
    }
    set href(v) { var n = new URL(v); this._p = n._p; this._search = n._search; this._sp = null; }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  URL.canParse = function (u, b) { try { new URL(u, b); return true; } catch (e) { return false; } };
  URL.parse = function (u, b) { try { return new URL(u, b); } catch (e) { return null; } };
  var blobUrls = {};
  var blobId = 1;
  URL.createObjectURL = function (b) { var u = 'blob:' + (G.location ? G.location.origin : 'null') + '/' + (blobId++); blobUrls[u] = b; return u; };
  URL.revokeObjectURL = function (u) { delete blobUrls[u]; };

  // ---- text encoding, base64 -----------------------------------------------

  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s) {
      s = s === undefined ? '' : String(s);
      var out = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { var d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd; }
        else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
    encodeInto(s, dest) { var b = this.encode(s); var n = Math.min(b.length, dest.length); for (var i = 0; i < n; i++) dest[i] = b[i]; return { read: s.length, written: n }; }
  }
  class TextDecoder {
    constructor(label, opts) { this._enc = String(label || 'utf-8').toLowerCase(); this.fatal = !!(opts && opts.fatal); this.ignoreBOM = !!(opts && opts.ignoreBOM); }
    get encoding() { return this._enc === 'utf8' ? 'utf-8' : this._enc === 'utf-16' ? 'utf-16le' : this._enc; }
    decode(buf) {
      if (!buf) return '';
      var b = buf instanceof Uint8Array ? buf : buf.buffer ? new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength) : new Uint8Array(buf);
      if (this._enc === 'latin1' || this._enc === 'iso-8859-1' || this._enc === 'ascii' || this._enc === 'windows-1252') { var o = ''; for (var x = 0; x < b.length; x++) o += String.fromCharCode(b[x]); return o; }
      if (this._enc === 'utf-16le' || this._enc === 'utf-16' || this._enc === 'utf-16be') {
        // code units, two bytes each (Monaco's StringBuilder decodes its
        // Uint16Array this way); in pieces so fromCharCode's arguments stay few
        var be = this._enc === 'utf-16be', n = b.length >> 1, k = 0, parts = [], units = [];
        if (!this.ignoreBOM && n > 0 && (be ? (b[0] === 0xfe && b[1] === 0xff) : (b[0] === 0xff && b[1] === 0xfe))) k = 1;
        for (; k < n; k++) {
          units.push(be ? (b[2 * k] << 8) | b[2 * k + 1] : b[2 * k] | (b[2 * k + 1] << 8));
          if (units.length === 4096) { parts.push(String.fromCharCode.apply(null, units)); units = []; }
        }
        if (units.length) parts.push(String.fromCharCode.apply(null, units));
        if (b.length & 1) { if (this.fatal) throw new TypeError('The encoded data was not valid for encoding ' + this.encoding); parts.push('�'); }
        return parts.join('');
      }
      var out = '', i = 0;
      if (!this.ignoreBOM && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
      while (i < b.length) {
        var c = b[i++];
        var cp;
        if (c < 0x80) cp = c;
        else if (c >= 0xc2 && c < 0xe0 && i < b.length && (b[i] & 0xc0) === 0x80) { cp = ((c & 31) << 6) | (b[i++] & 63); }
        else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length && (b[i] & 0xc0) === 0x80 && (b[i + 1] & 0xc0) === 0x80) { cp = ((c & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63); i += 2; if (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000)) cp = -1; }
        else if (c >= 0xf0 && c < 0xf5 && i + 2 < b.length && (b[i] & 0xc0) === 0x80 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) { cp = ((c & 7) << 18) | ((b[i] & 63) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; if (cp < 0x10000 || cp > 0x10ffff) cp = -1; }
        else cp = -1;
        if (cp < 0) { if (this.fatal) throw new TypeError('The encoded data was not valid for encoding utf-8'); cp = 0xfffd; }
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function btoa(s) {
    s = String(s);
    var out = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw DOMException("Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.", 'InvalidCharacterError');
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63) + (i + 1 < s.length ? B64.charAt((n >> 6) & 63) : '=') + (i + 2 < s.length ? B64.charAt(n & 63) : '=');
    }
    return out;
  }
  function atob(s) {
    s = String(s).replace(/[\t\n\f\r ]/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+\/]/.test(s)) throw DOMException("Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.", 'InvalidCharacterError');
    var out = '', bits = 0, acc = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 6) | B64.indexOf(s.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); }
    }
    return out;
  }

  // ---- blobs, files, abort -------------------------------------------------

  class Blob {
    constructor(parts, opts) {
      this.type = (opts && opts.type) || '';
      var s = '';
      parts = parts || [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p instanceof Blob) s += p._s;
        else if (p instanceof ArrayBuffer || ArrayBuffer.isView(p)) s += new TextDecoder('latin1').decode(p);
        else s += unescape(encodeURIComponent(String(p)));
      }
      this._s = s;
    }
    get size() { return this._s.length; }
    text() { return Promise.resolve(new TextDecoder().decode(this._bytes())); }
    arrayBuffer() { return Promise.resolve(this._bytes().buffer); }
    _bytes() { var b = new Uint8Array(this._s.length); for (var i = 0; i < this._s.length; i++) b[i] = this._s.charCodeAt(i); return b; }
    slice(a, b, type) { var x = new Blob([], { type: type || this.type }); x._s = this._s.slice(a, b); return x; }
  }
  class File extends Blob {
    constructor(parts, name, opts) { super(parts, opts); this.name = String(name); this.lastModified = (opts && opts.lastModified) || Date.now(); }
  }
  class FileReader extends EventTarget {
    constructor() { super(); this.result = null; this.readyState = 0; this.error = null; }
    _done(r) { var self = this; setTimeout(function () { self.result = r; self.readyState = 2; var ev = new ProgressEvent('load'); if (self.onload) self.onload(ev); dispatch(self, ev); var e2 = new ProgressEvent('loadend'); if (self.onloadend) self.onloadend(e2); dispatch(self, e2); }, 0); }
    readAsText(b) { this._done(new TextDecoder().decode(b._bytes())); }
    readAsDataURL(b) { this._done('data:' + (b.type || 'application/octet-stream') + ';base64,' + btoa(b._s)); }
    readAsArrayBuffer(b) { this._done(b._bytes().buffer); }
    readAsBinaryString(b) { this._done(b._s); }
    abort() {}
  }
  class AbortSignal extends EventTarget {
    constructor() { super(); this.aborted = false; this.reason = undefined; this.onabort = null; }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static abort(reason) { var c = new AbortController(); c.abort(reason); return c.signal; }
    static timeout(ms) { var c = new AbortController(); setTimeout(function () { c.abort(DOMException('signal timed out', 'TimeoutError')); }, ms); return c.signal; }
    static any(list) { var c = new AbortController(); list.forEach(function (s) { if (s.aborted) c.abort(s.reason); else s.addEventListener('abort', function () { c.abort(s.reason); }); }); return c.signal; }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason) {
      var s = this.signal;
      if (s.aborted) return;
      s.aborted = true;
      s.reason = reason === undefined ? DOMException('signal is aborted without reason', 'AbortError') : reason;
      var ev = new Event('abort');
      if (s.onabort) s.onabort(ev);
      dispatch(s, ev);
    }
  }

  // ---- messaging, timers, frames -------------------------------------------

  var t0 = Date.now();
  function now() { return Date.now() - t0; }
  // User Timing: marks and measures kept as a browser keeps them (the last
  // 1000, so a page that never clears them stays bounded); measure takes
  // mark names or { start, end, duration } (Monaco's input latency reads
  // its measures back by name)
  var perfEntries = [];
  function perfAdd(e) { perfEntries.push(e); if (perfEntries.length > 1000) perfEntries.splice(0, perfEntries.length - 1000); return e; }
  function perfTime(v, dflt) {
    if (v === undefined || v === null) return dflt;
    if (typeof v === 'number') return v;
    for (var i = perfEntries.length - 1; i >= 0; i--) if (perfEntries[i].entryType === 'mark' && perfEntries[i].name === String(v)) return perfEntries[i].startTime;
    throw DOMException("Failed to execute 'measure' on 'Performance': The mark '" + v + "' does not exist.", 'SyntaxError');
  }
  function perfClear(type, n) { perfEntries = perfEntries.filter(function (e) { return e.entryType !== type || (n !== undefined && e.name !== String(n)); }); }
  var performance = {
    now: now, timeOrigin: t0,
    mark: function (n, o) { return perfAdd({ name: String(n), startTime: o && typeof o.startTime === 'number' ? o.startTime : now(), entryType: 'mark', duration: 0, detail: o && o.detail !== undefined ? o.detail : null }); },
    measure: function (n, a, b) {
      var st, en;
      if (a && typeof a === 'object') {
        en = a.end !== undefined ? perfTime(a.end) : a.start !== undefined && a.duration !== undefined ? perfTime(a.start) + a.duration : now();
        st = a.start !== undefined ? perfTime(a.start) : a.duration !== undefined ? en - a.duration : 0;
      } else { st = perfTime(a, 0); en = perfTime(b, now()); }
      return perfAdd({ name: String(n), startTime: st, duration: en - st, entryType: 'measure', detail: a && typeof a === 'object' && a.detail !== undefined ? a.detail : null });
    },
    getEntriesByName: function (n, type) { return perfEntries.filter(function (e) { return e.name === String(n) && (type === undefined || e.entryType === type); }); },
    getEntriesByType: function (type) { return perfEntries.filter(function (e) { return e.entryType === type; }); },
    getEntries: function () { return perfEntries.slice(); },
    clearMarks: function (n) { perfClear('mark', n); }, clearMeasures: function (n) { perfClear('measure', n); },
    timing: { navigationStart: t0 }, navigation: { type: 0 }
  };
  // a realm started from a snapshot of an earlier one (the host's code
  // cache): its clock starts now, not when the snapshot was taken
  G.__resume = function () {
    t0 = Date.now();
    performance.timeOrigin = t0;
    performance.timing.navigationStart = t0;
    return 'ok';
  };

  class MessagePort extends EventTarget {
    constructor() { super(); this._other = null; this._started = false; this._queue = []; this._closed = false; this._onmessage = null; }
    get onmessage() { return this._onmessage; }
    set onmessage(fn) { this._onmessage = fn; this.start(); }
    postMessage(data) {
      var o = this._other;
      if (!o || this._closed) return;
      var copy = structuredCloneImpl(data);
      setTimeout(function () { o._receive(copy); }, 0);
    }
    _receive(data) {
      if (this._closed) return;
      if (!this._started) { this._queue.push(data); return; }
      var ev = new MessageEvent('message', { data: data });
      if (this._onmessage) { try { this._onmessage.call(this, ev); } catch (e) { reportError(e); } }
      invoke(this, ev, 2);
    }
    start() { if (this._started) return; this._started = true; var q = this._queue; this._queue = []; for (var i = 0; i < q.length; i++) this._receive(q[i]); }
    close() { this._closed = true; }
  }
  class MessageChannel {
    constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); this.port1._other = this.port2; this.port2._other = this.port1; }
  }
  class BroadcastChannel extends EventTarget {
    constructor(name) { super(); this.name = name; this.onmessage = null; }
    postMessage() {}
    close() {}
  }

  function structuredCloneImpl(v, seen) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'symbol') throw DOMException((typeof v === 'function' ? (v.name || 'function') : 'Symbol()') + ' could not be cloned.', 'DataCloneError');
      return v;
    }
    seen = seen || new Map();
    if (seen.has(v)) return seen.get(v);
    var out;
    if (v instanceof Date) out = new Date(v.getTime());
    else if (v instanceof RegExp) out = new RegExp(v.source, v.flags);
    else if (v instanceof Map) { out = new Map(); seen.set(v, out); v.forEach(function (x, k) { out.set(structuredCloneImpl(k, seen), structuredCloneImpl(x, seen)); }); return out; }
    else if (v instanceof Set) { out = new Set(); seen.set(v, out); v.forEach(function (x) { out.add(structuredCloneImpl(x, seen)); }); return out; }
    else if (v instanceof ArrayBuffer) out = v.slice(0);
    else if (ArrayBuffer.isView(v)) out = new v.constructor(v);
    else if (v instanceof Error) { out = new (G[v.name] || Error)(v.message); if (v.stack) out.stack = v.stack; }
    else if (v instanceof Blob) out = v;
    else if (v instanceof Node) throw DOMException('Failed to execute \'postMessage\': ' + v.toString() + ' object could not be cloned.', 'DataCloneError');
    else if (Array.isArray(v)) { out = []; seen.set(v, out); for (var i = 0; i < v.length; i++) out[i] = structuredCloneImpl(v[i], seen); return out; }
    else {
      out = {};
      seen.set(v, out);
      var keys = Object.keys(v);
      for (var k = 0; k < keys.length; k++) out[keys[k]] = structuredCloneImpl(v[keys[k]], seen);
      return out;
    }
    seen.set(v, out);
    return out;
  }

  var frameCallbacks = [];
  var frameId = 1;
  function requestAnimationFrame(fn) {
    var id = frameId++;
    frameCallbacks.push({ id: id, fn: fn });
    if (frameCallbacks.length === 1) { if (typeof __frame === 'function') __frame(runFrame); else setTimeout(runFrame, 16); }
    return id;
  }
  function cancelAnimationFrame(id) { for (var i = 0; i < frameCallbacks.length; i++) if (frameCallbacks[i].id === id) { frameCallbacks.splice(i, 1); return; } }
  function runFrame() {
    var list = frameCallbacks;
    frameCallbacks = [];
    var t = now();
    for (var i = 0; i < list.length; i++) { try { list[i].fn(t); } catch (e) { reportError(e); } }
  }
  var idleId = 1;
  function requestIdleCallback(fn) { var id = idleId++; setTimeout(function () { fn({ didTimeout: false, timeRemaining: function () { return 50; } }); }, 1); return id; }
  function cancelIdleCallback() {}

  // ---- storage -------------------------------------------------------------

  function makeStorage() {
    var data = {};
    var s = {
      get length() { return Object.keys(data).length; },
      key: function (i) { var k = Object.keys(data); return i < k.length ? k[i] : null; },
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = {}; }
    };
    return s;
  }

  // ---- constraint validation (HTML 4.10.20) --------------------------------

  // a control's checks: valueMissing (required), typeMismatch (email, url),
  // patternMismatch, rangeUnderflow / rangeOverflow (number, range and the
  // date and time types by their text order), stepMismatch (number, range),
  // customError (setCustomValidity). tooLong / tooShort only follow a user's
  // edit in a browser: never set here.
  var EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  function willValidateOf(el) {
    var n = el.localName;
    if (n === 'input') { var t = el.type; if (/^(hidden|reset|button)$/.test(t)) return false; if (t !== 'submit' && t !== 'image' && el.hasAttribute('readonly')) return false; }
    else if (n === 'textarea') { if (el.hasAttribute('readonly')) return false; }
    else if (n === 'button') { if (el.type !== 'submit') return false; }
    else if (n !== 'select') return false;
    if (isDisabled(el)) return false;
    for (var p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.localName === 'datalist') return false;
    return true;
  }
  function validityOf(el) {
    var v = { valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: !!el._customValidity };
    if (willValidateOf(el)) {
      var n = el.localName, t = n === 'input' ? el.type : n, val = n === 'button' ? '' : String(el.value || ''), req = el.hasAttribute('required');
      if (req) {
        if (t === 'checkbox') v.valueMissing = !el.checked;
        else if (t === 'radio') {
          var name = el.getAttribute('name'), any = el.checked;
          if (name && !any) { var root = formOf(el) || el.ownerDocument || doc; if (root) root.querySelectorAll('input[type=radio]').forEach(function (o) { if (o.getAttribute('name') === name && o.checked) any = true; }); }
          v.valueMissing = !any;
        } else if (t === 'select') v.valueMissing = el.value === '';
        else if (n === 'textarea' || (n === 'input' && !/^(range|color|submit|image|reset|button|hidden)$/.test(t))) v.valueMissing = val === '';
      }
      if (n === 'input' && val !== '') {
        var multi = el.hasAttribute('multiple');
        if (t === 'email') v.typeMismatch = (multi ? val.split(',') : [val]).some(function (x) { return !EMAIL_RE.test(multi ? x.trim() : x); });
        else if (t === 'url') { try { new URL(val); } catch (e) { v.typeMismatch = true; } }
        var pat = el.getAttribute('pattern');
        if (pat !== null && /^(text|search|tel|url|email|password)$/.test(t)) {
          try { var re = new RegExp('^(?:' + pat + ')$', 'v'); v.patternMismatch = (multi && t === 'email' ? val.split(',') : [val]).some(function (x) { return !re.test(x.trim ? (multi ? x.trim() : x) : x); }); }
          catch (e2) { try { var re2 = new RegExp('^(?:' + pat + ')$', 'u'); v.patternMismatch = !re2.test(val); } catch (e3) {} }
        }
        var mn = el.getAttribute('min'), mx = el.getAttribute('max');
        if (t === 'number' || t === 'range') {
          var x = parseFloat(val);
          if (isNaN(x)) v.badInput = t === 'number';
          else {
            if (mn !== null && !isNaN(parseFloat(mn)) && x < parseFloat(mn)) v.rangeUnderflow = true;
            if (mx !== null && !isNaN(parseFloat(mx)) && x > parseFloat(mx)) v.rangeOverflow = true;
            var st = el.getAttribute('step');
            if (st === null || st.toLowerCase() !== 'any') {
              var step = st !== null && parseFloat(st) > 0 ? parseFloat(st) : 1, base = mn !== null && !isNaN(parseFloat(mn)) ? parseFloat(mn) : 0;
              var q = (x - base) / step;
              if (Math.abs(q - Math.round(q)) > 1e-9) v.stepMismatch = true;
            }
          }
        } else if (/^(date|month|week|time|datetime-local)$/.test(t)) {
          if (mn !== null && mn !== '' && val < mn) v.rangeUnderflow = true;
          if (mx !== null && mx !== '' && val > mx) v.rangeOverflow = true;
        }
      }
      for (var k in v) if (k !== 'valid' && v[k]) v.valid = false;
    } else v.customError = false;
    if (v.customError) v.valid = false;
    return v;
  }
  var VALIDATION_MSG = { valueMissing: 'Please fill out this field.', typeMismatch: 'Please enter a valid value.', patternMismatch: 'Please match the requested format.', rangeUnderflow: 'Value must be greater than or equal to the minimum.', rangeOverflow: 'Value must be less than or equal to the maximum.', stepMismatch: 'Please enter a valid value.', badInput: 'Please enter a number.' };
  function controlInvalid(el) { if (el._internals && el.constructor.formAssociated) return el._internals.willValidate && !el._internals.validity.valid; return willValidateOf(el) && !validityOf(el).valid; }
  // a form or fieldset is :invalid when a control it holds is
  function groupInvalid(g) {
    var bad = false;
    var list = g.localName === 'form' ? g.elements : g.querySelectorAll('input,select,textarea,button');
    for (var i = 0; i < list.length && !bad; i++) if (list[i].localName !== 'fieldset' && controlInvalid(list[i])) bad = true;
    return bad;
  }
  function checkOne(el) {
    if (!controlInvalid(el)) return true;
    dispatch(el, new Event('invalid', { cancelable: true }));
    return false;
  }
  function validationApi(C) {
    var p = C.prototype;
    Object.defineProperty(p, 'validity', { configurable: true, get: function () { return validityOf(this); } });
    Object.defineProperty(p, 'willValidate', { configurable: true, get: function () { return willValidateOf(this); } });
    Object.defineProperty(p, 'validationMessage', { configurable: true, get: function () {
      if (!willValidateOf(this)) return '';
      var v = validityOf(this);
      if (v.customError) return this._customValidity;
      for (var k in VALIDATION_MSG) if (v[k]) return VALIDATION_MSG[k];
      return '';
    } });
    p.checkValidity = function () { return checkOne(this); };
    p.reportValidity = function () { return checkOne(this); };
    p.setCustomValidity = function (m) { var was = !!this._customValidity; this._customValidity = String(m === undefined ? '' : m); if (was !== !!this._customValidity) validityChanged(this); };
  }
  [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement].forEach(validationApi);
  [HTMLFormElement, HTMLFieldSetElement].forEach(function (C) {
    C.prototype.checkValidity = function () {
      var ok = true, list = this.localName === 'form' ? this.elements : this.querySelectorAll('input,select,textarea,button');
      for (var i = 0; i < list.length; i++) if (list[i].localName !== 'fieldset' && !checkOne(list[i])) ok = false;
      return ok;
    };
    C.prototype.reportValidity = C.prototype.checkValidity;
  });

  // ---- custom elements -----------------------------------------------------

  var customElementsRegistry = {};
  var whenDefinedWaits = {};
  // the element an upgrade's constructor returns (HTMLElement's constructor)
  var upgrading = null;
  // the elements named `name` in the page, its shadow trees too, in tree
  // order (HTML 4.13.4 define, step 16)
  function upgradeCandidates(root, name, out) {
    eachElement(root, function (e) {
      if (e.localName === name && !e._ce) out.push(e);
      if (e._sr) upgradeCandidates(e._sr, name, out);
    });
    return out;
  }
  // HTML 4.13.5 upgrade: the element takes the class's prototype, its
  // constructor runs on it, then attributeChangedCallback for each observed
  // attribute it has and connectedCallback when it is in the page
  function upgradeElement(e, cls) {
    if (e._ce) return;
    e._ce = true;
    Object.setPrototypeOf(e, cls.prototype);
    upgrading = e;
    try { Reflect.construct(cls, [], cls); } catch (err) { reportError(err); }
    upgrading = null;
    var observed = cls.observedAttributes || [], attr = cls.prototype.attributeChangedCallback;
    if (attr) for (var i = 0; i < observed.length; i++) {
      var n = String(observed[i]);
      if (e.hasAttribute(n)) { try { attr.call(e, n, null, e.getAttribute(n)); } catch (err2) { reportError(err2); } }
    }
    if (e.isConnected && e._connected) { try { e._connected(); } catch (err3) { reportError(err3); } }
  }
  function customName(cls) {
    for (var n in customElementsRegistry) if (customElementsRegistry[n] === cls) return n;
    return 'unknown-element';
  }
  var customElements = {
    define: function (name, cls) {
      if (customElementsRegistry[name]) throw DOMException("Failed to execute 'define' on 'CustomElementRegistry': the name \"" + name + '" has already been used with this registry', 'NotSupportedError');
      customElementsRegistry[name] = cls;
      var p = cls.prototype;
      var conn = p.connectedCallback, disc = p.disconnectedCallback, attr = p.attributeChangedCallback;
      var observed = cls.observedAttributes || [];
      if (conn) p._connected = function () { conn.call(this); };
      if (disc) p._disconnected = function () { disc.call(this); };
      if (attr) p._attrHook = function (n, o, v) { if (observed.indexOf(n) >= 0) attr.call(this, n, o, v); };
      if (doc) {
        var found = upgradeCandidates(doc, name, []);
        for (var i = 0; i < found.length; i++) upgradeElement(found[i], cls);
      }
      var waits = whenDefinedWaits[name];
      if (waits) { delete whenDefinedWaits[name]; waits.ok(cls); }
    },
    get: function (name) { return customElementsRegistry[name]; },
    getName: function (cls) { for (var n in customElementsRegistry) if (customElementsRegistry[n] === cls) return n; return null; },
    // (one promise per name until it is defined, HTML 4.13.4)
    whenDefined: function (name) {
      name = String(name);
      if (customElementsRegistry[name]) return Promise.resolve(customElementsRegistry[name]);
      var w = whenDefinedWaits[name];
      if (!w) { w = whenDefinedWaits[name] = {}; w.p = new Promise(function (ok) { w.ok = ok; }); }
      return w.p;
    },
    upgrade: function (root) {
      var all = [root];
      if (root && root._c) eachElement(root, function (e) { all.push(e); });
      for (var i = 0; i < all.length; i++) {
        var e = all[i], cls = e && e.nodeType === 1 && customElementsRegistry[e.localName];
        if (cls) upgradeElement(e, cls);
      }
    }
  };

  // ---- the window ----------------------------------------------------------

  function locationOf(url) {
    var l = {
      get href() { return doc ? doc._url : 'about:blank'; },
      set href(v) { G.open(resolveURL(v), '_self'); },
      assign: function (v) { G.open(resolveURL(v), '_self'); },
      replace: function (v) { G.open(resolveURL(v), '_self'); },
      reload: function () {},
      toString: function () { return this.href; }
    };
    ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(function (k) {
      Object.defineProperty(l, k, {
        get: function () { var p = parseURL(doc ? doc._url : 'about:blank'); return p ? p[k] : ''; },
        set: function (v) { if (k === 'hash' && doc) { var p = parseURL(doc._url); var old = doc._url; doc._url = old.replace(/#.*$/, '') + (v ? (String(v).charAt(0) === '#' ? v : '#' + v) : ''); var ev = new Event('hashchange'); ev.oldURL = old; ev.newURL = doc._url; setTimeout(function () { dispatch(G, ev); }, 0); } },
        enumerable: true, configurable: true
      });
    });
    return l;
  }
  var historyStates = [{ state: null }];
  var history = {
    get length() { return historyStates.length; },
    get state() { return historyStates[historyStates.length - 1].state; },
    scrollRestoration: 'auto',
    pushState: function (st, t, url) { historyStates.push({ state: st }); if (url !== undefined && url !== null && doc) doc._url = resolveURL(url); },
    replaceState: function (st, t, url) { historyStates[historyStates.length - 1] = { state: st }; if (url !== undefined && url !== null && doc) doc._url = resolveURL(url); },
    back: function () { if (historyStates.length > 1) { historyStates.pop(); var ev = new Event('popstate'); ev.state = this.state; setTimeout(function () { dispatch(G, ev); }, 0); } },
    forward: function () {},
    go: function (n) { if (n < 0) this.back(); }
  };
  var navigator = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 MFilesDesktop/1.0',
    appName: 'Netscape', appVersion: '5.0', appCodeName: 'Mozilla', product: 'Gecko', vendor: 'Google Inc.', platform: 'Linux x86_64',
    language: 'en-US', languages: ['en-US', 'en'], onLine: true, cookieEnabled: true, hardwareConcurrency: 4, maxTouchPoints: 0,
    doNotTrack: null, webdriver: false, pdfViewerEnabled: false,
    userAgentData: { brands: [{ brand: 'Chromium', version: '130' }], mobile: false, platform: 'Linux', getHighEntropyValues: function () { return Promise.resolve({}); } },
    clipboard: {
      writeText: function (t) { if (typeof __out !== 'undefined') __out.push(JSON.stringify({ tag: '__Clipboard', text: String(t) })); return Promise.resolve(); },
      readText: function () { return Promise.reject(DOMException('Read permission denied.', 'NotAllowedError')); },
      write: function () { return Promise.resolve(); },
      read: function () { return Promise.reject(DOMException('Read permission denied.', 'NotAllowedError')); }
    },
    permissions: { query: function () { return Promise.resolve({ state: 'denied', addEventListener: function () {}, onchange: null }); } },
    mediaDevices: { getUserMedia: function () { return Promise.reject(DOMException('Permission denied', 'NotAllowedError')); }, enumerateDevices: function () { return Promise.resolve([]); }, addEventListener: function () {} },
    serviceWorker: undefined,
    storage: { estimate: function () { return Promise.resolve({ quota: 0, usage: 0 }); }, persist: function () { return Promise.resolve(false); } },
    // (no position here: every request is answered as a denied permission)
    geolocation: {
      getCurrentPosition: function (ok, err) { if (typeof err === 'function') setTimeout(function () { err({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); }, 0); },
      watchPosition: function (ok, err) { this.getCurrentPosition(ok, err); return 1; },
      clearWatch: function () {}
    },
    sendBeacon: function () { return false; },
    vibrate: function () { return false; },
    share: function () { return Promise.reject(DOMException('Share canceled', 'AbortError')); },
    canShare: function () { return false; },
    javaEnabled: function () { return false; },
    locks: { request: function (n, o, cb) { var f = typeof o === 'function' ? o : cb; return Promise.resolve().then(function () { return f({ name: n }); }); } }
  };

  var screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0, addEventListener: function () {}, removeEventListener: function () {} } };

  // the window is an EventTarget: keep prelude's 'message' listeners
  var preludeAdd = G.addEventListener, preludeRemove = G.removeEventListener;
  G._ls = null;
  G.addEventListener = function (type, fn, opts) {
    if (type === 'message' && preludeAdd) { preludeAdd(type, fn); return; }
    EventTarget.prototype.addEventListener.call(G, type, fn, opts);
  };
  G.removeEventListener = function (type, fn, opts) {
    if (type === 'message' && preludeRemove) { preludeRemove(type, fn); return; }
    EventTarget.prototype.removeEventListener.call(G, type, fn, opts);
  };
  G.dispatchEvent = function (ev) { return dispatch(G, ev); };

  function install(name, v) { G[name] = v; }
  var exportsList = {
    DOMException: DOMException, Event: Event, CustomEvent: CustomEvent, UIEvent: UIEvent, FocusEvent: FocusEvent, MouseEvent: MouseEvent,
    PointerEvent: PointerEvent, WheelEvent: WheelEvent, KeyboardEvent: KeyboardEvent, InputEvent: InputEvent, CompositionEvent: CompositionEvent,
    MessageEvent: MessageEvent, ProgressEvent: ProgressEvent, ErrorEvent: ErrorEvent, AnimationEvent: AnimationEvent, TransitionEvent: TransitionEvent, Animation: Animation, KeyframeEffect: KeyframeEffect, AnimationEffect: AnimationEffect,
    ClipboardEvent: ClipboardEvent, DragEvent: DragEvent, EventTarget: EventTarget, Node: Node, CharacterData: CharacterData, Text: Text,
    CDATASection: CDATASection, Comment: Comment, DocumentFragment: DocumentFragment, DocumentType: DocumentType, ShadowRoot: ShadowRoot,
    Attr: Attr, DOMTokenList: DOMTokenList, CSSStyleDeclaration: CSSStyleDeclaration, Element: Element, HTMLElement: HTMLElement,
    SVGElement: SVGElement, SVGGraphicsElement: SVGGraphicsElement, SVGSVGElement: SVGSVGElement, SVGPathElement: SVGPathElement,
    Document: Document, HTMLDocument: HTMLDocument, XMLDocument: XMLDocument, NodeFilter: NodeFilter, TreeWalker: TreeWalker,
    NodeIterator: NodeIterator, Range: Range, StaticRange: StaticRange, MutationObserver: MutationObserver, MutationRecord: MutationRecord,
    ResizeObserver: ResizeObserver, IntersectionObserver: IntersectionObserver, DOMRect: DOMRect, DOMRectReadOnly: DOMRect, DOMMatrix: DOMMatrix, DOMMatrixReadOnly: DOMMatrix, WebKitCSSMatrix: DOMMatrix, DOMPoint: DOMPoint, DOMPointReadOnly: DOMPoint, SVGMatrix: DOMMatrix, SVGPoint: DOMPoint, DOMParser: DOMParser,
    XMLSerializer: XMLSerializer, CSSRule: CSSRule, CSSStyleRule: CSSStyleRule, CSSMediaRule: CSSMediaRule, CSSStyleSheet: CSSStyleSheet,
    StyleSheet: CSSStyleSheet, MediaQueryList: MediaQueryList, URL: URL, URLSearchParams: URLSearchParams, TextEncoder: TextEncoder,
    TextDecoder: TextDecoder, Blob: Blob, File: File, FileReader: FileReader, AbortController: AbortController, AbortSignal: AbortSignal,
    MessageChannel: MessageChannel, MessagePort: MessagePort, BroadcastChannel: BroadcastChannel, DataTransfer: DataTransfer,
    CanvasRenderingContext2D: CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D: CanvasRenderingContext2D, OffscreenCanvas: OffscreenCanvas,
    Path2D: Path2D, CanvasGradient: CanvasGradient, CanvasPattern: CanvasPattern, ImageData: ImageData, TextMetrics: TextMetrics,
    HTMLCollection: Array, NodeList: Array, NamedNodeMap: Object
  };
  for (var tagName in TAGS) exportsList[TAGS[tagName].name] = TAGS[tagName];
  exportsList.HTMLUnknownElement = HTMLUnknownElement;
  exportsList.HTMLMediaElement = HTMLMediaElement;
  for (var en in exportsList) install(en, exportsList[en]);
  install('CSS', {
    supports: function (a, b) { if (b === undefined) return supportsCondition(String(a).charAt(0) === '(' ? a : '(' + a + ')'); return supportsCondition('(' + a + ':' + b + ')'); },
    escape: function (s) { return String(s).replace(/([^\w-])/g, '\\$1').replace(/^(\d)/, '\\3$1 '); }
  });
  install('getComputedStyle', getComputedStyle);
  install('matchMedia', function (q) { return new MediaQueryList(String(q)); });
  install('requestAnimationFrame', requestAnimationFrame);
  install('cancelAnimationFrame', cancelAnimationFrame);
  install('requestIdleCallback', requestIdleCallback);
  install('cancelIdleCallback', cancelIdleCallback);
  install('structuredClone', function (v) { return structuredCloneImpl(v); });
  install('atob', atob);
  install('btoa', btoa);
  install('performance', performance);
  install('navigator', navigator);
  install('screen', screen);
  install('history', history);
  install('localStorage', makeStorage());
  install('sessionStorage', makeStorage());
  install('customElements', customElements);
  install('devicePixelRatio', 1);
  install('origin', '');
  install('isSecureContext', true);
  install('frames', G);
  install('length', 0);
  install('opener', null);
  install('frameElement', null);
  install('name', '');
  install('closed', false);
  install('event', undefined);
  install('getSelection', function () { return selection; });
  function scrollPage(x, y, by) {
    var root = doc && doc.documentElement;
    if (!root) return;
    if (typeof x === 'object' && x) { y = x.top; x = x.left; }
    var top = (by ? root.scrollTop : 0) + (+y || 0);
    top = Math.max(0, Math.min(Math.max(0, pageHeight() - viewport.h), top));
    if (top !== root.scrollTop) { root.scrollTop = top; scrolled(root); dispatch(doc, new Event('scroll')); }
  }
  install('scrollTo', function (x, y) { scrollPage(x, y, false); });
  install('scroll', function (x, y) { scrollPage(x, y, false); });
  install('scrollBy', function (x, y) { scrollPage(x, y, true); });
  install('focus', function () {});
  install('blur', function () {});
  install('print', function () {});
  install('stop', function () {});
  install('alert', function (m) { if (typeof console !== 'undefined') console.log(String(m)); });
  install('confirm', function () { return false; });
  install('prompt', function () { return null; });
  // window.postMessage posts to this window, as in a browser: a clone of the
  // message reaches its 'message' listeners in a later task (Monaco's
  // setTimeout0 runs its async work this way). The host is window.parent.
  install('postMessage', function (m) {
    var copy = structuredCloneImpl(m);
    setTimeout(function () {
      var ev = new MessageEvent('message', { data: copy, origin: G.location ? G.location.origin : '', source: G });
      if (typeof __listeners === 'undefined') { dispatch(G, ev); return; }
      var ls = __listeners.slice();
      for (var i = 0; i < ls.length; i++) { try { ls[i](ev); } catch (e) { reportError(e); } }
    }, 0);
  });
  install('reportError', reportError);
  // ---- fetch and XMLHttpRequest ------------------------------------------
  // The host answers what it can (its __fetchResource hook: the
  // application's own files); without one every request is a network error.
  var resources = {}, resourceId = 1;
  function loadResource(url, done) {
    var id = resourceId++;
    resources[id] = done;
    if (typeof G.__fetchResource === 'function') G.__fetchResource(id, url);
    else setTimeout(function () { __resource(id, 0, ''); }, 0);
    return id;
  }
  function __resource(id, status, text, type) {
    var done = resources[id];
    delete resources[id];
    if (done) done(status, text, type || '');
  }
  G.__resource = __resource;
  var STATUS_TEXT = { 200: 'OK', 404: 'Not Found' };
  class Headers {
    constructor(init) {
      this._h = {};
      if (init instanceof Headers) init = init._h;
      if (Array.isArray(init)) for (var i = 0; i < init.length; i++) this.append(init[i][0], init[i][1]);
      else if (init) for (var k in init) this.append(k, init[k]);
    }
    append(k, v) { k = String(k).toLowerCase(); this._h[k] = this._h[k] === undefined ? String(v) : this._h[k] + ', ' + v; }
    set(k, v) { this._h[String(k).toLowerCase()] = String(v); }
    get(k) { var v = this._h[String(k).toLowerCase()]; return v === undefined ? null : v; }
    has(k) { return this._h[String(k).toLowerCase()] !== undefined; }
    delete(k) { delete this._h[String(k).toLowerCase()]; }
    forEach(fn, self) { for (var k in this._h) fn.call(self, this._h[k], k, this); }
    entries() { var h = this._h; return Object.keys(h).sort().map(function (k) { return [k, h[k]]; })[Symbol.iterator](); }
    keys() { return Object.keys(this._h).sort()[Symbol.iterator](); }
    values() { var h = this._h; return Object.keys(h).sort().map(function (k) { return h[k]; })[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
  }
  function bodyText(b) {
    if (b === undefined || b === null) return '';
    if (typeof b === 'string') return b;
    if (b instanceof Blob) return new TextDecoder().decode(b._bytes());
    if (b instanceof URLSearchParams) return b.toString();
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
    return String(b);
  }
  class Body {
    _read() {
      if (this.bodyUsed) return Promise.reject(new TypeError('body already used'));
      this.bodyUsed = true;
      return Promise.resolve(this._body);
    }
    text() { return this._read(); }
    json() { return this._read().then(function (t) { return JSON.parse(t); }); }
    arrayBuffer() { return this._read().then(function (t) { return new TextEncoder().encode(t).buffer; }); }
    blob() { var type = this.headers.get('content-type') || ''; return this._read().then(function (t) { return new Blob([t], { type: type }); }); }
    formData() { return Promise.reject(new TypeError('formData is not supported')); }
  }
  class Response extends Body {
    constructor(body, init) {
      super();
      init = init || {};
      this._body = bodyText(body);
      this.bodyUsed = false;
      this.status = init.status === undefined ? 200 : init.status;
      this.statusText = init.statusText !== undefined ? String(init.statusText) : STATUS_TEXT[this.status] || '';
      this.headers = new Headers(init.headers);
      this.url = init.url || '';
      this.type = init.type || 'default';
      this.redirected = false;
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    get body() { return null; }
    clone() { if (this.bodyUsed) throw new TypeError('body already used'); return new Response(this._body, this); }
    static json(v, init) { var r = new Response(JSON.stringify(v), init); r.headers.set('content-type', 'application/json'); return r; }
    static error() { return new Response('', { status: 0, type: 'error' }); }
  }
  class Request extends Body {
    constructor(input, init) {
      super();
      init = init || {};
      var from = input instanceof Request ? input : null;
      this.url = from ? from.url : resolveURL(String(input));
      this.method = String(init.method || (from && from.method) || 'GET').toUpperCase();
      this.headers = new Headers(init.headers || (from && from.headers));
      this.signal = init.signal || (from && from.signal) || null;
      this._body = bodyText(init.body !== undefined ? init.body : from && from._body);
      this.bodyUsed = false;
    }
    clone() { return new Request(this); }
  }
  function abortError(signal) { return signal && signal.reason !== undefined ? signal.reason : DOMException('The operation was aborted.', 'AbortError'); }
  function contentType(url, type) {
    if (type) return type;
    var m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url);
    var t = m && { js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', html: 'text/html', css: 'text/css', svg: 'image/svg+xml', txt: 'text/plain', xml: 'application/xml' }[m[1].toLowerCase()];
    return t || 'application/octet-stream';
  }
  install('fetch', function fetch(input, init) {
    var req;
    try { req = new Request(input, init); } catch (e) { return Promise.reject(e); }
    var signal = req.signal;
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(abortError(signal)); return; }
      var settled = false;
      function onAbort() { if (!settled) { settled = true; delete resources[id]; reject(abortError(signal)); } }
      var id = loadResource(req.url, function (status, text, type) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!status) { reject(new TypeError('Failed to fetch')); return; }
        resolve(new Response(text, { status: status, url: req.url, type: 'basic', headers: { 'content-type': contentType(req.url, type) } }));
      });
      if (signal) signal.addEventListener('abort', onAbort);
    });
  });
  install('Headers', Headers);
  install('Request', Request);
  install('Response', Response);
  class XMLHttpRequest extends EventTarget {
    constructor() {
      super();
      this.readyState = 0; this.status = 0; this.statusText = ''; this.responseText = ''; this.response = '';
      this.responseType = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false;
      this.upload = new EventTarget();
      this._id = 0; this._type = '';
    }
    open(method, url) { this._method = String(method).toUpperCase(); this._url = resolveURL(String(url)); this._id = 0; this._state(1); }
    setRequestHeader() {}
    getAllResponseHeaders() { return this.readyState >= 2 && this.status ? 'content-type: ' + this._type + '\r\n' : ''; }
    getResponseHeader(k) { return this.readyState >= 2 && this.status && String(k).toLowerCase() === 'content-type' ? this._type : null; }
    overrideMimeType() {}
    _state(n) { this.readyState = n; this._fire('readystatechange', Event); }
    _fire(type, Cls) { var ev = new Cls(type); var h = this['on' + type]; if (typeof h === 'function') { try { h.call(this, ev); } catch (e) { reportError(e); } } this.dispatchEvent(ev); }
    send() {
      if (this.readyState !== 1) throw DOMException('The object is not open', 'InvalidStateError');
      var self = this;
      this._fire('loadstart', ProgressEvent);
      this._id = loadResource(this._url, function (status, text, type) {
        self._id = 0;
        if (!status) { self._state(4); self._fire('error', ProgressEvent); self._fire('loadend', ProgressEvent); return; }
        self.status = status; self.statusText = STATUS_TEXT[status] || ''; self.responseURL = self._url;
        self._type = contentType(self._url, type);
        self._state(2); self._state(3);
        self.responseText = text;
        var rt = self.responseType;
        try { self.response = rt === 'json' ? JSON.parse(text) : rt === 'arraybuffer' ? new TextEncoder().encode(text).buffer : rt === 'blob' ? new Blob([text], { type: self._type }) : text; } catch (e) { self.response = null; }
        self._state(4);
        self._fire('load', ProgressEvent);
        self._fire('loadend', ProgressEvent);
      });
    }
    abort() {
      if (!this._id) return;
      delete resources[this._id];
      this._id = 0;
      this._state(4);
      this.readyState = 0;
      this._fire('abort', ProgressEvent);
      this._fire('loadend', ProgressEvent);
    }
  }
  XMLHttpRequest.UNSENT = 0; XMLHttpRequest.OPENED = 1; XMLHttpRequest.HEADERS_RECEIVED = 2; XMLHttpRequest.LOADING = 3; XMLHttpRequest.DONE = 4;
  install('XMLHttpRequest', XMLHttpRequest);
  install('Image', function Image(w, h) { var i = doc.createElement('img'); if (w !== undefined) i.width = w; if (h !== undefined) i.height = h; return i; });
  install('Option', function Option(text, value, ds, sel) { var o = doc.createElement('option'); if (text !== undefined) o.text = text; if (value !== undefined) o.value = value; if (ds) o.defaultSelected = true; if (sel) o.selected = true; return o; });
  // the engine's own Promise, taken now (a polyfill that replaces the global
  // Promise and patches its then may schedule through queueMicrotask)
  var resolvedNow = Promise.resolve(), nativeThen = Promise.prototype.then;
  if (!G.queueMicrotask) install('queueMicrotask', function (fn) { nativeThen.call(resolvedNow, fn); });
  Object.defineProperty(G, 'innerWidth', { get: function () { return viewport.w; }, configurable: true });
  Object.defineProperty(G, 'innerHeight', { get: function () { return viewport.h; }, configurable: true });
  Object.defineProperty(G, 'outerWidth', { get: function () { return viewport.w; }, configurable: true });
  Object.defineProperty(G, 'outerHeight', { get: function () { return viewport.h; }, configurable: true });
  Object.defineProperty(G, 'scrollX', { get: function () { return 0; }, configurable: true });
  Object.defineProperty(G, 'scrollY', { get: function () { return doc && doc.documentElement ? doc.documentElement.scrollTop : 0; }, configurable: true });
  Object.defineProperty(G, 'pageXOffset', { get: function () { return 0; }, configurable: true });
  Object.defineProperty(G, 'pageYOffset', { get: function () { return doc && doc.documentElement ? doc.documentElement.scrollTop : 0; }, configurable: true });
  Object.defineProperty(G, 'screenX', { get: function () { return 0; }, configurable: true });
  Object.defineProperty(G, 'screenY', { get: function () { return 0; }, configurable: true });
  ['onload', 'onerror', 'onresize', 'onscroll', 'onfocus', 'onblur', 'onmessage', 'onunhandledrejection', 'onpopstate', 'onhashchange', 'onbeforeunload', 'onunload'].forEach(function (k) { if (G[k] === undefined) G[k] = null; });
  if (!G.location || !G.location.assign) install('location', locationOf());

  // ---- the host's entry points ---------------------------------------------

  function newDocument(url) {
    var d = new HTMLDocument();
    d._url = url || 'about:blank';
    return d;
  }
  G.__page = function (html, url) {
    doc = newDocument(url || 'about:blank');
    install('document', doc);
    var xml = /\.xht(ml)?([?#]|$)/i.test(String(url || '')) || /^\s*<\?xml/.test(String(html || ''));
    if (xml) doc.contentType = 'application/xhtml+xml';
    parseInto(String(html || ''), doc, doc, null, xml);
    // (a page with no doctype is in quirks mode)
    if (!xml && !doc.doctype) doc.compatMode = 'BackCompat';
    // <html>, <head> and <body> are optional in the markup: implied ones,
    // which the stray nodes go into
    var h = null;
    for (var j = 0; j < doc._c.length; j++) if (doc._c[j].nodeType === 1 && doc._c[j].localName === 'html') { h = doc._c[j]; break; }
    if (!h) h = doc.appendChild(doc.createElement('html'));
    var head = null, body = null;
    for (var k = 0; k < h._c.length; k++) {
      if (h._c[k].localName === 'head' && !head) head = h._c[k];
      else if (h._c[k].localName === 'body' && !body) body = h._c[k];
    }
    // <head> and <body> tags beside an implied <html>
    for (var m = 0; m < doc._c.length; m++) {
      var sn = doc._c[m];
      if (sn.nodeType !== 1 || sn === h) continue;
      if (sn.localName === 'head' && !head) { head = h.insertBefore(sn, h.firstChild); m--; }
      else if (sn.localName === 'body' && !body) { body = h.appendChild(sn); m--; }
    }
    if (!head) head = h.insertBefore(doc.createElement('head'), h.firstChild);
    if (!body) body = h.appendChild(doc.createElement('body'));
    // stray nodes in <html> beside <head> and <body>: metadata before any
    // content into <head>, the rest into <body> (before its own nodes when
    // they come before it)
    var hBody = false, hIn = false, bFirst = body.firstChild;
    for (var q = 0; q < h._c.length; q++) {
      var hn = h._c[q];
      if (hn === head) continue;
      if (hn === body) { hBody = true; continue; }
      if (hn.nodeType === 8) continue;
      if (hn.nodeType === 3 && !hIn && !/\S/.test(hn._data)) { if (hBody) continue; h.removeChild(hn); q--; continue; }
      if (!hIn && !hBody && hn.nodeType === 1 && /^(meta|title|link|style|script|base|noscript|template)$/.test(hn.localName)) { head.appendChild(hn); q--; continue; }
      hIn = true;
      if (hBody) body.appendChild(hn); else body.insertBefore(hn, bFirst);
      q--;
    }
    // stray nodes beside <html>: into <body> or, metadata before any
    // content, <head>
    var inBody = false;
    for (var i = 0; i < doc._c.length; i++) {
      var n = doc._c[i];
      if (n === h || n.nodeType === 10 || n.nodeType === 8) continue;
      if (n.nodeType === 3 && !inBody && !/\S/.test(n._data)) { doc.removeChild(n); i--; continue; }
      if (!inBody && n.nodeType === 1 && /^(meta|title|link|style|script|base)$/.test(n.localName)) head.appendChild(n);
      else { inBody = true; body.appendChild(n); }
      i--;
    }
    // with <html> first, before stray nodes after it
    if (doc.firstElementChild !== h) doc.appendChild(h);
    var base = doc.querySelector('base[href]');
    if (base && base.getAttribute('href')) doc._base = joinURL(base.getAttribute('href'), doc._url);
    // the page's own scripts are the host's to run (__scripts): already
    // started, so moving one later does not run it again
    eachElement(doc, function (e) { if (e._parser) { e._parser = false; if (e.localName === 'script') e._started = true; } });
    doc.readyState = 'loading';
    return 'ok';
  };
  G.__scripts = scriptsOfPage;
  G.__styles = stylesOfPage;
  G.__beginScript = function (id) { doc.currentScript = nodeById(id) || null; return 'ok'; };
  G.__endScript = function (id, ok) {
    var el = nodeById(id);
    doc.currentScript = null;
    if (el && el.getAttribute('src')) setTimeout(function () { dispatch(el, new Event(ok === false ? 'error' : 'load')); }, 0);
    return 'ok';
  };
  G.__addStyle = function (css, linkId) {
    var owner = linkId !== undefined && linkId !== null ? nodeById(linkId) : null;
    var s = new CSSStyleSheet(owner);
    s.href = owner ? owner.href : null;
    s.cssRules = parseSheetText(String(css || ''), s).cssRules;
    s._rebuild();
    linkSheets.push(s);
    if (owner) setTimeout(function () { dispatch(owner, new Event('load')); }, 0);
    return String(s._rules.length);
  };
  G.__loaded = function () {
    doc.readyState = 'interactive';
    dispatch(doc, new Event('readystatechange'));
    dispatch(doc, new Event('DOMContentLoaded', { bubbles: true }));
    doc.readyState = 'complete';
    dispatch(doc, new Event('readystatechange'));
    var ev = new Event('load');
    // <body onload="...">: the window's handler
    if (typeof G.onload !== 'function' && doc.body && doc.body.hasAttribute('onload')) G.onload = doc.body.onload;
    if (typeof G.onload === 'function') { try { G.onload(ev); } catch (e) { reportError(e); } }
    invoke(G, ev, 2);
    return 'ok';
  };
  G.__render = function () { var was = reflowing; reflowing = true; try { return render(); } finally { reflowing = was; } };
  // the render tree as a delta for a host that keeps the last page (see
  // renderJson): again = the host lost what it kept, everything is sent
  G.__renderDelta = function (again) { var was = reflowing; reflowing = true; if (again) deltaEpoch++; try { return render(deltaOn); } finally { reflowing = was; } };
  G.__deltaCheck = function (on) { deltaCheck = !!on; return String(deltaCheck); };
  // a test's: the page as the kept styles and renders give it against the
  // page with every style found and every node rendered again: '' when
  // the two are alike, else the texts around where they part
  G.__styleCheck = function () {
    var was = reflowing; reflowing = true;
    try {
      // (a patched style has its properties in another order, patchedStyle:
      // members by name; a script's scrollTop renders nothing again, the
      // host moves the box: "sc" left out)
      var norm = function (v) {
        if (Array.isArray(v)) return v.map(norm);
        if (!v || typeof v !== 'object') return v;
        var o = {}, ks = Object.keys(v).sort();
        for (var i = 0; i < ks.length; i++) if (ks[i] !== 'v' && ks[i] !== 'sc') o[ks[i]] = norm(v[ks[i]]);
        return o;
      };
      var a = render(false);
      changed();
      var b = render(false);
      if (a === b) return '';
      a = JSON.stringify(norm(JSON.parse(a))); b = JSON.stringify(norm(JSON.parse(b)));
      if (a === b) return '';
      var i = 0;
      while (i < a.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
      return 'kept ' + a.slice(Math.max(0, i - 200), i + 120) + ' fresh ' + b.slice(Math.max(0, i - 200), i + 120);
    } finally { reflowing = was; }
  };
  // a test's: each text movedJson gives is compared with renderNode's
  G.__fastRenderCheck = function (on) { if (on === undefined) return fastCheck ? JSON.stringify(fastCheck) : ''; fastCheck = on ? { n: 0, bad: 0, first: '' } : null; return ''; };
  G.__deltaRender = function (on) { on = !!on; if (on !== deltaOn) { deltaOn = on; deltaEpoch++; } return String(deltaOn); };
  // the host draws text with the browser's own faces (the playground's
  // canvas), so a line of Arial has Arial's height, not that of the Open
  // Sans a native host draws for it
  var browserFonts = false;
  // (on "measure": the host also measures the text with the browser, so
  // the page's own font families go to it, not Arial's metrics)
  G.__browserFonts = function (on) { browserFonts = on === 'measure' ? 'measure' : !!on; generation++; return String(browserFonts); };
  G.__syncLayout = function (on) { syncLayout = !!on && typeof __hostSync === 'function'; return String(syncLayout); };
  G.__generation = function () { return String(generation); };
  G.__layout = function (json) {
    var m = typeof json === 'string' ? JSON.parse(json) : json;
    var sizeChanged = false;
    if (m.viewport) {
      if (m.viewport[0] !== viewport.w || m.viewport[1] !== viewport.h) { viewport = { w: m.viewport[0], h: m.viewport[1] }; mediaCache = {}; sizeChanged = true; changed(); }
    }
    if (m.boxes) {
      takeBoxes(m.boxes);
      layoutGen = generation;
      layoutSb = scrollBumps;
      if (virts.length) virtCheck(true);
      boxSvgs = boxSvgs.filter(function (e) { return e.isConnected; });
      for (var bs = 0; bs < boxSvgs.length; bs++) {
        var sv = boxSvgs[bs], sb = boxes[sv.__id];
        if (!sb) continue;
        var scs = computedOf(sv), uw = svgUsedSize(sv, scs, 'width', 300), uh = svgUsedSize(sv, scs, 'height', 150);
        if (sv._usedBox !== (uw !== null ? uw : sb[2]) + ',' + (uh !== null ? uh : sb[3])) textChanged(sv);
      }
    }
    if (m.boxes && pctTransforms.length) {
      pctTransforms = pctTransforms.filter(function (e) { return e.isConnected; });
      for (var pt = 0; pt < pctTransforms.length; pt++) {
        var pe = pctTransforms[pt], pb = boxes[pe.__id];
        if (pb && pe._pctBox !== pb[2] + ',' + pb[3]) { dropComputed(pe); textChanged(pe); }
      }
    }
    if (m.boxes && scrollers.length) clampScrolls();
    if (m.boxes && (caretDrawn || (doc && doc._active && doc._active.isContentEditable))) { var cb2 = editCaretBox(); if ((cb2 ? JSON.stringify(cb2) : null) !== caretDrawn) generation++; }
    if (sizeChanged) { mediaChanged(); invoke(G, new UIEvent('resize', { view: G }), 2); if (typeof G.onresize === 'function') G.onresize(new UIEvent('resize')); }
    if (resizeObservers.length) fireResize();
    if (intersectionObservers.length) fireIntersect();
    return 'ok';
  };
  G.__input = function (json) {
    var m = typeof json === 'string' ? JSON.parse(json) : json;
    try { return hostInput(m); } catch (e) { reportError(e); return 'error ' + (e && e.message); }
  };
  // the files the host's chooser gave a file field (askFiles): [{name,
  // type, lastModified, b64}], then input and change, as a browser fires them
  G.__setFiles = function (id, json) {
    var el = nodeById(id), list = typeof json === 'string' ? JSON.parse(json) : json;
    if (!el || el.localName !== 'input' || el.type !== 'file') return 'no field';
    var files = list.map(function (f) { var x = new File([], f.name, { type: f.type || '', lastModified: f.lastModified }); x._s = f.b64 ? atob(f.b64) : ''; return x; });
    el._files = fileList(files);
    valueChanged(el);
    fireChange(el);
    return 'ok';
  };
  G.__querySelector = function (s) { var e = doc && doc.querySelector(s); return e ? String(e.__id) : ''; };
  G.__webdom = { restyleAll: function () { changed(); }, computedOf: computedOf, cascade: cascade, parseSelectorList: parseSelectorList, normalizeColor: normalizeColor, resolveURL: resolveURL, nodeById: nodeById, lengthPx: lengthPx };

  // ---- interfaces and members found missing against Chromium --------------
  // (bench/cases/webapi-survey: the globals and prototype members UI
  // libraries reach for; what a page can use here behaves as in Chromium,
  // what needs a network, threads or a database the host does not give
  // (WebSocket, Worker, indexedDB...) is left out so feature tests see it
  // missing)
  (function () {
    function iface(name, parent, obj) {
      var C = function () { throw new TypeError('Illegal constructor'); };
      Object.defineProperty(C, 'name', { value: name });
      C.prototype = Object.create(parent ? parent.prototype : Object.prototype);
      Object.defineProperty(C.prototype, 'constructor', { value: C, writable: true, configurable: true });
      Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
      if (parent) Object.setPrototypeOf(C, parent);
      if (obj) Object.setPrototypeOf(obj, C.prototype);
      install(name, C);
      return C;
    }
    function def(proto, name, get, set) { Object.defineProperty(proto, name, { get: get, set: set, configurable: true, enumerable: true }); }
    iface('Navigator', null, navigator);
    iface('History', null, history);
    var perf = iface('Performance', EventTarget, performance);
    perf.prototype.toJSON = function () { return { timeOrigin: this.timeOrigin, timing: this.timing, navigation: this.navigation }; };
    iface('Screen', EventTarget, screen);
    var StorageC = iface('Storage', null, G.localStorage);
    Object.setPrototypeOf(G.sessionStorage, StorageC.prototype);
    iface('CustomElementRegistry', null, customElements);
    if (G.location) iface('Location', null, G.location); else iface('Location', null, null);
    iface('StyleSheetList', null, null);
    iface('FileList', null, null);
    if (G.crypto) iface('Crypto', null, G.crypto);
    install('Selection', Selection);
    install('AbstractRange', AbstractRange);
    install('PopStateEvent', PopStateEvent);
    install('HashChangeEvent', HashChangeEvent);
    install('PageTransitionEvent', PageTransitionEvent);
    install('StorageEvent', StorageEvent);
    install('TouchEvent', TouchEvent);
    install('Touch', Touch);

    // MediaList (CSSOM 4.1): a sheet's media
    class MediaList {
      constructor(text) { this._m = []; this.mediaText = text || ''; }
      get mediaText() { return this._m.join(', '); }
      set mediaText(v) { this._m = String(v || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
      get length() { return this._m.length; }
      item(i) { return this._m[i] === undefined ? null : this._m[i]; }
      appendMedium(m) { m = String(m).trim(); if (this._m.indexOf(m) < 0) this._m.push(m); }
      deleteMedium(m) { var i = this._m.indexOf(String(m).trim()); if (i < 0) throw DOMException('Failed to delete medium.', 'NotFoundError'); this._m.splice(i, 1); }
      toString() { return this.mediaText; }
    }
    install('MediaList', MediaList);
    def(CSSStyleSheet.prototype, 'media', function () { var m = this._mediaList; if (!m) { var o = this._media0; m = this._mediaList = new MediaList(o && o.mediaText || ''); } return m; }, function (v) { this.media.mediaText = typeof v === 'string' ? v : v && v.mediaText || ''; });
    if (!('ownerRule' in CSSStyleSheet.prototype)) CSSStyleSheet.prototype.ownerRule = null;

    // VisualViewport: the layout viewport, scale 1
    var VV = iface('VisualViewport', EventTarget, null);
    var vv = Object.create(VV.prototype);
    vv._ls = null;
    def(vv, 'width', function () { return viewport.w; });
    def(vv, 'height', function () { return viewport.h; });
    def(vv, 'scale', function () { return 1; });
    def(vv, 'offsetLeft', function () { return 0; });
    def(vv, 'offsetTop', function () { return 0; });
    def(vv, 'pageLeft', function () { return G.scrollX || 0; });
    def(vv, 'pageTop', function () { return G.scrollY || 0; });
    vv.onresize = null; vv.onscroll = null; vv.onscrollend = null;
    install('visualViewport', vv);
    G.addEventListener('resize', function () { var ev = new Event('resize'); if (typeof vv.onresize === 'function') vv.onresize(ev); dispatch(vv, ev); });
    // (a script cannot close a window it did not open)
    install('close', function () {});

    // Node
    Node.prototype.lookupPrefix = function (ns) {
      if (!ns) return null;
      for (var n = this.nodeType === 1 ? this : this.parentNode; n && n.nodeType === 1; n = n.parentNode) {
        if (n.namespaceURI === ns && n.prefix) return n.prefix;
      }
      return null;
    };
    Node.prototype.isDefaultNamespace = function (ns) { return (ns || null) === this.lookupNamespaceURI(null); };
    var lookupNS0 = Node.prototype.lookupNamespaceURI;
    Node.prototype.lookupNamespaceURI = function (prefix) {
      prefix = prefix || null;
      if (prefix === 'xml') return 'http://www.w3.org/XML/1998/namespace';
      if (prefix === 'xmlns') return 'http://www.w3.org/2000/xmlns/';
      var n = this.nodeType === 9 ? this.documentElement : this.nodeType === 1 ? this : this.parentNode;
      for (; n && n.nodeType === 1; n = n.parentNode) {
        if (n.namespaceURI && (n.prefix || null) === prefix) return n.namespaceURI;
        var v = n.getAttribute(prefix ? 'xmlns:' + prefix : 'xmlns');
        if (v !== null) return v || null;
      }
      return lookupNS0.call(this, prefix);
    };

    // Element
    var EP = Element.prototype, HP = HTMLElement.prototype;
    EP.removeAttributeNode = function (a) {
      if (!a || this._attrs.indexOf(a) < 0) throw DOMException("Failed to execute 'removeAttributeNode' on 'Element': The node provided is owned by another element.", 'NotFoundError');
      this.removeAttribute(a.name);
      a.ownerElement = null;
      return a;
    };
    EP.setAttributeNodeNS = EP.setAttributeNode;
    EP.getAttributeNodeNS = function (ns, n) { return this.getAttributeNode(n); };
    EP.getElementsByTagNameNS = function (ns, t) {
      var root = this, any = ns === '*', all = t === '*';
      ns = ns === '' ? null : ns;
      return liveCollection(function () {
        var out = [];
        eachElement(root, function (e) { if ((any || (e.namespaceURI || null) === ns) && (all || e.localName === t)) out.push(e); });
        return out;
      });
    };
    Document.prototype.getElementsByTagNameNS = EP.getElementsByTagNameNS;
    DocumentFragment.prototype.getElementsByTagNameNS = EP.getElementsByTagNameNS;
    def(EP, 'part', function () { return this._part || (this._part = new DOMTokenList(this, 'part')); }, function (v) { this.setAttribute('part', v); });
    // (CSSOM View 6: display: none on it or above it, or content-visibility:
    // hidden above it; opacity and visibility when asked)
    EP.checkVisibility = function (o) {
      o = o || {};
      if (!this.isConnected) return false;
      for (var n = this; n && n.nodeType === 1; n = upFlat(n)) {
        var cs = computedOf(n);
        if (cs.display === 'none') return false;
        if (n !== this && cs['content-visibility'] === 'hidden') return false;
        if ((o.checkOpacity || o.opacityProperty) && parseFloat(cs.opacity) === 0) return false;
      }
      if ((o.checkVisibilityCSS || o.visibilityProperty) && computedOf(this).visibility !== 'visible') return false;
      return true;
    };
    // (a declarative shadow root, <template shadowrootmode>, in the text
    // becomes the element's shadow root, HTML 8.5)
    function declarativeShadow(root) {
      var ts = [];
      eachElement(root, function (e) { if (e.localName === 'template' && e.hasAttribute('shadowrootmode')) ts.push(e); });
      for (var i = ts.length - 1; i >= 0; i--) {
        var t = ts[i], host = t.parentNode, mode = t.getAttribute('shadowrootmode');
        if (!host || host.nodeType !== 1 || host._sr || (mode !== 'open' && mode !== 'closed')) continue;
        var sr = host.attachShadow({ mode: mode, delegatesFocus: t.hasAttribute('shadowrootdelegatesfocus'), clonable: t.hasAttribute('shadowrootclonable'), serializable: t.hasAttribute('shadowrootserializable') });
        sr.appendChild(t.content);
        host.removeChild(t);
      }
    }
    EP.setHTMLUnsafe = function (html) {
      var target = this.localName === 'template' && this.content ? this.content : this;
      removeAll(target);
      var frag = parseFragment(String(html), this);
      declarativeShadow(frag);
      target.appendChild(frag);
    };
    ShadowRoot.prototype.setHTMLUnsafe = EP.setHTMLUnsafe;
    Document.parseHTMLUnsafe = function (html) { return new DOMParser().parseFromString(String(html), 'text/html'); };
    function openTag(c) { var t = '<' + c._qname; for (var i = 0; i < c._attrs.length; i++) t += ' ' + c._attrs[i].name + '="' + escapeAttr(c._attrs[i]._v) + '"'; return t + '>'; }
    function htmlWithShadows(node, o) {
      var roots = (o && o.shadowRoots) || [], ser = o && o.serializableShadowRoots, out = '';
      var kids = node.nodeType === 1 && node.localName === 'template' && node.content ? node.content._c : node._c;
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType !== 1 || (c.namespaceURI === HTML_NS && VOID.test(c._qname))) { out += serialize(c, false); continue; }
        var inner = '', sr = c._sr;
        if (sr && ((ser && sr._serializable) || roots.indexOf(sr) >= 0)) inner = '<template shadowrootmode="' + sr.mode + '"' + (sr.delegatesFocus ? ' shadowrootdelegatesfocus=""' : '') + (sr._serializable ? ' shadowrootserializable=""' : '') + (sr._clonable ? ' shadowrootclonable=""' : '') + (sr._slotMode === 'manual' ? ' shadowrootslotassignment="manual"' : '') + '>' + htmlWithShadows(sr, o) + '</template>';
        out += openTag(c) + inner + htmlWithShadows(c, o) + '</' + c._qname + '>';
      }
      return out;
    }
    EP.getHTML = function (o) { if (!o || (!o.serializableShadowRoots && !(o.shadowRoots && o.shadowRoots.length)) || !shadowCount) return this.localName === 'template' && this.content ? serializeChildren(this.content) : serializeChildren(this); return htmlWithShadows(this, o); };
    ShadowRoot.prototype.getHTML = function (o) { return o && (o.serializableShadowRoots || (o.shadowRoots && o.shadowRoots.length)) ? htmlWithShadows(this, o) : serializeChildren(this); };
    EP.requestFullscreen = function () { return Promise.reject(new TypeError('Permissions check failed')); };
    EP.webkitRequestFullscreen = function () {};
    if (!('fullscreenEnabled' in Document.prototype)) def(Document.prototype, 'fullscreenEnabled', function () { return false; });

    // ARIA reflection (ARIA 1.3, 10.1): role and aria-* as nullable strings,
    // the element references by id within the same tree
    var ARIA = ['ariaAtomic', 'ariaAutoComplete', 'ariaBrailleLabel', 'ariaBrailleRoleDescription', 'ariaBusy', 'ariaChecked', 'ariaColCount', 'ariaColIndex', 'ariaColIndexText', 'ariaColSpan', 'ariaCurrent', 'ariaDescription', 'ariaDisabled', 'ariaExpanded', 'ariaHasPopup', 'ariaHidden', 'ariaInvalid', 'ariaKeyShortcuts', 'ariaLabel', 'ariaLevel', 'ariaLive', 'ariaModal', 'ariaMultiLine', 'ariaMultiSelectable', 'ariaOrientation', 'ariaPlaceholder', 'ariaPosInSet', 'ariaPressed', 'ariaReadOnly', 'ariaRelevant', 'ariaRequired', 'ariaRoleDescription', 'ariaRowCount', 'ariaRowIndex', 'ariaRowIndexText', 'ariaRowSpan', 'ariaSelected', 'ariaSetSize', 'ariaSort', 'ariaValueMax', 'ariaValueMin', 'ariaValueNow', 'ariaValueText'];
    function ariaAttr(p) { return p === 'role' ? 'role' : 'aria-' + p.slice(4).toLowerCase(); }
    ['role'].concat(ARIA).forEach(function (p) {
      var a = ariaAttr(p);
      def(EP, p, function () { return this.getAttribute(a); }, function (v) { if (v === null || v === undefined) this.removeAttribute(a); else this.setAttribute(a, v); });
    });
    var ARIA_REFS = { ariaActiveDescendantElement: 'aria-activedescendant', ariaControlsElements: 'aria-controls', ariaDescribedByElements: 'aria-describedby', ariaDetailsElements: 'aria-details', ariaErrorMessageElements: 'aria-errormessage', ariaFlowToElements: 'aria-flowto', ariaLabelledByElements: 'aria-labelledby', ariaOwnsElements: 'aria-owns' };
    Object.keys(ARIA_REFS).forEach(function (p) {
      var a = ARIA_REFS[p], one = !/Elements$/.test(p);
      def(EP, p, function () {
        var set = this._ariaRefs && this._ariaRefs[p];
        if (set !== undefined && this.getAttribute(a) === '') { set = (one ? [set] : set).filter(function (e) { return e && e.isConnected; }); return one ? set[0] || null : set.length ? set : null; }
        var v = this.getAttribute(a);
        if (v === null) return null;
        var root = this.getRootNode(), ids = v.trim().split(/\s+/), out = [];
        for (var i = 0; i < ids.length; i++) { var e = root.getElementById ? root.getElementById(ids[i]) : root.querySelector && root.querySelector('#' + G.CSS.escape(ids[i])); if (e) out.push(e); }
        return one ? out[0] || null : out.length ? out : null;
      }, function (v) {
        if (v === null || v === undefined) { if (this._ariaRefs) delete this._ariaRefs[p]; this.removeAttribute(a); return; }
        (this._ariaRefs || (this._ariaRefs = {}))[p] = one ? v : Array.from(v);
        this.setAttribute(a, '');
      });
    });
    def(EP, 'elementTiming', function () { return this.getAttribute('elementtiming') || ''; }, function (v) { this.setAttribute('elementtiming', v); });

    // HTMLElement
    reflect(HTMLElement, ['autocapitalize']);
    def(HP, 'enterKeyHint', function () { var v = (this.getAttribute('enterkeyhint') || '').toLowerCase(); return /^(enter|done|go|next|previous|search|send)$/.test(v) ? v : ''; }, function (v) { this.setAttribute('enterkeyhint', v); });
    def(HP, 'inputMode', function () { var v = (this.getAttribute('inputmode') || '').toLowerCase(); return /^(none|text|tel|url|email|numeric|decimal|search)$/.test(v) ? v : ''; }, function (v) { this.setAttribute('inputmode', v); });
    def(HP, 'translate', function () { for (var n = this; n && n.nodeType === 1; n = n.parentNode) { var t = n.getAttribute('translate'); if (t === '' || t === 'yes') return true; if (t === 'no') return false; } return true; }, function (v) { this.setAttribute('translate', v ? 'yes' : 'no'); });
    def(HP, 'nonce', function () { return this._nonce !== undefined ? this._nonce : this.getAttribute('nonce') || ''; }, function (v) { this._nonce = String(v); });
    if (!Object.getOwnPropertyDescriptor(HP, 'autofocus')) reflectBool(HTMLElement, ['autofocus']);
    def(SVGElement.prototype, 'nonce', function () { return this.getAttribute('nonce') || ''; }, function (v) { this.setAttribute('nonce', v); });

    // ElementInternals (HTML 4.13.7): form-associated custom elements, their
    // value, validity, custom states and default ARIA
    class CustomStateSet {
      constructor(el) { this._el = el; this._s = new Set(); }
      get size() { return this._s.size; }
      has(v) { return this._s.has(v); }
      add(v) { if (!this._s.has(v)) { this._s.add(v); changed(); } return this; }
      delete(v) { var r = this._s.delete(v); if (r) changed(); return r; }
      clear() { if (this._s.size) { this._s.clear(); changed(); } }
      forEach(fn, self) { var t = this; this._s.forEach(function (v) { fn.call(self, v, v, t); }); }
      values() { return this._s.values(); }
      keys() { return this._s.values(); }
      entries() { return this._s.entries(); }
      [Symbol.iterator]() { return this._s.values(); }
    }
    var VFLAGS = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'];
    class ElementInternals {
      constructor(el) { this._el = el; this._value = null; this._state = null; this._flags = {}; this._msg = ''; this._anchor = null; this.states = new CustomStateSet(el); }
      _fa() { if (!this._el.constructor || !this._el.constructor.formAssociated) throw DOMException("Failed to execute on 'ElementInternals': The target element is not a form-associated custom element.", 'NotSupportedError'); }
      get shadowRoot() { return this._el._sr || null; }
      setFormValue(v, state) { this._fa(); this._value = v; this._state = state === undefined ? v : state; }
      get form() { this._fa(); return formOf(this._el); }
      get labels() { this._fa(); return labelsOf(this._el); }
      get willValidate() { this._fa(); var e = this._el; if (e.hasAttribute("disabled") || e.hasAttribute("readonly")) return false; for (var n = e.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === "fieldset" && n.hasAttribute("disabled")) return false; return true; }
      get validity() {
        this._fa();
        var f = this._flags, v = {};
        VFLAGS.forEach(function (k) { v[k] = !!f[k]; });
        v.valid = !VFLAGS.some(function (k) { return f[k]; });
        return v;
      }
      get validationMessage() { this._fa(); return this.validity.valid ? '' : this._msg; }
      setValidity(flags, msg, anchor) {
        this._fa();
        flags = flags || {};
        var bad = VFLAGS.some(function (k) { return flags[k]; });
        if (bad && !msg) throw new TypeError("Failed to execute 'setValidity' on 'ElementInternals': The second argument should not be empty if one or more flags in the first argument are true.");
        var f = {}; VFLAGS.forEach(function (k) { f[k] = !!flags[k]; });
        this._flags = f; this._msg = bad ? String(msg) : ''; this._anchor = anchor || null;
        attrChanged(this._el); validityChanged(this._el);
      }
      checkValidity() { this._fa(); if (!this.willValidate || this.validity.valid) return true; dispatch(this._el, new Event('invalid', { cancelable: true })); return false; }
      reportValidity() { return this.checkValidity(); }
    }
    ['role'].concat(ARIA).forEach(function (p) { ElementInternals.prototype[p] = null; });
    Object.keys(ARIA_REFS).forEach(function (p) { ElementInternals.prototype[p] = null; });
    install('ElementInternals', ElementInternals);
    install('CustomStateSet', CustomStateSet);
    HP.attachInternals = function () {
      if (this._internals) throw DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals for the specified element was already attached.", 'NotSupportedError');
      if (this.localName.indexOf('-') < 0 || !customElementsRegistry[this.localName]) throw DOMException("Failed to execute 'attachInternals' on 'HTMLElement': Unable to attach ElementInternals to non-custom elements.", 'NotSupportedError');
      if (this.constructor.disabledFeatures && Array.from(this.constructor.disabledFeatures).indexOf('internals') >= 0) throw DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals is disabled by disabledFeature static field.", 'NotSupportedError');
      return (this._internals = new ElementInternals(this));
    };
    G.__internalsOf = function (el) { return el._internals || null; };

    // HTMLSelectElement, HTMLDialogElement
    HTMLSelectElement.prototype.showPicker = function () {
      if (isDisabled(this)) throw DOMException("Failed to execute 'showPicker' on 'HTMLSelectElement': HTMLSelectElement::showPicker() cannot be used on immutable controls.", 'InvalidStateError');
    };
    var DP = HTMLDialogElement.prototype;
    def(DP, 'returnValue', function () { return this._rv0 === undefined ? '' : this._rv0; }, function (v) { this._rv0 = String(v); });
    DP.requestClose = function (rv) {
      if (!this.open) return;
      if (!dispatch(this, new Event('cancel', { cancelable: true }))) return;
      this.close(rv);
    };
    reflect(HTMLDialogElement, []);
    def(DP, 'closedBy', function () { var v = (this.getAttribute('closedby') || '').toLowerCase(); return /^(any|closerequest|none)$/.test(v) ? v : this._modal ? 'closerequest' : 'none'; }, function (v) { this.setAttribute('closedby', v); });

    // ShadowRoot, HTMLSlotElement
    var SP = ShadowRoot.prototype;
    def(SP, 'slotAssignment', function () { return this._slotMode || 'named'; });
    def(SP, 'clonable', function () { return !!this._clonable; });
    def(SP, 'serializable', function () { return !!this._serializable; });
    SP.elementsFromPoint = function (x, y) { var out = []; for (var e = hitTest(x, y); e && e.nodeType === 1; e = upFlat(e)) { var t = retarget(e, this); if (t && t.nodeType === 1 && out.indexOf(t) < 0) out.push(t); } return out; };
    SP.getSelection = function () { return selection; };
    SP.getAnimations = function () { var out = []; eachElement(this, function (e) { if (e._waapi) e._waapi.forEach(function (a) { if (animationRelevant(a)) out.push(a); }); }); return out; };
    var attach0 = EP.attachShadow;
    EP.attachShadow = function (init) {
      var r = attach0.call(this, init);
      if (init) { r._slotMode = init.slotAssignment === 'manual' ? 'manual' : 'named'; r._clonable = !!init.clonable; r._serializable = !!init.serializable; }
      return r;
    };
    HTMLSlotElement.prototype.assign = function () {
      var nodes = Array.prototype.slice.call(arguments), self = this;
      (this._manual || []).forEach(function (n) { if (n._manualSlot === self) n._manualSlot = null; });
      this._manual = nodes;
      for (var i = 0; i < nodes.length; i++) nodes[i]._manualSlot = this;
      changed();
      var sr = shadowRootOf(this);
      if (sr) scheduleSlots(this);
    };

    // HTMLMediaElement: no media pipeline here; the state of a media
    // element that has nothing loaded (HAVE_NOTHING), as Chromium gives
    // for a source it cannot play
    var MP = HTMLMediaElement.prototype;
    reflectBool(HTMLMediaElement, ['loop', 'autoplay', 'controls', 'playsInline', 'disableRemotePlayback']);
    def(MP, 'muted', function () { return this._muted !== undefined ? this._muted : this.hasAttribute('muted'); }, function (v) { v = !!v; if (v !== this.muted) { this._muted = v; dispatch(this, new Event('volumechange')); } });
    def(MP, 'defaultMuted', function () { return this.hasAttribute('muted'); }, function (v) { this.toggleAttribute('muted', !!v); });
    def(MP, 'volume', function () { return this._vol === undefined ? 1 : this._vol; }, function (v) { v = +v; if (!(v >= 0 && v <= 1)) throw DOMException("Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (" + v + ') is outside the range [0, 1].', 'IndexSizeError'); if (v !== this.volume) { this._vol = v; dispatch(this, new Event('volumechange')); } });
    def(MP, 'playbackRate', function () { return this._rate === undefined ? 1 : this._rate; }, function (v) { this._rate = +v; dispatch(this, new Event('ratechange')); });
    def(MP, 'defaultPlaybackRate', function () { return this._drate === undefined ? 1 : this._drate; }, function (v) { this._drate = +v; });
    def(MP, 'currentTime', function () { return this._ct || 0; }, function (v) { this._ct = +v || 0; });
    def(MP, 'duration', function () { return NaN; });
    def(MP, 'paused', function () { return this._paused === undefined ? true : this._paused; });
    def(MP, 'ended', function () { return false; });
    def(MP, 'seeking', function () { return false; });
    def(MP, 'readyState', function () { return 0; });
    def(MP, 'networkState', function () { return this.getAttribute('src') ? 3 : 0; });
    def(MP, 'error', function () { return null; });
    def(MP, 'currentSrc', function () { var v = this.getAttribute('src'); return v ? resolveURL(v) : ''; });
    def(MP, 'srcObject', function () { return this._srcObj || null; }, function (v) { this._srcObj = v; });
    def(MP, 'buffered', function () { return { length: 0, start: function () { throw DOMException('Index out of range.', 'IndexSizeError'); }, end: function () { throw DOMException('Index out of range.', 'IndexSizeError'); } }; });
    def(MP, 'seekable', function () { return this.buffered; });
    def(MP, 'played', function () { return this.buffered; });
    reflect(HTMLMediaElement, ['preload', 'crossOrigin']);
    urlProp(HTMLMediaElement, ['src']);
    // (nothing ever loads: the element plays as one whose source is still
    // being fetched, its promise waits)
    MP.play = function () { if (this._paused !== false) { this._paused = false; dispatch(this, new Event('play')); } return new Promise(function () {}); };
    MP.pause = function () { if (this._paused === false) { this._paused = true; dispatch(this, new Event('pause')); } };
    MP.fastSeek = function (t) { this.currentTime = t; };
    MP.addTextTrack = function () { return { mode: 'disabled', cues: [], addCue: function () {}, removeCue: function () {} }; };
    def(MP, 'textTracks', function () { return []; });
    HTMLMediaElement.NETWORK_EMPTY = 0; HTMLMediaElement.NETWORK_IDLE = 1; HTMLMediaElement.NETWORK_LOADING = 2; HTMLMediaElement.NETWORK_NO_SOURCE = 3;
    HTMLMediaElement.HAVE_NOTHING = 0; HTMLMediaElement.HAVE_METADATA = 1; HTMLMediaElement.HAVE_CURRENT_DATA = 2; HTMLMediaElement.HAVE_FUTURE_DATA = 3; HTMLMediaElement.HAVE_ENOUGH_DATA = 4;
    def(HTMLVideoElement.prototype, 'videoWidth', function () { return 0; });
    def(HTMLVideoElement.prototype, 'videoHeight', function () { return 0; });
    urlProp(HTMLVideoElement, ['poster']);

    // SVGSVGElement: viewBox, width, height as animated values (SVG 2, 4.6)
    function animLength(el, a, dflt) {
      var base = { get value() { var v = el.getAttribute(a); if (v === null) return dflt; var n = parseFloat(v); if (/%$/.test(String(v).trim())) { var r = el.getBoundingClientRect(); return a === 'width' ? r.width : r.height; } return isNaN(n) ? dflt : n; }, set value(v) { el.setAttribute(a, String(v)); }, get valueAsString() { var v = el.getAttribute(a); return v === null ? '100%' : v; }, get unitType() { var v = el.getAttribute(a) || '100%'; return /%$/.test(v) ? 2 : /px$/.test(v) ? 5 : 1; } };
      return { baseVal: base, animVal: base };
    }
    def(SVGSVGElement.prototype, 'width', function () { return animLength(this, 'width', 0); });
    def(SVGSVGElement.prototype, 'height', function () { return animLength(this, 'height', 0); });
    def(SVGSVGElement.prototype, 'x', function () { return animLength(this, 'x', 0); });
    def(SVGSVGElement.prototype, 'y', function () { return animLength(this, 'y', 0); });
    def(SVGSVGElement.prototype, 'viewBox', function () {
      var el = this;
      function rect() { var v = el.getAttribute('viewBox'); if (v === null) return null; var p = v.trim().split(/[\s,]+/).map(Number); if (p.length !== 4 || p.some(isNaN)) return null; return p; }
      var base = {};
      ['x', 'y', 'width', 'height'].forEach(function (k, i) { def(base, k, function () { var r = rect(); return r ? r[i] : 0; }, function (v) { var r = rect() || [0, 0, 0, 0]; r[i] = +v; el.setAttribute('viewBox', r.join(' ')); }); });
      return { get baseVal() { return rect() ? base : null; }, get animVal() { return rect() ? base : null; } };
    });
    SVGSVGElement.prototype.createSVGRect = function () { return new DOMRect(0, 0, 0, 0); };
    SVGSVGElement.prototype.createSVGNumber = function () { return { value: 0 }; };
    SVGSVGElement.prototype.createSVGLength = function () { return { value: 0, unitType: 1, valueAsString: '0', newValueSpecifiedUnits: function (u, v) { this.value = v; this.unitType = u; }, convertToSpecifiedUnits: function () {} }; };
    SVGSVGElement.prototype.createSVGTransform = function () { return { type: 1, matrix: new DOMMatrix(), angle: 0, setMatrix: function (m) { this.matrix = m; }, setTranslate: function (x, y) { this.matrix = new DOMMatrix().translate(x, y); this.type = 2; }, setScale: function (x, y) { this.matrix = new DOMMatrix().scale(x, y); this.type = 3; }, setRotate: function (a) { this.matrix = new DOMMatrix().rotate(a); this.angle = a; this.type = 4; } }; };
    SVGSVGElement.prototype.getCurrentTime = function () { return 0; };
    SVGSVGElement.prototype.pauseAnimations = function () {};
    SVGSVGElement.prototype.unpauseAnimations = function () {};
    SVGSVGElement.prototype.forceRedraw = function () {};
    SVGSVGElement.prototype.suspendRedraw = function () { return 0; };
    SVGSVGElement.prototype.unsuspendRedraw = function () {};
    SVGSVGElement.prototype.unsuspendRedrawAll = function () {};

    // CSS.registerProperty (CSS Properties and Values API 1): as @property
    var registered = {};
    G.CSS.registerProperty = function (d) {
      if (!d || typeof d.name !== 'string' || d.name.slice(0, 2) !== '--') throw DOMException("Failed to execute 'registerProperty' on 'CSS': The name provided is not a custom property name.", 'SyntaxError');
      if (registered[d.name]) throw DOMException("Failed to execute 'registerProperty' on 'CSS': The name provided has already been registered.", 'InvalidModificationError');
      if (typeof d.inherits !== 'boolean') throw new TypeError("Failed to execute 'registerProperty' on 'CSS': required member inherits is undefined.");
      var syn = d.syntax === undefined ? '*' : String(d.syntax);
      if (syn !== '*' && d.initialValue === undefined) throw DOMException("Failed to execute 'registerProperty' on 'CSS': An initial value must be provided if the syntax is not '*'", 'SyntaxError');
      registered[d.name] = { syntax: syn, inherits: d.inherits, initialValue: d.initialValue };
      registerProp(d.name, d.inherits, d.initialValue, true);
    };

    // Blob: bytes() and stream(); Headers: getSetCookie()
    Blob.prototype.bytes = function () { return Promise.resolve(this._bytes()); };
    if (typeof G.ReadableStream === 'function') Blob.prototype.stream = function () { var b = this._bytes(); return new G.ReadableStream({ start: function (c) { if (b.length) c.enqueue(b); c.close(); } }); };
    else Blob.prototype.stream = function () {
      var b = this._bytes(), done = false;
      return { locked: false, getReader: function () { return { read: function () { if (done || !b.length) { done = true; return Promise.resolve({ value: undefined, done: true }); } done = true; return Promise.resolve({ value: b, done: false }); }, releaseLock: function () {}, cancel: function () { done = true; return Promise.resolve(); }, closed: Promise.resolve() }; }, cancel: function () { done = true; return Promise.resolve(); }, [Symbol.asyncIterator]: function () { var r = this.getReader(); return { next: function () { return r.read(); }, return: function () { return Promise.resolve({ done: true }); } }; } };
    };
    G.Headers.prototype.getSetCookie = function () { var v = this.get('set-cookie'); return v === null ? [] : v.split(/,\s*(?=[^;=\s]+=)/); };

    // FormData (XHR 5): a form's entries as a submission makes them, or
    // appended ones
    function formEntries(form, submitter) {
      var out = [];
      var els = form.elements || [];
      for (var i = 0; i < els.length; i++) {
        var e = els[i], ln = e.localName;
        if (e._internals && e.constructor.formAssociated) {
          var it = e._internals, fv = it._value, fnm = e.getAttribute('name');
          if (isDisabled(e) || e.hasAttribute('disabled') || fv === null || fv === undefined) continue;
          if (fv instanceof FormData) fv._e.forEach(function (p) { out.push([p[0], p[1]]); });
          else if (fnm) out.push([fnm, fv]);
          continue;
        }
        if (isDisabled(e) || (e.closest && e.closest('datalist'))) continue;
        if (ln === 'button' || (ln === 'input' && /^(submit|image|button|reset)$/.test(e.type))) { if (e !== submitter || !e.name) continue; }
        if (ln === 'fieldset' || ln === 'output' || ln === 'object') continue;
        var name = e.getAttribute('name');
        if (ln === 'input' && e.type === 'image' && e === submitter) { var pre = name ? name + '.' : ''; out.push([pre + 'x', '0'], [pre + 'y', '0']); continue; }
        if (!name) continue;
        if (ln === 'input' && (e.type === 'checkbox' || e.type === 'radio')) { if (e.checked) out.push([name, e.hasAttribute('value') ? e.getAttribute('value') : 'on']); continue; }
        if (ln === 'select') { e.options.forEach(function (o) { if (o.selected && !isDisabled(o)) out.push([name, o.value]); }); continue; }
        if (ln === 'input' && e.type === 'file') { var fs = e.files || []; if (!fs.length) out.push([name, new File([], '', { type: 'application/octet-stream' })]); for (var f = 0; f < fs.length; f++) out.push([name, fs[f]]); continue; }
        var v = e.value;
        if (ln === 'textarea') v = String(v).replace(/\r\n?/g, '\n');
        out.push([name, String(v)]);
        var dn = e.getAttribute('dirname');
        if (dn && (ln === 'textarea' || ln === 'input')) out.push([dn, 'ltr']);
      }
      return out;
    }
    function fdValue(v, fname) {
      if (v instanceof Blob) {
        if (!(v instanceof File) || fname !== undefined) { var f = new File([], fname !== undefined ? String(fname) : v instanceof File ? v.name : 'blob', { type: v.type, lastModified: v.lastModified }); f._s = v._s; return f; }
        return v;
      }
      return String(v);
    }
    class FormData {
      constructor(form, submitter) {
        this._e = [];
        if (form !== undefined && form !== null) {
          if (!(form instanceof HTMLFormElement)) throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
          if (submitter && (submitter.form !== form)) throw DOMException("Failed to construct 'FormData': The specified element is not owned by this form element.", 'NotFoundError');
          this._e = formEntries(form, submitter || null).map(function (p) { return [p[0], fdValue(p[1])]; });
        }
      }
      append(n, v, f) { this._e.push([String(n), fdValue(v, f)]); }
      delete(n) { n = String(n); this._e = this._e.filter(function (p) { return p[0] !== n; }); }
      get(n) { n = String(n); for (var i = 0; i < this._e.length; i++) if (this._e[i][0] === n) return this._e[i][1]; return null; }
      getAll(n) { n = String(n); return this._e.filter(function (p) { return p[0] === n; }).map(function (p) { return p[1]; }); }
      has(n) { n = String(n); return this._e.some(function (p) { return p[0] === n; }); }
      set(n, v, f) {
        n = String(n); v = fdValue(v, f);
        var i = -1;
        for (var k = 0; k < this._e.length; k++) if (this._e[k][0] === n) { if (i < 0) { i = k; this._e[k] = [n, v]; } else { this._e.splice(k, 1); k--; } }
        if (i < 0) this._e.push([n, v]);
      }
      forEach(fn, self) { var l = this._e.slice(); for (var i = 0; i < l.length; i++) fn.call(self, l[i][1], l[i][0], this); }
      entries() { return this._e.map(function (p) { return [p[0], p[1]]; })[Symbol.iterator](); }
      keys() { return this._e.map(function (p) { return p[0]; })[Symbol.iterator](); }
      values() { return this._e.map(function (p) { return p[1]; })[Symbol.iterator](); }
      [Symbol.iterator]() { return this.entries(); }
      get [Symbol.toStringTag]() { return 'FormData'; }
    }
    install('FormData', FormData);
    G.__formEntries = formEntries;
    // (a FormData body: urlencoded when every value is text, the way a
    // host that carries text only can send it; formData() reads either
    // form back)
    G.Response.prototype.formData = G.Request.prototype.formData = function () {
      var self = this, type = (this.headers.get('content-type') || '').toLowerCase();
      return this.text().then(function (t) {
        var fd = new FormData();
        if (type.indexOf('application/x-www-form-urlencoded') >= 0 || !/multipart/.test(type)) { new URLSearchParams(t).forEach(function (v, k) { fd.append(k, v); }); return fd; }
        var m = /boundary=("?)([^";]+)\1/.exec(type);
        if (!m) throw new TypeError('Failed to fetch');
        t.split('--' + m[2]).slice(1, -1).forEach(function (part) {
          var at = part.indexOf('\r\n\r\n'); if (at < 0) return;
          var head = part.slice(0, at), body = part.slice(at + 4).replace(/\r\n$/, '');
          var nm = /name="([^"]*)"/.exec(head), fn = /filename="([^"]*)"/.exec(head), ct = /content-type:\s*([^\r\n]+)/i.exec(head);
          if (!nm) return;
          if (fn) fd.append(nm[1], new File([body], fn[1], { type: ct ? ct[1] : '' })); else fd.append(nm[1], body);
        });
        return fd;
      });
    };
  })();

  // until __page: an empty document
  doc = newDocument('about:blank');
  parseInto('<html><head></head><body></body></html>', doc, doc);
  install('document', doc);
})(this);
