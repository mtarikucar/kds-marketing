//! Tenant scoping, read from the files themselves (no database):
//!
//! - every SQL literal in `jt_pg` that touches a tenant table names its scope (`workspace_id`, or
//!   the `id` of `workspaces`), unless it is explicitly marked platform-wide;
//! - the platform-wide marker only appears where a platform or user transaction is in hand;
//! - every tenant table has forced row-level security and a policy on `app.workspace_id`.

use std::path::Path;

use jt_archtest::{
    PLATFORM_WIDE_MARKER, SqlLiteral, mentions_word, rust_sources_in, sql_literals_in,
    tenant_tables, up_migrations, workspace_dir,
};

fn jt_pg_dir() -> std::path::PathBuf {
    workspace_dir().join("crates/adapters/jt_pg")
}

/// The file's path relative to the `jt_pg` crate, for messages and exemptions.
fn relative(path: &Path) -> String {
    path.strip_prefix(jt_pg_dir())
        .unwrap_or(path)
        .display()
        .to_string()
}

/// Whether `literal` names the scope of `table`.
fn scoped(literal: &SqlLiteral, table: &str) -> bool {
    let text = literal.text.to_lowercase();
    text.contains("workspace_id") || (table == "workspaces" && text.contains("id = $"))
}

#[test]
fn tenant_tables_are_read_from_the_migrations() {
    let tables = tenant_tables();
    for t in [
        "workspaces",
        "roles",
        "memberships",
        "api_keys",
        "agent_connections",
        "ledger_entries",
    ] {
        assert!(
            tables.iter().any(|x| x == t),
            "{t} is a tenant table: {tables:?}"
        );
    }
    // `sessions.current_workspace_id` is not a `workspace_id` column.
    for t in [
        "users",
        "sessions",
        "platform_operators",
        "platform_sessions",
    ] {
        assert!(!tables.iter().any(|x| x == t), "{t} is not a tenant table");
    }
}

#[test]
fn every_sql_literal_touching_a_tenant_table_mentions_workspace_id() {
    let tables = tenant_tables();
    let literals = sql_literals_in(&jt_pg_dir());
    // The scan must see the repositories' statements, or it would pass vacuously.
    assert!(
        literals.len() >= 40,
        "only {} SQL literals found in jt_pg",
        literals.len()
    );

    let mut checked = 0;
    let mut offences = Vec::new();
    for literal in &literals {
        let touched: Vec<&String> = tables
            .iter()
            .filter(|t| mentions_word(&literal.text, t))
            .collect();
        if touched.is_empty() {
            continue;
        }
        checked += 1;
        if literal.preceding_line.trim() == PLATFORM_WIDE_MARKER {
            continue;
        }
        for table in touched {
            if !scoped(literal, table) {
                offences.push(format!(
                    "{}:{}: touches `{table}` without naming its scope and without \
                     `{PLATFORM_WIDE_MARKER}` on the line before: {}",
                    relative(&literal.path),
                    literal.line,
                    literal.text
                ));
            }
        }
    }
    assert!(
        checked >= 30,
        "only {checked} statements touch a tenant table"
    );
    assert!(offences.is_empty(), "{}", offences.join("\n"));
}

/// `repos/ledger.rs` holds the one shared ledger insert: it takes a plain connection because the
/// tenant, platform and user bundles all call it, so the file imports no platform or user
/// transaction. Its statement names `workspace_id` regardless.
const MARKER_EXEMPT_FILES: &[&str] = &["src/repos/ledger.rs"];

/// The text of every `use` declaration in `source`, each joined onto one line.
fn use_declarations(source: &str) -> Vec<String> {
    let mut decls = Vec::new();
    let mut current: Option<String> = None;
    for line in source.lines() {
        let trimmed = line.trim();
        if current.is_none()
            && (trimmed.starts_with("use ")
                || trimmed.starts_with("pub use ")
                || trimmed.starts_with("pub(crate) use "))
        {
            current = Some(String::new());
        }
        if let Some(decl) = current.as_mut() {
            decl.push_str(trimmed);
            decl.push(' ');
            if trimmed.ends_with(';') {
                decls.push(current.take().unwrap_or_default());
            }
        }
    }
    decls
}

#[test]
fn platform_wide_markers_live_only_in_platform_or_user_files() {
    let mut marked = 0;
    let mut offences = Vec::new();
    for (path, source) in rust_sources_in(&jt_pg_dir()) {
        if !source
            .lines()
            .any(|line| line.trim() == PLATFORM_WIDE_MARKER)
        {
            continue;
        }
        marked += 1;
        let rel = relative(&path);
        if MARKER_EXEMPT_FILES.contains(&rel.as_str()) {
            continue;
        }
        let imports_scope = use_declarations(&source)
            .iter()
            .any(|decl| mentions_word(decl, "PlatformTx") || mentions_word(decl, "UserTx"));
        if !imports_scope {
            offences.push(rel);
        }
    }
    assert!(marked > 0, "no file carries the platform-wide marker");
    assert!(
        offences.is_empty(),
        "files with `{PLATFORM_WIDE_MARKER}` that import neither PlatformTx nor UserTx: {offences:?}"
    );
}

/// `text` with every run of whitespace collapsed to one space, lowercased.
fn normalised(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The `create policy … on <table> …;` statements of `sql` (normalised).
fn policies_on(sql: &str, table: &str) -> Vec<String> {
    let on = format!(" on {table} ");
    sql.match_indices("create policy ")
        .map(|(at, _)| {
            let rest = &sql[at..];
            rest[..rest.find(';').unwrap_or(rest.len())].to_owned()
        })
        .filter(|stmt| stmt.contains(&on))
        .collect()
}

#[test]
fn every_tenant_table_has_force_rls_in_the_migration() {
    let sql = normalised(
        &up_migrations()
            .into_iter()
            .map(|(_, text)| text)
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let mut offences = Vec::new();
    for table in tenant_tables() {
        // `workspaces` is scoped by its own `id`, every other tenant table by `workspace_id`.
        let column = if table == "workspaces" {
            "id"
        } else {
            "workspace_id"
        };
        for clause in ["enable row level security", "force row level security"] {
            if !sql.contains(&format!("alter table {table} {clause}")) {
                offences.push(format!("{table}: no `{clause}`"));
            }
        }
        let policies = policies_on(&sql, &table);
        let scoped = policies.iter().any(|p| {
            p.contains(&format!("using ({column} = "))
                && p.contains(&format!("with check ({column} = "))
                && p.matches("current_setting('app.workspace_id', true)")
                    .count()
                    >= 2
        });
        if !scoped {
            offences.push(format!(
                "{table}: no policy whose `using` and `with check` compare `{column}` with \
                 `app.workspace_id` (policies found: {policies:?})"
            ));
        }
    }
    assert!(offences.is_empty(), "{}", offences.join("\n"));
}
