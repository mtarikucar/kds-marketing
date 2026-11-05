//! Rules of the leads program (spec `2026-10-30-leads-pool-outreach-design.md`), read from the
//! files themselves.

use jt_archtest::workspace_dir;

/// The spec's Appendix A: the text between the appendix's ```` ```text ```` fence and its close.
fn appendix_a() -> String {
    let path =
        workspace_dir().join("../docs/superpowers/specs/2026-10-30-leads-pool-outreach-design.md");
    let spec = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
        .replace("\r\n", "\n");
    let appendix = spec
        .find("## Appendix A.")
        .expect("the spec has an Appendix A");
    let start = spec[appendix..]
        .find("```text\n")
        .map(|i| appendix + i + "```text\n".len())
        .expect("Appendix A opens a text fence");
    let end = spec[start..]
        .find("\n```")
        .map(|i| start + i)
        .expect("Appendix A closes its fence");
    spec[start..end].to_owned()
}

/// The playbook agents are served (`jt_prospects::playbook::TEXT`) is the spec's Appendix A,
/// word for word, so the two never drift: change both together and bump `PLAYBOOK_VERSION`.
#[test]
fn playbook_text_matches_the_spec_appendix() {
    let served = jt_prospects::playbook::TEXT.replace("\r\n", "\n");
    let spec = appendix_a();
    assert!(
        spec.starts_with("JEETA PROSPECTING PLAYBOOK v1\n"),
        "{spec}"
    );
    assert_eq!(served, spec);
    assert!(
        spec.starts_with(&format!(
            "JEETA PROSPECTING PLAYBOOK v{}",
            jt_prospects::playbook::PLAYBOOK_VERSION
        )),
        "the text's title names its version"
    );
}
