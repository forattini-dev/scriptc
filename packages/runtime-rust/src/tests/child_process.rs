// End-to-end tests for the asynchronous `child_process` surface.
//
// Every case is `#[cfg(unix)]`: they spawn `/bin/sh` and reason about POSIX
// signals and errnos, which have no honest Windows counterpart. The commands
// are deliberately boring — `exit 7`, `printf`, `sleep` — so a failure points
// at the runtime rather than at the fixture.

/// `stdio` mode for a piped stream, as `child_spawn_options` numbers them.
#[cfg(unix)]
const STDIO_PIPE: f64 = 3.0;

/// `stdio` mode for `/dev/null`.
#[cfg(unix)]
const STDIO_IGNORE: f64 = 0.0;

#[cfg(unix)]
fn shell(script: &str) -> JsArray<JsString> {
    array_new(vec![string("-c"), string(script)])
}

#[cfg(unix)]
fn spawn_shell(script: &str, stdout: f64, stderr: f64) -> JsChild {
    child_spawn_options(
        &string("sh"),
        &shell(script),
        STDIO_IGNORE,
        stdout,
        stderr,
        0.0,
        0.0,
        false,
        false,
        &array_new::<JsString>(Vec::new()),
        &string(""),
    )
}

/// Records `exit` as `exit:<code|signal>` on the shared transcript.
#[cfg(unix)]
fn record_exit(child: &JsChild, log: &Transcript) {
    let exit_log = log.clone();
    child_on_exit(
        child,
        Box::new(move |code, signal| {
            note(
                &exit_log,
                &format!(
                    "exit:{} {}",
                    code.map_or_else(|| "none".to_owned(), |code| format!("{code}")),
                    signal.map_or_else(|| "none".to_owned(), |signal| signal.to_string()),
                ),
            );
        }),
        no_trace_boxed(),
    );
}

#[cfg(unix)]
#[test]
fn child_exit_code_captured() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let child = spawn_shell("exit 7", STDIO_IGNORE, STDIO_IGNORE);
    assert!(child_pid(&child).is_some(), "a spawned child reports a pid");
    record_exit(&child, &log);

    run_event_loop();

    assert_eq!(entries(&log), vec!["exit:7 none"]);
    assert_eq!(child_exit_code(&child), Some(7.0));
    assert!(!child_killed(&child), "a natural exit is not a kill");

    drop(child);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[cfg(unix)]
#[test]
fn child_stdout_stderr_stream() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let child = spawn_shell("printf out; printf err 1>&2", STDIO_PIPE, STDIO_PIPE);
    let stdout = child_stdout(&child).expect("piped stdout");
    let stderr = child_stderr(&child).expect("piped stderr");

    for (label, stream) in [("stdout", &stdout), ("stderr", &stderr)] {
        let data_log = log.clone();
        child_stream_on_data(
            stream,
            Rc::new(move |chunk| {
                note(&data_log, &format!("{label}:{}", utf8(&chunk)));
            }),
            no_trace(),
            false,
        );
        let end_log = log.clone();
        child_stream_on_end(
            stream,
            Rc::new(move || note(&end_log, &format!("{label}-end"))),
            no_trace(),
        );
    }
    record_exit(&child, &log);

    run_event_loop();

    let entries = entries(&log);
    // Interleaving between the two pipes is the OS's business; what the
    // runtime owes is every byte, on the right stream, and an `end` for each.
    let joined = |prefix: &str| {
        entries
            .iter()
            .filter_map(|entry| entry.strip_prefix(prefix))
            .collect::<String>()
    };
    assert_eq!(joined("stdout:"), "out", "{entries:?}");
    assert_eq!(joined("stderr:"), "err", "{entries:?}");
    assert!(entries.contains(&"stdout-end".to_owned()), "{entries:?}");
    assert!(entries.contains(&"stderr-end".to_owned()), "{entries:?}");
    // `end` before `exit` is best-effort (the runtime gives its reader threads
    // one short bounded window before reporting the exit), and Node makes no
    // guarantee either — so the presence of both is what is asserted, and only
    // `close`-style ordering would be safe to pin.
    assert!(entries.contains(&"exit:0 none".to_owned()), "{entries:?}");

    drop(stdout);
    drop(stderr);
    drop(child);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[cfg(unix)]
#[test]
fn child_kill_sigterm_reports_signal() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let child = spawn_shell("sleep 30", STDIO_IGNORE, STDIO_IGNORE);
    record_exit(&child, &log);

    // Kill from a timer so the signal lands while the loop is already
    // polling the child, which is the shape a program would produce.
    let killing = child.downgrade();
    let kill_log = log.clone();
    timer_set_timeout(
        Box::new(move || {
            let sent = child_kill(&reborrow(&killing), &string("SIGTERM"));
            note(&kill_log, &format!("kill:{sent}"));
        }),
        10.0,
    );

    run_event_loop();

    assert_eq!(entries(&log), vec!["kill:true", "exit:none SIGTERM"]);
    assert!(child_killed(&child), "kill() marks the child killed");
    assert_eq!(
        child_exit_code(&child),
        None,
        "a signalled child has no exit code",
    );

    drop(child);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[cfg(unix)]
#[test]
fn child_spawn_enoent_emits_error() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let child = child_spawn(
        &string("scriptc-no-such-program-04d1"),
        &array_new::<JsString>(Vec::new()),
    );
    assert!(child_pid(&child).is_none(), "a failed spawn has no pid");

    let error_log = log.clone();
    child_on_error(
        &child,
        Box::new(move |error: JsError| {
            note(&error_log, &format!("error:{}", error_message(&error)));
        }),
        no_trace_boxed(),
    );
    record_exit(&child, &log);

    run_event_loop();

    let entries = entries(&log);
    assert_eq!(entries.len(), 1, "error replaces exit: {entries:?}");
    assert!(
        entries[0].contains("ENOENT"),
        "a missing program reports ENOENT: {}",
        entries[0],
    );
    // The failed spawn's errno is surfaced negated, the way `waitpid`-shaped
    // callers expect: ENOENT is 2.
    assert_eq!(child_exit_code(&child), Some(-2.0));

    drop(child);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[cfg(unix)]
#[test]
fn child_unref_lets_loop_exit() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let child = spawn_shell("sleep 30", STDIO_IGNORE, STDIO_IGNORE);
    record_exit(&child, &log);
    child_unref(&child);

    let started = std::time::Instant::now();
    run_event_loop();
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "an unreferenced child must not hold the loop open (took {elapsed:?})",
    );
    assert!(
        entries(&log).is_empty(),
        "the loop returned before the child could exit: {:?}",
        entries(&log),
    );

    // The child outlives the loop, so this test reaps it by hand rather than
    // leaving a `sleep 30` behind for the rest of the run.
    assert!(child_kill(&child, &string("SIGKILL")), "SIGKILL delivered");
    let reaping = std::time::Instant::now();
    while entries(&log).is_empty() {
        assert!(
            reaping.elapsed() < std::time::Duration::from_secs(5),
            "the killed child never reported",
        );
        if !children_dispatch_one() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    assert_eq!(entries(&log), vec!["exit:none SIGKILL"]);

    drop(child);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[cfg(unix)]
#[test]
fn child_large_output_no_deadlock() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    const EXPECTED: usize = 200_000;

    // Far more than a pipe buffer: if the reader thread's `sync_channel(1)`
    // handoff ever stopped draining, the child would block on write and this
    // test would sit on its deadline instead of finishing.
    let child = spawn_shell(
        "head -c 200000 /dev/zero | tr '\\0' a",
        STDIO_PIPE,
        STDIO_IGNORE,
    );
    let stdout = child_stdout(&child).expect("piped stdout");

    let received = Rc::new(Cell::new(0_usize));
    let counting = received.clone();
    let non_a = Rc::new(Cell::new(0_usize));
    let counting_non_a = non_a.clone();
    child_stream_on_data(
        &stdout,
        Rc::new(move |chunk| {
            let bytes = bytes_u8_values(&chunk);
            counting.set(counting.get() + bytes.len());
            counting_non_a.set(
                counting_non_a.get() + bytes.iter().filter(|byte| **byte != b'a').count(),
            );
        }),
        no_trace(),
        false,
    );
    let end_log = log.clone();
    child_stream_on_end(
        &stdout,
        Rc::new(move || note(&end_log, "end")),
        no_trace(),
    );
    record_exit(&child, &log);

    run_event_loop();

    assert_eq!(received.get(), EXPECTED, "every byte crossed the pipe");
    assert_eq!(non_a.get(), 0, "no byte was corrupted in transit");
    // Both events, in either order: at this volume the drain window before
    // `exit` is not always enough to land `end` first, and Node does not
    // promise that ordering either.
    let entries = entries(&log);
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert!(entries.contains(&"end".to_owned()), "{entries:?}");
    assert!(entries.contains(&"exit:0 none".to_owned()), "{entries:?}");

    drop(stdout);
    drop(child);
    finish();
    assert_eq!(live_heap_objects(), 0);
}
