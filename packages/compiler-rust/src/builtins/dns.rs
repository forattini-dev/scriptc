use super::{Api, Builtin, Implementation, Lowering};
use crate::ir::Type;

pub fn apis() -> Vec<Api> {
    let callback = Type::Dyn;
    let mut apis = vec![Api::native(
        "dns",
        "lookup",
        Lowering::Direct,
        vec![
            Builtin {
                ir: "dns.lookup",
                args: vec![Type::String, Type::Dyn, callback.clone()],
                result: Type::Void,
                implementation: Implementation::Emitter("dns"),
            },
            Builtin {
                ir: "dns.lookupDefault",
                args: vec![Type::String, callback],
                result: Type::Void,
                implementation: Implementation::Emitter("dns"),
            },
        ],
        "Node-style callback lookup with family, all-address and result-order options",
        &["tests/corpus/5440-dns-lookup-callback/main.ts"],
    )];
    apis.extend([
        ("resolveCaa", "dns.resolveCaa"),
        ("resolveCname", "dns.resolveCname"),
        ("resolveMx", "dns.resolveMx"),
        ("resolveNaptr", "dns.resolveNaptr"),
        ("resolveNs", "dns.resolveNs"),
        ("resolvePtr", "dns.resolvePtr"),
        ("resolveSoa", "dns.resolveSoa"),
        ("resolveSrv", "dns.resolveSrv"),
        ("resolveTxt", "dns.resolveTxt"),
        ("reverse", "dns.reverse"),
    ]
    .into_iter()
    .map(|(member, ir)| {
        Api::native(
            "dns/promises",
            member,
            Lowering::Direct,
            vec![Builtin {
                ir,
                args: vec![Type::String],
                result: Type::Promise {
                    inner: Box::new(Type::Dyn),
                },
                implementation: Implementation::Emitter("dns"),
            }],
            "One represented hostname resolved by the native DNS client; the Promise payload is checked at its typed consumer",
            &["tests/corpus/rust-native-dns-records/main.ts"],
        )
    })
    .collect::<Vec<_>>());
    for (member, ir) in [("resolve4", "dns.resolve4"), ("resolve6", "dns.resolve6")] {
        apis.push(Api::native(
            "dns/promises",
            member,
            Lowering::Direct,
            vec![
                Builtin {
                    ir,
                    args: vec![Type::String],
                    result: Type::Promise {
                        inner: Box::new(Type::Dyn),
                    },
                    implementation: Implementation::Emitter("dns"),
                },
                Builtin {
                    ir: if member == "resolve4" {
                        "dns.resolve4Options"
                    } else {
                        "dns.resolve6Options"
                    },
                    args: vec![Type::String, Type::Dyn],
                    result: Type::Promise {
                        inner: Box::new(Type::Dyn),
                    },
                    implementation: Implementation::Emitter("dns"),
                },
            ],
            "One represented hostname and optional TTL option; resolves address records through the native DNS client",
            &["tests/corpus/rust-native-dns-records/main.ts"],
        ));
    }
    apis
}
