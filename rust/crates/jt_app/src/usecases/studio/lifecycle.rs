use crate::{
    error::AppError,
    ports::{
        TenantRepos,
        studio::{StrategyChange, StrategyTransitionHook},
    },
};
use async_trait::async_trait;

/// Runs inside approval/archive, after the execution frame lock and before commit.
pub struct StudioTransition;
#[async_trait]
impl StrategyTransitionHook for StudioTransition {
    async fn apply(
        &self,
        repos: &mut dyn TenantRepos,
        change: &StrategyChange,
    ) -> Result<(), AppError> {
        repos.studio_control().lock_control().await?;
        repos.studio().apply_transition(change).await
    }
}
