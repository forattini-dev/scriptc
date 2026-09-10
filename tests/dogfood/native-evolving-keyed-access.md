# Keyed access on evolving engine bindings

Checkpoint on 2026-09-10 in `rust-effect-native`, HEAD `143bd19c` plus WIP.
This fixes a frontend regression; no Redwall performance improvement was measured.

Corpus 2603 failed in Rust, C and LLVM on `let bag; bag = {}; bag[key] = value`.
Instrumentation showed the checker mapping `{}` to `dyn`, while the actual
module slot remained `jsval`. Dotted access already recognized the engine
slot. Indexed access only considered the checker type and rejected the write
with SC1090; indexed reads also fell through to a non-array refusal.

The write path now recognizes an engine binding under a dynamic checker type,
using the existing `isIslandExpr` storage lookup. The read path dispatches an
actual engine handle through the existing indexed engine operation. Dynamic
native objects retain their existing checked operations. No runtime changes,
new engine fallback, or consumer changes were required.

Corpus 3161 covers global and local evolving bindings, aliases, order and
single evaluation of key/value expressions, negative/numeric keys, missing
object properties, and replacement of the original object with an array. It
serializes that array to check its structure and verifies the old alias still
refers to the original object.

## Validation and limits

- Rust: 5 differential tests passed (2600, 2601, 2603, 3161, 768).
- C/LLVM: 8 differential tests passed (2600, 2601, 2603, 3161 in each harness).
- Compiler build passed. Focused ESLint: zero errors, 95 existing warnings.
- Actual Ts7Host preflight matches the new 3161 baseline, without diagnostics.
- Sanitized C/LLVM: the same 8 differential tests passed.

The first version of the new fixture read a hole through an inferred string
array element type. It threw `TypeError: expected string at $, got undefined`.
Typed array reads that cannot represent missing elements remain a documented
divergence; this change does not claim to fix sparse primitive reads. That
probe and its native result remain in the evidence directory. The final
fixture checks sparse array structure through JSON serialization instead.
The final fixture was rerun against the exact pre-fix lowering file and failed
before its first output; it then passed with this correction.

Evidence: `/tmp/scriptc-evolving-keyed-20260910/`:
`rust-red.log`, `alias-final-red.log`, `rust-final-green.log`,
`c-llvm-green.log`, `preflight-final.log`, `build.log`, `lint.log`.
`rust-green.log` is the earlier incomplete run with the direct sparse read,
not the final passing receipt. `sparse-direct-read.js`, `array-read-red.json`
and `array-analysis.log` record that limitation. Debug instrumentation was
removed. Full plain/sanitized acceptance and the current-source paired
Redwall/Bun benchmark remain pending.
