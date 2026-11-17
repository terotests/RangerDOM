// SPDX-License-Identifier: MIT
//! RangerDOM's painter: EVG's display list made into triangles, textured
//! quads and clips for a 2D GPU renderer, with text (TrueType read and
//! rasterized here), paths, strokes, shadows and pictures. It calls no
//! graphics API; a host runs its output with SDL3 (playground/native in
//! Rust, EVGBrowser's desktop build in C++, where Ranger compiles this
//! crate). See painter.rs for the output.

#![allow(non_snake_case)]

mod check;
mod painter;
mod raster;
mod rgr;
mod svgpic;
mod ttf;

#[cfg(not(ranger))]
pub use check::PaintCheck;
#[cfg(not(ranger))]
pub use painter::{DlPainter, PaintRgba, PaintTex, OP_CLIP, OP_DRAW, OP_UNCLIP};
#[cfg(not(ranger))]
pub use raster::Raster;
#[cfg(not(ranger))]
pub use ttf::{flatten, TtfContours, TtfFace, TtfRings};
