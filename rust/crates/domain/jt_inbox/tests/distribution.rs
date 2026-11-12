use jt_inbox::*;
use jt_tenancy::UserId;
use serde_json::json;
use time::{Duration, OffsetDateTime};

/// Users whose ids sort in the order given.
fn users(n: usize) -> Vec<UserId> {
    let mut ids: Vec<UserId> = (0..n).map(|_| UserId::new_v7()).collect();
    ids.sort();
    ids
}

fn member(user_id: UserId) -> Candidate {
    Candidate {
        user_id,
        eligible: true,
        on_shift: true,
        open_owned: 0,
        languages: Vec::new(),
        cities: Vec::new(),
        sectors: Vec::new(),
    }
}

fn rule(name: &str, when: Match, to: MemberPool, method: Method) -> Rule {
    Rule {
        id: RuleId::new_v7(),
        name: name.into(),
        enabled: true,
        when,
        to,
        method,
        sla_minutes: Some(30),
        cursor: None,
    }
}

fn prospect_in(city: &str) -> LeadFacts {
    LeadFacts {
        city: Some(city.into()),
        ..LeadFacts::source_only(SourceKind::Prospect)
    }
}

fn cities(list: &[&str]) -> Match {
    Match {
        cities: list.iter().map(|c| c.to_string()).collect(),
        ..Match::default()
    }
}

const ON: DefaultRule = DefaultRule::On { cursor: None };

#[test]
fn rules_apply_in_order() {
    let u = users(3);
    let first = rule(
        "istanbul",
        cities(&["İstanbul"]),
        MemberPool::Members {
            user_ids: vec![u[1]],
        },
        Method::RoundRobin,
    );
    let second = rule(
        "everyone",
        Match::default(),
        MemberPool::Members {
            user_ids: vec![u[2]],
        },
        Method::RoundRobin,
    );
    let candidates: Vec<Candidate> = u.iter().copied().map(member).collect();
    let rules = [first.clone(), second.clone()];

    let c = choose(&rules, ON, &prospect_in("istanbul"), &candidates, &[]);
    assert_eq!(
        c,
        Choice {
            user_id: Some(u[1]),
            rule_id: Some(first.id),
            cause: Cause::Rule,
            sla_minutes: Some(30),
        }
    );
    let c = choose(&rules, ON, &prospect_in("Ankara"), &candidates, &[]);
    assert_eq!((c.user_id, c.rule_id), (Some(u[2]), Some(second.id)));

    let mut disabled = first.clone();
    disabled.enabled = false;
    let c = choose(
        &[disabled, second.clone()],
        ON,
        &prospect_in("istanbul"),
        &candidates,
        &[],
    );
    assert_eq!(c.rule_id, Some(second.id), "a disabled rule never applies");
}

#[test]
fn matching_rule_without_eligible_falls_through() {
    let u = users(2);
    let first = rule(
        "first",
        Match::default(),
        MemberPool::Members {
            user_ids: vec![u[0]],
        },
        Method::RoundRobin,
    );
    let second = rule(
        "second",
        Match::default(),
        MemberPool::Members {
            user_ids: vec![u[1]],
        },
        Method::LeastLoaded,
    );
    let mut candidates: Vec<Candidate> = u.iter().copied().map(member).collect();
    candidates[0].eligible = false;
    let c = choose(
        &[first, second.clone()],
        DefaultRule::Off,
        &LeadFacts::source_only(SourceKind::Channel),
        &candidates,
        &[],
    );
    assert_eq!((c.user_id, c.rule_id), (Some(u[1]), Some(second.id)));
}

#[test]
fn default_rule_catches_the_rest() {
    let u = users(2);
    let only_forms = rule(
        "forms",
        Match {
            sources: vec![SourceKind::Form],
            ..Match::default()
        },
        MemberPool::Members {
            user_ids: vec![u[0]],
        },
        Method::RoundRobin,
    );
    let candidates: Vec<Candidate> = u.iter().copied().map(member).collect();
    let facts = LeadFacts::source_only(SourceKind::MetaAds);
    let c = choose(
        std::slice::from_ref(&only_forms),
        DefaultRule::On { cursor: Some(u[0]) },
        &facts,
        &candidates,
        &[],
    );
    assert_eq!(
        c,
        Choice {
            user_id: Some(u[1]),
            rule_id: None,
            cause: Cause::Default,
            sla_minutes: None,
        }
    );
    // A solo owner gets everything with no rules at all.
    let solo = [member(u[0])];
    let c = choose(&[], ON, &facts, &solo, &[]);
    assert_eq!((c.user_id, c.cause), (Some(u[0]), Cause::Default));
}

#[test]
fn manual_mode_has_no_default() {
    let u = users(1);
    let candidates = [member(u[0])];
    let c = choose(
        &[],
        DefaultRule::Off,
        &LeadFacts::source_only(SourceKind::Channel),
        &candidates,
        &[],
    );
    assert_eq!(
        c,
        Choice {
            user_id: None,
            rule_id: None,
            cause: Cause::NoEligible,
            sla_minutes: None,
        }
    );
    // With the default on but nobody eligible, the answer is the same.
    let mut away = member(u[0]);
    away.eligible = false;
    let c = choose(
        &[],
        ON,
        &LeadFacts::source_only(SourceKind::Channel),
        &[away],
        &[],
    );
    assert_eq!((c.user_id, c.cause), (None, Cause::NoEligible));
}

#[test]
fn on_shift_members_come_first() {
    let u = users(3);
    let mut candidates: Vec<Candidate> = u.iter().copied().map(member).collect();
    candidates[0].on_shift = false;
    candidates[1].on_shift = false;
    let facts = LeadFacts::source_only(SourceKind::Channel);
    let c = choose(&[], ON, &facts, &candidates, &[]);
    assert_eq!(c.user_id, Some(u[2]), "the only member on shift");
    for c in &mut candidates {
        c.on_shift = false;
    }
    let c = choose(&[], ON, &facts, &candidates, &[]);
    assert_eq!(
        c.user_id,
        Some(u[0]),
        "nobody on shift: every eligible member"
    );
    // Least loaded also looks at the members on shift first.
    candidates[2].on_shift = true;
    candidates[2].open_owned = 9;
    let least = rule(
        "least",
        Match::default(),
        MemberPool::AllEligible,
        Method::LeastLoaded,
    );
    let c = choose(&[least], DefaultRule::Off, &facts, &candidates, &[]);
    assert_eq!(c.user_id, Some(u[2]));
}

#[test]
fn round_robin_wraps_after_cursor() {
    let u = users(3);
    let candidates: Vec<Candidate> = u.iter().copied().map(member).collect();
    let facts = LeadFacts::source_only(SourceKind::Channel);
    let mut r = rule(
        "all",
        Match::default(),
        MemberPool::AllEligible,
        Method::RoundRobin,
    );
    let mut seen = Vec::new();
    for _ in 0..4 {
        let c = choose(
            std::slice::from_ref(&r),
            DefaultRule::Off,
            &facts,
            &candidates,
            &[],
        );
        seen.push(c.user_id.unwrap());
        r.cursor = c.user_id;
    }
    assert_eq!(seen, vec![u[0], u[1], u[2], u[0]]);
    // A cursor naming a member no longer in the pool continues with the next id after it.
    let gone = r.cursor.unwrap();
    let rest: Vec<Candidate> = candidates
        .iter()
        .filter(|c| c.user_id != gone)
        .cloned()
        .collect();
    let c = choose(
        std::slice::from_ref(&r),
        DefaultRule::Off,
        &facts,
        &rest,
        &[],
    );
    assert_eq!(c.user_id, Some(u[1]));
    // The input order of the candidates does not matter.
    let mut reversed = candidates.clone();
    reversed.reverse();
    r.cursor = Some(u[0]);
    let c = choose(
        std::slice::from_ref(&r),
        DefaultRule::Off,
        &facts,
        &reversed,
        &[],
    );
    assert_eq!(c.user_id, Some(u[1]));
}

#[test]
fn least_loaded_breaks_ties_by_round_robin() {
    let u = users(3);
    let mut candidates: Vec<Candidate> = u.iter().copied().map(member).collect();
    candidates[0].open_owned = 2;
    candidates[1].open_owned = 1;
    candidates[2].open_owned = 1;
    let facts = LeadFacts::source_only(SourceKind::Channel);
    let mut r = rule(
        "least",
        Match::default(),
        MemberPool::AllEligible,
        Method::LeastLoaded,
    );
    let c = choose(
        std::slice::from_ref(&r),
        DefaultRule::Off,
        &facts,
        &candidates,
        &[],
    );
    assert_eq!(c.user_id, Some(u[1]));
    r.cursor = Some(u[1]);
    let c = choose(
        std::slice::from_ref(&r),
        DefaultRule::Off,
        &facts,
        &candidates,
        &[],
    );
    assert_eq!(
        c.user_id,
        Some(u[2]),
        "the tie goes to the next after the cursor"
    );
    r.cursor = Some(u[2]);
    let c = choose(
        std::slice::from_ref(&r),
        DefaultRule::Off,
        &facts,
        &candidates,
        &[],
    );
    assert_eq!(c.user_id, Some(u[1]), "wrapping, never the busier member");
}

#[test]
fn rep_filters_apply_only_to_known_facts() {
    let u = users(2);
    let mut candidates: Vec<Candidate> = u.iter().copied().map(member).collect();
    candidates[0].cities = vec!["İzmir".into()];
    candidates[0].languages = vec!["en".into()];
    let in_ankara = prospect_in("Ankara");
    let c = choose(&[], ON, &in_ankara, &candidates, &[]);
    assert_eq!(c.user_id, Some(u[1]), "a known city outside the rep's list");
    let in_izmir = LeadFacts {
        language: Some("EN".into()),
        ..prospect_in("IZMIR")
    };
    let c = choose(&[], ON, &in_izmir, &candidates, &[]);
    assert_eq!(c.user_id, Some(u[0]), "folded city and language");
    let unknown = LeadFacts::source_only(SourceKind::Channel);
    let c = choose(&[], ON, &unknown, &candidates, &[]);
    assert_eq!(
        c.user_id,
        Some(u[0]),
        "unknown facts pass the rep's filters"
    );
}

#[test]
fn excluded_users_are_skipped() {
    let u = users(3);
    let candidates: Vec<Candidate> = u.iter().copied().map(member).collect();
    let facts = LeadFacts::source_only(SourceKind::Channel);
    let c = choose(&[], ON, &facts, &candidates, &[u[0], u[1]]);
    assert_eq!(c.user_id, Some(u[2]));
    let c = choose(&[], ON, &facts, &candidates, &u);
    assert_eq!(c.cause, Cause::NoEligible);
}

#[test]
fn unknown_fact_never_matches_non_empty_list() {
    let unknown = LeadFacts::source_only(SourceKind::Channel);
    assert!(rule_matches(&Match::default(), &unknown));
    assert!(!rule_matches(&cities(&["Ankara"]), &unknown));
    for m in [
        Match {
            sectors: vec!["kuafor".into()],
            ..Match::default()
        },
        Match {
            languages: vec!["tr".into()],
            ..Match::default()
        },
        Match {
            segments: vec!["salons".into()],
            ..Match::default()
        },
        Match {
            min_score: Some(0),
            ..Match::default()
        },
    ] {
        assert!(!rule_matches(&m, &unknown), "{m:?}");
    }
    let known = LeadFacts {
        sector: Some("Kuaför".into()),
        segment: Some("salons".into()),
        language: Some("tr".into()),
        score: Some(70),
        ..prospect_in("Ankara")
    };
    let all = Match {
        sources: vec![SourceKind::Prospect],
        cities: vec!["ANKARA".into()],
        sectors: vec!["kuafor".into()],
        languages: vec!["TR".into()],
        segments: vec!["salons".into()],
        min_score: Some(70),
    };
    assert!(rule_matches(&all, &known));
    assert!(!rule_matches(
        &Match {
            min_score: Some(71),
            ..all.clone()
        },
        &known
    ));
    assert!(!rule_matches(
        &Match {
            sources: vec![SourceKind::Channel],
            ..all
        },
        &known
    ));
}

#[test]
fn stored_rules_and_profiles_read_tolerantly() {
    let user = UserId::new_v7();
    let r = rule(
        "all",
        cities(&["Ankara"]),
        MemberPool::Members {
            user_ids: vec![user],
        },
        Method::LeastLoaded,
    );
    let value = serde_json::to_value(&r).unwrap();
    assert_eq!(value["to"], json!({"kind": "members", "user_ids": [user]}));
    assert_eq!(value["method"], json!("least_loaded"));
    assert_eq!(serde_json::from_value::<Rule>(value).unwrap(), r);
    assert_eq!(
        serde_json::from_value::<Match>(json!({"future": 1})).unwrap(),
        Match::default()
    );
    assert_eq!(
        serde_json::to_value(MemberPool::AllEligible).unwrap(),
        json!({"kind": "all_eligible"})
    );
    for cause in Cause::ALL {
        assert_eq!(serde_json::to_value(cause).unwrap(), json!(cause.key()));
        assert_eq!(Cause::parse(cause.key()), Some(*cause));
    }
    for m in [Method::RoundRobin, Method::LeastLoaded] {
        assert_eq!(Method::parse(m.key()), Some(m));
    }
    let profile: RepProfile = serde_json::from_value(json!({"user_id": user})).unwrap();
    assert_eq!(profile, RepProfile::default_for(user));
    let now = OffsetDateTime::UNIX_EPOCH + Duration::days(1);
    assert!(profile.takes_new(now, 10_000));
    let capped = RepProfile {
        max_open: Some(2),
        ..profile.clone()
    };
    assert!(capped.takes_new(now, 1));
    assert!(!capped.takes_new(now, 2));
    let away = RepProfile {
        away_until: Some(now + Duration::hours(1)),
        ..profile.clone()
    };
    assert!(!away.takes_new(now, 0));
    assert!(away.takes_new(now + Duration::hours(1), 0));
    let closed = RepProfile {
        accepting: false,
        ..profile
    };
    assert!(!closed.takes_new(now, 0));
}

#[test]
fn fold_is_turkish_aware() {
    assert_eq!(fold("İstanbul"), "istanbul");
    assert_eq!(fold("ISPARTA"), "isparta");
    assert_eq!(fold("  Şanlı   Urfa "), "sanli urfa");
    assert_eq!(fold("Kuaför"), "kuafor");
}
