//! An inferred local keeps the owning ABI produced by a represented call.
use super::*;
use source_frontend::prelude::{get_source_file_of_node, get_token_pos_of_node, source_file_text};

#[derive(Clone, Copy)]
enum StorageEvent {
    Declaration(Node),
    Assignment(Node),
    PropertyAssignment(Node),
    ArrayPush(Node, Node),
    ContextualArrayElement(Node, Node),
}

fn local_assignment_operator(kind: SyntaxKind) -> bool {
    kind == SyntaxKind::EqualsToken
        || updates::compound_operator(kind).is_some()
        || matches!(
            kind,
            SyntaxKind::QuestionQuestionEqualsToken
                | SyntaxKind::BarBarEqualsToken
                | SyntaxKind::AmpersandAmpersandEqualsToken
        )
}

fn storage_events(node: Node, root: Node, events: &mut Vec<StorageEvent>) {
    if node != root
        && matches!(
            node.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::MethodDeclaration
                | SyntaxKind::ClassDeclaration
                | SyntaxKind::ClassExpression
        )
    {
        return;
    }
    if node.kind() == SyntaxKind::VariableDeclaration
        && node.name().kind() == SyntaxKind::Identifier
    {
        events.push(StorageEvent::Declaration(node));
    } else if node.kind() == SyntaxKind::BinaryExpression
        && local_assignment_operator(node.operator_token().kind())
        && node.left().kind() == SyntaxKind::Identifier
    {
        events.push(StorageEvent::Assignment(node));
    } else if node.kind() == SyntaxKind::BinaryExpression
        && node.operator_token().kind() == SyntaxKind::EqualsToken
        && node.left().kind() == SyntaxKind::PropertyAccessExpression
        && node.left().expression().kind() == SyntaxKind::Identifier
    {
        events.push(StorageEvent::PropertyAssignment(node));
    } else if node.kind() == SyntaxKind::BinaryExpression
        && node.operator_token().kind() == SyntaxKind::EqualsToken
        && node.left().kind() == SyntaxKind::ElementAccessExpression
        && node.right().kind() == SyntaxKind::Identifier
    {
        events.push(StorageEvent::ContextualArrayElement(
            node.right(),
            node.left().expression(),
        ));
    } else if node.kind() == SyntaxKind::CallExpression {
        let member = node.expression();
        if member.kind() == SyntaxKind::PropertyAccessExpression && member.name().text() == "push" {
            for argument in node.arguments() {
                if argument.kind() != SyntaxKind::SpreadElement {
                    if member.expression().kind() == SyntaxKind::Identifier {
                        events.push(StorageEvent::ArrayPush(member.expression(), argument));
                    }
                    if argument.kind() == SyntaxKind::Identifier {
                        events.push(StorageEvent::ContextualArrayElement(
                            argument,
                            member.expression(),
                        ));
                    }
                }
            }
        }
    }
    node.for_each_child(&mut |child| {
        storage_events(child, root, events);
        false
    });
}

fn storage_roots(node: Node, roots: &mut Vec<Node>) {
    if matches!(
        node.kind(),
        SyntaxKind::FunctionDeclaration
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::MethodDeclaration
            | SyntaxKind::Constructor
    ) && !node.body().is_nil()
    {
        roots.push(node.body());
    }
    node.for_each_child(&mut |child| {
        storage_roots(child, roots);
        false
    });
}

fn captured_assignment_events(
    node: Node,
    root: Node,
    inside_nested_function: bool,
    events: &mut Vec<StorageEvent>,
) {
    let inside_nested_function = inside_nested_function
        || (node != root
            && matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
            ));
    if inside_nested_function
        && node.kind() == SyntaxKind::BinaryExpression
        && local_assignment_operator(node.operator_token().kind())
        && node.left().kind() == SyntaxKind::Identifier
    {
        events.push(StorageEvent::Assignment(node));
    }
    node.for_each_child(&mut |child| {
        captured_assignment_events(child, root, inside_nested_function, events);
        false
    });
}

fn erased_record(
    source: &Type,
    target: &Type,
    records: &[ir::Record],
    active: &mut HashSet<(usize, usize)>,
) -> bool {
    if source == target || *target == Type::Dyn {
        return true;
    }
    let (Type::Record { shape_id: a }, Type::Record { shape_id: b }) = (source, target) else {
        return false;
    };
    let (Some(source), Some(target)) = (records.get(*a), records.get(*b)) else {
        return false;
    };
    if source.tuple
        || target.tuple
        || source.index_value.is_some()
        || target.index_value.is_some()
        || source.fields.len() != target.fields.len()
        || source
            .fields
            .iter()
            .chain(&target.fields)
            .any(|f| f.name == "\0scriptc.call")
    {
        return false;
    }
    if !active.insert((*a, *b)) {
        return true;
    }
    let result = target.fields.iter().all(|field| {
        source
            .fields
            .iter()
            .find(|old| old.name == field.name)
            .is_some_and(|old| erased_record(&old.r#type, &field.r#type, records, active))
    });
    active.remove(&(*a, *b));
    result
}

impl Lowerer<'_> {
    fn indexed_binding_observes_undefined(&mut self, declaration: Node) -> bool {
        fn undefined_like(node: Node) -> bool {
            (node.kind() == SyntaxKind::Identifier && node.text() == "undefined")
                || node.kind() == SyntaxKind::VoidExpression
        }

        fn visit(lowerer: &mut Lowerer<'_>, node: Node, symbol: u32) -> bool {
            if node.kind() == SyntaxKind::BinaryExpression
                && matches!(
                    node.operator_token().kind(),
                    SyntaxKind::EqualsEqualsEqualsToken
                        | SyntaxKind::ExclamationEqualsEqualsToken
                        | SyntaxKind::EqualsEqualsToken
                        | SyntaxKind::ExclamationEqualsToken
                )
            {
                let left = receivers::reference_node(node.left());
                let right = receivers::reference_node(node.right());
                if (left.kind() == SyntaxKind::Identifier
                    && lowerer.symbol(left) == symbol
                    && undefined_like(right))
                    || (right.kind() == SyntaxKind::Identifier
                        && lowerer.symbol(right) == symbol
                        && undefined_like(left))
                {
                    return true;
                }
            }
            let mut found = false;
            node.for_each_child(&mut |child| {
                found = found || visit(lowerer, child, symbol);
                found
            });
            found
        }

        let symbol = self.symbol(declaration.name());
        symbol != 0 && visit(self, get_source_file_of_node(declaration), symbol)
    }

    pub(super) fn plan_record_field_writes(&mut self, files: &[Node]) {
        let mut owners = HashMap::<u32, Type>::new();
        let mut writes = Vec::new();
        for file in files {
            let mut events = Vec::new();
            storage_events(*file, *file, &mut events);
            let mut roots = Vec::new();
            storage_roots(*file, &mut roots);
            for root in roots {
                storage_events(root, root, &mut events);
            }
            for event in events {
                match event {
                    StorageEvent::Declaration(declaration)
                        if !declaration.initializer().is_nil()
                            && receivers::reference_node(declaration.initializer()).kind()
                                == SyntaxKind::ObjectLiteralExpression =>
                    {
                        let symbol = self.symbol(declaration.name());
                        let ty = self
                            .contextual_record_storage
                            .get(&symbol)
                            .cloned()
                            .or_else(|| self.ty(declaration.initializer()).ok())
                            .or_else(|| self.ty(declaration.name()).ok());
                        if matches!(ty, Some(Type::Record { .. })) {
                            owners.insert(symbol, ty.unwrap());
                        }
                    }
                    StorageEvent::PropertyAssignment(assignment) => writes.push(assignment),
                    _ => {}
                }
            }
        }
        let mut parameter_owners = HashSet::new();
        for assignment in &writes {
            let receiver = assignment.left().expression();
            let symbol = self.symbol(receiver);
            if symbol == 0 || owners.contains_key(&symbol) {
                continue;
            }
            let declaration = self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .value_declaration;
            if declaration.is_nil()
                || declaration.kind() != SyntaxKind::Parameter
                || !parameter_abi::is_javascript(declaration)
            {
                continue;
            }
            let ty = self
                .js_parameter_types
                .get(&symbol)
                .cloned()
                .or_else(|| self.ty(receiver).ok());
            if let Some(ty @ Type::Record { .. }) = ty {
                owners.insert(symbol, ty);
                parameter_owners.insert(symbol);
            }
        }
        let initial = owners.clone();
        for assignment in writes {
            let member = assignment.left();
            let symbol = self.symbol(member.expression());
            let Some(Type::Record { shape_id }) = owners.get(&symbol).cloned() else {
                continue;
            };
            let record = self.records[shape_id].clone();
            if record.tuple || record.index_value.is_some() {
                continue;
            }
            let Some(field_index) = record
                .fields
                .iter()
                .position(|field| field.name == member.name().text())
            else {
                continue;
            };
            let Some(value) = self.planned_assignment_value(assignment.right()) else {
                continue;
            };
            let current = record.fields[field_index].r#type.clone();
            let widened = if current == value {
                continue;
            } else if current == Type::Dyn || value == Type::Dyn {
                Type::Dyn
            } else {
                let Some(widened) = self.intern_union(vec![current, value]) else {
                    continue;
                };
                widened
            };
            let mut fields = record.fields.clone();
            fields[field_index].r#type = widened;
            let target = self
                .records
                .iter()
                .find(|candidate| {
                    !candidate.tuple
                        && candidate.index_value == record.index_value
                        && candidate.fields == fields
                        && candidate.declared_order == record.declared_order
                })
                .map(|candidate| candidate.id)
                .unwrap_or_else(|| {
                    let id = self.records.len();
                    self.records.push(ir::Record {
                        id,
                        fields,
                        declared_order: record.declared_order,
                        tuple: false,
                        index_value: record.index_value,
                    });
                    id
                });
            owners.insert(symbol, Type::Record { shape_id: target });
        }
        for (symbol, ty) in owners {
            if initial.get(&symbol) != Some(&ty) {
                if parameter_owners.contains(&symbol) {
                    self.js_parameter_types.insert(symbol, ty);
                } else {
                    self.contextual_record_storage.insert(symbol, ty);
                }
            }
        }
    }

    fn planned_iterable_element(&mut self, node: Node) -> Option<Type> {
        let node = receivers::reference_node(node);
        if node.is_nil() {
            return None;
        }
        if node.kind() == SyntaxKind::CallExpression {
            let member = receivers::reference_node(node.expression());
            if member.kind() == SyntaxKind::PropertyAccessExpression
                && matches!(member.name().text(), "filter" | "slice")
            {
                // Both built-ins preserve the receiver's element ABI. The
                // checker port can accidentally substitute the callback's
                // contextual record here, so follow the source container.
                return self.planned_iterable_element(member.expression());
            }
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if let Some(Type::Array { elem }) = self
                .var_types
                .get(&symbol)
                .or_else(|| self.planned_local_storage.get(&symbol))
                .or_else(|| self.module_vars.get(&symbol))
            {
                return Some((**elem).clone());
            }
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.expression().kind() == SyntaxKind::ThisKeyword
        {
            let mut owner = node.parent();
            while !owner.is_nil()
                && !matches!(
                    owner.kind(),
                    SyntaxKind::MethodDeclaration | SyntaxKind::Constructor
                )
            {
                owner = owner.parent();
            }
            if !owner.is_nil() {
                let class = owner.parent();
                if !matches!(
                    class.kind(),
                    SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                ) {
                    return self.ty(node).ok().and_then(|ty| match ty {
                        Type::Array { elem } => Some(*elem),
                        _ => None,
                    });
                }
                let binding = if class.name().is_nil() {
                    class.parent().name()
                } else {
                    class.name()
                };
                if let Some(class_name) = self.source_class_name(binding) {
                    if let Some(storage) = self.field_type(&class_name, node.name().text()) {
                        let arrays = match storage {
                            Type::Array { elem } => vec![*elem],
                            Type::Union { union_id } => self.unions[union_id]
                                .arms
                                .iter()
                                .filter_map(|arm| match arm {
                                    Type::Array { elem } => Some((**elem).clone()),
                                    _ => None,
                                })
                                .collect(),
                            _ => Vec::new(),
                        };
                        if let [element] = arrays.as_slice() {
                            return Some(element.clone());
                        }
                    }
                }
            }
        }
        match self.ty(node).ok()? {
            Type::Array { elem } => Some(*elem),
            Type::String => Some(Type::String),
            Type::Record { shape_id } if self.records[shape_id].tuple => {
                let fields = self.records[shape_id]
                    .fields
                    .iter()
                    .map(|field| field.r#type.clone())
                    .collect::<Vec<_>>();
                self.intern_union(fields)
            }
            _ => None,
        }
    }

    fn planned_yield_star_value(&mut self, node: Node) -> Option<Type> {
        if node.kind() != SyntaxKind::YieldExpression || node.asterisk_token().is_nil() {
            return None;
        }
        let delegate = receivers::reference_node(node.expression());
        let return_channel = |ty: Type| match ty {
            Type::Generator { return_type, .. } => Some(*return_type),
            _ => None,
        };
        let checker_type = self.checker.get_type_at_location(delegate);
        if let Some(ty) = self.generator_type(checker_type).and_then(return_channel) {
            return Some(ty);
        }
        if delegate.kind() != SyntaxKind::CallExpression {
            return None;
        }
        let member = receivers::reference_node(delegate.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return None;
        }
        let symbol = self.symbol(member.name());
        let declared = (symbol != 0)
            .then(|| {
                self.checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .value_declaration
            })
            .filter(|method| method.kind() == SyntaxKind::MethodDeclaration);
        let method = declared.or_else(|| self.classes.unique_method_node(member.name().text()))?;
        let signature = self.checker.get_signature_from_declaration(method);
        let result = self.checker.get_return_type_of_signature(signature);
        self.generator_type(result).and_then(return_channel)
    }

    /// An inferred local initialized from a represented array lookup owns the
    /// array element ABI. The checker can flow-narrow that lookup (and, inside
    /// callbacks, occasionally expose the receiver ABI instead), but neither
    /// projection changes the native value stored in the local.
    pub(super) fn indexed_initializer_storage(
        &mut self,
        declaration: Node,
    ) -> Result<Option<Type>, String> {
        if !declaration.type_().is_nil() || declaration.initializer().is_nil() {
            return Ok(None);
        }
        let initializer = receivers::reference_node(declaration.initializer());
        if initializer.kind() != SyntaxKind::ElementAccessExpression {
            return Ok(None);
        }
        let receiver = receivers::reference_node(initializer.expression());
        if receiver.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let symbol = self.symbol(receiver);
        let storage = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .map(|local| local.r#type.clone())
            .or_else(|| self.var_types.get(&symbol).cloned());
        match storage {
            Some(Type::Array { elem })
                if matches!(
                    *elem,
                    Type::String | Type::F64 | Type::Bool | Type::Bigint | Type::Symbol
                ) && self.indexed_binding_observes_undefined(declaration) =>
            {
                self.undefined_storage_type(*elem, initializer).map(Some)
            }
            Some(Type::Array { elem }) => Ok(Some(*elem)),
            _ => Ok(None),
        }
    }

    fn numeric_storage(&self, ty: &Type) -> bool {
        match ty {
            Type::F64 | Type::Bigint | Type::Undefined => true,
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.numeric_storage(arm)),
            _ => false,
        }
    }

    fn planned_assignment_value(&mut self, node: Node) -> Option<Type> {
        let node = receivers::reference_node(node);
        if node.is_nil() {
            return None;
        }
        if self.native_computed_symbol_result_call(node) {
            // Computed well-known-symbol protocol calls (notably
            // `iterable[Symbol.asyncIterator]()`) own an erased runtime
            // result. Apply the same rule to later assignments that storage
            // initialization already applies to declaration initializers;
            // asking the checker to synthesize a closed result view here can
            // expose a declaration-less signature sentinel.
            return Some(Type::Dyn);
        }
        let checked = self.checker.get_type_at_location(node);
        if self
            .checker
            .ty(checked)
            .flags
            .intersects(TypeFlags::ANY | TypeFlags::UNKNOWN)
        {
            // A write of an erased value widens the owning slot. Checker
            // context from the old field value may still expose a scalar at
            // this assignment site, but cannot change the runtime payload.
            return Some(Type::Dyn);
        }
        if let Some(ty) = self.planned_yield_star_value(node) {
            return Some(ty);
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if let Some(ty) = self.var_types.get(&symbol).cloned() {
                if let Type::Union { union_id } = &ty
                    && let Ok(projected) = self.ty(node)
                    && !matches!(projected, Type::Null | Type::Undefined | Type::Void)
                    && self.unions[*union_id].arms.contains(&projected)
                {
                    // Planning runs before statement lowering, so it has no
                    // `var_defined` facts yet. The checker still exposes a
                    // point-in-time guard such as `if (value === undefined)
                    // return`; use that proven arm for the value copied into
                    // a fresh aggregate without changing the source cell.
                    return Some(projected);
                }
                return Some(ty);
            }
            let mut ancestor = node.parent();
            while !ancestor.is_nil() {
                if ancestor.kind() == SyntaxKind::ForOfStatement {
                    let head = ancestor.initializer();
                    if head.kind() == SyntaxKind::VariableDeclarationList
                        && let Some(declaration) = head.declarations().nodes().first()
                        && declaration.name().kind() == SyntaxKind::Identifier
                        && declaration.name().text() == node.text()
                        && let Some(element) = self.planned_iterable_element(ancestor.expression())
                    {
                        return Some(element);
                    }
                }
                if matches!(
                    ancestor.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                ) {
                    break;
                }
                ancestor = ancestor.parent();
            }
            if symbol != 0 {
                let declaration = self
                    .checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .value_declaration;
                if !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && declaration.name().kind() == SyntaxKind::Identifier
                {
                    let list = declaration.parent();
                    let loop_node = if list.is_nil() { list } else { list.parent() };
                    if !loop_node.is_nil()
                        && loop_node.kind() == SyntaxKind::ForOfStatement
                        && let Some(element) = self.planned_iterable_element(loop_node.expression())
                    {
                        return Some(element);
                    }
                }
            }
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression && node.name().text() == "length" {
            let receiver = receivers::reference_node(node.expression());
            let represented = if receiver.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(receiver);
                self.var_types.get(&symbol).cloned()
            } else {
                None
            }
            .or_else(|| self.ty(receiver).ok());
            if matches!(
                represented,
                Some(Type::String | Type::Array { .. } | Type::Bytes { .. })
            ) {
                return Some(Type::F64);
            }
        }
        self.numeric_initializer_type(node)
            .or_else(|| self.ty(node).ok())
    }

    fn planned_array_push_value(&mut self, node: Node) -> Option<Type> {
        let node = receivers::reference_node(node);
        if node.is_nil() {
            return None;
        }
        if node.kind() != SyntaxKind::ArrayLiteralExpression
            || node.elements().is_empty()
            || node.elements().iter().any(|element| {
                element.is_nil()
                    || matches!(
                        element.kind(),
                        SyntaxKind::OmittedExpression | SyntaxKind::SpreadElement
                    )
            })
        {
            return self.planned_assignment_value(node);
        }
        let elements = node
            .elements()
            .iter()
            .map(|element| self.planned_assignment_value(element))
            .collect::<Option<Vec<_>>>()?;
        self.intern_tuple(elements)
    }

    /// Mutable locals need one owning cell layout across every assignment.
    /// Inferred JavaScript locals are also widened across unlike represented
    /// values before the declaration is emitted. This is especially important
    /// for the common `let value = undefined; value = object` pattern: the
    /// checker may expose the initializer's narrow type at the declaration,
    /// while the native cell must retain both states.
    pub(super) fn plan_function_local_storage(&mut self, function: Node) -> Result<(), String> {
        let mut events = Vec::new();
        storage_events(function.body(), function.body(), &mut events);
        // A closure mutates the same outer cell, not a second lexical value.
        // Collect those writes after the outer declarations have established
        // their candidate layouts. Assignments to closure-local symbols are
        // naturally ignored because they are absent from this plan.
        let captured_start = events.len();
        let mut local_symbols = events[..captured_start]
            .iter()
            .filter_map(|event| match event {
                StorageEvent::Declaration(declaration) => Some(self.symbol(declaration.name())),
                _ => None,
            })
            .filter(|symbol| *symbol != 0)
            .collect::<HashSet<_>>();
        for parameter in function.parameters() {
            if parameter.name().kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(parameter.name());
                if symbol != 0 {
                    local_symbols.insert(symbol);
                }
            }
        }
        captured_assignment_events(function.body(), function.body(), false, &mut events);
        for event in &events[captured_start..] {
            if let StorageEvent::Assignment(assignment) = event {
                let symbol = self.symbol(assignment.left());
                if local_symbols.contains(&symbol) {
                    self.nested_assignment_symbols.insert(symbol);
                }
            }
        }
        let mut initial = HashMap::new();
        let mut inferred_javascript = HashSet::new();
        let mut contextual_elements = HashSet::new();
        let mut widened_arrays = HashSet::new();
        for event in events {
            match event {
                StorageEvent::Declaration(declaration) => {
                    let symbol = self.symbol(declaration.name());
                    let raw_initializer = declaration.initializer();
                    let inferred_empty_array = parameter_abi::is_javascript(declaration)
                        && declaration.type_().is_nil()
                        && !raw_initializer.is_nil()
                        && raw_initializer.kind() == SyntaxKind::ArrayLiteralExpression
                        && raw_initializer.elements().is_empty();
                    let inferred = parameter_abi::is_javascript(declaration)
                        && declaration.type_().is_nil()
                        && (self.declared(declaration).is_none() || inferred_empty_array);
                    if parameter_abi::is_javascript(declaration)
                        && declaration.type_().is_nil()
                        && !raw_initializer.is_nil()
                        && matches!(
                            raw_initializer.kind(),
                            SyntaxKind::ObjectLiteralExpression | SyntaxKind::CallExpression
                        )
                    {
                        contextual_elements.insert(symbol);
                    }
                    let checker_storage = if inferred && raw_initializer.is_nil() {
                        Ok(Type::Undefined)
                    } else {
                        self.storage_type(declaration.name())
                    };
                    let indexed_element = self.indexed_initializer_storage(declaration)?;
                    let initializer = receivers::reference_node(raw_initializer);
                    let symbol_storage = if initializer.is_nil() {
                        None
                    } else {
                        self.symbol_initializer_storage(initializer)
                    };
                    let commonjs_module_storage = inferred
                        .then(|| self.commonjs_module_logical_storage(initializer))
                        .flatten();
                    let constructed_object = if declaration.type_().is_nil()
                        && !raw_initializer.is_nil()
                        && raw_initializer.kind() == SyntaxKind::NewExpression
                    {
                        self.source_constructed_class_name(raw_initializer.expression())
                            .map(|class_name| Type::Object { class_name })
                    } else {
                        None
                    };
                    let planned_initializer_storage =
                        (constructed_object.is_none() && inferred && !initializer.is_nil())
                            .then(|| self.planned_argument_type(initializer))
                            .flatten();
                    let captured_dynamic_result = if inferred
                        && !initializer.is_nil()
                        && matches!(
                            initializer.kind(),
                            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
                        )
                        && initializer.asterisk_token().is_nil()
                        && !initializer
                            .modifier_flags()
                            .intersects(ModifierFlags::ASYNC)
                    {
                        let mut returns = Vec::new();
                        if initializer.body().kind() == SyntaxKind::Block {
                            parameter_abi::collect_returns(initializer.body(), &mut returns);
                        } else {
                            returns.push(initializer.body());
                        }
                        returns.into_iter().any(|value| {
                            let value = receivers::reference_node(value);
                            !value.is_nil() && value.kind() == SyntaxKind::Identifier && {
                                let captured = self.symbol(value);
                                self.data_bindings.contains(&captured)
                            }
                        })
                    } else {
                        false
                    };
                    let storage = if !raw_initializer.is_nil()
                        && (self.inferred_nonnull_array_element(declaration)
                            || self.inferred_nonnull_array_removal(declaration)
                            || self.native_dynamic_result_call(raw_initializer)
                            || self.native_weak_reference_constructor(raw_initializer)
                            || self.native_computed_symbol_result_call(raw_initializer))
                    {
                        Ok(Type::Dyn)
                    } else if let Some(symbol) = symbol_storage {
                        Ok(symbol)
                    } else if let Some(commonjs) = commonjs_module_storage {
                        Ok(commonjs)
                    } else if let Some(object) = constructed_object {
                        // The checker exposes instances from declaration-backed
                        // class factories as their structural public surface.
                        // Native storage must keep the actual instance owner:
                        // fields, prototype identity, and captured class state
                        // all live on that object and cannot be copied into a
                        // record projection.
                        Ok(object)
                    } else if matches!(&checker_storage, Ok(Type::Dyn) | Err(_))
                        && let Some(planned) = planned_initializer_storage
                    {
                        // The checker may expose an imported JSDoc interface
                        // as `any` or an unrepresentable open projection even
                        // though the JavaScript initializer has a concrete
                        // declared implementation ABI. The cell owns that
                        // initializer value, so retain its planned layout.
                        Ok(planned)
                    } else if let Some(element) = indexed_element {
                        Ok(element)
                    } else {
                        checker_storage.clone()
                    };
                    let storage = if captured_dynamic_result {
                        match storage {
                            Ok(Type::Func { params, ret, rest }) if *ret != Type::Void => {
                                Ok(Type::Func {
                                    params,
                                    ret: Box::new(Type::Dyn),
                                    rest,
                                })
                            }
                            other => other,
                        }
                    } else {
                        storage
                    };
                    if let Ok(ty) = storage {
                        let original = checker_storage.unwrap_or_else(|_| ty.clone());
                        initial.entry(symbol).or_insert(original);
                        self.var_types.insert(symbol, ty);
                        if inferred {
                            inferred_javascript.insert(symbol);
                        }
                    }
                }
                StorageEvent::Assignment(assignment) => {
                    let symbol = self.symbol(assignment.left());
                    let Some(current) = self.var_types.get(&symbol).cloned() else {
                        continue;
                    };
                    let compound = updates::compound_operator(assignment.operator_token().kind());
                    let Some(mut value) = self.planned_assignment_value(assignment.right()) else {
                        if compound == Some("+")
                            && inferred_javascript.contains(&symbol)
                            && current != Type::Dyn
                        {
                            // An unchecked JavaScript += whose RHS has no
                            // planned native projection can publish either a
                            // number or a string. Reserve the owning ABI before
                            // lowering the declaration so the operation keeps
                            // JavaScript addition semantics.
                            self.var_types.insert(symbol, Type::Dyn);
                        }
                        continue;
                    };
                    if let Some(op) = compound {
                        if !self.numeric_operand_domain(&current)
                            || !self.numeric_operand_domain(&value)
                        {
                            continue;
                        }
                        value = self.numeric_result_type(&current, &value, op);
                        if current != value
                            && !(self.numeric_storage(&current) && self.numeric_storage(&value))
                        {
                            // A compound update both reads the old value and
                            // publishes its result into the same cell. When
                            // JavaScript `+` can switch that cell between a
                            // numeric and string/erased domain, Dyn is the one
                            // identity-preserving owning ABI.
                            value = Type::Dyn;
                        }
                        if current != Type::Dyn && value == Type::Dyn {
                            // TypeScript permits an erased RHS in `+=` even
                            // for a local initially inferred as Number. At
                            // runtime that same cell may now hold a String;
                            // plan the owning slot as Dyn before declaration
                            // lowering so the actual JavaScript addition can
                            // choose either tag without a copied replacement.
                            self.var_types.insert(symbol, Type::Dyn);
                            continue;
                        }
                    }
                    if current == value {
                        continue;
                    }
                    let numeric = self.numeric_storage(&current) && self.numeric_storage(&value);
                    if !numeric && !inferred_javascript.contains(&symbol) {
                        continue;
                    }
                    let mut arms = match current {
                        Type::Union { union_id } => self.unions[union_id].arms.clone(),
                        ty => vec![ty],
                    };
                    match value {
                        Type::Union { union_id } => arms.extend(self.unions[union_id].arms.clone()),
                        ty => arms.push(ty),
                    }
                    if let Some(storage) = self.intern_union(arms) {
                        self.var_types.insert(symbol, storage);
                    }
                }
                StorageEvent::PropertyAssignment(assignment) => {
                    let member = assignment.left();
                    let symbol = self.symbol(member.expression());
                    let Some(Type::Record { shape_id }) = self.var_types.get(&symbol).cloned()
                    else {
                        continue;
                    };
                    let record = self.records[shape_id].clone();
                    if record.tuple || record.index_value.is_some() {
                        continue;
                    }
                    let Some(field_index) = record
                        .fields
                        .iter()
                        .position(|field| field.name == member.name().text())
                    else {
                        continue;
                    };
                    let Some(value) = self.planned_assignment_value(assignment.right()) else {
                        continue;
                    };
                    let current = record.fields[field_index].r#type.clone();
                    let widened = if current == value {
                        continue;
                    } else if current == Type::Dyn || value == Type::Dyn {
                        Type::Dyn
                    } else {
                        let Some(widened) = self.intern_union(vec![current, value]) else {
                            continue;
                        };
                        widened
                    };
                    let mut fields = record.fields.clone();
                    fields[field_index].r#type = widened;
                    let target = self
                        .records
                        .iter()
                        .find(|candidate| {
                            candidate.tuple == record.tuple
                                && candidate.index_value == record.index_value
                                && candidate.fields == fields
                                && candidate.declared_order == record.declared_order
                        })
                        .map(|candidate| candidate.id)
                        .unwrap_or_else(|| {
                            let id = self.records.len();
                            self.records.push(ir::Record {
                                id,
                                fields,
                                declared_order: record.declared_order,
                                tuple: false,
                                index_value: None,
                            });
                            id
                        });
                    self.var_types
                        .insert(symbol, Type::Record { shape_id: target });
                }
                StorageEvent::ArrayPush(receiver, argument) => {
                    let symbol = self.symbol(receiver);
                    if !inferred_javascript.contains(&symbol) || widened_arrays.contains(&symbol) {
                        continue;
                    }
                    let Some(Type::Array { elem }) = self.var_types.get(&symbol).cloned() else {
                        continue;
                    };
                    let Some(value) = self.planned_array_push_value(argument) else {
                        continue;
                    };
                    // The checker exposes a context-free empty JavaScript
                    // literal as an uninhabited/undefined element slot. Like
                    // `Dyn`, that is only a placeholder until the first
                    // concrete push; it must not become the array's permanent
                    // native ABI.
                    let next = if *elem == Type::Dyn && value == Type::Undefined {
                        // `undefined` is also the checker port's failure
                        // sentinel for some unannotated JS bindings. It is not
                        // evidence strong enough to narrow an erased array.
                        continue;
                    } else if matches!(*elem, Type::Dyn | Type::Undefined) {
                        value
                    } else if *elem == value {
                        continue;
                    } else {
                        widened_arrays.insert(symbol);
                        Type::Dyn
                    };
                    self.var_types.insert(
                        symbol,
                        Type::Array {
                            elem: Box::new(next),
                        },
                    );
                }
                StorageEvent::ContextualArrayElement(argument, receiver) => {
                    let symbol = self.symbol(argument);
                    if !contextual_elements.contains(&symbol) {
                        continue;
                    }
                    let Some(current) = self.var_types.get(&symbol).cloned() else {
                        continue;
                    };
                    if !matches!(current, Type::Record { .. } | Type::Union { .. }) {
                        continue;
                    }
                    let Some(element) = self.planned_iterable_element(receiver) else {
                        continue;
                    };
                    let compatible = match &element {
                        Type::Record { .. } => true,
                        Type::Union { union_id } => self.unions[*union_id]
                            .arms
                            .iter()
                            .any(|arm| matches!(arm, Type::Record { .. })),
                        _ => false,
                    };
                    if compatible && current != element {
                        let mut contextual = vec![element];
                        if let Type::Union { union_id } = current {
                            contextual.extend(
                                self.unions[union_id]
                                    .arms
                                    .iter()
                                    .filter(|arm| matches!(arm, Type::Null | Type::Undefined))
                                    .cloned(),
                            );
                        }
                        if let Some(storage) = self.intern_union(contextual) {
                            self.var_types.insert(symbol, storage);
                        }
                    }
                }
            }
        }
        for (symbol, original) in initial {
            if let Some(storage) = self.var_types.get(&symbol)
                && *storage != original
            {
                self.planned_local_storage.insert(symbol, storage.clone());
            }
        }
        Ok(())
    }

    pub(super) fn inferred_call_local(
        &mut self,
        declaration: Node,
        statement: Node,
        flags: NodeFlags,
    ) -> bool {
        if !flags.intersects(NodeFlags::CONST)
            || statement.parent().kind() == SyntaxKind::SourceFile
            || !parameter_abi::is_javascript(declaration)
            || !declaration.type_().is_nil()
            || self.declared(declaration).is_some()
            || !matches!(
                declaration.initializer().kind(),
                SyntaxKind::CallExpression | SyntaxKind::Identifier
            )
        {
            return false;
        }
        let file = get_source_file_of_node(statement);
        let text = source_file_text(file);
        let start = statement.pos().max(0) as usize;
        let token = get_token_pos_of_node(statement, file, false)
            .max(statement.pos())
            .max(0) as usize;
        if !statement.js_doc(file).is_empty()
            || !declaration.js_doc(file).is_empty()
            || text
                .get(start..token)
                .is_none_or(|prefix| prefix.contains("/**"))
        {
            return false;
        }
        match declaration.initializer().kind() {
            SyntaxKind::Identifier => true,
            SyntaxKind::CallExpression => {
                // Lower the call before committing an `any`/Dyn checker slot.
                // Standard intrinsics and published producers already own a
                // more precise result ABI; private erased functions still
                // naturally return Dyn and therefore remain contextual.
                true
            }
            _ => false,
        }
    }

    fn joined_record_storage(&self, source: &Type, arms: &[Type], depth: usize) -> bool {
        if depth >= 64 || arms.is_empty() {
            return false;
        }
        let Type::Record {
            shape_id: source_id,
        } = source
        else {
            return false;
        };
        let Some(source_record) = self.records.get(*source_id) else {
            return false;
        };
        if source_record.tuple || source_record.index_value.is_some() {
            return false;
        }
        let targets = arms
            .iter()
            .map(|arm| {
                let Type::Record { shape_id } = arm else {
                    return None;
                };
                self.records.get(*shape_id)
            })
            .collect::<Option<Vec<_>>>();
        let Some(targets) = targets else {
            return false;
        };
        if targets.iter().any(|target| {
            target.tuple
                || target.index_value.is_some()
                || target.fields.len() != source_record.fields.len()
        }) {
            return false;
        }
        source_record.fields.iter().all(|source_field| {
            let target_types = targets
                .iter()
                .map(|target| {
                    target
                        .fields
                        .iter()
                        .find(|field| field.name == source_field.name)
                        .map(|field| field.r#type.clone())
                })
                .collect::<Option<Vec<_>>>();
            let Some(target_types) = target_types else {
                return false;
            };
            let compatible = if matches!(source_field.r#type, Type::Record { .. })
                && target_types
                    .iter()
                    .all(|target| matches!(target, Type::Record { .. }))
            {
                self.joined_record_storage(&source_field.r#type, &target_types, depth + 1)
            } else {
                target_types
                    .iter()
                    .all(|target| self.contextual_result_compatible(target, &source_field.r#type))
            };
            if !compatible && std::env::var_os("SCRIPTC_TRACE_RECORD_VIEWS").is_some() {
                eprintln!(
                    "scriptc: record join field={} source={:?} targets={:?}",
                    source_field.name, source_field.r#type, target_types
                );
            }
            compatible
        })
    }

    fn joined_record_contract(&self, source: &Type, target: &Type, depth: usize) -> bool {
        if depth >= 64 {
            return false;
        }
        let (Type::Record { shape_id: source }, Type::Record { shape_id: target }) =
            (source, target)
        else {
            return false;
        };
        let (Some(source), Some(target)) = (self.records.get(*source), self.records.get(*target))
        else {
            return false;
        };
        if source.tuple
            || target.tuple
            || source.index_value.is_some()
            || target.index_value.is_some()
            || source.fields.len() != target.fields.len()
        {
            return false;
        }
        target.fields.iter().all(|target_field| {
            let Some(source_field) = source
                .fields
                .iter()
                .find(|field| field.name == target_field.name)
            else {
                return false;
            };
            if matches!(source_field.r#type, Type::Record { .. }) {
                if let Type::Union { union_id } = &target_field.r#type {
                    return self.joined_record_storage(
                        &source_field.r#type,
                        &self.unions[*union_id].arms,
                        depth + 1,
                    );
                }
                if matches!(target_field.r#type, Type::Record { .. }) {
                    return self.joined_record_contract(
                        &source_field.r#type,
                        &target_field.r#type,
                        depth + 1,
                    );
                }
            }
            self.contextual_result_compatible(&source_field.r#type, &target_field.r#type)
                || self.contextual_result_compatible(&target_field.r#type, &source_field.r#type)
        })
    }

    pub(super) fn call_record_storage(&self, source: &Type, inferred: &Type) -> bool {
        if !matches!(source, Type::Record { .. }) {
            return false;
        }
        if matches!(inferred, Type::Record { .. }) {
            return erased_record(source, inferred, &self.records, &mut HashSet::new())
                || self.joined_record_contract(source, inferred, 0);
        }
        // A JavaScript producer can publish one concrete shared record while
        // the checker describes its call result as a union of structural
        // projections (commonly after spreading an indexed table entry). Do
        // not invent a union tag at the local initialization boundary: retain
        // the producer ABI when it safely backs at least one inferred view.
        // Later property reads keep using the checked shared-record view.
        let Type::Union { union_id } = inferred else {
            return false;
        };
        self.contextual_result_compatible(source, inferred)
            || self.joined_record_storage(source, &self.unions[*union_id].arms, 0)
            || (!self.unions[*union_id].arms.is_empty()
                && self.unions[*union_id].arms.iter().all(|arm| {
                    matches!(arm, Type::Record { .. })
                        && (ir::record_equivalence::equivalent(
                            arm,
                            source,
                            &self.records,
                            &self.unions,
                        ) || ir::record_views::dynamic_view_pairs(
                            arm,
                            source,
                            &self.records,
                            &self.unions,
                        )
                        .is_some())
                }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: usize, fields: &[(&str, Type)]) -> ir::Record {
        ir::Record {
            id,
            fields: fields
                .iter()
                .map(|(name, ty)| ir::Field {
                    name: (*name).into(),
                    r#type: ty.clone(),
                })
                .collect(),
            declared_order: fields.iter().map(|(name, _)| (*name).into()).collect(),
            tuple: false,
            index_value: None,
        }
    }
    #[test]
    fn inferred_record_contract_allows_erasure_without_changing_mutable_layouts() {
        let mut records = vec![
            record(0, &[("value", Type::F64)]),
            record(1, &[("value", Type::Dyn)]),
            record(2, &[("value", Type::String)]),
            record(3, &[("other", Type::Dyn)]),
        ];
        let test = |a, b, records: &[ir::Record]| {
            erased_record(
                &Type::Record { shape_id: a },
                &Type::Record { shape_id: b },
                records,
                &mut HashSet::new(),
            )
        };
        assert!(test(0, 1, &records));
        assert!(!test(1, 0, &records));
        assert!(!test(0, 2, &records));
        assert!(!test(0, 3, &records));
        records[1].tuple = true;
        assert!(!test(0, 1, &records));
    }
}
