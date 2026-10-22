//! Strict parsing at the write boundary.
//!
//! The stored types read tolerantly (unknown fields ignored, missing ones defaulted), so a value
//! an owner or an agent writes is checked here first: every key the target struct does not have
//! is reported, at any depth, together with any type error, as [`Gap`]s with dotted paths. A
//! missing field is not an error here; it reads as empty and [`crate::validate_sections`] reports
//! it as a completeness gap.

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

/// The JSON shape of a written value, for finding unknown keys.
enum Shape {
    /// A scalar; only its type can be wrong, which the deserialiser reports.
    Leaf,
    /// An object with exactly `keys`; `nested` names the keys whose values are walked further.
    Object {
        keys: &'static [&'static str],
        nested: &'static [(&'static str, Shape)],
    },
    /// An array whose items all have one shape.
    List(&'static Shape),
}

const IDENTITY: Shape = Shape::Object {
    keys: Identity::KEYS,
    nested: &[],
};
const SEGMENT: Shape = Shape::Object {
    keys: Segment::KEYS,
    nested: &[],
};
const CHANNEL_CHOICE: Shape = Shape::Object {
    keys: ChannelChoice::KEYS,
    nested: &[],
};
const KPI: Shape = Shape::Object {
    keys: Kpi::KEYS,
    nested: &[],
};
const GOALS: Shape = Shape::Object {
    keys: Goals::KEYS,
    nested: &[("kpis", Shape::List(&KPI))],
};
const LANE: Shape = Shape::Object {
    keys: Lane::KEYS,
    nested: &[],
};
const BUDGET_FRAME: Shape = Shape::Object {
    keys: BudgetFrame::KEYS,
    nested: &[("lanes", Shape::List(&LANE))],
};
const MIX: Shape = Shape::Object {
    keys: Mix::KEYS,
    nested: &[],
};
const CADENCE: Shape = Shape::Object {
    keys: Cadence::KEYS,
    nested: &[("channel_mix", Shape::List(&MIX))],
};
const HYPOTHESIS_INPUT: Shape = Shape::Object {
    keys: HypothesisInput::KEYS,
    nested: &[],
};

/// Parses the value written for the section `key` (one of [`Sections::KEYS`]), refusing every
/// unknown key at any depth. On refusal the gaps name each unknown key by its dotted path
/// (`budget_frame.lanes[1].note`, message `unknown field`), then any type error under the
/// section's key; an unknown section is one gap under `key`.
pub fn parse_section_strict(key: &str, value: &Value) -> Result<SectionValue, Vec<Gap>> {
    match key {
        "identity" => strict(value, &IDENTITY, key).map(SectionValue::Identity),
        "audience" => strict(value, &Shape::List(&SEGMENT), key).map(SectionValue::Audience),
        "channels" => strict(value, &Shape::List(&CHANNEL_CHOICE), key).map(SectionValue::Channels),
        "goals" => strict(value, &GOALS, key).map(SectionValue::Goals),
        "budget_frame" => strict(value, &BUDGET_FRAME, key).map(SectionValue::BudgetFrame),
        "prohibitions" => {
            strict(value, &Shape::List(&Shape::Leaf), key).map(SectionValue::Prohibitions)
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

/// Deserialises `value` as `T`, failing with every unknown key under `path` and any type error.
fn strict<T: DeserializeOwned>(value: &Value, shape: &Shape, path: &str) -> Result<T, Vec<Gap>> {
    let mut gaps = Vec::new();
    unknown_keys(value, shape, path, &mut gaps);
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

/// Adds a gap for every key of `value` that `shape` does not have: an object's own unknown keys
/// first (sorted, whatever the map's order), then those of its walked keys in `nested` order. A
/// value of the wrong type is skipped here; the deserialiser reports it.
fn unknown_keys(value: &Value, shape: &Shape, path: &str, gaps: &mut Vec<Gap>) {
    match (shape, value) {
        (Shape::Object { keys, nested }, Value::Object(map)) => {
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
            for (key, inner) in *nested {
                if let Some(v) = map.get(*key) {
                    unknown_keys(v, inner, &format!("{path}.{key}"), gaps);
                }
            }
        }
        (Shape::List(item), Value::Array(items)) => {
            for (i, v) in items.iter().enumerate() {
                unknown_keys(v, item, &format!("{path}[{i}]"), gaps);
            }
        }
        _ => {}
    }
}
