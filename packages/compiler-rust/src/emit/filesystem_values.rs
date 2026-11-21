use super::*;

pub(super) fn definitions(module: &Emission<'_>, output: &mut String) {
    let mut used = false;
    module.visit_expressions(&mut |expr| {
        used |= matches!(expr, Expr::LibCall { r#fn, .. } if r#fn.starts_with("fs.namespace."));
    });
    if !used {
        return;
    }
    output.push_str(
        "fn native_fs_namespace_option_bool(options: &NativeValue, name: &str) -> bool { match options { NativeValue::Undefined => false, _ => match native_value_get(options.clone(), runtime::string(name)) { NativeValue::Undefined => false, NativeValue::Boolean(value) => value, _ => runtime::throw_type_error(format!(\"filesystem option {name} must be boolean\").into()), } } }\n",
    );
}

fn string_arg(value: &Expr, function: &Function, module: &Emission<'_>) -> String {
    values::checked_value(&Type::String, &expr(value, function, module), module)
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let Expr::LibCall { r#fn, args, .. } = value else {
        return None;
    };
    let code = match r#fn.as_str() {
        "fs.namespace.existsSync" => format!(
            "runtime::fs_exists(&({}))",
            string_arg(&args[0], function, module)
        ),
        "fs.namespace.lstatSync" => {
            let call = format!(
                "runtime::fs_lstat_sync(&({}))",
                string_arg(&args[0], function, module)
            );
            values::box_value(&Type::Stats, &call, module)
        }
        "fs.namespace.mkdirSync" => format!(
            "{{ let path = {}; let options = {}; if native_fs_namespace_option_bool(&options, \"recursive\") {{ runtime::fs_mkdir_recursive(&path); }} else {{ runtime::fs_mkdir(&path); }} NativeValue::Undefined }}",
            string_arg(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        "fs.namespace.readdirSync" => {
            let call = format!(
                "runtime::fs_readdir(&({}))",
                string_arg(&args[0], function, module)
            );
            values::box_value(
                &Type::Array {
                    elem: Box::new(Type::String),
                },
                &call,
                module,
            )
        }
        "fs.namespace.readlinkSync" => format!(
            "NativeValue::String(runtime::fs_readlink(&({})))",
            string_arg(&args[0], function, module)
        ),
        "fs.namespace.renameSync" => format!(
            "runtime::fs_rename(&({}), &({}))",
            string_arg(&args[0], function, module),
            string_arg(&args[1], function, module)
        ),
        "fs.namespace.rmSync" => format!(
            "{{ let path = {}; let options = {}; let recursive = native_fs_namespace_option_bool(&options, \"recursive\"); let force = native_fs_namespace_option_bool(&options, \"force\"); runtime::fs_rm_options(&path, recursive, force); }}",
            string_arg(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        "fs.namespace.symlinkSync" => format!(
            "{{ let target = {}; let path = {}; let kind = match {} {{ NativeValue::Undefined => runtime::string(\"file\"), NativeValue::String(value) => value, _ => runtime::throw_type_error(\"symlink type must be a string\".into()), }}; runtime::fs_symlink(&target, &path, &kind); }}",
            string_arg(&args[0], function, module),
            string_arg(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        "fs.namespace.unlinkSync" => format!(
            "runtime::fs_unlink(&({}))",
            string_arg(&args[0], function, module)
        ),
        _ => return None,
    };
    Some(code)
}
