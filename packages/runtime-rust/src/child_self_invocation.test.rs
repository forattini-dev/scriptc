#[test]
fn self_invocation_rejects_node_cli_before_spawning_a_process() {
    let executable = string(&std::env::current_exe().unwrap().to_string_lossy());
    for arguments in [
        vec![],
        vec!["-e", "setInterval(() => {}, 1000)"],
        vec!["--eval=1"],
        vec!["other-script.js"],
    ] {
        let arguments = array_new(arguments.into_iter().map(string).collect());
        let before = ASYNC_CHILDREN.with(|children| children.borrow().len());
        let payload = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            child_spawn(&executable, &arguments)
        })) {
            Err(payload) => payload,
            Ok(_) => panic!("self interpreter invocation was not refused"),
        };
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_code(&caught).as_deref(), Some("SC3001"));
        assert_eq!(
            ASYNC_CHILDREN.with(|children| children.borrow().len()),
            before
        );
    }
}

#[test]
fn self_invocation_keeps_explicit_same_script_reexec_and_external_interpreters() {
    let executable = string(&std::env::current_exe().unwrap().to_string_lossy());
    child_validate_self_invocation(
        &executable,
        &array_new(vec![executable.clone(), string("child-mode")]),
    );
    child_validate_self_invocation(
        &string("node"),
        &array_new(vec![string("-e"), string("console.log(1)")]),
    );
    let command = child_command(
        &executable,
        &array_new(vec![executable.clone(), string("child-mode")]),
        false,
        &string(""),
    )
    .unwrap();
    assert_eq!(
        command.get_args().next(),
        Some(std::ffi::OsStr::new(SELF_REEXEC_MARKER))
    );
}
