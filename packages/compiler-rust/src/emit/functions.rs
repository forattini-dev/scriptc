//! Typed function identities and lexical cells participate in cycle collection.
use super::*;
use std::fmt::Write;

pub(super) fn signature(function: &Function) -> Type {
    Type::Func {
        rest: function.rest,
        params: function.params.iter().map(|p| p.r#type.clone()).collect(),
        ret: Box::new(function.call_result()),
    }
}
pub(super) fn reads_receiver(ty: &Type, module: &Emission<'_>) -> bool {
    module.function_reads_receiver(ty)
}
pub(super) fn collect_types(
    module: &Module,
    callable_functions: &std::collections::HashSet<String>,
) -> Vec<Type> {
    fn visit(ty: &Type, found: &mut Vec<Type>) {
        match ty {
            Type::Func { params, ret, .. } => {
                if found.contains(ty) {
                    return;
                }
                found.push(ty.clone());
                for param in params {
                    visit(param, found);
                }
                visit(ret, found);
            }
            Type::Array { elem } | Type::Set { elem } => visit(elem, found),
            Type::Promise { inner } => visit(inner, found),
            Type::Generator {
                yield_type,
                return_type,
                next_type,
                ..
            } => {
                visit(yield_type, found);
                visit(return_type, found);
                visit(next_type, found);
            }
            Type::Map { key, value } => {
                visit(key, found);
                visit(value, found);
            }
            _ => {}
        }
    }
    let mut found = Vec::new();
    for function in &module.functions {
        if callable_functions.contains(&function.name) {
            visit(&signature(function), &mut found);
        }
        for local in &function.locals {
            visit(&local.r#type, &mut found);
        }
    }
    for record in &module.records {
        for field in &record.fields {
            visit(&field.r#type, &mut found);
        }
        if let Some(value) = &record.index_value {
            visit(value, &mut found);
        }
    }
    for union in &module.unions {
        for arm in &union.arms {
            visit(arm, &mut found);
        }
    }
    for global in &module.globals {
        visit(&global.r#type, &mut found);
    }
    module.visit_expressions(&mut |e| visit(&e.ty(), &mut found));
    found
}
pub(super) fn type_name(ty: &Type, module: &Emission<'_>) -> String {
    format!("NativeFunction{}", module.function_type_id(ty))
}
fn uses_static_storage(ty: &Type, module: &Emission<'_>) -> bool {
    let mut found = false;
    for function in module
        .functions
        .iter()
        .filter(|function| module.callable_function(&function.name) && signature(function) == *ty)
    {
        found = true;
        if function.captures.is_some() {
            return false;
        }
    }
    found
}
pub(super) fn definitions(module: &Emission<'_>, output: &mut String) {
    output.push_str("#[derive(Clone)]\nenum NativeFunctionForward { Forward { original: Option<NativeValue>, properties: Option<runtime::Gc<NativeRecordData>> } }\nimpl runtime::Trace for NativeFunctionForward { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { match self { Self::Forward { original, properties } => { if let Some(value) = original { value.trace_native(tracer); } if let Some(edge) = properties { tracer.edge(edge); } } } } }\nimpl runtime::ClearEdges for NativeFunctionForward { fn clear_edges(&mut self) { match self { Self::Forward { original, properties } => { *original = None; *properties = None; } } } }\n");
    output.push_str("#[derive(Clone)]\nenum NativeFunctionStatic { Forward { original: Option<NativeValue>, properties: Option<runtime::Gc<NativeRecordData>> }, Target { target: usize, properties: Option<runtime::Gc<NativeRecordData>> } }\nimpl runtime::Trace for NativeFunctionStatic { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { match self { Self::Forward { original, properties } => { if let Some(value) = original { value.trace_native(tracer); } if let Some(edge) = properties { tracer.edge(edge); } }, Self::Target { properties, .. } => { if let Some(edge) = properties { tracer.edge(edge); } } } } }\nimpl runtime::ClearEdges for NativeFunctionStatic { fn clear_edges(&mut self) { match self { Self::Forward { original, properties } => { *original = None; *properties = None; }, Self::Target { properties, .. } => { *properties = None; } } } }\n");
    for ty in module.function_types().iter().cloned() {
        let Type::Func { params, ret, rest } = &ty else {
            unreachable!()
        };
        let name = type_name(&ty, module);
        let targets = module
            .functions
            .iter()
            .enumerate()
            .filter(|(_, function)| {
                module.callable_function(&function.name) && signature(function) == ty
            })
            .collect::<Vec<_>>();
        if targets.is_empty() {
            writeln!(output, "type {name} = NativeFunctionForward;").unwrap();
            writeln!(output, "fn properties_{name}(function: &runtime::Gc<{name}>) -> runtime::Gc<NativeRecordData> {{ function.with(|target| match target {{ {name}::Forward {{ properties, .. }} => properties.as_ref().expect(\"scriptc: cleared function properties\").clone(), }}) }}").unwrap();
            let arguments = params
                .iter()
                .enumerate()
                .map(|(i, ty)| format!(", p{i}: {}", rust_type(ty.clone(), module)))
                .collect::<String>();
            let result_type = rust_type((**ret).clone(), module);
            let forwarded = (0..params.len())
                .map(|i| format!(", p{i}"))
                .collect::<String>();
            writeln!(output, "fn call_{name}(function: runtime::Gc<{name}>{arguments}) -> {result_type} {{ call_{name}_with_this(function, NativeValue::Undefined{forwarded}) }}").unwrap();
            let mut boxed_args = params
                .iter()
                .enumerate()
                .take(params.len().saturating_sub(usize::from(*rest)))
                .map(|(i, ty)| values::box_value(ty, &format!("p{i}"), module))
                .collect::<Vec<_>>();
            let extend = if *rest {
                let index = params.len() - 1;
                let Type::Array { elem } = &params[index] else {
                    unreachable!("validated rest ABI")
                };
                let boxed = values::box_value(elem, "item", module);
                format!(
                    "args.extend((0..runtime::array_len(&p{index}) as usize).map(|index| {{ let item = runtime::array_get(&p{index}, index as f64); {boxed} }}));"
                )
            } else {
                String::new()
            };
            let boxed_args = boxed_args.drain(..).collect::<Vec<_>>().join(", ");
            let call = format!(
                "{{ let mut args = vec![{boxed_args}]; {extend} native_value_call_with_this(original.expect(\"scriptc: cleared function adapter\"), receiver, args, \"function adapter\") }}"
            );
            let forward_result = if **ret == Type::Void {
                format!("{{ {call}; }}")
            } else {
                values::checked_value(ret, &call, module)
            };
            writeln!(output, "fn call_{name}_with_this(function: runtime::Gc<{name}>, receiver: NativeValue{arguments}) -> {result_type} {{ let target = function.with(Clone::clone); match target {{ {name}::Forward {{ original, .. }} => {forward_result}, }} }}").unwrap();
            continue;
        }
        if targets
            .iter()
            .all(|(_, function)| function.captures.is_none())
        {
            writeln!(output, "type {name} = NativeFunctionStatic;").unwrap();
            writeln!(output, "fn properties_{name}(function: &runtime::Gc<{name}>) -> runtime::Gc<NativeRecordData> {{ function.with(|target| match target {{ {name}::Forward {{ properties, .. }} | {name}::Target {{ properties, .. }} => properties.as_ref().expect(\"scriptc: cleared function properties\").clone(), }}) }}").unwrap();
            let arguments = params
                .iter()
                .enumerate()
                .map(|(i, ty)| format!(", p{i}: {}", rust_type(ty.clone(), module)))
                .collect::<String>();
            let result_type = rust_type((**ret).clone(), module);
            let forwarded = (0..params.len())
                .map(|i| format!(", p{i}"))
                .collect::<String>();
            writeln!(output, "fn call_{name}(function: runtime::Gc<{name}>{arguments}) -> {result_type} {{ call_{name}_with_this(function, NativeValue::Undefined{forwarded}) }}").unwrap();
            let mut boxed_args = params
                .iter()
                .enumerate()
                .take(params.len().saturating_sub(usize::from(*rest)))
                .map(|(i, ty)| values::box_value(ty, &format!("p{i}"), module))
                .collect::<Vec<_>>();
            let extend = if *rest {
                let index = params.len() - 1;
                let Type::Array { elem } = &params[index] else {
                    unreachable!("validated rest ABI")
                };
                let boxed = values::box_value(elem, "item", module);
                format!(
                    "args.extend((0..runtime::array_len(&p{index}) as usize).map(|index| {{ let item = runtime::array_get(&p{index}, index as f64); {boxed} }}));"
                )
            } else {
                String::new()
            };
            let boxed_args = boxed_args.drain(..).collect::<Vec<_>>().join(", ");
            let forward_call = format!(
                "{{ let mut args = vec![{boxed_args}]; {extend} native_value_call_with_this(original.expect(\"scriptc: cleared function adapter\"), receiver, args, \"function adapter\") }}"
            );
            let forward_result = if **ret == Type::Void {
                format!("{{ {forward_call}; }}")
            } else {
                values::checked_value(ret, &forward_call, module)
            };
            writeln!(output, "fn call_{name}_with_this(function: runtime::Gc<{name}>, receiver: NativeValue{arguments}) -> {result_type} {{ let target = function.with(Clone::clone); match target {{ {name}::Forward {{ original, .. }} => {forward_result}, {name}::Target {{ target, .. }} => match target {{").unwrap();
            for (index, function) in &targets {
                let args = function
                    .reads_receiver()
                    .then(|| "receiver".to_string())
                    .into_iter()
                    .chain((0..params.len()).map(|i| {
                        if classes::lazy_constructor_capture(
                            function,
                            &function.params[i].local_id,
                            module,
                        ) {
                            format!(
                                "NativeClassCapture::Value({})",
                                values::box_value(&params[i], &format!("p{i}"), module)
                            )
                        } else {
                            format!("p{i}")
                        }
                    }))
                    .collect::<Vec<_>>()
                    .join(", ");
                writeln!(
                    output,
                    "{index} => {}({args}),",
                    function_name(&function.name)
                )
                .unwrap();
            }
            output.push_str("_ => unreachable!(\"validated static function target\"), }, } }\n");
            continue;
        }
        writeln!(output, "#[derive(Clone)]\nenum {name} {{").unwrap();
        output.push_str("Forward { original: Option<NativeValue>, properties: Option<runtime::Gc<NativeRecordData>> },\n");
        let static_targets = targets
            .iter()
            .filter(|(_, function)| function.captures.is_none())
            .copied()
            .collect::<Vec<_>>();
        if !static_targets.is_empty() {
            output.push_str(
                "Static { target: usize, properties: Option<runtime::Gc<NativeRecordData>> },\n",
            );
        }
        if targets.is_empty() {
            output.push_str("Unreachable,\n");
        }
        for (index, function) in targets
            .iter()
            .filter(|(_, function)| function.captures.is_some())
        {
            writeln!(
                output,
                "F{index} {{ properties: Option<runtime::Gc<NativeRecordData>>,"
            )
            .unwrap();
            for (i, capture) in function.captures.iter().flatten().enumerate() {
                writeln!(
                    output,
                    "c{i}: Option<runtime::Gc<NativeCell<{}>>>,",
                    rust_type(capture.r#type.clone(), module)
                )
                .unwrap();
            }
            output.push_str("},\n");
        }
        writeln!(output, "}}\nimpl runtime::Trace for {name} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ match self {{").unwrap();
        output.push_str("Self::Forward { original, properties } => { if let Some(value) = original { value.trace_native(tracer); } if let Some(edge) = properties { tracer.edge(edge); } },\n");
        if !static_targets.is_empty() {
            output.push_str("Self::Static { properties, .. } => { if let Some(edge) = properties { tracer.edge(edge); } },\n");
        }
        if targets.is_empty() {
            output.push_str("Self::Unreachable => {},\n");
        }
        for (index, function) in targets
            .iter()
            .filter(|(_, function)| function.captures.is_some())
        {
            let fields = (0..function.captures.as_ref().map_or(0, Vec::len))
                .map(|i| format!("c{i}"))
                .chain(std::iter::once("properties".into()))
                .collect::<Vec<_>>();
            writeln!(output, "Self::F{index} {{ {} }} => {{", fields.join(", ")).unwrap();
            for field in fields {
                writeln!(
                    output,
                    "if let Some(edge) = {field} {{ tracer.edge(edge); }}"
                )
                .unwrap();
            }
            output.push_str("},\n");
        }
        writeln!(output, "}} }} }}\nimpl runtime::ClearEdges for {name} {{ fn clear_edges(&mut self) {{ match self {{").unwrap();
        output.push_str("Self::Forward { original, properties } => { *original = None; *properties = None; },\n");
        if !static_targets.is_empty() {
            output.push_str("Self::Static { properties, .. } => { *properties = None; },\n");
        }
        if targets.is_empty() {
            output.push_str("Self::Unreachable => {},\n");
        }
        for (index, function) in targets
            .iter()
            .filter(|(_, function)| function.captures.is_some())
        {
            let fields = (0..function.captures.as_ref().map_or(0, Vec::len))
                .map(|i| format!("c{i}"))
                .chain(std::iter::once("properties".into()))
                .collect::<Vec<_>>();
            writeln!(output, "Self::F{index} {{ {} }} => {{", fields.join(", ")).unwrap();
            for field in fields {
                writeln!(output, "*{field} = None;").unwrap();
            }
            output.push_str("},\n");
        }
        output.push_str("} } }\n");
        writeln!(output, "fn properties_{name}(function: &runtime::Gc<{name}>) -> runtime::Gc<NativeRecordData> {{ function.with(|target| match target {{").unwrap();
        writeln!(output, "{name}::Forward {{ properties, .. }} => properties.as_ref().expect(\"scriptc: cleared function properties\").clone(),").unwrap();
        if !static_targets.is_empty() {
            writeln!(output, "{name}::Static {{ properties, .. }} => properties.as_ref().expect(\"scriptc: cleared function properties\").clone(),").unwrap();
        }
        if targets.is_empty() {
            writeln!(
                output,
                "{name}::Unreachable => unreachable!(\"scriptc: unallocated function properties\"),"
            )
            .unwrap();
        }
        for (index, _) in targets
            .iter()
            .filter(|(_, function)| function.captures.is_some())
        {
            writeln!(output, "{name}::F{index} {{ properties, .. }} => properties.as_ref().expect(\"scriptc: cleared function properties\").clone(),").unwrap();
        }
        output.push_str("}) }\n");
        let arguments = params
            .iter()
            .enumerate()
            .map(|(i, ty)| format!(", p{i}: {}", rust_type(ty.clone(), module)))
            .collect::<String>();
        let result = rust_type((**ret).clone(), module);
        let forwarded = (0..params.len())
            .map(|i| format!(", p{i}"))
            .collect::<String>();
        writeln!(output, "fn call_{name}(function: runtime::Gc<{name}>{arguments}) -> {result} {{ call_{name}_with_this(function, NativeValue::Undefined{forwarded}) }}").unwrap();
        writeln!(output, "fn call_{name}_with_this(function: runtime::Gc<{name}>, receiver: NativeValue{arguments}) -> {result} {{ let target = function.with(Clone::clone); match target {{").unwrap();
        {
            let mut boxed_args = params
                .iter()
                .enumerate()
                .take(params.len().saturating_sub(usize::from(*rest)))
                .map(|(i, ty)| values::box_value(ty, &format!("p{i}"), module))
                .collect::<Vec<_>>();
            let extend = if *rest {
                let index = params.len() - 1;
                let Type::Array { elem } = &params[index] else {
                    unreachable!("validated rest ABI")
                };
                let boxed = values::box_value(elem, "item", module);
                format!(
                    "args.extend((0..runtime::array_len(&p{index}) as usize).map(|index| {{ let item = runtime::array_get(&p{index}, index as f64); {boxed} }}));"
                )
            } else {
                String::new()
            };
            let boxed_args = boxed_args.drain(..).collect::<Vec<_>>().join(", ");
            let call = format!(
                "{{ let mut args = vec![{boxed_args}]; {extend} native_value_call_with_this(original.expect(\"scriptc: cleared function adapter\"), receiver, args, \"function adapter\") }}"
            );
            let result = if **ret == Type::Void {
                format!("{{ {call}; }}")
            } else {
                values::checked_value(ret, &call, module)
            };
            writeln!(output, "{name}::Forward {{ original, .. }} => {result},").unwrap();
        }
        if targets.is_empty() {
            output.push_str("Self::Unreachable => unreachable!(\"scriptc: signature without an allocated function\"),\n".replace("Self::", &format!("{name}::")).as_str());
        }
        if !static_targets.is_empty() {
            writeln!(output, "{name}::Static {{ target, .. }} => match target {{").unwrap();
            for (index, function) in &static_targets {
                let args = function
                    .reads_receiver()
                    .then(|| "receiver".to_string())
                    .into_iter()
                    .chain((0..params.len()).map(|i| {
                        if classes::lazy_constructor_capture(
                            function,
                            &function.params[i].local_id,
                            module,
                        ) {
                            format!(
                                "NativeClassCapture::Value({})",
                                values::box_value(&params[i], &format!("p{i}"), module)
                            )
                        } else {
                            format!("p{i}")
                        }
                    }))
                    .collect::<Vec<_>>()
                    .join(", ");
                writeln!(
                    output,
                    "{index} => {}({args}),",
                    function_name(&function.name)
                )
                .unwrap();
            }
            output.push_str("_ => unreachable!(\"validated static function target\"), },\n");
        }
        for (index, function) in targets
            .iter()
            .filter(|(_, function)| function.captures.is_some())
        {
            let captures = (0..function.captures.as_ref().map_or(0, Vec::len))
                .map(|i| format!("c{i}"))
                .collect::<Vec<_>>();
            let args = function
                .reads_receiver()
                .then(|| "receiver".to_string())
                .into_iter()
                .chain(
                    captures
                        .iter()
                        .map(|c| format!("{c}.expect(\"scriptc: cleared function capture\")")),
                )
                .chain((0..params.len()).map(|i| {
                    if classes::lazy_constructor_capture(
                        function,
                        &function.params[i].local_id,
                        module,
                    ) {
                        format!(
                            "NativeClassCapture::Value({})",
                            values::box_value(&params[i], &format!("p{i}"), module)
                        )
                    } else {
                        format!("p{i}")
                    }
                }))
                .collect::<Vec<_>>()
                .join(", ");
            writeln!(
                output,
                "{name}::F{index} {{ {}.. }} => {}({args}),",
                captures
                    .iter()
                    .map(|c| format!("{c}, "))
                    .collect::<String>(),
                function_name(&function.name)
            )
            .unwrap();
        }
        output.push_str("} }\n");
    }
    for (index, function) in module.functions.iter().enumerate().filter(|(_, function)| {
        module.callable_function(&function.name) && function.captures.is_none()
    }) {
        let name = type_name(&signature(function), module);
        writeln!(output, "thread_local! {{ static FN_{index}: std::cell::RefCell<Option<runtime::Gc<{name}>>> = const {{ std::cell::RefCell::new(None) }}; }}").unwrap();
    }
    output.push_str("fn clear_function_storage() {\n");
    for (index, _) in module.functions.iter().enumerate().filter(|(_, function)| {
        module.callable_function(&function.name) && function.captures.is_none()
    }) {
        writeln!(
            output,
            "FN_{index}.with(|slot| {{ slot.borrow_mut().take(); }});"
        )
        .unwrap();
    }
    output.push_str("}\n");
}
pub(super) fn closure(
    fn_name: &str,
    captures: &[String],
    ty: &Type,
    module: &Emission<'_>,
) -> String {
    let index = module
        .functions
        .iter()
        .position(|f| f.name == fn_name)
        .unwrap();
    let name = type_name(ty, module);
    if module.functions[index].captures.is_none() {
        let target = if uses_static_storage(ty, module) {
            format!(
                "{name}::Target {{ target: {index}, properties: Some(runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }})) }}"
            )
        } else {
            format!(
                "{name}::Static {{ target: {index}, properties: Some(runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }})) }}"
            )
        };
        return format!(
            "FN_{index}.with(|slot| slot.borrow_mut().get_or_insert_with(|| runtime::Gc::new({target})).clone())"
        );
    }
    let fields = captures
        .iter()
        .enumerate()
        .map(|(i, id)| format!("c{i}: Some({id}.clone())"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "runtime::Gc::new({name}::F{index} {{ properties: Some(runtime::Gc::new(NativeMap {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }})), {fields} }})"
    )
}
