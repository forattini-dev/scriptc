# Agent Guide

Guidance for agents (and humans) working on this repository. These conventions apply repo-wide; the docs site under `docs/` additionally has its own conventions in `docs/AGENTS.md`.

## Build and test

```bash
pnpm install && pnpm -r build   # build the workspace
pnpm test:sandbox              # default full gate: plain + sanitized lanes (~4 minutes)
```

Use focused local tests while iterating, then use `pnpm test:sandbox` whenever a
full validation gate is required. It loads Sandbox configuration from the
shell and `.env.local`, runs portable coverage across disposable Linux
Sandboxes, and retains the Darwin-native contracts on macOS. Linux hosts run
their supported native-clang contracts locally; other hosts retain those
checks in the Sandboxes. Both lanes green is the bar before shipping any
change.

Only when Vercel Sandbox credentials or `SCRIPTC_SANDBOX_IMAGE` are unavailable,
run the slower local fallback:

```bash
SCRIPTC_TEST_WORKERS=4 pnpm test                 # plain lane
SCRIPTC_TEST_WORKERS=4 SCRIPTC_SAN=1 pnpm test  # sanitized lane
```

`SCRIPTC_TEST_WORKERS` caps the vitest worker pool so concurrent agents don't
contend for cores. Direct local runs default to two workers, two nested native
compiler jobs per worker, and one Cargo job. Full local suites share one
cross-lane advisory lock.

On a workstation that must remain responsive, wrap focused or local commands
with the repository's hard resource limiter:

```bash
pnpm limit -- pnpm exec vitest run <test-file> -t <focused-test> --maxWorkers=1
```

The wrapper uses a transient user cgroup and defaults to half of one CPU, a
2 GiB memory-high threshold, a 3 GiB hard memory limit, no swap, and one test,
native compiler, and Cargo worker. Override the ceilings only through the
documented `SCRIPTC_LIMIT_*` environment variables when the machine has spare
capacity.

Corpus programs are differential tests against Node: every program runs under Node and as a compiled native binary, and stdout, stderr, and exit codes must match byte-for-byte. A new feature lands with corpus programs that pin its behavior both ways.

## Collaboration checkpoints

After completing and checkpointing an implementation step, fetch `origin/main`
and reconcile it before starting the next step. Preserve concurrent agents' WIP:
inspect divergent work and integrate it deliberately instead of overwriting or
resetting another worktree.

Test location follows scope:

- Co-locate white-box unit tests with implementation files under
  `packages/*/src`; name them after the source file (`cc.ts` → `cc.test.ts`).
- Put package-level API and integration tests in `packages/*/test`.
- Put cross-package differential, harness, and end-to-end tests in the root `tests/` tree.

Keep existing tests in place unless a change already touches their organization;
new tests should follow this convention.

## Where things live

- `packages/compiler` — the frontend (tsc API to IR), the typed IR with validator and serializer, and the LLVM, C, and Rust backends.
- `packages/runtime` — the C runtime compiled into every C/LLVM-backed scriptc binary.
- `packages/runtime-rust` — the memory-safe Rust runtime (`#![forbid(unsafe_code)]`) linked by `--backend rust` binaries; its own gate is `cargo test` + `cargo clippy -- -D warnings` on the toolchain pinned in its `rust-toolchain.toml` (CI job `runtime_rust`).
- `packages/cli` — `scriptc build | run | coverage`.
- `tests/` — the differential corpus, diagnostics snapshots, and the harness.
- `docs/` — the documentation site (standalone pnpm workspace); see `docs/AGENTS.md`.
- `scripts/` — repo tooling, including the release version stamp.

## Releases

Releases are maintainer-run; see [RELEASING.md](./RELEASING.md).
