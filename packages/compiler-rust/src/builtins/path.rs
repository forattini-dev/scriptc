use super::*;
pub(super) fn apis() -> Vec<Api> {
    let operations = vec![
        call!("path.join", [strings()], String, "path_join"),
        call!("path.resolve", [strings()], String, "path_resolve"),
        call!("path.normalize", [String], String, "path_normalize"),
        call!("path.dirname", [String], String, "path_dirname"),
        call!("path.basename", [String, String], String, "path_basename"),
        call!("path.extname", [String], String, "path_extname"),
        call!("path.isAbsolute", [String], Bool, "path_is_absolute"),
        call!("path.relative", [String, String], String, "path_relative"),
        call!("path.win32Join", [strings()], String, "path_win32_join"),
        call!(
            "path.win32Resolve",
            [strings()],
            String,
            "path_win32_resolve"
        ),
        call!(
            "path.win32Normalize",
            [String],
            String,
            "path_win32_normalize"
        ),
        call!("path.win32Dirname", [String], String, "path_win32_dirname"),
        call!(
            "path.win32Basename",
            [String, String],
            String,
            "path_win32_basename"
        ),
        call!("path.win32Extname", [String], String, "path_win32_extname"),
        call!(
            "path.win32IsAbsolute",
            [String],
            Bool,
            "path_win32_is_absolute"
        ),
        call!(
            "path.win32Relative",
            [String, String],
            String,
            "path_win32_relative"
        ),
    ];
    operations.into_iter().map(|op| {
        let (module, suffix) = if let Some(name) = op.ir.strip_prefix("path.win32") {
            ("path/win32", name)
        } else { ("path", op.ir.strip_prefix("path.").unwrap()) };
        let name = match suffix {
            "Join" | "join" => "join", "Resolve" | "resolve" => "resolve",
            "Normalize" | "normalize" => "normalize", "Dirname" | "dirname" => "dirname",
            "Basename" | "basename" => "basename", "Extname" | "extname" => "extname",
            "IsAbsolute" | "isAbsolute" => "isAbsolute", "Relative" | "relative" => "relative",
            _ => unreachable!(),
        };
        let lowering = match name { "join" | "resolve" => Lowering::PathVariadic,
            "basename" => Lowering::PathBasename, _ => Lowering::Direct };
        Api::native(module, name, lowering, vec![op],
            "Primitive string paths; variadic join/resolve and omitted basename suffix; non-string overloads refused",
            &["tests/corpus/rust-native-platform/paths.ts"])
    }).collect()
}
