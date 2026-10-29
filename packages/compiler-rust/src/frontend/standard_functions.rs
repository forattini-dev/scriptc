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
    // Bound functions in this chain can have signatures the checker cannot
    // describe. Preserve their owning dynamic value across inferred aliases.
    pub(super) fn bind_intrinsic_value(&mut self, node: Node, seen: &mut HashSet<u32>) -> bool {
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if symbol == 0 || !seen.insert(symbol) {
                return false;
            }
            let declaration = self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .value_declaration;
            return !declaration.is_nil()
                && declaration.kind() == SyntaxKind::VariableDeclaration
                && declaration.type_().is_nil()
                && !declaration.initializer().is_nil()
                && self.bind_intrinsic_value(declaration.initializer(), seen);
        }
        if node.kind() == SyntaxKind::CallExpression {
            let member = node.expression();
            if member.kind() == SyntaxKind::PropertyAccessExpression
                && matches!(member.name().text(), "bind" | "call" | "apply")
            {
                return self.bind_intrinsic_value(member.expression(), seen);
            }
            return self.bind_intrinsic_value(member, seen);
        }
        if node.kind() != SyntaxKind::PropertyAccessExpression || node.name().text() != "bind" {
            return false;
        }
        let receiver = node.expression();
        if receiver.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(receiver);
        self.primitive_symbol(symbol, "Function", None)
    }

    pub(super) fn standard_callable_type(&self, id: TypeId) -> Option<Type> {
        let id = self.checker.ty(id).symbol();
        if id.0 == 0 {
            return None;
        }
        let symbol = self.checker.sym(id);
        let callable = match symbol.name.as_ref() {
            "StringConstructor" => string_callable(),
            "NumberConstructor" => number_constructor::callable(),
            _ => return None,
        };
        (!symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                decl.kind() == SyntaxKind::InterfaceDeclaration
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(*decl))
                            .file_name,
                    )
                    .is_some()
            }))
        .then_some(callable)
    }

    fn standard_string(&mut self, node: Node) -> bool {
        node.kind() == SyntaxKind::Identifier && {
            let id = self.symbol(node);
            self.primitive_symbol(id, "String", None)
        }
    }

    pub(super) fn standard_function_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.standard_string(node.expression()) || self.standard_number(node.expression()) {
            self.call_value(node).map(Some)
        } else {
            Ok(None)
        }
    }

    pub(super) fn standard_function_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "bind"
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let symbol = self.symbol(node.expression());
                self.primitive_symbol(symbol, "Function", None)
            }
        {
            // Function.bind is inherited from Function.prototype. Reading the
            // same intrinsic from a represented function keeps this within the
            // existing dynamic-property IR contract.
            let mut helper =
                Helper::new("function_bind_anchor", vec![], Type::Void, self.loc(node));
            helper.function.body.push(Stmt::Return {
                value: None,
                loc: helper.loc(),
            });
            let name = self.install_helper(helper.function);
            let anchor = Expr::Closure {
                fn_name: name,
                captures: vec![],
                r#type: Type::Func {
                    params: vec![],
                    ret: Box::new(Type::Void),
                    rest: false,
                },
                loc: self.loc(node),
            };
            let anchor = self.coerce(anchor, Type::Dyn, node)?;
            return Ok(Some(Expr::DynKeyGet {
                value: Box::new(anchor),
                key: Box::new(Expr::StrLit {
                    value: "bind".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        if self.standard_number(node) {
            return self.number_constructor_value(node).map(Some);
        }
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
