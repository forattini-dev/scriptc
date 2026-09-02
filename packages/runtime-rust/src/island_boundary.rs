/* The one place a Rust unwind is allowed to meet the island engine.
 *
 * The island is re-entrant in both directions: scriptc calls INTO boa
 * (`island_eval`, a `call`, `run_jobs`), and boa calls BACK OUT into Rust
 * — every `host.*` member, an FFI host function, a promise reaction, a
 * timer callback, the module loader. On that return leg the Rust code
 * runs with boa's VM frames still on the stack.
 *
 * That matters because scriptc's runtime signals errors by UNWINDING: a
 * `throw` is `resume_unwind` with a thread-local payload (errors.rs), a
 * detected library trap is another, and an ordinary `assert!` or
 * `.unwrap()` is a third. Let any of them unwind from a callback body,
 * and it tears through boa's frames — abandoning the VM's frame stack and
 * whatever `GcRefCell` borrows it held mid-mutation — on its way to a
 * `catch_unwind` far above. The realm that survives is not a realm any
 * more, and nothing says so at the point of damage.
 *
 * So EVERY callback boa can invoke runs its body inside
 * `island_boundary`, which turns the three unwind kinds into the one
 * thing boa does understand, a `JsError`:
 *
 *   - a scriptc `throw`  → a CATCHABLE engine exception carrying Node's
 *     `code`, so island JavaScript's own `try`/`catch` sees it (this is
 *     what island_host_io.rs's `island_host_guard` already did for the
 *     I/O members; the boundary generalizes it to all of them);
 *   - a library trap     → the same, built from the trap's text and code;
 *   - a genuine panic    → an UNCATCHABLE `PanicError`, which boa's VM
 *     refuses to hand to any `catch` block and propagates straight out,
 *     while the payload is PARKED here. `with_island_state` takes it back
 *     once the engine has returned control and re-raises it there —
 *     outside every boa frame, and after the realm has been torn down.
 *
 * The re-panic is ordered rather than immediate on purpose: the point is
 * that boa unwinds its OWN frames, by its own error path, before the Rust
 * unwind resumes.
 *
 * The realm slot and the funnel that guards it are at the bottom of this
 * file for the same reason: `with_island_state` is where a parked panic
 * comes back, and `IslandSlot` answers a SECOND way an island can take
 * the process down — being dropped by a thread-local destructor, which
 * needs no unwind at all. Its own comment has that story.
 */

thread_local! {
    /// A genuine Rust panic caught at an engine boundary, held until the
    /// engine hands control back. At most one: a later panic raised while
    /// the realm is already terminal does not displace the first, which
    /// is the one that explains the failure.
    static ISLAND_PARKED_PANIC: RefCell<Option<Box<dyn Any + Send>>> =
        const { RefCell::new(None) };
}

/// Run one engine-callback body so that no Rust unwind leaves it.
///
/// `AssertUnwindSafe` is the honest annotation and not a shrug: the whole
/// reason this exists is that the `Context` may be observed after an
/// unwind. What makes that sound to continue from is the kind of unwind —
/// a scriptc `throw` is ordinary control flow the engine resumes from,
/// and a genuine panic makes the realm terminal, so the only thing that
/// runs against it afterwards is boa's own propagation and the teardown
/// in `with_island_state`.
fn island_boundary<T>(
    context: &mut Context,
    body: impl FnOnce(&mut Context) -> JsResult<T>,
) -> JsResult<T> {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(context)));
    match outcome {
        Ok(result) => result,
        Err(payload) => Err(island_boundary_error(payload, context)),
    }
}

/// Classify one unwind payload into the engine error that replaces it.
fn island_boundary_error(payload: Box<dyn Any + Send>, context: &mut Context) -> BoaJsError {
    // A detected library trap carries its own rendered text and scriptc
    // code, and never reached `EXCEPTION_SLOT`, so it is rebuilt from
    // those two rather than through the caught-value path below.
    let payload = match take_runtime_trap(payload) {
        Ok((text, code)) => return island_trap_error(&text, code, context),
        Err(payload) => payload,
    };
    if is_scriptc_unwind(payload.as_ref()) {
        return island_host_error(&caught_from_panic(payload), context);
    }
    island_park_panic(payload)
}

/// Rebuild a library trap as a catchable engine error.
///
/// The trap text is a whole rendered line (`scriptc: TypeError: …\n`);
/// the engine wants a bare message, and the constructor is picked from
/// the trap's own code so `e instanceof TypeError` still narrows.
fn island_trap_error(text: &str, code: &'static str, context: &mut Context) -> BoaJsError {
    let message = text
        .trim_end_matches('\n')
        .trim_start_matches("scriptc: ")
        .to_owned();
    let error = match code {
        "SC4014" => error_new_code("RangeError", Rc::from(message.as_str()), code),
        "SC4015" => error_new_code("TypeError", Rc::from(message.as_str()), code),
        _ => error_new_code("Error", Rc::from(message.as_str()), code),
    };
    island_host_error(&caught_value(error), context)
}

/// Park a genuine Rust panic and answer with the error that ends the run.
///
/// `PanicError` is boa's own uncatchable kind: the VM's handler skips
/// every `catch` block for it, so island JavaScript cannot swallow a
/// scriptc defect and keep going on a realm that is no longer sound.
fn island_park_panic(payload: Box<dyn Any + Send>) -> BoaJsError {
    let message = island_panic_message(payload.as_ref());
    ISLAND_PARKED_PANIC.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = Some(payload);
        }
    });
    boa_engine::error::PanicError::new(format!("scriptc: {message}")).into()
}

/// The panic's own message, for the engine error that stands in for it.
/// The payload itself is kept intact for the re-panic, so this copy only
/// has to be readable — `panic!` and `assert!` both land in one of these
/// two shapes, and anything else is a payload nobody can render.
fn island_panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        return (*message).to_owned();
    }
    "a Rust panic crossed the island boundary".to_owned()
}

/// Take back a parked panic, if the run left one.
fn island_parked_panic() -> Option<Box<dyn Any + Send>> {
    ISLAND_PARKED_PANIC.with(|slot| slot.borrow_mut().take())
}

fn island_parked_panic_reset() {
    ISLAND_PARKED_PANIC.with(|slot| *slot.borrow_mut() = None);
}

/* ── the realm slot, and the funnel that guards it ─────────────────── */

/// The realm slot. Beyond holding the state it has exactly one job: make
/// THREAD EXIT safe, which dropping an `IslandState` is not.
///
/// boa keeps its garbage-collected arena in a `thread_local` of its own,
/// and TLS destructors run in an unspecified order — on glibc, the
/// reverse of registration. This slot registers FIRST, because it is
/// borrowed before the `Context` inside it makes boa touch its arena. So
/// at thread exit the arena is already torn down by the time
/// `IslandState` would be dropped, and that drop walks freed GC storage:
/// `tcache_thread_shutdown(): unaligned tcache chunk detected`, SIGABRT,
/// no message about what actually went wrong.
///
/// That is the abort reproduced in
/// docs/upstream/boa-suspected-aborts-are-not-upstream.md, and it is NOT
/// the unwind hazard the rest of this file is about: an island left
/// un-finished at thread exit aborts identically with no panic anywhere.
/// The panic was only what skipped `island_eval_finish`.
///
/// The realm is process-scoped, so the honest answer at thread exit is to
/// LEAK it rather than drop it against an arena that is already gone.
/// `island_eval_finish` still drops it properly, while the arena is live,
/// and that is the path every ordinary run takes.
struct IslandSlot(RefCell<Option<IslandState>>);

impl std::ops::Deref for IslandSlot {
    type Target = RefCell<Option<IslandState>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for IslandSlot {
    fn drop(&mut self) {
        std::mem::forget(self.0.get_mut().take());
    }
}

thread_local! {
    static ISLAND_STATE: IslandSlot = const { IslandSlot(RefCell::new(None)) };
}

/// The single funnel every island call passes through, so it is also the
/// one place that can catch an unwind crossing the realm and decide what
/// it means for `ISLAND_STATE`.
///
/// A scriptc `throw` reaching here (a `ScriptThrow`/`RuntimeTrap` marker)
/// is ordinary control flow — it is resumed untouched, and the realm's
/// globals stay live for a later `island_eval` call after the catch. Any
/// OTHER panic (an `assert!`/`.unwrap()` failure, a boa-internal bug) may
/// have left the engine's GC arena mid-mutation, so it gets `IslandState`
/// torn down right here, deterministically, before the unwind continues,
/// rather than left for whatever runs next to inherit.
///
/// This is also where a panic PARKED by `island_boundary` comes back: a
/// genuine panic raised inside a callback boa invoked is not allowed to
/// unwind through the engine's frames, so it travels out as boa's
/// uncatchable `PanicError` and re-raises here instead — after the engine
/// has unwound itself and the `ISLAND_STATE` borrow is released.
fn with_island_state<T>(f: impl FnOnce(&mut IslandState) -> T) -> T {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ISLAND_STATE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let state = slot.get_or_insert_with(island_state);
            f(state)
        })
    }));
    match outcome {
        Ok(value) => {
            // A genuine panic PARKED at an engine boundary re-raises
            // here, and only here. By now boa has unwound its own frames
            // through its uncatchable-error path and returned, and the
            // `ISLAND_STATE` borrow above is released — so this unwind
            // crosses scriptc frames only, and it crosses them after the
            // realm is gone.
            if let Some(payload) = island_parked_panic() {
                island_eval_finish();
                std::panic::resume_unwind(payload);
            }
            value
        }
        Err(payload) => {
            // A parked panic outranks whatever unwind reached here. The
            // engine answered the panic with an uncatchable error, so the
            // error that came back out is a SYMPTOM — usually the scriptc
            // throw `island_eval_error` builds from it. Drain that
            // throw's exception slot so the next one finds it empty, then
            // raise the cause rather than the symptom.
            if let Some(parked) = island_parked_panic() {
                if is_scriptc_unwind(payload.as_ref()) {
                    drop(take_runtime_trap(payload).map_err(caught_from_panic));
                }
                island_eval_finish();
                std::panic::resume_unwind(parked);
            }
            if !is_scriptc_unwind(payload.as_ref()) {
                island_eval_finish();
            }
            std::panic::resume_unwind(payload)
        }
    }
}
