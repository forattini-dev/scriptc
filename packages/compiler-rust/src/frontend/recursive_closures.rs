//! Recursive lexical functions need a cell before their closure is built.
use super::*;

impl Lowerer<'_> {
    fn deferred_tls_initializer(&mut self, initializer: Node, symbol: u32) -> bool {
        let initializer = primitives::primitive_source(initializer);
        if initializer.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let args = initializer.arguments().into_iter().collect::<Vec<_>>();
        let [options, callback] = args.as_slice() else {
            return false;
        };
        if !matches!(
            callback.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) || self.closure_mentions(*options, symbol)
            || !self.closure_mentions(*callback, symbol)
        {
            return false;
        }
        let callee = initializer.expression();
        if callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "connect"
        {
            self.native_namespace(callee.expression()) == Some("tls")
        } else if callee.kind() == SyntaxKind::Identifier {
            let id = self.native_symbol(callee);
            self.native_functions
                .get(&id)
                .is_some_and(|(module, member)| *module == "tls" && member == "connect")
        } else {
            false
        }
    }

    fn deferred_timer_initializer(&mut self, initializer: Node) -> bool {
        let initializer = primitives::primitive_source(initializer);
        if initializer.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let callee = primitives::primitive_source(initializer.expression());
        if callee.kind() != SyntaxKind::Identifier
            || !matches!(callee.text().as_ref(), "setTimeout" | "setInterval")
        {
            return false;
        }
        let symbol = self.symbol(callee);
        if symbol == 0 {
            return false;
        }
        let symbol = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        let declaration = symbol.value_declaration;
        if declaration.is_nil() || symbol.name.as_ref() != callee.text() {
            return false;
        }
        let path = &source_file_info(get_source_file_of_node(declaration)).file_name;
        source_frontend::frontend::bundled::bundled_lib_name(path).is_some()
            || path.contains("/node_modules/@types/node/")
            || path.contains("/node_modules/bun-types/")
    }

    pub(super) fn closure_mentions(&mut self, node: Node, symbol: u32) -> bool {
        if node.kind() == SyntaxKind::Identifier && self.symbol(node) == symbol {
            return true;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            if !found {
                found = self.closure_mentions(child, symbol);
            }
            false
        });
        found
    }

    fn referenced_local_functions(
        &mut self,
        node: Node,
        candidates: &HashSet<u32>,
        found: &mut HashSet<u32>,
    ) {
        if node.is_nil() {
            return;
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if candidates.contains(&symbol) {
                found.insert(symbol);
            }
        }
        node.for_each_child(&mut |child| {
            self.referenced_local_functions(child, candidates, found);
            false
        });
    }

    /// A closure may capture a lexical binding declared later in the same
    /// block. JavaScript creates the first closure before the later lexical
    /// initializer runs, but the captured binding cell itself already exists.
    /// Put only those forward-referenced bindings in traced dynamic cells;
    /// their declaration still performs the actual initialization in source
    /// order.
    pub(super) fn hoist_forward_closures(&mut self, block: Node) -> Result<Vec<Stmt>, String> {
        if block.kind() != SyntaxKind::Block {
            return Ok(Vec::new());
        }
        let statements = block.statements().into_iter().collect::<Vec<_>>();
        let mut body = Vec::new();
        // Hoisted function declarations may capture a class in this block
        // before its declaration has been lowered. Create only the lexical
        // cell here; evaluating the class and its heritage stays at its source
        // location, and reads before then retain the temporal dead zone.
        for statement in statements.iter().copied() {
            if statement.kind() != SyntaxKind::ClassDeclaration
                || statement.name().kind() != SyntaxKind::Identifier
            {
                continue;
            }
            let symbol = self.symbol(statement.name());
            if symbol == 0 || self.bindings.contains_key(&symbol) {
                continue;
            }
            let captured = statements.iter().any(|function| {
                function.kind() == SyntaxKind::FunctionDeclaration
                    && (self.closure_mentions(function.body(), symbol)
                        || function
                            .parameters()
                            .into_iter()
                            .any(|parameter| self.closure_mentions(parameter, symbol)))
            });
            if !captured {
                continue;
            }
            let Some(index) = self.classes.definition_index_for_node(statement) else {
                continue;
            };
            let Some(class_name) = self.classes.definition_name_at(index, statement) else {
                continue;
            };
            let local = Local {
                id: format!("v{}", self.locals.len()),
                name: statement.name().text().into(),
                r#type: Type::Dyn,
                mutable: true,
                boxed: true,
            };
            self.locals.push(local.clone());
            self.bindings.insert(symbol, local.clone());
            self.recursive_functions
                .insert(symbol, Type::Classval { class_name });
            body.push(Stmt::VarDecl {
                local_id: local.id,
                init: Expr::LibCall {
                    r#fn: "lexical.empty".into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: self.loc(statement),
                },
                loc: self.loc(statement),
            });
        }
        // Allocate every forward lexical cell before materializing hoisted
        // function declarations. A hoisted function can capture a `const`
        // declared later in the block (for example onCancel/onWake), while an
        // earlier timer initializer can simultaneously reference that function.
        for statement in statements.iter().copied() {
            if statement.kind() != SyntaxKind::VariableStatement {
                continue;
            }
            let list = statement.declaration_list();
            if !list.flags().intersects(NodeFlags::LET | NodeFlags::CONST) {
                continue;
            }
            for declaration in list.declarations().nodes() {
                if declaration.initializer().is_nil()
                    || !matches!(
                        declaration.name().kind(),
                        SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern
                    )
                {
                    continue;
                }
                let mut names = Vec::new();
                bindings::names(declaration.name(), &mut names);
                for name in names {
                    let symbol = self.symbol(name);
                    if symbol == 0 || self.bindings.contains_key(&symbol) {
                        continue;
                    }
                    let captured_by_hoisted = statements.iter().any(|function| {
                        function.kind() == SyntaxKind::FunctionDeclaration
                            && function.name().kind() == SyntaxKind::Identifier
                            && (self.closure_mentions(function.body(), symbol)
                                || function
                                    .parameters()
                                    .into_iter()
                                    .any(|parameter| self.closure_mentions(parameter, symbol)))
                    });
                    if std::env::var_os("SCRIPTC_TRACE_BINDINGS").is_some() {
                        eprintln!(
                            "scriptc: forward destructured candidate name={} symbol={} captured={}",
                            name.text(),
                            symbol,
                            captured_by_hoisted
                        );
                    }
                    if !captured_by_hoisted {
                        continue;
                    }
                    let ty = self.storage_type(name)?;
                    if matches!(
                        ty,
                        Type::Void | Type::Undefined | Type::Caught | Type::Classval { .. }
                    ) || self.dynamic_erasure_reason(&ty).is_some()
                    {
                        return Err(self.refuse(
                            name,
                            "forward destructured closure binding requires a dynamically representable native value",
                        ));
                    }
                    let local = Local {
                        id: format!("v{}", self.locals.len()),
                        name: name.text().into(),
                        r#type: Type::Dyn,
                        mutable: true,
                        boxed: true,
                    };
                    self.locals.push(local.clone());
                    self.bindings.insert(symbol, local.clone());
                    self.recursive_functions.insert(symbol, ty);
                    body.push(Stmt::VarDecl {
                        local_id: local.id,
                        init: self.coerce(
                            Expr::UnitLit {
                                unit: "undefined",
                                r#type: Type::Undefined,
                                loc: self.loc(name),
                            },
                            Type::Dyn,
                            name,
                        )?,
                        loc: self.loc(name),
                    });
                }
            }
        }
        for (index, statement) in statements.iter().copied().enumerate() {
            if statement.kind() != SyntaxKind::VariableStatement {
                continue;
            }
            let list = statement.declaration_list();
            if !list.flags().intersects(NodeFlags::LET | NodeFlags::CONST) {
                continue;
            }
            for declaration in list.declarations().nodes() {
                if declaration.name().kind() != SyntaxKind::Identifier {
                    continue;
                }
                let symbol = self.symbol(declaration.name());
                if symbol == 0 || self.bindings.contains_key(&symbol) {
                    continue;
                }
                let mut captured = false;
                let mut eager = false;
                for earlier in &statements[..index] {
                    self.delayed_mentions(*earlier, symbol, false, &mut captured, &mut eager);
                }
                if !captured && !eager {
                    captured = statements.iter().any(|function| {
                        function.kind() == SyntaxKind::FunctionDeclaration
                            && function.name().kind() == SyntaxKind::Identifier
                            && (self.closure_mentions(function.body(), symbol)
                                || function
                                    .parameters()
                                    .into_iter()
                                    .any(|parameter| self.closure_mentions(parameter, symbol)))
                    });
                }
                if !captured || eager {
                    continue;
                }
                let ty = self.storage_type(declaration.name())?;
                let ty = if declaration.initializer().is_nil() {
                    self.undefined_storage_type(ty, declaration)?
                } else {
                    ty
                };
                if matches!(
                    ty,
                    Type::Void | Type::Undefined | Type::Caught | Type::Classval { .. }
                ) || self.dynamic_erasure_reason(&ty).is_some()
                {
                    return Err(self.refuse(
                        declaration,
                        "forward closure binding requires a dynamically representable native value",
                    ));
                }
                let local = Local {
                    id: format!("v{}", self.locals.len()),
                    name: declaration.name().text().into(),
                    r#type: Type::Dyn,
                    mutable: true,
                    boxed: true,
                };
                self.locals.push(local.clone());
                self.bindings.insert(symbol, local.clone());
                self.recursive_functions.insert(symbol, ty);
                let init = if declaration.initializer().is_nil() {
                    Expr::LibCall {
                        r#fn: "lexical.empty".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc: self.loc(declaration),
                    }
                } else {
                    self.coerce(
                        Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: self.loc(declaration),
                        },
                        Type::Dyn,
                        declaration,
                    )?
                };
                body.push(Stmt::VarDecl {
                    local_id: local.id,
                    init,
                    loc: self.loc(declaration),
                });
            }
        }
        // A function hoisted for a forward reference can itself capture an
        // earlier sibling. That sibling must also exist when the hoisted
        // closure is built; repeat transitively before initializing any cells.
        let mut local_functions = HashMap::new();
        let mut required = HashSet::new();
        for (index, statement) in statements.iter().copied().enumerate() {
            if statement.kind() != SyntaxKind::FunctionDeclaration
                || statement.name().kind() != SyntaxKind::Identifier
            {
                continue;
            }
            let symbol = self.symbol(statement.name());
            if symbol == 0 || self.bindings.contains_key(&symbol) {
                continue;
            }
            local_functions.insert(symbol, statement);
            let mut captured = false;
            let mut eager = false;
            for earlier in &statements[..index] {
                self.delayed_mentions(*earlier, symbol, false, &mut captured, &mut eager);
            }
            if captured || eager {
                required.insert(symbol);
            }
        }
        let candidates = local_functions.keys().copied().collect::<HashSet<_>>();
        let mut pending = required.iter().copied().collect::<Vec<_>>();
        while let Some(symbol) = pending.pop() {
            let function = local_functions[&symbol];
            let mut referenced = HashSet::new();
            self.referenced_local_functions(function.body(), &candidates, &mut referenced);
            for parameter in function.parameters() {
                self.referenced_local_functions(parameter, &candidates, &mut referenced);
            }
            for dependency in referenced {
                if required.insert(dependency) {
                    pending.push(dependency);
                }
            }
        }
        let mut hoisted = Vec::new();
        for statement in statements.iter().copied() {
            if statement.kind() != SyntaxKind::FunctionDeclaration
                || statement.name().kind() != SyntaxKind::Identifier
            {
                continue;
            }
            let symbol = self.symbol(statement.name());
            if !required.contains(&symbol) {
                continue;
            }
            let ty = self.storage_type(statement.name())?;
            if !matches!(ty, Type::Func { .. }) {
                return Err(self.refuse(
                    statement,
                    "forward local function requires a native callable signature",
                ));
            }
            let local = Local {
                id: format!("v{}", self.locals.len()),
                name: statement.name().text().into(),
                r#type: Type::Dyn,
                mutable: true,
                boxed: true,
            };
            self.locals.push(local.clone());
            self.bindings.insert(symbol, local.clone());
            self.recursive_functions.insert(symbol, ty.clone());
            body.push(Stmt::VarDecl {
                local_id: local.id.clone(),
                init: self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(statement),
                    },
                    Type::Dyn,
                    statement,
                )?,
                loc: self.loc(statement),
            });
            hoisted.push((statement, symbol, ty, local));
        }
        // Every function cell must exist before any hoisted closure is built:
        // one function declaration can capture a sibling declared later.
        for (statement, symbol, ty, local) in hoisted {
            let init = self.closure(statement, Some(ty))?;
            let init = self.coerce(init, Type::Dyn, statement)?;
            body.push(Stmt::Assign {
                local_id: local.id,
                value: init,
                initializes_global: false,
                loc: self.loc(statement),
            });
            self.hoisted_function_initializers.insert(symbol);
        }
        for (index, statement) in statements.iter().copied().enumerate() {
            if statement.kind() == SyntaxKind::FunctionDeclaration {
                let name = statement.name();
                if name.is_nil() || name.kind() != SyntaxKind::Identifier {
                    continue;
                }
                let symbol = self.symbol(name);
                if symbol == 0 || self.bindings.contains_key(&symbol) {
                    continue;
                }
                let mut captured = false;
                let mut eager = false;
                for earlier in &statements[..index] {
                    self.delayed_mentions(*earlier, symbol, false, &mut captured, &mut eager);
                }
                if !captured && !eager {
                    continue;
                }
                let ty = self.storage_type(name)?;
                if !matches!(ty, Type::Func { .. }) {
                    return Err(self.refuse(
                        statement,
                        "forward local function requires a native callable signature",
                    ));
                }
                let local = Local {
                    id: format!("v{}", self.locals.len()),
                    name: name.text().into(),
                    r#type: Type::Dyn,
                    mutable: true,
                    boxed: true,
                };
                self.locals.push(local.clone());
                self.bindings.insert(symbol, local.clone());
                self.recursive_functions.insert(symbol, ty.clone());
                body.push(Stmt::VarDecl {
                    local_id: local.id.clone(),
                    init: self.coerce(
                        Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: self.loc(statement),
                        },
                        Type::Dyn,
                        statement,
                    )?,
                    loc: self.loc(statement),
                });
                let init = self.closure(statement, Some(ty))?;
                let init = self.coerce(init, Type::Dyn, statement)?;
                body.push(Stmt::Assign {
                    local_id: local.id,
                    value: init,
                    initializes_global: false,
                    loc: self.loc(statement),
                });
                self.hoisted_function_initializers.insert(symbol);
                continue;
            }
            if statement.kind() != SyntaxKind::VariableStatement {
                continue;
            }
            let list = statement.declaration_list();
            if !list.flags().intersects(NodeFlags::LET | NodeFlags::CONST) {
                continue;
            }
            for declaration in list.declarations().nodes() {
                if declaration.name().kind() != SyntaxKind::Identifier
                    || declaration.initializer().is_nil()
                {
                    continue;
                }
                let symbol = self.symbol(declaration.name());
                if symbol == 0 || self.bindings.contains_key(&symbol) {
                    continue;
                }
                let mut captured = false;
                let mut eager = false;
                for earlier in &statements[..index] {
                    self.delayed_mentions(*earlier, symbol, false, &mut captured, &mut eager);
                }
                if !captured && !eager {
                    for later in &statements[index + 1..] {
                        if later.kind() != SyntaxKind::FunctionDeclaration
                            || later.name().kind() != SyntaxKind::Identifier
                        {
                            continue;
                        }
                        let function_symbol = self.symbol(later.name());
                        if function_symbol != 0
                            && self.closure_mentions(later.body(), symbol)
                            && self.closure_mentions(declaration.initializer(), function_symbol)
                        {
                            captured = true;
                            break;
                        }
                    }
                }
                if !captured || eager {
                    continue;
                }
                let ty = self.storage_type(declaration.name())?;
                if matches!(
                    ty,
                    Type::Void | Type::Undefined | Type::Caught | Type::Classval { .. }
                ) || self.dynamic_erasure_reason(&ty).is_some()
                {
                    return Err(self.refuse(
                        declaration,
                        "forward closure binding requires a dynamically representable native value",
                    ));
                }
                let local = Local {
                    id: format!("v{}", self.locals.len()),
                    name: declaration.name().text().into(),
                    r#type: Type::Dyn,
                    mutable: true,
                    boxed: true,
                };
                self.locals.push(local.clone());
                self.bindings.insert(symbol, local.clone());
                self.recursive_functions.insert(symbol, ty);
                body.push(Stmt::VarDecl {
                    local_id: local.id,
                    init: self.coerce(
                        Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: self.loc(declaration),
                        },
                        Type::Dyn,
                        declaration,
                    )?,
                    loc: self.loc(declaration),
                });
            }
        }
        Ok(body)
    }

    pub(super) fn initialize_forward_closure(
        &mut self,
        declaration: Node,
        flags: NodeFlags,
    ) -> Result<Option<Vec<Stmt>>, String> {
        if !flags.intersects(NodeFlags::LET | NodeFlags::CONST) {
            return Ok(None);
        }
        let symbol = self.symbol(declaration.name());
        let Some(ty) = self.recursive_functions.get(&symbol).cloned() else {
            return Ok(None);
        };
        let Some(local) = self.bindings.get(&symbol).cloned() else {
            return Ok(None);
        };
        if local.r#type != Type::Dyn || !local.boxed {
            return Ok(None);
        }
        let value = if declaration.initializer().is_nil() {
            self.var_types.insert(symbol, ty);
            self.var_defined.remove(&symbol);
            let value = self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(declaration),
                },
                Type::Dyn,
                declaration,
            )?;
            Expr::LibCall {
                r#fn: "lexical.initialize".into(),
                args: vec![value],
                r#type: Type::Dyn,
                loc: self.loc(declaration),
            }
        } else {
            let value = self.expected_expression(declaration.initializer(), ty)?;
            self.coerce(value, Type::Dyn, declaration.initializer())?
        };
        if flags.intersects(NodeFlags::CONST)
            && let Some(binding) = self.bindings.get_mut(&symbol)
        {
            binding.mutable = false;
        }
        Ok(Some(vec![Stmt::Assign {
            local_id: local.id,
            value,
            initializes_global: false,
            loc: self.loc(declaration),
        }]))
    }

    /// Object literals may publish methods which close over the object being
    /// initialized.  The binding exists while those closures are created, but
    /// an ordinary read in the initializer is still in the lexical TDZ.
    fn delayed_mentions(
        &mut self,
        node: Node,
        symbol: u32,
        delayed: bool,
        captured: &mut bool,
        eager: &mut bool,
    ) {
        if node.kind() == SyntaxKind::Identifier && self.symbol(node) == symbol {
            if delayed {
                *captured = true;
            } else {
                *eager = true;
            }
            return;
        }
        if matches!(
            node.kind(),
            SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
        ) {
            // A computed method/accessor key is evaluated while the object is
            // constructed, but its parameters and body execute only after the
            // resulting property is called. Keep that distinction so a method
            // can close over the object being initialized without accidentally
            // accepting an eager TDZ read in its computed key.
            self.delayed_mentions(node.name(), symbol, delayed, captured, eager);
            for parameter in node.parameters() {
                self.delayed_mentions(parameter, symbol, true, captured, eager);
            }
            if !node.body().is_nil() {
                self.delayed_mentions(node.body(), symbol, true, captured, eager);
            }
            return;
        }
        let delayed = delayed
            || matches!(
                node.kind(),
                SyntaxKind::ArrowFunction
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::FunctionDeclaration
            );
        node.for_each_child(&mut |child| {
            self.delayed_mentions(child, symbol, delayed, captured, eager);
            false
        });
    }

    pub(super) fn recursive_const_closure(
        &mut self,
        declaration: Node,
        flags: NodeFlags,
        module: bool,
    ) -> Result<Option<Vec<Stmt>>, String> {
        let initializer = declaration.initializer();
        if module || !flags.intersects(NodeFlags::CONST) {
            return Ok(None);
        }
        let name = declaration.name();
        let symbol = self.symbol(name);
        if symbol == 0 {
            return Ok(None);
        }
        let direct_closure = matches!(
            initializer.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        );
        let deferred_tls = self.deferred_tls_initializer(initializer, symbol);
        let call_initializer = matches!(
            primitives::primitive_source(initializer).kind(),
            SyntaxKind::NewExpression | SyntaxKind::CallExpression
        );
        let recursive = if direct_closure {
            self.closure_mentions(initializer, symbol)
        } else if initializer.kind() == SyntaxKind::ObjectLiteralExpression
            || call_initializer
            || self.deferred_timer_initializer(initializer)
            || deferred_tls
        {
            let mut captured = false;
            let mut eager = false;
            self.delayed_mentions(initializer, symbol, false, &mut captured, &mut eager);
            captured && !eager
        } else {
            false
        };
        if !recursive {
            return Ok(None);
        }
        let ty = if deferred_tls {
            Type::Dyn
        } else {
            self.storage_type(name)?
        };
        if matches!(
            ty,
            Type::Void | Type::Undefined | Type::Caught | Type::Classval { .. }
        ) || self.dynamic_erasure_reason(&ty).is_some()
        {
            return Err(self.refuse(
                declaration,
                "recursive closure requires a dynamically representable native signature",
            ));
        }
        self.recursive_functions.insert(symbol, ty.clone());
        // The synthetic assignment initializes the cell after the closure
        // captures it. Source const writes are rejected through the binding.
        let local = Local {
            id: format!("v{}", self.locals.len()),
            name: name.text().into(),
            r#type: Type::Dyn,
            mutable: false,
            boxed: true,
        };
        self.bindings.insert(symbol, local.clone());
        let mut storage = local.clone();
        storage.mutable = true;
        self.locals.push(storage);
        // A call or constructor may invoke a captured callback immediately,
        // before the const initializer has completed. Keep the cell in the
        // TDZ until evaluation succeeds, so such reads throw ReferenceError.
        let initial_cell = if call_initializer {
            Expr::LibCall {
                r#fn: "lexical.empty".into(),
                args: vec![],
                r#type: Type::Dyn,
                loc: self.loc(declaration),
            }
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(declaration),
                },
                Type::Dyn,
                declaration,
            )?
        };
        let value = self.expected_expression(initializer, ty.clone())?;
        // This private cell never escapes as a dynamic value. Recursive reads
        // check it back to the exact function ABI before exposing the value.
        let value = if value.ty() == Type::Dyn {
            value
        } else {
            Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(declaration),
            }
        };
        let value = if call_initializer {
            Expr::LibCall {
                r#fn: "lexical.initialize".into(),
                args: vec![value],
                r#type: Type::Dyn,
                loc: self.loc(declaration),
            }
        } else {
            value
        };
        let published = Local {
            id: format!("v{}", self.locals.len()),
            name: name.text().into(),
            r#type: ty.clone(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(published.clone());
        self.bindings.insert(symbol, published.clone());
        let read = Expr::VarRef {
            local_id: local.id.clone(),
            r#type: Type::Dyn,
            loc: self.loc(declaration),
        };
        let checked = if ty == Type::Dyn {
            read
        } else {
            Expr::DynCheck {
                value: Box::new(read),
                r#type: ty,
                loc: self.loc(declaration),
            }
        };
        Ok(Some(vec![
            Stmt::VarDecl {
                local_id: local.id.clone(),
                init: initial_cell,
                loc: self.loc(declaration),
            },
            Stmt::Assign {
                local_id: local.id,
                value,
                initializes_global: false,
                loc: self.loc(declaration),
            },
            Stmt::VarDecl {
                local_id: published.id,
                init: checked,
                loc: self.loc(declaration),
            },
        ]))
    }
}
