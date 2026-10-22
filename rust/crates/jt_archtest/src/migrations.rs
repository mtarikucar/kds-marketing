//! The migrations as text: which tables are tenant tables.

use std::fs;
use std::path::PathBuf;

use crate::workspace_dir;

/// Every `migrations/*.up.sql` of the workspace, in file-name order, with `--` comments removed.
///
/// Panics when the directory cannot be read or holds no up migration, so a moved directory
/// cannot make the scans pass vacuously.
pub fn up_migrations() -> Vec<(PathBuf, String)> {
    let dir = workspace_dir().join("migrations");
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| entry.expect("cannot read a migrations entry").path())
        .filter(|p| p.to_string_lossy().ends_with(".up.sql"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no up migration in {}", dir.display());
    paths
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
            (path, strip_comments(&text))
        })
        .collect()
}

/// `sql` without its `--` line comments.
fn strip_comments(sql: &str) -> String {
    sql.lines()
        .map(|line| line.find("--").map_or(line, |at| &line[..at]))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The tenant tables: every table an up migration creates with a column named `workspace_id`,
/// plus `workspaces` itself (scoped by its `id`). Sorted, without duplicates.
pub fn tenant_tables() -> Vec<String> {
    let mut tables: Vec<String> = up_migrations()
        .iter()
        .flat_map(|(_, sql)| tables_with_workspace_id(sql))
        .collect();
    tables.push("workspaces".to_owned());
    tables.sort();
    tables.dedup();
    tables
}

/// The tables `create table [if not exists] <name> (…)` statements in `sql` create with a column
/// literally named `workspace_id`. Only the first word of each column definition counts, so a
/// column such as `current_workspace_id`, or a constraint mentioning `workspace_id`, does not.
pub(crate) fn tables_with_workspace_id(sql: &str) -> Vec<String> {
    let lower = sql.to_lowercase();
    let mut tables = Vec::new();
    let mut rest = lower.as_str();
    while let Some(at) = rest.find("create table") {
        rest = &rest[at + "create table".len()..];
        let mut head = rest.trim_start();
        if let Some(after) = head.strip_prefix("if not exists") {
            head = after.trim_start();
        }
        let Some(open) = head.find('(') else { break };
        let name = unquote(head[..open].trim());
        let Some(columns) = parenthesised(&head[open..]) else {
            break;
        };
        let has_column = top_level_items(columns)
            .iter()
            .filter_map(|item| item.split_whitespace().next())
            .any(|first| unquote(first) == "workspace_id");
        if has_column && !name.is_empty() {
            tables.push(name.to_owned());
        }
        rest = &head[open + columns.len()..];
    }
    tables
}

/// An identifier without surrounding double quotes.
fn unquote(ident: &str) -> &str {
    ident.trim_matches('"')
}

/// The text inside the parentheses that open `text` (which starts with `(`), up to the matching
/// `)`; `None` when they never close.
fn parenthesised(text: &str) -> Option<&str> {
    let mut depth = 0usize;
    for (i, c) in text.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[1..i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// `list` split at the commas outside any parentheses, each item trimmed.
fn top_level_items(list: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let (mut depth, mut start) = (0usize, 0usize);
    for (i, c) in list.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                items.push(list[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    items.push(list[start..].trim());
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tables_with_a_workspace_id_column_are_tenant_tables() {
        let sql = "
            create table if not exists workspaces (id uuid primary key, name text not null);
            create table if not exists sessions (
                id uuid primary key,
                current_workspace_id uuid references workspaces (id) on delete set null
            );
            CREATE TABLE \"Roles\" (
                id uuid primary key,
                \"workspace_id\" uuid not null references workspaces (id),
                status text check (status in ('a', 'b')),
                unique (workspace_id, key)
            );
            create table notes (
                id uuid,
                body text,
                constraint ws check (body <> 'workspace_id'),
                workspace_id uuid not null
            );
            create table links (id uuid, unique (workspace_id, id));
        ";
        assert_eq!(tables_with_workspace_id(sql), ["roles", "notes"]);
    }

    #[test]
    fn line_comments_are_stripped() {
        assert_eq!(
            strip_comments("a -- create table x (workspace_id uuid)\nb"),
            "a \nb"
        );
    }
}
