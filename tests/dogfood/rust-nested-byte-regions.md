# Reusing slices across nested byte regions

A fresh output inside another mutable byte region could read the outer
output. Input admission then borrowed its original Gc storage a second time,
while the outer mutable slice was live. The old compiler reproduces
`RefCell already mutably borrowed` with exit 101 and no stdout on corpus 3131.
The failing executable, stderr and emission regression are retained.

Input admission now excludes bindings already active in this function's
region map. Their reads reuse the existing emitted slice. This also avoids
redundant nested read borrows, while ordinary external inputs retain their
read-only admission checks. The outer mapping remains live after the inner
region finishes. No runtime change or unsafe access was introduced.

The regression and corpus failed before the fix. Six selected unit tests and
four Rust corpora (3127, 3128, 3129, 3131) pass with heap auditing. Corpus 3131
also passes C and LLVM sanitized. Tests cover two and three levels of fresh
buffers, reads from both enclosing buffers and writes after inner regions.
Touched lint, file-line caps and whitespace checks pass. The workspace build
and application acceptance will be refreshed with the next emitter step;
this focused checkpoint is not a full compiler validation or shipping gate.

Evidence: `/tmp/scriptc-nested-byte-regions-20260909/` and
`.red/tmp/native-nested-byte-regions-checkpoint-20260909/`.
