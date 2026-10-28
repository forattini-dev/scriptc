//! Nominal codecs and owning typed views lower through the portable IR ABI.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};
const DATA_VIEW_STORAGE: &str = "\0scriptc.dataview.storage";
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
    pub(super) fn data_view_type(&mut self, id: TypeId) -> Option<Type> {
        self.standard_name(self.checker.ty(id).symbol().0, &["DataView"])?;
        if let Some(record) = self.records.iter().find(|record| {
            record.fields.len() == 1
                && record.fields[0].name == DATA_VIEW_STORAGE
                && record.fields[0].r#type == Type::bytes()
        }) {
            return Some(Type::Record {
                shape_id: record.id,
            });
        }
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields: vec![ir::Field {
                name: DATA_VIEW_STORAGE.into(),
                r#type: Type::bytes(),
            }],
            declared_order: vec![DATA_VIEW_STORAGE.into()],
            tuple: false,
            index_value: None,
        });
        Some(Type::Record { shape_id })
    }
    pub(super) fn is_data_view(&self, ty: &Type) -> bool {
        matches!(ty, Type::Record { shape_id } if self.records.get(*shape_id).is_some_and(|record| {
            record.fields.len() == 1 && record.fields[0].name == DATA_VIEW_STORAGE
                && record.fields[0].r#type == Type::bytes()
        }))
    }
    pub(super) fn data_view_storage(&self, node: Node, value: Expr) -> Expr {
        let Type::Record { shape_id } = value.ty() else {
            unreachable!()
        };
        Expr::RecordGet {
            obj: Box::new(value),
            shape_id: format!("r{shape_id}"),
            field: DATA_VIEW_STORAGE.into(),
            r#type: Type::bytes(),
            loc: self.loc(node),
        }
    }
    pub(super) fn data_view_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let symbol = self.symbol(node.expression());
        if self.standard_name(symbol, &["DataView"]).is_none() {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=3).contains(&args.len()) {
            return Err(self.refuse(
                node,
                "DataView requires represented buffer and numeric offsets",
            ));
        }
        let buffer = args[0];
        if buffer.kind() != SyntaxKind::PropertyAccessExpression || buffer.name().text() != "buffer"
        {
            return Err(self.refuse(buffer, "DataView requires a represented typed array buffer"));
        }
        let owner = buffer.expression();
        let source = self.checker.get_type_at_location(owner);
        if self.standard_buffer_type(source) {
            return Err(self.refuse(owner, "Buffer pool and backing ArrayBuffer are not ported"));
        }
        let Some(owner_type @ Type::Bytes { .. }) = self.standard_byte_type(source) else {
            return Err(self.refuse(
                owner,
                "DataView buffer owner must be a supported typed array",
            ));
        };
        let receiver = self.expected_expression(owner, owner_type)?;
        let offsets = args[1..]
            .iter()
            .map(|arg| self.expected_expression(*arg, Type::F64))
            .collect::<Result<Vec<_>, _>>()?;
        let view = self.bytes_operation(node, receiver, "dataViewNew", offsets, Type::bytes());
        let id = self.checker.get_type_at_location(node);
        let target = self
            .data_view_type(id)
            .ok_or_else(|| self.refuse(node, "DataView result type is not represented"))?;
        Ok(Some(Expr::RecordLit {
            fields: vec![ir::FieldInit {
                name: DATA_VIEW_STORAGE.into(),
                value: view,
                absent: false,
                overflow: false,
            }],
            r#type: target,
            loc: self.loc(node),
        }))
    }
    fn data_view_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Ok(ty) = self.ty(node.expression()) else {
            return Ok(None);
        };
        if !self.is_data_view(&ty) {
            return Ok(None);
        }
        let name = node.name().text();
        if !matches!(name, "byteOffset" | "byteLength") {
            return Err(self.refuse(node, "DataView property or extracted method is not ported"));
        }
        let receiver = self.expected_expression(node.expression(), ty)?;
        let storage = self.data_view_storage(node, receiver);
        Ok(Some(self.bytes_operation(
            node,
            storage,
            name,
            vec![],
            Type::F64,
        )))
    }
    fn data_view_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        let Ok(ty) = self.ty(member.expression()) else {
            return Ok(None);
        };
        if !self.is_data_view(&ty) {
            return Ok(None);
        }
        let method = member.name().text();
        let portable = if let Some(suffix) = method.strip_prefix("get") {
            format!("dvGet{suffix}")
        } else if let Some(suffix) = method.strip_prefix("set") {
            format!("dvSet{suffix}")
        } else {
            return Err(self.refuse(node, "DataView method is not ported"));
        };
        let Some((_, setter, byte)) = ir::data_view_operation(&portable) else {
            return Err(self.refuse(node, "DataView method is not ported"));
        };
        // BigInt getters return a bigint; the Number-only IR form is not their ABI.
        if method.starts_with("getBig") {
            return Err(self.refuse(node, "DataView BigInt getters are not ported"));
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let required = if setter { 2 } else { 1 };
        if args.len() < required || args.len() > required + usize::from(!byte) {
            return Err(self.refuse(node, "DataView argument count is not ported"));
        }
        let receiver = self.expected_expression(member.expression(), ty)?;
        let storage = self.data_view_storage(member, receiver);
        let mut values = Vec::new();
        for (index, arg) in args.iter().enumerate() {
            values.push(self.expected_expression(
                *arg,
                if index < required {
                    Type::F64
                } else {
                    Type::Bool
                },
            )?);
        }
        Ok(Some(self.bytes_operation(
            node,
            storage,
            &portable,
            values,
            if setter { Type::Void } else { Type::F64 },
        )))
    }
    pub(super) fn standard_byte_type(&self, id: TypeId) -> Option<Type> {
        if self.standard_buffer_type(id) {
            return Some(Type::bytes());
        }
        self.standard_name(
            self.checker.ty(id).symbol().0,
            &[
                "Uint8Array",
                "Uint32Array",
                "Int32Array",
                "Float32Array",
                "Float64Array",
            ],
        )
        .map(|name| Type::Bytes {
            elem: match name.as_str() {
                "Float32Array" => "f32",
                "Float64Array" => "f64",
                "Uint32Array" => "u32",
                "Int32Array" => "i32",
                _ => "u8",
            }
            .into(),
        })
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
        let Some(name) = self.standard_name(
            symbol,
            &[
                "Uint8Array",
                "Uint32Array",
                "Int32Array",
                "Float32Array",
                "Float64Array",
            ],
        ) else {
            return Ok(None);
        };
        let ty = Type::Bytes {
            elem: match name.as_str() {
                "Float32Array" => "f32",
                "Float64Array" => "f64",
                "Uint32Array" => "u32",
                "Int32Array" => "i32",
                _ => "u8",
            }
            .into(),
        };
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 1 {
            return Err(self.refuse(
                node,
                "typed array buffer views and constructor offsets are not ported",
            ));
        }
        let source = args.first().map(|arg| self.expression(*arg)).transpose()?;
        let source = source
            .map(|source| {
                if matches!(source.ty(), Type::Bytes { .. }) && source.ty() != ty {
                    Ok(self.bytes_operation(
                        node,
                        source,
                        "toArray",
                        vec![],
                        Type::Array {
                            elem: Box::new(Type::F64),
                        },
                    ))
                } else if source.ty() != Type::F64 && self.numeric_operand_domain(&source.ty()) {
                    self.strict_number_primitive(source, node)
                } else {
                    Ok(source)
                }
            })
            .transpose()?;
        if source.as_ref().is_some_and(|s| {
            s.ty() != Type::F64
                && !matches!(s.ty(), Type::Bytes { .. })
                && s.ty()
                    != (Type::Array {
                        elem: Box::new(Type::F64),
                    })
        }) {
            return Err(self.refuse(
                node,
                "typed array constructor requires length, numeric array or represented typed bytes",
            ));
        }
        Ok(Some(Expr::BytesNew {
            source: source.map(Box::new),
            r#type: ty,
            loc: self.loc(node),
        }))
    }
    // The portable byte get traps by design. Source indexing must guard it
    // and retain undefined rather than fabricate a byte or trust checker bounds.
    pub(super) fn bytes_index(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        let index = self.expression(node.argument_expression())?;
        self.bytes_index_value(node, receiver, index)
    }
    pub(super) fn bytes_index_value(
        &mut self,
        node: Node,
        receiver: Expr,
        index: Expr,
    ) -> Result<Expr, String> {
        if index.ty() != Type::F64 {
            return Err(self.refuse(node, "byte indexing requires a represented numeric key"));
        }
        let result = self.intern_union(vec![Type::F64, Type::Undefined]).unwrap();
        let mut helper = helpers::Helper::new(
            "bytes_index",
            vec![receiver.ty(), Type::F64],
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
        if let Some(value) = self.data_view_get(node)? {
            return Ok(Some(value));
        }
        if let Ok(ty @ Type::Bytes { .. }) = self.ty(node.expression()) {
            if !matches!(node.name().text(), "length" | "byteLength" | "byteOffset") {
                return Err(self.refuse(
                    node,
                    "typed array property or extracted method is not ported",
                ));
            }
            let receiver = self.expected_expression(node.expression(), ty.clone())?;
            if node.name().text() == "byteOffset" {
                if ty != Type::bytes() {
                    return Err(self.refuse(node, "floating typed array byteOffset observations require a portable IR offset contract"));
                }
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
        if let Some(value) = self.data_view_call(node)? {
            return Ok(Some(value));
        }
        let method = member.name().text();
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if let Ok(ty @ Type::Bytes { .. }) = self.ty(member.expression()) {
            let receiver = self.expected_expression(member.expression(), ty.clone())?;
            if method == "set"
                && (args.len() == 1 || args.len() == 2)
                && !args
                    .iter()
                    .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
                && let Ok(Type::Record { shape_id }) = self.ty(args[0])
                && self.records[shape_id].tuple
            {
                let fields = self.records[shape_id].fields.clone();
                if fields.iter().any(|field| field.r#type != Type::F64)
                    || (0..fields.len())
                        .any(|index| !fields.iter().any(|f| f.name == index.to_string()))
                {
                    return Err(
                        self.refuse(args[0], "typed array set requires a dense numeric tuple")
                    );
                }
                let tuple = self.expression(args[0])?;
                if tuple.ty() != (Type::Record { shape_id }) {
                    return Err(self.refuse(
                        args[0],
                        "typed array set requires a represented numeric tuple",
                    ));
                }
                let offset = if args.len() == 2 {
                    self.expected_expression(args[1], Type::F64)?
                } else {
                    Expr::NumLit {
                        value: 0.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: self.loc(node),
                    }
                };
                let result = self.codec_helper(
                    node,
                    "typed_array_set_tuple",
                    vec![receiver, tuple, offset],
                    Type::Void,
                    |h| {
                        let elements = (0..fields.len())
                            .map(|index| Expr::RecordGet {
                                obj: Box::new(h.read(&h.param(1))),
                                shape_id: format!("r{shape_id}"),
                                field: index.to_string(),
                                r#type: Type::F64,
                                loc: h.loc(),
                            })
                            .collect();
                        let array = Expr::ArrayLit {
                            elems: elements,
                            r#type: Type::Array {
                                elem: Box::new(Type::F64),
                            },
                            loc: h.loc(),
                        };
                        let source = Expr::BytesNew {
                            source: Some(Box::new(array)),
                            r#type: ty,
                            loc: h.loc(),
                        };
                        Expr::BytesIntrinsic {
                            method: "setFrom".into(),
                            receiver: Box::new(h.read(&h.param(0))),
                            args: vec![source, h.read(&h.param(2))],
                            r#type: Type::Void,
                            loc: h.loc(),
                        }
                    },
                );
                return Ok(Some(result));
            }
            if method == "toString" {
                if ty == Type::bytes() {
                    return self.bytes_string_call(node, receiver).map(Some);
                }
                return Err(self.refuse(
                    node,
                    "floating typed array toString is not ported; use join",
                ));
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
                    ty.clone(),
                    args.iter()
                        .map(|a| self.expected_expression(*a, Type::F64))
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                "set" if args.len() == 1 || args.len() == 2 => {
                    let mut values = vec![self.expected_expression(args[0], ty.clone())?];
                    if args.len() == 2 {
                        values.push(self.expected_expression(args[1], Type::F64)?);
                    }
                    ("setFrom", Type::Void, values)
                }
                _ => return Err(self.refuse(node, "typed array method/arity is not ported")),
            };
            if method == "slice" && ty == Type::bytes() {
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
