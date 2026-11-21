/* Whole-file primitives shared by native lowering and the node:fs shim. */

/// A supplied descriptor keeps its existing open flags and current position.
pub fn fs_append_file_fd(fd: f64, data: &JsString) {
    use std::io::Write;
    validate_write_fd(fd);
    with_open_file(fd, "write", |file| file.write_all(data.as_bytes()));
}

/// Append UTF-8 bytes with a creation-only mode and optional atomic exclusion.
/// OpenOptions applies the host umask and never chmods an existing file.
pub fn fs_append_file_mode(path: &JsString, data: &JsString, mode: f64, exclusive: bool) {
    use std::io::Write;
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    if !path.is_well_formed() {
        throw_type_error("scriptc: lone UTF-16 append paths are not ported".into());
    }
    let mode = fs_creation_mode(mode);
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true).create_new(exclusive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        if mode & 0o200 == 0 {
            // OPEN_ALWAYS applies creation attributes only when it creates a file.
            options.attributes(1); // FILE_ATTRIBUTE_READONLY
        }
    }
    let mut file = match options.open(path.to_utf8_lossy()) {
        Ok(file) => file,
        Err(error) => throw_fs_append_open_error(path, error),
    };
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
}

pub fn fs_append_file_promise(
    path: &JsString,
    data: &JsString,
    mode: f64,
    exclusive: bool,
) -> JsPromise<()> {
    let path = path.clone();
    let data = data.clone();
    promise_from_sync(move || fs_append_file_mode(&path, &data, mode, exclusive))
}

fn throw_fs_append_open_error(path: &JsString, error: std::io::Error) -> ! {
    #[cfg(windows)]
    let resolved = if path.is_empty() { path.clone() } else { path_win32_resolve(&array_new(vec![path.clone()])) };
    #[cfg(windows)]
    {
        // libuv distinguishes a readonly file from an ACL access denial.
        if error.raw_os_error() == Some(5)
            && std::fs::metadata(path.to_utf8_lossy()).is_ok_and(|m| m.is_file() && m.permissions().readonly())
        {
            throw_error_code(format!("EPERM: operation not permitted, open '{resolved}'"), "EPERM");
        }
    }
    #[cfg(windows)]
    let path = &resolved;
    throw_fs_error("open", path, error)
}

/// The byte-taking half of `fs_append_file`, for callers that already
/// hold a Buffer view: the island's `fs.appendFileSync` resolves its
/// encoding argument in JavaScript and hands the bytes down.
pub fn fs_append_file_bytes(path: &JsString, data: &JsBytes<u8>) {
    use std::io::Write;
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.to_utf8_lossy())
    {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    let result = data.with(|data| {
        let storage = data.storage.borrow();
        file.write_all(&storage[data.offset..data.offset + data.length])
    });
    if let Err(error) = result {
        throw_fs_error("write", path, error);
    }
}

/// `readlink(2)`: the link's target AS WRITTEN, which is what makes it
/// different from `fs_realpath` — that one canonicalizes the whole path,
/// this one reports the single hop and leaves a relative target relative.
pub fn fs_readlink(path: &JsString) -> JsString {
    match std::fs::read_link(path.to_utf8_lossy()) {
        Ok(target) => JsString::from(target.to_string_lossy().as_ref()),
        Err(error) => throw_fs_error("readlink", path, error),
    }
}

pub fn fs_symlink(target: &JsString, path: &JsString, kind: &JsString) {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target.to_utf8_lossy(), path.to_utf8_lossy());
    #[cfg(windows)]
    let result = if matches!(kind.to_utf8_lossy(), "dir" | "junction") {
        std::os::windows::fs::symlink_dir(target.to_utf8_lossy(), path.to_utf8_lossy())
    } else {
        std::os::windows::fs::symlink_file(target.to_utf8_lossy(), path.to_utf8_lossy())
    };
    if let Err(error) = result {
        throw_fs_error("symlink", path, error);
    }
}
