// SPDX-License-Identifier: MIT
//
// TrueType faces (glyf outlines) read and rasterized here, with no library:
// the character map, advances, the outlines (simple and composite glyphs)
// and an area-coverage rasterizer that also fills the display list's paths.

pub struct Face {
    data: Vec<u8>,
    pub upm: f32,
    pub asc: f32,
    pub desc: f32,
    loca_long: bool,
    num_glyphs: u16,
    num_hmetrics: u16,
    glyf: usize,
    loca: usize,
    hmtx: usize,
    cmap: usize, // the chosen subtable
    cmap_fmt: u16,
}

fn u16_at(d: &[u8], o: usize) -> u16 { if o + 2 <= d.len() { u16::from_be_bytes([d[o], d[o + 1]]) } else { 0 } }
fn i16_at(d: &[u8], o: usize) -> i16 { u16_at(d, o) as i16 }
fn u32_at(d: &[u8], o: usize) -> u32 { if o + 4 <= d.len() { u32::from_be_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]) } else { 0 } }

impl Face {
    /// a .ttf, or the first face of a .ttc; None for a face without glyf
    /// outlines (CFF) or one that does not read
    pub fn parse(data: Vec<u8>) -> Option<Face> {
        let mut base = 0usize;
        if &data.get(0..4)? == b"ttcf" { base = u32_at(&data, 12) as usize; }
        let n = u16_at(&data, base + 4) as usize;
        let mut tab = std::collections::HashMap::new();
        for i in 0..n {
            let r = base + 12 + i * 16;
            let tag = data.get(r..r + 4)?.to_vec();
            tab.insert(tag, u32_at(&data, r + 8) as usize);
        }
        let get = |t: &[u8]| tab.get(t).copied();
        let head = get(b"head")?;
        let hhea = get(b"hhea")?;
        let maxp = get(b"maxp")?;
        let glyf = get(b"glyf")?;
        let loca = get(b"loca")?;
        let hmtx = get(b"hmtx")?;
        let cmap = get(b"cmap")?;
        // a Unicode subtable: format 12 (full range) before format 4 (BMP)
        let nsub = u16_at(&data, cmap + 2) as usize;
        let (mut best, mut fmt) = (0usize, 0u16);
        for i in 0..nsub {
            let r = cmap + 4 + i * 8;
            let (pid, eid) = (u16_at(&data, r), u16_at(&data, r + 2));
            let off = cmap + u32_at(&data, r + 4) as usize;
            let f = u16_at(&data, off);
            let unicode = pid == 0 || (pid == 3 && (eid == 1 || eid == 10));
            if !unicode { continue; }
            if f == 12 && fmt != 12 { best = off; fmt = 12; }
            else if f == 4 && fmt == 0 { best = off; fmt = 4; }
        }
        if fmt == 0 { return None; }
        let os2 = get(b"OS/2");
        // (the browser's line metrics: hhea, as Chromium on macOS reads them)
        let (asc, desc) = (i16_at(&data, hhea + 4) as f32, -(i16_at(&data, hhea + 6) as f32));
        let _ = os2;
        Some(Face {
            upm: u16_at(&data, head + 18) as f32,
            asc,
            desc,
            loca_long: i16_at(&data, head + 50) != 0,
            num_glyphs: u16_at(&data, maxp + 4),
            num_hmetrics: u16_at(&data, hhea + 34),
            glyf, loca, hmtx, cmap: best, cmap_fmt: fmt,
            data,
        })
    }

    pub fn glyph(&self, ch: u32) -> u16 {
        let d = &self.data;
        let t = self.cmap;
        if self.cmap_fmt == 12 {
            let n = u32_at(d, t + 12) as usize;
            let (mut lo, mut hi) = (0usize, n);
            while lo < hi {
                let m = (lo + hi) / 2;
                let r = t + 16 + m * 12;
                let (s, e) = (u32_at(d, r), u32_at(d, r + 4));
                if ch < s { hi = m } else if ch > e { lo = m + 1 } else { return (u32_at(d, r + 8) + (ch - s)) as u16; }
            }
            return 0;
        }
        if ch > 0xffff { return 0; }
        let segx2 = u16_at(d, t + 6) as usize;
        let ends = t + 14;
        let starts = ends + segx2 + 2;
        let deltas = starts + segx2;
        let ranges = deltas + segx2;
        for i in (0..segx2).step_by(2) {
            let end = u16_at(d, ends + i) as u32;
            if ch > end { continue; }
            let start = u16_at(d, starts + i) as u32;
            if ch < start { return 0; }
            let delta = u16_at(d, deltas + i);
            let ro = u16_at(d, ranges + i) as usize;
            if ro == 0 { return (ch as u16).wrapping_add(delta); }
            let g = u16_at(d, ranges + i + ro + 2 * (ch - start) as usize);
            return if g == 0 { 0 } else { g.wrapping_add(delta) };
        }
        0
    }

    pub fn advance(&self, g: u16) -> f32 {
        let i = if g < self.num_hmetrics { g } else { self.num_hmetrics.saturating_sub(1) } as usize;
        u16_at(&self.data, self.hmtx + i * 4) as f32
    }

    fn glyph_range(&self, g: u16) -> Option<(usize, usize)> {
        if g >= self.num_glyphs { return None; }
        let d = &self.data;
        let (a, b) = if self.loca_long {
            (u32_at(d, self.loca + g as usize * 4) as usize, u32_at(d, self.loca + g as usize * 4 + 4) as usize)
        } else {
            (u16_at(d, self.loca + g as usize * 2) as usize * 2, u16_at(d, self.loca + g as usize * 2 + 2) as usize * 2)
        };
        if b <= a { None } else { Some((self.glyf + a, self.glyf + b)) }
    }

    /// The glyph's outline as closed contours of line and quadratic
    /// segments, in font units (y up), transformed by m (a b c d e f).
    pub fn outline(&self, g: u16, m: [f32; 6], out: &mut Vec<Vec<(f32, f32, bool)>>, depth: u32) {
        let Some((o, _)) = self.glyph_range(g) else { return };
        let d = &self.data;
        let nc = i16_at(d, o);
        if nc >= 0 {
            let nc = nc as usize;
            let mut ends = Vec::with_capacity(nc);
            for i in 0..nc { ends.push(u16_at(d, o + 10 + i * 2) as usize); }
            let npts = ends.last().map(|e| e + 1).unwrap_or(0);
            let il = u16_at(d, o + 10 + nc * 2) as usize;
            let mut p = o + 12 + nc * 2 + il;
            let mut flags = Vec::with_capacity(npts);
            while flags.len() < npts {
                let f = *d.get(p).unwrap_or(&0); p += 1;
                flags.push(f);
                if f & 8 != 0 { let r = *d.get(p).unwrap_or(&0); p += 1; for _ in 0..r { flags.push(f); } }
            }
            flags.truncate(npts);
            let mut xs = Vec::with_capacity(npts);
            let mut v = 0i32;
            for &f in &flags {
                if f & 2 != 0 { let dx = *d.get(p).unwrap_or(&0) as i32; p += 1; v += if f & 16 != 0 { dx } else { -dx }; }
                else if f & 16 == 0 { v += i16_at(d, p) as i32; p += 2; }
                xs.push(v);
            }
            let mut ys = Vec::with_capacity(npts);
            v = 0;
            for &f in &flags {
                if f & 4 != 0 { let dy = *d.get(p).unwrap_or(&0) as i32; p += 1; v += if f & 32 != 0 { dy } else { -dy }; }
                else if f & 32 == 0 { v += i16_at(d, p) as i32; p += 2; }
                ys.push(v);
            }
            let tf = |x: i32, y: i32| { let (x, y) = (x as f32, y as f32); (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]) };
            let mut s = 0;
            for &e in &ends {
                if e < s || e >= npts { break; }
                let mut c = Vec::with_capacity(e - s + 2);
                for i in s..=e { let (x, y) = tf(xs[i], ys[i]); c.push((x, y, flags[i] & 1 != 0)); }
                out.push(c);
                s = e + 1;
            }
        } else if depth < 8 {
            let mut p = o + 10;
            loop {
                let fl = u16_at(d, p);
                let gi = u16_at(d, p + 2);
                p += 4;
                let (dx, dy) = if fl & 1 != 0 { let r = (i16_at(d, p) as f32, i16_at(d, p + 2) as f32); p += 4; r }
                    else { let r = (d[p] as i8 as f32, d[p + 1] as i8 as f32); p += 2; r };
                let f2 = |o: usize| i16_at(d, o) as f32 / 16384.0;
                let (mut a, mut b, mut c, mut dd) = (1.0, 0.0, 0.0, 1.0);
                if fl & 8 != 0 { a = f2(p); dd = a; p += 2; }
                else if fl & 0x40 != 0 { a = f2(p); dd = f2(p + 2); p += 4; }
                else if fl & 0x80 != 0 { a = f2(p); b = f2(p + 2); c = f2(p + 4); dd = f2(p + 6); p += 8; }
                // (offsets as points to match are rare; taken as zero)
                let (ex, ey) = if fl & 2 != 0 { (dx, dy) } else { (0.0, 0.0) };
                // child m' = m ∘ [a b c dd ex ey]
                let cm = [
                    m[0] * a + m[2] * b, m[1] * a + m[3] * b,
                    m[0] * c + m[2] * dd, m[1] * c + m[3] * dd,
                    m[0] * ex + m[2] * ey + m[4], m[1] * ex + m[3] * ey + m[5],
                ];
                self.outline(gi, cm, out, depth + 1);
                if fl & 0x20 == 0 { break; }
            }
        }
    }
}

/// Contours (on/off curve points) flattened to closed polylines.
pub fn flatten(contours: &[Vec<(f32, f32, bool)>], tol: f32) -> Vec<Vec<(f32, f32)>> {
    let mut rings = Vec::new();
    for c in contours {
        if c.len() < 2 { continue; }
        // a start that is on the curve (or the midpoint of two off ones)
        let n = c.len();
        let start = match c.iter().position(|p| p.2) {
            Some(i) => (c[i].0, c[i].1, i),
            None => (((c[0].0 + c[n - 1].0) / 2.0), ((c[0].1 + c[n - 1].1) / 2.0), n - 1),
        };
        let mut ring = vec![(start.0, start.1)];
        let mut cur = (start.0, start.1);
        let mut ctrl: Option<(f32, f32)> = None;
        for k in 1..=n {
            let p = c[(start.2 + k) % n];
            let pt = (p.0, p.1);
            if p.2 {
                match ctrl.take() { Some(q) => quad(&mut ring, cur, q, pt, tol), None => ring.push(pt) }
                cur = pt;
            } else if let Some(q) = ctrl {
                let mid = ((q.0 + pt.0) / 2.0, (q.1 + pt.1) / 2.0);
                quad(&mut ring, cur, q, mid, tol);
                cur = mid;
                ctrl = Some(pt);
            } else {
                ctrl = Some(pt);
            }
        }
        if let Some(q) = ctrl { quad(&mut ring, cur, q, (start.0, start.1), tol); }
        rings.push(ring);
    }
    rings
}

fn quad(ring: &mut Vec<(f32, f32)>, a: (f32, f32), q: (f32, f32), b: (f32, f32), tol: f32) {
    let dd = ((a.0 - 2.0 * q.0 + b.0).powi(2) + (a.1 - 2.0 * q.1 + b.1).powi(2)).sqrt();
    let n = ((dd / tol).sqrt().ceil() as usize).clamp(1, 32);
    for i in 1..=n {
        let t = i as f32 / n as f32;
        let u = 1.0 - t;
        ring.push((u * u * a.0 + 2.0 * u * t * q.0 + t * t * b.0, u * u * a.1 + 2.0 * u * t * q.1 + t * t * b.1));
    }
}

/// Signed-area coverage accumulation (one cell per pixel, the sum along a
/// row is the winding number): closed polylines in, 8-bit alpha out.
pub struct Raster {
    pub w: usize,
    pub h: usize,
    a: Vec<f32>,
}

impl Raster {
    pub fn new(w: usize, h: usize) -> Raster { Raster { w, h, a: vec![0.0; w * h + 4] } }

    pub fn line(&mut self, p0: (f32, f32), p1: (f32, f32)) {
        let maxx = self.w as f32 - 1.001;
        let p0 = (p0.0.clamp(0.0, maxx), p0.1);
        let p1 = (p1.0.clamp(0.0, maxx), p1.1);
        if (p0.1 - p1.1).abs() <= f32::EPSILON { return; }
        let (dir, p0, p1) = if p0.1 < p1.1 { (1.0, p0, p1) } else { (-1.0, p1, p0) };
        let dxdy = (p1.0 - p0.0) / (p1.1 - p0.1);
        let mut x = p0.0;
        if p0.1 < 0.0 { x -= p0.1 * dxdy; }
        let y0 = p0.1.max(0.0) as usize;
        let yend = (self.h).min(p1.1.ceil().max(0.0) as usize);
        for y in y0..yend {
            let ls = y * self.w;
            let dy = ((y + 1) as f32).min(p1.1) - (y as f32).max(p0.1);
            let xnext = x + dxdy * dy;
            let d = dy * dir;
            let (x0, x1) = if x < xnext { (x, xnext) } else { (xnext, x) };
            let x0f = x0.floor();
            let x0i = x0f as usize;
            let x1c = x1.ceil();
            let x1i = x1c as usize;
            if x1i <= x0i + 1 {
                let xmf = 0.5 * (x + xnext) - x0f;
                self.a[ls + x0i] += d - d * xmf;
                self.a[ls + x0i + 1] += d * xmf;
            } else {
                let s = 1.0 / (x1 - x0);
                let x0r = x0 - x0f;
                let a0 = 0.5 * s * (1.0 - x0r) * (1.0 - x0r);
                let x1r = x1 - x1c + 1.0;
                let am = 0.5 * s * x1r * x1r;
                self.a[ls + x0i] += d * a0;
                if x1i == x0i + 2 {
                    self.a[ls + x0i + 1] += d * (1.0 - a0 - am);
                } else {
                    let a1 = s * (1.5 - x0r);
                    self.a[ls + x0i + 1] += d * (a1 - a0);
                    for xi in x0i + 2..x1i - 1 { self.a[ls + xi] += d * s; }
                    let a2 = a1 + (x1i - x0i - 3) as f32 * s;
                    self.a[ls + x1i - 1] += d * (1.0 - a2 - am);
                }
                self.a[ls + x1i] += d * am;
            }
            x = xnext;
        }
    }

    pub fn rings(&mut self, rings: &[Vec<(f32, f32)>]) {
        for r in rings {
            for i in 0..r.len() { self.line(r[i], r[(i + 1) % r.len()]); }
        }
    }

    /// RGBA, white with the coverage as alpha
    pub fn rgba(&self, even_odd: bool) -> Vec<u8> {
        let mut out = vec![255u8; self.w * self.h * 4];
        let mut acc = 0.0f32;
        for i in 0..self.w * self.h {
            acc += self.a[i];
            let w = acc.abs();
            let c = if even_odd { let f = w % 2.0; if f > 1.0 { 2.0 - f } else { f } } else { w.min(1.0) };
            out[i * 4 + 3] = (c * 255.0 + 0.5) as u8;
        }
        out
    }
}
