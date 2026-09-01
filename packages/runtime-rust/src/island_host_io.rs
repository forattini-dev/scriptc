/* The I/O half of the island's host bridge: fs, crypto, zlib and os.
 *
 * island_host.rs answers the questions that cannot fail — the process
 * snapshot, path algebra, the promise state. This file answers the ones
 * that reach the operating system, and that changes two things.
 *
 * FIRST, every call here delegates to the SAME runtime primitive the
 * static lane lowers to: the island's `fs.readFileSync` and a compiled
 * `fs.readFileSync` are both `fs_read_file_bytes`, its `createHash` and a
 * compiled `createHash` are both ring through `crypto_digest_raw`. The
 * island is a different engine, not a different runtime.
 *
 * SECOND, these primitives THROW, and a scriptc throw is an unwinding
 * panic carrying a thread-local payload — not something boa knows how to
 * catch. Left alone it would unwind straight through the engine's frames
 * and out of the island entirely, which would make `fs.existsSync`'s
 * try/catch and `statSync({throwIfNoEntry: false})`'s `e.code` check
 * unreachable. So every primitive call goes through `island_host_guard`,
 * which catches the unwind and rebuilds it as an ENGINE error object
 * carrying Node's errno-name `code`. That conversion is the contract the
 * shared JavaScript in island-js/04-fs.js is written against.
 */

/// Run a runtime primitive that may throw, catching the unwind.
///
/// The runtime throws with `resume_unwind`, which deliberately does NOT
/// run the panic hook, so a caught scriptc error prints nothing. A real
/// Rust panic still carries a foreign payload, and `caught_from_panic`
/// re-raises those untouched — this guard converts scriptc throws only.
///
/// `AssertUnwindSafe` is sound here because the closure never captures
/// the engine `Context`: arguments are read out before the call and the
/// answer is marshalled after it, so no engine state is observed across
/// the unwind.
fn island_host_guard<T>(body: impl FnOnce() -> T) -> Result<T, Caught> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).map_err(caught_from_panic)
}

/// Rebuild a caught scriptc error as an engine error.
///
/// The name picks the engine's own constructor so `e instanceof TypeError`
/// narrows inside island JavaScript, and the scriptc `code` — the errno
/// NAME for fs, `Z_*` for zlib — is stamped on as an own property,
/// because that is the only field the shims actually read.
fn island_host_error(caught: &Caught, context: &mut Context) -> BoaJsError {
    // Every primitive reachable from this bridge throws a JsError; a bare
    // value would mean a runtime unit grew a new throw shape, so say that
    // rather than raising `undefined` as the exception.
    if !caught_is_error(caught) {
        return boa_engine::JsNativeError::error()
            .with_message("scriptc: the island host caught a non-Error throw")
            .into();
    }
    let native = match caught_error_name(caught).as_ref() {
        "TypeError" => boa_engine::JsNativeError::typ(),
        "RangeError" => boa_engine::JsNativeError::range(),
        "ReferenceError" => boa_engine::JsNativeError::reference(),
        "SyntaxError" => boa_engine::JsNativeError::syntax(),
        _ => boa_engine::JsNativeError::error(),
    };
    // `with_message` wants an owned or 'static message; the caught one is
    // reference-counted crate storage, so hand it a copy.
    let message = caught_error_message(caught).to_string();
    let object = native.with_message(message).into_opaque(context);
    if let Some(code) = caught_error_code(caught) {
        let stamped = object.set(
            js_string!("code"),
            JsValue::from(boa_engine::JsString::from(code.as_ref())),
            false,
            context,
        );
        // A failed stamp would leave a code-less error; the shims read
        // `code` to decide whether to rethrow, so surface that instead.
        if let Err(error) = stamped {
            return error;
        }
    }
    BoaJsError::from_opaque(object.into())
}

/// `island_host_guard` plus the conversion, for the common call shape.
fn island_host_run<T>(body: impl FnOnce() -> T, context: &mut Context) -> JsResult<T> {
    island_host_guard(body).map_err(|caught| island_host_error(&caught, context))
}

/* ── byte marshalling ──────────────────────────────────────────────── */

/// `arguments[index]` as runtime bytes. The island's shims always hand a
/// real Uint8Array down (their own `toU8`/`dataToU8` normalize first), so
/// anything else is a bridge contract break rather than a user error.
fn island_host_arg_bytes(
    arguments: &[JsValue],
    index: usize,
    context: &mut Context,
) -> JsResult<JsBytes<u8>> {
    let value = island_host_arg(arguments, index);
    let array = value
        .as_object()
        .and_then(|object| BoaJsUint8Array::from_object(object).ok())
        .ok_or_else(|| {
            boa_engine::JsNativeError::typ()
                .with_message("the island host expects a Uint8Array argument")
        })?;
    Ok(bytes_from_vec(array.to_vec(context)?))
}

/// Runtime bytes as a `Uint8Array` in the island's realm.
fn island_host_bytes(bytes: &JsBytes<u8>, context: &mut Context) -> JsResult<JsValue> {
    Ok(BoaJsUint8Array::from_iter(bytes_u8_values(bytes), context)?.into())
}

/* ── fs ────────────────────────────────────────────────────────────── */

/// What one `host.fs` operation produced, held OUTSIDE the engine so the
/// primitive can run inside `island_host_guard` without borrowing the
/// context across the unwind.
enum IslandFsAnswer {
    Nothing,
    Bool(bool),
    Text(JsString),
    Bytes(JsBytes<u8>),
    Names(JsArray<JsString>),
    Entries(Vec<FsDirent>),
    Stats(JsStats),
}

/// The eight-element `stat` row the shared `Stats` class reads.
///
/// The ORDER is the contract, and it is not the obvious one: mtime comes
/// before blocks and nlink, and atime is last. island-js/04-fs.js indexes
/// this row positionally, as does the C island's `isl_host_fs`.
fn island_fs_stats_row(stats: &JsStats, context: &mut Context) -> JsValue {
    let row = [
        JsValue::from(stats_is_file(stats)),
        JsValue::from(stats_is_directory(stats)),
        JsValue::from(stats_is_symlink(stats)),
        JsValue::from(stats_size(stats)),
        JsValue::from(stats_mtime_ms(stats)),
        JsValue::from(stats_blocks(stats)),
        JsValue::from(stats_nlink(stats)),
        JsValue::from(stats_atime_ms(stats)),
    ];
    BoaJsArray::from_iter(row, context).into()
}

/// `scandir`'s flat `[name, kind, name, kind, …]` array.
///
/// The kind integers are libuv's `UV_DIRENT_*` numbering, which the
/// shared `Dirent` class switches on: 1 file, 2 directory, 3 symlink,
/// 0 unknown. This runtime's `fs_readdir_types` does not distinguish
/// FIFOs, sockets or devices (4–7), so those arrive as 0 and every
/// `Dirent` predicate answers false — a narrower answer than the C
/// island's, never a wrong one.
fn island_fs_entries(entries: &[FsDirent], context: &mut Context) -> JsValue {
    let mut flat = Vec::with_capacity(entries.len() * 2);
    for entry in entries {
        flat.push(island_host_string(&entry.name));
        flat.push(JsValue::from(entry.kind));
    }
    BoaJsArray::from_iter(flat, context).into()
}

/// `host.fs(op, ...)` — the operation-string dispatcher, mirroring the C
/// island's `isl_host_fs`. The shim keeps path coercion, encodings,
/// Stats/Dirent shaping and the callback/promise spellings in JavaScript;
/// only the syscall crosses here.
fn island_host_fs(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let operation = island_host_arg_string(arguments, 0, context)?;
    // Every op but `mkdtemp` takes a path first, and mkdtemp's prefix
    // reads the same slot, so one conversion serves all of them.
    let path: JsString = Rc::from(island_host_arg_string(arguments, 1, context)?.as_str());
    let number = |index: usize, context: &mut Context| island_host_arg_number(arguments, index, context);

    let answer = match operation.as_str() {
        "readFile" => {
            island_host_run(|| IslandFsAnswer::Bytes(fs_read_file_bytes(&path)), context)?
        }
        "writeFile" => {
            let data = island_host_arg_bytes(arguments, 2, context)?;
            island_host_run(|| {
                fs_write_file_bytes(&path, &data);
                IslandFsAnswer::Nothing
            }, context)?
        }
        "appendFile" => {
            let data = island_host_arg_bytes(arguments, 2, context)?;
            island_host_run(|| {
                fs_append_file_bytes(&path, &data);
                IslandFsAnswer::Nothing
            }, context)?
        }
        // `exists` is the one op that cannot fail: it is an access(2)
        // probe, and the shim's try/catch would swallow a throw anyway.
        "exists" => IslandFsAnswer::Bool(fs_exists(&path)),
        "realpath" => {
            island_host_run(|| IslandFsAnswer::Text(fs_realpath(&path)), context)?
        }
        "mkdir" => {
            // mode < 0 is the shim's "no explicit mode" sentinel.
            let recursive = number(2, context)? != 0.0;
            let mode = number(3, context)?;
            island_host_run(|| {
                if mode < 0.0 {
                    if recursive { fs_mkdir_recursive(&path) } else { fs_mkdir(&path) }
                } else {
                    fs_mkdir_mode(&path, mode, recursive);
                }
                IslandFsAnswer::Nothing
            }, context)?
        }
        "rm" => {
            let recursive = number(2, context)? != 0.0;
            let force = number(3, context)? != 0.0;
            island_host_run(|| {
                fs_rm_options(&path, recursive, force);
                IslandFsAnswer::Nothing
            }, context)?
        }
        "rmdir" => {
            island_host_run(|| {
                fs_rmdir(&path);
                IslandFsAnswer::Nothing
            }, context)?
        }
        "unlink" => {
            island_host_run(|| {
                fs_unlink(&path);
                IslandFsAnswer::Nothing
            }, context)?
        }
        "readdir" => {
            island_host_run(|| IslandFsAnswer::Names(fs_readdir(&path)), context)?
        }
        "scandir" => {
            island_host_run(|| IslandFsAnswer::Entries(fs_readdir_types(&path)), context)?
        }
        "stat" => {
            island_host_run(|| IslandFsAnswer::Stats(fs_stat(&path, true)), context)?
        }
        "lstat" => {
            island_host_run(|| IslandFsAnswer::Stats(fs_stat(&path, false)), context)?
        }
        "access" => {
            let mode = number(2, context)?;
            island_host_run(|| {
                fs_access(&path, mode);
                IslandFsAnswer::Nothing
            }, context)?
        }
        "mkdtemp" => {
            island_host_run(|| IslandFsAnswer::Text(fs_mkdtemp(&path)), context)?
        }
        "chmod" => {
            let mode = number(2, context)?;
            island_host_run(|| {
                fs_chmod(&path, mode);
                IslandFsAnswer::Nothing
            }, context)?
        }
        "readlink" => {
            island_host_run(|| IslandFsAnswer::Text(fs_readlink(&path)), context)?
        }
        "copyFile" => {
            let destination: JsString = Rc::from(island_host_arg_string(arguments, 2, context)?.as_str());
            island_host_run(|| {
                fs_copy_file(&path, &destination);
                IslandFsAnswer::Nothing
            }, context)?
        }
        "rename" => {
            let destination: JsString = Rc::from(island_host_arg_string(arguments, 2, context)?.as_str());
            island_host_run(|| {
                fs_rename(&path, &destination);
                IslandFsAnswer::Nothing
            }, context)?
        }
        _ => {
            return Err(boa_engine::JsNativeError::reference()
                .with_message("unknown island fs op")
                .into());
        }
    };

    Ok(match answer {
        IslandFsAnswer::Nothing => JsValue::undefined(),
        IslandFsAnswer::Bool(value) => JsValue::from(value),
        IslandFsAnswer::Text(value) => island_host_string(&value),
        IslandFsAnswer::Bytes(value) => island_host_bytes(&value, context)?,
        IslandFsAnswer::Names(value) => island_host_string_array(&value, context),
        IslandFsAnswer::Entries(value) => island_fs_entries(&value, context),
        IslandFsAnswer::Stats(value) => island_fs_stats_row(&value, context),
    })
}

/// `host.fsConstants()` — the `fs.constants` object, shared with
/// `node:constants`.
///
/// The C island reads the target's real macros; this crate has no libc
/// dependency, so the values are spelled out per platform instead. They
/// are ABI constants, not implementation choices — the risk of drift is
/// in the O_* set, which is why linux and macOS are separate arms rather
/// than one "unix" arm.
fn island_host_fs_constants(
    _this: &JsValue,
    _arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    #[cfg(target_os = "macos")]
    const OPEN_FLAGS: [(&str, i32); 8] = [
        ("O_RDONLY", 0), ("O_WRONLY", 1), ("O_RDWR", 2), ("O_CREAT", 0x200),
        ("O_EXCL", 0x800), ("O_TRUNC", 0x400), ("O_APPEND", 8), ("O_NONBLOCK", 4),
    ];
    #[cfg(not(target_os = "macos"))]
    const OPEN_FLAGS: [(&str, i32); 8] = [
        ("O_RDONLY", 0), ("O_WRONLY", 1), ("O_RDWR", 2), ("O_CREAT", 64),
        ("O_EXCL", 128), ("O_TRUNC", 512), ("O_APPEND", 1024), ("O_NONBLOCK", 2048),
    ];

    let mut constants = ObjectInitializer::new(context);
    let put = |name: &str, value: i32, constants: &mut ObjectInitializer<'_>| {
        constants.property(
            boa_engine::JsString::from(name),
            JsValue::from(value),
            Attribute::WRITABLE | Attribute::ENUMERABLE | Attribute::CONFIGURABLE,
        );
    };
    for (name, value) in [("F_OK", 0), ("R_OK", 4), ("W_OK", 2), ("X_OK", 1)] {
        put(name, value, &mut constants);
    }
    for (name, value) in OPEN_FLAGS {
        put(name, value, &mut constants);
    }
    // The file-type bits the shared Stats class turns back into `mode`.
    for (name, value) in [
        ("S_IFMT", 0o170000), ("S_IFREG", 0o100000), ("S_IFDIR", 0o040000),
        ("S_IFCHR", 0o020000), ("S_IFLNK", 0o120000), ("S_IFIFO", 0o010000),
        ("S_IFSOCK", 0o140000), ("S_IFBLK", 0o060000),
    ] {
        put(name, value, &mut constants);
    }
    for (name, value) in [
        ("COPYFILE_EXCL", 1), ("COPYFILE_FICLONE", 2), ("COPYFILE_FICLONE_FORCE", 4),
    ] {
        put(name, value, &mut constants);
    }
    Ok(constants.build().into())
}

/* ── crypto ────────────────────────────────────────────────────────── */

/// `host.digest(alg, bytes)` → the raw digest, or `undefined` for an
/// algorithm this runtime does not carry.
///
/// `undefined` is a RETURN, never a throw: the shared crypto shim probes
/// with an empty input (`env.digest(alg, new Uint8Array(0)) === undefined`)
/// and raises Node's own "Digest method not supported" itself. Node's
/// `md5` takes that path here — ring does not carry it — so the island
/// refuses it out loud instead of answering wrongly.
fn island_host_digest(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let algorithm: JsString = Rc::from(island_host_arg_string(arguments, 0, context)?.as_str());
    let data = island_host_arg_bytes(arguments, 1, context)?;
    let digest = island_host_run(|| crypto_digest_raw(&algorithm, &data), context)?;
    match digest {
        Some(digest) => island_host_bytes(&digest, context),
        None => Ok(JsValue::undefined()),
    }
}

/// `host.hmac(alg, key, bytes)`, with the same `undefined` fence.
fn island_host_hmac(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let algorithm: JsString = Rc::from(island_host_arg_string(arguments, 0, context)?.as_str());
    let key = island_host_arg_bytes(arguments, 1, context)?;
    let data = island_host_arg_bytes(arguments, 2, context)?;
    let tag = island_host_run(|| crypto_hmac_raw(&algorithm, &key, &data), context)?;
    match tag {
        Some(tag) => island_host_bytes(&tag, context),
        None => Ok(JsValue::undefined()),
    }
}

/* ── zlib ──────────────────────────────────────────────────────────── */

/// `host.zlib(deflating, bytes, mode, level)`.
///
/// `deflating` is 1 to compress and 0 to expand; `mode` selects the
/// framing — 0 zlib, 1 raw, 2 gzip, 3 auto-detect. Mode 3 only ever
/// arrives with `deflating = 0` (it is `unzip`, which sniffs zlib vs
/// gzip); compressing under it falls back to zlib framing, as the C
/// island's windowBits table does.
///
/// DIVERGENCE: `level` is accepted and ignored. This runtime's zlib unit
/// is flate2 with its default compression, so a level request changes
/// nothing. Every output still decompresses to the same bytes — only the
/// compressed size can differ from Node's.
fn island_host_zlib(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let deflating = island_host_arg_number(arguments, 0, context)? != 0.0;
    let data = island_host_arg_bytes(arguments, 1, context)?;
    let mode = island_host_arg_number(arguments, 2, context)?;
    let _level = island_host_arg_number(arguments, 3, context)?;
    let output = island_host_run(
        || match (deflating, mode as i32) {
            (true, 1) => zlib_deflate_raw_sync(&data),
            (true, 2) => zlib_gzip_sync(&data),
            (true, _) => zlib_deflate_sync(&data),
            (false, 1) => zlib_inflate_raw_sync(&data),
            (false, 2) => zlib_gunzip_sync(&data),
            (false, 3) => zlib_unzip_sync(&data),
            (false, _) => zlib_inflate_sync(&data),
        },
        context,
    )?;
    island_host_bytes(&output, context)
}

/* ── os ────────────────────────────────────────────────────────────── */

fn island_host_arch(
    _this: &JsValue,
    _arguments: &[JsValue],
    _c: &mut Context,
) -> JsResult<JsValue> {
    Ok(island_host_string(&process_arch()))
}

fn island_host_hostname(
    _this: &JsValue,
    _arguments: &[JsValue],
    _c: &mut Context,
) -> JsResult<JsValue> {
    Ok(island_host_string(&os_hostname()))
}

fn island_host_homedir(
    _this: &JsValue,
    _arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    // os_homedir throws when every fallback fails, so it takes the guard.
    let home = island_host_run(os_homedir, context)?;
    Ok(island_host_string(&home))
}

fn island_host_tmpdir(
    _this: &JsValue,
    _arguments: &[JsValue],
    _c: &mut Context,
) -> JsResult<JsValue> {
    Ok(island_host_string(&os_tmpdir()))
}

/// `host.ids()` → `[uid, gid]`, the pair `os.userInfo()` reads.
fn island_host_ids(
    _this: &JsValue,
    _arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let ids = [
        JsValue::from(process_getuid()),
        JsValue::from(process_getgid()),
    ];
    Ok(BoaJsArray::from_iter(ids, context).into())
}

/// `host.signals()` → `os.constants.signals`, verbatim.
///
/// Spelled out per platform for the same reason `fsConstants` is: these
/// are the target's real signal numbers and the crate has no libc to ask.
/// Only the names the C island emits appear, and only where they exist.
fn island_host_signals(
    _this: &JsValue,
    _arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    #[cfg(target_os = "macos")]
    const SIGNALS: [(&str, i32); 29] = [
        ("SIGHUP", 1), ("SIGINT", 2), ("SIGQUIT", 3), ("SIGILL", 4), ("SIGTRAP", 5),
        ("SIGABRT", 6), ("SIGFPE", 8), ("SIGKILL", 9), ("SIGBUS", 10), ("SIGSEGV", 11),
        ("SIGSYS", 12), ("SIGPIPE", 13), ("SIGALRM", 14), ("SIGTERM", 15), ("SIGURG", 16),
        ("SIGSTOP", 17), ("SIGTSTP", 18), ("SIGCONT", 19), ("SIGCHLD", 20), ("SIGTTIN", 21),
        ("SIGTTOU", 22), ("SIGIO", 23), ("SIGXCPU", 24), ("SIGXFSZ", 25), ("SIGVTALRM", 26),
        ("SIGPROF", 27), ("SIGWINCH", 28), ("SIGUSR1", 30), ("SIGUSR2", 31),
    ];
    #[cfg(all(unix, not(target_os = "macos")))]
    const SIGNALS: [(&str, i32); 29] = [
        ("SIGHUP", 1), ("SIGINT", 2), ("SIGQUIT", 3), ("SIGILL", 4), ("SIGTRAP", 5),
        ("SIGABRT", 6), ("SIGBUS", 7), ("SIGFPE", 8), ("SIGKILL", 9), ("SIGUSR1", 10),
        ("SIGSEGV", 11), ("SIGUSR2", 12), ("SIGPIPE", 13), ("SIGALRM", 14), ("SIGTERM", 15),
        ("SIGCHLD", 17), ("SIGCONT", 18), ("SIGSTOP", 19), ("SIGTSTP", 20), ("SIGTTIN", 21),
        ("SIGTTOU", 22), ("SIGURG", 23), ("SIGXCPU", 24), ("SIGXFSZ", 25), ("SIGVTALRM", 26),
        ("SIGPROF", 27), ("SIGWINCH", 28), ("SIGIO", 29), ("SIGSYS", 31),
    ];
    // Windows carries only the ISO C signals Node reports.
    #[cfg(not(unix))]
    const SIGNALS: [(&str, i32); 6] = [
        ("SIGINT", 2), ("SIGILL", 4), ("SIGABRT", 6), ("SIGFPE", 8),
        ("SIGSEGV", 11), ("SIGTERM", 15),
    ];

    let mut signals = ObjectInitializer::new(context);
    for (name, number) in SIGNALS {
        signals.property(
            boa_engine::JsString::from(name),
            JsValue::from(number),
            Attribute::WRITABLE | Attribute::ENUMERABLE | Attribute::CONFIGURABLE,
        );
    }
    Ok(signals.build().into())
}
