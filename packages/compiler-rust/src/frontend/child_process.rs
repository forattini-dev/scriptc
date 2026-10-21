//! Native builtin function values retain their identity and normal bindings.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

#[derive(Clone, Copy, PartialEq)]
enum BuiltinFunction {
    ExecFile,
    Promisify,
    PromisifiedExecFile,
}

impl Lowerer<'_> {
    pub(super) fn child_projected_type(&mut self, node: Node) -> Option<Type> {
        if node.kind() == SyntaxKind::CallExpression {
            match self.builtin_function_origin(node.expression(), &mut HashSet::new()) {
                Some(BuiltinFunction::ExecFile) => return Some(Type::Child),
                Some(BuiltinFunction::PromisifiedExecFile) => {
                    return Some(Type::Promise {
                        inner: Box::new(self.exec_file_result()),
                    });
                }
                _ => {}
            }
        }
        let origin = self.builtin_function_origin(node, &mut HashSet::new())?;
        let ret = match origin {
            BuiltinFunction::ExecFile => Type::Child,
            BuiltinFunction::PromisifiedExecFile => Type::Promise {
                inner: Box::new(self.exec_file_result()),
            },
            BuiltinFunction::Promisify => return None,
        };
        Some(Type::Func {
            rest: true,
            params: vec![Type::Array {
                elem: Box::new(Type::Dyn),
            }],
            ret: Box::new(ret),
        })
    }
    pub(super) fn standard_child_symbol(&self, symbol: u32) -> bool {
        symbol != 0
            && self
                .checker
                .sym(SymbolId(symbol))
                .declarations
                .iter()
                .any(|decl| {
                    let file = source_file_info(get_source_file_of_node(*decl));
                    file.file_name.ends_with("/child_process.d.ts")
                        && (file.file_name.contains("/@types/node/")
                            || file.file_name.contains("/bun-types/"))
                })
    }

    fn builtin_function_origin(
        &mut self,
        node: Node,
        active: &mut HashSet<u32>,
    ) -> Option<BuiltinFunction> {
        let imported = if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            self.native_functions.get(&symbol).cloned()
        } else if node.kind() == SyntaxKind::PropertyAccessExpression {
            self.native_namespace(node.expression())
                .map(|module| (module, node.name().text().to_owned()))
        } else {
            None
        };
        if let Some((module, member)) = imported {
            return match (module, member.as_str()) {
                ("child_process", "execFile") => Some(BuiltinFunction::ExecFile),
                ("util", "promisify") => Some(BuiltinFunction::Promisify),
                _ => None,
            };
        }
        if node.kind() == SyntaxKind::ParenthesizedExpression {
            return self.builtin_function_origin(node.expression(), active);
        }
        if node.kind() == SyntaxKind::CallExpression {
            let args = node.arguments();
            if args.len() == 1
                && self.builtin_function_origin(node.expression(), active)
                    == Some(BuiltinFunction::Promisify)
                && matches!(
                    self.builtin_function_origin(args.get(0), active),
                    Some(BuiltinFunction::ExecFile | BuiltinFunction::PromisifiedExecFile)
                )
            {
                return Some(BuiltinFunction::PromisifiedExecFile);
            }
        }
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        if symbol == 0 || !active.insert(symbol) {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        let result = if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && declaration.parent().flags().intersects(NodeFlags::CONST)
            && declaration.name().kind() == SyntaxKind::Identifier
            && !declaration.initializer().is_nil()
        {
            self.builtin_function_origin(declaration.initializer(), active)
        } else {
            None
        };
        active.remove(&symbol);
        result
    }

    fn exec_file_result(&mut self) -> Type {
        let fields = ["stderr", "stdout"]
            .into_iter()
            .map(|name| ir::Field {
                name: name.into(),
                r#type: Type::String,
            })
            .collect::<Vec<_>>();
        let shape_id = self
            .records
            .iter()
            .position(|r| {
                !r.tuple
                    && !self.pending_layout(&Type::Record { shape_id: r.id })
                    && !self.enum_shape(r.id)
                    && !self.callables.contains_key(&r.id)
                    && r.index_value.is_none()
                    && r.fields == fields
            })
            .unwrap_or_else(|| {
                let id = self.records.len();
                self.records.push(ir::Record {
                    id,
                    fields,
                    tuple: false,
                    index_value: None,
                    declared_order: vec!["stdout".into(), "stderr".into()],
                });
                id
            });
        Type::Record { shape_id }
    }

    fn exec_file_value(&mut self, node: Node, promise: bool) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let args = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let ret = if promise {
            Type::Promise {
                inner: Box::new(self.exec_file_result()),
            }
        } else {
            Type::Child
        };
        let mut helper = helpers::Helper::new(
            if promise {
                "promisified_exec_file"
            } else {
                "exec_file"
            },
            vec![args],
            ret.clone(),
            self.loc(node),
        );
        helper.function.rest = true;
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: if promise {
                    "cp.execFilePromise"
                } else {
                    "cp.execFileNative"
                }
                .into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: ret.clone(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        let ty = Type::Func {
            rest: true,
            params: helper
                .function
                .params
                .iter()
                .map(|p| p.r#type.clone())
                .collect(),
            ret: Box::new(ret),
        };
        Ok(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn child_builtin_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        // Alias identifiers must read their actual lexical cell (including TDZ).
        let imported = if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            self.native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| *module == "child_process" && member == "execFile")
        } else if node.kind() == SyntaxKind::PropertyAccessExpression {
            self.native_namespace(node.expression()) == Some("child_process")
                && node.name().text() == "execFile"
        } else {
            false
        };
        if imported {
            self.exec_file_value(node, false).map(Some)
        } else {
            Ok(None)
        }
    }

    pub(super) fn promisify_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.builtin_function_origin(node.expression(), &mut HashSet::new())
            == Some(BuiltinFunction::ExecFile)
        {
            return self.call_value(node).map(Some);
        }
        if self.builtin_function_origin(node.expression(), &mut HashSet::new())
            != Some(BuiltinFunction::Promisify)
        {
            return Ok(None);
        }
        let args = node.arguments();
        if args.len() != 1
            || !matches!(
                self.builtin_function_origin(args.get(0), &mut HashSet::new()),
                Some(BuiltinFunction::ExecFile | BuiltinFunction::PromisifiedExecFile)
            )
        {
            return Err(self.refuse(node, "native promisify requires a proven execFile custom function; general callback wrapping is not ported"));
        }
        let argument = self.expression(args.get(0))?;
        let result = self.exec_file_value(node, true)?;
        let ty = result.ty();
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: argument,
                loc: self.loc(node),
            }],
            result: Box::new(result),
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    pub(super) fn child_property(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = node.expression();
        let name = node.name().text();
        if name == "child"
            && matches!(self.ty(receiver), Ok(Type::Promise { .. }))
            && matches!(self.ty(node), Ok(Type::Child))
        {
            let promise = self.expression(receiver)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "cp.promiseChild".into(),
                args: vec![promise],
                r#type: Type::Child,
                loc: self.loc(node),
            }));
        }
        if matches!(self.ty(receiver), Ok(Type::Child)) {
            if !matches!(name, "pid" | "exitCode" | "killed") {
                return Err(self.refuse(node, "ChildProcess member is not ported"));
            }
            let child = self.expression(receiver)?;
            let result = self.ty(node)?;
            return Ok(Some(Expr::LibCall {
                r#fn: format!("child.{name}"),
                args: vec![child],
                r#type: result,
                loc: self.loc(node),
            }));
        }
        Ok(None)
    }
}
