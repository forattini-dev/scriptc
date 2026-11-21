use super::*;

pub(super) fn apis() -> Vec<Api> {
    let mut entries = vec![Api::special(
        "events",
        "once",
        Access::Call,
        "events.onceDrain",
        "promise_new",
        "process.stdout/process.stderr drain wait used after a native write reports backpressure; generic EventEmitter targets and other events are not ported",
        &["tests/corpus/rust-native-process-writes/drain.ts"],
    )];
    entries.push(Api::native(
        "events",
        "getMaxListeners",
        Lowering::Direct,
        vec![Builtin {
            ir: "events.getMaxListeners",
            args: vec![Type::Dyn],
            result: Type::F64,
            implementation: Implementation::Emitter("values"),
        }],
        "Read the native listener warning threshold from a represented AbortSignal",
        &["tests/corpus/5367-events-abort-max-listeners/main.ts"],
    ));
    entries.push(Api::native(
        "events",
        "setMaxListeners",
        Lowering::Direct,
        vec![Builtin {
            ir: "events.setMaxListeners",
            args: vec![Type::F64, Type::Dyn],
            result: Type::Void,
            implementation: Implementation::Emitter("values"),
        }],
        "Set the native listener warning threshold on one represented AbortSignal",
        &["tests/corpus/5367-events-abort-max-listeners/main.ts"],
    ));
    let mut default_max = Api::native(
        "events",
        "defaultMaxListeners",
        Lowering::Property,
        vec![Builtin {
            ir: "events.defaultMaxListeners",
            args: vec![],
            result: Type::F64,
            implementation: Implementation::Emitter("values"),
        }],
        "Node-compatible default EventEmitter listener warning threshold",
        &["tests/corpus/5367-events-abort-max-listeners/main.ts"],
    );
    default_max.access = Access::Property;
    entries.push(default_max);
    entries
}
