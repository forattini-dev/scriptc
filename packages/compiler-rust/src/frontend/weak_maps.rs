//! Nominal WeakMap owners and owned, record-key library operations.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

pub(super) const CLASS: &str = "native_builtin_WeakMap";
pub(super) fn instance(ty: &Type) -> bool {
    matches!(ty, Type::Object { class_name } if class_name == CLASS)
}

fn key_type(ty: &Type, records: &[ir::Record], unions: &[ir::Union]) -> bool {
    match ty {
        Type::Dyn
        | Type::F64
        | Type::Bool
        | Type::String
        | Type::Undefined
        | Type::Null
        | Type::Object { .. } => true,
        Type::Record { shape_id } => !records[*shape_id].tuple,
        Type::Union { union_id } => unions[*union_id]
            .arms
            .iter()
            .all(|arm| key_type(arm, records, unions)),
        _ => false,
    }
}
impl Lowerer<'_> {
    pub(super) fn standard_weak_map(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        symbol.name.as_ref() == "WeakMap"
            && symbol.declarations.iter().any(|decl| {
                source_file_info(get_source_file_of_node(*decl))
                    .file_name
                    .ends_with("/lib.es2015.collection.d.ts")
            })
    }
    pub(super) fn weak_map_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !self
                .ty(member.expression())
                .ok()
                .as_ref()
                .is_some_and(instance)
        {
            return Ok(None);
        }
        let receiver = self.expression(member.expression())?;
        let name = member.name().text();
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let arity = match name {
            "get" | "has" | "delete" => 1,
            "set" => 2,
            _ => return Err(self.refuse(node, "WeakMap member is not ported")),
        };
        if arguments.len() != arity
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "WeakMap requires fixed native arguments"));
        }
        let key = self.expression(arguments[0])?;
        let key = self.narrowed(key, arguments[0])?;
        let valid_key = key_type(&key.ty(), &self.records, &self.unions);
        if !valid_key {
            return Err(self.refuse(
                arguments[0],
                &format!(
                    "WeakMap keys require identity-bearing native objects or represented primitive checks; got {:?}",
                    key.ty()
                ),
            ));
        }
        let key = if matches!(key.ty(), Type::Object { .. }) {
            // Class instances already own one stable GC identity. WeakMap only
            // needs that identity, so do not erase the object through Dyn (and
            // accidentally require a dynamic descriptor surface for Symbol
            // methods that the map never observes).
            key
        } else {
            self.coerce(key, Type::Dyn, arguments[0])?
        };
        let mut values = vec![receiver, key];
        if name == "set" {
            let value = self.expression(arguments[1])?;
            values.push(self.coerce(value, Type::Dyn, arguments[1])?);
        }
        let result = if name == "set" {
            values[0].ty()
        } else if name == "get" {
            Type::Dyn
        } else {
            Type::Bool
        };
        let mut helper = helpers::Helper::new(
            &format!("weak_map_{name}"),
            values.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(node),
        );
        let operation = Expr::LibCall {
            r#fn: format!("weakmap.{name}"),
            args: (0..values.len())
                .map(|i| helper.read(&helper.param(i)))
                .collect(),
            r#type: if name == "set" {
                Type::Void
            } else {
                result.clone()
            },
            loc: self.loc(node),
        };
        if name == "set" {
            helper.function.body.push(Stmt::Expression {
                expr: operation,
                loc: self.loc(node),
            });
            helper.function.body.push(Stmt::Return {
                value: Some(helper.read(&helper.param(0))),
                loc: self.loc(node),
            });
        } else {
            helper.function.body.push(Stmt::Return {
                value: Some(operation),
                loc: self.loc(node),
            });
        }
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: result,
            loc: self.loc(node),
        }))
    }
}
