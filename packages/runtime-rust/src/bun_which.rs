/// Bun 1.3.14's executable lookup. Never starts a shell or the found program.
pub fn bun_which(
    command: &JsString,
    path: Option<&JsString>,
    cwd: Option<&JsString>,
) -> Option<JsString> {
    let command = command.to_utf8_lossy();
    if command.len() >= if cfg!(windows) { 32767 * 3 + 1 } else { 4096 } {
        throw_error("bin path is too long".to_owned());
    }
    if command.is_empty() {
        return None;
    }
    // Bun passes NUL-terminated paths to the OS, including embedded NULs.
    // Bun's transpiler environment retains its startup PATH. process.env
    // mutations must not change this default (options.PATH still overrides it).
    let path = path.cloned().unwrap_or_else(|| {
        JsString::from(
            std::env::var_os("PATH")
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
        )
    });
    let cwd = cwd.cloned().unwrap_or_else(process_cwd);
    bun_which_search(command, path.to_utf8_lossy(), cwd.to_utf8_lossy()).map(JsString::from)
}

#[cfg(not(windows))]
fn bun_which_search(command: &str, path: &str, cwd: &str) -> Option<String> {
    let valid = |candidate: String| -> Option<String> {
        if candidate.len() + 1 > 4096 {
            return None;
        }
        let os_path = candidate.split('\0').next().unwrap_or("");
        if !std::fs::metadata(os_path).is_ok_and(|metadata| metadata.is_file()) {
            return None;
        }
        #[cfg(unix)]
        if rustix::fs::access(os_path, rustix::fs::Access::EXEC_OK).is_err() {
            return None;
        }
        Some(candidate)
    };
    if command.starts_with('/') {
        return valid(command.to_owned());
    }
    if command.contains('/') {
        return (!cwd.is_empty())
            .then(|| {
                format!(
                    "{}/{}",
                    cwd.trim_end_matches('/'),
                    command.strip_prefix("./").unwrap_or(command)
                )
            })
            .and_then(valid);
    }
    path.split(':')
        .filter(|segment| !segment.is_empty())
        .find_map(|segment| valid(format!("{segment}/{command}")))
}

#[cfg(windows)]
fn bun_which_search(command: &str, path: &str, cwd: &str) -> Option<String> {
    let has_extension = [".exe", ".cmd", ".bat"]
        .iter()
        .any(|extension| command.to_ascii_lowercase().ends_with(extension));
    let valid = |candidate: String| -> Option<String> {
        let variants = if has_extension {
            vec![candidate]
        } else {
            ["exe", "cmd", "bat"]
                .iter()
                .map(|extension| format!("{candidate}.{extension}"))
                .collect()
        };
        variants.into_iter().find(|variant| {
            std::fs::metadata(variant.split('\0').next().unwrap_or(""))
                .is_ok_and(|metadata| metadata.is_file())
        })
    };
    let normalize = |value: &str| {
        String::from_utf8_lossy(&normalize_windows_path(value.as_bytes())).into_owned()
    };
    let join = |directory: &str, bin: &str| {
        let directory = if std::path::Path::new(directory).is_absolute() {
            normalize(directory)
        } else {
            directory.to_owned()
        };
        format!("{}\\{bin}", directory.trim_end_matches(['/', '\\']))
    };
    if std::path::Path::new(command).is_absolute() {
        return valid(normalize(command));
    }
    if command.contains(['/', '\\']) {
        return (!cwd.is_empty())
            .then(|| join(cwd, command.strip_prefix("./").unwrap_or(command)))
            .and_then(valid)
            .map(|value| value.replace('/', "\\"));
    }
    path.split(';')
        .filter(|segment| !segment.is_empty())
        .find_map(|segment| valid(join(segment, command)))
}
