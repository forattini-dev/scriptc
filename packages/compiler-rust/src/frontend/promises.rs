//! Standard Promise identities and synchronous factories; reactions stay queued.
use super::*;
use source_frontend::prelude::{SignatureKind, SymbolId, get_source_file_of_node};

fn dynamic_module_may_export_then(call: Node, specifier: Node) -> bool {
    let target = modules::resolved_dynamic_target(get_source_file_of_node(call), specifier);
    !target.is_nil()
        && target.statements().into_iter().any(|statement| {
            statement.kind() == SyntaxKind::FunctionDeclaration
                && !statement.name().is_nil()
                && statement.name().text() == "then"
        })
}

impl Lowerer<'_> {
    /// Resolve an already initialized, immutable local builtin specifier.
    /// Restrict this to an earlier statement in the same block so replacing
    /// the read with its literal cannot bypass the temporal dead zone.
    pub(super) fn static_builtin_import_specifier(&mut self, node: Node) -> Option<Node> {
        if matches!(
            node.kind(),
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
        ) {
            return Some(node);
        }
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::VariableDeclaration
            || declaration.name().kind() != SyntaxKind::Identifier
            || !declaration.parent().flags().intersects(NodeFlags::CONST)
        {
            return None;
        }
        let literal = declaration.initializer();
        if !matches!(
            literal.kind(),
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
        ) || builtins::module(literal.text()).is_none()
        {
            return None;
        }
        let statement = declaration.parent().parent();
        let block = statement.parent();
        if statement.kind() != SyntaxKind::VariableStatement || block.kind() != SyntaxKind::Block {
            return None;
        }
        let mut current = node;
        while current.parent() != block {
            current = current.parent();
            if current.is_nil()
                || matches!(
                    current.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::Constructor
                )
            {
                return None;
            }
        }
        let statements = block.statements().into_iter().collect::<Vec<_>>();
        let declaration_index = statements
            .iter()
            .position(|candidate| *candidate == statement)?;
        let use_index = statements
            .iter()
            .position(|candidate| *candidate == current)?;
        (declaration_index < use_index).then_some(literal)
    }

    pub(super) fn validate_constant_builtin_namespace(
        &mut self,
        declaration: Node,
        name: Node,
        module: &str,
    ) -> Result<(), String> {
        let symbol = self.symbol(name);
        let scope = declaration.parent().parent().parent();
        if symbol == 0 || scope.kind() != SyntaxKind::Block {
            return Err(self.refuse(name, "builtin import namespace scope is not represented"));
        }
        let mut pending = vec![scope];
        while let Some(node) = pending.pop() {
            if node.kind() == SyntaxKind::Identifier && node != name && self.symbol(node) == symbol
            {
                let member = node.parent();
                if member.kind() != SyntaxKind::PropertyAccessExpression
                    || member.expression() != node
                    || !member.question_dot_token().is_nil()
                {
                    return Err(self.refuse(
                        node,
                        "builtin import namespace value needs an owning descriptor",
                    ));
                }
                let member_name = member.name().text();
                if builtins::source(module, member_name).is_none()
                    && builtins::property(module, member_name).is_none()
                    && !(module == "util" && member_name == "promisify")
                {
                    return Err(self.refuse(
                        member,
                        &format!("native builtin member {module}.{member_name} is not ported"),
                    ));
                }
                let consumer = member.parent();
                if consumer.kind() != SyntaxKind::CallExpression
                    || consumer.expression() != member
                    || !consumer.question_dot_token().is_nil()
                {
                    return Err(self.refuse(
                        member,
                        "builtin import member values need an owning descriptor",
                    ));
                }
            }
            node.for_each_child(&mut |child| {
                pending.push(child);
                false
            });
        }
        Ok(())
    }

    fn runtime_file_url_import(&mut self, node: Node) -> bool {
        let node = receivers::reference_node(node);
        if node.kind() != SyntaxKind::PropertyAccessExpression || node.name().text() != "href" {
            return false;
        }
        let call = receivers::reference_node(node.expression());
        if call.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let callee = receivers::reference_node(call.expression());
        if callee.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.native_symbol(callee);
        self.native_functions
            .get(&symbol)
            .is_some_and(|(module, member)| *module == "url" && member == "pathToFileURL")
    }

    pub(super) fn standard_promise_all_call(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression || member.name().text() != "all" {
            return false;
        }
        let receiver = member.expression();
        let symbol = self.symbol(receiver);
        symbol != 0
            && self.checker.sym(SymbolId(symbol)).name.as_ref() == "Promise"
            && self.standard_promise(SymbolId(symbol))
    }

    fn dynamic_import_promise(
        &self,
        call: Node,
        specifier: Node,
        capsule: Expr,
        record: Type,
    ) -> Expr {
        if let Some(index) = self.commonjs_dynamic_import_index(call) {
            return Expr::Intrinsic {
                name: "module.import.cjs".into(),
                args: vec![capsule, self.commonjs_initializer_closure(index, call)],
                r#type: Type::Promise {
                    inner: Box::new(record),
                },
                loc: self.loc(call),
            };
        }
        let target = modules::resolved_dynamic_target(get_source_file_of_node(call), specifier);
        let lazy = (!target.is_nil())
            .then(|| source_file_info(target).file_name.to_string())
            .and_then(|path| self.lazy_modules.get(&path));
        let mut args = vec![capsule];
        let name = if let Some(initializer) = lazy {
            args.push(Expr::Closure {
                fn_name: initializer.clone(),
                captures: vec![],
                r#type: Type::Func {
                    rest: false,
                    params: vec![],
                    ret: Box::new(Type::Void),
                },
                loc: self.loc(call),
            });
            "module.import.lazy"
        } else {
            "module.import.inert"
        };
        Expr::Intrinsic {
            name: name.into(),
            args,
            r#type: Type::Promise {
                inner: Box::new(record),
            },
            loc: self.loc(call),
        }
    }

    pub(super) fn dynamic_import_property(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let awaited = primitives::primitive_source(node.expression());
        if awaited.kind() != SyntaxKind::AwaitExpression {
            return Ok(None);
        }
        let import_call = primitives::primitive_source(awaited.expression());
        if import_call.kind() != SyntaxKind::CallExpression
            || import_call.expression().kind() != SyntaxKind::ImportKeyword
        {
            return Ok(None);
        }
        let args = import_call.arguments().into_iter().collect::<Vec<_>>();
        let [specifier] = args.as_slice() else {
            return Err(self.refuse(
                import_call,
                "dynamic import requires one literal module specifier",
            ));
        };
        if !matches!(
            specifier.kind(),
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
        ) {
            return Err(self.refuse(*specifier, "dynamic import specifier must be literal"));
        }
        if !self.is_async_function {
            return Err(self.refuse(awaited, "dynamic import property await requires async code"));
        }
        if dynamic_module_may_export_then(import_call, *specifier) {
            return Err(self.refuse(
                import_call,
                "dynamic import with a then export needs namespace Promise assimilation",
            ));
        }

        let promise_id = self.checker.get_type_at_location(import_call);
        let type_args = self.checker.get_type_arguments(promise_id).to_vec();
        let [namespace_id] = type_args.as_slice() else {
            return Err(self.refuse(import_call, "dynamic import has no namespace type argument"));
        };
        let properties = self.checker.get_properties_of_type(*namespace_id).to_vec();
        if properties
            .iter()
            .any(|symbol| self.checker.sym(*symbol).name.as_ref() == "then")
        {
            return Err(self.refuse(
                import_call,
                "dynamic import with a then export needs namespace Promise assimilation",
            ));
        }
        let export = node.name().text().to_string();
        let Some(mut symbol) = properties
            .iter()
            .copied()
            .find(|symbol| self.checker.sym(*symbol).name.as_ref() == export)
        else {
            return Err(self.refuse(
                node.name(),
                &format!("dynamic import export {export:?} was not resolved"),
            ));
        };
        if self
            .checker
            .sym(symbol)
            .flags
            .intersects(SymbolFlags::ALIAS)
        {
            symbol = self.checker.get_aliased_symbol(symbol);
        }
        let declaration = self.checker.sym(symbol).value_declaration;
        if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && !declaration.parent().flags().contains(NodeFlags::CONST)
        {
            return Err(self.refuse(
                node,
                "dynamic import of mutable export requires a live binding",
            ));
        }
        let class = if !declaration.is_nil() && declaration.kind() == SyntaxKind::ClassDeclaration {
            self.class_value(declaration.name())?
        } else {
            None
        };
        let (export_value, export_type) = if let Some(value) = class {
            let ty = value.ty();
            (value, ty)
        } else if let Some(signature) =
            self.request_function(symbol.0, node, functions::UseKind::Value)?
        {
            let function_type = Type::Func {
                rest: signature.rest,
                params: signature
                    .params
                    .iter()
                    .map(|parameter| parameter.r#type.clone())
                    .collect(),
                ret: Box::new(signature.return_type.clone()),
            };
            (
                Expr::Closure {
                    fn_name: signature.name,
                    captures: vec![],
                    r#type: function_type.clone(),
                    loc: self.loc(node),
                },
                function_type,
            )
        } else {
            let value = self.expression(node.name()).map_err(|error| {
                format!("{error}; while reading dynamic import export {export:?}")
            })?;
            let ty = value.ty();
            (value, ty)
        };
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields: vec![ir::Field {
                name: export.clone(),
                r#type: export_type.clone(),
            }],
            declared_order: vec![export.clone()],
            tuple: false,
            index_value: None,
        });
        let record_type = Type::Record { shape_id };
        let capsule = Expr::RecordLit {
            null_prototype: false,
            fields: vec![ir::FieldInit {
                name: export.clone(),
                value: export_value,
                absent: false,
                overflow: false,
            }],
            r#type: record_type.clone(),
            loc: self.loc(import_call),
        };
        let promise =
            self.dynamic_import_promise(import_call, *specifier, capsule, record_type.clone());
        let namespace = Expr::Await {
            value: Box::new(promise),
            r#type: record_type,
            loc: self.loc(awaited),
        };
        Ok(Some(Expr::RecordGet {
            obj: Box::new(namespace),
            shape_id: format!("r{shape_id}"),
            field: export,
            r#type: export_type,
            loc: self.loc(node),
        }))
    }

    pub(super) fn dynamic_import_call(
        &mut self,
        node: Node,
        expected: Option<&Type>,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression
            || node.expression().kind() != SyntaxKind::ImportKeyword
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let [specifier] = args.as_slice() else {
            return Err(self.refuse(node, "dynamic import requires one literal module specifier"));
        };
        if self.runtime_file_url_import(*specifier) {
            let inner = expected.cloned().unwrap_or(Type::Dyn);
            return Ok(Some(Expr::Intrinsic {
                name: "module.import.missing".into(),
                args: vec![Expr::StrLit {
                    value: "<runtime file URL>".into(),
                    r#type: Type::String,
                    loc: self.loc(*specifier),
                }],
                r#type: Type::Promise {
                    inner: Box::new(inner),
                },
                loc: self.loc(node),
            }));
        }
        if specifier.kind() == SyntaxKind::Identifier {
            let awaited = node.parent();
            let declaration = awaited.parent();
            if awaited.kind() != SyntaxKind::AwaitExpression
                || declaration.kind() != SyntaxKind::VariableDeclaration
                || declaration.initializer() != awaited
                || declaration.name().kind() != SyntaxKind::Identifier
            {
                return Err(self.refuse(
                    *specifier,
                    "dynamic builtin namespace needs a local member-only binding",
                ));
            }
        }
        let resolved_specifier = self
            .static_builtin_import_specifier(*specifier)
            .ok_or_else(|| self.refuse(*specifier, "dynamic import specifier must be literal"))?;
        let specifier = &resolved_specifier;
        if self
            .missing_dynamic_imports
            .contains(&declarations::Key::of(node))
        {
            let inner = expected.cloned().unwrap_or(Type::Dyn);
            return Ok(Some(Expr::Intrinsic {
                name: "module.import.missing".into(),
                args: vec![Expr::StrLit {
                    value: specifier.text().to_string(),
                    r#type: Type::String,
                    loc: self.loc(*specifier),
                }],
                r#type: Type::Promise {
                    inner: Box::new(inner),
                },
                loc: self.loc(node),
            }));
        }
        if dynamic_module_may_export_then(node, *specifier) {
            return Err(self.refuse(
                node,
                "dynamic import with a then export needs namespace Promise assimilation",
            ));
        }
        // A bare `import("./module.js");` observes module evaluation and
        // rejection scheduling, but never observes the fulfilled namespace.
        // Do not manufacture every export merely to discard it. The shared
        // module-import runtime still owns lazy evaluation, caching and the
        // returned promise; its private payload can therefore be undefined.
        if expected.is_none() && node.parent().kind() == SyntaxKind::ExpressionStatement {
            let capsule = Expr::DynFrom {
                value: Box::new(Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                }),
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            return Ok(Some(self.dynamic_import_promise(
                node,
                *specifier,
                capsule,
                Type::Dyn,
            )));
        }
        let declaration = node.parent().parent();
        let direct_destructuring = node.parent().kind() == SyntaxKind::AwaitExpression
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && declaration.name().kind() == SyntaxKind::ObjectBindingPattern;
        let then_chain = expected.is_none()
            && node.parent().kind() == SyntaxKind::PropertyAccessExpression
            && node.parent().name().text() == "then"
            && node.parent().parent().kind() == SyntaxKind::CallExpression;
        if !direct_destructuring && expected.is_none() && !then_chain {
            return Err(self.refuse(node, "dynamic import requires an observed namespace layout"));
        }
        if !direct_destructuring && builtins::module(specifier.text()).is_some() {
            // A whole builtin namespace is compile-time routing information:
            // later `namespace.member(...)` calls dispatch through the native
            // module table. The runtime import still owns Promise scheduling,
            // but no declaration-file namespace object needs to be copied.
            let capsule = Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            };
            return Ok(Some(self.dynamic_import_promise(
                node,
                *specifier,
                capsule,
                Type::Undefined,
            )));
        }
        let promise_id = self.checker.get_type_at_location(node);
        let type_args = self.checker.get_type_arguments(promise_id).to_vec();
        let [namespace_id] = type_args.as_slice() else {
            return Err(self.refuse(node, "dynamic import has no namespace type argument"));
        };
        let properties = self.checker.get_properties_of_type(*namespace_id).to_vec();
        if properties
            .iter()
            .any(|symbol| self.checker.sym(*symbol).name.as_ref() == "then")
        {
            return Err(self.refuse(
                node,
                "dynamic import with a then export needs namespace Promise assimilation",
            ));
        }
        if then_chain {
            let then_call = node.parent().parent();
            let Some(callback) = then_call.arguments().into_iter().next() else {
                return Err(self.refuse(node, "dynamic import then-chain requires a callback"));
            };
            if callback.kind() != SyntaxKind::ArrowFunction {
                return Err(self.refuse(
                    callback,
                    "dynamic import then-chain requires an inline arrow callback",
                ));
            }
            let Some(parameter) = callback.parameters().into_iter().next() else {
                return Err(self.refuse(
                    callback,
                    "dynamic import then-chain requires a namespace parameter",
                ));
            };
            let owner = self.symbol(parameter.name());
            let mut pending = vec![callback.body()];
            let mut names = Vec::new();
            while let Some(current) = pending.pop() {
                if current.kind() == SyntaxKind::PropertyAccessExpression
                    && current.expression().kind() == SyntaxKind::Identifier
                    && self.symbol(current.expression()) == owner
                {
                    let name = current.name().text().to_string();
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
                current.for_each_child(&mut |child| {
                    pending.push(child);
                    false
                });
            }
            if names.len() != 1 {
                return Err(self.refuse(
                    callback,
                    "dynamic import then-chain requires one observed named export",
                ));
            }
            let export = names.remove(0);
            let Some(mut symbol) = properties
                .iter()
                .copied()
                .find(|symbol| self.checker.sym(*symbol).name.as_ref() == export)
            else {
                return Err(self.refuse(
                    callback,
                    &format!("dynamic import export {export:?} was not resolved"),
                ));
            };
            if self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
            {
                symbol = self.checker.get_aliased_symbol(symbol);
            }
            let Some(signature) =
                self.request_function(symbol.0, callback, functions::UseKind::Value)?
            else {
                return Err(self.refuse(
                    callback,
                    "dynamic import then-chain export requires a function value",
                ));
            };
            let export_type = Type::Func {
                rest: signature.rest,
                params: signature
                    .params
                    .iter()
                    .map(|parameter| parameter.r#type.clone())
                    .collect(),
                ret: Box::new(signature.return_type.clone()),
            };
            let shape_id = self.records.len();
            self.records.push(ir::Record {
                id: shape_id,
                fields: vec![ir::Field {
                    name: export.clone(),
                    r#type: export_type.clone(),
                }],
                declared_order: vec![export.clone()],
                tuple: false,
                index_value: None,
            });
            let record = Type::Record { shape_id };
            let capsule = Expr::RecordLit {
                null_prototype: false,
                fields: vec![ir::FieldInit {
                    name: export,
                    value: Expr::Closure {
                        fn_name: signature.name,
                        captures: vec![],
                        r#type: export_type,
                        loc: self.loc(node),
                    },
                    absent: false,
                    overflow: false,
                }],
                r#type: record.clone(),
                loc: self.loc(node),
            };
            return Ok(Some(
                self.dynamic_import_promise(node, *specifier, capsule, record),
            ));
        }
        if !direct_destructuring {
            if let Some(namespace) = expected.filter(|ty| self.namespace_capsule(ty)) {
                let target =
                    modules::resolved_dynamic_target(get_source_file_of_node(node), *specifier);
                if target.is_nil() {
                    return Err(self.refuse(
                        node,
                        "dynamic import namespace has no executable module target",
                    ));
                }
                let capsule = self.namespace_value_for_file(target, node);
                return Ok(Some(self.dynamic_import_promise(
                    node,
                    *specifier,
                    capsule,
                    namespace.clone(),
                )));
            }
            let Some(Type::Record { shape_id }) = expected else {
                return Err(self.refuse(
                    node,
                    "contextual dynamic import requires a record namespace layout",
                ));
            };
            let fields = self.records[*shape_id].fields.clone();
            let commonjs = self.commonjs_dynamic_import_index(node);
            let mut values = Vec::with_capacity(fields.len());
            for field in &fields {
                let export = field.name.clone();
                let Some(mut symbol) = properties
                    .iter()
                    .copied()
                    .find(|symbol| self.checker.sym(*symbol).name.as_ref() == export)
                else {
                    return Err(self.refuse(
                        node,
                        &format!("dynamic import export {export:?} was not resolved"),
                    ));
                };
                if self
                    .checker
                    .sym(symbol)
                    .flags
                    .intersects(SymbolFlags::ALIAS)
                {
                    symbol = self.checker.get_aliased_symbol(symbol);
                }
                let export_declaration = self.checker.sym(symbol).value_declaration;
                if !export_declaration.is_nil()
                    && export_declaration.kind() == SyntaxKind::VariableDeclaration
                    && !export_declaration
                        .parent()
                        .flags()
                        .contains(NodeFlags::CONST)
                {
                    return Err(self.refuse(
                        node,
                        "dynamic import of mutable export requires a live binding",
                    ));
                }
                let value = if let Some(index) = commonjs {
                    let exports = self.commonjs_exports_value(index, node);
                    let value = if export == "default" {
                        exports
                    } else {
                        self.dynamic_get(
                            node,
                            exports,
                            Expr::StrLit {
                                value: export.clone(),
                                r#type: Type::String,
                                loc: self.loc(node),
                            },
                        )
                    };
                    self.coerce(value, field.r#type.clone(), node)?
                } else if !export_declaration.is_nil()
                    && export_declaration.kind() == SyntaxKind::ClassDeclaration
                {
                    self.class_value(export_declaration.name())?
                        .ok_or_else(|| {
                            self.refuse(node, "dynamic import class has no native value")
                        })?
                } else if let Some(signature) =
                    self.request_function(symbol.0, node, functions::UseKind::Value)?
                {
                    let ty = Type::Func {
                        rest: signature.rest,
                        params: signature
                            .params
                            .iter()
                            .map(|parameter| parameter.r#type.clone())
                            .collect(),
                        ret: Box::new(signature.return_type.clone()),
                    };
                    Expr::Closure {
                        fn_name: signature.name,
                        captures: vec![],
                        r#type: ty,
                        loc: self.loc(node),
                    }
                } else if !export_declaration.is_nil() {
                    self.expression(export_declaration.name())
                        .map_err(|error| {
                            format!("{error}; while reading dynamic import export {export:?}")
                        })?
                } else {
                    return Err(self.refuse(
                        node,
                        "dynamic import export has no native value declaration",
                    ));
                };
                let value = self.coerce(value, field.r#type.clone(), node)?;
                values.push(ir::FieldInit {
                    name: export,
                    value,
                    absent: false,
                    overflow: false,
                });
            }
            let record = Type::Record {
                shape_id: *shape_id,
            };
            let capsule = Expr::RecordLit {
                fields: values,
                null_prototype: false,
                r#type: record.clone(),
                loc: self.loc(node),
            };
            return Ok(Some(
                self.dynamic_import_promise(node, *specifier, capsule, record),
            ));
        }
        let mut fields = Vec::new();
        let mut values = Vec::new();
        let native_module = builtins::module(specifier.text());
        let commonjs = self.commonjs_dynamic_import_index(node);
        for element in declaration.name().elements() {
            if element.kind() != SyntaxKind::BindingElement || !element.dot_dot_dot_token().is_nil()
            {
                return Err(self.refuse(
                    element,
                    "dynamic import destructuring requires named exports",
                ));
            }
            let export = element.property_name_or_name().text().to_string();
            let Some(mut symbol) = properties
                .iter()
                .copied()
                .find(|symbol| self.checker.sym(*symbol).name.as_ref() == export)
            else {
                return Err(self.refuse(
                    element,
                    &format!("dynamic import export {export:?} was not resolved"),
                ));
            };
            if self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
            {
                symbol = self.checker.get_aliased_symbol(symbol);
            }
            let native = native_module.filter(|module| builtins::source(module, &export).is_some());
            if let Some(module) = native {
                self.bind_native_function(element.name(), module, &export);
            }
            let declaration = self.checker.sym(symbol).value_declaration;
            if !declaration.is_nil()
                && declaration.kind() == SyntaxKind::VariableDeclaration
                && !declaration.parent().flags().contains(NodeFlags::CONST)
            {
                return Err(self.refuse(
                    element,
                    "dynamic import of mutable export requires a live binding",
                ));
            }
            let class =
                if !declaration.is_nil() && declaration.kind() == SyntaxKind::ClassDeclaration {
                    self.class_value(declaration.name())?
                } else {
                    None
                };
            let value = if let Some(index) = commonjs {
                let exports = self.commonjs_exports_value(index, node);
                let value = if export == "default" {
                    exports
                } else {
                    self.dynamic_get(
                        element,
                        exports,
                        Expr::StrLit {
                            value: export.clone(),
                            r#type: Type::String,
                            loc: self.loc(element),
                        },
                    )
                };
                let expected = self.ty(element.name())?;
                self.coerce(value, expected, element)?
            } else if native.is_some() {
                // Native imports are statically dispatched at their direct call
                // sites. The inert namespace capsule still crosses the Promise
                // boundary so destructuring keeps import()'s async ordering;
                // using the function as a first-class value is refused by the
                // ordinary native-callable value rules.
                Expr::DynFrom {
                    value: Box::new(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(element),
                    }),
                    r#type: Type::Dyn,
                    loc: self.loc(element),
                }
            } else if let Some(value) = class {
                value
            } else if let Some(signature) =
                self.request_function(symbol.0, element, functions::UseKind::Value)?
            {
                let ty = Type::Func {
                    rest: signature.rest,
                    params: signature
                        .params
                        .iter()
                        .map(|param| param.r#type.clone())
                        .collect(),
                    ret: Box::new(signature.return_type.clone()),
                };
                Expr::Closure {
                    fn_name: signature.name,
                    captures: vec![],
                    r#type: ty,
                    loc: self.loc(element),
                }
            } else if !declaration.is_nil() {
                self.expression(declaration.name()).map_err(|error| {
                    format!("{error}; while reading dynamic import export {export:?}")
                })?
            } else {
                return Err(self.refuse(
                    element,
                    "dynamic import export has no native value declaration",
                ));
            };
            let ty = value.ty();
            fields.push(ir::Field {
                name: export.clone(),
                r#type: ty.clone(),
            });
            values.push(ir::FieldInit {
                name: export,
                value,
                absent: false,
                overflow: false,
            });
        }
        let shape_id = self.records.len();
        let declared_order = fields.iter().map(|field| field.name.clone()).collect();
        fields.sort_by(|left, right| left.name.cmp(&right.name));
        self.records.push(ir::Record {
            id: shape_id,
            fields,
            declared_order,
            tuple: false,
            index_value: None,
        });
        let record = Type::Record { shape_id };
        let capsule = Expr::RecordLit {
            fields: values,
            null_prototype: false,
            r#type: record.clone(),
            loc: self.loc(node),
        };
        Ok(Some(
            self.dynamic_import_promise(node, *specifier, capsule, record),
        ))
    }

    pub(super) fn promise_new_expected(
        &mut self,
        node: Node,
        expected: Option<Type>,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::NewExpression {
            return Ok(None);
        }
        let callee = primitives::primitive_source(node.expression());
        if callee.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let symbol = self.symbol(callee);
        if symbol == 0
            || self.checker.sym(SymbolId(symbol)).name.as_ref() != "Promise"
            || !self.standard_promise(SymbolId(symbol))
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let [executor] = args.as_slice() else {
            return Err(self.refuse(node, "Promise constructor requires one executor"));
        };
        let result = expected.unwrap_or(self.ty(node)?);
        let Type::Promise { .. } = &result else {
            return Err(self.refuse(node, "Promise constructor needs a native Promise contract"));
        };
        // JavaScript ignores the Promise executor's return value, but an
        // `async` executor still has a real Promise<void> implementation ABI.
        // Preserve that ABI while keeping ordinary executors on the standard
        // void contract; `promise.construct` discards either call result.
        let executor_return = if executor.modifier_flags().intersects(ModifierFlags::ASYNC) {
            Type::Promise {
                inner: Box::new(Type::Void),
            }
        } else {
            Type::Void
        };
        let executor_type = Type::Func {
            rest: false,
            // Resolve/reject are native callable values. Keeping their slots
            // dynamic preserves JavaScript function identity and routes calls
            // through the standard native dispatcher.
            params: vec![Type::Dyn, Type::Dyn],
            ret: Box::new(executor_return),
        };
        let executor = self.expected_expression(*executor, executor_type)?;
        Ok(Some(Expr::LibCall {
            r#fn: "promise.construct".into(),
            args: vec![executor],
            r#type: result,
            loc: self.loc(node),
        }))
    }

    /// The native protected continuation accepts a straight-line try body in
    /// an async function, with a literal catch result and no finalizer.
    pub(super) fn protected_linear_body(&self, body: Node) -> bool {
        if body.kind() != SyntaxKind::Block {
            return false;
        }
        let region = body.parent();
        if region.kind() != SyntaxKind::TryStatement
            || region.try_block() != body
            || !region.finally_block().is_nil()
            || region.catch_clause().is_nil()
            || !region.catch_clause().variable_declaration().is_nil()
        {
            return false;
        }
        let outer = region.parent();
        let owner = outer.parent();
        let statements = body.statements().into_iter().collect::<Vec<_>>();
        let catches = region
            .catch_clause()
            .block()
            .statements()
            .into_iter()
            .collect::<Vec<_>>();
        let owner_is_async = outer.kind() == SyntaxKind::Block
            && matches!(
                owner.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
            )
            && owner.modifier_flags().intersects(ModifierFlags::ASYNC);
        let outer_statements = outer.statements().into_iter().collect::<Vec<_>>();
        let standard_return = owner_is_async
            && outer_statements.as_slice() == [region]
            && statements
                .last()
                .is_some_and(|s| s.kind() == SyntaxKind::ReturnStatement)
            && statements
                .iter()
                .take(statements.len().saturating_sub(1))
                .all(|s| {
                    matches!(
                        s.kind(),
                        SyntaxKind::VariableStatement
                            | SyntaxKind::ExpressionStatement
                            | SyntaxKind::EmptyStatement
                    )
                })
            && catches.len() == 1
            && catches[0].kind() == SyntaxKind::ReturnStatement
            && !catches[0].expression().is_nil()
            && matches!(
                primitives::primitive_source(catches[0].expression()).kind(),
                SyntaxKind::NumericLiteral
                    | SyntaxKind::StringLiteral
                    | SyntaxKind::TrueKeyword
                    | SyntaxKind::FalseKeyword
            );
        let protected_exit = owner_is_async
            && catches.is_empty()
            && statements.iter().all(|statement| {
                matches!(
                    statement.kind(),
                    SyntaxKind::VariableStatement
                        | SyntaxKind::ExpressionStatement
                        | SyntaxKind::EmptyStatement
                )
            })
            && outer_statements
                .iter()
                .position(|statement| *statement == region)
                .is_some_and(|index| {
                    outer_statements[..index].iter().all(|statement| {
                        matches!(
                            statement.kind(),
                            SyntaxKind::VariableStatement
                                | SyntaxKind::ExpressionStatement
                                | SyntaxKind::EmptyStatement
                        )
                    }) && outer_statements[index + 1..] == [*outer_statements.last().unwrap()]
                        && outer_statements.last().is_some_and(|statement| {
                            if statement.kind() != SyntaxKind::ExpressionStatement {
                                return false;
                            }
                            let call = primitives::primitive_source(statement.expression());
                            let callee = primitives::primitive_source(call.expression());
                            call.kind() == SyntaxKind::CallExpression
                                && callee.kind() == SyntaxKind::PropertyAccessExpression
                                && callee.name().text() == "exit"
                                && primitives::primitive_source(callee.expression()).kind()
                                    == SyntaxKind::Identifier
                                && primitives::primitive_source(callee.expression()).text()
                                    == "process"
                        })
                });
        standard_return || protected_exit
    }
    /// Resume before looking up and invoking a zero-argument string method.
    pub(super) fn nested_await_string_method_return(
        &mut self,
        statement: Node,
        result: &Type,
    ) -> Result<Option<Vec<Stmt>>, String> {
        let call = primitives::primitive_source(statement.expression());
        if call.kind() != SyntaxKind::CallExpression || !call.arguments().is_empty() {
            return Ok(None);
        }
        let member = primitives::primitive_source(call.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !member.question_dot_token().is_nil()
        {
            return Ok(None);
        }
        let await_node = primitives::primitive_source(member.expression());
        if await_node.kind() != SyntaxKind::AwaitExpression {
            return Ok(None);
        }
        let method = member.name().text();
        if !matches!(
            method,
            "trim" | "trimStart" | "trimEnd" | "toLowerCase" | "toUpperCase"
        ) {
            return Ok(None);
        }
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, method, Some("String")) {
            return Ok(None);
        }
        let body = statement.parent();
        let function = body.parent();
        let statements = body.statements().into_iter().collect::<Vec<_>>();
        if *result != Type::String
            || body.kind() != SyntaxKind::Block
            || !matches!(
                function.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
            )
            || !function.modifier_flags().intersects(ModifierFlags::ASYNC)
            || statements.last() != Some(&statement)
            || !statements
                .iter()
                .take(statements.len().saturating_sub(1))
                .all(|item| {
                    matches!(
                        item.kind(),
                        SyntaxKind::VariableStatement
                            | SyntaxKind::ExpressionStatement
                            | SyntaxKind::EmptyStatement
                    )
                })
        {
            return Err(self.refuse(
                call,
                "awaited string method requires a terminal straight-line async return",
            ));
        }
        let awaited = self.terminal_await(await_node, &Type::String)?;
        let resumed = self.construction_local(Type::String, false);
        Ok(Some(vec![
            Stmt::VarDecl {
                local_id: resumed.id.clone(),
                init: awaited,
                loc: self.loc(await_node),
            },
            Stmt::Return {
                value: Some(Expr::StringIntrinsic {
                    method: method.into(),
                    receiver: Box::new(self.construction_read(&resumed, await_node)),
                    args: vec![],
                    r#type: Type::String,
                    loc: self.loc(call),
                }),
                loc: self.loc(statement),
            },
        ]))
    }
    /// Evaluate the function reference before suspending, then invoke that
    /// same function with the resolved argument in the continuation.
    pub(super) fn nested_await_call_return(
        &mut self,
        statement: Node,
        result: &Type,
    ) -> Result<Option<Vec<Stmt>>, String> {
        let call = primitives::primitive_source(statement.expression());
        if call.kind() != SyntaxKind::CallExpression
            || call.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let args = call.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 1
            || primitives::primitive_source(args[0]).kind() != SyntaxKind::AwaitExpression
        {
            return Ok(None);
        }
        let body = statement.parent();
        let statements = body.statements().into_iter().collect::<Vec<_>>();
        let straight_line = body.kind() == SyntaxKind::Block
            && matches!(
                body.parent().kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::IfStatement
            )
            && statements.last() == Some(&statement)
            && statements
                .iter()
                .take(statements.len().saturating_sub(1))
                .all(|item| {
                    matches!(
                        item.kind(),
                        SyntaxKind::VariableStatement
                            | SyntaxKind::ExpressionStatement
                            | SyntaxKind::EmptyStatement
                    )
                });
        if !self.is_async_function || !(body.kind() == SyntaxKind::IfStatement || straight_line) {
            return Err(self.refuse(call, "await in a call requires an async return"));
        }
        let callee = self.expression(call.expression())?;
        let Type::Func {
            params,
            ret,
            rest: false,
        } = callee.ty()
        else {
            return Err(self.refuse(call, "await in a call requires a fixed native function"));
        };
        if params.len() != 1 || *ret != *result || *result == Type::Void {
            return Err(self.refuse(
                call,
                "await in a call requires one matching argument and a represented result",
            ));
        }
        let await_node = primitives::primitive_source(args[0]);
        let awaited = self.terminal_await(await_node, &params[0])?;
        let target = self.construction_local(callee.ty(), false);
        let resumed = self.construction_local(params[0].clone(), false);
        Ok(Some(vec![
            Stmt::VarDecl {
                local_id: target.id.clone(),
                init: callee,
                loc: self.loc(call.expression()),
            },
            Stmt::VarDecl {
                local_id: resumed.id.clone(),
                init: awaited,
                loc: self.loc(await_node),
            },
            Stmt::Return {
                value: Some(Expr::CallValue {
                    callee: Box::new(self.construction_read(&target, call.expression())),
                    args: vec![self.construction_read(&resumed, await_node)],
                    r#type: result.clone(),
                    loc: self.loc(call),
                }),
                loc: self.loc(statement),
            },
        ]))
    }
    /// Split one awaited operand from a terminal arithmetic/string return.
    /// The left operand is snapshotted before suspension when it precedes
    /// the await; a right operand is evaluated only after resumption.
    pub(super) fn nested_await_return(
        &mut self,
        statement: Node,
        result: &Type,
    ) -> Result<Option<Vec<Stmt>>, String> {
        let expression = primitives::primitive_source(statement.expression());
        if let Some(value) = self.terminal_nullish_await(expression, result)? {
            return Ok(Some(vec![Stmt::Return {
                value: Some(value),
                loc: self.loc(statement),
            }]));
        }
        if expression.kind() != SyntaxKind::BinaryExpression {
            return Ok(None);
        }
        let left = primitives::primitive_source(expression.left());
        let right = primitives::primitive_source(expression.right());
        let left_await = left.kind() == SyntaxKind::AwaitExpression;
        let right_await = right.kind() == SyntaxKind::AwaitExpression;
        if !left_await && !right_await {
            return Ok(None);
        }
        let op = match expression.operator_token().kind() {
            SyntaxKind::PlusToken => "+",
            SyntaxKind::MinusToken => "-",
            SyntaxKind::AsteriskToken => "*",
            SyntaxKind::SlashToken => "/",
            SyntaxKind::PercentToken => "%",
            _ => return Ok(None),
        };
        let string_addition = *result == Type::String && op == "+";
        let numeric = *result == Type::F64;
        let body = statement.parent();
        let function = body.parent();
        let statements = body.statements().into_iter().collect::<Vec<_>>();
        if left_await == right_await
            || (!numeric && !string_addition)
            || body.kind() != SyntaxKind::Block
            || !matches!(
                function.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
            )
            || !function.modifier_flags().intersects(ModifierFlags::ASYNC)
            || statements.last() != Some(&statement)
        {
            return Err(self.refuse(expression, "nested await requires one represented operand in a terminal straight-line async return"));
        }
        let (await_node, other_node) = if left_await {
            (left, right)
        } else {
            (right, left)
        };
        let awaited_type = if string_addition {
            self.ty(await_node)?
        } else {
            Type::F64
        };
        let other = if string_addition {
            self.expression(other_node)?
        } else {
            self.expected_expression(other_node, Type::F64)?
        };
        let other_type = other.ty();
        let awaited = self.terminal_await(await_node, &awaited_type)?;
        let resumed = self.construction_local(awaited_type, false);
        let mut body = Vec::new();
        let other = if right_await {
            let snapshot = self.construction_local(other_type, false);
            body.push(Stmt::VarDecl {
                local_id: snapshot.id.clone(),
                init: other,
                loc: self.loc(other_node),
            });
            self.construction_read(&snapshot, other_node)
        } else {
            other
        };
        body.push(Stmt::VarDecl {
            local_id: resumed.id.clone(),
            init: awaited,
            loc: self.loc(await_node),
        });
        let resumed = self.construction_read(&resumed, await_node);
        let (left, right) = if left_await {
            (resumed, other)
        } else {
            (other, resumed)
        };
        let value = if string_addition {
            self.string_addition(left, right, expression)?
        } else {
            Expr::Bin {
                op: op.into(),
                left: Box::new(left),
                right: Box::new(right),
                r#type: Type::F64,
                loc: self.loc(expression),
            }
        };
        body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(statement),
        });
        Ok(Some(body))
    }

    pub(super) fn terminal_nullish_await(
        &mut self,
        expression: Node,
        result: &Type,
    ) -> Result<Option<Expr>, String> {
        let expression = primitives::primitive_source(expression);
        if expression.kind() != SyntaxKind::BinaryExpression
            || expression.operator_token().kind() != SyntaxKind::QuestionQuestionToken
        {
            return Ok(None);
        }
        let awaited = primitives::primitive_source(expression.left());
        let fallback = primitives::primitive_source(expression.right());
        if awaited.kind() != SyntaxKind::AwaitExpression
            || fallback.kind() != SyntaxKind::NullKeyword
            || self.ty(awaited)? != *result
        {
            return Ok(None);
        }
        self.terminal_await(awaited, result).map(Some)
    }

    /// One suspension followed by a simple return can use an owning frame.
    pub(super) fn simple_await_local(&mut self, node: Node) -> bool {
        self.simple_await_declaration(node.parent())
    }
    pub(super) fn simple_await_declaration(&mut self, declaration: Node) -> bool {
        if declaration.kind() != SyntaxKind::VariableDeclaration {
            return false;
        }
        let list = declaration.parent();
        let statement = list.parent();
        let body = statement.parent();
        let function = body.parent();
        if list.declarations().nodes().len() == 1 && self.protected_linear_body(body) {
            return true;
        }
        if declaration.name().kind() != SyntaxKind::Identifier {
            return false;
        }
        if statement.kind() == SyntaxKind::VariableStatement
            && body.kind() == SyntaxKind::Block
            && function.kind() == SyntaxKind::TryStatement
            && function.try_block() == body
            && function.finally_block().is_nil()
            && !function.catch_clause().is_nil()
            && function.catch_clause().variable_declaration().is_nil()
            && list.declarations().nodes().len() == 1
        {
            let outer = function.parent();
            let owner = outer.parent();
            let statements = body.statements().into_iter().collect::<Vec<_>>();
            let catches = function
                .catch_clause()
                .block()
                .statements()
                .into_iter()
                .collect::<Vec<_>>();
            let fallback = catches
                .first()
                .filter(|item| {
                    item.kind() == SyntaxKind::ReturnStatement && !item.expression().is_nil()
                })
                .map(|item| primitives::primitive_source(item.expression()));
            if outer.kind() == SyntaxKind::Block
                && matches!(
                    owner.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                )
                && owner.modifier_flags().intersects(ModifierFlags::ASYNC)
                && outer
                    .statements()
                    .into_iter()
                    .collect::<Vec<_>>()
                    .as_slice()
                    == [function]
                && statements.len() == 2
                && statements[0] == statement
                && statements[1].kind() == SyntaxKind::ReturnStatement
                && !statements[1].expression().is_nil()
                && statements[1].expression().kind() == SyntaxKind::AwaitExpression
                && catches.len() == 1
                && fallback.is_some_and(|item| {
                    matches!(
                        item.kind(),
                        SyntaxKind::NumericLiteral
                            | SyntaxKind::StringLiteral
                            | SyntaxKind::TrueKeyword
                            | SyntaxKind::FalseKeyword
                    )
                })
            {
                return true;
            }
        }
        if statement.kind() != SyntaxKind::VariableStatement
            || body.kind() != SyntaxKind::Block
            || !matches!(
                function.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
            )
            || !function.modifier_flags().intersects(ModifierFlags::ASYNC)
            || list.declarations().nodes().len() != 1
        {
            return false;
        }
        let statements = body.statements().into_iter().collect::<Vec<_>>();
        let Some(index) = statements.iter().position(|item| *item == statement) else {
            return false;
        };
        if statements.len() <= index + 1
            || statements
                .last()
                .is_none_or(|item| item.kind() != SyntaxKind::ReturnStatement)
            || !statements[..index].iter().all(|item| {
                matches!(
                    item.kind(),
                    SyntaxKind::VariableStatement
                        | SyntaxKind::ExpressionStatement
                        | SyntaxKind::EmptyStatement
                        | SyntaxKind::IfStatement
                )
            })
        {
            return false;
        }
        fn supported(lowerer: &mut Lowerer<'_>, node: Node) -> bool {
            match node.kind() {
                SyntaxKind::Identifier => {
                    lowerer.symbol(node) != 0
                        && matches!(
                            lowerer.ty(node),
                            Ok(Type::Dyn
                                | Type::F64
                                | Type::String
                                | Type::Record { .. }
                                | Type::Object { .. })
                        )
                }
                SyntaxKind::NumericLiteral
                | SyntaxKind::StringLiteral
                | SyntaxKind::TrueKeyword
                | SyntaxKind::FalseKeyword => true,
                SyntaxKind::ParenthesizedExpression => supported(lowerer, node.expression()),
                SyntaxKind::PropertyAccessExpression if node.question_dot_token().is_nil() => {
                    supported(lowerer, node.expression())
                }
                SyntaxKind::BinaryExpression
                    if matches!(
                        node.operator_token().kind(),
                        SyntaxKind::PlusToken
                            | SyntaxKind::MinusToken
                            | SyntaxKind::AsteriskToken
                            | SyntaxKind::SlashToken
                            | SyntaxKind::PercentToken
                    ) =>
                {
                    supported(lowerer, node.left()) && supported(lowerer, node.right())
                }
                SyntaxKind::CallExpression => {
                    let callee = primitives::primitive_source(node.expression());
                    let arguments = node.arguments().into_iter().collect::<Vec<_>>();
                    if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                        return false;
                    }
                    let source = lowerer.checker.get_type_at_location(callee);
                    lowerer.number_parser_type(source).is_some() && supported(lowerer, arguments[0])
                }
                _ => false,
            }
        }
        for item in &statements[index + 1..statements.len() - 1] {
            if item.kind() != SyntaxKind::ExpressionStatement {
                return false;
            }
            let effect = item.expression();
            if effect.kind() == SyntaxKind::BinaryExpression
                && effect.operator_token().kind() == SyntaxKind::EqualsToken
            {
                let left = effect.left();
                let target = match left.kind() {
                    SyntaxKind::Identifier => supported(self, left),
                    SyntaxKind::PropertyAccessExpression => {
                        matches!(self.ty(left.expression()), Ok(Type::Record { .. }))
                            && supported(self, left.expression())
                    }
                    _ => false,
                };
                if !target || !supported(self, effect.right()) {
                    return false;
                }
            } else if effect.kind() != SyntaxKind::CallExpression
                || self
                    .ambient_console_member(effect.expression())
                    .or_else(|| self.declared_console_call_member(effect.expression()))
                    .is_none()
                || !effect
                    .arguments()
                    .into_iter()
                    .all(|arg| supported(self, arg))
            {
                return false;
            }
        }
        supported(self, statements.last().unwrap().expression())
    }
    pub(super) fn terminal_await(&mut self, node: Node, result: &Type) -> Result<Expr, String> {
        if node.is_nil() {
            return Err(self.refuse(node, "await continuation lost its syntax node"));
        }
        let operand = node.expression();
        if operand.is_nil() {
            return Err(self.refuse(node, "await continuation has no operand"));
        }
        let dynamic_import = operand.kind() == SyntaxKind::CallExpression
            && operand.expression().kind() == SyntaxKind::ImportKeyword;
        // In `cond ? await import("./mod") : null` the surrounding expression
        // is a nullable union, but the import branch itself still resolves to
        // the namespace arm. Build the namespace Promise with that concrete
        // arm and let the ordinary post-await coercion wrap it back into the
        // contextual union.
        let import_result = if dynamic_import && let Type::Union { union_id } = result {
            let present = self.unions[*union_id]
                .arms
                .iter()
                .filter(|arm| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
                .cloned()
                .collect::<Vec<_>>();
            match present.as_slice() {
                [present] => present.clone(),
                _ => result.clone(),
            }
        } else {
            result.clone()
        };
        let mut promise = if dynamic_import {
            self.dynamic_import_call(operand, Some(&import_result))?
                .ok_or_else(|| self.refuse(operand, "dynamic import was not lowered"))?
        } else if let Some(value) = self.promise_call_expected(
            operand,
            Some(Type::Promise {
                inner: Box::new(if matches!(result, Type::Undefined | Type::Void) {
                    Type::Void
                } else {
                    result.clone()
                }),
            }),
        )? {
            value
        } else {
            self.expression(operand)?
        };
        if !matches!(promise.ty(), Type::Promise { .. } | Type::Dyn) {
            // ECMAScript await performs PromiseResolve even when the operand
            // is an ordinary value or a T | Promise<T> union. Route that
            // owning value through NativeValue: an existing Promise keeps its
            // identity, while a plain value becomes an already-fulfilled one.
            self.refuse_thenable(&promise.ty(), operand)?;
            self.defer_erased_thenable_methods(&promise.ty());
            self.materialize_erased_symbol_methods(&promise.ty())?;
            promise = self.coerce(promise, Type::Dyn, operand)?;
        }
        if promise.ty() == Type::Dyn {
            // JavaScript `await` first performs PromiseResolve: a native
            // Promise is adopted, while an ordinary value becomes an already
            // fulfilled Promise. Keep that operation explicit for erased
            // method results instead of requiring their storage to expose a
            // typed Promise ABI before the suspension boundary.
            promise = Expr::Intrinsic {
                name: "promise.resolve".into(),
                args: vec![promise],
                r#type: Type::Promise {
                    inner: Box::new(Type::Dyn),
                },
                loc: self.loc(operand),
            };
        }
        if node.parent().kind() == SyntaxKind::ExpressionStatement {
            let Type::Promise { inner } = promise.ty() else {
                unreachable!("await operand was normalized to a native Promise")
            };
            // Awaiting for effect observes settlement and rejection only. The
            // checker may expose a large structural payload (for example
            // Bun's ShellOutput), but materializing or projecting that value
            // would be both unnecessary and observably wrong when the source
            // discards it. Preserve the Promise's owning payload ABI through
            // the suspension and let the expression statement drop it.
            return Ok(Expr::Await {
                value: Box::new(promise),
                r#type: *inner,
                loc: self.loc(node),
            });
        }
        let result = match promise.ty() {
            Type::Promise { inner }
                if (self.namespace_capsule(result) || dynamic_import)
                    && matches!(inner.as_ref(), Type::Record { .. }) =>
            {
                *inner
            }
            _ => result.clone(),
        };
        let compatible = match promise.ty() {
            Type::Promise { inner } => {
                *inner == result
                    || *inner == Type::Dyn
                    || result == Type::Dyn
                    || matches!(
                        (inner.as_ref(), &result),
                        (Type::Void, Type::Undefined) | (Type::Undefined, Type::Void)
                    )
                    || ir::record_views::view_pairs(&inner, &result, &self.records, &self.unions)
                        .is_some()
            }
            _ => false,
        };
        if !compatible {
            let source = self.contextual_type_description(&promise.ty());
            let target = self.contextual_type_description(&result);
            let Type::Promise { inner } = promise.ty() else {
                unreachable!("await operand was normalized to a native Promise")
            };
            let awaited = Expr::Await {
                value: Box::new(promise),
                r#type: (*inner).clone(),
                loc: self.loc(node),
            };
            return self.coerce(awaited, result.clone(), node).map_err(|_| {
                self.refuse(
                    node,
                    &format!(
                        "await requires a Promise matching the function result: {source} -> {target}"
                    ),
                )
            });
        }
        Ok(Expr::Await {
            value: Box::new(promise),
            r#type: result,
            loc: self.loc(node),
        })
    }
    pub(super) fn promise_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        let child_promise = symbol.0 != 0
            && self.checker.sym(symbol).name.as_ref() == "PromiseWithChild"
            && self.standard_child_symbol(symbol.0);
        if !child_promise
            && (symbol.0 == 0
                || self.checker.sym(symbol).name.as_ref() != "Promise"
                || !self.standard_promise(symbol))
        {
            return None;
        }
        let args = self.checker.get_type_arguments(id).to_vec();
        if args.len() != 1 {
            return None;
        }
        let flags = self.checker.ty(args[0]).flags;
        let inner = if flags.intersects(TypeFlags::VOID | TypeFlags::NEVER | TypeFlags::UNDEFINED) {
            Type::Void
        } else if flags.intersects(TypeFlags::UNION)
            && self.checker.ty(args[0]).types().iter().any(|arm| {
                self.checker
                    .ty(*arm)
                    .flags
                    .intersects(TypeFlags::VOID | TypeFlags::NEVER | TypeFlags::UNDEFINED)
            })
        {
            // Promise<T | void> has one identity-bearing Promise handle, but
            // its fulfilled payload may be either T or JavaScript undefined.
            // Bare unit arms do not occupy typed IR slots, so retain that
            // payload in NativeValue instead of misclassifying Promise as a
            // structural record with then/catch/finally fields.
            Type::Dyn
        } else if flags.intersects(TypeFlags::NULL) {
            // Unit payloads have native tags, without a bare-unit callable ABI.
            Type::Dyn
        } else {
            self.type_id(args[0]).unwrap_or(Type::Dyn)
        };
        Some(Type::Promise {
            inner: Box::new(inner),
        })
    }
    fn native_thenable(&self, ty: &Type) -> bool {
        match ty {
            Type::Func { .. } | Type::Dyn => true,
            Type::Record { shape_id } => self.callables.contains_key(shape_id),
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .any(|a| self.native_thenable(a)),
            _ => false,
        }
    }
    pub(super) fn refuse_thenable(&self, ty: &Type, _node: Node) -> Result<(), String> {
        let refusal = |detail: &str| {
            format!(
                "SCN1001: {}:0..0: {detail}; native subset only, no fallback",
                self.file
            )
        };
        if self.namespace_capsule(ty)
            || matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.iter().any(|arm| self.namespace_capsule(arm)))
        {
            return Err(refusal(
                "module namespace thenable assimilation requires a native namespace descriptor contract",
            ));
        }
        if let Type::Record { shape_id } = ty
            && self.records[*shape_id]
                .fields
                .iter()
                .any(|f| f.name == "then" && self.native_thenable(&f.r#type))
        {
            return Err(refusal("native thenable assimilation is not ported"));
        }
        Ok(())
    }
    pub(super) fn standard_promise(&self, symbol: SymbolId) -> bool {
        self.checker.sym(symbol).declarations.iter().any(|n| {
            if n.is_nil() {
                return false;
            }
            let info = source_file_info(get_source_file_of_node(*n));
            let path = &info.file_name;
            path.ends_with("/lib.es5.d.ts") || path.ends_with("/lib.es2015.promise.d.ts")
        })
    }
    pub(super) fn promise_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        self.promise_call_expected(node, None)
    }
    pub(super) fn promise_call_expected(
        &mut self,
        node: Node,
        expected: Option<Type>,
    ) -> Result<Option<Expr>, String> {
        if node.is_nil() || node.kind() != SyntaxKind::CallExpression {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = member.expression();
        let symbol = self.symbol(receiver);
        if symbol != 0
            && self.checker.sym(SymbolId(symbol)).name.as_ref() == "Promise"
            && self.standard_promise(SymbolId(symbol))
        {
            if member.name().text() == "race" {
                let args = node.arguments().into_iter().collect::<Vec<_>>();
                let [sequence] = args.as_slice() else {
                    return Err(self.refuse(node, "Promise.race requires one iterable"));
                };
                if sequence.kind() != SyntaxKind::ArrayLiteralExpression
                    || sequence
                        .elements()
                        .into_iter()
                        .any(|element| element.kind() == SyntaxKind::SpreadElement)
                {
                    return Err(self.refuse(
                        *sequence,
                        "native Promise.race requires a fixed array literal",
                    ));
                }
                let inferred = expected.unwrap_or(self.ty(node)?);
                let result = if matches!(inferred, Type::Promise { .. }) {
                    inferred
                } else {
                    // A generic `Promise.race<T>` may erase T at a reachable
                    // native specialization (and the generic object may look
                    // record-shaped to the structural checker). The promise
                    // itself is still an owning native handle; only its
                    // payload view is dynamic.
                    Type::Promise {
                        inner: Box::new(Type::Dyn),
                    }
                };
                let values = sequence
                    .elements()
                    .into_iter()
                    .map(|element| {
                        let value = self.expression(element)?;
                        if !matches!(value.ty(), Type::Promise { .. }) {
                            return Err(self.refuse(
                                element,
                                "Promise.race entries need native Promise storage",
                            ));
                        }
                        Ok(value)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(Some(Expr::Intrinsic {
                    name: "promise.raceArray".into(),
                    args: values,
                    r#type: result,
                    loc: self.loc(node),
                }));
            }
            if member.name().text() == "all" {
                let args = node.arguments().into_iter().collect::<Vec<_>>();
                let [sequence] = args.as_slice() else {
                    return Err(self.refuse(node, "Promise.all requires one tuple literal"));
                };
                if sequence.kind() != SyntaxKind::ArrayLiteralExpression {
                    let requested = expected.unwrap_or(self.ty(node)?);
                    let result = if matches!(&requested, Type::Promise { inner } if matches!(inner.as_ref(), Type::Array { .. }))
                    {
                        requested.clone()
                    } else {
                        // Unchecked JavaScript commonly accumulates an empty
                        // array with push() before Promise.all. The checker can
                        // expose a tuple/record-like or erased result even
                        // though the runtime contract is still a homogeneous
                        // owning array of resolved values.
                        Type::Promise {
                            inner: Box::new(Type::Array {
                                elem: Box::new(Type::Dyn),
                            }),
                        }
                    };
                    let Type::Promise { inner } = &result else {
                        unreachable!()
                    };
                    let Type::Array { elem: result_elem } = inner.as_ref() else {
                        unreachable!()
                    };
                    let values = self.expression(*sequence)?;
                    let Type::Array { elem } = values.ty() else {
                        return Err(self.refuse(
                            *sequence,
                            "dynamic Promise.all input needs a native promise array",
                        ));
                    };
                    let Type::Promise { inner: source_elem } = elem.as_ref() else {
                        // Promise.all applies Promise.resolve to every iterable
                        // entry. A dynamically accumulated array may therefore
                        // mix plain payloads and native Promise handles; retain
                        // each owning value and perform that resolution in the
                        // Rust runtime.
                        let combined = Expr::Intrinsic {
                            name: "promise.allValuesInput".into(),
                            args: vec![values],
                            r#type: result.clone(),
                            loc: self.loc(node),
                        };
                        return Ok(Some(if result == requested {
                            combined
                        } else {
                            self.coerce(combined, requested, node)?
                        }));
                    };
                    if source_elem.as_ref() != result_elem.as_ref()
                        && result_elem.as_ref() != &Type::Dyn
                        && !matches!(
                            (source_elem.as_ref(), result_elem.as_ref()),
                            (Type::Void, Type::Undefined) | (Type::Undefined, Type::Void)
                        )
                    {
                        return Err(self.refuse(
                            node,
                            "dynamic Promise.all input/result element layouts differ",
                        ));
                    }
                    let combined = Expr::Intrinsic {
                        name: "promise.allInput".into(),
                        args: vec![values],
                        r#type: result.clone(),
                        loc: self.loc(node),
                    };
                    return Ok(Some(if result == requested {
                        combined
                    } else {
                        self.coerce(combined, requested, node)?
                    }));
                }
                if sequence
                    .elements()
                    .into_iter()
                    .any(|element| element.kind() == SyntaxKind::SpreadElement)
                {
                    return Err(self.refuse(
                        *sequence,
                        "native heterogeneous Promise.all requires a fixed array literal",
                    ));
                }
                let result = expected.unwrap_or(self.ty(node)?);
                let Type::Promise { inner } = &result else {
                    return Err(self.refuse(node, "Promise.all needs a native Promise result"));
                };
                if inner.as_ref() == &Type::Dyn {
                    let values = sequence
                        .elements()
                        .into_iter()
                        .map(|element| {
                            let value = self.expression(element)?;
                            if matches!(value.ty(), Type::Promise { .. }) {
                                return Ok::<Expr, String>(value);
                            }
                            let value = self.coerce(value, Type::Dyn, element)?;
                            Ok::<Expr, String>(Expr::Intrinsic {
                                name: "promise.resolve".into(),
                                args: vec![value],
                                r#type: Type::Promise {
                                    inner: Box::new(Type::Dyn),
                                },
                                loc: self.loc(element),
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    return Ok(Some(Expr::Intrinsic {
                        name: "promise.allDiscard".into(),
                        args: values,
                        r#type: result,
                        loc: self.loc(node),
                    }));
                }
                if let Type::Array { elem } = inner.as_ref() {
                    let values = sequence
                        .elements()
                        .into_iter()
                        .map(|element| {
                            self.expected_expression(
                                element,
                                Type::Promise {
                                    inner: elem.clone(),
                                },
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    return Ok(Some(Expr::Intrinsic {
                        name: "promise.allArray".into(),
                        args: values,
                        r#type: result,
                        loc: self.loc(node),
                    }));
                }
                let Type::Record { shape_id } = inner.as_ref() else {
                    return Err(self.refuse(
                        node,
                        "heterogeneous Promise.all result needs a fixed native tuple",
                    ));
                };
                let tuple = self.records[*shape_id].clone();
                if !tuple.tuple {
                    return Err(self.refuse(
                        node,
                        "heterogeneous Promise.all result is not a native tuple",
                    ));
                }
                let elements = sequence.elements().into_iter().collect::<Vec<_>>();
                if elements.len() != tuple.declared_order.len() {
                    return Err(
                        self.refuse(*sequence, "Promise.all input/result tuple lengths differ")
                    );
                }
                let values = elements
                    .into_iter()
                    .zip(&tuple.declared_order)
                    .map(|(element, name)| {
                        let field = tuple
                            .fields
                            .iter()
                            .find(|field| &field.name == name)
                            .expect("tuple declared field");
                        self.expected_expression(
                            element,
                            Type::Promise {
                                inner: Box::new(field.r#type.clone()),
                            },
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(Some(Expr::Intrinsic {
                    name: "promise.allTuple".into(),
                    args: values,
                    r#type: result,
                    loc: self.loc(node),
                }));
            }
            if member.name().text() == "reject" {
                let args = node.arguments().into_iter().collect::<Vec<_>>();
                if args.len() > 1 {
                    return Err(self.refuse(node, "Promise.reject extra arguments are not ported"));
                }
                let result = expected.unwrap_or(self.ty(node)?);
                if !matches!(result, Type::Promise { .. }) {
                    return Err(self.refuse(node, "Promise.reject needs a native Promise contract"));
                }
                let value = if let Some(reason) = args.first() {
                    let value = self.expression(*reason)?;
                    self.coerce(value, Type::Dyn, *reason)?
                } else {
                    self.coerce(
                        Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: self.loc(node),
                        },
                        Type::Dyn,
                        node,
                    )?
                };
                return Ok(Some(Expr::Intrinsic {
                    name: "promise.reject".into(),
                    args: vec![value],
                    r#type: result,
                    loc: self.loc(node),
                }));
            }
            if member.name().text() != "resolve" {
                return Err(self.refuse(node, "Promise static method is not ported"));
            }
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            if args.len() > 1 {
                return Err(self.refuse(node, "Promise.resolve extra arguments are not ported"));
            }
            let contextual = expected.is_some();
            let mut result = match expected {
                Some(ty) => ty,
                None => self.ty(node)?,
            };
            if !contextual && !matches!(result, Type::Promise { .. }) {
                let id = self.checker.get_type_at_location(node);
                let symbol = self.checker.ty(id).symbol();
                if symbol.0 != 0
                    && self.checker.sym(symbol).name.as_ref() == "Promise"
                    && self.standard_promise(symbol)
                    && self.checker.get_type_arguments(id).len() == 1
                {
                    // A checker-known Promise may have a payload whose class
                    // layout cannot be named at this call site. Keep its
                    // owning Promise identity and check the payload at use.
                    result = Type::Promise {
                        inner: Box::new(Type::Dyn),
                    };
                }
            }
            if !matches!(result, Type::Promise { .. }) {
                return Err(self.refuse(node, "Promise.resolve needs a native Promise contract"));
            }
            let Type::Promise { inner: payload } = &result else {
                unreachable!()
            };
            let mut values = args
                .into_iter()
                .map(|arg| {
                    let source = self.ty(arg)?;
                    self.refuse_thenable(&source, arg)?;
                    if contextual
                        && !matches!(**payload, Type::Void | Type::Undefined)
                        && !matches!(source, Type::Promise { .. } | Type::Null | Type::Undefined)
                    {
                        self.expected_expression(arg, (**payload).clone())
                    } else {
                        self.expression(arg)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            if values
                .first()
                .is_some_and(|value| matches!(value.ty(), Type::Promise { .. }))
            {
                return self.coerce(values.remove(0), result, node).map(Some);
            }
            if values
                .first()
                .is_some_and(|value| matches!(value.ty(), Type::Null | Type::Undefined))
            {
                let value = values.remove(0);
                values.push(self.coerce(value, Type::Dyn, node)?);
            }
            if let Some(value) = values.first() {
                self.refuse_thenable(&value.ty(), node)?;
            }
            let inner = values.first().map(Expr::ty).unwrap_or(Type::Void);
            let ty = Type::Promise {
                inner: Box::new(inner),
            };
            let value = Expr::Intrinsic {
                name: "promise.resolve".into(),
                args: values,
                r#type: ty,
                loc: self.loc(node),
            };
            return self.coerce(value, result, node).map(Some);
        }
        let checked_receiver = self.ty(receiver).ok();
        let method = member.name().text();
        let promise_method = matches!(method, "then" | "catch" | "finally");
        let represented_promise = matches!(checked_receiver, Some(Type::Promise { .. }))
            || promise_method && matches!(checked_receiver, Some(Type::Dyn)) && {
                // JavaScript declarations often expose a fluent result as
                // `any` even when lowering the call proves an owning
                // Promise. Probe on an isolated graph, then lower the real
                // receiver exactly once below.
                let mut probe = self.diagnostic_fork();
                probe
                    .expression(receiver)
                    .is_ok_and(|value| matches!(value.ty(), Type::Promise { .. }))
            };
        if !represented_promise {
            return Ok(None);
        }
        if !promise_method {
            return Err(self.refuse(node, "Promise method is not ported"));
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let max_args = if matches!(method, "catch" | "finally") {
            1
        } else {
            2
        };
        if args.len() > max_args {
            return Err(self.refuse(
                node,
                &format!("Promise.{method} extra arguments are not ported"),
            ));
        }
        if matches!(method, "catch" | "finally") || args.len() == 2 {
            self.ensure_exception_classes(node)?;
        }
        let native_fetch = self.ambient_fetch_call(receiver);
        let recv = self.expression(receiver)?;
        let source_inner = if native_fetch {
            // Response is an identity-bearing host handle. A declaration
            // projection collected in the checked graph must never turn its
            // Promise payload into a structural record in the execution graph.
            // Every Response property is selected dynamically from the same
            // NativeValue::HttpResponse identity.
            Box::new(Type::Dyn)
        } else {
            match recv.ty() {
                Type::Promise { inner } => inner,
                // Some host promises intentionally remain erased while their
                // recursive payload is projected only after await (notably
                // fetch/Response). The checker still proves the receiver's
                // Promise contract, and Dyn owns the same NativeValue::Promise.
                Type::Dyn => match checked_receiver.as_ref() {
                    Some(Type::Promise { inner }) => inner.clone(),
                    _ => {
                        return Err(
                            self.refuse(receiver, "Promise receiver has no owning native contract")
                        );
                    }
                },
                _ => {
                    return Err(
                        self.refuse(receiver, "Promise receiver has no owning native contract")
                    );
                }
            }
        };
        let recv = self.coerce(recv, Type::Dyn, receiver)?;
        if method == "finally" {
            let callback = if let Some(arg) = args.first().copied() {
                if matches!(
                    arg.kind(),
                    SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
                ) {
                    let id = self.checker.get_type_at_location(arg);
                    let signatures = self.checker.get_signatures_of_type(id, SignatureKind::CALL);
                    if signatures.len() != 1 {
                        return Err(self.refuse(arg, "Promise finally signature is not ported"));
                    }
                    let result = self.checker.get_return_type_of_signature(signatures[0]);
                    let result = if self
                        .checker
                        .ty(result)
                        .flags
                        .intersects(TypeFlags::VOID | TypeFlags::NEVER)
                    {
                        Type::Void
                    } else {
                        self.type_id(result).unwrap_or(Type::Dyn)
                    };
                    let callback = self.closure(
                        arg,
                        Some(Type::Func {
                            rest: false,
                            params: vec![],
                            ret: Box::new(result),
                        }),
                    )?;
                    self.coerce(callback, Type::Dyn, arg)?
                } else {
                    self.expected_expression(arg, Type::Dyn)?
                }
            } else {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?
            };
            let target = Type::Promise {
                inner: source_inner,
            };
            let value = Expr::DynInvoke {
                recv: Box::new(recv),
                method: "finally".into(),
                callee_name: "Promise.finally".into(),
                optional: false,
                args: vec![callback],
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            let value = self.coerce(value, target, node)?;
            return if let Some(expected) = expected {
                self.coerce(value, expected, node).map(Some)
            } else {
                Ok(Some(value))
            };
        }
        let mut values = Vec::new();
        let mut results = [None, None];
        // `catch(onRejected)` is exactly `then(undefined, onRejected)`.  Keep
        // one native reaction path so both forms have identical scheduling,
        // adoption and identity behavior.
        if method == "catch" {
            values.push(self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                Type::Dyn,
                node,
            )?);
        }
        for (argument_index, arg) in args.into_iter().enumerate() {
            let index = if method == "catch" { 1 } else { argument_index };
            // A Promise<void> callback still receives the JavaScript undefined value.
            if matches!(
                arg.kind(),
                SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
            ) {
                let id = self.checker.get_type_at_location(arg);
                let signatures = self.checker.get_signatures_of_type(id, SignatureKind::CALL);
                if signatures.len() != 1 {
                    return Err(self.refuse(arg, "Promise reaction signature is not ported"));
                }
                let ret = self.checker.get_return_type_of_signature(signatures[0]);
                let checked_ret = self.checker.ty(ret);
                let voidish = checked_ret
                    .flags
                    .intersects(TypeFlags::VOID | TypeFlags::NEVER)
                    || (checked_ret.flags.intersects(TypeFlags::UNION)
                        && checked_ret.types().iter().all(|arm| {
                            self.checker.ty(*arm).flags.intersects(
                                TypeFlags::VOID | TypeFlags::UNDEFINED | TypeFlags::NEVER,
                            )
                        }));
                let ret = if voidish {
                    // Optional calls naturally return void | undefined. Both
                    // arms carry JavaScript undefined, so a Promise reaction
                    // needs no synthetic union payload or dynamic fallback.
                    Type::Void
                } else {
                    let ty = self.type_id(ret).ok_or_else(|| {
                        self.refuse(arg, "Promise reaction result has no native representation")
                    })?;
                    if matches!(ty, Type::Null | Type::Undefined) {
                        Type::Dyn
                    } else {
                        ty
                    }
                };
                self.refuse_thenable(&ret, arg)?;
                let inner = source_inner.clone();
                let param =
                    if index == 1 || matches!(*inner, Type::Void | Type::Null | Type::Undefined) {
                        Type::Dyn
                    } else {
                        *inner
                    };
                if native_fetch
                    && index == 0
                    && let Some(parameter) = arg.parameters().into_iter().next()
                    && parameter.name().kind() == SyntaxKind::Identifier
                {
                    // The checked declaration graph may preserve structural
                    // Response views for individual member reads. The runtime
                    // parameter nevertheless owns one native Response handle;
                    // keep every use of that binding on its dynamic identity.
                    let symbol = self.symbol(parameter.name());
                    if symbol != 0 {
                        self.data_bindings.insert(symbol);
                    }
                }
                let callback = self.closure(
                    arg,
                    Some(Type::Func {
                        rest: false,
                        params: vec![param],
                        ret: Box::new(ret),
                    }),
                )?;
                results[index] = reaction_result(&callback.ty());
                values.push(self.coerce(callback, Type::Dyn, arg)?);
            } else {
                let value = self.expected_expression(arg, Type::Dyn)?;
                results[index] = match &value {
                    Expr::DynFrom { value, .. } => reaction_result(&value.ty()),
                    Expr::UnitLit { .. } => None,
                    _ if self.checker_any(arg) => Some(Type::Dyn),
                    _ => None,
                };
                values.push(value);
            }
        }
        let mut arms = vec![results[0].take().unwrap_or(*source_inner)];
        if let Some(rejected) = results[1].take() {
            arms.push(rejected);
        }
        let mut normalized = Vec::new();
        for arm in arms {
            match arm {
                Type::Void => normalized.push(Type::Undefined),
                Type::Union { union_id } => normalized.extend(self.unions[union_id].arms.clone()),
                arm => normalized.push(arm),
            }
        }
        let inner = self
            .intern_union(normalized)
            .ok_or_else(|| self.refuse(node, "Promise reaction result union is not ported"))?;
        let target = Type::Promise {
            inner: Box::new(if inner == Type::Undefined {
                Type::Void
            } else {
                inner
            }),
        };
        let value = Expr::DynInvoke {
            recv: Box::new(recv),
            method: "then".into(),
            callee_name: format!("Promise.{method}"),
            optional: false,
            args: values,
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        let value = self.coerce(value, target, node)?;
        // The checker may contextually discard a reaction result, producing
        // Promise<void>, even though the concrete callback returns a value
        // (notably a bound JavaScript callback with an erased result).  Keep
        // the same promise identity and install the requested payload view;
        // coercing through Dyn is the standard zero-copy Promise view bridge.
        let value = if let Some(expected) = expected {
            self.coerce(value, expected, node)?
        } else {
            value
        };
        Ok(Some(value))
    }
}

fn reaction_result(ty: &Type) -> Option<Type> {
    let Type::Func { ret, .. } = ty else {
        return None;
    };
    Some(match ret.as_ref() {
        Type::Promise { inner } => (**inner).clone(),
        ret => ret.clone(),
    })
}
