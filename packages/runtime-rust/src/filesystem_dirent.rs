pub struct FsDirent {
    pub name: JsString,
    pub kind: f64,
}

pub fn fs_readdir_types(path: &JsString) -> Vec<FsDirent> {
    let entries = match std::fs::read_dir(path.as_ref()) {
        Ok(entries) => entries,
        Err(error) => throw_fs_error("scandir", path, error),
    };
    let mut rows = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => throw_fs_error("scandir", path, error),
        };
        let kind = match entry.file_type() {
            Ok(file_type) if file_type.is_file() => 1.0,
            Ok(file_type) if file_type.is_dir() => 2.0,
            Ok(file_type) if file_type.is_symlink() => 3.0,
            _ => 0.0,
        };
        rows.push(FsDirent {
            name: Rc::from(entry.file_name().to_string_lossy().as_ref()),
            kind,
        });
    }
    rows
}
