# Developer entry points for the Rust workspace. Run from rust/.

.PHONY: fmt lint doc deny test check dev panel-install panel-test panel-build

fmt:
	cargo fmt --all -- --check

lint:
	cargo clippy --workspace --all-targets -- -D warnings

doc:
	RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps

deny:
	cargo deny check

# Needs JEETA_TEST_DATABASE_URL in the environment (see README).
test:
	cargo test --workspace

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
