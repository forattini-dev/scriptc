use super::*;
pub(super) fn apis() -> Vec<Api> {
    ["alloc", "allocUnsafe"].into_iter().map(|member| Api::native(
        "Buffer", member, Lowering::Buffer,
        vec![call!("buffer.alloc", [Type::F64], Type::bytes(), "buffer_alloc")],
        "One represented numeric size; owning Buffer brand, zero initialization and numeric errors. allocUnsafe contents are unspecified and safely initialized. Fill/encoding overloads, pooling/backing-store observations and extracted statics refused",
        &["tests/corpus/rust-native-platform/buffers.ts", "tests/corpus/rust-native-platform/buffer-errors.ts"],
    )).chain([Api::native("Buffer", "from", Lowering::Buffer,
        vec![Builtin { ir: "buffer.fromDyn", args: vec![Type::Dyn, Type::String], result: Type::bytes(), implementation: Implementation::NativeHelper("native_buffer_from_entry") }],
        "Owning strings, u8 views, arrays/tuples of primitive elements and ordinary array-like/Buffer JSON data; compiled own valueOf hooks; eager ordinary arguments; boxed/exotic source protocols and element object conversion hooks retain explicit boundaries",
        &["tests/corpus/rust-native-buffer-from/values.ts", "tests/corpus/rust-native-buffer-from/order.ts", "tests/corpus/rust-native-buffer-from/errors.ts"],
    ), Api::special("Buffer.prototype", "toString", Access::Call, "bytesIntrinsic.toStringVar", "bytes_to_string_checked",
        "Zero/one encoding argument; original Buffer brand selects decoding, Uint8Array selects comma join; empty Buffers skip encoding conversion; start/end overloads, extracted methods and object conversion hooks refused",
        &["tests/corpus/rust-native-buffer-from/values.ts", "tests/corpus/rust-native-buffer-from/order.ts", "tests/corpus/rust-native-buffer-from/errors.ts"],
    ), Api::native("Buffer", "isBuffer", Lowering::Buffer,
        vec![call!("buffer.isBuffer", [Type::Dyn], Bool, "bytes_is_buffer")],
        "Owning compiled values; Buffer allocation brands survive typed and erased aliases; unsupported value-erasure boundaries remain explicit",
        &["tests/corpus/rust-native-platform/buffers.ts"])]).collect()
}
pub(super) fn internal() -> Vec<Builtin> {
    vec![
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
