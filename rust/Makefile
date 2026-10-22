# Developer entry points for the Rust workspace. Run from rust/.

.PHONY: fmt lint doc deny test check dev panel-install panel-test panel-build

# Every cargo command here, `dev` included, runs `--locked`, as CI's do; fmt alone takes no such
# flag. Cargo.lock is used as committed, and a manifest change that needs a new lock file fails
# instead of resolving (run a plain `cargo build` once to update the lock file, then commit it).

fmt:
	cargo fmt --all -- --check

lint:
	cargo clippy --locked --workspace --all-targets -- -D warnings

doc:
	RUSTDOCFLAGS="-D warnings" cargo doc --locked --workspace --no-deps

deny:
	cargo deny --locked check

# Needs JEETA_TEST_DATABASE_URL in the environment (see README). The second run builds
# jt_outbound alone: once a crate enables its `test-loopback` feature in [dev-dependencies], a
# whole-workspace build unifies the feature in, and `tests/production_build.rs` compiles to nothing.
test:
	cargo test --locked --workspace
	cargo test --locked -p jt_outbound --test production_build

check: fmt lint doc deny test

# Reads rust/.env (see .env.example).
dev:
	cargo run --locked -p jeeta -- serve

panel-install:
	cd panel && pnpm install

panel-test:
	cd panel && pnpm test

panel-build:
	cd panel && pnpm build
