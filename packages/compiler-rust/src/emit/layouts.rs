//! Runtime representations and tracing are emitted from the same owned layouts.
use super::*;

pub(super) fn definitions(module: &Module, output: &mut String) {
    for record in &module.records {
        output.push_str(&format!("\nstruct R{} {{\n", record.id));
        for field in &record.fields {
            output.push_str(&format!(
                "{}: Option<{}>,\n",
                field_name(&field.name),
                rust_type(field.r#type.clone())
            ));
        }
        if let Some(value) = &record.index_value {
            output.push_str(&format!(
                "overflow: Vec<(String, {})>,\n",
                rust_type(value.clone())
            ));
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
        let (trace_dict, clear_dict) = if record.index_value.is_some() {
            (
                "for (_, value) in &self.overflow { value.trace_native(tracer); }",
                "self.overflow.clear();",
            )
        } else {
            ("", "")
        };
        output.push_str(&format!("impl runtime::Trace for R{} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ {trace} {trace_dict} }} }}\nimpl runtime::ClearEdges for R{} {{ fn clear_edges(&mut self) {{ {clear} {clear_dict} }} }}\n", record.id, record.id));
    }
    for union in &module.unions {
        output.push_str(&format!("\n#[derive(Clone)]\nenum U{} {{\n", union.id));
        for (tag, arm) in union.arms.iter().enumerate() {
            output.push_str(&format!("V{tag}({}),\n", rust_type(arm.clone())));
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
        output.push_str(&format!("impl NativeTrace for U{} {{ fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) {{ match self {{ {trace} }} }} }}\nimpl runtime::ArrayElement for U{} {{ fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) {{ self.trace_native(tracer); }} }}\n", union.id, union.id));
        let cases = union
            .arms
            .iter()
            .enumerate()
            .map(|(tag, ty)| {
                let equality = match ty {
                    Type::Record { .. } | Type::Array { .. } | Type::Object { .. } => {
                        "left.ptr_eq(&right)"
                    }
                    Type::Null | Type::Undefined => "true",
                    Type::F64 | Type::String | Type::Bool => "left == right",
                    _ => unreachable!("IR validated"),
                };
                format!(
                    "(U{}::V{tag}(left), U{}::V{tag}(right)) => {equality},",
                    union.id, union.id
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        output.push_str(&format!("fn union_eq_{}(left: U{}, right: U{}) -> bool {{ match (left, right) {{ {cases} _ => false }} }}\n", union.id, union.id, union.id));
    }
}
