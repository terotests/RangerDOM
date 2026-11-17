// SPDX-License-Identifier: MIT
//
// The page's SVG pictures of background-image (Bootstrap's check mark and
// switch knob, a select's arrow): DomView names each `dompng-<n>-<hash>`
// of its data: URL (DomView::pngPart) and the display list draws it by that
// name (IMAGE). The URLs come from the render tree's background-image
// values; EVG's SVG parser reads each and its paths are rasterized here.

use std::collections::HashMap;
use std::rc::Rc;

use ranger::cell::RefCell;
use rangerdom_view::DomView;
use rangerevg::{PathRing, SVGPathParser, SvgDocument, SvgParser, SvgVectorItem, VectorViewBox};

use crate::ttf::Raster;

/// name -> SVG text, for every SVG data: URL a render tree has shown
#[derive(Default)]
pub struct Pictures {
    pub svgs: HashMap<String, String>,
    /// names a paint asked for and nobody knew yet; and every name asked
    /// for once (asked again only when a new one turns up)
    pub missing: Vec<String>,
    pub asked: std::collections::HashSet<String>,
}

/// the page's SVG background-image values (elements and their ::before and
/// ::after), as a JSON array
pub const PAGE_QUERY: &str = "(function(){var o=[];var a=document.querySelectorAll('*');function t(s){try{var b=s&&s.backgroundImage;if(b&&b.indexOf('data:image/svg')>=0)o.push(b)}catch(e){}}for(var i=0;i<a.length;i++){t(getComputedStyle(a[i]));try{t(getComputedStyle(a[i],'::before'));t(getComputedStyle(a[i],'::after'))}catch(e){}}var m=window.__rdMaskPictures||[];for(var j=0;j<m.length;j++)o.push(m[j]);return JSON.stringify(o)})()";

fn json_string_at(s: &str, start: usize) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = start;
    while i < b.len() && b[i] != b'"' {
        if b[i] == b'\\' && i + 1 < b.len() {
            i += 1;
            match b[i] {
                b'n' => out.push(b'\n'),
                b't' => out.push(b'\t'),
                b'r' => out.push(b'\r'),
                b'u' if i + 4 < b.len() => {
                    if let Some(c) = std::str::from_utf8(&b[i + 1..i + 5]).ok().and_then(|h| u32::from_str_radix(h, 16).ok()).and_then(char::from_u32) {
                        let mut buf = [0u8; 4];
                        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                    }
                    i += 4;
                }
                c => out.push(c),
            }
        } else {
            out.push(b[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("x"), 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn base64_decode(s: &str) -> String {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes() {
        let v = match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' | b'-' => 62, b'/' | b'_' => 63, _ => continue } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// the SVG text of a data:image/svg+xml URL
fn svg_of(url: &str) -> Option<String> {
    let comma = url.find(',')?;
    let head = &url[..comma];
    let body = &url[comma + 1..];
    Some(if head.contains(";base64") { base64_decode(body) } else { percent_decode(body) })
}

impl Pictures {
    /// the values PAGE_QUERY answered
    pub fn add_values(&mut self, json_array: &str) -> usize {
        let mut n = 0;
        let b = json_array.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'"' {
                let v = json_string_at(json_array, i + 1);
                // (past the string: its escapes are two bytes each)
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' { if b[j] == b'\\' { j += 1; } j += 1; }
                i = j;
                let u = DomView::bgSvgUrl(&v);
                if u.is_empty() { i += 1; continue; }
                let name = DomView::pngPart(&u);
                if !self.svgs.contains_key(&name) { if let Some(svg) = svg_of(&u) { self.svgs.insert(name, svg); n += 1; } }
            }
            i += 1;
        }
        n
    }

    /// the SVG background pictures a render tree (its JSON) names
    pub fn scan(&mut self, json: &str) {
        if !json.contains("data:image/svg") { return; }
        let key = "\"background-image\":\"";
        let mut at = 0;
        while let Some(p) = json[at..].find(key) {
            let start = at + p + key.len();
            let v = json_string_at(json, start);
            at = start;
            let u = DomView::bgSvgUrl(&v);
            if u.is_empty() { continue; }
            let name = DomView::pngPart(&u);
            if self.svgs.contains_key(&name) { continue; }
            if let Some(svg) = svg_of(&u) { self.svgs.insert(name, svg); }
        }
    }
}

/// An SVG drawn into w x h pixels (xMidYMid meet), RGBA, not premultiplied.
pub fn rasterize(svg: &str, w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 4];
    let sp = Rc::new(RefCell::new(SvgParser::new()));
    let doc = SvgParser::parse(&sp, svg.to_string());
    if SvgDocument::item_count(&doc) == 0 { return out; }
    let vb = SvgDocument::effective_view_box(&doc);
    let m = VectorViewBox::resolve(&vb, w as f64, h as f64, "xMidYMid meet");
    let (ma, mb, mc, md, me, mf) = { let m = m.borrow(); (m.a, m.b, m.c, m.d, m.e, m.f) };
    let scale = (ma * md - mb * mc).abs().sqrt();
    let items = doc.borrow().items.clone();
    for it in &items {
        let cmds = it.borrow().commands.clone();
        let parser = SVGPathParser::from_commands(cmds);
        let rings: Vec<Rc<RefCell<PathRing>>> = SVGPathParser::flatten_rings(&parser, 16, ma, mb, mc, md, me, mf);
        let polys: Vec<(Vec<(f32, f32)>, bool)> = rings.iter().map(|r| {
            let r = r.borrow();
            (r.pts.chunks(2).filter(|p| p.len() == 2).map(|p| (p[0] as f32, p[1] as f32)).collect(), r.closed)
        }).collect();
        if SvgVectorItem::has_fill(it) {
            let c = it.borrow().fill_color.clone().unwrap();
            let c = c.borrow();
            let mut ras = Raster::new(w, h);
            let closed: Vec<Vec<(f32, f32)>> = polys.iter().map(|p| p.0.clone()).filter(|p| p.len() >= 3).collect();
            ras.rings(&closed);
            let eo = it.borrow().fill_rule == "evenodd";
            over(&mut out, &ras.rgba(eo), [c.r as f32, c.g as f32, c.b as f32, c.a as f32]);
        }
        if SvgVectorItem::has_stroke(it) {
            let c = it.borrow().stroke_color.clone().unwrap();
            let c = c.borrow();
            let t = (it.borrow().stroke_width * scale) as f32;
            let mut ras = Raster::new(w, h);
            let mut quads = Vec::new();
            for (p, closed) in &polys {
                let n = p.len();
                if n < 2 { continue; }
                let segs = if *closed { n } else { n - 1 };
                for i in 0..segs {
                    let (a, b) = (p[i], p[(i + 1) % n]);
                    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                    let l = (dx * dx + dy * dy).sqrt();
                    if l < 1e-4 { continue; }
                    // (each piece reaches half a width past its ends, which
                    // fills the joins of a polyline)
                    let (ux, uy) = (dx / l * t / 2.0, dy / l * t / 2.0);
                    let (nx, ny) = (-uy, ux);
                    let (a, b) = ((a.0 - ux, a.1 - uy), (b.0 + ux, b.1 + uy));
                    // (wound the same way, so overlaps add)
                    quads.push(vec![(a.0 + nx, a.1 + ny), (b.0 + nx, b.1 + ny), (b.0 - nx, b.1 - ny), (a.0 - nx, a.1 - ny)]);
                }
            }
            ras.rings(&quads);
            over(&mut out, &ras.rgba(false), [c.r as f32, c.g as f32, c.b as f32, c.a as f32]);
        }
    }
    out
}

/// coverage (alpha of a white RGBA) in colour c (0-255, alpha 0-1) over out
fn over(out: &mut [u8], cov: &[u8], c: [f32; 4]) {
    for i in (0..out.len()).step_by(4) {
        let sa = cov[i + 3] as f32 / 255.0 * c[3];
        if sa <= 0.0 { continue; }
        let da = out[i + 3] as f32 / 255.0;
        let oa = sa + da * (1.0 - sa);
        for k in 0..3 {
            let d = out[i + k] as f32;
            out[i + k] = ((c[k] * sa + d * da * (1.0 - sa)) / oa).round().clamp(0.0, 255.0) as u8;
        }
        out[i + 3] = (oa * 255.0).round() as u8;
    }
}
