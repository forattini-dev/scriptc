//! JSON module data is parsed once into an owned tree, then materialized by
//! the CommonJS cache thunk. Numeric spelling and member order survive parsing.
use super::*;
use serde::de::{self, MapAccess, Visitor};
use serde_json::value::RawValue;

#[derive(Clone, Debug)]
pub(super) enum DataValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<DataValue>),
    Object(Vec<(String, DataValue)>),
}

struct Members;
impl<'de> Visitor<'de> for Members {
    type Value = Vec<(String, Box<RawValue>)>;
    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON object")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut fields: Vec<(String, Box<RawValue>)> = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
            // JSON.parse replaces duplicates without moving the first key.
            if let Some((_, current)) = fields.iter_mut().find(|(name, _)| *name == key) {
                *current = value;
            } else {
                fields.push((key, value));
            }
        }
        Ok(fields)
    }
}

pub(super) fn parse(bytes: &[u8]) -> Result<DataValue, serde_json::Error> {
    // Node's JSON module loader strips one UTF-8 BOM, unlike JSON.parse itself.
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let raw: Box<RawValue> = serde_json::from_slice(bytes)?;
    fn value(raw: &RawValue) -> Result<DataValue, serde_json::Error> {
        let text = raw.get();
        match text.as_bytes()[0] {
            b'{' => {
                let mut deserializer = serde_json::Deserializer::from_str(text);
                let fields = de::Deserializer::deserialize_map(&mut deserializer, Members)?;
                Ok(DataValue::Object(
                    fields
                        .into_iter()
                        .map(|(key, raw)| Ok((key, value(&raw)?)))
                        .collect::<Result<_, serde_json::Error>>()?,
                ))
            }
            b'[' => {
                let elements: Vec<Box<RawValue>> = serde_json::from_str(text)?;
                Ok(DataValue::Array(
                    elements
                        .iter()
                        .map(|raw| value(raw))
                        .collect::<Result<_, _>>()?,
                ))
            }
            b'"' => Ok(DataValue::String(serde_json::from_str(text)?)),
            b'n' => Ok(DataValue::Null),
            b't' => Ok(DataValue::Bool(true)),
            b'f' => Ok(DataValue::Bool(false)),
            _ => Ok(DataValue::Number(
                source_frontend::jsnum::from_string(text).value(),
            )),
        }
    }
    value(&raw)
}

impl Lowerer<'_> {
    pub(super) fn json_module_value(&self, node: Node, value: &DataValue) -> Result<Expr, String> {
        let loc = self.loc(node);
        let value = match value {
            DataValue::Null => Expr::UnitLit {
                unit: "null",
                r#type: Type::Null,
                loc,
            },
            DataValue::Bool(value) => Expr::BoolLit {
                value: *value,
                r#type: Type::Bool,
                loc,
            },
            DataValue::Number(value) => Expr::NumLit {
                value: *value,
                spelling: None,
                r#type: Type::F64,
                loc,
            },
            DataValue::String(value) => Expr::StrLit {
                value: value.clone(),
                r#type: Type::String,
                loc,
            },
            DataValue::Array(elements) => {
                return Ok(Expr::DynArrLit {
                    elems: elements
                        .iter()
                        .map(|value| self.json_module_value(node, value))
                        .collect::<Result<_, _>>()?,
                    r#type: Type::Dyn,
                    loc,
                });
            }
            DataValue::Object(members) => {
                return Ok(Expr::DynObjLit {
                    fields: members
                        .iter()
                        .map(|(key, value)| {
                            Ok(ir::DynamicField {
                                key: Expr::StrLit {
                                    value: key.clone(),
                                    r#type: Type::String,
                                    loc: loc.clone(),
                                },
                                value: self.json_module_value(node, value)?,
                            })
                        })
                        .collect::<Result<_, String>>()?,
                    r#type: Type::Dyn,
                    loc,
                });
            }
        };
        self.coerce(value, Type::Dyn, node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn members_keep_first_position_and_last_value() {
        let DataValue::Object(fields) =
            parse(br#"{"z":1,"a":0,"z":2,"__proto__":{"own":true}}"#).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            ["z", "a", "__proto__"]
        );
        assert!(matches!(fields[0].1, DataValue::Number(2.0)));
        assert!(matches!(fields[2].1, DataValue::Object(_)));
    }
    #[test]
    fn numbers_use_javascript_conversion_without_intermediate_rounding() {
        let DataValue::Array(values) =
            parse(b"[-0,9007199254740993,1e400,1e-400,9888899923483823.8]").unwrap()
        else {
            panic!()
        };
        for (value, text) in values.iter().zip([
            "-0",
            "9007199254740993",
            "1e400",
            "1e-400",
            "9888899923483823.8",
        ]) {
            let DataValue::Number(value) = value else {
                panic!()
            };
            assert_eq!(
                value.to_bits(),
                source_frontend::jsnum::from_string(text).value().to_bits(),
                "{text}"
            );
        }
    }
    #[test]
    fn json_module_bom_and_strict_data_grammar() {
        assert!(matches!(
            parse(b"\xef\xbb\xbf null").unwrap(),
            DataValue::Null
        ));
        for source in [
            "{\"a\":1,}",
            "/*comment*/ {}",
            "[01]",
            "NaN",
            "undefined",
            "{} {}",
            "\"\\uD800\"",
        ] {
            assert!(parse(source.as_bytes()).is_err(), "{source}");
        }
    }
}
