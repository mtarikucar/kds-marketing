//! What a plan must look like on each ad platform (design 2026-11-11 B63 to B66).
//!
//! A campaign runs on one platform, the one its ad account is of. The campaign itself (a goal, a
//! total budget, a start and an end, one plan, Jeeta building it paused first) is the same on
//! every platform; what an ad carries is not: a Meta ad shows an image under a Page's name, a
//! Google search ad is a handful of headlines and descriptions answering searches. This table says
//! which fields of the one plan each platform takes, how long its texts may be and how long a
//! campaign may run there. A plan is held against its platform's row before anything is read or
//! sent: a field the platform does not take is refused naming the field, never dropped.
//!
//! What the platform's API then needs to build that plan is its adapter's business, behind
//! `AdCampaignWriter`.
use crate::ports::ads::AdsPlatform;
use serde::Serialize;

/// A list of texts a plan carries: how many, and how long each may be.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct TextList {
    pub min: usize,
    pub max: usize,
    pub chars: usize,
}

/// One platform's row. `None` and `false` mean "not taken on this platform".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct PlatformRules {
    pub platform: AdsPlatform,
    /// The capability kind of the platform's ad accounts.
    pub account_kind: &'static str,
    /// The capability kind of the account an ad speaks as (`page`).
    pub page_kind: Option<&'static str>,
    pub instagram: bool,
    /// Whether an ad shows one image (`material_ids`).
    pub image: bool,
    /// The longest `primary_text`, `headline` and `description` (the last is optional where
    /// taken).
    pub primary_text: Option<usize>,
    pub headline: Option<usize>,
    pub description: Option<usize>,
    /// The values `call_to_action` may take; empty: no call to action.
    pub calls_to_action: &'static [&'static str],
    /// A search ad's `headlines` and `descriptions`.
    pub headlines: Option<TextList>,
    pub descriptions: Option<TextList>,
    /// The plan's `keywords`.
    pub keywords: Option<TextList>,
    /// Whether the campaign may collect leads with the platform's own form (`lead_form`); every
    /// platform takes `link_click`.
    pub lead_form: bool,
    /// Whether the audience may be narrowed by age and gender.
    pub audience_age_and_gender: bool,
    /// Whether the audience may name regions, cities and interests (each platform has its own
    /// keys for them: only Meta's are known here).
    pub audience_places_and_interests: bool,
    /// Whether the audience may be left to the platform (`broad`).
    pub broad_audience: bool,
    /// Whether `placements` may name platforms; else it is `automatic`.
    pub placements: bool,
    /// The shortest and the longest a campaign may run on this platform.
    pub min_run_hours: i64,
    pub max_run_days: i64,
    /// Whether the platform says it never spends more than the campaign's total budget. Where it
    /// does not, Jeeta's own watch is what stops the campaign at its budget.
    pub hard_budget_cap: bool,
    /// How often the platform is asked how a running campaign stands.
    pub watch_minutes: i64,
    /// Whether the platform shows how an ad will look (`ads.ad_preview`).
    pub preview: bool,
    /// Whether no two ads of a campaign may say the same. On a platform where an ad has no
    /// name, what it says is the only thing it is known by: the build finds an ad it already
    /// made by its texts, and two ads saying the same could not be told apart.
    pub distinct_ads: bool,
}

/// The calls to action a Meta ad takes.
pub(crate) const META_CALLS_TO_ACTION: &[&str] = &[
    "LEARN_MORE",
    "SIGN_UP",
    "SHOP_NOW",
    "CONTACT_US",
    "GET_QUOTE",
    "SUBSCRIBE",
    "APPLY_NOW",
    "BOOK_NOW",
    "DOWNLOAD",
];

/// Meta: one image under a Page's name, with a call to action; a link or a lead form.
const META: PlatformRules = PlatformRules {
    platform: AdsPlatform::Meta,
    account_kind: "meta_ads",
    page_kind: Some("facebook_page"),
    instagram: true,
    image: true,
    primary_text: Some(1000),
    headline: Some(100),
    description: Some(100),
    calls_to_action: META_CALLS_TO_ACTION,
    headlines: None,
    descriptions: None,
    keywords: None,
    lead_form: true,
    audience_age_and_gender: true,
    audience_places_and_interests: true,
    broad_audience: true,
    placements: true,
    min_run_hours: 24,
    max_run_days: 90,
    hard_budget_cap: true,
    watch_minutes: 60,
    preview: true,
    distinct_ads: false,
};

/// Google: a responsive search ad (B68). No image and no Page; three to 15 headlines and two to
/// four descriptions
/// (<https://developers.google.com/google-ads/api/docs/responsive-search-ads/overview>), a
/// headline at most 30 characters and a description at most 90
/// (<https://support.google.com/google-ads/answer/7684791>); the audience is the searches the
/// keywords match, in the plan's countries; a keyword is "at most 80 characters and 10 words"
/// (<https://developers.google.com/google-ads/api/reference/rpc/v26/KeywordInfo>). A campaign with
/// a total budget runs 3 to 90 days
/// (<https://developers.google.com/google-ads/api/docs/campaigns/budgets/create-budgets>), and
/// Google never charges more than that total (<https://support.google.com/google-ads/answer/10486938>).
/// All read 2026-11-11. The adapter gives Google whole days in the account's time zone (the day
/// of the start from midnight, the day of the end to midnight), which can span a day more than
/// the campaign runs: so the longest run here is 89 days, and the shortest, 72 hours, always
/// spans at least Google's three days. An ad has no name at Google, so no two ads of a campaign
/// may say the same (`distinct_ads`).
const GOOGLE: PlatformRules = PlatformRules {
    platform: AdsPlatform::Google,
    account_kind: "google_ads",
    page_kind: None,
    instagram: false,
    image: false,
    primary_text: None,
    headline: None,
    description: None,
    calls_to_action: &[],
    headlines: Some(TextList {
        min: 3,
        max: 15,
        chars: 30,
    }),
    descriptions: Some(TextList {
        min: 2,
        max: 4,
        chars: 90,
    }),
    keywords: Some(TextList {
        min: 1,
        max: 20,
        chars: 80,
    }),
    lead_form: false,
    audience_age_and_gender: false,
    audience_places_and_interests: false,
    broad_audience: false,
    placements: false,
    min_run_hours: 72,
    max_run_days: 89,
    hard_budget_cap: true,
    watch_minutes: 60,
    preview: false,
    distinct_ads: true,
};

/// The most words a keyword carries.
pub(crate) const MAX_KEYWORD_WORDS: usize = 10;

/// The row of `platform`.
pub fn rules(platform: AdsPlatform) -> &'static PlatformRules {
    match platform {
        AdsPlatform::Meta => &META,
        AdsPlatform::Google => &GOOGLE,
    }
}

/// The row of the platform whose ad accounts are of capability kind `kind_key`, if one is.
pub fn rules_of_kind(kind_key: &str) -> Option<&'static PlatformRules> {
    AdsPlatform::of_kind(kind_key).map(rules)
}

/// Every platform's row, in the order of [`AdsPlatform::all`].
pub fn all_rules() -> Vec<&'static PlatformRules> {
    AdsPlatform::all().iter().map(|p| rules(*p)).collect()
}
