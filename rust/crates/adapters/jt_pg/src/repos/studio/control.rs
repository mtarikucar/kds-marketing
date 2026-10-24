use super::*;
use jt_strategy::LaneKind;
#[async_trait]
impl StudioControlRepo for PgTenantRepos {
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
