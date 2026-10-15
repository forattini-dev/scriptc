#[cfg(unix)]
#[test]
fn bun_subprocess_exit_identity_signal_and_heap() {
    let _guard = loop_deadline(DEADLINE_MS);
    for (script, expected) in [("exit 7", 7.0), ("kill -TERM $$", 143.0)] {
        let argv = array_new(vec![string("/bin/sh"), string("-c"), string(script)]);
        let child = bun_spawn(&argv, 0.0, 0.0, 0.0, false, &array_new(vec![]), &string(""));
        let promise = bun_subprocess_exited(&child);
        assert!(Gc::ptr_eq(&promise, &bun_subprocess_exited(&child)));
        child.with_mut(|child| child.process.as_mut().unwrap().wait().unwrap());
        assert_eq!(bun_subprocess_exit_code(&child), if expected == 7.0 { Some(7.0) } else { None });
        let observed = Rc::new(RefCell::new(None));
        let output = observed.clone();
        promise_then(&promise, Box::new(move |value| *output.borrow_mut() = Some(value)));
        run_event_loop();
        assert_eq!(observed.borrow_mut().take().unwrap().unwrap_or_else(|reason| panic!("{}", caught_error_message(&reason))), expected);
        assert_eq!(bun_subprocess_exit_code(&child), if expected == 7.0 { Some(7.0) } else { None });
        assert_eq!(child_killed(&child), expected == 143.0);
        drop((promise, child, argv));
    }
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn bun_subprocess_missing_command_throws_without_registering_a_child() {
    let argv = array_new(vec![string("scriptc-missing-subprocess-fixture")]);
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bun_spawn(&argv, 0.0, 0.0, 0.0, false, &array_new(vec![]), &string(""))));
    let reason = caught_from_panic(error.err().expect("spawn must throw"));
    assert_eq!(caught_error_code(&reason), Some(string("ENOENT")));
    assert!(!children_referenced_pending());
    drop((reason, argv));
    finish();
}

#[cfg(unix)]
#[test]
fn bun_subprocess_explicit_empty_env_uses_posix_default_search_path() {
    let _guard = loop_deadline(DEADLINE_MS);
    let argv = array_new(vec![string("sh"), string("-c"), string("exit 7")]);
    let child = bun_spawn(&argv, 0.0, 0.0, 0.0, true, &array_new(vec![]), &string(""));
    let promise = bun_subprocess_exited(&child);
    run_event_loop();
    assert!(matches!(promise_poll(&promise), Some(Ok(7.0))));
    drop((argv, promise, child));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[cfg(windows)]
#[test]
fn bun_subprocess_custom_windows_path_refuses_to_change_argv0() {
    let root = std::env::temp_dir().join(format!("scriptc-bun-spawn-path-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let name = "scriptc-bun-argv0-fixture";
    std::fs::write(root.join(format!("{name}.exe")), b"not executed").unwrap();
    let error = std::panic::catch_unwind(|| bun_spawn_check_windows_path(
        &string(name), Some(&array_new(vec![string("PATH"), string(root.to_str().unwrap())])), &string("")));
    let reason = caught_from_panic(error.err().expect("custom executable must be refused"));
    assert_eq!(caught_error_code(&reason), Some(string("SC3001")));
    assert!(!children_referenced_pending());
    drop(reason);
    std::fs::remove_dir_all(root).unwrap();
    finish();
}
