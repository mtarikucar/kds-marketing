//! What a device shows: the screen distilled to a list of elements, not a tree.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The most elements one observation carries; a longer screen is cut and marked `truncated`.
pub const MAX_ELEMENTS: usize = 300;

/// A look at the screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observation {
    pub screen: Screen,
    /// The package or bundle id of the app in front, when the device says.
    pub foreground_app: Option<String>,
    pub elements: Vec<Element>,
    /// More than [`MAX_ELEMENTS`] elements were on screen and the rest were left out.
    pub truncated: bool,
    /// The screenshot taken with the observation, as a Jeeta file.
    pub screenshot_file_id: Option<Uuid>,
}

/// The screen's size in pixels and its rotation in degrees.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Screen {
    pub w: u32,
    pub h: u32,
    pub rotation: u16,
}

/// One thing on screen. Bounds are `[left, top, right, bottom]` and the tap point is `[x, y]`,
/// both in screen pixels.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Element {
    pub text: Option<String>,
    pub id: Option<String>,
    pub desc: Option<String>,
    pub class: Option<String>,
    pub bounds: [u32; 4],
    pub tap_point: [u32; 2],
    pub clickable: bool,
    pub editable: bool,
    pub focused: bool,
}
