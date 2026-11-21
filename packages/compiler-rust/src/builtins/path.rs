use super::*;

pub(super) fn internal() -> Vec<Builtin> {
    vec![
        call!(
            "path.selectedJoin",
            [Bool, strings()],
            String,
            "path_selected_join"
        ),
        call!(
            "path.selectedIsAbsolute",
            [Bool, String],
            Bool,
            "path_selected_is_absolute"
        ),
        call!(
            "path.selectedResolve",
            [Bool, strings()],
            String,
            "path_selected_resolve"
        ),
        call!(
            "path.selectedNormalize",
            [Bool, String],
            String,
            "path_selected_normalize"
        ),
        call!(
            "path.selectedDirname",
            [Bool, String],
            String,
            "path_selected_dirname"
        ),
        call!(
            "path.selectedBasename",
            [Bool, String, String],
            String,
            "path_selected_basename"
        ),
        call!(
            "path.selectedExtname",
            [Bool, String],
            String,
            "path_selected_extname"
        ),
        call!(
            "path.selectedRelative",
            [Bool, String, String],
            String,
            "path_selected_relative"
        ),
        call!("path.selectedSep", [Bool], String, "path_selected_sep"),
        call!(
            "path.selectedDelimiter",
            [Bool],
            String,
            "path_selected_delimiter"
        ),
    ]
}

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
    let mut entries = operations.into_iter().map(|op| {
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
    }).collect::<Vec<_>>();
    for (module, operation) in [
        ("path", call!("path.posixSep", [], String, "path_posix_sep")),
        (
            "path/win32",
            call!("path.win32Sep", [], String, "path_win32_sep"),
        ),
    ] {
        let mut entry = Api::native(
            module,
            "sep",
            Lowering::Property,
            vec![operation],
            "Import- or namespace-proven immutable path separator, readable in nested compiled closures",
            &["tests/corpus/rust-native-platform/glob.ts"],
        );
        entry.access = Access::Property;
        entries.push(entry);
    }
    for (module, operation) in [
        (
            "path",
            call!("path.posixDelimiter", [], String, "path_posix_delimiter"),
        ),
        (
            "path/win32",
            call!("path.win32Delimiter", [], String, "path_win32_delimiter"),
        ),
    ] {
        let mut entry = Api::native(
            module,
            "delimiter",
            Lowering::Property,
            vec![operation],
            "Import- or namespace-proven immutable PATH-list delimiter, readable in nested compiled closures",
            &["tests/corpus/5254-path-delimiter-capture.ts"],
        );
        entry.access = Access::Property;
        entries.push(entry);
    }
    entries
}
