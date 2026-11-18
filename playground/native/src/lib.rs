// SPDX-License-Identifier: MIT
//
// The RangerDOM playground as a desktop program: a case of bench/ (a real UI
// library's page) runs in RangerDOM (CEr with webapi.js, laid out by EVG
// through the view) and is drawn in an SDL3 window. The bar above the page
// changes the case and runs the case's steps; the mouse, wheel and keys go
// to the page.
//
//   rangerdom-demo [cases dir] [--case NAME] [--size W,H]
//   rangerdom-demo --case shadcn --steps 3 --screenshot out.bmp   (headless)
//
// Keys: Ctrl/Cmd+N next step, Ctrl/Cmd+A all steps, Ctrl/Cmd+] / [ next /
// previous case, Ctrl/Cmd+R reload, Ctrl/Cmd+Q quit.

mod paint;
mod sdl;
mod svgpic;

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Instant;

use ranger::cell::RefCell;
use rangerdom_pg::Playground;
use rangerevg::EVGDisplayList;

const BAR: f32 = 40.0;

struct Case {
    name: String,
    area: String,
}

/// the strings of a JSON array of strings (or of objects' "name"/"area")
fn json_strings(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '"' {
            let mut t = String::new();
            i += 1;
            while i < b.len() && b[i] != '"' {
                if b[i] == '\\' && i + 1 < b.len() {
                    i += 1;
                    match b[i] {
                        'n' => t.push('\n'),
                        't' => t.push('\t'),
                        'u' if i + 4 < b.len() => {
                            let h: String = b[i + 1..i + 5].iter().collect();
                            if let Some(c) = u32::from_str_radix(&h, 16).ok().and_then(char::from_u32) { t.push(c); }
                            i += 4;
                        }
                        c => t.push(c),
                    }
                } else {
                    t.push(b[i]);
                }
                i += 1;
            }
            out.push(t);
        }
        i += 1;
    }
    out
}

fn read_cases(dir: &Path) -> Vec<Case> {
    let Ok(text) = std::fs::read_to_string(dir.join("index.json")) else { return Vec::new() };
    // [{"name": "...", "area": "...", ...}, ...]
    let toks = json_strings(&text);
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < toks.len() {
        if toks[i] == "name" {
            let name = toks[i + 1].clone();
            let mut area = String::new();
            if i + 3 < toks.len() && toks[i + 2] == "area" { area = toks[i + 3].clone(); }
            if dir.join(&name).join("index.html").exists() { out.push(Case { name, area }); }
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

fn find_cases(arg: Option<&str>) -> Option<PathBuf> {
    let mut tries: Vec<PathBuf> = Vec::new();
    if let Some(a) = arg { tries.push(PathBuf::from(a)); }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            tries.push(d.join("cases"));
            tries.push(d.join("../Resources/cases"));
        }
    }
    tries.push(PathBuf::from("cases"));
    tries.push(PathBuf::from("playground/dist/cases"));
    tries.into_iter().find(|p| p.join("index.json").exists())
}

fn esc(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// the DOM's name of a key SDL gives without text
fn key_name(k: u32) -> Option<&'static str> {
    Some(match k {
        0x0d => "Enter",
        0x1b => "Escape",
        0x08 => "Backspace",
        0x09 => "Tab",
        0x7f => "Delete",
        0x4000004f => "ArrowRight",
        0x40000050 => "ArrowLeft",
        0x40000051 => "ArrowDown",
        0x40000052 => "ArrowUp",
        0x4000004a => "Home",
        0x4000004d => "End",
        0x4000004b => "PageUp",
        0x4000004e => "PageDown",
        0x400000e1 | 0x400000e5 => "Shift",
        0x400000e0 | 0x400000e4 => "Control",
        0x400000e2 | 0x400000e6 => "Alt",
        0x400000e3 | 0x400000e7 => "Meta",
        _ => return None,
    })
}

struct App {
    dir: PathBuf,
    cases: Vec<Case>,
    ci: usize,
    pg: Option<Playground>,
    list: Option<Rc<RefCell<EVGDisplayList>>>,
    steps: Vec<String>,
    next: usize,
    /// the step running: its number and when it started; and "run all"
    running: Option<(usize, Instant)>,
    run_all: bool,
    status: String,
    w: f32,
    h: f32,
    /// last frame's times (render, layout, paint, draw) in ms
    times: [f64; 4],
    clock: Instant,
    buttons: Vec<(f32, f32, f32, f32, &'static str)>,
    /// render trees (JSON) that name SVG pictures, for the painter
    render_json: Vec<String>,
}

impl App {
    fn page_size(&self) -> (f64, f64) { (self.w as f64, (self.h - BAR).max(50.0) as f64) }

    fn load(&mut self, idx: usize) {
        self.ci = idx;
        self.list = None;
        self.steps.clear();
        self.next = 0;
        self.running = None;
        self.run_all = false;
        let name = self.cases[idx].name.clone();
        let dir = self.dir.join(&name);
        let html = std::fs::read_to_string(dir.join("index.html")).unwrap_or_default();
        let t = Instant::now();
        let mut pg = Playground::new();
        let base = format!("http://localhost/cases/{}/", name);
        for cap in html.split("<script src=\"").skip(1) {
            let Some(e) = cap.find('"') else { continue };
            let src = &cap[..e];
            let text = std::fs::read_to_string(dir.join(src)).unwrap_or_default();
            pg.add_script(&format!("{}{}", base, src), &text);
        }
        let (w, h) = self.page_size();
        pg.start(&html, &format!("{}index.html", base), w, h);
        pg.run_scripts();
        let started = run_sync(&mut pg, "__bench.start()", &mut self.render_json);
        if let Some(at) = started.find("\"steps\":[") {
            let rest = &started[at + 9..];
            let end = rest.find(']').unwrap_or(rest.len());
            self.steps = json_strings(&rest[..end]);
        }
        self.status = format!("loaded in {} ms, {} steps", t.elapsed().as_millis(), self.steps.len());
        for e in pg.errors.iter().take(3) { eprintln!("{}: {}", name, e); }
        self.pg = Some(pg);
        self.clock = Instant::now();
        self.frame_list();
    }

    fn frame_list(&mut self) {
        let Some(pg) = self.pg.as_mut() else { return };
        let t = Instant::now();
        let tree = pg.render();
        if tree.contains("data:image/svg") { self.render_json.push(tree); }
        let t1 = Instant::now();
        pg.layout();
        let t2 = Instant::now();
        self.list = pg.paint_list();
        let t3 = Instant::now();
        self.times[0] = (t1 - t).as_secs_f64() * 1e3;
        self.times[1] = (t2 - t1).as_secs_f64() * 1e3;
        self.times[2] = (t3 - t2).as_secs_f64() * 1e3;
    }

    fn start_step(&mut self) {
        if self.running.is_some() || self.next >= self.steps.len() { return; }
        let Some(pg) = self.pg.as_mut() else { return };
        let k = self.next;
        self.next += 1;
        pg.value(&format!("window.__pgDone=''; (__bench.run({})).then(function(r){{__pgDone=JSON.stringify(r)}}, function(e){{__pgDone=JSON.stringify({{error:String(e)}})}})", k));
        self.running = Some((k, Instant::now()));
        self.status = format!("step {}/{}: {} …", k + 1, self.steps.len(), self.steps[k]);
    }

    /// the running step done? (its promise settled)
    fn poll_step(&mut self) -> bool {
        let Some((k, t)) = self.running else { return false };
        let Some(pg) = self.pg.as_mut() else { return false };
        let r = pg.value("__pgDone");
        if r.is_empty() { return false; }
        self.running = None;
        let ok = if r.contains("\"error\"") { "failed" } else { "done" };
        self.status = format!("step {}/{} {} in {} ms: {}", k + 1, self.steps.len(), ok, t.elapsed().as_millis(), self.steps[k]);
        if self.run_all { if self.next < self.steps.len() { self.start_step(); } else { self.run_all = false; } }
        true
    }

    fn input(&mut self, json: String) {
        if let Some(pg) = self.pg.as_mut() {
            pg.input(&json);
            let _ = pg.messages();
        }
    }

    fn draw(&mut self, p: &mut paint::Painter) {
        let t = Instant::now();
        p.begin();
        unsafe {
            sdl::SDL_SetRenderDrawColor(p.ren, 255, 255, 255, 255);
            sdl::SDL_RenderClear(p.ren);
        }
        for t in std::mem::take(&mut self.render_json) { p.pictures.scan(&t); }
        if let Some(dl) = self.list.clone() {
            p.top = BAR;
            p.clip_window(0.0, BAR, self.w, self.h - BAR);
            p.draw_list(&dl);
        }
        p.top = 0.0;
        p.unclip();
        // (pictures the list named that no render tree showed, as a forced
        // layout's tree never comes here: asked of the page, then drawn again)
        if !p.pictures.missing.is_empty() {
            let miss = std::mem::take(&mut p.pictures.missing);
            for m in miss { p.pictures.asked.insert(m); }
            let vals = self.pg.as_mut().map(|pg| pg.value(svgpic::PAGE_QUERY)).unwrap_or_default();
            if p.pictures.add_values(&vals) > 0 {
                if let Some(dl) = self.list.clone() {
                    p.begin();
                    unsafe { sdl::SDL_SetRenderDrawColor(p.ren, 255, 255, 255, 255); sdl::SDL_RenderClear(p.ren); }
                    p.top = BAR;
                    p.clip_window(0.0, BAR, self.w, self.h - BAR);
                    p.draw_list(&dl);
                    p.top = 0.0;
                    p.unclip();
                    p.pictures.missing.clear();
                }
            }
        }
        self.bar(p);
        p.flush();
        self.times[3] = t.elapsed().as_secs_f64() * 1e3;
    }

    fn bar(&mut self, p: &mut paint::Painter) {
        let (w, _) = (self.w, self.h);
        p.fill(0.0, 0.0, w, BAR, 0.0, [0.13, 0.15, 0.19, 1.0]);
        p.fill(0.0, BAR - 1.0, w, 1.0, 0.0, [0.3, 0.33, 0.4, 1.0]);
        self.buttons.clear();
        let white = [1.0, 1.0, 1.0, 1.0];
        let dim = [0.7, 0.74, 0.8, 1.0];
        let mut x = 8.0;
        let mut button = |p: &mut paint::Painter, x: &mut f32, label: &str, id: &'static str, on: bool, btns: &mut Vec<(f32, f32, f32, f32, &'static str)>| {
            let tw = p.measure(label, 13.0, true);
            let bw = tw + 20.0;
            p.fill(*x, 7.0, bw, 26.0, 5.0, if on { [0.25, 0.42, 0.85, 1.0] } else { [0.24, 0.27, 0.33, 1.0] });
            p.label(label, *x + 10.0, 12.0, 13.0, true, if on { white } else { dim });
            btns.push((*x, 7.0, bw, 26.0, id));
            *x += bw + 6.0;
        };
        let mut btns = Vec::new();
        button(p, &mut x, "‹", "prev", true, &mut btns);
        let name = if self.cases.is_empty() { "no cases".to_string() } else { format!("{} ({}/{})", self.cases[self.ci].name, self.ci + 1, self.cases.len()) };
        let nw = p.label(&name, x + 2.0, 11.0, 15.0, true, white);
        x += nw.max(150.0) + 10.0;
        button(p, &mut x, "›", "next", true, &mut btns);
        x += 10.0;
        let can = self.running.is_none() && self.next < self.steps.len();
        button(p, &mut x, "Next step", "step", can, &mut btns);
        button(p, &mut x, "All steps", "all", can, &mut btns);
        button(p, &mut x, "Reload", "reload", true, &mut btns);
        x += 8.0;
        let area = if self.cases.is_empty() { String::new() } else { self.cases[self.ci].area.clone() };
        let status = format!("{} · {}", area, self.status);
        p.label(&status, x, 13.0, 12.0, false, dim);
        let t = format!("render {:.0} · layout {:.0} · paint {:.0} · draw {:.0} ms", self.times[0], self.times[1], self.times[2], self.times[3]);
        let tw = p.measure(&t, 11.0, false);
        if w - tw - 10.0 > x + p.measure(&status, 12.0, false) + 20.0 { p.label(&t, w - tw - 10.0, 14.0, 11.0, false, [0.55, 0.6, 0.66, 1.0]); }
        self.buttons = btns;
    }

    fn click_bar(&mut self, x: f32, y: f32) -> bool {
        let hit = self.buttons.iter().find(|b| x >= b.0 && x <= b.0 + b.2 && y >= b.1 && y <= b.1 + b.3).map(|b| b.4);
        match hit {
            Some("prev") => { let n = self.cases.len(); if n > 0 { self.load((self.ci + n - 1) % n); } }
            Some("next") => { let n = self.cases.len(); if n > 0 { self.load((self.ci + 1) % n); } }
            Some("step") => self.start_step(),
            Some("all") => { self.run_all = true; self.start_step(); }
            Some("reload") => self.load(self.ci),
            _ => return false,
        }
        true
    }
}

/// a page promise run to its end: ticks and frames until it settles
fn run_sync(pg: &mut Playground, call: &str, trees: &mut Vec<String>) -> String {
    pg.value(&format!("window.__pgDone=''; ({}).then(function(r){{__pgDone=JSON.stringify(r)}}, function(e){{__pgDone=JSON.stringify({{error:String(e)}})}})", call));
    let mut i = 0;
    while i < 2000 && pg.value("__pgDone").is_empty() {
        pg.tick(16.0);
        if pg.dirty() { let t = pg.render(); if t.contains("data:image/svg") { trees.push(t); } pg.layout(); }
        i += 1;
    }
    pg.value("__pgDone")
}

/// the program (main.rs; or a host's main that links the static library)
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let mut dir_arg: Option<String> = None;
    let mut case: Option<String> = None;
    let mut shot: Option<String> = None;
    let mut steps: usize = 0;
    // (headless: script run after the steps, frames, then a value printed)
    let mut eval: Option<String> = None;
    let mut print: Option<String> = None;
    // (headless: text typed a character a frame, each frame saved beside
    // the screenshot as <out>.<n>.bmp)
    let mut typed: Option<String> = None;
    let (mut ww, mut wh) = (1200.0f32, 800.0f32 + BAR);
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        let v = args.get(i + 1).cloned();
        match a {
            "--case" => { case = v; i += 1; }
            "--screenshot" => { shot = v; i += 1; }
            "--eval" => { eval = v; i += 1; }
            "--print" => { print = v; i += 1; }
            "--type" => { typed = v; i += 1; }
            "--steps" => { steps = v.and_then(|s| s.parse().ok()).unwrap_or(0); i += 1; }
            "--size" => {
                if let Some((w, h)) = v.as_deref().and_then(|s| s.split_once(',')) { ww = w.parse().unwrap_or(ww); wh = h.parse::<f32>().unwrap_or(800.0) + BAR; }
                i += 1;
            }
            "-h" | "--help" => {
                println!("rangerdom-demo [cases dir] [--case NAME] [--size W,H] [--steps N --screenshot out.bmp]");
                return;
            }
            _ if !a.starts_with('-') => dir_arg = Some(a.to_string()),
            _ => {}
        }
        i += 1;
    }
    let Some(dir) = find_cases(dir_arg.as_deref()) else {
        eprintln!("no cases (a directory with index.json): give it as the first argument");
        std::process::exit(2);
    };
    let cases = read_cases(&dir);
    if cases.is_empty() { eprintln!("no cases in {}", dir.display()); std::process::exit(2); }
    let ci = case.as_ref().and_then(|c| cases.iter().position(|x| &x.name == c)).unwrap_or(0);

    unsafe {
        // (headless: the offscreen driver where it has GL through EGL; macOS has
        // no EGL, a hidden Cocoa window with Metal draws there)
        if shot.is_some() && !cfg!(target_os = "macos") && std::env::var("SDL_VIDEO_DRIVER").is_err() {
            sdl::SDL_SetHint(sdl::cstr("SDL_VIDEO_DRIVER").as_ptr(), sdl::cstr("offscreen").as_ptr());
        }
        if !sdl::SDL_Init(sdl::INIT_VIDEO) { eprintln!("SDL_Init: {}", sdl::error()); std::process::exit(1); }
    }
    let flags = sdl::WINDOW_RESIZABLE | sdl::WINDOW_HIGH_PIXEL_DENSITY | if shot.is_some() { sdl::WINDOW_HIDDEN } else { 0 };
    let win = unsafe { sdl::SDL_CreateWindow(sdl::cstr("RangerDOM").as_ptr(), ww as i32, wh as i32, flags) };
    if win.is_null() { eprintln!("SDL_CreateWindow: {}", sdl::error()); std::process::exit(1); }
    let ren = unsafe { sdl::SDL_CreateRenderer(win, std::ptr::null()) };
    if ren.is_null() { eprintln!("SDL_CreateRenderer: {}", sdl::error()); std::process::exit(1); }
    unsafe {
        sdl::SDL_SetRenderVSync(ren, 1);
        // (untextured triangles blend by the renderer's draw mode, NONE by default)
        sdl::SDL_SetRenderDrawBlendMode(ren, sdl::BLENDMODE_BLEND);
        eprintln!("renderer: {}", std::ffi::CStr::from_ptr(sdl::SDL_GetRendererName(ren)).to_string_lossy());
        sdl::SDL_StartTextInput(win);
    }
    let mut painter = paint::Painter::new(ren);
    if !painter.has_font() { eprintln!("no sans-serif TrueType face found (RANGERDOM_FONT_DIR=dir with sans.ttf)"); }
    let size = |win: *mut sdl::Window| unsafe {
        let (mut w, mut h, mut pw, mut ph) = (0, 0, 0, 0);
        sdl::SDL_GetWindowSize(win, &mut w, &mut h);
        sdl::SDL_GetWindowSizeInPixels(win, &mut pw, &mut ph);
        (w as f32, h as f32, if w > 0 { pw as f32 / w as f32 } else { 1.0 })
    };
    let (w0, h0, s0) = size(win);
    painter.s = s0;
    let mut app = App {
        dir, cases, ci, pg: None, list: None, steps: Vec::new(), next: 0, running: None, run_all: false,
        status: String::new(), w: w0, h: h0, times: [0.0; 4], clock: Instant::now(), buttons: Vec::new(), render_json: Vec::new(),
    };
    // (the bar first, so a slow case shows that it is loading)
    app.status = "loading…".into();
    app.draw(&mut painter);
    unsafe { sdl::SDL_RenderPresent(ren); }
    app.load(app.ci);

    if let Some(out) = shot {
        let t = Instant::now();
        for k in 0..steps.min(app.steps.len()) {
            let pg = app.pg.as_mut().unwrap();
            let r = run_sync(pg, &format!("__bench.run({})", k), &mut app.render_json);
            println!("step {}: {}", k, r.chars().take(100).collect::<String>());
        }
        app.next = steps.min(app.steps.len());
        if let Some(js) = &eval {
            let pg = app.pg.as_mut().unwrap();
            pg.value(js);
            for _ in 0..40 { pg.tick(16.0); if pg.dirty() { let t = pg.render(); if t.contains("data:image/svg") { app.render_json.push(t); } pg.layout(); } }
        }
        if let Some(tx) = &typed {
            for (n, ch) in tx.chars().enumerate() {
                let q = if ch == '"' || ch == '\\' { format!("\\{}", ch) } else { ch.to_string() };
                app.input(format!("{{\"type\":\"text\",\"text\":\"{}\"}}", q));
                app.pg.as_mut().unwrap().tick(16.0);
                app.frame_list();
                app.draw(&mut painter);
                unsafe {
                    let s = sdl::SDL_RenderReadPixels(ren, std::ptr::null());
                    if !s.is_null() { sdl::SDL_SaveBMP(s, sdl::cstr(&format!("{}.{}.bmp", out, n)).as_ptr()); sdl::SDL_DestroySurface(s); }
                }
            }
        }
        if let Some(js) = &print { println!("{}", app.pg.as_mut().unwrap().value(js)); }
        app.frame_list();
        app.draw(&mut painter);
        println!("steps {:?}; last frame render {:.1} layout {:.1} paint {:.1} draw {:.1} ms; {} shapes {} text runs",
            t.elapsed(), app.times[0], app.times[1], app.times[2], app.times[3], painter.stats.0, painter.stats.1);
        unsafe {
            let s = sdl::SDL_RenderReadPixels(ren, std::ptr::null());
            if s.is_null() || !sdl::SDL_SaveBMP(s, sdl::cstr(&out).as_ptr()) { eprintln!("screenshot: {}", sdl::error()); }
            if !s.is_null() { sdl::SDL_DestroySurface(s); }
            sdl::SDL_Quit();
        }
        return;
    }

    let cursors = unsafe { [sdl::SDL_CreateSystemCursor(sdl::SYSTEM_CURSOR_DEFAULT), sdl::SDL_CreateSystemCursor(sdl::SYSTEM_CURSOR_POINTER), sdl::SDL_CreateSystemCursor(sdl::SYSTEM_CURSOR_TEXT)] };
    let mut cur_cursor = 0usize;
    let mut ev = sdl::Event::new();
    let mut redraw = true;
    let mut moved = false;
    let mut title = String::new();
    'main: loop {
        // wait for an event, or for the page's next timer
        let busy = app.running.is_some();
        let due = app.pg.as_mut().map(|p| p.due_in()).unwrap_or(-1.0);
        let wait = if busy || redraw { 0 } else if due >= 0.0 { (due as i32).clamp(0, 100) } else { 100 };
        let mut got = unsafe { if wait > 0 { sdl::SDL_WaitEventTimeout(&mut ev, wait) } else { sdl::SDL_PollEvent(&mut ev) } };
        while got {
            let gui = |m: u16| m & (sdl::KMOD_CTRL | sdl::KMOD_GUI) != 0;
            match ev.kind() {
                sdl::EVENT_QUIT => break 'main,
                sdl::EVENT_WINDOW_RESIZED | sdl::EVENT_WINDOW_PIXEL_SIZE_CHANGED | sdl::EVENT_WINDOW_DISPLAY_SCALE_CHANGED => {
                    let (w, h, s) = size(win);
                    if w != app.w || h != app.h {
                        app.w = w;
                        app.h = h;
                        let (pw, ph) = app.page_size();
                        if let Some(pg) = app.pg.as_mut() { pg.resize(pw, ph); }
                        app.frame_list();
                    }
                    painter.s = s;
                    redraw = true;
                }
                sdl::EVENT_WINDOW_MOUSE_LEAVE => app.input("{\"type\":\"leave\"}".into()),
                sdl::EVENT_MOUSE_MOTION => {
                    let (x, y) = (ev.f32(28), ev.f32(32));
                    if y >= BAR { app.input(format!("{{\"type\":\"move\",\"x\":{},\"y\":{},\"button\":0}}", x, y - BAR)); moved = true; }
                }
                sdl::EVENT_MOUSE_BUTTON_DOWN | sdl::EVENT_MOUSE_BUTTON_UP => {
                    let down = ev.kind() == sdl::EVENT_MOUSE_BUTTON_DOWN;
                    let b = ev.raw[24];
                    let (x, y) = (ev.f32(28), ev.f32(32));
                    if y < BAR {
                        if down && b == 1 && app.click_bar(x, y) { redraw = true; }
                    } else {
                        let button = match b { 2 => 1, 3 => 2, _ => 0 };
                        let t = unsafe { sdl::SDL_GetTicks() };
                        app.input(format!("{{\"type\":\"{}\",\"x\":{},\"y\":{},\"t\":{},\"button\":{}}}", if down { "down" } else { "up" }, x, y - BAR, t, button));
                    }
                }
                sdl::EVENT_MOUSE_WHEEL => {
                    // (as the system gives it, with natural scrolling in it, as a
                    // browser's deltaY: SDL's FLIPPED only says that it is in)
                    let (dx, dy) = (ev.f32(24), ev.f32(28));
                    let (x, y) = (ev.f32(36), ev.f32(40));
                    if y >= BAR { app.input(format!("{{\"type\":\"wheel\",\"x\":{},\"y\":{},\"dx\":{},\"dy\":{}}}", x, y - BAR, dx * 40.0, -dy * 40.0)); }
                }
                sdl::EVENT_KEY_DOWN | sdl::EVENT_KEY_UP => {
                    let down = ev.kind() == sdl::EVENT_KEY_DOWN;
                    let key = ev.u32(28);
                    let m = ev.u16(32);
                    if down && gui(m) {
                        let used = match key {
                            0x6e => { app.start_step(); true } // n
                            0x61 => { app.run_all = true; app.start_step(); true } // a
                            0x5d => { let n = app.cases.len(); app.load((app.ci + 1) % n); true } // ]
                            0x5b => { let n = app.cases.len(); app.load((app.ci + n - 1) % n); true } // [
                            0x72 => { app.load(app.ci); true } // r
                            0x71 | 0x77 => break 'main, // q, w
                            _ => false,
                        };
                        if used { redraw = true; got = unsafe { sdl::SDL_PollEvent(&mut ev) }; continue; }
                    }
                    let name: Option<String> = match key_name(key) {
                        Some(n) => Some(n.to_string()),
                        // (a printable key comes as text, unless a modifier made it a shortcut)
                        None if !down || gui(m) => char::from_u32(key).filter(|c| !c.is_control()).map(|c| c.to_string()),
                        None => None,
                    };
                    if let Some(n) = name {
                        let typ = if down { "key" } else { "keyup" };
                        app.input(format!("{{\"type\":\"{}\",\"key\":{},\"code\":\"\",\"shift\":{},\"ctrl\":{},\"alt\":{},\"meta\":{}}}", typ, esc(&n),
                            m & sdl::KMOD_SHIFT != 0, m & sdl::KMOD_CTRL != 0, m & sdl::KMOD_ALT != 0, m & sdl::KMOD_GUI != 0));
                    }
                }
                sdl::EVENT_TEXT_INPUT => {
                    let p = ev.ptr(24);
                    if !p.is_null() {
                        let text = unsafe { std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned() };
                        for ch in text.chars() {
                            app.input(format!("{{\"type\":\"key\",\"key\":{},\"code\":\"\",\"shift\":false,\"ctrl\":false,\"alt\":false,\"meta\":false}}", esc(&ch.to_string())));
                        }
                    }
                }
                _ => {}
            }
            got = unsafe { sdl::SDL_PollEvent(&mut ev) };
        }
        // the page's clock
        let now = Instant::now();
        let ms = (now - app.clock).as_secs_f64() * 1e3;
        app.clock = now;
        if let Some(pg) = app.pg.as_mut() { pg.tick(ms); }
        if app.poll_step() { redraw = true; }
        if moved {
            moved = false;
            let c = app.pg.as_mut().map(|p| p.value("__cursor()")).unwrap_or_default();
            let want = match c.as_str() { "pointer" => 1, "text" => 2, _ => 0 };
            if want != cur_cursor { cur_cursor = want; unsafe { sdl::SDL_SetCursor(cursors[want]); } }
        }
        let dirty = app.pg.as_mut().map(|p| p.dirty()).unwrap_or(false);
        if dirty { app.frame_list(); redraw = true; }
        if redraw {
            app.draw(&mut painter);
            unsafe { sdl::SDL_RenderPresent(ren); }
            redraw = false;
            let t = format!("RangerDOM · {}", app.cases[app.ci].name);
            if t != title { unsafe { sdl::SDL_SetWindowTitle(win, sdl::cstr(&t).as_ptr()); } title = t; }
        }
    }
    unsafe { sdl::SDL_Quit(); }
}

/// the program for a C main (the static library linked on macOS)
#[no_mangle]
pub extern "C" fn rangerdom_demo_main() -> i32 {
    run();
    0
}
