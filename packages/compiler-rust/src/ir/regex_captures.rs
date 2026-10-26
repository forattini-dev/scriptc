use super::*;

pub(crate) struct ExecLayout {
    pub result: usize,
    pub array_tag: usize,
    pub null_tag: usize,
    pub capture: usize,
    pub string_tag: usize,
    pub undefined_tag: usize,
}

pub(crate) fn exec_layout(module: &Module, ty: &Type) -> Option<ExecLayout> {
    let Type::Union { union_id: result } = ty else {
        return None;
    };
    let arms = &module.unions.get(*result)?.arms;
    if arms.len() != 2 {
        return None;
    }
    let null_tag = arms.iter().position(|t| *t == Type::Null)?;
    let array_tag = arms.iter().position(|t| matches!(t, Type::Array { .. }))?;
    let Type::Array { elem } = &arms[array_tag] else {
        return None;
    };
    let Type::Union { union_id: capture } = elem.as_ref() else {
        return None;
    };
    let slots = &module.unions.get(*capture)?.arms;
    if slots.len() != 2 {
        return None;
    }
    Some(ExecLayout {
        result: *result,
        array_tag,
        null_tag,
        capture: *capture,
        string_tag: slots.iter().position(|t| *t == Type::String)?,
        undefined_tag: slots.iter().position(|t| *t == Type::Undefined)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_rows_require_nullable_elements_and_exact_result_tags() {
        let mut module = Module {
            ir_version: VERSION,
            source_file: "test.ts".into(),
            entry: "__main".into(),
            functions: vec![],
            globals: vec![],
            classes: vec![],
            records: vec![],
            unions: vec![
                Union {
                    id: 0,
                    arms: vec![Type::Undefined, Type::String],
                },
                Union {
                    id: 1,
                    arms: vec![
                        Type::Null,
                        Type::Array {
                            elem: Box::new(Type::Union { union_id: 0 }),
                        },
                    ],
                },
            ],
        };
        let ty = Type::Union { union_id: 1 };
        let layout = exec_layout(&module, &ty).unwrap();
        assert_eq!(
            (
                layout.null_tag,
                layout.array_tag,
                layout.string_tag,
                layout.undefined_tag
            ),
            (0, 1, 1, 0)
        );
        module.unions[0].arms[0] = Type::Null;
        assert!(exec_layout(&module, &ty).is_none());
        module.unions[0].arms[0] = Type::Undefined;
        module.unions[1].arms.push(Type::Undefined);
        assert!(exec_layout(&module, &ty).is_none());
    }
}
