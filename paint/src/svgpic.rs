// SPDX-License-Identifier: MIT
//!
//! An SVG picture (a page's background-image, an <img> of an .svg) drawn
//! into w x h pixels, xMidYMid meet: EVG's SVG parser reads it, its paths
//! are flattened by EVG and filled and stroked here (raster.rs).

use std::rc::Rc;

use ranger::cell::RefCell;

use crate::raster::Raster;
use crate::rgr::{PathRing, SVGPathParser, SvgDocument, SvgParser, SvgVectorItem, VectorViewBox};

/// coverage (alpha of a white RGBA) in colour (r, g, b 0-255, a 0-1) over out
fn over(out: &mut Vec<u8>, cov: &Vec<u8>, r: f64, g: f64, b: f64, a: f64) {
    let n = out.len() / 4;
    for p in 0..n {
        let i = p * 4;
        let sa = (cov[i + 3] as f64) / 255.0 * a;
        if sa <= 0.0 {
            continue;
        }
        let da = (out[i + 3] as f64) / 255.0;
        let oa = sa + da * (1.0 - sa);
        out[i] = mix(r, out[i] as f64, sa, da, oa);
        out[i + 1] = mix(g, out[i + 1] as f64, sa, da, oa);
        out[i + 2] = mix(b, out[i + 2] as f64, sa, da, oa);
        out[i + 3] = ((oa * 255.0).round() as i64) as u8;
    }
}

fn mix(c: f64, d: f64, sa: f64, da: f64, oa: f64) -> u8 {
    let mut v = ((c * sa + d * da * (1.0 - sa)) / oa).round();
    if v < 0.0 {
        v = 0.0;
    }
    if v > 255.0 {
        v = 255.0;
    }
    (v as i64) as u8
}

/// An SVG drawn into w x h pixels (xMidYMid meet), RGBA, not premultiplied.
pub fn rasterize(svg: &str, w: i64, h: i64) -> Vec<u8> {
    let mut out: Vec<u8> = vec![0u8; (w * h * 4) as usize];
    let sp: Rc<RefCell<SvgParser>> = Rc::new(RefCell::new(SvgParser::new()));
    let doc: Rc<RefCell<SvgDocument>> = SvgParser::parse(&sp, svg.to_string());
    if SvgDocument::item_count(&doc) == 0 {
        return out;
    }
    let vb = SvgDocument::effective_view_box(&doc);
    let m = VectorViewBox::resolve(&vb, w as f64, h as f64, "xMidYMid meet");
    let ma = m.borrow().a;
    let mb = m.borrow().b;
    let mc = m.borrow().c;
    let md = m.borrow().d;
    let me = m.borrow().e;
    let mf = m.borrow().f;
    let scale = (ma * md - mb * mc).abs().sqrt();
    let items = doc.borrow().items.clone();
    for it in items.iter() {
        let cmds = it.borrow().commands.clone();
        let parser = SVGPathParser::from_commands(cmds);
        let rings: Vec<Rc<RefCell<PathRing>>> = SVGPathParser::flatten_rings(&parser, 16, ma, mb, mc, md, me, mf);
        if SvgVectorItem::has_fill(it) {
            let mut pts: Vec<f64> = Vec::new();
            let mut ends: Vec<i64> = Vec::new();
            for r in rings.iter() {
                let rp = r.borrow().pts.clone();
                if rp.len() >= 6 {
                    for v in rp.iter() {
                        pts.push(*v);
                    }
                    ends.push(pts.len() as i64);
                }
            }
            let fc = it.borrow().fill_color.clone();
            if let Some(c) = fc {
                let mut ras = Raster::new(w, h);
                ras.rings(&pts, &ends);
                let eo = it.borrow().fill_rule == "evenodd";
                let cov = ras.rgba(eo);
                let cr = c.borrow().r as f64;
                let cg = c.borrow().g as f64;
                let cb = c.borrow().b as f64;
                let ca = c.borrow().a;
                over(&mut out, &cov, cr, cg, cb, ca);
            }
        }
        if SvgVectorItem::has_stroke(it) {
            let sc = it.borrow().stroke_color.clone();
            if let Some(c) = sc {
                let t = it.borrow().stroke_width * scale;
                let mut quads: Vec<f64> = Vec::new();
                let mut ends: Vec<i64> = Vec::new();
                for r in rings.iter() {
                    let p = r.borrow().pts.clone();
                    let closed = r.borrow().closed;
                    let n = (p.len() / 2) as i64;
                    if n < 2 {
                        continue;
                    }
                    let mut segs = n - 1;
                    if closed {
                        segs = n;
                    }
                    for i in 0..segs {
                        let ia = (i * 2) as usize;
                        let ib = (((i + 1) % n) * 2) as usize;
                        let dx = p[ib] - p[ia];
                        let dy = p[ib + 1] - p[ia + 1];
                        let l = (dx * dx + dy * dy).sqrt();
                        if l < 1e-4 {
                            continue;
                        }
                        // (each piece reaches half a width past its ends,
                        // which fills the joins of a polyline; wound the same
                        // way, so overlaps add)
                        let ux = dx / l * t / 2.0;
                        let uy = dy / l * t / 2.0;
                        let nx = -uy;
                        let ny = ux;
                        let ax = p[ia] - ux;
                        let ay = p[ia + 1] - uy;
                        let bx = p[ib] + ux;
                        let by = p[ib + 1] + uy;
                        quads.push(ax + nx);
                        quads.push(ay + ny);
                        quads.push(bx + nx);
                        quads.push(by + ny);
                        quads.push(bx - nx);
                        quads.push(by - ny);
                        quads.push(ax - nx);
                        quads.push(ay - ny);
                        ends.push(quads.len() as i64);
                    }
                }
                let mut ras = Raster::new(w, h);
                ras.rings(&quads, &ends);
                let cov = ras.rgba(false);
                let cr = c.borrow().r as f64;
                let cg = c.borrow().g as f64;
                let cb = c.borrow().b as f64;
                let ca = c.borrow().a;
                over(&mut out, &cov, cr, cg, cb, ca);
            }
        }
    }
    out
}
