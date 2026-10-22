//! Test support: throwaway test databases, fakes for the application ports, fixtures, and (with
//! the `panel` feature) the panel's HTTP surface in process.

pub mod db;
pub mod fakes;
pub mod flows;
#[cfg(feature = "panel")]
pub mod panel;

pub use db::TestDb;
