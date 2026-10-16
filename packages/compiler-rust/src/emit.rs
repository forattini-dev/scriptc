use crate::ir::{Expr, Function, Module, Stmt, Type};

fn rust_type(ty: Type) -> &'static str {
    match ty {
        Type::F64 => "f64",
        Type::Bool => "bool",
        Type::String => "String",
        Type::Void => "()",
    }
}

pub fn rust(module: &Module) -> Result<String, String> {
    crate::ir::validate(module)?;
    let mut output = String::from(
        "// scriptc native IR v13; engine: none\n#![forbid(unsafe_code)]\n#![allow(unused_parens, unused_mut, unused_variables)]\n",
    );
    output.push_str(include_str!("program_support.rs"));
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
    output.push_str(&format!("\nfn main() {{ {}(); }}\n", module.entry));
    Ok(output)
}

fn expr(value: &Expr) -> String {
    match value {
        Expr::NumLit { value, .. } => format!("f64::from_bits({}_u64)", value.to_bits()),
        Expr::StrLit { value, .. } => format!("String::from({value:?})"),
        Expr::BoolLit { value, .. } => value.to_string(),
        Expr::VarRef {
            local_id, r#type, ..
        } => {
            if *r#type == Type::String {
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
            let ty = match local.r#type {
                Type::F64 => "f64",
                Type::Bool => "bool",
                Type::String => "String",
                Type::Void => unreachable!("IR validated"),
            };
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
