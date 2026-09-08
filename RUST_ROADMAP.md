# Rust is the primary backend

The fork compiles original TypeScript and JavaScript, including their admitted
npm implementation sources, through typed IR to memory-safe Rust and a native
executable. Rust is the default for builds and backend-validated coverage.
C and direct LLVM emission are explicit compatibility, debugging and comparison
backends. Library profiles continue to name their emission backend explicitly.
Unsupported Rust features or targets report diagnostics; they never select a
C/LLVM fallback. Cross builds currently require an explicit compatible backend.

Rustc normally uses LLVM internally. The comparison here is between scriptc's
Rust path and its direct LLVM emitter, not a claim to replace LLVM's optimizer.
Changing the default does not establish superior correctness or performance.

## Implementation priorities

1. Native imports with statically known destinations. Compile the module graph,
   preserving lazy initialization, once-only evaluation, live exports, rejection
   behavior and async ordering. The RSP snapshot records 43 import diagnostics
   at local literal paths; reaching these modules can expose additional gaps.
2. Native value boundaries. Complete checked URL/SearchParams references,
   recursive records/JSON and Promise payload conversion. Preserve identity,
   shared mutation and observable errors; do not use an engine to erase gaps.
3. Original consumer acceptance. Finish RSP commands and resident/store
   contracts, then Brain, red-dev and redcode. Adapters may drive original
   entrypoints, but must not rewrite application implementations for admission.
4. Runtime and compiler efficiency. Profile allocations, reference-count work,
   cycle collection, copying, async scheduling and generated code. Add a Rust
   whole-program cache with complete rustc/Cargo/source identities before
   claiming startup-cache parity with C/LLVM.

New native features may land first in Rust. Shared frontend/IR changes retain
regression coverage in the explicit C/LLVM lanes. Those backends must refuse
Rust-only IR honestly; they need not acquire every new Rust implementation.

## Quality acceptance

| Dimension | Required evidence |
| --- | --- |
| Semantic correctness | Original-source differential tests against the selected Node/Bun target; stdout, stderr, exit status and relevant artifacts match. Identity, aliasing, exceptions and async ordering have behavioral witnesses. |
| Native execution | Actual executable with engine none, no deferred runtime fences, and recorded compiler/consumer/generated-source/binary identities. Coverage alone is insufficient. |
| Memory safety | Generated Rust and maintained runtime forbid unsafe code. Cargo tests and Clippy pass on the pinned toolchain; allocation/cycle stress tests cover retention and cleanup. Transitive native dependency safety remains a separately stated boundary. |
| Diagnostics | Unsupported features identify source locations and fail deterministically. Backend emission runs in default coverage; no silent backend or engine fallback. |
| Compatibility | Complete original consumer contract suites pass. Compare identical corpus programs against direct LLVM, recording both refusals and accepted behavior; do not infer capability from diagnostic counts alone. |
| Performance | Fixed-input release builds, identical outputs, repeated runs, recorded toolchains and equivalent resource limits. Compare CPU time, peak RSS, elapsed time, executable size and build time against direct LLVM and relevant Node/Bun baselines. |
| Release readiness | Workspace build, both repository gate lanes, Rust runtime checks and original-consumer acceptance pass on the same checkpoint. Known failures remain visible. |

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
