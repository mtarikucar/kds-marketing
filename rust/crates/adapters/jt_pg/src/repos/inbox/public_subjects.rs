//! Public subjects (0019): the posts and products public items are about.

use super::{map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::PublicSubjectRepo};
use jt_capability::CapabilityId;
use jt_inbox::{PublicSubject, PublicSubjectId};

#[async_trait]
impl PublicSubjectRepo for PgTenantRepos {
    async fn upsert(&mut self, subject: PublicSubject) -> Result<PublicSubject, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, subject.workspace_id)?;
        reference(
            self.tx.conn(),
            ws,
            "capabilities",
            subject.capability_id.as_uuid(),
        )
        .await?;
        if let Some(publication) = subject.publication_id {
            reference(self.tx.conn(), ws, "studio_publications", publication).await?;
        }
        sqlx::query(
            "insert into public_subjects (workspace_id,id,capability_id,kind,external_id,title,url,\
             image_url,facts,publication_id,first_seen_at,updated_at) \
             select workspace_id,id,capability_id,kind,external_id,title,url,image_url,facts,\
             publication_id,first_seen_at,updated_at \
             from jsonb_populate_record(null::public_subjects,$1) where workspace_id=$2 \
             on conflict (workspace_id,capability_id,external_id) do update set kind=excluded.kind,\
             title=excluded.title,url=excluded.url,image_url=excluded.image_url,\
             facts=excluded.facts,\
             publication_id=coalesce(excluded.publication_id,public_subjects.publication_id),\
             updated_at=excluded.updated_at",
        )
        .bind(value!(&subject))
        .bind(ws.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store public subject"))?;
        PublicSubjectRepo::find_by_external(self, subject.capability_id, &subject.external_id)
            .await?
            .ok_or_else(|| AppError::internal("a stored public subject did not read back"))
    }
    async fn get(&mut self, id: PublicSubjectId) -> Result<Option<PublicSubject>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(s) from public_subjects s where workspace_id=$1 and id=$2"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            PublicSubject
        )
    }
    async fn find_by_external(
        &mut self,
        capability: CapabilityId,
        external_id: &str,
    ) -> Result<Option<PublicSubject>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(s) from public_subjects s where workspace_id=$1 \
                 and capability_id=$2 and external_id=$3"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(capability.as_uuid())
            .bind(external_id),
            self,
            PublicSubject
        )
    }
}
