//! `node:string_decoder` is an owning record over Rust's incremental decoder.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

const ENCODING: &str = "\0scriptc.stringDecoder.encoding";
const PENDING: &str = "\0scriptc.stringDecoder.pending";

impl Lowerer<'_> {
    fn standard_string_decoder_symbol(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        symbol.name.as_ref() == "StringDecoder"
            && symbol.declarations.iter().any(|declaration| {
                let file = source_file_info(get_source_file_of_node(*declaration));
                file.file_name.contains("/@types/node/")
                    && file.file_name.ends_with("/string_decoder.d.ts")
            })
    }

    pub(super) fn string_decoder_type(&mut self, id: TypeId) -> Option<Type> {
        if !self.standard_string_decoder_symbol(self.checker.ty(id).symbol().0) {
            return None;
        }
        if let Some(record) = self.records.iter().find(|record| {
            record.fields.len() == 2
                && record.fields[0].name == ENCODING
                && record.fields[0].r#type == Type::String
                && record.fields[1].name == PENDING
                && record.fields[1].r#type == Type::F64
        }) {
            return Some(Type::Record {
                shape_id: record.id,
            });
        }
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields: vec![
                ir::Field {
                    name: ENCODING.into(),
                    r#type: Type::String,
                },
                ir::Field {
                    name: PENDING.into(),
                    r#type: Type::F64,
                },
            ],
            declared_order: vec![ENCODING.into(), PENDING.into()],
            tuple: false,
            index_value: None,
        });
        Some(Type::Record { shape_id })
    }

    fn is_string_decoder(&self, ty: &Type) -> bool {
        matches!(ty, Type::Record { shape_id } if self.records.get(*shape_id).is_some_and(|record| {
            record.fields.len() == 2
                && record.fields[0].name == ENCODING
                && record.fields[1].name == PENDING
        }))
    }

    fn canonical_decoder_encoding(&self, node: Node) -> Result<String, String> {
        if node.kind() != SyntaxKind::StringLiteral {
            return Err(self.refuse(node, "StringDecoder encoding must be a string literal"));
        }
        let normalized = node.text().to_ascii_lowercase().replace(['-', '_'], "");
        match normalized.as_str() {
            "utf8" => Ok("utf8".into()),
            "utf16le" | "ucs2" => Ok("utf16le".into()),
            "latin1" | "binary" => Ok("latin1".into()),
            "ascii" => Ok("ascii".into()),
            "base64" => Ok("base64".into()),
            "base64url" => Ok("base64url".into()),
            "hex" => Ok("hex".into()),
            _ => Err(self.refuse(node, "unsupported StringDecoder encoding")),
        }
    }

    pub(super) fn string_decoder_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::NewExpression {
            return Ok(None);
        }
        let symbol = self.symbol(node.expression());
        if !self.standard_string_decoder_symbol(symbol) {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 1 {
            return Err(self.refuse(node, "StringDecoder accepts at most one encoding"));
        }
        let encoding = if let Some(argument) = args.first() {
            self.canonical_decoder_encoding(*argument)?
        } else {
            "utf8".into()
        };
        let source_type = self.checker.get_type_at_location(node);
        let ty = self
            .string_decoder_type(source_type)
            .ok_or_else(|| self.refuse(node, "StringDecoder result has no native record"))?;
        Ok(Some(Expr::RecordLit {
            null_prototype: false,
            fields: vec![
                ir::FieldInit {
                    name: ENCODING.into(),
                    value: Expr::StrLit {
                        value: encoding,
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                    absent: false,
                    overflow: false,
                },
                ir::FieldInit {
                    name: PENDING.into(),
                    value: Expr::NumLit {
                        value: 0.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: self.loc(node),
                    },
                    absent: false,
                    overflow: false,
                },
            ],
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    fn decoder_field(&self, receiver: Expr, field: &str, ty: Type, node: Node) -> Expr {
        let Type::Record { shape_id } = receiver.ty() else {
            unreachable!("validated StringDecoder record")
        };
        Expr::RecordGet {
            obj: Box::new(receiver),
            shape_id: format!("r{shape_id}"),
            field: field.into(),
            r#type: ty,
            loc: self.loc(node),
        }
    }

    pub(super) fn string_decoder_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let Ok(ty) = self.ty(node.expression()) else {
            return Ok(None);
        };
        if !self.is_string_decoder(&ty) {
            return Ok(None);
        }
        if node.name().text() != "encoding" {
            return Ok(None);
        }
        let receiver = self.expected_expression(node.expression(), ty)?;
        Ok(Some(self.decoder_field(
            receiver,
            ENCODING,
            Type::String,
            node,
        )))
    }

    pub(super) fn string_decoder_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let Ok(ty) = self.ty(member.expression()) else {
            return Ok(None);
        };
        if !self.is_string_decoder(&ty) {
            return Ok(None);
        }
        let method = member.name().text();
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if (method == "write" && args.len() != 1) || (method == "end" && !args.is_empty()) {
            return Err(self.refuse(node, "StringDecoder method argument count is not ported"));
        }
        if !matches!(method, "write" | "end") {
            return Err(self.refuse(node, "StringDecoder method is not ported"));
        }
        let mut values = vec![self.expected_expression(member.expression(), ty.clone())?];
        if method == "write" {
            values.push(self.expected_expression(args[0], Type::bytes())?);
        }
        let mut helper = helpers::Helper::new(
            &format!("string_decoder_{method}"),
            values.iter().map(Expr::ty).collect(),
            Type::String,
            self.loc(node),
        );
        let receiver = helper.read(&helper.param(0));
        let Type::Record { shape_id } = ty else {
            unreachable!()
        };
        let encoding = self.decoder_field(receiver.clone(), ENCODING, Type::String, node);
        let pending = self.decoder_field(receiver.clone(), PENDING, Type::F64, node);
        let output = helper.local("decoded", Type::String, false);
        let operation = if method == "write" {
            Expr::LibCall {
                r#fn: "strdec.write".into(),
                args: vec![
                    encoding.clone(),
                    pending.clone(),
                    helper.read(&helper.param(1)),
                ],
                r#type: Type::String,
                loc: helper.loc(),
            }
        } else {
            Expr::LibCall {
                r#fn: "strdec.end".into(),
                args: vec![encoding.clone(), pending.clone()],
                r#type: Type::String,
                loc: helper.loc(),
            }
        };
        helper.declare(&output, operation);
        let next = if method == "write" {
            Expr::LibCall {
                r#fn: "strdec.next".into(),
                args: vec![encoding, pending, helper.read(&helper.param(1))],
                r#type: Type::F64,
                loc: helper.loc(),
            }
        } else {
            helper.number(0.0)
        };
        helper.function.body.push(Stmt::RecordSet {
            obj: helper.read(&helper.param(0)),
            shape_id: format!("r{shape_id}"),
            field: PENDING.into(),
            value: next,
            loc: helper.loc(),
        });
        helper.function.body.push(Stmt::Return {
            value: Some(helper.read(&output)),
            loc: helper.loc(),
        });
        Ok(Some(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }
}
