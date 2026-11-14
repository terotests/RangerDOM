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
use rangerdom_json::JsonParser;
use rangerdom_view::DomView;
use rangerevg::{EVGDisplayList, EVGElement, EVGLayout, EVGUnit};

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
    pub errors: Vec<String>,
    w: f64,
    h: f64,
    page_json: String,
    last_gen: String,
    root: Option<Rc<RefCell<EVGElement>>>,
    lay: Option<Rc<RefCell<EVGLayout>>>,
}

impl Playground {
    pub fn new() -> Playground {
        Playground { engine: Engine::new(), scripts: Vec::new(), errors: Vec::new(), w: 800.0, h: 600.0, page_json: String::new(), last_gen: String::new(), root: None, lay: None }
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
    /// an expression's value as a string ("" on an error)
    pub fn value(&mut self, src: &str) -> String {
        let r = self.engine.eval(src);
        if self.note().is_empty() { r } else { String::new() }
    }

    pub fn add_script(&mut self, url: &str, text: &str) {
        self.scripts.push((url.to_string(), text.to_string()));
    }
    pub fn start(&mut self, html: &str, url: &str, w: f64, h: f64) {
        self.w = w;
        self.h = h;
        self.exec(PRELUDE);
        self.exec(WEBAPI);
        self.exec(HOST);
        self.exec(&format!("__page({}, {})", quote(html), quote(url)));
        self.exec(&format!("__layout({{viewport: [{}, {}]}})", w, h));
        self.exec("__installDefaults()");
    }
    /// the page's scripts in a browser's order, DOMContentLoaded and load
    pub fn run_scripts(&mut self) {
        self.exec("var __rdScripts = JSON.parse(__scripts())");
        let n: usize = self.value("__rdScripts.length").trim().parse().unwrap_or(0);
        for i in 0..n {
            let at = format!("__rdScripts[{}]", i);
            let id = self.value(&format!("{}.id", at));
            let has_src = !self.value(&format!("({}.src !== null) ? 'y' : ''", at)).is_empty();
            let src = if has_src {
                let u = self.value(&format!("{}.url", at));
                self.scripts.iter().find(|(su, _)| *su == u).map(|(_, t)| t.clone()).unwrap_or_default()
            } else {
                self.value(&format!("{}.text", at))
            };
            if !src.is_empty() {
                self.exec(&format!("__beginScript({})", id));
                let err = self.exec(&src);
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
        self.page_json = self.value("__render()");
        self.page_json.clone()
    }
    /// EVG lays the last render out; the boxes go back to the page
    pub fn layout(&mut self) -> String {
        #[cfg(not(target_arch = "wasm32"))]
        let timing = std::env::var("PG_TIMING").is_ok();
        #[cfg(not(target_arch = "wasm32"))]
        let mut t0 = std::time::Instant::now();
        #[cfg(not(target_arch = "wasm32"))]
        let mut lap = |what: &str| { if timing { eprintln!("  layout {} {:?}", what, t0.elapsed()); } t0 = std::time::Instant::now(); };
        #[cfg(target_arch = "wasm32")]
        let lap = |_: &str| {};
        let p = JsonParser::parse(self.page_json.clone());
        let page = p.borrow_mut().value();
        lap("parse");
        let root = EVGElement::create_div();
        root.borrow_mut().width = Some(EVGUnit::px(self.w));
        root.borrow_mut().height = Some(EVGUnit::px(self.h));
        EVGElement::set_attribute(&root, "white-space", "nowrap".to_string());
        EVGElement::set_attribute(&root, "font-family", "Arial".to_string());
        let b = DomView::build(&page, 0, self.w, self.h);
        lap("build");
        EVGElement::add_child(&root, b.clone());
        let lay = Rc::new(RefCell::new(EVGLayout::new()));
        EVGLayout::set_page_size(&lay, self.w, self.h);
        EVGLayout::layout(&lay, root.clone());
        lap("evg");
        DomView::settle(&b);
        lap("settle");
        let boxes = DomView::boxes(&b, 0);
        lap("boxes");
        self.exec(&format!("__layout({})", quote(&format!("{{\"boxes\":{}}}", boxes))));
        lap("realm __layout");
        self.root = Some(root);
        self.lay = Some(lay);
        boxes
    }
    /// the laid-out page as EVG's display list (JSON)
    pub fn paint(&mut self) -> String {
        let (Some(root), Some(lay)) = (self.root.clone(), self.lay.clone()) else { return String::new() };
        let dl = Rc::new(RefCell::new(EVGDisplayList::new()));
        EVGDisplayList::set_text_engine(&dl, EVGLayout::get_text_engine(&lay));
        EVGDisplayList::build(&dl, root);
        EVGDisplayList::to_json(&dl)
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
