//! Class value uses lower to portable typed IR operations.
use super::*;

impl Lowerer<'_> {
    pub(in crate::frontend) fn error_capture_stack_trace_constructor(
        &mut self,
        node: Node,
    ) -> bool {
        let Some(index) = self.class_symbol(node) else {
            return false;
        };
        self.classes.definitions[index].name == "%Error"
    }

    pub(in crate::frontend) fn lexical_class_index(&self, node: Node) -> Option<usize> {
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let mut ancestor = node.parent();
        while !ancestor.is_nil() && ancestor.kind() != SyntaxKind::SourceFile {
            if matches!(
                ancestor.kind(),
                SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
            ) && !ancestor.name().is_nil()
                && ancestor.name().text() == node.text()
            {
                if let Some(Type::Object { class_name }) = self
                    .instance_this
                    .as_ref()
                    .map(|local| local.r#type.clone())
                    && let Some(index) = self
                        .classes
                        .definitions
                        .iter()
                        .position(|definition| definition.name == class_name)
                    // Only when that receiver's class is this ancestor: a
                    // method of another class can reach this declaration name
                    // (for example a dynamic import of the class).
                    && self.classes.definitions[index].file
                        == source_file_info(get_source_file_of_node(ancestor)).file_name
                {
                    // Method bodies are lowered from checker-owned synthetic
                    // nodes whose class wrapper is not always pointer-equal to
                    // the inventory node. The receiver's nominal layout is the
                    // authoritative lexical owner in an instance body.
                    return Some(index);
                }
                return self.classes.definitions.iter().position(|definition| {
                    definition.node == ancestor
                        || (definition.file == self.file
                            && definition.node.pos() == ancestor.pos()
                            && definition.node.end() == ancestor.end())
                });
            }
            ancestor = ancestor.parent();
        }
        None
    }

    fn error_capture_stack_trace_member(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.expression().kind() != SyntaxKind::Identifier
            || node.name().text() != "captureStackTrace"
        {
            return false;
        }
        self.error_capture_stack_trace_constructor(node.expression())
    }

    /// Node exposes `Error.captureStackTrace` as a callable static capability.
    /// Native Error construction already owns the stack state, so invoking the
    /// capability only needs to preserve argument evaluation and return void.
    pub(in crate::frontend) fn error_capture_stack_trace_value(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        if !self.error_capture_stack_trace_member(node) {
            return Ok(None);
        }
        let arguments = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let mut helper = helpers::Helper::new(
            "error_capture_stack_trace",
            vec![arguments.clone()],
            Type::Void,
            self.loc(node),
        );
        helper.function.rest = true;
        let fn_name = self.install_helper(helper.function);
        Ok(Some(Expr::Closure {
            fn_name,
            captures: vec![],
            r#type: Type::Func {
                rest: true,
                params: vec![arguments],
                ret: Box::new(Type::Void),
            },
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn error_capture_stack_trace_call(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression
            || !self.error_capture_stack_trace_member(node.expression())
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty() || arguments.len() > 2 {
            return Err(self.refuse(
                node,
                "Error.captureStackTrace accepts a target and optional constructor",
            ));
        }
        let args = arguments
            .into_iter()
            .map(|argument| self.expression(argument))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Some(Expr::LibCall {
            r#fn: "error.captureStackTrace".into(),
            args,
            r#type: Type::Void,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn class_prototype_data_assignment(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let left = node.left();
        if left.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let prototype = primitives::primitive_source(left.expression());
        if prototype.kind() != SyntaxKind::PropertyAccessExpression
            || prototype.name().text() != "prototype"
        {
            return Ok(None);
        }
        let class_node = prototype.expression();
        let lexical = self.lexical_class_index(class_node);
        let Some(index) = lexical.or_else(|| self.class_symbol(class_node)) else {
            return Ok(None);
        };
        let name = left.name().text().to_string();
        if !self
            .classes
            .prototype_fields
            .contains_key(&(index, name.clone()))
        {
            return Ok(None);
        }
        let class = self.expression(class_node)?;
        let object = self.coerce(class, Type::Dyn, class_node)?;
        let value = self.expected_expression(node.right(), Type::Dyn)?;
        let mut stmts = Vec::new();
        let result = self.update_temp(value, &mut stmts, node.right());
        stmts.push(self.checked_dynamic_property_set(
            node,
            object,
            Expr::StrLit {
                value: name,
                r#type: Type::String,
                loc: self.loc(left),
            },
            result.clone(),
        )?);
        Ok(Some(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn class_prototype_data_get(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let prototype = node.expression();
        if prototype.kind() != SyntaxKind::PropertyAccessExpression
            || prototype.name().text() != "prototype"
        {
            return Ok(None);
        }
        let class_node = prototype.expression();
        let lexical = self.lexical_class_index(class_node);
        let Some(index) = lexical.or_else(|| self.class_symbol(class_node)) else {
            return Ok(None);
        };
        let field = node.name().text().to_string();
        if !self
            .classes
            .prototype_fields
            .contains_key(&(index, field.clone()))
            && lexical.is_none()
        {
            return Ok(None);
        }
        let class_name = self.classes.definitions[index].name.clone();
        let rebound_to_outer_this = if lexical.is_some() {
            let mut scope = class_node.parent();
            while !scope.is_nil()
                && !matches!(
                    scope.kind(),
                    SyntaxKind::FunctionExpression | SyntaxKind::ClassDeclaration
                )
            {
                scope = scope.parent();
            }
            if scope.kind() == SyntaxKind::FunctionExpression {
                let mut value = scope;
                let mut parent = value.parent();
                while parent.kind() == SyntaxKind::ParenthesizedExpression {
                    value = parent;
                    parent = parent.parent();
                }
                parent.kind() == SyntaxKind::PropertyAccessExpression
                    && parent.expression() == value
                    && parent.name().text() == "call"
                    && parent.parent().kind() == SyntaxKind::CallExpression
                    && parent.parent().arguments().get(0).kind() == SyntaxKind::ThisKeyword
            } else {
                false
            }
        } else {
            false
        };
        let owner = self.instance_this.as_ref().and_then(|local| {
            (matches!(&local.r#type, Type::Object { class_name: current }
                if lexical.is_some() || self.classes.subclass(current, &class_name))
                || (local.r#type == Type::Dyn && rebound_to_outer_this))
                .then(|| Expr::VarRef {
                    local_id: local.id.clone(),
                    r#type: local.r#type.clone(),
                    loc: self.loc(node),
                })
        });
        let value = if let Some(instance) = owner {
            self.coerce(instance, Type::Dyn, node)?
        } else {
            let class = self.expression(class_node)?;
            self.coerce(class, Type::Dyn, class_node)?
        };
        Ok(Some(self.dynamic_get(
            node,
            value,
            Expr::StrLit {
                value: field,
                r#type: Type::String,
                loc: self.loc(node),
            },
        )))
    }

    pub(in crate::frontend) fn class_prototype_data_set(
        &mut self,
        node: Node,
    ) -> Result<Option<Stmt>, String> {
        let left = node.left();
        if left.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let prototype = primitives::primitive_source(left.expression());
        if prototype.kind() != SyntaxKind::PropertyAccessExpression
            || prototype.name().text() != "prototype"
        {
            return Ok(None);
        }
        let class_node = prototype.expression();
        let Some(index) = self
            .lexical_class_index(class_node)
            .or_else(|| self.class_symbol(class_node))
        else {
            return Ok(None);
        };
        let name = left.name().text().to_string();
        if !self
            .classes
            .prototype_fields
            .contains_key(&(index, name.clone()))
        {
            return Ok(None);
        }
        let definition = self.classes.definitions[index].node;
        if definition.members().into_iter().any(|member| {
            member.modifier_flags().intersects(ModifierFlags::STATIC)
                && !member.name().is_nil()
                && member.name().text() == name
        }) {
            return Err(self.refuse(
                left,
                "prototype data and static data with the same name require separate descriptor storage",
            ));
        }
        let class = self.expression(class_node)?;
        let Type::Classval { .. } = class.ty() else {
            return Err(self.refuse(
                class_node,
                "prototype data requires a native class identity",
            ));
        };
        let object = Expr::DynFrom {
            value: Box::new(class),
            r#type: Type::Dyn,
            loc: self.loc(prototype),
        };
        let value = self.expected_expression(node.right(), Type::Dyn)?;
        self.checked_dynamic_property_set(
            node,
            object,
            Expr::StrLit {
                value: name,
                r#type: Type::String,
                loc: self.loc(left),
            },
            value,
        )
        .map(Some)
    }

    pub(in crate::frontend) fn dynamic_class_new(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let result = self.ty(node)?;
        if result != Type::Dyn {
            // `new Ctor(...)` through a constructor-only annotation (`type C =
            // new (...) => Like`) whose value is obtained at runtime: construct
            // dynamically, then check the instance against the declared view.
            if self.ty(node.expression()) != Ok(Type::Dyn)
                || self.class_symbol(node.expression()).is_some()
            {
                return Ok(None);
            }
        }
        let callee = self.expression(node.expression())?;
        let callee = if matches!(callee.ty(), Type::Classval { .. }) {
            self.coerce(callee, Type::Dyn, node.expression())?
        } else {
            callee
        };
        let callable = match callee.ty() {
            Type::Func { .. } => true,
            Type::Record { shape_id } => self.callables.contains_key(&shape_id),
            _ => false,
        };
        if callable {
            let callee = self.coerce(callee, Type::Dyn, node.expression())?;
            let arity = node.arguments().len();
            let mut args = vec![callee];
            args.extend(self.method_arguments(node, &vec![Type::Dyn; arity])?);
            let value = Expr::LibCall {
                r#fn: "dyn.constructCallable".into(),
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            return self.coerce(value, result, node).map(Some);
        }
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
        let value = Expr::Call {
            callee: name,
            args,
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        self.coerce(value, result, node).map(Some)
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
            let regex_constructor = Expr::LibCall {
                r#fn: "regex.constructorValue".into(),
                args: vec![],
                r#type: Type::Dyn,
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::If {
                cond: Expr::DynScalarEq {
                    left: Box::new(helper.read(&constructor)),
                    right: Box::new(regex_constructor),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Return {
                    value: Some(Expr::LibCall {
                        r#fn: "regex.constructDynamic".into(),
                        args: (0..arity)
                            .map(|i| helper.read(&helper.param(i + 2)))
                            .collect(),
                        r#type: Type::Dyn,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
            if arity == 0 {
                let marker = Expr::LibCall {
                    r#fn: "map.constructorValue".into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                };
                let map = Expr::MapNew {
                    seed: vec![],
                    r#type: Type::Map {
                        key: Box::new(Type::Dyn),
                        value: Box::new(Type::Dyn),
                    },
                    loc: helper.loc(),
                };
                let map = self.coerce(map, Type::Dyn, site)?;
                helper.function.body.push(Stmt::If {
                    cond: Expr::DynScalarEq {
                        left: Box::new(helper.read(&constructor)),
                        right: Box::new(marker),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(map),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
            }
            if arity == 1 {
                let marker = Expr::LibCall {
                    r#fn: "promise.constructorValue".into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                };
                let promise = Expr::LibCall {
                    r#fn: "promise.construct".into(),
                    args: vec![helper.read(&helper.param(2))],
                    r#type: Type::Promise {
                        inner: Box::new(Type::Dyn),
                    },
                    loc: helper.loc(),
                };
                let promise = self.coerce(promise, Type::Dyn, site)?;
                helper.function.body.push(Stmt::If {
                    cond: Expr::DynScalarEq {
                        left: Box::new(helper.read(&constructor)),
                        right: Box::new(marker),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(promise),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
            }
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
                    // Class expressions evaluated at runtime create distinct
                    // class identities that share the static layout.
                    cond: Expr::LibCall {
                        r#fn: "dyn.classLayoutIs".into(),
                        args: vec![helper.read(&constructor), identity],
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
                .find_mut(&name)
                .expect("registered dynamic constructor helper");
            *target = helper.function;
        }
        Ok(())
    }

    pub(in crate::frontend) fn class_ref(
        &mut self,
        index: usize,
        site: Node,
        prerequisite: Option<Expr>,
    ) -> Result<Expr, String> {
        let runtime = self.classes.layouts[index]
            .as_ref()
            .is_some_and(|class| class.runtime);
        if !runtime {
            self.request_constructor(index)?;
        }
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
        let known_non_class_local = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .is_some_and(|local| !matches!(local.r#type, Type::Classval { .. }));
        let Some(index) = self
            .lexical_class_index(node)
            .or_else(|| self.classes.symbols.get(&symbol).copied())
            .or_else(|| {
                if known_non_class_local {
                    return None;
                }
                let index = self.class_symbol(node)?;
                self.classes.layouts[index]
                    .as_ref()
                    .is_some_and(|class| class.runtime && class.js_name == node.text())
                    .then_some(index)
            })
        else {
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
        let mut ancestor = node.parent();
        while !ancestor.is_nil() && ancestor.kind() != SyntaxKind::SourceFile {
            if (ancestor == self.classes.definitions[index].node
                || (self.classes.definitions[index].file == self.file
                    && ancestor.pos() == self.classes.definitions[index].node.pos()
                    && ancestor.end() == self.classes.definitions[index].node.end()))
                && let Some(local) = self.instance_this.as_ref()
            {
                if let Type::Classval { class_name } = &local.r#type
                    && class_name == &self.classes.definitions[index].name
                {
                    return Ok(Some(Expr::VarRef {
                        local_id: local.id.clone(),
                        r#type: local.r#type.clone(),
                        loc: self.loc(node),
                    }));
                }
                let local = local.clone();
                let class_name = self.classes.definitions[index].name.clone();
                // The receiver only names this class's lexical constructor
                // when the body being lowered belongs to it: a foreign method
                // reaching the declaration (for example through a dynamic
                // import of the class) must use the ordinary class value.
                let own_body = self.classes.definitions[index].file == self.file
                    && match &local.r#type {
                        Type::Object { class_name: receiver } => {
                            self.classes.subclass(receiver, &class_name)
                        }
                        Type::Dyn => true,
                        _ => false,
                    };
                if !own_body {
                    ancestor = ancestor.parent();
                    continue;
                }
                let object = match local.r#type {
                    Type::Object { .. } => Expr::VarRef {
                        local_id: local.id.clone(),
                        r#type: local.r#type.clone(),
                        loc: self.loc(node),
                    },
                    // An erased `$dynamic` method body receives its receiver
                    // as NativeValue; check it as this class's instance.
                    Type::Dyn => self.coerce(
                        Expr::VarRef {
                            local_id: local.id.clone(),
                            r#type: Type::Dyn,
                            loc: self.loc(node),
                        },
                        Type::Object {
                            class_name: class_name.clone(),
                        },
                        node,
                    )?,
                    _ => {
                        ancestor = ancestor.parent();
                        continue;
                    }
                };
                return Ok(Some(Expr::LibCall {
                    r#fn: "class.lexicalConstructor".into(),
                    args: vec![object],
                    r#type: Type::Classval { class_name },
                    loc: self.loc(node),
                }));
            }
            ancestor = ancestor.parent();
        }
        let Some(token) = self.classes.definitions[index].token.clone() else {
            if self.classes.layouts[index]
                .as_ref()
                .is_some_and(|class| class.runtime)
            {
                return self.class_ref(index, node, None).map(Some);
            }
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
        self.request_constructor(index)?;
        let parent = self.class_heritage_value(node)?.map(Box::new);
        let capture_defs = self.classes.definitions[index].captures.clone();
        let captures = capture_defs
            .into_iter()
            .map(|(_, capture, ty)| self.expected_expression(capture, ty))
            .collect::<Result<Vec<_>, _>>()?;
        let class_name = self.classes.definitions[index].name.clone();
        let ty = Type::Classval {
            class_name: class_name.clone(),
        };
        let value = Expr::ClassCreate {
            class_name,
            parent,
            captures,
            r#type: ty.clone(),
            loc: self.loc(node),
        };
        let has_definition_effects = node.members().into_iter().any(|member| {
            let name = member.name();
            (member.kind() == SyntaxKind::MethodDeclaration
                && !name.is_nil()
                && name.kind() == SyntaxKind::ComputedPropertyName)
                || (member.kind() == SyntaxKind::PropertyDeclaration
                    && member.modifier_flags().intersects(ModifierFlags::STATIC)
                    && !member.modifier_flags().intersects(ModifierFlags::AMBIENT))
                || (!name.is_nil() && name.kind() == SyntaxKind::PrivateIdentifier)
        });
        if !has_definition_effects {
            return Ok(value);
        }
        // Allocate the runtime class identity first. Static field writes must
        // target that exact identity (not the shared layout ClassRef), and the
        // direct sequence keeps enclosing factory captures in scope.
        let class = self.construction_local(ty.clone(), false);
        let mut stmts = vec![Stmt::VarDecl {
            local_id: class.id.clone(),
            init: value,
            loc: self.loc(node),
        }];
        stmts.extend(
            self.class_computed_symbol_keys(node, Some(self.construction_read(&class, node)))?,
        );
        stmts.extend(self.initialize_private_storage(index, node)?);
        let receiver = self.construction_read(&class, node);
        stmts.extend(self.initialize_static_fields(index, node, Some(receiver))?);
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(self.construction_read(&class, node)),
            r#type: ty,
            loc: self.loc(node),
        })
    }

    fn proven_commonjs_class_heritage(&mut self, expression: Node, class_index: usize) -> bool {
        if self.commonjs_wrapped_default_class(expression) == Some(class_index) {
            return true;
        }
        if expression.kind() != SyntaxKind::Identifier {
            return false;
        }
        let local = self.checker.get_symbol_at_location(expression, false);
        if local.0 == 0 {
            return false;
        }
        let declarations = self.checker.sym(local).declarations.clone();
        if declarations.len() != 1 {
            return false;
        }
        let binding = declarations[0];
        let variable = match binding.kind() {
            SyntaxKind::BindingElement
                if binding.parent().kind() == SyntaxKind::ObjectBindingPattern =>
            {
                binding.parent().parent()
            }
            SyntaxKind::VariableDeclaration
                if binding.name().kind() == SyntaxKind::Identifier
                    && binding.name().text() == expression.text() =>
            {
                binding
            }
            _ => return false,
        };
        if variable.kind() != SyntaxKind::VariableDeclaration
            || !variable.parent().flags().intersects(NodeFlags::CONST)
            || variable.parent().parent().parent().kind() != SyntaxKind::SourceFile
        {
            return false;
        }
        let Some(file) = self.commonjs_require_file(variable.initializer()) else {
            return false;
        };
        let statements = file.statements();
        let Some(last) = statements.last() else {
            return false;
        };
        if last.kind() != SyntaxKind::ExpressionStatement {
            return false;
        }
        let export = last.expression();
        if export.kind() != SyntaxKind::BinaryExpression
            || export.operator_token().kind() != SyntaxKind::EqualsToken
            || export.left().kind() != SyntaxKind::PropertyAccessExpression
            || export.left().name().text() != "exports"
            || export.left().expression().kind() != SyntaxKind::Identifier
            || export.left().expression().text() != "module"
        {
            return false;
        }
        if export.right().kind() == SyntaxKind::Identifier {
            let exported = export.right();
            return statements.iter().any(|statement| {
                statement.kind() == SyntaxKind::ClassDeclaration
                    && statement.name().text() == exported.text()
                    && statement == self.classes.definitions[class_index].node
                    && self.checker.get_symbol_at_location(statement.name(), false)
                        == self.checker.get_symbol_at_location(exported, false)
                    && statement.end() <= last.pos()
            });
        }
        if export.right().kind() == SyntaxKind::ClassExpression {
            // `module.exports = class Name {}` publishes the class only after
            // its definition has completed. A top-level const require of that
            // module therefore cannot observe the checker-only undefined arm.
            return export.right() == self.classes.definitions[class_index].node;
        }
        if export.right().kind() != SyntaxKind::ObjectLiteralExpression
            || binding.kind() != SyntaxKind::BindingElement
        {
            return false;
        }
        let wanted = binding.property_name_or_name().text();
        let exported = export
            .right()
            .properties()
            .into_iter()
            .filter(|property| property.name().text() == wanted)
            .collect::<Vec<_>>();
        let [property] = exported.as_slice() else {
            return false;
        };
        if property.kind() != SyntaxKind::ShorthandPropertyAssignment {
            return false;
        }
        statements.iter().any(|statement| {
            statement.kind() == SyntaxKind::ClassDeclaration
                && statement.name().text() == wanted
                && statement == self.classes.definitions[class_index].node
                && statement.end() <= last.pos()
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
                .or_else(|| self.commonjs_wrapped_default_class(expression))
                .or_else(|| self.effectful_heritage_class(expression))
                .or_else(|| self.guarded_optional_class_heritage(node, expression))
                .ok_or_else(|| self.refuse(expression, "unresolved class heritage"))?;
            let lexical_heritage = matches!(
                expression.kind(),
                SyntaxKind::Identifier | SyntaxKind::ThisKeyword
            ) || (expression.kind() == SyntaxKind::PropertyAccessExpression
                && (self.module_namespace(expression.expression())
                    || self.commonjs_namespace_alias(expression.expression())));
            if !lexical_heritage {
                // The layout is fixed by the exact constructor identity above,
                // but JavaScript still evaluates an effectful heritage once at
                // class definition time. Retain that evaluation and require the
                // produced constructor to match the statically selected class.
                let target = Type::Classval {
                    class_name: self.classes.definitions[index].name.clone(),
                };
                return Ok(Some(self.expected_expression(expression, target)?));
            }
            if !self.classes.definitions[index].node.is_nil() {
                // A declaration's heritage only reads its lexical identity;
                // defining an unused subclass must not demand its base body.
                let symbol = self.symbol(expression);
                if self.classes.symbols.get(&symbol).copied() == Some(index)
                    && let Some(token) = self.classes.definitions[index].token.clone()
                {
                    let class = self.class_ref(index, expression, None)?;
                    let ty = class.ty();
                    return Ok(Some(Expr::Sequence {
                        stmts: vec![Stmt::Expression {
                            expr: self.read_class_token(&token, expression),
                            loc: self.loc(expression),
                        }],
                        result: Box::new(class),
                        r#type: ty,
                        loc: self.loc(expression),
                    }));
                }
                let value = self.expression(expression)?;
                if !matches!(value.ty(), Type::Classval { .. }) {
                    if self.proven_commonjs_class_heritage(expression, index) {
                        let target = Type::Classval {
                            class_name: self.classes.definitions[index].name.clone(),
                        };
                        return Ok(Some(self.coerce(value, target, expression)?));
                    }
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
            let decoder = self.classes.definitions[index]
                .name
                .ends_with("TextDecoder");
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            if decoder && args.len() > 2 {
                return Err(self.refuse(
                    node,
                    "text codec constructor arguments/options are not ported",
                ));
            }
            let encoding = if decoder {
                if let Some(label) = args.first() {
                    let label = primitives::primitive_source(*label);
                    if label.kind() != SyntaxKind::StringLiteral {
                        return Err(self.refuse(
                            label,
                            "native TextDecoder requires a represented literal encoding label",
                        ));
                    }
                    codecs::text_decoder_encoding(&label.text()).ok_or_else(|| {
                        self.refuse(label, "TextDecoder encoding label is not recognized")
                    })?
                } else {
                    -1.0
                }
            } else {
                -1.0
            };
            let mut fatal = false;
            if decoder && let Some(options) = args.get(1) {
                let options = primitives::primitive_source(*options);
                if options.kind() != SyntaxKind::ObjectLiteralExpression {
                    return Err(
                        self.refuse(options, "TextDecoder options must be an object literal")
                    );
                }
                for property in options.properties() {
                    if property.kind() != SyntaxKind::PropertyAssignment {
                        return Err(self.refuse(
                            property,
                            "TextDecoder options require named literal properties",
                        ));
                    }
                    let value = primitives::primitive_source(property.initializer());
                    let boolean = match value.kind() {
                        SyntaxKind::TrueKeyword => true,
                        SyntaxKind::FalseKeyword => false,
                        _ => {
                            return Err(
                                self.refuse(value, "TextDecoder options require boolean literals")
                            );
                        }
                    };
                    match property.name().text() {
                        "fatal" => fatal = boolean,
                        "ignoreBOM" if !boolean => {}
                        "ignoreBOM" => {
                            return Err(
                                self.refuse(property, "TextDecoder ignoreBOM=true is not ported")
                            );
                        }
                        _ => {
                            return Err(self.refuse(property, "TextDecoder option is not ported"));
                        }
                    }
                }
            }
            if decoder && encoding >= 0.0 && fatal {
                return Err(self.refuse(node, "fatal legacy TextDecoder decoding is not ported"));
            }
            self.request_constructor(index)?;
            let value = Expr::New {
                class_name: self.classes.definitions[index].name.clone(),
                args: if decoder {
                    vec![
                        Expr::BoolLit {
                            value: fatal,
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        },
                        Expr::NumLit {
                            value: encoding,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        },
                    ]
                } else {
                    vec![]
                },
                r#type: self.classes.object(index),
                loc: self.loc(node),
            };
            if decoder || args.is_empty() {
                return Ok(Some(value));
            }
            let mut stmts = Vec::with_capacity(args.len());
            for argument in args {
                if argument.kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(
                        argument,
                        "TextEncoder ignored arguments do not support spread evaluation",
                    ));
                }
                stmts.push(Stmt::Expression {
                    expr: self.expression(argument)?,
                    loc: self.loc(argument),
                });
            }
            let r#type = value.ty();
            return Ok(Some(Expr::Sequence {
                stmts,
                result: Box::new(value),
                r#type,
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index].name == "%DOMException" {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.len() > 2 {
                return Err(self.refuse(node, "DOMException accepts message and name"));
            }
            let message = arguments
                .first()
                .map(|argument| self.expression(*argument))
                .transpose()?;
            let message = self.message_value(message, node)?;
            let name = match arguments.get(1).copied() {
                None => Expr::StrLit {
                    value: "Error".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                },
                Some(argument) => {
                    let value = self.expression(argument)?;
                    if value.ty() == Type::Undefined {
                        Expr::StrLit {
                            value: "Error".into(),
                            r#type: Type::String,
                            loc: self.loc(argument),
                        }
                    } else {
                        self.message_value(Some(value), argument)?
                    }
                }
            };
            return Ok(Some(Expr::LibCall {
                r#fn: "error.domException".into(),
                args: vec![message, name],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index].name == "%AggregateError" {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.is_empty() || arguments.len() > 3 {
                return Err(self.refuse(
                    node,
                    "AggregateError accepts errors, optional message and optional cause options",
                ));
            }
            let errors = self.expected_expression(arguments[0], Type::Dyn)?;
            let message = arguments
                .get(1)
                .map(|argument| self.expression(*argument))
                .transpose()?;
            let message = self.message_value(message, node)?;
            let options = arguments
                .get(2)
                .map(|argument| self.expected_expression(*argument, Type::Dyn))
                .transpose()?;
            return Ok(Some(Expr::LibCall {
                r#fn: "error.aggregate".into(),
                args: std::iter::once(errors)
                    .chain(std::iter::once(message))
                    .chain(options)
                    .collect(),
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if matches!(
            self.classes.definitions[index].name.as_str(),
            node_streams::TRANSFORM
                | node_streams::DUPLEX
                | node_streams::READABLE
                | node_streams::WRITABLE
                | node_console::CLASS
                | event_emitters::CLASS
        ) {
            self.request_constructor(index)?;
            let mut statements = Vec::new();
            for argument in node.arguments() {
                if argument.kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(
                        argument,
                        "native stream constructor argument spreads are not ported",
                    ));
                }
                statements.push(Stmt::Expression {
                    expr: self.expression(argument)?,
                    loc: self.loc(argument),
                });
            }
            let value = Expr::New {
                class_name: self.classes.definitions[index].name.clone(),
                args: Vec::new(),
                r#type: self.classes.object(index),
                loc: self.loc(node),
            };
            if statements.is_empty() {
                return Ok(Some(value));
            }
            let r#type = value.ty();
            return Ok(Some(Expr::Sequence {
                stmts: statements,
                result: Box::new(value),
                r#type,
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index].name == dom_events::CLASS {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.is_empty()
                || arguments.len() > 2
                || arguments
                    .iter()
                    .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "native Event requires a type and optional init object",
                ));
            }
            let name = self.expected_expression(arguments[0], Type::String)?;
            let options = if let Some(argument) = arguments.get(1) {
                self.expected_expression(*argument, Type::Dyn)?
            } else {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?
            };
            self.request_constructor(index)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "dom.eventNew".into(),
                args: vec![name, options],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index].name == dom_events::TARGET_CLASS {
            if !node.arguments().is_empty() {
                return Err(self.refuse(
                    node,
                    "native EventTarget constructor arguments are not ported",
                ));
            }
            self.request_constructor(index)?;
            return Ok(Some(Expr::New {
                class_name: dom_events::TARGET_CLASS.into(),
                args: vec![],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index].node.is_nil() {
            let (message, options) = self.error_message(node)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "error.new".into(),
                args: std::iter::once(message).chain(options).collect(),
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        let callee = self.expression(node.expression())?;
        let inferred = self.classes.definitions[index].name.clone();
        // Imports from CommonJS/UMD packages retain an owning dynamic (or
        // undefined-aware union) value even when the checker can prove the
        // concrete constructor declaration. Install a checked Classval view
        // over that same value instead of replacing it with a static
        // ClassRef: class factories and module caches must keep their runtime
        // identity, while an absent or different export still fails at `new`.
        let callee = match callee.ty() {
            Type::Dyn => self.coerce(
                callee,
                Type::Classval {
                    class_name: inferred.clone(),
                },
                node.expression(),
            )?,
            Type::Union { union_id }
                if self.unions[union_id].arms.iter().any(|arm| {
                    *arm == (Type::Classval {
                        class_name: inferred.clone(),
                    })
                }) =>
            {
                self.coerce(
                    callee,
                    Type::Classval {
                        class_name: inferred.clone(),
                    },
                    node.expression(),
                )?
            }
            _ => callee,
        };
        let Type::Classval { class_name } = callee.ty() else {
            return Err(self.refuse(
                node,
                &format!(
                    "constructor value may be undefined or has a different identity (callee {:?}, inferred {inferred})",
                    callee.ty()
                ),
            ));
        };
        if !self.classes.subclass(&class_name, &inferred) {
            return Err(self.refuse(
                node,
                &format!(
                    "constructor value may be undefined or has a different identity (callee {class_name} {:?}, inferred {inferred} {:?})",
                    self.classes.definitions.iter().find(|d| d.name == class_name).map(|d| (d.file.clone(), d.node.pos())),
                    self.classes.definitions.iter().find(|d| d.name == inferred).map(|d| (d.file.clone(), d.node.pos())),
                ),
            ));
        }
        // A static method specialized for an inherited receiver can return a
        // more specific constructor than the checker sees at the call site.
        let index = self
            .classes
            .definitions
            .iter()
            .position(|class| class.name == class_name)
            .ok_or_else(|| self.refuse(node, "constructor identity has no native class"))?;
        let params = self.request_constructor(index)?;
        let types = params
            .into_iter()
            .skip(1)
            .map(|p| p.r#type)
            .collect::<Vec<_>>();
        let constructor = self.classes.definitions[index]
            .node
            .members()
            .into_iter()
            .find(|member| member.kind() == SyntaxKind::Constructor);
        let constructor_rest = constructor
            .and_then(|constructor| constructor.parameters().into_iter().last())
            .is_some_and(|parameter| !parameter.dot_dot_dot_token().is_nil())
            || constructor
                .is_some_and(|constructor| constructors::constructor_arguments_object(constructor).is_some());
        let supplied = node.arguments().into_iter().collect::<Vec<_>>();
        if !constructor_rest
            && constructor.is_some()
            && supplied.len() > types.len()
            && !supplied
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            // Capture the constructor and fixed arguments before evaluating the
            // surplus expressions. An explicit constructor without `arguments`
            // or a rest parameter cannot observe their values, but their effects
            // and exceptions precede instance allocation and constructor entry.
            let mut stmts = Vec::new();
            let callee_local = self.construction_local(callee.ty(), false);
            stmts.push(Stmt::VarDecl {
                local_id: callee_local.id.clone(),
                init: callee,
                loc: self.loc(node),
            });
            let mut args = Vec::with_capacity(types.len());
            for (argument, ty) in supplied.iter().zip(&types) {
                let value = self.expected_call_argument(*argument, ty.clone(), true)?;
                let local = self.construction_local(value.ty(), false);
                stmts.push(Stmt::VarDecl {
                    local_id: local.id.clone(),
                    init: value,
                    loc: self.loc(*argument),
                });
                args.push(self.construction_read(&local, *argument));
            }
            for argument in supplied.iter().skip(types.len()) {
                stmts.push(Stmt::Expression {
                    expr: self.expression(*argument)?,
                    loc: self.loc(*argument),
                });
            }
            let result = self.classes.object(index);
            return Ok(Some(Expr::Sequence {
                stmts,
                result: Box::new(Expr::NewValue {
                    callee: Box::new(self.construction_read(&callee_local, node)),
                    args,
                    r#type: result.clone(),
                    loc: self.loc(node),
                }),
                r#type: result,
                loc: self.loc(node),
            }));
        }
        let args = if constructor_rest {
            self.rest_method_arguments(node, &types, true)?
        } else {
            self.method_arguments(node, &types)?
        };
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
            Err(error)
                if self
                    .checker
                    .ty(checked_result)
                    .flags
                    .intersects(TypeFlags::UNION) =>
            {
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
            _ => {
                return Err(self.refuse(
                    node,
                    "constructor union requires represented native instances",
                ));
            }
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
            if common
                .as_ref()
                .is_none_or(|expected| params.len() > expected.len())
            {
                common = Some(params.clone());
            }
            classes.push((index, params.len()));
        }
        let params = common.unwrap();
        let arguments = self.method_arguments(node, &params)?;
        // Keep a dynamic property value intact until after argument evaluation:
        // JavaScript evaluates arguments before checking constructibility.
        let (callee, dynamic) = match callee {
            Expr::DynCheck { value, r#type, .. } if r#type == (Type::Union { union_id }) => {
                (*value, true)
            }
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
            let values = (1..=arity).map(|i| helper.read(&helper.param(i))).collect();
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

    pub(super) fn error_message(&mut self, node: Node) -> Result<(Expr, Option<Expr>), String> {
        if node.arguments().len() > 2 {
            return Err(self.refuse(node, "Error accepts message and optional cause options"));
        }
        let mut arguments = node.arguments().into_iter();
        let value = arguments.next().map(|n| self.expression(n)).transpose()?;
        let message = self.message_value(value, node)?;
        let options = arguments
            .next()
            .map(|argument| self.expected_expression(argument, Type::Dyn))
            .transpose()?;
        Ok((message, options))
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
            Some(value) if value.ty() == Type::Dyn => {
                let mut helper = helpers::Helper::new(
                    "dynamic_error_message",
                    vec![Type::Dyn],
                    Type::String,
                    self.loc(node),
                );
                let incoming = helper.read(&helper.param(0));
                helper.function.body.push(Stmt::Return {
                    value: Some(Expr::Ternary {
                        cond: Box::new(Expr::DynTest {
                            value: Box::new(incoming.clone()),
                            test: "undefined".into(),
                            negated: false,
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        then: Box::new(empty()),
                        else_: Box::new(Expr::LibCall {
                            r#fn: "dyn.stringConstructor".into(),
                            args: vec![incoming],
                            r#type: Type::String,
                            loc: helper.loc(),
                        }),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                });
                Ok(Expr::Call {
                    callee: self.install_helper(helper.function),
                    args: vec![value],
                    r#type: Type::String,
                    loc: self.loc(node),
                })
            }
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
                SyntaxKind::FunctionExpression
                    | SyntaxKind::FunctionDeclaration
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::GetAccessor
                    | SyntaxKind::SetAccessor
            ) {
                return None;
            }
            if ancestor.kind() == SyntaxKind::PropertyDeclaration
                && ancestor.modifier_flags().intersects(ModifierFlags::STATIC)
                && let Some(definition) = self
                    .classes
                    .definitions
                    .iter()
                    .find(|definition| definition.node == ancestor.parent())
            {
                return Some(Expr::ClassRef {
                    class_name: definition.name.clone(),
                    r#type: Type::Classval {
                        class_name: definition.name.clone(),
                    },
                    loc: self.loc(node),
                });
            }
            ancestor = ancestor.parent();
        }
        None
    }

    pub(in crate::frontend) fn this_expression(&mut self, node: Node) -> Result<Expr, String> {
        if self.instance_this.is_none()
            && let Some(value) = self.static_initializer_this(node)
        {
            return Ok(value);
        }
        if self.instance_this.is_none()
            && self.return_type.is_none()
            && let Some(value) = self.commonjs_this(node)
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

    pub(in crate::frontend) fn field_type(&self, class: &str, field: &str) -> Option<Type> {
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

    pub(in crate::frontend) fn ensure_contract_field(
        &mut self,
        class_name: &str,
        field: &str,
        site: Node,
    ) -> Result<Option<Type>, String> {
        if let Some(ty) = self.field_type(class_name, field) {
            return Ok(Some(ty));
        }
        let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)
        else {
            return Ok(None);
        };
        let definition = self.classes.definitions[index].node;
        let contract = self
            .class_contract(definition)
            .and_then(|hint| hint.fields.iter().find(|(name, _)| name == field))
            .and_then(|(_, ty)| ty.clone());
        let descendant = if contract.is_none() {
            let descendants = self
                .classes
                .definitions
                .iter()
                .enumerate()
                .filter(|(descendant, definition)| {
                    *descendant != index && self.classes.subclass(&definition.name, class_name)
                })
                .map(|(descendant, _)| descendant)
                .collect::<Vec<_>>();
            let mut common = None;
            for descendant in descendants {
                self.layout_class(descendant)?;
                let Some(candidate) = self.classes.layouts[descendant]
                    .as_ref()
                    .and_then(|layout| layout.fields.iter().find(|slot| slot.name == field))
                    .map(|slot| slot.r#type.clone())
                else {
                    continue;
                };
                if common.as_ref().is_some_and(|ty| *ty != candidate) {
                    common = None;
                    break;
                }
                common = Some(candidate);
            }
            common
        } else {
            None
        };
        let inferred = if contract.is_none()
            && descendant.is_none()
            && !definition.is_nil()
            && parameter_abi::is_javascript(definition)
        {
            if self.classes.method(index, field).is_some() {
                return Err(self.refuse(
                    site,
                    "extracted JavaScript prototype method needs a native function identity",
                ));
            }
            // JavaScript can install a public own property through an alias or
            // helper object (`helper.target.on = fn`) rather than a direct
            // `this.on = fn` assignment. The checker still exposes the closed
            // property type at every typed read/write site. Materialize that
            // slot on the native class so dynamic alias writes and later
            // nominal reads share one instance store. Prototype methods and
            // accessors are resolved before this path and therefore cannot be
            // mistaken for injected data properties.
            self.ty(site).ok().filter(|ty| *ty != Type::Dyn)
        } else {
            None
        };
        let Some(target) = contract.or(descendant).or(inferred) else {
            return Ok(None);
        };
        if matches!(target, Type::Void | Type::Null | Type::Undefined) {
            return Err(self.refuse(site, "public class field has no native representation"));
        }
        self.layout_class(index)?;
        let mut arms = if let Type::Union { union_id } = target {
            self.unions[union_id].arms.clone()
        } else {
            vec![target]
        };
        arms.push(Type::Undefined);
        let storage = self.intern_union(arms).ok_or_else(|| {
            self.refuse(
                site,
                "public class field has no undefined storage representation",
            )
        })?;
        let descendants = self
            .classes
            .definitions
            .iter()
            .enumerate()
            .filter(|(_, definition)| self.classes.subclass(&definition.name, class_name))
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let inherited_index = {
            let layout = self.classes.layouts[index]
                .as_mut()
                .expect("class layout was materialized");
            if let Some(position) = layout.fields.iter().position(|slot| slot.name == field) {
                if layout.fields[position].r#type != storage {
                    let existing = layout.fields[position].r#type.clone();
                    return Err(self.refuse(
                        site,
                        &format!(
                            "inherited class field layouts disagree: {class_name}.{field} has {:?}, requested {storage:?}",
                            existing
                        ),
                    ));
                }
                position
            } else {
                let position = layout.fields.len();
                layout.fields.push(ir::Field {
                    name: field.into(),
                    r#type: storage.clone(),
                });
                position
            }
        };
        for descendant in descendants {
            if descendant == index {
                continue;
            }
            let descendant_name = self.classes.definitions[descendant].name.clone();
            if let Some(layout) = self.classes.layouts[descendant].as_mut() {
                if let Some(existing) = layout.fields.iter().find(|slot| slot.name == field) {
                    if existing.r#type != storage {
                        let existing = existing.r#type.clone();
                        return Err(self.refuse(
                            site,
                            &format!(
                                "inherited class field layouts disagree: {}.{field} has {:?}, requested {storage:?}",
                                descendant_name, existing
                            ),
                        ));
                    }
                } else {
                    layout.fields.insert(
                        inherited_index.min(layout.fields.len()),
                        ir::Field {
                            name: field.into(),
                            r#type: storage.clone(),
                        },
                    );
                }
            }
        }
        Ok(Some(storage))
    }

    pub(in crate::frontend) fn ensure_dynamic_class_field(
        &mut self,
        class_name: &str,
        field: &str,
        site: Node,
    ) -> Result<Type, String> {
        let index = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)
            .ok_or_else(|| self.refuse(site, "dynamic class field has no source class"))?;
        self.layout_class(index)?;
        let storage = self
            .intern_union(vec![Type::Dyn, Type::Undefined])
            .ok_or_else(|| self.refuse(site, "dynamic class field has no native storage"))?;
        let inherited_index = {
            let layout = self.classes.layouts[index]
                .as_mut()
                .expect("class layout was materialized");
            if let Some(position) = layout.fields.iter().position(|slot| slot.name == field) {
                position
            } else {
                let position = layout.fields.len();
                layout.fields.push(ir::Field {
                    name: field.into(),
                    r#type: storage.clone(),
                });
                position
            }
        };
        let descendants = self
            .classes
            .definitions
            .iter()
            .enumerate()
            .filter(|(descendant, definition)| {
                *descendant != index && self.classes.subclass(&definition.name, class_name)
            })
            .map(|(descendant, _)| descendant)
            .collect::<Vec<_>>();
        for descendant in descendants {
            if let Some(layout) = self.classes.layouts[descendant].as_mut()
                && !layout.fields.iter().any(|slot| slot.name == field)
            {
                layout.fields.insert(
                    inherited_index.min(layout.fields.len()),
                    ir::Field {
                        name: field.into(),
                        r#type: storage.clone(),
                    },
                );
            }
        }
        Ok(storage)
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
        if self.class_symbol_key(key).is_some() {
            let obj = self.coerce(obj, Type::Dyn, node)?;
            let key = self.expression(key)?;
            return Ok(Expr::DynKeyGet {
                value: Box::new(obj),
                key: Box::new(key),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        if key.kind() != SyntaxKind::StringLiteral {
            return Err(self.refuse(
                node,
                "indexed class reads require a literal public data key",
            ));
        }
        let field = key.text().to_string();
        let ty = if let Some(ty) = self.field_type(&class_name, &field) {
            ty
        } else {
            self.class_index_slot(&class_name, &field, node)?
        };
        let value = Expr::FieldGet {
            obj: Box::new(obj),
            class_name,
            field,
            r#type: ty,
            loc: self.loc(node),
        };
        if let Type::Union { union_id } = value.ty()
            && self.unions[union_id]
                .arms
                .iter()
                .any(|arm| matches!(arm, Type::Func { .. }))
        {
            return Err(self.refuse(
                node,
                "indexed nullable function fields need a retained call reference",
            ));
        }
        self.narrowed(value, node)
    }

    pub(in crate::frontend) fn class_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.name().kind() == SyntaxKind::PrivateIdentifier {
            return self.private_get(node).map(Some);
        }
        // Probe the type without lowering the receiver twice (calls can enqueue helpers).
        let stored = if node.expression().kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node.expression());
            self.bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|local| local.r#type.clone())
                .filter(|ty| matches!(ty, Type::Object { .. }))
        } else {
            None
        };
        let mut ty = if matches!(
            node.expression().kind(),
            SyntaxKind::ThisKeyword | SyntaxKind::SuperKeyword
        ) {
            self.instance_this.as_ref().map(|l| l.r#type.clone())
        } else if node.expression().kind() == SyntaxKind::CallExpression {
            self.planned_class_method_call_result(node.expression())
                .or_else(|| self.ty(node.expression()).ok())
        } else {
            stored.or_else(|| self.ty(node.expression()).ok())
        };
        // A bound identifier lowers to its binding's representation. A
        // concrete non-object binding cannot become a class handle, so do not
        // fork the whole lowering state merely to rediscover it.
        let concrete_binding = node.expression().kind() == SyntaxKind::Identifier && {
            let symbol = self.symbol(node.expression());
            self.bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .is_some_and(|local| {
                    !matches!(
                        local.r#type,
                        Type::Object { .. } | Type::Dyn | Type::Union { .. }
                    )
                })
        };
        // Only an erased (`any`), unknown or union view can hide a represented
        // class handle; a concrete scalar/record/container view cannot.
        let hidden_class = matches!(&ty, None | Some(Type::Dyn | Type::Union { .. }));
        if hidden_class && !concrete_binding {
            let mut probe = self.diagnostic_fork();
            let represented = probe
                .expression(node.expression())
                .ok()
                .map(|value| value.ty());
            if matches!(represented, Some(Type::Object { .. })) {
                ty = represented;
            }
        }
        if !matches!(&ty, Some(Type::Object { .. })) {
            return Ok(None);
        }
        let checker_ty = ty.expect("class receiver probe checked above");
        let mut obj = if node.expression().kind() == SyntaxKind::SuperKeyword {
            self.this_expression(node.expression())?
        } else {
            self.expression(node.expression())?
        };
        if matches!(obj.ty(), Type::Record { .. }) && self.namespace_capsule(&checker_ty) {
            return Ok(None);
        }
        if !matches!(obj.ty(), Type::Object { .. }) {
            // A caught binding or an owning union can reach this path through
            // a checker-narrowed class view. Apply that view at the receiver
            // boundary before demanding the nominal class handle.
            obj = self.narrowed(obj, node.expression())?;
        }
        if matches!(obj.ty(), Type::Union { .. } | Type::Dyn)
            && primitives::primitive_source(node.expression()).kind() == SyntaxKind::Identifier
        {
            // The checker's nominal view (for example a JSDoc `@param {Error}`)
            // is not the binding's owning representation: callers pass other
            // values too. Leave the read to the ordinary owning-value property
            // path; re-reading an identifier receiver has no effects.
            return Ok(None);
        }
        let Type::Object { class_name } = obj.ty() else {
            let reason = format!(
                "class receiver has no object representation (runtime {:?}, checker {:?})",
                obj.ty(),
                checker_ty
            );
            return Err(self.refuse(node, &reason));
        };
        let field = node.name().text().to_string();
        // A native EventEmitter method read as a value (`this.emit.bind(...)`)
        // on a subclass that does not declare it: the runtime returns a
        // callable bound to the instance's native emitter.
        if self.classes.subclass(&class_name, event_emitters::CLASS)
            && matches!(
                field.as_str(),
                "on" | "addListener"
                    | "once"
                    | "prependListener"
                    | "prependOnceListener"
                    | "off"
                    | "removeListener"
                    | "emit"
                    | "listenerCount"
            )
            && {
                let parent = node.parent();
                !(parent.kind() == SyntaxKind::CallExpression && parent.expression() == node)
            }
            && self
                .classes
                .definitions
                .iter()
                .position(|definition| definition.name == class_name)
                .is_some_and(|index| self.classes.method(index, &field).is_none())
        {
            let receiver = self.coerce(obj, Type::Dyn, node.expression())?;
            let key = Expr::StrLit {
                value: field,
                r#type: Type::String,
                loc: self.loc(node.name()),
            };
            return Ok(Some(self.dynamic_get(node, receiver, key)));
        }
        if matches!(
            class_name.as_str(),
            node_streams::TRANSFORM
                | node_streams::DUPLEX
                | node_streams::READABLE
                | node_streams::WRITABLE
        ) && field == "destroyed"
        {
            return Ok(Some(Expr::LibCall {
                r#fn: "nodeStream.destroyed".into(),
                args: vec![obj],
                r#type: Type::Bool,
                loc: self.loc(node),
            }));
        }
        if self.classes.subclass(&class_name, dom_events::CLASS) {
            let result = match field.as_str() {
                "type" => Some(Type::String),
                "bubbles" | "cancelable" | "composed" | "defaultPrevented" | "isTrusted"
                | "cancelBubble" => Some(Type::Bool),
                "eventPhase" => Some(Type::F64),
                "target" | "currentTarget" | "srcElement" => Some(Type::Dyn),
                _ => None,
            };
            if let Some(result) = result {
                if class_name != dom_events::CLASS {
                    return Err(
                        self.refuse(node, "native Event subclass initialization is not ported")
                    );
                }
                let value = Expr::LibCall {
                    r#fn: "dom.eventGet".into(),
                    args: vec![
                        obj,
                        Expr::StrLit {
                            value: field,
                            r#type: Type::String,
                            loc: self.loc(node),
                        },
                    ],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                };
                return self.coerce(value, result, node).map(Some);
            }
        }
        if field == "constructor" && node.expression().kind() != SyntaxKind::SuperKeyword {
            if parameter_abi::is_javascript(node) || matches!(self.ty(node), Ok(Type::Dyn)) {
                let object = self.coerce(obj, Type::Dyn, node.expression())?;
                return Ok(Some(self.dynamic_get(
                    node,
                    object,
                    Expr::StrLit {
                        value: "constructor".into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                )));
            }
            return Ok(Some(Expr::LibCall {
                r#fn: "class.instanceConstructor".into(),
                args: vec![obj],
                r#type: Type::Classval {
                    class_name: class_name.clone(),
                },
                loc: self.loc(node),
            }));
        }
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
        if matches!(
            class_name.as_str(),
            node_streams::TRANSFORM
                | node_streams::DUPLEX
                | node_streams::READABLE
                | node_streams::WRITABLE
        ) && field == "_readableState"
        {
            let encoding = self
                .intern_union(vec![Type::String, Type::Null])
                .expect("string/null stream encoding storage");
            let declared_order = vec![
                "destroyed".to_string(),
                "endEmitted".to_string(),
                "ended".to_string(),
                "closeEmitted".to_string(),
                "dataEmitted".to_string(),
                "encoding".to_string(),
            ];
            let mut fields = vec![
                ir::Field {
                    name: "destroyed".into(),
                    r#type: Type::Bool,
                },
                ir::Field {
                    name: "endEmitted".into(),
                    r#type: Type::Bool,
                },
                ir::Field {
                    name: "ended".into(),
                    r#type: Type::Bool,
                },
                ir::Field {
                    name: "closeEmitted".into(),
                    r#type: Type::Bool,
                },
                ir::Field {
                    name: "dataEmitted".into(),
                    r#type: Type::Bool,
                },
                ir::Field {
                    name: "encoding".into(),
                    r#type: encoding.clone(),
                },
            ];
            fields.sort_by(|left, right| left.name.cmp(&right.name));
            let shape_id = if let Some(record) = self.records.iter().find(|record| {
                !record.tuple && record.index_value.is_none() && record.fields == fields
            }) {
                record.id
            } else {
                let shape_id = self.records.len();
                self.records.push(ir::Record {
                    id: shape_id,
                    fields,
                    declared_order: declared_order.clone(),
                    tuple: false,
                    index_value: None,
                });
                shape_id
            };
            let boolean = |name: &str, loc: Loc| ir::FieldInit {
                name: name.into(),
                value: Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc,
                },
                absent: false,
                overflow: false,
            };
            let loc = self.loc(node);
            let null = self.coerce(
                Expr::UnitLit {
                    unit: "null",
                    r#type: Type::Null,
                    loc: loc.clone(),
                },
                encoding,
                node,
            )?;
            return Ok(Some(Expr::RecordLit {
                fields: vec![
                    ir::FieldInit {
                        name: "destroyed".into(),
                        value: Expr::LibCall {
                            r#fn: "nodeStream.destroyed".into(),
                            args: vec![obj],
                            r#type: Type::Bool,
                            loc: loc.clone(),
                        },
                        absent: false,
                        overflow: false,
                    },
                    boolean("endEmitted", loc.clone()),
                    boolean("ended", loc.clone()),
                    boolean("closeEmitted", loc.clone()),
                    boolean("dataEmitted", loc.clone()),
                    ir::FieldInit {
                        name: "encoding".into(),
                        value: null,
                        absent: false,
                        overflow: false,
                    },
                ],
                null_prototype: false,
                r#type: Type::Record { shape_id },
                loc,
            }));
        }
        if field == "cause" && self.classes.subclass(&class_name, "%Error") {
            // Error options install `cause` as an own data property only when
            // it is present. It lives in the Error object's dynamic own-key
            // store so `in`, `instanceof`, typeof and aliasing observe the
            // same payload instead of a synthesized fixed class slot.
            let value = self.coerce(obj, Type::Dyn, node.expression())?;
            return Ok(Some(self.dynamic_get(
                node,
                value,
                Expr::StrLit {
                    value: field,
                    r#type: Type::String,
                    loc: self.loc(node),
                },
            )));
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
        if let Some(value) = self.abstract_property_get(node, obj.clone(), &field)? {
            return Ok(Some(self.narrowed(value, node)?));
        }
        if node.expression().kind() == SyntaxKind::SuperKeyword {
            return Err(self.refuse(
                node,
                "super data-property reads require prototype descriptors",
            ));
        }
        if parameter_abi::is_javascript(self.classes.definitions[index].node)
            && self.classes.method(lookup, &field).is_some()
        {
            self.layout_class(index)?;
            let methods = self.classes.dynamic_method_candidates_for_type(
                &Type::Object {
                    class_name: class_name.clone(),
                },
                &field,
                &self.unions,
            );
            for method in methods {
                let owner = self
                    .classes
                    .definition_index_for_node(method.parent())
                    .ok_or_else(|| self.refuse(node, "prototype method has no owner"))?;
                self.request_dynamic_method(owner, &field, method)?;
            }
            let receiver = self.coerce(obj, Type::Dyn, node.expression())?;
            return Ok(Some(self.dynamic_get(
                node,
                receiver,
                Expr::StrLit {
                    value: field,
                    r#type: Type::String,
                    loc: self.loc(node),
                },
            )));
        }
        let mut ty = self.ensure_contract_field(&class_name, &field, node)?;
        if ty.is_none()
            && parameter_abi::is_javascript(self.classes.definitions[index].node)
            && self.checker_any(node)
            && !self
                .classes
                .prototype_fields
                .contains_key(&(index, field.clone()))
        {
            // Checked JavaScript commonly hydrates instances through a key
            // loop or a helper-owned alias and later reads a concrete property
            // by name. The read establishes the closed native slot; the
            // dynamic write dispatcher then stores that key without adding an
            // open property bag. Restrict this fallback to checker-any data:
            // typed prototype methods and accessors keep their descriptor path.
            ty = Some(self.ensure_dynamic_class_field(&class_name, &field, node)?);
        }
        if ty.is_none()
            && self
                .classes
                .prototype_fields
                .contains_key(&(index, field.clone()))
        {
            let value = self.coerce(obj, Type::Dyn, node.expression())?;
            return Ok(Some(self.narrowed(
                self.dynamic_get(
                    node,
                    value,
                    Expr::StrLit {
                        value: field,
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                ),
                node,
            )?));
        }
        if ty.is_none() && self.classes.subclass(&class_name, "%Error") {
            // Object.assign and ordinary writes may decorate an Error while
            // retaining its nominal identity. Extra own fields live in the
            // Error object's shared dynamic property store.
            let value = self.coerce(obj, Type::Dyn, node.expression())?;
            return Ok(Some(self.narrowed(
                self.dynamic_get(
                    node,
                    value,
                    Expr::StrLit {
                        value: field,
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                ),
                node,
            )?));
        }
        let ty = ty.ok_or_else(|| {
            let owner = self
                .classes
                .definitions
                .iter()
                .find(|definition| definition.name == class_name)
                .map(|definition| {
                    format!(
                        "{} in {}",
                        definition
                            .token
                            .as_ref()
                            .map_or("anonymous", |token| token.name.as_str()),
                        definition.file
                    )
                })
                .unwrap_or_else(|| "unknown class".into());
            self.refuse(
                node,
                &format!("class property {class_name}.{field} is not ported ({owner})"),
            )
        })?;
        let value = Expr::FieldGet {
            obj: Box::new(obj),
            class_name: class_name.clone(),
            field: field.clone(),
            r#type: ty,
            loc: self.loc(node),
        };
        if value.ty() == Type::Dyn {
            // Dyn is the owning representation of an own JavaScript slot.
            // Keep that representation at extraction time; a typed consumer
            // can request a checked view through `expected_expression`, while
            // a call must see the actual stored function contract rather than
            // the checker's declaration-only return type.
            return Ok(Some(value));
        }
        if let Type::Union { union_id } = value.ty()
            && self.unions[union_id]
                .arms
                .iter()
                .any(|arm| *arm == Type::Dyn)
        {
            let parent = node.parent();
            if parent.kind() == SyntaxKind::CallExpression && parent.expression() == node {
                // An own field introduced by checked JavaScript is stored as
                // a live dynamic value. Call that value directly instead of
                // first projecting it through the checker's nominal method
                // return type. Borrowed prototype methods can legitimately
                // return the borrowing receiver rather than their declaring
                // class, and the dynamic call boundary preserves that JS
                // identity without a spurious nominal result check.
                return self.coerce(value, Type::Dyn, node).map(Some);
            }
        }
        if let Type::Union { union_id } = value.ty()
            && self.unions[union_id]
                .arms
                .iter()
                .any(|arm| matches!(arm, Type::Func { .. }))
        {
            let parent = node.parent();
            if parent.kind() == SyntaxKind::CallExpression && parent.expression() == node {
                // Keep the live slot through the call. A definite-assignment
                // assertion does not prevent the field containing undefined.
                return self.coerce(value, Type::Dyn, node).map(Some);
            }
            if matches!(
                parent.kind(),
                SyntaxKind::BinaryExpression
                    | SyntaxKind::IfStatement
                    | SyntaxKind::TypeOfExpression
            ) {
                return Ok(Some(value));
            }
            if parent.kind() == SyntaxKind::VariableDeclaration && parent.initializer() == node {
                // Retain the owning tagged slot in a local. A later direct
                // call narrows/checks the callable arm without erasing either
                // the function identity or its possible undefined value.
                return Ok(Some(value));
            }
            if matches!(
                parent.kind(),
                SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression
            ) {
                return Ok(Some(value));
            }
            if parent.kind() == SyntaxKind::PropertyAccessExpression
                && parent.expression() == node
                && matches!(parent.name().text().as_ref(), "bind" | "call" | "apply")
            {
                // `this.emit.bind(this, 'connection')`: the dynamic function
                // value owns bind/call/apply (an absent slot throws there).
                return self.coerce(value, Type::Dyn, node).map(Some);
            }
            return Err(self.refuse(
                node,
                "reading a nullable function field as a value needs an owning callable contract",
            ));
        }
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
        let mut ty = if member.expression().kind() == SyntaxKind::ThisKeyword {
            self.instance_this.as_ref().map(|l| l.r#type.clone())
        } else {
            self.ty(member.expression()).ok()
        };
        if matches!(&ty, None | Some(Type::Dyn | Type::Union { .. })) {
            let mut probe = self.diagnostic_fork();
            let represented = probe
                .expression(member.expression())
                .ok()
                .map(|value| value.ty());
            if matches!(represented, Some(Type::Object { .. })) {
                ty = represented;
            }
        }
        if !matches!(ty, Some(Type::Object { .. })) {
            return Ok(None);
        }
        let obj = self.expression(member.expression())?;
        let Type::Object { class_name } = obj.ty() else {
            return Err(self.refuse(node, "class write needs an object"));
        };
        if ir::builtin_error_class(&class_name) {
            let obj = self.coerce(obj, Type::Dyn, member.expression())?;
            let key = Expr::StrLit {
                value: member.name().text().into(),
                r#type: Type::String,
                loc: self.loc(member),
            };
            return Ok(Some(self.dynamic_property_set(node, obj, key)?));
        }
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
        let ty = if let Some(ty) = self.ensure_contract_field(&class_name, &field, node)? {
            ty
        } else {
            // JavaScript can introduce an own slot from a method after the
            // constructor has run. Preserve it as owned dynamic data rather
            // than confusing it with a prototype method.
            self.ensure_dynamic_class_field(&class_name, &field, node)?
        };
        let value = self.expected_expression(node.right(), ty)?;
        Ok(Some(Stmt::FieldSet {
            obj,
            class_name,
            field,
            value,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn class_index_slot(
        &mut self,
        class_name: &str,
        field: &str,
        site: Node,
    ) -> Result<Type, String> {
        if field == "__proto__" {
            return Err(self.refuse(site, "ordinary prototype writes are not ported"));
        }
        let index = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)
            .ok_or_else(|| self.refuse(site, "indexed class property has no source descriptor"))?;
        self.layout_class(index)?;
        if self.classes.accessor(index, field).is_some()
            || self.classes.method(index, field).is_some()
        {
            return Err(self.refuse(
                site,
                "indexed class accessors and prototype methods need their native descriptors",
            ));
        }
        if let Some(ty) = self.ensure_contract_field(class_name, field, site)? {
            Ok(ty)
        } else {
            self.ensure_dynamic_class_field(class_name, field, site)
        }
    }

    /// `value instanceof Promise` against the standard constructor. Native
    /// promises share one owning representation, so a typed Promise operand
    /// is always an instance and an erased operand checks the live brand.
    /// Every other represented value is a primitive, record, array or native
    /// handle whose prototype chain cannot reach Promise.prototype. The left
    /// operand is evaluated exactly once.
    fn promise_instanceof(&mut self, node: Node) -> Result<Expr, String> {
        let value = self.expression(node.left())?;
        let loc = self.loc(node);
        let constant = |value: Expr, result: bool| Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: value,
                loc: loc.clone(),
            }],
            result: Box::new(Expr::BoolLit {
                value: result,
                r#type: Type::Bool,
                loc: loc.clone(),
            }),
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        match value.ty() {
            Type::Promise { .. } => Ok(constant(value, true)),
            Type::F64 | Type::String | Type::Bool | Type::Null | Type::Undefined | Type::Void => {
                Ok(constant(value, false))
            }
            _ => {
                let dynamic = self.coerce(value, Type::Dyn, node.left())?;
                Ok(Expr::DynTest {
                    value: Box::new(dynamic),
                    test: "promise".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc,
                })
            }
        }
    }

    pub(in crate::frontend) fn class_instanceof(&mut self, node: Node) -> Result<Expr, String> {
        if node.right().kind() == SyntaxKind::Identifier && node.right().text() == "Promise" {
            let symbol = self.symbol(node.right());
            if symbol != 0 && self.standard_promise(SymbolId(symbol)) {
                return self.promise_instanceof(node);
            }
        }
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
        if self.standard_bigint_value(node.right()) {
            // Boxed BigInt objects are outside the represented native domain;
            // every supported primitive/owned value therefore fails this brand
            // test, while the left operand is still evaluated exactly once.
            return Ok(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: value,
                    loc: self.loc(node.left()),
                }],
                result: Box::new(Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                }),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if node.right().kind() == SyntaxKind::Identifier && node.right().text() == "RegExp" && {
            let symbol = self.symbol(node.right());
            self.regex_symbol(symbol)
        } {
            return Ok(match value.ty() {
                Type::Regex => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                Type::Dyn | Type::Caught => Expr::DynTest {
                    value: Box::new(self.coerce(value, Type::Dyn, node.left())?),
                    test: "regex".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                _ => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
            });
        }
        let right_name = node.right().text();
        let typed_array = match &*right_name {
            "Uint8Array" => Some(("u8", "bytes.u8")),
            "Float32Array" => Some(("f32", "bytes.f32")),
            "Float64Array" => Some(("f64", "bytes.f64")),
            _ => None,
        };
        if node.right().kind() == SyntaxKind::Identifier
            && let Some((element, test)) = typed_array
            && {
                let symbol = self.symbol(node.right());
                self.primitive_symbol(symbol, &right_name, None)
            }
        {
            return Ok(match value.ty() {
                Type::Bytes { elem } if elem == element => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                Type::Dyn => Expr::DynTest {
                    value: Box::new(value),
                    test: test.into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                _ => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
            });
        }
        if node.right().kind() == SyntaxKind::Identifier
            && node.right().text() == "ArrayBuffer"
            && {
                let symbol = self.symbol(node.right());
                self.primitive_symbol(symbol, "ArrayBuffer", None)
            }
        {
            return Ok(match value.ty() {
                Type::Dyn | Type::Caught => Expr::DynTest {
                    value: Box::new(value),
                    test: "arrayBuffer".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                _ => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
            });
        }
        if node.right().kind() == SyntaxKind::Identifier && node.right().text() == "URL" && {
            let symbol = self.symbol(node.right());
            (!self.bindings.contains_key(&symbol)
                && !self.module_bindings.contains_key(&symbol)
                && !self.outer.iter().any(|scope| scope.contains_key(&symbol)))
                || self.primitive_symbol(symbol, "URL", None)
        } {
            let value = if value.ty() == Type::Dyn {
                value
            } else {
                self.coerce(value, Type::Dyn, node.left())?
            };
            return Ok(Expr::DynTest {
                value: Box::new(value),
                test: "url".into(),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if self.standard_buffer_value(node.right()) {
            let value = self.coerce(value, Type::Dyn, node.left())?;
            return Ok(Expr::LibCall {
                r#fn: "buffer.isBuffer".into(),
                args: vec![value],
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        let date_symbol = self.symbol(node.right());
        if node.right().kind() == SyntaxKind::Identifier
            && node.right().text() == "Date"
            && self.primitive_symbol(date_symbol, "Date", None)
        {
            return Ok(match value.ty() {
                Type::Dyn => Expr::DynTest {
                    value: Box::new(value),
                    test: "date".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                _ => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
            });
        }
        if node.right().kind() == SyntaxKind::Identifier
            && matches!(node.right().text(), "Map" | "Set")
            && {
                let symbol = self.symbol(node.right());
                self.primitive_symbol(symbol, node.right().text(), None)
            }
        {
            let brand = node.right().text().to_ascii_lowercase();
            return Ok(match (&value.ty(), brand.as_str()) {
                (Type::Map { .. }, "map") | (Type::Set { .. }, "set") => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                (Type::Dyn, _) => Expr::DynTest {
                    value: Box::new(value),
                    test: brand,
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                _ => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
            });
        }
        if self.standard_object(node.right()) {
            return Ok(match value.ty() {
                Type::Object { .. }
                | Type::Record { .. }
                | Type::Array { .. }
                | Type::Map { .. }
                | Type::Set { .. }
                | Type::Func { .. }
                | Type::Classval { .. }
                | Type::Promise { .. }
                | Type::Bytes { .. }
                | Type::Child
                | Type::Stats => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                Type::F64
                | Type::Bigint
                | Type::String
                | Type::Bool
                | Type::Symbol
                | Type::Null
                | Type::Undefined
                | Type::Void => Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node.left()),
                    }],
                    result: Box::new(Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                _ => Expr::DynTest {
                    value: Box::new(self.coerce(value, Type::Dyn, node.left())?),
                    test: "objectInstance".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
            });
        }
        let Some(index) = self.class_symbol(node.right()) else {
            let constructor = self.expression(node.right())?;
            let value = self.coerce(value, Type::Dyn, node.left())?;
            let constructor = self.coerce(constructor, Type::Dyn, node.right())?;
            return Ok(Expr::LibCall {
                r#fn: "dyn.valueInstanceof".into(),
                args: vec![value, constructor],
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        };
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
        if member.kind() == SyntaxKind::Identifier
            && let Some(index) = self.class_symbol(member)
            && self.classes.definitions[index].node.is_nil()
            && ir::builtin_error_class(&self.classes.definitions[index].name)
        {
            // The standard Error family is callable as well as constructible;
            // both forms allocate the same fresh error instance.
            let (message, options) = self.error_message(node)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "error.new".into(),
                args: std::iter::once(message).chain(options).collect(),
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
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
        let overrides = self
            .classes
            .definitions
            .iter()
            .enumerate()
            .filter(|(_, definition)| self.classes.subclass(&definition.name, "%Error"))
            .filter_map(|(index, _)| self.classes.method(index, "toString"))
            .collect::<Vec<_>>();
        for (owner, method) in overrides {
            let signature = self.request_method(owner, "toString", method)?;
            if signature.params.len() != 1 {
                return Err(self.refuse(
                    method,
                    "Error.toString override needs zero source parameters and no class captures",
                ));
            }
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
