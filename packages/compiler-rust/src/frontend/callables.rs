//! Callable data objects use a private function slot in an owned record layout.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

mod contracts;

pub(super) const CALL_FIELD: &str = "\0scriptc.call";

impl Lowerer<'_> {
    pub(super) fn callable_type(&mut self, id: TypeId) -> Option<Type> {
        let signatures = self
            .checker
            .get_signatures_of_type(id, source_frontend::prelude::SignatureKind::CALL);
        let properties = self.checker.get_properties_of_type(id).to_vec();
        if signatures.len() != 1 || !self.checker.sig(signatures[0]).type_parameters.is_empty() {
            return if properties.is_empty() {
                self.erased_function_type(id)
            } else {
                self.polymorphic_callable_type(id)
            };
        }
        // A source function declaration owns its properties independently of
        // its callable ABI. Structural callable interfaces retain their record
        // contract; expando declarations must keep the original function identity.
        let symbol = self.checker.ty(id).symbol();
        let source_function = symbol.0 != 0
            && !self.checker.sym(symbol).value_declaration.is_nil()
            && self.checker.sym(symbol).value_declaration.kind() == SyntaxKind::FunctionDeclaration;
        if properties.is_empty() || source_function {
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
        self.types.insert(
            id,
            type_graph::Resolution::Resolving {
                kind: type_graph::LayoutKind::Record,
                reference: Some(result.clone()),
            },
        );
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
                Type::Func { params, ret, .. } => {
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
            self.types
                .insert(id, type_graph::Resolution::Ready(result.clone()));
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
        self.callable_assign_expected(node, None)
    }
    pub(super) fn callable_assign_expected(
        &mut self,
        node: Node,
        expected: Option<Type>,
    ) -> Result<Option<Expr>, String> {
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
        let contextual = expected.as_ref().and_then(|ty| match ty {
            Type::Record { shape_id } => self.callables.get(shape_id).cloned(),
            _ => None,
        });
        let target =
            if let Some(signature) = contextual.filter(|_| self.fresh_function(arguments[0])) {
                self.expected_expression(arguments[0], signature)?
            } else {
                self.expression(arguments[0])?
            };
        let (ty, create) = match target.ty() {
            Type::Func { .. } => {
                if !self.fresh_function(arguments[0]) {
                    return Err(self.refuse(
                        arguments[0],
                        "decorating an escaped bare function requires a shared property identity",
                    ));
                }
                let ty = if let Some(ty) = expected {
                    ty
                } else {
                    self.ty(node)?
                };
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
        self.function_bind_expected(node, None)
    }
    pub(super) fn owning_bind_type(&mut self, node: Node) -> Option<Type> {
        if node.kind() != SyntaxKind::CallExpression {
            return None;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression || member.name().text() != "bind" {
            return None;
        }
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, "bind", Some("Function"))
            && !self.primitive_symbol(symbol, "bind", Some("CallableFunction"))
            && !self.primitive_symbol(symbol, "bind", Some("NewableFunction"))
        {
            return None;
        }
        let source = receivers::reference_node(member.expression());
        let symbol = if source.kind() == SyntaxKind::Identifier {
            self.symbol(source)
        } else {
            0
        };
        let ty = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .map(|local| local.r#type.clone())
            .or_else(|| {
                let source = self.checker.get_type_at_location(source);
                self.type_id(source)
            })?;
        parameters::erased_rest(&ty).then_some(ty)
    }
    pub(super) fn function_bind_expected(
        &mut self,
        node: Node,
        expected: Option<Type>,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression || member.name().text() != "bind" {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let source_type = self.checker.get_type_at_location(member.expression());
        let owning_rest = self.owning_bind_type(node).is_some();
        let value = if owning_rest
            || self.regex_callable_type(source_type).is_some()
            || self.number_predicate_type(source_type).is_some()
        {
            // Keep the standard method's owning argument and receiver ABI
            // instead of replacing it with the checker's contextual signature.
            self.expression(member.expression())?
        } else if let Some(Type::Func { params, ret, rest }) = expected {
            let prefix = arguments.len().saturating_sub(1);
            let mut slots = Vec::new();
            for argument in arguments.iter().skip(1).take(prefix) {
                let symbol = self.symbol(*argument);
                let ty = self
                    .bindings
                    .get(&symbol)
                    .or_else(|| self.module_bindings.get(&symbol))
                    .map(|l| l.r#type.clone())
                    .or_else(|| self.ty(*argument).ok())
                    .unwrap_or(Type::Dyn);
                slots.push(ty);
            }
            slots.extend(params);
            self.expected_expression(
                member.expression(),
                Type::Func {
                    rest,
                    params: slots,
                    ret,
                },
            )?
        } else {
            self.expression(member.expression())?
        };
        let target = self.callable_body(value, node)?;
        let Type::Func { params, ret, rest } = target.ty() else {
            return Err(self.refuse(member, "bind requires a native function"));
        };
        let erased_rest = parameters::erased_rest(&target.ty());

        if arguments.is_empty()
            || (!erased_rest
                && arguments.len() - 1 > params.len().saturating_sub(usize::from(rest)))
        {
            return Err(self.refuse(
                node,
                "bind needs a this argument and a fixed prefix before the rest array",
            ));
        }
        let this = self.expected_expression(arguments[0], Type::Dyn)?;
        let mut values = vec![target, this];
        let prefix_start = values.len();
        for (index, argument) in arguments.iter().skip(1).enumerate() {
            let ty = if erased_rest {
                Type::Dyn
            } else {
                params[index].clone()
            };
            values.push(self.expected_expression(*argument, ty)?);
        }
        // An owning rest vector is transport, not one source argument slot.
        // Bound values prepend to that vector; the result keeps its complete ABI.
        let prefix = if erased_rest { 0 } else { arguments.len() - 1 };
        let result = Type::Func {
            rest,
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
        let sources = (0..values.len()).collect::<Vec<_>>();
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
        body.function.rest = rest;
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
        let mut args = captures
            .iter()
            .skip(2)
            .map(read)
            .chain(body.function.params.iter().map(read))
            .collect::<Vec<_>>();
        let rest_arg = rest.then(|| args.pop().expect("rest argument"));
        let array = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let list = body.local("bound arguments", array.clone(), false);
        let elems = args
            .into_iter()
            .map(|arg| self.coerce(arg, Type::Dyn, node))
            .collect::<Result<Vec<_>, _>>()?;
        body.declare(
            &list,
            Expr::ArrayLit {
                elems,
                r#type: array,
                loc: self.loc(node),
            },
        );
        if let Some(rest_arg) = rest_arg {
            let Type::Array { elem } = rest_arg.ty() else {
                unreachable!("rest ABI");
            };
            let source = body.local("bound rest", rest_arg.ty(), false);
            body.declare(&source, rest_arg);
            let index = body.local("bound rest index", Type::F64, true);
            body.declare(&index, body.number(0.0));
            let item = self.coerce(body.get(&source, &index, *elem), Type::Dyn, node)?;
            body.function.body.push(Stmt::While {
                cond: body.less(&index, body.length(&source)),
                body: vec![
                    Stmt::Expression {
                        expr: Expr::ArrayIntrinsic {
                            method: "push".into(),
                            receiver: Box::new(body.read(&list)),
                            args: vec![item],
                            r#type: Type::F64,
                            loc: self.loc(node),
                        },
                        loc: self.loc(node),
                    },
                    body.advance(&index),
                ],
                loc: self.loc(node),
            });
        }
        let call = Expr::DynInvoke {
            recv: Box::new(self.coerce(read(&captures[0]), Type::Dyn, node)?),
            method: "apply".into(),
            callee_name: "bound function".into(),
            args: vec![
                read(&captures[1]),
                self.coerce(body.read(&list), Type::Dyn, node)?,
            ],
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        let call = if *ret == Type::Void {
            call
        } else {
            self.coerce(call, (*ret).clone(), node)?
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
