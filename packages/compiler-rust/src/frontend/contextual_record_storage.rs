//! Select an owning contextual layout before a fresh record is published.
use super::*;
use source_frontend::flags::ContextFlags;

fn identifiers(node: Node, out: &mut Vec<Node>) {
    if node.kind() == SyntaxKind::Identifier {
        out.push(node);
    }
    node.for_each_child(&mut |child| {
        identifiers(child, out);
        false
    });
}

fn functions(node: Node, out: &mut Vec<Node>) {
    if matches!(
        node.kind(),
        SyntaxKind::FunctionDeclaration
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::MethodDeclaration
    ) {
        out.push(node);
    }
    node.for_each_child(&mut |child: Node| {
        functions(child, out);
        false
    });
}

fn variable_declarations(node: Node, out: &mut Vec<Node>) {
    if matches!(
        node.kind(),
        SyntaxKind::VariableDeclaration | SyntaxKind::Parameter
    ) {
        out.push(node);
    }
    node.for_each_child(&mut |child: Node| {
        variable_declarations(child, out);
        false
    });
}

fn direct_returns(node: Node, out: &mut Vec<Node>) {
    node.for_each_child(&mut |child: Node| {
        if child.kind() == SyntaxKind::ReturnStatement {
            out.push(child);
        } else if !matches!(
            child.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::MethodDeclaration
                | SyntaxKind::ClassDeclaration
                | SyntaxKind::ClassExpression
        ) {
            direct_returns(child, out);
        }
        false
    });
}

impl Lowerer<'_> {
    /// TypeScript method parameters are bivariant, so a concrete function can
    /// be published through a method whose corresponding slot is optional.
    /// JavaScript does not insert a wrapper at that assignment: omitted
    /// arguments reach the original function as `undefined`. Select that
    /// wider ABI before lowering the closure so the function keeps one
    /// identity and the native boundary does not reject an argument JavaScript
    /// would have delivered.
    fn optional_method_implementation(&self, source: &Type, target: &Type) -> Option<Type> {
        let (
            Type::Func {
                params: source_params,
                ret: source_ret,
                rest: source_rest,
            },
            Type::Func {
                params: target_params,
                ret: target_ret,
                rest: target_rest,
            },
        ) = (source, target)
        else {
            return None;
        };
        if source_rest != target_rest
            || source_params.len() != target_params.len()
            || !self.contextual_result_compatible(source_ret, target_ret)
        {
            return None;
        }
        let mut widened = false;
        for (source, target) in source_params.iter().zip(target_params) {
            if source == target {
                continue;
            }
            let Type::Union { union_id } = target else {
                return None;
            };
            let arms = &self.unions[*union_id].arms;
            if !arms.contains(&Type::Undefined)
                || !arms.iter().all(|arm| {
                    *arm == Type::Undefined || self.contextual_result_compatible(source, arm)
                })
            {
                return None;
            }
            widened = true;
        }
        widened.then(|| target.clone())
    }

    /// `satisfies` keeps a literal's narrow checker type, but a fresh object
    /// still has one runtime identity.  When its contract has a represented
    /// closed-record layout, construct the object in that owning layout from
    /// the start.  This is especially important for readonly tuple literals:
    /// turning an already-published tuple record into an array would require a
    /// second allocation, while contextual construction can use the array
    /// storage selected by the contract without copying anything.
    fn plan_satisfies_record_storage(&mut self, files: &[Node]) {
        let mut declarations = Vec::new();
        for file in files {
            variable_declarations(*file, &mut declarations);
        }
        for declaration in declarations {
            if declaration.kind() != SyntaxKind::VariableDeclaration
                || declaration.name().kind() != SyntaxKind::Identifier
                || !declaration.type_().is_nil()
            {
                continue;
            }
            let initializer = declaration.initializer();
            if initializer.is_nil() || initializer.kind() != SyntaxKind::SatisfiesExpression {
                continue;
            }
            let mut literal = initializer.expression();
            while matches!(
                literal.kind(),
                SyntaxKind::ParenthesizedExpression
                    | SyntaxKind::AsExpression
                    | SyntaxKind::TypeAssertionExpression
                    | SyntaxKind::NonNullExpression
            ) {
                literal = literal.expression();
            }
            if literal.kind() != SyntaxKind::ObjectLiteralExpression {
                continue;
            }
            let contract_id = self
                .checker
                .get_type_from_type_node_exported(initializer.type_());
            let Some(contract @ Type::Record { shape_id }) = self.type_id(contract_id) else {
                continue;
            };
            let shape = &self.records[shape_id];
            if shape.tuple
                || shape.index_value.is_some()
                || self.callables.contains_key(&shape_id)
                || self.enum_shape(shape_id)
                || self.is_data_view(&contract)
            {
                continue;
            }
            let source_id = self.checker.get_type_at_location(initializer.expression());
            if !self.checker.is_type_assignable_to(source_id, contract_id) {
                continue;
            }
            let symbol = self.symbol(declaration.name());
            if symbol != 0 {
                self.contextual_record_storage.insert(symbol, contract);
            }
        }
    }

    /// A fresh local record may be passed to a wider optional parameter view
    /// while still retaining additional fields for other consumers. Select one
    /// owning shape that keeps the full width and widens only the affected
    /// field slots. This preserves identity and makes later writes through
    /// either view sound; no call-boundary copy is introduced.
    fn plan_widened_argument_records(&mut self, files: &[Node]) {
        let mut declarations = Vec::new();
        let mut names = Vec::new();
        for file in files {
            variable_declarations(*file, &mut declarations);
            identifiers(*file, &mut names);
        }
        let mut names_by_symbol = HashMap::<u32, Vec<Node>>::new();
        for name in names {
            let symbol = self.symbol(name);
            if symbol != 0 {
                names_by_symbol.entry(symbol).or_default().push(name);
            }
        }
        for declaration in declarations {
            let parameter = declaration.kind() == SyntaxKind::Parameter;
            let initial = declaration.initializer();
            if declaration.name().kind() != SyntaxKind::Identifier {
                continue;
            }
            if !parameter
                && ((!declaration.type_().is_nil() && !parameter_abi::is_javascript(declaration))
                    || initial.is_nil()
                    || initial.kind() != SyntaxKind::ObjectLiteralExpression)
            {
                continue;
            }
            let symbol = self.symbol(declaration.name());
            if symbol == 0 {
                continue;
            }
            let source = if parameter {
                self.js_parameter_types.get(&symbol).cloned()
            } else {
                self.contextual_record_storage.get(&symbol).cloned()
            };
            let source = if let Some(source) = source {
                source
            } else {
                let source_id = self.checker.get_type_at_location(declaration.name());
                let Some(source) = self.type_id(source_id) else {
                    continue;
                };
                source
            };
            let Type::Record { shape_id } = source else {
                continue;
            };
            let source = self.records[shape_id].clone();
            if source.tuple || source.index_value.is_some() {
                continue;
            }
            let mut fields = source.fields.clone();
            let mut changed = false;
            for usage in names_by_symbol.get(&symbol).into_iter().flatten().copied() {
                if usage == declaration.name() {
                    continue;
                }
                let call = usage.parent();
                if call.kind() != SyntaxKind::CallExpression {
                    continue;
                }
                let arguments = call.arguments().into_iter().collect::<Vec<_>>();
                let Some(index) = arguments.iter().position(|argument| *argument == usage) else {
                    continue;
                };
                let callee = receivers::reference_node(call.expression());
                if callee.is_nil() || callee.kind() != SyntaxKind::Identifier {
                    continue;
                }
                let target_symbol = self.symbol(callee);
                if target_symbol == 0 {
                    continue;
                }
                let target = self
                    .checker
                    .sym(source_frontend::prelude::SymbolId(target_symbol));
                let function = target.declarations.iter().copied().find(|declaration| {
                    matches!(
                        declaration.kind(),
                        SyntaxKind::FunctionDeclaration
                            | SyntaxKind::FunctionExpression
                            | SyntaxKind::ArrowFunction
                            | SyntaxKind::MethodDeclaration
                    )
                });
                let Some(function) = function else {
                    continue;
                };
                let parameters = receivers::parameters(function);
                let Some(parameter_node) = parameters.get(index).copied() else {
                    continue;
                };
                let parameter_symbol = self.symbol(parameter_node.name());
                let context = (parameter_symbol != 0)
                    .then(|| self.js_parameter_types.get(&parameter_symbol).cloned())
                    .flatten()
                    .or_else(|| {
                        self.declared(function)
                            .and_then(|hint| hint.params.get(index))
                            .cloned()
                            .flatten()
                    });
                let context = if let Some(context) = context {
                    context
                } else {
                    let parameter_type = self.checker.get_type_at_location(parameter_node);
                    let Some(context) = self.type_id(parameter_type) else {
                        continue;
                    };
                    context
                };
                let target = match context {
                    Type::Record { shape_id } => Some(shape_id),
                    Type::Union { union_id } => {
                        let records = self.unions[union_id]
                            .arms
                            .iter()
                            .filter_map(|arm| match arm {
                                Type::Record { shape_id } => Some(*shape_id),
                                _ => None,
                            })
                            .collect::<Vec<_>>();
                        (records.len() == 1
                            && self.unions[union_id].arms.iter().all(|arm| {
                                matches!(arm, Type::Record { .. } | Type::Null | Type::Undefined)
                            }))
                        .then_some(records[0])
                    }
                    _ => None,
                };
                let Some(target) = target else { continue };
                for target_field in self.records[target].fields.clone() {
                    let Some(field) = fields
                        .iter_mut()
                        .find(|field| field.name == target_field.name)
                    else {
                        continue;
                    };
                    let Type::Union { union_id } = target_field.r#type else {
                        continue;
                    };
                    let arms = &self.unions[union_id].arms;
                    let source_arms = match &field.r#type {
                        Type::Union { union_id } => self.unions[*union_id].arms.clone(),
                        ty => vec![ty.clone()],
                    };
                    if !arms
                        .iter()
                        .any(|arm| matches!(arm, Type::Null | Type::Undefined))
                        || !source_arms.iter().all(|source| {
                            arms.iter().any(|arm| {
                                ir::record_equivalence::equivalent(
                                    source,
                                    arm,
                                    &self.records,
                                    &self.unions,
                                )
                            })
                        })
                    {
                        continue;
                    }
                    if field.r#type != (Type::Union { union_id }) {
                        field.r#type = Type::Union { union_id };
                        changed = true;
                    }
                }
            }
            if !changed {
                continue;
            }
            let target = self
                .records
                .iter()
                .find(|record| {
                    !record.tuple
                        && record.index_value == source.index_value
                        && record.fields == fields
                        && record.declared_order == source.declared_order
                })
                .map(|record| record.id)
                .unwrap_or_else(|| {
                    let id = self.records.len();
                    self.records.push(ir::Record {
                        id,
                        fields,
                        declared_order: source.declared_order,
                        tuple: false,
                        index_value: source.index_value,
                    });
                    id
                });
            let target = Type::Record { shape_id: target };
            if parameter {
                self.js_parameter_types.insert(symbol, target);
            } else {
                self.contextual_record_storage.insert(symbol, target);
            }
        }
    }

    pub(super) fn plan_contextual_record_storage(&mut self, files: &[Node]) {
        self.plan_satisfies_record_storage(files);
        // A declaration contract also supplies the owning layout for a local
        // record published through a returned object. JavaScript inference can
        // call one field `any` even when the public return type is concrete;
        // selecting the contract here lets every later assignment validate
        // against one stable layout instead of freezing that `any` projection.
        for file in files {
            let mut found = Vec::new();
            functions(*file, &mut found);
            for function in found {
                let declared = self.declared(function).and_then(|hint| hint.ret.clone());
                let checked = if declared.is_none() {
                    let signature = self.checker.get_signature_from_declaration(function);
                    (signature.0 != 0)
                        .then(|| self.checker.get_return_type_of_signature(signature))
                        .and_then(|result| self.type_id(result))
                } else {
                    None
                };
                let contract = match declared.or(checked) {
                    Some(Type::Promise { inner }) => *inner,
                    Some(contract) => contract,
                    None => continue,
                };
                let Type::Record { shape_id } = contract else {
                    continue;
                };
                let result = self.records[shape_id].clone();
                if function.body().is_nil() {
                    continue;
                }
                let mut returns = Vec::new();
                direct_returns(function.body(), &mut returns);
                for statement in returns {
                    let expression = statement.expression();
                    if expression.is_nil() {
                        continue;
                    }
                    let mut value = primitives::primitive_source(expression);
                    if value.kind() == SyntaxKind::Identifier {
                        let symbol = self.symbol(value);
                        let declaration = (symbol != 0)
                            .then(|| {
                                self.checker
                                    .sym(source_frontend::prelude::SymbolId(symbol))
                                    .value_declaration
                            })
                            .filter(|declaration| {
                                !declaration.is_nil()
                                    && declaration.kind() == SyntaxKind::VariableDeclaration
                                    && declaration.parent().flags().intersects(NodeFlags::CONST)
                                    && declaration.pos() >= function.body().pos()
                                    && declaration.end() <= function.body().end()
                            });
                        if let Some(declaration) = declaration {
                            let initializer = declaration.initializer();
                            if initializer.is_nil() {
                                continue;
                            }
                            value = primitives::primitive_source(initializer);
                        }
                    }
                    if value.kind() != SyntaxKind::ObjectLiteralExpression {
                        continue;
                    }
                    for property in value.properties() {
                        if !matches!(
                            property.kind(),
                            SyntaxKind::PropertyAssignment
                                | SyntaxKind::ShorthandPropertyAssignment
                        ) {
                            continue;
                        }
                        let Some(name) = self.data_property_name(property.name()) else {
                            continue;
                        };
                        let Some(field) = result.fields.iter().find(|field| field.name == name)
                        else {
                            continue;
                        };
                        let source = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                            property.name()
                        } else {
                            primitives::primitive_source(property.initializer())
                        };
                        if source.kind() != SyntaxKind::Identifier {
                            continue;
                        }
                        let symbol = self.symbol(source);
                        if symbol == 0 {
                            continue;
                        }
                        let declaration = self
                            .checker
                            .sym(source_frontend::prelude::SymbolId(symbol))
                            .value_declaration;
                        if !declaration.is_nil()
                            && declaration.kind() == SyntaxKind::FunctionDeclaration
                            && matches!(&field.r#type, Type::Func { .. })
                        {
                            let source_id = self.checker.get_type_at_location(source);
                            let Some(source_type) = self.type_id(source_id) else {
                                continue;
                            };
                            if std::env::var_os("SCRIPTC_TRACE_CONTEXTUAL_STORAGE").is_some() {
                                eprintln!(
                                    "scriptc: returned method {} source={source_type:?} target={:?}",
                                    source.text(),
                                    field.r#type
                                );
                            }
                            let Some(target) =
                                self.optional_method_implementation(&source_type, &field.r#type)
                            else {
                                continue;
                            };
                            match self.contextual_record_storage.entry(symbol) {
                                std::collections::hash_map::Entry::Vacant(entry) => {
                                    entry.insert(target);
                                }
                                std::collections::hash_map::Entry::Occupied(entry)
                                    if entry.get() != &target =>
                                {
                                    entry.remove();
                                }
                                _ => {}
                            }
                            continue;
                        }
                        if !matches!(&field.r#type, Type::Record { .. }) {
                            continue;
                        }
                        if declaration.is_nil()
                            || declaration.kind() != SyntaxKind::VariableDeclaration
                            || !declaration.type_().is_nil()
                            || declaration.initializer().kind()
                                != SyntaxKind::ObjectLiteralExpression
                            || declaration.pos() < function.body().pos()
                            || declaration.end() > function.body().end()
                        {
                            continue;
                        }
                        match self.contextual_record_storage.entry(symbol) {
                            std::collections::hash_map::Entry::Vacant(entry) => {
                                entry.insert(field.r#type.clone());
                            }
                            std::collections::hash_map::Entry::Occupied(entry)
                                if entry.get() != &field.r#type =>
                            {
                                entry.remove();
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        for file in files {
            let mut candidates = HashMap::new();
            for statement in file.statements() {
                if statement.kind() != SyntaxKind::VariableStatement
                    || statement.modifier_flags().intersects(ModifierFlags::EXPORT)
                {
                    continue;
                }
                let list = statement.declaration_list();
                if !list.flags().intersects(NodeFlags::CONST) {
                    continue;
                }
                for declaration in list.declarations().nodes() {
                    if declaration.name().kind() != SyntaxKind::Identifier
                        || !declaration.type_().is_nil()
                        || declaration.initializer().is_nil()
                        || declaration.initializer().kind() != SyntaxKind::ObjectLiteralExpression
                    {
                        continue;
                    }
                    let symbol = self.symbol(declaration.name());
                    if symbol != 0 {
                        candidates.insert(symbol, (declaration, Vec::new()));
                    }
                }
            }
            if candidates.is_empty() {
                continue;
            }
            let names = candidates
                .values()
                .map(|(decl, _)| decl.name().text().to_string())
                .collect::<HashSet<_>>();
            let mut all = Vec::new();
            identifiers(*file, &mut all);
            for name in all {
                if !names.contains(name.text()) {
                    continue;
                }
                let symbol = self.symbol(name);
                if let Some((decl, uses)) = candidates.get_mut(&symbol)
                    && name != decl.name()
                {
                    uses.push(name);
                }
            }
            for (symbol, (declaration, uses)) in candidates {
                let [usage] = uses.as_slice() else { continue };
                let array = usage.parent();
                if array.kind() != SyntaxKind::ArrayLiteralExpression
                    || array.parent().kind() != SyntaxKind::CallExpression
                    || !array
                        .parent()
                        .arguments()
                        .into_iter()
                        .any(|arg| arg == array)
                {
                    continue;
                }
                let context = self.checker.get_contextual_type(*usage, ContextFlags::NONE);
                let source = self.checker.get_type_at_location(*usage);
                if context.0 == 0 || !self.checker.is_type_assignable_to(source, context) {
                    continue;
                }
                let Some(target @ Type::Record { shape_id }) = self.type_id(context) else {
                    continue;
                };
                let shape = &self.records[shape_id];
                if shape.tuple
                    || shape.index_value.is_some()
                    || self.callables.contains_key(&shape_id)
                    || self.enum_shape(shape_id)
                    || self.is_data_view(&target)
                    || !declaration
                        .initializer()
                        .properties()
                        .into_iter()
                        .all(|property| {
                            self.data_property_name(property.name())
                                .is_some_and(|name| {
                                    shape.fields.iter().any(|field| field.name == name)
                                })
                        })
                {
                    continue;
                }
                self.contextual_record_storage.insert(symbol, target);
            }
        }
        // Parameter layouts feed local argument layouts and vice versa. Two
        // monotone passes are enough for the direct-call edge represented here.
        self.plan_widened_argument_records(files);
        self.plan_widened_argument_records(files);
    }
}
