//! WeakMap library operations snapshot arguments before validating the key.
use super::*;
pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let Expr::LibCall { r#fn, args, .. } = value else {
        return None;
    };
    let operation = r#fn.strip_prefix("weakmap.")?;
    let emit = |value: &Expr| expr(value, function, module);
    let instance = if module.classes.is_empty() {
        ""
    } else {
        "NativeValue::Instance(value) => Some(runtime::WeakKey::new(value)),"
    };
    let key = if matches!(args[1].ty(), Type::Object { .. }) {
        "Some(runtime::WeakKey::new(&key))".into()
    } else {
        format!(
            r#"match &key {{ NativeValue::Record(_, value) => Some(runtime::WeakKey::new(value)), NativeValue::Object(value) => Some(runtime::WeakKey::new(value)), {instance} NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_) | NativeValue::Boolean(_) | NativeValue::String(_) => None, _ => runtime::throw_type_error("scriptc: WeakMap key representation is not ported".into()) }}"#
        )
    };
    let result = match operation {
        "get" => {
            "key.as_ref().and_then(|key| runtime::weak_map_get::<NativeValue>(&owner, key)).unwrap_or(NativeValue::Undefined)"
        }
        "has" => {
            "key.as_ref().is_some_and(|key| runtime::weak_map_has::<NativeValue>(&owner, key))"
        }
        "delete" => {
            "key.as_ref().is_some_and(|key| runtime::weak_map_delete::<NativeValue>(&owner, key))"
        }
        "set" => {
            r#"match key { Some(key) => runtime::weak_map_set(&owner, &key, value), None => runtime::throw_type_error("Invalid value used as weak map key".into()) }"#
        }
        _ => return None,
    };
    Some(format!(
        "{{ let receiver = {}; let key = {}; {} let owner = runtime::WeakKey::new(&receiver); let key = {key}; {result} }}",
        emit(&args[0]),
        emit(&args[1]),
        if operation == "set" {
            format!("let value = {};", emit(&args[2]))
        } else {
            String::new()
        }
    ))
}
