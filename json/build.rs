// SPDX-License-Identifier: MIT
//
// Writes src/JsonText.rgr as the crate's Rust module (ranger::build, needs
// node and Ranger's rgrc).
fn main() {
    ranger::build::Module::new("src/JsonText.rgr").compile();
}
