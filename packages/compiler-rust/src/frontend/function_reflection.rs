//! Source display is proved from callable origin, never from a shared signature.
use super::*;
use helpers::Helper;
use source_frontend::prelude::SymbolId;

enum NativeCallable {
    Json(&'static str),
    String,
}

impl NativeCallable {
    fn name(&self) -> &'static str {
        match self {
            Self::Json(name) => name,
            Self::String => "String",
        }
    }

    fn source(&self) -> String {
        format!("function {}() {{ [native code] }}", self.name())
    }
}

impl Lowerer<'_> {
    fn native_callable_origin(
        &mut self,
        node: Node,
        active: &mut HashSet<u32>,
    ) -> Option<NativeCallable> {
        let node = receivers::reference_node(node);
        if let Some(name) = self.json_function_origin(node, &mut HashSet::new()) {
            return Some(NativeCallable::Json(name));
        }
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let id = self.symbol(node);
        if self.primitive_symbol(id, "String", None) {
            return Some(NativeCallable::String);
        }
        if id == 0 || !active.insert(id) {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(id)).value_declaration;
        let result = if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && declaration.parent().flags().intersects(NodeFlags::CONST)
            && declaration.name().kind() == SyntaxKind::Identifier
            && !declaration.initializer().is_nil()
        {
            self.native_callable_origin(declaration.initializer(), active)
        } else {
            None
        };
        active.remove(&id);
        result
    }

    pub(super) fn function_source_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = receivers::reference_node(node.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "toString"
        {
            return Ok(None);
        }
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, "toString", Some("Function"))
            && !self.primitive_symbol(symbol, "toString", Some("CallableFunction"))
        {
            return Ok(None);
        }
        let descriptor = self
            .native_callable_origin(member.expression(), &mut HashSet::new())
            .ok_or_else(|| {
                self.refuse(
                    node,
                    "function source reflection requires a proven standard callable",
                )
            })?;
        // The immutable origin proves the display, but the receiver and every
        // ignored argument must still evaluate once, with abrupt completion.
        let mut values = vec![self.expression(member.expression())?];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(
                    self.refuse(argument, "function source argument spreads are not ported")
                );
            }
            let value = self.primitive_operand(argument)?;
            values.push(self.primitive_capture(value, argument)?);
        }
        let mut helper = Helper::new(
            &format!("function_source_{}", descriptor.name()),
            values.iter().map(Expr::ty).collect(),
            Type::String,
            self.loc(node),
        );
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::StrLit {
                value: descriptor.source(),
                r#type: Type::String,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }
}
