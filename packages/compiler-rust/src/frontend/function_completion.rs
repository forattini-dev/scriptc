//! Source completion supplies undefined only when the owning result ABI admits it.
use super::*;
impl Lowerer<'_> {
    pub(super) fn undefined_return(&self, result: Type, node: Node) -> Result<Expr, String> {
        self.coerce(
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            },
            result,
            node,
        )
    }
    pub(super) fn complete_function_body(
        &self,
        body: &mut Vec<Stmt>,
        result: &Type,
        node: Node,
        refusal: &str,
    ) -> Result<(), String> {
        if *result == Type::Void || ir::always_returns(body) {
            return Ok(());
        }
        let value = self
            .undefined_return(result.clone(), node)
            .map_err(|_| self.refuse(node, refusal))?;
        body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(node),
        });
        Ok(())
    }
}
