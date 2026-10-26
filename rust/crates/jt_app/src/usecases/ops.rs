//! Operator-only operational health; the transport authenticates the platform context.
use super::Deps;
use crate::{ctx::PlatformCtx, error::AppError, ports::ops::OpsHealthOut};
pub async fn health(deps: &Deps, _pctx: &PlatformCtx) -> Result<OpsHealthOut, AppError> {
    deps.ops.snapshot().await
}
