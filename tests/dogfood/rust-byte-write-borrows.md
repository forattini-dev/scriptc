# Borrowed byte writes in the Rust emitter

`bytesSet` now borrows eligible local buffer handles through evaluation of
both the index and the value. The existing bounded scalar-expression proof
must approve both arguments. Calls, receiver assignments, computed receivers,
boxed/forced-boxed/TDZ locals, globals, async functions and generators retain
an owned receiver snapshot. This is compiler emission against typed IR;
consumer source and generated Rust are not rewritten.

The temporary holds a reference to the Gc handle, never a RefCell storage
borrow. The runtime acquires mutable storage only after both operands have
been evaluated. Nested reads of the same buffer therefore remain valid.
Runtime bounds checks and typed numeric conversions are unchanged, as is
`#![forbid(unsafe_code)]`.

The expression emitter owns the borrowing entry point for reads, writes and
integer-loop length conditions. It refuses borrowing whenever preevaluated
expression replacements are active, so statements cannot bypass snapshots.

Unit tests check emission and IR immutability, and separately cover index and
value reassignment and calls. Corpus 3125 compares Node and native results for
integer and arithmetic indices, numeric increments, unboxed
receiver replacement, Buffer views, signed and floating-point arrays,
callback replacement and alias mutation, writes after await and generator
resumption/completion.

The first test probe also used unsupported Uint8ClampedArray/Int8Array construction,
Float64Array.join, an element assignment as a value, and a valueless initial
next() on a numeric generator input channel. The frontend refused these before
Rust emission. The failed probe is preserved as `unsupported-probe.ts`; the
regression corpus uses supported syntax to isolate this optimization. These
frontend limitations have not been fixed by this step. A second probe reached
the existing Rust refusal for nested suspension in a byte assignment. Its
source and failure are preserved as `suspended-write-probe.ts` and `.log`.
The corpus tests writes after suspension; it does not claim support for
`data[i] = await value` or `data[i] = yield value`.

Evidence: `/tmp/scriptc-byte-writes-20260909/` and
`.red/tmp/native-byte-writes-checkpoint-20260909/`.

An invalid-index write probe traps in `bytes_index` rather than being ignored
as it is by JavaScript. Both the original Rust setter and C setter check
indices this way. The probe and failure are retained as
`invalid-index-probe.ts` and `.log`. This optimization preserves those bounds
checks; it does not establish JavaScript parity for invalid writes.

A temporary Vitest probe mocked `borrowedRustBytesLocal` to always return
null. The resulting release binary retains owned snapshots and reproduces
the same invalid-index panic. With borrowing disabled, the suspended-write
probe is also refused with the same nested-suspension diagnostic. Both
failures are therefore reproduced independently of this optimization. The
temporary test was removed from the package tests and retained in the evidence
folder as `baseline-probe.test.ts`, with `baseline.log` and the two
`baseline-*` output directories.

## Validation

- 13 unit tests passed, including emission and separate index/value fallback
  cases. The emission regression failed before implementation.
- 16 distinct Rust corpora passed with heap auditing across the focused runs:
  14 existing programs in `focused.log`, 1400 in the earlier
  `suspended-write-probe.log`, and final corpus 3125 in `corpus-final.log`.
  Earlier exploratory probes failed as documented above; those logs remain.
- Corpora 1400, 3123, 3124 and 3125 passed in both sanitized C and LLVM lanes
  (8 tests).
- Workspace build, touched-source ESLint, source-line caps and diff whitespace
  checks passed. The Rust runtime source hash is unchanged from the prior
  accepted artifact; runtime tests were not rerun for this emitter-only step.
- Redwall passed its 38 consumer contracts, including 26 native render calls
  with byte-identical PNG output versus Bun. Engine `none`, no external FFI,
  zero fences. All 116 analyzed source hashes match the prior acceptance.

The full plain/sanitized gate remains unaccepted because of the earlier
failed dynamic-import rejection contract. This checkpoint does not approve
shipping the compiler or installing the original complete Redwall CLI.

## Measured outcome

The generated renderer loses 24 direct-local write clones (static call sites),
leaving 7 owned sites. Its release binary is 4,067,736 bytes, 4,768 bytes smaller
than control. Seven-sample medians worsened 7.5%; the eleven-sample repeat with
reversed initial candidate order improved 4.2%. The new binary won 4/7 and
8/11 paired rounds. These rounds do not establish a consistent median-time
gain. It remains 6.05x slower than the freshly compiled Bun in the repeat.
All 60 executions matched output and PNG hashes. Full tables, artifact hashes
and host limitations are in `redwall-native.md`; raw results are in
`measurements/`, `measurements-repeat/` and `comparison.json`.
