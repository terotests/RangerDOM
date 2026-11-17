// SPDX-License-Identifier: MIT
//! Byte views of text for the hand-written parsers: the UTF-8 bytes of a
//! string once, as a `Vec<int>`, so that indexing is cheap on every target;
//! and the index searches of the converted .rgr code (indexOf and friends).

use ranger::prelude::*;

pub struct DomText {}

impl DomText {
    pub fn utf8(text: &str) -> Vec<int> {
        let mut out: Vec<int> = Vec::new();
        for b in text.bytes() {
            out.push(b as int);
        }
        out
    }

    /// byte index of the first `key` in `text`, -1 when there is none
    pub fn index_of(text: &str, key: &str) -> int {
        DomText::index_of_from(text, key, 0)
    }

    /// byte index of the first `key` at or after `from`, -1 when none
    pub fn index_of_from(text: &str, key: &str, from: int) -> int {
        if from < 0 || from as usize > text.as_bytes().len() {
            return -1;
        }
        if key.as_bytes().len() <= 16 {
            return DomText::find_short(text, key, from);
        }
        if let Some(p) = text[from as usize..].find(key) {
            return p as int + from;
        }
        -1
    }

    /// `index_of_from` for a short key by comparing bytes: str::find sets
    /// up a two-way searcher on every call, which costs more than the
    /// search itself for keys like "url(" or ")" (DomView::style calls it
    /// about a million times in the shadcn case). A byte match of UTF-8
    /// starts on a character boundary, so the index is the same.
    fn find_short(text: &str, key: &str, from: int) -> int {
        let t = text.as_bytes();
        let k = key.as_bytes();
        let m: usize = k.len();
        let n: usize = t.len();
        let mut i: usize = from as usize;
        if m == 0 {
            return from;
        }
        if m > n {
            return -1;
        }
        let first = k[0];
        while i + m <= n {
            if t[i] == first {
                let mut j: usize = 1;
                while j < m && t[i + j] == k[j] {
                    j += 1;
                }
                if j == m {
                    return i as int;
                }
            }
            i += 1;
        }
        -1
    }

    /// The character that starts at byte `i`, whole, and "" at a byte inside
    /// one: a walk over the bytes that copies `unit_at` of each copies the
    /// text. A copy of one byte (`text[i..i + 1]`) splits a multibyte
    /// character; the Ranger -> Rust build makes each piece valid UTF-8 on
    /// its own, so every byte of an "ä" or "€" became a U+FFFD.
    pub fn unit_at(text: &str, i: int) -> String {
        let n: int = text.as_bytes().len() as int;
        if i < 0 || i >= n {
            return String::new();
        }
        let c: int = text.as_bytes()[i as usize] as int;
        if c >= 128 && c < 192 {
            return String::new();
        }
        let mut e: int = i + 1;
        while e < n && (text.as_bytes()[e as usize] as int) >= 128 && (text.as_bytes()[e as usize] as int) < 192 {
            e += 1;
        }
        text[i as usize..e as usize].to_string()
    }

    /// byte index of the last `key` in `text`, -1 when there is none
    pub fn last_index_of(text: &str, key: &str) -> int {
        let mut at: int = -1;
        let mut from: int = 0;
        loop {
            let p = DomText::index_of_from(text, key, from);
            if p < 0 {
                return at;
            }
            at = p;
            from = p + 1;
        }
    }
}
