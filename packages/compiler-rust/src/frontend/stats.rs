//! Node filesystem snapshots retain their nominal owning runtime identity.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    /// A broad declaration such as ReturnType<typeof lstatSync> includes
    /// overloads not called by the body. Narrow only when every normal return
    /// is null or an immutable result of the one-argument native stat call.
    pub(super) fn precise_stats_return(&mut self, node: Node) -> Option<Type> {
        fn abrupt(node: Node) -> bool {
            match node.kind() {
                SyntaxKind::ReturnStatement | SyntaxKind::ThrowStatement => true,
                SyntaxKind::Block => node.statements().into_iter().last().is_some_and(abrupt),
                SyntaxKind::IfStatement => {
                    !node.else_statement().is_nil()
                        && abrupt(node.then_statement())
                        && abrupt(node.else_statement())
                }
                SyntaxKind::TryStatement => {
                    let finally = node.finally_block();
                    (!finally.is_nil() && abrupt(finally))
                        || (abrupt(node.try_block())
                            && !node.catch_clause().is_nil()
                            && abrupt(node.catch_clause().block()))
                }
                _ => false,
            }
        }
        fn returns(node: Node, out: &mut Vec<Node>) {
            if matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::ClassExpression
                    | SyntaxKind::MethodDeclaration
            ) {
                return;
            }
            if node.kind() == SyntaxKind::ReturnStatement {
                out.push(node.expression());
                return;
            }
            node.for_each_child(&mut |child| {
                returns(child, out);
                false
            });
        }
        let body = node.body();
        if body.is_nil() || !abrupt(body) {
            return None;
        }
        let mut result = Vec::new();
        returns(body, &mut result);
        let mut has_stats = false;
        let mut has_null = false;
        for value in result {
            let value = receivers::reference_node(value);
            if value.kind() == SyntaxKind::NullKeyword {
                has_null = true;
                continue;
            }
            let value = if value.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(value);
                if symbol == 0 {
                    return None;
                }
                let declaration = self
                    .checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .value_declaration;
                if declaration.is_nil()
                    || declaration.kind() != SyntaxKind::VariableDeclaration
                    || !declaration.parent().flags().intersects(NodeFlags::CONST)
                {
                    return None;
                }
                receivers::reference_node(declaration.initializer())
            } else {
                value
            };
            if value.kind() != SyntaxKind::CallExpression || value.arguments().len() != 1 {
                return None;
            }
            let callee = receivers::reference_node(value.expression());
            let native = if callee.kind() == SyntaxKind::Identifier {
                let symbol = self.native_symbol(callee);
                self.native_functions.get(&symbol).cloned()
            } else if callee.kind() == SyntaxKind::PropertyAccessExpression {
                self.native_namespace(callee.expression())
                    .map(|module| (module, callee.name().text().to_string()))
            } else {
                None
            };
            if !matches!(native, Some(("fs", ref name)) if name == "statSync" || name == "lstatSync")
            {
                return None;
            }
            has_stats = true;
        }
        if has_stats && has_null {
            self.intern_union(vec![Type::Stats, Type::Null])
        } else {
            None
        }
    }

    pub(super) fn standard_stats_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        symbol.0 != 0
            && self.checker.sym(symbol).name.as_ref() == "Stats"
            && self.checker.sym(symbol).declarations.iter().any(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                file.file_name.ends_with("/fs.d.ts")
                    && (file.file_name.contains("/@types/node/")
                        || file.file_name.contains("/bun-types/"))
            })
    }

    pub(super) fn stats_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.ty(node.expression()).ok() != Some(Type::Stats) {
            return Ok(None);
        }
        if node.name().text() != "size" {
            return Err(self.refuse(node, "Stats properties beyond size are not ported"));
        }
        let receiver = self.expression(node.expression())?;
        if receiver.ty() != Type::Stats {
            return Err(self.refuse(node, "Stats property needs a represented snapshot"));
        }
        Ok(Some(Expr::LibCall {
            r#fn: "stats.size".into(),
            args: vec![receiver],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    pub(super) fn stats_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = receivers::reference_node(node.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(
                member.name().text(),
                "isFile" | "isDirectory" | "isSymbolicLink"
            )
            || self.ty(member.expression()).ok() != Some(Type::Stats)
        {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "Stats method argument overloads are not ported"));
        }
        let receiver = self.expression(member.expression())?;
        if receiver.ty() != Type::Stats {
            return Err(self.refuse(node, "Stats method needs a represented snapshot"));
        }
        Ok(Some(Expr::LibCall {
            r#fn: format!("stats.{}", member.name().text()),
            args: vec![receiver],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }
}
