//! Source receivers are values, separate from ordinary function argument slots.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

#[derive(Clone, Copy)]
pub(super) enum Boundary {
    Namespace,
    Getter,
}
impl Boundary {
    fn reason(self) -> &'static str {
        match self {
            Self::Namespace => "namespace method this requires a native namespace receiver",
            Self::Getter => "getter-returned callable this requires a retained accessor reference",
        }
    }
}
pub(super) struct PendingCall {
    pub ty: Type,
    pub loc: Loc,
    pub boundary: Boundary,
}

/// Parentheses and type-only assertions retain a JavaScript call reference.
pub(super) fn reference_node(mut node: Node) -> Node {
    while matches!(
        node.kind(),
        SyntaxKind::ParenthesizedExpression
            | SyntaxKind::AsExpression
            | SyntaxKind::TypeAssertionExpression
            | SyntaxKind::SatisfiesExpression
    ) {
        node = node.expression();
    }
    node
}

pub(super) fn parameters(node: Node) -> Vec<Node> {
    node.parameters()
        .into_iter()
        .filter(|p| p.name().text() != "this")
        .collect()
}

/// Arrows borrow their enclosing receiver; ordinary nested functions and classes
/// introduce a new receiver. Include parameter defaults in the owning scope.
pub(super) fn reads_this(node: Node) -> bool {
    fn visit(node: Node, root: bool) -> bool {
        if node.kind() == SyntaxKind::ThisKeyword {
            return true;
        }
        if !root
            && matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::ClassExpression
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::GetAccessor
                    | SyntaxKind::SetAccessor
            )
        {
            return false;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            found |= visit(child, false);
            false
        });
        found
    }
    visit(node, true)
}

fn strict(node: Node) -> bool {
    let file = get_source_file_of_node(node);
    let info = source_file_info(file);
    let format = program::get_source_file_meta_data(&info.path).implied_node_format;
    if !commonjs::is_module(file)
        && (info.file_name.ends_with(".mjs")
            || info.file_name.ends_with(".mts")
            || (!info.external_module_indicator.is_nil() && info.external_module_indicator != file)
            || format == source_frontend::prelude::ModuleKind::ES_NEXT)
    {
        return true;
    }
    let mut scope = node;
    while !scope.is_nil() {
        if matches!(
            scope.kind(),
            SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
        ) {
            return true;
        }
        let block = if scope.kind() == SyntaxKind::SourceFile {
            scope
        } else {
            scope.body()
        };
        if !block.is_nil() && matches!(block.kind(), SyntaxKind::Block | SyntaxKind::SourceFile) {
            for stmt in block.statements() {
                if stmt.kind() != SyntaxKind::ExpressionStatement
                    || stmt.expression().kind() != SyntaxKind::StringLiteral
                {
                    break;
                }
                let expression = stmt.expression();
                let text = source_frontend::ast::source_file_text(file);
                let raw = text
                    .get(expression.pos().max(0) as usize..expression.end() as usize)
                    .unwrap_or("");
                // Escaped text with the same cooked value is not a strict directive.
                if expression.text() == "use strict"
                    && (raw.ends_with("\"use strict\"") || raw.ends_with("'use strict'"))
                {
                    return true;
                }
            }
        }
        scope = scope.parent();
    }
    false
}

impl Lowerer<'_> {
    pub(super) fn initialize_receiver(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        if !reads_this(node) {
            return Ok(vec![]);
        }
        if !strict(node) {
            return Err(self.refuse(
                node,
                "sloppy function this requires global substitution and primitive boxing",
            ));
        }
        if node.modifier_flags().intersects(ModifierFlags::ASYNC) {
            return Err(self.refuse(
                node,
                "async function this requires a deferred receiver contract",
            ));
        }
        self.receiver_local(
            node,
            Expr::LibCall {
                r#fn: "dyn.this".into(),
                args: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node),
            },
        )
    }
    pub(super) fn initialize_module_arrow_receiver(
        &mut self,
        node: Node,
    ) -> Result<Vec<Stmt>, String> {
        if commonjs::is_module(get_source_file_of_node(node)) || !strict(node) {
            return Err(self.refuse(
                node,
                "top-level arrow this requires an ESM undefined receiver",
            ));
        }
        let value = self.coerce(
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            },
            Type::Dyn,
            node,
        )?;
        self.receiver_local(node, value)
    }
    fn receiver_local(&mut self, node: Node, init: Expr) -> Result<Vec<Stmt>, String> {
        let local = Local {
            id: "source_this".into(),
            name: "this".into(),
            r#type: Type::Dyn,
            mutable: false,
            boxed: false,
        };
        self.locals.push(local.clone());
        self.instance_this = Some(local.clone());
        Ok(vec![Stmt::VarDecl {
            local_id: local.id,
            init,
            loc: self.loc(node),
        }])
    }

    pub(super) fn function_receiver_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(member.name().text(), "call" | "apply")
        {
            return Ok(None);
        }
        let id = self.symbol(member.name());
        if id == 0 {
            return Ok(None);
        }
        let symbol = self.checker.sym(SymbolId(id));
        // Custom own methods named call/apply retain their ordinary property ABI.
        if symbol.declarations.is_empty()
            || !symbol.declarations.iter().all(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                source_frontend::frontend::bundled::bundled_lib_name(&file.file_name).is_some()
                    && decl.parent().kind() == SyntaxKind::InterfaceDeclaration
                    && matches!(decl.parent().name().text(), "Function" | "CallableFunction")
            })
        {
            return Ok(None);
        }
        let target = self.expression(member.expression())?;
        let target = self.callable_body(target, node)?;
        if !matches!(target.ty(), Type::Func { .. } | Type::Dyn) {
            return Ok(None);
        }
        let recv = self.coerce(target, Type::Dyn, node)?;
        let args = node
            .arguments()
            .into_iter()
            .map(|arg| {
                if arg.kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(arg, "iterable receiver-call spreads are not ported"));
                }
                self.expected_expression(arg, Type::Dyn)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Expr::DynInvoke {
            recv: Box::new(recv),
            method: member.name().text().into(),
            callee_name: member.name().text().into(),
            args,
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
}

impl Lowerer<'_> {
    /// Implicit method receivers obey the same erasure fences as explicit values.
    /// Run after reachability closes, when every possible function target is known.
    pub(super) fn validate_call_receivers(&self, functions: &[Function]) -> Result<(), String> {
        let targets = functions
            .iter()
            .filter(|function| function.reads_receiver())
            .map(|function| Type::Func {
                rest: function.rest,
                params: function.params.iter().map(|p| p.r#type.clone()).collect(),
                ret: Box::new(function.call_result()),
            })
            .collect::<HashSet<_>>();
        for PendingCall { ty, loc, boundary } in &self.receiver_calls {
            if targets.contains(ty) || (*ty == Type::Dyn && !targets.is_empty()) {
                return Err(format!(
                    "SCN1001: {}:{}..{}: {}; native subset only, no fallback",
                    loc.file,
                    loc.start,
                    loc.end,
                    boundary.reason()
                ));
            }
        }
        let mut failure = None;
        for function in functions {
            function.visit_expressions(&mut |value| {
                if failure.is_some() {
                    return;
                }
                let (callee, loc) = match value {
                    Expr::CallValue { callee, loc, .. } if targets.contains(&callee.ty()) => {
                        (callee, loc)
                    }
                    Expr::DynCall { callee, loc, .. } if !targets.is_empty() => (callee, loc),
                    _ => return,
                };
                if let Some(receiver) = callee.call_receiver()
                    && let Some(reason) = self.dynamic_erasure_reason(&receiver.ty())
                {
                    failure = Some(format!(
                        "SCN1001: {}:{}..{}: {} (call receiver); native subset only, no fallback",
                        loc.file, loc.start, loc.end, reason
                    ));
                }
            });
        }
        failure.map_or(Ok(()), Err)
    }
}
