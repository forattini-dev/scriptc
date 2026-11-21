use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![Api::native(
        "asset",
        "file",
        Lowering::Direct,
        vec![call!("asset.file", [String, String], String, "asset_file")],
        "Build-time bytes embedded as base64 and extracted to a process-owned path",
        &["tests/corpus/rust-native-assets/file-loader.ts"],
    )]
}
