use super::state::MemBundle;
use super::tenant::MemTenant;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::production_projects::{DoneCursor, ProductionProject, ProjectRepo},
};
use uuid::Uuid;
#[async_trait]
impl ProjectRepo for MemTenant {
    async fn get_project(&mut self, id: Uuid) -> Result<Option<ProductionProject>, AppError> {
        Ok(self
            .state()
            .production_projects
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn list_projects(
        &mut self,
        archived: bool,
        before: Option<Uuid>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .production_projects
            .iter()
            .filter(|r| {
                r.workspace_id == self.ws
                    && r.archived == archived
                    && before.is_none_or(|v| r.id < v)
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.id));
        rows.truncate(101);
        Ok(rows)
    }
    async fn list_areas(
        &mut self,
        done: bool,
        before: Option<DoneCursor>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .production_projects
            .iter()
            .filter(|p| p.workspace_id == self.ws && !p.archived && p.done_at().is_some() == done)
            .filter(|p| !done || before.is_none_or(|c| (p.done_at(), p.id) < (Some(c.at), c.id)))
            .cloned()
            .collect();
        if done {
            rows.sort_by_key(|p| std::cmp::Reverse((p.done_at(), p.id)));
            rows.truncate(51);
        } else {
            rows.sort_by_key(|p| (p.starts_at(), p.id));
            rows.truncate(200);
        }
        Ok(rows)
    }
    async fn list_areas_waiting(&mut self) -> Result<Vec<ProductionProject>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .production_projects
            .iter()
            .filter(|p| p.workspace_id == self.ws && p.waiting_versions().next().is_some())
            .cloned()
            .collect();
        rows.sort_by_key(|p| (p.done_at(), p.id));
        rows.truncate(200);
        Ok(rows)
    }
    async fn save_project(
        &mut self,
        mut p: ProductionProject,
        expected: Option<u64>,
    ) -> Result<(), AppError> {
        // As the database: the answer's projection is not stored.
        p.state = None;
        self.call(|this| {
            if p.workspace_id != this.ws {
                return Err(AppError::internal("project workspace mismatch"));
            }
            let current = this
                .state()
                .production_projects
                .iter()
                .find(|r| r.workspace_id == this.ws && r.id == p.id);
            if current.map(|r| r.revision) != expected
                || p.revision != expected.unwrap_or(0).saturating_add(1)
            {
                return Err(AppError::conflict("project revision changed"));
            }
            this.tx.write(move |s| {
                s.production_projects
                    .retain(|r| r.workspace_id != p.workspace_id || r.id != p.id);
                s.production_projects.push(p.clone());
            });
            Ok(())
        })
    }
}
