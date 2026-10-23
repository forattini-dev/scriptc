use super::*;
pub(super) fn apis() -> Vec<Api> {
    ["alloc", "allocUnsafe"].into_iter().map(|member| Api::native(
        "Buffer", member, Lowering::Buffer,
        vec![call!("buffer.alloc", [Type::F64], Type::bytes(), "buffer_alloc")],
        "One represented numeric size; owning Buffer brand, zero initialization and numeric errors. allocUnsafe contents are unspecified and safely initialized. Fill/encoding overloads, pooling/backing-store observations and extracted statics refused",
        &["tests/corpus/rust-native-platform/buffers.ts", "tests/corpus/rust-native-platform/buffer-errors.ts"],
    )).chain([Api::native("Buffer", "isBuffer", Lowering::Buffer,
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
