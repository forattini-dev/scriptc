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
        Api::runtime_only(
            "fs",
            "readFileSync",
            Access::Call,
            &["fs_read_file", "fs_read_file_bytes"],
            "Rust text/bytes I/O exists; native overload selection, encodings and Buffer/URL contracts still need porting",
        ),
        Api::runtime_only(
            "fs",
            "writeFileSync",
            Access::Call,
            &["fs_write_file", "fs_write_file_bytes", "fs_write_file_mode"],
            "Rust text/bytes I/O exists; native flags, encoding, descriptor and error contracts still need porting",
        ),
        Api::runtime_only(
            "fs",
            "appendFileSync",
            Access::Call,
            &["fs_append_file"],
            "Rust append exists; native options, descriptor and publication contracts still need porting",
        ),
        Api::runtime_only(
            "fs",
            "statSync",
            Access::Call,
            &[
                "fs_stat",
                "stats_size",
                "stats_is_file",
                "stats_is_directory",
            ],
            "Runtime stat projections exist; the owning Stats object, BigInt options and error fields are not a native frontend contract",
        ),
        Api::runtime_only(
            "fs",
            "openSync",
            Access::Call,
            &["fs_open"],
            "Runtime descriptor operations exist; flags, optional modes and descriptor lifecycle need a native ABI",
        ),
    ]
}
