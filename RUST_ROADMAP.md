# Rust is the primary backend

The fork prioritizes well-typed TypeScript compiled through typed IR to
memory-safe Rust and an efficient native executable. The
[native TypeScript contract](./NATIVE_TYPESCRIPT.md) separates consumer
requirements, compiler gaps and excluded capabilities. Existing JavaScript
and npm implementation sources remain supported where statically admitted;
arbitrary Node/Bun application compatibility is not an unlimited obligation.
Rust is the default for builds and backend-validated coverage.
C and direct LLVM emission are explicit compatibility, debugging and comparison
backends. Library profiles continue to name their emission backend explicitly.
Unsupported Rust features or targets report diagnostics; they never select a
C/LLVM fallback. Cross builds currently require an explicit compatible backend.

Rustc normally uses LLVM internally. The comparison here is between scriptc's
Rust path and its direct LLVM emitter, not a claim to replace LLVM's optimizer.
Changing the default does not establish superior correctness or performance.

## Implementation priorities

1. Correct native type and value boundaries. Extend the
   [native local import slice](./tests/dogfood/rust-native-imports.md).
   Lazy evaluation, cached failures and live primitive exports now have native
   witnesses, including runtime wildcard graphs, diamonds and cycles. Exported
   functions can also return primitive/void Promises through native views that
   retain identity and reaction ordering. Open unknown-valued record exports
   share the native dynamic map, including nested map aliases and mutation.
   The next boundaries are records with declared fields or typed index values,
   arrays, classes, richer function signatures and shared static namespace
   objects, all while preserving identity and shared mutation.
   The immediate witness is the already-typed RSP telemetry record/callback;
   its declared fields and index signature need shared storage, not a consumer
   signature rewrite. Complete checked URL/SearchParams references,
   recursive records/JSON and Promise payload conversion. Preserve identity,
   shared mutation and observable errors; do not use an engine to erase gaps.
2. Runtime and compiler efficiency alongside semantic work. Profile
   allocations, reference-count work, cycle collection, copying, async
   scheduling and generated code. Add a Rust
   whole-program cache with complete rustc/Cargo/source identities before
   claiming startup-cache parity with C/LLVM. Measure already accepted
   workloads; optimization need not wait for full application compatibility.
3. Actionable admission diagnostics. Apply the contract's blocker categories
   to minimized failures before assigning ownership. The CLI does not yet
   expose those categories; existing SC codes alone cannot determine them.
   Consumer guidance must name a documented rule and concrete adaptation;
   compiler gaps must not be presented as type errors in valid consumer code.
4. Bounded consumer acceptance. Use RSP commands and resident/store contracts,
   then Brain, red-dev and redcode as named workloads. Classify and document
   required consumer migrations before expanding API/dependency scope. After
   migration, compare the same implementation and inputs across runtimes.
   Adapters may drive entrypoints, but must not hide compiler defects by
   replacing application logic. Full applications remain separate milestones
   from accepted entrypoints; no blanket Node/Bun emulation is promised.

New native features may land first in Rust. Shared frontend/IR changes retain
regression coverage in the explicit C/LLVM lanes. Those backends must refuse
Rust-only IR honestly; they need not acquire every new Rust implementation.

## Quality acceptance

| Dimension | Required evidence |
| --- | --- |
| Semantic correctness | Original-source differential tests against the selected Node/Bun target; stdout, stderr, exit status and relevant artifacts match. Identity, aliasing, exceptions and async ordering have behavioral witnesses. |
| Native execution | Actual executable with engine none, no deferred runtime fences, and recorded compiler/consumer/generated-source/binary identities. Coverage alone is insufficient. |
| Memory safety | Generated Rust and maintained runtime forbid unsafe code. Cargo tests and Clippy pass on the pinned toolchain; allocation/cycle stress tests cover retention and cleanup. Transitive native dependency safety remains a separately stated boundary. |
| Diagnostics | Unsupported features identify source locations and fail deterministically. Blocker reports distinguish documented consumer obligations, compiler gaps and excluded capabilities with evidence. Backend emission runs in default coverage; no silent backend or engine fallback. |
| Compatibility | Named consumer workloads meet the native contract and pass their complete relevant suites. Record any consumer migration separately; comparisons use the same implementation. Compare identical corpus programs against direct LLVM, recording both refusals and accepted behavior; do not infer capability from diagnostic counts alone. |
| Performance | Fixed-input release builds, identical outputs, repeated runs, recorded toolchains and equivalent resource limits. Compare CPU time, peak RSS, elapsed time, executable size and build time against direct LLVM and relevant Node/Bun baselines. |
| Release readiness | Workspace build, both repository gate lanes, Rust runtime checks and the claimed consumer milestones pass on the same checkpoint. Known failures and unaccepted workloads remain visible. |

Performance claims name the workload and metric. The target is lower CPU and
memory costs on the priority consumers, while maintaining correctness and
acceptable latency. Rust's ownership checks alone do not guarantee this:
JavaScript sharing and cycles still require runtime memory management.

## Current evidence and limits

[Consumer acceptance](./tests/dogfood/rust-native.md) records the original RPC
sidecar and Redwall milestones. Redwall's recorded benchmark has a smaller
Rust executable and lower peak RSS than Bun, but higher CPU usage; it does
not establish performance superiority, or a direct LLVM comparison.

[RSP admission](./tests/dogfood/rsp-native.md) remains incomplete, and the
[full repository gate](./tests/dogfood/native-gate.md) remains pending/red.
The native ReadableStream constructor gap exposed by the default migration is
addressed by the [Web Streams parity slice](./tests/dogfood/rust-web-streams.md).
Its original adoption entry now builds and runs in Rust, C and LLVM without an
engine. The document distinguishes the tested stream contracts from the wider
Fetch/Streams behavior and full consumer acceptance still to complete.

Making Rust primary is an implementation and product direction, not a release
certification or a claim that the full applications already compile.
