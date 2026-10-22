//! Rebuilding the tenant tier from the capability records.
//!
//! The tenant tier lives in memory, so it is empty after every start, while the hosts it held
//! are kept in the capability records (`connector_public.hosts`). [`rebuild_tenant_hosts`] reads
//! them back. It is meant to run once at start-up, before the server takes requests: a host a
//! use case allowed after its read of a workspace would be dropped by its replace.

use jt_app::error::AppError;
use jt_app::ports::{CapabilityFilter, UnitOfWork};
use jt_app::usecases::capabilities::declared_hosts;
use jt_capability::{Capability, CapabilityKind, Reach, StoredStatus};

use crate::client::Egress;
use crate::public_host::replace_with_public;

/// What [`rebuild_tenant_hosts`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RebuildReport {
    /// The workspaces whose tier was replaced: every workspace.
    pub workspaces: usize,
    /// The hosts the tenant tiers now hold, counted once per workspace.
    pub hosts: usize,
}

/// Replaces every workspace's tenant tier with the hosts its capabilities name: for each
/// workspace, the `connector_public.hosts` of each capability that is not retired and is reached
/// through a connector (its kind's reach, [`CapabilityKind::default_reach`], and its own), as the
/// capability use cases read them. A host [`crate::validate_public_host`] refuses is skipped with
/// a warning. Whatever a tier held before is dropped, so a retired capability's hosts are gone.
///
/// Each workspace is read in its own transaction; an error reading one stops the rebuild with
/// the workspaces before it already replaced.
pub async fn rebuild_tenant_hosts(
    egress: &Egress,
    uow: &dyn UnitOfWork,
) -> Result<RebuildReport, AppError> {
    let workspaces = {
        let mut platform = uow.platform().await?;
        let workspaces = platform.workspaces_list().await?;
        platform.commit().await?;
        workspaces
    };
    let mut report = RebuildReport::default();
    for workspace in workspaces {
        let mut repos = uow.tenant(workspace.id).await?;
        let capabilities = repos
            .capabilities()
            .list(CapabilityFilter::default())
            .await?;
        repos.commit().await?;
        let hosts: Vec<String> = capabilities
            .iter()
            .filter(|c| reaches_through_connector(c))
            .flat_map(declared_hosts)
            .collect();
        report.hosts += replace_with_public(egress, workspace.id, hosts);
        report.workspaces += 1;
    }
    tracing::info!(
        workspaces = report.workspaces,
        hosts = report.hosts,
        "rebuilt the tenant egress tier"
    );
    Ok(report)
}

/// Whether the system reaches `capability` through a connector: not retired, and of a kind on
/// the list whose reach is the connector's.
fn reaches_through_connector(capability: &Capability) -> bool {
    capability.status != StoredStatus::Retired
        && capability.reach == Reach::Connector
        && CapabilityKind::parse(&capability.kind_key)
            .is_some_and(|kind| kind.default_reach() == Reach::Connector)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use jt_app::ports::{TenantHostRegistry, UnitOfWork};
    use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
    use jt_tenancy::{WorkspaceId, WorkspaceStatus};
    use jt_testkit::fakes::{FIXED_NOW, InMemoryUow};
    use serde_json::json;

    use super::*;
    use crate::{Egress, EgressScope, EgressTenantHosts, Url};

    async fn workspace(uow: &InMemoryUow, slug: &str) -> WorkspaceId {
        let ws = WorkspaceId::new_v7();
        let mut user = uow.user().await.unwrap();
        user.workspaces_create(ws, slug, slug, WorkspaceStatus::Active, FIXED_NOW)
            .await
            .unwrap();
        user.commit().await.unwrap();
        ws
    }

    async fn capability(
        uow: &InMemoryUow,
        ws: WorkspaceId,
        kind_key: &str,
        hosts: &[&str],
        status: StoredStatus,
    ) {
        let mut capability = Capability::new(
            CapabilityId::new_v7(),
            ws,
            NewCapability {
                kind_key: kind_key.into(),
                name: format!("{kind_key} {status:?}"),
                connector_public: json!({ "hosts": hosts }),
                ..NewCapability::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        capability.status = status;
        let mut repos = uow.tenant(ws).await.unwrap();
        repos.capabilities().insert(capability, None).await.unwrap();
        repos.commit().await.unwrap();
    }

    fn reaches(egress: &Egress, ws: WorkspaceId, url: &str) -> bool {
        egress.permits(EgressScope::Tenant(ws), &Url::parse(url).unwrap())
    }

    #[tokio::test]
    async fn rebuild_drops_retired_hosts_and_keeps_live_ones() {
        let uow = InMemoryUow::new();
        let (acme, other) = (
            workspace(&uow, "acme").await,
            workspace(&uow, "other").await,
        );
        // Two connector capabilities of one workspace, one of them retired.
        capability(
            &uow,
            acme,
            "mailbox",
            &["imap.live.example", " smtp.live.example:465 "],
            StoredStatus::Verified,
        )
        .await;
        capability(
            &uow,
            acme,
            "mailbox",
            &["imap.retired.example"],
            StoredStatus::Retired,
        )
        .await;
        // Hosts of a capability the system does not reach are not the tier's; a stored host that
        // is not public is skipped.
        capability(
            &uow,
            acme,
            "notion",
            &["api.notion.example"],
            StoredStatus::Declared,
        )
        .await;
        capability(
            &uow,
            other,
            "instagram",
            &["127.0.0.1", "hooks.other.example"],
            StoredStatus::Unreachable,
        )
        .await;

        let egress = Egress::new(&[]);
        // What the tier held before (the retired capability's host, a stale one) is replaced.
        egress.allow_tenant_host(acme, "imap.retired.example");
        egress.allow_tenant_host(acme, "stale.example");

        let report = rebuild_tenant_hosts(&egress, &uow).await.unwrap();
        assert_eq!(
            report,
            RebuildReport {
                workspaces: 2,
                hosts: 3
            }
        );

        assert!(reaches(&egress, acme, "https://imap.live.example/"));
        assert!(reaches(&egress, acme, "https://smtp.live.example:465/"));
        assert!(!reaches(&egress, acme, "https://smtp.live.example/"));
        assert!(!reaches(&egress, acme, "https://imap.retired.example/"));
        assert!(!reaches(&egress, acme, "https://stale.example/"));
        assert!(!reaches(&egress, acme, "https://api.notion.example/"));
        assert!(reaches(&egress, other, "https://hooks.other.example/"));
        assert!(!reaches(&egress, other, "https://127.0.0.1/"));
        // Each workspace keeps to its own hosts.
        assert!(!reaches(&egress, other, "https://imap.live.example/"));
        assert!(!reaches(&egress, acme, "https://hooks.other.example/"));

        // Rebuilding again changes nothing.
        assert_eq!(rebuild_tenant_hosts(&egress, &uow).await.unwrap(), report);
        assert!(reaches(&egress, acme, "https://imap.live.example/"));
    }

    #[tokio::test]
    async fn rebuild_with_no_workspace_is_empty() {
        let report = rebuild_tenant_hosts(&Egress::new(&[]), &InMemoryUow::new())
            .await
            .unwrap();
        assert_eq!(
            report,
            RebuildReport {
                workspaces: 0,
                hosts: 0
            }
        );
    }

    #[test]
    fn rebuild_from_replaces_a_workspaces_tier() {
        let egress = Arc::new(Egress::new(&[]));
        let hosts = EgressTenantHosts::new(Arc::clone(&egress));
        let (ws, other) = (WorkspaceId::new_v7(), WorkspaceId::new_v7());
        hosts.allow(ws, "old.example").unwrap();
        hosts.allow(other, "other.example").unwrap();

        let kept = hosts
            .rebuild_from(
                ws,
                vec![
                    "new.example".into(),
                    "NEW.example".into(),
                    "mail.example:993".into(),
                    "127.0.0.1".into(),
                    "nas.lan".into(),
                    "not a host".into(),
                ],
            )
            .unwrap();
        assert_eq!(kept, 2);
        assert!(reaches(&egress, ws, "https://new.example/"));
        assert!(reaches(&egress, ws, "https://mail.example:993/"));
        assert!(!reaches(&egress, ws, "https://old.example/"));
        assert!(!reaches(&egress, ws, "https://127.0.0.1/"));
        // Another workspace's tier is untouched.
        assert!(reaches(&egress, other, "https://other.example/"));

        // Nothing at all empties the tier.
        assert_eq!(hosts.rebuild_from(ws, Vec::new()).unwrap(), 0);
        assert!(!reaches(&egress, ws, "https://new.example/"));
    }
}
