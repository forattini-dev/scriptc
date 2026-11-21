//! Nominal codecs and owning typed views lower through the portable IR ABI.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};
const DATA_VIEW_STORAGE: &str = "\0scriptc.dataview.storage";
pub(super) const TEXT_DECODER_FATAL: &str = "\0scriptc.textDecoder.fatal";
pub(super) const TEXT_DECODER_HANDLE: &str = "\0scriptc.textDecoder.handle";
pub(super) const TEXT_DECODER_ENCODING: &str = "\0scriptc.textDecoder.encoding";

/// WHATWG encoding labels used by the native decoder table. `-1` is UTF-8;
/// non-negative values are the stable ids consumed by `text_decode_legacy`.
pub(super) fn text_decoder_encoding(label: &str) -> Option<f64> {
    let label = label
        .trim_matches(['\u{0009}', '\u{000a}', '\u{000c}', '\u{000d}', '\u{0020}'])
        .to_ascii_lowercase();
    let id = match label.as_str() {
        "unicode-1-1-utf-8" | "unicode11utf8" | "unicode20utf8" | "utf-8" | "utf8"
        | "x-unicode20utf8" => -1,
        "866" | "cp866" | "csibm866" | "ibm866" => 0,
        "csisolatin2" | "iso-8859-2" | "iso-ir-101" | "iso8859-2" | "iso88592" | "iso_8859-2"
        | "iso_8859-2:1987" | "l2" | "latin2" => 1,
        "csisolatin3" | "iso-8859-3" | "iso-ir-109" | "iso8859-3" | "iso88593" | "iso_8859-3"
        | "iso_8859-3:1988" | "l3" | "latin3" => 2,
        "csisolatin4" | "iso-8859-4" | "iso-ir-110" | "iso8859-4" | "iso88594" | "iso_8859-4"
        | "iso_8859-4:1988" | "l4" | "latin4" => 3,
        "csisolatincyrillic" | "cyrillic" | "iso-8859-5" | "iso-ir-144" | "iso8859-5"
        | "iso88595" | "iso_8859-5" | "iso_8859-5:1988" => 4,
        "arabic" | "asmo-708" | "csiso88596e" | "csiso88596i" | "csisolatinarabic" | "ecma-114"
        | "iso-8859-6" | "iso-8859-6-e" | "iso-8859-6-i" | "iso-ir-127" | "iso8859-6"
        | "iso88596" | "iso_8859-6" | "iso_8859-6:1987" => 5,
        "csisolatingreek" | "ecma-118" | "elot_928" | "greek" | "greek8" | "iso-8859-7"
        | "iso-ir-126" | "iso8859-7" | "iso88597" | "iso_8859-7" | "iso_8859-7:1987"
        | "sun_eu_greek" => 6,
        "csiso88598e" | "csiso88598i" | "csisolatinhebrew" | "hebrew" | "iso-8859-8"
        | "iso-8859-8-e" | "iso-8859-8-i" | "iso-ir-138" | "iso8859-8" | "iso88598"
        | "iso_8859-8" | "iso_8859-8:1988" | "logical" | "visual" => 7,
        "csisolatin6" | "iso-8859-10" | "iso-ir-157" | "iso8859-10" | "iso885910" | "l6"
        | "latin6" => 8,
        "iso-8859-13" | "iso8859-13" | "iso885913" => 9,
        "iso-8859-14" | "iso8859-14" | "iso885914" => 10,
        "csisolatin9" | "iso-8859-15" | "iso8859-15" | "iso885915" | "iso_8859-15" | "l9" => 11,
        "iso-8859-16" => 12,
        "cskoi8r" | "koi" | "koi8" | "koi8-r" | "koi8_r" => 13,
        "koi8-ru" | "koi8-u" => 14,
        "csmacintosh" | "mac" | "macintosh" | "x-mac-roman" => 15,
        "dos-874" | "iso-8859-11" | "iso8859-11" | "iso885911" | "tis-620" | "windows-874" => 16,
        "cp1250" | "windows-1250" | "x-cp1250" => 17,
        "cp1251" | "windows-1251" | "x-cp1251" => 18,
        "ansi_x3.4-1968" | "ascii" | "cp1252" | "cp819" | "csisolatin1" | "ibm819"
        | "iso-8859-1" | "iso-ir-100" | "iso8859-1" | "iso88591" | "iso_8859-1"
        | "iso_8859-1:1987" | "l1" | "latin1" | "us-ascii" | "windows-1252" | "x-cp1252" => 19,
        "cp1253" | "windows-1253" | "x-cp1253" => 20,
        "cp1254" | "csisolatin5" | "iso-8859-9" | "iso-ir-148" | "iso8859-9" | "iso88599"
        | "iso_8859-9" | "iso_8859-9:1989" | "l5" | "latin5" | "windows-1254" | "x-cp1254" => 21,
        "cp1255" | "windows-1255" | "x-cp1255" => 22,
        "cp1256" | "windows-1256" | "x-cp1256" => 23,
        "cp1257" | "windows-1257" | "x-cp1257" => 24,
        "cp1258" | "windows-1258" | "x-cp1258" => 25,
        "x-mac-cyrillic" | "x-mac-ukrainian" => 26,
        "x-user-defined" => 27,
        "csunicode" | "iso-10646-ucs-2" | "ucs-2" | "unicode" | "unicodefeff" | "utf-16"
        | "utf-16le" => 28,
        "unicodefffe" | "utf-16be" => 29,
        "chinese" | "csgb2312" | "csiso58gb231280" | "gb18030" | "gb2312" | "gb_2312"
        | "gb_2312-80" | "gbk" | "iso-ir-58" | "x-gbk" => 30,
        "big5" | "big5-hkscs" | "cn-big5" | "csbig5" | "x-x-big5" => 31,
        "cseucpkdfmtjapanese" | "euc-jp" | "x-euc-jp" => 32,
        "csiso2022jp" | "iso-2022-jp" => 33,
        "csshiftjis" | "ms932" | "ms_kanji" | "shift-jis" | "shift_jis" | "sjis"
        | "windows-31j" | "x-sjis" => 34,
        "cseuckr" | "csksc56011987" | "euc-kr" | "iso-ir-149" | "korean" | "ks_c_5601-1987"
        | "ks_c_5601-1989" | "ksc5601" | "ksc_5601" | "windows-949" => 35,
        _ => return None,
    };
    Some(id as f64)
}
impl Lowerer<'_> {
    pub(super) fn standard_name(&self, symbol: u32, names: &[&str]) -> Option<String> {
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
                path.ends_with("lib.dom.d.ts")
                    || path.ends_with("lib.webworker.d.ts")
                    || path.ends_with("lib.es5.d.ts")
                    || path.ends_with("lib.es2021.weakref.d.ts")
                    || (path.contains("@types/node") && path.ends_with("util.d.ts"))
                    || path.contains("bun-types")
            })
            .then(|| symbol.name.to_string())
    }
    pub(super) fn standard_codec_symbol(&self, symbol: u32) -> Option<String> {
        self.standard_name(symbol, &["TextEncoder", "TextDecoder"])
    }
    pub(super) fn standard_array_buffer_type(&self, id: TypeId) -> bool {
        self.standard_name(self.checker.ty(id).symbol().0, &["ArrayBuffer"])
            .is_some()
    }
    pub(super) fn array_buffer_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let symbol = self.symbol(node.expression());
        if self.standard_name(symbol, &["ArrayBuffer"]).is_none() {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 1 {
            return Err(self.refuse(node, "ArrayBuffer accepts at most one byte length"));
        }
        let length = args
            .first()
            .map(|arg| self.expected_expression(*arg, Type::F64))
            .transpose()?
            .unwrap_or(Expr::NumLit {
                value: 0.0,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            });
        Ok(Some(Expr::Intrinsic {
            name: "arrayBuffer.new".into(),
            args: vec![length],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
    pub(super) fn array_buffer_is_view(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        let constructor_symbol = if callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.expression().kind() == SyntaxKind::Identifier
        {
            self.symbol(callee.expression())
        } else {
            0
        };
        if callee.kind() != SyntaxKind::PropertyAccessExpression
            || callee.name().text() != "isView"
            || callee.expression().kind() != SyntaxKind::Identifier
            || self
                .standard_name(constructor_symbol, &["ArrayBuffer"])
                .is_none()
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !matches!(arguments.as_slice(), [argument] if argument.kind() != SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "ArrayBuffer.isView requires exactly one value"));
        }
        let value = self.expression(arguments[0])?;
        let value = self.coerce(value, Type::Dyn, arguments[0])?;
        Ok(Some(Expr::LibCall {
            r#fn: "arrayBuffer.isView".into(),
            args: vec![value],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
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
            null_prototype: false,
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
        if !matches!(name, "buffer" | "byteOffset" | "byteLength") {
            return Err(self.refuse(node, "DataView property or extracted method is not ported"));
        }
        let receiver = self.expected_expression(node.expression(), ty)?;
        let storage = self.data_view_storage(node, receiver);
        if name == "buffer" {
            return Ok(Some(self.bytes_operation(
                node,
                storage,
                "buffer",
                vec![],
                Type::Dyn,
            )));
        }
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
        let direct = self
            .standard_name(
                self.checker.ty(id).symbol().0,
                &[
                    "Uint8Array",
                    "Uint16Array",
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
                    "Uint16Array" => "u16",
                    "Uint32Array" => "u32",
                    "Int32Array" => "i32",
                    _ => "u8",
                }
                .into(),
            });
        if direct.is_some() {
            return direct;
        }
        if self
            .checker
            .ty(id)
            .flags
            .intersects(TypeFlags::INTERSECTION)
        {
            // Control-flow operations such as Array.isArray can publish a
            // synthetic intersection view over an otherwise declaration-
            // proven Buffer/typed array. The intersection is a checker view,
            // not new storage: retain the unique owning byte constituent.
            let mut byte = None;
            for part in self.checker.ty(id).types() {
                let Some(candidate) = self.standard_byte_type(*part) else {
                    continue;
                };
                if byte.as_ref().is_some_and(|current| current != &candidate) {
                    return None;
                }
                byte = Some(candidate);
            }
            return byte;
        }
        None
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
                "Uint16Array",
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
                "Uint16Array" => "u16",
                "Uint32Array" => "u32",
                "Int32Array" => "i32",
                _ => "u8",
            }
            .into(),
        };
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if name == "Uint8Array" && args.len() == 3 {
            let buffer = primitives::primitive_source(args[0]);
            let offset = primitives::primitive_source(args[1]);
            let length = primitives::primitive_source(args[2]);
            let member = |value: Node, name: &str| {
                (value.kind() == SyntaxKind::PropertyAccessExpression
                    && value.name().text() == name)
                    .then(|| primitives::primitive_source(value.expression()))
            };
            if let (Some(owner), Some(offset_owner), Some(length_owner)) = (
                member(buffer, "buffer"),
                member(offset, "byteOffset"),
                member(length, "byteLength"),
            ) && owner.kind() == SyntaxKind::Identifier
                && offset_owner.kind() == SyntaxKind::Identifier
                && length_owner.kind() == SyntaxKind::Identifier
            {
                let symbol = self.symbol(owner);
                if symbol != 0
                    && self.symbol(offset_owner) == symbol
                    && self.symbol(length_owner) == symbol
                {
                    let source = self
                        .bindings
                        .get(&symbol)
                        .or_else(|| self.module_bindings.get(&symbol))
                        .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                        .map(|local| local.r#type.clone());
                    let source = if source.is_some() {
                        source
                    } else {
                        let checked = self.checker.get_type_at_location(owner);
                        self.standard_byte_type(checked)
                    };
                    if source == Some(Type::bytes()) {
                        let receiver = self.expected_expression(owner, Type::bytes())?;
                        return Ok(Some(self.bytes_operation(
                            node,
                            receiver,
                            "windowView",
                            vec![],
                            Type::bytes(),
                        )));
                    }
                }
            }
        }
        if name == "Uint8Array" && (args.len() == 2 || args.len() == 3) {
            let buffer = self.expression(args[0])?;
            let buffer = self.coerce(buffer, Type::Dyn, args[0])?;
            let offset = self.expected_expression(args[1], Type::F64)?;
            let has_length = args.len() == 3;
            let length = if has_length {
                self.expected_expression(args[2], Type::F64)?
            } else {
                Expr::NumLit {
                    value: 0.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }
            };
            return Ok(Some(Expr::LibCall {
                r#fn: "arrayBuffer.u8View".into(),
                args: vec![
                    buffer,
                    offset,
                    Expr::BoolLit {
                        value: has_length,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                    length,
                ],
                r#type: Type::bytes(),
                loc: self.loc(node),
            }));
        }
        if args.len() > 1 {
            return Err(self.refuse(
                node,
                "typed array buffer views and constructor offsets are not ported",
            ));
        }
        let source = args.first().map(|arg| self.expression(*arg)).transpose()?;
        if name == "Uint8Array"
            && source
                .as_ref()
                .is_some_and(|source| matches!(source.ty(), Type::Dyn | Type::Union { .. }))
        {
            let source = source.unwrap();
            let source = self.coerce(source, Type::Dyn, args[0])?;
            return Ok(Some(Expr::LibCall {
                r#fn: "bytes.fromDyn".into(),
                args: vec![source],
                r#type: Type::bytes(),
                loc: self.loc(node),
            }));
        }
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
            let source_type = source.as_ref().map(Expr::ty).unwrap();
            return Err(self.refuse(
                node,
                &format!(
                    "typed array constructor requires length, numeric array or represented typed bytes; got {source_type:?}"
                ),
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
    pub(super) fn nullable_bytes_index(
        &mut self,
        node: Node,
        receiver: Expr,
    ) -> Result<Option<Expr>, String> {
        let Type::Union { union_id } = receiver.ty() else {
            return Ok(None);
        };
        let arms = self.unions[union_id].arms.clone();
        if arms
            .iter()
            .filter(|arm| matches!(arm, Type::Bytes { .. }))
            .count()
            != 1
            || !arms
                .iter()
                .all(|arm| matches!(arm, Type::Bytes { .. } | Type::Null | Type::Undefined))
        {
            return Ok(None);
        }
        let index = self.expression(node.argument_expression())?;
        let index = self.bytes_numeric_index(node, index)?;
        let result = self.intern_union(vec![Type::F64, Type::Undefined]).unwrap();
        let mut helper = helpers::Helper::new(
            "nullable_bytes_index",
            vec![receiver.ty(), Type::F64],
            result.clone(),
            self.loc(node),
        );
        let source = helper.param(0);
        let key = helper.param(1);
        for (tag, arm) in arms.iter().enumerate() {
            let value = if matches!(arm, Type::Bytes { .. }) {
                let bytes = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(helper.read(&source)),
                    r#type: arm.clone(),
                    loc: helper.loc(),
                };
                self.bytes_index_value(node, bytes, helper.read(&key))?
            } else {
                let unit = Expr::UnitLit {
                    unit: if *arm == Type::Null {
                        "null"
                    } else {
                        "undefined"
                    },
                    r#type: arm.clone(),
                    loc: helper.loc(),
                };
                let unit = self.coerce(unit, Type::Dyn, node)?;
                let property = Expr::ToString {
                    operand: Box::new(helper.read(&key)),
                    r#type: Type::String,
                    loc: helper.loc(),
                };
                let read = self.dynamic_get(node, unit, property);
                self.coerce(read, result.clone(), node)?
            };
            let ret = Stmt::Return {
                value: Some(value),
                loc: helper.loc(),
            };
            if tag + 1 == arms.len() {
                helper.function.body.push(ret);
            } else {
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        value: Box::new(helper.read(&source)),
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![ret],
                    else_: None,
                    loc: helper.loc(),
                });
            }
        }
        Ok(Some(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![receiver, index],
            r#type: result,
            loc: self.loc(node),
        }))
    }
    pub(super) fn bytes_index_value(
        &mut self,
        node: Node,
        receiver: Expr,
        index: Expr,
    ) -> Result<Expr, String> {
        if let Type::Union { union_id } = index.ty() {
            let arms = self.unions[union_id].arms.clone();
            if arms.len() == 2 && arms.contains(&Type::F64) && arms.contains(&Type::Undefined) {
                let number_tag = arms.iter().position(|arm| *arm == Type::F64).unwrap();
                let mut helper = helpers::Helper::new(
                    "bytes_nullable_key",
                    vec![receiver.ty(), index.ty()],
                    Type::Dyn,
                    self.loc(node),
                );
                let bytes = helper.param(0);
                let key = helper.param(1);
                let number = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: number_tag,
                    value: Box::new(helper.read(&key)),
                    r#type: Type::F64,
                    loc: helper.loc(),
                };
                let numeric = self.bytes_index_value(node, helper.read(&bytes), number)?;
                let numeric = self.coerce(numeric, Type::Dyn, node)?;
                let source = self.coerce(helper.read(&bytes), Type::Dyn, node)?;
                let property = Expr::StrLit {
                    value: "undefined".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                };
                let named = self.dynamic_get(node, source, property);
                helper.function.body.push(Stmt::Return {
                    value: Some(Expr::Ternary {
                        cond: Box::new(Expr::UnionIsTag {
                            union_id: format!("u{union_id}"),
                            tag: number_tag,
                            value: Box::new(helper.read(&key)),
                            negated: false,
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        then: Box::new(numeric),
                        else_: Box::new(named),
                        r#type: Type::Dyn,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                });
                return Ok(Expr::Call {
                    callee: self.install_helper(helper.function),
                    args: vec![receiver, index],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                });
            }
        }
        let index = self.bytes_numeric_index(node, index)?;
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
    fn bytes_numeric_index(&mut self, node: Node, index: Expr) -> Result<Expr, String> {
        if index.ty() == Type::F64 {
            return Ok(index);
        }
        // Numeric expressions can deliberately retain a dynamic ABI when
        // their operands cross a captured/mutable JavaScript boundary.  The
        // checker still proves the element key is a Number, so project it at
        // the byte access rather than rejecting valid typed code or silently
        // accepting an arbitrary dynamic property name.
        if self.ty(node.argument_expression()).ok() == Some(Type::F64) {
            return self.coerce(index, Type::F64, node.argument_expression());
        }
        Err(self.refuse(
            node,
            &format!(
                "byte indexing requires a represented numeric key, got {}",
                self.contextual_type_description(&index.ty())
            ),
        ))
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
    pub(super) fn codec_method_value(
        &mut self,
        node: Node,
        bound_receiver: Option<Type>,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let Some(class_name) = self.codec_receiver(node.expression()) else {
            return Ok(None);
        };
        let encoder = class_name.ends_with("TextEncoder");
        if node.name().text() != if encoder { "encode" } else { "decode" }
            || !matches!(bound_receiver, Some(Type::Object { class_name: receiver }) if receiver == class_name)
        {
            return Ok(None);
        }
        // Model an extracted codec method with an explicit receiver slot. The
        // generic Function.bind lowering can then capture that slot and expose
        // the ordinary one-argument callable used by Node libraries.
        let receiver = Type::Object {
            class_name: class_name.clone(),
        };
        let input = if encoder { Type::String } else { Type::bytes() };
        let result = if encoder { Type::bytes() } else { Type::String };
        let mut helper = helpers::Helper::new(
            if encoder {
                "text_encode_method_value"
            } else {
                "text_decode_method_value"
            },
            vec![receiver.clone(), input],
            result.clone(),
            self.loc(node),
        );
        let value = if encoder {
            let encoded = Expr::LibCall {
                r#fn: "buffer.fromStr".into(),
                args: vec![
                    helper.read(&helper.param(1)),
                    Expr::StrLit {
                        value: "utf8".into(),
                        r#type: Type::String,
                        loc: helper.loc(),
                    },
                ],
                r#type: Type::bytes(),
                loc: helper.loc(),
            };
            Expr::BytesNew {
                source: Some(Box::new(encoded)),
                r#type: Type::bytes(),
                loc: helper.loc(),
            }
        } else {
            let field = |name: &str, ty: Type| Expr::DynCheck {
                value: Box::new(Expr::FieldGet {
                    obj: Box::new(helper.read(&helper.param(0))),
                    class_name: class_name.clone(),
                    field: name.into(),
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                }),
                r#type: ty,
                loc: helper.loc(),
            };
            Expr::LibCall {
                r#fn: "text.decodeSelected".into(),
                args: vec![
                    field(TEXT_DECODER_HANDLE, Type::F64),
                    helper.read(&helper.param(1)),
                    Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    field(TEXT_DECODER_FATAL, Type::Bool),
                    field(TEXT_DECODER_ENCODING, Type::F64),
                ],
                r#type: Type::String,
                loc: helper.loc(),
            }
        };
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: helper.loc(),
        });
        let r#type = Type::Func {
            rest: false,
            params: helper
                .function
                .params
                .iter()
                .map(|param| param.r#type.clone())
                .collect(),
            ret: Box::new(result),
        };
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type,
            loc: self.loc(node),
        }))
    }
    pub(super) fn codec_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if let Some(value) = self.data_view_get(node)? {
            return Ok(Some(value));
        }
        if let Ok(ty @ Type::Bytes { .. }) = self.ty(node.expression()) {
            if !matches!(
                node.name().text(),
                "length" | "byteLength" | "byteOffset" | "buffer"
            ) {
                return Err(self.refuse(
                    node,
                    "typed array property or extracted method is not ported",
                ));
            }
            let receiver = self.expected_expression(node.expression(), ty.clone())?;
            if node.name().text() == "buffer" {
                return Ok(Some(self.bytes_operation(
                    node,
                    receiver,
                    "buffer",
                    vec![],
                    Type::Dyn,
                )));
            }
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
        let checked_receiver = self.checker.get_type_at_location(member.expression());
        let checked_type = self
            .ty(member.expression())
            .ok()
            .or_else(|| self.type_id(checked_receiver));
        if method == "toString"
            && let Some(expected @ Type::Union { union_id }) = checked_type.clone()
        {
            let arms = self.unions[union_id].arms.clone();
            if arms
                .iter()
                .all(|arm| matches!(arm, Type::String | Type::Bytes { .. }))
                && arms.iter().any(|arm| *arm == Type::String)
                && arms.iter().any(|arm| *arm == Type::bytes())
            {
                if args.len() > 1
                    || args
                        .iter()
                        .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
                {
                    return Err(self.refuse(
                        node,
                        "string/Buffer toString accepts at most one represented encoding",
                    ));
                }
                let receiver = self.expected_expression(member.expression(), expected.clone())?;
                let encoding = if let Some(argument) = args.first() {
                    self.expected_expression(*argument, Type::String)?
                } else {
                    Expr::StrLit {
                        value: "utf8".into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    }
                };
                let mut helper = helpers::Helper::new(
                    "string_or_buffer_to_string",
                    vec![expected.clone(), Type::String],
                    Type::String,
                    self.loc(node),
                );
                for (tag, arm) in arms.iter().enumerate() {
                    let narrowed = Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(helper.read(&helper.param(0))),
                        r#type: arm.clone(),
                        loc: helper.loc(),
                    };
                    let result = if *arm == Type::String {
                        narrowed
                    } else {
                        let is_buffer = Expr::LibCall {
                            r#fn: "buffer.isBuffer".into(),
                            args: vec![self.coerce(narrowed.clone(), Type::Dyn, node)?],
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        };
                        Expr::Ternary {
                            cond: Box::new(is_buffer),
                            then: Box::new(Expr::BytesIntrinsic {
                                method: "toStringVar".into(),
                                receiver: Box::new(narrowed.clone()),
                                args: vec![helper.read(&helper.param(1))],
                                r#type: Type::String,
                                loc: helper.loc(),
                            }),
                            else_: Box::new(Expr::BytesIntrinsic {
                                method: "join".into(),
                                receiver: Box::new(narrowed),
                                args: vec![Expr::StrLit {
                                    value: ",".into(),
                                    r#type: Type::String,
                                    loc: helper.loc(),
                                }],
                                r#type: Type::String,
                                loc: helper.loc(),
                            }),
                            r#type: Type::String,
                            loc: helper.loc(),
                        }
                    };
                    let returned = Stmt::Return {
                        value: Some(result),
                        loc: helper.loc(),
                    };
                    if tag + 1 == arms.len() {
                        helper.function.body.push(returned);
                    } else {
                        helper.function.body.push(Stmt::If {
                            cond: Expr::UnionIsTag {
                                union_id: format!("u{union_id}"),
                                tag,
                                value: Box::new(helper.read(&helper.param(0))),
                                negated: false,
                                r#type: Type::Bool,
                                loc: helper.loc(),
                            },
                            then: vec![returned],
                            else_: None,
                            loc: helper.loc(),
                        });
                    }
                }
                return Ok(Some(Expr::Call {
                    callee: self.install_helper(helper.function),
                    args: vec![receiver, encoding],
                    r#type: Type::String,
                    loc: self.loc(node),
                }));
            }
        }
        if method == "toString"
            && let Some(expected @ Type::Bytes { .. }) = checked_type
        {
            if expected != Type::bytes() {
                return Err(self.refuse(
                    node,
                    "floating typed array toString is not ported; use join",
                ));
            }
            let mut receiver = self.expression(member.expression())?;
            if receiver.ty() != expected {
                receiver = self.coerce(receiver, expected, member.expression())?;
            }
            return self.bytes_string_call(node, receiver).map(Some);
        }
        if let Ok(ty @ Type::Bytes { .. }) = self.ty(member.expression()) {
            let receiver = self.expected_expression(member.expression(), ty.clone())?;
            if method == "equals" && ty == Type::bytes() {
                if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(
                        node,
                        "Buffer.equals requires exactly one represented byte sequence",
                    ));
                }
                let other = self.expected_expression(args[0], Type::bytes())?;
                return Ok(Some(self.bytes_operation(
                    node,
                    receiver,
                    "equals",
                    vec![other],
                    Type::Bool,
                )));
            }
            if matches!(method, "indexOf" | "lastIndexOf" | "includes") && ty == Type::bytes() {
                if !(1..=2).contains(&args.len())
                    || args
                        .iter()
                        .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
                {
                    return Err(self.refuse(
                        node,
                        &format!(
                            "byte {method} requires a numeric search value and optional numeric offset"
                        ),
                    ));
                }
                let byte_needle =
                    matches!(self.ty(args[0]), Ok(Type::Bytes { elem }) if elem == "u8");
                let needle = self.expected_expression(
                    args[0],
                    if byte_needle {
                        Type::bytes()
                    } else {
                        Type::F64
                    },
                )?;
                let offset = if args.len() == 2 {
                    self.expected_expression(args[1], Type::F64)?
                } else {
                    Expr::NumLit {
                        value: if method == "lastIndexOf" {
                            f64::INFINITY
                        } else {
                            0.0
                        },
                        spelling: None,
                        r#type: Type::F64,
                        loc: self.loc(node),
                    }
                };
                let search = Expr::LibCall {
                    r#fn: if byte_needle && method == "lastIndexOf" {
                        "bytes.lastIndexOfBytes"
                    } else if byte_needle {
                        "bytes.indexOfBytes"
                    } else if method == "lastIndexOf" {
                        "bytes.lastIndexOfNumeric"
                    } else {
                        "bytes.indexOfNumeric"
                    }
                    .into(),
                    args: vec![receiver, needle, offset],
                    r#type: Type::F64,
                    loc: self.loc(node),
                };
                return Ok(Some(if method == "includes" {
                    Expr::Bin {
                        op: ">=".into(),
                        left: Box::new(search),
                        right: Box::new(Expr::NumLit {
                            value: 0.0,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        }),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }
                } else {
                    search
                }));
            }
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
                "readUInt16BE" if args.len() == 1 => (
                    "readUIntBE",
                    Type::F64,
                    vec![
                        self.expected_expression(args[0], Type::F64)?,
                        Expr::NumLit {
                            value: 2.0,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        },
                    ],
                ),
                "readUIntBE" if args.len() == 2 => (
                    "readUIntBE",
                    Type::F64,
                    args.iter()
                        .map(|a| self.expected_expression(*a, Type::F64))
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                "write" if ty == Type::bytes() && (1..=4).contains(&args.len()) => {
                    if args
                        .iter()
                        .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
                    {
                        return Err(
                            self.refuse(node, "Buffer.write spread arguments are not ported")
                        );
                    }
                    let values = args
                        .iter()
                        .map(|arg| self.expected_expression(*arg, Type::Dyn))
                        .collect::<Result<Vec<_>, _>>()?;
                    ("writeString", Type::F64, values)
                }
                "writeUInt16BE" if args.len() == 2 => (
                    "writeUIntBE",
                    Type::F64,
                    vec![
                        self.expected_expression(args[0], Type::F64)?,
                        self.expected_expression(args[1], Type::F64)?,
                        Expr::NumLit {
                            value: 2.0,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        },
                    ],
                ),
                "writeUIntBE" if args.len() == 3 => (
                    "writeUIntBE",
                    Type::F64,
                    args.iter()
                        .map(|a| self.expected_expression(*a, Type::F64))
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                "copy" if ty == Type::bytes() && (1..=4).contains(&args.len()) => {
                    let mut values = vec![self.expected_expression(args[0], Type::bytes())?];
                    values.extend(
                        args.iter()
                            .skip(1)
                            .map(|argument| self.expected_expression(*argument, Type::F64))
                            .collect::<Result<Vec<_>, _>>()?,
                    );
                    ("copy", Type::F64, values)
                }
                "utf8Slice" | "ucs2Slice" if ty == Type::bytes() && args.len() <= 2 => {
                    let mut values = vec![Expr::StrLit {
                        value: if method == "utf8Slice" {
                            "utf8"
                        } else {
                            "utf16le"
                        }
                        .into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    }];
                    values.push(if let Some(start) = args.first() {
                        self.expected_expression(*start, Type::F64)?
                    } else {
                        Expr::NumLit {
                            value: 0.0,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        }
                    });
                    values.push(if let Some(end) = args.get(1) {
                        self.expected_expression(*end, Type::F64)?
                    } else {
                        Expr::NumLit {
                            value: f64::MAX,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        }
                    });
                    ("toStringRange", Type::String, values)
                }
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
                    let source = self.expression(args[0])?;
                    let array = Type::Array {
                        elem: Box::new(Type::F64),
                    };
                    let (operation, source) = if source.ty() == array {
                        ("setFromArray", source)
                    } else {
                        ("setFrom", self.coerce(source, ty.clone(), args[0])?)
                    };
                    let mut values = vec![source];
                    if args.len() == 2 {
                        values.push(self.expected_expression(args[1], Type::F64)?);
                    }
                    (operation, Type::Void, values)
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
        if method != if encoder { "encode" } else { "decode" }
            || args.len() > if encoder { 1 } else { 2 }
        {
            return Err(self.refuse(
                node,
                "only encode(string) and default UTF-8 decode(u8 bytes, { stream?: boolean }) are ported",
            ));
        }
        let receiver = self.expected_expression(
            member.expression(),
            Type::Object {
                class_name: class_name.clone(),
            },
        )?;
        let fatal = if encoder {
            None
        } else {
            let value = Expr::FieldGet {
                obj: Box::new(receiver.clone()),
                class_name: class_name.clone(),
                field: TEXT_DECODER_FATAL.into(),
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            Some(self.coerce(value, Type::Bool, node)?)
        };
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
        let mut helper_args = vec![receiver, input];
        helper_args.extend(fatal);
        if !encoder {
            let stream = if let Some(options) = args.get(1) {
                let options = receivers::reference_node(*options);
                if options.kind() != SyntaxKind::ObjectLiteralExpression
                    || options.properties().len() != 1
                {
                    return Err(self.refuse(
                        options,
                        "TextDecoder streaming options require a literal { stream: boolean }",
                    ));
                }
                let property = options.properties().get(0);
                let value = primitives::primitive_source(property.initializer());
                if property.kind() != SyntaxKind::PropertyAssignment
                    || self.data_property_name(property.name()).as_deref() != Some("stream")
                    || !matches!(
                        value.kind(),
                        SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword
                    )
                {
                    return Err(self.refuse(
                        property,
                        "TextDecoder streaming options require a literal { stream: boolean }",
                    ));
                }
                value.kind() == SyntaxKind::TrueKeyword
            } else {
                false
            };
            helper_args.push(Expr::BoolLit {
                value: stream,
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        Ok(Some(self.codec_helper(
            node,
            if encoder {
                "text_encode"
            } else {
                "text_decode"
            },
            helper_args,
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
                        "text.decodeSelected"
                    }
                    .into(),
                    args: if encoder {
                        args
                    } else {
                        vec![
                            Expr::DynCheck {
                                value: Box::new(Expr::FieldGet {
                                    obj: Box::new(h.read(&h.param(0))),
                                    class_name: class_name.clone(),
                                    field: TEXT_DECODER_HANDLE.into(),
                                    r#type: Type::Dyn,
                                    loc: h.loc(),
                                }),
                                r#type: Type::F64,
                                loc: h.loc(),
                            },
                            h.read(&h.param(1)),
                            h.read(&h.param(3)),
                            h.read(&h.param(2)),
                            Expr::DynCheck {
                                value: Box::new(Expr::FieldGet {
                                    obj: Box::new(h.read(&h.param(0))),
                                    class_name: class_name.clone(),
                                    field: TEXT_DECODER_ENCODING.into(),
                                    r#type: Type::Dyn,
                                    loc: h.loc(),
                                }),
                                r#type: Type::F64,
                                loc: h.loc(),
                            },
                        ]
                    },
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
