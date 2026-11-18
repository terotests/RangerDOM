// SPDX-License-Identifier: MIT
//!
//! A fixed display list (every kind of command) painted at 2x, and a digest
//! of the output: the cargo build and Ranger's builds of this crate must
//! print the same one (tools/paint-check.mjs).

use std::rc::Rc;

use ranger::cell::RefCell;

use crate::painter::DlPainter;
use crate::rgr::{EVGDisplayList, EVGDrawCmd, EVGDrawTile};

pub struct PaintCheck {
    cmds: Vec<Rc<RefCell<EVGDrawCmd>>>,
}

impl PaintCheck {
    fn add(&mut self, kind: i64, x: f64, y: f64, w: f64, h: f64, r: i64, g: i64, b: i64, a: f64) -> Rc<RefCell<EVGDrawCmd>> {
        let c: Rc<RefCell<EVGDrawCmd>> = Rc::new(RefCell::new(EVGDrawCmd::new()));
        c.borrow_mut().kind = kind;
        c.borrow_mut().x = x;
        c.borrow_mut().y = y;
        c.borrow_mut().w = w;
        c.borrow_mut().h = h;
        c.borrow_mut().r = r;
        c.borrow_mut().g = g;
        c.borrow_mut().b = b;
        c.borrow_mut().a = a;
        self.cmds.push(c.clone());
        c
    }

    /// the digest of a painted frame
    pub fn digest(p: &DlPainter) -> String {
        let mut vs: f64 = 0.0;
        for i in 0..p.verts.len() {
            vs += p.verts[i] * (((i % 7) + 1) as f64);
        }
        let mut is: i64 = 0;
        for i in 0..p.idx.len() {
            is += p.idx[i] * (((i % 5) + 1) as i64);
        }
        let mut os: i64 = 0;
        for i in 0..p.ops.len() {
            os += p.ops[i] * (((i % 3) + 1) as i64);
        }
        let mut ts: i64 = 0;
        let mut tw: i64 = 0;
        for t in p.uploads.iter() {
            tw += t.w * 1000 + t.h;
            for k in 0..t.px.len() {
                ts += (t.px[k] as i64) * (((k % 11) + 1) as i64);
            }
        }
        format!(
            "verts {} idx {} ops {} uploads {} | v {} i {} o {} t {} {} | shapes {} runs {}",
            p.verts.len(),
            p.idx.len(),
            p.ops.len(),
            p.uploads.len(),
            (vs * 100.0).round() as i64,
            is,
            os,
            tw,
            ts,
            p.shapes,
            p.runs
        )
    }

    /// the fixed list painted with `face` as the sans face
    pub fn run(face: Vec<u8>) -> String {
        let mut k = PaintCheck { cmds: Vec::new() };
        // a rounded box with a gradient and a shadow
        let a = k.add(0, 10.0, 10.0, 120.0, 40.0, 30, 90, 200, 1.0);
        a.borrow_mut().radius = 8.0;
        a.borrow_mut().has_grad = true;
        a.borrow_mut().r2 = 200;
        a.borrow_mut().g2 = 40;
        a.borrow_mut().b2 = 90;
        a.borrow_mut().a2 = 0.8;
        a.borrow_mut().has_shadow = true;
        a.borrow_mut().shadow_blur = 6.0;
        a.borrow_mut().shadow_y = 2.0;
        // a border with per-corner radii, turned
        let b = k.add(1, 150.0, 10.0, 80.0, 50.0, 0, 0, 0, 0.6);
        b.borrow_mut().thickness = 2.0;
        b.borrow_mut().per_corner = true;
        b.borrow_mut().radius = 4.0;
        b.borrow_mut().radius_tr = 12.0;
        b.borrow_mut().radius_br = 0.0;
        b.borrow_mut().radius_bl = 20.0;
        b.borrow_mut().rotate = 15.0;
        // a clip and a group
        k.add(4, 0.0, 0.0, 200.0, 100.0, 0, 0, 0, 1.0);
        k.add(8, 0.0, 0.0, 0.0, 0.0, 0, 0, 0, 0.5);
        // text
        let t = k.add(3, 12.0, 60.0, 90.0, 20.0, 10, 10, 10, 1.0);
        t.borrow_mut().text = "Hello, EVG! Ångström".to_string();
        t.borrow_mut().font_family = "Arial".to_string();
        t.borrow_mut().font_size = 15.0;
        let tb = k.add(3, 12.0, 80.0, 60.0, 20.0, 10, 10, 10, 1.0);
        tb.borrow_mut().text = "bold".to_string();
        tb.borrow_mut().font_family = "Arial".to_string();
        tb.borrow_mut().font_weight = "700".to_string();
        tb.borrow_mut().font_size = 13.0;
        // a filled path (a star, even-odd) cut to a rounded box
        let p = k.add(6, 100.0, 60.0, 40.0, 40.0, 200, 0, 0, 1.0);
        p.borrow_mut().even_odd = true;
        p.borrow_mut().radius = 6.0;
        p.borrow_mut().pts = vec![120.0, 60.0, 132.0, 98.0, 100.0, 74.0, 140.0, 74.0, 108.0, 98.0];
        k.add(9, 0.0, 0.0, 0.0, 0.0, 0, 0, 0, 1.0);
        k.add(5, 0.0, 0.0, 0.0, 0.0, 0, 0, 0, 1.0);
        // a dashed stroke with round caps
        let s = k.add(7, 0.0, 0.0, 0.0, 0.0, 0, 120, 0, 1.0);
        s.borrow_mut().thickness = 3.0;
        s.borrow_mut().stroke_cap = 1;
        s.borrow_mut().stroke_dash = "6, 3".to_string();
        s.borrow_mut().pts = vec![10.0, 120.0, 90.0, 140.0, 170.0, 120.0];
        // pictures: an SVG one in a tile, a decoded one cropped, a missing one
        let i = k.add(2, 200.0, 110.0, 24.0, 24.0, 0, 0, 0, 1.0);
        i.borrow_mut().src = "pic-svg".to_string();
        let tile: Rc<RefCell<EVGDrawTile>> = Rc::new(RefCell::new(EVGDrawTile::new()));
        tile.borrow_mut().x = 196.0;
        tile.borrow_mut().y = 106.0;
        tile.borrow_mut().w = 32.0;
        tile.borrow_mut().h = 32.0;
        i.borrow_mut().tile = Some(tile);
        let j = k.add(2, 10.0, 150.0, 60.0, 30.0, 0, 0, 0, 0.9);
        j.borrow_mut().src = "pic-rgba".to_string();
        let m = k.add(2, 80.0, 150.0, 30.0, 30.0, 0, 0, 0, 1.0);
        m.borrow_mut().src = "pic-missing".to_string();

        let dl: Rc<RefCell<EVGDisplayList>> = Rc::new(RefCell::new(EVGDisplayList::new()));
        for c in k.cmds.iter() {
            dl.borrow_mut().cmds.push(c.clone());
        }
        let mut pa = DlPainter::new();
        pa.s = 2.0;
        pa.top = 4.0;
        let had = pa.add_face("sans", face);
        pa.set_svg("pic-svg", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill='#0a0' d='M2 8 L6 12 L14 3' stroke='#030' stroke-width='2'/><circle cx='8' cy='8' r='3' fill='#f00'/></svg>");
        let mut px: Vec<u8> = vec![0u8; 4 * 4 * 4];
        for q in 0..px.len() {
            px[q] = ((q * 37) % 256) as u8;
        }
        pa.set_image("pic-rgba", 4, 4, px);
        pa.begin();
        pa.draw_list(&dl);
        let lw = pa.label("Bar", 4.0, 190.0, 12.0, false, &crate::painter::PaintRgba::rgba(0.1, 0.2, 0.3, 1.0));
        pa.end();
        let mut out = format!("face {} label {} missing {}\n", had, (lw * 100.0).round() as i64, pa.missing.len());
        out.push_str(&PaintCheck::digest(&pa));
        out
    }
}
