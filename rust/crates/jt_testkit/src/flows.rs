//! Application flows that tests share, run through the real use cases.

use jt_app::usecases::Deps;
use jt_app::usecases::auth::LoginInput;
use jt_app::usecases::platform;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};

/// The platform operator [`activate_workspace`] signs in as.
pub const OPERATOR_EMAIL: &str = "ops@jeeta.test";
/// Its password.
pub const OPERATOR_PASSWORD: &str = "operator passphrase";

/// Activates workspace `ws` as the platform operator does after payment: creates the operator
/// [`OPERATOR_EMAIL`] unless an operator exists, signs in as it and sets the status through
/// `platform::set_status`, which ledgers the change.
///
/// Panics when a step fails, e.g. when another operator was bootstrapped first.
pub async fn activate_workspace(deps: &Deps, ws: WorkspaceId) {
    platform::bootstrap(deps, OPERATOR_EMAIL, OPERATOR_PASSWORD)
        .await
        .expect("the test operator is bootstrapped");
    let session = platform::login(
        deps,
        LoginInput {
            email: OPERATOR_EMAIL.into(),
            password: OPERATOR_PASSWORD.into(),
        },
    )
    .await
    .expect("the test operator signs in (was another operator bootstrapped first?)");
    let pctx = platform::resolve(deps, &session.token)
        .await
        .expect("the operator session resolves");
    platform::set_status(deps, &pctx, ws, WorkspaceStatus::Active)
        .await
        .expect("the operator activates the workspace");
}
