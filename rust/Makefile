# Developer entry points for the Rust workspace. Run from rust/.

.PHONY: fmt lint deny test check dev panel-install panel-test panel-build

fmt:
	cargo fmt --all -- --check

lint:
	cargo clippy --workspace --all-targets -- -D warnings

deny:
	cargo deny check

test:
	cargo test --workspace

check: fmt lint deny test

dev:
	cargo run -p jeeta -- serve

panel-install:
	cd panel && pnpm install

panel-test:
	cd panel && pnpm test

panel-build:
	cd panel && pnpm build
