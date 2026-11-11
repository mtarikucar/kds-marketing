//! Content creation (design 2026-11-10 §6): a production area is worked by an agent from its
//! start time to a checked content package. The server runs no model and produces nothing: it
//! hands the area out, keeps the agent's place, and checks what is delivered.
pub mod areas;
pub mod delivery;
pub use areas::{area_claim, area_progress, area_redo, area_release, open_by_system};
pub use delivery::{area_deliver, delivery_accept};

use crate::ports::production_projects::{
    MAX_CONTENT_TYPE_CHARS, MAX_GOAL_CHARS, MAX_LINK_CHARS, MAX_TAG_CHARS, MAX_TAGS,
    MAX_VERSION_TEXT_CHARS, MAX_VERSION_TITLE_CHARS, MAX_VERSIONS,
};
use serde_json::{Value, json};

/// The input schema of `content.<name>`, as the MCP tool and the panel route take it.
pub fn schema(name: &str) -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    let note = json!({"type":"string","minLength":1,"maxLength":MAX_GOAL_CHARS});
    let token = json!({"type":"string","minLength":1,"maxLength":200});
    let revision = json!({"type":"integer","minimum":1});
    let (mut properties, mut required) = match name {
        "area_claim" => (
            json!({"expected_revision":revision}),
            vec!["expected_revision"],
        ),
        "delivery_accept" => (
            json!({"expected_revision":revision}),
            vec!["expected_revision"],
        ),
        "area_redo" => (
            json!({"package_revision":{"type":["integer","null"],"minimum":1},"note":note}),
            vec!["note"],
        ),
        "area_progress" => (
            json!({"claim_token":token,"step":{"type":"integer","minimum":1,"maximum":14},"note":note}),
            vec!["claim_token", "step", "note"],
        ),
        "area_release" => (
            json!({"claim_token":token,"reason":note}),
            vec!["claim_token", "reason"],
        ),
        "area_deliver" => {
            let version = json!({"type":"object","additionalProperties":false,"properties":{
                "format":{"enum":["story","feed_post","carousel","reel","tiktok_video"],
                    "description":"What kind of post this version is."},
                "capability_id":{"type":["string","null"],"format":"uuid",
                    "description":"The connected social account it is made for; leave out when none is connected or any account may take it."},
                "text":{"type":"string","maxLength":MAX_VERSION_TEXT_CHARS,
                    "description":"The caption as it goes out, without the tags. A story's text never goes out."},
                "title":{"type":["string","null"],"maxLength":MAX_VERSION_TITLE_CHARS,
                    "description":"A headline for the owner's preview and for ads; not part of a post's text."},
                "tags":{"type":"array","maxItems":MAX_TAGS,"items":{"type":"string","minLength":1,"maxLength":MAX_TAG_CHARS},
                    "description":"Hashtags without '#'; appended to the text on a line of their own when the post goes out."},
                "link":{"type":["string","null"],"format":"uri","maxLength":MAX_LINK_CHARS,
                    "description":"A public http(s) address the post links to, on platforms that take one."},
                "material_ids":{"type":"array","minItems":1,"maxItems":jt_studio::MAX_POST_MATERIALS,"uniqueItems":true,"items":uuid,
                    "description":"The area's materials this version shows, in display order (material ids, not file ids)."},
                "hypothesis_id":{"type":"string","format":"uuid",
                    "description":"The hypothesis of the approved strategy (jeeta.strategy.get) this content serves."},
                "content_type":{"type":["string","null"],"maxLength":MAX_CONTENT_TYPE_CHARS,
                    "description":"One of the hypothesis's organic content types, when it names any; otherwise leave out."}
            },"required":["format","text","material_ids","hypothesis_id"]});
            (
                json!({"claim_token":token,
                       "request_key":{"type":"string","minLength":1,"maxLength":200,
                           "description":"Your own key for this delivery: the same key with the same content replays its answer; a corrected delivery takes a new key."},
                       "summary":{"type":"string","minLength":1,"maxLength":MAX_GOAL_CHARS,
                           "description":"A few sentences for the owner on what you made and why, in the workspace's language."},
                       "versions":{"type":"array","minItems":1,"maxItems":MAX_VERSIONS,"items":version}}),
                vec!["claim_token", "request_key", "summary", "versions"],
            )
        }
        _ => panic!("unknown content schema"),
    };
    properties["project_id"] = uuid;
    required.insert(0, "project_id");
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
