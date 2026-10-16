//! Standard RegExp identity and typed operations, backed by the Rust runtime.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

impl Lowerer<'_> {
    fn regex_symbol(&self, symbol: u32) -> bool {
        symbol != 0 && {
            let symbol = self.checker.sym(SymbolId(symbol));
            symbol.name.as_ref() == "RegExp"
                && symbol.declarations.iter().any(|n| {
                    !n.is_nil()
                        && source_file_info(get_source_file_of_node(*n))
                            .file_name
                            .ends_with("/lib.es5.d.ts")
                })
        }
    }
    pub(super) fn is_regex_type(&self, id: TypeId) -> bool {
        self.regex_symbol(self.checker.ty(id).symbol().0)
    }
    pub(super) fn regex_literal(&self, node: Node) -> Result<Expr, String> {
        let text = node.text();
        let end = text
            .rfind('/')
            .filter(|end| *end > 0)
            .ok_or_else(|| self.refuse(node, "invalid native regex literal"))?;
        let flags = &text[end + 1..];
        if !flags.chars().all(|f| "gimsuy".contains(f)) {
            return Err(self.refuse(node, "native regex literal flags are limited to gimsuy"));
        }
        Ok(Expr::RegexLit {
            pattern: text[1..end].into(),
            flags: flags.into(),
            r#type: Type::Regex,
            loc: self.loc(node),
        })
    }
    pub(super) fn regex_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.expression().kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let symbol = self.symbol(node.expression());
        if !self.regex_symbol(symbol) {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 2 {
            return Err(self.refuse(node, "RegExp constructor arity is not ported"));
        }
        let mut values = Vec::new();
        for i in 0..2 {
            values.push(if let Some(arg) = args.get(i) {
                if arg.kind() == SyntaxKind::Identifier && arg.text() == "undefined" {
                    let unit = self.expression(*arg)?;
                    if unit.ty() != Type::Undefined {
                        return Err(self.refuse(*arg, "RegExp conversion is not ported"));
                    }
                    Expr::StrLit {
                        value: String::new(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    }
                } else {
                    self.expected_expression(*arg, Type::String)?
                }
            } else {
                Expr::StrLit {
                    value: String::new(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }
            });
        }
        Ok(Some(Expr::LibCall {
            r#fn: "regex.new".into(),
            args: values,
            r#type: Type::Regex,
            loc: self.loc(node),
        }))
    }
    pub(super) fn regex_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || self.ty(member.expression()).ok() != Some(Type::Regex)
        {
            return Ok(None);
        }
        if member.name().text() != "test" || node.arguments().len() != 1 {
            return Err(self.refuse(node, "only RegExp.test(string) is ported"));
        }
        let receiver = self.expression(member.expression())?;
        if receiver.ty() != Type::Regex {
            return Err(self.refuse(
                node,
                "RegExp receiver may be undefined; guard it before use",
            ));
        }
        let arg =
            self.expected_expression(node.arguments().into_iter().next().unwrap(), Type::String)?;
        Ok(Some(Expr::RegexIntrinsic {
            method: "test".into(),
            receiver: Box::new(receiver),
            args: vec![arg],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }
    pub(super) fn regex_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.ty(node.expression()).ok() != Some(Type::Regex) {
            return Ok(None);
        }
        let method = node.name().text();
        let result = match method {
            "source" | "flags" => Type::String,
            "lastIndex" => Type::F64,
            _ => return Err(self.refuse(node, "RegExp property is not ported")),
        };
        let receiver = self.expression(node.expression())?;
        if receiver.ty() != Type::Regex {
            return Err(self.refuse(
                node,
                "RegExp receiver may be undefined; guard it before use",
            ));
        }
        Ok(Some(Expr::RegexIntrinsic {
            method: method.into(),
            receiver: Box::new(receiver),
            args: vec![],
            r#type: result,
            loc: self.loc(node),
        }))
    }
    pub(super) fn regex_set(&mut self, node: Node) -> Result<Option<Stmt>, String> {
        let member = node.left();
        if self.ty(member.expression()).ok() != Some(Type::Regex) {
            return Ok(None);
        }
        if member.name().text() != "lastIndex" {
            return Err(self.refuse(node, "only numeric RegExp.lastIndex writes are ported"));
        }
        let receiver = self.expression(member.expression())?;
        if receiver.ty() != Type::Regex {
            return Err(self.refuse(
                node,
                "RegExp receiver may be undefined; guard it before use",
            ));
        }
        let arg = self.expected_expression(node.right(), Type::F64)?;
        Ok(Some(Stmt::Expression {
            expr: Expr::RegexIntrinsic {
                method: "setLastIndex".into(),
                receiver: Box::new(receiver),
                args: vec![arg],
                r#type: Type::F64,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }))
    }
}
