//! Collections have acyclic typed contents and shared reference identity.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Emission<'_>, out: &mut String) {
    out.push_str("struct NativeMapValuesIterator { owner: Option<NativeValue>, cursor: Option<NativeMapCursor> }\nimpl runtime::Trace for NativeMapValuesIterator { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { if let Some(owner) = &self.owner { owner.trace_native(tracer); } } }\nimpl runtime::ClearEdges for NativeMapValuesIterator { fn clear_edges(&mut self) { self.owner = None; self.cursor = None; } }\n");
    let mut needed = Vec::new();
    let mut objects = Vec::new();
    module.visit_expressions(&mut |value| {
        if let Expr::MapIntrinsic {
            method, receiver, ..
        } = value
            && (method == "valuesIterator" || method == "valuesIteratorObject")
            && !needed.contains(&receiver.ty())
        {
            needed.push(receiver.ty());
        }
        if let Expr::MapIntrinsic {
            method, receiver, ..
        } = value
            && method == "valuesIteratorObject"
            && !objects.contains(&receiver.ty())
        {
            objects.push(receiver.ty());
        }
    });
    let types = values::types(module);
    out.push_str("fn native_map_values_next(iterator: runtime::Gc<NativeMapValuesIterator>) -> NativeValue { let value = iterator.with_mut(|iterator| { let Some(owner) = &iterator.owner else { return None }; let cursor = iterator.cursor.as_ref().expect(\"live Map iterator cursor\"); let index = cursor.index.get(); let value: Option<NativeValue> = match owner {\n");
    for ty in &objects {
        let index = types
            .iter()
            .position(|candidate| candidate == ty)
            .expect("represented Map type");
        if dynamic_map(ty) {
            out.push_str("NativeValue::Map(map) => map.with(|data| data.entries.get(index).map(|(_, value)| value.clone())),\n");
        } else {
            writeln!(out, "NativeValue::V{index}(map) => map.storage.with(|data| data.entries.get(index).map(|(_, value)| value.clone())),").unwrap();
        }
    }
    out.push_str("_ => unreachable!(\"validated Map iterator owner\"), }; if value.is_some() { cursor.index.set(index + 1); } else { iterator.owner = None; iterator.cursor = None; } value }); match value { Some(value) => native_iterator_result(value, false), None => native_iterator_result(NativeValue::Undefined, true) } }\n");
    for ty in needed {
        let Type::Map { key, .. } = &ty else {
            unreachable!("validated Map iterator")
        };
        let index = types
            .iter()
            .position(|candidate| candidate == &ty)
            .expect("represented Map type");
        let key = rust_type((**key).clone(), module);
        let map_type = rust_type(ty.clone(), module);
        let storage = if dynamic_map(&ty) {
            "map"
        } else {
            "map.storage"
        };
        writeln!(out, "fn native_map_values_step_{index}(generator: runtime::JsGenerator<NativeValue, (), ()>, map: runtime::Gc<NativeMap<{key}, NativeValue>>, cursor: NativeMapCursor, command: runtime::GeneratorCommand<(), ()>) -> runtime::GeneratorStep<NativeValue, ()> {{ match command {{ runtime::GeneratorCommand::Next(()) => {{ let index = cursor.index.get(); let entry = map.with(|data| data.entries.get(index).cloned()); if let Some((_, value)) = entry {{ cursor.index.set(index + 1); runtime::generator_suspend(&generator, move |generator, command| native_map_values_step_{index}(generator, map, cursor, command)); runtime::GeneratorStep::Yielded(value) }} else {{ runtime::GeneratorStep::Returned(None) }} }}, runtime::GeneratorCommand::Return(value) => runtime::GeneratorStep::Returned(value), runtime::GeneratorCommand::Throw(reason) => runtime::rethrow_caught(reason), }} }}\nfn native_map_values_iterator_{index}(map: {map_type}) -> runtime::JsGenerator<NativeValue, (), ()> {{ let map = {storage}; let cursor = NativeMapCursor::new(map.identity()); runtime::generator_new(move |generator, command| native_map_values_step_{index}(generator, map, cursor, command)) }}").unwrap();
    }
}

fn key_equality(ty: &Type) -> &'static str {
    if *ty == Type::Dyn {
        "native_value_same_key(a, b)"
    } else if *ty == Type::F64 {
        "a == b || (a.is_nan() && b.is_nan())"
    } else {
        "a == b"
    }
}

pub(super) fn key_hash(ty: &Type, value: &str) -> String {
    match ty {
        Type::String => format!("Some({value}.stable_hash())"),
        Type::Bool => format!("Some(native_hash_key(&{value}))"),
        Type::F64 => format!("Some(native_number_key_hash({value}))"),
        Type::Dyn => format!("native_value_key_hash(&{value})"),
        _ => "None".into(),
    }
}

fn lookup(option: &str, stored: &Type, result: &Type, module: &Emission<'_>) -> String {
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

fn dynamic_map(ty: &Type) -> bool {
    matches!(ty, Type::Map { key, value } if **key == Type::Dyn && **value == Type::Dyn)
}

fn typed_map_view(value: &Type, storage: &str, module: &Emission<'_>) -> String {
    let read = values::checked_value(value, "value.clone()", module);
    let write = values::boxed(value, "value", module);
    format!("NativeTypedMap {{ storage: {storage}, read: |value| {read}, write: |value| {write} }}")
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    Some(match value {
        Expr::ArrayGet { arr, index, .. } => {
            format!(
                "{{ let array = {}; let index = {}; runtime::array_get(&array, index) }}",
                expr(arr, function, module),
                expr(index, function, module)
            )
        }
        Expr::MapNew {
            seed,
            r#type: Type::Map {
                key,
                value: map_value,
            },
            ..
        } => {
            let normalize = if **key == Type::Dyn {
                "let key = native_map_key(key);"
            } else if **key == Type::F64 {
                "let key = if key == 0.0 { 0.0 } else { key };"
            } else {
                ""
            };
            let erased = !dynamic_map(&value.ty());
            let entries = seed.iter().map(|pair| {
                let hash = key_hash(key, "key");
                let stored = if erased {
                    values::boxed(map_value, &expr(&pair.value, function, module), module)
                } else {
                    expr(&pair.value, function, module)
                };
                format!("{{ let key = {}; {normalize} let value = {}; let hash = {hash}; js_map_set(&map, key, value, hash, |a, b| {}); }}",
                    expr(&pair.key, function, module), stored, key_equality(key))
            }).collect::<String>();
            let storage = "runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() })";
            if erased {
                let view = typed_map_view(map_value, "map", module);
                format!("{{ let map = {storage}; {entries} {view} }}")
            } else {
                format!(
                    "{{ let map: {} = {storage}; {entries} map }}",
                    rust_type(value.ty(), module)
                )
            }
        }
        Expr::LibCall {
            r#fn,
            args,
            r#type:
                target @ Type::Map {
                    value: target_value,
                    ..
                },
            ..
        } if r#fn == "map.valueView" => {
            let source_type = args[0].ty();
            let source_storage = if dynamic_map(&source_type) {
                "source.clone()"
            } else {
                "source.storage.clone()"
            };
            let source = expr(&args[0], function, module);
            if dynamic_map(target) {
                format!("{{ let source = {source}; {source_storage} }}")
            } else {
                let view = typed_map_view(target_value, source_storage, module);
                format!("{{ let source = {source}; {view} }}")
            }
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "map.sameIdentity" => {
            let left_type = args[0].ty();
            let right_type = args[1].ty();
            let left_storage = if dynamic_map(&left_type) {
                "left"
            } else {
                "left.storage"
            };
            let right_storage = if dynamic_map(&right_type) {
                "right"
            } else {
                "right.storage"
            };
            format!(
                "{{ let left = {}; let right = {}; {left_storage}.ptr_eq(&{right_storage}) }}",
                expr(&args[0], function, module),
                expr(&args[1], function, module)
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
            let erased = !dynamic_map(&receiver.ty());
            let arguments = args
                .iter()
                .enumerate()
                .map(|(i, a)| format!("let arg{i} = {};", expr(a, function, module)))
                .collect::<String>();
            let equality = key_equality(&key);
            let hash = key_hash(&key, "arg0");
            let storage = if erased { "map.storage" } else { "map" };
            let read = |raw: &str| {
                if erased {
                    format!("({raw}).map(|value| (map.read)(&value))")
                } else {
                    raw.to_string()
                }
            };
            let operation = match method.as_str() {
                "get" => lookup(
                    &read(&format!(
                        "js_map_get(&{storage}, &arg0, {hash}, |a, b| {equality})"
                    )),
                    &value,
                    r#type,
                    module,
                ),
                "has" => format!("js_map_has(&{storage}, &arg0, {hash}, |a, b| {equality})"),
                "delete" => format!("js_map_delete(&{storage}, &arg0, {hash}, |a, b| {equality})"),
                "set" => format!(
                    "{{ {} let hash = {}; js_map_set(&{storage}, arg0, {}, hash, |a, b| {equality}) }}",
                    if *key == Type::Dyn {
                        "let arg0 = native_map_key(arg0);"
                    } else if *key == Type::F64 {
                        "let arg0 = if arg0 == 0.0 { 0.0 } else { arg0 };"
                    } else {
                        ""
                    },
                    key_hash(&key, "arg0"),
                    if erased { "(map.write)(arg1)" } else { "arg1" }
                ),
                "clear" => format!("{{ js_map_clear(&{storage}); }}"),
                "forEach" => {
                    let map_value = values::boxed(&receiver.ty(), "map.clone()", module);
                    let entry_key = values::boxed(&key, "entry_key", module);
                    let entry_value_expression = if erased {
                        "(map.read)(&entry_value)"
                    } else {
                        "entry_value"
                    };
                    let entry_value = values::boxed(&value, entry_value_expression, module);
                    format!(
                        "{{ if !native_value_is_function(&arg0) {{ native_map_foreach_callback_error(&arg0); }} let cursor = NativeMapCursor::new({storage}.identity()); let map_value = {map_value}; loop {{ let index = cursor.index.get(); let entry = {storage}.with(|data| data.entries.get(index).cloned()); let Some((entry_key, entry_value)) = entry else {{ break; }}; cursor.index.set(index + 1); let _ = native_value_call_with_this(arg0.clone(), arg1.clone(), vec![{entry_value}, {entry_key}, map_value.clone()], \"Map.forEach callback\"); }} }}"
                    )
                }
                "size" => {
                    format!("{{ let size = {storage}.with(|map| map.entries.len() as f64); size }}")
                }
                "keysToArray" => format!(
                    "runtime::array_new({storage}.with(|map| map.entries.iter().map(|(key, _)| key.clone()).collect()))"
                ),
                "valuesIterator" => {
                    let ty = receiver.ty();
                    let index = values::types(module)
                        .iter()
                        .position(|candidate| candidate == &ty)
                        .expect("represented Map type");
                    format!("native_map_values_iterator_{index}(map.clone())")
                }
                "valuesIteratorObject" => {
                    let ty = receiver.ty();
                    let owner = values::boxed(&ty, "map.clone()", module);
                    format!(
                        "NativeValue::MapValuesIterator(runtime::Gc::new(NativeMapValuesIterator {{ cursor: Some(NativeMapCursor::new({storage}.identity())), owner: Some({owner}) }}))"
                    )
                }
                "valuesToArray" => {
                    if erased {
                        format!(
                            "runtime::array_new({storage}.with(|storage| storage.entries.iter().map(|(_, value)| (map.read)(value)).collect()))"
                        )
                    } else {
                        format!(
                            "runtime::array_new({storage}.with(|storage| storage.entries.iter().map(|(_, value)| value.clone()).collect()))"
                        )
                    }
                }
                "entriesToArray" => {
                    let Type::Array { elem } = r#type else {
                        unreachable!("IR validated")
                    };
                    if matches!(elem.as_ref(), Type::Array { .. }) {
                        let value = if erased {
                            "(map.read)(value)"
                        } else {
                            "value.clone()"
                        };
                        return Some(format!(
                            "{{ let map = {}; {arguments} runtime::array_new({storage}.with(|storage| storage.entries.iter().map(|(key, value)| runtime::array_new(vec![key.clone(), {value}])).collect())) }}",
                            expr(receiver, function, module)
                        ));
                    }
                    let Type::Record { shape_id } = elem.as_ref() else {
                        unreachable!("IR validated")
                    };
                    let record = &module.records[*shape_id];
                    let key_field = field_name(
                        &record
                            .fields
                            .iter()
                            .find(|field| field.name == "0")
                            .unwrap()
                            .name,
                    );
                    let value_field = field_name(
                        &record
                            .fields
                            .iter()
                            .find(|field| field.name == "1")
                            .unwrap()
                            .name,
                    );
                    let value = if erased {
                        "(map.read)(value)"
                    } else {
                        "value.clone()"
                    };
                    format!(
                        "runtime::array_new({storage}.with(|storage| storage.entries.iter().map(|(key, value)| runtime::Gc::new(R{shape_id} {{ source: None, own_keys: vec![\"0\".into(), \"1\".into()], {key_field}: Some(key.clone()), {value_field}: Some({value}) }})).collect()))"
                    )
                }
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
            let entries = if record_storage::shared(&module.records[shape_id], module) {
                // Shared dictionary layouts store every own property through
                // NativeValue so independently materialized structural views
                // keep one object identity. Reinstall the indexed element's
                // typed view lazily at the read boundary.
                let checked = values::checked_value(stored, "value", module);
                format!(
                    "object.with(|object| js_dict_get(&object.entries, &key)).map(|value| {checked})"
                )
            } else {
                "object.with(|object| js_dict_get(&object.overflow, &key))".into()
            };
            let result = lookup(&entries, stored, r#type, module);
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
            r#type,
            ..
        } => {
            if method == "length" {
                format!(
                    "runtime::array_len(&({}))",
                    expr(receiver, function, module)
                )
            } else if method == "freeze" {
                format!(
                    "{{ let array = {}; runtime::array_freeze(&array); array }}",
                    expr(receiver, function, module)
                )
            } else if method == "hasStoredValue" {
                format!(
                    "{{ let array = {}; let index = {}; runtime::array_state(&array, index) == 1.0 }}",
                    expr(receiver, function, module),
                    expr(&args[0], function, module)
                )
            } else if method == "join" {
                format!(
                    "{{ let array = {}; let separator = {}; if let Some(source) = runtime::array_mapped_source::<NativeValue, runtime::JsString>(&array) {{ match native_array_join(NativeValue::Array(source), vec![NativeValue::String(separator)]) {{ NativeValue::String(value) => value, _ => unreachable!(\"native Array.join returns a string\") }} }} else {{ runtime::array_join(&array, &separator) }} }}",
                    expr(receiver, function, module),
                    expr(&args[0], function, module)
                )
            } else if method == "nextPresent" {
                format!(
                    "{{ let array = {}; let start = {}; runtime::array_next_present(&array, start) }}",
                    expr(receiver, function, module),
                    expr(&args[0], function, module)
                )
            } else if method == "previousPresent" {
                format!(
                    "{{ let array = {}; let start = {}; runtime::array_previous_present(&array, start) }}",
                    expr(receiver, function, module),
                    expr(&args[0], function, module)
                )
            } else if method == "slice" {
                let start = args
                    .first()
                    .map(|value| expr(value, function, module))
                    .unwrap_or_else(|| "0.0_f64".into());
                let end = args
                    .get(1)
                    .map(|value| expr(value, function, module))
                    .unwrap_or_else(|| "f64::INFINITY".into());
                format!(
                    "{{ let array = {}; let start = {start}; let end = {end}; runtime::array_slice(&array, start, end) }}",
                    expr(receiver, function, module)
                )
            } else if method == "fill" {
                let value = expr(&args[0], function, module);
                let start = args
                    .get(1)
                    .map(|arg| expr(arg, function, module))
                    .unwrap_or_else(|| "0.0_f64".into());
                let end = args
                    .get(2)
                    .map(|arg| expr(arg, function, module))
                    .unwrap_or_else(|| "f64::INFINITY".into());
                format!(
                    "{{ let array = {}; let value = {value}; let start = {start}; let end = {end}; runtime::array_fill(&array, value, start, end) }}",
                    expr(receiver, function, module)
                )
            } else if method == "reverse" {
                format!(
                    "{{ let array = {}; runtime::array_reverse(&array) }}",
                    expr(receiver, function, module)
                )
            } else if method == "splice" {
                let start = expr(&args[0], function, module);
                let delete_count = expr(&args[1], function, module);
                let items = args[2..]
                    .iter()
                    .map(|arg| expr(arg, function, module))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "{{ let array = {}; let start = {start}; let delete_count = {delete_count}; let items = vec![{items}]; runtime::array_splice_with_items(&array, start, delete_count, items) }}",
                    expr(receiver, function, module)
                )
            } else if method == "indexOf" {
                let Type::Array { elem } = receiver.ty() else {
                    unreachable!("validated array")
                };
                let needle = expr(&args[0], function, module);
                let start = args
                    .get(1)
                    .map(|arg| expr(arg, function, module))
                    .unwrap_or_else(|| "0.0_f64".into());
                let left = values::box_value(&elem, "left.clone()", module);
                let right = values::box_value(&elem, "right.clone()", module);
                format!(
                    "{{ let array = {}; let needle = {needle}; let start = {start}; runtime::array_index_of_from_by(&array, &needle, start, |left, right| native_value_eq(&({left}), &({right}))) }}",
                    expr(receiver, function, module)
                )
            } else if method == "entriesToArray" {
                let Type::Array { elem } = r#type else {
                    unreachable!("validated array.entries result")
                };
                let Type::Record { shape_id } = elem.as_ref() else {
                    unreachable!("validated array.entries tuple")
                };
                let record = &module.records[*shape_id];
                debug_assert!(record.tuple && record.fields.len() == 2);
                let index_field = field_name("0");
                let value_field = field_name("1");
                format!(
                    "{{ let array = {}; let length = runtime::array_len(&array) as usize; runtime::array_new((0..length).map(|index| runtime::Gc::new(R{shape_id} {{ source: None, own_keys: vec![\"0\".into(), \"1\".into()], {index_field}: Some(index as f64), {value_field}: Some(runtime::array_get(&array, index as f64)) }})).collect()) }}",
                    expr(receiver, function, module)
                )
            } else if method == "pop" || method == "shift" {
                let Type::Array { elem } = receiver.ty() else {
                    unreachable!("IR validated")
                };
                let option: String = if method == "pop" {
                    "{ let length = runtime::array_len(&array); if length == 0.0 { None } else if runtime::array_state(&array, length - 1.0) != 1.0 { runtime::array_set_length(&array, length - 1.0); None } else { Some(runtime::array_pop(&array)) } }".into()
                } else {
                    "runtime::array_shift_optional(&array)".into()
                };
                let operation = lookup(&option, &elem, r#type, module);
                format!(
                    "{{ let array = {}; {operation} }}",
                    expr(receiver, function, module)
                )
            } else if method == "push" {
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
            } else if method == "unshift" {
                let arguments = args
                    .iter()
                    .enumerate()
                    .map(|(i, arg)| format!("let arg{i} = {};", expr(arg, function, module)))
                    .collect::<String>();
                let values = args
                    .iter()
                    .enumerate()
                    .map(|(i, arg)| {
                        if arg.ty() == Type::String {
                            format!("runtime::JsString::from(arg{i})")
                        } else {
                            format!("arg{i}")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "{{ let array = {}; {arguments} runtime::array_unshift(&array, vec![{values}]) }}",
                    expr(receiver, function, module)
                )
            } else if method == "unshiftFrom" {
                format!(
                    "{{ let array = {}; let values = {}; runtime::array_unshift_from(&array, &values) }}",
                    expr(receiver, function, module),
                    expr(&args[0], function, module)
                )
            } else if method == "concat" {
                let arguments = args
                    .iter()
                    .enumerate()
                    .map(|(i, arg)| format!("let arg{i} = {};", expr(arg, function, module)))
                    .collect::<String>();
                let writes = args
                    .iter()
                    .enumerate()
                    .map(|(i, arg)| {
                        if matches!(arg.ty(), Type::Array { .. }) {
                            format!("runtime::array_concat_from(&result, &arg{i});")
                        } else {
                            format!(
                                "runtime::array_push(&result, {});",
                                if arg.ty() == Type::String {
                                    format!("runtime::JsString::from(arg{i})")
                                } else {
                                    format!("arg{i}")
                                }
                            )
                        }
                    })
                    .collect::<String>();
                format!(
                    "{{ let array = {}; {arguments} let result = runtime::array_new(Vec::new()); runtime::array_concat_from(&result, &array); {writes} result }}",
                    expr(receiver, function, module)
                )
            } else if method == "concatFrom" {
                format!(
                    "{{ let array = {}; let source = {}; runtime::array_concat_from(&array, &source) }}",
                    expr(receiver, function, module),
                    expr(&args[0], function, module)
                )
            } else {
                unreachable!("unsupported native array intrinsic")
            }
        }
        _ => return None,
    })
}
