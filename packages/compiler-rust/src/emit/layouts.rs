//! Runtime representations and tracing are emitted from the same owned layouts.
use super::*;

fn union_arm_abi(ty: &Type, module: &Emission<'_>) -> String {
    match ty {
        Type::Record { shape_id } if record_storage::shared(&module.records[*shape_id], module) => {
            "runtime::Gc<NativeRecordData>".into()
        }
        Type::Array { elem } => format!("runtime::JsArray<{}>", union_arm_abi(elem, module)),
        Type::Map { key, value } => format!(
            "runtime::Gc<NativeMap<{}, {}>>",
            union_arm_abi(key, module),
            union_arm_abi(value, module)
        ),
        Type::Set { elem } => format!("NativeTypedSet<{}>", union_arm_abi(elem, module)),
        Type::Generator {
            r#async,
            yield_type,
            return_type,
            next_type,
        } => {
            let channel = |ty: &Type| {
                if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
                    "()".into()
                } else {
                    union_arm_abi(ty, module)
                }
            };
            format!(
                "runtime::{}<{}, {}, {}>",
                if *r#async {
                    "JsAsyncGenerator"
                } else {
                    "JsGenerator"
                },
                channel(yield_type),
                channel(return_type),
                channel(next_type)
            )
        }
        // Promise payloads are erased by the runtime representation.
        Type::Promise { .. } => "runtime::JsPromise<NativeValue>".into(),
        // Nested unions retain their own nominal representation in this first
        // conservative pass. Canonicalizing recursive union graphs requires a
        // coinductive layout proof rather than a textual fixed point.
        Type::Union { union_id } => format!("U{union_id}"),
        _ => rust_type(ty.clone(), module),
    }
}

fn union_abi_representatives(module: &Emission<'_>) -> Vec<usize> {
    let mut representatives = std::collections::BTreeMap::<Vec<String>, usize>::new();
    module
        .unions
        .iter()
        .map(|union| {
            let key = union
                .arms
                .iter()
                .map(|arm| union_arm_abi(arm, module))
                .collect::<Vec<_>>();
            *representatives.entry(key).or_insert(union.id)
        })
        .collect()
}

pub(super) fn definitions(module: &Emission<'_>, output: &mut String) {
    record_storage::definitions(output);
    for record in &module.records {
        if record_storage::shared(record, module) {
            output.push_str(&format!("type R{} = NativeRecordData;\n", record.id));
            continue;
        }
        output.push_str(&format!("\nstruct R{} {{\n", record.id));
        if record.tuple {
            // A tuple refined from Dyn remains a view over the original JS
            // array. Closed tuple fields are used only by tuples born in the
            // typed IR; projected tuples read and write the shared source.
            output.push_str("source: Option<runtime::JsArray<NativeValue>>,\n");
        }
        for field in &record.fields {
            output.push_str(&format!(
                "{}: Option<{}>,\n",
                field_name(&field.name),
                rust_type(field.r#type.clone(), module)
            ));
        }
        if let Some(value) = &record.index_value {
            output.push_str(&format!(
                "overflow: Vec<(runtime::JsString, {})>,\n",
                rust_type(value.clone(), module)
            ));
        } else {
            output.push_str("own_keys: Vec<runtime::JsString>,\n");
        }
        output.push_str("}\n");
        let trace = record
            .fields
            .iter()
            .map(|field| {
                format!(
                    "if let Some(value) = &self.{} {{ value.trace_native(tracer); }}",
                    field_name(&field.name)
                )
            })
            .collect::<String>();
        let clear = record
            .fields
            .iter()
            .map(|field| format!("self.{} = None;", field_name(&field.name)))
            .collect::<String>();
        let (trace_source, clear_source) = if record.tuple {
            (
                "if let Some(source) = &self.source { source.trace_native(tracer); }",
                "self.source = None;",
            )
        } else {
            ("", "")
        };
        let (trace_dict, clear_dict) = if record.index_value.is_some() {
            (
                "for (_, value) in &self.overflow { value.trace_native(tracer); }",
                "self.overflow.clear();",
            )
        } else {
            ("", "self.own_keys.clear();")
        };
        output.push_str(&format!("impl runtime::Trace for R{} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ {trace_source} {trace} {trace_dict} }} }}\nimpl runtime::ClearEdges for R{} {{ fn clear_edges(&mut self) {{ {clear_source} {clear} {clear_dict} }} }}\n", record.id, record.id));
    }
    let union_representatives = union_abi_representatives(module);
    for union in &module.unions {
        let representative = union_representatives[union.id];
        if representative == union.id {
            output.push_str(&format!("\n#[derive(Clone)]\nenum U{} {{\n", union.id));
            for (tag, arm) in union.arms.iter().enumerate() {
                output.push_str(&format!("V{tag}({}),\n", rust_type(arm.clone(), module)));
            }
            output.push_str("}\n");
            let trace = union
                .arms
                .iter()
                .enumerate()
                .map(|(tag, arm)| {
                    let action = if matches!(arm, Type::Null | Type::Undefined) {
                        ""
                    } else {
                        "value.trace_native(tracer);"
                    };
                    format!("Self::V{tag}(value) => {{ {action} }}")
                })
                .collect::<Vec<_>>()
                .join(", ");
            output.push_str(&format!("impl NativeTrace for U{} {{ fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) {{ match self {{ {trace} }} }} }}\nimpl runtime::HeapValue for U{} {{ fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) {{ self.trace_native(tracer); }} }}\nimpl runtime::ArrayElement for U{} {{ fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) {{ self.trace_native(tracer); }} }}\n", union.id, union.id, union.id));
        } else {
            output.push_str(&format!("\ntype U{} = U{representative};\n", union.id));
        }
        let cases = union
            .arms
            .iter()
            .enumerate()
            .map(|(tag, ty)| {
                let equality = match ty {
                    Type::Record { .. }
                    | Type::Array { .. }
                    | Type::Map { .. }
                    | Type::Set { .. }
                    | Type::Object { .. }
                    | Type::Stats
                    | Type::Child
                    | Type::Bytes { .. } => {
                        if let Type::Record { shape_id } = ty
                            && module.records[*shape_id].tuple
                            && !record_storage::shared(&module.records[*shape_id], module)
                        {
                            "left.with(|left| left.source.as_ref().map(runtime::array_identity)).unwrap_or_else(|| left.identity()) == right.with(|right| right.source.as_ref().map(runtime::array_identity)).unwrap_or_else(|| right.identity())".to_string()
                        } else {
                            "left.ptr_eq(&right)".to_string()
                        }
                    }
                    Type::Func { .. } => {
                        let name = functions::type_name(ty, module);
                        format!("properties_{name}(&left).ptr_eq(&properties_{name}(&right))")
                    }
                    Type::Null | Type::Undefined => "true".into(),
                    Type::F64 | Type::Bigint | Type::String | Type::Bool | Type::Classval { .. } => {
                        "left == right".into()
                    }
                    Type::Dyn => "native_value_eq(&left, &right)".into(),
                    Type::Regex | Type::Symbol => "std::rc::Rc::ptr_eq(&left, &right)".into(),
                    Type::Promise { .. } => "runtime::promise_view_identity(&left) == runtime::promise_view_identity(&right)".into(),
                    Type::Generator { r#async, .. } => if *r#async {
                        "runtime::async_generator_ptr_eq(&left, &right)".into()
                    } else {
                        "runtime::generator_ptr_eq(&left, &right)".into()
                    },
                    _ => unreachable!("IR validated union equality for {ty:?}"),
                };
                format!(
                    "(U{}::V{tag}(left), U{}::V{tag}(right)) => {equality},",
                    union.id, union.id
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let left = values::box_value(&Type::Union { union_id: union.id }, "left", module);
        let right = values::box_value(&Type::Union { union_id: union.id }, "right", module);
        output.push_str(&format!("fn union_eq_{}(left: U{}, right: U{}) -> bool {{ match (left, right) {{ {cases} (left,right) => native_value_eq(&({left}), &({right})) }} }}\n", union.id, union.id, union.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Field, Record, Union};

    #[test]
    fn union_abi_reuses_shared_record_storage_but_preserves_tag_order() {
        let records = (0..2)
            .map(|id| Record {
                id,
                fields: vec![Field {
                    name: "value".into(),
                    // Dynamic fields require the shared property store; this
                    // test exercises union ABI reuse for that representation.
                    r#type: Type::Dyn,
                }],
                declared_order: vec!["value".into()],
                tuple: false,
                index_value: None,
            })
            .collect();
        let module = Module {
            ir_version: crate::ir::VERSION,
            source_file: "union-abi.ts".into(),
            source_modules: vec![],
            entry: "__main".into(),
            records,
            unions: vec![
                Union {
                    id: 0,
                    arms: vec![Type::Record { shape_id: 0 }, Type::Undefined],
                },
                Union {
                    id: 1,
                    arms: vec![Type::Record { shape_id: 1 }, Type::Undefined],
                },
                Union {
                    id: 2,
                    arms: vec![Type::Undefined, Type::Record { shape_id: 1 }],
                },
            ],
            globals: vec![],
            classes: vec![],
            functions: vec![],
        };
        let emission = Emission::new(&module);
        assert_eq!(union_abi_representatives(&emission), vec![0, 0, 2]);
    }
}
