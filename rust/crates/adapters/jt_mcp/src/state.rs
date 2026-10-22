//! The state the MCP handler shares: the application's ports, the strategy gate and the tools.

use std::sync::Arc;

use jt_app::catalog::{self, UseCase};
use jt_app::gate::StrategyGate;
use jt_app::usecases::Deps;
use rmcp::model::Tool;

use crate::registry::{ToolSpec, registry};

/// The hosts accepted in the `Host` header by default: loopback only (rmcp's DNS-rebinding
/// guard). A public deployment names its own with [`McpState::with_allowed_hosts`].
pub const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1"];

/// A tool with its use case and its `tools/list` form, resolved once.
#[derive(Clone, Debug)]
pub(crate) struct Registered {
    pub spec: ToolSpec,
    pub use_case: &'static UseCase,
    pub tool: Tool,
}

/// What the MCP adapter needs, built once by the binary (or a test).
#[derive(Clone)]
pub struct McpState {
    /// The ports the use cases call.
    pub deps: Deps,
    /// Whether a workspace has an approved strategy, for `Gated` use cases.
    pub gate: Arc<dyn StrategyGate>,
    tools: Arc<Vec<Registered>>,
    allowed_hosts: Arc<Vec<String>>,
}

impl McpState {
    /// The state with every tool of [`registry`], each resolved to its catalog use case, and
    /// [`LOOPBACK_HOSTS`] as the allowed hosts.
    ///
    /// # Panics
    ///
    /// When the registry disagrees with the catalog (see [`registry`]).
    pub fn new(deps: Deps, gate: Arc<dyn StrategyGate>) -> McpState {
        let tools = registry()
            .into_iter()
            .map(|spec| {
                let use_case = catalog::find(spec.use_case).unwrap_or_else(|| {
                    panic!("use case `{}` is not in the catalog", spec.use_case)
                });
                registered(spec, use_case)
            })
            .collect();
        McpState {
            deps,
            gate,
            tools: Arc::new(tools),
            allowed_hosts: Arc::new(LOOPBACK_HOSTS.iter().map(|h| (*h).to_owned()).collect()),
        }
    }

    /// The same state with one more tool, backed by `use_case`, which need not be in the
    /// catalog. Meant for tests (e.g. a `Gated` use case, which M0's catalog does not have yet);
    /// the binary serves [`McpState::new`] as it is.
    ///
    /// # Panics
    ///
    /// When the tool's name is taken, or `spec.use_case` is not `use_case.id`.
    pub fn with_test_tool(mut self, spec: ToolSpec, use_case: &'static UseCase) -> McpState {
        assert_eq!(
            spec.use_case, use_case.id,
            "the tool must name its use case"
        );
        assert!(
            self.tool(spec.name).is_none(),
            "tool name `{}` is already registered",
            spec.name
        );
        Arc::make_mut(&mut self.tools).push(registered(spec, use_case));
        self
    }

    /// The same state accepting these `Host` header values (a host, or `host:port`) on the HTTP
    /// endpoint. An empty list accepts any host, which is not recommended.
    pub fn with_allowed_hosts(
        mut self,
        hosts: impl IntoIterator<Item = impl Into<String>>,
    ) -> McpState {
        self.allowed_hosts = Arc::new(hosts.into_iter().map(Into::into).collect());
        self
    }

    /// The hosts the HTTP endpoint accepts.
    pub fn allowed_hosts(&self) -> &[String] {
        &self.allowed_hosts
    }

    /// The tool called `name`.
    pub(crate) fn tool(&self, name: &str) -> Option<&Registered> {
        self.tools.iter().find(|t| t.spec.name == name)
    }

    /// Every tool, in registration order.
    pub(crate) fn tools(&self) -> impl Iterator<Item = &Registered> {
        self.tools.iter()
    }
}

fn registered(spec: ToolSpec, use_case: &'static UseCase) -> Registered {
    assert_eq!(
        use_case.mcp_tool,
        Some(spec.name),
        "use case `{}` is not exposed as tool `{}`",
        use_case.id,
        spec.name
    );
    Registered {
        tool: spec.to_tool(),
        spec,
        use_case,
    }
}
