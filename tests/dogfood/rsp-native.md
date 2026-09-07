# RSP native admission

The next consumer is the original
`red-skills/apps/rsp/src/cli.ts`, without source rewriting or a JavaScript
engine. Full RSP compilation and command acceptance are not achieved yet.
The consumer checkout inspected on 2026-09-07 is at
`c5255e006318fa3ec9aea51ccac11778da3888a1`.

The refreshed static survey uses `backend: rust`, `target: bun`,
`allowEngine: false` and `npmStatic: auto`. It initially reported 203
diagnostics and 165 failed statements across 696 reached statements. These
are diagnostic occurrences, including cascades, not 203 independent bugs.
`@reddb-io/shared` and `@reddb-io/build-info` enter the static graph. TOON's
inferred export surface causes fallback at 45 import sites, SDK's at one;
the transitive `cli-args-parser` import also remains outside native admission.
The diagnostic-only dynamic survey still contains island statements and
cannot be counted as engine-free consumer acceptance.

## Numeric flags for the resident lock

The shared resident's `tryAcquireExclusiveLock` calls
`open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)`.
The compiler rejected O_CREAT, and its FileHandle lowering accepted only
string flags. The corpus fallback declarations also omitted the open flags.

The compiler now recognizes O_RDONLY/O_WRONLY/O_RDWR/O_CREAT/O_EXCL/O_TRUNC/
O_APPEND through named and namespace imports, using the destination
platform's values. Numeric `fs/promises.open` has a dedicated typed IR call
and C, LLVM and Rust emission. Existing string/default-argument behavior
keeps its original route; mixed string/number and optional-number flag
unions need separate lowering coverage.

On Unix the Rust runtime opens the descriptor through safe rustix APIs and
transfers its ownership into FileHandle. Numeric creation does not imply
truncation or append. Exclusive creation is performed by the OS, with the
requested creation permissions and non-inheritable descriptors. The Windows
Rust adapter maps the common access/create/exclusive/truncate/append bits;
Windows execution and broader flag combinations are not validated by this
Linux checkpoint.

Corpus 3026 covers exclusive creation/EEXIST, retained contents, read/write,
append, truncation and readonly access. Corpus 3027 covers invalid numeric
flags, rejected mode and argument evaluation order. A runtime test races
eight threads and requires exactly one successful lock owner. Platform-table
tests compare the host Node ABI and distinct Linux/Darwin/Windows lock masks.

The original RSP survey after the repair reports 202 diagnostics and 164
failed statements; `packages/shared/resident-core.ts` has no diagnostics in
that reached analysis. This establishes removal of this specific blocker,
not a compiled RSP executable.

Validation: 167 runtime tests and Clippy pass on Rust 1.98.0. Corpus 3026,
3027 and the existing FileHandle corpus 2686 match Node in Rust, C and LLVM;
the same three cases pass the sanitized C/LLVM lanes. Both constant-table
tests, the workspace build, generated-libcall and source-size checks pass.
Focused ESLint reports zero errors and 312 warnings in the selected files.

Local evidence is retained in `/tmp/scriptc-rsp-before-numeric-open.json`,
`/tmp/scriptc-rsp-npm-auto-native-survey.json`, and the
`/tmp/scriptc-rsp-open-*.log` validation logs.

## Next acceptance work

1. Reproduce the TOON/SDK export-surface fallbacks and native admission of
   the transitive CLI parser; repair the causes before changing fallback policy.
2. Implement the native bigint/hrtime path used by invocation telemetry,
   preserving integer precision.
3. Address generic flag-schema records, Promise payload widening and typed
   ChildProcess values crossing unknown boundaries, guided by consumer diagnostics.
4. Fill the remaining Node API gaps, including appendFileSync options.
5. Compile the original entrypoint and run real CLI contracts for usage/errors,
   passthrough stdout/stderr/exit behavior, then resident/store operations in
   disposable test directories.

Full repository plain/sanitized gates remain a separate release requirement;
see [native-gate.md](./native-gate.md). RSP performance claims require its own
fixed-input benchmarks after command acceptance.
