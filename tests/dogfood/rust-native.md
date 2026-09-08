# Rust native consumer acceptance

The rollout keeps five milestones: RPC sidecar; original Redwall renderer
and benchmarks; shared native dependencies and Effect semantics; RSP/Brain
command acceptance; full red-dev/redcode and measured runtime optimization.

These are named acceptance workloads under the
[native TypeScript contract](../../NATIVE_TYPESCRIPT.md), not a promise of
unlimited Node/Bun compatibility. Legitimate consumer migrations are recorded
separately; comparisons then use the same implementation. Historical
original-source milestones below retain their stated scope. Efficiency work
on accepted workloads proceeds alongside remaining admission work.

The first consumer is redcode's original `packages/rpc-sidecar/src/cli.ts`.
It compiles with `backend: rust`, `allowEngine: false`, and `target: bun`.
The native executable passed all eight existing sidecar contracts on
2026-09-07: JSON authorization, TOON authorization, ordered frames,
notifications, size limits, redirect refusal, URL validation, and SIGTERM.
This is consumer acceptance; the repository's full gates remain separate.

Validation completed for this milestone: 148 runtime tests and Clippy with
warnings denied on Rust 1.98.0; seven engine-admission tests; five inherited
JSX configuration tests; one Bun reader-type test; and one CLI admission
test. The full plain/sanitized repository gate has not completed.

The same original sidecar compiled with Bun 1.4.1 (`bun build --compile
--minify`) also passed the eight contracts. Executable sizes on Linux x64
were 4,376,232 bytes for Rust and 81,368,544 bytes for Bun. This establishes
an executable-size reduction, without a CPU/RSS/throughput claim.

Run from the scriptc repository after building the compiler:

```sh
pnpm build
pnpm limit -- node scripts/native-acceptance.mjs \
  --entry /path/to/redcode/packages/rpc-sidecar/src/cli.ts \
  --target bun --out .red/tmp/native-sidecar \
  --cwd /path/to/redcode/packages/rpc-sidecar \
  --binary-env REDCODE_RPC_SIDECAR_COMMAND \
  -- bun test test/sidecar.test.ts
```

`acceptance.json` retains compiler/consumer revisions, compiler distribution
and runtime source hashes, analyzed source hashes, generated Rust and binary
hashes, the execution profile, and the contract command/exit status. Contract
stdout/stderr are separate files. A build or contract failure exits nonzero.
Without a contract command, the report's `contract` field stays null.

Use `dogfood-scoreboard.mjs --backend rust --no-engine` for admission
diagnostics. Its `validation` field distinguishes frontend coverage from
backend emission. Neither mode invokes rustc or executes a consumer.

Redwall consumer acceptance and its first benchmark are recorded below;
dependency/Effect, RSP/Brain, and full application acceptance remain unfinished.

The current Effect lifetime fixes, regression witnesses and remaining
semantics are tracked in [effect-native.md](./effect-native.md).
Original RSP admission and blocker ownership are tracked in
[rsp-native.md](./rsp-native.md).
The complete repository gates remain separate; current failures and repairs
are tracked in [native-gate.md](./native-gate.md). Performance claims require a
separate benchmark with fixed inputs, matching outputs, repeated runs,
CPU time, peak RSS, executable size, and pinned compiler/consumer identities.
No speed or memory improvement is established by the sidecar contracts.

The original Redwall renderer (red-dev revision
`a5f33a32f36e8448e6faa4121588b92ec21b9f59`) now compiles to a native
Rust executable with `engine: none`, no external FFI, and no runtime
fences. Its fixed-input adapter reaches 769 statements with no reachable
diagnostics. This does not establish admission of the full red-dev CLI.

The first execution was stopped after sustained memory-high pressure:
the process cgroup peaked at 2,258,354,176 bytes without producing a new
PNG. Two runtime regressions reproduced unbounded candidate growth in
100,000 synchronous byte reads and temporary-object allocations. The
collector now deduplicates live candidates and prunes dead Weak handles
without tracing borrowed payloads; a separate drop counter preserves
safe-point collection scheduling. All 151 runtime tests and Clippy pass after the fix. The renderer now
completes, with exact PNG parity against Bun for all 26 native invocations
exercised by the original 38 contracts (38 passed, 112 assertions). A
separate fixed-input run produced 108,881 bytes, SHA256
`4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6`.

Known limits relevant to subsequent work:

- Engine absence permits native dependencies that internally use unsafe or C.
- The new Fetch reader supports byte response bodies and default readers;
  general Web Streams and BYOB readers require their own implementation.
- Signal listeners cap blocking event-loop waits at 50 ms. A wakeup descriptor
  can remove that periodic wakeup in a later measured event-loop change.
- Broader Fetch conformance, including redirects and HTTPS, needs separate
  coverage beyond the sidecar's loopback/manual-redirect contracts.

Redwall compatibility adds Float64Array throughout the IR, frontend,
C/LLVM/Rust emitters and both runtimes. Eight-byte views share storage and
retain f64 precision. Corpus 3000 passes the Node/native differential in
all three backends. Further corpus programs cover numeric-array/tuple
TypedArray.set, dense array clearing, homogeneous tuple indexing/join,
unknown indexed records, mixed spreads, proven non-null filter predicates,
and fixed compression levels. Corpus 3001-3003 passes all three backends.
Compiler/CLI builds, admission tests and lint pass. Corpus 3004-3008 now also passes all three backends. The cold LLVM
timeout passed on retry; a real level-1 compression-byte mismatch led to
an explicit SC2020 refusal for fixed levels 1-8, until their compatibility
is implemented. This slice admits only -1, 0 and 9. Fourteen admission
tests cover retained filter, array-length and compression-level fences.

Prepare reproducible consumer adapters without rewriting its sources:

```sh
node scripts/prepare-native-redwall.mjs --consumer ../red-dev --out /tmp/native-redwall
pnpm limit -- bun /tmp/native-redwall/fixture.ts
pnpm limit -- node scripts/native-acceptance.mjs \
  --entry /tmp/native-redwall/main.ts --target bun \
  --out /tmp/native-redwall/native --consumer-root ../red-dev --cwd ../red-dev \
  --binary-env SCRIPTC_NATIVE_REDWALL_BINARY -- \
  bun test --timeout 300000 --preload /tmp/native-redwall/preload.ts src/redwall-render.test.ts
pnpm limit -- bun build --compile --minify /tmp/native-redwall/main.ts --outfile /tmp/native-redwall/bun-program
pnpm limit -- node scripts/native-benchmark.mjs \
  --spec /tmp/native-redwall/benchmark.json --out /tmp/native-redwall/measurements
```

The preload replaces only `renderRedwall` with native subprocess calls;
helper contracts continue to exercise the original TypeScript. Each native
render is additionally compared byte-for-byte with the original Bun
implementation. The hook requires at least one native invocation, reports
its count, rejects stderr/failed native calls and enables heap auditing. The benchmark uses the same descriptor and assets
for both compiled adapters and requires exact PNG bytes before reporting.

The full plain/sanitized gate is not green. The earlier plain run was
interrupted after cache-contract failures: inherited `LD_LIBRARY_PATH`
disabled cache admission, the Zig shim had no selected version, and three
runtime-shadow fixtures omitted QuickJS's dtoa source. The fixtures now
copy both vendor dependencies, and all three focused cache tests pass. Local validation must unset LD_LIBRARY_PATH,
use the installed Zig binary in its test-local PATH, and use a private
0700 cache root; no global workstation configuration is required.

`scripts/native-benchmark.mjs` measures fresh Linux processes with GNU time.
Pass `--spec cases.json --out results --runs 7 --warmup 2`. The spec contains
`cases: [{name, command: [absoluteExecutable, ...args], cwd, artifacts: []}]`
and optional `inputs: [sourceOrAssetPaths]`. Paths are relative to the spec,
except artifacts are relative to each case's cwd. All candidates and warmups
must produce identical stdout, stderr, exit status, and artifact bytes.
Artifacts must be refreshed each run. An optional case `acceptance` path
checks the executable hash against an engine-free native-acceptance report.
The report records raw samples, executable/input hashes, CPU seconds, peak
RSS in KiB, elapsed time, and min/median/max excluding warmups. Run under the
same resource limits on an otherwise idle host; elapsed time includes launch
cost and reflects any cgroup throttling. Four harness tests cover equivalent
runs, output mismatch, artifact mismatch/staleness, and command failure.
The first Redwall measurement contains seven runs per candidate and two
warmups; all 18 outputs match. Raw evidence is in
`redwall-native.measurements.json`, with build/contract identities in
`redwall-native.evidence.json`. Median results on this shared Linux host:

| Metric | Rust | Bun compiled |
| --- | ---: | ---: |
| Executable bytes | 3,836,816 | 81,393,120 |
| CPU seconds | 8.88 | 1.41 |
| Peak RSS KiB | 110,996 | 137,632 |
| Elapsed milliseconds | 17,805 | 2,857 |

Rust's executable is 21.2 times smaller and median peak RSS is 19.4% lower
in this workload, while CPU consumption is 6.3 times higher. Runtime
optimization remains necessary. These are fresh-process measurements
under a 50% CPU quota on a host running unrelated workloads, not an
idle-host throughput benchmark. The report retains cgroup limits and
per-sample load averages. It identifies the tested dirty compiler snapshot;
it must not be relabeled as a later clean commit.
