//! Native value erasure keeps typed owning handles and compiled call targets.
use super::*;
use std::fmt::Write;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct AdapterPruning {
    pub discovered: usize,
    pub retained: usize,
    pub removed_bytes: usize,
}

fn adapter_name_at(value: &str, start: usize) -> Option<&str> {
    const PREFIXES: [&str; 3] = ["native_box_", "native_try_", "native_check_"];
    let tail = &value[start..];
    let prefix = PREFIXES
        .into_iter()
        .find(|prefix| tail.starts_with(prefix))?;
    let digits = tail[prefix.len()..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    (digits != 0).then(|| &tail[..prefix.len() + digits])
}

fn adapter_names(value: &str) -> std::collections::BTreeSet<String> {
    let mut names = std::collections::BTreeSet::new();
    for prefix in ["native_box_", "native_try_", "native_check_"] {
        let mut offset = 0;
        while let Some(relative) = value[offset..].find(prefix) {
            let start = offset + relative;
            if let Some(name) = adapter_name_at(value, start) {
                names.insert(name.to_owned());
                offset = start + name.len();
            } else {
                offset = start + prefix.len();
            }
        }
    }
    names
}

fn adapter_definition_name(line: &str) -> Option<String> {
    let start = line.find("fn native_")? + 3;
    let name = adapter_name_at(line, start)?;
    line[start + name.len()..]
        .starts_with('(')
        .then(|| name.to_owned())
}

/// Remove generated value adapters that cannot be reached by the emitted
/// program. Dependencies between adapters are followed transitively, so an
/// array or union view retains every box/check/try operation needed by its
/// conversion body. This is deliberately limited to the mechanically emitted
/// one-line adapter family; general Rust source remains untouched.
pub(super) fn prune_unused_adapters(source: String) -> (String, AdapterPruning) {
    let lines = source.split_inclusive('\n').collect::<Vec<_>>();
    let mut definitions = std::collections::BTreeMap::<String, (usize, Vec<String>)>::new();
    for (line_index, line) in lines.iter().enumerate() {
        let Some(name) = adapter_definition_name(line) else {
            continue;
        };
        let dependencies = adapter_names(line)
            .into_iter()
            .filter(|dependency| dependency != &name)
            .collect();
        definitions.insert(name, (line_index, dependencies));
    }
    if definitions.is_empty() {
        return (source, AdapterPruning::default());
    }

    let definition_lines = definitions
        .values()
        .map(|(line, _)| *line)
        .collect::<std::collections::HashSet<_>>();
    let mut reachable = std::collections::BTreeSet::new();
    for (line_index, line) in lines.iter().enumerate() {
        if definition_lines.contains(&line_index) {
            continue;
        }
        reachable.extend(
            adapter_names(line)
                .into_iter()
                .filter(|name| definitions.contains_key(name)),
        );
    }
    let mut pending = reachable.iter().cloned().collect::<Vec<_>>();
    while let Some(name) = pending.pop() {
        let Some((_, dependencies)) = definitions.get(&name) else {
            continue;
        };
        for dependency in dependencies {
            if definitions.contains_key(dependency) && reachable.insert(dependency.clone()) {
                pending.push(dependency.clone());
            }
        }
    }

    let retained_lines = reachable
        .iter()
        .filter_map(|name| definitions.get(name).map(|(line, _)| *line))
        .collect::<std::collections::HashSet<_>>();
    let mut result = String::with_capacity(source.len());
    let mut removed_bytes = 0;
    for (line_index, line) in lines.into_iter().enumerate() {
        if definition_lines.contains(&line_index) && !retained_lines.contains(&line_index) {
            removed_bytes += line.len();
        } else {
            result.push_str(line);
        }
    }
    (
        result,
        AdapterPruning {
            discovered: definitions.len(),
            retained: retained_lines.len(),
            removed_bytes,
        },
    )
}

pub(super) fn collect_types(
    module: &Module,
    callable_functions: &std::collections::HashSet<String>,
) -> Vec<Type> {
    fn visit(ty: &Type, out: &mut Vec<Type>, seen: &mut std::collections::HashSet<Type>) {
        if *ty == Type::Void || !seen.insert(ty.clone()) {
            return;
        }
        out.push(ty.clone());
        match ty {
            Type::Func { params, ret, .. } => {
                for p in params {
                    visit(p, out, seen);
                }
                visit(ret, out, seen);
            }
            Type::Array { elem } | Type::Set { elem } => visit(elem, out, seen),
            Type::Promise { inner } => visit(inner, out, seen),
            Type::Generator {
                yield_type,
                return_type,
                next_type,
                ..
            } => {
                visit(yield_type, out, seen);
                visit(return_type, out, seen);
                visit(next_type, out, seen);
            }
            Type::Map { key, value } => {
                visit(key, out, seen);
                visit(value, out, seen);
            }
            _ => {}
        }
    }
    let mut out = vec![
        Type::Dyn,
        Type::Undefined,
        Type::Null,
        Type::F64,
        Type::Bool,
        Type::String,
        Type::Regex,
        Type::Symbol,
        Type::Bigint,
        Type::Map {
            key: Box::new(Type::Dyn),
            value: Box::new(Type::Dyn),
        },
    ];
    let mut seen = out
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    for f in &module.functions {
        if callable_functions.contains(&f.name) {
            visit(
                &Type::Func {
                    rest: f.rest,
                    params: f.params.iter().map(|p| p.r#type.clone()).collect(),
                    ret: Box::new(f.call_result()),
                },
                &mut out,
                &mut seen,
            );
        }
        visit(&f.return_type, &mut out, &mut seen);
        // Generator functions publish their owning generator object through
        // call_result even though the function body's return channel may be
        // void. Erased class-method adapters still need that value ABI.
        visit(&f.call_result(), &mut out, &mut seen);
        for l in &f.locals {
            visit(&l.r#type, &mut out, &mut seen);
        }
        for p in &f.params {
            visit(&p.r#type, &mut out, &mut seen);
        }
    }
    for r in &module.records {
        visit(&Type::Record { shape_id: r.id }, &mut out, &mut seen);
        for f in &r.fields {
            visit(&f.r#type, &mut out, &mut seen);
        }
        if let Some(t) = &r.index_value {
            visit(t, &mut out, &mut seen);
        }
    }
    for u in &module.unions {
        visit(&Type::Union { union_id: u.id }, &mut out, &mut seen);
        for t in &u.arms {
            visit(t, &mut out, &mut seen);
        }
    }
    for g in &module.globals {
        visit(&g.r#type, &mut out, &mut seen);
    }
    for c in &module.classes {
        visit(
            &Type::Object {
                class_name: c.name.clone(),
            },
            &mut out,
            &mut seen,
        );
        visit(
            &Type::Classval {
                class_name: c.name.clone(),
            },
            &mut out,
            &mut seen,
        );
        for f in c.fields.iter().skip(module.class_header_len(c)) {
            visit(&f.r#type, &mut out, &mut seen);
        }
    }
    module.visit_expressions(&mut |e| visit(&e.ty(), &mut out, &mut seen));
    out
}
pub(super) fn types(module: &Emission<'_>) -> Vec<Type> {
    module.value_types().to_vec()
}
fn id(ty: &Type, module: &Emission<'_>) -> usize {
    module.value_type_id(ty)
}
pub(super) fn specialized(ty: &Type, module: &Emission<'_>) -> bool {
    if let Type::Record { shape_id } = ty
        && record_storage::shared(&module.records[*shape_id], module)
    {
        return false;
    }
    if matches!(ty, Type::Map { key, value } if **key == Type::Dyn && **value == Type::Dyn) {
        return false;
    }
    if matches!(ty, Type::Array { elem } if **elem == Type::Dyn) {
        return false;
    }
    matches!(
        ty,
        Type::Record { .. }
            | Type::Array { .. }
            | Type::Map { .. }
            | Type::Set { .. }
            | Type::Generator { .. }
            | Type::Classval { .. }
            | Type::Bytes { .. }
            | Type::CryptoHash
            | Type::CryptoSign
            | Type::Child
            | Type::Stats
            | Type::Dirent
    )
}
pub(super) fn boxed(ty: &Type, value: &str, module: &Emission<'_>) -> String {
    if let Type::Record { shape_id } = ty
        && record_storage::shared(&module.records[*shape_id], module)
    {
        return format!(
            "native_box_shared_record({value}, {})",
            module.record_tag(*shape_id)
        );
    }
    format!("native_box_{}({value})", id(ty, module))
}
fn checked(ty: &Type, value: &str, module: &Emission<'_>) -> String {
    if let Type::Record { shape_id } = ty
        && record_storage::shared(&module.records[*shape_id], module)
    {
        return format!(
            "native_check_shared_record(&({value}), {})",
            module.record_tag(*shape_id)
        );
    }
    format!("native_check_{}(&({value}))", id(ty, module))
}

fn dynamic_generator_adapter(
    index: usize,
    ty: &Type,
    module: &Emission<'_>,
) -> Option<(String, String)> {
    let Type::Generator {
        r#async: false,
        yield_type,
        return_type,
        next_type,
    } = ty
    else {
        return None;
    };
    let runtime_type = rust_type(ty.clone(), module);
    let yield_runtime = rust_type((**yield_type).clone(), module);
    let return_runtime = rust_type((**return_type).clone(), module);
    let next_runtime = rust_type((**next_type).clone(), module);
    let next_argument = if matches!(**next_type, Type::Void | Type::Undefined) {
        "{ let _ = sc_input; NativeValue::Undefined }".into()
    } else {
        boxed(next_type, "sc_input", module)
    };
    let yielded = if matches!(**yield_type, Type::Void | Type::Undefined) {
        "{ let _ = sc_value; () }".into()
    } else {
        checked(yield_type, "sc_value", module)
    };
    let returned = if matches!(**return_type, Type::Void | Type::Undefined) {
        "{ let _ = sc_value; runtime::GeneratorStep::Returned(None) }".into()
    } else {
        format!(
            "runtime::GeneratorStep::Returned(Some({}))",
            checked(return_type, "sc_value", module)
        )
    };
    let return_arguments = if matches!(**return_type, Type::Void | Type::Undefined) {
        "if sc_value.is_some() { vec![NativeValue::Undefined] } else { Vec::new() }".into()
    } else {
        format!(
            "sc_value.clone().map(|sc_value| vec![{}]).unwrap_or_default()",
            boxed(return_type, "sc_value", module)
        )
    };
    let fallback_return = "runtime::GeneratorStep::Returned(sc_value)";
    let definitions = format!(
        "fn native_dynamic_iterator_step_{index}(sc_generator: {runtime_type}, sc_iterator: NativeValue, sc_next: NativeValue, sc_command: runtime::GeneratorCommand<{next_runtime}, {return_runtime}>) -> runtime::GeneratorStep<{yield_runtime}, {return_runtime}> {{ match sc_command {{\n\
runtime::GeneratorCommand::Next(sc_input) => {{ let sc_argument = {next_argument}; let sc_arguments = if runtime::generator_next_has_argument(&sc_generator) {{ vec![sc_argument] }} else {{ Vec::new() }}; let sc_result = native_value_call_with_this(sc_next.clone(), sc_iterator.clone(), sc_arguments, \"Iterator.next\"); if !native_value_test(&sc_result, \"objectInstance\") {{ runtime::throw_type_error(\"Iterator result is not an object\".into()); }} let sc_done = native_value_test(&native_value_get(sc_result.clone(), runtime::string(\"done\")), \"truthy\"); let sc_value = native_value_get(sc_result, runtime::string(\"value\")); if sc_done {{ return {returned}; }} let sc_next_iterator = sc_iterator.clone(); let sc_next_method = sc_next.clone(); runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| native_dynamic_iterator_step_{index}(sc_generator, sc_next_iterator, sc_next_method, sc_command)); runtime::GeneratorStep::Yielded({yielded}) }},\n\
runtime::GeneratorCommand::Return(sc_value) => {{ if native_value_has_key(sc_iterator.clone(), runtime::string(\"return\")) {{ let sc_arguments = {return_arguments}; let sc_method = native_value_get(sc_iterator.clone(), runtime::string(\"return\")); let sc_result = native_value_call_with_this(sc_method, sc_iterator, sc_arguments, \"Iterator.return\"); if !native_value_test(&sc_result, \"objectInstance\") {{ runtime::throw_type_error(\"Iterator result is not an object\".into()); }} let sc_value = native_value_get(sc_result, runtime::string(\"value\")); {returned} }} else {{ {fallback_return} }} }},\n\
runtime::GeneratorCommand::Throw(sc_reason) => runtime::rethrow_caught(sc_reason),\n\
}} }}\n\
fn native_dynamic_iterator_{index}(sc_source: NativeValue) -> {runtime_type} {{ let sc_iterator = if native_value_has_key(sc_source.clone(), runtime::string(\"next\")) {{ sc_source }} else {{ let sc_method = native_value_symbol_get(sc_source.clone(), runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator)); native_value_call_with_this(sc_method, sc_source, Vec::new(), \"Symbol.iterator\") }}; let sc_next = native_value_get(sc_iterator.clone(), runtime::string(\"next\")); runtime::generator_new(move |sc_generator, sc_command| native_dynamic_iterator_step_{index}(sc_generator, sc_iterator, sc_next, sc_command)) }}\n"
    );
    let instance = if module.classes.is_empty() {
        ""
    } else {
        "matches!(value, NativeValue::Instance(_)) || "
    };
    let check = format!(
        "if let Some(exact) = native_try_{index}(value) {{ return exact; }} if {instance}native_value_has_key(value.clone(), runtime::string(\"next\")) || native_value_has_symbol_key(value.clone(), NativeValue::Symbol(runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator))) {{ return native_dynamic_iterator_{index}(value.clone()); }}"
    );
    Some((definitions, check))
}

fn instance_method_slots(module: &Emission<'_>) -> Vec<(usize, String)> {
    let mut slots = Vec::new();
    for (index, class) in module.classes.iter().enumerate() {
        let mut names = std::collections::BTreeSet::new();
        let mut current = Some(class);
        while let Some(owner) = current {
            names.extend(owner.method_names.iter().cloned());
            current = owner.base.as_deref().and_then(|base| module.class(base));
        }
        slots.extend(
            names
                .into_iter()
                .filter(|name| module.method(&class.name, name).is_some())
                .map(|name| (index, name)),
        );
    }
    slots
}

fn instance_method_owner(module: &Emission<'_>, mut index: usize, name: &str) -> usize {
    loop {
        let class = &module.classes[index];
        if class.method_names.iter().any(|method| method == name) {
            return index;
        }
        let Some(base) = class.base.as_ref() else {
            return index;
        };
        let Some(parent) = module
            .classes
            .iter()
            .position(|candidate| &candidate.name == base)
        else {
            return index;
        };
        index = parent;
    }
}

const CALLABLE_DISPATCH_GROUP: usize = 64;

fn function_call_body(ty: &Type, module: &Emission<'_>) -> String {
    let Type::Func { params, ret, rest } = ty else {
        unreachable!("callable dispatch only contains function types")
    };
    let function_name = functions::type_name(ty, module);
    // A typed forwarding view is only a compile-time ABI for typed callers.
    // An erased invocation must expose the original JavaScript return value,
    // even when it does not match the view's declared result type.
    let forward_result = "native_value_call_with_this(original, receiver, args, name)";
    let args = params
        .iter()
        .enumerate()
        .map(|(index, ty)| {
            if *rest && index + 1 == params.len() {
                let Type::Array { elem } = ty else {
                    unreachable!("validated rest ABI")
                };
                let value = checked(elem, "item.clone()", module);
                let value = if **elem == Type::String {
                    format!("runtime::JsString::from({value})")
                } else {
                    value
                };
                return format!(
                    ", runtime::array_new(args.iter().skip({index}).map(|item| {value}).collect())"
                );
            }
            format!(
                ", {}",
                checked(
                    ty,
                    &format!("args.get({index}).cloned().unwrap_or(NativeValue::Undefined)"),
                    module
                )
            )
        })
        .collect::<String>();
    let call = format!(
        "call_{}_with_this(function, receiver{args})",
        functions::type_name(ty, module)
    );
    let result = if **ret == Type::Void {
        format!("{{ {call}; NativeValue::Undefined }}")
    } else {
        boxed(ret, &call, module)
    };
    format!(
        "{{ let original = function.with(|value| match value {{ {function_name}::Forward {{ original, .. }} => original.clone(), _ => None }}); if let Some(original) = original {{ {forward_result} }} else {{ {result} }} }}"
    )
}

fn callable_dispatch_definitions(types: &[Type], module: &Emission<'_>, out: &mut String) {
    let callables = types
        .iter()
        .enumerate()
        .filter(|(_, ty)| matches!(ty, Type::Func { .. }))
        .collect::<Vec<_>>();
    for (group, chunk) in callables.chunks(CALLABLE_DISPATCH_GROUP).enumerate() {
        writeln!(out, "fn native_value_call_group_{group}(target: NativeCallableTarget{group}, receiver: NativeValue, args: Vec<NativeValue>, name: &str) -> NativeValue {{ match target {{").unwrap();
        for (index, ty) in chunk {
            let body = function_call_body(ty, module);
            writeln!(
                out,
                "NativeCallableTarget{group}::V{index}(function) => {body},"
            )
            .unwrap();
        }
        out.push_str("} }\n");
    }
    out.push_str("fn native_value_call_compiled(callee: runtime::Gc<NativeCallable>, receiver: NativeValue, args: Vec<NativeValue>, name: &str) -> NativeValue { let target = callee.with(|callable| callable.target.as_ref().expect(\"scriptc: cleared callable target\").clone()); match target {\n");
    for group in 0..callables.len().div_ceil(CALLABLE_DISPATCH_GROUP) {
        writeln!(
            out,
            "NativeCallableTarget::G{group}(target) => native_value_call_group_{group}(target, receiver, args, name),"
        )
        .unwrap();
    }
    out.push_str("} }\n");
}

pub(super) fn definitions(module: &Emission<'_>, out: &mut String) {
    out.push_str("thread_local! {\n    static NATIVE_NAVIGATOR: std::cell::RefCell<Option<runtime::Gc<NativeMap<runtime::JsString, NativeValue>>>> = const { std::cell::RefCell::new(None) };\n    static NATIVE_PROCESS: std::cell::RefCell<Option<runtime::Gc<NativeMap<runtime::JsString, NativeValue>>>> = const { std::cell::RefCell::new(None) };\n    static NATIVE_GLOBAL_OBJECT: std::cell::RefCell<Option<runtime::Gc<NativeMap<runtime::JsString, NativeValue>>>> = const { std::cell::RefCell::new(None) };\n}\nfn native_navigator_value() -> NativeValue { NativeValue::Object(NATIVE_NAVIGATOR.with(|slot| slot.borrow_mut().get_or_insert_with(|| { let mut entries = Vec::new(); js_data_set(&mut entries, runtime::string(\"userAgent\"), NativeValue::String(runtime::navigator_user_agent())); runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries, hash_index: NativeHashIndex::default() }) }).clone())) }\nfn native_process_value() -> NativeValue { NativeValue::Object(NATIVE_PROCESS.with(|slot| slot.borrow_mut().get_or_insert_with(|| { let mut entries = Vec::new(); js_data_set(&mut entries, runtime::string(\"version\"), NativeValue::String(runtime::process_version())); js_data_set(&mut entries, runtime::string(\"platform\"), NativeValue::String(runtime::process_platform())); js_data_set(&mut entries, runtime::string(\"arch\"), NativeValue::String(runtime::process_arch())); js_data_set(&mut entries, runtime::string(\"execPath\"), NativeValue::String(runtime::process_exec_path())); js_data_set(&mut entries, runtime::string(\"pid\"), NativeValue::Number(runtime::process_pid())); runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries, hash_index: NativeHashIndex::default() }) }).clone())) }\nfn native_global_object() -> NativeValue { NativeValue::Object(NATIVE_GLOBAL_OBJECT.with(|slot| slot.borrow_mut().get_or_insert_with(|| { let mut entries = Vec::new(); js_data_set(&mut entries, runtime::string(\"navigator\"), native_navigator_value()); js_data_set(&mut entries, runtime::string(\"process\"), native_process_value()); js_data_set(&mut entries, runtime::string(\"fetch\"), NativeValue::Fetch); js_data_set(&mut entries, runtime::string(\"AbortSignal\"), NativeValue::AbortSignalConstructor); js_data_set(&mut entries, runtime::string(\"RegExp\"), NativeValue::RegexConstructor); js_data_set(&mut entries, runtime::string(\"unescape\"), NativeValue::LegacyUnescape); runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries, hash_index: NativeHashIndex::default() }) }).clone())) }\nfn clear_native_global_object() { NATIVE_GLOBAL_OBJECT.with(|slot| *slot.borrow_mut() = None); NATIVE_NAVIGATOR.with(|slot| *slot.borrow_mut() = None); NATIVE_PROCESS.with(|slot| *slot.borrow_mut() = None); }\n");
    out.push_str("fn native_intl_value() -> NativeValue { let NativeValue::Object(global) = native_global_object() else { unreachable!() }; if let Some(value) = global.with(|data| data.entries.iter().find(|(key, _)| key == \"Intl\").map(|(_, value)| value.clone())) { return value; } let intl = NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"Segmenter\"), NativeValue::Undefined)], hash_index: NativeHashIndex::default() })); global.with_mut(|data| data.entries.push((runtime::string(\"Intl\"), intl.clone()))); intl }\n");
    if module.classes.is_empty() {
        out.push_str("fn native_instance_accessor_key(_: &NativeValue) -> Option<runtime::WeakKey> { None }\n");
    } else {
        out.push_str("fn native_instance_accessor_key(value: &NativeValue) -> Option<runtime::WeakKey> { match value { NativeValue::Instance(object) => Some(runtime::WeakKey::new(object)), _ => None } }\n");
    }
    out.push_str(include_str!("ordinary_getters_support.rs"));
    out.push_str(include_str!("callable_views_support.rs"));
    out.push_str(include_str!("fs_callbacks_support.rs"));
    out.push_str(include_str!("http_server_support.rs"));
    property_delete::definitions(module, out);
    record_construction::definitions(module, out);
    out.push_str(include_str!("../compare_values_support.rs"));
    out.push_str("fn native_value_string(value: NativeValue) -> runtime::JsString { match value { NativeValue::Undefined => \"undefined\".into(), NativeValue::Null => \"null\".into(), NativeValue::Number(v) => runtime::JsString::from(js_string_number(v)), NativeValue::Boolean(v) => runtime::JsString::from(v.to_string()), NativeValue::String(v) => v, NativeValue::BigInt(v) => runtime::bigint_to_string(&v), NativeValue::Date(v) => runtime::date_value_to_string(&v), NativeValue::Url(v) => runtime::url_href(&v), NativeValue::SearchParams(v) => runtime::search_params_to_string(&v), NativeValue::Symbol(_) => runtime::throw_type_error(\"Cannot convert a Symbol value to a string\".into()), NativeValue::RawJson(_) => runtime::throw_type_error(\"Cannot convert object to primitive value\".into()), _ => runtime::throw_type_error(\"scriptc: object string conversion requires native ToPrimitive support\".into()) } }\n");
    out.push_str(include_str!("join_values_support.rs"));
    out.push_str("fn native_value_inspect(value: NativeValue) -> String { match value { NativeValue::Undefined => \"undefined\".into(), NativeValue::Null => \"null\".into(), NativeValue::Number(v) => js_string_number(v), NativeValue::Boolean(v) => v.to_string(), NativeValue::String(v) => v.to_utf8_lossy().to_owned(), NativeValue::BigInt(v) => format!(\"{}n\", runtime::bigint_to_string(&v).to_utf8_lossy()), NativeValue::Symbol(v) => runtime::symbol_to_string(&v).to_utf8_lossy().to_owned(), NativeValue::Array(v) | NativeValue::Bound(v) => format!(\"[Array({})]\", runtime::array_len(&v)), NativeValue::Map(v) => format!(\"Map({})\", v.with(|m| m.entries.len())), NativeValue::Regex(_) => \"/[native regex]/\".into(), NativeValue::Date(v) => runtime::date_value_to_string(&v).to_utf8_lossy().to_owned(), NativeValue::Url(v) => runtime::url_href(&v).to_utf8_lossy().to_owned(), NativeValue::Promise(_) => \"Promise { <pending> }\".into(), NativeValue::RawJson(_) | NativeValue::Record(_, _) | NativeValue::Object(_) => \"[object Object]\".into(), _ => \"[native object]\".into() } }\n");
    out.push_str("fn native_util_inspect(value: NativeValue) -> String { match value { NativeValue::String(value) => format!(\"'{}'\", value.to_utf8_lossy().replace('\\\\', \"\\\\\\\\\").replace('\\'', \"\\\\'\")), NativeValue::Array(value) => { let items = runtime::array_values(&value).into_iter().map(native_util_inspect).collect::<Vec<_>>().join(\", \" ); format!(\"[ {items} ]\") }, NativeValue::Object(value) => value.with(|object| { let items = object.entries.iter().map(|(key, value)| format!(\"{}: {}\", key, native_util_inspect(value.clone()))).collect::<Vec<_>>().join(\", \" ); let prefix = if object.null_prototype { \"[Object: null prototype] \" } else { \"\" }; format!(\"{prefix}{{ {items} }}\") }), other => native_value_inspect(other) } }\n");
    out.push_str("fn native_util_format_value(value: NativeValue) -> String { match value { NativeValue::String(value) => value.to_utf8_lossy().to_owned(), other => native_util_inspect(other) } }\n");
    out.push_str("fn native_debuglog_value(section: runtime::JsString) -> NativeValue { let wanted = section.to_utf8_lossy().to_ascii_lowercase(); let enabled = std::env::var(\"NODE_DEBUG\").ok().is_some_and(|value| value.split(',').map(str::trim).any(|pattern| { let pattern = pattern.to_ascii_lowercase(); pattern == \"*\" || pattern == wanted || (pattern.ends_with('*') && wanted.starts_with(&pattern[..pattern.len() - 1])) })); NativeValue::DebugLog(section, enabled) }\n");
    out.push_str(include_str!("../querystring_values_support.rs"));
    out.push_str(include_str!("../map_values_support.rs"));
    out.push_str(include_str!("../erased_array_methods_support.rs"));
    out.push_str(include_str!("../async_bypass_support.rs"));
    out.push_str(include_str!("../promise_values_support.rs"));
    out.push_str(include_str!("../fetch_values_support.rs"));
    out.push_str(include_str!("../dns_values_support.rs"));
    let types = types(module);
    out.push_str("fn native_querystring_array_values(value: &NativeValue) -> Option<Vec<NativeValue>> { match value { NativeValue::Array(values) | NativeValue::Bound(values) => Some(runtime::array_values(values)),\n");
    for (index, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && specialized(ty, module)
        {
            let boxed = box_value(elem, "value", module);
            writeln!(
                out,
                "NativeValue::V{index}(values) => Some(runtime::array_values(values).into_iter().map(|value| {boxed}).collect()),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => None, } }\n");
    out.push_str("fn native_fetch_body_bytes(value: NativeValue) -> Option<runtime::JsBytes<u8>> { match value { NativeValue::ArrayBuffer(body) => Some(body),\n");
    for (index, ty) in types.iter().enumerate() {
        if *ty == Type::bytes() {
            writeln!(
                out,
                "NativeValue::V{index}(body) => Some(runtime::buffer_from_bytes(&body)),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => None, } }\n");
    out.push_str("fn native_file_handle_bytes(value: NativeValue) -> Option<runtime::JsBytes<u8>> { match value { NativeValue::ArrayBuffer(bytes) => Some(bytes),\n");
    for (index, ty) in types.iter().enumerate() {
        if *ty == Type::bytes() {
            writeln!(out, "NativeValue::V{index}(bytes) => Some(bytes),").unwrap();
        }
    }
    out.push_str("_ => None, } }\n");
    out.push_str("fn native_u8_from_dynamic(value: NativeValue) -> runtime::JsBytes<u8> { match value { NativeValue::ArrayBuffer(bytes) => runtime::bytes_u8_window_view(&bytes), NativeValue::Array(values) => { let numbers = runtime::array_values(&values).into_iter().map(|value| native_compare_number(&value)).collect::<Vec<_>>(); runtime::bytes_from_array::<u8>(&runtime::array_new(numbers)) },\n");
    for (index, ty) in types.iter().enumerate() {
        match ty {
            Type::Bytes { elem } if elem == "u8" => {
                writeln!(
                    out,
                    "NativeValue::V{index}(bytes) => runtime::bytes_copy(&bytes),"
                )
                .unwrap();
            }
            Type::Bytes { .. } => {
                writeln!(out, "NativeValue::V{index}(bytes) => runtime::bytes_from_array::<u8>(&runtime::bytes_to_array(&bytes)),").unwrap();
            }
            Type::Array { elem } if **elem == Type::F64 && specialized(ty, module) => {
                writeln!(
                    out,
                    "NativeValue::V{index}(values) => runtime::bytes_from_array::<u8>(&values),"
                )
                .unwrap();
            }
            _ => {}
        }
    }
    out.push_str("other => runtime::bytes_alloc::<u8>(native_compare_number(&other)), } }\n");
    out.push_str("thread_local! { static NATIVE_OBJECT_PROTOTYPE: std::cell::RefCell<Option<runtime::Gc<NativeMap<runtime::JsString, NativeValue>>>> = const { std::cell::RefCell::new(None) }; static NATIVE_ITERATOR_PROTOTYPE: std::cell::RefCell<Option<runtime::Gc<NativeMap<runtime::JsString, NativeValue>>>> = const { std::cell::RefCell::new(None) }; static NATIVE_ARRAY_ITERATOR_PROTOTYPE: std::cell::RefCell<Option<runtime::Gc<NativeMap<runtime::JsString, NativeValue>>>> = const { std::cell::RefCell::new(None) }; }\n");
    out.push_str("fn clear_native_object_prototypes() { NATIVE_ARRAY_ITERATOR_PROTOTYPE.with(|slot| *slot.borrow_mut() = None); NATIVE_ITERATOR_PROTOTYPE.with(|slot| *slot.borrow_mut() = None); NATIVE_OBJECT_PROTOTYPE.with(|slot| *slot.borrow_mut() = None); }\n");
    out.push_str("fn native_object_prototype_value() -> NativeValue { NativeValue::Object(NATIVE_OBJECT_PROTOTYPE.with(|slot| slot.borrow_mut().get_or_insert_with(|| { let object = runtime::Gc::new(NativeMap { null_prototype: true, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }); let value = NativeValue::Object(object.clone()); native_define_ordinary_data_descriptor(&value, &runtime::string(\"toString\"), runtime::DataDescriptor { value: Some(NativeValue::ObjectToString), writable: Some(true), enumerable: Some(false), configurable: Some(true) }); object }).clone())) }\n");
    out.push_str("fn native_iterator_prototype_value() -> NativeValue { NativeValue::Object(NATIVE_ITERATOR_PROTOTYPE.with(|slot| slot.borrow_mut().get_or_insert_with(|| { let object = runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }); native_set_instance_prototype(&object, native_object_prototype_value()); object }).clone())) }\n");
    out.push_str("fn native_array_iterator_prototype_value() -> NativeValue { NativeValue::Object(NATIVE_ARRAY_ITERATOR_PROTOTYPE.with(|slot| slot.borrow_mut().get_or_insert_with(|| { let object = runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }); native_set_instance_prototype(&object, native_iterator_prototype_value()); object }).clone())) }\n");
    out.push_str("fn native_value_get_prototype(value: NativeValue) -> NativeValue { match value { NativeValue::Undefined | NativeValue::Null => runtime::throw_type_error(\"Cannot convert undefined or null to object\".into()), NativeValue::Object(object) | NativeValue::Record(_, object) => if let Some(prototype) = native_instance_prototype(&object) { prototype } else if object.with(|data| data.null_prototype) { NativeValue::Null } else { native_object_prototype_value() },\n");
    out.push_str("NativeValue::ArrayIterator(_) => native_array_iterator_prototype_value(),\n");
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Record { .. }) && specialized(ty, module) {
            writeln!(
                out,
                "NativeValue::V{index}(_) => native_object_prototype_value(),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => NativeValue::Undefined, } }\n");
    out.push_str(
        "fn native_value_sort_default(value: NativeValue) -> NativeValue { match value {\n",
    );
    out.push_str("NativeValue::Array(array) => { runtime::array_sort_by_snapshot(&array, |left, right| native_value_string(left.clone()).cmp(&native_value_string(right.clone()))); NativeValue::Array(array) },\n");
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Array { elem } if **elem == Type::String) {
            writeln!(out, "NativeValue::V{index}(array) => {{ runtime::array_sort_by_snapshot(&array, |left, right| left.cmp(right)); NativeValue::V{index}(array) }},").unwrap();
        } else if matches!(ty, Type::Array { elem } if **elem == Type::F64) {
            writeln!(out, "NativeValue::V{index}(array) => {{ runtime::array_sort_by_snapshot(&array, |left, right| js_string_number(*left).cmp(&js_string_number(*right))); NativeValue::V{index}(array) }},").unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"scriptc: default native array.sort requires a primitive array\".into()), } }\n");
    out.push_str("fn native_value_sort_with(value: NativeValue, comparator: NativeValue) -> NativeValue { match value {\n");
    out.push_str("NativeValue::Array(array) => { runtime::array_sort_by_snapshot(&array, |left, right| native_sort_compare(&comparator, left.clone(), right.clone())); NativeValue::Array(array) },\n");
    for (index, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let left = boxed(elem, "left.clone()", module);
            let right = boxed(elem, "right.clone()", module);
            writeln!(out, "NativeValue::V{index}(array) => {{ runtime::array_sort_by_snapshot(&array, |left, right| native_sort_compare(&comparator, {left}, {right})); NativeValue::V{index}(array) }},").unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"scriptc: array.sort receiver is not a native array\".into()), } }\n");
    out.push_str("fn native_sort_compare(comparator: &NativeValue, left: NativeValue, right: NativeValue) -> std::cmp::Ordering { let result = native_value_call(comparator.clone(), vec![left, right], \"Array.sort comparator\"); let number = native_compare_number(&result); if number < 0.0 { std::cmp::Ordering::Less } else if number > 0.0 { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal } }\n");
    out.push_str("fn native_value_collection_brand(value: &NativeValue, kind: &str) -> bool { match (kind,value) { (\"map\", NativeValue::Map(_)) => true,\n");
    for (index, ty) in types.iter().enumerate() {
        let kinds = match ty {
            Type::Bytes { elem } => vec!["bytes".to_string(), format!("bytes.{elem}")],
            Type::Map { .. } => vec!["map".to_string()],
            Type::Set { .. } => vec!["set".to_string()],
            _ => continue,
        };
        if specialized(ty, module) {
            for kind in kinds {
                writeln!(out, "({kind:?}, NativeValue::V{index}(_)) => true,").unwrap();
            }
        }
    }
    out.push_str("_ => false, } }\n");
    out.push_str(
        "fn native_array_from_typed(value: NativeValue) -> runtime::JsArray<f64> { match value {\n",
    );
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Bytes { .. }) && specialized(ty, module) {
            writeln!(
                out,
                "NativeValue::V{index}(bytes) => runtime::bytes_to_array(&bytes),"
            )
            .unwrap();
        }
    }
    out.push_str(
        "_ => runtime::throw_type_error(\"Array.from requires a typed array\".into()), } }\n",
    );
    out.push_str("fn native_value_is_array(value: &NativeValue) -> bool { match value { NativeValue::Array(_) => true,\n");
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Array { elem } if **elem != Type::Dyn)
            || matches!(ty, Type::Record { shape_id } if module.records[*shape_id].tuple && specialized(ty, module))
        {
            writeln!(out, "NativeValue::V{index}(..) => true,").unwrap();
        }
    }
    out.push_str("_ => false } }\n");
    out.push_str("fn native_value_is_typed_array(value: &NativeValue) -> bool { match value {\n");
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Bytes { .. }) && specialized(ty, module) {
            writeln!(out, "NativeValue::V{index}(..) => true,").unwrap();
        }
    }
    out.push_str("_ => false } }\n");
    out.push_str("fn native_value_is_u8_array(value: &NativeValue) -> bool { match value {\n");
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Bytes { elem } if elem == "u8") && specialized(ty, module) {
            writeln!(out, "NativeValue::V{index}(..) => true,").unwrap();
        }
    }
    out.push_str("_ => false } }\n");
    out.push_str("fn native_map_keys_immediate(value: NativeValue) -> runtime::JsArray<NativeValue> { match value { NativeValue::Map(map) => runtime::array_new(map.with(|map| map.entries.iter().map(|(key, _)| key.clone()).collect())),\n");
    for (index, ty) in types.iter().enumerate() {
        if let Type::Map { key, .. } = ty
            && specialized(ty, module)
        {
            let boxed_key = boxed(key, "key.clone()", module);
            writeln!(out, "NativeValue::V{index}(map) => runtime::array_new(map.storage.with(|map| map.entries.iter().map(|(key, _)| {boxed_key}).collect())),").unwrap();
        }
    }
    out.push_str("NativeValue::Undefined => runtime::throw_type_error(\"Cannot read properties of undefined (reading 'keys')\".into()), NativeValue::Null => runtime::throw_type_error(\"Cannot read properties of null (reading 'keys')\".into()), _ => runtime::throw_error_code(\"scriptc SC1031: immediate dynamic keys require a native Map\".into(), \"SC1031\") } }\n");
    out.push_str("fn native_array_iterator_first_result(value: NativeValue) -> NativeValue { let length = match native_value_get(value.clone(), runtime::string(\"length\")) { NativeValue::Number(length) => length, _ => unreachable!(\"native array length ABI\"), }; let (value, done) = if length > 0.0 { (native_value_get(value, runtime::string(\"0\")), false) } else { (NativeValue::Undefined, true) }; NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"value\"), value), (runtime::string(\"done\"), NativeValue::Boolean(done))], hash_index: NativeHashIndex::default() })) }\n");
    out.push_str("fn native_array_iterator_next_result(value: NativeValue) -> NativeValue { let (value, done) = match value { NativeValue::Array(array) => if runtime::array_len(&array) > 0.0 { (runtime::array_shift(&array), false) } else { (NativeValue::Undefined, true) },\n");
    for (index, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let value = boxed(elem, "runtime::array_shift(&array)", module);
            writeln!(out, "NativeValue::V{index}(array) => if runtime::array_len(&array) > 0.0 {{ ({value}, false) }} else {{ (NativeValue::Undefined, true) }},").unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"Map iterator storage is not a native array\".into()), }; NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"value\"), value), (runtime::string(\"done\"), NativeValue::Boolean(done))], hash_index: NativeHashIndex::default() })) }\n");
    out.push_str("fn native_value_is_buffer(value: &NativeValue) -> bool { match value {\n");
    for (index, ty) in types.iter().enumerate() {
        if *ty == Type::bytes() {
            writeln!(
                out,
                "NativeValue::V{index}(bytes) => runtime::bytes_is_buffer(bytes),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => false } }\n");
    out.push_str("fn native_builtin_instanceof(value: &NativeValue, constructor: &NativeValue) -> Option<bool> { Some(match constructor { NativeValue::AbortSignalConstructor => matches!(value, NativeValue::AbortSignal(_) | NativeValue::AbortControllerAbort(_)), NativeValue::WebConstructor(kind) => match kind { 0 => matches!(value, NativeValue::WebBytesStream(_)), 1 => matches!(value, NativeValue::Object(object) | NativeValue::Record(_, object) if object.with(|data| data.entries.iter().any(|(key, _)| key == \"__blobBytes\"))), 2 => matches!(value, NativeValue::SearchParams(_)), 3 => matches!(value, NativeValue::Object(object) | NativeValue::Record(_, object) if object.with(|data| data.entries.iter().any(|(key, _)| key == \"__fileBrand\"))), 4 => matches!(value, NativeValue::Url(_)), 5 => false, 6 => matches!(value, NativeValue::HttpResponse(_)), 7 => matches!(value, NativeValue::Headers(_)), 8 => false, _ => unreachable!(\"validated Web constructor brand\"), }, _ => return None, }) }\n");
    out.push_str("fn native_value_is_function(value: &NativeValue) -> bool { match value { NativeValue::Callable(_) | NativeValue::InstanceMethod(..) | NativeValue::InstanceSymbolMethod(_) | NativeValue::NullConstructor(_) | NativeValue::ObjectToString | NativeValue::FunctionCall | NativeValue::FunctionHasInstance | NativeValue::Fetch | NativeValue::AbortSignalConstructor | NativeValue::WebConstructor(_) | NativeValue::BlobMethod(_, _) | NativeValue::WritableMethod(_, _) | NativeValue::AbortSignalStatic(_) | NativeValue::AbortControllerAbort(_) | NativeValue::WeakRefMethod(_) | NativeValue::FinalizationRegistryMethod(_, _) | NativeValue::Bound(_) | NativeValue::BindIntrinsic | NativeValue::SyncGeneratorMethod(_) | NativeValue::MapValuesNext | NativeValue::ArrayIteratorNext | NativeValue::IteratorIdentity | NativeValue::ArrayIteratorFactory | NativeValue::ArraySpliceMethod | NativeValue::ArrayMapMethod | NativeValue::ArrayJoinMethod | NativeValue::ArrayMutationMethod(_) | NativeValue::ArrayPredicateMethod(_) | NativeValue::ArrayDynMethod(_) | NativeValue::ArrayIndexOfMethod | NativeValue::StringMethod(_) | NativeValue::TimerMethod(_) | NativeValue::SearchParamsMethod(_) | NativeValue::ChildMethod(_) | NativeValue::ChildStreamMethod(_, _) | NativeValue::FileWriteStreamMethod(_, _) | NativeValue::ProcessWrite(_) | NativeValue::ProcessStdinMethod(_) | NativeValue::ReadlineMethod(_, _) | NativeValue::DiagnosticsChannelMethod(_, _) | NativeValue::DebugLog(_, _) | NativeValue::HttpIncomingMessageConstructor | NativeValue::NetSocketMethod(_, _) | NativeValue::NetServerMethod(_, _) | NativeValue::HttpServerResponseMethod(_, _) | NativeValue::EmitterMethod(_, _) | NativeValue::FileHandleMethod(_, _) | NativeValue::RegexConstructor | NativeValue::LegacyUnescape | NativeValue::PromiseConstructor | NativeValue::PromiseStaticMethod(_) | NativeValue::PromiseResolve(_) | NativeValue::PromiseReject(_) | NativeValue::Promisified(_) | NativeValue::PromisifyCallback(_) => true,\n");
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Classval { .. }) {
            writeln!(out, "NativeValue::V{index}(..) => true,").unwrap();
        }
    }
    out.push_str("_ => false } }\nfn native_value_apply_arguments(value: &NativeValue) -> Vec<NativeValue> { let array = native_array_to_dynamic(value).unwrap_or_else(|| runtime::throw_type_error(\"scriptc: apply requires a native array argument list\".into())); (0..runtime::array_len(&array) as usize).map(|i| runtime::array_get(&array, i as f64)).collect() }\n");
    out.push_str("fn native_array_push_apply(target: NativeValue, source: NativeValue) -> f64 { let values = native_value_apply_arguments(&source); match target { NativeValue::Array(array) => { for value in values { runtime::array_push(&array, value); } runtime::array_len(&array) },\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let value = checked(elem, "value", module);
            writeln!(out, "NativeValue::V{i}(array) => {{ for value in values {{ runtime::array_push(&array, {value}); }} runtime::array_len(&array) }},").unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"Array.prototype.push.apply target must be an array\".into()), } }\n");
    out.push_str("fn native_array_mutation_property(value: &NativeValue, key: &runtime::JsString) -> Option<NativeValue> { let unshift = key == \"unshift\"; match value { NativeValue::Array(array) => Some(runtime::array_property_get(array, key).unwrap_or(NativeValue::ArrayMutationMethod(unshift))),\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let item = boxed(elem, "value", module);
            writeln!(out, "NativeValue::V{i}(array) => Some(runtime::array_property_get(array, key).map(|value| {item}).unwrap_or(NativeValue::ArrayMutationMethod(unshift))),").unwrap();
        }
    }
    out.push_str("_ => None } }\nfn native_array_mutation_call(receiver: NativeValue, args: Vec<NativeValue>, unshift: bool) -> NativeValue { match receiver { NativeValue::Array(array) => { let length = if unshift { runtime::array_unshift(&array, args) } else { for value in args { runtime::array_push(&array, value); } runtime::array_len(&array) }; NativeValue::Number(length) },\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let item = checked(elem, "&value", module);
            writeln!(out, "NativeValue::V{i}(array) => {{ let values = args.into_iter().map(|value| {item}).collect::<Vec<_>>(); let length = if unshift {{ runtime::array_unshift(&array, values) }} else {{ for value in values {{ runtime::array_push(&array, value); }} runtime::array_len(&array) }}; NativeValue::Number(length) }},").unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"Array method called on an incompatible receiver\".into()), } }\n");
    out.push_str("fn native_array_map_property(value: &NativeValue) -> Option<NativeValue> { let key = runtime::string(\"map\"); match value { NativeValue::Array(array) => Some(runtime::array_property_get(array, &key).unwrap_or(NativeValue::ArrayMapMethod)),\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let item = boxed(elem, "value", module);
            writeln!(out, "NativeValue::V{i}(array) => Some(runtime::array_property_get(array, &key).map(|value| {item}).unwrap_or(NativeValue::ArrayMapMethod)),").unwrap();
        }
    }
    out.push_str("_ => None } }\nfn native_set_storage(value: &NativeValue) -> Option<runtime::Gc<NativeMap<NativeValue, bool>>> { match value {\n");
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Set { .. }) {
            writeln!(
                out,
                "NativeValue::V{index}(set) => Some(set.storage.clone()),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => None } }\n");
    out.push_str("fn native_array_join_property(value: &NativeValue) -> Option<NativeValue> { let key = runtime::string(\"join\"); match value { NativeValue::Array(array) => Some(runtime::array_property_get(array, &key).unwrap_or(NativeValue::ArrayJoinMethod)),\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let item = boxed(elem, "value", module);
            writeln!(out, "NativeValue::V{i}(array) => Some(runtime::array_property_get(array, &key).map(|value| {item}).unwrap_or(NativeValue::ArrayJoinMethod)),").unwrap();
        }
    }
    out.push_str("_ => None } }\n");
    out.push_str("fn native_array_own_property(value: &NativeValue, key: &runtime::JsString) -> Option<Option<NativeValue>> { match value { NativeValue::Array(array) => Some(if key == \"raw\" && runtime::array_is_template_frozen(array) { runtime::array_raw(array).map(NativeValue::Array) } else { runtime::array_property_get(array, key) }),\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let item = boxed(elem, "value", module);
            let raw = boxed(ty, "raw", module);
            writeln!(out, "NativeValue::V{i}(array) => Some(if key == \"raw\" && runtime::array_is_template_frozen(array) {{ runtime::array_raw(array).map(|raw| {raw}) }} else {{ runtime::array_property_get(array, key).map(|value| {item}) }}),").unwrap();
        }
    }
    out.push_str("_ => None } }\n");
    let array_descriptor = |element: &str, raw: &str| {
        format!(
            "runtime::array_own_descriptor(array, key).map(|descriptor| {{ let value = match descriptor.value {{ runtime::ArrayOwnValue::Element(item) => {element}, runtime::ArrayOwnValue::Undefined => NativeValue::Undefined, runtime::ArrayOwnValue::Length(length) => NativeValue::Number(length), runtime::ArrayOwnValue::Raw(raw) => {raw}, }}; runtime::OrdinaryProperty::Data(runtime::DataProperty {{ value, writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable }}) }})"
        )
    };
    writeln!(out, "fn native_array_own_descriptor(value: &NativeValue, key: &runtime::JsString) -> Option<runtime::OrdinaryProperty<NativeValue>> {{ match value {{ NativeValue::Array(array) => {},", array_descriptor("item", "NativeValue::Array(raw)")).unwrap();
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let element = boxed(elem, "item", module);
            let raw = boxed(ty, "raw", module);
            writeln!(
                out,
                "NativeValue::V{i}(array) => {},",
                array_descriptor(&element, &raw)
            )
            .unwrap();
        }
    }
    out.push_str("_ => None } }\n");
    out.push_str("fn native_array_is_template_frozen(value: &NativeValue) -> bool { match value { NativeValue::Array(array) => runtime::array_is_template_frozen(array),\n");
    for (i, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Array { elem } if **elem != Type::Dyn) {
            writeln!(
                out,
                "NativeValue::V{i}(array) => runtime::array_is_template_frozen(array),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => false } }\n");
    out.push_str("fn native_array_to_string(receiver: NativeValue) -> NativeValue { let own = native_array_own_property(&receiver, &runtime::string(\"toString\")).expect(\"validated array receiver\"); if let Some(method) = own { return native_value_call_with_this(method, receiver, vec![], \"toString\"); } let join = native_array_join_property(&receiver).expect(\"validated array receiver\"); if native_value_is_function(&join) { native_value_call_with_this(join, receiver, vec![], \"join\") } else { native_object_to_string(receiver) } }\n");
    out.push_str("fn native_array_map_length(value: &NativeValue) -> f64 { match value { NativeValue::Array(array) => runtime::array_len(array),\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            writeln!(
                out,
                "NativeValue::V{i}(array) => runtime::array_len(array),"
            )
            .unwrap();
        } else if let Type::Record { shape_id } = ty
            && module.records[*shape_id].tuple
            && specialized(ty, module)
        {
            writeln!(
                out,
                "NativeValue::V{i}(..) => {}.0,",
                module.records[*shape_id].fields.len()
            )
            .unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"Array.prototype.map requires an array\".into()) } }\nfn native_array_map_slot(value: &NativeValue, index: f64) -> Option<NativeValue> { match value { NativeValue::Array(array) => match runtime::array_state(array, index) { 0.0 => None, 2.0 => Some(NativeValue::Undefined), _ => Some(runtime::array_get(array, index)) },\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let item = boxed(elem, "runtime::array_get(array, index)", module);
            writeln!(out, "NativeValue::V{i}(array) => match runtime::array_state(array, index) {{ 0.0 => None, 2.0 => Some(NativeValue::Undefined), _ => Some({item}) }},").unwrap();
        } else if let Type::Record { shape_id } = ty
            && module.records[*shape_id].tuple
            && specialized(ty, module)
        {
            writeln!(out, "NativeValue::V{i}(..) => Some(native_value_get(value.clone(), runtime::JsString::from((index as usize).to_string()))),").unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"Array.prototype.map requires an array\".into()) } }\nfn native_array_predicate(receiver: NativeValue, args: Vec<NativeValue>, every: bool) -> NativeValue { let name = if every { \"Array.prototype.every\" } else { \"Array.prototype.some\" }; let length = native_array_map_length(&receiver); let callback = args.first().cloned().unwrap_or(NativeValue::Undefined); if !native_value_is_function(&callback) { runtime::throw_type_error(format!(\"{name} callback is not a function\")); } let this_arg = args.get(1).cloned().unwrap_or(NativeValue::Undefined); for index in 0..length as usize { if let Some(value) = native_array_map_slot(&receiver, index as f64) { let result = native_value_call_with_this(callback.clone(), this_arg.clone(), vec![value, NativeValue::Number(index as f64), receiver.clone()], name); let truthy = native_value_test(&result, \"truthy\"); if every && !truthy { return NativeValue::Boolean(false); } if !every && truthy { return NativeValue::Boolean(true); } } } NativeValue::Boolean(every) }\nfn native_array_map(receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue { let length = native_array_map_length(&receiver); let callback = args.first().cloned().unwrap_or(NativeValue::Undefined); if !native_value_is_function(&callback) { runtime::throw_type_error(\"Array.prototype.map callback is not a function\".into()); } let this_arg = args.get(1).cloned().unwrap_or(NativeValue::Undefined); let result = runtime::array_new::<NativeValue>(Vec::new()); runtime::array_set_length(&result, length); for index in 0..length as usize { if let Some(value) = native_array_map_slot(&receiver, index as f64) { let mapped = native_value_call_with_this(callback.clone(), this_arg.clone(), vec![value, NativeValue::Number(index as f64), receiver.clone()], \"Array.prototype.map\"); if matches!(mapped, NativeValue::Undefined) { runtime::array_set_undefined(&result, index as f64); } else { runtime::array_set(&result, index as f64, mapped); } } } NativeValue::Array(result) }\n");
    out.push_str("fn native_array_join(receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue { let length = native_array_map_length(&receiver) as usize; let separator = match args.first() { None | Some(NativeValue::Undefined) => runtime::string(\",\"), Some(value) => native_value_string(value.clone()) }; let _guard = match native_join_guard(&receiver) { Ok(guard) => guard, Err(()) => return NativeValue::String(runtime::string(\"\")), }; let mut output = runtime::JsStringBuilder::new(); for index in 0..length { if index != 0 { output.push_str(&separator); } if let Some(value) = native_array_map_slot(&receiver, index as f64) { if !matches!(value, NativeValue::Undefined | NativeValue::Null) { output.push_str(&native_join_element_string(value)); } } } NativeValue::String(output.finish()) }\n");
    out.push_str(
        r#"
fn native_array_index_of(receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue {
    let NativeValue::Array(array) = receiver else {
        runtime::throw_type_error("Array.prototype.indexOf requires an array".into());
    };
    let length = runtime::array_len(&array);
    if length == 0.0 { return NativeValue::Number(-1.0); }
    let search = args.first().cloned().unwrap_or(NativeValue::Undefined);
    let from = args.get(1).map(native_compare_number).unwrap_or(0.0);
    let from = if from.is_nan() { 0.0 } else { from.trunc() };
    if from >= length { return NativeValue::Number(-1.0); }
    let first = if from < 0.0 { (length + from).max(0.0) } else { from };
    for index in first as usize..length as usize {
        let index = index as f64;
        let value = match runtime::array_state(&array, index) {
            0.0 => continue,
            2.0 => NativeValue::Undefined,
            _ => runtime::array_get(&array, index),
        };
        if native_value_eq(&value, &search) { return NativeValue::Number(index); }
    }
    NativeValue::Number(-1.0)
}
"#,
    );
    out.push_str(include_str!("string_split_support.rs"));
    out.push_str("#[derive(Clone)]\nenum NativeValue { SyncGeneratorMethod(u8), MapValuesIterator(runtime::Gc<NativeMapValuesIterator>), MapValuesNext, ArrayIteratorNext, IteratorIdentity, ObjectToString, FunctionCall, FunctionHasInstance, InstanceMethod(usize, usize), InstanceSymbolMethod(usize), InstanceSymbolGetter(usize), Callable(runtime::Gc<NativeCallable>), NullConstructor(runtime::Gc<NativeRecordData>), Record(usize, runtime::Gc<NativeRecordData>), Proxy(runtime::Gc<NativeProxy>), WeakRef(runtime::Gc<NativeMap<runtime::JsString, NativeValue>>), WeakRefMethod(runtime::Gc<NativeMap<runtime::JsString, NativeValue>>), FinalizationRegistry(runtime::Gc<NativeMap<runtime::JsString, NativeValue>>), FinalizationRegistryMethod(runtime::Gc<NativeMap<runtime::JsString, NativeValue>>, u8), Undefined, Null, Number(f64), BigInt(runtime::JsBigInt), Boolean(bool), String(runtime::JsString), RawJson(runtime::JsRawJson), Regex(runtime::JsRegex), RegexConstructor, LegacyUnescape, Date(runtime::JsDate), Url(runtime::JsUrl), Symbol(runtime::JsSymbol), ArrayBuffer(runtime::JsBytes<u8>), WebBytesStream(runtime::JsWebStream<runtime::JsBytes<u8>>), WebBytesReader(runtime::JsWebReader<runtime::JsBytes<u8>>), WebBytesController(runtime::JsWebStream<runtime::JsBytes<u8>>), TextDecoderStream(f64), WebTextStream(runtime::JsWebStream<runtime::JsString>), WebTextReader(runtime::JsWebReader<runtime::JsString>), HttpResponse(runtime::JsHttpRequest), Headers(runtime::JsHttpRequest), AbortSignal(runtime::JsAbortSignal<NativeValue>), AbortControllerAbort(runtime::JsAbortSignal<NativeValue>), AbortSignalConstructor, WebConstructor(u8), AbortSignalStatic(u8), Fetch, Promise(runtime::JsPromise<NativeValue>), PromiseResolve(runtime::JsPromise<NativeValue>), PromiseReject(runtime::JsPromise<NativeValue>), Promisified(Box<NativeValue>), PromisifyCallback(runtime::JsPromise<NativeValue>), PromiseConstructor, PromiseStaticMethod(u8), DiagnosticsChannel(f64), DiagnosticsChannelMethod(f64, u8), DebugLog(runtime::JsString, bool), Object(runtime::Gc<NativeMap<runtime::JsString, NativeValue>>), Map(runtime::Gc<NativeMap<NativeValue, NativeValue>>), Array(runtime::JsArray<NativeValue>), ArrayIterator(runtime::JsArrayIterator<NativeValue>), ArrayIteratorFactory, Bound(runtime::JsArray<NativeValue>), BindIntrinsic, ArraySpliceMethod, ArrayMapMethod, ArrayJoinMethod, ArrayMutationMethod(bool), ArrayPredicateMethod(bool), ArrayDynMethod(u8), ArrayIndexOfMethod, StringMethod(u8), TimerMethod(u8), MapConstructor, ProcessWrite(u8), ProcessStdinMethod(u8), Readline(f64), ReadlineMethod(f64, u8), NetSocketMethod(runtime::JsNetSocket, u8), NetServerMethod(runtime::JsNetServer, u8), HttpServerResponseMethod(runtime::JsHttpResponse, u8), EmitterMethod(Box<NativeValue>, u8), FileHandleMethod(runtime::JsFileHandle, u8),\n");
    out.push_str("HttpIncomingMessageConstructor, SearchParams(runtime::JsSearchParams), SearchParamsMethod(u8), ChildMethod(runtime::JsChild), ChildStreamMethod(runtime::JsChildStream, u8), FileWriteStreamMethod(runtime::JsChildWriter, u8),\n");
    out.push_str("BlobMethod(runtime::JsBytes<u8>, u8),\n");
    out.push_str("WritableMethod(Box<NativeValue>, u8),\n");
    if !module.classes.is_empty() {
        out.push_str("Instance(runtime::Gc<NativeInstance>),\n");
    }
    for (i, ty) in types
        .iter()
        .enumerate()
        .filter(|(_, t)| specialized(t, module))
    {
        writeln!(out, "V{i}({}),", rust_type(ty.clone(), module)).unwrap();
    }
    out.push_str("}\n");
    if !module.classes.is_empty() {
        out.push_str(
            "fn native_value_class(value: &NativeValue) -> Option<NativeClass> { match value {\n",
        );
        for (index, _) in types
            .iter()
            .enumerate()
            .filter(|(_, ty)| matches!(ty, Type::Classval { .. }))
        {
            writeln!(out, "NativeValue::V{index}(class) => Some(*class),").unwrap();
        }
        out.push_str("_ => None, } }\n");
    }
    let callables = types
        .iter()
        .enumerate()
        .filter(|(_, ty)| matches!(ty, Type::Func { .. }))
        .collect::<Vec<_>>();
    for (group, chunk) in callables.chunks(CALLABLE_DISPATCH_GROUP).enumerate() {
        writeln!(out, "#[derive(Clone)]\nenum NativeCallableTarget{group} {{").unwrap();
        for (i, ty) in chunk {
            writeln!(out, "V{i}({}),", rust_type((*ty).clone(), module)).unwrap();
        }
        writeln!(out, "}}\nimpl runtime::Trace for NativeCallableTarget{group} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ match self {{").unwrap();
        for (i, _) in chunk {
            writeln!(out, "Self::V{i}(value) => tracer.edge(value),").unwrap();
        }
        out.push_str("} } }\n");
    }
    out.push_str("#[derive(Clone)]\nenum NativeCallableTarget {\n");
    for group in 0..callables.len().div_ceil(CALLABLE_DISPATCH_GROUP) {
        writeln!(out, "G{group}(NativeCallableTarget{group}),").unwrap();
    }
    out.push_str("}\nimpl runtime::Trace for NativeCallableTarget { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { match self {\n");
    for group in 0..callables.len().div_ceil(CALLABLE_DISPATCH_GROUP) {
        writeln!(
            out,
            "Self::G{group}(target) => runtime::Trace::trace(target, tracer),"
        )
        .unwrap();
    }
    if callables.is_empty() {
        // An empty enum is uninhabited, but Rust conservatively treats a
        // reference to it as inhabited for exhaustiveness checking.
        out.push_str("_ => unreachable!(\"empty native callable target\"),\n");
    }
    out.push_str("} } }\nstruct NativeCallable { target: Option<NativeCallableTarget>, properties: Option<runtime::Gc<NativeRecordData>> }\nimpl runtime::Trace for NativeCallable { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { if let Some(target) = &self.target { runtime::Trace::trace(target, tracer); } if let Some(properties) = &self.properties { tracer.edge(properties); } } }\nimpl runtime::ClearEdges for NativeCallable { fn clear_edges(&mut self) { self.target = None; self.properties = None; } }\n");
    if let Some((index, _)) = types
        .iter()
        .enumerate()
        .find(|(_, ty)| **ty == Type::bytes())
    {
        writeln!(out, "fn native_box_web_bytes(value: runtime::JsBytes<u8>) -> NativeValue {{ NativeValue::V{index}(value) }}").unwrap();
    } else {
        out.push_str("fn native_box_web_bytes(value: runtime::JsBytes<u8>) -> NativeValue { NativeValue::ArrayBuffer(value) }\n");
    }
    out.push_str("fn native_web_read_result(value: Option<runtime::JsBytes<u8>>) -> NativeValue { let object = runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }); object.with_mut(|data| match value { Some(bytes) => { native_record_define(&mut data.entries, runtime::string(\"done\"), NativeValue::Boolean(false)); native_record_define(&mut data.entries, runtime::string(\"value\"), native_box_web_bytes(bytes)); }, None => { native_record_define(&mut data.entries, runtime::string(\"done\"), NativeValue::Boolean(true)); native_record_define(&mut data.entries, runtime::string(\"value\"), NativeValue::Undefined); } }); NativeValue::Object(object) }\nfn native_web_text_read_result(value: Option<runtime::JsString>) -> NativeValue { let object = runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }); object.with_mut(|data| match value { Some(text) => { native_record_define(&mut data.entries, runtime::string(\"done\"), NativeValue::Boolean(false)); native_record_define(&mut data.entries, runtime::string(\"value\"), NativeValue::String(text)); }, None => { native_record_define(&mut data.entries, runtime::string(\"done\"), NativeValue::Boolean(true)); native_record_define(&mut data.entries, runtime::string(\"value\"), NativeValue::Undefined); } }); NativeValue::Object(object) }\n");
    out.push_str(include_str!("stream_values_support.rs"));
    out.push_str(include_str!("crypto_sign_support.rs"));
    out.push_str("fn native_readline_create(_options: NativeValue) -> NativeValue { NativeValue::Readline(runtime::readline_create()) }\n");
    out.push_str(r#"
fn native_inspector_profile() -> NativeValue {
    let empty = || NativeValue::Array(runtime::array_new(Vec::new()));
    NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![
        (runtime::string("nodes"), empty()),
        (runtime::string("startTime"), NativeValue::Number(0.0)),
        (runtime::string("endTime"), NativeValue::Number(0.0)),
        (runtime::string("samples"), empty()),
        (runtime::string("timeDeltas"), empty()),
    ], hash_index: NativeHashIndex::default() }))
}
fn native_inspector_post(method: runtime::JsString, callback: NativeValue) {
    if native_value_is_function(&callback) {
        let result = if method == "Profiler.stop" {
            NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string("profile"), native_inspector_profile())], hash_index: NativeHashIndex::default() }))
        } else {
            NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }))
        };
        let _ = native_value_call(callback, vec![NativeValue::Null, result], "inspector.Session.post callback");
    }
}
fn native_inspector_session() -> NativeValue {
    NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }))
}
"#);
    let mut uses_sqlite = false;
    module.visit_expressions(&mut |value| {
        uses_sqlite |= matches!(value, Expr::LibCall { r#fn, .. } if r#fn.starts_with("sqlite."));
    });
    if uses_sqlite {
        out.push_str(include_str!("sqlite_values_support.rs"));
    }
    // A single erased bridge covers every typed array. Checked projections
    // can then share storage without generating a cross-product of array ABIs.
    out.push_str("fn native_array_to_dynamic(value: &NativeValue) -> Option<runtime::JsArray<NativeValue>> { match value { NativeValue::Array(array) => Some(array.clone()),\n");
    for (index, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            let read = format!(
                "native_array_preserve_record({})",
                boxed(elem, "value", module)
            );
            let write = checked(elem, "native_array_restore_record(value)", module);
            writeln!(out, "NativeValue::V{index}(array) => Some(runtime::array_mapped(array.clone(), |value| {read}, |value| {write})),").unwrap();
        } else if let Type::Record { shape_id } = ty
            && module.records[*shape_id].tuple
            && specialized(ty, module)
        {
            let record = &module.records[*shape_id];
            let values = record
                .declared_order
                .iter()
                .map(|name| {
                    let field = record
                        .fields
                        .iter()
                        .find(|field| &field.name == name)
                        .expect("tuple declaration order");
                    let stored = format!(
                        "tuple.with(|tuple| tuple.{}.as_ref().expect(\"scriptc: cleared tuple\").clone())",
                        field_name(name)
                    );
                    boxed(&field.r#type, &stored, module)
                })
                .collect::<Vec<_>>()
                .join(", ");
            writeln!(out, "NativeValue::V{index}(tuple) => Some(if let Some(source) = tuple.with(|tuple| tuple.source.clone()) {{ source }} else {{ let source = runtime::array_new::<NativeValue>(vec![{values}]); tuple.with_mut(|tuple| tuple.source = Some(source.clone())); source }}),").unwrap();
        }
    }
    out.push_str("_ => None } }\nfn native_array_identity(value: &NativeValue) -> Option<usize> { match value { NativeValue::Array(array) => Some(runtime::array_identity(array)),\n");
    for (index, ty) in types.iter().enumerate() {
        if let Type::Array { elem } = ty
            && **elem != Type::Dyn
        {
            writeln!(
                out,
                "NativeValue::V{index}(array) => Some(runtime::array_identity(array)),"
            )
            .unwrap();
        } else if let Type::Record { shape_id } = ty
            && module.records[*shape_id].tuple
            && specialized(ty, module)
        {
            writeln!(out, "NativeValue::V{index}(tuple) => Some(tuple.with(|tuple| tuple.source.as_ref().map(runtime::array_identity)).unwrap_or_else(|| tuple.identity())),").unwrap();
        }
    }
    out.push_str("_ => None } }\n");
    out.push_str(r#"
fn native_object_to_string(value: NativeValue) -> NativeValue {
    if let NativeValue::Record(_, object) | NativeValue::Object(object) = &value {
        let key = runtime::PropertyKey::Symbol(runtime::symbol_well_known(runtime::WellKnownSymbol::ToStringTag));
        let custom = object.with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&key)).map(|property| property.value.clone()));
        if let Some(NativeValue::String(tag)) = custom {
            return NativeValue::String(runtime::string_concat(&runtime::JsString::from("[object "), &runtime::string_concat(&tag, &runtime::JsString::from("]"))));
        }
    }
"#);
    if !module.classes.is_empty() {
        out.push_str(r#"
    if matches!(&value, NativeValue::Instance(_)) {
        let custom = native_value_symbol_get(value.clone(), runtime::symbol_well_known(runtime::WellKnownSymbol::ToStringTag));
        if let NativeValue::String(tag) = custom {
            return NativeValue::String(runtime::string_concat(&runtime::JsString::from("[object "), &runtime::string_concat(&tag, &runtime::JsString::from("]"))));
        }
    }
"#);
    }
    out.push_str(
        r#"
    let tag = match &value {
        NativeValue::Undefined => "Undefined",
        NativeValue::Null => "Null",
        NativeValue::Boolean(_) => "Boolean",
        NativeValue::Number(_) => "Number",
        NativeValue::BigInt(_) => "BigInt",
        NativeValue::String(_) => "String",
        NativeValue::Symbol(_) => "Symbol",
        NativeValue::Regex(_) => "RegExp",
        NativeValue::Date(_) => "Date",
        NativeValue::Promise(_) => "Promise",
        NativeValue::Map(_) => "Map",
        _ if native_value_is_function(&value) => "Function",
        _ if native_value_is_array(&value) => "Array",
        _ => "Object",
    };
    NativeValue::String(runtime::JsString::from(format!("[object {tag}]")))
}
"#,
    );
    out.push_str("struct NativeProxy { target: Option<NativeValue>, handler: Option<NativeValue> }\nimpl runtime::Trace for NativeProxy { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { if let Some(value) = &self.target { value.trace_native(tracer); } if let Some(value) = &self.handler { value.trace_native(tracer); } } }\nimpl runtime::ClearEdges for NativeProxy { fn clear_edges(&mut self) { self.target = None; self.handler = None; } }\n");
    async_generator_definitions(&types, module, out);
    out.push_str("impl NativeTrace for NativeValue { fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) { match self { Self::Callable(v) => v.trace_native(tracer), Self::Promisified(v) => v.trace_native(tracer), Self::Record(_,v) => v.trace_native(tracer), Self::Proxy(v) => v.trace_native(tracer), Self::ArrayBuffer(v) => v.trace_native(tracer), Self::WebBytesStream(v) | Self::WebBytesController(v) => v.trace_native(tracer), Self::WebBytesReader(v) => v.trace_native(tracer), Self::WebTextStream(v) => v.trace_native(tracer), Self::WebTextReader(v) => v.trace_native(tracer), Self::HttpResponse(v) | Self::Headers(v) => v.trace_native(tracer), Self::AbortSignal(v) | Self::AbortControllerAbort(v) => v.trace_native(tracer), Self::Promise(v) | Self::PromiseResolve(v) | Self::PromiseReject(v) | Self::PromisifyCallback(v) => v.trace_native(tracer), Self::ChildMethod(v) => v.trace_native(tracer), Self::ChildStreamMethod(v, _) => v.trace_native(tracer), Self::FileWriteStreamMethod(v, _) => v.trace_native(tracer), Self::NetSocketMethod(v, _) => v.trace_native(tracer), Self::NetServerMethod(v, _) => v.trace_native(tracer), Self::HttpServerResponseMethod(v, _) => v.trace_native(tracer), Self::EmitterMethod(v, _) => v.trace_native(tracer), Self::FileHandleMethod(v, _) => v.trace_native(tracer), Self::Object(v) | Self::NullConstructor(v) | Self::WeakRef(v) | Self::WeakRefMethod(v) | Self::FinalizationRegistry(v) | Self::FinalizationRegistryMethod(v, _) => v.trace_native(tracer), Self::Map(v) => v.trace_native(tracer), Self::Array(v) | Self::Bound(v) => v.trace_native(tracer), Self::ArrayIterator(v) => v.trace_native(tracer), Self::MapValuesIterator(v) => v.trace_native(tracer),\n");
    if !module.classes.is_empty() {
        out.push_str("Self::Instance(v) => v.trace_native(tracer),\n");
    }
    for (i, _) in types
        .iter()
        .enumerate()
        .filter(|(_, t)| specialized(t, module))
    {
        writeln!(out, "Self::V{i}(v) => v.trace_native(tracer),").unwrap();
    }
    out.push_str("Self::BlobMethod(v, _) => v.trace_native(tracer),\n");
    out.push_str("Self::WritableMethod(v, _) => v.trace_native(tracer),\n");
    out.push_str("_ => {} } } }\nimpl runtime::Trace for NativeValue { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { self.trace_native(tracer); } }\nimpl runtime::ArrayElement for NativeValue { fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { self.trace_native(tracer); } }\nfn native_weak_ref_new(value: NativeValue) -> NativeValue { if matches!(&value, NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_) | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::Symbol(_)) { runtime::throw_type_error(\"WeakRef target must be an object\".into()); } NativeValue::WeakRef(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"target\"), value)], hash_index: NativeHashIndex::default() })) }\nfn native_finalization_registry_new(callback: NativeValue) -> NativeValue { if !native_value_is_function(&callback) { runtime::throw_type_error(\"FinalizationRegistry cleanup callback must be callable\".into()); } NativeValue::FinalizationRegistry(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"callback\"), callback)], hash_index: NativeHashIndex::default() })) }\n");
    out.push_str(r#"
fn native_blob_new(parts: NativeValue, options: NativeValue) -> NativeValue {
    let values = match parts {
        NativeValue::Undefined => Vec::new(),
        NativeValue::Array(parts) => runtime::array_values(&parts),
        _ => runtime::throw_type_error("Blob constructor: parts must be iterable".into()),
    };
    let mut raw = Vec::new();
    for value in values {
        match value {
            NativeValue::ArrayBuffer(bytes) => runtime::bytes_with_read_slice(&bytes, |slice| raw.extend_from_slice(slice.unwrap_or(&[]))),
            NativeValue::String(text) => raw.extend_from_slice(text.to_utf8_lossy().as_bytes()),
            NativeValue::Object(object) if object.with(|data| data.entries.iter().any(|(key, _)| key == "__blobBytes")) => {
                let value = object.with(|data| data.entries.iter().find(|(key, _)| key == "__blobBytes").map(|(_, value)| value.clone()).unwrap());
                if let NativeValue::ArrayBuffer(bytes) = value {
                    runtime::bytes_with_read_slice(&bytes, |slice| raw.extend_from_slice(slice.unwrap_or(&[])));
                }
            }
            other => raw.extend_from_slice(native_value_string(other).to_utf8_lossy().as_bytes()),
        }
    }
    let bytes = runtime::ffi_bytes_copy_in(&raw);
    let type_ = if matches!(options, NativeValue::Undefined | NativeValue::Null) {
        runtime::JsString::default()
    } else {
        match native_value_get(options, runtime::string("type")) {
            NativeValue::Undefined => runtime::JsString::default(),
            value => runtime::string(&native_value_string(value).to_utf8_lossy().to_ascii_lowercase()),
        }
    };
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("__blobBytes"), NativeValue::ArrayBuffer(bytes.clone())),
            (runtime::string("size"), NativeValue::Number(raw.len() as f64)),
            (runtime::string("type"), NativeValue::String(type_)),
            (runtime::string("arrayBuffer"), NativeValue::BlobMethod(bytes.clone(), 0)),
            (runtime::string("text"), NativeValue::BlobMethod(bytes, 1)),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}
fn native_file_new(parts: NativeValue, name: NativeValue, options: NativeValue) -> NativeValue {
    let value = native_blob_new(parts, options.clone());
    let NativeValue::Object(object) = &value else { unreachable!("Blob constructor returns an object") };
    let name = native_value_string(name);
    let last_modified = if matches!(options, NativeValue::Undefined | NativeValue::Null) {
        runtime::date_now()
    } else {
        let value = native_value_get(options, runtime::string("lastModified"));
        if matches!(value, NativeValue::Undefined) { runtime::date_now() } else { native_compare_number(&value) }
    };
    object.with_mut(|data| {
        data.entries.push((runtime::string("__fileBrand"), NativeValue::Boolean(true)));
        data.entries.push((runtime::string("name"), NativeValue::String(name)));
        data.entries.push((runtime::string("lastModified"), NativeValue::Number(last_modified)));
    });
    value
}
fn native_blob_method(bytes: runtime::JsBytes<u8>, method: u8) -> NativeValue {
    let promise = runtime::promise_new();
    let value = if method == 0 {
        NativeValue::ArrayBuffer(runtime::bytes_copy(&bytes))
    } else {
        let text = runtime::bytes_with_read_slice(&bytes, |slice| String::from_utf8_lossy(slice.unwrap_or(&[])).into_owned());
        NativeValue::String(runtime::string(&text))
    };
    let _ = runtime::promise_fulfill(&promise, value);
    NativeValue::Promise(promise)
}
fn native_writable_promise(value: NativeValue) -> NativeValue {
    match value {
        NativeValue::Promise(source) => NativeValue::Promise(runtime::promise_view_map(&source, |_| NativeValue::Undefined)),
        _ => {
            let promise = runtime::promise_new();
            let _ = runtime::promise_fulfill(&promise, NativeValue::Undefined);
            NativeValue::Promise(promise)
        }
    }
}
fn native_writable_invoke(source: NativeValue, method: &str, arguments: Vec<NativeValue>) -> NativeValue {
    if matches!(source, NativeValue::Undefined | NativeValue::Null) {
        return native_writable_promise(NativeValue::Undefined);
    }
    let callback = native_value_get(source.clone(), runtime::string(method));
    if matches!(callback, NativeValue::Undefined) {
        return native_writable_promise(NativeValue::Undefined);
    }
    if !native_value_is_function(&callback) {
        runtime::throw_type_error(format!("WritableStream {method} must be callable"));
    }
    native_writable_promise(native_value_call_with_this(
        callback,
        source,
        arguments,
        "WritableStream sink callback",
    ))
}
fn native_writable_writer(source: NativeValue) -> NativeValue {
    let ready = native_writable_promise(NativeValue::Undefined);
    let closed = native_writable_promise(NativeValue::Undefined);
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("write"), NativeValue::WritableMethod(Box::new(source.clone()), 1)),
            (runtime::string("close"), NativeValue::WritableMethod(Box::new(source.clone()), 2)),
            (runtime::string("abort"), NativeValue::WritableMethod(Box::new(source), 3)),
            (runtime::string("ready"), ready),
            (runtime::string("closed"), closed),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}
fn native_writable_stream_new(source: NativeValue) -> NativeValue {
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("getWriter"), NativeValue::WritableMethod(Box::new(source.clone()), 0)),
            (runtime::string("close"), NativeValue::WritableMethod(Box::new(source.clone()), 2)),
            (runtime::string("abort"), NativeValue::WritableMethod(Box::new(source), 3)),
            (runtime::string("locked"), NativeValue::Boolean(false)),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}
fn native_writable_method(source: NativeValue, method: u8, arguments: Vec<NativeValue>) -> NativeValue {
    match method {
        0 => {
            if !arguments.is_empty() { runtime::throw_type_error("WritableStream.getWriter accepts no arguments".into()); }
            native_writable_writer(source)
        }
        1 => native_writable_invoke(source, "write", vec![arguments.first().cloned().unwrap_or(NativeValue::Undefined)]),
        2 => native_writable_invoke(source, "close", vec![]),
        3 => native_writable_invoke(source, "abort", vec![arguments.first().cloned().unwrap_or(NativeValue::Undefined)]),
        _ => unreachable!("validated WritableStream method"),
    }
}
"#);
    out.push_str(r#"
fn native_proxy_new(target: NativeValue, handler: NativeValue) -> NativeValue {
    for value in [&target, &handler] {
        if !matches!(value, NativeValue::Object(_) | NativeValue::Record(..) | NativeValue::Proxy(_)) {
            runtime::throw_type_error("Cannot create proxy with a non-object as target or handler".into());
        }
    }
    NativeValue::Proxy(runtime::Gc::new(NativeProxy { target: Some(target), handler: Some(handler) }))
}
fn native_proxy_get(proxy: &runtime::Gc<NativeProxy>, key: NativeValue, receiver: NativeValue) -> NativeValue {
    let (target, handler) = proxy.with(|proxy| (
        proxy.target.as_ref().expect("scriptc: cleared Proxy target").clone(),
        proxy.handler.as_ref().expect("scriptc: cleared Proxy handler").clone(),
    ));
    let trap = native_value_get(handler.clone(), runtime::string("get"));
    if matches!(trap, NativeValue::Undefined | NativeValue::Null) {
        return match key {
            NativeValue::String(key) => native_value_get(target, key),
            NativeValue::Symbol(key) => native_value_symbol_get(target, key),
            other => native_value_get(target, native_value_string(other)),
        };
    }
    if !native_value_is_function(&trap) {
        runtime::throw_type_error("'get' property of a Proxy handler is not callable".into());
    }
    native_value_call_with_this(trap, handler, vec![target, key, receiver], "Proxy get trap")
}
fn native_proxy_set(proxy: &runtime::Gc<NativeProxy>, key: NativeValue, field: NativeValue, receiver: NativeValue) -> bool {
    let (target, handler) = proxy.with(|proxy| (
        proxy.target.as_ref().expect("scriptc: cleared Proxy target").clone(),
        proxy.handler.as_ref().expect("scriptc: cleared Proxy handler").clone(),
    ));
    let trap = native_value_get(handler.clone(), runtime::string("set"));
    if matches!(trap, NativeValue::Undefined | NativeValue::Null) {
        return native_reflect_set(target, key, field, receiver);
    }
    if !native_value_is_function(&trap) {
        runtime::throw_type_error("'set' property of a Proxy handler is not callable".into());
    }
    let result = native_value_call_with_this(
        trap,
        handler,
        vec![target, key, field, receiver],
        "Proxy set trap",
    );
    native_value_test(&result, "truthy")
}
fn native_reflect_get(target: NativeValue, key: NativeValue, receiver: NativeValue) -> NativeValue {
    if let NativeValue::Proxy(proxy) = &target {
        return native_proxy_get(proxy, key, receiver);
    }
    match key {
        NativeValue::Symbol(key) => native_value_symbol_get(target, key),
        key => {
            let key = native_value_string(key);
            native_getter_read_with_receiver(&target, &key, receiver)
                .unwrap_or_else(|| native_value_get(target, key))
        }
    }
}
// OrdinarySet asks a Proxy receiver for its own descriptor and then defines
// the data property. It must not call the receiver's `set` trap recursively.
fn native_reflect_proxy_receiver(mut receiver: NativeValue) -> (NativeValue, Vec<NativeValue>) {
    let mut handlers = Vec::new();
    while let NativeValue::Proxy(proxy) = &receiver {
        let (target, handler) = proxy.with(|proxy| (
            proxy.target.as_ref().expect("scriptc: cleared Proxy target").clone(),
            proxy.handler.as_ref().expect("scriptc: cleared Proxy handler").clone(),
        ));
        let trap = native_value_get(handler.clone(), runtime::string("getOwnPropertyDescriptor"));
        if !matches!(trap, NativeValue::Undefined | NativeValue::Null) {
            if !native_value_is_function(&trap) {
                runtime::throw_type_error("Proxy getOwnPropertyDescriptor trap is not callable".into());
            }
            runtime::throw_error_code("scriptc SC1031: Proxy receiver descriptor trap is not ported".into(), "SC1031");
        }
        handlers.push(handler);
        receiver = target;
    }
    (receiver, handlers)
}
fn native_reflect_proxy_definition(handlers: Vec<NativeValue>) {
    for handler in handlers {
        let trap = native_value_get(handler, runtime::string("defineProperty"));
        if !matches!(trap, NativeValue::Undefined | NativeValue::Null) {
            if !native_value_is_function(&trap) {
                runtime::throw_type_error("Proxy defineProperty trap is not callable".into());
            }
            runtime::throw_error_code("scriptc SC1031: Proxy receiver defineProperty trap is not ported".into(), "SC1031");
        }
    }
}
fn native_reflect_set(
    target: NativeValue,
    key: NativeValue,
    field: NativeValue,
    receiver: NativeValue,
) -> bool {
    if let NativeValue::Proxy(proxy) = &target {
        return native_proxy_set(proxy, key, field, receiver);
    }
    if matches!(&target, NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_)
        | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::Symbol(_)) {
        runtime::throw_type_error("Reflect.set called on non-object".into());
    }
    match key {
        NativeValue::Symbol(key) => {
            if native_value_own_symbol_property(&target, &key).is_some_and(|property| !property.writable) {
                return false;
            }
            if matches!(&receiver, NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_)
                | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::Symbol(_)) {
                return false;
            }
            let (receiver, handlers) = native_reflect_proxy_receiver(receiver);
            if native_value_own_symbol_property(&receiver, &key).is_some_and(|property| !property.writable) {
                return false;
            }
            if native_object_frozen(&receiver) { return false; }
            native_reflect_proxy_definition(handlers);
            if native_array_is_template_frozen(&receiver) { return false; }
            native_value_symbol_set(receiver, key, field);
        }
        key => {
            let key = native_value_string(key);
            let target_property = native_getter_lookup(&target, &key)
                .or_else(|| native_array_own_descriptor(&target, &key));
            match target_property {
                Some(runtime::OrdinaryProperty::Accessor(property)) => {
                    if matches!(property.set, NativeValue::Undefined) { return false; }
                    native_value_call_with_this(property.set, receiver, vec![field], "setter");
                    return true;
                }
                Some(runtime::OrdinaryProperty::Data(property)) if !property.writable => return false,
                _ => {}
            }
            if matches!(&receiver, NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_)
                | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::Symbol(_)) {
                return false;
            }
            let (receiver, handlers) = native_reflect_proxy_receiver(receiver);
            let receiver_property = native_getter_lookup(&receiver, &key)
                .or_else(|| native_array_own_descriptor(&receiver, &key));
            match receiver_property {
                Some(runtime::OrdinaryProperty::Accessor(_)) => return false,
                Some(runtime::OrdinaryProperty::Data(property)) if !property.writable => return false,
                _ => {}
            }
            if native_object_frozen(&receiver) { return false; }
            native_reflect_proxy_definition(handlers);
            if native_array_is_template_frozen(&receiver) { return false; }
            native_value_set(receiver, key, field);
        }
    }
    true
}
"#);
    let record_tags = module
        .records
        .iter()
        .map(|record| module.record_tag(record.id))
        .collect::<Vec<_>>();
    let data_view_tags = module
        .records
        .iter()
        .filter(|record| {
            record.fields.len() == 1
                && record.fields[0].name == "\0scriptc.dataview.storage"
                && record.fields[0].r#type == Type::bytes()
        })
        .map(|record| module.record_tag(record.id).to_string())
        .collect::<Vec<_>>();
    if data_view_tags.is_empty() {
        out.push_str("fn native_value_is_data_view(_value: &NativeValue) -> bool { false }\n");
    } else {
        writeln!(
            out,
            "fn native_value_is_data_view(value: &NativeValue) -> bool {{ matches!(value, NativeValue::Record(tag, _) if matches!(*tag, {})) }}",
            data_view_tags.join(" | ")
        )
        .unwrap();
    }
    // Values from dynamically loaded modules may enter an array literal
    // without their concrete record type appearing in another array ABI.
    let array_record_sources = module
        .records
        .iter()
        .enumerate()
        .filter_map(|(id, record)| record_storage::shared(record, module).then_some(id))
        .collect::<Vec<_>>();
    let mut checked_unions = std::collections::HashSet::new();
    module.visit_expressions(&mut |expr| {
        if let Expr::DynCheck {
            r#type: Type::Union { union_id },
            ..
        } = expr
        {
            checked_unions.insert(*union_id);
        }
    });
    // Record fields are read from the shared NativeValue property store.
    // Their declared union check must therefore know every compatible record
    // tag, including a required source record viewed as `Target | undefined`.
    // Limiting this table to field ABIs avoids generating the record x union
    // cross-product for unrelated local unions in large modules.
    for record in &module.records {
        for field in &record.fields {
            if let Type::Union { union_id } = field.r#type {
                checked_unions.insert(union_id);
            }
        }
        if let Some(Type::Union { union_id }) = record.index_value.as_ref() {
            checked_unions.insert(*union_id);
        }
    }
    out.push_str("#[cold] fn native_check_failed(value: &NativeValue, id: usize, expected: &str, location: &std::panic::Location<'_>) -> ! { if std::env::var_os(\"SCRIPTC_TRACE_TYPES\").is_some() { eprintln!(\"scriptc: native check {} expected {} got {:?} at {}\", id, expected, std::mem::discriminant(value), location); } runtime::throw_type_error(\"scriptc: native value does not match the required type\".into()) }\n");
    out.push_str("fn native_box_shared_record(value: runtime::Gc<NativeRecordData>, tag: usize) -> NativeValue { native_callable_view(&value).map(|view| view.function).unwrap_or_else(|| NativeValue::Record(tag, value)) }\n");
    out.push_str("fn native_try_shared_record(value: &NativeValue, tag: usize) -> Option<runtime::Gc<NativeRecordData>> { if let NativeValue::Record(_, value) = value { Some(value.clone()) } else { native_callable_cast(value, tag) } }\n");
    out.push_str("#[track_caller] fn native_check_shared_record(value: &NativeValue, tag: usize) -> runtime::Gc<NativeRecordData> { if let NativeValue::NullConstructor(object) = value { return native_callable_attach(object.clone(), value.clone(), tag); } if let NativeValue::Object(object) = value { return object.clone(); } let location = std::panic::Location::caller(); native_try_shared_record(value, tag).unwrap_or_else(|| native_check_failed(value, tag, \"shared record\", location)) }\n");
    out.push_str("fn native_promise_property(promise: &runtime::JsPromise<NativeValue>, key: &runtime::JsString) -> NativeValue {\n");
    if types.contains(&Type::Child) {
        writeln!(out, "if key == \"child\" {{ return runtime::promise_own_get::<_, runtime::JsChild>(promise, \"child\").map(|value| {}).unwrap_or(NativeValue::Undefined); }}", boxed(&Type::Child, "value", module)).unwrap();
    }
    out.push_str("native_value_missing_kind(key, \"promise\") }\n");
    for (i, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Record { shape_id } if record_storage::shared(&module.records[*shape_id], module))
        {
            continue;
        }
        let generator_view =
            if let Some((definitions, check)) = dynamic_generator_adapter(i, ty, module) {
                out.push_str(&definitions);
                check
            } else {
                String::new()
            };
        let rt = rust_type(ty.clone(), module);
        let (box_code, try_code) = match ty {
            Type::Record { shape_id } if module.records[*shape_id].tuple => (
                format!(
                    "value.with(|tuple| tuple.source.clone()).map(NativeValue::Array).unwrap_or_else(|| NativeValue::V{i}(value))"
                ),
                format!(
                    "if let NativeValue::V{i}(v) = value {{ Some(v.clone()) }} else {{ None }}"
                ),
            ),
            Type::Record { shape_id }
                if record_storage::shared(&module.records[*shape_id], module) =>
            {
                (
                    format!(
                        "native_callable_view(&value).map(|view| view.function).unwrap_or_else(|| NativeValue::Record({}, value))",
                        record_tags[*shape_id]
                    ),
                    format!(
                        "if let NativeValue::Record(_, value) = value {{ Some(value.clone()) }} else {{ native_callable_cast(value, {}) }}",
                        record_tags[*shape_id]
                    ),
                )
            }
            Type::Promise { .. } => (
                "NativeValue::Promise(value)".into(),
                "if let NativeValue::Promise(v) = value { Some(v.clone()) } else { None }".into(),
            ),
            Type::Dyn | Type::Caught => ("value".into(), "Some(value.clone())".into()),
            Type::Undefined => (
                "{ let _ = value; NativeValue::Undefined }".into(),
                "if matches!(value, NativeValue::Undefined) { Some(()) } else { None }".into(),
            ),
            Type::Null => (
                "{ let _ = value; NativeValue::Null }".into(),
                "if matches!(value, NativeValue::Null) { Some(()) } else { None }".into(),
            ),
            Type::F64 | Type::Bigint | Type::Bool | Type::String | Type::Regex | Type::Symbol => {
                let variant = match ty {
                    Type::F64 => "Number",
                    Type::Bigint => "BigInt",
                    Type::Bool => "Boolean",
                    Type::String => "String",
                    Type::Regex => "Regex",
                    _ => "Symbol",
                };
                (
                    format!("NativeValue::{variant}(value)"),
                    format!(
                        "if let NativeValue::{variant}(v) = value {{ Some(v.clone()) }} else {{ None }}"
                    ),
                )
            }
            Type::Array { elem } if **elem == Type::Dyn => (
                "NativeValue::Array(value)".into(),
                "if let NativeValue::Array(v) = value { Some(v.clone()) } else { None }".into(),
            ),
            Type::Array { elem } => (
                // A typed view may be backed by a dynamic array containing
                // values that the view cannot represent (for example an
                // asserted-away undefined). Erasing that view must recover
                // its owner before any element conversion is attempted.
                format!(
                    "runtime::array_mapped_source::<NativeValue, {}>(&value).map(NativeValue::Array).unwrap_or_else(|| NativeValue::V{i}(value))",
                    rust_type((**elem).clone(), module)
                ),
                format!(
                    "if let NativeValue::V{i}(v) = value {{ Some(v.clone()) }} else {{ None }}"
                ),
            ),
            Type::Map { key, value } if **key == Type::Dyn && **value == Type::Dyn => (
                "NativeValue::Map(value)".into(),
                "if let NativeValue::Map(v) = value { Some(v.clone()) } else { None }".into(),
            ),
            Type::Classval { class_name } => {
                let class = module
                    .classes
                    .iter()
                    .position(|candidate| candidate.name == *class_name)
                    .unwrap();
                (
                    format!("NativeValue::V{i}(value)"),
                    format!(
                        "native_value_class(value).filter(|value| native_class_layout(*value) == {class})"
                    ),
                )
            }
            Type::Object { class_name } => {
                let ci = module
                    .classes
                    .iter()
                    .position(|c| c.name == *class_name)
                    .unwrap();
                // An erased owner keeps its WeakMap/WeakSet state native. Reading
                // that state through a dynamic value would need a property
                // descriptor contract the collection does not have: refuse it
                // explicitly at the read instead of exposing a partial object.
                let opaque = match class_name.as_str() {
                    "native_builtin_WeakSet" => Some("WeakSet"),
                    _ => None,
                };
                (
                    if let Some(kind) = opaque {
                        format!("{{ let _ = value; runtime::throw_type_error(\"scriptc: erasing {kind} requires a native property descriptor contract\".into()) }}")
                    } else {
                        "NativeValue::Instance(value)".into()
                    },
                    format!(
                        "if let NativeValue::Instance(v) = value {{ if instance_is_{ci}(v.clone()) {{ Some(v.clone()) }} else {{ None }} }} else {{ None }}"
                    ),
                )
            }
            Type::Func { .. } => {
                let name = functions::type_name(ty, module);
                let group = types[..i]
                    .iter()
                    .filter(|candidate| matches!(candidate, Type::Func { .. }))
                    .count()
                    / CALLABLE_DISPATCH_GROUP;
                (
                    format!(
                        "{{ let properties = properties_{name}(&value); NativeValue::Callable(runtime::Gc::new(NativeCallable {{ target: Some(NativeCallableTarget::G{group}(NativeCallableTarget{group}::V{i}(value))), properties: Some(properties) }})) }}"
                    ),
                    format!(
                        "if let NativeValue::Callable(callable) = value {{ callable.with(|callable| match callable.target.as_ref()? {{ NativeCallableTarget::G{group}(NativeCallableTarget{group}::V{i}(function)) => Some(function.clone()), _ => None }}) }} else {{ None }}"
                    ),
                )
            }
            Type::Union { union_id } => {
                let arms = &module.unions[*union_id].arms;
                let b = arms
                    .iter()
                    .enumerate()
                    .map(|(tag, t)| format!("U{union_id}::V{tag}(v) => {},", boxed(t, "v", module)))
                    .collect::<String>();
                let mut c = arms.iter().enumerate().map(|(tag,t)| match t {
                    Type::Record { shape_id } if record_storage::shared(&module.records[*shape_id], module) => format!("if let NativeValue::Record(actual, object) = value {{ if *actual == {} {{ return Some(U{union_id}::V{tag}(object.clone())); }} }}", record_tags[*shape_id]),
                    _ => format!("if let Some(v) = native_try_{}(value) {{ return Some(U{union_id}::V{tag}(v)); }}", id(t,module)),
                }).collect::<String>();
                if checked_unions.contains(union_id)
                    || types
                        .iter()
                        .any(|array| matches!(array, Type::Array { elem } if elem.as_ref() == ty))
                {
                    let mut mappings = std::collections::BTreeMap::new();
                    for shape_id in &array_record_sources {
                        let source = Type::Record {
                            shape_id: *shape_id,
                        };
                        if let Some(pairs) = if checked_unions.contains(union_id) {
                            crate::ir::record_views::dynamic_view_pairs(
                                &source,
                                ty,
                                &module.records,
                                &module.unions,
                            )
                        } else {
                            crate::ir::record_views::view_pairs(
                                &source,
                                ty,
                                &module.records,
                                &module.unions,
                            )
                        } && let Some((_, target)) = pairs.first()
                        {
                            mappings.entry(record_tags[*shape_id]).or_insert(*target);
                        }
                    }
                    if !mappings.is_empty() {
                        // Group source tags with the same destination arm. The
                        // checked identity-preserving conversion is unchanged,
                        // but its Rust expression is emitted only once per arm.
                        let mut targets = std::collections::BTreeMap::<usize, Vec<String>>::new();
                        for (source, target) in mappings {
                            targets.entry(target).or_default().push(source.to_string());
                        }
                        let cases = targets
                            .into_iter()
                            .map(|(target, sources)| {
                                format!(
                                    "{} => return Some(U{union_id}::V{target}(object.clone())),",
                                    sources.join(" | ")
                                )
                            })
                            .collect::<String>();
                        c.push_str(&format!("if let NativeValue::Record(tag, object) = value {{ match *tag {{ {cases} _ => (), }} }}"));
                    }
                }
                // A single index-only dynamic record alongside unit arms has
                // an unambiguous owning view of any represented plain object.
                // Preserve exact record tags for every other union so an
                // untagged object cannot select an arbitrary structural arm.
                let record = arms.iter().enumerate().find_map(|(tag, arm)| {
                    let Type::Record { shape_id } = arm else {
                        return None;
                    };
                    let shape = &module.records[*shape_id];
                    (shape.fields.is_empty()
                        && shape.index_value == Some(Type::Dyn)
                        && record_storage::shared(shape, module)
                        && arms.iter().enumerate().all(|(i, other)| {
                            i == tag || matches!(other, Type::Null | Type::Undefined)
                        }))
                    .then_some(tag)
                });
                let view = record.map_or(String::new(), |tag| format!(
                    "if let NativeValue::Object(object) | NativeValue::Record(_, object) = value {{ return Some(U{union_id}::V{tag}(object.clone())); }}"
                ));
                (
                    format!("match value {{ {b} }}"),
                    format!("{{ {c} {view} None }}"),
                )
            }
            _ => (
                format!("NativeValue::V{i}(value)"),
                format!(
                    "if let NativeValue::V{i}(v) = value {{ Some(v.clone()) }} else {{ None }}"
                ),
            ),
        };
        // A direct checked record conversion is an owning property view.
        // Union tag tests still use native_try and require a known record tag;
        // an untagged object must not arbitrarily select a union's first arm.
        let object_view = if let Type::Union { union_id } = ty
            && let Some((tag, _)) = module.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .find(|(_, arm)| matches!(arm, Type::Record { shape_id } if record_storage::shared(&module.records[*shape_id], module)))
        {
            // A checked conversion is allowed to give an untagged ordinary
            // object an owning record view. Keep native_try strict so tag
            // tests and ordinary union narrowing never guess a structural arm.
            format!(
                "if let NativeValue::Object(object) = value {{ return U{union_id}::V{tag}(object.clone()); }}"
            )
        } else if matches!(ty, Type::Record { shape_id } if module.records[*shape_id].fields.is_empty() && module.records[*shape_id].index_value == Some(Type::Dyn))
        {
            "if let NativeValue::Object(object) | NativeValue::Record(_, object) = value { return object.clone(); }".into()
        } else if matches!(ty, Type::Record { shape_id } if record_storage::shared(&module.records[*shape_id], module))
        {
            let Type::Record { shape_id } = ty else { unreachable!() };
            format!("if let NativeValue::NullConstructor(object) = value {{ return native_callable_attach(object.clone(), value.clone(), {}); }} if let NativeValue::Object(object) = value {{ return object.clone(); }}", record_tags[*shape_id])
        } else {
            String::new()
        };
        // Values that cross a Dyn boundary use the erased NativeValue::Array
        // representation.  A checked union conversion can restore the typed
        // array view when there is exactly one array arm; unlike native_try,
        // this is an owning conversion and may validate/map every element.
        // Keep ambiguous array unions strict instead of guessing an arm.
        let union_array_view = if let Type::Union { union_id } = ty {
            let arrays = module.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| matches!(arm, Type::Array { .. }))
                .collect::<Vec<_>>();
            // Element categories a dynamic array element must satisfy for an
            // arm: 0 any, 1 array, 2 plain object, 3 string, 4 number.
            let category = |array: &Type| match array {
                Type::Array { elem } => match elem.as_ref() {
                    Type::Dyn => Some(0u8),
                    Type::Array { .. } => Some(1),
                    Type::Record { shape_id } if module.records[*shape_id].tuple => Some(1),
                    Type::Record { .. } => Some(2),
                    Type::String => Some(3),
                    Type::F64 => Some(4),
                    _ => None,
                },
                _ => None,
            };
            if let [(tag, array)] = arrays.as_slice() {
                let array_id = id(array, module);
                format!(
                    "if native_value_is_array(value) {{ return U{union_id}::V{tag}(native_check_{array_id}(value)); }}"
                )
            } else if arrays.len() > 1
                && arrays.iter().all(|(_, array)| category(array).is_some())
            {
                // Several array views (`Row[] | any[][]`): select the first
                // arm whose element category admits every current element,
                // keeping unconstrained (`any`) element views last.
                let mut ordered = arrays.clone();
                ordered.sort_by_key(|(_, array)| category(array) == Some(0));
                let mut code = String::from(
                    "if let Some(items) = native_array_to_dynamic(value) { let length = runtime::array_len(&items) as usize; let fits = |kind: u8| (0..length).all(|index| { let element = runtime::array_get(&items, index as f64); match kind { 0 => true, 1 => native_value_is_array(&element), 2 => !native_value_is_array(&element) && matches!(element, NativeValue::Record(..) | NativeValue::Object(..)), 3 => matches!(element, NativeValue::String(_)), _ => matches!(element, NativeValue::Number(_)) } });",
                );
                for (tag, array) in ordered {
                    let array_id = id(array, module);
                    let kind = category(array).expect("checked array category");
                    code.push_str(&format!(
                        " if fits({kind}) {{ return U{union_id}::V{tag}(native_check_{array_id}(value)); }}"
                    ));
                }
                code.push_str(" }");
                code
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        // A nullable callable may arrive through Dyn with a different native
        // signature from the checked arm. As with a direct callable check,
        // retain its identity and install a checked forwarding ABI. Do not
        // guess between multiple callable arms or other present union arms.
        let union_function_view = if let Type::Union { union_id } = ty {
            let arms = &module.unions[*union_id].arms;
            let functions = arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| matches!(arm, Type::Func { .. }))
                .collect::<Vec<_>>();
            if let [(tag, function)] = functions.as_slice()
                && arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Func { .. } | Type::Null | Type::Undefined))
            {
                let function_id = id(function, module);
                format!(
                    "if native_value_is_function(value) && native_function_properties(value).is_some() {{ return U{union_id}::V{tag}(native_check_{function_id}(value)); }}"
                )
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let function_view = if let Type::Func { .. } = ty {
            let name = functions::type_name(ty, module);
            // A value arriving through Dyn only promises the JavaScript
            // callable brand. Its parameter and result ABI cannot be
            // inspected at runtime, so install the same checked forwarding
            // view for native intrinsics (Promise resolve/reject, bind,
            // process.write, and future callable runtime values) that we use
            // for compatible generated closures. The forwarding call still
            // boxes arguments and checks its typed result.
            // All compatible typed-function variants already pass the shared
            // brand check; repeating their lists for every target signature
            // grows generated modules quadratically.
            format!(
                "if native_value_is_function(value) {{ let properties = native_function_properties(value).unwrap_or_else(|| runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }})); return runtime::Gc::new({name}::Forward {{ original: Some(value.clone()), properties: Some(properties) }}); }}"
            )
        } else {
            String::new()
        };
        let array_view = if let Type::Array { elem } = ty {
            if **elem == Type::Dyn {
                format!(
                    "if let Some(exact) = native_try_{i}(value) {{ return exact; }} if let Some(array) = native_array_to_dynamic(value) {{ return array; }}"
                )
            } else {
                let read = checked(elem, "value", module);
                let write = boxed(elem, "value", module);
                let target = rust_type((**elem).clone(), module);
                format!(
                    "if let Some(exact) = native_try_{i}(value) {{ return exact; }} if let Some(array) = native_array_to_dynamic(value) {{ if let Some(source) = runtime::array_mapped_source::<{target}, NativeValue>(&array) {{ return source; }} return runtime::array_mapped(array, |value| {read}, |value| {write}); }}"
                )
            }
        } else {
            String::new()
        };
        let tuple_view = if let Type::Record { shape_id } = ty
            && module.records[*shape_id].tuple
            && specialized(ty, module)
        {
            let record = &module.records[*shape_id];
            let fields = record
                .fields
                .iter()
                .map(|field| format!("{}: None", field_name(&field.name)))
                .collect::<Vec<_>>()
                .join(", ");
            let keys = record
                .declared_order
                .iter()
                .map(|name| format!("{name:?}.into()"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "if let Some(source) = native_array_to_dynamic(value) {{ if runtime::array_len(&source) == {}.0 {{ return runtime::Gc::new(R{shape_id} {{ source: Some(source), own_keys: vec![{keys}], {fields} }}); }} }}",
                record.fields.len()
            )
        } else {
            String::new()
        };
        let set_view = if let Type::Set { elem } = ty {
            let read = checked(elem, "value.clone()", module);
            let write = boxed(elem, "value", module);
            format!(
                "if let Some(storage) = native_set_storage(value) {{ return NativeTypedSet {{ storage, read: |value| {read}, write: |value| {write} }}; }}"
            )
        } else {
            String::new()
        };
        writeln!(out, "fn native_box_{i}(value: {rt}) -> NativeValue {{ {box_code} }}\nfn native_try_{i}(value: &NativeValue) -> Option<{rt}> {{ {try_code} }}\n#[track_caller] fn native_check_{i}(value: &NativeValue) -> {rt} {{ {object_view} {function_view} {union_function_view} {array_view} {tuple_view} {union_array_view} {generator_view} {set_view} let location = std::panic::Location::caller(); native_try_{i}(value).unwrap_or_else(|| native_check_failed(value, {i}, {rt:?}, location)) }}").unwrap();
    }
    out.push_str(r#"fn native_value_missing<K: runtime::JsStringSource + ?Sized>(key: &K) -> NativeValue { native_value_missing_kind(key, "object") }
fn native_value_missing_kind<K: runtime::JsStringSource + ?Sized>(key: &K, kind: &str) -> NativeValue {
    let key = key.well_formed_utf8().unwrap_or("");
    if kind == "array" && key == "join" { return NativeValue::ArrayJoinMethod; }
    let inherited = matches!(key, "toString" | "valueOf" | "constructor" | "__proto__" | "hasOwnProperty" | "isPrototypeOf" | "propertyIsEnumerable" | "toLocaleString");
    let specialized = match kind {
        "function" => matches!(key, "name" | "length" | "bind" | "call" | "apply" | "prototype" | "caller" | "arguments"),
        "array" => matches!(key, "map" | "filter" | "reduce" | "reduceRight" | "forEach" | "push" | "pop" | "shift" | "unshift" | "slice" | "splice" | "join" | "sort" | "reverse" | "entries" | "keys" | "values" | "includes" | "indexOf" | "at" | "find" | "findIndex" | "some" | "every" | "flat" | "flatMap" | "concat" | "with" | "toSorted" | "toReversed" | "toSpliced" | "fill" | "copyWithin" | "findLast" | "findLastIndex" | "lastIndexOf"),
        "string" => matches!(key, "trim" | "trimStart" | "trimEnd" | "split" | "replace" | "replaceAll" | "match" | "matchAll" | "search" | "slice" | "substring" | "substr" | "includes" | "startsWith" | "endsWith" | "charAt" | "charCodeAt" | "codePointAt" | "at" | "indexOf" | "lastIndexOf" | "toLowerCase" | "toUpperCase" | "repeat" | "padStart" | "padEnd" | "normalize" | "concat" | "localeCompare" | "toLocaleLowerCase" | "toLocaleUpperCase"),
        "symbol" => matches!(key, "description"),
        "regex" => matches!(key, "source" | "flags" | "lastIndex" | "global" | "ignoreCase" | "multiline" | "dotAll" | "unicode" | "unicodeSets" | "sticky" | "hasIndices" | "exec" | "test" | "compile"),
        "promise" => matches!(key, "then" | "catch" | "finally"),
        "set" => matches!(key, "add" | "has" | "delete" | "clear" | "size" | "entries" | "keys" | "values" | "forEach"),
        "map" => matches!(key, "get" | "set" | "size" | "has" | "delete" | "clear" | "entries" | "keys" | "values" | "forEach"),
        "number" => matches!(key, "toFixed" | "toExponential" | "toPrecision"),
        _ => false,
    };
    if inherited || specialized { runtime::throw_type_error(format!("scriptc: native erased {} member {} is not supported yet", kind, key)) }
    NativeValue::Undefined
}


"#);
    out.push_str("fn native_value_eq(left: &NativeValue, right: &NativeValue) -> bool { if let (Some(a), Some(b)) = (native_array_identity(left), native_array_identity(right)) { return a == b; } if let (Some(a), Some(b)) = (native_set_storage(left), native_set_storage(right)) { return a.ptr_eq(&b); } if let (Some(a), Some(b)) = (native_function_properties(left), native_function_properties(right)) { return a.ptr_eq(&b); } match (left, right) { (NativeValue::MapValuesIterator(a), NativeValue::MapValuesIterator(b)) => a.ptr_eq(b), (NativeValue::ArrayIterator(a), NativeValue::ArrayIterator(b)) => a.ptr_eq(b), (NativeValue::SyncGeneratorMethod(a), NativeValue::SyncGeneratorMethod(b)) => a == b, (NativeValue::MapValuesNext, NativeValue::MapValuesNext) | (NativeValue::ArrayIteratorNext, NativeValue::ArrayIteratorNext) | (NativeValue::IteratorIdentity, NativeValue::IteratorIdentity) => true, (NativeValue::ArrayIndexOfMethod, NativeValue::ArrayIndexOfMethod) => true, (NativeValue::ArrayMutationMethod(a), NativeValue::ArrayMutationMethod(b)) => a == b, (NativeValue::ArrayPredicateMethod(a), NativeValue::ArrayPredicateMethod(b)) => a == b, (NativeValue::ArrayDynMethod(a), NativeValue::ArrayDynMethod(b)) => a == b, (NativeValue::RawJson(a), NativeValue::RawJson(b)) => a.ptr_eq(b), (NativeValue::Proxy(a), NativeValue::Proxy(b)) => a.ptr_eq(b), (NativeValue::Record(_,a), NativeValue::Record(_,b)) => a.ptr_eq(b), (NativeValue::Record(_,a), NativeValue::Object(b)) | (NativeValue::Object(a), NativeValue::Record(_,b)) => a.ptr_eq(b), (NativeValue::Undefined, NativeValue::Undefined) | (NativeValue::Null, NativeValue::Null) => true, (NativeValue::Number(a), NativeValue::Number(b)) => a == b, (NativeValue::BigInt(a), NativeValue::BigInt(b)) => a == b, (NativeValue::Boolean(a), NativeValue::Boolean(b)) => a == b, (NativeValue::String(a), NativeValue::String(b)) => a == b, (NativeValue::Date(a), NativeValue::Date(b)) => a == b, (NativeValue::Url(a), NativeValue::Url(b)) => std::rc::Rc::ptr_eq(a,b), (NativeValue::Symbol(a), NativeValue::Symbol(b)) => runtime::symbol_ptr_eq(a,b), (NativeValue::Regex(a), NativeValue::Regex(b)) => std::rc::Rc::ptr_eq(a,b), (NativeValue::ArrayBuffer(a), NativeValue::ArrayBuffer(b)) => a.ptr_eq(b), (NativeValue::WebBytesStream(a), NativeValue::WebBytesStream(b)) => a.ptr_eq(b), (NativeValue::WebBytesReader(a), NativeValue::WebBytesReader(b)) => a.ptr_eq(b), (NativeValue::HttpResponse(a), NativeValue::HttpResponse(b)) | (NativeValue::Headers(a), NativeValue::Headers(b)) => a.ptr_eq(b), (NativeValue::AbortSignal(a), NativeValue::AbortSignal(b)) | (NativeValue::AbortControllerAbort(a), NativeValue::AbortControllerAbort(b)) => a.ptr_eq(b), (NativeValue::Object(a), NativeValue::Object(b)) => a.ptr_eq(b), (NativeValue::Map(a), NativeValue::Map(b)) => a.ptr_eq(b), (NativeValue::Promise(a), NativeValue::Promise(b)) => runtime::promise_view_identity(a) == runtime::promise_view_identity(b), (NativeValue::Array(a), NativeValue::Array(b)) | (NativeValue::Bound(a), NativeValue::Bound(b)) => a.ptr_eq(b), (NativeValue::StringMethod(a), NativeValue::StringMethod(b)) | (NativeValue::ProcessWrite(a), NativeValue::ProcessWrite(b)) | (NativeValue::ProcessStdinMethod(a), NativeValue::ProcessStdinMethod(b)) | (NativeValue::PromiseStaticMethod(a), NativeValue::PromiseStaticMethod(b)) | (NativeValue::AbortSignalStatic(a), NativeValue::AbortSignalStatic(b)) => a == b, (NativeValue::ObjectToString, NativeValue::ObjectToString) | (NativeValue::FunctionCall, NativeValue::FunctionCall) | (NativeValue::FunctionHasInstance, NativeValue::FunctionHasInstance) | (NativeValue::Fetch, NativeValue::Fetch) | (NativeValue::AbortSignalConstructor, NativeValue::AbortSignalConstructor) | (NativeValue::BindIntrinsic, NativeValue::BindIntrinsic) | (NativeValue::ArraySpliceMethod, NativeValue::ArraySpliceMethod) | (NativeValue::ArrayMapMethod, NativeValue::ArrayMapMethod) | (NativeValue::ArrayJoinMethod, NativeValue::ArrayJoinMethod) | (NativeValue::MapConstructor, NativeValue::MapConstructor) | (NativeValue::RegexConstructor, NativeValue::RegexConstructor) | (NativeValue::LegacyUnescape, NativeValue::LegacyUnescape) | (NativeValue::PromiseConstructor, NativeValue::PromiseConstructor) => true,\n");
    out.push_str(
        "(NativeValue::InstanceSymbolMethod(a), NativeValue::InstanceSymbolMethod(b)) => a == b,\n",
    );
    out.push_str("(NativeValue::WeakRef(a), NativeValue::WeakRef(b)) | (NativeValue::FinalizationRegistry(a), NativeValue::FinalizationRegistry(b)) => a.ptr_eq(b),\n");
    out.push_str(
        "(NativeValue::InstanceSymbolGetter(a), NativeValue::InstanceSymbolGetter(b)) => a == b,\n",
    );
    out.push_str("(NativeValue::TimerMethod(a), NativeValue::TimerMethod(b)) => a == b,\n");
    out.push_str("(NativeValue::InstanceMethod(a, ac), NativeValue::InstanceMethod(b, bc)) => a == b && ac == bc,\n");
    out.push_str("(NativeValue::WebConstructor(a), NativeValue::WebConstructor(b)) => a == b,\n");
    out.push_str("(NativeValue::HttpIncomingMessageConstructor, NativeValue::HttpIncomingMessageConstructor) => true,\n");
    out.push_str("(NativeValue::DebugLog(a, _), NativeValue::DebugLog(b, _)) => a == b,\n");
    if !module.classes.is_empty() {
        out.push_str("(NativeValue::Instance(a), NativeValue::Instance(b)) => a.ptr_eq(b),\n");
    }
    for (i, t) in types
        .iter()
        .enumerate()
        .filter(|(_, t)| specialized(t, module))
    {
        let eq = match t {
            Type::Record { shape_id } if module.records[*shape_id].tuple => {
                "a.with(|a| a.source.as_ref().map(runtime::array_identity)).unwrap_or_else(|| a.identity()) == b.with(|b| b.source.as_ref().map(runtime::array_identity)).unwrap_or_else(|| b.identity())"
            }
            Type::Classval { .. } => "a == b",
            Type::Generator { r#async: false, .. } => "runtime::generator_ptr_eq(a, b)",
            Type::Generator { r#async: true, .. } => "runtime::async_generator_ptr_eq(a, b)",
            _ => "a.ptr_eq(b)",
        };
        writeln!(out, "(NativeValue::V{i}(a), NativeValue::V{i}(b)) => {eq},").unwrap();
    }
    out.push_str("_ => false } }\nfn native_value_test(value: &NativeValue, test: &str) -> bool { match test { \"bigint\" => matches!(value, NativeValue::BigInt(_)), \"number\" => matches!(value, NativeValue::Number(_)), \"boolean\" => matches!(value, NativeValue::Boolean(_)), \"string\" => matches!(value, NativeValue::String(_)), \"symbol\" => matches!(value, NativeValue::Symbol(_)), \"date\" => matches!(value, NativeValue::Date(_)), \"regex\" => matches!(value, NativeValue::Regex(_)), \"url\" => matches!(value, NativeValue::Url(_)), \"promise\" => matches!(value, NativeValue::Promise(_)), \"arrayBuffer\" => matches!(value, NativeValue::ArrayBuffer(_)), \"undefined\" => matches!(value, NativeValue::Undefined), \"null\" => matches!(value, NativeValue::Null), \"nullish\" => matches!(value, NativeValue::Undefined | NativeValue::Null), \"array\" => native_value_is_array(value), \"bytes\" | \"bytes.u8\" | \"bytes.f32\" | \"bytes.f64\" | \"map\" | \"set\" => native_value_collection_brand(value, test), \"truthy\" => match value { NativeValue::Undefined | NativeValue::Null => false, NativeValue::BigInt(v) => runtime::bigint_truthy(v), NativeValue::Number(v) => *v != 0.0 && !v.is_nan(), NativeValue::Boolean(v) => *v, NativeValue::String(v) => !v.is_empty(), _ => true }, \"function\" => native_value_is_function(value),\n");
    if module.classes.is_empty() {
        out.push_str("\"classIterable\" => false,\n");
    } else {
        out.push_str("\"classIterable\" => matches!(value, NativeValue::Instance(_)) && native_value_has_symbol_key(value.clone(), NativeValue::Symbol(runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator))),\n");
    }
    out.push_str("\"object\" => !matches!(value, NativeValue::Undefined | NativeValue::Null | NativeValue::BigInt(_) | NativeValue::Number(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::Symbol(_)) && !native_value_test(value, \"function\"), \"syncGenerator\" => native_value_is_sync_generator(value), \"mapValuesIterator\" => matches!(value, NativeValue::MapValuesIterator(_)), \"objectInstance\" => !matches!(value, NativeValue::Undefined | NativeValue::Null | NativeValue::BigInt(_) | NativeValue::Number(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::Symbol(_)), _ => false } }\n");

    out.push_str("fn native_value_plain_record_prototype(value: &NativeValue) -> Option<bool> { match value { NativeValue::Record(_, object) | NativeValue::Object(object) => Some(object.with(|data| data.null_prototype)),\n");
    for (i, ty) in types.iter().enumerate() {
        if let Type::Record { shape_id } = ty
            && specialized(ty, module)
            && !module.records[*shape_id].tuple
        {
            writeln!(out, "NativeValue::V{i}(..) => Some(false),").unwrap();
        }
    }
    out.push_str("_ => None } }\n");
    out.push_str(include_str!("loose_equal_support.rs"));
    out.push_str(include_str!("deep_equal_support.rs"));

    out.push_str("fn native_record_plan_set(plan: NativeValue, key: runtime::JsString, value: NativeValue) { if native_getter_define_data(&plan, &key, value.clone()) { return; } match plan { NativeValue::Object(object) => object.with_mut(|data| native_record_define(&mut data.entries, key, value)), NativeValue::Record(_,object) => native_record_set(&object, key, value), _ => runtime::throw_type_error(\"scriptc: own-value plan must be a native object\".into()) } }\n");
    // Own symbol slots preserve identity; exotic receivers and inherited
    // symbol descriptors still require their own lookup contracts.
    out.push_str("fn native_value_symbol_get(value: NativeValue, key: runtime::JsSymbol) -> NativeValue { if native_value_is_sync_generator(&value) { if runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator)) { return NativeValue::IteratorIdentity; } if runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::ToStringTag)) { return NativeValue::String(runtime::string(\"Generator\")); } return NativeValue::Undefined; } if matches!(&value, NativeValue::MapValuesIterator(_)) { if runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator)) { return NativeValue::IteratorIdentity; } if runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::ToStringTag)) { return NativeValue::String(runtime::string(\"Map Iterator\")); } return NativeValue::Undefined; } if runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator)) && native_value_is_array(&value) { return NativeValue::ArrayIteratorFactory; } match value { NativeValue::Callable(function) => function.with(|function| function.properties.as_ref().expect(\"scriptc: cleared callable properties\").with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&runtime::PropertyKey::Symbol(key))).map(|property| property.value.clone()).unwrap_or(NativeValue::Undefined))), NativeValue::Record(_, object) | NativeValue::Object(object) => object.with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&runtime::PropertyKey::Symbol(key))).map(|property| property.value.clone()).unwrap_or(NativeValue::Undefined)), NativeValue::ArrayIterator(_) => if runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator)) { NativeValue::IteratorIdentity } else if runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::ToStringTag)) { NativeValue::String(runtime::string(\"Array Iterator\")) } else { NativeValue::Undefined }, ");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => native_instance_symbol_get(object, key), ");
    }
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Classval { .. }) {
            writeln!(out, "NativeValue::V{index}(class) => native_class_static_symbol_get(class, &key).unwrap_or(NativeValue::Undefined),").unwrap();
        }
    }
    out.push_str("NativeValue::Undefined => runtime::throw_type_error(format!(\"Cannot read properties of undefined (reading '{}')\", runtime::symbol_to_string(&key))), NativeValue::Null => runtime::throw_type_error(format!(\"Cannot read properties of null (reading '{}')\", runtime::symbol_to_string(&key))), _ => runtime::throw_type_error(\"scriptc: symbol property access on this native value is not supported yet\".into()) } }\n");
    if !module.classes.is_empty() {
        out.push_str("fn native_instance_symbol_get(object: runtime::Gc<NativeInstance>, key: runtime::JsSymbol) -> NativeValue { let value = object.with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&runtime::PropertyKey::Symbol(key.clone()))).map(|property| property.value.clone())).or_else(|| object.with(|data| native_class_brand_get(data.class, &key).then_some(NativeValue::Boolean(true)))).or_else(|| object.with(|data| native_class_symbol_get(data.class, &key))).unwrap_or(NativeValue::Undefined); match value { NativeValue::InstanceSymbolGetter(index) => native_value_call_with_this(NativeValue::InstanceSymbolGetter(index), NativeValue::Instance(object), vec![], \"symbol getter\"), other => other } }\n");
    }
    out.push_str("fn native_value_has_symbol_key(value: NativeValue, key: NativeValue) -> bool { let NativeValue::Symbol(key) = key else { runtime::throw_type_error(\"scriptc: expected a symbol key\".into()) }; if native_value_is_sync_generator(&value) || matches!(&value, NativeValue::MapValuesIterator(_) | NativeValue::ArrayIterator(_)) { return runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::Iterator)) || runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::ToStringTag)); } match value { NativeValue::Callable(function) => function.with(|function| function.properties.as_ref().expect(\"scriptc: cleared callable properties\").with(|data| data.symbol_properties.as_ref().is_some_and(|table| table.get(&runtime::PropertyKey::Symbol(key)).is_some()))), NativeValue::Record(_, object) | NativeValue::Object(object) => object.with(|data| data.symbol_properties.as_ref().is_some_and(|table| table.get(&runtime::PropertyKey::Symbol(key)).is_some())), ");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => object.with(|data| data.symbol_properties.as_ref().is_some_and(|table| table.get(&runtime::PropertyKey::Symbol(key.clone())).is_some()) || native_class_brand_get(data.class, &key) || native_class_symbol_get(data.class, &key).is_some()), ");
    }
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Classval { .. }) {
            writeln!(out, "NativeValue::V{index}(class) => native_class_static_symbol_get(class, &key).is_some(),").unwrap();
        }
    }
    for (index, ty) in types.iter().enumerate() {
        let symbol = match ty {
            Type::Generator { r#async: false, .. } => "Iterator",
            Type::Generator { r#async: true, .. } => "AsyncIterator",
            _ => continue,
        };
        writeln!(
            out,
            "NativeValue::V{index}(..) => runtime::symbol_ptr_eq(&key, &runtime::symbol_well_known(runtime::WellKnownSymbol::{symbol})),"
        )
        .unwrap();
    }
    out.push_str("_ => runtime::throw_error_code(\"scriptc SC1031: symbol presence requires an ordinary object\".into(), \"SC1031\") } }\n");
    out.push_str("fn native_value_has_own_symbol_key(value: NativeValue, key: NativeValue) -> bool { let NativeValue::Symbol(key) = key else { runtime::throw_type_error(\"scriptc: expected a symbol key\".into()) }; match value { NativeValue::Callable(function) => function.with(|function| function.properties.as_ref().expect(\"scriptc: cleared callable properties\").with(|data| data.symbol_properties.as_ref().is_some_and(|table| table.get(&runtime::PropertyKey::Symbol(key)).is_some()))), NativeValue::Record(_, object) | NativeValue::Object(object) => object.with(|data| data.symbol_properties.as_ref().is_some_and(|table| table.get(&runtime::PropertyKey::Symbol(key)).is_some())), ");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => object.with(|data| data.symbol_properties.as_ref().is_some_and(|table| table.get(&runtime::PropertyKey::Symbol(key)).is_some())), ");
    }
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Classval { .. }) {
            writeln!(out, "NativeValue::V{index}(class) => native_class_properties(class).with(|data| data.symbol_properties.as_ref().is_some_and(|table| table.get(&runtime::PropertyKey::Symbol(key)).is_some())),").unwrap();
        }
    }
    out.push_str("NativeValue::Undefined | NativeValue::Null => runtime::throw_type_error(\"Cannot convert undefined or null to object\".into()), _ => false } }\n");
    out.push_str("fn native_value_symbol_set(value: NativeValue, key: runtime::JsSymbol, field: NativeValue) { let extensible = !native_object_frozen(&value); let write = |table: &mut Option<runtime::DataPropertyTable<NativeValue>>| { let table = table.get_or_insert_with(runtime::DataPropertyTable::new); let key = runtime::PropertyKey::Symbol(key); match table.write_own(&key, field.clone()) { runtime::WriteOwnDataResult::Written => (), runtime::WriteOwnDataResult::NonWritable => runtime::throw_type_error(\"Cannot assign to read only symbol property\".into()), runtime::WriteOwnDataResult::Missing => { if !extensible { runtime::throw_type_error(\"Cannot add property, object is not extensible\".into()); } let descriptor = runtime::DataDescriptor { value: Some(field), writable: Some(true), enumerable: Some(true), configurable: Some(true) }; table.define(key, &descriptor, true, NativeValue::Undefined, |_, _| false).expect(\"new symbol property\"); } } }; match value { NativeValue::Record(_, object) | NativeValue::Object(object) => object.with_mut(|data| write(&mut data.symbol_properties)), ");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => object.with_mut(|data| write(&mut data.symbol_properties)), ");
    }
    out.push_str("NativeValue::Callable(function) => function.with(|function| function.properties.as_ref().expect(\"scriptc: cleared callable properties\").with_mut(|data| write(&mut data.symbol_properties))), _ => runtime::throw_type_error(\"scriptc: symbol property writes require an ordinary native object\".into()) } }\n");
    out.push_str("fn native_value_symbol_define(value: NativeValue, key: runtime::JsSymbol, descriptor: runtime::DataDescriptor<NativeValue>) { let extensible = !native_object_frozen(&value); let define = |table: &mut Option<runtime::DataPropertyTable<NativeValue>>| { table.get_or_insert_with(runtime::DataPropertyTable::new).define(runtime::PropertyKey::Symbol(key), &descriptor, extensible, NativeValue::Undefined, native_value_eq).unwrap_or_else(|_| runtime::throw_type_error(\"Cannot redefine symbol property\".into())) }; match value { NativeValue::Record(_, object) | NativeValue::Object(object) => object.with_mut(|data| define(&mut data.symbol_properties)), ");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => object.with_mut(|data| define(&mut data.symbol_properties)), ");
    }
    out.push_str("NativeValue::Callable(function) => function.with(|function| function.properties.as_ref().expect(\"scriptc: cleared callable properties\").with_mut(|data| define(&mut data.symbol_properties))), _ => runtime::throw_error_code(\"scriptc SC1031: symbol data properties require an ordinary target\".into(), \"SC1031\") } }\n");
    out.push_str(r#"
fn native_define_ordinary_data(target: NativeValue, key: NativeValue, descriptor: NativeValue) -> NativeValue {
    if !matches!(&key, NativeValue::String(_) | NativeValue::Symbol(_)) {
        runtime::throw_error_code("scriptc SC1031: dynamic property descriptor keys require a string or symbol".into(), "SC1031");
    }
    let object = match descriptor {
        NativeValue::Object(object) | NativeValue::Record(_, object) => object,
        _ => runtime::throw_error_code("scriptc SC1031: dynamic property descriptors require an ordinary descriptor".into(), "SC1031"),
    };
    let descriptor = object.with(|data| {
        let get = |name: &str| data.entries.iter().find(|(key, _)| *key == name).map(|(_, value)| value);
        if get("get").is_some() || get("set").is_some() {
            if get("value").is_some() || get("writable").is_some() {
                runtime::throw_type_error("Invalid property descriptor. Cannot both specify accessors and a value or writable attribute".into());
            }
            runtime::throw_error_code("scriptc SC1031: accessor descriptor is not a data descriptor".into(), "SC1031");
        }
        let flag = |name| match get(name) { None => None, Some(NativeValue::Boolean(value)) => Some(*value), Some(_) => runtime::throw_error_code("scriptc SC1031: data-property flags require booleans".into(), "SC1031") };
        runtime::DataDescriptor { value: get("value").cloned(), writable: flag("writable"), enumerable: flag("enumerable"), configurable: flag("configurable") }
    });
    match key {
        NativeValue::String(key) => {
            if !native_define_ordinary_data_descriptor(&target, &key, descriptor) {
                runtime::throw_error_code("scriptc SC1031: string data-property target is not an ordinary object".into(), "SC1031");
            }
        },
        NativeValue::Symbol(key) => native_value_symbol_define(target.clone(), key, descriptor),
        _ => unreachable!(),
    }
    target
}
fn native_define_ordinary_property(target: NativeValue, key: NativeValue, descriptor: NativeValue) -> NativeValue {
    let object = match &descriptor {
        NativeValue::Object(object) | NativeValue::Record(_, object) => object.clone(),
        _ => runtime::throw_type_error("Property description must be an object".into()),
    };
    let (get, set, value, writable, enumerable, configurable) = object.with(|data| {
        let read = |name: &str| data.entries.iter().find(|(key, _)| *key == name).map(|(_, value)| value.clone());
        (read("get"), read("set"), read("value"), read("writable"), read("enumerable"), read("configurable"))
    });
    if get.is_some() || set.is_some() {
        if value.is_some() || writable.is_some() {
            runtime::throw_type_error("Invalid property descriptor. Cannot both specify accessors and a value or writable attribute".into());
        }
        if matches!(key, NativeValue::Symbol(_)) {
            runtime::throw_error_code("scriptc SC1031: symbol accessor descriptors are not ported".into(), "SC1031");
        }
        let enumerable = enumerable.unwrap_or(NativeValue::Undefined);
        let configurable = configurable.unwrap_or(NativeValue::Undefined);
        // One descriptor with both accessors is one definition: splitting it
        // would redefine a (default non-configurable) accessor and throw.
        if let (Some(getter), Some(setter)) = (get.clone(), set.clone()) {
            return native_define_ordinary_accessor(target, key, getter, setter, enumerable, configurable);
        }
        if let Some(getter) = get {
            native_define_ordinary_getter(target.clone(), key.clone(), getter, enumerable.clone(), configurable.clone());
        }
        if let Some(setter) = set {
            native_define_ordinary_setter(target.clone(), key, setter, enumerable, configurable);
        }
        return target;
    }
    native_define_ordinary_data(target, key, descriptor)
}
fn native_define_properties(target: NativeValue, descriptors: NativeValue) -> NativeValue {
    let keys = native_reflect_own_keys(descriptors.clone());
    for index in 0..runtime::array_len(&keys) as usize {
        let key = runtime::array_get(&keys, index as f64);
        let descriptor = match &key {
            NativeValue::String(key) => native_value_get(descriptors.clone(), key.clone()),
            NativeValue::Symbol(key) => native_value_symbol_get(descriptors.clone(), key.clone()),
            _ => unreachable!("Reflect.ownKeys key ABI"),
        };
        native_define_ordinary_property(target.clone(), key, descriptor);
    }
    target
}
fn native_delete_computed(value: NativeValue, key: NativeValue, strict: bool) -> bool {
    match key {
        NativeValue::Symbol(key) => match value {
            NativeValue::Object(object) | NativeValue::Record(_, object) => {
                let deleted = object.with_mut(|data| data.symbol_properties.as_mut().is_none_or(|properties| properties.delete(&runtime::PropertyKey::Symbol(key.clone()))));
                if !deleted && strict { runtime::throw_type_error(format!("Cannot delete property '{}'", runtime::symbol_to_string(&key))); }
                deleted
            }
            NativeValue::Null | NativeValue::Undefined => runtime::throw_type_error("Cannot convert undefined or null to object".into()),
            NativeValue::Number(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::BigInt(_) | NativeValue::Symbol(_) => true,
            _ => runtime::throw_error_code("scriptc SC1031: deleting symbol properties requires an ordinary object".into(), "SC1031"),
        },
        other => runtime::native_delete_property(&value, &native_value_string(other), strict),
    }
}
"#);
    out.push_str("fn native_copy_enumerable_symbols(target: NativeValue, source: NativeValue) { let entries = match source { NativeValue::Record(_, object) | NativeValue::Object(object) => object.with(|data| data.symbol_properties.as_ref().map(|table| table.own_keys(true).into_iter().filter_map(|key| match key { runtime::PropertyKey::Symbol(symbol) => table.get(&runtime::PropertyKey::Symbol(symbol.clone())).map(|p| (symbol, p.value.clone())), _ => None }).collect::<Vec<_>>()).unwrap_or_default()), _ => Vec::new() }; for (key, value) in entries { native_value_symbol_set(target.clone(), key, value); } }\n");
    own_key_definitions(&types, module, out);
    regex::metadata_definitions(&types, out);
    let socket_chunk = if module.value_types().contains(&Type::bytes()) {
        boxed(&Type::bytes(), "chunk", module)
    } else {
        "NativeValue::ArrayBuffer(chunk)".into()
    };
    out.push_str(&format!(r#"
fn native_file_handle_call(
    handle: runtime::JsFileHandle,
    method: u8,
    args: Vec<NativeValue>,
) -> NativeValue {{
    match method {{
        0 => {{
            let buffer_value = args.first().cloned().unwrap_or(NativeValue::Undefined);
            let buffer = native_file_handle_bytes(buffer_value.clone()).unwrap_or_else(||
                runtime::throw_type_error("FileHandle.read buffer must be a Buffer or Uint8Array".into())
            );
            let offset = args.get(1).map(native_compare_number).unwrap_or(0.0);
            let length = args.get(2).map(native_compare_number).unwrap_or_else(|| runtime::bytes_len(&buffer));
            let position = args.get(3).map(native_compare_number).unwrap_or(-1.0);
            let source = runtime::file_handle_read_promise(&handle, &buffer, offset, length, position);
            NativeValue::Promise(runtime::promise_view_map(&source, move |bytes_read| {{
                NativeValue::Object(runtime::Gc::new(NativeMap {{
                    null_prototype: false,
                    symbol_properties: None,
                    entries: vec![
                        (runtime::string("bytesRead"), NativeValue::Number(bytes_read)),
                        (runtime::string("buffer"), buffer_value.clone()),
                    ],
                    hash_index: NativeHashIndex::default(),
                }}))
            }}))
        }}
        1 => {{
            let source = runtime::file_handle_close_promise(&handle);
            NativeValue::Promise(runtime::promise_view_map(&source, |_| NativeValue::Undefined))
        }}
        _ => unreachable!("validated FileHandle method"),
    }}
}}

fn native_file_handle_value(handle: runtime::JsFileHandle) -> NativeValue {{
    NativeValue::Object(runtime::Gc::new(NativeMap {{
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("read"), NativeValue::FileHandleMethod(handle.clone(), 0)),
            (runtime::string("close"), NativeValue::FileHandleMethod(handle, 1)),
        ],
        hash_index: NativeHashIndex::default(),
    }}))
}}

fn native_child_stream_value(stream: runtime::JsChildStream) -> NativeValue {{
    NativeValue::Object(runtime::Gc::new(NativeMap {{
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("setEncoding"), NativeValue::ChildStreamMethod(stream.clone(), 0)),
            (runtime::string("on"), NativeValue::ChildStreamMethod(stream.clone(), 1)),
            (runtime::string("once"), NativeValue::ChildStreamMethod(stream, 2)),
        ],
        hash_index: NativeHashIndex::default(),
    }}))
}}

fn native_child_stream_call(
    stream: runtime::JsChildStream,
    method: u8,
    receiver: NativeValue,
    args: Vec<NativeValue>,
) -> NativeValue {{
    if method == 0 {{
        let encoding = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string("undefined"));
        if encoding != "utf8" && encoding != "utf-8" {{
            runtime::throw_type_error("child stream encoding is not ported".into());
        }}
        runtime::child_stream_set_encoding_utf8(&stream);
        return receiver;
    }}
    let event = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string("undefined"));
    let callback = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
    if !native_value_is_function(&callback) {{
        runtime::throw_type_error("child stream listener must be a function".into());
    }}
    let traced = callback.clone();
    let trace: std::rc::Rc<dyn for<'a> Fn(&mut runtime::Tracer<'a>)> =
        std::rc::Rc::new(move |tracer| traced.trace_native(tracer));
    match event.well_formed_utf8().unwrap_or("") {{
        "data" => {{
            let encoded = runtime::child_stream_encoding_utf8(&stream);
            runtime::child_stream_on_data(
                &stream,
                std::rc::Rc::new(move |chunk| {{
                    let value = if encoded {{
                        NativeValue::String(runtime::bytes_to_string(&chunk, &runtime::string("utf8")))
                    }} else {{
                        {socket_chunk}
                    }};
                    let _ = native_value_call(callback.clone(), vec![value], "child stream data listener");
                }}),
                trace,
                method == 2,
            );
        }}
        "end" => {{
            runtime::child_stream_on_end(
                &stream,
                std::rc::Rc::new(move || {{
                    let _ = native_value_call(callback.clone(), Vec::new(), "child stream end listener");
                }}),
                trace,
            );
        }}
        _ => runtime::throw_type_error("child stream event is not ported".into()),
    }}
    receiver
}}

fn native_net_socket_value(socket: runtime::JsNetSocket) -> NativeValue {{
    let mut entries = vec![
        (runtime::string("on"), NativeValue::NetSocketMethod(socket.clone(), 0)),
        (runtime::string("once"), NativeValue::NetSocketMethod(socket.clone(), 1)),
        (runtime::string("write"), NativeValue::NetSocketMethod(socket.clone(), 2)),
        (runtime::string("destroy"), NativeValue::NetSocketMethod(socket.clone(), 3)),
        (runtime::string("end"), NativeValue::NetSocketMethod(socket.clone(), 4)),
        (runtime::string("connect"), NativeValue::NetSocketMethod(socket.clone(), 5)),
        (runtime::string("setTimeout"), NativeValue::NetSocketMethod(socket.clone(), 6)),
    ];
    if runtime::tls_socket_encrypted(&socket).is_some() {{
        entries.push((runtime::string("getProtocol"), NativeValue::NetSocketMethod(socket.clone(), 7)));
        entries.push((runtime::string("getCipher"), NativeValue::NetSocketMethod(socket.clone(), 8)));
        entries.push((runtime::string("getPeerCertificate"), NativeValue::NetSocketMethod(socket, 9)));
    }}
    NativeValue::Object(runtime::Gc::new(NativeMap {{
        null_prototype: false,
        symbol_properties: None,
        entries,
        hash_index: NativeHashIndex::default(),
    }}))
}}

fn native_tls_certificate_name(fields: Vec<(runtime::JsString, Vec<runtime::JsString>)>) -> NativeValue {{
    let entries = fields.into_iter().map(|(key, values)| {{
        let value = if values.len() == 1 {{
            NativeValue::String(values.into_iter().next().expect("one name value"))
        }} else {{
            NativeValue::Array(runtime::array_new(values.into_iter().map(NativeValue::String).collect()))
        }};
        (key, value)
    }}).collect();
    NativeValue::Object(runtime::Gc::new(NativeMap {{
        null_prototype: true,
        symbol_properties: None,
        entries,
        hash_index: NativeHashIndex::default(),
    }}))
}}

fn native_tls_peer_certificate(socket: &runtime::JsNetSocket) -> NativeValue {{
    let certificate = match runtime::tls_socket_peer_certificate(socket) {{
        None => return NativeValue::Null,
        Some(None) => return NativeValue::Object(runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }})),
        Some(Some(value)) => value,
    }};
    let entries = vec![
        (runtime::string("subject"), native_tls_certificate_name(certificate.subject)),
        (runtime::string("issuer"), native_tls_certificate_name(certificate.issuer)),
        (runtime::string("ca"), NativeValue::Boolean(certificate.ca)),
        (runtime::string("valid_from"), NativeValue::String(certificate.valid_from)),
        (runtime::string("valid_to"), NativeValue::String(certificate.valid_to)),
        (runtime::string("fingerprint"), NativeValue::String(certificate.fingerprint)),
        (runtime::string("fingerprint256"), NativeValue::String(certificate.fingerprint256)),
        (runtime::string("fingerprint512"), NativeValue::String(certificate.fingerprint512)),
        (runtime::string("serialNumber"), NativeValue::String(certificate.serial_number)),
    ];
    NativeValue::Object(runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries, hash_index: NativeHashIndex::default() }}))
}}

fn native_tls_connect_options(options: NativeValue, callback: NativeValue) -> NativeValue {{
    let host = match native_value_get(options.clone(), runtime::string("host")) {{
        NativeValue::String(value) => value,
        _ => runtime::throw_type_error("scriptc: tls.connect host must be a string".into()),
    }};
    let port = match native_value_get(options.clone(), runtime::string("port")) {{
        NativeValue::Number(value) => value,
        _ => runtime::throw_type_error("scriptc: tls.connect port must be a number".into()),
    }};
    let servername = match native_value_get(options.clone(), runtime::string("servername")) {{
        NativeValue::String(value) => value,
        _ => runtime::throw_type_error("scriptc: tls.connect servername must be a string".into()),
    }};
    let reject_unauthorized = match native_value_get(options.clone(), runtime::string("rejectUnauthorized")) {{
        NativeValue::Undefined => true,
        NativeValue::Boolean(value) => value,
        _ => runtime::throw_error_code("scriptc: tls.connect rejectUnauthorized must be boolean".into(), "SC1031"),
    }};
    let ca = match native_value_get(options, runtime::string("ca")) {{
        NativeValue::Undefined => None,
        NativeValue::String(value) => Some(value),
        _ => runtime::throw_error_code("scriptc: tls.connect ca must be a PEM string".into(), "SC1031"),
    }};
    if !matches!(callback, NativeValue::Undefined) && !native_value_is_function(&callback) {{
        runtime::throw_type_error("The callback argument must be of type function".into());
    }}
    let socket = runtime::tls_socket_connect(port, &host, &servername, reject_unauthorized, ca);
    let value = native_net_socket_value(socket.clone());
    if !matches!(callback, NativeValue::Undefined) {{
        let _ = native_net_socket_call(socket, 1, value.clone(), vec![NativeValue::String(runtime::string("secureConnect")), callback]);
    }}
    value
}}

fn native_net_socket_property(value: &NativeValue, key: &runtime::JsString) -> Option<NativeValue> {{
    let NativeValue::Object(object) = value else {{ return None }};
    let socket = object.with(|data| data.entries.iter().find_map(|(_, value)| match value {{
        NativeValue::NetSocketMethod(socket, _) => Some(socket.clone()),
        _ => None,
    }}))?;
    match key.well_formed_utf8()? {{
        "destroyed" => Some(NativeValue::Boolean(runtime::net_socket_destroyed(&socket))),
        "connecting" => Some(NativeValue::Boolean(runtime::net_socket_connecting(&socket))),
        "readable" => Some(NativeValue::Boolean(runtime::net_socket_readable(&socket))),
        "writable" => Some(NativeValue::Boolean(runtime::net_socket_writable(&socket))),
        "timeout" => Some(runtime::net_socket_timeout(&socket).map(NativeValue::Number).unwrap_or(NativeValue::Undefined)),
        "bytesWritten" => Some(NativeValue::Number(runtime::net_socket_bytes_written(&socket))),
        "remoteAddress" => Some(runtime::net_socket_remote_address(&socket).map(NativeValue::String).unwrap_or(NativeValue::Undefined)),
        "authorized" if runtime::tls_socket_encrypted(&socket).is_some() => Some(NativeValue::Boolean(runtime::tls_socket_authorized(&socket))),
        "authorizationError" if runtime::tls_socket_encrypted(&socket).is_some() => Some(runtime::tls_socket_authorization_error(&socket).map(NativeValue::String).unwrap_or(NativeValue::Null)),
        "encrypted" => runtime::tls_socket_encrypted(&socket).map(NativeValue::Boolean),
        _ => None,
    }}
}}

fn native_net_server_value(server: runtime::JsNetServer) -> NativeValue {{
    NativeValue::Object(runtime::Gc::new(NativeMap {{
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("on"), NativeValue::NetServerMethod(server.clone(), 0)),
            (runtime::string("once"), NativeValue::NetServerMethod(server.clone(), 1)),
            (runtime::string("off"), NativeValue::NetServerMethod(server.clone(), 2)),
            (runtime::string("listen"), NativeValue::NetServerMethod(server.clone(), 3)),
            (runtime::string("close"), NativeValue::NetServerMethod(server, 4)),
        ],
        hash_index: NativeHashIndex::default(),
    }}))
}}

fn native_net_server_listener(
    server: &runtime::JsNetServer,
    event: &runtime::JsString,
    callback: NativeValue,
    once: bool,
) {{
    if !native_value_is_function(&callback) {{
        runtime::throw_type_error("The listener argument must be of type function".into());
    }}
    let traced = callback.clone();
    let trace: std::rc::Rc<dyn for<'a> Fn(&mut runtime::Tracer<'a>)> =
        std::rc::Rc::new(move |tracer| traced.trace_native(tracer));
    match event.well_formed_utf8().unwrap_or("") {{
        "connection" => {{
            let target = callback;
            runtime::net_server_on_connection(
                server,
                std::rc::Rc::new(move |socket| {{
                    let _ = native_value_call(
                        target.clone(),
                        vec![native_net_socket_value(socket)],
                        "net.Server connection listener",
                    );
                }}),
                trace,
                once,
            );
        }}
        "request" => native_http_server_on_request(server, callback, trace, once),
        "listening" => {{
            let target = callback;
            runtime::net_server_on_listening(
                server,
                std::rc::Rc::new(move || {{
                    let _ = native_value_call(target.clone(), Vec::new(), "net.Server listening listener");
                }}),
                trace,
                once,
            );
        }}
        "close" => {{
            let target = callback;
            runtime::net_server_on_close(
                server,
                std::rc::Rc::new(move || {{
                    let _ = native_value_call(target.clone(), Vec::new(), "net.Server close listener");
                }}),
                trace,
                once,
            );
        }}
        "error" => {{
            let target = callback;
            runtime::net_server_on_error(
                server,
                std::rc::Rc::new(move |error| {{
                    let value = native_caught(runtime::caught_value(error));
                    let _ = native_value_call(target.clone(), vec![value], "net.Server error listener");
                }}),
                trace,
                once,
            );
        }}
        _ => runtime::throw_error_code(
            format!("scriptc: net.Server event '{{}}' is not ported", event),
            "SC1031",
        ),
    }}
}}

fn native_net_server_call(
    server: runtime::JsNetServer,
    method: u8,
    receiver: NativeValue,
    args: Vec<NativeValue>,
) -> NativeValue {{
    match method {{
        0 | 1 => {{
            let event = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string("undefined"));
            let callback = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            native_net_server_listener(&server, &event, callback, method == 1);
        }}
        2 => {{
            let event = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string("undefined"));
            if event == "error" {{
                runtime::net_server_off_error(&server);
            }} else {{
                runtime::throw_error_code(
                    format!("scriptc: net.Server.off('{{}}') is not ported", event),
                    "SC1031",
                );
            }}
        }}
        3 => {{
            let path = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string("undefined"));
            if let Some(callback) = args.get(1).cloned().filter(native_value_is_function) {{
                native_net_server_listener(&server, &runtime::string("listening"), callback, true);
            }}
            runtime::net_server_listen_path(&server, &path);
        }}
        4 => {{
            if let Some(callback) = args.first().cloned().filter(native_value_is_function) {{
                native_net_server_listener(&server, &runtime::string("close"), callback, true);
            }}
            runtime::net_server_close(&server);
        }}
        5 => return native_http_server_address(&server),
        6 => native_http_server_listen(&server, &args),
        _ => unreachable!("validated net.Server method"),
    }}
    receiver
}}

fn native_bun_connect(
    host: runtime::JsString,
    port: f64,
    open: NativeValue,
    data: NativeValue,
    close: NativeValue,
    error: NativeValue,
    connect_error: NativeValue,
) -> runtime::JsPromise<NativeValue> {{
    let promise = runtime::promise_new();
    let socket = runtime::net_socket_connect_deferred(port, &host);
    let value = native_net_socket_value(socket.clone());
    let connected = std::rc::Rc::new(std::cell::Cell::new(false));

    let connect_value = value.clone();
    let connect_open = open.clone();
    let connect_promise = promise.clone();
    let connect_state = connected.clone();
    let connect_trace = NativeValue::Array(runtime::array_new(vec![
        open,
        value.clone(),
        NativeValue::Promise(promise.clone()),
    ]));
    runtime::net_socket_on_connect(
        &socket,
        std::rc::Rc::new(move || {{
            connect_state.set(true);
            if native_value_is_function(&connect_open) {{
                let _ = native_value_call(
                    connect_open.clone(),
                    vec![connect_value.clone()],
                    "Bun.connect open handler",
                );
            }}
            let _ = runtime::promise_fulfill(&connect_promise, connect_value.clone());
        }}),
        std::rc::Rc::new(move |tracer| connect_trace.trace_native(tracer)),
        true,
    );

    if native_value_is_function(&data) {{
        let data_value = value.clone();
        let data_callback = data.clone();
        let data_trace = NativeValue::Array(runtime::array_new(vec![data, value.clone()]));
        runtime::net_socket_on_data(
            &socket,
            std::rc::Rc::new(move |chunk, _| {{
                let _ = native_value_call(
                    data_callback.clone(),
                    vec![data_value.clone(), NativeValue::ArrayBuffer(chunk)],
                    "Bun.connect data handler",
                );
            }}),
            std::rc::Rc::new(move |tracer| data_trace.trace_native(tracer)),
            false,
        );
    }}
    if native_value_is_function(&close) {{
        let close_value = value.clone();
        let close_callback = close.clone();
        let close_trace = NativeValue::Array(runtime::array_new(vec![close, value.clone()]));
        runtime::net_socket_on_close(
            &socket,
            std::rc::Rc::new(move || {{
                let _ = native_value_call(
                    close_callback.clone(),
                    vec![close_value.clone()],
                    "Bun.connect close handler",
                );
            }}),
            std::rc::Rc::new(move |tracer| close_trace.trace_native(tracer)),
            false,
        );
    }}

    let error_value = value.clone();
    let error_promise = promise.clone();
    let error_state = connected;
    let error_callback = error.clone();
    let connect_error_callback = connect_error.clone();
    let error_trace = NativeValue::Array(runtime::array_new(vec![
        error,
        connect_error,
        value,
        NativeValue::Promise(promise.clone()),
    ]));
    runtime::net_socket_on_error(
        &socket,
        std::rc::Rc::new(move |failure| {{
            let reason = runtime::caught_value(failure.clone());
            let callback = if error_state.get() {{
                error_callback.clone()
            }} else {{
                connect_error_callback.clone()
            }};
            if native_value_is_function(&callback) {{
                let _ = native_value_call(
                    callback,
                    vec![error_value.clone(), native_caught(reason.clone())],
                    "Bun.connect error handler",
                );
            }}
            let _ = runtime::promise_reject(&error_promise, reason);
        }}),
        std::rc::Rc::new(move |tracer| error_trace.trace_native(tracer)),
        false,
    );
    runtime::net_socket_start_connect(&socket);
    promise
}}

fn native_net_socket_call(socket: runtime::JsNetSocket, method: u8, receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue {{
    let owns_socket = match &receiver {{
        NativeValue::Object(object) => object.with(|data| data.entries.iter().any(|(_, value)| matches!(value, NativeValue::NetSocketMethod(candidate, _) if candidate.ptr_eq(&socket)))),
        _ => false,
    }};
    if !owns_socket {{ runtime::throw_error_code("scriptc: borrowed or detached socket methods are not supported yet".into(), "SC1031"); }}
    match method {{
        7 => runtime::tls_socket_protocol(&socket).map(NativeValue::String).unwrap_or(NativeValue::Null),
        8 => match runtime::tls_socket_cipher(&socket) {{
            None => NativeValue::Null,
            Some(None) => NativeValue::Undefined,
            Some(Some(cipher)) => NativeValue::Object(runtime::Gc::new(NativeMap {{
                null_prototype: false,
                symbol_properties: None,
                entries: vec![
                    (runtime::string("name"), NativeValue::String(cipher.name)),
                    (runtime::string("standardName"), NativeValue::String(cipher.standard_name)),
                    (runtime::string("version"), NativeValue::String(cipher.version)),
                ],
                hash_index: NativeHashIndex::default(),
            }})),
        }},
        9 => {{
            if args.first().is_some_and(|value| !matches!(value, NativeValue::Undefined | NativeValue::Boolean(false))) {{
                runtime::throw_error_code("scriptc: detailed TLS certificate chains are not ported".into(), "SC1031");
            }}
            native_tls_peer_certificate(&socket)
        }},
        0 | 1 => {{
            let event = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string("undefined"));
            let callback = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            if !native_value_is_function(&callback) {{
                runtime::throw_type_error("The listener argument must be of type function".into());
            }}
            let once = method == 1;
            match event.well_formed_utf8().unwrap_or("") {{
                "connect" => {{
                    let invoke = callback.clone();
                    let this = receiver.clone();
                    let traced = NativeValue::Array(runtime::array_new(vec![callback.clone(), receiver.clone()]));
                    runtime::net_socket_on_connect(&socket, std::rc::Rc::new(move || {{ let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![], "socket connect listener"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), once);
                }}
                "secureConnect" => {{
                    if runtime::tls_socket_encrypted(&socket).is_none() {{ runtime::throw_error_code("scriptc: secureConnect requires a TLS socket".into(), "SC1031"); }}
                    let invoke = callback.clone();
                    let this = receiver.clone();
                    let traced = NativeValue::Array(runtime::array_new(vec![callback.clone(), receiver.clone()]));
                    runtime::tls_socket_on_secure_connect(&socket, std::rc::Rc::new(move || {{ let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![], "TLS secureConnect listener"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), once);
                }}
                "timeout" => {{
                    let invoke = callback.clone();
                    let this = receiver.clone();
                    let traced = NativeValue::Array(runtime::array_new(vec![callback.clone(), receiver.clone()]));
                    runtime::net_socket_on_timeout(&socket, std::rc::Rc::new(move || {{ let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![], "socket timeout listener"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), once);
                }}
                "data" => {{
                    let invoke = callback.clone();
                    let this = receiver.clone();
                    let traced = NativeValue::Array(runtime::array_new(vec![callback.clone(), receiver.clone()]));
                    runtime::net_socket_on_data(&socket, std::rc::Rc::new(move |chunk, _| {{ let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![{socket_chunk}], "socket data listener"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), once);
                }}
                "end" => {{
                    let invoke = callback.clone();
                    let this = receiver.clone();
                    let traced = NativeValue::Array(runtime::array_new(vec![callback.clone(), receiver.clone()]));
                    runtime::net_socket_on_end(&socket, std::rc::Rc::new(move || {{ let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![], "socket end listener"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), once);
                }}
                "close" => {{
                    let invoke = callback.clone();
                    let this = receiver.clone();
                    let closed_socket = socket.clone();
                    let traced = NativeValue::Array(runtime::array_new(vec![callback.clone(), receiver.clone()]));
                    runtime::net_socket_on_close(&socket, std::rc::Rc::new(move || {{ let had_error = runtime::net_socket_had_error(&closed_socket); let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![NativeValue::Boolean(had_error)], "socket close listener"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), once);
                }}
                "error" => {{
                    let invoke = callback.clone();
                    let this = receiver.clone();
                    let traced = NativeValue::Array(runtime::array_new(vec![callback.clone(), receiver.clone()]));
                    runtime::net_socket_on_error(&socket, std::rc::Rc::new(move |error| {{ let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![native_caught(runtime::caught_value(error))], "socket error listener"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), once);
                }}
                name => runtime::throw_type_error(format!("scriptc: socket event '{{name}}' is not supported")),
            }}
            receiver
        }}
        2 => {{
            match args.first().cloned().unwrap_or(NativeValue::Undefined) {{
                NativeValue::String(value) => runtime::net_socket_write_str(&socket, &value),
                NativeValue::ArrayBuffer(value) => runtime::net_socket_write_bytes(&socket, &value),
                _ => runtime::throw_type_error("socket.write chunk must be a string or byte buffer".into()),
            }}
            NativeValue::Boolean(true)
        }}
        3 => {{ if args.first().is_some_and(|value| !matches!(value, NativeValue::Undefined | NativeValue::Null)) {{ runtime::throw_error_code("scriptc: socket.destroy(error) is not supported yet".into(), "SC1031"); }} runtime::net_socket_destroy(&socket); receiver }}
        4 => {{
            match args.first().cloned() {{
                Some(NativeValue::String(value)) => runtime::net_socket_end_str(&socket, &value),
                Some(NativeValue::ArrayBuffer(value)) => runtime::net_socket_end_bytes(&socket, &value),
                Some(NativeValue::Undefined) | None => runtime::net_socket_end(&socket),
                _ => runtime::throw_type_error("socket.end chunk must be a string or byte buffer".into()),
            }}
            receiver
        }}
        5 => {{
            if args.is_empty() || args.len() > 3 {{ runtime::throw_error_code("scriptc: unsupported socket.connect arguments".into(), "SC1031"); }}
            let port = match &args[0] {{ NativeValue::Number(port) => *port, NativeValue::String(_) => native_compare_number(&args[0]), _ => runtime::throw_type_error_code("The port argument must be a number or string".into(), "ERR_INVALID_ARG_TYPE") }};
            let (host, callback) = match args.get(1) {{
                None | Some(NativeValue::Undefined) => (runtime::string("localhost"), args.get(2).cloned()),
                Some(NativeValue::String(host)) => (host.clone(), args.get(2).cloned()),
                Some(value) if native_value_is_function(value) => (runtime::string("localhost"), Some(value.clone())),
                _ => runtime::throw_error_code("scriptc: unsupported socket.connect host".into(), "SC1031"),
            }};
            if let Some(callback) = callback.filter(|value| !matches!(value, NativeValue::Undefined)) {{
                if !native_value_is_function(&callback) {{ runtime::throw_type_error_code("The listener argument must be of type function".into(), "ERR_INVALID_ARG_TYPE"); }}
                let invoke = callback.clone();
                let this = receiver.clone();
                let traced = NativeValue::Array(runtime::array_new(vec![callback, receiver.clone()]));
                runtime::net_socket_on_connect(&socket, std::rc::Rc::new(move || {{ let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![], "socket connect listener"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), true);
            }}
            let _ = runtime::net_socket_connect_existing(&socket, port, &host);
            receiver
        }}
        6 => {{
            if args.is_empty() || args.len() > 2 {{ runtime::throw_error_code("scriptc: unsupported socket.setTimeout arguments".into(), "SC1031"); }}
            let NativeValue::Number(delay) = args[0] else {{ runtime::throw_type_error_code("The msecs argument must be of type number".into(), "ERR_INVALID_ARG_TYPE") }};
            runtime::net_socket_validate_timeout(delay);
            let callback = args.get(1).cloned().filter(|value| !matches!(value, NativeValue::Undefined));
            if callback.as_ref().is_some_and(|value| !native_value_is_function(value)) {{ runtime::throw_type_error_code("The callback argument must be of type function".into(), "ERR_INVALID_ARG_TYPE"); }}
            if delay == 0.0 && callback.is_some() {{ runtime::throw_error_code("scriptc: disabling a socket timeout with a callback is not supported yet".into(), "SC1031"); }}
            let _ = runtime::net_socket_set_timeout(&socket, delay);
            if delay > 0.0 {{
                if let Some(callback) = callback {{
                    let invoke = callback.clone();
                    let this = receiver.clone();
                    let traced = NativeValue::Array(runtime::array_new(vec![callback, receiver.clone()]));
                    runtime::net_socket_on_timeout(&socket, std::rc::Rc::new(move || {{ let _ = native_value_call_with_this(invoke.clone(), this.clone(), vec![], "socket timeout callback"); }}), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)), true);
                }}
            }}
            receiver
        }}
        _ => unreachable!("validated socket method"),
    }}
}}
"#));
    out.push_str(include_str!("file_write_stream_support.rs"));
    out.push_str("fn native_value_get(value: NativeValue, key: runtime::JsString) -> NativeValue { if let Some(method) = native_emitter_property(&value, &key) { return method; } if native_value_is_sync_generator(&value) { return match key.well_formed_utf8().unwrap_or(\"\") { \"next\" => NativeValue::SyncGeneratorMethod(0), \"return\" => NativeValue::SyncGeneratorMethod(1), \"throw\" => NativeValue::SyncGeneratorMethod(2), _ => native_value_missing_kind(&key, \"Generator\") }; } if matches!(&value, NativeValue::ArrayIterator(_)) { return if key == \"next\" { NativeValue::ArrayIteratorNext } else { native_value_missing_kind(&key, \"Array Iterator\") }; } if matches!(&value, NativeValue::MapValuesIterator(_)) { return if key == \"next\" { NativeValue::MapValuesNext } else { native_value_missing_kind(&key, \"Map Iterator\") }; } if let Some(property) = native_net_socket_property(&value, &key) { return property; } if key == \"raw\" && let Some(Some(raw)) = native_array_own_property(&value, &key) { return raw; } if let NativeValue::NullConstructor(store) = &value { return native_value_get(NativeValue::Object(store.clone()), key); } if let NativeValue::Proxy(proxy) = &value { return native_proxy_get(proxy, NativeValue::String(key.clone()), value.clone()); } if let NativeValue::WeakRef(store) = &value { return if key == \"deref\" { NativeValue::WeakRefMethod(store.clone()) } else { native_value_missing_kind(&key, \"WeakRef\") }; } if let NativeValue::FinalizationRegistry(store) = &value { return match key.well_formed_utf8().unwrap_or(\"\") { \"register\" => NativeValue::FinalizationRegistryMethod(store.clone(), 0), \"unregister\" => NativeValue::FinalizationRegistryMethod(store.clone(), 1), _ => native_value_missing_kind(&key, \"FinalizationRegistry\") }; } if let NativeValue::Readline(id) = &value { return match key.well_formed_utf8().unwrap_or(\"\") { \"question\" => NativeValue::ReadlineMethod(*id, 0), \"close\" => NativeValue::ReadlineMethod(*id, 1), _ => native_value_missing_kind(&key, \"readline.Interface\") }; } if matches!(&value, NativeValue::String(_)) { let method = match key.well_formed_utf8().unwrap_or(\"\") { \"split\" => Some(0), \"startsWith\" => Some(1), \"slice\" => Some(2), \"includes\" => Some(3), \"endsWith\" => Some(4), \"trim\" => Some(5), \"trimStart\" => Some(6), \"trimEnd\" => Some(7), \"toLowerCase\" => Some(8), \"toUpperCase\" => Some(9), \"substring\" => Some(10), \"substr\" => Some(11), \"repeat\" => Some(12), \"charAt\" => Some(13), \"charCodeAt\" => Some(14), \"codePointAt\" => Some(15), \"indexOf\" => Some(16), \"lastIndexOf\" => Some(17), \"localeCompare\" => Some(18), \"isWellFormed\" => Some(19), \"toWellFormed\" => Some(20), \"padStart\" => Some(21), \"padEnd\" => Some(22), \"match\" => Some(23), _ => None }; if let Some(method) = method { return NativeValue::StringMethod(method); } } if native_value_is_array(&value) && !matches!(&value, NativeValue::Array(array) if runtime::array_property_get(array, &key).is_some()) { if let Some(method) = native_array_dyn_method_index(&key) { return NativeValue::ArrayDynMethod(method); } } if (key == \"every\" || key == \"some\") && native_value_is_array(&value) && !matches!(&value, NativeValue::Array(array) if runtime::array_property_get(array, &key).is_some()) { return NativeValue::ArrayPredicateMethod(key == \"every\"); } if key == \"indexOf\" { if let NativeValue::Array(array) = &value { return runtime::array_property_get(array, &key).unwrap_or(NativeValue::ArrayIndexOfMethod); } } if key == \"push\" || key == \"unshift\" { if let Some(method) = native_array_mutation_property(&value, &key) { return method; } } if key == \"map\" { if let Some(method) = native_array_map_property(&value) { return method; } } if key == \"call\" && matches!(&value, NativeValue::ObjectToString | NativeValue::SyncGeneratorMethod(_) | NativeValue::MapValuesNext | NativeValue::ArrayIteratorNext | NativeValue::IteratorIdentity | NativeValue::Bound(_) | NativeValue::ArrayMapMethod | NativeValue::ArrayMutationMethod(_) | NativeValue::ArrayPredicateMethod(_) | NativeValue::ArrayDynMethod(_) | NativeValue::ArrayIndexOfMethod | NativeValue::StringMethod(_)) { return NativeValue::FunctionCall; } if key == \"bind\" && native_value_is_function(&value) { return NativeValue::BindIntrinsic; } if let Some(value) = native_regex_property(&value, &key) { return value; } if let Some(found) = native_getter_read(&value, &key) { return found; } match value { NativeValue::Bound(bound) => { native_function_data_key(&key); native_bound_properties(&bound).with(|data| data.entries.iter().find(|(k,_)| *k == key).map(|(_,v)| v.clone()).unwrap_or(NativeValue::Undefined)) }, NativeValue::Callable(function) => { native_function_data_key(&key); function.with(|function| function.properties.as_ref().expect(\"scriptc: cleared callable properties\").with(|data| data.entries.iter().find(|(k,_)| *k == key).map(|(_,v)| v.clone()).unwrap_or(NativeValue::Undefined))) }, NativeValue::RawJson(raw) => if key == \"rawJSON\" { NativeValue::String(raw.text()) } else { NativeValue::Undefined }, NativeValue::Record(_,object) => native_record_property(&object, &key), NativeValue::Undefined => runtime::throw_type_error(format!(\"Cannot read properties of undefined (reading '{}')\", key)), NativeValue::Null => runtime::throw_type_error(format!(\"Cannot read properties of null (reading '{}')\", key)), NativeValue::ArrayBuffer(bytes) => if key == \"byteLength\" { NativeValue::Number(runtime::bytes_byte_len(&bytes)) } else { native_value_missing_kind(&key, \"ArrayBuffer\") }, NativeValue::WebBytesStream(_) => native_value_missing_kind(&key, \"ReadableStream\"), NativeValue::WebBytesReader(_) => native_value_missing_kind(&key, \"ReadableStreamDefaultReader\"), NativeValue::HttpResponse(response) => native_fetch_response_get(response, &key), NativeValue::Headers(response) => native_headers_get(response, &key), NativeValue::Promise(promise) => native_promise_property(&promise, &key), NativeValue::PromiseConstructor => match key.well_formed_utf8().unwrap_or(\"\") { \"resolve\" => NativeValue::PromiseStaticMethod(0), \"reject\" => NativeValue::PromiseStaticMethod(1), _ => native_value_missing_kind(&key, \"Promise constructor\") }, NativeValue::DiagnosticsChannel(handle) => match key.well_formed_utf8().unwrap_or(\"\") { \"subscribe\" => NativeValue::DiagnosticsChannelMethod(handle, 0), \"unsubscribe\" => NativeValue::DiagnosticsChannelMethod(handle, 1), \"publish\" => NativeValue::DiagnosticsChannelMethod(handle, 2), \"name\" => NativeValue::String(runtime::diagnostics_chan_name::<NativeValue>(handle)), \"hasSubscribers\" => NativeValue::Boolean(runtime::diagnostics_chan_has_subscribers::<NativeValue>(handle)), _ => native_value_missing_kind(&key, \"diagnostics_channel.Channel\") }, NativeValue::Map(map) => { if key == \"size\" { NativeValue::Number(map.with(|m| m.entries.len() as f64)) } else { native_value_missing_kind(&key, \"map\") } }, NativeValue::Object(object) => object.with(|o| o.entries.iter().find(|(k,_)| *k == key).map(|(_,v)| v.clone())).unwrap_or_else(|| native_instance_prototype(&object).map(|prototype| native_prototype_get(prototype, &key, NativeValue::Object(object.clone()))).unwrap_or_else(|| native_value_missing(&key))), NativeValue::Array(array) => { if key == \"length\" { NativeValue::Number(runtime::array_len(&array)) } else if let Some(value) = runtime::array_property_get(&array, &key) { value } else if let Ok(i) = key.parse::<usize>() { if key == i.to_string() && runtime::array_state(&array, i as f64) == 1.0 { runtime::array_get(&array, i as f64) } else { NativeValue::Undefined } } else { native_value_missing_kind(&key, \"array\") } }, NativeValue::String(s) => { if key == \"length\" { NativeValue::Number(s.encode_utf16().count() as f64) } else if let Ok(index) = key.parse::<usize>() { if key == index.to_string() { s.encode_utf16().nth(index).map(|unit| NativeValue::String(runtime::JsString::from_utf16(&[unit]))).unwrap_or(NativeValue::Undefined) } else { NativeValue::Undefined } } else { native_value_missing_kind(&key, \"string\") } },\n");
    out.push_str("NativeValue::SearchParams(params) => match key.well_formed_utf8().unwrap_or(\"\") { \"set\" => NativeValue::SearchParamsMethod(0), \"toString\" => NativeValue::SearchParamsMethod(1), \"append\" => NativeValue::SearchParamsMethod(2), \"get\" => NativeValue::SearchParamsMethod(3), \"has\" => NativeValue::SearchParamsMethod(4), \"delete\" => NativeValue::SearchParamsMethod(5), \"sort\" => NativeValue::SearchParamsMethod(6), \"size\" => NativeValue::Number(runtime::search_params_size(&params)), _ => native_value_missing_kind(&key, \"URLSearchParams\") },\n");
    for (i, t) in types.iter().enumerate() {
        if let Type::Record { shape_id } = t {
            let r = &module.records[*shape_id];
            if record_storage::shared(r, module) {
                continue;
            }
            if let Some(value) = &r.index_value {
                let value = boxed(value, "v.clone()", module);
                writeln!(out, "NativeValue::V{i}(object) => object.with(|o| o.overflow.iter().find(|(k,_)| *k == key).map(|(_,v)| {value}).unwrap_or_else(|| native_value_missing(&key))),").unwrap();
                continue;
            }
            writeln!(
                out,
                "NativeValue::V{i}(object) => object.with(|o| {{ if !key.is_well_formed() {{ return NativeValue::Undefined; }} match key.well_formed_utf8().unwrap_or_else(|| unreachable!(\"ill-formed keys were checked before fixed-field dispatch\")) {{"
            )
            .unwrap();
            for (index, f) in r.fields.iter().enumerate() {
                let stored = format!(
                    "o.{}.clone().map(|v| {}).unwrap_or(NativeValue::Undefined)",
                    field_name(&f.name),
                    boxed(&f.r#type, "v", module)
                );
                let value = if r.tuple {
                    let projected = checked(
                        &f.r#type,
                        &format!("runtime::array_get(source, {}.0)", index),
                        module,
                    );
                    let projected = boxed(&f.r#type, &projected, module);
                    format!("if let Some(source) = &o.source {{ {projected} }} else {{ {stored} }}")
                } else {
                    stored
                };
                writeln!(out, "{:?} => {value},", f.name).unwrap();
            }
            if r.tuple {
                writeln!(
                    out,
                    "\"length\" => NativeValue::Number(o.source.as_ref().map(runtime::array_len).unwrap_or({}.0)),",
                    r.fields.len()
                )
                .unwrap();
            }
            writeln!(out, "_ => native_value_missing(&key) }} }}),").unwrap();
        }
    }
    out.push_str("NativeValue::Url(url) => match key.well_formed_utf8().unwrap_or(\"\") { \"href\" => NativeValue::String(runtime::url_href(&url)), \"origin\" => NativeValue::String(runtime::url_origin(&url)), \"protocol\" => NativeValue::String(runtime::url_protocol(&url)), \"username\" => NativeValue::String(runtime::url_username(&url)), \"password\" => NativeValue::String(runtime::url_password(&url)), \"host\" => NativeValue::String(runtime::url_host(&url)), \"hostname\" => NativeValue::String(runtime::url_hostname(&url)), \"port\" => NativeValue::String(runtime::url_port(&url)), \"pathname\" => NativeValue::String(runtime::url_pathname(&url)), \"search\" => NativeValue::String(runtime::url_search(&url)), \"hash\" => NativeValue::String(runtime::url_hash(&url)), \"searchParams\" => NativeValue::SearchParams(runtime::url_search_params(&url)), _ => native_value_missing_kind(&key, \"URL\") }, NativeValue::Symbol(symbol) => { if key == \"description\" { runtime::symbol_description(&symbol).map(|s| NativeValue::String(s)).unwrap_or(NativeValue::Undefined) } else { native_value_missing_kind(&key, \"symbol\") } }, NativeValue::Regex(_) => native_value_missing_kind(&key, \"regex\"), NativeValue::Date(_) => native_value_missing_kind(&key, \"date\"), NativeValue::Number(_) => native_value_missing_kind(&key, \"number\"),\n");
    for (i, t) in types.iter().enumerate() {
        if matches!(t, Type::Bytes { .. }) {
            let offset = if *t == Type::bytes() {
                "NativeValue::Number(runtime::bytes_byte_offset(&bytes))"
            } else {
                "runtime::throw_type_error(\"scriptc: floating typed array byteOffset is not ported\".into())"
            };
            writeln!(out, "NativeValue::V{i}(bytes) => {{ if !key.is_well_formed() {{ return NativeValue::Undefined; }} if let Ok(index) = key.parse::<usize>() {{ if key == index.to_string() {{ return if (index as f64) < runtime::bytes_len(&bytes) {{ NativeValue::Number(runtime::bytes_get(&bytes, index as f64)) }} else {{ NativeValue::Undefined }}; }} }} match key.well_formed_utf8().unwrap_or_else(|| unreachable!(\"ill-formed keys were checked before fixed-field dispatch\")) {{ \"length\" => NativeValue::Number(runtime::bytes_len(&bytes)), \"byteLength\" => NativeValue::Number(runtime::bytes_byte_len(&bytes)), \"byteOffset\" => {offset}, \"buffer\" => NativeValue::ArrayBuffer(runtime::bytes_array_buffer(&bytes)), \"undefined\" => {{ let owner = runtime::WeakKey::new(&bytes); runtime::weak_map_get::<NativeValue>(&owner, &owner).unwrap_or(NativeValue::Undefined) }}, \"then\" => NativeValue::Undefined, _ => runtime::throw_type_error(\"scriptc: erased typed array member requires a typed receiver\".into()), }} }},").unwrap();
        }
        if matches!(t, Type::Classval { .. }) {
            writeln!(
                out,
                "NativeValue::V{i}(class) => {{ if key == \"name\" {{ return native_class_get(class, &key).unwrap_or_else(|| NativeValue::String(runtime::string(native_class_js_name(class)))); }} native_function_data_key(&key); native_class_get(class, &key).unwrap_or(NativeValue::Undefined) }},"
            )
            .unwrap();
        }
        if matches!(t, Type::Set { .. }) {
            writeln!(out, "NativeValue::V{i}(set) => {{ if key == \"size\" {{ NativeValue::Number(set.storage.with(|set| set.entries.len() as f64)) }} else {{ native_value_missing_kind(&key, \"set\") }} }},").unwrap();
        }
        if matches!(t, Type::Map { .. }) && specialized(t, module) {
            writeln!(
                out,
                "NativeValue::V{i}(map) => if key == \"size\" {{ NativeValue::Number(map.storage.with(|map| map.entries.len() as f64)) }} else {{ native_value_missing_kind(&key, \"map\") }},"
            )
            .unwrap();
        }
    }
    for (i, t) in types.iter().enumerate() {
        if *t == Type::Child {
            writeln!(out, "NativeValue::V{i}(child) => match key.well_formed_utf8().unwrap_or(\"\") {{ \"pid\" => runtime::child_pid(&child).map(NativeValue::Number).unwrap_or(NativeValue::Undefined), \"exitCode\" => runtime::child_exit_code(&child).map(NativeValue::Number).unwrap_or(NativeValue::Null), \"signalCode\" => runtime::child_signal_code(&child).map(NativeValue::String).unwrap_or(NativeValue::Null), \"killed\" => NativeValue::Boolean(runtime::child_killed(&child)), \"kill\" => NativeValue::ChildMethod(child), \"then\" => NativeValue::Undefined, _ => runtime::throw_type_error(\"scriptc: ChildProcess member is not ported\".into()) }},").unwrap();
        }
        if *t == Type::Stats {
            writeln!(out, "NativeValue::V{i}(_) => runtime::throw_type_error(\"scriptc: erased Stats members require a shared native value contract\".into()),").unwrap();
        }
    }
    for (i, t) in types.iter().enumerate() {
        if let Type::Array { elem } = t
            && **elem != Type::Dyn
        {
            let value = boxed(elem, "runtime::array_get(&array, index as f64)", module);
            let property = boxed(elem, "value", module);
            writeln!(out, "NativeValue::V{i}(array) => {{ if key == \"length\" {{ NativeValue::Number(runtime::array_len(&array)) }} else if let Some(value) = runtime::array_property_get(&array, &key) {{ {property} }} else if let Ok(index) = key.parse::<usize>() {{ if key == index.to_string() && runtime::array_state(&array, index as f64) == 1.0 {{ {value} }} else {{ NativeValue::Undefined }} }} else {{ native_value_missing_kind(&key, \"array\") }} }},").unwrap();
        }
    }
    if !module.classes.is_empty() {
        let method_slots = instance_method_slots(module);
        let mut canonical_methods = std::collections::HashMap::new();
        for (slot, (kind, name)) in method_slots.iter().enumerate() {
            if let Some(function) = module.method(&module.classes[*kind].name, name) {
                canonical_methods
                    .entry(function.name.clone())
                    .or_insert(slot);
            }
        }
        out.push_str("NativeValue::Instance(object) => { if let Some(value) = object.with(|o| o.error.as_ref().and_then(|e| e.own.iter().find(|(name,_)| name == &key).map(|(_,v)| v.clone()))) { return value; } if let Some(value) = native_dom_event_property(&object, &key) { return value; } if key == \"constructor\" { let class = object.with(|object| object.class); if let Some(value) = native_class_properties(class).with(|data| data.entries.iter().find(|(name, _)| name == &key).map(|(_, value)| value.clone())) { return value; } return match native_class_layout(class) {\n");
        for (index, class) in module.classes.iter().enumerate() {
            let class_type = Type::Classval {
                class_name: class.name.clone(),
            };
            let value_index = types
                .iter()
                .position(|ty| *ty == class_type)
                .expect("represented class value");
            writeln!(out, "{index} => NativeValue::V{value_index}(class),").unwrap();
        }
        out.push_str("_ => unreachable!(\"validated class layout\"), }; } if !key.is_well_formed() { return NativeValue::Undefined; } let kind = object.with(|o| o.kind); match kind {\n");
        for (i, c) in module.classes.iter().enumerate() {
            writeln!(
                out,
                "{i} => match key.well_formed_utf8().unwrap_or_else(|| unreachable!(\"ill-formed keys were checked before fixed-field dispatch\")) {{"
            )
            .unwrap();
            if c.name.starts_with("native_builtin_Text") {
                out.push_str("\"encoding\" | \"fatal\" | \"ignoreBOM\" => runtime::throw_type_error(\"scriptc: erased codec properties require a typed receiver\".into()),\n");
            }
            if matches!(
                c.name.as_str(),
                "native_builtin_Transform"
                    | "native_builtin_Duplex"
                    | "native_builtin_Readable"
                    | "native_builtin_Writable"
            ) && !c.fields.iter().any(|field| field.name == "destroyed")
            {
                out.push_str("\"destroyed\" => NativeValue::Boolean(object.with(|object| object.stream_destroyed)),\n");
            }
            for f in c.fields.iter().filter(|f| !f.name.starts_with('%')) {
                let field = boxed(
                    &f.r#type,
                    &format!("instance_get_{i}_{}(object.clone())", field_name(&f.name)),
                    module,
                );
                if let Some(slot) = module
                    .method(&c.name, &f.name)
                    .and_then(|function| canonical_methods.get(&function.name))
                {
                    let owner = instance_method_owner(module, i, &f.name);
                    writeln!(out, "{:?} => if object.with(|object| object.own_keys.contains(&key)) {{ {field} }} else {{ NativeValue::InstanceMethod({slot}, native_instance_method_class(object.with(|object| object.class), {owner})) }},", f.name).unwrap();
                    continue;
                }
                writeln!(out, "{:?} => {},", f.name, field).unwrap();
            }
            let mut class = Some(c);
            let mut methods = std::collections::HashSet::new();
            while let Some(current) = class {
                for method in &current.method_names {
                    methods.insert(method);
                }
                class = current.base.as_deref().and_then(|base| module.class(base));
            }
            let mut methods = methods.into_iter().collect::<Vec<_>>();
            methods.sort();
            for method in methods {
                if c.fields.iter().any(|field| field.name == *method) {
                    continue;
                }
                let mut owner = Some(c);
                while let Some(current) = owner {
                    if current.method_names.contains(method) {
                        break;
                    }
                    owner = current.base.as_deref().and_then(|base| module.class(base));
                }
                if let Some(getter) = owner.and_then(|owner| {
                    let name = format!("%{}.get:{method}", owner.name);
                    module
                        .functions
                        .iter()
                        .find(|function| function.name == name)
                }) {
                    let receiver = checked(
                        &getter.params[0].r#type,
                        "NativeValue::Instance(object.clone())",
                        module,
                    );
                    let call = format!("{}({receiver})", function_name(&getter.name));
                    let result = if getter.call_result() == Type::Void {
                        format!("{{ {call}; NativeValue::Undefined }}")
                    } else {
                        boxed(&getter.call_result(), &call, module)
                    };
                    writeln!(out, "{:?} => {result},", method).unwrap();
                    continue;
                }
                // A method belongs to the prototype that declares its
                // implementation, not to each descendant instance kind.
                // Reuse the first slot resolving to that same implementation
                // so inherited reads preserve JavaScript function identity.
                let Some(slot) = module
                    .method(&c.name, method)
                    .and_then(|function| canonical_methods.get(&function.name))
                else {
                    writeln!(out, "{:?} => runtime::throw_type_error(\"scriptc: erased instance method value was not lowered\".into()),", method).unwrap();
                    continue;
                };
                let owner = instance_method_owner(module, i, method);
                writeln!(out, "{:?} => NativeValue::InstanceMethod({slot}, native_instance_method_class(object.with(|object| object.class), {owner})),", method).unwrap();
            }
            if c.name.starts_with("native_boxed_") {
                out.push_str("_ => runtime::throw_type_error(\"scriptc: boxed primitive properties require a native adapter\".into()), },\n");
            } else {
                out.push_str("_ => { let class = object.with(|instance| instance.class); native_class_get(class, &key).unwrap_or_else(|| native_value_missing(&key)) }, },\n");
            }
        }
        out.push_str("_ => unreachable!(\"validated native instance kind\") } },\n");
    }
    out.push_str("_ => native_value_missing(&key) } }\n");
    callable_dispatch_definitions(&types, module, out);
    out.push_str("fn native_util_promisify(target: NativeValue) -> NativeValue { if !native_value_is_function(&target) { runtime::throw_type_error(\"The original argument must be of type function\".into()); } NativeValue::Promisified(Box::new(target)) }\n");
    out.push_str("fn native_value_call(callee: NativeValue, args: Vec<NativeValue>, name: &str) -> NativeValue { native_value_call_with_this(callee, NativeValue::Undefined, args, name) }\nfn native_value_call_with_this(callee: NativeValue, receiver: NativeValue, args: Vec<NativeValue>, name: &str) -> NativeValue { if matches!(&callee, NativeValue::RegexConstructor) { return native_regex_construct(args, false); } if matches!(&callee, NativeValue::LegacyUnescape) { return native_legacy_unescape(args); } if let NativeValue::Promisified(target) = callee.clone() { let promise = runtime::promise_new(); let mut forwarded = args; forwarded.push(NativeValue::PromisifyCallback(promise.clone())); let _ = native_value_call(*target, forwarded, \"promisified function\"); return NativeValue::Promise(promise); } if let NativeValue::PromisifyCallback(promise) = callee.clone() { let error = args.first().cloned().unwrap_or(NativeValue::Undefined); if matches!(error, NativeValue::Undefined | NativeValue::Null) { let value = args.get(1).cloned().unwrap_or(NativeValue::Undefined); let _ = runtime::promise_fulfill(&promise, value); } else { let _ = runtime::promise_reject(&promise, runtime::caught_value(error)); } return NativeValue::Undefined; } if let NativeValue::NetSocketMethod(socket, method) = callee.clone() { return native_net_socket_call(socket, method, receiver, args); } if let NativeValue::NetServerMethod(server, method) = callee.clone() { return native_net_server_call(server, method, receiver, args); } if let NativeValue::HttpServerResponseMethod(response, method) = callee.clone() { return native_http_response_call(response, method, receiver, args); } if let NativeValue::EmitterMethod(owner, method) = callee.clone() { return native_emitter_invoke(&owner, native_emitter_method_name(method), &args).unwrap_or(NativeValue::Undefined); } if let NativeValue::FileHandleMethod(handle, method) = callee.clone() { return native_file_handle_call(handle, method, args); } if let NativeValue::FileWriteStreamMethod(writer, method) = callee.clone() { return native_file_write_stream_call(writer, method, receiver, args); } if let NativeValue::ReadlineMethod(id, method) = callee.clone() { if method == 1 { runtime::readline_close(id); return NativeValue::Undefined; } let query = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string(\"undefined\")); let callback = args.get(1).cloned().unwrap_or(NativeValue::Undefined); if !native_value_is_function(&callback) { runtime::throw_type_error(\"readline.question callback must be a function\".into()); } runtime::readline_question(id, &query, Box::new(move |answer| { let _ = native_value_call(callback, vec![NativeValue::String(answer)], \"readline question callback\"); })); return NativeValue::Undefined; } match callee { NativeValue::SyncGeneratorMethod(method) => native_value_sync_generator_invoke(receiver, method, args), NativeValue::ArrayIteratorNext => match receiver { NativeValue::ArrayIterator(iterator) => match runtime::array_iterator_next_or(&iterator, NativeValue::Undefined) { Some(runtime::ArrayIteratorItem::Value(value)) => native_iterator_result(value, false), Some(runtime::ArrayIteratorItem::Key(key)) => native_iterator_result(NativeValue::Number(key), false), Some(runtime::ArrayIteratorItem::Entry(key, value)) => native_iterator_result(NativeValue::Array(runtime::array_new(vec![NativeValue::Number(key), value])), false), None => native_iterator_result(NativeValue::Undefined, true) }, _ => runtime::throw_type_error(\"Method Array Iterator.prototype.next called on incompatible receiver\".into()) }, NativeValue::MapValuesNext => match receiver { NativeValue::MapValuesIterator(iterator) => native_map_values_next(iterator), _ => runtime::throw_type_error(\"Method Map Iterator.prototype.next called on incompatible receiver\".into()) }, NativeValue::IteratorIdentity => receiver, NativeValue::NullConstructor(_) => NativeValue::Undefined, NativeValue::ArrayIteratorFactory => match receiver { value @ NativeValue::ArrayIterator(_) => value, other => native_array_to_dynamic(&other).map(|array| NativeValue::ArrayIterator(runtime::array_iterator_new(&array, runtime::ArrayIteratorKind::Values))).unwrap_or_else(|| runtime::throw_type_error(\"Symbol.iterator called on unsupported receiver\".into())) }, NativeValue::ArrayMutationMethod(unshift) => native_array_mutation_call(receiver, args, unshift), NativeValue::ArrayPredicateMethod(every) => native_array_predicate(receiver, args, every), NativeValue::ArrayDynMethod(method) => native_array_dyn_call(receiver, args, method), NativeValue::ArrayIndexOfMethod => native_array_index_of(receiver, args), NativeValue::ArrayMapMethod => native_array_map(receiver, args), NativeValue::ArrayJoinMethod => native_array_join(receiver, args), NativeValue::StringMethod(method) => match method { 0 => native_string_split(receiver, args), 1 => native_string_starts_with(receiver, args), 2 => native_string_slice(receiver, args), 3..=22 => native_string_simple(method, receiver, args), 23 => native_string_match(receiver, args), _ => unreachable!(\"validated string method\") }, NativeValue::ObjectToString => native_object_to_string(receiver), NativeValue::FunctionCall => { let this_arg = args.first().cloned().unwrap_or(NativeValue::Undefined); native_value_call_with_this(receiver, this_arg, args.into_iter().skip(1).collect(), name) }, NativeValue::Fetch => native_fetch_call(args), NativeValue::AbortSignalStatic(method) => native_abort_signal_static(method, args), NativeValue::AbortControllerAbort(signal) => { if args.len() > 1 { runtime::throw_type_error(\"AbortController.abort accepts at most one reason\".into()); } let reason = args.first().cloned().unwrap_or(NativeValue::String(runtime::string(\"AbortError\"))); runtime::abort_controller_abort(&signal, reason); NativeValue::Undefined }, NativeValue::BindIntrinsic => native_bind(receiver, args), NativeValue::ArraySpliceMethod => { let NativeValue::Array(array) = receiver else { runtime::throw_type_error(\"Array.prototype.splice called on unsupported receiver\".into()) }; let start = args.first().map(native_compare_number).unwrap_or(0.0); let delete_count = args.get(1).map(native_compare_number).unwrap_or(f64::INFINITY); NativeValue::Array(runtime::array_splice_with_items(&array, start, delete_count, args.into_iter().skip(2).collect())) }, NativeValue::PromiseStaticMethod(method) => { let promise = runtime::promise_new(); let value = args.get(0).cloned().unwrap_or(NativeValue::Undefined); if method == 1 { let _ = runtime::promise_reject(&promise, runtime::caught_value(value)); } else if let NativeValue::Promise(source) = value { let target = promise.clone(); runtime::promise_then(&source, Box::new(move |outcome| match outcome { Ok(value) => { let _ = runtime::promise_fulfill(&target, value); }, Err(reason) => { let _ = runtime::promise_reject(&target, reason); } })); } else { let _ = runtime::promise_fulfill(&promise, value); } NativeValue::Promise(promise) }, NativeValue::PromiseResolve(promise) => { let value = args.get(0).cloned().unwrap_or(NativeValue::Undefined); if let NativeValue::Promise(source) = value { let target = promise.clone(); runtime::promise_then(&source, Box::new(move |outcome| match outcome { Ok(value) => { let _ = runtime::promise_fulfill(&target, value); }, Err(reason) => { let _ = runtime::promise_reject(&target, reason); } })); } else { let _ = runtime::promise_fulfill(&promise, value); } NativeValue::Undefined }, NativeValue::PromiseReject(promise) => { let reason = args.get(0).cloned().unwrap_or(NativeValue::Undefined); let _ = runtime::promise_reject(&promise, runtime::caught_value(reason)); NativeValue::Undefined }, NativeValue::ProcessWrite(fd) => { let value = args.get(0).cloned().unwrap_or(NativeValue::Undefined); let text = match value { NativeValue::String(text) => text, other => native_value_string(other) }; let written = if fd == 1 { runtime::process_stdout_write(&text) } else { runtime::process_stderr_write(&text) }; NativeValue::Boolean(written) }, NativeValue::ProcessStdinMethod(method) => match method { 0 => { let event = args.get(0).cloned().map(native_value_string).unwrap_or_else(|| runtime::string(\"undefined\")); if event != \"data\" { runtime::throw_error_code(\"scriptc: process.stdin only supports the data event\".into(), \"SC1031\"); } native_stdin_on_data(args.get(1).cloned().unwrap_or(NativeValue::Undefined)) }, 1 => { let event = args.get(0).cloned().map(native_value_string).unwrap_or_else(|| runtime::string(\"undefined\")); if event != \"data\" { return native_process_stdin_value(); } native_stdin_remove_data(args.get(1).cloned().unwrap_or(NativeValue::Undefined)) }, 2 => native_stdin_set_raw(matches!(args.first(), Some(NativeValue::Boolean(true)))), 3 => { runtime::stdin_resume(); native_process_stdin_value() }, 4 => { runtime::stdin_pause(); native_process_stdin_value() }, 5 => NativeValue::Boolean(runtime::stdin_is_paused()), _ => unreachable!(\"validated stdin method\") }, NativeValue::Bound(values) => { let target = runtime::array_get(&values, 0.0); let bound_this = runtime::array_get(&values, 1.0); let mut bound_args = (2..runtime::array_len(&values) as usize).map(|index| runtime::array_get(&values, index as f64)).collect::<Vec<_>>(); bound_args.extend(args); native_value_call_with_this(target, bound_this, bound_args, name) },\n");
    out.push_str("NativeValue::TimerMethod(_) => { if matches!(receiver, NativeValue::Undefined | NativeValue::Null) { runtime::throw_type_error(\"Invalid timer method receiver\".into()); } runtime::throw_error_code(\"scriptc: erased timer method receivers are not supported yet\".into(), \"SC1031\") },\n");
    out.push_str("NativeValue::BlobMethod(bytes, method) => { if !args.is_empty() { runtime::throw_type_error(\"Blob method accepts no arguments\".into()); } native_blob_method(bytes, method) },\n");
    out.push_str("NativeValue::WritableMethod(source, method) => native_writable_method(*source, method, args),\n");
    out.push_str("NativeValue::FunctionHasInstance => { let value = args.first().cloned().unwrap_or(NativeValue::Undefined); NativeValue::Boolean(native_value_instanceof(value, receiver)) },\n");
    out.push_str("NativeValue::WeakRefMethod(store) => store.with(|data| data.entries.iter().find(|(key, _)| key == \"target\").map(|(_, value)| value.clone()).unwrap_or(NativeValue::Undefined)),\n");
    out.push_str("NativeValue::FinalizationRegistryMethod(_, method) => match method { 0 => { let target = args.first().cloned().unwrap_or(NativeValue::Undefined); if matches!(&target, NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_) | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::Symbol(_)) { runtime::throw_type_error(\"FinalizationRegistry target must be an object\".into()); } if args.len() < 2 { runtime::throw_type_error(\"FinalizationRegistry.register requires a held value\".into()); } NativeValue::Undefined }, 1 => NativeValue::Boolean(false), _ => unreachable!(\"validated FinalizationRegistry method\") },\n");
    out.push_str("NativeValue::DebugLog(section, enabled) => { if enabled { let message = args.into_iter().map(native_value_inspect).collect::<Vec<_>>().join(\" \"); eprintln!(\"{} {}: {}\", section.to_utf8_lossy().to_ascii_uppercase(), std::process::id(), message); } NativeValue::Undefined },\n");
    out.push_str("NativeValue::DiagnosticsChannelMethod(handle, method) => { let callback = args.first().cloned().unwrap_or(NativeValue::Undefined); match method { 0 => { let identity = native_function_properties(&callback).unwrap_or_else(|| runtime::throw_type_error(\"diagnostics_channel subscriber must be a function\".into())).identity(); runtime::diagnostics_chan_subscribe(handle, identity, callback); NativeValue::Undefined }, 1 => { let identity = native_function_properties(&callback).unwrap_or_else(|| runtime::throw_type_error(\"diagnostics_channel subscriber must be a function\".into())).identity(); NativeValue::Boolean(runtime::diagnostics_chan_unsubscribe::<NativeValue>(handle, identity)) }, 2 => { let message = callback; let (channel_name, subscribers) = runtime::diagnostics_snapshot::<NativeValue>(handle); for subscriber in subscribers { let _ = native_value_call(subscriber, vec![message.clone(), NativeValue::String(channel_name.clone())], \"diagnostics_channel subscriber\"); } NativeValue::Undefined }, _ => unreachable!(\"validated diagnostics_channel method\") } },\n");
    out.push_str("NativeValue::SearchParamsMethod(method) => { let NativeValue::SearchParams(params) = receiver else { runtime::throw_type_error(\"Value of this must be of type URLSearchParams\".into()) }; let arg = |index| args.get(index).cloned().map(native_value_string).unwrap_or_else(|| runtime::string(\"undefined\")); match method { 0 => { runtime::search_params_set(&params, &arg(0), &arg(1)); NativeValue::Undefined }, 1 => NativeValue::String(runtime::search_params_to_string(&params)), 2 => { runtime::search_params_append(&params, &arg(0), &arg(1)); NativeValue::Undefined }, 3 => runtime::search_params_get(&params, &arg(0)).map(NativeValue::String).unwrap_or(NativeValue::Null), 4 => NativeValue::Boolean(runtime::search_params_has(&params, &arg(0))), 5 => { runtime::search_params_delete(&params, &arg(0)); NativeValue::Undefined }, 6 => { runtime::search_params_sort(&params); NativeValue::Undefined }, _ => unreachable!(\"validated URLSearchParams method\") } },\n");
    out.push_str("NativeValue::ChildMethod(child) => { let signal = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string(\"SIGTERM\")); NativeValue::Boolean(runtime::child_kill(&child, &signal)) },\n");
    out.push_str("NativeValue::ChildStreamMethod(stream, method) => native_child_stream_call(stream, method, receiver, args),\n");
    out.push_str("NativeValue::Callable(function) => native_value_call_compiled(function, receiver, args, name),\n");
    for (slot, (kind, method)) in instance_method_slots(module).iter().enumerate() {
        let normal = module
            .method(&module.classes[*kind].name, method)
            .expect("validated instance method target");
        let dynamic_name = format!("{}$dynamic", normal.name);
        let target = module
            .functions
            .iter()
            .find(|function| function.name == dynamic_name)
            .unwrap_or(normal);
        let arguments = target
            .params
            .iter()
            .enumerate()
            .map(|(index, parameter)| {
                if target.rest && index + 1 == target.params.len() {
                    let Type::Array { elem } = &parameter.r#type else {
                        unreachable!("validated method rest parameter")
                    };
                    let item = checked(elem, "item.clone()", module);
                    return format!(
                        "runtime::array_new(args.iter().skip({}).map(|item| {item}).collect())",
                        index - 1
                    );
                }
                let value = if index == 0 {
                    "receiver".to_string()
                } else {
                    format!(
                        "args.get({}).cloned().unwrap_or(NativeValue::Undefined)",
                        index - 1
                    )
                };
                checked(&parameter.r#type, &value, module)
            })
            .collect::<Vec<_>>()
            .join(", ");
        let call = format!("{}({arguments})", function_name(&target.name));
        let return_type = target.call_result();
        let result = if return_type == Type::Void {
            format!("{{ {call}; NativeValue::Undefined }}")
        } else {
            boxed(&return_type, &call, module)
        };
        writeln!(out, "NativeValue::InstanceMethod({slot}, _) => {result},").unwrap();
    }
    for (descriptor_index, descriptor) in module
        .classes
        .iter()
        .flat_map(|class| &class.symbol_methods)
        .filter(|method| method.function.is_some())
        .enumerate()
    {
        let name = descriptor.function.as_deref().unwrap();
        let target = module
            .functions
            .iter()
            .find(|function| function.name == name)
            .expect("validated native class symbol descriptor function");
        let signature = functions::signature(target);
        let Type::Func { params, ret, .. } = &signature else {
            unreachable!("native symbol descriptor callable")
        };
        let receiver = checked(&params[0], "receiver", module);
        let arguments = params
            .iter()
            .skip(1)
            .enumerate()
            .map(|(index, ty)| {
                checked(
                    ty,
                    &format!("args.get({index}).cloned().unwrap_or(NativeValue::Undefined)"),
                    module,
                )
            })
            .collect::<Vec<_>>();
        let mut call_args = vec![receiver];
        call_args.extend(arguments);
        let closure = functions::closure(name, &[], &signature, module);
        let call = format!(
            "call_{}({closure}, {})",
            functions::type_name(&signature, module),
            call_args.join(", ")
        );
        let result = if **ret == Type::Void {
            format!("{{ {call}; NativeValue::Undefined }}")
        } else {
            boxed(ret, &call, module)
        };
        let variant = if descriptor.getter {
            "InstanceSymbolGetter"
        } else {
            "InstanceSymbolMethod"
        };
        writeln!(
            out,
            "NativeValue::{variant}({descriptor_index}) => {result},"
        )
        .unwrap();
    }
    for (i, t) in types.iter().enumerate() {
        if let Type::Classval { class_name } = t {
            let class = module.class(class_name).unwrap();
            writeln!(
                out,
                "NativeValue::V{i}(_) => runtime::throw_type_error({:?}.into()),",
                format!(
                    "Class constructor {} cannot be invoked without 'new'",
                    class.js_name
                )
            )
            .unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(format!(\"{} is not a function\", name)) } }\n");
}

fn async_generator_definitions(types: &[Type], module: &Emission<'_>, out: &mut String) {
    out.push_str(
        "fn native_value_is_sync_generator(value: &NativeValue) -> bool { match value {\n",
    );
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Generator { r#async: false, .. }) {
            writeln!(out, "NativeValue::V{index}(..) => true,").unwrap();
        }
    }
    out.push_str("_ => false, } }\n");
    out.push_str("fn native_value_sync_generator_invoke(value: NativeValue, method: u8, args: Vec<NativeValue>) -> NativeValue { match value {\n");
    for (index, ty) in types.iter().enumerate() {
        let Type::Generator {
            r#async: false,
            yield_type,
            return_type,
            next_type,
        } = ty
        else {
            continue;
        };
        let next = if matches!(**next_type, Type::Void | Type::Undefined) {
            "()".into()
        } else {
            checked(
                next_type,
                "args.first().cloned().unwrap_or(NativeValue::Undefined)",
                module,
            )
        };
        let return_value = if matches!(**return_type, Type::Void | Type::Undefined) {
            "if args.is_empty() { None } else { Some(()) }".into()
        } else {
            format!(
                "args.first().cloned().map(|value| {})",
                checked(return_type, "value", module)
            )
        };
        let yielded = if matches!(**yield_type, Type::Void | Type::Undefined) {
            "{ let _ = value; NativeValue::Undefined }".into()
        } else {
            boxed(yield_type, "value", module)
        };
        let returned = if matches!(**return_type, Type::Void | Type::Undefined) {
            "match value { Some(()) if method == 1 => args.first().cloned().unwrap_or(NativeValue::Undefined), _ => NativeValue::Undefined }".into()
        } else {
            format!(
                "match value {{ Some(value) => {}, None => NativeValue::Undefined }}",
                boxed(return_type, "value", module)
            )
        };
        writeln!(out, "NativeValue::V{index}(generator) => {{ let step = match method {{ 0 => if args.is_empty() {{ runtime::generator_next_without_arg(&generator, {next}) }} else {{ runtime::generator_next(&generator, {next}) }}, 1 => runtime::generator_return(&generator, {return_value}), 2 => runtime::generator_throw(&generator, runtime::caught_value(args.first().cloned().unwrap_or(NativeValue::Undefined))), _ => unreachable!(\"validated generator method\"), }}; match step {{ runtime::GeneratorStep::Yielded(value) => native_iterator_result({yielded}, false), runtime::GeneratorStep::Returned(value) => native_iterator_result({returned}, true), }} }},").unwrap();
    }
    out.push_str("_ => runtime::throw_type_error(\"Generator method called on incompatible receiver\".into()), } }\n");
    out.push_str(
        "fn native_value_is_async_generator(value: &NativeValue) -> bool { match value {\n",
    );
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Generator { r#async: true, .. }) {
            writeln!(out, "NativeValue::V{index}(..) => true,").unwrap();
        }
    }
    out.push_str("_ => false, } }\n");
    out.push_str("fn native_value_async_iterator(value: NativeValue) -> NativeValue { if native_value_is_async_generator(&value) { return value; } let method = native_value_symbol_get(value.clone(), runtime::symbol_well_known(runtime::WellKnownSymbol::AsyncIterator)); native_value_call_with_this(method, value, vec![], \"Symbol.asyncIterator\") }\n");
    out.push_str("fn native_value_async_generator_invoke(value: NativeValue, method: &str, args: Vec<NativeValue>) -> NativeValue { match value {\n");
    for (index, ty) in types.iter().enumerate() {
        let Type::Generator {
            r#async: true,
            yield_type,
            return_type,
            next_type,
        } = ty
        else {
            continue;
        };
        let next_abi = if **next_type == Type::Void {
            &Type::Undefined
        } else {
            next_type
        };
        let return_abi = if **return_type == Type::Void {
            &Type::Undefined
        } else {
            return_type
        };
        let next = checked(
            next_abi,
            "args.first().cloned().unwrap_or(NativeValue::Undefined)",
            module,
        );
        let returned_arg = checked(
            return_abi,
            "args.first().cloned().unwrap_or(NativeValue::Undefined)",
            module,
        );
        let yielded = boxed(yield_type, "value", module);
        let returned = if matches!(**return_type, Type::Void | Type::Undefined) {
            "NativeValue::Undefined".into()
        } else {
            format!(
                "match value {{ Some(value) => {}, None => NativeValue::Undefined }}",
                boxed(return_type, "value", module)
            )
        };
        writeln!(
            out,
            "NativeValue::V{index}(generator) => {{ let source = match method {{ \"next\" => runtime::async_generator_next(&generator, {next}), \"return\" => runtime::async_generator_return(&generator, if args.is_empty() {{ None }} else {{ Some({returned_arg}) }}), _ => runtime::throw_type_error(format!(\"AsyncGenerator.{{}} is not a function\", method)), }}; let result = runtime::promise_new(); let continuation = result.clone(); runtime::promise_then(&source, Box::new(move |outcome| {{ match outcome {{ Ok(step) => {{ let value = match step {{ runtime::AsyncGeneratorStep::Yielded(value) => native_iterator_result({yielded}, false), runtime::AsyncGeneratorStep::Returned(value) => native_iterator_result({returned}, true), }}; let _ = runtime::promise_fulfill(&continuation, value); }}, Err(reason) => {{ let _ = runtime::promise_reject(&continuation, reason); }} }} }})); NativeValue::Promise(result) }},"
        )
        .unwrap();
    }
    out.push_str("_ => runtime::throw_type_error(\"scriptc: async generator invocation requires an async generator\".into()), } }\n");
    out.push_str("fn native_iterator_result(value: NativeValue, done: bool) -> NativeValue { NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"value\"), value), (runtime::string(\"done\"), NativeValue::Boolean(done))], hash_index: NativeHashIndex::default() })) }\n");
}

fn own_key_definitions(types: &[Type], module: &Emission<'_>, out: &mut String) {
    out.push_str("fn native_instance_property_delete(value: &NativeValue, key: &runtime::JsString) -> Option<bool> {\n");
    if module.classes.is_empty() {
        out.push_str("let _ = (value, key); None\n");
    } else {
        out.push_str("let NativeValue::Instance(object) = value else { return None }; if !native_getter_delete(value, key) { return Some(false); } let kind = object.with(|instance| instance.kind); match kind {\n");
        for (index, class) in module.classes.iter().enumerate() {
            writeln!(out, "{index} => match key.well_formed_utf8() {{").unwrap();
            for field in class
                .fields
                .iter()
                .skip(module.class_header_len(class))
                .filter(|field| !field.name.starts_with('%'))
            {
                let rust_name = field_name(&field.name);
                writeln!(out, "Some({:?}) => {{ object.with_mut(|instance| {{ instance.own_keys.retain(|existing| existing != key); match &mut instance.fields {{ NativeInstanceFields::C{index} {{ {rust_name}, .. }} => *{rust_name} = None, _ => unreachable!(\"validated instance kind\"), }} }}); Some(true) }},", field.name).unwrap();
            }
            out.push_str("_ => Some(true), },\n");
        }
        out.push_str("_ => unreachable!(\"validated native instance kind\"), }\n");
    }
    out.push_str("}\n");
    out.push_str("fn native_instance_property_set(value: &NativeValue, key: &runtime::JsString, field: &NativeValue) -> bool {\n");
    if !module.classes.is_empty() {
        out.push_str("let NativeValue::Instance(object) = value else { return false }; if key == \"constructor\" { return native_define_ordinary_data_descriptor(value, key, runtime::DataDescriptor { value: Some(field.clone()), writable: Some(true), enumerable: Some(true), configurable: Some(true) }); } if !key.is_well_formed() { runtime::throw_type_error(\"scriptc: unrepresented instance property write\".into()); } let kind = object.with(|instance| instance.kind); match kind {\n");
        for (index, class) in module.classes.iter().enumerate() {
            writeln!(out, "{index} => match key.well_formed_utf8().unwrap_or_else(|| unreachable!(\"checked property key\")) {{").unwrap();
            for field in class
                .fields
                .iter()
                .filter(|field| !field.name.starts_with('%'))
            {
                let value = checked(&field.r#type, "field.clone()", module);
                writeln!(
                    out,
                    "{:?} => {{ instance_set_{index}_{}(object.clone(), {value}); true }},",
                    field.name,
                    field_name(&field.name)
                )
                .unwrap();
            }
            out.push_str("_ => { if object.with(|instance| instance.error.is_some()) { object.with_mut(|instance| js_data_set(&mut instance.error.as_mut().expect(\"validated Error receiver\").own, key.clone(), field.clone())); true } else { runtime::throw_type_error(\"scriptc: unrepresented instance property write\".into()) } }, },\n");
        }
        out.push_str("_ => unreachable!(\"validated native instance kind\") }\n");
    } else {
        out.push_str("let _ = (value, key, field); false\n");
    }
    out.push_str("}\n");
    out.push_str("fn native_bytes_property_key(value: &NativeValue) -> Option<runtime::WeakKey> { match value {\n");
    for (i, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Bytes { .. }) {
            writeln!(
                out,
                "NativeValue::V{i}(bytes) => Some(runtime::WeakKey::new(bytes)),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => None, } }\n");
    out.push_str("thread_local! { static INSTANCE_METHOD_PROPERTIES: std::cell::RefCell<std::collections::HashMap<(usize, usize), runtime::Gc<NativeRecordData>>> = std::cell::RefCell::new(std::collections::HashMap::new()); }\nfn native_instance_method_properties(slot: usize, class: usize) -> runtime::Gc<NativeRecordData> { INSTANCE_METHOD_PROPERTIES.with(|slots| slots.borrow_mut().entry((slot, class)).or_insert_with(|| runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() })).clone()) }\nfn clear_native_instance_method_properties() { INSTANCE_METHOD_PROPERTIES.with(|slots| slots.borrow_mut().clear()); }\n");
    out.push_str("fn native_function_properties(value: &NativeValue) -> Option<runtime::Gc<NativeRecordData>> { match value { NativeValue::InstanceMethod(slot, class) => Some(native_instance_method_properties(*slot, *class)), NativeValue::Callable(function) => function.with(|function| function.properties.clone()), NativeValue::Bound(bound) => Some(native_bound_properties(bound)), NativeValue::NullConstructor(store) => Some(store.clone()),\n");
    for (i, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Classval { .. }) {
            writeln!(
                out,
                "NativeValue::V{i}(class) => Some(native_class_properties(*class)),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => None, } }\n");
    out.push_str("fn native_value_own_keys(value: &NativeValue) -> Vec<runtime::JsString> { let mut keys = match value { NativeValue::Bound(bound) => native_bound_properties(bound).with(|data| data.entries.iter().map(|(key,_)| key.clone()).collect()), NativeValue::Callable(function) => function.with(|function| function.properties.as_ref().expect(\"scriptc: cleared callable properties\").with(|data| data.entries.iter().map(|(key,_)| key.clone()).collect())), NativeValue::RawJson(_) => vec![runtime::string(\"rawJSON\")], NativeValue::Promise(promise) => runtime::promise_own_keys(promise).into_iter().map(runtime::JsString::from).collect(), NativeValue::Record(_,object) => object.with(|o| o.entries.iter().map(|(k,_)| k.clone()).collect()), NativeValue::Object(object) => object.with(|o| o.entries.iter().map(|(k,_)| k.clone()).collect()), NativeValue::Array(array) => native_array_index_keys(array), NativeValue::ArrayBuffer(_) | NativeValue::Date(_) | NativeValue::Url(_) | NativeValue::HttpResponse(_) | NativeValue::Headers(_) => Vec::new(),\n");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => native_instance_own_keys(object),\n");
    }
    for (i, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Classval { .. }) {
            writeln!(out, "NativeValue::V{i}(class) => native_class_properties(*class).with(|data| data.entries.iter().map(|(key,_)| key.clone()).collect()),").unwrap();
        }
        if matches!(ty, Type::Array { elem } if **elem != Type::Dyn) {
            writeln!(
                out,
                "NativeValue::V{i}(array) => native_array_index_keys(array),"
            )
            .unwrap();
        }
        if matches!(ty, Type::Bytes { .. }) {
            writeln!(out, "NativeValue::V{i}(bytes) => {{ let mut keys = native_index_keys(runtime::bytes_len(bytes) as usize); let owner = runtime::WeakKey::new(bytes); if runtime::weak_map_has::<NativeValue>(&owner, &owner) {{ keys.push(runtime::string(\"undefined\")); }} keys }},").unwrap();
        }
        if let Type::Record { shape_id } = ty {
            let record = &module.records[*shape_id];
            if record_storage::shared(record, module) {
                continue;
            }
            let keys = if record.index_value.is_some() {
                "o.overflow.iter().map(|(k,_)| k.clone()).collect()"
            } else if record.tuple {
                "o.source.as_ref().map(native_array_index_keys).unwrap_or_else(|| o.own_keys.clone())"
            } else {
                "o.own_keys.clone()"
            };
            writeln!(out, "NativeValue::V{i}(object) => object.with(|o| {keys}),").unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"scriptc: own-key reflection requires a native data record\".into()) }; for key in native_getter_own_keys(value) { if !keys.contains(&key) { keys.push(key); } } keys }\n");
    out.push_str("fn native_data_symbol_keys(table: &Option<runtime::DataPropertyTable<NativeValue>>) -> Vec<runtime::JsSymbol> { table.as_ref().map(|table| table.own_keys(false).into_iter().filter_map(|key| match key { runtime::PropertyKey::Symbol(symbol) => Some(symbol), runtime::PropertyKey::String(_) => None }).collect()).unwrap_or_default() }\n");
    out.push_str("fn native_value_own_symbols(value: &NativeValue) -> Vec<runtime::JsSymbol> { if let Some(properties) = native_function_properties(value) { return properties.with(|data| native_data_symbol_keys(&data.symbol_properties)); } match value { NativeValue::Record(_, object) | NativeValue::Object(object) => object.with(|data| native_data_symbol_keys(&data.symbol_properties)),\n");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => object.with(|data| native_data_symbol_keys(&data.symbol_properties)),\n");
    }
    out.push_str("_ => Vec::new(), } }\n");
    out.push_str("fn native_value_own_symbol_property(value: &NativeValue, key: &runtime::JsSymbol) -> Option<runtime::DataProperty<NativeValue>> { if let Some(properties) = native_function_properties(value) { return properties.with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&runtime::PropertyKey::Symbol(key.clone())).cloned())); } match value { NativeValue::Record(_, object) | NativeValue::Object(object) => object.with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&runtime::PropertyKey::Symbol(key.clone())).cloned())),\n");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => object.with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&runtime::PropertyKey::Symbol(key.clone())).cloned())),\n");
    }
    out.push_str("_ => None, } }\n");
    out.push_str("fn native_reflect_own_keys(value: NativeValue) -> runtime::JsArray<NativeValue> { let mut keys = native_value_own_keys(&value); if native_value_is_array(&value) && !keys.iter().any(|key| key == \"length\") { let at = keys.iter().position(|key| key.parse::<u32>().ok().filter(|index| *index != u32::MAX && *key == index.to_string()).is_none()).unwrap_or(keys.len()); keys.insert(at, runtime::string(\"length\")); } if native_array_own_descriptor(&value, &runtime::string(\"raw\")).is_some() && !keys.iter().any(|key| key == \"raw\") { keys.push(runtime::string(\"raw\")); } keys.sort_by_key(|key| key.parse::<u32>().ok().filter(|index| *index != u32::MAX && *key == index.to_string()).map(|index| (0, index)).unwrap_or((1, 0))); let mut result = keys.into_iter().map(NativeValue::String).collect::<Vec<_>>(); result.extend(native_value_own_symbols(&value).into_iter().map(NativeValue::Symbol)); runtime::array_new(result) }\n");
    out.push_str(include_str!("value_properties_support.rs"));
    out.push_str(include_str!("value_presence_support.rs"));
    if !module.classes.is_empty() {
        out.push_str("fn native_instance_has_method(object: &runtime::Gc<NativeInstance>, key: &runtime::JsString) -> bool { let Some(key) = key.well_formed_utf8() else { return false; }; match object.with(|object| object.kind) {\n");
        for (index, class) in module.classes.iter().enumerate() {
            let mut names = std::collections::BTreeSet::new();
            let mut current = Some(class);
            while let Some(owner) = current {
                names.extend(owner.method_names.iter().cloned());
                current = owner.base.as_deref().and_then(|base| module.class(base));
            }
            let pattern = names
                .into_iter()
                .map(|name| format!("{name:?}"))
                .collect::<Vec<_>>()
                .join(" | ");
            if pattern.is_empty() {
                writeln!(out, "{index} => false,").unwrap();
            } else {
                writeln!(out, "{index} => matches!(key, {pattern}),").unwrap();
            }
        }
        out.push_str("_ => false, } }\n");
    }
    // Indexed records retain their own storage layout. Membership reads its
    // live overflow keys without narrowing or reading a possibly absent value.
    out.push_str("fn native_value_has_key(value: NativeValue, key: runtime::JsString) -> bool { if native_value_is_sync_generator(&value) { return matches!(key.well_formed_utf8(), Some(\"next\" | \"return\" | \"throw\")) || native_object_prototype_has_key(&key); } match &value { NativeValue::ArrayIterator(_) => key == \"next\" || native_object_prototype_has_key(&key), NativeValue::MapValuesIterator(_) => key == \"next\" || native_object_prototype_has_key(&key), NativeValue::Object(object) | NativeValue::Record(_, object) => native_value_has_own(value.clone(), key.clone()) || native_instance_prototype(object).is_some_and(|prototype| native_value_has_key(prototype, key.clone())) || (!object.with(|data| data.null_prototype) && native_object_prototype_has_key(&key)), NativeValue::RawJson(_) => key == \"rawJSON\", NativeValue::Url(_) => matches!(key.well_formed_utf8(), Some(\"href\" | \"origin\" | \"protocol\" | \"username\" | \"password\" | \"host\" | \"hostname\" | \"port\" | \"pathname\" | \"search\" | \"hash\")),\n");
    if !module.classes.is_empty() {
        out.push_str("NativeValue::Instance(object) => native_value_has_own(value.clone(), key.clone()) || native_instance_has_method(object, &key) || object.with(|data| native_class_get(data.class, &key).is_some()) || native_object_prototype_has_key(&key),\n");
    }
    for (i, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Classval { .. }) {
            writeln!(out, "NativeValue::V{i}(class) => {{ native_function_data_key(&key); native_class_get(*class, &key).is_some() }},").unwrap();
        }
        if let Type::Record { shape_id } = ty
            && !module.records[*shape_id].tuple
            && !record_storage::shared(&module.records[*shape_id], module)
        {
            writeln!(out, "NativeValue::V{i}(..) => native_value_has_own(value.clone(), key.clone()) || native_object_prototype_has_key(&key),").unwrap();
        }
        if let Type::Bytes { elem } = ty {
            let buffer = if elem == "u8" {
                "runtime::bytes_is_buffer(bytes)"
            } else {
                "false"
            };
            writeln!(out, "NativeValue::V{i}(bytes) => native_value_has_own(value.clone(), key.clone()) || native_bytes_prototype_has_key(&key, {buffer}),").unwrap();
        }
    }
    out.push_str("_ => runtime::throw_type_error(\"scriptc: in operator requires a native data record; exotic prototype presence is not ported\".into()) } }\n");
    // Stable sorting leaves non-index string keys in insertion order. 2^32-1
    // and noncanonical numeric spellings are ordinary string keys.
    // ToObject/enumerability belongs to Object.keys, not the internal own-key
    // reader shared with hasOwn, JSON and process environment validation.
    out.push_str("fn native_value_keys(value: NativeValue) -> NativeValue { let mut keys = match &value { NativeValue::Undefined | NativeValue::Null => runtime::throw_type_error(\"Cannot convert undefined or null to object\".into()), NativeValue::BigInt(_) | NativeValue::Number(_) | NativeValue::Boolean(_) | NativeValue::Symbol(_) => Vec::new(), NativeValue::String(text) => native_index_keys(text.encode_utf16().count()), NativeValue::Array(array) => native_array_index_keys(array),\n");
    for (index, ty) in types.iter().enumerate() {
        let keys = match ty {
            Type::Array { elem } if **elem != Type::Dyn => "native_array_index_keys(value)",
            _ => continue,
        };
        writeln!(out, "NativeValue::V{index}(value) => {keys},").unwrap();
    }
    out.push_str("_ => native_value_own_keys(&value) }; keys.retain(|key| native_getter_enumerable(&value, key)); keys.sort_by_key(|key| key.parse::<u32>().ok().filter(|i| *i != u32::MAX && *key == i.to_string()).map(|i| (0, i)).unwrap_or((1, 0))); NativeValue::Array(runtime::array_new(keys.into_iter().map(NativeValue::String).collect())) }\n");
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    Some(match value {
        Expr::LibCall { r#fn, args, .. } if r#fn == "sqlite.open.node" => format!(
            "native_node_sqlite_open({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "sqlite.statementRun" => format!(
            "native_sqlite_run({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "sqlite.statementAll" => format!(
            "native_sqlite_rows({}, {}, 0)",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "sqlite.statementGet" => format!(
            "native_sqlite_rows({}, {}, 1)",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "sqlite.statementIterate" => format!(
            "native_sqlite_rows({}, {}, 0)",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn.starts_with("class.symbolDefine:") => {
            let name = r#fn.trim_start_matches("class.symbolDefine:");
            let descriptor = module
                .classes
                .iter()
                .flat_map(|class| &class.symbol_methods)
                .filter(|method| method.function.is_some())
                .enumerate()
                .find(|(_, method)| method.function.as_deref() == Some(name))
                .expect("validated native class symbol descriptor");
            let variant = if descriptor.1.getter {
                "InstanceSymbolGetter"
            } else {
                "InstanceSymbolMethod"
            };
            format!(
                "native_class_symbol_define({}, {}, NativeValue::{variant}({}))",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                descriptor.0,
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "class.setParent" => format!(
            "native_class_set_parent({}, {})",
            expr(&args[0], function, module), expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "class.staticSymbolDefine" => {
            format!(
                "native_class_static_symbol_define({}, {}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "fetch.responseFromStream" => format!(
            "{{ let stream = {}; match stream {{ NativeValue::WebBytesStream(stream) => NativeValue::HttpResponse(runtime::fetch_response_new_stream(&stream, |bytes| bytes)), _ => runtime::throw_type_error(\"Response body must be a native ReadableStream of bytes\".into()), }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "fetch.responseNew" => format!(
            "native_response_new({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "fetch.headersNew" => {
            format!("native_headers_new({})", expr(&args[0], function, module))
        }
        Expr::LibCall { r#fn, .. } if r#fn == "web.transformStreamNew" => {
            "native_transform_stream_new()".into()
        }
        Expr::LibCall { r#fn, .. } if r#fn == "web.textDecoderStreamNew" => {
            "NativeValue::TextDecoderStream(runtime::text_decoder_new())".into()
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "web.readableStreamNew" => {
            format!(
                "native_readable_stream_new({})",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "util.isDeepStrictEqual" => format!(
            "native_deep_strict_equal({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "util.promisify" => format!(
            "native_util_promisify({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. }
            if matches!(
                r#fn.as_str(),
                "utilTypes.isArrayBuffer" | "utilTypes.isAnyArrayBuffer"
            ) =>
        {
            format!(
                "matches!(&({}), NativeValue::ArrayBuffer(_))",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. }
            if matches!(
                r#fn.as_str(),
                "utilTypes.isTypedArray" | "utilTypes.isArrayBufferView"
            ) =>
        {
            format!(
                "native_value_is_typed_array(&({}))",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "utilTypes.isUint8Array" => format!(
            "native_value_is_u8_array(&({}))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "arrayBuffer.isView" => format!(
            "native_value_is_typed_array(&({}))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "arrayBuffer.u8View" => format!(
            "{{ let value = {}; match value {{ NativeValue::ArrayBuffer(bytes) => runtime::data_view_new(&bytes, {}, {}, {}), _ => runtime::throw_type_error(\"First argument to Uint8Array must be an ArrayBuffer\".into()), }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "stream.pipeline" => format!(
            "native_stream_pipeline({}, {}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "stream.isDisturbed" => format!(
            "{{ let value = {}; match value {{ NativeValue::WebBytesStream(stream) => runtime::web_stream_disturbed(&stream), _ => false, }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "stream.isErrored" => format!(
            "{{ let value = {}; match value {{ NativeValue::WebBytesStream(stream) => runtime::web_stream_errored(&stream), _ => false, }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "stream.isReadable" => format!(
            "{{ let value = {}; match value {{ NativeValue::WebBytesStream(stream) => NativeValue::Boolean(runtime::web_stream_readable(&stream)), _ => NativeValue::Null, }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "stream.isDestroyed" => format!(
            "{{ let _ = {}; NativeValue::Null }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "events.getMaxListeners" => format!(
            "{{ let value = {}; match value {{ NativeValue::AbortSignal(signal) | NativeValue::AbortControllerAbort(signal) => runtime::abort_signal_max_listeners(&signal), _ => runtime::throw_type_error(\"events.getMaxListeners target must be an AbortSignal\".into()), }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "events.setMaxListeners" => format!(
            "{{ let limit = {}; let value = {}; if !limit.is_finite() || limit < 0.0 {{ runtime::throw_range_error(\"The value of n is out of range\".into()); }} match value {{ NativeValue::AbortSignal(signal) | NativeValue::AbortControllerAbort(signal) => runtime::abort_signal_set_max_listeners(&signal, limit), _ => runtime::throw_type_error(\"events.setMaxListeners target must be an AbortSignal\".into()), }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, .. } if r#fn == "events.defaultMaxListeners" => "10.0".into(),
        Expr::LibCall { r#fn, args, .. } if r#fn == "assert.ok" => format!(
            "{{ let value = {}; let message = {}; runtime::assert_ok(native_value_test(&value, \"truthy\"), &message); }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "utilTypes.isProxy" => format!(
            "matches!(&({}), NativeValue::Proxy(_))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "utilTypes.isPromise" => format!(
            "matches!(&({}), NativeValue::Promise(_))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "utilTypes.isDataView" => format!(
            "native_value_is_data_view(&({}))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "utilTypes.isSharedArrayBuffer" => {
            format!("{{ let _ = {}; false }}", expr(&args[0], function, module))
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.proxyNew" => format!(
            "native_proxy_new({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.reflectGet" => format!(
            "native_reflect_get({}, {}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.reflectSet" => format!(
            "native_reflect_set({}, {}, {}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.reflectApply" => format!(
            "{{ let target = {}; let receiver = {}; let arguments = {}; native_value_call_with_this(target, receiver, native_value_apply_arguments(&arguments), \"Reflect.apply\") }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.classLayoutIs" => format!(
            "{{ let value = {}; let expected = {}; match (native_value_class(&value), native_value_class(&expected)) {{ (Some(value), Some(expected)) => native_class_layout(value) == native_class_layout(expected), _ => false }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.constructCallable" => format!(
            "native_construct_callable({}, vec![{}])",
            expr(&args[0], function, module),
            args.iter()
                .skip(1)
                .map(|argument| expr(argument, function, module))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.reflectOwnKeys" => format!(
            "native_reflect_own_keys({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.objectOwnSymbols" => format!(
            "runtime::array_new(native_value_own_symbols(&({})))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.objectOwnNames" => format!(
            "{{ let value = {}; let mut keys = native_value_own_keys(&value); if native_value_is_array(&value) && !keys.iter().any(|key| key == \"length\") {{ keys.push(runtime::string(\"length\")); }} keys.sort_by_key(|key| key.parse::<u32>().ok().filter(|index| *index != u32::MAX && *key == index.to_string()).map(|index| (0, index)).unwrap_or((1, 0))); runtime::array_new(keys) }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "promise.construct" => {
            let executor = boxed(&args[0].ty(), &expr(&args[0], function, module), module);
            format!(
                "{{ let promise = runtime::promise_new(); let executor = {executor}; let _ = native_value_call(executor, vec![NativeValue::PromiseResolve(promise.clone()), NativeValue::PromiseReject(promise.clone())], \"Promise executor\"); promise }}"
            )
        }
        Expr::DynIterN { value, count, .. } => format!(
            "native_value_iter_n({}, {count})",
            expr(value, function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "date.newValue" => format!(
            "NativeValue::Date(runtime::date_value_new({}))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "date.newDynamic" => format!(
            "{{ let value = {}; match value {{ NativeValue::Number(value) => NativeValue::Date(runtime::date_value_new(value)), NativeValue::String(value) => NativeValue::Date(runtime::date_value_new(runtime::date_parse_get_time(&value))), NativeValue::Date(value) => NativeValue::Date(runtime::date_value_copy(&value)), NativeValue::Boolean(value) => NativeValue::Date(runtime::date_value_new(if value {{ 1.0 }} else {{ 0.0 }})), NativeValue::Null => NativeValue::Date(runtime::date_value_new(0.0)), NativeValue::Undefined => NativeValue::Date(runtime::date_value_new(f64::NAN)), NativeValue::BigInt(_) | NativeValue::Symbol(_) => runtime::throw_type_error(\"Cannot convert value to a Date\".into()), _ => runtime::throw_type_error(\"scriptc: Date object conversion requires native ToPrimitive support\".into()), }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "date.valueTime" => format!(
            "{{ let value = {}; match value {{ NativeValue::Date(value) => runtime::date_value_time(&value), _ => runtime::throw_type_error(\"Date numeric conversion requires a Date value\".into()), }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, .. } if r#fn == "map.constructorValue" => {
            "NativeValue::MapConstructor".into()
        }
        Expr::LibCall { r#fn, .. } if r#fn == "promise.constructorValue" => {
            "NativeValue::PromiseConstructor".into()
        }
        Expr::LibCall { r#fn, .. } if r#fn == "regex.constructorValue" => {
            "NativeValue::RegexConstructor".into()
        }
        Expr::LibCall { r#fn, .. } if r#fn == "regex.globalValue" => {
            "native_global_regex_value()".into()
        }
        Expr::LibCall { r#fn, .. } if r#fn == "legacy.unescapeGlobal" => {
            "native_global_unescape_value()".into()
        }
        Expr::LibCall { r#fn, .. } if r#fn == "legacy.requireUnescape" => {
            "if !matches!(native_global_unescape_value(), NativeValue::LegacyUnescape) { runtime::throw_error_code(\"scriptc SC1031: reassigned unescape function is not ported\".into(), \"SC1031\"); }".into()
        }
        Expr::LibCall { r#fn, .. } if r#fn == "regex.requireGlobal" => {
            "if !matches!(native_global_regex_value(), NativeValue::RegexConstructor) { runtime::throw_error_code(\"scriptc SC1031: reassigned RegExp constructor is not ported\".into(), \"SC1031\"); }".into()
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "regex.constructDynamic" => format!(
            "native_regex_construct(vec![{}], true)",
            args.iter()
                .map(|arg| expr(arg, function, module))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Expr::LibCall { r#fn, .. } if r#fn == "array.spliceMethodValue" => {
            "NativeValue::ArraySpliceMethod".into()
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.objectRestCheck" => format!(
            "{{ let value = {}; if native_getter_has_any(&value) {{ runtime::throw_error_code(\"scriptc SC1031: object rest with accessors is not ported\".into(), \"SC1031\"); }} match value {{ NativeValue::Object(_) | NativeValue::Record(..) => (), _ => runtime::throw_error_code(\"scriptc SC1031: checked-dynamic object rest requires an ordinary object without descriptor-defined properties\".into(), \"SC1031\"), }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.freezeValue" => format!(
            "native_freeze_value({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.isFrozenValue" => format!(
            "native_is_frozen_value({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.sameValue" => format!(
            "{{ let left = {}; let right = {}; match (&left, &right) {{ (NativeValue::Number(left), NativeValue::Number(right)) => runtime::number_same_value(*left, *right), _ => native_value_eq(&left, &right), }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "template.object" => {
            let Expr::StrLit { value: site, .. } = &args[0] else {
                unreachable!("IR validated");
            };
            format!(
                "{{ let cooked = {}; let raw = {}; runtime::template_object_storage({site:?}, runtime::array_values(&cooked), runtime::array_values(&raw)) }}",
                expr(&args[1], function, module),
                expr(&args[2], function, module),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.objectAssignSourceCheck" => format!(
            "{{ let value = {}; if native_getter_has_any(&value) {{ runtime::throw_error_code(\"scriptc SC1031: Object.assign with accessors is not ported\".into(), \"SC1031\"); }} if let NativeValue::Object(object) | NativeValue::Record(_, object) = value {{ if object.with(|data| data.symbol_properties.as_ref().is_some_and(|table| !table.own_keys(true).is_empty())) {{ runtime::throw_error_code(\"scriptc SC1031: copying enumerable symbol properties is not ported\".into(), \"SC1031\"); }} }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.copyEnumerableSymbols" => format!(
            "native_copy_enumerable_symbols({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.objectAssignCopy" => format!(
            "native_object_assign_copy({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.hasSymbolKey" => format!(
            "native_value_has_symbol_key({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.defineOrdinaryData" => format!(
            "{{ let target = {}; let key = {}; let descriptor = {}; native_define_ordinary_data(target, key, descriptor) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.defineProperties" => format!(
            "native_define_properties({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.getOwnPropertyDescriptor" => format!(
            "native_own_property_descriptor({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.defineOrdinaryGetter" => format!(
            "{{ let target = {}; let key = {}; let getter = {}; let enumerable = {}; let configurable = {}; native_define_ordinary_getter(target, key, getter, enumerable, configurable) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module),
            expr(&args[4], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.defineOrdinarySetter" => format!(
            "{{ let target = {}; let key = {}; let setter = {}; let enumerable = {}; let configurable = {}; native_define_ordinary_setter(target, key, setter, enumerable, configurable) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module),
            expr(&args[4], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.defineOrdinaryAccessor" => format!(
            "{{ let target = {}; let key = {}; let getter = {}; let setter = {}; let enumerable = {}; let configurable = {}; native_define_ordinary_accessor(target, key, getter, setter, enumerable, configurable) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module),
            expr(&args[4], function, module),
            expr(&args[5], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.mapKeysImmediate" => format!(
            "native_map_keys_immediate({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.arrayIteratorFirstResult" => format!(
            "native_array_iterator_first_result({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.arrayIteratorNextResult" => format!(
            "native_array_iterator_next_result({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.typedArrayNumericIndex" => format!(
            "{{ let value = {}; match value {{ NativeValue::Number(value) => value, NativeValue::BigInt(value) => runtime::bigint_to_number(&value), NativeValue::String(text) => {{ if text == \"-0\" {{ f64::NAN }} else {{ let value = runtime::number_from_string(&text); if runtime::number_to_string(value) == text {{ value }} else {{ f64::NAN }} }} }}, _ => runtime::throw_type_error(\"scriptc: dynamic numeric index invariant failed\".into()), }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.compare" => format!(
            "{{ let left = {}; let right = {}; native_value_compare(left, right) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.stringConstructor" => format!(
            "{{ let value = {}; match value {{ NativeValue::Symbol(symbol) => runtime::symbol_to_string(&symbol), other => native_value_string(other), }} }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "record.setOwn" => format!(
            "native_record_plan_set({}, {}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, .. } if r#fn == "record.view" || r#fn == "record.checkedView" => {
            record_storage::view(value, function, module)
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "record.mutableDynView" => {
            boxed(&args[0].ty(), &expr(&args[0], function, module), module)
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "record.opaqueOwnValue" => {
            boxed(&args[0].ty(), &expr(&args[0], function, module), module)
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "callable.opaqueViewSource" => {
            boxed(&args[0].ty(), &expr(&args[0], function, module), module)
        }
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "array.view" => {
            let Type::Array { elem: source } = args[0].ty() else {
                unreachable!("IR validated")
            };
            let Type::Array { elem: target } = r#type else {
                unreachable!("IR validated")
            };
            let read = checked(target, &boxed(&source, "value", module), module);
            let write = checked(&source, &boxed(target, "value", module), module);
            let source_type = rust_type((*source).clone(), module);
            let target_type = rust_type((**target).clone(), module);
            format!(
                "{{ let array = {}; runtime::array_mapped_source::<{target_type}, {source_type}>(&array).unwrap_or_else(|| runtime::array_mapped(array, |value| {read}, |value| {write})) }}",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "array.generator" => {
            let source = expr(&args[0], function, module);
            if matches!(args[0].ty(), Type::Array { elem } if *elem == Type::Dyn) {
                format!("runtime::generator_from_array_or({source}, NativeValue::Undefined)")
            } else {
                format!("runtime::generator_from_array({source})")
            }
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "array.fromTyped" => format!(
            "native_array_from_typed({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, .. } if r#fn == "abort.controllerNew" => {
            "native_abort_controller_new()".into()
        }
        Expr::LibCall {
            r#fn,
            args,
            r#type: Type::Record { shape_id },
            ..
        } if r#fn == "callable.view" => {
            let boxed = boxed(&args[0].ty(), "function.clone()", module);
            let tags = crate::ir::record_equivalence::record_representatives(
                &module.records,
                &module.unions,
            );
            format!(
                "{{ let function = {}; let boxed = {boxed}; let store = native_function_properties(&boxed).expect(\"callable view property store\"); native_callable_attach(store, boxed, {}) }}",
                expr(&args[0], function, module),
                tags[*shape_id]
            )
        }
        Expr::LibCall {
            r#fn,
            args,
            r#type: Type::Record { shape_id },
            ..
        } if r#fn == "record.fromOwn" => format!(
            "record_from_own_{shape_id}({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall {
            r#fn,
            args,
            r#type: Type::Record { shape_id },
            ..
        } if r#fn == "record.cloneOwn" => format!(
            "record_clone_own_{shape_id}({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.hasOwn" => format!(
            "native_value_has_own({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.hasOwnKey" => format!(
            "native_value_has_own_key({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.hasKey" => format!(
            "native_value_has_key({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.objKeys" => {
            format!("native_value_keys({})", expr(&args[0], function, module))
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.fromEntries" => match args[0].ty() {
            Type::Array { elem } => {
                let pair = box_value(&elem, "runtime::array_get(&entries, index as f64)", module);
                format!(
                    "{{ let entries = {}; let object = runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }}); for index in 0..runtime::array_len(&entries) as usize {{ let pair = {pair}; if !matches!(&pair, NativeValue::Array(_) | NativeValue::Object(_) | NativeValue::Record(..)) {{ runtime::throw_type_error(\"Iterator value is not an entry object\".into()); }} let key = native_value_string(native_value_get(pair.clone(), runtime::string(\"0\"))); let value = native_value_get(pair, runtime::string(\"1\")); object.with_mut(|data| js_data_set(&mut data.entries, key, value)); }} NativeValue::Object(object) }}",
                    expr(&args[0], function, module)
                )
            }
            Type::Map { key, .. } if *key == Type::String => {
                // Typed Maps are views over owning NativeValue storage whose
                // entries were already boxed by the view's `write`; copy those
                // owning values in insertion order.
                format!(
                    "{{ let entries = {}; let object = runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }}); let storage: &runtime::Gc<NativeMap<runtime::JsString, NativeValue>> = &entries.storage; storage.with(|entries| {{ for (key, value) in &entries.entries {{ let value = value.clone(); object.with_mut(|data| js_data_set(&mut data.entries, key.clone(), value)); }} }}); NativeValue::Object(object) }}",
                    expr(&args[0], function, module)
                )
            }
            _ => unreachable!("validated Object.fromEntries"),
        },
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.fromSearchParams" => format!(
            "{{ let value = {}; let NativeValue::SearchParams(params) = value else {{ runtime::throw_type_error(\"Object.fromEntries requires URLSearchParams\".into()) }}; let object = runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }}); for index in 0..runtime::search_params_size(&params) as usize {{ let key = runtime::search_params_key_at(&params, index as f64); let value = NativeValue::String(runtime::search_params_value_at(&params, index as f64)); object.with_mut(|data| js_data_set(&mut data.entries, key, value)); }} NativeValue::Object(object) }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.fromHeaders" => format!(
            "{{ let value = {}; let NativeValue::Headers(headers) = value else {{ runtime::throw_type_error(\"Object.fromEntries requires Headers\".into()) }}; let object = runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }}); let mut entries = runtime::http_request_headers(&headers); entries.sort_by(|(left, _), (right, _)| left.cmp(right)); for (key, value) in entries {{ object.with_mut(|data| js_data_set(&mut data.entries, key, NativeValue::String(value))); }} NativeValue::Object(object) }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "array.pushApplyDynamic" => format!(
            "native_array_push_apply({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.callSpread" => format!(
            "{{ let callee = {}; let values = {}; let arguments = (0..runtime::array_len(&values) as usize).map(|index| runtime::array_get(&values, index as f64)).collect(); native_value_call(callee, arguments, \"dynamic spread call\") }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.callWithThisSpread" => format!(
            "{{ let callee = {}; let receiver = {}; let values = {}; let arguments = (0..runtime::array_len(&values) as usize).map(|index| runtime::array_get(&values, index as f64)).collect(); native_value_call_with_this(callee, receiver, arguments, \"dynamic spread method\") }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.invokeSpread" => format!(
            "{{ let receiver = {}; let method = {}; let values = {}; let callee = native_value_get(receiver.clone(), method.clone()); let arguments = (0..runtime::array_len(&values) as usize).map(|index| runtime::array_get(&values, index as f64)).collect(); native_value_call_with_this(callee, receiver, arguments, method.to_utf8_lossy()) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "url.newValue" => format!(
            "NativeValue::Url(runtime::url_new(&({})))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, .. } if r#fn == "searchParams.newValue" => {
            "NativeValue::SearchParams(runtime::search_params_new())".into()
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "searchParams.parseValue" => format!(
            "NativeValue::SearchParams(runtime::search_params_parse(&({})))",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "searchParams.keysArray" => format!(
            "{{ let NativeValue::SearchParams(params) = {} else {{ runtime::throw_type_error(\"Value of this must be of type URLSearchParams\".into()) }}; runtime::search_params_keys(&params) }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "searchParams.valuesArray" => format!(
            "{{ let NativeValue::SearchParams(params) = {} else {{ runtime::throw_type_error(\"Value of this must be of type URLSearchParams\".into()) }}; runtime::array_new((0..runtime::search_params_size(&params) as usize).map(|index| runtime::search_params_value_at(&params, index as f64)).collect()) }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "searchParams.entriesArray" => format!(
            "{{ let NativeValue::SearchParams(params) = {} else {{ runtime::throw_type_error(\"Value of this must be of type URLSearchParams\".into()) }}; runtime::array_new((0..runtime::search_params_size(&params) as usize).map(|index| runtime::array_new(vec![runtime::search_params_key_at(&params, index as f64), runtime::search_params_value_at(&params, index as f64)])).collect()) }}",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "url.newValueBase" => format!(
            "NativeValue::Url(runtime::url_new_base(&({}), &({})))",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "array.setSloppy" => format!(
            "{{ let array = {}; let index = {}; let value = {}; if !runtime::array_is_template_frozen(&array) {{ runtime::array_set(&array, index, value); }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "array.setLengthSloppy" => format!(
            "{{ let array = {}; let length = {}; if !runtime::array_is_template_frozen(&array) {{ runtime::array_set_length(&array, length); }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.keySet" => format!(
            "native_value_set({}, {}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.keySetComputed" => format!(
            "{{ let object = {}; let key = {}; let field = {}; match key {{ NativeValue::Symbol(key) => native_value_symbol_set(object, key, field), other => native_value_set(object, native_value_string(other), field) }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.keySetSloppy" => format!(
            "{{ let object = {}; let key = {}; let field = {}; if !native_array_is_template_frozen(&object) && !native_frozen_string_write_blocked(&object, &key) {{ native_value_set(object, key, field); }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.keySetComputedSloppy" => format!(
            "{{ let object = {}; let key = {}; let field = {}; match key {{ NativeValue::Symbol(key) => {{ let blocked = native_value_own_symbol_property(&object, &key).map(|property| !property.writable).unwrap_or_else(|| native_object_frozen(&object)); if !native_array_is_template_frozen(&object) && !blocked {{ native_value_symbol_set(object, key, field); }} }}, other => {{ let key = native_value_string(other); if !native_array_is_template_frozen(&object) && !native_frozen_string_write_blocked(&object, &key) {{ native_value_set(object, key, field); }} }} }} }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),

        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.keyDelete" => format!(
            "{{ let object = {}; let key = {}; let strict = {}; runtime::native_delete_property(&object, &key, strict) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.keyDeleteComputed" => format!(
            "{{ let receiver = {}; let key = {}; let strict = {}; native_delete_computed(receiver, key, strict) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),
        Expr::DynFrom { value, .. } => boxed(&value.ty(), &expr(value, function, module), module),
        Expr::DynCheck { value, r#type, .. } => {
            checked(r#type, &expr(value, function, module), module)
        }
        Expr::DynObjLit { fields, .. } => {
            let fields = fields
                .iter()
                .map(|field| {
                    let key = expr(&field.key, function, module);
                    let value = expr(&field.value, function, module);
                    if field.key.ty() == Type::Symbol {
                        format!("{{ let key = {key}; let value = {value}; native_value_symbol_set(object.clone(), key, value); }}")
                    } else {
                        format!("{{ let key = {key}; let value = {value}; native_value_set(object.clone(), key, value); }}")
                    }
                })
                .collect::<String>();
            format!(
                "{{ let object = NativeValue::Object(runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }})); {fields} object }}"
            )
        }
        Expr::DynArrLit { elems, .. } => format!(
            "NativeValue::Array(runtime::array_new(vec![{}]))",
            elems
                .iter()
                .map(|e| expr(e, function, module))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Expr::DynKeyGet { value, key, .. } => {
            let value = expr(value, function, module);
            let key_value = expr(key, function, module);
            match key.ty() {
                Type::Symbol => format!("native_value_symbol_get({value}, {key_value})"),
                Type::Dyn => format!(
                    "{{ let value = {value}; let key = {key_value}; match key {{ NativeValue::Symbol(symbol) => native_value_symbol_get(value, symbol), other => native_value_get(value, native_value_string(other)), }} }}"
                ),
                _ => format!("native_value_get({value}, {key_value})"),
            }
        }
        Expr::DynTest {
            value,
            test,
            negated,
            ..
        } => format!(
            "{}native_value_test(&({}), {test:?})",
            if *negated { "!" } else { "" },
            expr(value, function, module)
        ),
        Expr::DynScalarEq {
            left,
            right,
            negated,
            ..
        } => format!(
            "{}native_value_eq(&({}), &({}))",
            if *negated { "!" } else { "" },
            expr(left, function, module),
            expr(right, function, module)
        ),
        Expr::DynLooseEq {
            left,
            right,
            negated,
            ..
        } => format!(
            "{}native_value_abstract_eq(&({}), &({}))",
            if *negated { "!" } else { "" },
            expr(left, function, module),
            expr(right, function, module)
        ),
        Expr::DynInvoke {
            recv,
            method,
            callee_name,
            optional,
            args,
            ..
        } => {
            let invoke = format!(
                "native_value_invoke(recv, method, {method:?}, vec![{}], {callee_name:?})",
                args.iter()
                    .map(|e| expr(e, function, module))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let method_value = method
                .strip_prefix('\0')
                .and_then(crate::ir::well_known_symbol)
                .map(|symbol| {
                    format!(
                        "native_value_symbol_get(recv.clone(), runtime::symbol_well_known(runtime::WellKnownSymbol::{symbol}))"
                    )
                })
                .unwrap_or_else(|| format!("native_value_method(recv.clone(), {method:?})"));
            format!(
                "{{ let recv = {}; let method = {method_value}; {} }}",
                expr(recv, function, module),
                if *optional {
                    format!(
                        "if matches!(method, NativeValue::Null | NativeValue::Undefined) {{ NativeValue::Undefined }} else {{ {invoke} }}"
                    )
                } else {
                    invoke
                }
            )
        }
        Expr::DynCall {
            callee,
            callee_name,
            args,
            ..
        } => receivers::call(callee, args, Some(callee_name), function, module),
        _ => return None,
    })
}

pub(super) fn promise_expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let Expr::Intrinsic {
        name, args, r#type, ..
    } = value
    else {
        return None;
    };
    if name == "promise.valueView" {
        let [source] = args.as_slice() else {
            unreachable!("validated Promise value view")
        };
        return Some(expr(source, function, module));
    }
    if name == "promise.block" {
        let [promise] = args.as_slice() else {
            unreachable!("validated blocking await")
        };
        let checked = checked_value(r#type, "raw", module);
        return Some(format!(
            "{{ let raw = runtime::promise_block(&({})); {checked} }}",
            expr(promise, function, module)
        ));
    }
    if name == "object.nullConstructor" {
        return Some("native_null_constructor()".into());
    }
    if name == "object.constructNull" {
        return Some(format!(
            "native_construct_null({})",
            expr(&args[0], function, module)
        ));
    }
    if name == "object.createNull" {
        return Some("NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: true, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }))".into());
    }
    if name == "object.setPrototypeNull" {
        return Some(format!(
            "{{ let value = {}; match &value {{ NativeValue::Object(object) | NativeValue::Record(_, object) => object.with_mut(|data| data.null_prototype = true), _ => runtime::throw_type_error(\"Object.setPrototypeOf target must be an object\".into()), }} value }}",
            expr(&args[0], function, module)
        ));
    }
    if name == "object.setPrototype" {
        return Some(format!(
            "{{ let value = {}; let prototype = {}; match &value {{ NativeValue::Object(object) | NativeValue::Record(_, object) => {{ if !matches!(&prototype, NativeValue::Object(_) | NativeValue::Record(..)) {{ runtime::throw_type_error(\"Object prototype may only be an Object or null\".into()); }} object.with_mut(|data| data.null_prototype = false); native_set_instance_prototype(object, prototype); }}, _ => runtime::throw_type_error(\"Object.setPrototypeOf target must be an object\".into()), }} value }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ));
    }
    if name == "weakRef.new" {
        return Some(format!(
            "native_weak_ref_new({})",
            expr(&args[0], function, module)
        ));
    }
    if name == "finalizationRegistry.new" {
        return Some(format!(
            "native_finalization_registry_new({})",
            expr(&args[0], function, module)
        ));
    }
    if name == "arrayBuffer.new" {
        return Some(format!(
            "NativeValue::ArrayBuffer(runtime::bytes_alloc::<u8>({}))",
            expr(&args[0], function, module)
        ));
    }
    if name == "blob.new" {
        return Some(format!(
            "native_blob_new({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ));
    }
    if name == "file.new" {
        return Some(format!(
            "native_file_new({}, {}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ));
    }
    if name == "web.writableStreamNew" {
        return Some(format!(
            "native_writable_stream_new({})",
            expr(&args[0], function, module)
        ));
    }
    if name == "global.object" {
        return Some("native_global_object()".into());
    }
    if name == "global.navigator" {
        return Some("native_navigator_value()".into());
    }
    if name == "global.process" {
        return Some("native_process_value()".into());
    }
    if name == "global.fetch" {
        return Some("NativeValue::Fetch".into());
    }
    if name == "global.abortSignal" {
        return Some("NativeValue::AbortSignalConstructor".into());
    }
    if let Some(kind) = match name.as_str() {
        "global.readableStreamConstructor" => Some(0),
        "global.blobConstructor" => Some(1),
        "global.urlSearchParamsConstructor" => Some(2),
        "global.fileConstructor" => Some(3),
        "global.urlConstructor" => Some(4),
        "global.messagePortConstructor" => Some(5),
        "global.responseConstructor" => Some(6),
        "global.headersConstructor" => Some(7),
        "global.formDataConstructor" => Some(8),
        _ => None,
    } {
        return Some(format!("NativeValue::WebConstructor({kind})"));
    }
    if name == "global.intl" {
        return Some("native_intl_value()".into());
    }
    if name == "global.intlSegmenterUnavailable" {
        return Some(
            "runtime::throw_type_error(\"Intl.Segmenter is not a constructor\".into())".into(),
        );
    }
    if name == "global.unbound" {
        return Some(format!(
            "runtime::throw_reference_error(format!(\"{{}} is not defined\", {}.as_ref()))",
            expr(&args[0], function, module)
        ));
    }
    if name == "inspector.session.new" {
        return Some("native_inspector_session()".into());
    }
    if matches!(
        name.as_str(),
        "inspector.session.connect" | "inspector.session.disconnect"
    ) {
        return Some(format!(
            "{{ let _session = {}; }}",
            expr(&args[0], function, module)
        ));
    }
    if name == "inspector.session.post" {
        return Some(format!(
            "{{ let _session = {}; let method = {}; let _params = {}; let callback = {}; native_inspector_post(method, callback); }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module),
        ));
    }
    if name == "module.require.missing" {
        return Some(format!(
            "runtime::throw_error_code(format!(\"Cannot find module '{{}}'\", {}.to_utf8_lossy()), \"MODULE_NOT_FOUND\")",
            expr(&args[0], function, module)
        ));
    }
    if name == "promise.allInput" {
        let Type::Promise { inner } = value.ty() else {
            unreachable!("validated dynamic Promise.all")
        };
        let Type::Array { elem } = inner.as_ref() else {
            unreachable!("validated dynamic Promise.all result")
        };
        let [input] = args.as_slice() else {
            unreachable!("validated dynamic Promise.all input")
        };
        let checked = checked_value(elem, "raw", module);
        let array = format!(
            "runtime::array_new(values.into_iter().map(|value| {{ let raw = *value.downcast::<NativeValue>().expect(\"scriptc: Promise.all dynamic payload ABI\"); {checked} }}).collect())"
        );
        let boxed = box_value(inner.as_ref(), &array, module);
        return Some(format!(
            "{{ let entries = {}; let handles = runtime::array_values(&entries).into_iter().map(|entry| runtime::promise_to_handle(&entry)).collect(); runtime::promise_all_tuple(handles, |values| {boxed}) }}",
            expr(input, function, module)
        ));
    }
    if name == "promise.allValuesInput" {
        let Type::Promise { inner } = value.ty() else {
            unreachable!("validated value Promise.all")
        };
        let Type::Array { elem: result_elem } = inner.as_ref() else {
            unreachable!("validated value Promise.all result")
        };
        let [input] = args.as_slice() else {
            unreachable!("validated value Promise.all input")
        };
        let Type::Array { elem: source_elem } = input.ty() else {
            unreachable!("validated value Promise.all source")
        };
        let boxed_entry = box_value(source_elem.as_ref(), "entry", module);
        let checked = checked_value(result_elem, "raw", module);
        let array = format!(
            "runtime::array_new(values.into_iter().map(|value| {{ let raw = *value.downcast::<NativeValue>().expect(\"scriptc: Promise.all value payload ABI\"); {checked} }}).collect())"
        );
        let boxed_result = box_value(inner.as_ref(), &array, module);
        return Some(format!(
            "{{ let entries = {}; let handles = runtime::array_values(&entries).into_iter().map(|entry| {{ let promise = native_promise_resolved({boxed_entry}); runtime::promise_to_handle(&promise) }}).collect(); runtime::promise_all_tuple(handles, |values| {boxed_result}) }}",
            expr(input, function, module)
        ));
    }
    if name == "promise.allDiscard" {
        let handles = args
            .iter()
            .map(|arg| {
                format!(
                    "runtime::promise_to_handle(&({}))",
                    expr(arg, function, module)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Some(format!(
            "runtime::promise_all_tuple(vec![{handles}], |values| NativeValue::Array(runtime::array_new(values.into_iter().map(|value| *value.downcast::<NativeValue>().expect(\"scriptc: erased Promise.all payload ABI\")).collect())))"
        ));
    }
    if name == "promise.raceArray" {
        let entries = args
            .iter()
            .map(|arg| expr(arg, function, module))
            .collect::<Vec<_>>()
            .join(", ");
        return Some(format!("runtime::promise_race(vec![{entries}])"));
    }
    if name == "promise.allArray" {
        let Type::Promise { inner } = value.ty() else {
            unreachable!("validated Promise.all array")
        };
        let Type::Array { elem } = inner.as_ref() else {
            unreachable!("validated Promise.all array result")
        };
        let handles = args
            .iter()
            .map(|arg| {
                format!(
                    "runtime::promise_to_handle(&({}))",
                    expr(arg, function, module)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let checked = checked_value(elem, "raw", module);
        let array = format!(
            "runtime::array_new(values.into_iter().map(|value| {{ let raw = *value.downcast::<NativeValue>().expect(\"scriptc: Promise.all array payload ABI\"); {checked} }}).collect())"
        );
        let boxed = box_value(inner.as_ref(), &array, module);
        return Some(format!(
            "runtime::promise_all_tuple(vec![{handles}], |values| {boxed})"
        ));
    }
    if name == "promise.allTuple" {
        let Type::Promise { inner } = value.ty() else {
            unreachable!("validated Promise.all tuple")
        };
        let Type::Record { shape_id } = inner.as_ref() else {
            unreachable!("validated Promise.all tuple record")
        };
        let record = &module.records[*shape_id];
        let handles = args
            .iter()
            .map(|arg| {
                format!(
                    "runtime::promise_to_handle(&({}))",
                    expr(arg, function, module)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let reads = record
            .declared_order
            .iter()
            .enumerate()
            .map(|(index, name)| {
                let field = record
                    .fields
                    .iter()
                    .find(|field| &field.name == name)
                    .expect("validated tuple field");
                let checked = checked_value(&field.r#type, &format!("raw_{index}"), module);
                format!(
                    "let raw_{index} = *values.next().expect(\"scriptc: missing Promise.all tuple slot\").downcast::<NativeValue>().expect(\"scriptc: Promise.all tuple payload ABI\"); let value_{index} = {checked};"
                )
            })
            .collect::<String>();
        let keys = record
            .declared_order
            .iter()
            .map(|name| format!("{name:?}.into()"))
            .collect::<Vec<_>>()
            .join(", ");
        let fields = record
            .declared_order
            .iter()
            .enumerate()
            .map(|(index, name)| format!("{}: Some(value_{index})", field_name(name)))
            .collect::<Vec<_>>()
            .join(", ");
        let tuple = format!(
            "runtime::Gc::new(R{shape_id} {{ source: None, own_keys: vec![{keys}], {fields} }})"
        );
        let boxed = box_value(inner.as_ref(), &tuple, module);
        return Some(format!(
            "runtime::promise_all_tuple(vec![{handles}], |values| {{ let mut values = values.into_iter(); {reads} {boxed} }})"
        ));
    }
    if name == "module.import.lazy" {
        let [namespace, Expr::Closure { fn_name, .. }] = args.as_slice() else {
            unreachable!("validated module import")
        };
        let index = module
            .functions
            .iter()
            .position(|function| &function.name == fn_name)
            .expect("validated module initializer");
        let value = boxed(&namespace.ty(), &expr(namespace, function, module), module);
        return Some(format!(
            "{{ let cache = MODULE_CACHE_{index}.with(|slot| slot.borrow_mut().get_or_insert_with(runtime::module_cache_new).clone()); runtime::module_import_cached_map(cache, move || {{ native_module_eval_{index}(); runtime::promise_resolved(()) }}, move |_| {{ let value = {value}; native_promise_plain(&value); value }}) }}"
        ));
    }
    if name == "module.import.cjs" {
        let [namespace, Expr::Closure { fn_name, .. }] = args.as_slice() else {
            unreachable!("validated CommonJS module import")
        };
        let initializer = function_name(fn_name);
        let value = boxed(&namespace.ty(), &expr(namespace, function, module), module);
        return Some(format!(
            "runtime::module_import(move || {{ let _ = {initializer}(); let value = {value}; native_promise_plain(&value); native_promise_resolved(value) }})"
        ));
    }
    if name == "module.import.missing" {
        let [specifier] = args.as_slice() else {
            unreachable!("validated missing module import")
        };
        return Some(format!(
            "{{ let specifier = {}; runtime::promise_rejected(runtime::caught_value(runtime::error_new_code(\"Error\", runtime::string(&format!(\"Cannot find package '{{}}' imported from native module\", specifier.to_utf8_lossy())), \"ERR_MODULE_NOT_FOUND\"))) }}",
            expr(specifier, function, module)
        ));
    }
    if name != "promise.resolve" && name != "promise.reject" && name != "module.import.inert" {
        return None;
    }
    let value = if let Some(arg) = args.first() {
        boxed(&arg.ty(), &expr(arg, function, module), module)
    } else {
        "NativeValue::Undefined".into()
    };
    if name == "module.import.inert" {
        Some(format!(
            "runtime::module_import(move || native_promise_resolved({value}))"
        ))
    } else if name == "promise.reject" {
        Some(format!(
            "runtime::promise_rejected(runtime::caught_value({value}))"
        ))
    } else {
        Some(format!("native_promise_resolved({value})"))
    }
}

pub(super) fn box_value(ty: &Type, value: &str, module: &Emission<'_>) -> String {
    boxed(ty, value, module)
}

pub(super) fn checked_value(ty: &Type, value: &str, module: &Emission<'_>) -> String {
    checked(ty, value, module)
}

#[cfg(test)]
mod tests {
    use super::prune_unused_adapters;

    #[test]
    fn adapter_pruning_retains_transitive_dependencies_only() {
        let source = concat!(
            "fn native_box_0(value: A) -> NativeValue { native_check_1(&value) }\n",
            "fn native_try_0(value: &NativeValue) -> Option<A> { None }\n",
            "fn native_box_1(value: B) -> NativeValue { NativeValue::Undefined }\n",
            "fn native_try_1(value: &NativeValue) -> Option<B> { None }\n",
            "#[track_caller] fn native_check_1(value: &NativeValue) -> B { native_try_1(value).unwrap() }\n",
            "fn main() { let _ = native_box_0(A); }\n",
        )
        .to_owned();
        let original_bytes = source.len();
        let (pruned, metrics) = prune_unused_adapters(source);
        assert!(pruned.contains("fn native_box_0"));
        assert!(pruned.contains("fn native_try_1"));
        assert!(pruned.contains("fn native_check_1"));
        assert!(!pruned.contains("fn native_try_0"));
        assert!(!pruned.contains("fn native_box_1"));
        assert_eq!(metrics.discovered, 5);
        assert_eq!(metrics.retained, 3);
        assert_eq!(original_bytes - pruned.len(), metrics.removed_bytes);
    }
}
