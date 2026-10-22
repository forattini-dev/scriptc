//! A generic callable has one stable native layout and a fixed erased slot ABI.
use super::*;
use source_frontend::prelude::SignatureKind;

impl Lowerer<'_> {
    pub(in crate::frontend) fn erased_function_type(&mut self, id: TypeId) -> Option<Type> {
        let signatures = self.checker.get_signatures_of_type(id, SignatureKind::CALL);
        if signatures.is_empty() {
            return None;
        }
        let mut arity = 0;
        let mut results = Vec::new();
        for signature in signatures {
            let sig = self.checker.sig(signature);
            if sig.has_rest_parameter() {
                return None;
            }
            arity = arity.max(sig.parameters.len());
            let ret = self.checker.get_return_type_of_signature(signature);
            let symbol = self.checker.ty(ret).symbol().0;
            if let Some(shape_id) = self.polymorphic_callables.get(&symbol) {
                results.push(Type::Record {
                    shape_id: *shape_id,
                });
            } else {
                results.push(Type::Dyn);
            }
        }
        let result = results
            .first()
            .filter(|first| results.iter().all(|r| r == *first))
            .cloned()
            .unwrap_or(Type::Dyn);
        Some(Type::Func {
            rest: false,
            params: vec![Type::Dyn; arity],
            ret: Box::new(result),
        })
    }

    pub(in crate::frontend) fn polymorphic_callable_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol().0;
        if symbol == 0 {
            return None;
        }
        if let Some(shape_id) = self.polymorphic_callables.get(&symbol) {
            return Some(Type::Record {
                shape_id: *shape_id,
            });
        }
        let shape_id = self.records.len();
        self.polymorphic_callables.insert(symbol, shape_id);
        self.types.insert(
            id,
            type_graph::Resolution::Resolving {
                kind: type_graph::LayoutKind::Record,
                reference: Some(Type::Record { shape_id }),
            },
        );
        self.records.push(ir::Record {
            id: shape_id,
            fields: vec![],
            declared_order: vec![],
            tuple: false,
            index_value: None,
        });
        let signature = self.erased_function_type(id)?;
        let mut fields = vec![ir::Field {
            name: CALL_FIELD.into(),
            r#type: signature.clone(),
        }];
        for property in self.checker.get_properties_of_type(id).to_vec() {
            let info = self.checker.sym(property);
            if info
                .flags
                .intersects(SymbolFlags::ACCESSOR | SymbolFlags::OPTIONAL)
            {
                return None;
            }
            let name = info.name.to_string();
            if name == CALL_FIELD {
                return None;
            }
            let ty = self.checker.get_type_of_symbol(property);
            let signatures = self.checker.get_signatures_of_type(ty, SignatureKind::CALL);
            let r#type = if signatures.is_empty() {
                Type::Dyn
            } else {
                self.erased_function_type(ty)?
            };
            fields.push(ir::Field { name, r#type });
        }
        self.records[shape_id].declared_order = fields.iter().map(|f| f.name.clone()).collect();
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        self.records[shape_id].fields = fields;
        self.callables.insert(shape_id, signature);
        Some(Type::Record { shape_id })
    }

    pub(in crate::frontend) fn contextual_callable(
        &mut self,
        node: Node,
        target: &Type,
    ) -> Result<Option<Expr>, String> {
        if let Type::Func { .. } = target {
            if node.kind() == SyntaxKind::CallExpression
                && let Some(value) = self.function_bind_expected(node, Some(target.clone()))?
            {
                return Ok(Some(value));
            }
            if node.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(node);
                if let Some(signature) = self.request_function_context(
                    symbol,
                    node,
                    functions::UseKind::Value,
                    Some(target.clone()),
                    None,
                )? {
                    let value = Expr::Closure {
                        fn_name: signature.name,
                        captures: vec![],
                        r#type: Type::Func {
                            rest: signature.rest,
                            params: signature.params.into_iter().map(|p| p.r#type).collect(),
                            ret: Box::new(signature.return_type),
                        },
                        loc: self.loc(node),
                    };
                    return Ok(Some(self.coerce(value, target.clone(), node)?));
                }
            }
        }
        if let Type::Record { shape_id } = target
            && self.callables.contains_key(shape_id)
            && node.kind() == SyntaxKind::CallExpression
        {
            if let Some(value) = self.callable_assign_expected(node, Some(target.clone()))? {
                return Ok(Some(value));
            }
            let callee = node.expression();
            if callee.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(callee);
                if let Some(signature) = self.request_function_context(
                    symbol,
                    node,
                    functions::UseKind::Call,
                    None,
                    Some(target.clone()),
                )? {
                    let args = self.call_arguments(
                        node,
                        &signature
                            .params
                            .iter()
                            .map(|p| p.r#type.clone())
                            .collect::<Vec<_>>(),
                    )?;
                    let value = Expr::Call {
                        callee: signature.name,
                        args,
                        r#type: signature.return_type,
                        loc: self.loc(node),
                    };
                    return Ok(Some(self.coerce(value, target.clone(), node)?));
                }
            }
        }
        Ok(None)
    }
}
