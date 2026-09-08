# Native repository gate follow-up

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

Current local run evidence is in `/tmp/scriptc-redwall-full-gate.json`,
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
| Deferred catch-binding class failures | Two JS class-deferral cases fail compilation with constructor-assigned fields shadowing methods. Unresolved. |
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
