//! Static runtime dependencies in source order. Dynamic import is not an edge.
use source_frontend::flags::NodeFlags;
use source_frontend::prelude::{Node, SyntaxKind};
use std::collections::VecDeque;

#[derive(Clone, serde::Serialize)]
pub(super) struct AwaitSite {
    start: i32,
    end: i32,
    kind: &'static str,
}

/// Find suspension executed during module evaluation, excluding nested
/// function bodies. Computed method names are evaluated at class definition.
pub(super) fn top_level_await_sites(node: Node) -> Vec<AwaitSite> {
    fn visit(node: Node, sites: &mut Vec<AwaitSite>) {
        let kind = match node.kind() {
            SyntaxKind::AwaitExpression => Some("await"),
            SyntaxKind::ForOfStatement if !node.await_modifier().is_nil() => Some("for-await"),
            SyntaxKind::VariableDeclarationList
                if node.flags().contains(NodeFlags::AWAIT_USING) =>
            {
                Some("await-using")
            }
            SyntaxKind::FunctionDeclaration
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::Constructor => return,
            SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor => {
                let name = node.name();
                if !name.is_nil() && name.kind() == SyntaxKind::ComputedPropertyName {
                    visit(name, sites);
                }
                return;
            }
            _ => None,
        };
        if let Some(kind) = kind {
            sites.push(AwaitSite {
                start: node.pos(),
                end: node.end(),
                kind,
            });
        }
        node.for_each_child(&mut |child| {
            visit(child, sites);
            false
        });
    }
    let mut sites = Vec::new();
    visit(node, &mut sites);
    sites
}

#[derive(Default)]
pub(super) struct ModuleGraph {
    pub edges: Vec<Vec<usize>>,
    pub dynamic_edges: Vec<Vec<usize>>,
}

impl ModuleGraph {
    pub fn add_module(&mut self) -> usize {
        let index = self.edges.len();
        self.edges.push(Vec::new());
        self.dynamic_edges.push(Vec::new());
        index
    }

    pub fn add_dependency(&mut self, module: usize, dependency: usize) {
        if !self.edges[module].contains(&dependency) {
            self.edges[module].push(dependency);
        }
    }

    /// Discover a linked module without including it in eager evaluation or
    /// in static-cycle and top-level-await propagation.
    pub fn add_dynamic_dependency(&mut self, module: usize, dependency: usize) {
        if !self.dynamic_edges[module].contains(&dependency) {
            self.dynamic_edges[module].push(dependency);
        }
    }

    /// Preserve depth-first source order, evaluating each module once.
    pub fn evaluation_order(&self, entry: usize) -> Vec<usize> {
        fn visit(graph: &ModuleGraph, module: usize, seen: &mut [bool], out: &mut Vec<usize>) {
            if std::mem::replace(&mut seen[module], true) {
                return;
            }
            for &dependency in &graph.edges[module] {
                visit(graph, dependency, seen, out);
            }
            out.push(module);
        }
        let mut out = Vec::new();
        visit(self, entry, &mut vec![false; self.edges.len()], &mut out);
        out
    }

    /// Async evaluation propagates through importers, including through SCCs.
    pub fn async_closure(&self, intrinsic: &[bool]) -> Vec<bool> {
        assert_eq!(intrinsic.len(), self.edges.len());
        let mut parents = vec![Vec::new(); self.edges.len()];
        for (module, dependencies) in self.edges.iter().enumerate() {
            for &dependency in dependencies {
                parents[dependency].push(module);
            }
        }
        let mut result = intrinsic.to_vec();
        let mut queue = intrinsic
            .iter()
            .enumerate()
            .filter_map(|(i, &value)| value.then_some(i))
            .collect::<VecDeque<_>>();
        while let Some(module) = queue.pop_front() {
            for &parent in &parents[module] {
                if !result[parent] {
                    result[parent] = true;
                    queue.push_back(parent);
                }
            }
        }
        result
    }

    /// Identify cycle groups so a future async evaluator never waits on itself.
    pub fn components(&self) -> Vec<Vec<usize>> {
        fn visit(edges: &[Vec<usize>], node: usize, seen: &mut [bool], out: &mut Vec<usize>) {
            if std::mem::replace(&mut seen[node], true) {
                return;
            }
            for &next in &edges[node] {
                visit(edges, next, seen, out);
            }
            out.push(node);
        }
        let count = self.edges.len();
        let mut seen = vec![false; count];
        let mut finish = Vec::new();
        for node in 0..count {
            visit(&self.edges, node, &mut seen, &mut finish);
        }
        let mut reverse = vec![Vec::new(); count];
        for (node, edges) in self.edges.iter().enumerate() {
            for &next in edges {
                reverse[next].push(node);
            }
        }
        seen.fill(false);
        let mut components = Vec::new();
        while let Some(node) = finish.pop() {
            if !seen[node] {
                let mut component = Vec::new();
                visit(&reverse, node, &mut seen, &mut component);
                components.push(component);
            }
        }
        components
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(count: usize, edges: &[(usize, usize)]) -> ModuleGraph {
        let mut graph = ModuleGraph::default();
        for _ in 0..count {
            graph.add_module();
        }
        for &(module, dependency) in edges {
            graph.add_dependency(module, dependency);
        }
        graph
    }

    #[test]
    fn evaluation_order_preserves_siblings_and_evaluates_shared_modules_once() {
        let graph = graph(5, &[(0, 1), (0, 2), (0, 1), (1, 3), (2, 3)]);
        assert_eq!(graph.edges[0], [1, 2]);
        assert_eq!(graph.evaluation_order(0), [3, 1, 2, 0]);
    }

    #[test]
    fn cycle_groups_and_async_propagation_include_all_importers() {
        let graph = graph(7, &[(0, 1), (0, 4), (1, 2), (2, 3), (3, 1), (4, 5), (5, 5)]);
        let mut components = graph.components();
        for component in &mut components {
            component.sort_unstable();
        }
        components.sort();
        assert_eq!(
            components,
            [vec![0], vec![1, 2, 3], vec![4], vec![5], vec![6]]
        );
        assert_eq!(
            graph.async_closure(&[false, false, true, false, false, false, false]),
            [true, true, true, true, false, false, false]
        );
        assert_eq!(
            graph.async_closure(&[false, false, false, false, false, true, false]),
            [true, false, false, false, true, true, false]
        );
    }

    #[test]
    fn dynamic_edges_do_not_schedule_or_propagate_async_evaluation() {
        let mut graph = graph(4, &[(0, 1), (2, 3)]);
        graph.add_dynamic_dependency(1, 2);
        graph.add_dynamic_dependency(1, 2);
        graph.add_dynamic_dependency(3, 0);
        assert_eq!(graph.dynamic_edges[1], [2]);
        assert_eq!(graph.evaluation_order(0), [1, 0]);
        assert_eq!(graph.evaluation_order(2), [3, 2]);
        assert_eq!(
            graph.async_closure(&[false, false, true, false]),
            [false, false, true, false]
        );
        assert!(
            graph
                .components()
                .iter()
                .all(|component| component.len() == 1)
        );
    }
}
