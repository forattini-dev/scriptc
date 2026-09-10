# Borrowed byte reads in the Rust emitter

The emitter can now borrow a local byte-buffer handle for `get`, `length`,
`byteLength` and the integer-loop length condition. It does not clone a handle
just to immediately lend that clone to the runtime. Shared IR is unchanged;
the optimization is implemented against IR metadata, not by rewriting Rust.
Runtime storage, bounds checks, float/typed-array conversions and the existing
Rust safety policy are unchanged. At this initial checkpoint, writes retained
their original snapshots; see `rust-byte-write-borrows.md` for the subsequent
write-side optimization.

Eligibility is deliberately conservative:

- The receiver must be a local with byte storage. Globals, computed receivers,
  unions, boxed/forced-boxed/TDZ bindings, async functions and generators retain
  the existing path.
- Later arguments must fit a bounded whitelist of scalar local reads,
  constants, arithmetic, conditions, numeric increments and nested eligible
  byte reads. Calls, assignments, coercion hooks and suspension are refused.
- Expression contexts with preevaluated replacements keep those snapshots;
  borrowing must never bypass a replacement and reread the original local.
- The borrow is of the handle, not of its RefCell storage. The runtime acquires
  its storage access after the index expression has finished. Numeric index
  increments still execute once and in their original order.

The Redwall-generated Rust has 56 direct local byte-read/length call sites
that previously cloned and now borrow. This is a static source count, not a
count of runtime operations. The previous generated source is retained as the
control. Bun is rebuilt using `bun build <same main.ts> --compile`, with the
same consumer sources and input. Executables are benchmarked directly; the
Rust control only measures the change relative to our prior implementation.

Corpus 3124 covers arithmetic indices, pre/post-increment, nested reads,
unboxed receiver replacement inside an index, callback replacement, alias
mutation, captured reads, buffer views, Float64Array values, await snapshots
and generator resumption/completion. The direct-assignment case lives in a
function without captures so it tests the actual borrowing decision.

A first version left its generator suspended after the second yield. Heap
audit reported three live objects both with borrowing enabled and with the
helper mocked off. The control Rust contains the original handle clones.
That pre-existing failure is retained in `abandoned-generator.ts`,
`abandoned-generator.json`, `baseline/` and `baseline.log` in the evidence
folder. Completing the generator passes the audit. The abandoned-generator
cleanup issue is not fixed or suppressed by this change.

Evidence:
`.red/tmp/native-byte-borrows-checkpoint-20260909/` and
`/tmp/scriptc-byte-borrows-20260909/`.
The full plain/sanitized gate remains unaccepted; the prior plain attempt
stopped on the failed dynamic-import rejection contract. Sandbox image
configuration is unavailable. Focused validation does not approve shipping
the compiler or installing the full Redwall CLI.


## Measured outcome

In the same seven-sample round, direct executable medians were
830.34 ms for Bun --compile,
5813.65 ms for the previous scriptc binary and
5218.30 ms for scriptc with borrowed reads. This is an
observed 10.2% reduction relative to the Rust control;
the new binary won five of seven round comparisons amid substantial host
variation. It remains 6.28x slower than Bun for this input.
The executable is 4072504 bytes, 9120
bytes smaller than control, with essentially unchanged peak RAM. All 24 PNGs
and process outcomes matched. See `redwall-native.md` for the complete table,
provenance and limits.
