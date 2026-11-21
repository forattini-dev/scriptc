use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![
        Api::native(
            "string_decoder",
            "%write",
            Lowering::Special,
            vec![call!(
                "strdec.write",
                [String, Type::F64, Type::bytes()],
                String,
                "string_decoder_write"
            )],
            "Internal incremental StringDecoder prefix decode",
            &["tests/corpus/4961-string-decoder.ts"],
        ),
        Api::native(
            "string_decoder",
            "%next",
            Lowering::Special,
            vec![call!(
                "strdec.next",
                [String, Type::F64, Type::bytes()],
                Type::F64,
                "string_decoder_next"
            )],
            "Internal incremental StringDecoder pending-state transition",
            &["tests/corpus/4961-string-decoder.ts"],
        ),
        Api::native(
            "string_decoder",
            "%end",
            Lowering::Special,
            vec![call!(
                "strdec.end",
                [String, Type::F64],
                String,
                "string_decoder_end"
            )],
            "Internal incremental StringDecoder pending-state flush",
            &["tests/corpus/4961-string-decoder.ts"],
        ),
    ]
}
