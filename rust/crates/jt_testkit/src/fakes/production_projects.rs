use super::state::MemBundle;
use super::tenant::MemTenant;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::production_projects::{
        AreaCount, AreaOlay, AreaPosts, DoneCursor, ProductionProject, ProjectRepo,
    },
};
use jt_studio::MaterialId;
use std::collections::BTreeSet;
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
        olay: Option<AreaOlay>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .production_projects
            .iter()
            .filter(|r| {
                r.workspace_id == self.ws
                    && r.archived == archived
                    && before.is_none_or(|v| r.id < v)
                    && olay.is_none_or(|o| o.matches(r))
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
        olay: Option<AreaOlay>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .production_projects
            .iter()
            .filter(|p| p.workspace_id == self.ws && !p.archived && p.done_at().is_some() == done)
            .filter(|p| !done || before.is_none_or(|c| (p.done_at(), p.id) < (Some(c.at), c.id)))
            .filter(|p| olay.is_none_or(|o| o.matches(p)))
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
    async fn area_counts(&mut self) -> Result<Vec<AreaCount>, AppError> {
        let mut out: Vec<AreaCount> = Vec::new();
        for p in self
            .state()
            .production_projects
            .iter()
            .filter(|p| p.workspace_id == self.ws && !p.archived)
        {
            let open = p
                .requests
                .iter()
                .filter(|q| q.status == jt_app::ports::production_projects::RequestStatus::Open)
                .count() as u64;
            match out.iter_mut().find(|c| c.olay_id == p.olay_id) {
                Some(c) => {
                    c.areas += 1;
                    c.open_requests += open;
                }
                None => out.push(AreaCount {
                    olay_id: p.olay_id,
                    areas: 1,
                    open_requests: open,
                }),
            }
        }
        out.sort_by_key(|c| c.olay_id);
        Ok(out)
    }
    async fn area_posts(&mut self) -> Result<Vec<AreaPosts>, AppError> {
        let mut out: Vec<AreaPosts> = self
            .state()
            .production_projects
            .iter()
            .filter(|p| p.workspace_id == self.ws)
            .filter_map(AreaPosts::of)
            .collect();
        out.sort_by_key(|a| a.id);
        Ok(out)
    }
    async fn materials_in_areas(
        &mut self,
        ids: &[MaterialId],
    ) -> Result<BTreeSet<MaterialId>, AppError> {
        let mut held = BTreeSet::new();
        for p in self
            .state()
            .production_projects
            .iter()
            .filter(|p| p.workspace_id == self.ws)
        {
            held.extend(p.sources.iter().map(|s| s.material_id));
            for k in &p.packages {
                for v in &k.versions {
                    held.extend(v.material_ids.iter().copied());
                }
            }
        }
        Ok(ids.iter().copied().filter(|id| held.contains(id)).collect())
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
    async fn list_live_areas(&mut self) -> Result<Vec<ProductionProject>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .production_projects
            .iter()
            .filter(|p| p.workspace_id == self.ws && !p.archived)
            .cloned()
            .collect();
        rows.sort_by_key(|p| std::cmp::Reverse(p.id));
        Ok(rows)
    }
    async fn find_area_by_version(
        &mut self,
        version_id: Uuid,
    ) -> Result<Option<ProductionProject>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .production_projects
            .iter()
            .filter(|p| {
                p.workspace_id == self.ws
                    && p.packages
                        .iter()
                        .any(|k| k.versions.iter().any(|v| v.id == version_id))
            })
            .cloned()
            .collect();
        rows.sort_by_key(|p| p.id);
        Ok(rows.into_iter().next())
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
