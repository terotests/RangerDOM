//! EVG's classes the painter uses. cargo takes them from the rangerevg
//! crate; Ranger reads the files below (`cfg(any())` is never on for rustc,
//! and Ranger reads it).

#[allow(dead_code, unused, non_snake_case, clippy::all)]
mod rgr {
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGColor");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGDisplayList");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/SVGPathParser");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/SvgParser");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/VectorViewBox");
}
#[cfg(not(ranger))]
pub use rangerevg::{EVGDisplayList, EVGDrawCmd, EVGDrawTile, PathRing, SVGPathParser, SvgDocument, SvgParser, SvgVectorItem, VectorViewBox};
