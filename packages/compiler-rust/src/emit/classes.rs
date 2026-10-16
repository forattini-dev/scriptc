//! One traced object identity across the Error inheritance chain.
use super::*;
use std::fmt::Write;

fn undefined(module: &Module, ty: &Type) -> String {
    if *ty == Type::Dyn {
        return "NativeValue::Undefined".into();
    }
    let Type::Union { union_id } = ty else {
        unreachable!("validated optional class slot")
    };
    let tag = module.unions[*union_id]
        .arms
        .iter()
        .position(|a| *a == Type::Undefined)
        .unwrap();
    format!("U{union_id}::V{tag}(())")
}

pub(super) fn definitions(module: &Module, output: &mut String) {
    if module.classes.is_empty() {
        return;
    }
    // Each supported definition executes once at module scope. Constructor
    // values cannot be widened across class identities in this ABI.
    output.push_str("#[derive(Clone, Copy, PartialEq)]\nstruct NativeClass(usize);\nimpl NativeTrace for NativeClass { fn trace_native(&self, _: &mut runtime::Tracer<'_>) {} }\nimpl runtime::ArrayElement for NativeClass {}\n");
    output.push_str("struct NativeError { kind: usize, name: String, message: String, fields: NativeErrorFields }\nenum NativeErrorFields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        writeln!(output, "C{index} {{").unwrap();
        for field in class.fields.iter().skip(5) {
            writeln!(
                output,
                "{}: Option<{}>,",
                field_name(&field.name),
                rust_type(field.r#type.clone(), module)
            )
            .unwrap();
        }
        output.push_str("},\n");
    }
    output.push_str("}\nimpl runtime::Trace for NativeError { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { match &self.fields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        let names = class
            .fields
            .iter()
            .skip(5)
            .map(|f| field_name(&f.name))
            .collect::<Vec<_>>();
        writeln!(
            output,
            "NativeErrorFields::C{index} {{ {} }} => {{",
            names.join(", ")
        )
        .unwrap();
        for name in names {
            writeln!(
                output,
                "if let Some(value) = {name} {{ value.trace_native(tracer); }}"
            )
            .unwrap();
        }
        output.push_str("},\n");
    }
    output.push_str("} } }\nimpl runtime::ClearEdges for NativeError { fn clear_edges(&mut self) { match &mut self.fields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        let names = class
            .fields
            .iter()
            .skip(5)
            .map(|f| field_name(&f.name))
            .collect::<Vec<_>>();
        writeln!(
            output,
            "NativeErrorFields::C{index} {{ {} }} => {{",
            names.join(", ")
        )
        .unwrap();
        for name in names {
            writeln!(output, "*{name} = None;").unwrap();
        }
        output.push_str("},\n");
    }
    output.push_str("} } }\n");
    output.push_str("fn error_string(object: runtime::Gc<NativeError>) -> String { object.with(|e| { if e.name.is_empty() { e.message.clone() } else if e.message.is_empty() { e.name.clone() } else { format!(\"{}: {}\", e.name, e.message) } }) }\n");
    for (index, class) in module.classes.iter().enumerate() {
        let mut builtin = class;
        while !builtin.runtime {
            builtin = module.class(builtin.base.as_ref().unwrap()).unwrap();
        }
        let fields = class
            .fields
            .iter()
            .skip(5)
            .map(|f| format!("{}: None", field_name(&f.name)))
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(output, "fn error_allocate_{index}() -> runtime::Gc<NativeError> {{ runtime::Gc::new(NativeError {{ kind: {index}, name: String::from({:?}), message: String::new(), fields: NativeErrorFields::C{index} {{ {fields} }} }}) }}", builtin.js_name).unwrap();
        let descendants = module
            .classes
            .iter()
            .enumerate()
            .filter(|(_, c)| module.subclass(&c.name, &class.name))
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        let kinds = descendants
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(" | ");
        writeln!(output, "fn error_is_{index}(object: runtime::Gc<NativeError>) -> bool {{ object.with(|object| matches!(object.kind, {kinds})) }}").unwrap();
        for field in class
            .fields
            .iter()
            .filter(|field| !matches!(field.name.as_str(), "%code" | "%hasCause" | "%cause"))
        {
            let name = field_name(&field.name);
            let ty = rust_type(field.r#type.clone(), module);
            if matches!(field.name.as_str(), "name" | "message") {
                writeln!(output, "fn error_get_{index}_{name}(object: runtime::Gc<NativeError>) -> {ty} {{ object.with(|object| object.{}.clone()) }}\nfn error_set_{index}_{name}(object: runtime::Gc<NativeError>, value: {ty}) {{ object.with_mut(|object| object.{} = value); }}", field.name, field.name).unwrap();
                continue;
            }
            writeln!(output, "fn error_get_{index}_{name}(object: runtime::Gc<NativeError>) -> {ty} {{ object.with(|object| match &object.fields {{").unwrap();
            for descendant in &descendants {
                writeln!(output, "NativeErrorFields::C{descendant} {{ {name}, .. }} => {name}.clone().unwrap_or_else(|| {}),", undefined(module, &field.r#type)).unwrap();
            }
            output.push_str("_ => unreachable!(\"scriptc: invalid Error receiver\"), }) }\n");
            writeln!(output, "fn error_set_{index}_{name}(object: runtime::Gc<NativeError>, value: {ty}) {{ object.with_mut(|object| match &mut object.fields {{").unwrap();
            for descendant in &descendants {
                writeln!(
                    output,
                    "NativeErrorFields::C{descendant} {{ {name}, .. }} => *{name} = Some(value),"
                )
                .unwrap();
            }
            output.push_str("_ => unreachable!(\"scriptc: invalid Error receiver\"), }); }\n");
        }
    }
}

pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    let class_index = |name: &str| module.classes.iter().position(|c| c.name == name).unwrap();
    Some(match value {
        Expr::ClassRef { class_name, .. } => format!("NativeClass({})", class_index(class_name)),
        Expr::NewValue {
            args,
            r#type: Type::Object { class_name },
            ..
        }
        | Expr::New {
            class_name, args, ..
        } => {
            let index = class_index(class_name);
            let callee = if let Expr::NewValue { callee, .. } = value {
                format!(
                    "let class = {}; debug_assert!(class.0 == {index});",
                    expr(callee, function, module)
                )
            } else {
                String::new()
            };
            let evaluate = args
                .iter()
                .enumerate()
                .map(|(i, arg)| format!("let arg{i} = {};", expr(arg, function, module)))
                .collect::<String>();
            let args = (0..args.len())
                .map(|i| format!(", arg{i}"))
                .collect::<String>();
            let ctor = function_name(&format!("%{class_name}.constructor"));
            format!(
                "{{ {callee} {evaluate} let object = error_allocate_{index}(); {ctor}(object.clone(){args}); object }}"
            )
        }
        Expr::FieldGet {
            obj,
            class_name,
            field,
            ..
        } => format!(
            "error_get_{}_{}({})",
            class_index(class_name),
            field_name(field),
            expr(obj, function, module)
        ),
        Expr::Upcast { value, .. } => expr(value, function, module),
        Expr::Downcast {
            value,
            r#type: Type::Object { class_name },
            ..
        } => format!(
            "{{ let object = {}; if !error_is_{}(object.clone()) {{ runtime::throw_type_error(\"invalid Error projection\".into()); }} object }}",
            expr(value, function, module),
            class_index(class_name)
        ),
        Expr::InstanceOf {
            value, class_name, ..
        } => format!(
            "error_is_{}({})",
            class_index(class_name),
            expr(value, function, module)
        ),
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "error.new" => {
            let Type::Object { class_name } = r#type else {
                unreachable!("IR validated")
            };
            let index = class_index(class_name);
            format!(
                "{{ let message = {}; let object = error_allocate_{index}(); object.with_mut(|object| object.message = message); object }}",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "error.ctor" => format!(
            "{{ let object = {}; let message = {}; object.with_mut(|object| object.message = message); }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "error.toString" => {
            format!("error_string({})", expr(&args[0], function, module))
        }
        _ => return None,
    })
}
