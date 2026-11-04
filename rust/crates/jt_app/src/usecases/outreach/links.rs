//! The public links every commercial email carries (spec §3.14, D62, D63): the one-click
//! unsubscribe address and, for a campaign that tracks clicks, the click redirects. Here only
//! their addresses and MACs are built; the routes that honour them (`/u/…`, `/c/…`) are plan
//! L5-T2's, which verify a MAC with [`verify`].
//!
//! - **Token**: the email's outbox entry id, the id in its Message-ID (`<id@host>`), for an inbox
//!   send and an outreach send alike (an outreach send's row names it: `outreach_sends.outbox_id`).
//! - **MAC**: the first `jt_outreach::MAC_BYTES` bytes of HMAC-SHA256 under the workspace's key for
//!   the purpose (`deps.seal.hmac_key(ws, "outreach.unsubscribe" | "outreach.click")`) over
//!   `jt_outreach::mac_input(purpose, token, link)`, base64url without padding.
//! - **Address**: the platform's public base URL with `jt_outreach::unsubscribe_path` or
//!   `click_path`; only an `https` base gives one (the one-click address must be `https`).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use jt_outreach::{MAC_BYTES, MacPurpose, click_path, mac_input, unsubscribe_path};
use jt_tenancy::WorkspaceId;
use sha2::Sha256;
use uuid::Uuid;

use crate::error::AppError;
use crate::ports::connectors::Url;
use crate::usecases::Deps;

/// The MAC of `token` (and `link`) for `purpose` in `ws`, base64url without padding.
pub fn mac(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: MacPurpose,
    token: Uuid,
    link: Option<u16>,
) -> Result<String, AppError> {
    let bytes = raw_mac(deps, ws, purpose, token, link)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn raw_mac(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: MacPurpose,
    token: Uuid,
    link: Option<u16>,
) -> Result<Vec<u8>, AppError> {
    let secret = deps.seal.hmac_key(ws, purpose.key())?;
    let mut m = Hmac::<Sha256>::new_from_slice(secret.as_ref())
        .map_err(|_| AppError::internal("link key unavailable"))?;
    m.update(&mac_input(purpose, token, link));
    Ok(m.finalize().into_bytes()[..MAC_BYTES].to_vec())
}

/// Whether `given` (as a link carries it) is the MAC of `token` (and `link`) for `purpose` in
/// `ws`, compared in constant time; a value that is not base64url of the right length is not.
pub fn verify(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: MacPurpose,
    token: Uuid,
    link: Option<u16>,
    given: &str,
) -> Result<bool, AppError> {
    let Ok(given) = URL_SAFE_NO_PAD.decode(given) else {
        return Ok(false);
    };
    let expected = raw_mac(deps, ws, purpose, token, link)?;
    if given.len() != expected.len() {
        return Ok(false);
    }
    let diff = given
        .iter()
        .zip(&expected)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    Ok(diff == 0)
}

/// The platform's public base address when it is `https`: the only base a one-click
/// unsubscribe address may have.
pub(crate) fn https_base(deps: &Deps) -> Option<Url> {
    deps.apps
        .public_base_url()
        .filter(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| !h.is_empty()))
}

/// The one-click unsubscribe address of the commercial email whose outbox entry is `token`:
/// `{base}/u/{workspace_id}/{token}/{mac}`.
pub fn unsubscribe_url(
    deps: &Deps,
    base: &Url,
    ws: WorkspaceId,
    token: Uuid,
) -> Result<String, AppError> {
    let mac = mac(deps, ws, MacPurpose::Unsubscribe, token, None)?;
    join(base, &unsubscribe_path(ws, token, &mac))
}

/// The click redirect of link `link` (its index in the step's snapshot) of the email whose
/// outbox entry is `token`: `{base}/c/{workspace_id}/{token}/{link}/{mac}`.
pub fn click_url(
    deps: &Deps,
    base: &Url,
    ws: WorkspaceId,
    token: Uuid,
    link: u16,
) -> Result<String, AppError> {
    let mac = mac(deps, ws, MacPurpose::Click, token, Some(link))?;
    join(base, &click_path(ws, token, link, &mac))
}

fn join(base: &Url, path: &str) -> Result<String, AppError> {
    base.join(path)
        .map(String::from)
        .map_err(|_| AppError::internal("a public link does not join the base address"))
}

/// The `mailto:` fallback of `List-Unsubscribe` for the sending address `from`, subject
/// `unsubscribe` (spec §3.14); `None` for an address that a URI cannot hold as it is (anything
/// beyond ASCII letters, digits and `@.!$'*+-=^_`{|}~`).
pub fn unsubscribe_mailto(from: &str) -> Option<String> {
    let ok = from.contains('@')
        && from.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'@' | b'.'
                        | b'!'
                        | b'$'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'='
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'{'
                        | b'|'
                        | b'}'
                        | b'~'
                )
        });
    ok.then(|| format!("mailto:{from}?subject=unsubscribe"))
}
