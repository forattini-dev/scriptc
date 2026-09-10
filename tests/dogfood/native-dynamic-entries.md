# Object.entries: preserve inferred dynamic containers

Checkpoint on 2026-09-10 in `rust-effect-native`, HEAD `143bd19c` plus WIP.
This is a frontend correctness change, with no measured Redwall speedup.

`Object.entries` over an object-typed dynamic receiver produces native dynamic
pairs. The checker infers `[string, unknown][]`, but local storage only
recognized bare island values or arrays of island values as dynamic. Declaring
`entries` therefore attempted an unsupported typed extraction and emitted an
SC1100 runtime fence in Rust, C and LLVM. Preserving the local alone exposed a
second SC1090 fence: element access still tried to extract the entire array.

The frontend now preserves inferred array/tuple storage containing opaque
members, including destructured bindings. Indexed reads use the original
dynamic slot instead of materializing a typed container. Explicit native
container annotations keep their existing conversion path, and typed exits
retain their checks. JSON serialization eligibility is unchanged.

Corpus 3160 uses a TypeScript entry importing a JavaScript helper, matching the
mixed-source dependency path. It checks outer and pair aliases, pair mutation,
source payload identity and mutation, destructuring, and key order. Existing
2582/2584 object-statics fixtures reproduce the original failure.

## Validation

- Rust: original two fixtures and new alias fixture passed (3 tests).
- C/LLVM: the same three fixtures passed in both harnesses (6 tests).
- Compiler TypeScript build passed; focused ESLint had no errors (existing
  non-null-assertion warnings remain). Both lowering files remain under their
  frozen line limits; `git diff --check` passed.
- The new preflight record comes from the actual Ts7Host: helper before entry,
  with no diagnostics.
- Sanitized C/LLVM: the three fixtures passed in both harnesses (6 tests).
- Adjacent Rust contracts passed: typed/dynamic array identity, tuple-to-array
  conversion and routed keyed reads/writes (3 tests).
- Preflight/order canary: 32 tests passed, covering 600 entries.

Evidence: `/tmp/scriptc-dynamic-containers-20260910/`. `rust-red.log` reproduces
the original fixture; `alias-red.log` records the new alias failure. The first
attempt (`rust-green.log`, despite its filename) still failed. `analyze.log`
identifies the remaining indexed-read fence, and `analyze-index.log` confirms
the original fixture lowers without that fence after the second correction.
The alias fixture's final console statement uses an explicit template string
to avoid a separate, documented `console.log(any)` refusal.
`rust-index-green.log` and `c-llvm-green.log` are the passing native receipts.

Full plain/sanitized gates and a new paired Redwall/Bun measurement remain
required. These focused results do not approve the accumulated worktree.
