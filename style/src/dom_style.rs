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

use crate::dom_tree::{is_nan, parse_float, parse_int, Cs, Ctx, DomTree};
use ranger::cell::RefCell;
use rangerdom_json::{JsonNodes, JsonParser, JsonValue};
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
// the states webapi.js tells (W)
const P_FOCUS: i64 = 21;
const P_FOCUS_VISIBLE: i64 = 22;
const P_FOCUS_WITHIN: i64 = 23;
const P_HOVER: i64 = 24;
const P_ACTIVE: i64 = 25;
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
    /// it reads a state (:hover, :focus...): matched here for the render
    /// nodes (RX), left to webapi.js when it asks (Q), whose cascade keeps
    /// the hits of elements alike and tries again only what it was left
    pub state: bool,
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

/// what DomTree keeps of an element for its walks (B, and its last node)
pub struct RxEl {
    /// children: webapi.js's number * 4 + 0 element, 1 text, 2 a hole
    pub kids: Vec<i64>,
    /// its style attribute: name, value, !important
    pub inline: Vec<(usize, i64, bool)>,
    pub a: String,
    pub ax: String,
    pub sc: String,
    pub flags: String,
    pub dirty: bool,
    pub told: bool,
    /// the last walk: its style, its parent's, the epoch, why it is a hole
    pub cs: usize,
    pub pcs: usize,
    pub ep: i64,
    pub why: String,
    /// 0 not walked, 1 a node, 2 nothing (display none), 3 a hole
    pub state: i64,
    /// children in painting order
    pub order: Vec<i64>,
    pub holeText: String,
    pub node: Option<Rc<RefCell<JsonValue>>>,
    pub kidNodes: Vec<Rc<RefCell<JsonValue>>>,
    pub ownKey: String,
    pub handle: i64,
    pub handleNode: Option<Rc<RefCell<JsonValue>>>,
    /// a change in it or under it (B, X, N), and the one the last walk saw
    pub touch: i64,
    pub walked: i64,
    /// styled again by the walk's phase A: phase B builds its node again
    pub fresh: bool,
    /// a hole: webapi.js gave its JSON since it was last listed; an
    /// element: every node under it was there at the last phase B
    pub got: bool,
    pub complete: bool,
    /// inline values G set since its style was found, and nothing else
    /// changed in it (patchOk): name, the value before, the value now.
    /// Its next style is the last one with those values (rxPatch), not a
    /// whole cascade.
    pub patch: Vec<(usize, i64, i64)>,
    pub patchOk: bool,
    /// the names rxPatch wrote: phase B writes them over its last node
    pub patched: Vec<usize>,
}

impl RxEl {
    fn new() -> RxEl {
        RxEl {
            kids: Vec::new(),
            inline: Vec::new(),
            a: String::new(),
            ax: String::new(),
            sc: String::new(),
            flags: String::new(),
            dirty: true,
            told: false,
            cs: 0,
            pcs: 0,
            ep: 0,
            why: String::new(),
            state: 0,
            order: Vec::new(),
            holeText: String::new(),
            node: None,
            kidNodes: Vec::new(),
            ownKey: String::new(),
            handle: 0,
            handleNode: None,
            touch: 1,
            walked: 0,
            fresh: true,
            got: false,
            complete: false,
            patch: Vec::new(),
            patchOk: false,
            patched: Vec::new(),
        }
    }
}

/// a rule's declarations (D), in the order webapi.js's buildSpec sets them
pub struct RuleDecl {
    pub rank: i64,
    pub ua: bool,
    pub names: Vec<usize>,
    pub vals: Vec<i64>,
    pub imp: Vec<bool>,
    pub del: Vec<bool>,
}

/// logical properties (inline-size, margin-inline-start...) webapi.js maps
/// by writing mode: left to it
fn logical_name(n: &str) -> bool {
    n.contains("-inline") || n.contains("-block") || n.starts_with("inset-") || n == "inline-size" || n == "block-size" || n.contains("inline-size") || n.contains("block-size")
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
    /// webapi.js's number of the element in each slot
    ids: Vec<i64>,
    // ---- RX (computed styles and render nodes)
    pub tree: DomTree,
    rx: Vec<RxEl>,
    decls: HashMap<i64, Rc<Vec<RuleDecl>>>,
    texts: HashMap<i64, String>,
    textNodes: HashMap<i64, (String, Rc<RefCell<JsonValue>>)>,
    holeJson: HashMap<i64, String>,
    psMap: HashMap<i64, usize>,
    /// the walks' nodes by handle, for the page's {"rx": n} (DomPage)
    pub ext: Rc<RefCell<JsonNodes>>,
    /// a node a hole's delta named that the host does not keep
    holeMiss: bool,
    jsonMemo: HashMap<String, Rc<RefCell<JsonValue>>>,
    rxHoles: Vec<(i64, usize)>,
    handleN: i64,
    rxEpoch: i64,
    rxEp: i64,
    rxEpKey: String,
    rxRootPx: f64,
    rxVw: f64,
    rxVh: f64,
    pub walks: i64,
    rxTick: i64,
    /// webapi.js's virtual rows are on (a box of 32 children or more may
    /// render only some: webapi.js renders it)
    rxVirt: bool,
    /// the slot a walk starts from (0 between walks)
    pub rxRootAt: usize,
    stHover: i64,
    stActive: i64,
    stFocus: i64,
    stFv: bool,
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
            ids: Vec::new(),
            tree: DomTree::new(),
            rx: Vec::new(),
            decls: HashMap::new(),
            texts: HashMap::new(),
            textNodes: HashMap::new(),
            holeJson: HashMap::new(),
            psMap: HashMap::new(),
            ext: Rc::new(RefCell::new(JsonNodes::new())),
            holeMiss: false,
            jsonMemo: HashMap::new(),
            rxHoles: Vec::new(),
            handleN: 0,
            rxEpoch: 0,
            rxEp: 0,
            rxEpKey: String::new(),
            rxRootPx: 16.0,
            rxVw: 0.0,
            rxVh: 0.0,
            walks: 0,
            rxTick: 1,
            rxVirt: false,
            rxRootAt: 0,
            stHover: 0,
            stActive: 0,
            stFocus: 0,
            stFv: false,
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
        self.ids = vec![0];
        self.rx = Vec::new();
        self.decls = HashMap::new();
        self.texts = HashMap::new();
        self.textNodes = HashMap::new();
        self.holeJson = HashMap::new();
        self.psMap = HashMap::new();
        self.rxEpoch += 1;
        // (a new page, maybe in a new realm that numbers its sessions from
        // the start again: no style is taken as sent)
        self.tree.reset();
        self.jsonMemo = HashMap::new();
        self.stHover = 0;
        self.stActive = 0;
        self.stFocus = 0;
        self.stFv = false;
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
                    out = format!("{{\"queries\":{},\"elements\":{},\"rules\":{},\"sets\":{},\"walks\":{},\"styles\":{}}}", self.queries, self.slot.len(), self.rs.borrow().rules.len(), self.sets.len(), self.walks, self.tree.styles.len());
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
                        self.rxEpoch += 1;
                    }
                }
                "I" => {
                    if f.len() >= 2 {
                        self.tree.setTables(f[1]);
                        self.rxEpoch += 1;
                    }
                }
                "D" => {
                    if f.len() >= 3 {
                        self.rxDecls(num(f[1]), f[2]);
                    }
                }
                "B" => {
                    if f.len() >= 8 {
                        self.rxDescribe(&f);
                    }
                }
                "G" => {
                    if f.len() >= 3 {
                        self.rxInline(&f);
                    }
                }
                "X" => {
                    // (a text told again as it was: nothing changed)
                    let changed = if f.len() >= 4 {
                        match self.texts.get(&num(f[1])) {
                            Some(t) => t.as_str() != f[2],
                            None => true,
                        }
                    } else {
                        false
                    };
                    if changed {
                        self.texts.insert(num(f[1]), f[2].to_string());
                        let p = num(f[3]);
                        if let Some(&ps) = self.slot.get(&p) {
                            self.rxTick += 1;
                            // (its node's children change: not patched)
                            self.rxEl(ps);
                            self.rx[ps].patchOk = false;
                            self.rxTouchUp(ps);
                        }
                    }
                }
                "W" => {
                    if f.len() >= 5 {
                        self.setStates(num(f[1]), num(f[2]), num(f[3]), f[4] == "1");
                    }
                }
                "V" => {
                    // (is this the host webapi.js told? a restored page asks
                    // before it names the host's nodes)
                    out = if f.len() > 1 && num(f[1]) == self.session { "ok".to_string() } else { "!".to_string() };
                }
                "Y" => {
                    if f.len() >= 2 {
                        let h = num(f[1]);
                        out = match self.ext.borrow().map.get(&h) {
                            Some(n) => n.borrow().toJson(),
                            None => String::new(),
                        };
                    }
                }
                "C" => {
                    if f.len() >= 3 {
                        let c = self.tree.styleFrom(f[2]);
                        self.psMap.insert(num(f[1]), c);
                    }
                }
                "Z" => {
                    self.walks += 1;
                    out = self.rxWalk(&f);
                }
                "J" => {
                    if f.len() >= 3 {
                        self.holeJson.insert(num(f[1]), f[2].to_string());
                    }
                }
                "K" => {
                    if f.len() >= 2 {
                        let at = match self.slot.get(&num(f[1])) {
                            Some(&k) => k,
                            None => 0,
                        };
                        out = if at != 0 && at < self.rx.len() { self.rxFinish(at) } else { "0".to_string() };
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
        self.ids.push(id);
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
            // (what selectors see of it changed: its styles and all under it)
            self.rxTick += 1;
            self.rxDirtyDown(k);
            self.rxTouchUp(k);
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
                set.rules.push(Rc::new(Sel { parts: Vec::new(), js: true, need: vec![0, 0, 0, 0], state: false }));
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

    // ---- RX: computed styles and render nodes (DomTree)

    fn rxEl(&mut self, k: usize) {
        while self.rx.len() <= k {
            self.rx.push(RxEl::new());
        }
    }

    /// B: an element's render description (its children, inline style,
    /// what webapi.js gives of it)
    /// a change at slot k: it and its ancestors are walked again
    fn rxTouchUp(&mut self, k: usize) {
        let t = self.rxTick;
        let mut q = k;
        let mut guard = 0;
        while q != 0 && guard < 100000 {
            self.rxEl(q);
            if self.rx[q].touch == t {
                break;
            }
            self.rx[q].touch = t;
            q = self.els[q].pslot;
            guard += 1;
        }
    }

    fn rxDescribe(&mut self, f: &Vec<&str>) {
        let id = num(f[1]);
        let k = self.slotOf(id);
        self.rxEl(k);
        let mut kids: Vec<i64> = Vec::new();
        if !f[2].is_empty() {
            for c in f[2].split(',') {
                if c.len() < 2 {
                    continue;
                }
                let kind = &c[0..1];
                let n = num(&c[1..]);
                let code = if kind == "e" { 0 } else if kind == "t" { 1 } else { 2 };
                kids.push(n * 4 + code);
            }
        }
        let mut inl: Vec<(usize, i64, bool)> = Vec::new();
        if !f[3].is_empty() {
            for d in f[3].split('\u{3}') {
                let p: Vec<&str> = d.split('\u{2}').collect();
                if p.len() < 3 {
                    continue;
                }
                let n = self.tree.name(p[0]);
                let v = self.tree.value(p[1]);
                inl.push((n, v, p[2] == "1"));
            }
        }
        // (told again as it was: only what is under it changed, its
        // holes webapi.js gives may have)
        self.rxTick += 1;
        let same = {
            let r = &self.rx[k];
            r.told && r.kids == kids && r.inline == inl && r.a == f[4] && r.ax == f[5] && r.sc == f[6] && r.flags == f[7]
        };
        if !same {
            let r = &mut self.rx[k];
            r.patchOk = false;
            r.patch = Vec::new();
            r.kids = kids.clone();
            r.inline = inl;
            r.a = f[4].to_string();
            r.ax = f[5].to_string();
            r.sc = f[6].to_string();
            r.flags = f[7].to_string();
            r.dirty = true;
            r.told = true;
        }
        for &code in kids.iter() {
            if code % 4 == 2 {
                let ks = self.slotOf(code / 4);
                self.rxEl(ks);
                self.rx[ks].touch = self.rxTick;
            }
        }
        self.rxTouchUp(k);
    }

    /// G: inline properties set on an element told before, and nothing
    /// else changed at or under it: written over its inline style (a new
    /// name goes last, as webapi.js orders them)
    fn rxInline(&mut self, f: &Vec<&str>) {
        let id = num(f[1]);
        let k = self.slotOf(id);
        self.rxEl(k);
        if !self.rx[k].told {
            return;
        }
        for d in f[2].split('\u{3}') {
            let p: Vec<&str> = d.split('\u{2}').collect();
            if p.len() < 3 {
                continue;
            }
            let n = self.tree.name(p[0]);
            let v = self.tree.value(p[1]);
            let imp = p[2] == "1";
            let mut at: i64 = -1;
            let cnt = self.rx[k].inline.len();
            let mut i = 0;
            while i < cnt {
                if self.rx[k].inline[i].0 == n {
                    at = i as i64;
                    break;
                }
                i += 1;
            }
            if at >= 0 {
                let old = self.rx[k].inline[at as usize];
                if old.2 || imp {
                    self.rx[k].patchOk = false;
                } else if self.rx[k].patchOk {
                    let mut seen = false;
                    let pn = self.rx[k].patch.len();
                    let mut q = 0;
                    while q < pn {
                        if self.rx[k].patch[q].0 == n {
                            self.rx[k].patch[q].2 = v;
                            seen = true;
                        }
                        q += 1;
                    }
                    if !seen {
                        self.rx[k].patch.push((n, old.1, v));
                    }
                }
                self.rx[k].inline[at as usize] = (n, v, imp);
            } else {
                self.rx[k].patchOk = false;
                self.rx[k].inline.push((n, v, imp));
            }
        }
        // (and the attributes its node carries: the style attribute's text)
        if f.len() >= 4 {
            self.rx[k].a = f[3].to_string();
        }
        self.rx[k].dirty = true;
        self.rxTick += 1;
        self.rxTouchUp(k);
    }

    /// D: the declarations of rule set n's rules (by their place in "w"):
    /// [[rank, ua, [[name, value, important, delete]...]]...]
    fn rxDecls(&mut self, n: i64, json: &str) {
        let p = JsonParser::parse(json.to_string());
        let v = p.borrow_mut().value();
        if !p.borrow().ok {
            return;
        }
        let mut out: Vec<RuleDecl> = Vec::new();
        let count = v.borrow().count();
        let mut i = 0;
        while i < count {
            let w = v.borrow().item(i);
            let mut rd = RuleDecl { rank: JsonValue::intOf(&w.borrow().item(0), 0), ua: JsonValue::intOf(&w.borrow().item(1), 0) == 1, names: Vec::new(), vals: Vec::new(), imp: Vec::new(), del: Vec::new() };
            let ds = w.borrow().item(2);
            let dn = ds.borrow().count();
            let mut j = 0;
            while j < dn {
                let d = ds.borrow().item(j);
                let nm = d.borrow().item(0).borrow().text();
                let vt = d.borrow().item(1).borrow().text();
                let nid = self.tree.name(&nm);
                let vid = self.tree.value(&vt);
                rd.names.push(nid);
                rd.vals.push(vid);
                rd.imp.push(JsonValue::intOf(&d.borrow().item(2), 0) == 1);
                rd.del.push(JsonValue::intOf(&d.borrow().item(3), 0) == 1);
                j += 1;
            }
            out.push(rd);
            i += 1;
        }
        self.decls.insert(n, Rc::new(out));
        self.rxEpoch += 1;
    }

    /// the declarations an element's style is from (buildSpec), in
    /// `spec`; false when DomTree cannot style it (and why)
    fn rxSpec(&mut self, at: usize, id: i64, spec: &mut Cs) -> bool {
        let mut hits: Vec<usize> = Vec::new();
        let mut check: Vec<usize> = Vec::new();
        if self.queryList(id, "", &mut hits, &mut check, true) == 0 {
            self.tree.why = "not told".to_string();
            return false;
        }
        if !check.is_empty() {
            self.tree.why = "selector for webapi.js".to_string();
            return false;
        }
        // (a box of its own for ::before and the like: webapi.js's)
        let pes = ["before", "after", "first-letter", "first-line", "marker"];
        for pe in pes.iter() {
            if !self.rs.borrow().pidx.contains_key(*pe) {
                continue;
            }
            let mut ph: Vec<usize> = Vec::new();
            let mut pc: Vec<usize> = Vec::new();
            self.queryList(id, pe, &mut ph, &mut pc, true);
            if !ph.is_empty() || !pc.is_empty() {
                self.tree.why = format!("::{}", pe);
                return false;
            }
        }
        if !self.decls.contains_key(&self.cur) {
            self.tree.why = "no declarations".to_string();
            return false;
        }
        let ds = self.decls.get(&self.cur).unwrap().clone();
        // (in the cascade's order: webapi.js's rank)
        let mut order: Vec<usize> = Vec::new();
        for &h in hits.iter() {
            if h >= ds.len() {
                self.tree.why = "rule without declarations".to_string();
                return false;
            }
            let mut p = order.len();
            while p > 0 && ds[order[p - 1]].rank > ds[h].rank {
                p -= 1;
            }
            order.insert(p, h);
        }
        let mut imp: Vec<i64> = Vec::new();
        for &h in order.iter() {
            let rd = &ds[h];
            let mut j = 0;
            while j < rd.names.len() {
                let n = rd.names[j];
                if rd.del[j] {
                    spec.del(n);
                } else {
                    spec.set(n, rd.vals[j]);
                }
                j += 1;
            }
        }
        let inl = self.rx[at].inline.clone();
        for &(n, v, _p) in inl.iter() {
            if n < imp.len() && imp[n] != 0 {
                continue;
            }
            spec.set(n, v);
        }
        for &h in order.iter() {
            let rd = &ds[h];
            let mut j = 0;
            while j < rd.names.len() {
                if rd.imp[j] && rd.del[j] {
                    spec.del(rd.names[j]);
                } else if rd.imp[j] {
                    let n = rd.names[j];
                    spec.set(n, rd.vals[j]);
                    while imp.len() <= n {
                        imp.push(0);
                    }
                    imp[n] = if rd.ua { 1 } else { 2 };
                }
                j += 1;
            }
        }
        for &(n, v, p) in inl.iter() {
            if p {
                spec.set(n, v);
            }
        }
        // what DomTree leaves to webapi.js
        for &n in spec.order.iter() {
            let nm = &self.tree.names[n];
            if nm.starts_with("--") || nm.starts_with("animation") || nm.starts_with("transition") || logical_name(nm) {
                self.tree.why = format!("property {}", nm);
                return false;
            }
            let v = spec.vals[n];
            if v >= 0 && self.tree.values[v as usize].contains("var(") {
                self.tree.why = "var()".to_string();
                return false;
            }
        }
        true
    }

    /// the computed style of the element in slot at under parent style
    /// pcs (0 none, the root); 0 when DomTree cannot style it
    fn rxStyle(&mut self, at: usize, id: i64, pcs: usize) -> usize {
        let mut spec = Cs::new();
        if !self.rxSpec(at, id, &mut spec) {
            return 0;
        }
        self.tree.bad = false;
        let root = self.els[at].parent == 0;
        let cs = self.tree.compute(&spec, pcs, root, self.rxRootPx, self.rxVw, self.rxVh);
        if self.tree.bad || cs == 0 {
            return 0;
        }
        if root {
            self.rxRootPx = self.tree.styles[cs].fontPx;
        }
        cs
    }

    /// rxStyle for an element whose inline transform or opacity alone
    /// changed (RxEl.patch): its last style cs with the new values, when
    /// the old ones were what won the cascade and the new ones need no
    /// more than the element's own font size; 0 when not so
    fn rxPatch(&mut self, at: usize, cs: usize) -> usize {
        let old = self.tree.style(cs);
        let nT = self.tree.name("transform");
        let nO = self.tree.name("opacity");
        let ctx = Ctx::new(old.fontPx, self.rxRootPx, self.rxVw / 100.0, self.rxVh / 100.0);
        let pc = self.tree.style(self.rx[at].pcs);
        let hasP = self.rx[at].pcs != 0;
        let mut out = Cs::new();
        out.order = old.order.clone();
        out.vals = old.vals.clone();
        out.fontPx = old.fontPx;
        out.fsKw = old.fsKw;
        out.cc = old.cc.clone();
        out.ia = old.ia;
        let ps = self.rx[at].patch.clone();
        for &(n, a, b) in ps.iter() {
            if n != nT && n != nO {
                return 0;
            }
            let at0 = self.tree.text(a);
            let bt = self.tree.text(b);
            if !rx_patchable(&at0) || !rx_patchable(&bt) {
                return 0;
            }
            self.tree.bad = false;
            let ca = self.tree.computeValue(n, &at0, &ctx, &pc, hasP);
            if self.tree.bad || old.get(n) < 0 || self.tree.text(old.get(n)) != ca {
                return 0;
            }
            let cb = self.tree.computeValue(n, &bt, &ctx, &pc, hasP);
            if self.tree.bad {
                return 0;
            }
            let vid = self.tree.value(&cb);
            // (to or from the initial value the node gains or loses the
            // member: built whole)
            if vid == self.tree.initial[n] {
                return 0;
            }
            out.set(n, vid);
        }
        self.tree.intern(out)
    }

    /// whether DomTree draws an element of computed style cs as webapi.js
    /// would (the parts of renderNode it does)
    fn rxDrawable(&mut self, cs: usize) -> bool {
        let c = self.tree.style(cs);
        let d = self.tree.text(c.get(self.tree.nDisplay));
        if !(d == "block" || d == "inline" || d == "inline-block" || d == "flex" || d == "inline-flex" || d == "grid" || d == "inline-grid" || d == "flow-root" || d == "none") {
            self.tree.why = format!("display {}", d);
            return false;
        }
        let fl = c.get(self.tree.nFloat);
        if fl >= 0 && self.tree.values[fl as usize] != "none" {
            self.tree.why = "float".to_string();
            return false;
        }
        if self.tree.text(c.get(self.tree.nVisibility)) == "collapse" {
            self.tree.why = "visibility collapse".to_string();
            return false;
        }
        let none_or_absent = [self.tree.nCounterReset, self.tree.nCounterIncrement, self.tree.nTranslate, self.tree.nRotate, self.tree.nScale];
        for &n in none_or_absent.iter() {
            let v = c.get(n);
            if v >= 0 && self.tree.values[v as usize] != "none" {
                self.tree.why = format!("property {}", self.tree.names[n]);
                return false;
            }
        }
        let bs = c.get(self.tree.nBoxShadow);
        if bs >= 0 && self.tree.values[bs as usize].contains("inset") {
            self.tree.why = "inset shadow".to_string();
            return false;
        }
        true
    }

    /// Phase A of a walk: styles (and whether DomTree draws it) of the
    /// element in slot at under parent style pcs, and all under it that
    /// changed. 1 a node, 2 nothing (display: none), 3 a hole (webapi.js
    /// renders it). The holes to render again go to rxHoles with their
    /// parent's style.
    fn rxA(&mut self, at: usize, pcs: usize, force: bool) -> i64 {
        self.rxEl(at);
        let id = self.rxIdOf(at);
        // (nothing in it or under it changed since the last walk, under the
        // same parent style: what that walk found holds, its holes too)
        {
            let r = &self.rx[at];
            if !force && !r.dirty && r.pcs == pcs && r.ep == self.rxEp && r.state != 0 && r.walked == r.touch && r.complete {
                return r.state;
            }
        }
        let again = force || self.rx[at].dirty || self.rx[at].pcs != pcs || self.rx[at].ep != self.rxEp || self.rx[at].state == 0;
        let samePcs = self.rx[at].pcs == pcs;
        let sameEp = self.rx[at].ep == self.rxEp;
        self.rx[at].walked = self.rx[at].touch;
        self.rx[at].fresh = true;
        self.rx[at].complete = false;
        let mut cs = self.rx[at].cs;
        if again {
            self.rx[at].dirty = false;
            self.rx[at].pcs = pcs;
            self.rx[at].ep = self.rxEp;
            self.rx[at].why = String::new();
            // (only inline values G set, under the same parent style and
            // rules: the last style with those values)
            let pc0 = self.rx[at].cs;
            let canPatch = !force && self.rx[at].patchOk && !self.rx[at].patch.is_empty() && self.rx[at].state == 1 && pc0 != 0 && samePcs && sameEp;
            let mut pcsx: usize = 0;
            if canPatch {
                pcsx = self.rxPatch(at, pc0);
            }
            self.rx[at].patched = Vec::new();
            if pcsx != 0 {
                let ps = self.rx[at].patch.clone();
                for &(n, _a, _b) in ps.iter() {
                    self.rx[at].patched.push(n);
                }
            }
            self.rx[at].patch = Vec::new();
            self.rx[at].patchOk = true;
            cs = if pcsx != 0 { pcsx } else if self.rx[at].told { self.rxStyle(at, id, pcs) } else { 0 };
            self.rx[at].cs = cs;
            if cs == 0 {
                let w = if self.rx[at].told { self.tree.why.clone() } else { "not described".to_string() };
                self.rx[at].why = w;
            } else if !self.rxDrawable(cs) {
                let w = self.tree.why.clone();
                self.rx[at].why = w;
            }
        }
        if cs == 0 || !self.rx[at].why.is_empty() {
            self.rx[at].state = 3;
            self.rx[at].got = false;
            self.rxHoles.push((id, pcs));
            return 3;
        }
        let c = self.tree.style(cs);
        if self.tree.text(c.get(self.tree.nDisplay)) == "none" {
            self.rx[at].state = 2;
            self.rx[at].complete = true;
            return 2;
        }
        // (the walk's root inline: webapi.js renders it, see rxWalk; nothing
        // under it styled first)
        if at == self.rxRootAt && self.tree.text(c.get(self.tree.nDisplay)) == "inline" {
            self.rx[at].fresh = true;
            self.rx[at].state = 3;
            self.rx[at].why = "inline root".to_string();
            self.rx[at].dirty = true;
            return 3;
        }
        let kids = self.rx[at].kids.clone();
        let leaf = self.rx[at].flags.contains('L');
        // (a box of many children with virtual rows: webapi.js renders it,
        // none of them styled here first)
        // (O: webapi.js found its children all absolutely placed, which no
        // virtual rows leave out: checked below once they are styled)
        let outKids = self.rx[at].flags.contains('O');
        if self.rxVirt && !leaf && !outKids {
            let mut ne = 0;
            for &code in kids.iter() {
                if code % 4 != 1 {
                    ne += 1;
                }
            }
            if ne >= 32 {
                self.rx[at].state = 3;
                self.rx[at].why = "many children".to_string();
                self.rx[at].dirty = true;
                self.rx[at].got = false;
                self.rxHoles.push((id, pcs));
                return 3;
            }
        }
        let mut kcs: Vec<usize> = Vec::new();
        let mut nEl = 0;
        let holes0 = self.rxHoles.len();
        let mut ok = true;
        let mut why = String::new();
        if !leaf {
            for &code in kids.iter() {
                let kid = code / 4;
                let kind = code % 4;
                if kind == 1 {
                    kcs.push(0);
                    let t = match self.texts.get(&kid) {
                        Some(s) => s.clone(),
                        None => String::new(),
                    };
                    if !t.is_empty() && !self.rxTextOk(&c, &t) {
                        ok = false;
                        why = "text".to_string();
                    }
                    continue;
                }
                nEl += 1;
                let ks = self.slotOf(kid);
                if kind == 2 {
                    // (a hole webapi.js gave: its style, when DomTree can
                    // tell, for the checks below; rendered again by webapi.js
                    // when it or its parent's style changed)
                    self.rxEl(ks);
                    let stale = {
                        let r = &self.rx[ks];
                        r.state != 3 || r.pcs != cs || r.ep != self.rxEp || r.walked != r.touch || !r.got
                    };
                    if stale {
                        let hc = if self.els[ks].known { self.rxStyle(ks, kid, cs) } else { 0 };
                        let r = &mut self.rx[ks];
                        r.cs = hc;
                        r.pcs = cs;
                        r.ep = self.rxEp;
                        r.walked = r.touch;
                        r.state = 3;
                        r.dirty = false;
                        r.got = false;
                        r.complete = false;
                        self.rxHoles.push((kid, cs));
                    }
                    kcs.push(self.rx[ks].cs);
                    continue;
                }
                self.rxA(ks, cs, force);
                kcs.push(self.rx[ks].cs);
            }
        }
        if nEl >= 32 && self.rxVirt {
            let mut out = outKids;
            let mut i = 0;
            while out && i < kids.len() {
                if kids[i] % 4 != 1 {
                    let kc = kcs[i];
                    let pos = if kc == 0 { String::new() } else { self.tree.text(self.tree.styles[kc].get(self.tree.nPosition)) };
                    out = pos == "absolute" || pos == "fixed";
                }
                i += 1;
            }
            if !out {
                ok = false;
                why = "many children".to_string();
            }
        }
        if ok && !leaf {
            let pd = self.tree.text(c.get(self.tree.nDisplay));
            let fg = pd == "flex" || pd == "inline-flex" || pd == "grid" || pd == "inline-grid";
            let mut i = 0;
            while i < kids.len() && ok {
                let code = kids[i];
                if code % 4 != 1 {
                    let ks = self.slotOf(code / 4);
                    let kc = kcs[i];
                    if kc == 0 {
                        // (one DomTree could not style: only a picture or a
                        // control, which no rule below makes a table part or
                        // an inline holding a block)
                        if !self.rxPlainHole(ks) {
                            ok = false;
                            why = "unknown child".to_string();
                        }
                    } else {
                        let kd = self.tree.text(self.tree.styles[kc].get(self.tree.nDisplay));
                        if !fg && kd.starts_with("table") {
                            ok = false;
                            why = "table child".to_string();
                        } else if kd == "inline" && self.rxHoldsBlock(ks, kc) {
                            ok = false;
                            why = "block in inline".to_string();
                        }
                    }
                }
                i += 1;
            }
        }
        if !ok {
            self.rxHoles.truncate(holes0);
            self.rx[at].state = 3;
            self.rx[at].why = why;
            // (styled again next walk: its children's holes went with it)
            self.rx[at].dirty = true;
            self.rx[at].got = false;
            self.rxHoles.push((id, pcs));
            return 3;
        }
        // painting order (paintOrder): positioned children with a z-index
        let mut order: Vec<usize> = Vec::new();
        let mut keys: Vec<i64> = Vec::new();
        let mut keyed = false;
        let mut i = 0;
        while i < kids.len() && !leaf {
            let mut z: i64 = 0;
            if kids[i] % 4 != 1 && kcs[i] != 0 {
                let kc = self.tree.style(kcs[i]);
                let pos = self.tree.text(kc.get(self.tree.nPosition));
                let zt = self.tree.text(kc.get(self.tree.nZ));
                let top = self.tree.text(kc.get(self.tree.nTop));
                let bot = self.tree.text(kc.get(self.tree.nBottom));
                let staticY = (top.is_empty() || top == "auto") && (bot.is_empty() || bot == "auto");
                if (pos == "absolute" || pos == "fixed") && !zt.is_empty() && zt != "auto" && !staticY {
                    let zz = parse_int(&zt);
                    z = if is_nan(zz) { 0 } else { zz as i64 };
                    if z != 0 {
                        keyed = true;
                    }
                }
            }
            let mut p = order.len();
            if keyed {
                while p > 0 && keys[p - 1] > z {
                    p -= 1;
                }
            }
            order.insert(p, i);
            keys.insert(p, z);
            i += 1;
        }
        let mut codes: Vec<i64> = Vec::new();
        for &o in order.iter() {
            codes.push(kids[o]);
        }
        self.rx[at].order = codes;
        self.rx[at].state = 1;
        1
    }

    fn rxIdOf(&self, at: usize) -> i64 {
        if at < self.ids.len() {
            self.ids[at]
        } else {
            0
        }
    }

    fn rxDirtyDown(&mut self, k: usize) {
        if k >= self.rx.len() || self.rx[k].state == 0 {
            return;
        }
        self.rx[k].dirty = true;
        self.rx[k].touch = self.rxTick;
        let kids = self.rx[k].kids.clone();
        for &code in kids.iter() {
            if code % 4 != 1 {
                if let Some(&ks) = self.slot.get(&(code / 4)) {
                    self.rxDirtyDown(ks);
                }
            }
        }
    }

    /// renderNode's text checks: no text-transform, small caps or
    /// pre-line breaks (smallCapsText's other paths)
    fn rxTextOk(&self, c: &Rc<Cs>, t: &str) -> bool {
        let tt = self.tree.text(c.get(self.tree.nTextTransform));
        if !tt.is_empty() && tt != "none" {
            return false;
        }
        let mut fv = self.tree.text(c.get(self.tree.nFontVariantCaps));
        if fv.is_empty() {
            fv = self.tree.text(c.get(self.tree.nFontVariant));
        }
        if fv.contains("small-caps") {
            return false;
        }
        if self.tree.text(c.get(self.tree.nWhiteSpace)) == "pre-line" && t.contains('\n') {
            return false;
        }
        true
    }

    /// a hole DomTree could not style that needs nothing of its parent's
    /// render: not HTML, or a replaced element or control
    fn rxPlainHole(&self, ks: usize) -> bool {
        let e = &self.els[ks];
        if !e.known {
            return false;
        }
        if !e.html {
            return true;
        }
        let t = e.lower.as_str();
        t == "img" || t == "input" || t == "textarea" || t == "select" || t == "button" || t == "br" || t == "iframe" || t == "video" || t == "audio" || t == "canvas" || t == "svg"
    }

    /// webapi.js holdsBlock: an inline (in HTML) holding an in-flow block
    fn rxHoldsBlock(&mut self, ks: usize, kc: usize) -> bool {
        if !self.els[ks].html {
            return false;
        }
        let c = self.tree.style(kc);
        let d = self.tree.text(c.get(self.tree.nDisplay));
        let pos = self.tree.text(c.get(self.tree.nPosition));
        if d != "inline" || pos == "absolute" || pos == "fixed" {
            return false;
        }
        let t = self.els[ks].lower.clone();
        if t == "img" || t == "input" || t == "textarea" || t == "select" || t == "button" || t == "br" || t == "iframe" || t == "video" || t == "audio" || t == "canvas" || t == "svg" {
            return false;
        }
        if ks >= self.rx.len() {
            return true;
        }
        let kids = self.rx[ks].kids.clone();
        for &code in kids.iter() {
            if code % 4 == 1 {
                continue;
            }
            let gs = self.slotOf(code / 4);
            if gs >= self.rx.len() || self.rx[gs].cs == 0 {
                return true;
            }
            let gc = self.tree.style(self.rx[gs].cs);
            let gp = self.tree.text(gc.get(self.tree.nPosition));
            let gf = self.tree.text(gc.get(self.tree.nFloat));
            if gp == "absolute" || gp == "fixed" || (!gf.is_empty() && gf != "none") {
                continue;
            }
            let gd = self.tree.text(gc.get(self.tree.nDisplay));
            if gd == "block" || gd == "list-item" || gd == "table" || gd == "flex" || gd == "grid" || gd == "flow-root" || gd == "grid-lanes" {
                return true;
            }
            let gcs = self.rx[gs].cs;
            if self.rxHoldsBlock(gs, gcs) {
                return true;
            }
        }
        false
    }

    /// what renderNode writes of a style under its parent's (the own
    /// members, s) as JSON text
    fn rxOwn(&mut self, at: usize, cs: usize, pcs: usize) -> String {
        let c = self.tree.style(cs);
        let p = self.tree.style(pcs);
        let hasP = pcs != 0;
        let mut names: Vec<usize> = Vec::new();
        let mut vals: Vec<String> = Vec::new();
        for &n in c.order.iter() {
            let v = c.vals[n];
            if v < 0 {
                continue;
            }
            if self.tree.inherited[n] {
                if hasP && p.get(n) == v {
                    continue;
                }
            } else if self.tree.initial[n] == v {
                continue;
            }
            names.push(n);
            vals.push(self.tree.values[v as usize].clone());
        }
        // (a border with no colour of its own is in the element's colour)
        let col = c.get(self.tree.nColor);
        if col >= 0 {
            let colT = self.tree.values[col as usize].clone();
            let sides = ["top", "right", "bottom", "left"];
            for sd in sides.iter() {
                let sn = self.tree.name(&format!("border-{}-style", sd));
                let cn = self.tree.name(&format!("border-{}-color", sd));
                let mut bst = String::new();
                let mut ci: i64 = -1;
                let mut i = 0;
                while i < names.len() {
                    if names[i] == sn {
                        bst = vals[i].clone();
                    }
                    if names[i] == cn {
                        ci = i as i64;
                    }
                    i += 1;
                }
                if !bst.is_empty() && bst != "none" && bst != "hidden" && (ci < 0 || vals[ci as usize] == "currentcolor") {
                    if ci < 0 {
                        names.push(cn);
                        vals.push(colT.clone());
                    } else {
                        vals[ci as usize] = colT.clone();
                    }
                }
            }
        }
        let mut extra: Vec<String> = Vec::new();
        let mut xv: Vec<String> = Vec::new();
        let mut bsi: i64 = -1;
        let mut i = 0;
        while i < names.len() {
            if names[i] == self.tree.nBoxShadow {
                bsi = i as i64;
            }
            i += 1;
        }
        if bsi >= 0 && vals[bsi as usize] != "none" {
            let colT = if col >= 0 { self.tree.values[col as usize].clone() } else { String::new() };
            let bsv = vals[bsi as usize].clone();
            let (rings, drop) = self.tree.shadowLayers(&bsv, &colT);
            if !rings.is_empty() {
                extra.push("box-ring".to_string());
                xv.push(rings);
            }
            if !drop.is_empty() {
                extra.push("box-drop".to_string());
                xv.push(drop);
            }
        }
        // (the root's first body child gives its overflow to the viewport)
        let mut skipOv = false;
        if self.els[at].lower == "body" && self.els[at].html {
            let ps = self.els[at].pslot;
            if ps != 0 && self.els[ps].lower == "html" && self.els[ps].parent == 0 {
                let mut hasOv = false;
                for &n in names.iter() {
                    if n == self.tree.nOverflowX || n == self.tree.nOverflowY {
                        hasOv = true;
                    }
                }
                if hasOv && self.rxFirstBody(ps) == self.rxIdOf(at) {
                    let ox = self.tree.text(p.get(self.tree.nOverflowX));
                    let oy = self.tree.text(p.get(self.tree.nOverflowY));
                    if (ox.is_empty() || ox == "visible") && (oy.is_empty() || oy == "visible") {
                        skipOv = true;
                    }
                }
            }
        }
        let mut out = String::from("{");
        let mut first = true;
        let mut j = 0;
        while j < names.len() {
            let n = names[j];
            if skipOv && (n == self.tree.nOverflowX || n == self.tree.nOverflowY) {
                j += 1;
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&JsonValue::quote(&self.tree.names[n]));
            out.push(':');
            out.push_str(&JsonValue::quote(&vals[j]));
            j += 1;
        }
        let mut q = 0;
        while q < extra.len() {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&JsonValue::quote(&extra[q]));
            out.push(':');
            out.push_str(&JsonValue::quote(&xv[q]));
            q += 1;
        }
        out.push('}');
        out
    }

    /// the id of html's first body child (0 none)
    fn rxFirstBody(&mut self, hs: usize) -> i64 {
        if hs >= self.rx.len() {
            return 0;
        }
        let kids = self.rx[hs].kids.clone();
        for &code in kids.iter() {
            if code % 4 == 1 {
                continue;
            }
            let ks = self.slotOf(code / 4);
            if self.els[ks].lower == "body" {
                return code / 4;
            }
        }
        0
    }

    /// a JSON text as a node, the same object for the same text
    fn rxJson(&mut self, text: &str) -> Option<Rc<RefCell<JsonValue>>> {
        if text.is_empty() {
            return None;
        }
        if let Some(v) = self.jsonMemo.get(text) {
            return Some(v.clone());
        }
        let p = JsonParser::parse(text.to_string());
        let v = p.borrow_mut().value();
        if !p.borrow().ok {
            return None;
        }
        if self.jsonMemo.len() >= 20000 {
            self.jsonMemo = HashMap::new();
        }
        self.jsonMemo.insert(text.to_string(), v.clone());
        Some(v)
    }

    /// a hole's JSON (webapi.js's render of it) as nodes, the nodes of the
    /// page's other DomTree walks in it ({"rx": n}) put in
    fn rxHoleNode(&mut self, text: &str) -> Option<Rc<RefCell<JsonValue>>> {
        if text.is_empty() {
            return None;
        }
        let p = JsonParser::parse(text.to_string());
        let v = p.borrow_mut().value();
        if !p.borrow().ok {
            return None;
        }
        // (a delta: the nodes it names, {"r": n}, the host keeps; one it
        // does not keep, and the hole is not had)
        let refs = text.contains("{\"r\":");
        if refs && !self.ext.borrow().shares {
            return None;
        }
        if refs || text.contains("\"rx\":") {
            self.holeMiss = false;
            let r = self.rxResolve(&v);
            if self.holeMiss {
                return None;
            }
            return Some(r);
        }
        Some(v)
    }
    fn rxResolve(&mut self, n: &Rc<RefCell<JsonValue>>) -> Rc<RefCell<JsonValue>> {
        if n.borrow().kind != 5 {
            return n.clone();
        }
        if n.borrow().keys.len() == 1 && n.borrow().keys[0] == "r" {
            let k = n.borrow().getInt("r", -1);
            let got = self.ext.borrow().by_n.get(&k).cloned();
            if got.is_some() {
                return got.unwrap();
            }
            self.holeMiss = true;
            return n.clone();
        }
        if n.borrow().keyAt("rx") >= 0 {
            let h = n.borrow().getInt("rx", -1);
            let got = self.ext.borrow().map.get(&h).cloned();
            if got.is_some() {
                return got.unwrap();
            }
            return n.clone();
        }
        let c = n.borrow().get("c");
        if c.borrow().kind == 4 {
            let items = c.borrow().items.clone();
            let mut out: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
            for k in items.iter() {
                out.push(self.rxResolve(k));
            }
            c.borrow_mut().items = out;
        }
        n.clone()
    }

    /// a hole's JSON webapi.js gave this walk (J) as its node; none given:
    /// its node of the last walk
    fn rxHoleTake(&mut self, k: usize, id: i64) {
        let t = match self.holeJson.get(&id) {
            Some(s) => s.clone(),
            None => return,
        };
        self.rx[k].got = true;
        self.rx[k].complete = true;
        if self.rx[k].holeText == t && (self.rx[k].node.is_some() || t.is_empty()) {
            return;
        }
        let n = self.rxHoleNode(&t);
        // (a delta that names a node the host does not keep, or bad text:
        // not had, the walk incomplete; webapi.js renders it then)
        if n.is_none() && !t.is_empty() {
            let r = &mut self.rx[k];
            r.got = false;
            r.complete = false;
            r.holeText = String::new();
            r.node = None;
            r.kidNodes = Vec::new();
            r.ownKey = String::new();
            r.fresh = true;
            return;
        }
        // (the node it had, named now: nothing changed)
        let mut same = false;
        if n.is_some() && self.rx[k].node.is_some() {
            let a = n.clone().unwrap();
            let b = self.rx[k].node.clone().unwrap();
            same = Rc::ptr_eq(&a, &b);
        }
        if same {
            self.rx[k].holeText = t;
            return;
        }
        let r = &mut self.rx[k];
        r.holeText = t;
        r.node = n;
        r.kidNodes = Vec::new();
        r.ownKey = String::new();
        r.fresh = true;
    }

    /// Phase B: the element's node (none: display none), its children's
    /// first; the node of the last walk again when nothing in it changed
    /// rxB for an element rxPatch styled: a copy of its last node with
    /// the patched members of its style and its attributes anew, when its
    /// children are the nodes they were (None: built as rxB builds it)
    fn rxPatchNode(&mut self, at: usize, cs: usize) -> Option<Rc<RefCell<JsonValue>>> {
        let old = self.rx[at].node.clone()?;
        let codes = self.rx[at].order.clone();
        for &code in codes.iter() {
            let kind = code % 4;
            if kind == 1 {
                // (a text changed under it: X touched it, and it is styled whole)
                continue;
            }
            if kind == 2 {
                return None;
            }
            let ks = self.slotOf(code / 4);
            if ks >= self.rx.len() || self.rx[ks].fresh || self.rx[ks].walked != self.rx[ks].touch || !self.rx[ks].complete {
                return None;
            }
        }
        let os = old.borrow().get("s");
        if os.borrow().kind != 5 {
            return None;
        }
        let c = self.tree.style(cs);
        let ns = JsonValue::mkObj();
        ns.borrow_mut().keys = os.borrow().keys.clone();
        ns.borrow_mut().items = os.borrow().items.clone();
        let names = self.rx[at].patched.clone();
        for &n in names.iter() {
            let key = self.tree.names[n].clone();
            if !ns.borrow().has(&key) {
                return None;
            }
            let v = c.get(n);
            if v < 0 {
                return None;
            }
            let t = self.tree.values[v as usize].clone();
            ns.borrow_mut().put(&key, JsonValue::mkStr(t));
        }
        let o = JsonValue::mkObj();
        o.borrow_mut().keys = old.borrow().keys.clone();
        o.borrow_mut().items = old.borrow().items.clone();
        o.borrow_mut().put("s", ns);
        let a = self.rx[at].a.clone();
        if let Some(av) = self.rxJson(&a) {
            o.borrow_mut().put("a", av);
        }
        self.rx[at].patched = Vec::new();
        // (the next whole build compares with nothing: built anew)
        self.rx[at].ownKey = String::new();
        self.rx[at].node = Some(o.clone());
        self.rx[at].complete = true;
        Some(o)
    }

    fn rxB(&mut self, at: usize) -> Option<Rc<RefCell<JsonValue>>> {
        let state = self.rx[at].state;
        if state == 2 {
            return None;
        }
        let id = self.rxIdOf(at);
        if state == 3 {
            self.rxHoleTake(at, id);
            let g = self.rx[at].got;
            self.rx[at].complete = g;
            return self.rx[at].node.clone();
        }
        // (not styled again this walk: its node of the last)
        if !self.rx[at].fresh && self.rx[at].node.is_some() {
            return self.rx[at].node.clone();
        }
        self.rx[at].fresh = false;
        let cs = self.rx[at].cs;
        let pcs = self.rx[at].pcs;
        // (a style rxPatch made: the last node with those members written
        // over, its children the same nodes when they are)
        if !self.rx[at].patched.is_empty() {
            if let Some(n) = self.rxPatchNode(at, cs) {
                return Some(n);
            }
        }
        let sText = self.rxOwn(at, cs, pcs);
        let ia = self.tree.styles[cs].ia;
        let r = &self.rx[at];
        let own = format!("{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}", sText, r.a, r.ax, if ia { "1" } else { "" }, r.sc, self.els[at].tag);
        let codes = r.order.clone();
        let mut kidNodes: Vec<Rc<RefCell<JsonValue>>> = Vec::new();
        let mut all = true;
        for &code in codes.iter() {
            let kid = code / 4;
            let kind = code % 4;
            if kind == 1 {
                let t = match self.texts.get(&kid) {
                    Some(s) => s.clone(),
                    None => String::new(),
                };
                if t.is_empty() {
                    continue;
                }
                let key = format!("{}\u{1}{}", kid, t);
                let tn = match self.textNodes.get(&kid) {
                    Some(p) if p.0 == key => Some(p.1.clone()),
                    _ => None,
                };
                let node = if tn.is_some() {
                    tn.unwrap()
                } else {
                    let o = JsonValue::mkObj();
                    o.borrow_mut().put("i", JsonValue::mkInt(kid));
                    o.borrow_mut().put("x", JsonValue::mkStr(t.clone()));
                    self.textNodes.insert(kid, (key, o.clone()));
                    o
                };
                kidNodes.push(node);
                continue;
            }
            let ks = self.slotOf(kid);
            if kind == 2 {
                self.rxEl(ks);
                self.rxHoleTake(ks, kid);
                if !self.rx[ks].got {
                    all = false;
                }
                if let Some(n) = self.rx[ks].node.clone() {
                    kidNodes.push(n);
                }
                continue;
            }
            if let Some(n) = self.rxB(ks) {
                kidNodes.push(n);
            }
            if !self.rx[ks].complete {
                all = false;
            }
        }
        self.rx[at].complete = all;
        // (the same members and the same children: the same node)
        let same = {
            let r = &self.rx[at];
            r.node.is_some() && r.ownKey == own && r.kidNodes.len() == kidNodes.len() && {
                let mut eq = true;
                let mut i = 0;
                while i < kidNodes.len() {
                    if !Rc::ptr_eq(&r.kidNodes[i], &kidNodes[i]) {
                        eq = false;
                        break;
                    }
                    i += 1;
                }
                eq
            }
        };
        if same {
            return self.rx[at].node.clone();
        }
        let o = JsonValue::mkObj();
        o.borrow_mut().put("i", JsonValue::mkInt(id));
        let tag = self.els[at].tag.clone();
        o.borrow_mut().put("t", JsonValue::mkStr(tag));
        let sv = match self.rxJson(&sText) {
            Some(v) => v,
            None => JsonValue::mkObj(),
        };
        o.borrow_mut().put("s", sv);
        let a = self.rx[at].a.clone();
        if let Some(av) = self.rxJson(&a) {
            o.borrow_mut().put("a", av);
        }
        let ax = self.rx[at].ax.clone();
        if let Some(xv) = self.rxJson(&ax) {
            o.borrow_mut().put("ax", xv);
        }
        if ia {
            o.borrow_mut().put("ia", JsonValue::mkInt(1));
        }
        let sc = self.rx[at].sc.clone();
        if let Some(scv) = self.rxJson(&sc) {
            o.borrow_mut().put("sc", scv);
        }
        if !kidNodes.is_empty() {
            let arr = JsonValue::mkArr();
            arr.borrow_mut().items = kidNodes.clone();
            o.borrow_mut().put("c", arr);
        }
        let r = &mut self.rx[at];
        r.ownKey = own;
        r.kidNodes = kidNodes;
        r.node = Some(o.clone());
        Some(o)
    }

    /// Z: a walk from element id under parent style psN (webapi.js's
    /// number, 0 none): "-why" DomTree does not draw it, "0" nothing to
    /// draw, "N handle" its node, or "H holes styles" when webapi.js is to
    /// render the holes first (then J and K). A hole's render may walk
    /// again under it before this walk's K.
    fn rxWalk(&mut self, f: &Vec<&str>) -> String {
        if f.len() < 8 {
            return "-bad request".to_string();
        }
        if num(f[7]) != self.session {
            return "!".to_string();
        }
        if !self.tree.hasTables || !self.hasRules {
            return "-no tables".to_string();
        }
        let id = num(f[1]);
        let psN = num(f[2]);
        let vw = parse_float(f[3]);
        let vh = parse_float(f[4]);
        let rootPx = parse_float(f[5]);
        // (what every style is of: the rule set, its flags, the viewport,
        // the root's font size)
        self.rxVirt = f[6] == "1";
        let ep = format!("{}:{}:{}:{}:{}:{}", self.cur, f[3], f[4], f[5], f[6], self.rxEpoch);
        if ep != self.rxEpKey {
            self.rxEpKey = ep;
            self.rxEp += 1;
        }
        self.rxVw = vw;
        self.rxVh = vh;
        self.rxRootPx = rootPx;
        let pcs = if psN > 0 {
            match self.psMap.get(&psN) {
                Some(&c) => c,
                None => return "-parent style not told".to_string(),
            }
        } else {
            0
        };
        let at = match self.slot.get(&id) {
            Some(&k) => k,
            None => 0,
        };
        if at == 0 || at >= self.rx.len() || !self.rx[at].told {
            return "-not described".to_string();
        }
        self.rxHoles = Vec::new();
        self.holeJson = HashMap::new();
        self.rxRootAt = at;
        let st = self.rxA(at, pcs, false);
        self.rxRootAt = 0;
        if st == 3 {
            let w = self.rx[at].why.clone();
            return format!("-{}", w);
        }
        if st == 2 {
            return "0".to_string();
        }
        // (an inline one may be split around a block in it by its parent,
        // which webapi.js does with its JSON)
        let rd = self.tree.text(self.tree.styles[self.rx[at].cs].get(self.tree.nDisplay));
        if rd == "inline" {
            self.rx[at].fresh = true;
            return "-inline root".to_string();
        }
        if self.rxHoles.is_empty() {
            return format!("N\u{1}{}", self.rxFinish(at));
        }
        let mut holes = String::new();
        let mut styles = String::new();
        let hl = self.rxHoles.clone();
        let mut sent: Vec<usize> = Vec::new();
        for &(hid, hcs) in hl.iter() {
            if !holes.is_empty() {
                holes.push(';');
            }
            holes.push_str(&format!("{},{}", hid, hcs));
            if hcs != 0 && self.tree.styles[hcs].sent != self.session && !sent.contains(&hcs) {
                sent.push(hcs);
                if !styles.is_empty() {
                    styles.push('\u{3}');
                }
                styles.push_str(&format!("{}\u{2}{}", hcs, self.tree.styleJson(hcs)));
            }
        }
        for &s in sent.iter() {
            // (Rc: marked sent through a fresh copy)
            let c = self.tree.styles[s].clone();
            let mut n = Cs::new();
            n.order = c.order.clone();
            n.vals = c.vals.clone();
            n.fontPx = c.fontPx;
            n.fsKw = c.fsKw;
            n.cc = c.cc.clone();
            n.ia = c.ia;
            n.sent = self.session;
            self.tree.styles[s] = Rc::new(n);
        }
        format!("H\u{1}{}\u{1}{}", holes, styles)
    }

    /// K: the walk's nodes from element id, the holes' JSON put in: its
    /// handle ("0" none). The node of the last walk keeps its handle; a new
    /// one gets a new handle and the old is let go.
    fn rxFinish(&mut self, at: usize) -> String {
        let n = self.rxB(at);
        if n.is_none() {
            return "0".to_string();
        }
        let node = n.unwrap();
        // (a hole under it that webapi.js did not give: it renders this one)
        if !self.rx[at].complete {
            return String::new();
        }
        let old = self.rx[at].handle;
        if old > 0 && self.rx[at].handleNode.is_some() && Rc::ptr_eq(self.rx[at].handleNode.as_ref().unwrap(), &node) && self.ext.borrow().map.contains_key(&old) {
            return old.to_string();
        }
        if old > 0 {
            self.ext.borrow_mut().map.remove(&old);
        }
        self.handleN += 1;
        let h = self.handleN;
        self.ext.borrow_mut().map.insert(h, node.clone());
        let r2 = &mut self.rx[at];
        r2.handle = h;
        r2.handleNode = Some(node);
        h.to_string()
    }

    // ---- matching

    fn query(&mut self, id: i64, pe: &str) -> String {
        self.queries += 1;
        let mut hl: Vec<usize> = Vec::new();
        let mut cl: Vec<usize> = Vec::new();
        let r = self.queryList(id, pe, &mut hl, &mut cl, false);
        if r == 0 {
            return "?".to_string();
        }
        let mut hits = String::new();
        for &h in hl.iter() {
            if !hits.is_empty() {
                hits.push(',');
            }
            hits.push_str(&h.to_string());
        }
        hits.push('|');
        let mut check = String::new();
        for &c in cl.iter() {
            if !check.is_empty() {
                check.push(',');
            }
            check.push_str(&c.to_string());
        }
        hits.push_str(&check);
        hits
    }

    /// the rules that match element id (or its ::pe) in hits, those left
    /// to webapi.js in check; 0 when it was not told of the element
    fn queryList(&mut self, id: i64, pe: &str, hits: &mut Vec<usize>, check: &mut Vec<usize>, states: bool) -> i64 {
        let at = match self.slot.get(&id) {
            Some(&k) => k,
            None => 0,
        };
        if !self.hasRules || at == 0 || !self.els[at].known {
            return 0;
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
                    return 1;
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
        for &r in cand.iter() {
            if set.flags[r] & 1 == 0 {
                continue;
            }
            let sel = set.rules[r].clone();
            if sel.js || (sel.state && !states) {
                check.push(r);
                continue;
            }
            if self.matchSel(at, &sel) {
                hits.push(r);
            }
        }
        1
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

    /// whether slot at is the element id or one of its ancestors
    fn inChain(&self, at: usize, id: i64) -> bool {
        if id <= 0 {
            return false;
        }
        let mut q = match self.slot.get(&id) {
            Some(&k) => k,
            None => 0,
        };
        let mut guard = 0;
        while q != 0 && guard < 100000 {
            if q == at {
                return true;
            }
            q = self.els[q].pslot;
            guard += 1;
        }
        false
    }

    /// the slots of id and its ancestors
    fn chainOf(&self, id: i64) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        if id <= 0 {
            return out;
        }
        let mut q = match self.slot.get(&id) {
            Some(&k) => k,
            None => 0,
        };
        while q != 0 && out.len() < 100000 {
            out.push(q);
            q = self.els[q].pslot;
        }
        out
    }

    /// W: the hovered, active and focused elements (0 none) and whether the
    /// focus is visible; what came in or out of their chains styled again
    fn setStates(&mut self, h: i64, a: i64, fo: i64, fv: bool) {
        let olds = vec![self.chainOf(self.stHover), self.chainOf(self.stActive), self.chainOf(self.stFocus)];
        let fvWas = self.stFv;
        let focusWas = self.stFocus;
        self.stHover = h;
        self.stActive = a;
        self.stFocus = fo;
        self.stFv = fv;
        let news = vec![self.chainOf(h), self.chainOf(a), self.chainOf(fo)];
        let mut hit: Vec<usize> = Vec::new();
        let mut i = 0;
        while i < 3 {
            for &k in olds[i].iter() {
                if !news[i].contains(&k) && !hit.contains(&k) {
                    hit.push(k);
                }
            }
            for &k in news[i].iter() {
                if !olds[i].contains(&k) && !hit.contains(&k) {
                    hit.push(k);
                }
            }
            i += 1;
        }
        if fvWas != fv && focusWas == fo {
            if let Some(&k) = self.slot.get(&fo) {
                hit.push(k);
            }
        }
        if hit.is_empty() {
            return;
        }
        self.rxTick += 1;
        for &k in hit.iter() {
            self.rxDirtyDown(k);
            self.rxTouchUp(k);
        }
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
        if pc >= P_FOCUS && pc <= P_ACTIVE {
            if pc == P_HOVER {
                return self.inChain(at, self.stHover);
            }
            if pc == P_ACTIVE {
                return self.inChain(at, self.stActive);
            }
            if pc == P_FOCUS_WITHIN {
                return self.inChain(at, self.stFocus);
            }
            let f = match self.slot.get(&self.stFocus) {
                Some(&k) => k,
                None => 0,
            };
            return f == at && f != 0 && (pc == P_FOCUS || self.stFv);
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
    let mut sel = Sel { parts: Vec::new(), js: false, need: vec![0, 0, 0, 0], state: false };
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
            if (it.pc >= P_FOCUS && it.pc <= P_ACTIVE) || it.list.iter().any(|x| x.state) {
                sel.state = true;
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
            "focus" => P_FOCUS,
            "focus-visible" => P_FOCUS_VISIBLE,
            "focus-within" => P_FOCUS_WITHIN,
            "hover" => P_HOVER,
            "active" => P_ACTIVE,
            "has" | "scope" | "empty" | "checked" | "indeterminate" | "disabled" | "enabled" | "read-only" | "read-write" | "placeholder-shown" | "valid" | "invalid" | "in-range" | "out-of-range" | "lang" | "modal" | "popover-open" | "state" | "host" | "host-context" => P_JS,
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

/// an inline value rxPatch takes: none that depends on more than the
/// element's own font size (webapi.js patchedStyle's checks)
fn rx_patchable(v: &str) -> bool {
    if v.is_empty() || v.contains('%') || v.contains("var(") || v.contains("calc(") {
        return false;
    }
    let l = v.to_lowercase();
    if l == "inherit" || l == "initial" || l == "unset" || l == "revert" || l == "revert-layer" || l.contains("currentcolor") {
        return false;
    }
    for u in ["ch", "ex", "cap", "ic", "lh", "rlh", "vw", "vh", "vmin", "vmax", "rem"].iter() {
        if l.contains(u) {
            return false;
        }
    }
    true
}
