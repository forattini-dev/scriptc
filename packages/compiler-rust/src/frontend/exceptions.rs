//! Protected regions retain pending completions; finally may replace them.
use super::*;
use source_frontend::prelude::get_source_file_of_node;
impl Lowerer<'_> {
    pub(super) fn standard_errno_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        symbol.0 != 0
            && self.checker.sym(symbol).name.as_ref() == "ErrnoException"
            && self.checker.sym(symbol).declarations.iter().any(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                file.file_name.ends_with("/globals.d.ts")
                    && (file.file_name.contains("/@types/node/")
                        || file.file_name.contains("/bun-types/"))
            })
    }

    pub(super) fn try_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let catch = node.catch_clause();
        let before = self.var_defined.clone();
        let bindings = self.bindings.clone();
        let try_body = self.statements(node.try_block().statements())?;
        let try_defined = self.var_defined.clone();
        self.bindings = bindings.clone();
        self.var_defined = before.clone();
        self.var_call_effects();
        let mut catch_local_id = None;
        let mut caught_symbol = None;
        let catch_body = if catch.is_nil() {
            None
        } else {
            let declaration = catch.variable_declaration();
            if !declaration.is_nil() {
                if declaration.name().kind() != SyntaxKind::Identifier {
                    return Err(self.refuse(declaration, "catch destructuring is not ported"));
                }
                self.ensure_exception_classes(declaration)?;
                let symbol = self.symbol(declaration.name());
                let local = Local {
                    id: format!("v{}", self.locals.len()),
                    name: declaration.name().text().into(),
                    r#type: Type::Caught,
                    mutable: false,
                    boxed: false,
                };
                catch_local_id = Some(local.id.clone());
                self.locals.push(local.clone());
                let alias = Local {
                    id: format!("v{}", self.locals.len()),
                    name: "caughtValue".into(),
                    r#type: Type::Dyn,
                    mutable: false,
                    boxed: false,
                };
                self.locals.push(alias.clone());
                self.caught_aliases.insert(symbol, alias);
                caught_symbol = Some(symbol);
                self.bindings.insert(symbol, local);
            }
            let mut body = Vec::new();
            if let Some(symbol) = caught_symbol {
                let local = self.bindings[&symbol].clone();
                body.push(Stmt::VarDecl {
                    local_id: self.caught_aliases[&symbol].id.clone(),
                    init: Expr::CaughtToDyn {
                        value: Box::new(Expr::VarRef {
                            local_id: local.id,
                            r#type: Type::Caught,
                            loc: self.loc(catch),
                        }),
                        r#type: Type::Dyn,
                        loc: self.loc(catch),
                    },
                    loc: self.loc(catch),
                });
            }
            body.extend(self.statements(catch.block().statements())?);
            Some(body)
        };
        if let Some(symbol) = caught_symbol {
            self.caught_aliases.remove(&symbol);
        }
        // Only normal completions reach the following statement. An escaping
        // throw (including a failed assignment RHS) contributes no facts.
        let normal_defined = match &catch_body {
            None => try_defined,
            Some(_) if ir::always_returns(&try_body) => self.var_defined.clone(),
            Some(body) if ir::always_returns(body) => try_defined,
            Some(_) => try_defined
                .intersection(&self.var_defined)
                .copied()
                .collect(),
        };
        self.bindings = bindings.clone();
        self.var_defined = before.clone();
        // A throw can interrupt any assignment, including a call in either
        // body. Only facts established by the finalizer survive the region.
        self.var_call_effects();
        let finalizer = node.finally_block();
        let finally_body = if finalizer.is_nil() {
            self.var_defined = normal_defined;
            None
        } else {
            Some(self.statements(finalizer.statements())?)
        };
        self.bindings = bindings;
        Ok(vec![Stmt::TryCatch {
            try_body,
            catch_body,
            catch_local_id,
            finally_body,
            loc: self.loc(node),
        }])
    }
}
