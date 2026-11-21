use super::*;

pub(super) fn apis() -> Vec<Api> {
    let mut incoming = Api::native(
        "http",
        "IncomingMessage",
        Lowering::Property,
        vec![Builtin {
            ir: "http.incomingMessageConstructor",
            args: vec![],
            result: Type::Dyn,
            implementation: Implementation::Emitter("values"),
        }],
        "Stable native constructor identity for IncomingMessage prototype checks; construction is not exposed",
        &["packages/compiler-rust/tests/native.rs"],
    );
    incoming.access = Access::Property;
    let server = Api::native(
        "http",
        "createServer",
        Lowering::Direct,
        vec![
            Builtin {
                ir: "http.createServer",
                args: vec![],
                result: Type::Dyn,
                implementation: Implementation::Emitter("network"),
            },
            Builtin {
                ir: "http.createServerListener",
                args: vec![Type::Func {
                    rest: false,
                    params: vec![Type::Dyn, Type::Dyn],
                    ret: Box::new(Type::Void),
                }],
                result: Type::Dyn,
                implementation: Implementation::Emitter("network"),
            },
        ],
        "HTTP/1.1 server over the native net.Server: request listener, listen(port[, host][, callback]), address(), close(); requests expose method/url/headers/httpVersion and responses writeHead/setHeader/getHeader/removeHeader/write/end. Request bodies, upgrade and statusCode assignment are not ported",
        &["tests/corpus/rust-native-http-server/main.cjs"],
    );
    vec![incoming, server]
}
