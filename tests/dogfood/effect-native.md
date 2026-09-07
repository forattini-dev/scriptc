# Native Effect semantics

Consumer admission targets the installed Effect 4.0.0-beta.83 contract.
Native lowering is currently Rust-only and is selected for static builds.
The dependency/Effect milestone is in progress; RSP, Brain and full-app
acceptance are still separate, unfinished milestones.

The first correction gives SynchronizedRef a dedicated write permit,
shared by set, update and updateEffect. An effectful update holds it across
suspension and releases it on success or typed failure. Reads observe the
last committed value without acquiring the permit. Ref retains its ordinary
cell behavior. Deferred/Semaphore waiters now use FIFO order.

Corpus 3009 reproduced lost updates before the fix: Node returned 2 and 22,
while native Rust returned 1 and 2. After the fix it matches Node, including
fresh factory instances, makeUnsafe, queued ordinary writes, and recovery
after an update failure. Corpus 2978, 2987 and 2988 also passes, alongside
all 151 runtime tests and Clippy on Rust 1.98.0. The compiler build caught a
missing C-backend refusal for the new Rust-only calls; that exhaustive
dispatch is repaired and the compiler/CLI build passed.

The second correction represents typed failures and defects separately in
the fiber's outcome. Defects now unwind through ensuring and write-permit
cleanup; catchCause observes them, while ordinary failure recovery does not.
Scriptc throws inside callbacks and rejected Effect.promise values preserve
their payload as defects. Genuine Rust implementation panics still propagate.
Corpus 3010 passes against Node, including finalization, recovery boundaries,
string throws, rejected Error values, and permit release after a defect.

The Rust emitter also reconstructs scalar and builtin Error payloads when
a channel is widened to unknown. Existing dynamic payloads retain identity;
null and undefined are distinguishable at producer boxing sites. This is
not a general solution for typed record/class payloads widened to unknown.
Corpus 3011 passes the scalar success/failure channels and dynamic Error
identity against Node. The 20 other selected Effect regressions pass;
11 IR tests cover ordinary validation, serialization, boxed units and
rejection of malformed units and null callbacks.

Remaining semantics work includes multiple failing finalizers and combined causes,
interruption and shutdown, semaphore multi-permit acquisition, bounded
concurrency, PubSub scope cleanup, and tracing of boxed heap values.
Single-threaded execution alone does not provide atomicity across awaits.
Do not interpret API admission or the existing sequential corpus as proof
that these broader concurrent contracts are satisfied.
