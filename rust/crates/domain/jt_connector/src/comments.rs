//! Which comment operations a Meta grant allows (spec 2026-10-30-inbox-comments-marketplace-design.md
//! §5.3), from the scopes stored with the capability's credential. Comments stay off for a
//! capability until its grant holds these permissions: the new permissions are asked for only
//! once the platform's flags are on, after Meta's App Review grants them (spec §2 D11).
//!
//! | Kind / login | read, reply, hide | delete others' | private reply |
//! |---|---|---|---|
//! | `facebook_page` (Page token) | `pages_read_engagement` + `pages_manage_engagement` | + `pages_read_user_content` | + `pages_messaging` |
//! | `instagram` (Facebook Login) | `instagram_manage_comments` | same | + `instagram_manage_messages` |
//! | `instagram` (Instagram Login) | `instagram_business_manage_comments` | same | + `instagram_business_manage_messages` |
//!
//! This table is the design's rule; the exact permission each Graph call needs is VERIFY V-M1
//! (spec §12), checked against Meta's reference before the Meta comment calls merge.

/// The scopes Facebook Login adds to its request when comments are enabled for the platform.
pub const FACEBOOK_COMMENT_SCOPES: &[&str] = &[
    "instagram_manage_comments",
    "pages_manage_engagement",
    "pages_read_user_content",
];

/// The scopes Instagram Login adds to its request when comments are enabled for the platform.
pub const INSTAGRAM_COMMENT_SCOPES: &[&str] = &[
    "instagram_business_manage_comments",
    "instagram_business_manage_messages",
];

/// What a grant allows on a capability's comments.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CommentGrant {
    /// Read comments (webhooks, the backfill poll).
    pub read: bool,
    /// Reply to a comment publicly.
    pub reply: bool,
    /// Hide and unhide a comment.
    pub hide: bool,
    /// Delete other people's comments.
    pub delete_others: bool,
    /// Reply to a comment privately, as a direct message.
    pub private_reply: bool,
}

impl CommentGrant {
    /// Whether comments are on: they can be read and replied to.
    pub fn enabled(&self) -> bool {
        self.read && self.reply
    }
}

/// What `scopes` (as granted, exact and case-sensitive) allow on the comments of a capability of
/// `kind_key` (see the module's table). Every kind but `facebook_page` and `instagram` has no
/// comments: all false.
pub fn comment_grant(kind_key: &str, scopes: &[&str]) -> CommentGrant {
    let has = |scope: &str| scopes.contains(&scope);
    match kind_key {
        "facebook_page" => {
            let engage = has("pages_read_engagement") && has("pages_manage_engagement");
            CommentGrant {
                read: engage,
                reply: engage,
                hide: engage,
                delete_others: engage && has("pages_read_user_content"),
                private_reply: engage && has("pages_messaging"),
            }
        }
        "instagram" => {
            let facebook_login = has("instagram_manage_comments");
            let instagram_login = has("instagram_business_manage_comments");
            let on = facebook_login || instagram_login;
            CommentGrant {
                read: on,
                reply: on,
                hide: on,
                delete_others: on,
                private_reply: (facebook_login && has("instagram_manage_messages"))
                    || (instagram_login && has("instagram_business_manage_messages")),
            }
        }
        _ => CommentGrant::default(),
    }
}
