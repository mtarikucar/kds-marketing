use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::{connectors::MediaUpload, files::MediaFetcher},
    usecases::studio::files::{invalid, limit, validate_upload},
};
use jt_outbound::{Egress, EgressScope, Method, Url};
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
            .map_err(|_| invalid())?;
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > max) {
            return Err(invalid());
        }
        let mut bytes = vec![];
        while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
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
