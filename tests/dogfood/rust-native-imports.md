# Native Rust local module imports

A literal `import("./module.ts")` can evaluate a compiled local ESM module
without an embedded JavaScript engine. The target joins the compiled graph;
the import schedules evaluation after the current microtask checkpoint.
Each call returns a new Promise, while the module evaluation and namespace
are cached separately. Configured local aliases use the same resolver.

Namespace reads use traced getters over the original module globals. Mutable
primitive exports stay live; entity-name default exports retain their snapshot
semantics. Declared function exports share a cached native wrapper, including
its function properties, across aliases, named re-exports and runtime wildcard
re-exports. Keys follow the
Node 24 oracle: canonical array indexes first in numeric order, followed by
other export names in UTF-16 lexicographic order. Namespaces have null
prototypes and reject writes and extensions. Enumeration, JSON and
inspection read the exports rather than exposing the getter implementation.

Synchronous ESM evaluation records retain the original thrown value, including
failures shared through static dependencies and different importing modules.
Top-level await reuses the existing evaluation and cycle-root promises. The
runtime clears pending native module jobs during teardown. Unreached import
sites do not force an otherwise static executable to use the native loader.

## Behavioral witnesses

| Corpus | Contract |
| --- | --- |
| 3041 | Deferred evaluation, fresh import Promises, one namespace, live mutable exports, cached imports and cast aliases |
| 3042 | Aliases, default snapshots, readonly namespace, enumeration, JSON and inspection |
| 3043 | Shared failing dependency, exact Error identity, concurrent imports and retries, evaluation once |
| 3044 | Imported module with top-level await |
| 3045 | Top-level self-import remains pending and exits 13 |
| 3046 | Dynamically reached cycle uses the runtime evaluation root |
| 3047 | Nested microtask checkpoints, unit exports, destructuring and named static imports |
| 3048 | Multilevel wildcard re-exports, diamonds, explicit overrides, live aliases and renamed default snapshots |
| 3049 | Cyclic wildcard graph, function identity and cached namespaces |
| 3050 | Ambiguous wildcard names omitted; type-only declarations do not hide runtime bindings |

These programs select the Rust differential lane. C and direct LLVM explicitly
return SC3001 for this new native module IR; their existing embedded-engine
import route remains separate. Every new corpus entry uses `// @no-engine`,
enforced during compilation and checked against the successful execution
profile. API tests also prohibit the engine and execute an actual Rust binary,
verify local/promise/global aliases and `.then`, and pin
unsupported boundaries. Runtime tests cover queue order, completion adoption,
shared failure identity, reentrancy, teardown and namespace protection.

For the normal-exit corpus programs, the differential harness compares
stdout, stderr and exit status with Node. Corpus 3045 instead checks stdout,
exit 13 and absence of the Rust heap-audit marker; the existing nonzero-exit
lane does not establish byte-for-byte stderr equivalence.

## Remaining boundaries

This slice accepts primitive exports, primitive unions, native dynamic handles
and declared functions with supported argument/result representations. Open
`Record<string, unknown>` value exports now share their native map. Records
with declared fields or typed index values, arrays and other composite exports
require a native reference view
that preserves identity and shared mutation; the current copy conversion is
refused. Class and generic exports, broader function signatures, callable
`then` exports, CommonJS namespaces, computed module paths, callable
JSON/coercion hooks and import attributes still have explicit boundaries.
JSON imports retain their separate route.

Runtime `export *` follows the compiled ESM graph. Wildcards targeting
CommonJS, embedded modules or dependencies outside that graph remain explicit
SC1090 boundaries. The full namespace still refuses any export whose native
reference or function representation is unsupported, even if the application
only reads another export from that namespace.

Converting a native namespace into typed records or Promise payloads that
would copy its exports is also refused. Local aliases and casts retain the
handle. Static namespace objects used as first-class values alongside native
imports are refused because their existing record representation cannot share the
native namespace identity. Named static imports remain usable. Broader namespace
reflection and runtime loading of arbitrary modules are not established.
The scheduling witnesses do not prove complete Node ordering against filesystem
I/O and timers. Passing these witnesses does not establish compilation of the
full RSP, red-dev or redcode applications, complete C/LLVM parity, or a performance
advantage. Rustc normally continues to use LLVM internally.

The repository's full plain and sanitized gates remain pending/red; focused
checks are a development checkpoint, not release certification.

## Runtime wildcard resolution

The initial checkpoint `9b03640f` refused wildcard namespaces because the
checker's raw `Symbol.getExports()` table omitted their bindings. The
replacement resolves names over explicit runtime exports and runtime wildcard
edges. Explicit value exports win, wildcards exclude `default`, and repeated
paths to the same original binding agree. Names that resolve to different
bindings through competing stars are absent from the namespace. A visited
set per name prevents recursion through cycles without caching incomplete
cycle results as final answers.

The checker's `getExportsOfModule()` is not a runtime namespace table either:
it includes type-only wildcard values, lets type declarations hide runtime
star values, and chooses a symbol for ambiguous stars. The resolver therefore
uses runtime edges and ignores explicit type-only declarations when selecting
bindings. Corpus 3050 deliberately suppresses TS2308 on a conflicting star
declaration to test Node's valid namespace omission behavior; this does not
relax compiler diagnostics for ordinary named imports.

Named re-exports and imports that are re-exported locally also resolve through
runtime module/name pairs. Following the checker's final alias would otherwise
select the type-only source's value or drop a real export hidden by an
interface. Each reachable indirect export is validated independently: an
earlier star or explicit root export cannot hide a conflicting named binding
in a dependent module. Such invalid named re-exports receive SC1090, including
when the original TS diagnostic was suppressed.

Local aliases are followed one hop at a time, stopping at registered snapshot
storage. This preserves `export default value` through later named renames
and wildcards, while `export { value as default }` remains live.

## Initial checkpoint validation (9b03640f)

All seven native import corpus programs pass with the engine prohibited,
subject to the documented stderr limit for the exit-13 witness.
The focused API/IR/backend run passes all 38 tests in seven files, including
an actual Rust executable with the engine prohibited. The existing C/LLVM
import, top-level-await and JSON selection passes 28 plain tests and 12
sanitized tests. These are selected regression checks, not whole-corpus
parity. Rust sanitizers are not covered by the C/LLVM sanitized lane.

The Rust runtime passes 180 tests and all-target Clippy with warnings denied
on its pinned Rust 1.98.0 toolchain. Workspace build and lint pass; lint reports
zero errors and 3,114 warnings, including successful source-ceiling and
generated-file checks. All seven new preflight/order records for 3041–3047
match a fresh check; unrelated baseline disagreements are retained.

Reproduce the focused commands from the repository root, using the resource
limiter and a private persistent cache:

```bash
export SCRIPTC_LIMIT_CPU=100%
export SCRIPTC_CACHE_DIR=/home/cyber/.cache/scriptc-rust-native-gate
export CARGO_TARGET_DIR=/home/cyber/.cache/scriptc/cargo-target

pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  packages/compiler/test/native-import-*.test.ts \
  packages/compiler/src/backend/native-module-support.test.ts \
  packages/compiler/src/ir/validate-module-inits.test.ts --maxWorkers=1

pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/rust-differential.test.ts -t '304[1-7]-' --maxWorkers=1

pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/differential.test.ts tests/harness/llvm-differential.test.ts \
  -t '205[0-2]-|2606-|265[0279]-|266[0-3]-|2893-' --maxWorkers=1

SCRIPTC_SAN=1 pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/differential.test.ts tests/harness/llvm-differential.test.ts \
  -t '2050-|2652-|2660-|2661-|2663-|2893-dynamic-json' --maxWorkers=1

pnpm limit -- env -u LD_LIBRARY_PATH cargo +1.98.0 test \
  --manifest-path packages/runtime-rust/Cargo.toml
pnpm limit -- env -u LD_LIBRARY_PATH cargo +1.98.0 clippy \
  --manifest-path packages/runtime-rust/Cargo.toml --all-targets -- -D warnings
pnpm limit -- pnpm -r build
pnpm limit -- pnpm lint
```

The cache paths above identify this workstation; other hosts should use their
own private directories. Local evidence is retained in
`/tmp/scriptc-native-import-api-checkpoint.log`,
`/tmp/scriptc-native-import-corpus-checkpoint.log`,
`/tmp/scriptc-native-import-legacy-plain.log`,
`/tmp/scriptc-native-import-legacy-sanitized.log`,
`/tmp/scriptc-native-namespace-order-full.log` and
`/tmp/scriptc-native-namespace-order-clippy.log`. Build, lint and new baseline
checks are recorded in `/tmp/scriptc-native-import-build-checkpoint.log`,
`/tmp/scriptc-native-import-lint-checkpoint.log` and
`/tmp/scriptc-native-import-baselines-check.log`. The wildcard mismatch probe
is `/tmp/scriptc-native-import-star-probe.json`. These local artifacts are
not portable release proof.

## Wildcard checkpoint validation

The subsequent checkpoint is based on `9b03640f`. All 45 native import
API/IR/backend tests in seven files pass, including namespace admission,
an actual no-engine Rust binary, unchanged C/LLVM refusals and three invalid
named re-export graphs. The new 3048–3050 preflight/order records have no
diagnostics; all previous baseline entries are preserved.

All ten native import corpus programs pass with the engine prohibited. The
nine normal-exit witnesses compare stdout, stderr and exit status against
Node; the existing exit-13 stderr limitation for 3045 remains documented
above. Workspace build and lint pass with zero errors and 3,114 warnings;
source ceilings and generated-file checks also pass.

The API command above includes the expanded test files. The complete native
import corpus selection is now:

```bash
pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/rust-differential.test.ts \
  -t '304[1-9]-|3050-' --maxWorkers=1
```

This step changes frontend resolution and its tests; the Rust runtime source
is unchanged. The earlier Cargo and C/LLVM sanitizer results remain evidence
for their recorded checkpoint, not newly executed full gates. The Sandbox
image remains unconfigured and neither checkout has `.env.local`; no fresh
full local fallback was completed. Release readiness and original-consumer
acceptance therefore remain pending.

Evidence: `/tmp/scriptc-native-star-api-final.log`,
`/tmp/scriptc-native-star-corpus-final.log`,
`/tmp/scriptc-native-star-build-checkpoint.log`,
`/tmp/scriptc-native-star-lint-checkpoint.log`,
`/tmp/scriptc-native-star-baselines.log` and
`/tmp/scriptc-native-export-final-review.json`. The last file independently
confirms Node linking failures and native refusals for invalid named
re-exports hidden behind a previously visited star or explicit root export.
The [RSP survey](./rsp-native.md#runtime-star-re-export-resolution) records the
remaining callback boundary after the three telemetry star imports resolve.

## Native asynchronous function boundary

The follow-up to `c6e8e2d0` admits declared exported functions returning
`Promise<number>`, `Promise<string>`, `Promise<boolean>` and `Promise<void>`.
The argument admission and callback-signature checks remain in force; typed
record/array arguments and composite Promise payloads still refuse because
marshaling them would copy shared state. Existing dynamic handles retain their
own representation contract; this does not make arbitrary typed objects safe
to pass through `unknown` or `any`.

Corpus 3051 exposed an extra microtask in the old native handle bridge:
`ns.cached().then(callback)` ran after a separately queued Promise callback
and an `await Promise.resolve()`, whereas Node ran it before both. The new
Rust promise view forwards observations and polling to the original source;
it does not settle an intermediate promise first. Void payload conversion is
also a view. View mappers are internal representation conversions, not user
callbacks; they may run for each observation. Native dynamic reaction receivers and dynamic awaits use this
path. Promise resolution/adoption and embedded-engine bridges retain their
separate implementations.

Views retain source identity across typed comparisons, union comparisons and
re-boxing. Merely creating a view does not mark its source rejection handled.
Mapping failures reach observers as rejections; views trace their source and
release it when cleared. The runtime tests cover pending settlement, reaction
order, unhandled rejection identity, conversion errors and heap cleanup.

The normal-exit no-engine witness covers exported async functions, cached and
fresh Promise identity, function aliases, typed Promise parameters, dynamic
aliases and awaits, `.then`/`.catch`/`.finally`, primitive/void fulfillment and
Error rejection identity. Its stdout, stderr and exit status must match Node.
This is a limited native boundary, not complete JavaScript Promise conformance.

The 52 focused API/IR/backend checks include the eleven native import admission
programs and the three existing embedded-engine Promise bridge regressions.
All 52 pass together on the final source. The Error witness compares the
rejection with its original statically imported Error reference. The runtime
gate passes all 183 tests and all-target Clippy with
`-D warnings` on Rust 1.98.0. Workspace build and lint pass; lint reports zero
errors and the same 3,114 warnings. Only the new 3051 preflight/order baseline
was added, preserving every prior entry.

Evidence: `/tmp/scriptc-native-async-api-final.log`,
`/tmp/scriptc-native-async-runtime-final.log`,
`/tmp/scriptc-native-async-clippy-final.log`,
`/tmp/scriptc-native-async-build.log`, `/tmp/scriptc-native-async-lint.log` and
`/tmp/scriptc-native-async-baseline-final.log`. These are local checkpoint
artifacts. The full plain/sanitized gate and original-consumer acceptance
remain pending; no C/LLVM superiority or release readiness is established.

The differential selection validates thirteen programs: native imports
3041–3051 plus existing async-ordering (1021) and dynamic-rejection (2566)
regressions. Twelve passed in `/tmp/scriptc-native-async-corpus.log`; the new
3051 witness then passed in `/tmp/scriptc-native-async-corpus-final.log` after
the dynamic-await view correction. The twelve normal-exit programs match
Node stdout, stderr and exit status; 3045 retains the documented exit-13
stderr limitation. The final 3051 coverage reports `engine: none` and
`externalFfi: false`.

## Shared unknown-index record values

This historical checkpoint describes `2526d7b9`. The declared-field and
callback refusals in its table are superseded by the next checkpoint below.

The follow-up to `71e06834` removes copies when Rust boxes or validates an
open `Record<string, unknown>`: both sides already store the same
`JsMap<JsString, ScDyn>`. The conversion retains that map directly, including
its existing nested references. It no longer builds a deep copy or stores a
snapshot in the live-reference side table. Other record layouts keep their
existing boundaries and conversion behavior.

Native namespaces now admit globals of that exact record layout. Getters
retain the exported map, and reassigning an exported `let` publishes the new
map on subsequent reads. Named aliases share the binding; `export default
state` retains the original object reference, including mutations made before
or after the named binding changes.

| Export shape | Native admission |
| --- | --- |
| `let state: Record<string, unknown>` | Shared map value |
| `const state = { count: 0 }` | Still refused: declared-field storage |
| `const state: Record<string, number>` | Still refused: typed index storage |
| `const state: { count: number; [key: string]: unknown }` | Still refused: hybrid storage |
| `function update(state: Record<string, unknown>)` | Still refused: callers can supply other compatible layouts |
| A supported `unknown` callback argument/result | An already canonical record map retains identity |

This does not make arbitrary typed objects passed through `unknown` safe from
copying: the source must already use the canonical map. Native namespaces
also keep their existing typed-record conversion refusal; their live getters
need namespace-aware operations, not just shared data storage.

Corpus 3052 tests both conversion directions, insertion/deletion, nested map
identity and mutation, self references, an abandoned cycle with heap audit,
circular JSON rejection, shallow spread, independent `structuredClone`, and
JSON.parse aliases. Its native import witness tests static/dynamic identity,
namespace aliases, direct reads, exported rebinding, default object snapshots
and asynchronous mutation through an existing `unknown` callback contract.
The source runs unchanged under Node and the Rust binary with the engine
prohibited.

Validation covers 55 API/IR/backend tests in eight files and 23 differential
programs selected by `304[1-9]-|305[0-2]-|1575-|2676-|2691-|2692-|2849-|2850-`.
The shared numeric prefixes also include existing module/namespace cases.
All twelve native import witnesses prohibit the engine. The 21 normal-exit
programs compare stdout, stderr and exit status; 3045 and the existing
2676 top-level-await exit-1 witness retain the harness's nonzero-exit stderr
limitation. Heap audit is enabled, including the abandoned record cycle.
Only the new 3052 preflight/order baseline was added; all previous entries
are preserved.

Local evidence: `/tmp/scriptc-index-record-corpus-final.log`,
`/tmp/scriptc-index-record-api-final.log` and
`/tmp/scriptc-index-record-baseline.log`. The earlier failing identity witness
is `/tmp/scriptc-index-record-before.log`; the independent export admission
refusal is `/tmp/scriptc-index-record-export-before.log`.
The Rust runtime source is unchanged, so the prior 183 Cargo tests and Clippy
result remain historical evidence rather than a new runtime gate.

Workspace build and lint pass, including generated-file and source-ceiling
checks. Lint retains 3,114 warnings and zero errors. Logs are
`/tmp/scriptc-index-record-build.log` and `/tmp/scriptc-index-record-lint.log`.
These focused results do not replace the pending full plain/sanitized gate,
original-consumer acceptance or measured C/LLVM comparison.

## Shared declared-field record callbacks

Rust now chooses shared map storage for records that cross a typed/dynamic
boundary and have scalar declared fields, primitive optional unions, and
optionally an unknown-valued index signature. Each typed view retains the
same map; field reads and checked conversions validate its declared types.
Shapes used only in static paths keep their typed structs. The storage
plan clones Rust-local shape metadata and leaves shared IR shapes unchanged.

Native imports admit these record values and required record parameters,
synchronous record results and `Promise<Record>` results. Structurally
compatible scalar-field arguments can have a different shape and still share
the same object. The existing Promise views preserve settlement ordering.
Typed reads/writes, keyed access, JSON, shallow record clones, globals,
closures and async frames use the selected representation. The wrappers
trace their map through the existing collector; no unsafe runtime code or
new global reference cache is introduced.

Record-literal IR now marks synthetic missing optional fields with `absent`.
Shared literals retain source insertion order and omit those own keys while
preserving explicitly present `undefined` fields. Scalar-field JSON decoding
validates the shape and retains extra properties in the shared map. This does
not remove existing frontend reflection/spread restrictions for other layouts.

| Boundary | Current admission |
| --- | --- |
| Plain scalar-field record, including optional primitive fields | Shared typed/dynamic value, native export or callback parameter/result |
| Same fields plus `[key: string]: unknown` | Same shared behavior; dynamic extras retain existing references |
| `Record<string, unknown>` | Existing canonical map, now also admitted in native callback signatures |
| Structurally compatible scalar-field caller record | Shared original map; no parameter-shape copy |
| Typed nested record/array/class fields, typed index maps and tuples | Still outside this shared layout; native record marshaling refuses copying these arguments |
| Callback unions containing record arms, optional/rest parameters | Still refused by native import signature admission |
| Namespace conversion to a typed record | Still refused; namespace getters/prototype behavior require a separate implementation |

This slice does not make every object crossing `unknown` identity-preserving.
Other existing typed/dynamic composite conversions retain their documented
limits. Scalar unions here describe runtime primitive types; this work does
not add literal-value validation that the existing IR type erases.

Corpus 3053 compares boxing/unboxing, writes in both directions, container
references, absent versus explicit optional keys, JSON decoding, shallow
copies, independent structured clones and collectable cycles. Corpus 3054
compares static/dynamic exports, aliases and default snapshots, synchronous
and async record callbacks, mutation across await and differently shaped
compatible arguments. Both require the engine to be absent and run under
the Rust heap audit with Node output/error/exit parity.

The original failing witness is `/tmp/scriptc-declared-record-before.log`:
Rust printed `identity false false` and retained the old field value.
Original-consumer survey results and remaining telemetry barriers are in
[rsp-native.md](./rsp-native.md#shared-declared-field-record-callbacks).

Validation on the final implementation passes 64 API/IR/backend tests in
eight files and 44 Rust differential programs, including all fourteen native
import/record witnesses (3041–3054). The 42 normal-exit programs compare
stdout, stderr and exit status; 3045 and the existing 2676 top-level-await
exit-1 witness retain the harness's nonzero-exit stderr limitation. Twenty-two
selected C/LLVM checks pass with sanitizers, covering eleven existing
programs, including optional fields and async record literals. The runtime
source is unchanged; no fresh Cargo test/Clippy gate is claimed.

Workspace build and lint pass (zero errors, 3,114 existing warnings), including
generated files and source ceilings. Only the two new preflight/order
baselines were added. Logs: `/tmp/scriptc-shared-record-api-verified.log`,
`/tmp/scriptc-shared-record-corpus-final.log`,
`/tmp/scriptc-shared-record-sanitized.log`,
`/tmp/scriptc-shared-record-build-final.log`,
`/tmp/scriptc-shared-record-lint-final.log` and
`/tmp/scriptc-shared-record-baseline.log`.

These are focused local results. The Sandbox attempt stops before tests
because `SCRIPTC_SANDBOX_IMAGE` is absent
(`/tmp/scriptc-shared-record-sandbox.log`); a fresh full local fallback has
not completed. The full gate remains pending/red. No release certification,
complete consumer acceptance or performance superiority is established.
