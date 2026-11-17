//! Snapshot check, natively: a case's steps run once straight through, and
//! once with the page saved after step `at` and loaded into a new
//! playground before the next step. Both runs must answer every step the
//! same (the case's probes). Prints the snapshot's size and the times to
//! take it, load it and draw the first frame after it.
//!
//!   cargo run --release --example snapcheck -- playground/dist/cases/<case> [at]
use rangerdom_pg::Playground;
use std::time::Instant;

fn step(pg: &mut Playground, call: &str) -> String {
    pg.value(&format!("window.__pgDone=''; ({}).then(function(r){{__pgDone=JSON.stringify(r)}})", call));
    let mut i = 0;
    while i < 400 && pg.value("__pgDone").is_empty() {
        pg.tick(16.0);
        if pg.dirty() { pg.render(); pg.layout(); pg.paint(); }
        i += 1;
    }
    if pg.dirty() { pg.render(); pg.layout(); pg.paint(); }
    let r = pg.value("__pgDone");
    probe_of(&r)
}
/// what a step's answer says about the page (its probe and error), not
/// its timings
fn probe_of(s: &str) -> String {
    let err = s.find("\"error\":").map(|k| { let t = &s[k..]; t[..t.find(",\"probe\"").unwrap_or(t.len())].to_string() }).unwrap_or_default();
    let probe = s.find("\"probe\":").map(|k| s[k..].to_string()).unwrap_or_else(|| s.to_string());
    format!("{} {}", err, probe)
}
fn load(dir: &str) -> Playground {
    let html = std::fs::read_to_string(format!("{}/index.html", dir)).unwrap();
    let mut pg = Playground::new();
    let base = "http://x/c/";
    for cap in html.split("<script src=\"").skip(1) {
        let src = &cap[..cap.find('"').unwrap()];
        pg.add_script(&format!("{}{}", base, src), &std::fs::read_to_string(format!("{}/{}", dir, src)).unwrap());
        if let Ok(u) = std::fs::read_to_string(format!("{}/{}.unit", dir, src)) { pg.add_unit(&format!("{}{}", base, src), &u); }
    }
    pg.start(&html, &format!("{}index.html", base), 1200.0, 800.0);
    pg.run_scripts();
    pg.render(); pg.layout(); pg.paint();
    pg
}
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = &a[1];
    let at: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(5);
    // straight through
    let mut pg = load(dir);
    let s = step(&mut pg, "__bench.start()");
    let _ = s;
    let n = 200;
    if std::env::var("SNAP_DEBUG").is_ok() { println!("start: {}", &s.chars().take(400).collect::<String>()); }
    let mut straight = Vec::new();
    for k in 0..n { let r = step(&mut pg, &format!("__bench.run({})", k)); if r.contains("no step") { if std::env::var("SNAP_DEBUG").is_ok() { println!("stop at {}: {}", k, &r.chars().take(300).collect::<String>()); } break; } straight.push(r); }
    // saved after step `at`, loaded into a new playground
    let mut pg = load(dir);
    step(&mut pg, "__bench.start()");
    let mut again = Vec::new();
    for k in 0..straight.len() {
        again.push(step(&mut pg, &format!("__bench.run({})", k)));
        if k == at {
            let t = Instant::now();
            let snap = pg.snapshot();
            let take = t.elapsed().as_secs_f64() * 1e3;
            drop(pg);
            let t = Instant::now();
            let mut fresh = Playground::new();
            let ok = fresh.restore(&snap);
            let restore = t.elapsed().as_secs_f64() * 1e3;
            let t = Instant::now();
            fresh.render(); fresh.layout(); fresh.paint();
            let frame = t.elapsed().as_secs_f64() * 1e3;
            println!("snapshot after step {}: {} KB, take {:.0} ms, restore {:.0} ms ({}), first frame {:.0} ms", at, snap.len() / 1024, take, restore, if ok { "ok" } else { "FAILED" }, frame);
            if !ok { std::process::exit(1); }
            pg = fresh;
        }
    }
    let mut diff = 0;
    for k in 0..straight.len() {
        if straight[k] != again[k] {
            diff += 1;
            println!("step {} differs:\n  straight {}\n  restored {}", k, &straight[k].chars().take(300).collect::<String>(), &again[k].chars().take(300).collect::<String>());
        }
    }
    println!("{} steps, {} differ", straight.len(), diff);
    if diff > 0 { std::process::exit(1); }
}
