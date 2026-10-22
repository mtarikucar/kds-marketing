//! Strict parsing at the write boundary.
//!
//! The stored types read tolerantly (unknown fields ignored, missing ones defaulted), so a value
//! an owner or an agent writes is checked here first: every key the target struct does not have
//! is reported, at any depth, together with any type error, as [`Gap`]s with dotted paths; so is
//! a budget lane without its `lane` or `period` (a default would silently pick one), and a text
//! longer than its cap ([`MAX_SECTION_TEXT_CHARS`], [`MAX_SECTION_NAME_CHARS`],
//! [`MAX_PROHIBITION_CHARS`]). Any other missing field is not an error here; it reads as empty
//! and [`crate::validate_sections`] reports it as a completeness gap. Reading what is stored
//! stays tolerant: none of these checks applies to it.

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::hypothesis::HypothesisInput;
use crate::rules::Gap;
use crate::sections::{
    BudgetFrame, Cadence, ChannelChoice, Goals, Identity, Kpi, Lane, Mix, Sections, Segment,
};

/// The parsed payload of one section, as written under its key.
#[derive(Clone, Debug, PartialEq)]
pub enum SectionValue {
    Identity(Identity),
    Audience(Vec<Segment>),
    Channels(Vec<ChannelChoice>),
    Goals(Goals),
    BudgetFrame(BudgetFrame),
    Prohibitions(Vec<String>),
    Cadence(Cadence),
    PaidEnabled(bool),
}

impl SectionValue {
    /// The section's key, one of [`Sections::KEYS`].
    pub fn key(&self) -> &'static str {
        match self {
            SectionValue::Identity(_) => "identity",
            SectionValue::Audience(_) => "audience",
            SectionValue::Channels(_) => "channels",
            SectionValue::Goals(_) => "goals",
            SectionValue::BudgetFrame(_) => "budget_frame",
            SectionValue::Prohibitions(_) => "prohibitions",
            SectionValue::Cadence(_) => "cadence",
            SectionValue::PaidEnabled(_) => "paid_enabled",
        }
    }

    /// Replaces that section of `sections` with this value.
    pub fn apply(self, sections: &mut Sections) {
        match self {
            SectionValue::Identity(v) => sections.identity = v,
            SectionValue::Audience(v) => sections.audience = v,
            SectionValue::Channels(v) => sections.channels = v,
            SectionValue::Goals(v) => sections.goals = v,
            SectionValue::BudgetFrame(v) => sections.budget_frame = v,
            SectionValue::Prohibitions(v) => sections.prohibitions = v,
            SectionValue::Cadence(v) => sections.cadence = v,
            SectionValue::PaidEnabled(v) => sections.paid_enabled = v,
        }
    }
}

/// The longest identity field (`product`, `voice`, `positioning`, `usp`), channel rationale,
/// segment description or goal objective a write takes, in characters.
pub const MAX_SECTION_TEXT_CHARS: usize = 2_000;

/// The longest name a write takes, in characters: a segment's key and name, a KPI's name and
/// target, a channel (chosen or in the mix) and a lane's currency.
pub const MAX_SECTION_NAME_CHARS: usize = 200;

/// The longest prohibition a write takes, in characters.
pub const MAX_PROHIBITION_CHARS: usize = 500;

/// The JSON shape of a written value, for finding unknown and missing keys and over-long texts.
enum Shape {
    /// A scalar; only its type can be wrong, which the deserialiser reports.
    Leaf,
    /// A string of at most this many characters (a value of another type is the deserialiser's
    /// to report).
    Text(usize),
    /// An object with exactly `keys`, of which `required` must be present; `fields` names the
    /// keys whose values are checked further.
    Object {
        keys: &'static [&'static str],
        required: &'static [&'static str],
        fields: &'static [(&'static str, Shape)],
    },
    /// An array whose items all have one shape.
    List(&'static Shape),
}

const TEXT: Shape = Shape::Text(MAX_SECTION_TEXT_CHARS);
const NAME: Shape = Shape::Text(MAX_SECTION_NAME_CHARS);

const IDENTITY: Shape = Shape::Object {
    keys: Identity::KEYS,
    required: &[],
    fields: &[
        ("product", TEXT),
        ("voice", TEXT),
        ("positioning", TEXT),
        ("usp", TEXT),
    ],
};
const SEGMENT: Shape = Shape::Object {
    keys: Segment::KEYS,
    required: &[],
    fields: &[("key", NAME), ("name", NAME), ("description", TEXT)],
};
const CHANNEL_CHOICE: Shape = Shape::Object {
    keys: ChannelChoice::KEYS,
    required: &[],
    fields: &[("channel", NAME), ("rationale", TEXT)],
};
const KPI: Shape = Shape::Object {
    keys: Kpi::KEYS,
    required: &[],
    fields: &[("name", NAME), ("target", NAME)],
};
const GOALS: Shape = Shape::Object {
    keys: Goals::KEYS,
    required: &[],
    fields: &[("objective", TEXT), ("kpis", Shape::List(&KPI))],
};
const LANE: Shape = Shape::Object {
    keys: Lane::KEYS,
    // Read tolerantly, a missing lane is organic and a missing period monthly; written, the
    // owner says which.
    required: &["lane", "period"],
    fields: &[("currency", NAME)],
};
const BUDGET_FRAME: Shape = Shape::Object {
    keys: BudgetFrame::KEYS,
    required: &[],
    fields: &[("lanes", Shape::List(&LANE))],
};
const MIX: Shape = Shape::Object {
    keys: Mix::KEYS,
    required: &[],
    fields: &[("channel", NAME)],
};
const CADENCE: Shape = Shape::Object {
    keys: Cadence::KEYS,
    required: &[],
    fields: &[("channel_mix", Shape::List(&MIX))],
};
const PROHIBITION: Shape = Shape::Text(MAX_PROHIBITION_CHARS);
const HYPOTHESIS_INPUT: Shape = Shape::Object {
    keys: HypothesisInput::KEYS,
    required: &[],
    fields: &[],
};

/// Parses the value written for the section `key` (one of [`Sections::KEYS`]), refusing every
/// unknown key at any depth, a budget lane without its `lane` or `period`, and a text over its
/// cap. On refusal the gaps name each problem by its dotted path: an unknown key
/// (`budget_frame.lanes[1].note`, message `unknown field`), a missing one
/// (`budget_frame.lanes[0].period`, `required field`), an over-long text (`identity.product`,
/// `prohibitions[2]`: `at most N characters, got M`); then any type error under the section's
/// key. An unknown section is one gap under `key`.
pub fn parse_section_strict(key: &str, value: &Value) -> Result<SectionValue, Vec<Gap>> {
    match key {
        "identity" => strict(value, &IDENTITY, key).map(SectionValue::Identity),
        "audience" => strict(value, &Shape::List(&SEGMENT), key).map(SectionValue::Audience),
        "channels" => strict(value, &Shape::List(&CHANNEL_CHOICE), key).map(SectionValue::Channels),
        "goals" => strict(value, &GOALS, key).map(SectionValue::Goals),
        "budget_frame" => strict(value, &BUDGET_FRAME, key).map(SectionValue::BudgetFrame),
        "prohibitions" => {
            strict(value, &Shape::List(&PROHIBITION), key).map(SectionValue::Prohibitions)
        }
        "cadence" => strict(value, &CADENCE, key).map(SectionValue::Cadence),
        "paid_enabled" => strict(value, &Shape::Leaf, key).map(SectionValue::PaidEnabled),
        _ => Err(vec![Gap {
            field: key.to_owned(),
            message: format!(
                "unknown section; expected one of {}",
                Sections::KEYS.join(", ")
            ),
        }]),
    }
}

/// Parses a written list of hypotheses, refusing every unknown key as
/// [`parse_section_strict`] does; paths are `hypotheses[i].<key>`, matching
/// [`crate::validate_for_approval`].
pub fn parse_hypotheses_strict(value: &Value) -> Result<Vec<HypothesisInput>, Vec<Gap>> {
    strict(value, &Shape::List(&HYPOTHESIS_INPUT), "hypotheses")
}

/// Deserialises `value` as `T`, failing with every shape gap under `path` and any type error.
fn strict<T: DeserializeOwned>(value: &Value, shape: &Shape, path: &str) -> Result<T, Vec<Gap>> {
    let mut gaps = Vec::new();
    shape_gaps(value, shape, path, &mut gaps);
    match T::deserialize(value) {
        Ok(parsed) if gaps.is_empty() => Ok(parsed),
        Ok(_) => Err(gaps),
        Err(e) => {
            gaps.push(Gap {
                field: path.to_owned(),
                message: e.to_string(),
            });
            Err(gaps)
        }
    }
}

/// Adds a gap for every way `value` departs from `shape`: an object's own unknown keys first
/// (sorted, whatever the map's order), then its missing required keys (in `required` order),
/// then those of its checked keys in `fields` order; a text over its cap. A value of the wrong
/// type is skipped here; the deserialiser reports it.
fn shape_gaps(value: &Value, shape: &Shape, path: &str, gaps: &mut Vec<Gap>) {
    match (shape, value) {
        (
            Shape::Object {
                keys,
                required,
                fields,
            },
            Value::Object(map),
        ) => {
            let mut unknown: Vec<&str> = map
                .keys()
                .map(String::as_str)
                .filter(|k| !keys.contains(k))
                .collect();
            unknown.sort_unstable();
            for key in unknown {
                gaps.push(Gap {
                    field: format!("{path}.{key}"),
                    message: "unknown field".to_owned(),
                });
            }
            for key in required.iter().filter(|k| !map.contains_key(**k)) {
                gaps.push(Gap {
                    field: format!("{path}.{key}"),
                    message: "required field".to_owned(),
                });
            }
            for (key, inner) in *fields {
                if let Some(v) = map.get(*key) {
                    shape_gaps(v, inner, &format!("{path}.{key}"), gaps);
                }
            }
        }
        (Shape::List(item), Value::Array(items)) => {
            for (i, v) in items.iter().enumerate() {
                shape_gaps(v, item, &format!("{path}[{i}]"), gaps);
            }
        }
        (Shape::Text(max), Value::String(text)) => {
            let len = text.chars().count();
            if len > *max {
                gaps.push(Gap {
                    field: path.to_owned(),
                    message: format!("at most {max} characters, got {len}"),
                });
            }
        }
        _ => {}
    }
}
