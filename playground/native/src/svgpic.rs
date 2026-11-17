// SPDX-License-Identifier: MIT
//
// The page's SVG pictures of background-image (Bootstrap's check mark and
// switch knob, a select's arrow): DomView names each `dompng-<n>-<hash>`
// of its data: URL (DomView::pngPart) and the display list draws it by that
// name (IMAGE). The URLs come from the render tree's background-image
// values; the shared painter (rangerdom_paint) draws each.

use std::collections::HashMap;

use rangerdom_view::DomView;

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
