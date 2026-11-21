//! Native builtin function values retain their identity and normal bindings.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

#[derive(Clone, Copy, PartialEq)]
enum BuiltinFunction {
    DnsLookup,
    Exec,
    ExecFile,
    Promisify,
    PromisifiedDnsLookup,
    PromisifiedExec,
    PromisifiedExecFile,
}

impl Lowerer<'_> {
    fn native_child_receiver(&mut self, node: Node) -> Result<Expr, String> {
        let value = self.expression(node)?;
        if value.ty() == Type::Child {
            return Ok(value);
        }
        if value.ty() == Type::Dyn && self.ty(node).is_ok_and(|ty| ty == Type::Child) {
            return self.coerce(value, Type::Child, node);
        }
        let Type::Union { union_id } = value.ty() else {
            return Err(self.refuse(node, "child process receiver has no native child handle"));
        };
        let children = self.unions[union_id]
            .arms
            .iter()
            .enumerate()
            .filter(|(_, arm)| **arm == Type::Child)
            .collect::<Vec<_>>();
        let [(tag, child)] = children.as_slice() else {
            return Err(self.refuse(node, "child process receiver has no unique native handle"));
        };
        Ok(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag: *tag,
            value: Box::new(value),
            r#type: (*child).clone(),
            loc: self.loc(node),
        })
    }

    fn child_spawn_origin(&mut self, node: Node) -> bool {
        let callee = receivers::reference_node(node);
        if callee.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(callee);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| *module == "child_process" && member == "spawn");
        }
        callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "spawn"
            && self.native_namespace(callee.expression()) == Some("child_process")
    }

    pub(super) fn child_spawn(&mut self, node: Node) -> Result<Expr, String> {
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=3).contains(&args.len())
            || args
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "child_process.spawn requires command, optional argv, and optional literal options",
            ));
        }
        let second_is_options = args.len() == 2
            && receivers::reference_node(args[1]).kind() == SyntaxKind::ObjectLiteralExpression;
        let options_index = if args.len() == 3 {
            Some(2)
        } else if second_is_options {
            Some(1)
        } else {
            None
        };
        let options_node = options_index.map(|index| receivers::reference_node(args[index]));
        if let Some(options) = options_node {
            if options.kind() != SyntaxKind::ObjectLiteralExpression {
                return Err(self.refuse(options, "child_process.spawn options must be literal"));
            }
            for property in options.properties() {
                if property.kind() == SyntaxKind::SpreadAssignment {
                    return Err(self.refuse(
                        property,
                        "child_process.spawn option spreads are not ported",
                    ));
                }
                let name = property.name().text();
                if !matches!(
                    name.as_ref(),
                    "cwd" | "env" | "detached" | "stdio" | "windowsHide" | "shell"
                ) {
                    return Err(self.refuse(
                        property,
                        &format!("child_process.spawn option {name:?} is not ported"),
                    ));
                }
            }
        }
        let command = self.expected_expression(args[0], Type::String)?;
        let arguments = if args.len() >= 2 && !second_is_options {
            self.expected_expression(args[1], builtins::strings())?
        } else {
            Expr::ArrayLit {
                elems: Vec::new(),
                r#type: builtins::strings(),
                loc: self.loc(node),
            }
        };
        let options = if let Some(options) = options_node {
            self.dynamic_literal(options)?
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
        self.ensure_exception_classes(node)?;
        Ok(Expr::LibCall {
            r#fn: "cp.spawn".into(),
            args: vec![command, arguments, options],
            r#type: Type::Child,
            loc: self.loc(node),
        })
    }

    pub(super) fn child_spawn_function_value(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        if !self.child_spawn_origin(node) {
            return Ok(None);
        }
        // Imported builtins are ordinary JavaScript function values. Keep one
        // native closure for the value form so nullish selection, aliases and
        // dependency injection do not have to special-case the eventual call.
        // Options remain Dyn at this boundary because Node exposes an open
        // structural object; cp.spawn reads only its represented fields.
        let params = vec![Type::String, builtins::strings(), Type::Dyn];
        let mut helper = helpers::Helper::new(
            "child_spawn_function_value",
            params.clone(),
            Type::Child,
            self.loc(node),
        );
        self.ensure_exception_classes(node)?;
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: "cp.spawn".into(),
                args: vec![
                    helper.read(&helper.param(0)),
                    helper.read(&helper.param(1)),
                    helper.read(&helper.param(2)),
                ],
                r#type: Type::Child,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: Type::Func {
                rest: false,
                params,
                ret: Box::new(Type::Child),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn child_event_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(member.name().text().as_ref(), "on" | "once")
            || !matches!(self.ty(member.expression()), Ok(Type::Child))
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 2
            || args
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "ChildProcess on/once requires an event and one listener",
            ));
        }
        let child = self.native_child_receiver(member.expression())?;
        let event = self.expected_expression(args[0], Type::String)?;
        // Promise executor callbacks and other generic listeners are often
        // stored as Dyn even though the checker exposes a contextual callable
        // view. Read the owning value directly so we preserve its actual
        // function identity instead of inserting a narrower function check.
        let listener = self.expected_expression(args[1], Type::Dyn)?;
        self.ensure_exception_classes(node)?;
        Ok(Some(Expr::LibCall {
            r#fn: format!("child.{}", member.name().text()),
            args: vec![child, event, listener],
            r#type: Type::Child,
            loc: self.loc(node),
        }))
    }

    pub(super) fn child_stdin_call(
        &mut self,
        node: Node,
        optional_end: bool,
    ) -> Result<Option<Expr>, String> {
        let method = node.expression();
        if method.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let stdin = method.expression();
        if stdin.kind() != SyntaxKind::PropertyAccessExpression
            || stdin.name().text() != "stdin"
            || !matches!(self.ty(stdin.expression()), Ok(Type::Child))
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let child = self.native_child_receiver(stdin.expression())?;
        match method.name().text().as_ref() {
            "write"
                if args.len() == 2
                    && args
                        .iter()
                        .all(|arg| arg.kind() != SyntaxKind::SpreadElement) =>
            {
                let data = self.expected_expression(args[0], Type::bytes())?;
                let callback = self.expected_expression(args[1], Type::Dyn)?;
                Ok(Some(Expr::LibCall {
                    r#fn: "child.stdinWriteCallback".into(),
                    args: vec![child, data, callback],
                    r#type: Type::Bool,
                    loc: self.loc(node),
                }))
            }
            "end" if args.is_empty() => Ok(Some(Expr::LibCall {
                r#fn: if optional_end {
                    "child.stdinEndOptional"
                } else {
                    "child.stdinEnd"
                }
                .into(),
                args: vec![child],
                r#type: Type::Void,
                loc: self.loc(node),
            })),
            _ => Err(self.refuse(
                node,
                "ChildProcess stdin method or arguments are not ported",
            )),
        }
    }

    fn spawn_sync_origin(&mut self, node: Node) -> bool {
        let callee = receivers::reference_node(node);
        if callee.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(callee);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| {
                    *module == "child_process" && member == "spawnSync"
                });
        }
        callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "spawnSync"
            && self.native_namespace(callee.expression()) == Some("child_process")
    }

    pub(super) fn spawn_sync_function_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if !self.spawn_sync_origin(node) {
            return Ok(None);
        }
        let params = vec![Type::Dyn, Type::Dyn, Type::Dyn];
        let mut helper = helpers::Helper::new(
            "spawn_sync_function_value",
            params.clone(),
            Type::Dyn,
            self.loc(node),
        );
        let command = self.coerce(helper.read(&helper.param(0)), Type::String, node)?;
        let arguments = self.coerce(
            helper.read(&helper.param(1)),
            Type::Array {
                elem: Box::new(Type::String),
            },
            node,
        )?;
        let options = helper.read(&helper.param(2));
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: "cp.spawnSyncUtf8".into(),
                args: vec![command, arguments, options],
                r#type: Type::Dyn,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: Type::Func {
                rest: false,
                params,
                ret: Box::new(Type::Dyn),
            },
            loc: self.loc(node),
        }))
    }

    fn exec_file_sync_origin(&mut self, node: Node) -> bool {
        let callee = receivers::reference_node(node);
        if callee.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(callee);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| {
                    *module == "child_process" && member == "execFileSync"
                });
        }
        callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "execFileSync"
            && self.native_namespace(callee.expression()) == Some("child_process")
    }

    pub(super) fn spawn_sync_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let exec_file = self.exec_file_sync_origin(node.expression());
        if !exec_file && !self.spawn_sync_origin(node.expression()) {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let valid_arity = if exec_file {
            args.len() == 3
        } else {
            matches!(args.len(), 2 | 3)
        };
        if !valid_arity
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                if exec_file {
                    "execFileSync requires command, arguments and literal UTF-8 options"
                } else {
                    "spawnSync requires command, arguments and literal UTF-8 options"
                },
            ));
        }
        // Node's shell overload is `spawnSync(command, options)`: the second
        // argument is options rather than argv. Keep both overloads explicit so
        // evaluation and the IR ABI stay deterministic.
        let options_index = if !exec_file && args.len() == 2 { 1 } else { 2 };
        let options = receivers::reference_node(args[options_index]);
        if options.kind() != SyntaxKind::ObjectLiteralExpression {
            return Err(self.refuse(
                options,
                if exec_file {
                    "execFileSync requires literal UTF-8 options"
                } else {
                    "spawnSync requires literal UTF-8 options"
                },
            ));
        }
        let mut utf8 = false;
        let mut buffer = false;
        let mut stdio_ignored = false;
        for property in options.properties() {
            if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                if matches!(
                    property.name().text().as_ref(),
                    "cwd" | "env" | "timeout" | "killSignal" | "maxBuffer"
                ) {
                    continue;
                }
                return Err(self.refuse(
                    property,
                    if exec_file {
                        "execFileSync shorthand option is not ported"
                    } else {
                        "spawnSync shorthand option is not ported"
                    },
                ));
            }
            if property.kind() != SyntaxKind::PropertyAssignment {
                return Err(self.refuse(
                    property,
                    if exec_file {
                        "execFileSync options require named properties"
                    } else {
                        "spawnSync options require named properties"
                    },
                ));
            }
            match property.name().text() {
                "encoding" => {
                    let value = receivers::reference_node(property.initializer());
                    if value.kind() != SyntaxKind::StringLiteral {
                        return Err(self.refuse(value, "spawnSync requires literal encoding"));
                    }
                    match value.text().as_ref() {
                        "utf8" | "utf-8" => utf8 = true,
                        "buffer" if !exec_file => buffer = true,
                        _ => return Err(self.refuse(value, "spawnSync encoding is not ported")),
                    }
                }
                "cwd" | "env" => {}
                "input" if !exec_file => {}
                "shell" if !exec_file => {
                    let value = receivers::reference_node(property.initializer());
                    if !matches!(
                        value.kind(),
                        SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword
                    ) {
                        return Err(
                            self.refuse(value, "spawnSync shell option requires a literal boolean")
                        );
                    }
                }
                "stdio" => {
                    let value = receivers::reference_node(property.initializer());
                    stdio_ignored =
                        value.kind() == SyntaxKind::StringLiteral && value.text() == "ignore";
                }
                "timeout" | "killSignal" | "maxBuffer" => {}
                _ => {
                    return Err(self.refuse(
                        property,
                        if exec_file {
                            "execFileSync option is not ported"
                        } else {
                            "spawnSync option is not ported"
                        },
                    ));
                }
            }
        }
        if !utf8 && !buffer && !stdio_ignored {
            return Err(self.refuse(
                options,
                if exec_file {
                    "execFileSync requires literal utf8 encoding"
                } else {
                    "spawnSync requires literal utf8 encoding"
                },
            ));
        }
        let command = self.expected_expression(args[0], Type::String)?;
        let arguments = if options_index == 1 {
            Expr::ArrayLit {
                elems: Vec::new(),
                r#type: builtins::strings(),
                loc: self.loc(node),
            }
        } else {
            self.expected_expression(args[1], builtins::strings())?
        };
        let options = self.dynamic_literal(options)?;
        self.ensure_exception_classes(node)?;
        Ok(Some(Expr::LibCall {
            r#fn: if exec_file {
                "cp.execFileSyncUtf8"
            } else {
                "cp.spawnSyncUtf8"
            }
            .into(),
            args: vec![command, arguments, options],
            r#type: if exec_file { Type::String } else { Type::Dyn },
            loc: self.loc(node),
        }))
    }

    pub(super) fn child_projected_type(&mut self, node: Node) -> Option<Type> {
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .is_some_and(|binding| binding.r#type == Type::Child)
            {
                return Some(Type::Child);
            }
        }
        if node.kind() == SyntaxKind::CallExpression {
            if self.spawn_sync_origin(node.expression()) {
                return Some(Type::Dyn);
            }
            if self.child_spawn_origin(node.expression()) {
                return Some(Type::Child);
            }
            let callee = node.expression();
            if callee.kind() == SyntaxKind::PropertyAccessExpression
                && callee.name().text() == "spawn"
                && self.native_namespace(callee.expression()) == Some("Bun")
            {
                return Some(Type::Child);
            }
            match self.builtin_function_origin(node.expression(), &mut HashSet::new()) {
                Some(BuiltinFunction::PromisifiedDnsLookup) => {
                    return Some(Type::Promise {
                        inner: Box::new(Type::Dyn),
                    });
                }
                Some(BuiltinFunction::Exec | BuiltinFunction::ExecFile) => {
                    return Some(Type::Child);
                }
                Some(BuiltinFunction::PromisifiedExec | BuiltinFunction::PromisifiedExecFile) => {
                    return Some(Type::Promise {
                        inner: Box::new(self.exec_file_result()),
                    });
                }
                _ => {}
            }
        }
        let origin = self.builtin_function_origin(node, &mut HashSet::new())?;
        let ret = match origin {
            BuiltinFunction::DnsLookup => return None,
            BuiltinFunction::Exec | BuiltinFunction::ExecFile => Type::Child,
            BuiltinFunction::PromisifiedDnsLookup => Type::Promise {
                inner: Box::new(Type::Dyn),
            },
            BuiltinFunction::PromisifiedExec | BuiltinFunction::PromisifiedExecFile => {
                Type::Promise {
                    inner: Box::new(self.exec_file_result()),
                }
            }
            BuiltinFunction::Promisify => return None,
        };
        Some(Type::Func {
            rest: true,
            params: vec![Type::Array {
                elem: Box::new(Type::Dyn),
            }],
            ret: Box::new(ret),
        })
    }
    pub(super) fn standard_child_symbol(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let info = self.checker.sym(SymbolId(symbol));
        info.declarations.iter().any(|decl| {
            let file = source_file_info(get_source_file_of_node(*decl));
            match info.name.as_ref() {
                "ChildProcess" | "ChildProcessWithoutNullStreams" | "ChildProcessByStdio" => {
                    file.file_name.ends_with("/child_process.d.ts")
                        && (file.file_name.contains("/@types/node/")
                            || file.file_name.contains("/bun-types/"))
                }
                "Subprocess" => {
                    file.file_name.contains("/bun-types/") && file.file_name.ends_with("/bun.d.ts")
                }
                _ => false,
            }
        })
    }

    fn builtin_function_origin(
        &mut self,
        node: Node,
        active: &mut HashSet<u32>,
    ) -> Option<BuiltinFunction> {
        let imported = if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            self.native_functions.get(&symbol).cloned()
        } else if node.kind() == SyntaxKind::PropertyAccessExpression {
            self.native_namespace(node.expression())
                .map(|module| (module, node.name().text().to_owned()))
        } else {
            None
        };
        if let Some((module, member)) = imported {
            return match (module, member.as_str()) {
                ("child_process", "exec") => Some(BuiltinFunction::Exec),
                ("child_process", "execFile") => Some(BuiltinFunction::ExecFile),
                ("dns", "lookup") => Some(BuiltinFunction::DnsLookup),
                ("util", "promisify") => Some(BuiltinFunction::Promisify),
                _ => None,
            };
        }
        if node.kind() == SyntaxKind::ParenthesizedExpression {
            return self.builtin_function_origin(node.expression(), active);
        }
        if node.kind() == SyntaxKind::CallExpression {
            let args = node.arguments();
            if args.len() == 1
                && self.builtin_function_origin(node.expression(), active)
                    == Some(BuiltinFunction::Promisify)
                && matches!(
                    self.builtin_function_origin(args.get(0), active),
                    Some(
                        BuiltinFunction::Exec
                            | BuiltinFunction::ExecFile
                            | BuiltinFunction::DnsLookup
                            | BuiltinFunction::PromisifiedDnsLookup
                            | BuiltinFunction::PromisifiedExec
                            | BuiltinFunction::PromisifiedExecFile
                    )
                )
            {
                return Some(match self.builtin_function_origin(args.get(0), active) {
                    Some(BuiltinFunction::DnsLookup | BuiltinFunction::PromisifiedDnsLookup) => {
                        BuiltinFunction::PromisifiedDnsLookup
                    }
                    Some(BuiltinFunction::Exec | BuiltinFunction::PromisifiedExec) => {
                        BuiltinFunction::PromisifiedExec
                    }
                    _ => BuiltinFunction::PromisifiedExecFile,
                });
            }
        }
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        if symbol == 0 || !active.insert(symbol) {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        let result = if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && declaration.parent().flags().intersects(NodeFlags::CONST)
            && declaration.name().kind() == SyntaxKind::Identifier
            && !declaration.initializer().is_nil()
        {
            self.builtin_function_origin(declaration.initializer(), active)
        } else {
            None
        };
        active.remove(&symbol);
        result
    }

    fn exec_file_result(&mut self) -> Type {
        let fields = ["stderr", "stdout"]
            .into_iter()
            .map(|name| ir::Field {
                name: name.into(),
                r#type: Type::String,
            })
            .collect::<Vec<_>>();
        let shape_id = self
            .records
            .iter()
            .position(|r| {
                !r.tuple
                    && !self.pending_layout(&Type::Record { shape_id: r.id })
                    && !self.enum_shape(r.id)
                    && !self.callables.contains_key(&r.id)
                    && r.index_value.is_none()
                    && r.fields == fields
            })
            .unwrap_or_else(|| {
                let id = self.records.len();
                self.records.push(ir::Record {
                    id,
                    fields,
                    tuple: false,
                    index_value: None,
                    declared_order: vec!["stdout".into(), "stderr".into()],
                });
                id
            });
        Type::Record { shape_id }
    }

    fn exec_file_value(&mut self, node: Node, promise: bool, shell: bool) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let args = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let ret = if promise {
            Type::Promise {
                inner: Box::new(self.exec_file_result()),
            }
        } else {
            Type::Child
        };
        let mut helper = helpers::Helper::new(
            if promise {
                if shell {
                    "promisified_exec"
                } else {
                    "promisified_exec_file"
                }
            } else {
                if shell { "exec" } else { "exec_file" }
            },
            vec![args],
            ret.clone(),
            self.loc(node),
        );
        helper.function.rest = true;
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: if promise {
                    if shell {
                        "cp.execPromise"
                    } else {
                        "cp.execFilePromise"
                    }
                } else {
                    if shell {
                        "cp.execNative"
                    } else {
                        "cp.execFileNative"
                    }
                }
                .into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: ret.clone(),
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
            ret: Box::new(ret),
        };
        Ok(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: ty,
            loc: self.loc(node),
        })
    }

    fn dns_lookup_value(&mut self, node: Node) -> Expr {
        let args = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let ret = Type::Promise {
            inner: Box::new(Type::Dyn),
        };
        let mut helper = helpers::Helper::new(
            "promisified_dns_lookup",
            vec![args],
            ret.clone(),
            self.loc(node),
        );
        helper.function.rest = true;
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: "dns.lookupPromisified".into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: ret.clone(),
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
                .map(|param| param.r#type.clone())
                .collect(),
            ret: Box::new(ret),
        };
        Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: ty,
            loc: self.loc(node),
        }
    }

    pub(super) fn child_builtin_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        // Alias identifiers must read their actual lexical cell (including TDZ).
        let imported = if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            self.native_functions
                .get(&symbol)
                .and_then(|(module, member)| {
                    (*module == "child_process" && matches!(member.as_str(), "exec" | "execFile"))
                        .then_some(member == "exec")
                })
        } else if node.kind() == SyntaxKind::PropertyAccessExpression {
            (self.native_namespace(node.expression()) == Some("child_process")
                && matches!(node.name().text(), "exec" | "execFile"))
            .then(|| node.name().text() == "exec")
        } else {
            None
        };
        if let Some(shell) = imported {
            self.exec_file_value(node, false, shell).map(Some)
        } else {
            Ok(None)
        }
    }

    pub(super) fn promisify_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if matches!(
            self.builtin_function_origin(node.expression(), &mut HashSet::new()),
            Some(
                BuiltinFunction::Exec
                    | BuiltinFunction::ExecFile
                    | BuiltinFunction::PromisifiedDnsLookup
            )
        ) {
            return self.call_value(node).map(Some);
        }
        if self.builtin_function_origin(node.expression(), &mut HashSet::new())
            != Some(BuiltinFunction::Promisify)
        {
            return Ok(None);
        }
        let args = node.arguments();
        let target = (args.len() == 1)
            .then(|| self.builtin_function_origin(args.get(0), &mut HashSet::new()))
            .flatten();
        if !matches!(
            target,
            Some(
                BuiltinFunction::Exec
                    | BuiltinFunction::ExecFile
                    | BuiltinFunction::DnsLookup
                    | BuiltinFunction::PromisifiedDnsLookup
                    | BuiltinFunction::PromisifiedExec
                    | BuiltinFunction::PromisifiedExecFile
            )
        ) {
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(node, "util.promisify requires one callback function"));
            }
            let argument = self.expression(args[0])?;
            let argument = self.coerce(argument, Type::Dyn, args[0])?;
            let wrapped = Expr::LibCall {
                r#fn: "util.promisify".into(),
                args: vec![argument],
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            let result_type = self.ty(node)?;
            return Ok(Some(self.coerce(wrapped, result_type, node)?));
        }
        if matches!(
            target,
            Some(BuiltinFunction::DnsLookup | BuiltinFunction::PromisifiedDnsLookup)
        ) {
            return Ok(Some(self.dns_lookup_value(node)));
        }
        let argument = self.expression(args.get(0))?;
        let shell = matches!(
            target,
            Some(BuiltinFunction::Exec | BuiltinFunction::PromisifiedExec)
        );
        let result = self.exec_file_value(node, true, shell)?;
        let ty = result.ty();
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: argument,
                loc: self.loc(node),
            }],
            result: Box::new(result),
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    pub(super) fn child_property(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = node.expression();
        let name = node.name().text();
        if self.bun_spawn_origin(receiver, &mut HashSet::new()) {
            if name == "stdin" {
                let child = self.native_child_receiver(receiver)?;
                return Ok(Some(Expr::LibCall {
                    r#fn: "bun.stdinPresent".into(),
                    args: vec![child],
                    r#type: Type::Bool,
                    loc: self.loc(node),
                }));
            }
            if name == "exited" {
                let child = self.native_child_receiver(receiver)?;
                return Ok(Some(Expr::LibCall {
                    r#fn: "bun.exited".into(),
                    args: vec![child],
                    r#type: Type::Promise {
                        inner: Box::new(Type::F64),
                    },
                    loc: self.loc(node),
                }));
            }
            if matches!(name, "stdout" | "stderr") {
                let child = self.native_child_receiver(receiver)?;
                return Ok(Some(Expr::LibCall {
                    r#fn: format!("bun.{name}"),
                    args: vec![child],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }));
            }
            if matches!(name, "pid" | "exitCode" | "signalCode" | "killed") {
                let child = self.native_child_receiver(receiver)?;
                return Ok(Some(Expr::LibCall {
                    r#fn: format!("child.{name}"),
                    args: vec![child],
                    r#type: self.ty(node)?,
                    loc: self.loc(node),
                }));
            }
            return Err(self.refuse(node, "Bun subprocess property is not ported"));
        }
        if name == "child"
            && matches!(self.ty(receiver), Ok(Type::Promise { .. }))
            && matches!(self.ty(node), Ok(Type::Child))
        {
            let promise = self.expression(receiver)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "cp.promiseChild".into(),
                args: vec![promise],
                r#type: Type::Child,
                loc: self.loc(node),
            }));
        }
        if matches!(self.ty(receiver), Ok(Type::Child)) {
            if matches!(name.as_ref(), "stdout" | "stderr") {
                let child = self.native_child_receiver(receiver)?;
                return Ok(Some(Expr::LibCall {
                    r#fn: format!("child.{name}"),
                    args: vec![child],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }));
            }
            if name == "exited" {
                let child = self.native_child_receiver(receiver)?;
                return Ok(Some(Expr::LibCall {
                    r#fn: "bun.exited".into(),
                    args: vec![child],
                    r#type: Type::Promise {
                        inner: Box::new(Type::F64),
                    },
                    loc: self.loc(node),
                }));
            }
            if !matches!(name, "pid" | "exitCode" | "signalCode" | "killed") {
                return Err(self.refuse(node, "ChildProcess member is not ported"));
            }
            let child = self.native_child_receiver(receiver)?;
            let checked = self.ty(node)?;
            let result = match name.as_ref() {
                "exitCode" => self
                    .intern_union(vec![Type::F64, Type::Null])
                    .expect("child exit code union"),
                "signalCode" => self
                    .intern_union(vec![Type::String, Type::Null])
                    .expect("child signal code union"),
                _ => checked.clone(),
            };
            let value = Expr::LibCall {
                r#fn: format!("child.{name}"),
                args: vec![child],
                r#type: result.clone(),
                loc: self.loc(node),
            };
            return self.coerce(value, checked, node).map(Some);
        }
        Ok(None)
    }
}
