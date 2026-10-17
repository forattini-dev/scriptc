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
                Expr::LibCall {
                    r#fn: if encoder {
                        "buffer.fromStr"
                    } else {
                        "text.decode"
                    }
                    .into(),
                    args,
                    r#type: result,
                    loc: h.loc(),
                }
            },
        )))
    }
}
