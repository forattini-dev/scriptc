# Stack storage for uncaptured scalar cells

The Rust emitter previously allocated a `Gc<CellData<f64>>` for every numeric
local declared without an initializer. In Redwall's PNG unfilter loop, this
allocated a heap object for `recon` on each pixel-byte iteration.

`RustLocalCells` now distinguishes stack and shared cells for bindings forced
into a cell by statement emission. Uncaptured `number` and `boolean` locals in
synchronous functions use `std::cell::Cell<Option<T>>`. Assignments and reads
preserve the initialized state, including through catch/finally closures.
Reads still check initialization. Captured/TDZ bindings, async and generator
frames, and values with owning edges keep the existing runtime heap cell.
The storage map is reset between emitted functions and cleared after switch
scopes. No shared IR or runtime source changes are required.

Corpus 3126 covers per-iteration scalar variables, switch/fallthrough,
conditional assignment, signed zero, increments, try/catch/finally, escaping
captures and suspension/resumption. Focused validation passed 15 distinct
Rust corpora, 16 unit tests across the touched storage/byte-loop modules, and
3126 in both sanitized C and LLVM. Workspace build, source-line limits and
touched-source lint passed. Redwall passed 38 contracts (26 native calls),
with engine `none`, no external FFI, zero fences and identical PNGs to Bun.
All 116 analyzed consumer source hashes remain unchanged.

The separate LTO-only experiment is preserved in
`/tmp/scriptc-native-lto-20260909/`: it compiled the unchanged generated Rust
with `-C lto=thin`, keeping opt-level 2. Three-sample medians were 3082.85 ms
for control, 2985.82 ms for LTO and 541.66 ms for Bun --compile. All outputs
matched; this small screening gain does not solve the application gap. No
production build flags were changed from that experiment.

Stack-cell evidence is in `/tmp/scriptc-stack-cells-20260909/` and
`.red/tmp/native-stack-cells-checkpoint-20260909/`.
The full plain/sanitized gate remains unaccepted; this is a renderer
checkpoint and does not approve shipping the compiler or the original CLI.

## Screening result

Three measured samples and one warmup per executable, alternating order on
CPU 2 with the same resource limits and inputs. Medians: Bun 674.82 ms,
Rust control 3957.82 ms, stack cells 3955.82 ms.
The observed median change is -0.1%;
the new version still takes 5.86x Bun.
All 12 executions matched. This is a short screening experiment, not proof
that the end-to-end performance objective has been achieved.
