use super::*;
pub(super) fn apis() -> Vec<Api> {
    [Api::native("buffer", "isUtf8", Lowering::Buffer,
        vec![call!("buffer.isUtf8", [Type::bytes()], Bool, "buffer_is_utf8")],
        "One represented Uint8Array or Buffer view; validates UTF-8 bytes in the visible slice; ArrayBuffer, SharedArrayBuffer and erased inputs refused",
        &["tests/corpus/rust-native-platform/buffer-is-utf8.ts"],
    )].into_iter().chain(["alloc", "allocUnsafe", "allocUnsafeSlow"].into_iter().map(|member| Api::native(
        "Buffer", member, Lowering::Buffer,
        vec![call!("buffer.alloc", [Type::F64], Type::bytes(), "buffer_alloc")],
        "One represented numeric size; owning Buffer brand, zero initialization and numeric errors. Unsafe allocation contents are unspecified and safely initialized. Fill/encoding overloads, pooling/backing-store observations and extracted statics refused",
        &["tests/corpus/rust-native-platform/buffers.ts", "tests/corpus/rust-native-platform/buffer-errors.ts", "tests/corpus/5505-buffer-alloc-unsafe-slow/main.cjs"],
    ))).chain([Api::native("Buffer", "from", Lowering::Buffer,
        vec![Builtin { ir: "buffer.fromDyn", args: vec![Type::Dyn, Type::String], result: Type::bytes(), implementation: Implementation::NativeHelper("native_buffer_from_entry") }],
        "Owning strings, u8 views, arrays/tuples of primitive elements and ordinary array-like/Buffer JSON data; compiled own valueOf hooks; eager ordinary arguments; boxed/exotic source protocols and element object conversion hooks retain explicit boundaries",
        &["tests/corpus/rust-native-buffer-from/values.ts", "tests/corpus/rust-native-buffer-from/order.ts", "tests/corpus/rust-native-buffer-from/errors.ts"],
    ), Api::special("Buffer.prototype", "toString", Access::Call, "bytesIntrinsic.toStringVar", "bytes_to_string_checked",
        "Zero/one encoding argument; original Buffer brand selects decoding, Uint8Array selects comma join; empty Buffers skip encoding conversion; start/end overloads, extracted methods and object conversion hooks refused",
        &["tests/corpus/rust-native-buffer-from/values.ts", "tests/corpus/rust-native-buffer-from/order.ts", "tests/corpus/rust-native-buffer-from/errors.ts"],
    ), Api::native("Buffer", "byteLength", Lowering::Buffer,
        vec![call!("buffer.byteLenStr", [Type::String, Type::String], Type::F64, "buffer_byte_length_string"),
             Builtin { ir: "buffer.byteLenDyn", args: vec![Type::Dyn, Type::String], result: Type::F64, implementation: Implementation::NativeHelper("native_buffer_byte_length_dyn") }],
        "One native string with an optional native encoding string; Node aliases and invalid-encoding UTF-8 fallback are preserved; byte views, erased values and extracted statics are refused",
        &["tests/corpus/rust-native-buffer-byte-length/main.ts"],
    ), Api::native("Buffer", "concat", Lowering::Buffer,
        vec![call!("buffer.concat", [Type::Array { elem: Box::new(Type::bytes()) }], Type::bytes(), "buffer_concat"),
             call!("buffer.concatLen", [Type::Array { elem: Box::new(Type::bytes()) }, Type::F64], Type::bytes(), "buffer_concat_len")],
        "One represented array of Buffer or Uint8Array views and optional represented totalLength; copies, truncates or zero-fills into a new Buffer; dynamic element overloads refused",
        &["tests/corpus/rust-native-platform/buffer-concat.ts"],
    ), Api::native("Atomics", "wait", Lowering::Primitive,
        vec![call!("atomics.wait", [Type::Bytes { elem: "i32".into() }, Type::F64, Type::F64, Type::F64], Type::String, "atomics_wait")],
        "Finite numeric timeouts on a fresh, unobservable one-element SharedArrayBuffer and index zero; shared views, notifying agents, dynamic arguments and infinite waits refused",
        &["tests/corpus/rust-native-platform/atomics-fresh.ts"],
    ), Api::native("Buffer", "isBuffer", Lowering::Buffer,
        vec![call!("buffer.isBuffer", [Type::Dyn], Bool, "bytes_is_buffer")],
        "Owning compiled values; Buffer allocation brands survive typed and erased aliases; unsupported value-erasure boundaries remain explicit",
        &["tests/corpus/rust-native-platform/buffers.ts"])]).collect()
}
pub(super) fn internal() -> Vec<Builtin> {
    vec![
        call!(
            "buffer.fromU8Window",
            [Type::bytes()],
            Type::bytes(),
            "buffer_from_u8_window_view"
        ),
        call!(
            "bytes.indexOfNumeric",
            [Type::bytes(), Type::F64, Type::F64],
            Type::F64,
            "bytes_index_of_numeric"
        ),
        call!(
            "bytes.lastIndexOfNumeric",
            [Type::bytes(), Type::F64, Type::F64],
            Type::F64,
            "bytes_last_index_of_numeric"
        ),
        call!(
            "bytes.indexOfBytes",
            [Type::bytes(), Type::bytes(), Type::F64],
            Type::F64,
            "bytes_index_of_bytes"
        ),
        call!(
            "bytes.lastIndexOfBytes",
            [Type::bytes(), Type::bytes(), Type::F64],
            Type::F64,
            "bytes_last_index_of_bytes"
        ),
        call!(
            "bytes.sliceDispatch",
            [Type::bytes(), Type::F64, Type::F64],
            Type::bytes(),
            "bytes_slice_method"
        ),
        call!(
            "bytes.offset",
            [Type::bytes()],
            Type::F64,
            "bytes_source_offset"
        ),
    ]
}
