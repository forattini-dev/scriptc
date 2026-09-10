# Read-only input regions in the Rust backend

A fresh-output byte region can now borrow stable u8 input storage for the
whole loop. A bounded structural effect analysis checks the loop and direct
callees. Writes are allowed only to the isolated output and local scalar
bindings. Unknown IR, indirect/captured/recursive/async calls, shared writes,
input reassignment and input declarations inside the loop retain ordinary
reads. Callees are checked by their bodies, never application-specific names.

Multiple inputs may alias: immutable slice borrows are compatible. Runtime
backed views use an optional-slice fallback to the original getter, with no
copying or unsafe code. View offsets, bounds and operand evaluation remain
checked. Inlining permits the application optimizer to specialize the small
optional-slice helpers. Three Redwall loops use this path: PNG unfilter,
RGBA conversion and output filtering (12 static checked read call sites).

Validation: 16 Rust differential corpora with heap auditing and 15 distinct
unit tests across focused runs; corpus 3129 passed C and LLVM sanitized.
The runtime passed 213 tests and all-target Clippy on pinned Rust 1.98.0.
Workspace build, touched lint, line caps and whitespace checks passed.
Redwall passed 38 contracts, including 26 native calls with identical PNGs.
All 116 analyzed source hashes were rechecked. Engine none; no external FFI.

Three-sample screening plus one warmup per executable, alternating order on
CPU 2: Rust control 2472.81 ms, read regions 2191.62 ms, Bun --compile 693.58 ms.
Observed median reduction 11.4%; Rust remains 3.16x Bun. The new binary won
all three paired rounds; host variation remains substantial. All 12 outputs
matched. The executable is 4,063,256 bytes. These are screening measurements,
not proof that the performance objective or full validation gate is complete.

An initial acceptance build began while compiler dist was still stale. Its
artifacts are retained as stale-dist-redwall and excluded from performance
claims; the accepted build was started after the workspace build completed.
No consumer source or installed binary was changed.

Evidence: `/tmp/scriptc-byte-read-regions-20260909/` and
`.red/tmp/native-byte-read-regions-checkpoint-20260909/`.
