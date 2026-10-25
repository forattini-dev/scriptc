//! BigInt source values retain arbitrary precision through the owned value ABI.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn bigint_operation(&self, name: &str, args: Vec<Expr>, node: Node) -> Expr {
        let (_, result, _) = ir::bigint::signature(name).expect("BigInt operation");
        Expr::LibCall {
            r#fn: name.into(),
            args,
            r#type: result,
            loc: self.loc(node),
        }
    }

    pub(super) fn bigint_literal(&self, node: Node) -> Expr {
        self.bigint_operation(
            "bigint.parse",
            vec![Expr::StrLit {
                value: node.text().trim_end_matches('n').replace('_', ""),
                r#type: Type::String,
                loc: self.loc(node),
            }],
            node,
        )
    }

    pub(super) fn bigint_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = receivers::reference_node(node.expression());
        let constructor = member.kind() == SyntaxKind::Identifier && {
            let symbol = self.symbol(member);
            self.primitive_symbol(symbol, "BigInt", None)
        };
        let method = member.kind() == SyntaxKind::PropertyAccessExpression
            && member.name().text() == "toString"
            && self.ty(member.expression()).ok() == Some(Type::Bigint);
        if !constructor && !method {
            return Ok(None);
        }
        self.ensure_exception_classes(node)?;
        let mut values = Vec::new();
        if method {
            let value = self.expression(member.expression())?;
            values.push(self.coerce(value, Type::Bigint, member.expression())?);
        }
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(arg, "BigInt iterable argument spreads are not ported"));
            }
            let value = self.primitive_operand(arg)?;
            values.push(self.primitive_capture(value, arg)?);
        }
        let result = if constructor {
            Type::Bigint
        } else {
            Type::String
        };
        let mut helper = Helper::new(
            if constructor {
                "bigint_constructor"
            } else {
                "bigint_to_string"
            },
            values.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(node),
        );
        let value = if constructor {
            if values.is_empty() {
                return Err(self.refuse(
                    node,
                    "BigInt constructor needs a represented primitive argument",
                ));
            }
            let value = helper.read(&helper.param(0));
            match value.ty() {
                Type::Bigint => value,
                Type::String => self.bigint_operation("bigint.fromString", vec![value], node),
                Type::F64 => self.bigint_operation("bigint.fromNumber", vec![value], node),
                Type::Bool => self.bigint_operation("bigint.fromBool", vec![value], node),
                _ => return Err(self.refuse(node, "BigInt constructor coercion requires represented string, number, boolean or bigint")),
            }
        } else if values.len() == 1 {
            self.bigint_operation("bigint.toString", vec![helper.read(&helper.param(0))], node)
        } else {
            let radix = helper.read(&helper.param(1));
            let radix = self.primitive_string_argument(
                Some(radix),
                crate::string_builtins::Argument::Number(10.0),
                node,
            )?;
            self.bigint_operation(
                "bigint.radix",
                vec![helper.read(&helper.param(0)), radix],
                node,
            )
        };
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(node),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: result,
            loc: self.loc(node),
        }))
    }
}
