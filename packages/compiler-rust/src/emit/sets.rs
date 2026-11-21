//! Set operations use the same traced owning storage as native maps.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Emission<'_>, out: &mut String) {
    out.push_str(r#"
fn native_set_insert_value(set: &runtime::Gc<NativeMap<NativeValue, bool>>, value: NativeValue) {
    let value = native_map_key(value);
    let hash = native_value_key_hash(&value);
    js_map_set(set, value, true, hash, native_value_same_key);
}
fn native_set_dynamic_iterator_step(generator: runtime::JsGenerator<NativeValue, (), ()>, set: runtime::Gc<NativeMap<NativeValue, bool>>, cursor: NativeMapCursor, command: runtime::GeneratorCommand<(), ()>) -> runtime::GeneratorStep<NativeValue, ()> {
    match command {
        runtime::GeneratorCommand::Next(()) => {
            let index = cursor.index.get();
            let value = set.with(|data| data.entries.get(index).map(|(value, _)| value.clone()));
            if let Some(value) = value {
                cursor.index.set(index + 1);
                runtime::generator_suspend(&generator, move |generator, command| native_set_dynamic_iterator_step(generator, set, cursor, command));
                runtime::GeneratorStep::Yielded(value)
            } else { runtime::GeneratorStep::Returned(None) }
        },
        runtime::GeneratorCommand::Return(value) => runtime::GeneratorStep::Returned(value),
        runtime::GeneratorCommand::Throw(reason) => runtime::rethrow_caught(reason),
    }
}
fn native_set_dynamic_iterator<T: 'static>(set: NativeTypedSet<T>) -> runtime::JsGenerator<NativeValue, (), ()> {
    let cursor = NativeMapCursor::new(set.identity());
    let storage = set.storage;
    runtime::generator_new(move |generator, command| native_set_dynamic_iterator_step(generator, storage, cursor, command))
}
fn native_set_seed(set: &runtime::Gc<NativeMap<NativeValue, bool>>, source: NativeValue) {
    if matches!(source, NativeValue::Undefined | NativeValue::Null) { return; }
    if let Some(owner) = native_set_storage(&source) {
        let cursor = NativeMapCursor::new(owner.identity());
        loop {
            let index = cursor.index.get();
            let value = owner.with(|data| data.entries.get(index).map(|(value, _)| value.clone()));
            let Some(value) = value else { break; };
            cursor.index.set(index + 1);
            native_set_insert_value(set, value);
        }
        return;
    }
    if native_set_seed_collection(set, &source) { return; }
    if let NativeValue::String(text) = &source {
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut index = 0;
        while index < units.len() {
            let width = if (0xd800..=0xdbff).contains(&units[index]) && index + 1 < units.len() && (0xdc00..=0xdfff).contains(&units[index + 1]) { 2 } else { 1 };
            native_set_insert_value(set, NativeValue::String(runtime::JsString::from_utf16(&units[index..index + width])));
            index += width;
        }
        return;
    }
    let method = native_value_symbol_get(source.clone(), runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator));
    let iterator = native_value_call_with_this(method, source, Vec::new(), "Symbol.iterator");
    if !native_value_test(&iterator, "objectInstance") { runtime::throw_type_error("Result of the Symbol.iterator method is not an object".into()); }
    let next = native_value_get(iterator.clone(), runtime::string("next"));
    loop {
        let result = native_value_call_with_this(next.clone(), iterator.clone(), Vec::new(), "Iterator.next");
        if !native_value_test(&result, "objectInstance") { runtime::throw_type_error("Iterator result is not an object".into()); }
        if native_value_test(&native_value_get(result.clone(), runtime::string("done")), "truthy") { break; }
        let value = native_value_get(result, runtime::string("value"));
        native_set_insert_value(set, value);
    }
}
"#);
    out.push_str("fn native_set_seed_collection(set: &runtime::Gc<NativeMap<NativeValue, bool>>, source: &NativeValue) -> bool { match source {\n");
    out.push_str("NativeValue::Map(owner) => { let cursor = NativeMapCursor::new(owner.identity()); loop { let index = cursor.index.get(); let entry = owner.with(|data| data.entries.get(index).cloned()); let Some((key, value)) = entry else { break }; cursor.index.set(index + 1); native_set_insert_value(set, NativeValue::Array(runtime::array_new(vec![key, value]))); } true },\n");
    let types = values::types(module);
    for (index, ty) in types.iter().enumerate() {
        match ty {
            Type::Bytes { .. } => {
                writeln!(out, "NativeValue::V{index}(bytes) => {{ let length = runtime::bytes_len(bytes) as usize; for index in 0..length {{ native_set_insert_value(set, NativeValue::Number(runtime::bytes_get(bytes, index as f64))); }} true }},").unwrap();
            }
            Type::Map { key, .. } if values::specialized(ty, module) => {
                let boxed_key = values::boxed(key, "key", module);
                writeln!(out, "NativeValue::V{index}(map) => {{ let owner = map.storage.clone(); let cursor = NativeMapCursor::new(owner.identity()); loop {{ let index = cursor.index.get(); let entry = owner.with(|data| data.entries.get(index).cloned()); let Some((key, value)) = entry else {{ break }}; cursor.index.set(index + 1); let key = {boxed_key}; native_set_insert_value(set, NativeValue::Array(runtime::array_new(vec![key, value]))); }} true }},").unwrap();
            }
            _ => {}
        }
    }
    out.push_str("_ => false, } }\n");
    let mut needed = Vec::new();
    module.visit_expressions(&mut |value| {
        if let Expr::SetIntrinsic {
            method, receiver, ..
        } = value
            && method == "iterator"
            && !needed.contains(&receiver.ty())
        {
            needed.push(receiver.ty());
        }
    });
    for ty in needed {
        let Type::Set { elem } = &ty else {
            unreachable!("validated Set iterator")
        };
        let index = types
            .iter()
            .position(|candidate| candidate == &ty)
            .expect("represented Set type");
        let element = rust_type((**elem).clone(), module);
        writeln!(out, "fn native_set_iterator_step_{index}(generator: runtime::JsGenerator<{element}, (), ()>, set: NativeTypedSet<{element}>, cursor: NativeMapCursor, command: runtime::GeneratorCommand<(), ()>) -> runtime::GeneratorStep<{element}, ()> {{ match command {{ runtime::GeneratorCommand::Next(()) => {{ let index = cursor.index.get(); let entry = set.storage.with(|data| data.entries.get(index).cloned()); if let Some((value, _)) = entry {{ cursor.index.set(index + 1); let value = (set.read)(&value); runtime::generator_suspend(&generator, move |generator, command| native_set_iterator_step_{index}(generator, set, cursor, command)); runtime::GeneratorStep::Yielded(value) }} else {{ runtime::GeneratorStep::Returned(None) }} }}, runtime::GeneratorCommand::Return(value) => runtime::GeneratorStep::Returned(value), runtime::GeneratorCommand::Throw(reason) => runtime::rethrow_caught(reason), }} }}\nfn native_set_iterator_{index}(set: NativeTypedSet<{element}>) -> runtime::JsGenerator<{element}, (), ()> {{ let cursor = NativeMapCursor::new(set.identity()); runtime::generator_new(move |generator, command| native_set_iterator_step_{index}(generator, set, cursor, command)) }}").unwrap();
    }
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    Some(match value {
        Expr::SetNew {
            seed,
            r#type: Type::Set { elem },
            ..
        } => {
            let read = values::checked_value(elem, "value.clone()", module);
            let write = values::boxed(elem, "value", module);
            let insert = "let value = native_map_key((set.write)(value)); let hash = native_value_key_hash(&value); js_map_set(&set.storage, value, true, hash, native_value_same_key);";
            let seed = seed.as_ref().map(|seed| {
                if seed.ty() == Type::Dyn {
                    format!("native_set_seed(&set.storage, {});", expr(seed, function, module))
                } else {
                    format!("let seed = {}; let length = runtime::array_len(&seed) as usize; for index in 0..length {{ let value = {} ; {insert} }}", expr(seed, function, module), "runtime::array_get(&seed, index as f64)")
                }
            }).unwrap_or_default();
            format!(
                "{{ let storage = runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::<(NativeValue, bool)>::new(), hash_index: NativeHashIndex::default() }}); let set = NativeTypedSet {{ storage, read: |value| {read}, write: |value| {write} }}; {seed} set }}"
            )
        }
        Expr::SetIntrinsic {
            receiver,
            method,
            args,
            ..
        } => {
            let Type::Set { elem } = receiver.ty() else {
                unreachable!("IR validated")
            };
            let arguments = args
                .iter()
                .enumerate()
                .map(|(i, arg)| format!("let arg{i} = {};", expr(arg, function, module)))
                .collect::<String>();
            let operation = match method.as_str() {
                "size" => "set.storage.with(|set| set.entries.len() as f64)".into(),
                "toArray" => {
                    let array = "runtime::array_new(set.storage.with(|data| data.entries.iter().map(|(value, _)| value.clone()).collect()))";
                    if *elem == Type::Dyn {
                        array.into()
                    } else {
                        let read = values::checked_value(&elem, "value", module);
                        let write = values::boxed(&elem, "value", module);
                        format!("runtime::array_mapped({array}, |value| {read}, |value| {write})")
                    }
                }
                "iterator" => {
                    let ty = receiver.ty();
                    let index = values::types(module).iter().position(|candidate| candidate == &ty).expect("represented Set type");
                    format!("native_set_iterator_{index}(set.clone())")
                }
                "dynamicIterator" => "native_set_dynamic_iterator(set.clone())".into(),
                "clear" => "js_map_clear(&set.storage)".into(),
                "has" => "{ let arg0 = (set.write)(arg0); let hash = native_value_key_hash(&arg0); js_map_has(&set.storage, &arg0, hash, native_value_same_key) }".into(),
                "delete" => "{ let arg0 = (set.write)(arg0); let hash = native_value_key_hash(&arg0); js_map_delete(&set.storage, &arg0, hash, native_value_same_key) }".into(),
                "add" => "{ let arg0 = native_map_key((set.write)(arg0)); let hash = native_value_key_hash(&arg0); js_map_set(&set.storage, arg0, true, hash, native_value_same_key); }".into(),
                "hasValue" => "{ let hash = native_value_key_hash(&arg0); js_map_has(&set.storage, &arg0, hash, native_value_same_key) }".into(),
                "deleteValue" => "{ let hash = native_value_key_hash(&arg0); js_map_delete(&set.storage, &arg0, hash, native_value_same_key) }".into(),
                "addValue" => "{ let arg0 = native_map_key(arg0); let hash = native_value_key_hash(&arg0); js_map_set(&set.storage, arg0, true, hash, native_value_same_key); }".into(),
                _ => unreachable!("IR validated"),
            };
            format!(
                "{{ let set = {}; {arguments} {operation} }}",
                expr(receiver, function, module)
            )
        }
        _ => return None,
    })
}
