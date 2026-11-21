//! Primitive symbol identities use the owned IR and shared Rust runtime.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};
impl Lowerer<'_> {
    pub(super) fn node_util_inspect_custom(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::PropertyAccessExpression || node.name().text() != "custom" {
            return false;
        }
        let inspect = node.expression();
        inspect.kind() == SyntaxKind::PropertyAccessExpression
            && inspect.name().text() == "inspect"
            && self.native_namespace(inspect.expression()) == Some("util")
    }
    pub(super) fn standard_symbol(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let id = self.symbol(node);
        id != 0 && {
            let symbol = self.checker.sym(SymbolId(id));
            symbol.name.as_ref() == "Symbol"
                && symbol.declarations.iter().any(|decl| {
                    source_file_info(get_source_file_of_node(*decl))
                        .file_name
                        .ends_with("/lib.es2015.symbol.d.ts")
                })
        }
    }
    pub(super) fn symbol_initializer_storage(&mut self, node: Node) -> Option<Type> {
        let node = primitives::primitive_source(node);
        if node.kind() == SyntaxKind::CallExpression {
            let callee = primitives::primitive_source(node.expression());
            if self.standard_symbol(callee)
                || (callee.kind() == SyntaxKind::PropertyAccessExpression
                    && callee.name().text() == "for"
                    && self.standard_symbol(callee.expression()))
            {
                return Some(Type::Symbol);
            }
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && self.standard_symbol(node.expression())
            && ir::well_known_symbol(&format!("sym.{}", node.name().text())).is_some()
        {
            return Some(Type::Symbol);
        }
        None
    }
    pub(super) fn represented_symbol_value(&mut self, node: Node) -> bool {
        if self.ty(node).ok() == Some(Type::Symbol) {
            return true;
        }
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return false;
        }
        if self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .is_some_and(|local| local.r#type == Type::Symbol)
        {
            return true;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        !declaration.is_nil()
            && !declaration.initializer().is_nil()
            && self
                .symbol_initializer_storage(declaration.initializer())
                .is_some()
    }
    fn symbol_operation(&mut self, name: &str, args: Vec<Expr>, node: Node) -> Expr {
        let r#type = match name {
            "sym.toString" | "dyn.typeof" => Type::String,
            "sym.desc" | "sym.keyFor" => self
                .intern_union(vec![Type::String, Type::Undefined])
                .unwrap(),
            _ => Type::Symbol,
        };
        Expr::LibCall {
            r#fn: name.into(),
            args,
            r#type,
            loc: self.loc(node),
        }
    }
    pub(super) fn symbol_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if self.standard_symbol(member) {
            if args.len() > 1 {
                return Err(self.refuse(
                    node,
                    "Symbol arguments beyond the description are not ported",
                ));
            }
            let value = if let Some(arg) = args.first() {
                Some(self.expression(*arg)?)
            } else {
                None
            };
            return Ok(Some(match value {
                None | Some(Expr::UnitLit { r#type: Type::Undefined, .. }) => self.symbol_operation("sym.newAnon", vec![], node),
                Some(value) if value.ty() == Type::String => self.symbol_operation("sym.new", vec![value], node),
                _ => return Err(self.refuse(node, "Symbol description coercion requires a string or omitted/undefined description")),
            }));
        }
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = member.expression();
        if self.standard_symbol(receiver) {
            let (name, ty) = match member.name().text() {
                "for" => ("sym.for", Type::String),
                "keyFor" => ("sym.keyFor", Type::Symbol),
                _ => {
                    return Err(self.refuse(
                        node,
                        "well-known Symbol operations and factory values are not ported",
                    ));
                }
            };
            if args.len() != 1 {
                return Err(self.refuse(node, "Symbol operation needs one represented argument"));
            }
            let value = self.expected_expression(args[0], ty)?;
            return Ok(Some(self.symbol_operation(name, vec![value], node)));
        }
        if self.represented_symbol_value(receiver) {
            if member.name().text() != "toString" || !args.is_empty() {
                return Err(self.refuse(node, "only symbol.toString() is ported"));
            }
            let value = self.expression(receiver)?;
            if value.ty() != Type::Symbol {
                return Err(self.refuse(node, "optional symbol receiver requires a guard"));
            }
            return Ok(Some(self.symbol_operation(
                "sym.toString",
                vec![value],
                node,
            )));
        }
        Ok(None)
    }
    pub(super) fn symbol_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.node_util_inspect_custom(node) {
            return Ok(Some(self.symbol_operation(
                "sym.for",
                vec![Expr::StrLit {
                    value: "nodejs.util.inspect.custom".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }],
                node,
            )));
        }
        let standard = self.standard_symbol(node.expression());
        if standard {
            let operation = format!("sym.{}", node.name().text());
            if ir::well_known_symbol(&operation).is_some() {
                return Ok(Some(self.symbol_operation(&operation, vec![], node)));
            }
            return Err(self.refuse(
                node,
                "Symbol factory values and this property are not ported",
            ));
        }
        if !self.represented_symbol_value(node.expression()) {
            return Ok(None);
        }
        if node.name().text() != "description" {
            return Err(self.refuse(node, "symbol property is not ported"));
        }
        let value = self.expression(node.expression())?;
        if value.ty() != Type::Symbol {
            return Err(self.refuse(node, "optional symbol receiver requires a guard"));
        }
        Ok(Some(self.symbol_operation("sym.desc", vec![value], node)))
    }
}
