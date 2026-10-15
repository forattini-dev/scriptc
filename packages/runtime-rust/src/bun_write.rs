// Pinned Bun 1.3.14: short strings use UTF-16 length, byte inputs use byte
// length. Windows skips the fast path; empty writes still truncate immediately.
const BUN_WRITE_FAST_LIMIT: usize = 256 * 1024;

struct BunWriteFailure {
    error: std::io::Error,
    operation: &'static str,
}

pub fn bun_write_text(path: &JsString, data: &JsString) -> JsPromise<f64> {
    bun_file_path(path);
    bun_write_owned(
        path,
        data.to_utf8_lossy().as_bytes().to_vec(),
        string_len(data) < BUN_WRITE_FAST_LIMIT as f64,
    )
}

pub fn bun_write_bytes(path: &JsString, data: &JsBytes<u8>) -> JsPromise<f64> {
    bun_file_path(path);
    let bytes = bytes_values(data);
    let fast = bytes.len() < BUN_WRITE_FAST_LIMIT;
    bun_write_owned(path, bytes, fast)
}

fn bun_write_owned(path: &JsString, bytes: Vec<u8>, fast: bool) -> JsPromise<f64> {
    let promise = promise_new();
    if !cfg!(windows) && fast {
        let result = bun_write_io(path.to_utf8_lossy(), &bytes, false, true);
        // A missing parent falls back to the asynchronous writer, even for
        // short data. Empty sources instead use Bun's synchronous truncate path.
        if !matches!(&result, Err(failure) if failure.error.kind() == std::io::ErrorKind::NotFound)
        {
            bun_write_settle(path, &promise, result);
            return promise;
        }
    }
    if bytes.is_empty() {
        bun_write_settle(
            path,
            &promise,
            bun_write_io(path.to_utf8_lossy(), &bytes, true, false),
        );
    } else {
        bun_file_enqueue(
            path,
            BunFileOperation::Write(bytes),
            BunFilePending::Write(path.clone(), promise.clone()),
        );
    }
    promise
}

fn bun_write_io(
    path: &str,
    bytes: &[u8],
    create_parent: bool,
    fast: bool,
) -> Result<usize, BunWriteFailure> {
    use std::io::{Error, ErrorKind, Write};
    let failure = |error, operation| BunWriteFailure { error, operation };
    if path.is_empty() {
        return Err(failure(
            Error::from(ErrorKind::NotFound),
            if bytes.is_empty() && !fast {
                "truncate"
            } else if cfg!(windows) {
                "mkdir"
            } else {
                "open"
            },
        ));
    }
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(if cfg!(windows) && bytes.is_empty() {
            failure(Error::from(ErrorKind::InvalidInput), "truncate")
        } else {
            failure(Error::from(ErrorKind::IsADirectory), "open")
        });
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if fast { 0o664 } else { 0o666 });
    }
    let file = options.open(path);
    let mut file = match file {
        Ok(file) => file,
        Err(error)
            if create_parent
                && (error.kind() == ErrorKind::NotFound
                    || (cfg!(windows) && error.kind() == ErrorKind::NotADirectory)) =>
        {
            if let Some(parent) = std::path::Path::new(path)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent).map_err(|error| failure(error, "mkdir"))?;
            }
            options.open(path).map_err(|error| failure(error, "open"))?
        }
        Err(error) => return Err(failure(error, "open")),
    };
    file.write_all(bytes)
        .map_err(|error| failure(error, "write"))?;
    Ok(bytes.len())
}

fn bun_write_error(path: &JsString, failure: BunWriteFailure) -> JsError {
    let code = fs_error_code(&failure.error);
    let suffix = if path.to_utf8_lossy().is_empty() {
        String::new()
    } else {
        format!(" '{path}'")
    };
    error_new_code(
        "Error",
        string(&format!(
            "{code}: {}, {}{suffix}",
            fs_error_text(&failure.error),
            failure.operation
        )),
        code,
    )
}

fn bun_write_settle(
    path: &JsString,
    promise: &JsPromise<f64>,
    result: Result<usize, BunWriteFailure>,
) {
    match result {
        Ok(count) => {
            let _ = promise_fulfill(promise, count as f64);
        }
        Err(error) => {
            let _ = promise_reject(promise, caught_value(bun_write_error(path, error)));
        }
    }
}

fn bun_write_complete(path: &JsString, promise: &JsPromise<f64>, result: BunFileResult) {
    let result = match result {
        BunFileResult::Write(result) => result,
        BunFileResult::Unavailable => Err(BunWriteFailure {
            error: std::io::Error::new(
                std::io::ErrorKind::ResourceBusy,
                "could not create Bun file worker",
            ),
            operation: "open",
        }),
        _ => unreachable!("scriptc: Bun write completion type mismatch"),
    };
    bun_write_settle(path, promise, result);
}
