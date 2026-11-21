//! Callable data objects use a private function slot in an owned record layout.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

mod contracts;

pub(super) const CALL_FIELD: &str = "\0scriptc.call";

impl Lowerer<'_> {
    /// Empty-constructor factory whose prototype is `Object.create(null)`.
    /// This common package optimization is an allocation policy, not a reason
    /// to carry a JavaScript constructor engine into the native executable.
    pub(super) fn null_object_factory_call(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::CallExpression || !node.arguments().is_empty() {
            return false;
        }
        let function = primitives::primitive_source(node.expression());
        if !matches!(
            function.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) || !function.parameters().is_empty()
            || function.body().kind() != SyntaxKind::Block
        {
            return false;
        }
        let statements = function.body().statements().into_iter().collect::<Vec<_>>();
        let [declaration_statement, prototype_statement, return_statement] = statements.as_slice()
        else {
            return false;
        };
        if declaration_statement.kind() != SyntaxKind::VariableStatement
            || prototype_statement.kind() != SyntaxKind::ExpressionStatement
            || return_statement.kind() != SyntaxKind::ReturnStatement
        {
            return false;
        }
        let declarations = declaration_statement
            .declaration_list()
            .declarations()
            .nodes()
            .into_iter()
            .collect::<Vec<_>>();
        let [declaration] = declarations.as_slice() else {
            return false;
        };
        let name = declaration.name();
        let initializer = primitives::primitive_source(declaration.initializer());
        if name.kind() != SyntaxKind::Identifier
            || initializer.kind() != SyntaxKind::FunctionExpression
            || !initializer.parameters().is_empty()
            || initializer.body().kind() != SyntaxKind::Block
            || !initializer.body().statements().is_empty()
        {
            return false;
        }
        let symbol = self.symbol(name);
        let assignment = prototype_statement.expression();
        if assignment.kind() != SyntaxKind::BinaryExpression
            || assignment.operator_token().kind() != SyntaxKind::EqualsToken
        {
            return false;
        }
        let left = assignment.left();
        let create = primitives::primitive_source(assignment.right());
        if left.kind() != SyntaxKind::PropertyAccessExpression
            || left.name().text() != "prototype"
            || left.expression().kind() != SyntaxKind::Identifier
            || self.symbol(left.expression()) != symbol
            || create.kind() != SyntaxKind::CallExpression
        {
            return false;
        }
        let member = create.expression();
        let args = create.arguments().into_iter().collect::<Vec<_>>();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "create"
            || !self.standard_object(member.expression())
            || !matches!(args.as_slice(), [arg] if primitives::primitive_source(*arg).kind() == SyntaxKind::NullKeyword)
        {
            return false;
        }
        let returned = primitives::primitive_source(return_statement.expression());
        returned.kind() == SyntaxKind::Identifier && self.symbol(returned) == symbol
    }

    pub(super) fn null_object_constructor(&mut self, node: Node) -> bool {
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
        !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && !declaration.initializer().is_nil()
            && self
                .null_object_factory_call(primitives::primitive_source(declaration.initializer()))
    }

    /// A decorated bare function retains its owning function object. Its
    /// properties live on that object, including through pre-existing aliases.
    pub(super) fn assigned_function_type(&mut self, node: Node) -> Option<Type> {
        if node.kind() != SyntaxKind::CallExpression {
            return None;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "assign"
            || !self.standard_object(member.expression())
        {
            return None;
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 2
            || args[1].kind() != SyntaxKind::ObjectLiteralExpression
            || self.fresh_function(args[0])
        {
            return None;
        }
        let id = self.checker.get_type_at_location(args[0]);
        self.function_type(id)
    }

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

    pub(super) fn standard_object(&mut self, node: Node) -> bool {
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

    pub(super) fn standard_object_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() == SyntaxKind::CallExpression {
            let member = node.expression();
            if member.kind() == SyntaxKind::PropertyAccessExpression
                && member.name().text() == "setPrototypeOf"
                && self.standard_object(member.expression())
            {
                let symbol = self.symbol(member.name());
                if !self.primitive_symbol(symbol, "setPrototypeOf", Some("ObjectConstructor")) {
                    return Ok(None);
                }
                let arguments = node.arguments().into_iter().collect::<Vec<_>>();
                if !matches!(arguments.as_slice(), [_, _]) {
                    return Err(self.refuse(
                        node,
                        "Object.setPrototypeOf requires an ordinary object and one prototype",
                    ));
                }
                let target = self.expression(arguments[0])?;
                let target = self.coerce(target, Type::Dyn, arguments[0])?;
                let prototype = primitives::primitive_source(arguments[1]);
                if prototype.kind() != SyntaxKind::NullKeyword {
                    let prototype = self.expression(arguments[1])?;
                    let prototype = self.coerce(prototype, Type::Dyn, arguments[1])?;
                    return Ok(Some(Expr::Intrinsic {
                        name: "object.setPrototype".into(),
                        args: vec![target, prototype],
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    }));
                }
                return Ok(Some(Expr::Intrinsic {
                    name: "object.setPrototypeNull".into(),
                    args: vec![target],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }));
            }
            if member.kind() == SyntaxKind::PropertyAccessExpression
                && member.name().text() == "create"
                && self.standard_object(member.expression())
            {
                let symbol = self.symbol(member.name());
                if !self.primitive_symbol(symbol, "create", Some("ObjectConstructor")) {
                    return Ok(None);
                }
                let arguments = node.arguments().into_iter().collect::<Vec<_>>();
                if matches!(arguments.as_slice(), [argument] if primitives::primitive_source(*argument).kind() == SyntaxKind::NullKeyword)
                {
                    return Ok(Some(Expr::Intrinsic {
                        name: "object.createNull".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    }));
                }
                if !(1..=2).contains(&arguments.len())
                    || arguments
                        .iter()
                        .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                {
                    return Err(self.refuse(
                        node,
                        "Object.create requires a prototype and optional property descriptors",
                    ));
                }
                // Object.create(proto, descriptors?): evaluate both operands,
                // then allocate an ordinary object linked to `proto` (the
                // prototype check rejects primitives with Node's TypeError)
                // and apply the descriptors through defineProperties.
                let loc = self.loc(node);
                let null_prototype =
                    primitives::primitive_source(arguments[0]).kind() == SyntaxKind::NullKeyword;
                let mut stmts = Vec::new();
                let mut locals = Vec::new();
                for argument in &arguments {
                    let value = self.expression(*argument)?;
                    let value = self.coerce(value, Type::Dyn, *argument)?;
                    let local = self.construction_local(Type::Dyn, false);
                    stmts.push(Stmt::VarDecl {
                        local_id: local.id.clone(),
                        init: value,
                        loc: self.loc(*argument),
                    });
                    locals.push(local);
                }
                let mut object = if null_prototype {
                    Expr::Intrinsic {
                        name: "object.createNull".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    }
                } else {
                    Expr::Intrinsic {
                        name: "object.setPrototype".into(),
                        args: vec![
                            Expr::DynObjLit {
                                fields: vec![],
                                r#type: Type::Dyn,
                                loc: loc.clone(),
                            },
                            self.construction_read(&locals[0], arguments[0]),
                        ],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    }
                };
                if let Some(descriptors) = locals.get(1) {
                    object = Expr::LibCall {
                        r#fn: "dyn.defineProperties".into(),
                        args: vec![object, self.construction_read(descriptors, arguments[1])],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    };
                }
                return Ok(Some(Expr::Sequence {
                    stmts,
                    result: Box::new(object),
                    r#type: Type::Dyn,
                    loc,
                }));
            }
            if member.kind() == SyntaxKind::PropertyAccessExpression
                && member.name().text() == "fromEntries"
                && self.standard_object(member.expression())
            {
                let symbol = self.symbol(member.name());
                if !self.primitive_symbol(symbol, "fromEntries", Some("ObjectConstructor")) {
                    return Ok(None);
                }
                let arguments = node.arguments().into_iter().collect::<Vec<_>>();
                if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(
                        node,
                        "Object.fromEntries requires one represented entry array",
                    ));
                }
                // Type assertions are runtime-transparent. Preserve the host
                // brand of a Headers/URLSearchParams source even when a caller
                // casts it through `any` to satisfy an older lib declaration.
                let input = primitives::primitive_source(arguments[0]);
                let input_type = self.checker.get_type_at_location(input);
                let entries = self.expression(arguments[0])?;
                let operation = match entries.ty() {
                    Type::Array { elem } => match *elem {
                        Type::Record { shape_id }
                            if self.records[shape_id].tuple
                                && self.records[shape_id].fields.len() == 2 =>
                        {
                            "dyn.fromEntries"
                        }
                        Type::Array { .. } | Type::Dyn => {
                            // Ordinary JS arrays are valid iterable entry objects;
                            // an erased map result is checked by the runtime before
                            // its two slots are consumed.
                            "dyn.fromEntries"
                        }
                        _ => {
                            return Err(self.refuse(
                                arguments[0],
                                "Object.fromEntries entries require represented pairs",
                            ));
                        }
                    },
                    Type::Map { key, .. } if *key == Type::String => {
                        // A represented Map already owns an insertion-ordered
                        // entry table.  Keep that table typed through the IR so
                        // the backend can preserve value identity without an
                        // intermediate array of boxed pairs.
                        "dyn.fromEntries"
                    }
                    Type::Dyn if self.standard_search_params_type(input_type) => {
                        "dyn.fromSearchParams"
                    }
                    Type::Dyn if self.standard_headers_type(input_type) => "dyn.fromHeaders",
                    _ => {
                        return Err(self.refuse(
                            arguments[0],
                            "Object.fromEntries currently requires a native entry array or string-keyed Map",
                        ));
                    }
                };
                let value = Expr::LibCall {
                    r#fn: operation.into(),
                    args: vec![entries],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                };
                let target = self.ty(node)?;
                return self.coerce(value, target, node).map(Some);
            }
        }
        if node.kind() != SyntaxKind::CallExpression || !self.standard_object(node.expression()) {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "Object argument spreads are not ported"));
        }
        let first = if let Some(arg) = args.first() {
            self.expression(*arg)?
        } else {
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            }
        };
        let first = self.coerce(first, Type::Dyn, node)?;
        if args.len() == 1 {
            return Ok(Some(Expr::LibCall {
                r#fn: "dyn.objectValue".into(),
                args: vec![first],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        let mut values = vec![first];
        for arg in args.iter().skip(1) {
            values.push(self.expected_expression(*arg, Type::Dyn)?);
        }
        let mut helper = helpers::Helper::new(
            "object_value",
            values.iter().map(Expr::ty).collect(),
            Type::Dyn,
            self.loc(node),
        );
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: "dyn.objectValue".into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: Type::Dyn,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Some(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn object_get_prototype_of_call(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "getPrototypeOf"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let member_symbol = self.symbol(member.name());
        if !self.primitive_symbol(member_symbol, "getPrototypeOf", Some("ObjectConstructor")) {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(node, "Object.getPrototypeOf requires one ordinary argument"));
        }
        let value = self.expression(arguments[0])?;
        let value = self.coerce(value, Type::Dyn, arguments[0])?;
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.getPrototypeOf".into(),
            args: vec![value],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn object_prototype_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.name().text() != "prototype"
            || !self.standard_object(node.expression())
        {
            return Ok(None);
        }
        let member = self.symbol(node.name());
        if !self.primitive_symbol(member, "prototype", Some("ObjectConstructor")) {
            return Ok(None);
        }
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.objectPrototype".into(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn object_is_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "is"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 2
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "Object.is requires exactly two ordinary arguments"));
        }
        let left = self.expression(args[0])?;
        let left = self.coerce(left, Type::Dyn, args[0])?;
        let right = self.expression(args[1])?;
        let right = self.coerce(right, Type::Dyn, args[1])?;
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.sameValue".into(),
            args: vec![left, right],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }

    pub(super) fn object_freeze_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "freeze"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(node, "Object.freeze requires one native value"));
        }
        let value = self.expression(args[0])?;
        if matches!(
            value.ty(),
            Type::F64
                | Type::Bool
                | Type::String
                | Type::Bigint
                | Type::Symbol
                | Type::Null
                | Type::Undefined
        ) {
            // ECMAScript returns primitive inputs unchanged and evaluates the
            // argument exactly once; only objects require integrity changes.
            return Ok(Some(value));
        }
        if matches!(value.ty(), Type::Array { .. }) {
            // Native arrays carry an integrity marker: the same handle is
            // returned and every later mutation throws a TypeError.
            let r#type = value.ty();
            return Ok(Some(Expr::ArrayIntrinsic {
                method: "freeze".into(),
                receiver: Box::new(value),
                args: vec![],
                r#type,
                loc: self.loc(node),
            }));
        }
        if matches!(
            value.ty(),
            Type::Dyn | Type::Union { .. } | Type::Record { .. }
        ) {
            let result_type = value.ty();
            let value = self.coerce(value, Type::Dyn, args[0])?;
            let frozen = Expr::LibCall {
                r#fn: "dyn.freezeValue".into(),
                args: vec![value],
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            if matches!(result_type, Type::Record { .. }) {
                return self.coerce(frozen, result_type, node).map(Some);
            }
            return Ok(Some(frozen));
        }
        // Returning an object unchanged silently accepts later writes. Refuse
        // until its owning storage can enforce the frozen integrity level.
        Err(self.refuse(
            args[0],
            "Object.freeze requires native object integrity semantics",
        ))
    }

    pub(super) fn object_is_frozen_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "isFrozen"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(node, "Object.isFrozen requires one native value"));
        }
        let value = self.expression(args[0])?;
        let value = self.coerce(value, Type::Dyn, args[0])?;
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.isFrozenValue".into(),
            args: vec![value],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
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
        // Object.assign(target) performs ToObject and returns that target. A
        // fresh ordinary literal is already an object, so lowering it through
        // its contextual owning layout preserves identity without any copy or
        // synthetic decoration step.
        if arguments.len() == 1 && arguments[0].kind() == SyntaxKind::ObjectLiteralExpression {
            let ty = match expected {
                Some(ref ty) => ty.clone(),
                None => self.ty(node)?,
            };
            return self.expected_expression(arguments[0], ty).map(Some);
        }
        // A fresh ordinary target has not escaped. For two plain literals,
        // constructing the final record preserves its identity and the
        // evaluation order of both argument expressions.
        if arguments.len() == 2
            && arguments.iter().all(|arg| {
                arg.kind() == SyntaxKind::ObjectLiteralExpression
                    && arg.properties().into_iter().all(|property| {
                        matches!(
                            property.kind(),
                            SyntaxKind::PropertyAssignment
                                | SyntaxKind::ShorthandPropertyAssignment
                        ) && matches!(
                            property.name().kind(),
                            SyntaxKind::Identifier | SyntaxKind::StringLiteral
                        ) && property.name().text() != "__proto__"
                    })
            })
        {
            let ty = match expected {
                Some(ref ty @ Type::Record { .. }) => ty.clone(),
                Some(ref ty) => {
                    return Err(self.refuse(
                        node,
                        &format!("Object.assign result needs a native data record; found {ty:?}"),
                    ));
                }
                None => self.ty(node)?,
            };
            if let Type::Record { shape_id } = ty
                && !self.callables.contains_key(&shape_id)
            {
                let properties = arguments
                    .iter()
                    .flat_map(|arg| arg.properties().into_iter())
                    .collect();
                return self.construct_record(node, ty, properties).map(Some);
            }
            return Err(self.refuse(
                node,
                &format!("Object.assign result needs a native data record; found {ty:?}"),
            ));
        }
        if arguments.len() >= 2
            && arguments[0].kind() == SyntaxKind::ObjectLiteralExpression
            && arguments[0].properties().into_iter().all(|property| {
                matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
                ) && matches!(
                    property.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::StringLiteral
                ) && property.name().text() != "__proto__"
            })
        {
            let ty = match expected.as_ref() {
                Some(ty) => ty.clone(),
                None => self.ty(node)?,
            };
            if let Type::Record { shape_id } = ty
                && !self.callables.contains_key(&shape_id)
            {
                return self
                    .construct_record_assign_many(
                        node,
                        ty,
                        arguments[0].properties().into_iter().collect(),
                        arguments.iter().skip(1).copied().collect(),
                    )
                    .map(Some);
            }
            if ty == Type::Dyn {
                let mut stmts = Vec::new();
                let target = self.dynamic_literal(arguments[0])?;
                let target = self.update_temp(target, &mut stmts, arguments[0]);
                let mut sources = Vec::new();
                for source in arguments.iter().skip(1).copied() {
                    let value = self.expected_expression(source, Type::Dyn)?;
                    sources.push(self.update_temp(value, &mut stmts, source));
                }
                for source in sources {
                    let copy = self.dynamic_assign_values(node, target.clone(), source)?;
                    stmts.push(Stmt::Expression {
                        expr: copy,
                        loc: self.loc(node),
                    });
                }
                return Ok(Some(Expr::Sequence {
                    stmts,
                    result: Box::new(target),
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }));
            }
            if parameter_abi::is_javascript(node) {
                // Object.assign returns its first argument. TypeScript can
                // describe the intersection as callable when a later source
                // is callable, but copying enumerable properties never copies
                // the source's internal [[Call]] slot. Keep the fresh target
                // as an ordinary dynamic owner, then attach the requested
                // checked data view over that same property store.
                let mut stmts = Vec::new();
                let target = self.dynamic_literal(arguments[0])?;
                let target = self.update_temp(target, &mut stmts, arguments[0]);
                let mut sources = Vec::new();
                for source in arguments.iter().skip(1).copied() {
                    let value = self.expected_expression(source, Type::Dyn)?;
                    sources.push(self.update_temp(value, &mut stmts, source));
                }
                for source in sources {
                    let copy = self.dynamic_assign_values(node, target.clone(), source)?;
                    stmts.push(Stmt::Expression {
                        expr: copy,
                        loc: self.loc(node),
                    });
                }
                let result = self.coerce(target, ty.clone(), node)?;
                return Ok(Some(Expr::Sequence {
                    stmts,
                    result: Box::new(result),
                    r#type: ty,
                    loc: self.loc(node),
                }));
            }
            return Err(self.refuse(
                node,
                &format!("Object.assign result needs a native data record; found {ty:?}"),
            ));
        }
        if arguments.len() > 2 {
            if arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "Object.assign spread arguments require native argument iteration",
                ));
            }
            let target = self.expression(arguments[0])?;
            let object_union = match target.ty() {
                Type::Union { union_id } => self.unions[union_id]
                    .arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Object { .. } | Type::Record { .. })),
                _ => false,
            };
            if matches!(
                target.ty(),
                Type::Object { .. } | Type::Record { .. } | Type::Dyn
            ) || object_union
            {
                // Calls evaluate all arguments before Object.assign starts
                // copying any properties or invoking any source getter.
                let target_type = target.ty();
                let mut stmts = Vec::new();
                let target = self.update_temp(target, &mut stmts, arguments[0]);
                let mut sources = Vec::new();
                for source in arguments.iter().skip(1).copied() {
                    let value = self.expected_expression(source, Type::Dyn)?;
                    sources.push(self.update_temp(value, &mut stmts, source));
                }
                for source in sources {
                    let copy = self.dynamic_assign_values(node, target.clone(), source)?;
                    stmts.push(Stmt::Expression {
                        expr: copy,
                        loc: self.loc(node),
                    });
                }
                return Ok(Some(Expr::Sequence {
                    stmts,
                    result: Box::new(target),
                    r#type: target_type,
                    loc: self.loc(node),
                }));
            }
        }
        if arguments.len() == 2 {
            let target = self.expression(arguments[0])?;
            if matches!(target.ty(), Type::Func { .. })
                && arguments[1].kind() != SyntaxKind::ObjectLiteralExpression
            {
                // Object.assign decorates the existing target function; a
                // callable source contributes only its enumerable own data.
                // Both NativeValue wrappers expose their shared property
                // stores, so the ordinary dynamic copy preserves target
                // identity while a contextual callable-record view can be
                // rebuilt over that same store afterwards.
                let source = self.expected_expression(arguments[1], Type::Dyn)?;
                let assigned = self.dynamic_assign_values(node, target, source)?;
                let result_type = match expected {
                    Some(ty) => ty,
                    None => self.ty(node)?,
                };
                return self.coerce(assigned, result_type, node).map(Some);
            }
            let object_union = match target.ty() {
                Type::Union { union_id } => self.unions[union_id]
                    .arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Object { .. } | Type::Record { .. })),
                _ => false,
            };
            if matches!(
                target.ty(),
                Type::Object { .. } | Type::Record { .. } | Type::Dyn
            ) || object_union
            {
                let source = self.expected_expression(arguments[1], Type::Dyn)?;
                return self.dynamic_assign_values(node, target, source).map(Some);
            }
        }
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
        if matches!(target.ty(), Type::Object { .. }) {
            let mut values = vec![target];
            let mut names = Vec::new();
            for property in arguments[1].properties() {
                if !matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
                ) || !matches!(
                    property.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::StringLiteral
                ) || property.name().text() == "__proto__"
                {
                    return Err(self.refuse(
                        property,
                        "class instance decoration requires plain named data properties",
                    ));
                }
                let source = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                    property.name()
                } else {
                    property.initializer()
                };
                values.push(self.expected_expression(source, Type::Dyn)?);
                names.push(property.name().text().to_string());
            }
            let ty = values[0].ty();
            let mut helper = helpers::Helper::new(
                "assign_object_properties",
                values.iter().map(Expr::ty).collect(),
                ty.clone(),
                self.loc(node),
            );
            for (index, name) in names.iter().enumerate() {
                let object = self.coerce(helper.read(&helper.param(0)), Type::Dyn, node)?;
                helper.function.body.push(self.checked_dynamic_property_set(
                    node,
                    object,
                    Expr::StrLit {
                        value: name.clone(),
                        r#type: Type::String,
                        loc: helper.loc(),
                    },
                    helper.read(&helper.param(index + 1)),
                )?);
            }
            helper.function.body.push(Stmt::Return {
                value: Some(helper.read(&helper.param(0))),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            return Ok(Some(Expr::Call {
                callee,
                args: values,
                r#type: ty,
                loc: self.loc(node),
            }));
        }
        if matches!(target.ty(), Type::Func { .. }) && !self.fresh_function(arguments[0]) {
            if expected.as_ref().is_some_and(|ty| *ty != target.ty()) {
                return Err(self.refuse(
                    node,
                    "decorated function result requires its owning function storage",
                ));
            }
            let mut values = vec![target];
            let mut names = Vec::new();
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
                        "function decoration requires plain named properties",
                    ));
                }
                let name = property.name().text().to_string();
                self.function_data_key(property, &name)?;
                let source = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                    property.name()
                } else {
                    property.initializer()
                };
                values.push(self.expected_expression(source, Type::Dyn)?);
                names.push(name);
            }
            let ty = values[0].ty();
            let mut helper = helpers::Helper::new(
                "assign_function_properties",
                values.iter().map(Expr::ty).collect(),
                ty.clone(),
                self.loc(node),
            );
            for (index, name) in names.iter().enumerate() {
                let obj = self.coerce(helper.read(&helper.param(0)), Type::Dyn, node)?;
                let key = Expr::StrLit {
                    value: name.clone(),
                    r#type: Type::String,
                    loc: helper.loc(),
                };
                helper.function.body.push(self.checked_dynamic_property_set(
                    node,
                    obj,
                    key,
                    helper.read(&helper.param(index + 1)),
                )?);
            }
            helper.function.body.push(Stmt::Return {
                value: Some(helper.read(&helper.param(0))),
                loc: helper.loc(),
            });
            helper.function.name.push_str(&format!("_{names:?}"));
            let callee = self.install_helper(helper.function);
            return Ok(Some(Expr::Call {
                callee,
                args: values,
                r#type: ty,
                loc: self.loc(node),
            }));
        }
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
                    null_prototype: false,
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
        let expected_result = expected.as_ref().and_then(|ty| {
            let Type::Func { ret, .. } = ty else {
                return None;
            };
            Some((**ret).clone())
        });
        let bound_receiver = arguments.first().and_then(|argument| {
            if argument.kind() == SyntaxKind::ThisKeyword {
                self.instance_this
                    .as_ref()
                    .map(|local| local.r#type.clone())
            } else {
                self.ty(*argument).ok()
            }
        });
        let dynamic_source = self.javascript_prototype_value_candidate(member.expression())
            || (member.expression().kind() == SyntaxKind::Identifier
                && self
                    .binding(member.expression())
                    .is_ok_and(|local| local.r#type == Type::Dyn));
        let prototype_method = if dynamic_source {
            None
        } else if let Some(value) =
            self.codec_method_value(member.expression(), bound_receiver.clone())?
        {
            Some(value)
        } else {
            self.class_prototype_method_value(member.expression(), expected_result, bound_receiver)?
        };
        let explicit_receiver = prototype_method.is_some();
        let value = if let Some(value) = prototype_method {
            value
        } else if dynamic_source
            || owning_rest
            || self.regex_callable_type(source_type).is_some()
            || self.number_predicate_type(source_type).is_some()
            || self.number_parser_type(source_type).is_some()
        {
            // Keep the standard method's owning argument and receiver ABI
            // instead of replacing it with the checker's contextual signature.
            if dynamic_source && member.expression().kind() == SyntaxKind::Identifier {
                self.condition_value(member.expression())?
            } else {
                self.expression(member.expression())?
            }
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
        if target.ty() == Type::Dyn {
            let args = arguments
                .iter()
                .map(|argument| self.expected_expression(*argument, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Some(Expr::DynInvoke {
                recv: Box::new(target),
                method: "bind".into(),
                callee_name: "bind".into(),
                optional: false,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        let Type::Func { params, ret, rest } = target.ty() else {
            return Err(self.refuse(member, "bind requires a native function"));
        };
        let erased_rest = parameters::erased_rest(&target.ty());

        let typed_prefix = if explicit_receiver {
            arguments.len()
        } else {
            arguments.len().saturating_sub(1)
        };
        if arguments.is_empty()
            || (!erased_rest && typed_prefix > params.len().saturating_sub(usize::from(rest)))
        {
            return Err(self.refuse(
                node,
                "bind needs a this argument and a fixed prefix before the rest array",
            ));
        }
        let this_type = if explicit_receiver {
            params.first().cloned().ok_or_else(|| {
                self.refuse(node, "extracted class method is missing its receiver ABI")
            })?
        } else {
            Type::Dyn
        };
        let this = if self.ignored_console_bind_receiver(member.expression(), arguments[0]) {
            // The native console sink never reads its receiver. The ambient
            // global is an effect-free binding, not an exposed object value.
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(arguments[0]),
                },
                this_type,
                arguments[0],
            )?
        } else {
            self.expected_expression(arguments[0], this_type)?
        };
        let mut values = vec![target, this];
        let prefix_start = values.len();
        for (index, argument) in arguments.iter().skip(1).enumerate() {
            let ty = if erased_rest {
                Type::Dyn
            } else {
                params[index + usize::from(explicit_receiver)].clone()
            };
            values.push(self.expected_expression(*argument, ty)?);
        }
        // An owning rest vector is transport, not one source argument slot.
        // Bound values prepend to that vector; the result keeps its complete ABI.
        let prefix = if erased_rest { 0 } else { typed_prefix };
        let result = Type::Func {
            rest,
            params: params[prefix..].to_vec(),
            ret: ret.clone(),
        };
        let key = (
            format!(
                "bind_{}_{prefix_start}",
                if explicit_receiver {
                    "method"
                } else {
                    "function"
                }
            ),
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
            .skip(if explicit_receiver { 1 } else { 2 })
            .map(read)
            .chain(body.function.params.iter().map(read))
            .collect::<Vec<_>>();
        let typed_args = explicit_receiver.then(|| args.clone());
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
        let receiver = if explicit_receiver {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                Type::Dyn,
                node,
            )?
        } else {
            read(&captures[1])
        };
        let call = if let Some(args) = typed_args {
            Expr::CallValue {
                callee: Box::new(read(&captures[0])),
                args,
                r#type: (*ret).clone(),
                loc: self.loc(node),
            }
        } else {
            Expr::DynInvoke {
                recv: Box::new(self.coerce(read(&captures[0]), Type::Dyn, node)?),
                method: "apply".into(),
                callee_name: "bound function".into(),
                optional: false,
                args: vec![receiver, self.coerce(body.read(&list), Type::Dyn, node)?],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }
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
