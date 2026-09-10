# Mutable byte slices for non-escaping allocations

A freshly allocated, uncaptured const Uint8Array can now lend its storage
for a complete for-loop. Admission checks every use of that local: only
get/length/byteLength and element writes are allowed. A bare reference, alias,
capture or assignment rejects the region. The allocation must immediately
precede the loop apart from literal scalar declarations. Mutable bindings,
boxed/TDZ locals, async/generator functions, returns, try/catch dispatch and
labelled jumps retain ordinary emission.

The region keeps checked float/integer indices and typed numeric conversions.
Read indices and write index/value operands finish evaluating before any
short slice reborrow; accesses to the same buffer therefore preserve order.
Other buffers retain ordinary runtime access. The runtime checks direct
storage and releases the borrow on unwind. No unsafe code or unchecked
indexing is introduced.

An initial probe used unsupported element ++; that source and failure were
preserved. The next probe found synthetic Completion::Return dispatch from
try/catch emission crossing the slice closure, even without an explicit IR
return. Admission now refuses tryCatch nodes and the regression test pins it.
Corpus 3127 keeps that case and verifies the fallback, along with aliases,
captures, receiver replacement, ordinary breaks/continues and outer labels.

Eight distinct Rust corpora passed across focused runs, along with 15 selected
unit tests. Corpus 3127 passed in C/LLVM sanitized. Runtime: 210 tests passed
and all-target Clippy on 1.98.0 passed. Workspace build and touched lint passed.
Redwall passed 38 contracts, 26 native calls, engine none, no FFI and zero
fences; PNGs match Bun. Five generated loops borrow mutable slices, including
unfilter, RGBA conversion and output filtering.

Three-sample screening plus one warmup, alternating executables, same input
and assets, CPU 2 and resource limits: control 5067.45 ms,
regions 3611.78 ms, Bun --compile 941.33 ms.
Observed median improvement 28.7%;
still 3.84x Bun. All 12 executions matched.
This is a screening result, not completion of the performance objective.

Artifact: `7e8486a81d3a30c862810c59df7f9436a697051f3f68709b0465058d7dccc707`.
Evidence: `/tmp/scriptc-byte-regions-20260909/` and
`.red/tmp/native-byte-regions-checkpoint-20260909/`. The diagnostic IR-capture
test was removed from the package tests and retained with its result. The
full gate remains unaccepted; no consumer source or installed binary changed.
