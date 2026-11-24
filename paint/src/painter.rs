// SPDX-License-Identifier: MIT
//!
//! EVG's display list made into what a 2D GPU renderer draws: triangles
//! with colours (boxes and borders, rounded, two-stop gradients, soft
//! shadows, strokes), textured quads (text runs, filled paths and pictures
//! rasterized here) and clip rectangles, with group opacity as an alpha
//! factor. Every coordinate the list gives is in CSS pixels; the output is
//! in the window's own pixels (`s` per CSS px).
//!
//! The painter calls no graphics API. A frame's output is
//!
//!   uploads  textures to create before drawing (id, w, h, RGBA bytes, not
//!            premultiplied)
//!   ops      OP_DRAW (texture id or 0, first vertex, vertices, first index,
//!            indices), OP_CLIP (x, y, w, h), OP_UNCLIP, six numbers each
//!   verts    x, y, r, g, b, a, u, v per vertex (colours 0..1); a draw's
//!            indices count from its first vertex
//!   frees    textures no longer used, to destroy after drawing
//!
//! and a host runs it with its renderer (uploads, ops, frees, then done()): SDL3's SDL_RenderGeometry,
//! SDL_SetRenderClipRect, SDL_CreateTexture. The same file is the Rust
//! desktop playground's painter (cargo) and EVGBrowser's (Ranger -> C++).

use std::collections::HashMap;
use std::rc::Rc;

use ranger::cell::RefCell;

use crate::raster::Raster;
use crate::rgr::{EVGDisplayList, EVGDrawCmd};
use crate::svgpic;
use crate::ttf::{flatten, TtfContours, TtfFace, TtfRings};

pub const OP_DRAW: i64 = 1;
pub const OP_CLIP: i64 = 2;
pub const OP_UNCLIP: i64 = 3;

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

/// a texture for the host to create: RGBA, w x h, not premultiplied
#[derive(Clone)]
pub struct PaintTex {
    pub id: i64,
    pub w: i64,
    pub h: i64,
    pub px: Vec<u8>,
}

impl PaintTex {
    pub fn new() -> Self {
        Self {
            id: 0,
            w: 0,
            h: 0,
            px: Vec::new(),
        }
    }
}

/// a texture the painter keeps: its size in window pixels, where the anchor
/// (pen start, baseline) is inside it, the frame it was last drawn in
#[derive(Clone)]
pub struct PaintCached {
    pub id: i64,
    pub w: f64,
    pub h: f64,
    pub ox: f64,
    pub oy: f64,
    pub used: i64,
    /// a text run's colour emoji: texture id, x from the pen start, w, h
    /// (window px), four numbers each
    pub emo: Vec<f64>,
}

impl PaintCached {
    pub fn new() -> Self {
        Self {
            id: 0,
            w: 0.0,
            h: 0.0,
            ox: 0.0,
            oy: 0.0,
            used: 0,
            emo: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct PaintClip {
    pub on: bool,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl PaintClip {
    pub fn new() -> Self {
        Self {
            on: false,
            x0: 0.0,
            y0: 0.0,
            x1: 0.0,
            y1: 0.0,
        }
    }
}

/// a colour, 0..1 each
#[derive(Clone)]
pub struct PaintRgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl PaintRgba {
    pub fn new() -> Self {
        Self {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 1.0,
        }
    }
    pub fn of(r: i64, g: i64, b: i64, a: f64) -> PaintRgba {
        let mut c = PaintRgba::new();
        c.r = (r as f64) / 255.0;
        c.g = (g as f64) / 255.0;
        c.b = (b as f64) / 255.0;
        c.a = a;
        c
    }
    pub fn rgba(r: f64, g: f64, b: f64, a: f64) -> PaintRgba {
        let mut c = PaintRgba::new();
        c.r = r;
        c.g = g;
        c.b = b;
        c.a = a;
        c
    }
}

/// a box's fill: one colour, or two blended down (or across) the box
#[derive(Clone)]
struct PaintShade {
    c1: PaintRgba,
    c2: PaintRgba,
    grad: bool,
    across: bool,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl PaintShade {
    fn solid(c: PaintRgba) -> PaintShade {
        PaintShade {
            c1: c.clone(),
            c2: c,
            grad: false,
            across: false,
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        }
    }
    fn at(&self, px: f64, py: f64) -> PaintRgba {
        if !self.grad {
            return self.c1.clone();
        }
        let mut t: f64 = 0.0;
        if self.across {
            if self.w > 0.0 {
                t = (px - self.x) / self.w;
            }
        } else if self.h > 0.0 {
            t = (py - self.y) / self.h;
        }
        if t < 0.0 {
            t = 0.0;
        }
        if t > 1.0 {
            t = 1.0;
        }
        PaintRgba::rgba(
            self.c1.r + (self.c2.r - self.c1.r) * t,
            self.c1.g + (self.c2.g - self.c1.g) * t,
            self.c1.b + (self.c2.b - self.c1.b) * t,
            self.c1.a + (self.c2.a - self.c1.a) * t,
        )
    }
}

pub struct DlPainter {
    /// window pixels per CSS pixel
    pub s: f64,
    /// where the list's y = 0 is in the window (CSS px)
    pub top: f64,
    pub verts: Vec<f64>,
    pub idx: Vec<i64>,
    pub ops: Vec<i64>,
    pub uploads: Vec<PaintTex>,
    pub frees: Vec<i64>,
    /// pictures the list named that neither set_image nor set_svg gave,
    /// each once (the host may answer with set_image / set_svg); and
    /// "emoji:<codepoint>" for a pictograph text asked for, which the host
    /// may answer with set_emoji
    pub missing: Vec<String>,
    /// shapes and text runs the last frame drew
    pub shapes: i64,
    pub runs: i64,
    faces: Vec<TtfFace>,
    sans: i64,
    bold: i64,
    mono: i64,
    fallback: Vec<i64>,
    texts: HashMap<String, Rc<RefCell<PaintCached>>>,
    images: HashMap<String, Rc<RefCell<PaintCached>>>,
    svgs: HashMap<String, String>,
    asked: HashMap<String, bool>,
    emoji: HashMap<i64, Rc<RefCell<PaintCached>>>,
    emoji_asked: HashMap<i64, bool>,
    frame: i64,
    next_id: i64,
    batch_v: i64,
    batch_i: i64,
    clips: Vec<PaintClip>,
    clip: PaintClip,
    alphas: Vec<f64>,
    alpha: f64,
}

fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        return lo;
    }
    if v > hi {
        return hi;
    }
    v
}

fn maxf(a: f64, b: f64) -> f64 {
    if a > b {
        a
    } else {
        b
    }
}

fn minf(a: f64, b: f64) -> f64 {
    if a < b {
        a
    } else {
        b
    }
}

fn ri(v: f64) -> i64 {
    v.round() as i64
}

impl DlPainter {
    pub fn new() -> DlPainter {
        DlPainter {
            s: 1.0,
            top: 0.0,
            verts: Vec::new(),
            idx: Vec::new(),
            ops: Vec::new(),
            uploads: Vec::new(),
            frees: Vec::new(),
            missing: Vec::new(),
            shapes: 0,
            runs: 0,
            faces: Vec::new(),
            sans: -1,
            bold: -1,
            mono: -1,
            fallback: Vec::new(),
            texts: HashMap::new(),
            images: HashMap::new(),
            svgs: HashMap::new(),
            asked: HashMap::new(),
            emoji: HashMap::new(),
            emoji_asked: HashMap::new(),
            frame: 0,
            next_id: 1,
            batch_v: 0,
            batch_i: 0,
            clips: Vec::new(),
            clip: PaintClip::new(),
            alphas: Vec::new(),
            alpha: 1.0,
        }
    }

    // ---------------------------------------------------------------- fonts

    /// Where a role's face ("sans", "bold", "mono", "fallback") is looked
    /// for, first found first: Arial (what EVG's table measures), then faces
    /// with Arial's widths (Liberation Sans, Arimo), then the system's sans.
    /// A bare name is read from the host's font directory.
    pub fn font_candidates(role: &str) -> Vec<String> {
        let mut v: Vec<String> = Vec::new();
        if role == "sans" {
            v.push("sans.ttf".to_string());
            v.push("/System/Library/Fonts/Supplemental/Arial.ttf".to_string());
            v.push("/Library/Fonts/Arial.ttf".to_string());
            v.push("/usr/share/fonts/truetype/msttcorefonts/Arial.ttf".to_string());
            v.push("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf".to_string());
            v.push("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf".to_string());
            v.push("/usr/share/fonts/truetype/croscore/Arimo-Regular.ttf".to_string());
            v.push("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf".to_string());
            v.push("C:\\Windows\\Fonts\\arial.ttf".to_string());
        } else if role == "bold" {
            v.push("sans-bold.ttf".to_string());
            v.push("/System/Library/Fonts/Supplemental/Arial Bold.ttf".to_string());
            v.push("/Library/Fonts/Arial Bold.ttf".to_string());
            v.push("/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf".to_string());
            v.push("/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf".to_string());
            v.push("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf".to_string());
            v.push("/usr/share/fonts/truetype/croscore/Arimo-Bold.ttf".to_string());
            v.push("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf".to_string());
            v.push("C:\\Windows\\Fonts\\arialbd.ttf".to_string());
        } else if role == "mono" {
            v.push("mono.ttf".to_string());
            v.push("/System/Library/Fonts/Supplemental/Courier New.ttf".to_string());
            v.push("/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf".to_string());
            v.push("/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf".to_string());
            v.push("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf".to_string());
            v.push("C:\\Windows\\Fonts\\cour.ttf".to_string());
        } else if role == "fallback" {
            v.push("/System/Library/Fonts/Supplemental/Arial Unicode.ttf".to_string());
            v.push("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf".to_string());
            v.push("C:\\Windows\\Fonts\\seguisym.ttf".to_string());
        }
        v
    }

    /// a face's file for a role (see font_candidates); false when it does
    /// not read as a TrueType face with outlines. "fallback" faces add up.
    pub fn add_face(&mut self, role: &str, data: Vec<u8>) -> bool {
        let f = TtfFace::parse(data);
        if !f.ok {
            return false;
        }
        let at = self.faces.len() as i64;
        self.faces.push(f);
        if role == "sans" {
            self.sans = at;
        } else if role == "bold" {
            self.bold = at;
        } else if role == "mono" {
            self.mono = at;
        } else {
            self.fallback.push(at);
        }
        true
    }

    pub fn has_font(&self) -> bool {
        self.sans >= 0
    }

    /// the face a run is drawn with, and whether it is drawn bolder by hand
    fn face_for(&self, family: &str, weight: &str) -> (i64, bool) {
        let f = family.to_ascii_lowercase();
        let bold = f.ends_with("-bold") || weight == "bold" || weight == "bolder" || weight == "600" || weight == "700" || weight == "800" || weight == "900";
        let mono = f.contains("mono") || f.contains("courier") || f.contains("consol") || f.contains("menlo") || f.contains("monaco");
        if mono && self.mono >= 0 {
            return (self.mono, bold);
        }
        if bold && self.bold >= 0 {
            return (self.bold, false);
        }
        (self.sans, bold)
    }

    // -------------------------------------------------------------- pictures

    /// a decoded picture (RGBA, not premultiplied) the list draws by `name`
    /// (its src); it stays until drop_image
    pub fn set_image(&mut self, name: &str, w: i64, h: i64, px: Vec<u8>) {
        self.drop_image(name);
        if w <= 0 || h <= 0 {
            return;
        }
        let id = self.upload(w, h, px);
        let mut e = PaintCached::new();
        e.id = id;
        e.w = w as f64;
        e.h = h as f64;
        self.images.insert(name.to_string(), Rc::new(RefCell::new(e)));
    }

    pub fn has_image(&self, name: &str) -> bool {
        self.images.contains_key(name) || self.svgs.contains_key(name)
    }

    pub fn drop_image(&mut self, name: &str) {
        let had = self.images.get(name).cloned();
        if let Some(e) = had {
            self.frees.push(e.borrow().id);
            self.images.remove(name);
        }
    }

    /// an SVG picture's text, drawn by `name` at the size each command asks
    pub fn set_svg(&mut self, name: &str, svg: &str) {
        self.svgs.insert(name.to_string(), svg.to_string());
    }

    pub fn has_svg(&self, name: &str) -> bool {
        self.svgs.contains_key(name)
    }

    /// a colour emoji's picture (RGBA, not premultiplied) and its advance
    /// in ems, drawn for `cp` in text from now on; the text drawn so far is
    /// made again
    pub fn set_emoji(&mut self, cp: i64, advance: f64, w: i64, h: i64, px: Vec<u8>) {
        if w <= 0 || h <= 0 || self.emoji.contains_key(&cp) {
            return;
        }
        let id = self.upload(w, h, px);
        let mut e = PaintCached::new();
        e.id = id;
        e.w = w as f64;
        e.h = h as f64;
        e.ox = advance;
        self.emoji.insert(cp, Rc::new(RefCell::new(e)));
        for (_k, t) in self.texts.iter() {
            self.frees.push(t.borrow().id);
        }
        self.texts = HashMap::new();
    }

    /// whether `cp` is drawn as a colour emoji: asked once from the host
    /// (missing) for a pictograph, a character no face has, or one followed
    /// by U+FE0F
    fn emoji_for(&mut self, cp: i64, wanted: bool) -> bool {
        if self.emoji.contains_key(&cp) {
            return true;
        }
        if wanted && !self.emoji_asked.contains_key(&cp) {
            self.emoji_asked.insert(cp, true);
            self.missing.push(format!("emoji:{}", cp));
        }
        false
    }

    // ---------------------------------------------------------------- frame

    fn upload(&mut self, w: i64, h: i64, px: Vec<u8>) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        let mut t = PaintTex::new();
        t.id = id;
        t.w = w;
        t.h = h;
        t.px = px;
        self.uploads.push(t);
        id
    }

    /// The start of a frame: the last frame's output is dropped (the host
    /// ran it), and what the last frames did not use goes.
    pub fn begin(&mut self) {
        self.verts.clear();
        self.idx.clear();
        self.ops.clear();
        self.batch_v = 0;
        self.batch_i = 0;
        self.frame += 1;
        let n = self.texts.len() as i64;
        if self.frame % 30 == 0 || n > 6000 {
            let mut keep: i64 = 90;
            if n > 6000 {
                keep = 2;
            }
            let mut gone: Vec<String> = Vec::new();
            for (k, e) in self.texts.iter() {
                if self.frame - e.borrow().used > keep {
                    gone.push(k.clone());
                }
            }
            for k in gone.iter() {
                let e = self.texts.get(k).cloned();
                if let Some(t) = e {
                    self.frees.push(t.borrow().id);
                }
                self.texts.remove(k);
            }
        }
        self.clips.clear();
        self.clip = PaintClip::new();
        self.alphas.clear();
        self.alpha = 1.0;
        self.shapes = 0;
        self.runs = 0;
        self.push_op(OP_UNCLIP, 0, 0, 0, 0, 0);
    }

    /// the end of a frame: what is still batched goes out
    pub fn end(&mut self) {
        self.flush();
    }

    /// the host made the uploads and destroyed the frees
    pub fn done(&mut self) {
        self.uploads.clear();
        self.frees.clear();
    }

    fn push_op(&mut self, k: i64, a: i64, b: i64, c: i64, d: i64, e: i64) {
        self.ops.push(k);
        self.ops.push(a);
        self.ops.push(b);
        self.ops.push(c);
        self.ops.push(d);
        self.ops.push(e);
    }

    fn nverts(&self) -> i64 {
        (self.verts.len() / 8) as i64
    }

    /// the untextured triangles batched since the last draw
    pub fn flush(&mut self) {
        let nv = self.nverts();
        let ni = self.idx.len() as i64;
        if ni > self.batch_i {
            let bv = self.batch_v;
            let bi = self.batch_i;
            self.push_op(OP_DRAW, 0, bv, nv - bv, bi, ni - bi);
        }
        self.batch_v = nv;
        self.batch_i = ni;
    }

    fn vert(&mut self, x: f64, y: f64, c: &PaintRgba, u: f64, v: f64) {
        self.verts.push(x);
        self.verts.push(y);
        self.verts.push(c.r);
        self.verts.push(c.g);
        self.verts.push(c.b);
        self.verts.push(c.a * self.alpha);
        self.verts.push(u);
        self.verts.push(v);
    }

    fn px(&self, x: f64) -> f64 {
        x * self.s
    }

    fn py(&self, y: f64) -> f64 {
        (y + self.top) * self.s
    }

    fn set_clip(&mut self, c: PaintClip) {
        self.flush();
        if c.on {
            let x = c.x0.floor();
            let y = c.y0.floor();
            let w = maxf(c.x1.ceil() - x, 0.0);
            let h = maxf(c.y1.ceil() - y, 0.0);
            self.push_op(OP_CLIP, x as i64, y as i64, w as i64, h as i64, 0);
        } else {
            self.push_op(OP_UNCLIP, 0, 0, 0, 0, 0);
        }
        self.clip = c;
    }

    /// a clip of the window's own (a bar, the page), in CSS px of the window
    pub fn clip_window(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let s = self.s;
        let mut c = PaintClip::new();
        c.on = true;
        c.x0 = x * s;
        c.y0 = y * s;
        c.x1 = (x + w) * s;
        c.y1 = (y + h) * s;
        self.set_clip(c);
    }

    pub fn unclip(&mut self) {
        self.set_clip(PaintClip::new());
    }

    // ------------------------------------------------------------- geometry

    fn fan(&mut self, pts: &Vec<f64>, cx: f64, cy: f64, sh: &PaintShade) {
        let n = (pts.len() / 2) as i64;
        if n < 2 {
            return;
        }
        let base = self.nverts() - self.batch_v;
        let cc = sh.at(cx, cy);
        self.vert(cx, cy, &cc, 0.0, 0.0);
        for i in 0..n {
            let x = pts[(i * 2) as usize];
            let y = pts[(i * 2 + 1) as usize];
            let c = sh.at(x, y);
            self.vert(x, y, &c, 0.0, 0.0);
        }
        for i in 0..n {
            self.idx.push(base);
            self.idx.push(base + 1 + i);
            self.idx.push(base + 1 + (i + 1) % n);
        }
    }

    fn ring(&mut self, outer: &Vec<f64>, inner: &Vec<f64>, c: &PaintRgba) {
        let mut n = (outer.len() / 2) as i64;
        let ni = (inner.len() / 2) as i64;
        if ni < n {
            n = ni;
        }
        if n < 2 {
            return;
        }
        let base = self.nverts() - self.batch_v;
        for k in 0..n {
            let o = (k * 2) as usize;
            self.vert(outer[o], outer[o + 1], c, 0.0, 0.0);
            self.vert(inner[o], inner[o + 1], c, 0.0, 0.0);
        }
        for k in 0..n {
            let o0 = base + 2 * k;
            let i0 = o0 + 1;
            let o1 = base + 2 * ((k + 1) % n);
            let i1 = o1 + 1;
            self.idx.push(o0);
            self.idx.push(i0);
            self.idx.push(o1);
            self.idx.push(o1);
            self.idx.push(i0);
            self.idx.push(i1);
        }
    }

    fn quad(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, x2: f64, y2: f64, x3: f64, y3: f64, c: &PaintRgba) {
        let base = self.nverts() - self.batch_v;
        self.vert(x0, y0, c, 0.0, 0.0);
        self.vert(x1, y1, c, 0.0, 0.0);
        self.vert(x2, y2, c, 0.0, 0.0);
        self.vert(x3, y3, c, 0.0, 0.0);
        self.idx.push(base);
        self.idx.push(base + 1);
        self.idx.push(base + 2);
        self.idx.push(base);
        self.idx.push(base + 2);
        self.idx.push(base + 3);
    }

    /// a rounded box's outline in window pixels, corners TL TR BR BL
    fn rrect(x: f64, y: f64, w: f64, h: f64, r0: f64, r1: f64, r2: f64, r3: f64, segs: i64) -> Vec<f64> {
        let m = maxf(minf(w, h) / 2.0, 0.0);
        let rr = vec![clampf(r0, 0.0, m), clampf(r1, 0.0, m), clampf(r2, 0.0, m), clampf(r3, 0.0, m)];
        let cxs = vec![x + rr[0], x + w - rr[1], x + w - rr[2], x + rr[3]];
        let cys = vec![y + rr[0], y + rr[1], y + h - rr[2], y + h - rr[3]];
        let a0s = vec![180.0, 270.0, 0.0, 90.0];
        let mut pts: Vec<f64> = Vec::new();
        for k in 0..4 {
            for i in 0..(segs + 1) {
                let a = (a0s[k] + 90.0 * (i as f64) / (segs as f64)) * 3.141592653589793 / 180.0;
                pts.push(cxs[k] + rr[k] * a.cos());
                pts.push(cys[k] + rr[k] * a.sin());
            }
        }
        pts
    }

    fn radii(&self, c: &EVGDrawCmd) -> Vec<f64> {
        let s = self.s;
        if c.per_corner {
            return vec![c.radius * s, c.radius_tr * s, c.radius_br * s, c.radius_bl * s];
        }
        vec![c.radius * s, c.radius * s, c.radius * s, c.radius * s]
    }

    fn segs(r: &Vec<f64>) -> i64 {
        let mut m: f64 = 0.0;
        for v in r.iter() {
            if *v > m {
                m = *v;
            }
        }
        if m <= 0.5 {
            return 1;
        }
        let mut n = (m * 0.6).ceil() as i64;
        if n < 2 {
            n = 2;
        }
        if n > 16 {
            n = 16;
        }
        n
    }

    /// a filled box of the window's own (a bar), in CSS px of the window
    pub fn fill(&mut self, x: f64, y: f64, w: f64, h: f64, r: f64, c: &PaintRgba) {
        let s = self.s;
        let rr = vec![r * s, r * s, r * s, r * s];
        let pts = DlPainter::rrect(x * s, y * s, w * s, h * s, rr[0], rr[1], rr[2], rr[3], DlPainter::segs(&rr));
        let sh = PaintShade::solid(c.clone());
        self.fan(&pts, (x + w / 2.0) * s, (y + h / 2.0) * s, &sh);
    }

    /// the vertices from `start` on turned with the command's rotation
    fn rotate_from(&mut self, start: i64, c: &EVGDrawCmd) {
        if c.rotate == 0.0 {
            return;
        }
        let mut ox = self.px(c.x + c.w / 2.0);
        let mut oy = self.py(c.y + c.h / 2.0);
        if c.has_rot_origin {
            ox = self.px(c.rot_origin_x);
            oy = self.py(c.rot_origin_y);
        }
        let a = c.rotate * 3.141592653589793 / 180.0;
        let sn = a.sin();
        let cs = a.cos();
        let n = self.nverts();
        for k in start..n {
            let i = (k * 8) as usize;
            let dx = self.verts[i] - ox;
            let dy = self.verts[i + 1] - oy;
            self.verts[i] = ox + dx * cs - dy * sn;
            self.verts[i + 1] = oy + dx * sn + dy * cs;
        }
    }

    // ----------------------------------------------------------------- list

    /// a display list drawn (between begin and end)
    ///
    /// (`doc(hidden)`: EVG's classes are not API of this crate, and Ranger
    /// does not let a public item name a class that is not public)
    #[doc(hidden)]
    pub fn draw_list(&mut self, dl: &Rc<RefCell<EVGDisplayList>>) {
        let cmds = dl.borrow().cmds.clone();
        for c in cmds.iter() {
            self.cmd(&c.borrow());
        }
        self.flush();
        self.clips.clear();
        self.set_clip(PaintClip::new());
    }

    /// one command of a display list
    #[doc(hidden)]
    pub fn cmd(&mut self, c: &EVGDrawCmd) {
        let k = c.kind;
        if k == RECT {
            self.rect(c);
        } else if k == BORDER {
            self.border(c);
        } else if k == TEXT {
            if !c.text.is_empty() && c.a > 0.0 {
                self.text(c);
            }
        } else if k == PUSH_CLIP {
            let prev = self.clip.clone();
            self.clips.push(prev);
            let mut n = PaintClip::new();
            n.on = true;
            n.x0 = self.px(c.x);
            n.y0 = self.py(c.y);
            n.x1 = self.px(c.x + c.w);
            n.y1 = self.py(c.y + c.h);
            // (every clip in force narrows)
            if self.clip.on {
                n.x0 = maxf(n.x0, self.clip.x0);
                n.y0 = maxf(n.y0, self.clip.y0);
                n.x1 = minf(n.x1, self.clip.x1);
                n.y1 = minf(n.y1, self.clip.y1);
            }
            self.set_clip(n);
        } else if k == POP_CLIP {
            let mut p = PaintClip::new();
            if let Some(q) = self.clips.pop() {
                p = q;
            }
            self.set_clip(p);
        } else if k == GROUP_OPEN {
            let a = self.alpha;
            self.alphas.push(a);
            self.alpha = a * c.a;
        } else if k == GROUP_CLOSE {
            let mut a: f64 = 1.0;
            if let Some(q) = self.alphas.pop() {
                a = q;
            }
            self.alpha = a;
        } else if k == PATH {
            self.path(c);
        } else if k == STROKE {
            self.stroke(c);
        } else if k == IMAGE {
            self.image(c);
        }
    }

    fn rect(&mut self, c: &EVGDrawCmd) {
        let start = self.nverts();
        let x = self.px(c.x);
        let y = self.py(c.y);
        let w = c.w * self.s;
        let h = c.h * self.s;
        let r = self.radii(c);
        let segs = DlPainter::segs(&r);
        let mut segs4 = segs;
        if segs4 < 4 {
            segs4 = 4;
        }
        if c.has_shadow && c.shadow_a > 0.0 {
            let b = c.shadow_blur * self.s;
            let sx = c.shadow_x * self.s;
            let sy = c.shadow_y * self.s;
            let sc = PaintRgba::of(c.shadow_r, c.shadow_g, c.shadow_b, c.shadow_a);
            let mut n: i64 = 1;
            if b > 1.0 {
                n = 4;
            }
            // (CSS paints an outer shadow only outside the border box: a
            // ring from the grown box in to the box itself)
            let inner = DlPainter::rrect(x, y, w, h, r[0], r[1], r[2], r[3], segs4);
            for i in 0..n {
                let mut e: f64 = 0.0;
                if n > 1 {
                    e = b * 0.6 * ((n - i) as f64) / (n as f64);
                }
                let pts = DlPainter::rrect(x + sx - e, y + sy - e, w + 2.0 * e, h + 2.0 * e, maxf(r[0] + e, 0.0), maxf(r[1] + e, 0.0), maxf(r[2] + e, 0.0), maxf(r[3] + e, 0.0), segs4);
                let mut f: f64 = 1.0;
                if n > 1 {
                    f = 1.2;
                }
                let k = PaintRgba::rgba(sc.r, sc.g, sc.b, sc.a / (n as f64) * f);
                self.ring(&pts, &inner, &k);
            }
        }
        if c.a > 0.0 || (c.has_grad && c.a2 > 0.0) {
            let pts = DlPainter::rrect(x, y, w, h, r[0], r[1], r[2], r[3], segs);
            let mut sh = PaintShade::solid(PaintRgba::of(c.r, c.g, c.b, c.a));
            if c.has_grad {
                sh.c2 = PaintRgba::of(c.r2, c.g2, c.b2, c.a2);
                sh.grad = true;
                sh.across = c.grad_dir == 1;
                sh.x = x;
                sh.y = y;
                sh.w = w;
                sh.h = h;
            }
            self.fan(&pts, x + w / 2.0, y + h / 2.0, &sh);
        }
        self.rotate_from(start, c);
        self.shapes += 1;
    }

    fn border(&mut self, c: &EVGDrawCmd) {
        let start = self.nverts();
        let x = self.px(c.x);
        let y = self.py(c.y);
        let w = c.w * self.s;
        let h = c.h * self.s;
        let mut th = c.thickness;
        if th <= 0.0 {
            th = 1.0;
        }
        let t = th * self.s;
        let r = self.radii(c);
        let segs = DlPainter::segs(&r);
        let outer = DlPainter::rrect(x, y, w, h, r[0], r[1], r[2], r[3], segs);
        let inner = DlPainter::rrect(x + t, y + t, maxf(w - 2.0 * t, 0.0), maxf(h - 2.0 * t, 0.0), maxf(r[0] - t, 0.0), maxf(r[1] - t, 0.0), maxf(r[2] - t, 0.0), maxf(r[3] - t, 0.0), segs);
        let k = PaintRgba::of(c.r, c.g, c.b, c.a);
        self.ring(&outer, &inner, &k);
        self.rotate_from(start, c);
        self.shapes += 1;
    }

    /// a texture's quad at (x, y) window pixels with texture coordinates
    /// (u0, v0) - (u1, v1), tinted, turned with the command
    fn textured(&mut self, id: i64, x: f64, y: f64, w: f64, h: f64, u0: f64, v0: f64, u1: f64, v1: f64, k: &PaintRgba, c: &EVGDrawCmd) {
        self.flush();
        let start = self.nverts();
        self.vert(x, y, k, u0, v0);
        self.vert(x + w, y, k, u1, v0);
        self.vert(x + w, y + h, k, u1, v1);
        self.vert(x, y + h, k, u0, v1);
        self.rotate_from(start, c);
        let i0 = self.idx.len() as i64;
        self.idx.push(0);
        self.idx.push(1);
        self.idx.push(2);
        self.idx.push(0);
        self.idx.push(2);
        self.idx.push(3);
        self.push_op(OP_DRAW, id, start, 4, i0, 6);
        self.batch_v = self.nverts();
        self.batch_i = self.idx.len() as i64;
    }

    /// a picture the page named: a decoded one (set_image) filling its box
    /// as object-fit: cover, or the part the command crops; an SVG one
    /// (set_svg) drawn at the box's size, in its tile
    fn image(&mut self, c: &EVGDrawCmd) {
        if c.w <= 0.0 || c.h <= 0.0 {
            return;
        }
        let img = self.images.get(&c.src).cloned();
        if let Some(e) = img {
            let iw = e.borrow().w;
            let ih = e.borrow().h;
            let id = e.borrow().id;
            let mut u0: f64 = 0.0;
            let mut v0: f64 = 0.0;
            let mut u1: f64 = 1.0;
            let mut v1: f64 = 1.0;
            if c.has_crop {
                u0 = c.crop_x;
                v0 = c.crop_y;
                u1 = c.crop_x + c.crop_w;
                v1 = c.crop_y + c.crop_h;
            } else {
                // object-fit: cover, centred
                let k = maxf(c.w / iw, c.h / ih);
                let sw = c.w / k / iw;
                let sh = c.h / k / ih;
                u0 = (1.0 - sw) / 2.0;
                v0 = (1.0 - sh) / 2.0;
                u1 = u0 + sw;
                v1 = v0 + sh;
            }
            let x = self.px(c.x);
            let y = self.py(c.y);
            let tint = PaintRgba::rgba(1.0, 1.0, 1.0, c.a);
            self.textured(id, x, y, c.w * self.s, c.h * self.s, u0, v0, u1, v1, &tint, c);
            self.shapes += 1;
            return;
        }
        let svg = self.svgs.get(&c.src).cloned();
        let Some(text) = svg else {
            if !c.src.is_empty() && !self.asked.contains_key(&c.src) {
                self.asked.insert(c.src.clone(), true);
                self.missing.push(c.src.clone());
            }
            return;
        };
        // (a tile the size of the box is the box: a kept row moved down
        // keeps the tile where it was first laid)
        let mut bx = c.x;
        let mut by = c.y;
        let mut bw = c.w;
        let mut bh = c.h;
        if let Some(t) = &c.tile {
            let tx = t.borrow().x;
            let ty = t.borrow().y;
            let tw = t.borrow().w;
            let tth = t.borrow().h;
            if !((tw - c.w).abs() < 0.01 && (tth - c.h).abs() < 0.01) {
                bx = tx;
                by = ty;
                bw = tw;
                bh = tth;
            }
        }
        let x = self.px(bx);
        let y = self.py(by);
        let w = maxf((bw * self.s).round(), 1.0) as i64;
        let h = maxf((bh * self.s).round(), 1.0) as i64;
        if w > 4096 || h > 4096 {
            return;
        }
        let key = format!("S{}|{}|{}", w, h, c.src);
        let frame = self.frame;
        if !self.texts.contains_key(&key) {
            let px = svgpic::rasterize(&text, w, h);
            let id = self.upload(w, h, px);
            let mut e = PaintCached::new();
            e.id = id;
            e.w = w as f64;
            e.h = h as f64;
            self.texts.insert(key.clone(), Rc::new(RefCell::new(e)));
        }
        let t = self.texts.get(&key).cloned().unwrap();
        t.borrow_mut().used = frame;
        let id = t.borrow().id;
        let tw = t.borrow().w;
        let tth = t.borrow().h;
        // (the command's alpha fades the picture; its colour does not tint it)
        let tint = PaintRgba::rgba(1.0, 1.0, 1.0, c.a);
        self.textured(id, x, y, tw, tth, 0.0, 0.0, 1.0, 1.0, &tint, c);
        self.shapes += 1;
    }

    /// the command's rings in window pixels
    fn rings(&self, c: &EVGDrawCmd) -> TtfRings {
        let mut out = TtfRings::new();
        let total = c.pts.len() as i64;
        let mut ends: Vec<i64> = Vec::new();
        if c.ring_ends.is_empty() {
            ends.push(total);
        } else {
            for e in c.ring_ends.iter() {
                ends.push(*e);
            }
        }
        let mut start: i64 = 0;
        for e0 in ends.iter() {
            let mut e = *e0;
            if e > total {
                e = total;
            }
            if e >= start + 4 {
                let mut i = start;
                while i + 1 < e {
                    out.pts.push(self.px(c.pts[i as usize]));
                    out.pts.push(self.py(c.pts[(i + 1) as usize]));
                    i += 2;
                }
                out.ends.push(out.pts.len() as i64);
            }
            start = e;
        }
        out
    }

    fn path(&mut self, c: &EVGDrawCmd) {
        let rings = self.rings(c);
        if rings.ends.is_empty() {
            return;
        }
        let mut x0: f64 = 1e18;
        let mut y0: f64 = 1e18;
        let mut x1: f64 = -1e18;
        let mut y1: f64 = -1e18;
        let n = rings.pts.len() / 2;
        for i in 0..n {
            let x = rings.pts[i * 2];
            let y = rings.pts[i * 2 + 1];
            x0 = minf(x0, x);
            y0 = minf(y0, y);
            x1 = maxf(x1, x);
            y1 = maxf(y1, y);
        }
        let bx = x0.floor() - 1.0;
        let by = y0.floor() - 1.0;
        let w = (x1.ceil() - bx + 2.0) as i64;
        let h = (y1.ceil() - by + 2.0) as i64;
        if w < 2 || h < 2 || w > 4096 || h > 4096 {
            return;
        }
        // (the same shape moved by whole pixels is the same picture; `r` on
        // a vector: the rounded box its picture is cut to)
        let mut key = format!("P{}|{}|{}", c.even_odd, w, h);
        let cut = c.radius > 0.0;
        let kx = self.px(c.x) - bx;
        let ky = self.py(c.y) - by;
        let kw = c.w * self.s;
        let kh = c.h * self.s;
        let kr = c.radius * self.s;
        if cut {
            key.push_str(&format!("|r{},{},{},{},{}", ri(kx * 4.0), ri(ky * 4.0), ri(kw * 4.0), ri(kh * 4.0), ri(kr * 4.0)));
        }
        let mut local = TtfRings::new();
        for i in 0..n {
            local.pts.push(rings.pts[i * 2] - bx);
            local.pts.push(rings.pts[i * 2 + 1] - by);
        }
        for e in rings.ends.iter() {
            local.ends.push(*e);
            key.push_str(&format!(";{}", e));
        }
        for v in local.pts.iter() {
            key.push_str(&format!(",{}", ri(*v * 4.0)));
        }
        let frame = self.frame;
        if !self.texts.contains_key(&key) {
            let mut ras = Raster::new(w, h);
            ras.rings(&local.pts, &local.ends);
            let mut px = ras.rgba(c.even_odd);
            if cut {
                cut_rrect(&mut px, w, h, kx, ky, kw, kh, kr);
            }
            let id = self.upload(w, h, px);
            let mut e = PaintCached::new();
            e.id = id;
            e.w = w as f64;
            e.h = h as f64;
            self.texts.insert(key.clone(), Rc::new(RefCell::new(e)));
        }
        let t = self.texts.get(&key).cloned().unwrap();
        t.borrow_mut().used = frame;
        let id = t.borrow().id;
        let tw = t.borrow().w;
        let tth = t.borrow().h;
        let k = PaintRgba::of(c.r, c.g, c.b, c.a);
        self.textured(id, bx, by, tw, tth, 0.0, 0.0, 1.0, 1.0, &k, c);
        self.shapes += 1;
    }

    fn stroke(&mut self, c: &EVGDrawCmd) {
        let rings = self.rings(c);
        if rings.ends.is_empty() {
            return;
        }
        let mut th = c.thickness;
        if th <= 0.0 {
            th = 1.0;
        }
        let t = maxf(th * self.s, 0.75);
        let k = PaintRgba::of(c.r, c.g, c.b, c.a);
        let dash = dash_pattern(&c.stroke_dash, self.s);
        let mut dsum: f64 = 0.0;
        for v in dash.iter() {
            dsum += *v;
        }
        let dashed = !dash.is_empty() && dsum > 0.0;
        let start = self.nverts();
        let mut rs: i64 = 0;
        for re in rings.ends.iter() {
            let mut ring: Vec<f64> = Vec::new();
            let mut i = rs;
            while i < *re {
                ring.push(rings.pts[i as usize]);
                i += 1;
            }
            rs = *re;
            let mut pieces = TtfRings::new();
            if dashed {
                pieces = dash_ring(&ring, &dash, c.stroke_dash_offset * self.s);
            } else {
                for v in ring.iter() {
                    pieces.pts.push(*v);
                }
                pieces.ends.push(pieces.pts.len() as i64);
            }
            let mut ps: i64 = 0;
            for pe in pieces.ends.iter() {
                let np = (*pe - ps) / 2;
                let p0 = ps as usize;
                ps = *pe;
                if np < 2 {
                    continue;
                }
                let pl = p0 + ((np - 1) * 2) as usize;
                let closed = pieces.pts[p0] == pieces.pts[pl] && pieces.pts[p0 + 1] == pieces.pts[pl + 1];
                for i in 0..(np - 1) {
                    let ia = p0 + (i * 2) as usize;
                    let mut ax = pieces.pts[ia];
                    let mut ay = pieces.pts[ia + 1];
                    let mut bx = pieces.pts[ia + 2];
                    let mut by = pieces.pts[ia + 3];
                    let dx = bx - ax;
                    let dy = by - ay;
                    let l = (dx * dx + dy * dy).sqrt();
                    if l < 1e-4 {
                        continue;
                    }
                    let ux = dx / l;
                    let uy = dy / l;
                    // (inner ends reach half a width on, which closes the
                    // joins of thin curves; the line's own ends only with a
                    // square cap)
                    let first = i == 0 && !closed;
                    let last = i == np - 2 && !closed;
                    if !first || c.stroke_cap == 2 {
                        ax -= ux * t / 2.0;
                        ay -= uy * t / 2.0;
                    }
                    if !last || c.stroke_cap == 2 {
                        bx += ux * t / 2.0;
                        by += uy * t / 2.0;
                    }
                    let nx = -uy * t / 2.0;
                    let ny = ux * t / 2.0;
                    self.quad(ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny, &k);
                }
                if t > 2.0 {
                    for i in 0..np {
                        let end = i == 0 || i == np - 1;
                        if (end && !closed && c.stroke_cap != 1) || (!end && c.stroke_join == 2) {
                            continue;
                        }
                        let q = p0 + (i * 2) as usize;
                        let qx = pieces.pts[q];
                        let qy = pieces.pts[q + 1];
                        self.disc(qx, qy, t / 2.0, &k);
                    }
                }
            }
        }
        self.rotate_from(start, c);
        self.shapes += 1;
    }

    fn disc(&mut self, cx: f64, cy: f64, r: f64, k: &PaintRgba) {
        let mut n = (r * 2.0).ceil() as i64;
        if n < 8 {
            n = 8;
        }
        if n > 32 {
            n = 32;
        }
        let mut pts: Vec<f64> = Vec::new();
        for i in 0..n {
            let a = (i as f64) / (n as f64) * 6.283185307179586;
            pts.push(cx + r * a.cos());
            pts.push(cy + r * a.sin());
        }
        let sh = PaintShade::solid(k.clone());
        self.fan(&pts, cx, cy, &sh);
    }

    // ----------------------------------------------------------------- text

    fn text(&mut self, c: &EVGDrawCmd) {
        let s = self.s;
        let size = c.font_size;
        if size <= 0.0 {
            return;
        }
        let italic = c.text_align == "italic";
        let key = format!("T{}|{}|{}|{}|{}|{}|{}|{}", c.font_family, c.font_weight, ri(size * 100.0), ri(c.letter_spacing * 100.0), italic, ri(c.w * 10.0), ri(s * 100.0), c.text);
        let frame = self.frame;
        if !self.texts.contains_key(&key) {
            let made = self.raster_text(c, size, italic);
            let Some(t) = made else {
                return;
            };
            self.texts.insert(key.clone(), Rc::new(RefCell::new(t)));
        }
        let t = self.texts.get(&key).cloned().unwrap();
        t.borrow_mut().used = frame;
        let id = t.borrow().id;
        let tw = t.borrow().w;
        let tth = t.borrow().h;
        let ox = t.borrow().ox;
        let oy = t.borrow().oy;
        // the baseline: the half leading below the line box's top plus the
        // face's ascent (evg-webgl's rule)
        let (fi, _fb) = self.face_for(&c.font_family, &c.font_weight);
        let mut fa: f64 = 0.905;
        let mut fd: f64 = 0.212;
        if fi >= 0 {
            let f = &self.faces[fi as usize];
            fa = f.asc / f.upm;
            fd = f.desc / f.upm;
        }
        let mut half: f64 = 0.0;
        if c.h > 0.0 {
            half = (c.h - (fa + fd) * size) / 2.0;
        }
        let x = self.px(c.x);
        let y = self.py(c.y);
        let base = y + (half + fa * size) * s;
        let k = PaintRgba::of(c.r, c.g, c.b, c.a);
        self.textured(id, x - ox, base - oy, tw, tth, 0.0, 0.0, 1.0, 1.0, &k, c);
        // colour emoji in their own colours, on the baseline the way the
        // text around them sits
        let emo = t.borrow().emo.clone();
        let white = PaintRgba::rgba(1.0, 1.0, 1.0, c.a);
        let n = emo.len() / 4;
        for i in 0..n {
            let eid = emo[i * 4] as i64;
            let ex = emo[i * 4 + 1];
            let ew = emo[i * 4 + 2];
            let eh = emo[i * 4 + 3];
            self.textured(eid, x + ex, base + size * 0.12 * s - eh, ew, eh, 0.0, 0.0, 1.0, 1.0, &white, c);
        }
        self.runs += 1;
    }

    fn emoji_advance(&self, cp: i64) -> f64 {
        let e = self.emoji.get(&cp).cloned();
        if let Some(t) = e {
            return t.borrow().ox;
        }
        1.0
    }

    fn raster_text(&mut self, c: &EVGDrawCmd, size: f64, italic: bool) -> Option<PaintCached> {
        let s = self.s;
        let (fi, fake_bold) = self.face_for(&c.font_family, &c.font_weight);
        if fi < 0 {
            return None;
        }
        // the glyphs, each from the first face that has it
        // (a colour emoji is face -1, its glyph the codepoint; U+FE0F and
        // U+200D draw nothing)
        let mut gf: Vec<i64> = Vec::new();
        let mut gg: Vec<i64> = Vec::new();
        let mut chs: Vec<char> = Vec::new();
        for ch in c.text.chars() {
            chs.push(ch);
        }
        for ci in 0..chs.len() {
            let ch = chs[ci];
            let cp = (ch as u32) as i64;
            if cp == 0xFE0F || cp == 0x200D {
                continue;
            }
            let mut sel = false;
            if ci + 1 < chs.len() {
                sel = ((chs[ci + 1] as u32) as i64) == 0xFE0F;
            }
            let mut f = fi;
            let mut g = self.faces[fi as usize].glyph(cp);
            if cp >= 0x1F000 || sel {
                if self.emoji_for(cp, true) {
                    gf.push(-1);
                    gg.push(cp);
                    continue;
                }
            }
            if g == 0 && !ch.is_whitespace() && cp >= 0x80 {
                if self.emoji_for(cp, true) {
                    gf.push(-1);
                    gg.push(cp);
                    continue;
                }
            }
            if g == 0 {
                for fb in self.fallback.iter() {
                    let gi = self.faces[*fb as usize].glyph(cp);
                    if gi != 0 {
                        f = *fb;
                        g = gi;
                        break;
                    }
                }
            }
            if g == 0 && ch.is_whitespace() {
                // (a space no face has, such as U+202F between the digits
                // of "8 000", is drawn as an ordinary space, not as the
                // missing-glyph box)
                f = fi;
                g = self.faces[fi as usize].glyph(32);
            }
            gf.push(f);
            gg.push(g);
        }
        let ls = c.letter_spacing;
        let mut natural: f64 = 0.0;
        for i in 0..gf.len() {
            if gf[i] < 0 {
                natural += self.emoji_advance(gg[i]) * size + ls;
                continue;
            }
            let f = &self.faces[gf[i] as usize];
            natural += f.advance(gg[i]) * size / f.upm + ls;
        }
        // (the run stretched to the width the layout measured, when that is
        // its own width: a field's lines all carry the field's text width,
        // and a short line stretched to it looked a size larger)
        let mut ratio: f64 = 1.0;
        if natural > 0.0 && c.w > 0.0 {
            ratio = c.w / natural;
        }
        let mut fit: f64 = 1.0;
        if ratio >= 0.85 && ratio <= 1.15 {
            fit = ratio;
        }
        let pad: f64 = 2.0;
        let face = &self.faces[fi as usize];
        let asc = face.asc / face.upm * size * s;
        let desc = face.desc / face.upm * size * s;
        let mut slant: f64 = 0.0;
        if italic {
            slant = 0.2;
        }
        let w = ((natural * fit * s) + 2.0 * pad + asc * slant + 2.0).ceil() as i64;
        let h = (asc + desc + 2.0 * pad).ceil() as i64;
        if w < 1 || h < 1 || w > 8192 || h > 2048 {
            return None;
        }
        let mut contours = TtfContours::new();
        let mut pen = pad;
        let base = pad + asc;
        let mut emo: Vec<f64> = Vec::new();
        for i in 0..gf.len() {
            if gf[i] < 0 {
                let e = self.emoji.get(&gg[i]).cloned().unwrap();
                let ew = e.borrow().ox * size * s * fit;
                let eh = ew * e.borrow().h / e.borrow().w;
                emo.push(e.borrow().id as f64);
                emo.push(pen - pad);
                emo.push(ew);
                emo.push(eh);
                pen += ew + ls * s * fit;
                continue;
            }
            let f = &self.faces[gf[i] as usize];
            let k = size * s / f.upm;
            f.outline(gg[i], k * fit, 0.0, slant * k, -k, pen, base, &mut contours, 0);
            pen += (f.advance(gg[i]) * size / f.upm + ls) * s * fit;
        }
        let rings = flatten(&contours, 0.25);
        let mut ras = Raster::new(w, h);
        ras.rings(&rings.pts, &rings.ends);
        let mut px = ras.rgba(false);
        if fake_bold {
            // (no bold face: the outline drawn twice, a little apart)
            let mut shifted: Vec<f64> = Vec::new();
            let n = rings.pts.len() / 2;
            for i in 0..n {
                shifted.push(rings.pts[i * 2] + 0.6 * s);
                shifted.push(rings.pts[i * 2 + 1]);
            }
            let mut ras2 = Raster::new(w, h);
            ras2.rings(&shifted, &rings.ends);
            let b = ras2.rgba(false);
            let m = px.len() / 4;
            for i in 0..m {
                let j = i * 4 + 3;
                if b[j] > px[j] {
                    px[j] = b[j];
                }
            }
        }
        let id = self.upload(w, h, px);
        let mut t = PaintCached::new();
        t.id = id;
        t.w = w as f64;
        t.h = h as f64;
        t.ox = pad;
        t.oy = base;
        t.used = self.frame;
        t.emo = emo;
        Some(t)
    }

    /// text of the window's own (a bar): CSS px of the window, baseline y;
    /// returns its width
    pub fn label(&mut self, text: &str, x: f64, y: f64, size: f64, bold: bool, k: &PaintRgba) -> f64 {
        let mut c = EVGDrawCmd::new();
        c.kind = TEXT;
        c.text = text.to_string();
        if bold {
            c.font_family = "Arial-Bold".to_string();
        } else {
            c.font_family = "Arial".to_string();
        }
        c.font_size = size;
        c.r = (k.r * 255.0) as i64;
        c.g = (k.g * 255.0) as i64;
        c.b = (k.b * 255.0) as i64;
        c.a = k.a;
        let w = self.measure(text, size, bold);
        c.w = w;
        c.x = x;
        c.y = y - self.top;
        c.h = size * 1.2;
        self.text(&c);
        w
    }

    /// a text's width with the window's own faces (CSS px)
    pub fn measure(&self, text: &str, size: f64, bold: bool) -> f64 {
        let mut fi = self.sans;
        if bold && self.bold >= 0 {
            fi = self.bold;
        }
        if fi < 0 {
            let mut n: f64 = 0.0;
            for _ch in text.chars() {
                n += 1.0;
            }
            return n * size * 0.5;
        }
        let f = &self.faces[fi as usize];
        let mut w: f64 = 0.0;
        for ch in text.chars() {
            w += f.advance(f.glyph((ch as u32) as i64)) * size / f.upm;
        }
        w
    }
}

/// Alpha outside a rounded box (x, y, w, h, r in the bitmap's pixels) taken
/// away, with a pixel of soft edge.
fn cut_rrect(px: &mut Vec<u8>, bw: i64, bh: i64, x: f64, y: f64, w: f64, h: f64, r0: f64) {
    let r = maxf(minf(minf(r0, w / 2.0), h / 2.0), 0.0);
    for j in 0..bh {
        for i in 0..bw {
            let cx = (i as f64) + 0.5;
            let cy = (j as f64) + 0.5;
            // distance outside the rounded box (negative inside)
            let qx = (cx - (x + w / 2.0)).abs() - (w / 2.0 - r);
            let qy = (cy - (y + h / 2.0)).abs() - (h / 2.0 - r);
            let mx = maxf(qx, 0.0);
            let my = maxf(qy, 0.0);
            let d = (mx * mx + my * my).sqrt() + minf(maxf(qx, qy), 0.0) - r;
            let cov = clampf(0.5 - d, 0.0, 1.0);
            if cov < 1.0 {
                let k = ((j * bw + i) * 4 + 3) as usize;
                px[k] = (((px[k] as f64) * cov) as i64) as u8;
            }
        }
    }
}

/// a stroke's dash pattern (stroke-dasharray), in window pixels
fn dash_pattern(spec: &str, s: f64) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    let mut tok = String::new();
    let mut all = spec.to_string();
    all.push(' ');
    for ch in all.chars() {
        if ch == ',' || ch.is_whitespace() {
            if !tok.is_empty() {
                match tok.trim().parse::<f64>() {
                    Ok(v) => {
                        if v >= 0.0 {
                            out.push(v * s);
                        }
                    }
                    Err(_) => {}
                }
                tok = String::new();
            }
        } else {
            tok.push(ch);
        }
    }
    out
}

/// A polyline (x, y pairs) cut by a dash pattern (on, off, on, ...) into
/// its "on" pieces.
fn dash_ring(r: &Vec<f64>, pat: &Vec<f64>, offset: f64) -> TtfRings {
    let mut out = TtfRings::new();
    let np = (r.len() / 2) as i64;
    if np < 1 {
        return out;
    }
    let mut total: f64 = 0.0;
    for v in pat.iter() {
        total += *v;
    }
    let plen = pat.len() as i64;
    let mut k: i64 = 0;
    let mut left = pat[0];
    // (the offset walks into the pattern first)
    let m = maxf(total, 1e-3);
    let mut off = offset % m;
    if off < 0.0 {
        off += m;
    }
    while off > 0.0 {
        if off >= left {
            off -= left;
            k = (k + 1) % plen;
            left = pat[k as usize];
        } else {
            left -= off;
            off = 0.0;
        }
    }
    let mut cur: Vec<f64> = Vec::new();
    if k % 2 == 0 {
        cur.push(r[0]);
        cur.push(r[1]);
    }
    let mut guard: i64 = 0;
    for i in 0..(np - 1) {
        let mut ax = r[(i * 2) as usize];
        let mut ay = r[(i * 2 + 1) as usize];
        let bx = r[(i * 2 + 2) as usize];
        let by = r[(i * 2 + 3) as usize];
        let mut l = ((bx - ax) * (bx - ax) + (by - ay) * (by - ay)).sqrt();
        while l > 0.0 && guard < 100000 {
            guard += 1;
            if left >= l {
                left -= l;
                if k % 2 == 0 {
                    cur.push(bx);
                    cur.push(by);
                }
                l = 0.0;
            } else {
                let t = left / l;
                let mx = ax + (bx - ax) * t;
                let my = ay + (by - ay) * t;
                if k % 2 == 0 {
                    cur.push(mx);
                    cur.push(my);
                    for v in cur.iter() {
                        out.pts.push(*v);
                    }
                    out.ends.push(out.pts.len() as i64);
                    cur = Vec::new();
                } else {
                    cur = vec![mx, my];
                }
                l -= left;
                ax = mx;
                ay = my;
                k = (k + 1) % plen;
                left = pat[k as usize];
                if left <= 0.0 {
                    left = 1e-3;
                }
            }
        }
    }
    if k % 2 == 0 && cur.len() >= 4 {
        for v in cur.iter() {
            out.pts.push(*v);
        }
        out.ends.push(out.pts.len() as i64);
    }
    out
}
