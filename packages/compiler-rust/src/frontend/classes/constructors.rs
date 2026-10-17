//! Constructor ABIs, super calls and instance initialization order.
use super::*;

impl Lowerer<'_> {
    pub(super) fn request_constructor(&mut self, index: usize) -> Result<Vec<Param>, String> {
        self.layout_class(index)?;
        if let Some(params) = &self.classes.definitions[index].signature {
            return Ok(params.clone());
        }
        let definition = self.classes.definitions[index].clone();
        let constructors = definition
            .node
            .members()
            .into_iter()
            .filter(|m| m.kind() == SyntaxKind::Constructor)
            .collect::<Vec<_>>();
        if constructors.len() > 1 {
            return Err(self.refuse(definition.node, "constructor overloads are not ported"));
        }
        let mut params = vec![Param {
            local_id: "p0".into(),
            name: "this".into(),
            r#type: self.classes.object(index),
        }];
        if let Some(ctor) = constructors.first() {
            if ctor.body().is_nil() {
                return Err(self.refuse(*ctor, "constructor body is required"));
            }
            for (i, node) in ctor.parameters().into_iter().enumerate() {
                if node.name().kind() != SyntaxKind::Identifier
                    || !node.dot_dot_dot_token().is_nil()
                    || node.modifier_flags().intersects(
                        ModifierFlags::PUBLIC
                            | ModifierFlags::PRIVATE
                            | ModifierFlags::PROTECTED
                            | ModifierFlags::READONLY,
                    )
                {
                    return Err(self.refuse(
                        node,
                        "constructor rest and parameter properties are not ported",
                    ));
                }
                let ty = if let Some(hint) = self.class_contract(definition.node) {
                    if hint.params.len() != ctor.parameters().len() {
                        return Err(self.refuse(
                            *ctor,
                            "public class constructor/implementation arity differs",
                        ));
                    }
                    hint.params[i].clone().ok_or_else(|| {
                        self.refuse(node, "public class parameter has no native representation")
                    })?
                } else {
                    self.storage_type(node.name())?
                };
                params.push(Param {
                    local_id: format!("p{}", i + 1),
                    name: node.name().text().into(),
                    r#type: self.parameter_type(node, ty)?,
                });
            }
        } else if let Some(base) = definition.base {
            if self.classes.definitions[base].node.is_nil() {
                let ty = self
                    .intern_union(vec![Type::String, Type::Undefined])
                    .unwrap();
                params.push(Param {
                    local_id: "p1".into(),
                    name: "message".into(),
                    r#type: ty,
                });
            } else {
                let base = self.request_constructor(base)?;
                params.extend(base.into_iter().skip(1));
            }
        }
        self.classes.definitions[index].signature = Some(params.clone());
        self.classes.pending.push_back(index);
        Ok(params)
    }

    fn super_call(&mut self, index: usize, args: Vec<Expr>, site: Node) -> Result<Stmt, String> {
        let base = self.classes.definitions[index].base.unwrap();
        let this_ty = self.classes.object(index);
        let obj = Expr::VarRef {
            local_id: "p0".into(),
            r#type: this_ty,
            loc: self.loc(site),
        };
        let obj = self.coerce(obj, self.classes.object(base), site)?;
        let expr = if self.classes.definitions[base].node.is_nil() {
            if args.len() > 1 {
                return Err(self.refuse(site, "Error options/cause are not ported"));
            }
            let message = self.message_value(args.into_iter().next(), site)?;
            Expr::LibCall {
                r#fn: "error.ctor".into(),
                args: vec![obj, message],
                r#type: Type::Void,
                loc: self.loc(site),
            }
        } else {
            Expr::Call {
                callee: format!("%{}.constructor", self.classes.definitions[base].name),
                args: std::iter::once(obj).chain(args).collect(),
                r#type: Type::Void,
                loc: self.loc(site),
            }
        };
        Ok(Stmt::Expression {
            expr,
            loc: self.loc(site),
        })
    }

    fn initialize_fields(&mut self, index: usize) -> Result<Vec<Stmt>, String> {
        let mut body = Vec::new();
        for field in self.classes.definitions[index].node.members() {
            if field.kind() != SyntaxKind::PropertyDeclaration {
                continue;
            }
            if field.modifier_flags().intersects(ModifierFlags::AMBIENT) {
                continue;
            }
            let class_name = self.classes.definitions[index].name.clone();
            let ty = self.field_type(&class_name, field.name().text()).unwrap();
            let value = if field.initializer().is_nil() {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(field),
                    },
                    ty,
                    field,
                )?
            } else {
                self.expected_expression(field.initializer(), ty)?
            };
            body.push(Stmt::FieldSet {
                obj: self.this_expression(field)?,
                class_name,
                field: field.name().text().into(),
                value,
                loc: self.loc(field),
            });
        }
        Ok(body)
    }

    pub(in crate::frontend) fn lower_constructor(
        &mut self,
        index: usize,
    ) -> Result<Function, String> {
        let definition = self.classes.definitions[index].clone();
        self.file = definition.file.clone();
        self.locals.clear();
        self.bindings.clear();
        self.captures.clear();
        self.constructor_this = None;
        self.return_type = Some(Type::Void);
        self.var_types = self.module_vars.clone();
        self.var_defined.clear();
        let params = definition.signature.clone().unwrap();
        self.bind_parameter(None, &params[0])?;
        let this = self.locals[0].clone();
        let ctor = definition
            .node
            .members()
            .into_iter()
            .find(|m| m.kind() == SyntaxKind::Constructor);
        let base = definition.base;
        let mut body = Vec::new();
        // Base fields run before parameter defaults. Derived fields run after
        // the successful super call, before the following body statement.
        if base.is_none() {
            self.constructor_this = Some(this.clone());
            body.extend(self.initialize_fields(index)?);
        }
        if let Some(ctor) = ctor {
            fn has_return(node: Node) -> bool {
                if node.kind() == SyntaxKind::ReturnStatement {
                    return true;
                }
                if matches!(
                    node.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::ClassDeclaration
                        | SyntaxKind::ClassExpression
                ) {
                    return false;
                }
                let mut found = false;
                node.for_each_child(&mut |child| {
                    found |= has_return(child);
                    found
                });
                found
            }
            if has_return(ctor.body()) {
                return Err(self.refuse(ctor, "constructor early returns are not ported"));
            }
            for (node, param) in ctor.parameters().into_iter().zip(params.iter().skip(1)) {
                body.extend(self.bind_parameter(Some(node), param)?);
            }
            body.extend(self.hoist_local_vars(ctor.body())?);
            let mut super_seen = false;
            for statement in ctor.body().statements() {
                let call = if statement.kind() == SyntaxKind::ExpressionStatement {
                    statement.expression()
                } else {
                    Node::NIL
                };
                if !call.is_nil()
                    && call.kind() == SyntaxKind::CallExpression
                    && call.expression().kind() == SyntaxKind::SuperKeyword
                {
                    if super_seen {
                        return Err(self.refuse(call, "multiple super calls are not ported"));
                    }
                    let base =
                        base.ok_or_else(|| self.refuse(call, "super requires a derived class"))?;
                    let args = if self.classes.definitions[base].node.is_nil() {
                        call.arguments()
                            .into_iter()
                            .map(|n| self.expression(n))
                            .collect::<Result<Vec<_>, _>>()?
                    } else {
                        let types = self
                            .request_constructor(base)?
                            .into_iter()
                            .skip(1)
                            .map(|p| p.r#type)
                            .collect::<Vec<_>>();
                        self.call_arguments(call, &types)?
                    };
                    body.push(self.super_call(index, args, call)?);
                    self.constructor_this = Some(this.clone());
                    body.extend(self.initialize_fields(index)?);
                    super_seen = true;
                } else {
                    if statement.kind() == SyntaxKind::ReturnStatement {
                        return Err(
                            self.refuse(statement, "constructor early returns are not ported")
                        );
                    }
                    body.extend(self.statement(statement)?);
                }
            }
            if base.is_some() && !super_seen {
                return Err(self.refuse(ctor, "constructor requires one unconditional super call"));
            }
        } else if let Some(base) = base {
            for param in params.iter().skip(1) {
                self.bind_parameter(None, param)?;
            }
            if !self.classes.definitions[base].node.is_nil() {
                self.request_constructor(base)?;
            }
            let args = params
                .iter()
                .skip(1)
                .map(|p| Expr::VarRef {
                    local_id: p.local_id.clone(),
                    r#type: p.r#type.clone(),
                    loc: self.loc(definition.node),
                })
                .collect();
            body.push(self.super_call(index, args, definition.node)?);
            self.constructor_this = Some(this);
            body.extend(self.initialize_fields(index)?);
        }
        self.constructor_this = None;
        Ok(Function {
            name: format!("%{}.constructor", definition.name),
            params,
            captures: None,
            return_type: Type::Void,
            locals: std::mem::take(&mut self.locals),
            body,
            loc: self.loc(definition.node),
        })
    }
}
