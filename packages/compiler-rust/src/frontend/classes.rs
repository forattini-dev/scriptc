//! Class identities, definition-time effects and demand-driven constructor bodies.
use super::*;
use source_frontend::prelude::{SignatureKind, SymbolId, get_source_file_of_node};
use std::collections::VecDeque;

pub(super) fn parameter_property(node: Node) -> bool {
    node.modifier_flags().intersects(
        ModifierFlags::PUBLIC
            | ModifierFlags::PRIVATE
            | ModifierFlags::PROTECTED
            | ModifierFlags::READONLY,
    )
}

fn direct_static_super(node: Node) -> bool {
    node.kind() == SyntaxKind::PropertyAccessExpression
        && node.expression().kind() == SyntaxKind::SuperKeyword
}

fn static_super_initializer(node: Node) -> bool {
    if direct_static_super(node) {
        return true;
    }
    if node.kind() != SyntaxKind::BinaryExpression
        || !matches!(
            node.operator_token().kind(),
            SyntaxKind::PlusToken
                | SyntaxKind::MinusToken
                | SyntaxKind::AsteriskToken
                | SyntaxKind::SlashToken
                | SyntaxKind::PercentToken
                | SyntaxKind::AsteriskAsteriskToken
                | SyntaxKind::AmpersandToken
                | SyntaxKind::BarToken
                | SyntaxKind::CaretToken
                | SyntaxKind::LessThanLessThanToken
                | SyntaxKind::GreaterThanGreaterThanToken
                | SyntaxKind::GreaterThanGreaterThanGreaterThanToken
                | SyntaxKind::LessThanToken
                | SyntaxKind::LessThanEqualsToken
                | SyntaxKind::GreaterThanToken
                | SyntaxKind::GreaterThanEqualsToken
                | SyntaxKind::EqualsEqualsEqualsToken
                | SyntaxKind::ExclamationEqualsEqualsToken
                | SyntaxKind::EqualsEqualsToken
                | SyntaxKind::ExclamationEqualsToken
                | SyntaxKind::AmpersandAmpersandToken
                | SyntaxKind::BarBarToken
                | SyntaxKind::QuestionQuestionToken
        )
    {
        return false;
    }
    [node.left(), node.right()]
        .iter()
        .all(|operand| direct_static_super(*operand) || !static_methods::reads_super(*operand))
}

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
    captures: Vec<(u32, Node, Type)>,
}

#[derive(Clone, Default)]
pub(super) struct ClassGraph {
    definitions: Vec<Definition>,
    symbols: HashMap<u32, usize>,
    pub layouts: Vec<Option<ir::Class>>,
    pending: VecDeque<usize>,
    layout_active: HashSet<usize>,
    layout_deferred: VecDeque<usize>,
    methods: HashMap<(usize, String), Signature>,
    borrowed_methods: HashMap<(usize, String, String), Signature>,
    static_methods: HashMap<(usize, usize, String), Signature>,
    static_extracted_methods: HashMap<(usize, usize, String), Signature>,
    static_accessors: HashMap<(usize, usize, String), Signature>,
    symbol_nodes: HashMap<(usize, ir::SymbolMethodKey), Node>,
    symbol_signatures: HashMap<(usize, ir::SymbolMethodKey), Signature>,
    accessors: HashMap<(usize, String, bool), Signature>,
    private_slots: HashMap<u32, private_slots::Slot>,
    private_method_signatures: HashMap<String, Signature>,
    prototype_fields: HashMap<(usize, String), Node>,
    method_queue: VecDeque<Signature>,
    deferred_erased_methods: Vec<(Node, String)>,
    dynamic_extracted_names: HashSet<String>,
    deferred_interface_methods: Vec<(TypeId, Vec<String>)>,
    boxed_slots: Vec<(String, ir::Global)>,
}

impl ClassGraph {
    pub(in crate::frontend) fn note_dynamic_method_extraction(&mut self, name: &str) {
        self.dynamic_extracted_names.insert(name.to_owned());
    }

    pub(in crate::frontend) fn missing_dynamic_method_specializations(
        &self,
    ) -> Vec<(usize, String, Node)> {
        let mut pending = self
            .methods
            .iter()
            .filter(|((owner, name), _)| {
                self.dynamic_extracted_names.contains(name)
                    && !self.borrowed_methods.contains_key(&(
                        *owner,
                        name.clone(),
                        "\0dynamic".into(),
                    ))
            })
            .filter_map(|((owner, name), _)| {
                self.method(*owner, name)
                    .map(|(owner, node)| (owner, name.clone(), node))
            })
            .collect::<Vec<_>>();
        pending.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
        pending
    }
    pub(in crate::frontend) fn register_symbol(&mut self, symbol: u32, class: usize) {
        self.symbols.insert(symbol, class);
    }

    /// The nearest declaration of getter `name` for class `class_name`
    /// (walking its base classes), with the owning class index.
    pub(in crate::frontend) fn getter_candidate(
        &self,
        class_name: &str,
        name: &str,
    ) -> Option<(usize, Node)> {
        let mut index = self.definitions.iter().position(|d| d.name == class_name)?;
        loop {
            let class = self.definitions[index].node;
            if !class.is_nil()
                && let Some(getter) = class.members().into_iter().find(|member| {
                    member.kind() == SyntaxKind::GetAccessor
                        && !member.modifier_flags().intersects(ModifierFlags::STATIC)
                        && member.name().text() == name
                })
            {
                return Some((index, getter));
            }
            index = self.definitions[index].base?;
        }
    }

    /// Whether the class bound to `symbol` declares a get/set accessor `name`.
    pub(in crate::frontend) fn declares_accessor(&self, symbol: u32, name: &str) -> bool {
        self.symbols.get(&symbol).copied().is_some_and(|index| {
            let class = self.definitions[index].node;
            !class.is_nil()
                && class.members().into_iter().any(|member| {
                    matches!(member.kind(), SyntaxKind::GetAccessor | SyntaxKind::SetAccessor)
                        && member.name().text() == name
                })
        })
    }

    pub(in crate::frontend) fn has_identity(&self, symbol: u32) -> bool {
        self.symbols.contains_key(&symbol)
    }

    pub(in crate::frontend) fn nominal_identity_type(
        &mut self,
        symbol: u32,
        constructor: bool,
    ) -> Option<Type> {
        let index = *self.symbols.get(&symbol)?;
        if self.layouts[index].is_none()
            && !self.layout_active.contains(&index)
            && !self.layout_deferred.contains(&index)
        {
            self.layout_deferred.push_back(index);
        }
        let class_name = self.definitions[index].name.clone();
        Some(if constructor {
            Type::Classval { class_name }
        } else {
            Type::Object { class_name }
        })
    }

    pub(in crate::frontend) fn defer_interface_methods(
        &mut self,
        interface: TypeId,
        names: Vec<String>,
    ) {
        if !self
            .deferred_interface_methods
            .iter()
            .any(|(existing, _)| *existing == interface)
        {
            self.deferred_interface_methods.push((interface, names));
        }
    }

    pub(in crate::frontend) fn take_deferred_interface_methods(
        &mut self,
    ) -> Vec<(TypeId, Vec<String>)> {
        std::mem::take(&mut self.deferred_interface_methods)
    }

    pub(in crate::frontend) fn source_class_candidates(&self) -> Vec<(usize, Node)> {
        self.definitions
            .iter()
            .enumerate()
            .filter(|(_, definition)| !definition.node.is_nil())
            .map(|(index, definition)| (index, definition.node))
            .collect()
    }

    pub(in crate::frontend) fn method_candidate(
        &self,
        class: usize,
        name: &str,
    ) -> Option<(usize, Node)> {
        self.method(class, name)
    }

    pub(in crate::frontend) fn dynamic_method_candidates_for_type(
        &self,
        source: &Type,
        name: &str,
        unions: &[ir::Union],
    ) -> Vec<Node> {
        let arms = match source {
            Type::Union { union_id } => unions[*union_id].arms.clone(),
            other => vec![other.clone()],
        };
        let mut demanded = Vec::new();
        for arm in arms {
            let Type::Object { class_name } = arm else {
                continue;
            };
            for index in 0..self.definitions.len() {
                if self.subclass(&self.definitions[index].name, &class_name)
                    && let Some((_, method)) = self.method_candidate(index, name)
                    && !demanded.contains(&method)
                {
                    demanded.push(method);
                }
            }
        }
        demanded
    }

    pub(in crate::frontend) fn defer_dynamic_method_for_type(
        &mut self,
        source: &Type,
        name: &str,
        unions: &[ir::Union],
    ) {
        for method in self.dynamic_method_candidates_for_type(source, name, unions) {
            self.defer_erased_method(method, name.to_owned());
        }
    }

    pub(in crate::frontend) fn defer_erased_method(&mut self, node: Node, name: String) {
        if !self
            .deferred_erased_methods
            .iter()
            .any(|(existing, method)| *existing == node && *method == name)
        {
            self.deferred_erased_methods.push((node, name));
        }
    }

    pub(in crate::frontend) fn take_deferred_erased_methods(&mut self) -> Vec<(Node, String)> {
        std::mem::take(&mut self.deferred_erased_methods)
    }

    pub(in crate::frontend) fn definition_index_for_node(&self, node: Node) -> Option<usize> {
        self.definitions
            .iter()
            .position(|definition| definition.node == node)
    }

    pub(in crate::frontend) fn definition_index_for_name(&self, name: &str) -> Option<usize> {
        self.definitions
            .iter()
            .position(|definition| definition.name == name)
    }

    pub(in crate::frontend) fn definition_name_at(
        &self,
        index: usize,
        node: Node,
    ) -> Option<String> {
        self.definitions
            .get(index)
            .filter(|definition| definition.node == node)
            .map(|definition| definition.name.clone())
    }

    pub(in crate::frontend) fn guaranteed_string_presence(
        &self,
        class_name: &str,
        key: &str,
    ) -> bool {
        if matches!(
            key,
            "constructor"
                | "__defineGetter__"
                | "__defineSetter__"
                | "hasOwnProperty"
                | "__lookupGetter__"
                | "__lookupSetter__"
                | "isPrototypeOf"
                | "propertyIsEnumerable"
                | "toString"
                | "valueOf"
                | "__proto__"
                | "toLocaleString"
        ) {
            return true;
        }
        let mut current = self
            .definitions
            .iter()
            .position(|definition| definition.name == class_name);
        for _ in 0..=self.definitions.len() {
            let Some(index) = current else { return false };
            let definition = &self.definitions[index];
            if !definition.node.is_nil() {
                for member in definition.node.members() {
                    if matches!(
                        member.kind(),
                        SyntaxKind::MethodDeclaration
                            | SyntaxKind::GetAccessor
                            | SyntaxKind::SetAccessor
                            | SyntaxKind::PropertyDeclaration
                    ) && !matches!(
                        member.name().kind(),
                        SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
                    ) && member.name().text() == key
                    {
                        return true;
                    }
                    if member.kind() != SyntaxKind::Constructor {
                        continue;
                    }
                    if member.parameters().iter().any(|parameter| {
                        parameter_property(parameter)
                            && parameter.name().kind() == SyntaxKind::Identifier
                            && parameter.name().text() == key
                    }) {
                        return true;
                    }
                    if member.body().statements().iter().any(|statement| {
                        if statement.kind() != SyntaxKind::ExpressionStatement {
                            return false;
                        }
                        let expression = statement.expression();
                        if expression.kind() != SyntaxKind::BinaryExpression
                            || expression.operator_token().kind() != SyntaxKind::EqualsToken
                        {
                            return false;
                        }
                        let target = expression.left();
                        target.kind() == SyntaxKind::PropertyAccessExpression
                            && target.expression().kind() == SyntaxKind::ThisKeyword
                            && target.name().text() == key
                    }) {
                        return true;
                    }
                }
            }
            current = definition.base;
        }
        false
    }

    pub(in crate::frontend) fn lexical_method_captures(
        &self,
        method: Node,
    ) -> Option<(String, Vec<(u32, Node, Type)>)> {
        self.definitions
            .iter()
            .find(|definition| definition.node == method.parent())
            .map(|definition| (definition.name.clone(), definition.captures.clone()))
    }

    pub(in crate::frontend) fn mutable_capture_descriptor(
        &self,
        receiver_class: &str,
        symbol: u32,
    ) -> Option<(usize, String, Type)> {
        let mut owner = self
            .definitions
            .iter()
            .position(|definition| definition.name == receiver_class);
        for _ in 0..=self.definitions.len() {
            let index = owner?;
            let definition = &self.definitions[index];
            if let Some(capture) = definition
                .captures
                .iter()
                .position(|(captured, _, _)| *captured == symbol)
            {
                return Some((
                    capture,
                    definition.name.clone(),
                    definition.captures[capture].2.clone(),
                ));
            }
            owner = definition.base;
        }
        None
    }

    pub(super) fn describe(&self, name: &str) -> String {
        let Some(definition) = self
            .definitions
            .iter()
            .find(|definition| definition.name == name)
        else {
            return name.into();
        };
        let source_name = if definition.node.is_nil() || definition.node.name().is_nil() {
            "<anonymous>"
        } else {
            definition.node.name().text()
        };
        format!("{} ({source_name} in {})", definition.name, definition.file)
    }

    pub(super) fn has_static_methods(&self, name: &str) -> bool {
        let mut current = self
            .definitions
            .iter()
            .position(|definition| definition.name == name);
        for _ in 0..=self.definitions.len() {
            let Some(index) = current else { return false };
            let definition = &self.definitions[index];
            if !definition.node.is_nil()
                && definition.node.members().into_iter().any(|member| {
                    member.kind() == SyntaxKind::MethodDeclaration
                        && member.modifier_flags().intersects(ModifierFlags::STATIC)
                })
            {
                return true;
            }
            current = definition.base;
        }
        false
    }

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
    pub(super) fn class_inventory_ready(&self) -> bool {
        self.classes
            .definitions
            .iter()
            .any(|definition| !definition.node.is_nil())
    }

    /// Class layout can ask for a callback slot while the callback's parameter
    /// names the class currently being laid out. Going through the aggregate
    /// type graph treats that cycle as a recursive structural record, even
    /// though the value is only a function whose parameter carries the already
    /// reserved nominal class identity. Resolve the callable ABI directly.
    pub(super) fn class_callback_type(&mut self, node: Node) -> Option<Type> {
        let id = self.checker.get_type_at_location(node);
        (!self
            .checker
            .get_signatures_of_type(id, SignatureKind::CALL)
            .is_empty())
        .then(|| self.function_type(id))
        .flatten()
    }

    pub(super) fn finalize_class_layouts(&mut self) -> Result<(), String> {
        for index in 0..self.classes.definitions.len() {
            let Some(base) = self.classes.definitions[index].base else {
                continue;
            };
            if self.classes.layouts[index].is_none() {
                continue;
            }
            // A derived layout can become reachable before late runtime type
            // linking resolves its base edge. Materialize that base chain now
            // so final prefix reconstruction is independent of discovery order.
            self.layout_class(base)?;
            let inherited = self.classes.layouts[base]
                .as_ref()
                .ok_or_else(|| {
                    format!(
                        "base class layout was not materialized: child={} base={}",
                        self.classes.definitions[index].name, self.classes.definitions[base].name
                    )
                })?
                .fields
                .clone();
            let layout = self.classes.layouts[index]
                .as_mut()
                .expect("checked materialized derived layout");
            for field in &inherited {
                if let Some(existing) = layout.fields.iter().find(|slot| slot.name == field.name)
                    && existing.r#type != field.r#type
                {
                    return Err(format!(
                        "inherited class field layout differs: class={} field={}",
                        layout.name, field.name
                    ));
                }
            }
            let mut own = std::mem::take(&mut layout.fields);
            own.retain(|field| !inherited.iter().any(|base| base.name == field.name));
            layout.fields = inherited;
            layout.fields.extend(own);
        }
        Ok(())
    }

    pub(super) fn inventory_classes(&mut self, files: &[Node]) {
        for file in files {
            let mut definitions = Vec::new();
            fn visit(node: Node, definitions: &mut Vec<(Node, Node)>) {
                if node.kind() == SyntaxKind::ClassDeclaration && !node.name().is_nil() {
                    definitions.push((node, node.name()));
                } else if node.kind() == SyntaxKind::ClassExpression {
                    let binding = if node.parent().kind() == SyntaxKind::VariableDeclaration
                        && node.parent().name().kind() == SyntaxKind::Identifier
                    {
                        node.parent().name()
                    } else if !node.name().is_nil() {
                        node.name()
                    } else {
                        Node::NIL
                    };
                    definitions.push((node, binding));
                }
                node.for_each_child(&mut |child| {
                    visit(child, definitions);
                    false
                });
            }
            visit(*file, &mut definitions);
            for (node, binding) in definitions {
                let symbol = (node.kind() == SyntaxKind::ClassDeclaration
                    && !binding.is_nil()
                    && binding.kind() == SyntaxKind::Identifier)
                    .then(|| self.symbol(binding));
                let index = self.classes.definitions.len();
                let token = Local {
                    id: format!("%g.class.{index}"),
                    name: format!("class {index}"),
                    r#type: Type::F64,
                    mutable: false,
                    boxed: false,
                };
                let token = (node.kind() == SyntaxKind::ClassDeclaration
                    && node.parent().kind() == SyntaxKind::SourceFile)
                    .then_some(token);
                if let Some(token) = &token {
                    self.globals.push(ir::Global {
                        id: token.id.clone(),
                        name: token.name.clone(),
                        r#type: Type::F64,
                        mutable: false,
                        loc: self.loc(node),
                    });
                }
                if let Some(symbol) = symbol.filter(|symbol| *symbol != 0) {
                    self.classes.symbols.insert(symbol, index);
                }
                let ty = self.checker.get_type_at_location(node);
                let class_symbol = self.checker.ty(ty).symbol().0;
                if class_symbol != 0 {
                    self.classes.symbols.insert(class_symbol, index);
                }
                if node.kind() == SyntaxKind::ClassDeclaration
                    && !node.name().is_nil()
                    && node.name().kind() == SyntaxKind::Identifier
                {
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
                    captures: Vec::new(),
                });
                self.classes.layouts.push(None);
            }
        }
        fn prototype_assignments(node: Node, assignments: &mut Vec<Node>) {
            if node.kind() == SyntaxKind::BinaryExpression
                && node.operator_token().kind() == SyntaxKind::EqualsToken
            {
                let left = node.left();
                if left.kind() == SyntaxKind::PropertyAccessExpression {
                    let prototype = primitives::primitive_source(left.expression());
                    if prototype.kind() == SyntaxKind::PropertyAccessExpression
                        && prototype.name().text() == "prototype"
                        && prototype.expression().kind() == SyntaxKind::Identifier
                    {
                        assignments.push(node);
                    }
                }
            }
            node.for_each_child(&mut |child| {
                prototype_assignments(child, assignments);
                false
            });
        }
        let mut assignments = Vec::new();
        for file in files {
            prototype_assignments(*file, &mut assignments);
        }
        for assignment in assignments {
            let left = assignment.left();
            let class = primitives::primitive_source(left.expression()).expression();
            let mut owners = self.class_symbol(class).into_iter().collect::<Vec<_>>();
            if class.kind() == SyntaxKind::Identifier {
                let named = self
                    .classes
                    .definitions
                    .iter()
                    .enumerate()
                    .filter(|(_, definition)| {
                        !definition.node.is_nil()
                            && !definition.node.name().is_nil()
                            && definition.node.name().text() == class.text()
                    })
                    .map(|(index, _)| index)
                    .collect::<Vec<_>>();
                if let [index] = named.as_slice()
                    && !owners.contains(index)
                {
                    // Transpiled class factories commonly return a named
                    // local class into a same-spelled outer `var`, then attach
                    // prototype data through that alias. A unique lexical
                    // class name proves both spellings share the returned
                    // identity even when the JS checker keeps two symbols.
                    owners.push(*index);
                }
            }
            for index in owners {
                self.classes
                    .prototype_fields
                    .insert((index, left.name().text().into()), assignment);
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
        if self.standard_event_emitter(symbol) {
            let index = self.event_emitter_class(info.value_declaration);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if self.standard_async_resource(symbol) {
            let site = (!info.value_declaration.is_nil())
                .then_some(info.value_declaration)
                .or_else(|| {
                    info.declarations
                        .iter()
                        .copied()
                        .find(|node| !node.is_nil())
                })
                .expect("standard AsyncResource declaration");
            let index = self.async_resource_class(site);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if self.standard_dom_event(symbol) {
            let site = (!info.value_declaration.is_nil())
                .then_some(info.value_declaration)
                .or_else(|| {
                    info.declarations
                        .iter()
                        .copied()
                        .find(|node| !node.is_nil())
                })
                .expect("standard Event declaration");
            let index = self.dom_event_class(site);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if self.standard_event_target(symbol) {
            let site = (!info.value_declaration.is_nil())
                .then_some(info.value_declaration)
                .or_else(|| {
                    info.declarations
                        .iter()
                        .copied()
                        .find(|node| !node.is_nil())
                })
                .expect("standard EventTarget declaration");
            let index = self.event_target_class(site);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if self.standard_node_readable(symbol) {
            let site = (!info.value_declaration.is_nil())
                .then_some(info.value_declaration)
                .or_else(|| {
                    info.declarations
                        .iter()
                        .copied()
                        .find(|node| !node.is_nil())
                })
                .expect("standard Readable declaration");
            let index = self.node_readable_class(site);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if self.standard_node_duplex(symbol) {
            let site = (!info.value_declaration.is_nil())
                .then_some(info.value_declaration)
                .or_else(|| {
                    info.declarations
                        .iter()
                        .copied()
                        .find(|node| !node.is_nil())
                })
                .expect("standard Duplex declaration");
            let index = self.node_duplex_class(site);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if self.standard_node_writable(symbol) {
            let site = (!info.value_declaration.is_nil())
                .then_some(info.value_declaration)
                .or_else(|| {
                    info.declarations
                        .iter()
                        .copied()
                        .find(|node| !node.is_nil())
                })
                .expect("standard Writable declaration");
            let index = self.node_writable_class(site);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if self.standard_node_transform(symbol) {
            let site = (!info.value_declaration.is_nil())
                .then_some(info.value_declaration)
                .or_else(|| {
                    info.declarations
                        .iter()
                        .copied()
                        .find(|node| !node.is_nil())
                })
                .expect("standard Transform declaration");
            let index = self.node_transform_class(site);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
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
                        captures: Vec::new(),
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
                        captures: vec![],
                        methods: vec![],
                        symbol_methods: vec![],
                        symbol_brand: None,
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
            let index = self.codec_class(&name);
            self.classes.symbols.insert(symbol, index);
            return Some(index);
        }
        if !matches!(
            name.as_str(),
            "Error"
                | "EvalError"
                | "RangeError"
                | "ReferenceError"
                | "SyntaxError"
                | "TypeError"
                | "URIError"
                | "DOMException"
                | "AggregateError"
        ) || !info.declarations.iter().any(|n| {
            if n.is_nil() {
                return false;
            }
            let file = &source_file_info(get_source_file_of_node(*n)).file_name;
            if name == "DOMException" {
                file.ends_with("/lib.dom.d.ts")
                    || file.ends_with("/lib.webworker.d.ts")
                    || file.ends_with("/@types/node/web-globals/domexception.d.ts")
                    || (file.contains("/bun-types/") && file.ends_with("/globals.d.ts"))
            } else if name == "AggregateError" {
                file.ends_with("/lib.es2021.promise.d.ts")
                    || file.ends_with("/lib.es2022.error.d.ts")
            } else {
                file.ends_with("/lib.es5.d.ts")
            }
        }) {
            return None;
        }
        // Install the complete builtin prefix once. Source recognition still
        // requires declaration identity; a user-defined Error is never ambient.
        for builtin in [
            "Error",
            "EvalError",
            "RangeError",
            "ReferenceError",
            "SyntaxError",
            "TypeError",
            "URIError",
            "DOMException",
            "AggregateError",
        ] {
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
                captures: Vec::new(),
            });
            self.classes.layouts.push(Some(ir::Class {
                name: ir_name,
                js_name: builtin.into(),
                runtime: true,
                base: base.map(|i| self.classes.definitions[i].name.clone()),
                fields: ir::error_fields(),
                captures: vec![],
                methods: vec![],
                symbol_methods: vec![],
                symbol_brand: None,
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

    pub(in crate::frontend) fn class_symbol(&mut self, node: Node) -> Option<usize> {
        let identity = if node.kind() == SyntaxKind::PropertyAccessExpression
            && (self.module_namespace(node.expression())
                || self.commonjs_namespace_alias(node.expression()))
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

    fn commonjs_wrapped_default_class(&mut self, node: Node) -> Option<usize> {
        if node.kind() != SyntaxKind::PropertyAccessExpression || node.name().text() != "default" {
            return None;
        }
        let file = self.commonjs_namespace_require_file(node.expression())?;
        for statement in file.statements().into_iter().rev() {
            if statement.kind() != SyntaxKind::ExpressionStatement {
                continue;
            }
            let assignment = statement.expression();
            if assignment.kind() != SyntaxKind::BinaryExpression
                || assignment.operator_token().kind() != SyntaxKind::EqualsToken
                || assignment.left().kind() != SyntaxKind::PropertyAccessExpression
                || assignment.left().name().text() != "default"
                || assignment.left().expression().kind() != SyntaxKind::Identifier
                || assignment.left().expression().text() != "exports"
            {
                continue;
            }
            return self.class_symbol(assignment.right());
        }
        None
    }

    /// Resolve a constructor-producing expression through the instance type
    /// of its construct signature. `typeof C` is often represented by a
    /// separate `CConstructor` interface whose own symbol is not the class
    /// identity, while constructing it still returns the exact `C` instance.
    fn effectful_heritage_class(&mut self, node: Node) -> Option<usize> {
        let ty = self.checker.get_type_at_location(node);
        let signatures = self
            .checker
            .get_signatures_of_type(ty, SignatureKind::CONSTRUCT);
        let mut results = Vec::with_capacity(signatures.len());
        for signature in signatures {
            results.push(self.checker.get_return_type_of_signature(signature));
        }
        let symbols = results
            .into_iter()
            .map(|result| self.checker.ty(result).symbol().0)
            .collect::<Vec<_>>();
        let mut identity = None;
        for symbol in symbols {
            let Some(index) = self.builtin_class(symbol) else {
                identity = None;
                break;
            };
            if identity.is_some_and(|existing| existing != index) {
                return None;
            }
            identity = Some(index);
        }
        if identity.is_some() {
            return identity;
        }

        if node.kind() != SyntaxKind::CallExpression
            || !node.arguments().is_empty()
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let callee = self.symbol(node.expression());
        if callee == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(callee)).value_declaration;
        if declaration.kind() != SyntaxKind::FunctionDeclaration
            || !declaration.parameters().is_empty()
            || declaration.body().is_nil()
        {
            return None;
        }
        let statements = declaration.body().statements();
        if statements.is_empty()
            || statements.get(statements.len() - 1).kind() != SyntaxKind::ReturnStatement
        {
            return None;
        }
        fn returns(node: Node, values: &mut Vec<Node>) {
            if node.kind() == SyntaxKind::ReturnStatement {
                if !node.expression().is_nil() {
                    values.push(node.expression());
                }
                return;
            }
            if matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::ClassExpression
            ) {
                return;
            }
            node.for_each_child(&mut |child| {
                returns(child, values);
                false
            });
        }
        let mut values = Vec::new();
        declaration.body().for_each_child(&mut |child| {
            returns(child, &mut values);
            false
        });
        if values.is_empty() {
            return None;
        }
        for value in values {
            let index = if let Some(index) = self.class_symbol(value) {
                index
            } else if self.is_proxy_new(value) {
                let target = value.arguments().into_iter().next()?;
                self.class_symbol(target)?
            } else {
                return None;
            };
            if identity.is_some_and(|existing| existing != index) {
                return None;
            }
            identity = Some(index);
        }
        identity
    }

    /// Prove the native parent of an empty class factory whose JavaScript
    /// heritage is `optional.Parent ?? Object`. The subclass may use the
    /// represented parent layout only when every construction is guarded by
    /// that same optional property and every direct explicit caller supplies
    /// one identical native class.
    pub(super) fn guarded_optional_class_heritage(
        &mut self,
        class: Node,
        expression: Node,
    ) -> Option<usize> {
        if expression.kind() != SyntaxKind::Identifier || !class.members().is_empty() {
            return None;
        }
        let symbol = self.symbol(expression);
        if symbol == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if declaration.kind() != SyntaxKind::VariableDeclaration {
            return None;
        }
        let initializer = primitives::primitive_source(declaration.initializer());
        if initializer.kind() != SyntaxKind::BinaryExpression
            || initializer.operator_token().kind() != SyntaxKind::QuestionQuestionToken
            || !self.standard_object(initializer.right())
        {
            return None;
        }
        let candidate = primitives::primitive_source(initializer.left());
        if candidate.kind() != SyntaxKind::PropertyAccessExpression {
            return None;
        }

        let mut owner = class.parent();
        while !owner.is_nil()
            && !matches!(
                owner.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
            )
        {
            owner = owner.parent();
        }
        if owner.is_nil() || owner.name().is_nil() {
            return None;
        }
        let function_symbol = self.symbol(owner.name());
        let class_symbol = self.symbol(class.name());
        if function_symbol == 0 || class_symbol == 0 {
            return None;
        }

        fn collect(node: Node, kind: SyntaxKind, output: &mut Vec<Node>) {
            if node.kind() == kind {
                output.push(node);
            }
            node.for_each_child(&mut |child| {
                collect(child, kind, output);
                false
            });
        }
        let same_guard = |this: &mut Lowerer<'_>, guard: Node| {
            let guard = primitives::primitive_source(guard);
            guard.kind() == SyntaxKind::PropertyAccessExpression
                && guard.name().text() == candidate.name().text()
                && this.symbol(guard.expression()) == this.symbol(candidate.expression())
        };

        let mut constructions = Vec::new();
        collect(owner.body(), SyntaxKind::NewExpression, &mut constructions);
        let constructions = constructions
            .into_iter()
            .filter(|construction| self.symbol(construction.expression()) == class_symbol)
            .collect::<Vec<_>>();
        if constructions.is_empty()
            || constructions.into_iter().any(|construction| {
                let mut child = construction;
                let mut parent = construction.parent();
                while !parent.is_nil() && parent != owner {
                    if parent.kind() == SyntaxKind::ConditionalExpression
                        && parent.when_true() == child
                        && same_guard(self, parent.condition())
                    {
                        return false;
                    }
                    child = parent;
                    parent = parent.parent();
                }
                true
            })
        {
            return None;
        }

        let mut calls = Vec::new();
        for file in program::source_files() {
            if !is_declaration(&source_file_info(file).file_name) {
                collect(file, SyntaxKind::CallExpression, &mut calls);
            }
        }
        let mut parent = None;
        let mut found_call = false;
        for call in calls {
            if self.symbol(call.expression()) != function_symbol {
                continue;
            }
            found_call = true;
            let arguments = call.arguments().into_iter().collect::<Vec<_>>();
            let Some(params) = arguments.get(2).copied() else {
                continue;
            };
            if matches!(params.kind(), SyntaxKind::Identifier if params.text() == "undefined") {
                continue;
            }
            if params.kind() != SyntaxKind::ObjectLiteralExpression {
                return None;
            }
            let Some(value) = params.properties().into_iter().find_map(|property| {
                (property.kind() == SyntaxKind::PropertyAssignment
                    && property.name().text() == candidate.name().text())
                .then(|| property.initializer())
            }) else {
                continue;
            };
            let class = self.class_symbol(value)?;
            if parent.is_some_and(|previous| previous != class) {
                return None;
            }
            parent = Some(class);
        }
        if !found_call {
            return None;
        }
        parent
    }

    pub(in crate::frontend) fn source_class_name(&mut self, node: Node) -> Option<String> {
        let index = self.class_symbol(node)?;
        Some(self.classes.definitions[index].name.clone())
    }

    /// Resolve a source constructor from its declaration identity even when a
    /// JavaScript package's published declarations make the checker's value
    /// type `any`. This is deliberately declaration-based: equal spellings in
    /// another scope or module cannot select the wrong native class.
    pub(in crate::frontend) fn source_constructed_class_name(
        &mut self,
        constructor: Node,
    ) -> Option<String> {
        if constructor.kind() == SyntaxKind::Identifier {
            let local = self.checker.get_symbol_at_location(constructor, false);
            if local.0 != 0 {
                let info = self.checker.sym(local);
                let declaration = if !info.value_declaration.is_nil() {
                    info.value_declaration
                } else {
                    info.declarations
                        .iter()
                        .copied()
                        .find(|declaration| {
                            !declaration.is_nil()
                                && declaration.kind() == SyntaxKind::BindingElement
                        })
                        .unwrap_or(Node::NIL)
                };
                if !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::BindingElement
                    && declaration.parent().kind() == SyntaxKind::ObjectBindingPattern
                    && declaration.parent().parent().kind() == SyntaxKind::VariableDeclaration
                {
                    let initializer = declaration.parent().parent().initializer();
                    if initializer.kind() == SyntaxKind::CallExpression
                        && initializer.expression().kind() == SyntaxKind::Identifier
                        && initializer.expression().text() == "require"
                    {
                        let arguments = initializer.arguments().into_iter().collect::<Vec<_>>();
                        if let [specifier] = arguments.as_slice()
                            && specifier.kind() == SyntaxKind::StringLiteral
                        {
                            let specifier = specifier.text();
                            let member = declaration.property_name_or_name().text();
                            let class = match (specifier.as_ref(), member) {
                                ("stream" | "node:stream", "Transform" | "PassThrough") => {
                                    Some(node_streams::TRANSFORM)
                                }
                                ("stream" | "node:stream", "Duplex") => Some(node_streams::DUPLEX),
                                ("stream" | "node:stream", "Readable") => {
                                    Some(node_streams::READABLE)
                                }
                                ("stream" | "node:stream", "Writable") => {
                                    Some(node_streams::WRITABLE)
                                }
                                ("console" | "node:console", "Console") => {
                                    Some(node_console::CLASS)
                                }
                                _ => None,
                            };
                            if let Some(class) = class {
                                return Some(class.into());
                            }
                        }
                    }
                }
            }
        }
        let native = self.native_symbol(constructor);
        if let Some((module, member)) = self.native_functions.get(&native) {
            let class = match (*module, member.as_str()) {
                ("stream", "Transform" | "PassThrough") => Some(node_streams::TRANSFORM),
                ("stream", "Duplex") => Some(node_streams::DUPLEX),
                ("stream", "Readable") => Some(node_streams::READABLE),
                ("stream", "Writable") => Some(node_streams::WRITABLE),
                ("console", "Console") => Some(node_console::CLASS),
                _ => None,
            };
            if let Some(class) = class {
                return Some(class.into());
            }
        }
        if let Some(name) = self.source_class_name(constructor) {
            return Some(name);
        }
        let identity = if constructor.kind() == SyntaxKind::PropertyAccessExpression {
            constructor.name()
        } else {
            constructor
        };
        let symbol = self.symbol(identity);
        if symbol == 0 {
            return None;
        }
        let mut declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::Identifier
            && matches!(
                declaration.parent().kind(),
                SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
            )
        {
            declaration = declaration.parent();
        } else if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && !declaration.initializer().is_nil()
            && declaration.initializer().kind() == SyntaxKind::ClassExpression
        {
            declaration = declaration.initializer();
        }
        if let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.node == declaration)
        {
            return Some(self.classes.definitions[index].name.clone());
        }
        // A package can bind the implementation identifier to its published
        // `.d.ts` declaration. Match back to the implementation only when the
        // constructor spelling is unique in that exact source module.
        if identity.kind() != SyntaxKind::Identifier {
            return None;
        }
        let file = source_file_info(get_source_file_of_node(identity))
            .file_name
            .clone();
        let mut candidates = self.classes.definitions.iter().filter(|definition| {
            definition.file == file
                && !definition.node.is_nil()
                && !definition.node.name().is_nil()
                && definition.node.name().text() == identity.text()
        });
        let selected = candidates.next()?;
        if candidates.next().is_some() {
            return None;
        }
        Some(selected.name.clone())
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
        if node.modifier_flags().intersects(ModifierFlags::AMBIENT)
            || node
                .modifiers()
                .nodes()
                .into_iter()
                .any(|m| m.kind() == SyntaxKind::Decorator)
        {
            return Err(self.refuse(node, "only concrete undecorated classes are ported"));
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
            let lexical_heritage = matches!(
                expression.kind(),
                SyntaxKind::Identifier | SyntaxKind::ThisKeyword
            ) || (expression.kind() == SyntaxKind::PropertyAccessExpression
                && (self.module_namespace(expression.expression())
                    || self.commonjs_namespace_alias(expression.expression())));
            let heritage = self
                .class_symbol(expression)
                .or_else(|| self.commonjs_wrapped_default_class(expression))
                .or_else(|| self.effectful_heritage_class(expression))
                .or_else(|| self.guarded_optional_class_heritage(node, expression));
            let heritage = heritage.ok_or_else(|| {
                if lexical_heritage {
                    self.refuse(expression, "class heritage has no native identity")
                } else {
                    self.refuse(
                        expression,
                        "effectful class heritage has no exact native identity",
                    )
                }
            })?;
            base = Some(heritage);
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
        if node.kind() == SyntaxKind::ClassExpression
            || (node.kind() == SyntaxKind::ClassDeclaration
                && node.parent().kind() != SyntaxKind::SourceFile)
        {
            {
                fn collect(
                    lowerer: &mut Lowerer<'_>,
                    current: Node,
                    class: Node,
                    captures: &mut Vec<(u32, Node, Type)>,
                ) {
                    // A property-access name is a descriptor lookup, not a
                    // lexical read. In particular, `this.method()` inside a
                    // constructor arrow must retain `this`; capturing the
                    // method's declaration symbol would invent a nonexistent
                    // local cell for a prototype member.
                    let property_name = current.kind() == SyntaxKind::Identifier
                        && current.parent().kind() == SyntaxKind::PropertyAccessExpression
                        && current.parent().name() == current;
                    let self_reference = current.kind() == SyntaxKind::Identifier
                        && !class.name().is_nil()
                        && lowerer.symbol(current) == lowerer.symbol(class.name());
                    if current.kind() == SyntaxKind::Identifier && !property_name && !self_reference
                    {
                        let symbol = lowerer.symbol(current);
                        if symbol != 0 && !captures.iter().any(|capture| capture.0 == symbol) {
                            let declaration = lowerer
                                .checker
                                .sym(source_frontend::prelude::SymbolId(symbol))
                                .value_declaration;
                            if !declaration.is_nil()
                                && !(declaration.pos() >= class.pos()
                                    && declaration.end() <= class.end())
                            {
                                let mut owner = declaration.parent();
                                let mut lexical = false;
                                while !owner.is_nil() && owner.kind() != SyntaxKind::SourceFile {
                                    if matches!(
                                        owner.kind(),
                                        SyntaxKind::FunctionDeclaration
                                            | SyntaxKind::FunctionExpression
                                            | SyntaxKind::ArrowFunction
                                            | SyntaxKind::MethodDeclaration
                                            | SyntaxKind::GetAccessor
                                            | SyntaxKind::SetAccessor
                                    ) {
                                        lexical = true;
                                        break;
                                    }
                                    owner = owner.parent();
                                }
                                lexical |= get_source_file_of_node(declaration)
                                    == get_source_file_of_node(class);
                                if lexical {
                                    let ty = lowerer.ty(current).unwrap_or(Type::Dyn);
                                    captures.push((symbol, current, ty));
                                }
                            }
                        }
                    }
                    current.for_each_child(&mut |child| {
                        collect(lowerer, child, class, captures);
                        false
                    });
                }
                let mut captures = Vec::new();
                for member in node
                    .members()
                    .into_iter()
                    .filter(|member| !member.modifier_flags().intersects(ModifierFlags::STATIC))
                {
                    let root = match member.kind() {
                        SyntaxKind::Constructor
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::GetAccessor
                        | SyntaxKind::SetAccessor => member.body(),
                        SyntaxKind::PropertyDeclaration => member.initializer(),
                        _ => Node::default(),
                    };
                    if !root.is_nil() {
                        collect(self, root, node, &mut captures);
                    }
                }
                self.classes.definitions[index].captures = captures;
            }
        }
        let registry_brand = self.class_registry_brand(node);
        for member in node.members() {
            let static_method = member.modifier_flags().intersects(ModifierFlags::STATIC)
                && member.kind() == SyntaxKind::MethodDeclaration
                && matches!(
                    member.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::StringLiteral
                )
                && !static_methods::reads_super(member);
            let static_getter = member.modifier_flags().intersects(ModifierFlags::STATIC)
                && member.kind() == SyntaxKind::GetAccessor
                && matches!(
                    member.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::StringLiteral
                )
                && !static_methods::reads_super(member);
            let static_field = member.modifier_flags().intersects(ModifierFlags::STATIC)
                && member.kind() == SyntaxKind::PropertyDeclaration
                && matches!(
                    node.kind(),
                    SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                )
                && matches!(
                    member.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::StringLiteral
                )
                && (!static_methods::reads_super(member)
                    || static_super_initializer(member.initializer()));
            let symbol_method = if matches!(
                member.kind(),
                SyntaxKind::MethodDeclaration
                    | SyntaxKind::PropertyDeclaration
                    | SyntaxKind::GetAccessor
            ) && member.name().kind() == SyntaxKind::ComputedPropertyName
            {
                self.class_symbol_key(member.name().expression())
            } else {
                None
            };
            let static_symbol_method = member.modifier_flags().intersects(ModifierFlags::STATIC)
                && member.kind() == SyntaxKind::MethodDeclaration
                && symbol_method.is_some()
                && !static_methods::reads_super(member);
            let registry_brand_member = registry_brand
                .as_ref()
                .is_some_and(|(_, method, getter)| member == *method || member == *getter);
            if member.kind() == SyntaxKind::PropertyDeclaration
                && member.name().kind() == SyntaxKind::ComputedPropertyName
            {
                let key = member.name().expression();
                let symbol = self.checker.get_symbol_at_location(key, false).0;
                let declaration = (symbol != 0)
                    .then(|| {
                        self.checker
                            .sym(source_frontend::prelude::SymbolId(symbol))
                            .declarations
                            .iter()
                            .copied()
                            .find(|declaration| {
                                !declaration.is_nil()
                                    && matches!(
                                        declaration.kind(),
                                        SyntaxKind::VariableDeclaration
                                            | SyntaxKind::BindingElement
                                    )
                            })
                    })
                    .flatten();
                if key.kind() != SyntaxKind::Identifier
                    || symbol_method.is_none()
                    || !declaration.is_some_and(|declaration| {
                        matches!(
                            declaration.kind(),
                            SyntaxKind::VariableDeclaration | SyntaxKind::BindingElement
                        ) && declaration.end() <= node.pos()
                            && get_source_file_of_node(declaration) == get_source_file_of_node(node)
                    })
                {
                    return Err(self.refuse(
                        member,
                        "computed class field needs an earlier local const symbol",
                    ));
                }
            }
            if (member.modifier_flags().intersects(ModifierFlags::STATIC)
                && !static_method
                && !static_getter
                && !static_field
                && !static_symbol_method
                && !registry_brand_member)
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
                        SyntaxKind::PropertyDeclaration
                            | SyntaxKind::MethodDeclaration
                            | SyntaxKind::GetAccessor
                    ) && member.name().kind() == SyntaxKind::PrivateIdentifier)
                        && symbol_method.is_none()
                        && !registry_brand_member))
            {
                return Err(self.refuse(
                    member,
                    "class static/computed members, private accessors and decorators are not ported",
                ));
            }
            if let Some(key) = symbol_method.filter(|_| {
                matches!(
                    member.kind(),
                    SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
                ) && !member.modifier_flags().intersects(ModifierFlags::STATIC)
            }) {
                self.classes.symbol_nodes.insert((index, key), member);
            }
        }
        self.classes.definitions[index].base = base;
        self.inventory_private_slots(index)?;
        for member in node.members().into_iter().filter(|m| {
            matches!(
                m.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
            ) && !m.modifier_flags().intersects(ModifierFlags::STATIC)
                && !matches!(
                    m.name().kind(),
                    SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
                )
        }) {
            let name = member.name().text();
            if name.starts_with('%')
                || name.contains(':')
                || name == "constructor"
                || (name == "valueOf" && self.classes.subclass(&definition.name, "%Error"))
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
            ) && !m.modifier_flags().intersects(ModifierFlags::STATIC)
                && !matches!(
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
        for member in node.members().into_iter().filter(|m| {
            matches!(m.kind(), SyntaxKind::GetAccessor | SyntaxKind::SetAccessor)
                && !m.modifier_flags().intersects(ModifierFlags::STATIC)
        }) {
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
                        ) && !m.modifier_flags().intersects(ModifierFlags::STATIC)
                            && !m.modifier_flags().intersects(ModifierFlags::ABSTRACT)
                            && !matches!(
                                m.name().kind(),
                                SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
                            )
                            && m.name().text() == name
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
            if node.name().is_nil() || node.name().kind() != SyntaxKind::Identifier {
                return Err(self.refuse(node, "local class declaration requires a name"));
            }
            let value = self.class_expression(node)?;
            let symbol = self.symbol(node.name());
            if self.recursive_functions.contains_key(&symbol)
                && let Some(local) = self.bindings.get(&symbol).cloned()
                && local.r#type == Type::Dyn
                && local.boxed
            {
                let value = self.coerce(value, Type::Dyn, node)?;
                return Ok(vec![Stmt::Assign {
                    local_id: local.id,
                    value: Expr::LibCall {
                        r#fn: "lexical.initialize".into(),
                        args: vec![value],
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    },
                    initializes_global: false,
                    loc: self.loc(node),
                }]);
            }
            let local = Local {
                id: format!("v{}", self.locals.len()),
                name: node.name().text().into(),
                r#type: value.ty(),
                mutable: true,
                boxed: false,
            };
            self.locals.push(local.clone());
            self.bindings.insert(symbol, local.clone());
            return Ok(vec![Stmt::VarDecl {
                local_id: local.id,
                init: value,
                loc: self.loc(node),
            }]);
        }
        let index = self
            .class_symbol(node.name())
            .ok_or_else(|| self.refuse(node, "class has no native identity"))?;
        self.resolve_class(index)?;
        let mut body = Vec::new();
        if let Some(value) = self.class_heritage_value(node)? {
            let class = self.class_ref(index, node, None)?;
            body.push(Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "class.setParent".into(),
                    args: vec![class, value],
                    r#type: Type::Void,
                    loc: self.loc(node),
                },
                loc: self.loc(node),
            });
        }
        body.extend(self.class_computed_symbol_keys(node, None)?);
        body.extend(self.initialize_private_storage(index, node)?);
        body.extend(self.initialize_static_fields(index, node, None)?);
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

    /// Computed names are read at class definition, even for unused methods.
    /// The binding read retains module initialization and TDZ semantics.
    fn class_computed_symbol_keys(
        &mut self,
        node: Node,
        receiver: Option<Expr>,
    ) -> Result<Vec<Stmt>, String> {
        let mut body = Vec::new();
        let index = if node.kind() == SyntaxKind::ClassExpression {
            self.classes.definitions.iter().position(|definition| {
                definition.node == node
                    || (definition.file == self.file
                        && definition.node.pos() == node.pos()
                        && definition.node.end() == node.end())
            })
        } else {
            self.class_symbol(node.name())
        }
        .ok_or_else(|| self.refuse(node, "class has no native identity"))?;
        let mut seen = HashSet::new();
        for member in node.members() {
            if matches!(
                member.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
            ) && member.name().kind() == SyntaxKind::ComputedPropertyName
                && let Some(key) = self.class_symbol_key(member.name().expression())
                && !seen.insert((
                    key,
                    member.modifier_flags().intersects(ModifierFlags::STATIC),
                ))
            {
                return Err(self.refuse(member, "overloaded symbol method bodies are not ported"));
            }
        }
        for member in node.members() {
            if !matches!(
                member.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
            ) || member.name().kind() != SyntaxKind::ComputedPropertyName
            {
                continue;
            }
            let key = member.name().expression();
            if let Some(symbol_key) = self.class_symbol_key(key) {
                let value = self.expression(key)?;
                let value = self.coerce(value, Type::Symbol, key)?;
                if member.modifier_flags().intersects(ModifierFlags::STATIC) {
                    if member.kind() != SyntaxKind::MethodDeclaration {
                        return Err(self.refuse(member, "static symbol accessors are not ported"));
                    }
                    let callable = self.static_symbol_method_value(index, symbol_key, member)?;
                    let class = if let Some(receiver) = &receiver {
                        receiver.clone()
                    } else {
                        self.class_ref(index, node, None)?
                    };
                    body.push(Stmt::Expression {
                        expr: Expr::LibCall {
                            r#fn: "class.staticSymbolDefine".into(),
                            args: vec![class, value, callable],
                            r#type: Type::Void,
                            loc: self.loc(member),
                        },
                        loc: self.loc(key),
                    });
                    continue;
                }
                let descriptor = if member.type_parameters().is_empty() && !member.body().is_nil() {
                    Some(self.request_symbol_method(index, symbol_key, member)?)
                } else {
                    None
                };
                let expr = if let Some(descriptor) = descriptor {
                    let class = if let Some(receiver) = &receiver {
                        receiver.clone()
                    } else {
                        self.class_ref(index, node, None)?
                    };
                    Expr::LibCall {
                        r#fn: format!("class.symbolDefine:{}", descriptor.name),
                        args: vec![class, value],
                        r#type: Type::Void,
                        loc: self.loc(member),
                    }
                } else {
                    value
                };
                body.push(Stmt::Expression {
                    expr,
                    loc: self.loc(key),
                });
            }
        }
        Ok(body)
    }

    pub(super) fn initialize_static_fields(
        &mut self,
        index: usize,
        node: Node,
        receiver: Option<Expr>,
    ) -> Result<Vec<Stmt>, String> {
        let fields = node
            .members()
            .into_iter()
            .filter(|member| {
                member.kind() == SyntaxKind::PropertyDeclaration
                    && member.modifier_flags().intersects(ModifierFlags::STATIC)
                    && !member.modifier_flags().intersects(ModifierFlags::AMBIENT)
            })
            .collect::<Vec<_>>();
        if fields.is_empty() {
            return Ok(Vec::new());
        }
        self.layout_class(index)?;
        // Static storage operations materialize the class value in IR, whose
        // contract requires its constructor to be present even if the source
        // never reads the declaration's outer binding.
        self.request_constructor(index)?;
        let class_name = self.classes.definitions[index].name.clone();
        let mut body = Vec::new();
        for field in fields {
            self.function_data_key(field, field.name().text())?;
            let mut current = Some(index);
            while let Some(owner) = current {
                let definition = &self.classes.definitions[owner];
                if !definition.node.is_nil()
                    && definition.node.members().into_iter().any(|member| {
                        member.kind() == SyntaxKind::MethodDeclaration
                            && member.modifier_flags().intersects(ModifierFlags::STATIC)
                            && member.name().text() == field.name().text()
                    })
                {
                    return Err(self.refuse(
                        field,
                        "static field and method shadowing requires shared class descriptors",
                    ));
                }
                current = definition.base;
            }
            let init = field.initializer();
            let value = if init.is_nil() {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(field),
                    },
                    Type::Dyn,
                    field,
                )?
            } else {
                self.expected_expression(init, Type::Dyn)?
            };
            let class = receiver.clone().unwrap_or_else(|| Expr::ClassRef {
                class_name: class_name.clone(),
                r#type: Type::Classval {
                    class_name: class_name.clone(),
                },
                loc: self.loc(field),
            });
            // The value is confined to a data-slot operation; class erasure
            // remains fenced when methods cannot be represented dynamically.
            let obj = Expr::DynFrom {
                value: Box::new(class),
                r#type: Type::Dyn,
                loc: self.loc(field),
            };
            let key = Expr::StrLit {
                value: field.name().text().into(),
                r#type: Type::String,
                loc: self.loc(field),
            };
            body.push(self.checked_dynamic_property_set(field, obj, key, value)?);
        }
        Ok(body)
    }

    pub(super) fn class_data_receiver(
        &mut self,
        value: Expr,
        name: &str,
        site: Node,
    ) -> Result<Expr, String> {
        if let Type::Classval { class_name } = value.ty()
            && self.classes.has_static_methods(&class_name)
        {
            let mut current = self
                .classes
                .definitions
                .iter()
                .position(|definition| definition.name == class_name);
            let mut static_data = false;
            let mut static_method = false;
            while let Some(index) = current {
                let definition = &self.classes.definitions[index];
                static_data |= !definition.node.is_nil()
                    && definition.node.members().into_iter().any(|member| {
                        member.kind() == SyntaxKind::PropertyDeclaration
                            && member.modifier_flags().intersects(ModifierFlags::STATIC)
                            && matches!(
                                member.name().kind(),
                                SyntaxKind::Identifier | SyntaxKind::StringLiteral
                            )
                            && member.name().text() == name
                    });
                static_method |= !definition.node.is_nil()
                    && definition.node.members().into_iter().any(|member| {
                        member.kind() == SyntaxKind::MethodDeclaration
                            && member.modifier_flags().intersects(ModifierFlags::STATIC)
                            && member.name().text() == name
                    });
                current = definition.base;
            }
            if static_data {
                return Ok(Expr::DynFrom {
                    value: Box::new(value),
                    r#type: Type::Dyn,
                    loc: self.loc(site),
                });
            }
            let member = if site.kind() == SyntaxKind::BinaryExpression {
                site.left()
            } else {
                site
            };
            let ty = self.ty(member)?;
            if static_method
                && self
                    .native_type_contains(&ty, |part| matches!(part, Type::Dyn | Type::Func { .. }))
            {
                return Err(self.refuse(
                    site,
                    "callable or unknown static fields need shared class descriptors",
                ));
            }
            return Ok(Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(site),
            });
        }
        self.coerce(value, Type::Dyn, site)
    }

    pub(super) fn static_forward_read(&mut self, node: Node) -> bool {
        let index = if node.expression().kind() == SyntaxKind::ThisKeyword {
            let mut ancestor = node.parent();
            while !ancestor.is_nil()
                && ancestor.kind() != SyntaxKind::SourceFile
                && ancestor.kind() != SyntaxKind::PropertyDeclaration
            {
                ancestor = ancestor.parent();
            }
            if ancestor.is_nil() || ancestor.kind() != SyntaxKind::PropertyDeclaration {
                return false;
            }
            let Some(index) = self
                .classes
                .definitions
                .iter()
                .position(|definition| definition.node == ancestor.parent())
            else {
                return false;
            };
            index
        } else {
            let Some(index) = self.class_symbol(node.expression()) else {
                return false;
            };
            index
        };
        let class = self.classes.definitions[index].node;
        let mut field = node.parent();
        while !field.is_nil() && field.kind() != SyntaxKind::SourceFile {
            if field.kind() == SyntaxKind::PropertyDeclaration
                && field.modifier_flags().intersects(ModifierFlags::STATIC)
                && field.parent() == class
            {
                let declarations = class
                    .members()
                    .into_iter()
                    .filter(|member| {
                        member.kind() == SyntaxKind::PropertyDeclaration
                            && member.modifier_flags().intersects(ModifierFlags::STATIC)
                            && !member.modifier_flags().intersects(ModifierFlags::AMBIENT)
                            && member.name().text() == node.name().text()
                    })
                    .collect::<Vec<_>>();
                return declarations
                    .iter()
                    .any(|member| member.pos() >= field.pos())
                    && !declarations.iter().any(|member| member.pos() < field.pos());
            }
            field = field.parent();
        }
        false
    }

    pub(super) fn static_super_receiver(&mut self, member: Node) -> Result<Expr, String> {
        let parent = member.parent();
        let field =
            if parent.kind() == SyntaxKind::BinaryExpression && static_super_initializer(parent) {
                parent.parent()
            } else {
                parent
            };
        if field.kind() != SyntaxKind::PropertyDeclaration
            || !field.modifier_flags().intersects(ModifierFlags::STATIC)
            || (field.initializer() != member && field.initializer() != parent)
        {
            return Err(self.refuse(
                member,
                "static super access requires a direct field initializer",
            ));
        }
        let index = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.node == field.parent())
            .ok_or_else(|| self.refuse(member, "static super receiver has no class identity"))?;
        let base = self.classes.definitions[index].base.ok_or_else(|| {
            self.refuse(
                member,
                "static super properties require a represented base class",
            )
        })?;
        let mut current = Some(base);
        let mut represented = false;
        while let Some(owner) = current {
            let definition = &self.classes.definitions[owner];
            if !definition.node.is_nil()
                && definition.node.members().into_iter().any(|candidate| {
                    candidate.kind() == SyntaxKind::PropertyDeclaration
                        && candidate.modifier_flags().intersects(ModifierFlags::STATIC)
                        && !candidate
                            .modifier_flags()
                            .intersects(ModifierFlags::AMBIENT)
                        && candidate.name().text() == member.name().text()
                })
            {
                represented = true;
                break;
            }
            current = definition.base;
        }
        if !represented {
            return Err(self.refuse(
                member,
                "static super property needs a represented base data field",
            ));
        }
        self.request_constructor(base)?;
        let name = self.classes.definitions[base].name.clone();
        Ok(Expr::ClassRef {
            class_name: name.clone(),
            r#type: Type::Classval { class_name: name },
            loc: self.loc(member.expression()),
        })
    }

    fn layout_class(&mut self, index: usize) -> Result<(), String> {
        if self.classes.layouts[index].is_some() {
            return Ok(());
        }
        let root = self.classes.layout_active.is_empty();
        self.classes.layout_active.insert(index);
        let saved_file =
            std::mem::replace(&mut self.file, self.classes.definitions[index].file.clone());
        let mut result = self.layout_class_inner(index);
        self.file = saved_file;
        self.classes.layout_active.remove(&index);
        if result.is_ok() && root {
            while let Some(deferred) = self.classes.layout_deferred.pop_front() {
                if deferred != index
                    && self.classes.layouts[deferred].is_none()
                    && let Err(error) = self.layout_class(deferred)
                {
                    result = Err(error);
                    break;
                }
            }
        }
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
            js_name: if !definition.node.name().is_nil()
                && definition.node.name().kind() == SyntaxKind::Identifier
            {
                definition.node.name().text().into()
            } else if definition.node.parent().kind() == SyntaxKind::VariableDeclaration
                && !definition.node.parent().name().is_nil()
                && definition.node.parent().name().kind() == SyntaxKind::Identifier
            {
                definition.node.parent().name().text().into()
            } else {
                "anonymous".into()
            },
            runtime: false,
            base: definition
                .base
                .map(|base| self.classes.definitions[base].name.clone()),
            captures: definition
                .captures
                .iter()
                .map(|capture| capture.2.clone())
                .collect(),
            methods: vec![],
            symbol_methods: vec![],
            symbol_brand: self
                .class_registry_brand(definition.node)
                .map(|(key, _, _)| key),
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
                    && !matches!(
                        n.name().kind(),
                        SyntaxKind::PrivateIdentifier | SyntaxKind::ComputedPropertyName
                    )
                    && !n.modifier_flags().intersects(ModifierFlags::STATIC)
            })
            .map(|n| (n.name().text().to_string(), n))
            .collect::<Vec<_>>();
        // JavaScript fields can be introduced by assignments in constructors
        // or instance methods. Allocate their slots up front without moving
        // the writes so later property reads do not depend on lowering order.
        fn assigned(node: Node, fields: &mut Vec<(String, Node)>) {
            if node.is_nil() {
                return;
            }
            if matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
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
                    if name != "__proto__" && !fields.iter().any(|(n, _)| *n == name) {
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
            for param in ctor
                .parameters()
                .into_iter()
                .filter(|param| parameter_property(*param))
            {
                if param.name().kind() != SyntaxKind::Identifier {
                    return Err(self.refuse(
                        param,
                        "constructor binding-pattern properties are not ported",
                    ));
                }
                let name = param.name().text().to_string();
                if self.classes.accessor(index, &name).is_some() {
                    return Err(
                        self.refuse(param, "parameter property/accessor shadowing is not ported")
                    );
                }
                if !sources.iter().any(|(field, _)| *field == name) {
                    sources.push((name, param));
                }
            }
            assigned(ctor.body(), &mut sources);
        }
        for member in definition.node.members().into_iter().filter(|member| {
            !member.modifier_flags().intersects(ModifierFlags::STATIC)
                && matches!(
                    member.kind(),
                    SyntaxKind::MethodDeclaration
                        | SyntaxKind::GetAccessor
                        | SyntaxKind::SetAccessor
                )
        }) {
            assigned(member.body(), &mut sources);
        }
        let abstract_fields = definition
            .node
            .members()
            .into_iter()
            .filter(|member| {
                member.kind() == SyntaxKind::PropertyDeclaration
                    && member.modifier_flags().intersects(ModifierFlags::ABSTRACT)
                    && matches!(
                        member.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    )
            })
            .map(|member| member.name().text().to_string())
            .collect::<HashSet<_>>();
        sources.retain(|(name, _)| !abstract_fields.contains(name));
        let contract = self.class_contract(definition.node).cloned();
        sources.retain(|(name, node)| {
            node.kind() == SyntaxKind::PropertyDeclaration
                || self.classes.accessor(index, name).is_none()
        });
        for (name, field) in sources {
            if name.starts_with('%') || name == "__proto__" {
                return Err(self.refuse(field, "reserved class field names are not ported"));
            }
            let assignment = field.parent();
            let dynamic_parameter_assignment = if field.kind() == SyntaxKind::PropertyDeclaration {
                fn assigned_dynamic_parameter(
                    lowerer: &mut Lowerer<'_>,
                    node: Node,
                    name: &str,
                ) -> bool {
                    if node.is_nil()
                        || matches!(
                            node.kind(),
                            SyntaxKind::FunctionDeclaration
                                | SyntaxKind::FunctionExpression
                                | SyntaxKind::ArrowFunction
                                | SyntaxKind::ClassDeclaration
                                | SyntaxKind::ClassExpression
                        )
                    {
                        return false;
                    }
                    if node.kind() == SyntaxKind::BinaryExpression
                        && node.operator_token().kind() == SyntaxKind::EqualsToken
                    {
                        let left = node.left();
                        let right = receivers::reference_node(node.right());
                        let source_symbol = (right.kind() == SyntaxKind::Identifier)
                            .then(|| lowerer.symbol(right))
                            .unwrap_or(0);
                        if left.kind() == SyntaxKind::PropertyAccessExpression
                            && left.expression().kind() == SyntaxKind::ThisKeyword
                            && left.name().text() == name
                            && source_symbol != 0
                            && lowerer.data_bindings.contains(&source_symbol)
                        {
                            return true;
                        }
                        // `this.cache = new LRUCache()` into a field declared
                        // with a structural interface: keep the class
                        // instance (identity, getters, methods) as its owning
                        // value instead of copying it into a record view.
                        if left.kind() == SyntaxKind::PropertyAccessExpression
                            && left.expression().kind() == SyntaxKind::ThisKeyword
                            && left.name().text() == name
                            && right.kind() == SyntaxKind::NewExpression
                            && lowerer.class_symbol(right.expression()).is_some()
                        {
                            let declared = lowerer.checker.get_type_at_location(left);
                            let structural = match lowerer.type_id(declared) {
                                Some(Type::Record { .. }) => true,
                                Some(Type::Union { union_id }) => lowerer.unions[union_id]
                                    .arms
                                    .iter()
                                    .any(|arm| matches!(arm, Type::Record { .. })),
                                _ => false,
                            };
                            if structural {
                                return true;
                            }
                        }
                    }
                    let mut found = false;
                    node.for_each_child(&mut |child| {
                        found |= assigned_dynamic_parameter(lowerer, child, name);
                        found
                    });
                    found
                }
                // `this.field = new Class()` into an interface-typed field can
                // happen in any instance member (lazy getters included).
                fn assigned_class_instance(lowerer: &mut Lowerer<'_>, node: Node, name: &str) -> bool {
                    if node.is_nil()
                        || matches!(
                            node.kind(),
                            SyntaxKind::FunctionDeclaration
                                | SyntaxKind::FunctionExpression
                                | SyntaxKind::ClassDeclaration
                                | SyntaxKind::ClassExpression
                        )
                    {
                        return false;
                    }
                    if node.kind() == SyntaxKind::BinaryExpression
                        && node.operator_token().kind() == SyntaxKind::EqualsToken
                    {
                        let left = node.left();
                        let right = receivers::reference_node(node.right());
                        if left.kind() == SyntaxKind::PropertyAccessExpression
                            && left.expression().kind() == SyntaxKind::ThisKeyword
                            && left.name().text() == name
                            && right.kind() == SyntaxKind::NewExpression
                            && lowerer.class_symbol(right.expression()).is_some()
                        {
                            let declared = lowerer.checker.get_type_at_location(left);
                            let structural = match lowerer.type_id(declared) {
                                Some(Type::Record { .. }) => true,
                                Some(Type::Union { union_id }) => lowerer.unions[union_id]
                                    .arms
                                    .iter()
                                    .any(|arm| matches!(arm, Type::Record { .. })),
                                _ => false,
                            };
                            if structural {
                                return true;
                            }
                        }
                    }
                    let mut found = false;
                    node.for_each_child(&mut |child| {
                        found |= assigned_class_instance(lowerer, child, name);
                        found
                    });
                    found
                }
                definition
                    .node
                    .members()
                    .into_iter()
                    .filter(|member| member.kind() == SyntaxKind::Constructor)
                    .any(|constructor| assigned_dynamic_parameter(self, constructor.body(), &name))
                    || definition.node.members().into_iter().any(|member| {
                        matches!(
                            member.kind(),
                            SyntaxKind::MethodDeclaration
                                | SyntaxKind::GetAccessor
                                | SyntaxKind::SetAccessor
                        ) && !member.modifier_flags().intersects(ModifierFlags::STATIC)
                            && assigned_class_instance(self, member.body(), &name)
                    })
            } else {
                false
            };
            let planned_assignment = if parameter_abi::is_javascript(definition.node)
                && field.kind() == SyntaxKind::PropertyDeclaration
                && field.initializer().is_nil()
            {
                let mut assigned_from = None;
                let mut compatible = true;
                for constructor in definition
                    .node
                    .members()
                    .into_iter()
                    .filter(|member| member.kind() == SyntaxKind::Constructor)
                {
                    for statement in constructor.body().statements() {
                        if statement.kind() != SyntaxKind::ExpressionStatement {
                            continue;
                        }
                        let assignment = statement.expression();
                        if assignment.kind() != SyntaxKind::BinaryExpression
                            || assignment.operator_token().kind() != SyntaxKind::EqualsToken
                        {
                            continue;
                        }
                        let left = assignment.left();
                        let right = assignment.right();
                        if left.kind() == SyntaxKind::PropertyAccessExpression
                            && left.expression().kind() == SyntaxKind::ThisKeyword
                            && left.name().text() == name
                        {
                            let Some(candidate) = self.planned_argument_type(right) else {
                                compatible = false;
                                break;
                            };
                            if assigned_from
                                .as_ref()
                                .is_some_and(|current| *current != candidate)
                            {
                                compatible = false;
                                break;
                            }
                            assigned_from = Some(candidate);
                        }
                    }
                    if !compatible {
                        break;
                    }
                }
                compatible.then_some(assigned_from).flatten()
            } else if parameter_abi::is_javascript(definition.node)
                && field.kind() == SyntaxKind::PropertyDeclaration
                && matches!(
                    field.initializer().kind(),
                    SyntaxKind::NullKeyword | SyntaxKind::Identifier
                )
                && (field.initializer().kind() == SyntaxKind::NullKeyword
                    || (field.initializer().text() == "undefined"
                        && self.symbol(field.initializer()) == 0))
            {
                fn writes(node: Node, name: &str, values: &mut Vec<Node>) {
                    if matches!(
                        node.kind(),
                        SyntaxKind::FunctionDeclaration
                            | SyntaxKind::FunctionExpression
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
                            && left.name().text() == name
                        {
                            values.push(node.right());
                        }
                    }
                    node.for_each_child(&mut |child| {
                        writes(child, name, values);
                        false
                    });
                }
                let mut writes_to_field = Vec::new();
                for member in definition.node.members() {
                    if matches!(
                        member.kind(),
                        SyntaxKind::Constructor
                            | SyntaxKind::MethodDeclaration
                            | SyntaxKind::GetAccessor
                            | SyntaxKind::SetAccessor
                    ) && !member.body().is_nil()
                    {
                        writes(member.body(), &name, &mut writes_to_field);
                    }
                }
                let mut arms = vec![if field.initializer().kind() == SyntaxKind::NullKeyword {
                    Type::Null
                } else {
                    Type::Undefined
                }];
                let mut compatible = !writes_to_field.is_empty();
                for value in writes_to_field {
                    let candidate = self
                        .planned_argument_type(value)
                        .or_else(|| self.ty(value).ok());
                    let Some(candidate) = candidate else {
                        compatible = false;
                        break;
                    };
                    match candidate {
                        Type::Union { union_id } => arms.extend(self.unions[union_id].arms.clone()),
                        candidate => arms.push(candidate),
                    }
                }
                compatible.then(|| self.intern_union(arms)).flatten()
            } else if parameter_abi::is_javascript(definition.node)
                && field.kind() == SyntaxKind::PropertyAccessExpression
                && assignment.kind() == SyntaxKind::BinaryExpression
                && assignment.operator_token().kind() == SyntaxKind::EqualsToken
            {
                let right = assignment.right();
                if right.kind() == SyntaxKind::Identifier {
                    let symbol = self.symbol(right);
                    self.js_parameter_types.get(&symbol).cloned()
                } else if right.kind() == SyntaxKind::CallExpression
                    && right.expression().kind() == SyntaxKind::PropertyAccessExpression
                    && right.expression().name().text() == "map"
                    && right.expression().expression().kind()
                        == SyntaxKind::PropertyAccessExpression
                    && right.expression().expression().expression().kind()
                        == SyntaxKind::ThisKeyword
                    && layout.fields.iter().any(|slot| {
                        slot.name == right.expression().expression().name().text()
                            && match &slot.r#type {
                                Type::Array { .. } => true,
                                Type::Union { union_id } => self.unions[*union_id]
                                    .arms
                                    .iter()
                                    .any(|arm| matches!(arm, Type::Array { .. })),
                                _ => false,
                            }
                    })
                {
                    let callback = right.arguments().get(0);
                    let body = callback.body();
                    let result = if body.kind() == SyntaxKind::Block {
                        body.statements()
                            .into_iter()
                            .find(|statement| statement.kind() == SyntaxKind::ReturnStatement)
                            .map(|statement| statement.expression())
                    } else if !body.is_nil() {
                        Some(body)
                    } else {
                        None
                    };
                    result
                        .and_then(|result| self.ty(result).ok())
                        .map(|elem| Type::Array {
                            elem: Box::new(elem),
                        })
                } else {
                    None
                }
            } else {
                None
            };
            let ty = if dynamic_parameter_assignment {
                // The constructor parameter owns a class instance forwarded
                // through a structural interface. Store that same NativeValue
                // in the field; a record slot would copy or reject the class.
                Type::Dyn
            } else if error && matches!(name.as_str(), "name" | "message") {
                Type::Dyn
            } else if let Some(ty) = planned_assignment
                .as_ref()
                .filter(|ty| **ty != Type::Dyn)
                .cloned()
            {
                // Closed-world constructor calls can give an otherwise-`any`
                // JavaScript parameter a stable ABI. A direct `this.x = p`
                // assignment owns that same layout; retaining the checker's
                // erased field would discard array/container operations in
                // every method that subsequently reads `this.x`.
                ty
            } else if let Some((_, ty)) = contract
                .as_ref()
                .and_then(|c| c.fields.iter().find(|(n, _)| *n == name))
            {
                ty.clone().ok_or_else(|| {
                    self.refuse(field, "public class field has no native representation")
                })?
            } else if let Some(ty) = planned_assignment {
                ty
            } else if field.kind() == SyntaxKind::PropertyAccessExpression
                && field.parent().kind() == SyntaxKind::BinaryExpression
                && field.parent().operator_token().kind() == SyntaxKind::EqualsToken
                && self.classes.method(index, &name).is_some()
                && (|| {
                    let call = field.parent().right();
                    if call.kind() != SyntaxKind::CallExpression {
                        return false;
                    }
                    let bind = call.expression();
                    if bind.kind() != SyntaxKind::PropertyAccessExpression {
                        return false;
                    }
                    let method = bind.expression();
                    bind.name().text() == "bind"
                        && method.kind() == SyntaxKind::PropertyAccessExpression
                        && method.expression().kind() == SyntaxKind::ThisKeyword
                        && method.name().text() == name
                        && matches!(
                            call.arguments().into_iter().collect::<Vec<_>>().as_slice(),
                            [argument] if argument.kind() == SyntaxKind::ThisKeyword
                        )
                })()
            {
                // A constructor's own bound-method slot has a live callable
                // identity. It need not inherit the checker's potentially
                // unrepresentable inferred return union as a fixed field ABI.
                Type::Dyn
            } else {
                match self.ty(field.name()) {
                    Ok(ty) => ty,
                    Err(error) => self.class_callback_type(field.name()).ok_or(error)?,
                }
            };
            let ty = if error && matches!(name.as_str(), "name" | "message") {
                ty
            } else {
                if error && matches!(ty, Type::Func { .. }) {
                    return Err(self.refuse(field, "class field type is not ported"));
                }
                // Unit-only fields still define an enumerable own property in
                // JavaScript, but a unit has no standalone Rust storage slot.
                // Give that slot an unreachable numeric payload arm, exactly
                // like an uninitialized local, so the active tag remains the
                // source `undefined`/`null` value and field presence survives.
                let mut arms = match ty {
                    Type::Void | Type::Undefined => {
                        let Type::Union { union_id } =
                            self.undefined_storage_type(Type::F64, field)?
                        else {
                            unreachable!("undefined class field storage")
                        };
                        self.unions[union_id].arms.clone()
                    }
                    Type::Null => vec![Type::F64, Type::Null],
                    Type::Union { union_id } => self.unions[union_id].arms.clone(),
                    ty => vec![ty],
                };
                arms.push(Type::Undefined);
                self.intern_union(arms).ok_or_else(|| {
                    self.refuse(field, "class field has no undefined representation")
                })?
            };
            if let Some(inherited) = layout.fields.iter().find(|f| f.name == name) {
                if inherited.r#type != ty {
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
                ) && !member.modifier_flags().intersects(ModifierFlags::STATIC)
                    && !matches!(
                        member.name().kind(),
                        SyntaxKind::ComputedPropertyName | SyntaxKind::PrivateIdentifier
                    )
            })
            .map(|member| member.name().text().to_string())
            .collect();
        let mut seen = HashSet::new();
        layout.method_names.retain(|name| seen.insert(name.clone()));
        for member in definition.node.members() {
            if matches!(
                member.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
            ) && member.name().kind() == SyntaxKind::ComputedPropertyName
                && !member.modifier_flags().intersects(ModifierFlags::STATIC)
            {
                let key_node = member.name().expression();
                let Some(key) = self.class_symbol_key(key_node) else {
                    return Err(self.refuse(
                        member,
                        &format!(
                            "computed class symbol method key has no stable native identity: {}",
                            key_node.text()
                        ),
                    ));
                };
                // Repeated definitions replace the descriptor without changing its key.
                if !layout.symbol_methods.iter().any(|method| method.key == key) {
                    layout.symbol_methods.push(ir::SymbolMethod {
                        key,
                        getter: member.kind() == SyntaxKind::GetAccessor,
                        function: None,
                    });
                }
            }
        }
        self.classes.layouts[index] = Some(layout);
        Ok(())
    }

    /// Register the native TextEncoder/TextDecoder class (`name`).
    pub(super) fn codec_class(&mut self, name: &str) -> usize {
        let name = name.to_string();
        let ir_name = format!("native_builtin_{name}");
        self
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
                        captures: Vec::new(),
                    });
                    self.classes.layouts.push(Some(ir::Class {
                        name: ir_name,
                        js_name: name.clone(),
                        runtime: false,
                        base: None,
                        fields: if name == "TextDecoder" {
                            vec![
                                ir::Field {
                                    name: codecs::TEXT_DECODER_FATAL.into(),
                                    r#type: Type::Dyn,
                                },
                                ir::Field {
                                    name: codecs::TEXT_DECODER_HANDLE.into(),
                                    r#type: Type::Dyn,
                                },
                                ir::Field {
                                    name: codecs::TEXT_DECODER_ENCODING.into(),
                                    r#type: Type::Dyn,
                                },
                            ]
                        } else {
                            vec![]
                        },
                        captures: vec![],
                        methods: vec![],
                        symbol_methods: vec![],
                        symbol_brand: None,
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
                })
    }

    /// An interface that a class `implements` can hold that class's
    /// instances, whose identity, methods and accessors a closed record view
    /// cannot carry. Represent such interface types by the owning value.
    pub(in crate::frontend) fn inventory_implemented_interfaces(&mut self, files: &[Node]) {
        fn visit(lowerer: &mut Lowerer<'_>, node: Node) {
            if matches!(
                node.kind(),
                SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
            ) {
                for clause in node.heritage_clauses().nodes() {
                    if clause.token() != SyntaxKind::ImplementsKeyword {
                        continue;
                    }
                    for reference in clause.types().nodes() {
                        let checked = lowerer.checker.get_type_at_location(reference);
                        lowerer.data_types.insert(checked);
                        let symbol = lowerer.checker.ty(checked).symbol();
                        if symbol.0 != 0 {
                            let declared = lowerer.checker.get_declared_type_of_symbol(symbol);
                            lowerer.data_types.insert(declared);
                        }
                    }
                }
            }
            // `new (...) => Like`: instances reach the annotation from a
            // runtime constructor value, so `Like` holds owning instances.
            if node.kind() == SyntaxKind::ConstructorType {
                let constructor = lowerer.checker.get_type_from_type_node_exported(node);
                for signature in lowerer.checker.get_signatures_of_type(
                    constructor,
                    source_frontend::prelude::SignatureKind::CONSTRUCT,
                ) {
                    let instance = lowerer.checker.get_return_type_of_signature(signature);
                    lowerer.data_types.insert(instance);
                }
            }
            node.for_each_child(&mut |child| {
                visit(lowerer, child);
                false
            });
        }
        for file in files {
            visit(self, *file);
        }
    }

    /// The declaration catalog projects types in its own lowerer and hands
    /// back records/unions, not its class registry. Register every builtin
    /// class those adopted layouts name so their nominal layouts exist here.
    pub(super) fn register_referenced_builtin_classes(&mut self, site: Node) {
        let mut names = std::collections::BTreeSet::new();
        let mut stack = self
            .records
            .iter()
            .flat_map(|record| record.fields.iter().map(|field| field.r#type.clone()))
            .chain(self.unions.iter().flat_map(|union| union.arms.iter().cloned()))
            .collect::<Vec<_>>();
        let mut seen = HashSet::new();
        while let Some(ty) = stack.pop() {
            if !seen.insert(ty.clone()) {
                continue;
            }
            match ty {
                Type::Object { class_name } => {
                    names.insert(class_name);
                }
                Type::Func { params, ret, .. } => {
                    stack.extend(params);
                    stack.push(*ret);
                }
                Type::Array { elem } | Type::Set { elem } | Type::Promise { inner: elem } => {
                    stack.push(*elem)
                }
                Type::Map { key, value } => {
                    stack.push(*key);
                    stack.push(*value);
                }
                _ => {}
            }
        }
        for name in names {
            if self.classes.definition_index_for_name(&name).is_some() {
                continue;
            }
            match name.as_str() {
                dom_events::CLASS => {
                    self.dom_event_class(site);
                }
                dom_events::TARGET_CLASS => {
                    self.event_target_class(site);
                }
                event_emitters::CLASS => {
                    self.event_emitter_class(site);
                }
                node_streams::DUPLEX => {
                    self.node_duplex_class(site);
                }
                node_streams::TRANSFORM => {
                    self.node_transform_class(site);
                }
                node_streams::READABLE => {
                    self.node_readable_class(site);
                }
                node_streams::WRITABLE => {
                    self.node_writable_class(site);
                }
                "native_builtin_TextEncoder" => {
                    self.codec_class("TextEncoder");
                }
                "native_builtin_TextDecoder" => {
                    self.codec_class("TextDecoder");
                }
                _ => {}
            }
        }
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
                if self.classes.layout_active.is_empty() {
                    self.layout_class(index).ok()?;
                } else if !self.classes.layout_deferred.contains(&index) {
                    self.classes.layout_deferred.push_back(index);
                }
            }
            return Some(Type::Classval {
                class_name: self.classes.definitions[index].name.clone(),
            });
        }
        if self.classes.layout_active.contains(&index) {
            return Some(self.classes.object(index));
        }
        if self.classes.layout_active.is_empty() {
            self.layout_class(index).ok()?;
        } else if !self.classes.layout_deferred.contains(&index) {
            self.classes.layout_deferred.push_back(index);
        }
        Some(self.classes.object(index))
    }
}

mod accessors;
mod async_resources;
mod boxed;
mod brand;
mod constructors;
mod dom_events;
mod event_emitters;
mod methods;
mod node_console;
mod node_streams;
mod private_slots;
mod static_methods;
mod symbol_methods;
mod values;
pub(super) mod weak_sets;
