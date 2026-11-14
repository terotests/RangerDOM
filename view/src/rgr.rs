//! EVG's classes the view uses. cargo takes them from the rangerevg crate;
//! Ranger reads the files below (`cfg(any())` is never on for rustc, and
//! Ranger reads it).

#[allow(dead_code, unused, non_snake_case, clippy::all)]
mod rgr {
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGBox");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGCodepoint");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGColor");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGCssExtra");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGElement");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGLayout");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGLayoutFull");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGTextEngine");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGTextMeasurer");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/EVGUnit");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/SVGPathParser");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/SvgParser");
    #[cfg(any())]
    ranger::import_rgr!("../../../lib/evg/VectorViewBox");
}
#[cfg(not(ranger))]
pub use rangerevg::{EVGBox, EVGCodepoint, EVGColor, EVGCssExtra, EVGElement, EVGLayout, EVGLayoutFull, EVGTextEngine, EVGTextLine, EVGTextMetrics, EVGUnit, Matrix2D, PathBounds, SvgDocument, SvgParser, VectorViewBox};
