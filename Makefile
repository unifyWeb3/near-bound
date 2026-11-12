# The two crates are separate, so the commands are here in one place.
# The contract's own Cargo.lock is the one that matters: do not turn these into
# a cargo workspace, that would move the lock file and with it the bytes of the
# wasm on chain.

.PHONY: test fmt clippy wasm verify clean

test:
	cd policy && cargo test --locked
	cd contract && cargo test --locked

fmt:
	cd policy && cargo fmt --check
	cd contract && cargo fmt --check

clippy:
	cd policy && cargo clippy --all-targets --locked -- -D warnings
	cd contract && cargo clippy --all-targets --locked -- -D warnings

wasm:
	cd contract && cargo build --release --locked --target wasm32-unknown-unknown
	cd contract && wasm-opt -Oz --enable-nontrapping-float-to-int --enable-bulk-memory \
		target/wasm32-unknown-unknown/release/bound_contract.wasm -o bound_contract.wasm
	sha256sum contract/bound_contract.wasm

verify:
	python3 scripts/claims.py --check

clean:
	rm -rf policy/target contract/target
