//! Existing portable AsyncLocalStorage library operations.
use super::*;

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let Expr::LibCall { r#fn, args, .. } = value else {
        return None;
    };
    let emit = |v: &Expr| expr(v, function, module);
    Some(match r#fn.as_str() {
        "als.new" => "runtime::async_local_new::<NativeValue>()".into(),
        "als.get" => format!(
            "runtime::async_local_get::<NativeValue>({}).unwrap_or(NativeValue::Undefined)",
            emit(&args[0])
        ),
        "als.run" => format!(
            "{{ let handle = {}; let value = {}; let callback = {}; let arguments = {}; let values = match arguments {{ NativeValue::Array(array) => {{ let mut values = Vec::new(); let mut index = 0.0; while index < runtime::array_len(&array) {{ values.push(runtime::array_get(&array, index)); index += 1.0; }} values }}, _ => runtime::throw_type_error(\"scriptc: native AsyncLocalStorage arguments must be an array\".into()) }}; let _context = runtime::async_local_run::<NativeValue>(handle, value); native_value_call(callback, values, \"AsyncLocalStorage.run\") }}",
            emit(&args[0]),
            emit(&args[1]),
            emit(&args[2]),
            emit(&args[3])
        ),
        _ => return None,
    })
}
