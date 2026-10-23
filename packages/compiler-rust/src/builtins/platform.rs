use super::*;
pub(super) fn apis() -> Vec<Api> {
    let mut entries = vec![
        call!("os.homedir", [], String, "os_homedir"),
        call!("os.tmpdir", [], String, "os_tmpdir"),
        call!("process.platform", [], String, "process_platform"),
    ]
    .into_iter()
    .map(|op| {
        let name = match op.ir {
            "os.homedir" => "homedir",
            "os.tmpdir" => "tmpdir",
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
    entries
}
