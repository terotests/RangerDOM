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
        if let Some(p) = text.find(key) {
            return p as int;
        }
        -1
    }

    /// byte index of the first `key` at or after `from`, -1 when none
    pub fn index_of_from(text: &str, key: &str, from: int) -> int {
        if from < 0 || from as usize > text.as_bytes().len() {
            return -1;
        }
        if let Some(p) = text[from as usize..].find(key) {
            return p as int + from;
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
