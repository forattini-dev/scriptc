# Native Rust checkpoint — 2026-09-10

This checkpoint preserves the accumulated Rust compiler/runtime work, regression
programs, test harness repairs, optimization research and consumer experiments.
The maintainer requested a commit and branch push while full validation was
still running. This is not release approval or a claim that all regressions
have been eliminated. The main branch is not changed by this checkpoint.

The work includes native import and shared-record identity, callback/promise
boundaries, UTF-16 string behavior, Date components, byte borrowing and loop
optimizations, numeric coercions, runtime compatibility, native cache handling,
and differential tests. The coverage report now distinguishes the native
dynamic runtime from an embedded JavaScript engine.

## Completed checks

- Workspace build passed with the pinned runtime Rust toolchain.
- The focused coverage and CLI exit checks passed 31 tests. The whole-corpus
  coverage sweep belongs to the full gate and was not counted in that result.
- The dynamic JavaScript witness built with Rust and --no-engine and matched
  Node stdout, stderr and exit status.
- Current Redwall passed 38 consumer contracts, including 26 native renders
  compared byte-for-byte with Bun. Its executable is 4,072,912 bytes (3.88 MiB).
- All 117 consumer input hashes and the original artwork/font were verified.

## Remaining validation

The full plain and sanitized gates must both pass. Their live state at capture
is preserved in checkpoint.json and full-gate-in-progress.json; these files
are timestamped snapshots, not live status. The final benchmark of the current
executable has not run. The queued 43-entry consumer refresh has not run.

historical-redwall-report.md and historical-redwall-samples.json are a separate
completed experiment: median Rust 586.64 ms versus compiled Bun 639.25 ms,
76.96 versus 135.00 MiB peak RSS, and 3.88 versus 77.64 MiB executable size.
Do not attribute these timings to the current accepted executable. The same
original workload and byte-parity requirements remain mandatory for its new
measurement. This does not establish superiority across all TS projects.

Evidence retains original local source and artifact paths for traceability.
Generated executables, Cargo caches and disposable worktrees remain local and
are not versioned. Consumer source repositories were not modified.
