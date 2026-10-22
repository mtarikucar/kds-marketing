# Developer entry points for the Rust workspace. Run from rust/.

.PHONY: fmt lint doc deny test check dev panel-install panel-test panel-build

# Like CI, every cargo command but fmt (which takes no such flag) runs `--locked`: Cargo.lock is
# used as committed, and a manifest change that needs a new lock file fails instead of resolving
# (run a plain `cargo build` once to update the lock file, then commit it).

fmt:
	cargo fmt --all -- --check

lint:
	cargo clippy --locked --workspace --all-targets -- -D warnings

doc:
	RUSTDOCFLAGS="-D warnings" cargo doc --locked --workspace --no-deps

deny:
	cargo deny --locked check

# Needs JEETA_TEST_DATABASE_URL in the environment (see README).
test:
	cargo test --locked --workspace

check: fmt lint doc deny test

# Reads rust/.env (see .env.example).
dev:
	cargo run -p jeeta -- serve

panel-install:
	cd panel && pnpm install

panel-test:
	cd panel && pnpm test

panel-build:
	cd panel && pnpm build
