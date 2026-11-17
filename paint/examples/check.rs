// cargo run --release --example check -- <a .ttf>
fn main() {
    let path = std::env::args().nth(1).unwrap_or("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf".to_string());
    let face = std::fs::read(&path).unwrap_or_default();
    println!("{}", rangerdom_paint::PaintCheck::run(face));
}
