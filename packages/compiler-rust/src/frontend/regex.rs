//! Standard RegExp identity and typed operations, backed by the Rust runtime.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

// Recognize capture-free groups without confusing assertions, escaped
// parentheses, character classes or nested Unicode-set classes with captures.
fn split_pattern_without_captures(pattern: &[u8], unicode_sets: bool) -> bool {
    let mut class_depth = 0usize;
    let mut group_depth = 0usize;
    let mut escaped = false;
    for (index, byte) in pattern.iter().copied().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
        } else if byte == b'[' && (class_depth == 0 || unicode_sets) {
            class_depth += 1;
        } else if byte == b']' && class_depth != 0 {
            class_depth -= 1;
        } else if class_depth == 0 && byte == b'(' {
            if pattern.get(index + 1) != Some(&b'?')
                || !matches!(
                    (pattern.get(index + 2), pattern.get(index + 3)),
                    (Some(b':' | b'=' | b'!'), _) | (Some(b'<'), Some(b'=' | b'!'))
                )
            {
                return false;
            }
            group_depth += 1;
        } else if class_depth == 0 && byte == b')' {
            let Some(depth) = group_depth.checked_sub(1) else {
                return false;
            };
            group_depth = depth;
        }
    }
    !escaped && class_depth == 0 && group_depth == 0
}

#[cfg(test)]
mod tests {
    use super::split_pattern_without_captures;

    #[test]
    fn split_pattern_distinguishes_assertions_from_captures() {
        for pattern in [
            r",(?=\s*[a-zA-Z0-9_-]+=)",
            r"(?:a|(?=b)c)",
            r"(?<!x)(?:y)(?!z)",
            r"[()]+\(x\)",
        ] {
            assert!(
                split_pattern_without_captures(pattern.as_bytes(), false),
                "{pattern}"
            );
        }
        for pattern in [
            r"(a)",
            r"(?:a(b))",
            r"(?=(a))",
            r"(?<name>a)",
            r"(?:a",
            r"(?:a))",
        ] {
            assert!(
                !split_pattern_without_captures(pattern.as_bytes(), false),
                "{pattern}"
            );
        }
        assert!(split_pattern_without_captures(br"[[a-z]--[()]]", true));
        assert!(!split_pattern_without_captures(br"[[a-z]--[()]](x)", true));
    }
}

impl Lowerer<'_> {
    // The current split ABI contains strings only. Accept a capture only when
    // its enclosing group necessarily participates in every match.
    pub(super) fn regex_split_strings_only(&mut self, node: Node) -> bool {
        self.regex_split_strings_only_inner(node, &mut std::collections::HashSet::new())
    }

    fn regex_split_strings_only_inner(
        &mut self,
        node: Node,
        seen: &mut std::collections::HashSet<u32>,
    ) -> bool {
        let mut node = primitives::primitive_source(node);
        while node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if symbol == 0 || !seen.insert(symbol) {
                return false;
            }
            let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
            if declaration.is_nil()
                || declaration.kind() != SyntaxKind::VariableDeclaration
                || !declaration.parent().flags().intersects(NodeFlags::CONST)
                || declaration.initializer().is_nil()
            {
                return false;
            }
            node = primitives::primitive_source(declaration.initializer());
        }
        if node.kind() == SyntaxKind::ConditionalExpression {
            return self.regex_split_strings_only_inner(node.when_true(), &mut seen.clone())
                && self.regex_split_strings_only_inner(node.when_false(), seen);
        }
        if node.kind() != SyntaxKind::RegularExpressionLiteral {
            return false;
        }
        let text = node.text();
        let Some(end) = text.rfind('/').filter(|end| *end > 0) else {
            return false;
        };
        let pattern = &text.as_bytes()[1..end];
        // Unicode-set string disjunctions can contain class delimiters that
        // need a full v-mode parser. Keep the existing v-mode boundary.
        if !text[end + 1..].contains('v') && split_pattern_without_captures(pattern, false) {
            return true;
        }
        let outer = pattern.first() == Some(&b'(') && pattern.get(1) != Some(&b'?');
        let mut class = false;
        let mut escaped = false;
        let mut closed = false;
        for (i, byte) in pattern.iter().copied().enumerate() {
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
            } else if byte == b'[' && !class {
                class = true;
            } else if byte == b']' && class {
                class = false;
            } else if !class && byte == b'(' {
                if !outer || i != 0 {
                    return false;
                }
            } else if !class && byte == b')' {
                if !outer || i + 1 != pattern.len() || closed {
                    return false;
                }
                closed = true;
            }
        }
        !class && !escaped && (!outer || closed)
    }

    pub(super) fn regex_callable_type(&self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol().0;
        if symbol == 0 {
            return None;
        }
        // Instantiated and indexed-access forms of `RegExp["test"]` can carry
        // a synthetic value_declaration sentinel in the checker. Its
        // declarations and parent symbol remain authoritative, while asking
        // the sentinel for its kind panics inside the checker port.
        self.primitive_symbol(symbol, "test", Some("RegExp"))
            .then(|| Type::Func {
                rest: false,
                params: vec![Type::Dyn],
                ret: Box::new(Type::Bool),
            })
    }

    fn regex_test_value(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        let symbol = self.symbol(node.name());
        if !self.primitive_symbol(symbol, "test", Some("RegExp")) {
            return Err(self.refuse(node, "RegExp.test extraction requires the standard member"));
        }
        self.ensure_exception_classes(node)?;
        let mut method =
            helpers::Helper::new("regexp_test", vec![Type::Dyn], Type::Bool, self.loc(node));
        let this = method.local("RegExp receiver", Type::Regex, false);
        method.declare(
            &this,
            Expr::DynCheck {
                value: Box::new(Expr::LibCall {
                    r#fn: "dyn.this".into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: method.loc(),
                }),
                r#type: Type::Regex,
                loc: method.loc(),
            },
        );
        method.function.body.push(Stmt::Return {
            value: Some(Expr::RegexIntrinsic {
                method: "test".into(),
                receiver: Box::new(method.read(&this)),
                args: vec![Expr::ToString {
                    operand: Box::new(method.read(&method.param(0))),
                    r#type: Type::String,
                    loc: method.loc(),
                }],
                r#type: Type::Bool,
                loc: method.loc(),
            }),
            loc: method.loc(),
        });
        let ty = Type::Func {
            rest: false,
            params: vec![Type::Dyn],
            ret: Box::new(Type::Bool),
        };
        let value = Expr::Closure {
            fn_name: self.install_helper(method.function),
            captures: vec![],
            r#type: ty.clone(),
            loc: self.loc(node),
        };
        // Reading a prototype method evaluates the base, but does not bind it.
        // The capture-free method has one identity shared by all regex values.
        let mut read = helpers::Helper::new(
            "regexp_test_get",
            vec![Type::Regex],
            ty.clone(),
            self.loc(node),
        );
        read.function.body.push(Stmt::Return {
            value: Some(value),
            loc: read.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(read.function),
            args: vec![receiver],
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn regex_symbol(&self, symbol: u32) -> bool {
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
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "regex.requireGlobal".into(),
                    args: vec![],
                    r#type: Type::Void,
                    loc: self.loc(node),
                },
                loc: self.loc(node),
            }],
            result: Box::new(Expr::LibCall {
                r#fn: "regex.new".into(),
                args: values,
                r#type: Type::Regex,
                loc: self.loc(node),
            }),
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
        if !matches!(member.name().text(), "test" | "exec") || node.arguments().len() != 1 {
            return Err(self.refuse(
                node,
                "RegExp.test/exec require one represented string argument",
            ));
        }
        let receiver_node = member.expression();
        let mut receiver = self.expression(receiver_node)?;
        if receiver.ty() != Type::Regex {
            // A hoisted `var` keeps an undefined-aware owning ABI even when
            // the checker exposes RegExp at this use site. Narrow the live
            // value here: calls before initialization fail at runtime, while
            // ordinary module calls after initialization retain the regex
            // identity and mutable lastIndex state.
            receiver = self.coerce(receiver, Type::Regex, receiver_node)?;
        }
        if receiver.ty() != Type::Regex {
            return Err(self.refuse(
                node,
                "RegExp receiver may be undefined; guard it before use",
            ));
        }
        let arg =
            self.expected_expression(node.arguments().into_iter().next().unwrap(), Type::String)?;
        let result = if member.name().text() == "exec" {
            let array = self.regex_capture_array();
            self.intern_union(vec![array, Type::Null])
                .expect("regex result")
        } else {
            Type::Bool
        };
        Ok(Some(Expr::RegexIntrinsic {
            method: member.name().text().into(),
            receiver: Box::new(receiver),
            args: vec![arg],
            r#type: result,
            loc: self.loc(node),
        }))
    }
    pub(super) fn regex_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.ty(node.expression()).ok() != Some(Type::Regex) {
            return Ok(None);
        }
        let method = node.name().text();
        let receiver_node = node.expression();
        let prototype_owner = if receiver_node.kind() == SyntaxKind::PropertyAccessExpression
            && receiver_node.name().text() == "prototype"
            && receiver_node.expression().kind() == SyntaxKind::Identifier
        {
            self.symbol(receiver_node.expression())
        } else {
            0
        };
        let standard_prototype = receiver_node.kind() == SyntaxKind::PropertyAccessExpression
            && receiver_node.name().text() == "prototype"
            && receiver_node.expression().kind() == SyntaxKind::Identifier
            && self.regex_symbol(prototype_owner);
        let mut receiver = if standard_prototype {
            // The prototype object is itself a RegExp instance. Materialize a
            // side-effect-free native representative so prototype method
            // extraction can preserve its standard identity without treating
            // the ambient RegExp constructor as a lexical binding.
            Expr::LibCall {
                r#fn: "regex.new".into(),
                args: vec![
                    Expr::StrLit {
                        value: "(?:)".into(),
                        r#type: Type::String,
                        loc: self.loc(receiver_node),
                    },
                    Expr::StrLit {
                        value: String::new(),
                        r#type: Type::String,
                        loc: self.loc(receiver_node),
                    },
                ],
                r#type: Type::Regex,
                loc: self.loc(receiver_node),
            }
        } else {
            self.expression(receiver_node)?
        };
        if receiver.ty() != Type::Regex {
            receiver = self.coerce(receiver, Type::Regex, receiver_node)?;
        }
        if receiver.ty() != Type::Regex {
            return Err(self.refuse(
                node,
                "RegExp receiver may be undefined; guard it before use",
            ));
        }
        if method == "test" {
            return self.regex_test_value(node, receiver).map(Some);
        }
        if method == "constructor" {
            return Ok(Some(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: receiver,
                    loc: self.loc(receiver_node),
                }],
                result: Box::new(Expr::LibCall {
                    r#fn: "regex.constructorValue".into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        let result = match method {
            "source" | "flags" => Type::String,
            "lastIndex" => Type::F64,
            _ => return Err(self.refuse(node, "RegExp property is not ported")),
        };
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
        let receiver_node = member.expression();
        let mut receiver = self.expression(receiver_node)?;
        if receiver.ty() != Type::Regex {
            receiver = self.coerce(receiver, Type::Regex, receiver_node)?;
        }
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
