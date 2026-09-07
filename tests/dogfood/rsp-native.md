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

## TOON type-only exports checkpoint

TOON's fallback came from erased declaration-only exports: `JsonValue`,
`JsonObject`, `ToonlLineEmitter` and `ToonlRecord` disappeared when static
resolution hid its `.d.ts`. The ESM bridge now appends JSDoc type aliases
that reference compiler-owned, in-memory declaration copies. It preserves
the runtime JavaScript's inferred signatures and original source offsets.
Only those registered copies receive structural type lowering; an arbitrary
declaration filename does not bypass the npm engine boundary.

This first slice supports self-contained, directly exported, non-generic
interfaces and type aliases, including recursion, merged interfaces and
interface inheritance. Exact package exports, legacy main/types mappings,
internal declaration siblings and workspace symlinks are covered. Declared
functions, classes and variables do not become runtime exports. Declaration
imports/reexports, generic exports, runtime export-star barrels, nested or
pattern-based type mappings and ambiguous type surfaces remain unsupported.
Names already mentioned by the implementation or its JSDoc are preserved.
All declaration reads are tracked for cache invalidation, with state reset
between loads; no consumer or installed package files are rewritten.

The original RSP survey now admits `@reddb-io/toon` as static. It reaches
1,374 statements versus 696 before this step, with 206 failed statements
and 202 diagnostics. The unchanged diagnostic total includes newly reached
failures, so it is not a count of independent blockers removed. The reached
analysis contains zero island statements; that still does not establish a
successful native build. SDK remains in fallback, and `cli-args-parser`
remains outside auto admission. Reached TOON implementation diagnostics now
include an optional Error message; consumer sites also expose recursive JSON
record-coercion gaps.

Validation: 51 focused tests pass across npm-static regression coverage,
input tracking and the new type bridge. A subsequent focused sanitized run
passes 45 tests, including four additional admission cases and C/LLVM
Node differential executions (the Rust case was already verified in the
plain run). The native fixture covers records, `Readonly`, intersections
and recursive records; stdout, stderr and exit status match Node in Rust,
C and LLVM with `allowEngine: false`. Workspace build and source-size
checks pass; focused ESLint reports zero errors and 124 warnings in the selected files.
The full repository gate has not been rerun for this checkpoint.

Evidence: `/tmp/scriptc-rsp-before-toon-types.json`,
`/tmp/scriptc-rsp-after-toon-types.json`,
`/tmp/scriptc-rsp-preflight-before-toon-types.json`, and
`/tmp/scriptc-toon-types-*.log`. The failing regression before implementation
is retained in `/tmp/scriptc-toon-types-before.log`.

## CLI parser admission checkpoint

The original installed `cli-args-parser@1.0.6` reproduces missing `Token`
and `OptionDefinition` exports when selected statically. Its declaration
bundle defines these types locally and publishes them through
`export { type Token, type OptionDefinition, ... }`. The type bridge now
admits these local export lists, including renamed types and whole-list
`export type` syntax. Exported classes, variables, functions, generic types,
external reexports and private local names remain outside this bridge.
Native fixture coverage checks that declared value signatures still cannot
replace JavaScript inference.

`npmStatic: auto` now discovers transitive imports, reexports and top-level
CommonJS requires from selected runtime packages, using the importing
package's resolution realm. The same fixed-point process already used by
library mode judges each package once. Explicit package lists retain their
named scope, ineligible packages retain fallback, and external host mappings
take precedence for every newly discovered package, including mappings of
one of its subpaths. Discovery/fallback helpers were extracted from the
compiler entrypoint, reducing its frozen source-size debt from 2,677 to
2,561 lines.

A third blocker was fallback attribution: an unrelated SDK type error
triggered SOLO probes that discarded the parser when its companion packages
were no longer selected. Before those conservative probes, the compiler now
checks whether removing one package lets the remaining graph typecheck
together. A fresh full preflight still validates the retained set. The
regression demonstrates an unrelated type-guard failure no longer discarding
a parent whose inferred types depend on its selected child.

The original RSP survey now keeps `cli-args-parser` static. Its SC2013 engine
diagnostics fall from 25 to one, for SDK. Reached statements increase from
1,374 to 1,665, with 259 failed statements and 199 diagnostics overall.
These totals include newly exposed failures and cascades, not independent
compiler bugs. The survey contains zero island statements but does not
establish a successful RSP build.

A separate disposable entry imports the original parser's `looksLikeValue`
and its exported types. Preflight now passes, but native compilation still
refuses `ParseError`'s `super(message)`, whose message is inferred as
`unknown`. No original-parser executable or performance result is claimed.
This and TOON's optional Error message are the next shared runtime boundary
to reproduce and implement with Node's exact conversion semantics. Native
binding lowering for bare cross-package reexports also remains incomplete;
the discovery test explicitly preserves the no-engine refusal for that path.

Validation: 60 focused plain tests, 43 sanitized tests (the two Rust cases
were already verified in the plain run), and 18 library/external-boundary
checks pass. Both native fixtures match Node in Rust, C and LLVM without
an engine, including stdout, stderr and exit status. Workspace build,
source-size and diff checks pass; focused ESLint reports zero errors and
35 warnings. The full repository gate was not rerun and remains pending.

Validation evidence is retained in `/tmp/scriptc-parser-types-before.log`,
`/tmp/scriptc-parser-auto-before.log`, `/tmp/scriptc-parser-fallback-before.log`,
`/tmp/scriptc-parser-final-plain.log`, `/tmp/scriptc-parser-boundaries.log`,
`/tmp/scriptc-parser-final-sanitized.log`, `/tmp/scriptc-parser-build.log`
and `/tmp/scriptc-parser-lint.log`. Consumer evidence is in
`/tmp/scriptc-parser-original-before.json`,
`/tmp/scriptc-parser-original-result.json`,
`/tmp/scriptc-rsp-parser-preflight-after.json` and
`/tmp/scriptc-rsp-after-parser-admission.json`.

## Next acceptance work

1. Repair the SDK export-surface fallback, the remaining engine-import
   diagnostic. Preserve honest fallback for unsupported declaration graphs.
2. Implement the native bigint/hrtime path used by invocation telemetry,
   preserving integer precision.
3. Address recursive JSON and generic flag-schema record coercions, Promise
   payload widening and typed ChildProcess values crossing unknown boundaries.
4. Fill the remaining Node API gaps, including appendFileSync options.
5. Compile the original entrypoint and run real CLI contracts for usage/errors,
   passthrough stdout/stderr/exit behavior, then resident/store operations in
   disposable test directories.

Full repository plain/sanitized gates remain a separate release requirement;
see [native-gate.md](./native-gate.md). RSP performance claims require its own
fixed-input benchmarks after command acceptance.
