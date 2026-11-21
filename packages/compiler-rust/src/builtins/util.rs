use super::*;

pub(super) fn apis() -> Vec<Api> {
    let mut apis = vec![
        Api::native(
            "util",
            "isDeepStrictEqual",
            Lowering::Direct,
            vec![Builtin {
                ir: "util.isDeepStrictEqual",
                args: vec![Type::Dyn, Type::Dyn],
                result: Type::Bool,
                implementation: Implementation::Emitter("values"),
            }],
            "Native recursive comparison of represented JavaScript values; preserves typed array and record identity while comparing their contents without an embedded engine",
            &["tests/corpus/5214-util-is-deep-strict-equal.ts"],
        ),
        Api::native(
            "util",
            "inspect",
            Lowering::Direct,
            vec![Builtin {
                ir: "util.inspect",
                args: vec![Type::Dyn],
                result: Type::String,
                implementation: Implementation::Emitter("values"),
            }],
            "Engine-free diagnostic rendering for represented JavaScript values; returns an owning string and does not execute user inspection hooks",
            &["tests/corpus/5350-util-inspect/main.cjs"],
        ),
        Api::native(
            "util",
            "formatWithOptions",
            Lowering::Direct,
            vec![Builtin {
                ir: "util.formatWithOptionsValue",
                args: vec![Type::Dyn, Type::Dyn],
                result: Type::String,
                implementation: Implementation::Emitter("values"),
            }],
            "Engine-free two-argument formatWithOptions used by diagnostic hooks; evaluates the options value and renders one represented value with Node-style inspection",
            &["tests/corpus/5409-util-format-with-options-value/main.cjs"],
        ),
        Api::native(
            "util",
            "debuglog",
            Lowering::Direct,
            vec![Builtin {
                ir: "util.debuglog",
                args: vec![Type::String],
                result: Type::Dyn,
                implementation: Implementation::Emitter("values"),
            }],
            "NODE_DEBUG-gated variadic diagnostic callable with the observable enabled property",
            &["tests/corpus/5345-util-debuglog/main.cjs"],
        ),
    ];
    for (member, ir) in [
        ("isArrayBuffer", "utilTypes.isArrayBuffer"),
        ("isSharedArrayBuffer", "utilTypes.isSharedArrayBuffer"),
        ("isAnyArrayBuffer", "utilTypes.isAnyArrayBuffer"),
        ("isArrayBufferView", "utilTypes.isArrayBufferView"),
        ("isTypedArray", "utilTypes.isTypedArray"),
        ("isUint8Array", "utilTypes.isUint8Array"),
        ("isDataView", "utilTypes.isDataView"),
        ("isProxy", "utilTypes.isProxy"),
        ("isPromise", "utilTypes.isPromise"),
    ] {
        apis.push(Api::native(
            "util/types",
            member,
            Lowering::Direct,
            vec![Builtin {
                ir,
                args: vec![Type::Dyn],
                result: Type::Bool,
                implementation: Implementation::Emitter("values"),
            }],
            "Exact native brand predicate over represented values; unsupported SharedArrayBuffer and erased DataView brands remain false rather than being emulated",
            &["tests/corpus/5354-util-types-brands/main.cjs"],
        ));
    }
    apis.push(Api::native(
        "ArrayBuffer",
        "isView",
        Lowering::Direct,
        vec![Builtin {
            ir: "arrayBuffer.isView",
            args: vec![Type::Dyn],
            result: Type::Bool,
            implementation: Implementation::Emitter("values"),
        }],
        "Exact standard ArrayBuffer.isView predicate for represented typed-array views; lexically shadowed constructors are excluded",
        &["tests/corpus/5354-util-types-brands/main.cjs"],
    ));
    apis.push(Api::native(
        "ArrayBuffer",
        "u8View",
        Lowering::Direct,
        vec![Builtin {
            ir: "arrayBuffer.u8View",
            args: vec![Type::Dyn, Type::F64, Type::Bool, Type::F64],
            result: Type::bytes(),
            implementation: Implementation::Emitter("values"),
        }],
        "Native Uint8Array view over a represented ArrayBuffer with byte offset and optional length; shares backing storage and validates bounds",
        &["tests/corpus/5354-util-types-brands/main.cjs"],
    ));
    apis
}
