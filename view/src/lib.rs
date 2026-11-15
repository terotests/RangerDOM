// SPDX-License-Identifier: MIT
//! RangerDOM's view: a page's render tree (`__render()`, rangerdom_json) as
//! EVG elements, laid out and drawn by EVG on any host Ranger targets (SDL,
//! Kotlin, Go and Rust WASM, EVGBrowser). DomView builds the tree, DomMemo
//! keeps the elements of the parts of the page that did not change between
//! frames (with their layout, EVGElement.keepLayout), DomSvgDocs holds the
//! parsed SVG pictures and DomPngs the canvas bitmaps a host decodes.
//! DomPage is a host's whole side of a changing page: delta render trees
//! put together, the kept elements, the boxes back to the page.

#![allow(non_snake_case)]

mod dom_page;
mod dom_view;
mod rgr;

#[cfg(not(ranger))]
pub use dom_view::{DomBoxes, DomFrame, DomMemo, DomPngs, DomSeg, DomSvgDocs, DomView};
#[cfg(not(ranger))]
pub use dom_page::DomPage;
