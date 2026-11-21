//! Node filesystem snapshots retain their nominal owning runtime identity.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    /// An immutable local cannot be retagged between a truthy guard and a
    /// property read, even when the checker exposes a wider overload union.
    pub(super) fn guarded_stats_receiver(&mut self, node: Node) -> Option<Expr> {
        fn exits_branch(node: Node) -> bool {
            match node.kind() {
                SyntaxKind::ReturnStatement
                | SyntaxKind::ThrowStatement
                | SyntaxKind::ContinueStatement
                | SyntaxKind::BreakStatement => true,
                SyntaxKind::Block => node
                    .statements()
                    .into_iter()
                    .last()
                    .is_some_and(exits_branch),
                _ => false,
            }
        }
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let local = self.binding(node).ok()?;
        let Type::Union { union_id } = local.r#type else {
            return None;
        };
        if local.mutable
            || !self.unions[union_id]
                .arms
                .iter()
                .all(|arm| matches!(arm, Type::Stats | Type::Null | Type::Undefined))
        {
            return None;
        }
        let tag = self.unions[union_id]
            .arms
            .iter()
            .position(|arm| *arm == Type::Stats)?;
        let symbol = self.symbol(node);
        if symbol == 0 {
            return None;
        }
        let mut child = node;
        let mut parent = node.parent();
        while !parent.is_nil() {
            if parent.kind() == SyntaxKind::Block {
                for statement in parent.statements() {
                    if statement == child {
                        break;
                    }
                    if statement.kind() != SyntaxKind::IfStatement
                        || !statement.else_statement().is_nil()
                        || !exits_branch(statement.then_statement())
                    {
                        continue;
                    }
                    let guard = receivers::reference_node(statement.expression());
                    if guard.kind() == SyntaxKind::PrefixUnaryExpression
                        && guard.operator() == SyntaxKind::ExclamationToken
                    {
                        let guarded = receivers::reference_node(guard.operand());
                        if guarded.kind() == SyntaxKind::Identifier
                            && self.symbol(guarded) == symbol
                        {
                            return Some(Expr::UnionNarrow {
                                union_id: format!("u{union_id}"),
                                tag,
                                value: Box::new(Expr::VarRef {
                                    local_id: local.id,
                                    r#type: Type::Union { union_id },
                                    loc: self.loc(node),
                                }),
                                r#type: Type::Stats,
                                loc: self.loc(node),
                            });
                        }
                    }
                }
            }
            if parent.kind() == SyntaxKind::BinaryExpression
                && parent.operator_token().kind() == SyntaxKind::AmpersandAmpersandToken
                && parent.right() == child
            {
                let guard = receivers::reference_node(parent.left());
                if guard.kind() == SyntaxKind::Identifier && self.symbol(guard) == symbol {
                    return Some(Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(Expr::VarRef {
                            local_id: local.id,
                            r#type: Type::Union { union_id },
                            loc: self.loc(node),
                        }),
                        r#type: Type::Stats,
                        loc: self.loc(node),
                    });
                }
            }
            if matches!(
                parent.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::ClassExpression
            ) {
                break;
            }
            child = parent;
            parent = parent.parent();
        }
        None
    }

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
            // A bare `return;` has a nil expression node. It proves this is
            // not the specialized Stats/null contract; never pass that
            // sentinel through reference stripping or ask it for a kind.
            if value.is_nil() {
                return None;
            }
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

    pub(super) fn standard_statfs_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        symbol.0 != 0
            && self.checker.sym(symbol).name.as_ref() == "StatsFs"
            && self.checker.sym(symbol).declarations.iter().any(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                file.file_name.ends_with("/fs.d.ts")
                    && (file.file_name.contains("/@types/node/")
                        || file.file_name.contains("/bun-types/"))
            })
    }

    pub(super) fn statfs_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let checked = self.checker.get_type_at_location(node.expression());
        if !self.standard_statfs_type(checked) {
            return Ok(None);
        }
        let index = match node.name().text() {
            "type" => 0.0,
            "bsize" => 1.0,
            "blocks" => 2.0,
            "bfree" => 3.0,
            "bavail" => 4.0,
            "files" => 5.0,
            "ffree" => 6.0,
            _ => return Err(self.refuse(node, "StatFs property is not ported")),
        };
        let receiver = self.expression(node.expression())?;
        let snapshot = Type::Array {
            elem: Box::new(Type::F64),
        };
        if receiver.ty() != snapshot {
            return Err(self.refuse(node, "StatFs property needs a represented snapshot"));
        }
        Ok(Some(Expr::LibCall {
            r#fn: "fs.statfsField".into(),
            args: vec![
                receiver,
                Expr::NumLit {
                    value: index,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                },
            ],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    pub(super) fn stats_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let guarded = self.guarded_stats_receiver(node.expression());
        if guarded.is_none() && self.ty(node.expression()).ok() != Some(Type::Stats) {
            return Ok(None);
        }
        let operation = match node.name().text() {
            "size" => "stats.size",
            "mode" => "stats.mode",
            "uid" => "stats.uid",
            "gid" => "stats.gid",
            "atimeMs" => "stats.atimeMs",
            "mtimeMs" => "stats.mtimeMs",
            "dev" => "stats.dev",
            "ino" => "stats.ino",
            "blocks" => "stats.blocks",
            "nlink" => "stats.nlink",
            _ => return Err(self.refuse(node, "Stats property is not ported")),
        };
        let mut receiver = if let Some(guarded) = guarded {
            guarded
        } else {
            self.expression(node.expression())?
        };
        if receiver.ty() != Type::Stats {
            if receiver.ty() != Type::Dyn {
                receiver = self.coerce(receiver, Type::Dyn, node.expression())?;
            }
            receiver = self.coerce(receiver, Type::Stats, node.expression())?;
        }
        if receiver.ty() != Type::Stats {
            return Err(self.refuse(node, "Stats property needs a represented snapshot"));
        }
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
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
                "isFile" | "isDirectory" | "isSymbolicLink" | "isSocket"
            )
        {
            return Ok(None);
        }
        let guarded = self.guarded_stats_receiver(member.expression());
        if guarded.is_none() && self.ty(member.expression()).ok() != Some(Type::Stats) {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "Stats method argument overloads are not ported"));
        }
        let mut receiver = if let Some(guarded) = guarded {
            guarded
        } else {
            self.expression(member.expression())?
        };
        if receiver.ty() != Type::Stats {
            if receiver.ty() != Type::Dyn {
                receiver = self.coerce(receiver, Type::Dyn, member.expression())?;
            }
            receiver = self.coerce(receiver, Type::Stats, member.expression())?;
        }
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
