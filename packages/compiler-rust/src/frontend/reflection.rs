//! Own-key reflection over represented data, without evaluating property values.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

impl Lowerer<'_> {
    fn lower_reflected_property_key(&mut self, node: Node) -> Result<Expr, String> {
        if node.is_nil() {
            return Err("own-property reflection requires a property key".into());
        }
        let value = self.expression(node)?;
        if self.native_type_contains(&value.ty(), |ty| {
            !matches!(
                ty,
                Type::String
                    | Type::F64
                    | Type::Bigint
                    | Type::Bool
                    | Type::Null
                    | Type::Undefined
                    | Type::Void
                    | Type::Symbol
                    | Type::Dyn
                    | Type::Caught
                    | Type::Union { .. }
            )
        }) {
            return Err(self.refuse(
                node,
                "own-property reflection requires a primitive property key",
            ));
        }
        let value = self.primitive_capture(value, node)?;
        self.coerce(value, Type::Dyn, node)
    }

    pub(super) fn native_reflect_dynamic_result_call(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
            || !matches!(
                member.name().text(),
                "get" | "apply" | "getOwnPropertyDescriptor"
            )
        {
            return false;
        }
        let receiver = self.symbol(member.expression());
        self.primitive_symbol(receiver, "Reflect", None)
    }

    pub(super) fn object_get_own_property_names(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "getOwnPropertyNames"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !matches!(arguments.as_slice(), [argument] if argument.kind() != SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Object.getOwnPropertyNames requires one represented native object",
            ));
        }
        let value = self.expression(arguments[0])?;
        let value = self.primitive_capture(value, arguments[0])?;
        if !self.reflected_keys(&value.ty()) {
            return Err(self.refuse(
                arguments[0],
                "Object.getOwnPropertyNames requires represented own-key storage",
            ));
        }
        let value = self.coerce(value, Type::Dyn, arguments[0])?;
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.objectOwnNames".into(),
            args: vec![value],
            r#type: Type::Array {
                elem: Box::new(Type::String),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn object_get_own_property_symbols(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if std::env::var_os("SCRIPTC_TRACE_REFLECTION").is_some()
            && member.kind() == SyntaxKind::PropertyAccessExpression
            && member.name().text() == "getOwnPropertySymbols"
        {
            let receiver = member.expression();
            let symbol = self.symbol(receiver);
            eprintln!(
                "scriptc: getOwnPropertySymbols receiver={:?} text={} symbol={} standard={}",
                receiver.kind(),
                receiver.text(),
                symbol,
                self.standard_object(receiver),
            );
        }
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "getOwnPropertySymbols"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !matches!(arguments.as_slice(), [argument] if argument.kind() != SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Object.getOwnPropertySymbols requires one represented native object",
            ));
        }
        let value = self.expression(arguments[0])?;
        let value = self.primitive_capture(value, arguments[0])?;
        if !self.reflected_keys(&value.ty()) {
            return Err(self.refuse(
                arguments[0],
                "Object.getOwnPropertySymbols requires represented own-key storage",
            ));
        }
        let value = self.coerce(value, Type::Dyn, arguments[0])?;
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.objectOwnSymbols".into(),
            args: vec![value],
            r#type: Type::Array {
                elem: Box::new(Type::Symbol),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn object_define_properties(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "defineProperties"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !matches!(arguments.as_slice(), [target, descriptors]
            if target.kind() != SyntaxKind::SpreadElement
                && descriptors.kind() != SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Object.defineProperties requires a native target and descriptor object",
            ));
        }
        let mut statements = Vec::new();
        let mut values = Vec::new();
        for argument in arguments {
            let value = self.expression(argument)?;
            let value = self.primitive_capture(value, argument)?;
            let value = self.coerce(value, Type::Dyn, argument)?;
            let local = self.construction_local(Type::Dyn, false);
            statements.push(Stmt::VarDecl {
                local_id: local.id.clone(),
                init: value,
                loc: self.loc(argument),
            });
            values.push(local);
        }
        let args = values
            .iter()
            .map(|value| self.construction_read(value, node))
            .collect();
        Ok(Some(Expr::Sequence {
            stmts: statements,
            result: Box::new(Expr::LibCall {
                r#fn: "dyn.defineProperties".into(),
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            }),
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn object_get_own_property_descriptor(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "getOwnPropertyDescriptor"
            || !self.standard_object(member.expression())
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
                "Object.getOwnPropertyDescriptor requires a native target and property key",
            ));
        }
        let target = self.expression(args[0])?;
        let target = self.coerce(target, Type::Dyn, args[0])?;
        let key = self.expression(args[1])?;
        if !self.reflected_property_key(&key.ty()) {
            return Err(self.refuse(
                args[1],
                "Object.getOwnPropertyDescriptor requires a represented property key",
            ));
        }
        let key = self.coerce(key, Type::Dyn, args[1])?;
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.getOwnPropertyDescriptor".into(),
            args: vec![target, key],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn reflect_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        let receiver_symbol = if member.kind() == SyntaxKind::PropertyAccessExpression
            && member.expression().kind() == SyntaxKind::Identifier
        {
            self.symbol(member.expression())
        } else {
            0
        };
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
            || !matches!(
                member.name().text(),
                "apply" | "get" | "set" | "ownKeys" | "getOwnPropertyDescriptor" | "deleteProperty"
            )
            || !self.primitive_symbol(receiver_symbol, "Reflect", None)
        {
            return Ok(None);
        }
        let name = member.name().text();
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if name == "deleteProperty" {
            if !matches!(arguments.as_slice(), [target, key]
                if target.kind() != SyntaxKind::SpreadElement
                    && key.kind() != SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "Reflect.deleteProperty requires a native target and property key",
                ));
            }
            let target = self.expression(arguments[0])?;
            let target = self.primitive_capture(target, arguments[0])?;
            let target = self.coerce(target, Type::Dyn, arguments[0])?;
            let key = self.dynamic_property_key_expression(arguments[1])?;
            let key = self.coerce(key, Type::Dyn, arguments[1])?;
            return Ok(Some(Expr::LibCall {
                r#fn: "dyn.keyDeleteComputed".into(),
                args: vec![
                    target,
                    key,
                    Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                ],
                r#type: Type::Bool,
                loc: self.loc(node),
            }));
        }
        if name == "getOwnPropertyDescriptor" {
            if !matches!(arguments.as_slice(), [target, key]
                if target.kind() != SyntaxKind::SpreadElement
                    && key.kind() != SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "Reflect.getOwnPropertyDescriptor requires a native target and property key",
                ));
            }
            let target = self.expression(arguments[0])?;
            let target = self.primitive_capture(target, arguments[0])?;
            if !self.reflected_keys(&target.ty()) {
                return Err(self.refuse(
                    arguments[0],
                    "Reflect.getOwnPropertyDescriptor requires represented own-key storage",
                ));
            }
            let target = self.coerce(target, Type::Dyn, arguments[0])?;
            let key = self.expression(arguments[1])?;
            if !self.reflected_property_key(&key.ty()) {
                return Err(self.refuse(
                    arguments[1],
                    "Reflect.getOwnPropertyDescriptor requires a represented property key",
                ));
            }
            let key = self.coerce(key, Type::Dyn, arguments[1])?;
            return Ok(Some(Expr::LibCall {
                r#fn: "dyn.getOwnPropertyDescriptor".into(),
                args: vec![target, key],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        if name == "apply" {
            if !matches!(arguments.as_slice(), [target, receiver, list]
                if target.kind() != SyntaxKind::SpreadElement
                    && receiver.kind() != SyntaxKind::SpreadElement
                    && list.kind() != SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "Reflect.apply requires a native callable, receiver, and argument array",
                ));
            }
            let mut statements = Vec::new();
            let mut values = Vec::new();
            for argument in arguments {
                let value = self.expression(argument)?;
                let value = self.primitive_capture(value, argument)?;
                let value = self.coerce(value, Type::Dyn, argument)?;
                let local = self.construction_local(Type::Dyn, false);
                statements.push(Stmt::VarDecl {
                    local_id: local.id.clone(),
                    init: value,
                    loc: self.loc(argument),
                });
                values.push(local);
            }
            let args = values
                .iter()
                .map(|value| self.construction_read(value, node))
                .collect();
            return Ok(Some(Expr::Sequence {
                stmts: statements,
                result: Box::new(Expr::LibCall {
                    r#fn: "dyn.reflectApply".into(),
                    args,
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        if name == "ownKeys" {
            if !matches!(arguments.as_slice(), [argument] if argument.kind() != SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "Reflect.ownKeys requires one represented native object",
                ));
            }
            let value = self.expression(arguments[0])?;
            let value = self.primitive_capture(value, arguments[0])?;
            if !self.reflected_keys(&value.ty()) {
                return Err(self.refuse(
                    arguments[0],
                    "Reflect.ownKeys requires represented own-key storage",
                ));
            }
            let value = self.coerce(value, Type::Dyn, arguments[0])?;
            return Ok(Some(Expr::LibCall {
                r#fn: "dyn.reflectOwnKeys".into(),
                args: vec![value],
                r#type: Type::Array {
                    elem: Box::new(Type::Dyn),
                },
                loc: self.loc(node),
            }));
        }
        let required = if name == "get" { 2..=3 } else { 3..=4 };
        if !required.contains(&arguments.len())
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Reflect.get/set require their native positional arguments",
            ));
        }
        let mut statements = Vec::new();
        let mut values = Vec::new();
        for argument in arguments {
            let value = self.expression(argument)?;
            let value = self.primitive_capture(value, argument)?;
            let value = self.coerce(value, Type::Dyn, argument)?;
            let local = self.construction_local(Type::Dyn, false);
            statements.push(Stmt::VarDecl {
                local_id: local.id.clone(),
                init: value,
                loc: self.loc(argument),
            });
            values.push(local);
        }
        if (name == "get" && values.len() == 2) || (name == "set" && values.len() == 3) {
            values.push(values[0].clone());
        }
        let result_type = if name == "get" { Type::Dyn } else { Type::Bool };
        let args = values
            .iter()
            .map(|value| self.construction_read(value, node))
            .collect();
        Ok(Some(Expr::Sequence {
            stmts: statements,
            result: Box::new(Expr::LibCall {
                r#fn: format!("dyn.reflect{}", if name == "get" { "Get" } else { "Set" }),
                args,
                r#type: result_type.clone(),
                loc: self.loc(node),
            }),
            r#type: result_type,
            loc: self.loc(node),
        }))
    }

    fn array_excluded_by_guard(&mut self, node: Node, target: Node) -> bool {
        if target.kind() != SyntaxKind::Identifier {
            return false;
        }
        let target_symbol = self.symbol(target);
        let mut child = node;
        let mut parent = node.parent();
        while !parent.is_nil() && parent.kind() != SyntaxKind::SourceFile {
            if parent.kind() == SyntaxKind::IfStatement && parent.else_statement() == child {
                let condition = primitives::primitive_source(parent.expression());
                if condition.kind() == SyntaxKind::CallExpression {
                    let member = primitives::primitive_source(condition.expression());
                    let arguments = condition.arguments().into_iter().collect::<Vec<_>>();
                    if member.kind() == SyntaxKind::PropertyAccessExpression
                        && member.name().text() == "isArray"
                        && member.expression().kind() == SyntaxKind::Identifier
                        && arguments.len() == 1
                        && primitives::primitive_source(arguments[0]).kind()
                            == SyntaxKind::Identifier
                        && self.symbol(primitives::primitive_source(arguments[0])) == target_symbol
                    {
                        let array_symbol = self.symbol(member.expression());
                        let member_symbol = self.symbol(member.name());
                        if self.primitive_symbol(array_symbol, "Array", None)
                            && self.primitive_symbol(
                                member_symbol,
                                "isArray",
                                Some("ArrayConstructor"),
                            )
                        {
                            return true;
                        }
                    }
                }
            }
            child = parent;
            parent = parent.parent();
        }
        false
    }

    pub(super) fn object_define_data(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "defineProperty"
            || !self.standard_object(member.expression())
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 3 {
            return Err(self.refuse(node, "property descriptor requires native data attributes"));
        }
        let has_getter = args[2].kind() == SyntaxKind::ObjectLiteralExpression
            && args[2].properties().into_iter().any(|property| {
                property.name().text() == "get"
                    && matches!(
                        property.kind(),
                        SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                    )
            });
        let has_setter = args[2].kind() == SyntaxKind::ObjectLiteralExpression
            && args[2].properties().into_iter().any(|property| {
                property.name().text() == "set"
                    && matches!(
                        property.kind(),
                        SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                    )
            });
        if has_getter && has_setter {
            return self.object_define_accessor(node, args).map(Some);
        }
        if has_getter {
            return self.object_define_getter(node, args).map(Some);
        }
        if has_setter {
            return self.object_define_setter(node, args).map(Some);
        }
        if args[2].kind() != SyntaxKind::ObjectLiteralExpression {
            let target = self.expression(args[0])?;
            if target.ty() != Type::Dyn {
                return Err(self.refuse(
                    args[0],
                    "dynamic property descriptors require an erased ordinary object",
                ));
            }
            let key = self.expression(args[1])?;
            if !matches!(key.ty(), Type::String | Type::Symbol | Type::Dyn) {
                return Err(self.refuse(
                    args[1],
                    "dynamic property descriptor keys require a string or symbol",
                ));
            }
            let key = self.coerce(key, Type::Dyn, args[1])?;
            let descriptor = self.expression(args[2])?;
            let descriptor = self.coerce(descriptor, Type::Dyn, args[2])?;
            return Ok(Some(Expr::LibCall {
                r#fn: "dyn.defineOrdinaryData".into(),
                args: vec![target, key, descriptor],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        let mut value = None;
        let mut attributes = HashMap::new();
        for property in args[2].properties() {
            let (name, initializer) = match property.kind() {
                SyntaxKind::PropertyAssignment
                    if matches!(
                        property.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    ) =>
                {
                    (property.name().text(), property.initializer())
                }
                SyntaxKind::ShorthandPropertyAssignment
                    if property.name().kind() == SyntaxKind::Identifier =>
                {
                    (property.name().text(), property.name())
                }
                _ => {
                    return Err(self.refuse(
                        property,
                        "property descriptor requires named data attributes",
                    ));
                }
            };
            match name {
                "value" if value.is_none() => value = Some(initializer),
                name @ ("writable" | "enumerable" | "configurable")
                    if matches!(
                        initializer.kind(),
                        SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword
                    ) && attributes
                        .insert(
                            name.to_string(),
                            initializer.kind() == SyntaxKind::TrueKeyword,
                        )
                        .is_none() => {}
                _ => {
                    return Err(
                        self.refuse(property, "property descriptor attributes are not ported")
                    );
                }
            }
        }
        // `Object.defineProperty(Klass.prototype, 'getter', { enumerable: true })`
        // (ws's DOM-style events) only changes the enumerability of a declared
        // class accessor. Native class accessors keep their dispatch; the one
        // observable difference is inherited `for...in` enumeration, which
        // native instances do not report (known gap).
        if value.is_none()
            && attributes
                .keys()
                .all(|name| matches!(name.as_str(), "enumerable" | "configurable"))
            && node.parent().kind() == SyntaxKind::ExpressionStatement
            && args[0].kind() == SyntaxKind::PropertyAccessExpression
            && args[0].name().text() == "prototype"
            && args[0].expression().kind() == SyntaxKind::Identifier
            && {
                // The key is a literal, or the parameter of
                // `['a', 'b'].forEach((property) => ...)` over literal names.
                let keys = if matches!(
                    args[1].kind(),
                    SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
                ) {
                    vec![args[1].text().to_string()]
                } else if args[1].kind() == SyntaxKind::Identifier {
                    let symbol = self.symbol(args[1]);
                    let parameter = (symbol != 0)
                        .then(|| self.checker.sym(SymbolId(symbol)).value_declaration)
                        .filter(|node| !node.is_nil() && node.kind() == SyntaxKind::Parameter);
                    parameter
                        .and_then(|parameter| {
                            let callback = parameter.parent();
                            let call = callback.parent();
                            let member = call.expression();
                            let list = if call.kind() == SyntaxKind::CallExpression
                                && member.kind() == SyntaxKind::PropertyAccessExpression
                                && member.name().text() == "forEach"
                                && callback.parameters().get(0) == parameter
                            {
                                primitives::primitive_source(member.expression())
                            } else {
                                Node::NIL
                            };
                            (list.kind() == SyntaxKind::ArrayLiteralExpression)
                                .then(|| {
                                    list.elements()
                                        .into_iter()
                                        .map(|element| {
                                            (element.kind() == SyntaxKind::StringLiteral)
                                                .then(|| element.text().to_string())
                                        })
                                        .collect::<Option<Vec<_>>>()
                                })
                                .flatten()
                        })
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                let symbol = self.symbol(args[0].expression());
                !keys.is_empty()
                    && keys
                        .iter()
                        .all(|key| self.classes.declares_accessor(symbol, key))
            }
        {
            return Ok(Some(Expr::DynFrom {
                value: Box::new(Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                }),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        let Some(value) = value else {
            return Err(self.refuse(node, "property descriptor requires an explicit value"));
        };
        // Descriptor writes need the binding's owning storage, not a transient
        // checker refinement from a preceding `Array.isArray` branch. The
        // emitted operation performs its own live ordinary-object check.
        let target = if args[0].kind() == SyntaxKind::Identifier
            && let Ok(local) = self.binding(args[0])
        {
            Expr::VarRef {
                local_id: local.id,
                r#type: local.r#type,
                loc: self.loc(args[0]),
            }
        } else {
            self.expression(args[0])?
        };
        let record = match target.ty() {
            Type::Record { shape_id } => {
                let record = self.records[shape_id].clone();
                if record.tuple
                    || record.index_value.is_some()
                    || self.callables.contains_key(&shape_id)
                    || self.enum_shape(shape_id)
                {
                    return Err(self.refuse(
                        args[0],
                        "property descriptor requires a closed ordinary native record",
                    ));
                }
                Some(record)
            }
            // Class constructors are function objects with their own shared
            // property store. The backend already exposes that store through
            // native_function_properties, so data descriptors such as the
            // standard `name` rewrite used by class factories belong on the
            // same dynamic descriptor path as ordinary functions.
            Type::Dyn | Type::Object { .. } | Type::Classval { .. } => None,
            Type::Array { .. } if self.array_excluded_by_guard(node, args[0]) => None,
            Type::Union { union_id }
                if self.unions[union_id].arms.iter().all(|arm| {
                    matches!(arm, Type::Dyn | Type::Array { .. } | Type::Record { .. })
                }) =>
            {
                // Control-flow guards such as `Array.isArray(parent)` select
                // the ordinary-object arm before this call. Keep the union's
                // owning identity and let the dynamic descriptor operation
                // validate the live arm instead of copying it to a record.
                None
            }
            other => {
                return Err(self.refuse(
                    args[0],
                    &format!(
                        "property descriptor requires an ordinary native record, got {other:?}"
                    ),
                ));
            }
        };
        let name = self.literal_property_key(args[1]);
        let key = if let Some(name) = name.as_deref() {
            if name == "__proto__" {
                return Err(self.refuse(args[1], "prototype property descriptors are not ported"));
            }
            self.expected_expression(args[1], Type::String)?
        } else {
            let key = self.expression(args[1])?;
            if !matches!(key.ty(), Type::String | Type::Symbol | Type::Dyn) {
                return Err(self.refuse(
                    args[1],
                    "property descriptor requires a represented string or symbol key",
                ));
            }
            key
        };
        let value = if let Some(field) = record.as_ref().and_then(|record| {
            record
                .fields
                .iter()
                .find(|field| Some(field.name.as_str()) == name.as_deref())
        }) {
            let value = self.expected_expression(value, field.r#type.clone())?;
            self.coerce(value, Type::Dyn, node)?
        } else {
            self.expected_expression(value, Type::Dyn)?
        };
        let ty = target.ty();
        // Helper interning uses its name and signature. Attribute flags are
        // embedded in the helper body, so different descriptors must not
        // reuse the first helper installed for the same parameter types.
        let helper_name = format!(
            "define_data_property_{:?}_{:?}_{:?}",
            attributes.get("writable"),
            attributes.get("enumerable"),
            attributes.get("configurable")
        );
        let mut helper = helpers::Helper::new(
            &helper_name,
            vec![ty.clone(), key.ty(), Type::Dyn],
            ty.clone(),
            self.loc(node),
        );
        let object = self.coerce(helper.read(&helper.param(0)), Type::Dyn, node)?;
        let key_arg = self.coerce(helper.read(&helper.param(1)), Type::Dyn, node)?;
        let mut fields = vec![ir::DynamicField {
            key: Expr::StrLit {
                value: "value".into(),
                r#type: Type::String,
                loc: helper.loc(),
            },
            value: helper.read(&helper.param(2)),
        }];
        for name in ["writable", "enumerable", "configurable"] {
            let Some(value) = attributes.get(name).copied() else {
                continue;
            };
            fields.push(ir::DynamicField {
                key: Expr::StrLit {
                    value: name.into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                },
                value: self.coerce(
                    Expr::BoolLit {
                        value,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    Type::Dyn,
                    node,
                )?,
            });
        }
        helper.function.body.push(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.defineOrdinaryData".into(),
                args: vec![
                    object,
                    key_arg,
                    Expr::DynObjLit {
                        fields,
                        r#type: Type::Dyn,
                        loc: helper.loc(),
                    },
                ],
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        helper.function.body.push(Stmt::Return {
            value: Some(helper.read(&helper.param(0))),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: vec![target, key, value],
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    fn object_define_getter(&mut self, node: Node, args: Vec<Node>) -> Result<Expr, String> {
        let mut getter = None;
        let mut enumerable = None;
        let mut configurable = None;
        let mut flags = HashSet::new();
        for property in args[2].properties() {
            match property.kind() {
                SyntaxKind::MethodDeclaration
                    if property.name().text() == "get" && getter.is_none() =>
                {
                    if !property.parameters().is_empty() {
                        return Err(
                            self.refuse(property, "getter descriptor requires zero parameters")
                        );
                    }
                    getter = Some(property);
                }
                SyntaxKind::PropertyAssignment
                    if property.name().text() == "get" && getter.is_none() =>
                {
                    let value = primitives::primitive_source(property.initializer());
                    if !matches!(
                        value.kind(),
                        SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
                    ) || !value.parameters().is_empty()
                    {
                        return Err(self.refuse(
                            property,
                            "getter descriptor requires a zero-parameter function",
                        ));
                    }
                    getter = Some(property);
                }
                SyntaxKind::PropertyAssignment
                    if matches!(property.name().text(), "enumerable" | "configurable") =>
                {
                    let name = property.name().text();
                    if !flags.insert(name.to_string())
                        || !matches!(
                            property.initializer().kind(),
                            SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword
                        )
                    {
                        return Err(self.refuse(
                            property,
                            "getter descriptor attributes require distinct boolean literals",
                        ));
                    }
                    let value = property.initializer().kind() == SyntaxKind::TrueKeyword;
                    if name == "enumerable" {
                        enumerable = Some(value);
                    } else {
                        configurable = Some(value);
                    }
                }
                _ => {
                    return Err(self.refuse(
                        property,
                        "getter descriptor supports only a getter and literal attributes",
                    ));
                }
            }
        }
        let getter =
            getter.ok_or_else(|| self.refuse(node, "getter descriptor requires a getter"))?;
        let target = self.expression(args[0])?;
        let target_type = target.ty();
        if !matches!(
            target_type,
            Type::Dyn | Type::Record { .. } | Type::Func { .. } | Type::Object { .. }
        ) {
            return Err(self.refuse(
                args[0],
                "getter descriptor requires an ordinary object or function",
            ));
        }
        let key = self.expression(args[1])?;
        if !matches!(key.ty(), Type::String | Type::Dyn) {
            return Err(self.refuse(
                args[1],
                "getter descriptor keys require represented strings",
            ));
        }
        let key = self.coerce(key, Type::Dyn, args[1])?;
        let function = self.object_property_value(getter, Type::Dyn)?;
        let mut helper = helpers::Helper::new(
            "define_getter",
            vec![target_type.clone(), Type::Dyn, Type::Dyn],
            target_type.clone(),
            self.loc(node),
        );
        helper
            .function
            .name
            .push_str(&format!("_{enumerable:?}_{configurable:?}"));
        let receiver = helper.param(0);
        let result = Expr::LibCall {
            r#fn: "dyn.defineOrdinaryGetter".into(),
            args: vec![
                self.coerce(helper.read(&receiver), Type::Dyn, node)?,
                helper.read(&helper.param(1)),
                helper.read(&helper.param(2)),
                self.coerce(
                    enumerable.map_or_else(
                        || Expr::UnitLit {
                            unit: "undefined".into(),
                            r#type: Type::Undefined,
                            loc: helper.loc(),
                        },
                        |value| Expr::BoolLit {
                            value,
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        },
                    ),
                    Type::Dyn,
                    node,
                )?,
                self.coerce(
                    configurable.map_or_else(
                        || Expr::UnitLit {
                            unit: "undefined".into(),
                            r#type: Type::Undefined,
                            loc: helper.loc(),
                        },
                        |value| Expr::BoolLit {
                            value,
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        },
                    ),
                    Type::Dyn,
                    node,
                )?,
            ],
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::Expression {
            expr: result,
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&receiver));
        Ok(Expr::Call {
            callee,
            args: vec![target, key, function],
            r#type: target_type,
            loc: self.loc(node),
        })
    }

    fn object_define_accessor(&mut self, node: Node, args: Vec<Node>) -> Result<Expr, String> {
        let mut getter = None;
        let mut setter = None;
        let mut enumerable = None;
        let mut configurable = None;
        let mut flags = HashSet::new();
        for property in args[2].properties() {
            let name = property.name().text();
            match property.kind() {
                SyntaxKind::MethodDeclaration if name == "get" && getter.is_none() => {
                    if !property.parameters().is_empty() {
                        return Err(
                            self.refuse(property, "getter descriptor requires zero parameters")
                        );
                    }
                    getter = Some(property);
                }
                SyntaxKind::PropertyAssignment if name == "get" && getter.is_none() => {
                    let value = primitives::primitive_source(property.initializer());
                    if !matches!(
                        value.kind(),
                        SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
                    ) || !value.parameters().is_empty()
                    {
                        return Err(self.refuse(
                            property,
                            "getter descriptor requires a zero-parameter function",
                        ));
                    }
                    getter = Some(property);
                }
                SyntaxKind::MethodDeclaration if name == "set" && setter.is_none() => {
                    if property.parameters().len() != 1 {
                        return Err(
                            self.refuse(property, "setter descriptor requires one parameter")
                        );
                    }
                    setter = Some(property);
                }
                SyntaxKind::PropertyAssignment if name == "set" && setter.is_none() => {
                    let value = primitives::primitive_source(property.initializer());
                    if !matches!(
                        value.kind(),
                        SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
                    ) || value.parameters().len() != 1
                    {
                        return Err(self.refuse(
                            property,
                            "setter descriptor requires a one-parameter function",
                        ));
                    }
                    setter = Some(property);
                }
                SyntaxKind::PropertyAssignment
                    if matches!(name.as_ref(), "enumerable" | "configurable") =>
                {
                    if !flags.insert(name.to_string())
                        || !matches!(
                            property.initializer().kind(),
                            SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword
                        )
                    {
                        return Err(self.refuse(
                            property,
                            "accessor descriptor attributes require distinct boolean literals",
                        ));
                    }
                    let value = property.initializer().kind() == SyntaxKind::TrueKeyword;
                    if name == "enumerable" {
                        enumerable = Some(value);
                    } else {
                        configurable = Some(value);
                    }
                }
                _ => {
                    return Err(self.refuse(
                        property,
                        "accessor descriptor supports only get, set, and literal attributes",
                    ));
                }
            }
        }
        let getter =
            getter.ok_or_else(|| self.refuse(node, "accessor descriptor needs a getter"))?;
        let setter =
            setter.ok_or_else(|| self.refuse(node, "accessor descriptor needs a setter"))?;
        let target = self.expression(args[0])?;
        let target_type = target.ty();
        if !matches!(
            target_type,
            Type::Dyn
                | Type::Record { .. }
                | Type::Func { .. }
                | Type::Object { .. }
                | Type::Classval { .. }
        ) {
            return Err(self.refuse(
                args[0],
                "accessor descriptor requires an ordinary object or function",
            ));
        }
        let key = self.expression(args[1])?;
        if !matches!(key.ty(), Type::String | Type::Dyn) {
            return Err(self.refuse(
                args[1],
                "accessor descriptor keys require represented strings",
            ));
        }
        let key = self.coerce(key, Type::Dyn, args[1])?;
        let getter = self.object_property_value(getter, Type::Dyn)?;
        let setter = self.object_property_value(setter, Type::Dyn)?;
        let mut helper = helpers::Helper::new(
            "define_accessor",
            vec![target_type.clone(), Type::Dyn, Type::Dyn, Type::Dyn],
            target_type.clone(),
            self.loc(node),
        );
        helper
            .function
            .name
            .push_str(&format!("_{enumerable:?}_{configurable:?}"));
        let receiver = helper.param(0);
        let attribute = |value: Option<bool>, helper: &helpers::Helper| {
            value.map_or_else(
                || Expr::UnitLit {
                    unit: "undefined".into(),
                    r#type: Type::Undefined,
                    loc: helper.loc(),
                },
                |value| Expr::BoolLit {
                    value,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
            )
        };
        let enumerable = attribute(enumerable, &helper);
        let configurable = attribute(configurable, &helper);
        let enumerable = self.coerce(enumerable, Type::Dyn, node)?;
        let configurable = self.coerce(configurable, Type::Dyn, node)?;
        helper.function.body.push(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.defineOrdinaryAccessor".into(),
                args: vec![
                    self.coerce(helper.read(&receiver), Type::Dyn, node)?,
                    helper.read(&helper.param(1)),
                    helper.read(&helper.param(2)),
                    helper.read(&helper.param(3)),
                    enumerable,
                    configurable,
                ],
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&receiver));
        Ok(Expr::Call {
            callee,
            args: vec![target, key, getter, setter],
            r#type: target_type,
            loc: self.loc(node),
        })
    }

    fn object_define_setter(&mut self, node: Node, args: Vec<Node>) -> Result<Expr, String> {
        let mut setter = None;
        let mut enumerable = None;
        let mut configurable = None;
        let mut flags = HashSet::new();
        for property in args[2].properties() {
            match property.kind() {
                SyntaxKind::MethodDeclaration
                    if property.name().text() == "set" && setter.is_none() =>
                {
                    setter = Some(property);
                }
                SyntaxKind::PropertyAssignment
                    if property.name().text() == "set" && setter.is_none() =>
                {
                    let value = primitives::primitive_source(property.initializer());
                    if !matches!(
                        value.kind(),
                        SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
                    ) || value.parameters().len() != 1
                    {
                        return Err(self.refuse(
                            property,
                            "setter descriptor requires a one-parameter function",
                        ));
                    }
                    setter = Some(property);
                }
                SyntaxKind::PropertyAssignment
                    if matches!(property.name().text(), "enumerable" | "configurable") =>
                {
                    let name = property.name().text();
                    if !flags.insert(name.to_string())
                        || !matches!(
                            property.initializer().kind(),
                            SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword
                        )
                    {
                        return Err(self.refuse(
                            property,
                            "setter descriptor attributes require distinct boolean literals",
                        ));
                    }
                    let value = property.initializer().kind() == SyntaxKind::TrueKeyword;
                    if name == "enumerable" {
                        enumerable = Some(value);
                    } else {
                        configurable = Some(value);
                    }
                }
                _ => {
                    return Err(self.refuse(
                        property,
                        "setter descriptor supports only a setter and literal attributes",
                    ));
                }
            }
        }
        let setter =
            setter.ok_or_else(|| self.refuse(node, "setter descriptor requires a setter"))?;
        let target = self.expression(args[0])?;
        let target_type = target.ty();
        if !matches!(
            target_type,
            Type::Dyn | Type::Record { .. } | Type::Func { .. } | Type::Object { .. }
        ) {
            return Err(self.refuse(
                args[0],
                "setter descriptor requires an ordinary object, function, or class instance",
            ));
        }
        let key = self.expression(args[1])?;
        if !matches!(key.ty(), Type::String | Type::Dyn) {
            return Err(self.refuse(
                args[1],
                "setter descriptor keys require represented strings",
            ));
        }
        let key = self.coerce(key, Type::Dyn, args[1])?;
        let function = self.object_property_value(setter, Type::Dyn)?;
        let mut helper = helpers::Helper::new(
            "define_setter",
            vec![target_type.clone(), Type::Dyn, Type::Dyn],
            target_type.clone(),
            self.loc(node),
        );
        helper
            .function
            .name
            .push_str(&format!("_{enumerable:?}_{configurable:?}"));
        let receiver = helper.param(0);
        helper.function.body.push(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.defineOrdinarySetter".into(),
                args: vec![
                    self.coerce(helper.read(&receiver), Type::Dyn, node)?,
                    helper.read(&helper.param(1)),
                    helper.read(&helper.param(2)),
                    self.coerce(
                        enumerable.map_or_else(
                            || Expr::UnitLit {
                                unit: "undefined".into(),
                                r#type: Type::Undefined,
                                loc: helper.loc(),
                            },
                            |value| Expr::BoolLit {
                                value,
                                r#type: Type::Bool,
                                loc: helper.loc(),
                            },
                        ),
                        Type::Dyn,
                        node,
                    )?,
                    self.coerce(
                        configurable.map_or_else(
                            || Expr::UnitLit {
                                unit: "undefined".into(),
                                r#type: Type::Undefined,
                                loc: helper.loc(),
                            },
                            |value| Expr::BoolLit {
                                value,
                                r#type: Type::Bool,
                                loc: helper.loc(),
                            },
                        ),
                        Type::Dyn,
                        node,
                    )?,
                ],
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&receiver));
        Ok(Expr::Call {
            callee,
            args: vec![target, key, function],
            r#type: target_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn object_prototype_has_own_call(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let call = node.expression();
        if call.kind() != SyntaxKind::PropertyAccessExpression || call.name().text() != "call" {
            return Ok(None);
        }
        let method = call.expression();
        if method.kind() != SyntaxKind::PropertyAccessExpression
            || method.name().text() != "hasOwnProperty"
        {
            return Ok(None);
        }
        let prototype = method.expression();
        if prototype.kind() != SyntaxKind::PropertyAccessExpression
            || prototype.name().text() != "prototype"
            || prototype.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let object = self.symbol(prototype.expression());
        let prototype_symbol = self.symbol(prototype.name());
        let method_symbol = self.symbol(method.name());
        let call_symbol = self.symbol(call.name());
        if !self.primitive_symbol(object, "Object", None)
            || !self.primitive_symbol(prototype_symbol, "prototype", Some("ObjectConstructor"))
            || !self.primitive_symbol(method_symbol, "hasOwnProperty", Some("Object"))
            || !(self.primitive_symbol(call_symbol, "call", Some("Function"))
                || self.primitive_symbol(call_symbol, "call", Some("CallableFunction")))
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 2
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "hasOwnProperty.call requires a represented receiver and string key",
            ));
        }
        let value = self.expression(args[0])?;
        let unit = matches!(value.ty(), Type::Null | Type::Undefined);
        let value = self.primitive_capture(value, args[0])?;
        if !self.reflected_record(&value.ty()) && !unit {
            return Err(self.refuse(
                args[0],
                "hasOwnProperty.call requires a represented data record",
            ));
        }
        let value = self.coerce(value, Type::Dyn, args[0])?;
        let key = self.lower_reflected_property_key(args[1])?;
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.hasOwnKey".into(),
            args: vec![value, key],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }

    pub(super) fn object_reflection(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let name = member.name().text();
        if !matches!(name, "keys" | "values" | "entries" | "hasOwn") {
            return Ok(None);
        }
        let symbol = self.symbol(member.expression());
        if symbol == 0 {
            return Ok(None);
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        if symbol.name.as_ref() != "Object"
            || symbol.declarations.is_empty()
            || !symbol.declarations.iter().all(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                source_frontend::frontend::bundled::bundled_lib_name(&file.file_name)
                    == Some("lib.es5.d.ts")
            })
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "reflection argument spreads are not ported"));
        }
        if name == "hasOwn" && args.len() != 2 {
            return Err(self.refuse(
                node,
                "native record reflection argument count is not ported",
            ));
        }
        let value = if let Some(arg) = args.first() {
            self.expression(*arg)?
        } else {
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            }
        };
        let value = self.primitive_capture(value, node)?;
        if !(if matches!(name, "keys" | "values" | "entries") {
            self.reflected_keys(&value.ty())
        } else {
            self.reflected_record(&value.ty())
        }) {
            return Err(self.refuse(node, "own-key reflection requires a closed data record"));
        }
        let value = self.coerce(value, Type::Dyn, node)?;
        if name == "hasOwn" {
            let key = self.lower_reflected_property_key(args[1])?;
            return Ok(Some(Expr::LibCall {
                r#fn: "dyn.hasOwnKey".into(),
                args: vec![value, key],
                r#type: Type::Bool,
                loc: self.loc(node),
            }));
        }
        // Reflection returns erased keys. Read them into the typed array ABI;
        // values capture each current value and entries capture fresh pairs.
        let element = if name == "entries" {
            let inferred = self.ty(node).ok().and_then(|ty| match ty {
                Type::Array { elem } => match *elem {
                    Type::Record { shape_id }
                        if self.records[shape_id].tuple
                            && self.records[shape_id].fields.len() == 2
                            && self.records[shape_id]
                                .fields
                                .iter()
                                .any(|f| f.name == "0" && f.r#type == Type::String) =>
                    {
                        Some(Type::Record { shape_id })
                    }
                    Type::Array { elem } if *elem == Type::String => Some(Type::Array { elem }),
                    _ => None,
                },
                _ => None,
            });
            inferred.unwrap_or_else(|| {
                self.intern_tuple(vec![Type::String, Type::Dyn])
                    .expect("entry tuple")
            })
        } else if name == "values" {
            Type::Dyn
        } else {
            Type::String
        };
        let array = Type::Array {
            elem: Box::new(element.clone()),
        };
        // A call evaluates every argument before ToObject. Keep ignored extras
        // as ordinary typed parameters, including their exceptions and effects.
        let mut values = vec![value];
        for arg in args.iter().skip(1) {
            let value = self.expression(*arg)?;
            let value = self.primitive_capture(value, *arg)?;
            values.push(self.coerce(value, Type::Dyn, *arg)?);
        }
        let mut helper = helpers::Helper::new(
            "record_keys",
            values.iter().map(Expr::ty).collect(),
            array.clone(),
            self.loc(node),
        );
        let keys = helper.local("keys", Type::Dyn, false);
        let result = helper.local("result", array.clone(), false);
        let index = helper.local("index", Type::F64, true);
        let length = helper.local("length", Type::F64, false);
        helper.declare(
            &keys,
            Expr::LibCall {
                r#fn: "dyn.objKeys".into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
        );
        helper.declare(
            &result,
            Expr::ArrayLit {
                elems: vec![],
                r#type: array.clone(),
                loc: helper.loc(),
            },
        );
        helper.declare(&index, helper.number(0.0));
        let length_value = self.dynamic_get(
            node,
            helper.read(&keys),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: helper.loc(),
            },
        );
        helper.declare(&length, self.coerce(length_value, Type::F64, node)?);
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let key_item = self.dynamic_get(node, helper.read(&keys), key);
        let key_item = self.coerce(key_item, Type::String, node)?;
        let item = if name == "entries" {
            match element.clone() {
                Type::Record { shape_id } => {
                    let value_type = self.records[shape_id]
                        .fields
                        .iter()
                        .find(|f| f.name == "1")
                        .expect("entry value")
                        .r#type
                        .clone();
                    let value =
                        self.dynamic_get(node, helper.read(&helper.param(0)), key_item.clone());
                    let value = self.coerce(value, value_type, node)?;
                    Expr::RecordLit {
                        null_prototype: false,
                        fields: vec![
                            ir::FieldInit {
                                name: "0".into(),
                                value: key_item,
                                absent: false,
                                overflow: false,
                            },
                            ir::FieldInit {
                                name: "1".into(),
                                value,
                                absent: false,
                                overflow: false,
                            },
                        ],
                        r#type: Type::Record { shape_id },
                        loc: helper.loc(),
                    }
                }
                Type::Array { elem } => {
                    let value =
                        self.dynamic_get(node, helper.read(&helper.param(0)), key_item.clone());
                    let key = self.coerce(key_item, (*elem).clone(), node)?;
                    let value = self.coerce(value, (*elem).clone(), node)?;
                    Expr::ArrayLit {
                        elems: vec![key, value],
                        r#type: Type::Array { elem },
                        loc: helper.loc(),
                    }
                }
                _ => unreachable!("Object.entries pair representation"),
            }
        } else if name == "values" {
            self.dynamic_get(node, helper.read(&helper.param(0)), key_item)
        } else {
            key_item
        };
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: vec![
                Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&result)),
                        args: vec![item],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    },
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&result));
        Ok(Some(Expr::Call {
            callee,
            args: values,
            r#type: array,
            loc: self.loc(node),
        }))
    }

    fn reflected_keys(&self, ty: &Type) -> bool {
        match ty {
            Type::Dyn
            | Type::F64
            | Type::Bool
            | Type::String
            | Type::Symbol
            | Type::Null
            | Type::Undefined
            | Type::Array { .. }
            | Type::Bytes { .. }
            | Type::Promise { .. }
            | Type::Func { .. } => true,
            Type::Record { shape_id } => {
                !self.enum_shape(*shape_id) && !self.callables.contains_key(shape_id)
            }
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.reflected_keys(arm)),
            _ => false,
        }
    }

    fn reflected_property_key(&self, ty: &Type) -> bool {
        match ty {
            Type::String | Type::Symbol | Type::Dyn => true,
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.reflected_property_key(arm)),
            _ => false,
        }
    }

    fn reflected_record(&self, ty: &Type) -> bool {
        match ty {
            Type::Dyn
            | Type::Promise { .. }
            | Type::Func { .. }
            | Type::String
            | Type::F64
            | Type::Bigint
            | Type::Bool
            | Type::Symbol
            | Type::Array { .. }
            | Type::Bytes { .. }
            | Type::Object { .. } => true,
            Type::Record { shape_id } => {
                let shape = &self.records[*shape_id];
                !shape.tuple
                    && !self.enum_shape(*shape_id)
                    && !self.callables.contains_key(shape_id)
            }
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.reflected_record(arm)),
            _ => false,
        }
    }
}
