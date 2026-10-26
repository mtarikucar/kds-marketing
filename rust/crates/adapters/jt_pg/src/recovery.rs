//! Read-only recovery gates and an explicitly provisioned, retired sealed canary.
use jt_app::ports::SecretBox;
use jt_tenancy::WorkspaceId;
use sqlx::{PgPool, Row};
use subtle::ConstantTimeEq;
use uuid::Uuid;

/// Fixed identity reserved for the operator's recovery canary (never a live connector).
pub const CANARY_ID: Uuid = Uuid::from_u128(0x3a58ab692e7246b48a452e0c6b05512e);
/// Public, domain-separated expected plaintext; keys and decrypted bytes are never reported.
pub const CANARY_VALUE: &[u8] = b"jeeta-recovery-canary-v1";

/// Fixed categories only: callers must never print SQL errors or credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Connection/query could not be completed.
    Database,
    /// Missing, unknown, dirty or changed migration.
    Schema,
    /// Privileged role or missing FORCE RLS.
    Rls,
    /// Missing, changed or undecryptable canary.
    Canary,
}

/// Compare successful migration versions AND checksums with the embedded forward set.
/// `exact=false` permits pending migrations on normal startup, never unknown versions.
pub async fn check_schema(pool: &PgPool, exact: bool) -> Result<(), Refused> {
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(pool)
            .await
            .map_err(|_| Refused::Database)?;
    if !exists {
        return if exact { Err(Refused::Schema) } else { Ok(()) };
    }
    let rows = sqlx::query("SELECT version,success,checksum FROM public._sqlx_migrations")
        .fetch_all(pool)
        .await
        .map_err(|_| Refused::Schema)?;
    let expected: Vec<_> = crate::migrator()
        .iter()
        .filter(|m| !m.migration_type.is_down_migration())
        .collect();
    if exact && rows.len() != expected.len() {
        return Err(Refused::Schema);
    }
    for row in rows {
        let version: i64 = row.get("version");
        let checksum: Vec<u8> = row.get("checksum");
        if !row.get::<bool, _>("success")
            || !expected
                .iter()
                .any(|m| m.version == version && m.checksum.as_ref() == checksum)
        {
            return Err(Refused::Schema);
        }
    }
    Ok(())
}

/// Reject bypass roles and every tenant table lacking enabled AND forced RLS.
pub async fn check_rls(pool: &PgPool) -> Result<(), Refused> {
    if crate::role_bypasses_rls(pool)
        .await
        .map_err(|_| Refused::Database)?
    {
        return Err(Refused::Rls);
    }
    let bad: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (c.relname='workspaces' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped)) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
        .fetch_one(pool).await.map_err(|_| Refused::Database)?;
    if bad != 0 {
        return Err(Refused::Rls);
    }
    Ok(())
}

/// Verify without migrating, binding listeners, constructing providers or starting jobs.
pub async fn verify(pool: &PgPool, secrets: &dyn SecretBox) -> Result<(), Refused> {
    check_schema(pool, true).await?;
    check_rls(pool).await?;
    let mut tx = crate::PlatformTx::begin(pool)
        .await
        .map_err(|_| Refused::Database)?;
    let row = sqlx::query("SELECT workspace_id,connector_sealed FROM capabilities WHERE id=$1 AND kind_key='recovery_canary' AND status='retired'")
        .bind(CANARY_ID).fetch_optional(tx.conn()).await.map_err(|_| Refused::Database)?.ok_or(Refused::Canary)?;
    let ws = WorkspaceId::from(row.get::<Uuid, _>("workspace_id"));
    let sealed: Option<Vec<u8>> = row.get("connector_sealed");
    let clear = secrets
        .open(ws, &sealed.ok_or(Refused::Canary)?)
        .map_err(|_| Refused::Canary)?;
    if !bool::from(clear.as_slice().ct_eq(CANARY_VALUE)) {
        return Err(Refused::Canary);
    }
    Ok(())
}

/// Explicit operator seed (up). Refuses to overwrite any existing canary or credential.
pub async fn seed_canary(
    pool: &PgPool,
    ws: WorkspaceId,
    secrets: &dyn SecretBox,
) -> Result<(), Refused> {
    check_schema(pool, true).await?;
    check_rls(pool).await?;
    let sealed = secrets
        .seal(ws, CANARY_VALUE)
        .map_err(|_| Refused::Canary)?;
    let mut tx = crate::TenantTx::begin(pool, ws)
        .await
        .map_err(|_| Refused::Database)?;
    sqlx::query("INSERT INTO capabilities(id,workspace_id,kind_key,name,reach,status,connector_sealed,created_at,updated_at) VALUES ($1,$2,'recovery_canary','Recovery canary','agent','retired',$3,now(),now())")
        .bind(CANARY_ID).bind(ws.as_uuid()).bind(sealed).execute(tx.conn()).await.map_err(|_| Refused::Canary)?;
    tx.commit().await.map_err(|_| Refused::Database)
}

/// Idempotent seed rollback (down), scoped to the reserved identity, kind and retired state.
pub async fn remove_canary(pool: &PgPool, ws: WorkspaceId) -> Result<(), Refused> {
    check_rls(pool).await?;
    let mut tx = crate::TenantTx::begin(pool, ws)
        .await
        .map_err(|_| Refused::Database)?;
    sqlx::query(
        "DELETE FROM capabilities WHERE id=$1 AND workspace_id=$2 AND kind_key='recovery_canary' AND status='retired'",
    )
    .bind(CANARY_ID)
    .bind(ws.as_uuid())
    .execute(tx.conn())
    .await
    .map_err(|_| Refused::Database)?;
    tx.commit().await.map_err(|_| Refused::Database)
}
