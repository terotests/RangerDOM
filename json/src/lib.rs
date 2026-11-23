// SPDX-License-Identifier: MIT
//! RangerDOM's JSON: the page a host gets from `__render()` as a tree
//! (JsonValue, JsonParser), and the index searches of text the view uses
//! (DomText). A crate of its own, so that a host's other JSON is the same
//! type as the page's.

#![allow(non_snake_case)]

mod json;
mod rgr;
pub mod text;

pub use json::{JsonMemo, JsonNodes, JsonParser, JsonValue};
pub use text::DomText;
