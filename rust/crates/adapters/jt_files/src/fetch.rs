use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::{connectors::MediaUpload, files::MediaFetcher},
    usecases::studio::files::{invalid, limit, validate_upload},
};
use jt_outbound::{Egress, EgressError, EgressScope, Method, Url};
use jt_tenancy::WorkspaceId;
use std::sync::Arc;
/// Redirects are refused by the shared client, including redirects to private/foreign hosts.
pub struct CheckedMediaFetcher(pub Arc<Egress>);
#[async_trait]
impl MediaFetcher for CheckedMediaFetcher {
    async fn fetch(
        &self,
        ws: WorkspaceId,
        url: &Url,
        mime: &str,
        filename: &str,
    ) -> Result<MediaUpload, AppError> {
        let max = limit(mime)?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(invalid());
        }
        let mut response = self
            .0
            .prepare(Method::GET, url.clone())
            .send(EgressScope::Tenant(ws))
            .await
            .map_err(|e| match e {
                EgressError::Transport(_) | EgressError::Socket => unavailable(),
                EgressError::HostNotAllowed { .. }
                | EgressError::NotPublic { .. }
                | EgressError::Build(_) => invalid(),
            })?;
        let status = response.status();
        if status.is_server_error() || matches!(status.as_u16(), 408 | 429) {
            return Err(unavailable());
        }
        if !status.is_success() || response.content_length().is_some_and(|n| n > max) {
            return Err(invalid());
        }
        let mut bytes = vec![];
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if bytes.len() as u64 + chunk.len() as u64 > max {
                return Err(invalid());
            }
            bytes.extend_from_slice(&chunk);
        }
        let u = MediaUpload {
            bytes,
            mime: mime.into(),
            filename: filename.into(),
        };
        validate_upload(&u)?;
        Ok(u)
    }
}

// Fetch diagnostics can include URL credentials or response bytes; retain only a closed reason.
fn unavailable() -> AppError {
    AppError::upstream_unavailable("media", "media temporarily unavailable", None)
}
