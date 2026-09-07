# Rust native consumer acceptance

The rollout keeps five milestones: RPC sidecar; original Redwall renderer
and benchmarks; shared native dependencies and Effect semantics; RSP/Brain
command acceptance; full red-dev/redcode and measured runtime optimization.

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

The Redwall, dependency/Effect, RSP/Brain, and full application milestones
still need implementation and acceptance. Performance claims require a
separate benchmark with fixed inputs, matching outputs, repeated runs,
CPU time, peak RSS, executable size, and pinned compiler/consumer identities.
No speed or memory improvement is established by the sidecar contracts.

A fixed-input adapter calling the original Redwall renderer (red-dev
revision `a5f33a32f36e8448e6faa4121588b92ec21b9f59`) reached 741 statements
with 15 diagnostics in native Rust analysis. Enabling checked dynamic values
did not remove the blockers. The required compiler work includes Float64Array
representation, deflate options, tuple indexing and typed-array set inputs,
filter predicates, spreads, and unknown-valued brand-token records. Preserve
the renderer's float precision and compression settings when adding support.

Known limits relevant to subsequent work:

- Engine absence permits native dependencies that internally use unsafe or C.
- The new Fetch reader supports byte response bodies and default readers;
  general Web Streams and BYOB readers require their own implementation.
- Signal listeners cap blocking event-loop waits at 50 ms. A wakeup descriptor
  can remove that periodic wakeup in a later measured event-loop change.
- Broader Fetch conformance, including redirects and HTTPS, needs separate
  coverage beyond the sidecar's loopback/manual-redirect contracts.

The first Redwall compatibility slice adds Float64Array throughout the IR,
frontend, C/LLVM/Rust emitters and both runtimes. Eight-byte backing views
retain shared storage and full f64 precision. The focused C and LLVM
Node/native differential checks passed; the Rust differential is pending.
All 149 Rust runtime tests and Clippy passed on 1.98.0. Compiler/CLI builds
and lint passed. Re-analysis of the unchanged renderer reaches 755
statements with 11 diagnostics; it still does not compile end to end.

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
No consumer performance measurements have been recorded with this tool yet.
