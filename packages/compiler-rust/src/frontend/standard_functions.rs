//! Standard callable values retain identity and their complete argument list.
use super::*;
use helpers::Helper;

fn string_callable() -> Type {
    Type::Func {
        rest: true,
        params: vec![Type::Array {
            elem: Box::new(Type::Dyn),
        }],
        ret: Box::new(Type::String),
    }
}

fn boolean_callable() -> Type {
    Type::Func {
        rest: true,
        params: vec![Type::Array {
            elem: Box::new(Type::Dyn),
        }],
        ret: Box::new(Type::Bool),
    }
}

impl Lowerer<'_> {
    pub(super) fn standard_unescape_symbol(&self, symbol: u32) -> bool {
        if self.primitive_symbol(symbol, "unescape", None) {
            return true;
        }
        if symbol == 0 {
            return false;
        }
        let info = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        info.name.as_ref() == "unescape"
            && info.declarations.iter().any(|declaration| {
                if declaration.is_nil() {
                    return false;
                }
                let path = source_file_info(get_source_file_of_node(*declaration))
                    .file_name
                    .to_string()
                    .replace('\\', "/");
                path.ends_with("/lib/lib.es5.d.ts")
                    && (path.contains("/node_modules/typescript/")
                        || path.contains("/node_modules/@typescript/native-preview"))
            })
    }
    pub(super) fn install_standard_function_facades(&mut self) {
        let signature = Type::Func {
            rest: true,
            params: vec![Type::Array {
                elem: Box::new(Type::Dyn),
            }],
            ret: Box::new(Type::Dyn),
        };
        for record in &mut self.records {
            if record.tuple
                || record.index_value.is_some()
                || record
                    .fields
                    .iter()
                    .any(|field| field.name == callables::CALL_FIELD)
            {
                continue;
            }
            let names = record
                .fields
                .iter()
                .map(|field| field.name.as_str())
                .collect::<HashSet<_>>();
            // The bundled `Function` interface has no TypeScript call
            // signature, but JavaScript values carrying this exact facade are
            // callable. Declaration linking can erase its symbol identity, so
            // recover the private callable slot from its distinctive standard
            // surface rather than accepting arbitrary records as functions.
            if ![
                "apply",
                "bind",
                "call",
                "caller",
                "length",
                "name",
                "prototype",
            ]
            .into_iter()
            .all(|name| names.contains(name))
            {
                continue;
            }
            record.fields.push(ir::Field {
                name: callables::CALL_FIELD.into(),
                r#type: signature.clone(),
            });
            record
                .fields
                .sort_by(|left, right| left.name.cmp(&right.name));
            record
                .declared_order
                .insert(0, callables::CALL_FIELD.into());
            self.callables.insert(record.id, signature.clone());
        }
    }

    pub(super) fn unavailable_ambient_typeof(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let name = node.text().to_string();
        let symbol = self.symbol(node);
        // JavaScript deliberately permits `typeof missingName`: an
        // unresolvable reference is observed as "undefined" instead of
        // throwing. Build tools use this for feature stamps whose spelling is
        // not necessarily wrapped in double underscores (esbuild probes are a
        // common example). The checker has no symbol for those identifiers,
        // so handle them before ordinary expression lowering attempts to
        // resolve a lexical binding.
        if symbol == 0 {
            return true;
        }
        // Host facilities without a native runtime (shared memory, Atomics,
        // WebAssembly) are reported absent so feature detection selects the
        // package's portable fallback.
        if !matches!(
            name.as_str(),
            "File" | "define" | "self" | "window" | "SharedArrayBuffer" | "Atomics" | "WebAssembly"
        ) {
            return false;
        }
        if self.bindings.contains_key(&symbol)
            || self.module_bindings.contains_key(&symbol)
            || self
                .outer
                .iter()
                .rev()
                .any(|scope| scope.contains_key(&symbol))
        {
            return false;
        }
        let info = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        info.name.as_ref() == name
            && info.declarations.iter().all(|declaration| {
                declaration.is_nil()
                    || is_declaration(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(
                            *declaration,
                        ))
                        .file_name,
                    )
                    || declaration
                        .modifier_flags()
                        .intersects(ModifierFlags::AMBIENT)
            })
    }

    pub(super) fn standard_constructor_typeof(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return false;
        }
        if matches!(node.text().as_ref(), "TextEncoder" | "TextDecoder") {
            return self.standard_codec_symbol(symbol).is_some();
        }
        if !matches!(node.text().as_ref(), "Function" | "Map" | "Set" | "Date") {
            return false;
        }
        let info = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        if std::env::var_os("SCRIPTC_TRACE_STANDARD_CONSTRUCTORS").is_some() {
            eprintln!(
                "scriptc: standard constructor typeof {} {:?}",
                info.name,
                info.declarations
                    .iter()
                    .map(|declaration| (
                        declaration.kind(),
                        source_file_info(source_frontend::prelude::get_source_file_of_node(
                            *declaration,
                        ))
                        .file_name
                        .to_string()
                    ))
                    .collect::<Vec<_>>()
            );
        }
        info.name.as_ref() == node.text()
            && info.declarations.iter().any(|declaration| {
                !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(
                            *declaration,
                        ))
                        .file_name,
                    )
                    .is_some()
            })
    }

    pub(super) fn standard_function_constructor_origin(
        &mut self,
        node: Node,
        seen: &mut HashSet<u32>,
    ) -> bool {
        let node = receivers::reference_node(node);
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return false;
        }
        if self.primitive_symbol(symbol, "Function", None) {
            return true;
        }
        if !seen.insert(symbol) {
            return false;
        }
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && declaration.parent().flags().intersects(NodeFlags::CONST)
            && !declaration.initializer().is_nil()
            && self.standard_function_constructor_origin(declaration.initializer(), seen)
    }

    pub(super) fn unsupported_function_constructor(&mut self, node: Node) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let mut stmts = Vec::new();
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments
            .iter()
            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            // Although a no-engine binary cannot compile source text at
            // runtime, JavaScript still evaluates the complete argument list
            // before the constructor throws. Materialize the iterable spread
            // with the ordinary call-spread path so getters, iterators and
            // neighbouring arguments keep their left-to-right effects. This
            // also lets libraries feature-detect `Function` under try/catch
            // and select their non-JIT implementation.
            let argument_type = Type::Array {
                elem: Box::new(Type::Dyn),
            };
            stmts.push(Stmt::Expression {
                expr: self.array_spread_elements(node, arguments, argument_type)?,
                loc: self.loc(node),
            });
        } else {
            for argument in arguments {
                stmts.push(Stmt::Expression {
                    expr: self.expression(argument)?,
                    loc: self.loc(argument),
                });
            }
        }
        // The constructor always throws in a no-engine binary, but its normal
        // completion type is still callable. Keeping that ABI lets guarded
        // feature-detection/JIT code type-check without making it executable.
        let arguments = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let result_type = Type::Func {
            rest: true,
            params: vec![arguments],
            ret: Box::new(Type::Dyn),
        };
        let mut helper = Helper::new(
            "unsupported_function_constructor",
            vec![],
            result_type.clone(),
            self.loc(node),
        );
        helper.function.body.push(Stmt::Throw {
            value: Expr::LibCall {
                r#fn: "error.new".into(),
                args: vec![Expr::StrLit {
                    value:
                        "Dynamic Function construction is unavailable without a JavaScript engine"
                            .into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                }],
                r#type: Type::Object {
                    class_name: "%TypeError".into(),
                },
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        let call = Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![],
            r#type: result_type.clone(),
            loc: self.loc(node),
        };
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(call),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    fn standard_base64_global(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::Identifier || !matches!(node.text().as_ref(), "atob" | "btoa")
        {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return false;
        }
        let symbol = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        symbol.name.as_ref() == node.text()
            && !symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|declaration| {
                let info = source_file_info(source_frontend::prelude::get_source_file_of_node(
                    *declaration,
                ));
                let path = &info.file_name;
                source_frontend::frontend::bundled::bundled_lib_name(&path).is_some()
                    || path.contains("/@types/node/")
                    || path.contains("/bun-types/")
            })
    }

    // Bound functions in this chain can have signatures the checker cannot
    // describe. Preserve their owning dynamic value across inferred aliases.
    pub(super) fn bind_intrinsic_value(&mut self, node: Node, seen: &mut HashSet<u32>) -> bool {
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if symbol == 0 || !seen.insert(symbol) {
                return false;
            }
            let declaration = self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .value_declaration;
            return !declaration.is_nil()
                && declaration.kind() == SyntaxKind::VariableDeclaration
                && declaration.type_().is_nil()
                && !declaration.initializer().is_nil()
                && self.bind_intrinsic_value(declaration.initializer(), seen);
        }
        if node.kind() == SyntaxKind::CallExpression {
            let member = node.expression();
            if member.kind() == SyntaxKind::PropertyAccessExpression
                && matches!(member.name().text(), "bind" | "call" | "apply")
            {
                return self.bind_intrinsic_value(member.expression(), seen);
            }
            return self.bind_intrinsic_value(member, seen);
        }
        if node.kind() != SyntaxKind::PropertyAccessExpression || node.name().text() != "bind" {
            return false;
        }
        let receiver = node.expression();
        if receiver.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(receiver);
        self.primitive_symbol(symbol, "Function", None)
    }

    pub(super) fn standard_callable_type(&self, id: TypeId) -> Option<Type> {
        let id = self.checker.ty(id).symbol();
        if id.0 == 0 {
            return None;
        }
        let symbol = self.checker.sym(id);
        let callable = match symbol.name.as_ref() {
            "Function" => Type::Func {
                rest: true,
                params: vec![Type::Array {
                    elem: Box::new(Type::Dyn),
                }],
                ret: Box::new(Type::Dyn),
            },
            "StringConstructor" => string_callable(),
            "NumberConstructor" => number_constructor::callable(),
            "BooleanConstructor" => boolean_callable(),
            _ => return None,
        };
        (!symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                decl.kind() == SyntaxKind::InterfaceDeclaration
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(*decl))
                            .file_name,
                    )
                    .is_some()
            }))
        .then_some(callable)
    }

    fn standard_string(&mut self, node: Node) -> bool {
        node.kind() == SyntaxKind::Identifier && {
            let id = self.symbol(node);
            self.primitive_symbol(id, "String", None)
        }
    }

    fn standard_boolean(&mut self, node: Node) -> bool {
        node.kind() == SyntaxKind::Identifier && {
            let id = self.symbol(node);
            self.primitive_symbol(id, "Boolean", None)
        }
    }

    pub(super) fn standard_function_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        // CoffeeScript/Babel module wrappers: `(function() { ... }).call(this)`.
        // When the body never observes its receiver (or `arguments`), the
        // receiver is unobservable and the call is an ordinary IIFE.
        if callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "call"
            && let [receiver] = node.arguments().into_iter().collect::<Vec<_>>().as_slice()
            && receiver.kind() == SyntaxKind::ThisKeyword
        {
            let mut function = callee.expression();
            while function.kind() == SyntaxKind::ParenthesizedExpression {
                function = function.expression();
            }
            fn reads_this(node: Node) -> bool {
                if node.kind() == SyntaxKind::ThisKeyword {
                    return true;
                }
                if matches!(
                    node.kind(),
                    SyntaxKind::FunctionExpression
                        | SyntaxKind::FunctionDeclaration
                        | SyntaxKind::ClassDeclaration
                        | SyntaxKind::ClassExpression
                ) {
                    return false;
                }
                let mut found = false;
                node.for_each_child(&mut |child| {
                    found = found || reads_this(child);
                    found
                });
                found
            }
            if function.kind() == SyntaxKind::FunctionExpression
                && function.parameters().is_empty()
                && function.asterisk_token().is_nil()
                && !function.modifier_flags().intersects(ModifierFlags::ASYNC)
                && !function.body().is_nil()
                && !reads_this(function.body())
                && parameters::arguments_reference(function).is_none()
            {
                let value = self.expression(function)?;
                if let Type::Func { params, ret, rest: false } = value.ty()
                    && params.is_empty()
                {
                    return Ok(Some(Expr::CallValue {
                        callee: Box::new(value),
                        args: vec![],
                        r#type: *ret,
                        loc: self.loc(node),
                    }));
                }
            }
        }
        if callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "call"
            && callee.expression().kind() == SyntaxKind::PropertyAccessExpression
            && callee.expression().name().text() == "prototype"
            && callee.expression().expression().kind() == SyntaxKind::Identifier
            && {
                let owner = callee.expression().expression();
                let symbol = self.symbol(owner);
                self.primitive_symbol(symbol, "Function", None)
            }
        {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(
                    self.refuse(node, "Function.prototype.call value spreads are not ported")
                );
            }
            let mut stmts = Vec::with_capacity(arguments.len());
            for argument in arguments {
                stmts.push(Stmt::Expression {
                    expr: self.expression(argument)?,
                    loc: self.loc(argument),
                });
            }
            let loc = self.loc(node);
            return Ok(Some(Expr::Sequence {
                stmts,
                result: Box::new(Expr::DynFrom {
                    value: Box::new(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: loc.clone(),
                    }),
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                }),
                r#type: Type::Dyn,
                loc,
            }));
        }
        if callee.kind() == SyntaxKind::Identifier && callee.text() == "unescape" && {
            let symbol = self.symbol(callee);
            self.standard_unescape_symbol(symbol)
        } {
            let mut statements = vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "legacy.requireUnescape".into(),
                    args: vec![],
                    r#type: Type::Void,
                    loc: self.loc(callee),
                },
                loc: self.loc(callee),
            }];
            let mut first = None;
            for argument in node.arguments() {
                if argument.kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(argument, "unescape spread arguments are not ported"));
                }
                let value = self.expression(argument)?;
                let value = self.coerce(value, Type::Dyn, argument)?;
                let value = self.update_temp(value, &mut statements, argument);
                if first.is_none() {
                    first = Some(value);
                }
            }
            let first = match first {
                Some(value) => value,
                None => self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?,
            };
            self.ensure_exception_classes(node)?;
            let text = Expr::ToString {
                operand: Box::new(first),
                r#type: Type::String,
                loc: self.loc(node),
            };
            return Ok(Some(Expr::Sequence {
                stmts: statements,
                result: Box::new(Expr::StringIntrinsic {
                    method: "unescape".into(),
                    receiver: Box::new(text),
                    args: vec![],
                    r#type: Type::String,
                    loc: self.loc(node),
                }),
                r#type: Type::String,
                loc: self.loc(node),
            }));
        }
        if callee.kind() == SyntaxKind::Identifier
            && matches!(callee.text().as_ref(), "atob" | "btoa")
            && self.standard_base64_global(callee)
        {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(node, "atob/btoa require exactly one ordinary value"));
            }
            let value = self.expression(arguments[0])?;
            let receiver = if value.ty() == Type::String {
                value
            } else {
                Expr::ToString {
                    operand: Box::new(value),
                    r#type: Type::String,
                    loc: self.loc(arguments[0]),
                }
            };
            return Ok(Some(Expr::StringIntrinsic {
                method: callee.text().to_string(),
                receiver: Box::new(receiver),
                args: vec![],
                r#type: Type::String,
                loc: self.loc(node),
            }));
        }
        if callee.kind() == SyntaxKind::Identifier
            && matches!(
                callee.text().as_ref(),
                "decodeURIComponent" | "decodeURI" | "encodeURIComponent" | "encodeURI"
            )
            && {
                let symbol = self.symbol(callee);
                self.primitive_symbol(symbol, callee.text().as_ref(), None)
            }
        {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(node, "URI coding requires exactly one ordinary value"));
            }
            let receiver = self.expected_expression(arguments[0], Type::String)?;
            return Ok(Some(Expr::StringIntrinsic {
                method: callee.text().to_string(),
                receiver: Box::new(receiver),
                args: vec![],
                r#type: Type::String,
                loc: self.loc(node),
            }));
        }
        if callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "from"
            && callee.expression().kind() == SyntaxKind::Identifier
        {
            let owner = self.symbol(callee.expression());
            let member = self.symbol(callee.name());
            if self.primitive_symbol(owner, "Array", None)
                && self.primitive_symbol(member, "from", Some("ArrayConstructor"))
            {
                let arguments = node.arguments().into_iter().collect::<Vec<_>>();
                if !(1..=2).contains(&arguments.len())
                    || arguments
                        .iter()
                        .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                {
                    return Err(self.refuse(
                        node,
                        "Array.from requires a represented iterable and optional map callback",
                    ));
                }
                if arguments.len() == 2 {
                    return self.array_from_mapped(node, arguments).map(Some);
                }
                let target = self.ty(node)?;
                let source = if let Some(iteration) = self.immediate_set_iteration(arguments[0])? {
                    iteration
                } else if let Some(keys) = self.search_params_keys_array(arguments[0])? {
                    keys
                } else {
                    self.expression(arguments[0])?
                };
                // Calls across an erased JavaScript ABI carry the public
                // checker projection as DynCheck(Array<T>). Array.from must
                // consume the underlying generic container before installing
                // the typed element view on its newly cloned result.
                let (mut source, mut checked_array) = match source {
                    Expr::DynCheck {
                        value,
                        r#type: checked @ Type::Array { .. },
                        ..
                    } if value.ty() == Type::Dyn => (*value, Some(checked)),
                    Expr::DynCheck {
                        value,
                        r#type: Type::Generator { .. },
                        ..
                    } if value.ty() == Type::Dyn => (*value, Some(target.clone())),
                    source => (source, None),
                };
                if matches!(source.ty(), Type::Generator { r#async: false, .. }) {
                    // A declaration-only `Iterable<T>` is represented by the
                    // generator protocol type, while a reachable JavaScript
                    // implementation may still return an ordinary array. Keep
                    // the owning value and select the concrete array arm at
                    // this runtime `Array.from` boundary.
                    source = self.coerce(source, Type::Dyn, arguments[0])?;
                    checked_array = Some(target.clone());
                }
                if source.ty() == Type::Dyn {
                    if checked_array.is_none() {
                        let checker = self.checker.get_type_at_location(arguments[0]);
                        checked_array = self
                            .type_id(checker)
                            .filter(|checked| self.array_view(checked));
                    }
                    // `Iterable<T>` declarations commonly cross a JavaScript
                    // module ABI as Dyn even when the live value is an Array.
                    // Array.from is itself the runtime iterable boundary, so
                    // admit the represented generic array through a checked
                    // conversion and project its cloned result to the call's
                    // public element type below.
                    checked_array.get_or_insert_with(|| target.clone());
                    source = self.coerce(
                        source,
                        Type::Array {
                            elem: Box::new(Type::Dyn),
                        },
                        arguments[0],
                    )?;
                }
                let typed_bytes = match source.ty() {
                    Type::Bytes { .. } => true,
                    Type::Union { union_id } => {
                        let arms = &self.unions[union_id].arms;
                        !arms.is_empty() && arms.iter().all(|arm| matches!(arm, Type::Bytes { .. }))
                    }
                    _ => false,
                };
                if typed_bytes {
                    let source = self.coerce(source, Type::Dyn, arguments[0])?;
                    let cloned = Expr::LibCall {
                        r#fn: "array.fromTyped".into(),
                        args: vec![source],
                        r#type: Type::Array {
                            elem: Box::new(Type::F64),
                        },
                        loc: self.loc(node),
                    };
                    return Ok(Some(self.coerce(cloned, target, arguments[0])?));
                }
                if let Type::Set { elem } = source.ty() {
                    let array = Type::Array { elem };
                    let value = Expr::SetIntrinsic {
                        method: "toArray".into(),
                        receiver: Box::new(source),
                        args: vec![],
                        r#type: array,
                        loc: self.loc(node),
                    };
                    return Ok(Some(self.coerce(value, target, arguments[0])?));
                }
                let Type::Array { .. } = source.ty() else {
                    let represented = source.ty();
                    return Err(self.refuse(
                        arguments[0],
                        &format!(
                            "Array.from currently requires a represented Array, Map iterator or Set; got {represented:?}"
                        ),
                    ));
                };
                // Clone an erased JavaScript array through its generic native
                // representation first. A typed array has a specialized Rust
                // storage ABI and cannot be checked directly against the
                // generic container returned by a JavaScript implementation.
                let cloned_type = source.ty();
                let cloned = Expr::ArrayIntrinsic {
                    method: "slice".into(),
                    receiver: Box::new(source),
                    args: vec![],
                    r#type: cloned_type,
                    loc: self.loc(node),
                };
                let cloned = if let Some(checked) = checked_array
                    && cloned.ty() != checked
                {
                    self.array_checked_projection(arguments[0], cloned, checked)?
                } else {
                    cloned
                };
                return Ok(Some(self.coerce(cloned, target, arguments[0])?));
            }
        }
        if callee.kind() == SyntaxKind::Identifier && {
            let id = self.symbol(callee);
            self.primitive_symbol(id, "Array", None)
        } {
            return self.array_constructor_call(node).map(Some);
        }
        if self.standard_string(callee)
            || self.standard_number(callee)
            || self.standard_boolean(callee)
        {
            self.call_value(node).map(Some)
        } else {
            Ok(None)
        }
    }

    fn array_from_mapped(&mut self, node: Node, arguments: Vec<Node>) -> Result<Expr, String> {
        let source_node = arguments[0];
        let callback_node = receivers::reference_node(arguments[1]);
        let source = if let Some(iteration) = self.immediate_set_iteration(source_node)? {
            iteration
        } else {
            self.expression(source_node)?
        };
        let source = if let Type::Set { elem } = source.ty() {
            Expr::SetIntrinsic {
                method: "toArray".into(),
                receiver: Box::new(source),
                args: vec![],
                r#type: Type::Array { elem },
                loc: self.loc(source_node),
            }
        } else {
            source
        };
        let output = self.ty(node)?;
        let Type::Array { elem: result } = &output else {
            return Err(self.refuse(node, "Array.from map result needs a native array"));
        };
        let (input, length_field) = match source.ty() {
            Type::Array { elem } => ((*elem).clone(), None),
            Type::Record { shape_id } => {
                let field = self.records[shape_id]
                    .fields
                    .iter()
                    .find(|field| field.name == "length")
                    .cloned()
                    .ok_or_else(|| {
                        self.refuse(
                            source_node,
                            "Array.from array-like records require a numeric length field",
                        )
                    })?;
                (Type::Dyn, Some((shape_id, field)))
            }
            _ => {
                return Err(self.refuse(
                    source_node,
                    "Array.from map source requires a native array or array-like record",
                ));
            }
        };
        let inputs = [input.clone(), Type::F64];
        let callback = if matches!(
            callback_node.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) {
            if callback_node.parameters().len() > 2
                || callback_node
                    .parameters()
                    .iter()
                    .any(|parameter| !parameter.dot_dot_dot_token().is_nil())
            {
                return Err(self.refuse(
                    callback_node,
                    "Array.from map callback accepts at most two fixed native slots",
                ));
            }
            let params = callback_node
                .parameters()
                .into_iter()
                .zip(&inputs)
                .map(|(parameter, ty)| self.parameter_type(parameter, ty.clone()))
                .collect::<Result<Vec<_>, _>>()?;
            self.closure(
                callback_node,
                Some(Type::Func {
                    rest: false,
                    params,
                    ret: result.clone(),
                }),
            )?
        } else {
            self.expression(callback_node)?
        };
        let Type::Func { params, ret, rest } = callback.ty() else {
            return Err(self.refuse(
                callback_node,
                "Array.from map callback requires a native function",
            ));
        };
        if rest || params.len() > 2 {
            return Err(self.refuse(
                callback_node,
                "Array.from map callback has an unsupported native ABI",
            ));
        }
        let mut helper = Helper::new(
            "array_from_map",
            vec![source.ty(), callback.ty()],
            output.clone(),
            self.loc(node),
        );
        let source_slot = helper.param(0);
        let callback_slot = helper.param(1);
        let output_slot = helper.local("mapped array", output.clone(), false);
        let length = helper.local("length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        helper.declare(
            &output_slot,
            Expr::ArrayLit {
                elems: vec![],
                r#type: output.clone(),
                loc: helper.loc(),
            },
        );
        let length_value = if let Some((shape_id, ref field)) = length_field {
            let value = Expr::RecordGet {
                obj: Box::new(helper.read(&source_slot)),
                shape_id: format!("r{shape_id}"),
                field: field.name.clone(),
                r#type: field.r#type.clone(),
                loc: helper.loc(),
            };
            self.coerce(value, Type::F64, source_node)?
        } else {
            helper.length(&source_slot)
        };
        helper.declare(&length, length_value);
        helper.declare(&index, helper.number(0.0));
        let first = if length_field.is_some() {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: helper.loc(),
                },
                Type::Dyn,
                source_node,
            )?
        } else {
            helper.get(&source_slot, &index, input)
        };
        let provided = [first, helper.read(&index)];
        let args = params
            .iter()
            .enumerate()
            .map(|(index, target)| {
                self.coerce(provided[index].clone(), target.clone(), callback_node)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let value = Expr::CallValue {
            callee: Box::new(helper.read(&callback_slot)),
            args,
            r#type: *ret,
            loc: helper.loc(),
        };
        let value = self.coerce(value, (**result).clone(), callback_node)?;
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: vec![
                Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&output_slot)),
                        args: vec![value],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    },
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.finish(&output_slot)),
            args: vec![source, callback],
            r#type: output,
            loc: self.loc(node),
        })
    }

    pub(super) fn array_constructor_call(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(node, "Array constructor requires one non-spread argument"));
        }
        let length = self.expression(arguments[0])?;
        let ty = self.ty(node)?;
        if !matches!(&ty, Type::Array { .. }) {
            return Err(self.refuse(node, "Array constructor requires a represented array type"));
        }
        let dynamic = length.ty() == Type::Dyn;
        if length.ty() != Type::F64 && !dynamic {
            return Err(self.refuse(
                arguments[0],
                "Array constructor requires a numeric or dynamic argument",
            ));
        }
        if dynamic && !matches!(&ty, Type::Array { elem } if **elem == Type::Dyn) {
            return Err(self.refuse(node, "dynamic Array constructor requires dynamic elements"));
        }
        let mut helper = Helper::new(
            "array_constructor_length",
            vec![length.ty()],
            ty.clone(),
            self.loc(node),
        );
        let length_slot = helper.param(0);
        let array = helper.local("array", ty.clone(), false);
        helper.declare(
            &array,
            Expr::ArrayLit {
                elems: vec![],
                r#type: ty.clone(),
                loc: helper.loc(),
            },
        );
        let numeric_length = self.coerce(helper.read(&length_slot), Type::F64, node)?;
        let set_length = Stmt::ArraySetLength {
            arr: helper.read(&array),
            length: numeric_length,
            loc: helper.loc(),
        };
        if dynamic {
            let typeof_value = Expr::LibCall {
                r#fn: "dyn.typeof".into(),
                args: vec![helper.read(&length_slot)],
                r#type: Type::String,
                loc: helper.loc(),
            };
            let number = Expr::StrLit {
                value: "number".into(),
                r#type: Type::String,
                loc: helper.loc(),
            };
            let cond = Expr::StrEq {
                left: Box::new(typeof_value),
                right: Box::new(number),
                negated: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            };
            let push = Expr::ArrayIntrinsic {
                method: "push".into(),
                receiver: Box::new(helper.read(&array)),
                args: vec![helper.read(&length_slot)],
                r#type: Type::F64,
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::If {
                cond,
                then: vec![set_length],
                else_: Some(vec![Stmt::Expression {
                    expr: push,
                    loc: helper.loc(),
                }]),
                loc: helper.loc(),
            });
        } else {
            helper.function.body.push(set_length);
        }
        let callee = self.install_helper(helper.finish(&array));
        Ok(Expr::Call {
            callee,
            args: vec![length],
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn standard_function_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if let Some(value) = self.child_spawn_function_value(node)? {
            return Ok(Some(value));
        }
        if let Some(value) = self.spawn_sync_function_value(node)? {
            return Ok(Some(value));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "markResourceTiming"
            && self.standard_performance_value(node.expression())
        {
            // Undici snapshots this host hook into a module variable and calls
            // it unbound after completing a fetch. Resource timing entries are
            // observational telemetry rather than fetch control flow, so the
            // engine-free runtime keeps an ordinary variadic function value
            // that evaluates every argument and returns undefined. Keeping a
            // callable here is important: lowering the ambient `performance`
            // receiver would otherwise try to capture a declaration-file-only
            // binding.
            let arguments = Type::Array {
                elem: Box::new(Type::Dyn),
            };
            let mut helper = Helper::new(
                "performance_mark_resource_timing_value",
                vec![arguments.clone()],
                Type::Dyn,
                self.loc(node),
            );
            helper.function.rest = true;
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::DynFrom {
                    value: Box::new(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: helper.loc(),
                    }),
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            let r#type = Type::Func {
                rest: true,
                params: vec![arguments],
                ret: Box::new(Type::Dyn),
            };
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type,
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "call"
            && node.expression().kind() == SyntaxKind::Identifier
            && self.standard_function_constructor_origin(node.expression(), &mut HashSet::new())
        {
            return Ok(Some(Expr::Intrinsic {
                name: "function.call.value".into(),
                args: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::ElementAccessExpression {
            let prototype = node.expression();
            let key = node.argument_expression();
            if prototype.kind() == SyntaxKind::PropertyAccessExpression
                && prototype.name().text() == "prototype"
                && prototype.expression().kind() == SyntaxKind::Identifier
                && self.standard_function_constructor_origin(
                    prototype.expression(),
                    &mut HashSet::new(),
                )
                && key.kind() == SyntaxKind::PropertyAccessExpression
                && key.name().text() == "hasInstance"
                && self.standard_symbol(key.expression())
            {
                return Ok(Some(Expr::Intrinsic {
                    name: "function.hasInstance.value".into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }));
            }
        }
        if node.kind() == SyntaxKind::Identifier
            && self.standard_function_constructor_origin(node, &mut HashSet::new())
        {
            self.ensure_exception_classes(node)?;
            let arguments = Type::Array {
                elem: Box::new(Type::Dyn),
            };
            let mut helper = Helper::new(
                "unsupported_function_constructor_value",
                vec![arguments.clone()],
                Type::Dyn,
                self.loc(node),
            );
            helper.function.rest = true;
            helper.function.body.push(Stmt::Throw {
                value: Expr::LibCall {
                    r#fn: "error.new".into(),
                    args: vec![Expr::StrLit {
                        value: "Dynamic Function construction is unavailable without a JavaScript engine"
                            .into(),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }],
                    r#type: Type::Object {
                        class_name: "%TypeError".into(),
                    },
                    loc: helper.loc(),
                },
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: Type::Func {
                    rest: true,
                    params: vec![arguments],
                    ret: Box::new(Type::Dyn),
                },
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::Identifier && node.text() == "unescape" && {
            let symbol = self.symbol(node);
            self.standard_unescape_symbol(symbol)
        } {
            return Ok(Some(Expr::LibCall {
                r#fn: "legacy.unescapeGlobal".into(),
                args: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::Identifier
            && matches!(
                node.text().as_ref(),
                "decodeURIComponent" | "decodeURI" | "encodeURIComponent" | "encodeURI"
            )
            && {
                let symbol = self.symbol(node);
                self.primitive_symbol(symbol, node.text().as_ref(), None)
            }
        {
            // These globals are ordinary function values too, not merely
            // special direct-call syntax. Model their variadic JavaScript call
            // surface so Array.map may supply value/index/array while only the
            // first argument is observed.
            self.ensure_exception_classes(node)?;
            let arguments = Type::Array {
                elem: Box::new(Type::Dyn),
            };
            let mut helper = Helper::new(
                &format!("standard_{}_value", node.text()),
                vec![arguments.clone()],
                Type::String,
                self.loc(node),
            );
            helper.function.rest = true;
            let first = Expr::ArrayGet {
                arr: Box::new(helper.read(&helper.param(0))),
                index: Box::new(helper.number(0.0)),
                r#type: Type::Dyn,
                loc: helper.loc(),
            };
            let receiver = Expr::ToString {
                operand: Box::new(first),
                r#type: Type::String,
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::StringIntrinsic {
                    method: node.text().to_string(),
                    receiver: Box::new(receiver),
                    args: vec![],
                    r#type: Type::String,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            let r#type = Type::Func {
                params: vec![arguments],
                ret: Box::new(Type::String),
                rest: true,
            };
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type,
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "bind"
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let symbol = self.symbol(node.expression());
                self.primitive_symbol(symbol, "Function", None)
            }
        {
            // Function.bind is inherited from Function.prototype. Reading the
            // same intrinsic from a represented function keeps this within the
            // existing dynamic-property IR contract.
            let mut helper =
                Helper::new("function_bind_anchor", vec![], Type::Void, self.loc(node));
            helper.function.body.push(Stmt::Return {
                value: None,
                loc: helper.loc(),
            });
            let name = self.install_helper(helper.function);
            let anchor = Expr::Closure {
                fn_name: name,
                captures: vec![],
                r#type: Type::Func {
                    params: vec![],
                    ret: Box::new(Type::Void),
                    rest: false,
                },
                loc: self.loc(node),
            };
            let anchor = self.coerce(anchor, Type::Dyn, node)?;
            return Ok(Some(Expr::DynKeyGet {
                value: Box::new(anchor),
                key: Box::new(Expr::StrLit {
                    value: "bind".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && matches!(node.name().text(), "fromCharCode" | "fromCodePoint")
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let owner = self.symbol(node.expression());
                let member = self.symbol(node.name());
                self.primitive_symbol(owner, "String", None)
                    && self.primitive_symbol(member, node.name().text(), Some("StringConstructor"))
            }
        {
            return self
                .string_construction_value(node, node.name().text())
                .map(Some);
        }
        if self.standard_number(node) {
            return self.number_constructor_value(node).map(Some);
        }
        if self.standard_object(node) {
            // Object is both a namespace for static helpers and an ordinary
            // callable value. Dependency factories frequently retain it in a
            // variable (for example as the fallback base of a dynamic class),
            // so direct-call recognition alone is insufficient. Preserve the
            // variadic ABI and implement the callable conversion with the
            // same native ToObject operation used by `Object(value)`.
            let arguments = Type::Array {
                elem: Box::new(Type::Dyn),
            };
            let mut helper = Helper::new(
                "standard_object",
                vec![arguments.clone()],
                Type::Dyn,
                self.loc(node),
            );
            helper.function.rest = true;
            let values = helper.param(0);
            helper.function.body.push(Stmt::If {
                cond: Expr::Bin {
                    op: "===".into(),
                    left: Box::new(helper.length(&values)),
                    right: Box::new(helper.number(0.0)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Return {
                    value: Some(Expr::LibCall {
                        r#fn: "dyn.objectValue".into(),
                        args: vec![Expr::DynFrom {
                            value: Box::new(Expr::UnitLit {
                                unit: "undefined",
                                r#type: Type::Undefined,
                                loc: helper.loc(),
                            }),
                            r#type: Type::Dyn,
                            loc: helper.loc(),
                        }],
                        r#type: Type::Dyn,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
            let first = Expr::ArrayGet {
                arr: Box::new(helper.read(&values)),
                index: Box::new(helper.number(0.0)),
                r#type: Type::Dyn,
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::LibCall {
                    r#fn: "dyn.objectValue".into(),
                    args: vec![first],
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: Type::Func {
                    params: vec![arguments],
                    ret: Box::new(Type::Dyn),
                    rest: true,
                },
                loc: self.loc(node),
            }));
        }
        if self.standard_boolean(node) {
            let Type::Func { params, .. } = boolean_callable() else {
                unreachable!()
            };
            let mut helper = Helper::new(
                "standard_boolean",
                params.clone(),
                Type::Bool,
                self.loc(node),
            );
            helper.function.rest = true;
            let arguments = helper.param(0);
            helper.function.body.push(Stmt::If {
                cond: Expr::Bin {
                    op: "===".into(),
                    left: Box::new(helper.length(&arguments)),
                    right: Box::new(helper.number(0.0)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Return {
                    value: Some(Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
            let first = Expr::ArrayGet {
                arr: Box::new(helper.read(&arguments)),
                index: Box::new(helper.number(0.0)),
                r#type: Type::Dyn,
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::DynTest {
                    value: Box::new(first),
                    test: "truthy".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: Type::Func {
                    params,
                    ret: Box::new(Type::Bool),
                    rest: true,
                },
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "isArray"
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let owner = self.symbol(node.expression());
                let member = self.symbol(node.name());
                self.primitive_symbol(owner, "Array", None)
                    && self.primitive_symbol(member, "isArray", Some("ArrayConstructor"))
            }
        {
            // Array.isArray is frequently passed directly to every/filter.
            // Model its ordinary JavaScript variadic call surface: the first
            // argument is observed and additional callback arguments are
            // ignored; an omitted first argument behaves as undefined.
            let arguments = Type::Array {
                elem: Box::new(Type::Dyn),
            };
            let mut helper = Helper::new(
                "array_is_array_value",
                vec![arguments.clone()],
                Type::Bool,
                self.loc(node),
            );
            helper.function.rest = true;
            let value = Expr::ArrayGet {
                arr: Box::new(helper.read(&helper.param(0))),
                index: Box::new(helper.number(0.0)),
                r#type: Type::Dyn,
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::DynTest {
                    value: Box::new(value),
                    test: "array".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            let r#type = Type::Func {
                params: vec![arguments],
                ret: Box::new(Type::Bool),
                rest: true,
            };
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type,
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "random"
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let owner = self.symbol(node.expression());
                let member = self.symbol(node.name());
                self.primitive_symbol(owner, "Math", None)
                    && self.primitive_symbol(member, "random", Some("Math"))
            }
        {
            let mut helper = Helper::new("math_random_value", vec![], Type::F64, self.loc(node));
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::LibCall {
                    r#fn: "math.random".into(),
                    args: vec![],
                    r#type: Type::F64,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: Type::Func {
                    params: vec![],
                    ret: Box::new(Type::F64),
                    rest: false,
                },
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let owner = self.symbol(node.expression());
                let member = self.symbol(node.name());
                self.primitive_symbol(owner, "Math", None)
                    && self.primitive_symbol(member, node.name().text(), Some("Math"))
            }
            && let Some(operation) = crate::builtins::get("Math", node.name().text())
            && operation.args == [Type::F64]
            && operation.result == Type::F64
        {
            let mut helper = Helper::new(
                &format!("math_{}_value", node.name().text()),
                vec![Type::F64],
                Type::F64,
                self.loc(node),
            );
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::LibCall {
                    r#fn: operation.ir.into(),
                    args: vec![helper.read(&helper.param(0))],
                    r#type: Type::F64,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: Type::Func {
                    params: vec![Type::F64],
                    ret: Box::new(Type::F64),
                    rest: false,
                },
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "now"
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let owner = self.symbol(node.expression());
                let member = self.symbol(node.name());
                self.primitive_symbol(owner, "Date", None)
                    && self.primitive_symbol(member, "now", Some("DateConstructor"))
            }
        {
            let mut helper = Helper::new("date_now_value", vec![], Type::F64, self.loc(node));
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::LibCall {
                    r#fn: "date.now".into(),
                    args: vec![],
                    r#type: Type::F64,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: Type::Func {
                    params: vec![],
                    ret: Box::new(Type::F64),
                    rest: false,
                },
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "parse"
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let owner = self.symbol(node.expression());
                let member = self.symbol(node.name());
                self.primitive_symbol(owner, "Date", None)
                    && self.primitive_symbol(member, "parse", Some("DateConstructor"))
            }
        {
            let mut helper = Helper::new(
                "date_parse_value",
                vec![Type::String],
                Type::F64,
                self.loc(node),
            );
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::LibCall {
                    r#fn: "date.parseString".into(),
                    args: vec![helper.read(&helper.param(0))],
                    r#type: Type::F64,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: Type::Func {
                    params: vec![Type::String],
                    ret: Box::new(Type::F64),
                    rest: false,
                },
                loc: self.loc(node),
            }));
        }
        if !self.standard_string(node) {
            return Ok(None);
        }
        self.ensure_exception_classes(node)?;
        let Type::Func { params, .. } = string_callable() else {
            unreachable!()
        };
        let mut helper = Helper::new("standard_string", params, Type::String, self.loc(node));
        helper.function.rest = true;
        let arguments = helper.param(0);
        let length = helper.length(&arguments);
        helper.function.body.push(Stmt::If {
            cond: Expr::Bin {
                op: "===".into(),
                left: Box::new(length),
                right: Box::new(helper.number(0.0)),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(Expr::StrLit {
                    value: "".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        let value = Expr::ArrayGet {
            arr: Box::new(helper.read(&arguments)),
            index: Box::new(helper.number(0.0)),
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: "dyn.stringConstructor".into(),
                args: vec![value],
                r#type: Type::String,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: string_callable(),
            loc: self.loc(node),
        }))
    }
}
