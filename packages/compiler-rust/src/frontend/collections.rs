//! Typed maps, string-indexed records and owning data-property lookups.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    pub(super) fn standard_map_values_call(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.is_nil()
            || node.kind() != SyntaxKind::CallExpression
            || !node.question_dot_token().is_nil()
            || !node.arguments().is_empty()
        {
            return false;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "values"
            || !member.question_dot_token().is_nil()
        {
            return false;
        }
        let symbol = self.symbol(member.name());
        self.primitive_symbol(symbol, "values", Some("Map"))
            || self.primitive_symbol(symbol, "values", Some("ReadonlyMap"))
    }

    pub(super) fn immediate_map_values_iterator(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let node = primitives::primitive_source(node);
        if !self.standard_map_values_call(node) {
            return Ok(None);
        }
        let member = node.expression();
        let receiver = self.expression(member.expression())?;
        if !matches!(receiver.ty(), Type::Map { .. }) {
            return Ok(None);
        }
        Ok(Some(Expr::MapIntrinsic {
            method: "valuesIterator".into(),
            receiver: Box::new(receiver),
            args: vec![],
            r#type: Type::Generator {
                r#async: false,
                yield_type: Box::new(Type::Dyn),
                return_type: Box::new(Type::Void),
                next_type: Box::new(Type::Undefined),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn immediate_map_iteration(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression
            || !node.question_dot_token().is_nil()
            || node.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !member.question_dot_token().is_nil()
            || !matches!(member.name().text(), "keys" | "values" | "entries")
        {
            return Ok(None);
        }
        let method = member.name().text();
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, method, Some("Map"))
            && !self.primitive_symbol(symbol, method, Some("ReadonlyMap"))
        {
            return Ok(None);
        }
        let receiver = self.expression(member.expression())?;
        if !matches!(receiver.ty(), Type::Map { .. }) {
            return Ok(None);
        }
        self.map_intrinsic(node, receiver, method, vec![]).map(Some)
    }

    fn standard_map_keys_call(&mut self, node: Node) -> bool {
        if node.is_nil()
            || node.kind() != SyntaxKind::CallExpression
            || !node.question_dot_token().is_nil()
            || node.arguments().into_iter().next().is_some()
        {
            return false;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !member.question_dot_token().is_nil()
            || member.name().text() != "keys"
        {
            return false;
        }
        let symbol = self.symbol(member.name());
        self.primitive_symbol(symbol, "keys", Some("Map"))
            || self.primitive_symbol(symbol, "keys", Some("ReadonlyMap"))
    }

    /// A stored `Map.keys()` snapshot owns one shared native array. Consuming
    /// it mutates that array in place, so aliases of the iterator retain one
    /// cursor instead of each receiving an independent copied position.
    pub(super) fn stored_map_next(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression
            || !node.question_dot_token().is_nil()
            || node.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !member.question_dot_token().is_nil()
            || member.name().text() != "next"
        {
            return Ok(None);
        }
        let receiver = receivers::reference_node(member.expression());
        if receiver.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let symbol = self.symbol(receiver);
        let declaration = (symbol != 0)
            .then(|| {
                self.checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .value_declaration
            })
            .filter(|declaration| declaration.kind() == SyntaxKind::VariableDeclaration);
        let Some(declaration) = declaration else {
            return Ok(None);
        };
        if !self.standard_map_keys_call(receivers::reference_node(declaration.initializer())) {
            return Ok(None);
        }
        let iterator = self.expression(receiver)?;
        if !matches!(iterator.ty(), Type::Array { .. }) {
            return Ok(None);
        }
        let iterator = self.coerce(iterator, Type::Dyn, receiver)?;
        let result = Expr::LibCall {
            r#fn: "dyn.arrayIteratorNextResult".into(),
            args: vec![iterator],
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        let target = self.ty(node)?;
        self.coerce(result, target, node).map(Some)
    }

    /// Preserve a stored built-in Map key iterator as one stateful native
    /// snapshot. The array is private to the iterator binding; `.next()`
    /// consumes it through `stored_map_next` above.
    pub(super) fn stored_map_keys_initializer(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        if !self.standard_map_keys_call(receivers::reference_node(node)) {
            return Ok(None);
        }
        self.immediate_map_keys(receivers::reference_node(node))
    }

    /// Materialize the first result of an immediately consumed Map key
    /// iterator. The iterator itself cannot escape this syntax, so a snapshot
    /// preserves insertion order while the returned `{ value, done }` object
    /// keeps the standard iterator-result shape used by subsequent reads.
    pub(super) fn immediate_map_next(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression
            || !node.question_dot_token().is_nil()
            || node.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let next = node.expression();
        if next.kind() != SyntaxKind::PropertyAccessExpression
            || next.name().text() != "next"
            || !next.question_dot_token().is_nil()
        {
            return Ok(None);
        }
        let keys = next.expression();
        let Some(keys) = self.immediate_map_keys(keys)? else {
            return Ok(None);
        };
        let keys = self.coerce(keys, Type::Dyn, node)?;
        let result = Expr::LibCall {
            r#fn: "dyn.arrayIteratorFirstResult".into(),
            args: vec![keys],
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        let target = self.ty(node)?;
        self.coerce(result, target, node).map(Some)
    }

    /// Read the first key from an immediately consumed built-in Map iterator.
    /// No iterator object escapes this expression, so a native key snapshot
    /// preserves the observable insertion order without adding a heap ABI for
    /// general live Map iterators.
    pub(super) fn immediate_map_first(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.name().text() != "value" || !node.question_dot_token().is_nil() {
            return Ok(None);
        }
        let next = node.expression();
        if next.kind() != SyntaxKind::CallExpression
            || !next.question_dot_token().is_nil()
            || next.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let next_member = next.expression();
        if next_member.kind() != SyntaxKind::PropertyAccessExpression
            || next_member.name().text() != "next"
            || !next_member.question_dot_token().is_nil()
        {
            return Ok(None);
        }
        let keys = next_member.expression();
        if keys.kind() != SyntaxKind::CallExpression
            || !keys.question_dot_token().is_nil()
            || keys.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let member = keys.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "keys"
            || !member.question_dot_token().is_nil()
        {
            return Ok(None);
        }
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, "keys", Some("Map"))
            && !self.primitive_symbol(symbol, "keys", Some("ReadonlyMap"))
        {
            return Ok(None);
        }
        let receiver = self.expression(member.expression())?;
        // An erased `this.cache` (a `$dynamic` method body) or an owning
        // union slot whose checked view is a Map: check that Map view.
        let receiver = if !matches!(receiver.ty(), Type::Map { .. })
            && matches!(receiver.ty(), Type::Dyn | Type::Union { .. })
            && let Ok(map @ Type::Map { .. }) = self.ty(member.expression())
        {
            let value = self.coerce(receiver, Type::Dyn, member.expression())?;
            self.coerce(value, map, member.expression())?
        } else {
            receiver
        };
        let Type::Map { key, .. } = receiver.ty() else {
            return Ok(None);
        };
        let result = self
            .intern_union(vec![(*key).clone(), Type::Undefined])
            .ok_or_else(|| self.refuse(node, "Map iterator result has no native representation"))?;
        let mut helper = helpers::Helper::new(
            "map_immediate_first",
            vec![receiver.ty()],
            result.clone(),
            self.loc(node),
        );
        let array_ty = Type::Array { elem: key.clone() };
        let array = helper.local("keys", array_ty.clone(), false);
        helper.declare(
            &array,
            Expr::MapIntrinsic {
                method: "keysToArray".into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args: vec![],
                r#type: array_ty,
                loc: helper.loc(),
            },
        );
        let present = Expr::ArrayGet {
            arr: Box::new(helper.read(&array)),
            index: Box::new(helper.number(0.0)),
            r#type: *key,
            loc: helper.loc(),
        };
        let missing = Expr::UnitLit {
            unit: "undefined",
            r#type: Type::Undefined,
            loc: helper.loc(),
        };
        let test = Expr::Bin {
            op: "!==".into(),
            left: Box::new(helper.length(&array)),
            right: Box::new(helper.number(0.0)),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::If {
            cond: test,
            then: vec![Stmt::Return {
                value: Some(self.coerce(present, result.clone(), node)?),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        helper.function.body.push(Stmt::Return {
            value: Some(self.coerce(missing, result.clone(), node)?),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: vec![receiver],
            r#type: result,
            loc: self.loc(node),
        }))
    }

    pub(super) fn inferred_map_new_type(&mut self, node: Node) -> Option<Type> {
        if node.is_nil() || node.kind() != SyntaxKind::NewExpression {
            return None;
        }
        let symbol = self.symbol(node.expression());
        if symbol == 0
            || self.bindings.contains_key(&symbol)
            || self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .name
                .as_ref()
                != "Map"
            || !self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .declarations
                .iter()
                .any(|declaration| {
                    !declaration.is_nil()
                        && source_file_info(get_source_file_of_node(*declaration))
                            .file_name
                            .ends_with("/lib.es2015.collection.d.ts")
                })
        {
            return None;
        }
        let checked = self.checker.get_type_at_location(node);
        if let Some(ty @ Type::Map { .. }) = self.type_id(checked) {
            return Some(ty);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let [seed] = arguments.as_slice() else {
            return None;
        };
        if seed.kind() != SyntaxKind::ArrayLiteralExpression {
            return None;
        }
        let mut keys = Vec::new();
        let mut values = Vec::new();
        for pair in seed.elements() {
            if pair.kind() != SyntaxKind::ArrayLiteralExpression {
                return None;
            }
            let elements = pair.elements().into_iter().collect::<Vec<_>>();
            if elements.len() != 2 {
                return None;
            }
            let key_id = self.checker.get_type_at_location(elements[0]);
            let key = self.type_id(key_id).unwrap_or(Type::Dyn);
            let value_id = self.checker.get_type_at_location(elements[1]);
            let value = self.type_id(value_id).unwrap_or_else(|| {
                if self.checker.is_array_type(value_id) {
                    Type::Array {
                        elem: Box::new(Type::Dyn),
                    }
                } else {
                    Type::Dyn
                }
            });
            keys.push(key);
            values.push(value);
        }
        let common = |types: Vec<Type>, this: &mut Self| {
            let first = types.first()?.clone();
            if types.iter().all(|ty| *ty == first) {
                Some(first)
            } else {
                this.intern_union(types).or(Some(Type::Dyn))
            }
        };
        let key = common(keys, self)?;
        let key = if matches!(key, Type::String | Type::F64) {
            key
        } else {
            Type::Dyn
        };
        let value = common(values, self)?;
        Some(Type::Map {
            key: Box::new(key),
            value: Box::new(value),
        })
    }

    /// A built-in Map.keys() consumed immediately has no escaping iterator.
    /// Materialize only this syntactic form; stored iterators need live state.
    pub(super) fn immediate_map_keys(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression
            || !node.question_dot_token().is_nil()
            || node.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !member.question_dot_token().is_nil()
            || member.name().text() != "keys"
        {
            return Ok(None);
        }
        let symbol = self.symbol(member.name());
        let declared_map = self.primitive_symbol(symbol, "keys", Some("Map"))
            || self.primitive_symbol(symbol, "keys", Some("ReadonlyMap"));
        let receiver_type = self.ty(member.expression()).ok();
        if receiver_type == Some(Type::Dyn) {
            let receiver = self.expression(member.expression())?;
            let receiver = self.coerce(receiver, Type::Dyn, member.expression())?;
            return Ok(Some(Expr::LibCall {
                r#fn: "dyn.mapKeysImmediate".into(),
                args: vec![receiver],
                r#type: Type::Array {
                    elem: Box::new(Type::Dyn),
                },
                loc: self.loc(node),
            }));
        }
        if !declared_map || !matches!(receiver_type, Some(Type::Map { .. })) {
            return Ok(None);
        }
        let receiver = self.expression(member.expression())?;
        let Type::Map { key, .. } = receiver.ty() else {
            return Ok(None);
        };
        Ok(Some(Expr::MapIntrinsic {
            method: "keysToArray".into(),
            receiver: Box::new(receiver),
            args: vec![],
            r#type: Type::Array { elem: key },
            loc: self.loc(node),
        }))
    }

    pub(super) fn map_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let symbol = self.checker.sym(symbol);
        if !matches!(symbol.name.as_ref(), "Map" | "ReadonlyMap") {
            return None;
        }
        // Recognize the standard library declaration, not a user's same-named class.
        if !symbol.declarations.iter().any(|node| {
            !node.is_nil()
                && source_file_info(get_source_file_of_node(*node))
                    .file_name
                    .ends_with("/lib.es2015.collection.d.ts")
        }) {
            return None;
        }
        let args = self.checker.get_type_arguments(id).to_vec();
        if args.len() != 2 {
            return None;
        }
        let key = self.type_id(args[0])?;
        // The portable Map key ABI stores BigInt and Symbol as owning values.
        // This keeps exact numeric comparison and Symbol identity intact.
        let primitive_key_union = matches!(
            &key,
            Type::Union { union_id }
                if self.unions[*union_id]
                    .arms
                    .iter()
                    .all(|arm| matches!(arm, Type::String | Type::F64 | Type::Bigint | Type::Symbol | Type::Bool))
        );
        let key = if matches!(key, Type::Bigint | Type::Symbol) || primitive_key_union {
            Type::Dyn
        } else {
            key
        };
        let mut value = self.type_id(args[1]).or_else(|| {
            // Function-like interfaces can carry signatures whose parameter
            // or return shapes have no closed native callable ABI. A Map owns
            // the live JavaScript value rather than projecting its signature,
            // so retain callable identity in the dynamic slot. Calls after a
            // get still validate through NativeValue's callable dispatch.
            (!self
                .checker
                .get_signatures_of_type(args[1], source_frontend::prelude::SignatureKind::CALL)
                .is_empty())
            .then_some(Type::Dyn)
        })?;
        if matches!(value, Type::Func { .. }) {
            value = Type::Dyn;
        }
        // An index-only object is stored as dynamic property slots. Erase that
        // value at the Map ABI boundary so mutable Map and ReadonlyMap aliases
        // share the same native storage, including recursive JSON dictionaries.
        if matches!(value, Type::Record { shape_id }
            if self.records[shape_id].fields.is_empty()
                && self.records[shape_id].index_value.is_some())
        {
            value = Type::Dyn;
        }
        // The portable Map ABI accepts owning union values, but not a bare
        // bytes slot. Keep u8 payloads typed and traced in the same optional
        // union needed by Map.get; an absent entry still has no stored value.
        if matches!(value, Type::Bytes { .. }) {
            value = self.intern_union(vec![value, Type::Undefined])?;
        }
        if !matches!(key, Type::String | Type::F64 | Type::Dyn)
            || matches!(
                value,
                Type::Void | Type::Null | Type::Undefined | Type::Func { .. } | Type::Stats
            )
            || matches!(&value, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Stats))
        {
            return None;
        }
        Some(Type::Map {
            key: Box::new(key),
            value: Box::new(value),
        })
    }

    pub(super) fn lookup_type(&mut self, value: Type, node: Node) -> Result<Type, String> {
        let mut arms = match value {
            Type::Union { union_id } => self.unions[union_id].arms.clone(),
            value => vec![value],
        };
        arms.push(Type::Undefined);
        self.intern_union(arms)
            .ok_or_else(|| self.refuse(node, "lookup result has no undefined representation"))
    }

    pub(super) fn map_new(&mut self, node: Node) -> Result<Expr, String> {
        self.map_new_expected(node, None)
    }

    pub(super) fn map_new_expected(
        &mut self,
        node: Node,
        expected: Option<Type>,
    ) -> Result<Expr, String> {
        let ty = if let Some(ty) = expected {
            ty
        } else {
            self.ty(node)?
        };
        let Type::Map { key, value } = &ty else {
            return Err(self.refuse(node, "only native Map construction is ported"));
        };
        // A structural return type alone cannot prove which constructor ran.
        let symbol = self.symbol(node.expression());
        if symbol == 0
            || self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .name
                .as_ref()
                != "Map"
            || self.bindings.contains_key(&symbol)
            || !self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .declarations
                .iter()
                .any(|node| {
                    !node.is_nil()
                        && source_file_info(get_source_file_of_node(*node))
                            .file_name
                            .ends_with("/lib.es2015.collection.d.ts")
                })
        {
            return Err(self.refuse(node, "Map constructor must be the standard library value"));
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1 {
            return Err(self.refuse(node, "Map constructor arity is not ported"));
        }
        let mut seed = Vec::new();
        if let Some(argument) = arguments.first() {
            if argument.kind() != SyntaxKind::ArrayLiteralExpression {
                // Map is itself an iterable of entry tuples.  Materialize its
                // entries using the source key/value ABI, then reuse the
                // ordinary entry-array conversion so a typed destination can
                // validate/project values that arrived through Map<any, any>.
                // The helper builds a fresh map, preserving JavaScript's
                // snapshot and identity semantics for `new Map(existing)`.
                // In JavaScript sources the checker may report the Map
                // constructor's contextual `Iterable<[K, V]>` type for an
                // identifier argument.  The lowered binding retains its real
                // Map storage ABI, which is the authoritative source here.
                let mut lowered_identifier = if argument.kind() == SyntaxKind::Identifier {
                    Some(self.expression(*argument)?)
                } else {
                    None
                };
                let argument_type = if let Some(source) = lowered_identifier.as_ref() {
                    source.ty()
                } else {
                    self.ty(*argument)?
                };
                if let Type::Map {
                    key: source_key,
                    value: source_value,
                } = argument_type
                {
                    let source = if let Some(source) = lowered_identifier.take() {
                        source
                    } else {
                        self.expression(*argument)?
                    };
                    let pair = self
                        .intern_tuple(vec![(*source_key).clone(), (*source_value).clone()])
                        .ok_or_else(|| {
                            self.refuse(*argument, "Map source entry layout is not ported")
                        })?;
                    let entries = Expr::MapIntrinsic {
                        method: "entriesToArray".into(),
                        receiver: Box::new(source),
                        args: vec![],
                        r#type: Type::Array {
                            elem: Box::new(pair),
                        },
                        loc: self.loc(*argument),
                    };
                    return self.map_from_array(node, entries, ty);
                }
                // Preserve the Map constructor's iterable contract while lowering
                // pipelines such as `new Map(items.map(item => [key, value]))`.
                // Without this context, the callback result is inferred as an
                // ordinary homogeneous array and loses the two-slot tuple layout
                // required by the native Map ABI.
                let pair = self
                    .intern_tuple(vec![(**key).clone(), (**value).clone()])
                    .ok_or_else(|| self.refuse(*argument, "Map entry layout is not ported"))?;
                let entries = self.expected_expression(
                    *argument,
                    Type::Array {
                        elem: Box::new(pair),
                    },
                )?;
                return self.map_from_array(node, entries, ty);
            }
            for pair in argument.elements() {
                if pair.kind() != SyntaxKind::ArrayLiteralExpression {
                    let pair = self
                        .intern_tuple(vec![(**key).clone(), (**value).clone()])
                        .ok_or_else(|| self.refuse(pair, "Map entry layout is not ported"))?;
                    let entries = self.expected_expression(
                        *argument,
                        Type::Array {
                            elem: Box::new(pair),
                        },
                    )?;
                    return self.map_from_array(node, entries, ty);
                }
                let elements = pair.elements().into_iter().collect::<Vec<_>>();
                if pair.kind() != SyntaxKind::ArrayLiteralExpression || elements.len() != 2 {
                    return Err(
                        self.refuse(pair, "Map seed entry must be a key/value pair literal")
                    );
                }
                seed.push(ir::MapEntry {
                    key: self.expected_expression(elements[0], (**key).clone())?,
                    value: self.expected_expression(elements[1], (**value).clone())?,
                });
            }
        }
        Ok(Expr::MapNew {
            seed,
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn map_intrinsic(
        &mut self,
        node: Node,
        receiver: Expr,
        method: &str,
        arguments: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Map { key, value } = receiver.ty() else {
            return Err(self.refuse(node, "non-Map receiver"));
        };
        if method == "forEach" {
            if arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(node, "Map.forEach spread arguments are not ported"));
            }
            if let Some(reason) = self.dynamic_erasure_reason(&receiver.ty()) {
                return Err(self.refuse(node, reason));
            }
            let callback = if let Some(argument) = arguments.first() {
                let value = self.expression(*argument)?;
                self.coerce(value, Type::Dyn, *argument)?
            } else {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined".into(),
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?
            };
            let this_arg = if let Some(argument) = arguments.get(1) {
                self.expected_expression(*argument, Type::Dyn)?
            } else {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined".into(),
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?
            };
            let mut statements = Vec::new();
            let (receiver, callback, this_arg) = if arguments.len() > 2 {
                let receiver =
                    self.update_temp(receiver, &mut statements, node.expression().expression());
                let callback = self.update_temp(callback, &mut statements, arguments[0]);
                let this_arg = self.update_temp(this_arg, &mut statements, arguments[1]);
                for argument in arguments.iter().skip(2) {
                    statements.push(Stmt::Expression {
                        expr: self.expression(*argument)?,
                        loc: self.loc(*argument),
                    });
                }
                (receiver, callback, this_arg)
            } else {
                (receiver, callback, this_arg)
            };
            let call = Expr::MapIntrinsic {
                method: "forEach".into(),
                receiver: Box::new(receiver),
                args: vec![callback, this_arg],
                r#type: Type::Void,
                loc: self.loc(node),
            };
            return if statements.is_empty() {
                Ok(call)
            } else {
                Ok(Expr::Sequence {
                    stmts: statements,
                    result: Box::new(call),
                    r#type: Type::Void,
                    loc: self.loc(node),
                })
            };
        }
        if matches!(method, "get" | "has" | "delete")
            && arguments.len() == 1
            && matches!(*key, Type::String | Type::F64)
        {
            // Map queries compare the live key; they never coerce an
            // incompatible value to the map's checker-only key type.
            // Assertions on regex captures likewise do not manufacture a
            // string when the capture is absent.
            let argument = arguments[0];
            let query = self.condition_value(primitives::primitive_source(argument))?;
            let result = if method == "get" {
                self.lookup_type((*value).clone(), node)?
            } else {
                Type::Bool
            };
            if query.ty() == *key {
                return Ok(Expr::MapIntrinsic {
                    method: method.into(),
                    receiver: Box::new(receiver),
                    args: vec![query],
                    r#type: result,
                    loc: self.loc(node),
                });
            }
            let query = self.coerce(query, Type::Dyn, argument)?;
            let mut helper = helpers::Helper::new(
                &format!("map_query_{method}"),
                vec![receiver.ty(), Type::Dyn],
                result.clone(),
                self.loc(node),
            );
            let map = helper.param(0);
            let query_slot = helper.param(1);
            let present = Expr::MapIntrinsic {
                method: method.into(),
                receiver: Box::new(helper.read(&map)),
                args: vec![Expr::DynCheck {
                    value: Box::new(helper.read(&query_slot)),
                    r#type: (*key).clone(),
                    loc: helper.loc(),
                }],
                r#type: result.clone(),
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::If {
                cond: Expr::DynTest {
                    value: Box::new(helper.read(&query_slot)),
                    test: if *key == Type::String {
                        "string"
                    } else {
                        "number"
                    }
                    .into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Return {
                    value: Some(present),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
            let missing = if method == "get" {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: helper.loc(),
                    },
                    result.clone(),
                    node,
                )?
            } else {
                Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }
            };
            helper.function.body.push(Stmt::Return {
                value: Some(missing),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            return Ok(Expr::Call {
                callee,
                args: vec![receiver, query],
                r#type: result,
                loc: self.loc(node),
            });
        }
        let (types, result) = match method {
            "get" => (vec![*key], self.lookup_type(*value, node)?),
            "has" | "delete" => (vec![*key], Type::Bool),
            "size" => (vec![], Type::F64),
            "keys" => (vec![], Type::Array { elem: key.clone() }),
            "values" => (
                vec![],
                Type::Array {
                    elem: value.clone(),
                },
            ),
            "entries" => {
                let pair = self
                    .intern_tuple(vec![(*key).clone(), (*value).clone()])
                    .ok_or_else(|| self.refuse(node, "Map entry tuple has no native layout"))?;
                (
                    vec![],
                    Type::Array {
                        elem: Box::new(pair),
                    },
                )
            }
            // IR set returns void; JavaScript chaining remains explicitly refused.
            "set" => (vec![*key, *value], Type::Void),
            "clear" => (vec![], Type::Void),
            _ => return Err(self.refuse(node, "Map method is not ported")),
        };
        if types.len() != arguments.len() {
            return Err(self.refuse(node, "Map method arity is not ported"));
        }
        let args = arguments
            .into_iter()
            .zip(types)
            .map(|(node, ty)| self.expected_expression(node, ty))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Expr::MapIntrinsic {
            method: match method {
                "entries" => "entriesToArray".into(),
                "keys" => "keysToArray".into(),
                "values" => "valuesToArray".into(),
                _ => method.into(),
            },
            receiver: Box::new(receiver),
            args,
            r#type: result,
            loc: self.loc(node),
        })
    }

    pub(super) fn dictionary_get(
        &mut self,
        node: Node,
        obj: Expr,
        key: Expr,
    ) -> Result<Expr, String> {
        if matches!(obj.ty(), Type::Object { .. }) && key.ty() == Type::Symbol {
            // Native class instances reserve an owning symbol-property table.
            // A private library slot such as `this[kBody]` belongs there; it is
            // not part of the class's fixed string-field layout. Checked JS can
            // merge unrelated unique-symbol projections on a class; retain the
            // owning value until its actual use context selects a representation.
            let obj = self.coerce(obj, Type::Dyn, node)?;
            return Ok(self.dynamic_get(node, obj, key));
        }
        let Type::Record { shape_id } = obj.ty() else {
            let receiver = obj.ty();
            let detail = match receiver {
                Type::Union { union_id } => format!("{:?}", self.unions[union_id].arms),
                _ => format!("{receiver:?}"),
            };
            return Err(self.refuse(
                node,
                &format!(
                    "indexed access needs a native dictionary: receiver {detail}, key {:?}",
                    key.ty()
                ),
            ));
        };
        if self.records[shape_id].index_value.is_none() {
            if self.records[shape_id].tuple
                || self.callables.contains_key(&shape_id)
                || self.enum_shape(shape_id)
            {
                return Err(self.refuse(
                    node,
                    "computed tuple, callable and enum reads require their native member contracts",
                ));
            }
            if let Expr::StrLit { value: name, .. } = &key
                && let Some(field) = self.records[shape_id]
                    .fields
                    .iter()
                    .find(|f| f.name == *name)
                    .cloned()
            {
                let value = Expr::RecordGet {
                    obj: Box::new(obj),
                    shape_id: format!("r{shape_id}"),
                    field: field.name,
                    r#type: field.r#type,
                    loc: self.loc(node),
                };
                return if self.planned_field_read(node) {
                    Ok(value)
                } else {
                    self.narrowed(value, node)
                };
            }
            // A shape describes typed views of known fields, not a whitelist
            // for JavaScript property reads. Keep the original owning store so
            // computed keys observe aliases, extra properties and absence.
            let obj = self.coerce(obj, Type::Dyn, node)?;
            let value = self.dynamic_get(node, obj, key);
            if self.ty(node).is_err() {
                // A computed read can produce a heterogeneous union larger
                // than the closed native union ABI (common for JS lookup
                // tables whose values are many unrelated record shapes).
                // The owning dynamic result is the faithful representation.
                return Ok(value);
            }
            return self.narrowed(value, node);
        }
        let value = self.records[shape_id]
            .index_value
            .clone()
            .ok_or_else(|| self.refuse(node, "indexed access needs a string index signature"))?;
        if key.ty() != Type::String {
            return Err(self.refuse(node, "dictionary key must be a string"));
        }
        let ty = self.lookup_type(value, node)?;
        let value = Expr::RecordKeyGet {
            obj: Box::new(obj),
            shape_id: format!("r{shape_id}"),
            key: Box::new(key),
            overflow_only: true,
            r#type: ty,
            loc: self.loc(node),
        };
        // An index signature describes stored values, not key presence. The
        // checker can omit undefined when noUncheckedIndexedAccess is false.
        // Preserve the lookup tag until a source guard proves its payload.
        Ok(value)
    }

    pub(super) fn dictionary_set(&mut self, node: Node) -> Result<Stmt, String> {
        self.guard_raw_json_write(node)?;
        let member = node.left();
        let obj = self.expression(member.expression())?;
        let obj = self.narrowed(obj, member.expression())?;
        self.dictionary_set_value(node, obj)
    }

    pub(super) fn dictionary_set_value(&mut self, node: Node, obj: Expr) -> Result<Stmt, String> {
        let member = node.left();
        if let Type::Object { class_name } = obj.ty()
            && let Some(field) = self.literal_property_key(member.argument_expression())
        {
            let ty = self.class_index_slot(&class_name, &field, member)?;
            let value = self.expected_expression(node.right(), ty)?;
            return Ok(Stmt::FieldSet {
                obj,
                class_name,
                field,
                value,
                loc: self.loc(node),
            });
        }
        if let Type::Array { elem } = obj.ty()
            && *elem != Type::Dyn
        {
            // The runtime preserves JavaScript's distinction between ordinary
            // array indices and numeric named properties for any f64 key, so a
            // computed numeric expression can share the ordinary ArraySet IR.
            let index = self.expected_expression(member.argument_expression(), Type::F64)?;
            let value = self.expected_expression(node.right(), *elem)?;
            return Ok(self.source_array_set(node, obj, index, value));
        }
        if matches!(obj.ty(), Type::Bytes { .. }) {
            let expr = self.bytes_assignment_value(node, obj, None)?;
            return Ok(Stmt::Expression {
                expr,
                loc: self.loc(node),
            });
        }
        if matches!(obj.ty(), Type::Object { .. })
            && self.ty(member.argument_expression()).ok() == Some(Type::Symbol)
        {
            let obj = self.coerce(obj, Type::Dyn, member)?;
            let key = self.dynamic_property_key_expression(member.argument_expression())?;
            return self.dynamic_property_set(node, obj, key);
        }
        if obj.ty() == Type::Dyn
            || matches!(obj.ty(), Type::Func { .. })
            || matches!(obj.ty(), Type::Union { .. })
            || matches!(obj.ty(), Type::Array { elem } if *elem == Type::Dyn)
        {
            if matches!(obj.ty(), Type::Func { .. }) {
                self.function_member_key(member)?;
            }
            let obj = self.coerce(obj, Type::Dyn, member)?;
            let key = self.dynamic_property_key_expression(member.argument_expression())?;
            return self.dynamic_property_set(node, obj, key);
        }
        let Type::Record { shape_id } = obj.ty() else {
            return Err(self.refuse(
                member,
                &format!(
                    "indexed writes need a native dictionary or array; receiver is {:?}",
                    obj.ty()
                ),
            ));
        };
        if self.enum_shape(shape_id) {
            return Err(self.refuse(
                member,
                "enum namespace mutation outside its initializer is not ported",
            ));
        }
        if self.records[shape_id].index_value.is_none() {
            let name = self.literal_property_key(member.argument_expression());
            if name.is_none()
                && !self.records[shape_id].tuple
                && !self.callables.contains_key(&shape_id)
            {
                // A computed key may name either an existing field or a fresh
                // expando. Ordinary records share one owning property store,
                // so perform the write through its dynamic identity. Later
                // typed reads validate the value currently in that slot.
                let key = self.property_key_expression(member.argument_expression())?;
                let obj = self.coerce(obj, Type::Dyn, member)?;
                return self.dynamic_property_set(node, obj, key);
            }
            let name = name.ok_or_else(|| {
                self.refuse(
                    member,
                    "computed record writes require owning dynamic field slots",
                )
            })?;
            if name == "__proto__" {
                return Err(self.refuse(member, "ordinary prototype writes are not ported"));
            }
            let field = self.records[shape_id]
                .fields
                .iter()
                .find(|f| f.name == name)
                .cloned();
            let Some(field) = field else {
                if !self.records[shape_id].tuple && !self.callables.contains_key(&shape_id) {
                    // A string-literal element write is still an ordinary JS
                    // expando. Aliases of nested `{}` records often hide that
                    // write from declaration inventory (for example HTTP
                    // headers assembled by Octokit), so use the shared owning
                    // property store exactly as property assignment does.
                    let obj = self.coerce(obj, Type::Dyn, member)?;
                    let key = Expr::StrLit {
                        value: name,
                        r#type: Type::String,
                        loc: self.loc(member.argument_expression()),
                    };
                    return self.dynamic_property_set(node, obj, key);
                }
                return Err(self.refuse(
                    member,
                    &format!("unknown native record field {name:?} on r{shape_id}"),
                ));
            };
            let value = self.expected_expression(node.right(), field.r#type)?;
            return Ok(Stmt::RecordSet {
                obj,
                shape_id: format!("r{shape_id}"),
                field: field.name,
                value,
                loc: self.loc(node),
            });
        }
        let value_type = self.records[shape_id]
            .index_value
            .clone()
            .ok_or_else(|| self.refuse(member, "indexed writes need a string index signature"))?;
        let key = if member.kind() == SyntaxKind::PropertyAccessExpression {
            Expr::StrLit {
                value: member.name().text().into(),
                r#type: Type::String,
                loc: self.loc(member),
            }
        } else {
            self.property_key_expression(member.argument_expression())?
        };
        let value = self.expected_expression(node.right(), value_type)?;
        if matches!(&key, Expr::StrLit { value, .. } if value == "__proto__") {
            return Err(self.refuse(member, "dictionary prototype setters are not ported"));
        }
        Ok(Stmt::RecordKeySet {
            obj,
            shape_id: format!("r{shape_id}"),
            key,
            value,
            overflow_only: true,
            loc: self.loc(node),
        })
    }
}
