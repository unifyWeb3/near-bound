# The two crates are separate, so the commands are here in one place.
# The contract's own Cargo.lock is the one that matters: do not turn these into
# a cargo workspace, that would move the lock file and with it the bytes of the
# wasm on chain.

RUST = PATH=/home/unify/.local/rust-toolchain/bin:$$PATH
CARGO_HOME = CARGO_HOME=/home/unify/.audit-cargo

.PHONY: test test-shell verify verify-local fmt clippy wasm clean shellcheck deps-check

# Full local test path: the same gates as CI where practical (no network,
# no keys, no spending). The claims check is not part of unit test because it
# calls the live testnet RPC.
test:
	cd policy && $(RUST) $(CARGO_HOME) cargo test --locked
	cd contract && $(RUST) $(CARGO_HOME) cargo test --locked

# Deterministic Wasm verification: builds twice, compares SHA-256 bytes, and
# writes a machine-readable local artifact manifest. Not compared to the
# historical live hash.
verify-local:
	bash scripts/build-wasm.sh

# Fake-NEAR shell tests: dependency-free, no testnet, no keys, no spending.
test-shell:
	bash tests/fake-near/run.sh

fmt:
	cd policy && $(RUST) $(CARGO_HOME) cargo fmt --check
	cd contract && $(RUST) $(CARGO_HOME) cargo fmt --check

clippy:
	cd policy && $(RUST) $(CARGO_HOME) cargo clippy --all-targets --locked -- -D warnings
	cd contract && $(RUST) $(CARGO_HOME) cargo clippy --all-targets --locked -- -D warnings

wasm:
	bash scripts/build-wasm.sh

# Read-only check of the historical deployment against docs/claims.json.
# Network-dependent: not part of make test.
verify:
	python3 scripts/claims.py --check

shellcheck:
	shellcheck demo/agent.sh demo/protocol_arm.sh

deps-check:
	# Read-only dependency vulnerability check (known vulnerabilities only).
	# Runs in CI; no-op target kept for documentation.
	@echo "dependency vulnerability check runs in CI (.github/workflows/tests.yml)"

clean:
	rm -rf policy/target contract/target
