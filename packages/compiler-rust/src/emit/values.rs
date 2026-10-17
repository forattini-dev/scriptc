//! Native value erasure keeps typed owning handles and compiled call targets.
use super::*;
use std::fmt::Write;

fn types(module: &Module) -> Vec<Type> {
    fn visit(ty: &Type, out: &mut Vec<Type>) {
        if out.contains(ty) || *ty == Type::Void {
            return;
        }
        out.push(ty.clone());
        match ty {
            Type::Func { params, ret } => {
                for p in params {
                    visit(p, out);
                }
                visit(ret, out);
            }
            Type::Array { elem } | Type::Set { elem } => visit(elem, out),
            Type::Promise { inner } => visit(inner, out),
            Type::Map { key, value } => {
                visit(key, out);
                visit(value, out);
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
        Type::Map {
            key: Box::new(Type::Dyn),
            value: Box::new(Type::Dyn),
        },
    ];
    for f in &module.functions {
        if f.name != module.entry {
            visit(
                &Type::Func {
                    params: f.params.iter().map(|p| p.r#type.clone()).collect(),
                    ret: Box::new(f.return_type.clone()),
                },
                &mut out,
            );
        }
        visit(&f.return_type, &mut out);
        for l in &f.locals {
            visit(&l.r#type, &mut out);
        }
        for p in &f.params {
            visit(&p.r#type, &mut out);
        }
    }
    for r in &module.records {
        visit(&Type::Record { shape_id: r.id }, &mut out);
        for f in &r.fields {
            visit(&f.r#type, &mut out);
        }
        if let Some(t) = &r.index_value {
            visit(t, &mut out);
        }
    }
    for u in &module.unions {
        visit(&Type::Union { union_id: u.id }, &mut out);
        for t in &u.arms {
            visit(t, &mut out);
        }
    }
    for g in &module.globals {
        visit(&g.r#type, &mut out);
    }
    for c in &module.classes {
        visit(
            &Type::Object {
                class_name: c.name.clone(),
            },
            &mut out,
        );
        visit(
            &Type::Classval {
                class_name: c.name.clone(),
            },
            &mut out,
        );
        for f in c.fields.iter().skip(module.class_header_len(c)) {
            visit(&f.r#type, &mut out);
        }
    }
    module.visit_expressions(&mut |e| visit(&e.ty(), &mut out));
    out
}
fn id(ty: &Type, module: &Module) -> usize {
    types(module)
        .iter()
        .position(|t| t == ty)
        .expect("inventoried native value ABI")
}
fn specialized(ty: &Type) -> bool {
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
            | Type::Func { .. }
            | Type::Map { .. }
            | Type::Set { .. }
            | Type::Classval { .. }
            | Type::Bytes { .. }
    )
}
fn boxed(ty: &Type, value: &str, module: &Module) -> String {
    format!("native_box_{}({value})", id(ty, module))
}
fn checked(ty: &Type, value: &str, module: &Module) -> String {
    format!("native_check_{}(&({value}))", id(ty, module))
}

pub(super) fn definitions(module: &Module, out: &mut String) {
    out.push_str("fn native_value_string(value: NativeValue) -> String { match value { NativeValue::Undefined => \"undefined\".into(), NativeValue::Null => \"null\".into(), NativeValue::Number(v) => js_string_number(v), NativeValue::Boolean(v) => v.to_string(), NativeValue::String(v) => v, NativeValue::Symbol(_) => runtime::throw_type_error(\"Cannot convert a Symbol value to a string\".into()), _ => runtime::throw_type_error(\"scriptc: object string conversion requires native ToPrimitive support\".into()) } }\n");
    out.push_str(include_str!("../map_values_support.rs"));
    out.push_str(include_str!("../promise_values_support.rs"));
    let types = types(module);
    out.push_str("#[derive(Clone)]\nenum NativeValue { Undefined, Null, Number(f64), Boolean(bool), String(String), Regex(runtime::JsRegex), Symbol(runtime::JsSymbol), Promise(runtime::JsPromise<NativeValue>), Object(runtime::Gc<NativeMap<String, NativeValue>>), Map(runtime::Gc<NativeMap<NativeValue, NativeValue>>), Array(runtime::JsArray<NativeValue>),\n");
    if !module.classes.is_empty() {
        out.push_str("Instance(runtime::Gc<NativeInstance>),\n");
    }
    for (i, ty) in types.iter().enumerate().filter(|(_, t)| specialized(t)) {
        writeln!(out, "V{i}({}),", rust_type(ty.clone(), module)).unwrap();
    }
    out.push_str("}\nimpl NativeTrace for NativeValue { fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) { match self { Self::Promise(v) => v.trace_native(tracer), Self::Object(v) => v.trace_native(tracer), Self::Map(v) => v.trace_native(tracer), Self::Array(v) => v.trace_native(tracer),\n");
    if !module.classes.is_empty() {
        out.push_str("Self::Instance(v) => v.trace_native(tracer),\n");
    }
    for (i, _) in types.iter().enumerate().filter(|(_, t)| specialized(t)) {
        writeln!(out, "Self::V{i}(v) => v.trace_native(tracer),").unwrap();
    }
    out.push_str("_ => {} } } }\nimpl runtime::ArrayElement for NativeValue { fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { self.trace_native(tracer); } }\n");
    for (i, ty) in types.iter().enumerate() {
        let rt = rust_type(ty.clone(), module);
        let (box_code, try_code) = match ty {
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
            Type::F64 | Type::Bool | Type::String | Type::Regex | Type::Symbol => {
                let variant = match ty {
                    Type::F64 => "Number",
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
            Type::Map { key, value } if **key == Type::Dyn && **value == Type::Dyn => (
                "NativeValue::Map(value)".into(),
                "if let NativeValue::Map(v) = value { Some(v.clone()) } else { None }".into(),
            ),
            Type::Object { class_name } => {
                let ci = module
                    .classes
                    .iter()
                    .position(|c| c.name == *class_name)
                    .unwrap();
                (
                    "NativeValue::Instance(value)".into(),
                    format!(
                        "if let NativeValue::Instance(v) = value {{ if instance_is_{ci}(v.clone()) {{ Some(v.clone()) }} else {{ None }} }} else {{ None }}"
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
                let c = arms.iter().enumerate().map(|(tag,t)| format!("if let Some(v) = native_try_{}(value) {{ return Some(U{union_id}::V{tag}(v)); }}", id(t,module))).collect::<String>();
                (format!("match value {{ {b} }}"), format!("{{ {c} None }}"))
            }
            _ => (
                format!("NativeValue::V{i}(value)"),
                format!(
                    "if let NativeValue::V{i}(v) = value {{ Some(v.clone()) }} else {{ None }}"
                ),
            ),
        };
        writeln!(out, "fn native_box_{i}(value: {rt}) -> NativeValue {{ {box_code} }}\nfn native_try_{i}(value: &NativeValue) -> Option<{rt}> {{ {try_code} }}\nfn native_check_{i}(value: &NativeValue) -> {rt} {{ native_try_{i}(value).unwrap_or_else(|| runtime::throw_type_error(\"scriptc: native value does not match the required type\".into())) }}").unwrap();
    }
    out.push_str(r#"fn native_value_missing(key: &str) -> NativeValue { native_value_missing_kind(key, "object") }
fn native_value_missing_kind(key: &str, kind: &str) -> NativeValue {
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
    out.push_str("fn native_value_eq(left: &NativeValue, right: &NativeValue) -> bool { match (left, right) { (NativeValue::Undefined, NativeValue::Undefined) | (NativeValue::Null, NativeValue::Null) => true, (NativeValue::Number(a), NativeValue::Number(b)) => a == b, (NativeValue::Boolean(a), NativeValue::Boolean(b)) => a == b, (NativeValue::String(a), NativeValue::String(b)) => a == b, (NativeValue::Symbol(a), NativeValue::Symbol(b)) => runtime::symbol_ptr_eq(a,b), (NativeValue::Regex(a), NativeValue::Regex(b)) => std::rc::Rc::ptr_eq(a,b), (NativeValue::Object(a), NativeValue::Object(b)) => a.ptr_eq(b), (NativeValue::Map(a), NativeValue::Map(b)) => a.ptr_eq(b), (NativeValue::Promise(a), NativeValue::Promise(b)) => runtime::promise_view_identity(a) == runtime::promise_view_identity(b), (NativeValue::Array(a), NativeValue::Array(b)) => a.ptr_eq(b),\n");
    if !module.classes.is_empty() {
        out.push_str("(NativeValue::Instance(a), NativeValue::Instance(b)) => a.ptr_eq(b),\n");
    }
    for (i, t) in types.iter().enumerate().filter(|(_, t)| specialized(t)) {
        let eq = if matches!(t, Type::Classval { .. }) {
            "a == b"
        } else {
            "a.ptr_eq(b)"
        };
        writeln!(out, "(NativeValue::V{i}(a), NativeValue::V{i}(b)) => {eq},").unwrap();
    }
    out.push_str("_ => false } }\nfn native_value_test(value: &NativeValue, test: &str) -> bool { match test { \"number\" => matches!(value, NativeValue::Number(_)), \"boolean\" => matches!(value, NativeValue::Boolean(_)), \"string\" => matches!(value, NativeValue::String(_)), \"symbol\" => matches!(value, NativeValue::Symbol(_)), \"undefined\" => matches!(value, NativeValue::Undefined), \"null\" => matches!(value, NativeValue::Null), \"nullish\" => matches!(value, NativeValue::Undefined | NativeValue::Null), \"truthy\" => match value { NativeValue::Undefined | NativeValue::Null => false, NativeValue::Number(v) => *v != 0.0 && !v.is_nan(), NativeValue::Boolean(v) => *v, NativeValue::String(v) => !v.is_empty(), _ => true }, \"function\" => match value {\n");
    for (i, t) in types.iter().enumerate() {
        if matches!(t, Type::Func { .. } | Type::Classval { .. }) {
            writeln!(out, "NativeValue::V{i}(_) => true,").unwrap();
        }
    }
    out.push_str("_ => false }, \"object\" => !matches!(value, NativeValue::Undefined | NativeValue::Number(_) | NativeValue::Boolean(_) | NativeValue::String(_) | NativeValue::Symbol(_)) && !native_value_test(value, \"function\"), _ => false } }\n");
    out.push_str("fn native_value_set(value: NativeValue, key: String, field: NativeValue) { match value { NativeValue::Object(object) => object.with_mut(|o| { if let Some((_, current)) = o.entries.iter_mut().find(|(k,_)| *k == key) { *current = field; } else { o.entries.push((key, field)); } }), _ => runtime::throw_type_error(\"scriptc: property writes require a native plain object\".into()) } }\n");
    out.push_str("fn native_value_get(value: NativeValue, key: String) -> NativeValue { match value { NativeValue::Undefined => runtime::throw_type_error(format!(\"Cannot read properties of undefined (reading '{}')\", key)), NativeValue::Null => runtime::throw_type_error(format!(\"Cannot read properties of null (reading '{}')\", key)), NativeValue::Promise(_) => native_value_missing_kind(&key, \"promise\"), NativeValue::Map(map) => { if key == \"size\" { NativeValue::Number(map.with(|m| m.entries.len() as f64)) } else { native_value_missing_kind(&key, \"map\") } }, NativeValue::Object(object) => object.with(|o| o.entries.iter().find(|(k,_)| *k == key).map(|(_,v)| v.clone()).unwrap_or_else(|| native_value_missing(&key))), NativeValue::Array(array) => { if key == \"length\" { NativeValue::Number(runtime::array_len(&array)) } else if let Ok(i) = key.parse::<usize>() { if i.to_string() == key && (i as f64) < runtime::array_len(&array) { runtime::array_get(&array, i as f64) } else { NativeValue::Undefined } } else { native_value_missing_kind(&key, \"array\") } }, NativeValue::String(s) => { if key == \"length\" { NativeValue::Number(s.encode_utf16().count() as f64) } else if let Ok(index) = key.parse::<usize>() { if index.to_string() == key { s.encode_utf16().nth(index).map(|unit| NativeValue::String(String::from_utf16(&[unit]).unwrap_or_else(|_| runtime::throw_type_error(\"scriptc: lone UTF-16 surrogates are not ported\".into())))).unwrap_or(NativeValue::Undefined) } else { NativeValue::Undefined } } else { native_value_missing_kind(&key, \"string\") } },\n");
    for (i, t) in types.iter().enumerate() {
        if let Type::Record { shape_id } = t {
            let r = &module.records[*shape_id];
            writeln!(
                out,
                "NativeValue::V{i}(object) => object.with(|o| {{ match key.as_str() {{"
            )
            .unwrap();
            for f in &r.fields {
                writeln!(
                    out,
                    "{:?} => o.{}.clone().map(|v| {}).unwrap_or(NativeValue::Undefined),",
                    f.name,
                    field_name(&f.name),
                    boxed(&f.r#type, "v", module)
                )
                .unwrap();
            }
            let fallback = if let Some(t) = &r.index_value {
                format!(
                    "o.overflow.iter().find(|(k,_)| *k == key).map(|(_,v)| {}).unwrap_or_else(|| native_value_missing(&key))",
                    boxed(t, "v.clone()", module)
                )
            } else {
                "native_value_missing(&key)".into()
            };
            writeln!(out, "_ => {fallback} }} }}),").unwrap();
        }
    }
    out.push_str("NativeValue::Symbol(symbol) => { if key == \"description\" { runtime::symbol_description(&symbol).map(|s| NativeValue::String(s.to_string())).unwrap_or(NativeValue::Undefined) } else { native_value_missing_kind(&key, \"symbol\") } }, NativeValue::Regex(_) => native_value_missing_kind(&key, \"regex\"), NativeValue::Number(_) => native_value_missing_kind(&key, \"number\"),\n");
    for (i, t) in types.iter().enumerate() {
        if matches!(t, Type::Bytes { .. }) {
            writeln!(out, "NativeValue::V{i}(bytes) => {{ match key.as_str() {{ \"length\" | \"byteLength\" => NativeValue::Number(runtime::bytes_len(&bytes)), \"byteOffset\" => NativeValue::Number(runtime::bytes_byte_offset(&bytes)), _ => runtime::throw_type_error(\"scriptc: erased Uint8Array member requires a typed receiver\".into()), }} }},").unwrap();
        }
        if matches!(t, Type::Func { .. } | Type::Classval { .. }) {
            writeln!(
                out,
                "NativeValue::V{i}(_) => native_value_missing_kind(&key, \"function\"),"
            )
            .unwrap();
        }
        if matches!(t, Type::Set { .. }) {
            writeln!(out, "NativeValue::V{i}(set) => {{ if key == \"size\" {{ NativeValue::Number(set.with(|set| set.entries.len() as f64)) }} else {{ native_value_missing_kind(&key, \"set\") }} }},").unwrap();
        }
        if matches!(t, Type::Map { .. }) && specialized(t) {
            writeln!(
                out,
                "NativeValue::V{i}(_) => native_value_missing_kind(&key, \"map\"),"
            )
            .unwrap();
        }
    }
    for (i, t) in types.iter().enumerate() {
        if let Type::Array { elem } = t
            && **elem != Type::Dyn
        {
            let value: String = if **elem == Type::String {
                "runtime::array_get(&array, index as f64).to_string()".into()
            } else {
                "runtime::array_get(&array, index as f64)".into()
            };
            let value = boxed(elem, &value, module);
            writeln!(out, "NativeValue::V{i}(array) => {{ if key == \"length\" {{ NativeValue::Number(runtime::array_len(&array)) }} else if let Ok(index) = key.parse::<usize>() {{ if index.to_string() == key && (index as f64) < runtime::array_len(&array) {{ {value} }} else {{ NativeValue::Undefined }} }} else {{ native_value_missing_kind(&key, \"array\") }} }},").unwrap();
        }
    }
    if !module.classes.is_empty() {
        out.push_str(
            "NativeValue::Instance(object) => { let kind = object.with(|o| o.kind); match kind {\n",
        );
        for (i, c) in module.classes.iter().enumerate() {
            writeln!(out, "{i} => match key.as_str() {{").unwrap();
            if c.name.starts_with("native_builtin_Text") {
                out.push_str("\"encoding\" | \"fatal\" | \"ignoreBOM\" => runtime::throw_type_error(\"scriptc: erased codec properties require a typed receiver\".into()),\n");
            }
            for f in c.fields.iter().filter(|f| !f.name.starts_with('%')) {
                writeln!(
                    out,
                    "{:?} => {},",
                    f.name,
                    boxed(
                        &f.r#type,
                        &format!("instance_get_{i}_{}(object.clone())", field_name(&f.name)),
                        module
                    )
                )
                .unwrap();
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
                writeln!(out, "{:?} => runtime::throw_type_error(\"scriptc: erased instance method values require a receiver ABI\".into()),", method).unwrap();
            }
            out.push_str("_ => native_value_missing(&key), },\n");
        }
        out.push_str("_ => unreachable!(\"validated native instance kind\") } },\n");
    }
    out.push_str("_ => native_value_missing(&key) } }\nfn native_value_call(callee: NativeValue, args: Vec<NativeValue>, name: &str) -> NativeValue { match callee {\n");
    for (i, t) in types.iter().enumerate() {
        if let Type::Func { params, ret } = t {
            let args = params
                .iter()
                .enumerate()
                .map(|(j, t)| {
                    format!(
                        ", {}",
                        checked(
                            t,
                            &format!("args.get({j}).cloned().unwrap_or(NativeValue::Undefined)"),
                            module
                        )
                    )
                })
                .collect::<String>();
            let call = format!("call_{}(function{args})", functions::type_name(t, module));
            let result = if **ret == Type::Void {
                format!("{{ {call}; NativeValue::Undefined }}")
            } else {
                boxed(ret, &call, module)
            };
            writeln!(out, "NativeValue::V{i}(function) => {result},").unwrap();
        }
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

pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    Some(match value {
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.keySet" => format!(
            "native_value_set({}, {}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module)
        ),

        Expr::DynFrom { value, .. } => boxed(&value.ty(), &expr(value, function, module), module),
        Expr::DynCheck { value, r#type, .. } => {
            checked(r#type, &expr(value, function, module), module)
        }
        Expr::DynObjLit { fields, .. } => {
            let fields = fields.iter().map(|f| format!("{{ let key = {}; let value = {}; js_data_set(&mut entries, key, value); }}",expr(&f.key,function,module),expr(&f.value,function,module))).collect::<String>();
            format!(
                "{{ let mut entries = Vec::new(); {fields} NativeValue::Object(runtime::Gc::new(NativeMap {{ entries }})) }}"
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
        Expr::DynKeyGet { value, key, .. } => format!(
            "native_value_get({}, {})",
            expr(value, function, module),
            expr(key, function, module)
        ),
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
        Expr::DynInvoke {
            recv,
            method,
            callee_name,
            args,
            ..
        } => format!(
            "{{ let recv = {}; let method = native_value_method(recv, {method:?}); native_value_invoke(method, {method:?}, vec![{}], {callee_name:?}) }}",
            expr(recv, function, module),
            args.iter()
                .map(|e| expr(e, function, module))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Expr::DynCall {
            callee,
            callee_name,
            args,
            ..
        } => format!(
            "native_value_call({}, vec![{}], {callee_name:?})",
            expr(callee, function, module),
            args.iter()
                .map(|e| expr(e, function, module))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => return None,
    })
}

pub(super) fn promise_expression(
    value: &Expr,
    function: &Function,
    module: &Module,
) -> Option<String> {
    let Expr::Intrinsic { name, args, .. } = value else {
        return None;
    };
    if name != "promise.resolve" {
        return None;
    }
    let value = if let Some(arg) = args.first() {
        boxed(&arg.ty(), &expr(arg, function, module), module)
    } else {
        "NativeValue::Undefined".into()
    };
    Some(format!("native_promise_resolved({value})"))
}

pub(super) fn box_value(ty: &Type, value: &str, module: &Module) -> String {
    boxed(ty, value, module)
}

pub(super) fn checked_value(ty: &Type, value: &str, module: &Module) -> String {
    checked(ty, value, module)
}
