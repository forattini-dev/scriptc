# Rejected numeric specialization experiments

Both experiments below were removed from the default Rust backend after
measurement. Their source is preserved for research in
`.red/tmp/native-number-ranges-experiment-20260909/`; it is not integrated
into compiler emission. Earlier byte-loop and checked-index optimizations
remain. Corpus `3133-native-number-ranges.ts` is retained as a differential
regression input for future numeric representation work.

## Expression casts

The first experiment inferred conservative i32 intervals from valid u8
loads, exact literals, stable initializers, branches and direct numeric
leaf calls. It emitted integer arithmetic while retaining f64 locals and
function signatures. It rejected unknown callers, closures, mutable or
boxed bindings, overflow and possible negative zero.

Correctness tests passed, but optimized LLVM IR for `filtered` contained
26 saturating f64-to-i32 conversions versus zero in the control. Three
samples plus warmup gave median 2190.90 ms for control Rust, 2755.02 ms
for the candidate and 834.03 ms for compiled Bun. All 12 outputs matched.
This implementation was rejected. Source and generated IR are in
`/tmp/scriptc-number-ranges-20260909/`, including `cast-candidate/`.

## Complete integer leaf functions

The second experiment retained the conservative analysis but specialized
entire numeric leaf functions: i32 arguments, locals, operations and
return, with conversions only at the call boundary. The original f64
function remained available. Complete proof was required, code generation
had a 512-node budget, and no application names were special-cased.

Nine unit tests plus eight Rust differential corpora passed with heap
auditing (101, 140, 1110, 1538, 2389, 3130, 3132, 3133). A further emission
check confirmed no f64 storage in the integer helper. Workspace build and
file-line checks passed. ESLint reported only an existing warning in
`definitions.ts`. Corpus 3133 also passed sanitized C and LLVM checks.
Renderer acceptance passed 38 contracts and 26 native calls with identical
PNGs. All 116 analyzed source hashes and the runtime source matched the
control.

Three-sample screening was neutral (1921.89 ms control, 1928.38 ms
candidate, 822.58 ms compiled Bun). The follow-up seven-sample run plus
warmup rejected the optimization:

| Executable | Median elapsed ms | Median peak RSS KiB | Bytes |
| --- | ---: | ---: | ---: |
| Control Rust, loop versions | 1215.93 | 111192 | 4067408 |
| Integer-leaf Rust | 1234.85 | 111072 | 4067600 |
| Compiled Bun | 538.03 | 142756 | 81413600 |

All 24 outputs matched. The integer-leaf candidate lost all seven paired
rounds; its median was 1.56% slower than control. Evidence is in
`/tmp/scriptc-integer-leaves-20260909/measurements-seven/benchmark.json`.
Do not compare absolute times across rounds: host conditions varied.

## Implication and scope

Specializing the byte prediction helper alone did not close the gap. A
next experiment should preserve integer representation through induction
variables and derived byte indices, proving effects and numeric bounds
before eliminating conversions. Keep checked accesses and conservative
fallbacks. These experiments introduced no runtime source change or unsafe
access.

The comparison covers the renderer's TS adapter, not the complete original
Redwall CLI. Full compiler validation lanes remain outstanding; focused
correctness checks do not establish shipping readiness. Restoration build
and acceptance evidence uses the `restored-*` files under
`/tmp/scriptc-integer-leaves-20260909/`.

Restoration is verified: workspace build and Rust corpus 3133 passed with
heap audit. A fresh Redwall compilation passed 38 renderer contracts and
26 byte-identical native PNG comparisons. Its generated Rust SHA256
`293eb921252b19ed85bc4bd04d0ffec5d96d03fa267647c96abe4c3af7f93330`
exactly matches the accepted loop-version control; all 116 source hashes
and the runtime source hash also match. The rebuilt executable hash differs
from the earlier control, so it is not asserted to be a byte-identical
binary or to have newly measured performance. The timings above belong to
the executables recorded in their benchmark manifests.
