//! The tool registry: one [`ToolSpec`] per `CATALOG` row with an MCP tool, built from the tool
//! definitions in the private `tools` module.
//!
//! The registry is data: the handler never names a tool. Adding a use case with an MCP tool to
//! the catalog without a definition here (or the reverse) stops the server at startup.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use jt_app::catalog::{CATALOG, Risk};
use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::usecases::Deps;
use jt_tenancy::Permission;
use rmcp::model::{JsonObject, Tool, ToolAnnotations};
use schemars::generate::SchemaSettings;
use schemars::{JsonSchema, Schema};
use serde_json::Value;

use crate::tools;

/// What running a tool yields: its output as JSON, or the error of its use case.
pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, AppError>> + Send + 'a>>;

/// Runs a tool: deserialises its arguments and calls its use case in the caller's context.
pub type ToolRun = for<'a> fn(&'a Deps, &'a Ctx, Value) -> ToolFuture<'a>;

/// One MCP tool.
#[derive(Clone, Debug)]
pub struct ToolSpec {
    /// `jeeta.<domain>.<action>`, as the catalog names it.
    pub name: &'static str,
    /// The id of the use case behind the tool.
    pub use_case: &'static str,
    /// English text for agents, ending with [`risk_tag`] of `risk`.
    pub description: &'static str,
    /// The JSON Schema of the tool's arguments (an object).
    pub input_schema: Schema,
    pub risk: Risk,
    /// What the caller must hold to see the tool in `tools/list` and to call it.
    pub permission: Permission,
    pub run: ToolRun,
}

impl ToolSpec {
    /// The tool as `tools/list` shows it, with read-only and destructive hints from its risk.
    pub fn to_tool(&self) -> Tool {
        let schema: JsonObject = self.input_schema.as_object().cloned().unwrap_or_default();
        Tool::new(self.name, self.description, Arc::new(schema)).annotate(
            ToolAnnotations::new()
                .read_only(self.risk == Risk::Read)
                .destructive(self.risk == Risk::Destructive),
        )
    }
}

/// The suffix every tool description ends with, e.g. `" [risk: READ]"`.
pub fn risk_tag(risk: Risk) -> &'static str {
    match risk {
        Risk::Read => " [risk: READ]",
        Risk::Write => " [risk: WRITE]",
        Risk::Spend => " [risk: SPEND]",
        Risk::Destructive => " [risk: DESTRUCTIVE]",
    }
}

/// Catalog tools not defined here yet: a use case may enter the catalog before its tool, while a
/// plan lands it in steps. [`registry`] leaves them out. Each entry must still be a catalog tool
/// without a definition, so defining one stops the server until it is dropped from here. Empty:
/// every catalog tool is defined (M1b Task 8 defined the connection tools).
pub const NOT_YET_DEFINED: &[&str] = &[];

/// One tool per `CATALOG` row with an MCP tool, in catalog order, but those in
/// [`NOT_YET_DEFINED`].
///
/// # Panics
///
/// When a catalog row with an MCP tool has no definition in the `tools` module (unless it is in
/// [`NOT_YET_DEFINED`]), a definition has no such catalog row, a description does not end with
/// the catalog risk's [`risk_tag`], or an entry of [`NOT_YET_DEFINED`] is defined or not in the
/// catalog: the registry and the catalog must agree before the server starts.
pub fn registry() -> Vec<ToolSpec> {
    let defs = tools::definitions();
    for name in NOT_YET_DEFINED {
        let uc = CATALOG
            .iter()
            .find(|uc| uc.mcp_tool == Some(*name))
            .unwrap_or_else(|| panic!("`{name}` is in NOT_YET_DEFINED but not in the catalog"));
        assert!(
            defs.iter().all(|d| d.use_case != uc.id),
            "`{name}` is defined now; drop it from NOT_YET_DEFINED"
        );
    }
    let mut specs = Vec::new();
    for uc in CATALOG {
        let Some(name) = uc.mcp_tool else { continue };
        if NOT_YET_DEFINED.contains(&name) {
            continue;
        }
        let def = defs
            .iter()
            .find(|d| d.use_case == uc.id)
            .unwrap_or_else(|| panic!("catalog tool `{name}` (`{}`) has no definition", uc.id));
        assert!(
            def.description.ends_with(risk_tag(uc.risk)),
            "the description of `{name}` must end with `{}`",
            risk_tag(uc.risk)
        );
        specs.push(ToolSpec {
            name,
            use_case: uc.id,
            description: def.description,
            input_schema: (def.schema)(),
            risk: uc.risk,
            permission: def.permission,
            run: def.run,
        });
    }
    for def in &defs {
        assert!(
            specs.iter().any(|s| s.use_case == def.use_case),
            "tool definition for `{}` has no catalog row with an MCP tool",
            def.use_case
        );
    }
    specs
}

/// [`registry`] followed by `extra`, e.g. a test-only tool.
///
/// # Panics
///
/// When an extra tool's name is already taken.
pub fn registry_with(extra: Vec<ToolSpec>) -> Vec<ToolSpec> {
    let mut specs = registry();
    for spec in extra {
        assert!(
            specs.iter().all(|s| s.name != spec.name),
            "tool name `{}` is already registered",
            spec.name
        );
        specs.push(spec);
    }
    specs
}

/// The JSON Schema (draft 2020-12) of the arguments type `T`.
pub(crate) fn schema_for<T: JsonSchema>() -> Schema {
    SchemaSettings::draft2020_12()
        .into_generator()
        .into_root_schema_for::<T>()
}
