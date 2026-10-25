//! Class identities, definition-time effects and demand-driven constructor bodies.
use super::*;
use source_frontend::prelude::{SignatureKind, SymbolId, get_source_file_of_node};
use std::collections::VecDeque;

#[derive(Clone)]
struct Definition {
    node: Node,
    name: String,
    file: String,
    base: Option<usize>,
    resolved: bool,
    resolving: bool,
    signature: Option<Vec<Param>>,
    token: Option<Local>,
}

#[derive(Clone, Default)]
pub(super) struct ClassGraph {
    definitions: Vec<Definition>,
    symbols: HashMap<u32, usize>,
    pub layouts: Vec<Option<ir::Class>>,
    pending: VecDeque<usize>,
    layout_active: HashSet<usize>,
    methods: HashMap<(usize, String), Signature>,
    symbol_nodes: HashMap<(usize, ir::SymbolMethodKey), Node>,
    symbol_signatures: HashMap<(usize, ir::SymbolMethodKey), Signature>,
    accessors: HashMap<(usize, String, bool), Signature>,
    private_slots: HashMap<u32, private_slots::Slot>,
    private_method_signatures: HashMap<String, Signature>,
    method_queue: VecDeque<Signature>,
    boxed_slots: Vec<(String, ir::Global)>,
}

impl ClassGraph {
    pub fn next(&mut self) -> Option<usize> {
        self.pending.pop_front()
    }
    pub fn subclass(&self, child: &str, parent: &str) -> bool {
        let mut index = self.definitions.iter().position(|d| d.name == child);
        for _ in 0..=self.definitions.len() {
            let Some(i) = index else { return false };
            if self.definitions[i].name == parent {
                return true;
            }
            index = self.definitions[i].base;
        }
        false
    }
    fn object(&self, index: usize) -> Type {
        Type::Object {
            class_name: self.definitions[index].name.clone(),
        }
    }
    pub fn hierarchy(&self, name: &str) -> bool {
        self.definitions.iter().any(|d| {
            (d.name == name && d.base.is_some())
                || d.base
                    .is_some_and(|base| self.definitions[base].name == name)
        })
    }
}

impl Lowerer<'_> {
    pub(super) fn inventory_classes(&mut self, files: &[Node]) {
        for file in files {
            let mut definitions = Vec::new();
            for statement in file.statements() {
                if statement.kind() == SyntaxKind::ClassDeclaration && !statement.name().is_nil() {
                    definitions.push((statement, statement.name()));
                } else if statement.kind() == SyntaxKind::VariableStatement {
                    for declaration in statement.declaration_list().declarations().nodes() {
                        let expression = declaration.initializer();
                        if !expression.is_nil()
                            && expression.kind() == SyntaxKind::ClassExpression
                            && declaration.name().kind() == SyntaxKind::Identifier
                        {
                            definitions.push((expression, declaration.name()));
                        }
                    }
                }
            }
            for (node, binding) in definitions {
                let symbol = self.symbol(binding);
                let index = self.classes.definitions.len();
                let token = Local {
                    id: format!("%g.class.{index}"),
                    name: binding.text().into(),
                    r#type: Type::F64,
                    mutable: false,
                    boxed: false,
                };
                let token = (node.kind() == SyntaxKind::ClassDeclaration).then_some(token);
                if let Some(token) = &token {
                    self.globals.push(ir::Global {
                        id: token.id.clone(),
                        name: token.name.clone(),
                        r#type: Type::F64,
                        mutable: false,
                    });
                }
                self.classes.symbols.insert(symbol, index);
                let ty = self.checker.get_type_at_location(node);
                let class_symbol = self.checker.ty(ty).symbol().0;
                if class_symbol != 0 {
                    self.classes.symbols.insert(class_symbol, index);
                }
                if !node.name().is_nil() {
                    let inner = self.symbol(node.name());
                    if inner != 0 {
                        self.classes.symbols.insert(inner, index);
                    }
                }
                self.classes.definitions.push(Definition {
                    node,
                    name: format!("native_class_{index}"),
                    file: source_file_info(*file).file_name.to_string(),
                    base: None,
                    resolved: false,
                    resolving: false,
                    signature: None,
                    token,
                });
                self.classes.layouts.push(None);
            }
        }
    }

    pub(super) fn ensure_exception_classes(&mut self, site: Node) -> Result<(), String> {
        // Use the bundled declaration directly: a lexical class named Error
        // must not replace the runtime error hierarchy at the catch boundary.
        for file in program::source_files() {
            if !source_file_info(file).file_name.ends_with("/lib.es5.d.ts") {
                continue;
            }
            for statement in file.statements() {
                if statement.kind() != SyntaxKind::VariableStatement {
                    continue;
                }
                for declaration in statement.declaration_list().declarations().nodes() {
                    if declaration.name().kind() == SyntaxKind::Identifier
                        && declaration.name().text() == "Error"
                    {
                        let symbol = self
                            .checker
                            .get_symbol_at_location(declaration.name(), false);
                        if self.builtin_class(symbol.0).is_some() {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Err(self.refuse(site, "catch payloads require native Error declarations"))
    }

    fn builtin_class(&mut self, symbol: u32) -> Option<usize> {
        if let Some(index) = self.classes.symbols.get(&symbol) {
            return Some(*index);
        }
        if symbol == 0 {
            return None;
        }
        let info = self.checker.sym(SymbolId(symbol));
        let name = info.name.to_string();
        if self.standard_weak_set(symbol) {
            let index = self.weak_set_class(info.value_declaration);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if matches!(name.as_str(), "Number" | "String" | "Boolean")
            && self.primitive_symbol(symbol, &name, None)
        {
            let site = self.checker.sym(SymbolId(symbol)).value_declaration;
            let index = self.boxed_class(&name);
            self.private_table_constructor(site)
                .expect("internal boxed storage constructor");
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if self.standard_async_context(symbol) || self.standard_weak_map(symbol) {
            let weak = self.standard_weak_map(symbol);
            let class_name = if weak {
                weak_maps::CLASS
            } else {
                async_context::CLASS
            };
            let index = self
                .classes
                .definitions
                .iter()
                .position(|d| d.name == class_name)
                .unwrap_or_else(|| {
                    let index = self.classes.definitions.len();
                    self.classes.definitions.push(Definition {
                        node: Node::NIL,
                        name: class_name.into(),
                        file: "<builtin>".into(),
                        base: None,
                        resolved: true,
                        resolving: false,
                        signature: None,
                        token: None,
                    });
                    self.classes.layouts.push(Some(ir::Class {
                        name: class_name.into(),
                        js_name: if weak { "WeakMap" } else { "AsyncLocalStorage" }.into(),
                        runtime: false,
                        base: None,
                        fields: if weak {
                            vec![]
                        } else {
                            vec![ir::Field {
                                name: async_context::HANDLE.into(),
                                r#type: Type::Dyn,
                            }]
                        },
                        methods: vec![],
                        symbol_methods: vec![],
                        method_names: if weak {
                            vec!["get".into(), "set".into(), "has".into(), "delete".into()]
                        } else {
                            vec!["run".into(), "getStore".into()]
                        },
                        loc: Loc {
                            file: "<builtin>".into(),
                            start: 0,
                            end: 0,
                        },
                    }));
                    index
                });
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if matches!(name.as_str(), "TextEncoder" | "TextDecoder")
            && self.standard_codec_symbol(symbol).is_some()
        {
            let ir_name = format!("native_builtin_{name}");
            let index = self
                .classes
                .definitions
                .iter()
                .position(|d| d.name == ir_name)
                .unwrap_or_else(|| {
                    let index = self.classes.definitions.len();
                    self.classes.definitions.push(Definition {
                        node: Node::NIL,
                        name: ir_name.clone(),
                        file: "<builtin>".into(),
                        base: None,
                        resolved: true,
                        resolving: false,
                        signature: None,
                        token: None,
                    });
                    self.classes.layouts.push(Some(ir::Class {
                        name: ir_name,
                        js_name: name.clone(),
                        runtime: false,
                        base: None,
                        fields: vec![],
                        methods: vec![],
                        symbol_methods: vec![],
                        method_names: if name == "TextEncoder" {
                            vec!["encode".into(), "encodeInto".into()]
                        } else {
                            vec!["decode".into()]
                        },
                        loc: Loc {
                            file: "<builtin>".into(),
                            start: 0,
                            end: 0,
                        },
                    }));
                    index
                });
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if !matches!(
            name.as_str(),
            "Error" | "TypeError" | "RangeError" | "SyntaxError"
        ) || !info.declarations.iter().any(|n| {
            !n.is_nil()
                && source_file_info(get_source_file_of_node(*n))
                    .file_name
                    .ends_with("/lib.es5.d.ts")
        }) {
            return None;
        }
        // Install the complete builtin prefix once. Source recognition still
        // requires declaration identity; a user-defined Error is never ambient.
        for builtin in ["Error", "TypeError", "RangeError", "SyntaxError"] {
            let ir_name = format!("%{builtin}");
            if self.classes.definitions.iter().any(|d| d.name == ir_name) {
                continue;
            }
            let base = if builtin == "Error" {
                None
            } else {
                self.classes
                    .definitions
                    .iter()
                    .position(|d| d.name == "%Error")
            };
            self.classes.definitions.push(Definition {
                node: Node::NIL,
                name: ir_name.clone(),
                file: "<builtin>".into(),
                base,
                resolved: true,
                resolving: false,
                signature: None,
                token: None,
            });
            self.classes.layouts.push(Some(ir::Class {
                name: ir_name,
                js_name: builtin.into(),
                runtime: true,
                base: base.map(|i| self.classes.definitions[i].name.clone()),
                fields: ir::error_fields(),
                methods: vec![],
                symbol_methods: vec![],
                method_names: vec![],
                loc: Loc {
                    file: "<builtin>".into(),
                    start: 0,
                    end: 0,
                },
            }));
        }
        let index = self
            .classes
            .definitions
            .iter()
            .position(|d| d.name == format!("%{name}"))?;
        self.classes.symbols.insert(symbol, index);
        Some(index)
    }

    fn class_symbol(&mut self, node: Node) -> Option<usize> {
        let identity = if node.kind() == SyntaxKind::PropertyAccessExpression
            && self.module_namespace(node.expression())
        {
            node.name()
        } else {
            node
        };
        let symbol = self.symbol(identity);
        if let Some(index) = self.builtin_class(symbol) {
            return Some(index);
        }
        let ty = self.checker.get_type_at_location(node);
        let symbol = self.checker.ty(ty).symbol().0;
        self.builtin_class(symbol)
    }

    fn resolve_class(&mut self, index: usize) -> Result<(), String> {
        let file = std::mem::replace(&mut self.file, self.classes.definitions[index].file.clone());
        let result = self.resolve_class_inner(index);
        self.file = file;
        self.classes.definitions[index].resolving = false;
        result
    }

    fn resolve_class_inner(&mut self, index: usize) -> Result<(), String> {
        let definition = self.classes.definitions[index].clone();
        if definition.resolved {
            return Ok(());
        }
        if definition.resolving {
            return Err(self.refuse(definition.node, "cyclic class inheritance is not ported"));
        }
        self.classes.definitions[index].resolving = true;
        let node = definition.node;
        if !node.type_parameters().is_empty()
            || node
                .modifier_flags()
                .intersects(ModifierFlags::ABSTRACT | ModifierFlags::AMBIENT)
            || node
                .modifiers()
                .nodes()
                .into_iter()
                .any(|m| m.kind() == SyntaxKind::Decorator)
        {
            return Err(self.refuse(
                node,
                "only concrete non-generic undecorated classes are ported",
            ));
        }
        let mut base = None;
        for clause in node.heritage_clauses().nodes() {
            if clause.token() != SyntaxKind::ExtendsKeyword {
                continue;
            }
            let types = clause.types().nodes().into_iter().collect::<Vec<_>>();
            if types.len() != 1 {
                return Err(self.refuse(node, "one class base is required"));
            }
            let expression = types[0].expression();
            if expression.kind() != SyntaxKind::Identifier
                && !(expression.kind() == SyntaxKind::PropertyAccessExpression
                    && self.module_namespace(expression.expression()))
            {
                return Err(self.refuse(expression, "effectful class heritage is not ported"));
            }
            base =
                Some(self.class_symbol(expression).ok_or_else(|| {
                    self.refuse(expression, "class heritage has no native identity")
                })?);
        }
        if let Some(base) = base {
            if boxed::kind(&self.classes.definitions[base].name).is_some() {
                return Err(self.refuse(node, "boxed primitive subclassing is not ported"));
            }
            if self.classes.definitions[base].name == weak_maps::CLASS {
                return Err(self.refuse(node, "WeakMap subclassing is not ported"));
            }
            if self.classes.definitions[base].name == weak_sets::CLASS {
                return Err(self.refuse(node, "WeakSet subclassing is not ported"));
            }
            if self.classes.definitions[base].name == async_context::CLASS {
                return Err(self.refuse(node, "AsyncLocalStorage subclassing is not ported"));
            }
            if self.classes.definitions[base]
                .name
                .starts_with("native_builtin_Text")
            {
                return Err(self.refuse(node, "text codec subclassing is not ported"));
            }
            self.resolve_class(base)?;
        }
        for member in node.members() {
            let symbol_method = if member.kind() == SyntaxKind::MethodDeclaration
                && member.name().kind() == SyntaxKind::ComputedPropertyName
            {
                self.class_symbol_key(member.name().expression())
            } else {
                None
            };
            if member.modifier_flags().intersects(ModifierFlags::STATIC)
                || member
                    .modifiers()
                    .nodes()
                    .into_iter()
                    .any(|m| m.kind() == SyntaxKind::Decorator)
                || (member.kind() != SyntaxKind::Constructor
                    && (!matches!(
                        member.kind(),
                        SyntaxKind::PropertyDeclaration
                            | SyntaxKind::MethodDeclaration
                            | SyntaxKind::GetAccessor
                            | SyntaxKind::SetAccessor
                    ) || !matches!(
                        member.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    ) && !(matches!(
                        member.kind(),
                        SyntaxKind::PropertyDeclaration | SyntaxKind::MethodDeclaration
                    ) && member.name().kind() == SyntaxKind::PrivateIdentifier)
                        && symbol_method.is_none()))
            {
                return Err(self.refuse(
                    member,
                    "class static/computed members, private accessors and decorators are not ported",
                ));
            }
            if let Some(key) = symbol_method {
                self.classes.symbol_nodes.insert((index, key), member);
            }
        }
        self.classes.definitions[index].base = base;
        self.inventory_private_slots(index)?;
        for member in node.members().into_iter().filter(|m| {
            matches!(
                m.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
            ) && !matches!(
                m.name().kind(),
                SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
            )
        }) {
            let name = member.name().text();
            if name.starts_with('%')
                || name.contains(':')
                || name == "constructor"
                || (matches!(name, "toString" | "valueOf")
                    && self.classes.subclass(&definition.name, "%Error"))
            {
                return Err(self.refuse(
                    member,
                    "reserved methods and Error coercion overrides are not ported",
                ));
            }
        }
        // The initial descriptor model separates prototype accessors from data
        // slots and methods. Do not silently merge incompatible declarations.
        for member in node.members().into_iter().filter(|m| {
            matches!(
                m.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::PropertyDeclaration
            ) && !matches!(
                m.name().kind(),
                SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
            )
        }) {
            if let Some(base) = base
                && self.classes.accessor(base, member.name().text()).is_some()
            {
                return Err(self.refuse(
                    member,
                    "accessor/data or accessor/method shadowing is not ported",
                ));
            }
        }
        for member in node
            .members()
            .into_iter()
            .filter(|m| matches!(m.kind(), SyntaxKind::GetAccessor | SyntaxKind::SetAccessor))
        {
            let name = member.name().text();
            let mut owner = Some(index);
            while let Some(current) = owner {
                if self.classes.definitions[current].node.is_nil() {
                    break;
                }
                if self.classes.definitions[current]
                    .node
                    .members()
                    .into_iter()
                    .any(|m| {
                        matches!(
                            m.kind(),
                            SyntaxKind::MethodDeclaration | SyntaxKind::PropertyDeclaration
                        ) && !matches!(
                            m.name().kind(),
                            SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
                        ) && m.name().text() == name
                    })
                {
                    return Err(self.refuse(
                        member,
                        "accessor/data or accessor/method shadowing is not ported",
                    ));
                }
                owner = self.classes.definitions[current].base;
            }
        }
        self.classes.definitions[index].resolved = true;
        self.classes.definitions[index].resolving = false;
        Ok(())
    }

    pub(super) fn class_declaration(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        if self.return_type.is_some() || node.parent().kind() != SyntaxKind::SourceFile {
            return Err(self.refuse(node, "local class declarations are not ported"));
        }
        let index = self
            .class_symbol(node.name())
            .ok_or_else(|| self.refuse(node, "class has no native identity"))?;
        self.resolve_class(index)?;
        let mut body = Vec::new();
        if let Some(value) = self.class_heritage_value(node)? {
            body.push(Stmt::Expression {
                expr: value,
                loc: self.loc(node),
            });
        }
        body.extend(self.initialize_private_storage(index, node)?);
        let token = self.classes.definitions[index].token.as_ref().unwrap();
        body.push(Stmt::Assign {
            local_id: token.id.clone(),
            initializes_global: true,
            value: Expr::NumLit {
                value: 1.0,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        });
        Ok(body)
    }

    fn layout_class(&mut self, index: usize) -> Result<(), String> {
        if self.classes.layouts[index].is_some() {
            return Ok(());
        }
        self.classes.layout_active.insert(index);
        let saved_file =
            std::mem::replace(&mut self.file, self.classes.definitions[index].file.clone());
        let result = self.layout_class_inner(index);
        self.file = saved_file;
        self.classes.layout_active.remove(&index);
        if result.is_err() {
            self.classes.layouts[index] = None;
        }
        result
    }

    fn layout_class_inner(&mut self, index: usize) -> Result<(), String> {
        self.resolve_class(index)?;
        let definition = self.classes.definitions[index].clone();
        if let Some(base) = definition.base {
            self.layout_class(base)?;
        }
        let error = self.classes.subclass(&definition.name, "%Error");
        let mut layout = ir::Class {
            name: definition.name,
            js_name: if definition.node.name().is_nil() {
                definition.node.parent().name().text().into()
            } else {
                definition.node.name().text().into()
            },
            runtime: false,
            base: definition
                .base
                .map(|base| self.classes.definitions[base].name.clone()),
            methods: vec![],
            symbol_methods: vec![],
            method_names: vec![],
            fields: definition
                .base
                .map(|base| self.classes.layouts[base].as_ref().unwrap().fields.clone())
                .unwrap_or_default(),
            loc: Loc {
                file: definition.file,
                start: definition.node.pos().max(0),
                end: definition.node.end(),
            },
        };
        let mut sources = definition
            .node
            .members()
            .into_iter()
            .filter(|n| {
                n.kind() == SyntaxKind::PropertyDeclaration
                    && n.name().kind() != SyntaxKind::PrivateIdentifier
            })
            .map(|n| (n.name().text().to_string(), n))
            .collect::<Vec<_>>();
        // JavaScript fields are introduced by constructor assignments, not by
        // TS PropertyDeclaration nodes. Allocate slots without moving writes.
        fn assigned(node: Node, fields: &mut Vec<(String, Node)>) {
            if matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::ClassExpression
            ) {
                return;
            }
            if node.kind() == SyntaxKind::BinaryExpression
                && node.operator_token().kind() == SyntaxKind::EqualsToken
            {
                let left = node.left();
                if left.kind() == SyntaxKind::PropertyAccessExpression
                    && left.expression().kind() == SyntaxKind::ThisKeyword
                    && left.name().kind() != SyntaxKind::PrivateIdentifier
                {
                    let name = left.name().text().to_string();
                    if !fields.iter().any(|(n, _)| *n == name) {
                        fields.push((name, left));
                    }
                }
            }
            node.for_each_child(&mut |child| {
                assigned(child, fields);
                false
            });
        }
        for ctor in definition
            .node
            .members()
            .into_iter()
            .filter(|n| n.kind() == SyntaxKind::Constructor)
        {
            assigned(ctor.body(), &mut sources);
        }
        let contract = self.class_contract(definition.node).cloned();
        sources.retain(|(name, node)| {
            node.kind() == SyntaxKind::PropertyDeclaration
                || self.classes.accessor(index, name).is_none()
        });
        for (name, field) in sources {
            if name.starts_with('%') || name == "__proto__" {
                return Err(self.refuse(field, "reserved class field names are not ported"));
            }
            let ty = if error && matches!(name.as_str(), "name" | "message") {
                Type::String
            } else if let Some((_, ty)) = contract
                .as_ref()
                .and_then(|c| c.fields.iter().find(|(n, _)| *n == name))
            {
                ty.clone().ok_or_else(|| {
                    self.refuse(field, "public class field has no native representation")
                })?
            } else {
                self.ty(field.name())?
            };
            let ty = if error && matches!(name.as_str(), "name" | "message") {
                ty
            } else {
                if matches!(
                    ty,
                    Type::Func { .. } | Type::Void | Type::Undefined | Type::Null
                ) {
                    return Err(self.refuse(field, "class field type is not ported"));
                }
                let mut arms = if let Type::Union { union_id } = ty {
                    self.unions[union_id].arms.clone()
                } else {
                    vec![ty]
                };
                arms.push(Type::Undefined);
                self.intern_union(arms).ok_or_else(|| {
                    self.refuse(field, "class field has no undefined representation")
                })?
            };
            if let Some(inherited) = layout.fields.iter().find(|f| f.name == name) {
                if inherited.r#type != ty
                    || (error
                        && matches!(name.as_str(), "name" | "message")
                        && field.kind() == SyntaxKind::PropertyDeclaration
                        && field.initializer().is_nil()
                        && !field.modifier_flags().intersects(ModifierFlags::AMBIENT))
                {
                    return Err(self.refuse(
                        field,
                        "field override layout/undefined initialization is not ported",
                    ));
                }
            } else {
                layout.fields.push(ir::Field { name, r#type: ty });
            }
        }
        layout.method_names = definition
            .node
            .members()
            .into_iter()
            .filter(|member| {
                matches!(
                    member.kind(),
                    SyntaxKind::MethodDeclaration
                        | SyntaxKind::GetAccessor
                        | SyntaxKind::SetAccessor
                ) && !matches!(
                    member.name().kind(),
                    SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
                )
            })
            .map(|member| member.name().text().to_string())
            .collect();
        let mut seen = HashSet::new();
        layout.method_names.retain(|name| seen.insert(name.clone()));
        for member in definition.node.members() {
            if member.kind() == SyntaxKind::MethodDeclaration
                && member.name().kind() == SyntaxKind::ComputedPropertyName
            {
                let key = self.class_symbol_key(member.name().expression()).unwrap();
                // Repeated definitions replace the descriptor without changing its key.
                if !layout.symbol_methods.iter().any(|method| method.key == key) {
                    layout.symbol_methods.push(ir::SymbolMethod {
                        key,
                        function: None,
                    });
                }
            }
        }
        if let Some(field) = layout.fields.iter().find(|field| {
            self.classes.method(index, &field.name).is_some()
                || self.classes.accessor(index, &field.name).is_some()
        }) {
            return Err(self.refuse(
                definition.node,
                &format!(
                    "instance field '{}' shadows a prototype property; descriptor shadowing is not ported",
                    field.name
                ),
            ));
        }
        self.classes.layouts[index] = Some(layout);
        Ok(())
    }

    pub(super) fn class_type(&mut self, id: TypeId) -> Option<Type> {
        let constructor = !self
            .checker
            .get_signatures_of_type(id, SignatureKind::CONSTRUCT)
            .is_empty();
        let symbol = self.checker.ty(id).symbol().0;
        let index = self.builtin_class(symbol)?;
        if constructor {
            if self.classes.definitions[index].node.is_nil() {
                return None;
            }
            if !self.classes.layout_active.contains(&index) {
                self.layout_class(index).ok()?;
            }
            return Some(Type::Classval {
                class_name: self.classes.definitions[index].name.clone(),
            });
        }
        if self.classes.layout_active.contains(&index) {
            return Some(self.classes.object(index));
        }
        self.layout_class(index).ok()?;
        Some(self.classes.object(index))
    }
}

mod accessors;
mod boxed;
mod constructors;
mod methods;
mod private_slots;
mod symbol_methods;
mod values;
pub(super) mod weak_sets;
