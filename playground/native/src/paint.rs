// SPDX-License-Identifier: MIT
//
// EVG's display list drawn with SDL3's renderer: boxes and borders (rounded,
// two-stop gradients, soft shadows) as triangles, text runs and filled paths
// rasterized here into textures (ttf.rs), strokes as triangles, clips as
// the renderer's clip rectangle, group opacity as an alpha factor. Pictures
// (IMAGE) are drawn when they are SVG background pictures (svgpic.rs). Every coordinate the list gives is in CSS
// pixels; the painter works in the window's own pixels (`s` per CSS px).

use std::collections::HashMap;
use std::ffi::c_int;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use ranger::cell::RefCell;
use rangerevg::{EVGDisplayList, EVGDrawCmd};

use crate::sdl::{self, Rect, Renderer, Texture, Vertex};
use crate::svgpic::{self, Pictures};
use crate::ttf::{self, Face, Raster};

const RECT: i64 = 0;
const BORDER: i64 = 1;
const IMAGE: i64 = 2;
const TEXT: i64 = 3;
const PUSH_CLIP: i64 = 4;
const POP_CLIP: i64 = 5;
const PATH: i64 = 6;
const STROKE: i64 = 7;
const GROUP_OPEN: i64 = 8;
const GROUP_CLOSE: i64 = 9;

pub struct Fonts {
    pub sans: Option<Face>,
    pub bold: Option<Face>,
    pub mono: Option<Face>,
    pub fallback: Vec<Face>,
}

fn load_first(paths: &[&str]) -> Option<Face> {
    let dir = std::env::var("RANGERDOM_FONT_DIR").ok();
    for p in paths {
        let full = match (&dir, p.starts_with('/') || p.contains(':')) {
            (Some(d), false) => format!("{}/{}", d, p),
            _ => p.to_string(),
        };
        if let Ok(data) = std::fs::read(&full) {
            if let Some(f) = Face::parse(data) { return Some(f); }
        }
    }
    None
}

impl Fonts {
    /// Arial first (what EVG's table measures), then faces with Arial's
    /// widths (Liberation Sans, Arimo), then whatever sans the system has;
    /// a run is stretched to the width the layout measured anyway.
    pub fn load() -> Fonts {
        let sans = load_first(&[
            "sans.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
            "/usr/share/fonts/truetype/msttcorefonts/Arial.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/croscore/Arimo-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "C:\\Windows\\Fonts\\arial.ttf",
        ]);
        let bold = load_first(&[
            "sans-bold.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf",
            "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            "/usr/share/fonts/truetype/croscore/Arimo-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "C:\\Windows\\Fonts\\arialbd.ttf",
        ]);
        let mono = load_first(&[
            "mono.ttf",
            "/System/Library/Fonts/Supplemental/Courier New.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "C:\\Windows\\Fonts\\cour.ttf",
        ]);
        let mut fallback = Vec::new();
        for p in [
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "C:\\Windows\\Fonts\\seguisym.ttf",
        ] {
            if let Some(f) = load_first(&[p]) { fallback.push(f); }
        }
        Fonts { sans, bold, mono, fallback }
    }
}

struct Tex {
    t: *mut Texture,
    /// size in window pixels, and where the anchor (pen start, baseline) is
    /// inside the bitmap
    w: f32,
    h: f32,
    ox: f32,
    oy: f32,
    used: u64,
}

#[derive(Clone, Copy)]
struct Clip { x0: f32, y0: f32, x1: f32, y1: f32 }

pub struct Painter {
    pub ren: *mut Renderer,
    /// window pixels per CSS pixel
    pub s: f32,
    /// where the page starts in the window (CSS px, below the bar)
    pub top: f32,
    fonts: Fonts,
    texts: HashMap<String, Tex>,
    paths: HashMap<u64, Tex>,
    pics: HashMap<String, Tex>,
    pub pictures: Pictures,
    frame: u64,
    verts: Vec<Vertex>,
    idx: Vec<c_int>,
    clips: Vec<Option<Clip>>,
    clip: Option<Clip>,
    alphas: Vec<f32>,
    alpha: f32,
    pub stats: (usize, usize),
}

fn col(r: i64, g: i64, b: i64, a: f64) -> [f32; 4] { [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, a as f32] }

impl Painter {
    pub fn new(ren: *mut Renderer) -> Painter {
        Painter {
            ren, s: 1.0, top: 0.0, fonts: Fonts::load(), texts: HashMap::new(), paths: HashMap::new(), pics: HashMap::new(), pictures: Pictures::default(), frame: 0,
            verts: Vec::new(), idx: Vec::new(), clips: Vec::new(), clip: None, alphas: Vec::new(), alpha: 1.0, stats: (0, 0),
        }
    }

    pub fn has_font(&self) -> bool { self.fonts.sans.is_some() }

    /// the start of a frame: what the last frames did not use goes
    pub fn begin(&mut self) {
        self.frame += 1;
        let f = self.frame;
        if self.frame % 30 == 0 || self.texts.len() > 6000 {
            let keep = if self.texts.len() > 6000 { 2 } else { 90 };
            self.texts.retain(|_, t| { let k = f - t.used <= keep; if !k { unsafe { sdl::SDL_DestroyTexture(t.t) } } k });
            self.paths.retain(|_, t| { let k = f - t.used <= keep; if !k { unsafe { sdl::SDL_DestroyTexture(t.t) } } k });
            self.pics.retain(|_, t| { let k = f - t.used <= keep; if !k { unsafe { sdl::SDL_DestroyTexture(t.t) } } k });
        }
        self.clips.clear();
        self.clip = None;
        self.alphas.clear();
        self.alpha = 1.0;
        self.stats = (0, 0);
        unsafe { sdl::SDL_SetRenderClipRect(self.ren, std::ptr::null()); }
    }

    fn px(&self, x: f64, y: f64) -> (f32, f32) { (x as f32 * self.s, (y as f32 + self.top) * self.s) }

    pub fn flush(&mut self) {
        if self.idx.is_empty() { return; }
        unsafe { sdl::SDL_RenderGeometry(self.ren, std::ptr::null_mut(), self.verts.as_ptr(), self.verts.len() as c_int, self.idx.as_ptr(), self.idx.len() as c_int); }
        self.verts.clear();
        self.idx.clear();
    }

    fn set_clip(&mut self, c: Option<Clip>) {
        self.flush();
        self.clip = c;
        unsafe {
            match c {
                None => { sdl::SDL_SetRenderClipRect(self.ren, std::ptr::null()); }
                Some(c) => {
                    let r = Rect { x: c.x0.floor() as c_int, y: c.y0.floor() as c_int, w: ((c.x1.ceil() - c.x0.floor()).max(0.0)) as c_int, h: ((c.y1.ceil() - c.y0.floor()).max(0.0)) as c_int };
                    sdl::SDL_SetRenderClipRect(self.ren, &r);
                }
            }
        }
    }

    /// a clip of the window's own (the bar, the page), in CSS px of the window
    pub fn clip_window(&mut self, x: f32, y: f32, w: f32, h: f32) {
        let s = self.s;
        self.set_clip(Some(Clip { x0: x * s, y0: y * s, x1: (x + w) * s, y1: (y + h) * s }));
    }
    pub fn unclip(&mut self) { self.set_clip(None); }

    fn tri_fan(&mut self, pts: &[(f32, f32)], center: (f32, f32), color: &dyn Fn(f32, f32) -> [f32; 4]) {
        let base = self.verts.len() as c_int;
        let a = self.alpha;
        let v = |x: f32, y: f32, c: [f32; 4]| Vertex { x, y, r: c[0], g: c[1], b: c[2], a: c[3] * a, u: 0.0, v: 0.0 };
        self.verts.push(v(center.0, center.1, color(center.0, center.1)));
        for p in pts { self.verts.push(v(p.0, p.1, color(p.0, p.1))); }
        let n = pts.len() as c_int;
        for i in 0..n {
            self.idx.extend_from_slice(&[base, base + 1 + i, base + 1 + (i + 1) % n]);
        }
    }

    fn tri_strip_ring(&mut self, outer: &[(f32, f32)], inner: &[(f32, f32)], c: [f32; 4]) {
        let base = self.verts.len() as c_int;
        let a = self.alpha;
        for (o, i) in outer.iter().zip(inner.iter()) {
            self.verts.push(Vertex { x: o.0, y: o.1, r: c[0], g: c[1], b: c[2], a: c[3] * a, u: 0.0, v: 0.0 });
            self.verts.push(Vertex { x: i.0, y: i.1, r: c[0], g: c[1], b: c[2], a: c[3] * a, u: 0.0, v: 0.0 });
        }
        let n = outer.len().min(inner.len()) as c_int;
        for k in 0..n {
            let (o0, i0, o1, i1) = (base + 2 * k, base + 2 * k + 1, base + 2 * ((k + 1) % n), base + 2 * ((k + 1) % n) + 1);
            self.idx.extend_from_slice(&[o0, i0, o1, o1, i0, i1]);
        }
    }

    fn quad(&mut self, p: [(f32, f32); 4], c: [f32; 4]) {
        let base = self.verts.len() as c_int;
        let a = self.alpha;
        for q in p { self.verts.push(Vertex { x: q.0, y: q.1, r: c[0], g: c[1], b: c[2], a: c[3] * a, u: 0.0, v: 0.0 }); }
        self.idx.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    /// a rounded box's outline in window pixels, corners TL TR BR BL
    fn rrect(&self, x: f32, y: f32, w: f32, h: f32, r: [f32; 4], segs: usize) -> Vec<(f32, f32)> {
        let m = (w.min(h) / 2.0).max(0.0);
        let r = r.map(|v| v.clamp(0.0, m));
        let mut pts = Vec::with_capacity(4 * (segs + 1));
        let corners = [(x + r[0], y + r[0], r[0], 180.0f32), (x + w - r[1], y + r[1], r[1], 270.0), (x + w - r[2], y + h - r[2], r[2], 0.0), (x + r[3], y + h - r[3], r[3], 90.0)];
        for (cx, cy, rr, a0) in corners {
            for k in 0..=segs {
                let a = (a0 + 90.0 * k as f32 / segs as f32).to_radians();
                pts.push((cx + rr * a.cos(), cy + rr * a.sin()));
            }
        }
        pts
    }

    fn radii(&self, c: &EVGDrawCmd) -> [f32; 4] {
        let s = self.s;
        if c.per_corner { [c.radius as f32 * s, c.radius_tr as f32 * s, c.radius_br as f32 * s, c.radius_bl as f32 * s] } else { [c.radius as f32 * s; 4] }
    }

    fn segs(r: &[f32; 4]) -> usize { let m = r.iter().cloned().fold(0.0f32, f32::max); if m <= 0.5 { 1 } else { ((m * 0.6).ceil() as usize).clamp(2, 16) } }

    /// a filled box (the window's own drawing: the bar)
    pub fn fill(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, c: [f32; 4]) {
        let s = self.s;
        let rr = [r * s; 4];
        let pts = self.rrect(x * s, y * s, w * s, h * s, rr, Self::segs(&rr));
        self.tri_fan(&pts, ((x + w / 2.0) * s, (y + h / 2.0) * s), &|_, _| c);
    }

    fn rotate_from(&mut self, start: usize, c: &EVGDrawCmd) {
        if c.rotate == 0.0 { return; }
        let (px, py) = if c.has_rot_origin { self.px(c.rot_origin_x, c.rot_origin_y) } else { self.px(c.x + c.w / 2.0, c.y + c.h / 2.0) };
        let (sn, cs) = (c.rotate as f32).to_radians().sin_cos();
        for v in &mut self.verts[start..] {
            let (dx, dy) = (v.x - px, v.y - py);
            v.x = px + dx * cs - dy * sn;
            v.y = py + dx * sn + dy * cs;
        }
    }

    pub fn draw_list(&mut self, dl: &Rc<RefCell<EVGDisplayList>>) {
        let cmds = dl.borrow().cmds.clone();
        for c in cmds.iter() {
            let c = c.borrow();
            self.cmd(&c);
        }
        self.flush();
        while let Some(_) = self.clips.pop() {}
        self.set_clip(None);
    }

    fn cmd(&mut self, c: &EVGDrawCmd) {
        match c.kind {
            RECT => {
                let start = self.verts.len();
                let (x, y) = self.px(c.x, c.y);
                let (w, h) = (c.w as f32 * self.s, c.h as f32 * self.s);
                let r = self.radii(c);
                let segs = Self::segs(&r);
                if c.has_shadow && c.shadow_a > 0.0 {
                    let b = c.shadow_blur as f32 * self.s;
                    let (sx, sy) = (c.shadow_x as f32 * self.s, c.shadow_y as f32 * self.s);
                    let sc = col(c.shadow_r, c.shadow_g, c.shadow_b, c.shadow_a);
                    let n = if b > 1.0 { 4 } else { 1 };
                    // (CSS paints an outer shadow only outside the border box: a
                    // ring from the grown box in to the box itself, or a field
                    // with a transparent background shows grey)
                    let inner = self.rrect(x, y, w, h, r, segs.max(4));
                    for i in 0..n {
                        let e = if n == 1 { 0.0 } else { b * 0.6 * (n - i) as f32 / n as f32 };
                        let rr = r.map(|v| (v + e).max(0.0));
                        let pts = self.rrect(x + sx - e, y + sy - e, w + 2.0 * e, h + 2.0 * e, rr, segs.max(4));
                        let k = [sc[0], sc[1], sc[2], sc[3] / n as f32 * if n == 1 { 1.0 } else { 1.2 }];
                        self.tri_strip_ring(&pts, &inner, k);
                    }
                }
                if c.a > 0.0 || (c.has_grad && c.a2 > 0.0) {
                    let pts = self.rrect(x, y, w, h, r, segs);
                    let c1 = col(c.r, c.g, c.b, c.a);
                    if c.has_grad {
                        let c2 = col(c.r2, c.g2, c.b2, c.a2);
                        let across = c.grad_dir == 1;
                        let f = move |px: f32, py: f32| {
                            let t = if across { if w > 0.0 { (px - x) / w } else { 0.0 } } else if h > 0.0 { (py - y) / h } else { 0.0 };
                            let t = t.clamp(0.0, 1.0);
                            [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t, c1[3] + (c2[3] - c1[3]) * t]
                        };
                        self.tri_fan(&pts, (x + w / 2.0, y + h / 2.0), &f);
                    } else {
                        self.tri_fan(&pts, (x + w / 2.0, y + h / 2.0), &|_, _| c1);
                    }
                }
                self.rotate_from(start, c);
                self.stats.0 += 1;
            }
            BORDER => {
                let start = self.verts.len();
                let (x, y) = self.px(c.x, c.y);
                let (w, h) = (c.w as f32 * self.s, c.h as f32 * self.s);
                let t = (if c.thickness > 0.0 { c.thickness } else { 1.0 }) as f32 * self.s;
                let r = self.radii(c);
                let segs = Self::segs(&r);
                let outer = self.rrect(x, y, w, h, r, segs);
                let inner = self.rrect(x + t, y + t, (w - 2.0 * t).max(0.0), (h - 2.0 * t).max(0.0), r.map(|v| (v - t).max(0.0)), segs);
                self.tri_strip_ring(&outer, &inner, col(c.r, c.g, c.b, c.a));
                self.rotate_from(start, c);
                self.stats.0 += 1;
            }
            TEXT => {
                if c.text.is_empty() || c.a <= 0.0 { return; }
                self.text(c);
            }
            PUSH_CLIP => {
                self.clips.push(self.clip);
                let (x0, y0) = self.px(c.x, c.y);
                let (x1, y1) = self.px(c.x + c.w, c.y + c.h);
                let mut n = Clip { x0, y0, x1, y1 };
                // (every clip in force narrows, also a scroll layer's: a list
                // built for this one paint has its layers where they are)
                if let Some(o) = self.clip { n = Clip { x0: n.x0.max(o.x0), y0: n.y0.max(o.y0), x1: n.x1.min(o.x1), y1: n.y1.min(o.y1) }; }
                self.set_clip(Some(n));
            }
            POP_CLIP => {
                let p = self.clips.pop().unwrap_or(None);
                self.set_clip(p);
            }
            GROUP_OPEN => {
                self.alphas.push(self.alpha);
                self.alpha *= c.a as f32;
            }
            GROUP_CLOSE => {
                self.alpha = self.alphas.pop().unwrap_or(1.0);
            }
            PATH => self.path(c),
            STROKE => self.stroke(c),
            IMAGE => self.image(c),
            _ => {}
        }
    }

    /// a picture the page named (an SVG background), in its tile or its box
    fn image(&mut self, c: &EVGDrawCmd) {
        let Some(svg) = self.pictures.svgs.get(&c.src) else {
            if c.src.starts_with("dompng-") && !self.pictures.asked.contains(&c.src) { self.pictures.missing.push(c.src.clone()); }
            return;
        };
        let (bx, by, bw, bh) = match &c.tile { Some(t) => { let t = t.borrow(); (t.x, t.y, t.w, t.h) } None => (c.x, c.y, c.w, c.h) };
        let (x, y) = self.px(bx, by);
        let (w, h) = ((bw as f32 * self.s).round().max(1.0) as usize, (bh as f32 * self.s).round().max(1.0) as usize);
        if w > 4096 || h > 4096 { return; }
        let key = format!("{}|{}|{}", c.src, w, h);
        let frame = self.frame;
        if !self.pics.contains_key(&key) {
            let px = svgpic::rasterize(svg, w, h);
            let Some(t) = self.texture(w, h, &px) else { return };
            self.pics.insert(key.clone(), Tex { t, w: w as f32, h: h as f32, ox: 0.0, oy: 0.0, used: frame });
        }
        let t = self.pics.get_mut(&key).unwrap();
        t.used = frame;
        let (tt, tw, th) = (t.t, t.w, t.h);
        // (the command's alpha fades the picture; its colour does not tint it)
        self.textured(tt, x, y, tw, th, [1.0, 1.0, 1.0, c.a as f32], c, false);
        self.stats.0 += 1;
    }

    fn rings(&self, c: &EVGDrawCmd) -> Vec<Vec<(f32, f32)>> {
        let mut out = Vec::new();
        let mut start = 0usize;
        let ends: Vec<usize> = if c.ring_ends.is_empty() { vec![c.pts.len()] } else { c.ring_ends.iter().map(|e| *e as usize).collect() };
        for e in ends {
            let e = e.min(c.pts.len());
            if e >= start + 4 {
                let mut r = Vec::with_capacity((e - start) / 2);
                let mut i = start;
                while i + 1 < e { r.push(self.px(c.pts[i], c.pts[i + 1])); i += 2; }
                out.push(r);
            }
            start = e;
        }
        out
    }

    fn path(&mut self, c: &EVGDrawCmd) {
        let rings = self.rings(c);
        if rings.is_empty() { return; }
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for r in &rings { for p in r { x0 = x0.min(p.0); y0 = y0.min(p.1); x1 = x1.max(p.0); y1 = y1.max(p.1); } }
        let bx = x0.floor() - 1.0;
        let by = y0.floor() - 1.0;
        let w = (x1.ceil() - bx + 2.0) as usize;
        let h = (y1.ceil() - by + 2.0) as usize;
        if w < 2 || h < 2 || w > 4096 || h > 4096 { return; }
        // (the same shape moved by whole pixels is the same picture)
        let mut hs = std::collections::hash_map::DefaultHasher::new();
        c.even_odd.hash(&mut hs);
        // (`r` on a vector: the rounded box its picture is cut to)
        let cut = if c.radius > 0.0 { let (cx, cy) = self.px(c.x, c.y); Some((cx - bx, cy - by, c.w as f32 * self.s, c.h as f32 * self.s, c.radius as f32 * self.s)) } else { None };
        if let Some(k) = cut { for v in [k.0, k.1, k.2, k.3, k.4] { ((v * 4.0) as i32).hash(&mut hs); } }
        for r in &rings { r.len().hash(&mut hs); for p in r { (((p.0 - bx) * 4.0) as i32).hash(&mut hs); (((p.1 - by) * 4.0) as i32).hash(&mut hs); } }
        let key = hs.finish();
        let frame = self.frame;
        if !self.paths.contains_key(&key) {
            let mut ras = Raster::new(w, h);
            let local: Vec<Vec<(f32, f32)>> = rings.iter().map(|r| r.iter().map(|p| (p.0 - bx, p.1 - by)).collect()).collect();
            ras.rings(&local);
            let mut px = ras.rgba(c.even_odd);
            if let Some(k) = cut { cut_rrect(&mut px, w, h, k); }
            let Some(t) = self.texture(w, h, &px) else { return };
            self.paths.insert(key, Tex { t, w: w as f32, h: h as f32, ox: 0.0, oy: 0.0, used: frame });
        }
        let t = self.paths.get_mut(&key).unwrap();
        t.used = frame;
        let (tt, tw, th) = (t.t, t.w, t.h);
        self.textured(tt, bx, by, tw, th, col(c.r, c.g, c.b, c.a), c, false);
        self.stats.0 += 1;
    }

    fn stroke(&mut self, c: &EVGDrawCmd) {
        let rings = self.rings(c);
        if rings.is_empty() { return; }
        let t = ((if c.thickness > 0.0 { c.thickness } else { 1.0 }) as f32 * self.s).max(0.75);
        let k = col(c.r, c.g, c.b, c.a);
        let dash: Vec<f32> = c.stroke_dash.split(|ch: char| ch == ',' || ch.is_whitespace()).filter_map(|v| v.trim().parse::<f32>().ok()).map(|v| v * self.s).filter(|v| *v >= 0.0).collect();
        let dashed = dash.len() >= 1 && dash.iter().sum::<f32>() > 0.0;
        let start = self.verts.len();
        for r in &rings {
            let pieces = if dashed { dash_ring(r, &dash, c.stroke_dash_offset as f32 * self.s) } else { vec![r.clone()] };
            for p in pieces {
                if p.len() < 2 { continue; }
                for i in 0..p.len() - 1 {
                    let (a, mut b) = (p[i], p[i + 1]);
                    let mut a = a;
                    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                    let l = (dx * dx + dy * dy).sqrt();
                    if l < 1e-4 { continue; }
                    let (ux, uy) = (dx / l, dy / l);
                    // (inner ends reach half a width on, which closes the joins
                    // of thin curves; the line's own ends only with a square cap)
                    let first = i == 0 && p[0] != p[p.len() - 1];
                    let last = i == p.len() - 2 && p[0] != p[p.len() - 1];
                    if !first || c.stroke_cap == 2 { a = (a.0 - ux * t / 2.0, a.1 - uy * t / 2.0); }
                    if !last || c.stroke_cap == 2 { b = (b.0 + ux * t / 2.0, b.1 + uy * t / 2.0); }
                    let (nx, ny) = (-uy * t / 2.0, ux * t / 2.0);
                    self.quad([(a.0 + nx, a.1 + ny), (b.0 + nx, b.1 + ny), (b.0 - nx, b.1 - ny), (a.0 - nx, a.1 - ny)], k);
                }
                if t > 2.0 {
                    let last = p.len() - 1;
                    for (i, q) in p.iter().enumerate() {
                        let end = i == 0 || i == last;
                        let closed = p[0] == p[last];
                        if (end && !closed && c.stroke_cap != 1) || (!end && c.stroke_join == 2) { continue; }
                        self.disc(*q, t / 2.0, k);
                    }
                }
            }
        }
        self.rotate_from(start, c);
        self.stats.0 += 1;
    }

    fn disc(&mut self, c: (f32, f32), r: f32, k: [f32; 4]) {
        let n = ((r * 2.0).ceil() as usize).clamp(8, 32);
        let pts: Vec<(f32, f32)> = (0..n).map(|i| { let a = i as f32 / n as f32 * std::f32::consts::TAU; (c.0 + r * a.cos(), c.1 + r * a.sin()) }).collect();
        self.tri_fan(&pts, c, &|_, _| k);
    }

    fn texture(&mut self, w: usize, h: usize, rgba: &[u8]) -> Option<*mut Texture> {
        unsafe {
            let t = sdl::SDL_CreateTexture(self.ren, sdl::PIXELFORMAT_ABGR8888, sdl::TEXTUREACCESS_STATIC, w as c_int, h as c_int);
            if t.is_null() { return None; }
            sdl::SDL_SetTextureBlendMode(t, sdl::BLENDMODE_BLEND);
            sdl::SDL_UpdateTexture(t, std::ptr::null(), rgba.as_ptr() as *const _, (w * 4) as c_int);
            Some(t)
        }
    }

    /// a texture's quad at (x, y) window pixels, tinted, turned with the command
    fn textured(&mut self, t: *mut Texture, x: f32, y: f32, w: f32, h: f32, k: [f32; 4], c: &EVGDrawCmd, rotate: bool) {
        self.flush();
        let a = self.alpha;
        let v = |x: f32, y: f32, u: f32, vv: f32| Vertex { x, y, r: k[0], g: k[1], b: k[2], a: k[3] * a, u, v: vv };
        self.verts.extend_from_slice(&[v(x, y, 0.0, 0.0), v(x + w, y, 1.0, 0.0), v(x + w, y + h, 1.0, 1.0), v(x, y + h, 0.0, 1.0)]);
        if rotate || c.rotate != 0.0 { self.rotate_from(0, c); }
        let idx: [c_int; 6] = [0, 1, 2, 0, 2, 3];
        unsafe { sdl::SDL_RenderGeometry(self.ren, t, self.verts.as_ptr(), 4, idx.as_ptr(), 6); }
        self.verts.clear();
    }

    fn face_for(&self, family: &str, weight: &str) -> (Option<&Face>, bool) {
        let f = family.to_ascii_lowercase();
        let bold = f.ends_with("-bold") || matches!(weight, "bold" | "bolder" | "600" | "700" | "800" | "900");
        let mono = f.contains("mono") || f.contains("courier") || f.contains("consol") || f.contains("menlo") || f.contains("monaco");
        if mono { if let Some(m) = &self.fonts.mono { return (Some(m), bold); } }
        if bold { if let Some(b) = &self.fonts.bold { return (Some(b), false); } }
        (self.fonts.sans.as_ref(), bold)
    }

    fn text(&mut self, c: &EVGDrawCmd) {
        let s = self.s;
        let size = c.font_size as f32;
        if size <= 0.0 { return; }
        let italic = c.text_align == "italic";
        let key = format!("{}\u{1}{}\u{1}{}\u{1}{:.2}\u{1}{:.2}\u{1}{}\u{1}{:.1}\u{1}{:.2}", c.text, c.font_family, c.font_weight, size, c.letter_spacing, italic, c.w, s);
        let frame = self.frame;
        if !self.texts.contains_key(&key) {
            let Some(t) = self.raster_text(c, size, italic) else { return };
            self.texts.insert(key.clone(), t);
        }
        let t = self.texts.get_mut(&key).unwrap();
        t.used = frame;
        let (tt, tw, th, ox, oy) = (t.t, t.w, t.h, t.ox, t.oy);
        // the baseline: the half leading below the line box's top plus the
        // face's ascent (evg-webgl's rule)
        let (fa, fd) = match self.face_for(&c.font_family, &c.font_weight).0 { Some(f) => (f.asc / f.upm, f.desc / f.upm), None => (0.905, 0.212) };
        let half = if c.h > 0.0 { (c.h as f32 - (fa + fd) * size) / 2.0 } else { 0.0 };
        let (x, y) = self.px(c.x, c.y);
        let base = y + (half + fa * size) * s;
        self.textured(tt, x - ox, base - oy, tw, th, col(c.r, c.g, c.b, c.a), c, false);
        self.stats.1 += 1;
    }

    fn raster_text(&mut self, c: &EVGDrawCmd, size: f32, italic: bool) -> Option<Tex> {
        let s = self.s;
        let (face, fake_bold) = self.face_for(&c.font_family, &c.font_weight);
        let face = face?;
        // the glyphs, each from the first face that has it
        let mut glyphs: Vec<(&Face, u16)> = Vec::new();
        for ch in c.text.chars() {
            let cp = ch as u32;
            let mut g = (face, face.glyph(cp));
            if g.1 == 0 && !ch.is_whitespace() {
                for f in &self.fonts.fallback { let gi = f.glyph(cp); if gi != 0 { g = (f, gi); break; } }
            }
            glyphs.push(g);
        }
        let ls = c.letter_spacing as f32;
        let natural: f32 = glyphs.iter().map(|(f, g)| f.advance(*g) * size / f.upm + ls).sum();
        // stretched to the width the layout measured (the system's face is
        // not always the one EVG's table holds)
        let fit = if natural > 0.0 && c.w > 0.0 { (c.w as f32 / natural).clamp(0.8, 1.25) } else { 1.0 };
        let pad = 2.0f32;
        let asc = face.asc / face.upm * size * s;
        let desc = face.desc / face.upm * size * s;
        let slant = if italic { 0.2 } else { 0.0 };
        let w = ((natural * fit * s) + 2.0 * pad + asc * slant + 2.0).ceil() as usize;
        let h = (asc + desc + 2.0 * pad).ceil() as usize;
        if w < 1 || h < 1 || w > 8192 || h > 2048 { return None; }
        let mut contours = Vec::new();
        let mut pen = pad;
        let base = pad + asc;
        for (f, g) in &glyphs {
            let k = size * s / f.upm;
            f.outline(*g, [k * fit, 0.0, slant * k, -k, pen, base], &mut contours, 0);
            pen += (f.advance(*g) * size / f.upm + ls) * s * fit;
        }
        let mut rings = ttf::flatten(&contours, 0.25);
        if fake_bold {
            // (no bold face: the outline drawn twice, a little apart)
            let shifted: Vec<Vec<(f32, f32)>> = rings.iter().map(|r| r.iter().map(|p| (p.0 + 0.6 * s, p.1)).collect()).collect();
            let mut ras = Raster::new(w, h);
            ras.rings(&rings);
            let a = ras.rgba(false);
            let mut ras2 = Raster::new(w, h);
            ras2.rings(&shifted);
            let mut b = ras2.rgba(false);
            for i in (3..b.len()).step_by(4) { b[i] = b[i].max(a[i]); }
            let t = self.texture(w, h, &b)?;
            rings.clear();
            return Some(Tex { t, w: w as f32, h: h as f32, ox: pad, oy: base, used: self.frame });
        }
        let mut ras = Raster::new(w, h);
        ras.rings(&rings);
        let px = ras.rgba(false);
        let t = self.texture(w, h, &px)?;
        Some(Tex { t, w: w as f32, h: h as f32, ox: pad, oy: base, used: self.frame })
    }

    /// text of the window's own (the bar): CSS px of the window, baseline y
    pub fn label(&mut self, text: &str, x: f32, y: f32, size: f32, bold: bool, k: [f32; 4]) -> f32 {
        let mut c = EVGDrawCmd::new();
        c.kind = TEXT;
        c.text = text.to_string();
        c.font_family = if bold { "Arial-Bold".into() } else { "Arial".into() };
        c.font_size = size as f64;
        c.r = (k[0] * 255.0) as i64; c.g = (k[1] * 255.0) as i64; c.b = (k[2] * 255.0) as i64; c.a = k[3] as f64;
        let w = self.measure(text, size, bold);
        c.w = w as f64;
        c.x = x as f64;
        c.y = (y - self.top) as f64;
        c.h = (size * 1.2) as f64;
        self.text(&c);
        w
    }

    pub fn measure(&self, text: &str, size: f32, bold: bool) -> f32 {
        let face = if bold { self.fonts.bold.as_ref().or(self.fonts.sans.as_ref()) } else { self.fonts.sans.as_ref() };
        let Some(f) = face else { return text.len() as f32 * size * 0.5 };
        text.chars().map(|ch| f.advance(f.glyph(ch as u32)) * size / f.upm).sum()
    }
}

/// Alpha outside a rounded box (x, y, w, h, r in the bitmap's pixels) taken
/// away, with a pixel of soft edge.
fn cut_rrect(px: &mut [u8], bw: usize, bh: usize, k: (f32, f32, f32, f32, f32)) {
    let (x, y, w, h, r) = k;
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    for j in 0..bh {
        for i in 0..bw {
            let (cx, cy) = (i as f32 + 0.5, j as f32 + 0.5);
            // distance outside the rounded box (negative inside)
            let qx = (cx - (x + w / 2.0)).abs() - (w / 2.0 - r);
            let qy = (cy - (y + h / 2.0)).abs() - (h / 2.0 - r);
            let d = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r;
            let cov = (0.5 - d).clamp(0.0, 1.0);
            if cov < 1.0 { let a = &mut px[(j * bw + i) * 4 + 3]; *a = (*a as f32 * cov) as u8; }
        }
    }
}

/// A polyline cut by a dash pattern (on, off, on, ...) into its "on" pieces.
fn dash_ring(r: &[(f32, f32)], pat: &[f32], offset: f32) -> Vec<Vec<(f32, f32)>> {
    let total: f32 = pat.iter().sum();
    let mut out = Vec::new();
    let mut k = 0usize;
    let mut left = pat[0];
    // (the offset walks into the pattern first)
    let mut off = offset.rem_euclid(total.max(1e-3));
    while off > 0.0 {
        if off >= left { off -= left; k = (k + 1) % pat.len(); left = pat[k]; } else { left -= off; off = 0.0; }
    }
    let mut cur: Vec<(f32, f32)> = if k % 2 == 0 { vec![r[0]] } else { Vec::new() };
    let mut guard = 0;
    for i in 0..r.len().saturating_sub(1) {
        let (mut a, b) = (r[i], r[i + 1]);
        let mut l = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        while l > 0.0 && guard < 100_000 {
            guard += 1;
            if left >= l {
                left -= l;
                if k % 2 == 0 { cur.push(b); }
                l = 0.0;
            } else {
                let t = left / l;
                let m = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
                if k % 2 == 0 { cur.push(m); out.push(std::mem::take(&mut cur)); } else { cur = vec![m]; }
                l -= left;
                a = m;
                k = (k + 1) % pat.len();
                left = pat[k];
                if left <= 0.0 { left = 1e-3; }
            }
        }
    }
    if k % 2 == 0 && cur.len() >= 2 { out.push(cur); }
    out
}
