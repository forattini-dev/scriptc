use super::*;
pub(super) fn internal() -> Vec<Builtin> {
    let mut internal = vec![Builtin {
        ir: "fs.openNumericPromise",
        args: vec![String, Type::F64, Type::F64],
        result: Type::Promise {
            inner: Box::new(Type::Dyn),
        },
        implementation: Implementation::Emitter("filesystem-open-numeric-promise"),
    }];
    // Erased descriptor operations (Node callback forms and dynamic
    // writeSync data). They take their JavaScript arguments as one dynamic
    // vector; no public API claim is attached to these transports.
    for (ir, helper) in [
        ("fs.callbackOpen", "native_fs_callback_open"),
        ("fs.callbackWrite", "native_fs_callback_write"),
        ("fs.callbackClose", "native_fs_callback_close"),
        ("fs.callbackFsync", "native_fs_callback_fsync"),
        ("fs.callbackMkdir", "native_fs_callback_mkdir"),
        ("fs.dynamicWriteSync", "native_fs_dynamic_write_sync"),
        ("fs.dynamicFsyncSync", "native_fs_dynamic_fsync_sync"),
    ] {
        internal.push(Builtin {
            ir,
            args: vec![Type::Array {
                elem: Box::new(Type::Dyn),
            }],
            result: Type::Dyn,
            implementation: Implementation::NativeHelper(helper),
        });
    }
    internal
}

pub(super) fn apis() -> Vec<Api> {
    vec![
        Api::native(
            "fs",
            "createWriteStream",
            Lowering::Direct,
            vec![
                Builtin {
                    ir: "fs.createWriteStream",
                    args: vec![String, Type::Dyn],
                    result: Type::Dyn,
                    implementation: Implementation::Emitter("values"),
                },
                Builtin {
                    ir: "fs.createWriteStreamPath",
                    args: vec![String],
                    result: Type::Dyn,
                    implementation: Implementation::Emitter("values"),
                },
            ],
            "String path with omitted options, an encoding string, or represented options with flags: 'w' (the default); native queued writes, drain, error and end callbacks",
            &[
                "tests/corpus/rust-native-platform/write-stream.ts",
                "tests/corpus/rust-native-write-stream-default/main.cjs",
            ],
        ),
        Api::native(
            "fs",
            "existsSync",
            Lowering::Direct,
            vec![call!("fs.existsSync", [String], Bool, "fs_exists")],
            "One represented string path; Buffer/URL paths and other overloads refused",
            &["tests/corpus/rust-native-platform/mkdir.ts"],
        ),
        Api::native(
            "fs",
            "readdirSync",
            Lowering::ReadDirectory,
            vec![
                call!("fs.readdirSync", [String], strings(), "fs_readdir"),
                call!(
                    "fs.readdirDirentsSync",
                    [String],
                    Type::Array {
                        elem: Box::new(Type::Dirent)
                    },
                    "fs_readdir_dirents"
                ),
                call!("dirent.name", [Type::Dirent], String, "fs_dirent_name"),
                call!("dirent.isFile", [Type::Dirent], Bool, "fs_dirent_is_file"),
                call!(
                    "dirent.isDirectory",
                    [Type::Dirent],
                    Bool,
                    "fs_dirent_is_directory"
                ),
                call!(
                    "dirent.isSymbolicLink",
                    [Type::Dirent],
                    Bool,
                    "fs_dirent_is_symlink"
                ),
            ],
            "A represented string path returning native string names, or a plain literal { withFileTypes: true } returning owning native Dirent snapshots. Buffer/URL paths, encodings, recursive reads and other options are refused",
            &[
                "tests/corpus/rust-native-platform/readdir.ts",
                "tests/corpus/rust-native-platform/readdir-dirent.ts",
            ],
        ),
        Api::native(
            "fs",
            "readlinkSync",
            Lowering::Direct,
            vec![call!("fs.readlinkSync", [String], String, "fs_readlink")],
            "One represented string path returning the symbolic link target as written; Buffer/URL paths, encodings and extra arguments are refused",
            &["tests/corpus/5167-fs-readlink-sync.ts"],
        ),
        Api::native(
            "fs",
            "createReadStream",
            Lowering::Direct,
            vec![call!(
                "fs.createReadStreamChunks",
                [String],
                Type::Array {
                    elem: Box::new(Type::bytes())
                },
                "fs_read_stream_chunks"
            )],
            "One represented string path snapshotted into ordered 64 KiB native byte chunks for direct for-await consumption; options, events and independently exposed stream objects are not ported",
            &["tests/corpus/rust-native-platform/read-stream.ts"],
        ),
        Api::native(
            "fs",
            "globSync",
            Lowering::Glob,
            vec![call!(
                "fs.globSync",
                [String, String, strings()],
                strings(),
                "fs_glob_sync"
            )],
            "A represented relative string pattern and plain inline options with a represented string cwd and optional represented string-array exclude. Native traversal supports *, ? and **, prunes excluded directory trees, does not follow directory symlinks, and returns deterministic relative string paths. URL cwd, Dirent results, brace/extglob syntax, accessors and spreads are refused",
            &["tests/corpus/rust-native-platform/glob.ts"],
        ),
        Api::native(
            "fs",
            "mkdtempSync",
            Lowering::Direct,
            vec![call!("fs.mkdtempSync", [String], String, "fs_mkdtemp")],
            "One represented string prefix; creates a unique directory atomically and returns its path",
            &["tests/corpus/1424-fs-options.ts"],
        ),
        Api::native(
            "fs",
            "mkdirSync",
            Lowering::Directory,
            vec![
                call!("fs.mkdirSync", [String], Type::Void, "fs_mkdir"),
                call!(
                    "fs.mkdirModeSync",
                    [String, Type::F64],
                    Type::Void,
                    "fs_mkdir_mode_sync"
                ),
                call!(
                    "fs.mkdirRecursiveSync",
                    [String],
                    Type::Void,
                    "fs_mkdir_recursive"
                ),
                call!(
                    "fs.mkdirRecursiveModeSync",
                    [String, Type::F64],
                    Type::Void,
                    "fs_mkdir_recursive_mode_sync"
                ),
            ],
            "Statement effects only; well-formed UTF-16 string paths; numeric mode or plain inline options with literal recursive and numeric mode; observed return values, dynamic options and spreads refused",
            &["tests/corpus/rust-native-platform/mkdir.ts"],
        ),
        Api::native(
            "fs",
            "readFileSync",
            Lowering::ReadFile,
            vec![
                call!(
                    "fs.readFileSync",
                    [String, String],
                    String,
                    "fs_read_file_encoded"
                ),
                call!(
                    "fs.readFileBytesSync",
                    [String],
                    Type::bytes(),
                    "fs_read_file_bytes"
                ),
                call!("fs.readFdSync", [Type::F64, String], String, "fs_read_fd"),
                call!(
                    "fs.readFdBytesSync",
                    [Type::F64],
                    Type::bytes(),
                    "fs_read_fd_bytes"
                ),
            ],
            "One well-formed string path or numeric file descriptor, returning bytes when encoding is omitted, or text with literal utf8/utf-8 encoding/plain inline options containing that encoding and optional literal r flag. Full byte reads, UTF-8 decoding, argument effects and open/read error name/message/code represented. Buffer/URL paths, other encodings/flags, dynamic options, accessors and spreads refused; large-file limits and error path/syscall/errno pending",
            &[
                "tests/corpus/rust-native-platform/read-file.ts",
                "tests/corpus/rust-native-platform/read-file-errors.ts",
                "tests/corpus/5062-read-file-bytes.ts",
            ],
        ),
        Api::native(
            "fs",
            "writeFileSync",
            Lowering::WriteFile,
            vec![
                call!(
                    "fs.writeFileSync",
                    [String, String],
                    Type::Void,
                    "fs_write_file"
                ),
                call!(
                    "fs.writeFileModeSync",
                    [String, String, Type::F64],
                    Type::Void,
                    "fs_write_file_mode"
                ),
                call!(
                    "fs.writeFileBytesSync",
                    [String, Type::bytes()],
                    Type::Void,
                    "fs_write_file_bytes"
                ),
                call!(
                    "fs.writeFileBytesModeSync",
                    [String, Type::bytes(), Type::F64],
                    Type::Void,
                    "fs_write_file_bytes_mode"
                ),
                call!(
                    "fs.writeFileExclusiveModeSync",
                    [String, String, Type::F64],
                    Type::Void,
                    "fs_write_file_exclusive_mode"
                ),
                call!(
                    "fs.writeFileBytesExclusiveModeSync",
                    [String, Type::bytes(), Type::F64],
                    Type::Void,
                    "fs_write_file_bytes_exclusive_mode"
                ),
                call!(
                    "fs.writeFileFdSync",
                    [Type::F64, String],
                    Type::Void,
                    "fs_append_file_fd"
                ),
            ],
            "Well-formed string paths and string or byte data; numeric runtime-owned descriptors with string data and no options; default/literal utf8 or utf-8 encoding, null/undefined options or plain inline options with numeric mode, literal w flag and false flush. Source effects precede validation; overwrite/truncate semantics. Buffer/URL paths, other encodings/flags, descriptor options, dynamic options, getters, spreads and flush=true refused; error name/message/code represented",
            &[
                "tests/corpus/rust-native-platform/write-file.ts",
                "tests/corpus/rust-native-platform/open-numeric.ts",
            ],
        ),
        Api::native(
            "fs",
            "appendFileSync",
            Lowering::AppendFile,
            vec![
                call!(
                    "fs.appendFileSync",
                    [String, String],
                    Type::Void,
                    "fs_append_file"
                ),
                call!(
                    "fs.appendFileModeSync",
                    [String, String, Type::F64, Bool],
                    Type::Void,
                    "fs_append_file_mode"
                ),
                call!(
                    "fs.appendFileFdSync",
                    [Type::F64, String],
                    Type::Void,
                    "fs_append_file_fd"
                ),
            ],
            "Well-formed string paths and string data; numeric runtime-owned descriptors with string data and no options; default/literal utf8 or utf-8 encoding, null/undefined options or plain inline options with numeric mode, literal a flag and false flush. Source effects precede validation; create-only mode and append semantics. Buffer/URL paths, byte data, other encodings/flags, descriptor options, dynamic options, getters, spreads and flush=true refused; error name/message/code represented",
            &[
                "tests/corpus/rust-native-platform/append.ts",
                "tests/corpus/rust-native-platform/append-errors.ts",
                "tests/corpus/rust-native-platform/open-numeric.ts",
            ],
        ),
        stat_api("statSync", "fs.statSync", "fs_stat_sync"),
        stat_api("lstatSync", "fs.lstatSync", "fs_lstat_sync"),
        Api::native(
            "fs",
            "statfsSync",
            Lowering::Direct,
            vec![
                call!(
                    "fs.statfsSync",
                    [String],
                    Type::Array {
                        elem: Box::new(Type::F64)
                    },
                    "fs_statfs_sync"
                ),
                call!(
                    "fs.statfsField",
                    [
                        Type::Array {
                            elem: Box::new(Type::F64)
                        },
                        Type::F64
                    ],
                    Type::F64,
                    "array_get"
                ),
            ],
            "One represented string path returning one native numeric StatFs snapshot; type, bsize, blocks, bfree, bavail, files and ffree reads are represented. BigInt options and other members are refused",
            &["tests/corpus/5256-fs-statfs-sync.ts"],
        ),
        Api::native(
            "fs",
            "realpathSync",
            Lowering::Direct,
            vec![call!("fs.realpathSync", [String], String, "fs_realpath")],
            "One represented string path canonicalized by the Rust filesystem runtime; string output and filesystem errors preserve the native contract",
            &["tests/corpus/5183-fs-realpath-sync.ts"],
        ),
        Api::native(
            "fs",
            "copyFileSync",
            Lowering::Direct,
            vec![call!(
                "fs.copyFileSync",
                [String, String],
                Type::Void,
                "fs_copy_file"
            )],
            "Two represented string paths; copies file contents and metadata permitted by the Rust filesystem implementation. Copy flags, Buffer/URL paths and extra arguments are refused; filesystem errors preserve source and destination context",
            &["tests/corpus/5188-fs-copy-file-sync.ts"],
        ),
        Api::native(
            "fs",
            "linkSync",
            Lowering::Direct,
            vec![call!(
                "fs.linkSync",
                [String, String],
                Type::Void,
                "fs_link"
            )],
            "Two represented string paths; creates a native hard link. Buffer/URL paths and extra arguments are refused; filesystem errors preserve source and destination context",
            &["tests/corpus/5195-fs-link-sync.ts"],
        ),
        Api::native(
            "fs",
            "symlinkSync",
            Lowering::Direct,
            vec![call!(
                "fs.symlinkSync",
                [String, String, String],
                Type::Void,
                "fs_symlink"
            )],
            "Represented target and path strings plus file, dir, or junction kind; creates a native symbolic link and preserves filesystem errors. Buffer/URL paths and omitted or invalid link kinds are refused",
            &["tests/corpus/5286-fs-symlink-sync.ts"],
        ),
        Api::native(
            "fs",
            "chmodSync",
            Lowering::Direct,
            vec![call!(
                "fs.chmodSync",
                [String, Type::F64],
                Type::Void,
                "fs_chmod"
            )],
            "A represented string path and numeric mode; Unix permission bits and the Windows readonly projection are implemented natively. String modes, Buffer/URL paths and extra arguments are refused",
            &["tests/corpus/5196-fs-chmod-sync.ts"],
        ),
        Api::native(
            "fs",
            "fstatSync",
            Lowering::Direct,
            vec![call!("fs.fstatSync", [Type::F64], Type::Stats, "fs_fstat")],
            "One numeric runtime-owned file descriptor; Stats snapshots and descriptor errors represented; options and other descriptor sources refused",
            &["tests/corpus/rust-native-platform/open-numeric.ts"],
        ),
        Api::native(
            "fs",
            "fchmodSync",
            Lowering::Direct,
            vec![call!(
                "fs.fchmodSync",
                [Type::F64, Type::F64],
                Type::Void,
                "fs_fchmod"
            )],
            "Numeric runtime-owned descriptor and numeric mode; descriptor-backed permissions and errors represented; string modes and other descriptors refused",
            &["tests/corpus/rust-native-platform/open-numeric.ts"],
        ),
        Api::native(
            "fs",
            "ftruncateSync",
            Lowering::Descriptor,
            vec![call!(
                "fs.ftruncateSync",
                [Type::F64, Type::F64],
                Type::Void,
                "fs_ftruncate"
            )],
            "Runtime-owned numeric descriptor and optional numeric length; length validation and negative-to-zero semantics represented",
            &["tests/corpus/rust-native-platform/truncate-descriptor.ts"],
        ),
        Api::native(
            "fs",
            "writeSync",
            Lowering::Descriptor,
            vec![call!(
                "fs.writeSync",
                [Type::F64, Type::bytes(), Type::F64, Type::F64, Type::F64],
                Type::F64,
                "fs_write_sync"
            )],
            "Two-argument numeric descriptor and u8 view; writes current position and returns bytes written; offsets, positions, strings and options refused",
            &["tests/corpus/rust-native-platform/write-descriptor.ts"],
        ),
        Api::native(
            "fs",
            "unlinkSync",
            Lowering::Direct,
            vec![call!("fs.unlinkSync", [String], Type::Void, "fs_unlink")],
            "One represented string path; file removal and error name/message/code represented. Buffer/URL paths, extra arguments and lone UTF-16 paths refused; path/syscall/errno pending",
            &["tests/corpus/rust-native-platform/unlink.ts"],
        ),
        Api::native(
            "fs",
            "rmdirSync",
            Lowering::Direct,
            vec![call!("fs.rmdirSync", [String], Type::Void, "fs_rmdir")],
            "One represented string path; removes one empty directory with native filesystem error propagation. Recursive/options forms, Buffer/URL paths and extra arguments are refused",
            &["tests/corpus/5287-fs-rmdir-sync.ts"],
        ),
        Api::native(
            "fs",
            "accessSync",
            Lowering::Direct,
            vec![call!(
                "fs.accessSync",
                [String, Type::F64],
                Type::Void,
                "fs_access"
            )],
            "One represented string path and an optional numeric F_OK/R_OK/W_OK/X_OK mask; omitted mode defaults to F_OK and filesystem failures preserve native error codes",
            &["tests/corpus/5290-fs-access-sync.ts"],
        ),
        Api::native(
            "fs/promises",
            "mkdir",
            Lowering::Special,
            vec![call!(
                "fs.mkdirPromise",
                [String, Type::F64, Bool],
                Type::Promise {
                    inner: Box::new(Type::Dyn)
                },
                "fs_mkdir_promise"
            )],
            "Represented string path and plain recursive/mode options; resolves to the first directory created or undefined and preserves native filesystem rejections",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "rm",
            Lowering::Special,
            vec![call!(
                "fs.rmPromise",
                [String, Bool, Bool],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_rm_promise"
            )],
            "A represented string path and plain inline literal recursive/force options returning a native Promise<void>; native rejection preserves filesystem errors",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "writeFile",
            Lowering::Special,
            vec![call!(
                "fs.writeFilePromise",
                [String, String, Type::F64, Bool, Bool],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_write_file_promise"
            )],
            "Represented string path/data and plain inline utf8 encoding, numeric mode, w/wx flag and literal flush options returning a native Promise<void>; native rejection preserves filesystem errors",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "appendFile",
            Lowering::Special,
            vec![call!(
                "fs.appendFilePromise",
                [String, String, Type::F64, Bool],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_append_file_promise"
            )],
            "Represented string path/data and plain inline utf8 encoding, numeric mode and a flag options returning a native Promise<void>",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "readFile",
            Lowering::Special,
            vec![
                call!(
                    "fs.readFilePromise",
                    [String, String],
                    Type::Promise {
                        inner: Box::new(String)
                    },
                    "fs_read_file_encoded_promise"
                ),
                call!(
                    "fs.readFileBytesPromise",
                    [String],
                    Type::Promise {
                        inner: Box::new(Type::bytes())
                    },
                    "fs_read_file_bytes_promise"
                ),
            ],
            "Represented string path returning bytes when encoding is omitted or text for literal utf8/utf-8 encoding, through a native Promise with filesystem rejection semantics",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "readdir",
            Lowering::Special,
            vec![
                call!(
                    "fs.readdirPromise",
                    [String],
                    Type::Promise {
                        inner: Box::new(strings())
                    },
                    "fs_readdir_promise"
                ),
                call!(
                    "fs.readdirDirentsPromise",
                    [String],
                    Type::Promise {
                        inner: Box::new(Type::Array {
                            elem: Box::new(Type::Dirent)
                        })
                    },
                    "fs_readdir_dirents_promise"
                ),
            ],
            "A represented string path resolving to native string names, or literal { withFileTypes: true } resolving to owning native Dirent snapshots",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "unlink",
            Lowering::Direct,
            vec![call!(
                "fs.unlinkPromise",
                [String],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_unlink_promise"
            )],
            "One represented string path returning a native Promise<void>; filesystem failures reject with the same name/message/code contract as unlinkSync. Buffer/URL paths, extra arguments and lone UTF-16 paths are refused",
            &["tests/corpus/rust-native-platform/unlink-promise.ts"],
        ),
        Api::native(
            "fs/promises",
            "rename",
            Lowering::Direct,
            vec![call!(
                "fs.renamePromise",
                [String, String],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_rename_promise"
            )],
            "Two represented string paths returning a native Promise<void>; rename failures reject with the shared filesystem error contract",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "access",
            Lowering::Special,
            vec![call!(
                "fs.accessPromise",
                [String, Type::F64],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_access_promise"
            )],
            "One string path and an optional numeric F_OK/R_OK/W_OK/X_OK mask; omitted mode defaults to F_OK and filesystem failures reject the native Promise",
            &["tests/corpus/rust-native-platform/access-promise.ts"],
        ),
        Api::native(
            "fs/promises",
            "copyFile",
            Lowering::Direct,
            vec![call!(
                "fs.copyFilePromise",
                [String, String],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_copy_file_promise"
            )],
            "Two represented string paths returning a native Promise<void>; copy failures reject with the shared filesystem error contract. Copy flags and extra arguments are refused",
            &["tests/corpus/rust-native-platform/copy-file-promise.ts"],
        ),
        Api::native(
            "fs/promises",
            "chmod",
            Lowering::Direct,
            vec![call!(
                "fs.chmodPromise",
                [String, Type::F64],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_chmod_promise"
            )],
            "A represented string path and numeric mode returning a native Promise<void>; permission failures reject through the shared filesystem error contract",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "stat",
            Lowering::Direct,
            vec![call!(
                "fs.statPromise",
                [String],
                Type::Promise {
                    inner: Box::new(Type::Stats)
                },
                "fs_stat_promise"
            )],
            "One represented string path resolving to the same owning native Stats snapshot as statSync, with filesystem failures represented as Promise rejections",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "truncate",
            Lowering::Direct,
            vec![call!(
                "fs.truncatePromise",
                [String, Type::F64],
                Type::Promise {
                    inner: Box::new(Type::Void)
                },
                "fs_truncate_promise"
            )],
            "A represented string path and numeric length returning a native Promise<void>; truncation and filesystem failures preserve native rejection semantics",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs/promises",
            "open",
            Lowering::Direct,
            vec![Builtin {
                ir: "fs.openPromise",
                args: vec![String, String],
                result: Type::Promise {
                    inner: Box::new(Type::Dyn),
                },
                implementation: Implementation::Emitter("filesystem-open-promise"),
            }],
            "Represented string path and flag resolving to an identity-preserving native FileHandle with positional read and close Promise methods",
            &["packages/compiler-rust/tests/native.rs"],
        ),
        Api::native(
            "fs",
            "renameSync",
            Lowering::Direct,
            vec![call!(
                "fs.renameSync",
                [String, String],
                Type::Void,
                "fs_rename"
            )],
            "Two represented string paths; rename and error name/message/code represented. Buffer/URL paths, extra arguments and lone UTF-16 paths refused; path/dest/syscall/errno pending",
            &["tests/corpus/rust-native-platform/rename.ts"],
        ),
        Api::native(
            "fs",
            "cpSync",
            Lowering::Copy,
            vec![
                call!(
                    "fs.cpSync",
                    [String, String, Bool, Bool],
                    Type::Void,
                    "fs_cp_sync"
                ),
                call!(
                    "fs.cpSyncFiltered",
                    [
                        String,
                        String,
                        Bool,
                        Bool,
                        Type::Func {
                            params: vec![String, String],
                            ret: Box::new(Bool),
                            rest: false
                        }
                    ],
                    Type::Void,
                    "fs_cp_sync_filtered"
                ),
            ],
            "Two represented string paths and omitted options or plain inline recursive/dereference booleans plus a synchronous string-path filter callback. Files and recursive directory trees are copied natively while preserving symbolic links by default; force/errorOnExist modes, timestamps and verbatim symlink modes are refused",
            &[
                "tests/corpus/5136-fs-cp-sync.ts",
                "tests/corpus/5198-fs-cp-dereference.ts",
                "tests/corpus/5316-fs-cp-filter.ts",
            ],
        ),
        Api::native(
            "fs",
            "rmSync",
            Lowering::Remove,
            vec![
                call!("fs.rmSync", [String], Type::Void, "fs_rm"),
                call!(
                    "fs.rmOptionsSync",
                    [String, Bool, Bool],
                    Type::Void,
                    "fs_rm_options"
                ),
            ],
            "One represented string path with omitted options or plain inline literal boolean recursive/force options. Files, empty directories, recursive trees and force-missing semantics represented; Buffer/URL paths, dynamic options, getters, spreads, retries and retryDelay refused; error name/message/code represented",
            &["tests/corpus/rust-native-platform/remove.ts"],
        ),
        Api::native(
            "fs",
            "openSync",
            Lowering::Descriptor,
            vec![
                call!("fs.openSync", [String, String], Type::F64, "fs_open"),
                call!(
                    "fs.openModeSync",
                    [String, String, Type::F64],
                    Type::F64,
                    "fs_open_mode"
                ),
                call!(
                    "fs.openNumericSync",
                    [String, Type::F64, Type::F64],
                    Type::F64,
                    "fs_open_numeric"
                ),
                call!(
                    "fs.openFlagConstant",
                    [String],
                    Type::F64,
                    "fs_open_flag_constant"
                ),
            ],
            "Well-formed string paths, basic literal string flags or numeric flags with numeric mode; dynamic string flags refused; error name/message/code represented",
            &[
                "tests/corpus/rust-native-platform/descriptors.ts",
                "tests/corpus/rust-native-platform/open-numeric.ts",
            ],
        ),
        Api::native(
            "fs",
            "readSync",
            Lowering::Descriptor,
            vec![call!(
                "fs.readSync",
                [Type::F64, Type::bytes(), Type::F64, Type::F64, Type::F64],
                Type::F64,
                "fs_read_sync"
            )],
            "Positional numeric offset/length and optional numeric/null/undefined position with represented u8 views; options, BigInt positions and other view types refused; empty-view error inspection branding pending",
            &[
                "tests/corpus/rust-native-platform/descriptors.ts",
                "tests/corpus/rust-native-platform/descriptor-errors.ts",
            ],
        ),
        Api::native(
            "fs",
            "closeSync",
            Lowering::Descriptor,
            vec![
                call!("fs.closeSync", [Type::F64], Type::Void, "fs_close"),
                call!("fs.closeNullish", [String], Type::Void, "fs_close_nullish"),
            ],
            "One represented numeric descriptor; native lifecycle and numeric validation; standard/inherited descriptor ownership remains a separate contract",
            &[
                "tests/corpus/rust-native-platform/descriptors.ts",
                "tests/corpus/rust-native-platform/descriptor-errors.ts",
            ],
        ),
    ]
}

fn stat_api(member: &'static str, ir: &'static str, runtime: &'static str) -> Api {
    Api::native(
        "fs",
        member,
        Lowering::Direct,
        vec![
            Builtin {
                ir,
                args: vec![String],
                result: Type::Stats,
                implementation: Implementation::Runtime(runtime),
            },
            call!("stats.size", [Type::Stats], Type::F64, "stats_size"),
            call!("stats.mode", [Type::Stats], Type::F64, "stats_mode"),
            call!("stats.uid", [Type::Stats], Type::F64, "stats_uid"),
            call!("stats.gid", [Type::Stats], Type::F64, "stats_gid"),
            call!("stats.mtimeMs", [Type::Stats], Type::F64, "stats_mtime_ms"),
            call!("stats.atimeMs", [Type::Stats], Type::F64, "stats_atime_ms"),
            call!("stats.dev", [Type::Stats], Type::F64, "stats_dev"),
            call!("stats.ino", [Type::Stats], Type::F64, "stats_ino"),
            call!("stats.blocks", [Type::Stats], Type::F64, "stats_blocks"),
            call!("stats.nlink", [Type::Stats], Type::F64, "stats_nlink"),
            call!("stats.isFile", [Type::Stats], Bool, "stats_is_file"),
            call!(
                "stats.isDirectory",
                [Type::Stats],
                Bool,
                "stats_is_directory"
            ),
            call!(
                "stats.isSymbolicLink",
                [Type::Stats],
                Bool,
                "stats_is_symlink"
            ),
            call!("stats.isSocket", [Type::Stats], Bool, "stats_is_socket"),
        ],
        "One well-formed UTF-16 string path; owning Stats snapshots, size and zero-argument isFile/isDirectory/isSymbolicLink/isSocket reads. Options, Buffer/URL paths, other members, writes, method values, equality, direct array/Map/dictionary values, unions and erasure refused. Error name/message/code represented; path/syscall/errno pending",
        &[
            "tests/corpus/rust-native-platform/stats.ts",
            "tests/corpus/rust-native-platform/stat-errors.ts",
        ],
    )
}
