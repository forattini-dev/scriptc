//! Instance method discovery, demand and closed-hierarchy dispatch.
use super::*;

/// A declared `void` JavaScript method can still return a real value. Only
/// synthesize `undefined` for a method whose own returns cannot carry one.
fn method_returns_only_undefined(method: Node) -> bool {
    fn visit(node: Node) -> bool {
        if node.kind() == SyntaxKind::ReturnStatement {
            return node.expression().is_nil();
        }
        if matches!(
            node.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::MethodDeclaration
                | SyntaxKind::ClassDeclaration
                | SyntaxKind::ClassExpression
        ) {
            return true;
        }
        let mut valid = true;
        node.for_each_child(&mut |child| {
            valid = valid && visit(child);
            !valid
        });
        valid
    }
    !method.body().is_nil() && visit(method.body())
}

impl ClassGraph {
    pub fn next_method(&mut self) -> Option<Signature> {
        self.method_queue.pop_front()
    }

    pub(super) fn method(&self, mut owner: usize, name: &str) -> Option<(usize, Node)> {
        for _ in 0..=self.definitions.len() {
            let definition = &self.definitions[owner];
            if !definition.node.is_nil()
                && let Some(node) = definition.node.members().into_iter().rev().find(|node| {
                    node.kind() == SyntaxKind::MethodDeclaration
                        && !node.modifier_flags().intersects(ModifierFlags::STATIC)
                        && !matches!(
                            node.name().kind(),
                            SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
                        )
                        && node.name().text() == name
                })
            {
                return Some((owner, node));
            }
            owner = definition.base?;
        }
        None
    }

    pub(in crate::frontend) fn unique_method_node(&self, name: &str) -> Option<Node> {
        let candidates = self
            .definitions
            .iter()
            .filter(|definition| !definition.node.is_nil())
            .flat_map(|definition| definition.node.members())
            .filter(|candidate| {
                candidate.kind() == SyntaxKind::MethodDeclaration && candidate.name().text() == name
            })
            .collect::<Vec<_>>();
        let [method] = candidates.as_slice() else {
            return None;
        };
        Some(*method)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn generic_runtime_parameter_methods_remain_refused() {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/generic-method-queue");
                for entry in [
                    "main.ts",
                    "overridden-index.ts",
                    "inspect.ts",
                    "inspect-after-search.ts",
                    "custom-index.ts",
                    "direct-parameter.ts",
                ] {
                    let input = std::fs::canonicalize(root.join(entry)).unwrap();
                    let work = tempfile::Builder::new()
                        .prefix("scriptc-generic-method-")
                        .tempdir()
                        .unwrap();
                    let result = crate::frontend::lower(&input, work.path(), None, false);
                    let error = match result {
                        Ok(_) => panic!("{entry}: unsupported generic use must be refused"),
                        Err(error) => error,
                    };
                    assert!(
                        error.contains("generic and overloaded method"),
                        "{entry}: {error}"
                    );
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }
}

impl Lowerer<'_> {
    pub(in crate::frontend) fn javascript_prototype_value_candidate(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || !node.question_dot_token().is_nil()
        {
            return false;
        }
        let receiver = node.expression();
        let symbol = if receiver.kind() == SyntaxKind::Identifier {
            self.symbol(receiver)
        } else {
            0
        };
        let stored = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .map(|local| local.r#type.clone())
            .filter(|ty| matches!(ty, Type::Object { .. }));
        let Type::Object { class_name } = (if receiver.kind() == SyntaxKind::ThisKeyword {
            self.instance_this
                .as_ref()
                .map(|local| local.r#type.clone())
        } else {
            stored.or_else(|| self.ty(receiver).ok())
        })
        .unwrap_or(Type::Dyn) else {
            return false;
        };
        let Some(index) = self.classes.definition_index_for_name(&class_name) else {
            return false;
        };
        parameter_abi::is_javascript(self.classes.definitions[index].node)
            && self.classes.method(index, node.name().text()).is_some()
    }

    pub(in crate::frontend) fn dynamic_callable_initializer(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let callee = node.expression();
        if callee.kind() == SyntaxKind::PropertyAccessExpression
            && matches!(callee.name().text(), "call" | "apply")
        {
            return true;
        }
        let source = if callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "bind"
        {
            callee.expression()
        } else {
            callee
        };
        if self.javascript_prototype_value_candidate(source) {
            return true;
        }
        if source.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(source);
        self.bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .is_some_and(|local| local.r#type == Type::Dyn)
    }

    pub(in crate::frontend) fn defer_erased_thenable_methods(&mut self, source: &Type) {
        let methods = self
            .classes
            .dynamic_method_candidates_for_type(source, "then", &self.unions);
        for method in methods {
            let parameter_count = receivers::parameters(method).len();
            self.declarations.insert(
                declarations::Key::of(method),
                declarations::Hint {
                    rest: false,
                    params: vec![Some(Type::Dyn); parameter_count],
                    optional: vec![true; parameter_count],
                    parametric_callback_results: vec![false; parameter_count],
                    ret: Some(Type::Dyn),
                    reason: None,
                    value_type: None,
                    class: None,
                },
            );
            self.classes.defer_erased_method(method, "then".into());
        }
    }

    pub(in crate::frontend) fn planned_class_method_call_result(
        &mut self,
        call: Node,
    ) -> Option<Type> {
        if call.kind() != SyntaxKind::CallExpression
            || call.expression().kind() != SyntaxKind::PropertyAccessExpression
        {
            return None;
        }
        let member = call.expression();
        let receiver = receivers::reference_node(member.expression());
        let class_name = if receiver.kind() == SyntaxKind::NewExpression {
            self.source_constructed_class_name(receiver.expression())?
        } else {
            let Type::Object { class_name } = self.ty(receiver).ok()? else {
                return None;
            };
            class_name
        };
        let index = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)?;
        let (owner, method) = self.classes.method(index, member.name().text())?;
        self.layout_class(owner).ok()?;
        self.planned_javascript_method_return(method, owner)
    }

    pub(in crate::frontend) fn request_method(
        &mut self,
        owner: usize,
        name: &str,
        node: Node,
    ) -> Result<Signature, String> {
        self.request_method_with_result(owner, name, node, None)
    }

    pub(in crate::frontend) fn request_dynamic_method(
        &mut self,
        owner: usize,
        name: &str,
        node: Node,
    ) -> Result<Signature, String> {
        let key = (owner, name.to_string(), "\0dynamic".to_string());
        if let Some(signature) = self.classes.borrowed_methods.get(&key) {
            return Ok(signature.clone());
        }
        let mut signature = self.request_method(owner, name, node)?;
        fn requires_lexical_class(node: Node) -> bool {
            if matches!(
                node.kind(),
                SyntaxKind::SuperKeyword | SyntaxKind::PrivateIdentifier
            ) {
                return true;
            }
            let mut found = false;
            node.for_each_child(&mut |child| {
                found = found || requires_lexical_class(child);
                found
            });
            found
        }
        let captures_used =
            self.classes
                .lexical_method_captures(node)
                .is_some_and(|(_, captures)| {
                    captures
                        .into_iter()
                        .any(|(symbol, _, _)| self.closure_mentions(node, symbol))
                });
        let lexical_class = requires_lexical_class(node.body());
        let async_generator_needs_view = if signature.is_async && signature.generator.is_some() {
            let checker_signature = self.checker.get_signature_from_declaration(node);
            let checker_return = self.checker.get_return_type_of_signature(checker_signature);
            !matches!(self.generator_type(checker_return), Some(Type::Generator { yield_type, .. }) if *yield_type == Type::Dyn)
        } else {
            false
        };
        if captures_used
            && !node.body().is_nil()
            && !lexical_class
            && !async_generator_needs_view
            && signature.generator.is_none()
        {
            // A method that reads its class's lexical captures needs its typed
            // receiver to reach them. Keep the ordinary method: the erased
            // dispatcher checks the receiver and each argument against its
            // ABI before the call, so a mismatched receiver raises a TypeError.
            self.classes.borrowed_methods.insert(key, signature.clone());
            return Ok(signature);
        }
        if node.body().is_nil() || captures_used || lexical_class || async_generator_needs_view {
            let source = source_file_info(get_source_file_of_node(node))
                .file_name
                .clone();
            return Err(self.refuse(
                node,
                &format!(
                    "erased generator, super, private, capturing or dynamically created prototype methods are not ported: method {name:?}, source {source}, generator={}, captured={}, lexical-class={}, async-generator-view={}",
                    signature.generator.is_some(), captures_used, lexical_class, async_generator_needs_view,
                ),
            ));
        }
        signature.name.push_str("$dynamic");
        signature.params[0].r#type = Type::Dyn;
        let last = signature.params.len() - 1;
        for (index, param) in signature.params.iter_mut().enumerate().skip(1) {
            param.r#type = if signature.rest && index == last {
                Type::Array {
                    elem: Box::new(Type::Dyn),
                }
            } else {
                Type::Dyn
            };
        }
        // A generator call returns the generator object immediately, even
        // for `async *`; keep its typed channels for the erased dispatcher.
        if signature.generator.is_none() {
            signature.return_type = if signature.is_async {
                Type::Promise {
                    inner: Box::new(Type::Dyn),
                }
            } else {
                Type::Dyn
            };
        }
        self.classes.borrowed_methods.insert(key, signature.clone());
        self.classes.method_queue.push_back(signature.clone());
        Ok(signature)
    }

    fn request_method_with_result(
        &mut self,
        owner: usize,
        name: &str,
        node: Node,
        expected_result: Option<Type>,
    ) -> Result<Signature, String> {
        let key = (owner, name.to_string());
        if let Some(signature) = self.classes.methods.get(&key) {
            return Ok(signature.clone());
        }
        self.layout_class(owner)?;
        let abstract_method =
            node.body().is_nil() && node.modifier_flags().intersects(ModifierFlags::ABSTRACT);
        if abstract_method {
            if !node.type_parameters().is_empty()
                || node.modifier_flags().intersects(ModifierFlags::ASYNC)
                || !node.asterisk_token().is_nil()
                || self.classes.definitions[owner]
                    .node
                    .members()
                    .into_iter()
                    .any(|member| {
                        member != node
                            && member.kind() == SyntaxKind::MethodDeclaration
                            && member.name().text() == name
                    })
            {
                return Err(self.refuse(
                    node,
                    "generic, async, generator or overloaded abstract methods are not ported",
                ));
            }
            let file =
                std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
            let signature = self.function_signature(node, owner);
            self.file = file;
            let mut signature = signature?;
            let class = self.classes.definitions[owner].name.clone();
            signature.name = format!("%{class}.{name}");
            for (index, param) in signature.params.iter_mut().enumerate() {
                param.local_id = format!("p{}", index + 1);
            }
            signature.params.insert(
                0,
                Param {
                    local_id: "p0".into(),
                    name: "this".into(),
                    r#type: self.classes.object(owner),
                },
            );
            self.ensure_exception_classes(node)?;
            let loc = Loc {
                file: signature.file.clone(),
                start: node.pos().max(0),
                end: node.end(),
            };
            let message = format!("Cannot call abstract method {name}");
            self.lifted.push(Function {
                is_async: false,
                generator: None,
                rest: signature.rest,
                name: signature.name.clone(),
                params: signature.params.clone(),
                captures: None,
                return_type: signature.return_type.clone(),
                locals: signature
                    .params
                    .iter()
                    .map(|param| Local {
                        id: param.local_id.clone(),
                        name: param.name.clone(),
                        r#type: param.r#type.clone(),
                        mutable: false,
                        boxed: false,
                    })
                    .collect(),
                body: vec![Stmt::Throw {
                    value: Expr::LibCall {
                        r#fn: "error.new".into(),
                        args: vec![Expr::StrLit {
                            value: message,
                            r#type: Type::String,
                            loc: loc.clone(),
                        }],
                        r#type: Type::Object {
                            class_name: "%TypeError".into(),
                        },
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }],
                loc,
            });
            self.classes.methods.insert(key, signature.clone());
            let layout = self.classes.layouts[owner].as_mut().unwrap();
            if !layout.methods.iter().any(|method| method == name) {
                layout.methods.push(name.into());
            }
            return Ok(signature);
        }
        fn references_type_parameter(
            lowerer: &mut Lowerer<'_>,
            node: Node,
            parameters: &HashSet<u32>,
        ) -> bool {
            if node.kind() == SyntaxKind::Identifier && parameters.contains(&lowerer.symbol(node)) {
                return true;
            }
            let mut found = false;
            node.for_each_child(&mut |child| {
                found = found || references_type_parameter(lowerer, child, parameters);
                found
            });
            found
        }

        fn contains_callback_type(node: Node) -> bool {
            if node.kind() == SyntaxKind::FunctionType {
                return true;
            }
            let mut found = false;
            node.for_each_child(&mut |child: Node| {
                found |= contains_callback_type(child);
                found
            });
            found
        }

        let type_parameters = node
            .type_parameters()
            .into_iter()
            .map(|parameter| self.symbol(parameter.name()))
            .filter(|symbol| *symbol != 0)
            .collect::<HashSet<_>>();
        let generic_runtime_parameter = !type_parameters.is_empty()
            && receivers::parameters(node).into_iter().any(|parameter| {
                !parameter.type_().is_nil()
                    && references_type_parameter(self, parameter.type_(), &type_parameters)
                    && !contains_callback_type(parameter.type_())
            });
        let overloaded = self.classes.definitions[owner]
            .node
            .members()
            .into_iter()
            .any(|member| {
                member.kind() == SyntaxKind::MethodDeclaration
                    && member.name().text() == name
                    && member.body().is_nil()
            });
        if overloaded || (generic_runtime_parameter && self.declared(node).is_none()) {
            let source = source_frontend::prelude::source_file_info(
                source_frontend::prelude::get_source_file_of_node(node),
            )
            .file_name
            .clone();
            return Err(self.refuse(
                node,
                &format!(
                    "generic and overloaded method bodies are not ported: class={} method={} typeParameters={} source={source}",
                    self.classes.definitions[owner].name,
                    name,
                    node.type_parameters().len(),
                ),
            ));
        }
        if let Some(result) = expected_result
            && result != Type::Dyn
            && !matches!(result, Type::Void | Type::Undefined)
            && (parameter_abi::is_javascript(node) && node.type_().is_nil()
                || !node.type_parameters().is_empty())
            && self.declared(node).is_none()
            && !self
                .class_contract(self.classes.definitions[owner].node)
                .is_some_and(|hint| hint.methods.iter().any(|(method, _)| method == name))
        {
            let source_params = receivers::parameters(node);
            let callback_transports = source_params
                .iter()
                .map(|param| {
                    !param.type_().is_nil()
                        && contains_callback_type(param.type_())
                        && references_type_parameter(self, param.type_(), &type_parameters)
                })
                .collect::<Vec<_>>();
            let params = source_params
                .iter()
                .enumerate()
                .map(|(index, param)| {
                    self.storage_type(param.name())
                        .ok()
                        .or_else(|| callback_transports[index].then_some(Type::Dyn))
                })
                .collect::<Vec<_>>();
            if params.iter().all(Option::is_some) {
                self.declarations.insert(
                    declarations::Key::of(node),
                    declarations::Hint {
                        rest: node
                            .parameters()
                            .iter()
                            .last()
                            .is_some_and(|param| !param.dot_dot_dot_token().is_nil()),
                        params,
                        optional: source_params
                            .iter()
                            .map(|param| !param.question_token().is_nil())
                            .collect(),
                        parametric_callback_results: callback_transports,
                        ret: Some(result),
                        reason: None,
                        value_type: None,
                        class: None,
                    },
                );
            }
        }
        if let Some(hint) = self
            .class_contract(self.classes.definitions[owner].node)
            .and_then(|hint| hint.methods.iter().find(|(method, _)| method == name))
            .cloned()
        {
            let Some(Type::Func { params, ret, rest }) = hint.1 else {
                // Generic public declarations often erase to `unknown` while
                // their JavaScript implementation has a concrete body. Let
                // the implementation infer its own native ABI in that case.
                return self.request_method_without_contract(owner, name, node);
            };
            let parameter_count = params.len();
            self.declarations.insert(
                declarations::Key::of(node),
                declarations::Hint {
                    rest,
                    params: params.into_iter().map(Some).collect(),
                    optional: vec![false; parameter_count],
                    parametric_callback_results: vec![false; parameter_count],
                    ret: Some(*ret),
                    reason: None,
                    value_type: None,
                    class: None,
                },
            );
        }
        let file = std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
        let signature = self.function_signature(node, owner);
        self.file = file;
        let mut signature = signature?;
        let class = self.classes.definitions[owner].name.clone();
        signature.name = format!("%{class}.{name}");
        for (index, param) in signature.params.iter_mut().enumerate() {
            param.local_id = format!("p{}", index + 1);
        }
        signature.params.insert(
            0,
            Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: self.classes.object(owner),
            },
        );
        self.classes.methods.insert(key, signature.clone());
        self.classes.method_queue.push_back(signature.clone());
        let layout = self.classes.layouts[owner].as_mut().unwrap();
        layout.methods.push(name.into());
        let node = self.classes.definitions[owner].node;
        layout.methods.sort_by_key(|name| {
            node.members()
                .into_iter()
                .rfind(|member| {
                    member.kind() == SyntaxKind::MethodDeclaration && member.name().text() == name
                })
                .unwrap()
                .pos()
        });
        Ok(signature)
    }

    fn request_method_without_contract(
        &mut self,
        owner: usize,
        name: &str,
        node: Node,
    ) -> Result<Signature, String> {
        let key = (owner, name.to_string());
        let file = std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
        let signature = self.function_signature(node, owner);
        self.file = file;
        let mut signature = signature?;
        let class = self.classes.definitions[owner].name.clone();
        signature.name = format!("%{class}.{name}");
        for (index, param) in signature.params.iter_mut().enumerate() {
            param.local_id = format!("p{}", index + 1);
        }
        signature.params.insert(
            0,
            Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: self.classes.object(owner),
            },
        );
        self.classes.methods.insert(key, signature.clone());
        self.classes.method_queue.push_back(signature.clone());
        let layout = self.classes.layouts[owner].as_mut().unwrap();
        if !layout.methods.iter().any(|method| method == name) {
            layout.methods.push(name.into());
        }
        Ok(signature)
    }

    pub(in crate::frontend) fn class_prototype_method_value(
        &mut self,
        node: Node,
        expected_result: Option<Type>,
        bound_receiver: Option<Type>,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = node.expression();
        let prototype = receiver.kind() == SyntaxKind::PropertyAccessExpression
            && receiver.name().text() == "prototype";
        let class_name = if prototype {
            let Some(Type::Object { class_name }) = self.ty(receiver).ok() else {
                return Ok(None);
            };
            class_name
        } else {
            // Instance method extraction (`this.run.bind(this)`) is the same
            // prototype function identity as `Class.prototype.run`. Require
            // the checker declaration to be a method so an own callable data
            // slot with the same spelling is never mistaken for a prototype.
            let symbol = self.symbol(node.name());
            let declaration = (symbol != 0)
                .then(|| {
                    self.checker
                        .sym(source_frontend::prelude::SymbolId(symbol))
                        .value_declaration
                })
                .filter(|declaration| {
                    !declaration.is_nil()
                        && declaration.kind() == SyntaxKind::MethodDeclaration
                        && !declaration
                            .modifier_flags()
                            .intersects(ModifierFlags::STATIC)
                });
            let Some(declaration) = declaration else {
                return Ok(None);
            };
            let Some(index) = self
                .classes
                .definitions
                .iter()
                .position(|definition| definition.node == declaration.parent())
            else {
                return Ok(None);
            };
            self.classes.definitions[index].name.clone()
        };
        let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)
        else {
            return Ok(None);
        };
        self.resolve_class(index)?;
        let name = node.name().text();
        let Some((owner, declaration)) = self.classes.method(index, name) else {
            return Ok(None);
        };
        let mut signature =
            self.request_method_with_result(owner, name, declaration, expected_result)?;
        if prototype
            && let Some(Type::Object { class_name: target }) = bound_receiver
            && target != self.classes.definitions[owner].name
            && !self
                .classes
                .subclass(&target, &self.classes.definitions[owner].name)
        {
            let key = (owner, name.to_string(), target.clone());
            if let Some(existing) = self.classes.borrowed_methods.get(&key) {
                signature = existing.clone();
            } else {
                let Some(target_index) = self
                    .classes
                    .definitions
                    .iter()
                    .position(|definition| definition.name == target)
                else {
                    return Err(self.refuse(node, "borrowed method receiver has no native class"));
                };
                self.layout_class(target_index)?;
                let owner_type = self.classes.object(owner);
                let target_type = self.classes.object(target_index);
                signature.params[0].r#type = target_type.clone();
                if signature.return_type == owner_type {
                    // Fluent prototype methods return their live receiver.
                    // A structurally borrowed method therefore returns the
                    // borrowing class identity, not the declaration owner.
                    signature.return_type = target_type;
                }
                signature.name = format!(
                    "%{}.borrowed.{name}.{}",
                    self.classes.definitions[owner].name, target
                );
                self.classes.borrowed_methods.insert(key, signature.clone());
                self.classes.method_queue.push_back(signature.clone());
            }
        }
        let ty = Type::Func {
            rest: signature.rest,
            params: signature
                .params
                .iter()
                .map(|param| param.r#type.clone())
                .collect(),
            ret: Box::new(signature.return_type),
        };
        Ok(Some(Expr::Closure {
            fn_name: signature.name,
            captures: vec![],
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn class_call(&mut self, call: Node) -> Result<Option<Expr>, String> {
        self.class_call_with_result(call, None)
    }

    pub(in crate::frontend) fn class_call_on_value(
        &mut self,
        call: Node,
        object: Expr,
    ) -> Result<Option<Expr>, String> {
        let Type::Object { class_name } = object.ty() else {
            return Ok(None);
        };
        let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)
        else {
            return Ok(None);
        };
        self.resolve_class(index)?;
        let member = call.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let name = member.name().text();
        if self.field_type(&class_name, name).is_some() {
            return Ok(None);
        }
        let Some((owner, declaration)) = self.classes.method(index, name) else {
            return Ok(None);
        };
        for child in 0..self.classes.definitions.len() {
            self.resolve_class(child)?;
        }
        let signature = self.request_method(owner, name, declaration)?;
        let mut overridden = false;
        for child in 0..self.classes.definitions.len() {
            if child == index
                || !self
                    .classes
                    .subclass(&self.classes.definitions[child].name, &class_name)
            {
                continue;
            }
            if let Some((implementation, declaration)) = self.classes.method(child, name)
                && implementation != owner
            {
                let other = self.request_method(implementation, name, declaration)?;
                let base = signature.params.iter().skip(1).collect::<Vec<_>>();
                let derived = other.params.iter().skip(1).collect::<Vec<_>>();
                let required_extra = derived.len() > base.len()
                    && derived[base.len()..].iter().any(|parameter| {
                        parameter.r#type != Type::Dyn && !self.optional_storage(&parameter.r#type)
                    });
                if required_extra
                    || derived.iter().zip(&base).any(|(derived, base)| {
                        derived.r#type != base.r#type && derived.r#type != Type::Dyn
                    })
                    || other.return_type != signature.return_type
                {
                    return Err(self.refuse(
                        declaration,
                        "optional class method override requires a compatible native parameter/result ABI",
                    ));
                }
                overridden = true;
            }
        }
        let target = if overridden {
            self.classes.object(index)
        } else {
            self.classes.object(owner)
        };
        let object = self.coerce(object, target, member.expression())?;
        let types = signature
            .params
            .iter()
            .skip(1)
            .map(|parameter| parameter.r#type.clone())
            .collect::<Vec<_>>();
        let args = std::iter::once(object)
            .chain(self.rest_method_arguments(call, &types, signature.rest)?)
            .collect();
        Ok(Some(if overridden {
            Expr::VirtualCall {
                class_name,
                method: name.into(),
                args,
                r#type: signature.return_type,
                loc: self.loc(call),
            }
        } else {
            Expr::Call {
                callee: signature.name,
                args,
                r#type: signature.return_type,
                loc: self.loc(call),
            }
        }))
    }

    pub(in crate::frontend) fn class_call_expected(
        &mut self,
        call: Node,
        result: Type,
    ) -> Result<Option<Expr>, String> {
        self.class_call_with_result(call, Some(result))
    }

    fn class_call_with_result(
        &mut self,
        call: Node,
        expected_result: Option<Type>,
    ) -> Result<Option<Expr>, String> {
        let member = call.expression();
        let member_name = match member.kind() {
            SyntaxKind::PropertyAccessExpression => member.name(),
            SyntaxKind::ElementAccessExpression
                if member.argument_expression().kind() == SyntaxKind::StringLiteral =>
            {
                member.argument_expression()
            }
            _ => return Ok(None),
        };
        if member_name.kind() == SyntaxKind::PrivateIdentifier {
            return self.private_method_call(call);
        }
        let receiver = member.expression();
        if self.module_namespace(receiver) {
            return Ok(None);
        }
        if receiver.kind() == SyntaxKind::ThisKeyword
            && self
                .instance_this
                .as_ref()
                .is_some_and(|local| local.r#type == Type::Dyn)
        {
            let symbol = self.symbol(member_name);
            let declaration = (symbol != 0)
                .then(|| {
                    self.checker
                        .sym(source_frontend::prelude::SymbolId(symbol))
                        .value_declaration
                })
                .filter(|node| !node.is_nil() && node.kind() == SyntaxKind::MethodDeclaration);
            if let Some(declaration) = declaration
                && let Some(owner) = self.classes.definition_index_for_node(declaration.parent())
            {
                let source = self.classes.object(owner);
                let methods = self.classes.dynamic_method_candidates_for_type(
                    &source,
                    member_name.text(),
                    &self.unions,
                );
                for method in methods {
                    let owner = self
                        .classes
                        .definition_index_for_node(method.parent())
                        .ok_or_else(|| self.refuse(call, "prototype method has no owner"))?;
                    self.request_dynamic_method(owner, member_name.text(), method)?;
                }
            }
            return Ok(None);
        }
        let checked_receiver = self.checker.get_type_at_location(receiver);
        if self
            .checker
            .ty(checked_receiver)
            .flags
            .intersects(TypeFlags::INTERSECTION)
            && !self
                .checker
                .get_signatures_of_type(checked_receiver, SignatureKind::CALL)
                .is_empty()
            && self
                .checker
                .ty(checked_receiver)
                .types()
                .iter()
                .any(|part| {
                    let symbol = self.checker.ty(*part).symbol();
                    symbol.0 != 0
                        && self
                            .checker
                            .sym(symbol)
                            .flags
                            .intersects(SymbolFlags::CLASS)
                })
        {
            // The intersection describes a callable facade with attached
            // methods, not an instance of its nominal class component.
            // Read the live property from the function object instead.
            return Ok(None);
        }
        let is_super = receiver.kind() == SyntaxKind::SuperKeyword;
        let ty = if is_super || receiver.kind() == SyntaxKind::ThisKeyword {
            self.instance_this
                .as_ref()
                .map(|local| local.r#type.clone())
        } else if receiver.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(receiver);
            let storage = self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|local| local.r#type.clone());
            if matches!(storage, Some(Type::Dyn | Type::Union { .. })) {
                self.ty(receiver)
                    .ok()
                    .filter(|ty| matches!(ty, Type::Object { .. }))
                    .or(storage)
            } else {
                storage.or_else(|| self.ty(receiver).ok())
            }
        } else {
            self.ty(receiver).ok()
        };
        let (class_name, index) = if let Some(Type::Object { class_name }) = ty {
            if self.namespace_capsule(&Type::Object {
                class_name: class_name.clone(),
            }) {
                return Ok(None);
            }
            let Some(index) = self
                .classes
                .definitions
                .iter()
                .position(|d| d.name == class_name)
            else {
                return Err(self.refuse(
                    call,
                    &format!("class method receiver {class_name:?} has no native class definition"),
                ));
            };
            (class_name, index)
        } else {
            if !matches!(ty, Some(Type::Dyn)) {
                return Ok(None);
            }
            let receiver_symbol = (receiver.kind() == SyntaxKind::Identifier)
                .then(|| self.symbol(receiver))
                .unwrap_or(0);
            if receiver_symbol != 0 && self.data_bindings.contains(&receiver_symbol) {
                // Native host/data handles deliberately retain a dynamic
                // owning identity. A coincidentally unique source-class method
                // name must not rebrand that value as the class instance.
                return Ok(None);
            }
            // A private JavaScript parameter can retain an owning Dyn ABI even
            // when the checker resolves its member to one concrete source
            // class. Recover that nominal identity from the method declaration
            // and perform the ordinary checked receiver conversion below. This
            // is essential for generator methods: erasing the call result would
            // otherwise discard all yield/return/next channels.
            let symbol = self.symbol(member_name);
            let symbol_declaration = (symbol != 0).then(|| {
                self.checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .value_declaration
            });
            let declaration = symbol_declaration.filter(|declaration| {
                !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::MethodDeclaration
                    && !declaration
                        .modifier_flags()
                        .intersects(ModifierFlags::STATIC)
                    && declaration.parent().kind() == SyntaxKind::ClassDeclaration
            });
            let declared_owner = declaration.and_then(|declaration| {
                self.classes
                    .definitions
                    .iter()
                    .position(|definition| definition.node == declaration.parent())
            });
            let index = if let Some(index) = declared_owner {
                index
            } else {
                // `any` has no nominal provenance. Matching a class method
                // by spelling alone can reinterpret array.map or another
                // ordinary property call as an unrelated class method.
                return Ok(None);
            };
            (self.classes.definitions[index].name.clone(), index)
        };
        self.resolve_class(index)?;
        let name = member_name.text();
        let node_stream = matches!(
            class_name.as_str(),
            node_streams::TRANSFORM
                | node_streams::DUPLEX
                | node_streams::READABLE
                | node_streams::WRITABLE
        );
        if node_stream && matches!(name, "destroy" | "pause" | "resume") {
            let object = self.expression(receiver)?;
            if name == "destroy" {
                let args = call.arguments();
                if args.len() > 1
                    || args
                        .iter()
                        .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
                {
                    return Err(self.refuse(
                        call,
                        "native stream destroy accepts at most one ordinary argument",
                    ));
                }
                let result = object.ty();
                let mut values = vec![object];
                if let Some(argument) = args.first() {
                    values.push(self.expected_expression(argument, Type::Dyn)?);
                }
                return Ok(Some(Expr::LibCall {
                    r#fn: "nodeStream.destroy".into(),
                    args: values,
                    r#type: result,
                    loc: self.loc(call),
                }));
            }
            let mut values = vec![object];
            for argument in call.arguments() {
                if argument.kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(
                        argument,
                        "native stream identity method spreads are not ported",
                    ));
                }
                values.push(self.expected_expression(argument, Type::Dyn)?);
            }
            let maximum = if name == "destroy" { 2 } else { 1 };
            if values.len() > maximum {
                return Err(self.refuse(
                    call,
                    if name == "destroy" {
                        "native stream destroy accepts at most one error"
                    } else {
                        "native stream pause/resume do not accept arguments"
                    },
                ));
            }
            let result = values[0].ty();
            let mut helper = helpers::Helper::new(
                &format!("native_stream_{name}"),
                values.iter().map(Expr::ty).collect(),
                result.clone(),
                self.loc(call),
            );
            helper.function.body.push(Stmt::Return {
                value: Some(helper.read(&helper.param(0))),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Call {
                callee: self.install_helper(helper.function),
                args: values,
                r#type: result,
                loc: self.loc(call),
            }));
        }
        if node_stream
            && matches!(
                name,
                "write" | "push" | "end" | "cork" | "uncork" | "isPaused"
            )
        {
            let object = self.expression(receiver)?;
            let mut values = vec![object];
            for argument in call.arguments() {
                if argument.kind() == SyntaxKind::SpreadElement {
                    return Err(
                        self.refuse(argument, "native stream core method spreads are not ported")
                    );
                }
                values.push(self.expected_expression(argument, Type::Dyn)?);
            }
            let arguments = values.len() - 1;
            let valid = match name {
                "write" => (1..=3).contains(&arguments),
                "push" => (1..=2).contains(&arguments),
                "end" => arguments <= 3,
                "cork" | "uncork" | "isPaused" => arguments == 0,
                _ => unreachable!(),
            };
            if !valid {
                return Err(self.refuse(
                    call,
                    "native stream core method received an unsupported argument count",
                ));
            }
            let result = match name {
                "write" | "push" | "isPaused" => Type::Bool,
                "end" => values[0].ty(),
                "cork" | "uncork" => Type::Void,
                _ => unreachable!(),
            };
            let mut helper = helpers::Helper::new(
                &format!("native_stream_{name}"),
                values.iter().map(Expr::ty).collect(),
                result.clone(),
                self.loc(call),
            );
            let value = match name {
                "write" | "push" => Some(Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                "isPaused" => Some(Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                "end" => Some(helper.read(&helper.param(0))),
                "cork" | "uncork" => None,
                _ => unreachable!(),
            };
            helper.function.body.push(Stmt::Return {
                value,
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Call {
                callee: self.install_helper(helper.function),
                args: values,
                r#type: result,
                loc: self.loc(call),
            }));
        }
        if (class_name == node_console::CLASS && name == "table")
            || (class_name == node_streams::TRANSFORM && name == "read")
        {
            let object = self.expression(receiver)?;
            let mut values = vec![object];
            for argument in call.arguments() {
                if argument.kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(
                        argument,
                        "native Console/Transform method spreads are not ported",
                    ));
                }
                let value = self.expression(argument)?;
                values.push(self.coerce(value, Type::Dyn, argument)?);
            }
            let result = if class_name == node_streams::TRANSFORM {
                Type::String
            } else {
                Type::Dyn
            };
            let mut helper = helpers::Helper::new(
                if class_name == node_streams::TRANSFORM {
                    "native_transform_read"
                } else {
                    "native_console_table"
                },
                values.iter().map(Expr::ty).collect(),
                result.clone(),
                self.loc(call),
            );
            let value = if result == Type::String {
                Expr::StrLit {
                    value: String::new(),
                    r#type: Type::String,
                    loc: helper.loc(),
                }
            } else {
                Expr::DynFrom {
                    value: Box::new(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: helper.loc(),
                    }),
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                }
            };
            helper.function.body.push(Stmt::Return {
                value: Some(value),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Call {
                callee: self.install_helper(helper.function),
                args: values,
                r#type: result,
                loc: self.loc(call),
            }));
        }
        let lookup = if is_super {
            self.classes.definitions[index]
                .base
                .ok_or_else(|| self.refuse(call, "super method requires a derived instance body"))?
        } else {
            index
        };
        if !is_super && self.field_type(&class_name, name).is_some() {
            // An own data slot shadows the prototype descriptor. Let ordinary
            // member extraction retain the live (possibly bound) callable.
            return Ok(None);
        }
        let Some((owner, node)) = self.classes.method(lookup, name) else {
            return Ok(None);
        };
        // All source definitions are known, even when a later module statement
        // has not yet initialized its class value. Do not read class tokens here.
        for child in 0..self.classes.definitions.len() {
            self.resolve_class(child)?;
        }
        let signature = self.request_method_with_result(owner, name, node, expected_result)?;
        let mut overridden = false;
        let mut dynamic_result = false;
        let mut void_implementations_proven = method_returns_only_undefined(node);
        let observed_result = call.parent().kind() != SyntaxKind::ExpressionStatement;
        if signature.return_type == Type::Void
            && !signature.is_async
            && signature.generator.is_none()
            && observed_result
            && !void_implementations_proven
        {
            return Err(self.refuse(
                call,
                "observed void method requires a proven undefined return",
            ));
        }
        if !is_super {
            for child in 0..self.classes.definitions.len() {
                if child == index
                    || !self
                        .classes
                        .subclass(&self.classes.definitions[child].name, &class_name)
                {
                    continue;
                }
                if let Some((implementation, node)) = self.classes.method(child, name)
                    && implementation != owner
                {
                    let other = self.request_method(implementation, name, node)?;
                    let base = signature.params.iter().skip(1).collect::<Vec<_>>();
                    let child = other.params.iter().skip(1).collect::<Vec<_>>();
                    let required_extra = child.len() > base.len()
                        && child[base.len()..].iter().any(|parameter| {
                            parameter.r#type != Type::Dyn
                                && !self.optional_storage(&parameter.r#type)
                        });
                    let discarded_result = signature.return_type == Type::Void
                        && call.parent().kind() == SyntaxKind::ExpressionStatement;
                    // An async method and a synchronous method returning the
                    // same Promise have the same caller-visible ABI. Each
                    // implementation still executes with its own throw and
                    // scheduling semantics in the virtual dispatch arm.
                    let matching_promise_results = matches!(signature.return_type, Type::Promise { .. })
                        && other.return_type == signature.return_type
                        && other.generator.is_none()
                        && signature.generator.is_none();
                    let callable_kind_differs = (other.is_async != signature.is_async
                        && !matching_promise_results)
                        || other.generator.is_some() != signature.generator.is_some();
                    if other.return_type == Type::Void {
                        void_implementations_proven &= method_returns_only_undefined(node);
                    }
                    let can_preserve_result = signature.return_type == Type::Void
                        && !signature.is_async
                        && !other.is_async
                        && signature.generator.is_none()
                        && other.generator.is_none()
                        && void_implementations_proven;
                    if other.return_type != signature.return_type
                        && can_preserve_result
                        && !discarded_result
                    {
                        dynamic_result = true;
                    }
                    if required_extra
                        || child.iter().zip(&base).any(|(child, base)| {
                            child.r#type != base.r#type && child.r#type != Type::Dyn
                        })
                        || (callable_kind_differs && !discarded_result)
                        || (other.return_type != signature.return_type
                            && !discarded_result
                            && !can_preserve_result)
                    {
                        return Err(self.refuse(
                            node,
                            &format!(
                                "method override requires a compatible native parameter/result prefix ABI; trailing derived parameters must be optional (method={name}, base={:?}->{:?}, derived={:?}->{:?})",
                                base.iter().map(|parameter| &parameter.r#type).collect::<Vec<_>>(),
                                signature.return_type,
                                child.iter().map(|parameter| &parameter.r#type).collect::<Vec<_>>(),
                                other.return_type,
                            ),
                        ));
                    }
                    overridden = true;
                }
            }
        }
        if overridden
            && signature.return_type == Type::Void
            && !signature.is_async
            && signature.generator.is_none()
            && observed_result
            && !void_implementations_proven
        {
            return Err(self.refuse(
                call,
                "observed void method override requires proven undefined base implementations",
            ));
        }
        let object = if is_super {
            self.this_expression(receiver)?
        } else {
            self.expression(receiver)?
        };
        let object = self.coerce(
            object,
            if overridden {
                self.classes.object(index)
            } else {
                self.classes.object(owner)
            },
            receiver,
        )?;
        let types = signature
            .params
            .iter()
            .skip(1)
            .map(|p| p.r#type.clone())
            .collect::<Vec<_>>();
        let source_arguments = call.arguments().into_iter().collect::<Vec<_>>();
        let mut sequence = Vec::new();
        let (object, method_args) = if !signature.rest && source_arguments.len() > types.len() {
            if source_arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    call,
                    "extra method arguments combined with a spread are not ported",
                ));
            }
            let object_local = self.construction_local(object.ty(), false);
            sequence.push(Stmt::VarDecl {
                local_id: object_local.id.clone(),
                init: object,
                loc: self.loc(receiver),
            });
            let mut args = Vec::with_capacity(types.len());
            for (index, argument) in source_arguments.into_iter().enumerate() {
                if let Some(ty) = types.get(index) {
                    let value = self.expected_call_argument(argument, ty.clone(), true)?;
                    let local = self.construction_local(ty.clone(), false);
                    sequence.push(Stmt::VarDecl {
                        local_id: local.id.clone(),
                        init: value,
                        loc: self.loc(argument),
                    });
                    args.push(self.construction_read(&local, argument));
                } else {
                    sequence.push(Stmt::Expression {
                        expr: self.expression(argument)?,
                        loc: self.loc(argument),
                    });
                }
            }
            (self.construction_read(&object_local, receiver), args)
        } else {
            (
                object,
                self.rest_method_arguments(call, &types, signature.rest)?,
            )
        };
        let args = std::iter::once(object).chain(method_args).collect();
        let result = if overridden {
            Expr::VirtualCall {
                class_name,
                method: name.into(),
                args,
                r#type: if dynamic_result {
                    Type::Dyn
                } else {
                    signature.return_type
                },
                loc: self.loc(call),
            }
        } else {
            Expr::Call {
                callee: signature.name,
                args,
                r#type: signature.return_type,
                loc: self.loc(call),
            }
        };
        Ok(Some(if sequence.is_empty() {
            result
        } else {
            let result_type = result.ty();
            Expr::Sequence {
                stmts: sequence,
                result: Box::new(result),
                r#type: result_type,
                loc: self.loc(call),
            }
        }))
    }
}
