// SPDX-License-Identifier: MIT
//!
//! Signed-area coverage accumulation (one cell per pixel, the sum along a
//! row is the winding number): closed polylines in, 8-bit alpha out. Fills
//! text runs, the display list's paths and SVG pictures.

#[derive(Clone)]
pub struct Raster {
    pub w: i64,
    pub h: i64,
    a: Vec<f64>,
}

impl Raster {
    pub fn new(w: i64, h: i64) -> Raster {
        let a: Vec<f64> = vec![0.0; (w * h + 4) as usize];
        Raster { w: w, h: h, a: a }
    }

    pub fn line(&mut self, ax: f64, ay: f64, bx: f64, by: f64) {
        let maxx = (self.w as f64) - 1.001;
        let mut x0p = ax;
        let mut x1p = bx;
        if x0p < 0.0 {
            x0p = 0.0;
        }
        if x0p > maxx {
            x0p = maxx;
        }
        if x1p < 0.0 {
            x1p = 0.0;
        }
        if x1p > maxx {
            x1p = maxx;
        }
        if (ay - by).abs() <= 1e-9 {
            return;
        }
        let mut dir: f64 = 1.0;
        let mut px0 = x0p;
        let mut py0 = ay;
        let mut px1 = x1p;
        let mut py1 = by;
        if ay > by {
            dir = -1.0;
            px0 = x1p;
            py0 = by;
            px1 = x0p;
            py1 = ay;
        }
        let dxdy = (px1 - px0) / (py1 - py0);
        let mut x = px0;
        if py0 < 0.0 {
            x -= py0 * dxdy;
        }
        let mut y0: i64 = 0;
        if py0 > 0.0 {
            y0 = py0 as i64;
        }
        let mut yend: i64 = 0;
        if py1 > 0.0 {
            yend = py1.ceil() as i64;
        }
        if yend > self.h {
            yend = self.h;
        }
        let mut y = y0;
        while y < yend {
            let ls = y * self.w;
            let mut top = y as f64;
            if py0 > top {
                top = py0;
            }
            let mut bot = (y + 1) as f64;
            if py1 < bot {
                bot = py1;
            }
            let dy = bot - top;
            let xnext = x + dxdy * dy;
            let d = dy * dir;
            let mut xa = x;
            let mut xb = xnext;
            if xa > xb {
                xa = xnext;
                xb = x;
            }
            let x0f = xa.floor();
            let x0i = x0f as i64;
            let x1c = xb.ceil();
            let x1i = x1c as i64;
            if x1i <= x0i + 1 {
                let xmf = 0.5 * (x + xnext) - x0f;
                self.add(ls + x0i, d - d * xmf);
                self.add(ls + x0i + 1, d * xmf);
            } else {
                let s = 1.0 / (xb - xa);
                let x0r = xa - x0f;
                let a0 = 0.5 * s * (1.0 - x0r) * (1.0 - x0r);
                let x1r = xb - x1c + 1.0;
                let am = 0.5 * s * x1r * x1r;
                self.add(ls + x0i, d * a0);
                if x1i == x0i + 2 {
                    self.add(ls + x0i + 1, d * (1.0 - a0 - am));
                } else {
                    let a1 = s * (1.5 - x0r);
                    self.add(ls + x0i + 1, d * (a1 - a0));
                    let mut xi = x0i + 2;
                    while xi < x1i - 1 {
                        self.add(ls + xi, d * s);
                        xi += 1;
                    }
                    let a2 = a1 + ((x1i - x0i - 3) as f64) * s;
                    self.add(ls + x1i - 1, d * (1.0 - a2 - am));
                }
                self.add(ls + x1i, d * am);
            }
            x = xnext;
            y += 1;
        }
    }

    fn add(&mut self, i: i64, v: f64) {
        if i >= 0 && (i as usize) < self.a.len() {
            let k = i as usize;
            self.a[k] = self.a[k] + v;
        }
    }

    /// closed rings: x, y pairs in pts, each ring ending at its `ends` entry
    /// (counted in numbers); no ends is one ring
    pub fn rings(&mut self, pts: &Vec<f64>, ends: &Vec<i64>) {
        let mut start: i64 = 0;
        let mut k: usize = 0;
        let total = pts.len() as i64;
        loop {
            let mut e = total;
            if k < ends.len() {
                e = ends[k];
            } else if k > 0 || !ends.is_empty() {
                break;
            }
            if e > total {
                e = total;
            }
            let n = (e - start) / 2;
            if n >= 2 {
                for i in 0..n {
                    let a = (start + i * 2) as usize;
                    let b = (start + ((i + 1) % n) * 2) as usize;
                    self.line(pts[a], pts[a + 1], pts[b], pts[b + 1]);
                }
            }
            start = e;
            k += 1;
            if ends.is_empty() {
                break;
            }
        }
    }

    /// RGBA, white with the coverage as alpha
    pub fn rgba(&self, even_odd: bool) -> Vec<u8> {
        let n = (self.w * self.h) as usize;
        let mut out: Vec<u8> = vec![255u8; n * 4];
        let mut acc: f64 = 0.0;
        for i in 0..n {
            acc += self.a[i];
            let w = acc.abs();
            let mut c = w;
            if even_odd {
                let f = w % 2.0;
                if f > 1.0 {
                    c = 2.0 - f;
                } else {
                    c = f;
                }
            } else if c > 1.0 {
                c = 1.0;
            }
            let mut v = (c * 255.0 + 0.5) as i64;
            if v > 255 {
                v = 255;
            }
            out[i * 4 + 3] = v as u8;
        }
        out
    }
}
