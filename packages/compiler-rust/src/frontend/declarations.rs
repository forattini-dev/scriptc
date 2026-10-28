//! Portable contracts between the checked declaration graph and JS execution
//! graph. No checker IDs or AST nodes survive the program-version boundary.
use super::*;
use source_frontend::prelude::{SignatureKind, SymbolId, get_source_file_of_node};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Key {
    file: String,
    start: i32,
    end: i32,
}

impl Key {
    pub(super) fn of(node: Node) -> Self {
        Self {
            file: source_file_info(get_source_file_of_node(node))
                .file_name
                .to_string(),
            start: node.pos(),
            end: node.end(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ClassHint {
    pub params: Vec<Option<Type>>,
    pub fields: Vec<(String, Option<Type>)>,
    pub methods: Vec<(String, Option<Type>)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Hint {
    pub rest: bool,
    pub params: Vec<Option<Type>>,
    pub ret: Option<Type>,
    pub reason: Option<String>,
    pub value_type: Option<Type>,
    pub class: Option<ClassHint>,
}

impl Hint {
    pub(super) fn function_type(&self) -> Option<Type> {
        if self.reason.is_some() {
            return None;
        }
        Some(Type::Func {
            rest: self.rest,
            params: self.params.iter().cloned().collect::<Option<Vec<_>>>()?,
            ret: Box::new(self.ret.clone()?),
        })
    }
}

struct Edge {
    importer: String,
    specifier: String,
    target: String,
}
pub(super) struct MemberDemands {
    edges: Vec<Edge>,
    files: Vec<String>,
    objects: HashMap<(String, String), HashSet<String>>,
}
struct Export {
    file: String,
    name: String,
    hint: Hint,
}
struct MemberExport {
    file: String,
    name: String,
    member: String,
    signature: Type,
}
pub(super) struct Catalog {
    edges: Vec<Edge>,
    exports: Vec<Export>,
    members: Vec<MemberExport>,
    records: Vec<ir::Record>,
    unions: Vec<ir::Union>,
    callables: HashMap<usize, Type>,
    projections: HashMap<Key, Type>,
    literal_choices: HashMap<Key, Type>,
}
pub(super) struct Linked {
    pub hints: HashMap<Key, Hint>,
    pub records: Vec<ir::Record>,
    pub unions: Vec<ir::Union>,
    pub callables: HashMap<usize, Type>,
    pub projections: HashMap<Key, Type>,
    pub literal_choices: HashMap<Key, Type>,
}

fn unalias(checker: &mut Checker, symbol: SymbolId) -> SymbolId {
    if symbol.0 != 0 && checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
        checker.get_aliased_symbol(symbol)
    } else {
        symbol
    }
}

fn edges(checker: &mut Checker, files: &[Node]) -> Vec<Edge> {
    let mut edges = Vec::new();
    for file in files {
        for node in file.statements() {
            let Some(specifier) = modules::runtime_specifier(node) else {
                continue;
            };
            if builtins::module(specifier.text()).is_some() {
                continue;
            }
            let symbol = checker.get_symbol_at_location(specifier, false);
            let symbol = unalias(checker, symbol);
            if symbol.0 == 0 {
                continue;
            }
            let target = checker.sym(symbol).value_declaration;
            if target.is_nil() || target.kind() != SyntaxKind::SourceFile {
                continue;
            }
            edges.push(Edge {
                importer: source_file_info(*file).file_name.to_string(),
                specifier: specifier.text().to_string(),
                target: source_file_info(target).file_name.to_string(),
            });
        }
    }
    edges
}

// Discover only source-owned direct object methods while the execution graph
// is current. Paths and export/member names survive the checker version change;
// nodes, symbols and checker type IDs never cross it.
pub(super) fn member_demands(source: &str) -> Result<MemberDemands, String> {
    let files = program::source_files();
    let entry = files
        .iter()
        .copied()
        .find(|file| source_file_info(*file).file_name == source)
        .ok_or("SCN0002: missing execution entry for object method contracts")?;
    Ok(program::with_type_checker_for_file(entry, move |checker| {
        let mut objects = HashMap::new();
        for file in &files {
            let path = source_file_info(*file).file_name.to_string();
            if !is_javascript(&path) || file.symbol().0 == 0 {
                continue;
            }
            for exported in checker.get_exports_of_module_as_array(file.symbol()) {
                let name = checker.sym(exported).name.to_string();
                let symbol = unalias(checker, exported);
                if symbol.0 == 0 {
                    continue;
                }
                let declaration = checker.sym(symbol).value_declaration;
                if declaration.is_nil()
                    || declaration.kind() != SyntaxKind::VariableDeclaration
                    || declaration.initializer().is_nil()
                {
                    continue;
                }
                let object = receivers::reference_node(declaration.initializer());
                if object.kind() != SyntaxKind::ObjectLiteralExpression
                    || object
                        .properties()
                        .into_iter()
                        .any(|p| p.kind() == SyntaxKind::SpreadAssignment)
                {
                    continue;
                }
                let mut methods = HashSet::new();
                let mut counts: HashMap<String, usize> = HashMap::new();
                for property in object.properties() {
                    if matches!(
                        property.kind(),
                        SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                    ) && matches!(
                        property.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    ) {
                        *counts
                            .entry(property.name().text().to_string())
                            .or_default() += 1;
                    }
                }
                for property in object.properties() {
                    if !matches!(
                        property.kind(),
                        SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                    ) || !matches!(
                        property.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    ) {
                        continue;
                    }
                    let member = property.name().text().to_string();
                    if counts.get(&member) != Some(&1) {
                        continue;
                    }
                    let function = if property.kind() == SyntaxKind::MethodDeclaration {
                        property
                    } else {
                        receivers::reference_node(property.initializer())
                    };
                    if matches!(
                        function.kind(),
                        SyntaxKind::MethodDeclaration
                            | SyntaxKind::ArrowFunction
                            | SyntaxKind::FunctionExpression
                    ) {
                        methods.insert(member);
                    }
                }
                if !methods.is_empty() {
                    objects.insert((path.clone(), name), methods);
                }
            }
        }
        MemberDemands {
            edges: edges(checker, &files),
            files: files
                .iter()
                .map(|f| source_file_info(*f).file_name.to_string())
                .collect(),
            objects,
        }
    }))
}

fn paired_paths(
    checked: &[Edge],
    execution: &[Edge],
    files: &[String],
) -> HashSet<(String, String)> {
    let checked_files = checked
        .iter()
        .flat_map(|edge| [&edge.importer, &edge.target])
        .collect::<HashSet<_>>();
    let mut pairs = files
        .iter()
        .filter_map(|name| {
            checked_files
                .contains(name)
                .then_some((name.clone(), name.clone()))
        })
        .collect::<HashSet<_>>();
    let mut checked_by_file: HashMap<&str, Vec<&Edge>> = HashMap::new();
    for edge in checked {
        checked_by_file
            .entry(&edge.importer)
            .or_default()
            .push(edge);
    }
    let mut runtime_by_import: HashMap<(&str, &str), Vec<&str>> = HashMap::new();
    for edge in execution {
        runtime_by_import
            .entry((&edge.importer, &edge.specifier))
            .or_default()
            .push(&edge.target);
    }
    let mut pending = pairs.iter().cloned().collect::<Vec<_>>();
    while let Some((checked_file, runtime)) = pending.pop() {
        for edge in checked_by_file
            .get(checked_file.as_str())
            .into_iter()
            .flatten()
        {
            if let Some(targets) =
                runtime_by_import.get(&(runtime.as_str(), edge.specifier.as_str()))
            {
                for target in targets {
                    let pair = (edge.target.clone(), (*target).to_string());
                    if pairs.insert(pair.clone()) {
                        pending.push(pair);
                    }
                }
            }
        }
    }
    pairs
}

pub(super) fn snapshot(
    source: &str,
    console_prelude: Option<String>,
    demands: MemberDemands,
) -> Result<Catalog, String> {
    let files = program::source_files();
    let entry = files
        .iter()
        .copied()
        .find(|f| source_file_info(*f).file_name == source)
        .ok_or("SCN0002: missing checked entry")?;
    let source = source.to_string();
    Ok(program::with_type_checker_for_file(entry, move |checker| {
        let edges = edges(checker, &files);
        let pairs = paired_paths(&edges, &demands.edges, &demands.files);
        let mut needed: HashMap<(String, String), HashSet<String>> = HashMap::new();
        for (checked, runtime) in pairs {
            for ((path, name), members) in &demands.objects {
                if *path == runtime {
                    needed
                        .entry((checked.clone(), name.clone()))
                        .or_default()
                        .extend(members.iter().cloned());
                }
            }
        }
        // Follow actual non-builtin imports/reexports. Bundled/global type
        // libraries aren't runtime modules and must not seed contract tables.
        let mut reachable = files
            .iter()
            .filter_map(|f| {
                let name = source_file_info(*f).file_name.to_string();
                (!is_declaration(&name)).then_some(name)
            })
            .collect::<HashSet<_>>();
        loop {
            let mut changed = false;
            for edge in &edges {
                if reachable.contains(&edge.importer) {
                    changed |= reachable.insert(edge.target.clone());
                }
            }
            if !changed {
                break;
            }
        }
        let mut lowerer = Lowerer::new(checker, source, console_prelude);
        lowerer.declaration_abi = true;
        let mut exports = Vec::new();
        let mut members = Vec::new();
        for file in &files {
            let file = *file;
            let path = source_file_info(file).file_name.to_string();
            if !is_declaration(&path) || !reachable.contains(&path) || file.symbol().0 == 0 {
                continue;
            }
            for exported in lowerer
                .checker
                .get_exports_of_module_as_array(file.symbol())
            {
                let name = lowerer.checker.sym(exported).name.to_string();
                let symbol = unalias(lowerer.checker, exported);
                if symbol.0 == 0 {
                    continue;
                }
                let ty = lowerer.checker.get_type_of_symbol(symbol);
                let signatures = lowerer
                    .checker
                    .get_signatures_of_type(ty, SignatureKind::CALL);
                let constructors = lowerer
                    .checker
                    .get_signatures_of_type(ty, SignatureKind::CONSTRUCT);
                let mut hint = Hint {
                    rest: false,
                    params: vec![],
                    ret: None,
                    reason: None,
                    value_type: None,
                    class: None,
                };
                if constructors.len() == 1 {
                    let signature = constructors[0];
                    // A polymorphic declaration has one implementation ABI.
                    // Keep its payloads in owning native slots, just as for
                    // generic exported functions, rather than specializing
                    // the implementation to one consumer's type arguments.
                    let erased = !lowerer.checker.sig(signature).type_parameters.is_empty();
                    let parameters = lowerer.checker.sig(signature).parameters.clone();
                    let params = parameters
                        .into_iter()
                        .map(|p| {
                            if erased {
                                return Some(Type::Dyn);
                            }
                            let id = lowerer.checker.get_type_of_symbol(p);
                            lowerer.type_id(id)
                        })
                        .collect();
                    let instance = lowerer.checker.get_return_type_of_signature(signature);
                    let properties = lowerer.checker.get_properties_of_type(instance).to_vec();
                    let mut fields = Vec::new();
                    let mut methods = Vec::new();
                    for property in properties {
                        let info = lowerer.checker.sym(property);
                        let name = info.name.to_string();
                        if info.flags.intersects(SymbolFlags::METHOD) {
                            let id = lowerer.checker.get_type_of_symbol(property);
                            let signature = lowerer.function_type(id);
                            methods.push((name, signature));
                            continue;
                        }
                        // Public accessors carry a property contract too. The
                        // execution graph decides whether it is storage or a
                        // receiver-explicit getter/setter call.
                        let id = lowerer.checker.get_type_of_symbol(property);
                        fields.push((
                            name,
                            if erased {
                                Some(Type::Dyn)
                            } else {
                                lowerer.type_id(id)
                            },
                        ));
                    }
                    hint.class = Some(ClassHint {
                        params,
                        fields,
                        methods,
                    });
                } else if !signatures.is_empty() {
                    // Polymorphic public signatures use an owned native value ABI.
                    // This preserves payloads instead of choosing an arbitrary overload.
                    if signatures.len() != 1
                        || !lowerer
                            .checker
                            .sig(signatures[0])
                            .type_parameters
                            .is_empty()
                    {
                        hint.value_type = lowerer.type_id(ty);
                        hint.params = lowerer
                            .checker
                            .sig(signatures[0])
                            .parameters
                            .iter()
                            .map(|_| Some(Type::Dyn))
                            .collect();
                        hint.ret = Some(Type::Dyn);
                    } else {
                        // Use the same signature adapter as first-class calls:
                        // a fixed tuple rest is a finite list of ABI slots.
                        if let Some(Type::Func { params, ret, rest }) = lowerer.function_type(ty) {
                            hint.rest = rest;
                            hint.params = params.into_iter().map(Some).collect();
                            hint.ret = Some(*ret);
                        } else {
                            hint.reason =
                                Some("public JavaScript signature has no fixed native ABI".into());
                        }
                        if hint.reason.is_none()
                            && !lowerer.checker.get_properties_of_type(ty).is_empty()
                        {
                            hint.value_type = lowerer.type_id(ty);
                            if hint.value_type.is_none() {
                                hint.reason = Some(
                                    "public callable properties have no native representation"
                                        .into(),
                                );
                            }
                        }
                    }
                } else {
                    let Some(wanted) = needed.get(&(path.clone(), name.clone())) else {
                        continue;
                    };
                    // A public object is not itself callable. Its method
                    // declarations still define implementation parameter ABIs.
                    // Resolve each member independently: an unrelated field
                    // with no portable layout must not erase a proven method.
                    for property in lowerer.checker.get_properties_of_type(ty).to_vec() {
                        if !wanted.contains(lowerer.checker.sym(property).name.as_ref()) {
                            continue;
                        }
                        if lowerer
                            .checker
                            .sym(property)
                            .flags
                            .intersects(SymbolFlags::ACCESSOR)
                        {
                            continue;
                        }
                        let id = lowerer.checker.get_type_of_symbol(property);
                        if let Some(signature) = lowerer.function_type(id) {
                            members.push(MemberExport {
                                file: path.clone(),
                                name: name.clone(),
                                member: lowerer.checker.sym(property).name.to_string(),
                                signature,
                            });
                        }
                    }
                    continue;
                }
                exports.push(Export {
                    file: path.clone(),
                    name,
                    hint,
                });
            }
        }
        // Preserve checked member/call projections in source consumers. JS
        // implementation inference must not replace a public field with any,
        // or erase control-flow narrowing of an optional public member.
        fn portable(
            t: &Type,
            records: &[ir::Record],
            unions: &[ir::Union],
            seen: &mut HashSet<Type>,
        ) -> bool {
            if !seen.insert(t.clone()) {
                return true;
            }
            match t {
                Type::Object { .. } | Type::Classval { .. } => false,
                Type::Func { params, ret, .. } => {
                    params.iter().all(|p| portable(p, records, unions, seen))
                        && portable(ret, records, unions, seen)
                }
                Type::Record { shape_id } => {
                    records[*shape_id]
                        .fields
                        .iter()
                        .all(|f| portable(&f.r#type, records, unions, seen))
                        && records[*shape_id]
                            .index_value
                            .as_ref()
                            .is_none_or(|t| portable(t, records, unions, seen))
                }
                Type::Union { union_id } => unions[*union_id]
                    .arms
                    .iter()
                    .all(|t| portable(t, records, unions, seen)),
                Type::Array { elem } | Type::Set { elem } => portable(elem, records, unions, seen),
                Type::Promise { inner } => portable(inner, records, unions, seen),
                Type::Map { key, value } => {
                    portable(key, records, unions, seen) && portable(value, records, unions, seen)
                }
                _ => true,
            }
        }
        fn project(lowerer: &mut Lowerer<'_>, node: Node, out: &mut HashMap<Key, Type>) {
            if !lowerer.declaration_abi
                && node.kind() == SyntaxKind::ObjectLiteralExpression
                && let Some(choice) = lowerer.contextual_union_literal(node)
                && portable(
                    &choice,
                    &lowerer.records,
                    &lowerer.unions,
                    &mut HashSet::new(),
                )
            {
                lowerer.literal_choices.insert(Key::of(node), choice);
            }
            if matches!(
                node.kind(),
                SyntaxKind::Identifier
                    | SyntaxKind::PropertyAccessExpression
                    | SyntaxKind::ElementAccessExpression
                    | SyntaxKind::CallExpression
            ) {
                let id = lowerer.checker.get_type_at_location(node);
                if lowerer.declaration_projection(id) == lowerer.declaration_abi
                    && let Some(ty) = lowerer.type_id(id)
                    && portable(&ty, &lowerer.records, &lowerer.unions, &mut HashSet::new())
                {
                    out.insert(Key::of(node), ty);
                }
            }
            node.for_each_child(&mut |child| {
                project(lowerer, child, out);
                false
            });
        }
        // Public data/callback views retain the implementation ABI. Resolve
        // concrete consumer views separately so that transport-mode cache
        // entries never erase local class or container storage.
        let mut projections = HashMap::new();
        for transport in [true, false] {
            lowerer.declaration_abi = transport;
            if !transport {
                lowerer.types = type_graph::TypeCache::default();
            }
            for file in &files {
                let path = source_file_info(*file).file_name.to_string();
                if !is_declaration(&path) && !is_javascript(&path) {
                    project(&mut lowerer, *file, &mut projections);
                }
            }
        }
        Catalog {
            projections,
            literal_choices: lowerer.literal_choices,
            edges,
            exports,
            members,
            records: lowerer.records,
            unions: lowerer.unions,
            callables: lowerer.callables,
        }
    }))
}

impl Catalog {
    pub(super) fn link(self, checker: &mut Checker) -> Linked {
        let files = program::source_files();
        let execution_edges = edges(checker, &files);
        // Resolve identical specifiers in corresponding importer modules.
        // This also handles package exports that put types and JS in wholly
        // different directories, without probing/guessing sibling filenames.
        let runtime_files = files
            .iter()
            .map(|file| source_file_info(*file).file_name.to_string())
            .collect::<Vec<_>>();
        let pairs = paired_paths(&self.edges, &execution_edges, &runtime_files);
        let mut targets = HashMap::new();
        let mut object_targets = HashMap::new();
        for file in files {
            let path = source_file_info(file).file_name.to_string();
            if !is_javascript(&path) || file.symbol().0 == 0 {
                continue;
            }
            for exported in checker.get_exports_of_module_as_array(file.symbol()) {
                let name = checker.sym(exported).name.to_string();
                let symbol = unalias(checker, exported);
                if symbol.0 == 0 {
                    continue;
                }
                let node = checker.sym(symbol).value_declaration;
                if !node.is_nil()
                    && matches!(
                        node.kind(),
                        SyntaxKind::FunctionDeclaration
                            | SyntaxKind::VariableDeclaration
                            | SyntaxKind::ClassDeclaration
                    )
                {
                    if node.kind() == SyntaxKind::VariableDeclaration
                        && !node.initializer().is_nil()
                    {
                        let initial = receivers::reference_node(node.initializer());
                        if !initial.is_nil()
                            && initial.kind() == SyntaxKind::ObjectLiteralExpression
                        {
                            object_targets.insert((path.clone(), name.clone()), initial);
                        }
                    }
                    targets.insert((path.clone(), name), Key::of(node));
                }
            }
        }
        let mut hints = HashMap::<Key, Hint>::new();
        for export in self.exports {
            for (_, runtime) in pairs.iter().filter(|(checked, _)| *checked == export.file) {
                if let Some(key) = targets.get(&(runtime.clone(), export.name.clone())) {
                    if let Some(previous) = hints.get_mut(key) {
                        if *previous != export.hint {
                            previous.reason = Some(
                                "conflicting public JavaScript contracts are not ported".into(),
                            );
                        }
                    } else {
                        hints.insert(key.clone(), export.hint.clone());
                    }
                }
            }
        }
        for member in self.members {
            for (_, runtime) in pairs.iter().filter(|(checked, _)| *checked == member.file) {
                let Some(object) = object_targets.get(&(runtime.clone(), member.name.clone()))
                else {
                    continue;
                };
                let matching = object
                    .properties()
                    .into_iter()
                    .filter(|property| {
                        matches!(
                            property.kind(),
                            SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                        ) && matches!(
                            property.name().kind(),
                            SyntaxKind::Identifier | SyntaxKind::StringLiteral
                        ) && property.name().text() == member.member
                    })
                    .collect::<Vec<_>>();
                // Duplicates/spreads require a source-order property plan.
                if matching.len() != 1
                    || object
                        .properties()
                        .into_iter()
                        .any(|p| p.kind() == SyntaxKind::SpreadAssignment)
                {
                    continue;
                }
                let property = matching[0];
                let function = if property.kind() == SyntaxKind::MethodDeclaration {
                    property
                } else {
                    receivers::reference_node(property.initializer())
                };
                if !matches!(
                    function.kind(),
                    SyntaxKind::MethodDeclaration
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::FunctionExpression
                ) {
                    continue;
                }
                let Type::Func { params, ret, rest } = &member.signature else {
                    unreachable!("member signature")
                };
                let hint = Hint {
                    rest: *rest,
                    params: params.iter().cloned().map(Some).collect(),
                    ret: Some((**ret).clone()),
                    reason: None,
                    value_type: None,
                    class: None,
                };
                let key = Key::of(function);
                if let Some(previous) = hints.get_mut(&key) {
                    if *previous != hint {
                        previous.reason = Some(
                            "conflicting public JavaScript method contracts are not ported".into(),
                        );
                    }
                } else {
                    hints.insert(key, hint);
                }
            }
        }
        Linked {
            projections: self.projections,
            literal_choices: self.literal_choices,
            hints,
            records: self.records,
            unions: self.unions,
            callables: self.callables,
        }
    }
}

fn is_javascript(path: &str) -> bool {
    path.ends_with(".js") || path.ends_with(".mjs")
}

impl Lowerer<'_> {
    pub(super) fn declared_callable_type(&self, id: TypeId) -> Option<Option<Type>> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let declaration = self.checker.sym(symbol).value_declaration;
        if declaration.is_nil()
            || !matches!(
                declaration.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::FunctionExpression
            )
        {
            return None;
        }
        let hint = self.declared(declaration)?;
        (hint.class.is_none()
            && (declaration.kind() != SyntaxKind::FunctionDeclaration || hint.value_type.is_none())
            && (hint.ret.is_some() || hint.reason.is_some()))
        .then(|| hint.function_type())
    }
    pub(super) fn declared(&self, node: Node) -> Option<&Hint> {
        if node.is_nil() {
            return None;
        }
        self.declarations.get(&Key::of(node))
    }
    pub(super) fn class_contract(&self, node: Node) -> Option<&ClassHint> {
        let binding = if node.kind() == SyntaxKind::ClassExpression {
            node.parent()
        } else {
            node
        };
        self.declared(binding).and_then(|h| h.class.as_ref())
    }
    pub(super) fn checker_any(&mut self, node: Node) -> bool {
        if self.projections.contains_key(&Key::of(node)) {
            return false;
        }
        let id = self.checker.get_type_at_location(node);
        self.checker.ty(id).flags.intersects(TypeFlags::ANY)
    }
}

#[cfg(test)]
mod method_contract_tests {
    use super::*;

    #[test]
    fn module_pairing_keeps_multiple_implementations_and_terminates_cycles() {
        let edge = |importer: &str, specifier: &str, target: &str| Edge {
            importer: importer.into(),
            specifier: specifier.into(),
            target: target.into(),
        };
        let checked = vec![
            edge("entry.ts", "a", "types/api.d.ts"),
            edge("entry.ts", "b", "types/api.d.ts"),
            edge("types/api.d.ts", "./helper", "types/helper.d.ts"),
            edge("types/helper.d.ts", "./api", "types/api.d.ts"),
        ];
        let runtime = vec![
            edge("entry.ts", "a", "runtime/a.js"),
            edge("entry.ts", "b", "runtime/b.js"),
            edge("runtime/a.js", "./helper", "runtime/a-helper.js"),
            edge("runtime/b.js", "./helper", "runtime/b-helper.js"),
            edge("runtime/a-helper.js", "./api", "runtime/a.js"),
            edge("runtime/b-helper.js", "./api", "runtime/b.js"),
            edge("entry.ts", "unrelated", "runtime/unused.js"),
        ];
        let files = [
            "entry.ts",
            "runtime/a.js",
            "runtime/b.js",
            "runtime/a-helper.js",
            "runtime/b-helper.js",
            "runtime/unused.js",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        let pairs = paired_paths(&checked, &runtime, &files);
        assert_eq!(
            pairs,
            [
                ("entry.ts", "entry.ts"),
                ("types/api.d.ts", "runtime/a.js"),
                ("types/api.d.ts", "runtime/b.js"),
                ("types/helper.d.ts", "runtime/a-helper.js"),
                ("types/helper.d.ts", "runtime/b-helper.js"),
            ]
            .into_iter()
            .map(|(left, right)| (left.into(), right.into()))
            .collect()
        );
    }
}
