//! Nominal codecs and owning u8 views lower through the portable IR ABI.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};
impl Lowerer<'_> {
    fn standard_name(&self, symbol: u32, names: &[&str]) -> Option<String> {
        if symbol == 0 {
            return None;
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        if !names.contains(&symbol.name.as_ref()) {
            return None;
        }
        symbol
            .declarations
            .iter()
            .any(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                let path = &file.file_name;
                path.ends_with("/lib.dom.d.ts")
                    || path.ends_with("/lib.webworker.d.ts")
                    || path.ends_with("/lib.es5.d.ts")
                    || (path.contains("/@types/node/") && path.ends_with("/util.d.ts"))
            })
            .then(|| symbol.name.to_string())
    }
    pub(super) fn standard_codec_symbol(&self, symbol: u32) -> Option<String> {
        self.standard_name(symbol, &["TextEncoder", "TextDecoder"])
    }
    pub(super) fn standard_byte_type(&self, id: TypeId) -> bool {
        self.standard_name(self.checker.ty(id).symbol().0, &["Uint8Array"])
            .is_some()
            || self.standard_buffer_type(id)
    }
    pub(super) fn codec_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let symbol = self.symbol(node.expression());
        if self.standard_codec_symbol(symbol).is_some() {
            return self.class_new(node);
        }
        Ok(None)
    }
    pub(super) fn bytes_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let symbol = self.symbol(node.expression());
        if self.standard_name(symbol, &["Uint8Array"]).is_none() {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 1 {
            return Err(self.refuse(
                node,
                "Uint8Array buffer views and constructor offsets are not ported",
            ));
        }
        let source = args.first().map(|arg| self.expression(*arg)).transpose()?;
        if source.as_ref().is_some_and(|s| {
            s.ty() != Type::F64
                && s.ty() != Type::bytes()
                && s.ty()
                    != (Type::Array {
                        elem: Box::new(Type::F64),
                    })
        }) {
            return Err(self.refuse(
                node,
                "Uint8Array constructor requires length, numeric array or represented u8 bytes",
            ));
        }
        Ok(Some(Expr::BytesNew {
            source: source.map(Box::new),
            r#type: Type::bytes(),
            loc: self.loc(node),
        }))
    }
    // The portable byte get traps by design. Source indexing must guard it
    // and retain undefined rather than fabricate a byte or trust checker bounds.
    pub(super) fn bytes_index(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        let index = self.expression(node.argument_expression())?;
        if index.ty() != Type::F64 {
            return Err(self.refuse(node, "byte indexing requires a represented numeric key"));
        }
        let result = self.intern_union(vec![Type::F64, Type::Undefined]).unwrap();
        let mut helper = helpers::Helper::new(
            "bytes_index",
            vec![Type::bytes(), Type::F64],
            result.clone(),
            self.loc(node),
        );
        let bytes = helper.param(0);
        let index_slot = helper.param(1);
        let binary = |op: &str, left, right, r#type| Expr::Bin {
            op: op.into(),
            left: Box::new(left),
            right: Box::new(right),
            r#type,
            loc: helper.loc(),
        };
        let lower = binary(
            ">=",
            helper.read(&index_slot),
            helper.number(0.0),
            Type::Bool,
        );
        let upper = binary(
            "<",
            helper.read(&index_slot),
            self.bytes_operation(node, helper.read(&bytes), "length", vec![], Type::F64),
            Type::Bool,
        );
        let integer = binary(
            "===",
            binary("%", helper.read(&index_slot), helper.number(1.0), Type::F64),
            helper.number(0.0),
            Type::Bool,
        );
        let cond = Expr::Logical {
            op: "&&".into(),
            left: Box::new(Expr::Logical {
                op: "&&".into(),
                left: Box::new(lower),
                right: Box::new(upper),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            right: Box::new(integer),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let byte = self.bytes_operation(
            node,
            helper.read(&bytes),
            "get",
            vec![helper.read(&index_slot)],
            Type::F64,
        );
        let missing = Expr::UnitLit {
            unit: "undefined",
            r#type: Type::Undefined,
            loc: self.loc(node),
        };
        let value = Expr::Ternary {
            cond: Box::new(cond),
            then: Box::new(self.coerce(byte, result.clone(), node)?),
            else_: Box::new(self.coerce(missing, result.clone(), node)?),
            r#type: result.clone(),
            loc: self.loc(node),
        };
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(node),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![receiver, index],
            r#type: result,
            loc: self.loc(node),
        })
    }
    pub(super) fn bytes_operation(
        &self,
        node: Node,
        receiver: Expr,
        method: &str,
        args: Vec<Expr>,
        result: Type,
    ) -> Expr {
        Expr::BytesIntrinsic {
            method: method.into(),
            receiver: Box::new(receiver),
            args,
            r#type: result,
            loc: self.loc(node),
        }
    }
    fn codec_receiver(&mut self, node: Node) -> Option<String> {
        match self.ty(node).ok()? {
            Type::Object { class_name } if class_name.starts_with("native_builtin_Text") => {
                Some(class_name)
            }
            _ => None,
        }
    }
    fn codec_helper(
        &mut self,
        node: Node,
        kind: &str,
        args: Vec<Expr>,
        result: Type,
        operation: impl FnOnce(&helpers::Helper) -> Expr,
    ) -> Expr {
        let mut helper = helpers::Helper::new(
            kind,
            args.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(node),
        );
        let value = operation(&helper);
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(node),
        });
        let callee = self.install_helper(helper.function);
        Expr::Call {
            callee,
            args,
            r#type: result,
            loc: self.loc(node),
        }
    }
    pub(super) fn codec_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.ty(node.expression()).ok() == Some(Type::bytes()) {
            if !matches!(node.name().text(), "length" | "byteLength" | "byteOffset") {
                return Err(self.refuse(
                    node,
                    "Uint8Array property or extracted method is not ported",
                ));
            }
            let receiver = self.expected_expression(node.expression(), Type::bytes())?;
            if node.name().text() == "byteOffset" {
                let source_type = self.checker.get_type_at_location(node.expression());
                if self.standard_buffer_type(source_type) {
                    return Err(self.refuse(
                        node,
                        "Buffer pool and byteOffset observations are not ported",
                    ));
                }
                return Ok(Some(Expr::LibCall {
                    r#fn: "bytes.offset".into(),
                    args: vec![receiver],
                    r#type: Type::F64,
                    loc: self.loc(node),
                }));
            }
            return Ok(Some(self.bytes_operation(
                node,
                receiver,
                node.name().text(),
                vec![],
                Type::F64,
            )));
        }
        let Some(class_name) = self.codec_receiver(node.expression()) else {
            return Ok(None);
        };
        let receiver = self.expected_expression(
            node.expression(),
            Type::Object {
                class_name: class_name.clone(),
            },
        )?;
        let name = node.name().text();
        if name != "encoding"
            && !(class_name.ends_with("TextDecoder") && matches!(name, "fatal" | "ignoreBOM"))
        {
            return Err(self.refuse(
                node,
                "text codec property or extracted method is not ported",
            ));
        }
        let result = if name == "encoding" {
            Type::String
        } else {
            Type::Bool
        };
        Ok(Some(self.codec_helper(
            node,
            &format!("codec_{name}"),
            vec![receiver],
            result.clone(),
            |h| {
                if name == "encoding" {
                    Expr::StrLit {
                        value: "utf-8".into(),
                        r#type: result,
                        loc: h.loc(),
                    }
                } else {
                    Expr::BoolLit {
                        value: false,
                        r#type: result,
                        loc: h.loc(),
                    }
                }
            },
        )))
    }
    pub(super) fn codec_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let method = member.name().text();
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if self.ty(member.expression()).ok() == Some(Type::bytes()) {
            let receiver = self.expected_expression(member.expression(), Type::bytes())?;
            if method == "toString" {
                return self.bytes_string_call(node, receiver).map(Some);
            }
            let (method, result, values) = match method {
                "join" if args.len() <= 1 => (
                    "join",
                    Type::String,
                    vec![if args.is_empty() {
                        Expr::StrLit {
                            value: ",".into(),
                            r#type: Type::String,
                            loc: self.loc(node),
                        }
                    } else {
                        self.expected_expression(args[0], Type::String)?
                    }],
                ),
                "slice" | "subarray" if args.len() <= 2 => (
                    method,
                    Type::bytes(),
                    args.iter()
                        .map(|a| self.expected_expression(*a, Type::F64))
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                "set" if args.len() == 1 || args.len() == 2 => {
                    let mut values = vec![self.expected_expression(args[0], Type::bytes())?];
                    if args.len() == 2 {
                        values.push(self.expected_expression(args[1], Type::F64)?);
                    }
                    ("setFrom", Type::Void, values)
                }
                _ => return Err(self.refuse(node, "Uint8Array method/arity is not ported")),
            };
            if method == "slice" {
                let mut args = vec![receiver];
                args.extend(values);
                if args.len() == 1 {
                    args.push(Expr::NumLit {
                        value: 0.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: self.loc(node),
                    });
                }
                if args.len() == 2 {
                    args.push(Expr::NumLit {
                        value: f64::MAX,
                        spelling: None,
                        r#type: Type::F64,
                        loc: self.loc(node),
                    });
                }
                return Ok(Some(Expr::LibCall {
                    r#fn: "bytes.sliceDispatch".into(),
                    args,
                    r#type: result,
                    loc: self.loc(node),
                }));
            }
            return Ok(Some(
                self.bytes_operation(node, receiver, method, values, result),
            ));
        }
        let Some(class_name) = self.codec_receiver(member.expression()) else {
            return Ok(None);
        };
        let encoder = class_name.ends_with("TextEncoder");
        if method != if encoder { "encode" } else { "decode" } || args.len() > 1 {
            return Err(self.refuse(
                node,
                "only encode(string) and non-streaming default UTF-8 decode(u8 bytes) are ported",
            ));
        }
        let receiver =
            self.expected_expression(member.expression(), Type::Object { class_name })?;
        let input = if let Some(arg) = args.first() {
            // Preserve evaluation even for an explicit undefined argument.
            let value = self.expression(*arg)?;
            if value.ty() == Type::Undefined {
                return Err(self.refuse(
                    node,
                    "explicit undefined codec arguments require optional input lowering",
                ));
            }
            self.coerce(
                value,
                if encoder { Type::String } else { Type::bytes() },
                *arg,
            )?
        } else if encoder {
            Expr::StrLit {
                value: String::new(),
                r#type: Type::String,
                loc: self.loc(node),
            }
        } else {
            Expr::BytesNew {
                source: None,
                r#type: Type::bytes(),
                loc: self.loc(node),
            }
        };
        let result = if encoder { Type::bytes() } else { Type::String };
        Ok(Some(self.codec_helper(
            node,
            if encoder {
                "text_encode"
            } else {
                "text_decode"
            },
            vec![receiver, input],
            result.clone(),
            |h| {
                let mut args = vec![h.read(&h.param(1))];
                if encoder {
                    args.push(Expr::StrLit {
                        value: "utf8".into(),
                        r#type: Type::String,
                        loc: h.loc(),
                    });
                }
                let value = Expr::LibCall {
                    r#fn: if encoder {
                        "buffer.fromStr"
                    } else {
                        "text.decode"
                    }
                    .into(),
                    args,
                    r#type: result,
                    loc: h.loc(),
                };
                if encoder {
                    // The shared IR factory produces a Buffer. TextEncoder
                    // returns an independent, unbranded Uint8Array instead.
                    Expr::BytesNew {
                        source: Some(Box::new(value)),
                        r#type: Type::bytes(),
                        loc: h.loc(),
                    }
                } else {
                    value
                }
            },
        )))
    }
}
