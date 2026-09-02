/* Panic hardening across the island's engine boundary.
 *
 * Two independent defects share one symptom — `tcache_thread_shutdown():
 * unaligned tcache chunk detected`, SIGABRT, no message — and both are
 * covered here.
 *
 * FIRST, an `IslandState` dropped by a thread-local DESTRUCTOR runs
 * against a boa GC arena that its own destructor already tore down. That
 * needs no panic at all: any realm left un-finished when the thread ends
 * hits it. `IslandSlot` (island_eval.rs) leaks the realm at thread exit
 * instead, and the two subprocess tests below are the only honest way to
 * assert it, since what is under test is how the PROCESS ends.
 *
 * SECOND, a Rust unwind escaping a callback boa invoked tears through the
 * engine's own frames. `island_boundary` (island_boundary.rs) converts
 * every unwind at those boundaries into a `JsError` instead — catchable
 * for a scriptc `throw`, uncatchable-and-parked for a genuine panic.
 */

/// Re-run this very test binary for one `#[ignore]`d child test.
fn island_child_run(name: &str) -> std::process::Output {
    let exe = std::env::current_exe().expect("the test binary must know its own path");
    std::process::Command::new(exe)
        .arg(name)
        .args(["--exact", "--ignored", "--test-threads=1", "--nocapture"])
        .output()
        .expect("the child test binary must start")
}

/// A child that ends its thread with the realm still live AND a panic in
/// flight — the reproduction from
/// docs/upstream/boa-suspected-aborts-are-not-upstream.md, verbatim.
#[test]
#[ignore = "child process of a_panic_with_a_live_realm_fails_the_run_it_does_not_abort_it"]
fn island_child_panics_with_a_live_realm() {
    island_eval(&string("globalThis.probe = ({a:1}); 0"));
    let value = island_global_get("probe");
    assert_eq!(island_json(&value).as_ref(), "SHOULD-FAIL");
    island_eval_finish();
}

/// The same child MINUS the panic. It is what isolates the cause: this
/// one aborted too, which is why the abort was never about the unwind.
#[test]
#[ignore = "child process of a_realm_left_live_at_thread_exit_ends_the_process_cleanly"]
fn island_child_leaves_a_live_realm() {
    island_eval(&string("globalThis.probe = ({a:1}); 0"));
    let value = island_global_get("probe");
    assert_eq!(island_json(&value).as_ref(), "{\"a\":1}");
    // Deliberately NO island_eval_finish: the realm is still live when
    // this thread ends, which is the whole point.
}

#[test]
fn a_panic_with_a_live_realm_fails_the_run_it_does_not_abort_it() {
    let output = island_child_run("tests::island_child_panics_with_a_live_realm");
    let stderr = String::from_utf8_lossy(&output.stderr);
    // 101 is the test harness reporting a FAILED test. A signal death
    // reports no code at all, which is exactly what this used to do.
    assert_eq!(
        output.status.code(),
        Some(101),
        "the child must exit as a failed test, not on a signal; stderr:\n{stderr}"
    );
    assert!(
        stderr.contains("SHOULD-FAIL"),
        "the assertion's own message must reach stderr, not be buried by an abort; stderr:\n{stderr}"
    );
    assert!(
        !stderr.contains("tcache"),
        "the glibc heap-corruption abort must be gone; stderr:\n{stderr}"
    );
}

#[test]
fn a_realm_left_live_at_thread_exit_ends_the_process_cleanly() {
    let output = island_child_run("tests::island_child_leaves_a_live_realm");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(0),
        "an un-finished realm must not abort the process at thread exit; stderr:\n{stderr}"
    );
    assert!(
        !stderr.contains("tcache"),
        "the glibc heap-corruption abort must be gone; stderr:\n{stderr}"
    );
}

/// Install one host function as a global, so island JavaScript can call
/// it with the engine's frames underneath.
fn island_install_global(name: &str, value: &IslandValue) {
    let global = island_global_get("globalThis");
    island_set_index(&global, &island_value_string(&string(name)), value);
}

/// A scriptc `throw` from a host function is ordinary control flow on the
/// far side of the bridge: the boundary rebuilds it as a real engine
/// exception, so the island's own `try`/`catch` narrows on it instead of
/// the unwind tearing straight past every JavaScript frame.
#[test]
fn a_throwing_host_function_is_catchable_from_island_javascript() {
    let boom = island_value_host_function(
        0,
        Rc::new(|_: &[IslandHostArgument]| -> IslandHostResult {
            throw_type_error("host said no".to_owned())
        }),
    );
    island_install_global("boom", &boom);

    let rendered = island_eval(&string(
        "try { globalThis.boom(); 'no throw' } \
         catch (e) { e instanceof TypeError ? e.name + ': ' + e.message : 'wrong shape: ' + e }",
    ));
    assert_eq!(rendered.as_ref(), "TypeError: host said no");
    island_eval_finish();
}

/// A GENUINE Rust panic from a host function is not that. It becomes
/// boa's own uncatchable error — so the JavaScript `catch` below must not
/// see it — the engine unwinds its frames by its own error path, and the
/// panic re-raises from `with_island_state` afterwards, carrying its
/// original message and leaving the realm torn down.
#[test]
fn a_panicking_host_function_re_raises_after_the_engine_returns() {
    let boom = island_value_host_function(
        0,
        Rc::new(|_: &[IslandHostArgument]| -> IslandHostResult {
            panic!("island boundary probe")
        }),
    );
    island_install_global("boom", &boom);

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        island_eval(&string(
            "try { globalThis.boom() } catch (e) { globalThis.swallowed = true; 'caught' }",
        ))
    }));
    let message = outcome.err().and_then(|payload| {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|text| (*text).to_owned()))
    });
    assert_eq!(
        message.as_deref(),
        Some("island boundary probe"),
        "the panic's own message must survive, and JavaScript must not have caught it"
    );

    // The realm was torn down on the way out, so the next call builds a
    // fresh one — and the JavaScript `catch` block never ran.
    let rendered = island_eval(&string("typeof globalThis.swallowed"));
    assert_eq!(rendered.as_ref(), "undefined");
    island_eval_finish();
}
