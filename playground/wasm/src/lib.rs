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
use rangerdom_view::{DomBoxes, DomPaint, DomSvgDocs, DomView};
use rangerevg::{EVGA11yFromTree, EVGA11yTree, EVGDisplayList, EVGElement, EVGLayout, EVGRetain, EVGUnit};

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
        fn get_line_height(&mut self, font_family: String, font_size: f64) -> f64 { EVGTextMeasurerTrait::get_line_height(&mut self.inner, Self::table_face(&font_family), font_size) }
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
    /// the next render sends the whole page (after a restore this host
    /// has nothing of it)
    whole: bool,
}

impl Playground {
    pub fn new() -> Playground {
        let engine = Playground::tuned(Engine::new());
        let synced = Playground::new_synced(800.0, 600.0);
        let mut pg = Playground { engine: engine, scripts: Vec::new(), units: Vec::new(), errors: Vec::new(), w: 800.0, h: 600.0, page_json: String::new(), last_gen: String::new(), root: None, lay: None, synced: synced, whole: false };
        pg.engine.vm.set_host_sync(Box::new(SyncLayout { s: pg.synced.clone() }));
        pg
    }
    /// an engine as the playground runs it: the register machine, the
    /// browser's time zone
    fn tuned(mut engine: Engine) -> Engine {
        // (CEr's register machine: its default is still the stack machine)
        engine.vm.regs = true;
        // Date's local time zone: the browser's (pg_set_time_zone), kept
        // over pg_reset
        TIME_ZONE.with(|z| { let z = z.borrow(); if !z.is_empty() { engine.set_time_zone(&z); } });
        // the native tools: TZ, as Node and Chromium take it
        #[cfg(not(target_arch = "wasm32"))]
        if let Ok(z) = std::env::var("TZ") {
            let name = z.trim_start_matches(':');
            if !name.is_empty() {
                engine.set_time_zone(name);
            }
        }
        engine
    }
    fn new_synced(w: f64, h: f64) -> Rc<std::cell::RefCell<Synced>> {
        Rc::new(std::cell::RefCell::new(Synced { w: w, h: h, last: None, json: String::new(), boxes: String::new(), tree: None, tree_at: (0.0, 0.0), kept: Kept::new() }))
    }

    /// The page's whole state (CEr's heap snapshot: the document, its
    /// styles, the page's scripts and timers) with the viewport, as text
    /// for `restore`; "" while a script runs. What the host keeps (the
    /// laid-out tree, EVG's boxes) is not in it: it is made again from
    /// the page at the first frame after a restore.
    pub fn snapshot(&mut self) -> String {
        self.exec("__suspend()");
        // (garbage left by the last frames is not kept: a collection first)
        self.engine.vm.collect();
        let s = self.engine.snapshot();
        if s.is_empty() {
            return s;
        }
        format!("rdsnap1 {} {}\n{}", self.w, self.h, s)
    }
    /// The playground in the state `snapshot` gave; false (and nothing
    /// changed) when the text is not one.
    pub fn restore(&mut self, text: &str) -> bool {
        let Some(nl) = text.find('\n') else { return false };
        let head: Vec<&str> = text[..nl].split(' ').collect();
        if head.len() != 3 || head[0] != "rdsnap1" {
            return false;
        }
        let w: f64 = head[1].parse().unwrap_or(0.0);
        let h: f64 = head[2].parse().unwrap_or(0.0);
        let engine = Engine::from_snapshot(&text[nl + 1..]);
        if !engine.error.is_empty() {
            return false;
        }
        self.engine = Playground::tuned(engine);
        self.synced = Playground::new_synced(w, h);
        self.engine.vm.set_host_sync(Box::new(SyncLayout { s: self.synced.clone() }));
        self.w = w;
        self.h = h;
        self.root = None;
        self.lay = None;
        self.page_json = String::new();
        // (dirty at once: the first frame asks for the whole page, as this
        // host has none of it, __renderDelta(1))
        self.last_gen = String::new();
        self.whole = true;
        self.exec("__resume(1)");
        true
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
        // virtual rows: this host renders again before it paints when they
        // ask (layout); PG_NOVIRT renders every child
        #[cfg(not(target_arch = "wasm32"))]
        let virt = std::env::var("PG_NOVIRT").is_err();
        #[cfg(target_arch = "wasm32")]
        let virt = true;
        if virt {
            self.exec("__virtRows(true)");
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
    /// a new viewport size (the window resized): laid out at it from the
    /// next frame, the page told (resize event, media queries)
    pub fn resize(&mut self, w: f64, h: f64) {
        self.w = w;
        self.h = h;
        {
            let mut sy = self.synced.borrow_mut();
            sy.w = w;
            sy.h = h;
            sy.json.clear();
        }
        self.exec(&format!("__layout({{viewport: [{}, {}]}})", w, h));
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
        self.page_json = if self.whole { self.whole = false; self.value("__renderDelta(1)") } else { self.value("__renderDelta()") };
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
        let Some((mut boxes, mut root, mut lay)) = laid else { return String::new() };
        self.exec(&format!("__layout({})", quote(&format!("{{\"boxes\":{}}}", boxes))));
        // (virtual rows whose heights the layout showed to be other than
        // guessed, or that leave out a child near the viewport: rendered
        // and laid out again before anything is painted)
        for _ in 0..4 {
            if self.value("__virtAgain()").is_empty() { break; }
            self.render();
            let mut l = self.synced.borrow_mut().lay_out(&self.page_json);
            if l.is_none() {
                self.page_json = self.value("__renderDelta(1)");
                l = self.synced.borrow_mut().lay_out(&self.page_json);
            }
            let Some((b2, r2, l2)) = l else { break };
            self.exec(&format!("__layout({})", quote(&format!("{{\"boxes\":{}}}", b2))));
            boxes = b2; root = r2; lay = l2;
        }
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
    /// the laid-out page's accessible tree (EVGA11yFromTree from the roles
    /// and names DomView put on the boxes), JSON for evg-a11y.js
    pub fn a11y(&mut self, focus_id: &str, gen: i64) -> String {
        let Some(root) = self.root.clone() else { return String::new() };
        let fb = Rc::new(RefCell::new(EVGA11yFromTree::new()));
        let t = EVGA11yFromTree::build(&fb, &root, "Page".to_string(), gen, focus_id);
        EVGA11yTree::to_json(&t)
    }
    pub fn paint(&mut self) -> String {
        match self.paint_list() { Some(dl) => EVGDisplayList::to_json(&dl), None => String::new() }
    }
    /// The display list itself, for a host that draws its commands without
    /// the JSON (playground/native)
    pub fn paint_list(&mut self) -> Option<Rc<RefCell<EVGDisplayList>>> {
        self.newest();
        let (Some(root), Some(lay)) = (self.root.clone(), self.lay.clone()) else { return None };
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
        Some(dl)
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
    // (the last field's caret goes, its element may be kept)
    if let Some(old) = kept.deco.take() {
        let ks: Vec<_> = old.borrow().children.iter().filter(|c| { let n = c.borrow().class_name.clone(); n != "mfd-dcaret" && n != "mfd-dsel" }).cloned().collect();
        old.borrow_mut().children = ks;
    }
    let b = DomView::buildKept(&page, 0, w, h, Rc::clone(&kept.svgs));
    lap("build");
    EVGElement::add_child(&root, b.clone());
    let lay = Rc::new(RefCell::new(EVGLayout::new()));
    EVGLayout::set_page_size(&lay, w, h);
    EVGLayout::layout(&lay, root.clone());
    lap("evg");
    DomView::settle(&b);
    lap("settle");
    // the focused text field's caret, or its selection, over its laid out
    // text (DomView::decorate)
    // (a delta's tree is under "root", resolved to the whole page)
    let top = if page.borrow().has("root") { page.borrow().get("root") } else { page.clone() };
    let ff = DomView::focusedField(&top);
    if ff.borrow().kind == 5 {
        let fid = format!("mfd-xd-0-{}", ff.borrow().getText("i"));
        if let Some(fe) = find_el(&b, &fid) {
            DomView::decorate(&EVGLayout::get_text_engine(&lay), &fe, &ff);
            kept.deco = Some(fe);
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    let all = std::env::var("PG_FULLBOXES").is_ok();
    #[cfg(target_arch = "wasm32")]
    let all = false;
    let boxes = if all { DomView::boxes(&b, 0) } else { DomView::boxesSince(&b, 0, &kept.boxes) };
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
        // (the changes sent, taken as webapi.js takes them, are all the boxes)
        if !all {
            let m = JsonParser::parse(boxes.clone()).borrow_mut().value();
            let (set, gone) = (m.borrow().get("set"), m.borrow().get("gone"));
            for (i, k) in set.borrow().keys.iter().enumerate() { kept.mirror.insert(k.clone(), set.borrow().items[i].borrow().toJson()); }
            for g in gone.borrow().items.iter() { kept.mirror.remove(&g.borrow().str); }
            let full = JsonParser::parse(DomView::boxes(&b, 0)).borrow_mut().value();
            let mut bad = full.borrow().keys.len() != kept.mirror.len();
            for (i, k) in full.borrow().keys.iter().enumerate() {
                if kept.mirror.get(k) != Some(&full.borrow().items[i].borrow().toJson()) { bad = true; }
            }
            if bad { eprintln!("RETAIN box changes differ: {} boxes, {} after the changes", full.borrow().keys.len(), kept.mirror.len()); }
        }
        let boxes = DomView::boxes(&b, 0);
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

/// the element of id `id` under `el`
fn find_el(el: &Rc<RefCell<EVGElement>>, id: &str) -> Option<Rc<RefCell<EVGElement>>> {
    if el.borrow().id == id { return Some(el.clone()); }
    let ks = el.borrow().children.clone();
    for k in ks.iter() { if let Some(f) = find_el(k, id) { return Some(f); } }
    None
}

/// What one layout keeps for the next: the page's nodes by their ids with a
/// hash of what each holds, and the elements built from them (DomView's
/// memo). The next render tree gets the last one's node wherever a node
/// holds the same, and DomView then takes the element it built for that
/// node instead of building it again: a scroll that brings three rows into
/// a grid builds those rows, not the page.
struct Kept {
    /// the field decorate drew a caret or selection on last time
    deco: Option<Rc<RefCell<EVGElement>>>,
    svgs: Rc<RefCell<DomSvgDocs>>,
    /// the boxes the page has: what DomView::boxesSince sends is what
    /// changed since (PG_FULLBOXES: all of them every time)
    boxes: Rc<RefCell<DomBoxes>>,
    /// PG_RETAINCHECK: the boxes a page that took every change has
    #[cfg(not(target_arch = "wasm32"))]
    mirror: HashMap<String, String>,
    nodes: HashMap<String, (u64, Rc<RefCell<JsonValue>>)>,
    styles: HashMap<String, (u64, Rc<RefCell<JsonValue>>)>,
    /// the nodes of this page with an id, and how many of them are the
    /// last page's
    seen: usize,
    same: usize,
    off: bool,
    /// noting the elements of mostly new pages: how many such pages in a
    /// row the page after them made no use of (unused), whether the last
    /// page was noted, and the memo's counts when it began
    unused: usize,
    noted: bool,
    hits0: i64,
    misses0: i64,
    /// delta pages: the nodes kept by their numbers, the epoch they are
    /// of, the most nodes a page had and how many this one sent, the root
    by_n: HashMap<i64, Rc<RefCell<JsonValue>>>,
    epoch: i64,
    total: usize,
    fresh: usize,
    live: usize,
    since_prune: usize,
    root: Option<Rc<RefCell<JsonValue>>>,
    /// delta pages: each style object once, by what it holds. A page's
    /// elements mostly share a few styles (10 000 table rows: 90 000 style
    /// objects, 23 different), each kept apart was ~1.8 KB.
    pool: HashMap<u64, Rc<RefCell<JsonValue>>>,
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
/// a and b hold the same
fn same_value(a: &Rc<RefCell<JsonValue>>, b: &Rc<RefCell<JsonValue>>) -> bool {
    if Rc::ptr_eq(a, b) {
        return true;
    }
    let (x, y) = (a.borrow(), b.borrow());
    if x.kind != y.kind {
        return false;
    }
    match x.kind {
        1 => x.b == y.b,
        2 => x.numText == y.numText,
        3 => x.str == y.str,
        4 | 5 => x.items.len() == y.items.len() && (x.kind == 4 || x.keys == y.keys) && x.items.iter().zip(y.items.iter()).all(|(p, q)| same_value(p, q)),
        _ => true,
    }
}
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
        Kept { deco: None, svgs: svgs, boxes: Rc::new(RefCell::new(DomBoxes::new())), #[cfg(not(target_arch = "wasm32"))] mirror: HashMap::new(), nodes: HashMap::new(), styles: HashMap::new(), seen: 0, same: 0, off: off, unused: 0, noted: false, hits0: 0, misses0: 0, by_n: HashMap::new(), epoch: 0, total: 0, fresh: 0, live: 0, since_prune: 0, root: None, pool: HashMap::new() }
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
            self.pool = HashMap::new();
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
        // (and every 32 pages: one that took out most of its nodes, 10 000
        // rows cleared, held them as long as it lived)
        self.since_prune += 1;
        // (many elements left the page: what was kept for them goes now)
        let gone = page.borrow().getInt("gone", 0) as usize;
        if gone > 256 && gone * 8 > self.live {
            self.since_prune = 32;
            self.svgs.borrow().memo.borrow_mut().sweepNow = true;
        }
        if (self.fresh > 0 && (self.by_n.len() < 4096 || self.by_n.len() > self.live + self.live / 8)) || self.since_prune >= 32 {
            self.since_prune = 0;
            for _ in 0..8 {
                let before = self.by_n.len();
                self.by_n.retain(|_, v| Rc::strong_count(v) > 1);
                if self.by_n.len() == before {
                    break;
                }
            }
            self.styles.retain(|_, v| Rc::strong_count(&v.1) > 1);
            self.pool.retain(|_, v| Rc::strong_count(v) > 1);
            self.live = self.by_n.len();
        }
        if self.fresh > self.total {
            self.total = self.fresh;
        }
        // (elements are kept for a page that is mostly the last one, see share)
        let on = self.keeps(self.fresh * 4 < self.total);
        self.svgs.borrow().memo.borrow_mut().on = on;
        Some(same)
    }
    /// n's style object the pooled one that holds the same (the one n had
    /// last page too, when it holds the same: its children were built
    /// under it)
    fn pool_style(&mut self, n: &Rc<RefCell<JsonValue>>) {
        let s = n.borrow().get("s");
        if s.borrow().kind != 5 {
            return;
        }
        let hs = hash_value(&s);
        if let Some(p) = self.pool.get(&hs) {
            if !Rc::ptr_eq(p, &s) && same_value(p, &s) {
                let keep = p.clone();
                n.borrow_mut().put("s", keep);
            }
            return;
        }
        self.pool.insert(hs, s);
    }
    /// pool_style for n and every node under it (sent whole)
    fn pool_under(&mut self, n: &Rc<RefCell<JsonValue>>) {
        if n.borrow().kind != 5 {
            return;
        }
        self.pool_style(n);
        let c = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let kids = c.borrow().items.clone();
            for k in kids.iter() {
                self.pool_under(k);
            }
        }
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
            self.pool_under(n);
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
        if n.borrow().keyAt("i") >= 0 {
            self.fresh += 1;
        }
        self.pool_style(n);
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
        // (a mostly new page is noted all the same while the page after
        // one finds its elements: the page after a list is filled or
        // replaced is most often that page with one change)
        let on = self.seen > 0 && self.keeps((self.seen - self.same) * 4 < self.seen);
        self.svgs.borrow().memo.borrow_mut().on = on;
    }
    /// whether this page's elements are noted: mostly is "the page is
    /// mostly the last one". Three noted pages in a row that the next
    /// page took (almost) nothing from, an animation that moves every box:
    /// only mostly kept pages are noted from there on.
    fn keeps(&mut self, mostly: bool) -> bool {
        let (h, m) = {
            let sv = self.svgs.borrow();
            let mm = sv.memo.borrow();
            (mm.hits, mm.misses)
        };
        if self.noted {
            let (dh, dm) = (h - self.hits0, m - self.misses0);
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
        let on = !self.off && (mostly || self.unused < 3);
        self.noted = on;
        on
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

/// whether pages that change only what is drawn skip building and layout
/// (DomPaint; PG_NOPAINT turns it off natively)
fn paint_lane() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var("PG_NOPAINT").is_ok() {
        return false;
    }
    true
}

/// PG_RETAINCHECK on a paint-only frame: the page built and laid out from
/// nothing draws what the kept elements draw
#[cfg(not(target_arch = "wasm32"))]
fn paint_check(page: &Rc<RefCell<JsonValue>>, root: &Rc<RefCell<EVGElement>>, lay: &Rc<RefCell<EVGLayout>>, w: f64, h: f64) {
    let list = |root: &Rc<RefCell<EVGElement>>, lay: &Rc<RefCell<EVGLayout>>| {
        let dl = Rc::new(RefCell::new(EVGDisplayList::new()));
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
    let kb = root.borrow().children.first().cloned().unwrap();
    let (kl, fl) = (list(root, lay), list(&froot, &flay));
    if DomView::boxes(&kb, 0) != DomView::boxes(&fb, 0) {
        eprintln!("PAINT boxes differ");
    } else if kl != fl {
        let (x, y) = (kl.as_bytes(), fl.as_bytes());
        let mut i = 0;
        while i < x.len() && i < y.len() && x[i] == y[i] { i += 1; }
        let from = i.saturating_sub(120);
        eprintln!("PAINT list differs at {}: kept ...{} | fresh ...{}", i, String::from_utf8_lossy(&x[from..(i + 120).min(x.len())]), String::from_utf8_lossy(&y[from..(i + 120).min(y.len())]));
    } else {
        eprintln!("PAINT same");
    }
}

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
    /// the viewport tree was laid out at: at another size nothing of it
    /// is reused, even when the page's render is the same
    tree_at: (f64, f64),
    kept: Kept,
}

impl Synced {
    /// None: the page is a delta that names a node this host does not
    /// have (the page is asked for whole: __renderDelta(1), "!")
    fn lay_out(&mut self, json: &str) -> Option<(String, Rc<RefCell<EVGElement>>, Rc<RefCell<EVGLayout>>)> {
        if self.tree_at != (self.w, self.h) { self.tree = None; }
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
            let was = self.kept.root.clone();
            let tops = page.borrow().get("tops");
            let lone = !(tops.borrow().kind == 4 && !tops.borrow().items.is_empty());
            let same = self.kept.resolve(&page)?;
            // a page that changed only what is drawn (DomPaint): the values
            // written on the elements laid out last, the paint bounds
            // measured again, nothing built or laid out
            // (not under a caret or selection decorate drew: lay_out puts
            // those again)
            if !same && lone && self.tree_at == (self.w, self.h) && self.kept.deco.is_none() {
                if let (Some(w0), Some((r, l))) = (was, self.tree.clone()) {
                    if let Some(b) = r.borrow().children.first().cloned() {
                        let mut dp = DomPaint::new();
                        if paint_lane() && dp.compare(&w0, &page.borrow().get("root")) && dp.apply(&b, 0) {
                            EVGRetain::paint_frame(&l, &r);
                            let boxes = DomView::boxesSince(&b, 0, &self.kept.boxes);
                            #[cfg(not(target_arch = "wasm32"))]
                            if std::env::var("PG_RETAINCHECK").is_ok() {
                                // (the box changes sent, as lay_out's check mirrors them)
                                let m = JsonParser::parse(boxes.clone()).borrow_mut().value();
                                let (set, gone) = (m.borrow().get("set"), m.borrow().get("gone"));
                                for (i, k) in set.borrow().keys.iter().enumerate() { self.kept.mirror.insert(k.clone(), set.borrow().items[i].borrow().toJson()); }
                                for g in gone.borrow().items.iter() { self.kept.mirror.remove(&g.borrow().str); }
                                paint_check(&page, &r, &l, self.w, self.h);
                            }
                            self.json = json.to_string();
                            self.boxes = boxes.clone();
                            self.last = Some((r.clone(), l.clone()));
                            return Some((boxes, r, l));
                        }
                    }
                }
            }
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
        self.tree_at = (self.w, self.h);
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
thread_local! {
    static TIME_ZONE: std::cell::RefCell<String> = std::cell::RefCell::new(String::new());
}
/// Date's local time zone, an IANA name (the browser's
/// `Intl.DateTimeFormat().resolvedOptions().timeZone`), for this engine and
/// the ones pg_reset makes; 1 when CEr knows the zone, else 0 (and UTC)
#[no_mangle]
pub extern "C" fn pg_set_time_zone(zp: *mut u8, zl: usize) -> u32 {
    let z = text(zp, zl);
    TIME_ZONE.with(|t| *t.borrow_mut() = z.clone());
    PG.with(|p| if p.borrow_mut().engine.set_time_zone(&z) { 1 } else { 0 })
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
pub extern "C" fn pg_a11y(sp: *mut u8, sl: usize, gen: f64) -> usize {
    let s = text(sp, sl);
    answer(PG.with(|p| p.borrow_mut().a11y(&s, gen as i64)))
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
/// the page's state as text (Playground::snapshot)
#[no_mangle]
pub extern "C" fn pg_snapshot() -> usize {
    answer(PG.with(|p| p.borrow_mut().snapshot()))
}
/// 1 when the text was a snapshot and the page is now in its state
#[no_mangle]
pub extern "C" fn pg_restore(sp: *mut u8, sl: usize) -> u32 {
    let s = text(sp, sl);
    PG.with(|p| if p.borrow_mut().restore(&s) { 1 } else { 0 })
}
#[no_mangle]
pub extern "C" fn pg_messages() -> usize {
    answer(PG.with(|p| p.borrow_mut().messages()))
}
