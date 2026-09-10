# RSP native admission

The next consumer is the original
`red-skills/apps/rsp/src/cli.ts`, without source rewriting or a JavaScript
engine. Full RSP compilation and command acceptance are not achieved yet.
The consumer checkout inspected on 2026-09-07 is at
`c5255e006318fa3ec9aea51ccac11778da3888a1`.

## Blocker ownership

The [native TypeScript contract](../../NATIVE_TYPESCRIPT.md) governs new
admission work. The original-source target above describes this workload's
evidence; it does not forbid legitimate, documented consumer migrations or
commit scriptc to every transitive Node/Bun capability.

| Witness | Classification | Required next action |
| --- | --- | --- |
| `RspTelemetryEvent` in `apps/rsp/src/telemetry/schema.ts`, passed to `appendTelemetryEvent` | Compiler gap: the source already declares the collection, optional fields and unknown-valued index signature. The scalar-record boundary is implemented in the checkpoint below. | Retain identity/mutation/async regressions; complete the other telemetry exports and API gaps. Do not replace the signature with `unknown` to hide a compiler gap. |
| `appendFileSync` with `{ encoding: "utf8", mode: 0o600 }` in `telemetry/spool.ts` | Implemented in the native append-options slice below; the original call no longer reports its overload fence. | Retain creation-mode, Unicode, exclusive-create and evaluation-order regressions. Full compiler gates and telemetry workload acceptance remain pending. |
| SDK callback context lost when scriptc substitutes inferred JS types for ordinary declarations | Compiler gap, repaired in the recorded callback-context slice below. | Retain ordinary-preflight and implementation-divergence regressions; avoid requiring redundant callback annotations as a workaround. |

These examples do not classify all 212 diagnostics in the latest recorded
survey. Cascades and newly reached dependencies still require minimized
witnesses. No consumer correction is established merely by a refusal code.
If a dependency requires runtime JS evaluation, document that specific native
scope exclusion and adaptation before assigning it to the consumer; package
admission failure alone is not that evidence.

## Historical validation notes

**Sanitizer evidence correction:** the resource limiter did not forward
`SCRIPTC_SAN` to its transient systemd service before `7593476a`. Prefixing
`SCRIPTC_SAN=1 pnpm limit -- ...` therefore ran the ordinary lane on this
workstation. Earlier counts labelled sanitized below must not be counted as
sanitizer evidence unless independently verified. The SDK checkpoint records
replacement runs after the forwarding fix. The full repository gate remains
pending/red.

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

## Error message coercion checkpoint

Error construction and Error-subclass `super(message)` now accept optional
and unknown messages when their values have an existing native dynamic
conversion. `undefined` means an empty message; other values use JavaScript
ToString, including object hooks and conversion exceptions. Symbol messages
throw TypeError. Unsupported native carriers remain explicit refusals.
No runtime or engine dependency was added.

The inline `{ cause: expression }` path now evaluates the message expression
and then the cause expression before converting the message. A differential
regression reproduced the former ordering mismatch, including skipped cause
effects when message conversion threw. Three corpus programs pin coercion,
optional messages, single evaluation and argument/conversion ordering.

On original RSP revision `c5255e006318fa3ec9aea51ccac11778da3888a1`,
the same 1,665 statements are reached with 256 failures (previously 259)
and 194 diagnostics (previously 199). All five removed diagnostics are
Error message refusals: parser unknown, TOON optional string, and three
numeric-message specializations in shared flag parsing. The one SDK engine
import diagnostic remains; island statements remain zero. This is an
analysis result, not a successful RSP executable.

The original parser utility probe still passes preflight and now advances
past `ParseError`'s message conversion. Its six remaining deferred refusals
are subclasses whose `ParseError` base is not recognized as a registered
program class. The original consumer files were not modified.

Validation: 39 plain differential checks pass across Rust, C and LLVM;
10 C/LLVM checks pass with sanitizers. Workspace build, source-size and
diff checks pass. Focused ESLint reports zero errors and 94 warnings.
The three new preflight baselines were recorded individually with empty
diagnostics. The existing 20-entry order-canary chunk fails before reaching
them because `2963-island-async-callback/main.ts` has no recorded baseline;
unrelated baseline debt was not rewritten. The full repository gate was
not rerun and remains pending/red.

Evidence: `/tmp/scriptc-error-message-before.log`,
`/tmp/scriptc-error-order-before.log`,
`/tmp/scriptc-error-message-parity.log`,
`/tmp/scriptc-error-existing-parity.log`,
`/tmp/scriptc-error-message-sanitized.log`,
`/tmp/scriptc-error-order-canary.log`,
`/tmp/scriptc-error-message-build.log`,
`/tmp/scriptc-error-message-lint.log`,
`/tmp/scriptc-parser-after-error-coercion.json`, and
`/tmp/scriptc-rsp-after-error-coercion.json`.

## Bundled parser class inheritance checkpoint

The parser publishes its Error hierarchy as `var Base = class ...` followed
by `var Derived = class extends Base ...`. Class-value resolution admitted
const bindings only; changing just the declaration keyword reproduced the
refusal for both var and let. It now recognizes top-level class-expression
bindings with one initializer and no writes. The existing assignment scan
covers closures, destructuring and loop targets; initialized redeclarations
and references above the initializer remain excluded. General mutable
aliases to declared classes retain their previous boundary.

Exact class-binding resolution was extracted into `lower-class-bindings.ts`,
reducing the frozen size of `lower-classes.ts` from 5,656 to 5,621 lines.
The differential regression covers three Error inheritance levels, inherited
fields, `instanceof`, throwing/catching, and writes to each class's own
static storage. Reading a static field shadowed by a subclass still has an
explicit refusal; that separate limitation is pinned in an API test.

Two adapters importing the **original installed `cli-args-parser@1.0.6`**
now compile and execute as Rust-only native binaries: eight `looksLikeValue`
inputs and all seven exported Error classes. Both report `engine: none`,
`externalFfi: false` and no runtime fences. Stdout, stderr and exit status
match Node byte-for-byte, including Error messages, codes, details and
inheritance checks. No consumer or installed package source was rewritten.
This establishes these package contracts, not full argument parsing or RSP
command acceptance. No performance claim follows from this run.

Reproduce after `pnpm build`, supplying the original consumer checkout:

```bash
SCRIPTC_CACHE_DIR=/home/cyber/.cache/scriptc-rust-native-gate \
CARGO_TARGET_DIR=/home/cyber/.cache/scriptc/cargo-target \
pnpm limit -- env -u LD_LIBRARY_PATH node tests/dogfood/rsp-parser-native.mjs \
  /home/cyber/Work/reddb.io/red-skills
```

The runner retains both binaries, generated Rust, adapter sources and
`evidence.json` in the printed disposable directory. It asserts compilation
mode and byte parity, returning a nonzero exit on failure.

The final original-RSP survey reaches 1,689 statements (previously 1,665),
with 250 failures (previously 256), 194 diagnostics and zero island
statements. The six parser subclasses are now admitted. The one SDK
engine-import diagnostic remains. RSP itself still does not compile.

Validation: 47 plain checks pass: 33 differential executions across Rust,
C and LLVM, 12 class-binding API checks and two diagnostics snapshots.
The same 11 corpus programs pass both C/LLVM sanitized lanes (22 checks).
The 15 original-package scenarios pass in the reusable dogfood runner.
Workspace build, source-size, runner syntax and diff checks pass; focused
ESLint reports zero errors and 94 warnings. The new corpus entry's preflight
and evaluation order were checked directly and its baseline alone was added.
The full repository gate was not rerun and remains pending/red.

Evidence: `/tmp/scriptc-var-class-before.log`,
`/tmp/scriptc-var-class-boundaries-before.log`,
`/tmp/scriptc-var-class-final-plain.log`,
`/tmp/scriptc-var-class-final-sanitized.log`,
`/tmp/scriptc-var-class-final-build.log`,
`/tmp/scriptc-var-class-final-lint.log`,
`/tmp/scriptc-parser-native-final.log`, and
`/tmp/scriptc-rsp-after-class-bindings.json`. The final package evidence is
`/home/cyber/.cache/scriptc-test-tmp/scriptc-rsp-parser-native-FNg7gZ/evidence.json`.
These paths are retained workstation artifacts; the runner is the portable
reproduction entrypoint.

## SDK callback-context admission checkpoint

Forcing the original SDK into the RSP's static graph exposed 13 TypeScript
implicit-any diagnostics in consumer callback parameters. The shipped
declarations contextualize query/list results, while inference over the
SDK's JavaScript RPC/JSON boundaries returns any. The fallback loop treated
that loss of callback context as a reason to discard the entire package.

The frontend now retries this narrowly defined case. Every remaining
preflight diagnostic must be TS7006 or TS7031 at an unannotated parameter of
an arrow/function-expression callback passed directly to a call. The original
consumer must then pass a complete preflight against its ordinary declaration
surface. A fresh native load must still have only these callback diagnostics.
Only then may those callbacks proceed to native lowering. Both temporary
programs are disposed/restored through the normal load lifecycle.

No declaration value signatures or field types are copied into native IR.
The regression deliberately declares numeric rows while returning a string
in JavaScript; Rust, C and LLVM print the actual string exactly like Node.
Invalid original callback bodies, originally untyped callbacks, unrelated
TypeScript errors, non-callback implicit parameters, and inferred value
signature disagreements retain their errors/fallback. Changing a declaration
after a successful build revokes admission. Destructured callbacks can now
reach lowering, where records containing any still receive SC2009.

All five packages in the original RSP survey now report static admission,
including `@reddb-io/sdk@1.23.1`. SC2013 falls from one to zero; there are
zero island statements. Reached statements increase from 1,689 to 1,701,
failed statements from 250 to 252 as more code becomes visible, and total
diagnostics fall from 194 to 193. This is admission/analysis evidence, not
a successful RSP executable.

An isolated adapter importing the original SDK's `parseUri` passes preflight
but still fails native compilation with 23 SC3003 refusals. These expose
`globalThis.Bun`/`Deno` capability probes and URL/URLSearchParams values
crossing unknown/record boundaries. No SDK executable or database acceptance
is claimed, and no consumer/package files were rewritten.

Validation: 67 plain checks pass (13 callback-context, 30 npm/type-bridge
regressions and 24 fallback/library/external-boundary checks). Workspace
build, source-size and diff checks pass; focused ESLint reports zero errors
and 35 warnings. The compiler entrypoint's frozen source-size ceiling falls
from 2,561 to 2,547 lines by moving package-attribution helpers out.

After correcting sanitizer forwarding in `7593476a`, the callback suite
passes 12 checks with `SCRIPTC_SAN=1` actually present in the child process.
Its Rust case is excluded in this lane; C and LLVM compile with sanitizers.
The earlier file `/tmp/scriptc-sdk-context-sanitized.log` contains an ordinary
13-test run and is superseded by
`/tmp/scriptc-sdk-context-verified-sanitized.log`. One resource-limiter
regression and a live child-environment probe verify the forwarding fix.

The 23 corpus programs covering the Error-message and bundled-class steps
also pass both corrected C/LLVM lanes: 46 genuinely sanitized checks in
`/tmp/scriptc-recent-verified-sanitized.log`. Both suites explicitly identify
their sanitized mode. The C artifact for corpus 3031,
`node_modules/.cache/scriptc-tests/067decdec2aaf4bb/program`, contains
`__asan_init` and `__asan_report_load8`, verified with `nm`. These replacement
runs establish sanitizer coverage for those two checkpoints; older focused
checkpoints remain unaudited. They do not replace the full repository gate.

Evidence: `/tmp/scriptc-sdk-rsp-preflight-before.json`,
`/tmp/scriptc-sdk-context-before.log`,
`/tmp/scriptc-sdk-context-final.log`,
`/tmp/scriptc-sdk-npm-regressions.log`,
`/tmp/scriptc-sdk-boundaries.log`,
`/tmp/scriptc-rsp-after-sdk-admission.json`, and
`/tmp/scriptc-sdk-original-result.json`.

## SDK runtime-capability guards

The original SDK 1.23.1 evaluates `typeof globalThis.Bun !== 'undefined' &&
typeof globalThis.Bun.spawn === 'function'` and the analogous Deno guard at
module initialization. Native lowering previously deferred both statements.
The isolated Rust corpus reproduced empty stdout instead of the Node/Bun
oracle's detection results.

`lower-typeof.ts` now handles native capability queries according to the
selected target: Bun is absent for Node24/Node26 and an object for Bun;
Bun.spawn is a function on Bun; Deno is absent for all supported targets.
The same builtin query runs before generic dyn/union comparison lowering.
Boolean literal guards in value position now short-circuit before lowering
the unreachable operand, matching the existing condition-position rule.
Local declarations named globalThis retain normal lowering. Mutation,
unsupported calls such as Bun.spawn, and unguarded absent member reads retain
native refusals. Engine-enabled compilation does not use the new runtime
capability constants, because its globals can be mutable. Existing builtin
typeof handling was extracted without expanding the frozen source ceiling
(lower-exprs.ts: 11,232 to 11,188 lines).

Corpus 3032/3033 pins the SDK expressions, Node/Bun target differences,
short-circuit side effects, and a local globalThis parameter. Eleven API
checks cover all three target selections and the refusal boundaries.
The original SDK parseUri adapter, with the installed package symlinked and
no source rewriting, now has 21 refusals instead of 23: exactly the Bun/Deno
initializers disappeared. URL/URLSearchParams conversions and ParsedUri
records remain unsupported; no SDK utility binary is accepted yet.

The original RSP survey on the same consumer revision reaches 1,701
statements, with 250 failed (previously 252), zero island statements,
193 diagnostics (unchanged), and 99 runtime fences (previously 101).
All five npm packages still enter the static graph. This is removal of two
initialization barriers, not full RSP executable acceptance.

Validation: the eleven API checks and 26 selected differential checks pass.
The corpus selection covers 3032/3033, 2281/2282, 2712, 2795–2797 and both
2848 fixtures. Node-target programs run through C, LLVM and Rust; Bun-target
programs use the Rust harness. The same eight Node-target programs pass
16 C/LLVM checks with sanitizers, using the corrected SCRIPTC_SAN forwarding.
These focused passes do not replace the pending/red full repository gate.
The workspace build and source-size/diff checks pass; focused ESLint reports zero errors and 96 warnings.

Evidence: `/tmp/scriptc-capabilities-before.log`,
`/tmp/scriptc-capabilities-fixed.log`,
`/tmp/scriptc-capabilities-regressions.log`,
`/tmp/scriptc-capabilities-sanitized.log`,
`/tmp/scriptc-sdk-before-capability-result.json`,
`/tmp/scriptc-sdk-after-capability-result.json`, and
`/tmp/scriptc-rsp-after-capability-survey.json`.

## Next acceptance work

Apply the ownership classification above before expanding this workload.
Compiler priorities and efficiency work are ordered in the
[Rust roadmap](../../RUST_ROADMAP.md); the remaining RSP requirements below
are a workload inventory, not an instruction to implement all Node/Bun APIs.

1. Implement the SDK's native URL/URLSearchParams boundaries, retaining
   object identity, shared searchParams mutation and observable errors.
2. Extend the original parser contracts to tokenization and full flag parsing.
3. Implement the native bigint/hrtime path used by invocation telemetry,
   preserving integer precision.
4. Address recursive JSON and generic flag-schema record coercions, Promise
   payload widening and typed ChildProcess values crossing unknown boundaries.
5. Fill the remaining Node API gaps, including appendFileSync options.
6. Compile the original entrypoint and run real CLI contracts for usage/errors,
   passthrough stdout/stderr/exit behavior, then resident/store operations in
   disposable test directories.

Full repository plain/sanitized gates remain a separate release requirement;
see [native-gate.md](./native-gate.md). RSP performance claims require its own
fixed-input benchmarks after command acceptance.

## Native local import checkpoint

The final survey retains the original, clean RSP revision
`c5255e006318fa3ec9aea51ccac11778da3888a1` and uses `backend: rust`,
`target: bun`, `allowEngine: false`, and `npmStatic: auto`. Against the
capability-guard snapshot above, it reaches 1,932 statements (previously
1,701), with 247 failed (250), 198 diagnostics (193), and 100 runtime fences
(99). All five npm packages remain static. The compiler is the recorded
working snapshot based on `c6e8cb8c`, not an immutable released build.

The 43 generic SC2012 refusals for local `import()` become narrower native
boundary refusals: 21 function-signature boundaries, 10 composite-value
boundaries (records, arrays and a tuple), nine exports without a supported
identity-preserving representation, and three runtime `export *` namespaces.
Those three imports reach the original telemetry barrel. A separate native
probe demonstrated missing runtime star exports, so these imports now refuse
explicitly; type-only stars and named re-exports retain their tested behavior.
This does not mean 43 imports are accepted. Reaching more code also exposes
`@reddb-io/red-castle` outside native package admission. Counts describe
occurrences, not independent defects or successful binaries.

The final report records zero island statements. Before the star-export
refusal, it recorded four: telemetry namespace reads and calls at
`apps/rsp/src/cli/passthrough.ts:72,118` and
`apps/rsp/src/cli/invocation-telemetry.ts:86,87`. The trace found only native
`getProp`/`callFn`, `jsExit`, and `jsBridgePromise` operations; `stmtUsesIsland`
counts those nodes without considering the backend. That classification
discrepancy remains separate: the count now drops because the imports refuse,
not because the classifier was repaired. The survey still has no final
lowered module or execution profile and establishes no RSP binary acceptance.

Evidence: `/tmp/scriptc-rsp-after-native-import.json` and its `.mts`/`.log`
companions; `/tmp/scriptc-rsp-native-import-island-trace.json` records the
earlier source locations and IR constructs. Pre-guard evidence remains in
`/tmp/scriptc-rsp-before-export-star-guard.json`; the star-export reproduction
is `/tmp/scriptc-native-import-star-probe.json`. The initial working survey
is preserved as `/tmp/scriptc-rsp-after-native-import-initial.json`.

## Runtime star re-export resolution

The subsequent working snapshot, based on `9b03640f`, resolves the telemetry
barrel's runtime star exports. The survey was rerun on the final implementation,
including validation of indirect named re-exports, with the same options and
clean consumer revision as above. Its totals remain 1,932 reached statements,
247 failed, 198 diagnostics, 100 runtime fences, zero island statements, and
five static npm packages. The unreached totals also remain unchanged.

Exactly three diagnostics change: the runtime `export *` refusals become
native-signature refusals for `appendTelemetryEvent` at the same import sites.
The 43 native namespace boundaries now comprise 24 function-signature cases,
10 composite-value cases and nine unsupported export representations. These
imports request `appendTelemetryEvent` and string collection constants; the
function's `RspTelemetryEvent` argument is an indexed record with optional
fields, and its result is `Promise<void>`. Preserving values across that
native callback boundary remains necessary. The already-reported three-argument
`appendFileSync` call in `telemetry/spool.ts` is a separate implementation gap.

This is removal of the star-export resolution barrier, not acceptance of the
original telemetry imports or an RSP binary. The survey still has no final
lowered module or execution profile. Evidence is retained separately in
`/tmp/scriptc-rsp-after-export-star.json` and its `.mts`/`.log` companions;
`/tmp/scriptc-rsp-9b03640f-survey.json` preserves the prior checkpoint's survey,
and `/tmp/scriptc-rsp-after-export-star-intermediate.json` retains the survey
before the final indirect-re-export validation changes.

## Native Promise-returning exports

The next working snapshot, based on `c6e8e2d0`, admits the exported
`runRspMcpServer(): Promise<void>` call and advances the fast-git namespace
past `fastTelemetryRoot`. On the unchanged, clean consumer revision
`c5255e006318fa3ec9aea51ccac11778da3888a1`, the same Rust/Bun/no-engine survey
now reaches 2,109 statements (+177), with 257 failed statements (+10),
209 diagnostics (+11), 100 runtime fences and five static npm packages.
The newly visible diagnostics concern MCP record casts, store methods,
`existsSync` used as a value, and resident-store class/function boundaries.
The extra diagnostics reflect deeper traversal, not a completed executable.

There are still 43 native namespace boundary diagnostics. The three telemetry
imports still refuse `appendTelemetryEvent`: its indexed `RspTelemetryEvent`
argument needs a shared native record view even though `Promise<void>` results
now have a native bridge. The three-argument `appendFileSync` call remains an
independent gap. These are the next concrete telemetry requirements.

The report now counts two island statements. The classifier's existing generic
IR counting issue remains; this survey has no final module or execution
profile, so that count proves neither an engine dependency nor a successful
no-engine build. No consumer code was rewritten.

Evidence: `/tmp/scriptc-rsp-after-async-import.json` and its `.mts`/`.log`
companions, retained separately from the preceding export-star survey.

## Canonical record maps and native value exports

The working snapshot based on `71e06834` fixes Rust aliasing when an open
`Record<string, unknown>` crosses a typed/dynamic boundary and admits native
namespace value exports of that exact layout. The original RSP survey was
repeated on clean consumer revision `c5255e006318fa3ec9aea51ccac11778da3888a1`
with the same Rust/Bun/no-engine options. All 209 diagnostics are unchanged:
2,109 reached statements, 257 failed, two reported island statements,
100 runtime fences and five static npm packages. There is no final module,
execution profile or RSP executable.

The telemetry record is a different layout: `RspTelemetryEvent` combines a
required `collection`, optional declared fields and an unknown-valued index
signature. It still needs shared declared-field storage/validation and a
callback ABI that preserves compatible argument objects. Open-map export
support does not admit `appendTelemetryEvent` or justify rewriting its
signature. Its three-argument `appendFileSync` call remains a separate gap.

Evidence: `/tmp/scriptc-rsp-after-index-record.json` and its `.mts`/`.log`
companions. No consumer implementation was changed. The
[shared-record witness](./rust-native-imports.md#shared-unknown-index-record-values)
establishes native behavior for the admitted map layout, not full telemetry
acceptance or a performance comparison.

## Shared declared-field record callbacks

The working snapshot based on `f1c4abf9` gives scalar-field records shared
native storage when they cross typed/dynamic boundaries. It admits the
original `appendTelemetryEvent` signature without modifying the consumer's
types. The [record callback witness](./rust-native-imports.md#shared-declared-field-record-callbacks)
compares native execution with Node, including structurally compatible
arguments, shared mutation across await, exports and Promise results.

The fresh survey uses the same clean consumer revision
`c5255e006318fa3ec9aea51ccac11778da3888a1` and Rust/Bun/no-engine/npm-auto
options. Reached statements increase from 2,109 to 2,140; the report still
has 257 failed statements, 209 diagnostics, 100 runtime fences, two generic
island statements and five statically admitted npm packages.

Seven previous refusals are replaced by deeper boundaries at the same import
sites: three `appendTelemetryEvent` refusals become `drainTelemetrySpool`
signature refusals; three `DEFAULT_RSP_OVERHEAD_CEILING` record refusals become
`RSP_OVERHEAD_FAMILIES` tuple refusals; one `mergeRspBlock` signature refusal
becomes `provisionRspRepoStore`. Each namespace must admit its complete export
surface, so these are not seven accepted imports. No final module, execution
profile, telemetry command execution or complete RSP binary is established.
The `appendFileSync` options gap remains independent.

Evidence: `/tmp/scriptc-rsp-after-declared-record.json` and its `.mts`/`.log`
companions. The consumer checkout remains unchanged. This is compiler
admission progress, not a measured performance improvement or release gate.

## Native append options (2026-09-08, work in progress after `143bd19c`)

`appendFileSync(path, stringData, options)` now lowers UTF-8 literal options,
including numeric creation mode, append flag `"a"` and exclusive append `"ax"`.
The bare `"utf8"`/`"utf-8"` overload is also supported. Arguments and option
values run in source order before opening the file. Mode applies only when
creating the file, with the host umask; an existing file keeps its permissions.
Exclusive creation is one filesystem open operation. Rust uses safe
`OpenOptions`; C/LLVM reuse the existing checked write-mode syscall helper.

The frontend's write-options lowering and IR signatures now have dedicated
modules. Existing synchronous and Promise write behavior remains covered.
Other encodings, Buffer data with options, variable option records, other
flags and `flush` remain explicit compiler API gaps. These refusals do not
establish consumer noncompliance. Unknown option values with effects are
refused rather than silently omitted.

Focused evidence:

- Corpus `3055-fs-append-options.ts` prohibits an engine and compares Unicode,
  empty appends, exclusive EEXIST, invalid modes, missing paths, argument and
  option effects, and suppression of writes after an option throws with Node.
- Rust differential: 3055, 2687 and 2731 pass. Plain C/LLVM: 3055 and 2687 pass
  (four checks); sanitized C/LLVM: all three pass (six checks).
- Ten admission/refusal checks pass. The 184 runtime Rust tests and pinned
  Rust 1.98.0 all-target Clippy pass. A runtime test compares creation modes
  against a control opened under the current umask without mutating global
  process state, then checks that a later append retains mode 0600.
- Workspace build and lint pass; lint has zero errors and 3,114 warnings.

The fresh RSP survey uses the same clean consumer revision and the same
Rust/Bun/no-engine/npm-auto options as the record checkpoint. The exact
`appendFileSync with 3 arguments` fence in `telemetry/spool.ts` disappears.
Reached statements increase from 2,140 to 2,157. The report now has 260 failed
statements, 212 diagnostics, 101 runtime fences, two generic island statements
and the same five statically admitted npm packages. No execution profile or
complete RSP executable exists.

The newly reached compiler gaps are concrete: converting `encodeLines()` to
the declared `ToonlLineEmitter` object with function-valued members; spreading
`RspTelemetryEvent` with its declared fields and index signature; and deleting
an indexed field on that hybrid record. The `spoolEmitter` use-site refusal
is a cascade from the first gap. Preserve the consumer types and object
semantics when implementing these operations; the diagnostic hints are not
evidence that the source should be rewritten to hide the missing lowering.
The earlier barrel-level callback/tuple refusals also remain.

Evidence files are `/tmp/scriptc-append-{differential,sanitized,rust-final,
admission-final,cargo,clippy,build-final,lint}.log` and
`/tmp/scriptc-rsp-after-append-options.{json,mts,log}`. Full unfiltered plain
and sanitized validation is still pending. The running isolated gate covers
`143bd19c` plus its opt-in passed-binary cleanup, so it cannot certify this
new compiler/runtime change. Do not commit or ship this slice until the full
gates pass on its final source snapshot.

### Native factory boundary: scalar methods now supported

The compiler now accepts a minimized typed interface returned from a JS
factory when its methods use fixed scalar/unknown signatures. Rust retains
the original dynamic map, validates current methods and preserves the native
callable's identity through adapters; corpus 3065 pins alias mutation and
method replacement without an engine. See the factory section of
`native-gate.md` for differential evidence and the exact limits.

This does not yet clear ToonlLineEmitter: declareLane takes string[], while
push/pushTagged take indexed records. Those need shared parameter views;
allowing the existing composite-copy adapters would violate the consumer's
identity contract. The RspTelemetryEvent spread/delete blockers are unchanged.
Consumer types are already sufficient; these remain Scriptc implementation
tasks. The consumer checkout is still clean at
c5255e006318fa3ec9aea51ccac11778da3888a1; no unchanged RSP binary is certified.

### Native array parameters/results retain aliases

The current compiler slice adds shared native array views. Fixed factory methods
can now accept and return scalar/unknown arrays and nested arrays in that
domain. This supplies the array representation required by declareLane's
string[] parameter. Corpus 3066 proves argument/result identity and mutation
through both typed and dynamic callbacks; 3067 covers general dynamic array
round trips, nested views and cycles.

This still does not admit the complete ToonlLineEmitter shape: push and
pushTagged accept Record<string, boolean | number | null | string>, whose
parameter representation still copies. The next shared storage work belongs
to Scriptc's indexed records. No RSP source edit or full consumer success is
claimed from these focused witnesses.

The async extension is also compiler work: corpus 3068 now constructs dynamic
array literals across await without re-evaluating prior elements. Spread
snapshots precede later source mutation, and nested union-wrapped literals
retain dynamic element storage. Rejection follows the existing try/catch
continuations. These witnesses strengthen the native array representation;
they do not replace the outstanding indexed-record parameters or certify
execution of the original RSP entrypoint.

Fresh original-entry admission after this array slice remains incomplete:
`/tmp/scriptc-rsp-after-array-await.{log,json}` records 2157 statements,
260 failed statements, 212 diagnostics and 101 runtime fences, with no
preflight failure. These counts match the earlier survey; the full factory
shape still depends on indexed record parameters, so isolated array admission
must not be presented as full-entry progress. The five npm packages remain
classified static. The consumer is unchanged and clean at
c5255e006318fa3ec9aea51ccac11778da3888a1. This was analysis, not a binary build.

### Native scalar record parameters: full encoder signature admitted

Pure scalar/union dictionaries now retain their backing through native
checked views. This completes the representations used by declareLane,
end, push and pushTagged in the real ToonlLineEmitter signature. Corpus 3069
keeps that dictionary domain (boolean | number | null | string) and verifies
factory arguments/results, retained state, replacement, callbacks, deletion,
key order, JSON and identity without an engine. Its noUncheckedIndexedAccess
configuration pins optional read behavior without changing the parameter type.

Fresh original-entry analysis in `/tmp/scriptc-rsp-after-record-views.{log,json}`
confirms the SC1100 on encodeLines() and derived SC2004 on spoolEmitter are
gone. It reaches a new SC2020 at Object.entries in telemetry/spool.ts
(offsets 13316-13330). The existing hybrid record spread/delete refusals remain.
The survey records 2160 statements, 259 failed statements, 211 diagnostics,
101 runtime fences and no preflight failure. Five npm packages remain static.
The consumer remains clean at c5255e006318fa3ec9aea51ccac11778da3888a1.

This is admission progress on unchanged RSP source, not an RSP executable.
Next compiler work is the newly reached Object.entries and hybrid operations,
plus the remaining broader admission/gate failures. Consumer casts, cloned
rows or weaker parameter types are not required by this repair.

## Object union iteration checkpoint

The original, unchanged RSP entry at red-skills
`c5255e006318fa3ec9aea51ccac11778da3888a1` now clears Object.entries at
telemetry/spool.ts offsets 13316–13330. The compiler resolves the union from
`entry.event ?? {}` and enumerates the active shape without changing the
consumer's code or types. The same intrinsic type correction clears two
previous result-type fences in generic `parseFlags` instantiations.

Final source analysis (`/tmp/scriptc-rsp-after-object-iteration.json`, final
log `/tmp/scriptc-rsp-after-object-iteration-final.log`): 2166 statements,
258 failed statements, 216 diagnostics, 101 runtime fences, no preflight
failure, five static npm packages. This is not an executable. The diagnostic
count rises because the two newly admitted generic loops expose downstream
failures: dynamic keyed reads of `{}` at shared/args.ts offset 8127, reading
`type` from `ValueFlagSpec<unknown>` at 8262, and dependent uses of `raw`.
The exact delta removes three diagnostics and adds eight; it is saved in
`/tmp/scriptc-object-iteration-rsp-delta.json`. The interim generic regression
is repaired; generic router corpus 2847 passes Rust and sanitized C/LLVM.

Hybrid spread/delete in spool.ts still fence. These generic reads and hybrid
operations are compiler work; no consumer workaround was introduced. Native
corpora 3072/3073 and their limits are documented in
[native-gate.md](./native-gate.md#native-object-union-iteration).

## Generic optional field checkpoint

The unchanged original RSP now clears both `spec.type` reads at shared/args.ts
8262 in the `parseFlags` instances for byte-budget/ephemeral and full/since.
Those constraints omit the optional field in some concrete record variants;
the compiler now reads the active variant and preserves absence and identity.
No cast, clone, type weakening or consumer edit was introduced.

Analysis receipt: `/tmp/scriptc-rsp-after-generic-optional.json` and its log.
There are 2237 statements, 259 failed statements, 218 diagnostics and 100 runtime
fences; preflight passes and the same five npm packages remain static. This is
admission evidence, not an executable. The exact diagnostic delta removes the
two `type` reads and adds four subsequently reached `spec.coerce` call failures
at 8352 and 8406 (`/tmp/scriptc-generic-optional-rsp-delta.json`).

Next compiler work remains the narrowed generic callbacks and
`parsed.options[name]`, followed by the hybrid spread/delete sites. Standalone
probes of the original cli-args-parser's parse/createParser exports currently
hit the npm inferred-surface typecheck fallback before reproducing the RSP
keyed-read failure; `/tmp/scriptc-parser-result-{probe,explicit}.log` retain
that distinction. A package declaration already describes options as a
dictionary, so requiring a consumer workaround would not fix the compiler's
lost representation.

## Generic callback dispatch checkpoint

The unchanged original RSP clears all four `spec.coerce` call refusals at
shared/args.ts 8352 and 8406 in the byte-budget/ephemeral and full/since
`parseFlags` instances. The compiler reads the active concrete record's
closure before evaluating arguments and dispatches its original signature.
There is no record projection, callback replacement or consumer edit.

`/tmp/scriptc-rsp-after-generic-callback.json` records 2237 statements,
259 failed statements, 216 diagnostics and 100 runtime fences. Preflight
passes; the same five packages remain static. The exact delta in
`/tmp/scriptc-generic-callback-rsp-delta.json` removes the four SC1090 call
refusals and adds two SC2004 uses of `raw` at 8425. Those now-reached arguments
inherit the existing `parsed.options[name]` failure at 8127. This does not
mean the entire parseFlags function or the RSP executable compiles.

The next representation blocker is the original parser's dictionary result;
its declarations already describe indexed options. Schema width conversions
and the hybrid spool operations also remain compiler work. The native
callback witness, focused regressions and remaining admission limits are in
[native-gate.md](./native-gate.md#generic-record-callback-dispatch).

## Open JavaScript dictionary checkpoint

The inferred type of a JavaScript empty object literal now uses a shared
dynamic dictionary rather than a closed zero-field record. TypeScript empty
literals retain their existing closed-record admission. This repairs the
original parser's `result.options: {}` and `result.positional: {}` storage:
runtime keys written through aliases survive later reads. The Rust boundary
also admits fixed unknown-valued fields without copying their containing
record, with explicit C/LLVM refusals for the newly shared operations.

The final unchanged-RSP receipt is `/tmp/scriptc-rsp-after-js-open-record.json`
and `/tmp/scriptc-rsp-after-js-open-record-final.log`: 2259 statements,
236 failed statements, 210 diagnostics and 70 runtime fences. The previous
checkpoint had 2237/259/216/100 respectively. Preflight passes, and the same
five packages remain static. These numbers remain admission evidence;
there is no certified original RSP executable.

`/tmp/scriptc-js-open-record-rsp-delta.json` removes 13 diagnostics and adds
seven. All three former closed-object keyed-read refusals at shared/args.ts
8127 clear. The byte-budget/ephemeral and full/since instances also clear the
inherited raw-value failures. The json-only instance now encounters a
different, earlier blocker: `parser.parse` at 7038 returns checked dynamic
storage where its result contract still expects a record containing
`errors: number[]` and `rest: number[]`. Later parsed uses inherit this
failure. Those empty arrays are inferred from JavaScript implementation
residue, while the package declaration specifies string errors/rest; this
representation loss and the original parser's remaining operations are
compiler work, not a request for consumer casts or clones.

The original-package probes in `/tmp/scriptc-parser-result-generic*.log`
also establish that a generic/annotated importer can retain npm-static
admission; the earlier plain importer stopped at inferred-surface preflight
fallback. The intermediate post-mapping probe removes the previous internal
recordKeyGet shape-mismatch error from the plain parse case, but still has
other failures. It is not a complete parser execution test. Native witnesses
3076/3077 and their limits are recorded in
[native-gate.md](./native-gate.md#open-javascript-dictionaries-and-native-record-boundaries).


## JavaScript array-field checkpoint

The parser's inferred empty array fields now remain dynamic shared arrays,
including nested arrays, instead of becoming numeric arrays. Explicit TS
interfaces can view supported array/dictionary fields without copying their
storage; recognized JSDoc and TS element declarations retain their checks.
Explicit unknown-to-record casts also use the native shared admission rules.
These are compiler changes; the original consumer and installed parser remain
unchanged.

The final receipt `/tmp/scriptc-rsp-after-js-array-fields.json` uses the same
Rust/Bun/no-engine/npm-static-auto options: 2265 statements, 215 failed,
198 diagnostics and 59 runtime fences. The prior completed dictionary
checkpoint had 2259/236/210/70 respectively. Preflight passes and the same five
packages remain static. `/tmp/scriptc-js-array-fields-rsp-delta.json` records
16 removed and four newly exposed diagnostics.

The json-only parser call at shared/args.ts byte 7038 clears its former
unknown-to-result failure and its dependent parsed/raw uses. Two MCP request
casts at mcp-server.ts bytes 1018 and 9900 also clear. Newly reached failures
include `missingValue.replace` in all three parseFlags instances and the
json-only return width conversion at byte 8452: the latter still sees a
numeric positional array and an unknown-valued options dictionary. These
remaining representation/lowering failures belong in scriptc, not in consumer
casts, clones or weakened types. Original parser internals still have Set,
unknown-switch/key and spread limitations. No original RSP executable has
been certified; reduced admission failures are not execution proof.

Native witness 3078, reference-identity checks, regression receipts and current
support limits are documented in
[native-gate.md](./native-gate.md#javascript-array-fields-and-shared-container-records).


## Forwarded arrays and find-result checkpoint

The final unchanged-consumer receipt is `/tmp/scriptc-rsp-after-js-array-flow.json`
and `/tmp/scriptc-rsp-after-js-array-flow-final2.log`, with the same
Rust/Bun/no-engine/npm-static-auto options: 2265 statements, 213 failed,
192 diagnostics and 59 runtime fences. Preflight passes and the same five
packages remain static. The previous completed checkpoint had
2265/215/198/59 respectively. Earlier intermediate receipts are retained;
only this final receipt includes the TS nested-array and length fixes.

`/tmp/scriptc-js-array-flow-rsp-delta.json` removes six diagnostics and adds
none: the three `missingValue.replace` refusals at shared/args.ts byte 7323,
and three numeric positional-array return mismatches at byte 8452. The
compiler now preserves JS array origins through TS forwarding fields,
aliases and indexing, and does not store a real find result in an inferred
undefined-only slot. No consumer casts, clones or source changes were added.

Ten diagnostics remain in shared/args.ts. The two nontrivial parseFlags
instances still fail schema coercion at bytes 6962/7156 and have a parser.parse
refusal at 7038. extractFlags still has schema coercion/keyed-read or union
adaptation failures at 10760/11293. The original parser implementation also
retains its Set, switch-on-unknown, keyed-access and spread blockers. Clearing
the six targeted diagnostics therefore does not certify any complete RSP
execution.

The native failure reproduced before the repair, the three new corpus
programs and final-source regression evidence are recorded in
[native-gate.md](./native-gate.md#forwarded-js-arrays-and-native-search-results).


### Optional native record views and resident-server reachability

The optional-array/scalar-union record slice admits the previously refused
`runResidentServer` native import signature. The same clean consumer commit
`c5255e006318fa3ec9aea51ccac11778da3888a1` now reaches 3086 statements,
with 284 failed statements, 246 diagnostics and 81 runtime fences. Preflight
passes and the same five npm packages remain static. The receipt is
`/tmp/scriptc-rsp-after-optional-flag-final.json`; the diagnostic delta is
`/tmp/scriptc-optional-flag-rsp-delta.json`.

Compared with the preceding 2265/213/192/59 receipt, two diagnostics disappear:
the native import signature refusal and its dependent `runResidentServer`
use. The 56 added diagnostics are in newly reached resident-server code (45),
resident-core (5), telemetry/spool (4), elision-store (1) and the SDK KV
implementation (1). This is a larger analyzed graph, not a like-for-like
improvement or regression in diagnostic counts. The ten `shared/args.ts`
diagnostics remain unchanged; schema conversion is not fixed by this slice.

The minimized schema case confirms that callback return covariance alone
already works. The unresolved record-to-union conversion loses the literal
`"boolean"`/`"value"` discriminant and finds multiple structural candidates.
A correct fix must preserve that distinction and the schema's references;
it cannot select the first arm or copy objects to get through admission.
Consumer casts, clones and weakened annotations are not the remedy.

See [the native record evidence](./native-gate.md#optional-arrays-and-scalar-union-record-methods)
for the executable witnesses and the separate nested-callable import fence.
Original RSP execution and both complete repository lanes remain unaccepted.


### Acyclic nested record views

The nested-record slice clears the native import signature refusal for
`readGhConditionalJson`. On the same clean consumer commit
`c5255e006318fa3ec9aea51ccac11778da3888a1`, the receipt
`/tmp/scriptc-rsp-after-nested-record.json` reports 3327 statements, 295 failed,
257 diagnostics and 81 runtime fences. Preflight passes and the same five
npm packages remain static. Relative to the preceding 3086/284/246/81 result,
one diagnostic disappears and twelve appear in newly reached code:
gh-conditional (8), overhead-budget (2), cli/main (1) and gh-etag-cache (1).
The delta is `/tmp/scriptc-nested-record-rsp-delta.json`; the larger reachable
graph must not be mistaken for a comparable diagnostic-rate regression.

This is a representation prerequisite for schema conversion, not its completion.
Fixed acyclic records can retain nested record values and optional record
method arguments/results across checked native views. The literal-aware
multi-record union and indexed schema conversion remain to implement; no
consumer casts, clones or annotation changes are requested. Full original RSP
execution and the complete repository gates remain unaccepted.

### Discriminated flag schema views

On the unchanged consumer commit `c5255e006318fa3ec9aea51ccac11778da3888a1`,
`/tmp/scriptc-rsp-after-discriminated-schema.json` reports 3327 statements,
295 failed, 250 diagnostics and 81 runtime fences. Preflight passes; the same
five packages remain static. Relative to the nested-record checkpoint, the
graph is unchanged and seven diagnostics disappear with none added:
five fixed-schema conversion refusals and two parser.parse call refusals.
The exact delta is `/tmp/scriptc-discriminated-schema-rsp-delta.json`.

Compiler support now retains literal discriminator domains, shared flag-record
views and acyclic record-valued dictionaries. Native witnesses preserve schema
identity, flag identity, callback and discriminator mutation, entry replacement,
current own-key iteration and single evaluation. See
[the executable evidence](./native-gate.md#discriminated-records-and-shared-flag-schemas).

Three diagnostics remain in packages/shared/args.ts: a dynamic key into a
heterogeneous fixed schema, and two conversions involving aliases inferred as
`[string, string]`. Those require compiler support for heterogeneous indexed
reads and shared tuple-to-array views; they are not requests for consumer casts
or annotation weakening. Other compiler families, the original RSP executable
and complete repository gates remain outstanding.

### Heterogeneous keys and shared homogeneous tuples

The next compiler slice admits dynamic reads of heterogeneous fixed schemas
and dense homogeneous scalar tuples backed by shared array storage. Checked
views preserve identity, mutation, missing keys, runtime length and evaluation
order; spread/rest produce fresh arrays. Empty, sparse, heterogeneous and
composite tuples retain their existing fences.

Focused evidence: 14 Rust regression cases, four new differential cases
3090–3093 plus one native checked-view API test, 30 unit/API tests, and eight
sanitized C/LLVM comparisons passed. New TS7 baselines were verified. Receipts
are `/tmp/scriptc-tuple-schema-{rust-regression,native-final,unit,sanitized-final,baselines-verified}.log`.
The complete final-source plain/sanitized gates remain outstanding.

Original RSP analysis now reports 3327 statements, 293 failed, 247 diagnostics
and 81 runtime fences. The exact delta removes eight diagnostics and adds five:
all three args.ts diagnostics clear; five import sites advance past tuple exports
and expose unsupported callable/class exports. No consumer files were changed.

An isolated import of the original extractFlags compiles to a Rust binary with
engine none and zero diagnostics, but fails differential execution: `-f name`
produces an empty field and leaves name in rest. The regex runtime currently
maps absent captures to empty strings instead of undefined. This is a compiler/
runtime correctness defect, not a consumer compliance request. The original
probe and both outputs are retained in
`/tmp/scriptc-original-extract-native-20260908`. Neither this function nor the
complete RSP executable is certified. Checkpoint:
`/tmp/scriptc-native-tuple-schema-evidence-20260908`.

### Optional regex captures and typed capture boundaries

The native capture ABI now stores `string | undefined` for exec/match/matchAll
rows. Rust constructs the generated enum directly through a generic capture
constructor; C/LLVM receive the compiler's union layout. No empty-string sentinel
is used. Named groups retain absent values, and duplicate names select the first
participating capture even when it is empty. Inferred direct capture returns and
map-result storage keep the optional value; member receivers check absence once
and throw the matching TypeError. This does not certify all regex metadata,
groups-object identity/prototype behavior, or stateful exec surfaces.

JSON encoding admits undefined array positions and writes null in all three
backends, while the JSON decoder's validation domain remains unchanged.
Corpus 3094–3096 covers absent/empty captures, function and callback boundaries,
shared numeric slots, named groups, duplicate alternatives, exact errors and
receiver evaluation count. Validation passed: 20 Rust differential cases, two
IR unit tests, 199 runtime Rust tests, Clippy, workspace build and lint (zero
errors, 3120 warnings). Sanitized evidence covers four C comparisons in
`/tmp/scriptc-regex-captures-sanitized-second.log`, four LLVM comparisons in
`/tmp/scriptc-regex-captures-llvm-final.log`, and six further C/LLVM comparisons
in `/tmp/scriptc-regex-boundaries-sanitized.log`. The first log's LLVM failure
was fixed and rerun in the second log. Successful focused logs report no retry.
TS7 baselines for 2996 and 3094–3096 were added and verified.

The original extractFlags import now passes the initial native-vs-Node witness
without an engine: `/tmp/scriptc-original-extract-regex-fixed-20260908`.
The stronger twelve-case matrix reaches seven correct cases, then aborts on
an out-of-bounds argv read when a flag lacks its value. The callee declares
`string | undefined`, but the argument read still traps before the call.
Both outputs and the failure status are retained in
`/tmp/scriptc-original-extract-matrix-20260908`; the contextual type witness is
`/tmp/scriptc-optional-argument-context.log`. This remains a compiler defect.
The whole function, original RSP and complete plain/sanitized repository gates
remain unaccepted. Consumer files remain unchanged. Checkpoint:
`/tmp/scriptc-native-regex-evidence-20260908`.

### Contextual optional indexes and npm specialization

Optional/any/unknown destinations now receive a checked array read that retains
undefined for missing, negative and fractional indexes. Implicit JS specialization
keeps its native checked-dynamic parameter when the checker would otherwise bind
that read to a bare element type and erase absence; truthful optional checker
types still specialize. The type query does not lower the argument twice.

Corpus 3097 pins typed calls, unknown destinations, optional returns and evaluation
order. A TS caller of an npm JS function with an optional declaration reproduces
the original specialization bug in `tests/harness/npm-optional-index.test.ts`.
Seven focused plain comparisons passed, including that fixture on Rust/C/LLVM;
four sanitized C/LLVM comparisons passed. Build and lint completed without errors
(3120 existing lint warnings); the new TS7 baseline was added and verified.
Receipts: `/tmp/scriptc-optional-index-{plain,sanitized,build,lint,baseline-verified}.log`.

The unchanged original extractFlags import now byte-matches Node on all twelve
matrix cases, including missing values, empty values, aliases, negative numbers,
repetition and separators. Compilation reports 89 statements, no failed statements
or diagnostics, engine none; stdout, stderr and status match. The witness is
`/tmp/scriptc-original-extract-matrix-fixed-20260908`, with final receipt
`/tmp/scriptc-original-extract-matrix-optional-fixed.log`. This establishes the
exercised matrix, not whole-function or application certification.

Fresh full RSP analysis on the same clean consumer commit c5255e006318fa3ec9aea51ccac11778da3888a1
reports 3324 statements, 314 failed, 259 diagnostics and 82 runtime fences.
Compared with the tuple checkpoint, no diagnostics disappear and twelve appear:
five Number conversions of string|undefined, and seven dot reads on index-signature
records. The former follow the truthful optional capture/index representation;
the latter need investigation against the integrated upstream named-any record
change. These are compiler work, not requests for consumer casts or bracket rewrites.
Full repository plain/sanitized gates and original RSP binary remain unaccepted.
Checkpoint: `/tmp/scriptc-native-optional-index-evidence-20260908`.

### Primitive Number unions and narrowed index-record dots

Number now converts native primitive unions by their active tag: null becomes
zero, undefined becomes NaN, booleans become 0/1 and strings retain the exact
StringToNumber grammar. An interned helper receives the argument once; scalar
unit/void inputs retain source effects. Unsupported object coercions retain their
fences. The lowering was extracted from lower-calls.ts and its frozen ceiling
reduced. A premature property-read fence was removed: checker-index-records whose
values remain checked-dynamic after an unknown guard now reach the existing
native property path; static record fields still use fieldTarget.

Corpus 3098–3099 reproduced both failures before their fixes. Seven focused Rust
comparisons and four sanitized C/LLVM comparisons pass; build and lint pass
(0 errors, 3120 warnings); both new TS7 baselines were added and verified.
Receipts: `/tmp/scriptc-number-record-{green,sanitized,build,lint,baselines-verified}.log`.
The original twelve-case extractFlags matrix again matches stdout/stderr/status
with engine none: `/tmp/scriptc-original-extract-matrix-number-record-20260908`.

Fresh original RSP analysis reports 3327 statements, 294 failed, 247 diagnostics
and 82 runtime fences (`/tmp/scriptc-rsp-after-number-record.json`). All twelve
new diagnostics from the previous checkpoint disappear. Compared with the tuple
checkpoint the diagnostic set is identical, but one runtime fence remains new:
Number.parseInt in @reddb-io/toon's parseHeader, instantiated with an unknown
parameter. The optional-argument work must cover this boundary too. Full gates
and the complete RSP binary remain unaccepted; consumer files are unchanged.
Checkpoint: `/tmp/scriptc-native-number-record-evidence-20260908`.

### Shared native numeric parsers

Global parseInt/parseFloat and Number.parseInt/parseFloat now share primitive
ToString conversion before calling the native parser. Optional captures and
missing array indexes retain undefined; ToString supplies "undefined", which
parses as a finite integer in bases 32/36 instead of incorrectly returning NaN.
Source and radix evaluation order, missing values and thrown sources are pinned
by corpus 3100–3101. Arbitrary object coercion hooks retain existing fences.
The old optional-parseInt helper was removed and both oversized source ceilings
were reduced after extraction to lower-numeric-parser.ts.

Both new failures were reproduced first. Six Rust comparisons and six sanitized
C/LLVM comparisons pass, including the existing parser witnesses; the Rust pattern
also includes the unrelated same-prefix 1522-spawnsync-options case. Build and lint
pass (0 errors, 3122 warnings), and both new TS7 baselines are verified. Receipts:
`/tmp/scriptc-numeric-parser-{red,green,sanitized,build,lint,baselines-verified}.log`.

Fresh original RSP analysis reports 3327 statements, 293 failed, 247 diagnostics
and 81 runtime fences (`/tmp/scriptc-rsp-after-numeric-parser.json`). Both diagnostic
and runtime-fence sets exactly equal the earlier tuple checkpoint. The additional
TOON Number.parseInt fence has cleared without reverting truthful optional values.
This closes the newly introduced analysis regressions, not all repository
regressions or application execution. Full final-source gates and the complete
RSP binary remain unaccepted. Consumer files are unchanged.
Checkpoint: `/tmp/scriptc-native-numeric-parser-evidence-20260908`.

### Native value properties after implicit JS specialization

A minimized npm fixture reproduced the original TOON splitLines failure. A
focused probe confirmed that its lines local was already native string[] while
the checker still called it any. The final property fallback now reads array
and string length from the supplied native value; the existing concrete-record
field/overflow fallback was extracted alongside it. Custom record properties
keep their own layout and the receiver is not re-lowered by the helper. The
lower-exprs.ts frozen ceiling was reduced after extraction. Debug probes were
removed.

The npm fixture also pins mutation of the trailing empty line, CRLF handling,
string-result lengths in indentation calculations and native array results.
Nine focused plain tests and four sanitized C/LLVM comparisons pass, including
regex groups after the record-fallback extraction. Build and lint pass (0 errors,
3122 warnings). Receipts:
`/tmp/scriptc-native-value-property-{plain,sanitized,build,lint}.log`.

The original @reddb-io/toon 0.3.0 decode import was tested without copying or
editing the consumer package. Its no-engine refusal shrank from 14 deferred
functionalities to 12: splitLines and collectLines length failures cleared.
It still does not produce a binary. Remaining groups include unknown switches,
comparisons, dynamic array spread, Set operations, Object.defineProperty and
Number over unknown. Original probes:
`/tmp/scriptc-original-toon-decode-20260908` and
`/tmp/scriptc-original-toon-decode-length-20260908`.

Fresh original RSP analysis reports 3328 statements, 291 failed, 247 diagnostics
and 79 runtime fences (`/tmp/scriptc-rsp-after-native-property.json`). The
247-diagnostic set is unchanged and exactly two runtime fences disappear, with
none added. Final-source extractFlags still matches Node on all twelve cases,
stdout/stderr/status included, engine none:
`/tmp/scriptc-original-extract-matrix-native-property-20260908`.
This is focused evidence, not a green complete repository gate or certification
of the entire RSP application. Consumer files remain unchanged.
Checkpoint: `/tmp/scriptc-native-value-property-evidence-20260908`.

### Native dynamic switches, absent tests and suspending selection

Checked-dynamic discriminants now use native strict equality and the existing
switch body dispatch. The discriminant is evaluated once into a hidden local
that does not rebind the source variable. Case tests remain lazy and preserve
primitive tags, NaN, signed zero, undefined, and supported reference identity.
Missing indices of typed TS arrays in case expressions use the same absence
probe as strict equality; corpus 3102 reproduced a truncated execution before
this correction.

When a case expression contains await, lowering selects a numeric starting
clause through lazy conditionals before entering the switch bodies. The Rust
async expression emitter now sequences dynScalarEq operands across suspension.
This preserves a default before later cases, no default, fallthrough, mutation
of the original discriminant and rejection through try/catch/finally. Corpora
3102-3104 pin these behaviors against Node without an embedded engine. This
step does not certify arbitrary suspension inside switch bodies or every
labelled async loop combination; the separate island-handle temporary path
also remains outside this fix.

Final focused validation: eleven Rust differential cases plus the reviewed
json-dyn diagnostics snapshot pass; all six C/LLVM sanitized comparisons for
3102-3104 pass. Build, lint (0 errors, 3122 existing warnings), and TS7 preflight/
module-order baselines pass. The frozen lower-stmts.ts ceiling decreased.
Receipts: `/tmp/scriptc-dynamic-switch-rust-final-verified.log`,
`/tmp/scriptc-dynamic-switch-sanitized-final.log`,
`/tmp/scriptc-dynamic-switch-build-verified.log`,
`/tmp/scriptc-dynamic-switch-lint-verified.log`, and
`/tmp/scriptc-dynamic-switch-baselines-final-verified.log`.

Fresh full RSP analysis reports 3379 statements, 290 failed statements,
247 diagnostics and 78 runtime fences. The diagnostic set is unchanged. Five
switch fences disappear; four later fences become visible (two parseInt
instantiations, one comparison, and one Number conversion). The previous
checkpoint had 3328 statements, 291 failed and 79 runtime fences. Island
statements remain 4. These totals measure analysis coverage, not application
readiness or independent feature counts. Receipt:
`/tmp/scriptc-rsp-after-dynamic-switch.json`.

The untouched original TOON decode import now has 11 runtime fences instead
of 12: three switch refusals clear and two later parseInt refusals surface.
The no-engine build still refuses compilation honestly. Remaining groups are
numeric conversion/comparison over dynamic values, dynamic array spread,
Set<any>, and Object.defineProperty. Probe:
`/tmp/scriptc-original-toon-decode-switch-final-20260908`.
The consumer checkout is unchanged. Full plain/sanitized repository acceptance
and the complete RSP native binary remain unaccepted; no release was made.
Checkpoint: `/tmp/scriptc-native-dynamic-switch-evidence-20260908`.

### Native dynamic numeric conversion and async evaluation boundaries

Number, Number.parseInt/parseFloat and the global parsers now handle native
checked-dynamic values. Number runs valueOf before toString; parsers use the
string hint, then coerce the radix. The parser helper evaluates all arguments
before either conversion and materializes explicit absent/void radix values.
The C number-conversion protocol has a value-returning ABI shared by C/LLVM;
Rust now implements the corresponding object-hook protocol. Coercion signatures
and backend dispatch were extracted, reducing frozen file ceilings.

Corpora 3105-3107 compare primitive tags, numeric grammars, radix conversion,
negative zero, missing array indices, user hooks, receiver mutation, fallback,
throws and await against Node. A reproduced array defect ignored the elements'
toString hooks; the native string-hint path now invokes them, captures join's
initial length, protects an element across mutation and handles array recursion.
Shorthand object methods using this retain the existing frontend SC1090 fence;
this step tests receiver binding through the already-supported plain-function
form, without changing consumers. The original refusal probe is preserved as
`/tmp/scriptc-numeric-object-method-this-refusal.js`.

The await witness exposed deferred expression emission: conversion effects ran
after later arguments and throws escaped the intended catch. Rust continuation
consumers now receive evaluated values. Resumed protected expressions catch
only their own evaluation, then invoke their continuation outside that catcher.
This also handles a later synchronous argument throwing after an earlier await.
A separate witness caught and fixed an overly broad intermediate catcher that
incorrectly intercepted an error after the source try block had ended.

The former dynamic-surface diagnostic now compiles and moved to corpus 3108
with observable output. The coverage fixture now counts six of nine statements
as static and two dynamic-only sites; only the removed parseFloat refusal and
its totals changed. Final focused validation: 24 Rust corpus cases and two
coverage snapshots pass, including existing async loops, ordering, exceptions,
array/tuple awaits and primitive-union parsers. Twelve distinct sanitized
C/LLVM comparisons pass across six fixtures; the final expanded 3107 witness
was rechecked on both backends. Build, lint (0 errors, 3122 warnings), and all
four TS7 baselines pass. Receipts:
`/tmp/scriptc-dynamic-numeric-complete-verified.log`,
`/tmp/scriptc-dynamic-numeric-sanitized{,-await,-boundary}.log`,
`/tmp/scriptc-dynamic-numeric-{build,lint}-complete.log`, and
`/tmp/scriptc-dynamic-numeric-baselines-complete.log`.

The original cli-args-parser 1.0.6 coerceToType import compiles with engine none:
67 statements, no failed statements or diagnostics, all 32 scenarios matching
Node stdout/stderr/status. The final-source binary and receipts are retained in
`/tmp/scriptc-original-cli-coercion-final-20260908`. This is a real dependency
component, not certification of the entire parser package or RSP application.

Final original RSP analysis reports 3379 statements, 285 failed, 247 diagnostics
and 71 runtime fences (`/tmp/scriptc-rsp-after-dynamic-numeric-final.json`). The
diagnostic set is unchanged; seven numeric fences disappear and none are added.
The previous checkpoint had 290 failed statements and 78 runtime fences. Island
statements remain 4. Original TOON decode drops from 11 to 8 runtime fences and
still refuses its no-engine build; remaining groups are dynamic comparisons,
array spread, Set<any> and Object.defineProperty. Consumer files are unchanged.
Full plain/sanitized repository acceptance and the complete RSP binary remain
unaccepted. Checkpoint:
`/tmp/scriptc-native-dynamic-numeric-evidence-20260908`.

### Native relational comparisons and Unicode trust probe (2026-09-08)

The native `dyn.compare` IR call now evaluates both operands before running
number-hint OrdinaryToPrimitive, left then right. Primitive strings compare
as UTF-16; other primitive pairs compare numerically, with NaN unordered for
all four operators. Rust and C/LLVM share these semantics, including hooks,
receiver binding, exceptions, cyclic arrays and optional indexed reads.
Number conversion reuses the primitive protocol without discarding strings
prematurely. The effect seed names live in a pure module to avoid an IR import
cycle; the expression-lowering extraction reduces its frozen line ceiling.

The typed string path also used byte ordering. A red differential witness
reproduced reversed astral/BMP ordering; the frontend now selects the existing
UTF-16 comparison on all backends. Corpora 3109-3112 cover a 324-pair matrix,
conversion/evaluation order, both throwing operands, receiver binding, awaits,
catch boundaries, typed Unicode strings and absent numeric/string indices.
17 Rust differential cases pass; 16 sanitized C/LLVM comparisons pass across
3105-3112. Build, lint (0 errors, 3121 warnings), and four TS7 baselines pass.
Receipts: `/tmp/scriptc-dynamic-relational-complete.log`,
`/tmp/scriptc-dynamic-relational-sanitized.log`,
`/tmp/scriptc-static-relational-sanitized.log`, and
`/tmp/scriptc-dynamic-relational-{build,lint,baselines}-final.log`.

Original RSP analysis now counts 3382 statements, 284 failed, 247 unchanged
diagnostics and 69 runtime fences. Three comparison fences disappeared; one
previously unreachable refusal surfaced at `character.charCodeAt(0).toString`
in TOON quoteString. This is a net reduction of two fences, not elimination
of all downstream blockers. Original TOON decode has 496 statements, six
failed and six diagnostics/fences (previously eight): dynamic array spread,
Set construction/has/add and Object.defineProperty remain.

A direct import of original TOON parseQuotedString, via a temporary relative
symlink without modifying its source, compiles with engine none: 53 statements,
no diagnostics. **It is not a trusted component binary:** 22 of 23 scenarios
match Node, but an astral character becomes two replacement characters.
The retained native binary and byte comparison are under
`/tmp/scriptc-original-toon-quoted-relational-20260908`.
`tests/dogfood/native-string-surrogate-roundtrip.ts` minimizes the same defect:
indexed append reconstructs `😀` as `��`. This is a known failing trust probe,
not an accepted corpus case. The existing Rust JsString = Rc<str> and lossy
UTF-16-half reads cannot preserve isolated surrogates. That runtime source
was unchanged in this step. Preserving UTF-16 code units through indexing,
slicing, concatenation and host boundaries is the next correctness priority;
consumer rewrites are not an acceptance strategy.

Consumer HEAD remains c5255e006318fa3ec9aea51ccac11778da3888a1, with a clean
working tree. Full repository plain/sanitized gates and the complete RSP
binary remain unaccepted. Checkpoint:
`/tmp/scriptc-native-dynamic-relational-evidence-20260908`.
