//! One traced instance identity across ordinary and Error class hierarchies.
use super::*;
use std::fmt::Write;

fn undefined(module: &Emission<'_>, ty: &Type) -> String {
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

pub(super) fn definitions(module: &Emission<'_>, output: &mut String) {
    if module.classes.is_empty() {
        return;
    }
    // Each supported definition executes once at module scope. Constructor
    // values cannot be widened across class identities in this ABI.
    output.push_str("#[derive(Clone, Copy, PartialEq)]\nstruct NativeClass(usize);\nimpl NativeTrace for NativeClass { fn trace_native(&self, _: &mut runtime::Tracer<'_>) {} }\nimpl runtime::ArrayElement for NativeClass {}\n");
    output.push_str("struct NativeErrorData { name: runtime::JsString, message: runtime::JsString, own: Vec<(runtime::JsString, NativeValue)> }\nstruct NativeInstance { kind: usize, error: Option<NativeErrorData>, fields: NativeInstanceFields }\nenum NativeInstanceFields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        writeln!(output, "C{index} {{").unwrap();
        for field in class.fields.iter().skip(module.class_header_len(class)) {
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
    output.push_str("}\nimpl runtime::Trace for NativeInstance { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { if let Some(error) = &self.error { for (_, value) in &error.own { value.trace_native(tracer); } } match &self.fields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        let names = class
            .fields
            .iter()
            .skip(module.class_header_len(class))
            .map(|f| field_name(&f.name))
            .collect::<Vec<_>>();
        writeln!(
            output,
            "NativeInstanceFields::C{index} {{ {} }} => {{",
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
    output.push_str("} } }\nimpl runtime::ClearEdges for NativeInstance { fn clear_edges(&mut self) { if let Some(error) = &mut self.error { error.own.clear(); } match &mut self.fields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        let names = class
            .fields
            .iter()
            .skip(module.class_header_len(class))
            .map(|f| field_name(&f.name))
            .collect::<Vec<_>>();
        writeln!(
            output,
            "NativeInstanceFields::C{index} {{ {} }} => {{",
            names.join(", ")
        )
        .unwrap();
        for name in names {
            writeln!(output, "*{name} = None;").unwrap();
        }
        output.push_str("},\n");
    }
    output.push_str("} } }\n");
    output.push_str("fn error_string(object: runtime::Gc<NativeInstance>) -> runtime::JsString { object.with(|object| { let e = object.error.as_ref().expect(\"validated Error receiver\"); if e.name.is_empty() { e.message.clone() } else if e.message.is_empty() { e.name.clone() } else { runtime::string_concat(&runtime::string_concat(&e.name, &runtime::string(\": \")), &e.message) } }) }\n");
    for (index, class) in module.classes.iter().enumerate() {
        let mut builtin = class;
        while let Some(base) = &builtin.base {
            builtin = module.class(base).unwrap();
        }
        let error = if builtin.runtime {
            // Native subclasses inherit the builtin Error name, not their class name.
            let mut native = class;
            while !native.runtime {
                native = module.class(native.base.as_ref().unwrap()).unwrap();
            }
            format!(
                "Some(NativeErrorData {{ name: runtime::JsString::from({:?}), message: runtime::JsString::default(), own: Vec::new() }})",
                native.js_name
            )
        } else {
            "None".into()
        };
        let fields = class
            .fields
            .iter()
            .skip(module.class_header_len(class))
            .map(|f| format!("{}: None", field_name(&f.name)))
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(output, "fn instance_allocate_{index}() -> runtime::Gc<NativeInstance> {{ runtime::Gc::new(NativeInstance {{ kind: {index}, error: {error}, fields: NativeInstanceFields::C{index} {{ {fields} }} }}) }}").unwrap();
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
        writeln!(output, "fn instance_is_{index}(object: runtime::Gc<NativeInstance>) -> bool {{ object.with(|object| matches!(object.kind, {kinds})) }}").unwrap();
        for field in class
            .fields
            .iter()
            .filter(|field| !field.name.starts_with('%'))
        {
            let name = field_name(&field.name);
            let ty = rust_type(field.r#type.clone(), module);
            if module.class_header_len(class) != 0
                && matches!(field.name.as_str(), "name" | "message")
            {
                writeln!(output, "fn instance_get_{index}_{name}(object: runtime::Gc<NativeInstance>) -> {ty} {{ object.with(|object| object.error.as_ref().expect(\"validated Error receiver\").{}.clone()) }}\nfn instance_set_{index}_{name}(object: runtime::Gc<NativeInstance>, value: {ty}) {{ object.with_mut(|object| object.error.as_mut().expect(\"validated Error receiver\").{} = value); }}", field.name, field.name).unwrap();
                continue;
            }
            writeln!(output, "fn instance_get_{index}_{name}(object: runtime::Gc<NativeInstance>) -> {ty} {{ object.with(|object| match &object.fields {{").unwrap();
            for descendant in &descendants {
                writeln!(output, "NativeInstanceFields::C{descendant} {{ {name}, .. }} => {name}.clone().unwrap_or_else(|| {}),", undefined(module, &field.r#type)).unwrap();
            }
            output.push_str("_ => unreachable!(\"scriptc: invalid class receiver\"), }) }\n");
            writeln!(output, "fn instance_set_{index}_{name}(object: runtime::Gc<NativeInstance>, value: {ty}) {{ object.with_mut(|object| match &mut object.fields {{").unwrap();
            for descendant in &descendants {
                writeln!(
                    output,
                    "NativeInstanceFields::C{descendant} {{ {name}, .. }} => *{name} = Some(value),"
                )
                .unwrap();
            }
            output.push_str("_ => unreachable!(\"scriptc: invalid class receiver\"), }); }\n");
        }
    }
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let class_index = |name: &str| module.classes.iter().position(|c| c.name == name).unwrap();
    Some(match value {
        Expr::VirtualCall {
            class_name,
            method,
            args,
            ..
        } => {
            let evaluate = args
                .iter()
                .enumerate()
                .map(|(index, arg)| format!("let arg{index} = {};", expr(arg, function, module)))
                .collect::<String>();
            let arguments = (0..args.len())
                .map(|index| format!("arg{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            let cases = module
                .classes
                .iter()
                .enumerate()
                .filter(|(_, class)| module.subclass(&class.name, class_name))
                .map(|(index, class)| {
                    let target = module
                        .method(&class.name, method)
                        .expect("validated inherited dispatch");
                    format!("{index} => {}({arguments}),", function_name(&target.name))
                })
                .collect::<String>();
            format!(
                "{{ {evaluate} let kind = arg0.with(|object| object.kind); match kind {{ {cases} _ => unreachable!(\"validated native method receiver\"), }} }}"
            )
        }
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
                "{{ {callee} {evaluate} let object = instance_allocate_{index}(); {ctor}(object.clone(){args}); object }}"
            )
        }
        Expr::FieldGet {
            obj,
            class_name,
            field,
            ..
        } => format!(
            "instance_get_{}_{}({})",
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
            "{{ let object = {}; if !instance_is_{}(object.clone()) {{ runtime::throw_type_error(\"invalid class projection\".into()); }} object }}",
            expr(value, function, module),
            class_index(class_name)
        ),
        Expr::InstanceOf {
            value, class_name, ..
        } => format!(
            "instance_is_{}({})",
            class_index(class_name),
            expr(value, function, module)
        ),
        Expr::LibCall { r#fn, args, .. }
            if matches!(r#fn.as_str(), "dyn.classInstanceof" | "dyn.errInstanceof") =>
        {
            let Expr::StrLit { value, .. } = &args[1] else {
                unreachable!("validated class identity")
            };
            format!(
                "match {} {{ NativeValue::Instance(object) => instance_is_{}(object), _ => false }}",
                expr(&args[0], function, module),
                class_index(value)
            )
        }
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "error.new" => {
            let Type::Object { class_name } = r#type else {
                unreachable!("IR validated")
            };
            let index = class_index(class_name);
            format!(
                "{{ let message = {}; let object = instance_allocate_{index}(); object.with_mut(|object| object.error.as_mut().expect(\"validated Error receiver\").message = message); object }}",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "error.ctor" => format!(
            "{{ let object = {}; let message = {}; object.with_mut(|object| object.error.as_mut().expect(\"validated Error receiver\").message = message); }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "error.toString" => {
            format!("error_string({})", expr(&args[0], function, module))
        }
        _ => return None,
    })
}
