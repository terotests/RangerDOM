//! JsonText.rgr, the parser's string operations in the target's own units.
//! A cargo build includes the Rust module build.rs writes for it.

#[allow(dead_code, unused, non_snake_case)]
mod m {
    ranger::import_rgr!("JsonText");
}
pub use m::JsonText;
