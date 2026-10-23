//! Parse Rust syntax and SQL tokens, including SQL nested in repository macros.
use proc_macro2::{TokenStream, TokenTree};
use std::{
    fs,
    path::{Path, PathBuf},
};
use syn::visit::Visit;
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

// Identifier boundaries, strings and comments matter: never a `status =` grep.
fn sql_tokens(sql: &str) -> Vec<String> {
    let mut chars = sql.chars().peekable();
    let mut out = Vec::new();
    while let Some(c) = chars.next() {
        match c {
            '-' if chars.peek() == Some(&'-') => {
                chars.next();
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut depth = 1;
                while let Some(c) = chars.next() {
                    if c == '/' && chars.peek() == Some(&'*') {
                        chars.next();
                        depth += 1;
                    }
                    if c == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                }
                assert_eq!(depth, 0, "unterminated SQL comment");
            }
            '\'' => {
                while let Some(c) = chars.next() {
                    if c == '\'' {
                        if chars.peek() == Some(&'\'') {
                            chars.next();
                        } else {
                            break;
                        }
                    }
                }
                out.push("<value>".into());
            }
            '"' => {
                let mut name = String::new();
                while let Some(c) = chars.next() {
                    if c == '"' {
                        if chars.peek() == Some(&'"') {
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    name.push(c);
                }
                out.push(name.to_ascii_lowercase());
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let mut word = String::from(c);
                while chars
                    .peek()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
                {
                    word.push(chars.next().unwrap());
                }
                out.push(word.to_ascii_lowercase());
            }
            c if !c.is_whitespace() => out.push(c.to_string()),
            _ => {}
        }
    }
    out
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatusWrite {
    Insert,
    Update,
}
fn status_writes(sql: &str) -> usize {
    journey_status_writes(sql).len()
}
fn journey_status_writes(sql: &str) -> Vec<StatusWrite> {
    let t = sql_tokens(sql);
    let mut writes = Vec::new();
    for (i, token) in t.iter().enumerate() {
        let insert = token == "insert";
        if !insert && token != "update" {
            continue;
        }
        let mut target = i + 1;
        if insert {
            if t.get(target).map(String::as_str) != Some("into") {
                continue;
            }
            target += 1;
        }
        if t.get(target).map(String::as_str) == Some("only") {
            target += 1;
        }
        if t.get(target + 1).map(String::as_str) == Some(".") {
            target += 2;
        }
        if t.get(target).map(String::as_str) != Some("journeys") {
            continue;
        }
        if insert {
            // Every INSERT creates a status, even when its column is omitted and SQL supplies
            // a default. Column-list tricks must never bypass the domain creation proof.
            writes.push(StatusWrite::Insert);
        } else {
            let rest = &t[target + 1..];
            let set = rest
                .iter()
                .position(|s| s == "set")
                .expect("UPDATE without SET");
            let assignments: Vec<_> = rest[set + 1..]
                .iter()
                .take_while(|s| !["where", "returning", ";"].contains(&s.as_str()))
                .collect();
            // Parse assignment LHS (including tuple assignment), stopping at its equals sign.
            let mut lhs = true;
            let mut depth = 0;
            for s in assignments {
                match s.as_str() {
                    "(" => depth += 1,
                    ")" => depth -= 1,
                    "=" if depth == 0 => lhs = false,
                    "," if depth == 0 => lhs = true,
                    "status" if lhs => writes.push(StatusWrite::Update),
                    _ => {}
                }
            }
        }
    }
    writes
}
#[derive(Default)]
struct Literals(Vec<String>);
impl<'ast> Visit<'ast> for Literals {
    fn visit_lit_str(&mut self, lit: &'ast syn::LitStr) {
        self.0.push(lit.value());
    }
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        self.tokens(mac.tokens.clone());
    }
}
impl Literals {
    fn tokens(&mut self, stream: TokenStream) {
        for token in stream {
            match token {
                TokenTree::Group(g) => self.tokens(g.stream()),
                TokenTree::Literal(l) => {
                    if let Ok(s) = syn::parse_str::<syn::LitStr>(&l.to_string()) {
                        self.0.push(s.value());
                    }
                }
                _ => {}
            }
        }
    }
}
// Undo restores the parent of an EXISTING row, not an initial journey. This single SQL
// statement is audited explicitly in merges.rs::restore_snapshot. It cannot change status;
// adding an INSERT or status assignment there must still fail the creation/reducer rule.
const MERGE_JOURNEY_PARENT_RESTORE: &str =
    "update journeys set person_id=$3,updated_at=$4 where workspace_id=$1 and id=$2";

#[derive(Default)]
struct Writes {
    owner: Option<(String, Vec<String>)>,
    count: usize,
    inserts: usize,
    updates: usize,
    merge_restore_allowed: bool,
    restores: usize,
    violations: Vec<String>,
}
impl Writes {
    fn literal(&mut self, sql: &str) {
        if self.merge_restore_allowed
            && sql == MERGE_JOURNEY_PARENT_RESTORE
            && self
                .owner
                .as_ref()
                .is_some_and(|(name, _)| name == "restore_snapshot")
        {
            self.restores += 1;
            assert!(
                journey_status_writes(sql).is_empty(),
                "snapshot exception must never write status"
            );
            return;
        }
        for write in journey_status_writes(sql) {
            self.count += 1;
            let (method, proof) = match write {
                StatusWrite::Insert => {
                    self.inserts += 1;
                    ("insert_initial", "InitialJourney")
                }
                StatusWrite::Update => {
                    self.updates += 1;
                    ("apply_transition", "Transition")
                }
            };
            if !self
                .owner
                .as_ref()
                .is_some_and(|(name, types)| name == method && types.iter().any(|t| t == proof))
            {
                self.violations.push(
                    self.owner
                        .as_ref()
                        .map_or("<outside a function>", |(name, _)| name)
                        .to_owned(),
                );
            }
        }
    }
    fn function(&mut self, sig: &syn::Signature, block: &syn::Block) {
        let types = sig
            .inputs
            .iter()
            .filter_map(|arg| match arg {
                syn::FnArg::Typed(arg) => match arg.ty.as_ref() {
                    syn::Type::Path(p) => p.path.segments.last().map(|s| s.ident.to_string()),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        let previous = self.owner.replace((sig.ident.to_string(), types));
        self.visit_block(block);
        self.owner = previous;
    }
}
impl<'ast> Visit<'ast> for Writes {
    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        self.function(&item.sig, &item.block);
    }
    fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
        self.function(&item.sig, &item.block);
    }
    fn visit_lit_str(&mut self, lit: &'ast syn::LitStr) {
        self.literal(&lit.value());
    }
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        let mut literals = Literals::default();
        literals.tokens(mac.tokens.clone());
        for sql in literals.0 {
            self.literal(&sql);
        }
    }
}
fn inspect(source: &str) -> Writes {
    let mut writes = Writes::default();
    writes.visit_file(&syn::parse_file(source).unwrap());
    writes
}
#[test]
fn inbox_status_written_only_by_reducer() {
    let mut files = Vec::new();
    rust_files(&root().join("crates/adapters/jt_pg/src"), &mut files);
    let (mut inserts, mut updates, mut restores) = (0, 0, 0);
    for path in files {
        let mut writes = Writes {
            merge_restore_allowed: path.ends_with("repos/inbox/merges.rs"),
            ..Writes::default()
        };
        writes.visit_file(&syn::parse_file(&fs::read_to_string(&path).unwrap()).unwrap());
        assert!(
            writes.violations.is_empty(),
            "{}: journeys.status must use insert_initial(InitialJourney) for INSERT and apply_transition(Transition) for UPDATE: {:?}",
            path.display(),
            writes.violations
        );
        inserts += writes.inserts;
        updates += writes.updates;
        restores += writes.restores;
    }
    assert_eq!(
        (inserts, updates),
        (1, 1),
        "audit every status INSERT and UPDATE"
    );
    assert_eq!(
        restores, 1,
        "audit exactly the existing-row parent restore statement"
    );
}
#[test]
fn creation_and_update_proofs_cannot_be_swapped() {
    let valid = inspect(
        r#"
        impl Repo {
            fn insert_initial(&mut self, initial: jt_inbox::InitialJourney) { query!("insert into journeys select * from seed"); }
            fn apply_transition(&mut self, transition: Transition) { query!("update journeys set status=$1"); }
        }
    "#,
    );
    assert_eq!((valid.inserts, valid.updates), (1, 1));
    assert!(valid.violations.is_empty());
    for source in [
        r#"fn insert_initial(initial: Transition) { query!("insert into journeys select * from seed"); }"#,
        r#"fn apply_transition(transition: InitialJourney) { query!("update journeys set status=$1"); }"#,
        r#"fn insert_initial(initial: InitialJourney) { query!("update journeys set status=$1"); }"#,
        r#"fn apply_transition(transition: Transition) { query!("insert into journeys select * from seed"); }"#,
        r#"fn restore_snapshot(snapshot: Snapshot) { query!("update journeys set person_id=$3,status=$4 where workspace_id=$1 and id=$2"); }"#,
    ] {
        assert_eq!(inspect(source).violations.len(), 1, "{source}");
    }
}
#[test]
fn structural_scan_detects_helpers_macros_and_missing_transition_parameter() {
    let writes = inspect(
        r#"
        const BYPASS: &str = "insert into journeys select * from seed";
        fn helper() { sqlx::query("update journeys set status=$1"); }
        impl Repo {
            fn apply_transition(&mut self, transition: jt_inbox::Transition) {
                query!("update journeys set status=$1");
            }
            fn raw(&mut self) { execute!(wrap!("insert into journeys (status) values ($1)")); }
        }
    "#,
    );
    assert_eq!(writes.count, 4);
    assert_eq!(writes.violations, ["<outside a function>", "helper", "raw"]);
    let writes = inspect(
        r#"fn apply_transition(status: String) { query!("update journeys set status=$1"); }"#,
    );
    assert_eq!(writes.violations, ["apply_transition"]);
}
#[test]
fn sql_write_parser_covers_insert_update_and_ignores_comments_and_values() {
    for sql in [
        "INSERT INTO journeys SELECT * FROM jsonb_populate_record(null::journeys,$1)",
        "insert into public.journeys (id, status) values ($1,$2)",
        "insert into journeys (id) values ($1)",
        "UPDATE \"journeys\" SET \"status\"=$1 WHERE id=$2",
        "with x as (select 1) update journeys j set owner_id=$1, status=$2 where id=$3",
        "update journeys set (status, closed_at) = ($1,$2)",
    ] {
        assert_eq!(status_writes(sql), 1, "{sql}");
    }
    for sql in [
        "update journeys set owner_id=$1 where status=$2",
        "insert into journey_events values ('update journeys set status=1')",
        "-- update journeys set status=1\n select 1",
        "/* insert into journeys select 1 */ select 'status'",
    ] {
        assert_eq!(status_writes(sql), 0, "{sql}");
    }
}
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}
#[test]
fn single_match_or_create_definition() {
    #[derive(Default)]
    struct Definitions(usize);
    impl<'ast> Visit<'ast> for Definitions {
        fn visit_signature(&mut self, sig: &'ast syn::Signature) {
            if sig.ident == "match_or_create" {
                self.0 += 1;
            }
            syn::visit::visit_signature(self, sig);
        }
    }
    let mut files = Vec::new();
    rust_files(&root().join("crates"), &mut files);
    let mut definitions = Definitions::default();
    for path in files
        .into_iter()
        .filter(|p| p.components().any(|c| c.as_os_str() == "src"))
    {
        definitions.visit_file(&syn::parse_file(&fs::read_to_string(path).unwrap()).unwrap());
    }
    assert_eq!(definitions.0, 1);
}
#[test]
fn inbox_catalog_schemas_match_both_surfaces() {
    let tools = jt_mcp::registry();
    let rows: Vec<_> = jt_app::catalog::CATALOG
        .iter()
        .filter(|r| r.id.starts_with("inbox."))
        .collect();
    assert_eq!(rows.len(), 46);
    for row in rows {
        let tool = tools.iter().find(|t| Some(t.name) == row.mcp_tool).unwrap();
        assert_eq!(
            tool.input_schema.as_value(),
            &jt_app::usecases::inbox::schema::tool(row.id.strip_prefix("inbox.").unwrap())
        );
        assert_eq!(tool.input_schema.as_value()["additionalProperties"], false);
    }
}

#[test]
fn forged_transition_bypass_injection_rejected() {
    let source = fs::read_to_string(root().join("crates/domain/jt_inbox/src/journey.rs")).unwrap();
    let file = syn::parse_file(&source).unwrap();
    for (name, expected_examples) in [("Transition", 4), ("InitialJourney", 5)] {
        let transition = file
            .items
            .iter()
            .find_map(|item| match item {
                syn::Item::Struct(item) if item.ident == name => Some(item),
                _ => None,
            })
            .unwrap();
        assert!(
            transition
                .fields
                .iter()
                .all(|field| matches!(field.vis, syn::Visibility::Inherited))
        );
        let mut compile_fail_examples = 0;
        for attr in &transition.attrs {
            if attr.path().is_ident("derive") {
                let derives = attr
                    .parse_args_with(
                        syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
                    )
                    .unwrap();
                assert!(
                    derives
                        .iter()
                        .all(|path| !path.is_ident("Deserialize") && !path.is_ident("Default"))
                );
            }
            if let syn::Meta::NameValue(meta) = &attr.meta
                && meta.path.is_ident("doc")
                && let syn::Expr::Lit(lit) = &meta.value
                && let syn::Lit::Str(doc) = &lit.lit
                && doc.value().trim() == "```compile_fail"
            {
                compile_fail_examples += 1;
            }
        }
        // The final workspace doc-test run compiles these attempted injection routes.
        assert_eq!(compile_fail_examples, expected_examples, "{name}");
    }
}

#[test]
fn initial_journey_has_only_domain_defined_start_state() {
    use jt_inbox::{JourneyId, JourneyStatus, PersonId, ReduceInput, Source, begin_journey};
    use jt_tenancy::WorkspaceId;
    let id = JourneyId::new_v7();
    let workspace_id = WorkspaceId::new_v7();
    let person_id = PersonId::new_v7();
    let at = jt_testkit::fakes::FIXED_NOW;
    let initial = begin_journey(id, workspace_id, person_id, Source::Repeat, at);
    let row = initial.journey();
    assert_eq!(
        (row.id, row.workspace_id, row.person_id),
        (id, workspace_id, person_id)
    );
    assert_eq!(row.source, Source::Repeat);
    assert_eq!((row.opened_at, row.updated_at), (at, at));
    assert_eq!(row.status, JourneyStatus::New);
    assert_eq!(row.unreachable_attempts, 0);
    assert_eq!(row.reduce_input, ReduceInput::default());
    assert!(row.owner.is_none() && row.closed_at.is_none() && row.lost_reason.is_none());
    let mut copy = row.clone();
    copy.status = JourneyStatus::Won;
    assert_eq!(initial.journey().status, JourneyStatus::New);
}
