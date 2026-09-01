/* Whole-file operations that only the island's `node:fs` shim asks for.
 *
 * They are ordinary filesystem primitives, not island machinery — they
 * live beside filesystem.rs rather than inside it because that file is at
 * its readability cap, the same reason fs_readdir_types sits in
 * filesystem_dirent.rs. A static lowering may reach for either of these
 * later without moving them.
 */

/// The byte-taking half of `fs_append_file`, for callers that already
/// hold a Buffer view: the island's `fs.appendFileSync` resolves its
/// encoding argument in JavaScript and hands the bytes down.
pub fn fs_append_file_bytes(path: &JsString, data: &JsBytes<u8>) {
    use std::io::Write;
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.as_ref())
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
    match std::fs::read_link(path.as_ref()) {
        Ok(target) => Rc::from(target.to_string_lossy().as_ref()),
        Err(error) => throw_fs_error("readlink", path, error),
    }
}
