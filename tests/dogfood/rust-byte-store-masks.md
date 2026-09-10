# Redundant low-byte masks in Rust stores

The Rust emitter removes a literal `& 255` on either side of a numeric value
stored in a u8 buffer. The store already applies ToUint8, and
ToUint8(x & 255) equals ToUint8(x), including negative, fractional, huge and
nonfinite numbers. Other masks and wider/floating destinations stay unchanged.
Shared IR is unchanged; receiver snapshots and once-only operand evaluation
are preserved, including inside mutable slice regions.

The emission regression failed before the fix. Two unit tests and differential
corpus 3128 passed against Node/Rust with heap auditing, and C/LLVM sanitized.
Workspace build, touched-source ESLint, file-line caps and diff checks passed.
Redwall passed 38 contracts (26 native invocations), with identical PNG output,
engine none and no external FFI. All 116 analyzed source hashes were rechecked.

Three-sample screening plus one warmup, alternating executable order on CPU 2:
control 3065.85 ms, masks 2680.57 ms, Bun --compile 711.30 ms. The observed
median reduction is 12.6%; Rust still takes 3.77x Bun. All 12 executions matched.
This short measurement does not establish completion of the performance goal.
The executable remains 4,059,832 bytes. No consumer source or installed binary
was changed. The full plain/sanitized gate remains unaccepted.

Evidence: `/tmp/scriptc-byte-store-20260909/` and
`.red/tmp/native-byte-store-checkpoint-20260909/`.
