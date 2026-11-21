//! Exhaustive mutable traversal of expressions in the portable IR.
use super::*;

pub(crate) fn function(function: &mut Function, visitor: &mut impl FnMut(&mut Expr)) {
    statements_mut(&mut function.body, visitor);
}

fn statements_mut(body: &mut [Stmt], visitor: &mut impl FnMut(&mut Expr)) {
    for statement in body {
        match statement {
            Stmt::GeneratorForOf {
                generator, body, ..
            } => {
                expression_mut(generator, visitor);
                statements_mut(body, visitor);
            }
            Stmt::Switch { disc, cases, .. } => {
                expression_mut(disc, visitor);
                for case in cases {
                    if let Some(test) = &mut case.test {
                        expression_mut(test, visitor);
                    }
                    statements_mut(&mut case.body, visitor);
                }
            }
            Stmt::Throw { value, .. } => expression_mut(value, visitor),
            Stmt::ArraySet {
                arr, index, value, ..
            }
            | Stmt::BytesSet {
                arr, index, value, ..
            } => {
                expression_mut(arr, visitor);
                expression_mut(index, visitor);
                expression_mut(value, visitor);
            }
            Stmt::ArraySetLength { arr, length, .. } => {
                expression_mut(arr, visitor);
                expression_mut(length, visitor);
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                statements_mut(try_body, visitor);
                if let Some(body) = catch_body {
                    statements_mut(body, visitor);
                }
                if let Some(body) = finally_body {
                    statements_mut(body, visitor);
                }
            }
            Stmt::FieldSet { obj, value, .. } | Stmt::RecordSet { obj, value, .. } => {
                expression_mut(obj, visitor);
                expression_mut(value, visitor);
            }
            Stmt::RecordKeySet {
                obj, key, value, ..
            } => {
                expression_mut(obj, visitor);
                expression_mut(key, visitor);
                expression_mut(value, visitor);
            }
            Stmt::Break { .. } | Stmt::Continue { .. } => {}
            Stmt::VarDecl { init, .. } => expression_mut(init, visitor),
            Stmt::Assign { value, .. } => expression_mut(value, visitor),
            Stmt::Expression { expr, .. } => expression_mut(expr, visitor),
            Stmt::Return { value, .. } => {
                if let Some(value) = value {
                    expression_mut(value, visitor);
                }
            }
            Stmt::While { cond, body, .. } => {
                expression_mut(cond, visitor);
                statements_mut(body, visitor);
            }
            Stmt::If {
                cond, then, else_, ..
            } => {
                expression_mut(cond, visitor);
                statements_mut(then, visitor);
                if let Some(other) = else_ {
                    statements_mut(other, visitor);
                }
            }
            Stmt::Block { body, .. } => statements_mut(body, visitor),
        }
    }
}
fn expression_mut(value: &mut Expr, visitor: &mut impl FnMut(&mut Expr)) {
    visitor(value);
    match value {
        Expr::Yield { value, .. }
        | Expr::YieldStar {
            generator: value, ..
        }
        | Expr::Await { value, .. }
        | Expr::CaughtToDyn { value, .. }
        | Expr::CaughtNarrow { value, .. }
        | Expr::CaughtTest { value, .. }
        | Expr::DynFrom { value, .. }
        | Expr::DynCheck { value, .. }
        | Expr::DynIterN { value, .. }
        | Expr::DynTest { value, .. }
        | Expr::Upcast { value, .. }
        | Expr::Downcast { value, .. }
        | Expr::InstanceOf { value, .. }
        | Expr::UnionWrap { value, .. }
        | Expr::UnionNarrow { value, .. }
        | Expr::UnionProject { value, .. }
        | Expr::UnionIsTag { value, .. }
        | Expr::FieldGet { obj: value, .. }
        | Expr::RecordGet { obj: value, .. }
        | Expr::Unary { operand: value, .. }
        | Expr::ToString { operand: value, .. } => expression_mut(value, visitor),
        Expr::GeneratorNext {
            generator, value, ..
        } => {
            expression_mut(generator, visitor);
            expression_mut(value, visitor);
        }
        Expr::GeneratorReturn {
            generator, value, ..
        } => {
            expression_mut(generator, visitor);
            if let Some(value) = value {
                expression_mut(value, visitor);
            }
        }
        Expr::DynScalarEq { left, right, .. }
        | Expr::DynLooseEq { left, right, .. }
        | Expr::Logical { left, right, .. }
        | Expr::StrEq { left, right, .. }
        | Expr::StrConcat { left, right, .. }
        | Expr::UnionEq { left, right, .. }
        | Expr::Bin { left, right, .. }
        | Expr::DynKeyGet {
            value: left,
            key: right,
            ..
        }
        | Expr::RecordKeyGet {
            obj: left,
            key: right,
            ..
        }
        | Expr::ArrayGet {
            arr: left,
            index: right,
            ..
        } => {
            expression_mut(left, visitor);
            expression_mut(right, visitor);
        }
        Expr::DynInvoke { recv, args, .. }
        | Expr::DynCall {
            callee: recv, args, ..
        }
        | Expr::NewValue {
            callee: recv, args, ..
        }
        | Expr::BytesIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::RegexIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::MapIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::StringIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::ArrayIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::SetIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::CallValue {
            callee: recv, args, ..
        } => {
            expression_mut(recv, visitor);
            for arg in args {
                expression_mut(arg, visitor);
            }
        }
        Expr::VirtualCall { args, .. }
        | Expr::New { args, .. }
        | Expr::LibCall { args, .. }
        | Expr::Intrinsic { args, .. }
        | Expr::Call { args, .. }
        | Expr::ArrayLit { elems: args, .. }
        | Expr::DynArrLit { elems: args, .. } => {
            for arg in args {
                expression_mut(arg, visitor);
            }
        }
        Expr::DynObjLit { fields, .. } => {
            for field in fields {
                expression_mut(&mut field.key, visitor);
                expression_mut(&mut field.value, visitor);
            }
        }
        Expr::Sequence { stmts, result, .. } => {
            statements_mut(stmts, visitor);
            expression_mut(result, visitor);
        }
        Expr::RecordLit { fields, .. } => {
            for field in fields {
                expression_mut(&mut field.value, visitor);
            }
        }
        Expr::MapNew { seed, .. } => {
            for pair in seed {
                expression_mut(&mut pair.key, visitor);
                expression_mut(&mut pair.value, visitor);
            }
        }
        Expr::BytesNew { source: seed, .. } | Expr::SetNew { seed, .. } => {
            if let Some(seed) = seed {
                expression_mut(seed, visitor);
            }
        }
        Expr::Ternary {
            cond, then, else_, ..
        } => {
            expression_mut(cond, visitor);
            expression_mut(then, visitor);
            expression_mut(else_, visitor);
        }
        Expr::ClassCreate {
            parent, captures, ..
        } => {
            if let Some(parent) = parent {
                expression_mut(parent, visitor);
            }
            for capture in captures {
                expression_mut(capture, visitor);
            }
        }
        Expr::ClassRef { .. }
        | Expr::RegexLit { .. }
        | Expr::Closure { .. }
        | Expr::UnitLit { .. }
        | Expr::NumLit { .. }
        | Expr::StrLit { .. }
        | Expr::BoolLit { .. }
        | Expr::VarRef { .. } => {}
    }
}
