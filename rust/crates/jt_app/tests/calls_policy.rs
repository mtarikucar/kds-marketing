//! The call policy at its input boundary: the texts the owner approved are a person's to change
//! (an agent reads them), and a body's unknown keys are refused at any depth.
mod support;

use jt_app::usecases::calls::PlaceInput;
use serde_json::json;

#[test]
fn a_place_body_refuses_a_field_the_plan_does_not_have() {
    let plan = json!({
        "opening": "Ada Hanım ile mi görüşüyorum?", "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."], "max_duration_s": 60, "spoken_by": "x",
    });
    let e = serde_json::from_value::<PlaceInput>(
        json!({ "purpose": "service", "mode": "agent", "plan": plan }),
    )
    .unwrap_err()
    .to_string();
    assert!(e.contains("unknown field `plan.spoken_by`"), "{e}");
}
