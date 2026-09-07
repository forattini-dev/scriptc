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

## Subscription lifetime and shutdown

The original native PubSub retained every subscription until the hub was
dropped. Closing an acquiring scope left its queue registered and buffered
values alive. A differential witness returned `value:7` from a closed
subscription, then stopped producing output when hub shutdown left a take
pending. Node instead reported interruption and ran the waiting consumer's
finalizer.

Subscriptions now register an acquire/release finalizer with the current
scope. Release removes the registration, clears messages and wakes waiters.
Hub shutdown detaches and closes all its queues before resuming any waiting
fiber, so callbacks can reenter without observing a partly closed hub or
borrowing its state recursively.

Queue shutdown follows the installed Effect 4 behavior: buffered messages are
discarded, pending takes interrupt, pending offers answer false, later offers
answer false, and repeated shutdown succeeds with true. Interruption is a
separate outcome from typed failure and defect, so ordinary error handlers do
not swallow it. Cause predicates and tapCause preserve this distinction.
Cause.squash reconstructs the actual boxed value into unknown; the typed error
channel alone cannot describe a defect or interruption, including Cause<never>.

Regression witnesses:

- `3016-effect-pubsub-scope.ts`: escaped subscription, nested scope isolation,
  shutdown of a pending take and its finalizer.
- `3017-effect-queue-shutdown.ts`: buffered and blocked offers, pending takes,
  shutdown idempotence and bypassing typed error recovery.
- `3018-effect-interruption-cause.ts`: squashing interruption and defects whose
  payload differs from the typed error channel.
- `3019-effect-cause-composite.ts`: preserving record, array and union failure
  conversion while accepting a defect outside the declared error channel.
- `packages/runtime-rust/src/effect_state.test.rs`: 100 consecutive scopes
  release registrations and weakly observed payloads, body failure/defect
  cleanup, and release of buffered and pending queue payloads with reentry.

Validation: all 154 runtime tests and Clippy pass on Rust 1.98.0. The four
new differential programs plus 2978, 2989, 2990, 2991, 2994, 3010 and 3011
pass against Node (11 total), with native heap auditing enabled. Workspace
build, the final compiler rebuild and source-size checks pass; focused
ESLint reports zero errors and 28 existing lowering warnings. The first
final differential run could not build because locked crates were absent
from the local cache. After `cargo fetch --locked`, the unchanged 11-case
selection passed. This is focused validation, not a green repository gate.

## Remaining work

This fixes specific ownership paths, not all memory retention in Effect.
`EffectValue` is still `Rc<dyn Any>`. `EffectData::trace` does not enumerate
boxed payloads, service bundles, or kernel state, and suspended fiber frames
are not collector nodes. Integrating these owners requires preserving shared
box identity in the collector's reference accounting: tracing the same boxed
Gc once per alias can overcount internal edges and clear reachable objects.
A minimal cyclic-value witness and rooted/shared-owner tests must precede
that change.

Other pending semantics include combined causes and multiple failing
finalizers, general fiber cancellation and interruption masks, runSync
cleanup after asynchronous refusal, real bounded/unbounded collection
concurrency, and PubSub backpressure. Single interruption causes do not
provide fiber identity APIs. General typed record/class payload widening to
unknown and dynamic-mode native Effect integration also remain unfinished.

The consumer acceptance order remains RSP/Brain, then full red-dev/redcode,
followed by measured CPU/RSS optimization. The full repository gate is still
red; see [native-gate.md](./native-gate.md).
