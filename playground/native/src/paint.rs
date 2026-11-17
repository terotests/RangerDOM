// SPDX-License-Identifier: MIT
//
// The window's painter: RangerDOM's shared painter (paint/, the crate
// rangerdom_paint, which EVGBrowser's desktop build compiles to C++ with
// Ranger) makes EVG's display list into triangles, textures and clips, and
// this runs them with SDL3's renderer. Everything about how a box, a run of
// text or a picture looks is in the crate; here are only the SDL calls and
// the fonts' files.

use std::collections::HashMap;
use std::ffi::c_int;
use std::rc::Rc;

use ranger::cell::RefCell;
use rangerdom_paint::{DlPainter, PaintRgba, OP_CLIP, OP_DRAW, OP_UNCLIP};
use rangerevg::EVGDisplayList;

use crate::sdl::{self, Rect, Renderer, Texture, Vertex};
use crate::svgpic::Pictures;

pub struct Painter {
    pub ren: *mut Renderer,
    /// window pixels per CSS pixel
    pub s: f32,
    /// where the page starts in the window (CSS px, below the bar)
    pub top: f32,
    pub pictures: Pictures,
    /// shapes and text runs the last frame drew
    pub stats: (usize, usize),
    dl: DlPainter,
    texs: HashMap<i64, *mut Texture>,
    verts: Vec<Vertex>,
    idx: Vec<c_int>,
}

fn rgba(c: [f32; 4]) -> PaintRgba { PaintRgba::rgba(c[0] as f64, c[1] as f64, c[2] as f64, c[3] as f64) }

impl Painter {
    pub fn new(ren: *mut Renderer) -> Painter {
        let mut dl = DlPainter::new();
        // each role's face: RANGERDOM_FONT_DIR's file of that name first,
        // then the system's (DlPainter::font_candidates)
        let dir = std::env::var("RANGERDOM_FONT_DIR").ok();
        for role in ["sans", "bold", "mono", "fallback"] {
            for p in DlPainter::font_candidates(role) {
                let full = match (&dir, p.starts_with('/') || p.contains(':')) {
                    (Some(d), false) => format!("{}/{}", d, p),
                    _ => p.clone(),
                };
                let Ok(data) = std::fs::read(&full) else { continue };
                if dl.add_face(role, data) && role != "fallback" { break; }
            }
        }
        Painter { ren, s: 1.0, top: 0.0, pictures: Pictures::default(), stats: (0, 0), dl, texs: HashMap::new(), verts: Vec::new(), idx: Vec::new() }
    }

    pub fn has_font(&self) -> bool { self.dl.has_font() }

    fn sync(&mut self) {
        self.dl.s = self.s as f64;
        self.dl.top = self.top as f64;
    }

    /// the start of a frame
    pub fn begin(&mut self) {
        self.sync();
        self.dl.begin();
    }

    pub fn clip_window(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.sync();
        self.dl.clip_window(x as f64, y as f64, w as f64, h as f64);
    }

    pub fn unclip(&mut self) { self.dl.unclip(); }

    pub fn draw_list(&mut self, list: &Rc<RefCell<EVGDisplayList>>) {
        self.sync();
        // the SVG pictures the render trees named, as the painter draws them
        for (name, svg) in self.pictures.svgs.iter() {
            if !self.dl.has_svg(name) { self.dl.set_svg(name, svg); }
        }
        self.dl.draw_list(list);
        // (the page's canvas pictures and SVG backgrounds no render tree
        // showed: asked of the page by the caller)
        for m in std::mem::take(&mut self.dl.missing) {
            if m.starts_with("dompng-") && !self.pictures.asked.contains(&m) { self.pictures.missing.push(m); }
        }
    }

    /// a filled box of the window's own (the bar), CSS px of the window
    pub fn fill(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, c: [f32; 4]) {
        self.sync();
        self.dl.fill(x as f64, y as f64, w as f64, h as f64, r as f64, &rgba(c));
    }

    /// text of the window's own (the bar): CSS px of the window, top y
    pub fn label(&mut self, text: &str, x: f32, y: f32, size: f32, bold: bool, k: [f32; 4]) -> f32 {
        self.sync();
        self.dl.label(text, x as f64, y as f64, size as f64, bold, &rgba(k)) as f32
    }

    pub fn measure(&self, text: &str, size: f32, bold: bool) -> f32 { self.dl.measure(text, size as f64, bold) as f32 }

    /// the frame's output run with SDL: textures made, triangles and clips
    /// drawn, unused textures destroyed
    pub fn flush(&mut self) {
        self.dl.end();
        let ren = self.ren;
        for t in self.dl.uploads.iter() {
            unsafe {
                let tex = sdl::SDL_CreateTexture(ren, sdl::PIXELFORMAT_ABGR8888, sdl::TEXTUREACCESS_STATIC, t.w as c_int, t.h as c_int);
                if tex.is_null() { continue; }
                sdl::SDL_SetTextureBlendMode(tex, sdl::BLENDMODE_BLEND);
                sdl::SDL_UpdateTexture(tex, std::ptr::null(), t.px.as_ptr() as *const _, (t.w * 4) as c_int);
                self.texs.insert(t.id, tex);
            }
        }
        let v = &self.dl.verts;
        self.verts.clear();
        let mut i = 0;
        while i + 8 <= v.len() {
            self.verts.push(Vertex { x: v[i] as f32, y: v[i + 1] as f32, r: v[i + 2] as f32, g: v[i + 3] as f32, b: v[i + 4] as f32, a: v[i + 5] as f32, u: v[i + 6] as f32, v: v[i + 7] as f32 });
            i += 8;
        }
        self.idx.clear();
        for k in self.dl.idx.iter() { self.idx.push(*k as c_int); }
        let ops = &self.dl.ops;
        let mut o = 0;
        while o + 6 <= ops.len() {
            let (kind, a, b, c, d, e) = (ops[o], ops[o + 1], ops[o + 2], ops[o + 3], ops[o + 4], ops[o + 5]);
            o += 6;
            unsafe {
                if kind == OP_DRAW {
                    let tex = if a == 0 { std::ptr::null_mut() } else { match self.texs.get(&a) { Some(t) => *t, None => continue } };
                    sdl::SDL_RenderGeometry(ren, tex, self.verts.as_ptr().add(b as usize), c as c_int, self.idx.as_ptr().add(d as usize), e as c_int);
                } else if kind == OP_CLIP {
                    let r = Rect { x: a as c_int, y: b as c_int, w: c as c_int, h: d as c_int };
                    sdl::SDL_SetRenderClipRect(ren, &r);
                } else if kind == OP_UNCLIP {
                    sdl::SDL_SetRenderClipRect(ren, std::ptr::null());
                }
            }
        }
        for id in self.dl.frees.iter() {
            if let Some(t) = self.texs.remove(id) { unsafe { sdl::SDL_DestroyTexture(t) } }
        }
        self.dl.done();
        self.stats = (self.dl.shapes as usize, self.dl.runs as usize);
    }
}
