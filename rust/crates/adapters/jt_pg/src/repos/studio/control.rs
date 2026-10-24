use super::*;
use jt_strategy::LaneKind;
#[async_trait]
impl StudioControlRepo for PgTenantRepos {
    async fn set_policy(
        &mut self,
        expected: u64,
        lane: LaneKind,
        required: bool,
    ) -> Result<StudioControl, AppError> {
        let mut c = self.lock_control().await?;
        if c.revision != expected {
            return Err(AppError::conflict("control revision changed"));
        }
        c.lanes.entry(lane).or_default().requires_human_approval = required;
        c.revision = c
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("revision overflow"))?;
        sqlx::query("update studio_control set data=$2 where workspace_id=$1")
            .bind(self.workspace_id().0)
            .bind(encode(&c)?)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "set Studio policy"))?;
        Ok(c)
    }
    async fn binding_control(
        &mut self,
        id: AdSetBindingId,
    ) -> Result<Option<BindingControl>, AppError> {
        let row: Option<Option<Value>> = sqlx::query_scalar(
            "select control from studio_adset_bindings where workspace_id=$1 and id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(id.0)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "binding control"))?;
        row.flatten().map(decode).transpose()
    }
    async fn save_binding_control(&mut self, c: BindingControl) -> Result<(), AppError> {
        self.lock_control().await?;
        let b = StudioRepo::get_binding(self, c.binding_id)
            .await?
            .ok_or_else(|| AppError::not_found("binding"))?;
        b.chain.require_same(&c.chain).map_err(invalid)?;
        sqlx::query("update studio_adset_bindings set control=$3 where workspace_id=$1 and id=$2")
            .bind(self.workspace_id().0)
            .bind(c.binding_id.0)
            .bind(encode(&c)?)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "save binding control"))?;
        Ok(())
    }
    async fn lock_control(&mut self) -> Result<StudioControl, AppError> {
        let ws = self.workspace_id();
        let initial = StudioControl {
            workspace_id: ws,
            brake_engaged: false,
            revision: 0,
            lanes: Default::default(),
        };
        sqlx::query(
            "insert into studio_control(workspace_id,data) values($1,$2) on conflict do nothing",
        )
        .bind(ws.0)
        .bind(encode(&initial)?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "ensure Studio control"))?;
        let row =
            sqlx::query_scalar("select data from studio_control where workspace_id=$1 for update")
                .bind(ws.0)
                .fetch_one(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "lock Studio control"))?;
        decode(row)
    }
    async fn set_brake(
        &mut self,
        expected: u64,
        lane: Option<LaneKind>,
        engaged: bool,
    ) -> Result<StudioControl, AppError> {
        let mut c = self.lock_control().await?;
        if c.revision != expected {
            return Err(AppError::conflict("control revision changed"));
        }
        if let Some(lane) = lane {
            c.lanes.entry(lane).or_default().brake_engaged = engaged;
        } else {
            c.brake_engaged = engaged;
        }
        c.revision = c
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("revision overflow"))?;
        sqlx::query("update studio_control set data=$2 where workspace_id=$1")
            .bind(self.workspace_id().0)
            .bind(encode(&c)?)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "set Studio brake"))?;
        Ok(c)
    }
}
