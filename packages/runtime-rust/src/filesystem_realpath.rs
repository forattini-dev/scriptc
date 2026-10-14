fn fs_realpath_result(path: &std::path::Path) -> JsString {
    let display = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
            return string(&format!(r"\\{unc}"));
        }
        if let Some(path) = display.strip_prefix(r"\\?\") {
            return string(path);
        }
    }
    string(display.as_ref())
}
