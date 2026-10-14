#[test]
fn child_environment_explicit_pairs_do_not_inherit_arbitrary_parent_writes() {
    let name = string("SCRIPTC_CHILD_ENV_PARENT_ONLY");
    let original = process_env_get(&name);
    process_env_set(&name, &string("not-in-the-child"));
    let mut command = std::process::Command::new("unused");
    child_configure_environment(
        &mut command,
        Some(&array_new(vec![
            string("SCRIPTC_CHILD_ENV_EXPLICIT"),
            string("yes"),
        ])),
    );
    process_env_write(&name, original);
    let env = command.get_envs().collect::<Vec<_>>();
    assert!(
        env.iter()
            .any(|(key, value)| *key == "SCRIPTC_CHILD_ENV_EXPLICIT"
                && value == &Some(std::ffi::OsStr::new("yes")))
    );
    assert!(
        !env.iter()
            .any(|(key, _)| *key == "SCRIPTC_CHILD_ENV_PARENT_ONLY")
    );
}

#[cfg(windows)]
#[test]
fn child_environment_windows_fills_required_keys_but_respects_case_insensitive_overrides() {
    let key = string("SystemRoot");
    let original = process_env_get(&key);
    process_env_set(&key, &string("parent-value"));
    let mut inherited = std::process::Command::new("unused");
    child_configure_environment(&mut inherited, Some(&array_new(Vec::new())));
    let mut overridden = std::process::Command::new("unused");
    child_configure_environment(
        &mut overridden,
        Some(&array_new(vec![
            string("sYsTeMrOoT"),
            string("explicit-value"),
        ])),
    );
    process_env_write(&key, original);
    for (command, expected) in [
        (&inherited, "parent-value"),
        (&overridden, "explicit-value"),
    ] {
        let entries = command
            .get_envs()
            .filter(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case("SYSTEMROOT"))
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].1, Some(std::ffi::OsStr::new(expected)));
    }
}

#[cfg(windows)]
#[test]
fn child_environment_replacement_keeps_node_startable_on_windows() {
    let executable = std::env::var_os("SCRIPTC_NODE_ORACLE").unwrap_or_else(|| "node".into());
    let mut command = std::process::Command::new(executable);
    child_configure_environment(
        &mut command,
        Some(&array_new(vec![
            string("SCRIPTC_CHILD_ENV_EXPLICIT"),
            string("yes"),
        ])),
    );
    let output = command.args([
        "-e", "process.stdout.write(process.env.SCRIPTC_CHILD_ENV_EXPLICIT + ' ' + (typeof process.env.SystemRoot === 'string'))",
    ]).output().expect("spawn Node with an explicit environment");
    assert!(
        output.status.success(),
        "Node failed to initialize: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"yes true");
    assert!(output.stderr.is_empty());
}
