// SPDX-License-Identifier: MIT
//! DomPaint -- a page's frame that changed only what is drawn, drawn
//! without building or laying out anything (EVG's EVGRetain, the rule
//! RangerGames uses for its JSX trees too).
//!
//! A host keeps the last render tree and the elements DomView built from
//! it. When the next tree (a delta put together) differs from it only in
//! paint properties of boxes that already have their elements, `compare`
//! says so and notes what changed; `apply` writes those values on the kept
//! elements (`EVGRetain.patch`), and the host measures the paint bounds
//! again (`EVGRetain.paintFrame`) instead of building and laying out the
//! page. Anything else, and anything this cannot prove to change only
//! paint, takes the full path.
//!
//! What counts as paint here is narrower than EVGRetain's list, because
//! DomView reads these properties for more than painting:
//!
//! - `transform`, only from one transform to another: a box with a
//!   transform is the containing block of the fixed boxes in it, starts a
//!   stacking context and resets what clips its absolute boxes, so a box
//!   that gets or loses one is built again. Not on a relatively positioned
//!   box either, whose offset DomView writes into its transform.
//! - `opacity`, only from one value under 1 to another (1 or none makes
//!   no stacking context).
//! - `background-color`, only from one colour that shows to another: a
//!   cell, an inline or a band with a background is laid out otherwise.
//!
//! and only on a box of its own (block, flex, grid and their inline kinds)
//! of an ordinary tag, not hidden, clipped or the page's root or body.
//! Removed properties and changed attributes (but the `style` one, which
//! the computed style already holds) take the full path.
//!
//! A text node's text changed is EVGRetain's tier 2: written on the one
//! text element DomView drew it as (`EVGRetain.patchText`), and the host
//! lays out only the path to it (`EVGRetain.layoutFrame`), as RangerGames
//! does. Only when that element holds the node's whole text as it came
//! (no white space DomView would collapse or trim), and the new text is
//! of the same kind: a word for a word (DomView draws the words of a run
//! of mixed looks as elements of their own), any text for a text drawn
//! whole.
//!
//! An inline `<svg>` whose markup changed (a shape's `d`, `fill` or
//! `stroke`, a game's moving pieces) is paint only too, when its opening
//! tag is the same and has a `viewBox`: the box's size does not come from
//! what is in it then, and DomView draws the markup as it came. `patchSvg`
//! writes the new markup and its parsed document on the element (the same
//! call RangerGames makes for its path patches).

use ranger::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::dom_view::DomView;
use crate::rgr::{EVGElement, EVGRetain, SvgParser};
use rangerdom_json::JsonValue;

pub struct DomPaint {
    /// what `compare` found: node ids, property names, new values
    pub ids: Vec<String>,
    pub names: Vec<String>,
    pub vals: Vec<String>,
    pub ok: bool,
    /// texts changed: the text node's id (its last one) and its parent's,
    /// the ids DomView names its element by, the text drawn, the new text
    pub tids: Vec<String>,
    pub tpars: Vec<String>,
    pub tolds: Vec<String>,
    pub tnews: Vec<String>,
    /// text nodes set anew: their old and new ids
    renOld: Vec<String>,
    renNew: Vec<String>,
    /// accessible names changed: node ids, their new "ax"
    axIds: Vec<String>,
    axVals: Vec<Rc<RefCell<JsonValue>>>,
    /// inline pictures whose markup changed: node ids, the new markup
    pub svgIds: Vec<String>,
    pub svgVals: Vec<String>,
    /// the parent of the nodes `node` looks at
    parent: String,
    /// the text elements `apply` wrote on: the host lays out the path to
    /// them (empty: paint only)
    #[doc(hidden)]
    pub dirty: Vec<Rc<RefCell<EVGElement>>>,
    /// the nodes found the same and the stamps they get once all is found
    same: Vec<Rc<RefCell<JsonValue>>>,
    stamps: Vec<i64>,
}

impl DomPaint {
    pub fn new() -> Self {
        DomPaint {
            ids: Vec::new(),
            names: Vec::new(),
            vals: Vec::new(),
            ok: true,
            tids: Vec::new(),
            tpars: Vec::new(),
            tolds: Vec::new(),
            tnews: Vec::new(),
            renOld: Vec::new(),
            renNew: Vec::new(),
            axIds: Vec::new(),
            axVals: Vec::new(),
            svgIds: Vec::new(),
            svgVals: Vec::new(),
            parent: String::new(),
            dirty: Vec::new(),
            same: Vec::new(),
            stamps: Vec::new(),
        }
    }
    /// whether the render tree `now` is `was` but for paint properties of
    /// boxes and texts (noted for `apply`)
    pub fn compare(&mut self, was: &Rc<RefCell<JsonValue>>, now: &Rc<RefCell<JsonValue>>) -> bool {
        self.ids = Vec::new();
        self.names = Vec::new();
        self.vals = Vec::new();
        self.ok = true;
        self.tids = Vec::new();
        self.tpars = Vec::new();
        self.tolds = Vec::new();
        self.tnews = Vec::new();
        self.renOld = Vec::new();
        self.renNew = Vec::new();
        self.axIds = Vec::new();
        self.axVals = Vec::new();
        self.svgIds = Vec::new();
        self.svgVals = Vec::new();
        self.parent = String::new();
        self.same = Vec::new();
        self.stamps = Vec::new();
        self.node(was, now);
        if !self.ok || (self.ids.is_empty() && self.tids.is_empty() && self.svgIds.is_empty()) {
            return false;
        }
        true
    }
    fn node(&mut self, was: &Rc<RefCell<JsonValue>>, now: &Rc<RefCell<JsonValue>>) {
        if !self.ok || Rc::ptr_eq(was, now) {
            return;
        }
        let kind: i64 = now.borrow().kind;
        if was.borrow().kind != kind {
            self.ok = false;
            return;
        }
        if kind != 5 {
            if was.borrow().toJson() != now.borrow().toJson() {
                self.ok = false;
            }
            return;
        }
        let wk: Vec<String> = DomPaint::keysOf(was);
        let nk: Vec<String> = DomPaint::keysOf(now);
        if wk.len() != nk.len() {
            self.ok = false;
            return;
        }
        let n: i64 = nk.len() as i64;
        for i in 0..n {
            if wk[i as usize] != nk[i as usize] {
                self.ok = false;
                return;
            }
        }
        for k in nk.iter().cloned() {
            if !self.ok {
                return;
            }
            let wv: Rc<RefCell<JsonValue>> = was.borrow().get(&k);
            let nv: Rc<RefCell<JsonValue>> = now.borrow().get(&k);
            if Rc::ptr_eq(&wv, &nv) {
                continue;
            }
            if k == "c" {
                let up: String = self.parent.clone();
                self.parent = now.borrow().getText("i");
                self.kids(&wv, &nv);
                self.parent = up;
            } else if k == "x" {
                self.text(&was.borrow().getText("i"), &wv, &nv);
            } else if k == "i" && now.borrow().has("x") {
                // (a text node set anew: its elements are named again; the
                // same id written again is no rename, and a rename walks
                // the whole tree)
                let a: String = wv.borrow().text();
                let b: String = nv.borrow().text();
                if a != b {
                    self.renOld.push(a);
                    self.renNew.push(b);
                }
                continue;
            } else if k == "ax" {
                self.ax(now, &wv, &nv);
            } else if k == "s" {
                self.style(now, &wv, &nv);
            } else if k == "a" {
                self.attrs(&wv, &nv);
            } else if k == "svg" {
                self.svg(now, &wv, &nv);
            } else if wv.borrow().toJson() != nv.borrow().toJson() {
                self.ok = false;
            }
        }
        if self.ok {
            self.same.push(Rc::clone(now));
            self.stamps.push(was.borrow().stamp);
        }
    }
    fn kids(&mut self, wc: &Rc<RefCell<JsonValue>>, nc: &Rc<RefCell<JsonValue>>) {
        if wc.borrow().kind != 4 || nc.borrow().kind != 4 {
            if wc.borrow().toJson() != nc.borrow().toJson() {
                self.ok = false;
            }
            return;
        }
        let wi: Vec<Rc<RefCell<JsonValue>>> = wc.borrow().items.clone();
        let ni: Vec<Rc<RefCell<JsonValue>>> = nc.borrow().items.clone();
        if wi.len() != ni.len() {
            self.ok = false;
            return;
        }
        let n: i64 = ni.len() as i64;
        for i in 0..n {
            self.node(&wi[i as usize], &ni[i as usize]);
            if !self.ok {
                return;
            }
        }
    }
    fn text(&mut self, own: &str, wv: &Rc<RefCell<JsonValue>>, nv: &Rc<RefCell<JsonValue>>) {
        let a: String = wv.borrow().text();
        let b: String = nv.borrow().text();
        if a == b {
            return;
        }
        if wv.borrow().kind != 3 || nv.borrow().kind != 3 || self.parent.is_empty() || !DomPaint::plainText(&a) || !DomPaint::plainText(&b) {
            self.ok = false;
            return;
        }
        // (a word for a word: a word may be one of a run's words)
        if !DomPaint::spaced(&a) && DomPaint::spaced(&b) {
            self.ok = false;
            return;
        }
        self.tids.push(own.to_string());
        self.tpars.push(self.parent.clone());
        self.tolds.push(a);
        self.tnews.push(b);
    }
    /// an inline picture's markup changed: paint only when the opening
    /// tags are the same and have a viewBox (the box's size and the
    /// picture's mapping into it are then the same, and DomView takes the
    /// markup as it is)
    fn svg(&mut self, node: &Rc<RefCell<JsonValue>>, wv: &Rc<RefCell<JsonValue>>, nv: &Rc<RefCell<JsonValue>>) {
        let a: String = wv.borrow().text();
        let b: String = nv.borrow().text();
        if a == b {
            return;
        }
        if wv.borrow().kind != 3 || nv.borrow().kind != 3 {
            self.ok = false;
            return;
        }
        let ta: String = DomPaint::openTag(&a);
        if ta.is_empty() || ta != DomPaint::openTag(&b) || !ta.contains(" viewBox=") {
            self.ok = false;
            return;
        }
        self.svgIds.push(node.borrow().getText("i"));
        self.svgVals.push(b);
    }
    /// the markup's first `<svg ...>` tag, "" when it starts otherwise
    fn openTag(m: &str) -> String {
        if !m.starts_with("<svg") {
            return String::new();
        }
        let end: Option<usize> = m.find('>');
        if end.is_none() {
            return String::new();
        }
        m[0..end.unwrap()].to_string()
    }
    /// an inline picture's new markup written on the element DomView drew
    /// it as: the markup and its document, parsed here (what DomView would
    /// have built from it); the host then measures the paint bounds again
    /// (`EVGRetain.paintFrame`)
    #[doc(hidden)]
    pub fn patchSvg(el: &Rc<RefCell<EVGElement>>, markup: &str) {
        EVGElement::set_attribute(el, "svg", markup.to_string());
        let sp: Rc<RefCell<SvgParser>> = Rc::new(RefCell::new(SvgParser::new()));
        el.borrow_mut().svg_doc = Some(SvgParser::parse(&sp, markup.to_string()));
        el.borrow_mut().svg_doc_key = markup.to_string();
        let st: i64 = el.borrow().paint_stamp + 1;
        el.borrow_mut().paint_stamp = st;
    }
    /// the accessible name, value or description of an element changed
    /// (its text did): written on its element by `apply` as DomView does
    fn ax(&mut self, node: &Rc<RefCell<JsonValue>>, wa: &Rc<RefCell<JsonValue>>, na: &Rc<RefCell<JsonValue>>) {
        if wa.borrow().kind != 5 || na.borrow().kind != 5 {
            self.ok = false;
            return;
        }
        let wk: Vec<String> = wa.borrow().keys.clone();
        let nk: Vec<String> = na.borrow().keys.clone();
        if wk.len() != nk.len() {
            self.ok = false;
            return;
        }
        let n: i64 = nk.len() as i64;
        let mut changed: bool = false;
        for i in 0..n {
            let k: String = nk[i as usize].clone();
            if wk[i as usize] != k {
                self.ok = false;
                return;
            }
            let same: bool = wa.borrow().get(&k).borrow().toJson() == na.borrow().get(&k).borrow().toJson();
            if !same && k != "n" && k != "v" && k != "d" {
                self.ok = false;
                return;
            }
            if !same {
                changed = true;
            }
        }
        // (the same name, value and description: nothing to write)
        if !changed {
            return;
        }
        self.axIds.push(node.borrow().getText("i"));
        self.axVals.push(Rc::clone(na));
    }
    /// text DomView draws as it is: no white space but single spaces
    /// between words
    fn plainText(t: &str) -> bool {
        if t.is_empty() || t.starts_with(' ') || t.ends_with(' ') || t.contains("  ") {
            return false;
        }
        for c in t.chars() {
            if c == '\n' || c == '\t' || c == '\r' || c == '\u{a0}' || c == '\u{ad}' || c == '\u{200b}' {
                return false;
            }
        }
        true
    }
    fn spaced(t: &str) -> bool {
        t.contains(' ')
    }
    fn attrs(&mut self, wa: &Rc<RefCell<JsonValue>>, na: &Rc<RefCell<JsonValue>>) {
        if wa.borrow().kind != 5 || na.borrow().kind != 5 {
            if wa.borrow().toJson() != na.borrow().toJson() {
                self.ok = false;
            }
            return;
        }
        let wk: Vec<String> = wa.borrow().keys.clone();
        let nk: Vec<String> = na.borrow().keys.clone();
        if wk.len() != nk.len() {
            self.ok = false;
            return;
        }
        let n: i64 = nk.len() as i64;
        for i in 0..n {
            let k: String = nk[i as usize].clone();
            if wk[i as usize] != k {
                self.ok = false;
                return;
            }
            if k != "style" && wa.borrow().get(&k).borrow().toJson() != na.borrow().get(&k).borrow().toJson() {
                self.ok = false;
                return;
            }
        }
    }
    fn style(&mut self, node: &Rc<RefCell<JsonValue>>, ws: &Rc<RefCell<JsonValue>>, ns: &Rc<RefCell<JsonValue>>) {
        if ws.borrow().kind != 5 || ns.borrow().kind != 5 {
            self.ok = false;
            return;
        }
        // (the same text is the same object, JsonMemo)
        if Rc::ptr_eq(ws, ns) {
            return;
        }
        // (the members in the same order, as the same element's style
        // renders them: compared side by side, without a lookup by name
        // for each; 500 boxes of 40 members a frame)
        if DomPaint::sameKeys(ws, ns) {
            let n: i64 = ns.borrow().keys.len() as i64;
            for i in 0..n {
                let wv: Rc<RefCell<JsonValue>> = ws.borrow().items[i as usize].clone();
                let nv: Rc<RefCell<JsonValue>> = ns.borrow().items[i as usize].clone();
                if Rc::ptr_eq(&wv, &nv) {
                    continue;
                }
                if wv.borrow().kind == 3 && nv.borrow().kind == 3 && wv.borrow().str == nv.borrow().str {
                    continue;
                }
                let a: String = wv.borrow().text();
                let b: String = nv.borrow().text();
                if a == b {
                    continue;
                }
                let k: String = ns.borrow().keys[i as usize].clone();
                if !DomPaint::paintable(node, ns, &k, &a, &b) {
                    self.ok = false;
                    return;
                }
                self.ids.push(node.borrow().getText("i"));
                self.names.push(k);
                self.vals.push(b);
            }
            return;
        }
        let wk: Vec<String> = ws.borrow().keys.clone();
        for k in wk.iter().cloned() {
            if !ns.borrow().has(&k) {
                self.ok = false;
                return;
            }
        }
        let nk: Vec<String> = ns.borrow().keys.clone();
        for k in nk.iter().cloned() {
            let b: String = ns.borrow().getText(&k);
            let had: bool = ws.borrow().has(&k);
            let a: String = ws.borrow().getText(&k);
            if had && a == b {
                continue;
            }
            if !had || !DomPaint::paintable(node, ns, &k, &a, &b) {
                self.ok = false;
                return;
            }
            self.ids.push(node.borrow().getText("i"));
            self.names.push(k.clone());
            self.vals.push(b.clone());
        }
    }
    /// a delta's patched node ({"n": N, "m": M, "ps": {...}, "sa": "..."},
    /// webapi.js __deltaPatch): the kept node M with the members of "ps"
    /// written over its style and "sa" as its style attribute, its
    /// children and everything else M's, under the number N. A box whose
    /// transform or opacity alone changed is sent as these few bytes, not
    /// its whole render.
    pub fn patchedNode(base: &Rc<RefCell<JsonValue>>, d: &Rc<RefCell<JsonValue>>) -> Rc<RefCell<JsonValue>> {
        let out: Rc<RefCell<JsonValue>> = DomPaint::copyObj(base);
        out.borrow_mut().put("n", d.borrow().get("n"));
        let ps: Rc<RefCell<JsonValue>> = d.borrow().get("ps");
        if ps.borrow().kind == 5 {
            let st: Rc<RefCell<JsonValue>> = DomPaint::copyObj(&base.borrow().get("s"));
            let n: i64 = ps.borrow().keys.len() as i64;
            for i in 0..n {
                let k: String = ps.borrow().keys[i as usize].clone();
                let v: Rc<RefCell<JsonValue>> = ps.borrow().items[i as usize].clone();
                st.borrow_mut().put(&k, v);
            }
            out.borrow_mut().put("s", st);
        }
        if d.borrow().has("sa") {
            let at: Rc<RefCell<JsonValue>> = DomPaint::copyObj(&base.borrow().get("a"));
            at.borrow_mut().put("style", d.borrow().get("sa"));
            out.borrow_mut().put("a", at);
        }
        out
    }
    /// an object's members in a new object (the values shared)
    fn copyObj(o: &Rc<RefCell<JsonValue>>) -> Rc<RefCell<JsonValue>> {
        let out: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        if o.borrow().kind != 5 {
            return out;
        }
        let n: i64 = o.borrow().keys.len() as i64;
        for i in 0..n {
            let k: String = o.borrow().keys[i as usize].clone();
            out.borrow_mut().keys.push(k);
            let v: Rc<RefCell<JsonValue>> = o.borrow().items[i as usize].clone();
            out.borrow_mut().items.push(v);
        }
        out
    }
    /// whether two objects have the same member names in the same order
    fn sameKeys(a: &Rc<RefCell<JsonValue>>, b: &Rc<RefCell<JsonValue>>) -> bool {
        let n: i64 = a.borrow().keys.len() as i64;
        if (b.borrow().keys.len() as i64) != n {
            return false;
        }
        for i in 0..n {
            if a.borrow().keys[i as usize] != b.borrow().keys[i as usize] {
                return false;
            }
        }
        true
    }
    /// a node's member names but its number ("n"), which a delta gives
    /// anew to every node it sends
    fn keysOf(n: &Rc<RefCell<JsonValue>>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let ks: Vec<String> = n.borrow().keys.clone();
        for k in ks.iter().cloned() {
            if k != "n" {
                out.push(k);
            }
        }
        out
    }
    /// whether `name` going from `a` to `b` on this node changes only how
    /// its box is drawn (see above)
    #[doc(hidden)]
    pub fn paintable(node: &Rc<RefCell<JsonValue>>, s: &Rc<RefCell<JsonValue>>, name: &str, a: &str, b: &str) -> bool {
        let t: String = node.borrow().getText("t");
        if !DomPaint::plainTag(&t) {
            return false;
        }
        let d: String = s.borrow().getText("display");
        if !(d == "block" || d == "flex" || d == "grid" || d == "inline-block" || d == "inline-flex" || d == "inline-grid") {
            return false;
        }
        let p: String = s.borrow().getText("position");
        if p == "relative" || p == "sticky" || s.borrow().has("rel-left") || s.borrow().has("rel-top") {
            return false;
        }
        if s.borrow().getText("visibility") == "hidden" || s.borrow().has("clip") {
            return false;
        }
        if name == "transform" {
            return DomPaint::shown(a, "none") && DomPaint::shown(b, "none");
        }
        if name == "opacity" {
            return DomPaint::shown(a, "1") && DomPaint::shown(b, "1");
        }
        if name == "background-color" {
            return DomPaint::painted(a) && DomPaint::painted(b);
        }
        false
    }
    fn shown(v: &str, off: &str) -> bool {
        !v.is_empty() && v != off
    }
    fn painted(v: &str) -> bool {
        !v.is_empty() && v != "transparent" && v != "rgba(0, 0, 0, 0)"
    }
    fn plainTag(t: &str) -> bool {
        t == "div" || t == "span" || t == "section" || t == "article" || t == "header" || t == "footer" || t == "main" || t == "nav" || t == "aside" || t == "li" || t == "ul" || t == "ol" || t == "p" || t == "a" || t == "h1" || t == "h2" || t == "h3" || t == "h4" || t == "h5" || t == "h6" || t == "figure" || t == "label"
    }
    /// what `compare` noted, written on the elements DomView built under
    /// `top` (ids mfd-xd-<index>-<node>): false, and nothing written, when
    /// a node's element is not there. Once written, the nodes `compare`
    /// found the same get the stamps of the last tree's, so the next full
    /// build takes their elements.
    #[doc(hidden)]
    pub fn apply(&mut self, top: &Rc<RefCell<EVGElement>>, index: i64) -> bool {
        self.dirty = Vec::new();
        let pfx: String = format!("mfd-xd-{}-", index);
        let mut want: HashMap<String, bool> = HashMap::new();
        for id in self.ids.iter() {
            want.insert(format!("{}{}", pfx, id), true);
        }
        for id in self.axIds.iter() {
            want.insert(format!("{}{}", pfx, id), true);
        }
        for id in self.svgIds.iter() {
            want.insert(format!("{}{}", pfx, id), true);
        }
        let mut found: HashMap<String, Rc<RefCell<EVGElement>>> = HashMap::new();
        let mut twice: HashMap<String, bool> = HashMap::new();
        DomPaint::find(top, &want, &mut found, &mut twice);
        let n: i64 = self.ids.len() as i64;
        for i in 0..n {
            let fid: String = format!("{}{}", pfx, self.ids[i as usize]);
            if !found.contains_key(&fid) || twice.contains_key(&fid) {
                return false;
            }
        }
        for id in self.axIds.iter() {
            let fid: String = format!("{}{}", pfx, id);
            if !found.contains_key(&fid) || twice.contains_key(&fid) {
                return false;
            }
        }
        for id in self.svgIds.iter() {
            let fid: String = format!("{}{}", pfx, id);
            if !found.contains_key(&fid) || twice.contains_key(&fid) {
                return false;
            }
            // (the picture's own element: DomView may have drawn a
            // fallback in its place)
            if found.get(&fid).cloned().unwrap().borrow().tag_name != "svg" {
                return false;
            }
        }
        let mut texts: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let tn: i64 = self.tids.len() as i64;
        for i in 0..tn {
            let mut t: Option<Rc<RefCell<EVGElement>>> = DomPaint::textOf(top, &format!("{}{}", pfx, self.tids[i as usize]), &self.tolds[i as usize]);
            if t.is_none() {
                t = DomPaint::textOf(top, &format!("{}{}", pfx, self.tpars[i as usize]), &self.tolds[i as usize]);
            }
            if t.is_none() {
                return false;
            }
            let te: Rc<RefCell<EVGElement>> = t.unwrap();
            for d in texts.iter() {
                if Rc::ptr_eq(d, &te) {
                    return false;
                }
            }
            texts.push(te);
        }
        for i in 0..n {
            let el: Rc<RefCell<EVGElement>> = found.get(&format!("{}{}", pfx, self.ids[i as usize])).cloned().unwrap();
            EVGRetain::patch(&el, &self.names[i as usize], &self.vals[i as usize]);
        }
        let an: i64 = self.axIds.len() as i64;
        for i in 0..an {
            let el: Rc<RefCell<EVGElement>> = found.get(&format!("{}{}", pfx, self.axIds[i as usize])).cloned().unwrap();
            DomView::applyAx(&el, &self.axVals[i as usize]);
        }
        let svn: i64 = self.svgIds.len() as i64;
        for i in 0..svn {
            let el: Rc<RefCell<EVGElement>> = found.get(&format!("{}{}", pfx, self.svgIds[i as usize])).cloned().unwrap();
            DomPaint::patchSvg(&el, &self.svgVals[i as usize]);
        }
        for i in 0..tn {
            EVGRetain::patch_text(&texts[i as usize], self.tnews[i as usize].clone());
        }
        let rn: i64 = self.renOld.len() as i64;
        for i in 0..rn {
            DomPaint::rename(top, &format!("{}{}", pfx, self.renOld[i as usize]), &format!("{}{}", pfx, self.renNew[i as usize]));
        }
        self.dirty = texts;
        // (only now: a node whose elements a full build would take must
        // have its changes written on them)
        let sn: i64 = self.same.len() as i64;
        for i in 0..sn {
            self.same[i as usize].borrow_mut().stamp = self.stamps[i as usize];
        }
        true
    }
    /// the one element under `top` with this id and a text, when its text
    /// is `text`
    fn textOf(top: &Rc<RefCell<EVGElement>>, id: &str, text: &str) -> Option<Rc<RefCell<EVGElement>>> {
        let mut all: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        DomPaint::texts(top, id, &mut all);
        if all.len() != 1 {
            return None;
        }
        let el: Rc<RefCell<EVGElement>> = all[0].clone();
        if el.borrow().text_content != text || !el.borrow().children.is_empty() {
            return None;
        }
        Some(el)
    }
    fn rename(el: &Rc<RefCell<EVGElement>>, was: &str, now: &str) {
        if el.borrow().id == was {
            el.borrow_mut().id = now.to_string();
        }
        let ks: Vec<Rc<RefCell<EVGElement>>> = el.borrow().children.clone();
        for k in ks.iter() {
            DomPaint::rename(k, was, now);
        }
    }
    fn texts(el: &Rc<RefCell<EVGElement>>, id: &str, out: &mut Vec<Rc<RefCell<EVGElement>>>) {
        if el.borrow().id == id && !el.borrow().text_content.is_empty() {
            out.push(Rc::clone(el));
        }
        let ks: Vec<Rc<RefCell<EVGElement>>> = el.borrow().children.clone();
        for k in ks.iter() {
            DomPaint::texts(k, id, out);
        }
    }
    #[doc(hidden)]
    fn find(el: &Rc<RefCell<EVGElement>>, want: &HashMap<String, bool>, found: &mut HashMap<String, Rc<RefCell<EVGElement>>>, twice: &mut HashMap<String, bool>) {
        let id: String = el.borrow().id.clone();
        if want.contains_key(&id) {
            // (one element a node: a second of the same id means DomView
            // built more than a box for it, which this does not patch)
            if found.contains_key(&id) {
                twice.insert(id.clone(), true);
            } else {
                found.insert(id.clone(), Rc::clone(el));
            }
        }
        let ks: Vec<Rc<RefCell<EVGElement>>> = el.borrow().children.clone();
        for k in ks.iter() {
            DomPaint::find(k, want, found, twice);
        }
    }
}
