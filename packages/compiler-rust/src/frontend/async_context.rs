//! Nominal store identity and context operations over owned native values.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

pub(super) const CLASS: &str = "native_builtin_AsyncLocalStorage";
pub(super) const HANDLE: &str = "[[AsyncContextHandle]]";

pub(super) fn instance(ty: &Type) -> bool {
    matches!(ty, Type::Object { class_name } if class_name == CLASS)
}

impl Lowerer<'_> {
    pub(super) fn standard_async_context(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        symbol.name.as_ref() == "AsyncLocalStorage"
            && symbol.declarations.iter().any(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                let path = &file.file_name;
                path.ends_with("/async_hooks.d.ts")
                    && (path.contains("/@types/node/") || path.contains("/bun-types/"))
            })
    }

    pub(super) fn async_context_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
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
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let name = member.name().text();
        if !matches!(name, "run" | "getStore")
            || (name == "getStore" && !args.is_empty())
            || (name == "run" && args.len() < 2)
        {
            return Err(self.refuse(node, "AsyncLocalStorage member or arguments are not ported"));
        }
        if args
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "AsyncLocalStorage iterable call spreads are not ported",
            ));
        }
        // Helper parameters snapshot the receiver and every argument before
        // entering the context. Callback/argument effects observe the caller.
        let mut values = vec![receiver];
        if name == "run" {
            values.push(self.expected_expression(args[0], Type::Dyn)?);
            let callback = self.expression(args[1])?;
            if !matches!(callback.ty(), Type::Func { .. } | Type::Dyn) {
                return Err(self.refuse(
                    args[1],
                    "AsyncLocalStorage.run needs a represented callback",
                ));
            }
            values.push(self.coerce(callback, Type::Dyn, args[1])?);
            for arg in args.iter().skip(2) {
                values.push(self.expected_expression(*arg, Type::Dyn)?);
            }
        }
        let mut helper = helpers::Helper::new(
            &format!("async_context_{name}"),
            values.iter().map(Expr::ty).collect(),
            Type::Dyn,
            self.loc(node),
        );
        let handle = Expr::DynCheck {
            value: Box::new(Expr::FieldGet {
                obj: Box::new(Expr::VarRef {
                    local_id: "p0".into(),
                    r#type: values[0].ty(),
                    loc: self.loc(node),
                }),
                class_name: CLASS.into(),
                field: HANDLE.into(),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }),
            r#type: Type::F64,
            loc: self.loc(node),
        };
        let mut operations = vec![handle];
        if name == "run" {
            operations.push(Expr::VarRef {
                local_id: "p1".into(),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
            operations.push(Expr::VarRef {
                local_id: "p2".into(),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
            let forwarded = Expr::DynArrLit {
                elems: (3..values.len())
                    .map(|i| Expr::VarRef {
                        local_id: format!("p{i}"),
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    })
                    .collect(),
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            operations.push(forwarded);
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: if name == "run" { "als.run" } else { "als.get" }.into(),
                args: operations,
                r#type: Type::Dyn,
                loc: self.loc(node),
            }),
            loc: self.loc(node),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
}
