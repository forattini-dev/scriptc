# Validation contract refresh, 2026-09-10

The full plain gate completed with 6,729 passing tests and 108 failing tests.
The preserved log separates 81 explicit disk-full failures, 17 linker bus
errors, and ten failures caused by outdated test expectations. The sanitized
lane did not run, and this gate did not authorize a final Redwall benchmark.
The linker failures still require successful reruns; their timing alongside
disk exhaustion is not proof that every one has the same cause.

Five recently added corpus entries had no recorded frontend baselines.
Their source dependencies and diagnostics were reviewed, and their records
were added without changing existing records. The WASI driver test now pins
both the already implemented getpid emulation macro and its link library.
The old engine membership fence test now checks present, absent and inherited
properties, including empty stderr and a successful exit. These expectations
passed in isolated plain and sanitized runs, with membership output also
checked against Node.

The native-import admission suite still rejected six signatures supported
by shared record views and one wider record containing an array. The tests
now require successful admission for those exact inputs. Existing refusals
for unsupported array exports, namespace hooks and record unions remain.
Corpus 3169 checks nested object identity, typed dictionary arguments and
results, asynchronous record results and array mutations, and preservation
of a wider record's array through a narrower parameter. Its native output
matches Node. The frontend baseline lists only the entry because its module
dependency is imported dynamically.

An exploratory expression that reads a dictionary property directly from an
imported function call still produces SC1090. That rejected shape is preserved
separately in the evidence; the execution witness uses a local variable for
the returned view. This checkpoint does not claim that all record expressions
or all native imports are supported.

After disk cleanup, offline compilation initially failed because Cargo's
registry cache no longer contained chrono. Fetching the locked dependencies
restored the cache; the focused Rust dynamic-call regression then passed.
The remaining disk-affected tests and both full validation lanes still need
to pass before the updated Redwall binary receives its final timed comparison.

Evidence: `/tmp/scriptc-consolidation-gate-20260910f/failure-inventory.json`
and `/tmp/scriptc-order-baselines-20260910f/`, including the isolated baseline
review, plain/sanitized contract logs, native-import execution witness,
rejected direct-call property expression and Cargo-cache recovery logs.


## Coverage execution profile correction

The next full run exposed five coverage test failures, reproduced separately.
Three snapshots lacked the default Rust execution profile. The lazy-builtin
snapshot still treated http2 as unavailable, although the existing fixture
now loads its shim and preserves _http_agent as the unused lazy trap.
The CLI test wrongly expected success from an external host runtime blocker;
the existing coverage-exit contract requires status 1. Repeatable declarations
now have both cases pinned: runtime values remain SC1010/status 1, while
imports used only as types give fully static coverage/status 0.

Reviewing the dynamic JS snapshot exposed an actual reporting bug: a program
with engine none was described as running in an embedded engine. The report
now uses the execution profile to describe the native dynamic runtime when
no JavaScript engine is required. Statement counts and backend selection are
unchanged. The original JS fixture compiled with Rust, dynamic mode and
--no-engine; its stdout, stderr and exit status matched Node exactly.

The focused coverage and CLI exit suites passed 31 tests. Their whole-corpus
coverage sweep was deliberately left to the full validation, not counted as
passed. Full run G was interrupted after reproducing its five failures; its
remaining modules and sanitized lane are unvalidated. A new complete run is
required before the final benchmark. No consumer sources were modified.

Redwall acceptance G passed all 38 contracts, including 26 native render calls
with Bun byte parity. Its 117 source inputs and original artwork/font bytes
were rechecked after restoring deleted temporary adapters/assets from exact
checkpoint or consumer copies. This acceptance is separate from final timing.
Evidence: /tmp/scriptc-coverage-correction-20260910g/ and
/tmp/scriptc-boundary-redwall-20260910g/.
