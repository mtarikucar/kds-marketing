//! One-time bank-transfer evidence and tenant payment status.
mod payments;
pub mod schema;
pub use payments::{report_payment, status};
pub use schema::{BillingConfig, BillingStatusOut, EntitlementOut, PaymentOut, ReportPaymentInput};

pub mod codes;
pub use codes::{ActivationCodeDeliveryOut, activate};
pub use schema::ActivateInput;
