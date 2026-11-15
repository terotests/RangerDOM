// SPDX-License-Identifier: MIT
//! DomPage: a host's side of a page that changes, frame by frame, with
//! everything RangerDOM's view does to make a frame cost what changed. Any
//! host (EVGBrowser, an SDL or Kotlin window, a WASM page) gives it the
//! render tree webapi.js sends (`__renderDelta()` after
//! `__deltaRender(true)`, or a whole `__render()`), lays out the element it
//! builds, and gives the page back the boxes:
//!
//! ```text
//! let p = DomPage::new();          p.setSize(w, h)
//! match p.take(json) {             -1: the page named a node this host
//!   -1 => ask "__renderDelta(1)",      does not have: ask for it whole
//!    0 => nothing changed,          0: the element and its layout stand
//!    _ => lay out p.view(),         1: a new element (kept parts inside)
//! }
//! let boxes = p.settle();          after the layout: "" or what changed,
//!                                  for __layout({"boxes": <boxes>})
//! ```
//!
//! What it keeps between frames: the delta page's nodes by their numbers
//! ({"r": n} names one kept), each node's style object while it holds the
//! same (its children were built under it), and DomView's memo (DomMemo):
//! the elements built for nodes that did not change, with their layout
//! (EVGElement.keepLayout). On pages where every box changes each frame
//! (an animation moving everything) noting elements costs more than it
//! saves, so after three such frames only mostly kept pages are noted.
//!
//! Fetched pictures (http, https) are the host's: `wanted()` lists those
//! the last build met without a size, `setImageSize` gives one (the page is
//! built again by `rebuild()`), and the picture is drawn by its URL.

use ranger::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::dom_view::{DomBoxes, DomSvgDocs, DomView};
use crate::rgr::EVGElement;
use rangerdom_json::{JsonParser, JsonValue};

pub struct DomPage {
    pub svgs: Rc<RefCell<DomSvgDocs>>,
    pub boxes: Rc<RefCell<DomBoxes>>,
    /// the viewport: the page's root box is w x h and scrolls itself
    pub w: f64,
    pub h: f64,
    /// off: nothing is kept from frame to frame (every frame is built and
    /// laid out from nothing; for checks)
    pub off: bool,
    /// the element the last build made (the viewport box), none before
    /// the first
    built: Option<Rc<RefCell<EVGElement>>>,
    /// the page the element was built from (a delta put together)
    page: Option<Rc<RefCell<JsonValue>>>,
    /// the text last taken: the same text again changes nothing
    lastJson: String,
    /// settle: whether a build or a layout happened since the last
    laid: bool,
    /// delta pages: the nodes by their numbers, the epoch they are of
    byN: HashMap<i64, Rc<RefCell<JsonValue>>>,
    epoch: i64,
    /// the nodes' style objects by node id, and their texts
    styleObj: HashMap<String, Rc<RefCell<JsonValue>>>,
    styleText: HashMap<String, String>,
    /// the nodes the last page sent (fresh), the most a page sent (total),
    /// how many numbered nodes the page held when last counted (live)
    fresh: i64,
    total: i64,
    live: i64,
    root: Option<Rc<RefCell<JsonValue>>>,
    /// noting elements: pages in a row the next page took (almost)
    /// nothing from, whether the last page was noted, the memo's counts
    unused: i64,
    noted: bool,
    hits0: i64,
    misses0: i64,
    /// the next build keeps nothing (a picture's size arrived)
    forget: bool,
    /// the size changed since the last build
    resized: bool,
}

impl DomPage {
    pub fn new() -> Self {
        let svgs: Rc<RefCell<DomSvgDocs>> = Rc::new(RefCell::new(DomSvgDocs::new()));
        Rc::clone(&svgs.borrow().memo).borrow_mut().on = true;
        Rc::clone(&svgs.borrow().memo).borrow_mut().keepLayout = true;
        Self {
            svgs: svgs,
            boxes: Rc::new(RefCell::new(DomBoxes::new())),
            w: 800.0,
            h: 600.0,
            off: false,
            built: None,
            page: None,
            lastJson: String::new(),
            laid: false,
            byN: HashMap::new(),
            epoch: -1,
            styleObj: HashMap::new(),
            styleText: HashMap::new(),
            fresh: 0,
            total: 0,
            live: 0,
            root: None,
            unused: 0,
            noted: false,
            hits0: 0,
            misses0: 0,
            forget: false,
            resized: false,
        }
    }
    /// the viewport's size; a new size builds the page again
    pub fn setSize(&mut self, w: f64, h: f64) {
        if w != self.w || h != self.h {
            self.w = w;
            self.h = h;
            self.lastJson = String::new();
            self.resized = true;
        }
    }
    /// whether there is an element to lay out
    pub fn hasView(&self) -> bool {
        self.built.is_some()
    }
    /// the element the last build made: the viewport box with the page in
    /// it (an empty box before the first build)
    #[doc(hidden)]
    pub fn view(&self) -> Rc<RefCell<EVGElement>> {
        if self.built.is_some() {
            return Rc::clone(self.built.as_ref().unwrap());
        }
        EVGElement::create_div()
    }
    /// a render tree from the page: -1 it names a node this host does not
    /// keep (ask for the page whole: `__renderDelta(1)`), 0 nothing to lay
    /// out again, 1 a new element to lay out (view)
    pub fn take(&mut self, json: String) -> i64 {
        if self.built.is_some() && json == self.lastJson {
            return 0;
        }
        let p: Rc<RefCell<JsonParser>> = JsonParser::parse(json.clone());
        let page: Rc<RefCell<JsonValue>> = p.borrow_mut().value();
        if page.borrow().kind != 5 {
            return 0;
        }
        if page.borrow().has("d") {
            let same: i64 = self.resolve(&page);
            if same < 0 {
                self.lastJson = String::new();
                return -1;
            }
            if same == 1 && self.built.is_some() && !self.forget && !self.resized {
                self.lastJson = json;
                return 0;
            }
        } else {
            // (a whole page: its nodes are new objects, nothing to take)
            self.byN = HashMap::new();
            self.root = None;
            Rc::clone(&self.svgs.borrow().memo).borrow_mut().on = false;
        }
        self.lastJson = json;
        self.page = Some(Rc::clone(&page));
        self.build();
        1
    }
    /// the page built again from what was taken last (a picture's size
    /// arrived): true when there is a page
    pub fn rebuild(&mut self) -> bool {
        if self.page.is_none() {
            return false;
        }
        self.forget = true;
        self.build();
        true
    }
    fn build(&mut self) {
        let page: Rc<RefCell<JsonValue>> = Rc::clone(self.page.as_ref().unwrap());
        if self.forget || self.off {
            Rc::clone(&self.svgs.borrow().memo).borrow_mut().on = false;
            self.forget = false;
        }
        self.resized = false;
        self.svgs.borrow_mut().frame();
        let b: Rc<RefCell<EVGElement>> = DomView::buildKept(&page, 0, self.w, self.h, Rc::clone(&self.svgs));
        self.built = Some(b);
        self.laid = true;
    }
    /// the host laid the view out again (its own reasons: a scroll, a
    /// picture): settle gives the boxes that moved
    pub fn laidOut(&mut self) {
        self.laid = true;
    }
    /// after the layout: the boxes that changed since the last settle, as
    /// webapi.js's __layout takes them ({"boxes": <this>}); "" when nothing
    /// was built or laid out since
    pub fn settle(&mut self) -> String {
        if !self.laid || self.built.is_none() {
            return String::new();
        }
        self.laid = false;
        let b: Rc<RefCell<EVGElement>> = Rc::clone(self.built.as_ref().unwrap());
        DomView::settle(&b);
        DomView::boxesSince(&b, 0, &self.boxes)
    }
    /// the pictures (http, https URLs) the last build met with no size
    pub fn wanted(&self) -> Vec<String> {
        self.svgs.borrow().wanted.clone()
    }
    /// a fetched picture's natural size (0 x 0: it failed, it is not
    /// drawn and not asked for again)
    pub fn setImageSize(&mut self, url: String, w: f64, h: f64) {
        let mut v: Vec<f64> = Vec::new();
        if w > 0.0 && h > 0.0 {
            v.push(w);
            v.push(h);
        }
        self.svgs.borrow_mut().sizes.insert(url, v);
    }
    /// the page's node of an id (none: not in the last page)
    pub fn node(&self, nodeId: &str) -> Option<Rc<RefCell<JsonValue>>> {
        if self.page.is_none() || nodeId.is_empty() {
            return None;
        }
        let root: Rc<RefCell<JsonValue>> = self.page.as_ref().unwrap().borrow().get("root");
        DomPage::findIn(&root, nodeId)
    }
    fn findIn(n: &Rc<RefCell<JsonValue>>, nodeId: &str) -> Option<Rc<RefCell<JsonValue>>> {
        if n.borrow().kind != 5 {
            return None;
        }
        if n.borrow().getText("i") == nodeId {
            return Some(Rc::clone(n));
        }
        let c: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let kids: Vec<Rc<RefCell<JsonValue>>> = c.borrow().items.clone();
            for k in kids.iter() {
                let f: Option<Rc<RefCell<JsonValue>>> = DomPage::findIn(k, nodeId);
                if f.is_some() {
                    return f;
                }
            }
        }
        None
    }
    /// a node's tag ("" for none)
    pub fn tagOf(&self, nodeId: &str) -> String {
        let n: Option<Rc<RefCell<JsonValue>>> = self.node(nodeId);
        if n.is_none() {
            return String::new();
        }
        n.unwrap().borrow().getText("t")
    }
    /// one of a node's attributes as the render tree has them (value: a
    /// field's text; href: a link's, resolved)
    pub fn attrOf(&self, nodeId: &str, name: &str) -> String {
        let n: Option<Rc<RefCell<JsonValue>>> = self.node(nodeId);
        if n.is_none() {
            return String::new();
        }
        n.unwrap().borrow().get("a").borrow().getText(name)
    }
    /// a text field the user types into: "text" (an input of a text kind),
    /// "textarea", else ""
    pub fn fieldKind(&self, nodeId: &str) -> String {
        let n: Option<Rc<RefCell<JsonValue>>> = self.node(nodeId);
        if n.is_none() {
            return String::new();
        }
        let nd: Rc<RefCell<JsonValue>> = n.unwrap();
        let t: String = nd.borrow().getText("t");
        if t == "textarea" {
            return "textarea".to_string();
        }
        if t != "input" {
            return String::new();
        }
        let ty: String = nd.borrow().get("a").borrow().getText("type").to_lowercase();
        if ty.is_empty() || ty == "text" || ty == "search" || ty == "url" || ty == "email" || ty == "tel" || ty == "number" {
            return "text".to_string();
        }
        String::new()
    }
    /// the link (an a element's href) the node is in, "" for none
    pub fn hrefAt(&self, nodeId: &str) -> String {
        if self.page.is_none() || nodeId.is_empty() {
            return String::new();
        }
        let root: Rc<RefCell<JsonValue>> = self.page.as_ref().unwrap().borrow().get("root");
        let mut found: Vec<String> = Vec::new();
        DomPage::hrefIn(&root, nodeId, "", &mut found);
        if found.is_empty() {
            return String::new();
        }
        found[0].clone()
    }
    fn hrefIn(n: &Rc<RefCell<JsonValue>>, nodeId: &str, href: &str, found: &mut Vec<String>) -> bool {
        if n.borrow().kind != 5 {
            return false;
        }
        let mut h: String = href.to_string();
        if n.borrow().getText("t") == "a" {
            let own: String = n.borrow().get("a").borrow().getText("href");
            if !own.is_empty() {
                h = own;
            }
        }
        if n.borrow().getText("i") == nodeId {
            found.push(h);
            return true;
        }
        let c: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let kids: Vec<Rc<RefCell<JsonValue>>> = c.borrow().items.clone();
            for k in kids.iter() {
                if DomPage::hrefIn(k, nodeId, &h, found) {
                    return true;
                }
            }
        }
        false
    }
    /// the id of the page's node an element id names ("" for none): hit
    /// tests give element ids, the page's input takes node ids
    pub fn nodeOf(id: &str) -> String {
        let pfx: String = "mfd-xd-0-".to_string();
        if !id.starts_with(&pfx) {
            return String::new();
        }
        let rest: String = id[(pfx.as_bytes().len()) as usize..(id.as_bytes().len()) as usize].to_string();
        let mut end: i64 = 0;
        let bs: Vec<u8> = rest.as_bytes().to_vec();
        while end < (bs.len() as i64) && bs[end as usize] >= 48 && bs[end as usize] <= 57 {
            end += 1;
        }
        rest[(0) as usize..(end) as usize].to_string()
    }
    /// a delta page put together: 1 its root is the last page's (nothing
    /// changed), 0 a changed page, -1 it names a node that is not kept
    fn resolve(&mut self, page: &Rc<RefCell<JsonValue>>) -> i64 {
        let epoch: i64 = page.borrow().getInt("d", 0);
        if epoch != self.epoch {
            self.byN = HashMap::new();
            self.styleObj = HashMap::new();
            self.styleText = HashMap::new();
            self.root = None;
            self.total = 0;
            self.live = 0;
            self.epoch = epoch;
        }
        self.fresh = 0;
        let root: Rc<RefCell<JsonValue>> = page.borrow().get("root");
        if root.borrow().kind != 5 {
            self.root = None;
            return 0;
        }
        let ro: Option<Rc<RefCell<JsonValue>>> = self.nodeOfPage(&root);
        if ro.is_none() {
            self.byN = HashMap::new();
            self.root = None;
            return -1;
        }
        let r: Rc<RefCell<JsonValue>> = ro.unwrap();
        let mut same: bool = false;
        if self.root.is_some() {
            same = Rc::ptr_eq(self.root.as_ref().unwrap(), &r);
        }
        self.root = Some(Rc::clone(&r));
        // the top layer's boxes come apart ("tops"): the page's root is a
        // copy of the kept one with them after its children
        let tops: Rc<RefCell<JsonValue>> = page.borrow().get("tops");
        if tops.borrow().kind == 4 && !tops.borrow().items.is_empty() {
            let copy: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
            let ks: Vec<String> = r.borrow().keys.clone();
            let vs: Vec<Rc<RefCell<JsonValue>>> = r.borrow().items.clone();
            copy.borrow_mut().keys = ks;
            copy.borrow_mut().items = vs;
            let kids: Rc<RefCell<JsonValue>> = JsonValue::mkArr();
            let c: Rc<RefCell<JsonValue>> = r.borrow().get("c");
            if c.borrow().kind == 4 {
                let ci: Vec<Rc<RefCell<JsonValue>>> = c.borrow().items.clone();
                kids.borrow_mut().items = ci;
            }
            let ti: Vec<Rc<RefCell<JsonValue>>> = tops.borrow().items.clone();
            for t in ti.iter().cloned() {
                kids.borrow_mut().items.push(t);
            }
            copy.borrow_mut().put("c", kids);
            page.borrow_mut().put("root", copy);
            page.borrow_mut().put("tops", JsonValue::mkNull());
            same = false;
        } else {
            page.borrow_mut().put("root", Rc::clone(&r));
        }
        // (the numbered nodes no longer in the page are let go, counted
        // again from the page once the list grew by an eighth)
        let held: i64 = self.byN.len() as i64;
        if self.fresh > 0 && held > self.live + self.live / 8 + 64 {
            let mut keep: HashMap<i64, Rc<RefCell<JsonValue>>> = HashMap::new();
            let mut ids: HashMap<String, bool> = HashMap::new();
            DomPage::collect(&r, &mut keep, &mut ids);
            if tops.borrow().kind == 4 {
                let ti2: Vec<Rc<RefCell<JsonValue>>> = tops.borrow().items.clone();
                for t in ti2.iter().cloned() {
                    DomPage::collect(&t, &mut keep, &mut ids);
                }
            }
            self.byN = keep;
            self.live = self.byN.len() as i64;
            let mut so: HashMap<String, Rc<RefCell<JsonValue>>> = HashMap::new();
            let mut st: HashMap<String, String> = HashMap::new();
            let sk: Vec<String> = self.styleObj.keys().cloned().collect::<Vec<String>>();
            for k in sk.iter().cloned() {
                if ids.contains_key(&k) {
                    so.insert(k.clone(), Rc::clone(self.styleObj.get(&k).unwrap()));
                    let tx: Option<String> = self.styleText.get(&k).cloned();
                    if tx.is_some() {
                        st.insert(k.clone(), tx.unwrap());
                    }
                }
            }
            self.styleObj = so;
            self.styleText = st;
        }
        if self.fresh > self.total {
            self.total = self.fresh;
        }
        // (elements are noted for a page that is mostly the last one)
        let on: bool = self.keeps(self.fresh * 4 < self.total);
        Rc::clone(&self.svgs.borrow().memo).borrow_mut().on = on;
        if same {
            return 1;
        }
        0
    }
    /// the numbered nodes and the ids under n, n too
    fn collect(n: &Rc<RefCell<JsonValue>>, keep: &mut HashMap<i64, Rc<RefCell<JsonValue>>>, ids: &mut HashMap<String, bool>) {
        if n.borrow().kind != 5 {
            return;
        }
        let num: i64 = n.borrow().getInt("n", -1);
        if num >= 0 {
            keep.insert(num, Rc::clone(n));
        }
        let id: String = n.borrow().getText("i");
        if !id.is_empty() {
            ids.insert(id, true);
        }
        let c: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let kids: Vec<Rc<RefCell<JsonValue>>> = c.borrow().items.clone();
            for k in kids.iter() {
                DomPage::collect(k, keep, ids);
            }
        }
    }
    /// the node ids under n, n too
    fn ids(n: &Rc<RefCell<JsonValue>>) -> i64 {
        if n.borrow().kind != 5 {
            return 0;
        }
        let mut count: i64 = 0;
        if n.borrow().keyAt("i") >= 0 {
            count = 1;
        }
        let c: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let kids: Vec<Rc<RefCell<JsonValue>>> = c.borrow().items.clone();
            for k in kids.iter() {
                count += DomPage::ids(k);
            }
        }
        count
    }
    /// the page's node for n: the kept node {"r": k} names, else n with its
    /// children put together (none: a name of a node not kept)
    fn nodeOfPage(&mut self, n: &Rc<RefCell<JsonValue>>) -> Option<Rc<RefCell<JsonValue>>> {
        if n.borrow().kind != 5 {
            return Some(Rc::clone(n));
        }
        if n.borrow().keys.len() == 1 && n.borrow().keys[0] == "r" {
            let k: i64 = n.borrow().getInt("r", -1);
            return self.byN.get(&k).cloned();
        }
        // (a node without a number was sent whole: nothing under it is
        // named or kept by itself)
        if n.borrow().keyAt("n") < 0 {
            self.fresh += DomPage::ids(n);
            return Some(Rc::clone(n));
        }
        let c: Rc<RefCell<JsonValue>> = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let kids: Vec<Rc<RefCell<JsonValue>>> = c.borrow().items.clone();
            let mut out: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
            for k in kids.iter() {
                let got: Option<Rc<RefCell<JsonValue>>> = self.nodeOfPage(k);
                if got.is_none() {
                    return None;
                }
                out.push(got.unwrap());
            }
            c.borrow_mut().items = out;
        }
        let id: String = n.borrow().getText("i");
        if !id.is_empty() {
            self.fresh += 1;
            // (a node sent again keeps its style object while that holds
            // the same: its children were built under it)
            let s: Rc<RefCell<JsonValue>> = n.borrow().get("s");
            if s.borrow().kind == 5 {
                let text: String = s.borrow().toJson();
                let was: Option<String> = self.styleText.get(&id).cloned();
                let mut keep: Rc<RefCell<JsonValue>> = Rc::clone(&s);
                if was.is_some() && was.unwrap() == text {
                    let old: Option<Rc<RefCell<JsonValue>>> = self.styleObj.get(&id).cloned();
                    if old.is_some() {
                        keep = old.unwrap();
                    }
                }
                if !Rc::ptr_eq(&keep, &s) {
                    n.borrow_mut().put("s", Rc::clone(&keep));
                }
                self.styleObj.insert(id.clone(), keep);
                self.styleText.insert(id.clone(), text);
            }
        }
        let num: i64 = n.borrow().getInt("n", -1);
        if num >= 0 {
            self.byN.insert(num, Rc::clone(n));
        }
        Some(Rc::clone(n))
    }
    /// whether this page's elements are noted: mostly is "the page is
    /// mostly the last one". Three noted pages in a row that the next page
    /// took (almost) nothing from: only mostly kept pages from there on
    fn keeps(&mut self, mostly: bool) -> bool {
        let memo = Rc::clone(&self.svgs.borrow().memo);
        let h: i64 = memo.borrow().hits;
        let m: i64 = memo.borrow().misses;
        if self.noted {
            let dh: i64 = h - self.hits0;
            let dm: i64 = m - self.misses0;
            // (a page of a few elements, a list emptied, tells nothing)
            if dh + dm >= 16 {
                if dh * 4 < dh + dm {
                    self.unused += 1;
                } else {
                    self.unused = 0;
                }
            }
        }
        self.hits0 = h;
        self.misses0 = m;
        let on: bool = !self.off && (mostly || self.unused < 3);
        self.noted = on;
        on
    }
}
