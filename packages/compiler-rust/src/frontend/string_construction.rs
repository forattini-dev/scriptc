//! String factories retain eager argument values and sequential conversions.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn string_construction_call(
        &mut self,
        node: Node,
        name: &str,
    ) -> Result<Expr, String> {
        let operation = crate::builtins::get("String", name).expect("proven String member");
        let mut values = Vec::new();
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    argument,
                    "String code construction iterable spreads are not ported",
                ));
            }
            let value = self.primitive_operand(argument)?;
            if !self.numeric_operand_domain(&value.ty()) {
                return Err(self.refuse(argument, "String code construction requires represented primitives; object coercion hooks are not ported"));
            }
            values.push(self.primitive_capture(value, argument)?);
        }
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            &format!("string_{name}"),
            values.iter().map(Expr::ty).collect(),
            Type::String,
            self.loc(node),
        );
        let array_type = Type::Array {
            elem: Box::new(Type::F64),
        };
        let mut numbers = Vec::new();
        let mut chunks = Vec::new();
        for index in 0..values.len() {
            // All original values are helper arguments, so RHS effects and
            // abrupt completions precede even the first ToNumber conversion.
            // Number() and ToNumeric would incorrectly accept BigInt here.
            let number = self.strict_number_primitive(helper.read(&helper.param(index)), node)?;
            let slot = helper.local(&format!("number{index}"), Type::F64, false);
            helper.declare(&slot, number);
            numbers.push(helper.read(&slot));
            if name == "fromCodePoint" {
                // Validate this number before converting the next argument.
                // The shared library ABI also supports an arbitrary numeric
                // array, but converting all source arguments first would
                // replace an earlier RangeError with a later Symbol error.
                let chunk = helper.local(&format!("chunk{index}"), Type::String, false);
                helper.declare(
                    &chunk,
                    Expr::LibCall {
                        r#fn: operation.ir.into(),
                        args: vec![Expr::ArrayLit {
                            elems: vec![helper.read(&slot)],
                            r#type: array_type.clone(),
                            loc: helper.loc(),
                        }],
                        r#type: Type::String,
                        loc: helper.loc(),
                    },
                );
                chunks.push(helper.read(&chunk));
            }
        }
        let result = if name == "fromCodePoint" {
            chunks
                .into_iter()
                .reduce(|left, right| self.string_concat(left, right, node))
                .unwrap_or_else(|| Expr::StrLit {
                    value: "".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                })
        } else {
            Expr::LibCall {
                r#fn: operation.ir.into(),
                args: vec![Expr::ArrayLit {
                    elems: numbers,
                    r#type: array_type,
                    loc: helper.loc(),
                }],
                r#type: Type::String,
                loc: helper.loc(),
            }
        };
        helper.function.body.push(Stmt::Return {
            value: Some(result),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::String,
            loc: self.loc(node),
        })
    }
}
