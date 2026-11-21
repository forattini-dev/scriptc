//! Dense typed arrays: map materializes a fresh array before Map consumes it.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn source_array_set(&self, node: Node, arr: Expr, index: Expr, value: Expr) -> Stmt {
        let loc = self.loc(node);
        if receivers::strict(node) {
            Stmt::ArraySet {
                arr,
                index,
                value,
                loc,
            }
        } else {
            Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "array.setSloppy".into(),
                    args: vec![arr, index, value],
                    r#type: Type::Void,
                    loc: loc.clone(),
                },
                loc,
            }
        }
    }

    pub(super) fn source_array_set_length(&self, node: Node, arr: Expr, length: Expr) -> Stmt {
        let loc = self.loc(node);
        if receivers::strict(node) {
            Stmt::ArraySetLength { arr, length, loc }
        } else {
            Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "array.setLengthSloppy".into(),
                    args: vec![arr, length],
                    r#type: Type::Void,
                    loc: loc.clone(),
                },
                loc,
            }
        }
    }
    /// Prove that indexed reads cannot observe an array hole. This is used by
    /// `find`, whose callback visits holes as `undefined`, to retain a typed
    /// callback ABI only for construction pipelines that materialize every
    /// slot. The proof deliberately follows immutable initializer provenance
    /// instead of trusting an array's TypeScript element annotation.
    pub(super) fn array_indices_are_defined(
        &mut self,
        node: Node,
        active: &mut HashSet<u32>,
    ) -> bool {
        let node = primitives::primitive_source(node);
        match node.kind() {
            SyntaxKind::ArrayLiteralExpression => node.elements().iter().all(|element| {
                if element.kind() == SyntaxKind::OmittedExpression {
                    return false;
                }
                element.kind() != SyntaxKind::SpreadElement
                    || self.array_indices_are_defined(element.expression(), active)
            }),
            SyntaxKind::Identifier => {
                let symbol = self.symbol(node);
                if symbol == 0 || !active.insert(symbol) {
                    return false;
                }
                let declaration = self
                    .checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .value_declaration;
                let result = declaration.kind() == SyntaxKind::VariableDeclaration
                    && !declaration.initializer().is_nil()
                    && self.array_indices_are_defined(declaration.initializer(), active);
                active.remove(&symbol);
                result
            }
            SyntaxKind::CallExpression => {
                let callee = primitives::primitive_source(node.expression());
                if callee.kind() != SyntaxKind::PropertyAccessExpression {
                    return false;
                }
                match callee.name().text() {
                    // These operations always append their result slots
                    // densely, while skipping source holes where applicable.
                    "filter" | "flat" | "flatMap" => true,
                    // These preserve the receiver's hole pattern.
                    "map" | "slice" => self.array_indices_are_defined(callee.expression(), active),
                    _ => false,
                }
            }
            _ => false,
        }
    }

    /// Recognize built-in Array members even after generic substitution or
    /// checked-JavaScript synthesis has replaced the canonical lib.d.ts
    /// symbol. Callers still require represented `Type::Array` storage before
    /// emitting an intrinsic, which is the final dispatch proof.
    pub(super) fn native_array_method_provenance(
        &mut self,
        receiver: Node,
        symbol: u32,
        name: &str,
    ) -> bool {
        if self.primitive_symbol(symbol, name, Some("Array"))
            || self.primitive_symbol(symbol, name, Some("ReadonlyArray"))
        {
            return true;
        }
        let checked = self.checker.get_type_at_location(receiver);
        if self.checker.is_array_type(checked)
            || (self.checker.ty(checked).flags.intersects(TypeFlags::UNION)
                && self
                    .checker
                    .ty(checked)
                    .types()
                    .iter()
                    .any(|arm| self.checker.is_array_type(*arm)))
        {
            return true;
        }
        symbol == 0
            || self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .declarations
                .is_empty()
    }

    /// Preserve the standard unbound splice identity used by transpiled
    /// `[].splice.call(arrayLike, ...)` code. The fresh empty receiver has no
    /// observable evaluation effects; the eventual `call` supplies the real
    /// owning receiver.
    pub(super) fn array_method_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.name().text() != "splice"
            || node.expression().kind() != SyntaxKind::ArrayLiteralExpression
            || !node.expression().elements().is_empty()
        {
            return Ok(None);
        }
        let symbol = self.symbol(node.name());
        if !self.primitive_symbol(symbol, "splice", Some("Array")) {
            return Ok(None);
        }
        Ok(Some(Expr::LibCall {
            r#fn: "array.spliceMethodValue".into(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn array_splice_method_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let call = node.expression();
        if call.kind() != SyntaxKind::PropertyAccessExpression || call.name().text() != "call" {
            return Ok(None);
        }
        let target = call.expression();
        if target.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let symbol = self.symbol(target);
        if symbol == 0 {
            return Ok(None);
        }
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        if declaration.kind() != SyntaxKind::VariableDeclaration {
            return Ok(None);
        }
        let initializer = declaration.initializer();
        if self.array_method_value(initializer)?.is_none() {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let Some(receiver_node) = arguments.first().copied() else {
            return Err(self.refuse(node, "Array.prototype.splice.call requires a receiver"));
        };
        let receiver = self.checked_array_receiver(receiver_node)?;
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(
                receiver_node,
                "splice.call requires a native array receiver",
            ));
        };
        let start = if let Some(value) = arguments.get(1) {
            self.expected_expression(*value, Type::F64)?
        } else {
            Expr::NumLit {
                value: 0.0,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            }
        };
        let delete_count = if let Some(value) = arguments.get(2) {
            self.expected_expression(*value, Type::F64)?
        } else {
            Expr::NumLit {
                value: f64::INFINITY,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            }
        };
        let mut args = vec![start, delete_count];
        for value in arguments.iter().skip(3) {
            args.push(self.expected_expression(*value, (*elem).clone())?);
        }
        Ok(Some(Expr::ArrayIntrinsic {
            method: "splice".into(),
            receiver: Box::new(receiver),
            args,
            r#type: Type::Array { elem },
            loc: self.loc(node),
        }))
    }

    pub(super) fn array_checked_projection(
        &mut self,
        node: Node,
        source: Expr,
        target: Type,
    ) -> Result<Expr, String> {
        let Type::Array { elem: source_elem } = source.ty() else {
            unreachable!("array projection source")
        };
        let Type::Array { elem: target_elem } = &target else {
            unreachable!("array projection target")
        };
        if source_elem == *target_elem || **target_elem == Type::Dyn {
            return Err(self.refuse(
                node,
                "array projection requires distinct source and typed target elements",
            ));
        }
        Ok(Expr::LibCall {
            r#fn: "array.view".into(),
            args: vec![source],
            r#type: target,
            loc: self.loc(node),
        })
    }

    pub(super) fn checked_array_receiver(&mut self, source: Node) -> Result<Expr, String> {
        let value = self.expression(source)?;
        let value = self.live_member_receiver(source, value);
        self.checked_array_value(source, value, false)
    }

    fn checked_mutating_array_receiver(&mut self, source: Node) -> Result<Expr, String> {
        let value = self.expression(source)?;
        let value = self.live_member_receiver(source, value);
        self.checked_array_value(source, value, true)
    }

    pub(super) fn checked_array_value(
        &mut self,
        source: Node,
        value: Expr,
        erase_dynamic: bool,
    ) -> Result<Expr, String> {
        if let Type::Union { union_id } = value.ty() {
            let arms = self.unions[union_id].arms.clone();
            if arms.len() > 1 && arms.iter().all(|arm| matches!(arm, Type::Array { .. })) {
                let concrete = arms
                    .iter()
                    .filter(|arm| !matches!(arm, Type::Array { elem } if **elem == Type::Dyn))
                    .cloned()
                    .collect::<Vec<_>>();
                let target = match concrete.as_slice() {
                    [first, rest @ ..] if rest.iter().all(|arm| arm == first) => first.clone(),
                    _ => Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                };
                // Every arm owns a standard Array. Erase only the union tag,
                // then install a checked element view on the same container.
                let value = self.coerce(value, Type::Dyn, source)?;
                return self.coerce(value, target, source);
            }
            let arrays = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| matches!(arm, Type::Array { .. }))
                .collect::<Vec<_>>();
            let tuples = self.unions[union_id]
                .arms
                .iter()
                .filter(
                    |arm| matches!(arm, Type::Record { shape_id } if self.records[*shape_id].tuple),
                )
                .collect::<Vec<_>>();
            if let [(tag, array)] = arrays.as_slice() {
                if !tuples.is_empty()
                    && self.unions[union_id].arms.iter().all(|arm| {
                        matches!(arm, Type::Null | Type::Undefined)
                            || self.live_container_view_compatible(arm, array)
                    })
                {
                    // `nullableArray ?? []` can retain the empty literal as a
                    // tuple arm. Both arms own array storage; erase the union
                    // tag once and install a checked shared array view instead
                    // of rejecting the method call or copying either arm.
                    let target = (*array).clone();
                    let value = self.coerce(value, Type::Dyn, source)?;
                    return self.coerce(value, target, source);
                }
                return Ok(Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: (*array).clone(),
                    loc: self.loc(source),
                });
            }
        }
        if value.ty() == Type::Dyn
            && !erase_dynamic
            && let Ok(ty @ Type::Array { .. }) = self.ty(source)
        {
            // Public JavaScript class fields may need erased storage while the
            // checker still proves a concrete array at this read. Validate the
            // live value at the method boundary instead of trusting stale flow.
            return self.coerce(value, ty, source);
        }
        if value.ty() == Type::Dyn {
            let checked = self.checker.get_type_at_location(source);
            let array = self.checker.is_array_type(checked)
                || (self.checker.ty(checked).flags.intersects(TypeFlags::UNION)
                    && self
                        .checker
                        .ty(checked)
                        .types()
                        .iter()
                        .any(|arm| self.checker.is_array_type(*arm)));
            if array {
                // The checker may prove an array while its heterogeneous
                // element union has no closed native layout. The owning value
                // still supports the standard Array ABI through erased
                // elements, validated once at the method boundary.
                return self.coerce(
                    value,
                    Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                    source,
                );
            }
        }
        Ok(value)
    }
    pub(super) fn array_concat_result_type(&mut self, node: Node) -> Option<Type> {
        if node.kind() != SyntaxKind::CallExpression {
            return None;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression || member.name().text() != "concat"
        {
            return None;
        }
        let symbol = self.symbol(member.name());
        if !self.native_array_method_provenance(member.expression(), symbol, "concat") {
            return None;
        }
        let source_item = |this: &mut Self, source: Node| {
            let checked = this.checker.get_type_at_location(source);
            if let Some(ty) = this.type_id(checked) {
                return Some(match ty {
                    Type::Array { elem } => *elem,
                    ty => ty,
                });
            }
            if source.kind() == SyntaxKind::ArrayLiteralExpression {
                return Some(Type::Dyn);
            }
            let name = receivers::reference_node(source);
            let name = if name.kind() == SyntaxKind::PropertyAccessExpression {
                name.name()
            } else {
                name
            };
            let symbol = this.symbol(name);
            this.bindings
                .get(&symbol)
                .or_else(|| this.module_bindings.get(&symbol))
                .or_else(|| this.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|binding| match &binding.r#type {
                    Type::Array { elem } => elem.as_ref().clone(),
                    ty => ty.clone(),
                })
                // concat accepts both arrays and scalar values. If the checker
                // cannot close the scalar's layout, the result still has a
                // valid owning element contract.
                .or(Some(Type::Dyn))
        };
        let mut items = vec![source_item(self, member.expression())?];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return None;
            }
            items.push(source_item(self, argument)?);
        }
        let mut arms = Vec::new();
        for item in items {
            if let Type::Union { union_id } = item {
                arms.extend(self.unions[union_id].arms.clone());
            } else {
                arms.push(item);
            }
        }
        // JavaScript concat may combine records whose static union cannot use
        // one closed native tag layout (for example several distinct object
        // class views). The owning dynamic element preserves identity and lets
        // each append perform its normal erasure checks instead of rejecting
        // the whole concat during type planning.
        let elem = self.intern_union(arms).unwrap_or(Type::Dyn);
        Some(Type::Array {
            elem: Box::new(elem),
        })
    }

    pub(super) fn nullable_array_element(&self, ty: &Type) -> Option<Type> {
        let Type::Union { union_id } = ty else {
            return None;
        };
        let arms = &self.unions[*union_id].arms;
        let mut arrays = arms.iter().filter_map(|arm| match arm {
            Type::Array { elem } => Some(elem.as_ref().clone()),
            _ => None,
        });
        let element = arrays.next()?;
        (arrays.next().is_none()
            && arms
                .iter()
                .all(|arm| matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined)))
        .then_some(element)
    }

    pub(super) fn array_view(&self, ty: &Type) -> bool {
        match ty {
            Type::Array { .. } => true,
            Type::Union { union_id } => {
                let arms = &self.unions[*union_id].arms;
                let arrays = arms
                    .iter()
                    .filter(|arm| matches!(arm, Type::Array { .. }))
                    .collect::<Vec<_>>();
                if let [target] = arrays.as_slice() {
                    arms.iter().all(|arm| {
                        matches!(arm, Type::Null | Type::Undefined)
                            || self.live_container_view_compatible(arm, target)
                    })
                } else {
                    !arrays.is_empty()
                        && arms.iter().all(|arm| {
                            matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined)
                        })
                }
            }
            _ => false,
        }
    }

    pub(super) fn array_length(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        if matches!(receiver.ty(), Type::Array { .. }) {
            return Ok(Expr::ArrayIntrinsic {
                method: "length".into(),
                receiver: Box::new(receiver),
                args: vec![],
                r#type: Type::F64,
                loc: self.loc(node),
            });
        }
        let Type::Union { union_id } = receiver.ty() else {
            unreachable!()
        };
        let arms = self.unions[union_id].arms.clone();
        let mut helper = Helper::new(
            "array_length",
            vec![receiver.ty()],
            Type::F64,
            self.loc(node),
        );
        let input = helper.param(0);
        for (tag, arm) in arms.iter().enumerate() {
            let value = if matches!(arm, Type::Array { .. }) {
                // Keep array ownership typed; length does not require erasing
                // the element layout into a generic object representation.
                Expr::ArrayIntrinsic {
                    method: "length".into(),
                    receiver: Box::new(Expr::UnionNarrow {
                        value: Box::new(helper.read(&input)),
                        union_id: format!("u{union_id}"),
                        tag,
                        r#type: arm.clone(),
                        loc: helper.loc(),
                    }),
                    args: vec![],
                    r#type: Type::F64,
                    loc: helper.loc(),
                }
            } else {
                let receiver = self.coerce(
                    Expr::UnitLit {
                        unit: if *arm == Type::Null {
                            "null"
                        } else {
                            "undefined"
                        },
                        r#type: arm.clone(),
                        loc: helper.loc(),
                    },
                    Type::Dyn,
                    node,
                )?;
                let key = Expr::StrLit {
                    value: "length".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                };
                let read = self.dynamic_get(node, receiver, key);
                self.coerce(read, Type::F64, node)?
            };
            let ret = Stmt::Return {
                value: Some(value),
                loc: helper.loc(),
            };
            if tag + 1 == arms.len() {
                helper.function.body.push(ret);
            } else {
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        value: Box::new(helper.read(&input)),
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![ret],
                    else_: None,
                    loc: helper.loc(),
                });
            }
        }
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![receiver],
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }

    /// Each spread is consumed before the next source element is evaluated.
    /// Passing all sources to one eager helper would observe later mutations
    /// too early, or copy a source only after its following element changed it.
    pub(super) fn array_spread_literal(&mut self, node: Node, ty: Type) -> Result<Expr, String> {
        self.array_spread_elements(node, node.elements().into_iter().collect(), ty)
    }

    /// Construct an owned argument array, consuming each spread in place.
    pub(super) fn array_spread_elements(
        &mut self,
        node: Node,
        elements: Vec<Node>,
        ty: Type,
    ) -> Result<Expr, String> {
        let Type::Array { elem } = &ty else {
            unreachable!()
        };
        let output = Local {
            id: format!("array_literal{}", self.locals.len()),
            name: "array construction".into(),
            r#type: ty.clone(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(output.clone());
        let read = |loc: Loc| Expr::VarRef {
            local_id: output.id.clone(),
            r#type: ty.clone(),
            loc,
        };
        let mut stmts = vec![Stmt::VarDecl {
            local_id: output.id.clone(),
            init: Expr::ArrayLit {
                elems: vec![],
                r#type: ty.clone(),
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];
        for element in elements {
            if element.kind() == SyntaxKind::OmittedExpression {
                return Err(self.refuse(
                    element,
                    "array construction with holes requires a sparse iterator contract",
                ));
            }
            let expr = if element.kind() == SyntaxKind::SpreadElement {
                // Observe the live slot, including any undefined tag left by a
                // preceding callback. Unknown/custom iterators stay refused.
                let source_node = primitives::primitive_source(element.expression());
                let source = if let Some(keys) = self.immediate_map_keys(source_node)? {
                    keys
                } else if source_node.kind() == SyntaxKind::ArrayLiteralExpression {
                    // Empty literals have never[] in the checker. Their
                    // elements are contextual at this construction boundary.
                    self.expected_expression(source_node, ty.clone())?
                } else if self.ty(source_node).ok() == Some(ty.clone()) {
                    // The checker can narrow a class field to the exact spread
                    // array while its owning storage still contains multiple
                    // historical array arms. Lower against the contextual
                    // sequence here; `condition_value` would otherwise pick a
                    // different representable arm solely from the live slot.
                    self.expected_expression(source_node, ty.clone())?
                } else {
                    self.condition_value(source_node)?
                };
                let checked_iterable = (source.ty() == Type::Dyn)
                    .then(|| self.ty(source_node).ok())
                    .flatten()
                    .filter(|ty| matches!(ty, Type::Set { .. } | Type::Map { .. } | Type::String));
                let source = if let Some(iterable) = checked_iterable {
                    // Erased storage (for example `map.get(key)` after a
                    // truthiness guard) whose checked view is a native
                    // iterable: check that representation at the spread.
                    self.coerce(source, iterable, source_node)?
                } else if source.ty() == Type::Dyn {
                    // Unannotated JS parameters commonly retain `any` even
                    // when every reachable call passes the path as a dynamic
                    // native array. Array-literal spread already performs an
                    // iterable brand check at runtime; represent the supported
                    // dynamic Array case explicitly instead of rejecting it at
                    // the checker boundary. Other dynamic iterables remain
                    // outside this bounded contract.
                    self.coerce(
                        source,
                        Type::Array {
                            elem: Box::new(Type::Dyn),
                        },
                        source_node,
                    )?
                } else {
                    source
                };
                match source.ty() {
                    Type::Array { .. } => {
                        self.array_extend(element, read(self.loc(element)), source)?
                    }
                    Type::Union { union_id }
                        if {
                            let arms = &self.unions[union_id].arms;
                            let arrays = arms
                                .iter()
                                .filter(|arm| matches!(arm, Type::Array { .. }))
                                .collect::<Vec<_>>();
                            !arrays.is_empty()
                                && arrays.iter().all(|array| *array == arrays[0])
                                && arms.iter().all(|arm| {
                                    matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined)
                                })
                        } =>
                    {
                        // Flow narrowing can expose an array while the owning
                        // slot retains its nullable union ABI. Check the live
                        // tag through NativeValue: the array keeps its identity
                        // and an actually nullish spread still throws.
                        let array = self.unions[union_id]
                            .arms
                            .iter()
                            .find(|arm| matches!(arm, Type::Array { .. }))
                            .cloned()
                            .expect("guarded array arm");
                        let source = self.coerce(source, Type::Dyn, source_node)?;
                        let source = self.coerce(source, array, source_node)?;
                        self.array_extend(element, read(self.loc(element)), source)?
                    }
                    Type::Union { union_id }
                        if self.unions[union_id]
                            .arms
                            .iter()
                            .all(|arm| matches!(arm, Type::Array { .. })) =>
                    {
                        self.array_union_extend(element, read(self.loc(element)), source, union_id)?
                    }
                    Type::Union { union_id }
                        if self.unions[union_id].arms.iter().any(|arm| {
                            matches!(arm, Type::Array { .. } | Type::String | Type::Set { .. })
                                || matches!(arm, Type::Record { shape_id } if self.records[*shape_id].tuple)
                        }) =>
                    {
                        // A correlation guard may establish that a value
                        // produced from another field is iterable even when
                        // TypeScript retains the producer's full scalar/array
                        // union. Dispatch every represented iterable arm and
                        // preserve JavaScript's runtime TypeError for the
                        // remaining non-iterable arms.
                        self.spread_union_extend(
                            element,
                            read(self.loc(element)),
                            source,
                            union_id,
                        )?
                    }
                    Type::String => self.string_extend(element, read(self.loc(element)), source)?,
                    Type::Set { ref elem } => {
                        let array = Type::Array { elem: elem.clone() };
                        let values = Expr::SetIntrinsic {
                            method: "toArray".into(),
                            receiver: Box::new(source),
                            args: vec![],
                            r#type: array,
                            loc: self.loc(element),
                        };
                        self.array_extend(element, read(self.loc(element)), values)?
                    }
                    Type::Map { ref key, ref value } => {
                        let pair = if matches!(elem.as_ref(), Type::Array { elem: item }
                            if **item == **key && **item == **value)
                        {
                            (**elem).clone()
                        } else {
                            self.intern_tuple(vec![(**key).clone(), (**value).clone()])
                                .ok_or_else(|| {
                                    self.refuse(
                                        element,
                                        "Map spread entry has no native tuple representation",
                                    )
                                })?
                        };
                        let entries = Expr::MapIntrinsic {
                            method: "entriesToArray".into(),
                            receiver: Box::new(source),
                            args: vec![],
                            r#type: Type::Array {
                                elem: Box::new(pair),
                            },
                            loc: self.loc(element),
                        };
                        self.array_extend(element, read(self.loc(element)), entries)?
                    }
                    Type::Record { shape_id } if self.records[shape_id].tuple => {
                        self.tuple_extend(element, read(self.loc(element)), source)?
                    }
                    Type::Generator { r#async: false, .. } => {
                        self.generator_extend(element, read(self.loc(element)), source)?
                    }
                    other => {
                        let represented = match other {
                            Type::Union { union_id } => {
                                format!("{other:?}, arms: {:?}", self.unions[union_id].arms)
                            }
                            _ => format!("{other:?}"),
                        };
                        return Err(self.refuse(element, &format!("array spread requires a native array, string, Set, Map or fixed tuple; general iterators are not ported (represented source: {represented})")));
                    }
                }
            } else {
                let value = self.expected_expression(element, (**elem).clone())?;
                Expr::ArrayIntrinsic {
                    method: "push".into(),
                    receiver: Box::new(read(self.loc(element))),
                    args: vec![value],
                    r#type: Type::F64,
                    loc: self.loc(element),
                }
            };
            stmts.push(Stmt::Expression {
                expr,
                loc: self.loc(element),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(read(self.loc(node))),
            r#type: ty.clone(),
            loc: self.loc(node),
        })
    }

    fn array_union_extend(
        &mut self,
        node: Node,
        output: Expr,
        source: Expr,
        union_id: usize,
    ) -> Result<Expr, String> {
        let result_type = output.ty();
        let arms = self.unions[union_id].arms.clone();
        let source_local = self.construction_local(source.ty(), false);
        let mut branches = Vec::new();
        for (tag, arm) in arms.iter().enumerate() {
            let narrowed = Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(self.construction_read(&source_local, node)),
                r#type: arm.clone(),
                loc: self.loc(node),
            };
            let extend = self.array_extend(node, output.clone(), narrowed)?;
            branches.push(vec![Stmt::Expression {
                expr: extend,
                loc: self.loc(node),
            }]);
        }
        let mut tail = branches.pop().expect("non-empty array union spread");
        while let Some(body) = branches.pop() {
            let tag = branches.len();
            tail = vec![Stmt::If {
                cond: Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    negated: false,
                    value: Box::new(self.construction_read(&source_local, node)),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                then: body,
                else_: Some(tail),
                loc: self.loc(node),
            }];
        }
        let mut stmts = vec![Stmt::VarDecl {
            local_id: source_local.id,
            init: source,
            loc: self.loc(node),
        }];
        stmts.extend(tail);
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(output),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    fn spread_union_extend(
        &mut self,
        node: Node,
        output: Expr,
        source: Expr,
        union_id: usize,
    ) -> Result<Expr, String> {
        let result_type = output.ty();
        let arms = self.unions[union_id].arms.clone();
        let source_local = self.construction_local(source.ty(), false);
        let mut branches = Vec::new();
        for (tag, arm) in arms.iter().enumerate() {
            let extend = match arm {
                Type::Array { .. } => self.array_extend(
                    node,
                    output.clone(),
                    Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(self.construction_read(&source_local, node)),
                        r#type: arm.clone(),
                        loc: self.loc(node),
                    },
                )?,
                Type::String => self.string_extend(
                    node,
                    output.clone(),
                    Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(self.construction_read(&source_local, node)),
                        r#type: arm.clone(),
                        loc: self.loc(node),
                    },
                )?,
                Type::Set { elem } => {
                    let values = Expr::SetIntrinsic {
                        method: "toArray".into(),
                        receiver: Box::new(Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(self.construction_read(&source_local, node)),
                            r#type: arm.clone(),
                            loc: self.loc(node),
                        }),
                        args: vec![],
                        r#type: Type::Array { elem: elem.clone() },
                        loc: self.loc(node),
                    };
                    self.array_extend(node, output.clone(), values)?
                }
                Type::Record { shape_id } if self.records[*shape_id].tuple => self.tuple_extend(
                    node,
                    output.clone(),
                    Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(self.construction_read(&source_local, node)),
                        r#type: arm.clone(),
                        loc: self.loc(node),
                    },
                )?,
                _ => {
                    // A unit arm has no standalone storage and therefore must
                    // never be extracted as `Null`/`Undefined`. Box the owning
                    // union instead; the active tag preserves the exact value
                    // and the iterable brand check below raises JavaScript's
                    // TypeError for every non-iterable scalar arm.
                    let dynamic =
                        self.coerce(self.construction_read(&source_local, node), Type::Dyn, node)?;
                    let checked = self.coerce(
                        dynamic,
                        Type::Array {
                            elem: Box::new(Type::Dyn),
                        },
                        node,
                    )?;
                    self.array_extend(node, output.clone(), checked)?
                }
            };
            branches.push(vec![Stmt::Expression {
                expr: extend,
                loc: self.loc(node),
            }]);
        }
        let mut tail = branches.pop().expect("non-empty spread union");
        while let Some(body) = branches.pop() {
            let tag = branches.len();
            tail = vec![Stmt::If {
                cond: Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    negated: false,
                    value: Box::new(self.construction_read(&source_local, node)),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                then: body,
                else_: Some(tail),
                loc: self.loc(node),
            }];
        }
        let mut stmts = vec![Stmt::VarDecl {
            local_id: source_local.id,
            init: source,
            loc: self.loc(node),
        }];
        stmts.extend(tail);
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(output),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    fn string_extend(&mut self, node: Node, output: Expr, source: Expr) -> Result<Expr, String> {
        let Type::Array { elem } = output.ty() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            "string_extend",
            vec![output.ty(), Type::String],
            output.ty(),
            self.loc(node),
        );
        let result = helper.param(0);
        let input = helper.param(1);
        let index = helper.local("index", Type::F64, true);
        helper.declare(&index, helper.number(0.0));
        let loc = helper.loc();
        let width = self.string_iteration_width(helper.read(&input), helper.read(&index), node);
        let next = Expr::Bin {
            op: "+".into(),
            left: Box::new(helper.read(&index)),
            right: Box::new(width),
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let item = Expr::StringIntrinsic {
            method: "slice".into(),
            receiver: Box::new(helper.read(&input)),
            args: vec![helper.read(&index), next.clone()],
            r#type: Type::String,
            loc: loc.clone(),
        };
        let item = self.coerce(item, *elem, node)?;
        let length = Expr::StringIntrinsic {
            method: "length".into(),
            receiver: Box::new(helper.read(&input)),
            args: vec![],
            r#type: Type::F64,
            loc: loc.clone(),
        };
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, length),
            body: vec![
                Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&result)),
                        args: vec![item],
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::Assign {
                    local_id: index.id.clone(),
                    value: next,
                    initializes_global: false,
                    loc: loc.clone(),
                },
            ],
            loc,
        });
        let callee = self.install_helper(helper.finish(&result));
        Ok(Expr::Call {
            callee,
            args: vec![output, source],
            r#type: result.r#type,
            loc: self.loc(node),
        })
    }

    pub(super) fn array_extend(
        &mut self,
        node: Node,
        output: Expr,
        source: Expr,
    ) -> Result<Expr, String> {
        let Type::Array { elem: target } = output.ty() else {
            unreachable!()
        };
        let Type::Array { elem } = source.ty() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            "array_extend",
            vec![output.ty(), source.ty()],
            output.ty(),
            self.loc(node),
        );
        let result = helper.param(0);
        let input = helper.param(1);
        let index = helper.local("index", Type::F64, true);
        helper.declare(&index, helper.number(0.0));
        let item = self.coerce(helper.get(&input, &index, *elem), (*target).clone(), node)?;
        let admits_undefined = matches!(*target, Type::Dyn | Type::Undefined)
            || matches!(*target, Type::Union { union_id }
                if self.unions[union_id].arms.contains(&Type::Undefined));
        let item = if admits_undefined {
            // Array iterators yield undefined for holes as well as explicitly
            // undefined slots. Do not read a missing typed payload before
            // constructing the undefined value for that position.
            Expr::Ternary {
                cond: Box::new(Expr::ArrayIntrinsic {
                    method: "hasStoredValue".into(),
                    receiver: Box::new(helper.read(&input)),
                    args: vec![helper.read(&index)],
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                then: Box::new(item),
                else_: Box::new(self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: helper.loc(),
                    },
                    (*target).clone(),
                    node,
                )?),
                r#type: *target,
                loc: helper.loc(),
            }
        } else {
            item
        };
        let push = Expr::ArrayIntrinsic {
            method: "push".into(),
            receiver: Box::new(helper.read(&result)),
            args: vec![item],
            r#type: Type::F64,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.length(&input)),
            body: vec![
                Stmt::Expression {
                    expr: push,
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&result));
        Ok(Expr::Call {
            callee,
            args: vec![output, source],
            r#type: result.r#type,
            loc: self.loc(node),
        })
    }

    /// Spread a live synchronous generator: drive `next(undefined)` until the
    /// result is done, appending each yielded value in order. The generator
    /// handle is consumed exactly like `for...of`, so later spreads of the
    /// same generator observe the advanced state.
    pub(super) fn generator_extend(
        &mut self,
        node: Node,
        output: Expr,
        source: Expr,
    ) -> Result<Expr, String> {
        let Type::Array { elem: target } = output.ty() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            "generator_extend",
            vec![output.ty(), source.ty()],
            output.ty(),
            self.loc(node),
        );
        let result = helper.param(0);
        let input = helper.param(1);
        let step = helper.local("step", Type::Dyn, false);
        let loc = helper.loc();
        let step_read = Expr::VarRef {
            local_id: step.id.clone(),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let key = |name: &str| Expr::StrLit {
            value: name.into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let done = self.dynamic_get(node, step_read.clone(), key("done"));
        let value = self.dynamic_get(node, step_read, key("value"));
        let value = self.coerce(value, (*target).clone(), node)?;
        let Type::Generator { next_type, .. } = source.ty() else {
            unreachable!("generator spread source")
        };
        let undefined = |ty: Type| Expr::UnitLit {
            unit: "undefined",
            r#type: ty,
            loc: loc.clone(),
        };
        let resume = match *next_type {
            Type::Void => undefined(Type::Void),
            Type::Undefined => undefined(Type::Undefined),
            other => self.coerce(undefined(Type::Undefined), other, node)?,
        };
        helper.function.body.push(Stmt::While {
            cond: Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            body: vec![
                Stmt::VarDecl {
                    local_id: step.id.clone(),
                    init: Expr::GeneratorNext {
                        generator: Box::new(helper.read(&input)),
                        value: Box::new(resume),
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::If {
                    cond: Expr::DynTest {
                        value: Box::new(done),
                        test: "truthy".into(),
                        negated: false,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    then: vec![Stmt::Break {
                        target_depth: 0,
                        loc: loc.clone(),
                    }],
                    else_: None,
                    loc: loc.clone(),
                },
                Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&result)),
                        args: vec![value],
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
            ],
            loc: loc.clone(),
        });
        let callee = self.install_helper(helper.finish(&result));
        Ok(Expr::Call {
            callee,
            args: vec![output, source],
            r#type: result.r#type,
            loc: self.loc(node),
        })
    }

    pub(super) fn array_prototype_push_apply(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let apply = node.expression();
        if apply.kind() != SyntaxKind::PropertyAccessExpression || apply.name().text() != "apply" {
            return Ok(None);
        }
        let push = apply.expression();
        if push.kind() != SyntaxKind::PropertyAccessExpression || push.name().text() != "push" {
            return Ok(None);
        }
        let prototype = push.expression();
        if prototype.kind() != SyntaxKind::PropertyAccessExpression
            || prototype.name().text() != "prototype"
            || prototype.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let array_symbol = self.symbol(prototype.expression());
        let push_symbol = self.symbol(push.name());
        if !self.primitive_symbol(array_symbol, "Array", None)
            || !self.primitive_symbol(push_symbol, "push", Some("Array"))
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let [target, source] = args.as_slice() else {
            return Err(self.refuse(
                node,
                "Array.prototype.push.apply requires target and source arrays",
            ));
        };
        let target = self.expression(*target)?;
        let source = self.expression(*source)?;
        if !matches!(target.ty(), Type::Array { .. }) || !matches!(source.ty(), Type::Array { .. })
        {
            let target = self.coerce(target, Type::Dyn, node)?;
            let source = self.coerce(source, Type::Dyn, node)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "array.pushApplyDynamic".into(),
                args: vec![target, source],
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        let extended = self.array_extend(node, target, source)?;
        let local = self.construction_local(extended.ty(), false);
        let length = Expr::ArrayIntrinsic {
            method: "length".into(),
            receiver: Box::new(self.construction_read(&local, node)),
            args: vec![],
            r#type: Type::F64,
            loc: self.loc(node),
        };
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::VarDecl {
                local_id: local.id,
                init: extended,
                loc: self.loc(node),
            }],
            result: Box::new(length),
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    fn tuple_extend(&mut self, node: Node, output: Expr, source: Expr) -> Result<Expr, String> {
        let Type::Array { elem } = output.ty() else {
            unreachable!()
        };
        let Type::Record { shape_id } = source.ty() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            "tuple_extend",
            vec![output.ty(), source.ty()],
            output.ty(),
            self.loc(node),
        );
        let result = helper.param(0);
        let input = helper.param(1);
        for name in self.records[shape_id].declared_order.clone() {
            let field = self.records[shape_id]
                .fields
                .iter()
                .find(|field| field.name == name)
                .expect("required tuple position");
            let item = Expr::RecordGet {
                obj: Box::new(helper.read(&input)),
                shape_id: format!("r{shape_id}"),
                field: name,
                r#type: field.r#type.clone(),
                loc: helper.loc(),
            };
            let item = self.coerce(item, (*elem).clone(), node)?;
            helper.function.body.push(Stmt::Expression {
                expr: Expr::ArrayIntrinsic {
                    method: "push".into(),
                    receiver: Box::new(helper.read(&result)),
                    args: vec![item],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                loc: helper.loc(),
            });
        }
        let callee = self.install_helper(helper.finish(&result));
        Ok(Expr::Call {
            callee,
            args: vec![output, source],
            r#type: result.r#type,
            loc: self.loc(node),
        })
    }

    pub(super) fn supported_array_method(name: &str) -> bool {
        matches!(
            name,
            "concat"
                | "fill"
                | "at"
                | "includes"
                | "sort"
                | "reverse"
                | "some"
                | "every"
                | "forEach"
                | "filter"
                | "slice"
                | "find"
                | "findIndex"
                | "reduce"
                | "reduceRight"
                | "map"
                | "flat"
                | "flatMap"
                | "join"
                | "pop"
                | "shift"
                | "indexOf"
                | "entries"
                | "splice"
                | "push"
                | "unshift"
        )
    }

    pub(super) fn is_array_map(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression || member.name().text() != "map" {
            return false;
        }
        let receiver = member.expression();
        let symbol = self.symbol(receiver);
        let ty = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .map(|l| l.r#type.clone())
            .or_else(|| self.ty(receiver).ok());
        matches!(ty, Some(Type::Array { .. }))
    }

    fn array_fill(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if !self.native_array_method_provenance(member.expression(), symbol, "fill") {
            return Err(self.refuse(member, "array.fill requires its standard declaration"));
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty()
            || arguments.len() > 3
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "array.fill requires a value and at most two numeric indices",
            ));
        }
        let receiver = self.checked_mutating_array_receiver(member.expression())?;
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "array.fill requires a native array"));
        };
        let mut args = vec![self.expected_expression(arguments[0], *elem)?];
        for arg in arguments.iter().skip(1) {
            args.push(self.expected_expression(*arg, Type::F64)?);
        }
        Ok(Expr::ArrayIntrinsic {
            method: "fill".into(),
            r#type: receiver.ty(),
            receiver: Box::new(receiver),
            args,
            loc: self.loc(node),
        })
    }

    fn array_reverse(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if !self.native_array_method_provenance(member.expression(), symbol, "reverse") {
            return Err(self.refuse(member, "array.reverse requires its standard declaration"));
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "array.reverse does not accept arguments"));
        }
        let receiver = self.checked_mutating_array_receiver(member.expression())?;
        Ok(Expr::ArrayIntrinsic {
            method: "reverse".into(),
            r#type: receiver.ty(),
            receiver: Box::new(receiver),
            args: vec![],
            loc: self.loc(node),
        })
    }

    pub(super) fn array_call(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        if member.name().text() == "concat" {
            return self.array_concat(node);
        }
        if member.name().text() == "fill" {
            return self.array_fill(node);
        }
        if member.name().text() == "at" {
            return self.array_at(node);
        }
        if member.name().text() == "includes" {
            return self.array_includes(node);
        }
        if member.name().text() == "sort" {
            return self.array_sort(node);
        }
        if member.name().text() == "reverse" {
            return self.array_reverse(node);
        }
        if matches!(
            member.name().text(),
            "some"
                | "every"
                | "forEach"
                | "filter"
                | "slice"
                | "find"
                | "findIndex"
                | "reduce"
                | "reduceRight"
        ) {
            return self.array_sequence_method(node);
        }
        if member.name().text() == "map" {
            return self.array_map(node, None);
        }
        if member.name().text() == "flat" {
            return self.array_flat(node);
        }
        if member.name().text() == "flatMap" {
            return self.array_flat_map(node);
        }
        if member.name().text() == "join" {
            return self.array_join(node);
        }
        if member.name().text() == "pop" {
            return self.array_pop(node);
        }
        if member.name().text() == "shift" {
            return self.array_shift(node);
        }
        if member.name().text() == "indexOf" {
            return self.array_index_of(node);
        }
        if member.name().text() == "entries" {
            return self.array_entries(node);
        }
        if member.name().text() == "splice" {
            return self.array_splice(node);
        }
        if !matches!(member.name().text(), "push" | "unshift") {
            return Err(self.refuse(node, "array method is not ported"));
        }
        let method = member.name().text();
        let receiver = self.checked_mutating_array_receiver(member.expression())?;
        self.array_mutation_value(node, receiver, method)
    }

    pub(super) fn array_mutation_value(
        &mut self,
        node: Node,
        receiver: Expr,
        method: &str,
    ) -> Result<Expr, String> {
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "non-array receiver"));
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments
            .iter()
            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            // Materialize the complete argument list before mutating the
            // receiver. This preserves `target.push(...target)` and the
            // left-to-right evaluation order of mixed ordinary/spread args.
            let values =
                self.array_spread_elements(node, arguments, Type::Array { elem: elem.clone() })?;
            if method == "unshift" {
                return Ok(Expr::ArrayIntrinsic {
                    method: "unshiftFrom".into(),
                    receiver: Box::new(receiver),
                    args: vec![values],
                    r#type: Type::F64,
                    loc: self.loc(node),
                });
            }
            let extended = self.array_extend(node, receiver, values)?;
            return Ok(Expr::ArrayIntrinsic {
                method: "length".into(),
                receiver: Box::new(extended),
                args: vec![],
                r#type: Type::F64,
                loc: self.loc(node),
            });
        }
        let args = arguments
            .into_iter()
            .map(|arg| self.expected_expression(arg, (*elem).clone()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Expr::ArrayIntrinsic {
            method: method.into(),
            receiver: Box::new(receiver),
            args,
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }

    fn array_entries(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if !self.native_array_method_provenance(member.expression(), symbol, "entries") {
            return Err(self.refuse(member, "array.entries requires its standard declaration"));
        }
        if node.arguments().into_iter().next().is_some() {
            return Err(self.refuse(node, "array.entries does not accept arguments"));
        }
        let receiver = self.checked_array_receiver(member.expression())?;
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "array.entries requires a native array"));
        };
        let pair = self
            .intern_tuple(vec![Type::F64, (*elem).clone()])
            .ok_or_else(|| self.refuse(node, "array.entries element has no native tuple ABI"))?;
        Ok(Expr::ArrayIntrinsic {
            method: "entriesToArray".into(),
            receiver: Box::new(receiver),
            args: vec![],
            r#type: Type::Array {
                elem: Box::new(pair),
            },
            loc: self.loc(node),
        })
    }

    fn array_index_of(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        let standard = self.native_array_method_provenance(member.expression(), symbol, "indexOf");
        let source = node.arguments().into_iter().collect::<Vec<_>>();
        if source.is_empty()
            || source.len() > 2
            || source
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "array.indexOf requires a value and optional numeric start",
            ));
        }
        let receiver = self.checked_array_receiver(member.expression())?;
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "array.indexOf requires a native array"));
        };
        if !standard {
            let checked = self.checker.get_type_at_location(member.expression());
            if !self
                .checker
                .ty(checked)
                .flags
                .intersects(TypeFlags::ANY | TypeFlags::UNKNOWN)
            {
                return Err(self.refuse(member, "array.indexOf requires its standard declaration"));
            }
            // A checked-JS field can be `any` in the checker while its native
            // storage is a closed Array. Native arrays do not expose arbitrary
            // own named methods, so the represented receiver proves this is
            // the standard intrinsic rather than a user property.
        }
        if *elem == Type::Dyn {
            // A represented dynamic array can carry an own method property.
            // Fetch it before evaluating arguments and retain the live array
            // as `this`, including an arbitrary replacement return value.
            let receiver = self.coerce(receiver, Type::Dyn, member.expression())?;
            let mut args = vec![self.expected_expression(source[0], Type::Dyn)?];
            if let Some(start_node) = source.get(1) {
                let start = self.expected_expression(*start_node, Type::F64)?;
                args.push(self.coerce(start, Type::Dyn, *start_node)?);
            }
            return Ok(Expr::DynInvoke {
                recv: Box::new(receiver),
                method: "indexOf".into(),
                callee_name: "indexOf".into(),
                optional: false,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        let mut args = vec![self.expected_expression(source[0], (*elem).clone())?];
        if let Some(start) = source.get(1) {
            args.push(self.expected_expression(*start, Type::F64)?);
        }
        Ok(Expr::ArrayIntrinsic {
            method: "indexOf".into(),
            receiver: Box::new(receiver),
            args,
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }

    fn array_splice(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if !self.native_array_method_provenance(member.expression(), symbol, "splice") {
            return Err(self.refuse(member, "array.splice requires its standard declaration"));
        }
        let source = node.arguments().into_iter().collect::<Vec<_>>();
        if source
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "array.splice argument spreads are not ported"));
        }
        let receiver = self.checked_array_receiver(member.expression())?;
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "array.splice requires a native array"));
        };
        let number = |value: f64, loc: Loc| Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc,
        };
        let mut args = vec![
            if let Some(arg) = source.first() {
                self.expected_expression(*arg, Type::F64)?
            } else {
                number(0.0, self.loc(node))
            },
            if let Some(arg) = source.get(1) {
                self.expected_expression(*arg, Type::F64)?
            } else {
                number(f64::INFINITY, self.loc(node))
            },
        ];
        for arg in source.iter().skip(2) {
            args.push(self.expected_expression(*arg, (*elem).clone())?);
        }
        let ty = Type::Array { elem };
        Ok(Expr::ArrayIntrinsic {
            method: "splice".into(),
            receiver: Box::new(receiver),
            args,
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn array_concat_expected(
        &mut self,
        node: Node,
        expected: Option<Type>,
    ) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        let standard = self.native_array_method_provenance(member.expression(), symbol, "concat");
        let represented_receiver = if standard {
            false
        } else {
            self.planned_argument_type(member.expression())
                .is_some_and(|ty| self.array_view(&ty))
        };
        if !standard && !represented_receiver {
            return Err(self.refuse(member, "array.concat requires its standard declaration"));
        }
        let array_type = expected
            .or_else(|| self.array_concat_result_type(node))
            .unwrap_or(Type::Array {
                elem: Box::new(Type::Dyn),
            });
        let receiver = if member.expression().kind() == SyntaxKind::ArrayLiteralExpression {
            self.expected_expression(member.expression(), array_type.clone())?
        } else {
            self.checked_array_receiver(member.expression())?
        };
        let receiver = if receiver.ty() == Type::Dyn && standard {
            // Checked JavaScript may erase a recursive parameter after it is
            // also passed to an unknown callback. The canonical concat member
            // still proves Array dispatch; validate the live value once and
            // retain its shared storage behind the result element view.
            self.coerce(receiver, array_type.clone(), member.expression())?
        } else {
            receiver
        };
        let Type::Array { .. } = receiver.ty() else {
            return Err(self.refuse(node, "array.concat requires a non-null native array"));
        };
        let mut values = vec![receiver];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "array.concat argument spreads are not ported"));
            }
            let planned = self.ty(argument).ok();
            let union_of_arrays = matches!(planned, Some(Type::Union { union_id })
                if self.unions[union_id]
                    .arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Array { .. })))
                || (argument.kind() == SyntaxKind::ConditionalExpression
                    && matches!(self.ty(argument.when_true()), Ok(Type::Array { .. }))
                    && matches!(self.ty(argument.when_false()), Ok(Type::Array { .. })));
            let value = if union_of_arrays {
                // concat flattens either conditional array arm. Give both
                // branches the destination element ABI up front so an empty
                // literal's `never[]`/Dyn view cannot select the wrong tagged
                // branch or become one scalar element.
                self.expected_expression(argument, array_type.clone())?
            } else {
                self.expression(argument)?
            };
            values.push(value);
        }
        let Type::Array { elem } = &array_type else {
            unreachable!()
        };
        let elem = elem.as_ref().clone();
        let mut helper = Helper::new(
            "array_concat",
            values.iter().map(Expr::ty).collect(),
            array_type.clone(),
            self.loc(node),
        );
        let output = helper.local("result", array_type.clone(), false);
        helper.declare(
            &output,
            Expr::ArrayLit {
                elems: vec![],
                r#type: array_type.clone(),
                loc: helper.loc(),
            },
        );
        for index in 0..values.len() {
            let value = helper.read(&helper.param(index));
            let append = match value.ty() {
                Type::Array { .. } if value.ty() == array_type => Expr::ArrayIntrinsic {
                    method: "concatFrom".into(),
                    receiver: Box::new(helper.read(&output)),
                    args: vec![value],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                Type::Array { .. } => self.array_extend(node, helper.read(&output), value)?,
                _ => {
                    let value = self.coerce(value, elem.clone(), node)?;
                    Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&output)),
                        args: vec![value],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    }
                }
            };
            helper.function.body.push(Stmt::Expression {
                expr: append,
                loc: helper.loc(),
            });
        }
        let result = helper.read(&output);
        helper.function.body.push(Stmt::Return {
            value: Some(result),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: array_type,
            loc: self.loc(node),
        })
    }

    fn array_concat(&mut self, node: Node) -> Result<Expr, String> {
        self.array_concat_expected(node, None)
    }

    fn array_sort(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if !self.native_array_method_provenance(member.expression(), symbol, "sort") {
            return Err(self.refuse(member, "array.sort requires its standard declaration"));
        }
        let receiver = self.checked_array_receiver(member.expression())?;
        let ty = receiver.ty();
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !arguments.is_empty() {
            let Type::Array { elem } = &ty else {
                return Err(self.refuse(node, "array.sort requires a native array"));
            };
            if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(node, "array.sort requires one comparator"));
            }
            let callback_node = receivers::reference_node(arguments[0]);
            let callback = if matches!(
                callback_node.kind(),
                SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
            ) {
                if callback_node.parameters().len() > 2
                    || callback_node
                        .parameters()
                        .iter()
                        .any(|p| !p.dot_dot_dot_token().is_nil())
                {
                    return Err(self.refuse(
                        callback_node,
                        "array.sort comparator accepts at most two fixed parameters",
                    ));
                }
                let params = callback_node
                    .parameters()
                    .into_iter()
                    .map(|p| self.parameter_type(p, (**elem).clone()))
                    .collect::<Result<Vec<_>, _>>()?;
                self.closure(
                    callback_node,
                    Some(Type::Func {
                        rest: false,
                        params,
                        ret: Box::new(Type::Dyn),
                    }),
                )?
            } else {
                // A comparator commonly lives in an optional or erased
                // configuration field and is guarded with `typeof ... ===
                // 'function'` before sort. The call supplies its complete
                // native contract: two array elements and a numeric ordering
                // result. Request that checked callable view here instead of
                // losing it as a dynamic property value.
                self.expected_expression(
                    callback_node,
                    Type::Func {
                        rest: false,
                        params: vec![(**elem).clone(), (**elem).clone()],
                        ret: Box::new(Type::F64),
                    },
                )?
            };
            let Type::Func { params, ret, rest } = callback.ty() else {
                return Err(self.refuse(
                    callback_node,
                    "array.sort comparator requires a native function",
                ));
            };
            if rest
                || params.len() > 2
                || !self.numeric_operand_domain(&ret)
                || params.iter().any(|p| p != elem.as_ref())
            {
                return Err(self.refuse(
                    callback_node,
                    "array.sort comparator requires matching element parameters and a primitive result",
                ));
            }
            let value = self.coerce(receiver, Type::Dyn, node)?;
            let callback = self.coerce(callback, Type::Dyn, callback_node)?;
            let sorted = Expr::DynInvoke {
                recv: Box::new(value),
                method: "sort".into(),
                callee_name: "Array.sort".into(),
                optional: false,
                args: vec![callback],
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            return self.coerce(sorted, ty, node);
        }
        if !matches!(&ty, Type::Array { elem } if matches!(**elem, Type::String | Type::F64 | Type::Dyn))
        {
            return Err(self.refuse(node, "default array.sort requires a native primitive array"));
        }
        let value = self.coerce(receiver, Type::Dyn, node)?;
        let sorted = Expr::DynInvoke {
            recv: Box::new(value),
            method: "sort".into(),
            callee_name: "Array.sort".into(),
            optional: false,
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        self.coerce(sorted, ty, node)
    }

    fn array_pop(&mut self, node: Node) -> Result<Expr, String> {
        let source = node.expression().expression();
        let mut receiver = self.checked_array_receiver(source)?;
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "pop needs a non-null native array"));
        };
        let mut element_type = *elem;
        let erased_union = if let Type::Union { union_id } = element_type {
            let arms = &self.unions[union_id].arms;
            !self.optional_storage(&element_type)
                && arms
                    .iter()
                    .filter(|arm| matches!(arm, Type::Record { .. }))
                    .count()
                    <= 1
                && arms.iter().all(|arm| match arm {
                    Type::F64
                    | Type::String
                    | Type::Bool
                    | Type::Bigint
                    | Type::Symbol
                    | Type::Null => true,
                    Type::Record { shape_id } => {
                        let record = &self.records[*shape_id];
                        !record.tuple
                            && record.index_value.is_none()
                            && !self.callables.contains_key(shape_id)
                            && !self.enum_shape(*shape_id)
                    }
                    _ => false,
                })
        } else {
            false
        };
        if matches!(element_type, Type::Union { .. })
            && !self.optional_storage(&element_type)
            && !erased_union
        {
            // `pop()` itself establishes an erased owning result when a
            // heterogeneous element union has no reusable optional layout.
            // Keep the same array identity and validate only its Array brand.
            receiver = self.coerce(receiver, Type::Dyn, source)?;
            receiver = self.coerce(
                receiver,
                Type::Array {
                    elem: Box::new(Type::Dyn),
                },
                source,
            )?;
            element_type = Type::Dyn;
        }
        let result_type = self.undefined_storage_type(element_type.clone(), node)?;
        let local = self.construction_local(receiver.ty(), false);
        let mut stmts = vec![Stmt::VarDecl {
            local_id: local.id.clone(),
            init: receiver,
            loc: self.loc(source),
        }];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "pop argument spreads are not ported"));
            }
            stmts.push(Stmt::Expression {
                expr: self.expression(argument)?,
                loc: self.loc(argument),
            });
        }
        if element_type == Type::Dyn || erased_union {
            // Use the shared IR's dynamic indexed read and length mutation.
            // A single record arm keeps an unambiguous owning identity when
            // the result is converted back to its undefined-capable union.
            let mut helper = helpers::Helper::new(
                "array_pop_dynamic",
                vec![local.r#type.clone()],
                result_type.clone(),
                self.loc(node),
            );
            let array = helper.param(0);
            let length = helper.local("length", Type::F64, false);
            helper.declare(&length, helper.length(&array));
            let index = Expr::Bin {
                op: "-".into(),
                left: Box::new(helper.read(&length)),
                right: Box::new(helper.number(1.0)),
                r#type: Type::F64,
                loc: helper.loc(),
            };
            let dynamic = self.coerce(helper.read(&array), Type::Dyn, node)?;
            let key = Expr::ToString {
                operand: Box::new(index.clone()),
                r#type: Type::String,
                loc: helper.loc(),
            };
            let value = helper.local("popped", result_type.clone(), false);
            let missing = self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: helper.loc(),
                },
                result_type.clone(),
                node,
            )?;
            let popped = self.coerce(
                self.dynamic_get(node, dynamic, key),
                result_type.clone(),
                node,
            )?;
            helper.function.body.push(Stmt::If {
                cond: Expr::Bin {
                    op: ">".into(),
                    left: Box::new(helper.read(&length)),
                    right: Box::new(helper.number(0.0)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![
                    Stmt::VarDecl {
                        local_id: value.id.clone(),
                        init: popped,
                        loc: helper.loc(),
                    },
                    Stmt::ArraySetLength {
                        arr: helper.read(&array),
                        length: index,
                        loc: helper.loc(),
                    },
                    Stmt::Return {
                        value: Some(helper.read(&value)),
                        loc: helper.loc(),
                    },
                ],
                else_: None,
                loc: helper.loc(),
            });
            helper.function.body.push(Stmt::Return {
                value: Some(missing),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            return Ok(Expr::Sequence {
                stmts,
                result: Box::new(Expr::Call {
                    callee,
                    args: vec![self.construction_read(&local, source)],
                    r#type: result_type.clone(),
                    loc: self.loc(node),
                }),
                r#type: result_type,
                loc: self.loc(node),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::ArrayIntrinsic {
                method: "pop".into(),
                receiver: Box::new(self.construction_read(&local, source)),
                args: vec![],
                r#type: result_type.clone(),
                loc: self.loc(node),
            }),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    fn array_shift(&mut self, node: Node) -> Result<Expr, String> {
        let source = node.expression().expression();
        let receiver = self.checked_array_receiver(source)?;
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "shift needs a non-null native array"));
        };
        let element_type = *elem;
        let result_type = if element_type == Type::Dyn {
            Type::Dyn
        } else {
            self.undefined_storage_type(element_type, node)?
        };
        let local = self.construction_local(receiver.ty(), false);
        let mut stmts = vec![Stmt::VarDecl {
            local_id: local.id.clone(),
            init: receiver,
            loc: self.loc(source),
        }];
        // JavaScript ignores ordinary arguments to shift, but still evaluates
        // them from left to right before invoking the method.
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "shift argument spreads are not ported"));
            }
            stmts.push(Stmt::Expression {
                expr: self.expression(argument)?,
                loc: self.loc(argument),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::ArrayIntrinsic {
                method: "shift".into(),
                receiver: Box::new(self.construction_read(&local, source)),
                args: vec![],
                r#type: result_type.clone(),
                loc: self.loc(node),
            }),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn array_map(&mut self, node: Node, expected: Option<Type>) -> Result<Expr, String> {
        let receiver = self.checked_array_receiver(node.expression().expression())?;
        self.array_map_value(node, receiver, expected)
    }

    pub(super) fn array_map_value(
        &mut self,
        node: Node,
        receiver: Expr,
        expected: Option<Type>,
    ) -> Result<Expr, String> {
        let Type::Array { elem: source } = receiver.ty() else {
            return Err(self.refuse(node, "map receiver needs a native array"));
        };
        let output = if let Some(expected) = expected {
            expected
        } else {
            let checked = self.ty(node)?;
            if matches!(checked, Type::Array { .. }) {
                checked
            } else {
                let callback = node.arguments().get(0);
                let mut callback = callback;
                while callback.kind() == SyntaxKind::ParenthesizedExpression {
                    callback = callback.expression();
                }
                let body = callback.body();
                let result = if body.is_nil() {
                    // A named callback has no syntactic body at this call
                    // site, but its represented function ABI still carries
                    // the map element type. Prefer that return slot before
                    // falling back to inline callback-body inference.
                    self.ty(callback).ok().and_then(|ty| match ty {
                        Type::Func { ret, .. } => Some(*ret),
                        _ => None,
                    })
                } else if body.kind() == SyntaxKind::Block {
                    body.statements()
                        .into_iter()
                        .find(|statement| statement.kind() == SyntaxKind::ReturnStatement)
                        .filter(|statement| !statement.expression().is_nil())
                        .and_then(|statement| self.ty(statement.expression()).ok())
                } else {
                    self.ty(body).ok()
                };
                Type::Array {
                    elem: Box::new(result.ok_or_else(|| {
                        self.refuse(node, "array.map result needs a native element type")
                    })?),
                }
            }
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 {
            return Err(self.refuse(
                node,
                "array.map requires one callback; thisArg is not ported",
            ));
        }
        let mut callback_node = arguments[0];
        while callback_node.kind() == SyntaxKind::ParenthesizedExpression {
            callback_node = callback_node.expression();
        }
        let requested_output = output;
        let owns_asserted_value = matches!(
            callback_node.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) && self.asserted_map_get(callback_node.body());
        let output = if owns_asserted_value {
            Type::Array { elem: Box::new(Type::Dyn) }
        } else {
            requested_output.clone()
        };
        let Type::Array { elem: result } = &output else {
            return Err(self.refuse(node, "array.map result needs a native element type"));
        };
        let inputs = [(*source).clone(), Type::F64, receiver.ty()];
        let callback = if matches!(
            callback_node.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) {
            if callback_node
                .parameters()
                .iter()
                .any(|parameter| !parameter.dot_dot_dot_token().is_nil())
            {
                let ty = self.ty(callback_node)?;
                if !matches!(ty, Type::Func { rest: true, .. }) {
                    return Err(self.refuse(
                        callback_node,
                        "array.map tuple-rest callbacks are not ported",
                    ));
                }
                self.closure(callback_node, Some(ty))?
            } else {
                if callback_node.parameters().len() > 3 {
                    return Err(self.refuse(
                        callback_node,
                        "array.map callback accepts at most three native slots",
                    ));
                }
                let params = callback_node
                    .parameters()
                    .into_iter()
                    .zip(&inputs)
                    .map(|(node, ty)| self.parameter_type(node, ty.clone()))
                    .collect::<Result<Vec<_>, _>>()?;
                self.closure(
                    callback_node,
                    Some(Type::Func {
                        rest: false,
                        params,
                        ret: result.clone(),
                    }),
                )?
            }
        } else {
            self.expression(callback_node)?
        };
        let Type::Func { params, ret, rest } = callback.ty() else {
            return Err(self.refuse(callback_node, "array.map callback is not a native function"));
        };
        if params.len() > if rest { 4 } else { 3 } {
            return Err(self.refuse(
                callback_node,
                "array.map callback requires unsupported argument slots",
            ));
        }
        let mut helper = Helper::new(
            "array_map",
            vec![receiver.ty(), callback.ty()],
            output.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let callback_slot = helper.param(1);
        let length = helper.local("length", Type::F64, false);
        let mapped = helper.local("mapped", output.clone(), false);
        let index = helper.local("index", Type::F64, true);
        helper.declare(&length, helper.length(&array));
        helper.declare(
            &mapped,
            Expr::ArrayLit {
                elems: vec![],
                r#type: output.clone(),
                loc: helper.loc(),
            },
        );
        // map creates an output with the original length, including holes.
        // Later callback mutations affect which source indices are visited,
        // but do not alter that initial result length.
        helper.function.body.push(Stmt::ArraySetLength {
            arr: helper.read(&mapped),
            length: helper.read(&length),
            loc: helper.loc(),
        });
        helper.declare(&index, helper.number(0.0));
        let element = if *source == Type::Dyn {
            // A present undefined slot has no typed payload. Read through the
            // dynamic property contract so it is still passed to the callback.
            let array_value = self.coerce(helper.read(&array), Type::Dyn, node)?;
            let key = Expr::ToString {
                operand: Box::new(helper.read(&index)),
                r#type: Type::String,
                loc: helper.loc(),
            };
            self.dynamic_get(node, array_value, key)
        } else {
            helper.get(&array, &index, *source)
        };
        let provided = [element, helper.read(&index), helper.read(&array)];
        let args = params
            .iter()
            .enumerate()
            .map(|(index, target)| {
                if rest && index + 1 == params.len() {
                    let Type::Array { elem } = target else {
                        return Err(
                            self.refuse(callback_node, "array.map rest ABI requires an array slot")
                        );
                    };
                    let elems = provided
                        .iter()
                        .skip(index)
                        .cloned()
                        .map(|value| self.coerce(value, (**elem).clone(), callback_node))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(Expr::ArrayLit {
                        elems,
                        r#type: target.clone(),
                        loc: helper.loc(),
                    })
                } else {
                    self.coerce(provided[index].clone(), target.clone(), callback_node)
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        let call = Expr::CallValue {
            callee: Box::new(helper.read(&callback_slot)),
            args,
            r#type: *ret,
            loc: helper.loc(),
        };
        let value = self.coerce(call, (**result).clone(), callback_node)?;
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: vec![
                Stmt::Assign {
                    local_id: index.id.clone(),
                    value: Expr::ArrayIntrinsic {
                        method: "nextPresent".into(),
                        receiver: Box::new(helper.read(&array)),
                        args: vec![helper.read(&index)],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    },
                    initializes_global: false,
                    loc: helper.loc(),
                },
                Stmt::If {
                    cond: Expr::Logical {
                        op: "||".into(),
                        left: Box::new(Expr::Bin {
                            op: ">=".into(),
                            left: Box::new(helper.read(&index)),
                            right: Box::new(helper.read(&length)),
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        right: Box::new(Expr::Bin {
                            op: ">=".into(),
                            left: Box::new(helper.read(&index)),
                            right: Box::new(helper.length(&array)),
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Break {
                        target_depth: 0,
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                },
                Stmt::ArraySet {
                    arr: helper.read(&mapped),
                    index: helper.read(&index),
                    value,
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let name = self.install_helper(helper.finish(&mapped));
        let value = Expr::Call {
            callee: name,
            args: vec![receiver, callback],
            r#type: output,
            loc: self.loc(node),
        };
        self.coerce(value, requested_output, node)
    }

    /// Lower the typed, one-level array case of `Array.prototype.flatMap`.
    /// Both the source traversal and the returned-array traversal use the
    /// shared sparse-array cursor, matching JavaScript's omission of holes.
    pub(super) fn array_flat_map(&mut self, node: Node) -> Result<Expr, String> {
        let receiver = self.checked_array_receiver(node.expression().expression())?;
        self.array_flat_map_value(node, receiver)
    }

    pub(super) fn array_flat_map_value(
        &mut self,
        node: Node,
        receiver: Expr,
    ) -> Result<Expr, String> {
        let Type::Array { elem: source } = receiver.ty() else {
            return Err(self.refuse(node, "flatMap receiver needs a native array"));
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(
                node,
                "array.flatMap requires one callback; thisArg is not ported",
            ));
        }
        let mut callback_node = arguments[0];
        while callback_node.kind() == SyntaxKind::ParenthesizedExpression {
            callback_node = callback_node.expression();
        }
        let callback_type = self.ty(callback_node).ok();
        let checked_output = self.ty(node)?;
        if std::env::var_os("SCRIPTC_TRACE_ARRAYS").is_some() {
            let callback_body = callback_node.body();
            let callback_body_type = if callback_body.is_nil() {
                None
            } else {
                self.ty(callback_body).ok()
            };
            eprintln!(
                "scriptc: flatMap call output={checked_output:?} callback={:?} callbackBody={:?}",
                callback_type, callback_body_type,
            );
        }
        let output = match checked_output {
            output @ Type::Array { .. } => output,
            Type::Union { union_id } => {
                let arrays = self.unions[union_id]
                    .arms
                    .iter()
                    .filter(|arm| matches!(arm, Type::Array { .. }))
                    .cloned()
                    .collect::<Vec<_>>();
                if let [output] = arrays.as_slice()
                    && self.unions[union_id]
                        .arms
                        .iter()
                        .all(|arm| arm == output || matches!(arm, Type::Null | Type::Undefined))
                {
                    output.clone()
                } else {
                    return Err(
                        self.refuse(node, "array.flatMap result needs one native array arm")
                    );
                }
            }
            _ => match callback_type {
                Some(Type::Func { ret, .. }) if matches!(*ret, Type::Array { .. }) => *ret,
                _ => {
                    return Err(
                        self.refuse(node, "array.flatMap result needs a native element type")
                    );
                }
            },
        };
        let Type::Array { elem: result } = &output else {
            return Err(self.refuse(node, "array.flatMap result needs a native element type"));
        };
        let nested = Type::Array {
            elem: result.clone(),
        };
        let inputs = [(*source).clone(), Type::F64, receiver.ty()];
        let callback = if matches!(
            callback_node.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) {
            if callback_node.parameters().len() > 3
                || callback_node
                    .parameters()
                    .iter()
                    .any(|parameter| !parameter.dot_dot_dot_token().is_nil())
            {
                return Err(self.refuse(
                    callback_node,
                    "array.flatMap callback accepts at most three fixed native slots",
                ));
            }
            let params = callback_node
                .parameters()
                .into_iter()
                .zip(&inputs)
                .map(|(parameter, ty)| self.parameter_type(parameter, ty.clone()))
                .collect::<Result<Vec<_>, _>>()?;
            self.closure(
                callback_node,
                Some(Type::Func {
                    rest: false,
                    params,
                    ret: Box::new(nested.clone()),
                }),
            )?
        } else {
            self.expression(callback_node)?
        };
        let Type::Func { params, ret, rest } = callback.ty() else {
            return Err(self.refuse(
                callback_node,
                "array.flatMap callback is not a native function",
            ));
        };
        let dynamic_result = *ret == Type::Dyn;
        let mapped_element = match &*ret {
            Type::Array { elem } => (**elem).clone(),
            Type::Dyn => Type::Dyn,
            _ => {
                return Err(self.refuse(
                    callback_node,
                    "array.flatMap callback must return a native array or dynamic value",
                ));
            }
        };
        if rest || params.len() > 3 {
            return Err(self.refuse(
                callback_node,
                "array.flatMap callback must use at most three fixed native slots",
            ));
        }
        let mapped_type = (*ret).clone();

        let mut helper = Helper::new(
            "array_flat_map",
            vec![receiver.ty(), callback.ty()],
            output.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let callback_slot = helper.param(1);
        let length = helper.local("initial length", Type::F64, false);
        let flattened = helper.local("flattened", output.clone(), false);
        let index = helper.local("source index", Type::F64, true);
        let mapped_result = helper.local("mapped result", mapped_type.clone(), false);
        let mapped = if dynamic_result {
            helper.local(
                "mapped array",
                Type::Array {
                    elem: Box::new(Type::Dyn),
                },
                false,
            )
        } else {
            mapped_result.clone()
        };
        let mapped_length = helper.local("mapped length", Type::F64, false);
        let mapped_index = helper.local("mapped index", Type::F64, true);
        helper.declare(&length, helper.length(&array));
        helper.declare(
            &flattened,
            Expr::ArrayLit {
                elems: vec![],
                r#type: output.clone(),
                loc: helper.loc(),
            },
        );
        helper.declare(&index, helper.number(0.0));

        let provided = [
            helper.get(&array, &index, *source),
            helper.read(&index),
            helper.read(&array),
        ];
        let args = params
            .iter()
            .enumerate()
            .map(|(index, target)| {
                self.coerce(provided[index].clone(), target.clone(), callback_node)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let call = Expr::CallValue {
            callee: Box::new(helper.read(&callback_slot)),
            args,
            r#type: mapped_type,
            loc: helper.loc(),
        };
        let source_done = Expr::Logical {
            op: "||".into(),
            left: Box::new(Expr::Bin {
                op: ">=".into(),
                left: Box::new(helper.read(&index)),
                right: Box::new(helper.read(&length)),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            right: Box::new(Expr::Bin {
                op: ">=".into(),
                left: Box::new(helper.read(&index)),
                right: Box::new(helper.length(&array)),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let mapped_done = Expr::Logical {
            op: "||".into(),
            left: Box::new(Expr::Bin {
                op: ">=".into(),
                left: Box::new(helper.read(&mapped_index)),
                right: Box::new(helper.read(&mapped_length)),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            right: Box::new(Expr::Bin {
                op: ">=".into(),
                left: Box::new(helper.read(&mapped_index)),
                right: Box::new(helper.length(&mapped)),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let mapped_value = helper.get(&mapped, &mapped_index, mapped_element);
        let mapped_value = self.coerce(mapped_value, (**result).clone(), callback_node)?;
        let push = Expr::ArrayIntrinsic {
            method: "push".into(),
            receiver: Box::new(helper.read(&flattened)),
            args: vec![mapped_value],
            r#type: Type::F64,
            loc: helper.loc(),
        };
        let inner = Stmt::While {
            cond: helper.less(&mapped_index, helper.read(&mapped_length)),
            body: vec![
                Stmt::Assign {
                    local_id: mapped_index.id.clone(),
                    value: Expr::ArrayIntrinsic {
                        method: "nextPresent".into(),
                        receiver: Box::new(helper.read(&mapped)),
                        args: vec![helper.read(&mapped_index)],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    },
                    initializes_global: false,
                    loc: helper.loc(),
                },
                Stmt::If {
                    cond: mapped_done,
                    then: vec![Stmt::Break {
                        target_depth: 0,
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                },
                Stmt::Expression {
                    expr: push,
                    loc: helper.loc(),
                },
                helper.advance(&mapped_index),
            ],
            loc: helper.loc(),
        };
        let mut flatten = Vec::new();
        if dynamic_result {
            flatten.push(Stmt::VarDecl {
                local_id: mapped.id.clone(),
                init: Expr::DynCheck {
                    value: Box::new(helper.read(&mapped_result)),
                    r#type: mapped.r#type.clone(),
                    loc: helper.loc(),
                },
                loc: helper.loc(),
            });
        }
        flatten.extend([
            Stmt::VarDecl {
                local_id: mapped_length.id.clone(),
                init: helper.length(&mapped),
                loc: helper.loc(),
            },
            Stmt::VarDecl {
                local_id: mapped_index.id.clone(),
                init: helper.number(0.0),
                loc: helper.loc(),
            },
            inner,
        ]);
        let mut body = vec![
            Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::ArrayIntrinsic {
                    method: "nextPresent".into(),
                    receiver: Box::new(helper.read(&array)),
                    args: vec![helper.read(&index)],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                initializes_global: false,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: source_done,
                then: vec![Stmt::Break {
                    target_depth: 0,
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            },
            Stmt::VarDecl {
                local_id: mapped_result.id.clone(),
                init: call,
                loc: helper.loc(),
            },
        ];
        if dynamic_result {
            let scalar = self.coerce(
                helper.read(&mapped_result),
                (**result).clone(),
                callback_node,
            )?;
            body.push(Stmt::If {
                cond: Expr::DynTest {
                    value: Box::new(helper.read(&mapped_result)),
                    test: "array".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: flatten,
                else_: Some(vec![Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&flattened)),
                        args: vec![scalar],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    },
                    loc: helper.loc(),
                }]),
                loc: helper.loc(),
            });
        } else {
            body.extend(flatten);
        }
        body.push(helper.advance(&index));
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body,
            loc: helper.loc(),
        });
        let name = self.install_helper(helper.finish(&flattened));
        Ok(Expr::Call {
            callee: name,
            args: vec![receiver, callback],
            r#type: output,
            loc: self.loc(node),
        })
    }

    /// `flat()` with its default depth removes one array layer and skips holes
    /// in both the source and nested arrays. Erased elements are tested at
    /// runtime because JavaScript preserves non-array values unchanged.
    fn array_flat(&mut self, node: Node) -> Result<Expr, String> {
        if node.arguments().into_iter().next().is_some() {
            return Err(self.refuse(node, "array.flat currently supports the default depth only"));
        }
        let receiver = self.checked_array_receiver(node.expression().expression())?;
        let Type::Array { elem: source } = receiver.ty() else {
            return Err(self.refuse(node, "flat receiver needs a native array"));
        };
        let result = match &*source {
            Type::Array { elem } => (**elem).clone(),
            Type::Dyn => Type::Dyn,
            other => other.clone(),
        };
        let output = Type::Array {
            elem: Box::new(result.clone()),
        };
        let mut helper = Helper::new(
            "array_flat",
            vec![receiver.ty()],
            output.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let flattened = helper.local("flattened", output.clone(), false);
        let length = helper.local("initial length", Type::F64, false);
        let index = helper.local("source index", Type::F64, true);
        helper.declare(
            &flattened,
            Expr::ArrayLit {
                elems: vec![],
                r#type: output.clone(),
                loc: helper.loc(),
            },
        );
        helper.declare(&length, helper.length(&array));
        helper.declare(&index, helper.number(0.0));

        let source_done = Expr::Logical {
            op: "||".into(),
            left: Box::new(Expr::Bin {
                op: ">=".into(),
                left: Box::new(helper.read(&index)),
                right: Box::new(helper.read(&length)),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            right: Box::new(Expr::Bin {
                op: ">=".into(),
                left: Box::new(helper.read(&index)),
                right: Box::new(helper.length(&array)),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let item = helper.local("source item", (*source).clone(), false);
        let push_item = |value: Expr, helper: &Helper| Stmt::Expression {
            expr: Expr::ArrayIntrinsic {
                method: "push".into(),
                receiver: Box::new(helper.read(&flattened)),
                args: vec![value],
                r#type: Type::F64,
                loc: helper.loc(),
            },
            loc: helper.loc(),
        };
        let mut body = vec![
            Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::ArrayIntrinsic {
                    method: "nextPresent".into(),
                    receiver: Box::new(helper.read(&array)),
                    args: vec![helper.read(&index)],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                initializes_global: false,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: source_done,
                then: vec![Stmt::Break {
                    target_depth: 0,
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            },
            Stmt::VarDecl {
                local_id: item.id.clone(),
                init: helper.get(&array, &index, (*source).clone()),
                loc: helper.loc(),
            },
        ];

        let nested_type = match &*source {
            Type::Array { .. } => Some((*source).clone()),
            Type::Dyn => Some(Type::Array {
                elem: Box::new(Type::Dyn),
            }),
            _ => None,
        };
        if let Some(nested_type) = nested_type {
            let Type::Array { elem: nested_elem } = &nested_type else {
                unreachable!()
            };
            let nested = helper.local("nested array", nested_type.clone(), false);
            let nested_length = helper.local("nested length", Type::F64, false);
            let nested_index = helper.local("nested index", Type::F64, true);
            let nested_done = Expr::Logical {
                op: "||".into(),
                left: Box::new(Expr::Bin {
                    op: ">=".into(),
                    left: Box::new(helper.read(&nested_index)),
                    right: Box::new(helper.read(&nested_length)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                right: Box::new(Expr::Bin {
                    op: ">=".into(),
                    left: Box::new(helper.read(&nested_index)),
                    right: Box::new(helper.length(&nested)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                r#type: Type::Bool,
                loc: helper.loc(),
            };
            let inner = Stmt::While {
                cond: helper.less(&nested_index, helper.read(&nested_length)),
                body: vec![
                    Stmt::Assign {
                        local_id: nested_index.id.clone(),
                        value: Expr::ArrayIntrinsic {
                            method: "nextPresent".into(),
                            receiver: Box::new(helper.read(&nested)),
                            args: vec![helper.read(&nested_index)],
                            r#type: Type::F64,
                            loc: helper.loc(),
                        },
                        initializes_global: false,
                        loc: helper.loc(),
                    },
                    Stmt::If {
                        cond: nested_done,
                        then: vec![Stmt::Break {
                            target_depth: 0,
                            loc: helper.loc(),
                        }],
                        else_: None,
                        loc: helper.loc(),
                    },
                    push_item(
                        helper.get(&nested, &nested_index, (**nested_elem).clone()),
                        &helper,
                    ),
                    helper.advance(&nested_index),
                ],
                loc: helper.loc(),
            };
            let nested_value = if *source == Type::Dyn {
                Expr::DynCheck {
                    value: Box::new(helper.read(&item)),
                    r#type: nested_type.clone(),
                    loc: helper.loc(),
                }
            } else {
                helper.read(&item)
            };
            let flatten = vec![
                Stmt::VarDecl {
                    local_id: nested.id.clone(),
                    init: nested_value,
                    loc: helper.loc(),
                },
                Stmt::VarDecl {
                    local_id: nested_length.id.clone(),
                    init: helper.length(&nested),
                    loc: helper.loc(),
                },
                Stmt::VarDecl {
                    local_id: nested_index.id.clone(),
                    init: helper.number(0.0),
                    loc: helper.loc(),
                },
                inner,
            ];
            if *source == Type::Dyn {
                body.push(Stmt::If {
                    cond: Expr::DynTest {
                        value: Box::new(helper.read(&item)),
                        test: "array".into(),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: flatten,
                    else_: Some(vec![push_item(helper.read(&item), &helper)]),
                    loc: helper.loc(),
                });
            } else {
                body.extend(flatten);
            }
        } else {
            body.push(push_item(helper.read(&item), &helper));
        }
        body.push(helper.advance(&index));
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body,
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&flattened));
        Ok(Expr::Call {
            callee,
            args: vec![receiver],
            r#type: output,
            loc: self.loc(node),
        })
    }

    pub(super) fn map_from_array(
        &mut self,
        node: Node,
        entries: Expr,
        ty: Type,
    ) -> Result<Expr, String> {
        let Type::Map { key, value } = &ty else {
            unreachable!()
        };
        let Type::Array { elem } = entries.ty() else {
            return Err(self.refuse(node, "Map seed must be a native array of entry tuples"));
        };
        let Type::Record { shape_id } = *elem else {
            return Err(self.refuse(node, "Map entries need native tuple layouts"));
        };
        let record = &self.records[shape_id];
        if !record.tuple || record.fields.len() != 2 {
            return Err(self.refuse(node, "Map entry tuple must contain exactly two positions"));
        }
        let key_type = record.fields[0].r#type.clone();
        let value_type = record.fields[1].r#type.clone();
        let mut helper = Helper::new(
            "map_entries",
            vec![entries.ty()],
            ty.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let map = helper.local("map", ty.clone(), false);
        let index = helper.local("index", Type::F64, true);
        let pair = helper.local("entry", *elem, false);
        helper.declare(
            &map,
            Expr::MapNew {
                seed: vec![],
                r#type: ty.clone(),
                loc: helper.loc(),
            },
        );
        helper.declare(&index, helper.number(0.0));
        let read = |position: &str, ty: Type| Expr::RecordGet {
            obj: Box::new(helper.read(&pair)),
            shape_id: format!("r{shape_id}"),
            field: position.into(),
            r#type: ty,
            loc: helper.loc(),
        };
        let key = self.coerce(read("0", key_type), (**key).clone(), node)?;
        let value = self.coerce(read("1", value_type), (**value).clone(), node)?;
        let set = Expr::MapIntrinsic {
            method: "set".into(),
            receiver: Box::new(helper.read(&map)),
            args: vec![key, value],
            r#type: Type::Void,
            loc: helper.loc(),
        };
        let body = vec![
            Stmt::VarDecl {
                local_id: pair.id.clone(),
                init: helper.get(&array, &index, pair.r#type.clone()),
                loc: helper.loc(),
            },
            Stmt::Expression {
                expr: set,
                loc: helper.loc(),
            },
            helper.advance(&index),
        ];
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.length(&array)),
            body,
            loc: helper.loc(),
        });
        let name = self.install_helper(helper.finish(&map));
        Ok(Expr::Call {
            callee: name,
            args: vec![entries],
            r#type: ty,
            loc: self.loc(node),
        })
    }
}
