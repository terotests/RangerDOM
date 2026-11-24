// SPDX-License-Identifier: MIT
//! RangerDOM's style in Rust: the part of webapi.js's CSS cascade a host
//! does for it, whatever engine runs the page. webapi.js tells the host
//! what changed in the page (elements in and out, attributes, the rules of
//! the page's sheets) and asks which rules match an element, all through
//! the one synchronous call every engine RangerDOM runs on gives a page
//! (`__hostSync`, a request starting with U+0001 'S'). DomStyle keeps the
//! elements as the selectors see them and matches; what it is told is
//! rebuilt from the page at any time (a restored snapshot sends it all
//! again), so nothing of it is part of the page's state.

#![allow(non_snake_case)]

mod dom_style;
mod dom_tree;

pub use dom_style::DomStyle;
