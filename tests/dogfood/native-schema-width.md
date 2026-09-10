# Prefer a unique structural schema conversion

Checkpoint on 2026-09-10 in `rust-effect-native`, HEAD `143bd19c` plus WIP.

Corpus 2852 was refused by C with SC3001 because the frontend converted a
boolean-only flag through a dynamic check of the whole callable flag union.
When exactly one union arm has a structural width plan, lowering now uses
that existing adapter and union wrapping. Ambiguous conversions retain the
discriminator check. C/LLVM callable-record admission guards are unchanged.

Rust width adapters retain shared storage. A frontend-only change initially
broke live discriminator reads after alias mutation: the other union arm
remained statically represented. The planner now records record-to-union
wrapper dependencies and propagates shared storage through the completed
graph, independently of IR discovery order. Unrelated records stay typed;
shared IR metadata is not mutated.

Corpus 3163 reproduces alias writes, tuple aliases, fields outside a narrowed
view, a changed discriminator, and invocation of the resulting native
callback. It runs with no JS engine. Two validated IR tests check both
boundary/wrapper discovery orders; the previous planner failed one order.

## Validation

- Final Rust differential/unit selection: 26 passed, including 2852, 3163,
  discriminated-record neighbors and callable-record admission tests.
- Entire shared-record planner unit file: 5 passed.
- C/LLVM original 2852: 2 plain and 2 sanitized tests passed.
- Compiler build and focused ESLint passed with no reported warnings.
- Actual Ts7Host preflight for 3163 recorded without diagnostics.
- Exact frozen line counts and `git diff --check` passed independently.

Correction to prior receipts: the line-count checks for the 3160, 3161 and
3162 checkpoints had failed, but chained shell commands hid their status.
Those receipts now record the failure. Reviewed extractions reduced
lower-exprs to 11099 lines and lower-stmts to 8018; their frozen debt entries
were reduced here. This does not change the earlier test/build results.

Evidence: `/tmp/scriptc-schema-cast-20260910/`. Valid red evidence is in
`rust-retag-valid-red.log` and `planning-order-valid-red.log`; initial probes
with invalid TS/IR are not regression evidence. Full plain/sanitized gates
and the current-source Redwall/Bun benchmark are still pending.
