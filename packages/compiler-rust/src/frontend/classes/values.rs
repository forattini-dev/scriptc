//! Class value uses lower to portable typed IR operations.
use super::*;

impl Lowerer<'_> {
    pub(in crate::frontend) fn dynamic_class_new(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        if self.ty(node)? != Type::Dyn || !self.checker_any(node.expression()) {
            return Ok(None);
        }
        let callee = self.expression(node.expression())?;
        if callee.ty() != Type::Dyn {
            return Ok(None);
        }
        let arity = node.arguments().len();
        let arguments = self.method_arguments(node, &vec![Type::Dyn; arity])?;
        self.ensure_exception_classes(node)?;
        let mut types = vec![Type::Dyn, Type::String];
        types.extend(vec![Type::Dyn; arity]);
        let helper = helpers::Helper::new("dynamic_construct", types, Type::Dyn, self.loc(node));
        let name = self.install_helper(helper.function);
        if !self
            .dynamic_constructors
            .iter()
            .any(|(existing, _, _)| *existing == name)
        {
            self.dynamic_constructors.push((name.clone(), arity, node));
        }
        fn constructor_name(node: Node) -> String {
            match node.kind() {
                SyntaxKind::Identifier => node.text().into(),
                SyntaxKind::PropertyAccessExpression => format!(
                    "{}.{}",
                    constructor_name(node.expression()),
                    node.name().text()
                ),
                _ => "value".into(),
            }
        }
        let mut args = vec![
            callee,
            Expr::StrLit {
                value: format!(
                    "{} is not a constructor",
                    constructor_name(node.expression())
                ),
                r#type: Type::String,
                loc: self.loc(node),
            },
        ];
        args.extend(arguments);
        Ok(Some(Expr::Call {
            callee: name,
            args,
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn populate_dynamic_constructors(&mut self) -> Result<(), String> {
        let requests = self.dynamic_constructors.clone();
        for (name, arity, site) in requests {
            let mut types = vec![Type::Dyn, Type::String];
            types.extend(vec![Type::Dyn; arity]);
            let mut helper =
                helpers::Helper::new("dynamic_construct", types, Type::Dyn, self.loc(site));
            helper.function.name = name.clone();
            let constructor = helper.param(0);
            let candidates = self
                .classes
                .definitions
                .iter()
                .enumerate()
                .filter_map(|(index, class)| {
                    (!class.node.is_nil())
                        .then(|| {
                            class
                                .signature
                                .as_ref()
                                .map(|signature| (index, signature.clone()))
                        })
                        .flatten()
                })
                .collect::<Vec<_>>();
            for (index, params) in candidates {
                let class_name = self.classes.definitions[index].name.clone();
                let class_type = Type::Classval {
                    class_name: class_name.clone(),
                };
                let class = Expr::ClassRef {
                    class_name: class_name.clone(),
                    r#type: class_type.clone(),
                    loc: helper.loc(),
                };
                let Ok(identity) = self.coerce(class, Type::Dyn, site) else {
                    continue;
                };
                let result = self.classes.object(index);
                if self.dynamic_erasure_reason(&result).is_some() {
                    continue;
                }
                let mut arguments = Vec::new();
                let mut compatible = true;
                for (position, param) in params.iter().skip(1).enumerate() {
                    let source = if position < arity {
                        helper.read(&helper.param(position + 2))
                    } else {
                        Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: helper.loc(),
                        }
                    };
                    match self.coerce(source, param.r#type.clone(), site) {
                        Ok(value) => arguments.push(value),
                        Err(_) => {
                            compatible = false;
                            break;
                        }
                    }
                }
                if !compatible {
                    continue;
                }
                let callee = Expr::DynCheck {
                    value: Box::new(helper.read(&constructor)),
                    r#type: class_type,
                    loc: helper.loc(),
                };
                let value = Expr::NewValue {
                    callee: Box::new(callee),
                    args: arguments,
                    r#type: result,
                    loc: helper.loc(),
                };
                let value = self.coerce(value, Type::Dyn, site)?;
                helper.function.body.push(Stmt::If {
                    cond: Expr::DynScalarEq {
                        left: Box::new(helper.read(&constructor)),
                        right: Box::new(identity),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(value),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
            }
            let loc = helper.loc();
            let error = |message: Expr| Stmt::Throw {
                value: Expr::LibCall {
                    r#fn: "error.new".into(),
                    args: vec![message],
                    r#type: Type::Object {
                        class_name: "%TypeError".into(),
                    },
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            };
            helper.function.body.push(Stmt::If {
                cond: Expr::DynTest {
                    value: Box::new(helper.read(&constructor)),
                    test: "function".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![error(Expr::StrLit {
                    value: "scriptc: dynamic constructor has no represented native ABI".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                })],
                else_: None,
                loc: helper.loc(),
            });
            helper
                .function
                .body
                .push(error(helper.read(&helper.param(1))));
            let target = self
                .lifted
                .iter_mut()
                .find(|function| function.name == name)
                .expect("registered dynamic constructor helper");
            *target = helper.function;
        }
        Ok(())
    }

    fn class_ref(
        &mut self,
        index: usize,
        site: Node,
        prerequisite: Option<Expr>,
    ) -> Result<Expr, String> {
        self.request_constructor(index)?;
        let class_name = self.classes.definitions[index].name.clone();
        let ty = Type::Classval {
            class_name: class_name.clone(),
        };
        let value = Expr::ClassRef {
            class_name: class_name.clone(),
            r#type: ty.clone(),
            loc: self.loc(site),
        };
        let Some(prerequisite) = prerequisite else {
            return Ok(value);
        };
        let mut helper = helpers::Helper::new(
            &format!("class_{class_name}"),
            vec![prerequisite.ty()],
            ty.clone(),
            self.loc(site),
        );
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(site),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![prerequisite],
            r#type: ty,
            loc: self.loc(site),
        })
    }

    pub(in crate::frontend) fn class_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let symbol = self.symbol(node);
        let Some(index) = self.classes.symbols.get(&symbol).copied() else {
            return Ok(None);
        };
        // A class declaration's inner name is initialized while its static
        // fields run, even though the surrounding lexical binding is in TDZ.
        let mut ancestor = node.parent();
        while !ancestor.is_nil() && ancestor.kind() != SyntaxKind::SourceFile {
            if ancestor.kind() == SyntaxKind::PropertyDeclaration
                && ancestor.modifier_flags().intersects(ModifierFlags::STATIC)
                && ancestor.parent() == self.classes.definitions[index].node
            {
                return self.class_ref(index, node, None).map(Some);
            }
            ancestor = ancestor.parent();
        }
        let Some(token) = self.classes.definitions[index].token.clone() else {
            return Ok(None);
        };
        self.class_ref(index, node, Some(self.read_class_token(&token, node)))
            .map(Some)
    }

    pub(in crate::frontend) fn class_expression(&mut self, node: Node) -> Result<Expr, String> {
        let index = self
            .classes
            .definitions
            .iter()
            .position(|d| d.node == node)
            .ok_or_else(|| {
                self.refuse(
                    node,
                    "class expressions require a direct module initializer",
                )
            })?;
        self.resolve_class(index)?;
        let prerequisite = self.class_heritage_value(node)?;
        let mut stmts = Vec::new();
        if let Some(expr) = prerequisite {
            stmts.push(Stmt::Expression {
                expr,
                loc: self.loc(node),
            });
        }
        stmts.extend(self.initialize_private_storage(index, node)?);
        let value = self.class_ref(index, node, None)?;
        if stmts.is_empty() {
            return Ok(value);
        }
        let ty = value.ty();
        // Global initialization has one top-level statement owner in portable
        // IR. Execute this definition thunk at the original expression site.
        let mut helper = helpers::Helper::new(
            &format!("class_definition_{}", self.classes.definitions[index].name),
            vec![],
            ty.clone(),
            self.loc(node),
        );
        helper.function.body = stmts;
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(node),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![],
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn class_heritage_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        for clause in node.heritage_clauses().nodes() {
            if clause.token() != SyntaxKind::ExtendsKeyword {
                continue;
            }
            let expression = clause
                .types()
                .nodes()
                .into_iter()
                .next()
                .unwrap()
                .expression();
            let index = self
                .class_symbol(expression)
                .ok_or_else(|| self.refuse(expression, "unresolved class heritage"))?;
            if !self.classes.definitions[index].node.is_nil() {
                // A declaration's heritage only reads its lexical identity;
                // defining an unused subclass must not demand its base body.
                let symbol = self.symbol(expression);
                if self.classes.symbols.get(&symbol).copied() == Some(index)
                    && let Some(token) = self.classes.definitions[index].token.clone()
                {
                    return Ok(Some(self.read_class_token(&token, expression)));
                }
                let value = self.expression(expression)?;
                if !matches!(value.ty(), Type::Classval { .. }) {
                    return Err(self.refuse(expression, "class heritage may be undefined"));
                }
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

    pub(super) fn read_class_token(&self, token: &Local, site: Node) -> Expr {
        Expr::VarRef {
            local_id: token.id.clone(),
            r#type: Type::F64,
            loc: self.loc(site),
        }
    }

    pub(in crate::frontend) fn class_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(index) = self.class_symbol(node.expression()) else {
            return self.union_class_new(node);
        };
        if let Some(name) = boxed::kind(&self.classes.definitions[index].name) {
            return self.boxed_new(node, index, name).map(Some);
        }
        if self.classes.definitions[index].name == weak_sets::CLASS {
            return self.weak_set_new(node, index).map(Some);
        }
        if self.classes.definitions[index].name == weak_maps::CLASS {
            if !node.arguments().is_empty() {
                return Err(self.refuse(node, "WeakMap constructor iterables are not ported"));
            }
            self.request_constructor(index)?;
            return Ok(Some(Expr::New {
                class_name: weak_maps::CLASS.into(),
                args: vec![],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index].name == async_context::CLASS {
            if !node.arguments().is_empty() {
                return Err(
                    self.refuse(node, "AsyncLocalStorage constructor options are not ported")
                );
            }
            self.request_constructor(index)?;
            return Ok(Some(Expr::New {
                class_name: async_context::CLASS.into(),
                args: vec![],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index]
            .name
            .starts_with("native_builtin_Text")
        {
            if !node.arguments().is_empty() {
                return Err(self.refuse(
                    node,
                    "text codec constructor arguments/options are not ported",
                ));
            }
            self.request_constructor(index)?;
            return Ok(Some(Expr::New {
                class_name: self.classes.definitions[index].name.clone(),
                args: vec![],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index].node.is_nil() {
            let message = self.error_message(node)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "error.new".into(),
                args: vec![message],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        let callee = self.expression(node.expression())?;
        let expected = Type::Classval {
            class_name: self.classes.definitions[index].name.clone(),
        };
        if callee.ty() != expected {
            return Err(self.refuse(
                node,
                "constructor value may be undefined or has a different identity",
            ));
        }
        let params = self.request_constructor(index)?;
        let types = params
            .into_iter()
            .skip(1)
            .map(|p| p.r#type)
            .collect::<Vec<_>>();
        let args = self.method_arguments(node, &types)?;
        let result = self.classes.object(index);
        Ok(Some(Expr::NewValue {
            callee: Box::new(callee),
            args,
            r#type: result,
            loc: self.loc(node),
        }))
    }

    fn union_class_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let checked = self.checker.get_type_at_location(node.expression());
        if !self.checker.ty(checked).flags.intersects(TypeFlags::UNION) {
            return Ok(None);
        }
        let callee = self.expression(node.expression())?;
        let Type::Union { union_id } = callee.ty() else {
            return Ok(None);
        };
        let arms = self.unions[union_id].arms.clone();
        if arms.len() < 2 || !arms.iter().all(|arm| matches!(arm, Type::Classval { .. })) {
            return Ok(None);
        }
        let checked_result = self.checker.get_type_at_location(node);
        let result = match self.ty(node) {
            Ok(result @ Type::Object { .. }) => result,
            Err(error) if self.checker.ty(checked_result).flags.intersects(TypeFlags::UNION) => {
                let result_arms = self.checker.ty(checked_result).types().to_vec();
                let mut instances = Vec::new();
                for source in result_arms {
                    let Some(Type::Object { class_name }) = self.type_id(source) else {
                        return Err(error);
                    };
                    instances.push(class_name);
                }
                if instances.len() != arms.len() || !arms.iter().all(|arm| {
                    matches!(arm, Type::Classval { class_name } if instances.contains(class_name))
                }) {
                    return Err(error);
                }
                Type::Dyn
            }
            _ => return Err(self.refuse(node, "constructor union requires represented native instances")),
        };
        let mut classes = Vec::new();
        let mut common: Option<Vec<Type>> = None;
        for arm in &arms {
            let Type::Classval { class_name } = arm else {
                unreachable!()
            };
            let index = self
                .classes
                .definitions
                .iter()
                .position(|d| d.name == *class_name)
                .ok_or_else(|| {
                    self.refuse(node, "constructor union has no native class identity")
                })?;
            self.resolve_class(index)?;
            if let Type::Object { class_name: parent } = &result
                && !self.classes.subclass(class_name, parent)
            {
                return Err(self.refuse(
                    node,
                    "constructor union instances need a shared native class hierarchy",
                ));
            }
            let params = self
                .request_constructor(index)?
                .into_iter()
                .skip(1)
                .map(|param| param.r#type)
                .collect::<Vec<_>>();
            if let Some(expected) = &common {
                let (shorter, longer) = if params.len() < expected.len() {
                    (&params, expected)
                } else {
                    (expected, &params)
                };
                if shorter.iter().ne(longer.iter().take(shorter.len()))
                    || longer.iter().skip(shorter.len()).any(|ty| {
                        *ty != Type::Dyn && !matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
                    })
                {
                    return Err(self.refuse(node, "constructor union argument contracts differ"));
                }
            }
            if common.as_ref().is_none_or(|expected| params.len() > expected.len()) {
                common = Some(params.clone());
            }
            classes.push((index, params.len()));
        }
        let params = common.unwrap();
        let arguments = self.method_arguments(node, &params)?;
        // Keep a dynamic property value intact until after argument evaluation:
        // JavaScript evaluates arguments before checking constructibility.
        let (callee, dynamic) = match callee {
            Expr::DynCheck { value, r#type, .. }
                if r#type == (Type::Union { union_id }) => (*value, true),
            value => (value, false),
        };
        let mut helper_types = vec![callee.ty()];
        helper_types.extend(params);
        let mut helper = helpers::Helper::new(
            "class_union_new",
            helper_types,
            result.clone(),
            self.loc(node),
        );
        let constructor = helper.param(0);
        let selected_value = if dynamic {
            Expr::DynCheck {
                value: Box::new(helper.read(&constructor)),
                r#type: Type::Union { union_id },
                loc: helper.loc(),
            }
        } else {
            helper.read(&constructor)
        };
        for (tag, (arm, (index, arity))) in arms.iter().zip(classes).enumerate() {
            let selected = Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(selected_value.clone()),
                r#type: arm.clone(),
                loc: helper.loc(),
            };
            let values = (1..=arity)
                .map(|i| helper.read(&helper.param(i)))
                .collect();
            let instance = Expr::NewValue {
                callee: Box::new(selected),
                args: values,
                r#type: self.classes.object(index),
                loc: helper.loc(),
            };
            let instance = self.coerce(instance, result.clone(), node)?;
            let ret = Stmt::Return {
                value: Some(instance),
                loc: helper.loc(),
            };
            if tag + 1 == arms.len() {
                helper.function.body.push(ret);
            } else {
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(selected_value.clone()),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![ret],
                    else_: None,
                    loc: helper.loc(),
                });
            }
        }
        let mut args = vec![callee];
        args.extend(arguments);
        Ok(Some(Expr::Call {
            callee: self.install_helper(helper.function),
            args,
            r#type: result,
            loc: self.loc(node),
        }))
    }

    pub(super) fn error_message(&mut self, node: Node) -> Result<Expr, String> {
        if node.arguments().len() > 1 {
            return Err(self.refuse(node, "Error options/cause are not ported"));
        }
        let value = node
            .arguments()
            .into_iter()
            .next()
            .map(|n| self.expression(n))
            .transpose()?;
        self.message_value(value, node)
    }
    pub(super) fn message_value(
        &mut self,
        value: Option<Expr>,
        node: Node,
    ) -> Result<Expr, String> {
        let empty = || Expr::StrLit {
            value: String::new(),
            r#type: Type::String,
            loc: self.loc(node),
        };
        match value {
            None
            | Some(Expr::UnitLit {
                r#type: Type::Undefined,
                ..
            }) => Ok(empty()),
            Some(value) if value.ty() == Type::String => Ok(value),
            Some(value) => {
                let Type::Union { union_id } = value.ty() else {
                    return Err(self.refuse(node, "Error message string conversion is not ported"));
                };
                let arms = &self.unions[union_id].arms;
                if arms.len() != 2
                    || !arms.contains(&Type::String)
                    || !arms.contains(&Type::Undefined)
                {
                    return Err(self.refuse(node, "Error message type is not ported"));
                }
                let mut helper = helpers::Helper::new(
                    "error_message",
                    vec![value.ty()],
                    Type::String,
                    self.loc(node),
                );
                let tag = arms.iter().position(|a| *a == Type::String).unwrap();
                helper.function.body.push(Stmt::Return {
                    value: Some(Expr::Ternary {
                        cond: Box::new(Expr::UnionIsTag {
                            union_id: format!("u{union_id}"),
                            tag,
                            negated: false,
                            value: Box::new(helper.read(&helper.param(0))),
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        then: Box::new(Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(helper.read(&helper.param(0))),
                            r#type: Type::String,
                            loc: helper.loc(),
                        }),
                        else_: Box::new(empty()),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                });
                let callee = self.install_helper(helper.function);
                Ok(Expr::Call {
                    callee,
                    args: vec![value],
                    r#type: Type::String,
                    loc: self.loc(node),
                })
            }
        }
    }

    pub(in crate::frontend) fn static_initializer_this(&self, node: Node) -> Option<Expr> {
        let mut ancestor = node.parent();
        while !ancestor.is_nil() && ancestor.kind() != SyntaxKind::SourceFile {
            if matches!(
                ancestor.kind(),
                SyntaxKind::FunctionExpression | SyntaxKind::FunctionDeclaration
                    | SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
            ) {
                return None;
            }
            if ancestor.kind() == SyntaxKind::PropertyDeclaration
                && ancestor.modifier_flags().intersects(ModifierFlags::STATIC)
                && let Some(definition) = self.classes.definitions.iter()
                    .find(|definition| definition.node == ancestor.parent())
            {
                return Some(Expr::ClassRef {
                    class_name: definition.name.clone(),
                    r#type: Type::Classval { class_name: definition.name.clone() },
                    loc: self.loc(node),
                });
            }
            ancestor = ancestor.parent();
        }
        None
    }

    pub(in crate::frontend) fn this_expression(&self, node: Node) -> Result<Expr, String> {
        if self.instance_this.is_none()
            && let Some(value) = self.static_initializer_this(node)
        {
            return Ok(value);
        }
        let local = self.instance_this.as_ref().ok_or_else(|| {
            self.refuse(
                node,
                "this before super or outside a represented instance body is not ported",
            )
        })?;
        Ok(Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        })
    }

    pub(super) fn field_type(&self, class: &str, field: &str) -> Option<Type> {
        self.classes
            .layouts
            .iter()
            .flatten()
            .find(|c| c.name == class)?
            .fields
            .iter()
            .find(|f| f.name == field)
            .map(|f| f.r#type.clone())
    }

    pub(in crate::frontend) fn class_index_get(
        &mut self,
        node: Node,
        obj: Expr,
    ) -> Result<Expr, String> {
        let Type::Object { class_name } = obj.ty() else {
            unreachable!()
        };
        if class_name == weak_maps::CLASS
            || class_name == weak_sets::CLASS
            || class_name == async_context::CLASS
        {
            return Err(self.refuse(node, "builtin class indexed properties are not ported"));
        }
        let key = node.argument_expression();
        if key.kind() != SyntaxKind::StringLiteral {
            return Err(self.refuse(
                node,
                "indexed class reads require a literal public data key",
            ));
        }
        let field = key.text().to_string();
        let ty = self.field_type(&class_name, &field).ok_or_else(|| {
            self.refuse(
                node,
                "indexed class reads require a represented public data slot",
            )
        })?;
        let value = Expr::FieldGet {
            obj: Box::new(obj),
            class_name,
            field,
            r#type: ty,
            loc: self.loc(node),
        };
        self.narrowed(value, node)
    }

    pub(in crate::frontend) fn class_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.name().kind() == SyntaxKind::PrivateIdentifier {
            return self.private_get(node).map(Some);
        }
        // Probe the type without lowering the receiver twice (calls can enqueue helpers).
        let ty = if matches!(
            node.expression().kind(),
            SyntaxKind::ThisKeyword | SyntaxKind::SuperKeyword
        ) {
            self.instance_this.as_ref().map(|l| l.r#type.clone())
        } else {
            self.ty(node.expression()).ok()
        };
        if !matches!(ty, Some(Type::Object { .. })) {
            return Ok(None);
        }
        let obj = if node.expression().kind() == SyntaxKind::SuperKeyword {
            self.this_expression(node.expression())?
        } else {
            self.expression(node.expression())?
        };
        let Type::Object { class_name } = obj.ty() else {
            return Err(self.refuse(node, "class receiver has no object representation"));
        };
        let field = node.name().text().to_string();
        if class_name == weak_maps::CLASS || class_name == weak_sets::CLASS {
            return Err(self.refuse(
                node,
                "weak collection property access and extracted methods are not ported",
            ));
        }
        if class_name == async_context::CLASS {
            return Err(self.refuse(
                node,
                "AsyncLocalStorage property reads and extracted methods are not ported",
            ));
        }
        let index = self
            .classes
            .definitions
            .iter()
            .position(|d| d.name == class_name)
            .ok_or_else(|| self.refuse(node, "class property has no source descriptor"))?;
        let lookup = if node.expression().kind() == SyntaxKind::SuperKeyword {
            self.classes.definitions[index].base.ok_or_else(|| {
                self.refuse(node, "super property requires a derived instance body")
            })?
        } else {
            index
        };
        if self.classes.accessor(lookup, &field).is_some() {
            let value = self.accessor_call(node, obj, &field, None)?.unwrap();
            return Ok(Some(self.narrowed(value, node)?));
        }
        if node.expression().kind() == SyntaxKind::SuperKeyword {
            return Err(self.refuse(
                node,
                "super data-property reads require prototype descriptors",
            ));
        }
        let ty = self
            .field_type(&class_name, &field)
            .ok_or_else(|| self.refuse(node, "class property is not ported"))?;
        let value = Expr::FieldGet {
            obj: Box::new(obj),
            class_name: class_name.clone(),
            field: field.clone(),
            r#type: ty,
            loc: self.loc(node),
        };
        if self.checker_any(node)
            && let Some(class) = self
                .classes
                .definitions
                .iter()
                .find(|class| class.name == class_name)
            && let Some(target) = self
                .class_contract(class.node)
                .and_then(|hint| hint.fields.iter().find(|(name, _)| *name == field))
                .and_then(|(_, ty)| ty.clone())
        {
            if value.ty() == target {
                return Ok(Some(value));
            }
            // A public JS declaration supplies a contract, not checker-local
            // inference for the implementation. Verify extraction from storage.
            let value = self.coerce(value, Type::Dyn, node)?;
            return Ok(Some(self.coerce(value, target, node)?));
        }
        Ok(Some(self.narrowed(value, node)?))
    }

    pub(in crate::frontend) fn class_set(&mut self, node: Node) -> Result<Option<Stmt>, String> {
        if node.left().name().kind() == SyntaxKind::PrivateIdentifier {
            let expr = self.private_assignment(node)?;
            return Ok(Some(Stmt::Expression {
                expr,
                loc: self.loc(node),
            }));
        }
        if let Some(expr) = self.class_accessor_assignment(node)? {
            return Ok(Some(Stmt::Expression {
                expr,
                loc: self.loc(node),
            }));
        }
        let member = node.left();
        let ty = if member.expression().kind() == SyntaxKind::ThisKeyword {
            self.instance_this.as_ref().map(|l| l.r#type.clone())
        } else {
            self.ty(member.expression()).ok()
        };
        if !matches!(ty, Some(Type::Object { .. })) {
            return Ok(None);
        }
        let obj = self.expression(member.expression())?;
        let Type::Object { class_name } = obj.ty() else {
            return Err(self.refuse(node, "class write needs an object"));
        };
        let field = member.name().text().to_string();
        if class_name == weak_maps::CLASS || class_name == weak_sets::CLASS {
            return Err(self.refuse(
                node,
                "weak collection property access and extracted methods are not ported",
            ));
        }
        if class_name == async_context::CLASS {
            return Err(self.refuse(node, "AsyncLocalStorage property writes are not ported"));
        }
        let ty = self
            .field_type(&class_name, &field)
            .ok_or_else(|| self.refuse(node, "class property write is not ported"))?;
        let value = self.expected_expression(node.right(), ty)?;
        Ok(Some(Stmt::FieldSet {
            obj,
            class_name,
            field,
            value,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn class_instanceof(&mut self, node: Node) -> Result<Expr, String> {
        let value = if node.left().kind() == SyntaxKind::Identifier
            && let Ok(local) = self.binding(node.left())
            && local.r#type == Type::Caught
        {
            Expr::VarRef {
                local_id: local.id,
                r#type: Type::Caught,
                loc: self.loc(node.left()),
            }
        } else {
            self.expression(node.left())?
        };
        let index = self
            .class_symbol(node.right())
            .ok_or_else(|| self.refuse(node, "instanceof needs a resolved class"))?;
        self.layout_class(index)?;
        let class_name = self.classes.definitions[index].name.clone();
        let direct = matches!(value.ty(), Type::Object { class_name: left } if self.classes.hierarchy(&left) && self.classes.hierarchy(&class_name));
        let value = if weak_sets::instance(&value.ty()) {
            // Brand observation does not expose the collection's descriptors.
            // Keep the shared dyn.classInstanceof contract for nominal roots.
            Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node.left()),
            }
        } else if value.ty() == Type::Caught || direct {
            value
        } else {
            self.coerce(value, Type::Dyn, node.left())?
        };
        let intrinsic = if self.classes.subclass(&class_name, "%Error") {
            "dyn.errInstanceof"
        } else {
            "dyn.classInstanceof"
        };
        let test = |value: Expr, loc: Loc| {
            if value.ty() == Type::Caught {
                Expr::CaughtTest {
                    value: Box::new(value),
                    test: "instanceof".into(),
                    class_name: class_name.clone(),
                    r#type: Type::Bool,
                    loc,
                }
            } else if value.ty() == Type::Dyn {
                Expr::LibCall {
                    r#fn: intrinsic.into(),
                    args: vec![
                        value,
                        Expr::StrLit {
                            value: class_name.clone(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        },
                    ],
                    r#type: Type::Bool,
                    loc,
                }
            } else {
                Expr::InstanceOf {
                    value: Box::new(value),
                    class_name: class_name.clone(),
                    r#type: Type::Bool,
                    loc,
                }
            }
        };
        if !self.classes.definitions[index].node.is_nil() {
            let constructor = self.expression(node.right())?;
            if !matches!(constructor.ty(), Type::Classval { .. }) {
                return Err(self.refuse(node.right(), "instanceof constructor may be undefined"));
            }
            let value = if value.ty() == Type::Caught {
                test(value, self.loc(node))
            } else {
                value
            };
            let mut helper = helpers::Helper::new(
                &format!("instanceof_{class_name}"),
                vec![value.ty(), constructor.ty()],
                Type::Bool,
                self.loc(node),
            );
            helper.function.body.push(Stmt::Return {
                value: Some(if value.ty() == Type::Bool {
                    helper.read(&helper.param(0))
                } else {
                    test(helper.read(&helper.param(0)), helper.loc())
                }),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            Ok(Expr::Call {
                callee,
                args: vec![value, constructor],
                r#type: Type::Bool,
                loc: self.loc(node),
            })
        } else {
            Ok(test(value, self.loc(node)))
        }
    }

    pub(in crate::frontend) fn error_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "toString"
        {
            return Ok(None);
        }
        if !matches!(self.ty(member.expression()), Ok(Type::Object { .. })) {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "Error.toString takes no arguments"));
        }
        let value = self.expression(member.expression())?;
        let value = self.coerce(
            value,
            Type::Object {
                class_name: "%Error".into(),
            },
            node,
        )?;
        Ok(Some(Expr::LibCall {
            r#fn: "error.toString".into(),
            args: vec![value],
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }
}
