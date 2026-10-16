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
        if self
            .checker
            .ty(id)
            .flags
            .intersects(TypeFlags::ANY | TypeFlags::UNKNOWN | TypeFlags::TYPE_PARAMETER)
        {
            return Some(Type::Dyn);
        }
        if let Some(ty) = self.primitive_type(self.checker.ty(id).flags) {
            return Some(ty);
        }
        if let Some(ty) = self.class_type(id) {
            return Some(ty);
        }
        if self.is_regex_type(id) {
            return Some(Type::Regex);
        }
        self.aggregate_type(id)
    }
    pub(super) fn ty(&mut self, node: Node) -> Result<Type, String> {
        if let Some(ty) = self.enum_type(node) {
            return Ok(ty);
        }
        if let Some(ty) = self.projections.get(&declarations::Key::of(node)) {
            return Ok(ty.clone());
        }
        let id = self.checker.get_type_at_location(node);
        if self.checker.ty(id).flags.intersects(TypeFlags::VOID) {
            return Ok(Type::Undefined);
        }
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
            && hint.class.is_none()
        {
            if hint.reason.is_none()
                && let Some(ty) = &hint.value_type
            {
                return Ok(ty.clone());
            }
            return hint.function_type().ok_or_else(|| {
                self.refuse(
                    node,
                    "public JavaScript function value has no native signature",
                )
            });
        }
        let ty = self.ty(node)?;
        if ty == Type::Dyn
            && node.parent().kind() == SyntaxKind::VariableDeclaration
            && (self.file.ends_with(".js") || self.file.ends_with(".mjs"))
            && node
                .parent()
                .parent()
                .flags()
                .intersects(NodeFlags::LET | NodeFlags::CONST)
        {
            return Err(self.refuse(
                node,
                "infer unannotated JavaScript lexical storage from its native initializer",
            ));
        }

        if matches!(ty, Type::Null | Type::Undefined) {
            return Err(self.refuse(
                node,
                "standalone unit storage outside a union is not ported",
            ));
        }
        Ok(ty)
    }
}
