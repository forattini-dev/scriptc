//! Typed function identities and lexical cells participate in cycle collection.
use super::*;
use std::fmt::Write;

fn signature(function: &Function) -> Type {
    Type::Func {
        params: function.params.iter().map(|p| p.r#type.clone()).collect(),
        ret: Box::new(function.return_type.clone()),
    }
}
fn types(module: &Module) -> Vec<Type> {
    fn visit(ty: &Type, found: &mut Vec<Type>) {
        match ty {
            Type::Func { params, ret } => {
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
            Type::Map { key, value } => {
                visit(key, found);
                visit(value, found);
            }
            _ => {}
        }
    }
    let mut found = Vec::new();
    for function in &module.functions {
        if function.name != module.entry {
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
pub(super) fn type_name(ty: &Type, module: &Module) -> String {
    format!(
        "NativeFunction{}",
        types(module)
            .iter()
            .position(|t| t == ty)
            .expect("inventoried native function signature")
    )
}
pub(super) fn definitions(module: &Module, output: &mut String) {
    for ty in types(module) {
        let Type::Func { params, ret } = &ty else {
            unreachable!()
        };
        let name = type_name(&ty, module);
        let targets = module
            .functions
            .iter()
            .enumerate()
            .filter(|(_, f)| f.name != module.entry && signature(f) == ty)
            .collect::<Vec<_>>();
        writeln!(output, "#[derive(Clone)]\nenum {name} {{").unwrap();
        if targets.is_empty() {
            output.push_str("Unreachable,\n");
        }
        for (index, function) in &targets {
            writeln!(output, "F{index} {{").unwrap();
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
        if targets.is_empty() {
            output.push_str("Self::Unreachable => {},\n");
        }
        for (index, function) in &targets {
            let fields = (0..function.captures.as_ref().map_or(0, Vec::len))
                .map(|i| format!("c{i}"))
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
        if targets.is_empty() {
            output.push_str("Self::Unreachable => {},\n");
        }
        for (index, function) in &targets {
            let fields = (0..function.captures.as_ref().map_or(0, Vec::len))
                .map(|i| format!("c{i}"))
                .collect::<Vec<_>>();
            writeln!(output, "Self::F{index} {{ {} }} => {{", fields.join(", ")).unwrap();
            for field in fields {
                writeln!(output, "*{field} = None;").unwrap();
            }
            output.push_str("},\n");
        }
        output.push_str("} } }\n");
        let arguments = params
            .iter()
            .enumerate()
            .map(|(i, ty)| format!(", p{i}: {}", rust_type(ty.clone(), module)))
            .collect::<String>();
        writeln!(output, "fn call_{name}(function: runtime::Gc<{name}>{arguments}) -> {} {{ let target = function.with(Clone::clone); match target {{", rust_type((**ret).clone(), module)).unwrap();
        if targets.is_empty() {
            output.push_str("Self::Unreachable => unreachable!(\"scriptc: signature without an allocated function\"),\n".replace("Self::", &format!("{name}::")).as_str());
        }
        for (index, function) in &targets {
            let captures = (0..function.captures.as_ref().map_or(0, Vec::len))
                .map(|i| format!("c{i}"))
                .collect::<Vec<_>>();
            let args = captures
                .iter()
                .map(|c| format!("{c}.expect(\"scriptc: cleared function capture\")"))
                .chain((0..params.len()).map(|i| format!("p{i}")))
                .collect::<Vec<_>>()
                .join(", ");
            writeln!(
                output,
                "{name}::F{index} {{ {} }} => {}({args}),",
                captures.join(", "),
                function_name(&function.name)
            )
            .unwrap();
        }
        output.push_str("} }\n");
    }
    for (index, function) in module
        .functions
        .iter()
        .enumerate()
        .filter(|(_, f)| f.name != module.entry && f.captures.is_none())
    {
        let name = type_name(&signature(function), module);
        writeln!(output, "thread_local! {{ static FN_{index}: std::cell::RefCell<Option<runtime::Gc<{name}>>> = const {{ std::cell::RefCell::new(None) }}; }}").unwrap();
    }
    output.push_str("fn clear_function_storage() {\n");
    for (index, _) in module
        .functions
        .iter()
        .enumerate()
        .filter(|(_, f)| f.name != module.entry && f.captures.is_none())
    {
        writeln!(
            output,
            "FN_{index}.with(|slot| {{ slot.borrow_mut().take(); }});"
        )
        .unwrap();
    }
    output.push_str("}\n");
}
pub(super) fn closure(fn_name: &str, captures: &[String], ty: &Type, module: &Module) -> String {
    let index = module
        .functions
        .iter()
        .position(|f| f.name == fn_name)
        .unwrap();
    let name = type_name(ty, module);
    if module.functions[index].captures.is_none() {
        return format!(
            "FN_{index}.with(|slot| slot.borrow_mut().get_or_insert_with(|| runtime::Gc::new({name}::F{index} {{}})).clone())"
        );
    }
    let fields = captures
        .iter()
        .enumerate()
        .map(|(i, id)| format!("c{i}: Some({id}.clone())"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("runtime::Gc::new({name}::F{index} {{ {fields} }})")
}
