// SPDX-License-Identifier: MIT
//! DomStyle -- the page's elements as selectors see them, and which of the
//! page's rules match one, for webapi.js's cascade (cascade1).
//!
//! webapi.js describes the elements whose style it asks for (and their
//! ancestors), again when that changed, with the rules of the page's
//! sheets; records joined by U+0000, fields by U+0001:
//!
//!   P                      answered "rsx1": a host that has DomStyle
//!   R  xhtml session       start again: no elements, no rules (xhtml "1":
//!                          attribute values match case-sensitively); the
//!                          questions that follow carry `session`
//!   N  id parent ns tag pE pEE pT pTE [name value]…
//!                          an element: its parent (0 the document, -1
//!                          none), its places among its parent's element
//!                          children (from the start and the end, of all
//!                          and of its type; 0 when no selector reads
//!                          them), its attributes (a value no selector
//!                          reads is sent empty); ns "" is HTML's
//!   S  n json              a selector as webapi.js parsed it, by its
//!                          number n (kept until R)
//!   L  n json              a rule set by its number n, in use from now
//!                          (see webapi.js rsxRules): {"w": [selector n...],
//!                          "f": [flags...], "idx": {key: [w...]},
//!                          "pidx": {pseudo: {key: [w...]}}}; 64 are kept
//!   U  n                   rule set n again (one let go of: the next Q is
//!                          answered "!")
//!   E  old new             a new session number: the page tells each
//!                          element again, the rule sets and selectors stay
//!   F  i,f,i,f…            flags changed (a media query answered anew)
//!   Q  id pe session       which rules match element id (or its ::pe);
//!                          "!" when `session` is not R's (a new host)
//!   T                      what it did: {"queries", "elements", "rules",
//!                          "sets"}
//!
//! A request with Q gets "h,h,…|c,c,…": the rules (by their place in "w")
//! that match, and the ones it leaves to webapi.js (state the page holds,
//! as :hover or :checked, :has(), a sibling combinator), which it then
//! matches itself. "?" when it was not told of the element.
//!
//! The rules come as webapi.js parsed them (parseComplex), so both match
//! the same selectors; the index (key to rules) is webapi.js's too.

use ranger::cell::RefCell;
use rangerdom_json::{JsonParser, JsonValue};
use std::collections::HashMap;
use std::rc::Rc;

// item kinds of a compound
const K_TAG: i64 = 1;
const K_ID: i64 = 2;
const K_CLASS: i64 = 3;
const K_ATTR: i64 = 4;
const K_PSEUDO: i64 = 5;
const K_PSEUDOEL: i64 = 6;

// pseudo-classes DomStyle answers
const P_NOT: i64 = 1;
const P_IS: i64 = 2;
const P_ROOT: i64 = 3;
const P_FIRST: i64 = 4;
const P_LAST: i64 = 5;
const P_ONLY: i64 = 6;
const P_FIRST_T: i64 = 7;
const P_LAST_T: i64 = 8;
const P_ONLY_T: i64 = 9;
const P_NTH: i64 = 10;
const P_NTH_LAST: i64 = 11;
const P_NTH_T: i64 = 12;
const P_NTH_LAST_T: i64 = 13;
const P_LINK: i64 = 14;
const P_FALSE: i64 = 15;
const P_TRUE: i64 = 16;
const P_REQUIRED: i64 = 17;
const P_OPTIONAL: i64 = 18;
const P_OPEN: i64 = 19;
const P_DIR: i64 = 20;
// one webapi.js answers itself
const P_JS: i64 = 99;

/// elements kept before DomStyle lets go of them all
const MAX_ELEMENTS: usize = 200000;

pub struct Item {
    pub kind: i64,
    /// tag (lower case), id, class, attribute value, a pseudo-class's arg
    pub v: String,
    /// the tag as written
    pub raw: String,
    /// an attribute's name (lower case)
    pub n: String,
    pub op: String,
    pub hasV: bool,
    /// [i]: in any case
    pub ci: bool,
    /// an attribute HTML matches in any ASCII case
    pub hci: bool,
    pub pc: i64,
    pub a: i64,
    pub b: i64,
    pub list: Vec<Sel>,
}

pub struct Part {
    pub items: Vec<Item>,
    /// how this compound relates to the next one (its left): ' ', '>',
    /// '+', '~'; "" for the last
    pub comb: String,
}

pub struct Sel {
    pub parts: Vec<Part>,
    /// webapi.js matches it (a pseudo-class not answered here)
    pub js: bool,
    /// the ancestor filter's bits of the names its ancestors must have
    /// (webapi.js needOf)
    pub need: Vec<i64>,
}

pub struct El {
    pub tag: String,
    pub lower: String,
    pub html: bool,
    pub names: Vec<String>,
    pub values: Vec<String>,
    pub classes: Vec<String>,
    pub parent: i64,
    /// places among the parent's element children (1 from the start or
    /// the end, of all and of the same type)
    pub pE: i64,
    pub pEE: i64,
    pub pT: i64,
    pub pTE: i64,
    /// the ancestor filter, good while ancGen is DomStyle's gen
    pub anc: Vec<i64>,
    pub ancGen: i64,
    /// told of (a slot made for a parent not told of yet is not)
    pub known: bool,
    /// the parent's slot (0 none)
    pub pslot: usize,
    /// its own names' bits in the ancestor filter (type, id, classes)
    pub bits: Vec<i64>,
}

impl El {
    fn new(tag: &str, html: bool, parent: i64) -> El {
        El {
            tag: tag.to_string(),
            lower: tag.to_lowercase(),
            html,
            names: Vec::new(),
            values: Vec::new(),
            classes: Vec::new(),
            parent,
            pE: 0,
            pEE: 0,
            pT: 0,
            pTE: 0,
            anc: vec![0, 0, 0, 0],
            ancGen: 0,
            known: false,
            pslot: 0,
            bits: vec![0, 0, 0, 0],
        }
    }
    /// webapi.js attrOf: by the exact name
    fn attr(&self, name: &str) -> Option<&String> {
        let mut i = 0;
        while i < self.names.len() {
            if self.names[i] == name {
                return Some(&self.values[i]);
            }
            i += 1;
        }
        None
    }
    /// webapi.js attrValue: a selector's name (lower case), an element not
    /// HTML's by any case
    fn attrSel(&self, name: &str) -> Option<&String> {
        if self.html {
            return self.attr(name);
        }
        let mut i = 0;
        while i < self.names.len() {
            if self.names[i].to_lowercase() == name {
                return Some(&self.values[i]);
            }
            i += 1;
        }
        None
    }
    fn setClasses(&mut self) {
        self.classes.clear();
        let v = match self.attr("class") {
            Some(s) => s.clone(),
            None => String::new(),
        };
        // (classSet: split at ASCII white space, each name once)
        let mut cur = String::new();
        for ch in v.chars() {
            if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\u{c}' || ch == '\r' {
                self.addClass(&cur);
                cur = String::new();
            } else {
                cur.push(ch);
            }
        }
        self.addClass(&cur);
    }
    fn addClass(&mut self, c: &str) {
        if c.is_empty() {
            return;
        }
        for x in self.classes.iter() {
            if x == c {
                return;
            }
        }
        self.classes.push(c.to_string());
    }
}

/// a rule set webapi.js sent before (L), kept for when it is used again (U)
pub struct RuleSet {
    pub rules: Vec<Rc<Sel>>,
    /// per rule: 1 it applies (its media query, its sheet's pseudo-elements),
    /// 2 it is under more than one key
    pub flags: Vec<i64>,
    pub idx: HashMap<String, Vec<usize>>,
    pub pidx: HashMap<String, HashMap<String, Vec<usize>>>,
}

pub struct DomStyle {
    /// the elements by slot (0 none), and webapi.js's number for each
    pub els: Vec<El>,
    pub slot: HashMap<i64, usize>,
    pub xhtml: bool,
    /// the selectors webapi.js sent (S), by its number for them
    pub sels: HashMap<i64, Rc<Sel>>,
    /// told something since: every ancestor filter is made again
    pub gen: i64,
    /// the rule set in use (webapi.js's number cur), and all it sent
    pub rs: Rc<RefCell<RuleSet>>,
    pub hasRules: bool,
    cur: i64,
    sets: HashMap<i64, Rc<RefCell<RuleSet>>>,
    /// a rule under several keys taken once per element
    stamp: i64,
    stamps: Vec<i64>,
    pub queries: i64,
    /// the page's number for what it told this host (R): a question with
    /// another one is answered "!", and the page starts again
    pub session: i64,
}

impl Default for DomStyle {
    fn default() -> Self {
        DomStyle::new()
    }
}

impl RuleSet {
    pub fn new() -> RuleSet {
        RuleSet { rules: Vec::new(), flags: Vec::new(), idx: HashMap::new(), pidx: HashMap::new() }
    }
}

impl DomStyle {
    pub fn new() -> DomStyle {
        let mut s = DomStyle {
            els: Vec::new(),
            slot: HashMap::new(),
            xhtml: false,
            sels: HashMap::new(),
            gen: 1,
            rs: Rc::new(RefCell::new(RuleSet::new())),
            hasRules: false,
            cur: -1,
            sets: HashMap::new(),
            stamp: 0,
            stamps: Vec::new(),
            queries: 0,
            session: -1,
        };
        s.reset();
        s
    }

    /// Whether a __hostSync request is DomStyle's (U+0001 'S').
    pub fn mine(request: &str) -> bool {
        request.starts_with("\u{1}S")
    }

    fn reset(&mut self) {
        self.els = Vec::new();
        self.els.push(El::new("", true, -1));
        self.slot = HashMap::new();
        self.sels = HashMap::new();
        self.sets = HashMap::new();
        self.cur = -1;
        self.rs = Rc::new(RefCell::new(RuleSet::new()));
        self.hasRules = false;
        self.gen += 1;
    }

    /// A request (DomStyle::mine) and its answer.
    pub fn call(&mut self, request: &str) -> String {
        self.call1(request)
    }

    fn call1(&mut self, request: &str) -> String {
        let body = if request.len() >= 2 { &request[2..] } else { "" };
        let mut out = String::new();
        for rec in body.split('\u{0}') {
            if rec.is_empty() {
                continue;
            }
            let f: Vec<&str> = rec.split('\u{1}').collect();
            match f[0] {
                "R" => {
                    self.reset();
                    self.xhtml = f.len() > 1 && f[1] == "1";
                    self.session = if f.len() > 2 { num(f[2]) } else { 0 };
                }
                "E" => {
                    // (a new number for what the page tells: it tells each
                    // element again, this host keeps what it has)
                    if f.len() > 2 && num(f[1]) == self.session {
                        self.session = num(f[2]);
                    }
                }
                "P" => {
                    out = "rsx1".to_string();
                }
                "T" => {
                    out = format!("{{\"queries\":{},\"elements\":{},\"rules\":{},\"sets\":{}}}", self.queries, self.slot.len(), self.rs.borrow().rules.len(), self.sets.len());
                }
                "N" => {
                    if f.len() >= 9 {
                        self.describe(&f);
                    }
                }
                "S" => {
                    if f.len() >= 3 {
                        let p = JsonParser::parse(f[2].to_string());
                        let v = p.borrow_mut().value();
                        if p.borrow().ok {
                            self.sels.insert(num(f[1]), Rc::new(selOf(&v)));
                        }
                    }
                }
                "U" => {
                    // (a rule set sent before; one let go of: the page is
                    // asked to send it all again)
                    if f.len() >= 2 {
                        let n = num(f[1]);
                        if self.sets.contains_key(&n) {
                            self.rs = self.sets.get(&n).unwrap().clone();
                            self.cur = n;
                            self.hasRules = true;
                        } else {
                            self.session = -1;
                        }
                    }
                }
                "L" => {
                    if f.len() >= 3 {
                        let n = num(f[1]);
                        self.setRules(n, f[2]);
                    }
                }
                "F" => {
                    if f.len() >= 2 {
                        let v: Vec<&str> = f[1].split(',').collect();
                        let mut i = 0;
                        while i + 1 < v.len() {
                            let k = num(v[i]) as usize;
                            if k < self.rs.borrow().flags.len() {
                                self.rs.borrow_mut().flags[k] = num(v[i + 1]);
                            }
                            i += 2;
                        }
                    }
                }
                "Q" => {
                    // (a page this host was not told about: one restored
                    // from a snapshot sends it all again)
                    if f.len() > 3 && num(f[3]) != self.session {
                        out = "!".to_string();
                    } else {
                        out = self.query(num(f[1]), if f.len() > 2 { f[2] } else { "" });
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// the slot of webapi.js's element id (made when not there yet)
    fn slotOf(&mut self, id: i64) -> usize {
        if let Some(&k) = self.slot.get(&id) {
            return k;
        }
        let k = self.els.len();
        self.els.push(El::new("", true, -1));
        self.slot.insert(id, k);
        k
    }

    fn describe(&mut self, f: &Vec<&str>) {
        // (a page that made and styled many elements: let go of all, and
        // the page tells again what it asks about)
        if self.slot.len() >= MAX_ELEMENTS {
            self.reset();
            self.session = -1;
        }
        let id = num(f[1]);
        let parent = num(f[2]);
        let k = self.slotOf(id);
        let pslot = if parent > 0 { self.slotOf(parent) } else { 0 };
        let mut e = El::new(f[4], f[3].is_empty(), parent);
        e.pE = num(f[5]);
        e.pEE = num(f[6]);
        e.pT = num(f[7]);
        e.pTE = num(f[8]);
        let mut i = 9;
        while i + 1 < f.len() {
            e.names.push(f[i].to_string());
            e.values.push(f[i + 1].to_string());
            i += 2;
        }
        e.setClasses();
        e.known = true;
        e.pslot = pslot;
        let mut b = vec![0, 0, 0, 0];
        bloom(&mut b, "t:", &e.lower);
        if let Some(v) = e.attr("id") {
            if !v.is_empty() {
                bloom(&mut b, "i:", v);
            }
        }
        for c in e.classes.iter() {
            bloom(&mut b, "c:", c);
        }
        e.bits = b;
        // (one told of before changed: the filters below it made again;
        // a new one is no one's ancestor yet)
        if self.els[k].known {
            self.gen += 1;
        }
        self.els[k] = e;
    }

    fn setRules(&mut self, n: i64, json: &str) {
        self.hasRules = false;
        let p = JsonParser::parse(json.to_string());
        let v = p.borrow_mut().value();
        if !p.borrow().ok {
            return;
        }
        let mut set = RuleSet::new();
        let w = v.borrow().get("w");
        let count = w.borrow().count();
        let mut i = 0;
        while i < count {
            let k = JsonValue::intOf(&w.borrow().item(i), 0);
            if self.sels.contains_key(&k) {
                set.rules.push(self.sels.get(&k).unwrap().clone());
            } else {
                set.rules.push(Rc::new(Sel { parts: Vec::new(), js: true, need: vec![0, 0, 0, 0] }));
            }
            i += 1;
        }
        let f = v.borrow().get("f");
        let mut j = 0;
        while j < count {
            set.flags.push(JsonValue::intOf(&f.borrow().item(j), 0));
            j += 1;
        }
        set.idx = indexOf(&v.borrow().get("idx"));
        let pv = v.borrow().get("pidx");
        let keys = pv.borrow().keys.clone();
        for k in keys.iter() {
            let sub = indexOf(&pv.borrow().get(k));
            set.pidx.insert(k.clone(), sub);
        }
        // (at most 64 kept: the page sends again one let go of)
        if self.sets.len() >= 64 {
            self.sets = HashMap::new();
        }
        self.rs = Rc::new(RefCell::new(set));
        self.sets.insert(n, self.rs.clone());
        self.cur = n;
        self.hasRules = true;
    }

    // ---- matching

    fn query(&mut self, id: i64, pe: &str) -> String {
        self.queries += 1;
        let at = match self.slot.get(&id) {
            Some(&k) => k,
            None => 0,
        };
        if !self.hasRules || at == 0 || !self.els[at].known {
            return "?".to_string();
        }
        let rs = self.rs.clone();
        let set = rs.borrow();
        while self.stamps.len() < set.rules.len() {
            self.stamps.push(0);
        }
        let mut cand: Vec<usize> = Vec::new();
        self.stamp += 1;
        {
            let idx = if pe.is_empty() {
                &set.idx
            } else {
                if !set.pidx.contains_key(pe) {
                    return "|".to_string();
                }
                set.pidx.get(pe).unwrap()
            };
            let e = &self.els[at];
            let stamp = self.stamp;
            let flags = &set.flags;
            let stamps = &mut self.stamps;
            if let Some(v) = e.attr("id") {
                if !v.is_empty() {
                    takeKey(idx, &format!("#{}", v), flags, stamps, stamp, &mut cand);
                }
            }
            for c in e.classes.iter() {
                takeKey(idx, &format!(".{}", c), flags, stamps, stamp, &mut cand);
            }
            takeKey(idx, &e.tag, flags, stamps, stamp, &mut cand);
            if !e.html && e.tag != e.lower {
                takeKey(idx, &e.lower, flags, stamps, stamp, &mut cand);
            }
            takeKey(idx, "*", flags, stamps, stamp, &mut cand);
            if e.parent == 0 {
                takeKey(idx, ":root", flags, stamps, stamp, &mut cand);
            }
            for n in e.names.iter() {
                takeKey(idx, &format!("[{}", n.to_lowercase()), flags, stamps, stamp, &mut cand);
            }
        }
        let mut hits = String::new();
        let mut check = String::new();
        for &r in cand.iter() {
            if set.flags[r] & 1 == 0 {
                continue;
            }
            let sel = set.rules[r].clone();
            if sel.js {
                if !check.is_empty() {
                    check.push(',');
                }
                check.push_str(&r.to_string());
                continue;
            }
            if self.matchSel(at, &sel) {
                if !hits.is_empty() {
                    hits.push(',');
                }
                hits.push_str(&r.to_string());
            }
        }
        hits.push('|');
        hits.push_str(&check);
        hits
    }

    /// sel matches the element in slot at
    fn matchSel(&mut self, at: usize, sel: &Sel) -> bool {
        // (the names its ancestors must have, WebKit's and Blink's
        // ancestor filter: most rules end here)
        if sel.need[0] != 0 || sel.need[1] != 0 || sel.need[2] != 0 || sel.need[3] != 0 {
            self.ancestors(at);
            let a = &self.els[at].anc;
            let mut i = 0;
            while i < 4 {
                if a[i] & sel.need[i] != sel.need[i] {
                    return false;
                }
                i += 1;
            }
        }
        self.matchFrom(at, sel, 0)
    }

    /// the filter of the names (types, ids, classes) of at's ancestors,
    /// kept in its anc
    fn ancestors(&mut self, at: usize) {
        if self.els[at].ancGen == self.gen {
            return;
        }
        let p = self.els[at].pslot;
        let mut out = vec![0, 0, 0, 0];
        if p > 0 && self.els[p].known {
            self.ancestors(p);
            let mut i = 0;
            while i < 4 {
                out[i] = self.els[p].anc[i] | self.els[p].bits[i];
                i += 1;
            }
        }
        let gen = self.gen;
        let e = &mut self.els[at];
        e.anc = out;
        e.ancGen = gen;
    }

    fn matchFrom(&self, at: usize, sel: &Sel, k: usize) -> bool {
        // (an element it was not told of: no match; webapi.js describes
        // every ancestor before it asks)
        if at == 0 || !self.els[at].known {
            return false;
        }
        if !self.matchCompound(at, &sel.parts[k].items) {
            return false;
        }
        if k + 1 >= sel.parts.len() {
            return true;
        }
        let comb = sel.parts[k].comb.as_str();
        if comb == ">" {
            return self.matchFrom(self.els[at].pslot, sel, k + 1);
        }
        if comb == " " {
            let mut a = self.els[at].pslot;
            while a > 0 && self.els[a].known {
                if self.matchFrom(a, sel, k + 1) {
                    return true;
                }
                a = self.els[a].pslot;
            }
            return false;
        }
        false
    }

    fn matchCompound(&self, at: usize, items: &Vec<Item>) -> bool {
        for s in items.iter() {
            if s.kind == K_PSEUDO {
                if !self.matchPseudo(at, s) {
                    return false;
                }
                continue;
            }
            let e = &self.els[at];
            if s.kind == K_TAG {
                if e.html {
                    if e.tag != s.v {
                        return false;
                    }
                } else if e.tag != s.raw && e.lower != s.v {
                    return false;
                }
            } else if s.kind == K_ID {
                match e.attr("id") {
                    Some(v) => {
                        if *v != s.v {
                            return false;
                        }
                    }
                    None => return false,
                }
            } else if s.kind == K_CLASS {
                if !e.classes.iter().any(|c| *c == s.v) {
                    return false;
                }
            } else if s.kind == K_ATTR {
                let have0 = match e.attrSel(&s.n) {
                    Some(v) => v.clone(),
                    None => return false,
                };
                if s.op.is_empty() {
                    continue;
                }
                let ci = s.ci || (s.hci && e.html && !self.xhtml);
                let (want, have) = if ci { (s.v.to_lowercase(), have0.to_lowercase()) } else { (s.v.clone(), have0) };
                let op = s.op.as_str();
                if op == "=" && have != want {
                    return false;
                }
                if op == "~=" && (want.is_empty() || !spaced(&have).contains(&format!(" {} ", want))) {
                    return false;
                }
                if op == "|=" && have != want && !have.starts_with(&format!("{}-", want)) {
                    return false;
                }
                if op == "^=" && (want.is_empty() || !have.starts_with(&want)) {
                    return false;
                }
                if op == "$=" && (want.is_empty() || !have.ends_with(&want)) {
                    return false;
                }
                if op == "*=" && (want.is_empty() || !have.contains(&want)) {
                    return false;
                }
                if op == "!=" && have == want {
                    return false;
                }
            }
        }
        true
    }

    fn matchPseudo(&self, at: usize, s: &Item) -> bool {
        let pc = s.pc;
        if pc == P_NOT {
            for sel in s.list.iter() {
                if self.matchFrom(at, sel, 0) {
                    return false;
                }
            }
            return true;
        }
        if pc == P_IS {
            for sel in s.list.iter() {
                if self.matchFrom(at, sel, 0) {
                    return true;
                }
            }
            return false;
        }
        if pc == P_FALSE {
            return false;
        }
        if pc == P_TRUE {
            return true;
        }
        if pc == P_DIR {
            return s.v == "ltr";
        }
        let parent = self.els[at].parent;
        if pc == P_ROOT {
            return parent == 0;
        }
        if pc >= P_FIRST && pc <= P_NTH_LAST_T {
            return posTest(&self.els[at], pc, s.a, s.b);
        }
        let e = &self.els[at];
        if pc == P_LINK {
            return (e.tag == "a" || e.tag == "area") && e.attrSel("href").is_some();
        }
        if pc == P_REQUIRED || pc == P_OPTIONAL {
            if !(e.tag == "input" || e.tag == "select" || e.tag == "textarea") {
                return false;
            }
            let r = e.attrSel("required").is_some();
            return if pc == P_REQUIRED { r } else { !r };
        }
        if pc == P_OPEN {
            return e.attrSel("open").is_some();
        }
        false
    }
}

/// a place test (:first-child, :nth-child(an+b)...) on an element
fn posTest(e: &El, pc: i64, a: i64, b: i64) -> bool {
    match pc {
        P_FIRST => e.pE == 1,
        P_LAST => e.pEE == 1,
        P_ONLY => e.pE == 1 && e.pEE == 1,
        P_FIRST_T => e.pT == 1,
        P_LAST_T => e.pTE == 1,
        P_ONLY_T => e.pT == 1 && e.pTE == 1,
        P_NTH => nth(a, b, e.pE),
        P_NTH_LAST => nth(a, b, e.pEE),
        P_NTH_T => nth(a, b, e.pT),
        _ => nth(a, b, e.pTE),
    }
}

fn num(s: &str) -> i64 {
    s.parse::<i64>().unwrap_or(0)
}

/// webapi.js nthMatch
fn nth(a: i64, b: i64, pos: i64) -> bool {
    if a == 0 {
        return pos == b;
    }
    let d = pos - b;
    d % a == 0 && d / a >= 0
}

/// ' ' + the value with each run of white space one space + ' '
fn spaced(v: &str) -> String {
    let mut out = String::from(" ");
    let mut ws = false;
    for ch in v.chars() {
        if ch.is_whitespace() {
            if !ws {
                out.push(' ');
            }
            ws = true;
        } else {
            out.push(ch);
            ws = false;
        }
    }
    out.push(' ');
    out
}

fn indexOf(v: &Rc<RefCell<JsonValue>>) -> HashMap<String, Vec<usize>> {
    let mut out: HashMap<String, Vec<usize>> = HashMap::new();
    let keys = v.borrow().keys.clone();
    for k in keys.iter() {
        let l = v.borrow().get(k);
        let n = l.borrow().count();
        let mut list: Vec<usize> = Vec::new();
        let mut i = 0;
        while i < n {
            list.push(JsonValue::intOf(&l.borrow().item(i), 0) as usize);
            i += 1;
        }
        out.insert(k.clone(), list);
    }
    out
}

/// HTML attributes whose values match in any ASCII case (webapi.js
/// HTML_CI_ATTRS)
const HTML_CI: [&str; 46] = [
    "accept", "accept-charset", "align", "alink", "axis", "bgcolor", "charset", "checked", "clear", "codetype", "color", "compact", "declare", "defer", "dir", "direction", "disabled", "enctype", "face", "frame", "hreflang", "http-equiv", "lang", "language", "link", "media", "method", "multiple", "nohref", "noresize", "noshade", "nowrap", "readonly", "rel", "rev", "rules", "scope", "scrolling", "selected", "shape", "target", "text", "type", "valign", "valuetype", "vlink",
];

/// a selector as webapi.js parsed it ({parts: [{c: [item…], comb}…]})
fn selOf(v: &Rc<RefCell<JsonValue>>) -> Sel {
    let mut sel = Sel { parts: Vec::new(), js: false, need: vec![0, 0, 0, 0] };
    let parts = v.borrow().get("parts");
    let n = parts.borrow().count();
    if n == 0 {
        sel.js = true;
    }
    let mut i = 0;
    while i < n {
        let p = parts.borrow().item(i);
        let comb = p.borrow().getText("comb");
        // (a sibling combinator: webapi.js has the siblings)
        if i + 1 < n && (comb == "+" || comb == "~") {
            sel.js = true;
        }
        let c = p.borrow().get("c");
        let m = c.borrow().count();
        let mut items: Vec<Item> = Vec::new();
        let mut j = 0;
        while j < m {
            let it = itemOf(&c.borrow().item(j));
            if it.pc == P_JS || it.list.iter().any(|x| x.js) {
                sel.js = true;
            }
            items.push(it);
            j += 1;
        }
        sel.parts.push(Part { items, comb });
        i += 1;
    }
    let mut k = 1;
    while k < sel.parts.len() {
        let cb = sel.parts[k - 1].comb.clone();
        if cb == " " || cb == ">" {
            let mut need = sel.need.clone();
            for x in sel.parts[k].items.iter() {
                if x.kind == K_CLASS {
                    bloom(&mut need, "c:", &x.v);
                } else if x.kind == K_ID {
                    bloom(&mut need, "i:", &x.v);
                } else if x.kind == K_TAG && x.v != "*" {
                    bloom(&mut need, "t:", &x.v);
                }
            }
            sel.need = need;
        }
        k += 1;
    }
    sel
}

/// a name (with its kind: "t:", "i:", "c:") into an ancestor filter: two
/// bits of 120, 30 in each of its four numbers (the same on every target)
fn bloom(f: &mut Vec<i64>, kind: &str, name: &str) {
    let mut h: i64 = 5381;
    for b in kind.bytes() {
        h = (h * 33 + (b as i64)) % 1000003;
    }
    for b in name.bytes() {
        h = (h * 33 + (b as i64)) % 1000003;
    }
    let a = (h % 120) as usize;
    let c = ((h / 120) % 120) as usize;
    f[a / 30] |= 1 << (a % 30);
    f[c / 30] |= 1 << (c % 30);
}

/// a rule set's rules under key, each rule under several keys once
fn takeKey(idx: &HashMap<String, Vec<usize>>, key: &str, flags: &Vec<i64>, stamps: &mut Vec<i64>, stamp: i64, cand: &mut Vec<usize>) {
    if !idx.contains_key(key) {
        return;
    }
    for &r in idx.get(key).unwrap().iter() {
        if flags[r] & 2 != 0 {
            if stamps[r] == stamp {
                continue;
            }
            stamps[r] = stamp;
        }
        cand.push(r);
    }
}

fn itemOf(v: &Rc<RefCell<JsonValue>>) -> Item {
    let o = v.borrow();
    let t = o.getText("t");
    let mut it = Item {
        kind: 0,
        v: String::new(),
        raw: String::new(),
        n: String::new(),
        op: String::new(),
        hasV: false,
        ci: false,
        hci: false,
        pc: 0,
        a: 0,
        b: 0,
        list: Vec::new(),
    };
    if t == "tag" {
        it.kind = K_TAG;
        it.v = o.getText("v");
        it.raw = o.getText("raw");
    } else if t == "id" {
        it.kind = K_ID;
        it.v = o.getText("v");
    } else if t == "class" {
        it.kind = K_CLASS;
        it.v = o.getText("v");
    } else if t == "attr" {
        it.kind = K_ATTR;
        it.n = o.getText("n");
        it.op = o.getText("op");
        it.hasV = o.has("v");
        it.v = o.getText("v");
        it.ci = o.getBool("i", false);
        it.hci = HTML_CI.contains(&it.n.as_str());
    } else if t == "pseudoel" {
        it.kind = K_PSEUDOEL;
    } else if t == "pseudo" {
        it.kind = K_PSEUDO;
        let n = o.getText("n");
        it.v = o.getText("arg");
        it.a = o.getInt("a", 0);
        it.b = o.getInt("b", 0);
        let of = o.has("of");
        it.pc = match n.as_str() {
            "not" => P_NOT,
            "is" | "where" => P_IS,
            "root" => P_ROOT,
            "first-child" => P_FIRST,
            "last-child" => P_LAST,
            "only-child" => P_ONLY,
            "first-of-type" => P_FIRST_T,
            "last-of-type" => P_LAST_T,
            "only-of-type" => P_ONLY_T,
            "nth-child" => {
                if of {
                    P_JS
                } else {
                    P_NTH
                }
            }
            "nth-last-child" => {
                if of {
                    P_JS
                } else {
                    P_NTH_LAST
                }
            }
            "nth-of-type" => P_NTH_T,
            "nth-last-of-type" => P_NTH_LAST_T,
            "link" | "any-link" => P_LINK,
            "visited" | "target" | "user-invalid" | "user-valid" | "fullscreen" | "autofill" | "-webkit-autofill" => P_FALSE,
            "defined" => P_TRUE,
            "required" => P_REQUIRED,
            "optional" => P_OPTIONAL,
            "open" => P_OPEN,
            "dir" => P_DIR,
            // what webapi.js answers from state it holds, and :has()
            "has" | "scope" | "empty" | "checked" | "indeterminate" | "disabled" | "enabled" | "read-only" | "read-write" | "placeholder-shown" | "focus" | "focus-visible" | "focus-within" | "hover" | "active" | "valid" | "invalid" | "in-range" | "out-of-range" | "lang" | "modal" | "popover-open" | "state" | "host" | "host-context" => P_JS,
            // the ones webapi.js's matchPseudo answers false for
            _ => P_FALSE,
        };
        if it.pc == P_NOT || it.pc == P_IS {
            let l = o.get("list");
            let k = l.borrow().count();
            let mut i = 0;
            while i < k {
                it.list.push(selOf(&l.borrow().item(i)));
                i += 1;
            }
        }
    }
    it
}
