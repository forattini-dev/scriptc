//! Own-key reflection for closed native data records.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

impl Lowerer<'_> {
    pub(super) fn object_reflection(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let name = member.name().text();
        if !matches!(name, "keys" | "hasOwn") {
            return Ok(None);
        }
        let symbol = self.symbol(member.expression());
        if symbol == 0 {
            return Ok(None);
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        if symbol.name.as_ref() != "Object"
            || symbol.declarations.is_empty()
            || !symbol.declarations.iter().all(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                source_frontend::frontend::bundled::bundled_lib_name(&file.file_name)
                    == Some("lib.es5.d.ts")
            })
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != if name == "keys" { 1 } else { 2 } {
            return Err(self.refuse(
                node,
                "native record reflection argument count is not ported",
            ));
        }
        let value = self.expression(args[0])?;
        if !self.reflected_record(&value.ty()) {
            return Err(self.refuse(node, "own-key reflection requires a closed data record"));
        }
        let value = self.coerce(value, Type::Dyn, args[0])?;
        if name == "hasOwn" {
            let key = self.expected_expression(args[1], Type::String)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "dyn.hasOwn".into(),
                args: vec![value, key],
                r#type: Type::Bool,
                loc: self.loc(node),
            }));
        }
        // The retained reflection operation returns an erased array. Copy its
        // known string elements through checked reads into the typed array ABI.
        let array = Type::Array {
            elem: Box::new(Type::String),
        };
        let mut helper = helpers::Helper::new(
            "record_keys",
            vec![Type::Dyn],
            array.clone(),
            self.loc(node),
        );
        let keys = helper.local("keys", Type::Dyn, false);
        let result = helper.local("result", array.clone(), false);
        let index = helper.local("index", Type::F64, true);
        let length = helper.local("length", Type::F64, false);
        helper.declare(
            &keys,
            Expr::LibCall {
                r#fn: "dyn.objKeys".into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
        );
        helper.declare(
            &result,
            Expr::ArrayLit {
                elems: vec![],
                r#type: array.clone(),
                loc: helper.loc(),
            },
        );
        helper.declare(&index, helper.number(0.0));
        let length_value = self.dynamic_get(
            node,
            helper.read(&keys),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: helper.loc(),
            },
        );
        helper.declare(&length, self.coerce(length_value, Type::F64, node)?);
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let item = self.dynamic_get(node, helper.read(&keys), key);
        let item = self.coerce(item, Type::String, node)?;
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: vec![
                Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&result)),
                        args: vec![item],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    },
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&result));
        Ok(Some(Expr::Call {
            callee,
            args: vec![value],
            r#type: array,
            loc: self.loc(node),
        }))
    }

    fn reflected_record(&self, ty: &Type) -> bool {
        match ty {
            Type::Record { shape_id } => {
                let shape = &self.records[*shape_id];
                !shape.tuple
                    && shape.index_value.is_none()
                    && !self.enum_shape(*shape_id)
                    && !self.callables.contains_key(shape_id)
            }
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.reflected_record(arm)),
            _ => false,
        }
    }
}
