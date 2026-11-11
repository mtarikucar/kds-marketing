//! What a plan must look like on each ad platform (design 2026-11-11 B63 to B66).
//!
//! A campaign runs on one platform, the one its ad account is of. The campaign itself (a goal, a
//! total budget, a start and an end, one plan, Jeeta building it paused first) is the same on
//! every platform; what an ad carries is not: a Meta ad shows an image under a Page's name, a
//! Google search ad is a handful of headlines and descriptions answering searches, a LinkedIn ad
//! is an image and a text under the company page of its ad account. This table says
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
    /// The media types the platform takes an ad's image in; empty: any image.
    pub image_types: &'static [&'static str],
    /// Whether the platform refuses emoji in an ad's texts.
    pub no_emoji: bool,
    /// Whether the platform refuses a link written out in an ad's `primary_text` (the ad's own
    /// link element carries the address).
    pub no_link: bool,
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
    image_types: &[],
    no_emoji: false,
    no_link: false,
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
    image_types: &[],
    no_emoji: false,
    no_link: false,
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

/// The calls to action a LinkedIn ad takes: those of Jeeta's list LinkedIn has a button for
/// (`GET_QUOTE` is its `VIEW_QUOTE`, `APPLY_NOW` its `APPLY`; it has none for "contact us" or
/// "book now").
pub(crate) const LINKEDIN_CALLS_TO_ACTION: &[&str] = &[
    "LEARN_MORE",
    "SIGN_UP",
    "SHOP_NOW",
    "GET_QUOTE",
    "SUBSCRIBE",
    "APPLY_NOW",
    "DOWNLOAD",
];

/// LinkedIn: single-image sponsored content. The ad speaks as the company page its ad account
/// advertises for, so a plan names no page. Introductory text at most 3,000 characters, headline
/// at most 200, the image a JPG, a PNG or a GIF
/// (<https://www.linkedin.com/help/lms/answer/a426534>, read 2026-11-11); the description shows
/// only outside LinkedIn's own feed, where these ads do not run, so it is not taken. The
/// audience is the plan's countries: LinkedIn forbids using its targeting to discriminate by
/// age or gender, and this version does not narrow by either. LinkedIn never spends more than a
/// campaign's lifetime budget (<https://www.linkedin.com/help/lms/answer/a422101>). It names
/// its least lifetime budget, which follows the length of the run, only when it refuses one: a
/// budget that is too small is learnt at the build, which then stops with LinkedIn's own words
/// and nothing spent.
const LINKEDIN: PlatformRules = PlatformRules {
    platform: AdsPlatform::Linkedin,
    account_kind: "linkedin_ads",
    page_kind: None,
    instagram: false,
    image: true,
    image_types: &["image/jpeg", "image/png", "image/gif"],
    no_emoji: false,
    no_link: false,
    primary_text: Some(3000),
    headline: Some(200),
    description: None,
    calls_to_action: LINKEDIN_CALLS_TO_ACTION,
    headlines: None,
    descriptions: None,
    keywords: None,
    lead_form: false,
    audience_age_and_gender: false,
    audience_places_and_interests: false,
    broad_audience: false,
    placements: false,
    min_run_hours: 24,
    max_run_days: 90,
    hard_budget_cap: true,
    watch_minutes: 60,
    preview: false,
    distinct_ads: false,
};

/// TikTok: a one-image carousel ad on TikTok itself (B69; a single image alone is not a format of
/// TikTok's own placement). The ad speaks as the TikTok account linked to its ad account, so a
/// plan names no account; the music a carousel needs is the first piece TikTok recommends for the
/// image. One text of at most 100 characters without emoji, an image that is a JPG or a PNG, and
/// a call to action (<https://business-api.tiktok.com/portal/docs?id=1739953377508354>,
/// <https://business-api.tiktok.com/portal/docs?id=1766217791987713>, read 2026-11-11); no
/// headline and no description. The audience is the plan's countries, everyone of 18 and over.
/// A lifetime budget is never exceeded (TikTok's help: "will never exceed the budget you set"),
/// and TikTok's least budgets are the ad account's own limits (`AdAccountLimits`).
const TIKTOK: PlatformRules = PlatformRules {
    platform: AdsPlatform::Tiktok,
    account_kind: "tiktok_ads",
    page_kind: None,
    instagram: false,
    image: true,
    image_types: &["image/jpeg", "image/png"],
    no_emoji: true,
    no_link: false,
    primary_text: Some(100),
    headline: None,
    description: None,
    calls_to_action: META_CALLS_TO_ACTION,
    headlines: None,
    descriptions: None,
    keywords: None,
    lead_form: false,
    audience_age_and_gender: false,
    audience_places_and_interests: false,
    broad_audience: false,
    placements: false,
    min_run_hours: 24,
    max_run_days: 90,
    hard_budget_cap: true,
    watch_minutes: 60,
    preview: false,
    distinct_ads: false,
};

/// X: a promoted-only post of the ads account's own X user that carries a website card (design
/// §3.4). The ad is a text of at most 280 characters, and a card of one image and a title of at
/// most 70 characters that leads to the website; a website card has no button, so there is no
/// call to action, and a plan names no account. The post's text carries no link of its own: X
/// takes a website card or a link in the post, not both. The image is a JPG or a PNG. The
/// audience is the plan's countries. X's pages do not say that a campaign's total budget is
/// never exceeded: `hard_budget_cap` is false, and Jeeta reads a running X campaign every
/// fifteen minutes and pauses it itself when its budget is reached (B67). All read 2026-11-11
/// from X's Ads API documentation.
const X: PlatformRules = PlatformRules {
    platform: AdsPlatform::X,
    account_kind: "x_ads",
    page_kind: None,
    instagram: false,
    image: true,
    image_types: &["image/jpeg", "image/png"],
    no_emoji: false,
    no_link: true,
    primary_text: Some(280),
    headline: Some(70),
    description: None,
    calls_to_action: &[],
    headlines: None,
    descriptions: None,
    keywords: None,
    lead_form: false,
    audience_age_and_gender: false,
    audience_places_and_interests: false,
    broad_audience: false,
    placements: false,
    min_run_hours: 24,
    max_run_days: 90,
    hard_budget_cap: false,
    watch_minutes: 15,
    preview: false,
    distinct_ads: false,
};

/// Whether `text` carries a link written out: an `http://` or `https://` address, or a word
/// that begins with `www.`.
pub(crate) fn has_link(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("http://")
        || lower.contains("https://")
        || lower.split_whitespace().any(|word| {
            word.trim_start_matches(|c: char| !c.is_alphanumeric())
                .starts_with("www.")
        })
}

/// Whether `text` carries an emoji: a character of the pictograph blocks, a variation selector
/// that turns a symbol into one, or the joiner emoji sequences are built with.
pub(crate) fn has_emoji(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(u32::from(c),
            0x1F000..=0x1FAFF      // pictographs, emoticons, transport, flags, supplemental
            | 0x2600..=0x27BF      // miscellaneous symbols and dingbats
            | 0x2B00..=0x2BFF      // stars and arrows used as emoji
            | 0x2300..=0x23FF      // technical symbols used as emoji (watch, hourglass)
            | 0xFE0F               // the emoji variation selector
            | 0x200D               // the zero width joiner
            | 0xE0020..=0xE007F) // tag characters (flag sequences)
    })
}

/// The most words a keyword carries.
pub(crate) const MAX_KEYWORD_WORDS: usize = 10;

/// The row of `platform`.
pub fn rules(platform: AdsPlatform) -> &'static PlatformRules {
    match platform {
        AdsPlatform::Meta => &META,
        AdsPlatform::Google => &GOOGLE,
        AdsPlatform::Linkedin => &LINKEDIN,
        AdsPlatform::Tiktok => &TIKTOK,
        AdsPlatform::X => &X,
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
