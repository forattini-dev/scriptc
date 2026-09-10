# Guarded integer storage for byte-loop regions

The Rust backend can keep canonical counted-loop variables and their
proven arithmetic derivatives in i64 storage for an entire fresh-output
byte region. This covers numeric bounds such as count, height and stride,
beyond the earlier `i < bytes.length` specialization. Ordinary number
observations convert back to f64. Byte accesses stay checked.

## Proof and fallback

`backend/rust/index-regions.ts` performs bounded, conservative analysis.
External numeric bindings must be unboxed, initialized and unwritten in
the region. A guard checks that each is an exact nonnegative integer,
excludes negative zero and caps it at 2^26-1. This cap leaves headroom for
products within the exact binary64 integer domain; it does not change the
accepted input domain, because other values use the original path.

The analysis propagates intervals through literals, stable initializers,
addition, subtraction and multiplication. Every intermediate must remain
within the safe-integer domain; multiplication that could produce -0 is
refused. Mutable derived locals retain ordinary storage. Counter writes
must consist only of the canonical unit update. Captures/boxed locals,
suspension and switch/try regions remain conservative boundaries. Unknown
facts are not inferred from TypeScript `number` annotations alone.

Signed derived indices use `usize::try_from(...).unwrap_or(usize::MAX)`
before the existing checked getters/setters. This retains failure for
negative indices and avoids wraparound onto valid indices on 32-bit
hosts. No unsafe access or runtime source change is introduced.

Numeric admission is combined with the existing input-slice selection:
one optimized path and one ordinary path per region. Nested counted loops
share the outer plan and guard. Loop-local declarations, including for-of
elements, cannot become guards evaluated before their scope. Code/data
flow analyses have depth, work and external-binding budgets and do not
mutate shared IR.

## Evidence and validation

Artifacts: `/tmp/scriptc-index-regions-20260909/`.

- `red.log`: missing emission detected before integration; interval/fallback
  controls already passed.
- `green.log`: 18 focused unit tests passed after first integration.
- `forof-red.log`: reproduced a for-of element incorrectly classified as
  an external parameter. The collector now records these internal bindings
  with unknown range.
- `final-differential.log`: 50 focused tests passed after that correction,
  including Rust corpus 3134 with heap auditing and neighboring byte,
  integer, iteration, closure and nested-control programs.
- `final-build.log`, `final-lint.log`: workspace build and ESLint passed;
  maintained file-line limits and whitespace checks also passed.
- `final-sanitized.log`: final corpus 3134 passed C and LLVM sanitized.
- `final-redwall/acceptance.json`: 38 renderer contracts passed with 26
  byte-identical native PNG comparisons. All 116 analyzed source hashes
  and the runtime source hash match the prior control. The generated Rust
  is identical to the initial screening candidate after the for-of fix.

The first draft corpus used Array.from and typed-array constructor shapes
that this frontend does not yet admit; `differential.log` records that
refusal. The final corpus uses supported operations to isolate this pass.
It covers fractional, negative, NaN, infinite and large bounds, empty
loops, mutable limits, closures, negative zero and arithmetic observations,
subarrays, backed Buffer views, nested loops and for-of elements.

## Diagnostic experiment and screening

Before compiler integration, a manually specialized diagnostic copy changed
only the index representation of the renderer's `filtered` function while
leaving its pixel values and predictor in f64. Inclusive boundary timers
showed median `filtered` time 767.10 ms for control and 327.81 ms for the
diagnostic variant. All eight diagnostic executions produced the expected
PNG. These instrumented, manually changed copies are not accepted compiler
artifacts; source and results are preserved in `profile-results.json` and
`prepare.py`.

The actual compiler candidate specializes both `filtered` and `toRgba`.
Initial screening with three samples plus warmup gave median 1920.48 ms
for prior Rust, 1638.16 ms for the candidate and 798.55 ms for compiled Bun.
All twelve outputs matched. This is a 14.70% median time reduction in that
screening, not a comparison against absolute timings from other rounds.

## Seven-sample acceptance benchmark

Seven samples per candidate plus one warmup, interleaved on the same CPU:

| Executable | Median elapsed ms | Median peak RSS KiB | Bytes |
| --- | ---: | ---: | ---: |
| Prior Rust, loop versions | 1390.73 | 111208 | 4067408 |
| Guarded integer regions | 1115.57 | 111164 | 4066800 |
| Compiled Bun | 638.41 | 141348 | 81413600 |

All 24 executions matched stdout, stderr, status and the 108881-byte PNG
(SHA256 `4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6`).
The candidate won 6/7 paired rounds and reduced median elapsed time by
19.79%, while the executable shrank by 608 bytes. This supports retaining
the optimization. Host variation remains visible; these medians belong to
this round, not a hardware-independent performance guarantee.

The candidate took 1.75 times the compiled Bun median, compared with 2.18
for the prior Rust in the same round. The overall performance objective is
still unachieved. Final sources and binaries are recorded in
`final-redwall/acceptance.json`; timing, binary hashes and output hashes
are in `measurements-seven/benchmark.json` and `benchmark-seven-spec.json`.

## Remaining work and scope

This acceptance uses the same TS renderer adapter, inputs and assets on
both executables. It does not establish full original Redwall CLI support.
Full plain and sanitized compiler gates remain outstanding, so focused
validation does not establish shipping readiness.

The benchmark PNG is 8-bit indexed color (type 3), with a 435-byte PLTE
chunk and no tRNS. Its palette branch still uses generic per-pixel palette
reads and repeated union-narrowing calls. Those are concrete next profiling
targets; no measured attribution or optimization is claimed for them here.
