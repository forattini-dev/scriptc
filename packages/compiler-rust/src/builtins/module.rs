use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![Api::special(
        "module",
        "createRequire",
        Access::Call,
        "module.require.missing",
        "throw_error_code",
        "Returns a native require function for the original base location. A compiled binary has no module loader at run time, so every call with a represented string specifier throws Node's MODULE_NOT_FOUND error after evaluating the specifier; statically linked require sites keep their ordinary CommonJS lowering. Native addons, require.resolve, require.cache and other require members are not represented",
        &["tests/corpus/rust-native-module-create-require/main.ts"],
    )]
}
