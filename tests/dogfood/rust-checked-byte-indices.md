# Checked byte index fast path

Byte reads/writes now validate a float index with a saturating usize cast,
an exact round trip and the view-length bound. This replaces fractional and
finite checks plus a separate Gc metadata borrow. NaN, infinity, negative and
fractional values still trap; negative zero indexes zero. The length check
rejects usize saturation before the potentially rounded usize-to-f64 value
can be accepted. Reads and writes borrow metadata once. No unsafe code or
unverified indexing is introduced; typed conversions and aliases are unchanged.

The runtime passes 207 tests and all-target Clippy on 1.98.0. The new property
test compares 814,765 cases with the original rule, including every exponent,
both signs, mantissa boundaries, random binary64 patterns and wide usize
lengths. Failed writes preserve backing storage in the view-bound test.
Fifteen focused Rust corpora pass with heap auditing. The renderer passes all
38 contracts (26 native calls), engine none, no external FFI, zero fences.

Three-sample screening, same executables/input/assets, CPU 2, alternating
order and one warmup: control 3615.26 ms, new
3296.33 ms, Bun --compile 631.09 ms.
Observed median change -8.8%;
still 5.22x Bun. All 12 outputs matched.
This is a screening result; the performance objective is not achieved.

Artifact hash: `1a83fcebecbfb27dde0bc36c3947531bc8180649e6bdebe04d9b6f0fd29727ec`.
Evidence: `/tmp/scriptc-byte-index-20260909/` and
`.red/tmp/native-byte-index-checkpoint-20260909/`. The full gate remains
unaccepted; the original consumer CLI has not been installed or approved.
