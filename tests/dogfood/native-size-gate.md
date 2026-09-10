# Native C size budgets: reproducible rebaseline (2026-09-09)

Full plain attempt 3 stopped after 14 passing tests because the C hello-world
executable measured 468,192 bytes against a 392,000-byte ceiling. No Rust
size claim follows from this C-lane failure. The same ceiling also fails
against the committed HEAD runtime, before the current WIP.

All measurements below use Linux x86_64 and Ubuntu clang 18.1.3, release -O2,
without sanitizers. Executables are unstripped; source/path strings and symbol
tables can produce small size differences across output locations.

| Runtime/build | Executable bytes | text reported by `size` |
|---|---:|---:|
| Runtime when the ceiling was set, 297c6812 | 387,608 | 323,600 |
| HEAD runtime, 143bd19c, current driver | 463,728 | 389,100 |
| Current WIP runtime, current driver probe | 468,200 | 392,108 |
| Current island-suite static fixture | 468,192 | 392,108 |
| Current regex-suite regex fixture | 629,072 | 533,039 |
| Current island-suite engine fixture | 1,795,224 | 1,607,135 |

The historical probe extracts the original runtime and uses its nineteen-source
compile recipe from 297c6812. Its entry differs from the current generated C
only by restoring `return 0`, the original emitter's static exit spelling;
`scr_process_exit_code_get` did not yet exist. It prints `hello world\n` and
exits 0. Its size reproduces the old documented 387,600 bytes within 8 bytes.
The HEAD and WIP probes use exactly the same current generated C and actual
`compileC` driver, selecting extracted runtime sources through the existing
`SCRIPTC_TEST_RUNTIME_SRC_DIR` seam. All successful probes print the same output.
The historical runtime cannot be compiled directly with the current source
list: scr_dtoa.c and scr_ffi.c had not been added yet. That unsuccessful probe
is retained and is not counted as a historical build result.

`nm` inspection of the current static binary finds no JS_NewRuntime, JS_Eval
or lre_compile implementation. The scr_island_* function-pointer hooks present
in the static runtime do not contain an engine. Historical symbol comparisons
show added/expanded numeric formatting and parsing, UTF-16 string operations,
URL parsing, Date local-time conversion, and other always-linked C runtime
services. Individual symbol deltas are not a causal byte accounting: inlining,
renaming, data and alignment also contribute. The WIP-versus-HEAD text delta
is 3,008 bytes, with Date component conversion and dynamic numeric coercion
among the additions; the much larger old-ceiling drift predates this WIP.

The two suites now share Linux ceilings of 476,000 bytes for the base runtime
and 637,000 for regex, leaving about two ELF pages above measured artifacts.
The island test also requires an engine-versus-static gap greater than 500 KB;
the regex test retains the absence of regex references in emitted C and
requires a regex-versus-static gap greater than 100 KB. No Darwin ceiling
was changed or revalidated. These are refreshed regression budgets, not an
optimization, a size reduction, or approval of the full repository gates.

Focused validation of both updated size tests passed (2/2). The final Rust
12-scenario rejection regression and both Commander matrices also pass with
`SCRIPTC_RUST_HEAP_AUDIT=1`. Both full plain/sanitized gates remain pending.

Recipes, binaries, command lines, hashes, symbol deltas and before/after logs:
`/tmp/scriptc-native-size-audit-20260909/`. Persisted evidence:
`.red/tmp/native-size-gate-checkpoint-20260909/`.
