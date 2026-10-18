//! Ambient console members keep one stable native text-sink identity per member.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

pub(super) fn text_sink_type() -> Type {
    Type::Func {
        params: vec![Type::String],
        ret: Box::new(Type::Void),
    }
}
fn member_name(name: &str) -> Option<&'static str> {
    match name {
        "log" => Some("log"),
        "info" => Some("info"),
        "debug" => Some("debug"),
        "warn" => Some("warn"),
        "error" => Some("error"),
        _ => None,
    }
}
fn output_intrinsic(name: &str) -> &'static str {
    if matches!(name, "warn" | "error") {
        "console.error"
    } else {
        "console.log"
    }
}
impl Lowerer<'_> {
    fn standard_declaration(&self, node: Node) -> bool {
        if node.is_nil() {
            return false;
        }
        let file = source_file_info(get_source_file_of_node(node));
        let path = &file.file_name;
        self.console_prelude.as_deref() == Some(path.as_str())
            || matches!(
                source_frontend::frontend::bundled::bundled_lib_name(path),
                Some("lib.dom.d.ts" | "lib.webworker.d.ts")
            )
            || (path.contains("/@types/node/")
                && (path.ends_with("/console.d.ts") || path.ends_with("/globals.d.ts")))
            || (path.contains("/bun-types/") && path.ends_with("/globals.d.ts"))
    }

    fn standard_console_symbol(&self, id: u32, global: bool) -> Option<&'static str> {
        if id == 0 {
            return None;
        }
        let symbol = self.checker.sym(SymbolId(id));
        let name = if global {
            (symbol.name.as_ref() == "console").then_some("console")?
        } else {
            member_name(&symbol.name)?
        };
        (!symbol.declarations.is_empty()
            && symbol.declarations.iter().copied().all(|declaration| {
                self.standard_declaration(declaration)
                    && (global || {
                        let owner = declaration.parent();
                        owner.kind() == SyntaxKind::InterfaceDeclaration
                            && owner.name().text() == "Console"
                    })
            }))
        .then_some(name)
    }
    pub(super) fn standard_console_type(&self, id: TypeId) -> bool {
        self.standard_console_symbol(self.checker.ty(id).symbol().0, false)
            .is_some()
    }
    fn ambient_console_member(&mut self, node: Node) -> Option<&'static str> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let receiver = self.symbol(node.expression());
        self.standard_console_symbol(receiver, true)?;
        let member = self.symbol(node.name());
        self.standard_console_symbol(member, false)
    }
    pub(super) fn console_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(name) = self.ambient_console_member(node) else {
            return Ok(None);
        };
        let mut helper = helpers::Helper::new(
            &format!("console_{name}"),
            vec![Type::String],
            Type::Void,
            self.loc(node),
        );
        helper.function.body.push(Stmt::Expression {
            expr: Expr::Intrinsic {
                name: output_intrinsic(name).into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: Type::Void,
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        let fn_name = self.install_helper(helper.function);
        Ok(Some(Expr::Closure {
            fn_name,
            captures: vec![],
            r#type: text_sink_type(),
            loc: self.loc(node),
        }))
    }
    /// Existing projects can supply a narrow ambient console declaration of
    /// their own. Direct primitive calls need its global binding and void
    /// contract, while function values require a recognized standard ABI.
    fn declared_console_call_member(&mut self, member: Node) -> Option<&'static str> {
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let name = member_name(member.name().text())?;
        let symbol = self.symbol(member.expression());
        if symbol == 0
            || self.bindings.contains_key(&symbol)
            || self.module_bindings.contains_key(&symbol)
            || self.outer.iter().any(|scope| scope.contains_key(&symbol))
            || self.functions.contains(symbol)
        {
            return None;
        }
        let info = self.checker.sym(SymbolId(symbol));
        if info.name.as_ref() != "console"
            || info.declarations.is_empty()
            || !info.declarations.iter().all(|decl| {
                is_declaration(&source_file_info(get_source_file_of_node(*decl)).file_name)
            })
        {
            return None;
        }
        let ty = self.checker.get_type_at_location(member);
        let signatures = self
            .checker
            .get_signatures_of_type(ty, source_frontend::prelude::SignatureKind::CALL);
        if signatures.is_empty() {
            return None;
        }
        for signature in signatures {
            let result = self.checker.get_return_type_of_signature(signature);
            if !self.checker.ty(result).flags.intersects(TypeFlags::VOID) {
                return None;
            }
        }
        Some(name)
    }
    pub(super) fn console_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(name) = self
            .ambient_console_member(node.expression())
            .or_else(|| self.declared_console_call_member(node.expression()))
        else {
            return Ok(None);
        };
        let mut args = Vec::new();
        for arg in node.arguments() {
            args.push(self.expression(arg)?);
        }
        if args
            .iter()
            .any(|arg| !matches!(arg.ty(), Type::F64 | Type::String | Type::Bool))
        {
            return Err(self.refuse(node, "non-primitive console argument values are not ported"));
        }
        if args.len() > 1
            && args[0].ty() == Type::String
            && !matches!(&args[0], Expr::StrLit { value, .. } if !value.contains('%'))
        {
            return Err(self.refuse(node, "Node console format substitution is not ported"));
        }
        Ok(Some(Expr::Intrinsic {
            name: output_intrinsic(name).into(),
            args,
            r#type: Type::Void,
            loc: self.loc(node),
        }))
    }
}
