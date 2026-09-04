/* ── embedded file assets (Bun's `with { type: "file" }` loader) ─────────
 * The compiler embeds the asset's bytes at build time (base64 in the
 * generated source); the loader decodes, writes the file under a
 * process-owned scratch directory, and answers the PATH the default
 * binding carries (Bun's file-loader contract — a string path). Node has
 * no counterpart (its ESM loader refuses the extensions), so extraction
 * failures trap: there is no catchable Node-shaped error to reproduce. */

static ASSET_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

fn asset_dir() -> &'static std::path::PathBuf {
    ASSET_DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("scriptc-assets-{}", std::process::id()));
        if let Err(error) = std::fs::create_dir_all(&dir) {
            panic!("scriptc: asset extraction failed: {error}");
        }
        dir
    })
}

fn asset_safe_name(name: &str) -> String {
    // The name rides the compiler's baking — still strip to the basename so
    // no path component can escape the scratch directory.
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    if base.is_empty() || base == "." || base == ".." {
        panic!("scriptc: asset extraction failed: invalid asset name");
    }
    base.to_owned()
}

pub fn asset_file(content_base64: &JsString, name: &JsString) -> JsString {
    let bytes = bytes_base64_decode(content_base64.as_ref());
    let file_name = asset_safe_name(name.as_ref());
    // A content hash prefixes the name: two assets sharing a basename (two
    // packages' icons.png) keep distinct files, and the write is idempotent
    // for repeated imports of one document.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in &bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    let path = asset_dir().join(format!("{hash:016x}-{file_name}"));
    if let Err(error) = std::fs::write(&path, &bytes) {
        panic!("scriptc: asset extraction failed: {error}");
    }
    string(&path.to_string_lossy())
}