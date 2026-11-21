#[derive(Clone)]
pub struct FsDirent {
    identity: Rc<()>,
    pub name: JsString,
    pub kind: f64,
}

impl FsDirent {
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.identity, &other.identity)
    }
}

impl HeapValue for FsDirent {}
impl ArrayElement for FsDirent {}

pub fn fs_dirent_name(value: &FsDirent) -> JsString {
    value.name.clone()
}

pub fn fs_dirent_is_file(value: &FsDirent) -> bool {
    value.kind == 1.0
}

pub fn fs_dirent_is_directory(value: &FsDirent) -> bool {
    value.kind == 2.0
}

pub fn fs_dirent_is_symlink(value: &FsDirent) -> bool {
    value.kind == 3.0
}

pub fn fs_readdir_types(path: &JsString) -> Vec<FsDirent> {
    let entries = match std::fs::read_dir(path.to_utf8_lossy()) {
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
            identity: Rc::new(()),
            name: JsString::from(entry.file_name().to_string_lossy().as_ref()),
            kind,
        });
    }
    rows
}

pub fn fs_readdir_dirents(path: &JsString) -> JsArray<FsDirent> {
    array_new(fs_readdir_types(path))
}

pub fn fs_readdir_dirents_promise(path: &JsString) -> JsPromise<JsArray<FsDirent>> {
    let path = path.clone();
    promise_from_sync(move || fs_readdir_dirents(&path))
}
