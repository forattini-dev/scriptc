//! Proven standard primitives lower through typed, eager argument boundaries.
use super::*;
use helpers::Helper;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

impl Lowerer<'_> {
    pub(super) fn primitive_symbol(&self, id: u32, name: &str, owner: Option<&str>) -> bool {
        if id == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(id));
        symbol.name.as_ref() == name
            && !symbol.declarations.is_empty()
            // A global value may share its symbol with type-only interface
            // augmentations (for example Node's Array<T>). They cannot replace
            // its runtime value. Still prove the value declaration itself and
            // every member declaration before selecting a native intrinsic.
            && (owner.is_some()
                || (!symbol.value_declaration.is_nil()
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(get_source_file_of_node(symbol.value_declaration)).file_name,
                    )
                    .is_some()))
            && symbol.declarations.iter().all(|decl| {
                if owner.is_none() && decl.kind() == SyntaxKind::InterfaceDeclaration {
                    return true;
                }
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
        let name = node.name().text();
        if node.expression().kind() == SyntaxKind::Identifier {
            let receiver = self.symbol(node.expression());
            let member = self.symbol(node.name());
            if self.primitive_symbol(receiver, "Number", None)
                && self.primitive_symbol(member, name, Some("NumberConstructor"))
            {
                let value = match name {
                    "MAX_SAFE_INTEGER" => 9_007_199_254_740_991.0,
                    "MIN_SAFE_INTEGER" => -9_007_199_254_740_991.0,
                    "MAX_VALUE" => f64::MAX,
                    "MIN_VALUE" => f64::from_bits(1),
                    "EPSILON" => f64::EPSILON,
                    "POSITIVE_INFINITY" => f64::INFINITY,
                    "NEGATIVE_INFINITY" => f64::NEG_INFINITY,
                    "NaN" => f64::NAN,
                    _ => return Ok(None),
                };
                return Ok(Some(Expr::NumLit {
                    value,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }));
            }
        }
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
        if matches!(name, "fromCharCode" | "fromCodePoint")
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "String", None)
            }
            && self.primitive_symbol(member_id, name, Some("StringConstructor"))
        {
            return self.string_construction_call(node, name).map(Some);
        }
        if matches!(name, "toString" | "toFixed")
            && self.primitive_symbol(member_id, name, Some("Number"))
        {
            return self.number_string_call(node, member).map(Some);
        }
        if name == "isArray"
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "Array", None)
            }
            && self.primitive_symbol(member_id, name, Some("ArrayConstructor"))
        {
            return self.array_brand_call(node).map(Some);
        }
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
        let string_identity = matches!(name, "toString" | "valueOf")
            && self.primitive_symbol(member_id, name, Some("String"));
        if !math && string.is_none() && !string_identity {
            return Ok(None);
        }
        let mut values = Vec::new();
        if string.is_some() || string_identity {
            let receiver = self.primitive_operand(member.expression())?;
            let receiver = self.live_member_receiver(member.expression(), receiver);
            let receiver = self.string_method_receiver(member, receiver)?;
            values.push(receiver);
            if string.is_some() {
                self.ensure_exception_classes(node)?;
            }
        }
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    arg,
                    "standard primitive iterable argument spreads are not ported",
                ));
            }
            let value = self.primitive_operand(arg)?;
            let value = self.primitive_capture(value, arg)?;
            values.push(value);
        }
        // Evaluate the receiver and ALL arguments before conversions, errors or
        // reduction. Unused extra arguments still have their source effects.
        let result = if string_identity {
            Type::String
        } else {
            string.map_or(Type::F64, |operation| operation.result.clone())
        };
        // A represented RegExp selects the existing regex overload, never
        // ToString(search). Ordinary strings retain the literal-search path.
        let regex_replace = string.is_some()
            && matches!(name, "replace" | "replaceAll")
            && values.get(1).is_some_and(|value| value.ty() == Type::Regex);
        let mut helper = Helper::new(
            &format!("primitive_{name}"),
            values.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(node),
        );
        let operand = if string.is_some() || string_identity {
            1
        } else {
            0
        };
        let mut numbers = Vec::new();
        let count = if string_identity {
            0
        } else if let Some(operation) = string {
            operation.args.len()
        } else if math && matches!(name, "min" | "max" | "hypot") {
            values.len()
        } else {
            math_operation
                .as_ref()
                .map_or(1, |operation| operation.args.len())
        };
        let callback_replace = regex_replace
            && values
                .get(2)
                .is_some_and(|value| matches!(value.ty(), Type::Func { .. }));
        for index in 0..if callback_replace { 0 } else { count } {
            let value = if regex_replace && index == 0 {
                helper.read(&helper.param(1))
            } else if let Some(operation) = string {
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
        // These two methods return the primitive string unchanged. Keep the
        // helper call: eliminating it would discard unused argument effects.
        let value = if string_identity {
            helper.read(&helper.param(0))
        } else if callback_replace {
            let callback = self.coerce(helper.read(&helper.param(2)), Type::Dyn, node)?;
            Expr::LibCall {
                r#fn: "regex.replaceCaptures".into(),
                args: vec![
                    helper.read(&helper.param(0)),
                    helper.read(&helper.param(1)),
                    callback,
                    Expr::BoolLit {
                        value: name == "replaceAll",
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                ],
                r#type: Type::String,
                loc: helper.loc(),
            }
        } else if regex_replace {
            Expr::RegexIntrinsic {
                method: name.into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args: numbers,
                r#type: Type::String,
                loc: helper.loc(),
            }
        } else if string.is_some() {
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

    fn array_brand_call(&mut self, node: Node) -> Result<Expr, String> {
        let mut values = Vec::new();
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    arg,
                    "standard primitive iterable argument spreads are not ported",
                ));
            }
            // A predicate observes the live slot, before any checker refinement.
            let mut value = self.condition_value(primitive_source(arg))?;
            if value.ty() == Type::Caught {
                value = self.coerce(value, Type::Dyn, arg)?;
            }
            let value = self.primitive_capture(value, arg)?;
            values.push(value);
        }
        let mut helper = Helper::new(
            "array_is_array",
            values.iter().map(Expr::ty).collect(),
            Type::Bool,
            self.loc(node),
        );
        let value = if values.is_empty() {
            Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            }
        } else {
            self.array_brand(helper.read(&helper.param(0)), node)
        };
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: values,
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }

    // Unit tags cannot occupy standalone function ABI slots. A void-valued
    // source call still evaluates here and contributes JavaScript undefined.
    pub(super) fn primitive_capture(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if value.ty() == Type::Void {
            let ty = self.intern_union(vec![Type::F64, Type::Undefined]).unwrap();
            let unit = Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            };
            return Ok(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: value,
                    loc: self.loc(node),
                }],
                result: Box::new(self.coerce(unit, ty.clone(), node)?),
                r#type: ty,
                loc: self.loc(node),
            });
        }
        if matches!(value.ty(), Type::Null | Type::Undefined) {
            let ty = self.intern_union(vec![Type::F64, value.ty()]).unwrap();
            return self.coerce(value, ty, node);
        }
        Ok(value)
    }

    fn number_string_call(&mut self, node: Node, member: Node) -> Result<Expr, String> {
        let fixed = member.name().text() == "toFixed";
        self.ensure_exception_classes(node)?;
        let receiver = self.primitive_operand(member.expression())?;
        if receiver.ty() != Type::F64 {
            return Err(self.refuse(
                member,
                "Number formatting requires a represented numeric receiver",
            ));
        }
        let mut values = vec![receiver];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    argument,
                    "Number formatting iterable argument spreads are not ported",
                ));
            }
            let value = self.primitive_operand(argument)?;
            values.push(self.primitive_capture(value, argument)?);
        }
        let mut helper = Helper::new(
            if fixed {
                "number_to_fixed"
            } else {
                "number_to_string"
            },
            values.iter().map(Expr::ty).collect(),
            Type::String,
            self.loc(node),
        );
        let radix = self.primitive_string_argument(
            (values.len() > 1).then(|| helper.read(&helper.param(1))),
            crate::string_builtins::Argument::Number(if fixed { 0.0 } else { 10.0 }),
            node,
        )?;
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: if fixed {
                    "num.toFixed"
                } else {
                    "num.toRadixString"
                }
                .into(),
                args: vec![helper.read(&helper.param(0)), radix],
                r#type: Type::String,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: values,
            r#type: Type::String,
            loc: self.loc(node),
        })
    }

    fn array_brand(&self, value: Expr, node: Node) -> Expr {
        let boolean = |value| Expr::BoolLit {
            value,
            r#type: Type::Bool,
            loc: self.loc(node),
        };
        match value.ty() {
            Type::Dyn => Expr::DynTest {
                value: Box::new(value),
                test: "array".into(),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            },
            Type::Array { .. } => boolean(true),
            Type::Record { shape_id } => boolean(self.records[shape_id].tuple),
            Type::Union { union_id } => self.unions[union_id].arms.iter().enumerate().rev().fold(
                boolean(false),
                |otherwise, (tag, arm)| {
                    let narrowed = Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(value.clone()),
                        r#type: arm.clone(),
                        loc: self.loc(node),
                    };
                    Expr::Ternary {
                        cond: Box::new(Expr::UnionIsTag {
                            union_id: format!("u{union_id}"),
                            tag,
                            negated: false,
                            value: Box::new(value.clone()),
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        }),
                        then: Box::new(self.array_brand(narrowed, node)),
                        else_: Box::new(otherwise),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }
                },
            ),
            _ => boolean(false),
        }
    }

    pub(super) fn primitive_string_argument(
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
            // The omitted/undefined default is semantic input. Parameters and
            // return type alone cannot distinguish a start of 0 from an end
            // of Infinity (or different default separator strings).
            let identity = match argument {
                Argument::Number(number) => format!("string_argument_number_{}", number.to_bits()),
                Argument::Text(text) => format!("string_argument_text_{:?}", text.as_bytes()),
            };
            let mut helper =
                Helper::new(&identity, vec![value.ty()], argument.ty(), self.loc(node));
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
    pub(super) fn primitive_operand(&mut self, node: Node) -> Result<Expr, String> {
        self.expression(primitive_source(node))
    }

    /// Only represented primitives participate. Objects require observable
    /// ToPrimitive hooks; a numeric type assertion must never erase that work.
    pub(super) fn primitive_number(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        let loc = self.loc(node);
        let number = |n| Expr::NumLit {
            value: n,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        match value.ty() {
            Type::F64 => Ok(value),
            Type::Bigint | Type::Symbol => {
                self.ensure_exception_classes(node)?;
                let kind = if value.ty() == Type::Bigint { "BigInt" } else { "Symbol" };
                let mut helper = Helper::new(&format!("primitive_number_error_{kind}"), vec![value.ty()], Type::F64, self.loc(node));
                helper.function.body.push(Stmt::Throw { value: Expr::LibCall { r#fn: "error.new".into(), args: vec![Expr::StrLit { value: format!("Cannot convert a {kind} value to a number"), r#type: Type::String, loc: self.loc(node) }], r#type: Type::Object { class_name: "%TypeError".into() }, loc: self.loc(node) }, loc: self.loc(node) });
                Ok(Expr::Call { callee: self.install_helper(helper.function), args: vec![value], r#type: Type::F64, loc: self.loc(node) })
            }
            Type::String => Ok(Expr::LibCall { r#fn: "num.fromString".into(), args: vec![value], r#type: Type::F64, loc: self.loc(node) }),
            Type::Bool => Ok(Expr::Ternary { cond: Box::new(value), then: Box::new(number(1.0)), else_: Box::new(number(0.0)), r#type: Type::F64, loc: self.loc(node) }),
            Type::Null | Type::Undefined => {
                if matches!(value, Expr::UnitLit { .. }) {
                    Ok(number(if value.ty() == Type::Null { 0.0 } else { f64::NAN }))
                } else {
                    self.strict_number_primitive(value, node)
                }
            }
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

pub(super) fn primitive_source(mut node: Node) -> Node {
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
    node
}
