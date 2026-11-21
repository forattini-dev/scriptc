use super::*;
use source_frontend::prelude::SymbolId;

impl Lowerer<'_> {
    pub(super) fn unavailable_intl_segmenter_origin(
        &mut self,
        node: Node,
        active: &mut HashSet<u32>,
    ) -> bool {
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::PropertyAccessExpression && node.name().text() == "Segmenter"
        {
            let namespace = receivers::reference_node(node.expression());
            if namespace.kind() != SyntaxKind::Identifier || namespace.text() != "Intl" {
                return false;
            }
            let symbol = self.symbol(namespace);
            return !self.bindings.contains_key(&symbol)
                && !self.module_bindings.contains_key(&symbol)
                && !self.outer.iter().any(|scope| scope.contains_key(&symbol));
        }
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 || !active.insert(symbol) {
            return false;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        let result = !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && !declaration.initializer().is_nil()
            && self.unavailable_intl_segmenter_origin(declaration.initializer(), active);
        active.remove(&symbol);
        result
    }
}
