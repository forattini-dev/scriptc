//! Callable data objects use a private function slot in an owned record layout.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

pub(super) const CALL_FIELD: &str = "\0scriptc.call";

impl Lowerer<'_> {
    pub(super) fn callable_type(&mut self, id: TypeId) -> Option<Type> {
        let properties = self.checker.get_properties_of_type(id).to_vec();
        if properties.is_empty() {
            return self.function_type(id);
        }
        let shape_id = self.records.len();
        let result = Type::Record { shape_id };
        self.records.push(ir::Record {
            id: shape_id,
            fields: vec![],
            declared_order: vec![],
            tuple: false,
            index_value: None,
        });
        self.types.insert(id, Some(result.clone()));
        let signature = self.function_type(id)?;
        let mut fields = vec![ir::Field {
            name: CALL_FIELD.into(),
            r#type: signature.clone(),
        }];
        for property in properties {
            let symbol = self.checker.sym(property);
            let name = symbol.name.to_string();
            if name == CALL_FIELD || symbol.flags.intersects(SymbolFlags::ACCESSOR) {
                return None;
            }
            let optional = symbol.flags.intersects(SymbolFlags::OPTIONAL);
            let source = self.checker.get_type_of_symbol(property);
            let mut ty = self.type_id(source)?;
            if optional {
                let mut arms = if let Type::Union { union_id } = ty {
                    self.unions[union_id].arms.clone()
                } else {
                    vec![ty]
                };
                arms.push(Type::Undefined);
                ty = self.intern_union(arms)?;
            }
            if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
                return None;
            }
            fields.push(ir::Field { name, r#type: ty });
        }
        let declared_order = fields.iter().map(|f| f.name.clone()).collect();
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        fn refers(
            ty: &Type,
            shape: usize,
            records: &[ir::Record],
            seen: &mut HashSet<usize>,
        ) -> bool {
            match ty {
                Type::Record { shape_id } => {
                    *shape_id == shape
                        || (seen.insert(*shape_id)
                            && records[*shape_id]
                                .fields
                                .iter()
                                .any(|f| refers(&f.r#type, shape, records, seen)))
                }
                Type::Func { params, ret } => {
                    params.iter().any(|p| refers(p, shape, records, seen))
                        || refers(ret, shape, records, seen)
                }
                Type::Array { elem } => refers(elem, shape, records, seen),
                _ => false,
            }
        }
        let recursive = fields
            .iter()
            .any(|f| refers(&f.r#type, shape_id, &self.records, &mut HashSet::new()));
        self.records[shape_id].fields = fields;
        self.records[shape_id].declared_order = declared_order;
        if !recursive
            && let Some(existing) = self.records.iter().find(|r| {
                r.id != shape_id
                    && self.callables.get(&r.id) == Some(&signature)
                    && r.fields == self.records[shape_id].fields
            })
        {
            let result = Type::Record {
                shape_id: existing.id,
            };
            self.types.insert(id, Some(result.clone()));
            return Some(result);
        }
        self.callables.insert(shape_id, signature);
        Some(result)
    }

    pub(super) fn callable_body(&self, value: Expr, site: Node) -> Result<Expr, String> {
        if let Type::Record { shape_id } = value.ty()
            && let Some(signature) = self.callables.get(&shape_id)
        {
            return self.coerce(value, signature.clone(), site);
        }
        Ok(value)
    }

    fn standard_object(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return false;
        }
        let info = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        info.name.as_ref() == "Object"
            && info.declarations.iter().any(|n| {
                !n.is_nil()
                    && source_file_info(get_source_file_of_node(*n))
                        .file_name
                        .ends_with("/lib.es5.d.ts")
            })
    }

    fn fresh_function(&mut self, mut node: Node) -> bool {
        while node.kind() == SyntaxKind::ParenthesizedExpression {
            node = node.expression();
        }
        if matches!(
            node.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) {
            return true;
        }
        if node.kind() == SyntaxKind::CallExpression {
            let member = node.expression();
            return member.kind() == SyntaxKind::PropertyAccessExpression
                && member.name().text() == "bind";
        }
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return false;
        }
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::VariableDeclaration
            || !declaration.parent().flags().intersects(NodeFlags::CONST)
            || declaration.initializer().is_nil()
            || !self.fresh_function(declaration.initializer())
        {
            return false;
        }
        let mut scope = declaration.parent();
        while !matches!(
            scope.kind(),
            SyntaxKind::SourceFile
                | SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
        ) {
            scope = scope.parent();
        }
        fn uses(
            lowerer: &mut Lowerer<'_>,
            node: Node,
            symbol: u32,
            declaration_name: Node,
        ) -> usize {
            let mut count = usize::from(
                node.kind() == SyntaxKind::Identifier
                    && node != declaration_name
                    && lowerer.symbol(node) == symbol,
            );
            node.for_each_child(&mut |child| {
                count += uses(lowerer, child, symbol, declaration_name);
                false
            });
            count
        }
        uses(self, scope, symbol, declaration.name()) == 1
    }

    pub(super) fn callable_assign(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "assign"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 2 || arguments[1].kind() != SyntaxKind::ObjectLiteralExpression {
            return Err(self.refuse(
                node,
                "native Object.assign requires one plain data source for a callable target",
            ));
        }
        let target = self.expression(arguments[0])?;
        let (ty, create) = match target.ty() {
            Type::Func { .. } => {
                if !self.fresh_function(arguments[0]) {
                    return Err(self.refuse(
                        arguments[0],
                        "decorating an escaped bare function requires a shared property identity",
                    ));
                }
                let ty = self.ty(node)?;
                let Type::Record { shape_id } = ty else {
                    return Err(self.refuse(
                        node,
                        "callable Object.assign result needs its property layout",
                    ));
                };
                if self.callables.get(&shape_id) != Some(&target.ty()) {
                    return Err(self.refuse(node, "callable Object.assign signature mismatch"));
                }
                (Type::Record { shape_id }, true)
            }
            ty @ Type::Record { shape_id } if self.callables.contains_key(&shape_id) => (ty, false),
            _ => {
                return Err(self.refuse(
                    node,
                    "Object.assign target is not a native callable data object",
                ));
            }
        };
        let Type::Record { shape_id } = ty else {
            unreachable!()
        };
        let mut values = vec![target];
        let mut names = Vec::new();
        let mut seen = HashSet::new();
        for property in arguments[1].properties() {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
            ) || !matches!(
                property.name().kind(),
                SyntaxKind::Identifier | SyntaxKind::StringLiteral
            ) {
                return Err(self.refuse(
                    property,
                    "callable properties must be named data properties",
                ));
            }
            let name = property.name().text().to_string();
            if name == CALL_FIELD
                || matches!(
                    name.as_str(),
                    "__proto__" | "name" | "bind" | "length" | "caller" | "arguments" | "prototype"
                )
                || !seen.insert(name.clone())
            {
                return Err(self.refuse(
                    property,
                    "callable intrinsic/prototype/private/duplicate properties are not ported",
                ));
            }
            let field = self.records[shape_id]
                .fields
                .iter()
                .find(|f| f.name == name)
                .cloned()
                .ok_or_else(|| {
                    self.refuse(
                        property,
                        "adding callable properties after escape is not ported",
                    )
                })?;
            let source = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                property.name()
            } else {
                property.initializer()
            };
            values.push(self.expected_expression(source, field.r#type)?);
            names.push(name);
        }
        let mut helper = helpers::Helper::new(
            if create {
                "callable_create"
            } else {
                "callable_assign"
            },
            values.iter().map(Expr::ty).collect(),
            ty.clone(),
            self.loc(node),
        );
        if create {
            let mut fields = vec![ir::FieldInit {
                name: CALL_FIELD.into(),
                value: helper.read(&helper.param(0)),
                absent: false,
                overflow: false,
            }];
            for (i, name) in names.iter().enumerate() {
                fields.push(ir::FieldInit {
                    name: name.clone(),
                    value: helper.read(&helper.param(i + 1)),
                    absent: false,
                    overflow: false,
                });
            }
            for field in self.records[shape_id].fields.clone() {
                if field.name != CALL_FIELD && !seen.contains(&field.name) {
                    fields.push(ir::FieldInit {
                        name: field.name,
                        value: self.coerce(
                            Expr::UnitLit {
                                unit: "undefined",
                                r#type: Type::Undefined,
                                loc: self.loc(node),
                            },
                            field.r#type,
                            node,
                        )?,
                        absent: true,
                        overflow: false,
                    });
                }
            }
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::RecordLit {
                    fields,
                    r#type: ty.clone(),
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
        } else {
            for (i, name) in names.iter().enumerate() {
                helper.function.body.push(Stmt::RecordSet {
                    obj: helper.read(&helper.param(0)),
                    shape_id: format!("r{shape_id}"),
                    field: name.clone(),
                    value: helper.read(&helper.param(i + 1)),
                    loc: helper.loc(),
                });
            }
            helper.function.body.push(Stmt::Return {
                value: Some(helper.read(&helper.param(0))),
                loc: helper.loc(),
            });
        }
        // The written field sequence is part of this helper's semantics.
        helper.function.name.push_str(&format!("_{names:?}"));
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    pub(super) fn function_bind(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression || member.name().text() != "bind" {
            return Ok(None);
        }
        let value = self.expression(member.expression())?;
        let target = self.callable_body(value, node)?;
        let Type::Func { params, ret } = target.ty() else {
            return Err(self.refuse(member, "bind requires a native function"));
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty() || arguments.len() - 1 > params.len() {
            return Err(self.refuse(
                node,
                "bind needs a this argument and a fixed native argument prefix",
            ));
        }
        let this = self.expression(arguments[0])?;
        let mut values = vec![target];
        if !matches!(this, Expr::UnitLit { .. }) {
            if this.ty() == Type::Void {
                return Err(
                    self.refuse(arguments[0], "void bind receiver sequencing is not ported")
                );
            }
            values.push(this);
        }
        let prefix_start = values.len();
        for (argument, ty) in arguments.iter().skip(1).zip(&params) {
            values.push(self.expected_expression(*argument, ty.clone())?);
        }
        let prefix = arguments.len() - 1;
        let result = Type::Func {
            params: params[prefix..].to_vec(),
            ret: ret.clone(),
        };
        let key = (
            format!("bind_{prefix_start}"),
            values.iter().map(Expr::ty).collect::<Vec<_>>(),
            result.clone(),
        );
        if let Some(name) = self.helpers.get(&key) {
            return Ok(Some(Expr::Call {
                callee: name.clone(),
                args: values,
                r#type: result,
                loc: self.loc(node),
            }));
        }
        let name = format!("lambda{}", self.next_closure);
        self.next_closure += 1;
        let mut helper = helpers::Helper::new(&key.0, key.1, result.clone(), self.loc(node));
        let sources = std::iter::once(0)
            .chain(prefix_start..values.len())
            .collect::<Vec<_>>();
        let captures = sources
            .iter()
            .enumerate()
            .map(|(i, source)| Param {
                local_id: format!("c{i}"),
                name: format!("bound{i}"),
                r#type: helper.param(*source).r#type,
            })
            .collect::<Vec<_>>();
        let mut body = helpers::Helper::new(
            &name,
            params[prefix..].to_vec(),
            (*ret).clone(),
            self.loc(node),
        );
        for capture in &captures {
            body.function.locals.push(Local {
                id: capture.local_id.clone(),
                name: capture.name.clone(),
                r#type: capture.r#type.clone(),
                mutable: false,
                boxed: true,
            });
        }
        let read = |p: &Param| Expr::VarRef {
            local_id: p.local_id.clone(),
            r#type: p.r#type.clone(),
            loc: self.loc(node),
        };
        let args = captures
            .iter()
            .skip(1)
            .map(read)
            .chain(body.function.params.iter().map(read))
            .collect();
        let call = Expr::CallValue {
            callee: Box::new(read(&captures[0])),
            args,
            r#type: (*ret).clone(),
            loc: self.loc(node),
        };
        if *ret == Type::Void {
            body.function.body.push(Stmt::Expression {
                expr: call,
                loc: self.loc(node),
            });
            body.function.body.push(Stmt::Return {
                value: None,
                loc: self.loc(node),
            });
        } else {
            body.function.body.push(Stmt::Return {
                value: Some(call),
                loc: self.loc(node),
            });
        }
        body.function.captures = Some(captures);
        self.lifted.push(body.function);
        for source in &sources {
            helper.function.locals[*source].boxed = true;
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::Closure {
                fn_name: name,
                captures: sources
                    .iter()
                    .map(|source| helper.param(*source).id)
                    .collect(),
                r#type: result.clone(),
                loc: self.loc(node),
            }),
            loc: self.loc(node),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: result,
            loc: self.loc(node),
        }))
    }
}
