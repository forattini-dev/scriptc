# Rust: prototype membership and typed engine boundaries

The Redwall optimization consolidation exposed two Rust corpus failures in
the complete 1,572-program sweep on 2026-09-10. The sweep produced 1,570 passing
programs; the full repository lane was then intentionally interrupted to
integrate the reproduced corrections. That run is not a passing full gate.

## Corrections

- Native `in` checks now follow the live prototype chain. Own-property checks
  remain separate. Corpus 3165 covers inherited fields, late additions with
  `undefined` values, shadowing, and two prototype levels. This additional
  regression was reproduced independently while the full sweep ran.
- The generic `Promise<any[]>` bridge accepts engine array handles as well as
  native arrays. It checks the engine array brand and reads indexed elements
  as handles rather than serializing them. Original corpus 2633 and reduced
  corpus 3166 cover fulfilled and empty arrays.
- JSON-compatible shared-record casts accept engine values through the existing
  typed input conversion. Optional shared records use the same conversion.
  Original corpus 2963 and new corpus 3167 cover asynchronous callbacks and
  absent values. This is a typed boundary copy; it does not establish live
  aliases across the record cast.
- The new membership case exposed C's existing runtime fence for `in` on
  engine objects. C and LLVM now use the runtime membership operation for
  engine-held and typed-reference receivers. QuickJS answers inherited
  presence directly, and the may-throw classification propagates proxy trap
  exceptions for computed keys. Corpus 3168 and explicit C/LLVM harness tests
  cover both literal and computed keys, missing properties, and throwing traps.

Each regression was reproduced against the unchanged compiler and passed
against an isolated corrected compiler before integration. The probes compare
Node and native stdout, stderr, and exit status, with the Rust heap audit
enabled. All nine initial focused Rust cases passed after integration. After
the C/LLVM correction, corpus 3165 passed all three backends; the proxy corpus
and explicit emitter tests also passed all three. Four C/LLVM membership and
promise tests plus both explicit proxy tests passed with sanitizers. ESLint
reported no errors, and the source line limits and diff checks passed.
Complete plain/sanitized repository gates remain required; the isolated and
focused tests do not substitute for those gates.

Evidence directories:

- `/tmp/scriptc-prototype-membership-20260910/`
- `/tmp/scriptc-promise-crossing-20260910/`
- `/tmp/scriptc-async-callback-record-20260910/`
- `/tmp/scriptc-engine-membership-20260910/`
- `/tmp/scriptc-consolidation-gate-20260910e/intentional-interruption.json`
- `/tmp/scriptc-final-gate-inputs-20260910f/`

These corrections change compiler-generated code and the C runtime. The Rust
runtime and Redwall consumer are unchanged. The final Redwall benchmark must
use the accepted executable from the final build and preserve the original 4K input and compiled Bun
comparison. Earlier timings must not be attributed to a newly hashed binary.
