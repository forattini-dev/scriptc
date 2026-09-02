# Two suspected boa aborts are NOT upstream — the heap corruption is ours

A negative result about boa, and a positive one about scriptc. **No issue
should be filed for either suspected bug.** The one defect that DID reproduce
in pure boa has its own draft in `boa-to-json-drops-typed-array-elements.md`.

- **Version under test:** `boa_engine = "=0.22.0"` (default features)
- **Toolchain:** `rustc 1.98.0 (88d9e12ae 2026-08-18)`, debug profile
- **Method:** standalone crate, boa's public API only, no scriptc code linked

## (a) `JsValue::to_json` over a `Uint8Array` — DOES NOT ABORT in boa

In pure boa it returns cleanly for every shape tried: a `Uint8Array` from
`eval`, an empty one, one nested in an object, one nested in an array, one built
through `JsUint8Array::from_iter`, a 64 KiB one, a detached-buffer view, a
`Uint8Array` subclass, a `Proxy` over a typed array, two views over one buffer,
and `to_json` called from inside a `NativeFunction` host closure. Exit code 0,
no panic, no `SIGABRT`/`SIGSEGV`, no glibc message.

It returns `Ok(Some({}))`, silently dropping the elements. That is a real
upstream defect, written up separately — but it is a correctness bug, not a
crash. The same `{}` comes back through scriptc's own `island_json`, also
without aborting.

## (b) `new Function` nested in an IIFE through `eval` — DOES NOT ABORT in boa

Seven shapes all evaluate correctly, exit code 0: a bare
`new Function('a','return a+1')(1)`; an IIFE returning the created function; an
IIFE calling it; the arrow-function variant; a doubly nested IIFE; a
`new Function` whose body itself builds a `new Function`; and the exact
five-parameter CommonJS wrapper
`new Function('exports','require','module','__filename','__dirname', src)` that
`packages/runtime-rust/src/island_bootstrap.js:164` emits, including nested
instances of it.

## What actually aborts: an island realm dropped at thread exit

Both reports share one cause, and it is on our side. Reduced to a minimal case
with no typed array and no `new Function` involved:

```rust
#[test]
fn probe() {
    island_eval(&string("globalThis.probe = ({a:1}); 0"));
    let value = island_global_get("probe");
    assert_eq!(island_json(&value).as_ref(), "SHOULD-FAIL"); // any panic here
    island_eval_finish();
}
```

Run single-threaded, one test, against `--features island-eval`:

```
running 1 test
test tests::probe ... tcache_thread_shutdown(): unaligned tcache chunk detected
error: test failed, to rerun pass `--lib`
Caused by:
  process didn't exit successfully: ... (signal: 6, SIGABRT: process abort signal)
```

The same body WITHOUT the failing assertion (evaluate, `island_json`, print,
`island_eval_finish`) passes cleanly and prints `{}`.

### Correction: the panic was a red herring — FIXED

The first pass of this note concluded the trigger was "the unwind, not the
value, not the engine call", and that the abort was the island state
surviving an unwind with boa's VM frame stack abandoned mid-call. That is
one step off the mark, and the isolating probe is a third variant of the
body above: evaluate, `island_json`, print, and then **do not call
`island_eval_finish`** — no panic anywhere.

```
test tests::probe_no_panic_no_finish ... json={"a":1}
tcache_thread_shutdown(): unaligned tcache chunk detected
... (signal: 6, SIGABRT: process abort signal)
```

It aborts identically. So the panic was never the cause: it was only what
made the test skip `island_eval_finish`.

The cause is destructor ORDER. boa keeps its garbage-collected arena in a
`thread_local`, and glibc runs TLS destructors in the reverse of
registration order. `ISLAND_STATE` registers FIRST — it is borrowed before
the `Context` inside it makes boa touch its arena — so at thread exit the
arena is torn down first, and dropping `IslandState` afterwards walks freed
GC storage. Any island left un-finished when its thread ends hits this,
panic or no panic.

The fix is `IslandSlot` in `packages/runtime-rust/src/island_boundary.rs`: the
realm is process-scoped, so at thread exit it is LEAKED rather than dropped
against an arena that is already gone. `island_eval_finish` still drops it
properly, while the arena is live, and that is the path every ordinary run
takes. `packages/runtime-rust/src/tests/island_boundary.rs` holds both
variants fixed as subprocess tests, since what is under test is how the
process ends.

Why the two original reports looked like separate engine bugs: both were
reached through a path that panics — a `to_json` result that failed a check, and
a CJS module whose top level calls a host bridge that throws
(`island_bootstrap.js:169` wraps `fn.call(...)` in a `try`/`catch` that
rethrows). Panicking is what skips the teardown, which is what made the
panic look causal.

### The unwind hazard was real, and is closed separately

Unwinding out of a callback boa invoked is still not something to do — it
abandons the VM's frame stack and whatever `GcRefCell` borrows it held —
even though it is not what produced this abort. Every Rust→boa→Rust
boundary now runs its body inside `island_boundary`
(`packages/runtime-rust/src/island_boundary.rs`), which converts a scriptc
`throw` into a catchable engine exception and a genuine panic into boa's
uncatchable `PanicError`, parking the payload so `with_island_state` can
re-raise it once the engine has unwound its own frames.

Note this was probed in pure boa and did NOT reproduce there: a Rust `panic!`
raised from a `NativeFunction`, unwound through boa's VM and caught outside,
then reusing the same `Context` five times plus a 500-iteration GC hammer,
survived intact. So it is scriptc's teardown of an unwound island that is
wrong, not boa's tolerance of an unwind.

## Untested permutation

scriptc builds boa with `default-features = false`
(`packages/runtime-rust/Cargo.toml`), dropping `float16`, `xsum` and `temporal`.
A matching no-default-features crate could not be built (the scratch filesystem
ran out of space). None of those features touch typed-array JSON or function
construction, so this is not expected to matter — but it is not ruled out.
