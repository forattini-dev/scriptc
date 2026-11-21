use super::*;

pub(super) fn apis() -> Vec<Api> {
    let mut apis = vec![Api::native(
        "diagnostics_channel",
        "channel",
        Lowering::Direct,
        vec![Builtin {
            ir: "diagnostics.channel",
            args: vec![Type::String],
            result: Type::Dyn,
            implementation: Implementation::Emitter("values"),
        }],
        "Interned native diagnostics channel with dynamic subscribe, unsubscribe, publish, name and hasSubscribers members",
        &["tests/corpus/5338-diagnostics-channel-native/main.ts"],
    )];
    for (member, ir, args, result, contract) in [
        (
            "subscribe",
            "diagnostics.subscribe",
            vec![Type::String, Type::Dyn],
            Type::Void,
            "Subscribe one represented callback to an interned diagnostics channel name",
        ),
        (
            "unsubscribe",
            "diagnostics.unsubscribe",
            vec![Type::String, Type::Dyn],
            Type::Bool,
            "Remove the first identity-equal represented callback from an interned diagnostics channel name",
        ),
        (
            "hasSubscribers",
            "diagnostics.hasSubscribers",
            vec![Type::String],
            Type::Bool,
            "Test named diagnostics-channel activity shared with channel objects",
        ),
    ] {
        apis.push(Api::native(
            "diagnostics_channel",
            member,
            Lowering::Direct,
            vec![Builtin {
                ir,
                args,
                result,
                implementation: Implementation::Emitter("values"),
            }],
            contract,
            &["tests/corpus/5468-diagnostics-named-subscribe/main.cjs"],
        ));
    }
    apis
}
