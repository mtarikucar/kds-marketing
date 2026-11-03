//! Dedupe keys (spec §3.3): hard keys are unique among live prospects and are the only keys the
//! blocklist hashes; soft keys only raise non-blocking flags. Every key is derived from a stored,
//! already-normalised prospect, so the same business gives the same keys however it was written.

use jt_inbox::{IdentityChannel, normalise};
use serde::{Deserialize, Serialize};

use crate::{Prospect, ProspectError, invalid};

/// The kind of a dedupe key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    /// An E.164 number, or a `tr444:` number ([`normalise_phone`]).
    Phone,
    /// A lower-cased address (`jt_inbox::normalise`).
    Email,
    /// An Instagram handle.
    Instagram,
    /// A TikTok handle.
    Tiktok,
    /// A website host or a business email's domain (soft).
    Domain,
    /// The folded business name and city, `name|city` (soft).
    NameCity,
}

impl KeyKind {
    /// Every kind, hard ones first; the order [`derive_keys`] answers in.
    pub const ALL: &[KeyKind] = &[
        KeyKind::Phone,
        KeyKind::Email,
        KeyKind::Instagram,
        KeyKind::Tiktok,
        KeyKind::Domain,
        KeyKind::NameCity,
    ];

    /// The stable key, as stored (`prospect_keys.kind`, `prospect_blocklist.kind`).
    pub fn key(self) -> &'static str {
        match self {
            KeyKind::Phone => "phone",
            KeyKind::Email => "email",
            KeyKind::Instagram => "instagram",
            KeyKind::Tiktok => "tiktok",
            KeyKind::Domain => "domain",
            KeyKind::NameCity => "name_city",
        }
    }

    /// The kind with this key, if any.
    pub fn parse(key: &str) -> Option<KeyKind> {
        KeyKind::ALL.iter().copied().find(|k| k.key() == key)
    }

    /// Whether the key is unique among live prospects (phone, email and the two handles). Only
    /// hard keys go on the blocklist (do-not-contact, erasure, rejection memory) and only a hard
    /// key's hit refuses a write; a soft key (a shared domain, a name and city) is a flag.
    pub fn hard(self) -> bool {
        matches!(
            self,
            KeyKind::Phone | KeyKind::Email | KeyKind::Instagram | KeyKind::Tiktok
        )
    }
}

/// One dedupe key of a prospect.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Key {
    pub kind: KeyKind,
    pub value: String,
}

/// Mail domains anyone can have an address at: an address there says nothing about which
/// business it is, so it gives no `domain` key.
pub const FREE_MAIL_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "hotmail.com",
    "hotmail.com.tr",
    "outlook.com",
    "outlook.com.tr",
    "live.com",
    "msn.com",
    "windowslive.com",
    "yahoo.com",
    "yahoo.com.tr",
    "ymail.com",
    "yandex.com",
    "yandex.com.tr",
    "yandex.ru",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "mail.com",
    "gmx.com",
    "gmx.net",
    "proton.me",
    "protonmail.com",
    "mynet.com",
];

/// Why a URL's host is not a business's own website. Each kind has the refusal reason a
/// `website` field on it meets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PlatformKind {
    /// A social network's profile: the `instagram` and `tiktok` fields hold the handles.
    SocialProfile,
    /// A link-in-bio page.
    LinkInBio,
    /// A chat link.
    Messaging,
    /// A map listing or a map link.
    MapListing,
    /// A store or listing page of a marketplace or a delivery platform.
    Marketplace,
    /// A link shortener: the host says nothing of where the link leads.
    ShortLink,
    /// A host many unrelated sites or pages share (a site builder's, a search engine's).
    SharedHost,
}

impl PlatformKind {
    /// The `website` field's refusal reason for a URL on this kind of host.
    pub fn reason(self) -> &'static str {
        match self {
            PlatformKind::SocialProfile => "website_is_a_platform_profile",
            PlatformKind::LinkInBio => "website_is_a_link_in_bio_page",
            PlatformKind::Messaging => "website_is_a_messaging_link",
            PlatformKind::MapListing => "website_is_a_map_listing",
            PlatformKind::Marketplace => "website_is_a_marketplace_listing",
            PlatformKind::ShortLink => "website_is_a_short_link",
            PlatformKind::SharedHost => "website_is_a_shared_host",
        }
    }
}

/// Hosts that are never a business's own website, with why: a URL there is a profile, a listing
/// or a link, and the host is shared by everyone on it, so it is never a `domain` key. A host
/// matches when it is one of these or a subdomain of one; the longest match decides the kind.
/// Search and map providers under many country domains are [`PLATFORM_NAMES`].
pub const PLATFORM_HOSTS: &[(&str, PlatformKind)] = &[
    ("instagram.com", PlatformKind::SocialProfile),
    ("facebook.com", PlatformKind::SocialProfile),
    ("fb.com", PlatformKind::SocialProfile),
    ("fb.me", PlatformKind::SocialProfile),
    ("tiktok.com", PlatformKind::SocialProfile),
    ("x.com", PlatformKind::SocialProfile),
    ("twitter.com", PlatformKind::SocialProfile),
    ("linkedin.com", PlatformKind::SocialProfile),
    ("youtube.com", PlatformKind::SocialProfile),
    ("youtu.be", PlatformKind::SocialProfile),
    ("linktr.ee", PlatformKind::LinkInBio),
    ("linkin.bio", PlatformKind::LinkInBio),
    ("bio.link", PlatformKind::LinkInBio),
    ("beacons.ai", PlatformKind::LinkInBio),
    ("taplink.cc", PlatformKind::LinkInBio),
    ("wa.me", PlatformKind::Messaging),
    ("whatsapp.com", PlatformKind::Messaging),
    ("t.me", PlatformKind::Messaging),
    ("maps.app.goo.gl", PlatformKind::MapListing),
    ("g.page", PlatformKind::MapListing),
    ("goo.gl", PlatformKind::ShortLink),
    ("bit.ly", PlatformKind::ShortLink),
    ("sites.google.com", PlatformKind::SharedHost),
    ("trendyol.com", PlatformKind::Marketplace),
    ("hepsiburada.com", PlatformKind::Marketplace),
    ("n11.com", PlatformKind::Marketplace),
    ("ciceksepeti.com", PlatformKind::Marketplace),
    ("yemeksepeti.com", PlatformKind::Marketplace),
    ("getir.com", PlatformKind::Marketplace),
    ("sahibinden.com", PlatformKind::Marketplace),
    ("armut.com", PlatformKind::Marketplace),
];

/// Search and map providers that serve under many country domains (`google.com`,
/// `google.com.tr`, `yandex.ru`, …): a host whose labels are one of these names and then one or
/// two short labels (`com`, `com.tr`, `co.uk`), or a subdomain of such a host. A map path
/// (`/maps…`) or a `maps.` subdomain is a [`PlatformKind::MapListing`], anything else a
/// [`PlatformKind::SharedHost`].
pub const PLATFORM_NAMES: &[&str] = &["google", "yandex"];

/// The longest a website's host may be: 253 characters, the longest name RFC 1035 §2.3.4 (255
/// octets on the wire) allows. A stored key is at most 400 characters (`prospect_keys.value`).
pub const MAX_HOST_CHARS: usize = 253;

/// Legal-form and joining tokens dropped from a folded business name (spec §3.3), as they read
/// after folding: `a.ş` → `as`, `şti` → `sti`, `şirketi` → `sirketi`.
const LEGAL_FORM_TOKENS: &[&str] = &["ltd", "sti", "as", "limited", "sirketi", "tic", "san", "ve"];

/// The platform kind of `host` (lower-case ASCII, no trailing dot) reached at `path`, if any.
fn platform_of(host: &str, path: &str) -> Option<PlatformKind> {
    let on = |p: &str| host == p || host.ends_with(&format!(".{p}"));
    let listed = PLATFORM_HOSTS
        .iter()
        .filter(|(p, _)| on(p))
        .max_by_key(|(p, _)| p.len())
        .map(|(_, kind)| *kind);
    if listed.is_some() {
        return listed;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let named = labels.iter().enumerate().any(|(i, l)| {
        let suffix = &labels[i + 1..];
        PLATFORM_NAMES.contains(l)
            && (1..=2).contains(&suffix.len())
            && suffix
                .iter()
                .all(|s| (2..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase()))
    });
    if !named {
        return None;
    }
    let maps = labels.first() == Some(&"maps") || path == "/maps" || path.starts_with("/maps/");
    Some(if maps {
        PlatformKind::MapListing
    } else {
        PlatformKind::SharedHost
    })
}

/// What a website URL's host is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebsiteHost {
    /// The business's own: its `domain` key.
    Domain(String),
    /// A platform's: never a business's own website, never a key.
    Platform(PlatformKind),
    /// An IP address: no name to key on.
    IpAddress,
}

/// What `url`'s host is: its `domain` key (IDNA to ASCII and lower-cased, which the `url`
/// crate does for `http`/`https`, with one leading `www.` stripped), a platform host, or an IP
/// address. `Err` for anything but an absolute `http`/`https` URL (`not_http`) and for a host
/// longer than [`MAX_HOST_CHARS`] (`host_too_long`).
pub fn classify_website(url: &str) -> Result<WebsiteHost, ProspectError> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| invalid("website", "not_http"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(invalid("website", "not_http"));
    }
    let host = match parsed.host() {
        Some(url::Host::Domain(d)) => d.trim_end_matches('.').to_ascii_lowercase(),
        Some(_) => return Ok(WebsiteHost::IpAddress),
        None => return Err(invalid("website", "not_http")),
    };
    if host.len() > MAX_HOST_CHARS {
        return Err(invalid("website", "host_too_long"));
    }
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() {
        return Err(invalid("website", "not_http"));
    }
    Ok(match platform_of(&host, parsed.path()) {
        Some(kind) => WebsiteHost::Platform(kind),
        None => WebsiteHost::Domain(host),
    })
}

/// The `domain` key of a website ([`classify_website`]): `None` for a platform host or an IP
/// address; `Err` for anything but an absolute `http`/`https` URL or an overlong host.
pub fn website_domain(url: &str) -> Result<Option<String>, ProspectError> {
    Ok(match classify_website(url)? {
        WebsiteHost::Domain(d) => Some(d),
        WebsiteHost::Platform(_) | WebsiteHost::IpAddress => None,
    })
}

/// The first path segments of Instagram URLs that are not profiles: posts, reels, stories,
/// explore pages, TV and account pages.
const INSTAGRAM_RESERVED: &[&str] = &["p", "reel", "reels", "stories", "explore", "tv", "accounts"];
/// The first path segments of TikTok URLs that are not profiles (a profile path is `@handle`).
const TIKTOK_RESERVED: &[&str] = &["t", "video", "tag", "music", "discover"];

/// The path of `lower` (`/…`, `?…`, `#…` or empty) when it is a URL on `host` itself or on its
/// `www.` or `m.` subdomain, with or without a scheme; `None` for anything else.
fn platform_path<'a>(lower: &'a str, host: &str) -> Option<&'a str> {
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(lower);
    ["", "www.", "m."].into_iter().find_map(|sub| {
        rest.strip_prefix(sub)
            .and_then(|r| r.strip_prefix(host))
            .filter(|path| path.is_empty() || path.starts_with(['/', '?', '#']))
    })
}

/// The handle of an Instagram or TikTok value: a bare handle, `@handle`, or a profile URL on the
/// platform's host or its `www.`/`m.` subdomain (`instagram.com/<h>`, `tiktok.com/@<h>`);
/// lower-cased; `[a-z0-9._]` of `1..=30` (Instagram) or `2..=24` (TikTok) characters. A bare
/// value keeps a leading `www.` or `m.` (it is part of the handle). A URL of a post, a reel, a
/// story or any page but a profile (a reserved first path segment, a TikTok path without `@`,
/// another host) is `not_a_profile_url`; a malformed handle is `invalid`.
pub fn normalise_handle(kind: KeyKind, raw: &str) -> Result<String, ProspectError> {
    let (field, host, reserved, min, max) = match kind {
        KeyKind::Instagram => ("instagram", "instagram.com", INSTAGRAM_RESERVED, 1, 30),
        KeyKind::Tiktok => ("tiktok", "tiktok.com", TIKTOK_RESERVED, 2, 24),
        _ => return Err(invalid("kind", "not_a_handle")),
    };
    let lower = raw.trim().to_ascii_lowercase();
    let not_a_profile = || invalid(field, "not_a_profile_url");
    let handle = match platform_path(&lower, host) {
        Some(path) => {
            let path = path.strip_prefix('/').ok_or_else(not_a_profile)?;
            let first = path.split(['/', '?', '#']).next().unwrap_or_default();
            if reserved.contains(&first) {
                return Err(not_a_profile());
            }
            match (kind, first.strip_prefix('@')) {
                (_, Some(handle)) => handle,
                (KeyKind::Tiktok, None) => return Err(not_a_profile()),
                (_, None) => first,
            }
        }
        None if lower.contains("://") => return Err(not_a_profile()),
        None => lower.strip_prefix('@').unwrap_or(&lower),
    };
    if handle.is_empty() {
        return Err(not_a_profile());
    }
    let well_formed = (min..=max).contains(&handle.len())
        && handle
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_');
    if well_formed {
        Ok(handle.to_owned())
    } else {
        Err(invalid(field, "invalid"))
    }
}

/// The handle of `kind` that `url` names when it is a profile URL on that platform's host.
pub fn website_handle(kind: KeyKind, url: &str) -> Option<String> {
    let host = match kind {
        KeyKind::Instagram => "instagram.com",
        KeyKind::Tiktok => "tiktok.com",
        _ => return None,
    };
    platform_path(&url.trim().to_ascii_lowercase(), host)?;
    normalise_handle(kind, url).ok()
}

/// The prefix of a Turkish nationwide `444` number's key: `tr444:` and its seven digits. Such a
/// number is kept apart from E.164 numbers: it is no inbox identity and Jeeta never dials it
/// ([`phone_is_dialable`]).
pub const TR444_PREFIX: &str = "tr444:";

/// Seven digits starting `444`.
fn is_444(digits: &str) -> bool {
    digits.len() == 7 && digits.starts_with("444") && digits.bytes().all(|b| b.is_ascii_digit())
}

/// A phone as the pool stores and keys it. Before the inbox's rules (`jt_inbox::normalise`) it
/// is read as Turkish businesses publish it: an extension (`dahili`, `ext`, `x`, `/` and what
/// follows) is cut, a leading `00` is the international `+`, and a national `0` after `+90`
/// (`+90 (0) 5…`) is dropped. A `444` number of seven digits (alone, or after `0` or `+90`) is
/// `tr444:<digits>`. A number that would start `+0` is refused. Idempotent: its own output
/// normalises to itself.
pub fn normalise_phone(raw: &str) -> Result<String, ProspectError> {
    let bad = || invalid("phone", "invalid");
    let raw = raw.trim();
    if let Some(digits) = raw.strip_prefix(TR444_PREFIX) {
        return if is_444(digits) {
            Ok(raw.to_owned())
        } else {
            Err(bad())
        };
    }
    // Lower-cased, the Turkish capitals İ and I as i, so a marker matches in any case.
    let lower: String = raw
        .chars()
        .map(|c| match c {
            'İ' | 'I' | 'ı' => 'i',
            c => c.to_ascii_lowercase(),
        })
        .collect();
    // The number starts at its first `+` or digit (a label such as `Tel/Fax:` before it is no
    // extension); an extension marker after that ends it.
    let start = lower
        .find(|c: char| c == '+' || c.is_ascii_digit())
        .unwrap_or(lower.len());
    let tail = &lower[start..];
    let cut = ["dahili", "ext", "x", "/"]
        .iter()
        .filter_map(|m| tail.find(m))
        .min()
        .unwrap_or(tail.len());
    let number: String = tail[..cut]
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '.'))
        .collect();
    let international = number.starts_with('+') || number.starts_with("00");
    let mut digits: String = number.chars().filter(char::is_ascii_digit).collect();
    if number.starts_with("00") {
        digits.drain(..2);
    }
    if international && digits.starts_with('0') {
        return Err(bad());
    }
    if international && digits.starts_with("900") {
        digits.remove(2);
    }
    let national = if international || digits.len() == 9 {
        digits.strip_prefix("90")
    } else if digits.len() == 8 {
        digits.strip_prefix('0')
    } else {
        Some(digits.as_str())
    };
    if let Some(n) = national.filter(|n| is_444(n)) {
        return Ok(format!("{TR444_PREFIX}{n}"));
    }
    let raw_number = if international {
        format!("+{digits}")
    } else {
        digits
    };
    let out = normalise(IdentityChannel::Phone, &raw_number).map_err(|_| bad())?;
    if out.starts_with("+0") {
        return Err(bad());
    }
    Ok(out)
}

/// Whether a normalised phone ([`normalise_phone`]) is an E.164 number: an inbox identity a
/// promotion may use. A `tr444:` number is not.
pub fn phone_is_dialable(normalised: &str) -> bool {
    normalised.starts_with('+')
}

/// Characters that join a word rather than separate two: `Ltd.` and `A.Ş.` stay one token each.
fn joins(c: char) -> bool {
    matches!(c, '.' | '\'' | '’' | '`') || ('\u{0300}'..='\u{036f}').contains(&c)
}

/// The Turkish-aware fold of spec §3.3: İ → i and I → ı before lower-casing, then
/// ç ğ ı ö ş ü → c g i o s u and the circumflex of older spellings â î û → a i u; abbreviation
/// dots and apostrophes dropped, other punctuation a space; legal-form tokens dropped; spaces
/// collapsed.
fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let c = match c {
            'İ' => 'i',
            'I' => 'ı',
            c => c,
        };
        for l in c.to_lowercase() {
            if joins(l) {
                continue;
            }
            out.push(match l {
                'ç' => 'c',
                'ğ' => 'g',
                'ı' => 'i',
                'ö' => 'o',
                'ş' => 's',
                'ü' => 'u',
                'â' => 'a',
                'î' => 'i',
                'û' => 'u',
                l if l.is_alphanumeric() => l,
                _ => ' ',
            });
        }
    }
    out.split_whitespace()
        .filter(|t| !LEGAL_FORM_TOKENS.contains(t))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The `name_city` key: `name|city`, both folded; `None` when either is empty after folding.
pub fn name_city(name: &str, city: &str) -> Option<String> {
    let name = fold(name);
    let city = fold(city);
    if name.is_empty() || city.is_empty() {
        None
    } else {
        Some(format!("{name}|{city}"))
    }
}

/// The bytes a blocklist hash is computed over: the kind's key, a NUL, the normalised value.
pub fn blocklist_material(kind: KeyKind, normalised: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(kind.key().len() + 1 + normalised.len());
    out.extend_from_slice(kind.key().as_bytes());
    out.push(0);
    out.extend_from_slice(normalised.as_bytes());
    out
}

/// A raw value of `kind` (a person typing an objection, an agent's check) normalised as a key:
/// a phone as [`normalise_phone`], an email as `jt_inbox::normalise`, a handle as
/// [`normalise_handle`], a domain from a bare host or a URL as [`website_domain`] (a platform
/// host or an IP address is no domain), a `name|city` pair folded on both sides.
pub fn normalise_key(kind: KeyKind, raw: &str) -> Result<String, ProspectError> {
    match kind {
        KeyKind::Phone => normalise_phone(raw),
        KeyKind::Email => {
            normalise(IdentityChannel::Email, raw).map_err(|_| invalid("email", "invalid"))
        }
        KeyKind::Instagram | KeyKind::Tiktok => normalise_handle(kind, raw),
        KeyKind::Domain => {
            let raw = raw.trim();
            let url = if raw.contains("://") {
                raw.to_owned()
            } else {
                format!("https://{raw}")
            };
            website_domain(&url)
                .map_err(|_| invalid("domain", "invalid"))?
                .ok_or(invalid("domain", "invalid"))
        }
        KeyKind::NameCity => {
            let (name, city) = raw.split_once('|').ok_or(invalid("name_city", "invalid"))?;
            name_city(name, city).ok_or(invalid("name_city", "invalid"))
        }
    }
}

/// Every key of a stored prospect, hard and soft, deduplicated, in [`KeyKind::ALL`] order and by
/// value within a kind. Values are re-normalised, so a legacy row written before a rule changed
/// still gives today's keys; a value that no longer normalises gives no key.
pub fn derive_keys(p: &Prospect) -> Vec<Key> {
    let mut keys: Vec<Key> = Vec::new();
    let mut push = |kind: KeyKind, value: Option<String>| {
        if let Some(value) = value {
            keys.push(Key { kind, value });
        }
    };
    let c = &p.contact;
    if let Some(f) = &c.phone {
        push(KeyKind::Phone, normalise_phone(&f.value).ok());
    }
    if let Some(f) = &c.email {
        let email = normalise(IdentityChannel::Email, &f.value).ok();
        let domain = email
            .as_deref()
            .and_then(|e| e.rsplit_once('@'))
            .map(|(_, d)| d.to_owned())
            .filter(|d| !FREE_MAIL_DOMAINS.contains(&d.as_str()))
            .and_then(|d| website_domain(&format!("https://{d}")).ok().flatten());
        push(KeyKind::Email, email);
        push(KeyKind::Domain, domain);
    }
    if let Some(f) = &c.instagram {
        push(
            KeyKind::Instagram,
            normalise_handle(KeyKind::Instagram, &f.value).ok(),
        );
    }
    if let Some(f) = &c.tiktok {
        push(
            KeyKind::Tiktok,
            normalise_handle(KeyKind::Tiktok, &f.value).ok(),
        );
    }
    if let Some(f) = &c.website {
        // A legacy website on a platform host still names the handle it holds.
        for kind in [KeyKind::Instagram, KeyKind::Tiktok] {
            push(kind, website_handle(kind, &f.value));
        }
        push(KeyKind::Domain, website_domain(&f.value).ok().flatten());
    }
    if let Some(city) = &p.city {
        push(KeyKind::NameCity, name_city(&p.business_name, city));
    }
    keys.sort();
    keys.dedup();
    keys
}
