# WASI validation after the Rust-default transition

The 2026-09-10 full gate exposed WASI fixtures that expected LLVM while
implicitly selecting the default Rust backend. The fixtures and CLI probe
now explicitly select LLVM; the CLI also pins its Node 24 runtime semantics.
Captured stdout, stderr and exit codes remain compared without filtering.
A separate test confirms that the default Rust backend refuses WASI rather
than silently selecting another backend. Rust WASI support is not added.

Once those tests reached the compiler, the WASI sysroot rejected realpath,
chmod and DT_SOCK references in the shared C runtime. Target guards now
keep those references out of WASI builds. Unsupported static realpath and
permission-changing calls receive SC3002; dynamic runtime calls fail instead
of pretending success. Executable metadata uses the guest argv[0] spelling
because WASI exposes no host executable path. Platforms without DT_SOCK
retain the existing directory-entry fallback. Linux's preprocessed
scr_lib.c is byte-identical before and after these guards.

The driver also opts into wasi-libc's documented getpid emulation using
both its macro and link library. This is a placeholder process identifier,
not the host PID. Native compiler flags are unchanged.

## Stable allocation accounting

Four embedded npm programs produced their expected output but aborted in
QuickJS's js_free_rt during teardown. A temporary allocation ledger found
that the size reported for live allocations increased before free/realloc.
The accounting guard remained enabled throughout the investigation.

A standalone WASI C reproduction, without scriptc or QuickJS, observed a
9-byte malloc request whose usable size changed from 12 to 24 after a
neighboring allocation. Zig 0.13's wasi-libc emmalloc attempt_allocate
explicitly expands the previous used region to align the next allocation.
Consequently, malloc_usable_size is unsuitable as a stable accounting
callback for this allocator.

The WASI island allocator now stores the requested payload size in an
aligned private header. Its size callback stays stable until realloc/free.
Allocation, zero-filled allocation, growth, shrinkage, overflow rejection
and free preserve their contracts; failed realloc keeps the original block.
The counting allocator still releases its underlying allocations normally.
The adapter is selected only for WASI. Linux's preprocessed scr_island.c
is byte-identical to its previous implementation; the Rust runtime is
unchanged. Temporary QuickJS diagnostics were removed by restoring the
exact vendor bytes saved before this investigation, including the existing
module-link diagnostic patches.

## Validation

- All 67 tests in the WASI differential file passed, including the four
  npm teardown cases, pending-module exit precedence, the CLI probe,
  pointer-width-sensitive objects, async functions and generators.
- The allocator contract passed on the host with AddressSanitizer and
  UndefinedBehaviorSanitizer, and as an actual WASI module. Both builds
  explicitly keep assertions enabled; the C fixture rejects NDEBUG.
- The new unit harness first failed before reaching C because test.each
  did not supply the assumed context argument. Its next WASI build caught
  assertions disabled by Zig's optimized configuration. Neither failure
  is counted as the behavioral reproduction or as a pass.
- Maintained source-line limits and whitespace checks passed. Full
  plain/sanitized repository validation and the updated workspace build
  remain separate requirements.

Evidence: `/tmp/scriptc-wasi-portability-20260910/` holds target-guard
baselines, snapshots and preprocessed-source identity. The final allocator
investigation is in `/tmp/scriptc-wasi-teardown-20260910/`:
`malloc-drift.c`, `malloc-drift.log`, `diagnostic.log`, `ledger.log`,
`host-preprocessing.json`, `green.log`, `final-wasi.log` and
`allocator-final.log`. In final-wasi.log the complete WASI file passed;
the combined invocation exited 1 only for the new unit fixture's disabled
assertions. allocator-final.log records that fixture passing afterward.

These changes close validation failures in the legacy C/LLVM WASI path.
They do not change the TS-to-Rust renderer optimizations or establish
performance beyond the separately measured Redwall workload.
