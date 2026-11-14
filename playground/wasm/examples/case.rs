use rangerdom_pg::Playground;
use std::time::Instant;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = &a[1];
    let steps: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(99);
    let html = std::fs::read_to_string(format!("{}/index.html", dir)).unwrap();
    let mut pg = Playground::new();
    let base = "http://x/c/";
    for cap in html.split("<script src=\"").skip(1) {
        let src = &cap[..cap.find('"').unwrap()];
        pg.add_script(&format!("{}{}", base, src), &std::fs::read_to_string(format!("{}/{}", dir, src)).unwrap());
    }
    let t = Instant::now();
    pg.start(&html, &format!("{}index.html", base), 1200.0, 800.0);
    println!("start {:?}", t.elapsed());
    let t = Instant::now();
    pg.run_scripts();
    println!("scripts {:?}", t.elapsed());
    let mut acc = [0f64; 3];
    let mut draw = |pg: &mut Playground, acc: &mut [f64; 3]| {
        let t = Instant::now(); pg.render(); acc[0] += t.elapsed().as_secs_f64() * 1e3;
        let t = Instant::now(); pg.layout(); acc[1] += t.elapsed().as_secs_f64() * 1e3;
        let t = Instant::now(); pg.paint(); acc[2] += t.elapsed().as_secs_f64() * 1e3;
    };
    draw(&mut pg, &mut acc);
    let mut run = |pg: &mut Playground, call: &str| -> String {
        let mut acc = [0f64; 3];
        let t = Instant::now();
        pg.value(&format!("window.__pgDone=''; ({}).then(function(r){{__pgDone=JSON.stringify(r)}})", call));
        let mut i = 0;
        while i < 400 && pg.value("__pgDone").is_empty() { pg.tick(16.0); if pg.dirty() { draw(pg, &mut acc); } i += 1; }
        if pg.dirty() { draw(pg, &mut acc); }
        let r = pg.value("__pgDone");
        println!("{:<60} total {:.0} ms render {:.0} layout {:.0} paint {:.0}", &r.chars().take(60).collect::<String>(), t.elapsed().as_secs_f64() * 1e3, acc[0], acc[1], acc[2]);
        r
    };
    let s = run(&mut pg, "__bench.start()");
    let n = s.matches("\",\"").count() + 1;
    for k in 0..n.min(steps) { run(&mut pg, &format!("__bench.run({})", k)); }
}
