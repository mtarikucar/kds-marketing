//! Dedupe keys (spec §3.3): hard keys are unique among live prospects; soft keys only raise
//! `possible_duplicate`. Every key is derived from a stored, already-normalised prospect, so the
//! same business gives the same keys however it was written.

use jt_inbox::{IdentityChannel, normalise};
use serde::{Deserialize, Serialize};

use crate::{Prospect, ProspectError, invalid};

/// The kind of a dedupe key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    /// An E.164 number (`jt_inbox::normalise`).
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

    /// Whether the key is unique among live prospects (phone, email and the two handles).
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

/// Hosts of social profiles, link-in-bio pages and map links: a URL there is a profile, not the
/// business's own website, and the host is shared by everyone, so it is never a `domain` key.
/// A host matches when it is one of these or a subdomain of one.
pub const PLATFORM_HOSTS: &[&str] = &[
    "instagram.com",
    "facebook.com",
    "fb.com",
    "fb.me",
    "tiktok.com",
    "x.com",
    "twitter.com",
    "linkedin.com",
    "youtube.com",
    "youtu.be",
    "wa.me",
    "whatsapp.com",
    "t.me",
    "linktr.ee",
    "linkin.bio",
    "bio.link",
    "beacons.ai",
    "taplink.cc",
    "maps.app.goo.gl",
    "goo.gl",
    "g.page",
    "maps.google.com",
];

/// Legal-form and joining tokens dropped from a folded business name (spec §3.3), as they read
/// after folding: `a.ş` → `as`, `şti` → `sti`, `şirketi` → `sirketi`.
const LEGAL_FORM_TOKENS: &[&str] = &["ltd", "sti", "as", "limited", "sirketi", "tic", "san", "ve"];

fn is_platform_host(host: &str) -> bool {
    PLATFORM_HOSTS
        .iter()
        .any(|p| host == *p || host.ends_with(&format!(".{p}")))
}

/// The `domain` key of a website: its host, IDNA to ASCII and lower-cased (the `url` crate does
/// both for `http`/`https`), with one leading `www.` stripped. `None` for a platform host or an
/// IP address; `Err` for anything but an absolute `http`/`https` URL.
pub fn website_domain(url: &str) -> Result<Option<String>, ProspectError> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| invalid("website", "not_http"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(invalid("website", "not_http"));
    }
    let host = match parsed.host() {
        Some(url::Host::Domain(d)) => d.trim_end_matches('.').to_ascii_lowercase(),
        Some(_) => return Ok(None),
        None => return Err(invalid("website", "not_http")),
    };
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() || is_platform_host(&host) {
        return Ok(None);
    }
    Ok(Some(host))
}

/// The handle of an Instagram or TikTok value: a bare handle, `@handle`, or a profile URL on the
/// platform's host (`instagram.com/<h>`, `tiktok.com/@<h>`); lower-cased; `[a-z0-9._]` of
/// `1..=30` (Instagram) or `2..=24` (TikTok) characters.
pub fn normalise_handle(kind: KeyKind, raw: &str) -> Result<String, ProspectError> {
    let (field, host, min, max) = match kind {
        KeyKind::Instagram => ("instagram", "instagram.com", 1, 30),
        KeyKind::Tiktok => ("tiktok", "tiktok.com", 2, 24),
        _ => return Err(invalid("kind", "not_a_handle")),
    };
    let raw = raw.trim();
    let lower = raw.to_ascii_lowercase();
    let without_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    let without_www = without_scheme
        .strip_prefix("www.")
        .or_else(|| without_scheme.strip_prefix("m."))
        .unwrap_or(without_scheme);
    let handle = match without_www.strip_prefix(host) {
        Some(path) => {
            let path = path.strip_prefix('/').ok_or(invalid(field, "invalid"))?;
            path.split(['/', '?', '#']).next().unwrap_or_default()
        }
        None => without_www,
    };
    let handle = handle.strip_prefix('@').unwrap_or(handle);
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

/// Characters that join a word rather than separate two: `Ltd.` and `A.Ş.` stay one token each.
fn joins(c: char) -> bool {
    matches!(c, '.' | '\'' | '’' | '`') || ('\u{0300}'..='\u{036f}').contains(&c)
}

/// The Turkish-aware fold of spec §3.3: İ → i and I → ı before lower-casing, then
/// ç ğ ı ö ş ü → c g i o s u; abbreviation dots and apostrophes dropped, other punctuation a
/// space; legal-form tokens dropped; spaces collapsed.
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
/// a phone or email as `jt_inbox::normalise`, a handle as [`normalise_handle`], a domain from a
/// bare host or a URL as [`website_domain`] (a platform host is no domain), a `name|city` pair
/// folded on both sides.
pub fn normalise_key(kind: KeyKind, raw: &str) -> Result<String, ProspectError> {
    match kind {
        KeyKind::Phone => {
            normalise(IdentityChannel::Phone, raw).map_err(|_| invalid("phone", "invalid"))
        }
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
        push(
            KeyKind::Phone,
            normalise(IdentityChannel::Phone, &f.value).ok(),
        );
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
            if website_on(&f.value, kind) {
                push(kind, normalise_handle(kind, &f.value).ok());
            }
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

fn website_on(url: &str, kind: KeyKind) -> bool {
    let host = match kind {
        KeyKind::Instagram => "instagram.com",
        KeyKind::Tiktok => "tiktok.com",
        _ => return false,
    };
    url::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|h| h == host || h.ends_with(&format!(".{host}")))
}
