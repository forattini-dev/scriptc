//! Lazy strict-equality selection and fallthrough use the portable switch node.
use super::*;

impl Lowerer<'_> {
    pub(super) fn switch_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let saved_bindings = self.bindings.clone();
        let saved_types = self.var_types.clone();
        self.var_defined.clear();
        let value = self.condition_value(node.expression())?;
        let value = self.primitive_capture(value, node.expression())?;
        let value = self.coerce(value, Type::Dyn, node.expression())?;
        let source = self.construction_local(Type::Dyn, false);
        let loc = self.loc(node);
        let mut cases = Vec::new();
        for clause in node.case_block().clauses().nodes() {
            // Braced cases already own their lexical cells. A shared case
            // scope needs declaration instantiation before tests, including
            // TDZ reads from other cases; never approximate it with if scopes.
            for statement in clause.statements() {
                if statement.kind() == SyntaxKind::VariableStatement
                    && statement
                        .declaration_list()
                        .flags()
                        .intersects(NodeFlags::LET | NodeFlags::CONST)
                {
                    return Err(self.refuse(statement, "switch lexical declarations require a braced case body; shared case-scope instantiation is not ported"));
                }
            }
            self.var_defined.clear();
            let test = if clause.kind() == SyntaxKind::DefaultClause {
                None
            } else {
                let value = self.condition_value(clause.expression())?;
                let value = self.primitive_capture(value, clause.expression())?;
                Some(Expr::DynScalarEq {
                    left: Box::new(self.construction_read(&source, clause)),
                    right: Box::new(self.coerce(value, Type::Dyn, clause.expression())?),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(clause),
                })
            };
            self.var_defined.clear();
            cases.push(ir::SwitchCase {
                test,
                body: self.statements(clause.statements())?,
            });
        }
        self.bindings = saved_bindings;
        self.var_types = saved_types;
        self.var_defined.clear();
        Ok(vec![Stmt::Block {
            body: vec![
                Stmt::VarDecl {
                    local_id: source.id,
                    init: value,
                    loc: loc.clone(),
                },
                Stmt::Switch {
                    disc: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    cases,
                    loc: loc.clone(),
                },
            ],
            loc,
        }])
    }
}
