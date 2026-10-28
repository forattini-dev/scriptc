//! Recursive lexical functions need a cell before their closure is built.
use super::*;

impl Lowerer<'_> {
    fn closure_mentions(&mut self, node: Node, symbol: u32) -> bool {
        if node.kind() == SyntaxKind::Identifier && self.symbol(node) == symbol {
            return true;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            if !found {
                found = self.closure_mentions(child, symbol);
            }
            false
        });
        found
    }

    pub(super) fn recursive_const_closure(
        &mut self,
        declaration: Node,
        flags: NodeFlags,
        module: bool,
    ) -> Result<Option<Vec<Stmt>>, String> {
        let initializer = declaration.initializer();
        if module
            || !flags.intersects(NodeFlags::CONST)
            || !matches!(
                initializer.kind(),
                SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
            )
        {
            return Ok(None);
        }
        let name = declaration.name();
        let symbol = self.symbol(name);
        if symbol == 0 || !self.closure_mentions(initializer, symbol) {
            return Ok(None);
        }
        let ty = self.storage_type(name)?;
        if !matches!(ty, Type::Func { .. }) {
            return Err(self.refuse(
                declaration,
                "recursive closure requires a native function signature",
            ));
        }
        self.recursive_functions.insert(symbol, ty.clone());
        // The synthetic assignment initializes the cell after the closure
        // captures it. Source const writes are rejected through the binding.
        let local = Local {
            id: format!("v{}", self.locals.len()),
            name: name.text().into(),
            r#type: Type::Dyn,
            mutable: false,
            boxed: true,
        };
        self.bindings.insert(symbol, local.clone());
        let mut storage = local.clone();
        storage.mutable = true;
        self.locals.push(storage);
        let undefined = self.coerce(
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(declaration),
            },
            Type::Dyn,
            declaration,
        )?;
        let value = self.expected_expression(initializer, ty.clone())?;
        // This private cell never escapes as a dynamic value. Recursive reads
        // check it back to the exact function ABI before exposing the value.
        let value = Expr::DynFrom {
            value: Box::new(value),
            r#type: Type::Dyn,
            loc: self.loc(declaration),
        };
        let published = Local {
            id: format!("v{}", self.locals.len()),
            name: name.text().into(),
            r#type: ty.clone(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(published.clone());
        self.bindings.insert(symbol, published.clone());
        let checked = Expr::DynCheck {
            value: Box::new(Expr::VarRef {
                local_id: local.id.clone(),
                r#type: Type::Dyn,
                loc: self.loc(declaration),
            }),
            r#type: ty,
            loc: self.loc(declaration),
        };
        Ok(Some(vec![
            Stmt::VarDecl {
                local_id: local.id.clone(),
                init: undefined,
                loc: self.loc(declaration),
            },
            Stmt::Assign {
                local_id: local.id,
                value,
                initializes_global: false,
                loc: self.loc(declaration),
            },
            Stmt::VarDecl {
                local_id: published.id,
                init: checked,
                loc: self.loc(declaration),
            },
        ]))
    }
}
