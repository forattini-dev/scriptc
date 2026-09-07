# Native Effect semantics

Consumer admission targets the installed Effect 4.0.0-beta.83 contract.
Native lowering is currently Rust-only and is selected for static builds.
The dependency/Effect milestone is in progress; RSP, Brain and full-app
acceptance are still separate, unfinished milestones.

The first correction gives SynchronizedRef a dedicated write permit,
shared by set, update and updateEffect. An effectful update holds it across
suspension and releases it on success or typed failure. Reads observe the
last committed value without acquiring the permit. Ref retains its ordinary
cell behavior. Waiting writes retain arrival order.

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

The third correction acquires a Semaphore request atomically: a waiter for
multiple permits does not consume a partial request while suspended. Smaller
eligible requests can proceed, and zero and fractional permit counts retain
Effect's numeric accounting. Corpus 3012 previously returned holder,large,small
and then stalled at zero permits; it now matches Node's holder,small,large,
including zero/fractional acquisition and release after a defect.

Deferred settlement publishes its outcome and releases the mutable borrow
before resuming waiters. Corpus 3013 previously panicked when a resumed fiber
queried and awaited the same Deferred; it now matches Node, including a
repeated settlement returning false. Both new programs and regressions 2988,
3009 and 3010 pass differential validation. All 151 runtime tests and Clippy
pass on Rust 1.98.0. This checkpoint does not make the full repository gate
green; the immutable Redwall gate still has failures under investigation.

The fourth correction routes Ref.getAndSet and SynchronizedRef.getAndSet
through value replacement even when the replacement is callable. Previously
the compiler emitted an updater invocation, tried to unbox the stored closure
as the callback's argument type, and terminated before producing output.
Corpus 3014 now matches Node and proves replacement does not call the function;
2987 and 3009 also pass. Workspace build and focused ESLint pass (0 errors;
28 existing warnings in the lowering module).

Collection options now refuse unsupported concurrency explicitly. The current
kernel accepts omitted concurrency or literal concurrency: 1; bounded,
unbounded, inherited and computed options remain unfinished. The compiler
checks the entire options object, including members after discard, and
requires a literal boolean for discard so it cannot erase side effects in
an option expression. Before this correction 13 admission regressions failed;
all 15 admission cases now pass, including two sequential controls. Corpus
3015 verifies explicit sequential options across suspension against Node;
2977 and 2987 also pass. The compiler build and focused ESLint pass. The
first 3015 draft hit the existing refusal for console.log of a void call;
the final fixture observes discard through the callback's side effects.

Remaining semantics work includes multiple failing finalizers and combined causes,
interruption and shutdown, bounded
concurrency, PubSub scope cleanup, and tracing of boxed heap values.
Single-threaded execution alone does not provide atomicity across awaits.
Do not interpret API admission or the existing sequential corpus as proof
that these broader concurrent contracts are satisfied.
