# Rust is the primary backend

The fork prioritizes well-typed TypeScript compiled through typed IR to
memory-safe Rust and an efficient native executable. The
[native TypeScript contract](./NATIVE_TYPESCRIPT.md) separates consumer
requirements, compiler gaps and excluded capabilities. Existing JavaScript
and npm implementation sources remain supported where statically admitted;
arbitrary Node/Bun application compatibility is not an unlimited obligation.
Rust is the default for builds and backend-validated coverage.
C and direct LLVM emission are explicit compatibility, debugging and comparison
backends. Library profiles continue to name their emission backend explicitly.
Unsupported Rust features or targets report diagnostics; they never select a
C/LLVM fallback. Cross builds currently require an explicit compatible backend.

Rustc normally uses LLVM internally. The comparison here is between scriptc's
Rust path and its direct LLVM emitter, not a claim to replace LLVM's optimizer.
Changing the default does not establish superior correctness or performance.

The latest [flag schema slice](./tests/dogfood/native-gate.md#discriminated-records-and-shared-flag-schemas)
adds live discriminated record views, acyclic record-valued dictionaries and
shared structural projections with runtime own-key iteration. Fifteen Rust
corpus cases, 34 focused checks and eight sanitized C/LLVM comparisons pass.
On the unchanged RSP graph, diagnostics fall from 257 to 250; three args.ts
refusals remain around heterogeneous keyed reads and tuple-valued aliases.
Full original-program execution and both complete gates remain outstanding.

## Implementation priorities

1. Correct native type and value boundaries. Extend the
   [native local import slice](./tests/dogfood/rust-native-imports.md).
   Lazy evaluation, cached failures and live primitive exports now have native
   witnesses, including runtime wildcard graphs, diamonds and cycles. Exported
   functions can also return primitive/void Promises through native views that
   retain identity and reaction ordering. Open unknown-valued record exports
   share the native dynamic map, including nested map aliases and mutation.
   Scalar declared-field records now share storage at typed/dynamic boundaries
   and in native callback arguments/results, including primitive optional
   fields and unknown-valued extras. Static-only shapes retain typed structs.
   Scalar/unknown arrays, including nested arrays in that domain, now retain
   backing identity and shared mutation across native dynamic boundaries.
   Fixed factory methods accept these array parameters/results. The next
   boundaries are nested typed fields, composite index values, classes,
   richer function signatures and shared static namespace objects. Pure
   scalar/union dictionaries now share storage across native boundaries.
   RSP's telemetry record/callback signature now passes its prior boundary;
   other exports in the same barrel still refuse admission. Extend optional
   callback signatures and composite references without consumer signature
   rewrites. Native UTF-8 append options now pass focused differential tests;
   the original RSP overload fence is gone. The newly reached telemetry gaps
   are function-valued encoder records, hybrid-record spread and indexed
   deletion (see the [RSP evidence](./tests/dogfood/rsp-native.md#native-append-options-2026-09-08-work-in-progress-after-143bd19c)).
   Complete checked URL/SearchParams references,
   recursive records/JSON and Promise payload conversion. Preserve identity,
   shared mutation and observable errors; do not use an engine to erase gaps.
2. Runtime and compiler efficiency alongside semantic work. Profile
   allocations, reference-count work, cycle collection, copying, async
   scheduling and generated code. Add a Rust
   whole-program cache with complete rustc/Cargo/source identities before
   claiming startup-cache parity with C/LLVM. Measure already accepted
   workloads; optimization need not wait for full application compatibility.
3. Actionable admission diagnostics. Apply the contract's blocker categories
   to minimized failures before assigning ownership. The CLI does not yet
   expose those categories; existing SC codes alone cannot determine them.
   Consumer guidance must name a documented rule and concrete adaptation;
   compiler gaps must not be presented as type errors in valid consumer code.
4. Bounded consumer acceptance. Use RSP commands and resident/store contracts,
   then Brain, red-dev and redcode as named workloads. Classify and document
   required consumer migrations before expanding API/dependency scope. After
   migration, compare the same implementation and inputs across runtimes.
   Adapters may drive entrypoints, but must not hide compiler defects by
   replacing application logic. Full applications remain separate milestones
   from accepted entrypoints; no blanket Node/Bun emulation is promised.

New native features may land first in Rust. Shared frontend/IR changes retain
regression coverage in the explicit C/LLVM lanes. Those backends must refuse
Rust-only IR honestly; they need not acquire every new Rust implementation.

## Quality acceptance

| Dimension | Required evidence |
| --- | --- |
| Semantic correctness | Original-source differential tests against the selected Node/Bun target; stdout, stderr, exit status and relevant artifacts match. Identity, aliasing, exceptions and async ordering have behavioral witnesses. |
| Native execution | Actual executable with engine none, no deferred runtime fences, and recorded compiler/consumer/generated-source/binary identities. Coverage alone is insufficient. |
| Memory safety | Generated Rust and maintained runtime forbid unsafe code. Cargo tests and Clippy pass on the pinned toolchain; allocation/cycle stress tests cover retention and cleanup. Transitive native dependency safety remains a separately stated boundary. |
| Diagnostics | Unsupported features identify source locations and fail deterministically. Blocker reports distinguish documented consumer obligations, compiler gaps and excluded capabilities with evidence. Backend emission runs in default coverage; no silent backend or engine fallback. |
| Compatibility | Named consumer workloads meet the native contract and pass their complete relevant suites. Record any consumer migration separately; comparisons use the same implementation. Compare identical corpus programs against direct LLVM, recording both refusals and accepted behavior; do not infer capability from diagnostic counts alone. |
| Performance | Fixed-input release builds, identical outputs, repeated runs, recorded toolchains and equivalent resource limits. Compare CPU time, peak RSS, elapsed time, executable size and build time against direct LLVM and relevant Node/Bun baselines. |
| Release readiness | Workspace build, both repository gate lanes, Rust runtime checks and the claimed consumer milestones pass on the same checkpoint. Known failures and unaccepted workloads remain visible. |

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
The current uncommitted slice also adds native indexed `ReadableStream.from`,
with Promise ordering and shared array/bytes chunks; its focused evidence and
remaining limits are in the [gate record](./tests/dogfood/native-gate.md#native-readablestreamfrom-and-array-views).

Native typed factory results now support shared records with fixed scalar/unknown
methods and shared array arguments/results, including callable identity through
adapters. Pure scalar/union indexed record method parameters now use shared
map views; the full ToonlLineEmitter signature passes its former RSP boundary.
Object.entries over the optional event union now compiles; generic
flag callback calls now dispatch their concrete closures while preserving
argument order. Inferred JS empty dictionaries now retain indexed writes
and aliases, including shared unknown-valued fields across native record
boundaries. Inferred JS empty-array fields now use dynamic shared arrays,
while declared TS/JSDoc element types retain their checks. Shared record
fields support native array/dictionary views, including explicit checked
casts. JS array origins now survive TS forwarding fields, aliases, nested
indexing and length reads; search/removal results and unannotated callbacks
retain dynamic values instead of numeric or undefined-only inference residue.
Shared records also retain optional array fields and scalar-union callback
arguments/results. Native import parameters can now preserve optional arrays;
nested callable parameters still have a separate import admission fence.
Acyclic nested records and optional record method arguments/results now also
retain shared storage through checked views. Recursive layouts, record arrays
and multi-record unions remain outside this shared view contract.
Unit comparisons and bare `typeof` now inspect stored unions even when the
checker retains a stale narrowing across a mutating call.
The targeted parseFlags string/result diagnostics clear. Flag-schema
coercions and the original parser's Set/switch/spread operations still block
RSP execution. Optional fields across concrete generic record variants now
preserve undefined, reference identity and receiver evaluation. The intrinsic
keeps concrete generic value types and evaluates its receiver once. Dynamic array literals also
retain evaluation order through await, spread and rejection, including inside
try/catch; corpus 3068 pins this behavior against Node without an engine.
The [factory evidence](./tests/dogfood/native-gate.md#native-typed-factory-methods-and-function-identity)
records tested behavior and remaining limits. C/LLVM explicitly refuse these
new shared callable exits instead of emitting their field-copy representation.

Making Rust primary is an implementation and product direction, not a release
certification or a claim that the full applications already compile.

Heterogeneous fixed-schema key reads and dense homogeneous scalar tuple views
now pass focused native tests, clearing the three remaining args.ts diagnostics.
The original extractFlags emits an engine-free Rust binary, but differential
execution exposes incorrect absent regex captures. Correcting that runtime
behavior is required before accepting the function; full application and
repository gates remain outstanding. See the latest dogfood gate record.

Optional regex capture semantics now pass differential tests across Rust, C
and LLVM. The original extractFlags happy-path witness matches Node without an
engine. Its expanded matrix exposes an out-of-bounds argument read despite an
optional callee parameter; that caller-boundary defect is the next correction.
The full RSP executable and repository acceptance gates remain outstanding.

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

### UTF-16 final-source validation checkpoint (2026-09-09)

JsString now preserves lone UTF-16 units instead of replacing them at indexing
and append boundaries. Language operations, JSON keys/values, emitted literals
and TS7 symbol/literal-type queries retain those units; OS boundaries request
a lossy UTF-8 view explicitly. The safe runtime retains forbid(unsafe_code).
V8 island string parity is not claimed by this checkpoint.

Final-source build and lint pass (0 errors, 3121 existing warnings); pinned
Rust 1.98.0 nonmutating Clippy passes with -D warnings. Twenty facade/literal
parity tests and 26 selected Rust differential corpus cases pass, including
3113–3115 and existing numeric, relational, JSON, regex, filesystem and child
process cases. Three new preflight baseline entries are recorded and verified.

The original TOON parseQuotedString component now matches Node in all 23
scenarios (stdout/stderr/status, engine none), fixing the earlier emoji
corruption. The Redcode RPC sidecar was rebuilt with the changed runtime and
passes its eight existing contracts again. These are development-profile
component builds, not complete consumer applications or size benchmarks.

Broader acceptance remains FAILED/PENDING: the default TS7 order/preflight
canary ran 583 entries in chunks and ended with 16 failing and 16 passing
tests. Thirteen failures first encounter missing baseline entries (including
older upstream corpus additions); three encounter changed diagnostics. This
is not a green full gate. No existing expectations were blindly re-recorded;
only the three new UTF-16 fixtures were added. SCRIPTC_SANDBOX_IMAGE is absent,
so eventual full acceptance must use the documented local plain/sanitized
fallback. Those complete lanes have not passed for this WIP.

Receipts and WIP hashes: `.red/tmp/native-utf16-checkpoint-20260909/`.
Redwall was also discovered missing from the earlier consumer inventory;
see `tests/dogfood/redwall-native.md`. Its original renderer currently refuses
two Date component constructors (775 statements, two failures, no runtime
fences reported). Its existing 1.87 MB vendor binary embeds a JS engine and is
not Rust-native acceptance. The complete deploy/trusted-binary goal is active.

### Date components unlock original Redwall rendering (2026-09-09)

Local Date construction now lowers through a seven-number ABI on Rust/C/LLVM,
with argument evaluation before coercion, calendar rollover, default components,
0–99 year mapping and UTC conversion before TimeClip. Six-zone tests cover DST
folds/gaps, Lord Howe's half hour and Apia's skipped day. Historical OS-vs-ICU
zone differences remain documented; exact old instants are pinned in UTC.

The original Redwall renderer passes 38 existing consumer tests with 26 native
Rust render invocations checked byte-for-byte against Bun and heap-audited.
The generic JSON-input adapter is 4.09 MB vs 81.41 MB for the identical adapter
compiled by Bun. A repeated equivalence-gated benchmark (3 measured samples,
1 warmup per candidate) reports median 3.77 s / 110740 KiB for Rust vs
0.570 s / 131548 KiB for Bun. This is a disk/RSS gain and a CPU loss, not general
backend superiority or acceptance of the complete red-dev application.

Build/lint (0 errors, 3122 warnings), pinned Clippy and runtime 201/201 pass.
Four Rust Date corpus tests pass; the six-zone matrix passes on all backends,
including sanitized C/LLVM, plus eight sanitized corpus comparisons. The
stdlib-fence snapshot removes only the now-supported Date diagnostic; the two
new corpus baselines are recorded/verified. Full plain/sanitized acceptance
and the previously observed 16 broad baseline failures remain unresolved.
See tests/dogfood/redwall-native.md and
.red/tmp/native-date-redwall-checkpoint-20260909/. Next performance experiments
should isolate numeric conversions and borrowed byte access without consumer
rewrites or weakening memory safety. The full trusted-deployment goal is active.


### Numeric conversion experiment: no demonstrated Redwall speedup (2026-09-09)

Rust ToInt32 now extracts IEEE-754 integer bits; 202 runtime tests and pinned
1.98.0 Clippy pass, plus eight focused Rust differentials and the new 3118
corpus on sanitized C/LLVM. Its baseline and source line gate pass. Rebuilt
Redwall retains all 38 contracts (26 native calls with byte parity), identical
generated Rust source, and unchanged consumer sources. Application binaries
use rustc 1.97.1 in both before/after receipts.

Three measured samples plus one warmup per candidate give medians: previous
Rust 3775.09 ms, bit-conversion Rust 3829.10 ms, Bun 582.63 ms. All 12 runs
match outputs exactly. The isolated conversion benchmark improved, but the
real renderer shows no demonstrated gain (median 1.43% slower; no statistical
significance claim). New executable: 4080856 bytes, peak RSS 110836 KiB;
Bun: 81413600 bytes, 131120 KiB. Rust remains 6.57x slower for this input.
The experiment remains WIP; full plain/sanitized gates and broad baseline debt
remain unresolved. Next performance work should measure safe borrowed byte
accesses, with effect ordering preserved. See tests/dogfood/redwall-native.md
and .red/tmp/native-numeric-redwall-checkpoint-20260909/ for evidence.


### Shared TS7 lifecycle and generic closure captures (2026-09-09)

Two compiler defects are fixed: disposing a shared-host program now releases
TS7's ref-counted project and its synthetic config without invalidating live
siblings; generic closure implementations are scoped to their enclosing
specialized frame, preventing reuse of another frame's captures (SC9001).
The lifecycle/facade gate passes 21 tests. Native corpus 3120 covers different
outer capture types and independent same-specialization values with Node
parity; existing closure/value and tuple-length regressions also pass.

The full read-only preflight audit completes 1,731 entries without crashes;
367 missing records plus scoped 3120 are added, exactly two existing baseline
deltas are reviewed, and the default canary is now 32/32 passing (585 entries).
Five diagnostic snapshots are individually reviewed after runtime checks of
new admissions. The final sanitized selection passes 13 tests. Generic closure
families are Rust-only by backend implementation; corpus 2986 and 3120 now
carry that existing directive, not an assertion of C/LLVM sanitizer coverage.

Build/lint pass (0 errors, 3122 warnings). Rebuilt Redwall retains 38 contracts,
26 native/Bun byte comparisons, no engine/fences, unchanged generated Rust and
unchanged consumer sources. Full plain/sanitized gates remain unaccepted;
dynamic-import/main.ts and ns-import-object/main.ts still need their now-admitted
behavior reconciled with their old refusal fixtures. Larger consumer blockers
remain. See tests/dogfood/ts7-lifecycle-gate.md and
.red/tmp/native-ts7-lifecycle-checkpoint-20260909/ for receipts and WIP hashes.


### Graduated import fixtures and full-gate preparation (2026-09-09)

The two remaining refusal fixtures are replaced by execution contracts.
Corpus 3121 preserves the namespace-as-value behavior of ns-import-object.
Corpus 3122 executes the admitted own-module and http2 imports before checking
an absent computed package name; it observes the loadable http2 function shape,
not implementation of its networking APIs. Its own-module imports use explicit
.ts paths so the Node oracle exercises the actual source. The former fixture
would fail on the missing package before reaching the imports it meant to test.

Both new programs match Node under Rust and under sanitized C/LLVM (four
legacy comparisons). Their preflight records preserve the former fixtures'
module orders with relocated paths and empty diagnostics; both are verified
without re-recording other baselines. The two obsolete source fixtures and
refusal snapshots are removed after those execution checks pass. The complete
diagnostic suite is now 115/115 passing, without snapshot-update mode.

Before the complete local gate, the task cache was copied to
/tmp/scriptc-native-full-gate-cache-20260909 and verified by SHA-256 for all
6,231 files (4,602,115,798 bytes), preserving the original cache. New scratch
outputs live in /tmp/scriptc-native-full-gate-tmp-20260909; passed corpus binaries
may be discarded only after their assertions pass, retaining digest receipts.
This avoids consuming the roughly 4 GiB remaining on the /home partition.
SCRIPTC_SANDBOX_IMAGE is still unavailable, so the local fallback applies.

The full plain/sanitized gates are not yet accepted. The next gate uses one
worker, the resource limiter, and --bail 1: any failure stops the run for a
focused diagnosis; a failed or interrupted attempt is not a passing full gate.
Evidence: .red/tmp/native-import-admission-checkpoint-20260909/.

### Manifest gate repaired after first full plain attempt (2026-09-09)

Full plain attempt 1 stopped at a stale generated Date.constructor note,
after 67 native compiler/cache tests passed and two skipped. Regeneration
changes only the note to include already-implemented local Date components.
The 636-entry manifest check and complete 76-test surface-manifest suite pass;
no compiler/runtime behavior changes in this repair. The full plain gate must
be retried, followed by the full sanitized gate; neither is accepted yet.

The Redcode extensionless-root panic is now minimized without consumer edits.
With a neighboring .js file, TS7 loads that sibling instead of the requested
root; without it the server panics. This is still an unresolved frontend defect,
not native application acceptance. See tests/dogfood/frontend-extensionless.md
and .red/tmp/native-manifest-gate-checkpoint-20260909/ for current evidence.
