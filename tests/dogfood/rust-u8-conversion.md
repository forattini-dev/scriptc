# Specialized binary64 to Uint8 conversion

The Rust runtime now truncates a number through a safe saturating i64 cast
and keeps its low byte. Within i64 this equals ToUint8. Outside it, all finite
binary64 values are multiples of 256. Negative saturation already has zero
low bits; positive saturation is corrected to zero. No binary64 truncates
to i64::MAX itself. NaN and infinities also convert to zero. Wider and floating
array conversions are unchanged. No unsafe operations were introduced.

An independent truncation/modulo reference passed 1,065,635 cases, covering
all exponents, both signs, mantissa boundaries, random bit patterns, signed
fractions and adjacent values around i64 saturation. The isolated probe won
all six timing rounds; the preserved baseline test passed before the change.
The final runtime passes 214 tests and all-target Clippy on pinned 1.98.0.
Ten focused Rust differential corpora pass with heap auditing; corpus 3130
also passes C and LLVM sanitized. File-line and whitespace checks pass.
The compiler TypeScript is unchanged from the previous successful build.

Redwall passes 38 contracts (26 native invocations), engine none, no FFI,
zero fences and identical PNGs. Its generated Rust hash is identical to the
previous artifact: only runtime implementation changed. All 116 current
analyzed source hashes were rechecked.

Three-sample screening: control 2567.23 ms, u8 conversion 2082.65 ms,
Bun --compile 731.16 ms. The apparent 18.9% reduction was smaller in the
seven-sample repeat: control 2827.35 ms, u8 2657.00 ms, Bun 1046.69 ms.
That repeat gives a 6.0% median reduction for this step, winning 4/7 paired
rounds. Host variation is substantial; do not treat the screening gain as a
stable application improvement.

The seven-sample round also includes the earlier Rust byte-write artifact:
5416.03 ms. The complete current candidate reduces its median time 50.9%,
but still takes 2.54x Bun. All 32 executions (including warmups) match output.
The new binary is 4,063,984 bytes; Bun is 81,413,600 bytes. Median peak RSS is
110952 KiB versus Bun's 136984 KiB in that round.

The earlier Rust record differs only in package.json version 1.0.131 versus
1.0.132, confirmed against Git; all other 115 analyzed files match. Neither
version string is present in generated renderer Rust. A fresh Bun compilation
from the current source is byte-identical to the previous Bun executable.
The provenance and comparison are retained alongside the measurements.

Evidence: `/tmp/scriptc-u8-conversion-20260909/` and
`.red/tmp/native-u8-conversion-checkpoint-20260909/`. This is the TS renderer
adapter, not installation/acceptance of the original CLI. The full compiler
plain/sanitized gate remains unaccepted, and the performance goal is open.

## O3-only diagnostic

The unchanged generated Rust and runtime were also built with only the final
application flag changed from opt-level=2 to opt-level=3. The exact rustc
command is retained. All 38 renderer contracts passed, and all 12 screening
executions matched. Three-sample medians: control 2503.17 ms, O3 2476.01 ms,
Bun --compile 987.63 ms. This ~1.1% difference is not convincing evidence of
an application gain; the binary grew from 4,063,984 to 4,083,408 bytes.
Production flags remain unchanged. Evidence: `/tmp/scriptc-release-o3-20260909/`.

An optimized LLVM IR diagnostic is retained as `analysis.ll`, with extracted
renderer functions and `ir-summary.json`. It still contains floating-point
induction and saturating float-to-index conversions in the hot functions.
These static instruction counts do not measure their share of runtime.
The requested LLVM remark flags produced no optimization remarks, so no
vectorizer refusal reason is claimed from that probe. Integer/range analysis
and explicit specialization of the optional read-slice fallback are the next
candidates to investigate against the same executable benchmark.
