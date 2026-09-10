# Signed conversion for checked byte indices

For lengths at most isize::MAX, byte indexing now uses a safe saturating
isize conversion followed by the length check and an exact f64 round trip.
Negative signed results become unsigned values above the admitted length.
Positive saturation fails the strict bound before a rounded round trip can
be accepted. Wider hypothetical lengths retain the original usize path.
This avoids unsigned conversion overhead without dropping bounds or integral
checks. Negative zero still indexes zero; fractions and nonfinite indices
keep their previous behavior. No unsafe code is introduced.

The isolated candidate matched 914,032 value/length combinations and won all
six microbenchmark rounds. Before changing the runtime, the independent
finite/fractional/bounds reference was expanded around isize saturation and
wide lengths; its 1,047,717 cases passed before and after implementation.
The runtime passes all 214 tests and all-target Clippy on pinned 1.98.0.
Ten focused Rust differential corpora pass with heap auditing. Line limits
and whitespace checks pass; compiler TypeScript and C/LLVM are unchanged.

Redwall passes 38 contracts with 26 native calls and identical PNG output.
Engine none, no external FFI, zero fences. Generated Rust is byte-identical
to the previous candidate; all 116 consumer source hashes were rechecked.
Three-sample screening, one warmup and alternating executables on CPU 2:
control 2066.65 ms, signed indices 1735.48 ms, Bun --compile 712.45 ms.
Observed median reduction 16.0%; Rust remains 2.44x Bun. All 12 executions
match output. The binary is 4,061,968 bytes, 2,016 bytes smaller than control.
This screening result does not establish completion of the performance goal.

Evidence: `/tmp/scriptc-signed-index-20260909/` and
`.red/tmp/native-signed-index-checkpoint-20260909/`. No consumer source or
installed CLI was changed. The full plain/sanitized gate remains unaccepted.
