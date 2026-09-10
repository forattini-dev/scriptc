# Console messages from thread-instanced libraries

The 2026-09-10 full plain gate exposed interleaved initialization output in
the CB7 host-callback probe. Two independent library instances wrote
`callbacks readycallbacks ready\n\n` instead of two complete lines. The
existing executable reproduced this in 6/100 C runs and 7/100 LLVM runs.

The C runtime formatted each message with separately locked stdio calls.
Thread-instanced libraries now hold the host stream's recursive stdio lock
through formatting, newline and flush. POSIX uses flockfile/funlockfile;
Windows uses the CRT's _lock_file/_unlock_file. Locks are not nested across
stdout and stderr. This applies only with SCR_LIB and SCR_THREAD_INSTANCES;
ordinary executable builds and the Rust runtime retain their existing path.

The new runtime probe yields between real formatter writes to exercise
mid-message scheduling. It verifies complete numeric/boolean/negative-zero
lines on both streams, allowing thread order to vary. It failed before the
fix and passed afterward. The original CB7 assertions, including exact
output, thread identity, channel routing and poison isolation, are unchanged.

Validation: 33 focused tests passed, including the original C/LLVM callback
suite and live-output contracts. Three sanitized tests passed, including
the new runtime probe with AddressSanitizer and UndefinedBehaviorSanitizer.
The rebuilt original probes passed 100 repetitions per backend, comparing
their complete stdout, stderr and exit status. Maintained line limits,
whitespace checks and focused ESLint passed. Zig cross-compiled the console
translation unit to a Windows x64 COFF object, checking the CRT lock APIs;
this is not a Windows execution test. Full plain/sanitized gates are pending.

Gate B also exposed WASI tests that expected LLVM while leaving the backend
implicit. Rust is the default. These tests and their CLI invocation now
select LLVM explicitly; a separate assertion preserves the default Rust
target refusal. This does not add Rust WASI support or automatic fallback.
The corrected WASI file exposed separate missing-libc target guards and
allocator accounting problems. Its 67 tests now pass; see
[native-wasi-portability.md](./native-wasi-portability.md) for the separate
diagnosis and validation. Full repository gates remain pending.

Evidence: `/tmp/scriptc-callback-stdio-20260910/`. `red-runtime.log` records
the formatter regression; `green.log`, `sanitized.log` and
`fixed-repetition.json` record the passing checks. The first `red.log`
attempt stopped on an existing header warning promoted by an extra Werror
flag; it is not the behavioral reproduction. The final probe uses the
same Wall/Wextra convention as neighboring runtime tests.

Full gate B was intentionally stopped after these confirmed failures;
its before/after source fingerprint matched. Its logs remain under
`/tmp/scriptc-consolidation-gate-20260910b/`. Current Redwall performance
evidence remains separate and does not imply full repository acceptance.
