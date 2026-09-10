# TS7 lifecycle and native closure gate (2026-09-09)

This checkpoint addresses compiler reliability and the verification backlog.
It does not accept the complete plain/sanitized gate or the complete consumer
applications. Work remains isolated in the rust-effect-native worktree.

## Shared TS7 hosts retained disposed programs

The native API documents that openProjects is reference-counted and persists
across snapshots until closeProjects. Ts7Program.dispose released only its
snapshot. Consequently a reused Ts7Host retained every synthetic project and
its compiler-owned virtual tsconfig. The long baseline audit accumulated
memory and repeatedly crossed the limiter's 2 GiB memory-high threshold.

The regression test queries the real server inventory: before the fix, the
first project remains listed after disposal. After the fix, only its live
sibling remains. That sibling still answers source and semantic queries; a
subsequent program works, repeated disposal is harmless, and the final project
inventory is empty. Program disposal now closes its project through a new
snapshot, releases that snapshot, and removes only that synthetic config.
Closing a host clears its virtual overlay. Live sibling snapshots are preserved.

The lifecycle and facade suites pass 21 tests. The complete read-only audit
then finishes 1,731 entries with no crashes: 1,362 unchanged baseline records,
367 absent records and two reviewed existing deltas. GNU time records
560,672 KiB peak RSS and 11m18s elapsed under one CPU quota with Nice=19 and
GOMEMLIMIT=1GiB. This is an audit observation, not a controlled speed benchmark.
At entry 800 the TS7 server RSS was 89,884 KiB and the entire cgroup used
543,256,576 bytes with zero memory-high/max/OOM events. The original partial
run and its throttling investigation are retained; no percentage reduction
in general compilation cost or native application RAM is claimed.

## Generic closures must belong to their enclosing specialization

Reviewing removed diagnostics exposed a real failure rather than merely a
stale snapshot. Calling the same generic factory with number and string
captures produced SC9001: familyClosure capture "x.0" is not boxed. The family
registry keyed implementations only by AST node; a second specialization
reused the first specialization's capture sources and skipped boxing its own
locals.

The registry now keys by AST node and enclosing FnCtx. Each specialized frame
gets its own implementation and capture layout. Corpus 3120 pins both outer
capture types, multiple calls of one specialization with independent captured
values, and an immediately invoked generic arrow. Rust matches Node byte for
byte. Existing generic value, closure family, ordinary closure and computed
tuple-length cases also pass the focused Rust comparisons.

C and LLVM explicitly do not implement genericFunc/familyClosure. The attempted
sanitized comparisons reproduced that existing limitation on corpus 2986 and
the new 3120. Both now carry the established @rust-only directive. This is a
backend scope declaration, not sanitized validation of the Rust feature.
Rust comparisons retain heap auditing; the runtime remains forbid(unsafe_code).

## Baselines and diagnostic expectations

The original 16 failed tests were chunks that stopped on the first failed
entry. The canary now uses soft assertions to report all baseline mismatches
within a chunk, preserving failure status. Missing records still fail; they
do not get silently created. Its description distinguishes the original 5.9.3
records from later reviewed native records.

The audit added 367 records and a separate scoped check added corpus 3120:
368 additions in this step, no removals, exactly two existing records changed.
The nonempty new records were reviewed explicitly: the Bun SQLite fixture is
refused under the canary's default Node target; the JSON require diagnostic
fixture retains its two SC1012 refusals. All other new records have empty
preflight diagnostics. These preflight records do not prove native execution
of every fixture.

The two existing deltas are narrow:

- module-out-of-scope removes only the obsolete node:v8 import refusal; all
  remaining structured diagnostics and module order are unchanged.
- import-fences uses inspector, which still has an import fence, instead of
  v8, whose uses now trap at runtime. Its coverage contract remains four
  statements, three static, one grouped SC1010 blocker with two sites.

The old cycle-window-call fixture was a newly supported safe recursive call.
Corpus 3119 preserves that program as a Node/native differential. The negative
fixture now actually reads a lexical offset before initialization: Node throws
ReferenceError, and the compiler retains the original SC1016 snapshot. Rust
passes the positive case; C and LLVM also pass it with sanitizers.

The broad diagnostic run reported 110/117 passing and seven failures. Five
snapshots were reviewed individually: the child-process overload text includes
spawn; record component failures retain the intentional slot-specific SC2009
introduced by 827f89142; duplicate generic diagnostics are removed while their
primary refusals remain; the newly admitted closure/IIFE and computed tuple
length operations have native differential evidence. The closure capture bug
was fixed before retiring its old refusal. Only these five snapshots were
updated, and the final verification runs without update mode.

Two diagnostic fixtures remain to be reconciled with their now-admitted
behavior: dynamic-import/main.ts and ns-import-object/main.ts. Their successful
compilation is recorded, not rewritten into fake failure snapshots. Acceptance
of their supported operations and the appropriate replacement of their former
refusal contracts remain next-step work. Full plain/sanitized gates and the
remaining consumer blockers are still outstanding.

## Evidence

Working receipts: /tmp/scriptc-preflight-audit-20260909/.
Persistent checkpoint: .red/tmp/native-ts7-lifecycle-checkpoint-20260909/.
They include the before/after lifecycle test, audit data, scoped baseline
review, the failing and passing generic closure reproductions, diagnostics,
resource observations, source hashes and native Redwall acceptance receipts.

The runtime source was not changed by this step. Redwall acceptance checks
38 existing tests with 26 real native renderer calls and Bun byte parity;
this remains a component contract, not acceptance of the entire red-dev app.

## Final focused verification

The default preflight/order canary passes 32/32 tests (585 entries). The read-only
full audit above plus the scoped 3120 record covers all 1,732 current entries;
this is not a full native differential or a complete repository gate.

Build and lint pass with zero errors and 3,122 existing warnings. The final
sanitized selection passes 13 tests: the five reviewed diagnostic snapshots
and four corpora on each of C and LLVM (1560, 2020, 2031, 3119). Closure family
corpora 2986/3120 are correctly absent from those legacy lanes; both pass Rust
with heap auditing, along with the ordinary closure regression 962. Earlier
focused Rust checks also pass 1950, 2020 and 3093.

The final rebuilt Redwall again passes 38 consumer tests with 26 native calls
and exact Bun PNG parity. Its receipt reports engine none, externalFfi false
and zero runtime fences. Generated Rust SHA-256 remains
5cca69a54a2872e389484fba59dee03feda20b5be8037d66b1680b0b4a095bc7.
The runtime source hash matches the preceding numeric checkpoint, and consumer
source hashes still match the acceptance inventory. This frontend change
therefore makes no new renderer-speed claim. No consumer source or installed
binary was replaced.


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
