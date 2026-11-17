// virtcheck <case dir> [steps]: the virtual rows oracle. The case runs in
// two pages, one with virtual rows off (__virtRows(false): every element
// rendered) and one with them on; after each benchmark step, at several
// scroll positions of the document, what is drawn in the viewport, the
// document's scroll height and the boxes of the elements in view must be
// the same in both. Exits 1 on the first difference.
// VC_CSS: a style sheet added to both (`#main{overflow:auto}` makes the
// jsfb cases' frame a scroller); VC_SCROLL: the selector of the box to
// scroll (the page's when unset); VC_EVAL: a value printed after each step.
use rangerdom_pg::Playground;

const W: f64 = 1200.0;
const H: f64 = 800.0;

fn page(dir: &str, virt: bool) -> Playground {
    let html = std::fs::read_to_string(format!("{}/index.html", dir)).unwrap();
    let mut pg = Playground::new();
    let base = "http://x/c/";
    for cap in html.split("<script src=\"").skip(1) {
        let src = &cap[..cap.find('"').unwrap()];
        pg.add_script(&format!("{}{}", base, src), &std::fs::read_to_string(format!("{}/{}", dir, src)).unwrap());
    }
    pg.start(&html, &format!("{}index.html", base), W, H);
    pg.value(&format!("__virtRows({})", virt));
    pg.run_scripts();
    if let Ok(css) = std::env::var("VC_CSS") {
        pg.value(&format!("(function(){{var s=document.createElement('style');s.textContent={:?};document.head.appendChild(s)}})()", css));
    }
    settle(&mut pg);
    pg
}

/// frames until the page has nothing more to draw (a layout can show that
/// the rendered rows do not cover the viewport: rendered again before the
/// paint)
fn settle(pg: &mut Playground) {
    for _ in 0..8 {
        if !pg.dirty() { break; }
        pg.render();
        pg.layout();
    }
}

fn run(pg: &mut Playground, call: &str) -> String {
    pg.value(&format!("window.__pgDone=''; ({}).then(function(r){{__pgDone=JSON.stringify(r)}})", call));
    let mut i = 0;
    while i < 400 && pg.value("__pgDone").is_empty() { pg.tick(16.0); settle(pg); i += 1; }
    settle(pg);
    pg.value("__pgDone")
}

/// the display list's commands that touch the viewport, one per line
fn drawn(pg: &mut Playground) -> Vec<String> {
    let w: f64 = pg.value("innerWidth").parse().unwrap_or(W);
    let h: f64 = pg.value("innerHeight").parse().unwrap_or(H);
    let dl = pg.paint();
    let mut out = Vec::new();
    let Some(i) = dl.find("\"cmds\":[") else { return out };
    let body = &dl[i + 8..];
    // the commands are flat objects: split at "},{" outside strings
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut in_str = false;
    let mut esc = false;
    let b = body.as_bytes();
    for (k, &c) in b.iter().enumerate() {
        if in_str {
            if esc { esc = false; } else if c == b'\\' { esc = true; } else if c == b'"' { in_str = false; }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' | b'[' => { if depth == 0 && c == b'{' { start = k; } depth += 1; }
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 && c == b'}' { out.push(body[start..=k].to_string()); }
                if depth < 0 { break; }
            }
            _ => {}
        }
    }
    let num = |s: &str, key: &str| -> Option<f64> {
        let p = s.find(&format!("\"{}\":", key))? + key.len() + 3;
        let e = s[p..].find(|ch: char| ch == ',' || ch == '}').map(|e| p + e)?;
        s[p..e].parse().ok()
    };
    out.into_iter().filter(|c| {
        match (num(c, "x"), num(c, "y"), num(c, "w"), num(c, "h")) {
            (Some(x), Some(y), Some(cw), Some(ch)) => x < w && y < h && x + cw > 0.0 && y + ch > 0.0,
            _ => true,
        }
    }).collect()
}

// (the rects of the elements in view; a cell or list item out of view is
// not looked into: reading every element of 10 000 rows would render
// each row left out)
const PROBE: &str = "(function(){__syncLayout(1);var de=document.documentElement,out=[de.scrollHeight,de.scrollTop].join(' ');(function walk(e){for(var c=e.firstElementChild;c;c=c.nextElementSibling){var r=c.getBoundingClientRect();if(r.height>0&&(r.bottom<=0||r.top>=innerHeight)&&/^(TD|TH|LI)$/.test(c.tagName))continue;if(r.bottom>0&&r.top<innerHeight&&r.height>0)out+='\\n'+c.tagName+(c.id?'#'+c.id:'')+' '+[r.left,r.top,r.width,r.height].map(function(v){return Math.round(v*100)/100}).join(',');walk(c)}})(document.body);return out})()";

fn compare(a: &mut Playground, b: &mut Playground, at: &str) -> bool {
    let (pa, pb) = (a.value(PROBE), b.value(PROBE));
    let (da, db) = (drawn(a), drawn(b));
    let mut ok = true;
    if pa != pb {
        ok = false;
        let la: Vec<&str> = pa.lines().collect();
        let lb: Vec<&str> = pb.lines().collect();
        let k = (0..la.len().max(lb.len())).find(|&k| la.get(k) != lb.get(k)).unwrap_or(0);
        println!("DIFF {}: boxes (lines {} / {}) first at {}: full {:?} virtual {:?}", at, la.len(), lb.len(), k, la.get(k), lb.get(k));
    }
    if da != db {
        ok = false;
        let k = (0..da.len().max(db.len())).find(|&k| da.get(k) != db.get(k)).unwrap_or(0);
        println!("DIFF {}: drawn ({} / {} commands) first at {}: full {:?} virtual {:?}", at, da.len(), db.len(), k, da.get(k), db.get(k));
    }
    if ok { println!("same {}: {} boxes, {} commands", at, pa.lines().count() - 1, da.len()); }
    ok
}

fn scroll_to(pg: &mut Playground, y: &str) {
    let sel = std::env::var("VC_SCROLL").unwrap_or_default();
    // ("+n" / "-n": by n from where it is)
    let to = if y.starts_with('+') || y.starts_with('-') { format!("de.scrollTop{}", y) } else { y.to_string() };
    pg.value(&format!("(function(){{var de={};de.scrollTop={};return de.scrollTop}})()", if sel.is_empty() { "document.documentElement".to_string() } else { format!("document.querySelector({:?})", sel) }, to));
    // (a script's scroll is drawn at the next frame, with its scroll event)
    pg.tick(16.0);
    settle(pg);
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = &a[1];
    let steps: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(99);
    let mut full = page(dir, false);
    let mut virt = page(dir, true);
    let mut bad = 0;
    let s = run(&mut full, "__bench.start()");
    run(&mut virt, "__bench.start()");
    let n = s.matches("\",\"").count() + 1;
    let ys = ["0", "400", "de.scrollHeight/3", "de.scrollHeight/2+123", "de.scrollHeight-innerHeight-10", "de.scrollHeight", "1000", "0", "20000", "403000", "0"];
    for k in 0..n.min(steps) {
        let r = run(&mut full, &format!("__bench.run({})", k));
        run(&mut virt, &format!("__bench.run({})", k));
        if let Ok(e) = std::env::var("VC_EVAL") { println!("EVAL full {}\nEVAL virt {}", full.value(&e), virt.value(&e)); }
        for y in ys.iter() {
            scroll_to(&mut full, y);
            scroll_to(&mut virt, y);
            if !compare(&mut full, &mut virt, &format!("step {} {} scroll {}", k, &r.chars().take(30).collect::<String>(), y)) { bad += 1; }
        }
        // small steps down and up, as a wheel turns: the rows rendered are
        // kept while they cover the viewport, then move
        for y in ["2000"].iter().chain(["+130"; 14].iter()).chain(["-170"; 8].iter()) {
            scroll_to(&mut full, y);
            scroll_to(&mut virt, y);
            if !compare(&mut full, &mut virt, &format!("step {} {} scroll {}", k, &r.chars().take(30).collect::<String>(), y)) { bad += 1; }
        }
        // the window resized, narrower and lower, and back
        for (rw, rh) in [(760.0, 560.0), (W, H)] {
            // (laid out at the new size even where nothing marks the page
            // changed)
            for pg in [&mut full, &mut virt] { pg.resize(rw, rh); pg.render(); pg.layout(); }
            settle(&mut full);
            settle(&mut virt);
            for y in ["0", "1500", "de.scrollHeight/2"].iter() {
                scroll_to(&mut full, y);
                scroll_to(&mut virt, y);
                if !compare(&mut full, &mut virt, &format!("step {} at {}x{} scroll {}", k, rw, rh, y)) { bad += 1; }
            }
        }
    }
    println!("{}", if bad == 0 { "virtual rows: all the same".to_string() } else { format!("virtual rows: {} differences", bad) });
    if bad > 0 { std::process::exit(1); }
}
