// SPDX-License-Identifier: MIT
//!
//! TrueType faces (glyf outlines) read with no library: the character map
//! (formats 12 and 4), advances, and the outlines of simple and composite
//! glyphs as contours of on- and off-curve points; `flatten` turns those
//! into closed polylines for the rasterizer (raster.rs).
//!
//! Ranger reads this file too (strict Rust): it is compiled to C++ for
//! EVGBrowser's desktop build, so it keeps to f64 / i64 / Vec and plain
//! loops.

/// a glyph's outline: points (x, y, on the curve), and where each contour
/// ends in them (exclusive)
#[derive(Clone)]
pub struct TtfContours {
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub on: Vec<bool>,
    pub ends: Vec<i64>,
}

impl TtfContours {
    pub fn new() -> Self {
        Self {
            xs: Vec::new(),
            ys: Vec::new(),
            on: Vec::new(),
            ends: Vec::new(),
        }
    }
}

/// closed polylines: x, y pairs in `pts`, where each ring ends in `ends`
/// (counted in numbers, as EVG's display list counts them)
#[derive(Clone)]
pub struct TtfRings {
    pub pts: Vec<f64>,
    pub ends: Vec<i64>,
}

impl TtfRings {
    pub fn new() -> Self {
        Self {
            pts: Vec::new(),
            ends: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct TtfFace {
    data: Vec<u8>,
    pub ok: bool,
    pub upm: f64,
    pub asc: f64,
    pub desc: f64,
    loca_long: bool,
    num_glyphs: i64,
    num_hmetrics: i64,
    glyf: i64,
    loca: i64,
    hmtx: i64,
    cmap: i64,
    cmap_fmt: i64,
}

fn u8_at(d: &Vec<u8>, o: i64) -> i64 {
    if o >= 0 && (o as usize) < d.len() {
        d[o as usize] as i64
    } else {
        0
    }
}

fn u16_at(d: &Vec<u8>, o: i64) -> i64 {
    (u8_at(d, o) << 8) | u8_at(d, o + 1)
}

fn i16_at(d: &Vec<u8>, o: i64) -> i64 {
    let v = u16_at(d, o);
    if v >= 32768 {
        v - 65536
    } else {
        v
    }
}

fn u32_at(d: &Vec<u8>, o: i64) -> i64 {
    (u16_at(d, o) << 16) | u16_at(d, o + 2)
}

fn tag_at(d: &Vec<u8>, o: i64) -> String {
    let mut s = String::new();
    for k in 0..4 {
        let c = u8_at(d, o + k);
        if c >= 32 && c < 127 {
            s.push((c as u8) as char);
        } else {
            s.push('?');
        }
    }
    s
}

impl TtfFace {
    pub fn empty() -> Self {
        Self {
            data: Vec::new(),
            ok: false,
            upm: 1000.0,
            asc: 0.0,
            desc: 0.0,
            loca_long: false,
            num_glyphs: 0,
            num_hmetrics: 0,
            glyf: 0,
            loca: 0,
            hmtx: 0,
            cmap: 0,
            cmap_fmt: 0,
        }
    }

    /// a .ttf, or the first face of a .ttc; `ok` is false for a face
    /// without glyf outlines (CFF) or one that does not read
    pub fn parse(data: Vec<u8>) -> TtfFace {
        let mut f = TtfFace::empty();
        if data.len() < 12 {
            return f;
        }
        let mut base: i64 = 0;
        if tag_at(&data, 0) == "ttcf" {
            base = u32_at(&data, 12);
        }
        let n = u16_at(&data, base + 4);
        let mut head: i64 = -1;
        let mut hhea: i64 = -1;
        let mut maxp: i64 = -1;
        let mut glyf: i64 = -1;
        let mut loca: i64 = -1;
        let mut hmtx: i64 = -1;
        let mut cmap: i64 = -1;
        for i in 0..n {
            let r = base + 12 + i * 16;
            let tag = tag_at(&data, r);
            let off = u32_at(&data, r + 8);
            if tag == "head" {
                head = off;
            } else if tag == "hhea" {
                hhea = off;
            } else if tag == "maxp" {
                maxp = off;
            } else if tag == "glyf" {
                glyf = off;
            } else if tag == "loca" {
                loca = off;
            } else if tag == "hmtx" {
                hmtx = off;
            } else if tag == "cmap" {
                cmap = off;
            }
        }
        if head < 0 || hhea < 0 || maxp < 0 || glyf < 0 || loca < 0 || hmtx < 0 || cmap < 0 {
            return f;
        }
        // a Unicode subtable: format 12 (full range) before format 4 (BMP)
        let nsub = u16_at(&data, cmap + 2);
        let mut best: i64 = 0;
        let mut fmt: i64 = 0;
        for i in 0..nsub {
            let r = cmap + 4 + i * 8;
            let pid = u16_at(&data, r);
            let eid = u16_at(&data, r + 2);
            let off = cmap + u32_at(&data, r + 4);
            let sf = u16_at(&data, off);
            let unicode = pid == 0 || (pid == 3 && (eid == 1 || eid == 10));
            if !unicode {
                continue;
            }
            if sf == 12 && fmt != 12 {
                best = off;
                fmt = 12;
            } else if sf == 4 && fmt == 0 {
                best = off;
                fmt = 4;
            }
        }
        if fmt == 0 {
            return f;
        }
        // (the browser's line metrics: hhea, as Chromium on macOS reads them)
        f.asc = i16_at(&data, hhea + 4) as f64;
        f.desc = -(i16_at(&data, hhea + 6) as f64);
        f.upm = u16_at(&data, head + 18) as f64;
        if f.upm <= 0.0 {
            f.upm = 1000.0;
        }
        f.loca_long = i16_at(&data, head + 50) != 0;
        f.num_glyphs = u16_at(&data, maxp + 4);
        f.num_hmetrics = u16_at(&data, hhea + 34);
        f.glyf = glyf;
        f.loca = loca;
        f.hmtx = hmtx;
        f.cmap = best;
        f.cmap_fmt = fmt;
        f.data = data;
        f.ok = true;
        f
    }

    /// the glyph of a code point, 0 when the face has none
    pub fn glyph(&self, ch: i64) -> i64 {
        if !self.ok {
            return 0;
        }
        let d = &self.data;
        let t = self.cmap;
        if self.cmap_fmt == 12 {
            let n = u32_at(d, t + 12);
            let mut lo: i64 = 0;
            let mut hi: i64 = n;
            while lo < hi {
                let m = (lo + hi) / 2;
                let r = t + 16 + m * 12;
                let s = u32_at(d, r);
                let e = u32_at(d, r + 4);
                if ch < s {
                    hi = m;
                } else if ch > e {
                    lo = m + 1;
                } else {
                    return (u32_at(d, r + 8) + (ch - s)) & 65535;
                }
            }
            return 0;
        }
        if ch > 65535 {
            return 0;
        }
        let segx2 = u16_at(d, t + 6);
        let ends = t + 14;
        let starts = ends + segx2 + 2;
        let deltas = starts + segx2;
        let ranges = deltas + segx2;
        let mut i: i64 = 0;
        while i < segx2 {
            let end = u16_at(d, ends + i);
            if ch > end {
                i += 2;
                continue;
            }
            let start = u16_at(d, starts + i);
            if ch < start {
                return 0;
            }
            let delta = u16_at(d, deltas + i);
            let ro = u16_at(d, ranges + i);
            if ro == 0 {
                return (ch + delta) & 65535;
            }
            let g = u16_at(d, ranges + i + ro + 2 * (ch - start));
            if g == 0 {
                return 0;
            }
            return (g + delta) & 65535;
        }
        0
    }

    /// the glyph's advance in font units
    pub fn advance(&self, g: i64) -> f64 {
        if !self.ok || self.num_hmetrics <= 0 {
            return 0.0;
        }
        let mut i = g;
        if i >= self.num_hmetrics {
            i = self.num_hmetrics - 1;
        }
        u16_at(&self.data, self.hmtx + i * 4) as f64
    }

    /// where the glyph's data starts in the font, -1 for an empty glyph
    fn glyph_start(&self, g: i64) -> i64 {
        if g < 0 || g >= self.num_glyphs {
            return -1;
        }
        let d = &self.data;
        let mut a: i64 = 0;
        let mut b: i64 = 0;
        if self.loca_long {
            a = u32_at(d, self.loca + g * 4);
            b = u32_at(d, self.loca + g * 4 + 4);
        } else {
            a = u16_at(d, self.loca + g * 2) * 2;
            b = u16_at(d, self.loca + g * 2 + 2) * 2;
        }
        if b <= a {
            return -1;
        }
        self.glyf + a
    }

    /// The glyph's outline as contours of on- and off-curve points, in font
    /// units (y up), mapped by (x, y) -> (ma x + mc y + me, mb x + md y + mf).
    pub fn outline(&self, g: i64, ma: f64, mb: f64, mc: f64, md: f64, me: f64, mf: f64, out: &mut TtfContours, depth: i64) {
        let o = self.glyph_start(g);
        if o < 0 {
            return;
        }
        let d = &self.data;
        let nc = i16_at(d, o);
        if nc >= 0 {
            let mut ends: Vec<i64> = Vec::new();
            for i in 0..nc {
                ends.push(u16_at(d, o + 10 + i * 2));
            }
            let mut npts: i64 = 0;
            if nc > 0 {
                npts = ends[(nc - 1) as usize] + 1;
            }
            let il = u16_at(d, o + 10 + nc * 2);
            let mut p = o + 12 + nc * 2 + il;
            let mut flags: Vec<i64> = Vec::new();
            while (flags.len() as i64) < npts {
                let fl = u8_at(d, p);
                p += 1;
                flags.push(fl);
                if (fl & 8) != 0 {
                    let r = u8_at(d, p);
                    p += 1;
                    for _k in 0..r {
                        flags.push(fl);
                    }
                }
            }
            let mut xs: Vec<i64> = Vec::new();
            let mut v: i64 = 0;
            for i in 0..npts {
                let fl = flags[i as usize];
                if (fl & 2) != 0 {
                    let dx = u8_at(d, p);
                    p += 1;
                    if (fl & 16) != 0 {
                        v += dx;
                    } else {
                        v -= dx;
                    }
                } else if (fl & 16) == 0 {
                    v += i16_at(d, p);
                    p += 2;
                }
                xs.push(v);
            }
            let mut ys: Vec<i64> = Vec::new();
            v = 0;
            for i in 0..npts {
                let fl = flags[i as usize];
                if (fl & 4) != 0 {
                    let dy = u8_at(d, p);
                    p += 1;
                    if (fl & 32) != 0 {
                        v += dy;
                    } else {
                        v -= dy;
                    }
                } else if (fl & 32) == 0 {
                    v += i16_at(d, p);
                    p += 2;
                }
                ys.push(v);
            }
            let mut s: i64 = 0;
            for ci in 0..nc {
                let e = ends[ci as usize];
                if e < s || e >= npts {
                    break;
                }
                for i in s..(e + 1) {
                    let x = xs[i as usize] as f64;
                    let y = ys[i as usize] as f64;
                    out.xs.push(ma * x + mc * y + me);
                    out.ys.push(mb * x + md * y + mf);
                    out.on.push((flags[i as usize] & 1) != 0);
                }
                out.ends.push(out.xs.len() as i64);
                s = e + 1;
            }
        } else if depth < 8 {
            let mut p = o + 10;
            loop {
                let fl = u16_at(d, p);
                let gi = u16_at(d, p + 2);
                p += 4;
                let mut dx: f64 = 0.0;
                let mut dy: f64 = 0.0;
                if (fl & 1) != 0 {
                    dx = i16_at(d, p) as f64;
                    dy = i16_at(d, p + 2) as f64;
                    p += 4;
                } else {
                    let bx = u8_at(d, p);
                    let by = u8_at(d, p + 1);
                    dx = (if bx >= 128 { bx - 256 } else { bx }) as f64;
                    dy = (if by >= 128 { by - 256 } else { by }) as f64;
                    p += 2;
                }
                let mut a: f64 = 1.0;
                let mut b: f64 = 0.0;
                let mut c: f64 = 0.0;
                let mut dd: f64 = 1.0;
                if (fl & 8) != 0 {
                    a = (i16_at(d, p) as f64) / 16384.0;
                    dd = a;
                    p += 2;
                } else if (fl & 64) != 0 {
                    a = (i16_at(d, p) as f64) / 16384.0;
                    dd = (i16_at(d, p + 2) as f64) / 16384.0;
                    p += 4;
                } else if (fl & 128) != 0 {
                    a = (i16_at(d, p) as f64) / 16384.0;
                    b = (i16_at(d, p + 2) as f64) / 16384.0;
                    c = (i16_at(d, p + 4) as f64) / 16384.0;
                    dd = (i16_at(d, p + 6) as f64) / 16384.0;
                    p += 8;
                }
                // (offsets as points to match are rare; taken as zero)
                let mut ex: f64 = 0.0;
                let mut ey: f64 = 0.0;
                if (fl & 2) != 0 {
                    ex = dx;
                    ey = dy;
                }
                // the child's map: this one after [a b c dd ex ey]
                let na = ma * a + mc * b;
                let nb = mb * a + md * b;
                let nc2 = ma * c + mc * dd;
                let nd = mb * c + md * dd;
                let ne = ma * ex + mc * ey + me;
                let nf = mb * ex + md * ey + mf;
                self.outline(gi, na, nb, nc2, nd, ne, nf, out, depth + 1);
                if (fl & 32) == 0 {
                    break;
                }
            }
        }
    }
}

/// a quadratic curve from (ax, ay) by (qx, qy) to (bx, by), as line points
fn quad(out: &mut Vec<f64>, ax: f64, ay: f64, qx: f64, qy: f64, bx: f64, by: f64, tol: f64) {
    let ex = ax - 2.0 * qx + bx;
    let ey = ay - 2.0 * qy + by;
    let dd = (ex * ex + ey * ey).sqrt();
    let mut n = (dd / tol).sqrt().ceil() as i64;
    if n < 1 {
        n = 1;
    }
    if n > 32 {
        n = 32;
    }
    for i in 1..(n + 1) {
        let t = (i as f64) / (n as f64);
        let u = 1.0 - t;
        out.push(u * u * ax + 2.0 * u * t * qx + t * t * bx);
        out.push(u * u * ay + 2.0 * u * t * qy + t * t * by);
    }
}

/// Contours (on / off curve points) flattened to closed polylines.
pub fn flatten(c: &TtfContours, tol: f64) -> TtfRings {
    let mut rings = TtfRings::new();
    let mut s: i64 = 0;
    for ci in 0..c.ends.len() {
        let e = c.ends[ci];
        let n = e - s;
        if n < 2 {
            s = e;
            continue;
        }
        // a start on the curve (or the midpoint of the last and first off ones)
        let mut first: i64 = -1;
        for k in 0..n {
            if c.on[(s + k) as usize] {
                first = k;
                break;
            }
        }
        let mut sx: f64 = 0.0;
        let mut sy: f64 = 0.0;
        let mut si: i64 = 0;
        if first >= 0 {
            sx = c.xs[(s + first) as usize];
            sy = c.ys[(s + first) as usize];
            si = first;
        } else {
            sx = (c.xs[s as usize] + c.xs[(s + n - 1) as usize]) / 2.0;
            sy = (c.ys[s as usize] + c.ys[(s + n - 1) as usize]) / 2.0;
            si = n - 1;
        }
        rings.pts.push(sx);
        rings.pts.push(sy);
        let mut cx = sx;
        let mut cy = sy;
        let mut has_q = false;
        let mut qx: f64 = 0.0;
        let mut qy: f64 = 0.0;
        for k in 1..(n + 1) {
            let j = (s + ((si + k) % n)) as usize;
            let px = c.xs[j];
            let py = c.ys[j];
            if c.on[j] {
                if has_q {
                    quad(&mut rings.pts, cx, cy, qx, qy, px, py, tol);
                    has_q = false;
                } else {
                    rings.pts.push(px);
                    rings.pts.push(py);
                }
                cx = px;
                cy = py;
            } else if has_q {
                let mx = (qx + px) / 2.0;
                let my = (qy + py) / 2.0;
                quad(&mut rings.pts, cx, cy, qx, qy, mx, my, tol);
                cx = mx;
                cy = my;
                qx = px;
                qy = py;
            } else {
                has_q = true;
                qx = px;
                qy = py;
            }
        }
        if has_q {
            quad(&mut rings.pts, cx, cy, qx, qy, sx, sy, tol);
        }
        rings.ends.push(rings.pts.len() as i64);
        s = e;
    }
    rings
}
