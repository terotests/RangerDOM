// SPDX-License-Identifier: MIT
//
// The playground's engine (playground/src/Playground.rgr's job) as a crate:
// one page in CEr with webapi.js, its render tree (__render()) laid out by
// EVG through RangerDOM's view, the boxes back to the page, the display list
// out as JSON. Built for wasm32-unknown-unknown, main.js calls the exported
// functions below; strings cross as UTF-8 in buffers the module allocates
// (pg_alloc), and an answer is read from pg_out_ptr / pg_out_len.

use std::rc::Rc;

use cer::Engine;
use ranger::cell::RefCell;
use std::collections::HashMap;

use rangerdom_json::{JsonParser, JsonValue};
use rangerdom_view::{DomSvgDocs, DomView};
use rangerevg::{EVGDisplayList, EVGElement, EVGLayout, EVGUnit};

// ---------------------------------------------------------------- text widths
// In the browser the page's text is measured by the browser (main.js
// `rangerdom.pg_measure`: a 2D canvas, the font the painter draws with), so
// a line breaks where Chromium breaks it whatever face the page's families
// resolve to there. DomView gives such a host the page's own family list
// (`fm: "measure"`); the vertical metrics stay the table's Arial, which
// DomView's line boxes assume. Natively (the example tools) the table
// measures.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "rangerdom")]
extern "C" {
    fn pg_measure(fp: *const u8, fl: usize, tp: *const u8, tl: usize, size: f64, bold: i32) -> f64;
}

#[cfg(target_arch = "wasm32")]
mod measure {
    use super::*;
    use rangerevg::{EVGTextMeasurer, EVGTextMeasurerTrait, EVGTextMetrics, RgAnyRef};

    pub struct BrowserMeasurer {
        inner: EVGTextMeasurer,
        widths: HashMap<String, f64>,
    }
    impl RgAnyRef for BrowserMeasurer {
        fn rg_as_any(&self) -> &dyn std::any::Any { self }
    }
    impl BrowserMeasurer {
        pub fn new() -> Self { BrowserMeasurer { inner: EVGTextMeasurer::new(), widths: HashMap::new() } }
        /// a family DomView named (a CSS list ending in "mfd", maybe with
        /// EVG's "-Bold"): the list and whether it is bold; None for a face
        /// of the table's own (Arial, Ahem, the monospace)
        fn split(family: &str) -> Option<(String, bool)> {
            let (f, bold) = match family.strip_suffix("-Bold") { Some(f) => (f, true), None => (family, false) };
            f.strip_suffix(", mfd").map(|l| (l.to_string(), bold))
        }
        fn width(&mut self, text: &str, family: &str, size: f64) -> f64 {
            let Some((list, bold)) = Self::split(family) else { return self.inner.measure_text_width(text.to_string(), family.to_string(), size) };
            if text.is_empty() { return 0.0 }
            let key = format!("{}|{}|{}|{}", list, size, bold as u8, text);
            if let Some(w) = self.widths.get(&key) { return *w }
            let w = unsafe { pg_measure(list.as_ptr(), list.len(), text.as_ptr(), text.len(), size, bold as i32) };
            if self.widths.len() > 60_000 { self.widths.clear() }
            self.widths.insert(key, w);
            w
        }
        /// the table's Arial for the vertical numbers
        fn table_face(family: &str) -> String {
            match Self::split(family) { Some((_, true)) => "Arial-Bold".to_string(), Some(_) => "Arial".to_string(), None => family.to_string() }
        }
    }
    impl EVGTextMeasurerTrait for BrowserMeasurer {
        fn rgf_adv_table(&self) -> &Vec<f64> { &self.inner.adv_table }
        fn rgf_adv_table_mut(&mut self) -> &mut Vec<f64> { &mut self.inner.adv_table }
        fn rgf_mono_table(&self) -> &Vec<f64> { &self.inner.mono_table }
        fn rgf_mono_table_mut(&mut self) -> &mut Vec<f64> { &mut self.inner.mono_table }
        fn rgf_latin_table(&self) -> &Vec<f64> { &self.inner.latin_table }
        fn rgf_latin_table_mut(&mut self) -> &mut Vec<f64> { &mut self.inner.latin_table }
        fn rgf_punct_table(&self) -> &Vec<f64> { &self.inner.punct_table }
        fn rgf_punct_table_mut(&mut self) -> &mut Vec<f64> { &mut self.inner.punct_table }
        fn rgf_tables_ready(&self) -> bool { self.inner.tables_ready }
        fn rgf_tables_ready_mut(&mut self) -> &mut bool { &mut self.inner.tables_ready }
        fn rgf_mono_family(&self) -> String { self.inner.mono_family.clone() }
        fn rgf_mono_family_mut(&mut self) -> &mut String { &mut self.inner.mono_family }
        fn rgf_mono_known(&self) -> bool { self.inner.mono_known }
        fn rgf_mono_known_mut(&mut self) -> &mut bool { &mut self.inner.mono_known }
        fn rgf_mono_cached(&self) -> bool { self.inner.mono_cached }
        fn rgf_mono_cached_mut(&mut self) -> &mut bool { &mut self.inner.mono_cached }
        fn rgf_bold_cached(&self) -> bool { self.inner.bold_cached }
        fn rgf_bold_cached_mut(&mut self) -> &mut bool { &mut self.inner.bold_cached }
        fn rgf_bold_table(&self) -> &Vec<f64> { &self.inner.bold_table }
        fn rgf_bold_table_mut(&mut self) -> &mut Vec<f64> { &mut self.inner.bold_table }
        fn rgf_bold_latin_table(&self) -> &Vec<f64> { &self.inner.bold_latin_table }
        fn rgf_bold_latin_table_mut(&mut self) -> &mut Vec<f64> { &mut self.inner.bold_latin_table }
        fn rgf_bold_punct_table(&self) -> &Vec<f64> { &self.inner.bold_punct_table }
        fn rgf_bold_punct_table_mut(&mut self) -> &mut Vec<f64> { &mut self.inner.bold_punct_table }
        fn is_font_accurate(&self) -> bool { self.inner.is_font_accurate() }
        fn has_face(&self, font_family: String) -> bool { Self::split(&font_family).is_some() || self.inner.has_face(font_family) }
        fn measure_key(&self) -> String { format!("browser|{}", EVGTextMeasurerTrait::measure_key(&self.inner)) }
        fn measure_text(&mut self, text: String, font_family: String, font_size: f64) -> Rc<RefCell<EVGTextMetrics>> {
            let m = EVGTextMeasurerTrait::measure_text(&mut self.inner, String::new(), Self::table_face(&font_family), font_size);
            let w = self.width(&text, &font_family, font_size);
            m.borrow_mut().width = w;
            m
        }
        fn measure_text_width(&mut self, text: String, font_family: String, font_size: f64) -> f64 { self.width(&text, &font_family, font_size) }
        fn get_line_height(&self, font_family: String, font_size: f64) -> f64 { EVGTextMeasurerTrait::get_line_height(&self.inner, Self::table_face(&font_family), font_size) }
        fn mono_for(&mut self, font_family: String) -> bool { if Self::split(&font_family).is_some() { false } else { EVGTextMeasurerTrait::mono_for(&mut self.inner, font_family) } }
        fn prepare_tables(&mut self) { EVGTextMeasurerTrait::prepare_tables(&mut self.inner) }
        fn measure_char(&mut self, ch: i64, font_family: String, font_size: f64) -> f64 {
            match char::from_u32(ch as u32) { Some(c) if Self::split(&font_family).is_some() => self.width(&c.to_string(), &font_family, font_size), _ => EVGTextMeasurerTrait::measure_char(&mut self.inner, ch, font_family, font_size) }
        }
        fn wrap_text(&mut self, text: String, font_family: String, font_size: f64, max_width: f64) -> Vec<String> {
            EVGTextMeasurerTrait::wrap_text(&mut self.inner, text, Self::table_face(&font_family), font_size, max_width)
        }
    }
    /// the browser measures from now on (EVG's default measurer)
    pub fn install() {
        let m: Rc<RefCell<dyn EVGTextMeasurerTrait>> = Rc::new(RefCell::new(BrowserMeasurer::new()));
        rangerevg::EVGDefaultMeasurer::install(m);
    }
}

const PRELUDE: &str = include_str!("../js/prelude.js");
const WEBAPI: &str = include_str!("../js/webapi.js");
const HOST: &str = include_str!("../js/host.js");

/// A string as a JavaScript string literal (DomRealm.quote).
fn quote(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\u{2028}' => o.push_str("\\u2028"),
            '\u{2029}' => o.push_str("\\u2029"),
            _ => o.push(c),
        }
    }
    o.push('"');
    o
}

pub struct Playground {
    engine: Engine,
    scripts: Vec<(String, String)>,
    /// compiled scripts by URL (CEr's unit text, pg_compile): a script that
    /// has one is read from it, not parsed and compiled
    units: Vec<(String, String)>,
    pub errors: Vec<String>,
    w: f64,
    h: f64,
    page_json: String,
    last_gen: String,
    root: Option<Rc<RefCell<EVGElement>>>,
    lay: Option<Rc<RefCell<EVGLayout>>>,
    synced: Rc<std::cell::RefCell<Synced>>,
}

impl Playground {
    pub fn new() -> Playground {
        // (CEr's register machine: its default is still the stack machine)
        let mut engine = Engine::new();
        engine.vm.regs = true;
        let synced = Rc::new(std::cell::RefCell::new(Synced { w: 800.0, h: 600.0, last: None, json: String::new(), boxes: String::new(), tree: None, kept: Kept::new() }));
        engine.vm.set_host_sync(Box::new(SyncLayout { s: synced.clone() }));
        Playground { engine: engine, scripts: Vec::new(), units: Vec::new(), errors: Vec::new(), w: 800.0, h: 600.0, page_json: String::new(), last_gen: String::new(), root: None, lay: None, synced: synced }
    }

    fn note(&mut self) -> String {
        let e = self.engine.error.clone();
        if !e.is_empty() && self.errors.len() < 50 {
            self.errors.push(e.clone());
        }
        e
    }
    /// runs a script; "" when it ran to its end, else the error
    pub fn exec(&mut self, src: &str) -> String {
        self.engine.eval(src);
        self.note()
    }
    /// `exec` of a script whose compiled unit may be known (by `key`: a
    /// URL, or rangerdom:<file> for js/); a unit of another CEr or another
    /// text does not read back, and the script is then compiled as usual
    fn exec_keyed(&mut self, key: &str, src: &str) -> String {
        let text = self.units.iter().find(|(k, _)| k == key).map(|(_, t)| t.clone())
            .or_else(|| CORE_UNITS.with(|c| c.borrow().iter().find(|(k, _)| k == key).map(|(_, t)| t.clone())));
        if let Some(t) = text {
            let u = cer::unit::decode(&t, src);
            if u.entry >= 0 {
                self.engine.run(u);
                return self.note();
            }
        }
        self.exec(src)
    }
    /// an expression's value as a string ("" on an error)
    pub fn value(&mut self, src: &str) -> String {
        let r = self.engine.eval(src);
        if self.note().is_empty() { r } else { String::new() }
    }

    pub fn add_script(&mut self, url: &str, text: &str) {
        self.scripts.push((url.to_string(), text.to_string()));
    }
    pub fn add_unit(&mut self, url: &str, text: &str) {
        if url.starts_with("rangerdom:") {
            CORE_UNITS.with(|c| {
                let mut c = c.borrow_mut();
                c.retain(|(k, _)| k != url);
                c.push((url.to_string(), text.to_string()));
            });
        } else {
            self.units.push((url.to_string(), text.to_string()));
        }
    }
    pub fn start(&mut self, html: &str, url: &str, w: f64, h: f64) {
        self.w = w;
        self.h = h;
        {
            let mut sy = self.synced.borrow_mut();
            sy.w = w;
            sy.h = h;
        }
        self.exec_keyed("rangerdom:prelude.js", PRELUDE);
        self.exec_keyed("rangerdom:webapi.js", WEBAPI);
        self.exec_keyed("rangerdom:host.js", HOST);
        self.exec(&format!("__page({}, {})", quote(html), quote(url)));
        self.exec(&format!("__layout({{viewport: [{}, {}]}})", w, h));
        self.exec("__installDefaults()");
        // sizes read after a change are laid out at once (SyncLayout)
        self.exec("__syncLayout(true)");
        // a render sends what changed since the last one (Kept::resolve)
        #[cfg(not(target_arch = "wasm32"))]
        let delta = std::env::var("PG_NODELTA").is_err();
        #[cfg(target_arch = "wasm32")]
        let delta = true;
        if delta {
            self.exec("__deltaRender(true)");
        }
        // PG_DELTACHECK: each delta comes with the whole page, and what the
        // host put together is compared with it (Synced::lay_out)
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("PG_DELTACHECK").is_ok() {
            self.exec("__deltaCheck(true)");
        }
        // its text is drawn by the browser (evg-webgl): the browser's faces
        // (the browser measures the text in WASM; the native tools measure
        // with the table)
        #[cfg(target_arch = "wasm32")]
        { measure::install(); self.exec("__browserFonts('measure')"); }
        #[cfg(not(target_arch = "wasm32"))]
        self.exec("__browserFonts(true)");
    }
    /// the page's scripts in a browser's order, DOMContentLoaded and load
    pub fn run_scripts(&mut self) {
        self.exec("var __rdScripts = JSON.parse(__scripts())");
        let n: usize = self.value("__rdScripts.length").trim().parse().unwrap_or(0);
        for i in 0..n {
            let at = format!("__rdScripts[{}]", i);
            let id = self.value(&format!("{}.id", at));
            let has_src = !self.value(&format!("({}.src !== null) ? 'y' : ''", at)).is_empty();
            let mut key = String::new();
            let src = if has_src {
                let u = self.value(&format!("{}.url", at));
                let t = self.scripts.iter().find(|(su, _)| *su == u).map(|(_, t)| t.clone()).unwrap_or_default();
                key = u;
                t
            } else {
                self.value(&format!("{}.text", at))
            };
            if !src.is_empty() {
                self.exec(&format!("__beginScript({})", id));
                let err = if key.is_empty() { self.exec(&src) } else { self.exec_keyed(&key, &src) };
                self.exec(&format!("__endScript({}, {})", id, if err.is_empty() { "true" } else { "false" }));
            }
        }
        self.exec("__loaded()");
        self.tick(0.0);
    }
    pub fn tick(&mut self, ms: f64) -> i64 {
        self.value(&format!("__tick({})", ms)).trim().parse::<f64>().map(|d| d as i64).unwrap_or(0)
    }
    pub fn due_in(&mut self) -> f64 {
        self.value("__dueIn()").trim().parse().unwrap_or(-1.0)
    }
    pub fn input(&mut self, json: &str) -> String {
        self.value(&format!("__input({})", quote(json)))
    }
    pub fn messages(&mut self) -> String {
        self.value("__drain()")
    }
    pub fn dirty(&mut self) -> bool {
        let g = self.value("__generation()");
        g != self.last_gen
    }
    /// the render tree (webapi.js's cascade and boxes) as JSON
    pub fn render(&mut self) -> String {
        self.last_gen = self.value("__generation()");
        self.page_json = self.value("__renderDelta()");
        self.page_json.clone()
    }
    /// EVG lays the last render out; the boxes go back to the page
    pub fn layout(&mut self) -> String {
        let mut laid = self.synced.borrow_mut().lay_out(&self.page_json);
        if laid.is_none() {
            // (the delta names a node this host does not have: the whole page)
            self.page_json = self.value("__renderDelta(1)");
            laid = self.synced.borrow_mut().lay_out(&self.page_json);
        }
        let Some((boxes, root, lay)) = laid else { return String::new() };
        self.exec(&format!("__layout({})", quote(&format!("{{\"boxes\":{}}}", boxes))));
        self.root = Some(root.clone());
        self.lay = Some(lay.clone());
        boxes
    }
    /// the newest layout: a frame's, or one the page's script asked for
    /// (reading a size after a change: __hostSync)
    fn newest(&mut self) {
        if let Some((r, l)) = self.synced.borrow_mut().last.take() {
            self.root = Some(r);
            self.lay = Some(l);
        }
    }
    /// the laid-out page as EVG's display list (JSON)
    pub fn paint(&mut self) -> String {
        self.newest();
        let (Some(root), Some(lay)) = (self.root.clone(), self.lay.clone()) else { return String::new() };
        let dl = Rc::new(RefCell::new(EVGDisplayList::new()));
        // (opacity fades a subtree as one picture: evg-webgl composites a
        // group offscreen)
        dl.borrow_mut().group_opacity = true;
        // (a list made for this one paint has no commands of an earlier
        // walk to give again, and with fragments on a kept subtree is
        // drawn whole, also what is outside its clip: AG Grid 1 743
        // commands for 186)
        EVGDisplayList::set_fragments(&dl, false);
        EVGDisplayList::set_text_engine(&dl, EVGLayout::get_text_engine(&lay));
        EVGDisplayList::build(&dl, root);
        EVGDisplayList::to_json(&dl)
    }
}

/// The render tree laid out by EVG: the boxes (JSON) for the page, and the
/// tree and layout the display list is built from.
fn lay_out(page: &Rc<RefCell<JsonValue>>, delta: bool, w: f64, h: f64, kept: &mut Kept) -> (String, Rc<RefCell<EVGElement>>, Rc<RefCell<EVGLayout>>) {
    #[cfg(not(target_arch = "wasm32"))]
    let timing = std::env::var("PG_TIMING").is_ok();
    #[cfg(not(target_arch = "wasm32"))]
    let mut t0 = std::time::Instant::now();
    #[cfg(not(target_arch = "wasm32"))]
    let mut lap = |what: &str| { if timing { eprintln!("  layout {} {:?}", what, t0.elapsed()); } t0 = std::time::Instant::now(); };
    #[cfg(target_arch = "wasm32")]
    let lap = |_: &str| {};
    let page = page.clone();
    let root = EVGElement::create_div();
    root.borrow_mut().width = Some(EVGUnit::px(w));
    root.borrow_mut().height = Some(EVGUnit::px(h));
    EVGElement::set_attribute(&root, "white-space", "nowrap".to_string());
    EVGElement::set_attribute(&root, "font-family", "Arial".to_string());
    if !delta {
        kept.share(&page);
    }
    lap("share");
    kept.svgs.borrow_mut().frame();
    let b = DomView::buildKept(&page, 0, w, h, Rc::clone(&kept.svgs));
    lap("build");
    EVGElement::add_child(&root, b.clone());
    let lay = Rc::new(RefCell::new(EVGLayout::new()));
    EVGLayout::set_page_size(&lay, w, h);
    EVGLayout::layout(&lay, root.clone());
    lap("evg");
    DomView::settle(&b);
    lap("settle");
    let boxes = DomView::boxes(&b, 0);
    lap("boxes");
    // PG_RETAINCHECK: the same page built with nothing kept gives the same
    // boxes and the same display list, or the difference is printed
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var("PG_RETAINCHECK").is_ok() {
        let list = |root: &Rc<RefCell<EVGElement>>, lay: &Rc<RefCell<EVGLayout>>| {
            let dl = Rc::new(RefCell::new(EVGDisplayList::new()));
        // (opacity fades a subtree as one picture: evg-webgl composites a
        // group offscreen)
        dl.borrow_mut().group_opacity = true;
            EVGDisplayList::set_fragments(&dl, false);
            EVGDisplayList::set_text_engine(&dl, EVGLayout::get_text_engine(lay));
            EVGDisplayList::build(&dl, root.clone());
            EVGDisplayList::to_json(&dl)
        };
        let fresh_page = JsonParser::parse(page.borrow().toJson()).borrow_mut().value();
        let froot = EVGElement::create_div();
        froot.borrow_mut().width = Some(EVGUnit::px(w));
        froot.borrow_mut().height = Some(EVGUnit::px(h));
        EVGElement::set_attribute(&froot, "white-space", "nowrap".to_string());
        EVGElement::set_attribute(&froot, "font-family", "Arial".to_string());
        let fb = DomView::build(&fresh_page, 0, w, h);
        EVGElement::add_child(&froot, fb.clone());
        let flay = Rc::new(RefCell::new(EVGLayout::new()));
        EVGLayout::set_page_size(&flay, w, h);
        EVGLayout::layout(&flay, froot.clone());
        DomView::settle(&fb);
        let fboxes = DomView::boxes(&fb, 0);
        let (kl, fl) = (list(&root, &lay), list(&froot, &flay));
        let first = |a: &str, b: &str| {
            let (x, y) = (a.as_bytes(), b.as_bytes());
            let mut i = 0;
            while i < x.len() && i < y.len() && x[i] == y[i] { i += 1; }
            let from = i.saturating_sub(120);
            format!("at {}: kept ...{} | fresh ...{}", i, String::from_utf8_lossy(&x[from..(i + 120).min(x.len())]), String::from_utf8_lossy(&y[from..(i + 120).min(y.len())]))
        };
        // (PG_TREE=<element id>: that element's subtree in both trees)
        if boxes != fboxes && std::env::var("PG_TREE").is_ok() {
            fn find(el: &Rc<RefCell<EVGElement>>, id: &str) -> Option<Rc<RefCell<EVGElement>>> {
                if el.borrow().id == id { return Some(el.clone()); }
                let ks = el.borrow().children.clone();
                for k in ks.iter() { if let Some(f) = find(k, id) { return Some(f); } }
                None
            }
            fn dump(el: &Rc<RefCell<EVGElement>>, d: usize, o: &mut String) {
                let e = el.borrow();
                let u = |x: &Option<Rc<RefCell<EVGUnit>>>| match x { Some(v) => format!("{}/{}/{}", v.borrow().value, v.borrow().is_set, v.borrow().unit_type), None => "-".to_string() };
                let bx = e.r#box.clone().unwrap();
                o.push_str(&format!("{}{} .{} d={} pos={} x={} y={} w={} h={} ml={} mr={} width={} height={} left={} right={} abs={}\n", " ".repeat(d * 2), e.id, e.class_name, e.display, e.position, e.calculated_x, e.calculated_y, e.calculated_width, e.calculated_height, bx.borrow().margin_left_px, bx.borrow().margin_right_px, u(&e.width), u(&e.height), u(&e.left), u(&e.right), e.is_absolute));
                let ks = e.children.clone();
                drop(e);
                for k in ks.iter() { dump(k, d + 1, o); }
            }
            let id = std::env::var("PG_TREE").unwrap();
            let (mut a, mut b2) = (String::new(), String::new());
            if let Some(x) = find(&root, &id) { dump(&x, 0, &mut a); }
            if let Some(x) = find(&froot, &id) { dump(&x, 0, &mut b2); }
            eprintln!("KEPT TREE\n{}FRESH TREE\n{}", a, b2);
        }
        if boxes != fboxes { eprintln!("RETAIN boxes differ {}", first(&boxes, &fboxes)); }
        else if kl != fl { eprintln!("RETAIN list differs {}", first(&kl, &fl)); }
        else { eprintln!("RETAIN same"); }
    }
    (boxes, root, lay)
}

/// What one layout keeps for the next: the page's nodes by their ids with a
/// hash of what each holds, and the elements built from them (DomView's
/// memo). The next render tree gets the last one's node wherever a node
/// holds the same, and DomView then takes the element it built for that
/// node instead of building it again: a scroll that brings three rows into
/// a grid builds those rows, not the page.
struct Kept {
    svgs: Rc<RefCell<DomSvgDocs>>,
    nodes: HashMap<String, (u64, Rc<RefCell<JsonValue>>)>,
    styles: HashMap<String, (u64, Rc<RefCell<JsonValue>>)>,
    /// the nodes of this page with an id, and how many of them are the
    /// last page's
    seen: usize,
    same: usize,
    off: bool,
    /// delta pages: the nodes kept by their numbers, the epoch they are
    /// of, the most nodes a page had and how many this one sent, the root
    by_n: HashMap<i64, Rc<RefCell<JsonValue>>>,
    epoch: i64,
    total: usize,
    fresh: usize,
    live: usize,
    root: Option<Rc<RefCell<JsonValue>>>,
}

/// a delta page put together is the whole page (but for the numbers, "n")
#[cfg(not(target_arch = "wasm32"))]
fn same_page(a: &Rc<RefCell<JsonValue>>, b: &Rc<RefCell<JsonValue>>, at: &mut String) -> bool {
    let (ka, kb) = (a.borrow().kind, b.borrow().kind);
    if ka != kb {
        at.push_str(" kind");
        return false;
    }
    match ka {
        5 => {
            let keys: Vec<String> = a.borrow().keys.iter().filter(|k| k.as_str() != "n").cloned().collect();
            let kb: Vec<String> = b.borrow().keys.clone();
            if keys != kb {
                at.push_str(&format!(" keys {:?} / {:?} of {}", keys, kb, b.borrow().getText("i")));
                return false;
            }
            for k in keys.iter() {
                if !same_page(&a.borrow().get(k), &b.borrow().get(k), at) {
                    at.push_str(&format!(" <{} of {}", k, b.borrow().getText("i")));
                    return false;
                }
            }
            true
        }
        4 => {
            let (ia, ib) = (a.borrow().items.clone(), b.borrow().items.clone());
            if ia.len() != ib.len() {
                at.push_str(&format!(" count {} / {}", ia.len(), ib.len()));
                return false;
            }
            for i in 0..ia.len() {
                if !same_page(&ia[i], &ib[i], at) {
                    at.push_str(&format!(" [{}]", i));
                    return false;
                }
            }
            true
        }
        _ => {
            let same = a.borrow().text() == b.borrow().text() && a.borrow().b == b.borrow().b;
            if !same {
                at.push_str(&format!(" {:?} / {:?}", a.borrow().text(), b.borrow().text()));
            }
            same
        }
    }
}

fn mix(h: u64, v: u64) -> u64 {
    (h ^ v).wrapping_mul(0x100000001b3).rotate_left(23) ^ 0x9e3779b97f4a7c15
}

fn hash_str(mut h: u64, s: &str) -> u64 {
    for b in s.as_bytes() {
        h = (h ^ (*b as u64)).wrapping_mul(0x100000001b3);
    }
    mix(h, s.len() as u64)
}

/// a value's hash: its kind, text and members in order
fn hash_value(n: &Rc<RefCell<JsonValue>>) -> u64 {
    let v = n.borrow();
    let mut h: u64 = mix(0xcbf29ce484222325, v.kind as u64);
    match v.kind {
        1 => h = mix(h, v.b as u64),
        2 => h = hash_str(h, &v.numText),
        3 => h = hash_str(h, &v.str),
        4 | 5 => {
            for (i, it) in v.items.iter().enumerate() {
                if v.kind == 5 {
                    h = hash_str(h, &v.keys[i]);
                }
                h = mix(h, hash_value(it));
            }
        }
        _ => {}
    }
    h
}

impl Kept {
    fn new() -> Kept {
        let svgs = Rc::new(RefCell::new(DomSvgDocs::new()));
        svgs.borrow().memo.borrow_mut().on = true;
        // (a kept element keeps its layout too, EVGElement.keepLayout;
        // PG_NOKEEPLAYOUT lays every kept element out again, PG_RETAINCHECK
        // compares each frame with a page built and laid out from nothing)
        svgs.borrow().memo.borrow_mut().keepLayout = true;
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("PG_NOKEEPLAYOUT").is_ok() { svgs.borrow().memo.borrow_mut().keepLayout = false; }
        #[cfg(not(target_arch = "wasm32"))]
        let off = std::env::var("PG_NORETAIN").is_ok();
        #[cfg(target_arch = "wasm32")]
        let off = false;
        Kept { svgs: svgs, nodes: HashMap::new(), styles: HashMap::new(), seen: 0, same: 0, off: off, by_n: HashMap::new(), epoch: 0, total: 0, fresh: 0, live: 0, root: None }
    }
    /// a delta page (webapi.js renderJson): each node it names ({"r": n})
    /// is the node kept under that number, each node with a number is kept.
    /// Some(true): its root is the last page's. None: it names a node that
    /// is not kept.
    fn resolve(&mut self, page: &Rc<RefCell<JsonValue>>) -> Option<bool> {
        let epoch = page.borrow().getInt("d", 0);
        if epoch != self.epoch {
            self.by_n = HashMap::new();
            self.styles = HashMap::new();
            self.nodes = HashMap::new();
            self.root = None;
            self.total = 0;
            self.live = 0;
            self.epoch = epoch;
        }
        self.fresh = 0;
        let root = page.borrow().get("root");
        if root.borrow().kind != 5 {
            self.root = None;
            return Some(false);
        }
        let Some(r) = self.node_of(&root) else {
            self.by_n = HashMap::new();
            self.root = None;
            return None;
        };
        let mut same = match &self.root { Some(was) => Rc::ptr_eq(was, &r), None => false };
        self.root = Some(r.clone());
        // the top layer's boxes come apart ("tops"): the page's root is a
        // copy of the kept one with them after its children
        let tops = page.borrow().get("tops");
        if tops.borrow().kind == 4 && !tops.borrow().items.is_empty() {
            let mut copy = r.borrow().clone();
            copy.stamp = 0;
            let kids = JsonValue::mkArr();
            let c = r.borrow().get("c");
            if c.borrow().kind == 4 {
                kids.borrow_mut().items = c.borrow().items.clone();
            }
            for t in tops.borrow().items.iter() {
                kids.borrow_mut().items.push(t.clone());
            }
            let top_root = Rc::new(RefCell::new(copy));
            top_root.borrow_mut().put("c", kids);
            page.borrow_mut().put("root", top_root);
            page.borrow_mut().put("tops", JsonValue::mkNull());
            same = false;
        } else {
            page.borrow_mut().put("root", r.clone());
        }
        // (a kept node only this list holds is no longer in the page: let
        // go, with what was under it. A page that names one later, a
        // subtree taken out and put back unchanged, is asked for whole.)
        if self.fresh > 0 && (self.by_n.len() < 4096 || self.by_n.len() > self.live + self.live / 8) {
            for _ in 0..8 {
                let before = self.by_n.len();
                self.by_n.retain(|_, v| Rc::strong_count(v) > 1);
                if self.by_n.len() == before {
                    break;
                }
            }
            self.styles.retain(|_, v| Rc::strong_count(&v.1) > 1);
            self.live = self.by_n.len();
        }
        if self.fresh > self.total {
            self.total = self.fresh;
        }
        // (elements are kept for a page that is mostly the last one, see share)
        let on = !self.off && self.fresh * 4 < self.total;
        self.svgs.borrow().memo.borrow_mut().on = on;
        Some(same)
    }
    /// the nodes with an id under n, n too
    fn ids(n: &Rc<RefCell<JsonValue>>) -> usize {
        if n.borrow().kind != 5 {
            return 0;
        }
        let mut count = if n.borrow().keyAt("i") >= 0 { 1 } else { 0 };
        let c = n.borrow().get("c");
        if c.borrow().kind == 4 {
            for k in c.borrow().items.iter() {
                count += Kept::ids(k);
            }
        }
        count
    }
    fn node_of(&mut self, n: &Rc<RefCell<JsonValue>>) -> Option<Rc<RefCell<JsonValue>>> {
        if n.borrow().kind != 5 {
            return Some(n.clone());
        }
        if n.borrow().keys.len() == 1 && n.borrow().keys[0] == "r" {
            let id = n.borrow().getInt("r", -1);
            return self.by_n.get(&id).cloned();
        }
        // (a node without a number was sent whole: nothing under it is
        // named or kept by itself)
        if n.borrow().keyAt("n") < 0 {
            self.fresh += Kept::ids(n);
            return Some(n.clone());
        }
        let c = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let kids = c.borrow().items.clone();
            let mut out = Vec::with_capacity(kids.len());
            for k in kids.iter() {
                out.push(self.node_of(k)?);
            }
            c.borrow_mut().items = out;
        }
        let id = n.borrow().getText("i");
        if !id.is_empty() {
            self.fresh += 1;
            // (a node sent again keeps its style object while that holds
            // the same: its children were built under it)
            let s = n.borrow().get("s");
            if s.borrow().kind == 5 {
                let hs = hash_value(&s);
                let mut keep = s.clone();
                if let Some((was, old)) = self.styles.get(&id) {
                    if *was == hs {
                        keep = old.clone();
                    }
                }
                if !Rc::ptr_eq(&keep, &s) {
                    n.borrow_mut().put("s", keep.clone());
                }
                self.styles.insert(id, (hs, keep));
            }
        }
        let num = n.borrow().getInt("n", -1);
        if num >= 0 {
            self.by_n.insert(num, n.clone());
        }
        Some(n.clone())
    }
    /// the page with the last page's nodes where they hold the same
    fn share(&mut self, page: &Rc<RefCell<JsonValue>>) {
        let mut nodes = HashMap::new();
        let mut styles = HashMap::new();
        self.seen = 0;
        self.same = 0;
        let root = page.borrow().get("root");
        if root.borrow().kind == 5 {
            let (shared, _) = self.node(&root, &mut nodes, &mut styles);
            page.borrow_mut().put("root", shared);
        }
        self.nodes = nodes;
        self.styles = styles;
        // (elements are kept for a page that is mostly the last one: on a
        // page where every box moves each frame, noting each element for
        // the next frame cost more than building it)
        let on = !self.off && self.seen > 0 && (self.seen - self.same) * 4 < self.seen;
        self.svgs.borrow().memo.borrow_mut().on = on;
    }
    /// n or the last page's node for it, and its hash; each node with an
    /// id ("i") is noted for the next page
    fn node(&mut self, n: &Rc<RefCell<JsonValue>>, nodes: &mut HashMap<String, (u64, Rc<RefCell<JsonValue>>)>, styles: &mut HashMap<String, (u64, Rc<RefCell<JsonValue>>)>) -> (Rc<RefCell<JsonValue>>, u64) {
        if n.borrow().kind != 5 {
            return (n.clone(), hash_value(n));
        }
        let id = n.borrow().getText("i");
        let count = n.borrow().keys.len();
        let mut h: u64 = mix(0xcbf29ce484222325, 5);
        let mut hs: u64 = 0;
        for i in 0..count {
            let key = n.borrow().keys[i].clone();
            let it = n.borrow().items[i].clone();
            h = hash_str(h, &key);
            if key == "c" && it.borrow().kind == 4 {
                let kids = it.borrow().items.clone();
                let mut hc: u64 = mix(0xcbf29ce484222325, 4);
                let mut out = Vec::with_capacity(kids.len());
                for k in kids.iter() {
                    let (sk, hk) = self.node(k, nodes, styles);
                    hc = mix(hc, hk);
                    out.push(sk);
                }
                it.borrow_mut().items = out;
                h = mix(h, hc);
            } else {
                let hv = hash_value(&it);
                if key == "s" {
                    hs = hv;
                }
                h = mix(h, hv);
            }
        }
        if id.is_empty() {
            return (n.clone(), h);
        }
        self.seen += 1;
        if let Some((was, old)) = self.nodes.remove(&id) {
            if was == h {
                self.same += 1;
                self.carry(&old, nodes, styles);
                nodes.insert(id, (h, old.clone()));
                return (old, h);
            }
        }
        // (a node whose children changed keeps its style object while that
        // holds the same: its other children were built under it)
        if hs != 0 {
            if let Some((was, old)) = self.styles.remove(&id) {
                if was == hs {
                    n.borrow_mut().put("s", old);
                }
            }
            styles.insert(id.clone(), (hs, n.borrow().get("s")));
        }
        nodes.insert(id, (h, n.clone()));
        (n.clone(), h)
    }
    /// a node taken from the last page: what is under it goes on to the
    /// next one's notes
    fn carry(&mut self, n: &Rc<RefCell<JsonValue>>, nodes: &mut HashMap<String, (u64, Rc<RefCell<JsonValue>>)>, styles: &mut HashMap<String, (u64, Rc<RefCell<JsonValue>>)>) {
        let id = n.borrow().getText("i");
        if !id.is_empty() {
            if let Some(e) = self.styles.remove(&id) {
                styles.insert(id.clone(), e);
            }
        }
        let c = n.borrow().get("c");
        if c.borrow().kind != 4 {
            return;
        }
        let kids = c.borrow().items.clone();
        for k in kids.iter() {
            if k.borrow().kind != 5 {
                continue;
            }
            let kid = k.borrow().getText("i");
            if !kid.is_empty() {
                if let Some(e) = self.nodes.remove(&kid) {
                    nodes.insert(kid, e);
                }
            }
            self.carry(k, nodes, styles);
        }
    }}

/// What a synchronous layout left for the next paint.
struct Synced {
    w: f64,
    h: f64,
    last: Option<(Rc<RefCell<EVGElement>>, Rc<RefCell<EVGLayout>>)>,
    /// the render tree last laid out, its boxes and tree: the same tree
    /// again (a frame after a script's forced layout, or two reads with
    /// only a class that changes nothing between) is not laid out again
    json: String,
    boxes: String,
    tree: Option<(Rc<RefCell<EVGElement>>, Rc<RefCell<EVGLayout>>)>,
    kept: Kept,
}

impl Synced {
    /// None: the page is a delta that names a node this host does not
    /// have (the page is asked for whole: __renderDelta(1), "!")
    fn lay_out(&mut self, json: &str) -> Option<(String, Rc<RefCell<EVGElement>>, Rc<RefCell<EVGLayout>>)> {
        if let Some((r, l)) = self.tree.clone() {
            if self.json == json {
                return Some((self.boxes.clone(), r, l));
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        let t0 = std::time::Instant::now();
        let page = JsonParser::parse(json.to_string()).borrow_mut().value();
        let delta = page.borrow().has("d");
        if delta {
            let same = self.kept.resolve(&page)?;
            #[cfg(not(target_arch = "wasm32"))]
            if page.borrow().has("whole") {
                let mut at = String::new();
                if same_page(&page.borrow().get("root"), &page.borrow().get("whole"), &mut at) {
                    eprintln!("DELTACHECK same");
                } else {
                    eprintln!("DELTACHECK DIFFERENT at {}", at);
                }
                page.borrow_mut().put("whole", JsonValue::mkNull());
            }
            // (its root is the one laid out last: nothing changed)
            if same {
                if let Some((r, l)) = self.tree.clone() {
                    return Some((self.boxes.clone(), r, l));
                }
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("PG_TIMING").is_ok() { eprintln!("  layout parse {:?} ({} bytes{})", t0.elapsed(), json.len(), if delta { ", delta" } else { "" }); }
        let (boxes, root, lay) = lay_out(&page, delta, self.w, self.h, &mut self.kept);
        self.json = json.to_string();
        self.boxes = boxes.clone();
        self.tree = Some((root.clone(), lay.clone()));
        self.last = Some((root.clone(), lay.clone()));
        Some((boxes, root, lay))
    }
}

/// __hostSync(renderJson) from webapi.js: a script read a size after it
/// changed the page, so the page is laid out now, as a browser's forced
/// layout does, and the boxes are the answer.
struct SyncLayout {
    s: Rc<std::cell::RefCell<Synced>>,
}

impl cer::vm::HostSync for SyncLayout {
    fn call(&mut self, request: &str) -> String {
        match self.s.borrow_mut().lay_out(request) {
            Some(l) => l.0,
            None => "!".to_string(),
        }
    }
}

impl Default for Playground {
    fn default() -> Self {
        Playground::new()
    }
}

// ---- the module's interface (wasm32): one playground, strings in and out

thread_local! {
    static PG: std::cell::RefCell<Playground> = std::cell::RefCell::new(Playground::new());
    static OUT: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    /// the compiled js/ scripts (pg_add_unit with a rangerdom: key)
    static CORE_UNITS: std::cell::RefCell<Vec<(String, String)>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn text(ptr: *mut u8, len: usize) -> String {
    if len == 0 {
        return String::new();
    }
    // the buffer pg_alloc gave, handed back
    let v = unsafe { Vec::from_raw_parts(ptr, len, len) };
    String::from_utf8(v).unwrap_or_default()
}
fn answer(s: String) -> usize {
    let n = s.len();
    OUT.with(|o| *o.borrow_mut() = s.into_bytes());
    n
}

#[no_mangle]
pub extern "C" fn pg_alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
#[no_mangle]
pub extern "C" fn pg_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn pg_reset() {
    PG.with(|p| *p.borrow_mut() = Playground::new());
}
#[no_mangle]
pub extern "C" fn pg_add_script(up: *mut u8, ul: usize, tp: *mut u8, tl: usize) {
    let (u, t) = (text(up, ul), text(tp, tl));
    PG.with(|p| p.borrow_mut().add_script(&u, &t));
}
/// a compiled script for the page about to start (url) or for one of js/
/// (rangerdom:prelude.js, rangerdom:webapi.js, rangerdom:host.js; kept
/// over pg_reset)
#[no_mangle]
pub extern "C" fn pg_add_unit(up: *mut u8, ul: usize, tp: *mut u8, tl: usize) {
    let (u, t) = (text(up, ul), text(tp, tl));
    PG.with(|p| p.borrow_mut().add_unit(&u, &t));
}
/// A script compiled, as text (CEr's unit, its code cache): "" when it
/// does not compile or holds what the text cannot. `rangerdom:<file>`
/// names one of js/. For the build (playground/build.mjs).
#[no_mangle]
pub extern "C" fn pg_compile(sp: *mut u8, sl: usize) -> usize {
    let s = text(sp, sl);
    let src: &str = match s.as_str() {
        "rangerdom:prelude.js" => PRELUDE,
        "rangerdom:webapi.js" => WEBAPI,
        "rangerdom:host.js" => HOST,
        _ => s.as_str(),
    };
    let mut e = Engine::new();
    let u = e.compile(src);
    answer(if e.error.is_empty() { cer::unit::encode(&u, src) } else { String::new() })
}
#[no_mangle]
pub extern "C" fn pg_start(hp: *mut u8, hl: usize, up: *mut u8, ul: usize, w: f64, h: f64) {
    let (html, url) = (text(hp, hl), text(up, ul));
    PG.with(|p| p.borrow_mut().start(&html, &url, w, h));
}
#[no_mangle]
pub extern "C" fn pg_run_scripts() {
    PG.with(|p| p.borrow_mut().run_scripts());
}
#[no_mangle]
pub extern "C" fn pg_tick(ms: f64) -> i64 {
    PG.with(|p| p.borrow_mut().tick(ms))
}
#[no_mangle]
pub extern "C" fn pg_due_in() -> f64 {
    PG.with(|p| p.borrow_mut().due_in())
}
#[no_mangle]
pub extern "C" fn pg_dirty() -> i32 {
    PG.with(|p| p.borrow_mut().dirty() as i32)
}
#[no_mangle]
pub extern "C" fn pg_render() -> usize {
    answer(PG.with(|p| p.borrow_mut().render()))
}
#[no_mangle]
pub extern "C" fn pg_layout() -> usize {
    answer(PG.with(|p| p.borrow_mut().layout()))
}
#[no_mangle]
pub extern "C" fn pg_paint() -> usize {
    answer(PG.with(|p| p.borrow_mut().paint()))
}
#[no_mangle]
pub extern "C" fn pg_eval(sp: *mut u8, sl: usize) -> usize {
    let s = text(sp, sl);
    answer(PG.with(|p| p.borrow_mut().value(&s)))
}
#[no_mangle]
pub extern "C" fn pg_input(sp: *mut u8, sl: usize) -> usize {
    let s = text(sp, sl);
    answer(PG.with(|p| p.borrow_mut().input(&s)))
}
#[no_mangle]
pub extern "C" fn pg_messages() -> usize {
    answer(PG.with(|p| p.borrow_mut().messages()))
}
