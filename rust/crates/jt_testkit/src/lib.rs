//! Test support: throwaway test databases, fakes for the application ports, fixtures, and (with
//! the `panel` feature) the panel's HTTP surface in process.

pub mod db;
pub mod fakes;
pub mod flows;
#[cfg(feature = "panel")]
pub mod panel;

pub use db::TestDb;

pub mod inbox_contract;

pub mod inbox_merge_contract;

pub mod compliance_contract;

pub mod studio_contract;

pub mod studio_attribution_contract;

pub mod billing_contract;

pub mod platform_payment_contract;

pub mod activation_contract;

mod activation_control;

pub mod platform_access_contract;

pub mod devices_bridge_contract;
pub mod devices_contract;

pub mod prospects_contract;
