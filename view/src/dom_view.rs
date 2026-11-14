// SPDX-License-Identifier: AGPL-3.0-or-later
//!
//! DomView -- a dashboard's page in the window. The page runs on web/dom
//! (RangerDOM js/webapi.js) in bin/mfiles-uix, which renders it as a tree of
//! elements with their computed style (uixhost "page", __render()):
//!
//!   {"i": node id, "t": tag, "s": {css property: computed value},
//!    "a": {attribute: value}, "c": [children], "svg": markup}
//!   {"i": node id, "x": text}
//!
//! Only the properties that differ from the initial value are in "s", and
//! an inherited one only where it differs from the parent's, so the
//! inherited ones are carried down here. This builds EVG elements from it:
//! block boxes as columns, flex and grid boxes as themselves. A line of
//! text and inline elements is a wrapping row: a run in one style is one
//! text element, a run whose spans differ (colour, face, size) is a word
//! per element with the space as the row's gap, and an inline box
//! (inline-block, an image, an SVG picture) sits on the baseline as an item
//! of the row. Faces are picked by family and weight (faceOf: Open Sans as
//! Arial, Figtree), `line-height: normal` is Chromium's from the face's
//! metrics, and list items get their marker. Every element gets the id
//! mfd-xd-<dashboard>-<node>, which is how a click finds its node and how
//! the window tells the page where its boxes are (boxes).
//!
//! The focused text field's caret and selection are drawn after layout
//! (decorate), where the text's lines are known: a 1px caret at the measured
//! place of the text before it, bands under the selected text.
//!
//! A canvas that keeps pixels (webapi.js pixel mode) comes as an "img" with
//! its bitmap in "png" (a data: URL): the element's src is the picture's
//! name (pngPart), and the window decodes it once (M-Files: MfdApp.domPictures).
//!
//! Not drawn: borders that differ by side, box shadows, other images that
//! are not SVG; an SVG gradient is drawn as the average of its stops (Ranger's
//! SvgParser has no gradients). A relatively positioned element's offset is
//! drawn as a translation.

use ranger::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::rgr::{EVGBox, EVGCodepoint, EVGColor, EVGCssExtra, EVGElement, EVGLayout, EVGLayoutFull, EVGTextEngine, EVGTextLine, EVGTextMetrics, EVGUnit, Matrix2D, PathBounds, SvgDocument, SvgParser, VectorViewBox};
use rangerdom_json::JsonValue;
use rangerdom_json::DomText;

/// a piece of a run of text: what it says, the inherited style it is drawn
/// with, and the id of the node a click on it goes to
#[derive(Clone)]
pub struct DomSeg {
    pub text: String,
    pub inh: Rc<RefCell<JsonValue>>,
    pub id: String,
}

impl DomSeg {
    pub fn new() -> Self {
        Self {
            text: String::new(),
            inh: JsonValue::mkObj(),
            id: String::new(),
        }
    }
}

/// the canvas bitmaps of a page (their PNG data: URLs)
#[derive(Clone)]
pub struct DomPngs {
    pub urls: Vec<String>,
}

impl DomPngs {
    pub fn new() -> Self {
        Self {
            urls: Vec::new(),
        }
    }
}

/// the boxes of the page's nodes, in the order they were found
/// an affine map of the plane, (x, y) to (a x + b y + c, d x + e y + f): a
/// frame's coordinates to its parent's (DomView.collectIn)
#[derive(Clone)]
pub struct DomFrame {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl DomFrame {
    pub fn new() -> Self {
        Self {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
            e: 1.0,
            f: 0.0,
        }
    }
    pub fn shift(dx: f64, dy: f64) -> Rc<RefCell<DomFrame>> {
        let m: Rc<RefCell<DomFrame>> = Rc::new(RefCell::new(DomFrame::new()));
        m.borrow_mut().c = dx;
        m.borrow_mut().f = dy;
        m
    }
    pub fn mapX(&self, x: f64, y: f64) -> f64 {
        (self.a * x + self.b * y) + self.c
    }
    pub fn mapY(&self, x: f64, y: f64) -> f64 {
        (self.d * x + self.e * y) + self.f
    }
    /// this after g: a point mapped by g, then by this
    pub fn then(&self, g: &Rc<RefCell<DomFrame>>) -> Rc<RefCell<DomFrame>> {
        let m: Rc<RefCell<DomFrame>> = Rc::new(RefCell::new(DomFrame::new()));
        m.borrow_mut().a = self.a * g.borrow().a + self.b * g.borrow().d;
        m.borrow_mut().b = self.a * g.borrow().b + self.b * g.borrow().e;
        m.borrow_mut().c = (self.a * g.borrow().c + self.b * g.borrow().f) + self.c;
        m.borrow_mut().d = self.d * g.borrow().a + self.e * g.borrow().d;
        m.borrow_mut().e = self.d * g.borrow().b + self.e * g.borrow().e;
        m.borrow_mut().f = (self.d * g.borrow().c + self.e * g.borrow().f) + self.f;
        m
    }
}

#[derive(Clone)]
pub struct DomBoxes {
    pub ids: Vec<String>,
    pub at: HashMap<String,i64>,
    pub x0: Vec<f64>,
    pub y0: Vec<f64>,
    pub x1: Vec<f64>,
    pub y1: Vec<f64>,
    /// a scroll container's ",clientWidth,clientHeight,scrollWidth,scrollHeight"
    pub scroll: HashMap<String,String>,
}

impl DomBoxes {
    pub fn new() -> Self {
        Self {
            ids: Vec::new(),
            at: HashMap::new(),
            x0: Vec::new(),
            y0: Vec::new(),
            x1: Vec::new(),
            y1: Vec::new(),
            scroll: HashMap::new(),
        }
    }
    pub fn add(&mut self, id: &str, ax: f64, ay: f64, bx: f64, by: f64) {
        if self.at.contains_key(id) {
            let k: i64 = self.at.get(id).cloned().unwrap();
            if ax < self.x0[k as usize] {
                self.x0[k as usize] = ax;
            }
            if ay < self.y0[k as usize] {
                self.y0[k as usize] = ay;
            }
            if bx > self.x1[k as usize] {
                self.x1[k as usize] = bx;
            }
            if by > self.y1[k as usize] {
                self.y1[k as usize] = by;
            }
            return;
        }
        self.at.insert(id.to_string(), self.ids.len() as i64);
        self.ids.push(id.to_string());
        self.x0.push(ax);
        self.y0.push(ay);
        self.x1.push(bx);
        self.y1.push(by);
    }
}

/// the elements built in the last frame from a page's nodes, by the node's
/// stamp (JsonValue.stamp): a patched page shares the nodes a change left
/// alone with the last one, and such a node built in the same surroundings
/// (key: DomView.memoKey) is the same element, so it is taken as it was
/// instead of built again (DomView.children). An element is taken at
/// most once a frame; what a frame did not take is dropped (frame).
pub struct DomMemo {
    /// off: nothing is kept (a page built once, as the layout tests do)
    pub on: bool,
    pub next: i64,
    curKeys: HashMap<String,String>,
    curEls: HashMap<String,Rc<RefCell<EVGElement>>>,
    curLate: HashMap<String,i64>,
    prevKeys: HashMap<String,String>,
    prevEls: HashMap<String,Rc<RefCell<EVGElement>>>,
    prevLate: HashMap<String,i64>,
    /// the margins each element had as built: the parent's margin
    /// collapsing sets its children's, so a kept element gets them back
    curMt: HashMap<String,Rc<RefCell<EVGUnit>>>,
    curMb: HashMap<String,Rc<RefCell<EVGUnit>>>,
    curAuto: HashMap<String,String>,
    prevMt: HashMap<String,Rc<RefCell<EVGUnit>>>,
    prevMb: HashMap<String,Rc<RefCell<EVGUnit>>>,
    prevAuto: HashMap<String,String>,
    /// the elements taken this frame, and each element's margins as the
    /// frame left them (marginSig): a kept element keeps its layout
    /// (EVGElement.keepLayout) only when they are what they were when it
    /// was laid out last
    taken: Vec<String>,
    curSig: HashMap<String,String>,
    prevSig: HashMap<String,String>,
    /// off: kept elements are laid out again (the layout is not kept)
    pub keepLayout: bool,
    pub hits: i64,
    pub misses: i64,
}

impl DomMemo {
    pub fn new() -> Self {
        Self {
            on: false,
            next: 0,
            curKeys: HashMap::new(),
            curEls: HashMap::new(),
            curLate: HashMap::new(),
            prevKeys: HashMap::new(),
            prevEls: HashMap::new(),
            prevLate: HashMap::new(),
            curMt: HashMap::new(),
            curMb: HashMap::new(),
            curAuto: HashMap::new(),
            prevMt: HashMap::new(),
            prevMb: HashMap::new(),
            prevAuto: HashMap::new(),
            taken: Vec::new(),
            curSig: HashMap::new(),
            prevSig: HashMap::new(),
            keepLayout: true,
            hits: 0,
            misses: 0,
        }
    }
    pub fn frame(&mut self) {
        self.prevKeys = self.curKeys.clone();
        self.prevEls = self.curEls.clone();
        self.prevLate = self.curLate.clone();
        let k: HashMap<String,String> = HashMap::new();
        self.curKeys = k.clone();
        let e: HashMap<String,Rc<RefCell<EVGElement>>> = HashMap::new();
        self.curEls = e.clone();
        let l: HashMap<String,i64> = HashMap::new();
        self.curLate = l.clone();
        self.prevMt = self.curMt.clone();
        self.prevMb = self.curMb.clone();
        self.prevAuto = self.curAuto.clone();
        let u: HashMap<String,Rc<RefCell<EVGUnit>>> = HashMap::new();
        self.curMt = u.clone();
        self.curMb = u.clone();
        let a: HashMap<String,String> = HashMap::new();
        self.curAuto = a.clone();
        self.prevSig = self.curSig.clone();
        self.curSig = a.clone();
        self.taken = Vec::new();
    }
    pub(crate) fn unitSig(u: Option<Rc<RefCell<EVGUnit>>>) -> String {
        if u.is_none() {
            return "-;".to_string();
        }
        let uu: Rc<RefCell<EVGUnit>> = u.unwrap();
        let set: String = if uu.borrow().is_set { "1".to_string() } else { "0".to_string() };
        format!("{}:{}:{};", uu.borrow().value, uu.borrow().unit_type, set)
    }
    /// an element's margins: what its parent decides about them
    pub(crate) fn marginSig(el: &Rc<RefCell<EVGElement>>) -> String {
        let bx: Rc<RefCell<EVGBox>> = el.borrow().r#box.clone().unwrap();
        let mut out: String = DomMemo::unitSig(bx.borrow().margin_top.clone());
        out = format!("{}{}", out, DomMemo::unitSig(bx.borrow().margin_bottom.clone()));
        out = format!("{}{}", out, DomMemo::unitSig(bx.borrow().margin_left.clone()));
        out = format!("{}{}", out, DomMemo::unitSig(bx.borrow().margin_right.clone()));
        let at: String = if el.borrow().margin_auto_top { "1".to_string() } else { "0".to_string() };
        let ab: String = if el.borrow().margin_auto_bottom { "1".to_string() } else { "0".to_string() };
        format!("{}{}{}", out, at, ab)
    }
    /// the frame built: each element taken keeps its layout when its
    /// margins are what they were last frame, and every element kept
    /// notes its margins for the next
    pub(crate) fn settle(&mut self) {
        let ks: Vec<String> = self.curEls.keys().cloned().collect::<Vec<String>>();
        for sk in ks.iter().cloned() {
            let el: Rc<RefCell<EVGElement>> = self.curEls.get(&sk).cloned().unwrap();
            let sig: String = DomMemo::marginSig(&el);
            self.curSig.insert(sk.clone(), sig.clone());
        }
        let tk: Vec<String> = self.taken.clone();
        for sk in tk.iter().cloned() {
            let el: Rc<RefCell<EVGElement>> = self.curEls.get(&sk).cloned().unwrap();
            let mut same: bool = false;
            if self.keepLayout && self.prevSig.contains_key(&sk) && self.curSig.contains_key(&sk) {
                same = self.prevSig.get(&sk).cloned().unwrap() == self.curSig.get(&sk).cloned().unwrap();
            }
            // (an absolute or fixed box is placed by its own layout, which a
            // kept layout skips)
            if el.borrow().is_absolute || el.borrow().position == "fixed" {
                same = false;
            }
            let had: bool = el.borrow().has_layout;
            el.borrow_mut().keep_layout = same;
            el.borrow_mut().layout_clean = same && had;
        }
    }
    /// the element built last frame for this stamp and key, or none (also
    /// when this frame took it already)
    pub(crate) fn take(&mut self, stamp: i64, key: &str) -> Option<Rc<RefCell<EVGElement>>> {
        let none: Option<Rc<RefCell<EVGElement>>> = None;
        let sk: String = stamp.to_string();
        if stamp <= 0 || !self.prevKeys.contains_key(&sk) || self.curKeys.contains_key(&sk) {
            return none;
        }
        let was: String = self.prevKeys.get(&sk).cloned().unwrap();
        if was != key {
            return none;
        }
        let el: Rc<RefCell<EVGElement>> = self.prevEls.get(&sk).cloned().unwrap();
        let late: i64 = self.prevLate.get(&sk).cloned().unwrap();
        self.curKeys.insert(sk.clone(), key.to_string());
        self.curEls.insert(sk.clone(), Rc::clone(&el));
        self.curLate.insert(sk.clone(), late);
        if self.prevMt.contains_key(&sk) && self.prevMb.contains_key(&sk) && self.prevAuto.contains_key(&sk) {
            let mt: Rc<RefCell<EVGUnit>> = self.prevMt.get(&sk).cloned().unwrap();
            let mb: Rc<RefCell<EVGUnit>> = self.prevMb.get(&sk).cloned().unwrap();
            let au: String = self.prevAuto.get(&sk).cloned().unwrap();
            let bx: Rc<RefCell<EVGBox>> = el.borrow().r#box.clone().unwrap();
            bx.borrow_mut().margin_top = Some(Rc::clone(&mt));
            bx.borrow_mut().margin_bottom = Some(Rc::clone(&mb));
            el.borrow_mut().margin_auto_top = au.starts_with("1");
            el.borrow_mut().margin_auto_bottom = au.ends_with("1");
            self.curMt.insert(sk.clone(), mt);
            self.curMb.insert(sk.clone(), mb);
            self.curAuto.insert(sk.clone(), au);
        }
        self.taken.push(sk.clone());
        Some(el)
    }
    /// the paint-late boxes the element's build counted
    pub fn lateOf(&self, stamp: i64) -> i64 {
        let sk: String = stamp.to_string();
        if self.curLate.contains_key(&sk) {
            return self.curLate.get(&sk).cloned().unwrap();
        }
        0
    }
    pub(crate) fn keep(&mut self, stamp: i64, key: &str, el: &Rc<RefCell<EVGElement>>, late: i64) {
        let sk: String = stamp.to_string();
        self.curKeys.insert(sk.clone(), key.to_string());
        self.curEls.insert(sk.clone(), Rc::clone(el));
        self.curLate.insert(sk.clone(), late);
        let bx: Rc<RefCell<EVGBox>> = el.borrow().r#box.clone().unwrap();
        let mt: Option<Rc<RefCell<EVGUnit>>> = bx.borrow().margin_top.clone();
        let mb: Option<Rc<RefCell<EVGUnit>>> = bx.borrow().margin_bottom.clone();
        if mt.is_some() && mb.is_some() {
            self.curMt.insert(sk.clone(), mt.unwrap());
            self.curMb.insert(sk.clone(), mb.unwrap());
            let at: String = if el.borrow().margin_auto_top { "1".to_string() } else { "0".to_string() };
            let ab: String = if el.borrow().margin_auto_bottom { "1".to_string() } else { "0".to_string() };
            self.curAuto.insert(sk.clone(), format!("{}{}", at, ab));
        }
    }
}

/// the parsed SVG markup of the pages drawn in the last two frames, by its
/// text: the tree is built again every frame, so the parse EVG keeps on an
/// element (EVGElement.svgDoc) was lost with it, and a large picture that
/// did not change (React Flow's dotted background, ~2000 tiles in full
/// screen) was parsed again for every frame
pub struct DomSvgDocs {
    cur: HashMap<String,Rc<RefCell<SvgDocument>>>,
    prev: HashMap<String,Rc<RefCell<SvgDocument>>>,
    /// this frame's <scene3d> boxes the page draws on the GPU: the
    /// elements' ids and their nodes ("s3d", "s3w", "s3h", "s3t")
    pub sceneIds: Vec<String>,
    pub scenes: Vec<Rc<RefCell<JsonValue>>>,
    /// the elements the last frame built (DomMemo), with the parsed SVG
    pub memo: Rc<RefCell<DomMemo>>,
    /// the page's objects a build changed and what they held before
    /// (DomView.putPage), put back when the build ends (undo)
    undoObjs: Vec<Rc<RefCell<JsonValue>>>,
    undoWas: Vec<Rc<RefCell<JsonValue>>>,
}

impl DomSvgDocs {
    pub fn new() -> Self {
        Self {
            cur: HashMap::new(),
            prev: HashMap::new(),
            sceneIds: Vec::new(),
            scenes: Vec::new(),
            memo: Rc::new(RefCell::new(DomMemo::new())),
            undoObjs: Vec::new(),
            undoWas: Vec::new(),
        }
    }
    /// the page as it was before the build: a patched page shares its
    /// unchanged nodes with the next frame, which must read what web/dom
    /// wrote, not what a build made of it
    pub(crate) fn undo(&mut self) {
        let mut i: i64 = (self.undoObjs.len() as i64) - 1;
        while i >= 0 {
            let was: Rc<RefCell<JsonValue>> = self.undoWas[i as usize].clone();
            let ks: Vec<String> = was.borrow().keys.clone();
            let vs: Vec<Rc<RefCell<JsonValue>>> = was.borrow().items.clone();
            let o: Rc<RefCell<JsonValue>> = self.undoObjs[i as usize].clone();
            o.borrow_mut().keys = ks;
            o.borrow_mut().items = vs;
            i -= 1;
        }
        self.undoObjs = Vec::new();
        self.undoWas = Vec::new();
    }
    /// a new frame: what the last one did not use is dropped
    pub fn frame(&mut self) {
        Rc::clone(&self.memo).borrow_mut().frame();
        self.sceneIds = Vec::new();
        self.scenes = Vec::new();
        self.prev = self.cur.clone();
        let none: HashMap<String,Rc<RefCell<SvgDocument>>> = HashMap::new();
        self.cur = none.clone();
    }
    pub(crate) fn docOf(&mut self, src: &str) -> Rc<RefCell<SvgDocument>> {
        let d: Option<Rc<RefCell<SvgDocument>>> = self.cur.get(src).cloned();
        if d.is_some() {
            return d.clone().unwrap();
        }
        let p: Option<Rc<RefCell<SvgDocument>>> = self.prev.get(src).cloned();
        if p.is_some() {
            self.cur.insert(src.to_string(), p.clone().unwrap());
            return p.clone().unwrap();
        }
        let sp: Rc<RefCell<SvgParser>> = Rc::new(RefCell::new(SvgParser::new()));
        let doc: Rc<RefCell<SvgDocument>> = SvgParser::parse(&sp, src.to_string());
        self.cur.insert(src.to_string(), Rc::clone(&doc));
        doc
    }
    /// true when the markup draws: no parse error, and at least one shape
    pub fn drawable(&mut self, src: &str) -> bool {
        let doc: Rc<RefCell<SvgDocument>> = self.docOf(src);
        return !SvgDocument::has_errors(&doc) && SvgDocument::item_count(&doc) > 0;
    }
    pub fn errorOf(&mut self, src: &str) -> String {
        let doc: Rc<RefCell<SvgDocument>> = self.docOf(src);
        return SvgDocument::error_summary(&doc);
    }
}

pub struct DomView {
    /// the SVG markup parsed in earlier frames
    pub svgs: Rc<RefCell<DomSvgDocs>>,
    /// the pieces of the run of text being collected (children)
    pub segs: Vec<Rc<RefCell<DomSeg>>>,
    /// the font size of the box style() is writing, for em in track lists
    pub emPx: f64,
    /// transformed boxes around the one being built
    pub inTransform: i64,
    /// what is on the lines of the block being built (children, flatten)
    pub fNodes: Vec<Rc<RefCell<JsonValue>>>,
    pub fInh: Vec<Rc<RefCell<JsonValue>>>,
    pub fIds: Vec<String>,
    /// the number of the list item being built
    pub listNo: i64,
    pub index: i64,
    pub pfx: String,
    /// the element being built is a flex or grid item
    pub inFlex: bool,
    /// building an empty absolute box of another writing mode in its
    /// parent's frame (orthogonal)
    pub unturned: bool,
    /// the page's viewport, and how many positioned elements are around the
    /// one being built: with none, an absolute box's containing block is the
    /// viewport, not its parent
    pub vw: f64,
    pub vh: f64,
    pub positioned: i64,
    /// boxes that clip (overflow) since the containing block of an absolute
    /// box / of a fixed one: the clips such a box is out of
    pub clipSinceCb: i64,
    pub clipSinceFx: i64,
    /// boxes marked paint-late so far
    pub lateCount: i64,
    /// the computed styles of the positioned boxes around the one being built
    /// (the last is the containing block of an absolute box)
    pub cbStyles: Vec<Rc<RefCell<JsonValue>>>,
    /// the computed style of the element whose child is being built
    pub outerS: Rc<RefCell<JsonValue>>,
    /// the writing mode of what is being built: "" (horizontal-tb),
    /// "vertical-lr" or "vertical-rl". A box in another one than its parent's
    /// is laid out on its own in its own frame, where its inline axis is x
    /// (DomView.logical), and placed in the parent as a box of the size it
    /// came out (orthogonal)
    pub wm: String,
    /// the table being built: its columns' shares of its width (tableCols),
    /// and the column the next cell of the row being built starts at
    pub colW: Vec<f64>,
    /// vertical items of a horizontal grid aligned by justify-self:
    /// baseline (orthogonal), the grid lines them up (gridJustifyBaselines)
    jbItems: Vec<Rc<RefCell<EVGElement>>>,
    pub jbStart: Vec<bool>,
    pub jbDist: Vec<f64>,
    pub jbCol: Vec<String>,
    pub jbMargin: Vec<f64>,
    /// (false for an item in the grid's own mode, whose baseline is made up)
    pub jbReal: Vec<bool>,
    pub cellAt: i64,
    /// a table is a grid of its cells (tableGrid): the next element built
    /// is a row's or row group's band, without its cells (bandOnly), and the
    /// grid lines of each item children() builds (fRow, fCol)
    pub bandOnly: bool,
    pub fRow: Vec<String>,
    pub fCol: Vec<String>,
    /// the definite content height of the element whose children are being
    /// built, -1 when it has none (DomView.definiteH)
    pub defH: f64,
    /// a page without a doctype: auto-height blocks let percentage heights
    /// through to the box above them (the quirks mode percentage quirk)
    pub quirks: bool,
    /// whether that element's height may be definite when defH is -1
    pub defHMaybe: bool,
    /// the nearest scroll container's scrollport (padding box) size, -1
    /// when not known in px: a sticky box's percentage insets are of it
    pub spW: f64,
    pub spH: f64,
    /// the direction the element style() styles inherits
    pub dirNow: String,
    /// what the element being built did that a kept element would not do
    /// again (a grid's baseline items, a <scene3d>, another writing mode):
    /// counted, and an element whose build counted any is not kept
    pub memoBad: i64,
}

impl DomView {
    pub fn new() -> Self {
        Self {
            svgs: Rc::new(RefCell::new(DomSvgDocs::new())),
            segs: Vec::new(),
            emPx: 16.0,
            inTransform: 0,
            fNodes: Vec::new(),
            fInh: Vec::new(),
            fIds: Vec::new(),
            listNo: 0,
            index: 0,
            pfx: String::new(),
            inFlex: false,
            unturned: false,
            vw: 0.0,
            vh: 0.0,
            positioned: 0,
            clipSinceCb: 0,
            clipSinceFx: 0,
            lateCount: 0,
            cbStyles: Vec::new(),
            outerS: JsonValue::mkObj(),
            wm: String::new(),
            colW: Vec::new(),
            jbItems: Vec::new(),
            jbStart: Vec::new(),
            jbDist: Vec::new(),
            jbCol: Vec::new(),
            jbMargin: Vec::new(),
            jbReal: Vec::new(),
            cellAt: 0,
            bandOnly: false,
            fRow: Vec::new(),
            fCol: Vec::new(),
            defH: -1.0,
            quirks: false,
            defHMaybe: false,
            spW: -1.0,
            spH: -1.0,
            dirNow: String::new(),
            memoBad: 0,
        }
    }
    pub fn has(s: &str, prefix: &str) -> bool {
        let k: i64 = prefix.as_bytes().len() as i64;
        if (s.as_bytes().len() as i64) < k {
            return false;
        }
        s[(0) as usize..(k) as usize].to_string() == prefix
    }
    /// the page's body as one element of size w x h
    /// the picture name of a canvas bitmap: from its PNG, so a changed
    /// bitmap is a new picture
    pub fn pngPart(url: &str) -> String {
        // over the bytes once: `url.as_bytes()[i]` in the loop copied the
        // whole text for each byte in the Rust build (a 460 kB SVG: 5.4 s)
        let mut h: i64 = 5381;
        let mut n: i64 = 0;
        for b in url.bytes() {
            h = (h * 33 + (b as i64)) % 2147483647;
            n += 1;
        }
        format!("dompng-{}-{}", n, h)
    }
    /// the data: URL picture of a background-image (its first url()), else
    /// empty
    pub fn bgUrl(v: &str) -> String {
        let at: i64 = DomText::index_of(&v, "url(");
        if at < 0 {
            return String::new();
        }
        let rest: String = v[(at + 4) as usize..(v.as_bytes().len() as i64) as usize].to_string();
        let end: i64 = DomText::index_of(&rest, ")");
        if end < 0 {
            return String::new();
        }
        let mut u: String = rest[(0) as usize..(end) as usize].to_string().trim().to_string();
        if u.starts_with("\"") || u.starts_with("'") {
            u = u[(1) as usize..((u.as_bytes().len() as i64) - 1) as usize].to_string();
        }
        if DomView::pictureUrl(&u) {
            return u;
        }
        String::new()
    }
    /// the body's background moved to the root (html) when the root has
    /// none
    pub fn rootBackground(&self, n: &Rc<RefCell<JsonValue>>, hs: &Rc<RefCell<JsonValue>>) {
        let hc: String = hs.borrow().getText("background-color");
        let hi: String = hs.borrow().getText("background-image");
        if (!hc.is_empty() && (hc != "transparent" && hc != "rgba(0, 0, 0, 0)")) || (!hi.is_empty() && hi != "none") {
            return;
        }
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        if kids.borrow().kind != 4 {
            return;
        }
        let __it_k = kids.borrow().items.clone();
        for k in __it_k.iter().cloned() {
            if k.borrow().getText("t") != "body" || !k.borrow().has("s") {
                continue;
            }
            let bs: Rc<RefCell<JsonValue>> = k.borrow().get("s");
            for key in vec!["background-color".to_string(), "background-image".to_string(), "background-repeat".to_string(), "background-position".to_string(), "background-size".to_string()].iter().cloned() {
                let v: String = bs.borrow().getText(&key);
                if !v.is_empty() {
                    self.putPage(hs, &key, &v);
                    self.putPage(&bs, &key, "");
                }
            }
            return;
        }
    }
    /// a background-position keyword as a percentage
    pub fn bgPct(w: &str, em: f64) -> String {
        if w.ends_with("em") && !w.ends_with("rem") {
            let num: Option<f64> = w[(0) as usize..((w.as_bytes().len() as i64) - 2) as usize].to_string().parse::<f64>().ok();
            if num.is_some() {
                return format!("{}px", DomView::fmt(num.unwrap() * em));
            }
        }
        if w == "left" || w == "top" {
            return "0%".to_string();
        }
        if w == "center" {
            return "50%".to_string();
        }
        if w == "right" || w == "bottom" {
            return "100%".to_string();
        }
        w.to_string()
    }
    /// a background-position as two values, x then y, each a length or a
    /// percentage (keywords made percentages)
    pub fn bgPosition(v: &str, em: f64) -> String {
        let mut ws: Vec<String> = Vec::new();
        for w in v.to_lowercase().split(" ").map(|s| s.to_string()).collect::<Vec<String>>().iter().cloned() {
            if !w.is_empty() {
                ws.push(w);
            }
        }
        if ws.is_empty() {
            return "0% 0%".to_string();
        }
        if ws.len() == 1 {
            if ws[0] == "top" || ws[0] == "bottom" {
                return format!("50% {}", DomView::bgPct(&ws[0], em));
            }
            return format!("{} 50%", DomView::bgPct(&ws[0], em));
        }
        // (a vertical keyword first, or a horizontal one second: swapped)
        if ws[0] == "top" || (ws[0] == "bottom" || (ws[1] == "left" || ws[1] == "right")) {
            return format!("{} {}", DomView::bgPct(&ws[1], em), DomView::bgPct(&ws[0], em));
        }
        format!("{} {}", DomView::bgPct(&ws[0], em), DomView::bgPct(&ws[1], em))
    }
    /// a base64 PNG, GIF or JPEG data: URL, which the hosts can decode
    pub fn pictureUrl(src: &str) -> bool {
        let mut head: String = src.to_string();
        if head.as_bytes().len() > 32 {
            head = head[(0) as usize..(32) as usize].to_string();
        }
        head = head.to_lowercase();
        (head.starts_with("data:image/png;base64,") || (head.starts_with("data:image/gif;base64,") || head.starts_with("data:image/jpeg;base64,")))
    }
    /// an image's source: a PNG data: URL is in "png" (webapi.js leaves
    /// only its head in src)
    pub fn imgSrc(n: &Rc<RefCell<JsonValue>>) -> String {
        if n.borrow().has("png") {
            return n.borrow().getText("png");
        }
        n.borrow().get("a").borrow().getText("src")
    }
    /// the canvas bitmaps (and data: URL pictures) in a page's tree
    pub fn pngs(n: &Rc<RefCell<JsonValue>>, out: &Rc<RefCell<DomPngs>>) {
        if n.borrow().kind != 5 {
            return;
        }
        if n.borrow().has("png") {
            out.borrow_mut().urls.push(n.borrow().getText("png"));
        }
        if n.borrow().has("s") {
            let bu: String = DomView::bgUrl(&n.borrow().get("s").borrow().getText("background-image"));
            if !bu.is_empty() {
                out.borrow_mut().urls.push(bu);
            }
        }
        if !n.borrow().has("png") && n.borrow().getText("t") == "img" {
            let isrc: String = n.borrow().get("a").borrow().getText("src");
            if DomView::pictureUrl(&isrc) {
                out.borrow_mut().urls.push(isrc);
            }
        }
        let c: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let __it_k = c.borrow().items.clone();
            for k in __it_k.iter().cloned() {
                DomView::pngs(&k, out);
            }
        }
    }
    #[doc(hidden)]
    pub fn build(page: &Rc<RefCell<JsonValue>>, index: i64, w: f64, h: f64) -> Rc<RefCell<EVGElement>> {
        DomView::buildWith(page, index, w, h, Rc::new(RefCell::new(DomSvgDocs::new())))
    }
    /// build with what earlier frames parsed and built (svgs, its memo)
    #[doc(hidden)]
    pub fn buildKept(page: &Rc<RefCell<JsonValue>>, index: i64, w: f64, h: f64, svgs: Rc<RefCell<DomSvgDocs>>) -> Rc<RefCell<EVGElement>> {
        DomView::buildWith(page, index, w, h, svgs)
    }
    pub(crate) fn buildWith(page: &Rc<RefCell<JsonValue>>, index: i64, w: f64, h: f64, svgs: Rc<RefCell<DomSvgDocs>>) -> Rc<RefCell<EVGElement>> {
        EVGLayoutFull::install();
        let v: Rc<RefCell<DomView>> = Rc::new(RefCell::new(DomView::new()));
        v.borrow_mut().svgs = Rc::clone(&svgs);
        v.borrow_mut().index = index;
        v.borrow_mut().pfx = format!("mfd-xd-{}-", index);
        v.borrow_mut().vw = w;
        v.borrow_mut().vh = h;
        // (the root's containing block, the viewport, has a definite height)
        v.borrow_mut().defH = h;
        v.borrow_mut().quirks = page.borrow().getBool("quirks", false);
        let r#box: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        r#box.borrow_mut().id = format!("mfd-dash-{}", index);
        r#box.borrow_mut().width = Some(EVGUnit::px(w));
        let _tmp_2 = EVGUnit::px(h);
        r#box.borrow_mut().height = Some(_tmp_2);
        EVGElement::set_attribute(&r#box, "overflow", "auto".to_string());
        // its bar when the page is longer than the box (bars)
        r#box.borrow_mut().class_name = "mfd-dauto d-dashcanvas".to_string();
        // the page starts from CSS's initial values, not what the window's
        // own style sheet gives the elements around it (.d-page: nowrap)
        EVGElement::set_attribute(&r#box, "white-space", "normal".to_string());
        let root: Rc<RefCell<JsonValue>> = page.borrow().get("root");
        if root.borrow().kind != 5 {
            return Rc::clone(&r#box);
        }
        let inh: Rc<RefCell<JsonValue>> = v.borrow().inherit(&JsonValue::mkObj(), &root.borrow().get("s"));
        let body: Rc<RefCell<JsonValue>> = v.borrow().child(&root, "body");
        if body.borrow().kind != 5 {
            return Rc::clone(&r#box);
        }
        let bi: Rc<RefCell<JsonValue>> = v.borrow().inherit(&inh, &body.borrow().get("s"));
        // (a root with a box of its own, positioned, with a border, padding,
        // margins or a width, is drawn as that box around the body)
        let rs: Rc<RefCell<JsonValue>> = root.borrow().get("s");
        let mut root_box: bool = false;
        let rpos: String = rs.borrow().getText("position");
        if !rpos.is_empty() && rpos != "static" {
            root_box = true;
        }
        for rk in vec!["border-top-style".to_string(), "border-left-style".to_string(), "padding-top".to_string(), "padding-left".to_string(), "margin-top".to_string(), "margin-left".to_string(), "width".to_string()].iter().cloned() {
            let rv: String = rs.borrow().getText(&rk);
            if !rv.is_empty() && rv != "none" && rv != "0px" && rv != "auto" {
                root_box = true;
            }
        }
        // (and a root that lays the body out as a flex or grid item, or
        // one whose head a style sheet shows)
        let rdisp: String = rs.borrow().getText("display");
        if rdisp == "flex" || rdisp == "grid" {
            root_box = true;
        }
        // (or a ::before or ::after of the root's own)
        let rkids: Rc<RefCell<JsonValue>> = root.borrow().get("c");
        let __it_rk = rkids.borrow().items.clone();
        for rk in __it_rk.iter().cloned() {
            if rk.borrow().kind == 5 && rk.borrow().has("pe") {
                root_box = true;
            }
        }
        let head: Rc<RefCell<JsonValue>> = v.borrow().child(&root, "head");
        if head.borrow().kind == 5 {
            let hd: String = head.borrow().get("s").borrow().getText("display");
            if !hd.is_empty() && hd != "none" {
                root_box = true;
            }
        }
        // (the root is a formatting context: the body's margins stay in it)
        if root_box && (rs.borrow().getText("display").is_empty() || rs.borrow().getText("display") == "block") {
            v.borrow().putPage(&rs, "display", "flow-root");
        }
        // (a vertical root: the body's inline size is the initial containing
        // block's height, and in a right-to-left block flow the body is at
        // the right, CSS Writing Modes 7.1)
        let rwm: String = rs.borrow().getText("writing-mode");
        let vroot: bool = !root_box && (rwm == "vertical-rl" || rwm == "vertical-lr" || rwm == "sideways-rl" || rwm == "sideways-lr");
        if vroot {
            let bs: Rc<RefCell<JsonValue>> = body.borrow().get("s");
            let bh: String = bs.borrow().getText("height");
            if bh.is_empty() || bh == "auto" {
                let bmt: f64 = DomView::pxOf(&bs.borrow().getText("margin-top"));
                let bmb: f64 = DomView::pxOf(&bs.borrow().getText("margin-bottom"));
                let bpt: f64 = DomView::pxOf(&bs.borrow().getText("padding-top")) + DomView::pxOf(&bs.borrow().getText("padding-bottom"));
                let bbt: f64 = DomView::pxOf(&bs.borrow().getText("border-top-width")) + DomView::pxOf(&bs.borrow().getText("border-bottom-width"));
                let ih: f64 = h - bmt - bmb - bpt - bbt;
                if ih > 0.0 {
                    v.borrow().putPage(&bs, "height", &format!("{}px", DomView::fmt(ih)));
                }
            }
        }
        let b: Rc<RefCell<EVGElement>> = if root_box { v.borrow_mut().element(&root, inh.clone()) } else { v.borrow_mut().element(&body, bi.clone()) };
        if vroot && (rwm == "vertical-rl" || rwm == "sideways-rl") {
            EVGElement::set_attribute(&b, "align-self", "flex-end".to_string());
        }
        // the top layer's boxes (webapi.js render: the root's last children,
        // marked tl), drawn after everything else, boxes of the viewport
        let mut tops: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        if !root_box {
            v.borrow_mut().outerS = body.borrow().get("s");
            let __it_tk = rkids.borrow().items.clone();
            for tk in __it_tk.iter().cloned() {
                if tk.borrow().kind == 5 && tk.borrow().has("tl") {
                    let ti: Rc<RefCell<JsonValue>> = v.borrow().inherit(&inh, &tk.borrow().get("s"));
                    let te: Rc<RefCell<EVGElement>> = v.borrow_mut().element(&tk, ti.clone());
                    tops.push(te);
                }
            }
        }
        // the page scrolled (the document's scroll is the root's)
        let rsc: Rc<RefCell<JsonValue>> = root.borrow().get("sc");
        if rsc.borrow().kind == 4 && (rsc.borrow().items.len() as i64) == 2 {
            let _tmp_1 = if ((rsc.borrow().items[0].clone().borrow().text().parse::<f64>().ok()).is_some()) { ((rsc.borrow().items[0].clone().borrow().text().parse::<f64>().ok()).unwrap()) } else { 0.0 };
            r#box.borrow_mut().scroll_left = _tmp_1;
            r#box.borrow_mut().scroll_top = if ((rsc.borrow().items[1].clone().borrow().text().parse::<f64>().ok()).is_some()) { ((rsc.borrow().items[1].clone().borrow().text().parse::<f64>().ok()).unwrap()) } else { 0.0 };
        }
        // the body is as tall as its content; the canvas (the whole box)
        // takes the root's background, or the body's when the root has none
        let mut bg: String = root.borrow().get("s").borrow().getText("background-color");
        if bg.is_empty() {
            bg = body.borrow().get("s").borrow().getText("background-color");
        }
        if !bg.is_empty() {
            EVGElement::set_attribute(&r#box, "background-color", bg.clone());
        }
        EVGElement::add_child(&r#box, Rc::clone(&b));
        let __n_ti = tops.len() as i64;
        for ti in 0..__n_ti {
            EVGElement::add_child(&r#box, Rc::clone(&tops[ti as usize]));
        }
        Rc::clone(&svgs.borrow().memo).borrow_mut().settle();
        svgs.borrow_mut().undo();
        Rc::clone(&r#box)
    }
    /// the inherited properties under an element: the parent's, then its own
    pub fn inheritedNames() -> Vec<String> {
        vec!["color".to_string(), "font-size".to_string(), "font-family".to_string(), "font-weight".to_string(), "font-style".to_string(), "font-variant".to_string(), "line-height".to_string(), "text-align".to_string(), "white-space".to_string(), "letter-spacing".to_string(), "word-spacing".to_string(), "cursor".to_string(), "visibility".to_string(), "list-style-type".to_string(), "list-style-position".to_string(), "text-indent".to_string(), "direction".to_string(), "writing-mode".to_string(), "text-orientation".to_string()].clone()
    }
    /// a length that is given, not auto
    pub fn setLen(v: &str) -> bool {
        !v.is_empty() && v != "auto"
    }
    pub fn displayOf(n: &Rc<RefCell<JsonValue>>) -> String {
        let d: String = n.borrow().get("s").borrow().getText("display");
        if d.is_empty() {
            return "inline".to_string();
        }
        d
    }
    /// white space collapsed as `white-space: normal` does. The text is
    /// copied in runs cut at ASCII white space only: a copy per byte splits
    /// a multibyte character, and the Rust build (from_utf8_lossy per piece)
    /// made each of its bytes a U+FFFD (the Sales dashboard's "Päivitä").
    pub fn collapse(s: &str) -> String {
        let mut out: String = String::new();
        let mut space: bool = false;
        let n: i64 = s.as_bytes().len() as i64;
        let mut start: i64 = 0;
        let mut i: i64 = 0;
        while i < n {
            let c: i64 = (s.as_bytes()[i as usize] as i64);
            if c == 32 || (c == 10 || (c == 9 || c == 13)) {
                if start < i {
                    out = format!("{}{}", out, s[(start) as usize..(i) as usize].to_string());
                }
                space = true;
                start = i + 1;
            } else {
                if space {
                    out = format!("{} ", out);
                    space = false;
                }
            }
            i += 1;
        }
        if start < n {
            out = format!("{}{}", out, s[(start) as usize..(n) as usize].to_string());
        }
        if space {
            out = format!("{} ", out);
        }
        out
    }
    pub fn trimmed(s: &str) -> String {
        let mut a: i64 = 0;
        let mut b: i64 = s.as_bytes().len() as i64;
        while a < b && (s.as_bytes()[a as usize] as i64) == 32 {
            a += 1;
        }
        while b > a && (s.as_bytes()[(b - 1) as usize] as i64) == 32 {
            b -= 1;
        }
        s[(a) as usize..(b) as usize].to_string()
    }
    /// the window's face for a CSS font-family and font-weight: [family,
    /// "bold" or ""]. The window has Open Sans (named "Arial", as the window
    /// draws with it) and Figtree, each family's weights by name
    /// ("Figtree-Semibold"), so the measured face is the drawn one; any other
    /// family is drawn in Open Sans, monospace in DejaVu Sans Mono when the build
    /// found it.
    pub fn faceOf(family: &str, weight: &str) -> Vec<String> {
        let mut base: String = "Arial".to_string();
        // (a list naming none of the faces below is Arial: not taken apart
        // name by name, as each text box asks)
        let fl: String = family.to_lowercase();
        let special: bool = DomText::index_of(&fl, "figtree") >= 0 || DomText::index_of(&fl, "ahem") >= 0 || DomText::index_of(&fl, "open sans") >= 0 || DomText::index_of(&fl, "monospace") >= 0 || DomText::index_of(&fl, "dejavu sans mono") >= 0;
        let names: Vec<String> = if special { family.split(",").map(|s| s.to_string()).collect::<Vec<String>>() } else { Vec::new() };
        for raw in names.iter().cloned() {
            let nm: String = DomView::trimmed(&DomView::unquoted(&raw)).to_lowercase();
            if nm == "figtree" {
                base = "Figtree".to_string();
                break;
            }
            // WPT's test face: one weight, every glyph a square
            if nm == "ahem" {
                return vec!["Ahem".to_string(), String::new()].clone();
            }
            if nm == "open sans" {
                break;
            }
            if nm == "monospace" || nm == "dejavu sans mono" {
                base = "DejaVu Sans Mono".to_string();
                break;
            }
        }
        let mut w: i64 = 400;
        if weight == "bold" || weight == "bolder" {
            w = 700;
        } else {
            let n: Option<i64> = weight.parse::<i64>().ok();
            if n.is_some() {
                w = n.unwrap();
            }
        }
        // (the monospace face has one bold weight)
        if w >= 700 || w >= 600 && base == "DejaVu Sans Mono" {
            return vec![base, "bold".to_string()].clone();
        }
        if w >= 600 {
            return vec![format!("{}-Semibold", base), String::new()].clone();
        }
        if w >= 500 && base == "Figtree" {
            return vec!["Figtree-Medium".to_string(), String::new()].clone();
        }
        vec![base, String::new()].clone()
    }
    /// the quotes taken out, the text between them copied in runs (as collapse)
    pub fn unquoted(s: &str) -> String {
        let mut out: String = String::new();
        let n: i64 = s.as_bytes().len() as i64;
        let mut start: i64 = 0;
        let mut i: i64 = 0;
        while i < n {
            let c: i64 = (s.as_bytes()[i as usize] as i64);
            if c == 34 || c == 39 {
                if start < i {
                    out = format!("{}{}", out, s[(start) as usize..(i) as usize].to_string());
                }
                start = i + 1;
            }
            i += 1;
        }
        if start < n {
            out = format!("{}{}", out, s[(start) as usize..(n) as usize].to_string());
        }
        out
    }
    /// the box properties EVG takes as they are
    pub fn boxNames() -> Vec<String> {
        vec!["width".to_string(), "height".to_string(), "min-width".to_string(), "min-height".to_string(), "max-width".to_string(), "max-height".to_string(), "margin-top".to_string(), "margin-right".to_string(), "margin-bottom".to_string(), "margin-left".to_string(), "padding-top".to_string(), "padding-right".to_string(), "padding-bottom".to_string(), "padding-left".to_string(), "background-color".to_string(), "background-image".to_string(), "opacity".to_string(), "position".to_string(), "top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string(), "flex-grow".to_string(), "flex-shrink".to_string(), "flex-basis".to_string(), "align-self".to_string(), "justify-self".to_string(), "justify-content".to_string(), "align-content".to_string(), "row-gap".to_string(), "column-gap".to_string(), "grid-template-columns".to_string(), "grid-template-rows".to_string(), "grid-template-areas".to_string(), "grid-column".to_string(), "grid-row".to_string(), "grid-area".to_string(), "grid-auto-flow".to_string(), "grid-auto-columns".to_string(), "grid-auto-rows".to_string(), "text-overflow".to_string(), "transform".to_string(), "transform-origin".to_string(), "object-fit".to_string(), "aspect-ratio".to_string()].clone()
    }
    pub fn stretchy(v: &str) -> bool {
        v == "stretch" || (v == "-webkit-fill-available" || v == "-moz-available")
    }
    /// a size limit less the padding and border (0, none, stays 0)
    pub fn lessChrome(v: f64, c: f64) -> f64 {
        if v <= 0.0 {
            return v;
        }
        let r: f64 = v - c;
        if r <= 0.0 {
            return 0.01;
        }
        r
    }
    /// whether a box's inline size is contained (contain: size, inline-size
    /// or strict): sized as if empty
    pub fn sizeContained(s: &Rc<RefCell<JsonValue>>) -> bool {
        let ctn: String = s.borrow().getText("contain");
        DomText::index_of(&ctn, "size") >= 0 || DomText::index_of(&ctn, "strict") >= 0
    }
    /// whether an inset is set (not auto)
    pub fn inset(s: &Rc<RefCell<JsonValue>>, side: &str) -> bool {
        let v: String = s.borrow().getText(side);
        !v.is_empty() && v != "auto"
    }
    /// a px length as a number; 0 for anything else
    /// "10em" → "100px" (at 10px) wherever a number ends in em, not rem
    pub fn emToPx(v: &str, fs: f64) -> String {
        let mut out: String = String::new();
        let mut i: i64 = 0;
        let n: i64 = v.as_bytes().len() as i64;
        while i < n {
            let c: i64 = (v.as_bytes()[i as usize] as i64);
            let isNum: bool = (c >= 48 && c <= 57) || c == 46;
            if isNum {
                let mut j: i64 = i;
                while j < n && ((v.as_bytes()[j as usize] as i64) >= 48 && (v.as_bytes()[j as usize] as i64) <= 57 || (v.as_bytes()[j as usize] as i64) == 46) {
                    j += 1;
                }
                // (rem: of the root's 16px)
                if j + 2 < n && v[(j) as usize..(j + 3) as usize].to_string() == "rem" {
                    let dr: Option<f64> = v[(i) as usize..(j) as usize].to_string().parse::<f64>().ok();
                    if dr.is_some() {
                        out = format!("{}{}px", out, DomView::fmt(dr.unwrap() * 16.0));
                        i = j + 3;
                        continue;
                    }
                }
                if j + 1 < n && v[(j) as usize..(j + 2) as usize].to_string() == "em" {
                    let d: Option<f64> = v[(i) as usize..(j) as usize].to_string().parse::<f64>().ok();
                    if d.is_some() {
                        out = format!("{}{}px", out, DomView::fmt(d.unwrap() * fs));
                        i = j + 2;
                        continue;
                    }
                }
                out = format!("{}{}", out, v[(i) as usize..(j) as usize].to_string());
                i = j;
                continue;
            }
            out = format!("{}{}", out, DomText::unit_at(&v, i));
            i += 1;
        }
        out
    }
    /// the floats a clear value clears: left, right or both ("true")
    pub fn clearSide(clr: &str) -> String {
        if clr == "left" || clr == "right" {
            return clr.to_string();
        }
        "true".to_string()
    }
    /// an aspect-ratio's width over height ("2 / 1", "2"; 0 when not one)
    pub fn ratioOf(v: &str) -> f64 {
        let sl: i64 = DomText::index_of(&v, "/");
        if sl < 0 {
            return if ((DomView::trimmed(v).parse::<f64>().ok()).is_some()) { ((DomView::trimmed(v).parse::<f64>().ok()).unwrap()) } else { 0.0 };
        }
        let a: f64 = if ((DomView::trimmed(&v[(0) as usize..(sl) as usize].to_string()).parse::<f64>().ok()).is_some()) { ((DomView::trimmed(&v[(0) as usize..(sl) as usize].to_string()).parse::<f64>().ok()).unwrap()) } else { 0.0 };
        let b: f64 = if ((DomView::trimmed(&v[(sl + 1) as usize..(v.as_bytes().len() as i64) as usize].to_string()).parse::<f64>().ok()).is_some()) { ((DomView::trimmed(&v[(sl + 1) as usize..(v.as_bytes().len() as i64) as usize].to_string()).parse::<f64>().ok()).unwrap()) } else { 0.0 };
        if b <= 0.0 {
            return 0.0;
        }
        a / b
    }
    pub fn pxOf(v: &str) -> f64 {
        let n: i64 = v.as_bytes().len() as i64;
        if n < 3 || v[(n - 2) as usize..(n) as usize].to_string() != "px" {
            return 0.0;
        }
        let d: Option<f64> = v[(0) as usize..(n - 2) as usize].to_string().parse::<f64>().ok();
        if d.is_some() {
            return d.unwrap();
        }
        0.0
    }
    /// a border side's width: 0 when it has no style
    /// a button or text field the page left to the browser's own look
    /// (border and background still the browser's style sheet's): Chromium
    /// paints it as a control, a 1px #767676 line with 2px round corners
    /// inside the 2px border its layout keeps, not the outset/inset border
    fn nativeLook(e: &Rc<RefCell<EVGElement>>, s: &Rc<RefCell<JsonValue>>, t: &str, r#type: &str) {
        let btn: bool = t == "button" || t == "input" && (r#type == "button" || (r#type == "submit" || r#type == "reset"));
        let field: bool = (((t == "input" && !btn) && r#type != "checkbox") && r#type != "radio") && r#type != "hidden";
        // (a button with no text has its baseline at its content box's
        // bottom, as Chromium has it)
        if t == "button" {
            let rhs_1 = format!("{} mfd-button", e.borrow().class_name);
            e.borrow_mut().class_name = rhs_1;
        }
        if !btn && !field {
            return;
        }
        let mut want: String = "outset".to_string();
        let mut bg: String = "rgb(239, 239, 239)".to_string();
        let mut bg_off: String = "rgba(239, 239, 239, 0.3)".to_string();
        if field {
            want = "inset".to_string();
            bg = "rgb(255, 255, 255)".to_string();
            bg_off = bg.clone();
        }
        let __v_si: Vec<String> = vec!["top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string()];
        let __n_si = __v_si.len() as i64;
        for si in 0..__n_si {
            let sd = __v_si[si as usize].clone();
            if s.borrow().getText(&format!("border-{}-style", sd)) != want || DomView::side(s, &sd) != 2.0 {
                return;
            }
        }
        let bc: String = s.borrow().getText("border-top-color");
        let mut line: String = "".to_string();
        if bc == "rgb(118, 118, 118)" && s.borrow().getText("background-color") == bg {
            line = "rgb(118, 118, 118)".to_string();
        }
        // (disabled: Chromium's paler line, and its fill not see-through)
        if bc == "rgba(118, 118, 118, 0.3)" && s.borrow().getText("background-color") == bg_off {
            line = "rgb(209, 209, 209)".to_string();
            if btn {
                EVGElement::set_attribute(&e, "background-color", "rgb(238, 238, 238)".to_string());
            }
        }
        if line.is_empty() {
            return;
        }
        EVGElement::set_attribute(&e, "border-width", "1px".to_string());
        EVGElement::set_attribute(&e, "border-color", line.to_string());
        let __v_pi: Vec<String> = vec!["top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string()];
        let __n_pi = __v_pi.len() as i64;
        for pi in 0..__n_pi {
            let pd = __v_pi[pi as usize].clone();
            let _tmp_1 = DomView::pxOf(&s.borrow().getText(&format!("padding-{}", pd))) + 1.0;
            EVGElement::set_attribute(
                &e,
                &format!("padding-{}", pd),
                format!("{}px", DomView::fmt(_tmp_1))
            );
        }
        let r: String = s.borrow().getText("border-top-left-radius");
        if r.is_empty() || r == "0px" {
            EVGElement::set_attribute(&e, "border-radius", "2px".to_string());
        }
    }
    /// a checkbox or radio button as Chromium draws it, in 13px
    pub fn checkSvg(r#type: &str, on: bool, off: bool) -> String {
        let mut accent: String = "#0075ff".to_string();
        let mut line: String = "#767676".to_string();
        let mut fill: String = "#ffffff".to_string();
        let mut tick: String = "#ffffff".to_string();
        if off {
            accent = "#d1d1d1".to_string();
            line = "#d1d1d1".to_string();
            fill = "#f8f8f8".to_string();
            tick = "#ededed".to_string();
        }
        let head: String = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"13\" height=\"13\" viewBox=\"0 0 13 13\">".to_string();
        if r#type == "radio" {
            if on {
                return format!("{}<circle cx=\"6.5\" cy=\"6.5\" r=\"6\" fill=\"{}\" stroke=\"{}\" stroke-width=\"1\"/><circle cx=\"6.5\" cy=\"6.5\" r=\"3.5\" fill=\"{}\"/></svg>", head, fill, accent, accent);
            }
            return format!("{}<circle cx=\"6.5\" cy=\"6.5\" r=\"6\" fill=\"{}\" stroke=\"{}\" stroke-width=\"1\"/></svg>", head, fill, line);
        }
        if on {
            return format!("{}<rect x=\"0\" y=\"0\" width=\"13\" height=\"13\" rx=\"2\" fill=\"{}\"/><path d=\"M3 6.6 L5.4 9 L10 3.9\" fill=\"none\" stroke=\"{}\" stroke-width=\"1.8\"/></svg>", head, accent, tick);
        }
        format!("{}<rect x=\"0.5\" y=\"0.5\" width=\"12\" height=\"12\" rx=\"2\" fill=\"{}\" stroke=\"{}\" stroke-width=\"1\"/></svg>", head, fill, line)
    }
    /// an inline's own box shows: a background, a border or padding
    pub fn decorated(s: &Rc<RefCell<JsonValue>>, rtl: bool) -> bool {
        let bg: String = s.borrow().getText("background-color");
        if !bg.is_empty() && (bg != "transparent" && bg != "rgba(0, 0, 0, 0)") {
            return true;
        }
        let __v_sd: Vec<String> = vec!["top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string()];
        let __n_sd = __v_sd.len() as i64;
        for sd in 0..__n_sd {
            let nm = __v_sd[sd as usize].clone();
            if DomView::side(s, &nm) > 0.0 {
                return true;
            }
            if DomView::pxOf(&s.borrow().getText(&format!("padding-{}", nm))) > 0.0 {
                return true;
            }
            // (a side margin moves what follows it on the line; right to
            // left the words keep their own boxes)
            if !rtl && (nm == "left" || nm == "right") && DomView::pxOf(&s.borrow().getText(&format!("margin-{}", nm))) > 0.0 {
                return true;
            }
        }
        false
    }
    /// what deco draws, into the pieces' inherited style
    pub fn putDeco(inh: &Rc<RefCell<JsonValue>>, s: &Rc<RefCell<JsonValue>>, id: &str) {
        // (an inline decorated inside another keeps the other's box as
        // _deco2_, drawn on a wrapper around its pieces)
        if inh.borrow().has("_deco_id") {
            let __v_dk: Vec<String> = vec!["id".to_string(), "bg".to_string(), "btop".to_string(), "bright".to_string(), "bbottom".to_string(), "bleft".to_string(), "ptop".to_string(), "pright".to_string(), "pbottom".to_string(), "pleft".to_string(), "mtop".to_string(), "mright".to_string(), "mbottom".to_string(), "mleft".to_string()];
            let __n_dk = __v_dk.len() as i64;
            for dk in 0..__n_dk {
                let kn = __v_dk[dk as usize].clone();
                let kv: String = inh.borrow().getText(&format!("_deco_{}", kn));
                inh.borrow_mut().put(&format!("_deco2_{}", kn), JsonValue::mkStr(kv.clone()));
            }
        }
        inh.borrow_mut().put("_deco_id", JsonValue::mkStr(id.to_string()));
        let bg: String = s.borrow().getText("background-color");
        let mut bgv: String = String::new();
        if !bg.is_empty() && (bg != "transparent" && bg != "rgba(0, 0, 0, 0)") {
            bgv = bg.clone();
        }
        inh.borrow_mut().put("_deco_bg", JsonValue::mkStr(bgv.clone()));
        let __v_sd: Vec<String> = vec!["top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string()];
        let __n_sd = __v_sd.len() as i64;
        for sd in 0..__n_sd {
            let nm = __v_sd[sd as usize].clone();
            let w: f64 = DomView::side(s, &nm);
            let mut bv: String = String::new();
            if w > 0.0 {
                bv = format!("{}px {} {}", DomView::fmt(w), s.borrow().getText(&format!("border-{}-style", nm)), DomView::sideColor(s, &nm));
            }
            inh.borrow_mut().put(&format!("_deco_b{}", nm), JsonValue::mkStr(bv.clone()));
            inh.borrow_mut().put(&format!("_deco_p{}", nm), JsonValue::mkStr(DomView::fmt(DomView::pxOf(&s.borrow().getText(&format!("padding-{}", nm))))));
            inh.borrow_mut().put(&format!("_deco_m{}", nm), JsonValue::mkStr(DomView::fmt(DomView::pxOf(&s.borrow().getText(&format!("margin-{}", nm))))));
        }
    }
    /// an inline's box on its pieces: the background and the top and
    /// bottom sides on each (outside the line's height), the left side on
    /// its first piece and the right on its last
    fn deco(&self, pieces: &[Rc<RefCell<EVGElement>>], pinh: &[Rc<RefCell<JsonValue>>], pgap: &[bool], dp: &str) {
        let n: i64 = pieces.len() as i64;
        for i in 0..n {
            let inh: Rc<RefCell<JsonValue>> = pinh[i as usize].clone();
            let id: String = inh.borrow().getText(&format!("{}id", dp));
            if id.is_empty() {
                continue;
            }
            let e: Rc<RefCell<EVGElement>> = pieces[i as usize].clone();
            let bg: String = inh.borrow().getText(&format!("{}bg", dp));
            if !bg.is_empty() {
                EVGElement::set_attribute(&e, "background-color", bg.clone());
            }
            let mut first: bool = true;
            // (a neighbour in the same inline, at either depth, continues it)
            if i > 0 && (pinh[(i - 1) as usize].clone().borrow().getText("_deco_id") == id || pinh[(i - 1) as usize].clone().borrow().getText("_deco2_id") == id) {
                first = false;
            }
            let mut last: bool = true;
            if i < n - 1 && (pinh[(i + 1) as usize].clone().borrow().getText("_deco_id") == id || pinh[(i + 1) as usize].clone().borrow().getText("_deco2_id") == id) {
                last = false;
            }
            // (the sides painted where they are folded into the padding,
            // as a box's: top right bottom left)
            let __v_sd: Vec<String> = vec!["top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string()];
            let __n_sd = __v_sd.len() as i64;
            let mut bws: Vec<String> = Vec::new();
            let mut bcs: Vec<String> = Vec::new();
            let mut bss: Vec<String> = Vec::new();
            let mut btot: f64 = 0.0;
            let mut styled: bool = false;
            // (its background and sides are around the font's content
            // area, not the line: the leading is outside them)
            let mut ffs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
            if ffs == 0.0 && inh.borrow().getText("font-size") != "0px" {
                ffs = 16.0;
            }
            let flh: f64 = DomView::lineHeight(&inh);
            let fface: String = DomView::faceOf(&inh.borrow().getText("font-family"), "")[0].clone();
            let fsp: Vec<f64> = DomView::lineSplit(ffs, flh, &fface);
            let farea: f64 = (ffs * DomView::ascentEm(&fface) + 0.5).floor() + (ffs * DomView::descentEm(&fface) + 0.5).floor();
            let lead: f64 = fsp[0] - (ffs * DomView::ascentEm(&fface) + 0.5).floor();
            let lead_under: f64 = fsp[1] - (ffs * DomView::descentEm(&fface) + 0.5).floor();
            if (lead != 0.0 || lead_under != 0.0) && !e.borrow().text_content.is_empty() {
                EVGElement::set_attribute(&e, "line-height", format!("{}px", DomView::fmt(farea)));
            }
            for sd in 0..__n_sd {
                let nm = __v_sd[sd as usize].clone();
                let mut skip: bool = false;
                if nm == "left" && !first {
                    skip = true;
                }
                if nm == "right" && !last {
                    skip = true;
                }
                let bv: String = inh.borrow().getText(&format!("{}b{}", dp, nm));
                let mut bw: f64 = 0.0;
                let mut bc: String = "rgb(0, 0, 0)".to_string();
                let mut bst: String = "solid".to_string();
                if !bv.is_empty() && !skip {
                    bw = DomView::pxOf(&DomView::lineSplitFirst(&bv));
                    let rest: String = bv[(DomView::lineSplitFirst(&bv).as_bytes().len() as i64 + 1) as usize..(bv.as_bytes().len() as i64) as usize].to_string();
                    bst = DomView::lineSplitFirst(&rest);
                    bc = rest[(bst.as_bytes().len() as i64 + 1) as usize..(rest.as_bytes().len() as i64) as usize].to_string();
                    if bst == "dotted" || bst == "dashed" {
                        styled = true;
                    }
                }
                btot = btot + bw;
                bws.push(DomView::fmt(bw));
                bcs.push(bc.clone());
                bss.push(bst.clone());
                let mut pv: f64 = 0.0;
                if !skip {
                    pv = DomView::pxOf(&format!("{}px", inh.borrow().getText(&format!("{}p{}", dp, nm))));
                }
                if pv + bw > 0.0 {
                    EVGElement::set_attribute(&e, &format!("padding-{}", nm), format!("{}px", DomView::fmt(pv + bw)));
                }
                if nm == "top" || nm == "bottom" {
                    // (an inline's sides above and below do not move the
                    // line; the leading is the margin)
                    let mut lm: f64 = 0.0;
                    if (lead != 0.0 || lead_under != 0.0) && !e.borrow().text_content.is_empty() {
                        lm = if nm == "top" { lead } else { lead_under };
                    }
                    // (a wrapper's content is its piece's line, the
                    // leading inside: its box is around the font's area)
                    let mut xl: f64 = 0.0;
                    if dp == "_deco2_" && (lead != 0.0 || lead_under != 0.0) {
                        xl = if nm == "top" { 0.0 - lead } else { 0.0 - lead_under };
                        EVGElement::set_attribute(&e, &format!("padding-{}", nm), format!("{}px", DomView::fmt(pv + bw + xl)));
                    }
                    if lm - (bw + pv + xl) != 0.0 {
                        EVGElement::set_attribute(&e, &format!("margin-{}", nm), format!("{}px", DomView::fmt(lm - (bw + pv + xl))));
                    }
                } else {
                    if !skip {
                        let mv: f64 = DomView::pxOf(&format!("{}px", inh.borrow().getText(&format!("{}m{}", dp, nm))));
                        if mv != 0.0 {
                            EVGElement::set_attribute(&e, &format!("margin-{}", nm), format!("{}px", DomView::fmt(mv)));
                        }
                    }
                }
            }
            // (the space to the next word of the inline is in its box)
            if !last && pgap[i as usize] {
                let gw: f64 = DomView::spaceWidth(&inh);
                let pr0: f64 = DomView::mPx(e.borrow().r#box.as_ref().unwrap().borrow().padding_right.clone());
                let mr0: f64 = DomView::mPx(e.borrow().r#box.as_ref().unwrap().borrow().margin_right.clone());
                EVGElement::set_attribute(&e, "padding-right", format!("{}px", DomView::fmt(pr0 + gw)));
                EVGElement::set_attribute(&e, "margin-right", format!("{}px", DomView::fmt(mr0 - gw)));
            }
            if btot > 0.0 {
                let mut styles: String = String::new();
                if styled {
                    styles = format!("|{} {} {} {}", bss[0], bss[1], bss[2], bss[3]);
                }
                EVGElement::set_attribute(
                    &e,
                    "side-borders",
                    format!("{} {} {} {}|{}|{}|{}|{}{}", bws[0], bws[1], bws[2], bws[3], bcs[0], bcs[1], bcs[2], bcs[3], styles)
                );
            }
        }
    }
    /// the first word of a value
    pub fn lineSplitFirst(v: &str) -> String {
        let sp: i64 = DomText::index_of(v, " ");
        if sp < 0 {
            return v.to_string();
        }
        v[(0) as usize..(sp) as usize].to_string()
    }
    pub fn side(s: &Rc<RefCell<JsonValue>>, name: &str) -> f64 {
        let st: String = s.borrow().getText(&format!("border-{}-style", name));
        if st.is_empty() || (st == "none" || st == "hidden") {
            return 0.0;
        }
        return DomView::pxOf(&s.borrow().getText(&format!("border-{}-width", name)));
    }
    /// a border side's color, currentcolor made the text color
    pub fn sideColor(s: &Rc<RefCell<JsonValue>>, name: &str) -> String {
        let c: String = s.borrow().getText(&format!("border-{}-color", name));
        if c.is_empty() || c == "currentcolor" {
            let t: String = s.borrow().getText("color");
            if t.is_empty() {
                return "rgb(0, 0, 0)".to_string();
            }
            return t;
        }
        c
    }
    pub fn fmt(v: f64) -> String {
        let r: i64 = v.floor() as i64;
        if (r as f64) == v {
            return r.to_string();
        }
        v.to_string()
    }
    /// a px size made a border box's by adding what is around the content
    /// the height of a line of the inherited font: line-height, or the
    /// face's for normal
    pub fn lineHeight(inh: &Rc<RefCell<JsonValue>>) -> f64 {
        let mut fs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
        if fs == 0.0 && inh.borrow().getText("font-size") != "0px" {
            fs = 16.0;
        }
        let lh: String = inh.borrow().getText("line-height");
        let px: f64 = DomView::pxOf(&lh);
        if px > 0.0 {
            return px;
        }
        // (a line-height of nothing is a line of nothing)
        if lh == "0px" || (lh == "0" || lh == "0%") {
            return 0.0;
        }
        let k: Option<f64> = lh.parse::<f64>().ok();
        if k.is_some() && !lh.is_empty() {
            return k.unwrap() * fs;
        }
        DomView::normalLine(inh, fs)
    }
    /// a line of a font of fs px, line-height lh, as above and below its
    /// baseline: the face's ascent and descent (rounded, as Chromium has
    /// them) and half the leading each
    pub fn lineSplit(fs: f64, lh: f64, face: &str) -> Vec<f64> {
        let asc: f64 = DomView::ascentEm(face);
        let desc: f64 = DomView::descentEm(face);
        let a: f64 = ((fs * asc + 0.5).floor() as i64) as f64;
        let d: f64 = ((fs * desc + 0.5).floor() as i64) as f64;
        let half: f64 = (lh - (a + d)) / 2.0;
        vec![(a + half), (d + half)].clone()
    }
    /// the block's font's line (the strut) above and under its baseline
    pub fn strutOf(inh: &Rc<RefCell<JsonValue>>) -> Vec<f64> {
        let mut fs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
        if fs == 0.0 && inh.borrow().getText("font-size") != "0px" {
            fs = 16.0;
        }
        let _tmp_1 = DomView::lineHeight(inh);
        return DomView::lineSplit(fs, _tmp_1, &DomView::faceOf(&inh.borrow().getText("font-family"), "")[0].clone());
    }
    /// a text element's line above and under its baseline
    fn splitOf(el: &Rc<RefCell<EVGElement>>) -> Vec<f64> {
        let fs: f64 = el.borrow().font_size.as_ref().unwrap().borrow().value;
        let face: String = el.borrow().font_family.clone();
        let mut lh: f64 = el.borrow().line_height * fs;
        if el.borrow().line_height_unit.as_ref().unwrap().borrow().is_set {
            lh = el.borrow().line_height_unit.as_ref().unwrap().borrow().value;
        }
        if lh == 0.0 {
            lh = DomView::normalLineOf(fs, &face);
        }
        // (with its margins and padding: a decorated inline's piece is its
        // content area, the leading in its margins, its sides in its
        // padding and taken back by its margins)
        let sp: Vec<f64> = DomView::lineSplit(fs, lh, &face);
        let mt: f64 = DomView::mPx(el.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone());
        let mb: f64 = DomView::mPx(el.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone());
        let pt: f64 = DomView::mPx(el.borrow().r#box.as_ref().unwrap().borrow().padding_top.clone());
        let pb: f64 = DomView::mPx(el.borrow().r#box.as_ref().unwrap().borrow().padding_bottom.clone());
        vec![sp[0] + mt + pt, sp[1] + mb + pb].clone()
    }
    /// the text element of a run: the element itself, or an inline box's
    /// (a `<span>`) one text element
    fn runOf(el: &Rc<RefCell<EVGElement>>) -> Option<Rc<RefCell<EVGElement>>> {
        let mut r: Option<Rc<RefCell<EVGElement>>> = None;
        if !el.borrow().text_content.is_empty() {
            if el.borrow().font_size.as_ref().unwrap().borrow().is_set {
                r = Some(Rc::clone(&el));
            }
            return r;
        }
        // (or its words, all of its font)
        if el.borrow().children.is_empty() {
            return r;
        }
        let __it_c = el.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            if c.borrow().text_content.is_empty() || !c.borrow()
                .font_size.as_ref()
                .unwrap()
                .borrow()
                .is_set {
                return r;
            }
        }
        r = Some(Rc::clone(&el.borrow().children[0]));
        r
    }
    pub fn maxOf(a: f64, b: f64) -> f64 {
        if a > b {
            return a;
        }
        b
    }
    /// a text element on a line that reaches `above` over the baseline and
    /// `below` under it: margins make up the difference
    fn onStrut(el: &Rc<RefCell<EVGElement>>, above: f64, below: f64) {
        let t: Option<Rc<RefCell<EVGElement>>> = DomView::runOf(el);
        if t.is_none() {
            return;
        }
        let own: Vec<f64> = DomView::splitOf(&t.clone().unwrap());
        let up: f64 = above - own[0];
        let down: f64 = below - own[1];
        // (the strut's room is the line's: it collapses with no margin)
        if (up > 0.01 || down > 0.01) && DomText::index_of(&el.borrow().class_name, "mfd-strut") < 0 {
            let _tmp_c = format!("{} mfd-strut", el.borrow().class_name);
            el.borrow_mut().class_name = _tmp_c;
        }
        if up > 0.01 {
            let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(el.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone()) + up));
            EVGElement::set_attribute(&el, "margin-top", _tmp_1);
        }
        if down > 0.01 {
            let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(el.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) + down));
            EVGElement::set_attribute(&el, "margin-bottom", _tmp_1);
        }
    }
    pub fn normalLineOf(fs: f64, face: &str) -> f64 {
        (((fs * DomView::ascentEm(face) + 0.5).floor() as i64) as f64) + (((fs * DomView::descentEm(face) + 0.5).floor() as i64) as f64)
    }
    /// a face's ascent and descent (hhea) in ems: Figtree, Ahem (WPT's
    /// test face) and Open Sans, which stands for every other family
    pub fn ascentEm(face: &str) -> f64 {
        if DomText::index_of(&face, "Figtree") == 0 {
            return 0.95;
        }
        if face == "Ahem" {
            return 0.8;
        }
        if face == "DejaVu Sans Mono" {
            return 0.92822;
        }
        1.06885
    }
    pub fn descentEm(face: &str) -> f64 {
        if DomText::index_of(&face, "Figtree") == 0 {
            return 0.25;
        }
        if face == "Ahem" {
            return 0.2;
        }
        if face == "DejaVu Sans Mono" {
            return 0.23584;
        }
        0.29297
    }
    /// `line-height: normal` as Chromium has it: the face's ascent and
    /// descent (hhea), each rounded to the pixel
    pub fn normalLine(inh: &Rc<RefCell<JsonValue>>, fs: f64) -> f64 {
        let face: String = DomView::faceOf(&inh.borrow().getText("font-family"), "")[0].clone();
        let asc: f64 = DomView::ascentEm(&face);
        let desc: f64 = DomView::descentEm(&face);
        (((fs * asc + 0.5).floor() as i64) as f64) + (((fs * desc + 0.5).floor() as i64) as f64)
    }
    pub fn or(s: &str, fallback: &str) -> String {
        if s.is_empty() {
            return fallback.to_string();
        }
        s.to_string()
    }
    /// --- writing modes ----------------------------------------------------------
    /// "" for horizontal-tb, else the vertical mode a writing-mode value is
    pub fn wmOf(inh: &Rc<RefCell<JsonValue>>) -> String {
        let w: String = inh.borrow().getText("writing-mode");
        if w == "vertical-lr" || w == "sideways-lr" {
            return "vertical-lr".to_string();
        }
        if ((w == "vertical-rl" || w == "sideways-rl") || w == "tb-rl") || w == "tb" {
            return "vertical-rl".to_string();
        }
        String::new()
    }
    /// a physical side as the frame of a vertical mode has it: the inline
    /// axis is x (top is the inline start), the block axis y (the left side
    /// in vertical-lr, the right in vertical-rl, is the block start)
    pub fn sideIn(side: &str, mode: &str) -> String {
        if side == "top" {
            return "left".to_string();
        }
        if side == "bottom" {
            return "right".to_string();
        }
        if side == "left" {
            if mode == "vertical-rl" {
                return "bottom".to_string();
            }
            return "top".to_string();
        }
        if side == "right" {
            if mode == "vertical-rl" {
                return "top".to_string();
            }
            return "bottom".to_string();
        }
        side.to_string()
    }
    /// a computed style in the frame of `mode` (as it is for horizontal-tb)
    pub fn logical(s: &Rc<RefCell<JsonValue>>, mode: &str) -> Rc<RefCell<JsonValue>> {
        if mode.is_empty() {
            return s.clone();
        }
        let o: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        let __n_i = s.borrow().keys.len() as i64;
        for i in 0..__n_i {
            let k = s.borrow().keys[i as usize].clone();
            let mut nk: String = k.clone();
            if k == "width" {
                nk = "height".to_string();
            }
            if k == "height" {
                nk = "width".to_string();
            }
            if k == "min-width" {
                nk = "min-height".to_string();
            }
            if k == "min-height" {
                nk = "min-width".to_string();
            }
            if k == "max-width" {
                nk = "max-height".to_string();
            }
            if k == "max-height" {
                nk = "max-width".to_string();
            }
            if k == "overflow-x" {
                nk = "overflow-y".to_string();
            }
            if k == "overflow-y" {
                nk = "overflow-x".to_string();
            }
            if k == "top" || (k == "right" || (k == "bottom" || k == "left")) {
                nk = DomView::sideIn(&k, mode);
            }
            let __v_pj: Vec<String> = vec!["margin-".to_string(), "padding-".to_string(), "border-".to_string()];
            let __n_pj = __v_pj.len() as i64;
            for pj in 0..__n_pj {
                let pre = __v_pj[pj as usize].clone();
                if DomText::index_of(&k, &pre) == 0 {
                    let rest: String = k[(pre.as_bytes().len() as i64) as usize..(k.as_bytes().len() as i64) as usize].to_string();
                    let dash: i64 = DomText::index_of(&rest, "-");
                    let mut side: String = rest.clone();
                    let mut tail: String = String::new();
                    if dash > 0 {
                        side = rest[(0) as usize..(dash) as usize].to_string();
                        tail = rest[(dash) as usize..(rest.as_bytes().len() as i64) as usize].to_string();
                    }
                    if side == "top" || (side == "right" || (side == "bottom" || side == "left")) {
                        nk = format!("{}{}{}", pre, DomView::sideIn(&side, mode), tail);
                    }
                }
            }
            // (a ratio of width to height is height to width turned)
            if k == "aspect-ratio" {
                let av: String = s.borrow().getText("aspect-ratio");
                let mut pre: String = String::new();
                let mut rv: String = DomView::trimmed(&av);
                if DomText::index_of(&rv, "auto") == 0 {
                    pre = "auto ".to_string();
                    rv = DomView::trimmed(&rv[(4) as usize..(rv.as_bytes().len() as i64) as usize].to_string());
                }
                let ra: i64 = DomText::index_of(&rv, "auto");
                if ra > 0 {
                    pre = " auto".to_string();
                    rv = DomView::trimmed(&rv[(0) as usize..(ra) as usize].to_string());
                }
                if DomView::ratioOf(&rv) > 0.0 {
                    let rs: i64 = DomText::index_of(&rv, "/");
                    let mut tv: String = format!("1 / {}", rv);
                    if rs > 0 {
                        tv = format!("{} / {}", DomView::trimmed(&rv[(rs + 1) as usize..(rv.as_bytes().len() as i64) as usize].to_string()), DomView::trimmed(&rv[(0) as usize..(rs) as usize].to_string()));
                    }
                    if pre == " auto" {
                        tv = format!("{} auto", tv);
                    } else {
                        tv = format!("{}{}", pre, tv);
                    }
                    o.borrow_mut().put(&nk, JsonValue::mkStr(tv));
                    continue;
                }
            }
            o.borrow_mut().put(&nk, s.borrow().items[i as usize].clone());
        }
        o
    }
    /// after the page's layout: a box in another writing mode that its
    /// parent sized otherwise than it came out on its own (a flex item that
    /// grew, a stretched grid item) is laid out again at that size
    #[doc(hidden)]
    pub fn settle(el: &Rc<RefCell<EVGElement>>) {
        if DomText::index_of(&el.borrow().class_name, "mfd-wm") == 0 {
            let __n_li = el.borrow().children.len() as i64;
            for li in 0..__n_li {
                let l = Rc::clone(&el.borrow().children[li as usize]);
                let want_w: f64 = el.borrow().calculated_height;
                let want_h: f64 = el.borrow().calculated_width;
                let dw: f64 = want_w - l.borrow().calculated_width;
                let dh: f64 = want_h - l.borrow().calculated_height;
                if (dw * dw > 0.25 || dh * dh > 0.25) && (want_w > 0.0 && want_h > 0.0) {
                    EVGElement::set_attribute(&l, "width", format!("{}px", DomView::fmt(want_w)));
                    EVGElement::set_attribute(&l, "height", format!("{}px", DomView::fmt(want_h)));
                    EVGElement::set_attribute(&l, "position", "static".to_string());
                    let lay: Rc<RefCell<EVGLayout>> = Rc::new(RefCell::new(EVGLayout::new()));
                    EVGLayout::set_page_size(&lay, want_w, want_h);
                    EVGLayout::layout(&lay, Rc::clone(&l));
                    EVGElement::set_attribute(&l, "position", "absolute".to_string());
                    if DomText::index_of(&el.borrow().class_name, "horizontal") < 0 && DomText::index_of(&el.borrow().class_name, "-lr") < 0 {
                        EVGElement::set_attribute(&l, "transform-origin", format!("{}px {}px", DomView::fmt(want_h / 2.0), DomView::fmt(want_h / 2.0)));
                    }
                    if DomText::index_of(&el.borrow().class_name, "horizontal vertical-rl") > 0 {
                        EVGElement::set_attribute(&l, "transform-origin", format!("{}px {}px", DomView::fmt(want_w / 2.0), DomView::fmt(want_w / 2.0)));
                    }
                }
                DomView::settle(&l);
            }
            return;
        }
        let __it_c = el.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            DomView::settle(&c);
        }
    }
    /// what of a box's style is about its place in its parent
    pub fn placeKey(k: &str) -> bool {
        if DomText::index_of(&k, "margin-") == 0 || (DomText::index_of(&k, "flex-") == 0 || (DomText::index_of(&k, "grid-") == 0 || (DomText::index_of(&k, "min-") == 0 || DomText::index_of(&k, "max-") == 0))) {
            return true;
        }
        let __v_i: Vec<String> = vec!["position".to_string(), "top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string(), "align-self".to_string(), "justify-self".to_string(), "order".to_string(), "float".to_string(), "clear".to_string()];
        let __n_i = __v_i.len() as i64;
        for i in 0..__n_i {
            let pk = __v_i[i as usize].clone();
            if k == pk {
                return true;
            }
        }
        false
    }
    /// a grid line by number, span or auto (not a name)
    pub fn lineLike(v: &str) -> bool {
        let t: String = v.trim().to_string();
        if t == "auto" || DomText::index_of(&t, "span") == 0 {
            return true;
        }
        if t.is_empty() {
            return false;
        }
        let c: i64 = (t.as_bytes()[0 as usize] as i64);
        (c >= 48 && c <= 57) || (c == 45 || c == 43)
    }
    /// grid-column or grid-row, from its longhands when it is not there
    pub fn placeOf(s: &Rc<RefCell<JsonValue>>, n: &str) -> String {
        if s.borrow().has(n) {
            return s.borrow().getText(n);
        }
        let a: String = DomView::or(&s.borrow().getText(&format!("{}-start", n)), "auto");
        let b: String = DomView::or(&s.borrow().getText(&format!("{}-end", n)), "auto");
        if a == "auto" && b == "auto" {
            return String::new();
        }
        format!("{} / {}", a, b)
    }
    /// the column an item shares its baselines in: its first one on the
    /// start side, its last on the end side (CSS Align 9.3); a span of all
    /// the explicit columns starts at the first, other auto ones are only
    /// told apart by their grid-column
    pub fn baselineTrack(gc: &str, start_side: bool, cols: &str) -> String {
        let parts: Vec<String> = gc.split("/").map(|s| s.to_string()).collect::<Vec<String>>();
        let mut a: String = String::new();
        let mut b: String = String::new();
        if !parts.is_empty() {
            a = DomView::trimmed(&parts[0].clone());
        }
        if (parts.len() as i64) > 1 {
            b = DomView::trimmed(&parts[1].clone());
        }
        let mut span: i64 = 1;
        let mut start: i64 = 0;
        if DomView::has(&a, "span ") {
            span = DomView::intOf(&a[(5) as usize..(a.as_bytes().len() as i64) as usize].to_string());
        } else {
            if !a.is_empty() && a != "auto" {
                start = DomView::intOf(&a);
            }
        }
        if DomView::has(&b, "span ") {
            span = DomView::intOf(&b[(5) as usize..(b.as_bytes().len() as i64) as usize].to_string());
        } else {
            if start > 0 && (!b.is_empty() && b != "auto") {
                span = DomView::intOf(&b) - start;
            }
        }
        if start <= 0 {
            let mut n: i64 = 0;
            if DomText::index_of(&cols, "(") < 0 {
                let __n_wi = DomView::trimmed(cols)
                    .split(" ")
                    .map(|s| s.to_string())
                    .collect::<Vec<String>>()
                    .len() as i64;
                for wi in 0..__n_wi {
                    let w = DomView::trimmed(cols)
                        .split(" ")
                        .map(|s| s.to_string())
                        .collect::<Vec<String>>()[wi as usize].clone();
                    if !w.is_empty() {
                        n += 1;
                    }
                }
            }
            if n > 0 && span == n {
                start = 1;
            } else {
                return gc.to_string();
            }
        }
        if start_side {
            return start.to_string();
        }
        ((start + span) - 1).to_string()
    }
    /// the size of the tracks a grid-row (or -column) names in a template
    /// of pixel tracks; -1 when not known before the layout
    pub fn trackSpanPx(gc: &str, tpl: &str) -> f64 {
        let parts: Vec<String> = gc.split("/").map(|s| s.to_string()).collect::<Vec<String>>();
        let mut a: String = String::new();
        let mut b: String = String::new();
        if !parts.is_empty() {
            a = DomView::trimmed(&parts[0].clone());
        }
        if (parts.len() as i64) > 1 {
            b = DomView::trimmed(&parts[1].clone());
        }
        let start: i64 = DomView::intOf(&a);
        if start <= 0 {
            return -1.0;
        }
        let mut span: i64 = 1;
        if DomView::has(&b, "span ") {
            span = DomView::intOf(&b[(5) as usize..(b.as_bytes().len() as i64) as usize].to_string());
        } else {
            if !b.is_empty() && b != "auto" {
                span = DomView::intOf(&b) - start;
            }
        }
        if DomText::index_of(&tpl, "(") >= 0 {
            return -1.0;
        }
        let mut tracks: Vec<String> = Vec::new();
        let __n_wi = DomView::trimmed(tpl)
            .split(" ")
            .map(|s| s.to_string())
            .collect::<Vec<String>>()
            .len() as i64;
        for wi in 0..__n_wi {
            let w = DomView::trimmed(tpl)
                .split(" ")
                .map(|s| s.to_string())
                .collect::<Vec<String>>()[wi as usize].clone();
            if !w.is_empty() {
                tracks.push(w.clone());
            }
        }
        if start + span > (tracks.len() as i64) + 1 {
            return -1.0;
        }
        let mut sum: f64 = 0.0;
        let mut t: i64 = start - 1;
        while t < (start - 1) + span {
            let tw: String = tracks[t as usize].clone();
            if DomView::pxOf(&tw) <= 0.0 {
                return -1.0;
            }
            sum += DomView::pxOf(&tw);
            t += 1;
        }
        sum
    }
    pub fn intOf(v: &str) -> i64 {
        let d: Option<f64> = v.parse::<f64>().ok();
        if d.is_some() {
            return (d.unwrap()).floor() as i64;
        }
        0
    }
    /// lineMid, or with no text the middle of the first (or last) box with
    /// nothing in it, an inline block sitting on the line's central baseline
    fn boxMid(top: &Rc<RefCell<EVGElement>>, el: &Rc<RefCell<EVGElement>>, first: bool) -> f64 {
        let m: f64 = DomView::lineMid(top, el, first);
        if m >= 0.0 {
            return m;
        }
        DomView::leafMid(top, el, first)
    }
    fn leafMid(top: &Rc<RefCell<EVGElement>>, el: &Rc<RefCell<EVGElement>>, first: bool) -> f64 {
        let n: i64 = el.borrow().children.len() as i64;
        if n == 0 && (!Rc::ptr_eq(&el, &top) && el.borrow().calculated_height > 0.0) {
            return (el.borrow().calculated_y - top.borrow().calculated_y) + el.borrow().calculated_height / 2.0;
        }
        let mut i: i64 = 0;
        while i < n {
            let mut k: i64 = i;
            if !first {
                k = (n - 1) - i;
            }
            let m: f64 = DomView::leafMid(top, &Rc::clone(&el.borrow().children[k as usize]), first);
            if m >= 0.0 {
                return m;
            }
            i += 1;
        }
        -1.0
    }
    /// the middle of the first (or last) line of text in `el`, from the
    /// top of `top`; -1 with no text. A text's lines are equally tall: the
    /// one line is its height less its baselines' distance
    fn lineMid(top: &Rc<RefCell<EVGElement>>, el: &Rc<RefCell<EVGElement>>, first: bool) -> f64 {
        let n: i64 = el.borrow().children.len() as i64;
        if n == 0 && !el.borrow().text_content.is_empty() {
            let mut lh: f64 = el.borrow().calculated_height;
            if el.borrow().calculated_last_baseline > el.borrow().calculated_baseline {
                lh = el.borrow().calculated_height - (el.borrow().calculated_last_baseline - el.borrow().calculated_baseline);
            }
            if first {
                return (el.borrow().calculated_y - top.borrow().calculated_y) + lh / 2.0;
            }
            return ((el.borrow().calculated_y - top.borrow().calculated_y) + el.borrow().calculated_height) - lh / 2.0;
        }
        let mut i: i64 = 0;
        while i < n {
            let mut k: i64 = i;
            if !first {
                k = (n - 1) - i;
            }
            let m: f64 = DomView::lineMid(top, &Rc::clone(&el.borrow().children[k as usize]), first);
            if m >= 0.0 {
                return m;
            }
            i += 1;
        }
        -1.0
    }
    /// --- the page as HTML (window_view) ---------------------------------------
    ///
    /// What the window draws, as HTML: each element with its attributes and
    /// the computed style web/dom gave it (the properties that differ from
    /// their initial values) as its style attribute.
    /// the page as HTML: each element with its computed style, and where the
    /// window drew it (boxes, as the window last told the page:
    /// {"node id": [x, y, width, height, ...]}) as data-box="x,y,w,h"
    pub fn html(page: &Rc<RefCell<JsonValue>>, boxes: &Rc<RefCell<JsonValue>>) -> String {
        let root: Rc<RefCell<JsonValue>> = page.borrow().get("root");
        if root.borrow().kind != 5 {
            return String::new();
        }
        DomView::htmlOf(&root, boxes)
    }
    pub fn esc(s: &str) -> String {
        s.replace("&".to_string().as_str(), "&amp;".to_string().as_str())
            .replace("<".to_string().as_str(), "&lt;".to_string().as_str())
            .replace(">".to_string().as_str(), "&gt;".to_string().as_str())
            .replace("\"".to_string().as_str(), "&quot;".to_string().as_str())
            .clone()
    }
    pub fn htmlOf(n: &Rc<RefCell<JsonValue>>, boxes: &Rc<RefCell<JsonValue>>) -> String {
        if n.borrow().has("x") {
            return DomView::esc(&n.borrow().getText("x"));
        }
        if n.borrow().has("svg") {
            return n.borrow().getText("svg");
        }
        let t: String = n.borrow().getText("t");
        if t.is_empty() {
            return String::new();
        }
        let mut out: String = format!("<{}", t);
        let a: Rc<RefCell<JsonValue>> = n.borrow().get("a");
        let __n_i = a.borrow().keys.len() as i64;
        for i in 0..__n_i {
            let k = a.borrow().keys[i as usize].clone();
            let v: Rc<RefCell<JsonValue>> = a.borrow().items[i as usize].clone();
            if k == "caret" || (k == "sel" || k == "focused") {
                continue;
            }
            if v.borrow().kind == 1 {
                if v.borrow().b {
                    out = format!("{} {}", out, k);
                }
                continue;
            }
            out = format!("{} {}=\"{}\"", out, k, DomView::esc(&v.borrow().text()));
        }
        let bx: Rc<RefCell<JsonValue>> = boxes.borrow().get(&n.borrow().getText("i"));
        if bx.borrow().kind == 4 && (bx.borrow().items.len() as i64) >= 4 {
            out = format!("{} data-box=\"{},{},{},{}\"", out, bx.borrow().items[0].clone().borrow().text(), bx.borrow().items[1].clone().borrow().text(), bx.borrow().items[2].clone().borrow().text(), bx.borrow().items[3].clone().borrow().text());
        }
        let s: Rc<RefCell<JsonValue>> = n.borrow().get("s");
        let mut style: String = String::new();
        let __n_j = s.borrow().keys.len() as i64;
        for j in 0..__n_j {
            let sk = s.borrow().keys[j as usize].clone();
            style = format!("{}{}: {}; ", style, sk, s.borrow().items[j as usize].clone().borrow().text());
        }
        if !style.is_empty() {
            out = format!("{} style=\"{}\"", out, DomView::esc(&style.trim().to_string()));
        }
        out = format!("{}>", out);
        if t == "input" || (t == "br" || (t == "img" || t == "hr")) {
            return out;
        }
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_c = kids.borrow().items.clone();
        for c in __it_c.iter().cloned() {
            out = format!("{}{}", out, DomView::htmlOf(&c, boxes));
        }
        format!("{}</{}>", out, t)
    }
    /// a table's rows, in its row groups too (not in a table inside it)
    pub fn rowsOf(n: &Rc<RefCell<JsonValue>>) -> Vec<Rc<RefCell<JsonValue>>> {
        let mut out: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_c = kids.borrow().items.clone();
        for c in __it_c.iter().cloned() {
            let d: String = DomView::displayOf(&c);
            if d == "table-row" {
                out.push(c.clone());
            }
            if d == "table-row-group" || (d == "table-header-group" || d == "table-footer-group") {
                for r in DomView::rowsOf(&c).iter().cloned() {
                    out.push(r);
                }
            }
        }
        out
    }
    pub fn spanOf(c: &Rc<RefCell<JsonValue>>) -> i64 {
        let v: Option<i64> = c.borrow().get("a").borrow().getText("colspan").parse::<i64>().ok();
        if v.is_none() {
            return 1;
        }
        if v.unwrap() < 1 {
            return 1;
        }
        v.unwrap()
    }
    /// EVG's SVG painter draws flat colours and drops a gradient paint: a
    /// fill or stroke of url(#gradient) is drawn in the average of the
    /// gradient's stop colours instead, which keeps an illustration's shapes
    pub fn flatGradients(svg: &str) -> String {
        if DomText::index_of(&svg, "url(#") < 0 {
            return svg.to_string();
        }
        let mut out: String = svg.to_string();
        let mut from: i64 = 0;
        while true {
            let a: i64 = DomView::indexFrom(svg, "Gradient", from);
            if a < 0 {
                break;
            }
            let lt: i64 = a - 7;
            if lt < 0 || svg[(lt) as usize..(lt + 7) as usize].to_string() != "<linear" && svg[(lt) as usize..(lt + 7) as usize].to_string() != "<radial" {
                from = a + 8;
                continue;
            }
            let tag_end: i64 = DomView::indexFrom(svg, ">", a);
            let close: i64 = DomView::indexFrom(svg, "Gradient>", a + 8);
            if tag_end < 0 || close < 0 {
                break;
            }
            let id: String = DomView::attrIn(&svg[(a) as usize..(tag_end) as usize].to_string(), "id");
            let body: String = svg[(tag_end) as usize..(close) as usize].to_string();
            // the stops' colours, averaged
            let mut r: f64 = 0.0;
            let mut g: f64 = 0.0;
            let mut b: f64 = 0.0;
            let mut cnt: i64 = 0;
            let mut sp: i64 = 0;
            while true {
                let st: i64 = DomView::indexFrom(&body, "<stop", sp);
                if st < 0 {
                    break;
                }
                let se: i64 = DomView::indexFrom(&body, ">", st);
                if se < 0 {
                    break;
                }
                let mut sc: String = DomView::attrIn(&body[(st) as usize..(se) as usize].to_string(), "stop-color");
                if sc.is_empty() {
                    sc = "black".to_string();
                }
                let c: Rc<RefCell<EVGColor>> = EVGColor::parse(&sc);
                if c.borrow().is_set {
                    r += (EVGColor::red(&c)) as f64;
                    g += (EVGColor::green(&c)) as f64;
                    b += (EVGColor::blue(&c)) as f64;
                    cnt += 1;
                }
                sp = se;
            }
            if !id.is_empty() && cnt > 0 {
                let n: f64 = cnt as f64;
                let col: String = format!("rgb({},{},{})", (r / n + 0.5).floor() as i64, (g / n + 0.5).floor() as i64, (b / n + 0.5).floor() as i64);
                out = DomView::replaceAll(&out, &format!("url(#{})", id), &col);
                out = DomView::replaceAll(&out, &format!("url('#{}')", id), &col);
                out = DomView::replaceAll(&out, &format!("url(\"#{}\")", id), &col);
            }
            from = close;
        }
        out
    }
    pub fn indexFrom(s: &str, what: &str, from: i64) -> i64 {
        if from >= (s.as_bytes().len() as i64) {
            return 0 - 1;
        }
        let i: i64 = DomText::index_of(&s[(from) as usize..(s.as_bytes().len() as i64) as usize].to_string(), what);
        if i < 0 {
            return i;
        }
        i + from
    }
    /// an attribute's value in a tag's text: name="value"
    pub fn attrIn(tag: &str, name: &str) -> String {
        let mut k: i64 = DomText::index_of(&tag, &format!(" {}=\"", name));
        let mut q: String = "\"".to_string();
        if k < 0 {
            k = DomText::index_of(&tag, &format!(" {}='", name));
            q = "'".to_string();
        }
        if k < 0 {
            return String::new();
        }
        let v0: i64 = (k + (name.as_bytes().len() as i64)) + 3;
        let v1: i64 = DomView::indexFrom(tag, &q, v0);
        if v1 < 0 {
            return String::new();
        }
        tag[(v0) as usize..(v1) as usize].to_string()
    }
    pub fn replaceAll(s: &str, what: &str, with: &str) -> String {
        let mut out: String = String::new();
        let mut rest: String = s.to_string();
        while true {
            let i: i64 = DomText::index_of(&rest, what);
            if i < 0 {
                break;
            }
            out = format!("{}{}{}", out, rest[(0) as usize..(i) as usize].to_string(), with);
            rest = rest[(i + (what.as_bytes().len() as i64)) as usize..(rest.as_bytes().len() as i64) as usize].to_string();
        }
        format!("{}{}", out, rest)
    }
    /// a base64 digit's value, -1 for anything else
    pub fn b64v(c: i64) -> i64 {
        if (c >= 65 && c <= 90) {
            return c - 65;
        }
        if (c >= 97 && c <= 122) {
            return c - 71;
        }
        if (c >= 48 && c <= 57) {
            return c + 4;
        }
        if c == 43 || c == 45 {
            return 62;
        }
        if c == 47 || c == 95 {
            return 63;
        }
        0 - 1
    }
    /// the bytes of base64 text, at most `limit` of them
    pub fn b64bytes(t: &str, limit: i64) -> Vec<i64> {
        let mut out: Vec<i64> = Vec::new();
        let mut acc: i64 = 0;
        let mut bits: i64 = 0;
        let mut i: i64 = 0;
        let n: i64 = t.as_bytes().len() as i64;
        while i < n && (out.len() as i64) < limit {
            let v: i64 = DomView::b64v((t.as_bytes()[i as usize] as i64));
            if v >= 0 {
                acc = (acc * 64 + v) % 16777216;
                bits += 6;
                if bits >= 8 {
                    bits -= 8;
                    let mut sh: i64 = 1;
                    let mut k: i64 = 0;
                    while k < bits {
                        sh *= 2;
                        k += 1;
                    }
                    out.push(((acc as f64 / sh as f64).floor() as i64) % 256);
                    acc = acc % sh;
                }
            }
            i += 1;
        }
        out
    }
    /// %XX escapes decoded (an SVG in a data: URL)
    pub fn unescapeUrl(t: &str) -> String {
        let mut out: String = String::new();
        let mut i: i64 = 0;
        let n: i64 = t.as_bytes().len() as i64;
        let hex: String = "0123456789abcdef".to_string();
        while i < n {
            let c: i64 = (t.as_bytes()[i as usize] as i64);
            if c == 37 && i + 2 < n {
                let h1: i64 = DomText::index_of(&hex, &t[(i + 1) as usize..(i + 2) as usize].to_string().to_lowercase());
                let h2: i64 = DomText::index_of(&hex, &t[(i + 2) as usize..(i + 3) as usize].to_string().to_lowercase());
                if h1 >= 0 && h2 >= 0 {
                    out = format!("{}{}", out, char::from_u32((h1 * 16 + h2) as u32).unwrap_or('\0'));
                    i += 3;
                    continue;
                }
            }
            out = format!("{}{}", out, DomText::unit_at(&t, i));
            i += 1;
        }
        out
    }
    /// a number attribute of the first <svg ...> tag, 0 when it has none
    /// or it is not in px
    pub fn svgAttr(svg: &str, name: &str) -> f64 {
        let val: String = DomView::svgAttrText(svg, name);
        if DomView::pxOf(&DomView::px(&val)) > 0.0 {
            return DomView::pxOf(&DomView::px(&val));
        }
        0.0
    }
    /// an SVG document with its root's attribute set to a value
    pub fn svgRootAttr(svg: &str, name: &str, value: &str) -> String {
        let at: i64 = DomText::index_of(&svg, "<svg");
        if at < 0 {
            return svg.to_string();
        }
        let mut end: i64 = DomText::index_of_from(&svg, ">", at);
        if end < 0 {
            end = svg.as_bytes().len() as i64;
        }
        let mut tag: String = svg[(at) as usize..(end) as usize].to_string();
        let k: i64 = DomText::index_of(&tag, &format!(" {}=", name));
        if k >= 0 {
            let v: i64 = (k + (name.as_bytes().len() as i64)) + 2;
            let q: String = tag[(v as usize)..((v + 1) as usize)].to_string();
            let stop: i64 = DomText::index_of_from(&tag, &q, v + 1);
            if stop < 0 {
                return svg.to_string();
            }
            tag = format!("{}{}", tag[0..(k as usize)].to_string(), tag[((stop + 1) as usize)..tag.as_bytes().len()].to_string());
        }
        tag = format!("<svg {}=\"{}\"{}", name, value, tag[4..tag.as_bytes().len()].to_string());
        format!("{}{}{}", svg[0..(at as usize)].to_string(), tag, svg[(end as usize)..svg.as_bytes().len()].to_string())
    }
    /// whether a clip: rect(top, right, bottom, left) leaves nothing: its
    /// right not past its left or its bottom not below its top (auto
    /// edges are the box's, so they leave something)
    pub fn clipEmpty(v: &str, fs: f64) -> bool {
        let t: String = v.trim().to_string();
        if !t.starts_with("rect(") || !t.ends_with(")") {
            return false;
        }
        let inner: String = t[5..(t.as_bytes().len() - 1)].to_string().replace(",", " ");
        let mut parts: Vec<String> = Vec::new();
        for pt in inner.split(" ") {
            if !pt.trim().is_empty() {
                parts.push(pt.trim().to_string());
            }
        }
        if (parts.len() as i64) != 4 {
            return false;
        }
        let mut px: Vec<f64> = Vec::new();
        let mut auto: Vec<bool> = Vec::new();
        for pv in parts.iter().cloned() {
            let mut q: String = pv.clone();
            if q.starts_with("+") {
                q = q[1..q.as_bytes().len()].to_string();
            }
            if q == "auto" {
                px.push(0.0);
                auto.push(true);
                continue;
            }
            let mut unit_px: f64 = 1.0;
            let mut num: String = q.clone();
            for u in vec!["px".to_string(), "pt".to_string(), "pc".to_string(), "in".to_string(), "cm".to_string(), "mm".to_string(), "em".to_string(), "ex".to_string()].iter().cloned() {
                if q.ends_with(&u) {
                    num = q[0..(q.as_bytes().len() - 2)].to_string();
                    if u == "pt" {
                        unit_px = 96.0 / 72.0;
                    }
                    if u == "pc" {
                        unit_px = 16.0;
                    }
                    if u == "in" {
                        unit_px = 96.0;
                    }
                    if u == "cm" {
                        unit_px = 96.0 / 2.54;
                    }
                    if u == "mm" {
                        unit_px = 96.0 / 25.4;
                    }
                    if u == "em" {
                        unit_px = fs;
                    }
                    if u == "ex" {
                        unit_px = fs / 2.0;
                    }
                }
            }
            let d: Option<f64> = num.parse::<f64>().ok();
            if d.is_none() {
                return false;
            }
            px.push(d.unwrap() * unit_px);
            auto.push(false);
        }
        (!auto[1] && !auto[3] && px[1] <= px[3]) || (!auto[0] && !auto[2] && px[2] <= px[0])
    }
    /// an attribute of an SVG document's root as written, empty without it
    pub fn svgAttrText(svg: &str, name: &str) -> String {
        let at: i64 = DomText::index_of(&svg, "<svg");
        if at < 0 {
            return String::new();
        }
        let mut end: i64 = DomText::index_of_from(&svg, ">", at);
        if end < 0 {
            end = svg.as_bytes().len() as i64;
        }
        let tag: String = svg[(at) as usize..(end) as usize].to_string();
        let k: i64 = DomText::index_of(&tag, &format!(" {}=", name));
        if k < 0 {
            return String::new();
        }
        let v: i64 = (k + (name.as_bytes().len() as i64)) + 2;
        let q: i64 = (tag.as_bytes()[v as usize] as i64);
        let stop: i64 = DomText::index_of_from(&tag, &char::from_u32(q as u32).unwrap_or('\0').to_string(), v + 1);
        if stop < 0 {
            return String::new();
        }
        tag[(v + 1) as usize..(stop) as usize].to_string().trim().to_string()
    }
    /// whether a source is an SVG document as a data: URL
    pub fn svgUrl(src: &str) -> bool {
        let mut head: String = src.to_string();
        if head.as_bytes().len() > 32 {
            head = head[(0) as usize..(32) as usize].to_string();
        }
        head.to_lowercase().starts_with("data:image/svg+xml")
    }
    /// the SVG document of a data: URL, empty when it has none
    pub fn svgOfUrl(src: &str) -> String {
        let comma: i64 = DomText::index_of(&src, ",");
        if DomText::index_of(&src, "data:") != 0 || comma < 0 {
            return String::new();
        }
        let head: String = src[(5) as usize..(comma) as usize].to_string().to_lowercase();
        let body: String = src[(comma + 1) as usize..(src.as_bytes().len() as i64) as usize].to_string();
        let mut svg: String = String::new();
        if DomText::index_of(&head, ";base64") >= 0 {
            let sb: Vec<i64> = DomView::b64bytes(&body, 65536);
            for c in sb.iter().copied() {
                svg = format!("{}{}", svg, char::from_u32(c as u32).unwrap_or('\0'));
            }
        } else {
            svg = DomView::unescapeUrl(&body);
        }
        svg
    }
    /// a picture's own size from its data: URL (PNG, GIF, JPEG, SVG), as
    /// img.naturalWidth/naturalHeight are; empty when it is not known
    /// an SVG picture with no ratio of its own (not both of width and
    /// height, no viewBox): its width and height attributes, -1 for one
    /// left out; empty when it has a ratio or is not SVG
    pub fn svgNoRatio(src: &str) -> Vec<f64> {
        let none: Vec<f64> = Vec::new();
        if DomText::index_of(&src, "data:") != 0 || !DomView::svgUrl(src) {
            return none;
        }
        let svg: String = DomView::svgOfUrl(src);
        if DomText::index_of(&svg, "<svg") < 0 {
            return none;
        }
        let sw: f64 = DomView::svgAttr(&svg, "width");
        let sh: f64 = DomView::svgAttr(&svg, "height");
        if sw > 0.0 && sh > 0.0 {
            return none;
        }
        let vbl: Vec<String> = DomView::listOf(&DomView::svgAttrText(&svg, "viewBox"));
        if (vbl.len() as i64) == 4 {
            return none;
        }
        let mut rw: f64 = -1.0;
        let mut rh: f64 = -1.0;
        if sw > 0.0 {
            rw = sw;
        }
        if sh > 0.0 {
            rh = sh;
        }
        vec![rw, rh]
    }
    pub fn imageSize(src: &str) -> Vec<f64> {
        let none: Vec<f64> = Vec::new();
        if DomText::index_of(&src, "data:") != 0 {
            return none;
        }
        let comma: i64 = DomText::index_of(&src, ",");
        if comma < 0 {
            return none;
        }
        let head: String = src[(5) as usize..(comma) as usize].to_string().to_lowercase();
        let body: String = src[(comma + 1) as usize..(src.as_bytes().len() as i64) as usize].to_string();
        let b64: bool = DomText::index_of(&head, ";base64") >= 0;
        if DomText::index_of(&head, "svg") >= 0 {
            let svg: String = DomView::svgOfUrl(src);
            let mut sw: f64 = DomView::svgAttr(&svg, "width");
            let mut sh: f64 = DomView::svgAttr(&svg, "height");
            // (one side set: the other from the viewBox's ratio)
            let vbl: Vec<String> = DomView::listOf(&DomView::svgAttrText(&svg, "viewBox"));
            if (vbl.len() as i64) == 4 && (sw > 0.0) != (sh > 0.0) {
                let vbw: Option<f64> = vbl[2].parse::<f64>().ok();
                let vbh: Option<f64> = vbl[3].parse::<f64>().ok();
                if vbw.is_some() && vbh.is_some() && vbw.unwrap() > 0.0 && vbh.unwrap() > 0.0 {
                    if sw > 0.0 {
                        sh = (sw * vbh.unwrap()) / vbw.unwrap();
                    } else {
                        sw = (sh * vbw.unwrap()) / vbh.unwrap();
                    }
                }
            }
            if sw <= 0.0 {
                sw = 300.0;
            }
            if sh <= 0.0 {
                sh = 150.0;
            }
            return vec![sw, sh].clone();
        }
        if !b64 {
            return none;
        }
        let b: Vec<i64> = DomView::b64bytes(&body, 262144);
        let n: i64 = b.len() as i64;
        if n >= 24 && (b[0] == 137 && b[1] == 80) {
            let pw: i64 = (b[16] * 256 + b[17]) * 65536 + (b[18] * 256 + b[19]);
            let ph: i64 = (b[20] * 256 + b[21]) * 65536 + (b[22] * 256 + b[23]);
            return vec![(pw as f64), (ph as f64)].clone();
        }
        if n >= 10 && (b[0] == 71 && b[1] == 73) {
            let gw: i64 = b[6] + b[7] * 256;
            let gh: i64 = b[8] + b[9] * 256;
            return vec![(gw as f64), (gh as f64)].clone();
        }
        if n >= 4 && (b[0] == 255 && b[1] == 216) {
            let mut i: i64 = 2;
            while i + 9 < n {
                if b[i as usize] != 255 {
                    return none;
                }
                let m: i64 = b[(i + 1) as usize];
                let __len: i64 = b[(i + 2) as usize] * 256 + b[(i + 3) as usize];
                if m >= 192 && (m <= 207 && (m != 196 && (m != 200 && m != 204))) {
                    let jh: i64 = b[(i + 5) as usize] * 256 + b[(i + 6) as usize];
                    let jw: i64 = b[(i + 7) as usize] * 256 + b[(i + 8) as usize];
                    return vec![(jw as f64), (jh as f64)].clone();
                }
                i = (i + 2) + __len;
            }
        }
        none
    }
    /// a replaced box's auto size under its min- and max- sizes (0 for
    /// none), CSS 2 10.4
    pub fn constrained(w: f64, h: f64, min_w0: f64, max_w0: f64, min_h0: f64, max_h0: f64) -> Vec<f64> {
        let min_w: f64 = min_w0;
        let min_h: f64 = min_h0;
        let mut maxW: f64 = max_w0;
        let mut max_h: f64 = max_h0;
        if maxW <= 0.0 {
            maxW = 1000000000.0;
        }
        if max_h <= 0.0 {
            max_h = 1000000000.0;
        }
        if maxW < min_w {
            maxW = min_w;
        }
        if max_h < min_h {
            max_h = min_h;
        }
        let mut rw: f64 = w;
        let mut rh: f64 = h;
        let over_w: bool = w > maxW;
        let under_w: bool = w < min_w;
        let over_h: bool = h > max_h;
        let under_h: bool = h < min_h;
        if over_w && over_h {
            if maxW / w <= max_h / h {
                rw = maxW;
                rh = DomView::maxOf(min_h, (maxW * h) / w);
            } else {
                rw = DomView::maxOf(min_w, (max_h * w) / h);
                rh = max_h;
            }
            return vec![rw, rh].clone();
        }
        if under_w && under_h {
            if min_w / w <= min_h / h {
                rw = DomView::minOf(maxW, (min_h * w) / h);
                rh = min_h;
            } else {
                rw = min_w;
                rh = DomView::minOf(max_h, (min_w * h) / w);
            }
            return vec![rw, rh].clone();
        }
        if under_w && over_h {
            return vec![min_w, max_h].clone();
        }
        if over_w && under_h {
            return vec![maxW, min_h].clone();
        }
        if over_w {
            return vec![maxW, DomView::maxOf((maxW * h) / w, min_h)].clone();
        }
        if under_w {
            return vec![min_w, DomView::minOf((min_w * h) / w, max_h)].clone();
        }
        if over_h {
            return vec![DomView::maxOf((max_h * w) / h, min_w), max_h].clone();
        }
        if under_h {
            return vec![DomView::minOf((min_h * w) / h, maxW), min_h].clone();
        }
        vec![w, h].clone()
    }
    /// the numbers of a list such as a viewBox ("0 0 4 1", "0,0,4,1")
    pub fn listOf(v: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut cur: String = String::new();
        let mut i: i64 = 0;
        let n: i64 = v.as_bytes().len() as i64;
        while i < n {
            let c: i64 = (v.as_bytes()[i as usize] as i64);
            if c == 32 || (c == 44 || (c == 9 || c == 10)) {
                if !cur.is_empty() {
                    out.push(cur.clone());
                }
                cur = String::new();
            } else {
                cur = format!("{}{}", cur, DomText::unit_at(&v, i));
            }
            i += 1;
        }
        if !cur.is_empty() {
            out.push(cur.clone());
        }
        out
    }
    pub fn px(v: &str) -> String {
        if v.is_empty() {
            return String::new();
        }
        let last: i64 = (v.as_bytes()[((v.as_bytes().len() as i64) - 1) as usize] as i64);
        if (last >= 48 && last <= 57) {
            return format!("{}px", v);
        }
        v.to_string()
    }
    /// does the box start a block formatting context, which is as tall as
    /// the floats in it
    /// a box's margin-box width from px sizes, -1 when its width is not px
    pub fn outerPxW(s: &Rc<RefCell<JsonValue>>) -> f64 {
        let w: String = s.borrow().getText("width");
        if (w.as_bytes().len() as i64) < 3 || w[((w.as_bytes().len() as i64) - 2) as usize..(w.as_bytes().len() as i64) as usize].to_string() != "px" {
            return -1.0;
        }
        let mut t: f64 = DomView::pxOf(&w) + (DomView::pxOf(&s.borrow().getText("margin-left")) + DomView::pxOf(&s.borrow().getText("margin-right")));
        if s.borrow().getText("box-sizing") != "border-box" {
            t += ((DomView::pxOf(&s.borrow().getText("padding-left")) + DomView::pxOf(&s.borrow().getText("padding-right"))) + DomView::side(s, "left")) + DomView::side(s, "right");
        }
        t
    }
    /// whether a box holds only text and inline boxes in the flow, the lines
    /// that floats beside it shorten
    pub fn inlineOnly(n: &Rc<RefCell<JsonValue>>) -> bool {
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_c = kids.borrow().items.clone();
        for c in __it_c.iter().cloned() {
            if c.borrow().has("t") {
                let cs: Rc<RefCell<JsonValue>> = c.borrow().get("s");
                let cp: String = cs.borrow().getText("position");
                if cp == "absolute" || cp == "fixed" {
                    return false;
                }
                let cd: String = DomView::displayOf(&c);
                if cd != "inline" && (cd != "inline-block" && (cd != "inline-flex" && (cd != "inline-grid" && (cd != "inline-table" && c.borrow().getText("t") != "br")))) {
                    return false;
                }
                let cf: String = cs.borrow().getText("float");
                if cf == "left" || cf == "right" {
                    return false;
                }
            }
        }
        true
    }
    pub fn holdsFloats(s: &Rc<RefCell<JsonValue>>, display: &str) -> bool {
        if display == "flow-root" || (display == "inline-block" || (display == "table-cell" || display == "list-item" && false)) {
            return true;
        }
        let ov: String = s.borrow().getText("overflow-y");
        if !ov.is_empty() && ov != "visible" {
            return true;
        }
        let ox: String = s.borrow().getText("overflow-x");
        if !ox.is_empty() && ox != "visible" {
            return true;
        }
        let pos: String = s.borrow().getText("position");
        if pos == "absolute" || pos == "fixed" {
            return true;
        }
        let fl: String = s.borrow().getText("float");
        if fl == "left" || fl == "right" {
            return true;
        }
        false
    }
    /// --- margins, which EVG does not collapse ---------------------------------
    ///
    /// A block's children are an EVG column, whose margins add up; in CSS the
    /// vertical margins of blocks in a flow collapse: two siblings are as far
    /// apart as the larger margin (CSS 2.1 8.3.1), and a block's first and
    /// last child's margins go through it when nothing (padding, a border, a
    /// scroll container, a flex item's own formatting context) is between.
    /// Both are written into the elements here, children first. Only px
    /// margins collapse, and an empty block does not collapse through itself.
    fn mPx(m: Option<Rc<RefCell<EVGUnit>>>) -> f64 {
        if m.is_none() {
            return 0.0;
        }
        let u: Rc<RefCell<EVGUnit>> = m.clone().unwrap();
        if u.borrow().is_set && u.borrow().unit_type == 0 {
            return u.borrow().value;
        }
        0.0
    }
    /// a line whose strut room is in its margins, which do not collapse
    fn struck(k: &Rc<RefCell<EVGElement>>) -> bool {
        DomText::index_of(&k.borrow().class_name, "mfd-strut") >= 0
    }
    fn plain(m: Option<Rc<RefCell<EVGUnit>>>) -> bool {
        if m.is_none() {
            return true;
        }
        let u: Rc<RefCell<EVGUnit>> = m.clone().unwrap();
        return !u.borrow().is_set || u.borrow().unit_type == 0;
    }
    /// the margin two adjoining margins make: the largest positive one and
    /// the most negative one, added
    pub fn collapsed(a: f64, b: f64) -> f64 {
        let mut pos: f64 = 0.0;
        let mut neg: f64 = 0.0;
        let __n_i = vec![a, b].len() as i64;
        for i in 0..__n_i {
            let v = vec![a, b][i as usize];
            if v > pos {
                pos = v;
            }
            if v < neg {
                neg = v;
            }
        }
        pos + neg
    }
    fn inFlow(k: &Rc<RefCell<EVGElement>>) -> bool {
        return k.borrow().position != "absolute" && k.borrow().position != "fixed";
    }
    /// an empty block, whose top and bottom margins adjoin: nothing in it,
    /// no height, padding or border (CSS 2.1 8.3.1)
    fn selfCollapsing(k: &Rc<RefCell<EVGElement>>) -> bool {
        if DomText::index_of(&k.borrow().class_name, "mfd-block") < 0 || !k.borrow().text_content.is_empty() {
            return false;
        }
        // (absolute boxes in it are out of its flow)
        let __it_kc = k.borrow().children.clone();
        for kc in __it_kc.iter().cloned() {
            if DomView::inFlow(&kc) {
                return false;
            }
        }
        if !k.borrow().svg_source.is_empty() || (k.borrow().tag_name == "img" || (k.borrow().tag_name == "svg" || (k.borrow().tag_name == "input" || k.borrow().tag_name == "textarea"))) {
            return false;
        }
        let mut _tmp_1 = k.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone();
        if !DomView::plain(_tmp_1) || !DomView::plain(k.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) {
            return false;
        }
        let mut _tmp_3 = k.borrow().height.clone();
        let mut _tmp_4 = k.borrow().min_height.clone();
        if k.borrow()
            .height.as_ref()
            .unwrap()
            .borrow()
            .is_set && DomView::mPx(_tmp_3) != 0.0 || k.borrow()
            .min_height.as_ref()
            .unwrap()
            .borrow()
            .is_set && DomView::mPx(_tmp_4) != 0.0 {
            return false;
        }
        let mut _tmp_5 = k.borrow().r#box.as_ref().unwrap().borrow().padding_top.clone();
        let mut _tmp_6 = k.borrow().r#box.as_ref().unwrap().borrow().padding_bottom.clone();
        if DomView::mPx(_tmp_5) != 0.0 || (DomView::mPx(_tmp_6) != 0.0 || DomView::mPx(k.borrow().r#box.as_ref().unwrap().borrow().border_width.clone()) != 0.0) {
            return false;
        }
        true
    }
    /// the margins that adjoin in a flow collapse to one: between two
    /// siblings, and through the empty blocks between them, as one chain
    /// (the largest positive margin and the most negative, added); the
    /// chain before the first box with something in it is on the first
    /// one of all, which collapseThrough joins with the parent's
    fn collapseSiblings(e: &Rc<RefCell<EVGElement>>) {
        let mut lead: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut leading: bool = true;
        let mut pos: f64 = 0.0;
        let mut neg: f64 = 0.0;
        let mut placed: f64 = 0.0;
        let mut chained: bool = false;
        let __it_k = e.borrow().children.clone();
        for k in __it_k.iter().cloned() {
            if !DomView::inFlow(&k) {
                continue;
            }
            let mut _tmp_1 = k.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone();
            let plain_k: bool = (DomView::plain(_tmp_1) && DomView::plain(k.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone())) && !DomView::struck(&k);
            let t: f64 = DomView::mPx(k.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone());
            let b: f64 = DomView::mPx(k.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone());
            let empty: bool = DomView::selfCollapsing(&k);
            if leading {
                if !plain_k {
                    leading = false;
                    lead.clear();
                    chained = false;
                    if DomView::plain(k.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) {
                        pos = DomView::maxOf(b, 0.0);
                        neg = 0.0 - DomView::maxOf(0.0 - b, 0.0);
                        placed = b;
                        chained = true;
                    }
                    continue;
                }
                lead.push(Rc::clone(&k));
                pos = DomView::maxOf(pos, t);
                if t < neg {
                    neg = t;
                }
                if empty {
                    pos = DomView::maxOf(pos, b);
                    if b < neg {
                        neg = b;
                    }
                    continue;
                }
                // (the run's margins on its first box)
                if (lead.len() as i64) > 1 {
                    let __n_li = lead.len() as i64;
                    for li in 0..__n_li {
                        let lk = Rc::clone(&lead[li as usize]);
                        if li == 0 {
                            EVGElement::set_attribute(
                                &lk,
                                "margin-top",
                                format!("{}px", DomView::fmt(pos + neg))
                            );
                        } else {
                            EVGElement::set_attribute(&lk, "margin-top", "0px".to_string());
                        }
                        if !Rc::ptr_eq(&lk, &k) {
                            EVGElement::set_attribute(&lk, "margin-bottom", "0px".to_string());
                        }
                    }
                }
                leading = false;
                pos = DomView::maxOf(b, 0.0);
                neg = 0.0 - DomView::maxOf(0.0 - b, 0.0);
                placed = b;
                chained = true;
                continue;
            }
            if !plain_k || !chained {
                chained = false;
                if DomView::plain(k.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) {
                    pos = DomView::maxOf(b, 0.0);
                    neg = 0.0 - DomView::maxOf(0.0 - b, 0.0);
                    placed = b;
                    chained = true;
                }
                continue;
            }
            pos = DomView::maxOf(pos, t);
            if t < neg {
                neg = t;
            }
            let top: f64 = (pos + neg) - placed;
            if top != t {
                EVGElement::set_attribute(&k, "margin-top", format!("{}px", DomView::fmt(top)));
            }
            placed += top;
            if empty {
                pos = DomView::maxOf(pos, b);
                if b < neg {
                    neg = b;
                }
                if b != 0.0 {
                    EVGElement::set_attribute(&k, "margin-bottom", "0px".to_string());
                }
                continue;
            }
            pos = DomView::maxOf(b, 0.0);
            neg = 0.0 - DomView::maxOf(0.0 - b, 0.0);
            placed = b;
        }
        // (a run of empty blocks alone: its margins on the first)
        if leading && (lead.len() as i64) > 1 {
            let __n_lj = lead.len() as i64;
            for lj in 0..__n_lj {
                let lk2 = Rc::clone(&lead[lj as usize]);
                if lj == 0 {
                    EVGElement::set_attribute(
                        &lk2,
                        "margin-top",
                        format!("{}px", DomView::fmt(pos + neg))
                    );
                } else {
                    EVGElement::set_attribute(&lk2, "margin-top", "0px".to_string());
                }
                EVGElement::set_attribute(&lk2, "margin-bottom", "0px".to_string());
            }
        }
        if leading && (lead.len() as i64) == 1 {
            let only: Rc<RefCell<EVGElement>> = Rc::clone(&lead[0]);
            if DomView::selfCollapsing(&only) {
                EVGElement::set_attribute(&only, "margin-top", format!("{}px", DomView::fmt(pos + neg)));
                EVGElement::set_attribute(&only, "margin-bottom", "0px".to_string());
            }
        }
    }
    /// is there text anywhere in the box
    /// (a flex container in a box, as its content: the box has the flex
    /// container's baseline)
    fn flexInside(el: &Rc<RefCell<EVGElement>>) -> bool {
        let __it_c = el.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            let mut __re_gx1: Rc<RefCell<EVGCssExtra>> = EVGLayoutFull::cx(Rc::clone(&c));
            if __re_gx1.borrow().flex_box && !c.borrow().children.is_empty() || DomView::flexInside(&c) {
                return true;
            }
        }
        false
    }
    fn hasText(el: &Rc<RefCell<EVGElement>>) -> bool {
        if !el.borrow().text_content.is_empty() {
            return true;
        }
        let __it_c = el.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            if DomView::hasText(&c) {
                return true;
            }
        }
        false
    }
    /// a text element, or a word of pieces
    fn textual(el: &Rc<RefCell<EVGElement>>) -> bool {
        if !el.borrow().text_content.is_empty() {
            return true;
        }
        let n: i64 = el.borrow().children.len() as i64;
        if n == 0 || el.borrow().tag_name == "svg" {
            return false;
        }
        // (a word is a row of its pieces; a block of text, an inline-block,
        // is a box on the line)
        if el.borrow().flex_direction != "row" {
            return false;
        }
        let __it_c = el.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            if c.borrow().text_content.is_empty() {
                return false;
            }
        }
        true
    }
    /// how far under the baseline the block's font reaches (rounded, as
    /// Chromium has it)
    pub fn descent(inh: &Rc<RefCell<JsonValue>>) -> f64 {
        let mut fs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
        if fs == 0.0 && inh.borrow().getText("font-size") != "0px" {
            fs = 16.0;
        }
        let d: f64 = DomView::descentEm(&DomView::faceOf(&inh.borrow().getText("font-family"), "")[0].clone());
        let lh: f64 = DomView::lineHeight(inh);
        // the half-leading a line-height other than normal adds
        let half: f64 = (lh - DomView::normalLine(inh, fs)) / 2.0;
        (((fs * d + 0.5).floor() as i64) as f64) + half
    }
    /// text-align as left, center or right ("start" is right to left
    /// on the right)
    pub fn alignOf(inh: &Rc<RefCell<JsonValue>>) -> String {
        let ta: String = inh.borrow().getText("text-align");
        let rtl: bool = inh.borrow().getText("direction") == "rtl";
        if ta == "center" || (ta == "justify" || (ta == "left" || ta == "right")) {
            return ta;
        }
        if ta == "end" {
            if rtl {
                return "left".to_string();
            }
            return "right".to_string();
        }
        if rtl {
            return "right".to_string();
        }
        String::new()
    }
    /// a row the items of a line go into: wrapping, as text-align places them
    fn lineRow(inh: &Rc<RefCell<JsonValue>>) -> Rc<RefCell<EVGElement>> {
        let row: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        EVGElement::set_attribute(&row, "display", "flex".to_string());
        EVGElement::set_attribute(&row, "flex-direction", "row".to_string());
        EVGElement::set_attribute(&row, "align-items", "center".to_string());
        let ta: String = DomView::alignOf(inh);
        if ta == "center" {
            EVGElement::set_attribute(&row, "justify-content", "center".to_string());
        }
        if ta == "right" || ta == "end" {
            EVGElement::set_attribute(&row, "justify-content", "flex-end".to_string());
        }

        // a line that does not wrap (nowrap, pre) is one row
        let ws: String = inh.borrow().getText("white-space");
        if ws == "nowrap" || ws == "pre" {
            EVGElement::set_attribute(&row, "flex-wrap", "nowrap".to_string());
        } else {
            EVGElement::set_attribute(&row, "flex-wrap", "wrap".to_string());
        }
        row
    }
    /// the white space at the start and the end of a line is not drawn
    fn trimEnds(row: &Rc<RefCell<EVGElement>>) {
        let n: i64 = row.borrow().children.len() as i64;
        if n == 0 {
            return;
        }
        DomView::trimText(&Rc::clone(&row.borrow().children[0]), true);
        DomView::trimText(&Rc::clone(&row.borrow().children[(n - 1) as usize]), false);
    }
    fn trimText(el: &Rc<RefCell<EVGElement>>, start: bool) {
        if !el.borrow().text_content.is_empty() {
            let t: String = el.borrow().text_content.clone();
            let mut a: i64 = 0;
            let mut b: i64 = t.as_bytes().len() as i64;
            if start {
                while a < b && (t.as_bytes()[a as usize] as i64) == 32 {
                    a += 1;
                }
            } else {
                while b > a && (t.as_bytes()[(b - 1) as usize] as i64) == 32 {
                    b -= 1;
                }
            }
            el.borrow_mut().text_content = t[(a) as usize..(b) as usize].to_string();
            return;
        }
        // a word made of pieces
        let n: i64 = el.borrow().children.len() as i64;
        if n > 0 && (el.borrow().tag_name != "svg" && el.borrow().svg_source.is_empty()) {
            if start {
                DomView::trimText(&Rc::clone(&el.borrow().children[0]), true);
            } else {
                DomView::trimText(&Rc::clone(&el.borrow().children[(n - 1) as usize]), false);
            }
        }
    }
    pub fn white(c: i64) -> bool {
        c == 32 || (c == 10 || (c == 9 || c == 13))
    }
    /// the width of a space of the block's face: the gap between words
    pub fn spaceWidth(inh: &Rc<RefCell<JsonValue>>) -> f64 {
        let mut fs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
        if fs == 0.0 && inh.borrow().getText("font-size") != "0px" {
            fs = 16.0;
        }
        let face: String = DomView::faceOf(&inh.borrow().getText("font-family"), "")[0].clone();
        // (word-spacing is added to each space, CSS Text 3 8.2)
        let ws: f64 = DomView::pxOf(&inh.borrow().getText("word-spacing"));
        if (DomView::has(&face, "Figtree")) {
            return fs * 0.247 + ws;
        }
        if face == "Ahem" {
            return fs + ws;
        }
        // (every glyph of the monospace face is 1233/2048 em wide)
        if face == "DejaVu Sans Mono" {
            return fs * 0.60205 + ws;
        }
        fs * 0.2598 + ws
    }
    /// --- after layout -------------------------------------------------------------
    /// --- the focused field's caret and selection ----------------------------------
    /// an input that holds text, or a textarea (its node in the page)
    pub fn textField(n: &Rc<RefCell<JsonValue>>) -> bool {
        let t: String = n.borrow().getText("t");
        if t == "textarea" {
            return true;
        }
        if t != "input" {
            return false;
        }
        let ty: String = n.borrow().get("a").borrow().getText("type");
        ty.is_empty() || (ty == "text" || (ty == "search" || (ty == "email" || (ty == "url" || (ty == "tel" || (ty == "password" || ty == "number"))))))
    }
    /// [left, top, right, bottom] of the box's content on the page
    pub(crate) fn inner(e: &Rc<RefCell<EVGElement>>) -> Vec<f64> {
        let bw: f64 = e.borrow().r#box.as_ref().unwrap().borrow().border_width_px;
        let mut out: Vec<f64> = Vec::new();
        out.push((e.borrow().calculated_x + bw) + e.borrow().r#box.as_ref().unwrap().borrow().padding_left_px);
        out.push((e.borrow().calculated_y + bw) + e.borrow().r#box.as_ref().unwrap().borrow().padding_top_px);
        out.push((e.borrow().calculated_x + e.borrow().calculated_width) - (bw + e.borrow().r#box.as_ref().unwrap().borrow().padding_right_px));
        out.push((e.borrow().calculated_y + e.borrow().calculated_height) - (bw + e.borrow().r#box.as_ref().unwrap().borrow().padding_bottom_px));
        out
    }
    /// the text's size in the field: [width of its widest line, height]
    pub(crate) fn contentSize(eng: &Rc<RefCell<EVGTextEngine>>, e: &Rc<RefCell<EVGElement>>) -> Vec<f64> {
        let t: Rc<RefCell<EVGElement>> = DomView::fieldText(e);
        let lines: Vec<Rc<RefCell<EVGTextLine>>> = DomView::linesOf(eng, &t, &e.borrow().a11y_value.clone());
        let mut w: f64 = 0.0;
        for ln in lines.iter().cloned() {
            let mut _tmp_1 = ln.borrow().text.clone();
            let mut _tmp_2 = t.borrow().letter_spacing.clone();
            let m: Rc<RefCell<EVGTextMetrics>> = EVGTextEngine::measure_run_spaced(
                &eng,
                &_tmp_1,
                &EVGElement::effective_font_family(&t),
                DomView::fontSizeOf(&t),
                _tmp_2
            );
            if m.borrow().width > w {
                w = m.borrow().width;
            }
        }
        let mut out: Vec<f64> = Vec::new();
        out.push(w + 1.0);
        out.push(((lines.len() as i64) as f64) * DomView::lineBoxOf(eng, &t));
        out
    }
    /// the element a field draws its text in (not its caret or a band)
    pub(crate) fn fieldText(e: &Rc<RefCell<EVGElement>>) -> Rc<RefCell<EVGElement>> {
        let __it_c = e.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            if c.borrow().class_name != "mfd-dcaret" && c.borrow().class_name != "mfd-dsel" {
                return c;
            }
        }
        e.clone()
    }
    fn fontSizeOf(t: &Rc<RefCell<EVGElement>>) -> f64 {
        let mut fs: f64 = t.borrow().inherited_font_size;
        if t.borrow().font_size.as_ref().unwrap().borrow().is_set {
            fs = t.borrow().font_size.as_ref().unwrap().borrow().pixels;
        }
        if fs <= 0.0 {
            fs = 14.0;
        }
        fs
    }
    /// the height of a line, as EVGDisplayList draws the text's lines
    fn lineBoxOf(eng: &Rc<RefCell<EVGTextEngine>>, t: &Rc<RefCell<EVGElement>>) -> f64 {
        let fs: f64 = DomView::fontSizeOf(t);
        let mut lb: f64 = EVGElement::line_box_for(&t, fs, EVGTextEngine::line_height_for(&eng, &EVGElement::effective_font_family(&t), fs));
        if lb <= 0.0 {
            lb = fs * 1.2;
        }
        lb
    }
    /// the lines `text` breaks into in the field's text element (the same
    /// call and width EVGDisplayList draws with)
    pub(crate) fn linesOf(eng: &Rc<RefCell<EVGTextEngine>>, t: &Rc<RefCell<EVGElement>>, text: &str) -> Vec<Rc<RefCell<EVGTextLine>>> {
        let _tmp_1 = EVGBox::get_inner_width(&t.borrow().r#box.as_ref().unwrap(), t.borrow().calculated_width);
        let wrap: f64 = EVGElement::wrap_width(&t, _tmp_1);
        let mut _tmp_3 = t.borrow().letter_spacing.clone();
        return EVGTextEngine::break_lines_spaced(
            &eng,
            text,
            &EVGElement::effective_font_family(&t),
            DomView::fontSizeOf(t),
            wrap,
            _tmp_3
        ).clone();
    }
    /// [x, y, height] of the caret after `prefix`, on the page
    pub(crate) fn caretAt(eng: &Rc<RefCell<EVGTextEngine>>, e: &Rc<RefCell<EVGElement>>, prefix: &str) -> Vec<f64> {
        let t: Rc<RefCell<EVGElement>> = DomView::fieldText(e);
        let lines: Vec<Rc<RefCell<EVGTextLine>>> = DomView::linesOf(eng, &t, prefix);
        let n: i64 = lines.len() as i64;
        let last: Rc<RefCell<EVGTextLine>> = Rc::clone(&lines[(n - 1) as usize]);
        let mut _tmp_1 = last.borrow().text.clone();
        let mut _tmp_2 = t.borrow().letter_spacing.clone();
        let m: Rc<RefCell<EVGTextMetrics>> = EVGTextEngine::measure_run_spaced(
            &eng,
            &_tmp_1,
            &EVGElement::effective_font_family(&t),
            DomView::fontSizeOf(&t),
            _tmp_2
        );
        let bw: f64 = t.borrow().r#box.as_ref().unwrap().borrow().border_width_px;
        let lb: f64 = DomView::lineBoxOf(eng, &t);
        let x: f64 = ((t.borrow().calculated_x + bw) + t.borrow().r#box.as_ref().unwrap().borrow().padding_left_px) + m.borrow().width;
        let y: f64 = (((t.borrow().calculated_y + bw) + t.borrow().r#box.as_ref().unwrap().borrow().padding_top_px) + t.borrow().text_shift_y) + ((n - 1) as f64) * lb;
        let mut out: Vec<f64> = Vec::new();
        out.push(x);
        out.push(y);
        out.push(lb);
        out
    }
    /// the text of the field before the point (x, y) on the page: where a
    /// click puts the caret
    pub(crate) fn prefixAt(eng: &Rc<RefCell<EVGTextEngine>>, e: &Rc<RefCell<EVGElement>>, x: f64, y: f64) -> String {
        let text: String = e.borrow().a11y_value.clone();
        if text.is_empty() {
            return String::new();
        }
        let t: Rc<RefCell<EVGElement>> = DomView::fieldText(e);
        let face: String = EVGElement::effective_font_family(&t);
        let fs: f64 = DomView::fontSizeOf(&t);
        let lines: Vec<Rc<RefCell<EVGTextLine>>> = DomView::linesOf(eng, &t, &text);
        let bw: f64 = t.borrow().r#box.as_ref().unwrap().borrow().border_width_px;
        let lb: f64 = DomView::lineBoxOf(eng, &t);
        let top: f64 = ((t.borrow().calculated_y + bw) + t.borrow().r#box.as_ref().unwrap().borrow().padding_top_px) + t.borrow().text_shift_y;
        let mut li: i64 = 0;
        if y > top {
            li = ((y - top) / lb).floor() as i64;
        }
        if li >= (lines.len() as i64) {
            li = (lines.len() as i64) - 1;
        }
        // the code points before the line: each line broke at one space or
        // line feed
        let mut start: i64 = 0;
        let mut k: i64 = 0;
        while k < li {
            let ln: Rc<RefCell<EVGTextLine>> = Rc::clone(&lines[k as usize]);
            start += (EVGCodepoint::to_array(&ln.borrow().text).len() as i64) + 1;
            k += 1;
        }
        let line: Rc<RefCell<EVGTextLine>> = Rc::clone(&lines[li as usize]);
        let cps: Vec<i64> = EVGCodepoint::to_array(&line.borrow().text.clone());
        let dx: f64 = x - ((t.borrow().calculated_x + bw) + t.borrow().r#box.as_ref().unwrap().borrow().padding_left_px);
        // the nearest boundary between characters
        let mut c: i64 = 0;
        let mut prevW: f64 = 0.0;
        let mut done: bool = false;
        while !done && c < (cps.len() as i64) {
            let w: f64 = EVGTextEngine::measure_run_spaced(&eng, &EVGTextEngine::cp_slice(&cps, c + 1), &face, fs, t.borrow().letter_spacing.clone())
                .borrow()
                .width;
            if w > dx {
                if dx - prevW > w - dx {
                    c += 1;
                }
                done = true;
            } else {
                prevW = w;
                c += 1;
            }
        }
        let all: Vec<i64> = EVGCodepoint::to_array(&text);
        let mut n: i64 = start + c;
        if n > (all.len() as i64) {
            n = all.len() as i64;
        }
        EVGTextEngine::cp_slice(&all, n)
    }
    /// an element placed after layout paints where its box is (the display
    /// list culls by these bounds)
    fn painted(el: &Rc<RefCell<EVGElement>>) {
        let rhs_2 = el.borrow().calculated_x;
        el.borrow_mut().paint_left = rhs_2;
        let _tmp_2 = el.borrow().calculated_y;
        el.borrow_mut().paint_top = _tmp_2;
        let rhs_3 = el.borrow().calculated_x + el.borrow().calculated_width;
        el.borrow_mut().paint_right = rhs_3;
        let rhs_4 = el.borrow().calculated_y + el.borrow().calculated_height;
        el.borrow_mut().paint_bottom = rhs_4;
    }
    /// a band of the selection
    fn band(x: f64, y: f64, w: f64, h: f64) -> Rc<RefCell<EVGElement>> {
        let b: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        b.borrow_mut().class_name = "mfd-dsel".to_string();
        let _tmp_1 = EVGColor::rgb(180, 213, 254);
        b.borrow_mut().background_color = Some(_tmp_1);
        b.borrow_mut().calculated_x = x;
        b.borrow_mut().calculated_y = y;
        b.borrow_mut().calculated_width = w;
        b.borrow_mut().calculated_height = h;
        DomView::painted(&b);
        b
    }
    /// the caret, or the selection's bands, over the laid out field `e`
    /// (field: its node in the page); the caret element, or e when the
    /// selection is not empty (no caret then, as in a browser)
    pub(crate) fn decorate(eng: &Rc<RefCell<EVGTextEngine>>, e: &Rc<RefCell<EVGElement>>, field: &Rc<RefCell<JsonValue>>) -> Rc<RefCell<EVGElement>> {
        let a: Rc<RefCell<JsonValue>> = field.borrow().get("a");
        let t: Rc<RefCell<EVGElement>> = DomView::fieldText(e);
        let mut kids: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let sel: Rc<RefCell<JsonValue>> = a.borrow().get("sel");
        let selected: bool = sel.borrow().kind == 4 && (sel.borrow().items.len() as i64) == 2;
        if selected {
            let p0: Vec<f64> = DomView::caretAt(
                eng,
                e,
                &sel.borrow().items[0].clone().borrow().text()
            );
            let p1: Vec<f64> = DomView::caretAt(
                eng,
                e,
                &sel.borrow().items[1].clone().borrow().text()
            );
            let x0: f64 = p0[0];
            let y0: f64 = p0[1];
            let lb: f64 = p0[2];
            let x1: f64 = p1[0];
            let y1: f64 = p1[1];
            let bw: f64 = t.borrow().r#box.as_ref().unwrap().borrow().border_width_px;
            let left: f64 = (t.borrow().calculated_x + bw) + t.borrow()
                .r#box.as_ref()
                .unwrap()
                .borrow()
                .padding_left_px;
            let right: f64 = left + EVGBox::get_inner_width(&t.borrow().r#box.as_ref().unwrap(), t.borrow().calculated_width.clone());
            if y1 - y0 < lb / 2.0 {
                kids.push(DomView::band(x0, y0, x1 - x0, lb));
            } else {
                // the first line to its end, the lines between, the last
                // from its start
                kids.push(DomView::band(x0, y0, right - x0, lb));
                let mut y: f64 = y0 + lb;
                while y < y1 - lb / 2.0 {
                    kids.push(DomView::band(left, y, right - left, lb));
                    y += lb;
                }
                kids.push(DomView::band(left, y1, x1 - left, lb));
            }
        }
        let __it_c = e.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            // (not the selection and caret a kept field had last frame)
            let cc: String = c.borrow().class_name.clone();
            if cc != "mfd-dsel" && cc != "mfd-dcaret" {
                kids.push(Rc::clone(&c));
            }
        }
        let mut out: Rc<RefCell<EVGElement>> = Rc::clone(&e);
        if !selected {
            let p: Vec<f64> = DomView::caretAt(eng, e, &a.borrow().getText("caret"));
            let caret: Rc<RefCell<EVGElement>> = EVGElement::create_div();
            caret.borrow_mut().class_name = "mfd-dcaret".to_string();
            // the field's own color (caret-color: auto), not its placeholder's
            caret.borrow_mut().background_color = Some(EVGColor::rgb(0, 0, 0));
            let fc: String = field.borrow().get("s").borrow().getText("color");
            if !fc.is_empty() {
                caret.borrow_mut().background_color = Some(EVGColor::parse(&fc));
            }
            caret.borrow_mut().calculated_x = p[0];
            caret.borrow_mut().calculated_y = p[1];
            caret.borrow_mut().calculated_width = 1.0;
            caret.borrow_mut().calculated_height = p[2];
            DomView::painted(&caret);
            kids.push(Rc::clone(&caret));
            out = Rc::clone(&caret);
        }
        e.borrow_mut().children = kids.clone();
        out
    }
    /// the page's focused text field (its "a" has the caret), or a value that
    /// is not an object; the window draws its caret and selection over it
    pub fn focusedField(n: &Rc<RefCell<JsonValue>>) -> Rc<RefCell<JsonValue>> {
        if n.borrow().kind != 5 {
            return Rc::new(RefCell::new(JsonValue::new()));
        }
        let a: Rc<RefCell<JsonValue>> = n.borrow().get("a");
        if a.borrow().kind == 5 && a.borrow().has("caret") {
            return n.clone();
        }
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_k = kids.borrow().items.clone();
        for k in __it_k.iter().cloned() {
            let f: Rc<RefCell<JsonValue>> = DomView::focusedField(&k);
            if f.borrow().kind == 5 {
                return f;
            }
        }
        Rc::new(RefCell::new(JsonValue::new()))
    }
    /// where the page's elements are, relative to its box: the
    /// {"<node>": [x, y, w, h]} of web/dom's __layout
    /// (a node drawn as several elements, a span's words, has the box
    /// around them all, as getBoundingClientRect gives it)
    #[doc(hidden)]
    pub fn boxes(r#box: &Rc<RefCell<EVGElement>>, index: i64) -> String {
        let pfx: String = format!("mfd-xd-{}-", index);
        let acc: Rc<RefCell<DomBoxes>> = Rc::new(RefCell::new(DomBoxes::new()));
        // where the boxes are in the page: the page's own scroll (the
        // root's, build) is taken back out, as web/dom subtracts it
        let _tmp_1 = r#box.borrow().calculated_x - r#box.borrow().scroll_left;
        DomView::collect(r#box, &pfx, _tmp_1, r#box.borrow().calculated_y - r#box.borrow().scroll_top, &acc);
        let mut out: String = String::new();
        let __n_i = acc.borrow().ids.len() as i64;
        for i in 0..__n_i {
            let id = acc.borrow().ids[i as usize].clone();
            if i > 0 {
                out = format!("{},", out);
            }
            let x0: f64 = acc.borrow().x0[i as usize];
            let y0: f64 = acc.borrow().y0[i as usize];
            let mut more: String = String::new();
            if acc.borrow().scroll.contains_key(&id) {
                more = acc.borrow().scroll.get(&id).cloned().unwrap();
            }
            out = format!("{}\"{}\":[{},{},{},{}{}]", out, id, DomView::num(x0), DomView::num(y0), DomView::num(acc.borrow().x1[i as usize] - x0), DomView::num(acc.borrow().y1[i as usize] - y0), more);
        }
        format!("{}{}{}", "{".to_string(), out, "}".to_string())
    }
    /// an element's transform as a frame: about its origin (CSS's default 50%
    /// 50%), turned, scaled (the y axis flipped for a mirror), then shifted
    fn ownFrame(el: &Rc<RefCell<EVGElement>>) -> Rc<RefCell<DomFrame>> {
        let sc: f64 = el.borrow().scale;
        let mut scy: f64 = sc;
        if el.borrow().flip_y {
            scy = 0.0 - sc;
        }
        if (el.borrow().rotate == 0.0 && ((sc - 1.0).abs()) < 0.000001) && !el.borrow().flip_y {
            let mut _tmp_1 = el.borrow().translate_x.clone();
            return DomFrame::shift(_tmp_1, el.borrow().translate_y.clone());
        }
        let mut _tmp_1 = Rc::clone(&el.borrow().transform_origin_x);
        let ox: f64 = el.borrow().calculated_x + EVGElement::resolve_origin(&_tmp_1, el.borrow().calculated_width.clone());
        let mut _tmp_3 = Rc::clone(&el.borrow().transform_origin_y);
        let oy: f64 = el.borrow().calculated_y + EVGElement::resolve_origin(&_tmp_3, el.borrow().calculated_height.clone());
        let rad: f64 = (el.borrow().rotate * 3.14159265358979) / 180.0;
        let cs: f64 = rad.cos();
        let sn: f64 = rad.sin();
        let m: Rc<RefCell<DomFrame>> = Rc::new(RefCell::new(DomFrame::new()));
        m.borrow_mut().a = cs * sc;
        m.borrow_mut().b = 0.0 - sn * scy;
        m.borrow_mut().d = sn * sc;
        m.borrow_mut().e = cs * scy;
        let rhs_5 = ((ox + el.borrow().translate_x) - m.borrow().a * ox) - m.borrow().b * oy;
        m.borrow_mut().c = rhs_5;
        let rhs_6 = ((oy + el.borrow().translate_y) - m.borrow().d * ox) - m.borrow().e * oy;
        m.borrow_mut().f = rhs_6;
        m
    }
    fn collect(el: &Rc<RefCell<EVGElement>>, pfx: &str, ox: f64, oy: f64, acc: &Rc<RefCell<DomBoxes>>) {
        DomView::collectIn(el, pfx, &DomFrame::shift(0.0 - ox, 0.0 - oy), acc);
    }
    /// the boxes under el, fr taking el's frame to the page's
    fn collectIn(el: &Rc<RefCell<EVGElement>>, pfx: &str, fr: &Rc<RefCell<DomFrame>>, acc: &Rc<RefCell<DomBoxes>>) {
        // the element's own transform (translate, scale, rotate about its
        // transform-origin, as EVG paints it) moves its box and what is inside
        // (a box turned for painting by its writing mode, orthogonal: its
        // frame is turned by the mfd-wm box above already)
        let mut kf: Rc<RefCell<DomFrame>> = Rc::clone(fr);
        if DomText::index_of(&el.borrow().class_name, "mfd-qt") < 0 {
            kf = fr.borrow().then(&DomView::ownFrame(el));
        }
        if DomView::has(&el.borrow().id.clone(), pfx) {
            let x: f64 = el.borrow().calculated_x;
            let y: f64 = el.borrow().calculated_y;
            let w: f64 = el.borrow().calculated_width;
            let h: f64 = el.borrow().calculated_height;
            let nid: String = (el.borrow().id)[(pfx.as_bytes().len() as i64) as usize..((el.borrow().id.as_bytes().len() as i64)) as usize].to_string();
            // the bounds of the four corners
            let _tmp_1 = DomView::minOf(kf.borrow().mapX(x, y), kf.borrow().mapX(x + w, y));
            let ax: f64 = DomView::minOf(_tmp_1, DomView::minOf(kf.borrow().mapX(x, y + h), kf.borrow().mapX(x + w, y + h)));
            let _tmp_3 = DomView::maxOf(kf.borrow().mapX(x, y), kf.borrow().mapX(x + w, y));
            let bx: f64 = DomView::maxOf(_tmp_3, DomView::maxOf(kf.borrow().mapX(x, y + h), kf.borrow().mapX(x + w, y + h)));
            let _tmp_5 = DomView::minOf(kf.borrow().mapY(x, y), kf.borrow().mapY(x + w, y));
            let ay: f64 = DomView::minOf(_tmp_5, DomView::minOf(kf.borrow().mapY(x, y + h), kf.borrow().mapY(x + w, y + h)));
            let _tmp_7 = DomView::maxOf(kf.borrow().mapY(x, y), kf.borrow().mapY(x + w, y));
            let by: f64 = DomView::maxOf(_tmp_7, DomView::maxOf(kf.borrow().mapY(x, y + h), kf.borrow().mapY(x + w, y + h)));
            // scaled or turned (a zoomed React Flow viewport): the box below
            // is where it is drawn, and its own sizes (clientWidth,
            // offsetWidth...) stay the laid-out ones, so they go too:
            // client and scroll sizes, then the border box's width and height
            let turned: bool = (((kf.borrow().a - 1.0).abs()) > 0.000001 || ((kf.borrow().b).abs()) > 0.000001) || (((kf.borrow().d).abs()) > 0.000001 || ((kf.borrow().e - 1.0).abs()) > 0.000001);
            if turned {
                acc.borrow_mut().add(&nid, ax, ay, bx, by);
            } else {
                // whole pixels elsewhere: a page's sizes stay as they were
                // (a responsive Chart.js chart sized by a fractional box
                // stopped animating)
                acc.borrow_mut().add(&nid, DomView::whole(ax), DomView::whole(ay), DomView::whole(bx), DomView::whole(by));
            }
            if el.borrow()
                .scroll_height > EVGElement::client_height(&el) + 0.5 || el.borrow()
                .scroll_width > EVGElement::client_width(&el) + 0.5 {
                // what scrolls: its client and scroll sizes (scrollHeight...)
                let mut _tmp_1 = el.borrow().scroll_width.clone();
                let mut sz: String = format!(",{},{},{},{}", DomView::num(EVGElement::client_width(&el)), DomView::num(EVGElement::client_height(&el)), DomView::num(_tmp_1), DomView::num(el.borrow().scroll_height.clone()));
                if turned {
                    sz = format!("{},{},{}", sz, DomView::num(w), DomView::num(h));
                }
                acc.borrow_mut().scroll.insert(nid.clone(), sz.clone());
            } else {
                if turned {
                    let ws: String = DomView::num(w);
                    let hs: String = DomView::num(h);
                    acc.borrow_mut().scroll.insert(nid.clone(), format!(",{},{},{},{},{},{}", ws, hs, ws, hs, ws, hs));
                }
            }
        }
        // a vertical box in the other vertical mode: turned over
        if DomText::index_of(&el.borrow().class_name, "mfd-flip") >= 0 {
            let g: Rc<RefCell<DomFrame>> = Rc::new(RefCell::new(DomFrame::new()));
            g.borrow_mut().e = 0.0 - 1.0;
            g.borrow_mut().f = 2.0 * el.borrow().calculated_y + el.borrow().calculated_height;
            let kg: Rc<RefCell<DomFrame>> = kf.borrow().then(&g);
            let __it_c = el.borrow().children.clone();
            for c in __it_c.iter().cloned() {
                DomView::collectIn(&c, pfx, &kg, acc);
            }
            return;
        }
        // a box in another writing mode: its own frame turned into this one
        if DomText::index_of(&el.borrow().class_name, "mfd-wm") == 0 {
            let __n_li = el.borrow().children.len() as i64;
            for li in 0..__n_li {
                let l = Rc::clone(&el.borrow().children[li as usize]);
                let lx: f64 = l.borrow().calculated_x;
                let ly: f64 = l.borrow().calculated_y;
                let px: f64 = el.borrow().calculated_x;
                let py: f64 = el.borrow().calculated_y;
                let g_1: Rc<RefCell<DomFrame>> = Rc::new(RefCell::new(DomFrame::new()));
                g_1.borrow_mut().a = 0.0;
                g_1.borrow_mut().b = 1.0;
                g_1.borrow_mut().c = px - ly;
                g_1.borrow_mut().d = 1.0;
                g_1.borrow_mut().e = 0.0;
                g_1.borrow_mut().f = py - lx;
                if DomText::index_of(&el.borrow().class_name, "horizontal") > 0 {
                    if DomText::index_of(&el.borrow().class_name, "vertical-rl") > 0 {
                        g_1.borrow_mut().d = 0.0 - 1.0;
                        g_1.borrow_mut().f = (py + l.borrow().calculated_width) + lx;
                    }
                } else {
                    if DomText::index_of(&el.borrow().class_name, "vertical-rl") > 0 {
                        g_1.borrow_mut().b = 0.0 - 1.0;
                        g_1.borrow_mut().c = (px + l.borrow().calculated_height) + ly;
                    }
                }
                DomView::collectIn(&l, pfx, &kf.borrow().then(&g_1), acc);
            }
            return;
        }
        let __it_c = el.borrow().children.clone();
        for c_1 in __it_c.iter().cloned() {
            DomView::collectIn(&c_1, pfx, &kf, acc);
        }
    }
    pub fn minOf(a: f64, b: f64) -> f64 {
        if a < b {
            return a;
        }
        b
    }
    pub fn whole(v: f64) -> f64 {
        if v < 0.0 {
            return ((v - 0.5).floor() as i64) as f64;
        }
        ((v + 0.5).floor() as i64) as f64
    }
    /// to a hundredth of a pixel: a scaled page's boxes (React Flow's nodes at
    /// zoom 0.52) divide back to whole pixels, rounding to 1 px put a handle
    /// 2 units off
    pub fn num(v: f64) -> String {
        let mut h: f64 = 0.5;
        if v < 0.0 {
            h = 0.0 - 0.5;
        }
        DomView::fmt((((v * 100.0 + h).floor() as i64) as f64) / 100.0)
    }
    /// the room an overflow-y: scroll box gives its bar, as Chromium's
    /// classic scrollbar
    pub fn gutter() -> f64 {
        15.0
    }
    /// the scroll containers' bars, drawn after layout over each one's right
    /// edge: a track in scrollbar-color's second colour and a thumb in its
    /// first (Chromium's #f1f1f1 and #c1c1c1 without one), the thumb as long
    /// as the share of the content in view and where scrollTop has it. The
    /// container's children were moved by its scroll, so the bars are put
    /// where they show; they have no id, so a hit on one is the container's.
    pub(crate) fn bars(el: &Rc<RefCell<EVGElement>>) {
        // (a kept element has the bars the last frame drew: those go)
        let mut keep_kids: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut had: bool = false;
        let __it_k0 = el.borrow().children.clone();
        for k0 in __it_k0.iter().cloned() {
            let kc: String = k0.borrow().class_name.clone();
            if kc == "mfd-dbar" || kc == "mfd-dthumb" {
                had = true;
            } else {
                keep_kids.push(k0);
            }
        }
        if had {
            el.borrow_mut().children = keep_kids;
        }
        let __it_c = el.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            DomView::bars(&c);
        }
        let always: bool = DomText::index_of(&el.borrow().class_name, "mfd-dscroll") >= 0;
        if !always && DomText::index_of(&el.borrow().class_name, "mfd-dauto") < 0 {
            return;
        }
        let max_y: f64 = EVGElement::max_scroll_top(&el);
        if !always && max_y <= 0.0 {
            return;
        }
        let bw: f64 = el.borrow().r#box.as_ref().unwrap().borrow().border_width_px;
        let x: f64 = (el.borrow().calculated_x + el.borrow().calculated_width) - bw;
        let top: f64 = el.borrow().calculated_y + bw;
        let h: f64 = el.borrow().calculated_height - bw * 2.0;
        let g: f64 = DomView::gutter();
        let w: f64 = 6.0;
        let bx: f64 = (x - g) + (g - w) / 2.0;
        let track_y: f64 = top + 2.0;
        let track_h: f64 = h - 4.0;
        if track_h < 12.0 {
            return;
        }
        let mut _tmp_1 = el.borrow().scrollbar_track.clone();
        let track: Rc<RefCell<EVGElement>> = DomView::barPiece(
            bx,
            track_y,
            w,
            track_h,
            Rc::clone(&EVGColor::rgb(241, 241, 241)),
            _tmp_1
        );
        el.borrow_mut().children.push(Rc::clone(&track));
        if max_y <= 0.0 {
            return;
        }
        let client_h: f64 = EVGElement::client_height(&el);
        let mut thumbH: f64 = (track_h * client_h) / (client_h + max_y);
        if thumbH < 18.0 {
            thumbH = 18.0;
        }
        let thumb_y: f64 = track_y + ((track_h - thumbH) * el.borrow().scroll_top) / max_y;
        let mut _tmp_2 = el.borrow().scrollbar_thumb.clone();
        let thumb: Rc<RefCell<EVGElement>> = DomView::barPiece(
            bx,
            thumb_y,
            w,
            thumbH,
            Rc::clone(&EVGColor::rgb(193, 193, 193)),
            _tmp_2
        );
        thumb.borrow_mut().class_name = "mfd-dthumb".to_string();
        el.borrow_mut().children.push(Rc::clone(&thumb));
    }
    /// an <svg> with overflow: visible draws past its box: React Flow puts
    /// each edge in a 300 x 150 svg at the flow's origin and the path where
    /// its nodes are. The display list culls a subtree by the union of its
    /// boxes (EVGElement.paintTop...), so once a zoom or pan took that small
    /// box out of view the edges were not drawn. After layout the paint
    /// bounds of such an svg are grown to its drawing (as the display list
    /// places it: viewBox to the box), and its ancestors' to include them;
    /// true when something under el grew
    pub(crate) fn overflowing(el: &Rc<RefCell<EVGElement>>) -> bool {
        let mut grew: bool = false;
        let __n_i = el.borrow().children.len() as i64;
        for i in 0..__n_i {
            let c = Rc::clone(&el.borrow().children[i as usize]);
            if !EVGElement::is_hidden(&c) {
                if DomView::overflowing(&c) {
                    grew = true;
                    let mut _tmp_1 = c.borrow().paint_left.clone();
                    let mut _tmp_2 = c.borrow().paint_top.clone();
                    let mut _tmp_3 = c.borrow().paint_right.clone();
                    DomView::unionPaint(el, _tmp_1, _tmp_2, _tmp_3, c.borrow().paint_bottom.clone());
                }
            }
        }
        if el.borrow().class_name != "mfd-svgvis" || el.borrow().svg_doc.is_none() {
            return grew;
        }
        let doc: Rc<RefCell<SvgDocument>> = el.borrow().svg_doc.clone().unwrap();
        if SvgDocument::item_count(&doc) == 0 {
            return grew;
        }
        let w: f64 = el.borrow().calculated_width;
        let h: f64 = el.borrow().calculated_height;
        let m: Rc<RefCell<Matrix2D>> = VectorViewBox::resolve(
            &SvgDocument::effective_view_box(&doc),
            w,
            h,
            "xMidYMid meet"
        );
        let b: Rc<RefCell<PathBounds>> = SvgDocument::bounds(&doc);
        // the widest stroke's half beyond the points
        let mut pad: f64 = 0.0;
        let __it_it = doc.borrow().items.clone();
        for it in __it_it.iter() {
            if it.borrow().stroke_width > pad {
                pad = it.borrow().stroke_width;
            }
        }
        pad = (pad * DomView::maxOf((m.borrow().a).abs(), (m.borrow().d).abs())) / 2.0;
        let x0: f64 = ((m.borrow().a * b.borrow().min_x + m.borrow().c * b.borrow().min_y) + m.borrow().e) + el.borrow().calculated_x;
        let y0: f64 = ((m.borrow().b * b.borrow().min_x + m.borrow().d * b.borrow().min_y) + m.borrow().f) + el.borrow().calculated_y;
        let x1: f64 = ((m.borrow().a * b.borrow().max_x + m.borrow().c * b.borrow().max_y) + m.borrow().e) + el.borrow().calculated_x;
        let y1: f64 = ((m.borrow().b * b.borrow().max_x + m.borrow().d * b.borrow().max_y) + m.borrow().f) + el.borrow().calculated_y;
        let _tmp_1 = DomView::minOf(x0, x1) - pad;
        let _tmp_2 = DomView::minOf(y0, y1) - pad;
        let _tmp_3 = DomView::maxOf(x0, x1) + pad;
        DomView::unionPaint(el, _tmp_1, _tmp_2, _tmp_3, DomView::maxOf(y0, y1) + pad);
        true
    }
    fn unionPaint(el: &Rc<RefCell<EVGElement>>, l: f64, t: f64, r: f64, b: f64) {
        if l < el.borrow().paint_left {
            el.borrow_mut().paint_left = l;
        }
        if t < el.borrow().paint_top {
            el.borrow_mut().paint_top = t;
        }
        if r > el.borrow().paint_right {
            el.borrow_mut().paint_right = r;
        }
        if b > el.borrow().paint_bottom {
            el.borrow_mut().paint_bottom = b;
        }
    }
    fn barPiece(x: f64, y: f64, w: f64, h: f64, fallback: Rc<RefCell<EVGColor>>, color: Option<Rc<RefCell<EVGColor>>>) -> Rc<RefCell<EVGElement>> {
        let p: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        p.borrow_mut().class_name = "mfd-dbar".to_string();
        p.borrow_mut().a11y_hidden = true;
        p.borrow_mut().background_color = Some(Rc::clone(&fallback));
        if color.is_some() {
            let own: Rc<RefCell<EVGColor>> = color.clone().unwrap();
            if own.borrow().is_set {
                p.borrow_mut().background_color = Some(Rc::clone(&own));
            }
        }
        let r: f64 = w / 2.0;
        p.borrow_mut().r#box.as_ref().unwrap().borrow_mut().border_radius_px = r;
        p.borrow_mut().r#box.as_ref().unwrap().borrow_mut().border_radius_tl_px = r;
        p.borrow_mut().r#box.as_ref().unwrap().borrow_mut().border_radius_tr_px = r;
        p.borrow_mut().r#box.as_ref().unwrap().borrow_mut().border_radius_br_px = r;
        p.borrow_mut().r#box.as_ref().unwrap().borrow_mut().border_radius_bl_px = r;
        p.borrow_mut().calculated_x = x;
        p.borrow_mut().calculated_y = y;
        p.borrow_mut().calculated_width = w;
        p.borrow_mut().calculated_height = h;
        DomView::painted(&p);
        p
    }
    pub fn child(&self, n: &Rc<RefCell<JsonValue>>, tag: &str) -> Rc<RefCell<JsonValue>> {
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_k = kids.borrow().items.clone();
        for k in __it_k.iter().cloned() {
            if k.borrow().getText("t") == tag {
                return k;
            }
        }
        Rc::new(RefCell::new(JsonValue::new()))
    }
    pub fn inherit(&self, parent: &Rc<RefCell<JsonValue>>, s: &Rc<RefCell<JsonValue>>) -> Rc<RefCell<JsonValue>> {
        let o: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        let __n_i = parent.borrow().keys.len() as i64;
        for i in 0..__n_i {
            let k = parent.borrow().keys[i as usize].clone();
            o.borrow_mut().put(&k, parent.borrow().items[i as usize].clone());
        }
        // (the names once: each call makes the list again)
        let names: Vec<String> = DomView::inheritedNames();
        for n in names.iter().cloned() {
            if s.borrow().has(&n) {
                o.borrow_mut().put(&n, s.borrow().get(&n));
            }
        }
        // (text-decoration: the lines of the boxes above reach the text of
        // their in-flow content, not a float's, an absolute box's or an
        // atomic inline's, CSS Text Decoration 3, 2.1)
        let tpos: String = s.borrow().getText("position");
        let tfl: String = s.borrow().getText("float");
        let tdis: String = s.borrow().getText("display");
        if tpos == "absolute" || tpos == "fixed" || (!tfl.is_empty() && tfl != "none") || tdis == "inline-block" || tdis == "inline-flex" || tdis == "inline-grid" || tdis == "inline-table" {
            o.borrow_mut().putStr("_tdeco", "");
        }
        // (on a block the lines it gets are drawn by an anonymous inline
        // around its text: of the block's own font, CSS Text Decoration 3)
        let tin: String = o.borrow().getText("_tdeco");
        if !tin.is_empty() && !tdis.is_empty() && tdis != "inline" && tdis != "contents" && tdis != "none" {
            let mut bfs: f64 = DomView::pxOf(&o.borrow().getText("font-size"));
            if bfs <= 0.0 {
                bfs = 16.0;
            }
            let bface: String = DomView::faceOf(&o.borrow().getText("font-family"), &o.borrow().getText("font-weight"))[0].clone();
            let basc: f64 = (bfs * DomView::ascentEm(&bface) + 0.5).floor();
            let mut rew: String = String::new();
            for es in tin.split(";").map(|s| s.to_string()).collect::<Vec<String>>().iter().cloned() {
                let sp1: i64 = DomText::index_of(&es, " ");
                let sp2: i64 = DomText::index_of_from(&es, " ", sp1 + 1);
                let sp3: i64 = DomText::index_of_from(&es, " ", sp2 + 1);
                if sp1 <= 0 || sp2 < 0 || sp3 < 0 {
                    continue;
                }
                let one: String = format!("{} {} {}{}", es[0..(sp1 as usize)].to_string(), DomView::fmt(bfs), DomView::fmt(basc), es[(sp3 as usize)..es.as_bytes().len()].to_string());
                if rew.is_empty() {
                    rew = one.clone();
                } else {
                    rew = format!("{};{}", rew, one);
                }
            }
            o.borrow_mut().putStr("_tdeco", &rew);
        }
        let own: String = DomView::decoLinesOf(s, &o);
        if !own.is_empty() {
            let had: String = o.borrow().getText("_tdeco");
            if had.is_empty() {
                o.borrow_mut().putStr("_tdeco", &own);
            } else {
                o.borrow_mut().putStr("_tdeco", &format!("{};{}", had, own));
            }
        }
        o
    }
    /// a box's own text-decoration lines, as EVGElement.textDecorations
    /// takes them less the skip flag: "kind size ascent color" a line, ";"
    /// between, of its font (the decorating box's) and its decoration colour
    /// or its colour
    pub fn decoLinesOf(s: &Rc<RefCell<JsonValue>>, o: &Rc<RefCell<JsonValue>>) -> String {
        let mut lv: String = s.borrow().getText("text-decoration-line");
        let mut cv: String = s.borrow().getText("text-decoration-color");
        let sh: String = s.borrow().getText("text-decoration");
        let mut rest: Vec<String> = Vec::new();
        if !sh.is_empty() {
            let mut kinds: String = String::new();
            for ws in sh.split(" ").map(|s| s.to_string()).collect::<Vec<String>>().iter().cloned() {
                if ws.is_empty() {
                    continue;
                }
                let wl: String = ws.to_lowercase();
                if wl == "underline" || wl == "overline" || wl == "line-through" || wl == "blink" || wl == "none" {
                    kinds = format!("{} {}", kinds, wl);
                    continue;
                }
                if wl == "solid" || wl == "double" || wl == "dotted" || wl == "dashed" || wl == "wavy" || wl == "auto" || wl == "from-font" {
                    continue;
                }
                rest.push(ws.clone());
            }
            if lv.is_empty() {
                lv = kinds.clone();
            }
        }
        if cv.is_empty() && (rest.len() as i64) > 0 {
            let mut joined: String = String::new();
            for r in rest.iter().cloned() {
                // (a thickness is not a colour)
                if (r.ends_with("px") || r.ends_with("em") || r.ends_with("%")) && DomText::index_of(&r, "(") < 0 && DomText::index_of(&joined, "(") < 0 {
                    continue;
                }
                if joined.is_empty() {
                    joined = r.clone();
                } else {
                    joined = format!("{} {}", joined, r);
                }
            }
            cv = joined.clone();
        }
        if cv.is_empty() || cv.to_lowercase() == "currentcolor" {
            cv = o.borrow().getText("color");
        }
        if cv.is_empty() {
            cv = "rgb(0, 0, 0)".to_string();
        }
        // (no line: nothing to measure; most boxes have none)
        let lvl: String = lv.to_lowercase();
        if DomText::index_of(&lvl, "underline") < 0 && DomText::index_of(&lvl, "overline") < 0 && DomText::index_of(&lvl, "line-through") < 0 {
            return String::new();
        }
        let mut fs: f64 = DomView::pxOf(&o.borrow().getText("font-size"));
        if fs <= 0.0 {
            fs = 16.0;
        }
        let face: String = DomView::faceOf(&o.borrow().getText("font-family"), &o.borrow().getText("font-weight"))[0].clone();
        let asc: f64 = (fs * DomView::ascentEm(&face) + 0.5).floor();
        let mut out: String = String::new();
        for k in lv.split(" ").map(|s| s.to_string()).collect::<Vec<String>>().iter().cloned() {
            let ks: String = k.to_lowercase();
            if ks == "underline" || ks == "overline" || ks == "line-through" {
                let ent: String = format!("{} {} {} {}", ks, DomView::fmt(fs), DomView::fmt(asc), cv);
                if out.is_empty() {
                    out = ent.clone();
                } else {
                    out = format!("{};{}", out, ent);
                }
            }
        }
        out
    }
    /// a text node, or an inline element with only text inside
    pub fn isText(&self, n: &Rc<RefCell<JsonValue>>) -> bool {
        if n.borrow().has("x") {
            return true;
        }
        if DomView::displayOf(n) != "inline" {
            return false;
        }
        if n.borrow().has("svg") {
            return false;
        }
        let t: String = n.borrow().getText("t");
        if t == "img" || (t == "br" || (t == "input" || (t == "textarea" || t == "select"))) {
            return false;
        }
        let pos: String = n.borrow().get("s").borrow().getText("position");
        if pos == "absolute" || pos == "fixed" {
            return false;
        }
        let fl: String = n.borrow().get("s").borrow().getText("float");
        if !fl.is_empty() && fl != "none" {
            return false;
        }
        // text placed off the baseline is a box of its own in its line
        let va: String = n.borrow().get("s").borrow().getText("vertical-align");
        let _tmp_4 = DomView::collapse(&self.textOf(n));
        if !va.is_empty() && (va != "baseline" && (DomView::trimmed(&_tmp_4).as_bytes().len() as i64) > 0) {
            return false;
        }
        // (a margin, padding or border at its sides moves what follows it
        // in the line: a box of its own, when it is one word, which a box
        // in the line keeps whole as the text would)
        let ss: Rc<RefCell<JsonValue>> = n.borrow().get("s");
        let mut one_word: bool = DomText::index_of(&DomView::trimmed(&_tmp_4), " ") < 0;
        // (a decorated one is pieces whose own sides move what follows)
        if DomView::decorated(&ss, self.dirNow == "rtl" || ss.borrow().getText("direction") == "rtl") {
            one_word = false;
        }
        let __v_hs: Vec<String> = vec!["margin-left".to_string(), "margin-right".to_string(), "padding-left".to_string(), "padding-right".to_string()];
        let __n_hs = __v_hs.len() as i64;
        for hs in 0..__n_hs {
            if one_word && DomView::pxOf(&ss.borrow().getText(&__v_hs[hs as usize].clone())) != 0.0 {
                return false;
            }
        }
        if one_word && (DomView::side(&ss, "left") > 0.0 || DomView::side(&ss, "right") > 0.0) {
            return false;
        }
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_k = kids.borrow().items.clone();
        for k in __it_k.iter().cloned() {
            if !self.isText(&k) {
                return false;
            }
        }
        true
    }
    pub fn textOf(&self, n: &Rc<RefCell<JsonValue>>) -> String {
        if n.borrow().has("x") {
            return n.borrow().getText("x");
        }
        let mut out: String = String::new();
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_k = kids.borrow().items.clone();
        for k in __it_k.iter().cloned() {
            out = format!("{}{}", out, self.textOf(&k));
        }
        out
    }
    /// a text element drawn with the inherited properties
    fn textEl(&self, text: String, inh: &Rc<RefCell<JsonValue>>, id: String) -> Rc<RefCell<EVGElement>> {
        let e: Rc<RefCell<EVGElement>> = EVGElement::create_span();
        if !id.is_empty() {
            e.borrow_mut().id = id.clone();
        }
        let __n_i = inh.borrow().keys.len() as i64;
        for i in 0..__n_i {
            let k = inh.borrow().keys[i as usize].clone();
            let v: String = inh.borrow().items[i as usize].clone().borrow().text();
            if k == "cursor" || k == "font-variant" || k == "list-style-position" || k == "text-indent" || (k == "visibility" || (k == "list-style-type" || (k == "direction" || (k == "writing-mode" || k == "word-spacing")))) {
                continue;
            }
            if DomText::index_of(&k, "_deco") == 0 || k == "_tdeco" {
                continue;
            }
            if k == "text-align" && (v == "start" || v == "left") {
                continue;
            }
            if k == "white-space" && v == "normal" {
                continue;
            }
            if k == "line-height" && v == "normal" {
                continue;
            }
            // (and a font-size of 0 too: text of no size is not drawn)
            if k == "font-size" && v == "0px" {
                EVGElement::set_attribute(&e, "font-size", "0.001px".to_string());
                continue;
            }
            // (EVG takes a line-height of 0 for none set)
            if k == "line-height" && (v == "0px" || (v == "0" || v == "0%")) {
                EVGElement::set_attribute(&e, "line-height", "0.001px".to_string());
                continue;
            }
            if k == "font-family" || k == "font-weight" {
                continue;
            }
            EVGElement::set_attribute(&e, &k, v.clone());
        }
        let face: Vec<String> = DomView::faceOf(&inh.borrow().getText("font-family"), &inh.borrow().getText("font-weight"));
        EVGElement::set_attribute(&e, "font-family", face[0].clone());
        // (the text-decoration lines that reach it; an underline through a
        // face of solid glyphs is left only under the spaces, skip-ink)
        let tdl: String = inh.borrow().getText("_tdeco");
        if !tdl.is_empty() {
            let mut tds: String = String::new();
            for es in tdl.split(";").map(|s| s.to_string()).collect::<Vec<String>>().iter().cloned() {
                let sp1: i64 = DomText::index_of(&es, " ");
                if sp1 <= 0 {
                    continue;
                }
                let kind: String = es[0..(sp1 as usize)].to_string();
                let sp2: i64 = DomText::index_of_from(&es, " ", sp1 + 1);
                let sp3: i64 = DomText::index_of_from(&es, " ", sp2 + 1);
                if sp2 < 0 || sp3 < 0 {
                    continue;
                }
                let mut skip: String = "0".to_string();
                if kind == "underline" && face[0].clone() == "Ahem" {
                    skip = "1".to_string();
                }
                let one: String = format!("{} {}{}", es[0..(sp3 as usize)].to_string(), skip, es[(sp3 as usize)..es.as_bytes().len()].to_string());
                if tds.is_empty() {
                    tds = one.clone();
                } else {
                    tds = format!("{};{}", tds, one);
                }
            }
            EVGElement::set_attribute(&e, "text-decorations", tds.clone());
        }
        let lhn: String = inh.borrow().getText("line-height");
        if lhn.is_empty() || lhn == "normal" {
            EVGElement::set_attribute(&e, "line-height", format!("{}px", DomView::fmt(DomView::lineHeight(inh))));
        }
        if face[1].clone() == "bold" {
            EVGElement::set_attribute(&e, "font-weight", "bold".to_string());
        }
        // small capitals made from the capitals 0.7 as big, as Chromium
        // makes them when the font has none (a word all in small letters),
        // rounded to the pixel
        let mut text: String = text.clone();
        if inh.borrow().getText("font-variant") == "small-caps" && text.to_uppercase() != text && text.to_lowercase() == text {
            let scs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
            if scs > 0.0 {
                text = text.to_uppercase();
                // (to the whole pixel, as Chromium sizes the face it makes)
                EVGElement::set_attribute(&e, "font-size", format!("{}px", DomView::fmt((scs * 0.7 + 0.5).floor())));
            }
        }
        e.borrow_mut().text_content = text.clone();
        // (down a vertical line the baseline is the line's middle, unless
        // the text lies sideways on its alphabetic one)
        if !self.wm.is_empty() && inh.borrow().getText("text-orientation") != "sideways" {
            EVGElement::set_attribute(&e, "baseline-central", "true".to_string());
        }
        // (sideways in vertical-lr the lines lie with their tops on the
        // right, the block end)
        if self.wm == "vertical-lr" && inh.borrow().getText("text-orientation") == "sideways" {
            EVGElement::set_attribute(&e, "baseline-under", "true".to_string());
        }
        e
    }
    pub fn pre(&self, inh: &Rc<RefCell<JsonValue>>) -> bool {
        let ws: String = inh.borrow().getText("white-space");
        ws == "pre" || (ws == "pre-wrap" || ws == "break-spaces")
    }
    /// the size `stretch` makes a box along the axis of n (width, height or
    /// their min- and max-): -1 when the parent's size there is not set
    /// a min- or max- size in pixels, `stretch` filling the parent (0 when
    /// there is nothing to fill)
    /// a min- or max- size in %, of the grid area or of the parent's
    /// definite height; a grid's single auto track is the grid's own size
    /// (0 when there is none, -1 for a size not in %)
    /// a relative box's offset in px: a percentage is of its containing
    /// block's content height (its definite one, else none) or width (a px
    /// one, else none)
    pub fn relOff(&self, s: &Rc<RefCell<JsonValue>>, n: &str, vertical: bool) -> f64 {
        let v: String = s.borrow().getText(n);
        if !v.ends_with("%") {
            return DomView::pxOf(&v);
        }
        let pct: Option<f64> = v[0..((v.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
        if pct.is_none() {
            return 0.0;
        }
        let mut base: f64 = -1.0;
        // (inside an inline the containing block is a box further out)
        let od: String = self.outerS.borrow().getText("display");
        if od == "inline" || od == "contents" {
            return 0.0;
        }
        if vertical {
            base = self.defH;
        } else {
            let ow: String = self.outerS.borrow().getText("width");
            if ow.ends_with("px") {
                base = DomView::pxOf(&ow);
                if self.outerS.borrow().getText("box-sizing") == "border-box" {
                    base = (((base - DomView::pxOf(&self.outerS.borrow().getText("padding-left"))) - DomView::pxOf(&self.outerS.borrow().getText("padding-right"))) - DomView::side(&self.outerS.clone(), "left")) - DomView::side(&self.outerS.clone(), "right");
                }
            }
        }
        if base < 0.0 {
            return 0.0;
        }
        base * pct.unwrap() / 100.0
    }
    pub fn pctLimit(&self, s: &Rc<RefCell<JsonValue>>, n: &str, vertical: bool) -> f64 {
        let v: String = s.borrow().getText(n);
        if DomText::index_of(&v, "%") < 0 {
            return -1.0;
        }
        let mut pct: f64 = 0.0;
        let pi: i64 = DomText::index_of(&v, "%");
        let pnum: String = v[(0) as usize..(pi) as usize].to_string();
        let pd: Option<f64> = pnum.parse::<f64>().ok();
        if pd.is_some() {
            pct = pd.unwrap();
        }
        let mut base: f64 = -1.0;
        let od: String = self.outerS.borrow().getText("display");
        if od == "grid" || od == "inline-grid" {
            // (the style and the grid's are in the frame's own axes)
            let on_rows: bool = vertical;
            let mut place: String = s.borrow().getText("grid-column");
            let mut tpl: String = self.outerS.borrow().getText("grid-template-columns");
            let mut own: String = self.outerS.borrow().getText("width");
            if on_rows {
                place = s.borrow().getText("grid-row");
                tpl = self.outerS.borrow().getText("grid-template-rows");
            }
            if vertical {
                own = self.outerS.borrow().getText("height");
            }
            if place.is_empty() || place == "auto" {
                place = "1".to_string();
            }
            base = DomView::trackSpanPx(&place, &tpl);
            if base < 0.0 && (tpl.is_empty() || tpl == "none") {
                if DomView::pxOf(&own) > 0.0 {
                    base = DomView::pxOf(&own);
                }
            }
        } else {
            if vertical {
                base = self.defH;
            }
        }
        if base < 0.0 {
            return 0.0;
        }
        (base * pct) / 100.0
    }
    pub fn heightLimit(&self, s: &Rc<RefCell<JsonValue>>, n: &str) -> f64 {
        let p: f64 = self.pctLimit(s, n, true);
        if p >= 0.0 {
            return p;
        }
        self.limitOf(s, n)
    }
    pub fn widthLimit(&self, s: &Rc<RefCell<JsonValue>>, n: &str) -> f64 {
        let p: f64 = self.pctLimit(s, n, false);
        if p > 0.0 {
            return p;
        }
        self.limitOf(s, n)
    }
    pub fn limitOf(&self, s: &Rc<RefCell<JsonValue>>, n: &str) -> f64 {
        let v: String = s.borrow().getText(n);
        if DomView::stretchy(&v) {
            let f: f64 = self.fillOf(s, n);
            if f < 0.0 {
                return 0.0;
            }
            return f;
        }
        DomView::pxOf(&v)
    }
    /// an element's definite content height: its own height in px, or a
    /// stretched item's of a single-line flex row whose height is definite
    /// (CSS Flexbox 9.8); -1 for none. parentH is the parent's
    /// percentage margin-top/-bottom of an in-flow block child as px of
    /// the parent's px content width (horizontal, not a flex/grid item)
    fn pctBlockMargins(&self, s: &Rc<RefCell<JsonValue>>) {
        if self.inFlex || !self.wm.is_empty() {
            return;
        }
        let pos: String = s.borrow().getText("position");
        if pos == "absolute" || pos == "fixed" {
            return;
        }
        let od: String = self.outerS.borrow().getText("display");
        if !(od == "block" || od == "flow-root" || od == "list-item" || od == "inline-block") {
            return;
        }
        // (a multi-column parent is a formatting context of its own: its
        // children's margins stay in it, which the collapsing here leaves
        // to a margin it does not take part in)
        let occ: String = self.outerS.borrow().getText("column-count");
        let ocw: String = self.outerS.borrow().getText("column-width");
        let ocs: String = self.outerS.borrow().getText("columns");
        if (!occ.is_empty() && occ != "auto") || (!ocw.is_empty() && ocw != "auto") || (!ocs.is_empty() && ocs != "auto" && ocs != "auto auto") {
            return;
        }
        let ow: String = self.outerS.borrow().getText("width");
        if !ow.ends_with("px") || DomText::index_of(&ow, "(") >= 0 {
            return;
        }
        let mut cw: f64 = DomView::pxOf(&ow);
        if self.outerS.borrow().getText("box-sizing") == "border-box" {
            let __v_bs: Vec<String> = vec!["padding-left".to_string(), "padding-right".to_string(), "border-left-width".to_string(), "border-right-width".to_string()];
            let __n_bs = __v_bs.len() as i64;
            for bi in 0..__n_bs {
                cw = cw - DomView::pxOf(&self.outerS.borrow().getText(&__v_bs[bi as usize]));
            }
        }
        if cw < 0.0 {
            return;
        }
        let __v_ms: Vec<String> = vec!["margin-top".to_string(), "margin-bottom".to_string()];
        let __n_ms = __v_ms.len() as i64;
        for mi in 0..__n_ms {
            let mn: String = __v_ms[mi as usize].clone();
            let mv: String = s.borrow().getText(&mn);
            if (mv.as_bytes().len() as i64) > 1 && mv.ends_with("%") && DomText::index_of(&mv, "(") < 0 {
                let q: Option<f64> = mv[0..((mv.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                if q.is_some() {
                    self.putPage(s, &mn, &format!("{}px", DomView::fmt(cw * q.unwrap() / 100.0)));
                }
            }
        }
    }
    /// the px size a grid item of no ratio stretched along an axis gets
    /// (CSS Grid 11.3): its single track's, the grid's own px size there
    /// (-1 when it does not stretch, or the size is not known so)
    pub fn gridStretchPx(&self, s: &Rc<RefCell<JsonValue>>, horiz: bool) -> f64 {
        let gd: String = self.outerS.borrow().getText("display");
        let pos: String = s.borrow().getText("position");
        if !(gd == "grid" || gd == "inline-grid") || pos == "absolute" || pos == "fixed" || !self.wm.is_empty() {
            return -1.0;
        }
        let mut al: String = s.borrow().getText(if horiz { "justify-self" } else { "align-self" });
        if al.is_empty() || al == "auto" {
            al = self.outerS.borrow().getText(if horiz { "justify-items" } else { "align-items" });
        }
        if al != "stretch" {
            return -1.0;
        }
        let own: String = s.borrow().getText(if horiz { "width" } else { "height" });
        if !own.is_empty() && own != "auto" {
            return -1.0;
        }
        let tr: String = self.outerS.borrow().getText(if horiz { "grid-template-columns" } else { "grid-template-rows" });
        if !(tr.is_empty() || tr == "none" || tr == "100%" || tr == "auto" || tr == "1fr") {
            return -1.0;
        }
        let gs: String = self.outerS.borrow().getText(if horiz { "width" } else { "height" });
        if DomText::index_of(&gs, "px") <= 0 || DomText::index_of(&gs, "(") >= 0 {
            return -1.0;
        }
        if self.outerS.borrow().getText("box-sizing") == "border-box" {
            return -1.0;
        }
        let mut v: f64 = DomView::pxOf(&gs);
        let __v_mside: Vec<String> = if horiz { vec!["margin-left".to_string(), "margin-right".to_string()] } else { vec!["margin-top".to_string(), "margin-bottom".to_string()] };
        let __n_mside = __v_mside.len() as i64;
        for mi in 0..__n_mside {
            let mv: String = s.borrow().getText(&__v_mside[mi as usize]);
            if mv == "auto" || DomText::index_of(&mv, "%") >= 0 {
                return -1.0;
            }
            v = v - DomView::pxOf(&mv);
        }
        if v < 0.0 {
            return 0.0;
        }
        return v;
    }
    /// a height in px, or a percentage of the definite one around it; -1
    /// for none
    /// the width an aspect-ratio gives a flex row's item stretched to a
    /// definite line (-1 when it does not)
    pub fn stretchedRatioWidth(&self, s: &Rc<RefCell<JsonValue>>) -> f64 {
        let bgd: String = self.outerS.borrow().getText("display");
        let arv: String = s.borrow().getText("aspect-ratio");
        let pos: String = s.borrow().getText("position");
        if !(bgd == "flex" || bgd == "inline-flex") || pos == "absolute" || pos == "fixed" || !self.wm.is_empty() || self.defH < 0.0 || arv.is_empty() || DomText::index_of(&arv, "auto") >= 0 {
            return -1.0;
        }
        let sfd: String = self.outerS.borrow().getText("flex-direction");
        let sfw: String = self.outerS.borrow().getText("flex-wrap");
        let sai: String = self.outerS.borrow().getText("align-items");
        let sas: String = s.borrow().getText("align-self");
        let sfb: String = s.borrow().getText("flex-basis");
        let swd: String = s.borrow().getText("width");
        let sht: String = s.borrow().getText("height");
        let row: bool = sfd.is_empty() || sfd == "row" || sfd == "row-reverse";
        let one_line: bool = sfw.is_empty() || sfw == "nowrap";
        let stretched: bool = (sas.is_empty() || sas == "auto" || sas == "stretch" || sas == "normal") && (sai.is_empty() || sai == "stretch" || sai == "normal" || sas == "stretch");
        let auto_sizes: bool = (swd.is_empty() || swd == "auto") && (sht.is_empty() || sht == "auto") && (sfb.is_empty() || sfb == "auto" || sfb == "content");
        let no_limits: bool = s.borrow().getText("min-height").is_empty() && s.borrow().getText("max-height").is_empty() && s.borrow().getText("max-width").is_empty();
        let auto_m: bool = s.borrow().getText("margin-top") == "auto" || s.borrow().getText("margin-bottom") == "auto";
        let sq: f64 = DomView::ratioOf(&arv);
        if !(row && one_line && stretched && auto_sizes && no_limits && !auto_m && sq > 0.0 && s.borrow().getText("box-sizing") != "border-box") {
            return -1.0;
        }
        let vch: f64 = DomView::pxOf(&s.borrow().getText("margin-top")) + DomView::pxOf(&s.borrow().getText("margin-bottom")) + DomView::pxOf(&s.borrow().getText("padding-top")) + DomView::pxOf(&s.borrow().getText("padding-bottom")) + DomView::side(&s, "top") + DomView::side(&s, "bottom");
        let mut ch: f64 = self.defH - vch;
        if ch < 0.0 {
            ch = 0.0;
        }
        ch * sq
    }
    pub fn lenOrPctH(&self, v: &str) -> f64 {
        if v.ends_with("px") {
            return DomView::pxOf(v);
        }
        if (v.as_bytes().len() as i64) > 1 && v.ends_with("%") && DomText::index_of(v, "(") < 0 && self.defH >= 0.0 {
            let q: Option<f64> = v[0..(v.as_bytes().len() - 1)].to_string().parse::<f64>().ok();
            if q.is_some() {
                return (self.defH * q.unwrap()) / 100.0;
            }
        }
        -1.0
    }
    // An item of a column flex container of no definite height whose
    // flex-basis is a percentage or content has no definite height, whatever
    // its height says (flexbox 9.8): its children's percentage heights are auto.
    pub fn indefColumnItem(&self, s: &Rc<RefCell<JsonValue>>, parent_h: f64) -> bool {
        let ifd: String = self.outerS.borrow().getText("display");
        let ifdir: String = self.outerS.borrow().getText("flex-direction");
        let ifb: String = s.borrow().getText("flex-basis");
        let ifpos: String = s.borrow().getText("position");
        ((ifd == "flex" || ifd == "inline-flex") && (ifdir == "column" || ifdir == "column-reverse")) && ((parent_h < 0.0 && !self.defHMaybe) && ((ifb == "content" || ((ifb.as_bytes().len() as i64) > 1 && ifb.ends_with("%"))) && (ifpos != "absolute" && ifpos != "fixed")))
    }
    pub fn definiteH(&self, s: &Rc<RefCell<JsonValue>>, parent_h: f64) -> f64 {
        // (a percentage padding is of the containing block's width)
        let bp: f64 = ((self.relOff(s, "padding-top", false) + self.relOff(s, "padding-bottom", false)) + DomView::pxOf(&s.borrow().getText("border-top-width"))) + DomView::pxOf(&s.borrow().getText("border-bottom-width"));
        let h: String = s.borrow().getText("height");
        // (a fully inflexible item of a column flex container with a px
        // flex-basis has that basis as its definite height, flexbox 9.8)
        let ifd: String = self.outerS.borrow().getText("display");
        let ifdir: String = self.outerS.borrow().getText("flex-direction");
        let ifb: String = s.borrow().getText("flex-basis");
        let ifg: String = s.borrow().getText("flex-grow");
        let ifpos: String = s.borrow().getText("position");
        if ((ifd == "flex" || ifd == "inline-flex") && (ifdir == "column" || ifdir == "column-reverse")) && ((s.borrow().getText("flex-shrink") == "0" && (ifg.is_empty() || ifg == "0")) && ((ifb.as_bytes().len() as i64) > 2 && ifb.ends_with("px") && (ifpos != "absolute" && ifpos != "fixed"))) {
            let mut bv: f64 = DomView::pxOf(&ifb);
            if s.borrow().getText("box-sizing") == "border-box" {
                bv -= bp;
            }
            if bv < 0.0 {
                bv = 0.0;
            }
            return bv;
        }
        if self.indefColumnItem(s, parent_h) {
            return -1.0;
        }
        if (h.as_bytes().len() as i64) > 2 && h[((h.as_bytes().len() as i64) - 2) as usize..(h.as_bytes().len() as i64) as usize].to_string() == "px" {
            let mut hv: f64 = DomView::pxOf(&h);
            if s.borrow().getText("box-sizing") == "border-box" {
                hv -= bp;
            }
            if hv < 0.0 {
                hv = 0.0;
            }
            return hv;
        }
        // (a percentage of a definite height is definite; a grid item's is
        // of its row, when the grid has one row of a set size)
        let hpos: String = s.borrow().getText("position");
        let mut pct_base: f64 = parent_h;
        if (ifd == "grid" || ifd == "inline-grid") && hpos != "absolute" && hpos != "fixed" {
            let gtr: String = self.outerS.borrow().getText("grid-template-rows").trim().to_string();
            let ggr: String = s.borrow().getText("grid-row").trim().to_string();
            if gtr.ends_with("px") && DomText::index_of(&gtr, " ") < 0 && DomText::index_of(&gtr, "(") < 0 && (ggr.is_empty() || ggr == "auto" || ggr == "1" || ggr.starts_with("1 ") || ggr.starts_with("1/")) {
                pct_base = DomView::pxOf(&gtr);
            }
        }
        if (((h.as_bytes().len() as i64) > 1 && h[((h.as_bytes().len() as i64) - 1) as usize..(h.as_bytes().len() as i64) as usize].to_string() == "%") && pct_base >= 0.0) && (hpos != "absolute" && hpos != "fixed") {
            let hq: Option<f64> = h[(0) as usize..((h.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
            if hq.is_some() {
                let mut hp: f64 = (pct_base * hq.unwrap()) / 100.0;
                if s.borrow().getText("box-sizing") == "border-box" {
                    hp -= bp;
                }
                if hp < 0.0 {
                    hp = 0.0;
                }
                return hp;
            }
        }
        if !h.is_empty() && h != "auto" {
            return -1.0;
        }
        // (an auto height from aspect-ratio and a px width is definite for
        // percentages inside, CSS Sizing 4 5.1)
        let dar: String = s.borrow().getText("aspect-ratio");
        let dw: String = s.borrow().getText("width");
        if (!dar.is_empty() && DomText::index_of(&dar, "auto") < 0) && ((dw.as_bytes().len() as i64) > 2 && dw[((dw.as_bytes().len() as i64) - 2) as usize..(dw.as_bytes().len() as i64) as usize].to_string() == "px") {
            let darq: f64 = DomView::ratioOf(&dar);
            if darq > 0.0 {
                let mut dh: f64 = DomView::pxOf(&dw) / darq;
                if s.borrow().getText("box-sizing") == "border-box" {
                    dh -= bp;
                }
                if dh < 0.0 {
                    dh = 0.0;
                }
                return dh;
            }
        }
        if parent_h < 0.0 {
            return -1.0;
        }
        // (an absolute box in a positioned parent of a definite height:
        // its top and bottom insets make its height, CSS 2.1 10.6.4)
        let apos: String = s.borrow().getText("position");
        let opos: String = self.outerS.borrow().getText("position");
        if apos == "absolute" && (opos == "relative" || opos == "absolute" || opos == "fixed" || opos == "sticky") {
            let at: String = s.borrow().getText("top");
            let ab: String = s.borrow().getText("bottom");
            let amt: String = s.borrow().getText("margin-top");
            let amb: String = s.borrow().getText("margin-bottom");
            if at.ends_with("px") && ab.ends_with("px") && amt != "auto" && amb != "auto" {
                let cbh: f64 = (parent_h + DomView::pxOf(&self.outerS.borrow().getText("padding-top"))) + DomView::pxOf(&self.outerS.borrow().getText("padding-bottom"));
                let mut av: f64 = ((((cbh - DomView::pxOf(&at)) - DomView::pxOf(&ab)) - DomView::pxOf(&amt)) - DomView::pxOf(&amb)) - bp;
                if av < 0.0 {
                    av = 0.0;
                }
                return av;
            }
        }
        // (quirks mode: a block of an auto height in normal flow passes the
        // height above it on to percentages inside)
        if self.quirks && apos != "absolute" && apos != "fixed" {
            let qod: String = self.outerS.borrow().getText("display");
            let qd: String = s.borrow().getText("display");
            let q_outer_ok: bool = qod != "flex" && qod != "inline-flex" && qod != "grid" && qod != "inline-grid";
            let q_self_ok: bool = qd != "flex" && qd != "inline-flex" && qd != "grid" && qd != "inline-grid" && qd != "table" && qd != "inline-table" && qd != "table-cell";
            if q_outer_ok && q_self_ok {
                return parent_h;
            }
        }
        let od: String = self.outerS.borrow().getText("display");
        let ofd: String = self.outerS.borrow().getText("flex-direction");
        let ofw: String = self.outerS.borrow().getText("flex-wrap");
        if od != "flex" && od != "inline-flex" {
            return -1.0;
        }
        if ofd == "column" || ofd == "column-reverse" {
            return -1.0;
        }
        if ofw == "wrap" || ofw == "wrap-reverse" {
            return -1.0;
        }
        let pos: String = s.borrow().getText("position");
        if pos == "absolute" || pos == "fixed" {
            return -1.0;
        }
        let mut r#as: String = s.borrow().getText("align-self");
        if (r#as.as_bytes().len() as i64) == 0 || r#as == "auto" {
            r#as = self.outerS.borrow().getText("align-items");
        }
        if ((r#as.as_bytes().len() as i64) > 0 && r#as != "normal") && r#as != "stretch" {
            return -1.0;
        }
        if s.borrow().getText("margin-top") == "auto" || s.borrow().getText("margin-bottom") == "auto" {
            return -1.0;
        }
        let mut v: f64 = ((parent_h - DomView::pxOf(&s.borrow().getText("margin-top"))) - DomView::pxOf(&s.borrow().getText("margin-bottom"))) - bp;
        if v < 0.0 {
            v = 0.0;
        }
        v
    }
    pub fn fillOf(&self, s: &Rc<RefCell<JsonValue>>, n: &str) -> f64 {
        let mut tall: bool = DomText::index_of(&n, "height") >= 0;
        if n == "flex-basis" {
            let fd: String = self.outerS.borrow().getText("flex-direction");
            tall = fd == "column" || fd == "column-reverse";
        }
        let mut axis: String = "width".to_string();
        let mut a: String = "left".to_string();
        let mut b: String = "right".to_string();
        if tall {
            axis = "height".to_string();
            a = "top".to_string();
            b = "bottom".to_string();
        }
        let mut pv: String = self.outerS.borrow().getText(&axis);
        let mut pp: f64 = DomView::pxOf(&pv);
        let sp0: String = s.borrow().getText("position");
        let in_flow0: bool = sp0 != "absolute" && sp0 != "fixed";
        // (a single-line flex row of no set height has its line clamped by
        // its max-height, CSS Flexbox 9.4 step 8: the line is taken as that)
        if (tall && in_flow0) && ((pp <= 0.0 && pv != "0px") && self.defH < 0.0) {
            let rd: String = self.outerS.borrow().getText("display");
            let rfd: String = self.outerS.borrow().getText("flex-direction");
            let rfw: String = self.outerS.borrow().getText("flex-wrap");
            let rmh: String = self.outerS.borrow().getText("max-height");
            if ((rd == "flex" || rd == "inline-flex") && (rfd.is_empty() || (rfd == "row" || rfd == "row-reverse"))) && ((rfw.is_empty() || rfw == "nowrap") && DomText::index_of(&rmh, "px") > 0) {
                pv = rmh.clone();
                pp = DomView::pxOf(&rmh);
            }
        }
        // (a stretched flex item's height is definite, defH)
        let from_def: bool = (tall && in_flow0) && ((pp <= 0.0 && pv != "0px") && self.defH >= 0.0);
        if (pp <= 0.0 && pv != "0px") && !from_def {
            return -1.0;
        }
        let mut inner: f64 = pp;
        if from_def {
            inner = self.defH;
        }
        if self.outerS.borrow().getText("box-sizing") == "border-box" && !from_def {
            inner = (((inner - DomView::pxOf(&self.outerS.borrow().getText(&format!("padding-{}", a)))) - DomView::pxOf(&self.outerS.borrow().getText(&format!("padding-{}", b)))) - DomView::pxOf(&self.outerS.borrow().getText(&format!("border-{}-width", a)))) - DomView::pxOf(&self.outerS.borrow().getText(&format!("border-{}-width", b)));
        }
        // an absolute box fills its containing block's padding box less
        // its insets; with none it starts at its static position, the
        // content edge (a grid's area is its padding box all the same)
        let sp: String = s.borrow().getText("position");
        if sp == "absolute" || sp == "fixed" {
            let pps: String = self.outerS.borrow().getText("position");
            if pps != "relative" && (pps != "absolute" && (pps != "fixed" && pps != "sticky")) {
                return -1.0;
            }
            let pad_a: f64 = DomView::pxOf(&self.outerS.borrow().getText(&format!("padding-{}", a)));
            inner = (inner + pad_a) + DomView::pxOf(&self.outerS.borrow().getText(&format!("padding-{}", b)));
            let ia: String = s.borrow().getText(&a);
            let ib: String = s.borrow().getText(&b);
            let ia_set: bool = !ia.is_empty() && ia != "auto";
            let ib_set: bool = !ib.is_empty() && ib != "auto";
            if ia_set {
                inner -= DomView::pxOf(&ia);
            }
            if ib_set {
                inner -= DomView::pxOf(&ib);
            }
            let pgd2: String = self.outerS.borrow().getText("display");
            if (!ia_set && !ib_set) && (pgd2 != "grid" && pgd2 != "inline-grid") {
                inner -= pad_a;
            }
        }
        let mut m_a: f64 = DomView::pxOf(&s.borrow().getText(&format!("margin-{}", a)));
        let mut m_b: f64 = DomView::pxOf(&s.borrow().getText(&format!("margin-{}", b)));
        // (a block's top and bottom margins that collapse with its
        // parent's are outside the parent: the box fills it all)
        let opd: String = self.outerS.borrow().getText("display");
        let oov: String = self.outerS.borrow().getText("overflow-y");
        if (tall && (sp != "absolute" && sp != "fixed")) && ((opd.is_empty() || opd == "block") && (oov.is_empty() || oov == "visible")) {
            if DomView::pxOf(&self.outerS.borrow().getText("padding-top")) == 0.0 && DomView::side(&self.outerS.clone(), "top") == 0.0 {
                m_a = 0.0;
            }
            if DomView::pxOf(&self.outerS.borrow().getText("padding-bottom")) == 0.0 && DomView::side(&self.outerS.clone(), "bottom") == 0.0 {
                m_b = 0.0;
            }
        }
        let mut f: f64 = (inner - m_a) - m_b;
        if s.borrow().getText("box-sizing") != "border-box" {
            f = (((f - DomView::pxOf(&s.borrow().getText(&format!("padding-{}", a)))) - DomView::pxOf(&s.borrow().getText(&format!("padding-{}", b)))) - DomView::pxOf(&s.borrow().getText(&format!("border-{}-width", a)))) - DomView::pxOf(&s.borrow().getText(&format!("border-{}-width", b)));
        }
        if f < 0.0 {
            f = 0.0;
        }
        f
    }
    fn style(&self, e: &Rc<RefCell<EVGElement>>, s: &Rc<RefCell<JsonValue>>, display: &str) {
        // EVG places an element with an inset out of flow; in CSS only an
        // absolute or fixed one is (a relative one's offset is left out)
        let pos: String = s.borrow().getText("position");
        let placed: bool = pos == "absolute" || pos == "fixed";
        // grid-area of lines (row-start / column-start / row-end /
        // column-end) is a grid-row and a grid-column; a name stays an area
        let ga0: String = s.borrow().getText("grid-area");
        let area_lines: bool = !ga0.is_empty() && (DomText::index_of(&ga0, "/") >= 0 || DomView::lineLike(&ga0));
        if area_lines {
            let gp: Vec<String> = ga0.split("/").map(|s| s.to_string()).collect::<Vec<String>>();
            let g1: String = gp[0].clone().trim().to_string();
            let mut g2: String = "auto".to_string();
            let mut g3: String = "auto".to_string();
            let mut g4: String = "auto".to_string();
            if (gp.len() as i64) > 1 {
                g2 = gp[1].clone().trim().to_string();
            }
            if (gp.len() as i64) > 2 {
                g3 = gp[2].clone().trim().to_string();
            }
            if (gp.len() as i64) > 3 {
                g4 = gp[3].clone().trim().to_string();
            }
            // (a missing name side takes the start's name)
            if (gp.len() as i64) <= 2 && !DomView::lineLike(&g1) {
                g3 = g1.clone();
            }
            if (gp.len() as i64) <= 3 && !DomView::lineLike(&g2) {
                g4 = g2.clone();
            }
            if !s.borrow().has("grid-row") {
                EVGElement::set_attribute(&e, "grid-row", format!("{} / {}", g1, g3));
            }
            if !s.borrow().has("grid-column") {
                EVGElement::set_attribute(&e, "grid-column", format!("{} / {}", g2, g4));
            }
        }
        // (a placement given by its longhands alone)
        let __v_gi0: Vec<String> = vec!["grid-column".to_string(), "grid-row".to_string()];
        let __n_gi0 = __v_gi0.len() as i64;
        for gi0 in 0..__n_gi0 {
            let gn = __v_gi0[gi0 as usize].clone();
            if !s.borrow().has(&gn) && (s.borrow().has(&format!("{}-start", gn)) || s.borrow().has(&format!("{}-end", gn))) {
                EVGElement::set_attribute(&e, &gn, DomView::placeOf(s, &gn));
            }
        }
        // a length flex-basis down a column is where the height starts
        // (EVG reads flex-basis along a row): as tall as the basis, no
        // less than its content when min-height is auto
        let mut cbv: String = s.borrow().getText("flex-basis");
        // (a percentage of the column's definite height)
        if ((cbv.as_bytes().len() as i64) > 1 && cbv[((cbv.as_bytes().len() as i64) - 1) as usize..(cbv.as_bytes().len() as i64) as usize].to_string() == "%") && self.defH >= 0.0 {
            let cbq: Option<f64> = cbv[(0) as usize..((cbv.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
            // (0 % stays: an image's 0 height would take its width too)
            if cbq.is_some() && cbq.unwrap() > 0.0 {
                cbv = format!("{}px", DomView::fmt((self.defH * cbq.unwrap()) / 100.0));
            }
        }
        let cbh: String = s.borrow().getText("height");
        let cpd0: String = self.outerS.borrow().getText("display");
        let cpf0: String = self.outerS.borrow().getText("flex-direction");
        // (a length basis down a column is the hypothetical height whatever
        // the height says, CSS Flexbox 9.2 3 A; EVG starts from the height)
        if (!placed && (cpd0 == "flex" || cpd0 == "inline-flex")) && (cpf0 == "column" || cpf0 == "column-reverse") {
            // (one below the height with min-height auto stays: the automatic
            // minimum is the smaller of the height and the content, 4.5)
            let cbm: String = s.borrow().getText("min-height");
            let cbm_auto: bool = cbm.is_empty() || cbm == "auto";
            if (cbv.ends_with("px") && cbh.ends_with("px")) && (DomView::pxOf(&cbv) > DomView::pxOf(&cbh) || ((!cbm_auto || s.borrow().getText("flex-shrink") == "0") && cbv != cbh)) {
                self.putPage(s, "height", &cbv);
            }
        }
        if (!placed && (cpd0 == "flex" || cpd0 == "inline-flex")) && (cpf0 == "column" || cpf0 == "column-reverse") {
            if ((cbv.as_bytes().len() as i64) > 2 && cbv[((cbv.as_bytes().len() as i64) - 2) as usize..(cbv.as_bytes().len() as i64) as usize].to_string() == "px") && (cbh.is_empty() || cbh == "auto") {
                let cbp: f64 = DomView::pxOf(&cbv);
                let cmh: String = s.borrow().getText("min-height");
                if cbp > 0.0 {
                    if cmh.is_empty() || cmh == "auto" {
                        EVGElement::set_attribute(&e, "min-height", cbv.clone());
                    } else {
                        EVGElement::set_attribute(&e, "height", cbv.clone());
                    }
                } else {
                    // (a 0 basis is the height when no automatic minimum
                    // holds it at its content)
                    if cbv == "0px" && (!cmh.is_empty() && cmh != "auto") {
                        EVGElement::set_attribute(&e, "height", "0px".to_string());
                    }
                }
            }
        }
        // (a growing item of a column with flex-basis auto grows from its
        // content, which EVG takes only when told)
        if (!placed && (cpd0 == "flex" || cpd0 == "inline-flex")) && (cpf0 == "column" || cpf0 == "column-reverse") {
            let cgo: Option<f64> = s.borrow().getText("flex-grow").parse::<f64>().ok();
            let mut cgv: f64 = 0.0;
            if cgo.is_some() {
                cgv = cgo.unwrap();
            }
            if cgv > 0.0 && ((cbv.is_empty() || cbv == "auto") && (cbh.is_empty() || cbh == "auto")) {
                EVGElement::set_attribute(&e, "flex-basis", "auto".to_string());
            }
        }
        // (a percentage flex-basis of a column whose main size is not
        // definite is the content's, CSS Flexbox 9.2 3)
        let pba: String = s.borrow().getText("flex-basis");
        let mut pba_auto: bool = false;
        if !placed && (((pba.as_bytes().len() as i64) > 1 && pba[((pba.as_bytes().len() as i64) - 1) as usize..(pba.as_bytes().len() as i64) as usize].to_string() == "%") && DomText::index_of(&pba, "(") < 0) {
            let pbd: String = self.outerS.borrow().getText("display");
            let pbf: String = self.outerS.borrow().getText("flex-direction");
            let pbwm: String = self.outerS.borrow().getText("writing-mode");
            let pb_vert: bool = DomText::index_of(&pbwm, "vertical") == 0 || DomText::index_of(&pbwm, "sideways") == 0;
            let pbw: String = self.outerS.borrow().getText("width");
            if (pbd == "flex" || pbd == "inline-flex") && (pbf == "column" || pbf == "column-reverse") {
                if !pb_vert && (self.defH < 0.0 && !self.defHMaybe) {
                    pba_auto = true;
                }
                if pb_vert && (pbw.is_empty() || pbw == "auto") {
                    pba_auto = true;
                }
            }
        }
        // (flex-basis: content sizes the item by its content along the main
        // axis, whatever its width or height there says, flexbox 7.2.3)
        let bcd: String = self.outerS.borrow().getText("display");
        let bcf: String = self.outerS.borrow().getText("flex-direction");
        let mut basis_skip: String = String::new();
        // (not a replaced box's: its own size is worked out from its width
        // further on)
        let btag: String = e.borrow().tag_name.clone();
        let breplaced: bool = btag == "img" || (btag == "canvas" || (btag == "video" || (btag == "svg" || (btag == "iframe" || (btag == "input" || (btag == "textarea" || (btag == "select" || btag == "button")))))));
        if ((!placed && s.borrow().getText("flex-basis") == "content") && ((bcd == "flex" || bcd == "inline-flex") && self.wm.is_empty())) && !breplaced {
            // (a row's: down a column the height still makes the item's
            // height definite for what is inside)
            if !(bcf == "column" || bcf == "column-reverse") {
                basis_skip = "width".to_string();
            }
        }
        // (a cell's percentage width is its column's, of the table: the
        // cell fills the column, CSS 2.1 17.5.2)
        if (s.borrow().getText("display") == "table-cell" && (bcd == "table" || bcd == "inline-table")) && s.borrow().getText("width").ends_with("%") {
            basis_skip = "width".to_string();
        }
        let tdisp: String = s.borrow().getText("display");
        let tbl_flex: bool = bcd == "flex" || bcd == "inline-flex";
        // (not a fixed one: its columns set its width, CSS 2.1 17.5.2.1)
        let tbl_item: bool = ((tdisp == "table" || tdisp == "inline-table") && self.wm.is_empty()) && !(s.borrow().getText("table-layout") == "fixed" && s.borrow().getText("width").ends_with("px"));
        let __v_i: Vec<String> = DomView::boxNames();
        let __n_i = __v_i.len() as i64;
        for i in 0..__n_i {
            let n = __v_i[i as usize].clone();
            if !placed && (n == "top" || (n == "right" || (n == "bottom" || n == "left"))) {
                continue;
            }
            if !basis_skip.is_empty() && n == basis_skip {
                continue;
            }
            // (a table is never smaller than its content, so as a flex item
            // its automatic or zero minimum is its min-content size, CSS 2.1
            // 17.5.2, Flexbox 4.5)
            // (not down a column with a flex basis, which is its height)
            let tfb: String = s.borrow().getText("flex-basis");
            if tbl_item && (n == "min-width" || ((n == "min-height" && (tbl_flex && !placed)) && ((tfb.is_empty() || tfb == "auto" || tfb == "content") || !(bcf == "column" || bcf == "column-reverse")))) {
                let tmv: String = s.borrow().getText(&n);
                if tmv.is_empty() || (tmv == "auto" || (tmv == "0px" || tmv == "0")) {
                    EVGElement::set_attribute(&e, &n, "min-content".to_string());
                    continue;
                }
            }
            // (a set width in px is clamped by its px min- and max-width
            // here, and the min-content minimum still raises it: EVG
            // measures a box's content within its own max-width)
            if tbl_item && ((n == "width" || n == "max-width") || n == "min-width") {
                let tw0: String = s.borrow().getText("width");
                let tx0: String = s.borrow().getText("max-width");
                let tn0: String = s.borrow().getText("min-width");
                if tw0.ends_with("px") && s.borrow().getText("box-sizing") != "border-box" {
                    if n == "max-width" && tx0.ends_with("px") {
                        continue;
                    }
                    if n == "min-width" && tn0.ends_with("px") {
                        EVGElement::set_attribute(&e, "min-width", "min-content".to_string());
                        continue;
                    }
                    if n == "width" {
                        let mut tv: f64 = DomView::pxOf(&tw0);
                        if tx0.ends_with("px") && DomView::pxOf(&tx0) < tv {
                            tv = DomView::pxOf(&tx0);
                        }
                        if tn0.ends_with("px") && DomView::pxOf(&tn0) > tv {
                            tv = DomView::pxOf(&tn0);
                        }
                        EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(tv)));
                        continue;
                    }
                }
            }
            if n == "flex-basis" && pba_auto {
                EVGElement::set_attribute(&e, "flex-basis", "auto".to_string());
                continue;
            }
            if area_lines && n == "grid-area" {
                continue;
            }
            // (a linear gradient is EVG's background-gradient, painted under
            // the content; a picture's url() stays background-image)
            if n == "background-image" && (DomText::index_of(&s.borrow().getText(&n), "linear-gradient(") == 0 || DomText::index_of(&s.borrow().getText(&n), "repeating-linear-gradient(") == 0) {
                let lg: String = s.borrow().getText(&n);
                // (only one that fills the box: a set size or place is not
                // drawn)
                let lgs: String = s.borrow().getText("background-size");
                let lgp: String = s.borrow().getText("background-position");
                let fills: bool = (lgs.is_empty() || (lgs == "auto" || lgs == "auto auto")) && (lgp.is_empty() || (lgp == "0% 0%" || (lgp == "0px 0px" || lgp == "left top")));
                if (DomText::index_of(&lg, "), linear-gradient(") < 0 && (DomText::index_of(&lg, "), repeating-") < 0 && DomText::index_of(&lg, "url(") < 0)) && fills {
                    EVGElement::set_attribute(&e, "background-gradient", lg.clone());
                }
                continue;
            }
            // (a table's cells, rows and groups have no margins, CSS 2.1
            // 8.3)
            if DomText::index_of(&n, "margin-") == 0 && (display == "table-cell" || (display == "table-row" || (display == "table-row-group" || (display == "table-header-group" || (display == "table-footer-group" || (display == "table-column" || display == "table-column-group")))))) {
                continue;
            }
            if s.borrow().has(&n) {
                let mut v: String = s.borrow().getText(&n);
                // (track lists keep em as written; EVG takes px)
                if DomText::index_of(&n, "grid-template-") == 0 || DomText::index_of(&n, "grid-auto-") == 0 {
                    if DomText::index_of(&v, "em") > 0 {
                        v = DomView::emToPx(&v, self.emPx);
                    }
                }
                if DomView::stretchy(&v) && (DomText::index_of(&n, "width") >= 0 || (DomText::index_of(&n, "height") >= 0 || n == "flex-basis")) {
                    // stretch: the parent's content box less the margins,
                    // when the parent's size is set there. A grid item's
                    // and a flex item's across its line is its area's or
                    // line's: the self-alignment stretch
                    let ogd: String = self.outerS.borrow().getText("display");
                    let ofd: String = self.outerS.borrow().getText("flex-direction");
                    let in_grid_s: bool = ogd == "grid" || ogd == "inline-grid";
                    let col_flex: bool = (ogd == "flex" || ogd == "inline-flex") && (ofd == "column" || ofd == "column-reverse");
                    let row_flex: bool = (ogd == "flex" || ogd == "inline-flex") && !col_flex;
                    let sabs: String = s.borrow().getText("position");
                    let in_flow_s: bool = sabs != "absolute" && sabs != "fixed";
                    if n == "width" && (in_flow_s && (in_grid_s || col_flex)) {
                        if in_grid_s {
                            EVGElement::set_attribute(&e, "justify-self", "stretch".to_string());
                        } else {
                            EVGElement::set_attribute(&e, "align-self", "stretch".to_string());
                            // (in a wrapping column the lines are not the
                            // container's width: measured at the container's,
                            // then stretched to its line)
                            let ofw0: String = self.outerS.borrow().getText("flex-wrap");
                            if ofw0 == "wrap" || ofw0 == "wrap-reverse" {
                                let cf: f64 = self.fillOf(s, &n);
                                if cf >= 0.0 {
                                    EVGElement::set_attribute(&e, "min-width", format!("{}px", DomView::fmt(cf)));
                                }
                            }
                        }
                        continue;
                    }
                    if n == "height" && (in_flow_s && (in_grid_s || row_flex)) {
                        EVGElement::set_attribute(&e, "align-self", "stretch".to_string());
                        continue;
                    }
                    // (a block in a block's flow: the width auto gives, which
                    // also keeps clear of floats beside a formatting context)
                    let sd_s: String = s.borrow().getText("display");
                    let sfl_s: String = s.borrow().getText("float");
                    if n == "width" && in_flow_s && !in_grid_s && !row_flex && !col_flex && (sfl_s.is_empty() || sfl_s == "none") && (sd_s == "block" || sd_s == "flow-root" || sd_s == "list-item") && s.borrow().getText("margin-left") != "auto" && s.borrow().getText("margin-right") != "auto" && self.wm.is_empty() {
                        EVGElement::set_attribute(&e, "width", "auto".to_string());
                        continue;
                    }
                    // (in a wrapping flex container the line's cross size is
                    // not known here. A min- stretch is the stretch to the
                    // line, no less than the item's own size; a max- one is
                    // the stretch to the line no more than its own size, and
                    // no less than that size limited by the container, which
                    // is what the item puts in the line)
                    let ofw: String = self.outerS.borrow().getText("flex-wrap");
                    let wrap_f: bool = (row_flex || col_flex) && (ofw == "wrap" || ofw == "wrap-reverse");
                    let mut cross_ax: String = "height".to_string();
                    if col_flex {
                        cross_ax = "width".to_string();
                    }
                    let min_max: bool = DomText::index_of(&n, "min-") == 0 || DomText::index_of(&n, "max-") == 0;
                    let own_px: String = s.borrow().getText(&cross_ax);
                    if (wrap_f && in_flow_s) && (DomText::index_of(&n, "max-") == 0 && DomText::index_of(&n, &cross_ax) >= 0) {
                        let own_v: f64 = DomView::pxOf(&own_px);
                        let mut lim: f64 = self.fillOf(s, &n);
                        if DomText::index_of(&own_px, "px") > 0 && lim >= 0.0 {
                            if lim > own_v {
                                lim = own_v;
                            }
                            EVGElement::set_attribute(&e, &cross_ax.clone(), "auto".to_string());
                            EVGElement::set_attribute(&e, "align-self", "stretch".to_string());
                            EVGElement::set_attribute(&e, &n, own_px.clone());
                            EVGElement::set_attribute(
                                &e,
                                &format!("min-{}", cross_ax),
                                format!("{}px", DomView::fmt(lim))
                            );
                            continue;
                        }
                    }
                    if (wrap_f && in_flow_s) && (min_max && DomText::index_of(&n, &cross_ax) >= 0) {
                        if DomText::index_of(&n, "min-") == 0 {
                            let own_c: String = s.borrow().getText(&cross_ax);
                            EVGElement::set_attribute(&e, &cross_ax, "auto".to_string());
                            EVGElement::set_attribute(&e, "align-self", "stretch".to_string());
                            if !own_c.is_empty() && own_c != "auto" {
                                EVGElement::set_attribute(&e, &n, own_c.clone());
                            }
                        }
                        continue;
                    }
                    // (in an auto row a max-height does not resolve while
                    // the row is sized, so the row fits the item and the
                    // limit is the item's own height)
                    let ogr: String = self.outerS.borrow().getText("grid-template-rows");
                    if in_grid_s && (in_flow_s && (n == "max-height" && (ogr.is_empty() || (ogr == "none" || ogr == "auto")))) {
                        continue;
                    }
                    // (a grid item's min- and max- sizes are its area's,
                    // less its margins: a percentage of the area)
                    if in_grid_s && (in_flow_s && (DomText::index_of(&n, "min-") == 0 || DomText::index_of(&n, "max-") == 0)) {
                        let mut sa: String = "left".to_string();
                        let mut sb: String = "right".to_string();
                        if DomText::index_of(&n, "height") >= 0 {
                            sa = "top".to_string();
                            sb = "bottom".to_string();
                        }
                        let mut less: f64 = DomView::pxOf(&s.borrow().getText(&format!("margin-{}", sa))) + DomView::pxOf(&s.borrow().getText(&format!("margin-{}", sb)));
                        if s.borrow().getText("box-sizing") != "border-box" {
                            less = (((less + DomView::pxOf(&s.borrow().getText(&format!("padding-{}", sa)))) + DomView::pxOf(&s.borrow().getText(&format!("padding-{}", sb)))) + DomView::pxOf(&s.borrow().getText(&format!("border-{}-width", sa)))) + DomView::pxOf(&s.borrow().getText(&format!("border-{}-width", sb)));
                        }
                        EVGElement::set_attribute(&e, &n, format!("calc(100% - {}px)", DomView::fmt(less)));
                        continue;
                    }
                    let fill: f64 = self.fillOf(s, &n);
                    if fill >= 0.0 {
                        EVGElement::set_attribute(&e, &n, format!("{}px", DomView::fmt(fill)));
                        // (a block does not shrink in its parent's column)
                        if n == "height" && (ogd == "block" || ogd.is_empty()) {
                            EVGElement::set_attribute(&e, "flex-shrink", "0".to_string());
                        }
                    } else {
                        // (an indefinite min- stretch is 0, not the
                        // automatic minimum)
                        if DomText::index_of(&n, "min-") == 0 {
                            EVGElement::set_attribute(&e, &n, "0px".to_string());
                        }
                    }
                    continue;
                }
                // (an absolute box's percentage width is of its containing
                // block's padding box, CSS 2.1 10.1: its parent's, when
                // that is positioned with a px width)
                if (n == "width" || (n == "min-width" || n == "max-width")) && ((v.as_bytes().len() as i64) > 1 && v[((v.as_bytes().len() as i64) - 1) as usize..(v.as_bytes().len() as i64) as usize].to_string() == "%") && s.borrow().getText("position") == "absolute" {
                    let apos: String = self.outerS.borrow().getText("position");
                    let apw: String = self.outerS.borrow().getText("width");
                    let apl: f64 = DomView::pxOf(&self.outerS.borrow().getText("padding-left"));
                    let apr: f64 = DomView::pxOf(&self.outerS.borrow().getText("padding-right"));
                    let apq: Option<f64> = v[(0) as usize..((v.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                    // (in a grid it is of its grid area)
                    let apd: String = self.outerS.borrow().getText("display");
                    if (apd != "grid" && apd != "inline-grid") && (apos == "relative" || (apos == "absolute" || apos == "sticky")) && (apw.ends_with("px") && (apl + apr > 0.0 && (self.outerS.borrow().getText("box-sizing") != "border-box" && (apq.is_some() && self.wm.is_empty())))) {
                        let apb: f64 = (DomView::pxOf(&apw) + apl) + apr;
                        v = format!("{}px", DomView::fmt((apq.unwrap() * apb) / 100.0));
                    }
                }
                // (a percentage max-height of a parent whose height is
                // not set is none)
                if n == "max-height" && ((v.as_bytes().len() as i64) > 1 && v[((v.as_bytes().len() as i64) - 1) as usize..(v.as_bytes().len() as i64) as usize].to_string() == "%") {
                    let oh: String = self.outerS.borrow().getText("height");
                    let opos: String = self.outerS.borrow().getText("position");
                    let odis: String = self.outerS.borrow().getText("display");
                    let mut ofree: bool = (oh.is_empty() || oh == "auto") && ((opos != "absolute" && opos != "fixed") && (odis == "block" || (odis == "inline-block" || odis == "list-item")));
                    // (nor of a flex or grid container whose height is not
                    // definite)
                    let oflex: bool = odis == "flex" || (odis == "inline-flex" || (odis == "grid" || odis == "inline-grid"));
                    if (oflex && (oh.is_empty() || oh == "auto")) && self.defH < 0.0 {
                        ofree = true;
                    }
                    // (one whose height may be known once it is laid out
                    // keeps it, as none until then, pct-auto)
                    if (ofree && !placed) && (self.defHMaybe && self.defH < 0.0) {
                        EVGElement::set_attribute(&e, "pct-auto", "true".to_string());
                        ofree = false;
                    }
                    if ofree && !placed {
                        continue;
                    }
                }
                // (down a column of a vertical frame, which is across the
                // page, left and right are where they say)
                if n == "justify-content" && (!self.wm.is_empty() && (v == "left" || v == "right")) {
                    let jfd: String = s.borrow().getText("flex-direction");
                    if jfd == "column" || jfd == "column-reverse" {
                        let phys_end: bool = (v == "left") == (self.wm == "vertical-rl");
                        if phys_end {
                            v = "end".to_string();
                        } else {
                            v = "start".to_string();
                        }
                    }
                }
                if v != "auto" && (v != "normal" && v != "none") {
                    EVGElement::set_attribute(&e, &n, v.clone());
                }
                // (a flex item's align-self: normal is the stretch, not
                // its container's align-items)
                if n == "align-self" && v == "normal" {
                    EVGElement::set_attribute(&e, &n, "stretch".to_string());
                }
                // an auto margin: a flex item's takes free space on either
                // axis, a block's left and right centre it when it has a
                // width (else they are 0 and it fills the line)
                if v == "auto" && (!placed && DomText::index_of(&n, "margin-") == 0) {
                    let across: bool = n == "margin-left" || n == "margin-right";
                    let w: String = s.borrow().getText("width");
                    // (an inline-level box's or a float's auto margins are 0,
                    // CSS 2.1 10.3.2, 10.3.9 and 10.3.5)
                    let adsp: String = s.borrow().getText("display");
                    let afl2: String = s.borrow().getText("float");
                    let in_line: bool = adsp.starts_with("inline") || (!afl2.is_empty() && afl2 != "none");
                    if self.inFlex || across && (!w.is_empty() && w != "auto") && !in_line {
                        EVGElement::set_attribute(&e, &n, "auto".to_string());
                    }
                }
                // (an absolute box's between two insets share the room left)
                if v == "auto" && (placed && DomText::index_of(&n, "margin-") == 0) {
                    let acr: bool = n == "margin-left" || n == "margin-right";
                    let mut i1: String = "top".to_string();
                    let mut i2: String = "bottom".to_string();
                    if acr {
                        i1 = "left".to_string();
                        i2 = "right".to_string();
                    }
                    let v1: String = s.borrow().getText(&i1);
                    let v2: String = s.borrow().getText(&i2);
                    if (!v1.is_empty() && v1 != "auto") && (!v2.is_empty() && v2 != "auto") {
                        EVGElement::set_attribute(&e, &n, "auto".to_string());
                    }
                }
            }
        }
        // (a box in a block's flow keeps its height: a block's children
        // overflow it, they do not shrink, CSS 2.1 10.6.3)
        let bgd: String = self.outerS.borrow().getText("display");
        let flow_parent: bool = ((bgd == "block" || bgd == "flow-root") || (bgd == "list-item" || bgd == "inline-block")) || bgd.is_empty();
        if (flow_parent && !placed) && !self.inFlex {
            EVGElement::set_attribute(&e, "flex-shrink", "0".to_string());
            // (a percentage height of a block whose height is not definite
            // is auto, and so is such a min-height, CSS 2.1 10.5)
            if self.defH < 0.0 && !self.defHMaybe {
                let __v_phi: Vec<String> = vec!["height".to_string(), "min-height".to_string()];
                let __n_phi = __v_phi.len() as i64;
                for phi in 0..__n_phi {
                    let phn = __v_phi[phi as usize].clone();
                    let phv: String = s.borrow().getText(&phn);
                    if (phv.as_bytes().len() as i64) > 1 && (phv[((phv.as_bytes().len() as i64) - 1) as usize..(phv.as_bytes().len() as i64) as usize].to_string() == "%" && DomText::index_of(&phv, "(") < 0) {
                        EVGElement::set_attribute(&e, &phn, "auto".to_string());
                    }
                }
            }
            // (a definite height its parent has from elsewhere than its own
            // height, an inflexible column item's basis: the percentage of
            // it, in px)
            let pdh: String = self.outerS.borrow().getText("height");
            let pdmx: String = self.outerS.borrow().getText("max-height");
            let pdmn: String = self.outerS.borrow().getText("min-height");
            let pd_lim: bool = (!pdmx.is_empty() && pdmx != "none") || (!pdmn.is_empty() && pdmn != "auto" && pdmn != "0px");
            if self.defH >= 0.0 && !pdh.ends_with("px") && !pdh.ends_with("%") && !pd_lim {
                let pdv: String = s.borrow().getText("height");
                let pdp: String = s.borrow().getText("position");
                if (pdv.as_bytes().len() as i64) > 1 && (pdv.ends_with("%") && DomText::index_of(&pdv, "(") < 0) && pdp != "absolute" && pdp != "fixed" {
                    let pdq: Option<f64> = pdv[0..((pdv.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                    if pdq.is_some() {
                        EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt((self.defH * pdq.unwrap()) / 100.0)));
                    }
                }
            }
            // (one whose height may only be known once it is laid out, a
            // stretched flex item's, is auto until then: EVG lays it out
            // again in that height)
            if self.defH < 0.0 && self.defHMaybe {
                let pav: String = s.borrow().getText("height");
                if (pav.as_bytes().len() as i64) > 1 && (pav[((pav.as_bytes().len() as i64) - 1) as usize..(pav.as_bytes().len() as i64) as usize].to_string() == "%" && DomText::index_of(&pav, "(") < 0) {
                    EVGElement::set_attribute(&e, "pct-auto", "true".to_string());
                }
            }
        }
        // (a percentage height of a definite one with an aspect-ratio: in
        // px, so the ratio gives the width it asks for while it is measured,
        // CSS Sizing 4, 5.1)
        let arv: String = s.borrow().getText("aspect-ratio");
        if self.defH >= 0.0 && (!arv.is_empty() && arv != "auto") {
            let arh: String = s.borrow().getText("height");
            let arp: String = s.borrow().getText("position");
            if ((arh.as_bytes().len() as i64) > 1 && (arh[((arh.as_bytes().len() as i64) - 1) as usize..(arh.as_bytes().len() as i64) as usize].to_string() == "%" && DomText::index_of(&arh, "(") < 0)) && (arp != "absolute" && arp != "fixed") {
                let arq: Option<f64> = arh[(0) as usize..((arh.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                if arq.is_some() {
                    EVGElement::set_attribute(
                        &e,
                        "height",
                        format!("{}px", DomView::fmt((self.defH * arq.unwrap()) / 100.0))
                    );
                }
            }
        }
        // (an auto width with an aspect-ratio follows the height as its
        // min- and max-height hold it, and with no height a min-height
        // still gives the least width, CSS Sizing 4 5.1)
        if !arv.is_empty() && arv != "auto" && self.wm.is_empty() && (s.borrow().getText("width").is_empty() || s.borrow().getText("width") == "auto") && s.borrow().getText("min-width").is_empty() {
            let arpos: String = s.borrow().getText("position");
            let arr: f64 = DomView::ratioOf(&arv);
            if arr > 0.0 && arpos != "absolute" && arpos != "fixed" && s.borrow().getText("box-sizing") != "border-box" {
                let hv: f64 = self.lenOrPctH(&s.borrow().getText("height"));
                let mnh: f64 = self.lenOrPctH(&s.borrow().getText("min-height"));
                let mxh: f64 = self.lenOrPctH(&s.borrow().getText("max-height"));
                if hv >= 0.0 {
                    let mut hh: f64 = hv;
                    if mxh >= 0.0 && hh > mxh {
                        hh = mxh;
                    }
                    if mnh >= 0.0 && hh < mnh {
                        hh = mnh;
                    }
                    // (raised by its min-height; one a max-height lowers keeps
                    // its content's least width, which EVG gives it)
                    if hh > hv {
                        EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(hh * arr)));
                    }
                } else {
                    if mnh > 0.0 {
                        EVGElement::set_attribute(&e, "min-width", format!("{}px", DomView::fmt(mnh * arr)));
                    }
                }
            }
        }
        // (a flex row's item stretched to a definite line: its height is
        // definite, so the ratio gives its width, CSS Flexbox 9.8)
        let arfw: f64 = self.stretchedRatioWidth(s);
        if arfw >= 0.0 {
            EVGElement::set_attribute(&e, "flex-basis", format!("{}px", DomView::fmt(arfw)));
        }
        // (a percentage min-height of a flex item whose container's height
        // is not definite is 0, not the automatic minimum)
        if ((bgd == "flex" || bgd == "inline-flex") && !placed) && (self.defH < 0.0 && !self.defHMaybe) {
            let fmh: String = s.borrow().getText("min-height");
            if (fmh.as_bytes().len() as i64) > 1 && (fmh[((fmh.as_bytes().len() as i64) - 1) as usize..(fmh.as_bytes().len() as i64) as usize].to_string() == "%" && DomText::index_of(&fmh, "(") < 0) {
                EVGElement::set_attribute(&e, "min-height", "0px".to_string());
            }
        }
        // (a flex item of a row that neither grows nor shrinks is its flex
        // base size, its max-content width, CSS Flexbox 9.2 and 9.7)
        if (bgd == "flex" || bgd == "inline-flex") && !placed {
            let nfd: String = self.outerS.borrow().getText("flex-direction");
            let nw: String = s.borrow().getText("width");
            let nb: String = s.borrow().getText("flex-basis");
            let ng: String = s.borrow().getText("flex-grow");
            let row_item: bool = nfd.is_empty() || (nfd == "row" || nfd == "row-reverse");
            let auto_item: bool = (nw.is_empty() || nw == "auto") && (nb.is_empty() || (nb == "auto" || nb == "content"));
            if (row_item && auto_item) && (s.borrow().getText("flex-shrink") == "0" && (ng.is_empty() || ng == "0")) {
                EVGElement::set_attribute(&e, "width", "max-content".to_string());
            }
            // (an intrinsic height keyword is not auto: the item is not
            // stretched across its line)
            let nh: String = s.borrow().getText("height");
            if row_item && (nh == "min-content" || (nh == "max-content" || nh == "fit-content")) {
                let mut nas: String = s.borrow().getText("align-self");
                if nas.is_empty() || nas == "auto" {
                    nas = self.outerS.borrow().getText("align-items");
                }
                if nas.is_empty() || (nas == "normal" || nas == "stretch") {
                    EVGElement::set_attribute(&e, "align-self", "flex-start".to_string());
                }
            }
            // (down a column aligned to the start an item is as wide as its
            // content: EVG shrinks one that says so itself)
            let cas: String = s.borrow().getText("align-self");
            if !row_item && (cas.is_empty() || cas == "auto") {
                let cai: String = self.outerS.borrow().getText("align-items");
                if cai == "flex-start" || (cai == "start" || cai == "self-start") {
                    EVGElement::set_attribute(&e, "align-self", "flex-start".to_string());
                }
            }
        }
        // an inline-level box or a float is as wide as what it holds, up to
        // the line (shrink-to-fit)
        let wv: String = s.borrow().getText("width");
        let mut fit_w: bool = false;
        if wv.is_empty() || wv == "auto" {
            let fl0: String = s.borrow().getText("float");
            if display == "inline-block" || (display == "inline-flex" || (display == "inline-grid" || (display == "inline-table" || (fl0 == "left" || fl0 == "right")))) {
                EVGElement::set_attribute(&e, "width", "fit-content".to_string());
                fit_w = true;
            }
            // (an absolute grid not held by both insets fits its tracks)
            if (placed && display == "grid") && !(s.borrow().has("left") && s.borrow().has("right")) {
                EVGElement::set_attribute(&e, "width", "fit-content".to_string());
                fit_w = true;
            }
        }
        // border-spacing (separate borders): around the cells inside the
        // table's border, and between its rows and its cells (CSS 2.1 17.6.1)
        if s.borrow().getText("border-collapse") != "collapse" {
            let bsp: Vec<String> = s.borrow().getText("border-spacing")
                .trim()
                .to_string()
                .split(" ")
                .map(|s| s.to_string())
                .collect::<Vec<String>>();
            let mut bs_h: f64 = 0.0;
            let mut bs_v: f64 = 0.0;
            if !bsp.is_empty() {
                bs_h = DomView::pxOf(&bsp[0].clone());
                bs_v = bs_h;
            }
            if (bsp.len() as i64) > 1 {
                bs_v = DomView::pxOf(&bsp[1].clone());
            }
            if (bs_h > 0.0 || bs_v > 0.0) && (display == "table" || display == "inline-table") {
                EVGElement::set_attribute(&e, "padding-left", format!("{}px", DomView::fmt(DomView::pxOf(&s.borrow().getText("padding-left")) + bs_h)));
                EVGElement::set_attribute(&e, "padding-right", format!("{}px", DomView::fmt(DomView::pxOf(&s.borrow().getText("padding-right")) + bs_h)));
                EVGElement::set_attribute(&e, "padding-top", format!("{}px", DomView::fmt(DomView::pxOf(&s.borrow().getText("padding-top")) + bs_v)));
                EVGElement::set_attribute(&e, "padding-bottom", format!("{}px", DomView::fmt(DomView::pxOf(&s.borrow().getText("padding-bottom")) + bs_v)));
                EVGElement::set_attribute(&e, "row-gap", format!("{}px", DomView::fmt(bs_v)));
                EVGElement::set_attribute(&e, "column-gap", format!("{}px", DomView::fmt(bs_h)));
            }
            if bs_v > 0.0 && (display == "table-row-group" || (display == "table-header-group" || display == "table-footer-group")) {
                EVGElement::set_attribute(&e, "row-gap", format!("{}px", DomView::fmt(bs_v)));
            }
            if bs_h > 0.0 && display == "table-row" {
                EVGElement::set_attribute(&e, "column-gap", format!("{}px", DomView::fmt(bs_h)));
            }
        }
        // size containment: the box is sized as if it held nothing, or
        // contain-intrinsic-size's lengths (CSS Containment 3.2, CSS
        // Sizing 4 5.2), its content laid out in it all the same
        let ctn: String = s.borrow().getText("contain");
        let mut c_size_h: bool = DomText::index_of(&ctn, "size") >= 0 && DomText::index_of(&ctn, "inline-size") < 0;
        if DomText::index_of(&ctn, "strict") >= 0 {
            c_size_h = true;
        }
        let c_size_w: bool = DomView::sizeContained(s);
        // (layout containment: no baseline from its content, its border
        // box's bottom stands for it, CSS Containment 3.3)
        if (DomText::index_of(&ctn, "layout") >= 0 || DomText::index_of(&ctn, "strict") >= 0) || DomText::index_of(&ctn, "content") >= 0 {
            EVGElement::set_attribute(&e, "baseline-from-bottom", "0".to_string());
        }
        if c_size_w {
            let cis: Vec<String> = s.borrow().getText("contain-intrinsic-size")
                .trim()
                .to_string()
                .split(" ")
                .map(|s| s.to_string())
                .collect::<Vec<String>>();
            let mut cis_w: f64 = 0.0;
            let mut cis_h: f64 = 0.0;
            let mut cvs: Vec<String> = Vec::new();
            for cv in cis.iter().cloned() {
                if !cv.is_empty() && cv != "auto" {
                    cvs.push(cv.clone());
                }
            }
            if !cvs.is_empty() {
                cis_w = DomView::pxOf(&cvs[0].clone());
                cis_h = cis_w;
            }
            if (cvs.len() as i64) > 1 {
                cis_h = DomView::pxOf(&cvs[1].clone());
            }
            let cbs: bool = s.borrow().getText("box-sizing") == "border-box";
            // (as a flex or grid item, or measured by a box that fits it,
            // its content counts as that width)
            if wv.is_empty() || wv == "auto" {
                EVGElement::set_attribute(&e, "contain-w", DomView::fmt(cis_w));
            }
            // (a content keyword width is the contained content's, those
            // lengths, CSS Sizing 4 5.2)
            let kw_w: bool = wv == "min-content" || (wv == "max-content" || (wv == "fit-content" || wv == "-webkit-fit-content"));
            if (fit_w || placed && (wv.is_empty() || wv == "auto")) || kw_w {
                let mut cwx: f64 = cis_w;
                if cbs {
                    cwx += ((DomView::pxOf(&s.borrow().getText("padding-left")) + DomView::pxOf(&s.borrow().getText("padding-right"))) + DomView::side(s, "left")) + DomView::side(s, "right");
                }
                EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(cwx)));
            }
            let chv: String = s.borrow().getText("height");
            // (an aspect-ratio with a ratio gives the height from a set
            // width: containment drops only the natural ratio)
            let car: String = s.borrow().getText("aspect-ratio");
            let car_w: bool = (!car.is_empty() && car.trim() != "auto") && (!wv.is_empty() && wv != "auto");
            // (an item of a flex row: its content size along the row is the
            // contained width, its flex basis when that is auto; it is
            // stretched across the row as any item is)
            let cfd: String = self.outerS.borrow().getText("display");
            let cfdir: String = self.outerS.borrow().getText("flex-direction");
            let c_row_item: bool = ((!placed && (cfd == "flex" || cfd == "inline-flex")) && (cfdir.is_empty() || (cfdir == "row" || cfdir == "row-reverse"))) && self.wm.is_empty();
            let cfb: String = s.borrow().getText("flex-basis");
            if (c_row_item && (wv.is_empty() || wv == "auto")) && (cfb.is_empty() || cfb == "auto" || cfb == "content") {
                let mut cbx: f64 = cis_w;
                if cbs {
                    cbx += ((DomView::pxOf(&s.borrow().getText("padding-left")) + DomView::pxOf(&s.borrow().getText("padding-right"))) + DomView::side(s, "left")) + DomView::side(s, "right");
                }
                EVGElement::set_attribute(&e, "flex-basis", format!("{}px", DomView::fmt(cbx)));
            }
            let cas: String = DomView::or(&s.borrow().getText("align-self"), &self.outerS.borrow().getText("align-items"));
            // (as tall as the line: a definite container's; otherwise the line is
            // its contained height)
            let c_stretched: bool = (c_row_item && self.defH >= 0.0) && (cas.is_empty() || (cas == "auto" || (cas == "normal" || cas == "stretch")));
            // (stretched, it is no shorter than that content: the line is as
            // tall as it, at least)
            let cmh: String = s.borrow().getText("min-height");
            if ((c_stretched && c_size_h) && (chv.is_empty() || chv == "auto")) && (cmh.is_empty() || cmh == "auto") {
                let mut cmx: f64 = cis_h;
                if cbs {
                    cmx += ((DomView::pxOf(&s.borrow().getText("padding-top")) + DomView::pxOf(&s.borrow().getText("padding-bottom"))) + DomView::side(s, "top")) + DomView::side(s, "bottom");
                }
                EVGElement::set_attribute(&e, "min-height", format!("{}px", DomView::fmt(cmx)));
            }
            if ((c_size_h && (chv.is_empty() || chv == "auto")) && !car_w) && !c_stretched {
                let mut chx: f64 = cis_h;
                if cbs {
                    chx += ((DomView::pxOf(&s.borrow().getText("padding-top")) + DomView::pxOf(&s.borrow().getText("padding-bottom"))) + DomView::side(s, "top")) + DomView::side(s, "bottom");
                }
                EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt(chx)));
            }
        }
        if placed {
            // (its insets are from the page's corner then too)
            if self.positioned == 0 && pos == "absolute" {
                let mut icb_ax: String = String::new();
                if DomView::inset(s, "left") || DomView::inset(s, "right") {
                    icb_ax = "x".to_string();
                }
                if DomView::inset(s, "top") || DomView::inset(s, "bottom") {
                    icb_ax = format!("{}y", icb_ax);
                }
                if !icb_ax.is_empty() {
                    EVGElement::set_attribute(&e, "icb", icb_ax.clone());
                }
            }
            // a percentage size of the viewport, when no positioned box is
            // around it (EVG takes it of the parent)
            if self.positioned == 0 || pos == "fixed" {
                let __v_pi: Vec<String> = vec!["width".to_string(), "height".to_string(), "min-width".to_string(), "min-height".to_string(), "max-width".to_string(), "max-height".to_string()];
                let __n_pi = __v_pi.len() as i64;
                for pi in 0..__n_pi {
                    let pn = __v_pi[pi as usize].clone();
                    let pv: String = s.borrow().getText(&pn);
                    if (pv.as_bytes().len() as i64) > 1 && pv[((pv.as_bytes().len() as i64) - 1) as usize..(pv.as_bytes().len() as i64) as usize].to_string() == "%" {
                        let frac: Option<f64> = pv[(0) as usize..((pv.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                        if frac.is_some() {
                            let mut span: f64 = self.vw;
                            if DomText::index_of(&pn, "height") >= 0 {
                                span = self.vh;
                            }
                            EVGElement::set_attribute(
                                &e,
                                &pn,
                                format!("{}px", DomView::fmt((frac.unwrap() / 100.0) * span))
                            );
                        }
                    }
                }
            }
            // with no inset it is out of flow all the same, at its static
            // place: EVG takes a box with none as in flow, so it gets the
            // parent's content corner, which the static place is when it
            // comes first (a page's wrapper, a dialog's frame)
            if !s.borrow().has("top") && (!s.borrow().has("bottom") && (!s.borrow().has("left") && !s.borrow().has("right"))) {
                EVGElement::set_attribute(&e, "top", "0px".to_string());
                // (right to left, its static place is at the right content
                // edge, CSS 2.1 10.3.7)
                let sd: String = self.outerS.borrow().getText("display");
                let s_flow: bool = sd != "grid" && sd != "inline-grid" && sd != "flex" && sd != "inline-flex";
                if s_flow && self.dirNow == "rtl" {
                    EVGElement::set_attribute(&e, "right", "0px".to_string());
                } else {
                    EVGElement::set_attribute(&e, "left", "0px".to_string());
                }
                // (a fixed box too: placed where it is, as an absolute one)
                if s.borrow().getText("position") == "fixed" {
                    EVGElement::set_attribute(&e, "position", "absolute".to_string());
                }
                // in a flex container: where the container would put it
                // as its only item
                let pd: String = self.outerS.borrow().getText("display");
                // (in a grid, aligned in its grid area)
                if pd == "flex" || (pd == "inline-flex" || (pd == "grid" || pd == "inline-grid")) {
                    EVGElement::set_attribute(&e, "static-flex", "true".to_string());
                } else {
                    // (in a block, under the boxes before it)
                    EVGElement::set_attribute(&e, "static-flow", "true".to_string());
                }
            } else {
                // in a grid an axis with no inset is aligned in the area
                // all the same (justify-self, align-self)
                let gd: String = self.outerS.borrow().getText("display");
                // (in a block, with no top or bottom: under the boxes before
                // it)
                let block_p: bool = gd != "grid" && (gd != "inline-grid" && (gd != "flex" && gd != "inline-flex"));
                if block_p && (!s.borrow().has("top") && !s.borrow().has("bottom")) {
                    EVGElement::set_attribute(&e, "static-flow", "true".to_string());
                    // (its top margin below that place, as with no inset)
                    EVGElement::set_attribute(&e, "top", "0px".to_string());
                }
                if block_p && (!s.borrow().has("left") && !s.borrow().has("right")) && self.dirNow == "rtl" {
                    EVGElement::set_attribute(&e, "right", "0px".to_string());
                }
                if gd == "grid" || gd == "inline-grid" {
                    if !s.borrow().has("top") && !s.borrow().has("bottom") {
                        EVGElement::set_attribute(&e, "top", "0px".to_string());
                        EVGElement::set_attribute(&e, "static-flex", "y".to_string());
                    }
                    if !s.borrow().has("left") && !s.borrow().has("right") {
                        EVGElement::set_attribute(&e, "left", "0px".to_string());
                        EVGElement::set_attribute(&e, "static-flex", "x".to_string());
                    }
                }
            }
            // an inset is from the parent's padding edge in CSS and from
            // its content edge in EVG
            // (in a grid an item has its area for the containing block,
            // the padding box when its lines are auto, EVG's too)
            // (a parent that is not positioned is not its containing
            // block: the positioned box around it is, which EVG lays it out
            // in again along the axes it has an inset on)
            let mut cb_s: Rc<RefCell<JsonValue>> = self.outerS.clone().clone();
            let mut cb_up: bool = false;
            let opos0: String = self.outerS.borrow().getText("position");
            let parent_cb: bool = opos0 == "absolute" || (opos0 == "fixed" || (opos0 == "relative" || opos0 == "sticky"));
            if (pos == "absolute" && !parent_cb) && !self.cbStyles.is_empty() {
                let mut cb_ax: String = String::new();
                if DomView::inset(s, "left") || DomView::inset(s, "right") {
                    cb_ax = "x".to_string();
                }
                if DomView::inset(s, "top") || DomView::inset(s, "bottom") {
                    cb_ax = format!("{}y", cb_ax);
                }
                // (percentage sizes are of that block too)
                let __v_szi: Vec<String> = vec!["width".to_string(), "height".to_string(), "min-width".to_string(), "min-height".to_string(), "max-width".to_string(), "max-height".to_string()];
                let __n_szi = __v_szi.len() as i64;
                for szi in 0..__n_szi {
                    let szn = __v_szi[szi as usize].clone();
                    if DomText::index_of(&s.borrow().getText(&szn), "%") >= 0 && DomText::index_of(&cb_ax, "s") < 0 {
                        cb_ax = format!("{}s", cb_ax);
                    }
                }
                if !cb_ax.is_empty() {
                    EVGElement::set_attribute(&e, "cb-outer", cb_ax.clone());
                    cb_s = self.cbStyles[((self.cbStyles.len() as i64) - 1) as usize].clone();
                    cb_up = true;
                }
            }
            // (with no inset in a grid that is not its containing block,
            // its static place is the grid's content box, not the area of
            // its lines)
            let cgd: String = self.outerS.borrow().getText("display");
            if (pos == "absolute" && !parent_cb) && (!cb_up && (cgd == "grid" || cgd == "inline-grid")) {
                if !DomView::inset(s, "left") && (!DomView::inset(s, "right") && (!DomView::inset(s, "top") && !DomView::inset(s, "bottom"))) {
                    EVGElement::set_attribute(&e, "cb-outer", "c".to_string());
                }
            }
            let pgd: String = self.outerS.borrow().getText("display");
            let mut p_in_grid: bool = pgd == "grid" || pgd == "inline-grid";
            if cb_up {
                p_in_grid = false;
            }
            let col_placed: bool = p_in_grid;
            let row_placed: bool = p_in_grid;
            // (a grid-area is its grid-row and grid-column already)
            if p_in_grid && (s.borrow().getText("grid-area").is_empty() || s.borrow().getText("grid-area") == "auto") {
                if (DomView::placeOf(s, "grid-column").as_bytes().len() as i64) == 0 {
                    EVGElement::set_attribute(&e, "grid-column", "auto / auto".to_string());
                }
                if (DomView::placeOf(s, "grid-row").as_bytes().len() as i64) == 0 {
                    EVGElement::set_attribute(&e, "grid-row", "auto / auto".to_string());
                }
            }
            let __v_si: Vec<String> = vec!["top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string()];
            let __n_si = __v_si.len() as i64;
            for si in 0..__n_si {
                let side = __v_si[si as usize].clone();
                let iv: String = s.borrow().getText(&side);
                let on_col: bool = side == "left" || side == "right";
                let in_area: bool = on_col && col_placed || !on_col && row_placed;
                // (a fixed box's insets are of the viewport, which has none)
                if (!in_area && pos != "fixed") && ((iv.as_bytes().len() as i64) > 2 && iv[((iv.as_bytes().len() as i64) - 2) as usize..(iv.as_bytes().len() as i64) as usize].to_string() == "px") {
                    let pad: f64 = DomView::pxOf(&cb_s.borrow().getText(&format!("padding-{}", side)));
                    if pad != 0.0 {
                        EVGElement::set_attribute(&e, &side, format!("{}px", DomView::fmt(DomView::pxOf(&iv) - pad)));
                    }
                }
            }
        } else {
            // a relative offset moves the box where it is drawn, as a
            // translation does
            if pos == "relative" {
                // (and by the offsets of a relative inline it was in)
                let ix: f64 = DomView::pxOf(&s.borrow().getText("rel-left")) - DomView::pxOf(&s.borrow().getText("rel-right"));
                let iy: f64 = DomView::pxOf(&s.borrow().getText("rel-top")) - DomView::pxOf(&s.borrow().getText("rel-bottom"));
                let mut dx: f64 = self.relOff(s, "left", false) - self.relOff(s, "right", false);
                if s.borrow().has("left") {
                    dx = self.relOff(s, "left", false);
                    // (both given: right wins in a right-to-left
                    // containing block, CSS 2.1 9.4.3)
                    let rlr: String = s.borrow().getText("right");
                    if (!rlr.is_empty() && rlr != "auto") && (s.borrow().getText("left") != "auto" && self.outerS.borrow().getText("direction") == "rtl") {
                        dx = 0.0 - self.relOff(s, "right", false);
                    }
                }
                let mut dy: f64 = self.relOff(s, "top", true) - self.relOff(s, "bottom", true);
                if s.borrow().has("top") {
                    dy = self.relOff(s, "top", true);
                }
                if s.borrow().has("rel-left") {
                    dx = dx + DomView::pxOf(&s.borrow().getText("rel-left"));
                } else {
                    dx = dx + ix;
                }
                if s.borrow().has("rel-top") {
                    dy = dy + DomView::pxOf(&s.borrow().getText("rel-top"));
                } else {
                    dy = dy + iy;
                }
                if dx != 0.0 || dy != 0.0 {
                    let mut tr: String = format!("translate({}px, {}px)", DomView::fmt(dx), DomView::fmt(dy));
                    let t0: String = s.borrow().getText("transform");
                    if !t0.is_empty() && t0 != "none" {
                        tr = format!("{} {}", tr, t0);
                    }
                    EVGElement::set_attribute(&e, "transform", tr.clone());
                }
            }
        }
        // a background picture given as a data: URL, tiled by the display
        // list over the box (bg-picture)
        let bg_url: String = DomView::bgUrl(&s.borrow().getText("background-image"));
        let mut bg_em: f64 = DomView::pxOf(&s.borrow().getText("font-size"));
        if bg_em <= 0.0 {
            bg_em = self.emPx;
        }
        if !bg_url.is_empty() {
            let nat: Vec<f64> = DomView::imageSize(&bg_url);
            if nat.len() == 2 {
                let mut rep: String = s.borrow().getText("background-repeat");
                if rep.is_empty() || rep == "repeat repeat" || rep == "space" || rep == "round" {
                    rep = "repeat".to_string();
                }
                if rep == "repeat no-repeat" {
                    rep = "repeat-x".to_string();
                }
                if rep == "no-repeat repeat" {
                    rep = "repeat-y".to_string();
                }
                if rep == "no-repeat no-repeat" {
                    rep = "no-repeat".to_string();
                }
                let mut size: String = s.borrow().getText("background-size");
                if size.is_empty() {
                    size = "auto".to_string();
                }
                // (fixed: placed against the viewport, CSS 2.1 14.2.1)
                let mut fixed: String = String::new();
                if s.borrow().getText("background-attachment") == "fixed" {
                    fixed = format!("|fixed {} {}", DomView::fmt(self.vw), DomView::fmt(self.vh));
                }
                EVGElement::set_attribute(
                    &e,
                    "bg-picture",
                    format!("{}|{}|{}|{}|{}|{}{}", DomView::pngPart(&bg_url), DomView::fmt(nat[0]), DomView::fmt(nat[1]), rep, DomView::bgPosition(&s.borrow().getText("background-position"), bg_em), size, fixed)
                );
            }
        }
        // four equal sides: EVG's border is one width and one color. Sides
        // with other widths or colors take their room as padding and are
        // painted from side-borders
        let bt: f64 = DomView::side(s, "top");
        let br: f64 = DomView::side(s, "right");
        let bb: f64 = DomView::side(s, "bottom");
        let bl: f64 = DomView::side(s, "left");
        // (a percentage padding is of the containing block's width, where
        // that is known in px)
        // (and a separate table's border-spacing, which is padding too)
        let mut sp_h: f64 = 0.0;
        let mut sp_v: f64 = 0.0;
        let sdisp: String = s.borrow().getText("display");
        if (sdisp == "table" || sdisp == "inline-table") && s.borrow().getText("border-collapse") != "collapse" {
            let sbs: Vec<String> = s.borrow().getText("border-spacing").split(" ").map(|s| s.to_string()).collect::<Vec<String>>();
            if !sbs.is_empty() {
                sp_h = DomView::pxOf(&sbs[0].clone());
                sp_v = sp_h;
            }
            if (sbs.len() as i64) > 1 {
                sp_v = DomView::pxOf(&sbs[1].clone());
            }
        }
        let pt: f64 = self.relOff(s, "padding-top", false) + sp_v;
        let pr: f64 = self.relOff(s, "padding-right", false) + sp_h;
        let pb: f64 = self.relOff(s, "padding-bottom", false) + sp_v;
        let pl: f64 = self.relOff(s, "padding-left", false) + sp_h;
        let sc: Vec<String> = vec![DomView::sideColor(s, "top"), DomView::sideColor(s, "right"), DomView::sideColor(s, "bottom"), DomView::sideColor(s, "left")];
        let same_color: bool = sc[1] == sc[0] && sc[2] == sc[0] && sc[3] == sc[0];
        // dotted and dashed sides are painted from side-borders too
        let ss: Vec<String> = vec![s.borrow().getText("border-top-style"), s.borrow().getText("border-right-style"), s.borrow().getText("border-bottom-style"), s.borrow().getText("border-left-style")];
        let mut styled: bool = false;
        let mut ssi: i64 = 0;
        while ssi < 4 {
            let st: String = ss[ssi as usize].clone();
            if st == "dotted" || st == "dashed" {
                styled = true;
            }
            ssi += 1;
        }
        let styles: String = if styled { format!("|{} {} {} {}", ss[0], ss[1], ss[2], ss[3]) } else { String::new() };
        if bt > 0.0 && (br == bt && (bb == bt && bl == bt)) && same_color && !styled {
            EVGElement::set_attribute(&e, "border-width", s.borrow().getText("border-top-width"));
            let bc: String = s.borrow().getText("border-top-color");
            if !bc.is_empty() && bc != "currentcolor" {
                EVGElement::set_attribute(&e, "border-color", bc.clone());
            }
        } else {
            if bt + (br + (bb + bl)) > 0.0 {
                EVGElement::set_attribute(&e, "padding-top", format!("{}px", DomView::fmt(pt + bt)));
                EVGElement::set_attribute(&e, "padding-right", format!("{}px", DomView::fmt(pr + br)));
                EVGElement::set_attribute(&e, "padding-bottom", format!("{}px", DomView::fmt(pb + bb)));
                EVGElement::set_attribute(&e, "padding-left", format!("{}px", DomView::fmt(pl + bl)));
                // the sides are painted where they were folded in (not a
                // row's or a row group's: the table's border model does)
                let sbd: String = s.borrow().getText("display");
                if !sbd.starts_with("table-") || sbd == "table-cell" || sbd == "table-caption" {
                EVGElement::set_attribute(
                    &e,
                    "side-borders",
                    format!("{} {} {} {}|{}|{}|{}|{}{}", DomView::fmt(bt), DomView::fmt(br), DomView::fmt(bb), DomView::fmt(bl), sc[0], sc[1], sc[2], sc[3], styles)
                );
                }
                // (a grid's absolute items take its padding edge)
                let fgd: String = s.borrow().getText("display");
                if fgd == "grid" || fgd == "inline-grid" {
                    EVGElement::set_attribute(
                        &e,
                        "folded-border",
                        format!("{} {} {} {}", DomView::fmt(bt), DomView::fmt(br), DomView::fmt(bb), DomView::fmt(bl))
                    );
                }
            }
        }
        // (a percentage padding of a containing block whose width is known
        // in px: in px, so a percentage height inside sees the content box
        // when the box is sized to its content)
        let pod: String = self.outerS.borrow().getText("display");
        if self.outerS.borrow().getText("width").ends_with("px") && pod != "inline" && pod != "contents" && pod != "flex" && pod != "inline-flex" && pod != "grid" && pod != "inline-grid" && ((bt > 0.0 && (br == bt && (bb == bt && bl == bt)) && same_color && !styled) || bt + (br + (bb + bl)) <= 0.0) {
            let __v_pp: Vec<String> = vec!["padding-top".to_string(), "padding-right".to_string(), "padding-bottom".to_string(), "padding-left".to_string()];
            let __n_pp = __v_pp.len() as i64;
            for ppi in 0..__n_pp {
                let ppn = __v_pp[ppi as usize].clone();
                let ppv: String = s.borrow().getText(&ppn);
                if ppv.ends_with("%") && DomText::index_of(&ppv, "(") < 0 {
                    let ppx: f64 = self.relOff(s, &ppn, false);
                    EVGElement::set_attribute(&e, &ppn, format!("{}px", DomView::fmt(ppx)));
                }
            }
        }
        // EVG's width and height are the border box's; CSS's are the
        // content box's unless box-sizing says otherwise (EVG adds the
        // padding and border once they are resolved, a percentage among them)
        if s.borrow().getText("box-sizing") != "border-box" {
            EVGElement::set_attribute(&e, "box-sizing", "content-box".to_string());
        }
        let r: String = s.borrow().getText("border-top-left-radius");
        if !r.is_empty() {
            let r2: String = s.borrow().getText("border-top-right-radius");
            let r3: String = s.borrow().getText("border-bottom-right-radius");
            let r4: String = s.borrow().getText("border-bottom-left-radius");
            if (r2 == r && r3 == r) && r4 == r {
                EVGElement::set_attribute(&e, "border-radius", r.clone());
            } else {
                EVGElement::set_attribute(
                    &e,
                    "border-radius",
                    format!("{} {} {} {}", r, DomView::or(&r2, "0px"), DomView::or(&r3, "0px"), DomView::or(&r4, "0px"))
                );
            }
        }
        let ox: String = s.borrow().getText("overflow-x");
        let oy: String = s.borrow().getText("overflow-y");
        // (an aspect-ratio box whose ratio-dependent axis scrolls has no
        // automatic minimum there: the ratio's size, CSS Sizing 4 5.1)
        let arv_2: String = s.borrow().getText("aspect-ratio");
        if !arv_2.is_empty() && DomText::index_of(&arv_2, "auto") < 0 {
            let arq_1: f64 = DomView::ratioOf(&arv_2);
            let ar_w: String = s.borrow().getText("width");
            let ar_h: String = s.borrow().getText("height");
            // (clip beside a scrolling axis computes to hidden)
            let sc_x0: bool = ox == "hidden" || (ox == "auto" || ox == "scroll");
            let sc_y0: bool = oy == "hidden" || (oy == "auto" || oy == "scroll");
            let scroll_x: bool = sc_x0 || ox == "clip" && sc_y0;
            let scroll_y: bool = sc_y0 || oy == "clip" && sc_x0;
            let no_lim_w: bool = (s.borrow().getText("min-width").as_bytes().len() as i64) == 0 && (s.borrow().getText("max-width").as_bytes().len() as i64) == 0;
            let no_lim_h: bool = (s.borrow().getText("min-height").as_bytes().len() as i64) == 0 && (s.borrow().getText("max-height").as_bytes().len() as i64) == 0;
            if arq_1 > 0.0 && (((scroll_x && no_lim_w) && (ar_w.is_empty() || ar_w == "auto")) && DomText::index_of(&ar_h, "px") > 0) {
                EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(DomView::pxOf(&ar_h) * arq_1)));
            }
            if arq_1 > 0.0 && (((scroll_y && no_lim_h) && (ar_h.is_empty() || ar_h == "auto")) && DomText::index_of(&ar_w, "px") > 0) {
                EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt(DomView::pxOf(&ar_w) / arq_1)));
            }
            // (a max-height or min-height transfers through the ratio to
            // the width the ratio starts from, when the height is auto and
            // the width is not given, and not past min-width, CSS Sizing 4,
            // 5.2.1)
            // (not for a flex or grid item, whose width the container gives)
            let t_od: String = self.outerS.borrow().getText("display");
            let t_item: bool = !placed && (DomText::index_of(&t_od, "flex") >= 0 || DomText::index_of(&t_od, "grid") >= 0);
            if arq_1 > 0.0 && (!t_item && ((ar_h.is_empty() || ar_h == "auto") && DomText::index_of(&ar_w, "px") < 0 && DomText::index_of(&ar_w, "%") < 0)) {
                let tmh: String = s.borrow().getText("max-height");
                let mut tm: f64 = -1.0;
                if DomText::index_of(&tmh, "px") > 0 {
                    tm = DomView::pxOf(&tmh);
                } else {
                    if self.defH >= 0.0 && ((tmh.as_bytes().len() as i64) > 1 && (tmh[((tmh.as_bytes().len() as i64) - 1) as usize..(tmh.as_bytes().len() as i64) as usize].to_string() == "%" && DomText::index_of(&tmh, "(") < 0)) {
                        let q: Option<f64> = tmh[(0) as usize..((tmh.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                        if q.is_some() {
                            tm = (self.defH * q.unwrap()) / 100.0;
                        }
                    }
                }
                let tmw: String = s.borrow().getText("min-width");
                let floor_w: f64 = if DomText::index_of(&tmw, "px") > 0 { DomView::pxOf(&tmw) } else { 0.0 };
                if tm >= 0.0 && s.borrow().getText("box-sizing") != "border-box" {
                    let mut tw: f64 = tm * arq_1;
                    let omw: String = s.borrow().getText("max-width");
                    if DomText::index_of(&omw, "px") > 0 && DomView::pxOf(&omw) < tw {
                        tw = DomView::pxOf(&omw);
                    }
                    if tw < floor_w {
                        tw = floor_w;
                    }
                    EVGElement::set_attribute(&e, "max-width", format!("{}px", DomView::fmt(tw)));
                }
                let tnh: String = s.borrow().getText("min-height");
                if DomText::index_of(&tnh, "px") > 0 && s.borrow().getText("box-sizing") != "border-box" {
                    let mut tn: f64 = DomView::pxOf(&tnh) * arq_1;
                    let xmw: String = s.borrow().getText("max-width");
                    if DomText::index_of(&xmw, "px") > 0 && DomView::pxOf(&xmw) < tn {
                        tn = DomView::pxOf(&xmw);
                    }
                    if tn > floor_w {
                        EVGElement::set_attribute(&e, "min-width", format!("{}px", DomView::fmt(tn)));
                    }
                }
            }
            // (a ratio without auto is of the box box-sizing names: with
            // border-box, of the border box, CSS Sizing 4, 5.1; EVG's is of
            // the content box)
            if arq_1 > 0.0 && s.borrow().getText("box-sizing") == "border-box" {
                if (ar_h.is_empty() || ar_h == "auto") && (DomText::index_of(&ar_w, "px") > 0 && no_lim_h) {
                    EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt(DomView::pxOf(&ar_w) / arq_1)));
                    // (min-height auto still keeps the content, 5.2)
                    if !scroll_y {
                        EVGElement::set_attribute(&e, "min-height", "min-content".to_string());
                    }
                } else {
                    if (ar_w.is_empty() || ar_w == "auto") && (DomText::index_of(&ar_h, "px") > 0 && no_lim_w) {
                        EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(DomView::pxOf(&ar_h) * arq_1)));
                    }
                }
            }
        }
        if !ox.is_empty() || !oy.is_empty() {
            let mut o: String = oy.clone();
            if o.is_empty() {
                o = ox.clone();
            }
            if o == "scroll" {
                o = "auto".to_string();
            }
            if o != "visible" {
                EVGElement::set_attribute(&e, "overflow", o.clone());
                // the bar (bars): its colours, and an overflow-y: scroll
                // box has it always, in a gutter taken from its padding box
                // as Chromium's classic bar is (auto: over the content, when
                // there is something to scroll)
                let sbc: String = s.borrow().getText("scrollbar-color");
                if !sbc.is_empty() && sbc != "auto" {
                    EVGElement::set_attribute(&e, "scrollbar-color", sbc.clone());
                }
                let sbw: String = s.borrow().getText("scrollbar-width");
                if !sbw.is_empty() {
                    EVGElement::set_attribute(&e, "scrollbar-width", sbw.clone());
                }
                if sbw != "none" {
                    if oy == "scroll" {
                        let rhs_7 = format!("{} mfd-dscroll", e.borrow().class_name);
                        e.borrow_mut().class_name = rhs_7;
                        let gp_1: f64 = DomView::pxOf(&s.borrow().getText("padding-right")) + DomView::gutter();
                        EVGElement::set_attribute(&e, "padding-right", format!("{}px", DomView::fmt(gp_1)));
                        // the bar is in the box, not added to a content
                        // box's width
                        let cw: f64 = DomView::pxOf(&s.borrow().getText("width"));
                        if cw > 0.0 && s.borrow().getText("box-sizing") != "border-box" {
                            let mut less_w: f64 = cw - DomView::gutter();
                            if less_w < 0.0 {
                                less_w = 0.0;
                            }
                            EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(less_w)));
                        }
                    }
                    if oy == "auto" {
                        let rhs_8 = format!("{} mfd-dauto", e.borrow().class_name);
                        e.borrow_mut().class_name = rhs_8;
                    }
                }
                // a scroll container's automatic minimum size in a flex
                // box is zero, not its content's
                if (s.borrow().getText("min-width").as_bytes().len() as i64) == 0 {
                    EVGElement::set_attribute(&e, "min-width", "0px".to_string());
                }
                if (s.borrow().getText("min-height").as_bytes().len() as i64) == 0 {
                    EVGElement::set_attribute(&e, "min-height", "0px".to_string());
                }
            }
        }
        if s.borrow().getText("visibility") == "hidden" {
            EVGElement::set_attribute(&e, "opacity", "0".to_string());
        }
        if display == "flex" || display == "inline-flex" {
            EVGElement::set_attribute(&e, "display", "flex".to_string());
            let mut fd: String = s.borrow().getText("flex-direction");
            if fd.is_empty() {
                fd = "row".to_string();
            }
            EVGElement::set_attribute(&e, "flex-direction", fd.clone());
            let mut fw: String = s.borrow().getText("flex-wrap");
            if fw.is_empty() {
                fw = "nowrap".to_string();
            }
            EVGElement::set_attribute(&e, "flex-wrap", fw.clone());
            let flc: String = s.borrow().getText("flex-line-count");
            if !flc.is_empty() {
                EVGElement::set_attribute(&e, "flex-line-count", flc.clone());
            }
            let mut ai: String = s.borrow().getText("align-items");
            if ai.is_empty() || ai == "normal" {
                ai = "stretch".to_string();
            }
            EVGElement::set_attribute(&e, "align-items", ai.clone());
            let ac: String = s.borrow().getText("align-content");
            if ac.is_empty() || ac == "normal" {
                EVGElement::set_attribute(&e, "align-content", "stretch".to_string());
            }
            return;
        }
        if display == "table-row" {
            // a table's row: its cells side by side, as tall as the tallest
            EVGElement::set_attribute(&e, "display", "flex".to_string());
            EVGElement::set_attribute(&e, "flex-direction", "row".to_string());
            EVGElement::set_attribute(&e, "flex-wrap", "nowrap".to_string());
            EVGElement::set_attribute(&e, "align-items", "stretch".to_string());
            return;
        }
        if display == "grid" || display == "inline-grid" {
            EVGElement::set_attribute(&e, "display", "grid".to_string());
            // a grid-lanes container: its lanes' axis and flow-tolerance
            let glanes: String = s.borrow().getText("grid-lanes");
            if !glanes.is_empty() {
                EVGElement::set_attribute(&e, "grid-lanes", glanes.clone());
                let gtol: String = s.borrow().getText("lanes-tolerance");
                if !gtol.is_empty() {
                    EVGElement::set_attribute(&e, "lanes-tolerance", gtol.clone());
                }
            }
            let gi: String = s.borrow().getText("align-items");
            if !gi.is_empty() && gi != "normal" {
                EVGElement::set_attribute(&e, "align-items", gi.clone());
            }
            let gj: String = s.borrow().getText("justify-items");
            if !gj.is_empty() && (gj != "normal" && gj != "legacy") {
                EVGElement::set_attribute(&e, "justify-items", gj.clone());
            }
            let gc: String = s.borrow().getText("align-content");
            if gc.is_empty() || gc == "normal" {
                EVGElement::set_attribute(&e, "align-content", "stretch".to_string());
            }
            return;
        }
        // a block: its children one under another, as wide as it. As an
        // EVG flex column it takes its content's width in a row (a flex
        // item, an inline-block) and the row's in a column, as CSS does
        if display == "block" {
            let rhs_9 = format!("{} mfd-block", e.borrow().class_name);
            e.borrow_mut().class_name = rhs_9;
        }
        EVGElement::set_attribute(&e, "display", "flex".to_string());
        EVGElement::set_attribute(&e, "flex-direction", "column".to_string());
        EVGElement::set_attribute(&e, "flex-wrap", "nowrap".to_string());
        EVGElement::set_attribute(&e, "align-items", "stretch".to_string());
    }
    /// a node's style in the frame being built
    /// a member of a style object of the page set for this build; the
    /// object's members are put back when the build ends (DomSvgDocs.undo)
    pub(crate) fn putPage(&self, o: &Rc<RefCell<JsonValue>>, k: &str, v: &str) {
        let was: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        let ks: Vec<String> = o.borrow().keys.clone();
        let vs: Vec<Rc<RefCell<JsonValue>>> = o.borrow().items.clone();
        was.borrow_mut().keys = ks;
        was.borrow_mut().items = vs;
        self.svgs.borrow_mut().undoObjs.push(o.clone());
        self.svgs.borrow_mut().undoWas.push(was);
        o.borrow_mut().putStr(k, v);
    }
    pub fn styleIn(&self, n: &Rc<RefCell<JsonValue>>) -> Rc<RefCell<JsonValue>> {
        return DomView::logical(&n.borrow().get("s"), &self.wm.clone());
    }
    /// a box whose writing mode is orthogonal to its parent's: built in its
    /// own frame and laid out there on its own, its inline size the content's
    /// up to the viewport's (CSS Writing Modes 3, 7.3), then put in a box of
    /// the size it came out, turned a quarter (DomView.collect maps its
    /// boxes back)
    fn orthogonal(&mut self, n: &Rc<RefCell<JsonValue>>, inh: Rc<RefCell<JsonValue>>, own: String) -> Rc<RefCell<EVGElement>> {
        self.memoBad += 1;
        // (an empty absolute block with an inset has no content to turn: it
        // is built where it is, its sizes percentages of its containing block)
        let oc: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let empty: bool = oc.borrow().kind != 4 || oc.borrow().items.is_empty();
        let os: Rc<RefCell<JsonValue>> = self.styleIn(n);
        let opos: String = os.borrow().getText("position");
        let odisp: String = DomView::displayOf(n);
        let inset: bool = (DomView::setLen(&os.borrow().getText("top")) || DomView::setLen(&os.borrow().getText("bottom"))) || (DomView::setLen(&os.borrow().getText("left")) || DomView::setLen(&os.borrow().getText("right")));
        let box_only: bool = ((odisp == "block" || odisp == "inline-block") && n.borrow().getText("t") != "img") && !n.borrow().has("svg");
        if (empty && (opos == "absolute" || opos == "fixed")) && (inset && box_only) {
            self.unturned = true;
            let u: Rc<RefCell<EVGElement>> = self.element(n, inh.clone());
            self.unturned = false;
            return u;
        }
        let was: String = self.wm.clone();
        let was_flex: bool = self.inFlex;
        self.wm = own.clone();
        self.inFlex = false;
        let l: Rc<RefCell<EVGElement>> = self.element(n, inh.clone());
        self.wm = was.clone();
        self.inFlex = was_flex;
        // its size where it is: the margins, the place and the flex or grid
        // item's properties, in the parent's frame
        let ps: Rc<RefCell<JsonValue>> = self.styleIn(n);
        let keep: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        let __n_i = ps.borrow().keys.len() as i64;
        for i in 0..__n_i {
            let k = ps.borrow().keys[i as usize].clone();
            if DomView::placeKey(&k) {
                keep.borrow_mut().put(&k, ps.borrow().items[i as usize].clone());
            }
        }
        // (self-start and self-end are by the box's own frame: across a
        // flex row of a vertical parent, the parent's block axis, whose
        // start is the box's inline start)
        let kas: String = keep.borrow().getText("align-self");
        if (kas == "self-start" || kas == "self-end") && (!was.is_empty() && own.is_empty()) {
            let kfd: String = self.outerS.borrow().getText("flex-direction");
            let kd: String = self.outerS.borrow().getText("display");
            if (kd == "flex" || kd == "inline-flex") && (kfd.is_empty() || (kfd == "row" || kfd == "row-reverse")) {
                let mut to_end: bool = was == "vertical-rl";
                if inh.borrow().getText("direction") == "rtl" {
                    to_end = !to_end;
                }
                if kas == "self-end" {
                    to_end = !to_end;
                }
                if to_end {
                    keep.borrow_mut().put("align-self", JsonValue::mkStr("flex-end".to_string()));
                } else {
                    keep.borrow_mut().put("align-self", JsonValue::mkStr("flex-start".to_string()));
                }
            }
        }
        // (in a horizontal grid, a vertical item's own inline axis is the
        // grid's block axis and its block axis the grid's inline one)
        let ogd: String = self.outerS.borrow().getText("display");
        if was.is_empty() && (!own.is_empty() && (ogd == "grid" || ogd == "inline-grid")) {
            let grtl: bool = self.outerS.borrow().getText("direction") == "rtl";
            let irtl: bool = inh.borrow().getText("direction") == "rtl";
            if kas == "self-start" || kas == "self-end" {
                let a_end: bool = irtl != (kas == "self-end");
                if a_end {
                    keep.borrow_mut().put("align-self", JsonValue::mkStr("end".to_string()));
                } else {
                    keep.borrow_mut().put("align-self", JsonValue::mkStr("start".to_string()));
                }
            }
            let kjs: String = keep.borrow().getText("justify-self");
            if kjs == "self-start" || kjs == "self-end" {
                // (its block start: the left of vertical-lr, the right of
                // vertical-rl)
                let on_right: bool = (own == "vertical-rl") != (kjs == "self-end");
                if on_right != grtl {
                    keep.borrow_mut().put("justify-self", JsonValue::mkStr("end".to_string()));
                } else {
                    keep.borrow_mut().put("justify-self", JsonValue::mkStr("start".to_string()));
                }
            }
        }
        // (and in a vertical grid a horizontal item's inline axis is the
        // grid's block axis, its block axis, downwards, the grid's inline one)
        if !was.is_empty() && (own.is_empty() && (ogd == "grid" || ogd == "inline-grid")) {
            let grtl2: bool = self.outerS.borrow().getText("direction") == "rtl";
            let irtl2: bool = inh.borrow().getText("direction") == "rtl";
            if kas == "self-start" || kas == "self-end" {
                // (its start on the right, against a block start on the left)
                let on_right2: bool = irtl2 != (kas == "self-end");
                if on_right2 != (was == "vertical-rl") {
                    keep.borrow_mut().put("align-self", JsonValue::mkStr("end".to_string()));
                } else {
                    keep.borrow_mut().put("align-self", JsonValue::mkStr("start".to_string()));
                }
            }
            let kjs2: String = keep.borrow().getText("justify-self");
            if kjs2 == "self-start" || kjs2 == "self-end" {
                if (kjs2 == "self-end") != grtl2 {
                    keep.borrow_mut().put("justify-self", JsonValue::mkStr("end".to_string()));
                } else {
                    keep.borrow_mut().put("justify-self", JsonValue::mkStr("start".to_string()));
                }
            }
        }
        let ls: Rc<RefCell<JsonValue>> = DomView::logical(&n.borrow().get("s"), &own);
        let mut avail: f64 = self.vh;
        if own.is_empty() {
            avail = self.vw;
        }
        avail -= 16.0;
        // (in a grid row of a fixed size, that size: the grid area is its
        // containing block, CSS Writing Modes 7.3)
        let ogd2: String = self.outerS.borrow().getText("display");
        if ogd2 == "grid" || ogd2 == "inline-grid" {
            let ra: f64 = DomView::trackSpanPx(&keep.borrow().getText("grid-row"), &self.outerS.borrow().getText("grid-template-rows"));
            if ra >= 0.0 {
                avail = ra;
            }
        }
        let lw: String = ls.borrow().getText("width");
        let tg: String = n.borrow().getText("t");
        if (lw.is_empty() || lw == "auto") && (tg != "img" && !n.borrow().has("svg")) {
            EVGElement::set_attribute(&l, "width", "fit-content".to_string());
        }
        EVGElement::set_attribute(&l, "margin-top", "0px".to_string());
        EVGElement::set_attribute(&l, "margin-right", "0px".to_string());
        EVGElement::set_attribute(&l, "margin-bottom", "0px".to_string());
        EVGElement::set_attribute(&l, "margin-left", "0px".to_string());
        EVGElement::set_attribute(&l, "position", "static".to_string());
        // (its flex or grid item's part is the outer box's)
        EVGElement::set_attribute(&l, "flex-grow", "0".to_string());
        EVGElement::set_attribute(&l, "flex-shrink", "0".to_string());
        EVGElement::set_attribute(&l, "flex-basis", "auto".to_string());
        EVGElement::set_attribute(&l, "align-self", "auto".to_string());
        let tmp: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        EVGElement::set_attribute(&tmp, "display", "flex".to_string());
        EVGElement::set_attribute(&tmp, "flex-direction", "column".to_string());
        EVGElement::set_attribute(&tmp, "align-items", "flex-start".to_string());
        tmp.borrow_mut().width = Some(EVGUnit::px(avail));
        let _tmp_5 = EVGUnit::px(self.vh.clone());
        tmp.borrow_mut().height = Some(_tmp_5);
        EVGElement::add_child(&tmp, Rc::clone(&l));
        let lay: Rc<RefCell<EVGLayout>> = Rc::new(RefCell::new(EVGLayout::new()));
        EVGLayout::set_page_size(&lay, avail, self.vh.clone());
        EVGLayout::layout(&lay, Rc::clone(&tmp));
        let l_w: f64 = l.borrow().calculated_width;
        let l_h: f64 = l.borrow().calculated_height;
        // (its last baseline from its block start, for columnBaselines)
        let lfull: Rc<RefCell<EVGLayoutFull>> = Rc::new(RefCell::new(EVGLayoutFull::new()));
        let l_last: f64 = lfull.borrow().last_baseline_offset_of(Rc::clone(&lay), Rc::clone(&l));
        if l_last >= 0.0 {
            let rhs_10 = l_last - l.borrow().r#box.as_ref().unwrap().borrow().margin_top_px;
            l.borrow_mut().calculated_last_baseline = rhs_10;
        } else {
            l.borrow_mut().calculated_last_baseline = l_h;
        }
        tmp.borrow_mut().children.clear();
        let p: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        self.style(&p, &keep, "block");
        p.borrow_mut().class_name = format!("mfd-wm {}", own);
        if own.is_empty() {
            p.borrow_mut().class_name = format!("mfd-wm horizontal {}", was);
        }
        // a grid item stretched along an axis is at least its size there
        // (settle lays it out again at the size it gets)
        let pgd: String = self.outerS.borrow().getText("display");
        let in_grid: bool = pgd == "grid" || pgd == "inline-grid";
        let mut gjs: String = keep.borrow().getText("justify-self");
        if gjs.is_empty() || gjs == "auto" {
            gjs = self.outerS.borrow().getText("justify-items");
        }
        let mut gas: String = keep.borrow().getText("align-self");
        if gas.is_empty() || gas == "auto" {
            gas = self.outerS.borrow().getText("align-items");
        }
        let picture: bool = tg == "img" || n.borrow().has("svg");
        let mut stretch_w: bool = (in_grid && !picture) && (gjs.is_empty() || (gjs == "normal" || (gjs == "stretch" || gjs == "legacy")));
        let mut stretch_h: bool = (in_grid && !picture) && (gas.is_empty() || (gas == "normal" || gas == "stretch"));
        // (across a flex column, stretched as wide as the line)
        let ofd: String = self.outerS.borrow().getText("flex-direction");
        if (pgd == "flex" || pgd == "inline-flex") && (ofd == "column" || ofd == "column-reverse") {
            if gas.is_empty() || (gas == "normal" || gas == "stretch") {
                stretch_w = true;
            }
        }
        // (its own width is its height here, and its height the width)
        let lh0: String = ls.borrow().getText("height");
        if !lh0.is_empty() && lh0 != "auto" {
            stretch_w = false;
        }
        if !lw.is_empty() && lw != "auto" {
            stretch_h = false;
        }
        // (a picture growing down a column without a width: the width
        // follows the flexed height by its ratio)
        let pgo: Option<f64> = keep.borrow().getText("flex-grow").parse::<f64>().ok();
        let mut pgr: f64 = 0.0;
        if pgo.is_some() {
            pgr = pgo.unwrap();
        }
        let col_grow_p: bool = ((((picture && (pgd == "flex" || pgd == "inline-flex")) && (ofd == "column" || ofd == "column-reverse")) && pgr > 0.0) && (lh0.is_empty() || lh0 == "auto")) && !stretch_w;
        if stretch_w {
            if picture {
                // (a picture stretched across a column takes the line's
                // width, within its limits, the height by its ratio)
                let __v_pli: Vec<String> = vec!["min-width".to_string(), "max-width".to_string(), "min-height".to_string(), "max-height".to_string()];
                let __n_pli = __v_pli.len() as i64;
                for pli in 0..__n_pli {
                    let pln = __v_pli[pli as usize].clone();
                    let plv: String = ps.borrow().getText(&pln);
                    if DomText::index_of(&plv, "px") > 0 {
                        EVGElement::set_attribute(&p, &pln, plv.clone());
                    }
                }
            } else {
                EVGElement::set_attribute(&p, "min-width", format!("{}px", DomView::fmt(l_h)));
            }
        } else {
            if col_grow_p {
                EVGElement::set_attribute(&p, "align-self", gas.clone());
            } else {
                EVGElement::set_attribute(&p, "width", format!("{}px", DomView::fmt(l_h)));
            }
        }
        // (stretched down a column with a length basis, the basis is its
        // height: no ratio)
        let basis_h: bool = (picture && stretch_w) && DomView::pxOf(&keep.borrow().getText("flex-basis")) > 0.0;
        if !basis_h {
            if (tg == "img" && ((lw.is_empty() || lw == "auto") || col_grow_p)) && (l_h > 0.0 && l_w > 0.0) {
                // a picture's height follows its width, by its natural ratio
                // (turned with it) when it has one
                let mut r_w: f64 = l_h;
                let mut r_h: f64 = l_w;
                let oa: Rc<RefCell<JsonValue>> = n.borrow().get("a");
                let onat: Vec<f64> = DomView::imageSize(&DomView::imgSrc(&n));
                if (onat.len() as i64) == 2 {
                    if onat[0] > 0.0 && onat[1] > 0.0 {
                        r_w = onat[0];
                        r_h = onat[1];
                        if own.is_empty() {
                            r_w = onat[1];
                            r_h = onat[0];
                        }
                    }
                }
                EVGElement::set_attribute(
                    &p,
                    "aspect-ratio",
                    format!("{} / {}", DomView::fmt(r_w), DomView::fmt(r_h))
                );
            } else {
                if stretch_h {
                    EVGElement::set_attribute(&p, "min-height", format!("{}px", DomView::fmt(l_w)));
                } else {
                    EVGElement::set_attribute(&p, "height", format!("{}px", DomView::fmt(l_w)));
                }
            }
        }
        EVGElement::set_attribute(&p, "flex-shrink", "0".to_string());
        EVGElement::set_attribute(&l, "position", "absolute".to_string());
        // (the sizes it came out are its border box's)
        EVGElement::set_attribute(&l, "box-sizing", "border-box".to_string());
        EVGElement::set_attribute(&l, "left", "0px".to_string());
        EVGElement::set_attribute(&l, "top", "0px".to_string());
        EVGElement::set_attribute(&l, "width", format!("{}px", DomView::fmt(l_w)));
        EVGElement::set_attribute(&l, "height", format!("{}px", DomView::fmt(l_h)));
        // (painted turned a quarter clockwise into its box, as a vertical
        // line's glyphs are: about the middle of its first l_h square)
        // (its lines left to right in vertical-lr: turned over its own
        // block axis first, which the painter's upright glyphs ignore)
        if !own.is_empty() && was.is_empty() {
            let rhs_11 = format!("{} mfd-qt", l.borrow().class_name);
            l.borrow_mut().class_name = rhs_11;
            if own.ends_with("-lr") {
                EVGElement::set_attribute(&l, "transform", "rotate(90deg) scale(1, -1)".to_string());
                EVGElement::set_attribute(&l, "transform-origin", "0px 0px".to_string());
            } else {
                EVGElement::set_attribute(&l, "transform", "rotate(90deg)".to_string());
                EVGElement::set_attribute(&l, "transform-origin", format!("{}px {}px", DomView::fmt(l_h / 2.0), DomView::fmt(l_h / 2.0)));
            }
        }
        // (a horizontal box in a vertical-rl frame, which is painted turned
        // clockwise: turned back, about the middle of its first l_w square)
        if own.is_empty() && was == "vertical-rl" {
            let rhs_12 = format!("{} mfd-qt", l.borrow().class_name);
            l.borrow_mut().class_name = rhs_12;
            EVGElement::set_attribute(&l, "transform", "rotate(-90deg)".to_string());
            EVGElement::set_attribute(&l, "transform-origin", format!("{}px {}px", DomView::fmt(l_w / 2.0), DomView::fmt(l_w / 2.0)));
        }
        EVGElement::add_child(&p, Rc::clone(&l));
        // (a horizontal box in a vertical flex line aligned by its baseline
        // has none there: the central one is synthesized at its middle,
        // CSS Align 9.1)
        if (!was.is_empty() && own.is_empty()) && (pgd == "flex" || pgd == "inline-flex") {
            if ((ofd.is_empty() || ofd == "row") || ofd == "row-reverse") && (gas == "baseline" || (gas == "first baseline" || gas == "last baseline")) {
                EVGElement::set_attribute(&p, "baseline-from-bottom", DomView::fmt(l_w / 2.0));
            }
        }
        // justify-self: baseline in a horizontal grid: where its baseline
        // is across it, from the side its group lines up on
        if (was.is_empty()) != (own.is_empty()) && in_grid {
            let jb: String = gjs.clone();
            let j_first: bool = jb == "baseline" || jb == "first baseline";
            if (j_first || jb == "last baseline") && self.outerS.borrow().getText("direction") != "rtl" {
                // (in a vertical grid a horizontal item's baseline is from
                // its top, the grid's inline start, whichever way it goes)
                let rl: bool = own == "vertical-rl";
                let mut bx: f64 = 0.0;
                if l.borrow().has_baseline {
                    let mut bb: f64 = l.borrow().calculated_baseline;
                    if !j_first {
                        bb = l.borrow().calculated_last_baseline;
                    }
                    // (a vertical line's baseline is its middle, the central
                    // one, unless its text lies sideways on the alphabetic
                    // one, baseline-under in vertical-lr)
                    if !own.is_empty() {
                        let mid: f64 = DomView::boxMid(&l, &l, j_first);
                        if mid >= 0.0 {
                            if inh.borrow().getText("text-orientation") != "sideways" {
                                bb = mid;
                            }
                        }
                    }
                    bx = bb;
                    if rl {
                        bx = l_h - bb;
                    }
                }
                let m_l: f64 = DomView::pxOf(&keep.borrow().getText("margin-left"));
                let m_r: f64 = DomView::pxOf(&keep.borrow().getText("margin-right"));
                let start_side: bool = j_first != rl;
                self.jbItems.push(Rc::clone(&p));
                self.memoBad += 1;
                self.jbReal.push(true);
                self.jbStart.push(start_side);
                let mut _tmp_2 = DomView::baselineTrack(
                    &keep.borrow().getText("grid-column"),
                    start_side,
                    &self.outerS.borrow().getText("grid-template-columns")
                );
                self.jbCol.push(_tmp_2);
                if start_side {
                    self.jbDist.push(m_l + bx);
                    self.jbMargin.push(m_l);
                } else {
                    self.jbDist.push(m_r + (l_h - bx));
                    self.jbMargin.push(m_r);
                }
            }
        }
        // (an inline box placed by vertical-align in its line, as element
        // does)
        let pdi: String = ps.borrow().getText("display");
        if DomText::index_of(&pdi, "inline-") == 0 && !self.inFlex {
            let pva: String = ps.borrow().getText("vertical-align");
            if pva == "middle" {
                EVGElement::set_attribute(&p, "align-self", "center".to_string());
            }
            if pva == "top" || pva == "text-top" {
                EVGElement::set_attribute(&p, "align-self", "flex-start".to_string());
            }
            if pva == "bottom" || pva == "text-bottom" {
                EVGElement::set_attribute(&p, "align-self", "flex-end".to_string());
            }
        }
        p
    }
    /// justify-self: baseline on an item of a vertical grid in the grid's
    /// own mode: its block axis is across the grid's inline one, so it
    /// joins its group by a baseline synthesized at its middle (CSS Align
    /// 9.1, central in vertical modes)
    /// an object's stamp, given one if it has none (DomMemo)
    fn stampOf(&self, o: &Rc<RefCell<JsonValue>>) -> String {
        if o.borrow().stamp <= 0 {
            let memo: Rc<RefCell<DomMemo>> = Rc::clone(&self.svgs.borrow().memo);
            memo.borrow_mut().next += 1;
            o.borrow_mut().stamp = memo.borrow().next;
        }
        o.borrow().stamp.to_string()
    }
    /// the state an element's build reads besides its node, its parent's
    /// style and what it inherits (DomMemo): the same key, the same element
    fn memoKey(&self) -> String {
        let mut cw: String = String::new();
        for w in self.colW.iter().copied() {
            cw = format!("{},{}", cw, DomView::fmt(w));
        }
        let mut flags: String = String::new();
        for f in vec![self.inFlex, self.unturned, self.defHMaybe, self.quirks, self.bandOnly].iter().copied() {
            if f {
                flags = format!("{}1", flags);
            } else {
                flags = format!("{}0", flags);
            }
        }
        format!("{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}", self.wm, flags, self.positioned.to_string(), self.clipSinceCb.to_string(), self.clipSinceFx.to_string(), self.inTransform.to_string(), DomView::fmt(self.defH), DomView::fmt(self.spW), DomView::fmt(self.spH), self.dirNow, DomView::fmt(self.vw), DomView::fmt(self.vh), DomView::fmt(self.emPx), self.cellAt.to_string(), cw, self.listNo.to_string())
    }
    fn parallelBaseline(&mut self, ke: Rc<RefCell<EVGElement>>, kid: &Rc<RefCell<JsonValue>>, kinh: &Rc<RefCell<JsonValue>>) {
        let od: String = self.outerS.borrow().getText("display");
        if od != "grid" && od != "inline-grid" {
            return;
        }
        if DomView::wmOf(kinh) != self.wm {
            return;
        }
        let ks: Rc<RefCell<JsonValue>> = self.styleIn(kid);
        let kp: String = ks.borrow().getText("position");
        if kp == "absolute" || kp == "fixed" {
            return;
        }
        let mut jb: String = ks.borrow().getText("justify-self");
        if jb.is_empty() || jb == "auto" {
            jb = self.outerS.borrow().getText("justify-items");
        }
        let j_first: bool = jb == "baseline" || jb == "first baseline";
        if !j_first && jb != "last baseline" {
            return;
        }
        if self.outerS.borrow().getText("direction") == "rtl" {
            return;
        }
        // (its size along the grid's inline axis, laid out on its own)
        let kw: String = ks.borrow().getText("width");
        // (a percentage of a track the alignment sizes is cyclic: it
        // takes no part, CSS Box Alignment 9.3; a fixed track is not)
        let mut gc_p: String = ks.borrow().getText("grid-column");
        if gc_p.is_empty() || gc_p == "auto" {
            gc_p = "1".to_string();
        }
        if DomText::index_of(&kw, "%") >= 0 && DomView::trackSpanPx(&gc_p, &self.outerS.borrow().getText("grid-template-columns")) < 0.0 {
            EVGElement::set_attribute(&ke, "justify-self", "start".to_string());
            return;
        }
        let tmp: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        EVGElement::set_attribute(&tmp, "display", "flex".to_string());
        EVGElement::set_attribute(&tmp, "flex-direction", "column".to_string());
        EVGElement::set_attribute(&tmp, "align-items", "flex-start".to_string());
        let mut pw: f64 = self.vh;
        let mut ph: f64 = self.vw;
        if self.wm.is_empty() {
            pw = self.vw;
            ph = self.vh;
        }
        // (in a column of a fixed size, fit to it)
        let col_a: f64 = DomView::trackSpanPx(&ks.borrow().getText("grid-column"), &self.outerS.borrow().getText("grid-template-columns"));
        if col_a >= 0.0 {
            pw = col_a;
        }
        tmp.borrow_mut().width = Some(EVGUnit::px(pw));
        tmp.borrow_mut().height = Some(EVGUnit::px(ph));
        let was_w: Option<Rc<RefCell<EVGUnit>>> = ke.borrow().width.clone();
        if kw.is_empty() || kw == "auto" {
            EVGElement::set_attribute(&ke, "width", "fit-content".to_string());
        }
        EVGElement::add_child(&tmp, Rc::clone(&ke));
        let lay: Rc<RefCell<EVGLayout>> = Rc::new(RefCell::new(EVGLayout::new()));
        EVGLayout::set_page_size(&lay, pw, ph);
        EVGLayout::layout(&lay, Rc::clone(&tmp));
        let w: f64 = ke.borrow().calculated_width;
        // (synthesized on the line-under side of the vertical items' lines
        // across it, the left, or of the horizontal ones', its block end;
        // the middle where they are upright, central)
        let mut bx: f64 = w / 2.0;
        if kinh.borrow().getText("text-orientation") == "sideways" {
            bx = w;
            if self.wm.is_empty() {
                bx = 0.0;
            }
        }
        tmp.borrow_mut().children.clear();
        ke.borrow_mut().width = was_w.clone();
        // (the size it is fitted to in its column, where the alignment
        // puts it)
        if col_a >= 0.0 && (kw.is_empty() || kw == "auto") {
            EVGElement::set_attribute(&ke, "width", format!("{}px", DomView::fmt(w)));
        }
        let m_l: f64 = DomView::pxOf(&ks.borrow().getText("margin-left"));
        let m_r: f64 = DomView::pxOf(&ks.borrow().getText("margin-right"));
        self.jbItems.push(Rc::clone(&ke));
        self.memoBad += 1;
        self.jbReal.push(false);
        self.jbStart.push(j_first);
        let mut _tmp_8 = DomView::baselineTrack(
            &ks.borrow().getText("grid-column"),
            j_first,
            &self.outerS.borrow().getText("grid-template-columns")
        );
        self.jbCol.push(_tmp_8);
        if j_first {
            self.jbDist.push(m_l + bx);
            self.jbMargin.push(m_l);
        } else {
            self.jbDist.push(m_r + (w - bx));
            self.jbMargin.push(m_r);
        }
    }
    /// the vertical items of a grid recorded from `from` on: each group (a
    /// column, a side) put where its baselines meet, the farthest from its
    /// side first (CSS Align 9.3)
    pub fn gridJustifyBaselines(&mut self, from: i64) {
        let n: i64 = self.jbItems.len() as i64;
        let mut i: i64 = from;
        while i < n {
            let mut max_d: f64 = 0.0;
            let mut real: bool = false;
            let mut j: i64 = from;
            while j < n {
                if self.jbStart[j as usize] == self.jbStart[i as usize] && self.jbCol[j as usize].clone() == self.jbCol[i as usize].clone() {
                    if self.jbDist[j as usize] > max_d {
                        max_d = self.jbDist[j as usize];
                    }
                    if self.jbReal[j as usize] {
                        real = true;
                    }
                }
                j += 1;
            }
            // (a group with no real baseline falls back to start)
            if !real {
                max_d = self.jbDist[i as usize];
            }
            let it: Rc<RefCell<EVGElement>> = Rc::clone(&self.jbItems[i as usize]);
            let m: f64 = self.jbMargin[i as usize] + (max_d - self.jbDist[i as usize]);
            if self.jbStart[i as usize] {
                EVGElement::set_attribute(&it, "justify-self", "start".to_string());
                EVGElement::set_attribute(&it, "margin-left", format!("{}px", DomView::fmt(m)));
            } else {
                EVGElement::set_attribute(&it, "justify-self", "end".to_string());
                EVGElement::set_attribute(&it, "margin-right", format!("{}px", DomView::fmt(m)));
            }
            i += 1;
        }
        while (self.jbItems.len() as i64) > from {
            let last: i64 = (self.jbItems.len() as i64) - 1;
            self.jbItems.remove((last) as usize);
            self.jbStart.remove((last) as usize);
            self.jbDist.remove((last) as usize);
            self.jbCol.remove((last) as usize);
            self.jbMargin.remove((last) as usize);
            self.jbReal.remove((last) as usize);
        }
    }
    /// a vertical box in the other vertical mode than its parent's: the same
    /// axes, its blocks stacked the other way. Built in its own mode and
    /// turned over across its block axis (collectIn), its margins and insets
    /// on that axis the parent's
    fn flipped(&mut self, n: &Rc<RefCell<JsonValue>>, inh: Rc<RefCell<JsonValue>>, own: String) -> Rc<RefCell<EVGElement>> {
        self.memoBad += 1;
        // (the left and right margins and insets swapped: in its own mode
        // its block start is the other side)
        let s0: Rc<RefCell<JsonValue>> = n.borrow().get("s");
        let s1: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        let __n_i = s0.borrow().keys.len() as i64;
        for i in 0..__n_i {
            let k = s0.borrow().keys[i as usize].clone();
            let mut k1: String = k.clone();
            if k == "margin-left" {
                k1 = "margin-right".to_string();
            }
            if k == "margin-right" {
                k1 = "margin-left".to_string();
            }
            if k == "left" {
                k1 = "right".to_string();
            }
            if k == "right" {
                k1 = "left".to_string();
            }
            // (in a grid its own block start and end are the grid's block
            // end and start)
            let mut fv: Rc<RefCell<JsonValue>> = s0.borrow().items[i as usize].clone();
            if k == "align-self" && (self.outerS.borrow().getText("display") == "grid" || self.outerS.borrow().getText("display") == "inline-grid") {
                if s0.borrow().getText(&k) == "self-start" {
                    fv = JsonValue::mkStr("end".to_string());
                }
                if s0.borrow().getText(&k) == "self-end" {
                    fv = JsonValue::mkStr("start".to_string());
                }
            }
            // (its first baseline is the parent's last one, and the other
            // way round)
            let fpos: String = s0.borrow().getText("position");
            let f_in_flow: bool = fpos != "absolute" && fpos != "fixed";
            if (k == "align-self" && f_in_flow) && self.outerS.borrow().getText("display") != "block" {
                let fb: String = s0.borrow().getText(&k);
                if fb == "baseline" || fb == "first baseline" {
                    fv = JsonValue::mkStr("last baseline".to_string());
                }
                if fb == "last baseline" {
                    fv = JsonValue::mkStr("first baseline".to_string());
                }
            }
            s1.borrow_mut().put(&k1, fv.clone());
        }
        // (an item aligned by the parent's align-items the same way)
        let fpos2: String = s0.borrow().getText("position");
        if (fpos2 != "absolute" && fpos2 != "fixed") && (!s0.borrow().has("align-self") || s0.borrow().getText("align-self") == "auto") {
            let pai: String = self.outerS.borrow().getText("align-items");
            if pai == "baseline" || pai == "first baseline" {
                s1.borrow_mut().put("align-self", JsonValue::mkStr("last baseline".to_string()));
            }
            if pai == "last baseline" {
                s1.borrow_mut().put("align-self", JsonValue::mkStr("first baseline".to_string()));
            }
        }
        let n1: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        let __n_i2 = n.borrow().keys.len() as i64;
        for i2 in 0..__n_i2 {
            let k2 = n.borrow().keys[i2 as usize].clone();
            if k2 == "s" {
                n1.borrow_mut().put(&k2, s1.clone());
            } else {
                n1.borrow_mut().put(&k2, n.borrow().items[i2 as usize].clone());
            }
        }
        let was: String = self.wm.clone();
        self.wm = own.clone();
        let l: Rc<RefCell<EVGElement>> = self.element(&n1, inh.clone());
        self.wm = was.clone();
        let rhs_13 = format!("{} mfd-flip", l.borrow().class_name);
        l.borrow_mut().class_name = rhs_13;
        EVGElement::set_attribute(&l, "baseline-flip", "true".to_string());
        l
    }
    /// baselines across a flex column: an item in the other writing mode
    /// has its blocks across the column, and its first baseline is there.
    /// The items whose block start is the column's left are lined up on the
    /// baseline furthest from the left, the ones that start at the right
    /// (vertical-rl in a horizontal column) on the one furthest from the
    /// right, by their margins (CSS Box Alignment 9.3)
    fn columnBaselines(&self, e: &Rc<RefCell<EVGElement>>, s: &Rc<RefCell<JsonValue>>) {
        let ai: String = s.borrow().getText("align-items");
        let wrap_rev: bool = s.borrow().getText("flex-wrap") == "wrap-reverse";
        let mut items: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut bs: Vec<f64> = Vec::new();
        let mut ends: Vec<bool> = Vec::new();
        let mut max_s: f64 = 0.0;
        let mut max_e: f64 = 0.0;
        let __it_c = e.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            let mut al: String = c.borrow().align_self.clone();
            if al.is_empty() || al == "auto" {
                al = ai.clone();
            }
            let last_b: bool = al == "last baseline";
            if (al != "baseline" && al != "first baseline") && !last_b {
                continue;
            }
            let wrapped: bool = DomText::index_of(&c.borrow().class_name, "mfd-wm") == 0 && !c.borrow().children.is_empty();
            if !wrapped && (!self.wm.is_empty() && (!c.borrow().is_absolute && c.borrow().tag_name != "svg")) {
                // a box in the column's own vertical mode has its baseline
                // along the column: across it, the one synthesized at its
                // middle (CSS Box Alignment 9.1), by the size it fits to
                let mt: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                EVGElement::set_attribute(&mt, "display", "flex".to_string());
                EVGElement::set_attribute(&mt, "flex-direction", "column".to_string());
                EVGElement::set_attribute(&mt, "align-items", "flex-start".to_string());
                let _tmp_2 = EVGUnit::px(self.vh.clone());
                mt.borrow_mut().width = Some(_tmp_2);
                let _tmp_4 = EVGUnit::px(self.vw.clone());
                mt.borrow_mut().height = Some(_tmp_4);
                EVGElement::add_child(&mt, Rc::clone(&c));
                let was_a: String = c.borrow().align_self.clone();
                c.borrow_mut().align_self = "flex-start".to_string();
                let mlay: Rc<RefCell<EVGLayout>> = Rc::new(RefCell::new(EVGLayout::new()));
                let mut _tmp_5 = self.vh.clone();
                EVGLayout::set_page_size(&mlay, _tmp_5, self.vw.clone());
                EVGLayout::layout(&mlay, Rc::clone(&mt));
                c.borrow_mut().align_self = was_a.clone();
                let cw: f64 = c.borrow().calculated_width;
                let mut bm: f64 = cw / 2.0;
                let mut end_m: bool = last_b;
                if last_b {
                    bm += DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_right.clone());
                } else {
                    bm += DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_left.clone());
                }
                if wrap_rev {
                    bm = ((DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_left.clone()) + cw) + DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_right.clone())) - bm;
                    end_m = !end_m;
                }
                if end_m {
                    max_e = DomView::maxOf(max_e, bm);
                } else {
                    max_s = DomView::maxOf(max_s, bm);
                }
                items.push(Rc::clone(&c));
                bs.push(bm);
                ends.push(end_m);
                continue;
            }
            if !wrapped && ((self.wm.is_empty() && !wrap_rev) && (!c.borrow().is_absolute && c.borrow().tag_name != "svg")) {
                // a box in the column's horizontal mode has no baseline
                // across it: the one synthesized at its line-left edge
                // (its right one for a last baseline, in the end group;
                // wrap-reverse, which needs its width, is left out)
                let mut hb: f64 = DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_left.clone());
                let h_end: bool = last_b;
                if last_b {
                    hb = DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_right.clone());
                }
                if h_end {
                    max_e = DomView::maxOf(max_e, hb);
                } else {
                    max_s = DomView::maxOf(max_s, hb);
                }
                items.push(Rc::clone(&c));
                bs.push(hb);
                ends.push(h_end);
                continue;
            }
            if !wrapped {
                continue;
            }
            let l: Rc<RefCell<EVGElement>> = Rc::clone(&c.borrow().children[0]);
            let mut b: f64 = l.borrow().calculated_height;
            if l.borrow().has_baseline {
                b = l.borrow().calculated_baseline;
            }
            // (a vertical line's baseline is its middle, the central one)
            let vert_item: bool = self.wm.is_empty();
            let mut mid: f64 = -1.0;
            if vert_item {
                mid = DomView::lineMid(&l, &l, true);
            }
            if mid >= 0.0 {
                b = mid;
            }
            let mut atEnd: bool = self.wm.is_empty() && (DomText::index_of(&c.borrow().class_name, "horizontal") < 0 && DomText::index_of(&c.borrow().class_name, "vertical-rl") >= 0);
            // (a last baseline is by the block end: the group at the other
            // side, the distance from that side)
            if last_b {
                atEnd = !atEnd;
                b = l.borrow().calculated_height - l.borrow().calculated_last_baseline;
                if vert_item {
                    let mid_l: f64 = DomView::lineMid(&l, &l, false);
                    if mid_l >= 0.0 {
                        b = l.borrow().calculated_height - mid_l;
                    }
                }
            }
            if atEnd {
                b += DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_right.clone());
            } else {
                b += DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_left.clone());
            }
            // (wrap-reverse turns the cross axis: each group is at the
            // other side, its baselines measured from there)
            if wrap_rev {
                b = ((DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_left.clone()) + l.borrow().calculated_height) + DomView::mPx(c.borrow().r#box.as_ref().unwrap().borrow().margin_right.clone())) - b;
                atEnd = !atEnd;
            }
            if atEnd {
                max_e = DomView::maxOf(max_e, b);
            } else {
                max_s = DomView::maxOf(max_s, b);
            }
            items.push(Rc::clone(&c));
            bs.push(b);
            ends.push(atEnd);
        }
        let __n_k = items.len() as i64;
        for k in 0..__n_k {
            let c2 = Rc::clone(&items[k as usize]);
            let b2: f64 = bs[k as usize];
            if ends[k as usize] {
                let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(c2.borrow().r#box.as_ref().unwrap().borrow().margin_right.clone()) + (max_e - b2)));
                EVGElement::set_attribute(&c2, "margin-right", _tmp_1);
                EVGElement::set_attribute(&c2, "align-self", "flex-end".to_string());
            } else {
                let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(c2.borrow().r#box.as_ref().unwrap().borrow().margin_left.clone()) + (max_s - b2)));
                EVGElement::set_attribute(&c2, "margin-left", _tmp_1);
                EVGElement::set_attribute(&c2, "align-self", "flex-start".to_string());
            }
        }
    }
    /// an element and what is inside it
    fn element(&mut self, n: &Rc<RefCell<JsonValue>>, inh: Rc<RefCell<JsonValue>>) -> Rc<RefCell<EVGElement>> {
        let band: bool = self.bandOnly;
        self.bandOnly = false;
        let own: String = DomView::wmOf(&inh);
        if (own.is_empty()) != (self.wm.is_empty()) && !self.unturned {
            return self.orthogonal(n, inh.clone(), own.clone());
        }
        if (!own.is_empty() && own != self.wm) && !self.unturned {
            return self.flipped(n, inh.clone(), own.clone());
        }
        let s: Rc<RefCell<JsonValue>> = self.styleIn(n);
        // (a ratio of zero or infinity is auto, CSS Sizing 4 5.1)
        let zar: String = s.borrow().getText("aspect-ratio");
        if !zar.is_empty() && zar != "auto" {
            let mut zr: String = zar.clone();
            if zr.starts_with("auto") {
                zr = zr[(4) as usize..(zr.as_bytes().len() as i64) as usize].to_string();
            }
            zr = zr.trim().to_string();
            let zsl: i64 = DomText::index_of(&zr, "/");
            let mut zbad: bool = DomView::ratioOf(&zr) <= 0.0;
            if zsl >= 0 {
                let zb: Option<f64> = zr[(zsl + 1) as usize..(zr.as_bytes().len() as i64) as usize].to_string().trim().parse::<f64>().ok();
                if zb.is_some() && zb.unwrap() == 0.0 {
                    zbad = true;
                }
            }
            if zbad {
                self.putPage(&s, "aspect-ratio", "auto");
            }
        }
        let a: Rc<RefCell<JsonValue>> = n.borrow().get("a");
        let t: String = n.borrow().getText("t");
        let display: String = DomView::displayOf(n);
        let id: String = format!("{}{}", self.pfx, n.borrow().getText("i"));
        if n.borrow().has("svg") {
            // a picture: inline SVG, or an SVG file the host put in
            let p: Rc<RefCell<EVGElement>> = EVGElement::create_div();
            p.borrow_mut().tag_name = "svg".to_string();
            p.borrow_mut().id = id.clone();
            let src: String = n.borrow().getText("svg");
            EVGElement::set_attribute(&p, "svg", src.clone());
            // parsed in an earlier frame (EVG parses again if a fill is set,
            // which is part of its key)
            p.borrow_mut().svg_doc = Some(self.svgs.borrow_mut().docOf(&src));
            p.borrow_mut().svg_doc_key = src.clone();
            let vb: String = a.borrow().getText("viewBox");
            if !vb.is_empty() {
                EVGElement::set_attribute(&p, "viewBox", vb.clone());
            }
            self.style(&p, &s, "inline-block");
            EVGElement::set_attribute(&p, "flex-shrink", "0".to_string());
            // in a line: on the baseline (flush), or where vertical-align says
            let va: String = s.borrow().getText("vertical-align");
            if va == "middle" && !self.inFlex {
                EVGElement::set_attribute(&p, "align-self", "center".to_string());
            }
            if (va == "top" || va == "text-top") && !self.inFlex {
                EVGElement::set_attribute(&p, "align-self", "flex-start".to_string());
            }
            if (va == "bottom" || va == "text-bottom") && !self.inFlex {
                EVGElement::set_attribute(&p, "align-self", "flex-end".to_string());
            }
            // a length raises it from the baseline (flush adds the descent)
            if DomView::pxOf(&va) != 0.0 && !self.inFlex {
                EVGElement::set_attribute(&p, "margin-bottom", format!("{}px", DomView::fmt(DomView::pxOf(&s.borrow().getText("margin-bottom")) + DomView::pxOf(&va))));
            }
            // its size: the one set, else the attributes', else the
            // viewBox's ratio across the line, else 300 x 150 (CSS 2 10.3.2)
            let mut sw: String = s.borrow().getText("width");
            let mut sh: String = s.borrow().getText("height");
            if sw == "auto" || (sw == "max-content" || (sw == "min-content" || sw == "fit-content")) {
                sw = String::new();
            }
            if sh == "auto" || (sh == "max-content" || (sh == "min-content" || sh == "fit-content")) {
                sh = String::new();
            }
            let sar: String = s.borrow().getText("aspect-ratio");
            // (a percentage height of an indefinite one is auto, CSS 2
            // 10.5; an absolute box's is of its containing block)
            let spos: String = s.borrow().getText("position");
            if !sar.is_empty() && sar != "auto" && (DomText::index_of(&sh, "%") >= 0 && DomText::index_of(&sh, "(") < 0) && self.defH < 0.0 && (spos != "absolute" && spos != "fixed") {
                sh = String::new();
            }
            let aw: f64 = DomView::pxOf(&DomView::px(&a.borrow().getText("width")));
            let ah: f64 = DomView::pxOf(&DomView::px(&a.borrow().getText("height")));
            let mut ratio: f64 = 0.0;
            let vbs: Vec<String> = DomView::listOf(&vb);
            if (vbs.len() as i64) == 4 {
                let vw_1: Option<f64> = vbs[2].clone().parse::<f64>().ok();
                let vh_1: Option<f64> = vbs[3].clone().parse::<f64>().ok();
                if vw_1.is_some() && vh_1.is_some() {
                    if vw_1.unwrap() > 0.0 && vh_1.unwrap() > 0.0 {
                        ratio = vw_1.unwrap() / vh_1.unwrap();
                    }
                }
            }
            // (aspect-ratio: a ratio without auto is the one it has, auto
            // with one is the viewBox's when there is one)
            let svb_ratio: f64 = ratio;
            if !sar.is_empty() && sar != "auto" && self.wm.is_empty() {
                let sq: f64 = DomView::ratioOf(&sar.replace("auto", ""));
                if sq > 0.0 && (DomText::index_of(&sar, "auto") < 0 || ratio == 0.0) {
                    ratio = sq;
                }
            }
            let mut iw: f64 = aw;
            let mut ih: f64 = ah;
            if aw > 0.0 && (ah == 0.0 && ratio > 0.0) {
                ih = aw / ratio;
            }
            if ah > 0.0 && (aw == 0.0 && ratio > 0.0) {
                iw = ah * ratio;
            }
            let fill: bool = (aw == 0.0 && ah == 0.0) && svb_ratio > 0.0;
            if ratio > 0.0 && ratio != svb_ratio && sh.is_empty() && DomText::index_of(&DomView::px(&sw), "px") > 0 {
                ih = DomView::pxOf(&DomView::px(&sw)) / ratio;
            }
            if iw == 0.0 && !fill {
                iw = 300.0;
            }
            if ih == 0.0 && !fill {
                ih = 150.0;
            }
            // (a grid item of no ratio and no size of its own stretched in
            // an axis fills its area there, CSS Grid 11.3)
            let mut sgw: f64 = -1.0;
            let mut sgh: f64 = -1.0;
            if ratio == 0.0 && aw == 0.0 && ah == 0.0 {
                sgw = self.gridStretchPx(&s, true);
                sgh = self.gridStretchPx(&s, false);
            }
            let s_fill_w: bool = sgw >= 0.0;
            let s_fill_h: bool = sgh >= 0.0;
            if s_fill_w {
                iw = sgw;
                sw = format!("{}px", DomView::fmt(sgw));
            }
            if s_fill_h {
                ih = sgh;
                sh = format!("{}px", DomView::fmt(sgh));
            }
            if s_fill_w {
                EVGElement::set_attribute(&p, "justify-self", "stretch".to_string());
            }
            if s_fill_h {
                EVGElement::set_attribute(&p, "align-self", "stretch".to_string());
            }
            if !sw.is_empty() {
                EVGElement::set_attribute(&p, "width", DomView::px(&sw));
            } else {
                if fill {
                    EVGElement::set_attribute(&p, "width", "100%".to_string());
                } else {
                    if !sh.is_empty() {
                        if aw == 0.0 && (ratio > 0.0 && DomView::pxOf(&DomView::px(&sh)) > 0.0) {
                            let _tmp_1 = DomView::pxOf(&DomView::px(&sh)) * ratio;
                            EVGElement::set_attribute(&p, "width", format!("{}px", DomView::fmt(_tmp_1)));
                        } else {
                            EVGElement::set_attribute(&p, "width", format!("{}px", DomView::fmt(iw)));
                        }
                    } else {
                        EVGElement::set_attribute(&p, "width", format!("{}px", DomView::fmt(iw)));
                    }
                }
            }
            if !sh.is_empty() {
                EVGElement::set_attribute(&p, "height", DomView::px(&sh));
            } else {
                if ah == 0.0 && (fill || !sw.is_empty() && ratio > 0.0) {
                    EVGElement::set_attribute(&p, "aspect-ratio", ratio.to_string());
                } else {
                    EVGElement::set_attribute(&p, "height", format!("{}px", DomView::fmt(ih)));
                }
            }
            // (with no viewBox its user units are px from its corner, not
            // fitted into the box: a viewBox of the box's size where that
            // is known, a percentage height of a definite one included)
            if vb.is_empty() && DomText::index_of(&src, "viewBox") < 0 {
                let mut uw: f64 = iw;
                if !sw.is_empty() {
                    uw = -1.0;
                    if DomText::index_of(&DomView::px(&sw), "px") > 0 {
                        uw = DomView::pxOf(&DomView::px(&sw));
                    }
                }
                let mut uh: f64 = ih;
                if !sh.is_empty() {
                    uh = -1.0;
                    let shp: String = DomView::px(&sh);
                    if DomText::index_of(&shp, "px") > 0 {
                        uh = DomView::pxOf(&shp);
                    } else {
                        if shp.ends_with("%") && self.defH >= 0.0 {
                            let hp: Option<f64> = shp[0..((shp.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                            if hp.is_some() {
                                uh = self.defH * hp.unwrap() / 100.0;
                            }
                        }
                    }
                }
                let at: i64 = DomText::index_of(&src, "<svg");
                if ((uw > 0.0 && uh > 0.0) && !fill) && at >= 0 {
                    let cut: usize = (at + 4) as usize;
                    let src2: String = format!("{} viewBox=\"0 0 {} {}\"{}", src[0..cut].to_string(), DomView::fmt(uw), DomView::fmt(uh), src[cut..src.as_bytes().len()].to_string());
                    EVGElement::set_attribute(&p, "svg", src2.clone());
                    p.borrow_mut().svg_doc = Some(self.svgs.borrow_mut().docOf(&src2));
                    p.borrow_mut().svg_doc_key = src2.clone();
                }
            }
            // overflow: visible draws past the box (overflowing)
            // (web/dom leaves out the initial visible)
            let sox: String = s.borrow().getText("overflow-x");
            let soy: String = s.borrow().getText("overflow-y");
            if (sox.is_empty() || sox == "visible") && (soy.is_empty() || soy == "visible") {
                p.borrow_mut().class_name = "mfd-svgvis".to_string();
            }
            return p;
        }
        let e: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        e.borrow_mut().id = id.clone();
        self.emPx = DomView::pxOf(&inh.borrow().getText("font-size"));
        if self.emPx <= 0.0 {
            self.emPx = 16.0;
        }
        // the root's background is the canvas's, and with none of its own it
        // is the body's (CSS 2.1 14.2)
        if t == "html" {
            self.rootBackground(n, &s);
            let rbc: String = s.borrow().getText("background-color");
            let rbi: String = s.borrow().getText("background-image");
            if (!rbc.is_empty() && (rbc != "transparent" && rbc != "rgba(0, 0, 0, 0)")) || (!rbi.is_empty() && rbi != "none") {
                EVGElement::set_attribute(&e, "bg-canvas", format!("{} {}", DomView::fmt(self.vw), DomView::fmt(self.vh)));
            }
        }
        self.dirNow = inh.borrow().getText("direction");
        // (a percentage block margin of a box in a block's flow is of that
        // block's width; in px when that is, so it collapses with others,
        // CSS 2.1 8.3.1)
        self.pctBlockMargins(&s);
        self.style(&e, &s, &display);
        // (with no content its automatic minimum width is the ratio's,
        // CSS Flexbox 4.5; content's own least width EVG gives it)
        let arc: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        if (arc.borrow().kind != 4 || arc.borrow().items.is_empty()) && s.borrow().getText("min-width").is_empty() {
            let arfm: f64 = self.stretchedRatioWidth(&s);
            if arfm >= 0.0 {
                EVGElement::set_attribute(&e, "min-width", format!("{}px", DomView::fmt(arfm)));
            }
        }
        // (clip: rect() of an absolute box that leaves nothing of it: the
        // box is not drawn, CSS 2.1 11.1.2)
        let cpos: String = s.borrow().getText("position");
        if (cpos == "absolute" || cpos == "fixed") && DomView::clipEmpty(&s.borrow().getText("clip"), DomView::pxOf(&s.borrow().getText("font-size"))) {
            EVGElement::set_attribute(&e, "opacity", "0".to_string());
        }
        DomView::nativeLook(&e, &s, &t, &a.borrow().getText("type"));
        // an inline box placed by vertical-align in its line (flush)
        if (DomText::index_of(&display, "inline-") == 0 || display == "inline") && !self.inFlex {
            let iva: String = s.borrow().getText("vertical-align");
            // (an inline's middle is not its line's: it stays as it was)
            if iva == "middle" && display != "inline" {
                EVGElement::set_attribute(&e, "align-self", "center".to_string());
            }
            if iva == "top" || iva == "text-top" {
                EVGElement::set_attribute(&e, "align-self", "flex-start".to_string());
            }
            if iva == "bottom" || iva == "text-bottom" {
                EVGElement::set_attribute(&e, "align-self", "flex-end".to_string());
            }
        }
        // (a grid item's self-start and self-end are by its own direction:
        // against the grid's, the other end of the line)
        let gjd: String = self.outerS.borrow().getText("display");
        if gjd == "grid" || gjd == "inline-grid" {
            let gjv: String = s.borrow().getText("justify-self");
            if (gjv == "self-start" || gjv == "self-end") && (inh.borrow().getText("direction") == "rtl") != (self.outerS.borrow().getText("direction") == "rtl") {
                if gjv == "self-start" {
                    EVGElement::set_attribute(&e, "justify-self", "end".to_string());
                } else {
                    EVGElement::set_attribute(&e, "justify-self", "start".to_string());
                }
            }
        }
        // justify-self of a block in a block (CSS Box Alignment 6.1): its
        // auto width fits the content, placed at the start, the center or
        // the end of the line (EVG mirrors a right-to-left block's)
        if !self.inFlex {
            let mut bjs: String = s.borrow().getText("justify-self");
            if DomText::index_of(&bjs, "safe ") >= 0 {
                bjs = bjs[(DomText::index_of(&bjs, "safe ") + 5) as usize..(bjs.as_bytes().len() as i64) as usize].to_string();
            }
            let bpd: String = self.outerS.borrow().getText("display");
            let block_p: bool = bpd == "block" || (bpd == "flow-root" || (bpd == "list-item" || (bpd == "inline-block" || bpd == "table-cell")));
            let block_c: bool = display == "block" || (display == "flex" || (display == "grid" || (display == "flow-root" || (display == "list-item" || display == "table"))));
            let bpos: String = s.borrow().getText("position");
            let bfl: String = s.borrow().getText("float");
            if (block_p && block_c) && ((bpos != "absolute" && bpos != "fixed") && (bfl.is_empty() || bfl == "none")) {
                let mut brtl: bool = self.outerS.borrow().getText("direction") == "rtl";
                // (down a vertical line, left and right are its top and
                // bottom, and nothing is mirrored)
                let bvert: bool = !self.wm.is_empty();
                if bvert {
                    if bjs == "left" {
                        bjs = "line-left".to_string();
                    }
                    if bjs == "right" {
                        bjs = "line-right".to_string();
                    }
                }
                let mut side: String = String::new();
                if bjs == "line-left" {
                    side = "left".to_string();
                }
                if bjs == "line-right" {
                    side = "right".to_string();
                }
                if bjs == "start" || (bjs == "self-start" || bjs == "flex-start") {
                    side = "left".to_string();
                    if brtl {
                        side = "right".to_string();
                    }
                }
                if bjs == "end" || (bjs == "self-end" || bjs == "flex-end") {
                    side = "right".to_string();
                    if brtl {
                        side = "left".to_string();
                    }
                }
                if bjs == "left" || (bjs == "right" || bjs == "center") {
                    side = bjs.clone();
                }
                if side == "center" {
                    EVGElement::set_attribute(&e, "align-self", "center".to_string());
                }
                if bvert {
                    brtl = false;
                }
                if side == "left" {
                    if brtl {
                        EVGElement::set_attribute(&e, "align-self", "flex-end".to_string());
                    } else {
                        EVGElement::set_attribute(&e, "align-self", "flex-start".to_string());
                    }
                }
                if side == "right" {
                    if brtl {
                        EVGElement::set_attribute(&e, "align-self", "flex-start".to_string());
                    } else {
                        EVGElement::set_attribute(&e, "align-self", "flex-end".to_string());
                    }
                }
            }
        }
        // where the page has a scroll container scrolled (a text field's own
        // scroll is the window's, the host app's, M-Files: MfdApp.dashScroll)
        let sc: Rc<RefCell<JsonValue>> = n.borrow().get("sc");
        if ((sc.borrow().kind == 4 && (sc.borrow().items.len() as i64) == 2) && t != "input") && t != "textarea" {
            e.borrow_mut().scroll_left = if ((sc.borrow().items[0].clone().borrow().text().parse::<f64>().ok()).is_some()) { ((sc.borrow().items[0].clone().borrow().text().parse::<f64>().ok()).unwrap()) } else { 0.0 };
            e.borrow_mut().scroll_top = if ((sc.borrow().items[1].clone().borrow().text().parse::<f64>().ok()).is_some()) { ((sc.borrow().items[1].clone().borrow().text().parse::<f64>().ok()).unwrap()) } else { 0.0 };
        }
        if t == "br" {
            // a line break's box is the line it ends: no width, a line tall
            let rhs_14 = format!("{} mfd-br", e.borrow().class_name);
            e.borrow_mut().class_name = rhs_14;
            EVGElement::set_attribute(&e, "width", "0px".to_string());
            // (the box is the font's, ascent to descent, as Chromium has
            // it; the leading around it is margin)
            let br_lh: f64 = DomView::lineHeight(&inh);
            let mut br_fs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
            if br_fs == 0.0 {
                br_fs = 16.0;
            }
            let br_ca: f64 = DomView::normalLine(&inh, br_fs);
            EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt(br_ca)));
            // (as a flex item its automatic minimum is that line)
            EVGElement::set_attribute(&e, "min-height", format!("{}px", DomView::fmt(br_ca)));
            if br_lh != br_ca {
                let half: f64 = (br_lh - br_ca) / 2.0;
                EVGElement::set_attribute(&e, "margin-top", format!("{}px", DomView::fmt(half)));
                EVGElement::set_attribute(
                    &e,
                    "margin-bottom",
                    format!("{}px", DomView::fmt((br_lh - br_ca) - half))
                );
            }
        }
        if t == "button" && (display == "block" || display == "inline-block") {
            // a button's content is in the middle of it, top to bottom
            EVGElement::set_attribute(&e, "justify-content", "center".to_string());
            // and a button in a block is as wide as its content, not the line
            if (!self.inFlex && (s.borrow().getText("width").as_bytes().len() as i64) == 0) && !DomView::sizeContained(&s) {
                EVGElement::set_attribute(&e, "width", "fit-content".to_string());
            }
            // (size-contained, its baseline is its content box's bottom)
            if DomView::sizeContained(&s) && display == "inline-block" {
                EVGElement::set_attribute(&e, "baseline-from-bottom", DomView::fmt(DomView::pxOf(&s.borrow().getText("padding-bottom")) + DomView::side(&s, "bottom")));
            }
        }
        // (so is a button laid out as a flex or grid container)
        if t == "button" && (display == "flex" || display == "grid") {
            let bw: String = s.borrow().getText("width");
            if (!self.inFlex && (bw.is_empty() || bw == "auto")) && !DomView::sizeContained(&s) {
                EVGElement::set_attribute(&e, "width", "fit-content".to_string());
            }
        }
        let mut label: String = a.borrow().getText("aria-label");
        if label.is_empty() {
            label = a.borrow().getText("title");
        }
        let role: String = a.borrow().getText("role");
        if t == "button" || (t == "a" || role == "button") {
            e.borrow_mut().role = "button".to_string();
            if label.is_empty() {
                label = DomView::trimmed(&DomView::collapse(&self.textOf(n)));
            }
        }
        if !label.is_empty() {
            e.borrow_mut().a11y_label = label.clone();
        }
        e.borrow_mut().a11y_disabled = a.borrow().getBool("disabled", false);
        if t == "input" || (t == "textarea" || t == "select") {
            // a form control: what it holds, or its placeholder
            let mut val: String = a.borrow().getText("value");
            let mut tinh: Rc<RefCell<JsonValue>> = inh.clone();
            if val.is_empty() {
                val = a.borrow().getText("placeholder");
                tinh = self.inherit(&inh, &JsonValue::mkObj());
                tinh.borrow_mut().put("color", JsonValue::mkStr("rgb(117, 117, 117)".to_string()));
            }
            if a.borrow().getText("type") == "checkbox" || a.borrow().getText("type") == "radio" {
                // drawn as Chromium draws it (its native look): a 13px box
                EVGElement::set_attribute(&e, "width", "13px".to_string());
                EVGElement::set_attribute(&e, "height", "13px".to_string());
                EVGElement::set_attribute(&e, "border-width", "0px".to_string());
                EVGElement::set_attribute(&e, "padding", "0px".to_string());
                EVGElement::set_attribute(&e, "background-color", "rgba(0, 0, 0, 0)".to_string());
                // (in a line its baseline is its border box's bottom, the
                // bottom margin under it: a picture's is its margin's)
                if !self.inFlex {
                    EVGElement::set_attribute(&e, "margin-bottom", "0px".to_string());
                }
                e.borrow_mut().role = a.borrow().getText("type");
                e.borrow_mut().a11y_checked = 1;
                if a.borrow().getBool("checked", false) {
                    e.borrow_mut().a11y_checked = 2;
                }
                let mark: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                mark.borrow_mut().tag_name = "svg".to_string();
                EVGElement::set_attribute(
                    &mark,
                    "svg",
                    DomView::checkSvg(&a.borrow().getText("type"), a.borrow().getBool("checked", false), a.borrow().getBool("disabled", false))
                );
                EVGElement::set_attribute(&mark, "viewBox", "0 0 13 13".to_string());
                EVGElement::set_attribute(&mark, "width", "13px".to_string());
                EVGElement::set_attribute(&mark, "height", "13px".to_string());
                EVGElement::add_child(&e, Rc::clone(&mark));
                return e;
            }
            if t == "textarea" && (s.borrow().getText("height").as_bytes().len() as i64) == 0 {
                // as tall as its rows (2 by default) of lines
                let rows: Option<i64> = a.borrow().getText("rows").parse::<i64>().ok();
                let mut nr: i64 = 2;
                if rows.is_some() {
                    nr = rows.unwrap();
                }
                let lh: f64 = DomView::lineHeight(&inh);
                let th: f64 = (nr as f64) * lh + (DomView::pxOf(&s.borrow().getText("padding-top")) + (DomView::pxOf(&s.borrow().getText("padding-bottom")) + (DomView::side(&s, "top") + DomView::side(&s, "bottom"))));
                EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt(th)));
            }
            if DomView::textField(n) {
                // its text scrolls inside it (the window shifts it, decorate):
                // an input's on one line, a textarea's wrapped
                EVGElement::set_attribute(&e, "overflow", "hidden".to_string());
                let mut ws: String = "pre-wrap".to_string();
                if t == "input" {
                    ws = "pre".to_string();
                }
                tinh = self.inherit(&tinh, &JsonValue::mkObj());
                tinh.borrow_mut().put("white-space", JsonValue::mkStr(ws.to_string()));
            }
            // (a compressible control's percentage width counts as 0 in its
            // minimum: calc(140px + 100%) shrinks no further than 140px,
            // CSS Sizing 3, 5.2.2)
            let cw: String = s.borrow().getText("width");
            let cmin: String = s.borrow().getText("min-width");
            if (cmin == "auto" || cmin.is_empty()) && (DomText::index_of(&cw, "calc(") == 0 && DomText::index_of(&cw, "%") > 0) {
                let cu: Rc<RefCell<EVGUnit>> = EVGUnit::parse(&cw);
                if cu.borrow().is_set {
                    EVGUnit::resolve(&cu, 0.0, 16.0);
                    if cu.borrow().pixels > 0.0 {
                        EVGElement::set_attribute(&e, "min-width", format!("{}px", DomView::fmt(cu.borrow().pixels.clone())));
                    }
                }
            }
            // (an empty field is a line tall all the same)
            if val.is_empty() && DomView::textField(n) {
                val = " ".to_string();
            }
            e.borrow_mut().role = "textbox".to_string();
            e.borrow_mut().a11y_value = a.borrow().getText("value");
            if e.borrow().a11y_label.is_empty() {
                e.borrow_mut().a11y_label = a.borrow().getText("placeholder");
            }
            EVGElement::add_child(&e, self.textEl(val.clone(), &tinh, String::new()));
            return e;
        }
        // (a drawn canvas has its picture and its text as children,
        // webapi.js canvasRender: a box of its own like any element)
        let mut drawn_canvas: bool = false;
        if t == "canvas" {
            let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
            drawn_canvas = kids.borrow().kind == 4 && !kids.borrow().items.is_empty();
        }
        // (a video with nothing to show is 300 by 150, with no ratio
        // between the two, CSS 2 10.3.2 and 10.6.2)
        // (an iframe's too, its width and height attributes its size; its
        // document is not drawn)
        if (t == "video" || t == "iframe") && self.wm.is_empty() {
            let mut vw_2: String = s.borrow().getText("width");
            let mut vh_2: String = s.borrow().getText("height");
            if t == "iframe" {
                let fa: Rc<RefCell<JsonValue>> = n.borrow().get("a");
                let mut faw: String = DomView::px(&fa.borrow().getText("width"));
                let mut fah: String = DomView::px(&fa.borrow().getText("height"));
                // (a percentage attribute is the style's; of an indefinite
                // height it is auto)
                if DomText::index_of(&faw, "%") >= 0 {
                    faw = String::new();
                }
                if DomText::index_of(&fah, "%") >= 0 {
                    fah = String::new();
                }
                let fpos: String = s.borrow().getText("position");
                if ((DomText::index_of(&vh_2, "%") >= 0 && DomText::index_of(&vh_2, "(") < 0) && self.defH < 0.0) && (fpos != "absolute" && fpos != "fixed") {
                    vh_2 = String::new();
                    self.putPage(&s, "height", "");
                }
                if (vw_2.is_empty() || vw_2 == "auto") && !faw.is_empty() {
                    EVGElement::set_attribute(&e, "width", faw.clone());
                    self.putPage(&s, "width", &faw);
                    vw_2 = faw.clone();
                }
                if (vh_2.is_empty() || vh_2 == "auto") && !fah.is_empty() {
                    EVGElement::set_attribute(&e, "height", fah.clone());
                    self.putPage(&s, "height", &fah);
                    vh_2 = fah.clone();
                }
                // (an aspect-ratio and one side set: the other follows it;
                // stretched across a flex line of a set size: the line's)
                let far: String = s.borrow().getText("aspect-ratio");
                let has_ar: bool = !far.is_empty() && far != "auto";
                let fpd: String = self.outerS.borrow().getText("display");
                let ffd: String = self.outerS.borrow().getText("flex-direction");
                let mut fas: String = s.borrow().getText("align-self");
                if fas.is_empty() || fas == "auto" {
                    fas = self.outerS.borrow().getText("align-items");
                }
                let fstretch: bool = (fpd == "flex" || fpd == "inline-flex") && (fas.is_empty() || (fas == "normal" || fas == "stretch"));
                let fcol: bool = ffd == "column" || ffd == "column-reverse";
                let w_set: bool = !(vw_2.is_empty() || vw_2 == "auto");
                let h_set: bool = !(vh_2.is_empty() || vh_2 == "auto");
                if (has_ar && w_set && !h_set) || ((fstretch && !fcol) && DomText::index_of(&self.outerS.borrow().getText("height"), "px") > 0) {
                    vh_2 = "-".to_string();
                }
                if (has_ar && h_set && !w_set) || ((fstretch && fcol) && DomText::index_of(&self.outerS.borrow().getText("width"), "px") > 0) {
                    vw_2 = "-".to_string();
                }
            } else {
                // (a video's too: an aspect-ratio and one side set)
                let var: String = s.borrow().getText("aspect-ratio");
                if !var.is_empty() && var != "auto" {
                    let vws: bool = !(vw_2.is_empty() || vw_2 == "auto");
                    let vhs: bool = !(vh_2.is_empty() || vh_2 == "auto");
                    if vws && !vhs {
                        vh_2 = "-".to_string();
                    }
                    if vhs && !vws {
                        vw_2 = "-".to_string();
                    }
                }
            }
            if vw_2.is_empty() || vw_2 == "auto" {
                EVGElement::set_attribute(&e, "width", "300px".to_string());
                self.putPage(&s, "width", "300px");
            }
            if vh_2.is_empty() || vh_2 == "auto" {
                EVGElement::set_attribute(&e, "height", "150px".to_string());
                self.putPage(&s, "height", "150px");
            }
        }
        if t == "img" || t == "canvas" && !drawn_canvas {
            // an image that is not SVG: its box, and its alt text. Its size
            // is the one set, else the attribute's, else the picture's own
            // (one side set: the other from the picture's ratio). A
            // canvas's bitmap is drawn
            if t == "img" && n.borrow().has("s3d") {
                // a .tsx document's <scene3d> the page draws on the GPU (a
                // native slot of kind scene3d): a box with a background, so
                // the slot finds its place in paint order
                if s.borrow().getText("background-color").is_empty() {
                    EVGElement::set_attribute(&e, "background-color", "#000000".to_string());
                }
                let sid: String = e.borrow().id.clone();
                self.svgs.borrow_mut().sceneIds.push(sid);
                self.memoBad += 1;
                self.svgs.borrow_mut().scenes.push(n.clone());
            }
            if n.borrow().has("png") {
                e.borrow_mut().src = DomView::pngPart(&n.borrow().getText("png"));
            } else if t == "img" && DomView::pictureUrl(&a.borrow().getText("src")) {
                // a picture given as a data: URL: the hosts get its bytes
                // (pngs) under the same name a canvas's bitmap has
                e.borrow_mut().src = DomView::pngPart(&a.borrow().getText("src"));
            }
            // (an SVG picture as a data: URL: its document drawn into the
            // box, scaled as its viewBox, else its width and height, say)
            if t == "img" && DomView::svgUrl(&a.borrow().getText("src")) {
                let sv: String = DomView::svgOfUrl(&a.borrow().getText("src"));
                let sat: i64 = DomText::index_of(&sv, "<svg");
                // (one of no ratio: one side set, the other is its own size,
                // else 300 by 150, CSS 2.1 10.3.2 and 10.6.2)
                let snr: Vec<f64> = DomView::svgNoRatio(&a.borrow().getText("src"));
                // (stretched in a grid's area: that size there, CSS Grid 11.3)
                if (snr.len() as i64) == 2 && self.wm.is_empty() {
                    let igw: f64 = self.gridStretchPx(&s, true);
                    let igh: f64 = self.gridStretchPx(&s, false);
                    if igw >= 0.0 {
                        self.putPage(&s, "width", &format!("{}px", DomView::fmt(igw)));
                        EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(igw)));
                    }
                    if igh >= 0.0 {
                        self.putPage(&s, "height", &format!("{}px", DomView::fmt(igh)));
                        EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt(igh)));
                    }
                }
                if (snr.len() as i64) == 2 && self.wm.is_empty() {
                    let nsw: String = s.borrow().getText("width");
                    let nsh: String = s.borrow().getText("height");
                    let nsw_set: bool = nsw.ends_with("px");
                    let nsh_set: bool = nsh.ends_with("px");
                    if nsw_set && (nsh.is_empty() || nsh == "auto") {
                        let nh: f64 = if snr[1] < 0.0 { 150.0 } else { snr[1] };
                        self.putPage(&s, "height", &format!("{}px", DomView::fmt(nh)));
                        EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt(nh)));
                    }
                    if nsh_set && (nsw.is_empty() || nsw == "auto") {
                        let nw: f64 = if snr[0] < 0.0 { 300.0 } else { snr[0] };
                        self.putPage(&s, "width", &format!("{}px", DomView::fmt(nw)));
                        EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(nw)));
                    }
                }
                if sat >= 0 {
                    let mut sv2: String = sv.clone();
                    let svw: f64 = DomView::svgAttr(&sv, "width");
                    let svh: f64 = DomView::svgAttr(&sv, "height");
                    if DomView::svgAttrText(&sv, "viewBox").is_empty() && svw > 0.0 && svh > 0.0 {
                        let cut0: usize = (sat + 4) as usize;
                        sv2 = format!("{} viewBox=\"0 0 {} {}\"{}", sv[0..cut0].to_string(), DomView::fmt(svw), DomView::fmt(svh), sv[cut0..sv.as_bytes().len()].to_string());
                    }
                    // (one of no ratio: its user units are the box's px, the
                    // box its set size, else its own, else 300 by 150)
                    if DomView::svgAttrText(&sv, "viewBox").is_empty() && !(svw > 0.0 && svh > 0.0) {
                        let mut bxw: f64 = DomView::pxOf(&s.borrow().getText("width"));
                        let mut bxh: f64 = DomView::pxOf(&s.borrow().getText("height"));
                        if bxw <= 0.0 {
                            bxw = if svw > 0.0 { svw } else { 300.0 };
                        }
                        if bxh <= 0.0 {
                            bxh = if svh > 0.0 { svh } else { 150.0 };
                        }
                        let cut1: usize = (sat + 4) as usize;
                        sv2 = format!("{} viewBox=\"0 0 {} {}\"{}", sv[0..cut1].to_string(), DomView::fmt(bxw), DomView::fmt(bxh), sv[cut1..sv.as_bytes().len()].to_string());
                    }
                    // (percentages in it are of the viewBox: the root's
                    // width and height are the viewBox's, the box scales it)
                    let svbl: Vec<String> = DomView::listOf(&DomView::svgAttrText(&sv2, "viewBox"));
                    if (svbl.len() as i64) == 4 {
                        sv2 = DomView::svgRootAttr(&DomView::svgRootAttr(&sv2, "width", &svbl[2]), "height", &svbl[3]);
                    }
                    // (the root's background-color fills the picture)
                    let sst: String = DomView::svgAttrText(&sv2, "style");
                    let sbk: i64 = DomText::index_of(&sst, "background-color:");
                    let sat2: i64 = DomText::index_of(&sv2, "<svg");
                    let sgt: i64 = DomText::index_of_from(&sv2, ">", sat2);
                    if sbk >= 0 && sgt > 0 {
                        let mut sbv: String = sst[((sbk + 17) as usize)..sst.as_bytes().len()].to_string();
                        let semi: i64 = DomText::index_of(&sbv, ";");
                        if semi >= 0 {
                            sbv = sbv[0..semi as usize].to_string();
                        }
                        sbv = sbv.trim().to_string();
                        let mut ins: usize = (sgt + 1) as usize;
                        let mut tail: String = String::new();
                        if sv2[(sgt - 1) as usize..sgt as usize].to_string() == "/" {
                            ins = (sgt - 1) as usize;
                            tail = "</svg>".to_string();
                        }
                        let close: String = sv2[ins..(sgt + 1) as usize].to_string();
                        let close2: String = close.replace("/>", ">");
                        sv2 = format!("{}{}<rect x=\"-100000\" y=\"-100000\" width=\"200000\" height=\"200000\" fill=\"{}\"/>{}{}", sv2[0..ins].to_string(), close2, sbv, sv2[((sgt + 1) as usize)..sv2.as_bytes().len()].to_string(), tail);
                    }
                    // (the display list draws a document on an svg box, in
                    // its border box: with a border or padding the picture
                    // is a box of its own filling the content box)
                    let mut chrome: f64 = 0.0;
                    for sd in vec!["top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string()].iter().cloned() {
                        chrome += DomView::side(&s, &sd) + DomView::pxOf(&s.borrow().getText(&format!("padding-{}", sd)));
                    }
                    let mut pic: Rc<RefCell<EVGElement>> = Rc::clone(&e);
                    if chrome != 0.0 {
                        pic = EVGElement::create_div();
                        pic.borrow_mut().id = format!("{}-pic", id);
                        EVGElement::set_attribute(&pic, "flex-grow", "1".to_string());
                        EVGElement::set_attribute(&pic, "flex-shrink", "1".to_string());
                        EVGElement::set_attribute(&pic, "min-width", "0px".to_string());
                        EVGElement::set_attribute(&pic, "align-self", "stretch".to_string());
                        EVGElement::set_attribute(&e, "display", "flex".to_string());
                        EVGElement::set_attribute(&e, "flex-direction", "row".to_string());
                        EVGElement::add_child(&e, Rc::clone(&pic));
                    }
                    EVGElement::set_attribute(&pic, "svg", sv2.clone());
                    pic.borrow_mut().tag_name = "svg".to_string();
                    // (a picture is cut to its box)
                    EVGElement::set_attribute(&pic, "overflow", "hidden".to_string());
                    pic.borrow_mut().svg_doc = Some(self.svgs.borrow_mut().docOf(&sv2));
                    pic.borrow_mut().svg_doc_key = sv2.clone();
                }
            }
            let alt: String = a.borrow().getText("alt");
            let mut nat: Vec<f64> = DomView::imageSize(&DomView::imgSrc(&n));
            // (in a vertical frame the attributes and the picture's own
            // size are turned as the style is)
            let mut attr_w: String = a.borrow().getText("width");
            let mut attr_h: String = a.borrow().getText("height");
            // (a canvas's attributes are its bitmap's size, 300 by 150 when
            // left out: its own size, not a set one)
            if t == "canvas" {
                let mut cv_w: f64 = DomView::pxOf(&DomView::px(&attr_w));
                let mut cv_h: f64 = DomView::pxOf(&DomView::px(&attr_h));
                if attr_w.is_empty() {
                    cv_w = 300.0;
                }
                if attr_h.is_empty() {
                    cv_h = 150.0;
                }
                nat = vec![cv_w, cv_h];
                attr_w = String::new();
                attr_h = String::new();
            }
            // (size containment: no natural size but contain-intrinsic-size's,
            // CSS Containment 3.2)
            if DomView::sizeContained(&s) && DomText::index_of(&s.borrow().getText("contain"), "inline-size") < 0 {
                let ccs: Vec<String> = s.borrow().getText("contain-intrinsic-size").trim().to_string().split(" ").map(|s| s.to_string()).collect::<Vec<String>>();
                let mut ccv: Vec<String> = Vec::new();
                for cc in ccs.iter().cloned() {
                    if !cc.is_empty() && cc != "auto" {
                        ccv.push(cc.clone());
                    }
                }
                let mut ccw: f64 = 0.0;
                let mut cch: f64 = 0.0;
                if !ccv.is_empty() {
                    ccw = DomView::pxOf(&ccv[0].clone());
                    cch = ccw;
                }
                if (ccv.len() as i64) > 1 {
                    cch = DomView::pxOf(&ccv[1].clone());
                }
                // (with none given the picture keeps its own: its ratio is
                // what an aspect-ratio of auto falls back to here)
                if !ccv.is_empty() {
                    nat = vec![ccw, cch];
                    // (those lengths are no ratio: a set width leaves the
                    // height theirs, and the other way round)
                    let csw: String = s.borrow().getText("width");
                    let csh: String = s.borrow().getText("height");
                    let csw_set: bool = !csw.is_empty() && csw != "auto";
                    let csh_set: bool = !csh.is_empty() && csh != "auto";
                    let csar: String = s.borrow().getText("aspect-ratio");
                    if csar.is_empty() || csar == "auto" {
                        if csw_set && !csh_set {
                            self.putPage(&s, "height", &format!("{}px", DomView::fmt(cch)));
                        }
                        if csh_set && !csw_set {
                            self.putPage(&s, "width", &format!("{}px", DomView::fmt(ccw)));
                        }
                    }
                }
            }
            if !self.wm.is_empty() {
                if t != "canvas" {
                    attr_w = a.borrow().getText("height");
                    attr_h = a.borrow().getText("width");
                }
                if (nat.len() as i64) == 2 {
                    let n0: f64 = nat[0];
                    let n1: f64 = nat[1];
                    nat = vec![n1, n0];
                }
            }
            // (a picture's width and height attributes are in its style
            // already, as presentational hints, unless a rule said auto)
            if t == "img" && self.wm.is_empty() {
                attr_w = String::new();
                attr_h = String::new();
            }
            let mut set_w: String = DomView::or(&s.borrow().getText("width"), &DomView::px(&attr_w));
            let mut set_h: String = DomView::or(&s.borrow().getText("height"), &DomView::px(&attr_h));
            // (an intrinsic size keyword is the picture's own size, as auto)
            if set_w == "auto" || (set_w == "min-content" || (set_w == "max-content" || set_w == "fit-content")) {
                if set_w != "auto" {
                    self.putPage(&s, "width", "");
                }
                set_w = String::new();
            }
            if set_h == "auto" {
                set_h = String::new();
            }
            // (a percentage height of a definite one is a length, the width
            // following by the ratio)
            if (set_w.is_empty() && ((set_h.as_bytes().len() as i64) > 1 && set_h[((set_h.as_bytes().len() as i64) - 1) as usize..(set_h.as_bytes().len() as i64) as usize].to_string() == "%")) && (self.defH >= 0.0 && self.wm.is_empty()) {
                let shq: Option<f64> = set_h[(0) as usize..((set_h.as_bytes().len() as i64) - 1) as usize].to_string()
                    .parse::<f64>()
                    .ok();
                if shq.is_some() {
                    set_h = format!("{}px", DomView::fmt((self.defH * shq.unwrap()) / 100.0));
                    self.putPage(&s, "height", &set_h);
                }
            }
            // (a percentage height of a height that is not definite is auto:
            // the picture's ratio gives it, CSS 2.1 10.5; a flexed item's
            // may still be definite, and a picture of no known size keeps it)
            if ((set_h.as_bytes().len() as i64) > 1 && (set_h[((set_h.as_bytes().len() as i64) - 1) as usize..(set_h.as_bytes().len() as i64) as usize].to_string() == "%" && DomText::index_of(&set_h, "(") < 0)) && (self.defH < 0.0 && (self.wm.is_empty() && ((!self.defHMaybe || self.inFlex) && (nat.len() as i64) == 2))) {
                let ph_pos: String = s.borrow().getText("position");
                if ph_pos != "absolute" && ph_pos != "fixed" {
                    set_h = String::new();
                    self.putPage(&s, "height", "");
                    EVGElement::set_attribute(&e, "height", "auto".to_string());
                }
            }
            let mut nat_w: f64 = 16.0;
            let mut nat_h: f64 = 16.0;
            if (nat.len() as i64) == 2 {
                nat_w = nat[0];
                nat_h = nat[1];
            }
            // (a picture with no source and no alt text has no size: an
            // empty box)
            // (a drawing of no width of its own is as wide as it may be:
            // fit-content down a column is the column's width at most)
            if t == "img" && self.wm.is_empty() && (nat.len() as i64) == 2 && DomView::svgUrl(&DomView::imgSrc(&n)) {
                let nsvg: String = DomView::svgOfUrl(&DomView::imgSrc(&n));
                let cfd: String = self.outerS.borrow().getText("display");
                let cfdir: String = self.outerS.borrow().getText("flex-direction");
                let cw: f64 = DomView::pxOf(&self.outerS.borrow().getText("width"));
                if DomView::svgAttr(&nsvg, "width") <= 0.0 && DomView::svgAttr(&nsvg, "height") <= 0.0 && (cfd == "flex" || cfd == "inline-flex") && (cfdir == "column" || cfdir == "column-reverse") && cw > 0.0 && nat_w > cw {
                    nat_h = (nat_h * cw) / nat_w;
                    nat_w = cw;
                }
            }
            let no_source: bool = (t == "img" && (nat.len() as i64) != 2) && ((a.borrow().getText("src").as_bytes().len() as i64) == 0 && alt.is_empty());
            if no_source {
                nat_w = 0.0;
                nat_h = 0.0;
            }
            // justify-self: stretch in a grid makes it as wide as its area,
            // the height following by the ratio
            let pgd: String = self.outerS.borrow().getText("display");
            let mut pjs: String = s.borrow().getText("justify-self");
            if pjs.is_empty() || pjs == "auto" {
                pjs = self.outerS.borrow().getText("justify-items");
            }
            let mut pas: String = s.borrow().getText("align-self");
            if pas.is_empty() || pas == "auto" {
                pas = self.outerS.borrow().getText("align-items");
            }
            // min- and max- sizes hold the picture's own size keeping its
            // ratio where they can (CSS 2 10.4's table)
            let mut fixed_h: bool = false;
            let mut col_stretch: bool = false;
            let mut col_grow: bool = false;
            // (stretched across a column: the column's width)
            if set_w.is_empty() && self.wm.is_empty() {
                let cpd: String = self.outerS.borrow().getText("display");
                let cdir: String = self.outerS.borrow().getText("flex-direction");
                if (cpd == "flex" || cpd == "inline-flex") && (cdir == "column" || cdir == "column-reverse") {
                    let mut cas: String = s.borrow().getText("align-self");
                    if cas.is_empty() || cas == "auto" {
                        cas = self.outerS.borrow().getText("align-items");
                    }
                    if cas.is_empty() || (cas == "normal" || cas == "stretch") {
                        col_stretch = true;
                    } else {
                        // (growing down a column: the width follows the
                        // flexed height by the ratio)
                        let cgr: String = s.borrow().getText("flex-grow");
                        if !cgr.is_empty() && cgr != "0" {
                            col_grow = true;
                            // (said on the item, so the layout knows it is not
                            // stretched)
                            EVGElement::set_attribute(&e, "align-self", cas.clone());
                        }
                    }
                }
            }
            // a flex item: a definite basis down a column, or the stretch
            // across a row of a set height, is its height, the width
            // following by the ratio
            if (set_w.is_empty() && set_h.is_empty()) && (nat_w > 0.0 && nat_h > 0.0) {
                let fpd: String = self.outerS.borrow().getText("display");
                if fpd == "flex" || fpd == "inline-flex" {
                    let fdir: String = self.outerS.borrow().getText("flex-direction");
                    let col_p: bool = fdir == "column" || fdir == "column-reverse";
                    let basis: f64 = DomView::pxOf(&s.borrow().getText("flex-basis"));
                    let mut fas: String = s.borrow().getText("align-self");
                    if fas.is_empty() || fas == "auto" {
                        fas = self.outerS.borrow().getText("align-items");
                    }
                    let stretch_x: bool = fas.is_empty() || (fas == "normal" || fas == "stretch");
                    let ph: f64 = DomView::pxOf(&self.outerS.borrow().getText("height"));
                    if col_p && basis > 0.0 {
                        nat_w = (basis * nat_w) / nat_h;
                        nat_h = basis;
                    }
                    // (stretched across a column: the column's width)
                    if !col_p && (stretch_x && ph > 0.0) {
                        let mut in_h: f64 = (((ph - DomView::pxOf(&self.outerS.borrow().getText("padding-top"))) - DomView::pxOf(&self.outerS.borrow().getText("padding-bottom"))) - DomView::pxOf(&s.borrow().getText("margin-top"))) - DomView::pxOf(&s.borrow().getText("margin-bottom"));
                        if self.outerS.borrow().getText("box-sizing") == "border-box" {
                            in_h = (in_h - DomView::pxOf(&self.outerS.borrow().getText("border-top-width"))) - DomView::pxOf(&self.outerS.borrow().getText("border-bottom-width"));
                        }
                        if in_h > 0.0 {
                            nat_w = (in_h * nat_w) / nat_h;
                            nat_h = in_h;
                        } else {
                            // (margins over the line's height: nothing left)
                            nat_w = 0.0;
                            nat_h = 0.0;
                        }
                    }
                }
            }
            // (with box-sizing: border-box the limits are of the border box,
            // the picture's size of the content box)
            let mut hc: f64 = 0.0;
            let mut vc: f64 = 0.0;
            if s.borrow().getText("box-sizing") == "border-box" {
                hc = ((DomView::pxOf(&s.borrow().getText("padding-left")) + DomView::pxOf(&s.borrow().getText("padding-right"))) + DomView::side(&s, "left")) + DomView::side(&s, "right");
                vc = ((DomView::pxOf(&s.borrow().getText("padding-top")) + DomView::pxOf(&s.borrow().getText("padding-bottom"))) + DomView::side(&s, "top")) + DomView::side(&s, "bottom");
            }
            // (an aspect-ratio without auto is of the box box-sizing names:
            // the picture's width with its chrome, the height by the ratio,
            // then the limits, CSS 2 10.4's table)
            let car: String = s.borrow().getText("aspect-ratio");
            let mut carq: f64 = 0.0;
            if !car.is_empty() && DomText::index_of(&car, "auto") < 0 {
                carq = DomView::ratioOf(&car);
            }
            if ((set_w.is_empty() && set_h.is_empty()) && (nat_w > 0.0 && nat_h > 0.0)) && (carq > 0.0 && self.wm.is_empty()) {
                let bw0: f64 = nat_w + hc;
                let mut _tmp_1 = self.widthLimit(&s, "min-width");
                let mut _tmp_2 = self.widthLimit(&s, "max-width");
                let mut _tmp_3 = self.heightLimit(&s, "min-height");
                let mut _tmp_4 = self.heightLimit(&s, "max-height");
                let rcs: Vec<f64> = DomView::constrained(
                    bw0,
                    bw0 / carq,
                    _tmp_1,
                    _tmp_2,
                    _tmp_3,
                    _tmp_4
                );
                nat_w = rcs[0] - hc;
                nat_h = rcs[1] - vc;
                if nat_w < 0.0 {
                    nat_w = 0.0;
                }
                if nat_h < 0.0 {
                    nat_h = 0.0;
                }
                fixed_h = true;
            } else {
                if (set_w.is_empty() && set_h.is_empty()) && (nat_w > 0.0 && nat_h > 0.0) {
                    let mut _tmp_1 = self.widthLimit(&s, "min-width");
                    let mut _tmp_2 = self.widthLimit(&s, "max-width");
                    let mut _tmp_3 = self.heightLimit(&s, "min-height");
                    let mut _tmp_4 = self.heightLimit(&s, "max-height");
                    let _tmp_5 = DomView::lessChrome(_tmp_1, hc);
                    let _tmp_6 = DomView::lessChrome(_tmp_2, hc);
                    let _tmp_7 = DomView::lessChrome(_tmp_3, vc);
                    let _tmp_8 = DomView::lessChrome(_tmp_4, vc);
                    let cs: Vec<f64> = DomView::constrained(
                        nat_w,
                        nat_h,
                        _tmp_5,
                        _tmp_6,
                        _tmp_7,
                        _tmp_8
                    );
                    let cw_1: f64 = cs[0];
                    let ch: f64 = cs[1];
                    if (cw_1 * nat_h - ch * nat_w) * (cw_1 * nat_h - ch * nat_w) > 0.0001 {
                        fixed_h = true;
                    }
                    nat_w = cw_1;
                    nat_h = ch;
                }
            }
            let area_w: bool = (pgd == "grid" || pgd == "inline-grid") && ((pjs == "stretch" || pas == "stretch") && (set_w.is_empty() && set_h.is_empty()));
            if ((s.borrow().getText("width").as_bytes().len() as i64) == 0 && !(area_w || (col_stretch || col_grow))) && !no_source {
                let mut ww: String = set_w.clone();
                if ww.is_empty() {
                    let mut hp: f64 = DomView::pxOf(&set_h);
                    // (the height its limits leave, the width following by
                    // the ratio, CSS 2 10.4; a zero height too)
                    let zero_h: bool = hp == 0.0 && (set_h == "0" || (set_h == "0px" || set_h == "0em"));
                    if hp > 0.0 || zero_h {
                        let mxh: String = s.borrow().getText("max-height");
                        if ((mxh.as_bytes().len() as i64) > 2 && mxh[((mxh.as_bytes().len() as i64) - 2) as usize..(mxh.as_bytes().len() as i64) as usize].to_string() == "px") && DomView::pxOf(&mxh) < hp {
                            hp = DomView::pxOf(&mxh);
                        }
                        let mnh: String = s.borrow().getText("min-height");
                        if ((mnh.as_bytes().len() as i64) > 2 && mnh[((mnh.as_bytes().len() as i64) - 2) as usize..(mnh.as_bytes().len() as i64) as usize].to_string() == "px") && DomView::pxOf(&mnh) > hp {
                            hp = DomView::pxOf(&mnh);
                        }
                    }
                    // (a border-box width takes the padding and border too)
                    ww = format!("{}px", (nat_w + hc).to_string());
                    if hp > 0.0 && nat_h > 0.0 {
                        ww = format!("{}px", (((hp - vc) * nat_w) / nat_h + hc).to_string());
                        // (an aspect-ratio without auto: the width by it, of
                        // the box box-sizing names; a picture fitted in by
                        // object-fit keeps its own, as object-position is
                        // not drawn)
                        let ofit: String = s.borrow().getText("object-fit");
                        if carq > 0.0 && (ofit.is_empty() || ofit == "fill") {
                            ww = format!("{}px", ((hp - vc) * carq + hc).to_string());
                            if s.borrow().getText("box-sizing") == "border-box" {
                                ww = format!("{}px", (hp * carq).to_string());
                            }
                        }
                    }
                }
                // (its width limits hold it, as they do its content
                // contribution, CSS 2 10.4)
                if ((ww.as_bytes().len() as i64) > 2 && ww[((ww.as_bytes().len() as i64) - 2) as usize..(ww.as_bytes().len() as i64) as usize].to_string() == "px") {
                    let mut wv: f64 = DomView::pxOf(&ww);
                    let mxw: String = s.borrow().getText("max-width");
                    if ((mxw.as_bytes().len() as i64) > 2 && mxw[((mxw.as_bytes().len() as i64) - 2) as usize..(mxw.as_bytes().len() as i64) as usize].to_string() == "px") && DomView::pxOf(&mxw) < wv {
                        wv = DomView::pxOf(&mxw);
                    }
                    let mnw: String = s.borrow().getText("min-width");
                    if ((mnw.as_bytes().len() as i64) > 2 && mnw[((mnw.as_bytes().len() as i64) - 2) as usize..(mnw.as_bytes().len() as i64) as usize].to_string() == "px") && DomView::pxOf(&mnw) > wv {
                        wv = DomView::pxOf(&mnw);
                    }
                    ww = format!("{}px", wv.to_string());
                }
                EVGElement::set_attribute(&e, "width", ww.clone());
                // (a flex row item's automatic minimum is its content size,
                // the picture's: it does not shrink below it, CSS Flexbox 4.5)
                let mpd: String = self.outerS.borrow().getText("display");
                let mdir: String = self.outerS.borrow().getText("flex-direction");
                let mmw: String = s.borrow().getText("min-width");
                if (mpd == "flex" || mpd == "inline-flex") && ((mdir == "row" || (mdir == "row-reverse" || mdir.is_empty())) && (mmw.is_empty() || mmw == "auto")) {
                    let mov: String = s.borrow().getText("overflow-x");
                    if mov.is_empty() || mov == "visible" {
                        EVGElement::set_attribute(&e, "min-width", ww.clone());
                    }
                }
            }
            // (a set px width its px limits move is the width they leave,
            // also in a track's contribution, CSS 2 10.4)
            {
                let lw: String = s.borrow().getText("width");
                if DomText::index_of(&lw, "px") > 0 {
                    let mut lv: f64 = DomView::pxOf(&lw);
                    let lmx: String = s.borrow().getText("max-width");
                    if DomText::index_of(&lmx, "px") > 0 && DomView::pxOf(&lmx) < lv {
                        lv = DomView::pxOf(&lmx);
                    }
                    let lmn: String = s.borrow().getText("min-width");
                    if DomText::index_of(&lmn, "px") > 0 && DomView::pxOf(&lmn) > lv {
                        lv = DomView::pxOf(&lmn);
                    }
                    if lv != DomView::pxOf(&lw) {
                        EVGElement::set_attribute(&e, "width", format!("{}px", lv.to_string()));
                    }
                }
            }
            // (a set px width: the minimum is the smaller of it and the
            // content size)
            let sw_1: String = s.borrow().getText("width");
            let swp: f64 = DomView::pxOf(&sw_1);
            if (swp > 0.0 && DomText::index_of(&sw_1, "px") > 0) && (nat_w > 0.0 && nat_h > 0.0) {
                let npd: String = self.outerS.borrow().getText("display");
                let ndir: String = self.outerS.borrow().getText("flex-direction");
                let nmw: String = s.borrow().getText("min-width");
                let nov: String = s.borrow().getText("overflow-x");
                if ((npd == "flex" || npd == "inline-flex") && ((ndir == "row" || (ndir == "row-reverse" || ndir.is_empty())) && (nmw.is_empty() || nmw == "auto"))) && (nov.is_empty() || nov == "visible") {
                    let mut csz: f64 = nat_w + hc;
                    let shp: f64 = DomView::pxOf(&set_h);
                    if shp > 0.0 {
                        csz = ((shp - vc) * nat_w) / nat_h + hc;
                    }
                    if csz > swp {
                        csz = swp;
                    }
                    EVGElement::set_attribute(&e, "min-width", format!("{}px", DomView::fmt(csz)));
                }
            }
            // (and down a column it stretches across: the height its
            // stretched width gives it by the ratio, when that is less)
            let shp2: f64 = DomView::pxOf(&set_h);
            let opw: String = self.outerS.borrow().getText("width");
            if ((col_stretch && shp2 > 0.0) && DomText::index_of(&set_h, "px") > 0) && ((nat_w > 0.0 && nat_h > 0.0) && DomText::index_of(&opw, "px") > 0) {
                let cmh2: String = s.borrow().getText("min-height");
                let cov2: String = s.borrow().getText("overflow-y");
                if (cmh2.is_empty() || cmh2 == "auto") && (cov2.is_empty() || cov2 == "visible") {
                    let mut lw2: f64 = ((DomView::pxOf(&opw) - DomView::pxOf(&s.borrow().getText("margin-left"))) - DomView::pxOf(&s.borrow().getText("margin-right"))) - hc;
                    if self.outerS.borrow().getText("box-sizing") == "border-box" {
                        lw2 = (((lw2 - DomView::pxOf(&self.outerS.borrow().getText("padding-left"))) - DomView::pxOf(&self.outerS.borrow().getText("padding-right"))) - DomView::side(&self.outerS, "left")) - DomView::side(&self.outerS, "right");
                    }
                    if lw2 > 0.0 {
                        let mut csz2: f64 = (lw2 * nat_h) / nat_w + vc;
                        if csz2 > shp2 {
                            csz2 = shp2;
                        }
                        EVGElement::set_attribute(&e, "min-height", format!("{}px", DomView::fmt(csz2)));
                    }
                }
            }
            // (down a column with a set px width: the automatic minimum is
            // the height that width gives by the ratio, or the set height
            // when that is less, CSS Flexbox 4.5)
            if ((swp > 0.0 && DomText::index_of(&sw_1, "px") > 0) && (nat_w > 0.0 && nat_h > 0.0)) && self.wm.is_empty() {
                let kpd: String = self.outerS.borrow().getText("display");
                let kdir: String = self.outerS.borrow().getText("flex-direction");
                let kmh: String = s.borrow().getText("min-height");
                let kov: String = s.borrow().getText("overflow-y");
                if ((kpd == "flex" || kpd == "inline-flex") && (kdir == "column" || kdir == "column-reverse")) && ((kmh.is_empty() || kmh == "auto") && (kov.is_empty() || kov == "visible")) {
                    let mut ksz: f64 = ((swp - hc) * nat_h) / nat_w + vc;
                    // (an aspect-ratio without auto is the ratio)
                    if carq > 0.0 {
                        ksz = (swp - hc) / carq + vc;
                    }
                    let ksh: f64 = DomView::pxOf(&set_h);
                    if DomText::index_of(&set_h, "px") > 0 && ksh < ksz {
                        ksz = ksh;
                    }
                    if ksz > 0.0 {
                        EVGElement::set_attribute(&e, "min-height", format!("{}px", DomView::fmt(ksz)));
                    }
                }
            }
            if (s.borrow().getText("height").as_bytes().len() as i64) == 0 {
                if !set_h.is_empty() {
                    EVGElement::set_attribute(&e, "height", set_h.clone());
                } else {
                    // the height follows the width, which a flex line or a
                    // percentage can still change
                    // (stretched across a column with a definite basis: the
                    // basis is the height, the width the line's, no ratio)
                    let col_basis: bool = col_stretch && DomView::pxOf(&s.borrow().getText("flex-basis")) > 0.0;
                    if ((nat_w > 0.0 && nat_h > 0.0) && !fixed_h) && !col_basis {
                        EVGElement::set_attribute(
                            &e,
                            "aspect-ratio",
                            format!("{} / {}", nat_w.to_string(), nat_h)
                        );
                    } else {
                        // (a stretched flex row item takes the line's height,
                        // its min/max limits still apply)
                        let hpd: String = self.outerS.borrow().getText("display");
                        let hdir: String = self.outerS.borrow().getText("flex-direction");
                        let mut has0: String = s.borrow().getText("align-self");
                        if has0.is_empty() || has0 == "auto" {
                            has0 = self.outerS.borrow().getText("align-items");
                        }
                        let row_stretch: bool = ((hpd == "flex" || hpd == "inline-flex") && (hdir == "row" || (hdir == "row-reverse" || hdir.is_empty()))) && (has0.is_empty() || (has0 == "normal" || has0 == "stretch"));
                        if !(row_stretch && self.wm.is_empty()) && !col_basis {
                            EVGElement::set_attribute(&e, "height", format!("{}px", (nat_h + vc).to_string()));
                        }
                    }
                }
            } else {
                // (a set height that grows down a column: the width follows)
                if col_grow && (nat_w > 0.0 && nat_h > 0.0) {
                    EVGElement::set_attribute(
                        &e,
                        "aspect-ratio",
                        format!("{} / {}", nat_w.to_string(), nat_h)
                    );
                }
            }
            // (aspect-ratio: auto <ratio> is the picture's own ratio when
            // it has one)
            let iar: String = s.borrow().getText("aspect-ratio");
            if (DomText::index_of(&iar, "auto") == 0 && (iar.as_bytes().len() as i64) > 4) && (nat_w > 0.0 && nat_h > 0.0) {
                EVGElement::set_attribute(&e, "aspect-ratio", format!("{} / {}", nat_w.to_string(), nat_h));
            }
            // (and a ratio without auto is the one it has)
            if !iar.is_empty() && DomText::index_of(&iar, "auto") < 0 {
                EVGElement::set_attribute(&e, "aspect-ratio", iar.clone());
            }
            // (a picture fills its content box unless object-fit says
            // otherwise, CSS Images 3 5.5: EVG's own default is cover)
            // (a turned box's picture is not stretched here: its sides are
            // swapped by the time it is drawn)
            if s.borrow().getText("object-fit").is_empty() && self.wm.is_empty() && (s.borrow().getText("writing-mode").is_empty() || s.borrow().getText("writing-mode") == "horizontal-tb") {
                EVGElement::set_attribute(&e, "object-fit", "fill".to_string());
            }
            e.borrow_mut().a11y_label = alt.clone();
            return e;
        }
        let flex_item: bool = self.inFlex;
        let no: i64 = self.listNo;
        let ps: String = s.borrow().getText("position");
        let anchors: bool = ps == "absolute" || (ps == "fixed" || (ps == "relative" || ps == "sticky"));
        // an absolute box is not clipped by the overflow of a box between it
        // and its containing block, nor a fixed one by any (CSS Overflow 3
        // 3, CSS 2.1 11.1.1): it is drawn outside them, and their scroll
        // does not move it
        let was_csc: i64 = self.clipSinceCb;
        let was_csf: i64 = self.clipSinceFx;
        if ps == "absolute" && self.clipSinceCb > 0 {
            EVGElement::set_attribute(&e, "escape-clip", format!("{}", self.clipSinceCb));
        }
        if ps == "fixed" && self.clipSinceFx > 0 {
            EVGElement::set_attribute(&e, "escape-clip", format!("{}", self.clipSinceFx));
        }
        // (its own clip is around the boxes it is the containing block of)
        let ovx: String = s.borrow().getText("overflow-x");
        let ovy: String = s.borrow().getText("overflow-y");
        if (!ovx.is_empty() && ovx != "visible") || (!ovy.is_empty() && ovy != "visible") {
            self.clipSinceCb += 1;
            self.clipSinceFx += 1;
        }
        if anchors {
            self.clipSinceCb = 0;
        }
        let tfv: String = s.borrow().getText("transform");
        if !tfv.is_empty() && tfv != "none" {
            self.clipSinceCb = 0;
            self.clipSinceFx = 0;
        }
        if anchors {
            self.positioned += 1;
            // (the containing block of the absolute boxes inside it)
            EVGElement::set_attribute(&e, "cb", "true".to_string());
            self.cbStyles.push(s.clone());
        }
        // (a sticky box keeps its px insets from its scrollport's edges)
        if ps == "sticky" {
            let __v_sti: Vec<String> = vec!["top".to_string(), "left".to_string(), "bottom".to_string(), "right".to_string()];
            let __n_sti = __v_sti.len() as i64;
            for sti in 0..__n_sti {
                let stn = __v_sti[sti as usize].clone();
                let stv: String = s.borrow().getText(&stn);
                if DomText::index_of(&stv, "px") > 0 {
                    EVGElement::set_attribute(&e, &format!("sticky-{}", stn), DomView::fmt(DomView::pxOf(&stv)));
                }
                // (a percentage of the scrollport's size, CSS Position 3.4)
                let mut stb: f64 = self.spW;
                if stn == "top" || stn == "bottom" {
                    stb = self.spH;
                }
                if (stv.as_bytes().len() as i64) > 1 && stv.ends_with("%") && DomText::index_of(&stv, "(") < 0 && stb >= 0.0 {
                    let stq: Option<f64> = stv[0..((stv.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                    if stq.is_some() {
                        EVGElement::set_attribute(&e, &format!("sticky-{}", stn), DomView::fmt(stb * stq.unwrap() / 100.0));
                    }
                }
            }
        }
        let was_cols: Vec<f64> = self.colW.clone();
        let was_at: i64 = self.cellAt;
        if display == "table" || display == "inline-table" {
            // (a grid of its cells, tableGrid: no shares for flex rows)
            if DomView::gridTable(n) {
                self.colW = Vec::new();
                EVGElement::set_attribute(&e, "display", "grid".to_string());
            } else {
                self.colW = self.tableCols(n);
            }
            // a table with no width is as wide as its content
            let tw: String = s.borrow().getText("width");
            if !self.inFlex && (tw.is_empty() || tw == "auto") {
                EVGElement::set_attribute(&e, "width", "fit-content".to_string());
            }
            // (a table's width in px holds the border spacing, which is
            // its padding here)
            if DomView::pxOf(&tw) > 0.0 && (DomView::gridTable(n) && s.borrow().getText("box-sizing") != "border-box") {
                let bsp: Vec<String> = s.borrow().getText("border-spacing").split(" ").map(|x| x.to_string()).collect::<Vec<String>>();
                let mut bsh: f64 = 0.0;
                if !bsp.is_empty() {
                    bsh = DomView::pxOf(&bsp[0].clone());
                }
                let mut inner: f64 = DomView::pxOf(&tw) - 2.0 * bsh;
                if inner < 0.0 {
                    inner = 0.0;
                }
                EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt(inner)));
            }
        }
        if display == "table-row" {
            self.cellAt = 0;
        }
        if display == "table-cell" && !self.colW.is_empty() {
            self.cell(&e, n, &s);
        }
        // a cell's content is placed in it by vertical-align (CSS 2 17.5.3)
        if display == "table-cell" && self.wm != "vertical-lr" && self.wm != "vertical-rl" {
            let cva: String = s.borrow().getText("vertical-align");
            if cva == "middle" {
                EVGElement::set_attribute(&e, "justify-content", "center".to_string());
            }
            if cva == "bottom" {
                EVGElement::set_attribute(&e, "justify-content", "flex-end".to_string());
            }
            // (baseline: the cells of a row on their first baselines; a
            // cell that paints nothing of its own moves as a whole)
            let cbg: bool = !s.borrow().getText("background-color").is_empty() && s.borrow().getText("background-color") != "transparent" && s.borrow().getText("background-color") != "rgba(0, 0, 0, 0)";
            let cbi: bool = !s.borrow().getText("background-image").is_empty() && s.borrow().getText("background-image") != "none";
            let cbd: bool = DomView::side(&s, "top") > 0.0 || DomView::side(&s, "bottom") > 0.0 || DomView::side(&s, "left") > 0.0 || DomView::side(&s, "right") > 0.0;
            // (a td or th with content: an anonymous cell or an empty one
            // keeps filling its row, which its percentage heights need)
            let ct: String = n.borrow().getText("t");
            let c_has: bool = n.borrow().get("c").borrow().items.len() > 0;
            if (cva.is_empty() || cva == "baseline") && !cbg && !cbi && !cbd && (ct == "td" || ct == "th") && c_has {
                EVGElement::set_attribute(&e, "align-self", "baseline".to_string());
            }
        }
        let jb_from: i64 = self.jbItems.len() as i64;
        // (the line-under side of vertical-lr with sideways text is the
        // left, the block start: an item's synthesized baseline is there)
        if self.wm == "vertical-lr" && inh.borrow().getText("text-orientation") == "sideways" {
            EVGElement::set_attribute(&e, "baseline-synth-top", "true".to_string());
        }
        let was_def_h: f64 = self.defH;
        let indef_item: bool = self.indefColumnItem(&s, was_def_h);
        self.defH = self.definiteH(&s, was_def_h);
        let was_sp_w: f64 = self.spW;
        let was_sp_h: f64 = self.spH;
        let spo: String = s.borrow().getText("overflow");
        let spox: String = s.borrow().getText("overflow-x");
        let spoy: String = s.borrow().getText("overflow-y");
        let sp_any: String = format!(" {} {} {} ", spo, spox, spoy);
        if DomText::index_of(&sp_any, " auto ") >= 0 || DomText::index_of(&sp_any, " scroll ") >= 0 || DomText::index_of(&sp_any, " hidden ") >= 0 {
            self.spW = -1.0;
            self.spH = -1.0;
            let spwv: String = s.borrow().getText("width");
            let sphv: String = s.borrow().getText("height");
            let spbb: bool = s.borrow().getText("box-sizing") == "border-box";
            if spwv.ends_with("px") {
                let mut w0: f64 = DomView::pxOf(&spwv);
                if spbb {
                    w0 = w0 - DomView::side(&s.clone(), "left") - DomView::side(&s.clone(), "right");
                } else {
                    w0 = w0 + DomView::pxOf(&s.borrow().getText("padding-left")) + DomView::pxOf(&s.borrow().getText("padding-right"));
                }
                self.spW = w0;
            }
            if sphv.ends_with("px") {
                let mut h0: f64 = DomView::pxOf(&sphv);
                if spbb {
                    h0 = h0 - DomView::side(&s.clone(), "top") - DomView::side(&s.clone(), "bottom");
                } else {
                    h0 = h0 + DomView::pxOf(&s.borrow().getText("padding-top")) + DomView::pxOf(&s.borrow().getText("padding-bottom"));
                }
                self.spH = h0;
            }
        }
        // (a flex or grid item, a positioned box, a cell or a height not
        // in px can be definite without definiteH knowing its size)
        let was_maybe: bool = self.defHMaybe;
        let mpos: String = s.borrow().getText("position");
        let mh: String = s.borrow().getText("height");
        self.defHMaybe = ((self.inFlex || (mpos == "absolute" || mpos == "fixed")) || (display == "table-cell" || display == "table")) || !mh.is_empty() && mh != "auto";
        if indef_item {
            self.defHMaybe = false;
        }
        // a positioned box paints over its in-flow siblings (CSS 2.1
        // Appendix E), whatever their order in the tree
        let ppos: String = s.borrow().getText("position");
        // (one with a negative z-index stays in tree order, under them)
        let pz: String = s.borrow().getText("z-index");
        let mut late_self: bool = false;
        if (ppos == "absolute" || (ppos == "fixed" || (ppos == "relative" || ppos == "sticky"))) && !pz.starts_with("-") {
            EVGElement::set_attribute(&e, "paint-late", "true".to_string());
            self.lateCount += 1;
            late_self = true;
        }
        // an atomic inline (inline-block, inline-table) is inline content:
        // painted after the block backgrounds of its stacking context
        // (CSS 2.1 Appendix E, step 7)
        let afl: String = s.borrow().getText("float");
        if (display == "inline-block" || display == "inline-table") && (ppos.is_empty() || ppos == "static") && (afl.is_empty() || afl == "none") && !self.inFlex {
            EVGElement::set_attribute(&e, "inline-atomic", "true".to_string());
        }
        let late_from: i64 = self.lateCount;
        // (a grid item's z-index orders its painting even when it is not
        // positioned, CSS Grid 9.5)
        let gzv: String = s.borrow().getText("z-index");
        let gpd: String = self.outerS.borrow().getText("display");
        if !band {
            self.children(&e, n, inh.clone(), &display);
            if display == "grid" || display == "inline-grid" {
                DomView::gridOrder(&e);
                DomView::zOrder(&e);
            }
            // (a flex item's order is the order its container lays out and
            // paints them, Flexbox 5.4)
            if display == "flex" || display == "inline-flex" {
                DomView::gridOrder(&e);
            }
        }
        // (marked after its own children, which may set its class)
        if (gpd == "grid" || gpd == "inline-grid") && (!gzv.is_empty() && gzv != "auto") {
            if gzv.parse::<i64>().ok().is_some() {
                let rhs_15 = format!("{} mfd-z{}", e.borrow().class_name, gzv);
                e.borrow_mut().class_name = rhs_15;
            }
        }
        // (a grid item's order puts it in the order its grid places and
        // paints them, CSS Grid 9.5 and Flexbox 5.4)
        let gov: String = s.borrow().getText("order");
        // (not a positioned box out of the flow: no flex item, its order
        // has no effect, Flexbox 4.1)
        let gop: String = s.borrow().getText("position");
        let gout: bool = (gpd == "flex" || gpd == "inline-flex") && (gop == "absolute" || gop == "fixed");
        if (gpd == "grid" || (gpd == "inline-grid" || (gpd == "flex" || gpd == "inline-flex"))) && (!gov.is_empty() && (gov != "0" && !gout)) {
            if gov.parse::<i64>().ok().is_some() {
                let rhs_16 = format!("{} mfd-o{}", e.borrow().class_name, gov);
                e.borrow_mut().class_name = rhs_16;
            }
        }
        // a box with positioned boxes inside is painted with them, after
        // its in-flow siblings: they are painted in tree order over the
        // in-flow boxes around them, which EVG paints parent by parent
        // (not out of a negative z-index box: a stacking context under
        // its siblings with what is inside it)
        let neg_z: bool = (ppos == "absolute" || (ppos == "fixed" || (ppos == "relative" || ppos == "sticky"))) && pz.starts_with("-");
        if self.lateCount > late_from && !late_self && !neg_z {
            EVGElement::set_attribute(&e, "paint-late", "true".to_string());
        }
        self.defH = was_def_h;
        self.defHMaybe = was_maybe;
        self.spW = was_sp_w;
        self.spH = was_sp_h;
        if display == "grid" || display == "inline-grid" {
            self.gridJustifyBaselines(jb_from);
        }
        if display == "table" || display == "inline-table" {
            self.colW = was_cols.clone();
        }
        if display == "table-row" {
            self.cellAt = was_at;
        }
        self.clipSinceCb = was_csc;
        self.clipSinceFx = was_csf;
        if anchors {
            self.positioned -= 1;
            self.cbStyles.remove(((self.cbStyles.len() as i64) - 1) as usize);
        }
        if t == "fieldset" {
            self.legendBand(&e, n, &s);
            // (a flex fieldset's anonymous content box has no min-height of
            // its own: with no height set it is as tall as its content, so
            // the main axis of a column has no free space to place in)
            let fsh: String = s.borrow().getText("height");
            let fsd: String = s.borrow().getText("flex-direction");
            if ((display == "flex" || display == "inline-flex") && (fsd == "column" || fsd == "column-reverse")) && (fsh.is_empty() || fsh == "auto") {
                EVGElement::set_attribute(&e, "justify-content", "flex-start".to_string());
            }
        }
        if inh.borrow().getText("direction") == "rtl" {
            // EVG mirrors a right-to-left grid or block (a block's narrower
            // children sit on the right); flex rows and lines are reversed
            // here, so EVG is not to mirror them again
            let fd0: String = s.borrow().getText("flex-direction");
            let flex_row: bool = (display == "flex" || display == "inline-flex") && (fd0.is_empty() || (fd0 == "row" || fd0 == "row-reverse"));
            if flex_row {
                EVGElement::set_attribute(&e, "direction", "ltr".to_string());
            } else {
                EVGElement::set_attribute(&e, "direction", "rtl".to_string());
            }
        } else {
            // (a left-to-right box inside a right-to-left one)
            if inh.borrow().getText("direction") == "ltr" {
                EVGElement::set_attribute(&e, "direction", "ltr".to_string());
            }
        }
        // (an inline-block's baseline is its last line's; one that clips
        // has its bottom margin edge, as EVG has a box without text)
        let ibo: String = s.borrow().getText("overflow-y");
        if display == "inline-block" && (ibo.is_empty() || ibo == "visible") {
            EVGElement::set_attribute(&e, "baseline-last", "true".to_string());
        }
        // (a flex container's baseline is its first item's)
        if display == "flex" || display == "inline-flex" {
            EVGElement::set_attribute(&e, "flex-box", "true".to_string());
            let bfd: String = s.borrow().getText("flex-direction");
            if (bfd == "column" || bfd == "column-reverse") && inh.borrow().getText("direction") != "rtl" {
                self.columnBaselines(&e, &s);
            }
        }
        // EVG has no reversed flex directions: the children in the other
        // order, packed from the other end, are the same boxes
        let mut fdir_1: String = s.borrow().getText("flex-direction");
        // (start and end follow the writing direction: they turn with a
        // right to left row, not with a reversed flex direction)
        let mut wm_rev: bool = false;
        // right to left, a row starts at the right: a row is laid out as a
        // reversed one, and a reversed one as a row
        // (a row that wraps is mirrored by EVG instead: reversed, its items
        // would fall on other lines)
        let fwr: String = s.borrow().getText("flex-wrap");
        let rtl_wrap: bool = ((display == "flex" || display == "inline-flex") && (fwr == "wrap" || fwr == "wrap-reverse")) && (fdir_1.is_empty() || fdir_1 == "row");
        if inh.borrow().getText("direction") == "rtl" && rtl_wrap {
            EVGElement::set_attribute(&e, "direction", "rtl".to_string());
            let __it_rch = e.borrow().children.clone();
            for rch in __it_rch.iter().cloned() {
                if rch.borrow().text_dir.is_empty() {
                    EVGElement::set_attribute(&rch, "direction", "ltr".to_string());
                }
            }
        }
        if inh.borrow().getText("direction") == "rtl" && !rtl_wrap {
            if fdir_1.is_empty() || fdir_1 == "row" {
                fdir_1 = "row-reverse".to_string();
                wm_rev = true;
            } else {
                if fdir_1 == "row-reverse" {
                    fdir_1 = "row".to_string();
                }
            }
        }
        // (one that wraps is laid out forward and reflected along its main
        // axis by EVG: reversing the children would put them on other lines)
        // (with one item or none in flow the lines are the same either way)
        let mut mm_flow: i64 = 0;
        let __it_mm = e.borrow().children.clone();
        for mch in __it_mm.iter().cloned() {
            if !EVGElement::has_absolute_position(&mch) {
                mm_flow += 1;
            }
        }
        let main_mirror: bool = ((display == "flex" || display == "inline-flex") && (fdir_1 == "row-reverse" || fdir_1 == "column-reverse")) && ((fwr == "wrap" || fwr == "wrap-reverse") && (self.wm.is_empty() && mm_flow > 1));
        if main_mirror {
            if fdir_1 == "row-reverse" {
                EVGElement::set_attribute(&e, "flex-direction", "row".to_string());
                EVGElement::set_attribute(&e, "main-mirror", "x".to_string());
            } else {
                EVGElement::set_attribute(&e, "flex-direction", "column".to_string());
                EVGElement::set_attribute(&e, "main-mirror", "y".to_string());
            }
        }
        if ((display == "flex" || display == "inline-flex") && (fdir_1 == "row-reverse" || fdir_1 == "column-reverse")) && !main_mirror {
            let mut rev: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
            let mut ri: i64 = (e.borrow().children.len() as i64) - 1;
            while ri >= 0 {
                rev.push(Rc::clone(&e.borrow().children[ri as usize]));
                ri -= 1;
            }
            e.borrow_mut().children = rev.clone();
            if fdir_1 == "row-reverse" {
                EVGElement::set_attribute(&e, "flex-direction", "row".to_string());
            } else {
                EVGElement::set_attribute(&e, "flex-direction", "column".to_string());
            }
            let jc: String = s.borrow().getText("justify-content");
            // (an auto-height column is as tall as its items: packed from
            // either end they are in the same place)
            let hv: String = s.borrow().getText("height");
            let mh_2: String = s.borrow().getText("min-height");
            let sized: bool = fdir_1 == "row-reverse" || (!hv.is_empty() && hv != "auto" || !mh_2.is_empty() && (mh_2 != "auto" && mh_2 != "0px"));
            // (space-between with one item, and stretch, pack at the start)
            let mut in_flow: i64 = 0;
            let __it_ch = e.borrow().children.clone();
            for ch_1 in __it_ch.iter().cloned() {
                if !EVGElement::has_absolute_position(&ch_1) {
                    in_flow += 1;
                }
            }
            let mut start_like: bool = jc.is_empty() || (jc == "normal" || (jc == "flex-start" || (jc == "stretch" || jc == "space-between" && in_flow <= 1)));
            if jc == "start" && wm_rev {
                start_like = true;
            }
            if sized && start_like {
                EVGElement::set_attribute(&e, "justify-content", "flex-end".to_string());
            }
            if jc == "flex-end" || jc == "end" && wm_rev {
                EVGElement::set_attribute(&e, "justify-content", "flex-start".to_string());
            }
        }
        // (a row's start, end, left and right are sides of the page, not
        // of its flex direction: EVG's row runs left to right, its items
        // in their order on the page)
        let pfd: String = s.borrow().getText("flex-direction");
        if ((display == "flex" || display == "inline-flex") && (self.wm.is_empty() && !rtl_wrap)) && (pfd.is_empty() || (pfd == "row" || pfd == "row-reverse")) {
            let pjc: String = s.borrow().getText("justify-content");
            if pjc == "start" || (pjc == "end" || (pjc == "left" || pjc == "right")) {
                let prtl: bool = inh.borrow().getText("direction") == "rtl";
                let mut pright: bool = pjc == "right" || (pjc == "end" && !prtl || pjc == "start" && prtl);
                if main_mirror && fdir_1 == "row-reverse" {
                    pright = !pright;
                }
                if pright {
                    EVGElement::set_attribute(&e, "justify-content", "flex-end".to_string());
                } else {
                    EVGElement::set_attribute(&e, "justify-content", "flex-start".to_string());
                }
            }
        }
        if display == "block" || display == "list-item" {
            self.collapseThrough(&e, &s, flex_item);
        }
        if display == "list-item" {
            self.marker(&e, &inh, no);
        }
        self.outlineBox(&e, &s, &inh, &display);
        e
    }
    /// an outline (CSS UI 4, 5.1): a box of its own around the border box,
    /// outline-offset out from it, painted over the content; it takes no
    /// room (not an inline's, whose outline follows its line boxes)
    fn outlineBox(&self, e: &Rc<RefCell<EVGElement>>, s: &Rc<RefCell<JsonValue>>, inh: &Rc<RefCell<JsonValue>>, display: &str) {
        let ost: String = s.borrow().getText("outline-style");
        if !(ost == "solid" || ost == "dotted" || ost == "dashed") {
            return;
        }
        if display.is_empty() || display == "inline" || display == "contents" || (display.starts_with("table-") && display != "table-cell" && display != "table-caption") {
            return;
        }
        let ow: f64 = DomView::pxOf(&s.borrow().getText("outline-width"));
        if ow <= 0.0 {
            return;
        }
        let off: f64 = DomView::pxOf(&s.borrow().getText("outline-offset"));
        let mut oc: String = s.borrow().getText("outline-color");
        if oc.is_empty() || oc == "currentcolor" {
            oc = DomView::or(&s.borrow().getText("color"), &inh.borrow().getText("color"));
        }
        if oc.is_empty() {
            oc = "rgb(0, 0, 0)".to_string();
        }
        let o: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        EVGElement::set_attribute(&o, "position", "absolute".to_string());
        EVGElement::set_attribute(&o, "box-sizing", "border-box".to_string());
        // (EVG's insets are of the content box, a grid's of its padding
        // box: out over the padding and the border too)
        let pad_in: f64 = if display == "grid" || display == "inline-grid" { 0.0 } else { 1.0 };
        let out_t: f64 = ((ow + off) + DomView::pxOf(&s.borrow().getText("border-top-width"))) + pad_in * self.relOff(s, "padding-top", false);
        let out_r: f64 = ((ow + off) + DomView::pxOf(&s.borrow().getText("border-right-width"))) + pad_in * self.relOff(s, "padding-right", false);
        let out_b: f64 = ((ow + off) + DomView::pxOf(&s.borrow().getText("border-bottom-width"))) + pad_in * self.relOff(s, "padding-bottom", false);
        let out_l: f64 = ((ow + off) + DomView::pxOf(&s.borrow().getText("border-left-width"))) + pad_in * self.relOff(s, "padding-left", false);
        EVGElement::set_attribute(&o, "top", format!("{}px", DomView::fmt(0.0 - out_t)));
        EVGElement::set_attribute(&o, "right", format!("{}px", DomView::fmt(0.0 - out_r)));
        EVGElement::set_attribute(&o, "bottom", format!("{}px", DomView::fmt(0.0 - out_b)));
        EVGElement::set_attribute(&o, "left", format!("{}px", DomView::fmt(0.0 - out_l)));
        let wv: String = format!("{}px", DomView::fmt(ow));
        if ost == "solid" {
            EVGElement::set_attribute(&o, "border-width", wv.clone());
            EVGElement::set_attribute(&o, "border-color", oc.clone());
        } else {
            EVGElement::set_attribute(&o, "padding-top", wv.clone());
            EVGElement::set_attribute(&o, "padding-right", wv.clone());
            EVGElement::set_attribute(&o, "padding-bottom", wv.clone());
            EVGElement::set_attribute(&o, "padding-left", wv.clone());
            let w4: String = DomView::fmt(ow);
            EVGElement::set_attribute(&o, "side-borders", format!("{} {} {} {}|{}|{}|{}|{}|{} {} {} {}", w4, w4, w4, w4, oc, oc, oc, oc, ost, ost, ost, ost));
        }
        EVGElement::set_attribute(&o, "paint-late", "true".to_string());
        EVGElement::add_child(e, Rc::clone(&o));
    }
    /// --- tables ---------------------------------------------------------------
    ///
    /// A table is a column of rows, a row a flex row of its cells. The
    /// columns line up because each cell grows by its columns' shares of the
    /// row, which are the same in every row: a column's share is the length
    /// of its longest text (up to 60 characters) and a few more, as a table
    /// with automatic layout gives the wider content the more room.
    /// a table as a grid (CSS 2.1 17.5): its rows' cells are its items, at
    /// the grid lines their rows and the cells before them (rowspan,
    /// colspan) give them. A row or row group is an item too, a band across
    /// all the columns under its cells (its background, its height). The
    /// columns are as wide as their content in a table with no width, and
    /// share a table's width by their content's length otherwise.
    /// Captions are rows of their own over or under the cells
    fn tableGrid(&mut self, e: &Rc<RefCell<EVGElement>>, n: &Rc<RefCell<JsonValue>>, inh: &Rc<RefCell<JsonValue>>) {
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let items: Vec<Rc<RefCell<JsonValue>>> = kids.borrow().items.clone();
        let mut occ: Vec<String> = Vec::new();
        let mut r: i64 = 1;
        let mut ncols: i64 = 1;
        // (a caption is outside the table box, so outside its
        // border-spacing and padding, which the table here has as padding:
        // its margins take them back, CSS 2.1 17.4 and 17.6.1)
        let ts0: Rc<RefCell<JsonValue>> = n.borrow().get("s");
        let no_border: bool = (DomView::side(&ts0, "left") + DomView::side(&ts0, "right") + DomView::side(&ts0, "top") + DomView::side(&ts0, "bottom")) == 0.0;
        if no_border && ts0.borrow().getText("border-collapse") != "collapse" {
            let bsp: Vec<String> = ts0.borrow().getText("border-spacing").trim().to_string().split(" ").map(|x| x.to_string()).collect::<Vec<String>>();
            let mut bs_h: f64 = 0.0;
            let mut bs_v: f64 = 0.0;
            if !bsp.is_empty() {
                bs_h = DomView::pxOf(&bsp[0].clone());
                bs_v = bs_h;
            }
            if (bsp.len() as i64) > 1 {
                bs_v = DomView::pxOf(&bsp[1].clone());
            }
            let ph_l: f64 = bs_h + DomView::pxOf(&ts0.borrow().getText("padding-left"));
            let ph_r: f64 = bs_h + DomView::pxOf(&ts0.borrow().getText("padding-right"));
            let pv_t: f64 = bs_v + DomView::pxOf(&ts0.borrow().getText("padding-top"));
            let pv_b: f64 = bs_v + DomView::pxOf(&ts0.borrow().getText("padding-bottom"));
            for c in items.iter().cloned() {
                if DomView::displayOf(&c) == "table-caption" {
                    let cs: Rc<RefCell<JsonValue>> = c.borrow().get("s");
                    let done: bool = cs.borrow().getText("-mfd-cap-out") == "1";
                    let ml: String = cs.borrow().getText("margin-left");
                    let mr: String = cs.borrow().getText("margin-right");
                    let px_m: bool = (ml.is_empty() || ml.ends_with("px")) && (mr.is_empty() || mr.ends_with("px"));
                    if !done && px_m && (ph_l + ph_r + pv_t + pv_b) > 0.0 {
                        self.putPage(&cs, "-mfd-cap-out", "1");
                        self.putPage(&cs, "margin-left", &format!("{}px", DomView::fmt(DomView::pxOf(&ml) - ph_l)));
                        self.putPage(&cs, "margin-right", &format!("{}px", DomView::fmt(DomView::pxOf(&mr) - ph_r)));
                        if cs.borrow().getText("caption-side") == "bottom" {
                            self.putPage(&cs, "margin-bottom", &format!("{}px", DomView::fmt(DomView::pxOf(&cs.borrow().getText("margin-bottom")) - pv_b)));
                        } else {
                            self.putPage(&cs, "margin-top", &format!("{}px", DomView::fmt(DomView::pxOf(&cs.borrow().getText("margin-top")) - pv_t)));
                        }
                    }
                }
            }
        }
        // the captions over the table
        for c in items.iter().cloned() {
            if DomView::displayOf(&c) == "table-caption" && c.borrow().get("s").borrow().getText("caption-side") != "bottom" {
                self.tableItem(&c, inh, format!("{} / span 1", r), "1 / -1".to_string());
                r += 1;
            }
        }
        // (a captioned table's background is of the table box, not of its
        // captions, CSS 2.1 17.4: a band under the rows carries it)
        let ts: Rc<RefCell<JsonValue>> = n.borrow().get("s");
        let tbg: String = ts.borrow().getText("background-color");
        let mut has_cap: bool = false;
        for c in items.iter().cloned() {
            if DomView::displayOf(&c) == "table-caption" {
                has_cap = true;
            }
        }
        let mut tband: i64 = -1;
        let first_body: i64 = r;
        if has_cap && (!tbg.is_empty() && (tbg != "transparent" && tbg != "rgba(0, 0, 0, 0)")) {
            let bare: bool = (DomView::pxOf(&ts.borrow().getText("padding-top")) + DomView::pxOf(&ts.borrow().getText("padding-bottom")) + DomView::pxOf(&ts.borrow().getText("padding-left")) + DomView::pxOf(&ts.borrow().getText("padding-right"))) == 0.0 && (DomView::side(&ts, "left") + DomView::side(&ts, "right") + DomView::side(&ts, "top") + DomView::side(&ts, "bottom")) == 0.0;
            if bare && (ts.borrow().getText("background-image").is_empty() || ts.borrow().getText("background-image") == "none") {
                let bn: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
                let bs: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
                bs.borrow_mut().putStr("display", "block");
                bs.borrow_mut().putStr("background-color", &tbg);
                bn.borrow_mut().putStr("t", "div");
                bn.borrow_mut().put("s", bs);
                bn.borrow_mut().put("c", JsonValue::mkArr());
                tband = self.fNodes.len() as i64;
                self.tableItem(&bn, inh, String::new(), "1 / -1".to_string());
            }
        }
        // (a column's or column group's background image is placed in the
        // column's box, all the rows' height, under the rows and cells,
        // CSS 2.1 17.5.1: a band per column, its rows set once known)
        let mut cbands: Vec<i64> = Vec::new();
        let mut cat: i64 = 1;
        for c in items.iter().cloned() {
            let d: String = DomView::displayOf(&c);
            if d == "table-column" {
                let sp: i64 = DomView::spanOf(&c);
                self.colBand(&c, inh, cat, sp, &mut cbands);
                cat += sp;
            }
            if d == "table-column-group" {
                let g0: i64 = cat;
                let mut inner: i64 = 0;
                let gk: Rc<RefCell<JsonValue>> = c.borrow().get("c");
                let __it_g = gk.borrow().items.clone();
                for g in __it_g.iter().cloned() {
                    if DomView::displayOf(&g) == "table-column" {
                        cat += DomView::spanOf(&g);
                        inner += 1;
                    }
                }
                if inner == 0 {
                    cat += DomView::spanOf(&c);
                }
                self.colBand(&c, inh, g0, cat - g0, &mut cbands);
                cat = g0;
                for g in __it_g.iter().cloned() {
                    if DomView::displayOf(&g) == "table-column" {
                        let gsp: i64 = DomView::spanOf(&g);
                        self.colBand(&g, inh, cat, gsp, &mut cbands);
                        cat += gsp;
                    }
                }
                if inner == 0 {
                    cat += DomView::spanOf(&c);
                }
            }
        }
        for c in items.iter().cloned() {
            let d: String = DomView::displayOf(&c);
            let cp: String = c.borrow().get("s").borrow().getText("position");
            if d == "table-row-group" || (d == "table-header-group" || d == "table-footer-group") {
                let rows: Vec<Rc<RefCell<JsonValue>>> = DomView::rowsOf(&c);
                if rows.is_empty() {
                    continue;
                }
                if DomView::bandShows(&c) {
                    self.tableItem(&c, inh, format!("{} / span {}", r, rows.len() as i64), "1 / -1".to_string());
                }
                // (its rows inherit from it)
                let ginh: Rc<RefCell<JsonValue>> = self.inherit(inh, &c.borrow().get("s"));
                for row in rows.iter().cloned() {
                    ncols = DomView::maxI(ncols, self.tableRow(&row, &ginh, r, &mut occ));
                    r += 1;
                }
                continue;
            }
            if d == "table-row" {
                ncols = DomView::maxI(ncols, self.tableRow(&c, inh, r, &mut occ));
                r += 1;
                continue;
            }
            if d == "table-caption" || (d == "table-column" || (d == "table-column-group" || d == "none")) {
                continue;
            }
            if self.isText(&c) {
                continue;
            }
            if cp == "absolute" || cp == "fixed" {
                self.tableItem(&c, inh, "auto".to_string(), "auto".to_string());
                continue;
            }
            // (anything else: a row of its own across the columns)
            self.tableItem(&c, inh, format!("{} / span 1", r), "1 / -1".to_string());
            r += 1;
        }
        if tband >= 0 {
            if r > first_body {
                self.fRow[tband as usize] = format!("{} / span {}", first_body, r - first_body);
                EVGElement::set_attribute(&e, "background-color", "rgba(0, 0, 0, 0)".to_string());
            } else {
                self.fRow[tband as usize] = "auto".to_string();
            }
        }
        for bi in cbands.iter().cloned() {
            if r > first_body {
                self.fRow[bi as usize] = format!("{} / span {}", first_body, r - first_body);
            } else {
                self.fRow[bi as usize] = "auto".to_string();
            }
        }
        let body_end: i64 = r;
        for c in items.iter().cloned() {
            if DomView::displayOf(&c) == "table-caption" && c.borrow().get("s").borrow().getText("caption-side") == "bottom" {
                self.tableItem(&c, inh, format!("{} / span 1", r), "1 / -1".to_string());
                r += 1;
            }
        }
        // (a table's height is its grid's: its captions are on top, CSS 2.1
        // 17.4, when their heights are known)
        let th0: String = ts.borrow().getText("height");
        if has_cap && th0.ends_with("px") {
            let mut cap_h: f64 = 0.0;
            let mut known: bool = true;
            for c in items.iter().cloned() {
                if DomView::displayOf(&c) == "table-caption" {
                    let cs: Rc<RefCell<JsonValue>> = c.borrow().get("s");
                    let ch: String = cs.borrow().getText("height");
                    if !ch.ends_with("px") {
                        known = false;
                    }
                    cap_h += (((DomView::pxOf(&ch) + DomView::pxOf(&cs.borrow().getText("margin-top"))) + DomView::pxOf(&cs.borrow().getText("margin-bottom"))) + DomView::side(&cs, "top")) + DomView::side(&cs, "bottom");
                    if cs.borrow().getText("box-sizing") != "border-box" {
                        cap_h += DomView::pxOf(&cs.borrow().getText("padding-top")) + DomView::pxOf(&cs.borrow().getText("padding-bottom"));
                    }
                }
            }
            if known && cap_h > 0.0 {
                EVGElement::set_attribute(&e, "height", format!("{}px", DomView::fmt(DomView::pxOf(&th0) + cap_h)));
            }
        }
        // (a caption is as tall as it is: a taller table's height goes to
        // its rows, CSS 2.1 17.4)
        if has_cap && body_end > first_body {
            let mut rtpl: String = String::new();
            let mut ri: i64 = 1;
            while ri < r {
                if ri > 1 {
                    rtpl = format!("{} ", rtpl);
                }
                if ri < first_body || ri >= body_end {
                    rtpl = format!("{}min-content", rtpl);
                } else {
                    rtpl = format!("{}auto", rtpl);
                }
                ri += 1;
            }
            EVGElement::set_attribute(&e, "grid-template-rows", rtpl.clone());
        }
        // the columns
        let s: Rc<RefCell<JsonValue>> = n.borrow().get("s");
        let tw: String = s.borrow().getText("width");
        let shares: Vec<f64> = self.tableCols(n);
        let fixed: bool = s.borrow().getText("table-layout") == "fixed" && !(tw.is_empty() || tw == "auto");
        let mut avail: f64 = DomView::pxOf(&tw);
        // (within its max-width and min-width)
        let tmx: String = s.borrow().getText("max-width");
        if (avail > 0.0 && tmx.ends_with("px")) && DomView::pxOf(&tmx) < avail {
            avail = DomView::pxOf(&tmx);
        }
        let tmn: String = s.borrow().getText("min-width");
        if (avail > 0.0 && tmn.ends_with("px")) && DomView::pxOf(&tmn) > avail {
            avail = DomView::pxOf(&tmn);
        }
        if avail > 0.0 {
            avail = (avail - (DomView::pxOf(&s.borrow().getText("padding-left")) + DomView::pxOf(&s.borrow().getText("padding-right")))) - (DomView::side(&s, "left") + DomView::side(&s, "right"));
            // (and less the spacing around the columns: a percentage
            // column is of what is left, CSS 2.1 17.5.2.1)
            if s.borrow().getText("border-collapse") != "collapse" {
                let bsp0: String = s.borrow().getText("border-spacing");
                let bsx: Vec<String> = bsp0.split(" ").map(|s| s.to_string()).collect::<Vec<String>>();
                if !bsx.is_empty() {
                    avail = avail - DomView::pxOf(&bsx[0].clone()) * ((ncols + 1) as f64);
                }
            }
        }
        let widths: Vec<String> = DomView::colWidths(n, ncols, fixed, avail);
        let mut tpl: String = String::new();
        let mut ci: i64 = 0;
        while ci < ncols {
            if ci > 0 {
                tpl = format!("{} ", tpl);
            }
            let cw: String = widths[ci as usize].clone();
            if fixed {
                // (CSS 2.1 17.5.2.1: the first row's widths, the rest of
                // the table's width shared evenly)
                if cw.is_empty() {
                    tpl = format!("{}minmax(0px, 1fr)", tpl);
                } else {
                    tpl = format!("{}{}", tpl, cw);
                }
            } else if DomView::pxOf(&tw) <= 0.0 {
                // (no width, or a percentage: the content's widths, the
                // free room shared out by the grid)
                if cw.is_empty() {
                    tpl = format!("{}auto", tpl);
                } else {
                    tpl = format!("{}minmax({}, auto)", tpl, cw);
                }
            } else {
                let mut sh: f64 = 4.0;
                if ci < (shares.len() as i64) {
                    sh = shares[ci as usize];
                }
                if cw.is_empty() {
                    tpl = format!("{}{}fr", tpl, DomView::fmt(sh));
                } else {
                    tpl = format!("{}minmax({}, {}fr)", tpl, cw, DomView::fmt(sh));
                }
            }
            ci += 1;
        }
        EVGElement::set_attribute(&e, "grid-template-columns", tpl.clone());
        // (a fixed table's columns are as wide as the first row says: a cell
        // of a narrower column gives up its padding, 17.5.2.1)
        if fixed && avail > 0.0 {
            self.fixedPads(&widths, avail);
            // (no narrower than its columns, 17.5.2.1)
            let mut sum: f64 = 0.0;
            for w in widths.iter().cloned() {
                if w.ends_with("px") {
                    sum += DomView::pxOf(&w);
                }
            }
            if sum > avail + 0.01 {
                let grow: f64 = sum - avail;
                let mut tw2: f64 = DomView::pxOf(&tw);
                let tmx2: String = s.borrow().getText("max-width");
                if tmx2.ends_with("px") && DomView::pxOf(&tmx2) < tw2 {
                    tw2 = DomView::pxOf(&tmx2);
                }
                // (the spacing round the columns is the box's padding here,
                // outside a content-box width)
                let mut tsp: f64 = 0.0;
                if s.borrow().getText("box-sizing") != "border-box" && s.borrow().getText("border-collapse") != "collapse" {
                    let tbs: Vec<String> = s.borrow().getText("border-spacing").split(" ").map(|x| x.to_string()).collect::<Vec<String>>();
                    if !tbs.is_empty() {
                        tsp = DomView::pxOf(&tbs[0].clone()) * 2.0;
                    }
                }
                EVGElement::set_attribute(&e, "width", format!("{}px", DomView::fmt((tw2 + grow) - tsp)));
                EVGElement::set_attribute(&e, "max-width", "none".to_string());
            }
        }
        // (a band or caption spans the columns by their count: a line counted
        // from the end makes EVG read the template again for each item)
        let mut fi: i64 = 0;
        while fi < (self.fCol.len() as i64) {
            if self.fCol[fi as usize] == "1 / -1" {
                self.fCol[fi as usize] = format!("1 / span {}", ncols);
            }
            fi += 1;
        }
        // (rows share a table's height, columns its width)
        EVGElement::set_attribute(&e, "align-content", "stretch".to_string());
        EVGElement::set_attribute(&e, "justify-content", "stretch".to_string());
    }
    /// whether a table is laid out as a grid: not when a row or row group
    /// is positioned (it moves its cells and holds their absolute boxes,
    /// which a band does not)
    pub fn gridTable(n: &Rc<RefCell<JsonValue>>) -> bool {
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_c = kids.borrow().items.clone();
        for c in __it_c.iter().cloned() {
            // (text or a box that is not a table part: CSS wraps it in an
            // anonymous cell, which the grid does not make)
            if c.borrow().has("x") {
                if (DomView::trimmed(&DomView::collapse(&c.borrow().getText("x"))).as_bytes().len() as i64) > 0 {
                    return false;
                }
                continue;
            }
            let d: String = DomView::displayOf(&c);
            let cp: String = c.borrow().get("s").borrow().getText("position");
            if !d.starts_with("table-") && (d != "none" && (cp != "absolute" && cp != "fixed")) {
                return false;
            }
            // (a positioned or floated table part is a block box)
            let cf: String = c.borrow().get("s").borrow().getText("float");
            if d.starts_with("table-") && ((cp == "absolute" || cp == "fixed") || (!cf.is_empty() && cf != "none")) {
                return false;
            }
            if d == "table-row" || (d == "table-row-group" || (d == "table-header-group" || d == "table-footer-group")) {
                let p: String = c.borrow().get("s").borrow().getText("position");
                if !p.is_empty() && p != "static" {
                    return false;
                }
                if d != "table-row" && !DomView::gridTable(&c) {
                    return false;
                }
                if d == "table-row" && DomView::loseText(&c) {
                    return false;
                }
            }
        }
        true
    }
    /// whether a row has text of its own (not in a cell)
    pub fn loseText(n: &Rc<RefCell<JsonValue>>) -> bool {
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_c = kids.borrow().items.clone();
        for c in __it_c.iter().cloned() {
            if c.borrow().has("x") && (DomView::trimmed(&DomView::collapse(&c.borrow().getText("x"))).as_bytes().len() as i64) > 0 {
                return true;
            }
        }
        false
    }
    /// whether a row's or row group's band is drawn or sized: a background,
    /// a border or a height (an empty band would give the table its
    /// baseline)
    pub fn bandShows(n: &Rc<RefCell<JsonValue>>) -> bool {
        let s: Rc<RefCell<JsonValue>> = n.borrow().get("s");
        let bg: String = s.borrow().getText("background-color");
        if !bg.is_empty() && (bg != "transparent" && bg != "rgba(0, 0, 0, 0)") {
            return true;
        }
        let bi: String = s.borrow().getText("background-image");
        if !bi.is_empty() && bi != "none" {
            return true;
        }
        let h: String = s.borrow().getText("height");
        if !h.is_empty() && h != "auto" {
            return true;
        }
        let __v_si: Vec<String> = vec!["top".to_string(), "right".to_string(), "bottom".to_string(), "left".to_string()];
        let __n_si = __v_si.len() as i64;
        for si in 0..__n_si {
            let sn = __v_si[si as usize].clone();
            let bs: String = s.borrow().getText(&format!("border-{}-style", sn));
            if !bs.is_empty() && (bs != "none" && bs != "hidden") {
                return true;
            }
        }
        false
    }
    /// the widths the cells of span 1 set on their columns, as track sizes
    /// ("" for none): a px width with the cell's padding and border, or a
    /// percentage; in a fixed table only the first row's
    pub fn colWidths(n: &Rc<RefCell<JsonValue>>, ncols: i64, fixed: bool, avail: f64) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut px: Vec<f64> = Vec::new();
        while (out.len() as i64) < ncols {
            out.push(String::new());
            px.push(0.0);
        }
        // the columns' own widths first (table-column, or a column group
        // with no columns in it)
        let mut at: i64 = 0;
        let tk: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_t = tk.borrow().items.clone();
        for c in __it_t.iter().cloned() {
            let d: String = DomView::displayOf(&c);
            if d == "table-column" && at < ncols {
                out[at as usize] = DomView::colPx(&c, avail);
                at += DomView::spanOf(&c);
            }
            if d == "table-column-group" {
                let mut inner: i64 = 0;
                let gk: Rc<RefCell<JsonValue>> = c.borrow().get("c");
                let __it_g = gk.borrow().items.clone();
                for g in __it_g.iter().cloned() {
                    if DomView::displayOf(&g) == "table-column" {
                        if at < ncols {
                            out[at as usize] = DomView::colPx(&g, avail);
                        }
                        at += DomView::spanOf(&g);
                        inner += 1;
                    }
                }
                if inner == 0 {
                    if at < ncols {
                        out[at as usize] = DomView::colPx(&c, avail);
                    }
                    at += DomView::spanOf(&c);
                }
            }
        }
        let mut ci: i64 = 0;
        while ci < ncols {
            if DomView::pxOf(&out[ci as usize]) > 0.0 {
                px[ci as usize] = DomView::pxOf(&out[ci as usize]);
            }
            ci += 1;
        }
        let rows: Vec<Rc<RefCell<JsonValue>>> = DomView::rowsOf(n);
        let mut ri: i64 = 0;
        for r in rows.iter().cloned() {
            if fixed && ri > 0 {
                break;
            }
            ri += 1;
            let mut col: i64 = 0;
            let kids: Rc<RefCell<JsonValue>> = r.borrow().get("c");
            let __it_c = kids.borrow().items.clone();
            for c in __it_c.iter().cloned() {
                if DomView::displayOf(&c) != "table-cell" {
                    continue;
                }
                let span: i64 = DomView::spanOf(&c);
                if span == 1 && col < ncols {
                    let cs: Rc<RefCell<JsonValue>> = c.borrow().get("s");
                    let w: String = cs.borrow().getText("width");
                    let mut extra: f64 = 0.0;
                    if cs.borrow().getText("box-sizing") != "border-box" {
                        extra = ((DomView::pxOf(&cs.borrow().getText("padding-left")) + DomView::pxOf(&cs.borrow().getText("padding-right"))) + DomView::side(&cs, "left")) + DomView::side(&cs, "right");
                    }
                    let mut pct: Option<f64> = None;
                    if (w.as_bytes().len() as i64) > 1 && w.ends_with("%") {
                        pct = w[(0) as usize..((w.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
                    }
                    if (w.ends_with("%") && avail > 0.0) && pct.is_some() {
                        // (a percentage of a table in px: px, with the
                        // cell's padding and border)
                        if out[col as usize].is_empty() {
                            out[col as usize] = format!("{}px", DomView::fmt((avail * pct.unwrap()) / 100.0 + extra));
                        }
                    } else if w.ends_with("%") {
                        if out[col as usize].is_empty() {
                            out[col as usize] = w.clone();
                        }
                    } else if DomView::pxOf(&w) > 0.0 {
                        let ow: f64 = DomView::pxOf(&w) + extra;
                        if ow > px[col as usize] && !out[col as usize].ends_with("%") {
                            px[col as usize] = ow;
                            out[col as usize] = format!("{}px", DomView::fmt(ow));
                        }
                    }
                }
                col += span;
            }
        }
        out
    }
    /// in a fixed table, a cell of one column whose padding and borders
    /// are wider than the column keeps only what fits of its padding
    fn fixedPads(&mut self, widths: &Vec<String>, avail: f64) {
        let mut used: f64 = 0.0;
        let mut empty: i64 = 0;
        for w in widths.iter().cloned() {
            if w.is_empty() {
                empty += 1;
            } else if w.ends_with("px") {
                used += DomView::pxOf(&w);
            } else {
                return;
            }
        }
        let mut share: f64 = 0.0;
        if empty > 0 && avail > used {
            share = (avail - used) / (empty as f64);
        }
        let nn: i64 = self.fNodes.len() as i64;
        for k in 0..nn {
            let c: Rc<RefCell<JsonValue>> = self.fNodes[k as usize].clone();
            if DomView::displayOf(&c) != "table-cell" {
                continue;
            }
            let fc: String = self.fCol[k as usize].clone();
            if !fc.ends_with(" / span 1") {
                continue;
            }
            let ci: Option<i64> = fc[(0) as usize..((fc.as_bytes().len() as i64) - 9) as usize].to_string().parse::<i64>().ok();
            if ci.is_none() || ci.unwrap() < 1 || ci.unwrap() > (widths.len() as i64) {
                continue;
            }
            let cw: String = widths[(ci.unwrap() - 1) as usize].clone();
            let mut colw: f64 = share;
            if !cw.is_empty() {
                colw = DomView::pxOf(&cw);
            }
            let cs: Rc<RefCell<JsonValue>> = c.borrow().get("s");
            let pl: f64 = DomView::pxOf(&cs.borrow().getText("padding-left"));
            let pr: f64 = DomView::pxOf(&cs.borrow().getText("padding-right"));
            let bw: f64 = DomView::side(&cs, "left") + DomView::side(&cs, "right");
            if pl + pr > 0.0 && (pl + pr) + bw > colw + 0.01 {
                let mut room: f64 = colw - bw;
                if room < 0.0 {
                    room = 0.0;
                }
                self.putPage(&cs, "padding-left", &format!("{}px", DomView::fmt((pl * room) / (pl + pr))));
                self.putPage(&cs, "padding-right", &format!("{}px", DomView::fmt((pr * room) / (pl + pr))));
            }
        }
    }
    /// a column's width as a track size, "" for none
    pub fn colPx(c: &Rc<RefCell<JsonValue>>, avail: f64) -> String {
        let w: String = c.borrow().get("s").borrow().getText("width");
        let mw: f64 = DomView::pxOf(&c.borrow().get("s").borrow().getText("min-width"));
        if DomView::pxOf(&w) > 0.0 || mw > 0.0 {
            let mut v: f64 = DomView::pxOf(&w);
            if mw > v {
                v = mw;
            }
            return format!("{}px", DomView::fmt(v));
        }
        if (w.as_bytes().len() as i64) > 1 && (w.ends_with("%") && avail > 0.0) {
            let p: Option<f64> = w[(0) as usize..((w.as_bytes().len() as i64) - 1) as usize].to_string().parse::<f64>().ok();
            if p.is_some() {
                return format!("{}px", DomView::fmt((avail * p.unwrap()) / 100.0));
            }
        }
        String::new()
    }
    fn maxI(a: i64, b: i64) -> i64 {
        if a > b {
            return a;
        }
        b
    }
    /// an item of a table's grid at these lines
    fn copyStyle(from: &Rc<RefCell<JsonValue>>, to: &Rc<RefCell<JsonValue>>, k: &str) {
        let v: String = from.borrow().getText(k);
        if !v.is_empty() {
            to.borrow_mut().putStr(k, &v);
        }
    }
    /// a band for a column (or group) `c` with a background image, at
    /// columns `at` to `at + span`; its index in `bands`
    fn colBand(&mut self, c: &Rc<RefCell<JsonValue>>, inh: &Rc<RefCell<JsonValue>>, at: i64, span: i64, bands: &mut Vec<i64>) {
        let cs: Rc<RefCell<JsonValue>> = c.borrow().get("s");
        let img: String = cs.borrow().getText("background-image");
        if img.is_empty() || img == "none" || span < 1 {
            return;
        }
        let bn: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        let bs: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        bs.borrow_mut().putStr("display", "block");
        bs.borrow_mut().putStr("background-image", &img);
        DomView::copyStyle(&cs, &bs, "background-position");
        DomView::copyStyle(&cs, &bs, "background-repeat");
        DomView::copyStyle(&cs, &bs, "background-size");
        DomView::copyStyle(&cs, &bs, "background-origin");
        DomView::copyStyle(&cs, &bs, "background-clip");
        bn.borrow_mut().putStr("t", "div");
        bn.borrow_mut().put("s", bs);
        bn.borrow_mut().put("c", JsonValue::mkArr());
        bands.push(self.fNodes.len() as i64);
        self.tableItem(&bn, inh, String::new(), format!("{} / span {}", at, span));
    }
    fn tableItem(&mut self, c: &Rc<RefCell<JsonValue>>, inh: &Rc<RefCell<JsonValue>>, row: String, col: String) {
        self.fNodes.push(c.clone());
        self.fInh.push(inh.clone());
        self.fIds.push(String::new().to_string());
        self.fRow.push(row);
        self.fCol.push(col);
    }
    /// a row's band and its cells, each at the first column no cell of a
    /// row above spans into; the columns the row reaches
    fn tableRow(&mut self, row: &Rc<RefCell<JsonValue>>, inh: &Rc<RefCell<JsonValue>>, r: i64, occ: &mut Vec<String>) -> i64 {
        if DomView::bandShows(row) {
            self.tableItem(row, inh, format!("{} / span 1", r), "1 / -1".to_string());
        }
        let mut col: i64 = 1;
        let mut last: i64 = 1;
        // (its cells inherit from it)
        let rinh: Rc<RefCell<JsonValue>> = self.inherit(inh, &row.borrow().get("s"));
        let kids: Rc<RefCell<JsonValue>> = row.borrow().get("c");
        let __it_c = kids.borrow().items.clone();
        for c in __it_c.iter().cloned() {
            // (a box that is not a table part is in a cell of its own,
            // CSS 2.1 17.2.1; misplaced table parts are left out)
            let cd: String = DomView::displayOf(&c);
            let cpos: String = c.borrow().get("s").borrow().getText("position");
            if self.isText(&c) || cd == "none" {
                continue;
            }
            if cpos == "absolute" || cpos == "fixed" {
                self.tableItem(&c, &rinh, "auto".to_string(), "auto".to_string());
                continue;
            }
            if cd != "table-cell" && cd.starts_with("table-") {
                continue;
            }
            while DomView::occHas(occ, r, col) {
                col += 1;
            }
            let cs: i64 = DomView::spanOf(&c);
            let rs: i64 = DomView::rowSpanOf(&c);
            // (only the rows under this one need to know: a cell of one
            // row leaves no mark, which keeps a long table's list short)
            let mut rr: i64 = r + 1;
            while rr < r + rs {
                let mut cc: i64 = col;
                while cc < col + cs {
                    occ.push(format!("{}:{}", rr, cc));
                    cc += 1;
                }
                rr += 1;
            }
            self.tableItem(&c, &rinh, format!("{} / span {}", r, rs), format!("{} / span {}", col, cs));
            col += cs;
            if col - 1 > last {
                last = col - 1;
            }
        }
        // (cells of rows above that span into this one count too)
        let mut cc: i64 = col;
        while DomView::occHas(occ, r, cc) {
            last = cc;
            cc += 1;
        }
        last
    }
    fn occHas(occ: &Vec<String>, r: i64, c: i64) -> bool {
        let k: String = format!("{}:{}", r, c);
        for o in occ.iter().cloned() {
            if o == k {
                return true;
            }
        }
        false
    }
    pub fn rowSpanOf(c: &Rc<RefCell<JsonValue>>) -> i64 {
        let v: Option<i64> = c.borrow().get("a").borrow().getText("rowspan").parse::<i64>().ok();
        if v.is_none() {
            return 1;
        }
        if v.unwrap() < 1 {
            return 1;
        }
        v.unwrap()
    }
    /// the shares of a table's columns
    pub fn tableCols(&self, table: &Rc<RefCell<JsonValue>>) -> Vec<f64> {
        let mut w: Vec<f64> = Vec::new();
        let rows: Vec<Rc<RefCell<JsonValue>>> = DomView::rowsOf(table);
        for r in rows.iter().cloned() {
            let mut col: i64 = 0;
            let kids: Rc<RefCell<JsonValue>> = r.borrow().get("c");
            let __it_c = kids.borrow().items.clone();
            for c in __it_c.iter().cloned() {
                if DomView::displayOf(&c) != "table-cell" {
                    continue;
                }
                let span: i64 = DomView::spanOf(&c);
                while (w.len() as i64) < col + span {
                    w.push(4.0);
                }
                if span == 1 {
                    let _tmp_2 = DomView::collapse(&self.textOf(&c));
                    let mut __len: f64 = ((DomView::trimmed(&_tmp_2).as_bytes().len() as i64)) as f64;
                    if __len > 60.0 {
                        __len = 60.0;
                    }
                    if __len + 4.0 > w[col as usize] {
                        w[col as usize] = __len + 4.0;
                    }
                }
                col += span;
            }
        }
        w
    }
    /// a cell: its columns' share of the row (unless it has a width)
    fn cell(&mut self, e: &Rc<RefCell<EVGElement>>, n: &Rc<RefCell<JsonValue>>, s: &Rc<RefCell<JsonValue>>) {
        let span: i64 = DomView::spanOf(n);
        let mut share: f64 = 0.0;
        let mut k: i64 = self.cellAt;
        while k < self.cellAt + span && k < (self.colW.len() as i64) {
            share += self.colW[k as usize];
            k += 1;
        }
        self.cellAt += span;
        if (s.borrow().getText("width").as_bytes().len() as i64) > 0 || share <= 0.0 {
            return;
        }
        EVGElement::set_attribute(&e, "flex-grow", DomView::fmt(share));
        EVGElement::set_attribute(&e, "flex-shrink", "1".to_string());
        EVGElement::set_attribute(&e, "flex-basis", "0px".to_string());
        EVGElement::set_attribute(&e, "min-width", "0px".to_string());
    }
    /// a fieldset's legend, its first legend child, is in its top border,
    /// across the border's middle; the content starts under the taller of
    /// the two. The legend goes first, in a band as tall as the border, and
    /// the top border's room is the band's (its line is not drawn)
    fn legendBand(&self, e: &Rc<RefCell<EVGElement>>, n: &Rc<RefCell<JsonValue>>, s: &Rc<RefCell<JsonValue>>) {
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let mut lid: String = String::new();
        let __it_k = kids.borrow().items.clone();
        for k in __it_k.iter().cloned() {
            if lid.is_empty() && k.borrow().getText("t") == "legend" {
                lid = format!("{}{}", self.pfx, k.borrow().getText("i"));
            }
        }
        if lid.is_empty() {
            return;
        }
        let mut at: i64 = 0 - 1;
        let __n_ci = e.borrow().children.len() as i64;
        for ci in 0..__n_ci {
            let ch = Rc::clone(&e.borrow().children[ci as usize]);
            if ch.borrow().id == lid && !EVGElement::has_absolute_position(&ch) {
                at = ci;
            }
        }
        if at < 0 {
            return;
        }
        let bt: f64 = DomView::side(s, "top");
        let br: f64 = DomView::side(s, "right");
        let bb: f64 = DomView::side(s, "bottom");
        let bl: f64 = DomView::side(s, "left");
        let pt: f64 = DomView::pxOf(&s.borrow().getText("padding-top"));
        EVGElement::set_attribute(&e, "border-width", "0px".to_string());
        EVGElement::set_attribute(&e, "padding-top", format!("{}px", DomView::fmt(pt)));
        EVGElement::set_attribute(&e, "padding-right", format!("{}px", DomView::fmt(DomView::pxOf(&s.borrow().getText("padding-right")) + br)));
        EVGElement::set_attribute(&e, "padding-bottom", format!("{}px", DomView::fmt(DomView::pxOf(&s.borrow().getText("padding-bottom")) + bb)));
        EVGElement::set_attribute(&e, "padding-left", format!("{}px", DomView::fmt(DomView::pxOf(&s.borrow().getText("padding-left")) + bl)));
        EVGElement::set_attribute(&e, "skip-first-baseline", "true".to_string());
        let lg: Rc<RefCell<EVGElement>> = Rc::clone(&e.borrow().children[at as usize]);
        let band: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        EVGElement::set_attribute(&band, "display", "flex".to_string());
        EVGElement::set_attribute(&band, "flex-direction", "row".to_string());
        EVGElement::set_attribute(&band, "align-items", "center".to_string());
        EVGElement::set_attribute(&band, "min-height", format!("{}px", DomView::fmt(bt)));
        EVGElement::set_attribute(&band, "margin-top", format!("{}px", DomView::fmt(0.0 - pt)));
        EVGElement::set_attribute(&band, "margin-bottom", format!("{}px", DomView::fmt(pt)));
        EVGElement::add_child(&band, Rc::clone(&lg));
        let mut rest: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        rest.push(Rc::clone(&band));
        let __n_cj = e.borrow().children.len() as i64;
        for cj in 0..__n_cj {
            let ch2 = Rc::clone(&e.borrow().children[cj as usize]);
            if cj != at {
                rest.push(Rc::clone(&ch2));
            }
        }
        e.borrow_mut().children = rest.clone();
    }
    /// a list item's marker, outside its box at the first line, where
    /// Chromium draws it: a disc a third of the font size across, its right
    /// edge a space and 8px before the item; a number ends there
    fn marker(&self, e: &Rc<RefCell<EVGElement>>, inh: &Rc<RefCell<JsonValue>>, no: i64) {
        let r#type: String = inh.borrow().getText("list-style-type");
        // (inside, web/dom made it the first box of the first line)
        if r#type == "none" || inh.borrow().getText("list-style-position") == "inside" {
            return;
        }
        let mut fs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
        if fs == 0.0 && inh.borrow().getText("font-size") != "0px" {
            fs = 16.0;
        }
        let lh: f64 = DomView::lineHeight(inh);
        let gap: f64 = fs * 0.26 + 8.0;
        let color: String = DomView::or(&inh.borrow().getText("color"), "rgb(0, 0, 0)");
        if r#type == "decimal" || (r#type == "lower-alpha" || (r#type == "upper-alpha" || (r#type == "lower-roman" || r#type == "upper-roman"))) {
            let num: Rc<RefCell<EVGElement>> = self.textEl(format!("{}.", no.to_string()),
                inh,
                String::new()
            );
            EVGElement::set_attribute(&num, "position", "absolute".to_string());
            EVGElement::set_attribute(&num, "top", "0px".to_string());
            EVGElement::set_attribute(
                &num,
                "left",
                format!("{}px", DomView::fmt(0.0 - (fs * 3.0 + fs * 0.26)))
            );
            EVGElement::set_attribute(&num, "width", format!("{}px", DomView::fmt(fs * 3.0)));
            EVGElement::set_attribute(&num, "text-align", "right".to_string());
            EVGElement::add_child(&e, Rc::clone(&num));
            return;
        }
        let d: f64 = fs / 3.0;
        let m: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        EVGElement::set_attribute(&m, "position", "absolute".to_string());
        EVGElement::set_attribute(&m, "left", format!("{}px", DomView::fmt(0.0 - (gap + d))));
        EVGElement::set_attribute(
            &m,
            "top",
            format!("{}px", DomView::fmt((lh / 2.0 + 0.5) - d / 2.0))
        );
        EVGElement::set_attribute(&m, "width", format!("{}px", DomView::fmt(d)));
        EVGElement::set_attribute(&m, "height", format!("{}px", DomView::fmt(d)));
        if r#type == "square" {
            EVGElement::set_attribute(&m, "background-color", color.clone());
        } else {
            EVGElement::set_attribute(&m, "border-radius", format!("{}px", DomView::fmt(d / 2.0)));
            if r#type == "circle" {
                EVGElement::set_attribute(&m, "border-width", "1px".to_string());
                EVGElement::set_attribute(&m, "border-color", color.clone());
            } else {
                EVGElement::set_attribute(&m, "background-color", color.clone());
            }
        }
        EVGElement::add_child(&e, Rc::clone(&m));
    }
    /// the children: runs of text become text elements; in a block, a line
    /// with inline boxes in it becomes a wrapping row
    fn children(&mut self, e: &Rc<RefCell<EVGElement>>, n: &Rc<RefCell<JsonValue>>, inh: Rc<RefCell<JsonValue>>, display: &str) {
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let flex: bool = display == "flex" || (display == "inline-flex" || (display == "grid" || (display == "inline-grid" || (display == "table-row" || ((display == "table" || display == "inline-table") && DomView::gridTable(n))))));
        let keep: bool = self.pre(&inh);
        // the current line of a block: text and inline boxes, whether there
        // is white space before each, and whether there is some after the
        // last
        let mut line: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut line_sp: Vec<bool> = Vec::new();
        // the rows of floats in this block, their side, and whether a box
        // after them clears them
        let mut f_rows: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut f_sides: Vec<String> = Vec::new();
        let mut f_cleared: Vec<bool> = Vec::new();
        // the outer widths of the last float row's left and right floats
        // (-1 when one is not in px)
        let mut row_left_w: f64 = 0.0;
        let mut row_right_w: f64 = 0.0;
        // (a float that does not fit beside the earlier ones goes under
        // them, and so do the ones after it: the first line's widths stay)
        let mut row_full: bool = false;
        let mut row_cw: f64 = DomView::pxOf(&n.borrow().get("s").borrow().getText("width"));
        // (the content box's, also with box-sizing: border-box)
        {
            let rcs: Rc<RefCell<JsonValue>> = n.borrow().get("s");
            if row_cw > 0.0 && rcs.borrow().getText("box-sizing") == "border-box" {
                row_cw -= ((DomView::pxOf(&rcs.borrow().getText("padding-left")) + DomView::pxOf(&rcs.borrow().getText("padding-right"))) + DomView::side(&rcs, "left")) + DomView::side(&rcs, "right");
            }
        }
        let mut last_float: i64 = 0 - 1;
        let mut pend: bool = false;
        let mut line_text: bool = false;
        let mut run: String = String::new();
        let mut runId: String = String::new();
        let mut items: i64 = 0;
        // the children, an inline element that is only a wrapper (no box of
        // its own) opened up: what is in it is on the block's lines, as in
        // CSS, and not one box in them
        let flat0: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
        let flat_inh0: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
        let flat_id0: Vec<String> = Vec::new();
        self.fNodes = flat0.clone();
        self.fInh = flat_inh0.clone();
        self.fIds = flat_id0.clone();
        let tbl: bool = (display == "table" || display == "inline-table") && DomView::gridTable(n);
        self.fRow = Vec::new();
        self.fCol = Vec::new();
        let __it_c0 = kids.borrow().items.clone();
        if tbl {
            self.tableGrid(e, n, &inh);
        }
        for c0 in __it_c0.iter().cloned() {
            if tbl {
                continue;
            }
            if flex {
                self.fNodes.push(c0.clone());
                self.fInh.push(inh.clone());
                self.fIds.push(String::new().to_string());
            } else {
                self.flatten(c0.clone(), inh.clone(), "");
            }
        }
        // (the lists of this block: a block inside starts its own)
        let mut flat: Vec<Rc<RefCell<JsonValue>>> = self.fNodes.clone();
        let mut flat_inh: Vec<Rc<RefCell<JsonValue>>> = self.fInh.clone();
        let mut flat_id: Vec<String> = self.fIds.clone();
        // (a float in a line that cannot break, after some of its text,
        // goes after the end of that run: the line is not split by it)
        if !flex && !tbl {
            let ord: Vec<i64> = self.nowrapFloats(&flat, &flat_inh);
            let mut moved: bool = false;
            let __n_oi = ord.len() as i64;
            for oi in 0..__n_oi {
                if ord[oi as usize] != oi {
                    moved = true;
                }
            }
            if moved {
                let mut of: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
                let mut oh: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
                let mut od: Vec<String> = Vec::new();
                for oj in 0..__n_oi {
                    of.push(flat[ord[oj as usize] as usize].clone());
                    oh.push(flat_inh[ord[oj as usize] as usize].clone());
                    od.push(flat_id[ord[oj as usize] as usize].clone());
                }
                flat = of.clone();
                flat_inh = oh.clone();
                flat_id = od.clone();
            }
        }
        let flat_row: Vec<String> = self.fRow.clone();
        let flat_col: Vec<String> = self.fCol.clone();
        let mut k: i64 = 0;
        let count: i64 = flat.len() as i64;
        // what the children's elements are built under, for keeping them
        // (DomMemo): this element's style and its containing block's
        let mon: bool = self.svgs.borrow().memo.borrow().on;
        let mut msig: String = String::new();
        // (the page's style objects by their stamps: a patch shares a node's
        // style with the last page while it is the same)
        let mut inh_sigs: HashMap<String,String> = HashMap::new();
        if mon {
            msig = format!("{}|{}|{}", self.pfx, self.stampOf(&n.borrow().get("s")), (self.cbStyles.len() as i64).to_string());
            if !self.cbStyles.is_empty() {
                msig = format!("{}|{}", msig, self.stampOf(&self.cbStyles[self.cbStyles.len() - 1]));
            }
        }
        while k <= count {
            let end: bool = k == count;
            let mut kid: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
            let mut iinh: Rc<RefCell<JsonValue>> = inh.clone();
            let mut iid: String = String::new();
            if !end {
                kid = flat[k as usize].clone();
                iinh = flat_inh[k as usize].clone();
                iid = flat_id[k as usize].clone();
            }
            let mut text: bool = false;
            if !end {
                text = self.isText(&kid);
            }
            if text {
                if runId.is_empty() {
                    runId = format!("{}{}", self.pfx, kid.borrow().getText("i"));
                    self.segs.clear();
                }
                run = format!("{}{}", run, self.textOf(&kid));
                if iid.is_empty() {
                    iid = format!("{}{}", self.pfx, kid.borrow().getText("i"));
                }
                self.segments(&kid, iinh.clone(), iid.clone());
            }
            if !text && !runId.is_empty() {
                let mut rt: String = run.clone();
                if !keep {
                    rt = DomView::collapse(&run);
                }
                // a run on a line with inline boxes (before it, or the
                // one that ends it) flows around them a word at a time
                let mut box_after: bool = false;
                if !end && !flex {
                    let kd: String = DomView::displayOf(&kid);
                    let kp: String = kid.borrow().get("s").borrow().getText("position");
                    box_after = (kd == "inline" || (kd == "inline-block" || (kd == "inline-flex" || (kd == "inline-grid" || kd == "inline-table")))) && (kp != "absolute" && kp != "fixed");
                }
                // (a line that does not wrap is one text element still)
                let nowrap: bool = inh.borrow().getText("white-space") == "nowrap";
                // (word-spacing: the words apart, each space the wider)
                let wsp: bool = DomView::pxOf(&inh.borrow().getText("word-spacing")) != 0.0;
                // (and a run with a part that does not wrap, which keeps
                // its words together, in a block whose lines do)
                let mut part_nw: bool = false;
                for sgn in self.segs.iter().cloned() {
                    if sgn.borrow().inh.borrow().getText("white-space") == "nowrap" {
                        part_nw = true;
                    }
                }
                // (not in a block of no width, whose lines EVG does not
                // break as a row's: one text element breaks there)
                if n.borrow().get("s").borrow().getText("width") == "0px" {
                    part_nw = false;
                }
                let flows: bool = !flex && (!keep && (!nowrap && (((!line.is_empty() || box_after) || wsp) || part_nw)));
                // (white space alone is text in pre, but not in a flex box)
                let has: bool = (DomView::trimmed(&rt).as_bytes().len() as i64) > 0 || (keep && (!flex && !rt.is_empty()));
                if !rt.is_empty() && DomView::white((rt.as_bytes()[0 as usize] as i64)) {
                    pend = true;
                }
                if flows && has {
                    let fws: Vec<Rc<RefCell<EVGElement>>> = self.words(false);
                    let __n_fi = fws.len() as i64;
                    for fi in 0..__n_fi {
                        let fw = Rc::clone(&fws[fi as usize]);
                        if fi > 0 {
                            pend = true;
                        }
                        line.push(Rc::clone(&fw));
                        line_sp.push(pend);
                        pend = false;
                    }
                    line_text = true;
                }
                if !flows && has {
                    if !keep && self.rich(&inh) {
                        // pieces that look different (a coloured word, a
                        // bold one): a text element per word
                        let wrap: Rc<RefCell<EVGElement>> = DomView::lineRow(&inh);
                        // (a line of its own when it is alone in one)
                        wrap.borrow_mut().class_name = "mfd-words".to_string();

                        EVGElement::set_attribute(&wrap, "align-items", "flex-end".to_string());
                        // (pieces of other line-heights: on their baselines)
                        if self.lhMixed(&inh) {
                            EVGElement::set_attribute(&wrap, "align-items", "baseline".to_string());
                        }
                        let _tmp_1 = DomView::spaceWidth(&inh);
                        EVGElement::set_attribute(
                            &wrap,
                            "column-gap",
                            format!("{}px", DomView::fmt(_tmp_1))
                        );
                        // (right to left, the ending punctuation of a run
                        // of left-to-right words is on its left)
                        let wws: Vec<Rc<RefCell<EVGElement>>> = self.words(inh.borrow().getText("direction") == "rtl");
                        let __n_wi = wws.len() as i64;
                        for wi in 0..__n_wi {
                            let w = Rc::clone(&wws[wi as usize]);
                            EVGElement::add_child(&wrap, Rc::clone(&w));
                        }
                        if flex {
                            EVGElement::add_child(&e, Rc::clone(&wrap));
                        } else {
                            line.push(Rc::clone(&wrap));
                            line_sp.push(pend);
                            line_text = true;
                        }
                    } else {
                        // the run ends: one text element
                        if flex {
                            // (preserved spaces stay in the item's text)
                            let mut ft: String = DomView::trimmed(&rt);
                            if keep {
                                ft = rt.clone();
                            }
                            let mut _tmp_1 = self.textEl(ft,
                                &inh,
                                runId.clone()
                            );
                            EVGElement::add_child(&e, _tmp_1);
                        } else {
                            // (a line that does not wrap: the spaces at
                            // the ends of its text are the gaps beside the
                            // boxes, or nothing at the line's ends)
                            let mut nrt: String = rt.clone();
                            if nowrap && !keep {
                                nrt = DomView::trimmed(&rt);
                            }
                            // (a preserved newline on a line of boxes ends
                            // that line, as a break does)
                            let nl_split: bool = keep && ((!line.is_empty() || box_after) && DomText::index_of(&nrt, "\n") >= 0);
                            if nl_split {
                                let parts: Vec<String> = nrt.split("\n").map(|s| s.to_string()).collect::<Vec<String>>();
                                let np: i64 = parts.len() as i64;
                                for pi in 0..np {
                                    let pt: String = parts[pi as usize].clone();
                                    if !pt.is_empty() {
                                        line.push(self.textEl(pt.clone(), &inh, format!("{}n{}", runId, pi)));
                                        line_sp.push(pend);
                                        line_text = true;
                                    }
                                    pend = false;
                                    if pi < np - 1 && !line.is_empty() {
                                        self.flush(e, &line, &line_sp, line_text, &inh, n.borrow().get("s").borrow().getText("unicode-bidi") == "bidi-override");
                                        line.clear();
                                        line_sp.clear();
                                        line_text = false;
                                    }
                                }
                            } else if keep && (wsp && (DomText::index_of(&nrt, "\n") < 0 && (DomText::index_of(&nrt, " ") >= 0 || DomText::index_of(&nrt, "\u{a0}") >= 0))) {
                                // (preserved spaces with word-spacing: each
                                // one widened, CSS Text 3 8.2; the words
                                // apart by gaps of their spaces' width)
                                let gap1: f64 = DomView::spaceWidth(&inh);
                                let rb: Vec<u8> = nrt.as_bytes().to_vec();
                                let rn: i64 = rb.len() as i64;
                                let mut st: i64 = 0;
                                let mut piece_n: i64 = 0;
                                let mut first: bool = true;
                                while st < rn {
                                    // (a no-break space is one too)
                                    let sp: bool = (rb[st as usize] as i64) == 32 || ((rb[st as usize] as i64) == 194 && (st + 1 < rn && (rb[(st + 1) as usize] as i64) == 160));
                                    let mut en: i64 = st;
                                    let mut units: i64 = 0;
                                    let mut more: bool = true;
                                    while en < rn && more {
                                        let c0: i64 = rb[en as usize] as i64;
                                        let nb: bool = c0 == 194 && (en + 1 < rn && (rb[(en + 1) as usize] as i64) == 160);
                                        if (c0 == 32 || nb) != sp {
                                            more = false;
                                        } else {
                                            if nb {
                                                en += 2;
                                            } else {
                                                en += 1;
                                            }
                                            units += 1;
                                        }
                                    }
                                    if sp {
                                        let gap: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                                        EVGElement::set_attribute(&gap, "width", format!("{}px", DomView::fmt(gap1 * (units as f64))));
                                        EVGElement::set_attribute(&gap, "height", "0px".to_string());
                                        EVGElement::set_attribute(&gap, "flex-shrink", "0".to_string());
                                        line.push(gap);
                                    } else {
                                        line.push(self.textEl(nrt[(st) as usize..(en) as usize].to_string(), &inh, format!("{}w{}", runId, piece_n)));
                                        line_text = true;
                                    }
                                    if first {
                                        line_sp.push(pend);
                                    } else {
                                        line_sp.push(false);
                                    }
                                    first = false;
                                    piece_n += 1;
                                    st = en;
                                }
                            } else {
                                line.push(self.textEl(nrt.clone(), &inh, runId.clone()));
                                line_sp.push(pend);
                                line_text = true;
                            }
                        }
                    }
                    pend = false;
                }
                if !rt.is_empty() && DomView::white((rt.as_bytes()[((rt.as_bytes().len() as i64) - 1) as usize] as i64)) {
                    pend = true;
                }
                run = String::new();
                runId = String::new();
            }
            if !text && !end {
                let d: String = DomView::displayOf(&kid);
                let kinh: Rc<RefCell<JsonValue>> = self.inherit(&iinh,
                    &kid.borrow().get("s")
                );
                let was_flex: bool = self.inFlex;
                let was_outer: Rc<RefCell<JsonValue>> = self.outerS.clone().clone();
                if d == "list-item" {
                    items += 1;
                    self.listNo = items;
                }
                self.inFlex = flex;
                self.outerS = self.styleIn(n);
                // (a transformed box is the containing block of the fixed
                // boxes in it, CSS Transforms 1 §2: they are absolute there)
                let trn: String = self.outerS.borrow().getText("transform");
                let was_tr: i64 = self.inTransform;
                if !trn.is_empty() && trn != "none" {
                    self.inTransform += 1;
                }
                let kfs: Rc<RefCell<JsonValue>> = kid.borrow().get("s");
                if self.inTransform > 0 && kfs.borrow().getText("position") == "fixed" {
                    self.putPage(&kfs, "position", "absolute");
                }
                // (a table's row or row group: its band in the grid, the
                // cells are the table's own items)
                if tbl && !flat_row.is_empty() {
                    self.bandOnly = d == "table-row" || (d == "table-row-group" || (d == "table-header-group" || d == "table-footer-group"));
                }
                // a node the last frame built in the same surroundings: the
                // element it built then (DomMemo)
                let memo: Rc<RefCell<DomMemo>> = Rc::clone(&self.svgs.borrow().memo);
                let mut mkey: String = String::new();
                let mut kept: Option<Rc<RefCell<EVGElement>>> = None;
                if mon {
                    // (what it inherits, made this frame: by its text, once
                    // for the children that share it)
                    let ist: String = self.stampOf(&iinh);
                    if !inh_sigs.contains_key(&ist) {
                        inh_sigs.insert(ist.clone(), iinh.borrow().toJson());
                    }
                    mkey = format!("{}|{}|{}", msig, self.memoKey(), inh_sigs.get(&ist).cloned().unwrap());
                    kept = memo.borrow_mut().take(kid.borrow().stamp, &mkey);
                }
                let mut ke: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                if kept.is_some() {
                    ke = kept.clone().unwrap();
                    self.bandOnly = false;
                    self.lateCount += memo.borrow().lateOf(kid.borrow().stamp);
                    memo.borrow_mut().hits += 1;
                } else {
                    let bad0: i64 = self.memoBad;
                    let late0: i64 = self.lateCount;
                    ke = self.element(&kid, kinh.clone());
                    if mon {
                        memo.borrow_mut().misses += 1;
                        if self.memoBad == bad0 {
                            if kid.borrow().stamp <= 0 {
                                memo.borrow_mut().next += 1;
                                kid.borrow_mut().stamp = memo.borrow().next;
                            }
                            memo.borrow_mut().keep(kid.borrow().stamp, &mkey, &ke, self.lateCount - late0);
                        }
                    }
                }
                if tbl && k < (flat_row.len() as i64) {
                    EVGElement::set_attribute(&ke, "grid-row", flat_row[k as usize].clone());
                    EVGElement::set_attribute(&ke, "grid-column", flat_col[k as usize].clone());
                }
                self.inTransform = was_tr;
                self.parallelBaseline(Rc::clone(&ke), &kid, &kinh);
                self.inFlex = was_flex;
                self.outerS = was_outer.clone();
                let pos: String = kid.borrow().get("s").borrow().getText("position");
                let out_of_flow: bool = pos == "absolute" || pos == "fixed";
                let inline_box: bool = d == "inline" || (d == "inline-block" || (d == "inline-flex" || (d == "inline-grid" || d == "inline-table")));
                let fl: String = kid.borrow().get("s").borrow().getText("float");
                let floated: bool = !flex && (!out_of_flow && (fl == "left" || fl == "right"));
                let clr: String = kid.borrow().get("s").borrow().getText("clear");
                let is_br: bool = kid.borrow().getText("t") == "br";
                if !floated && (!is_br && (!clr.is_empty() && clr != "none")) {
                    // a box that clears goes under the floats before it
                    // (the left or the right ones, or both), its top margin
                    // taken in by the clearance
                    EVGElement::set_attribute(&ke, "clear-floats", DomView::clearSide(&clr));
                    if last_float == (e.borrow().children.len() as i64) - 1 {
                        // (kept where it is past the floats' bottom without
                        // clearance, CSS 2.1 9.5.2)
                        let cmt: f64 = DomView::pxOf(&kid.borrow().get("s").borrow().getText("margin-top"));
                        if cmt > 0.0 {
                            EVGElement::set_attribute(&ke, "clear-margin", DomView::fmt(cmt));
                        }
                        EVGElement::set_attribute(&ke, "margin-top", "0px".to_string());
                    }
                }
                if floated {
                    // floats side by side, out of the flow: a wrapping row
                    // per side, as tall as nothing unless this box holds
                    // its floats (a formatting context) or a later box
                    // clears them. A float met inside a line goes to that
                    // line's top, the line's content beside it (CSS 2.1
                    // 9.5.1 rule 6 and 9.5: the line box is shortened), so
                    // the line is kept open and drawn after the float
                    // (not when the float takes the whole width, or the line
                    // cannot wrap: then it goes under the line when it does
                    // not fit beside it)
                    let hws: String = iinh.borrow().getText("white-space");
                    let hfw: f64 = DomView::outerPxW(&kid.borrow().get("s"));
                    let hoist: bool = !line.is_empty() && (clr.is_empty() || clr == "none") && hws != "nowrap" && hws != "pre" && !(row_cw > 0.0 && hfw >= row_cw - 0.01);
                    if !hoist {
                        self.flush(e, &line, &line_sp, line_text, &inh, n.borrow().get("s").borrow().getText("unicode-bidi") == "bidi-override");
                        line.clear();
                        line_sp.clear();
                        pend = false;
                        line_text = false;
                    }
                    let mut row_at: i64 = 0 - 1;
                    if !f_rows.is_empty() && last_float == (e.borrow().children.len() as i64) - 1 {
                        row_at = (f_rows.len() as i64) - 1;
                    }
                    if row_at < 0 {
                        let fr: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                        EVGElement::set_attribute(&fr, "display", "flex".to_string());
                        EVGElement::set_attribute(&fr, "flex-direction", "row".to_string());
                        EVGElement::set_attribute(&fr, "flex-wrap", "wrap".to_string());
                        EVGElement::set_attribute(&fr, "align-items", "flex-start".to_string());
                        // (the float rules place them, CSS 2.1 9.5.1)
                        EVGElement::set_attribute(&fr, "float-row", "true".to_string());
                        // (floats paint over the in-flow blocks after them,
                        // CSS 2.1 Appendix E step 5; under a positioned box
                        // before them, which paints late in tree order)
                        let mut pos_before: bool = false;
                        for pk in e.borrow().children.iter().cloned() {
                            let pkp: String = pk.borrow().position.clone();
                            if pkp == "absolute" || pkp == "fixed" || pkp == "relative" || pkp == "sticky" {
                                pos_before = true;
                            }
                        }
                        if !pos_before {
                            EVGElement::set_attribute(&fr, "paint-late", "true".to_string());
                        }
                        EVGElement::add_child(&e, Rc::clone(&fr));
                        f_rows.push(Rc::clone(&fr));
                        f_sides.push("left".to_string().to_string());
                        f_cleared.push(false);
                        row_at = (f_rows.len() as i64) - 1;
                        row_left_w = 0.0;
                        row_right_w = 0.0;
                        row_full = false;
                    }
                    let fks: Rc<RefCell<JsonValue>> = kid.borrow().get("s");
                    let mut fw_1: f64 = DomView::outerPxW(&fks);
                    let fwv: String = fks.borrow().getText("width");
                    if (fw_1 < 0.0 && row_cw > 0.0) && ((fwv.as_bytes().len() as i64) > 1 && fwv[((fwv.as_bytes().len() as i64) - 1) as usize..(fwv.as_bytes().len() as i64) as usize].to_string() == "%") {
                        let fwq: Option<f64> = fwv[(0) as usize..((fwv.as_bytes().len() as i64) - 1) as usize].to_string()
                            .parse::<f64>()
                            .ok();
                        if fwq.is_some() {
                            let fks2: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
                            let __n_fki = fks.borrow().keys.len() as i64;
                            for fki in 0..__n_fki {
                                let fk = fks.borrow().keys[fki as usize].clone();
                                fks2.borrow_mut().put(&fk, fks.borrow().items[fki as usize].clone());
                            }
                            fks2.borrow_mut().putStr("width", &format!("{}px", DomView::fmt((row_cw * fwq.unwrap()) / 100.0)));
                            fw_1 = DomView::outerPxW(&fks2);
                        }
                    }
                    if ((row_cw > 0.0 && fw_1 >= 0.0) && (row_left_w >= 0.0 && row_right_w >= 0.0)) && ((row_left_w + row_right_w) + fw_1) - row_cw > 0.01 {
                        row_full = true;
                    }
                    if !row_full {
                        if fl == "right" {
                            if fw_1 < 0.0 || row_right_w < 0.0 {
                                row_right_w = -1.0;
                            } else {
                                row_right_w += fw_1;
                            }
                        } else {
                            if fw_1 < 0.0 || row_left_w < 0.0 {
                                row_left_w = -1.0;
                            } else {
                                row_left_w += fw_1;
                            }
                        }
                    }
                    last_float = (e.borrow().children.len() as i64) - 1;
                    // (a float's percentage heights are of this block's height,
                    // not of the row it is in)
                    let bhp: f64 = self.defH;
                    if bhp >= 0.0 {
                        let pnames: Vec<String> = vec!["height".to_string(), "min-height".to_string(), "max-height".to_string()];
                        for pn in pnames.iter().cloned() {
                            let pv: String = fks.borrow().getText(&pn);
                            let pc_at: i64 = DomText::index_of(&pv, "%");
                            if pc_at > 0 && DomText::index_of(&pv, "(") < 0 {
                                let pnum: String = pv[(0) as usize..(pc_at) as usize].to_string();
                                let pd: Option<f64> = pnum.parse::<f64>().ok();
                                if pd.is_some() {
                                    EVGElement::set_attribute(
                                        &ke,
                                        &pn,
                                        format!("{}px", DomView::fmt((bhp * pd.unwrap()) / 100.0))
                                    );
                                }
                            }
                        }
                    }
                    EVGElement::set_attribute(&ke, "flex-shrink", "0".to_string());
                    EVGElement::set_attribute(&ke, "float-side", fl.clone());
                    if !clr.is_empty() && clr != "none" {
                        EVGElement::set_attribute(&ke, "clear-floats", DomView::clearSide(&clr));
                    }
                    // the right floats after the left ones, at the far end
                    if fl == "right" && f_sides[row_at as usize].clone() != "right" {
                        EVGElement::set_attribute(&ke, "margin-left", "auto".to_string());
                        f_sides[row_at as usize] = "right".to_string();
                    }
                    let frow: Rc<RefCell<EVGElement>> = Rc::clone(&f_rows[row_at as usize]);
                    EVGElement::add_child(&frow, Rc::clone(&ke));
                    k += 1;
                    continue;
                }
                if flex || out_of_flow {
                    // (an inline-level absolute box right after floats: its
                    // static position is on the line beside them, by the
                    // line's text-align, CSS 2.1 10.3.7)
                    if (out_of_flow && kid.borrow().has("ia")) && ((!f_rows.is_empty() && last_float == (e.borrow().children.len() as i64) - 1) && ((row_cw > 0.0 && row_left_w >= 0.0) && row_right_w >= 0.0)) {
                        let iks: Rc<RefCell<JsonValue>> = kid.borrow().get("s");
                        let il: String = iks.borrow().getText("left");
                        let ir: String = iks.borrow().getText("right");
                        if (il.is_empty() || il == "auto") && (ir.is_empty() || ir == "auto") {
                            let ita: String = inh.borrow().getText("text-align");
                            let irtl: bool = inh.borrow().getText("direction") == "rtl";
                            let line_a: f64 = row_left_w;
                            let line_b: f64 = row_cw - row_right_w;
                            let mut ip: f64 = line_a;
                            if irtl {
                                ip = line_b;
                            }
                            if ita == "center" || ita == "-webkit-center" {
                                ip = (line_a + line_b) / 2.0;
                            } else if ita == "right" || (ita == "end" && !irtl) || (ita == "start" && irtl) {
                                ip = line_b;
                            } else if ita == "left" || (ita == "start" && !irtl) || (ita == "end" && irtl) {
                                ip = line_a;
                            }
                            let iw: f64 = DomView::outerPxW(&iks);
                            if !irtl || iw >= 0.0 {
                                if irtl {
                                    ip -= iw;
                                }
                                let ipl: f64 = DomView::pxOf(&n.borrow().get("s").borrow().getText("padding-left"));
                                EVGElement::set_attribute(&ke, "left", format!("{}px", DomView::fmt(ipl + ip)));
                            }
                        }
                    }
                    EVGElement::add_child(&e, Rc::clone(&ke));
                } else {
                    if inline_box {
                        line.push(Rc::clone(&ke));
                        line_sp.push(pend);
                        pend = false;
                        // a line break ends its line. Its line is beside the
                        // left floats just before it, and one that clears
                        // puts what follows under both (CSS 2.1 9.5.2: the
                        // clearance is after the break)
                        if is_br {
                            let beside_floats: bool = !f_rows.is_empty() && (last_float == (e.borrow().children.len() as i64) - 1 && f_sides[((f_rows.len() as i64) - 1) as usize].clone() == "left");
                            if beside_floats {
                                let tmp: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                                self.flush(&tmp, &line, &line_sp, line_text, &inh, n.borrow().get("s").borrow().getText("unicode-bidi") == "bidi-override");
                                let f_at: i64 = (f_rows.len() as i64) - 1;
                                let frow2: Rc<RefCell<EVGElement>> = Rc::clone(&f_rows[f_at as usize]);
                                let __it_lr = tmp.borrow().children.clone();
                                for lr in __it_lr.iter().cloned() {
                                    EVGElement::set_attribute(&lr, "flex-grow", "1".to_string());
                                    EVGElement::set_attribute(&lr, "flex-basis", "0px".to_string());
                                    EVGElement::add_child(&frow2, Rc::clone(&lr));
                                }
                                if !clr.is_empty() && clr != "none" {
                                    let __n_fri2 = f_rows.len() as i64;
                                    for fri2 in 0..__n_fri2 {
                                        let fr2 = Rc::clone(&f_rows[fri2 as usize]);
                                        f_cleared[fri2 as usize] = true;
                                    }
                                }
                                last_float = 0 - 1;
                            } else {
                                self.flush(e, &line, &line_sp, line_text, &inh, n.borrow().get("s").borrow().getText("unicode-bidi") == "bidi-override");
                                // (what follows the break goes under the
                                // floats)
                                if !clr.is_empty() && clr != "none" {
                                    let cl: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                                    EVGElement::set_attribute(&cl, "height", "0px".to_string());
                                    EVGElement::set_attribute(&cl, "clear-floats", DomView::clearSide(&clr));
                                    EVGElement::add_child(&e, Rc::clone(&cl));
                                }
                            }
                            line.clear();
                            line_sp.clear();
                            line_text = false;
                        }
                    } else {
                        self.flush(e, &line, &line_sp, line_text, &inh, n.borrow().get("s").borrow().getText("unicode-bidi") == "bidi-override");
                        line.clear();
                        line_sp.clear();
                        pend = false;
                        line_text = false;
                        // a box with its own formatting context right after
                        // floats sits beside them, not under (CSS 2.1 9.5)
                        let bks: Rc<RefCell<JsonValue>> = kid.borrow().get("s");
                        let next_to_floats: bool = !f_rows.is_empty() && last_float == (e.borrow().children.len() as i64) - 1;
                        // (one of a px width, after floats not yet cleared:
                        // EVG finds the place where its border box fits
                        // beside them as they are laid out)
                        let gbfc: bool = DomView::holdsFloats(&bks, &d) || (d == "flex" || (d == "grid" || d == "table"));
                        let gw: String = bks.borrow().getText("width");
                        // (a min-width can make it wider than its width:
                        // left to the rules below)
                        let gmw: String = bks.borrow().getText("min-width");
                        let g_minw_ok: bool = gmw.is_empty() || (gmw == "auto" || (gmw == "0px" || gmw == "0"));
                        let mut g_uncleared: bool = false;
                        let __n_gfi = f_cleared.len() as i64;
                        for gfi in 0..__n_gfi {
                            if !f_cleared[gfi as usize] {
                                g_uncleared = true;
                            }
                        }
                        let geo_bfc: bool = (!f_rows.is_empty() && g_uncleared) && ((gbfc && gw.ends_with("px") && g_minw_ok) && ((clr.is_empty() || clr == "none") && (bks.borrow().getText("margin-left") != "auto" && inh.borrow().getText("direction") != "rtl")));
                        if geo_bfc {
                            EVGElement::set_attribute(&ke, "beside-floats", "bfc".to_string());
                        } else if next_to_floats && (!(f_cleared[((f_rows.len() as i64) - 1) as usize]) && (clr.is_empty() || clr == "none")) {
                            let bfc: bool = DomView::holdsFloats(&bks, &d) || (d == "flex" || (d == "grid" || d == "table"));
                            // (one wider than the room beside them goes
                            // under them: its width, or its min-width, in px
                            // or in % of the container's)
                            let mut bw: f64 = -1.0;
                            if bfc && row_cw > 0.0 {
                                let __v_bwi: Vec<String> = vec!["width".to_string(), "min-width".to_string()];
                                let __n_bwi = __v_bwi.len() as i64;
                                for bwi in 0..__n_bwi {
                                    let bwn = __v_bwi[bwi as usize].clone();
                                    let bwv: String = bks.borrow().getText(&bwn);
                                    let mut bwp: f64 = -1.0;
                                    if DomText::index_of(&bwv, "px") > 0 {
                                        bwp = DomView::pxOf(&bwv);
                                    }
                                    if DomText::index_of(&bwv, "%") > 0 && DomText::index_of(&bwv, "calc") < 0 {
                                        let bwq: Option<f64> = bwv[(0) as usize..((bwv.as_bytes().len() as i64) - 1) as usize].to_string()
                                            .parse::<f64>()
                                            .ok();
                                        if bwq.is_some() {
                                            bwp = (row_cw * bwq.unwrap()) / 100.0;
                                        }
                                    }
                                    if bwp > bw {
                                        bw = bwp;
                                    }
                                }
                            }
                            let too_wide: bool = (bw >= 0.0 && (row_left_w >= 0.0 && row_right_w >= 0.0)) && bw - ((row_cw - row_left_w) - row_right_w) > 0.01;
                            if too_wide {
                                EVGElement::set_attribute(&ke, "clear-floats", "true".to_string());
                            }
                            // (auto margins share the room the floats leave,
                            // CSS 2.1 9.5)
                            let aml: bool = bks.borrow().getText("margin-left") == "auto";
                            let amr: bool = bks.borrow().getText("margin-right") == "auto";
                            let bwv0: String = bks.borrow().getText("width");
                            if (((bfc && !too_wide) && (row_left_w >= 0.0 && row_right_w >= 0.0)) && (aml || amr)) && (row_cw > 0.0 && DomText::index_of(&bwv0, "px") > 0) {
                                let mut bo: f64 = DomView::pxOf(&bwv0);
                                if bks.borrow().getText("box-sizing") != "border-box" {
                                    bo += ((DomView::pxOf(&bks.borrow().getText("padding-left")) + DomView::pxOf(&bks.borrow().getText("padding-right"))) + DomView::side(&bks, "left")) + DomView::side(&bks, "right");
                                }
                                let mut ml0: f64 = DomView::pxOf(&bks.borrow().getText("margin-left"));
                                let mut mr0: f64 = DomView::pxOf(&bks.borrow().getText("margin-right"));
                                let mut free: f64 = ((row_cw - row_left_w) - row_right_w) - bo;
                                if !aml {
                                    free -= ml0;
                                }
                                if !amr {
                                    free -= mr0;
                                }
                                if free >= 0.0 {
                                    if aml && amr {
                                        ml0 = free / 2.0;
                                        mr0 = free / 2.0;
                                    } else if aml {
                                        ml0 = free;
                                    } else {
                                        mr0 = free;
                                    }
                                    EVGElement::set_attribute(&ke, "margin-left", format!("{}px", DomView::fmt(row_left_w + ml0)));
                                    EVGElement::set_attribute(&ke, "margin-right", format!("{}px", DomView::fmt(row_right_w + mr0)));
                                }
                            } else if ((bfc && !too_wide) && row_left_w >= 0.0) && row_right_w >= 0.0 {
                                if row_left_w > 0.0 {
                                    let _tmp_1 = row_left_w + DomView::pxOf(&bks.borrow().getText("margin-left"));
                                    EVGElement::set_attribute(
                                        &ke,
                                        "margin-left",
                                        format!("{}px", DomView::fmt(_tmp_1))
                                    );
                                }
                                if row_right_w > 0.0 {
                                    let _tmp_1 = row_right_w + DomView::pxOf(&bks.borrow().getText("margin-right"));
                                    EVGElement::set_attribute(
                                        &ke,
                                        "margin-right",
                                        format!("{}px", DomView::fmt(_tmp_1))
                                    );
                                }
                            }
                            // (a block in the flow overlaps the floats and its
                            // lines are shortened beside them, CSS 2.1 9.5)
                            let plain_block: bool = d == "block" || (d == "list-item" || d.is_empty());
                            if (!bfc && plain_block) && DomView::inlineOnly(&kid) {
                                EVGElement::set_attribute(&ke, "beside-floats", "true".to_string());
                            }
                        }
                        EVGElement::add_child(&e, Rc::clone(&ke));
                    }
                }
            }
            k += 1;
        }
        self.flush(e, &line, &line_sp, line_text, &inh, n.borrow().get("s").borrow().getText("unicode-bidi") == "bidi-override");
        // (the lines and blocks after floats in this block are beside them
        // where they reach their top)
        if !f_rows.is_empty() {
            let mut seen_f: bool = false;
            let __it_bc = e.borrow().children.clone();
            for bc in __it_bc.iter().cloned() {
                let bx: Rc<RefCell<EVGCssExtra>> = EVGLayoutFull::cx(Rc::clone(&bc));
                if bx.borrow().float_row {
                    seen_f = true;
                } else {
                    // (a line that is a row of runs has each of its lines
                    // shortened by the floats beside that line)
                    let row_line: bool = bx.borrow().height_through || bc.borrow().class_name == "mfd-words";
                    let anon_line: bool = row_line || !bc.borrow().text_content.is_empty() && EVGElement::get_child_count(&bc) == 0;
                    if (seen_f && !bx.borrow().clear_floats) && anon_line {
                        if row_line && EVGElement::get_child_count(&bc) > 0 {
                            EVGElement::set_attribute(&bc, "beside-floats", "lines".to_string());
                        } else {
                            EVGElement::set_attribute(&bc, "beside-floats", "true".to_string());
                        }
                    }
                }
            }
        }
        // floats a box does not hold take no height in it (a flex or grid
        // item holds its own)
        if !DomView::holdsFloats(&n.borrow().get("s"), display) && !self.inFlex {
            let __n_fri = f_rows.len() as i64;
            for fri in 0..__n_fri {
                let fr_1 = Rc::clone(&f_rows[fri as usize]);
                if !(f_cleared[fri as usize]) {
                    EVGElement::set_attribute(&fr_1, "height", "0px".to_string());
                    fr_1.borrow_mut().class_name = "mfd-floats".to_string();
                }
            }
        }
        // (in one that holds them they take no room in the flow either, and
        // the box reaches their bottom)
        // (a flex or grid item, a table cell, holds them so too)
        // (only when a box follows its floats: the item or the table is
        // sized before it grows to them)
        let mut flow_after: bool = false;
        if !f_rows.is_empty() {
            let ec: Vec<Rc<RefCell<EVGElement>>> = e.borrow().children.clone();
            if !ec.is_empty() {
                flow_after = !Rc::ptr_eq(&ec[ec.len() - 1], &f_rows[f_rows.len() - 1]);
            }
        }
        let item_holds: bool = (self.inFlex && flow_after) && (display == "block" || (display == "list-item" || (display.is_empty() || display == "table-cell")));
        if (DomView::holdsFloats(&n.borrow().get("s"), display) || item_holds) && !flex {
            let mut any_f: bool = false;
            let __n_fri3 = f_rows.len() as i64;
            for fri3 in 0..__n_fri3 {
                let fr3 = Rc::clone(&f_rows[fri3 as usize]);
                if !(f_cleared[fri3 as usize]) {
                    EVGElement::set_attribute(&fr3, "height", "0px".to_string());
                    fr3.borrow_mut().class_name = "mfd-floats".to_string();
                    any_f = true;
                }
            }
            if any_f {
                EVGElement::set_attribute(&e, "float-holder", "true".to_string());
                // (a cell's floats are its content too: what vertical-align
                // places is taken as filling it)
                if display == "table-cell" {
                    EVGElement::set_attribute(&e, "justify-content", "flex-start".to_string());
                }
            }
        }
        if !flex {
            DomView::collapseSiblings(e);
        }
    }
    fn collapseThrough(&self, e: &Rc<RefCell<EVGElement>>, s: &Rc<RefCell<JsonValue>>, flex_item: bool) {
        if flex_item {
            return;
        }
        let ox: String = s.borrow().getText("overflow-x");
        let oy: String = s.borrow().getText("overflow-y");
        if !ox.is_empty() && ox != "visible" || !oy.is_empty() && oy != "visible" {
            return;
        }
        let pos: String = s.borrow().getText("position");
        if pos == "absolute" || pos == "fixed" {
            return;
        }
        let fl: String = s.borrow().getText("float");
        if !fl.is_empty() && fl != "none" {
            return;
        }
        let mut kids: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        // (floats that take no height are out of the flow too)
        let __it_k = e.borrow().children.clone();
        for k in __it_k.iter().cloned() {
            if DomView::inFlow(&k) && k.borrow().class_name != "mfd-floats" {
                kids.push(Rc::clone(&k));
            }
        }
        let n: i64 = kids.len() as i64;
        if n == 0 {
            return;
        }
        let first: Rc<RefCell<EVGElement>> = Rc::clone(&kids[0]);
        if DomView::pxOf(&s.borrow().getText("padding-top")) == 0.0 && DomView::side(s, "top") == 0.0 {
            let mut _tmp_1 = e.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone();
            if (DomView::plain(_tmp_1) && DomView::plain(first.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone())) && !DomView::struck(&first) {
                let _tmp_1 = DomView::mPx(e.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone());
                let _tmp_2 = DomView::mPx(first.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone());
                let c: f64 = DomView::collapsed(_tmp_1, _tmp_2);
                EVGElement::set_attribute(&e, "margin-top", format!("{}px", DomView::fmt(c)));
                EVGElement::set_attribute(&first, "margin-top", "0px".to_string());
            }
        }
        // (empty blocks at the end let the margin before them through:
        // collapseSiblings left the chain on the last box and their tops)
        let mut li: i64 = n - 1;
        let mut trail: f64 = 0.0;
        while li > 0 && DomView::selfCollapsing(&Rc::clone(&kids[li as usize])) {
            let tk: Rc<RefCell<EVGElement>> = Rc::clone(&kids[li as usize]);
            trail += DomView::mPx(tk.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone());
            li -= 1;
        }
        let last: Rc<RefCell<EVGElement>> = Rc::clone(&kids[li as usize]);
        // (a box with clearance in that chain keeps it in this box: its
        // margins do not collapse with this box's bottom, CSS 2.1 8.3.1)
        let mut has_floats: bool = false;
        let __it_fk = e.borrow().children.clone();
        for fk in __it_fk.iter().cloned() {
            if EVGLayoutFull::cx(Rc::clone(&fk)).borrow().float_row {
                has_floats = true;
            }
        }
        let mut cj: i64 = li;
        while cj < n && has_floats {
            if EVGLayoutFull::cx(Rc::clone(&kids[cj as usize])).borrow().clear_floats {
                return;
            }
            cj += 1;
        }
        let mut auto_h: bool = (s.borrow().getText("height").as_bytes().len() as i64) == 0 && (s.borrow().getText("min-height").as_bytes().len() as i64) == 0;
        // (with a min-height the margin goes through only when it leaves
        // the height as the content makes it; else it is in neither this
        // box nor after it. A max-height keeps CSS 2.1's collapsing,
        // margin-collapse-038)
        let minh_t: String = s.borrow().getText("min-height");
        let min_px: bool = minh_t.ends_with("px");
        if (s.borrow().getText("height").as_bytes().len() as i64) == 0 && min_px && DomView::pxOf(&s.borrow().getText("padding-bottom")) == 0.0 && DomView::side(s, "bottom") == 0.0 {
            let mut h0: f64 = 0.0;
            let mut ok: bool = DomView::plain(last.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) && !DomView::struck(&last);
            let mut hi: i64 = 0;
            while hi <= li && ok {
                let hk: Rc<RefCell<EVGElement>> = Rc::clone(&kids[hi as usize]);
                let hu: Option<Rc<RefCell<EVGUnit>>> = hk.borrow().height.clone();
                if hu.is_none() || !hu.as_ref().unwrap().borrow().is_set || hu.as_ref().unwrap().borrow().unit_type != 0 {
                    ok = false;
                } else {
                    let mut _tmp_p = hk.borrow().r#box.as_ref().unwrap().borrow().padding_top.clone();
                    let mut _tmp_q = hk.borrow().r#box.as_ref().unwrap().borrow().padding_bottom.clone();
                    if DomView::mPx(_tmp_p) != 0.0 || DomView::mPx(_tmp_q) != 0.0 || DomView::mPx(hk.borrow().r#box.as_ref().unwrap().borrow().border_width.clone()) != 0.0 {
                        ok = false;
                    }
                    h0 += DomView::mPx(hk.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone());
                    h0 += DomView::mPx(hu.clone());
                    if hi < li {
                        h0 += DomView::mPx(hk.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone());
                    }
                }
                hi += 1;
            }
            if ok {
                let mn: f64 = DomView::pxOf(&minh_t);
                if h0 < mn {
                    let chain2: f64 = DomView::mPx(last.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) + trail;
                    let mut tj2: i64 = li + 1;
                    while tj2 < n {
                        let tk3: Rc<RefCell<EVGElement>> = Rc::clone(&kids[tj2 as usize]);
                        if tj2 == li + 1 {
                            EVGElement::set_attribute(&tk3, "margin-top", format!("{}px", DomView::fmt(chain2)));
                        } else {
                            EVGElement::set_attribute(&tk3, "margin-top", "0px".to_string());
                        }
                        if tj2 == n - 1 {
                            EVGElement::set_attribute(&tk3, "margin-bottom", format!("{}px", DomView::fmt(0.0 - chain2)));
                        }
                        tj2 += 1;
                    }
                    EVGElement::set_attribute(&last, "margin-bottom", "0px".to_string());
                    return;
                }
                auto_h = true;
            }
        }
        if auto_h && (DomView::pxOf(&s.borrow().getText("padding-bottom")) == 0.0 && DomView::side(s, "bottom") == 0.0) {
            let mut _tmp_1 = e.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone();
            if (DomView::plain(_tmp_1) && DomView::plain(last.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone())) && !DomView::struck(&last) {
                let _tmp_1 = DomView::mPx(e.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone());
                let _tmp_2 = DomView::mPx(last.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) + trail;
                let c2: f64 = DomView::collapsed(_tmp_1, _tmp_2);
                // (the empty blocks stay where the margin puts them, and the
                // last one takes it back so this box ends at the last one
                // with something in it)
                let chain: f64 = DomView::mPx(last.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) + trail;
                let mut tj: i64 = li + 1;
                while tj < n {
                    let tk2: Rc<RefCell<EVGElement>> = Rc::clone(&kids[tj as usize]);
                    if tj == li + 1 {
                        EVGElement::set_attribute(&tk2, "margin-top", format!("{}px", DomView::fmt(chain)));
                    } else {
                        EVGElement::set_attribute(&tk2, "margin-top", "0px".to_string());
                    }
                    if tj == n - 1 {
                        EVGElement::set_attribute(
                            &tk2,
                            "margin-bottom",
                            format!("{}px", DomView::fmt(0.0 - chain))
                        );
                    }
                    tj += 1;
                }
                EVGElement::set_attribute(&e, "margin-bottom", format!("{}px", DomView::fmt(c2)));
                // (an absolute box after it with no inset is under that
                // margin all the same)
                let lmb: f64 = DomView::mPx(last.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone());
                let mut after: bool = false;
                let __it_k2 = e.borrow().children.clone();
                for k2 in __it_k2.iter().cloned() {
                    if after {
                        let k2x: Rc<RefCell<EVGCssExtra>> = EVGLayoutFull::cx(Rc::clone(&k2));
                        // (and so are floats after it)
                        if k2.borrow().class_name == "mfd-floats" {
                            EVGElement::set_attribute(&k2, "margin-top", format!("{}px", DomView::fmt(lmb)));
                            EVGElement::set_attribute(
                                &k2,
                                "margin-bottom",
                                format!("{}px", DomView::fmt(0.0 - lmb))
                            );
                        }
                        if k2x.borrow().static_flow && DomView::plain(k2.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone()) {
                            let _tmp_1 = format!("{}px", DomView::fmt(DomView::collapsed(lmb, DomView::mPx(k2.borrow().r#box.as_ref().unwrap().borrow().margin_top.clone()))));
                            EVGElement::set_attribute(&k2, "margin-top", _tmp_1);
                        }
                    }
                    if Rc::ptr_eq(&k2, &last) {
                        after = true;
                    }
                }
                EVGElement::set_attribute(&last, "margin-bottom", "0px".to_string());
            }
        }
    }
    /// the strong direction of an item's text (UAX 9 classes, roughly):
    /// 1 left to right, -1 right to left (or mixed), 0 neither
    fn strongDir(el: &Rc<RefCell<EVGElement>>) -> i64 {
        let mut d: i64 = 0;
        let t: String = el.borrow().text_content.clone();
        let tn: i64 = t.as_bytes().len() as i64;
        let mut q: i64 = 0;
        while q < tn {
            let b: i64 = t.as_bytes()[q as usize] as i64;
            if (b >= 65 && b <= 90) || (b >= 97 && b <= 122) {
                if d == 0 {
                    d = 1;
                }
            }
            if b >= 128 {
                // (anything past ASCII decides nothing here: right to left)
                return 0 - 1;
            }
            q += 1;
        }
        let __it_c = el.borrow().children.clone();
        for c in __it_c.iter().cloned() {
            let cd: i64 = DomView::strongDir(&c);
            if cd == (0 - 1) {
                return 0 - 1;
            }
            if cd == 1 {
                d = 1;
            }
        }
        d
    }
    /// right to left a row runs from the right, but left-to-right pieces
    /// in it keep their order, the white space between them too (UAX 9 L2:
    /// a run of them reversed once more)
    fn ltrRuns(mut line: &mut Vec<Rc<RefCell<EVGElement>>>, mut line_sp: &mut Vec<bool>) {
        if (line.len() as i64) < 2 {
            return;
        }
        let mut dirs: Vec<i64> = Vec::new();
        for di in line.iter().cloned() {
            dirs.push(DomView::strongDir(&di));
        }
        let ln: i64 = line.len() as i64;
        let mut a: i64 = 0;
        while a < ln {
            if dirs[a as usize] != 1 {
                a += 1;
                continue;
            }
            // the run: from this L to the last L before an R
            let mut b: i64 = a;
            let mut q: i64 = a + 1;
            while q < ln && dirs[q as usize] != (0 - 1) {
                if dirs[q as usize] == 1 {
                    b = q;
                }
                q += 1;
            }
            if b > a {
                let mut rl: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
                let mut rs: Vec<bool> = Vec::new();
                let mut k: i64 = 0;
                while k <= b - a {
                    rl.push(Rc::clone(&line[(b - k) as usize]));
                    if k == 0 {
                        rs.push(line_sp[a as usize]);
                    } else {
                        rs.push(line_sp[(b - k + 1) as usize]);
                    }
                    k += 1;
                }
                k = 0;
                while k <= b - a {
                    line[(a + k) as usize] = Rc::clone(&rl[k as usize]);
                    line_sp[(a + k) as usize] = rs[k as usize];
                    k += 1;
                }
            }
            a = b + 1;
        }
    }
    /// a line of a block: one text element as it is, else a wrapping row
    fn flush(&self, e: &Rc<RefCell<EVGElement>>, line_in: &Vec<Rc<RefCell<EVGElement>>>, sp_in: &[bool], line_text: bool, inh: &Rc<RefCell<JsonValue>>, overridden: bool) {
        if line_in.is_empty() {
            return;
        }
        // the block's first line starts text-indent in: an empty text
        // element as wide, or one pulling the line back by a negative one
        let mut line: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut line_sp: Vec<bool> = Vec::new();
        let ti: String = inh.borrow().getText("text-indent");
        // (a row of words: the first one's margin, so the indent and that
        // word are one piece where the row is as narrow as its widest)
        let one_word: bool = line_text && line_in.len() == 1 && DomText::index_of(&line_in[0].borrow().text_content, " ") < 0 && DomText::index_of(&line_in[0].borrow().text_content, "\n") < 0 && DomText::index_of(&line_in[0].borrow().text_content, "\u{200b}") < 0;
        // (or a line that starts with an empty atomic box: a picture, an
        // empty inline-block)
        let atom0: bool = line_in[0].borrow().text_content.is_empty() && line_in[0].borrow().children.is_empty();
        let first_word: bool = (!line_text || one_word || atom0) && inh.borrow().getText("direction") != "rtl" && ti.ends_with("px") && (!ti.starts_with("-") || atom0) && DomText::index_of(&line_in[0].borrow().class_name, "mfd-br") < 0;
        if !ti.is_empty() && (ti != "0px" && ti != "0" && ti != "0%") && e.borrow().children.is_empty() && first_word {
            let w0: Rc<RefCell<EVGElement>> = Rc::clone(&line_in[0]);
            let m0: f64 = DomView::mPx(w0.borrow().r#box.as_ref().unwrap().borrow().margin_left.clone());
            EVGElement::set_attribute(&w0, "margin-left", format!("{}px", DomView::fmt(m0 + DomView::pxOf(&ti))));
        } else if !ti.is_empty() && (ti != "0px" && ti != "0" && ti != "0%") && e.borrow().children.is_empty() {
            let sp: Rc<RefCell<EVGElement>> = self.textEl(String::new(), inh, String::new());
            if ti.starts_with("-") {
                EVGElement::set_attribute(&sp, "width", "0px".to_string());
                EVGElement::set_attribute(&sp, "margin-left", ti.clone());
            } else {
                EVGElement::set_attribute(&sp, "width", ti.clone());
            }
            EVGElement::set_attribute(&sp, "flex-shrink", "0".to_string());
            line.push(Rc::clone(&sp));
            line_sp.push(false);
            // (a text alone after it starts the line all the same: its white
            // space at either end goes, as with no indent)
            if (line_text && line_in.len() == 1) && !self.pre(inh) {
                let _tmp_t = DomView::trimmed(&line_in[0].borrow().text_content.clone());
                line_in[0].borrow_mut().text_content = _tmp_t;
            }
        }
        for li in line_in.iter().cloned() {
            line.push(Rc::clone(&li));
        }
        for ls in sp_in.iter().cloned() {
            line_sp.push(ls);
        }
        if (line_sp.len() as i64) > (sp_in.len() as i64) && (line_sp.len() as i64) > 1 {
            line_sp[1] = false;
        }
        // (right to left the row runs from the right, but left-to-right
        // pieces in it keep their order, the white space between them too:
        // UAX 9 L2, a run of them reversed once more)
        if inh.borrow().getText("direction") == "rtl" && !overridden {
            DomView::ltrRuns(&mut line, &mut line_sp);
        }
        let n: i64 = line.len() as i64;
        let ta: String = DomView::alignOf(inh);
        let mut aligned: bool = ta == "center" || (ta == "right" || ta == "end");
        // (left in a right-to-left block: a row, which EVG does not mirror;
        // a row of words is turned at the start of its line instead)
        if ta == "left" && inh.borrow().getText("direction") == "rtl" && !line[0].borrow().text_content.is_empty() {
            aligned = true;
        }
        if n == 1 && (line_text && !aligned) {
            // a text element stretches across its block, as the line does
            let only: Rc<RefCell<EVGElement>> = Rc::clone(&line[0]);
            // (pre text keeps its white space)
            if !self.pre(inh) {
                let _tmp_2 = DomView::trimmed(&only.borrow().text_content.clone());
                only.borrow_mut().text_content = _tmp_2;
            }
            // a smaller font than the block's sits on the baseline of the
            // block's font's line (the strut), which is the line's height
            // then: `<span>` of 11px in a 13px block is 2px down and the
            // line 18px, not 15
            let strut: Vec<f64> = DomView::strutOf(inh);
            DomView::onStrut(&only, strut[0], strut[1]);
            EVGElement::add_child(&e, Rc::clone(&only));
            return;
        }
        // (a text element alone is as wide as its text in EVG, so a centred
        // line is a row that centres it)
        let row: Rc<RefCell<EVGElement>> = DomView::lineRow(inh);
        // (a percentage height on the line is of the block's)
        EVGElement::set_attribute(&row, "height-through", "true".to_string());
        // the line's text and pictures on one baseline: text is as tall as
        // its line, so its bottom is the descent under the baseline, and a
        // picture's (margin) bottom is on it. An inline box with lines of its
        // own stays in the middle. With no text the line is as tall as the
        // block's font's line (the strut) all the same.
        EVGElement::set_attribute(&row, "align-items", "flex-end".to_string());
        // the white space between two items is the row's gap (a space of
        // the block's face, which a line's end does not keep); two items with
        // none between them take the gap back
        let gap: f64 = DomView::spaceWidth(inh);
        EVGElement::set_attribute(&row, "column-gap", format!("{}px", DomView::fmt(gap)));
        let mut desc: f64 = DomView::descent(inh);
        let mut br_fs: f64 = DomView::pxOf(&inh.borrow().getText("font-size"));
        if br_fs == 0.0 {
            br_fs = 16.0;
        }
        let br_desc: f64 = ((br_fs * DomView::descentEm(&DomView::faceOf(&inh.borrow().getText("font-family"), "")[0].clone()) + 0.5).floor() as i64) as f64;
        // (a line-height under the font's: the strut ends above the
        // baseline, and a picture's bottom is the line's)
        if desc < 0.0 {
            desc = 0.0;
        }
        let mut has_text: bool = false;
        // text of other sizes on one baseline, the strut's among them: each
        // as tall as the line above and under the baseline
        let strut_1: Vec<f64> = DomView::strutOf(inh);
        let mut above: f64 = strut_1[0];
        let mut below: f64 = strut_1[1];
        for it0 in line.iter().cloned() {
            let t0: Option<Rc<RefCell<EVGElement>>> = DomView::runOf(&it0);
            if t0.is_some() {
                let sp: Vec<f64> = DomView::splitOf(&t0.clone().unwrap());
                above = DomView::maxOf(above, sp[0]);
                below = DomView::maxOf(below, sp[1]);
            }
        }
        // an inline box with lines of its own (an inline-block of text, an
        // inline-grid) sits on the line's baseline by its first line's: the
        // row aligns on baselines then, with an invisible strut of the
        // block's font among its items
        let mut line_text_1: bool = false;
        for lt in line.iter().cloned() {
            if DomView::textual(&lt) {
                line_text_1 = true;
            }
        }
        let mut by_base: bool = false;
        for ib in line.iter().cloned() {
            if (ib.borrow().tag_name != "svg" && ib.borrow().svg_source.is_empty()) && (!DomView::textual(&ib) && DomText::index_of(&ib.borrow().class_name, "mfd-br") < 0) {
                // (a grid's baseline is its first item's, a picture's
                // bottom when it has no text: EVG has it)
                // (one vertical-align puts at the top or bottom is not)
                // (so is a flex container's, its first item's, synthesized
                // from the item's bottom when it has no text)
                let mut __re_gx1: Rc<RefCell<EVGCssExtra>> = EVGLayoutFull::cx(Rc::clone(&ib));
                let flex_col: bool = __re_gx1.borrow().flex_box && !ib.borrow().children.is_empty();
                if (((DomView::hasText(&ib) || ib.borrow().display == "grid") || DomView::flexInside(&ib)) || flex_col) && ib.borrow().align_self.is_empty() {
                    by_base = true;
                }
            }
        }
        if by_base {
            EVGElement::set_attribute(&row, "align-items", "baseline".to_string());
            let st: Rc<RefCell<EVGElement>> = self.textEl("x".to_string(),
                inh,
                String::new()
            );
            EVGElement::set_attribute(&st, "width", "0px".to_string());
            EVGElement::set_attribute(&st, "white-space", "nowrap".to_string());
            EVGElement::set_attribute(&st, "opacity", "0".to_string());
            EVGElement::set_attribute(&st, "flex-shrink", "0".to_string());
            EVGElement::set_attribute(&st, "margin-right", format!("{}px", DomView::fmt(0.0 - gap)));
            DomView::onStrut(&st, above, below);
            EVGElement::add_child(&row, Rc::clone(&st));
        }
        // boxes at the line's top (vertical-align: top) and none on the
        // baseline: the baseline's text is at the top as well, the line as
        // tall as the tallest box
        let mut top_mode: bool = false;
        if !by_base {
            let mut any_top: bool = false;
            let mut any_base: bool = false;
            for tb in line.iter().cloned() {
                if !DomView::textual(&tb) {
                    if tb.borrow().align_self == "flex-start" {
                        any_top = true;
                    }
                    if tb.borrow().align_self.is_empty() && DomText::index_of(&tb.borrow().class_name, "mfd-br") < 0 {
                        any_base = true;
                    }
                }
            }
            if any_top && !any_base {
                top_mode = true;
                EVGElement::set_attribute(&row, "align-items", "flex-start".to_string());
            }
        }
        // right to left the line runs from the right: its items in the
        // other order, an item's missing space before it on its right
        let rtl: bool = inh.borrow().getText("direction") == "rtl";
        let __n_i = line.len() as i64;
        for i in 0..__n_i {
            let it = Rc::clone(&line[i as usize]);
            // (the white space before a line break is not kept either)
            let br_here: bool = DomText::index_of(&it.borrow().class_name, "mfd-br") >= 0;
            if i > 0 && (!(line_sp[i as usize]) || br_here) {
                if rtl {
                    let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().margin_right.clone()) - gap));
                    EVGElement::set_attribute(&it, "margin-right", _tmp_1);
                } else {
                    let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().margin_left.clone()) - gap));
                    EVGElement::set_attribute(&it, "margin-left", _tmp_1);
                    EVGElement::set_attribute(&it, "line-join", "true".to_string());
                }
            }
            if br_here && by_base {
                // on the baseline as the line's text is: its bottom the
                // font's descent under it, whatever the line-height (a
                // break's box is the font's content area; EVG takes an empty
                // box's margin bottom)
                let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) - br_desc));
                EVGElement::set_attribute(&it, "margin-bottom", _tmp_1);
            }
            if it.borrow().tag_name == "svg" || !it.borrow().svg_source.is_empty() {
                if it.borrow().align_self.is_empty() && !by_base {
                    let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) + desc));
                    EVGElement::set_attribute(&it, "margin-bottom", _tmp_1);
                }
            } else {
                if DomView::textual(&it) {
                    has_text = true;
                    DomView::onStrut(&it, above, below);
                    // a word does not break: it overflows a line too narrow
                    let tw: String = DomView::trimmed(&it.borrow().text_content.clone());
                    if !tw.is_empty() && DomText::index_of(&tw, " ") < 0 {
                        EVGElement::set_attribute(&it, "flex-shrink", "0".to_string());
                    }
                } else {
                    if it.borrow().align_self.is_empty() && !by_base {
                        // (a grid's baseline is its first item's, which is
                        // not known here; a flex row with no text in it has
                        // its first item's bottom, synthesized, as a box's)
                        let own_lines: bool = it.borrow().display == "grid";
                        let br: bool = DomText::index_of(&it.borrow().class_name, "mfd-br") >= 0;
                        // (a break on a line of boxes and no text that is
                        // lower than the font: on the boxes' bottoms, the
                        // baseline, by the font's descent)
                        let br_low: bool = (br && !top_mode) && (!line_text_1 && (above < 0.0 || below < 0.0));
                        if br_low {
                            // (its line-height adds nothing to the line: its
                            // margins take its height back)
                            let br_asc: f64 = ((br_fs * DomView::ascentEm(&DomView::faceOf(&inh.borrow().getText("font-family"), "")[0].clone()) + 0.5).floor() as i64) as f64;
                            EVGElement::set_attribute(&it, "align-self", "flex-end".to_string());
                            EVGElement::set_attribute(
                                &it,
                                "margin-bottom",
                                format!("{}px", DomView::fmt(0.0 - br_desc))
                            );
                            EVGElement::set_attribute(
                                &it,
                                "margin-top",
                                format!("{}px", DomView::fmt(0.0 - br_asc))
                            );
                        }
                        if !br_low {
                            if DomView::hasText(&it) || (own_lines || br) {
                                if !(br && top_mode) {
                                    EVGElement::set_attribute(&it, "align-self", "center".to_string());
                                }
                            } else {
                                // a box with no line in it (a picture, an empty
                                // inline-block) has its baseline at its bottom
                                let mut under: f64 = desc;
                                // (a line-height under the font's: the
                                // baseline is the line's bottom)
                                if DomText::index_of(&it.borrow().class_name, "mfd-button") >= 0 {
                                    under = (under - DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().padding_bottom.clone())) - DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().border_width.clone());
                                }
                                if under < 0.0 {
                                    under = 0.0;
                                }
                                // (a flex row's is its first item's bottom,
                                // inside its padding, border and margin)
                                if it.borrow().flex_direction == "row" && !it.borrow().children.is_empty() {
                                    under = ((desc - DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().padding_bottom.clone())) - DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().border_width.clone())) - DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone());
                                    if under < 0.0 {
                                        under = 0.0;
                                    }
                                }
                                let _tmp_1 = format!("{}px", DomView::fmt(DomView::mPx(it.borrow().r#box.as_ref().unwrap().borrow().margin_bottom.clone()) + under));
                                EVGElement::set_attribute(&it, "margin-bottom", _tmp_1);
                            }
                        }
                    }
                    // an inline box keeps its size on a line that overflows
                    EVGElement::set_attribute(&it, "flex-shrink", "0".to_string());
                }
            }
            EVGElement::add_child(&row, Rc::clone(&it));
            // (the row's strut is on its first line only: a box that wraps
            // takes one to its line, after it, where no break comes)
            if by_base && !DomView::textual(&it) {
                let st2: Rc<RefCell<EVGElement>> = self.textEl("x".to_string(),
                    inh,
                    String::new()
                );
                EVGElement::set_attribute(&st2, "width", "0px".to_string());
                EVGElement::set_attribute(&st2, "white-space", "nowrap".to_string());
                EVGElement::set_attribute(&st2, "opacity", "0".to_string());
                EVGElement::set_attribute(&st2, "flex-shrink", "0".to_string());
                // (taken back on its left: it sits at the box's end, and a
                // scroll container does not reach a gap past the last box)
                EVGElement::set_attribute(
                    &st2,
                    "margin-left",
                    format!("{}px", DomView::fmt(0.0 - gap))
                );
                DomView::onStrut(&st2, above, below);
                EVGElement::add_child(&row, Rc::clone(&st2));
            }
        }
        if !has_text {
            // (a line-height under the font's leaves the strut above the
            // baseline, which is the boxes' bottom: the line reaches it)
            EVGElement::set_attribute(&row, "min-height", format!("{}px", DomView::fmt(DomView::lineHeight(inh))));
            let wm_s: String = inh.borrow().getText("writing-mode");
            let horiz_s: bool = wm_s.is_empty() || wm_s == "horizontal-tb";
            if ((!by_base && !top_mode) && horiz_s) && (below < 0.0 && above > 0.0) {
                let sp0: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                EVGElement::set_attribute(&sp0, "width", "0px".to_string());
                EVGElement::set_attribute(&sp0, "height", format!("{}px", DomView::fmt(above)));
                EVGElement::set_attribute(&sp0, "flex-shrink", "0".to_string());
                EVGElement::set_attribute(
                    &sp0,
                    "margin-right",
                    format!("{}px", DomView::fmt(0.0 - gap))
                );
                let mut with_sp: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
                with_sp.push(Rc::clone(&sp0));
                let __it_sc0 = row.borrow().children.clone();
                for sc0 in __it_sc0.iter().cloned() {
                    with_sp.push(Rc::clone(&sc0));
                }
                row.borrow_mut().children = with_sp.clone();
            }
            // (and its baseline is the strut's: an invisible one first)
            // (a line-height under the font's: the baseline is the boxes'
            // bottoms, the line's)
            // (a font of no size has no strut: the baseline is at the line's
            // bottom, or at its top when its boxes are there)
            let no_strut: bool = above <= 0.0 && below <= 0.0;
            if (!by_base && !top_mode) && ((above < 0.0 || below < 0.0) || no_strut) {
                EVGElement::set_attribute(&row, "baseline-from-bottom", "0".to_string());
            }
            if !by_base && (top_mode && above >= 0.0) {
                EVGElement::set_attribute(&row, "baseline-from-top", DomView::fmt(above));
            }
            if (!by_base && !top_mode) && ((above >= 0.0 && below >= 0.0) && !no_strut) {
                let st3: Rc<RefCell<EVGElement>> = self.textEl("x".to_string(),
                    inh,
                    String::new()
                );
                EVGElement::set_attribute(&st3, "width", "0px".to_string());
                EVGElement::set_attribute(&st3, "white-space", "nowrap".to_string());
                EVGElement::set_attribute(&st3, "opacity", "0".to_string());
                EVGElement::set_attribute(&st3, "flex-shrink", "0".to_string());
                EVGElement::set_attribute(
                    &st3,
                    "margin-right",
                    format!("{}px", DomView::fmt(0.0 - gap))
                );
                DomView::onStrut(&st3, above, below);
                let mut with_strut: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
                with_strut.push(Rc::clone(&st3));
                let __it_rc = row.borrow().children.clone();
                for rc in __it_rc.iter().cloned() {
                    with_strut.push(Rc::clone(&rc));
                }
                row.borrow_mut().children = with_strut.clone();
            }
        }
        if rtl {
            EVGElement::set_attribute(&row, "direction", "ltr".to_string());
            let mut rv: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
            let mut rk: i64 = (row.borrow().children.len() as i64) - 1;
            while rk >= 0 {
                rv.push(Rc::clone(&row.borrow().children[rk as usize]));
                rk -= 1;
            }
            row.borrow_mut().children = rv.clone();
        }
        DomView::trimEnds(&row);
        EVGElement::add_child(&e, Rc::clone(&row));
    }
    /// a child into the block's list of what is on its lines: an inline
    /// element with no box of its own (no padding, border, margin,
    /// background) and something other than text in it is replaced by its
    /// children, with what it hands down to them; a click on its text goes to
    /// it (id)
    /// whether a flattened item is text in a run that does not wrap (0),
    /// text that may wrap or a box that ends the run (1), or neither (2)
    pub fn nowrapItem(&self, n: &Rc<RefCell<JsonValue>>, inh: &Rc<RefCell<JsonValue>>) -> i64 {
        if self.isText(n) {
            let mut ws: String = inh.borrow().getText("white-space");
            if !n.borrow().has("x") {
                let own: String = n.borrow().get("s").borrow().getText("white-space");
                if !own.is_empty() {
                    ws = own.clone();
                }
            }
            if ws == "nowrap" {
                return 0;
            }
            return 1;
        }
        let d: String = DomView::displayOf(n);
        if n.borrow().getText("t") == "br" {
            return 1;
        }
        let pos: String = n.borrow().get("s").borrow().getText("position");
        if pos == "absolute" || pos == "fixed" {
            return 2;
        }
        let fl: String = n.borrow().get("s").borrow().getText("float");
        if fl == "left" || fl == "right" {
            return 2;
        }
        if d == "inline" || (d == "inline-block" || (d == "inline-flex" || (d == "inline-grid" || d == "inline-table"))) {
            if inh.borrow().getText("white-space") == "nowrap" {
                return 0;
            }
            return 1;
        }
        return 1;
    }
    /// the order of a block's flattened items, a float after text in a
    /// run that does not wrap moved to the end of that run
    pub fn nowrapFloats(&self, flat: &Vec<Rc<RefCell<JsonValue>>>, finh: &Vec<Rc<RefCell<JsonValue>>>) -> Vec<i64> {
        let mut ord: Vec<i64> = Vec::new();
        let total: i64 = flat.len() as i64;
        for i in 0..total {
            ord.push(i);
        }
        let mut k: i64 = 0;
        while k < total {
            let n: Rc<RefCell<JsonValue>> = flat[ord[k as usize] as usize].clone();
            let fl: String = n.borrow().get("s").borrow().getText("float");
            let pos: String = n.borrow().get("s").borrow().getText("position");
            let ws: String = finh[ord[k as usize] as usize].borrow().getText("white-space");
            if self.isText(&n) || ((fl != "left" && fl != "right") || (pos == "absolute" || (pos == "fixed" || ws != "nowrap"))) {
                k += 1;
                continue;
            }
            // (text of the run before it)
            let mut before: bool = false;
            let mut b: i64 = k - 1;
            while b >= 0 {
                let bn: Rc<RefCell<JsonValue>> = flat[ord[b as usize] as usize].clone();
                let kind: i64 = self.nowrapItem(&bn, &finh[ord[b as usize] as usize]);
                if kind == 1 {
                    break;
                }
                if kind == 0 && (!bn.borrow().has("x") || (DomView::trimmed(&self.textOf(&bn)).as_bytes().len() as i64) > 0) {
                    before = true;
                }
                b -= 1;
            }
            let mut to: i64 = k + 1;
            while before && to < total {
                let kind: i64 = self.nowrapItem(&flat[ord[to as usize] as usize], &finh[ord[to as usize] as usize]);
                if kind == 1 {
                    break;
                }
                to += 1;
            }
            if !before || to == k + 1 {
                k += 1;
                continue;
            }
            let mut no: Vec<i64> = Vec::new();
            for j in 0..total {
                if j != k {
                    no.push(ord[j as usize]);
                }
                if j == to - 1 {
                    no.push(ord[k as usize]);
                }
            }
            ord = no.clone();
            // (the items that were after it are looked at again)
        }
        return ord;
    }
    pub fn flatten(&mut self, c: Rc<RefCell<JsonValue>>, inh: Rc<RefCell<JsonValue>>, id: &str) {
        if (!c.borrow().has("x") && !self.isText(&c)) && self.wrapper(&c) {
            let cinh: Rc<RefCell<JsonValue>> = self.inherit(&inh,
                &c.borrow().get("s")
            );
            let cid: String = format!("{}{}", self.pfx, c.borrow().getText("i"));
            let kids: Rc<RefCell<JsonValue>> = c.borrow().get("c");
            let __it_g = kids.borrow().items.clone();
            for g in __it_g.iter().cloned() {
                self.flatten(g.clone(), cinh.clone(), &cid);
            }
            return;
        }
        self.fNodes.push(c.clone());
        self.fInh.push(inh.clone());
        self.fIds.push(id.to_string());
    }
    pub fn wrapper(&self, c: &Rc<RefCell<JsonValue>>) -> bool {
        if DomView::displayOf(c) != "inline" {
            return false;
        }
        if c.borrow().has("svg") {
            return false;
        }
        let t: String = c.borrow().getText("t");
        if t == "a" || (t == "button" || (t == "img" || (t == "br" || (t == "input" || (t == "textarea" || t == "select"))))) {
            return false;
        }
        let a: Rc<RefCell<JsonValue>> = c.borrow().get("a");
        if a.borrow().getText("role") == "button" {
            return false;
        }
        let s: Rc<RefCell<JsonValue>> = c.borrow().get("s");
        let pos: String = s.borrow().getText("position");
        if pos == "absolute" || (pos == "fixed" || pos == "relative") {
            return false;
        }
        // (one placed off the baseline is a box of its own in the line)
        let va: String = s.borrow().getText("vertical-align");
        if !va.is_empty() && va != "baseline" {
            return false;
        }
        let __n_i = s.borrow().keys.len() as i64;
        for i in 0..__n_i {
            let k = s.borrow().keys[i as usize].clone();
            if DomView::has(&k, "padding-") || (DomView::has(&k, "margin-") || (DomView::has(&k, "background") || (k == "opacity" || k == "transform"))) {
                if DomView::pxOf(&s.borrow().getText(&k)) != 0.0 {
                    return false;
                }
                if DomView::has(&k, "background") || (k == "opacity" || k == "transform") {
                    return false;
                }
            }
            if DomView::has(&k, "border-") && DomText::index_of(&k, "-style") > 0 {
                if s.borrow().getText(&k) != "none" {
                    return false;
                }
            }
        }
        true
    }
    /// --- inline formatting ------------------------------------------------------
    ///
    /// EVG draws a text element in one style. A run of text whose pieces look
    /// different (`for <span class=accent>Aino</span> to`) is drawn as a text
    /// element per word in a wrapping row, which breaks lines where the words
    /// do; a word whose pieces differ (`<b>Aino</b>,`) is a row of its pieces
    /// that does not break. The space between words is the row's gap, so
    /// the space at the end of a line takes no room, as in CSS. On a line
    /// with inline boxes the words are the line's own items (flush).
    /// the pieces of a text node or an inline element, into segs
    pub fn segments(&mut self, n: &Rc<RefCell<JsonValue>>, inh: Rc<RefCell<JsonValue>>, id: String) {
        if n.borrow().has("x") {
            let sg: Rc<RefCell<DomSeg>> = Rc::new(RefCell::new(DomSeg::new()));
            sg.borrow_mut().text = n.borrow().getText("x");
            sg.borrow_mut().inh = inh.clone();
            sg.borrow_mut().id = id.clone();
            self.segs.push(sg.clone());
            return;
        }
        let kinh: Rc<RefCell<JsonValue>> = self.inherit(&inh,
            &n.borrow().get("s")
        );
        let kid: String = format!("{}{}", self.pfx, n.borrow().getText("i"));
        // (an inline with a background, borders or padding: its pieces
        // carry them, drawn by deco)
        let ns: Rc<RefCell<JsonValue>> = n.borrow().get("s");
        if DomView::decorated(&ns, kinh.borrow().getText("direction") == "rtl") {
            DomView::putDeco(&kinh, &ns, &kid);
        }
        let kids: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        let __it_k = kids.borrow().items.clone();
        for k in __it_k.iter().cloned() {
            self.segments(&k, kinh.clone(), kid.clone());
        }
    }
    /// a piece is drawn unlike its block
    pub fn rich(&self, inh: &Rc<RefCell<JsonValue>>) -> bool {
        let __it_sg = self.segs.clone();
        for sg in __it_sg.iter().cloned() {
            if (sg.borrow().inh).borrow().has("_deco_id") {
                return true;
            }
            let __v_j: Vec<String> = vec!["color".to_string(), "font-family".to_string(), "font-weight".to_string(), "font-size".to_string(), "font-style".to_string(), "letter-spacing".to_string(), "line-height".to_string(), "_tdeco".to_string()];
            let __n_j = __v_j.len() as i64;
            for j in 0..__n_j {
                let k = __v_j[j as usize].clone();
                if (sg.borrow().inh).borrow().getText(&k) != inh.borrow().getText(&k) {
                    return true;
                }
            }
        }
        false
    }
    /// a piece has a line-height of its own
    pub fn lhMixed(&self, inh: &Rc<RefCell<JsonValue>>) -> bool {
        let __it_sg = self.segs.clone();
        for sg in __it_sg.iter().cloned() {
            if (sg.borrow().inh).borrow().getText("line-height") != inh.borrow().getText("line-height") {
                return true;
            }
        }
        false
    }
    /// the run's words: what is between its white space
    fn words(&self, rtl_tail: bool) -> Vec<Rc<RefCell<EVGElement>>> {
        let mut out: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut out_segs: Vec<Vec<i64>> = Vec::new();
        let mut ptext: Vec<String> = Vec::new();
        let mut pseg: Vec<i64> = Vec::new();
        let mut cur: String = String::new();
        let mut cur_seg: i64 = 0 - 1;
        // (a space in text that does not wrap keeps the words around it
        // one piece: no line breaks there)
        let mut nb_space: bool = false;
        let __n_j = self.segs.len() as i64;
        for j in 0..__n_j {
            let sg = self.segs[j as usize].clone();
            let t: String = sg.borrow().text.clone();
            let n: i64 = t.as_bytes().len() as i64;
            let seg_nowrap: bool = sg.borrow().inh.borrow().getText("white-space") == "nowrap";
            let mut i: i64 = 0;
            while i < n {
                let c: i64 = (t.as_bytes()[i as usize] as i64);
                if DomView::white(c) && seg_nowrap && (!cur.is_empty() || !ptext.is_empty()) {
                    nb_space = true;
                    i += 1;
                    continue;
                }
                if DomView::white(c) {
                    nb_space = false;
                    // the word before is done
                    if !cur.is_empty() {
                        ptext.push(cur.clone());
                        pseg.push(cur_seg);
                        cur = String::new();
                    }
                    if !ptext.is_empty() {
                        out.push(self.word(&ptext, &pseg));
                        out_segs.push(pseg.to_vec());
                        ptext.clear();
                        pseg.clear();
                    }
                } else {
                    if nb_space {
                        cur = format!("{} ", cur);
                        nb_space = false;
                    }
                    if j != cur_seg && !cur.is_empty() {
                        ptext.push(cur.clone());
                        pseg.push(cur_seg);
                        cur = String::new();
                    }
                    cur_seg = j;
                    cur = format!("{}{}", cur, DomText::unit_at(&t, i));
                }
                i += 1;
            }
        }
        if !cur.is_empty() {
            ptext.push(cur.clone());
            pseg.push(cur_seg);
        }
        // (bidi, UAX 9 N1/N2: in a right-to-left block, neutral punctuation
        // that ends a run of only left-to-right letters takes the block's
        // direction and goes to the run's left)
        let mut tail: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        if rtl_tail && (!ptext.is_empty() && self.asciiLetters()) {
            let li: i64 = (ptext.len() as i64) - 1;
            let lt: String = ptext[li as usize].clone();
            let ln: i64 = lt.as_bytes().len() as i64;
            let mut k: i64 = ln;
            while k > 0 && DomView::neutralByte(lt.as_bytes()[(k - 1) as usize] as i64) {
                k -= 1;
            }
            if k < ln && (k > 0 || li > 0) {
                let punct: String = lt[(k) as usize..(ln) as usize].to_string();
                let tsg: Rc<RefCell<DomSeg>> = self.segs[(pseg[li as usize]) as usize].clone();
                let tinh: Rc<RefCell<JsonValue>> = tsg.borrow().inh.clone();
                let te: Rc<RefCell<EVGElement>> = self.textEl(punct.clone(), &tinh, tsg.borrow().id.clone());
                let sw: f64 = DomView::spaceWidth(&tinh);
                EVGElement::set_attribute(&te, "margin-right", format!("{}px", DomView::fmt(0.0 - sw)));
                tail.push(te);
                if k == 0 {
                    let mut kt: Vec<String> = Vec::new();
                    let mut ks: Vec<i64> = Vec::new();
                    let mut q: i64 = 0;
                    while q < li {
                        kt.push(ptext[q as usize].clone());
                        ks.push(pseg[q as usize]);
                        q += 1;
                    }
                    ptext = kt;
                    pseg = ks;
                } else {
                    ptext[li as usize] = lt[(0) as usize..(k) as usize].to_string();
                }
            }
        }
        if !ptext.is_empty() {
            out.push(self.word(&ptext, &pseg));
                        out_segs.push(pseg.to_vec());
        }
        // (the boxes of decorated inlines on their pieces)
        let mut pieces: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut pinh: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
        let mut pgap: Vec<bool> = Vec::new();
        let mut any_deco: bool = false;
        // (where each piece is: a word of the run, or a piece of one)
        let mut ploc_o: Vec<i64> = Vec::new();
        let mut ploc_k: Vec<i64> = Vec::new();
        let __n_ow = out.len() as i64;
        for ow in 0..__n_ow {
            let wsg: Vec<i64> = out_segs[ow as usize].clone();
            let we: Rc<RefCell<EVGElement>> = out[ow as usize].clone();
            if (wsg.len() as i64) == 1 {
                pieces.push(we.clone());
                ploc_o.push(ow);
                ploc_k.push(-1);
                pgap.push(ow < __n_ow - 1);
                let wi: Rc<RefCell<JsonValue>> = self.segs[(wsg[0]) as usize].clone().borrow().inh.clone();
                if wi.borrow().has("_deco_id") {
                    any_deco = true;
                }
                pinh.push(wi);
            } else {
                let wk: Vec<Rc<RefCell<EVGElement>>> = we.borrow().children.clone();
                let __n_pk = wk.len() as i64;
                for pk in 0..__n_pk {
                    if pk < (wsg.len() as i64) {
                        pieces.push(wk[pk as usize].clone());
                        ploc_o.push(ow);
                        ploc_k.push(pk);
                        pgap.push(pk == __n_pk - 1 && ow < __n_ow - 1);
                        let pi: Rc<RefCell<JsonValue>> = self.segs[(wsg[pk as usize]) as usize].clone().borrow().inh.clone();
                        if pi.borrow().has("_deco_id") {
                            any_deco = true;
                        }
                        pinh.push(pi);
                    }
                }
            }
        }
        // (a text-decoration goes on across the space to the next word
        // its lines also reach)
        let __n_tp = pieces.len() as i64;
        for tp in 0..__n_tp {
            let tdv: String = pinh[tp as usize].clone().borrow().getText("_tdeco");
            if !tdv.is_empty() && pgap[tp as usize] && tp + 1 < __n_tp && pinh[(tp + 1) as usize].clone().borrow().getText("_tdeco") == tdv {
                let tgw: f64 = DomView::spaceWidth(&pinh[tp as usize].clone());
                EVGElement::set_attribute(&pieces[tp as usize].clone(), "text-decoration-extend", format!("{}px", DomView::fmt(tgw)));
            }
        }
        if any_deco {
            self.deco(&pieces, &pinh, &pgap, "_deco_");
            // (an inline decorated inside another: the other's box on a
            // wrapper around each piece)
            let mut any2: bool = false;
            let __it_p2 = pinh.clone();
            for p2 in __it_p2.iter().cloned() {
                if !p2.borrow().getText("_deco2_id").is_empty() {
                    any2 = true;
                }
            }
            if any2 {
                let mut wraps: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
                let __n_q = pieces.len() as i64;
                for q in 0..__n_q {
                    let pe: Rc<RefCell<EVGElement>> = pieces[q as usize].clone();
                    if pinh[q as usize].clone().borrow().getText("_deco2_id").is_empty() {
                        wraps.push(pe.clone());
                        continue;
                    }
                    let w: Rc<RefCell<EVGElement>> = EVGElement::create_div();
                    EVGElement::set_attribute(&w, "display", "flex".to_string());
                    EVGElement::set_attribute(&w, "flex-direction", "row".to_string());
                    EVGElement::set_attribute(&w, "flex-wrap", "nowrap".to_string());
                    EVGElement::set_attribute(&w, "align-items", "flex-end".to_string());
                    let qo: i64 = ploc_o[q as usize];
                    let qk: i64 = ploc_k[q as usize];
                    if qk < 0 {
                        out[qo as usize] = w.clone();
                    } else {
                        let qw: Rc<RefCell<EVGElement>> = out[qo as usize].clone();
                        let mut qkids: Vec<Rc<RefCell<EVGElement>>> = qw.borrow().children.clone();
                        qkids[qk as usize] = w.clone();
                        qw.borrow_mut().children = qkids.clone();
                    }
                    EVGElement::add_child(&w, Rc::clone(&pe));
                    wraps.push(w.clone());
                }
                self.deco(&wraps, &pinh, &pgap, "_deco2_");
            }
        }
        if !tail.is_empty() {
            let __it_o = out.clone();
            for o in __it_o.iter().cloned() {
                tail.push(Rc::clone(&o));
            }
            return tail;
        }
        out
    }
    /// a grid's items in paint order by their z-index (negative under the
    /// rest, then auto and 0, then positive), when every in-flow item is
    /// placed by lines, so moving them does not move them in the grid
    /// a grid's items in their order-modified document order: by order,
    /// tree order among equals
    fn gridOrder(e: &Rc<RefCell<EVGElement>>) {
        let kids: Vec<Rc<RefCell<EVGElement>>> = e.borrow().children.clone();
        let mut os: Vec<i64> = Vec::new();
        let mut any: bool = false;
        for k in kids.iter().cloned() {
            let cn: String = k.borrow().class_name.clone();
            let at: i64 = DomText::index_of(&cn, " mfd-o");
            let mut o: i64 = 0;
            if at >= 0 {
                let rest: String = cn[(at + 6) as usize..(cn.as_bytes().len() as i64) as usize].to_string();
                let sp: i64 = DomText::index_of(&rest, " ");
                let mut num: String = rest.clone();
                if sp >= 0 {
                    num = rest[(0) as usize..(sp) as usize].to_string();
                }
                let po: Option<i64> = num.parse::<i64>().ok();
                if po.is_some() {
                    o = po.unwrap();
                    any = true;
                }
            }
            os.push(o);
        }
        if !any {
            return;
        }
        let kn: i64 = kids.len() as i64;
        let mut out: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut used: Vec<bool> = Vec::new();
        let mut ui: i64 = 0;
        while ui < kn {
            used.push(false);
            ui += 1;
        }
        let mut placed: i64 = 0;
        while placed < kn {
            let mut best: i64 = -1;
            let mut j: i64 = 0;
            while j < kn {
                if !used[j as usize] && (best < 0 || os[j as usize] < os[best as usize]) {
                    best = j;
                }
                j += 1;
            }
            used[best as usize] = true;
            out.push(Rc::clone(&kids[best as usize]));
            placed += 1;
        }
        e.borrow_mut().children = out;
    }
    fn zOrder(e: &Rc<RefCell<EVGElement>>) {
        let kids: Vec<Rc<RefCell<EVGElement>>> = e.borrow().children.clone();
        let mut zs: Vec<i64> = Vec::new();
        let mut any: bool = false;
        for k in kids.iter().cloned() {
            let cn: String = k.borrow().class_name.clone();
            let at: i64 = DomText::index_of(&cn, " mfd-z");
            let mut z: i64 = 0;
            if at >= 0 {
                let rest: String = cn[(at + 6) as usize..(cn.as_bytes().len() as i64) as usize].to_string();
                let sp: i64 = DomText::index_of(&rest, " ");
                let mut num: String = rest.clone();
                if sp >= 0 {
                    num = rest[(0) as usize..(sp) as usize].to_string();
                }
                let pz: Option<i64> = num.parse::<i64>().ok();
                if pz.is_some() {
                    z = pz.unwrap();
                    any = true;
                }
            }
            if k.borrow().position != "absolute" && k.borrow().position != "fixed" {
                let gr: String = k.borrow().grid_row.clone();
                let gc: String = k.borrow().grid_column.clone();
                // (grid-area places it as well, an area's name or its lines)
                let ga: String = k.borrow().grid_area.clone();
                let by_area: bool = !ga.is_empty() && DomText::index_of(&ga, "auto") < 0;
                // (a line given at the start is a place: "1 / auto" spans one)
                let mut gr0: String = gr.clone();
                let mut gc0: String = gc.clone();
                let grs: i64 = DomText::index_of(&gr, "/");
                if grs >= 0 {
                    gr0 = gr[0..(grs as usize)].to_string().trim().to_string();
                }
                let gcs: i64 = DomText::index_of(&gc, "/");
                if gcs >= 0 {
                    gc0 = gc[0..(gcs as usize)].to_string().trim().to_string();
                }
                if !by_area && (gr0.is_empty() || (gc0.is_empty() || (DomText::index_of(&gr0, "auto") >= 0 || DomText::index_of(&gc0, "auto") >= 0 || gr0.starts_with("span") || gc0.starts_with("span")))) {
                    return;
                }
            }
            zs.push(z);
        }
        if !any {
            return;
        }
        // (a stable insertion sort: the tree order among equals)
        // (by each z there is, lowest first, tree order within one)
        let kn: i64 = kids.len() as i64;
        let mut out: Vec<Rc<RefCell<EVGElement>>> = Vec::new();
        let mut done: i64 = 0;
        let mut floor: i64 = 0;
        let mut first: bool = true;
        while done < kn {
            let mut lo: i64 = 0;
            let mut have: bool = false;
            let mut j: i64 = 0;
            while j < kn {
                let zj: i64 = zs[j as usize];
                if (first || zj > floor) && (!have || zj < lo) {
                    lo = zj;
                    have = true;
                }
                j += 1;
            }
            if !have {
                break;
            }
            let mut q: i64 = 0;
            while q < kn {
                if zs[q as usize] == lo {
                    out.push(Rc::clone(&kids[q as usize]));
                    done += 1;
                }
                q += 1;
            }
            floor = lo;
            first = false;
        }
        e.borrow_mut().children = out;
    }
    /// the run's text is left-to-right letters only (ASCII, some letter)
    fn asciiLetters(&self) -> bool {
        let mut letter: bool = false;
        let __it_sg = self.segs.clone();
        for sg in __it_sg.iter().cloned() {
            let t: String = sg.borrow().text.clone();
            let tn: i64 = t.as_bytes().len() as i64;
            let mut q: i64 = 0;
            while q < tn {
                let b: i64 = t.as_bytes()[q as usize] as i64;
                if b >= 128 {
                    return false;
                }
                if (b >= 65 && b <= 90) || (b >= 97 && b <= 122) {
                    letter = true;
                }
                q += 1;
            }
        }
        letter
    }
    /// a byte of neutral punctuation (UAX 9 class ON)
    pub fn neutralByte(c: i64) -> bool {
        c == 46 || (c == 44 || (c == 33 || (c == 63 || (c == 59 || (c == 58 || (c == 41 || c == 34))))))
    }
    /// a word of text that does not wrap and has no space in it: one line
    /// anyway, measured as a word (EVG keeps a nowrap text's box at its
    /// parent's width)
    fn wordWrapAttr(e: &Rc<RefCell<EVGElement>>, t: &str) {
        if e.borrow().white_space == "nowrap" && DomText::index_of(t, " ") < 0 {
            EVGElement::set_attribute(&e, "white-space", "normal".to_string());
        }
    }
    fn word(&self, ptext0: &[String], pseg0: &[i64]) -> Rc<RefCell<EVGElement>> {
        // (word-spacing widens a no-break space too, CSS Text 3 8.2: the
        // word is cut after each one, which then takes the spacing on its
        // right)
        let mut ptext: Vec<String> = Vec::new();
        let mut pseg: Vec<i64> = Vec::new();
        let mut nbsp_ws: Vec<f64> = Vec::new();
        let mut cut: bool = false;
        let __n_q = ptext0.len() as i64;
        for q in 0..__n_q {
            let pt = ptext0[q as usize].clone();
            let ws: f64 = DomView::pxOf(&self.segs[(pseg0[q as usize]) as usize].clone().borrow().inh.borrow().getText("word-spacing"));
            let pn: i64 = pt.as_bytes().len() as i64;
            let mut has_nb: bool = false;
            let mut b: i64 = 0;
            while b + 1 < pn {
                if (pt.as_bytes()[b as usize] as i64) == 194 && (pt.as_bytes()[(b + 1) as usize] as i64) == 160 {
                    has_nb = true;
                }
                b += 1;
            }
            if ws != 0.0 && has_nb {
                cut = true;
                let mut piece: String = String::new();
                let mut i: i64 = 0;
                while i < pn {
                    piece = format!("{}{}", piece, DomText::unit_at(&pt, i));
                    if i > 0 && (pt.as_bytes()[(i - 1) as usize] as i64) == 194 && (pt.as_bytes()[i as usize] as i64) == 160 {
                        ptext.push(piece.clone());
                        pseg.push(pseg0[q as usize]);
                        nbsp_ws.push(ws);
                        piece = String::new();
                    }
                    i += 1;
                }
                if !piece.is_empty() {
                    ptext.push(piece.clone());
                    pseg.push(pseg0[q as usize]);
                    nbsp_ws.push(0.0);
                }
            } else {
                ptext.push(pt);
                pseg.push(pseg0[q as usize]);
                nbsp_ws.push(0.0);
            }
        }
        // (a word with spaces kept from text that does not wrap: as wide
        // as its text, overflowing the line rather than shrunk)
        let mut kept: bool = false;
        let __n_kp = ptext.len() as i64;
        for kp in 0..__n_kp {
            if DomText::index_of(&ptext[kp as usize], " ") >= 0 || self.segs[(pseg[kp as usize]) as usize].clone().borrow().inh.borrow().getText("white-space") == "nowrap" {
                kept = true;
            }
        }
        if (ptext.len() as i64) == 1 && !cut {
            let sg: Rc<RefCell<DomSeg>> = self.segs[(pseg[0]) as usize].clone();
            let mut _tmp_1 = sg.borrow().inh.clone();
            let one: Rc<RefCell<EVGElement>> = self.textEl(ptext[0].clone(), &_tmp_1, sg.borrow().id.clone());
            DomView::wordWrapAttr(&one, &ptext[0]);
            if kept {
                EVGElement::set_attribute(&one, "flex-shrink", "0".to_string());
            }
            return one;
        }
        let row: Rc<RefCell<EVGElement>> = EVGElement::create_div();
        EVGElement::set_attribute(&row, "display", "flex".to_string());
        EVGElement::set_attribute(&row, "flex-direction", "row".to_string());
        EVGElement::set_attribute(&row, "flex-wrap", "nowrap".to_string());
        EVGElement::set_attribute(&row, "align-items", "flex-end".to_string());
        let lh0: String = self.segs[(pseg[0]) as usize].clone().borrow().inh.borrow().getText("line-height");
        let __n_k0 = ptext.len() as i64;
        for k0 in 0..__n_k0 {
            if self.segs[(pseg[k0 as usize]) as usize].clone().borrow().inh.borrow().getText("line-height") != lh0 {
                EVGElement::set_attribute(&row, "align-items", "baseline".to_string());
            }
        }
        let __n_k = ptext.len() as i64;
        for k in 0..__n_k {
            let pt = ptext[k as usize].clone();
            let sg2: Rc<RefCell<DomSeg>> = self.segs[(pseg[k as usize]) as usize].clone();
            let mut _tmp_1 = sg2.borrow().inh.clone();
            let mut _tmp_3 = self.textEl(pt.clone(), &_tmp_1, sg2.borrow().id.clone());
            DomView::wordWrapAttr(&_tmp_3, &pt);
            if kept {
                EVGElement::set_attribute(&_tmp_3, "flex-shrink", "0".to_string());
            }
            if nbsp_ws[k as usize] != 0.0 {
                EVGElement::set_attribute(&_tmp_3, "margin-right", format!("{}px", DomView::fmt(nbsp_ws[k as usize])));
            }
            EVGElement::add_child(&row, _tmp_3);
        }
        if kept {
            EVGElement::set_attribute(&row, "flex-shrink", "0".to_string());
        }
        row
    }
}
