//! Proven standard primitives lower through typed, eager argument boundaries.
use super::*;
use helpers::Helper;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

impl Lowerer<'_> {
    pub(super) fn standard_performance_value(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::Identifier || node.text() != "performance" {
            return false;
        }
        let id = self.checker.get_symbol_at_location(node, false);
        let lexical = id.0 != 0
            && (self.bindings.contains_key(&id.0)
                || self.module_bindings.contains_key(&id.0)
                || self
                    .outer
                    .iter()
                    .rev()
                    .any(|scope| scope.contains_key(&id.0)));
        id.0 != 0
            && !lexical
            && self.checker.sym(id).declarations.iter().any(|declaration| {
                if declaration.is_nil() {
                    return false;
                }
                let path = &source_file_info(get_source_file_of_node(*declaration)).file_name;
                source_frontend::frontend::bundled::bundled_lib_name(path).is_some()
                    || path.contains("@types/node")
            })
    }

    fn erased_number_radix_chain(&mut self, node: Node, member: Node) -> bool {
        if member.name().text() != "toString"
            || node.arguments().len() != 1
            || node.arguments().first().is_none_or(|argument| {
                argument.kind() == SyntaxKind::SpreadElement
                    || !(argument.kind() == SyntaxKind::NumericLiteral
                        || self.ty(argument).is_ok_and(|ty| ty == Type::F64))
            })
        {
            return false;
        }
        let parent = node.parent();
        parent.kind() == SyntaxKind::PropertyAccessExpression && parent.name().text() == "padStart"
    }

    fn numeric_string_receiver_origin(&mut self, node: Node) -> bool {
        let node = receivers::reference_node(node);
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        let mut declaration = if symbol == 0 {
            Node::NIL
        } else {
            self.checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .value_declaration
        };
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::VariableDeclaration
            || declaration.name().kind() != SyntaxKind::Identifier
            || declaration.name().text() != node.text()
            || declaration.initializer().is_nil()
        {
            fn find_local(
                current: Node,
                root: Node,
                name: &str,
                before: i32,
                best: &mut Option<Node>,
            ) {
                if current != root
                    && matches!(
                        current.kind(),
                        SyntaxKind::FunctionDeclaration
                            | SyntaxKind::FunctionExpression
                            | SyntaxKind::ArrowFunction
                            | SyntaxKind::MethodDeclaration
                    )
                {
                    return;
                }
                if current.kind() == SyntaxKind::VariableDeclaration
                    && current.name().kind() == SyntaxKind::Identifier
                    && current.name().text() == name
                    && current.pos() < before
                    && !current.initializer().is_nil()
                    && best.is_none_or(|candidate| candidate.pos() < current.pos())
                {
                    *best = Some(current);
                }
                current.for_each_child(&mut |child| {
                    find_local(child, root, name, before, best);
                    false
                });
            }
            let mut root = node.parent();
            while !root.is_nil()
                && !matches!(
                    root.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                )
            {
                root = root.parent();
            }
            if root.is_nil() {
                return false;
            }
            let mut best = None;
            find_local(root, root, node.text().as_ref(), node.pos(), &mut best);
            declaration = best.unwrap_or(Node::NIL);
            if declaration.is_nil() {
                return false;
            }
        }
        let initializer = receivers::reference_node(declaration.initializer());
        if initializer.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = receivers::reference_node(initializer.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "charCodeAt"
        {
            return false;
        }
        let member_symbol = self.symbol(member.name());
        self.primitive_symbol(member_symbol, "charCodeAt", Some("String"))
            || self
                .ty(member.expression())
                .is_ok_and(|ty| ty == Type::String)
    }

    /// An owning dynamic (or union) operand whose checked view is exactly
    /// `scalar` (for example a defaulted callback formal unpacked from an
    /// erased argument vector): check it as that scalar at the use site.
    pub(super) fn checked_scalar_operand(
        &mut self,
        value: Expr,
        node: Node,
        scalar: Type,
    ) -> Result<Expr, String> {
        if value.ty() == scalar
            || !matches!(value.ty(), Type::Dyn | Type::Union { .. })
            || self.ty(node).ok().as_ref() != Some(&scalar)
        {
            return Ok(value);
        }
        let value = self.coerce(value, Type::Dyn, node)?;
        Ok(Expr::DynCheck {
            value: Box::new(value),
            r#type: scalar,
            loc: self.loc(node),
        })
    }

    pub(super) fn string_split_value(
        &mut self,
        node: Node,
        receiver: Expr,
    ) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=2).contains(&arguments.len())
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "string split requires a represented separator and optional numeric limit",
            ));
        }
        let separator = self.primitive_operand(arguments[0])?;
        let separator = self.checked_scalar_operand(separator, arguments[0], Type::String)?;
        let is_regex = separator.ty() == Type::Regex;
        if is_regex && !self.regex_split_strings_only(arguments[0]) {
            return Err(self.refuse(
                arguments[0],
                "regex split requires a literal with no captures or one always-present enclosing capture",
            ));
        }
        if !is_regex && separator.ty() != Type::String {
            return Err(self.refuse(
                arguments[0],
                "string split requires a represented string or RegExp separator",
            ));
        }
        let limit = if let Some(limit) = arguments.get(1) {
            self.expected_expression(*limit, Type::F64)?
        } else {
            Expr::NumLit {
                value: u32::MAX as f64,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            }
        };
        let args = vec![separator, limit];
        let result = Type::Array {
            elem: Box::new(Type::String),
        };
        if is_regex {
            Ok(Expr::RegexIntrinsic {
                method: "split".into(),
                receiver: Box::new(receiver),
                args,
                r#type: result,
                loc: self.loc(node),
            })
        } else {
            Ok(Expr::StringIntrinsic {
                method: "split".into(),
                receiver: Box::new(receiver),
                args,
                r#type: result,
                loc: self.loc(node),
            })
        }
    }

    pub(super) fn string_match_value(
        &mut self,
        node: Node,
        receiver: Expr,
    ) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(
                node,
                "string match requires one represented RegExp argument",
            ));
        }
        let regex = self.primitive_operand(arguments[0])?;
        if regex.ty() != Type::Regex {
            let receiver = self.coerce(receiver, Type::Dyn, node.expression().expression())?;
            let regex = self.coerce(regex, Type::Dyn, arguments[0])?;
            return Ok(Expr::DynInvoke {
                recv: Box::new(receiver),
                method: "match".into(),
                callee_name: "match".into(),
                optional: false,
                args: vec![regex],
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        let array = self.regex_capture_array();
        let result = self
            .intern_union(vec![array, Type::Null])
            .expect("regex result");
        Ok(Expr::RegexIntrinsic {
            method: "match".into(),
            receiver: Box::new(receiver),
            args: vec![regex],
            r#type: result,
            loc: self.loc(node),
        })
    }

    pub(super) fn global_numeric_value(&self, node: Node, symbol: u32) -> Option<Expr> {
        let value = match node.text() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            _ => return None,
        };
        // Only the immutable standard global is intrinsic. Lexical parameters,
        // imports and user-defined globals must keep their own binding.
        if !self.primitive_symbol(symbol, node.text(), None) {
            return None;
        }
        Some(Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }

    // The execution checker can expose any for a JS formal whose portable
    // declaration ABI proves a primitive string. No object is recognized by
    // its member spelling, and custom declarations keep their own dispatch.
    fn represented_string_member(&mut self, node: Node, _symbol: u32) -> bool {
        let source = receivers::reference_node(node.expression());
        (source.kind() == SyntaxKind::Identifier
            && self
                .binding(source)
                .is_ok_and(|local| self.string_view(&local.r#type)))
            || self.ty(source).is_ok_and(|ty| self.string_view(&ty))
    }
    pub(super) fn primitive_symbol(&self, id: u32, name: &str, owner: Option<&str>) -> bool {
        if id == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(id));
        if symbol.name.as_ref() != name || symbol.declarations.is_empty() {
            return false;
        }
        if let Some(owner) = owner {
            // Instantiated/indexed member symbols may contain synthetic
            // declaration sentinels. The owning interface symbol is stable and
            // is also the stronger provenance proof: it must be the requested
            // standard interface with at least one bundled declaration.
            if symbol.parent.0 != 0 {
                let parent = self.checker.sym(symbol.parent);
                if parent.name.as_ref() == owner
                    && parent.flags.intersects(SymbolFlags::INTERFACE)
                    && !parent.declarations.is_empty()
                {
                    return true;
                }
            }
            // Instantiation can also detach a standard member from its
            // interface symbol (notably filter after map in fluent chains).
            // The declaration itself remains anchored in the bundled lib and
            // under the requested interface, which is an equally strong
            // provenance proof once the receiver has a native primitive ABI.
            symbol.declarations.iter().any(|declaration| {
                let parent = declaration.parent();
                !parent.is_nil()
                    && !parent.name().is_nil()
                    && parent.name().text() == owner
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(get_source_file_of_node(*declaration)).file_name,
                    )
                    .is_some()
            })
        } else {
            // A global value may share its symbol with type-only interface
            // augmentations (for example Node's Array<T>). They cannot replace
            // its runtime value, so prove the actual value declaration.
            !symbol.value_declaration.is_nil()
                && source_frontend::frontend::bundled::bundled_lib_name(
                    &source_file_info(get_source_file_of_node(symbol.value_declaration)).file_name,
                )
                .is_some()
        }
    }

    pub(super) fn standard_date_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol().0;
        self.primitive_symbol(symbol, "Date", None)
    }

    pub(super) fn date_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let constructor = node.expression();
        let symbol = self.symbol(constructor);
        if constructor.kind() != SyntaxKind::Identifier
            || !self.primitive_symbol(symbol, "Date", None)
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 7
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "native Date construction requires at most seven represented arguments",
            ));
        }
        if arguments.len() >= 2 {
            let mut values = Vec::with_capacity(7);
            for argument in arguments {
                let value = self.primitive_operand(argument)?;
                values.push(self.primitive_number(value, argument)?);
            }
            while values.len() < 7 {
                values.push(Expr::NumLit {
                    value: if values.len() == 2 { 1.0 } else { 0.0 },
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                });
            }
            let milliseconds = Expr::LibCall {
                r#fn: "date.newComponents".into(),
                args: values,
                r#type: Type::F64,
                loc: self.loc(node),
            };
            return Ok(Some(Expr::LibCall {
                r#fn: "date.newValue".into(),
                args: vec![milliseconds],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        let milliseconds = if let Some(argument) = arguments.first().copied() {
            // A non-null assertion and other checker-proven narrowing can leave
            // the owning local in union storage while this use is a concrete
            // number or string view. Install that view before choosing the Date
            // constructor ABI instead of rejecting the wider storage cell.
            let value = match self.ty(argument)? {
                Type::F64 => self.expected_expression(argument, Type::F64)?,
                Type::String => self.expected_expression(argument, Type::String)?,
                _ => self.primitive_operand(argument)?,
            };
            match value.ty() {
                Type::F64 => value,
                Type::String => Expr::LibCall {
                    r#fn: "date.parseString".into(),
                    args: vec![value],
                    r#type: Type::F64,
                    loc: self.loc(argument),
                },
                Type::Dyn => {
                    return Ok(Some(Expr::LibCall {
                        r#fn: "date.newDynamic".into(),
                        args: vec![value],
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    }));
                }
                _ => {
                    return Err(self.refuse(
                        argument,
                        "native Date construction requires represented epoch milliseconds or a date string",
                    ));
                }
            }
        } else {
            Expr::LibCall {
                r#fn: "date.now".into(),
                args: vec![],
                r#type: Type::F64,
                loc: self.loc(node),
            }
        };
        Ok(Some(Expr::LibCall {
            r#fn: "date.newValue".into(),
            args: vec![milliseconds],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn primitive_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let name = node.name().text();
        if name == "length" {
            let source = receivers::reference_node(node.expression());
            let represented = if source.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(source);
                self.bindings
                    .get(&symbol)
                    .or_else(|| self.module_bindings.get(&symbol))
                    .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                    .map(|local| local.r#type.clone())
                    .or_else(|| self.var_types.get(&symbol).cloned())
            } else {
                None
            }
            .or_else(|| self.ty(node.expression()).ok());
            if matches!(represented, Some(Type::Bytes { .. })) {
                let receiver = self.expression(node.expression())?;
                return Ok(Some(self.bytes_operation(
                    node,
                    receiver,
                    "length",
                    vec![],
                    Type::F64,
                )));
            }
        }
        if node.expression().kind() == SyntaxKind::Identifier {
            let receiver = self.symbol(node.expression());
            let member = self.symbol(node.name());
            if self.primitive_symbol(receiver, "Math", None)
                && self.primitive_symbol(member, name, Some("Math"))
            {
                let value = match name {
                    "E" => std::f64::consts::E,
                    "LN10" => std::f64::consts::LN_10,
                    "LN2" => std::f64::consts::LN_2,
                    "LOG10E" => std::f64::consts::LOG10_E,
                    "LOG2E" => std::f64::consts::LOG2_E,
                    "PI" => std::f64::consts::PI,
                    "SQRT1_2" => std::f64::consts::FRAC_1_SQRT_2,
                    "SQRT2" => std::f64::consts::SQRT_2,
                    _ => return Ok(None),
                };
                return Ok(Some(Expr::NumLit {
                    value,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }));
            }
            if self.primitive_symbol(receiver, "Number", None)
                && self.primitive_symbol(member, name, Some("NumberConstructor"))
            {
                let value = match name {
                    "MAX_SAFE_INTEGER" => 9_007_199_254_740_991.0,
                    "MIN_SAFE_INTEGER" => -9_007_199_254_740_991.0,
                    "MAX_VALUE" => f64::MAX,
                    "MIN_VALUE" => f64::from_bits(1),
                    "EPSILON" => f64::EPSILON,
                    "POSITIVE_INFINITY" => f64::INFINITY,
                    "NEGATIVE_INFINITY" => f64::NEG_INFINITY,
                    "NaN" => f64::NAN,
                    _ => return Ok(None),
                };
                return Ok(Some(Expr::NumLit {
                    value,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }));
            }
        }
        if node.name().text() != "length" {
            return Ok(None);
        }
        let receiver = self.primitive_operand(node.expression())?;
        let receiver = self.narrowed(receiver, node.expression())?;
        if receiver.ty() != Type::String {
            return Ok(None);
        }
        // Once the receiver has a native string representation, `length` is
        // the standard primitive operation regardless of which declaration
        // symbol the checker attached after control-flow assignments. Boxed
        // strings and user objects do not carry Type::String and stay on their
        // ordinary property path.
        Ok(Some(Expr::StringIntrinsic {
            method: "length".into(),
            receiver: Box::new(receiver),
            args: vec![],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    pub(super) fn primitive_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let mut member = node.expression();
        while member.kind() == SyntaxKind::ParenthesizedExpression {
            member = member.expression();
        }
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let name = member.name().text();
        let member_id = self.symbol(member.name());
        if name == "now" && self.standard_performance_value(member.expression()) {
            if !node.arguments().is_empty() {
                return Err(self.refuse(
                    node,
                    "performance.now extra argument effects are not ported",
                ));
            }
            return Ok(Some(Expr::LibCall {
                r#fn: "performance.now".into(),
                args: vec![],
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        if name == "wait"
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "Atomics", None)
            }
            && self.primitive_symbol(member_id, name, Some("Atomics"))
        {
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            let fresh = args
                .first()
                .copied()
                .map(receivers::reference_node)
                .unwrap_or(Node::NIL);
            let is_standard_constructor = |this: &mut Self, value: Node, name: &str| {
                value.kind() == SyntaxKind::NewExpression
                    && value.expression().kind() == SyntaxKind::Identifier
                    && {
                        let id = this.symbol(value.expression());
                        this.primitive_symbol(id, name, None)
                    }
            };
            if args.len() != 4
                || !is_standard_constructor(self, fresh, "Int32Array")
                || fresh.arguments().len() != 1
            {
                return Err(self.refuse(
                    node,
                    "Atomics.wait requires a fresh private Int32Array over a SharedArrayBuffer",
                ));
            }
            let buffer = receivers::reference_node(fresh.arguments().get(0));
            if !is_standard_constructor(self, buffer, "SharedArrayBuffer")
                || buffer.arguments().len() != 1
            {
                return Err(self.refuse(
                    node,
                    "Atomics.wait requires a fresh private SharedArrayBuffer",
                ));
            }
            let literal = |value: Node| {
                let value = receivers::reference_node(value);
                (value.kind() == SyntaxKind::NumericLiteral).then(|| {
                    source_frontend::jsnum::from_string(&value.text().replace('_', "")).value()
                })
            };
            if literal(buffer.arguments().get(0)) != Some(4.0)
                || literal(args[1]) != Some(0.0)
                || literal(args[2]) != Some(0.0)
            {
                return Err(self.refuse(
                    node,
                    "Atomics.wait requires one fresh zero slot and literal zero index/value",
                ));
            }
            // The private one-slot contract proves that no notifier can race
            // this wait. Keep the timeout as a runtime number so wrappers such
            // as `pauseSync(ms)` retain their native ABI; the runtime enforces
            // the subset's finite 60-second ceiling before sleeping.
            let timeout = self.expected_expression(args[3], Type::F64)?;
            let number = |value| Expr::NumLit {
                value,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            };
            return Ok(Some(Expr::LibCall {
                r#fn: "atomics.wait".into(),
                args: vec![
                    Expr::BytesNew {
                        source: Some(Box::new(number(1.0))),
                        r#type: Type::Bytes { elem: "i32".into() },
                        loc: self.loc(node),
                    },
                    number(0.0),
                    number(0.0),
                    timeout,
                ],
                r#type: Type::String,
                loc: self.loc(node),
            }));
        }
        if name == "parse"
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "Date", None)
            }
            && self.primitive_symbol(member_id, name, Some("DateConstructor"))
        {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                return Err(
                    self.refuse(node, "Date.parse requires one represented string argument")
                );
            }
            let value = self.expected_expression(arguments[0], Type::String)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "date.parseString".into(),
                args: vec![value],
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        if name == "UTC"
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "Date", None)
            }
            && self.primitive_symbol(member_id, name, Some("DateConstructor"))
        {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if !(2..=7).contains(&arguments.len())
                || arguments
                    .iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "Date.UTC requires two to seven represented numeric arguments",
                ));
            }
            let mut values = Vec::new();
            for argument in arguments {
                let value = self.primitive_operand(argument)?;
                values.push(self.primitive_number(value, argument)?);
            }
            while values.len() < 7 {
                values.push(Expr::NumLit {
                    value: if values.len() == 2 { 1.0 } else { 0.0 },
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                });
            }
            return Ok(Some(Expr::LibCall {
                r#fn: "date.utc".into(),
                args: values,
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        if name == "now"
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "Date", None)
            }
            && self.primitive_symbol(member_id, name, Some("DateConstructor"))
        {
            if !node.arguments().is_empty() {
                return Err(self.refuse(node, "Date.now extra argument effects are not ported"));
            }
            return Ok(Some(Expr::LibCall {
                r#fn: "date.now".into(),
                args: vec![],
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        if matches!(name, "fromCharCode" | "fromCodePoint")
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "String", None)
            }
            && self.primitive_symbol(member_id, name, Some("StringConstructor"))
        {
            return self.string_construction_call(node, name).map(Some);
        }
        if name == "toString" && node.arguments().is_empty() {
            let unions = self.unions.clone();
            let scalar = |ty: &Type| {
                matches!(ty, Type::String | Type::F64 | Type::Bigint | Type::Bool)
                    || matches!(ty, Type::Union { union_id }
                    if unions[*union_id].arms.iter().all(|arm| {
                        matches!(arm, Type::String | Type::F64 | Type::Bigint | Type::Bool)
                    }))
            };
            let source_receiver = primitive_source(member.expression());
            let stored = if source_receiver.kind() == SyntaxKind::Identifier {
                self.binding(source_receiver).ok().map(|local| local.r#type)
            } else {
                None
            };
            let represented = self
                .ty(member.expression())
                .ok()
                .is_some_and(|ty| scalar(&ty))
                || stored.as_ref().is_some_and(scalar)
                || (source_receiver.kind() != SyntaxKind::Identifier && {
                    let mut probe = self.diagnostic_fork();
                    probe
                        .primitive_operand(member.expression())
                        .is_ok_and(|value| scalar(&value.ty()))
                });
            if represented {
                // All guarded primitive scalar arms use the ordinary
                // JavaScript string conversion for zero-argument toString.
                // Keep the live tagged value and avoid manufacturing a boxed
                // prototype object or dispatching through a JavaScript engine.
                let receiver = self.primitive_operand(member.expression())?;
                let receiver = self.coerce(receiver, Type::Dyn, member.expression())?;
                return Ok(Some(Expr::LibCall {
                    r#fn: "dyn.stringConstructor".into(),
                    args: vec![receiver],
                    r#type: Type::String,
                    loc: self.loc(node),
                }));
            }
        }
        if matches!(
            name,
            "toString" | "toFixed" | "toExponential" | "toPrecision" | "toLocaleString"
        ) {
            let source_receiver = primitive_source(member.expression());
            let stored_number = source_receiver.kind() == SyntaxKind::Identifier
                && self
                    .binding(source_receiver)
                    .is_ok_and(|local| local.r#type == Type::F64);
            let represented_number = self.primitive_symbol(member_id, name, Some("Number"))
                || self.ty(member.expression()).is_ok_and(|ty| ty == Type::F64)
                || stored_number
                || self.numeric_string_receiver_origin(member.expression())
                || self.erased_number_radix_chain(node, member)
                || (source_receiver.kind() != SyntaxKind::Identifier && {
                    let mut probe = self.diagnostic_fork();
                    probe
                        .primitive_operand(member.expression())
                        .is_ok_and(|value| value.ty() == Type::F64)
                });
            // A synthesized union member can carry both Date and Number
            // declarations. An erased receiver must retain runtime dispatch;
            // the shared method name alone does not prove a numeric value.
            let ambiguous_date =
                name == "toString" && self.primitive_symbol(member_id, name, Some("Date")) && {
                    let mut probe = self.diagnostic_fork();
                    probe
                        .primitive_operand(member.expression())
                        .is_ok_and(|value| value.ty() == Type::Dyn)
                };
            if represented_number && !ambiguous_date {
                return self.number_string_call(node, member).map(Some);
            }
        }
        if name == "isArray"
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "Array", None)
            }
            && self.primitive_symbol(member_id, name, Some("ArrayConstructor"))
        {
            return self.array_brand_call(node).map(Some);
        }
        let math_operation = crate::builtins::get("Math", name);
        let math = math_operation.is_some()
            && member.expression().kind() == SyntaxKind::Identifier
            && {
                let id = self.symbol(member.expression());
                self.primitive_symbol(id, "Math", None)
            }
            && self.primitive_symbol(member_id, name, Some("Math"));
        let string_candidate = crate::string_builtins::by_method(name).is_some()
            || matches!(name, "split" | "match" | "matchAll");
        let mut represented_receiver = None;
        let mut proven_string = self.primitive_symbol(member_id, name, Some("String"))
            || (string_candidate && self.represented_string_member(member, member_id));
        // `string & any[]` (a string narrowed by `Array.isArray`) resolves
        // members on its String part, yet the owning value is erased: let the
        // dynamic dispatcher choose the real receiver's method.
        if proven_string && {
            let checked = self.checker.get_type_at_location(member.expression());
            self.checker.ty(checked).flags.intersects(TypeFlags::INTERSECTION)
                && self.ty(member.expression()).ok() == Some(Type::Dyn)
        } {
            proven_string = false;
        }
        if name == "toString" && node.arguments().is_empty() {
            let checked = self.checker.get_type_at_location(member.expression());
            if self.standard_string_or_url_type(checked) {
                let receiver = self.primitive_operand(member.expression())?;
                let receiver = self.live_member_receiver(member.expression(), receiver);
                if receiver.ty() == Type::Dyn {
                    return Ok(Some(Expr::ToString {
                        operand: Box::new(receiver),
                        r#type: Type::String,
                        loc: self.loc(node),
                    }));
                }
            }
        }
        if string_candidate && !proven_string {
            // JavaScript dependencies frequently expose `any` at the checker
            // boundary even though their already-lowered record field has an
            // exact native string ABI. Prefer that concrete IR representation
            // and retain the expression so a getter/call is evaluated once.
            let receiver = self.primitive_operand(member.expression())?;
            proven_string = self.string_view(&receiver.ty());
            represented_receiver = Some(receiver);
        }
        if name == "match" && proven_string {
            let receiver = represented_receiver
                .take()
                .map(Ok)
                .unwrap_or_else(|| self.primitive_operand(member.expression()))?;
            let receiver = self.live_member_receiver(member.expression(), receiver);
            let receiver = self.string_method_receiver(member, receiver)?;
            return self.string_match_value(node, receiver).map(Some);
        }
        if name == "matchAll" && proven_string {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    node,
                    "string matchAll requires one represented RegExp argument",
                ));
            }
            let receiver = represented_receiver
                .take()
                .map(Ok)
                .unwrap_or_else(|| self.primitive_operand(member.expression()))?;
            let receiver = self.live_member_receiver(member.expression(), receiver);
            let receiver = self.string_method_receiver(member, receiver)?;
            let regex = self.primitive_operand(arguments[0])?;
            if regex.ty() != Type::Regex {
                return Err(self.refuse(
                    arguments[0],
                    "string matchAll requires a represented RegExp",
                ));
            }
            let row = self.regex_capture_array();
            let result = Type::Array {
                elem: Box::new(row),
            };
            return Ok(Some(Expr::RegexIntrinsic {
                method: "matchAll".into(),
                receiver: Box::new(receiver),
                args: vec![regex],
                r#type: result,
                loc: self.loc(node),
            }));
        }
        if name == "split" && proven_string {
            let receiver = represented_receiver
                .take()
                .map(Ok)
                .unwrap_or_else(|| self.primitive_operand(member.expression()))?;
            let receiver = self.live_member_receiver(member.expression(), receiver);
            let receiver = self.string_method_receiver(member, receiver)?;
            return self.string_split_value(node, receiver).map(Some);
        }
        let string =
            crate::string_builtins::by_method(name).filter(|_| name != "length" && proven_string);
        let string_identity = matches!(name, "toString" | "valueOf")
            && self.primitive_symbol(member_id, name, Some("String"));
        if !math && string.is_none() && !string_identity {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if matches!(name, "toLocaleLowerCase" | "toLocaleUpperCase") && !arguments.is_empty() {
            return Err(self.refuse(
                node,
                "native locale-sensitive string casing currently supports only the default locale",
            ));
        }
        if arguments
            .iter()
            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            if math && matches!(name, "min" | "max" | "hypot") {
                // Argument-list iteration completes before Math performs
                // ToNumber. First materialize every ordinary/spread value as
                // an owning NativeValue array, then convert the completed
                // list in a second helper pass.
                let raw = self.array_spread_elements(
                    node,
                    arguments,
                    Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                )?;
                let numeric = self.array_extend(
                    node,
                    Expr::ArrayLit {
                        elems: vec![],
                        r#type: Type::Array {
                            elem: Box::new(Type::F64),
                        },
                        loc: self.loc(node),
                    },
                    raw,
                )?;
                return Ok(Some(Expr::LibCall {
                    r#fn: format!("math.{name}Arr"),
                    args: vec![numeric],
                    r#type: Type::F64,
                    loc: self.loc(node),
                }));
            }
            return Err(self.refuse(
                arguments
                    .iter()
                    .find(|argument| argument.kind() == SyntaxKind::SpreadElement)
                    .copied()
                    .unwrap_or(node),
                "standard primitive iterable argument spreads are not ported",
            ));
        }
        let mut values = Vec::new();
        if string.is_some() || string_identity {
            let receiver = represented_receiver
                .take()
                .map(Ok)
                .unwrap_or_else(|| self.primitive_operand(member.expression()))?;
            let receiver = self.live_member_receiver(member.expression(), receiver);
            let receiver = self.string_method_receiver(member, receiver)?;
            values.push(receiver);
            if string.is_some() {
                self.ensure_exception_classes(node)?;
            }
        }
        for arg in arguments {
            let value = self.primitive_operand(arg)?;
            let value = self.primitive_capture(value, arg)?;
            values.push(value);
        }
        // Evaluate the receiver and ALL arguments before conversions, errors or
        // reduction. Unused extra arguments still have their source effects.
        let result = if string_identity {
            Type::String
        } else {
            string.map_or(Type::F64, |operation| operation.result.clone())
        };
        // A represented RegExp selects the existing regex overload, never
        // ToString(search). Ordinary strings retain the literal-search path.
        let regex_replace = string.is_some()
            && matches!(name, "replace" | "replaceAll")
            && values.get(1).is_some_and(|value| value.ty() == Type::Regex);
        let mut helper = Helper::new(
            &format!("primitive_{name}"),
            values.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(node),
        );
        let operand = if string.is_some() || string_identity {
            1
        } else {
            0
        };
        let mut numbers = Vec::new();
        let count = if string_identity {
            0
        } else if let Some(operation) = string {
            operation.args.len()
        } else if math && matches!(name, "min" | "max" | "hypot") {
            values.len()
        } else {
            math_operation
                .as_ref()
                .map_or(1, |operation| operation.args.len())
        };
        let callback_replace = regex_replace
            && values
                .get(2)
                .is_some_and(|value| matches!(value.ty(), Type::Func { .. }));
        for index in 0..if callback_replace { 0 } else { count } {
            let value = if regex_replace && index == 0 {
                helper.read(&helper.param(1))
            } else if let Some(operation) = string {
                let value = (operand + index < values.len())
                    .then(|| helper.read(&helper.param(operand + index)));
                let site = node.arguments().into_iter().nth(index).unwrap_or(node);
                self.primitive_string_argument(value, operation.args[index], site)?
            } else if operand + index < values.len() {
                self.primitive_number(helper.read(&helper.param(operand + index)), node)?
            } else {
                helper.number(f64::NAN)
            };
            let local = helper.local(&format!("argument{index}"), value.ty(), false);
            helper.declare(&local, value);
            numbers.push(helper.read(&local));
        }
        // These two methods return the primitive string unchanged. Keep the
        // helper call: eliminating it would discard unused argument effects.
        let value = if string_identity {
            helper.read(&helper.param(0))
        } else if callback_replace {
            let callback = self.coerce(helper.read(&helper.param(2)), Type::Dyn, node)?;
            Expr::LibCall {
                r#fn: "regex.replaceCaptures".into(),
                args: vec![
                    helper.read(&helper.param(0)),
                    helper.read(&helper.param(1)),
                    callback,
                    Expr::BoolLit {
                        value: name == "replaceAll",
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                ],
                r#type: Type::String,
                loc: helper.loc(),
            }
        } else if regex_replace {
            Expr::RegexIntrinsic {
                method: name.into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args: numbers,
                r#type: Type::String,
                loc: helper.loc(),
            }
        } else if string.is_some() {
            Expr::StringIntrinsic {
                method: name.into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args: numbers,
                r#type: result.clone(),
                loc: helper.loc(),
            }
        } else {
            let (operation, args) = if matches!(name, "min" | "max" | "hypot") {
                (
                    format!("math.{name}Arr"),
                    vec![Expr::ArrayLit {
                        elems: numbers,
                        r#type: Type::Array {
                            elem: Box::new(Type::F64),
                        },
                        loc: helper.loc(),
                    }],
                )
            } else {
                (format!("math.{name}"), numbers)
            };
            Expr::LibCall {
                r#fn: operation,
                args,
                r#type: result.clone(),
                loc: helper.loc(),
            }
        };
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: result,
            loc: self.loc(node),
        }))
    }

    fn array_brand_call(&mut self, node: Node) -> Result<Expr, String> {
        let mut values = Vec::new();
        let mut guarded_array = false;
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    arg,
                    "standard primitive iterable argument spreads are not ported",
                ));
            }
            // A predicate observes the live slot, before any checker refinement.
            let mut value = self.condition_value(primitive_source(arg))?;
            if value.ty() == Type::Caught {
                value = self.coerce(value, Type::Dyn, arg)?;
            }
            guarded_array =
                node.arguments().len() == 1 && self.array_after_immediate_absence_exit(arg, &value);
            let value = self.primitive_capture(value, arg)?;
            values.push(value);
        }
        if guarded_array {
            // The proof above is restricted to a native record data slot.
            // Its read has no getter/Proxy effects, so the standard predicate
            // is observably constant after the adjacent terminal guard.
            return Ok(Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        let definitely_non_array = values.first().is_some_and(|value| match value.ty() {
            Type::Bytes { .. }
            | Type::String
            | Type::F64
            | Type::Bigint
            | Type::Bool
            | Type::Symbol
            | Type::Null
            | Type::Undefined
            | Type::Void => true,
            Type::Union { union_id } => self.unions[union_id].arms.iter().all(|arm| {
                matches!(
                    arm,
                    Type::Bytes { .. }
                        | Type::String
                        | Type::F64
                        | Type::Bigint
                        | Type::Bool
                        | Type::Symbol
                        | Type::Null
                        | Type::Undefined
                        | Type::Void
                )
            }),
            _ => false,
        });
        if values.len() == 1
            && definitely_non_array
            && node
                .arguments()
                .first()
                .is_some_and(|argument| primitive_source(argument).kind() == SyntaxKind::Identifier)
        {
            // Buffers and typed arrays are ArrayBuffer views, not ordinary
            // JavaScript Arrays. A plain identifier read has no observable
            // getter/call effects, so publish the exact false result here.
            // This also prevents TypeScript's synthetic `Buffer & any[]`
            // true branch from demanding an impossible native array view.
            return Ok(Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        let mut helper = Helper::new(
            "array_is_array",
            values.iter().map(Expr::ty).collect(),
            Type::Bool,
            self.loc(node),
        );
        let value = if values.is_empty() {
            Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            }
        } else {
            self.array_brand(helper.read(&helper.param(0)), node)
        };
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: values,
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }

    // Unit tags cannot occupy standalone function ABI slots. A void-valued
    // source call still evaluates here and contributes JavaScript undefined.
    pub(super) fn primitive_capture(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if value.ty() == Type::Void {
            let ty = self.intern_union(vec![Type::F64, Type::Undefined]).unwrap();
            let unit = Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            };
            return Ok(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: value,
                    loc: self.loc(node),
                }],
                result: Box::new(self.coerce(unit, ty.clone(), node)?),
                r#type: ty,
                loc: self.loc(node),
            });
        }
        if matches!(value.ty(), Type::Null | Type::Undefined) {
            let ty = self.intern_union(vec![Type::F64, value.ty()]).unwrap();
            return self.coerce(value, ty, node);
        }
        Ok(value)
    }

    fn number_string_call(&mut self, node: Node, member: Node) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let receiver_node = member.expression();
        let receiver = self.primitive_operand(receiver_node)?;
        let erased_radix = self.erased_number_radix_chain(node, member);
        let receiver = if receiver.ty() == Type::Dyn
            && (self.numeric_string_receiver_origin(receiver_node) || erased_radix)
        {
            Expr::DynCheck {
                value: Box::new(receiver),
                r#type: Type::F64,
                loc: self.loc(receiver_node),
            }
        } else if receiver.ty() != Type::F64 && self.ty(receiver_node).is_ok_and(|ty| ty == Type::F64)
        {
            // The checker proves a number (for example `(value ?? 0)` over an
            // optional field) while the operand keeps its owning storage.
            // Check that storage as a number at the call boundary.
            let value = self.coerce(receiver, Type::Dyn, receiver_node)?;
            Expr::DynCheck {
                value: Box::new(value),
                r#type: Type::F64,
                loc: self.loc(receiver_node),
            }
        } else {
            receiver
        };
        self.number_string_call_value(node, receiver)
    }

    pub(super) fn number_string_call_value(
        &mut self,
        node: Node,
        receiver: Expr,
    ) -> Result<Expr, String> {
        let method = node.expression().name().text();
        let fixed = method == "toFixed";
        self.ensure_exception_classes(node)?;
        if receiver.ty() != Type::F64 {
            return Err(self.refuse(
                node.expression(),
                "Number formatting requires a represented numeric receiver",
            ));
        }
        if method == "toLocaleString" {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.is_empty() {
                // The native runtime profile uses en-US as its deterministic
                // default locale. Explicit locale negotiation remains fenced.
                return Ok(Expr::LibCall {
                    r#fn: "num.toLocaleStringEnUs".into(),
                    args: vec![receiver],
                    r#type: Type::String,
                    loc: self.loc(node),
                });
            }
            if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    node,
                    "native Number.toLocaleString supports the default locale or explicit en-US",
                ));
            }
            let locale = primitives::primitive_source(arguments[0]);
            if locale.kind() != SyntaxKind::StringLiteral {
                return Err(self.refuse(
                    arguments[0],
                    "native Number.toLocaleString requires a represented literal locale",
                ));
            }
            let r#fn = match locale.text().as_ref() {
                "en-US" => "num.toLocaleStringEnUs",
                "pt-BR" => "num.toLocaleStringPtBr",
                _ => {
                    return Err(self.refuse(
                        arguments[0],
                        "native Number.toLocaleString currently supports en-US and pt-BR",
                    ));
                }
            };
            return Ok(Expr::LibCall {
                r#fn: r#fn.into(),
                args: vec![receiver],
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        let mut values = vec![receiver];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    argument,
                    "Number formatting iterable argument spreads are not ported",
                ));
            }
            let value = self.primitive_operand(argument)?;
            values.push(self.primitive_capture(value, argument)?);
        }
        let mut helper = Helper::new(
            if fixed {
                "number_to_fixed"
            } else {
                "number_to_string"
            },
            values.iter().map(Expr::ty).collect(),
            Type::String,
            self.loc(node),
        );
        let optional_absent = node.arguments().is_empty()
            || node.arguments().first().is_some_and(|argument| {
                self.ty(primitives::primitive_source(argument))
                    .is_ok_and(|ty| ty == Type::Undefined)
            });
        let argument = || (values.len() > 1).then(|| helper.read(&helper.param(1)));
        let numeric_argument = if matches!(method, "toFixed" | "toString") || !optional_absent {
            Some(self.primitive_string_argument(
                argument(),
                crate::string_builtins::Argument::Number(if fixed { 0.0 } else { 10.0 }),
                node,
            )?)
        } else {
            None
        };
        let (operation, mut args) = match method {
            "toFixed" => ("num.toFixed", vec![helper.read(&helper.param(0))]),
            "toString" => ("num.toRadixString", vec![helper.read(&helper.param(0))]),
            "toExponential" if optional_absent => {
                ("num.toExponential", vec![helper.read(&helper.param(0))])
            }
            "toExponential" => (
                "num.toExponentialDigits",
                vec![helper.read(&helper.param(0))],
            ),
            "toPrecision" if optional_absent => (
                "num.toRadixString",
                vec![helper.read(&helper.param(0)), helper.number(10.0)],
            ),
            "toPrecision" => ("num.toPrecision", vec![helper.read(&helper.param(0))]),
            _ => unreachable!(),
        };
        if let Some(argument) = numeric_argument {
            args.push(argument);
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: operation.into(),
                args,
                r#type: Type::String,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: values,
            r#type: Type::String,
            loc: self.loc(node),
        })
    }

    fn array_brand(&self, value: Expr, node: Node) -> Expr {
        let boolean = |value| Expr::BoolLit {
            value,
            r#type: Type::Bool,
            loc: self.loc(node),
        };
        match value.ty() {
            Type::Dyn => Expr::DynTest {
                value: Box::new(value),
                test: "array".into(),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            },
            Type::Array { .. } => boolean(true),
            Type::Record { shape_id } => boolean(self.records[shape_id].tuple),
            Type::Union { union_id } => self.unions[union_id].arms.iter().enumerate().rev().fold(
                boolean(false),
                |otherwise, (tag, arm)| {
                    let narrowed = Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(value.clone()),
                        r#type: arm.clone(),
                        loc: self.loc(node),
                    };
                    Expr::Ternary {
                        cond: Box::new(Expr::UnionIsTag {
                            union_id: format!("u{union_id}"),
                            tag,
                            negated: false,
                            value: Box::new(value.clone()),
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        }),
                        then: Box::new(self.array_brand(narrowed, node)),
                        else_: Box::new(otherwise),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }
                },
            ),
            _ => boolean(false),
        }
    }

    pub(super) fn primitive_string_argument(
        &mut self,
        value: Option<Expr>,
        argument: crate::string_builtins::Argument,
        node: Node,
    ) -> Result<Expr, String> {
        use crate::string_builtins::Argument;
        let default = match argument {
            Argument::Number(value) => Expr::NumLit {
                value,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            },
            Argument::Text(value) => Expr::StrLit {
                value: value.into(),
                r#type: Type::String,
                loc: self.loc(node),
            },
        };
        let Some(value) = value else {
            return Ok(default);
        };
        if value.ty() == Type::Undefined {
            return Ok(default);
        }
        if matches!(argument, Argument::Text(_))
            && matches!(value.ty(), Type::Union { .. })
            && node.kind() == SyntaxKind::Identifier
        {
            let symbol = self.symbol(node);
            if symbol != 0
                && !self.nested_assignment_symbols.contains(&symbol)
                && self.ty(node).ok() == Some(Type::String)
            {
                // Suspension and callback lifting can clear the ordinary
                // point-in-time fact for a boxed local. If no nested function
                // can write that cell, TypeScript's String view remains a
                // sound exact arm at this use; outer sequential assignments
                // have already contributed their own flow fact.
                return self.coerce(value, Type::String, node);
            }
        }
        if let Type::Union { union_id } = value.ty() {
            // The omitted/undefined default is semantic input. Parameters and
            // return type alone cannot distinguish a start of 0 from an end
            // of Infinity (or different default separator strings).
            let identity = match argument {
                Argument::Number(number) => format!("string_argument_number_{}", number.to_bits()),
                Argument::Text(text) => format!("string_argument_text_{:?}", text.as_bytes()),
            };
            let mut helper =
                Helper::new(&identity, vec![value.ty()], argument.ty(), self.loc(node));
            let slot = helper.param(0);
            for (tag, arm) in self.unions[union_id].arms.clone().into_iter().enumerate() {
                let result = if arm == Type::Undefined {
                    default.clone()
                } else {
                    let narrowed = if arm == Type::Null {
                        Expr::UnitLit {
                            unit: "null",
                            r#type: Type::Null,
                            loc: helper.loc(),
                        }
                    } else {
                        Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(helper.read(&slot)),
                            r#type: arm,
                            loc: helper.loc(),
                        }
                    };
                    self.primitive_string_argument(Some(narrowed), argument, node)?
                };
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        value: Box::new(helper.read(&slot)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(result),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
            }
            helper.function.body.push(Stmt::Return {
                value: Some(default),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            return Ok(Expr::Call {
                callee,
                args: vec![value],
                r#type: argument.ty(),
                loc: self.loc(node),
            });
        }
        match argument {
            Argument::Number(_) => self.primitive_number(value, node),
            Argument::Text(_) => match value.ty() {
                Type::String => Ok(value),
                Type::Null => Ok(Expr::StrLit {
                    value: "null".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }),
                Type::Bool | Type::F64 => Ok(Expr::ToString {
                    operand: Box::new(value),
                    r#type: Type::String,
                    loc: self.loc(node),
                }),
                // The erased value path implements ToString for every
                // represented primitive and throws for Symbol or objects,
                // whose observable ToPrimitive hooks remain outside the
                // native subset. This is both broader and more accurate than
                // pretending an `any` argument is already a String.
                Type::Dyn => Ok(Expr::ToString {
                    operand: Box::new(value),
                    r#type: Type::String,
                    loc: self.loc(node),
                }),
                other => {
                    let storage = if node.kind() == SyntaxKind::Identifier {
                        let symbol = self.symbol(node);
                        let declaration = (symbol != 0).then(|| {
                            self.checker
                                .sym(source_frontend::prelude::SymbolId(symbol))
                                .value_declaration
                        });
                        let binding = self
                            .bindings
                            .get(&symbol)
                            .or_else(|| self.module_bindings.get(&symbol))
                            .or_else(|| {
                                self.outer.iter().rev().find_map(|scope| scope.get(&symbol))
                            })
                            .cloned();
                        let planned = self.planned_local_storage.get(&symbol).cloned();
                        let owned = self.var_types.get(&symbol).cloned();
                        let checker = self.ty(node).ok();
                        Some(format!(
                            "symbol={symbol}, binding={binding:?}, planned={:?}, owned={:?}, checker={:?}, declaration={:?}",
                            planned,
                            owned,
                            checker,
                            declaration.filter(|declaration| !declaration.is_nil()).map(
                                |declaration| (
                                    declaration.kind(),
                                    declaration.pos(),
                                    declaration.end(),
                                    declaration.name().text().to_string(),
                                )
                            ),
                        ))
                    } else {
                        None
                    };
                    Err(self.refuse(
                        node,
                        &format!(
                            "standard string arguments require represented primitives, got {other:?}; object coercion hooks are not ported; storage: {storage:?}"
                        ),
                    ))
                }
            },
        }
    }

    // Type-only wrappers do not perform JavaScript numeric/string conversion.
    // Preserve the operand before applying the actual standard operation.
    pub(super) fn primitive_operand(&mut self, node: Node) -> Result<Expr, String> {
        self.expression(primitive_source(node))
    }

    /// Only represented primitives participate. Objects require observable
    /// ToPrimitive hooks; a numeric type assertion must never erase that work.
    pub(super) fn primitive_number(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        let loc = self.loc(node);
        let number = |n| Expr::NumLit {
            value: n,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        match value.ty() {
            Type::F64 => Ok(value),
            Type::Dyn => self.strict_number_primitive(value, node),
            Type::Bigint | Type::Symbol => {
                self.ensure_exception_classes(node)?;
                let kind = if value.ty() == Type::Bigint { "BigInt" } else { "Symbol" };
                let mut helper = Helper::new(&format!("primitive_number_error_{kind}"), vec![value.ty()], Type::F64, self.loc(node));
                helper.function.body.push(Stmt::Throw { value: Expr::LibCall { r#fn: "error.new".into(), args: vec![Expr::StrLit { value: format!("Cannot convert a {kind} value to a number"), r#type: Type::String, loc: self.loc(node) }], r#type: Type::Object { class_name: "%TypeError".into() }, loc: self.loc(node) }, loc: self.loc(node) });
                Ok(Expr::Call { callee: self.install_helper(helper.function), args: vec![value], r#type: Type::F64, loc: self.loc(node) })
            }
            Type::String => Ok(Expr::LibCall { r#fn: "num.fromString".into(), args: vec![value], r#type: Type::F64, loc: self.loc(node) }),
            Type::Bool => Ok(Expr::Ternary { cond: Box::new(value), then: Box::new(number(1.0)), else_: Box::new(number(0.0)), r#type: Type::F64, loc: self.loc(node) }),
            Type::Null | Type::Undefined => {
                if matches!(value, Expr::UnitLit { .. }) {
                    Ok(number(if value.ty() == Type::Null { 0.0 } else { f64::NAN }))
                } else {
                    self.strict_number_primitive(value, node)
                }
            }
            ty @ Type::Union { union_id } => {
                let mut helper = Helper::new("primitive_number", vec![ty], Type::F64, self.loc(node));
                let slot = helper.param(0);
                for (tag, arm) in self.unions[union_id].arms.clone().into_iter().enumerate() {
                    let value = Expr::UnionNarrow { union_id: format!("u{union_id}"), tag, value: Box::new(helper.read(&slot)), r#type: arm, loc: helper.loc() };
                    let result = match value.ty() {
                        Type::Null => helper.number(0.0),
                        Type::Undefined => helper.number(f64::NAN),
                        _ => self.primitive_number(value, node)?,
                    };
                    helper.function.body.push(Stmt::If { cond: Expr::UnionIsTag { union_id: format!("u{union_id}"), tag, negated: false, value: Box::new(helper.read(&slot)), r#type: Type::Bool, loc: helper.loc() }, then: vec![Stmt::Return { value: Some(result), loc: helper.loc() }], else_: None, loc: helper.loc() });
                }
                helper.function.body.push(Stmt::Return { value: Some(helper.number(f64::NAN)), loc: helper.loc() });
                let callee = self.install_helper(helper.function);
                Ok(Expr::Call { callee, args: vec![value], r#type: Type::F64, loc: self.loc(node) })
            }
            _ => Err(self.refuse(node, "standard numeric arguments require represented primitives; object coercion hooks are not ported")),
        }
    }
}

pub(super) fn primitive_source(mut node: Node) -> Node {
    while !node.is_nil()
        && matches!(
            node.kind(),
            SyntaxKind::ParenthesizedExpression
                | SyntaxKind::AsExpression
                | SyntaxKind::TypeAssertionExpression
                | SyntaxKind::SatisfiesExpression
                | SyntaxKind::NonNullExpression
        )
    {
        node = node.expression();
    }
    node
}
