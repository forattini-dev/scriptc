# Checkpoint: Node level-6 distance heuristic

The original redwall PNG codec now compiles to a stable Rust binary with `execution: { engine: "none", externalFfi: false }` and no runtime fences. Its six original 3840×2160 wallpapers produce complete encoded PNG files, stdout, stderr and exit status identical to Node 26.10.0 and Node 24.15.0. This closes the observed compression divergence, not the full redwall application or universal zlib parity.

## Generic correction

Node's level-6 slow compressor rejects three-byte matches at distances greater than 4096 bytes even with its default strategy. The opt-in `scriptc-node-level6` path in vendored zlib-rs omitted that `TOO_FAR` heuristic. The fix restores it only for that feature and level; filtered-strategy behavior and other compression levels are unchanged. There are no package names, file-format checks, input fingerprints, new engine dependencies or external FFI in the implementation.

The pinned Node 24.15.0 source documents the heuristic in `deps/zlib/deflate.c`. Both locally installed Node versions produce the same reduced vectors. Local Node 26.10.0 is not the project's exact 26.8.1 pin.

## Regression evidence

The runtime regression failed before the fix at distance 4097. Compiler dev and release regressions also failed with different compressed stdout after the fixture was expressed with supported indexed Buffer writes. Corpus `3443-zlib-distant-three-byte-match.ts` covers distances 4095, 4096, 4097 and 8192 and round-trip decoding. It exercises the algorithm independently of redwall.

After the fix, all seven `zlib_input_tests` pass. The ten compiler zlib byte-parity tests and thirteen promisified zlib tests pass separately against Node 26 and Node 24, including dev/release builds, framing, rejection cases, no-engine execution and heap audit. `cargo clippy -- -D warnings` and `pnpm build` pass on stable Rust 1.98.0; existing vendor dependency warnings remain visible.

Fresh consumer build evidence is in `.red/tmp/zlib-postfix-20261004-2lOGxK/redwall-png-node26/probe.json`. The program-generated comparison reports `png-differential-26.10.0.json` and `png-differential-24.15.0.json` in the same directory record all six cases with `allEqual: true` and `applicationsClosed: false`. The earlier diagnosis artifacts retain their pre-fix state.

## Validation limits and remaining consumers

Both full local lanes were attempted with one worker and bail on the first error. Plain and sanitized stopped at `packages/compiler/src/backend/native-toolchain.test.ts:228` because the sandbox rejects that test's piped `execFileSync` native execution with EPERM; four preceding tests passed in each lane. Neither full lane is green. The full Cargo runtime suite also failed in network-loop, TCP, TLS and UDP tests under sandbox restrictions; its focused zlib tests are green. The resource-limiter wrapper cannot connect to the user bus here, so bounded worker settings were used without claiming a hard cgroup limit.

Baldim remains blocked by static npm admission and generic frontend limitations, including callable builtin Error constructors and conditional CommonJS exports. Full red-dev and redskilled consumers still lack installed sibling workspace dependencies. The redskilled lease seam passed earlier, but is not a full daemon/CLI build. Next development should address those generic frontend boundaries and retry original consumers; it must not replace them with package-specific kernels or claim probe success as application completion.

The maintainer explicitly approved local progress without fetch/reconcile for this phase. Existing work is preserved. No commit or push was performed.
