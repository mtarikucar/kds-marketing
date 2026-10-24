# Developer entry points for the Rust workspace. Run from rust/.

.PHONY: fmt lint doc deny test check dev panel-install panel-test panel-build sweep

# Disk hygiene. Every distinct cargo invocation shape (package set, feature set, profile) gets its
# own metadata hash and therefore its own copy of every dependency and test binary under target/.
# Use exactly the invocations below — `--workspace` for tests and clippy, and the one
# production_build run — rather than `-p` subsets, which mint a third copy of the whole tree.

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

# Removes target/ artifacts older than a day (install once: cargo install cargo-sweep). Run at the
# end of a working day; `cargo clean` is the heavier alternative.
sweep:
	cargo sweep --time 1

# Reads rust/.env (see .env.example).
dev:
	cargo run --locked -p jeeta -- serve

panel-install:
	cd panel && pnpm install

panel-test:
	cd panel && pnpm test

panel-build:
	cd panel && pnpm build

.PHONY: smoke-inbox
# Entire connector/consumer/reply/ack flow in process; no database or provider required.
smoke-inbox:
	cargo test --locked -p jt_app --test smoke_inbox

.PHONY: smoke-studio
# In-process M3 acceptance with scripted connectors; no database or provider credentials.
smoke-studio:
	./scripts/smoke-studio.sh
