//! The in-memory owner's notices (`0049_owner_notices`): unique per workspace and dedupe key.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::notices::{NoticeRepo, NoticeRow, NoticeState};
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::state::MemBundle;
use super::tenant::MemTenant;

#[async_trait]
impl NoticeRepo for MemTenant {
    async fn insert(&mut self, row: &NoticeRow) -> Result<bool, AppError> {
        let ws = self.ws;
        if self
            .state()
            .notices
            .iter()
            .any(|(w, n)| *w == ws && (n.dedupe_key == row.dedupe_key || n.id == row.id))
        {
            return Ok(false);
        }
        let row = row.clone();
        self.tx.write(move |s| s.notices.push((ws, row.clone())));
        Ok(true)
    }

    async fn count_since(&mut self, since: OffsetDateTime) -> Result<u32, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .notices
            .iter()
            .filter(|(w, n)| *w == ws && n.created_at >= since && n.state != NoticeState::Skipped)
            .count() as u32)
    }

    async fn get(&mut self, id: Uuid) -> Result<Option<NoticeRow>, AppError> {
        Ok(find(self.state().notices.as_slice(), self.ws, id))
    }

    async fn lock(&mut self, id: Uuid) -> Result<Option<NoticeRow>, AppError> {
        self.tx.journal_lock("owner_notices");
        self.tx.lock_studio().await;
        Ok(find(self.state().notices.as_slice(), self.ws, id))
    }

    async fn save(&mut self, row: &NoticeRow) -> Result<(), AppError> {
        let row = row.clone();
        self.call(|this| {
            let ws = this.ws;
            if find(this.state().notices.as_slice(), ws, row.id).is_none() {
                return Err(AppError::not_found("no such notice"));
            }
            this.tx.write(move |s| {
                for (w, n) in &mut s.notices {
                    if *w == ws && n.id == row.id {
                        n.state = row.state;
                        n.attempts = row.attempts;
                        n.sent_at = row.sent_at;
                        n.mailbox_capability_id = row.mailbox_capability_id;
                    }
                }
            });
            Ok(())
        })
    }

    async fn queued(&mut self, limit: u32) -> Result<Vec<Uuid>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<&NoticeRow> = self
            .state()
            .notices
            .iter()
            .filter(|(w, n)| *w == ws && n.state == NoticeState::Queued)
            .map(|(_, n)| n)
            .collect();
        rows.sort_by_key(|n| (n.created_at, n.id));
        Ok(rows
            .into_iter()
            .take(limit.clamp(1, 100) as usize)
            .map(|n| n.id)
            .collect())
    }
}

fn find(rows: &[(WorkspaceId, NoticeRow)], ws: WorkspaceId, id: Uuid) -> Option<NoticeRow> {
    rows.iter()
        .find(|(w, n)| *w == ws && n.id == id)
        .map(|(_, n)| n.clone())
}
