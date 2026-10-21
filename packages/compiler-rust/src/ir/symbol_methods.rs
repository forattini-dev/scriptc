//! Prototype symbol descriptors stay separate from observable string names.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolMethodKey {
    Iterator,
    AsyncIterator,
}

impl SymbolMethodKey {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "iterator" => Some(Self::Iterator),
            "asyncIterator" => Some(Self::AsyncIterator),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Iterator => "iterator",
            Self::AsyncIterator => "asyncIterator",
        }
    }
    pub fn function_name(self, class: &str) -> String {
        format!("%{class}.%symbol.{}", self.name())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SymbolMethod {
    pub key: SymbolMethodKey,
    /// Absent until a call demands this body, including generator bodies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function: Option<String>,
}

pub(super) fn validate(
    module: &Module,
    functions: &HashMap<&str, &Function>,
) -> Result<(), String> {
    for class in &module.classes {
        let mut seen = std::collections::HashSet::new();
        for descriptor in &class.symbol_methods {
            if class.runtime || !seen.insert(descriptor.key) {
                return Err("invalid native symbol method surface".into());
            }
            if let Some(name) = &descriptor.function {
                let function = functions
                    .get(name.as_str())
                    .ok_or("missing native symbol method function")?;
                if *name != descriptor.key.function_name(&class.name)
                    || function
                        .captures
                        .as_ref()
                        .is_some_and(|captures| !captures.is_empty())
                    || function.params.first().map(|p| &p.r#type)
                        != Some(&Type::Object {
                            class_name: class.name.clone(),
                        })
                {
                    return Err("invalid native symbol method receiver/function".into());
                }
            }
        }
    }
    Ok(())
}

/// Erased instance mirrors do not yet carry symbol descriptors. Refuse the
/// conversion, including composite values and possible derived instances.
pub(crate) fn contains_symbol_methods(ty: &Type, module: &Module) -> bool {
    if module
        .classes
        .iter()
        .all(|class| class.symbol_methods.is_empty())
    {
        return false;
    }
    fn visit(ty: &Type, module: &Module, seen: &mut std::collections::HashSet<Type>) -> bool {
        if !seen.insert(ty.clone()) {
            return false;
        }
        match ty {
            Type::Object { class_name } => module.classes.iter().any(|class| {
                (module.subclass(&class.name, class_name)
                    || module.subclass(class_name, &class.name))
                    && (!class.symbol_methods.is_empty()
                        || class
                            .fields
                            .iter()
                            .any(|field| visit(&field.r#type, module, seen)))
            }),
            Type::Array { elem } | Type::Promise { inner: elem } | Type::Set { elem } => {
                visit(elem, module, seen)
            }
            Type::Map { key, value } => visit(key, module, seen) || visit(value, module, seen),
            Type::Func { params, ret, .. } => {
                params.iter().any(|param| visit(param, module, seen)) || visit(ret, module, seen)
            }
            Type::Record { shape_id } => module.records.get(*shape_id).is_some_and(|record| {
                record
                    .fields
                    .iter()
                    .any(|field| visit(&field.r#type, module, seen))
                    || record
                        .index_value
                        .as_ref()
                        .is_some_and(|value| visit(value, module, seen))
            }),
            Type::Union { union_id } => module
                .unions
                .get(*union_id)
                .is_some_and(|union| union.arms.iter().any(|arm| visit(arm, module, seen))),
            _ => false,
        }
    }
    visit(ty, module, &mut std::collections::HashSet::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module() -> Module {
        let loc = Loc {
            file: "symbols.ts".into(),
            start: 0,
            end: 0,
        };
        Module {
            ir_version: VERSION,
            source_file: loc.file.clone(),
            entry: "main".into(),
            records: vec![],
            unions: vec![],
            globals: vec![],
            classes: vec![Class {
                name: "Box".into(),
                js_name: "Box".into(),
                runtime: false,
                base: None,
                fields: vec![],
                methods: vec![],
                method_names: vec!["iterator".into()],
                symbol_methods: vec![SymbolMethod {
                    key: SymbolMethodKey::Iterator,
                    function: None,
                }],
                loc: loc.clone(),
            }],
            functions: vec![Function {
                name: "main".into(),
                params: vec![],
                locals: vec![],
                captures: None,
                is_async: false,
                rest: false,
                return_type: Type::Void,
                body: vec![],
                loc,
            }],
        }
    }

    #[test]
    fn inventory_does_not_demand_a_body_or_confuse_string_keys() {
        let mut module = module();
        super::super::validate(&module).unwrap();
        module.classes[0].symbol_methods.push(SymbolMethod {
            key: SymbolMethodKey::AsyncIterator,
            function: None,
        });
        super::super::validate(&module).unwrap();
        let wire = serde_json::to_value(&module).unwrap();
        assert_eq!(wire["classes"][0]["symbolMethods"][0]["key"], "iterator");
        assert!(
            wire["classes"][0]["symbolMethods"][0]
                .get("function")
                .is_none()
        );
        let duplicate = module.classes[0].symbol_methods[0].clone();
        module.classes[0].symbol_methods.push(duplicate);
        assert!(
            super::super::validate(&module)
                .unwrap_err()
                .contains("symbol method surface")
        );
    }

    #[test]
    fn demanded_body_requires_the_owned_function_and_receiver() {
        let mut module = module();
        let name = SymbolMethodKey::Iterator.function_name("Box");
        module.classes[0].symbol_methods[0].function = Some(name.clone());
        assert!(
            super::super::validate(&module)
                .unwrap_err()
                .contains("missing native symbol method function")
        );
        let mut function = Function {
            name,
            params: vec![],
            locals: vec![],
            captures: None,
            is_async: false,
            rest: false,
            return_type: Type::Void,
            body: vec![],
            loc: module.functions[0].loc.clone(),
        };
        function.params.push(Param {
            local_id: "p0".into(),
            name: "this".into(),
            r#type: Type::Object {
                class_name: "Box".into(),
            },
        });
        function.locals.push(Local {
            id: "p0".into(),
            name: "this".into(),
            r#type: function.params[0].r#type.clone(),
            mutable: false,
            boxed: false,
        });
        module.functions.push(function);
        super::super::validate(&module).unwrap();
        module.functions[1].params[0].r#type = Type::String;
        assert!(
            super::super::validate(&module)
                .unwrap_err()
                .contains("symbol method receiver")
        );
    }

    #[test]
    fn erasure_guard_traverses_composites_without_recursing_forever() {
        let mut module = module();
        module.records.push(Record {
            id: 0,
            fields: vec![
                Field {
                    name: "self".into(),
                    r#type: Type::Record { shape_id: 0 },
                },
                Field {
                    name: "box".into(),
                    r#type: Type::Object {
                        class_name: "Box".into(),
                    },
                },
            ],
            declared_order: vec!["self".into(), "box".into()],
            tuple: false,
            index_value: None,
        });
        assert!(contains_symbol_methods(
            &Type::Record { shape_id: 0 },
            &module
        ));
        module.classes[0].symbol_methods.clear();
        assert!(!contains_symbol_methods(
            &Type::Record { shape_id: 0 },
            &module
        ));
        assert!(!contains_symbol_methods(
            &Type::Record { shape_id: 99 },
            &module
        ));
    }
}
