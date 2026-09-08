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
| `appendFileSync` with `{ encoding: "utf8", mode: 0o600 }` in `telemetry/spool.ts` | Compiler API gap selected for the telemetry workload; the currently admitted two-argument form does not implement these options. | Implement creation permissions and encoding semantics with differential tests, including umask and existing-file behavior. Do not discard `mode` to obtain admission. |
| SDK callback context lost when scriptc substitutes inferred JS types for ordinary declarations | Compiler gap, repaired in the recorded callback-context slice below. | Retain ordinary-preflight and implementation-divergence regressions; avoid requiring redundant callback annotations as a workaround. |

These examples do not classify all 209 diagnostics in the latest recorded
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
