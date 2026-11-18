//! A string literal written over several lines is joined with `\` continuations, so its value
//! has single spaces; a lost continuation leaves the next line's indentation inside the text (a
//! run of spaces in a one-line value). Checked for the content module's SQL (design 2026-11-18).

use jt_archtest::{sql_literals_in, workspace_dir};

#[test]
fn the_production_areas_sql_has_no_runs_of_spaces() {
    let literals: Vec<_> = sql_literals_in(&workspace_dir().join("crates/adapters/jt_pg"))
        .into_iter()
        .filter(|l| l.path.ends_with("repos/studio/projects.rs"))
        .collect();
    assert!(
        literals.len() >= 5,
        "the production areas' SQL is found ({})",
        literals.len()
    );
    for l in literals {
        // A raw string keeps its lines (and their indentation) on purpose.
        if l.text.contains('\n') {
            continue;
        }
        assert!(
            !l.text.contains("     "),
            "{}:{}: a run of spaces in {:?}",
            l.path.display(),
            l.line,
            l.text
        );
    }
}
