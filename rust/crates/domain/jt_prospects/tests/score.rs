//! Score writes against the workspace's rubric (spec §3.4), and the fixed buckets.

use jt_prospects::*;
use jt_strategy::{Criterion, Rubric};

fn rubric() -> Rubric {
    Rubric {
        criteria: vec![
            Criterion {
                key: "fit".into(),
                description: "sells what we serve".into(),
                weight: 60,
            },
            Criterion {
                key: "size".into(),
                description: "two branches or more".into(),
                weight: 40,
            },
        ],
        qualify_at: 70,
    }
}

fn reason(criterion: &str, points: u8) -> ReasonInput {
    ReasonInput {
        criterion: criterion.into(),
        points,
        evidence: "their menu lists it".into(),
        source: Some(SourceRefInput::Url {
            url: "https://ornek.example.invalid/menu".into(),
            note: None,
        }),
    }
}

fn score(score: u8, reasons: Vec<ReasonInput>) -> ScoreInput {
    ScoreInput {
        score,
        reasons,
        rubric_digest: "d".into(),
    }
}

fn reason_of(input: &ScoreInput) -> (&'static str, &'static str) {
    match validate_score(input, &rubric()) {
        Err(ProspectError::Invalid { field, reason }) => (field, reason),
        Ok(()) => panic!("accepted"),
    }
}

#[test]
fn score_must_equal_sum_of_points() {
    assert_eq!(
        validate_score(
            &score(80, vec![reason("fit", 50), reason("size", 30)]),
            &rubric()
        ),
        Ok(())
    );
    assert_eq!(
        reason_of(&score(81, vec![reason("fit", 50), reason("size", 30)])),
        ("score", "not_the_sum_of_points")
    );
    assert_eq!(
        reason_of(&score(101, vec![reason("fit", 60), reason("size", 41)])),
        ("score", "out_of_range")
    );
}

#[test]
fn every_criterion_exactly_once() {
    assert_eq!(
        reason_of(&score(50, vec![reason("fit", 50)])),
        ("reasons", "missing_criterion")
    );
    assert_eq!(
        reason_of(&score(60, vec![reason("fit", 30), reason("fit", 30)])),
        ("reasons", "duplicate_criterion")
    );
    assert_eq!(
        reason_of(&score(
            60,
            vec![reason("fit", 30), reason("size", 20), reason("price", 10)]
        )),
        ("reasons", "unknown_criterion")
    );
    let mut no_evidence = reason("fit", 30);
    no_evidence.evidence = " ".into();
    assert_eq!(
        reason_of(&score(60, vec![no_evidence, reason("size", 30)])),
        ("reasons", "evidence_length")
    );
    let mut bad_source = reason("fit", 30);
    bad_source.source = Some(SourceRefInput::Url {
        url: "file:///etc".into(),
        note: None,
    });
    assert_eq!(
        reason_of(&score(60, vec![bad_source, reason("size", 30)])),
        ("reasons", "source_not_http")
    );
}

#[test]
fn points_bounded_by_weight() {
    assert_eq!(
        reason_of(&score(100, vec![reason("fit", 61), reason("size", 39)])),
        ("reasons", "points_exceed_weight")
    );
    assert_eq!(
        validate_score(
            &score(100, vec![reason("fit", 60), reason("size", 40)]),
            &rubric()
        ),
        Ok(())
    );
}

#[test]
fn an_empty_rubric_takes_no_score() {
    let empty = Rubric::default();
    assert_eq!(
        validate_score(&score(0, vec![]), &empty),
        Err(ProspectError::Invalid {
            field: "rubric",
            reason: "empty"
        })
    );
}

#[test]
fn buckets_are_fixed() {
    for (s, b, key) in [
        (0, Bucket::B0To24, "0-24"),
        (24, Bucket::B0To24, "0-24"),
        (25, Bucket::B25To49, "25-49"),
        (49, Bucket::B25To49, "25-49"),
        (50, Bucket::B50To74, "50-74"),
        (74, Bucket::B50To74, "50-74"),
        (75, Bucket::B75To100, "75-100"),
        (100, Bucket::B75To100, "75-100"),
    ] {
        assert_eq!(bucket(s), b, "{s}");
        assert_eq!(b.key(), key);
        assert_eq!(serde_json::to_value(b).unwrap(), serde_json::json!(key));
        assert_eq!(Bucket::parse(key), Some(b));
    }
}
