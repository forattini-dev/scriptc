#[cfg(windows)]
fn fs_windows_creation_permissions(file: &std::fs::File, path: &JsString, mode: u32) {
    let mut permissions = file
        .metadata()
        .unwrap_or_else(|error| throw_fs_error("open", path, error))
        .permissions();
    permissions.set_readonly(mode & 0o200 == 0);
    file.set_permissions(permissions)
        .unwrap_or_else(|error| throw_fs_error("open", path, error));
}

#[cfg(windows)]
pub fn fs_chown(_path: &JsString, _uid: f64, _gid: f64) {
    // libuv's Windows chown completes as a no-op even for a missing path.
}

#[cfg(windows)]
pub fn fs_chmod(path: &JsString, mode: f64) {
    let metadata = std::fs::metadata(path.to_utf8_lossy())
        .unwrap_or_else(|error| throw_fs_error("chmod", path, error));
    let mut permissions = metadata.permissions();
    permissions.set_readonly(to_uint32(mode) & 0o200 == 0);
    if let Err(error) = std::fs::set_permissions(path.to_utf8_lossy(), permissions) {
        throw_fs_error("chmod", path, error);
    }
}

#[cfg(windows)]
pub fn fs_access(path: &JsString, mode: f64) {
    let metadata = std::fs::metadata(path.to_utf8_lossy())
        .unwrap_or_else(|error| throw_fs_error("access", path, error));
    // libuv allows R_OK/X_OK for paths visible through GetFileAttributes;
    // W_OK additionally rejects a readonly file (directories ignore it).
    if to_int32(mode) & 2 != 0 && metadata.is_file() && metadata.permissions().readonly() {
        throw_error_code(
            format!("EPERM: operation not permitted, access '{}'", path),
            "EPERM",
        );
    }
}

#[cfg(not(unix))]
pub fn fs_write_file_mode(path: &JsString, data: &JsString, mode: f64) {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    fs_set_creation_mode(&mut options, fs_creation_mode(mode));
    let mut file = options
        .open(path.to_utf8_lossy())
        .unwrap_or_else(|error| throw_fs_error("open", path, error));
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
    #[cfg(windows)]
    fs_windows_creation_permissions(&file, path, fs_creation_mode(mode));
}
