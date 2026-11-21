use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![
        Api::native(
            "zlib",
            "gzipSync",
            Lowering::Zlib,
            vec![call!(
                "zlib.gzipSync",
                [Type::bytes()],
                Type::bytes(),
                "zlib_gzip_sync"
            )],
            "One Uint8Array or Buffer input; options and other overloads are refused",
            &["tests/corpus/rust-native-zlib/gzip.ts"],
        ),
        Api::native(
            "zlib",
            "gunzipSync",
            Lowering::Zlib,
            vec![call!(
                "zlib.gunzipSync",
                [Type::bytes()],
                Type::bytes(),
                "zlib_gunzip_sync"
            )],
            "One Uint8Array or Buffer input; options and other overloads are refused",
            &["tests/corpus/rust-native-zlib/gzip.ts"],
        ),
        Api::native(
            "zlib",
            "inflateSync",
            Lowering::Zlib,
            vec![call!(
                "zlib.inflateSync",
                [Type::bytes()],
                Type::bytes(),
                "zlib_inflate_sync"
            )],
            "One Uint8Array or Buffer input; options and other overloads are refused",
            &["tests/corpus/rust-native-zlib/values.ts"],
        ),
        Api::native(
            "zlib",
            "deflateSync",
            Lowering::Zlib,
            vec![
                call!(
                    "zlib.deflateSync",
                    [Type::bytes()],
                    Type::bytes(),
                    "zlib_deflate_sync"
                ),
                call!(
                    "zlib.deflateSyncLevel",
                    [Type::bytes(), Type::F64],
                    Type::bytes(),
                    "zlib_deflate_sync_level"
                ),
            ],
            "One Uint8Array or Buffer input, with an optional literal level from -1 through 9; other options and overloads are refused",
            &["tests/corpus/rust-native-zlib/values.ts"],
        ),
    ]
}
