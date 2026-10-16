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

struct Demand {
    caller: Option<u32>,
    target: u32,
    site: Loc,
    kind: UseKind,
}

enum State {
    Discovered,
    Queued(Signature),
    Lowering(Signature),
    Lowered(Signature),
}

#[derive(Default)]
pub(super) struct FunctionGraph {
    definitions: HashMap<u32, Definition>,
    states: HashMap<u32, State>,
    pending: VecDeque<u32>,
    edges: Vec<Demand>,
    seen_edges: HashSet<(Option<u32>, u32, UseKind)>,
    current: Option<u32>,
}

impl FunctionGraph {
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
                params: signature.params.iter().map(|p| p.r#type.clone()).collect(),
                ret: Box::new(signature.return_type.clone()),
            };
            if abi.as_ref().is_some_and(|expected| *expected != actual)
                || result
                    .as_ref()
                    .is_some_and(|expected| *expected != signature.return_type)
            {
                return Err(
                    self.refuse(site, "function demanded with incompatible native contracts")
                );
            }
            return Ok(Some(signature.clone()));
        }
        if definition.nodes.len() != 1 {
            return Err(self.functions.explain(
                symbol,
                refusal(
                    &definition.file,
                    definition.nodes[0],
                    "function overloads are not ported",
                ),
            ));
        }
        let file = std::mem::replace(&mut self.file, definition.file);
        let signature = self.function_signature(definition.nodes[0], definition.ordinal);
        self.file = file;
        let mut signature = signature.map_err(|error| self.functions.explain(symbol, error))?;
        let contextual = (signature.file.ends_with(".js") || signature.file.ends_with(".mjs"))
            && self.declared(signature.node).is_none();
        if contextual {
            let (slots, ret) = if let Some(Type::Func { params, ret }) = abi {
                (Some(params), Some(*ret))
            } else {
                (None, result)
            };
            if let Some(slots) = slots {
                if slots.len() != signature.params.len()
                    || signature
                        .params
                        .iter()
                        .zip(&slots)
                        .any(|(p, t)| p.r#type != Type::Dyn && p.r#type != *t)
                {
                    return Err(self.refuse(
                        site,
                        "JavaScript function parameters conflict with contextual native ABI",
                    ));
                }
                for (param, ty) in signature.params.iter_mut().zip(slots) {
                    param.r#type = ty;
                }
            }
            if let Some(ret) = ret {
                if signature.return_type != Type::Dyn
                    && ret != Type::Dyn
                    && signature.return_type != ret
                {
                    return Err(self.refuse(
                        site,
                        "JavaScript function result conflicts with contextual native ABI",
                    ));
                }
                signature.return_type = ret;
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
