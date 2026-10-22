//! Rebuilds the crate when a migration is added or changed: `sqlx::migrate!` embeds
//! `rust/migrations` at build time but does not tell Cargo to watch the directory.

fn main() {
    println!("cargo:rerun-if-changed=../../../migrations");
}
