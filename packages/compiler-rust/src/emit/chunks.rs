//! Deterministic source-module partitioning for multi-crate emission.
//!
//! Static import cycles are indivisible because their bindings and module
//! initialization state are shared. Dynamic edges are reported but never
//! converted into eager dependencies.
use crate::ir::{Expr, Module, SourceModule};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChunkPlan {
    pub schema_version: u32,
    pub weight_model: &'static str,
    pub target_weight: usize,
    pub total_weight: usize,
    pub total_source_bytes: usize,
    pub chunks: Vec<Chunk>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Chunk {
    pub id: String,
    pub weight: usize,
    pub source_bytes: usize,
    pub contains_eager_modules: bool,
    pub contains_lazy_modules: bool,
    pub modules: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub static_chunks: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dynamic_chunks: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbiPlan {
    pub schema_version: u32,
    pub partition: ChunkPlan,
    pub chunks: Vec<ChunkOwnership>,
    pub cross_chunk_references: Vec<CrossChunkReference>,
    pub abi_owned_functions: Vec<String>,
    pub abi_owned_classes: Vec<String>,
    pub abi_owned_globals: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured_rust: Option<MeasuredRust>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeasuredRust {
    pub total_bytes: usize,
    pub abi_and_root_bytes: usize,
    pub function_body_bytes: usize,
    pub by_source_module: BTreeMap<String, usize>,
    pub by_section: BTreeMap<String, usize>,
    pub value_adapter_definitions: usize,
    pub retained_value_adapters: usize,
    pub removed_value_adapter_bytes: usize,
    pub removed_dead_locals: usize,
    pub removed_dead_local_declarations: usize,
    pub removed_dead_local_assignments: usize,
    pub preserved_dead_local_effects: usize,
    pub callable_functions: usize,
    pub direct_only_functions: usize,
    pub function_abi_types: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChunkOwnership {
    pub id: String,
    pub functions: usize,
    pub classes: usize,
    pub globals: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrossChunkReference {
    pub from_chunk: String,
    pub to_chunk: String,
    pub caller: String,
    pub target: String,
    pub kind: &'static str,
}

#[derive(Clone, Debug)]
struct Component {
    modules: Vec<usize>,
    weight: usize,
    source_bytes: usize,
    contains_eager_modules: bool,
    contains_lazy_modules: bool,
}

// The red-dev baseline expands 3.10 MiB of executable TS/JS to 57.39 MiB of
// generated Rust. Sixteen is deliberately a little lower than that observed
// ratio: it is a stable packing estimate, not a claim about exact output size.
const SOURCE_TO_RUST_WEIGHT: usize = 16;

fn estimated_weight(source_bytes: usize) -> usize {
    source_bytes.max(1).saturating_mul(SOURCE_TO_RUST_WEIGHT)
}

pub(crate) fn plan_sources(
    sources: &[SourceModule],
    target_weight: usize,
) -> Result<ChunkPlan, String> {
    plan_sources_with_affinity(sources, target_weight, &BTreeMap::new())
}

fn plan_sources_with_affinity(
    sources: &[SourceModule],
    target_weight: usize,
    extra_affinity: &BTreeMap<(String, String), usize>,
) -> Result<ChunkPlan, String> {
    if target_weight == 0 {
        return Err("chunk target weight must be greater than zero".into());
    }
    let mut ordered = sources.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.file.cmp(&right.file));
    let mut index = BTreeMap::new();
    for (position, source) in ordered.iter().enumerate() {
        if index.insert(source.file.as_str(), position).is_some() {
            return Err(format!("duplicate source module {:?}", source.file));
        }
    }
    let resolve = |owner: &SourceModule, dependency: &str| {
        index.get(dependency).copied().ok_or_else(|| {
            format!(
                "source module {:?} references missing dependency {dependency:?}",
                owner.file
            )
        })
    };
    let mut static_edges = vec![Vec::new(); ordered.len()];
    let mut dynamic_edges = vec![Vec::new(); ordered.len()];
    for (position, source) in ordered.iter().enumerate() {
        for dependency in &source.static_dependencies {
            static_edges[position].push(resolve(source, dependency)?);
        }
        for dependency in &source.dynamic_dependencies {
            dynamic_edges[position].push(resolve(source, dependency)?);
        }
        static_edges[position].sort_unstable();
        static_edges[position].dedup();
        dynamic_edges[position].sort_unstable();
        dynamic_edges[position].dedup();
    }

    let components = components(&static_edges, &ordered);
    let mut module_component = vec![0usize; ordered.len()];
    for (component_index, component) in components.iter().enumerate() {
        for &module in &component.modules {
            module_component[module] = component_index;
        }
    }
    let mut affinity = vec![BTreeMap::<usize, usize>::new(); components.len()];
    for edges in [&static_edges, &dynamic_edges] {
        for (module, dependencies) in edges.iter().enumerate() {
            let from = module_component[module];
            for &dependency in dependencies {
                let to = module_component[dependency];
                if from == to {
                    continue;
                }
                *affinity[from].entry(to).or_default() += 1;
                *affinity[to].entry(from).or_default() += 1;
            }
        }
    }
    for ((left, right), weight) in extra_affinity {
        let left = index[left.as_str()];
        let right = index[right.as_str()];
        let left = module_component[left];
        let right = module_component[right];
        if left != right {
            *affinity[left].entry(right).or_default() += weight;
            *affinity[right].entry(left).or_default() += weight;
        }
    }
    let mut remaining = components.into_iter().map(Some).collect::<Vec<_>>();
    let mut chunks = Vec::<Component>::new();
    while let Some(seed) = remaining.iter().position(Option::is_some) {
        let mut members = vec![seed];
        let mut chunk = remaining[seed].take().unwrap();
        loop {
            let mut best = None::<(usize, usize)>;
            for (candidate, component) in remaining.iter().enumerate() {
                let Some(component) = component else { continue };
                if chunk.weight.saturating_add(component.weight) > target_weight {
                    continue;
                }
                let score = members
                    .iter()
                    .map(|member| affinity[*member].get(&candidate).copied().unwrap_or(0))
                    .sum();
                if best.is_none_or(|(_, best_score)| score > best_score) {
                    best = Some((candidate, score));
                }
            }
            let Some((candidate, _)) = best else { break };
            let component = remaining[candidate].take().unwrap();
            members.push(candidate);
            chunk.weight += component.weight;
            chunk.source_bytes += component.source_bytes;
            chunk.contains_eager_modules |= component.contains_eager_modules;
            chunk.contains_lazy_modules |= component.contains_lazy_modules;
            chunk.modules.extend(component.modules);
        }
        chunks.push(chunk);
    }

    let mut module_chunk = vec![0usize; ordered.len()];
    for (chunk_index, chunk) in chunks.iter_mut().enumerate() {
        chunk.modules.sort_unstable();
        for &module in &chunk.modules {
            module_chunk[module] = chunk_index;
        }
    }
    let chunk_id = |index: usize| format!("scriptc_chunk_{index:04}");
    let chunks = chunks
        .into_iter()
        .enumerate()
        .map(|(chunk_index, chunk)| {
            let mut static_chunks = BTreeSet::new();
            let mut dynamic_chunks = BTreeSet::new();
            for &module in &chunk.modules {
                for &dependency in &static_edges[module] {
                    let dependency_chunk = module_chunk[dependency];
                    if dependency_chunk != chunk_index {
                        static_chunks.insert(chunk_id(dependency_chunk));
                    }
                }
                for &dependency in &dynamic_edges[module] {
                    let dependency_chunk = module_chunk[dependency];
                    if dependency_chunk != chunk_index {
                        dynamic_chunks.insert(chunk_id(dependency_chunk));
                    }
                }
            }
            Chunk {
                id: chunk_id(chunk_index),
                weight: chunk.weight,
                source_bytes: chunk.source_bytes,
                contains_eager_modules: chunk.contains_eager_modules,
                contains_lazy_modules: chunk.contains_lazy_modules,
                modules: chunk
                    .modules
                    .into_iter()
                    .map(|module| ordered[module].file.clone())
                    .collect(),
                static_chunks: static_chunks.into_iter().collect(),
                dynamic_chunks: dynamic_chunks.into_iter().collect(),
            }
        })
        .collect::<Vec<_>>();
    Ok(ChunkPlan {
        schema_version: 1,
        weight_model: "estimated-rust-bytes-v1-source-x16",
        target_weight,
        total_weight: ordered
            .iter()
            .map(|source| estimated_weight(source.source_bytes))
            .sum(),
        total_source_bytes: ordered.iter().map(|source| source.source_bytes).sum(),
        chunks,
    })
}

pub(crate) fn plan_abi(module: &Module, target_weight: usize) -> Result<AbiPlan, String> {
    let function_files = module
        .functions
        .iter()
        .map(|function| (function.name.as_str(), function.loc.file.as_str()))
        .collect::<BTreeMap<_, _>>();
    let source_files = module
        .source_modules
        .iter()
        .map(|source| source.file.as_str())
        .collect::<BTreeSet<_>>();
    let mut call_affinity = BTreeMap::new();
    for function in &module.functions {
        if !source_files.contains(function.loc.file.as_str()) {
            continue;
        }
        function.visit_expressions(&mut |expression| {
            let target = match expression {
                Expr::Call { callee, .. } => callee,
                Expr::Closure { fn_name, .. } => fn_name,
                _ => return,
            };
            let Some(target_file) = function_files.get(target.as_str()) else {
                return;
            };
            if function.loc.file != *target_file && source_files.contains(*target_file) {
                let edge = if function.loc.file.as_str() < *target_file {
                    (function.loc.file.clone(), (*target_file).into())
                } else {
                    ((*target_file).into(), function.loc.file.clone())
                };
                *call_affinity.entry(edge).or_default() += 1;
            }
        });
    }
    let partition =
        plan_sources_with_affinity(&module.source_modules, target_weight, &call_affinity)?;
    let mut owner = BTreeMap::<String, String>::new();
    for chunk in &partition.chunks {
        for source in &chunk.modules {
            owner.insert(source.clone(), chunk.id.clone());
        }
    }
    let mut ownership = partition
        .chunks
        .iter()
        .map(|chunk| {
            (
                chunk.id.clone(),
                ChunkOwnership {
                    id: chunk.id.clone(),
                    functions: 0,
                    classes: 0,
                    globals: 0,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut functions = BTreeMap::<String, Option<String>>::new();
    let mut abi_owned_functions = Vec::new();
    for function in &module.functions {
        let chunk = owner.get(&function.loc.file).cloned();
        functions.insert(function.name.clone(), chunk.clone());
        if let Some(chunk) = chunk {
            ownership.get_mut(&chunk).unwrap().functions += 1;
        } else {
            abi_owned_functions.push(function.name.clone());
        }
    }
    let mut abi_owned_classes = Vec::new();
    for class in &module.classes {
        if let Some(chunk) = owner.get(&class.loc.file) {
            ownership.get_mut(chunk).unwrap().classes += 1;
        } else {
            abi_owned_classes.push(class.name.clone());
        }
    }
    let mut abi_owned_globals = Vec::new();
    for global in &module.globals {
        if let Some(chunk) = owner.get(&global.loc.file) {
            ownership.get_mut(chunk).unwrap().globals += 1;
        } else {
            abi_owned_globals.push(global.id.clone());
        }
    }
    let mut references = BTreeSet::new();
    for function in &module.functions {
        let Some(from_chunk) = owner.get(&function.loc.file) else {
            continue;
        };
        function.visit_expressions(&mut |expression| {
            let (target, kind) = match expression {
                Expr::Call { callee, .. } => (callee.as_str(), "call"),
                Expr::Closure { fn_name, .. } => (fn_name.as_str(), "closure"),
                _ => return,
            };
            let Some(Some(to_chunk)) = functions.get(target) else {
                return;
            };
            if from_chunk != to_chunk {
                references.insert(CrossChunkReference {
                    from_chunk: from_chunk.clone(),
                    to_chunk: to_chunk.clone(),
                    caller: function.name.clone(),
                    target: target.into(),
                    kind,
                });
            }
        });
    }
    abi_owned_functions.sort();
    abi_owned_classes.sort();
    abi_owned_globals.sort();
    Ok(AbiPlan {
        schema_version: 1,
        partition,
        chunks: ownership.into_values().collect(),
        cross_chunk_references: references.into_iter().collect(),
        abi_owned_functions,
        abi_owned_classes,
        abi_owned_globals,
        measured_rust: None,
    })
}

fn components(edges: &[Vec<usize>], sources: &[&SourceModule]) -> Vec<Component> {
    fn visit(edges: &[Vec<usize>], node: usize, seen: &mut [bool], out: &mut Vec<usize>) {
        if std::mem::replace(&mut seen[node], true) {
            return;
        }
        for &next in &edges[node] {
            visit(edges, next, seen, out);
        }
        out.push(node);
    }
    let mut seen = vec![false; edges.len()];
    let mut finish = Vec::new();
    for node in 0..edges.len() {
        visit(edges, node, &mut seen, &mut finish);
    }
    let mut reverse = vec![Vec::new(); edges.len()];
    for (node, dependencies) in edges.iter().enumerate() {
        for &dependency in dependencies {
            reverse[dependency].push(node);
        }
    }
    for incoming in &mut reverse {
        incoming.sort_unstable();
    }
    seen.fill(false);
    let mut result = Vec::new();
    while let Some(node) = finish.pop() {
        if seen[node] {
            continue;
        }
        let mut modules = Vec::new();
        visit(&reverse, node, &mut seen, &mut modules);
        modules.sort_unstable();
        result.push(Component {
            weight: modules
                .iter()
                .map(|module| estimated_weight(sources[*module].source_bytes))
                .sum(),
            source_bytes: modules
                .iter()
                .map(|module| sources[*module].source_bytes)
                .sum(),
            contains_eager_modules: modules.iter().any(|module| sources[*module].eager),
            contains_lazy_modules: modules.iter().any(|module| !sources[*module].eager),
            modules,
        });
    }
    // SCC discovery order is an implementation detail. Stable lexical order
    // keeps the plan and its content-addressable cache keys reproducible.
    result.sort_by(|left, right| {
        sources[left.modules[0]]
            .file
            .cmp(&sources[right.modules[0]].file)
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Function, Global, Loc, Stmt, Type};

    fn source(
        file: &str,
        static_dependencies: &[&str],
        dynamic_dependencies: &[&str],
        source_bytes: usize,
        eager: bool,
    ) -> SourceModule {
        SourceModule {
            file: file.into(),
            static_dependencies: static_dependencies
                .iter()
                .map(|value| (*value).into())
                .collect(),
            dynamic_dependencies: dynamic_dependencies
                .iter()
                .map(|value| (*value).into())
                .collect(),
            source_bytes,
            eager,
        }
    }

    #[test]
    fn cycles_are_indivisible_and_shared_modules_are_assigned_once() {
        let plan = plan_sources(
            &[
                source("a.ts", &["b.ts", "shared.ts"], &[], 4, true),
                source("b.ts", &["a.ts"], &[], 4, true),
                source("lazy.ts", &["shared.ts"], &[], 4, false),
                source("shared.ts", &[], &[], 4, true),
            ],
            112,
        )
        .unwrap();
        assert_eq!(plan.chunks[0].modules, ["a.ts", "b.ts"]);
        assert_eq!(plan.chunks[0].weight, 128);
        assert_eq!(
            plan.chunks
                .iter()
                .flat_map(|chunk| &chunk.modules)
                .filter(|module| module.as_str() == "shared.ts")
                .count(),
            1
        );
    }

    #[test]
    fn input_and_dependency_order_do_not_change_the_plan() {
        let first = vec![
            source("entry.ts", &["z.ts", "a.ts"], &["lazy.ts"], 5, true),
            source("a.ts", &[], &[], 4, true),
            source("lazy.ts", &[], &[], 3, false),
            source("z.ts", &[], &[], 4, true),
        ];
        let mut second = first.clone();
        second.reverse();
        second
            .iter_mut()
            .find(|module| module.file == "entry.ts")
            .unwrap()
            .static_dependencies
            .reverse();
        assert_eq!(
            plan_sources(&first, 128).unwrap(),
            plan_sources(&second, 128).unwrap()
        );
    }

    #[test]
    fn dynamic_edges_are_reported_without_making_lazy_chunks_eager() {
        let plan = plan_sources(
            &[
                source("entry.ts", &[], &["lazy.ts"], 6, true),
                source("lazy.ts", &[], &[], 6, false),
            ],
            96,
        )
        .unwrap();
        assert_eq!(plan.chunks.len(), 2);
        assert!(plan.chunks[0].contains_eager_modules);
        assert_eq!(plan.chunks[0].dynamic_chunks, ["scriptc_chunk_0001"]);
        assert!(!plan.chunks[1].contains_eager_modules);
        assert!(plan.chunks[1].contains_lazy_modules);
    }

    #[test]
    fn abi_inventory_reports_only_cross_chunk_static_calls_and_closures() {
        let loc = |file: &str| Loc {
            file: file.into(),
            start: 0,
            end: 1,
        };
        let a = loc("a.ts");
        let b = loc("b.ts");
        let module = Module {
            ir_version: crate::ir::VERSION,
            source_file: a.file.clone(),
            source_modules: vec![
                source("a.ts", &["b.ts"], &[], 1, true),
                source("b.ts", &[], &[], 1, true),
            ],
            entry: "fa".into(),
            records: vec![],
            unions: vec![],
            classes: vec![],
            globals: vec![Global {
                id: "%g.a".into(),
                name: "a".into(),
                r#type: Type::F64,
                mutable: false,
                loc: a.clone(),
            }],
            functions: vec![
                Function {
                    is_async: false,
                    generator: None,
                    rest: false,
                    name: "fa".into(),
                    params: vec![],
                    captures: None,
                    return_type: Type::Void,
                    locals: vec![],
                    body: vec![
                        Stmt::Expression {
                            expr: Expr::Call {
                                callee: "fb".into(),
                                args: vec![],
                                r#type: Type::Void,
                                loc: a.clone(),
                            },
                            loc: a.clone(),
                        },
                        Stmt::Expression {
                            expr: Expr::Closure {
                                fn_name: "fb".into(),
                                captures: vec![],
                                r#type: Type::Func {
                                    params: vec![],
                                    ret: Box::new(Type::Void),
                                    rest: false,
                                },
                                loc: a.clone(),
                            },
                            loc: a.clone(),
                        },
                    ],
                    loc: a,
                },
                Function {
                    is_async: false,
                    generator: None,
                    rest: false,
                    name: "fb".into(),
                    params: vec![],
                    captures: None,
                    return_type: Type::Void,
                    locals: vec![],
                    body: vec![],
                    loc: b,
                },
            ],
        };
        let plan = plan_abi(&module, 16).unwrap();
        assert_eq!(plan.chunks.len(), 2);
        assert_eq!(
            plan.chunks
                .iter()
                .map(|chunk| chunk.functions)
                .sum::<usize>(),
            2
        );
        assert_eq!(
            plan.chunks.iter().map(|chunk| chunk.globals).sum::<usize>(),
            1
        );
        assert_eq!(plan.cross_chunk_references.len(), 2);
        assert_eq!(plan.cross_chunk_references[0].kind, "call");
        assert_eq!(plan.cross_chunk_references[1].kind, "closure");
        assert!(plan.abi_owned_functions.is_empty());
    }
}
