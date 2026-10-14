// A compiled script is not a Node CLI. Passing `-e`, a different script,
// or no script to its executable must not silently run the current main
// again. Explicit same-script re-execution keeps the existing argv ABI.
fn child_validate_self_invocation(command: &JsString, arguments: &JsArray<JsString>) {
    let Ok(executable) = std::env::current_exe().and_then(std::fs::canonicalize) else {
        return;
    };
    if std::fs::canonicalize(command.to_utf8_lossy()).is_ok_and(|path| path == executable)
        && !is_self_reexec(command, arguments)
    {
        throw_error_code(
            "executing Node CLI code through the compiled executable is not supported yet; only explicit same-script re-execution is supported".to_owned(),
            "SC3001",
        );
    }
}
