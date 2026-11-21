use super::{Access, Api, Builtin, Implementation, Lowering};
use crate::ir::Type;

pub fn apis() -> Vec<Api> {
    let mut socket = Api::native(
        "net",
        "Socket",
        Lowering::Direct,
        vec![Builtin {
            ir: "net.socketNew",
            args: vec![],
            result: Type::Dyn,
            implementation: Implementation::Emitter("network"),
        }],
        "Constructs a disconnected native socket with the default options",
        &["tests/fixtures/net-socket/main.ts"],
    );
    socket.access = Access::Construct;
    vec![
        socket,
        Api::native(
            "tls",
            "connect",
            Lowering::Direct,
            vec![Builtin {
                ir: "tls.connectOptions",
                args: vec![Type::Dyn, Type::Dyn],
                result: Type::Dyn,
                implementation: Implementation::Emitter("network"),
            }],
            "TLS client with represented host, port, servername, optional trust settings and secure-connect callback",
            &["tests/fixtures/tls-connect/client.ts"],
        ),
        Api::native(
            "net",
            "isIP",
            Lowering::Direct,
            vec![Builtin {
                ir: "net.isIP",
                args: vec![Type::String],
                result: Type::F64,
                implementation: Implementation::Runtime("net_is_ip"),
            }],
            "Strict textual IP validation returning 4, 6, or 0",
            &["tests/corpus/rust-native-commonjs/import-default-native/main.cjs"],
        ),
        Api::native(
            "net",
            "isIPv4",
            Lowering::Direct,
            vec![Builtin {
                ir: "net.isIPv4",
                args: vec![Type::String],
                result: Type::Bool,
                implementation: Implementation::Runtime("net_is_ipv4"),
            }],
            "Strict textual IPv4 validation",
            &["tests/corpus/rust-native-commonjs/import-default-native/main.cjs"],
        ),
        Api::native(
            "net",
            "isIPv6",
            Lowering::Direct,
            vec![Builtin {
                ir: "net.isIPv6",
                args: vec![Type::String],
                result: Type::Bool,
                implementation: Implementation::Runtime("net_is_ipv6"),
            }],
            "Strict textual IPv6 validation",
            &["tests/corpus/rust-native-commonjs/import-default-native/main.cjs"],
        ),
        Api::native(
            "net",
            "createConnection",
            Lowering::Direct,
            vec![Builtin {
                ir: "net.createConnectionPath",
                args: vec![Type::String],
                result: Type::Dyn,
                implementation: Implementation::Emitter("network"),
            }],
            "One local-domain socket path; returns the shared native Socket view",
            &["tests/corpus/rust-native-net-local/main.ts"],
        ),
        Api::native(
            "net",
            "connect",
            Lowering::Direct,
            vec![Builtin {
                ir: "net.connectOptions",
                args: vec![Type::Dyn],
                result: Type::Dyn,
                implementation: Implementation::Emitter("network"),
            }],
            "TCP connection from a host/port options object; returns the shared native Socket view before asynchronous connect/error delivery",
            &["tests/corpus/5454-net-connect-options/main.ts"],
        ),
        Api::native(
            "net",
            "createServer",
            Lowering::Direct,
            vec![
                Builtin {
                    ir: "net.createServer",
                    args: vec![],
                    result: Type::Dyn,
                    implementation: Implementation::Emitter("network"),
                },
                Builtin {
                    ir: "net.createServerListener",
                    args: vec![Type::Func {
                        rest: false,
                        params: vec![Type::Dyn],
                        ret: Box::new(Type::Void),
                    }],
                    result: Type::Dyn,
                    implementation: Implementation::Emitter("network"),
                },
            ],
            "Creates an identity-preserving native local-domain Server with an optional connection listener and on/once/off/listen/close event methods",
            &["packages/compiler-rust/tests/native.rs"],
        ),
    ]
}
