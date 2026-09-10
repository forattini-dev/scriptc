# Rust integer induction in byte loops

The Rust emitter now reuses `matchIntegerBytesForLoop`, the existing shared
analysis consumed by the C and LLVM emitters. For canonical
`for (let i = 0; i < bytes.length; i++)` loops it stores the induction variable
as `usize`, reads it as `f64` at ordinary JavaScript number uses, and passes
it directly to checked integer-index byte reads and writes. This is a backend
representation decision; it neither mutates shared IR nor rewrites emitted Rust.

The first tier requires an unboxed counter, zero initialization, a unit update,
and no writes to the counter in the body. Rust-forced boxes, captured receiver
bindings, async functions and generators retain the generic representation.
The receiver and its length are reevaluated at every loop condition. Byte
operations retain receiver/index/value evaluation order, view offsets, numeric
conversion and bounds checks. An integer index does not prove that every
buffer accessed in the body is long enough. No `unsafe` code is introduced.

The implementation deliberately retains handle clones. Borrow elimination,
loop-invariant buffer borrowing, general range analysis, vectorization and PGO
are separate changes that need their own evidence. This first tier reaches two
Redwall loops: CRC byte input and glyph coverage-to-alpha conversion. Most
image loops do not have the recognized canonical form.

Validation uses corpus 1409 and new corpus 3123 against Node, Rust heap audit,
and sanitized C/LLVM comparisons. The new corpus covers nested/labeled loops,
continue/break, a finally body, observable floating-point index uses, receiver
replacement during a write value, shortening a receiver, typed-array views,
Buffer backing aliases, captured/mutated counters and reads after await.
Cross-finally break/continue remains a frontend refusal and is not claimed by
this optimization. Unit tests assert function/loop scoping, rejection of
ineligible bindings, emitted integer operations and unchanged shared IR.
Runtime tests pin subarray offsets, integer conversion and view bounds.

Evidence is retained under
`.red/tmp/native-integer-loops-checkpoint-20260909/` and
`/tmp/scriptc-integer-loops-20260909/`.

The complete plain/sanitized release gate is not accepted: the prior full plain
attempt stopped at `dynamic import() keeps a failed module rejected` in
`emit-rust-island-modules.test.ts`. Focused success does not supersede that
failure or approve the complete consumer CLI for deployment.


## Measured outcome

The Redwall renderer remains byte-exact in 38 consumer tests (26 native calls).
Seven interleaved measured samples per candidate show 4300.47 ms median for
control and 4299.63 ms for integer induction: no demonstrated application
speedup. The new executable is 4081624 bytes, 768 bytes larger. CPU and peak RAM
are effectively unchanged. This change closes an emitter optimization gap;
it does not establish improved Redwall performance.

A separate diagnostic copy with inclusive boundary timers places about 93% of
render time in PNG unfiltering, RGBA conversion and output filtering; zlib is
about 6%. These timings locate the next investigation, but do not quantify the
individual contributions of clones, number conversions and bounds checks.
See `redwall-native.md` for measurements, hashes and instrumentation limits.
