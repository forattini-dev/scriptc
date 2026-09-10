/* Whole-file primitives shared by native lowering and the node:fs shim. */

/// Append UTF-8 bytes with a creation-only mode and optional atomic exclusion.
/// OpenOptions applies the host umask and never chmods an existing file.
pub fn fs_append_file_mode(path: &JsString, data: &JsString, mode: f64, exclusive: bool) {
    use std::io::Write;
    let mode = fs_creation_mode(mode);
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true).create_new(exclusive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = match options.open(path.to_utf8_lossy()) {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
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
