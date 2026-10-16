//! Source-checker identities are adapted to owned scriptc value layouts.
use super::*;

impl Lowerer<'_> {
    pub(super) fn primitive_type(&self, flags: TypeFlags) -> Option<Type> {
        if flags.intersects(TypeFlags::NUMBER_LIKE) {
            Some(Type::F64)
        } else if flags.intersects(TypeFlags::STRING_LIKE) {
            Some(Type::String)
        } else if flags.intersects(TypeFlags::BOOLEAN_LIKE) {
            Some(Type::Bool)
        } else {
            None
        }
    }
    pub(super) fn type_id(&mut self, id: TypeId) -> Option<Type> {
        if let Some(ty) = self.primitive_type(self.checker.ty(id).flags) {
            return Some(ty);
        }
        self.aggregate_type(id)
    }
    pub(super) fn ty(&mut self, node: Node) -> Result<Type, String> {
        let id = self.checker.get_type_at_location(node);
        self.type_id(id).ok_or_else(|| {
            self.refuse(
                node,
                "type has no representation in the first native IR subset",
            )
        })
    }
    pub(super) fn storage_type(&mut self, node: Node) -> Result<Type, String> {
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && let Some(hint) = self.declared(node.parent())
        {
            return hint.function_type().ok_or_else(|| {
                self.refuse(
                    node,
                    "public JavaScript function value has no native signature",
                )
            });
        }
        let ty = self.ty(node)?;
        if matches!(ty, Type::Null | Type::Undefined) {
            return Err(self.refuse(
                node,
                "standalone unit storage outside a union is not ported",
            ));
        }
        Ok(ty)
    }
}
