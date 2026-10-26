//! Global and Number parsers share callable identities and eager argument capture.
use super::*;
use helpers::Helper;

fn parser(name: &str) -> bool {
    matches!(name, "parseInt" | "parseFloat")
}

impl Lowerer<'_> {
    pub(super) fn number_parser_type(&self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let name = self.checker.sym(symbol).name.as_ref();
        (parser(name)
            && (self.primitive_symbol(symbol.0, name, Some("NumberConstructor"))
                || self.primitive_symbol(symbol.0, name, None)))
        .then(number_constructor::callable)
    }

    fn number_parser_name(&mut self, node: Node) -> Option<String> {
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::Identifier && parser(node.text()) {
            let symbol = self.symbol(node);
            return self
                .primitive_symbol(symbol, node.text(), None)
                .then(|| node.text().into());
        }
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.expression().kind() != SyntaxKind::Identifier
            || !parser(node.name().text())
        {
            return None;
        }
        let base = self.symbol(node.expression());
        let member = self.symbol(node.name());
        (self.primitive_symbol(base, "Number", None)
            && self.primitive_symbol(member, node.name().text(), Some("NumberConstructor")))
        .then(|| node.name().text().into())
    }

    pub(super) fn number_parser_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(name) = self.number_parser_name(node.expression()) else {
            return Ok(None);
        };
        for argument in node
            .arguments()
            .into_iter()
            .take(if name == "parseInt" { 2 } else { 1 })
        {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "numeric parser iterable spreads are not ported"));
            }
            if let Ok(ty) = self.ty(primitives::primitive_source(argument))
                && self.native_type_contains(&ty, |arm| {
                    matches!(
                        arm,
                        Type::Record { .. }
                            | Type::Array { .. }
                            | Type::Object { .. }
                            | Type::Map { .. }
                            | Type::Set { .. }
                            | Type::Func { .. }
                            | Type::Classval { .. }
                            | Type::Bytes { .. }
                    )
                })
            {
                return Err(self.refuse(
                    argument,
                    "numeric parser object coercion hooks are not ported",
                ));
            }
        }
        self.call_value(node).map(Some)
    }

    pub(super) fn number_parser_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(name) = self.number_parser_name(node) else {
            return Ok(None);
        };
        self.ensure_exception_classes(node)?;
        let Type::Func { params, .. } = number_constructor::callable() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            &format!("standard_{name}"),
            params,
            Type::F64,
            self.loc(node),
        );
        helper.function.rest = true;
        let arguments = helper.param(0);
        let read = |index: f64| Expr::Ternary {
            cond: Box::new(Expr::Bin {
                op: "<".into(),
                left: Box::new(helper.number(index)),
                right: Box::new(helper.length(&arguments)),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            then: Box::new(Expr::ArrayGet {
                arr: Box::new(helper.read(&arguments)),
                index: Box::new(helper.number(index)),
                r#type: Type::Dyn,
                loc: helper.loc(),
            }),
            else_: Box::new(Expr::DynFrom {
                value: Box::new(Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: helper.loc(),
                }),
                r#type: Type::Dyn,
                loc: helper.loc(),
            }),
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        let input = read(0.0);
        let radix = (name == "parseInt").then(|| read(1.0));
        // Capture all source arguments in the rest vector before ToString.
        // Conversion is sequential: a Symbol input must throw before radix
        // conversion, including when the radix itself would throw.
        let text = helper.local("text", Type::String, false);
        helper.declare(
            &text,
            Expr::ToString {
                operand: Box::new(input),
                r#type: Type::String,
                loc: self.loc(node),
            },
        );
        let mut args = vec![helper.read(&text)];
        if let Some(radix) = radix {
            args.push(self.strict_number_primitive(radix, node)?);
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: format!("num.{name}"),
                args,
                r#type: Type::F64,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: number_constructor::callable(),
            loc: self.loc(node),
        }))
    }
}
