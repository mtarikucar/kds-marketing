use jt_studio::{
    ContentType, MAX_MATERIAL_LABEL_CHARS, MAX_MATERIAL_LABELS, ProductGroup, SlotNeed,
    StudioError, Tags, normalize_material_labels,
};
use std::collections::BTreeSet;

#[test]
fn labels_are_normalized_deduplicated_and_bounded() {
    let labels = vec![
        "  Fresh   Bread  ".into(),
        "fresh bread".into(),
        "İzmir".into(),
    ];
    assert_eq!(
        normalize_material_labels(&labels).unwrap(),
        BTreeSet::from(["fresh bread".into(), "i\u{307}zmir".into()])
    );
    for invalid in [
        "".to_owned(),
        "   ".to_owned(),
        "hello\nworld".to_owned(),
        "x".repeat(MAX_MATERIAL_LABEL_CHARS + 1),
    ] {
        assert_eq!(
            normalize_material_labels(&[invalid]),
            Err(StudioError::InvalidMaterial("labels"))
        );
    }
    assert!(normalize_material_labels(&vec!["x".into(); MAX_MATERIAL_LABELS + 1]).is_err());
}

#[test]
fn old_tags_and_needs_deserialize_and_legacy_strategy_is_unchanged() {
    let tags: Tags =
        serde_json::from_str(r#"{"product_groups":["figur"],"content_types":["boyama"]}"#).unwrap();
    let need: SlotNeed = serde_json::from_str(r#"{"product_groups":["figur"]}"#).unwrap();
    assert!(tags.labels.is_empty());
    assert!(need.labels.is_empty());
    assert!(need.matches(&tags));
    let parsed = SlotNeed::from_keys("boyama", "unrecognized-business-key");
    assert_eq!(parsed.content_types, BTreeSet::from([ContentType::Boyama]));
    assert!(parsed.labels.is_empty());
    assert!(parsed.matches(&tags));
}

#[test]
fn explicit_business_labels_are_required_alongside_legacy_tags() {
    let tags = Tags {
        product_groups: BTreeSet::from([ProductGroup::Figur]),
        labels: normalize_material_labels(&["  FRESH Bread ".into(), "bakery".into()]).unwrap(),
        ..Tags::default()
    };
    let mut need = SlotNeed {
        product_groups: BTreeSet::from([ProductGroup::Figur]),
        labels: BTreeSet::from(["fresh bread".into()]),
        ..SlotNeed::default()
    };
    assert!(!need.is_empty());
    assert!(need.matches(&tags));
    need.labels.insert("coffee".into());
    assert!(!need.matches(&tags));
    let roundtrip: SlotNeed = serde_json::from_value(serde_json::to_value(&need).unwrap()).unwrap();
    assert_eq!(roundtrip, need);
}

#[test]
fn strategy_requires_only_explicit_label_markers() {
    let need = SlotNeed::from_keys("boyama.label: Fresh Bread", "label:BAKERY/unknown");
    assert_eq!(
        need.labels,
        BTreeSet::from(["fresh bread".into(), "bakery".into()])
    );
    let tags = Tags {
        content_types: BTreeSet::from([ContentType::Boyama]),
        labels: BTreeSet::from(["fresh bread".into(), "bakery".into()]),
        ..Tags::default()
    };
    assert!(need.matches(&tags));
    let invalid = SlotNeed::from_keys("label:", "unknown");
    assert!(!invalid.is_empty());
    assert!(!invalid.matches(&Tags::default()));
}
