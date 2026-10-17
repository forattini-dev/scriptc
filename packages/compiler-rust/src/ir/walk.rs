//! Exhaustive owned-IR traversal, including types of temporary expressions.
use super::*;
impl Module {
    pub fn visit_expressions(&self, visitor: &mut impl FnMut(&Expr)) {
        for function in &self.functions {
            statements(&function.body, visitor);
        }
    }
}
fn statements(body: &[Stmt], visitor: &mut impl FnMut(&Expr)) {
    for statement in body {
        match statement {
            Stmt::FieldSet { obj, value, .. } | Stmt::RecordSet { obj, value, .. } => {
                expression(obj, visitor);
                expression(value, visitor);
            }
            Stmt::RecordKeySet {
                obj, key, value, ..
            } => {
                expression(obj, visitor);
                expression(key, visitor);
                expression(value, visitor);
            }
            Stmt::VarDecl { init, .. } => expression(init, visitor),
            Stmt::Assign { value, .. } => expression(value, visitor),
            Stmt::Expression { expr, .. } => expression(expr, visitor),
            Stmt::Return { value, .. } => {
                if let Some(value) = value {
                    expression(value, visitor);
                }
            }
            Stmt::While { cond, body, .. } => {
                expression(cond, visitor);
                statements(body, visitor);
            }
            Stmt::If {
                cond, then, else_, ..
            } => {
                expression(cond, visitor);
                statements(then, visitor);
                if let Some(other) = else_ {
                    statements(other, visitor);
                }
            }
            Stmt::Block { body, .. } => statements(body, visitor),
        }
    }
}
fn expression(value: &Expr, visitor: &mut impl FnMut(&Expr)) {
    visitor(value);
    match value {
        Expr::DynFrom { value, .. }
        | Expr::DynCheck { value, .. }
        | Expr::DynTest { value, .. }
        | Expr::Upcast { value, .. }
        | Expr::Downcast { value, .. }
        | Expr::InstanceOf { value, .. }
        | Expr::UnionWrap { value, .. }
        | Expr::UnionNarrow { value, .. }
        | Expr::UnionIsTag { value, .. }
        | Expr::FieldGet { obj: value, .. }
        | Expr::RecordGet { obj: value, .. }
        | Expr::Unary { operand: value, .. }
        | Expr::ToString { operand: value, .. } => expression(value, visitor),
        Expr::DynScalarEq { left, right, .. }
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
            expression(left, visitor);
            expression(right, visitor);
        }
        Expr::DynInvoke { recv, args, .. }
        | Expr::DynCall {
            callee: recv, args, ..
        }
        | Expr::NewValue {
            callee: recv, args, ..
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
            expression(recv, visitor);
            for arg in args {
                expression(arg, visitor);
            }
        }
        Expr::New { args, .. }
        | Expr::LibCall { args, .. }
        | Expr::Intrinsic { args, .. }
        | Expr::Call { args, .. }
        | Expr::ArrayLit { elems: args, .. }
        | Expr::DynArrLit { elems: args, .. } => {
            for arg in args {
                expression(arg, visitor);
            }
        }
        Expr::DynObjLit { fields, .. } => {
            for field in fields {
                expression(&field.key, visitor);
                expression(&field.value, visitor);
            }
        }
        Expr::RecordLit { fields, .. } => {
            for field in fields {
                expression(&field.value, visitor);
            }
        }
        Expr::MapNew { seed, .. } => {
            for pair in seed {
                expression(&pair.key, visitor);
                expression(&pair.value, visitor);
            }
        }
        Expr::SetNew { seed, .. } => {
            if let Some(seed) = seed {
                expression(seed, visitor);
            }
        }
        Expr::Ternary {
            cond, then, else_, ..
        } => {
            expression(cond, visitor);
            expression(then, visitor);
            expression(else_, visitor);
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
