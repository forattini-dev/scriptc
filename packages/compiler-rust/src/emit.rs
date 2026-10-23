use crate::ir::{Expr, Function, Module, Stmt, Type};
mod async_context;
mod bytes;
mod child_process;
mod classes;
mod collections;
mod exceptions;
mod functions;
mod json_functions;
mod layouts;
mod process;
mod receivers;
mod record_construction;
mod record_storage;
mod regex;
mod sets;
mod storage;
mod symbols;
mod values;
mod weak_maps;

fn rust_type(ty: Type, module: &Module) -> String {
    match ty {
        Type::Dyn | Type::Caught => "NativeValue",
        Type::Promise { .. } => "runtime::JsPromise<NativeValue>",
        Type::Child => "runtime::JsChild",
        Type::Stats => "runtime::JsStats",
        ty @ Type::Func { .. } => {
            return format!("runtime::Gc<{}>", functions::type_name(&ty, module));
        }
        Type::F64 => "f64",
        Type::Bool => "bool",
        Type::Regex => "runtime::JsRegex",
        Type::Symbol => "runtime::JsSymbol",
        Type::Bytes { .. } => "runtime::JsBytes<u8>",
        Type::Object { .. } => "runtime::Gc<NativeInstance>",
        Type::Classval { .. } => "NativeClass",
        Type::String => "runtime::JsString",
        Type::Void => "()",
        Type::Map { key, value } => {
            return format!(
                "runtime::Gc<NativeMap<{}, {}>>",
                rust_type(*key, module),
                rust_type(*value, module)
            );
        }
        Type::Set { elem } => {
            return format!("runtime::Gc<NativeMap<{}, bool>>", rust_type(*elem, module));
        }
        Type::Array { elem } => {
            return format!(
                "runtime::JsArray<{}>",
                if *elem == Type::String {
                    "runtime::JsString".into()
                } else {
                    rust_type(*elem, module)
                }
            );
        }
        Type::Null | Type::Undefined => "()",
        Type::Record { shape_id } => {
            return format!("runtime::Gc<R{shape_id}>");
        }
        Type::Union { union_id } => return format!("U{union_id}"),
    }
    .into()
}

fn field_name(name: &str) -> String {
    format!(
        "f_{}",
        name.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

fn function_name(name: &str) -> String {
    if name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
        return name.into();
    }
    format!(
        "encoded_{}",
        name.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

pub fn rust(module: &Module) -> Result<String, String> {
    crate::ir::validate(module)?;
    let mut output = String::from(
        "// scriptc native IR v13; engine: none\n#![forbid(unsafe_code)]\n#![allow(unused_parens, unused_mut, unused_variables)]\n",
    );
    output.push_str(include_str!("program_support.rs"));
    if uses_runtime(module) {
        output.push_str("\nuse scriptc_runtime as runtime;\nuse runtime::JsStringSource;\n");
        output.push_str(include_str!("heap_support.rs"));
        output.push_str(include_str!("collections_support.rs"));
        layouts::definitions(module, &mut output);
        classes::definitions(module, &mut output);
        functions::definitions(module, &mut output);
        values::definitions(module, &mut output);
        exceptions::definitions(module, &mut output);
        child_process::definitions(module, &mut output);
        json_functions::definitions(module, &mut output);
    }
    storage::definitions(module, &mut output);
    for function in &module.functions {
        let params = function
            .params
            .iter()
            .map(|p| {
                format!(
                    "mut {}: {}",
                    p.local_id,
                    rust_type(p.r#type.clone(), module)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let captures = function
            .captures
            .iter()
            .flatten()
            .map(|p| {
                format!(
                    "{}: runtime::Gc<NativeCell<{}>>, ",
                    p.local_id,
                    rust_type(p.r#type.clone(), module)
                )
            })
            .collect::<String>();
        let receiver = if function.reads_receiver() {
            "native_this: NativeValue, "
        } else {
            ""
        };
        output.push_str(&format!(
            "\nfn {}({receiver}{captures}{params}) -> {} {{\n",
            function_name(&function.name),
            rust_type(function.call_result(), module)
        ));
        if function.is_async {
            output.push_str("let result = runtime::promise_new(); let target = result.clone(); runtime::promise_run_segment(&target, || { let value = (|| {\n");
        }
        for param in &function.params {
            if function
                .locals
                .iter()
                .any(|l| l.id == param.local_id && l.boxed)
            {
                output.push_str(&format!(
                    "let {} = native_cell({});\n",
                    param.local_id, param.local_id
                ));
            }
        }
        for stmt in &function.body {
            statement(stmt, function, module, &mut output);
        }
        if function.is_async {
            output.push_str("})();\n");
            let boxed = if function.return_type == Type::Void {
                "NativeValue::Undefined".into()
            } else {
                values::box_value(&function.return_type, "value", module)
            };
            output.push_str(&format!("let value = {boxed}; native_promise_plain(&value); let _ = runtime::promise_fulfill(&result, value); }}); result\n"));
        }
        output.push_str("}\n");
    }
    if uses_runtime(module) {
        output.push_str(&format!("\nfn main() {{ runtime::init(); let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{ {}(); runtime::run_event_loop(); }})); clear_module_storage(); clear_function_storage(); let error = outcome.err().map(|payload| {{ let caught = runtime::caught_from_panic(payload); native_exception_string(&caught) }}); let failed = runtime::had_unhandled_rejection(); runtime::finish(); if let Some(error) = error {{ eprintln!(\"Uncaught {{error}}\"); std::process::exit(1); }} if failed {{ std::process::exit(1); }} }}\n", module.entry));
    } else {
        output.push_str(&format!("\nfn main() {{ {}(); }}\n", module.entry));
    }
    Ok(output)
}

pub fn uses_runtime(module: &Module) -> bool {
    if module.functions.iter().any(|f| f.is_async) {
        return true;
    }
    fn expr(value: &Expr) -> bool {
        match value {
            Expr::StrLit { .. }
            | Expr::StrConcat { .. }
            | Expr::StrEq { .. }
            | Expr::ToString { .. }
            | Expr::DynFrom { .. }
            | Expr::DynCheck { .. }
            | Expr::DynObjLit { .. }
            | Expr::DynArrLit { .. }
            | Expr::DynKeyGet { .. }
            | Expr::DynTest { .. }
            | Expr::DynScalarEq { .. }
            | Expr::DynInvoke { .. }
            | Expr::DynCall { .. } => true,
            Expr::Intrinsic { name, .. } if name == "promise.resolve" => true,
            Expr::BytesNew { .. }
            | Expr::BytesIntrinsic { .. }
            | Expr::RegexLit { .. }
            | Expr::RegexIntrinsic { .. } => true,
            Expr::ClassRef { .. }
            | Expr::NewValue { .. }
            | Expr::New { .. }
            | Expr::FieldGet { .. }
            | Expr::Upcast { .. }
            | Expr::Downcast { .. }
            | Expr::InstanceOf { .. }
            | Expr::VirtualCall { .. } => true,
            Expr::ArrayLit { .. }
            | Expr::LibCall { .. }
            | Expr::SetNew { .. }
            | Expr::SetIntrinsic { .. } => true,
            Expr::ArrayIntrinsic { .. } | Expr::StringIntrinsic { .. } => true,
            Expr::ArrayGet { .. } => true,
            Expr::MapNew { seed, .. } => seed.iter().any(|p| expr(&p.key) || expr(&p.value)),
            Expr::MapIntrinsic { receiver, args, .. } => expr(receiver) || args.iter().any(expr),
            Expr::RecordKeyGet { obj, key, .. } => expr(obj) || expr(key),
            Expr::Bin { left, right, .. }
            | Expr::UnionEq { left, right, .. }
            | Expr::Logical { left, right, .. } => expr(left) || expr(right),
            Expr::Unary { operand, .. } => expr(operand),
            Expr::Call { args, .. } | Expr::Intrinsic { args, .. } => args.iter().any(expr),
            Expr::Closure { .. } => false,
            Expr::CallValue { callee, args, .. } => expr(callee) || args.iter().any(expr),
            Expr::RecordLit { fields, .. } => fields.iter().any(|f| expr(&f.value)),
            Expr::Sequence { stmts, result, .. } => body(stmts) || expr(result),
            Expr::RecordGet { obj: value, .. }
            | Expr::UnionWrap { value, .. }
            | Expr::UnionNarrow { value, .. }
            | Expr::UnionIsTag { value, .. } => expr(value),
            Expr::Ternary {
                cond, then, else_, ..
            } => expr(cond) || expr(then) || expr(else_),
            _ => false,
        }
    }
    fn body(stmts: &[Stmt]) -> bool {
        stmts.iter().any(|stmt| match stmt {
            Stmt::FieldSet { .. } | Stmt::Throw { .. } | Stmt::TryCatch { .. } => true,
            Stmt::RecordKeySet {
                obj, key, value, ..
            } => expr(obj) || expr(key) || expr(value),
            Stmt::RecordSet { obj, value, .. } => expr(obj) || expr(value),
            Stmt::VarDecl { init, .. } => expr(init),
            Stmt::Assign { value, .. } => expr(value),
            Stmt::Expression { expr: value, .. } => expr(value),
            Stmt::Return { value, .. } => value.as_ref().is_some_and(expr),
            Stmt::Block { body: stmts, .. } => body(stmts),
            Stmt::While {
                cond, body: stmts, ..
            } => expr(cond) || body(stmts),
            Stmt::If {
                cond, then, else_, ..
            } => expr(cond) || body(then) || else_.as_ref().is_some_and(|other| body(other)),
        })
    }
    fn ty(t: &Type) -> bool {
        match t {
            Type::Array { .. }
            | Type::Map { .. }
            | Type::Set { .. }
            | Type::Record { .. }
            | Type::Union { .. }
            | Type::Object { .. } => true,
            Type::String
            | Type::Regex
            | Type::Stats
            | Type::Symbol
            | Type::Bytes { .. }
            | Type::Dyn
            | Type::Promise { .. } => true,
            Type::Func { params, ret, .. } => params.iter().any(ty) || ty(ret),
            _ => false,
        }
    }
    module.functions.len() > 1
        || !module.classes.is_empty()
        || !module.globals.is_empty()
        || !module.records.is_empty()
        || !module.unions.is_empty()
        || module
            .records
            .iter()
            .any(|r| r.fields.iter().any(|f| ty(&f.r#type)))
        || module.unions.iter().any(|u| u.arms.iter().any(ty))
        || module.functions.iter().any(|f| {
            ty(&f.return_type)
                || f.params.iter().any(|p| ty(&p.r#type))
                || f.locals.iter().any(|local| ty(&local.r#type))
                || body(&f.body)
        })
}

fn expr(value: &Expr, function: &Function, module: &Module) -> String {
    if let Some(value) = exceptions::expression(value, function, module) {
        return value;
    }
    if let Some(code) = process::expression(value, function, module) {
        return code;
    }
    if let Some(code) = json_functions::expression(value, function, module) {
        return code;
    }
    if let Some(code) = child_process::expression(value, function, module) {
        return code;
    }
    if let Some(code) = sets::expression(value, function, module) {
        return code;
    }
    if let Some(code) = values::promise_expression(value, function, module) {
        return code;
    }
    if let Some(code) = symbols::expression(value, function, module) {
        return code;
    }
    if let Some(code) = regex::expression(value, function, module) {
        return code;
    }
    if let Some(code) = classes::expression(value, function, module) {
        return code;
    }
    if let Some(code) = collections::expression(value, function, module) {
        return code;
    }
    if let Some(code) = bytes::expression(value, function, module) {
        return code;
    }
    if let Some(code) = weak_maps::expression(value, function, module) {
        return code;
    }
    if let Some(code) = async_context::expression(value, function, module) {
        return code;
    }
    if let Some(code) = values::expression(value, function, module) {
        return code;
    }
    match value {
        Expr::CaughtToDyn { .. }
        | Expr::CaughtNarrow { .. }
        | Expr::CaughtTest { .. }
        | Expr::DynFrom { .. }
        | Expr::DynCheck { .. }
        | Expr::DynObjLit { .. }
        | Expr::DynArrLit { .. }
        | Expr::DynKeyGet { .. }
        | Expr::DynTest { .. }
        | Expr::DynScalarEq { .. }
        | Expr::DynInvoke { .. }
        | Expr::DynCall { .. } => unreachable!("native value expression"),
        Expr::BytesNew { .. } | Expr::BytesIntrinsic { .. } => unreachable!("bytes expression"),
        Expr::RegexLit { .. } | Expr::RegexIntrinsic { .. } => unreachable!("regex expression"),
        Expr::ClassRef { .. }
        | Expr::NewValue { .. }
        | Expr::New { .. }
        | Expr::FieldGet { .. }
        | Expr::Upcast { .. }
        | Expr::Downcast { .. }
        | Expr::InstanceOf { .. }
        | Expr::VirtualCall { .. } => unreachable!("class expression"),
        Expr::ArrayGet { .. }
        | Expr::MapNew { .. }
        | Expr::MapIntrinsic { .. }
        | Expr::RecordKeyGet { .. }
        | Expr::ArrayIntrinsic { .. } => unreachable!("collection expression"),
        Expr::SetNew { .. } | Expr::SetIntrinsic { .. } => unreachable!("Set expression"),
        Expr::Closure {
            fn_name,
            captures,
            r#type,
            ..
        } => functions::closure(fn_name, captures, r#type, module),
        Expr::CallValue { callee, args, .. } => {
            receivers::call(callee, args, None, function, module)
        }
        Expr::Logical {
            op, left, right, ..
        } => format!(
            "({} {op} {})",
            expr(left, function, module),
            expr(right, function, module)
        ),
        Expr::StrEq {
            negated,
            left,
            right,
            ..
        } => format!(
            "({} {} {})",
            expr(left, function, module),
            if *negated { "!=" } else { "==" },
            expr(right, function, module)
        ),
        Expr::UnionEq {
            left,
            right,
            negated,
            ..
        } => {
            let Type::Union { union_id } = left.ty() else {
                unreachable!("IR validated");
            };
            format!(
                "{}union_eq_{union_id}({}, {})",
                if *negated { "!" } else { "" },
                expr(left, function, module),
                expr(right, function, module)
            )
        }
        Expr::StrConcat { left, right, .. } => format!(
            "{{ let left = {}; let right = {}; runtime::string_concat(&left, &right) }}",
            expr(left, function, module),
            expr(right, function, module)
        ),
        Expr::ToString { operand, .. } => {
            let value = expr(operand, function, module);
            match operand.ty() {
                Type::F64 => format!("runtime::JsString::from(js_string_number({value}))"),
                Type::Bool => format!("runtime::JsString::from(({value}).to_string())"),
                Type::Dyn => format!("native_value_string({value})"),
                _ => unreachable!("IR validated"),
            }
        }
        Expr::UnitLit { .. } => "()".into(),
        Expr::Sequence { stmts, result, .. } => {
            let mut output = String::from("{\n");
            for stmt in stmts {
                statement_in(stmt, function, module, &mut output, false);
            }
            output.push_str(&expr(result, function, module));
            output.push('}');
            output
        }
        Expr::RecordLit {
            fields,
            r#type: Type::Record { shape_id },
            ..
        } => {
            if module.records[*shape_id].index_value.is_some() {
                let entries = fields
                    .iter()
                    .map(|f| {
                        format!(
                            "{{ let value = {}; js_dict_set(&mut entries, {:?}.into(), value); }}",
                            expr(&f.value, function, module),
                            f.name
                        )
                    })
                    .collect::<String>();
                return format!(
                    "{{ let mut entries = Vec::new(); {entries} runtime::Gc::new(R{shape_id} {{ overflow: entries }}) }}"
                );
            }
            if record_storage::shared(&module.records[*shape_id]) {
                let entries = fields.iter().map(|f| {
                    let value = expr(&f.value, function, module);
                    if f.absent { format!("let _ = {value};") } else {
                        format!("{{ let value = {value}; native_record_define(&mut entries, {:?}.into(), {}); }}", f.name, values::box_value(&f.value.ty(), "value", module))
                    }
                }).collect::<String>();
                return format!(
                    "{{ let mut entries = Vec::new(); {entries} runtime::Gc::new(NativeRecordData {{ entries }}) }}"
                );
            }
            let keys = fields
                .iter()
                .filter(|f| !f.absent)
                .map(|f| format!("{:?}.into()", f.name))
                .collect::<Vec<_>>()
                .join(", ");
            let fields = fields
                .iter()
                .map(|f| {
                    format!(
                        "{}: Some({})",
                        field_name(&f.name),
                        expr(&f.value, function, module)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("runtime::Gc::new(R{shape_id} {{ own_keys: vec![{keys}], {fields} }})")
        }
        Expr::RecordLit { .. } => unreachable!("IR validated"),
        Expr::RecordGet {
            obj, field, r#type, ..
        } => {
            let Type::Record { shape_id } = obj.ty() else {
                unreachable!("IR validated")
            };
            if record_storage::shared(&module.records[shape_id]) {
                record_storage::read(r#type, &expr(obj, function, module), field, module)
            } else {
                format!(
                    "{{ let object = {}; let value = object.with(|object| object.{}.as_ref().expect(\"scriptc: cleared record\").clone()); value }}",
                    expr(obj, function, module),
                    field_name(field)
                )
            }
        }
        Expr::UnionWrap {
            tag,
            value,
            r#type: Type::Union { union_id },
            ..
        } => format!("U{union_id}::V{tag}({})", expr(value, function, module)),
        Expr::UnionWrap { .. } => unreachable!("IR validated"),
        Expr::UnionNarrow { tag, value, .. } => {
            let Type::Union { union_id } = value.ty() else {
                unreachable!("IR validated");
            };
            format!(
                "match {} {{ U{union_id}::V{tag}(value) => value, _ => panic!(\"invalid narrowed union tag\") }}",
                expr(value, function, module)
            )
        }
        Expr::UnionIsTag {
            tag,
            negated,
            value,
            ..
        } => {
            let Type::Union { union_id } = value.ty() else {
                unreachable!("IR validated");
            };
            format!(
                "{}matches!({}, U{union_id}::V{tag}(_))",
                if *negated { "!" } else { "" },
                expr(value, function, module)
            )
        }
        Expr::Ternary {
            cond, then, else_, ..
        } => format!(
            "(if {} {{ {} }} else {{ {} }})",
            expr(cond, function, module),
            expr(then, function, module),
            expr(else_, function, module)
        ),
        Expr::ArrayLit {
            elems,
            r#type: Type::Array { elem },
            ..
        } => {
            let values = elems
                .iter()
                .map(|value| {
                    if **elem == Type::String {
                        format!("runtime::JsString::from({})", expr(value, function, module))
                    } else {
                        expr(value, function, module)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let element = if **elem == Type::String {
                "runtime::JsString"
            } else {
                &rust_type((**elem).clone(), module)
            };
            format!("runtime::array_new::<{element}>(vec![{values}])")
        }
        Expr::ArrayLit { .. } => unreachable!("IR validated"),
        Expr::StringIntrinsic {
            method,
            receiver,
            args,
            ..
        } => {
            let operation = crate::string_builtins::by_method(method).expect("IR validated");
            let receiver = expr(receiver, function, module);
            let args = args
                .iter()
                .map(|arg| {
                    let value = expr(arg, function, module);
                    if arg.ty() == Type::String {
                        format!(", &({value})")
                    } else {
                        format!(", {value}")
                    }
                })
                .collect::<String>();
            format!("runtime::{}(&({receiver}){args})", operation.runtime)
        }
        Expr::LibCall { r#fn, .. } if r#fn == "dyn.this" => "native_this.clone()".into(),
        Expr::LibCall { r#fn, args, .. } => {
            let builtin = crate::builtins::by_ir(r#fn).expect("IR validated");
            if let crate::builtins::Implementation::FloatBinaryMethod(name) = builtin.implementation
            {
                return format!(
                    "{{ let left = {}; let right = {}; left.{name}(right) }}",
                    expr(&args[0], function, module),
                    expr(&args[1], function, module)
                );
            }
            let args = args
                .iter()
                .map(|arg| match arg.ty() {
                    Type::String => {
                        format!("&runtime::JsString::from({})", expr(arg, function, module))
                    }
                    Type::Array { .. } | Type::Stats => {
                        format!("&({})", expr(arg, function, module))
                    }
                    _ => expr(arg, function, module),
                })
                .collect::<Vec<_>>()
                .join(", ");
            match builtin.implementation {
                crate::builtins::Implementation::Runtime(name) => {
                    format!("runtime::{name}({args})")
                }
                crate::builtins::Implementation::FloatMethod(name) => format!("({args}).{name}()"),
                crate::builtins::Implementation::FloatBinaryMethod(_) => unreachable!(),
            }
        }
        Expr::NumLit { value, .. } => format!("f64::from_bits({}_u64)", value.to_bits()),
        Expr::StrLit { value, .. } => format!("runtime::JsString::from({value:?})"),
        Expr::BoolLit { value, .. } => value.to_string(),
        Expr::VarRef {
            local_id, r#type, ..
        } => {
            if let Some(global) = module.global(local_id) {
                return storage::read(module, global);
            }
            if function.locals.iter().any(|l| l.id == *local_id && l.boxed) {
                return format!(
                    "{local_id}.with(|cell| cell.value.clone().expect(\"scriptc: cleared lexical cell\"))"
                );
            }
            if matches!(
                r#type,
                Type::String
                    | Type::Dyn
                    | Type::Caught
                    | Type::Array { .. }
                    | Type::Map { .. }
                    | Type::Set { .. }
                    | Type::Record { .. }
                    | Type::Union { .. }
                    | Type::Func { .. }
                    | Type::Object { .. }
                    | Type::Regex
                    | Type::Bytes { .. }
                    | Type::Symbol
                    | Type::Promise { .. }
                    | Type::Child
                    | Type::Stats
            ) {
                format!("{local_id}.clone()")
            } else {
                local_id.clone()
            }
        }
        Expr::Bin {
            op, left, right, ..
        } => {
            let array = matches!(
                left.ty(),
                Type::Array { .. }
                    | Type::Record { .. }
                    | Type::Map { .. }
                    | Type::Set { .. }
                    | Type::Object { .. }
                    | Type::Func { .. }
                    | Type::Bytes { .. }
                    | Type::Child
                    | Type::Stats
            );
            let record = matches!(left.ty(), Type::Regex);
            let promise = matches!(left.ty(), Type::Promise { .. });
            let left = expr(left, function, module);
            let right = expr(right, function, module);
            match op.as_str() {
                "===" | "!==" if promise => format!(
                    "(runtime::promise_view_identity(&({left})) {} runtime::promise_view_identity(&({right})))",
                    if op == "!==" { "!=" } else { "==" }
                ),
                "===" | "!==" if array => format!(
                    "{}({left}).ptr_eq(&({right}))",
                    if op == "!==" { "!" } else { "" }
                ),
                "===" | "!==" if record => format!(
                    "{}std::rc::Rc::ptr_eq(&({left}), &({right}))",
                    if op == "!==" { "!" } else { "" }
                ),
                "===" => format!("({left} == {right})"),
                "!==" => format!("({left} != {right})"),
                "**" => format!("js_pow({left}, {right})"),
                _ => format!("({left} {op} {right})"),
            }
        }
        Expr::Unary { op, operand, .. } => format!("({op}({}))", expr(operand, function, module)),
        Expr::Call { callee, args, .. } => format!(
            "{}({})",
            function_name(callee),
            module
                .functions
                .iter()
                .find(|f| &f.name == callee)
                .filter(|f| f.reads_receiver())
                .map(|_| "NativeValue::Undefined".into())
                .into_iter()
                .chain(args.iter().map(|v| expr(v, function, module)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Expr::Intrinsic { name, args, .. } => {
            let args = args
                .iter()
                .map(|arg| match arg.ty() {
                    Type::F64 => format!("js_number({})", expr(arg, function, module)),
                    Type::Bool => format!("({}).to_string()", expr(arg, function, module)),
                    Type::String => format!(
                        "({}).to_utf8_lossy().to_owned()",
                        expr(arg, function, module)
                    ),
                    Type::Void => unreachable!("IR validated"),
                    _ => unreachable!("IR validated"),
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("console({}, &[{args}])", name == "console.error")
        }
    }
}

fn statement(stmt: &Stmt, function: &Function, module: &Module, output: &mut String) {
    statement_in(stmt, function, module, output, false);
}
fn statement_in(
    stmt: &Stmt,
    function: &Function,
    module: &Module,
    output: &mut String,
    protected: bool,
) {
    use std::fmt::Write;
    match stmt {
        Stmt::Throw { value, .. } => {
            writeln!(
                output,
                "runtime::throw_value({});",
                values::box_value(&value.ty(), &expr(value, function, module), module)
            )
            .unwrap();
        }
        Stmt::TryCatch { .. } => exceptions::statement(stmt, function, module, output, protected),
        Stmt::FieldSet {
            obj,
            class_name,
            field,
            value,
            ..
        } => {
            let index = module
                .classes
                .iter()
                .position(|c| c.name == *class_name)
                .unwrap();
            writeln!(
                output,
                "{{ let object = {}; let value = {}; instance_set_{index}_{}(object, value); }}",
                expr(obj, function, module),
                expr(value, function, module),
                field_name(field)
            )
            .unwrap();
        }
        Stmt::RecordKeySet {
            obj, key, value, ..
        } => {
            writeln!(output, "{{ let object = {}; let key = {}; let value = {}; object.with_mut(|object| js_dict_set(&mut object.overflow, key, value)); }}", expr(obj, function, module), expr(key, function, module), expr(value, function, module)).unwrap();
        }
        Stmt::RecordSet {
            obj, field, value, ..
        } => {
            let Type::Record { shape_id } = obj.ty() else {
                unreachable!("IR validated")
            };
            if record_storage::shared(&module.records[shape_id]) {
                writeln!(output, "{{ let object = {}; let value = {}; native_record_set(&object, {:?}.into(), {}); }}", expr(obj, function, module), expr(value, function, module), field, values::box_value(&value.ty(), "value", module)).unwrap();
                return;
            }
            writeln!(
                output,
                "{{ let object = {}; let value = {}; object.with_mut(|object| {{ object.{} = Some(value); if !object.own_keys.iter().any(|key| key == {:?}) {{ object.own_keys.push({:?}.into()); }} }}); }}",
                expr(obj, function, module),
                expr(value, function, module),
                field_name(field), field, field
            )
            .unwrap();
        }
        Stmt::VarDecl { local_id, init, .. } => {
            let local = function
                .locals
                .iter()
                .find(|local| local.id == *local_id)
                .expect("IR validated");
            let mutable = if local.mutable { "mut " } else { "" };
            let ty = rust_type(local.r#type.clone(), module);
            if local.boxed {
                writeln!(
                    output,
                    "let {local_id}: runtime::Gc<NativeCell<{ty}>> = native_cell({});",
                    expr(init, function, module)
                )
                .unwrap();
            } else {
                writeln!(
                    output,
                    "let {mutable}{local_id}: {ty} = {};",
                    expr(init, function, module)
                )
                .unwrap();
            }
        }
        Stmt::Assign {
            local_id, value, ..
        } => {
            if let Some(global) = module.global(local_id) {
                output.push_str(&storage::write(
                    module,
                    function,
                    stmt,
                    global,
                    expr(value, function, module),
                ));
                return;
            }
            if function.locals.iter().any(|l| l.id == *local_id && l.boxed) {
                writeln!(
                    output,
                    "{{ let value = {}; {local_id}.with_mut(|cell| cell.value = Some(value)); }}",
                    expr(value, function, module)
                )
                .unwrap();
            } else {
                writeln!(output, "{local_id} = {};", expr(value, function, module)).unwrap();
            }
        }
        Stmt::Expression { expr: value, .. } => {
            writeln!(output, "{};", expr(value, function, module)).unwrap();
        }
        Stmt::Return { value, .. } => {
            let value = value
                .as_ref()
                .map(|v| expr(v, function, module))
                .unwrap_or_else(|| "()".into());
            if protected {
                writeln!(output, "return runtime::Completion::Return({value});").unwrap();
            } else {
                writeln!(output, "return {value};").unwrap();
            }
        }
        Stmt::If {
            cond, then, else_, ..
        } => {
            writeln!(output, "if {} {{", expr(cond, function, module)).unwrap();
            for stmt in then {
                statement_in(stmt, function, module, output, protected);
            }
            output.push('}');
            if let Some(other) = else_ {
                output.push_str(" else {\n");
                for stmt in other {
                    statement_in(stmt, function, module, output, protected);
                }
                output.push('}');
            }
            output.push('\n');
        }
        Stmt::While { cond, body, .. } => {
            writeln!(output, "while {} {{", expr(cond, function, module)).unwrap();
            for stmt in body {
                statement_in(stmt, function, module, output, protected);
            }
            output.push_str("}\n");
        }
        Stmt::Block { body, .. } => {
            output.push_str("{\n");
            for stmt in body {
                statement_in(stmt, function, module, output, protected);
            }
            output.push_str("}\n");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporary_byte_values_require_the_runtime_without_typed_locals() {
        let loc = crate::ir::Loc {
            file: "temporary.ts".into(),
            start: 0,
            end: 1,
        };
        let module = Module {
            ir_version: crate::ir::VERSION,
            source_file: "temporary.ts".into(),
            entry: "__main".into(),
            records: vec![],
            unions: vec![],
            globals: vec![],
            classes: vec![],
            functions: vec![Function {
                is_async: false,
                rest: false,
                name: "__main".into(),
                params: vec![],
                captures: None,
                return_type: Type::Void,
                locals: vec![],
                loc: loc.clone(),
                body: vec![Stmt::Expression {
                    expr: Expr::Intrinsic {
                        name: "console.log".into(),
                        args: vec![Expr::BytesIntrinsic {
                            method: "length".into(),
                            receiver: Box::new(Expr::BytesNew {
                                source: None,
                                r#type: Type::bytes(),
                                loc: loc.clone(),
                            }),
                            args: vec![],
                            r#type: Type::F64,
                            loc: loc.clone(),
                        }],
                        r#type: Type::Void,
                        loc: loc.clone(),
                    },
                    loc,
                }],
            }],
        };
        crate::ir::validate(&module).unwrap();
        assert!(uses_runtime(&module));
    }
}
