use super::*;
impl PgTenantRepos {
    pub(super) async fn studio_check_files(&mut self, p: &Piece) -> Result<(), AppError> {
        for m in p
            .media
            .iter()
            .chain(p.adaptations.values().flat_map(|c| c.media.iter()))
        {
            if let MediaAsset::File { id } = m {
                let file = StudioRepo::get_file(self, *id)
                    .await?
                    .ok_or_else(|| AppError::not_found("file"))?;
                if file.deleted_at.is_some() {
                    return Err(AppError::conflict("file has been deleted"));
                }
            }
        }
        Ok(())
    }
    pub(super) async fn studio_save_file(&mut self, file: StoredFile) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), file.workspace_id)?;
        StudioControlRepo::lock_control(self).await?;
        if file.id.0.is_nil()
            || file.size_bytes == 0
            || file.mime.trim().is_empty()
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(AppError::validation("invalid file metadata", json!({})));
        }
        if let Some(old) = self
            .studio_record::<StoredFile>("studio_files", file.id.0)
            .await?
            && (old.sha256 != file.sha256
                || old.size_bytes != file.size_bytes
                || old.created_at != file.created_at
                || old.mime != file.mime
                || old.filename != file.filename
                || (old.deleted_at.is_some() && old.deleted_at != file.deleted_at))
        {
            return Err(AppError::conflict("file identity is immutable"));
        }
        sqlx::query("insert into studio_files(workspace_id,id,data,size_bytes) values($1,$2,$3,$4) on conflict(workspace_id,id) do update set data=excluded.data")
            .bind(self.workspace_id().0).bind(file.id.0).bind(encode(&file)?).bind(revision(file.size_bytes)?).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"save Studio file"))?;
        Ok(())
    }
    pub(super) async fn studio_trend(
        &mut self,
        t: TrendSignal,
        key: &str,
    ) -> Result<TrendSignal, AppError> {
        same_workspace(self.workspace_id(), t.workspace_id)?;
        t.validate().map_err(invalid)?;
        let payload = encode(&t)?;
        if let Some(saved) = self.studio_replay("trend.save", key, &payload).await? {
            return Ok(saved);
        }
        sqlx::query("insert into studio_trends(workspace_id,id,data,born_version_id,hypothesis_id) values($1,$2,$3,$4,$5)")
            .bind(self.workspace_id().0).bind(t.id.0).bind(&payload).bind(t.born_version_id.0).bind(t.hypothesis_id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"save Studio trend"))?;
        self.studio_receipt("trend.save", key, &payload, &t).await?;
        Ok(t)
    }
    pub(super) async fn studio_bind(
        &mut self,
        mut b: AdSetBinding,
        key: &str,
    ) -> Result<AdSetBinding, AppError> {
        same_workspace(self.workspace_id(), b.chain.workspace_id)?;
        b.validate().map_err(invalid)?;
        jt_app::ports::StrategyRepo::lock_execution_frame(self).await?;
        StudioControlRepo::lock_control(self).await?;
        let payload = encode(&b)?;
        if let Some(saved) = self.studio_replay("adset.bind", key, &payload).await? {
            return Ok(saved);
        }
        let capability = jt_app::ports::CapabilityRepo::find(self, b.capability_id)
            .await?
            .ok_or_else(|| AppError::not_found("capability"))?;
        b.verified_at = capability.last_verified_at;
        b.verification_evidence = capability.evidence;
        if let Some(old) = StudioRepo::get_binding(self, b.id).await? {
            b.validate_refresh_of(&old).map_err(invalid)?;
            if old != b {
                if b.verified_at.is_none()
                    || !capability.external_id.as_deref().is_some_and(|id| {
                        jt_capability::canonical_external_id(&capability.kind_key, id)
                            == jt_capability::canonical_external_id(
                                &capability.kind_key,
                                &b.account_id,
                            )
                    })
                {
                    return Err(AppError::conflict("binding_stale"));
                }
                // Explicitly rebinding never revives old consent or a pending resume operation.
                sqlx::query("update studio_budget_moves set data=jsonb_set(jsonb_set(data,'{state}','\"cancelled\"'),'{approval}','null') where workspace_id=$1 and binding_id=$2 and data->>'state'='queued'")
                    .bind(self.workspace_id().0).bind(b.id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"cancel rebound budget moves"))?;
                sqlx::query("update studio_adset_bindings set data=$3,control=null where workspace_id=$1 and id=$2")
                    .bind(self.workspace_id().0).bind(b.id.0).bind(encode(&b)?).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"refresh binding verification"))?;
            }
            self.studio_receipt("adset.bind", key, &payload, &b).await?;
            return Ok(b);
        }
        sqlx::query("insert into studio_adset_bindings(workspace_id,id,data,capability_id,adset_id,born_version_id,hypothesis_id,arm_id) values($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(self.workspace_id().0).bind(b.id.0).bind(encode(&b)?).bind(b.capability_id.0).bind(&b.adset_id).bind(b.chain.born_version_id.0).bind(b.chain.hypothesis_id.0).bind(b.chain.arm_id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"bind external ad set"))?;
        self.studio_receipt("adset.bind", key, &payload, &b).await?;
        Ok(b)
    }
    pub(super) async fn studio_move(
        &mut self,
        mut m: BudgetMove,
        key: &str,
    ) -> Result<BudgetMove, AppError> {
        same_workspace(self.workspace_id(), m.chain.workspace_id)?;
        let payload = encode(&m)?;
        if let Some(saved) = self.studio_replay("budget.move", key, &payload).await? {
            return Ok(saved);
        }
        let b: AdSetBinding = self
            .studio_record("studio_adset_bindings", m.binding_id.0)
            .await?
            .ok_or_else(|| AppError::not_found("binding"))?;
        m.validate_for_binding(&b).map_err(invalid)?;
        m.binding_verified_at = b.verified_at;
        m.binding_verification_evidence = b.verification_evidence;
        sqlx::query("insert into studio_budget_moves(workspace_id,id,data,binding_id,reservation_id,executed_version_id,born_version_id,hypothesis_id,arm_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(self.workspace_id().0).bind(m.id.0).bind(encode(&m)?).bind(m.binding_id.0).bind(m.reservation_id.map(|r|r.0)).bind(m.executed_version_id.map(|v|v.0)).bind(m.chain.born_version_id.0).bind(m.chain.hypothesis_id.0).bind(m.chain.arm_id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"save Studio budget move"))?;
        self.studio_receipt("budget.move", key, &payload, &m)
            .await?;
        Ok(m)
    }
    pub(super) async fn studio_measure(&mut self, m: Measurement) -> Result<bool, AppError> {
        same_workspace(self.workspace_id(), m.chain.workspace_id)?;
        m.validate().map_err(invalid)?;
        StudioControlRepo::lock_control(self).await?;
        let chain = if let Some(id) = m.publication_id {
            self.studio_record::<Publication>("studio_publications", id.0)
                .await?
                .map(|p| p.chain)
        } else {
            self.studio_record::<AdSetBinding>(
                "studio_adset_bindings",
                m.binding_id.expect("validated").0,
            )
            .await?
            .map(|b| b.chain)
        }
        .ok_or_else(|| AppError::not_found("measurement target"))?;
        chain.require_same(&m.chain).map_err(invalid)?;
        let old:Option<Value>=sqlx::query_scalar("select data from studio_measurements where workspace_id=$1 and ((publication_id=$2 and measurement_window=$3) or (binding_id=$4 and date=$5 and metric_scope=$6))")
            .bind(self.workspace_id().0).bind(m.publication_id.map(|p|p.0)).bind(encode(&m.window)?.as_str()).bind(m.binding_id.map(|b|b.0)).bind(m.date).bind(&m.metric_scope).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"find measurement"))?;
        if let Some(old) = old {
            let old: Measurement = decode(old)?;
            if old == m {
                return Ok(false);
            }
            if old.status == MeasurementStatus::Complete {
                return if old.evidence_key == m.evidence_key {
                    Err(AppError::conflict("measurement evidence changed"))
                } else {
                    Err(AppError::conflict(
                        "complete measurement requires an explicit correction",
                    ))
                };
            }
            sqlx::query("delete from studio_measurements where workspace_id=$1 and id=$2 and status <> 'complete'").bind(self.workspace_id().0).bind(old.id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"replace retryable measurement"))?;
        }
        sqlx::query("insert into studio_measurements(workspace_id,id,data,publication_id,binding_id,measurement_window,date,metric_scope,evidence_key,status,born_version_id,hypothesis_id,arm_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
            .bind(self.workspace_id().0).bind(m.id.0).bind(encode(&m)?).bind(m.publication_id.map(|p|p.0)).bind(m.binding_id.map(|b|b.0)).bind(encode(&m.window)?.as_str()).bind(m.date).bind(&m.metric_scope).bind(&m.evidence_key).bind(encode(&m.status)?.as_str()).bind(m.chain.born_version_id.0).bind(m.chain.hypothesis_id.0).bind(m.chain.arm_id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"record Studio measurement"))?;
        Ok(true)
    }
    pub(super) async fn studio_learn(&mut self, u: LearningUpdate) -> Result<bool, AppError> {
        same_workspace(self.workspace_id(), u.chain.workspace_id)?;
        u.validate().map_err(invalid)?;
        StudioControlRepo::lock_control(self).await?;
        let old:Option<Option<Value>>=sqlx::query_scalar("select data from studio_learning_applications where workspace_id=$1 and hypothesis_id=$2 and evidence_key=$3")
            .bind(self.workspace_id().0).bind(u.chain.hypothesis_id.0).bind(&u.evidence_key).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"find learning evidence"))?;
        if let Some(old) = old {
            if old == Some(encode(&u)?) {
                return Ok(false);
            }
            return Err(AppError::conflict("learning evidence payload changed"));
        }
        let evidence:Option<Value>=sqlx::query_scalar("select data from studio_measurements where workspace_id=$1 and evidence_key=$2 and status='complete'").bind(self.workspace_id().0).bind(&u.evidence_key).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"read learning source"))?;
        let m: Measurement =
            decode(evidence.ok_or_else(|| AppError::conflict("complete measurement required"))?)?;
        m.chain.require_same(&u.chain).map_err(invalid)?;
        let mut arm: Arm = self
            .studio_record("studio_arms", u.chain.arm_id.0)
            .await?
            .ok_or_else(|| AppError::not_found("arm"))?;
        arm.alpha += u.alpha_delta;
        arm.beta += u.beta_delta;
        arm.weight += u.weight_delta;
        arm.validate().map_err(invalid)?;
        sqlx::query("insert into studio_learning_applications(workspace_id,hypothesis_id,born_version_id,evidence_key,derived_confidence,arm_id,data) values($1,$2,$3,$4,$5,$6,$7)")
            .bind(self.workspace_id().0).bind(u.chain.hypothesis_id.0).bind(u.chain.born_version_id.0).bind(&u.evidence_key).bind(u.derived_confidence).bind(u.chain.arm_id.0).bind(encode(&u)?).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"apply learning once"))?;
        sqlx::query("update studio_arms set data=$3 where workspace_id=$1 and id=$2")
            .bind(self.workspace_id().0)
            .bind(arm.id.0)
            .bind(encode(&arm)?)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "update learned arm"))?;
        Ok(true)
    }
}
