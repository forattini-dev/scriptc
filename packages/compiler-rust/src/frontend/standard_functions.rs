//! Standard callable values retain identity and their complete argument list.
use super::*;
use helpers::Helper;

fn string_callable() -> Type {
    Type::Func {
        rest: true,
        params: vec![Type::Array {
            elem: Box::new(Type::Dyn),
        }],
        ret: Box::new(Type::String),
    }
}

impl Lowerer<'_> {
    pub(super) fn standard_callable_type(&self, id: TypeId) -> Option<Type> {
        let id = self.checker.ty(id).symbol();
        if id.0 == 0 {
            return None;
        }
        let symbol = self.checker.sym(id);
        (symbol.name.as_ref() == "StringConstructor"
            && !symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                decl.kind() == SyntaxKind::InterfaceDeclaration
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(*decl))
                            .file_name,
                    )
                    .is_some()
            }))
        .then(string_callable)
    }

    fn standard_string(&mut self, node: Node) -> bool {
        node.kind() == SyntaxKind::Identifier && {
            let id = self.symbol(node);
            self.primitive_symbol(id, "String", None)
        }
    }

    pub(super) fn standard_function_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.standard_string(node.expression()) {
            self.call_value(node).map(Some)
        } else {
            Ok(None)
        }
    }

    pub(super) fn standard_function_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if !self.standard_string(node) {
            return Ok(None);
        }
        self.ensure_exception_classes(node)?;
        let Type::Func { params, .. } = string_callable() else {
            unreachable!()
        };
        let mut helper = Helper::new("standard_string", params, Type::String, self.loc(node));
        helper.function.rest = true;
        let arguments = helper.param(0);
        let length = helper.length(&arguments);
        helper.function.body.push(Stmt::If {
            cond: Expr::Bin {
                op: "===".into(),
                left: Box::new(length),
                right: Box::new(helper.number(0.0)),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(Expr::StrLit {
                    value: "".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        let value = Expr::ArrayGet {
            arr: Box::new(helper.read(&arguments)),
            index: Box::new(helper.number(0.0)),
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: "dyn.stringConstructor".into(),
                args: vec![value],
                r#type: Type::String,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: string_callable(),
            loc: self.loc(node),
        }))
    }
}
