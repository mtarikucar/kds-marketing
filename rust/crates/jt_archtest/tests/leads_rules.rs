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

/// The `jeeta.*` names in `text`: each run of lowercase letters, digits, `_`, `.` and `*` after
/// `jeeta.`, a sentence's closing dot left out.
fn jeeta_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("jeeta.") {
        let tail = &rest[i..];
        let end = tail
            .find(|c: char| {
                !(c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '*'))
            })
            .unwrap_or(tail.len());
        names.push(tail[..end].trim_end_matches('.').to_owned());
        rest = &tail[end..];
    }
    names
}

/// Every tool the playbook tells an agent to call is a tool of the MCP registry (a name ending
/// in `.*` stands for a family: some tool starts with it), so the playbook never sends an agent
/// to a tool that does not exist.
#[test]
fn playbook_tools_exist_in_the_catalog() {
    let registry = jt_mcp::registry();
    let names = jeeta_names(jt_prospects::playbook::TEXT);
    assert!(names.len() >= 10, "the playbook names its tools: {names:?}");
    for name in &names {
        let found = match name.strip_suffix(".*") {
            Some(family) => registry
                .iter()
                .any(|t| t.name.starts_with(&format!("{family}."))),
            None => registry.iter().any(|t| t.name == name),
        };
        assert!(found, "the playbook names {name}, which is not an MCP tool");
    }
}

#[test]
fn jeeta_names_reads_families_and_sentence_ends() {
    assert_eq!(
        jeeta_names("call jeeta.work.checkin. Then jeeta.devices.*) and jeeta.prospects.score"),
        [
            "jeeta.work.checkin",
            "jeeta.devices.*",
            "jeeta.prospects.score"
        ]
    );
}
