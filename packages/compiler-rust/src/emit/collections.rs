//! Collections have acyclic typed contents and shared reference identity.
use super::*;

fn key_equality(ty: &Type) -> &'static str {
    if *ty == Type::Dyn {
        "native_value_same_key(a, b)"
    } else if *ty == Type::F64 {
        "a == b || (a.is_nan() && b.is_nan())"
    } else {
        "a == b"
    }
}

fn lookup(option: &str, stored: &Type, result: &Type, module: &Module) -> String {
    if *stored == Type::Dyn && *result == Type::Dyn {
        return format!("({option}).unwrap_or(NativeValue::Undefined)");
    }
    let Type::Union { union_id } = result else {
        unreachable!("IR validated")
    };
    let target = &module.unions[*union_id];
    let undefined = target
        .arms
        .iter()
        .position(|a| *a == Type::Undefined)
        .unwrap();
    let present = if stored == result {
        "value".into()
    } else if let Type::Union { union_id: source } = stored {
        let cases = module.unions[*source]
            .arms
            .iter()
            .enumerate()
            .map(|(tag, arm)| {
                let target_tag = target.arms.iter().position(|a| a == arm).unwrap();
                format!("U{source}::V{tag}(value) => U{union_id}::V{target_tag}(value)")
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("match value {{ {cases} }}")
    } else {
        let tag = target.arms.iter().position(|a| a == stored).unwrap();
        format!("U{union_id}::V{tag}(value)")
    };
    format!("match {option} {{ Some(value) => {present}, None => U{union_id}::V{undefined}(()) }}")
}

pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    Some(match value {
        Expr::ArrayGet {
            arr, index, r#type, ..
        } => {
            let value = format!(
                "{{ let array = {}; let index = {}; runtime::array_get(&array, index) }}",
                expr(arr, function, module),
                expr(index, function, module)
            );
            if *r#type == Type::String {
                format!("({value}).to_string()")
            } else {
                value
            }
        }
        Expr::MapNew {
            seed,
            r#type: Type::Map { key, .. },
            ..
        } => {
            let normalize = if **key == Type::Dyn {
                "let key = native_map_key(key);"
            } else if **key == Type::F64 {
                "let key = if key == 0.0 { 0.0 } else { key };"
            } else {
                ""
            };
            let entries = seed.iter().map(|pair| {
                format!("{{ let key = {}; {normalize} let value = {}; js_map_set(&map, key, value, |a, b| {}); }}",
                    expr(&pair.key, function, module), expr(&pair.value, function, module), key_equality(key))
            }).collect::<String>();
            format!(
                "{{ let map: {} = runtime::Gc::new(NativeMap {{ entries: Vec::new() }}); {entries} map }}",
                rust_type(value.ty(), module)
            )
        }
        Expr::MapIntrinsic {
            receiver,
            method,
            args,
            r#type,
            ..
        } => {
            let Type::Map { key, value } = receiver.ty() else {
                unreachable!("IR validated")
            };
            let arguments = args
                .iter()
                .enumerate()
                .map(|(i, a)| format!("let arg{i} = {};", expr(a, function, module)))
                .collect::<String>();
            let equality = key_equality(&key);
            let operation = match method.as_str() {
                "get" => lookup(
                    &format!("js_map_get(&map, &arg0, |a, b| {equality})"),
                    &value,
                    r#type,
                    module,
                ),
                "has" => format!("js_map_has(&map, &arg0, |a, b| {equality})"),
                "delete" => format!("js_map_delete(&map, &arg0, |a, b| {equality})"),
                "set" => format!(
                    "{{ {} js_map_set(&map, arg0, arg1, |a, b| {equality}) }}",
                    if *key == Type::Dyn {
                        "let arg0 = native_map_key(arg0);"
                    } else if *key == Type::F64 {
                        "let arg0 = if arg0 == 0.0 { 0.0 } else { arg0 };"
                    } else {
                        ""
                    }
                ),
                "clear" => "{ map.with_mut(|map| map.entries.clear()); }".into(),
                "size" => "{ let size = map.with(|map| map.entries.len() as f64); size }".into(),
                _ => unreachable!("IR validated"),
            };
            format!(
                "{{ let map = {}; {arguments} {operation} }}",
                expr(receiver, function, module)
            )
        }
        Expr::RecordKeyGet {
            obj, key, r#type, ..
        } => {
            let Type::Record { shape_id } = obj.ty() else {
                unreachable!("IR validated")
            };
            let stored = module.records[shape_id].index_value.as_ref().unwrap();
            let result = lookup(
                "object.with(|object| js_dict_get(&object.overflow, &key))",
                stored,
                r#type,
                module,
            );
            format!(
                "{{ let object = {}; let key = {}; let result = {result}; result }}",
                expr(obj, function, module),
                expr(key, function, module)
            )
        }
        Expr::ArrayIntrinsic {
            receiver,
            method,
            args,
            ..
        } => {
            if method == "length" {
                format!(
                    "runtime::array_len(&({}))",
                    expr(receiver, function, module)
                )
            } else {
                let arguments = args
                    .iter()
                    .enumerate()
                    .map(|(i, arg)| format!("let arg{i} = {};", expr(arg, function, module)))
                    .collect::<String>();
                let writes = args
                    .iter()
                    .enumerate()
                    .map(|(i, arg)| {
                        format!(
                            "runtime::array_push(&array, {});",
                            if arg.ty() == Type::String {
                                format!("runtime::JsString::from(arg{i})")
                            } else {
                                format!("arg{i}")
                            }
                        )
                    })
                    .collect::<String>();
                format!(
                    "{{ let array = {}; {arguments} {writes} runtime::array_len(&array) }}",
                    expr(receiver, function, module)
                )
            }
        }
        _ => return None,
    })
}
