# The two crates are separate, so the commands are here in one place.
# The contract's own Cargo.lock is the one that matters: do not turn these into
# a cargo workspace, that would move the lock file and with it the bytes of
# the wasm on chain.

# Use the cargo selected by rustup and rust-toolchain.toml by default. A
# caller can override CARGO without changing the repository.
CARGO ?= cargo
CARGO_HOME ?= $(HOME)/.audit-cargo
export CARGO_HOME

.PHONY: test test-rust test-shell test-deps test-web test-submission verify verify-local fmt clippy wasm clean shellcheck deps-check

# The local unit-test path. Cargo may fetch locked crates when its cache is
# empty. The tests need no keys and spend nothing.
test: test-rust test-shell test-deps test-web test-submission

test-rust:
	cd policy && $(CARGO) test --locked
	cd contract && $(CARGO) test --locked

# Fake-NEAR shell tests: dependency-free, no testnet, no keys, no spending.
test-shell:
	bash tests/fake-near/run.sh

# The dependency script's own failure paths are tested with fake commands. No
# network or package installation is needed.
test-deps:
	bash tests/dependency-check/run.sh

# The console tests use Node's built-in test runner and need no package
# installation.
test-web:
	cd web && node --test test/*.test.js

# The submission payload failure paths. The script builds the payload for the
# builder and never sends it, so the tests prove it never guesses a value and
# never reaches the network.
test-submission:
	bash tests/submission/run.sh

# Deterministic Wasm verification: builds twice, compares SHA-256 bytes, and
# writes a machine-readable local artifact manifest. Not compared to the
# historical live hash.
verify-local:
	bash scripts/build-wasm.sh

fmt:
	cd policy && $(CARGO) fmt --check
	cd contract && $(CARGO) fmt --check

clippy:
	cd policy && $(CARGO) clippy --all-targets --locked -- -D warnings
	cd contract && $(CARGO) clippy --all-targets --locked -- -D warnings

wasm:
	bash scripts/build-wasm.sh

# Read-only check of the historical deployment against docs/claims.json.
# This uses the public testnet RPC.
verify:
	python3 scripts/claims.py --check

shellcheck:
	shellcheck demo/agent.sh demo/nonce.sh demo/protocol_arm.sh scripts/build-wasm.sh scripts/dependency-check.sh tests/fake-near/run.sh tests/dependency-check/run.sh tests/submission/run.sh

# The dependency check installs a pinned cargo-audit when needed and fetches
# the public RustSec advisory database. It fails closed on either failure.
deps-check:
	bash scripts/dependency-check.sh

clean:
	rm -rf policy/target contract/target
