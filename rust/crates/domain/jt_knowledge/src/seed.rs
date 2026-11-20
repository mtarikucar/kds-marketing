//! What a workspace's strategy versions give its knowledge base when it is seeded (design
//! §4.3): the seed cards' texts, the prohibitions, the goals, the past conversations, and the
//! proposals for what was written but never applied.
//!
//! Every function here is pure and deterministic: the same versions give the same texts.

use jt_ledger::Actor;
use jt_strategy::{
    ChannelChoice, ConsultationEntry, ConsultationKind, Goals, Hypothesis, IcpEntry, Identity,
    Sections, Segment,
};

use crate::card::{PAST_CONVERSATIONS, SEED_CARDS};
use crate::limits::{
    MAX_CARD_BODY_CHARS, MAX_GOAL_CHARS, MAX_GOALS, MAX_PROHIBITION_CHARS, MAX_PROHIBITIONS,
};
use crate::proposal::ProposalKind;
use crate::text::{cut, one_line};

/// The reason of a proposal for a text a draft wrote and no approval applied.
pub const DRAFT_REASON: &str = "Daha önce yazılmıştı ama uygulanmamıştı.";
/// The reason of a proposal for a text of the strategy archived last.
pub const ARCHIVED_REASON: &str = "Daha önce kullanılıyordu; istersen geri ekle.";
/// The reason of a proposal for a text an approval through the old strategy tools wrote for a
/// card the owner had changed since (design §4.3.4).
pub const RESYNC_REASON: &str = "Önceki sayfada onaylanan metin.";
/// The consultation log's note on a draft the seeding closes.
pub const DRAFT_CLOSED_NOTE: &str = "closed: the knowledge base replaces drafts";
/// The name of the general ad budget the seeding creates from a paid lane.
pub const AD_BUDGET_NAME: &str = "Reklam bütçesi";
/// The longest past conversation entry a card keeps, in characters.
pub const PAST_ENTRY_CHARS: usize = 600;

/// The seed cards whose text an open draft's differences from the approved version (identity,
/// audience, goals, prospecting, live hypotheses) are proposed for. Without an approved version
/// every seed card the version gives text to is proposed, `accounts_channels` too.
pub const PROPOSABLE_CARDS: [&str; 6] = [
    "who_we_are",
    "products_prices",
    "voice",
    "customers",
    "post_ideas",
    "who_we_seek",
];

/// One seed card's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedCard {
    pub key: &'static str,
    pub title: &'static str,
    pub body: String,
}

/// What a version gives the knowledge base: the eight seed cards, in their positions, the
/// prohibitions and the goal lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedParts {
    pub cards: Vec<SeedCard>,
    pub prohibitions: Vec<String>,
    pub goals: Vec<String>,
}

impl SeedParts {
    /// The eight seed cards with no text, no prohibition, no goal.
    pub fn blank() -> SeedParts {
        SeedParts {
            cards: SEED_CARDS
                .iter()
                .map(|(key, title)| SeedCard {
                    key,
                    title,
                    body: String::new(),
                })
                .collect(),
            prohibitions: Vec::new(),
            goals: Vec::new(),
        }
    }

    /// What a version with `sections` gives, `topics` being its hypotheses in position order
    /// without the owner's request (retired ones are left out here).
    pub fn from_version(sections: &Sections, topics: &[Hypothesis]) -> SeedParts {
        let body = |key: &str| match key {
            "who_we_are" => who_we_are(&sections.identity),
            "products_prices" => fit(Some(&sections.identity.product), &[]),
            "voice" => fit(Some(&sections.identity.voice), &[]),
            "customers" => customers(&sections.goals, &sections.audience),
            "post_ideas" => post_ideas(topics),
            "who_we_seek" => who_we_seek(&sections.prospecting.icp, &sections.audience),
            "accounts_channels" => accounts_channels(&sections.channels),
            _ => String::new(),
        };
        SeedParts {
            cards: SEED_CARDS
                .iter()
                .map(|(key, title)| SeedCard {
                    key,
                    title,
                    body: body(key),
                })
                .collect(),
            prohibitions: prohibitions(&sections.prohibitions),
            goals: goal_lines(&sections.goals),
        }
    }

    /// The text of the seed card `key`; empty for a key it has not.
    pub fn body(&self, key: &str) -> &str {
        self.cards
            .iter()
            .find(|c| c.key == key)
            .map_or("", |c| c.body.as_str())
    }
}

/// A platform's name in the owner's words, for a capability kind.
pub fn platform_name(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "instagram" => "Instagram",
        "facebook_page" => "Facebook",
        "x" => "X",
        "linkedin_page" | "linkedin_member" => "LinkedIn",
        "tiktok" => "TikTok",
        "youtube" => "YouTube",
        "pinterest" => "Pinterest",
        "google_business" => "Google İşletme",
        "mailbox" => "E-posta",
        "whatsapp_cloud" => "WhatsApp",
        "sms_line" => "SMS",
        "meta_ads" => "Meta reklam",
        _ => return None,
    })
}

/// A card's body from a paragraph (`head`, kept as written) and lines under it after a blank
/// line. Longer than [`MAX_CARD_BODY_CHARS`], it keeps whole lines from the start and ends with
/// `(+{n} satır daha)`.
pub fn fit(head: Option<&str>, lines: &[String]) -> String {
    let head = head.map(str::trim).filter(|h| !h.is_empty());
    let join = |n: usize| {
        let mut parts: Vec<String> = head.iter().map(|h| (*h).to_owned()).collect();
        if n > 0 {
            parts.push(lines[..n].join("\n"));
        }
        parts.join("\n\n")
    };
    let whole = join(lines.len());
    if whole.chars().count() <= MAX_CARD_BODY_CHARS {
        return whole;
    }
    for n in (0..lines.len()).rev() {
        let kept = join(n);
        let more = format!("(+{} satır daha)", lines.len() - n);
        let text = if kept.is_empty() {
            more
        } else {
            format!("{kept}\n{more}")
        };
        if text.chars().count() <= MAX_CARD_BODY_CHARS {
            return text;
        }
    }
    cut(&whole, MAX_CARD_BODY_CHARS)
}

/// `• {text}` with the text on one line.
fn bullet(text: &str) -> String {
    format!("• {}", one_line(text))
}

/// `text` on one line, ending with exactly one full stop.
fn sentence(text: &str) -> String {
    let text = one_line(text);
    format!("{}.", text.trim_end_matches('.'))
}

/// "Biz kimiz": the positioning, then what sets the business apart.
fn who_we_are(identity: &Identity) -> String {
    let usp = identity.usp.trim();
    let lines: Vec<String> = if usp.is_empty() {
        Vec::new()
    } else {
        vec![format!("Bizi farklı kılan: {usp}")]
    };
    fit(Some(&identity.positioning), &lines)
}

/// "Müşterilerimiz": the objective, then one line per audience segment.
fn customers(goals: &Goals, audience: &[Segment]) -> String {
    let lines: Vec<String> = audience
        .iter()
        .map(|s| {
            let name = if s.name.trim().is_empty() {
                s.key.as_str()
            } else {
                s.name.as_str()
            };
            if s.description.trim().is_empty() {
                bullet(name)
            } else {
                bullet(&format!("{}: {}", one_line(name), one_line(&s.description)))
            }
        })
        .collect();
    fit(Some(&goals.objective), &lines)
}

/// "Paylaşım fikirleri": one line per live topic, in position order.
fn post_ideas(topics: &[Hypothesis]) -> String {
    let lines: Vec<String> = topics
        .iter()
        .filter(|h| h.state.is_live())
        .map(|h| {
            if h.angle.trim().is_empty() {
                bullet(&h.title)
            } else {
                bullet(&format!("{}: {}", one_line(&h.title), one_line(&h.angle)))
            }
        })
        .collect();
    fit(None, &lines)
}

/// "Kimi arıyoruz": one line per entry of the ideal customer profile (its rubric stays in the
/// frame).
fn who_we_seek(icp: &[IcpEntry], audience: &[Segment]) -> String {
    let lines: Vec<String> = icp
        .iter()
        .map(|e| {
            let name = audience
                .iter()
                .find(|s| s.key == e.segment_key && !s.name.trim().is_empty())
                .map_or(e.segment_key.as_str(), |s| s.name.as_str());
            let sectors: Vec<String> = e
                .sectors
                .iter()
                .map(|s| one_line(s))
                .filter(|s| !s.is_empty())
                .collect();
            let mut line = if sectors.is_empty() {
                format!("• {}.", one_line(name).trim_end_matches('.'))
            } else {
                format!("• {}: {}", one_line(name), sentence(&sectors.join(", ")))
            };
            let areas: Vec<String> = e
                .areas
                .iter()
                .filter(|a| !a.city.trim().is_empty())
                .map(|a| match a.district.as_deref().map(str::trim) {
                    Some(d) if !d.is_empty() => format!("{} ({d})", a.city.trim()),
                    _ => a.city.trim().to_owned(),
                })
                .collect();
            let joined = |items: &[String], sep: &str| {
                items
                    .iter()
                    .map(|s| one_line(s))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(sep)
            };
            for (label, text) in [
                ("Şehirler", areas.join(", ")),
                ("İşaretler", joined(&e.signals, "; ")),
                ("Hariç", joined(&e.exclusions, "; ")),
                ("Ölçek", one_line(&e.size_hint)),
            ] {
                if !text.is_empty() {
                    line.push_str(&format!(" {label}: {}", sentence(&text)));
                }
            }
            line
        })
        .collect();
    fit(None, &lines)
}

/// "Hesaplar ve kanallar": one line per channel choice with a rationale.
fn accounts_channels(channels: &[ChannelChoice]) -> String {
    let lines: Vec<String> = channels
        .iter()
        .filter(|c| !c.rationale.trim().is_empty())
        .map(|c| match c.channel.as_str() {
            "any" => bullet(&c.rationale),
            kind => {
                let name = platform_name(kind).unwrap_or(kind);
                bullet(&format!("{name}: {}", one_line(&c.rationale)))
            }
        })
        .collect();
    fit(None, &lines)
}

/// The prohibitions as they are: trimmed, the empty ones dropped, at most [`MAX_PROHIBITIONS`]
/// of at most [`MAX_PROHIBITION_CHARS`] characters, each once.
pub fn prohibitions(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in raw {
        let p = cut(p.trim(), MAX_PROHIBITION_CHARS);
        if !p.is_empty() && !out.contains(&p) && out.len() < MAX_PROHIBITIONS {
            out.push(p);
        }
    }
    out
}

/// One goal line per KPI: `{name}: {target}`, or `{name}` when the target is empty; at most
/// [`MAX_GOALS`] of at most [`MAX_GOAL_CHARS`] characters, each once.
pub fn goal_lines(goals: &Goals) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for kpi in &goals.kpis {
        let (name, target) = (one_line(&kpi.name), one_line(&kpi.target));
        let line = match (name.is_empty(), target.is_empty()) {
            (false, false) => format!("{name}: {target}"),
            (false, true) => name,
            (true, false) => target,
            (true, true) => continue,
        };
        let line = cut(&line, MAX_GOAL_CHARS);
        if !out.contains(&line) && out.len() < MAX_GOALS {
            out.push(line);
        }
    }
    out
}

/// "Önceki görüşmeler": the answers and notes a person or an agent recorded in any version's
/// consultation log (the system's own notes left out), newest first, `• {text}` each cut at
/// [`PAST_ENTRY_CHARS`] characters, whole entries only, until [`MAX_CARD_BODY_CHARS`]; none
/// when there is none.
pub fn past_conversations(entries: &[ConsultationEntry]) -> Option<String> {
    let mut kept: Vec<&ConsultationEntry> = entries
        .iter()
        .filter(|e| matches!(e.kind, ConsultationKind::Answer | ConsultationKind::Note))
        .filter(|e| !matches!(e.actor, Actor::System { .. }))
        .filter(|e| !e.text.trim().is_empty())
        .collect();
    kept.sort_by_key(|e| std::cmp::Reverse((e.at, e.id)));
    let mut body = String::new();
    for e in kept {
        let line = format!("• {}", cut(&one_line(&e.text), PAST_ENTRY_CHARS));
        let len = body.chars().count() + usize::from(!body.is_empty()) + line.chars().count();
        if len > MAX_CARD_BODY_CHARS {
            break;
        }
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&line);
    }
    (!body.is_empty()).then_some(body)
}

/// A proposal the seeding makes, against the seed card of `card_key` for a `card_edit`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedProposal {
    pub kind: ProposalKind,
    pub card_key: Option<&'static str>,
    pub title: Option<String>,
    pub body: String,
}

/// What a version's parts that were never applied (`unapplied`) become, against what the
/// knowledge base was seeded with (`applied`, the approved version's parts; none for a workspace
/// with no approved version, whose seed cards are blank): a `card_edit` for each card whose text
/// differs and is not empty (of [`PROPOSABLE_CARDS`] against an approved version, of every seed
/// card without one, so nothing an archived or a draft version said is lost), a `rule_add` per
/// prohibition only `unapplied` has, a `goal_add` per goal line only it has, and, with `log` (the
/// past conversations of a workspace without an approved version), a `card_new` "Önceki
/// görüşmeler".
pub fn unapplied(
    applied: Option<&SeedParts>,
    unapplied: &SeedParts,
    log: Option<&str>,
) -> Vec<SeedProposal> {
    let blank = SeedParts::blank();
    let (applied, keys): (&SeedParts, Vec<&'static str>) = match applied {
        Some(applied) => (applied, PROPOSABLE_CARDS.to_vec()),
        None => (&blank, SEED_CARDS.iter().map(|(key, _)| *key).collect()),
    };
    let mut out = Vec::new();
    for key in keys {
        let text = unapplied.body(key);
        if !text.trim().is_empty() && text != applied.body(key) {
            out.push(SeedProposal {
                kind: ProposalKind::CardEdit,
                card_key: Some(key),
                title: None,
                body: text.to_owned(),
            });
        }
    }
    let mut seen: Vec<&String> = Vec::new();
    for p in &unapplied.prohibitions {
        if !applied.prohibitions.contains(p) && !seen.contains(&p) {
            seen.push(p);
            out.push(SeedProposal {
                kind: ProposalKind::RuleAdd,
                card_key: None,
                title: None,
                body: p.clone(),
            });
        }
    }
    let mut seen: Vec<&String> = Vec::new();
    for g in &unapplied.goals {
        if !applied.goals.contains(g) && !seen.contains(&g) {
            seen.push(g);
            out.push(SeedProposal {
                kind: ProposalKind::GoalAdd,
                card_key: None,
                title: None,
                body: g.clone(),
            });
        }
    }
    if let Some(log) = log.filter(|l| !l.trim().is_empty()) {
        out.push(SeedProposal {
            kind: ProposalKind::CardNew,
            card_key: None,
            title: Some(PAST_CONVERSATIONS.1.to_owned()),
            body: log.to_owned(),
        });
    }
    out
}
