//! Declaration-proven standard object surfaces, before prototype mutation.
use super::*;
use helpers::Helper;

// Presence describes the pinned JavaScript surface, independently of whether
// invoking every member is ported. Never hide an API to select a fallback path.
const JSON_PROPERTIES: &[&str] = &[
    "parse",
    "stringify",
    "rawJSON",
    "isRawJSON",
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

impl Lowerer<'_> {
    pub(super) fn standard_object_presence(&mut self, node: Node) -> Result<Expr, String> {
        let mut receiver = node.right();
        while receiver.kind() == SyntaxKind::ParenthesizedExpression {
            receiver = receiver.expression();
        }
        let symbol = self.symbol(receiver);
        if receiver.kind() != SyntaxKind::Identifier || !self.primitive_symbol(symbol, "JSON", None)
        {
            return Err(self.refuse(node, "in operator requires a proven standard JSON object; general prototype presence is not ported"));
        }
        let value = self.expression(node.left())?;
        if self.native_type_contains(&value.ty(), |ty| {
            !matches!(
                ty,
                Type::String
                    | Type::F64
                    | Type::Bool
                    | Type::Null
                    | Type::Undefined
                    | Type::Void
                    | Type::Symbol
                    | Type::Dyn
                    | Type::Caught
                    | Type::Union { .. }
            )
        }) {
            return Err(self.refuse(
                node.left(),
                "object ToPropertyKey for standard object presence is not ported",
            ));
        }
        self.ensure_exception_classes(node)?;
        let value = if value.ty() == Type::Caught {
            Expr::CaughtToDyn {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }
        } else {
            self.coerce(value, Type::Dyn, node.left())?
        };
        let mut helper = Helper::new(
            "json_property_presence",
            vec![Type::Dyn],
            Type::Bool,
            self.loc(node),
        );
        let key = helper.param(0);
        // Symbols are property identities, never their descriptions or strings.
        let tag = Expr::LibCall {
            r#fn: "sym.toStringTag".into(),
            args: vec![],
            r#type: Type::Symbol,
            loc: helper.loc(),
        };
        let tag = self.coerce(tag, Type::Dyn, node)?;
        helper.function.body.push(Stmt::If {
            cond: Expr::DynTest {
                value: Box::new(helper.read(&key)),
                test: "symbol".into(),
                negated: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(Expr::DynScalarEq {
                    left: Box::new(helper.read(&key)),
                    right: Box::new(tag),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        let text = helper.local("key", Type::String, false);
        helper.declare(
            &text,
            Expr::ToString {
                operand: Box::new(helper.read(&key)),
                r#type: Type::String,
                loc: helper.loc(),
            },
        );
        let present = JSON_PROPERTIES.iter().fold(
            Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            |otherwise, name| Expr::Logical {
                op: "||".into(),
                left: Box::new(otherwise),
                right: Box::new(Expr::StrEq {
                    negated: false,
                    left: Box::new(helper.read(&text)),
                    right: Box::new(Expr::StrLit {
                        value: (*name).into(),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
        );
        helper.function.body.push(Stmt::Return {
            value: Some(present),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![value],
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }
}
