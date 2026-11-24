//! Social media management (design 2026-11-10 §7): finished content goes out without a person.
//! The module's agent gives each platform version of a content package a time; the existing
//! posting engine plans it, checks it and publishes it. Nothing here publishes by itself.
pub mod accounts;
pub mod approval;
pub mod own_posts;
pub mod ready;
pub mod schedule;
pub use accounts::{account_get, account_pause, accounts_list};
pub use own_posts::{own_post_image, own_posts};
pub use schedule::{version_schedule, versions_waiting};

use serde_json::{Value, json};

/// The input schema of `social.<name>`, as the MCP tool and the panel route take it.
pub fn schema(name: &str) -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    let (properties, required) = match name {
        "version_schedule" => (
            json!({"project_id":uuid,"version_id":uuid,"capability_id":uuid,
                   "publish_at":{"type":"string","format":"date-time"},
                   "request_key":{"type":"string","minLength":1,"maxLength":200}}),
            vec![
                "project_id",
                "version_id",
                "capability_id",
                "publish_at",
                "request_key",
            ],
        ),
        "versions_waiting" | "accounts_list" => (json!({}), vec![]),
        "account_get" => (
            json!({"capability_id":uuid,
                   "from":{"type":["string","null"],"format":"date",
                       "description":"The period's first day (YYYY-MM-DD); 30 days back when left out."},
                   "until":{"type":["string","null"],"format":"date",
                       "description":"The period's last day; today when left out. At most 366 days."}}),
            vec!["capability_id"],
        ),
        "account_pause" => (
            json!({"capability_id":uuid,"paused":{"type":"boolean"},
                   "expected_revision":{"type":"integer","minimum":0}}),
            vec!["capability_id", "paused", "expected_revision"],
        ),
        "own_posts" => (
            json!({"capability_id":uuid,
                   "limit":{"type":["integer","null"],"minimum":1,"maximum":50,
                       "description":"How many posts, newest first; 30 when left out, at most 50."},
                   "cursor":{"type":["string","null"],"minLength":1,"maxLength":512,
                       "description":"The next_cursor of the page before, for the page after it."}}),
            vec!["capability_id"],
        ),
        "own_post_image" => (
            json!({"capability_id":uuid,
                   "post_id":{"type":"string","minLength":1,"maxLength":128,
                       "description":"A post_id of jeeta.social.own_posts."},
                   "index":{"type":"integer","minimum":0,"maximum":19,
                       "description":"A carousel's item, from 0; 0 when left out."}}),
            vec!["capability_id", "post_id"],
        ),
        _ => panic!("unknown social schema"),
    };
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
