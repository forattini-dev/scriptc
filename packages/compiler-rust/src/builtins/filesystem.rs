use super::*;
pub(super) fn apis() -> Vec<Api> {
    vec![
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
            vec![call!(
                "fs.readFileSync",
                [String, String],
                String,
                "fs_read_file_encoded"
            )],
            "One well-formed string path with literal utf8/utf-8 encoding or plain inline options containing that encoding and optional literal r flag. Full UTF-8 decoding, argument effects and open/read error name/message/code represented. Descriptor/Buffer/URL paths, omitted/null encodings returning Buffer, other encodings/flags, dynamic options, accessors and spreads refused; large-file limits and error path/syscall/errno pending",
            &[
                "tests/corpus/rust-native-platform/read-file.ts",
                "tests/corpus/rust-native-platform/read-file-errors.ts",
            ],
        ),
        Api::runtime_only(
            "fs",
            "writeFileSync",
            Access::Call,
            &["fs_write_file", "fs_write_file_bytes", "fs_write_file_mode"],
            "Rust text/bytes I/O exists; native flags, encoding, descriptor and error contracts still need porting",
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
            ],
            "Well-formed string paths and string data; default/literal utf8 or utf-8 encoding, null/undefined options or plain inline options with numeric mode, literal a flag and false flush. Source effects precede validation; create-only mode and append semantics. Descriptor/Buffer/URL paths, byte data, other encodings/flags, dynamic options, getters, spreads and flush=true refused; error name/message/code represented",
            &[
                "tests/corpus/rust-native-platform/append.ts",
                "tests/corpus/rust-native-platform/append-errors.ts",
            ],
        ),
        stat_api("statSync", "fs.statSync", "fs_stat_sync"),
        stat_api("lstatSync", "fs.lstatSync", "fs_lstat_sync"),
        Api::native(
            "fs",
            "openSync",
            Lowering::Descriptor,
            vec![call!("fs.openSync", [String, String], Type::F64, "fs_open")],
            "One well-formed string path and an optional basic literal string flag; numeric/synchronous flags, dynamic flags and mode arguments refused; error name/message/code represented",
            &["tests/corpus/rust-native-platform/descriptors.ts"],
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
            vec![call!("fs.closeSync", [Type::F64], Type::Void, "fs_close")],
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
        ],
        "One well-formed UTF-16 string path; owning Stats snapshots, size and zero-argument isFile/isDirectory/isSymbolicLink reads. Options, Buffer/URL paths, other members, writes, method values, equality, direct array/Map/dictionary values, unions and erasure refused. Error name/message/code represented; path/syscall/errno pending",
        &[
            "tests/corpus/rust-native-platform/stats.ts",
            "tests/corpus/rust-native-platform/stat-errors.ts",
        ],
    )
}
