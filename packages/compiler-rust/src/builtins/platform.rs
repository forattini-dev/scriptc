use super::*;
pub(super) fn apis() -> Vec<Api> {
    let mut entries = vec![
        call!("os.homedir", [], String, "os_homedir"),
        call!("os.tmpdir", [], String, "os_tmpdir"),
        call!("os.hostname", [], String, "os_hostname"),
        call!("os.totalmem", [], Type::F64, "os_totalmem"),
        call!("process.platform", [], String, "process_platform"),
    ]
    .into_iter()
    .map(|op| {
        let name = match op.ir {
            "os.homedir" => "homedir",
            "os.tmpdir" => "tmpdir",
            "os.hostname" => "hostname",
            "os.totalmem" => "totalmem",
            "process.platform" => "platform",
            _ => unreachable!(),
        };
        Api::native(
            "os",
            name,
            Lowering::Direct,
            vec![op],
            "Zero-argument platform query",
            &["tests/corpus/rust-native-platform/paths.ts"],
        )
    })
    .collect::<Vec<_>>();
    entries.push(Api::native(
        "os",
        "userInfo",
        Lowering::Direct,
        vec![Builtin {
            ir: "os.userInfo",
            args: vec![],
            result: Type::Dyn,
            implementation: Implementation::NativeHelper("native_os_user_info"),
        }],
        "Zero-argument owning snapshot with Node-compatible uid, gid, username, homedir and shell fields; encoding overloads are refused",
        &["tests/corpus/rust-native-platform/user-info.ts"],
    ));
    entries.push(Api::native(
        "url",
        "fileURLToPath",
        Lowering::Direct,
        vec![call!(
            "url.fileURLToPathStr",
            [String],
            String,
            "url_string_to_path"
        )],
        "Represented string file URL; URL object and options overloads refused",
        &["tests/corpus/rust-native-file-urls/paths.ts"],
    ));
    entries.push(Api::native(
        "url",
        "pathToFileURL",
        Lowering::Direct,
        vec![Builtin {
            ir: "url.pathToFileURL",
            args: vec![String],
            result: Type::Dyn,
            implementation: Implementation::NativeHelper("native_path_to_file_url"),
        }],
        "Represented string path resolved against the working directory to a native URL value; the options overload is refused",
        &["tests/corpus/rust-native-main-module-guard/main.ts"],
    ));
    entries.push(Api::native(
        "v8",
        "getHeapStatistics",
        Lowering::Direct,
        vec![Builtin {
            ir: "v8.getHeapStatistics",
            args: vec![],
            result: Type::Dyn,
            implementation: Implementation::NativeHelper("native_v8_heap_statistics"),
        }],
        "Native process heap snapshot; heap_size_limit reports currently available native process memory because Rust has no V8 managed-heap ceiling",
        &["tests/corpus/rust-native-platform/v8.ts"],
    ));
    entries.push(Api::special(
        "inspector",
        "Session",
        Access::Construct,
        "inspector.session.new",
        "native_inspector_session",
        "Native inspector session facade; Profiler lifecycle callbacks are preserved and stop returns a structurally valid empty Chrome CPU profile",
        &["tests/corpus/rust-native-platform/inspector.ts"],
    ));
    entries
}

pub(super) fn internal() -> Vec<Builtin> {
    vec![call!(
        "os.signalKnown",
        [String],
        Bool,
        "os_signal_supported"
    )]
}
