// SPDX-License-Identifier: MIT
//! DomTree -- computed styles and render nodes on the host side, for the
//! subtrees of a page whose CSS DomTree knows (the RX path of webapi.js).
//!
//! webapi.js describes the elements under a node it renders (their
//! children, inline style, the attributes and accessibility the render
//! tree carries) and the declarations of its rule set's rules, expanded
//! to longhands. DomStyle matches; DomTree takes the declarations of the
//! rules that match, computes each element's style as webapi.js's
//! computeStyle does, finds what renderNode would write of it, and builds
//! the render tree's nodes (JsonValue, the type a host's DomPage keeps)
//! with no JSON text in between. An element whose style needs what
//! DomTree does not do (a custom property, calc(), a transition, a
//! ::before box, a table...) is a hole: webapi.js renders it and gives its
//! JSON, which is put in its place.
//!
//! This file has the values (computeValue's part, colours, lengths, JS
//! number text) and the styles as DomTree keeps them (Cs); the matching
//! and the walk are DomStyle's (dom_style.rs).

use rangerdom_json::{JsonParser, JsonValue};
use std::collections::HashMap;
use std::rc::Rc;

/// a computed style: the names it has (DomTree's numbers for them) in the
/// order webapi.js's object would have them, and the value of each
/// (DomTree's numbers for values; -1 undefined, -2 not there)
pub struct Cs {
    pub order: Vec<usize>,
    pub vals: Vec<i64>,
    pub fontPx: f64,
    pub fsKw: bool,
    /// the properties that were currentcolor (computeStyle's _cc)
    pub cc: Vec<usize>,
    /// an inline-level box absolutely positioned (renderNode's "ia")
    pub ia: bool,
    /// the session webapi.js was last given this style in
    pub sent: i64,
}

impl Cs {
    pub fn new() -> Cs {
        Cs { order: Vec::new(), vals: Vec::new(), fontPx: 16.0, fsKw: true, cc: Vec::new(), ia: false, sent: -1 }
    }
    /// the value of name (-1 none)
    pub fn get(&self, n: usize) -> i64 {
        if n < self.vals.len() {
            let v = self.vals[n];
            if v < 0 {
                return -1;
            }
            return v;
        }
        -1
    }
    pub fn has(&self, n: usize) -> bool {
        n < self.vals.len() && self.vals[n] != -2
    }
    /// set name (a new one goes last, one there keeps its place)
    pub fn set(&mut self, n: usize, v: i64) {
        while self.vals.len() <= n {
            self.vals.push(-2);
        }
        if self.vals[n] == -2 {
            self.order.push(n);
        }
        self.vals[n] = v;
    }
    pub fn del(&mut self, n: usize) {
        if n >= self.vals.len() || self.vals[n] == -2 {
            return;
        }
        self.vals[n] = -2;
        let mut i = 0;
        while i < self.order.len() {
            if self.order[i] == n {
                self.order.remove(i);
                break;
            }
            i += 1;
        }
    }
}

/// what lengths are of: font sizes, the viewport
pub struct Ctx {
    pub em: f64,
    pub rem: f64,
    pub vw: f64,
    pub vh: f64,
    /// ch and ex when the face says (Ahem, monospace), else -1
    pub ch: f64,
    pub ex: f64,
    pub pct: f64,
    pub hasPct: bool,
}

impl Ctx {
    pub fn new(em: f64, rem: f64, vw: f64, vh: f64) -> Ctx {
        Ctx { em, rem, vw, vh, ch: -1.0, ex: -1.0, pct: 0.0, hasPct: false }
    }
}

/// The names and values DomTree has numbers for, the tables webapi.js
/// gave (INHERITED, INITIAL, valueKind, the named colours) and the styles.
pub struct DomTree {
    pub names: Vec<String>,
    pub nameId: HashMap<String, usize>,
    pub inherited: Vec<bool>,
    pub initial: Vec<i64>,
    pub kind: Vec<i64>,
    /// INHERITED in webapi.js's order
    pub inhOrder: Vec<usize>,
    pub values: Vec<String>,
    pub valueId: HashMap<String, i64>,
    pub named: HashMap<String, String>,
    pub hasTables: bool,
    /// the styles by number (0 none), and by what they hold
    pub styles: Vec<Rc<Cs>>,
    pub styleId: HashMap<String, usize>,
    /// a value DomTree cannot compute was met (the element is a hole)
    pub bad: bool,
    pub why: String,
    // names it looks at
    pub nDisplay: usize,
    pub nPosition: usize,
    pub nColor: usize,
    pub nFontSize: usize,
    pub nFontFamily: usize,
    pub nFontWeight: usize,
    pub nFloat: usize,
    pub nVisibility: usize,
    pub nTop: usize,
    pub nBottom: usize,
    pub nZ: usize,
    pub nTransform: usize,
    pub nTranslate: usize,
    pub nRotate: usize,
    pub nScale: usize,
    pub nBoxShadow: usize,
    pub nTextTransform: usize,
    pub nFontVariant: usize,
    pub nFontVariantCaps: usize,
    pub nWhiteSpace: usize,
    pub nCounterReset: usize,
    pub nCounterIncrement: usize,
    pub nOverflowX: usize,
    pub nOverflowY: usize,
    pub nWritingMode: usize,
    pub nDirection: usize,
    pub vNone: i64,
    pub vAuto: i64,
    pub vInline: i64,
}

impl DomTree {
    pub fn new() -> DomTree {
        let mut t = DomTree {
            names: Vec::new(),
            nameId: HashMap::new(),
            inherited: Vec::new(),
            initial: Vec::new(),
            kind: Vec::new(),
            inhOrder: Vec::new(),
            values: Vec::new(),
            valueId: HashMap::new(),
            named: HashMap::new(),
            hasTables: false,
            styles: Vec::new(),
            styleId: HashMap::new(),
            bad: false,
            why: String::new(),
            nDisplay: 0,
            nPosition: 0,
            nColor: 0,
            nFontSize: 0,
            nFontFamily: 0,
            nFontWeight: 0,
            nFloat: 0,
            nVisibility: 0,
            nTop: 0,
            nBottom: 0,
            nZ: 0,
            nTransform: 0,
            nTranslate: 0,
            nRotate: 0,
            nScale: 0,
            nBoxShadow: 0,
            nTextTransform: 0,
            nFontVariant: 0,
            nFontVariantCaps: 0,
            nWhiteSpace: 0,
            nCounterReset: 0,
            nCounterIncrement: 0,
            nOverflowX: 0,
            nOverflowY: 0,
            nWritingMode: 0,
            nDirection: 0,
            vNone: 0,
            vAuto: 0,
            vInline: 0,
        };
        t.reset();
        t
    }

    pub fn reset(&mut self) {
        self.names = Vec::new();
        self.nameId = HashMap::new();
        self.inherited = Vec::new();
        self.initial = Vec::new();
        self.kind = Vec::new();
        self.inhOrder = Vec::new();
        self.values = Vec::new();
        self.valueId = HashMap::new();
        self.hasTables = false;
        self.styles = Vec::new();
        self.styles.push(Rc::new(Cs::new()));
        self.styleId = HashMap::new();
        self.nDisplay = self.name("display");
        self.nPosition = self.name("position");
        self.nColor = self.name("color");
        self.nFontSize = self.name("font-size");
        self.nFontFamily = self.name("font-family");
        self.nFontWeight = self.name("font-weight");
        self.nFloat = self.name("float");
        self.nVisibility = self.name("visibility");
        self.nTop = self.name("top");
        self.nBottom = self.name("bottom");
        self.nZ = self.name("z-index");
        self.nTransform = self.name("transform");
        self.nTranslate = self.name("translate");
        self.nRotate = self.name("rotate");
        self.nScale = self.name("scale");
        self.nBoxShadow = self.name("box-shadow");
        self.nTextTransform = self.name("text-transform");
        self.nFontVariant = self.name("font-variant");
        self.nFontVariantCaps = self.name("font-variant-caps");
        self.nWhiteSpace = self.name("white-space");
        self.nCounterReset = self.name("counter-reset");
        self.nCounterIncrement = self.name("counter-increment");
        self.nOverflowX = self.name("overflow-x");
        self.nOverflowY = self.name("overflow-y");
        self.nWritingMode = self.name("writing-mode");
        self.nDirection = self.name("direction");
        self.vNone = self.value("none");
        self.vAuto = self.value("auto");
        self.vInline = self.value("inline");
    }

    /// DomTree's number for a property name
    pub fn name(&mut self, n: &str) -> usize {
        if let Some(&k) = self.nameId.get(n) {
            return k;
        }
        let k = self.names.len();
        self.names.push(n.to_string());
        self.nameId.insert(n.to_string(), k);
        self.inherited.push(false);
        self.initial.push(-1);
        self.kind.push(-1);
        k
    }
    /// DomTree's number for a value
    pub fn value(&mut self, v: &str) -> i64 {
        if let Some(&k) = self.valueId.get(v) {
            return k;
        }
        let k = self.values.len() as i64;
        self.values.push(v.to_string());
        self.valueId.insert(v.to_string(), k);
        k
    }
    pub fn text(&self, v: i64) -> String {
        if v < 0 {
            return String::new();
        }
        self.values[v as usize].clone()
    }
    pub fn style(&self, id: usize) -> Rc<Cs> {
        self.styles[id].clone()
    }

    /// the tables (I): {"inh": [names], "init": {name: value}, "kind":
    /// {name: k}, "named": {name: "r,g,b"}}
    pub fn setTables(&mut self, json: &str) {
        let p = JsonParser::parse(json.to_string());
        let v = p.borrow_mut().value();
        if !p.borrow().ok {
            return;
        }
        let inh = v.borrow().get("inh");
        let n = inh.borrow().count();
        let mut i = 0;
        self.inhOrder = Vec::new();
        while i < n {
            let nm = inh.borrow().item(i).borrow().text();
            let k = self.name(&nm);
            self.inherited[k] = true;
            self.inhOrder.push(k);
            i += 1;
        }
        let init = v.borrow().get("init");
        let keys = init.borrow().keys.clone();
        let mut j = 0;
        while j < keys.len() {
            let k = self.name(&keys[j]);
            let tv = init.borrow().items[j].borrow().text();
            self.initial[k] = self.value(&tv);
            j += 1;
        }
        let kinds = v.borrow().get("kind");
        let kk = kinds.borrow().keys.clone();
        let mut q = 0;
        while q < kk.len() {
            let k = self.name(&kk[q]);
            self.kind[k] = JsonValue::intOf(&kinds.borrow().items[q].clone(), 0);
            q += 1;
        }
        let named = v.borrow().get("named");
        let nk = named.borrow().keys.clone();
        let mut r = 0;
        self.named = HashMap::new();
        while r < nk.len() {
            let tv = named.borrow().items[r].borrow().text();
            self.named.insert(nk[r].clone(), tv);
            r += 1;
        }
        self.hasTables = true;
    }

    /// a style kept by what it holds: the same number for the same style
    pub fn intern(&mut self, c: Cs) -> usize {
        let mut key = String::new();
        for &n in c.order.iter() {
            key.push_str(&n.to_string());
            key.push(':');
            key.push_str(&c.vals[n].to_string());
            key.push(';');
        }
        key.push_str(&js_num(c.fontPx));
        key.push(if c.fsKw { 'k' } else { '-' });
        key.push(if c.ia { 'a' } else { '-' });
        for &n in c.cc.iter() {
            key.push_str(&n.to_string());
            key.push(',');
        }
        if let Some(&k) = self.styleId.get(&key) {
            return k;
        }
        // (a page that made very many: let go of all, from the next walk)
        let k = self.styles.len();
        self.styles.push(Rc::new(c));
        self.styleId.insert(key, k);
        k
    }

    /// a style as webapi.js takes it (rxCs): {"p": {name: value}, "f":
    /// font px, "k": its size from the keywords, "c": [currentcolor names]}
    pub fn styleJson(&self, id: usize) -> String {
        let c = self.styles[id].clone();
        let mut out = String::from("{\"p\":{");
        let mut first = true;
        for &n in c.order.iter() {
            let v = c.vals[n];
            if v < 0 {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&JsonValue::quote(&self.names[n]));
            out.push(':');
            out.push_str(&JsonValue::quote(&self.values[v as usize]));
        }
        out.push_str("},\"f\":");
        out.push_str(&js_num(c.fontPx));
        out.push_str(",\"k\":");
        out.push_str(if c.fsKw { "true" } else { "false" });
        out.push_str(",\"c\":[");
        let mut i = 0;
        while i < c.cc.len() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&JsonValue::quote(&self.names[c.cc[i]]));
            i += 1;
        }
        out.push_str("]}");
        out
    }

    /// webapi.js's style object (P) as one of DomTree's
    pub fn styleFrom(&mut self, json: &str) -> usize {
        let p = JsonParser::parse(json.to_string());
        let v = p.borrow_mut().value();
        if !p.borrow().ok {
            return 0;
        }
        let mut c = Cs::new();
        let props = v.borrow().get("p");
        let keys = props.borrow().keys.clone();
        let mut i = 0;
        while i < keys.len() {
            let n = self.name(&keys[i]);
            let it = props.borrow().items[i].clone();
            if it.borrow().kind == 3 {
                let tv = it.borrow().str.clone();
                let vid = self.value(&tv);
                c.set(n, vid);
            }
            i += 1;
        }
        let f = v.borrow().get("f");
        if f.borrow().kind == 2 {
            c.fontPx = parse_float(&f.borrow().numText);
        }
        c.fsKw = v.borrow().getBool("k", true);
        let cc = v.borrow().get("c");
        let cn = cc.borrow().count();
        let mut j = 0;
        while j < cn {
            let nm = cc.borrow().item(j).borrow().text();
            let k = self.name(&nm);
            c.cc.push(k);
            j += 1;
        }
        self.intern(c)
    }

    fn fail(&mut self, why: &str) {
        if !self.bad {
            self.bad = true;
            self.why = why.to_string();
        }
    }

    // ---- computeStyle (webapi.js computeStyle1), for a spec without
    // custom properties, logical properties, animations or transitions

    /// the computed style of an element from its declarations (names and
    /// value numbers in the cascade's order), under parent (0 none); 0 and
    /// bad when it needs what DomTree does not do
    pub fn compute(&mut self, spec: &Cs, parent: usize, root: bool, rootPx: f64, vw: f64, vh: f64) -> usize {
        let pc = self.styles[parent].clone();
        let hasP = parent != 0;
        let mut out = Cs::new();
        // inherited from the parent first
        if hasP {
            let inh = self.inhOrder.clone();
            for &ip in inh.iter() {
                let pv = pc.get(ip);
                if pv >= 0 {
                    out.set(ip, pv);
                }
            }
        }
        let fontPx = if hasP { pc.fontPx } else { 16.0 };
        // (the root's rem is its own size; its size's rem is 16)
        let rootPx0 = if root { 16.0 } else { rootPx };
        let fsRaw = spec.get(self.nFontSize);
        if spec.has(self.nFontSize) && fsRaw >= 0 {
            let mut fs = self.text(fsRaw);
            if fs == "inherit" {
                fs = if hasP { self.text(pc.get(self.nFontSize)) } else { "16px".to_string() };
            }
            let px = self.fontSizePx(&fs, fontPx, rootPx0, vw, vh);
            if self.bad {
                return 0;
            }
            let t = fmt_px(px);
            let vid = self.value(&t);
            out.set(self.nFontSize, vid);
            out.fontPx = px;
            out.fsKw = is_size_keyword(&fs) && (if hasP { pc.fsKw } else { true });
        } else {
            out.fontPx = fontPx;
            out.fsKw = if hasP { pc.fsKw } else { true };
            let famS = if spec.has(self.nFontFamily) { self.text(spec.get(self.nFontFamily)) } else if hasP { self.text(pc.get(self.nFontFamily)) } else { String::new() };
            let mono = famS.trim() == "monospace";
            let pMono = if hasP { self.text(pc.get(self.nFontFamily)).trim() == "monospace" } else { false };
            if out.fsKw && mono != pMono {
                out.fontPx = if mono { fontPx * 13.0 / 16.0 } else { fontPx * 16.0 / 13.0 };
                let t = fmt_px(out.fontPx);
                let vid = self.value(&t);
                out.set(self.nFontSize, vid);
            }
            if out.get(self.nFontSize) < 0 {
                let t = fmt_px(fontPx);
                let vid = self.value(&t);
                out.set(self.nFontSize, vid);
            }
        }
        let mut ctx = Ctx::new(out.fontPx, if root { out.fontPx } else { rootPx }, vw / 100.0, vh / 100.0);
        let fam0 = (if spec.has(self.nFontFamily) { self.text(spec.get(self.nFontFamily)) } else if hasP { self.text(pc.get(self.nFontFamily)) } else { String::new() }).to_lowercase();
        if fam0.contains("ahem") {
            ctx.ch = ctx.em;
            ctx.ex = ctx.em * 0.8;
        } else if fam0.contains("mono") || fam0.contains("courier") || fam0.contains("consolas") {
            ctx.ch = ctx.em * 0.6021;
        }
        let order = spec.order.clone();
        for &n in order.iter() {
            if n == self.nFontSize {
                continue;
            }
            let vid = spec.get(n);
            if vid < 0 {
                continue;
            }
            let v = self.text(vid);
            let kw = v.to_lowercase();
            if kw == "inherit" {
                let cc = hasP && contains_name(&pc.cc, n);
                if cc {
                    let c = self.value("currentcolor");
                    out.set(n, c);
                } else if hasP && pc.get(n) >= 0 {
                    out.set(n, pc.get(n));
                } else {
                    out.set(n, self.initial[n]);
                }
                continue;
            }
            if kw == "initial" || kw == "revert" || kw == "revert-layer" {
                out.set(n, self.initial[n]);
                continue;
            }
            if kw == "unset" {
                if self.inherited[n] && hasP {
                    out.set(n, pc.get(n));
                } else {
                    out.set(n, self.initial[n]);
                }
                continue;
            }
            let cv = self.computeValue(n, &v, &ctx, &pc, hasP);
            if self.bad {
                return 0;
            }
            let cid = self.value(&cv);
            out.set(n, cid);
        }
        if out.get(self.nDisplay) < 0 {
            out.set(self.nDisplay, self.vInline);
        }
        // (a side with a style and no width has the initial one, medium)
        let sides = ["top", "right", "bottom", "left"];
        for sd in sides.iter() {
            let sn = self.name(&format!("border-{}-style", sd));
            let wn = self.name(&format!("border-{}-width", sd));
            let st = out.get(sn);
            if st >= 0 {
                let s = self.text(st);
                if s != "none" && s != "hidden" && !out.has(wn) {
                    let w = self.value("3px");
                    out.set(wn, w);
                }
            }
        }
        // the two-keyword forms of display as the one-keyword ones
        let d0 = self.text(out.get(self.nDisplay));
        if d0.trim().contains(' ') || d0.trim().contains('\t') {
            let low = d0.trim().to_lowercase();
            let ws: Vec<&str> = low.split_whitespace().collect();
            let mut dIn = false;
            let mut inner = String::new();
            for w in ws.iter() {
                if *w == "inline" {
                    dIn = true;
                } else if *w != "block" && *w != "run-in" && inner.is_empty() {
                    inner = w.to_string();
                }
            }
            if inner.is_empty() {
                inner = "flow".to_string();
            }
            let nd = if inner == "flow" {
                if dIn { "inline".to_string() } else { "block".to_string() }
            } else if inner == "flow-root" {
                if dIn { "inline-block".to_string() } else { "flow-root".to_string() }
            } else if inner == "flex" || inner == "grid" || inner == "grid-lanes" || inner == "table" {
                if dIn { format!("inline-{}", inner) } else { inner.clone() }
            } else if inner == "list-item" {
                "list-item".to_string()
            } else {
                d0.clone()
            };
            let ndv = self.value(&nd);
            out.set(self.nDisplay, ndv);
        }
        // (a translation's percentages need the box: webapi.js's)
        let tf = out.get(self.nTransform);
        if tf >= 0 && self.values[tf as usize].contains('%') {
            self.fail("transform %");
            return 0;
        }
        // currentcolor in colours
        let col = if out.get(self.nColor) >= 0 { self.text(out.get(self.nColor)) } else { "rgb(0, 0, 0)".to_string() };
        let ord = out.order.clone();
        for &n in ord.iter() {
            if n == self.nColor {
                continue;
            }
            let v = out.get(n);
            if v < 0 {
                continue;
            }
            let s = self.values[v as usize].clone();
            if !s.to_lowercase().contains("currentcolor") {
                continue;
            }
            if s.to_lowercase() == "currentcolor" {
                out.cc.push(n);
            }
            let r = replace_ci(&s, "currentcolor", &col);
            let rv = self.value(&r);
            out.set(n, rv);
        }
        let disp = self.text(out.get(self.nDisplay));
        let pos = self.text(out.get(self.nPosition));
        let absol = pos == "absolute" || pos == "fixed";
        out.ia = absol && disp.starts_with("inline");
        if absol && disp.starts_with("inline") {
            let nd = if disp == "inline-flex" { "flex" } else if disp == "inline-grid" { "grid" } else if disp == "inline-grid-lanes" { "grid-lanes" } else { "block" };
            let v = self.value(nd);
            out.set(self.nDisplay, v);
        }
        if hasP {
            let pd = self.text(pc.get(self.nDisplay));
            let d2 = self.text(out.get(self.nDisplay));
            let fg = pd == "flex" || pd == "inline-flex" || pd == "grid" || pd == "inline-grid" || pd == "grid-lanes" || pd == "inline-grid-lanes";
            if fg && d2.starts_with("inline") {
                let nd = if d2 == "inline-flex" { "flex".to_string() } else if d2 == "inline-grid" { "grid".to_string() } else if d2 == "inline-grid-lanes" { "grid-lanes".to_string() } else if d2 == "inline-block" || d2 == "inline" { "block".to_string() } else { d2.clone() };
                let v = self.value(&nd);
                out.set(self.nDisplay, v);
            }
        }
        self.intern(out)
    }

    pub fn fontSizePx(&mut self, v0: &str, parentPx: f64, rootPx: f64, vw: f64, vh: f64) -> f64 {
        let v = v0.trim().to_lowercase();
        if v == "xx-small" {
            return 9.0;
        }
        if v == "x-small" {
            return 10.0;
        }
        if v == "small" {
            return 13.0;
        }
        if v == "medium" {
            return 16.0;
        }
        if v == "large" {
            return 18.0;
        }
        if v == "x-large" {
            return 24.0;
        }
        if v == "xx-large" {
            return 32.0;
        }
        if v == "xxx-large" {
            return 48.0;
        }
        if v == "smaller" {
            return parentPx / 1.2;
        }
        if v == "larger" {
            return parentPx * 1.2;
        }
        let mut ctx = Ctx::new(parentPx, rootPx, vw / 100.0, vh / 100.0);
        ctx.pct = parentPx;
        ctx.hasPct = true;
        let l = self.lengthPx(&v, &ctx);
        if self.bad {
            return 0.0;
        }
        if is_nan(l) {
            return parentPx;
        }
        l
    }

    /// a length in px; NaN for none (auto, a keyword, % without what it is
    /// of); bad for calc() and the like
    pub fn lengthPx(&mut self, v0: &str, ctx: &Ctx) -> f64 {
        let v = v0.trim();
        let low = v.to_lowercase();
        if low.starts_with("calc(") || low.starts_with("min(") || low.starts_with("max(") || low.starts_with("clamp(") {
            self.fail("calc");
            return nan();
        }
        let bs: Vec<u8> = v.as_bytes().to_vec();
        let mut i: usize = 0;
        if i < bs.len() && (bs[i] == 43 || bs[i] == 45) {
            i += 1;
        }
        let ds = i;
        while i < bs.len() && ((bs[i] >= 48 && bs[i] <= 57) || bs[i] == 46) {
            i += 1;
        }
        if i == ds {
            return nan();
        }
        // (an exponent: e, e-)
        if i < bs.len() && (bs[i] == 101 || bs[i] == 69) {
            let mut j = i + 1;
            if j < bs.len() && bs[j] == 45 {
                j += 1;
            }
            let d0 = j;
            while j < bs.len() && bs[j] >= 48 && bs[j] <= 57 {
                j += 1;
            }
            if j > d0 {
                i = j;
            }
        }
        let numPart = &v[0..i];
        let unit = v[i..].to_lowercase();
        let n = parse_float(numPart);
        if unit.is_empty() {
            return if n == 0.0 { 0.0 } else { n };
        }
        if unit == "px" {
            return n;
        }
        if unit == "em" {
            return n * ctx.em;
        }
        if unit == "rem" {
            return n * ctx.rem;
        }
        if unit == "vw" {
            return n * ctx.vw;
        }
        if unit == "vh" {
            return n * ctx.vh;
        }
        if unit == "vmin" {
            return n * (if ctx.vw < ctx.vh { ctx.vw } else { ctx.vh });
        }
        if unit == "vmax" {
            return n * (if ctx.vw > ctx.vh { ctx.vw } else { ctx.vh });
        }
        if unit == "pt" {
            return n * 4.0 / 3.0;
        }
        if unit == "pc" {
            return n * 16.0;
        }
        if unit == "in" {
            return n * 96.0;
        }
        if unit == "cm" {
            return n * 96.0 / 2.54;
        }
        if unit == "mm" {
            return n * 96.0 / 25.4;
        }
        if unit == "q" {
            return n * 96.0 / 101.6;
        }
        if unit == "ch" {
            return n * (if ctx.ch >= 0.0 { ctx.ch } else { ctx.em / 2.0 });
        }
        if unit == "ex" {
            return n * (if ctx.ex >= 0.0 { ctx.ex } else { ctx.em / 2.0 });
        }
        if unit == "%" {
            return if ctx.hasPct { n * ctx.pct / 100.0 } else { nan() };
        }
        nan()
    }

    /// webapi.js computeValue for the values DomTree computes
    pub fn computeValue(&mut self, n: usize, v0: &str, ctx: &Ctx, pc: &Cs, hasP: bool) -> String {
        let v = v0.trim().to_string();
        let low = v.to_lowercase();
        if low.contains("var(") || low.contains("calc(") || low.contains("min(") || low.contains("max(") || low.contains("clamp(") || low.contains("env(") || low.contains("attr(") {
            self.fail("function value");
            return v;
        }
        let name = self.names[n].clone();
        let mut kind = self.kind[n];
        if kind < 0 {
            kind = value_kind(&name);
            self.kind[n] = kind;
        }
        if name == "line-height" {
            if is_plain_number(&v) {
                return if v.starts_with('+') { v[1..].to_string() } else { v };
            }
            if v == "normal" {
                return v;
            }
            let mut c2 = Ctx::new(ctx.em, ctx.rem, ctx.vw, ctx.vh);
            c2.ch = ctx.ch;
            c2.ex = ctx.ex;
            c2.pct = ctx.em;
            c2.hasPct = true;
            let lh = self.lengthPx(&v, &c2);
            return if is_nan(lh) { v } else { fmt_px(lh) };
        }
        if kind & 1 != 0 {
            if v == "thin" {
                return "1px".to_string();
            }
            if v == "medium" {
                return "3px".to_string();
            }
            if v == "thick" {
                return "5px".to_string();
            }
        }
        if name == "background-size" || name == "background-position" {
            return self.unitsToPx(&v, ctx, false);
        }
        if name == "border-spacing" || name == "scrollbar-color" {
            self.fail("border-spacing");
            return v;
        }
        if kind & 2 != 0 {
            if v.contains('%') {
                return v;
            }
            let px = self.lengthPx(&v, ctx);
            if !is_nan(px) {
                return fmt_px(px);
            }
            return v;
        }
        if kind & 4 != 0 {
            if low == "currentcolor" {
                if name == "color" {
                    return if hasP { self.text(pc.get(self.nColor)) } else { "rgb(0, 0, 0)".to_string() };
                }
                return v;
            }
            return self.normalizeColor(&v);
        }
        if name == "font-weight" {
            if v == "normal" {
                return "400".to_string();
            }
            if v == "bold" {
                return "700".to_string();
            }
            if v == "bolder" || v == "lighter" {
                let mut pw = 400.0;
                if hasP {
                    let t = self.text(pc.get(self.nFontWeight));
                    let p = parse_int(&t);
                    if !is_nan(p) && p != 0.0 {
                        pw = p;
                    }
                }
                if v == "bolder" {
                    return js_num(if pw + 300.0 < 900.0 { pw + 300.0 } else { 900.0 });
                }
                return js_num(if pw - 300.0 > 100.0 { pw - 300.0 } else { 100.0 });
            }
            return v;
        }
        if name == "translate" || name == "box-shadow" || name == "transform" || name == "text-shadow" {
            return self.emToPx(&v, ctx);
        }
        v
    }

    /// (n)(rem|em)\b as px, as computeValue's replace for translate,
    /// transform and the shadows
    fn emToPx(&mut self, v: &str, ctx: &Ctx) -> String {
        if !v.contains("em") {
            return v.to_string();
        }
        let bs: Vec<u8> = v.as_bytes().to_vec();
        let mut out = String::new();
        let mut i: usize = 0;
        let mut last: usize = 0;
        while i < bs.len() {
            let c = bs[i];
            let isStart = c == 45 || c == 46 || (c >= 48 && c <= 57);
            if !isStart {
                i += 1;
                continue;
            }
            // a run of -?[\d.]+ (the regex takes the longest at the first place it can)
            let st = i;
            let mut j = i;
            if bs[j] == 45 {
                j += 1;
            }
            let d0 = j;
            while j < bs.len() && ((bs[j] >= 48 && bs[j] <= 57) || bs[j] == 46) {
                j += 1;
            }
            if j == d0 {
                i += 1;
                continue;
            }
            let mut unitLen = 0;
            let mut isRem = false;
            if j + 3 <= bs.len() && &v[j..j + 3] == "rem" {
                unitLen = 3;
                isRem = true;
            } else if j + 2 <= bs.len() && &v[j..j + 2] == "em" {
                unitLen = 2;
            }
            if unitLen == 0 || (j + unitLen < bs.len() && is_word(bs[j + unitLen])) {
                i = j;
                continue;
            }
            let n = parse_float(&v[st..j]);
            out.push_str(&v[last..st]);
            out.push_str(&fmt_px(n * (if isRem { ctx.rem } else { ctx.em })));
            last = j + unitLen;
            i = last;
        }
        out.push_str(&v[last..]);
        out
    }

    /// background-size / -position: each length of rem, em, vw... in px
    fn unitsToPx(&mut self, v: &str, ctx: &Ctx, _x: bool) -> String {
        let low = v.to_lowercase();
        let units = ["rem", "em", "vw", "vh", "vmin", "vmax", "pt", "pc", "in", "cm", "mm", "q"];
        let mut any = false;
        for u in units.iter() {
            if low.contains(u) {
                any = true;
            }
        }
        if !any {
            return v.to_string();
        }
        // (tokens separated by spaces and commas)
        let mut out = String::new();
        let mut cur = String::new();
        for ch in v.chars() {
            if ch == ' ' || ch == ',' || ch == '\t' || ch == '\n' {
                out.push_str(&self.tokenPx(&cur, ctx));
                cur = String::new();
                out.push(ch);
            } else {
                cur.push(ch);
            }
        }
        out.push_str(&self.tokenPx(&cur, ctx));
        out
    }
    fn tokenPx(&mut self, t: &str, ctx: &Ctx) -> String {
        if t.is_empty() {
            return String::new();
        }
        let low = t.to_lowercase();
        let units = ["rem", "em", "vw", "vh", "vmin", "vmax", "pt", "pc", "in", "cm", "mm", "q"];
        for u in units.iter() {
            if low.ends_with(u) {
                let num = &t[0..t.len() - u.len()];
                if is_plain_number(num) || (num.starts_with('-') && is_plain_number(&num[1..])) {
                    let q = self.lengthPx(t, ctx);
                    if !is_nan(q) {
                        return fmt_px(q);
                    }
                }
                return t.to_string();
            }
        }
        t.to_string()
    }

    /// webapi.js normalizeColor (color-mix, oklab, oklch: bad)
    pub fn normalizeColor(&mut self, v: &str) -> String {
        let s = collapse_spaces(v.trim()).replace("( ", "(").replace(" )", ")").replace(" ,", ",");
        let low = s.to_lowercase();
        if low == "transparent" {
            return "rgba(0, 0, 0, 0)".to_string();
        }
        if let Some(rgb) = self.named.get(&low) {
            let p: Vec<&str> = rgb.split(',').collect();
            if p.len() == 3 {
                return rgb_string(parse_float(p[0]), parse_float(p[1]), parse_float(p[2]), 1.0);
            }
        }
        if s.starts_with('#') {
            let h0 = &s[1..];
            let ok = h0.len() >= 3 && h0.len() <= 8 && all_hex(h0);
            if ok {
                let mut h = String::new();
                if h0.len() == 3 || h0.len() == 4 {
                    for ch in h0.chars() {
                        h.push(ch);
                        h.push(ch);
                    }
                } else {
                    h = h0.to_string();
                }
                if h.len() != 6 && h.len() != 8 {
                    return s;
                }
                let r = i64::from_str_radix(&h[0..2], 16).unwrap_or(0) as f64;
                let g = i64::from_str_radix(&h[2..4], 16).unwrap_or(0) as f64;
                let b = i64::from_str_radix(&h[4..6], 16).unwrap_or(0) as f64;
                let a = if h.len() == 8 { i64::from_str_radix(&h[6..8], 16).unwrap_or(0) as f64 / 255.0 } else { 1.0 };
                return rgb_string(r, g, b, a);
            }
        }
        if low.starts_with("rgb") || low.starts_with("hsl") {
            let open = s.find('(');
            if open.is_none() || !s.ends_with(')') {
                return s;
            }
            let o = open.unwrap();
            let fname = low[0..o].to_string();
            if fname != "rgb" && fname != "rgba" && fname != "hsl" && fname != "hsla" {
                return s;
            }
            let body = s[o + 1..s.len() - 1].trim().to_string();
            let mut parts: Vec<String> = Vec::new();
            let mut alpha = String::new();
            let mut hasAlpha = false;
            if body.contains(',') {
                let ps: Vec<&str> = body.split(',').collect();
                let mut i = 0;
                while i < ps.len() {
                    if i < 3 {
                        parts.push(ps[i].to_string());
                    } else if i == 3 {
                        alpha = ps[i].to_string();
                        hasAlpha = true;
                    }
                    i += 1;
                }
            } else {
                let sl: Vec<&str> = body.split('/').collect();
                for p in sl[0].trim().split_whitespace() {
                    parts.push(p.to_string());
                }
                if sl.len() > 1 {
                    alpha = sl[1].to_string();
                    hasAlpha = true;
                }
            }
            if parts.len() < 3 {
                return s;
            }
            let a = if hasAlpha { alpha_of(&alpha) } else { 1.0 };
            if fname.starts_with("rgb") {
                let r = channel(&parts[0], 255.0);
                let g = channel(&parts[1], 255.0);
                let b = channel(&parts[2], 255.0);
                if is_nan(r) || is_nan(g) || is_nan(b) || is_nan(a) {
                    self.fail("colour");
                    return s;
                }
                return rgb_string(r, g, b, a);
            }
            let hh = parse_float(&parts[0]);
            let s1 = channel(&parts[1], 1.0) / (if parts[1].trim().ends_with('%') { 1.0 } else { 100.0 });
            let l1 = channel(&parts[2], 1.0) / (if parts[2].trim().ends_with('%') { 1.0 } else { 100.0 });
            if is_nan(hh) || is_nan(s1) || is_nan(l1) || is_nan(a) {
                self.fail("colour");
                return s;
            }
            let rgb = hsl_to_rgb(hh, s1, l1);
            return rgb_string(rgb[0], rgb[1], rgb[2], a);
        }
        if low.starts_with("color-mix(") || low.starts_with("oklab(") || low.starts_with("oklch(") {
            self.fail("colour function");
            return s;
        }
        s
    }

    /// renderNode's shadowLayers: the outer layers the host draws, rings
    /// and one drop shadow (box-ring, box-drop)
    pub fn shadowLayers(&mut self, bs: &str, color: &str) -> (String, String) {
        let layers = split_comma(bs);
        let mut rings: Vec<String> = Vec::new();
        let mut drop = String::new();
        for layer in layers.iter() {
            let toks = split_value(layer);
            let mut lens: Vec<f64> = Vec::new();
            let mut col = String::new();
            let mut inset = false;
            for t in toks.iter() {
                if t == "inset" {
                    inset = true;
                    continue;
                }
                if t.starts_with("calc(") {
                    self.fail("calc shadow");
                    return (String::new(), String::new());
                }
                if is_px_number(t) {
                    lens.push(parse_float(t));
                    continue;
                }
                col = t.clone();
            }
            if inset || lens.len() < 2 {
                continue;
            }
            let src = if col.is_empty() || col == "currentcolor" { if color.is_empty() { "rgb(0, 0, 0)".to_string() } else { color.to_string() } } else { col.clone() };
            let nc = self.normalizeColor(&src);
            let c = parse_rgba(&nc);
            if c.len() != 4 || !(c[3] > 0.0) {
                continue;
            }
            let rgba = format!("rgba({},{},{},{})", js_num(js_round(c[0])), js_num(js_round(c[1])), js_num(js_round(c[2])), js_num(js_round(c[3] * 1000.0) / 1000.0));
            let dx = lens[0];
            let dy = lens[1];
            let blur = if lens.len() > 2 { lens[2] } else { 0.0 };
            let spread = if lens.len() > 3 { lens[3] } else { 0.0 };
            if dx == 0.0 && dy == 0.0 && blur == 0.0 {
                if spread > 0.0 {
                    rings.push(format!("{} {}", fmt_px(spread), rgba));
                }
            } else if drop.is_empty() {
                drop = format!("{} {} {} {}", fmt_px(dx), fmt_px(dy), fmt_px(blur), rgba);
            }
        }
        (rings.join(", "), drop)
    }
}

// ---- values

fn contains_name(l: &Vec<usize>, n: usize) -> bool {
    for &x in l.iter() {
        if x == n {
            return true;
        }
    }
    false
}

fn is_word(b: u8) -> bool {
    (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 95
}

/// /^\+?[\d.]+$/
fn is_plain_number(v: &str) -> bool {
    let bs = v.as_bytes();
    let mut i = 0;
    if i < bs.len() && bs[i] == 43 {
        i += 1;
    }
    if i >= bs.len() {
        return false;
    }
    while i < bs.len() {
        if !((bs[i] >= 48 && bs[i] <= 57) || bs[i] == 46) {
            return false;
        }
        i += 1;
    }
    true
}

/// /^-?[\d.]+(px)?$/
fn is_px_number(v: &str) -> bool {
    let mut t = v;
    if t.ends_with("px") {
        t = &t[0..t.len() - 2];
    }
    if t.starts_with('-') {
        t = &t[1..];
    }
    if t.is_empty() {
        return false;
    }
    all_num(t)
}

fn is_size_keyword(fs: &str) -> bool {
    let k = fs;
    k == "xx-small" || k == "x-small" || k == "small" || k == "medium" || k == "large" || k == "x-large" || k == "xx-large" || k == "xxx-large" || k == "smaller" || k == "larger" || k == "initial"
}

/// webapi.js valueKind
pub fn value_kind(name: &str) -> i64 {
    let mut k = 0;
    if name.ends_with("-width") && (name.starts_with("border-") || name.starts_with("outline-")) {
        k |= 1;
    }
    let lp = [
        "width", "height", "min-width", "min-height", "max-width", "max-height", "top", "right", "bottom", "left", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius", "row-gap", "column-gap", "flex-basis", "letter-spacing", "word-spacing", "text-indent", "outline-width", "outline-offset", "line-height", "gap",
    ];
    for p in lp.iter() {
        if *p == name {
            k |= 2;
        }
    }
    if name == "color" || name.ends_with("-color") || name == "fill" || name == "stroke" {
        k |= 4;
    }
    k
}

/// JS parseFloat: the number at the start of s (NaN for none)
pub fn parse_float(s0: &str) -> f64 {
    let s = trim_start(s0);
    let bs = s.as_bytes();
    let mut i = 0;
    if i < bs.len() && (bs[i] == 43 || bs[i] == 45) {
        i += 1;
    }
    if s[i..].starts_with("Infinity") {
        return if s.starts_with('-') { -inf() } else { inf() };
    }
    let ds = i;
    while i < bs.len() && bs[i] >= 48 && bs[i] <= 57 {
        i += 1;
    }
    let mut digits = i > ds;
    if i < bs.len() && bs[i] == 46 {
        i += 1;
        let fs = i;
        while i < bs.len() && bs[i] >= 48 && bs[i] <= 57 {
            i += 1;
        }
        if i > fs {
            digits = true;
        }
    }
    if !digits {
        return nan();
    }
    let mut end = i;
    if i < bs.len() && (bs[i] == 101 || bs[i] == 69) {
        let mut j = i + 1;
        if j < bs.len() && (bs[j] == 43 || bs[j] == 45) {
            j += 1;
        }
        let es = j;
        while j < bs.len() && bs[j] >= 48 && bs[j] <= 57 {
            j += 1;
        }
        if j > es {
            end = j;
        }
    }
    let t = &s[0..end];
    let t2 = if t.ends_with('.') { format!("{}0", t) } else { t.to_string() };
    let t3 = if t2.starts_with('.') {
        format!("0{}", t2)
    } else if t2.starts_with("-.") || t2.starts_with("+.") {
        format!("{}0{}", &t2[0..1], &t2[1..])
    } else {
        t2
    };
    let v: Option<f64> = t3.parse::<f64>().ok();
    if v.is_some() {
        v.unwrap()
    } else {
        nan()
    }
}

/// s without the white space at its start (JS trimStart's ASCII part)
fn trim_start(s: &str) -> String {
    let bs = s.as_bytes();
    let mut i = 0;
    while i < bs.len() && (bs[i] == 32 || bs[i] == 9 || bs[i] == 10 || bs[i] == 12 || bs[i] == 13) {
        i += 1;
    }
    s[i..].to_string()
}

/// NaN and infinity, and their tests, made of plain arithmetic (the
/// targets Ranger writes have no f64::NAN or is_nan)
pub fn nan() -> f64 {
    let z: f64 = 0.0;
    z / z
}

pub fn is_nan(x: f64) -> bool {
    x != x
}

pub fn inf() -> f64 {
    let z: f64 = 0.0;
    1.0 / z
}

pub fn is_inf(x: f64) -> bool {
    x == inf() || x == -inf()
}

/// JS parseInt(s, 10)
pub fn parse_int(s0: &str) -> f64 {
    let s = trim_start(s0);
    let bs = s.as_bytes();
    let mut i = 0;
    let neg = i < bs.len() && bs[i] == 45;
    if i < bs.len() && (bs[i] == 43 || bs[i] == 45) {
        i += 1;
    }
    let ds = i;
    let mut n: f64 = 0.0;
    while i < bs.len() && bs[i] >= 48 && bs[i] <= 57 {
        n = n * 10.0 + (bs[i] - 48) as f64;
        i += 1;
    }
    if i == ds {
        return nan();
    }
    if neg {
        -n
    } else {
        n
    }
}

/// JS Math.round
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// JS String(number)
pub fn js_num(x: f64) -> String {
    if is_nan(x) {
        return "NaN".to_string();
    }
    if is_inf(x) {
        return if x > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let a = x.abs();
    if a >= 1e21 || a < 1e-6 {
        // (exponent form: d[.ddd]e+n)
        let s = format!("{:e}", x);
        let parts: Vec<&str> = s.split('e').collect();
        let exp = parts[1];
        let e2 = if exp.starts_with('-') { exp.to_string() } else { format!("+{}", exp) };
        return format!("{}e{}", parts[0], e2);
    }
    format!("{}", x)
}

/// webapi.js fmtPx
pub fn fmt_px(n: f64) -> String {
    format!("{}px", js_num(js_round(n * 1000.0) / 1000.0))
}

fn clamp255(n: f64) -> f64 {
    let r = js_round(n);
    if r < 0.0 {
        0.0
    } else if r > 255.0 {
        255.0
    } else {
        r
    }
}

fn rgb_string(r: f64, g: f64, b: f64, a: f64) -> String {
    if a >= 1.0 {
        return format!("rgb({}, {}, {})", js_num(clamp255(r)), js_num(clamp255(g)), js_num(clamp255(b)));
    }
    let am = if a < 0.0 { 0.0 } else { a };
    format!("rgba({}, {}, {}, {})", js_num(clamp255(r)), js_num(clamp255(g)), js_num(clamp255(b)), js_num(js_round(am * 1000.0) / 1000.0))
}

fn channel(t0: &str, scale: f64) -> f64 {
    let t = t0.trim();
    if t == "none" {
        return 0.0;
    }
    if t.ends_with('%') {
        return parse_float(t) / 100.0 * scale;
    }
    parse_float(t)
}

fn alpha_of(t0: &str) -> f64 {
    let t = t0.trim();
    if t == "none" {
        return 0.0;
    }
    if t.ends_with('%') {
        return parse_float(t) / 100.0;
    }
    parse_float(t)
}

fn hue(p: f64, q: f64, t0: f64) -> f64 {
    let mut t = t0;
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 1.0 / 2.0 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    p
}

fn hsl_to_rgb(h0: f64, s0: f64, l0: f64) -> Vec<f64> {
    let h = ((h0 % 360.0) + 360.0) % 360.0 / 360.0;
    let s = if s0 < 0.0 { 0.0 } else if s0 > 1.0 { 1.0 } else { s0 };
    let l = if l0 < 0.0 { 0.0 } else if l0 > 1.0 { 1.0 } else { l0 };
    if s == 0.0 {
        let g = l * 255.0;
        return vec![g, g, g];
    }
    let q2 = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p2 = 2.0 * l - q2;
    vec![hue(p2, q2, h + 1.0 / 3.0) * 255.0, hue(p2, q2, h) * 255.0, hue(p2, q2, h - 1.0 / 3.0) * 255.0]
}

/// webapi.js parseRGBA of a normalised colour: [r, g, b, a] or empty
fn parse_rgba(s: &str) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    let o = s.find('(');
    if o.is_none() || !s.ends_with(')') || !(s.starts_with("rgb(") || s.starts_with("rgba(")) {
        return out;
    }
    let body = &s[o.unwrap() + 1..s.len() - 1];
    for p in body.split(',') {
        let t = p.trim();
        if t.is_empty() || !all_num(t) {
            return Vec::new();
        }
        out.push(parse_float(t));
    }
    if out.len() == 3 {
        out.push(1.0);
    }
    if out.len() != 4 {
        return Vec::new();
    }
    out
}

fn collapse_spaces(v: &str) -> String {
    let mut out = String::new();
    let mut sp = false;
    for ch in v.chars() {
        if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\u{c}' {
            sp = true;
            continue;
        }
        if sp {
            out.push(' ');
            sp = false;
        }
        out.push(ch);
    }
    out
}

/// s with every `what` (any ASCII case) as `with`
fn replace_ci(s: &str, what: &str, with: &str) -> String {
    let low = s.to_lowercase();
    if low.len() != s.len() {
        return s.replace(what, with);
    }
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        if low[i..].starts_with(what) {
            out.push_str(with);
            i += what.len();
        } else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// webapi.js splitValue: at white space outside parentheses
pub fn split_value(v: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut depth = 0;
    let mut cur = String::new();
    for ch in v.chars() {
        if ch == '(' {
            depth += 1;
        }
        if ch == ')' {
            depth -= 1;
        }
        if depth == 0 && (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\u{c}') {
            if !cur.is_empty() {
                out.push(cur);
            }
            cur = String::new();
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// webapi.js splitComma: at commas outside parentheses, each trimmed
pub fn split_comma(v: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut depth = 0;
    let mut cur = String::new();
    for ch in v.chars() {
        if ch == '(' {
            depth += 1;
        }
        if ch == ')' {
            depth -= 1;
        }
        if depth == 0 && ch == ',' {
            out.push(cur.trim().to_string());
            cur = String::new();
        } else {
            cur.push(ch);
        }
    }
    out.push(cur.trim().to_string());
    out
}

fn all_hex(s: &str) -> bool {
    let bs = s.as_bytes();
    let mut i = 0;
    while i < bs.len() {
        let b = bs[i];
        if !((b >= 48 && b <= 57) || (b >= 97 && b <= 102) || (b >= 65 && b <= 70)) {
            return false;
        }
        i += 1;
    }
    true
}

/// only digits and dots
fn all_num(s: &str) -> bool {
    let bs = s.as_bytes();
    let mut i = 0;
    while i < bs.len() {
        let b = bs[i];
        if !((b >= 48 && b <= 57) || b == 46) {
            return false;
        }
        i += 1;
    }
    true
}
