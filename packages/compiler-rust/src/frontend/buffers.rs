//! Declaration-proven Buffer factories use owning byte handles with runtime brands.
use super::*;
use helpers::Helper;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};
impl Lowerer<'_> {
    fn standard_buffer_symbol(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        matches!(symbol.name.as_ref(), "Buffer" | "BufferConstructor")
            && !symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                let path = &file.file_name;
                (path.contains("/@types/node/") || path.contains("/bun-types/"))
                    && (path.ends_with("/buffer.d.ts") || path.ends_with("/buffer.buffer.d.ts"))
            })
    }
    pub(super) fn standard_buffer_type(&self, id: TypeId) -> bool {
        self.standard_buffer_symbol(self.checker.ty(id).symbol().0)
    }
    pub(super) fn buffer_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let symbol = self.symbol(member.expression());
        if !self.standard_buffer_symbol(symbol) {
            return Ok(None);
        }
        let method = member.name().text();
        if !matches!(
            method,
            "from" | "alloc" | "allocUnsafe" | "isBuffer" | "byteLength"
        ) {
            return Err(self.refuse(node, "Buffer static is not ported"));
        }
        let method_symbol = self.symbol(member.name());
        if method_symbol == 0
            || !self
                .checker
                .sym(SymbolId(method_symbol))
                .declarations
                .iter()
                .all(|decl| {
                    let file = source_file_info(get_source_file_of_node(*decl));
                    let path = &file.file_name;
                    path.contains("/@types/node/")
                        && (path.ends_with("/buffer.d.ts") || path.ends_with("/buffer.buffer.d.ts"))
                })
        {
            return Err(self.refuse(node, "Buffer method declaration is not ported"));
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if method == "from" {
            return self.buffer_from_call(node).map(Some);
        }
        if method == "byteLength" {
            if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(node, "Buffer.byteLength requires one native string; encoding overloads are not ported"));
            }
            let value = self.expression(args[0])?;
            if value.ty() != Type::String {
                return Err(self.refuse(args[0], "Buffer.byteLength requires a native string"));
            }
            return Ok(Some(Expr::LibCall {
                r#fn: "buffer.byteLenStr".into(),
                args: vec![
                    value,
                    Expr::StrLit {
                        value: "utf8".into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                ],
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(node, "Buffer factory overload is not ported"));
        }
        self.ensure_exception_classes(node)?;
        let value = self.expression(args[0])?;
        let (ir, value, result) = if method == "isBuffer" {
            (
                "buffer.isBuffer",
                self.coerce(value, Type::Dyn, args[0])?,
                Type::Bool,
            )
        } else {
            if value.ty() != Type::F64 {
                return Err(self.refuse(
                    node,
                    "Buffer allocation requires a represented numeric size",
                ));
            }
            ("buffer.alloc", value, Type::bytes())
        };
        Ok(Some(Expr::LibCall {
            r#fn: ir.into(),
            args: vec![value],
            r#type: result,
            loc: self.loc(node),
        }))
    }

    fn buffer_from_call(&mut self, node: Node) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let mut values = Vec::new();
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(
                    self.refuse(arg, "Buffer.from iterable argument spreads are not ported")
                );
            }
            let value = self.primitive_operand(arg)?;
            values.push(self.primitive_capture(value, arg)?);
        }
        if values.is_empty() {
            values.push(self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                Type::Dyn,
                node,
            )?);
        }
        let mut helper = Helper::new(
            "buffer_from",
            values.iter().map(Expr::ty).collect(),
            Type::bytes(),
            self.loc(node),
        );
        let source = self.coerce(helper.read(&helper.param(0)), Type::Dyn, node)?;
        let encoding = if values.len() > 1 {
            let raw = self.coerce(helper.read(&helper.param(1)), Type::Dyn, node)?;
            Expr::Ternary {
                cond: Box::new(Expr::DynTest {
                    value: Box::new(raw.clone()),
                    test: "string".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                then: Box::new(self.coerce(raw, Type::String, node)?),
                else_: Box::new(Expr::StrLit {
                    value: "utf8".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                }),
                r#type: Type::String,
                loc: helper.loc(),
            }
        } else {
            Expr::StrLit {
                value: "utf8".into(),
                r#type: Type::String,
                loc: helper.loc(),
            }
        };
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: "buffer.fromDyn".into(),
                args: vec![source, encoding],
                r#type: Type::bytes(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::bytes(),
            loc: self.loc(node),
        })
    }

    pub(super) fn bytes_string_call(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let mut values = vec![receiver];
        if node.arguments().len() > 1 {
            return Err(self.refuse(node, "Buffer.toString start/end overloads are not ported"));
        }
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    arg,
                    "Buffer.toString iterable argument spreads are not ported",
                ));
            }
            let value = self.primitive_operand(arg)?;
            values.push(self.primitive_capture(value, arg)?);
        }
        let mut helper = Helper::new(
            "bytes_to_string",
            values.iter().map(Expr::ty).collect(),
            Type::String,
            self.loc(node),
        );
        let bytes = helper.read(&helper.param(0));
        // Source lookup on a Uint8Array selects its join-based method, even
        // when a type assertion or typed alias calls it a Buffer.
        helper.function.body.push(Stmt::If {
            cond: Expr::Unary {
                op: "!".into(),
                operand: Box::new(Expr::LibCall {
                    r#fn: "buffer.isBuffer".into(),
                    args: vec![self.coerce(bytes.clone(), Type::Dyn, node)?],
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(Expr::BytesIntrinsic {
                    method: "join".into(),
                    receiver: Box::new(bytes.clone()),
                    args: vec![Expr::StrLit {
                        value: ",".into(),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }],
                    r#type: Type::String,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        helper.function.body.push(Stmt::If {
            cond: Expr::Bin {
                op: "===".into(),
                left: Box::new(Expr::BytesIntrinsic {
                    method: "length".into(),
                    receiver: Box::new(bytes.clone()),
                    args: vec![],
                    r#type: Type::F64,
                    loc: helper.loc(),
                }),
                right: Box::new(helper.number(0.0)),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(Expr::StrLit {
                    value: "".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        let default = Expr::StrLit {
            value: "utf8".into(),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let encoding = if values.len() > 1 {
            let raw = self.coerce(helper.read(&helper.param(1)), Type::Dyn, node)?;
            // Node reports an unsupported bigint encoding with its `n`
            // suffix. No bigint spelling is a valid encoding name.
            let text = Expr::Ternary {
                cond: Box::new(Expr::DynTest {
                    value: Box::new(raw.clone()),
                    test: "bigint".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                then: Box::new(self.bigint_operation(
                    "bigint.inspect",
                    vec![self.coerce(raw.clone(), Type::Bigint, node)?],
                    node,
                )),
                else_: Box::new(Expr::ToString {
                    operand: Box::new(raw.clone()),
                    r#type: Type::String,
                    loc: helper.loc(),
                }),
                r#type: Type::String,
                loc: helper.loc(),
            };
            Expr::Ternary {
                cond: Box::new(Expr::DynTest {
                    value: Box::new(raw.clone()),
                    test: "undefined".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                then: Box::new(default),
                else_: Box::new(text),
                r#type: Type::String,
                loc: helper.loc(),
            }
        } else {
            default
        };
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::BytesIntrinsic {
                method: "toStringVar".into(),
                receiver: Box::new(bytes),
                args: vec![encoding],
                r#type: Type::String,
                loc: helper.loc(),
            }),
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
