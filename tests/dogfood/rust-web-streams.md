# Native Rust Web Streams parity

The Rust-default checkpoint (`512fcc30`) refused `fetch.streamNew` while C and
direct LLVM compiled `tests/fixtures/node-types/fetch-static.ts`. The constructor
now emits native Rust. The adoption test explicitly builds and executes that
same entry through all three backends with `allowEngine: false`, checking the
reported backend, engine, stdout and stderr. Its functions containing network
requests are not invoked: this is constructor/admission evidence, not an upload
or AbortSignal transport-conformance claim.

The maintained Rust runtime implements default readable streams with a queue,
start/pull/cancel callbacks, the default one-entry high-water mark, controllers,
reader locks, pending reads and the reader's closed promise. It traces queued
values, source callbacks and reader cycles. Release rejects pending reads;
cancellation settles them; errors discard queued chunks and retain their reason.
The generated code preserves the underlying source as callback `this`.

Typed read results are projected when the read settles. A separate Promise.map
reaction changed the order relative to queueMicrotask; corpus 3037 reproduced
that difference and now guards the direct settlement path. Byte chunks reuse
their reference, including a live typed reference when one exists, rather than
copying each incoming HTTP chunk through the generic dynamic-value converter.

## Behavioral witnesses

| Corpus | Contract |
| --- | --- |
| 3034 | Synchronous start; desiredSize; byte identity and mutation; close/drain; locks and reacquisition |
| 3035 | Async start gates pull; async pulls serialize; completion drains the queue |
| 3036 | Empty source; pending-read release; locked cancellation; cancel callback settlement; errors and throwing start |
| 3037 | Read/end reactions retain their order relative to queueMicrotask |
| 3038 | Reader.closed identity, fulfillment, rejection and release |
| 3039 | Returned start Promise assimilation relative to queueMicrotask |
| 3040 | Original static-stream-this fixture's source callback binding and mutation witness |
| 2997–2999 | Existing HTTP response readers: byte bodies, cancellation and no-content responses |

Corpus 3039 passed on Rust and exposed an existing C/LLVM ordering difference:
C ran pull before the later microtask. The shared C runtime now retains the
separate start-settlement job after awaiting the callback's Promise. The test
remains in every applicable differential lane.

Rust runtime tests additionally cover one-entry backpressure, delayed start,
pending-read release, retention of a lock after its reader variable is dropped,
collection of abandoned reader/source/controller cycles, and closed-promise
replacement after release. All generated Rust and the maintained runtime keep
their unsafe-code prohibition.

## Remaining boundaries

This is a measured slice of parity. It does not establish complete WHATWG
Streams or Fetch conformance, support for every callback return/argument shape,
ReadableStream.from, BYOB readers, streaming HTTP uploads, or full original
consumer acceptance. Rust's Fetch transport and the broader conversion of
native values still need their own shared C/LLVM/Node contract comparison.
The closed-promise witness uses the admitted direct property/await form;
the shared frontend still refuses the explored `.closed.then(...)` and typed
closed-promise variable forms. The cycle tests cover reader and source/controller
cycles, not every retention path through pending Promise callbacks.

The diagnostic adoption snapshot now reflects the implemented URL.hash getter
and the existing static Response.clone refusal. URL.hash was checked through
the three native differential lanes before removing its stale refusal.

Repository release validation remains separate. The Sandbox gate cannot start
without SCRIPTC_SANDBOX_IMAGE; focused local plain/sanitized checks and the Rust
crate gate do not replace a fresh full repository gate. See
[native-gate.md](./native-gate.md) for the outstanding full-suite state.

## Checkpoint validation (2026-09-07)

The final plain differential selection passes 30 tests: ten programs each in
Rust, C and direct LLVM. Each lane compares with Node; the LLVM lane additionally
compares with explicit C. This includes the seven new programs and the three
existing HTTP-reader regressions above. The 4,183 unselected cases were not run.

```bash
SCRIPTC_LIMIT_CPU=100% \
SCRIPTC_CACHE_DIR=/home/cyber/.cache/scriptc-rust-native-gate \
CARGO_TARGET_DIR=/home/cyber/.cache/scriptc/cargo-target \
pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/rust-differential.test.ts \
  tests/harness/llvm-differential.test.ts \
  tests/harness/differential.test.ts \
  -t '303[4-9]-|3040-|299[7-9]-' --maxWorkers=1
```

The standalone before/after adoption audit retains the original failure in
`/tmp/scriptc-backend-equivalence-audit.json` and the successful three-backend
result in `/tmp/scriptc-backend-equivalence-after.json`. All three resulting
executables exit zero with empty stdout/stderr and `engine: none`.

The complete project-adoption file and default-backend API file pass all
20 tests (15 + 5), including a flagless Rust build with no C compiler and no
engine, explicit C/LLVM selections, and refusal of unsupported Rust targets.
They were run together through the same resource-limited wrapper:

```bash
pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  packages/compiler/test/default-backend.test.ts \
  tests/harness/project-config.test.ts --maxWorkers=1
```

Final logs: `/tmp/scriptc-stream-parity-final.log`,
`/tmp/scriptc-stream-adoption-final.log`,
`/tmp/scriptc-stream-runtime-checkpoint.log`,
`/tmp/scriptc-stream-static-checks.log`,
`/tmp/scriptc-stream-build-final.log` and
`/tmp/scriptc-stream-order-baselines-check.log`.

The selected sanitized run passes 27 tests: ten corpus cases per C/LLVM lane,
the original adoption entry in C and LLVM, the diagnostic snapshot, and four
existing `static-stream`/`static-stream-this` integration contracts. The four
integration contracts also pass plain. These larger fixtures exercise C/LLVM
transport behavior; they were not run through Rust in this checkpoint.

```bash
SCRIPTC_SAN=1 SCRIPTC_LIMIT_CPU=100% \
SCRIPTC_CACHE_DIR=/home/cyber/.cache/scriptc-rust-native-gate \
CARGO_TARGET_DIR=/home/cyber/.cache/scriptc/cargo-target \
pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/llvm-differential.test.ts tests/harness/differential.test.ts \
  tests/harness/project-config.test.ts tests/harness/fetch.test.ts \
  -t '303[4-9]-|3040-|299[7-9]-|fetch AbortSignal|declared-but-not-lowered|static-stream' \
  --maxWorkers=1
```

The final sanitizer log is `/tmp/scriptc-stream-sanitized-final.log`; the plain
integration log is `/tmp/scriptc-stream-fetch-regression.log`. An independent
`nm` check found `__asan_init` in the final corpus 3039 LLVM executable; its
binary identity is retained in `/tmp/scriptc-stream-asan-final.json`.

Workspace build, maintained Rust/compiler source-size limits, generated
backend-libcall inventory and ESLint for the changed compiler files pass.
The inventory records recognized names, not a compatibility percentage.
The all-target Clippy check also required mechanical corrections to existing
Effect test closures and failure matching; their assertions are retained.
All 172 Rust runtime tests and the all-target Clippy check pass on the pinned
Rust 1.98.0 toolchain, including the five new co-located Web Streams tests.

The seven new corpus entries also have reviewed preflight/order baselines:
each has no preflight diagnostics and evaluates its single source module.
Only these missing entries were added to the canary's baseline file; older
missing or changed baselines remain part of the outstanding full gate.

Logs under `/tmp` are local workstation evidence and can expire. The portable
evidence is the checked-in corpus, adoption assertions and runtime tests.
