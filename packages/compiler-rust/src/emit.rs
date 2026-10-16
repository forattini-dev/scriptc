use crate::ir::{Expr, Function, Module, Stmt, Type};

fn rust_type(ty: Type) -> &'static str {
    match ty {
        Type::F64 => "f64",
        Type::Bool => "bool",
        Type::String => "String",
        Type::Void => "()",
        Type::Array {
            elem: &Type::String,
        } => "runtime::JsArray<runtime::JsString>",
        Type::Array { elem: &Type::F64 } => "runtime::JsArray<f64>",
        Type::Array { elem: &Type::Bool } => "runtime::JsArray<bool>",
        Type::Array { .. } => unreachable!("IR validated"),
    }
}

pub fn rust(module: &Module) -> Result<String, String> {
    crate::ir::validate(module)?;
    let mut output = String::from(
        "// scriptc native IR v13; engine: none\n#![forbid(unsafe_code)]\n#![allow(unused_parens, unused_mut, unused_variables)]\n",
    );
    output.push_str(include_str!("program_support.rs"));
    if uses_runtime(module) {
        output.push_str("\nuse scriptc_runtime as runtime;\n");
    }
    for function in &module.functions {
        let params = function
            .params
            .iter()
            .map(|p| format!("mut {}: {}", p.local_id, rust_type(p.r#type)))
            .collect::<Vec<_>>()
            .join(", ");
        output.push_str(&format!(
            "\nfn {}({params}) -> {} {{\n",
            function.name,
            rust_type(function.return_type)
        ));
        for stmt in &function.body {
            statement(stmt, function, &mut output);
        }
        output.push_str("}\n");
    }
    if uses_runtime(module) {
        output.push_str(&format!("\nfn main() {{ runtime::init(); let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {}())); let error = outcome.err().map(|payload| {{ let caught = runtime::caught_from_panic(payload); runtime::caught_to_string(&caught).to_string() }}); runtime::finish(); if let Some(error) = error {{ eprintln!(\"Uncaught {{error}}\"); std::process::exit(1); }} }}\n", module.entry));
    } else {
        output.push_str(&format!("\nfn main() {{ {}(); }}\n", module.entry));
    }
    Ok(output)
}

pub fn uses_runtime(module: &Module) -> bool {
    fn expr(value: &Expr) -> bool {
        match value {
            Expr::ArrayLit { .. } | Expr::LibCall { .. } => true,
            Expr::Bin { left, right, .. } => expr(left) || expr(right),
            Expr::Unary { operand, .. } => expr(operand),
            Expr::Call { args, .. } | Expr::Intrinsic { args, .. } => args.iter().any(expr),
            _ => false,
        }
    }
    fn body(stmts: &[Stmt]) -> bool {
        stmts.iter().any(|stmt| match stmt {
            Stmt::VarDecl { init, .. } => expr(init),
            Stmt::Assign { value, .. } => expr(value),
            Stmt::Expression { expr: value, .. } => expr(value),
            Stmt::Return { value, .. } => value.as_ref().is_some_and(expr),
            Stmt::Block { body: stmts, .. } => body(stmts),
            Stmt::If {
                cond, then, else_, ..
            } => expr(cond) || body(then) || else_.as_ref().is_some_and(|other| body(other)),
        })
    }
    module.functions.iter().any(|f| {
        matches!(f.return_type, Type::Array { .. })
            || f.params
                .iter()
                .any(|p| matches!(p.r#type, Type::Array { .. }))
            || f.locals
                .iter()
                .any(|local| matches!(local.r#type, Type::Array { .. }))
            || body(&f.body)
    })
}

fn expr(value: &Expr) -> String {
    match value {
        Expr::ArrayLit {
            elems,
            r#type: Type::Array { elem },
            ..
        } => {
            let values = elems
                .iter()
                .map(|value| {
                    if **elem == Type::String {
                        format!("runtime::JsString::from({})", expr(value))
                    } else {
                        expr(value)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let element = if **elem == Type::String {
                "runtime::JsString"
            } else {
                rust_type(**elem)
            };
            format!("runtime::array_new::<{element}>(vec![{values}])")
        }
        Expr::ArrayLit { .. } => unreachable!("IR validated"),
        Expr::LibCall { r#fn, args, .. } => {
            let builtin = crate::builtins::by_ir(r#fn).expect("IR validated");
            let args = args
                .iter()
                .map(|arg| match arg.ty() {
                    Type::String => format!("&runtime::JsString::from({})", expr(arg)),
                    Type::Array { .. } => format!("&({})", expr(arg)),
                    _ => expr(arg),
                })
                .collect::<Vec<_>>()
                .join(", ");
            let call = format!("runtime::{}({args})", builtin.runtime);
            if builtin.result == Type::String {
                format!("({call}).to_string()")
            } else {
                call
            }
        }
        Expr::NumLit { value, .. } => format!("f64::from_bits({}_u64)", value.to_bits()),
        Expr::StrLit { value, .. } => format!("String::from({value:?})"),
        Expr::BoolLit { value, .. } => value.to_string(),
        Expr::VarRef {
            local_id, r#type, ..
        } => {
            if matches!(r#type, Type::String | Type::Array { .. }) {
                format!("{local_id}.clone()")
            } else {
                local_id.clone()
            }
        }
        Expr::Bin {
            op, left, right, ..
        } => {
            let left = expr(left);
            let right = expr(right);
            match op.as_str() {
                "===" => format!("({left} == {right})"),
                "!==" => format!("({left} != {right})"),
                "**" => format!("js_pow({left}, {right})"),
                _ => format!("({left} {op} {right})"),
            }
        }
        Expr::Unary { op, operand, .. } => format!("({op}({}))", expr(operand)),
        Expr::Call { callee, args, .. } => format!(
            "{callee}({})",
            args.iter().map(expr).collect::<Vec<_>>().join(", ")
        ),
        Expr::Intrinsic { name, args, .. } => {
            let args = args
                .iter()
                .map(|arg| match arg.ty() {
                    Type::F64 => format!("js_number({})", expr(arg)),
                    Type::Bool => format!("({}).to_string()", expr(arg)),
                    Type::String => expr(arg),
                    Type::Void => unreachable!("IR validated"),
                    Type::Array { .. } => unreachable!("IR validated"),
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("console({}, &[{args}])", name == "console.error")
        }
    }
}

fn statement(stmt: &Stmt, function: &Function, output: &mut String) {
    use std::fmt::Write;
    match stmt {
        Stmt::VarDecl { local_id, init, .. } => {
            let local = function
                .locals
                .iter()
                .find(|local| local.id == *local_id)
                .expect("IR validated");
            let mutable = if local.mutable { "mut " } else { "" };
            let ty = rust_type(local.r#type);
            writeln!(output, "let {mutable}{local_id}: {ty} = {};", expr(init)).unwrap();
        }
        Stmt::Assign {
            local_id, value, ..
        } => {
            writeln!(output, "{local_id} = {};", expr(value)).unwrap();
        }
        Stmt::Expression { expr: value, .. } => {
            writeln!(output, "{};", expr(value)).unwrap();
        }
        Stmt::Return { value, .. } => {
            writeln!(
                output,
                "return {};",
                value.as_ref().map(expr).unwrap_or_default()
            )
            .unwrap();
        }
        Stmt::If {
            cond, then, else_, ..
        } => {
            writeln!(output, "if {} {{", expr(cond)).unwrap();
            for stmt in then {
                statement(stmt, function, output);
            }
            output.push('}');
            if let Some(other) = else_ {
                output.push_str(" else {\n");
                for stmt in other {
                    statement(stmt, function, output);
                }
                output.push('}');
            }
            output.push('\n');
        }
        Stmt::Block { body, .. } => {
            output.push_str("{\n");
            for stmt in body {
                statement(stmt, function, output);
            }
            output.push_str("}\n");
        }
    }
}
