//! Record arrays reserve field absence before owned layouts exist.
use super::*;
use source_frontend::{flags::ContextFlags, prelude::SymbolId};

struct Owner {
    element: TypeId,
    records: Vec<Node>,
    types: HashSet<TypeId>,
}

fn collect(node: Node, declarations: &mut Vec<Node>, calls: &mut Vec<Node>) {
    if node.kind() == SyntaxKind::VariableDeclaration {
        declarations.push(node);
    }
    if node.kind() == SyntaxKind::CallExpression {
        calls.push(node);
    }
    node.for_each_child(&mut |child| {
        collect(child, declarations, calls);
        false
    });
}

impl Lowerer<'_> {
    pub(super) fn plan_value_layouts(&mut self, files: &[Node]) {
        let owners = self.container_owners(files);
        loop {
            let before = (
                self.js_absence_parameters.len(),
                self.js_absent_fields.len(),
                self.absence_returns.len(),
                self.absence_assignments.len(),
            );
            self.plan_parameter_abi(files);
            self.solve_container_abi(&owners);
            if before
                == (
                    self.js_absence_parameters.len(),
                    self.js_absent_fields.len(),
                    self.absence_returns.len(),
                    self.absence_assignments.len(),
                )
            {
                break;
            }
        }
    }

    fn container_owners(&mut self, files: &[Node]) -> Vec<Owner> {
        let mut declarations = Vec::new();
        let mut calls = Vec::new();
        for file in files {
            collect(*file, &mut declarations, &mut calls);
        }
        let mut owners = HashMap::new();
        for declaration in declarations {
            let javascript = parameter_abi::is_javascript(declaration);
            if declaration.name().kind() != SyntaxKind::Identifier
                || (javascript && !declaration.type_().is_nil())
                || (!javascript && declaration.type_().is_nil())
                || self.declared(declaration).is_some()
                || declaration.initializer().is_nil()
            {
                continue;
            }
            let initial = receivers::reference_node(declaration.initializer());
            if initial.kind() != SyntaxKind::ArrayLiteralExpression
                || (javascript
                    && self
                        .checker
                        .get_contextual_type(initial, ContextFlags::NONE)
                        .0
                        != 0)
            {
                continue;
            }
            let array = self.checker.get_type_at_location(declaration.name());
            if !self.checker.is_array_type(array) {
                continue;
            }
            let element = self.checker.get_element_type_of_array_type(array);
            if !self.checker.ty(element).flags.intersects(TypeFlags::OBJECT)
                || !self.checker.get_index_infos_of_type(element).is_empty()
            {
                continue;
            }
            let mut owner = Owner {
                element,
                records: Vec::new(),
                types: HashSet::from([element]),
            };
            for seed in initial.elements() {
                self.container_record(seed, &mut owner, &mut HashSet::new());
            }
            if !owner.records.is_empty() || !javascript {
                owners.insert(self.symbol(declaration.name()), owner);
            }
        }
        if owners.is_empty() {
            return Vec::new();
        }
        for call in calls {
            let member = call.expression();
            if member.kind() != SyntaxKind::PropertyAccessExpression
                || member.name().text() != "push"
            {
                continue;
            }
            let symbol = self.container_owner(member.expression(), &mut HashSet::new());
            if let Some(owner) = owners.get_mut(&symbol) {
                for argument in call.arguments() {
                    self.container_record(argument, owner, &mut HashSet::new());
                }
            }
        }
        owners.into_values().collect()
    }

    fn solve_container_abi(&mut self, owners: &[Owner]) {
        // Shared record sources connect owners. Join all demands without
        // changing an already published native layout or copying an owner.
        loop {
            let before = self.js_absent_fields.len();
            for owner in owners {
                let fields = self.checker.get_properties_of_type(owner.element).to_vec();
                for field in fields {
                    let name = self.checker.sym(field).name.to_string();
                    let source = self.checker.get_type_of_symbol(field);
                    if self.primitive_type(self.checker.ty(source).flags).is_none() {
                        continue;
                    }
                    let mut absent = owner
                        .types
                        .iter()
                        .any(|id| self.js_absent_fields.contains(&(*id, name.clone())));
                    for record in &owner.records {
                        let mut present = false;
                        for property in record.properties() {
                            if self.data_property_name(property.name()).as_deref() != Some(&name) {
                                continue;
                            }
                            present = true;
                            let value =
                                if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                                    property.name()
                                } else {
                                    property.initializer()
                                };
                            absent |= self.argument_may_be_absent(value, &mut HashSet::new());
                        }
                        absent |= !present;
                    }
                    if absent {
                        for id in &owner.types {
                            self.js_absent_fields.insert((*id, name.clone()));
                        }
                    }
                }
            }
            if before == self.js_absent_fields.len() {
                break;
            }
        }
    }

    fn container_owner(&mut self, node: Node, seen: &mut HashSet<u32>) -> u32 {
        let node = receivers::reference_node(node);
        if node.kind() != SyntaxKind::Identifier {
            return 0;
        }
        let symbol = self.symbol(node);
        if symbol == 0 || !seen.insert(symbol) {
            return 0;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && !declaration.initializer().is_nil()
            && declaration.type_().is_nil()
            && self.declared(declaration).is_none()
            && declaration.parent().flags().intersects(NodeFlags::CONST)
        {
            let initial = receivers::reference_node(declaration.initializer());
            if initial.kind() == SyntaxKind::Identifier {
                return self.container_owner(initial, seen);
            }
        }
        symbol
    }

    fn container_record(&mut self, node: Node, owner: &mut Owner, seen: &mut HashSet<u32>) {
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if symbol == 0 || !seen.insert(symbol) {
                return;
            }
            let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
            if declaration.is_nil()
                || declaration.kind() != SyntaxKind::VariableDeclaration
                || declaration.initializer().is_nil()
                || !declaration.type_().is_nil()
                || self.declared(declaration).is_some()
                || !parameter_abi::is_javascript(declaration)
                || self
                    .checker
                    .get_contextual_type(declaration.initializer(), ContextFlags::NONE)
                    .0
                    != 0
            {
                return;
            }
            let count = owner.records.len();
            self.container_record(declaration.initializer(), owner, seen);
            if count != owner.records.len() {
                owner
                    .types
                    .insert(self.checker.get_type_of_symbol(SymbolId(symbol)));
            }
            return;
        }
        if node.kind() != SyntaxKind::ObjectLiteralExpression {
            return;
        }
        if node.properties().into_iter().any(|p| {
            !matches!(
                p.kind(),
                SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
            ) || self.data_property_name(p.name()).is_none()
        }) {
            return;
        }
        owner.types.insert(self.checker.get_type_at_location(node));
        owner.records.push(node);
    }

    pub(super) fn planned_field_read(&mut self, node: Node) -> bool {
        let name = match node.kind() {
            SyntaxKind::PropertyAccessExpression => node.name().text().to_string(),
            SyntaxKind::ElementAccessExpression => {
                let Some(name) = self.literal_property_key(node.argument_expression()) else {
                    return false;
                };
                name
            }
            _ => return false,
        };
        let receiver = receivers::reference_node(node.expression());
        let ty = self.checker.get_type_at_location(receiver);
        if self.js_absent_fields.contains(&(ty, name.clone())) {
            return true;
        }
        if receiver.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(receiver);
            if symbol != 0 {
                let ty = self.checker.get_type_of_symbol(SymbolId(symbol));
                return self.js_absent_fields.contains(&(ty, name));
            }
        }
        false
    }
}
