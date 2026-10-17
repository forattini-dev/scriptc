//! Standard-library Sets have typed elements, owning identity and a finite ABI.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    pub(super) fn set_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let info = self.checker.sym(symbol);
        if !matches!(info.name.as_ref(), "Set" | "ReadonlySet")
            || !info.declarations.iter().any(|n| {
                !n.is_nil()
                    && source_file_info(get_source_file_of_node(*n))
                        .file_name
                        .ends_with("/lib.es2015.collection.d.ts")
            })
        {
            return None;
        }
        let args = self.checker.get_type_arguments(id).to_vec();
        if args.len() != 1 {
            return None;
        }
        let elem = self.type_id(args[0])?;
        matches!(elem, Type::String | Type::F64).then_some(Type::Set {
            elem: Box::new(elem),
        })
    }

    pub(super) fn set_new(&mut self, node: Node, expected: Option<Type>) -> Result<Expr, String> {
        let ty = match expected {
            Some(ty) => ty,
            None => self.ty(node)?,
        };
        let Type::Set { elem } = &ty else {
            return Err(self.refuse(node, "Set needs a native element type"));
        };
        let symbol = self.symbol(node.expression());
        if symbol == 0
            || self.bindings.contains_key(&symbol)
            || self.module_bindings.contains_key(&symbol)
        {
            return Err(self.refuse(node, "Set constructor must be the standard library value"));
        }
        let info = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        if info.name.as_ref() != "Set"
            || !info.declarations.iter().any(|n| {
                !n.is_nil()
                    && source_file_info(get_source_file_of_node(*n))
                        .file_name
                        .ends_with("/lib.es2015.collection.d.ts")
            })
        {
            return Err(self.refuse(node, "Set constructor must be the standard library value"));
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1
            || arguments
                .iter()
                .any(|n| n.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "Set accepts one native array seed"));
        }
        let seed = if let Some(arg) = arguments.first() {
            let value = if arg.kind() == SyntaxKind::ArrayLiteralExpression {
                self.expected_expression(*arg, Type::Array { elem: elem.clone() })?
            } else {
                self.expression(*arg)?
            };
            if matches!(value, Expr::UnitLit { .. }) {
                None
            } else if value.ty() == (Type::Array { elem: elem.clone() }) {
                Some(Box::new(value))
            } else {
                return Err(self.refuse(
                    *arg,
                    "Set seed requires a native array; general iterables are not ported",
                ));
            }
        } else {
            None
        };
        Ok(Expr::SetNew {
            seed,
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn set_intrinsic(
        &mut self,
        node: Node,
        receiver: Expr,
        method: &str,
        arguments: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Set { elem } = receiver.ty() else {
            return Err(self.refuse(node, "Set receiver may be undefined"));
        };
        let (types, result) = match method {
            "add" => (vec![*elem], Type::Void),
            "has" | "delete" => (vec![*elem], Type::Bool),
            "clear" => (vec![], Type::Void),
            "size" => (vec![], Type::F64),
            _ => return Err(self.refuse(node, "Set method is not ported")),
        };
        if types.len() != arguments.len() {
            return Err(self.refuse(node, "Set method arity is not ported"));
        }
        let args = arguments
            .into_iter()
            .zip(types)
            .map(|(n, t)| self.expected_expression(n, t))
            .collect::<Result<Vec<_>, _>>()?;
        if method == "add" {
            // Shared IR add returns void; the source call returns its receiver.
            // Keep both receiver and argument evaluation outside the helper.
            let mut helper = helpers::Helper::new(
                "set_add",
                vec![receiver.ty(), args[0].ty()],
                receiver.ty(),
                self.loc(node),
            );
            let set = helper.param(0);
            helper.function.body.push(Stmt::Expression {
                expr: Expr::SetIntrinsic {
                    method: method.into(),
                    receiver: Box::new(helper.read(&set)),
                    args: vec![helper.read(&helper.param(1))],
                    r#type: Type::Void,
                    loc: helper.loc(),
                },
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.finish(&set));
            let result = receiver.ty();
            return Ok(Expr::Call {
                callee,
                args: std::iter::once(receiver).chain(args).collect(),
                r#type: result,
                loc: self.loc(node),
            });
        }
        Ok(Expr::SetIntrinsic {
            method: method.into(),
            receiver: Box::new(receiver),
            args,
            r#type: result,
            loc: self.loc(node),
        })
    }
}
