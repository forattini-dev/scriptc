# Elide unobserved generic bindings without losing effects

Checkpoint on 2026-09-10 in `rust-effect-native`, HEAD `143bd19c` plus WIP.

Corpus 2593 crashed the LLVM emitter on a generic function value that the
program never reads. Previously its type was unmappable, so the frontend's
dead-binding rule removed the declaration and pure writes. The new
`genericFunc` representation bypassed that rule and unnecessarily materialized
the function. The same program's actually called generic bindings can already
monomorphize normally.

The frontend now applies the existing whole-program dead-binding proof to
generic families as well as unmappable types. It still requires a pure or
absent initializer, no reads or exports, and pure standalone assignments.
Concrete mapped types retain their previous path.

The standalone-assignment requirement matters: `const kept = (target = fn)`
observes the assigned function even if `target` itself is never read. The
first broadening wrongly removed `target`, and new corpus 3162 reproduced a
missing-binding refusal. Keeping storage for assignments used as expressions
restored the program. The fixture also verifies that an unused function value
created by a call, and an unread assignment with a call on its right side,
preserve their creation effects. It runs as Rust without a JS engine.

## Validation

- Original 2593 passed in Rust, C and LLVM after the initial correction.
- Final source: Rust 2593/3162 passed (2 tests); C/LLVM 2593 plus adjacent
  generic binding/alias fixtures 2020/2551 passed (6 tests).
- Compiler build and focused ESLint passed; existing lint warnings remain.
- New 3162 preflight baseline is recorded from the real Ts7Host, with no
  diagnostics.
- Final sanitized C/LLVM: the same 6 differential tests passed.

Evidence: `/tmp/scriptc-generic-inert-20260910/`. `llvm-red.log` and
`analyze-red.log` reproduce the original failure and type change;
`observability-red.log` records the assignment-result counterexample;
`rust-observability-green.log` and `c-llvm-final.log` validate the final source.
No broad first-class generic support for C/LLVM is claimed; unobserved values
are eliminated before emission. No new Redwall benchmark was run. Full plain
and sanitized gates and the current-source paired Bun comparison remain
pending.
