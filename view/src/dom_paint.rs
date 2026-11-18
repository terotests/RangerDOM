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

use ranger::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::rgr::{EVGElement, EVGRetain};
use rangerdom_json::JsonValue;

pub struct DomPaint {
    /// what `compare` found: node ids, property names, new values
    pub ids: Vec<String>,
    pub names: Vec<String>,
    pub vals: Vec<String>,
    pub ok: bool,
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
            same: Vec::new(),
            stamps: Vec::new(),
        }
    }
    /// whether the render tree `now` is `was` but for paint properties of
    /// boxes (noted for `apply`). The nodes found the same get the stamps
    /// of the last tree's, so the next full build takes their elements.
    pub fn compare(&mut self, was: &Rc<RefCell<JsonValue>>, now: &Rc<RefCell<JsonValue>>) -> bool {
        self.ids = Vec::new();
        self.names = Vec::new();
        self.vals = Vec::new();
        self.ok = true;
        self.same = Vec::new();
        self.stamps = Vec::new();
        self.node(was, now);
        if !self.ok || self.ids.is_empty() {
            return false;
        }
        // (only now: a node whose elements a full build would take must
        // have its paint changes written on them)
        let n: i64 = self.same.len() as i64;
        for i in 0..n {
            self.same[i as usize].borrow_mut().stamp = self.stamps[i as usize];
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
                self.kids(&wv, &nv);
            } else if k == "s" {
                self.style(now, &wv, &nv);
            } else if k == "a" {
                self.attrs(&wv, &nv);
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
    /// a node's element is not there
    #[doc(hidden)]
    pub fn apply(&self, top: &Rc<RefCell<EVGElement>>, index: i64) -> bool {
        let pfx: String = format!("mfd-xd-{}-", index);
        let mut want: HashMap<String, bool> = HashMap::new();
        for id in self.ids.iter() {
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
        for i in 0..n {
            let el: Rc<RefCell<EVGElement>> = found.get(&format!("{}{}", pfx, self.ids[i as usize])).cloned().unwrap();
            EVGRetain::patch(&el, &self.names[i as usize], &self.vals[i as usize]);
        }
        true
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
