//! Plan input slots before caching callable and storage layouts.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

pub(super) fn is_javascript(node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    let file = source_file_info(get_source_file_of_node(node));
    [".js", ".mjs", ".cjs"]
        .iter()
        .any(|ext| file.file_name.ends_with(ext))
}

fn collect(
    node: Node,
    functions: &mut Vec<Node>,
    calls: &mut Vec<Node>,
    assignments: &mut Vec<Node>,
) {
    if matches!(
        node.kind(),
        SyntaxKind::FunctionDeclaration
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::MethodDeclaration
            | SyntaxKind::Constructor
    ) {
        functions.push(node);
    }
    if matches!(
        node.kind(),
        SyntaxKind::CallExpression | SyntaxKind::NewExpression
    ) {
        calls.push(node);
    }
    if node.kind() == SyntaxKind::BinaryExpression
        && node.operator_token().kind() == SyntaxKind::EqualsToken
        && node.left().kind() == SyntaxKind::Identifier
    {
        assignments.push(node);
    }
    node.for_each_child(&mut |child| {
        collect(child, functions, calls, assignments);
        false
    });
}

pub(super) fn collect_returns(node: Node, returns: &mut Vec<Node>) {
    if matches!(
        node.kind(),
        SyntaxKind::FunctionDeclaration
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::MethodDeclaration
            | SyntaxKind::ClassDeclaration
            | SyntaxKind::ClassExpression
    ) {
        return;
    }
    if node.kind() == SyntaxKind::ReturnStatement {
        returns.push(node.expression());
        return;
    }
    node.for_each_child(&mut |child| {
        collect_returns(child, returns);
        false
    });
}

impl Lowerer<'_> {
    fn structural_record_parameter_abi(&self, ty: &Type) -> bool {
        match ty {
            Type::Record { .. } => true,
            Type::Union { union_id } => {
                let arms = &self.unions[*union_id].arms;
                arms.iter().any(|arm| matches!(arm, Type::Record { .. }))
                    && arms.iter().all(|arm| {
                        matches!(
                            arm,
                            Type::Record { .. } | Type::Null | Type::Undefined | Type::Void
                        )
                    })
            }
            _ => false,
        }
    }

    fn structural_record_result_abi(&self, ty: &Type) -> bool {
        match ty {
            Type::Promise { inner } => self.structural_record_parameter_abi(inner),
            other => self.structural_record_parameter_abi(other),
        }
    }

    fn nominal_object_result_abi(&self, ty: &Type) -> bool {
        match ty {
            Type::Object { .. } => true,
            Type::Union { union_id } => {
                let arms = &self.unions[*union_id].arms;
                arms.iter().any(|arm| matches!(arm, Type::Object { .. }))
                    && arms.iter().all(|arm| {
                        matches!(
                            arm,
                            Type::Object { .. } | Type::Null | Type::Undefined | Type::Void
                        )
                    })
            }
            _ => false,
        }
    }

    fn source_sequence_may_fall_through(&mut self, statements: Vec<Node>) -> bool {
        let mut reachable = true;
        for statement in statements {
            if !reachable {
                break;
            }
            reachable = self.source_statement_may_fall_through(statement);
        }
        reachable
    }

    fn source_statement_may_fall_through(&mut self, statement: Node) -> bool {
        match statement.kind() {
            SyntaxKind::ReturnStatement | SyntaxKind::ThrowStatement => false,
            SyntaxKind::Block => {
                self.source_sequence_may_fall_through(statement.statements().into_iter().collect())
            }
            SyntaxKind::IfStatement => {
                let then_falls = self.source_statement_may_fall_through(statement.then_statement());
                let else_statement = statement.else_statement();
                else_statement.is_nil()
                    || then_falls
                    || self.source_statement_may_fall_through(else_statement)
            }
            SyntaxKind::SwitchStatement => {
                let clauses = statement.case_block().clauses().nodes();
                let has_default = clauses
                    .clone()
                    .into_iter()
                    .any(|clause| clause.kind() == SyntaxKind::DefaultClause);
                if !has_default && !self.exhaustive_literal_switch(statement) {
                    return true;
                }
                let mut tail_falls = true;
                let mut some_entry_falls = false;
                for clause in clauses.into_iter().rev() {
                    let body = clause.statements().into_iter().collect::<Vec<_>>();
                    // A break completes the switch normally. Be conservative
                    // about nested control flow; widening an actually absent
                    // result is safer than erasing JavaScript undefined.
                    if body
                        .iter()
                        .any(|node| node.kind() == SyntaxKind::BreakStatement)
                    {
                        return true;
                    }
                    let entry_falls = self.source_sequence_may_fall_through(body) && tail_falls;
                    some_entry_falls |= entry_falls;
                    tail_falls = entry_falls;
                }
                some_entry_falls
            }
            _ => true,
        }
    }

    pub(super) fn function_may_return_absent(&mut self, function: Node) -> bool {
        if function.body().is_nil() {
            return false;
        }
        let mut returns = Vec::new();
        collect_returns(function.body(), &mut returns);
        let explicit_absence = returns
            .into_iter()
            .any(|value| self.argument_may_be_absent(value, &mut HashSet::new()));
        explicit_absence
            || self.source_sequence_may_fall_through(
                function.body().statements().into_iter().collect(),
            )
    }

    pub(super) fn function_absence_kinds(&mut self, function: Node) -> (bool, bool) {
        if function.body().is_nil() {
            return (false, false);
        }
        let mut returns = Vec::new();
        collect_returns(function.body(), &mut returns);
        let mut null = false;
        let mut undefined = false;
        for value in returns {
            if value.is_nil() {
                undefined = true;
                continue;
            }
            let value = receivers::reference_node(value);
            null |= value.kind() == SyntaxKind::NullKeyword;
            undefined |= value.kind() == SyntaxKind::VoidExpression
                || value.kind() == SyntaxKind::Identifier
                    && value.text() == "undefined"
                    && self.symbol(value) == 0;
            if !null && !undefined && self.argument_may_be_absent(value, &mut HashSet::new()) {
                // Propagated absence without a visible literal is normally an
                // omitted/undefined channel. A checker union which contains
                // null already survives type_id and does not need this hint.
                undefined = true;
            }
        }
        undefined |= self
            .source_sequence_may_fall_through(function.body().statements().into_iter().collect());
        (null, undefined)
    }

    fn collect_escaping_private_functions(
        &mut self,
        node: Node,
        targets: &HashSet<u32>,
        escaping: &mut HashSet<u32>,
    ) {
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if targets.contains(&symbol) {
                let parent = node.parent();
                let declaration_name = matches!(
                    parent.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::ClassDeclaration
                        | SyntaxKind::ClassExpression
                ) && parent.name() == node;
                let direct_call = matches!(
                    parent.kind(),
                    SyntaxKind::CallExpression | SyntaxKind::NewExpression
                ) && receivers::reference_node(parent.expression()) == node;
                let direct_member_call = parent.kind() == SyntaxKind::PropertyAccessExpression
                    && parent.name() == node
                    && matches!(
                        parent.parent().kind(),
                        SyntaxKind::CallExpression | SyntaxKind::NewExpression
                    )
                    && receivers::reference_node(parent.parent().expression()) == parent;
                let static_module_alias = matches!(
                    parent.kind(),
                    SyntaxKind::ImportSpecifier | SyntaxKind::ExportSpecifier
                );
                if !declaration_name && !direct_call && !direct_member_call && !static_module_alias
                {
                    escaping.insert(symbol);
                }
            }
        }
        node.for_each_child(&mut |child| {
            self.collect_escaping_private_functions(child, targets, escaping);
            false
        });
    }

    fn planned_argument_type_inner(&mut self, node: Node, seen: &mut HashSet<u32>) -> Option<Type> {
        let node = receivers::reference_node(node);
        if node.is_nil() {
            return None;
        }
        // Stable ownership plans outrank an `any` checker projection. This is
        // what lets a private JS helper forward a source-class instance through
        // one or more unannotated parameters without erasing its methods (and,
        // in particular, generator channels).
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if let Some(ty) = self.js_parameter_types.get(&symbol) {
                return Some(ty.clone());
            }
            if let Some(ty) = self.planned_local_storage.get(&symbol) {
                return Some(ty.clone());
            }
            if symbol != 0 {
                let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                if !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && !declaration.initializer().is_nil()
                {
                    let initial = receivers::reference_node(declaration.initializer());
                    if initial.kind() == SyntaxKind::NewExpression
                        && let Some(class_name) =
                            self.source_constructed_class_name(initial.expression())
                    {
                        return Some(Type::Object { class_name });
                    }
                }
            }
        }
        if node.kind() == SyntaxKind::NewExpression
            && let Some(class_name) = self.source_constructed_class_name(node.expression())
        {
            return Some(Type::Object { class_name });
        }
        let checked = self.checker.get_type_at_location(node);
        let checker_erased = self
            .checker
            .ty(checked)
            .flags
            .intersects(TypeFlags::ANY | TypeFlags::UNKNOWN);
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if symbol != 0 && seen.insert(symbol) {
                let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                if !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && is_javascript(declaration)
                    && declaration.type_().is_nil()
                    && !declaration.initializer().is_nil()
                    && declaration.parent().kind() == SyntaxKind::VariableDeclarationList
                    && !declaration.parent().flags().intersects(NodeFlags::CONST)
                {
                    let initial = receivers::reference_node(declaration.initializer());
                    if matches!(self.ty(initial).ok(), Some(Type::Null | Type::Undefined)) {
                        // A mutable JS cell initialized with a nullish sentinel
                        // has no useful argument ABI until all of its writes are
                        // considered. Treat it as the owning dynamic value here;
                        // freezing a callee parameter to `undefined` would make
                        // later object writes impossible to pass.
                        return Some(Type::Dyn);
                    }
                }
                if !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && !declaration.initializer().is_nil()
                    && let Some(ty) =
                        self.planned_argument_type_inner(declaration.initializer(), seen)
                {
                    return Some(ty);
                }
                if !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::BindingElement
                    && declaration.parent().kind() == SyntaxKind::ObjectBindingPattern
                {
                    let owner = declaration.parent().parent();
                    if owner.kind() == SyntaxKind::VariableDeclaration
                        && !owner.initializer().is_nil()
                        && let Some(source) =
                            self.planned_argument_type_inner(owner.initializer(), seen)
                    {
                        let name = if declaration.property_name().is_nil() {
                            declaration.name().text()
                        } else {
                            declaration.property_name().text()
                        };
                        let field = |shape_id: usize| {
                            self.records[shape_id]
                                .fields
                                .iter()
                                .find(|field| field.name == name)
                                .map(|field| field.r#type.clone())
                        };
                        let projected = match source {
                            Type::Record { shape_id } => field(shape_id),
                            Type::Union { union_id } => {
                                let mut projected = None;
                                let mut valid = true;
                                for arm in self.unions[union_id].arms.clone() {
                                    let Type::Record { shape_id } = arm else {
                                        valid = false;
                                        break;
                                    };
                                    let Some(value) = field(shape_id) else {
                                        valid = false;
                                        break;
                                    };
                                    if projected.as_ref().is_some_and(|ty| *ty != value) {
                                        valid = false;
                                        break;
                                    }
                                    projected = Some(value);
                                }
                                valid.then_some(projected).flatten()
                            }
                            _ => None,
                        };
                        if projected.is_some() {
                            return projected;
                        }
                    }
                }
            }
        }
        if node.kind() == SyntaxKind::CallExpression {
            if let Some(ty) = self.planned_class_method_call_result(node) {
                return Some(ty);
            }
            let callee = receivers::reference_node(node.expression());
            if callee.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(callee);
                if symbol != 0 {
                    if let Some(function) = self.functions.source_node(symbol) {
                        if let Some(ty) = self.declared(function).and_then(|hint| hint.ret.clone())
                        {
                            return Some(ty);
                        }
                        let signature = self.checker.get_signature_from_declaration(function);
                        if signature.0 != 0 {
                            let result = self.checker.get_return_type_of_signature(signature);
                            if let Some(ty) = self.type_id(result) {
                                return Some(ty);
                            }
                        }
                    }
                    let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                    if !declaration.is_nil()
                        && let Some(ty) =
                            self.declared(declaration).and_then(|hint| hint.ret.clone())
                    {
                        // JavaScript implementations with TypeScript overloads
                        // own the union of every declared result, while the
                        // checker resolves each call site to one overload. Use
                        // that selected arm for contextual parameter planning;
                        // the emitted call still owns the union and `coerce`
                        // performs the checked tag projection at the boundary.
                        if let Type::Union { union_id } = &ty
                            && let Ok(resolved) = self.ty(node)
                            && self.unions[*union_id].arms.contains(&resolved)
                        {
                            return Some(resolved);
                        }
                        // An erased declaration hint is only an ownership ABI;
                        // it must not hide a concrete checker result needed to
                        // plan the receiving parameter (notably JS overload
                        // implementations that return sync/async generators).
                        if ty == Type::Dyn
                            && let Ok(resolved) = self.ty(node)
                            && resolved != Type::Dyn
                        {
                            return Some(resolved);
                        }
                        return Some(ty);
                    }
                }
            }
        }
        if node.kind() == SyntaxKind::ArrayLiteralExpression {
            let mut elements = Vec::new();
            for element in node.elements() {
                if element.kind() == SyntaxKind::SpreadElement {
                    return None;
                }
                elements.push(self.planned_argument_type_inner(element, seen)?);
            }
            let element = self.intern_union(elements)?;
            return Some(Type::Array {
                elem: Box::new(element),
            });
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression && node.name().text() == "length" {
            let receiver = self.planned_argument_type_inner(node.expression(), seen)?;
            if matches!(
                receiver,
                Type::Array { .. } | Type::Bytes { .. } | Type::String
            ) {
                return Some(Type::F64);
            }
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression {
            let receiver = receivers::reference_node(node.expression());
            if receiver.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(receiver);
                let owner = self
                    .contextual_record_storage
                    .get(&symbol)
                    .cloned()
                    .or_else(|| self.planned_local_storage.get(&symbol).cloned())
                    .or_else(|| self.var_types.get(&symbol).cloned())
                    .or_else(|| self.module_vars.get(&symbol).cloned());
                if let Some(Type::Record { shape_id }) = owner
                    && let Some(field) = self.records[shape_id]
                        .fields
                        .iter()
                        .find(|field| field.name == node.name().text())
                {
                    return Some(field.r#type.clone());
                }
            }
        }
        if node.kind() == SyntaxKind::BinaryExpression
            && matches!(
                node.operator_token().kind(),
                SyntaxKind::PlusToken
                    | SyntaxKind::MinusToken
                    | SyntaxKind::AsteriskToken
                    | SyntaxKind::SlashToken
                    | SyntaxKind::PercentToken
                    | SyntaxKind::AsteriskAsteriskToken
                    | SyntaxKind::AmpersandToken
                    | SyntaxKind::BarToken
                    | SyntaxKind::CaretToken
                    | SyntaxKind::LessThanLessThanToken
                    | SyntaxKind::GreaterThanGreaterThanToken
                    | SyntaxKind::GreaterThanGreaterThanGreaterThanToken
            )
        {
            let left = self.planned_argument_type_inner(node.left(), &mut seen.clone())?;
            let right = self.planned_argument_type_inner(node.right(), seen)?;
            if left == Type::F64 && right == Type::F64 {
                return Some(Type::F64);
            }
            if left == Type::Bigint
                && right == Type::Bigint
                && node.operator_token().kind()
                    != SyntaxKind::GreaterThanGreaterThanGreaterThanToken
            {
                return Some(Type::Bigint);
            }
            return None;
        }
        if node.kind() == SyntaxKind::ConditionalExpression {
            let when_true =
                self.planned_argument_type_inner(node.when_true(), &mut seen.clone())?;
            let when_false = self.planned_argument_type_inner(node.when_false(), seen)?;
            return (when_true == when_false).then_some(when_true);
        }
        if checker_erased {
            // Structured expressions above may recover a stable contract from
            // closed-world parameter plans even when the JS checker reports
            // `any` for the whole expression (for example `8 + data.length`).
            // Every other erased projection remains an owning dynamic value;
            // a transient checker use must not freeze its callee ABI.
            return Some(Type::Dyn);
        }
        self.ty(node).ok().filter(|ty| *ty != Type::Dyn)
    }

    pub(super) fn planned_argument_type(&mut self, node: Node) -> Option<Type> {
        self.planned_argument_type_inner(node, &mut HashSet::new())
            .filter(|ty| !matches!(ty, Type::Null | Type::Undefined | Type::Void))
    }

    fn asserted_array_binding_argument(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::NonNullExpression {
            return false;
        }
        let source = primitives::primitive_source(node);
        if source.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(source);
        if symbol == 0 {
            return false;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        !declaration.is_nil()
            && declaration.kind() == SyntaxKind::BindingElement
            && declaration.parent().kind() == SyntaxKind::ArrayBindingPattern
            && declaration.initializer().is_nil()
            && declaration.dot_dot_dot_token().is_nil()
    }

    pub(super) fn guarded_truthy_call_argument(&mut self, argument: Node, target: &Type) -> bool {
        if argument.kind() != SyntaxKind::Identifier {
            return false;
        }
        let call = argument.parent();
        if call.kind() != SyntaxKind::CallExpression
            || call.expression().kind() != SyntaxKind::Identifier
            || call.arguments().into_iter().next() != Some(argument)
        {
            return false;
        }
        let symbol = self.symbol(argument);
        let binding = self
            .bindings
            .get(&symbol)
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .cloned();
        let prior_return_guard = (|| {
            let binding = binding.as_ref()?;
            if symbol == 0 || binding.mutable || !self.var_defined.contains(&symbol) {
                return None;
            }
            let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
            if declaration.is_nil()
                || declaration.kind() != SyntaxKind::VariableDeclaration
                || !declaration.parent().flags().contains(NodeFlags::CONST)
            {
                return None;
            }
            let mut statement = call;
            while !statement.parent().is_nil()
                && statement.parent().kind() != SyntaxKind::Block
            {
                statement = statement.parent();
                if matches!(statement.kind(), SyntaxKind::FunctionDeclaration | SyntaxKind::FunctionExpression | SyntaxKind::ArrowFunction) {
                    return None;
                }
            }
            let block = statement.parent();
            if block.is_nil() {
                return None;
            }
            let statements = block.statements().into_iter().collect::<Vec<_>>();
            let position = statements.iter().position(|candidate| *candidate == statement)?;
            let guard = *statements.get(position.checked_sub(1)?)?;
            if guard.kind() != SyntaxKind::IfStatement || !guard.else_statement().is_nil() {
                return None;
            }
            let condition = receivers::reference_node(guard.expression());
            if condition.kind() != SyntaxKind::PrefixUnaryExpression
                || condition.operator() != SyntaxKind::ExclamationToken
            {
                return None;
            }
            let tested = receivers::reference_node(condition.operand());
            if tested.kind() != SyntaxKind::Identifier || self.symbol(tested) != symbol {
                return None;
            }
            let then = guard.then_statement();
            let exits = then.kind() == SyntaxKind::ReturnStatement
                || (then.kind() == SyntaxKind::Block
                    && then.statements().len() == 1
                    && then.statements().get(0).kind() == SyntaxKind::ReturnStatement);
            exits.then_some(binding.r#type.clone())
        })();
        if let Some(Type::Union { union_id }) = prior_return_guard {
            let arms = &self.unions[union_id].arms;
            let present = arms.iter().filter(|arm| !matches!(arm, Type::Null | Type::Undefined | Type::Void)).collect::<Vec<_>>();
            if !present.is_empty()
                && present.len() < arms.len()
                && present.into_iter().all(|arm| {
                    matches!(arm, Type::String | Type::F64 | Type::Bool | Type::Bigint | Type::Symbol)
                        && self.contextual_result_compatible(arm, target)
                })
            {
                return true;
            }
        }
        let parent = call.parent();
        let condition = if parent.kind() == SyntaxKind::BinaryExpression
            && parent.operator_token().kind() == SyntaxKind::AmpersandAmpersandToken
            && parent.right() == call
        {
            parent.left()
        } else if parent.kind() == SyntaxKind::ConditionalExpression && parent.when_true() == call {
            parent.condition()
        } else {
            return false;
        };
        let condition = receivers::reference_node(condition);
        if symbol == 0
            || condition.kind() != SyntaxKind::Identifier
            || self.symbol(condition) != symbol
            || !(self.bindings.contains_key(&symbol)
                || self.outer.iter().any(|scope| scope.contains_key(&symbol)))
        {
            return false;
        }
        let Some(Type::Union { union_id }) = self.planned_argument_type(argument) else {
            return false;
        };
        let arms = &self.unions[union_id].arms;
        let present = arms
            .iter()
            .filter(|arm| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
            .collect::<Vec<_>>();
        !present.is_empty()
            && present.len() < arms.len()
            && present
                .into_iter()
                .all(|arm| self.contextual_result_compatible(arm, target))
    }

    /// Modules reached through package JavaScript can be linked after the
    /// initial whole-program ABI pass. At demand time, recover one private
    /// parameter contract from every direct call in its own source module.
    /// Disagreement and spreads leave the contract unresolved. Omitted or
    /// undefined defaulted arguments do not constrain the input contract.
    pub(super) fn late_parameter_type(&mut self, parameter: Node) -> Option<Type> {
        let initializer = receivers::reference_node(parameter.initializer());
        if !initializer.is_nil()
            && initializer.kind() == SyntaxKind::ObjectLiteralExpression
            && initializer.properties().is_empty()
        {
            let checked = self.checker.get_type_at_location(parameter);
            if let Some(contract @ Type::Union { union_id }) = self.type_id(checked) {
                let records = self.unions[union_id]
                    .arms
                    .iter()
                    .filter_map(|arm| match arm {
                        Type::Record { shape_id } if !self.records[*shape_id].fields.is_empty() => {
                            Some(*shape_id)
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let only_record_or_undefined = self.unions[union_id]
                    .arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Record { .. } | Type::Undefined));
                if records.len() == 1 && only_record_or_undefined {
                    // A documented options parameter such as `@param
                    // {Options} [options]` owns a non-empty optional-record
                    // contract. Its `{}` default must retain that ABI instead
                    // of specializing the function to one concrete call-site
                    // literal whose fields all happen to be present.
                    let symbol = self.parameter_symbol(parameter);
                    self.js_parameter_types.insert(symbol, contract.clone());
                    return Some(contract);
                }
            }
        }
        let mut seen = HashSet::new();
        let mut inferred = None;
        if !self.collect_late_parameter_type(parameter, &mut seen, &mut inferred) {
            return None;
        }
        let ty = inferred?;
        let symbol = self.parameter_symbol(parameter);
        self.js_parameter_types.insert(symbol, ty.clone());
        Some(ty)
    }

    /// Follow parameter-to-parameter forwarding until reaching represented
    /// call arguments. A cycle is harmless when another edge anchors it to a
    /// concrete type; an erased non-parameter edge remains ambiguous.
    fn collect_late_parameter_type(
        &mut self,
        parameter: Node,
        seen: &mut HashSet<u32>,
        inferred: &mut Option<Type>,
    ) -> bool {
        if parameter.kind() != SyntaxKind::Parameter
            || parameter.name().kind() != SyntaxKind::Identifier
            || !is_javascript(parameter)
        {
            return false;
        }
        let function = parameter.parent();
        if function.kind() != SyntaxKind::FunctionDeclaration || function.name().is_nil() {
            return false;
        }
        let target = self.symbol(function.name());
        let parameter_symbol = self.symbol(parameter.name());
        if target == 0 || parameter_symbol == 0 {
            return false;
        }
        if let Some(ty) = self
            .js_parameter_types
            .get(&parameter_symbol)
            .filter(|ty| **ty != Type::Dyn)
            .cloned()
        {
            if inferred
                .as_ref()
                .is_some_and(|current| *current != ty && *current != Type::Dyn)
            {
                return false;
            }
            if inferred.is_none() {
                *inferred = Some(ty);
            }
            return true;
        }
        if !seen.insert(parameter_symbol) {
            return true;
        }
        let Some(index) = receivers::parameters(function)
            .iter()
            .position(|candidate| *candidate == parameter)
        else {
            return false;
        };
        let file = get_source_file_of_node(function);
        let mut functions = Vec::new();
        let mut calls = Vec::new();
        let mut assignments = Vec::new();
        collect(file, &mut functions, &mut calls, &mut assignments);
        let mut found = false;
        for call in calls.iter().copied() {
            if self.call_target(call.expression(), &mut HashSet::new()) != target {
                continue;
            }
            let arguments = call.arguments().into_iter().collect::<Vec<_>>();
            let Some(argument) = arguments.get(index).copied() else {
                if parameter.initializer().is_nil() {
                    return false;
                }
                found = true;
                continue;
            };
            if !parameter.initializer().is_nil() && self.ty(argument).ok() == Some(Type::Undefined)
            {
                found = true;
                continue;
            }
            if argument.kind() == SyntaxKind::SpreadElement {
                return false;
            }
            let Some(ty) = self.planned_argument_type(argument) else {
                return false;
            };
            if ty == Type::Dyn {
                let argument = receivers::reference_node(argument);
                if argument.kind() != SyntaxKind::Identifier {
                    // A default initializer does not restrict other supplied
                    // values. Keep an unknown expression erased rather than
                    // freezing the ABI to the initializer's inferred shape.
                    if parameter.initializer().is_nil()
                        || !parameter.type_().is_nil()
                        || self.declared(parameter.parent()).is_some()
                    {
                        return false;
                    }
                    *inferred = Some(Type::Dyn);
                    found = true;
                    continue;
                }
                let symbol = self.symbol(argument);
                if symbol == 0 {
                    return false;
                }
                let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                if declaration.is_nil()
                    || declaration.kind() != SyntaxKind::Parameter
                    || !self.collect_late_parameter_type(declaration, seen, inferred)
                {
                    return false;
                }
            } else {
                if inferred
                    .as_ref()
                    .is_some_and(|current| *current != ty && *current != Type::Dyn)
                {
                    return false;
                }
                if inferred.is_none() {
                    *inferred = Some(ty);
                }
            }
            found = true;
        }
        found
    }

    fn plan_default_object_parameter(&mut self, node: Node) {
        if node.initializer().is_nil() {
            return;
        }
        let initial = receivers::reference_node(node.initializer());
        if !node.type_().is_nil()
            || !node.dot_dot_dot_token().is_nil()
            || node.name().kind() != SyntaxKind::Identifier
            || initial.is_nil()
            || initial.kind() != SyntaxKind::ObjectLiteralExpression
            || !initial.properties().is_empty()
        {
            return;
        }
        let function = node.parent();
        let file = get_source_file_of_node(function);
        let text = source_frontend::prelude::source_file_text(file);
        // Documentation alone is fine; explicit JSDoc input types retain the
        // checked ABI instead of being silently erased.
        let mut owners = vec![node, function];
        let mut parent = function.parent();
        while matches!(
            parent.kind(),
            SyntaxKind::VariableDeclaration
                | SyntaxKind::VariableDeclarationList
                | SyntaxKind::VariableStatement
        ) {
            owners.push(parent);
            parent = parent.parent();
        }
        let parameter_name = node.name().text().to_string();
        for owner in owners {
            let token = source_frontend::prelude::get_token_pos_of_node(owner, file, false)
                .max(owner.pos())
                .max(0) as usize;
            let Some(prefix) = text.get(owner.pos().max(0) as usize..token) else {
                return;
            };
            if prefix.contains("@type")
                || prefix.lines().any(|line| {
                    let Some((_, tail)) = line.split_once("@param") else {
                        return false;
                    };
                    let mut tail = tail.trim_start();
                    if tail.starts_with('{') {
                        let Some(end) = tail.find('}') else {
                            return true;
                        };
                        tail = tail[end + 1..].trim_start();
                    }
                    let documented = tail
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .trim_start_matches('[')
                        .trim_start_matches("...")
                        .split(['=', ']'])
                        .next()
                        .unwrap_or_default();
                    documented == parameter_name
                })
            {
                let source = self.checker.get_type_at_location(node.name());
                let symbol = self.symbol(node.name());
                if symbol != 0
                    && let Some(ty) = self.type_id(source)
                {
                    // An explicit JSDoc object contract owns this parameter's
                    // ABI. In particular its optional fields must not be
                    // replaced later by the closed shape of one supplied
                    // object literal; the empty default observes absence.
                    self.js_parameter_types.insert(symbol, ty);
                }
                return;
            }
        }
        // Select ownership before callable signatures or record layouts are
        // cached. Keep reads, aliases and private return values on that same
        // ABI instead of projecting the live object into the inferred {}.
        let source = self.checker.get_type_at_location(node.name());
        let arms = if self.checker.ty(source).flags.intersects(TypeFlags::UNION) {
            self.checker.ty(source).types().to_vec()
        } else {
            vec![source]
        };
        if arms.iter().any(|id| {
            let flags = self.checker.ty(*id).flags;
            !flags.intersects(TypeFlags::UNDEFINED)
                && (!flags.intersects(TypeFlags::OBJECT)
                    || !self.checker.get_properties_of_type(*id).is_empty()
                    || !self.checker.get_index_infos_of_type(*id).is_empty())
        }) {
            return;
        }
        let symbol = self.symbol(node.name());
        if symbol == 0 {
            return;
        }
        self.data_bindings.insert(symbol);
        self.data_types.insert(source);
        for id in arms {
            if self.checker.ty(id).flags.intersects(TypeFlags::OBJECT) {
                self.data_types.insert(id);
            }
        }
        self.data_types
            .insert(self.checker.get_type_at_location(initial));
    }

    pub(super) fn plan_parameter_abi(&mut self, files: &[Node]) {
        let mut functions = Vec::new();
        let mut calls = Vec::new();
        let mut assignments = Vec::new();
        for file in files {
            collect(*file, &mut functions, &mut calls, &mut assignments);
        }
        // JavaScript parameters are mutable local bindings even when JSDoc or
        // a declaration describes only their incoming type. Plan an owning
        // dynamic slot before signatures are cached when a later assignment
        // can install a value outside that contract.
        let mut javascript_parameters = HashMap::new();
        for function in functions
            .iter()
            .copied()
            .filter(|node| is_javascript(*node))
        {
            for parameter in receivers::parameters(function) {
                if parameter.name().kind() != SyntaxKind::Identifier
                    || !parameter.dot_dot_dot_token().is_nil()
                {
                    continue;
                }
                let symbol = self.parameter_symbol(parameter);
                if symbol != 0 {
                    javascript_parameters.insert(symbol, parameter);
                }
            }
        }
        for assignment in &assignments {
            let symbol = self.symbol(assignment.left());
            let Some(parameter) = javascript_parameters.get(&symbol).copied() else {
                continue;
            };
            let checked = self.checker.get_type_at_location(parameter);
            let Some(expected) = self.type_id(checked) else {
                continue;
            };
            if expected == Type::Dyn {
                continue;
            }
            let actual = self
                .planned_argument_type(assignment.right())
                .or_else(|| self.ty(assignment.right()).ok());
            if actual.as_ref().is_some_and(|actual| {
                *actual == Type::Dyn || !self.contextual_result_compatible(actual, &expected)
            }) {
                self.data_bindings.insert(symbol);
                self.js_parameter_types.insert(symbol, Type::Dyn);
            }
        }
        let mut targets = HashMap::new();
        let mut parameter_owners = HashMap::new();
        let mut return_edges = Vec::new();
        for function in functions.iter().copied() {
            let javascript = is_javascript(function);
            let declared = self.declared(function).is_some();
            let declared_generator_iterable = javascript
                && self.declared(function).is_some_and(|hint| {
                    hint.params
                        .iter()
                        .flatten()
                        .any(|ty| matches!(ty, Type::Generator { r#async: false, .. }))
                });
            let declared_erased_parameter = javascript
                && self
                    .declared(function)
                    .is_some_and(|hint| hint.params.iter().flatten().any(|ty| *ty == Type::Dyn));
            if (!javascript
                && !matches!(
                    function.kind(),
                    SyntaxKind::FunctionDeclaration | SyntaxKind::Constructor
                ))
                || (function.kind() != SyntaxKind::Constructor
                    && declared
                    && !declared_generator_iterable
                    && !declared_erased_parameter)
            {
                continue;
            }
            if function.kind() == SyntaxKind::MethodDeclaration
                && (function.parent().kind() != SyntaxKind::ClassDeclaration
                    || function.modifier_flags().intersects(ModifierFlags::STATIC)
                    || function.name().kind() != SyntaxKind::Identifier)
            {
                continue;
            }
            if function.parent().kind() == SyntaxKind::VariableDeclaration
                && self.declared(function.parent()).is_some()
            {
                continue;
            }
            if javascript {
                for param in receivers::parameters(function) {
                    self.plan_default_object_parameter(param);
                }
            }
            let binding = if function.kind() == SyntaxKind::Constructor {
                let class = function.parent();
                if !matches!(
                    class.kind(),
                    SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                ) {
                    continue;
                }
                if !class.name().is_nil() {
                    class.name()
                } else if class.parent().kind() == SyntaxKind::VariableDeclaration {
                    class.parent().name()
                } else {
                    continue;
                }
            } else if matches!(
                function.kind(),
                SyntaxKind::FunctionDeclaration | SyntaxKind::MethodDeclaration
            ) {
                function.name()
            } else if function.parent().kind() == SyntaxKind::VariableDeclaration {
                let declaration = function.parent();
                if self.declared(declaration).is_some() {
                    continue;
                }
                declaration.name()
            } else {
                continue;
            };
            if binding.is_nil() || binding.kind() != SyntaxKind::Identifier {
                continue;
            }
            let symbol = self.symbol(binding);
            if symbol != 0 {
                let params = receivers::parameters(function);
                for param in &params {
                    if param.name().kind() == SyntaxKind::Identifier {
                        parameter_owners.insert(self.symbol(param.name()), symbol);
                    }
                }
                targets.insert(symbol, params);
                if function.kind() == SyntaxKind::FunctionDeclaration && !function.body().is_nil() {
                    // Unannotated JavaScript inference can collapse a private
                    // scalar success path to its concrete arm even though an
                    // early `return undefined` remains observable. Feed JS
                    // declarations into the same monotone absence analysis as
                    // TS declarations so the function ABI is widened before
                    // any caller or body is lowered.
                    let mut returns = Vec::new();
                    collect_returns(function.body(), &mut returns);
                    return_edges.extend(returns.into_iter().map(|value| (symbol, value)));
                }
            }
        }
        let target_symbols = targets.keys().copied().collect::<HashSet<_>>();
        let mut escaping = HashSet::new();
        for file in files {
            self.collect_escaping_private_functions(*file, &target_symbols, &mut escaping);
        }
        let mut direct_calls = HashMap::<u32, Vec<Vec<Node>>>::new();
        for call in calls.iter().copied() {
            let target = self.call_target(call.expression(), &mut HashSet::new());
            if target != 0 {
                direct_calls
                    .entry(target)
                    .or_default()
                    .push(call.arguments().into_iter().collect());
            }
        }
        let mut edges = Vec::new();
        for call in calls.iter().copied() {
            let target = self.call_target(call.expression(), &mut HashSet::new());
            let Some(params) = targets.get(&target) else {
                continue;
            };
            let arguments: Vec<_> = call.arguments().into_iter().collect();
            // A spread has no fixed source slots in this frontend contract.
            if arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
            {
                continue;
            }
            for (index, param) in params.iter().copied().enumerate() {
                if param.name().kind() != SyntaxKind::Identifier
                    || !param.dot_dot_dot_token().is_nil()
                {
                    continue;
                }
                let symbol = self.symbol(param.name());
                edges.push((symbol, arguments.get(index).copied()));
            }
        }
        // JavaScript and JSDoc declarations are descriptive, not an invariant
        // boundary: packages routinely call their own helpers with values
        // outside the published annotation. Meet every direct call site before
        // lowering the implementation so those slots retain the owning dynamic
        // representation instead of coercing unrelated scalars into a union.
        for function in functions
            .iter()
            .copied()
            .filter(|function| is_javascript(*function))
        {
            let binding = if function.kind() == SyntaxKind::Constructor {
                let class = function.parent();
                if matches!(
                    class.kind(),
                    SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                ) && !class.name().is_nil()
                {
                    class.name()
                } else if class.parent().kind() == SyntaxKind::VariableDeclaration {
                    class.parent().name()
                } else {
                    Node::NIL
                }
            } else if matches!(
                function.kind(),
                SyntaxKind::FunctionDeclaration | SyntaxKind::MethodDeclaration
            ) {
                function.name()
            } else if function.parent().kind() == SyntaxKind::VariableDeclaration {
                function.parent().name()
            } else {
                Node::NIL
            };
            if binding.is_nil() || binding.kind() != SyntaxKind::Identifier {
                continue;
            }
            let target = self.symbol(binding);
            if target == 0 {
                continue;
            }
            let params = receivers::parameters(function);
            let Some(call_sets) = direct_calls.get(&target) else {
                continue;
            };
            for arguments in call_sets {
                for (index, parameter) in params.iter().copied().enumerate() {
                    if parameter.name().kind() != SyntaxKind::Identifier
                        || !parameter.dot_dot_dot_token().is_nil()
                    {
                        continue;
                    }
                    let Some(argument) = arguments.get(index).copied() else {
                        continue;
                    };
                    let checked = self.checker.get_type_at_location(parameter);
                    // Use the paired declaration when its indexed-object
                    // union needs the owning-argument check below. Inferred
                    // `any` would otherwise hide the incompatible layout
                    // until after that declaration-based ABI was fixed.
                    let Some(expected) = self
                        .declared(function)
                        .and_then(|hint| hint.params.get(index).cloned().flatten())
                        .filter(|ty| matches!(ty, Type::Union { union_id }
                            if self.unions[*union_id].arms.iter().any(|arm|
                                matches!(arm, Type::Record { shape_id }
                                    if self.records[*shape_id].index_value.is_some()))))
                        .or_else(|| self.type_id(checked))
                    else {
                        continue;
                    };
                    let actual = self
                        .planned_argument_type(argument)
                        .or_else(|| self.ty(argument).ok());
                    if actual.as_ref().is_some_and(|actual| {
                        let callback_width_mismatch = matches!(
                            (actual, &expected),
                            (
                                Type::Func {
                                    params: actual,
                                    rest: false,
                                    ..
                                },
                                Type::Func {
                                    params: expected,
                                    rest: false,
                                    ..
                                }
                            ) if actual.len() > expected.len()
                        );
                        // A declared JSON-like union can contain an indexed
                        // object arm, while a caller owns a closed record.
                        // The dynamic record cannot be checked as that union
                        // just by accepting its structural annotation: the
                        // union's tagged object arm has a different layout.
                        // Keep the JavaScript parameter's owning value instead.
                        let indexed_object_union = matches!(actual, Type::Record { .. } | Type::Dyn)
                            && matches!(&expected, Type::Union { union_id }
                                if self.unions[*union_id].arms.iter().any(|arm|
                                    matches!(arm, Type::Record { shape_id }
                                        if self.records[*shape_id].index_value.is_some())));
                        callback_width_mismatch
                            || indexed_object_union
                            || !self.contextual_result_compatible(actual, &expected)
                    }) {
                        let symbol = self.parameter_symbol(parameter);
                        if symbol != 0 {
                            self.js_parameter_types.insert(symbol, Type::Dyn);
                        }
                    }
                }
            }
        }
        // TypeScript declarations also erase at runtime. A JSON-like indexed
        // union cannot safely adopt a caller's concrete record by merely
        // checking its tag; preserve the record owner at every direct call.
        // The body's normal typed operations still have to validate their
        // actual inputs, and the function keeps its declared result ABI.
        let mut asserted_binding_parameters = HashSet::new();
        for function in functions.iter().copied().filter(|function| {
            !is_javascript(*function)
                && function.kind() == SyntaxKind::FunctionDeclaration
                && !function.name().is_nil()
                && !function.body().is_nil()
        }) {
            let target = self.symbol(function.name());
            let Some(call_sets) = direct_calls.get(&target) else {
                continue;
            };
            for (index, parameter) in receivers::parameters(function).into_iter().enumerate() {
                if parameter.name().kind() != SyntaxKind::Identifier
                    || !parameter.dot_dot_dot_token().is_nil()
                {
                    continue;
                }
                if !escaping.contains(&target)
                    && matches!(self.ty(parameter.name()), Ok(Type::F64 | Type::String | Type::Bool | Type::Bigint | Type::Symbol))
                    && call_sets.iter().any(|arguments| arguments.get(index)
                        .is_some_and(|argument| self.asserted_array_binding_argument(*argument)))
                {
                    // Array destructuring can yield undefined even when the
                    // checker infers a scalar and the source asserts `!`.
                    let symbol = self.parameter_symbol(parameter);
                    if symbol != 0 {
                        self.js_parameter_types.insert(symbol, Type::Dyn);
                        asserted_binding_parameters.insert(symbol);
                    }
                    continue;
                }
                let checked = self.checker.get_type_at_location(parameter);
                // Imported aliases can give the parameter node an `any`
                // checker view while its identifier retains the declared
                // union used by signature construction.
                let name_type = self.ty(parameter.name()).ok();
                let planned_type = name_type
                    .filter(|ty| matches!(ty, Type::Union { .. }))
                    .or_else(|| self.type_id(checked));
                let Some(Type::Union { union_id }) = planned_type else {
                    continue;
                };
                if !self.unions[union_id].arms.iter().any(|arm| {
                    matches!(arm, Type::Record { shape_id }
                        if self.records[*shape_id].index_value.is_some())
                }) {
                    continue;
                }
                let requires_owner = call_sets.iter().any(|arguments| {
                    arguments.get(index).is_some_and(|argument| {
                        self.planned_argument_type(*argument)
                            .or_else(|| self.ty(*argument).ok())
                            .is_some_and(|ty| matches!(ty, Type::Record { .. } | Type::Dyn))
                    })
                });
                if requires_owner {
                    let symbol = self.parameter_symbol(parameter);
                    if symbol != 0 {
                        self.js_parameter_types.insert(symbol, Type::Dyn);
                    }
                }
            }
        }
        // JSON.stringify and an asserted indexed read can return undefined.
        // Direct forwarding functions retain that owning result even when
        // their declarations advertise a narrower scalar.
        let mut owning_return_edges = Vec::new();
        let mut owning_value_functions = HashSet::new();
        for function in functions.iter().copied().filter(|function| {
            function.kind() == SyntaxKind::FunctionDeclaration
                && !function.name().is_nil()
                && !function.body().is_nil()
                && function.asterisk_token().is_nil()
        }) {
            let symbol = self.symbol(function.name());
            if symbol == 0 {
                continue;
            }
            let dynamic_parameter = receivers::parameters(function).into_iter().any(|parameter| {
                let id = self.parameter_symbol(parameter);
                self.js_parameter_types.get(&id) == Some(&Type::Dyn)
            });
            let mut returned = Vec::new();
            collect_returns(function.body(), &mut returned);
            for value in returned.into_iter().filter(|value| !value.is_nil()) {
                if (dynamic_parameter && self.json_stringify_result(value))
                    || self.array_asserted_live_element(value)
                {
                    owning_value_functions.insert(symbol);
                }
                let value = primitives::primitive_source(value);
                if value.kind() == SyntaxKind::CallExpression {
                    let callee = self.call_target(value.expression(), &mut HashSet::new());
                    if callee != 0 {
                        owning_return_edges.push((symbol, callee));
                    }
                }
            }
        }
        loop {
            let mut changed = false;
            for (caller, callee) in &owning_return_edges {
                if owning_value_functions.contains(callee) {
                    changed |= owning_value_functions.insert(*caller);
                }
            }
            if !changed {
                break;
            }
        }
        self.nominal_return_functions.extend(owning_value_functions);
        // A structural interface parameter may receive a concrete class at a
        // `new` boundary.  A class instance cannot be copied into the record
        // payload used by an optional interface union: doing so loses its
        // nominal identity, methods, accessors and mutations.  Select the
        // owning NativeValue ABI before constructor signatures and class
        // fields are cached.  Repeat so a derived constructor forwarding its
        // parameter through `super(...)` carries the same decision into the
        // base constructor.
        // Published JavaScript declarations and JSDoc can describe a narrower
        // result than the implementation really returns. This is an ordinary
        // function ABI decision and must not depend on whether the nominal
        // class inventory happened to be ready for this planning pass.
        for function in functions.iter().copied() {
            if function.body().is_nil()
                || function.name().is_nil()
                || !parameter_abi::is_javascript(function)
                || !function.asterisk_token().is_nil()
            {
                continue;
            }
            let signature = self.checker.get_signature_from_declaration(function);
            let checked_result = self.checker.get_return_type_of_signature(signature);
            // `get_return_type_of_signature` sees the JavaScript
            // implementation signature. A paired declaration or inherited
            // public contract can be narrower and is the ABI that
            // `function_signature` will actually publish, so compare against
            // that same contract here.
            let expected = self
                .declared(function)
                .and_then(|hint| hint.ret.clone())
                .or_else(|| self.type_id(checked_result));
            let Some(expected) = expected else {
                continue;
            };
            let mut returns = Vec::new();
            collect_returns(function.body(), &mut returns);
            let implementation_result =
                if function.modifier_flags().intersects(ModifierFlags::ASYNC) {
                    match &expected {
                        Type::Promise { inner } => inner.as_ref(),
                        _ => &expected,
                    }
                } else {
                    &expected
                };
            let returns_incompatible = returns.iter().copied().any(|expression| {
                if expression.is_nil() {
                    return false;
                }
                let checked = self.checker.get_type_at_location(expression);
                self.type_id(checked).is_some_and(|actual| {
                    !self.contextual_result_compatible(&actual, implementation_result)
                })
            });
            if std::env::var_os("SCRIPTC_TRACE_RETURN_ABI").is_some() {
                let actual = returns
                    .iter()
                    .copied()
                    .filter(|expression| !expression.is_nil())
                    .filter_map(|expression| {
                        let checked = self.checker.get_type_at_location(expression);
                        self.type_id(checked)
                    })
                    .collect::<Vec<_>>();
                eprintln!(
                    "scriptc: return-abi name={} symbol={} expected={expected:?} implementation={implementation_result:?} actual={actual:?} incompatible={returns_incompatible}",
                    function.name().text(),
                    self.symbol(function.name()),
                );
            }
            if returns_incompatible {
                let symbol = self.symbol(function.name());
                if symbol != 0 {
                    self.nominal_return_functions.insert(symbol);
                }
            }
        }
        if self.class_inventory_ready() {
            loop {
                let mut changed = false;
                for (symbol, argument) in &edges {
                    let declaration = self.checker.sym(SymbolId(*symbol)).value_declaration;
                    if declaration.is_nil() || declaration.kind() != SyntaxKind::Parameter {
                        continue;
                    }
                    let checked = self.checker.get_type_at_location(declaration);
                    let Some(expected) = self.type_id(checked) else {
                        continue;
                    };
                    if !self.structural_record_parameter_abi(&expected) {
                        continue;
                    }
                    let nominal = if let Some(argument) = argument {
                        let reference = receivers::reference_node(*argument);
                        let source_symbol = (reference.kind() == SyntaxKind::Identifier)
                            .then(|| self.symbol(reference))
                            .unwrap_or(0);
                        let checked_source = self.checker.get_type_at_location(reference);
                        matches!(self.type_id(checked_source), Some(Type::Object { .. }))
                            || source_symbol != 0 && self.data_bindings.contains(&source_symbol)
                    } else {
                        false
                    };
                    if nominal {
                        changed |= self.data_bindings.insert(*symbol);
                        self.data_types.insert(checked);
                    }
                }
                if !changed {
                    break;
                }
            }
            for function in functions.iter().copied() {
                if function.body().is_nil() || function.name().is_nil() {
                    continue;
                }
                let signature = self.checker.get_signature_from_declaration(function);
                let checked_result = self.checker.get_return_type_of_signature(signature);
                let Some(expected) = self.type_id(checked_result) else {
                    continue;
                };
                let mut returns = Vec::new();
                collect_returns(function.body(), &mut returns);
                if !self.structural_record_result_abi(&expected) {
                    continue;
                }
                let returns_nominal = returns.iter().copied().any(|expression| {
                    if expression.is_nil() {
                        return false;
                    }
                    let checked = self.checker.get_type_at_location(expression);
                    self.type_id(checked)
                        .is_some_and(|actual| self.nominal_object_result_abi(&actual))
                });
                if returns_nominal {
                    let symbol = self.symbol(function.name());
                    if symbol != 0 {
                        self.nominal_return_functions.insert(symbol);
                    }
                    let owning_view = if matches!(expected, Type::Promise { .. }) {
                        self.checker
                            .get_type_arguments(checked_result)
                            .first()
                            .copied()
                    } else {
                        Some(checked_result)
                    };
                    if let Some(owning_view) = owning_view {
                        self.data_types.insert(owning_view);
                        let names = self
                            .checker
                            .get_properties_of_type(owning_view)
                            .iter()
                            .map(|property| self.checker.sym(*property).name.to_string())
                            .collect();
                        self.classes.defer_interface_methods(owning_view, names);
                    }
                }
            }
        }
        // A private function whose identity never escapes is a closed-world
        // callable. If every direct call supplies the same represented type,
        // use that type for an otherwise-erased JavaScript parameter. Repeat
        // to propagate contracts through private function-to-function calls.
        loop {
            let mut changed = false;
            let mut candidates: HashMap<u32, Vec<Option<Node>>> = HashMap::new();
            for (symbol, argument) in &edges {
                candidates.entry(*symbol).or_default().push(*argument);
            }
            for (symbol, arguments) in candidates {
                let Some(owner) = parameter_owners.get(&symbol) else {
                    continue;
                };
                if asserted_binding_parameters.contains(&symbol) {
                    continue;
                }
                let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                let function = declaration.parent();
                let parameter_index = receivers::parameters(function)
                    .iter()
                    .position(|candidate| *candidate == declaration);
                let published_erased = parameter_index.is_some_and(|index| {
                    self.declared(function)
                        .and_then(|hint| hint.params.get(index))
                        .and_then(|ty| ty.as_ref())
                        == Some(&Type::Dyn)
                });
                let parametric_callback = parameter_index.is_some_and(|index| {
                    self.declared(function)
                        .and_then(|hint| hint.parametric_callback_results.get(index))
                        .copied()
                        .unwrap_or(false)
                });
                if published_erased || parametric_callback {
                    // A published erased slot has one JavaScript implementation
                    // for every admitted value. In particular, `getter: () =>
                    // T` must retain its function object as an owning value.
                    // Specializing either contract from the first call splits
                    // later aliases/reexports and corrupts the public ABI.
                    if self.js_parameter_types.get(&symbol) != Some(&Type::Dyn) {
                        self.js_parameter_types.insert(symbol, Type::Dyn);
                        changed = true;
                    }
                    continue;
                }
                // A pre-inventory pass may only be able to prove Dyn for a
                // `new SourceClass()` value in emitted JavaScript. Preserve
                // every concrete decision, but allow the post-class-inventory
                // pass to monotonically refine that erased placeholder.
                let generator_refinement = self
                    .js_parameter_types
                    .get(&symbol)
                    .is_some_and(|ty| matches!(ty, Type::Generator { .. }));
                if self
                    .js_parameter_types
                    .get(&symbol)
                    .is_some_and(|ty| *ty != Type::Dyn)
                    && !generator_refinement
                {
                    continue;
                }
                let mut inferred = None;
                let mut valid = true;
                for argument in arguments {
                    let Some(argument) = argument else {
                        continue;
                    };
                    let planned = self.planned_argument_type(argument);
                    let Some(ty) = planned else {
                        valid = false;
                        break;
                    };
                    if inferred.as_ref().is_some_and(|current| *current != ty) {
                        valid = false;
                        break;
                    }
                    inferred = Some(ty);
                }
                let source = self.checker.get_type_at_location(declaration);
                let erased = self
                    .checker
                    .ty(source)
                    .flags
                    .intersects(TypeFlags::ANY | TypeFlags::UNKNOWN);
                let published_generator = parameter_index.is_some_and(|index| {
                    self.declared(function)
                        .and_then(|hint| hint.params.get(index))
                        .and_then(|ty| ty.as_ref())
                        .is_some_and(|ty| matches!(ty, Type::Generator { r#async: false, .. }))
                });
                let paired_erased_generator = erased
                    && escaping.contains(owner)
                    && self.declared(function).is_some()
                    && inferred
                        .as_ref()
                        .is_some_and(|ty| matches!(ty, Type::Generator { .. }));
                let expected_iterable = self.type_id(source);
                let synchronous_iterable = inferred.clone().and_then(|ty| {
                    expected_iterable
                        .as_ref()
                        .and_then(|expected| self.synchronous_iterable_argument(ty, expected))
                });
                let generator_iterable = synchronous_iterable.is_some()
                    && (self.standard_iterator_type(source) || erased);
                let generator_union = inferred.clone().filter(|ty| {
                    matches!(ty, Type::Union { .. })
                        && self.synchronous_generator_argument(ty.clone()).is_some()
                });
                let escaping_erased_generator = erased
                    && escaping.contains(owner)
                    && generator_union.is_some()
                    && !published_generator;
                let published_generator_union = published_generator && generator_union.is_some();
                let selected = if escaping_erased_generator && !paired_erased_generator {
                    Some(Type::Dyn)
                } else {
                    generator_union
                        .clone()
                        .or_else(|| synchronous_iterable.clone())
                        .or_else(|| inferred.clone())
                };
                let trace_filter = std::env::var("SCRIPTC_TRACE_PARAMETER_ABI").ok();
                let trace_owner = declaration.parent();
                let trace_name = if trace_owner.name().is_nil() {
                    ""
                } else {
                    trace_owner.name().text()
                };
                if trace_filter.as_deref().is_some_and(|filter| {
                    filter.is_empty()
                        || filter == "all"
                        || trace_name.contains(filter)
                        || (filter == "legacy"
                            && (generator_refinement
                                || generator_union.is_some()
                                || declaration.parent().kind() == SyntaxKind::MethodDeclaration))
                }) {
                    eprintln!(
                        "scriptc: parameter ABI owner={} param={} existing={:?} inferred={inferred:?} expected={expected_iterable:?} selected={:?} valid={valid} escaping={}",
                        trace_name,
                        declaration.name().text(),
                        self.js_parameter_types.get(&symbol),
                        selected,
                        escaping.contains(owner),
                    );
                }
                let child_borrow = valid
                    && !escaping.contains(owner)
                    && inferred.as_ref() == Some(&Type::Child)
                    && expected_iterable.as_ref().is_some_and(|ty| {
                        let Type::Record { shape_id } = ty else {
                            return false;
                        };
                        let record = &self.records[*shape_id];
                        !record.tuple
                            && record.fields.len() == 2
                            && record
                                .fields
                                .iter()
                                .any(|field| field.name == "pid" && field.r#type == Type::F64)
                            && record.fields.iter().any(|field| {
                                field.name == "kill"
                                    && matches!(&field.r#type, Type::Func { params, ret, .. }
                                        if params.len() == 1 && **ret == Type::Void)
                            })
                    });
                let published_concrete = valid
                    && parameter_index.is_some_and(|index| {
                        self.declared(function)
                            .and_then(|hint| hint.params.get(index))
                            .and_then(|ty| ty.as_ref())
                            .is_some_and(|ty| *ty != Type::Dyn)
                    })
                    && expected_iterable
                        .as_ref()
                        .is_some_and(|expected| inferred.as_ref() == Some(expected));
                if valid
                    && ((erased && !escaping.contains(owner))
                        || generator_iterable
                        || child_borrow
                        || published_concrete
                        || escaping_erased_generator
                        || paired_erased_generator
                        || published_generator_union)
                    && let Some(ty) = selected
                    && self.js_parameter_types.get(&symbol) != Some(&ty)
                {
                    self.js_parameter_types.insert(symbol, ty);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        // Monotone union of every call demand, including chains of parameters.
        // No generated function can freeze its slots from the first call site.
        loop {
            let mut changed = false;
            for (symbol, argument) in &edges {
                if argument.is_some_and(|argument| {
                    receivers::reference_node(argument).kind() == SyntaxKind::NullKeyword
                }) {
                    changed |= self.js_null_parameters.insert(*symbol);
                }
                let declaration = self.checker.sym(SymbolId(*symbol)).value_declaration;
                let published_required = if declaration.is_nil()
                    || declaration.kind() != SyntaxKind::Parameter
                    || !declaration.question_token().is_nil()
                    || !declaration.initializer().is_nil()
                {
                    false
                } else {
                    let function = declaration.parent();
                    let index = receivers::parameters(function)
                        .iter()
                        .position(|candidate| *candidate == declaration);
                    index
                        .and_then(|index| {
                            let hint = self.declared(function)?;
                            if hint.optional.get(index).copied().unwrap_or(false) {
                                return Some(false);
                            }
                            hint.params
                                .get(index)
                                .and_then(|ty| ty.as_ref())
                                .map(|ty| !self.optional_storage(ty))
                        })
                        .unwrap_or(false)
                };
                if published_required {
                    // A paired declaration owns this public call contract.
                    // Closed-world call inference may refine an erased
                    // implementation, but it must not make a required
                    // published parameter optional merely because an alias or
                    // recursive call has an imprecise checker projection.
                    continue;
                }
                if !self.js_absence_parameters.contains(symbol)
                    && argument.is_none_or(|arg| {
                        !self.guarded_capture_site(receivers::reference_node(arg))
                            && self.argument_may_be_absent(arg, &mut HashSet::new())
                    })
                {
                    changed |= self.js_absence_parameters.insert(*symbol);
                }
            }
            for assignment in &assignments {
                let symbol = self.symbol(assignment.left());
                if symbol == 0 || self.absence_assignments.contains(&symbol) {
                    continue;
                }
                let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                if !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && !self.guarded_truthy_assignment_site(assignment.right())
                    && self.argument_may_be_absent(assignment.right(), &mut HashSet::new())
                {
                    changed |= self.absence_assignments.insert(symbol);
                }
            }
            for (symbol, value) in &return_edges {
                if !self.absence_returns.contains(symbol)
                    && self.argument_may_be_absent(*value, &mut HashSet::new())
                {
                    changed |= self.absence_returns.insert(*symbol);
                }
            }
            if !changed {
                break;
            }
        }
    }

    fn commonjs_destructured_call_target(&mut self, node: Node) -> Option<u32> {
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let lexical = self
            .commonjs_lexical_symbol(node)
            .unwrap_or_else(|| self.checker.get_symbol_at_location(node, false));
        if lexical.0 == 0 {
            return None;
        }
        let checked = self.checker.sym(lexical).value_declaration;
        let binding = if !checked.is_nil()
            && checked.kind() == SyntaxKind::BindingElement
            && checked.parent().kind() == SyntaxKind::ObjectBindingPattern
        {
            checked
        } else {
            // The JavaScript checker may resolve a destructured require use
            // straight to the exported declaration. Recover the lexical
            // binding syntax so the CommonJS module edge remains visible to
            // the closed-world ABI planner.
            get_source_file_of_node(node)
                .statements()
                .into_iter()
                .find_map(|statement| {
                    if statement.kind() != SyntaxKind::VariableStatement {
                        return None;
                    }
                    statement
                        .declaration_list()
                        .declarations()
                        .nodes()
                        .into_iter()
                        .find_map(|declaration| {
                            (declaration.name().kind() == SyntaxKind::ObjectBindingPattern)
                                .then(|| {
                                    declaration.name().elements().into_iter().find(|element| {
                                        element.name().kind() == SyntaxKind::Identifier
                                            && element.name().text() == node.text()
                                    })
                                })
                                .flatten()
                        })
                })?
        };
        let declaration = binding.parent().parent();
        if declaration.kind() != SyntaxKind::VariableDeclaration
            || declaration.initializer().is_nil()
        {
            return None;
        }
        let required = receivers::reference_node(declaration.initializer());
        let file = self.commonjs_require_file(required)?;
        let export = if binding.property_name().is_nil() {
            binding.name().text()
        } else {
            binding.property_name().text()
        };
        file.statements().into_iter().find_map(|statement| {
            (statement.kind() == SyntaxKind::FunctionDeclaration
                && !statement.name().is_nil()
                && statement.name().text() == export)
                .then(|| self.symbol(statement.name()))
                .filter(|symbol| *symbol != 0)
        })
    }

    pub(super) fn call_target(&mut self, node: Node, seen: &mut HashSet<u32>) -> u32 {
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::SuperKeyword {
            let mut owner = node.parent();
            while !owner.is_nil() && owner.kind() != SyntaxKind::Constructor {
                owner = owner.parent();
            }
            if owner.is_nil() {
                return 0;
            }
            let class = owner.parent();
            for clause in class.heritage_clauses().nodes() {
                if clause.token() != SyntaxKind::ExtendsKeyword {
                    continue;
                }
                let types = clause.types().nodes().into_iter().collect::<Vec<_>>();
                if let [base] = types.as_slice() {
                    return self.call_target(base.expression(), seen);
                }
            }
            return 0;
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression {
            let symbol = self.symbol(node.name());
            if symbol == 0 || !seen.insert(symbol) {
                return 0;
            }
            let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
            return if !declaration.is_nil()
                && declaration.kind() == SyntaxKind::MethodDeclaration
                && declaration.parent().kind() == SyntaxKind::ClassDeclaration
            {
                // A JavaScript property access may carry a transient
                // structural property symbol distinct from the declaration
                // symbol. Canonicalize on the method declaration so the
                // whole-program call edge meets the parameter owner.
                self.symbol(declaration.name())
            } else {
                0
            };
        }
        if node.kind() != SyntaxKind::Identifier {
            return 0;
        }
        if let Some(target) = self.commonjs_destructured_call_target(node) {
            return target;
        }
        let lexical = self.checker.get_symbol_at_location(node, false);
        let symbol = if lexical.0 != 0
            && self
                .checker
                .sym(lexical)
                .flags
                .intersects(SymbolFlags::ALIAS)
        {
            // Direct ESM imports must meet the parameter owner registered on
            // the exported declaration. Keeping the local ImportSpecifier
            // symbol here silently drops constructor and function call edges.
            self.checker.get_aliased_symbol(lexical).0
        } else {
            self.symbol(node)
        };
        if symbol == 0 || !seen.insert(symbol) {
            return 0;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && !declaration.initializer().is_nil()
        {
            let initial = receivers::reference_node(declaration.initializer());
            if initial.kind() == SyntaxKind::Identifier {
                // Only immutable aliases denote one target throughout execution.
                if declaration.parent().flags().intersects(NodeFlags::CONST) {
                    return self.call_target(initial, seen);
                }
                return 0;
            }
        }
        symbol
    }

    pub(super) fn bytes_named_key_value(&mut self, node: Node, seen: &mut HashSet<u32>) -> bool {
        let node = primitives::primitive_source(node);
        if node.is_nil() {
            return false;
        }
        match node.kind() {
            SyntaxKind::ElementAccessExpression => {
                self.argument_may_be_absent(node.argument_expression(), &mut HashSet::new())
                    && self.ty(node.expression()).is_ok_and(|ty| {
                        self.native_type_contains(&ty, |arm| matches!(arm, Type::Bytes { .. }))
                    })
            }
            SyntaxKind::Identifier => {
                let symbol = self.symbol(node);
                if symbol == 0 || !seen.insert(symbol) {
                    return false;
                }
                let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && !declaration.initializer().is_nil()
                    && self.bytes_named_key_value(declaration.initializer(), seen)
            }
            SyntaxKind::ConditionalExpression => {
                self.bytes_named_key_value(node.when_true(), &mut seen.clone())
                    || self.bytes_named_key_value(node.when_false(), seen)
            }
            SyntaxKind::BinaryExpression
                if matches!(
                    node.operator_token().kind(),
                    SyntaxKind::QuestionQuestionToken
                        | SyntaxKind::BarBarToken
                        | SyntaxKind::AmpersandAmpersandToken
                ) =>
            {
                self.bytes_named_key_value(node.left(), &mut seen.clone())
                    || self.bytes_named_key_value(node.right(), seen)
            }
            _ => false,
        }
    }

    pub(super) fn argument_may_be_absent(&mut self, node: Node, seen: &mut HashSet<u32>) -> bool {
        if node.is_nil() {
            return true;
        }
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::Identifier && node.text() == "undefined" {
            let symbol = self.symbol(node);
            if symbol == 0
                || self
                    .checker
                    .sym(SymbolId(symbol))
                    .value_declaration
                    .is_nil()
            {
                // Contextual JavaScript return inference can report the global
                // `undefined` identifier as the successful scalar arm. Match
                // expression lowering's global-identifier proof instead of
                // relying only on that contextual checker type.
                return true;
            }
        }
        if self.planned_field_read(node) {
            return true;
        }
        let ty = self.checker.get_type_at_location(node);
        if self.source_has_undefined(ty) {
            return true;
        }
        match node.kind() {
            SyntaxKind::NonNullExpression => self.argument_may_be_absent(node.expression(), seen),
            SyntaxKind::VoidExpression => true,
            SyntaxKind::CallExpression => {
                let target = self.call_target(node.expression(), &mut HashSet::new());
                target != 0 && self.absence_returns.contains(&target)
            }
            SyntaxKind::Identifier => {
                let symbol = self.symbol(node);
                if self.js_absence_parameters.contains(&symbol)
                    || self.absence_assignments.contains(&symbol)
                {
                    return true;
                }
                if symbol == 0 || !seen.insert(symbol) {
                    return false;
                }
                let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && !declaration.initializer().is_nil()
                    && self.argument_may_be_absent(declaration.initializer(), seen)
            }
            SyntaxKind::ElementAccessExpression => {
                if self
                    .literal_property_key(node.argument_expression())
                    .as_deref()
                    == Some("length")
                {
                    return false;
                }
                let receiver = receivers::reference_node(node.expression());
                let name = if receiver.kind() == SyntaxKind::PropertyAccessExpression {
                    receiver.name()
                } else {
                    receiver
                };
                let symbol = self.symbol(name);
                let source = if symbol != 0 {
                    self.checker.get_type_of_symbol(SymbolId(symbol))
                } else {
                    self.checker.get_type_at_location(receiver)
                };
                let arms = if self.checker.ty(source).flags.intersects(TypeFlags::UNION) {
                    self.checker.ty(source).types().to_vec()
                } else {
                    vec![source]
                };
                let nullable = arms.iter().any(|id| {
                    self.checker
                        .ty(*id)
                        .flags
                        .intersects(TypeFlags::NULL | TypeFlags::UNDEFINED)
                });
                arms.into_iter().any(|id| {
                    (nullable && self.checker.is_array_type(id))
                        || (!self.checker.is_array_type(id)
                            && !self.checker.is_tuple_type(id)
                            && !self.checker.get_index_infos_of_type(id).is_empty())
                })
            }
            SyntaxKind::ConditionalExpression => {
                self.argument_may_be_absent(node.when_true(), &mut seen.clone())
                    || self.argument_may_be_absent(node.when_false(), seen)
            }
            _ => false,
        }
    }

    pub(super) fn source_has_undefined(&self, ty: TypeId) -> bool {
        let source = self.checker.ty(ty);
        source
            .flags
            .intersects(TypeFlags::UNDEFINED | TypeFlags::VOID)
            || (source.flags.intersects(TypeFlags::UNION)
                && source
                    .types()
                    .iter()
                    .any(|id| self.source_has_undefined(*id)))
    }
}
