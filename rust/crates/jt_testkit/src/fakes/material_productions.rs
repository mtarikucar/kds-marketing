use super::state::MemBundle;
use super::tenant::MemTenant;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::material_productions::{ProductionRecord, ProductionRepo},
};
use uuid::Uuid;
#[async_trait]
impl ProductionRepo for MemTenant {
    async fn get_production(&mut self, id: Uuid) -> Result<Option<ProductionRecord>, AppError> {
        Ok(self
            .state()
            .material_productions
            .iter()
            .find(|r| r.production.workspace_id == self.ws && r.production.id == id)
            .cloned())
    }
    async fn list_productions(&mut self) -> Result<Vec<ProductionRecord>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .material_productions
            .iter()
            .filter(|r| r.production.workspace_id == self.ws)
            .cloned()
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.production.id));
        Ok(rows)
    }
    async fn save_production(
        &mut self,
        row: ProductionRecord,
        expected: Option<u64>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            if row.production.workspace_id != this.ws {
                return Err(AppError::internal("production workspace mismatch"));
            }
            let current = this.state().material_productions.iter().find(|r| {
                r.production.workspace_id == this.ws && r.production.id == row.production.id
            });
            if current.map(|r| r.production.revision) != expected
                || row.production.revision != expected.unwrap_or(0).saturating_add(1)
            {
                return Err(AppError::conflict("production revision changed"));
            }
            this.tx.write(move |s| {
                s.material_productions.retain(|r| {
                    r.production.workspace_id != row.production.workspace_id
                        || r.production.id != row.production.id
                });
                s.material_productions.push(row.clone());
            });
            Ok(())
        })
    }
}
