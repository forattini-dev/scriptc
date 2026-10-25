//! Standard JSON function values use one owning compiled closure per operation.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

impl Lowerer<'_> {
    pub(super) fn guard_raw_json_write(&mut self, node: Node) -> Result<(), String> {
        fn branded(lowerer: &mut Lowerer<'_>, node: Node, active: &mut HashSet<u32>) -> bool {
            let node = receivers::reference_node(node);
            let ty = lowerer.checker.get_type_at_location(node);
            if lowerer.raw_json_type(ty) {
                return true;
            }
            if node.kind() == SyntaxKind::CallExpression {
                return lowerer.json_function_origin(node.expression(), &mut HashSet::new())
                    == Some("rawJSON");
            }
            if node.kind() != SyntaxKind::Identifier {
                return false;
            }
            let symbol = lowerer.symbol(node);
            if symbol == 0 || !active.insert(symbol) {
                return false;
            }
            let decl = lowerer.checker.sym(SymbolId(symbol)).value_declaration;
            !decl.is_nil()
                && decl.kind() == SyntaxKind::VariableDeclaration
                && decl.parent().flags().intersects(NodeFlags::CONST)
                && !decl.initializer().is_nil()
                && branded(lowerer, decl.initializer(), active)
        }
        if !receivers::strict(node) && branded(self, node.left().expression(), &mut HashSet::new())
        {
            return Err(self.refuse(
                node,
                "sloppy raw JSON writes require a native integrity contract; not ported",
            ));
        }
        Ok(())
    }

    pub(super) fn raw_json_property_type(&mut self, node: Node) -> Option<Type> {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return None;
        }
        let receiver = self.checker.get_type_at_location(node.expression());
        if !self.raw_json_type(receiver) {
            return None;
        }
        // The standard declaration inherits Object's types, but the actual
        // branded object has a null prototype and one frozen own data field.
        Some(if node.name().text() == "rawJSON" {
            Type::String
        } else {
            Type::Dyn
        })
    }

    pub(super) fn raw_json_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        symbol.name.as_ref() == "RawJSON"
            && !symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                decl.kind() == SyntaxKind::InterfaceDeclaration
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(get_source_file_of_node(*decl)).file_name,
                    ) == Some("lib.es2026.json.d.ts")
            })
    }

    pub(super) fn json_callable_type(&self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol().0;
        if symbol == 0 {
            return None;
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        if !matches!(
            symbol.name.as_ref(),
            "stringify" | "parse" | "rawJSON" | "isRawJSON"
        ) || symbol.declarations.is_empty()
            || !symbol.declarations.iter().all(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                let owner = decl.parent();
                source_frontend::frontend::bundled::bundled_lib_name(&file.file_name).is_some()
                    && owner.kind() == SyntaxKind::InterfaceDeclaration
                    && owner.name().text() == "JSON"
            })
        {
            return None;
        }
        Some(Type::Func {
            rest: true,
            params: vec![Type::Array {
                elem: Box::new(Type::Dyn),
            }],
            ret: Box::new(Type::Dyn),
        })
    }

    fn standard_json_member(&mut self, node: Node) -> Option<&'static str> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let member = match node.name().text() {
            "stringify" => "stringify",
            "parse" => "parse",
            "rawJSON" => "rawJSON",
            "isRawJSON" => "isRawJSON",
            _ => return None,
        };
        let global = self.symbol(node.expression());
        if !self.primitive_symbol(global, "JSON", None) {
            return None;
        }
        let symbol = self.symbol(node.name());
        // Newer APIs can be used from unchecked JavaScript with older lib
        // declarations. The proven global still owns the pinned native member.
        // A declared override must always retain the standard member proof.
        if symbol != 0 && !self.primitive_symbol(symbol, member, Some("JSON")) {
            return None;
        }
        Some(member)
    }
    pub(super) fn json_function_origin(
        &mut self,
        node: Node,
        active: &mut HashSet<u32>,
    ) -> Option<&'static str> {
        let node = receivers::reference_node(node);
        if let Some(member) = self.standard_json_member(node) {
            return Some(member);
        }
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let id = self.symbol(node);
        if id == 0 || !active.insert(id) {
            return None;
        }
        let decl = self.checker.sym(SymbolId(id)).value_declaration;
        let result = if !decl.is_nil()
            && decl.kind() == SyntaxKind::VariableDeclaration
            && decl.parent().flags().intersects(NodeFlags::CONST)
            && decl.name().kind() == SyntaxKind::Identifier
            && !decl.initializer().is_nil()
        {
            self.json_function_origin(decl.initializer(), active)
        } else {
            None
        };
        active.remove(&id);
        result
    }
    pub(super) fn json_function_type(&mut self, node: Node) -> Option<Type> {
        if node.kind() == SyntaxKind::CallExpression {
            let callee = self.checker.get_type_at_location(node.expression());
            // A declaration can reuse a standard JSON callable contract for
            // another implementation. Its native result is still owning and
            // may be undefined, unlike the declaration's string projection.
            if self.json_callable_type(callee).is_some()
                || self
                    .json_function_origin(node.expression(), &mut HashSet::new())
                    .is_some()
            {
                return Some(Type::Dyn);
            }
        }
        self.json_function_origin(node, &mut HashSet::new())?;
        Some(Type::Func {
            rest: true,
            params: vec![Type::Array {
                elem: Box::new(Type::Dyn),
            }],
            ret: Box::new(Type::Dyn),
        })
    }
    pub(super) fn json_function_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(member) = self.standard_json_member(node) else {
            return Ok(None);
        };
        self.ensure_exception_classes(node)?;
        let args = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let mut helper = helpers::Helper::new(
            &format!("json_{member}"),
            vec![args],
            Type::Dyn,
            self.loc(node),
        );
        helper.function.rest = true;
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: format!("json.{member}Native"),
                args: vec![helper.read(&helper.param(0))],
                r#type: Type::Dyn,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        let ty = Type::Func {
            rest: true,
            params: helper
                .function
                .params
                .iter()
                .map(|p| p.r#type.clone())
                .collect(),
            ret: Box::new(Type::Dyn),
        };
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: ty,
            loc: self.loc(node),
        }))
    }
    pub(super) fn json_function_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let origin = self.json_function_origin(node.expression(), &mut HashSet::new());
        if origin == Some("parse") && node.arguments().len() > 1 {
            let reviver = self.checker.get_type_at_location(node.arguments().get(1));
            if !self
                .checker
                .get_signatures_of_type(reviver, source_frontend::prelude::SignatureKind::CALL)
                .is_empty()
            {
                return Err(self.refuse(
                    node,
                    "JSON.parse reviver requires a source-preserving parse context; not ported",
                ));
            }
        }
        if origin.is_some() {
            self.call_value(node).map(Some)
        } else {
            Ok(None)
        }
    }
}
