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
    pub(super) fn standard_buffer_value(&mut self, node: Node) -> bool {
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            return self.standard_buffer_symbol(symbol);
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression && node.name().text() == "Buffer" {
            let receiver = receivers::reference_node(node.expression());
            if receiver.kind() == SyntaxKind::Identifier {
                if self
                    .native_namespace(receiver)
                    .is_some_and(|module| matches!(module, "buffer" | "node:buffer"))
                {
                    return true;
                }
                let lexical_buffer = get_source_file_of_node(receiver)
                    .statements()
                    .into_iter()
                    .filter(|statement| statement.kind() == SyntaxKind::VariableStatement)
                    .flat_map(|statement| statement.declaration_list().declarations().nodes())
                    .any(|declaration| {
                        if declaration.name().kind() != SyntaxKind::Identifier
                            || declaration.name().text() != receiver.text()
                        {
                            return false;
                        }
                        let call = primitives::primitive_source(declaration.initializer());
                        call.kind() == SyntaxKind::CallExpression
                            && call.expression().kind() == SyntaxKind::Identifier
                            && call.expression().text() == "require"
                            && call.arguments().len() == 1
                            && call.arguments().first().is_some_and(|argument| {
                                argument.kind() == SyntaxKind::StringLiteral
                                    && matches!(argument.text(), "buffer" | "node:buffer")
                            })
                    });
                if lexical_buffer {
                    return true;
                }
            }
            let symbol = self.symbol(node);
            return self.standard_buffer_symbol(symbol);
        }
        false
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
            "from"
                | "alloc"
                | "allocUnsafe"
                | "allocUnsafeSlow"
                | "isBuffer"
                | "byteLength"
                | "concat"
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
        if method == "concat" {
            if !(1..=2).contains(&args.len())
                || args
                    .iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "Buffer.concat requires a represented byte array and optional numeric totalLength",
                ));
            }
            let list = self.expected_expression(
                args[0],
                Type::Array {
                    elem: Box::new(Type::bytes()),
                },
            )?;
            let mut values = vec![list];
            if let Some(total) = args.get(1) {
                values.push(self.expected_expression(*total, Type::F64)?);
            }
            return Ok(Some(Expr::LibCall {
                r#fn: if values.len() == 1 {
                    "buffer.concat".into()
                } else {
                    "buffer.concatLen".into()
                },
                args: values,
                r#type: Type::bytes(),
                loc: self.loc(node),
            }));
        }
        if method == "from" {
            return self.buffer_from_call(node).map(Some);
        }
        if method == "byteLength" {
            if args.is_empty()
                || args.len() > 2
                || args
                    .iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "Buffer.byteLength requires a native string and optional string encoding",
                ));
            }
            let value = self.expression(args[0])?;
            let value = if !matches!(value.ty(), Type::String | Type::Dyn)
                && self.ty(args[0]).ok() == Some(Type::String)
            {
                // A typeof guard can refine the checker view while the owning
                // local keeps an earlier unknown/union ABI. Check that view at
                // this call boundary instead of rejecting the guarded value.
                self.coerce(value, Type::String, args[0])?
            } else {
                value
            };
            if !matches!(value.ty(), Type::String | Type::Dyn) {
                return Err(self.refuse(args[0], "Buffer.byteLength requires a native string"));
            }
            let encoding = if let Some(encoding) = args.get(1) {
                self.expected_expression(*encoding, Type::String)?
            } else {
                Expr::StrLit {
                    value: "utf8".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }
            };
            return Ok(Some(Expr::LibCall {
                r#fn: if value.ty() == Type::String {
                    "buffer.byteLenStr"
                } else {
                    "buffer.byteLenDyn"
                }
                .into(),
                args: vec![value, encoding],
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
            let definitely_non_buffer = match value.ty() {
                Type::Bytes { .. } | Type::Dyn | Type::Caught => false,
                Type::Union { union_id } => self.unions[union_id]
                    .arms
                    .iter()
                    .all(|arm| !matches!(arm, Type::Bytes { .. } | Type::Dyn | Type::Caught)),
                _ => true,
            };
            if definitely_non_buffer
                && primitives::primitive_source(args[0]).kind() == SyntaxKind::Identifier
            {
                // A represented non-byte identifier cannot acquire Buffer's
                // runtime brand. Publishing the exact predicate result also
                // prevents TypeScript's synthetic `T & Buffer` true branch
                // from demanding an impossible native byte view.
                return Ok(Some(Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                }));
            }
            (
                "buffer.isBuffer",
                self.coerce(value, Type::Dyn, args[0])?,
                Type::Bool,
            )
        } else {
            // JavaScript dependencies commonly carry an options record as an
            // owning dynamic value and narrow its `size` field before calling
            // Buffer.allocUnsafe. Node still requires the value at this exact
            // boundary to be numeric, so retain that check as a Dyn -> f64
            // conversion instead of refusing an otherwise represented value.
            let value = self.coerce(value, Type::F64, args[0])?;
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
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if let [buffer, offset, length] = args.as_slice()
            && [buffer, offset, length]
                .iter()
                .all(|arg| arg.kind() == SyntaxKind::PropertyAccessExpression)
            && buffer.name().text() == "buffer"
            && offset.name().text() == "byteOffset"
            && length.name().text() == "byteLength"
        {
            let source = buffer.expression();
            let symbol = self.symbol(source);
            if source.kind() == SyntaxKind::Identifier
                && symbol != 0
                && self.symbol(offset.expression()) == symbol
                && self.symbol(length.expression()) == symbol
                && self.ty(source)? == Type::bytes()
            {
                self.ensure_exception_classes(node)?;
                let view = self.expected_expression(source, Type::bytes())?;
                return Ok(Expr::LibCall {
                    r#fn: "buffer.fromU8Window".into(),
                    args: vec![view],
                    r#type: Type::bytes(),
                    loc: self.loc(node),
                });
            }
        }
        self.ensure_exception_classes(node)?;
        let mut values = Vec::new();
        for arg in args {
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
