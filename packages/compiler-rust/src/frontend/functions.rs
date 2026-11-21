//! Function inventory and demand worklist. Unused declarations need no native ABI.
use super::*;
use std::collections::VecDeque;

#[derive(Clone)]
pub(super) struct Definition {
    pub nodes: Vec<Node>,
    pub file: String,
    pub name: String,
    pub ordinal: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum UseKind {
    Call,
    Value,
}

#[derive(Clone)]
struct Demand {
    caller: Option<u32>,
    target: u32,
    site: Loc,
    kind: UseKind,
}

#[derive(Clone)]
enum State {
    Discovered,
    Queued(Signature),
    Lowering(Signature),
    Lowered(Signature),
}

#[derive(Clone, Default)]
pub(super) struct FunctionGraph {
    definitions: HashMap<u32, Definition>,
    states: HashMap<u32, State>,
    pending: VecDeque<u32>,
    edges: Vec<Demand>,
    seen_edges: HashSet<(Option<u32>, u32, UseKind)>,
    current: Option<u32>,
}

impl FunctionGraph {
    pub(super) fn source_node(&self, symbol: u32) -> Option<Node> {
        let nodes = &self.definitions.get(&symbol)?.nodes;
        (nodes.len() == 1).then(|| nodes[0])
    }
    pub(super) fn declare(&mut self, symbol: u32, node: Node, file: String, name: String) {
        let ordinal = self.definitions.len();
        self.definitions
            .entry(symbol)
            .and_modify(|d| d.nodes.push(node))
            .or_insert(Definition {
                nodes: vec![node],
                file,
                name,
                ordinal,
            });
        self.states.entry(symbol).or_insert(State::Discovered);
    }

    pub(super) fn contains(&self, symbol: u32) -> bool {
        self.definitions.contains_key(&symbol)
    }

    pub(super) fn demand(&mut self, symbol: u32, site: Loc, kind: UseKind) -> Option<Definition> {
        let definition = self.definitions.get(&symbol)?;
        if self.seen_edges.insert((self.current, symbol, kind)) {
            self.edges.push(Demand {
                caller: self.current,
                target: symbol,
                site,
                kind,
            });
        }
        Some(definition.clone())
    }

    pub(super) fn signature(&self, symbol: u32) -> Option<&Signature> {
        match self.states.get(&symbol)? {
            State::Discovered => None,
            State::Queued(s) | State::Lowering(s) | State::Lowered(s) => Some(s),
        }
    }

    pub(super) fn enqueue(&mut self, symbol: u32, signature: Signature) {
        assert!(matches!(self.states.get(&symbol), Some(State::Discovered)));
        self.states.insert(symbol, State::Queued(signature));
        self.pending.push_back(symbol);
    }

    pub(super) fn replace_queued(&mut self, symbol: u32, signature: Signature) -> bool {
        let Some(state @ State::Queued(_)) = self.states.get_mut(&symbol) else {
            return false;
        };
        *state = State::Queued(signature);
        true
    }

    pub(super) fn next(&mut self) -> Option<(u32, Signature)> {
        assert!(self.current.is_none());
        let symbol = self.pending.pop_front()?;
        let Some(State::Queued(signature)) = self.states.get(&symbol) else {
            unreachable!("queued native function")
        };
        let signature = signature.clone();
        self.states
            .insert(symbol, State::Lowering(signature.clone()));
        self.current = Some(symbol);
        Some((symbol, signature))
    }

    pub(super) fn finish(&mut self, symbol: u32) {
        assert_eq!(self.current, Some(symbol));
        let Some(State::Lowering(signature)) = self.states.get(&symbol) else {
            unreachable!("lowering native function")
        };
        self.states
            .insert(symbol, State::Lowered(signature.clone()));
        self.current = None;
    }

    pub(super) fn explain(&self, target: u32, error: String) -> String {
        if error.contains("\nnative reachability:") {
            return error;
        }
        let mut trace = Vec::new();
        let mut visited = HashSet::new();
        let mut target = Some(target);
        while let Some(symbol) = target.filter(|s| visited.insert(*s)) {
            let Some(edge) = self.edges.iter().find(|e| e.target == symbol) else {
                break;
            };
            let definition = &self.definitions[&symbol];
            trace.push(format!(
                "{} '{}' at {}:{}..{}",
                if edge.kind == UseKind::Call {
                    "call"
                } else {
                    "function value"
                },
                definition.name,
                edge.site.file,
                edge.site.start,
                edge.site.end
            ));
            target = edge.caller;
        }
        trace.reverse();
        format!(
            "{error}\nnative reachability: entry initialization -> {}",
            trace.join(" -> ")
        )
    }
}

impl Lowerer<'_> {
    pub(super) fn contextual_type_description(&self, ty: &Type) -> String {
        fn describe(
            ty: &Type,
            records: &[ir::Record],
            unions: &[ir::Union],
            depth: usize,
        ) -> String {
            if depth == 0 {
                return format!("{ty:?}");
            }
            match ty {
                Type::Record { shape_id } => records.get(*shape_id).map_or_else(
                    || format!("record r{shape_id}"),
                    |record| {
                        let fields = record
                            .fields
                            .iter()
                            .take(12)
                            .map(|field| {
                                format!(
                                    "{}: {}",
                                    field.name,
                                    describe(&field.r#type, records, unions, depth - 1)
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!(
                            "record r{shape_id} {{{fields}{}}}",
                            if record.fields.len() > 12 {
                                ", ..."
                            } else {
                                ""
                            }
                        )
                    },
                ),
                Type::Union { union_id } => unions.get(*union_id).map_or_else(
                    || format!("union u{union_id}"),
                    |union| {
                        union
                            .arms
                            .iter()
                            .map(|arm| describe(arm, records, unions, depth - 1))
                            .collect::<Vec<_>>()
                            .join(" | ")
                    },
                ),
                Type::Array { elem } => {
                    format!("Array<{}>", describe(elem, records, unions, depth - 1))
                }
                Type::Promise { inner } => {
                    format!("Promise<{}>", describe(inner, records, unions, depth - 1))
                }
                _ => format!("{ty:?}"),
            }
        }
        describe(ty, &self.records, &self.unions, 4)
    }

    pub(super) fn contextual_result_compatible(&self, source: &Type, target: &Type) -> bool {
        // A JavaScript function whose first native demand erased its result can
        // still serve a later typed consumer. The call site owns the Dyn check;
        // recompiling the same function with a second return ABI would split
        // function identity and is both unnecessary and incorrect.
        if let (
            Type::Generator {
                r#async: source_async,
                yield_type: source_yield,
                return_type: source_return,
                next_type: source_next,
            },
            Type::Generator {
                r#async: target_async,
                yield_type: target_yield,
                return_type: target_return,
                next_type: target_next,
            },
        ) = (source, target)
        {
            // A contextual Iterable/Generator annotation refines the channels
            // of the same stateful JS generator implementation. Yields and the
            // terminal value are covariant; values sent through next() are
            // contravariant. Dyn remains the single erased boundary, and a
            // bare JS `return` is the undefined value accepted by Dyn.
            return source_async == target_async
                && self.contextual_result_compatible(source_yield, target_yield)
                && (matches!(**source_return, Type::Void | Type::Undefined)
                    && **target_return == Type::Dyn
                    || self.contextual_result_compatible(source_return, target_return))
                && self.contextual_result_compatible(target_next, source_next);
        }
        if let (Type::Promise { inner: source }, Type::Promise { inner: target }) = (source, target)
        {
            // Promise ABIs share the same identity-bearing native handle. The
            // consumer checks the fulfilled NativeValue when it awaits the
            // promise, so an earlier Promise<Dyn> demand must not force a
            // second compilation (or split function identity) for a later
            // Promise<T> view.
            return self.contextual_result_compatible(source, target);
        }
        if !matches!(source, Type::Union { .. })
            && let Type::Union { union_id } = target
        {
            // Return values are covariant. A function compiled with a closed
            // result can serve a consumer whose callable view widens that
            // result with nullish (or another represented) alternatives. The
            // call boundary owns the union wrapping; compiling the function a
            // second time would split its JavaScript identity.
            return self.unions[*union_id]
                .arms
                .iter()
                .any(|arm| self.contextual_result_compatible(source, arm));
        }
        if *source == Type::Dyn
            || (*target == Type::Dyn && self.dynamic_erasure_reason(source).is_none())
            || source == target
            || ir::callable_view_compatible(source, target)
            || self.structural_callable_view_compatible(source, target)
            || matches!(source, Type::Record { shape_id } if self.callables.get(shape_id).is_some_and(|callable| callable == target || ir::callable_view_compatible(callable, target)))
            || ir::record_equivalence::equivalent(source, target, &self.records, &self.unions)
            || ir::record_views::view_pairs(source, target, &self.records, &self.unions).is_some()
            || ir::record_views::dynamic_view_pairs(source, target, &self.records, &self.unions)
                .is_some()
        {
            return true;
        }
        let (Type::Union { union_id: source }, Type::Union { union_id: target }) = (source, target)
        else {
            return false;
        };
        self.unions[*source].arms.iter().all(|arm| {
            matches!(
                arm,
                Type::F64
                    | Type::Bigint
                    | Type::String
                    | Type::Bool
                    | Type::Null
                    | Type::Undefined
                    | Type::Symbol
            ) && self.unions[*target].arms.contains(arm)
        })
    }

    pub(super) fn inventory(&mut self, files: &[Node]) {
        for file in files {
            let path = source_file_info(*file).file_name.to_string();
            for node in file.statements() {
                if node.kind() != SyntaxKind::FunctionDeclaration {
                    continue;
                }
                let symbol = if node.name().is_nil() {
                    node.symbol().0
                } else {
                    self.symbol(node.name())
                };
                if symbol != 0 {
                    let name = if node.name().is_nil() {
                        "default"
                    } else {
                        node.name().text()
                    };
                    self.functions
                        .declare(symbol, node, path.clone(), name.into());
                }
            }
        }
    }

    pub(super) fn request_function(
        &mut self,
        symbol: u32,
        site: Node,
        kind: UseKind,
    ) -> Result<Option<Signature>, String> {
        self.request_function_context(symbol, site, kind, None, None)
    }

    pub(super) fn request_function_context(
        &mut self,
        symbol: u32,
        site: Node,
        kind: UseKind,
        abi: Option<Type>,
        result: Option<Type>,
    ) -> Result<Option<Signature>, String> {
        let Some(definition) = self.functions.demand(symbol, self.loc(site), kind) else {
            return Ok(None);
        };
        if let Some(signature) = self.functions.signature(symbol) {
            let actual = Type::Func {
                rest: signature.rest,
                params: signature.params.iter().map(|p| p.r#type.clone()).collect(),
                ret: Box::new(signature.return_type.clone()),
            };
            if let Some(expected) = abi.as_ref().filter(|expected| {
                **expected != actual
                    && !ir::callable_view_compatible(&actual, expected)
                    && !self.structural_callable_view_compatible(&actual, expected)
            }) {
                return Err(self.refuse(
                    site,
                    &format!("function demanded with incompatible native contracts: existing {actual:?}, requested {expected:?}"),
                ));
            }
            if let Some(expected) = result.as_ref().filter(|expected| {
                !self.contextual_result_compatible(&signature.return_type, expected)
            }) {
                let existing = self.contextual_type_description(&signature.return_type);
                let requested = self.contextual_type_description(expected);
                return Err(self.refuse(
                    site,
                    &format!("function demanded with incompatible native contracts: existing result {existing}, requested result {requested}"),
                ));
            }
            return Ok(Some(signature.clone()));
        }
        // TypeScript overloads are body-less call views of one
        // implementation. The implementation signature is the native ABI;
        // each call site still converts its result to the checked overload.
        let implementations = definition
            .nodes
            .iter()
            .copied()
            .filter(|node| !node.body().is_nil())
            .collect::<Vec<_>>();
        let implementation = match (definition.nodes.as_slice(), implementations.as_slice()) {
            ([only], _) => *only,
            (_, [implementation])
                if definition.nodes.iter().all(|node| {
                    node.kind() == SyntaxKind::FunctionDeclaration
                        && get_source_file_of_node(*node) == get_source_file_of_node(*implementation)
                }) =>
            {
                *implementation
            }
            _ => {
                return Err(self.functions.explain(
                    symbol,
                    refusal(
                        &definition.file,
                        definition.nodes[0],
                        "function overloads are not ported",
                    ),
                ));
            }
        };
        let file = std::mem::replace(&mut self.file, definition.file);
        let signature = self.function_signature(implementation, definition.ordinal);
        self.file = file;
        let mut signature = signature.map_err(|error| self.functions.explain(symbol, error))?;
        let contextual = (signature.file.ends_with(".js") || signature.file.ends_with(".mjs"))
            && self.declared(signature.node).is_none();
        if contextual {
            let (slots, ret) = if let Some(Type::Func { params, ret, rest }) = abi {
                if rest != signature.rest {
                    return Err(self.refuse(
                        site,
                        "JavaScript function rest ABI conflicts with contextual native ABI",
                    ));
                }
                (Some(params), Some(*ret))
            } else {
                (None, result)
            };
            if let Some(slots) = slots {
                if slots.len() < signature.params.len()
                    || (signature.rest && slots.len() != signature.params.len())
                {
                    return Err(self.refuse(
                        site,
                        &format!(
                            "JavaScript function arity conflicts with contextual native ABI: inferred {}, requested {}",
                            signature.params.len(),
                            slots.len()
                        ),
                    ));
                }
                if let Some((index, (param, requested))) =
                    signature.params.iter().zip(&slots).enumerate().find(
                        |(_, (param, requested))| {
                            param.r#type != Type::Dyn
                                && **requested != Type::Dyn
                                && param.r#type != **requested
                                && !matches!(
                                    (&param.r#type, *requested),
                                    (Type::Record { .. }, Type::Generator { r#async: false, .. })
                                )
                        },
                    )
                {
                    return Err(self.refuse(
                        site,
                        &format!(
                            "JavaScript function parameter {} conflicts with contextual native ABI: inferred {:?}, requested {:?}",
                            index + 1,
                            param.r#type,
                            requested
                        ),
                    ));
                }
                for (param, ty) in signature.params.iter_mut().zip(slots) {
                    param.r#type = ty;
                }
            }
            if let Some(ret) = ret {
                let returns_absence = self.function_may_return_absent(signature.node)
                    || self.function_absence_kinds(signature.node).0;
                let ret = if returns_absence && signature.return_type == Type::Dyn {
                    Type::Dyn
                } else if let Type::Union { union_id } = &ret {
                    let arms = &self.unions[*union_id].arms;
                    let compatible = arms
                        .iter()
                        .filter(|arm| {
                            !matches!(arm, Type::Null | Type::Undefined)
                                && self.contextual_result_compatible(&signature.return_type, arm)
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if !returns_absence
                        && compatible.len() == 1
                        && arms.iter().all(|arm| {
                            matches!(arm, Type::Null | Type::Undefined) || *arm == compatible[0]
                        })
                    {
                        compatible[0].clone()
                    } else {
                        ret
                    }
                } else {
                    ret
                };
                let ret = if returns_absence
                    && ret != Type::Dyn
                    && matches!(&signature.return_type, Type::Union { union_id } if {
                        let arms = &self.unions[*union_id].arms;
                        arms.iter().any(|arm| matches!(arm, Type::Null | Type::Undefined))
                            && arms.iter().any(|arm| {
                                !matches!(arm, Type::Null | Type::Undefined)
                                    && (arm == &ret
                                        || self.contextual_result_compatible(arm, &ret))
                            })
                    }) {
                    // A contextual consumer can immediately narrow a
                    // nullable result, but it cannot change what the source
                    // function returns. Keep the owning nullable ABI and let
                    // the call-site projection select its present arm.
                    signature.return_type.clone()
                } else {
                    ret
                };
                // Ordinary async functions return a Promise; async generator
                // functions return the generator immediately. Contextual
                // erasure cannot change either JavaScript call convention.
                let optional_generator_view = signature.generator.is_some()
                    && matches!(&ret, Type::Union { union_id }
                        if self.unions[*union_id].arms.iter().filter(|arm|
                            self.contextual_result_compatible(&signature.return_type, arm)
                        ).count() == 1
                        && self.unions[*union_id].arms.iter().all(|arm|
                            matches!(arm, Type::Null | Type::Undefined)
                            || self.contextual_result_compatible(&signature.return_type, arm)));
                let ret = if signature.generator.is_some()
                    && (ret == Type::Dyn || optional_generator_view)
                {
                    signature.return_type.clone()
                } else if signature.is_async
                    && signature.generator.is_none()
                    && !matches!(ret, Type::Promise { .. })
                {
                    Type::Promise {
                        inner: Box::new(ret),
                    }
                } else {
                    ret
                };
                let callable_view = matches!((&signature.return_type, &ret), (Type::Func { .. }, Type::Record { shape_id }) if self.callables.contains_key(shape_id));
                let contextual_function = match (&signature.return_type, &ret) {
                    (
                        Type::Func {
                            params: source,
                            ret: source_ret,
                            rest: source_rest,
                        },
                        Type::Func {
                            params: target,
                            ret: target_ret,
                            rest: target_rest,
                        },
                    ) => {
                        source_rest == target_rest
                            && source.len() == target.len()
                            && source
                                .iter()
                                .zip(target)
                                .all(|(a, b)| *a == Type::Dyn || a == b)
                            && (**source_ret == Type::Dyn || source_ret == target_ret)
                    }
                    _ => false,
                };
                if signature.return_type != Type::Dyn
                    && ret != Type::Dyn
                    && signature.return_type != ret
                    && !self.contextual_result_compatible(&signature.return_type, &ret)
                    && !callable_view
                    && !contextual_function
                {
                    return Err(self.refuse(
                        site,
                        &format!(
                            "JavaScript function result conflicts with contextual native ABI: {} -> {}",
                            self.contextual_type_description(&signature.return_type),
                            self.contextual_type_description(&ret)
                        ),
                    ));
                }
                signature.return_type = ret;
                if let (
                    Some(channels),
                    Type::Generator {
                        yield_type,
                        next_type,
                        ..
                    },
                ) = (&mut signature.generator, &signature.return_type)
                {
                    // The public call result and the continuation channels are
                    // one ABI. Contextualizing only the former creates an IR
                    // call whose Rust type disagrees with the generated
                    // function, even though both describe the same generator.
                    channels.yield_type = (**yield_type).clone();
                    channels.next_type = (**next_type).clone();
                }
            }
        }
        self.functions.enqueue(symbol, signature.clone());
        Ok(Some(signature))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site() -> Loc {
        Loc {
            file: "entry.ts".into(),
            start: 1,
            end: 2,
        }
    }
    fn signature(name: &str) -> Signature {
        Signature {
            is_async: false,
            generator: None,
            rest: false,
            node: Node::NIL,
            file: "functions.ts".into(),
            name: name.into(),
            params: vec![],
            return_type: Type::Void,
        }
    }

    #[test]
    fn discovery_does_not_require_a_signature_or_schedule_code() {
        let mut graph = FunctionGraph::default();
        graph.declare(7, Node::NIL, "functions.ts".into(), "unused".into());
        assert!(graph.next().is_none());
        assert!(graph.signature(7).is_none());
        assert_eq!(graph.definitions[&7].ordinal, 0);
    }

    #[test]
    fn recursion_and_new_dependencies_reach_a_deterministic_fixed_point() {
        let mut graph = FunctionGraph::default();
        graph.declare(7, Node::NIL, "functions.ts".into(), "first".into());
        graph.declare(8, Node::NIL, "functions.ts".into(), "second".into());
        graph.demand(7, site(), UseKind::Call).unwrap();
        graph.enqueue(7, signature("f0"));
        assert_eq!(graph.next().unwrap().0, 7);
        graph.demand(7, site(), UseKind::Call).unwrap();
        assert!(graph.signature(7).is_some());
        graph.demand(8, site(), UseKind::Value).unwrap();
        graph.enqueue(8, signature("f1"));
        graph.finish(7);
        assert_eq!(graph.next().unwrap().0, 8);
        graph.demand(7, site(), UseKind::Call).unwrap();
        assert!(graph.signature(7).is_some());
        graph.finish(8);
        assert!(graph.next().is_none());
        assert!(matches!(graph.states[&7], State::Lowered(_)));
        assert!(matches!(graph.states[&8], State::Lowered(_)));
    }

    #[test]
    fn failures_retain_the_first_demand_chain_without_duplicate_traces() {
        let mut graph = FunctionGraph::default();
        graph.declare(7, Node::NIL, "functions.ts".into(), "first".into());
        graph.declare(8, Node::NIL, "functions.ts".into(), "unsupported".into());
        graph.demand(7, site(), UseKind::Call).unwrap();
        graph.enqueue(7, signature("f0"));
        graph.next().unwrap();
        graph.demand(8, site(), UseKind::Value).unwrap();
        graph.demand(8, site(), UseKind::Value).unwrap();
        assert_eq!(graph.edges.len(), 2);
        let error = graph.explain(8, "SCN1001: unsupported".into());
        assert!(error.contains("entry initialization -> call 'first'"));
        assert!(error.contains("function value 'unsupported'"));
        assert_eq!(graph.explain(7, error.clone()), error);
    }
}
