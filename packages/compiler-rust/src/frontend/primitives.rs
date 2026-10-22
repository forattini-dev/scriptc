//! Proven standard primitives lower through typed, eager argument boundaries.
use super::*;
use helpers::Helper;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

impl Lowerer<'_> {
    fn primitive_symbol(&self, id: u32, name: &str, owner: Option<&str>) -> bool {
        if id == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(id));
        symbol.name.as_ref() == name
            && !symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                source_frontend::frontend::bundled::bundled_lib_name(&file.file_name).is_some()
                    && owner.is_none_or(|name| {
                        let parent = decl.parent();
                        parent.kind() == SyntaxKind::InterfaceDeclaration
                            && parent.name().text() == name
                    })
            })
    }

    pub(super) fn primitive_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.name().text() != "length" {
            return Ok(None);
        }
        let id = self.symbol(node.name());
        if !self.primitive_symbol(id, "length", Some("String")) {
            return Ok(None);
        }
        let receiver = self.primitive_operand(node.expression())?;
        if receiver.ty() != Type::String {
            return Ok(None);
        }
        Ok(Some(Expr::StringIntrinsic {
            method: "length".into(),
            receiver: Box::new(receiver),
            args: vec![],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    pub(super) fn primitive_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let mut member = node.expression();
        while member.kind() == SyntaxKind::ParenthesizedExpression {
            member = member.expression();
        }
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let name = member.name().text();
        let member_id = self.symbol(member.name());
        let math_operation = crate::builtins::get("Math", name);
        let math = math_operation.is_some()
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "Math", None)
            }
            && self.primitive_symbol(member_id, name, Some("Math"));
        let string = crate::string_builtins::by_method(name)
            .filter(|_| name != "length" && self.primitive_symbol(member_id, name, Some("String")));
        if !math && string.is_none() {
            return Ok(None);
        }
        let mut values = Vec::new();
        if string.is_some() {
            let receiver = self.primitive_operand(member.expression())?;
            if receiver.ty() != Type::String {
                return Err(self.refuse(
                    member,
                    "standard string methods require a represented string receiver",
                ));
            }
            values.push(receiver);
            self.ensure_exception_classes(node)?;
        }
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    arg,
                    "standard primitive iterable argument spreads are not ported",
                ));
            }
            let mut value = self.primitive_operand(arg)?;
            // Unit tags use the existing nullable numeric ABI; they cannot be
            // passed as standalone Rust value slots. Preserve their evaluation.
            if matches!(value.ty(), Type::Null | Type::Undefined) {
                let ty = self.intern_union(vec![Type::F64, value.ty()]).unwrap();
                value = self.coerce(value, ty, arg)?;
            }
            values.push(value);
        }
        // Evaluate the receiver and ALL arguments before conversions, errors or
        // reduction. Unused extra arguments still have their source effects.
        let result = string.map_or(Type::F64, |operation| operation.result.clone());
        let mut helper = Helper::new(
            &format!("primitive_{name}"),
            values.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(node),
        );
        let operand = if string.is_some() { 1 } else { 0 };
        let mut numbers = Vec::new();
        let count = if let Some(operation) = string {
            operation.args.len()
        } else if math && matches!(name, "min" | "max" | "hypot") {
            values.len()
        } else {
            math_operation
                .as_ref()
                .map_or(1, |operation| operation.args.len())
        };
        for index in 0..count {
            let value = if let Some(operation) = string {
                let value = (operand + index < values.len())
                    .then(|| helper.read(&helper.param(operand + index)));
                self.primitive_string_argument(value, operation.args[index], node)?
            } else if operand + index < values.len() {
                self.primitive_number(helper.read(&helper.param(operand + index)), node)?
            } else {
                helper.number(f64::NAN)
            };
            let local = helper.local(&format!("argument{index}"), value.ty(), false);
            helper.declare(&local, value);
            numbers.push(helper.read(&local));
        }
        let value = if string.is_some() {
            Expr::StringIntrinsic {
                method: name.into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args: numbers,
                r#type: result.clone(),
                loc: helper.loc(),
            }
        } else {
            let (operation, args) = if matches!(name, "min" | "max" | "hypot") {
                (
                    format!("math.{name}Arr"),
                    vec![Expr::ArrayLit {
                        elems: numbers,
                        r#type: Type::Array {
                            elem: Box::new(Type::F64),
                        },
                        loc: helper.loc(),
                    }],
                )
            } else {
                (format!("math.{name}"), numbers)
            };
            Expr::LibCall {
                r#fn: operation,
                args,
                r#type: result.clone(),
                loc: helper.loc(),
            }
        };
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: result,
            loc: self.loc(node),
        }))
    }

    fn primitive_string_argument(
        &mut self,
        value: Option<Expr>,
        argument: crate::string_builtins::Argument,
        node: Node,
    ) -> Result<Expr, String> {
        use crate::string_builtins::Argument;
        let default = match argument {
            Argument::Number(value) => Expr::NumLit {
                value,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            },
            Argument::Text(value) => Expr::StrLit {
                value: value.into(),
                r#type: Type::String,
                loc: self.loc(node),
            },
        };
        let Some(value) = value else {
            return Ok(default);
        };
        if value.ty() == Type::Undefined {
            return Ok(default);
        }
        if let Type::Union { union_id } = value.ty() {
            let mut helper = Helper::new(
                "string_argument",
                vec![value.ty()],
                argument.ty(),
                self.loc(node),
            );
            let slot = helper.param(0);
            for (tag, arm) in self.unions[union_id].arms.clone().into_iter().enumerate() {
                let result = if arm == Type::Undefined {
                    default.clone()
                } else {
                    let narrowed = if arm == Type::Null {
                        Expr::UnitLit {
                            unit: "null",
                            r#type: Type::Null,
                            loc: helper.loc(),
                        }
                    } else {
                        Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(helper.read(&slot)),
                            r#type: arm,
                            loc: helper.loc(),
                        }
                    };
                    self.primitive_string_argument(Some(narrowed), argument, node)?
                };
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        value: Box::new(helper.read(&slot)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(result),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
            }
            helper.function.body.push(Stmt::Return {
                value: Some(default),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            return Ok(Expr::Call {
                callee,
                args: vec![value],
                r#type: argument.ty(),
                loc: self.loc(node),
            });
        }
        match argument {
            Argument::Number(_) => self.primitive_number(value, node),
            Argument::Text(_) => match value.ty() {
                Type::String => Ok(value),
                Type::Null => Ok(Expr::StrLit { value: "null".into(), r#type: Type::String, loc: self.loc(node) }),
                Type::Bool | Type::F64 => Ok(Expr::ToString { operand: Box::new(value), r#type: Type::String, loc: self.loc(node) }),
                _ => Err(self.refuse(node, "standard string arguments require represented primitives; object coercion hooks are not ported")),
            },
        }
    }

    // Type-only wrappers do not perform JavaScript numeric/string conversion.
    // Preserve the operand before applying the actual standard operation.
    fn primitive_operand(&mut self, mut node: Node) -> Result<Expr, String> {
        while matches!(
            node.kind(),
            SyntaxKind::ParenthesizedExpression
                | SyntaxKind::AsExpression
                | SyntaxKind::TypeAssertionExpression
                | SyntaxKind::SatisfiesExpression
                | SyntaxKind::NonNullExpression
        ) {
            node = node.expression();
        }
        self.expression(node)
    }

    /// Only represented primitives participate. Objects require observable
    /// ToPrimitive hooks; a numeric type assertion must never erase that work.
    fn primitive_number(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        let number = |n| Expr::NumLit {
            value: n,
            spelling: None,
            r#type: Type::F64,
            loc: self.loc(node),
        };
        match value.ty() {
            Type::F64 => Ok(value),
            Type::String => Ok(Expr::LibCall { r#fn: "num.fromString".into(), args: vec![value], r#type: Type::F64, loc: self.loc(node) }),
            Type::Bool => Ok(Expr::Ternary { cond: Box::new(value), then: Box::new(number(1.0)), else_: Box::new(number(0.0)), r#type: Type::F64, loc: self.loc(node) }),
            Type::Null => Ok(number(0.0)),
            Type::Undefined => Ok(number(f64::NAN)),
            ty @ Type::Union { union_id } => {
                let mut helper = Helper::new("primitive_number", vec![ty], Type::F64, self.loc(node));
                let slot = helper.param(0);
                for (tag, arm) in self.unions[union_id].arms.clone().into_iter().enumerate() {
                    let value = Expr::UnionNarrow { union_id: format!("u{union_id}"), tag, value: Box::new(helper.read(&slot)), r#type: arm, loc: helper.loc() };
                    let result = match value.ty() {
                        Type::Null => helper.number(0.0),
                        Type::Undefined => helper.number(f64::NAN),
                        _ => self.primitive_number(value, node)?,
                    };
                    helper.function.body.push(Stmt::If { cond: Expr::UnionIsTag { union_id: format!("u{union_id}"), tag, negated: false, value: Box::new(helper.read(&slot)), r#type: Type::Bool, loc: helper.loc() }, then: vec![Stmt::Return { value: Some(result), loc: helper.loc() }], else_: None, loc: helper.loc() });
                }
                helper.function.body.push(Stmt::Return { value: Some(helper.number(f64::NAN)), loc: helper.loc() });
                let callee = self.install_helper(helper.function);
                Ok(Expr::Call { callee, args: vec![value], r#type: Type::F64, loc: self.loc(node) })
            }
            _ => Err(self.refuse(node, "standard numeric arguments require represented primitives; object coercion hooks are not ported")),
        }
    }
}
