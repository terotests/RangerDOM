// SPDX-License-Identifier: MIT
//! JSON as a small tree: RangerDOM's page (the render tree, __render()) and
//! the host's REST and MCP bodies.
//!
//! Numbers keep the text they were written with (numText): JSON-RPC ids are
//! echoed back as sent, and millisecond times do not fit an int on every
//! target. Strings are copied in runs (substring), so UTF-8 bytes (C++) and
//! UTF-16 units (JavaScript) pass through untouched; only \u escapes are
//! decoded (utf8Of).

use ranger::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::rgr::JsonText;

#[derive(Clone)]
pub struct JsonValue {
    /// 0 null, 1 boolean, 2 number, 3 string, 4 array, 5 object
    pub kind: i64,
    pub b: bool,
    pub numText: String,
    pub str: String,
    pub items: Vec<Rc<RefCell<JsonValue>>>,
    pub keys: Vec<String>,
    /// who has seen this value: a number a reader (MfdDomView) gives it to
    /// know it again later; 0 until then. A patched page shares its
    /// unchanged nodes with the last one, so they keep theirs.
    pub stamp: i64,
}

impl JsonValue {
    pub fn new() -> Self {
        Self {
            kind: 0,
            b: false,
            numText: "0".to_string(),
            str: String::new(),
            items: Vec::new(),
            keys: Vec::new(),
            stamp: 0,
        }
    }
    pub fn mkNull() -> Rc<RefCell<JsonValue>> {
        Rc::new(RefCell::new(JsonValue::new()))
    }
    pub fn mkBool(v: bool) -> Rc<RefCell<JsonValue>> {
        let j: Rc<RefCell<JsonValue>> = Rc::new(RefCell::new(JsonValue::new()));
        j.borrow_mut().kind = 1;
        j.borrow_mut().b = v;
        j
    }
    pub fn mkInt(v: i64) -> Rc<RefCell<JsonValue>> {
        let j: Rc<RefCell<JsonValue>> = Rc::new(RefCell::new(JsonValue::new()));
        j.borrow_mut().kind = 2;
        j.borrow_mut().numText = v.to_string();
        j
    }
    /// a number already written out ("1792688088000")
    pub fn mkNum(text: String) -> Rc<RefCell<JsonValue>> {
        let j: Rc<RefCell<JsonValue>> = Rc::new(RefCell::new(JsonValue::new()));
        j.borrow_mut().kind = 2;
        j.borrow_mut().numText = text.clone();
        j
    }
    pub fn mkStr(v: String) -> Rc<RefCell<JsonValue>> {
        let j: Rc<RefCell<JsonValue>> = Rc::new(RefCell::new(JsonValue::new()));
        j.borrow_mut().kind = 3;
        j.borrow_mut().str = v.clone();
        j
    }
    pub fn mkArr() -> Rc<RefCell<JsonValue>> {
        let j: Rc<RefCell<JsonValue>> = Rc::new(RefCell::new(JsonValue::new()));
        j.borrow_mut().kind = 4;
        j
    }
    pub fn mkObj() -> Rc<RefCell<JsonValue>> {
        let j: Rc<RefCell<JsonValue>> = Rc::new(RefCell::new(JsonValue::new()));
        j.borrow_mut().kind = 5;
        j
    }
    /// ---------------------------------------------------------------------
    /// Writing
    /// ---------------------------------------------------------------------
    pub fn hex4(code: i64) -> String {
        let digits: String = "0123456789abcdef".to_string();
        let mut out: String = String::new();
        let mut v: i64 = code;
        let mut k: i64 = 0;
        while k < 4 {
            let d: i64 = v % 16;
            out = format!("{}{}", JsonText::substr(&digits, d, d + 1), out);
            v = v / 16;
            k += 1;
        }
        out
    }
    pub fn quote(s: &str) -> String {
        let mut out: String = "\"".to_string();
        let len: i64 = JsonText::str_len(&s);
        let mut start: i64 = 0;
        let mut i: i64 = 0;
        while i < len {
            let c: i64 = JsonText::char_at(&s, i);
            if (c == 34 || c == 92) || c >= 0 && c < 32 {
                out = format!("{}{}", out, JsonText::substr(&s, start, i));
                if c == 34 {
                    out = format!("{}\\\"", out);
                } else {
                    if c == 92 {
                        out = format!("{}\\\\", out);
                    } else {
                        if c == 10 {
                            out = format!("{}\\n", out);
                        } else {
                            if c == 13 {
                                out = format!("{}\\r", out);
                            } else {
                                if c == 9 {
                                    out = format!("{}\\t", out);
                                } else {
                                    out = format!("{}\\u{}", out, JsonValue::hex4(c));
                                }
                            }
                        }
                    }
                }
                start = i + 1;
            }
            i += 1;
        }
        out = format!("{}{}\"", out, JsonText::substr(&s, start, len));
        out
    }
    pub fn isNull(&self) -> bool {
        self.kind == 0
    }
    /// object: set (replace) a member
    pub fn put(&mut self, key: &str, value: Rc<RefCell<JsonValue>>) {
        let at: i64 = self.keyAt(key);
        if at >= 0 {
            self.items[at as usize] = value;
            return;
        }
        self.keys.push(key.to_string());
        self.items.push(value);
    }
    pub fn putStr(&mut self, key: &str, value: &str) {
        self.put(key, JsonValue::mkStr(value.to_string()));
    }
    pub fn putInt(&mut self, key: &str, value: i64) {
        self.put(key, JsonValue::mkInt(value));
    }
    pub fn putBool(&mut self, key: &str, value: bool) {
        self.put(key, JsonValue::mkBool(value));
    }
    /// array: append
    pub fn add(&mut self, value: Rc<RefCell<JsonValue>>) {
        self.items.push(value);
    }
    /// where an object's member is in keys, -1 when it has none (no key
    /// is copied to be compared: a page's styles are read a hundred times
    /// per element)
    pub fn keyAt(&self, key: &str) -> i64 {
        let n: i64 = self.keys.len() as i64;
        let mut i: i64 = 0;
        while i < n {
            if self.keys[i as usize] == key {
                return i;
            }
            i += 1;
        }
        -1
    }
    pub fn has(&self, key: &str) -> bool {
        self.keyAt(key) >= 0
    }
    /// object member, or a null value
    pub fn get(&self, key: &str) -> Rc<RefCell<JsonValue>> {
        if self.kind == 5 {
            let at: i64 = self.keyAt(key);
            if at >= 0 {
                return self.items[at as usize].clone();
            }
        }
        Rc::new(RefCell::new(JsonValue::new()))
    }
    pub fn item(&self, index: i64) -> Rc<RefCell<JsonValue>> {
        if index >= 0 && index < (self.items.len() as i64) {
            return self.items[index as usize].clone();
        }
        Rc::new(RefCell::new(JsonValue::new()))
    }
    pub fn count(&self) -> i64 {
        self.items.len() as i64
    }
    /// the text of a string, a number's text, "true"/"false", else ""
    pub fn text(&self) -> String {
        if self.kind == 3 {
            return self.str.clone();
        }
        if self.kind == 2 {
            return self.numText.clone();
        }
        if self.kind == 1 {
            if self.b {
                return "true".to_string();
            }
            return "false".to_string();
        }
        String::new()
    }
    pub fn getText(&self, key: &str) -> String {
        // (a missing member: no null value made for it, as get makes)
        if self.kind == 5 {
            let at: i64 = self.keyAt(key);
            if at >= 0 {
                return self.items[at as usize].borrow().text();
            }
        }
        String::new()
    }
    pub fn getInt(&self, key: &str, fallback: i64) -> i64 {
        let v: Rc<RefCell<JsonValue>> = self.get(key);
        if v.borrow().kind == 2 || v.borrow().kind == 3 {
            let n: Option<i64> = v.borrow().text().trim().to_string().parse::<i64>().ok();
            if n.is_some() {
                return n.unwrap();
            }
        }
        fallback
    }
    pub fn getBool(&self, key: &str, fallback: bool) -> bool {
        let v: Rc<RefCell<JsonValue>> = self.get(key);
        if v.borrow().kind == 1 {
            return v.borrow().b;
        }
        fallback
    }
    pub fn toJson(&self) -> String {
        if self.kind == 1 {
            if self.b {
                return "true".to_string();
            }
            return "false".to_string();
        }
        if self.kind == 2 {
            return self.numText.clone();
        }
        if self.kind == 3 {
            return JsonValue::quote(&self.str.clone());
        }
        if self.kind == 4 {
            let mut parts: Vec<String> = Vec::new();
            let __it_v = self.items.clone();
            for v in __it_v.iter().cloned() {
                parts.push(v.borrow().toJson());
            }
            return format!("[{}]", parts.join(&*",".to_string()));
        }
        if self.kind == 5 {
            let mut parts2: Vec<String> = Vec::new();
            let __n_i2 = self.items.len() as i64;
            for i2 in 0..__n_i2 {
                let v2 = self.items[i2 as usize].clone();
                parts2.push(format!("{}:{}", JsonValue::quote(&self.keys[i2 as usize].clone()), v2.borrow().toJson()));
            }
            return format!("{}{}{}", "{".to_string(), parts2.join(&*",".to_string()), "}".to_string());
        }
        "null".to_string()
    }
}

/// the objects under a key (a render tree's "s", its nodes' computed
/// styles) a reader has parsed, by their text: the same text again is the
/// same object, not parsed again. A page's boxes share a few styles (a
/// game's 266 boxes, 30 styles), and a delta sends them again each frame.
#[derive(Clone)]
pub struct JsonMemo {
    pub key: String,
    pub map: HashMap<String, Rc<RefCell<JsonValue>>>,
    pub hits: i64,
    pub misses: i64,
}

impl JsonMemo {
    pub fn new(key: &str) -> Self {
        Self {
            key: key.to_string(),
            map: HashMap::new(),
            hits: 0,
            misses: 0,
        }
    }
    pub fn clear(&mut self) {
        self.map = HashMap::new();
    }
}

#[derive(Clone)]
pub struct JsonParser {
    pub text: String,
    pub pos: i64,
    pub len: i64,
    pub ok: bool,
    pub error: String,
    pub memo: Option<Rc<RefCell<JsonMemo>>>,
}

impl JsonParser {
    pub fn new() -> Self {
        Self {
            text: String::new(),
            pos: 0,
            len: 0,
            ok: true,
            error: String::new(),
            memo: None,
        }
    }
    /// the value, or null with ok false
    pub fn parse(text: String) -> Rc<RefCell<JsonParser>> {
        let p: Rc<RefCell<JsonParser>> = Rc::new(RefCell::new(JsonParser::new()));
        p.borrow_mut().text = text.clone();
        p.borrow_mut().len = JsonText::str_len(&text);
        p
    }
    pub fn utf8Of(cp: i64) -> String {
        let mut b: Vec<u8> = Vec::new();
        if cp < 128 {
            b.push(cp as u8);
        } else {
            if cp < 2048 {
                b.push((192 + (cp / 64)) as u8);
                b.push((128 + cp % 64) as u8);
            } else {
                if cp < 65536 {
                    b.push((224 + (cp / 4096)) as u8);
                    b.push((128 + (cp / 64) % 64) as u8);
                    b.push((128 + cp % 64) as u8);
                } else {
                    b.push((240 + (cp / 262144)) as u8);
                    b.push((128 + (cp / 4096) % 64) as u8);
                    b.push((128 + (cp / 64) % 64) as u8);
                    b.push((128 + cp % 64) as u8);
                }
            }
        }
        String::from_utf8_lossy(&b).to_string()
    }
    pub fn value(&mut self) -> Rc<RefCell<JsonValue>> {
        self.ws();
        let v: Rc<RefCell<JsonValue>> = self.readValue();
        self.ws();
        if self.ok && self.pos < self.len {
            self.fail("text after the value");
        }
        v
    }
    pub fn fail(&mut self, why: &str) -> Rc<RefCell<JsonValue>> {
        if self.ok {
            self.ok = false;
            self.error = format!("{} at {}", why, self.pos);
        }
        Rc::new(RefCell::new(JsonValue::new()))
    }
    pub fn peek(&self) -> i64 {
        if self.pos < self.len {
            return JsonText::char_at(&self.text, self.pos);
        }
        -1
    }
    pub fn ws(&mut self) {
        let mut go: bool = true;
        while go {
            let c: i64 = self.peek();
            if ((c == 32 || c == 9) || c == 10) || c == 13 {
                self.pos += 1;
            } else {
                go = false;
            }
        }
    }
    pub fn word(&mut self, w: &str) -> bool {
        let n: i64 = JsonText::str_len(&w);
        if self.pos + n <= self.len {
            if JsonText::substr(&self.text, self.pos, self.pos + n) == w {
                self.pos += n;
                return true;
            }
        }
        false
    }
    pub fn readValue(&mut self) -> Rc<RefCell<JsonValue>> {
        if !self.ok {
            return Rc::new(RefCell::new(JsonValue::new()));
        }
        let c: i64 = self.peek();
        if c == 123 {
            return self.readObject();
        }
        if c == 91 {
            return self.readArray();
        }
        if c == 34 {
            return JsonValue::mkStr(self.readString());
        }
        if self.word("true") {
            return JsonValue::mkBool(true);
        }
        if self.word("false") {
            return JsonValue::mkBool(false);
        }
        if self.word("null") {
            return Rc::new(RefCell::new(JsonValue::new()));
        }
        if c == 45 || (c >= 48 && c <= 57) {
            let start: i64 = self.pos;
            let mut go: bool = true;
            while go {
                let d: i64 = self.peek();
                if (((d >= 48 && d <= 57) || d == 45) || d == 43) || ((d == 46 || d == 101) || d == 69) {
                    self.pos += 1;
                } else {
                    go = false;
                }
            }
            return JsonValue::mkNum(JsonText::substr(&self.text, start, self.pos));
        }
        self.fail("unexpected character")
    }
    pub fn readObject(&mut self) -> Rc<RefCell<JsonValue>> {
        let o: Rc<RefCell<JsonValue>> = JsonValue::mkObj();
        self.pos += 1;
        self.ws();
        if self.peek() == 125 {
            self.pos += 1;
            return o;
        }
        let mut go: bool = true;
        while go && self.ok {
            self.ws();
            if self.peek() != 34 {
                return self.fail("expected a key");
            }
            let key: String = self.readString();
            self.ws();
            if self.peek() != 58 {
                return self.fail("expected :");
            }
            self.pos += 1;
            self.ws();
            let mut v: Rc<RefCell<JsonValue>> = Rc::new(RefCell::new(JsonValue::new()));
            if self.memo.is_some() && self.peek() == 123 && key == self.memo.as_ref().unwrap().borrow().key {
                v = self.readMemo();
            } else {
                v = self.readValue();
            }
            o.borrow_mut().put(&key, v.clone());
            self.ws();
            let c: i64 = self.peek();
            if c == 44 {
                self.pos += 1;
            } else {
                if c == 125 {
                    self.pos += 1;
                    go = false;
                } else {
                    return self.fail("expected , or }");
                }
            }
        }
        o
    }
    /// an object at pos from the memo by its text, or parsed and kept there
    fn readMemo(&mut self) -> Rc<RefCell<JsonValue>> {
        let start: i64 = self.pos;
        let end: i64 = self.objectEnd(start);
        if end < 0 {
            return self.readValue();
        }
        let raw: String = JsonText::substr(&self.text, start, end);
        let memo: Rc<RefCell<JsonMemo>> = Rc::clone(self.memo.as_ref().unwrap());
        let hit: Option<Rc<RefCell<JsonValue>>> = memo.borrow().map.get(&raw).cloned();
        if hit.is_some() {
            self.pos = end;
            memo.borrow_mut().hits += 1;
            return hit.unwrap();
        }
        let v: Rc<RefCell<JsonValue>> = self.readValue();
        if self.ok && self.pos == end {
            if (memo.borrow().map.len() as i64) >= 8192 {
                memo.borrow_mut().clear();
            }
            memo.borrow_mut().map.insert(raw, Rc::clone(&v));
            memo.borrow_mut().misses += 1;
        }
        v
    }
    /// where the object starting at start ends (after its closing brace),
    /// -1 when it does not
    fn objectEnd(&self, start: i64) -> i64 {
        let mut depth: i64 = 0;
        let mut i: i64 = start;
        let mut inStr: bool = false;
        while i < self.len {
            let c: i64 = JsonText::char_at(&self.text, i);
            if inStr {
                if c == 92 {
                    i += 1;
                } else {
                    if c == 34 {
                        inStr = false;
                    }
                }
            } else {
                if c == 34 {
                    inStr = true;
                }
                if c == 123 || c == 91 {
                    depth += 1;
                }
                if c == 125 || c == 93 {
                    depth -= 1;
                    if depth == 0 {
                        return i + 1;
                    }
                }
            }
            i += 1;
        }
        -1
    }
    pub fn readArray(&mut self) -> Rc<RefCell<JsonValue>> {
        let a: Rc<RefCell<JsonValue>> = JsonValue::mkArr();
        self.pos += 1;
        self.ws();
        if self.peek() == 93 {
            self.pos += 1;
            return a;
        }
        let mut go: bool = true;
        while go && self.ok {
            self.ws();
            a.borrow_mut().add(self.readValue());
            self.ws();
            let c: i64 = self.peek();
            if c == 44 {
                self.pos += 1;
            } else {
                if c == 93 {
                    self.pos += 1;
                    go = false;
                } else {
                    return self.fail("expected , or ]");
                }
            }
        }
        a
    }
    pub fn hexValue(&self, at: i64) -> i64 {
        let mut v: i64 = 0;
        let mut k: i64 = 0;
        while k < 4 {
            let c: i64 = JsonText::char_at(&self.text, at + k);
            let mut d: i64 = -1;
            if (c >= 48 && c <= 57) {
                d = c - 48;
            }
            if (c >= 97 && c <= 102) {
                d = c - 87;
            }
            if (c >= 65 && c <= 70) {
                d = c - 55;
            }
            if d < 0 {
                return -1;
            }
            v = v * 16 + d;
            k += 1;
        }
        v
    }
    pub fn readString(&mut self) -> String {
        // at the opening quote
        self.pos += 1;
        // the pieces between escapes, joined once at the end: adding each to
        // one growing string copied it per escape (quadratic for a long
        // string with many, as a dashboard's SVG markup with its quotes)
        let mut parts: Vec<String> = Vec::new();
        let mut start: i64 = self.pos;
        while self.pos < self.len {
            let c: i64 = JsonText::char_at(&self.text, self.pos);
            if c == 34 {
                self.pos += 1;
                if parts.is_empty() {
                    return JsonText::substr(&self.text, start, self.pos - 1);
                }
                parts.push(JsonText::substr(&self.text, start, self.pos - 1));
                return parts.join(&*String::new());
            }
            if c == 92 {
                parts.push(JsonText::substr(&self.text, start, self.pos));
                let e: i64 = JsonText::char_at(&self.text, self.pos + 1);
                self.pos += 2;
                if e == 110 {
                    parts.push("\n".to_string().to_string());
                }
                if e == 116 {
                    parts.push("\t".to_string().to_string());
                }
                if e == 114 {
                    parts.push("\r".to_string().to_string());
                }
                if e == 98 {
                    parts.push(char::from_u32(8 as u32).unwrap_or('\0').to_string());
                }
                if e == 102 {
                    parts.push(char::from_u32(12 as u32).unwrap_or('\0').to_string());
                }
                if e == 34 {
                    parts.push("\"".to_string().to_string());
                }
                if e == 92 {
                    parts.push("\\".to_string().to_string());
                }
                if e == 47 {
                    parts.push("/".to_string().to_string());
                }
                if e == 117 {
                    let mut cp: i64 = self.hexValue(self.pos.clone());
                    if cp < 0 {
                        self.fail("bad \\u escape");
                        return parts.join(&*String::new());
                    }
                    self.pos += 4;
                    // a surrogate pair
                    if ((cp >= 55296 && cp <= 56319)) && self.pos + 6 <= self.len {
                        if JsonText::char_at(&self.text, self.pos) == 92 && JsonText::char_at(&self.text, self.pos + 1) == 117 {
                            let lo: i64 = self.hexValue(self.pos + 2);
                            if (lo >= 56320 && lo <= 57343) {
                                cp = (65536 + (cp - 55296) * 1024) + (lo - 56320);
                                self.pos += 6;
                            }
                        }
                    }
                    parts.push(JsonParser::utf8Of(cp));
                }
                start = self.pos;
            } else {
                self.pos += 1;
            }
        }
        self.fail("unterminated string");
        parts.join(&*String::new())
    }
}
