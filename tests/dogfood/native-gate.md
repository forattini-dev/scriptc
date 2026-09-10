# Native repository gate follow-up

Latest committed compiler checkpoint: `143bd19c`, shared scalar-field record
references and native callback boundaries. The
[append-options working slice](./rsp-native.md#native-append-options-2026-09-08-work-in-progress-after-143bd19c)
now passes focused Node comparisons through Rust, C and LLVM, selected C/LLVM
sanitizer checks, runtime Rust tests/Clippy, workspace build and lint. It is
not committed or release-certified.

The last unfiltered local gate ran in the isolated `native-trust-gate`
checkout on `143bd19c` plus opt-in removal of passed corpus binaries. Build
passed with unchanged source. The plain lane reported a
120-second timeout in a test that compiles 24 switch fixtures in one loop;
that group is split into independently timed cases in the implementation
checkout, retaining all assertions. Its focused run passed 23 cases, with
2398 timing out while contending for the first host build slot; 2398 then
passed in 3.9 seconds with a third slot available and the same one-CPU quota.
These two runs establish all 24 semantic comparisons, not a green full gate.
That run finished red: plain reported 6,355 passed, 103 failed and 161
skipped tests; the sanitized lane encountered ENOSPC and did not complete
its intended coverage. Its status and logs are
under `/tmp/scriptc-trust-gate-143bd19c/`. This frozen checkpoint does not
cover later compiler/runtime or test-harness changes; the final source needs
both full gates before a commit. Sandbox configuration remains unavailable.

The current C backend test results include two broken Zig-shim executions,
a vendor-LRU fixture failure and a ten-second final-compile barrier timeout.
The LRU failure reproduced separately: the warmed cache occupies 2,502,238
bytes, and the test's 5 MiB cap prunes to a 3,932,160-byte low watermark.
Adding the complete executable exceeds that watermark even after the filler
is removed, so evicting the promoted engine archive is allowed by the cache
contract. The fixture now sizes its budget from an actual complete build and
reserves another executable plus metadata below the watermark, forces a cache
miss and retains both the promotion and size assertions. Its focused rerun
passes (`/tmp/scriptc-vendor-lru-after.log`). No production LRU algorithm
change is justified by this finding. Zig 0.13.0 is installed and answers its
version through the absolute executable; the failing tests instead resolved
a mise shim with no selected version. Select the usable executable in the
next gate environment. Both cross checks pass with that selection
(`/tmp/scriptc-zig-selected.log`). The final-compile barrier also reproduced
separately and now follows the test's cancellation signal instead of an
independent ten-second deadline. Cleanup releases and awaits the in-flight
compiler before restoring its environment; the cache-poisoning assertions
remain intact. The ordinary run passes in 24.5 seconds
(`/tmp/scriptc-header-barrier-after.log`). An intentional one-second
cancellation control exits with a failed test after draining compiler cleanup;
that control is termination evidence, not a passing validation run.
Other library/fence assertion failures are also appearing; the final report
must be triaged individually before updating expectations.

Consumer acceptance and repository validation are separate. RPC sidecar and
Redwall acceptance do not make the full repository gate green. The Effect
milestone remains in progress; RSP/Brain and full red-dev/redcode acceptance
remain unfinished.

The local fallback began on the clean, immutable Redwall snapshot
`e7bcadbc6c8b7e7166a380fb81269b713fb295bf`. Sandbox configuration was unavailable
(`SCRIPTC_SANDBOX_IMAGE` absent). Both lanes finished with failures on 2026-09-07. The plain lane reported
146 failed files / 348 failed tests, 55 passed files / 5,524 passed tests,
and three snapshot failures. The sanitized lane reported 204 failed files /
155 failed tests and two passed files / 37 passed tests. ENOSPC occurred
already in the plain lane and prevented most sanitized tests from starting.
These totals include infrastructure cascades, not independently confirmed
regressions. Its supervisor was recovered after the original tool session
disappeared; the test process itself survived.
The run uses a two-core CPU quota, two Vitest workers, one compiler worker per test
worker, and a private persistent cache. It cannot validate later Effect or
runtime repairs. A fresh immutable gate must cover the final changes before
shipping.

Older completed-run evidence is in `/tmp/scriptc-redwall-full-gate.json`,
`/tmp/scriptc-redwall-full-plain.log` and
`/tmp/scriptc-redwall-full-sanitized.log`. These are workstation artifacts,
not portable checked-in proof of a passing gate.

| Finding | Evidence and disposition |
| --- | --- |
| Library refusal and sanitizer fixtures | Repaired in `ace7948f`; 16 selected library-mode cases and four callback cases passed. |
| Windows clocks and sleeps | Cross compilation reproduced missing `clock_gettime`, `CLOCK_MONOTONIC`, `CLOCK_REALTIME` and `nanosleep`. Runtime-owned Win32/POSIX helpers now pass the Windows PE/network/TLS/dynamic/fetch cross-build and the Windows/Linux ARM regex cross-build. Twelve selected C/LLVM differential cases pass in each local lane (plain and sanitized). Windows execution was not run on this Linux host. |
| Windows certificate-store fixture | The EKU-only probe did not reference store enumeration, so the linker removed the `TrustedPeople` string asserted by the test. The probe now includes an enumeration path, and its cross-build assertions pass. |
| Fetch test proxy contamination | `fetch.test.ts` poisons the compiler process's proxy variables, which Cargo inherits while downloading rusty_v8. The archive returned HTTP 200 with the normal environment; the refused proxy reproduced connection failure. The proxy now belongs only to executed fixtures. Three Rust fetch contracts and three explicit-proxy contracts pass. The initial 120-second cold-build timeout required preparing the runtime before repeating these checks. |
| Surface, Date-fence and coverage expectations | Existing expectations disagree with the current manifest/lowering. Each witness must be checked before updating expectations. |
| Deferred catch-binding class failures | Repaired in the current working snapshot: collection no longer flushes deferred class diagnostics while probing initializer storage. All 25 error contracts pass plain and sanitized; seven Rust class corpus programs also pass. See the gate repair checkpoint below. |
| Static executable size | The hello-world size assertion observed 463,720 bytes against a 392,000-byte limit. Cause and acceptable budget remain unresolved. |
| Cache identity and timing cases | Several mutation/publication/LRU cases failed; distinguish actual cache defects from timing failures before changing tests. |
| Whole-corpus coverage sweep | The single sweep exceeded its 600-second timeout. This is not evidence that every individual coverage case failed. |
| TS7 order baselines | The completed plain lane reports missing baselines for new corpus/diagnostic/npm/Node fixtures and changed preflight diagnostics. Review those differences before recording new expectations; ENOSPC does not explain missing checked-in baselines. |

Use the resource limiter for focused checks. Native tests need a private
0700 cache, and inherited `LD_LIBRARY_PATH` disables persistent cache reuse.
Do not disable sanitizers or relax behavioral assertions to make a gate pass.

An audit on 2026-09-07 found that the limiter's explicit environment list
omitted `SCRIPTC_SAN`. A flag prefixed before `pnpm limit` did not reach the
transient service: a child-process probe printed `null`. Commit `7593476a`
forwards it and the same probe prints `"1"`; a regression captures the
`systemd-run --setenv SCRIPTC_SAN=1` argument. Earlier focused runs using
that invocation are not sanitizer evidence. This finding does not reclassify
the separately supervised full gate above; its command/environment needs
its own audit. Replacement focused runs are recorded in
[rsp-native.md](./rsp-native.md).

Storage recovery removed 5,760 reproducible ELF/PE binaries (78,559,181,960
bytes) only from the completed Redwall checkout's `node_modules/.cache/scriptc-tests`.
Generated sources, oracle outputs, metadata, logs, consumer acceptance artifacts
and source worktrees were retained. The removal manifest is
`/tmp/scriptc-redwall-cache-reclaimed.tsv`. Subsequent gates need enough disk
headroom for their native output caches as well as CPU and memory limits.

## Rust-default checkpoint

Rust is now the default build and backend-validated coverage path. The
legacy whole-program startup cache is restricted to explicit C/LLVM
selections. Library profiles still specify their emission explicitly.
Plain adoption tests exercise Rust; tests that consume SCRIPTC_SAN select
C explicitly for that lane, because Rust sanitizer support is unfinished.
The full gate must be rerun after this default migration; prior gate
results do not certify it, and focused passes are not a release verdict.

Documentation smoke builds produced a native Rust executable, an explicit
LLVM Linux ARM64 ELF and an explicit LLVM Windows x64 PE. WASI failed while
compiling the C runtime, reporting undeclared realpath/chmod and DT_SOCK.
No C runtime repair is included in this checkpoint. Evidence is retained in
`/tmp/scriptc-rust-default-doc-smoke.json` and its companion log. Windows
and ARM64 artifacts were inspected, not executed on this Linux x64 host.

The full project-adoption suite at this checkpoint has 11 passes and two
failures. Rust explicitly refuses fetch.streamNew in the @types/node
ReadableStream constructor fixture; the second failure is a diagnostic
snapshot disagreement around Response.clone and URL.hash. Neither assertion
was relaxed or skipped. These remain quality blockers for the new default,
recorded in `/tmp/scriptc-rust-default-adoption.log`. The selected sanitized
C/LLVM/adoption run has 21 passes, not a full sanitizer gate.

## Native Rust Web Streams checkpoint

The two adoption failures recorded above are repaired. The full project-adoption
file now passes all 15 tests, including an explicit Rust/C/LLVM build-and-execute
matrix for the original `node-types/fetch-static.ts` entry with no engine.
The five default-backend API tests also pass (20/20 in the combined run).
The constructor is implemented in Rust, and the diagnostic snapshot retains
the static Response.clone refusal while removing the obsolete URL.hash refusal.
The original entry does not invoke its network request functions, so this is
constructor/admission evidence rather than full Fetch transport conformance.

The [Web Streams parity record](./rust-web-streams.md) describes the native
queue, callbacks, locks, read/closed settlement, chunk identity and cycle tests.
All 30 selected plain corpus tests pass in Rust, C and LLVM. Corpus 3039 also
exposed a pre-existing start-Promise ordering difference in the C runtime;
the repaired C/LLVM behavior matches Node. The 172 Rust runtime tests and
all-target Clippy with warnings denied pass on the pinned Rust 1.98.0 toolchain.
Workspace build, changed-compiler ESLint, generated-libcall checks and source
ceilings pass. Seven reviewed preflight/order records were added only for the
new corpus programs, preserving prior unrelated baseline disagreements.

The selected sanitized run passes 27/27: 20 C/LLVM corpus tests, two original
adoption builds, the diagnostic snapshot and four existing stream integration
contracts. Those four contracts also pass plain. The final logs are
`/tmp/scriptc-stream-parity-final.log`,
`/tmp/scriptc-stream-adoption-final.log`,
`/tmp/scriptc-stream-sanitized-final.log` and
`/tmp/scriptc-stream-runtime-checkpoint.log`; the parity record gives the
commands and distinguishes Rust witnesses from C/LLVM transport coverage.

This checkpoint does not change the full-suite verdict above. The fresh
Sandbox attempt stops before tests because SCRIPTC_SANDBOX_IMAGE is absent
(`/tmp/scriptc-stream-sandbox.log`). No full local fallback was completed on
this checkpoint; selected plain/sanitized passes do not certify a release or
original RSP/Brain/red-dev/redcode acceptance.

## Native Rust local import checkpoint

Literal local ESM imports now have a Rust-native evaluation queue, shared
module evaluation/failure records and live namespace getters. The
[native import parity record](./rust-native-imports.md) documents admission,
behavioral witnesses, reproducible commands and remaining boundaries.
Runtime wildcard re-exports are explicitly refused after a Node comparison
exposed silently missing namespace exports; type-only wildcards and named
re-exports remain admitted.

Focused validation passes on the working snapshot based on `c6e8cb8c`:

| Check | Result |
| --- | --- |
| Native Rust corpus 3041–3047 | 7 passes with engine prohibited; exit-13 witness does not assert complete stderr parity |
| Native import API/IR/backend files | 38 passes, including an actual Rust binary and C/LLVM refusal contracts |
| Existing C/LLVM module/await/JSON selection | 28 plain and 12 sanitized passes |
| Rust runtime, pinned 1.98.0 | 180 tests pass; all-target Clippy passes with warnings denied |
| Workspace build and lint | Pass; zero lint errors and 3,114 warnings; generated files and source ceilings match |
| New preflight/order baselines | All seven match; existing unrelated disagreements retained |

Final focused logs are `/tmp/scriptc-native-import-corpus-checkpoint.log`,
`/tmp/scriptc-native-import-api-checkpoint.log`,
`/tmp/scriptc-native-import-legacy-plain.log`,
`/tmp/scriptc-native-import-legacy-sanitized.log`,
`/tmp/scriptc-native-namespace-order-full.log`,
`/tmp/scriptc-native-namespace-order-clippy.log`,
`/tmp/scriptc-native-import-build-checkpoint.log`,
`/tmp/scriptc-native-import-lint-checkpoint.log` and
`/tmp/scriptc-native-import-baselines-check.log`.

The full-suite verdict remains pending/red. Sandbox configuration is still
unavailable on this workstation (`SCRIPTC_SANDBOX_IMAGE` is absent, and
neither checkout has `.env.local`); no fresh full local fallback was completed
for this checkpoint. The focused C/LLVM sanitizer selection does not test
Rust sanitizer support or certify a release. The original RSP survey still
reports refusals and produces no complete executable; neither C/LLVM
equivalence nor superior performance is established.

## Native Rust wildcard re-export checkpoint

The follow-up to `9b03640f` replaces the blanket wildcard refusal with runtime
ESM export resolution. Multilevel stars, diamonds, cycles, explicit overrides,
type-only shadows and renamed default snapshots have native witnesses.
Named re-exports are checked independently so another star or explicit root
export cannot hide an invalid dependent binding. See the updated
[native import parity record](./rust-native-imports.md#wildcard-checkpoint-validation).

All ten native import corpus programs and 45 API/IR/backend tests pass with
the no-engine contracts enforced. The nine normal-exit corpus programs match
Node's stdout, stderr and exit status; the existing exit-13 stderr limitation
for 3045 is unchanged. Workspace build and lint pass with zero errors and
3,114 warnings, including source-ceiling and generated-file checks. Only the
three new preflight/order baselines were added; prior entries were preserved.

Final evidence is in `/tmp/scriptc-native-star-corpus-final.log`,
`/tmp/scriptc-native-star-api-final.log`,
`/tmp/scriptc-native-star-build-checkpoint.log`,
`/tmp/scriptc-native-star-lint-checkpoint.log` and
`/tmp/scriptc-native-star-baselines.log`.

Rust runtime sources are unchanged in this step; the previous Cargo and
C/LLVM sanitizer checks were not repeated. The full plain/sanitized suite
remains pending/red, with Sandbox configuration still absent and no fresh full
local fallback completed. The original RSP survey still refuses the telemetry
callback's record/Promise boundary and produces no complete executable.

## Native asynchronous export checkpoint

The follow-up to `c6e8e2d0` admits primitive/void Promise results from exported
functions and corrects the extra reaction job introduced by native handle
bridging. Rust promise views preserve source identity, observation ordering
and rejection ownership. Typed record/array arguments and composite Promise
payloads remain refused. Details and local validation artifacts are in the
[native import record](./rust-native-imports.md#native-asynchronous-function-boundary).

Thirteen differential programs pass across the focused selection and final
3051 rerun: eleven native imports and two existing async regressions. The
exit-13 stderr limitation of 3045 is unchanged.

The focused API/IR/backend checks pass 52 cases across eight files, including
three embedded-engine bridge regressions. Rust 1.98.0 passes 183 runtime tests
and all-target Clippy with warnings denied. Workspace build, lint, generated
files and source ceilings pass; lint retains 3,114 warnings and zero errors.
The new preflight/order entry preserves all existing baselines.

The unchanged original RSP now reaches 2,109 statements, with 257 failed and
209 diagnostics. The newly admitted asynchronous exports expose deeper MCP
and resident-store blockers. Telemetry still requires an identity-preserving
record argument boundary and the separate appendFileSync overload. There is
still no final RSP module, execution profile or executable.

The Sandbox image and local environment configuration remain absent. No fresh
full plain/sanitized fallback was completed in this step: the full gate stays
pending/red. Focused validation is not release certification.

## Canonical record map checkpoint

The follow-up to `71e06834` preserves the native map when open
`Record<string, unknown>` values cross typed/dynamic boundaries, and admits
those records as native namespace value exports. Declared-field records,
typed index values and broader record callback signatures remain refused.
The original RSP survey is unchanged and still produces no complete binary.

The focused gate passes 55 API/IR/backend tests and 23 differential programs,
including twelve native import witnesses with the engine prohibited. The
new record witness checks shared mutation, default-export snapshots, native
async calls, cloning and an abandoned cycle under heap audit. The two
nonzero-exit witnesses retain the harness's documented stderr limitation.
Evidence and the exact admitted boundary are in the
[native import record](./rust-native-imports.md#shared-unknown-index-record-values).

Workspace build, lint, generated-file and source-ceiling checks also pass;
lint retains 3,114 warnings and zero errors. Runtime source is unchanged;
its previous Cargo/Clippy gate was not repeated.
No fresh full plain/sanitized gate was completed. Full validation and release
readiness remain pending/red, independent of these focused results.

## Gate repair working checkpoint — 2026-09-08

The implementation checkout remains based on `143bd19c` with uncommitted
append and gate repairs. The separately running full gate covers its frozen
baseline, not these changes.

The native-import handle probe used recursive traversal before the ordinary
expression depth fence. Its iterative replacement lets the existing 7,000-level
JavaScript fixture reach the named deferred diagnostic instead of overflowing
the host stack. The configured expression depth limit is unchanged.
Class storage inference now suppresses deferred-diagnostic flushing only while
collecting globals; the real class use still diagnoses a poisoned class.
The poisoned-base snapshot retains the primary error and drops the secondary
misleading extends-edge cascade.

Current focused evidence:

| Check | Result and local artifact |
| --- | --- |
| Complete error contracts, plain | 25 pass; `/tmp/scriptc-errors-repaired-plain.log` |
| Complete error contracts, sanitized | 25 pass; `/tmp/scriptc-errors-repaired-sanitized.log` |
| Rust class corpus 1940, 1941, 1944, 2002, 2798, 3028, 3031 | 7 pass against Node with heap audit; `/tmp/scriptc-class-rust-regressions.log` |
| Native import corpus after iterative probe | 6 pass; `/tmp/scriptc-native-type-walk-corpus.log` |
| Library profiles and exact Date fences | 67 pass: 61 profile checks and six C/LLVM Date contracts; `/tmp/scriptc-library-fences-after.log` |
| Workspace build after class/probe repair | Pass; `/tmp/scriptc-native-gate-repairs-build.log` |
| Full lint after class/probe repair | Zero errors, 3,114 warnings; generated files and line ceilings pass; `/tmp/scriptc-native-gate-current-lint.log` |

The Date contracts explicitly prove both directions: fencing `getTime` allows
`Date.parse`, and fencing `Date.parse` allows `getTime`, while each fenced call
still refuses SC4008. The profile tests now recognize native `Math.sin` and
retain a separate dynamic-only `Response.clone` refusal witness.

Four surface diagnostic failures reproduced in
`/tmp/scriptc-surface-diagnostics-before.log`. Two were backend gaps:
`fetch.streamFrom` lacked Rust emission (repaired below), and `fetch.responseBytes` refused the
result shape reached by a union of Response methods (repaired below). The other two were stale
expectations that `Response.clone` remained refused with the engine enabled.
Per-operation probes confirmed the actual boundary; the repaired tests assert
each remaining refused operation by name, with two passes in
`/tmp/scriptc-surface-refusals-after.log`. Static clone extraction and calls
still refuse; dynamic `tee`, `pipeTo`, `blob` and `formData` remain refused.

The missing-FFI-symbol contract also reproduced an actual Rust driver defect:
an undefined native symbol escaped `compile()` as an InternalCompilerError.
Rust now returns SC5004 attributed to the FFI profile, matching C/LLVM.
The shared diagnostic detail retains the missing symbol and recognizes
rust-lld's singular `undefined symbol` marker after generated-code warnings.
The existing integration test now runs all three backends, with three plain
passes and two sanitized C/LLVM passes in `/tmp/scriptc-ffi-link-after.log`
and `/tmp/scriptc-ffi-link-sanitized.log`. The original failure is retained in
`/tmp/scriptc-ffi-link-before.log`. Workspace build and changed-source lint
pass after this repair (`/tmp/scriptc-ffi-repair-build.log`,
`/tmp/scriptc-ffi-repair-lint.log`; zero errors, 32 existing lint warnings).

These changes do not complete the full gate or produce an executable of the
unchanged RSP consumer. Remaining full-suite failures and final
combined-source validation are still compiler work.

## Native Response result unions

Rust now lowers `await response[member]()` for a typed
`member: "text" | "bytes"`, preserving the `string | Uint8Array` fulfillment.
Each branch projects its native payload into the existing union with
`promise_view_map`, retaining the source Promise's reaction scheduling.
No runtime changes or engine fallback are involved.

Corpus `3056-response-method-union.ts` executes both members on constructed
Responses, checks payload contents and `bodyUsed`, and requires no engine in
the Rust lane. Its initial SC3001 refusal is in
`/tmp/scriptc-response-union-lowering-before.log`. The repaired corpus passes
against Node in Rust, C and LLVM, and the original surface-analysis regression
passes too (four tests in `/tmp/scriptc-response-union-after.log`).
The C and LLVM sanitized differential runs also pass (two tests in
`/tmp/scriptc-response-union-sanitized.log`).
Workspace build, changed-source lint and line ceilings pass. The new TS7 order
baseline was recorded individually, preserving existing entries.

The first probe also exposed a separate frontend gap: reading `.length` on
an unnarrowed `string | Uint8Array` still reports SC1090 even though both
members provide a numeric length. That is compiler work. The focused Response
fixture narrows before reading payload fields to isolate its Promise-dispatch
regression; no consumer source was changed.

An additional full-file manifest/profile rerun was deliberately stopped after
the focused reproductions and repairs above, to release its native compiler
slot. `/tmp/scriptc-profile-manifest-before.log` is an incomplete run, not
a validation result. The independent full frozen-checkout gate continues.

## Native ReadableStream.from and array views

The Rust backend now emits native `ReadableStream.from` for the indexed
sources in this slice: arrays, strings and Uint8Array, including dynamic
representations of those sources. Array items are fetched on reader demand
with high-water mark zero. Mutations between reads remain visible. Strings
advance by Unicode scalar value rather than UTF-8 byte or quadratic rescanning.
The native adapter resolves Promise items and preserves the Node 24 reaction
order for one read and multiple pending reads. Primitive `Promise.reject`
reasons now use the existing dynamic rejection carrier; Error reasons retain
their existing path. Corpus 3059 covers string, number, boolean, null and
undefined rejection reasons.

The first nested-array probe produced `false 1 / false 2 2` instead of Node's
`true 2 / true 3 3`. Rust now projects those chunks through a traced array view
that retains the original typed storage, with checked writes into that
storage. Length, indexing, set, push and pop avoid whole-array conversion.
Ordinary arrays retain their Vec storage, and bulk readers borrow it without
copying. Serializers, array iterators and other runtime readers now also
observe views. Checked optional-array exits recover the original handle;
array equality compares the underlying storage identity. Runtime tests cover
bidirectional mutation, raw template arrays, bulk operations, lazy scalar
projection and a collectible source/view cycle. Generated Rust and the
maintained runtime still forbid unsafe code.

Bytes chunks retain their bytes handle. Selected record chunks retain shared
record storage, including optional record exits. This is not a blanket change
to the compiler's other composite-to-dynamic conversions: generic boxing and
more complex payload shapes still need their own identity audit.

The same source-demand corpus exposed eager prefetch in C/LLVM. Their
`sf_stream_pull` now waits for a pending reader or collector/upload/discard
consumer before pulling an indexed `from` source. Existing constructor-stream
prefetch behavior is unchanged.

Focused evidence (local uncommitted source):

| Check | Result and local artifact |
| --- | --- |
| Rust stream API regressions | Five pass, including rejected/resolved items, single/multiple-read job order and nested-array identity; `/tmp/scriptc-stream-view-native.log` |
| Array identity corpus 3060 | Rust, C and LLVM pass against Node; `/tmp/scriptc-stream-array-corpus-after.log` |
| Array identity corpus 3060, sanitized | C and LLVM pass; `/tmp/scriptc-stream-array-sanitized.log` |
| Corpus 3057–3059 and existing static Fetch, sanitized | 12 pass in C/LLVM; `/tmp/scriptc-stream-from-sanitized.log` |
| Rust array/union regression set | Nine corpus programs pass; `/tmp/scriptc-stream-view-regressions.log` |
| Runtime Rust | 190 tests pass on 1.98.0; `/tmp/scriptc-stream-view-runtime-verified.log` |
| Runtime Clippy | All targets pass with warnings denied; `/tmp/scriptc-stream-view-clippy.log` |
| Workspace build and lint | Pass; lint has zero errors and existing warnings; `/tmp/scriptc-stream-combined-build.log`, `/tmp/scriptc-stream-combined-lint.log` |
| TS7 baselines 3057–3060 | Individually recorded with no preflight diagnostics, preserving existing entries; `/tmp/scriptc-stream-baselines.log`; fresh read-only verification in `/tmp/scriptc-stream-baselines-verified.log` |

A separate probe found frontend SC2020 for `array.splice(1, 1, 7, 8)`.
That insertion overload remains compiler work. Corpus 3060 uses the supported
two-argument deletion form to isolate stream aliasing; the Rust runtime view's
insertion behavior is tested directly. The failing overload is retained in
`/tmp/scriptc-stream-array-corpus.log`; no consumer was edited.
This slice does not claim arbitrary custom iterables or asynchronous iterables.

The opt-in passed-binary cleanup from the frozen gate is now integrated into
the implementation checkout. It only deletes corpus scratch executables after
all assertions pass, retaining generated source and a SHA-256 receipt.
Outside paths and symlinks are rejected; two focused tests pass in
`/tmp/scriptc-passed-binary-final.log`. An opted-in corpus 3059 run passes
in Rust, C and LLVM and writes the digest receipts
(`/tmp/scriptc-passed-binary-integration.log`). Ordinary runs retain their artifacts.

The full baseline gate remains a different frozen source tree. Final combined
plain/sanitized lanes and unchanged-consumer executable acceptance remain
pending; the results above do not authorize a release-readiness claim.

## Readline queue, EOF and optional output

The test named "C readline" was compiling the default Rust backend. Its
buffered-close failure reproduced: Rust returned two lines while Node returned
all four already received lines after `close()`. Rust now keeps an iterator
event queue independently of the input byte buffer. Closing detaches future
input and retains queued events. Close listeners precede a pending read's
completion. An EOF tail reaches the iterator without answering a pending
question, while a held CR remains a real terminator.

The tests explicitly select Rust and C and feed actual line terminators (the
former table accidentally used literal backslashes). Stdout, stderr and exit
status are compared with Node; the sanitized lane filters only the known
ASan makecontext/swapcontext warning, matching the repository harness. Rust
executables run with heap audit. Direct LLVM's `rl.nextLine` refusal is pinned
separately as SC3001; it is not claimed as native iterator execution.

Probes also exposed prompts being printed without `output` configured. The
frontend now retains the presence of `output: process.stdout` as a typed
boolean in `rl.create`. Rust, C and LLVM pass it to their runtime; omitted
output suppresses prompts while preserving question behavior. Existing
no-argument runtime entry points remain as compatibility wrappers. Corpus
3061 checks both modes without an engine.

| Check | Result and artifact |
| --- | --- |
| Original failure | `/tmp/scriptc-readline-close-before.log` |
| Rust/C iterator and question contracts, LLVM admission fence and existing EOF witness | 28 pass; `/tmp/scriptc-readline-native-final.log` |
| Sanitized contracts and readline corpus | 20 checks pass; `/tmp/scriptc-readline-sanitized-final.log`; LLVM admits 1475/3061 and refuses iterator corpus 2794 |
| Corpus 3061 plain | Rust, C and LLVM pass; `/tmp/scriptc-readline-output-plain.log` |
| Runtime | 194 tests and all-target Clippy pass on 1.98.0; `/tmp/scriptc-readline-cargo-final.log`, `/tmp/scriptc-readline-clippy.log` |
| Build/lint | Pass, zero lint errors; `/tmp/scriptc-readline-build.log`, `/tmp/scriptc-readline-lint-final.log` |
| TS7 | Corpus 3061 baseline recorded individually; `/tmp/scriptc-readline-baseline.log` |

## Frozen baseline result and disk recovery

The plain lane on immutable `143bd19c` plus scratch-binary cleanup completed
with 6,355 passing, 103 failing and 161 skipped tests in 227 files (27 failed
files). Its source hash remained unchanged. The complete result is
`/tmp/scriptc-trust-gate-143bd19c/plain.json`. These results precede the repairs
above. The sanitized lane also ended with exit 1, with ENOSPC preventing
complete execution; it is not a complete semantic validation. Both lane
statuses and unchanged-source checks are in the adjacent `status.json`.

The `/home` partition filled despite free space on `/tmp`'s separate partition.
Old, inactive native test artifacts were relocated to
`/tmp/scriptc-retained-native-artifacts-20260908`, preserving their original
paths with directory symlinks. Nothing in those artifacts was discarded; the
move receipts are in `moves.jsonl`. An interrupted write to this document was
recovered from the preceding source snapshot and its SHA-256 verified before
an atomic replacement. Focused runs interrupted by ENOSPC must be rerun;
`/tmp/scriptc-js-overload-rust-repaired.log` and
`/tmp/scriptc-bun-fixture-native.log` are failed infrastructure evidence.

Remaining failures include actual Rust/engine behavior, stale code-generation
and admission expectations, missing fixture dependencies and TS7 baselines,
C/LLVM handling of generic function families, and the C hello-world size
budget. Final combined-source plain/sanitized lanes and unchanged-consumer
acceptance remain required before committing or shipping.

## Gate repairs: JS overloads, inherited dispatch and fixture contracts

The JavaScript preflight now relaxes TS2575 (overload arity), alongside
TS2554, only for JavaScript. The same invalid five-argument `fs.read` call
in TypeScript still fails SC0001. Its checked Rust lowering also accepts
its actual void return type for the always-throwing `fs.readChk` tail.
Two preflight regressions, the Rust checked-fs API and corpus 2595 pass
(`/tmp/scriptc-js-overload-rust-recovered.log`, four checks). The C/LLVM
sanitized corpus plus the two preflight checks also pass (four checks,
`/tmp/scriptc-js-overload-sanitized.log`). Build and lint passed after this
repair (`/tmp/scriptc-gate-repairs-{build,lint}-final.log`).

The Bunny test package was absent from clean worktrees because its fixture
`node_modules` directory was ignored. Its three source/manifest/type files
are now eligible for tracking. The native contract exercises a real SQLite
query and close, plus the unsupported `bun:ffi.dlopen` trap. SQLite was
already implemented; expecting its constructor to trap was stale.

Inheritance cost tests now use runtime-selected base/subclass instances
where virtual dispatch is required. A separate exact-construction case
checks direct overridden method/accessor calls and no virtual method slots.
Hierarchy destructor metadata can remain after an upcast and does not imply
virtual method dispatch. All eight inheritance contracts and three Bun
contracts pass (`/tmp/scriptc-cost-bun-contracts.log`). Eight inheritance
contracts also pass with C sanitizers. That invocation includes a ninth,
ordinary Rust Readable check (`/tmp/scriptc-cost-readable-sanitized.log`);
it is not evidence of Rust sanitizer instrumentation. The Readable test now
pins Node's actual coalescing of pre-buffered byte chunks: `one two 7`.

The default backend no-engine contract was stale too: it grouped default
Rust with explicit C/LLVM. Eight admission checks now pass, separately
asserting default Rust stays engine-free and C/LLVM reject QuickJS under
`--no-engine` (`/tmp/scriptc-no-engine-contracts.log`). These focused results
do not supersede the outstanding complete plain/sanitized gates or RSP
consumer acceptance.

## Engine handles and native Number predicates

Three destructuring failures reproduced on the current source before repair
(`/tmp/scriptc-island-destructuring-before.log`). The Rust emitter applied
native dynamic helpers to values stored as engine handles. It now delegates
those patterns and builtin calls to the already selected realm. Empty object
checks retain the source spelling in TypeErrors and check handle-held null
and undefined. Property writes also dispatch through the engine handle.
This does not introduce an engine into native programs.

All six destructuring/builtin API cases pass against Node with heap audit
(`/tmp/scriptc-island-dispatch-final.log`). A broader replay recovered five
of ten historical failures (`/tmp/scriptc-island-dispatch-corpus.log`). The
five remaining cases in that replay were 2210, 2474, 2475, 2633 and 2963;
the replay as a whole was red and is not a completed corpus gate.

A new two-mode witness then exposed an admission mismatch: Number.isInteger
and Number.isSafeInteger had native Rust lowering but their intrinsic global
lookups still selected an engine. Admission and emission now share the exact
call-signature recognizer. Admission continues traversing the argument, so
an intrinsic call cannot hide explicit engine evaluation. Other global calls
retain their existing engine requirements. The same mutation/destructuring
and numeric-predicate program passes with engine disabled and explicitly
enabled (`/tmp/scriptc-native-number-specialization.log`, ten API/admission
checks at that point). Two additional nested-engine refusal tests pass
(`/tmp/scriptc-native-number-nested.log`).

Corpus 3062 pins non-coercion, safe-integer boundaries, negative zero, NaN,
infinity, null/undefined and argument effects. Rust executes it with reported
engine `none`; C and LLVM also match Node (three checks,
`/tmp/scriptc-native-number-corpus.log`). C/LLVM sanitized executions pass
(two checks, `/tmp/scriptc-native-number-sanitized.log`). Its TS7 baseline
was recorded individually and freshly verified in read-only mode
(`/tmp/scriptc-number-baseline-verified.log`). Build and lint pass with zero
lint errors (`/tmp/scriptc-native-number-{build,lint}.log`).

Removing the unnecessary Number engine requirement also recovers corpus
2474: its literal spreads and getters can remain on their native dynamic
storage. The separate replay is recorded in
`/tmp/scriptc-native-number-followups-final.log`. That does not fix object
spread on actual engine handles (2475), Promise reaction order (2210), or
composite results crossing asynchronous callbacks (2633/2963). Those defects
remain compiler/runtime work. RSP's typed factory result and hybrid record
spread/delete admission gaps also remain; no consumer files were changed.
Full final-source plain and sanitized lanes and an unchanged RSP executable
are still required before the trust/deploy objective is complete.

## Native Promise adoption and finally ordering

The remaining native Promise-order failure (corpus 2210) is repaired. Rust's
dynamic handler-result adoption now queues the thenable-resolution job before
registering its forwarding reaction, using a view for the representation
boundary. `finally` constructs the intermediate cleanup continuation and
adopts it: scalar cleanup no longer settles the outer promise immediately.
A cleanup callback returning the outer promise leaves the dependency cycle
pending, as Node does, instead of spuriously rejecting it as direct self
resolution. This concerns native Promises; it does not establish general
thenable-object assimilation support.

New no-engine corpus 3063 compares scalar cleanup, fulfilled/rejected Promise
cleanup, callbacks that throw, non-callable cleanup, pending cleanup on both
source outcomes, and the pending cycle against Node. The original Rust run
failed both 2210 and 3063 (`/tmp/scriptc-promise-finally-before.log`). The new
corpus also exposed C/LLVM's early cleanup/forwarding reactions; their shared
C runtime now preserves the corresponding continuation and adoption stages,
retaining cleanup rejection across the suspension before forwarding it.

Final evidence:

- 2210 and expanded 3063 pass on Rust, C and LLVM: six checks in
  `/tmp/scriptc-promise-finally-plain-final.log`; Rust 3063 reports engine none.
- Sanitized C/LLVM 2211 and expanded 3063 pass: four checks in
  `/tmp/scriptc-promise-finally-sanitized-final.log`. Sanitized 2210 also
  passed after the runtime repair in
  `/tmp/scriptc-promise-finally-sanitized-after.log`.
- Rust regressions 1429, 1982, 2211 and 3051 pass: four checks in
  `/tmp/scriptc-promise-finally-regressions.log`.
- Build and lint pass (zero lint errors), and 3063's individually recorded
  TS7 baseline matches fresh preflight after the pending-cleanup extension:
  `/tmp/scriptc-promise-finally-{build,lint}.log` and
  `/tmp/scriptc-promise-baseline-verified.log`.

`origin/main` was freshly fetched and remains an ancestor of this branch
(120 commits ahead, zero behind); no reconciliation was needed. No commit,
push, deployment or consumer change was made. Actual engine-handle spreads
(2475), composite async callback results (2633/2963), the recorded native RSP
admission gaps and the remaining full-gate failures still need work. Neither
the complete final-source plain/sanitized gate nor unchanged RSP execution
has passed.

## Engine-handle object spread

Rust object spread now copies data properties from actual engine handles.
Boa uses its public CopyDataProperties operation; V8 snapshots own keys,
rechecks descriptors in order and defines data properties, including symbols.
Corpus 3064 pins shallow object/byte identity, shared mutation, getters that
delete later keys, Proxy trap order, non-enumerable/inherited exclusions and
`__proto__` as an ordinary data property. This is engine compatibility;
generic native composite-to-engine conversion still uses the existing copy
bridge.

The Rust differential artifact key now includes the selected engine so Boa
and V8 runs cannot race on one generated source/binary path. Final distinct
artifact runs pass 2475 and 3064 on each engine, without retries:
`/tmp/scriptc-island-spread-{v8,boa}-final.log`. Build, lint, 194 default
runtime tests, default all-target Clippy and both engine-specific Clippy
checks pass (`/tmp/scriptc-island-spread-{build,lint,cargo,clippy,v8-clippy,boa-clippy}.log`).
The individually recorded 3064 TS7 baseline matches fresh read-only preflight
(`/tmp/scriptc-spread-baseline-verified.log`).

2633 now reaches its final Promise.all result but still rejects an engine
array as a native array; solving that requires a shared engine-array view.
2963 and the RSP native factory/hybrid record gaps remain. These focused
checks do not replace the complete final-source plain and sanitized gates
or unchanged RSP execution. No commit, push or consumer edit was made.

## Native typed factory methods and function identity

A minimized version of the RSP factory boundary reproduced SC1100 despite a
TypeScript interface already declaring the result. Native shared record
storage now also accepts fixed methods over number/string/boolean/unknown
arguments and results (and void results). Frontend coercion, builtin
boundaries and IR validation agree on the admission domain. Rust reads
validate each current field from the retained dynamic map, writes update that
same map, and method signatures register their read adapters and write boxes.
Required callable members never fall through JSON decoding.

The new corpus exposed a second defect: repeated method reads constructed
adapters with fresh function identities. Rust now obtains an adapter's
identity from its underlying native callable; dynamic equality also compares
that identity across signatures. Corpus 3065 checks closed-over state, two
typed aliases of the same map, replacement from both sides, detached original
functions and catchable TypeError after an untyped replacement becomes
non-callable. It matches Node with engine none and the heap audit enabled.

Evidence:

- Original typed factory refusal: `/tmp/scriptc-native-factory-before.log`.
- Initial object-sharing success still failed method identity:
  `/tmp/scriptc-native-factory-corpus.log`.
- Final focused run: 41 passing checks in four files, including ten Rust
  differential programs (1664-1668, 3052-3054, 3060, 3065), admission checks
  and ten shape-domain tests: `/tmp/scriptc-native-factory-final.log`.
- C/LLVM sanitized regressions 902, 1666 and 2902: six passing differential
  checks in `/tmp/scriptc-native-factory-sanitized.log`. This does not certify
  C/LLVM shared record identity for the new Rust-only corpus.
- 3065 TS7 baseline was recorded individually and freshly verified without
  changing it: `/tmp/scriptc-factory-baseline-verified.log`.
- Lint passes with zero errors: `/tmp/scriptc-native-factory-lint.log`.
- New shared callable exits are explicitly refused by C/LLVM at coverage and
  compilation, before artifact creation, rather than entering their field-copy
  record builders. Rust keeps the admitted shared representation. Eight API
  and backend contract checks pass in
  `/tmp/scriptc-native-factory-backend-final.log`.
- Final workspace build and lint pass after the backend refusal was added:
  `/tmp/scriptc-native-factory-{build,lint}-verified.log`. A fresh comparison
  of the compiler build metadata with all 279 source input hashes found no
  mismatch; maintained source line limits and `git diff --check` also pass.

This is a partial repair of the native factory boundary, not full RSP
admission. Methods taking or returning arrays/records/bytes remain refused
until shared parameter/result representations exist; the full ToonlLineEmitter
signature still reaches that compiler gap. Object-literal methods using this
also retain their pre-existing explicit frontend/runtime fence, pinned by an
admission test. No consumer cast, weakened type, clone, or consumer edit was
introduced. RedSkills remains clean at c5255e006318fa3ec9aea51ccac11778da3888a1.

The complete final-source plain/sanitized gates, remaining recorded failures
and unchanged RSP executable are still outstanding. The preserved old full
baseline remains red and cannot certify this source delta.

## Native array views across typed and dynamic calls

Rust now projects scalar/unknown arrays, recursively including arrays of
those arrays, when boxing into native dynamic values. Checked exits recover
the original typed storage when possible, or validate existing elements and
create a traced view over the dynamic source. Both directions use one source
array; a new view rechecks the current element on each read, and writes go
back to that source. No JSON conversion or copied mirror is used for this
array domain. Other composite layouts and native-to-engine conversions retain
their separately documented limitations.

Shared callable record admission now includes these array arguments/results.
The existing C/LLVM shared-callable refusal remains in effect; this is a Rust
implementation. General native array boxing benefits as well, so a library
helper receiving the same array cannot accidentally detach its mutations.

The differential witnesses exposed and repaired three representation issues:

- Native dynamic append-by-index previously inserted undefined even for an
  append at exactly length. It now writes the supplied element directly; a
  checked number/string view does not reject a fabricated intermediate value.
- Direct, union-arm and includes/indexOf array comparisons now use backing
  identity, including repeated views of one nested array.
- A literal entering a dynamic slot now constructs dynamic element storage
  directly, including empty literals and spreads. An inferred empty numeric
  fallback no longer constrains a declared unknown[] to numbers. Existing
  typed variables still retain their original storage.

Corpus 3066 tests typed factory array arguments and results, library-retained
state, indexed append, replacement and typed callbacks. Corpus 3067 tests
round trips in both directions, nested aliasing, dynamic bulk mutations,
literal/spread storage, cycles, JSON cycle rejection and heap cleanup. The
three corpus programs 3065-3067 and the focused admission/validation/domain
checks pass: 23 checks in `/tmp/scriptc-native-array-views-literal.log`. The
validation test covers an initially invalid element, nested invalid data and
a later dynamic mutation followed by a checked read and successful recovery.

The earlier failed witnesses remain in `/tmp/scriptc-factory-array-before.log`
and `/tmp/scriptc-native-array-views{,-final,-checked,-reviewed}.log`. They
distinguish the original admission refusal, identity/storage failures and
implementation iteration from the final green run.

A separate frontend gap surfaced while constructing the witness: direct
number[].fill/copyWithin and splice with insertion arguments remain SC2020.
The new corpus exercises the dynamic mutation route after Array.isArray,
which is the existing library execution path; this does not certify the
missing direct typed syntax. Direct unknown-versus-optional-array comparison
also remains fenced, so the spread witness uses an explicit checked array
exit before its identity comparison. These are compiler work, not requested
consumer rewrites.

ToonlLineEmitter still requires indexed record parameter views for push and
pushTagged. The recorded RSP spread/delete and other full-gate failures, the
complete final-source plain/sanitized gates and unchanged RSP execution remain
outstanding. No deployment, commit, push or consumer edit was made.

### Async dynamic array construction

A new witness, corpus 3068, initially failed with SC3001 for a dynamic array
literal containing await (`/tmp/scriptc-array-await-before.log`). The Rust
async emitter now admits native boxing as a suspending expression and builds
a direct dynamic array literal incrementally. It appends each element before
starting the next, snapshots each spread before a later suspension can mutate
its source, and uses the same construction in protected try/catch segments.
It does not re-emit a previously materialized whole typed array literal.

The expanded witness also exposed a nested literal wrapped in an inferred
union: its numeric storage rejected an otherwise valid dynamic string push.
Both synchronous and asynchronous construction now recognize those inline
literals through representation-only union wrappers. Existing typed array
variables still keep their backing; this change does not admit arbitrary
composite views or widen typed array writes.

Final focused validation: `/tmp/scriptc-array-await-final.log` records four
native differential witnesses (3065-3068) plus the current-element validation
API test, all passing. `/tmp/scriptc-array-await-admission.log` separately
records all 21 factory/domain checks, including C/LLVM refusal before artifact
creation. Eleven async/Promise and neighboring corpus regressions also pass
in `/tmp/scriptc-array-await-regressions.log`, including loop stress, protected
branches and finally ordering: 37 checks across these final-source runs.
Corpus 3068 covers side-effect order, nested mixed mutation, spread
snapshots, boxed await results, protected completion, rejection, and suppression
of expressions after rejection. The harness checks Node stdout, stderr, exit
status and Rust heap cleanup with allowEngine false.

The broader pre-async array run also completed: 16 checks passed in
`/tmp/scriptc-array-view-regressions.log`, covering typed JSON, array higher
order operations, checked dynamic adapters, identity and streams. TS7 order
baselines for 3066-3068 are recorded and individually verified; 3067 was checked
again after its nested-union mutation witness changed. The final build input
hash receipt is `/tmp/scriptc-array-await-build-hashes.json` (281 compiler
sources, zero mismatches). Workspace build and lint passed; lint reports zero
errors and 3115 existing warnings, and the maintained-source line ceilings
remain satisfied (`/tmp/scriptc-array-await-{build,lint}.log`).

The final-source complete plain/sanitized gates and original RSP executable
remain outstanding. The earlier frozen gate remains RED; these focused checks
do not replace it. No consumer migration, commit, push or deployment is part
of this checkpoint.

## Native scalar dictionary views

Rust now projects pure string/number-keyed dictionaries whose values are
native scalars or scalar unions, including canonical unknown slots. Typed
maps retain their existing JsMap representation. A dynamic view points to
that same map with capture-free read/write conversions, and the collector
traces its source edge. Returning through the matching typed boundary recovers
the original map; otherwise the checked view validates current entries and
rechecks each later value read. Dictionary refinement assertions now use this
boundary rather than a width copy. Nested composite dictionary values remain
outside the new admission domain.

All structural operations delegate to the source: writes, deletion, clear,
size, iteration/tombstones and namespace/null-prototype metadata. Enumeration
uses JavaScript property order without converting values. JSON visits mapped
entries and shares the source cycle identity. Value equality, union equality,
array searches and map keys use backing identity for dictionary views.
This is native storage work; the separate native/engine bridge is unchanged.

The shared factory method domain now accepts these dictionary parameters and
results. C/LLVM explicitly refuse newly shared indexed-record casts and shared
callable exits before emitting an artifact. Existing static dictionary APIs
retain their typed layouts. The source/runtime change is not a claim that
arbitrary prototypes, descriptors or composite values can cross every bridge.

Corpus 3069 covers aliasing through the typed factory and JS helpers, current
state, callbacks/method replacement, deletion, JSON, numeric key ordering and
optional reads. The admission/IR checks pass (25 checks in
`/tmp/scriptc-record-view-admission.log`). The two new dictionary corpus
programs and map validation API pass (three checks in
`/tmp/scriptc-record-view-unit-tags.log`). The API test verifies an invalid
initial entry, an invalid later mutation, successful recovery and preservation
of null/undefined values, identities and JSON behavior.

Two frontend/IR issues reached by the witness were also repaired. Dynamic
primitive keys on record-backed JS values now stringify through the existing
native conversion; corpus 3070 pins numbers, booleans, null and undefined.
The validator now accepts retagging an indexed scalar union to its
undefined-armed read result. Standalone undefined index values now use the
existing unit-only union representation, as other value positions already do;
corpus 3071 pins property presence and null-versus-undefined JSON behavior.
This keeps the existing coarse unit type model; it does not certify exact
null-only versus undefined-only rejection at a checked cast.

Corpus 3070 passed Rust differential testing. Both 3070 and 3071 pass the
C/LLVM sanitized lanes (four checks in
`/tmp/scriptc-record-view-sanitized-final.log`). The three new TS7 baselines
are recorded and verified in `/tmp/scriptc-record-view-baselines-verified.log`.
The final workspace build and lint pass (`/tmp/scriptc-record-view-{build,lint}-final.log`);
lint has zero errors and the existing 3115 warnings. The build hash receipt
`/tmp/scriptc-record-view-build-hashes.json` matches all 283 compiler inputs.
Maintained-source limits and frozen oversized-file ceilings remain satisfied.
Sixteen broader native regressions also pass in
`/tmp/scriptc-record-view-regressions.log`, covering existing indexed records,
callbacks, containers, module imports and the prior array/async slices.
Earlier failed iterations, including an invalid single-arm-union attempt,
remain in `/tmp/scriptc-record-view-{before,after,key-after,final,checked,units}.log`.

A separate existing gap remains: a bare missing-key read whose declared value
type excludes undefined can still trap when noUncheckedIndexedAccess is off.
The optional-read witness enables that existing checker option; it does not
certify the unguarded spelling or impose a consumer migration. The broader
unchecked-read contract remains compiler work.

Runtime map tests pass for lazy conversion, shared mutation, metadata,
tombstone/order behavior and cycle collection. Clippy passes on Rust 1.98.0.
The complete default runtime run is still RED: 196 tests passed and
`tcp_echo_roundtrip_over_loopback` observed client-connect before
server-connection (`/tmp/scriptc-record-view-runtime-full.log`). The exact
isolated test then passed (`/tmp/scriptc-record-view-tcp-exact.log`); that does
not resolve its ordering instability. The malformed earlier probe matched
zero tests and is not validation. No network implementation/test was changed.

Original RSP admission now clears the encoder signature and reaches
Object.entries, but its executable and the complete final-source repository
plain/sanitized gates remain outstanding. No commit, push, deployment or
consumer edit was made.

## TCP readiness ordering repair

The default runtime gate's intermittent echo ordering failure is now reproduced
without sleeps: `network.test.rs` supplies a completed loopback handshake after
the initial empty accept poll. Before the fix, the client connect callback runs
first (`/tmp/scriptc-tcp-order-before.log`). `net_socket_connect_one` now rechecks
one accept after queueing a successful non-TLS completion, preserving the
existing accept priority without an unbounded accept drain. Queueing completion
first also avoids losing that notification if an accept callback throws.

The complete default Rust 1.98.0 runtime gate passes: 198 tests, including the
new deterministic witness and the unchanged echo transcript assertion, plus
Clippy with `-D warnings` (`/tmp/scriptc-tcp-order-{runtime,clippy}.log`). Four
native differential witnesses pass with heap audit: 2695 TCP roundtrip, 2696
HTTP roundtrip, 2908 dynamic socket end and 2910 finish ordering
(`/tmp/scriptc-tcp-order-differential.log`). These checks resolve the observed
runtime failure; complete final-source repository lanes remain outstanding.
The source/evidence checkpoint is `/tmp/scriptc-native-tcp-evidence-20260908`.

## Native object union iteration

`Object.keys/values/entries` now dispatch through the active record arm of a
typed union, passing the receiver once and reusing that arm's storage and
ordered enumeration helper. The lowering was extracted from the frozen large
call/container modules into `lower-object-iteration.ts` and
`lower-object-index-iteration.ts`; both old file ceilings decreased.
Unknown-valued `Object.values` results use a native dynamic array. Scalar
values box without copying objects; unsupported fixed composite values and
accessors retain their explicit diagnostics.

The precision override now distributes values across disjoint object members.
A keyless structural type yields unknown rather than incorrectly claiming
never. Its `ScriptcObjectValue` alias resolves against concrete generic
instantiations, with declaration provenance checked against the compiler's
own override file. This preserves the existing generic router (2847) and
separate number/string instantiations in the new witness. An intermediate
inline-conditional version regressed 2847; that failure remains recorded in
`/tmp/scriptc-object-iteration-regressions.log` and is fixed in the final run.

Final verification:

- `/tmp/scriptc-object-iteration-native-final.log`: 18 passed, consisting of
  13 native differential programs and five admission/refusal checks. Corpus
  3072 covers optional hybrid records, disjoint shapes, keys/values/entries,
  single evaluation, generic instantiation and empty inputs. Corpus 3073
  preserves nested dictionary identity and mutation through an entries row,
  while row replacement leaves the original source intact. Existing record
  order, indexed records, generic aliases and the factory map view also pass.
- `/tmp/scriptc-object-iteration-sanitized-final.log`: four passed, covering
  2847 and 3072 in both C and LLVM sanitized lanes.
- `/tmp/scriptc-object-iteration-build-verified.log`: workspace build passed.
  `/tmp/scriptc-object-iteration-lint-final.log`: zero errors, 3117 warnings.
  Source line ceilings and both new TS7 baseline entries pass verification.
- Rust runtime sources are unchanged since the TCP checkpoint's 198 passing
  tests and Clippy gate.

The identity witness is Rust-only: the initial combined corpus showed C/LLVM
copying checked dictionaries (false identity, mutations absent from the
source). This is retained in `/tmp/scriptc-object-iteration-sanitized.log`.
Splitting 3073 preserves the full Rust identity assertion while 3072 tests the
shared enumeration implementation; the final sanitized passes do not certify
C/LLVM dictionary identity. Serializing `[string, unknown][]` directly also
retains an existing JSON admission fence, observed in the initial probe; that
broader JSON contract is not claimed here. Existing hybrid ordering and
optional-property-presence limitations are unchanged.

RSP now clears its spool Object.entries boundary and reaches deeper generic
flag reads. Complete original consumer execution and both complete
final-source repository lanes remain outstanding. Source, logs and both native
witness binaries are checkpointed in
`/tmp/scriptc-native-object-iteration-evidence-20260908`.

## Generic optional fields across concrete record variants

A generic constraint's optional field can be absent from some concrete record
variants while the IR still retains the full union. The existing single-record
absence handling now lives in `lower-optional-record-field.ts` and also selects
the active union arm. Present fields use reference-preserving reads and tag
conversions; omitted fields return undefined. The receiver is evaluated once,
including its side effects and exceptions. Checker-erased generic call results
can carry scalar/undefined results through the checked-dynamic representation.
The helper declines structural copies, tuples, index-signature layouts and
accessors; those retain their existing lowering paths.

Corpus 3074 covers the actual mixed BooleanFlagSpec/ValueFlagSpec pattern,
field omission/presence, mutable optional fields, separate generic
instantiations, direct reads, effectful receiver calls and a throwing receiver.
Its final extension also verifies that an optional object-valued field retains
identity and that mutation reaches the original payload. It passes Node byte
parity in Rust and in sanitized C/LLVM:
`/tmp/scriptc-generic-optional-native-final.log` and
`/tmp/scriptc-generic-optional-sanitized-final.log` (one plus two checks).
Six initial focused checks also pass in
`/tmp/scriptc-generic-optional-native.log`, including utility generics, generic
methods, the existing router and object-union enumeration. The initial
sanitized witness passed before the payload extension too.

The final workspace build, lint (zero errors, 3117 warnings), file ceilings and
TS7 baseline verification pass; receipts are
`/tmp/scriptc-generic-optional-{build-verified,lint-final,baseline-verified}.log`.
The compiler input receipt covers 292 files. Runtime sources remain unchanged
from the 198-test/Clippy TCP checkpoint. Earlier admission/debug failures and
the initial unused-import lint error remain in the retained logs.

Original RSP admission clears both ValueFlagSpec.type reads and exposes the
following coerce callback calls; it still has no certified executable. The
complete repository plain/sanitized gates remain outstanding. Source, evidence
and the native corpus binary are retained at
`/tmp/scriptc-native-generic-optional-evidence-20260908`.

## Generic record callback dispatch

`lower-generic-record-call.ts` handles a checker-narrowed generic record whose
storage still carries multiple concrete variants. One helper reads the
original closure into a tagged function value; a second invokes its concrete
signature after the arguments have evaluated. Reading the callback first is
essential when an argument replaces the original object's callback. Missing
fields remain undefined and throw a catchable TypeError if reached. No
unchecked structural narrowing or record copy is introduced. The existing
single-record path is extracted into `lower-record-field-call.ts`, reducing
the frozen `lower-calls.ts` ceiling from 9439 to 9375 lines.

Admission requires identical parameter ABIs across callable variants. Return
values can keep their exact type, retag a union or box scalar values into
unknown. Composite copies into unknown, indexed/accessor receiver layouts,
spread and surplus argument forms remain outside this helper's admission.
Computed generic receivers with a checker-any member use their concrete
stored signatures and surface supported results as checked dynamic values.

Corpus 3075 covers multiple concrete callback return types, number/undefined
returns, captured state, calls inside map, callback replacement during an
argument, effectful/throwing receivers and arguments, callback exceptions,
and exact composite return identity/mutation across distinct record variants.
The final focused run passes seven Rust differential
programs plus eight API admission checks (15 total):
`/tmp/scriptc-generic-callback-regressions.log`. The final corpus also passes
C and LLVM with sanitizers (two checks):
`/tmp/scriptc-generic-callback-sanitized.log`. The earlier native run's retry
is retained separately and is not the final verification receipt.

Workspace build, lint (zero errors, 3120 warnings), file ceilings and the new
TS7 baseline verification pass. Receipts are
`/tmp/scriptc-generic-callback-{build-final,lint,baseline-verified}.log`;
`/tmp/scriptc-generic-callback-build-hashes.json` records 294 compiler inputs.
Runtime sources remain unchanged from the 198-test/Clippy TCP checkpoint.
Source, evidence, emitted Rust and the native binary are retained at
`/tmp/scriptc-native-generic-callback-evidence-20260908`.

The original RSP's four coerce call refusals clear, exposing two inherited
raw-argument failures. It still has no certified executable. Final-source
complete plain/sanitized repository gates remain outstanding/red; these
focused results do not certify a release or performance superiority.

## Open JavaScript dictionaries and native record boundaries

An empty object literal inferred from JavaScript remains open to runtime
keys, so `types.ts` now maps it to checked dynamic storage. Treating nested
`result.options: {}` as a closed empty record had rejected legitimate indexed
writes and lost the parser's dictionary representation. The original
TypeScript empty-literal rules are unchanged and have an admission test.

`lower-open-record.ts` supports native identity comparisons between shared
record views and their dynamic source. Fixed unknown-valued record fields
now qualify for the existing shared Rust map boundary, preserving both the
outer record and its field references. The helper also deletes own data keys
of proven JS empty-literal dictionaries through a shared map view; missing
keys return true. Statement and expression positions evaluate receiver and
key once. Arbitrary dynamic receivers, array holes, custom prototypes and
property descriptor semantics are not certified by this slice.

A direct void call whose concrete declaration ends in throw and has no
valued returns can execute before the dynamic undefined placeholder. This
preserves the throwing RHS's effects without trying to box a void payload.
Arbitrary void callbacks keep their fence; the rule does not assume a
type-erased callback's hidden return is undefined.

New Rust-only no-engine corpus 3076 covers aliases, scalar/undefined/null
values, key ordering, presence, delete/reinsert, nested object identity,
receiver/key/value order and throwing RHS evaluation. Its final extension
also checks effectful delete, deletion of a missing key and a retained child
alias after removal. Corpus 3077 returns an inferred JS dictionary to a
generic TS consumer, writes through a typed alias, and checks identity.
C/LLVM explicitly refuse newly shared dictionary deletion, record identity
comparisons and unknown-field exits before writing a binary; their existing
copying conversions are not claimed equivalent to Rust.

The final focused run passes eight Rust differential programs and 20 API/IR
checks (28 total): `/tmp/scriptc-js-open-record-native-final.log`. The final
3076 extension is checked separately in
`/tmp/scriptc-js-open-record-delete-final.log`. The npm-static type bridge
and native factory boundary regressions pass 24 more checks in
`/tmp/scriptc-js-open-record-boundaries-final.log`. The established shared
corpus 1643/3070 passes sanitized C and LLVM (four checks) in
`/tmp/scriptc-js-open-record-sanitized-final.log`; this does not certify
C/LLVM support for the new Rust-only witnesses. Earlier failing native and
sanitized attempts remain in the logs.

Workspace build, lint (zero errors, 3120 warnings), source ceilings and TS7
baseline verification pass. Receipts:
`/tmp/scriptc-js-open-record-{build-final2,lint,baseline-final}.log`.
The compiler input hash receipt covers 295 files. Runtime sources are
unchanged from the 198-test/Clippy TCP checkpoint. Final successful corpus
logs report no retry; the corpus test definitions still configure a retry
even when the command line passes `--retry=0`.

Source, logs, generated Rust and native binaries are retained in
`/tmp/scriptc-native-js-open-record-evidence-20260908`. The original RSP now
has 236 failed statements and 70 runtime fences and still lacks an accepted
executable. Complete final-source plain/sanitized repository gates remain
outstanding/red. No deployment or release is certified by these focused
results.

## JavaScript array fields and shared container records

`js-array-field-types.ts` keeps inferred JS object fields such as `errors: []`,
`rest: []` and `nested: [[]]` in checked dynamic storage when their element
type still contains inference-only `never`. They must not acquire `number[]`
from the uninhabited type's numeric representation. Declared TS fields and
recognized JSDoc contextual array types retain their typed element contracts;
positive and negative string/number admission cases pin this distinction.

Shared Rust records now admit fixed array and scalar/dynamic dictionary
fields through the existing reference-preserving views. Explicit casts of
unknown to supported mixed records use the same native checked-admission
predicate as automatic conversions. Broader nested fixed-record, byte and
promise field layouts remain outside this shared-view contract. C/LLVM reject
the newly admitted unknown-field exits before binary emission. Their legacy
JSON-safe copying conversions remain available; no C/LLVM array/dictionary
identity equivalence is claimed by this change.

Rust-only no-engine corpus 3078 returns an inferred JS parser result into an
explicit TS interface. It checks array and dictionary identity, nested-array
identity, JS and TS mutation, field replacement with an old alias retained,
generic consumption and explicit checked casts. It also checks an array field
beside a fixed unknown field, including mutation through the checked alias.
The final source passes 11 Rust differential programs and 54 API/IR boundary
checks. Five established corpus programs (1593, 1643, 2038, 2430, 3070) pass
both sanitized C/LLVM lanes, for ten additional comparisons. Final successful
logs report no retry; the harness still configures one retry per corpus case.

Receipts are `/tmp/scriptc-js-array-fields-{native-final,boundaries-final,
sanitized-final,build-verified,lint,baseline-verified}.log`. Workspace build,
source ceilings, TS7 baseline verification and lint pass (zero errors, 3120
warnings). `/tmp/scriptc-js-array-fields-build-hashes.json` covers 296 compiler
inputs. Runtime sources are unchanged from the prior Rust runtime checkpoint;
this slice did not rerun Cargo tests or Clippy.

Source, logs, generated Rust and the 3078 native binary are retained at
`/tmp/scriptc-native-js-array-fields-evidence-20260908`. The final unchanged-RSP
analysis has 215 failed statements and 59 runtime fences. These focused checks
do not replace the complete final-source plain/sanitized gates, which remain
outstanding/red. The original RSP executable is still unaccepted.


## Forwarded JS arrays and native search results

A minimal unannotated TS wrapper `{ positionals: parsed.rest }` compiled
successfully but its Rust executable threw `expected number at $, got string`.
The compiler had reconstructed `number[]` from the JS field's inferred
`never[]`. The same source now executes and prints `tail`. Before/after
receipts are `/tmp/scriptc-js-array-flow-native-{before,after}.log`; the first
probe used release optimization and the repaired probe used dev optimization.
This is semantic evidence, not a performance comparison. The final corpus
checks below use the normal dev differential posture.

`js-array-field-types.ts` now follows data-field reads, variable aliases and
shorthand properties back to the JS array initializer. Supported TS forwarding
expressions keep that origin through nested array reads and `.length`, without
reconstructing a numeric array. Explicit TS annotations and unrelated TS
never arrays keep their contracts. The fallback is based on recorded data
origins and inference residue, not a general relaxation of TS diagnostics.

The same helper retains dynamic binding storage for inferred JS array
`find`, `findLast`, `pop`, `shift` and `at` results. Such arrays can contain a
real value even when the checker predicts only undefined. Dynamic array
callbacks with unannotated never parameters take the existing unknown
parameter override, and `maybeNarrow` no longer treats checker-never as proof
of a numeric dynamic payload. This also removes the reproduced internal
regex-test argument mismatch without introducing a new RegExp coercion rule.

Rust-only no-engine 3079 covers global/local results, missing matches,
find/findLast/map/some/every callbacks, at/pop/shift, heterogeneous values,
selected object identity and a throwing predicate. Rust-only 3080 covers TS
forwarding fields, aliases, shorthand properties, nested indexed reads,
lengths and writes observed through all aliases. Shared no-engine 3081 tests
evolving-array search/removal in Rust, C and LLVM; it does not exercise the
Rust-only shared record exits from 3079/3080.

Final-source focused results: 16 Rust differential programs and 58 API/IR
checks pass. Five shared corpus programs (1628, 2038, 2430, 3070, 3081) pass
sanitized C and LLVM, giving ten additional comparisons. Final successful
logs report no retry; the earlier failing 3080 run retried once and remains
in the receipts. Logs are `/tmp/scriptc-js-array-flow-native-verified.log`,
`/tmp/scriptc-js-array-flow-boundaries-verified.log` and
`/tmp/scriptc-js-array-flow-sanitized-verified.log`.

Workspace build (`/tmp/scriptc-js-array-flow-build-final4.log`), lint (zero
errors, 3120 warnings), source ceilings and the three TS7 baseline checks pass.
Lint/baseline receipts are `/tmp/scriptc-js-array-flow-lint-verified.log` and
`/tmp/scriptc-js-array-flow-baseline-final.log`. The compiler hash receipt
covers 296 inputs; runtime Rust sources are unchanged from the preceding
checkpoint, so this slice did not rerun runtime Cargo tests or Clippy.
Source, logs, generated Rust and three native binaries are retained in
`/tmp/scriptc-native-js-array-flow-evidence-20260908`.

The unchanged-RSP receipt removes six targeted diagnostics, with no new ones:
213 failed statements, 192 diagnostics and 59 runtime fences remain. The
original RSP executable and complete final-source plain/sanitized repository
gates remain unaccepted. These focused checks do not certify deployment.


## Optional arrays and scalar-union record methods

Native shared records now admit optional arrays with one supported array arm
and null/undefined units. Method arguments/results also admit scalar unions.
Arrays of records, multiple array alternatives and byte-containing callback
unions retain their fences. The runtime implementation is unchanged: existing
shared array and checked scalar conversions supply these views. Corpus 3082
pins optional fields, array/callable identity, mutation through both views,
callback replacement, optional arguments/results and thrown callbacks.

This also admits optional-array record parameters at native import boundaries.
Corpus 3083 pins the same pattern exposed by RSP's `runResidentServer`: a
module mutates an optional array and clears the caller's field after await;
replacement arrays and rejected calls remain observable. Nested callable
parameters retain their separate native import refusal, pinned by an API
test. C/LLVM retain existing callable record boxing; their shared checked
callable exits fail with SC3001 before creating output files.

The native import witness exposed an additional miscompile. After assigning
an array and calling a mutating function, `options.aliases === undefined`
answered false in Rust and true in Node. Receipt
`/tmp/scriptc-optional-flag-import-correct-path.log` reproduces the mismatch.
The checker keeps its narrowed array type across calls, and the compiler
incorrectly folded the comparison using that stale type. Strict/loose unit
comparisons and bare typeof now peel unionNarrow to inspect the stored union.
This subsumes the previous process.env special case. Corpus 3084 additionally
pins null, undefined, both comparison directions, negation, typeof, refill,
single receiver evaluation and exceptions; it passes Rust, sanitized C and
sanitized LLVM against Node. Its failing-before receipt is
`/tmp/scriptc-optional-flag-unit-before.log`.

Final-source checks pass: eight Rust differential programs (1117, 1372, 1528,
2491, 2492, 3082–3084), six admission/refusal API tests, and ten sanitized C/LLVM
comparisons (1117, 1372, 2491, 2492, 3084 in both backends). Receipts are
`/tmp/scriptc-optional-flag-native-final.log`,
`/tmp/scriptc-optional-flag-env-api-final.log` and
`/tmp/scriptc-optional-flag-sanitized-final.log`. These successful logs report
no retry; the preceding failing reproductions and their retries are retained.
Earlier checks before the predicate repair also passed 27 Rust programs,
37 API/IR checks and 12 sanitized C/LLVM comparisons; they are not counted as
final-source results.

Workspace build, lint (zero errors, 3120 warnings), source ceilings and all
three new TS7 baselines pass. The lower-exprs frozen debt ceiling decreases
from 11182 to 11151 lines after removing the duplicated env-only handling.
Receipts are `/tmp/scriptc-optional-flag-build-verified.log`,
`/tmp/scriptc-optional-flag-lint-verified.log` and
`/tmp/scriptc-optional-flag-baselines-final.log`. The compiler hash receipt
covers 297 inputs. Runtime Rust remains unchanged from the previous checkpoint;
this slice did not rerun its Cargo tests or Clippy. Source, logs, generated Rust
and three native binaries are retained at
`/tmp/scriptc-native-optional-flag-evidence-20260908`.

The unchanged RSP source now reaches 3086 statements after clearing the
resident-server import signature refusal, with 284 failed statements, 246
diagnostics and 81 runtime fences. Two old diagnostics disappear and 56
appear in newly reached bodies. Its ten shared/args diagnostics are unchanged:
literal-aware schema union conversion remains unresolved. The final receipt
is `/tmp/scriptc-rsp-after-optional-flag-final.json`. The original RSP executable
and complete final-source plain/sanitized repository gates remain unaccepted;
these focused checks do not certify deployment.


## Acyclic nested record views

Shared native records now retain acyclic nested record fields, including
optional records and record-valued method arguments/results. Storage planning
marks the nested shapes as well as the boundary shape without mutating the
common IR. Recursive layouts, arrays of records, byte fields and multi-record
union dispatch remain outside this shared representation contract; existing
unrelated lowering paths are not claimed to gain reference preservation.

The preceding compiler build refused the checked outer-record view with SC1090
(`/tmp/scriptc-nested-record-before.log`). The first implementation exposed
missing JsonDecode implementations on optional unions of shared callable
records. Shared wrappers already implement checked JSON traits, including
errors for JSON attempting to supply required callbacks. The backend now
recognizes these traits for union generation and avoids emitting the physical
construction struct's incompatible JSON implementation. Native extraction
continues to use the shared map, not a JSON round trip.

No-engine Rust corpus 3085 pins nested identity, arrays, optional method
arguments/results, callback replacement, replacement child records and
mutations visible through aliases. It also pins serialization of the existing
unknown box and checked JSON inputs with absent or invalid nested callbacks.
Direct typed JSON.stringify of callable records retains its separate frontend
refusal; the witness does not claim that surface. The final native fixture
passes byte-for-byte against Node.

Focused verification passes: eleven Rust corpus programs (1009, 3065, 3066,
3069, 3074, 3075, 3078, 3082–3085), 21 IR/storage-planning checks, and 22 final
admission/refusal API checks. C/LLVM refuse shared nested callable exits and
function adapters with shared nested parameters before creating output; scalar
callable exits retain their existing support. Four shared corpus programs
(1009, 2038, 3081, 3084) pass sanitized C and LLVM, for eight comparisons.
Logs are `/tmp/scriptc-nested-record-native-final.log`,
`/tmp/scriptc-nested-record-boundaries.log`,
`/tmp/scriptc-nested-record-admission-final.log` and
`/tmp/scriptc-nested-record-sanitized-final.log`. Successful logs report no
retry; the earlier failing admission/emission probes and retries are retained.

Workspace build, lint (zero errors, 3120 warnings), source ceilings and the new
TS7 baseline pass. Receipts are `/tmp/scriptc-nested-record-build-final.log`,
`/tmp/scriptc-nested-record-lint-final.log` and
`/tmp/scriptc-nested-record-baseline-verified.log`. The source snapshot,
297 compiler-input hashes, generated Rust and executable are retained at
`/tmp/scriptc-native-nested-record-evidence-20260908`. Runtime Rust sources
remain unchanged; Cargo tests and Clippy were not rerun in this slice.

The original clean RSP source now reaches 3327 statements (295 failed), 257
diagnostics and 81 runtime fences. The import signature refusal for
readGhConditionalJson clears, exposing twelve diagnostics in newly reached
bodies. This is a larger graph, not a like-for-like diagnostic-rate comparison.
Literal-aware FlagSpec dispatch and shared indexed-schema conversion are still
required. The original RSP executable and complete final-source repository
gates remain unaccepted; this checkpoint does not certify deployment.


The next union step must preserve both literal discrimination and live identity.
A union's declared discriminant can be retained separately from erased record
layouts, then used to choose checked shared views and dictionary values. A
one-time tag selection is insufficient: a function receiving a wider
`{ kind: string }` view can mutate the same object. Tag tests, narrowing and
identity comparisons must observe the current discriminant and shared object,
or reject the unsupported path explicitly; they must not trust an enum tag
that became stale. Pin that aliasing case before widening schema admission.

## Discriminated records and shared flag schemas

String-literal record discriminants now survive frontend mapping in optional
IR union metadata. The validator requires disjoint nonempty domains covering
all record arms. Shared Rust union extraction, narrowing, tag tests and equality
observe the current object, including discriminator mutation through wider
aliases. JSON union decoding also selects by the discriminator before checking
fields; an extra property cannot redirect a smaller arm into a larger one.

Acyclic pure dictionaries now admit shared record and discriminated-record
values. Rust replaces supported compiler-generated width/capture helper bodies
with checked shared projections, preserving both outer schema identity and
inner flag references. C/LLVM retain their ordinary helper bodies and refuse
new shared callable schema exits before output creation. Recursive layouts,
record-array views and tuple-to-array views remain outside this extension.

The first executable schema witness exposed a missing-key regression:
Object.keys on the original fixed shape omitted a key added through its
indexed alias. Shared Rust Object.keys/values/entries helpers now enumerate
current own keys in JavaScript order. Corpus 3089 additionally pins extra
fields through a narrower view, omitted versus explicitly undefined keys,
integer-key ordering, mutation and single evaluation. These are compiler
changes; no consumer annotations, casts or clones were added.

Final focused validation:

- 15 Rust differential programs: 1003, 1373, 2985, 3065, 3069, 3074, 3075,
  3082–3089. New no-engine witnesses 3086–3089 cover discriminator mutation,
  schema replacement/iteration/identity, nested JSON discrimination and width
  view enumeration. Log: `/tmp/scriptc-discriminated-schema-rust-regression.log`.
- 34 IR, registry, storage-planning and API tests, including a native binary
  with heap audit that checks invalid tags/callbacks, live map reads and JSON
  decoder failures. Log: `/tmp/scriptc-discriminated-record-unit-final.log`.
- Eight sanitized C/LLVM differential comparisons (1003, 1009, 1373, 3084).
  Log: `/tmp/scriptc-discriminated-schema-sanitized.log`.
- Workspace build, exact source ceilings, lint (zero errors, 3120 warnings)
  and new TS7 baselines. Logs: `/tmp/scriptc-discriminated-schema-build-final.log`,
  `/tmp/scriptc-discriminated-schema-lint.log` and
  `/tmp/scriptc-discriminated-schema-baselines-verified.log`.

Successful focused logs report no retry; earlier failing probes are retained.
The Rust regression log includes a `context canceled` line, but finishes with
all 15 cases passing and process exit zero. Evidence, source hashes, generated
Rust and four executables are retained at
`/tmp/scriptc-native-discriminated-schema-evidence-20260908`.
Runtime Rust sources did not change in this slice; Cargo tests and Clippy were
not rerun solely for compiler changes.

The unchanged original RSP graph now reports 3327 statements, 295 failed,
250 diagnostics and 81 runtime fences. Seven diagnostics disappear without
new diagnostics or graph growth: five schema-conversion and two parser.parse
refusals. Three args.ts diagnostics remain: heterogeneous keyed lookup and
tuple-valued aliases crossing schema/union boundaries. Optional chaining over
a multi-record union and stringify of tuple arrays containing undefined also
retain separate frontend fences; the new tests do not claim those surfaces.

These focused passes establish this representation slice, not full application
acceptance. The original RSP executable and complete final-source plain and
sanitized repository gates remain unaccepted. No deploy, release or performance
superiority over C/LLVM is certified.

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

### Isolated renderer artifact smoke (2026-09-09)

While the full plain gate remained live, the accepted Redwall renderer was
copied into a minimal Bubblewrap filesystem with its Obsidian/font assets,
explicit host system libraries, no checkout/toolchain/Node/Bun installation,
an empty environment plus explicit PATH/TZ/heap-audit variables, and isolated
network/process namespaces. Rust and the existing Bun-compiled oracle both
exit zero with empty streams and identical 108881-byte PNGs. The copied Rust
binary, assets and fixture total 4140593 bytes excluding system libraries.

The dynamic Linux x86_64 ELF requires glibc symbols through 2.35 (hypot).
This is a local relocation/dependency smoke, not a cross-distribution gate,
complete red-dev package, performance improvement or deployment acceptance.
Compiler/runtime/executable test sources were held unchanged during the full
gate; sanitized has not started. See tests/dogfood/redwall-native.md and
.red/tmp/native-redwall-portability-checkpoint-20260909/ for evidence.

### Full plain attempt 1: manifest drift repaired (2026-09-09)

The first full local plain attempt terminated with exit 1 after 67 passing
tests and two skips in the native compiler/cache suite. The next file failed
its manifest staleness guard: the generated Date constructor note now includes
local calendar components, but packages/compiler/surface-manifest.json still
carried the former description. This attempt does not accept the full gate.

Regeneration changes exactly that one entry's note. No status, backend column,
version, other entry, compiler source or runtime source changes in this step.
The source table already describes the previously implemented Date behavior;
its execution coverage remains the Date/Redwall checks recorded above.
`pnpm manifest --check` passes for all 636 entries, and the complete focused
surface-manifest suite passes 76/76 tests without snapshot-update mode.
The 337 code files in the preceding WIP checksum inventory remain unchanged.

The extensionless Redcode checker crash is independently minimized, including
a control showing that a neighboring .js file changes root resolution. That
investigation applies no frontend fix; see tests/dogfood/frontend-extensionless.md.
The next full plain attempt must run to completion, then the full sanitized
lane remains required. Evidence and WIP checkpoint:
`.red/tmp/native-manifest-gate-checkpoint-20260909/`.

### Full plain attempt 2: callback contract and missing rejection report (2026-09-09)

Attempt 2 terminates at the first npm callback test after four CLI bootstrap
tests pass, including default/explicit Rust builds from the installed CLI.
The Rust scalar boundary has included `at $` since commit 681d146cb; the
assertion still used the C/LLVM primitive spelling. The test now checks each
backend's exact message, TypeError identity, absence of callback-body output,
empty stderr and status zero. It passes on Rust and sanitized C/LLVM.

The npm runner now retains and compares stderr byte-for-byte, including
nonzero exits. Exercising the existing Commander argv matrix reveals a real
unhandled-rejection defect: for `calc.ts fail "flat tire"`, Node writes the
error and exits 1, while the Rust/V8 executable writes nothing and exits 0.
This was reproduced directly outside Vitest. The lower-level V8 wrapper has
an unhandled-rejection ledger, but its take_unhandled_rejections API currently
has no caller in the high-level runtime. No runtime fix is applied yet, and
the stricter assertion remains failing rather than hiding the missing report.

The parseAsync companion also exceeded its test's 120-second limit. Its cache
contained generated Rust and unfinished objects, with no executable. A separate
build completed in 52.827 seconds; all four Node/native argv pairs matched
stdout, stderr and status. With the shared 300-second native-build timeout,
the focused test passed in 54.765 seconds. The earlier timeout is not counted
as an application hang or compatibility refusal.
No full third attempt or full sanitized lane has started.

Independently, a generated-code-only Redwall experiment removes 35 local
handle clones from bytes_get calls and retains 38 tests/26 native byte-parity
calls. Its timing medians improve relative to the same-run control, with large
machine variability; this does not change or establish speedup of the compiler
backend. See tests/dogfood/redwall-native.md for measurements and limits.
Evidence: `.red/tmp/native-npm-boundary-checkpoint-20260909/` and
`.red/tmp/native-borrowed-reads-checkpoint-20260909/`.

### V8 orphaned rejections: reproduced and repaired (2026-09-09)

The old Commander artifact was re-run twice: its rejected async action exited
0 with empty stderr while Node exited 1. A new minimal package invokes and
drops a typed native callback's Promise. Its regression failed before the
runtime change with the same wrong exit status.

The Rust event loop now drains V8 jobs before checking either rejection
ledger, gives any queued native microtasks/nextTicks another turn, and consumes
the V8 ledger after native rejection checks. The first surviving engine
rejection prints the Rust runtime's existing `UnhandledPromiseRejection:`
diagnostic and sets the exit-failure flag. Native failures retain reporting
priority. Previously handled engine promises are removed by V8's tracker;
the documented dormant WebAssembly-stub marker remains excluded. The engine
is never initialized merely to perform a checkpoint.

The regression also exposed that native string rejection reasons became
Error objects when exported to V8. That bridge now preserves strings,
numbers and booleans. The final twelve scenarios cover orphaned callbacks, engine-only
rejection, primitive reasons, multiple/native+engine survivors, caught Error
and primitive values, and handlers attached by later engine microtasks and
the island's nextTick shim. The shim's documented nextTick scheduling remains
engine-microtask based; these tests do not claim full Node phase parity.

Rust focused validation passed all three tests: the initial 11-scenario regression
and both Commander argv matrices. Direct re-execution with Rust heap auditing
also passed all 11 scenarios and the original Commander failure. The latter
now prints exactly `UnhandledPromiseRejection: Error: cannot compute: flat tire`
and exits 1. C and LLVM each passed the final 12-scenario regression and both
Commander matrices with sanitizers. The new split distinguishes two already
settled rejections from fatal exit with another callback parked. The latter
pins C/LLVM's exact existing `scriptc RC audit skipped: 2 fiber(s) never resumed`
line rather than hiding it or calling that case a successful C heap audit.

Pinned Rust 1.98.0 validation passes 202 runtime tests, all-target Clippy with
`-D warnings` in default, V8+SQLite and Boa+SQLite configurations, and all nine
V8-wrapper tests. This broader Clippy gate found redundant conversions/closures
left in tests and island adapters by the existing string migration; they were
removed without lint suppressions. Source ceilings and forbid(unsafe_code)
remain intact. The full plain gate will recheck the final Rust regression and
the broader package matrix; neither full repository lane has been accepted.

The npm harness compares application stderr bytes, with exact native fatal
diagnostics for the two intentional unhandled-rejection cases. It excludes
only Linux ASan's exact known swapcontext advisory in native sanitized runs,
retaining all other bytes and sanitizer diagnostics. ESM fixtures now declare
their module type; two import()-only CommonJS scripts retain their original
mode explicitly. This removes Node's module-configuration warning at its source.
The existing opt-in passed-binary cleanup now also covers npm case binaries,
retaining generated sources and digest receipts, and never discarding failures.

Scope limits: this repair does not add island process event listeners (the
shared process shim still declares those inert), general arbitrary-object
rejection marshalling, or cross-engine identity preservation. These must not
be inferred from the callback/primitive cases above. Consumer sources and
installed binaries were not changed. The active goal still requires the full
gates and validation of complete consumer applications.

Logs and probes: `/tmp/scriptc-npm-boundary-gate-20260909/`. Source/evidence
checkpoint: `.red/tmp/native-v8-rejection-checkpoint-20260909/`.

### Full plain attempt 3: C size budget drift (2026-09-09)

Attempt 3 stopped after 14 passing C-island contracts at the static executable
size ceiling: 468,192 bytes versus 392,000. This occurred before the final
Rust npm regression was reached. Rebuilding the committed HEAD runtime with
the same generated entry already yields 463,728 bytes. The runtime/recipe from
the original budget commit reproduces its documented 387,600 bytes within
8 bytes. The static artifact contains no engine implementation symbols.

Both affected Linux C size budgets have been refreshed from these measurements
and now share one definition; independent optional-linkage cost checks remain.
Both focused size checks pass (2/2). This change does not reduce binary size or
change the runtime. Details, limits and reproducible recipes are recorded in
tests/dogfood/native-size-gate.md. Full plain attempt 4 and full sanitized have
not started; the deploy/trusted-complete-consumer goal remains active.

Final focused Rust revalidation after the Clippy cleanups passes all three
tests with SCRIPTC_RUST_HEAP_AUDIT=1: the complete 12-scenario rejection matrix
and both Commander argv matrices (323.739 seconds of tests). Evidence:
`/tmp/scriptc-npm-boundary-gate-20260909/rust-final-heap-contracts.log`.
This closes the specific lost-rejection reproduction, including its original
CLI trigger; it does not approve either full repository lane.
