# Native callable conversion direction

The Redwall consolidation gate stopped at C corpus 2470 after 756 passing
tests. Its `mockImplementations` member adapts a dynamic function to a typed
function receiving a record of callbacks. The admission check treated every
record in a function signature as a dynamic-to-typed extraction. This rejected
an outbound argument snapshot that the existing C/LLVM adapters support.

`native-callable-record-support.ts` now follows conversion direction. Function
parameters reverse it; results and record fields preserve it. Both explicit
`dynCheck` adapters and `dynFrom` boxing thunks participate. The latter matters:
boxing a typed function generates a thunk that checks its dynamic arguments,
even without an explicit `dynCheck` node at that argument in the original IR.
Record recursion tracks direction as well as shape identity.

The guard still rejects shared callable record extraction, including nested
callback arguments, boxed methods and returned records. It does not claim that
C/LLVM gained Rust's shared map identity. Corpus 2470 now actually calls
`mockImplementations` with an inline record and restores the original method.
Rust, C and LLVM match Node for the strengthened program.

## Nested Rust factory admission

An older admission test still expected SC1100 for a JS factory method taking
`Record<string, { count: number }>`. The pre-change compiler dist already
accepted this signature. Before updating that expectation, new Rust-only
corpus 3145 verified native execution without an engine: outer and inner
identity, retained references, mutation from both sides, replacement of the
inner object, and recapturing an independent dictionary all match Node.

Two exploratory probes exercised separate unsupported operations. Passing an
unannotated evolving JS object into 2470's typed parameter introduces a real
shared-record extraction that C/LLVM still reject. Compound assignment on a
computed nested receiver in the new factory produces SC1090; the identity
fixture uses ordinary assignment to isolate the factory boundary. These
limitations were not removed or silently admitted by this change. No consumer
repository was edited.

## Evidence

Directory: `/tmp/scriptc-shared-exit-20260909/`.

- `direction-red-valid.log`: three incorrect direction refusals reproduced.
- `boxed-red.log`: hidden record extraction in a boxing thunk was not refused.
- `admission-final.log`: 34 tests passed, covering direction, nested records,
  factories and optional records.
- `factory-baseline.json`: pre-change dist admits the nested factory signature.
- `corpus-green.log`: exploratory failures described above, retained for audit.
- `corpus-isolated.log`: four differential tests passed (2470 Rust/C/LLVM and
  3145 Rust); the LLVM harness additionally checks C against Node.
- `corpus-sanitized.log`: two sanitized differential tests passed for 2470.
- `build.log`: workspace build passed.

These focused results do not approve the complete plain/sanitized gate or
replace the final Redwall acceptance and paired Bun benchmark. The measured
compression checkpoint remains documented in `redwall-zlib-borrowed-input.md`.
