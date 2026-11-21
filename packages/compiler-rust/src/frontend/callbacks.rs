//! First-class functions and lexical capture boxes.
use super::*;
use source_frontend::prelude::SignatureKind;

impl Lowerer<'_> {
    fn fixed_rest_parameter_unsafe_use(&mut self, callback: Node, symbols: &[u32]) -> bool {
        fn aliases(lowerer: &mut Lowerer<'_>, node: Node, symbols: &mut Vec<u32>) {
            let pair =
                if node.kind() == SyntaxKind::VariableDeclaration && !node.initializer().is_nil() {
                    Some((node.name(), node.initializer()))
                } else if node.kind() == SyntaxKind::BinaryExpression
                    && node.operator_token().kind() == SyntaxKind::EqualsToken
                {
                    Some((node.left(), node.right()))
                } else {
                    None
                };
            if let Some((target, source)) = pair
                && target.kind() == SyntaxKind::Identifier
                && parameter_value(lowerer, source, symbols)
            {
                let symbol = lowerer.symbol(target);
                if symbol != 0 && !symbols.contains(&symbol) {
                    symbols.push(symbol);
                }
            }
            node.for_each_child(&mut |child| {
                aliases(lowerer, child, symbols);
                false
            });
        }
        fn rooted_in_parameter(lowerer: &mut Lowerer<'_>, mut node: Node, symbols: &[u32]) -> bool {
            if !matches!(
                node.kind(),
                SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
            ) {
                return false;
            }
            while matches!(
                node.kind(),
                SyntaxKind::PropertyAccessExpression
                    | SyntaxKind::ElementAccessExpression
                    | SyntaxKind::ParenthesizedExpression
            ) {
                node = node.expression();
            }
            node.kind() == SyntaxKind::Identifier && symbols.contains(&lowerer.symbol(node))
        }
        // A property read whose checked type is a primitive copies a value;
        // it cannot alias (and later mutate) an erased parameter record.
        fn primitive_read(lowerer: &mut Lowerer<'_>, node: Node) -> bool {
            let checked = lowerer.checker.get_type_at_location(node);
            primitive_type(lowerer, checked)
                || {
                    // An erased read stored into a primitive slot is converted
                    // and copied there, so it cannot alias the parameter.
                    let context = lowerer.checker.get_contextual_type(
                        node,
                        source_frontend::flags::ContextFlags::NONE,
                    );
                    context.0 != 0 && primitive_type(lowerer, context)
                }
        }
        fn primitive_type(lowerer: &mut Lowerer<'_>, checked: TypeId) -> bool {
            let flags = lowerer.checker.ty(checked).flags;
            // `BufferEncoding` and similar literal unions (optionally with
            // undefined/null) are still primitive values.
            if flags.intersects(TypeFlags::UNION) {
                let parts = lowerer.checker.ty(checked).types().to_vec();
                return !parts.is_empty()
                    && parts.into_iter().all(|part| {
                        lowerer
                            .checker
                            .ty(part)
                            .flags
                            .intersects(TypeFlags::UNDEFINED | TypeFlags::NULL)
                            || primitive_type(lowerer, part)
                    });
            }
            flags.intersects(
                TypeFlags::STRING_LIKE
                    | TypeFlags::NUMBER_LIKE
                    | TypeFlags::BOOLEAN_LIKE
                    | TypeFlags::BIG_INT_LIKE,
            ) && !flags.intersects(
                TypeFlags::ANY
                    | TypeFlags::UNKNOWN
                    | TypeFlags::OBJECT
                    | TypeFlags::NON_PRIMITIVE
                    | TypeFlags::UNION
                    | TypeFlags::INTERSECTION
                    | TypeFlags::TYPE_PARAMETER,
            )
        }
        fn parameter_value(lowerer: &mut Lowerer<'_>, mut node: Node, symbols: &[u32]) -> bool {
            while matches!(
                node.kind(),
                SyntaxKind::ParenthesizedExpression | SyntaxKind::SpreadElement
            ) {
                node = node.expression();
            }
            if node.kind() == SyntaxKind::Identifier {
                // A flow-narrowed primitive (`typeof data === "string" ? data`)
                // is copied, not aliased.
                symbols.contains(&lowerer.symbol(node)) && !primitive_read(lowerer, node)
            } else {
                rooted_in_parameter(lowerer, node, symbols) && !primitive_read(lowerer, node)
            }
        }
        // Whether a literal element/property value can carry the parameter
        // (or an object reachable from it) into the new aggregate.
        fn escapes(lowerer: &mut Lowerer<'_>, node: Node, symbols: &[u32]) -> bool {
            match node.kind() {
                SyntaxKind::ParenthesizedExpression
                | SyntaxKind::AsExpression
                | SyntaxKind::NonNullExpression
                | SyntaxKind::TypeAssertionExpression
                | SyntaxKind::SatisfiesExpression
                | SyntaxKind::SpreadElement
                | SyntaxKind::SpreadAssignment => escapes(lowerer, node.expression(), symbols),
                SyntaxKind::ConditionalExpression => {
                    escapes(lowerer, node.when_true(), symbols)
                        || escapes(lowerer, node.when_false(), symbols)
                }
                SyntaxKind::BinaryExpression
                    if matches!(
                        node.operator_token().kind(),
                        SyntaxKind::BarBarToken
                            | SyntaxKind::AmpersandAmpersandToken
                            | SyntaxKind::QuestionQuestionToken
                            | SyntaxKind::CommaToken
                    ) =>
                {
                    escapes(lowerer, node.left(), symbols) || escapes(lowerer, node.right(), symbols)
                }
                SyntaxKind::PropertyAssignment => escapes(lowerer, node.initializer(), symbols),
                SyntaxKind::ShorthandPropertyAssignment => {
                    symbols.contains(&lowerer.symbol(node.name()))
                }
                // Methods and accessors capture the parameter by closure.
                SyntaxKind::MethodDeclaration
                | SyntaxKind::GetAccessor
                | SyntaxKind::SetAccessor
                | SyntaxKind::ArrowFunction
                | SyntaxKind::FunctionExpression => references_parameter(lowerer, node, symbols),
                _ => parameter_value(lowerer, node, symbols),
            }
        }
        fn references_parameter(lowerer: &mut Lowerer<'_>, node: Node, symbols: &[u32]) -> bool {
            if node.kind() == SyntaxKind::Identifier && symbols.contains(&lowerer.symbol(node)) {
                return true;
            }
            let mut found = false;
            node.for_each_child(&mut |child| {
                found = found || references_parameter(lowerer, child, symbols);
                found
            });
            found
        }
        // Native output sinks and value conversions only read their arguments.
        fn read_only_sink(lowerer: &mut Lowerer<'_>, call: Node) -> bool {
            let callee = call.expression();
            if callee.kind() == SyntaxKind::Identifier {
                let symbol = lowerer.symbol(callee);
                return ["String", "Number", "Boolean"]
                    .iter()
                    .any(|name| lowerer.primitive_symbol(symbol, name, None));
            }
            if callee.kind() != SyntaxKind::PropertyAccessExpression {
                return false;
            }
            let receiver = callee.expression();
            let member = callee.name().text();
            if receiver.kind() == SyntaxKind::Identifier {
                let symbol = lowerer.symbol(receiver);
                if (member == "stringify" && lowerer.primitive_symbol(symbol, "JSON", None))
                    || (member == "isArray" && lowerer.primitive_symbol(symbol, "Array", None))
                    || (matches!(member.as_ref(), "from" | "byteLength" | "isBuffer")
                        && lowerer.standard_buffer_value(receiver))
                {
                    return true;
                }
            }
            lowerer.ambient_console_member(callee).is_some()
                || lowerer.declared_console_call_member(callee).is_some()
                || (callee.name().text() == "write"
                    && (lowerer.process_member(receiver, "stdout")
                        || lowerer.process_member(receiver, "stderr")))
        }
        fn visit(lowerer: &mut Lowerer<'_>, node: Node, symbols: &[u32], scope: Node) -> bool {
            if node.kind() == SyntaxKind::CallExpression
                && !read_only_sink(lowerer, node)
                && node
                    .arguments()
                    .into_iter()
                    .any(|arg| parameter_value(lowerer, arg, symbols))
            {
                return true;
            }
            if node.kind() == SyntaxKind::ArrayLiteralExpression
                && node
                    .elements()
                    .into_iter()
                    .any(|element| escapes(lowerer, element, symbols))
            {
                return true;
            }
            if node.kind() == SyntaxKind::ObjectLiteralExpression
                && node
                    .properties()
                    .into_iter()
                    .any(|property| escapes(lowerer, property, symbols))
            {
                return true;
            }
            if matches!(
                node.kind(),
                SyntaxKind::ReturnStatement | SyntaxKind::ThrowStatement
            ) && !node.expression().is_nil()
                && parameter_value(lowerer, node.expression(), symbols)
            {
                return true;
            }
            let written = if node.kind() == SyntaxKind::BinaryExpression
                && (node.operator_token().kind() == SyntaxKind::EqualsToken
                    || updates::compound_operator(node.operator_token().kind()).is_some()
                    || matches!(
                        node.operator_token().kind(),
                        SyntaxKind::QuestionQuestionEqualsToken
                            | SyntaxKind::BarBarEqualsToken
                            | SyntaxKind::AmpersandAmpersandEqualsToken
                    )) {
                Some(node.left())
            } else if matches!(
                node.kind(),
                SyntaxKind::PrefixUnaryExpression | SyntaxKind::PostfixUnaryExpression
            ) && matches!(
                node.operator(),
                SyntaxKind::PlusPlusToken | SyntaxKind::MinusMinusToken
            ) {
                Some(node.operand())
            } else if node.kind() == SyntaxKind::DeleteExpression {
                Some(node.expression())
            } else {
                None
            };
            if written.is_some_and(|target| rooted_in_parameter(lowerer, target, symbols)) {
                return true;
            }
            // Re-binding the parameter to a local declared inside the callback
            // only creates a tracked alias (its mutations are checked above).
            let local_alias = node.kind() == SyntaxKind::BinaryExpression
                && node.left().kind() == SyntaxKind::Identifier
                && {
                let symbol = lowerer.symbol(node.left());
                let declaration = (symbol != 0)
                    .then(|| lowerer.checker.sym(source_frontend::prelude::SymbolId(symbol)).value_declaration)
                    .filter(|declaration| !declaration.is_nil());
                symbols.contains(&symbol)
                    && declaration.is_some_and(|declaration| {
                        declaration.pos() >= scope.pos() && declaration.end() <= scope.end()
                    })
            };
            if node.kind() == SyntaxKind::BinaryExpression
                && node.operator_token().kind() == SyntaxKind::EqualsToken
                && !local_alias
                && parameter_value(lowerer, node.right(), symbols)
            {
                return true;
            }
            let mut found = false;
            node.for_each_child(&mut |child| {
                found = found || visit(lowerer, child, symbols, scope);
                found
            });
            found
        }
        if callback.body().is_nil() {
            return false;
        }
        let mut aliases_seen = symbols.to_vec();
        loop {
            let previous = aliases_seen.len();
            aliases(self, callback.body(), &mut aliases_seen);
            if aliases_seen.len() == previous {
                break;
            }
        }
        visit(self, callback.body(), &aliases_seen, callback.body())
    }

    fn capture_entry_fact_stable(&mut self, closure: Node, symbol: u32) -> bool {
        fn assignment_target(lowerer: &mut Lowerer<'_>, node: Node, symbol: u32) -> bool {
            if node.is_nil() {
                return false;
            }
            if node.kind() == SyntaxKind::Identifier {
                return lowerer.symbol(node) == symbol;
            }
            if matches!(
                node.kind(),
                SyntaxKind::ArrayLiteralExpression
                    | SyntaxKind::ObjectLiteralExpression
                    | SyntaxKind::ArrayBindingPattern
                    | SyntaxKind::ObjectBindingPattern
            ) {
                let mut found = false;
                node.for_each_child(&mut |child| {
                    found = found || assignment_target(lowerer, child, symbol);
                    found
                });
                return found;
            }
            false
        }

        fn writes_after_capture(
            lowerer: &mut Lowerer<'_>,
            node: Node,
            closure: Node,
            symbol: u32,
            inside_nested: bool,
        ) -> bool {
            let inside_nested = inside_nested
                || matches!(
                    node.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                );
            let relevant = inside_nested || node.pos() >= closure.pos();
            if relevant {
                if node.kind() == SyntaxKind::BinaryExpression
                    && (node.operator_token().kind() == SyntaxKind::EqualsToken
                        || updates::compound_operator(node.operator_token().kind()).is_some()
                        || matches!(
                            node.operator_token().kind(),
                            SyntaxKind::QuestionQuestionEqualsToken
                                | SyntaxKind::BarBarEqualsToken
                                | SyntaxKind::AmpersandAmpersandEqualsToken
                        ))
                    && assignment_target(lowerer, node.left(), symbol)
                {
                    return true;
                }
                if matches!(
                    node.kind(),
                    SyntaxKind::PrefixUnaryExpression | SyntaxKind::PostfixUnaryExpression
                ) && matches!(
                    node.operator(),
                    SyntaxKind::PlusPlusToken | SyntaxKind::MinusMinusToken
                ) && assignment_target(lowerer, node.operand(), symbol)
                {
                    return true;
                }
                if matches!(
                    node.kind(),
                    SyntaxKind::ForInStatement | SyntaxKind::ForOfStatement
                ) && assignment_target(lowerer, node.initializer(), symbol)
                {
                    return true;
                }
            }
            let mut found = false;
            node.for_each_child(&mut |child| {
                found =
                    found || writes_after_capture(lowerer, child, closure, symbol, inside_nested);
                found
            });
            found
        }

        let mut owner = closure.parent();
        while !owner.is_nil()
            && !matches!(
                owner.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::Constructor
            )
        {
            owner = owner.parent();
        }
        !owner.is_nil()
            && !owner.body().is_nil()
            && !writes_after_capture(self, owner.body(), closure, symbol, false)
    }

    fn parametric_callback_argument(&mut self, node: Node) -> bool {
        let call = node.parent();
        if call.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let Some(argument) = call
            .arguments()
            .into_iter()
            .position(|candidate| declarations::Key::of(candidate) == declarations::Key::of(node))
        else {
            return false;
        };
        let target = self.checker.get_type_at_location(call.expression());
        let signatures = self
            .checker
            .get_signatures_of_type(target, SignatureKind::CALL);
        let callee = receivers::reference_node(call.expression());
        let canonical = self.call_target(callee, &mut HashSet::new());
        let symbol = if canonical != 0 {
            canonical
        } else if callee.kind() == SyntaxKind::PropertyAccessExpression {
            self.symbol(callee.name())
        } else {
            self.symbol(callee)
        };
        let declared = self
            .functions
            .source_node(symbol)
            .and_then(|source| self.declared(source))
            .and_then(|hint| hint.parametric_callback_results.get(argument))
            .copied()
            .unwrap_or(false);
        declared
            || signatures.iter().copied().any(|signature| {
                let signature = self.checker.sig(signature);
                if signature.type_parameters.is_empty() {
                    return false;
                }
                let Some(parameter) = signature.parameters.get(argument).copied() else {
                    return false;
                };
                let parameter = self.checker.get_type_of_symbol(parameter);
                self.checker
                    .get_signatures_of_type(parameter, SignatureKind::CALL)
                    .into_iter()
                    .any(|callback| {
                        let result = self.checker.get_return_type_of_signature(callback);
                        self.checker
                            .ty(result)
                            .flags
                            .intersects(TypeFlags::TYPE_PARAMETER)
                    })
            })
    }

    /// A declaration-backed generic callback can use `T` as an opaque
    /// transport even though the implementation has one erased native ABI.
    /// Recover the concrete return selected for this argument, but only when
    /// the declaration's callback result is itself a type parameter. This is
    /// deliberately narrower than accepting an arbitrary `() => any` slot.
    fn parametric_callback_transport_result(
        &mut self,
        node: Node,
        requested: &Type,
    ) -> Option<Type> {
        let Type::Func {
            ret: requested_ret, ..
        } = requested
        else {
            return None;
        };
        if **requested_ret != Type::Dyn || node.body().kind() == SyntaxKind::Block {
            return None;
        }
        if self.asserted_map_get(node.body()) {
            // A non-null assertion is erased at runtime. Map.get can still
            // yield undefined, so the checker-selected result is only a view
            // and cannot replace this callback's owning dynamic return ABI.
            return None;
        }
        if !self.parametric_callback_argument(node) {
            return None;
        }
        let checked = self.checker.get_type_at_location(node);
        let Type::Func { params, ret, rest } = self.public_javascript_function_type(checked)?
        else {
            return None;
        };
        let Type::Func {
            params: requested_params,
            rest: requested_rest,
            ..
        } = requested
        else {
            unreachable!("validated callback request")
        };
        (rest == *requested_rest && params.len() == requested_params.len() && *ret != Type::Dyn)
            .then_some(*ret)
    }

    // The restricted object can cross an erased ABI only when this particular
    // generic implementation immediately returns the callback result and the
    // caller immediately recovers the same concrete return representation.
    fn direct_parametric_object_transport(&mut self, node: Node, result: &Type) -> bool {
        let call = node.parent();
        let returned = call.parent();
        if call.kind() != SyntaxKind::CallExpression
            || returned.kind() != SyntaxKind::ReturnStatement
            || returned.expression() != call
            || self.return_type.as_ref() != Some(result)
        {
            return false;
        }
        let callee = receivers::reference_node(call.expression());
        let canonical = self.call_target(callee, &mut HashSet::new());
        let symbol = if canonical != 0 {
            canonical
        } else if callee.kind() == SyntaxKind::PropertyAccessExpression {
            self.symbol(callee.name())
        } else {
            self.symbol(callee)
        };
        let Some(source) = self.functions.source_node(symbol) else {
            return false;
        };
        let parameters = receivers::parameters(source);
        if parameters.len() != 1
            || parameters[0].name().kind() != SyntaxKind::Identifier
            || call.arguments().len() != 1
            || source.body().kind() != SyntaxKind::Block
        {
            return false;
        }
        let statements = source.body().statements();
        if statements.len() != 1 || statements.get(0).kind() != SyntaxKind::ReturnStatement {
            return false;
        }
        let value = receivers::reference_node(statements.get(0).expression());
        if value.kind() != SyntaxKind::CallExpression || !value.arguments().is_empty() {
            return false;
        }
        let target = receivers::reference_node(value.expression());
        target.kind() == SyntaxKind::Identifier
            && self.symbol(target) != 0
            && self.symbol(target) == self.symbol(parameters[0].name())
    }

    /// Keep the owning class handle for an approved parametric transport until
    /// the consumer's `DynCheck` recovers the concrete representation.
    fn parametric_object_transport(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if matches!(value.ty(), Type::Object { .. }) {
            return Ok(Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        self.coerce(value, Type::Dyn, node)
    }

    pub(super) fn function_type(&mut self, id: TypeId) -> Option<Type> {
        if let Some(ty) = self.declared_callable_type(id) {
            return ty;
        }
        if let Some(ty) = self
            .standard_callable_type(id)
            .or_else(|| self.json_callable_type(id))
            .or_else(|| self.regex_callable_type(id))
            .or_else(|| self.number_predicate_type(id))
            .or_else(|| self.number_parser_type(id))
        {
            return Some(ty);
        }
        if self.standard_console_type(id) {
            return Some(console::text_sink_type());
        }
        let signatures = self.checker.get_signatures_of_type(id, SignatureKind::CALL);
        if signatures.len() != 1 {
            return None;
        }
        let signature = signatures[0];
        let sig = self.checker.sig(signature);
        let declaration = sig.declaration;
        let type_predicate = !declaration.is_nil()
            && !declaration.type_().is_nil()
            && declaration.type_().kind() == SyntaxKind::TypePredicate;
        let rest = sig.has_rest_parameter();
        let generic = !sig.type_parameters.is_empty();
        let symbols = sig.parameters.clone();
        let count = symbols.len();
        let mut params = Vec::new();
        let mut array_rest = false;
        for (index, symbol) in symbols.into_iter().enumerate() {
            let id = self.checker.get_type_of_symbol(symbol);
            if rest && index + 1 == count {
                if !self.checker.is_tuple_type(id) {
                    if generic {
                        return None;
                    }
                    let ty = self.type_id(id)?;
                    if !matches!(ty, Type::Array { .. }) {
                        return None;
                    }
                    params.push(ty);
                    array_rest = true;
                    continue;
                }
                let target = self.checker.ty(id).target();
                let flags = self.checker.ty(target).as_tuple_type().element_flags();
                if flags.iter().any(|flag| {
                    flag.intersects(
                        source_frontend::flags::ElementFlags::REST
                            | source_frontend::flags::ElementFlags::VARIADIC,
                    )
                }) {
                    return None;
                }
                let elements = self.checker.get_type_arguments(id).to_vec();
                for (source, flag) in elements.into_iter().zip(flags) {
                    let mut ty = self.type_id(source)?;
                    if flag.intersects(source_frontend::flags::ElementFlags::OPTIONAL) {
                        let mut arms = if let Type::Union { union_id } = ty {
                            self.unions[union_id].arms.clone()
                        } else {
                            vec![ty]
                        };
                        arms.push(Type::Undefined);
                        ty = self.intern_union(arms)?;
                    }
                    params.push(ty);
                }
                continue;
            }
            let mut ty = self
                .type_id(id)
                .or_else(|| type_predicate.then_some(Type::Dyn))?;
            let symbol_declaration = self.checker.sym(symbol).value_declaration;
            let parameter = if !symbol_declaration.is_nil()
                && symbol_declaration.kind() == SyntaxKind::Parameter
            {
                symbol_declaration
            } else if !declaration.is_nil() && declaration.parameters().len() > index {
                declaration.parameters().get(index)
            } else {
                Node::NIL
            };
            if !parameter.is_nil() && parameter.kind() == SyntaxKind::Parameter {
                ty = self.parameter_type(parameter, ty).ok()?;
            }
            if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
                return None;
            }
            params.push(ty);
        }
        let result = self.checker.get_return_type_of_signature(signature);
        let class_intersection = self
            .checker
            .ty(result)
            .flags
            .intersects(TypeFlags::INTERSECTION)
            && self.checker.ty(result).types().iter().any(|part| {
                let symbol = self.checker.ty(*part).symbol();
                symbol.0 != 0
                    && self
                        .checker
                        .sym(symbol)
                        .flags
                        .intersects(SymbolFlags::CLASS)
            });
        // A non-returning body transports no normal value. Its throw/abrupt
        // completion remains in IR; the callable can use the unit return ABI.
        let ret = if type_predicate {
            // A TypeScript type predicate refines the checker view of its
            // argument, but its JavaScript result is an ordinary boolean.
            // The checker can retain the predicate pseudo-type on aliases,
            // where it has no standalone storage representation.
            Type::Bool
        } else if self
            .checker
            .ty(result)
            .flags
            .intersects(TypeFlags::VOID | TypeFlags::NEVER)
        {
            Type::Void
        } else if class_intersection
            && !declaration.is_nil()
            && parameter_abi::is_javascript(declaration)
        {
            // JavaScript commonly decorates a class instance with Object.assign.
            // The checker's structural intersection is a view of that same
            // owning identity, not a separate closed record layout.
            Type::Dyn
        } else {
            // Unit-valued source results still need a value when a callback is
            // invoked through the owning ABI (for example a deleting reviver).
            self.aggregate_slot_type(result)?
        };
        let symbol = if declaration.is_nil() || declaration.name().is_nil() {
            0
        } else {
            self.symbol(declaration.name())
        };
        let mut ret = if self.absence_returns.contains(&symbol)
            && matches!(ret, Type::F64 | Type::String | Type::Bool)
        {
            self.undefined_storage_type(ret, declaration).ok()?
        } else {
            ret
        };
        // JavaScript's checker can infer `number` for arithmetic on `any`,
        // even though an all-BigInt invocation returns a BigInt. Reserve
        // the complete owning result ABI before the function enters a record.
        if ret == Type::F64
            && !declaration.is_nil()
            && parameter_abi::is_javascript(declaration)
            && declaration.type_().is_nil()
            && !declaration.body().is_nil()
            && declaration.body().kind() != SyntaxKind::Block
            && params
                .iter()
                .any(|ty| matches!(ty, Type::Dyn | Type::Bigint | Type::Union { .. }))
            && let Some(inferred) = self.numeric_initializer_type(declaration.body())
            && matches!(&inferred, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Bigint))
        {
            ret = inferred;
        }
        Some(Type::Func {
            rest: array_rest,
            params,
            ret: Box::new(ret),
        })
    }

    /// Public JavaScript implementations need one stable owning ABI even when
    /// their declaration mentions open, nominal or recursive library values.
    /// Preserve every representable slot and transport only the unavailable
    /// slots through NativeValue. Concrete operations in the implementation
    /// must still establish their checked projection at the use site.
    pub(super) fn public_javascript_function_type(&mut self, id: TypeId) -> Option<Type> {
        if let Some(ty) = self.function_type(id) {
            return Some(ty);
        }
        let signatures = self.checker.get_signatures_of_type(id, SignatureKind::CALL);
        if signatures.len() != 1 {
            return None;
        }
        let signature = signatures[0];
        let sig = self.checker.sig(signature);
        let declaration = sig.declaration;
        if sig.has_rest_parameter() || !sig.type_parameters.is_empty() {
            return None;
        }
        let mut params = Vec::new();
        for (index, symbol) in sig.parameters.clone().into_iter().enumerate() {
            let source = self.checker.get_type_of_symbol(symbol);
            let mut ty = self.type_id(source).unwrap_or(Type::Dyn);
            let symbol_declaration = self.checker.sym(symbol).value_declaration;
            let parameter = if !symbol_declaration.is_nil()
                && symbol_declaration.kind() == SyntaxKind::Parameter
            {
                symbol_declaration
            } else if !declaration.is_nil() && declaration.parameters().len() > index {
                declaration.parameters().get(index)
            } else {
                Node::NIL
            };
            if !parameter.is_nil() && parameter.kind() == SyntaxKind::Parameter {
                ty = self.parameter_type(parameter, ty).unwrap_or(Type::Dyn);
            }
            if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
                ty = Type::Dyn;
            }
            params.push(ty);
        }
        let result = self.checker.get_return_type_of_signature(signature);
        let ret = if self
            .checker
            .ty(result)
            .flags
            .intersects(TypeFlags::VOID | TypeFlags::NEVER)
        {
            Type::Void
        } else {
            self.aggregate_slot_type(result).unwrap_or(Type::Dyn)
        };
        Some(Type::Func {
            rest: false,
            params,
            ret: Box::new(ret),
        })
    }

    pub(super) fn resolve_binding(&mut self, symbol: u32, node: Node) -> Result<Local, String> {
        if let Some(local) = self.bindings.get(&symbol) {
            return Ok(local.clone());
        }
        let recursive_capture = self.recursive_functions.contains_key(&symbol)
            && self
                .outer
                .iter()
                .rev()
                .any(|scope| scope.contains_key(&symbol));
        if !recursive_capture && let Some(local) = self.module_bindings.get(&symbol) {
            return Ok(local.clone());
        }
        // In checked CommonJS, a use can resolve to the exported alias while
        // its storage belongs to the nearest lexical declaration. Normalize
        // that checker projection before searching enclosing capture scopes.
        let symbol = if recursive_capture {
            symbol
        } else {
            self.commonjs_lexical_symbol(node)
                .map_or(symbol, |lexical| lexical.0)
        };
        if !recursive_capture
            && let Some(local) = self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
        {
            return Ok(local.clone());
        }
        let source = self
            .outer
            .iter()
            .rev()
            .find_map(|scope| scope.get(&symbol))
            .cloned();
        if source.is_none() && std::env::var_os("SCRIPTC_TRACE_BINDINGS").is_some() {
            let info = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
            eprintln!(
                "scriptc: unlowered binding symbol={symbol} name={} flags={:?} declarations={:?} module={:?}",
                info.name,
                info.flags,
                info.declarations
                    .iter()
                    .map(|declaration| (declaration.kind(), declaration.pos(), declaration.end()))
                    .collect::<Vec<_>>(),
                self.module_bindings
                    .iter()
                    .filter_map(|(id, local)| (local.name == info.name.as_ref())
                        .then_some((*id, local.clone())))
                    .collect::<Vec<_>>()
            );
        }
        let source = source.ok_or_else(|| self.refuse(node, "unlowered binding"))?;
        // Both the lexical cell and its value are traced owning nodes.
        let local = Local {
            id: format!("c{}", self.captures.len()),
            name: source.name,
            r#type: source.r#type,
            mutable: source.mutable,
            boxed: true,
        };
        self.captures.push((
            symbol,
            Param {
                local_id: local.id.clone(),
                name: local.name.clone(),
                r#type: local.r#type.clone(),
            },
        ));
        self.bindings.insert(symbol, local.clone());
        self.locals.push(local.clone());
        Ok(local)
    }

    pub(super) fn local_function_declaration(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let name = node.name();
        if name.is_nil() || name.kind() != SyntaxKind::Identifier {
            return Err(self.refuse(node, "local function declaration requires a name"));
        }
        let symbol = self.symbol(name);
        if symbol == 0 {
            return Err(self.refuse(node, "local function declaration has no lexical symbol"));
        }
        if self.hoisted_function_initializers.remove(&symbol) {
            return Ok(Vec::new());
        }
        let mut prefix = Vec::new();
        if !self.recursive_functions.contains_key(&symbol)
            && self.closure_mentions(node.body(), symbol)
        {
            let ty = self.storage_type(name)?;
            if !matches!(ty, Type::Func { .. }) || self.dynamic_erasure_reason(&ty).is_some() {
                return Err(self.refuse(
                    node,
                    "recursive local function requires a dynamically representable native signature",
                ));
            }
            let local = Local {
                id: format!("v{}", self.locals.len()),
                name: name.text().into(),
                r#type: Type::Dyn,
                mutable: true,
                boxed: true,
            };
            self.bindings.insert(symbol, local.clone());
            self.locals.push(local.clone());
            self.recursive_functions.insert(symbol, ty);
            prefix.push(Stmt::VarDecl {
                local_id: local.id,
                init: self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?,
                loc: self.loc(node),
            });
        }
        if let Some(ty) = self.recursive_functions.get(&symbol).cloned()
            && let Some(local) = self.bindings.get(&symbol).cloned()
            && local.r#type == Type::Dyn
            && local.boxed
        {
            let init = self.closure(node, Some(ty))?;
            let init = self.coerce(init, Type::Dyn, node)?;
            if let Some(binding) = self.bindings.get_mut(&symbol) {
                binding.mutable = false;
            }
            prefix.push(Stmt::Assign {
                local_id: local.id,
                value: init,
                initializes_global: false,
                loc: self.loc(node),
            });
            return Ok(prefix);
        }
        let ty = self.storage_type(name)?;
        if !matches!(ty, Type::Func { .. }) {
            return Err(self.refuse(
                node,
                "local function declaration requires a native function signature",
            ));
        }
        let local = Local {
            id: format!("v{}", self.locals.len()),
            name: name.text().into(),
            r#type: ty.clone(),
            mutable: true,
            boxed: false,
        };
        self.bindings.insert(symbol, local.clone());
        self.locals.push(local.clone());
        let init = self.closure(node, Some(ty))?;
        Ok(vec![Stmt::VarDecl {
            local_id: local.id,
            init,
            loc: self.loc(node),
        }])
    }

    pub(super) fn closure(&mut self, node: Node, expected: Option<Type>) -> Result<Expr, String> {
        let inferred_context = expected.is_none();
        let object_method = matches!(
            node.kind(),
            SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
        ) && node.parent().kind() == SyntaxKind::ObjectLiteralExpression;
        if !node.name().is_nil() && !object_method {
            // The inner name is a lexical self binding, including in defaults
            // and nested closures. Keep it refused whenever the body can read it.
            let symbol = self.symbol(node.name());
            fn references(lowerer: &mut Lowerer<'_>, node: Node, symbol: u32) -> bool {
                if node.kind() == SyntaxKind::Identifier && lowerer.symbol(node) == symbol {
                    return true;
                }
                let mut found = false;
                node.for_each_child(&mut |child| {
                    found |= references(lowerer, child, symbol);
                    found
                });
                found
            }
            let recursive_declaration = matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration | SyntaxKind::FunctionExpression
            ) && self.recursive_functions.contains_key(&symbol)
                && self
                    .bindings
                    .get(&symbol)
                    .is_some_and(|binding| binding.r#type == Type::Dyn && binding.boxed);
            let mentions_self = !node.body().is_nil()
                && (references(self, node.body(), symbol)
                    || node
                        .parameters()
                        .into_iter()
                        .any(|param| references(self, param, symbol)));
            if symbol != 0
                && node.kind() == SyntaxKind::FunctionExpression
                && mentions_self
                && !recursive_declaration
            {
                return self.named_recursive_expression(node, expected, symbol);
            }
            if symbol == 0 || node.body().is_nil() || (!recursive_declaration && mentions_self) {
                return Err(self.refuse(
                    node,
                    "named function expressions with a self binding are not ported",
                ));
            }
        }
        let is_generator = !node.asterisk_token().is_nil();
        let generic = !node.type_parameters().is_empty();
        // A JavaScript function expression can be checked as an open object
        // (notably UMD wrappers and constructor factories) even though its call
        // signature itself has a stable erased ABI. Derive that callable ABI
        // before asking the aggregate type mapper to represent the surrounding
        // function object.
        let mut inferred_callable = if expected.is_none() || expected == Some(Type::Dyn) {
            let id = self.checker.get_type_at_location(node);
            if generic {
                // Type parameters do not exist at runtime. Give every
                // instantiation one stable Dyn boundary instead of cloning a
                // closure ABI for each TypeScript specialization. Calls still
                // recover their checker-selected type after crossing it.
                self.erased_function_type(id)
            } else {
                self.public_javascript_function_type(id)
            }
        } else {
            None
        };
        let generator_return = if is_generator {
            let signature = self.checker.get_signature_from_declaration(node);
            let checker_return = self.checker.get_return_type_of_signature(signature);
            let generator =
                self.generator_type(checker_return)
                    .unwrap_or_else(|| Type::Generator {
                        r#async: node.modifier_flags().intersects(ModifierFlags::ASYNC),
                        yield_type: Box::new(Type::Dyn),
                        return_type: Box::new(Type::Void),
                        next_type: Box::new(Type::Dyn),
                    });
            if let Some(Type::Func { params, rest, .. }) = inferred_callable.clone() {
                inferred_callable = Some(Type::Func {
                    params,
                    ret: Box::new(generator.clone()),
                    rest,
                });
            }
            Some(generator)
        } else {
            None
        };
        let mut requested = match expected {
            Some(ty) => ty,
            None => inferred_callable
                .clone()
                .map_or_else(|| self.ty(node), Ok)?,
        };
        if let (Some(generator), Type::Func { params, rest, .. }) =
            (generator_return.clone(), requested.clone())
        {
            requested = Type::Func {
                params,
                ret: Box::new(generator),
                rest,
            };
        }
        if is_generator
            && matches!(&requested, Type::Func { ret, .. } if !matches!(ret.as_ref(), Type::Generator { .. }))
            && let Some(callable) = inferred_callable.clone()
            && matches!(&callable, Type::Func { ret, .. } if matches!(ret.as_ref(), Type::Generator { .. }))
        {
            // Generator syntax fixes the JavaScript call convention: calling
            // it returns a generator handle even when an unchecked contextual
            // slot was first planned as `() => any` or an async Promise.
            requested = callable;
        }
        // A function object is stored as a callable record once properties
        // such as `clear`, `done` or `sync` are attached. Lower the source
        // body against that record's call signature, then install the shared
        // callable view at the ordinary coercion boundary below.
        let mut implementation_requested = if let Type::Record { shape_id } = &requested {
            self.callables
                .get(shape_id)
                .cloned()
                .unwrap_or_else(|| requested.clone())
        } else {
            requested.clone()
        };
        if self.parametric_callback_argument(node)
            && let Type::Func { params, rest, .. } = &implementation_requested
        {
            implementation_requested = Type::Func {
                params: params.clone(),
                ret: Box::new(Type::Dyn),
                rest: *rest,
            };
        }
        let is_async = node.modifier_flags().intersects(ModifierFlags::ASYNC);
        if parameter_abi::is_javascript(node)
            && self.function_may_return_absent(node)
            && let Type::Func { params, ret, rest } = &implementation_requested
            && !matches!(**ret, Type::Dyn | Type::Void | Type::Undefined)
        {
            // Unchecked JavaScript may install a callback into a narrower
            // JSDoc slot while still returning `undefined` by falling through.
            // Preserve that live value in the implementation ABI; the
            // contextual function view remains attached below and validates
            // an observed result only when the consumer actually projects it.
            let result = if is_async && matches!(**ret, Type::Promise { .. }) {
                Type::Promise {
                    inner: Box::new(Type::Dyn),
                }
            } else {
                Type::Dyn
            };
            implementation_requested = Type::Func {
                params: params.clone(),
                ret: Box::new(result),
                rest: *rest,
            };
        }
        // An async implementation always has a Promise ABI even when its
        // contextual contract also permits a synchronous result. TypeScript
        // commonly spells that contract as `T | Promise<T>` (for callbacks
        // that may be implemented either way). Lower the implementation using
        // the Promise arm, then coerce the resulting function view back to the
        // wider contextual contract below.
        let contextual_async_promise = if is_async {
            match &implementation_requested {
                Type::Func { ret, .. } => match &**ret {
                    Type::Union { union_id } => {
                        let mut promises = self.unions[*union_id]
                            .arms
                            .iter()
                            .filter(|arm| matches!(arm, Type::Promise { .. }));
                        let promise = promises.next().cloned();
                        if promises.next().is_none() {
                            promise
                        } else {
                            None
                        }
                    }
                    _ => None,
                },
                _ => None,
            }
        } else {
            None
        };
        let mut ty = match (&implementation_requested, inferred_callable.clone()) {
            (Type::Func { params, rest, .. }, _) if contextual_async_promise.is_some() => {
                Type::Func {
                    params: params.clone(),
                    ret: Box::new(contextual_async_promise.expect("checked Promise arm")),
                    rest: *rest,
                }
            }
            (
                Type::Func {
                    ret, rest: false, ..
                },
                _,
            ) if receivers::parameters(node).len() == 1
                && !receivers::parameters(node)[0].dot_dot_dot_token().is_nil() =>
            {
                Type::Func {
                    params: vec![Type::Array {
                        elem: Box::new(Type::Dyn),
                    }],
                    ret: if is_async && **ret == Type::Dyn {
                        Box::new(Type::Promise {
                            inner: Box::new(Type::Dyn),
                        })
                    } else {
                        ret.clone()
                    },
                    rest: true,
                }
            }
            (Type::Dyn, Some(callable)) => callable,
            (Type::Func { params, ret, rest }, _) if is_async && **ret == Type::Dyn => Type::Func {
                params: params.clone(),
                ret: Box::new(Type::Promise {
                    inner: Box::new(Type::Dyn),
                }),
                rest: *rest,
            },
            _ => implementation_requested.clone(),
        };
        if parameter_abi::is_javascript(node)
            && parameters::arguments_reference(node).is_some()
            && let Type::Func {
                ret, rest: false, ..
            } = &ty
        {
            // An ordinary JavaScript function owns an `arguments` object even
            // when a contextual record describes only its fixed public slots.
            // Lower the implementation through the established erased-rest
            // transport, then attach the contextual callable view below.
            ty = Type::Func {
                params: vec![Type::Array {
                    elem: Box::new(Type::Dyn),
                }],
                ret: ret.clone(),
                rest: true,
            };
        }
        if let (Some(generator), Type::Func { params, rest, .. }) =
            (generator_return.clone(), ty.clone())
        {
            ty = Type::Func {
                params,
                ret: Box::new(generator),
                rest,
            };
        }
        let Type::Func {
            params: types,
            ret,
            rest,
        } = &ty
        else {
            return Err(self.refuse(node, "callback needs a native function signature"));
        };
        let generator = if is_generator {
            let Type::Generator {
                r#async,
                yield_type,
                next_type,
                ..
            } = &**ret
            else {
                return Err(self.refuse(
                    node,
                    &format!(
                        "generator callback requires represented continuation channels; got {ret:?}"
                    ),
                ));
            };
            if *r#async != is_async {
                return Err(self.refuse(node, "generator callback async ABI differs"));
            }
            Some(ir::GeneratorChannels {
                yield_type: (**yield_type).clone(),
                next_type: (**next_type).clone(),
            })
        } else {
            None
        };
        let body_return = if is_generator {
            let Type::Generator { return_type, .. } = &**ret else {
                unreachable!("validated generator callback")
            };
            (**return_type).clone()
        } else if is_async {
            let Type::Promise { inner } = &**ret else {
                return Err(self.refuse(node, "async callback requires a native Promise result"));
            };
            (**inner).clone()
        } else {
            (**ret).clone()
        };
        let parametric_transport = self
            .parametric_callback_transport_result(node, &implementation_requested)
            .map(|transport| match transport {
                // The checker describes an async callback's call result as a
                // Promise, while the function body returns its payload. The
                // async ABI wraps that payload after the body has evaluated.
                Type::Promise { inner } if is_async => *inner,
                transport => transport,
            });
        if let Some(result) = &parametric_transport
            && let Some(reason) = self.dynamic_erasure_reason(result)
            && !self.direct_parametric_object_transport(node, result)
        {
            return Err(self.refuse(node, reason));
        }
        let erased_parametric_transport = inferred_context && parametric_transport.is_some();
        if is_async {
            self.refuse_thenable(&body_return, node)?;
        }
        let parameters = receivers::parameters(node);
        let source_rest = parameters
            .iter()
            .last()
            .is_some_and(|p| !p.dot_dot_dot_token().is_nil());
        let fixed_rest_pattern = source_rest
            && !*rest
            && parameters.len() == 1
            && parameters[0].name().kind() == SyntaxKind::ArrayBindingPattern
            && parameters[0].name().elements().len() <= types.len();
        // Public erased rest contracts keep their owning vector ABI. A JS
        // implementation may still declare ordinary fixed source formals.
        // Contextual function expressions also occur in feature-detection
        // fallbacks such as `String.fromCodePoint ?? function (codePoint) {}`.
        // There the selected native callable owns a typed rest vector while
        // the fallback observes ordinary JavaScript formals. Unpack that
        // vector into dynamic source bindings without changing the callable's
        // public rest ABI. Keep declaration implementations strict: a `.d.ts`
        // rest contract backed by a fixed function declaration is still a
        // source/implementation mismatch.
        let contextual_fixed_to_rest = matches!(
            node.kind(),
            SyntaxKind::FunctionExpression | SyntaxKind::ArrowFunction
        ) && !source_rest
            && *rest
            && matches!(types.as_slice(), [Type::Array { .. }]);
        let unpack_rest = !source_rest
            && ((parameter_abi::is_javascript(node) && parameters::erased_rest(&ty))
                || contextual_fixed_to_rest);
        if unpack_rest && !parameter_abi::is_javascript(node) {
            if node.kind() != SyntaxKind::ArrowFunction
                && parameters::arguments_reference(node).is_some()
            {
                return Err(self.refuse(
                    node,
                    "fixed callback arguments object requires its native object contract",
                ));
            }
            fn binding_symbols(lowerer: &mut Lowerer<'_>, name: Node, symbols: &mut Vec<u32>) {
                match name.kind() {
                    SyntaxKind::Identifier => {
                        let symbol = lowerer.symbol(name);
                        if symbol != 0 {
                            symbols.push(symbol);
                        }
                    }
                    SyntaxKind::ArrayBindingPattern | SyntaxKind::ObjectBindingPattern => {
                        for element in name.elements() {
                            if !bindings::omitted(element) && !element.name().is_nil() {
                                binding_symbols(lowerer, element.name(), symbols);
                            }
                        }
                    }
                    _ => {}
                }
            }
            let mut symbols = Vec::new();
            for parameter in &parameters {
                // An `unknown`/`any` formal binds the owning dynamic value
                // itself, so aliases observe the same object; only typed
                // views unpacked from the transport vector can diverge.
                if parameter.name().kind() == SyntaxKind::Identifier
                    && self.ty(parameter.name()).ok() == Some(Type::Dyn)
                {
                    continue;
                }
                binding_symbols(self, parameter.name(), &mut symbols);
            }
            if self.fixed_rest_parameter_unsafe_use(node, &symbols) {
                return Err(self.refuse(
                    node,
                    "fixed callback arguments cannot yet mutate erased record properties",
                ));
            }
        }
        if !unpack_rest && parameters.len() > types.len() {
            return Err(self.refuse(
                node,
                "callback requires more parameters than its native signature",
            ));
        }
        if !unpack_rest && !fixed_rest_pattern && source_rest != *rest {
            return Err(self.refuse(node, "callback rest ABI differs from its native target"));
        }
        for (index, param) in parameters.iter().copied().enumerate() {
            if !matches!(
                param.name().kind(),
                SyntaxKind::Identifier
                    | SyntaxKind::ObjectBindingPattern
                    | SyntaxKind::ArrayBindingPattern
            ) || (!param.dot_dot_dot_token().is_nil() && (!*rest || index + 1 != types.len()))
            {
                return Err(self.refuse(param, "callback parameter form is not ported"));
            }
            if param.name().kind() == SyntaxKind::ObjectBindingPattern {
                self.validate_object_parameter(param)?;
            } else if param.name().kind() == SyntaxKind::ArrayBindingPattern {
                self.validate_array_parameter(param)?;
            }
        }
        let name = format!("lambda{}", self.next_closure);
        self.next_closure += 1;
        let saved_locals = std::mem::take(&mut self.locals);
        let saved_bindings = std::mem::take(&mut self.bindings);
        let saved_captures = std::mem::take(&mut self.captures);
        let saved_return = self.return_type.replace(body_return.clone());
        let saved_async = std::mem::replace(&mut self.is_async_function, is_async);
        let saved_generator = self.generator.take();
        self.generator = generator.clone();
        let saved_this = self.instance_this.take();
        let saved_var_types = self.var_types.clone();
        let saved_var_defined = std::mem::take(&mut self.var_defined);
        self.var_defined = saved_var_defined
            .iter()
            .copied()
            .filter(|symbol| {
                saved_bindings.get(symbol).is_some_and(|binding| {
                    !binding.mutable || self.capture_entry_fact_stable(node, *symbol)
                })
            })
            .collect();
        let mut captured_scope = saved_bindings.clone();
        for (symbol, local) in &mut captured_scope {
            if local.r#type == Type::Caught {
                *local = self
                    .caught_aliases
                    .get(symbol)
                    .expect("catch snapshot")
                    .clone();
            }
        }
        self.outer.push(captured_scope);
        if node.body().kind() == SyntaxKind::Block {
            self.plan_function_local_storage(node)?;
        }
        let nodes = parameters;
        let mut params = Vec::new();
        let mut body = Vec::new();
        let lexical_this =
            if node.kind() == SyntaxKind::ArrowFunction && receivers::reads_this(node) {
                if let Some(source) = &saved_this {
                    let local = Local {
                        id: "lexical_this".into(),
                        name: "lexical this".into(),
                        r#type: source.r#type.clone(),
                        mutable: false,
                        boxed: true,
                    };
                    self.locals.push(local.clone());
                    self.instance_this = Some(local.clone());
                    Some((
                        source.clone(),
                        Param {
                            local_id: local.id,
                            name: local.name,
                            r#type: local.r#type,
                        },
                    ))
                } else if self.static_initializer_this(node).is_some() {
                    None
                } else {
                    body.extend(self.initialize_module_arrow_receiver(node)?);
                    None
                }
            } else {
                if node.kind() != SyntaxKind::ArrowFunction {
                    body.extend(self.initialize_receiver(node)?);
                }
                None
            };
        if fixed_rest_pattern {
            let elements = nodes[0].name().elements();
            for (index, ty) in types.iter().enumerate() {
                let param = Param {
                    local_id: format!("p{index}"),
                    name: (index < elements.len())
                        .then(|| elements.get(index))
                        .filter(|element| !bindings::omitted(*element))
                        .map(|element| element.name().text().to_string())
                        .unwrap_or_else(|| format!("ignored{index}")),
                    r#type: ty.clone(),
                };
                if let Some(element) = (index < elements.len())
                    .then(|| elements.get(index))
                    .filter(|element| !bindings::omitted(*element))
                {
                    body.extend(self.bind_parameter(Some(element), &param)?);
                } else {
                    body.extend(self.bind_parameter(None, &param)?);
                }
                params.push(param);
            }
        }
        for (index, ty) in types
            .iter()
            .enumerate()
            .filter(|_| !unpack_rest && !fixed_rest_pattern)
        {
            let name = nodes
                .get(index)
                .map(|n| {
                    if n.name().kind() == SyntaxKind::Identifier {
                        n.name().text().to_string()
                    } else {
                        format!("binding{index}")
                    }
                })
                .unwrap_or_else(|| format!("ignored{index}"));
            let param = Param {
                local_id: format!("p{index}"),
                name,
                r#type: ty.clone(),
            };
            body.extend(self.bind_parameter(nodes.get(index).copied(), &param)?);
            params.push(param);
        }
        if unpack_rest {
            let incoming = Param {
                local_id: "p0".into(),
                name: "arguments".into(),
                r#type: types[0].clone(),
            };
            body.extend(self.bind_parameter(None, &incoming)?);
            if node.kind() != SyntaxKind::ArrowFunction
                && let Some(arguments) = parameters::arguments_reference(node)
            {
                let symbol = self.symbol(arguments);
                if symbol != 0 {
                    let local = self
                        .locals
                        .last()
                        .expect("arguments transport local")
                        .clone();
                    self.bindings.insert(symbol, local);
                }
            }
            body.extend(self.bind_erased_rest_formals(&nodes, &incoming)?);
            params.push(incoming);
        }
        let loc = self.loc(node);
        if node.body().kind() == SyntaxKind::Block {
            body.extend(self.hoist_local_vars(node.body())?);
            body.extend(self.hoist_forward_closures(node.body())?);
        }
        body.extend(if node.body().kind() == SyntaxKind::Block {
            self.statements(node.body().statements())?
        } else if is_async
            && let Some(value) = self.terminal_nullish_await(node.body(), &body_return)?
        {
            vec![Stmt::Return {
                value: Some(value),
                loc: self.loc(node.body()),
            }]
        } else if is_async && node.body().kind() == SyntaxKind::AwaitExpression {
            vec![Stmt::Return {
                value: Some(self.terminal_await(node.body(), &body_return)?),
                loc: self.loc(node.body()),
            }]
        } else if body_return == Type::Void {
            vec![
                Stmt::Expression {
                    expr: self.expression(node.body())?,
                    loc: self.loc(node.body()),
                },
                Stmt::Return {
                    value: None,
                    loc: loc.clone(),
                },
            ]
        } else if is_async && matches!(self.ty(node.body()), Ok(Type::Promise { .. })) {
            let promise = self.expected_expression(
                node.body(),
                Type::Promise {
                    inner: Box::new(body_return.clone()),
                },
            )?;
            let Type::Promise { inner } = promise.ty() else {
                unreachable!("contextual async callback Promise")
            };
            if *inner != body_return && *inner != Type::Dyn && body_return != Type::Dyn {
                return Err(self.refuse(
                    node.body(),
                    "async callback Promise payload differs from its native result",
                ));
            }
            vec![Stmt::Return {
                value: Some(Expr::Await {
                    value: Box::new(promise),
                    r#type: body_return.clone(),
                    loc: self.loc(node.body()),
                }),
                loc: self.loc(node.body()),
            }]
        } else if let Some(transport) = parametric_transport {
            let value = self.expected_expression(node.body(), transport)?;
            vec![Stmt::Return {
                value: Some(self.parametric_object_transport(value, node.body())?),
                loc: self.loc(node.body()),
            }]
        } else {
            vec![Stmt::Return {
                value: Some(self.expected_expression(node.body(), body_return.clone())?),
                loc: self.loc(node.body()),
            }]
        });
        self.complete_function_body(&mut body, &body_return, node, "callback can fall through")?;
        if generator.is_some() {
            for local in &mut self.locals {
                local.boxed = true;
            }
        }
        let captures = std::mem::replace(&mut self.captures, saved_captures);
        let function = Function {
            is_async,
            generator,
            rest: *rest,
            name: name.clone(),
            params,
            captures: Some(
                captures
                    .iter()
                    .map(|(_, p)| p.clone())
                    .chain(lexical_this.iter().map(|(_, p)| p.clone()))
                    .collect(),
            ),
            return_type: body_return,
            locals: std::mem::replace(&mut self.locals, saved_locals),
            body,
            loc: loc.clone(),
        };
        self.bindings = saved_bindings;
        self.return_type = saved_return;
        self.is_async_function = saved_async;
        self.generator = saved_generator;
        self.instance_this = saved_this;
        self.var_types = saved_var_types;
        self.var_defined = saved_var_defined;
        self.outer.pop();
        let mut sources = Vec::new();
        for (symbol, _) in captures {
            let caught = self
                .bindings
                .get(&symbol)
                .is_some_and(|local| local.r#type == Type::Caught);
            let source = if caught {
                self.caught_aliases[&symbol].clone()
            } else {
                self.resolve_binding(symbol, node)?
            };
            self.locals
                .iter_mut()
                .find(|l| l.id == source.id)
                .expect("binding local")
                .boxed = true;
            if caught {
                self.caught_aliases
                    .get_mut(&symbol)
                    .expect("catch snapshot")
                    .boxed = true;
            } else {
                self.bindings.get_mut(&symbol).expect("binding").boxed = true;
            }
            sources.push(source.id);
        }
        if let Some((source, _)) = lexical_this {
            self.locals
                .iter_mut()
                .find(|local| local.id == source.id)
                .expect("lexical receiver local")
                .boxed = true;
            self.instance_this.as_mut().expect("lexical receiver").boxed = true;
            sources.push(source.id);
        }
        self.lifted.push(function);
        let value = Expr::Closure {
            fn_name: name,
            captures: sources,
            r#type: ty,
            loc,
        };
        if value.ty() == requested || erased_parametric_transport {
            Ok(value)
        } else {
            self.coerce(value, requested, node)
        }
    }

    fn named_recursive_expression(
        &mut self,
        node: Node,
        expected: Option<Type>,
        symbol: u32,
    ) -> Result<Expr, String> {
        let signature = match expected.clone() {
            Some(ty @ Type::Func { .. }) => ty,
            _ => {
                let id = self.checker.get_type_at_location(node);
                self.public_javascript_function_type(id)
                    .or_else(|| self.type_id(id))
                    .ok_or_else(|| {
                        self.refuse(
                            node,
                            "named recursive function requires a represented signature",
                        )
                    })?
            }
        };
        if !matches!(signature, Type::Func { .. })
            || self.dynamic_erasure_reason(&signature).is_some()
        {
            return Err(self.refuse(
                node,
                "named recursive function requires a dynamically represented signature",
            ));
        }
        let loc = self.loc(node);
        let local = Local {
            id: format!("v{}", self.locals.len()),
            name: node.name().text().into(),
            r#type: Type::Dyn,
            mutable: false,
            boxed: true,
        };
        let previous_binding = self.bindings.insert(symbol, local.clone());
        let previous_signature = self.recursive_functions.insert(symbol, signature);
        let mut storage = local.clone();
        storage.mutable = true;
        self.locals.push(storage);
        let result = self.closure(node, expected);
        if let Some(previous) = previous_binding {
            self.bindings.insert(symbol, previous);
        } else {
            self.bindings.remove(&symbol);
        }
        if let Some(previous) = previous_signature {
            self.recursive_functions.insert(symbol, previous);
        } else {
            self.recursive_functions.remove(&symbol);
        }
        let result = result?;
        let result_type = result.ty();
        let value = self.coerce(result, Type::Dyn, node)?;
        let undefined = self.coerce(
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: loc.clone(),
            },
            Type::Dyn,
            node,
        )?;
        let read = Expr::VarRef {
            local_id: local.id.clone(),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let read = self.coerce(read, result_type.clone(), node)?;
        Ok(Expr::Sequence {
            stmts: vec![
                Stmt::VarDecl {
                    local_id: local.id.clone(),
                    init: undefined,
                    loc: loc.clone(),
                },
                Stmt::Assign {
                    local_id: local.id,
                    value,
                    initializes_global: false,
                    loc: loc.clone(),
                },
            ],
            result: Box::new(read),
            r#type: result_type,
            loc,
        })
    }

    fn nullable_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let name = node.expression();
        if name.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let Ok(local) = self.binding(name) else {
            return Ok(None);
        };
        let Type::Union { union_id } = local.r#type else {
            return Ok(None);
        };
        let arms = &self.unions[union_id].arms;
        let functions = arms
            .iter()
            .filter(|t| matches!(t, Type::Func { .. }))
            .collect::<Vec<_>>();
        if functions.len() != 1
            || arms
                .iter()
                .any(|t| !matches!(t, Type::Func { .. } | Type::Null | Type::Undefined))
        {
            return Ok(None);
        }
        let ty = functions[0].clone();
        let Type::Func { params, ret, rest } = ty.clone() else {
            unreachable!()
        };
        let mut types = vec![local.r#type.clone()];
        types.extend(params.clone());
        let mut helper = helpers::Helper::new(
            &format!("nullable_call_{}", name.text()),
            types,
            (*ret).clone(),
            self.loc(node),
        );
        let callee = self.coerce(helper.read(&helper.param(0)), Type::Dyn, name)?;
        let call = if rest {
            Expr::CallValue {
                callee: Box::new(self.coerce(callee, ty, name)?),
                args: params
                    .iter()
                    .enumerate()
                    .map(|(i, _)| helper.read(&helper.param(i + 1)))
                    .collect(),
                r#type: (*ret).clone(),
                loc: self.loc(node),
            }
        } else {
            let args = params
                .iter()
                .enumerate()
                .map(|(i, _)| self.coerce(helper.read(&helper.param(i + 1)), Type::Dyn, node))
                .collect::<Result<Vec<_>, _>>()?;
            Expr::DynCall {
                callee: Box::new(callee),
                callee_name: name.text().into(),
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            }
        };
        if *ret == Type::Void {
            helper.function.body.push(Stmt::Expression {
                expr: call,
                loc: self.loc(node),
            });
        } else {
            helper.function.body.push(Stmt::Return {
                value: Some(self.coerce(call, (*ret).clone(), node)?),
                loc: self.loc(node),
            });
        }
        let callee = self.install_helper(helper.function);
        let mut args = vec![Expr::VarRef {
            local_id: local.id,
            r#type: local.r#type,
            loc: self.loc(name),
        }];
        args.extend(self.rest_call_arguments(node, &params, rest)?);
        Ok(Some(Expr::Call {
            callee,
            args,
            r#type: *ret,
            loc: self.loc(node),
        }))
    }

    pub(super) fn call_value(&mut self, node: Node) -> Result<Expr, String> {
        if let Some(value) = self.nullable_call(node)? {
            return Ok(value);
        }
        let target = node.expression();
        if target.kind() == SyntaxKind::ElementAccessExpression {
            let key = primitives::primitive_source(target.argument_expression());
            let operation = if key.kind() == SyntaxKind::PropertyAccessExpression
                && self.standard_symbol(key.expression())
            {
                let operation = format!("sym.{}", key.name().text());
                ir::well_known_symbol(&operation).map(|_| operation)
            } else {
                None
            };
            if let Some(operation) = operation {
                let receiver = self.expression(target.expression())?;
                let receiver = self.coerce(receiver, Type::Dyn, target.expression())?;
                let args = node
                    .arguments()
                    .into_iter()
                    .map(|argument| self.expected_expression(argument, Type::Dyn))
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(Expr::DynInvoke {
                    recv: Box::new(receiver),
                    method: format!("\0{operation}"),
                    callee_name: operation.replacen("sym.", "Symbol.", 1),
                    optional: false,
                    args,
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                });
            }
        }
        let ambient_fetch =
            target.kind() == SyntaxKind::Identifier && target.text() == "fetch" && {
                let symbol = self.symbol(target);
                !self.bindings.contains_key(&symbol)
                    && !self.module_bindings.contains_key(&symbol)
                    && !self.outer.iter().any(|scope| scope.contains_key(&symbol))
            };
        let contextual = if target.kind() == SyntaxKind::Identifier
            && !ambient_fetch
            && !node
                .arguments()
                .into_iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            let canonical = self.call_target(target, &mut HashSet::new());
            let symbol = if canonical == 0 {
                self.symbol(target)
            } else {
                canonical
            };
            if let Some(mut signature) =
                self.request_function(symbol, node, functions::UseKind::Call)?
            {
                let mut changed = false;
                for (index, argument) in node.arguments().into_iter().enumerate() {
                    let planned = self.planned_argument_type(argument);
                    let expected = signature.params.get(index).map(|param| &param.r#type);
                    if !(signature.rest && index + 1 == signature.params.len())
                        && planned
                            .as_ref()
                            .zip(expected)
                            .is_some_and(|(actual, expected)| {
                                !self.contextual_result_compatible(actual, expected)
                            })
                    {
                        signature.params[index].r#type = Type::Dyn;
                        changed = true;
                        continue;
                    }
                    let actual = planned.and_then(|ty| match expected {
                        Some(expected @ Type::Generator { r#async: false, .. }) => {
                            self.synchronous_iterable_argument(ty, expected)
                        }
                        Some(expected @ Type::Union { .. }) => {
                            self.synchronous_iterable_argument(ty, expected)
                        }
                        Some(Type::Record { .. }) => self.synchronous_generator_argument(ty),
                        _ => None,
                    });
                    if let Some(actual) = actual {
                        signature.params[index].r#type = actual;
                        changed = true;
                    }
                }
                if !changed || self.functions.replace_queued(symbol, signature.clone()) {
                    Some(signature)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        let mut value = if let Some(signature) = contextual {
            Expr::Closure {
                fn_name: signature.name,
                captures: vec![],
                r#type: Type::Func {
                    rest: signature.rest,
                    params: signature
                        .params
                        .iter()
                        .map(|param| param.r#type.clone())
                        .collect(),
                    ret: Box::new(signature.return_type),
                },
                loc: self.loc(target),
            }
        } else if target.kind() == SyntaxKind::Identifier
            && self
                .binding(target)
                .is_ok_and(|local| local.r#type == Type::Dyn)
        {
            self.condition_value(target)?
        } else {
            self.expression(target)?
        };
        // A non-null assertion on an indexed callback table preserves the
        // owning union until the call boundary. Select its sole present
        // callable arm here so the invocation retains the typed function ABI.
        if target.kind() == SyntaxKind::NonNullExpression
            && let Type::Union { union_id } = value.ty()
        {
            let present = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
                .collect::<Vec<_>>();
            if let [(tag, ty)] = present.as_slice()
                && matches!(ty, Type::Func { .. })
            {
                value = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: (*ty).clone(),
                    loc: self.loc(target),
                };
            }
        }
        let mut callee = self.callable_body(value, node)?;
        if std::env::var_os("SCRIPTC_TRACE_CALL_VALUES").is_some() {
            eprintln!(
                "scriptc: call value {}:{}..{} target={:?} callee={:?}",
                self.file,
                node.pos(),
                node.end(),
                target.text(),
                callee.ty(),
            );
        }
        if let Type::Union { union_id } = callee.ty() {
            let arms = &self.unions[union_id].arms;
            let functions = arms
                .iter()
                .filter(|arm| matches!(arm, Type::Func { .. }))
                .count();
            if functions == 1
                && arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Func { .. } | Type::Null | Type::Undefined))
            {
                // A direct call through an optional member has one owning
                // JavaScript operation: box the selected union arm, retain
                // the member receiver, and let the dynamic callable boundary
                // either invoke the function or throw for null/undefined.
                // Narrowing without a guard would incorrectly assume presence.
                callee = self.coerce(callee, Type::Dyn, target)?;
            }
        }
        let member = receivers::reference_node(node.expression());
        if member.kind() == SyntaxKind::PropertyAccessExpression {
            let source = self.checker.get_type_at_location(member.expression());
            let symbol = self.symbol(member.name());
            // A namespace member that resolves to a function declaration which
            // never reads `this` observes nothing of the namespace receiver.
            let receiver_free_export = symbol != 0 && {
                let mut target = source_frontend::prelude::SymbolId(symbol);
                if self.checker.sym(target).flags.intersects(SymbolFlags::ALIAS) {
                    target = self.checker.get_aliased_symbol(target);
                }
                let declaration = if target.0 == 0 {
                    Node::NIL
                } else {
                    self.checker.sym(target).value_declaration
                };
                !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::FunctionDeclaration
                    && !receivers::reads_this(declaration)
            };
            let boundary = if (self.module_namespace(member.expression())
                || self.namespace_value_type(source).is_some())
                && !receiver_free_export
            {
                Some(receivers::Boundary::Namespace)
            } else if symbol != 0
                && self
                    .checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .flags
                    .intersects(SymbolFlags::ACCESSOR)
            {
                Some(receivers::Boundary::Getter)
            } else {
                None
            };
            if let Some(boundary) = boundary {
                self.receiver_calls.push(receivers::PendingCall {
                    ty: callee.ty(),
                    loc: self.loc(node),
                    boundary,
                });
            }
        }
        // A JavaScript call whose value is discarded must still evaluate the
        // callee and arguments and run every side effect, but it does not
        // require a projection of the returned value into the checker's
        // contextual type. This matters for structurally borrowed methods:
        // `Other.prototype.add.bind(this)` can return the borrowing receiver
        // even though the source declaration names `Other`. Validating that
        // unused result would reject a perfectly valid JavaScript call after
        // its effects have already happened.
        if node.parent().kind() == SyntaxKind::ExpressionStatement
            && let Type::Func { params, ret, rest } = callee.ty()
            && !matches!(*ret, Type::Dyn | Type::Void)
        {
            callee = self.coerce(
                callee,
                Type::Func {
                    params,
                    ret: Box::new(Type::Dyn),
                    rest,
                },
                node,
            )?;
        }
        // `typeof value === "function" ? value() : value`: the checker narrows
        // the callee to its callable constituents while the owning slot keeps
        // the full union. Invoke the live value through the dynamic callable
        // boundary, which calls the function arm (or throws a TypeError).
        let checker_any = {
            let checked = self.checker.get_type_at_location(target);
            self.checker.ty(checked).flags.intersects(TypeFlags::ANY)
        };
        let checker_callable = {
            let checked = self.checker.get_type_at_location(target);
            // An `any` callee (untyped JavaScript) is called dynamically in JS
            // as well: invoke the live value, which throws if not callable.
            self.checker.ty(checked).flags.intersects(TypeFlags::ANY)
                || !self
                    .checker
                    .get_signatures_of_type(checked, SignatureKind::CALL)
                    .is_empty()
        };
        if let Type::Union { union_id } = callee.ty()
            && checker_callable
            && self.unions[union_id].arms.iter().any(|arm| matches!(arm, Type::Func { .. }))
        {
            let functions = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| matches!(arm, Type::Func { .. }))
                .map(|(tag, arm)| (tag, arm.clone()))
                .collect::<Vec<_>>();
            let others_not_callable = self.unions[union_id].arms.iter().all(|arm| {
                matches!(arm, Type::Func { .. })
                    || matches!(arm, Type::Record { shape_id } if !self.callables.contains_key(shape_id))
                    || matches!(arm, Type::Null | Type::Undefined | Type::String | Type::F64 | Type::Bool)
            });
            if self.dynamic_erasure_reason(&callee.ty()).is_none() {
                callee = self.coerce(callee, Type::Dyn, target)?;
            } else if let [(tag, function)] = functions.as_slice()
                && others_not_callable
                && !checker_any
            {
                // The checker's callable narrowing (a `typeof … === "function"`
                // guard) selects the only function arm; the other arms are
                // plain data that can never satisfy that guard.
                callee = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(callee),
                    r#type: function.clone(),
                    loc: self.loc(target),
                };
            }
        }
        if let Type::Union { union_id } = callee.ty()
            && self.unions[union_id].arms.iter().all(|arm| {
                matches!(arm, Type::Func { .. })
                    || matches!(arm, Type::Record { shape_id } if self.callables.contains_key(shape_id))
            })
        {
            // Callable records (for example `NodeRequire` selected by `??`
            // beside a plain callback) carry their call signature in the
            // record's owning function slot, which the dynamic adapter invokes.
            // A typeof-normalized value can select between closures whose
            // return ABIs differ. The selected union tag must keep the exact
            // closure identity, so invoke its existing NativeValue callable
            // adapter instead of inventing one lossy common Func signature.
            callee = self.coerce(callee, Type::Dyn, target)?;
        }
        if callee.ty() == Type::Dyn {
            let callee_name = if member.kind() == SyntaxKind::PropertyAccessExpression
                && matches!(
                    member.expression().kind(),
                    SyntaxKind::Identifier | SyntaxKind::ThisKeyword
                ) {
                format!(
                    "{}.{}",
                    if member.expression().kind() == SyntaxKind::ThisKeyword {
                        "this"
                    } else {
                        member.expression().text()
                    },
                    member.name().text()
                )
            } else {
                "value".into()
            };
            let source_arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if source_arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                // Snapshot the callee before consuming the iterable argument
                // list. array_spread_elements preserves left-to-right spread
                // effects and produces the exact vector consumed by the
                // dynamic native call boundary.
                let mut stmts = Vec::new();
                let callee = self.update_temp(callee, &mut stmts, node.expression());
                let argument_type = Type::Array {
                    elem: Box::new(Type::Dyn),
                };
                let args =
                    self.array_spread_elements(node, source_arguments, argument_type.clone())?;
                return Ok(Expr::Sequence {
                    stmts,
                    result: Box::new(Expr::LibCall {
                        r#fn: "dyn.callSpread".into(),
                        args: vec![callee, args],
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                });
            }
            let args = source_arguments
                .into_iter()
                .map(|n| self.expected_expression(n, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Expr::DynCall {
                callee: Box::new(callee),
                callee_name,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        let Type::Func { params, ret, rest } = callee.ty() else {
            let checked = self.ty(target);
            let owning = self.contextual_type_description(&callee.ty());
            let guarded = self.directly_truthy_selected_property(target);
            return Err(self.refuse(
                node,
                &format!(
                    "callee has no native function representation: owning={owning}, checked={checked:?}, guarded={guarded}, target={} ({:?})",
                    target.text(),
                    target.kind(),
                ),
            ));
        };
        let source_arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if source_arguments
            .iter()
            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            // A spread can supply a runtime-sized list even when TypeScript's
            // projected callable ABI is fixed (common in emitted JavaScript
            // wrappers). Invoke the same Rust closure through NativeValue so
            // JavaScript argument truncation/defaulting remains centralized.
            let result_type = (*ret).clone();
            let callee = self.coerce(callee, Type::Dyn, node.expression())?;
            let mut stmts = Vec::new();
            let callee = self.update_temp(callee, &mut stmts, node.expression());
            let arguments = self.array_spread_elements(
                node,
                source_arguments,
                Type::Array {
                    elem: Box::new(Type::Dyn),
                },
            )?;
            let result = Expr::LibCall {
                r#fn: "dyn.callSpread".into(),
                args: vec![callee, arguments],
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            let result = self.coerce(result, result_type.clone(), node)?;
            return Ok(Expr::Sequence {
                stmts,
                result: Box::new(result),
                r#type: result_type,
                loc: self.loc(node),
            });
        }
        if !rest && source_arguments.len() > params.len() {
            // JavaScript evaluates the callee and every supplied argument from
            // left to right even when a fixed-arity function ignores trailing
            // values. Snapshot the values accepted by the native ABI and keep
            // the trailing expressions as statements before making the call.
            let callee_local = self.construction_local(callee.ty(), false);
            let mut stmts = vec![Stmt::VarDecl {
                local_id: callee_local.id.clone(),
                init: callee,
                loc: self.loc(node.expression()),
            }];
            let mut args = Vec::with_capacity(params.len());
            for (index, argument) in source_arguments.into_iter().enumerate() {
                if let Some(ty) = params.get(index) {
                    let value = self.expected_expression(argument, ty.clone())?;
                    let local = self.construction_local(ty.clone(), false);
                    stmts.push(Stmt::VarDecl {
                        local_id: local.id.clone(),
                        init: value,
                        loc: self.loc(argument),
                    });
                    args.push(self.construction_read(&local, argument));
                } else {
                    stmts.push(Stmt::Expression {
                        expr: self.expression(argument)?,
                        loc: self.loc(argument),
                    });
                }
            }
            let result_type = (*ret).clone();
            return Ok(Expr::Sequence {
                stmts,
                result: Box::new(Expr::CallValue {
                    callee: Box::new(self.construction_read(&callee_local, node.expression())),
                    args,
                    r#type: result_type.clone(),
                    loc: self.loc(node),
                }),
                r#type: result_type,
                loc: self.loc(node),
            });
        }
        let args = self.rest_call_arguments(node, &params, rest)?;
        Ok(Expr::CallValue {
            callee: Box::new(callee),
            args,
            r#type: *ret,
            loc: self.loc(node),
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn named_function_self_assignment_does_not_mutate_the_recursion_cell() {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let input = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/named-function-self/assignment.cjs")
                    .canonicalize()
                    .unwrap();
                let work = tempfile::Builder::new()
                    .prefix("scriptc-self-assignment-")
                    .tempdir()
                    .unwrap();
                let error = match crate::frontend::lower(&input, work.path(), None, false) {
                    Ok(_) => {
                        panic!("assignment to the immutable self binding must not mutate its cell")
                    }
                    Err(error) => error,
                };
                assert!(
                    error.contains("assignment to an immutable binding"),
                    "{error}"
                );
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn generic_callback_that_inspects_weak_map_dispatches() {
        // An erased owner keeps its WeakMap native; a dynamic read of that
        // WeakMap dispatches get/set/has/delete on the same native handle
        // (behavior pinned by tests/corpus/rust-native-erased-weakmap-dispatch).
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/generic-weakmap-inspection");
                let project = std::fs::canonicalize(root.join("tsconfig.json")).unwrap();
                for entry in ["main.mts", "leak.mts"] {
                    let input = std::fs::canonicalize(root.join(entry)).unwrap();
                    let work = tempfile::Builder::new()
                        .prefix("scriptc-native-")
                        .tempdir()
                        .unwrap();
                    let module = crate::frontend::lower(&input, work.path(), Some(&project), false)
                        .unwrap_or_else(|error| panic!("{entry}: {error}"));
                    let rust = crate::emit::rust(&module).unwrap_or_else(|error| panic!("{entry}: {error}"));
                    assert!(
                        !rust.contains("erasing WeakMap requires a native property descriptor contract"),
                        "{entry}: dynamic WeakMap reads dispatch on the native handle"
                    );
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
