//! Warm-up, frequency, budgets, domain pacing and auto-pause arithmetic (spec §3.11, D15; the
//! numbers are product defaults, not provider facts).

mod support;

use jt_outreach::*;
use support::*;
use time::{Date, Duration};

#[test]
fn warmup_schedule_and_cap() {
    let p = WarmupPolicy::default();
    assert_eq!(
        p,
        WarmupPolicy {
            enabled: true,
            start: 20,
            step: 10,
            max: 150
        }
    );
    for (day, cap) in [
        (0, 20),
        (1, 30),
        (12, 140),
        (13, 150),
        (14, 150),
        (u32::MAX, 150),
    ] {
        assert_eq!(warmup_cap(&p, day), cap, "day {day}");
    }
    let flat = WarmupPolicy {
        enabled: true,
        start: 200,
        step: 0,
        max: 150,
    };
    assert_eq!(warmup_cap(&flat, 0), 150, "never above max");
    // A stored partial policy reads every missing key as its default.
    let read: WarmupPolicy = serde_json::from_value(serde_json::json!({"max": 90})).unwrap();
    assert_eq!(
        read,
        WarmupPolicy {
            max: 90,
            ..WarmupPolicy::default()
        }
    );
}

#[test]
fn warmup_disabled_is_unbounded() {
    let p = WarmupPolicy {
        enabled: false,
        ..WarmupPolicy::default()
    };
    assert_eq!(warmup_cap(&p, 0), u32::MAX);
    assert_eq!(warmup_cap(&p, 40), u32::MAX);
}

fn day(offset: i64) -> Date {
    NOW.date() + Duration::days(offset)
}

#[test]
fn warmup_day_index_counts_earlier_send_days_and_resets_after_idle() {
    let today = day(0);
    assert_eq!(warmup_day_index(&[], today), 0);
    assert_eq!(warmup_day_index(&[today], today), 0, "only earlier days");
    assert_eq!(
        warmup_day_index(&[day(-1), day(-3), day(-2), day(-1), today], today),
        3,
        "each day once, in any order"
    );
    assert_eq!(warmup_day_index(&[day(-30)], today), 1);
    assert_eq!(
        warmup_day_index(&[day(-31), day(-40)], today),
        0,
        "the last send is older than 30 days"
    );
    assert_eq!(
        warmup_day_index(&[day(-40), day(-35), day(-3)], today),
        1,
        "an idle stretch over 30 days starts the count again"
    );
    assert_eq!(
        warmup_day_index(&[day(5)], today),
        0,
        "a later day is no earlier day"
    );
}

#[test]
fn frequency_gap_and_window() {
    let f = Frequency::default();
    assert_eq!(
        f,
        Frequency {
            min_gap_days: 3,
            max_per_30_days: 4
        }
    );
    let at = |d: i64| NOW + Duration::days(d);
    assert_eq!(frequency_next_allowed(&f, &[], NOW), None);
    assert_eq!(
        frequency_next_allowed(&f, &[at(-1)], NOW),
        Some(at(2)),
        "three days after the last send"
    );
    assert_eq!(frequency_next_allowed(&f, &[at(-3)], NOW), None);
    let four = [at(-4), at(-29), at(-10), at(-20)];
    assert_eq!(
        frequency_next_allowed(&f, &four, NOW),
        Some(at(1)),
        "the oldest of four in 30 days leaves the window first"
    );
    assert_eq!(
        frequency_next_allowed(&f, &[at(-29), at(-20), at(-10), at(-1)], NOW),
        Some(at(2)),
        "the later of the two rules"
    );
    assert_eq!(
        frequency_next_allowed(&f, &[at(-31), at(-29), at(-20), at(-10)], NOW),
        None,
        "a send 31 days ago is outside the window"
    );
    assert_eq!(
        frequency_next_allowed(&f, &[at(-30), at(-29), at(-20), at(-10)], NOW),
        None,
        "the window is (now - 30 days, now]"
    );
}

#[test]
fn budget_takes_the_smallest_remainder() {
    let base = BudgetInput {
        mailbox_daily_ops_cap: None,
        warmup_cap: 20,
        mailbox_sent_today: 5,
        per_day: 100,
        campaign_sent_today: 0,
        per_hour: 30,
        campaign_sent_last_hour: 0,
    };
    assert_eq!(budget(&base), 1, "at most ⌈per_hour / 60⌉ a minute");
    for (change, expected) in [
        (
            BudgetInput {
                mailbox_sent_today: 20,
                ..base
            },
            0,
        ),
        (
            BudgetInput {
                mailbox_daily_ops_cap: Some(5),
                ..base
            },
            0,
        ),
        (
            BudgetInput {
                warmup_cap: u32::MAX,
                mailbox_sent_today: 500,
                ..base
            },
            0,
        ),
        (
            BudgetInput {
                campaign_sent_today: 100,
                ..base
            },
            0,
        ),
        (
            BudgetInput {
                campaign_sent_last_hour: 30,
                ..base
            },
            0,
        ),
        (
            BudgetInput {
                campaign_sent_last_hour: 31,
                mailbox_sent_today: 30,
                ..base
            },
            0,
        ),
    ] {
        assert_eq!(budget(&change), expected, "{change:?}");
    }
    assert_eq!(MAILBOX_DAY_CEILING, 500);
    assert!(domain_ok(DOMAIN_PER_HOUR - 1));
    assert!(!domain_ok(DOMAIN_PER_HOUR));
    assert_eq!(DOMAIN_POSTPONE, Duration::minutes(20));
}

#[test]
fn auto_pause_on_bounces_and_complaints() {
    use SendOutcome::*;
    let mut recent = vec![Sent; 48];
    recent.extend([Bounced, Bounced]);
    assert_eq!(auto_pause(&recent), None, "2 of 50 is 4 %");
    recent[10] = Bounced;
    assert_eq!(auto_pause(&recent), Some(PauseReason::BounceRate));
    // Only the newest 50 sends count; attempts that never left are no sends.
    let mut recent = vec![Queued, Failed, Refused];
    recent.extend(vec![Sent; 50]);
    recent.extend([Bounced, Bounced, Bounced]);
    assert_eq!(auto_pause(&recent), None);
    let mut recent = vec![Sent; 150];
    recent.push(Complained);
    assert_eq!(auto_pause(&recent), None);
    recent.push(Complained);
    assert_eq!(auto_pause(&recent), Some(PauseReason::Complaints));
    let mut recent = vec![Sent; 199];
    recent.push(Complained);
    recent.push(Complained);
    assert_eq!(auto_pause(&recent), None, "the second is the 201st send");
}
