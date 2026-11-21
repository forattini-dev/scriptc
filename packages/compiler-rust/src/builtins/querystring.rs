use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![
        Api::native(
            "querystring",
            "stringify",
            Lowering::Direct,
            vec![Builtin {
                ir: "querystring.stringify",
                args: vec![Type::Dyn],
                result: Type::String,
                implementation: Implementation::Emitter("values"),
            }],
            "One-argument querystring serialization for represented own enumerable string properties; primitive values and arrays follow Node's legacy querystring scalar rules",
            &["tests/corpus/5467-querystring-stringify/main.cjs"],
        ),
        Api::native(
            "querystring",
            "unescape",
            Lowering::Direct,
            vec![call!(
                "querystring.unescape",
                [Type::String],
                Type::String,
                "querystring_unescape"
            )],
            "Percent decoding of a represented string with Node's tolerant malformed UTF-8 fallback; non-string coercion and custom decoders are not represented",
            &["tests/corpus/5499-querystring-unescape/main.cjs"],
        ),
    ]
}
