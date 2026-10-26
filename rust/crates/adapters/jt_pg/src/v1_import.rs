//! Import extension over the existing tenant bundle. No DDL, migrations or platform transactions.
use crate::{PgTenantRepos, TenantTx};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::v1_import::{ImportRepos, ImportStore},
};
use jt_inbox::{IdentityChannel, PersonId};
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

/// An ordinary-role pool used only after the binary's schema and RLS gates.
pub struct PgImportStore(pub PgPool);
#[async_trait]
impl ImportStore for PgImportStore {
    async fn begin(&self, workspace: WorkspaceId) -> Result<Box<dyn ImportRepos>, AppError> {
        let tx = TenantTx::begin(&self.0, workspace)
            .await
            .map_err(|_| refused())?;
        Ok(Box::new(PgTenantRepos { tx }))
    }
}
fn refused() -> AppError {
    AppError::internal("v1 import database_failed")
}

/// Explicit set of import-created child tables. Other children make the aggregate ineligible.
const CHILDREN: &[(&str, &str)] = &[
    ("identities", "person_id=$2"),
    ("consents", "person_id=$2"),
    ("suppressions", "person_id=$2"),
    ("journeys", "person_id=$2"),
    (
        "notes",
        "journey_id in (select id from journeys where workspace_id=$1 and person_id=$2)",
    ),
    (
        "tasks",
        "journey_id in (select id from journeys where workspace_id=$1 and person_id=$2)",
    ),
];

impl PgTenantRepos {
    async fn import_fingerprint(&mut self, person: PersonId) -> Result<String, AppError> {
        let ws = self.workspace_id().as_uuid();
        let person_row: Value = sqlx::query_scalar("select to_jsonb(p) #- '{first_touch,v1_checkpoint}' from people p where workspace_id=$1 and id=$2")
            .bind(ws).bind(person.as_uuid()).fetch_one(self.tx.conn()).await.map_err(|_| refused())?;
        let mut rows = vec![person_row];
        for (table, filter) in CHILDREN {
            // Static table/filter pairs above; never derived from the input file.
            let row: Value = sqlx::query_scalar(&format!("select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) from {table} t where workspace_id=$1 and {filter}"))
                .bind(ws).bind(person.as_uuid()).fetch_one(self.tx.conn()).await.map_err(|_| refused())?;
            rows.push(row);
        }
        Ok(hex::encode(Sha256::digest(
            serde_json::to_vec(&rows).map_err(|_| refused())?,
        )))
    }
    async fn import_lock_graph(&mut self, person: PersonId) -> Result<Option<Value>, AppError> {
        let ws = self.workspace_id().as_uuid();
        // Parent FOR UPDATE also fences concurrent child insertion through the composite FKs.
        let first: Option<Value> = sqlx::query_scalar(
            "select first_touch from people where workspace_id=$1 and id=$2 for update",
        )
        .bind(ws)
        .bind(person.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|_| refused())?;
        if first.is_none() {
            return Ok(None);
        }
        for (table, filter) in CHILDREN {
            sqlx::query(&format!(
                "select 1 from {table} where workspace_id=$1 and {filter} for update"
            ))
            .bind(ws)
            .bind(person.as_uuid())
            .fetch_all(self.tx.conn())
            .await
            .map_err(|_| refused())?;
        }
        Ok(first)
    }
}
#[async_trait]
impl ImportRepos for PgTenantRepos {
    async fn identity_owner(
        &mut self,
        channel: IdentityChannel,
        value: &str,
    ) -> Result<Option<PersonId>, AppError> {
        let channel = serde_json::to_value(channel).map_err(|_| refused())?;
        let id: Option<Uuid> = sqlx::query_scalar("select person_id from identities where workspace_id=$1 and channel=$2 and value_normalized=$3 and active")
            .bind(self.workspace_id().as_uuid()).bind(channel.as_str()).bind(value)
            .fetch_optional(self.tx.conn()).await.map_err(|_| refused())?;
        Ok(id.map(Into::into))
    }
    async fn imported_lead(&mut self, lead: &str) -> Result<Option<PersonId>, AppError> {
        let id: Option<Uuid> = sqlx::query_scalar("select id from people where workspace_id=$1 and first_touch->>'system'='v1' and first_touch->>'kind'='import' and first_touch->'v1_leads' @> $2::jsonb order by id limit 1")
            .bind(self.workspace_id().as_uuid()).bind(json!([{ "v1_lead_id": lead }]))
            .fetch_optional(self.tx.conn()).await.map_err(|_| refused())?;
        Ok(id.map(Into::into))
    }
    async fn untouched(&mut self, person: PersonId) -> Result<bool, AppError> {
        let Some(first) = self.import_lock_graph(person).await? else {
            return Ok(false);
        };
        if first["system"] != "v1" || first["kind"] != "import" {
            return Ok(false);
        }
        let Some(expected) = first["v1_checkpoint"].as_str() else {
            return Ok(false);
        };
        let used: bool = sqlx::query_scalar("select exists(select 1 from conversations where workspace_id=$1 and person_id=$2) or exists(select 1 from merges where workspace_id=$1 and (source_id=$2 or target_id=$2)) or exists(select 1 from people where workspace_id=$1 and merged_into=$2) or exists(select 1 from erasure_log where workspace_id=$1 and person_id=$2) or exists(select 1 from journeys j where workspace_id=$1 and person_id=$2 and (exists(select 1 from journey_events e where e.workspace_id=$1 and e.journey_id=j.id) or exists(select 1 from quotes q where q.workspace_id=$1 and q.journey_id=j.id) or exists(select 1 from appointments a where a.workspace_id=$1 and a.journey_id=j.id) or exists(select 1 from commissions c where c.workspace_id=$1 and c.journey_id=j.id) or exists(select 1 from journey_attribution a where a.workspace_id=$1 and a.journey_id=j.id))) or exists(select 1 from messages m join identities i on i.workspace_id=m.workspace_id and i.id=m.sender_identity_id where m.workspace_id=$1 and i.person_id=$2) or exists(select 1 from conversations c join identities i on i.workspace_id=c.workspace_id and i.id=c.last_inbound_identity_id where c.workspace_id=$1 and i.person_id=$2)")
            .bind(self.workspace_id().as_uuid()).bind(person.as_uuid()).fetch_one(self.tx.conn()).await.map_err(|_| refused())?;
        Ok(!used && self.import_fingerprint(person).await? == expected)
    }
    async fn checkpoint(
        &mut self,
        person: PersonId,
        lead: &str,
        provenance: Value,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id().as_uuid();
        // Keep the first lead's attribution; retain every duplicate's source and stage separately.
        sqlx::query("update people set first_touch=(case when first_touch->>'system'='v1' then first_touch else first_touch || $3 end) || jsonb_build_object('v1_leads',coalesce(first_touch->'v1_leads','[]'::jsonb) || jsonb_build_array($3::jsonb)) where workspace_id=$1 and id=$2")
            .bind(ws).bind(person.as_uuid()).bind(provenance).execute(self.tx.conn()).await.map_err(|_| refused())?;
        // Preserve the typed dictionary shape while also recording the requested import shape.
        sqlx::query("update journeys set lost_reason=lost_reason || jsonb_build_object('kind','import','text',lost_reason->>'reason_label') where workspace_id=$1 and person_id=$2 and source->>'v1_lead_id'=$3 and lost_reason is not null")
            .bind(ws).bind(person.as_uuid()).bind(lead).execute(self.tx.conn()).await.map_err(|_| refused())?;
        let hash = self.import_fingerprint(person).await?;
        sqlx::query("update people set first_touch=jsonb_set(first_touch,'{v1_checkpoint}',to_jsonb($3::text)) where workspace_id=$1 and id=$2")
            .bind(ws).bind(person.as_uuid()).bind(hash).execute(self.tx.conn()).await.map_err(|_| refused())?;
        Ok(())
    }
    async fn rollback_import(&mut self, person: PersonId) -> Result<bool, AppError> {
        if !self.untouched(person).await? {
            return Ok(false);
        }
        let ws = self.workspace_id().as_uuid();
        for table in ["notes", "tasks"] {
            sqlx::query(&format!("delete from {table} where workspace_id=$1 and journey_id in (select id from journeys where workspace_id=$1 and person_id=$2)"))
                .bind(ws).bind(person.as_uuid()).execute(self.tx.conn()).await.map_err(|_| refused())?;
        }
        for table in ["consents", "suppressions", "identities", "journeys"] {
            sqlx::query(&format!(
                "delete from {table} where workspace_id=$1 and person_id=$2"
            ))
            .bind(ws)
            .bind(person.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|_| refused())?;
        }
        sqlx::query("delete from people where workspace_id=$1 and id=$2")
            .bind(ws)
            .bind(person.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|_| refused())?;
        Ok(true)
    }
}
