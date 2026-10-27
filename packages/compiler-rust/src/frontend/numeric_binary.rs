//! Numeric operators capture both operands before converting either primitive.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn numeric_binary(
        &mut self,
        left: Expr,
        right: Expr,
        op: &str,
        node: Node,
    ) -> Result<Expr, String> {
        for ty in [left.ty(), right.ty()] {
            if !self.numeric_operand_domain(&ty) {
                return Err(self.refuse(node, "numeric object coercion hooks are not ported"));
            }
        }
        self.ensure_exception_classes(node)?;
        let result_type = self.numeric_result_type(&left.ty(), &right.ty(), op);
        let operation = match op {
            "+" => "add",
            "-" => "sub",
            "*" => "mul",
            "/" => "div",
            "%" => "rem",
            "**" => "pow",
            _ => unreachable!("numeric operator family"),
        };
        // Boxing only retains the original values. In particular it must not
        // perform Number() conversion before the other operand is evaluated.
        let args = vec![
            self.coerce(left, Type::Dyn, node.left())?,
            self.coerce(right, Type::Dyn, node.right())?,
        ];
        let mut helper = Helper::new(
            &format!("numeric_{operation}"),
            vec![Type::Dyn, Type::Dyn],
            Type::Dyn,
            self.loc(node),
        );
        if op == "+" {
            let string_test = |index| Expr::DynTest {
                value: Box::new(helper.read(&helper.param(index))),
                test: "string".into(),
                negated: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            };
            let condition = Expr::Logical {
                op: "||".into(),
                left: Box::new(string_test(0)),
                right: Box::new(string_test(1)),
                r#type: Type::Bool,
                loc: helper.loc(),
            };
            let string = self.string_addition(
                helper.read(&helper.param(0)),
                helper.read(&helper.param(1)),
                node,
            )?;
            helper.function.body.push(Stmt::If {
                cond: condition,
                then: vec![Stmt::Return {
                    value: Some(self.coerce(string, Type::Dyn, node)?),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
        }
        let a = helper.local("left_numeric", Type::Dyn, false);
        let b = helper.local("right_numeric", Type::Dyn, false);
        let left_numeric = self.numeric_primitive(helper.read(&helper.param(0)), node)?;
        let right_numeric = self.numeric_primitive(helper.read(&helper.param(1)), node)?;
        helper.declare(&a, left_numeric);
        helper.declare(&b, right_numeric);
        let test_loc = helper.loc();
        let is_bigint = |value| Expr::DynTest {
            value: Box::new(value),
            test: "bigint".into(),
            negated: false,
            r#type: Type::Bool,
            loc: test_loc.clone(),
        };
        let mixed = numeric_type_error(
            "Cannot mix BigInt and other types, use explicit conversions",
            helper.loc(),
        );
        let bigint = self.bigint_operation(
            &format!("bigint.{operation}"),
            vec![
                self.coerce(helper.read(&a), Type::Bigint, node)?,
                self.coerce(helper.read(&b), Type::Bigint, node)?,
            ],
            node,
        );
        helper.function.body.push(Stmt::If {
            cond: is_bigint(helper.read(&a)),
            then: vec![Stmt::If {
                cond: is_bigint(helper.read(&b)),
                then: vec![Stmt::Return {
                    value: Some(self.coerce(bigint, Type::Dyn, node)?),
                    loc: helper.loc(),
                }],
                else_: Some(vec![mixed.clone()]),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        helper.function.body.push(Stmt::If {
            cond: is_bigint(helper.read(&b)),
            then: vec![mixed],
            else_: None,
            loc: helper.loc(),
        });
        let number = Expr::Bin {
            op: op.into(),
            left: Box::new(self.coerce(helper.read(&a), Type::F64, node)?),
            right: Box::new(self.coerce(helper.read(&b), Type::F64, node)?),
            r#type: Type::F64,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::Return {
            value: Some(self.coerce(number, Type::Dyn, node)?),
            loc: helper.loc(),
        });
        let call = Expr::Call {
            callee: self.install_helper(helper.function),
            args,
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        self.coerce(call, result_type, node)
    }

    fn numeric_operand_domain(&self, ty: &Type) -> bool {
        match ty {
            Type::Dyn
            | Type::F64
            | Type::Bigint
            | Type::String
            | Type::Bool
            | Type::Null
            | Type::Undefined
            | Type::Symbol => true,
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.numeric_operand_domain(arm)),
            _ => false,
        }
    }

    fn numeric_domain(&self, ty: &Type, addition: bool) -> u8 {
        match ty {
            Type::F64 | Type::Bool | Type::Null | Type::Undefined => 1,
            Type::Bigint => 2,
            Type::String => {
                if addition {
                    4
                } else {
                    1
                }
            }
            Type::Dyn => {
                if addition {
                    7
                } else {
                    3
                }
            }
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .fold(0, |mask, arm| mask | self.numeric_domain(arm, addition)),
            _ => 0,
        }
    }

    fn numeric_result_type(&mut self, left: &Type, right: &Type, op: &str) -> Type {
        let a = self.numeric_domain(left, op == "+");
        let b = self.numeric_domain(right, op == "+");
        let result = (a & b & 3) | if op == "+" && (a | b) & 4 != 0 { 4 } else { 0 };
        match result {
            1 => Type::F64,
            2 => Type::Bigint,
            3 => self.intern_union(vec![Type::F64, Type::Bigint]).unwrap(),
            4 => Type::String,
            _ => Type::Dyn,
        }
    }

    /// Reserve the result ABI before module slots and captures are allocated.
    /// Checker-only `number` inference for `any - any` loses valid BigInts.
    pub(super) fn numeric_initializer_type(&mut self, node: Node) -> Option<Type> {
        let node = receivers::reference_node(node);
        if node.kind() != SyntaxKind::BinaryExpression {
            return None;
        }
        let op = match node.operator_token().kind() {
            SyntaxKind::PlusToken => "+",
            SyntaxKind::MinusToken => "-",
            SyntaxKind::AsteriskToken => "*",
            SyntaxKind::SlashToken => "/",
            SyntaxKind::PercentToken => "%",
            SyntaxKind::AsteriskAsteriskToken => "**",
            _ => return None,
        };
        let left = self.numeric_source_type(node.left())?;
        let right = self.numeric_source_type(node.right())?;
        if !self.numeric_operand_domain(&left) || !self.numeric_operand_domain(&right) {
            return None;
        }
        Some(self.numeric_result_type(&left, &right, op))
    }

    fn numeric_source_type(&mut self, node: Node) -> Option<Type> {
        let node = receivers::reference_node(node);
        if let Some(ty) = self.numeric_initializer_type(node) {
            return Some(ty);
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if let Some(ty) = self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|local| local.r#type.clone())
                .or_else(|| self.var_types.get(&symbol).cloned())
                .or_else(|| self.module_vars.get(&symbol).cloned())
            {
                return Some(ty);
            }
        }
        self.ty(node).ok()
    }

    fn numeric_primitive(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        let mut helper = Helper::new(
            "to_numeric_primitive",
            vec![Type::Dyn],
            Type::Dyn,
            self.loc(node),
        );
        let input = helper.read(&helper.param(0));
        helper.function.body.push(Stmt::If {
            cond: Expr::DynTest {
                value: Box::new(input.clone()),
                test: "bigint".into(),
                negated: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(input.clone()),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        // The existing primitive ToNumber helper supplies string/boolean/unit
        // conversion, Symbol errors and the explicit object-hook boundary.
        let number = self.strict_number_primitive(input, node)?;
        helper.function.body.push(Stmt::Return {
            value: Some(self.coerce(number, Type::Dyn, node)?),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![value],
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }
}

fn numeric_type_error(message: &str, loc: Loc) -> Stmt {
    Stmt::Throw {
        value: Expr::LibCall {
            r#fn: "error.new".into(),
            args: vec![Expr::StrLit {
                value: message.into(),
                r#type: Type::String,
                loc: loc.clone(),
            }],
            r#type: Type::Object {
                class_name: "%TypeError".into(),
            },
            loc: loc.clone(),
        },
        loc,
    }
}
