//! Owning module identities; export reads stay in the live module binding table.
//! The portable object ABI is a private zero-field capsule, never an export snapshot.
use super::*;

#[cfg(test)]
mod tests {
    #[test]
    fn namespace_snapshots_keep_unsupported_erased_payloads_refused() {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/namespace-symbol-default");
                for (name, expected) in [
                    ("weak-map-main.mts", "erasing WeakMap"),
                    ("generic-symbol-main.mts", "erasing symbol methods"),
                ] {
                    let input = root.join(name).canonicalize().unwrap();
                    let work = tempfile::Builder::new()
                        .prefix("scriptc-namespace-erasure-")
                        .tempdir()
                        .unwrap();
                    match crate::frontend::lower(&input, work.path(), None, false) {
                        // The WeakMap owner and the WeakMap itself are erasable
                        // native handles: dynamic reads dispatch on the WeakMap.
                        Ok(module) if expected == "erasing WeakMap" => {
                            let rust = crate::emit::rust(&module)
                                .unwrap_or_else(|error| panic!("{name}: {error}"));
                            assert!(!rust.contains(expected), "{name}: WeakMap reads dispatch natively");
                        }
                        Ok(_) => panic!("{name}: unsupported dynamic payload was accepted"),
                        Err(error) => assert!(error.contains(expected), "{name}: {error}"),
                    }
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }
}

#[derive(Clone, Default)]
pub(super) struct NamespaceValues {
    paths: HashMap<String, usize>,
    slots: Vec<ir::Global>,
    pub layouts: Vec<ir::Class>,
}

fn namespace_class_name(path: &str) -> String {
    // Type adaptation is transactional, so discovery order can change after a
    // failed speculative layout is rolled back. Namespace identity must not.
    // A deterministic path key prevents a cached tuple/record from referring
    // to a different capsule when that module is rediscovered later.
    let mut hash = 0x6c62272e07bb014262b821756295c58du128;
    for byte in path.replace('\\', "/").bytes() {
        hash ^= u128::from(byte);
        hash = hash.wrapping_mul(0x0000000001000000000000000000013bu128);
    }
    format!("native_namespace_{hash:032x}")
}

fn collect_namespace_names(
    ty: &Type,
    records: &[ir::Record],
    unions: &[ir::Union],
    seen: &mut HashSet<Type>,
    names: &mut HashSet<String>,
) {
    if !seen.insert(ty.clone()) {
        return;
    }
    match ty {
        Type::Object { class_name } | Type::Classval { class_name }
            if class_name.starts_with("native_namespace_") =>
        {
            names.insert(class_name.clone());
        }
        Type::Array { elem } | Type::Set { elem } | Type::Promise { inner: elem } => {
            collect_namespace_names(elem, records, unions, seen, names);
        }
        Type::Generator {
            yield_type,
            return_type,
            next_type,
            ..
        } => {
            collect_namespace_names(yield_type, records, unions, seen, names);
            collect_namespace_names(return_type, records, unions, seen, names);
            collect_namespace_names(next_type, records, unions, seen, names);
        }
        Type::Map { key, value } => {
            collect_namespace_names(key, records, unions, seen, names);
            collect_namespace_names(value, records, unions, seen, names);
        }
        Type::Func { params, ret, .. } => {
            for parameter in params {
                collect_namespace_names(parameter, records, unions, seen, names);
            }
            collect_namespace_names(ret, records, unions, seen, names);
        }
        Type::Record { shape_id } => {
            if let Some(record) = records.get(*shape_id) {
                for field in &record.fields {
                    collect_namespace_names(&field.r#type, records, unions, seen, names);
                }
                if let Some(value) = &record.index_value {
                    collect_namespace_names(value, records, unions, seen, names);
                }
            }
        }
        Type::Union { union_id } => {
            if let Some(union) = unions.get(*union_id) {
                for arm in &union.arms {
                    collect_namespace_names(arm, records, unions, seen, names);
                }
            }
        }
        _ => {}
    }
}

impl Lowerer<'_> {
    /// An explicit `namespace as unknown as Record<string, T>` assertion asks
    /// for computed lookup over the namespace's complete enumerable surface.
    /// Namespace capsules intentionally carry no copied fields, so materialize
    /// a dictionary only when every runtime export is a stable ESM binding.
    /// Function declarations and `const` variables cannot change identity
    /// after dependency evaluation; mutable exports remain live and therefore
    /// cannot be represented by this snapshot.
    pub(super) fn namespace_index_snapshot(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let source_type = self.checker.get_type_at_location(node);
        if self.namespace_value_type(source_type).is_none() {
            return Ok(None);
        }
        let mut exports = self
            .checker
            .get_properties_of_type(source_type)
            .iter()
            .copied()
            .map(|symbol| (self.checker.sym(symbol).name.to_string(), symbol))
            .collect::<Vec<_>>();
        exports.sort_by(|left, right| left.0.cmp(&right.0));

        let mut fields = Vec::with_capacity(exports.len());
        for (name, mut symbol) in exports {
            if self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
            {
                symbol = self.checker.get_aliased_symbol(symbol);
            }
            let declaration = self.checker.sym(symbol).value_declaration;
            let stable = !declaration.is_nil()
                && (declaration.kind() == SyntaxKind::FunctionDeclaration
                    || (declaration.kind() == SyntaxKind::VariableDeclaration
                        && declaration.parent().flags().intersects(NodeFlags::CONST)));
            if !stable {
                return Err(self.refuse(
                    node,
                    &format!(
                        "computed module namespace snapshot requires stable exports; {name:?} is mutable or has no value declaration"
                    ),
                ));
            }
            let value = self
                .namespace_export_value(node, &name, node)?
                .ok_or_else(|| {
                    self.refuse(
                        node,
                        &format!("module namespace export {name:?} has no native snapshot value"),
                    )
                })?;
            if self.dynamic_erasure_reason(&value.ty())
                == Some("erasing symbol methods requires a native descriptor contract")
            {
                // Snapshot exports are passed to an unknown-typed consumer.
                // Materialize the same receiver-explicit symbol descriptors
                // required for ordinary dynamic callable arguments before
                // asking the erasure validator whether this value is safe.
                self.materialize_erased_symbol_methods(&value.ty())?;
            }
            if std::env::var_os("SCRIPTC_TRACE_NAMESPACE_SNAPSHOT").is_some()
                && let Some(reason) = self.dynamic_erasure_reason(&value.ty())
            {
                eprintln!(
                    "scriptc: namespace snapshot export {name:?} has {:?}: {reason}",
                    value.ty()
                );
            }
            let value = self.coerce(value, Type::Dyn, node)?;
            fields.push(ir::DynamicField {
                key: Expr::StrLit {
                    value: name,
                    r#type: Type::String,
                    loc: self.loc(node),
                },
                value,
            });
        }
        Ok(Some(Expr::DynObjLit {
            fields,
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn standard_path_namespace_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        matches!(symbol.name.as_ref(), "PlatformPath" | "path")
            && symbol.declarations.iter().any(|declaration| {
                let file = source_file_info(get_source_file_of_node(*declaration));
                let path = file.file_name.replace('\\', "/");
                path.ends_with("/path.d.ts")
                    && (path.contains("/@types/node/") || path.contains("/bun-types/"))
            })
    }

    pub(super) fn native_namespace_record(
        &mut self,
        node: Node,
        target: &Type,
    ) -> Result<Option<Expr>, String> {
        let Some(module) = self.native_namespace(node) else {
            return Ok(None);
        };
        if *target == Type::Bool && matches!(module, "path" | "path/win32") {
            return Ok(Some(Expr::BoolLit {
                value: module == "path/win32",
                r#type: Type::Bool,
                loc: self.loc(node),
            }));
        }
        let record = match target {
            Type::Record { shape_id } => Some(*shape_id),
            Type::Union { union_id } => {
                let records = self.unions[*union_id]
                    .arms
                    .iter()
                    .filter_map(|arm| match arm {
                        Type::Record { shape_id } => Some(*shape_id),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                (records.len() == 1).then_some(records[0])
            }
            _ => None,
        };
        let Some(shape_id) = record else {
            return Ok(None);
        };
        if module != "fs" {
            return Err(self.refuse(
                node,
                &format!(
                    "native namespace value has no typed descriptor adapter: module={module}, target={}",
                    self.contextual_type_description(target)
                ),
            ));
        }
        let fields = self.records[shape_id].fields.clone();
        let mut values = Vec::with_capacity(fields.len());
        for field in fields {
            let callable = match field.r#type.clone() {
                ty @ Type::Func { .. } => ty,
                Type::Record { shape_id } => {
                    self.callables.get(&shape_id).cloned().ok_or_else(|| {
                        self.refuse(node, "native namespace descriptor fields must be callable")
                    })?
                }
                _ => {
                    return Err(
                        self.refuse(node, "native namespace descriptor fields must be callable")
                    );
                }
            };
            let Type::Func { params, ret, rest } = callable.clone() else {
                unreachable!("selected callable ABI")
            };
            if rest {
                return Err(self.refuse(
                    node,
                    "native namespace descriptor rest functions are not ported",
                ));
            }
            let operation = format!("fs.namespace.{}", field.name);
            let result = match field.name.as_str() {
                "existsSync" => Type::Bool,
                "lstatSync" | "mkdirSync" | "readdirSync" | "readlinkSync" => Type::Dyn,
                "renameSync" | "rmSync" | "symlinkSync" | "unlinkSync" => Type::Void,
                _ => {
                    return Err(self.refuse(
                        node,
                        &format!("native fs namespace member {:?} is not ported", field.name),
                    ));
                }
            };
            if *ret != result {
                return Err(self.refuse(
                    node,
                    &format!(
                        "native fs namespace member {:?} has an unsupported return ABI",
                        field.name
                    ),
                ));
            }
            let mut helper = helpers::Helper::new(
                &format!("fs_namespace_{}", field.name),
                params.clone(),
                result.clone(),
                self.loc(node),
            );
            let args = (0..params.len())
                .map(|index| {
                    let parameter = helper.param(index);
                    self.coerce(helper.read(&parameter), Type::Dyn, node)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let call = Expr::LibCall {
                r#fn: operation,
                args,
                r#type: result.clone(),
                loc: self.loc(node),
            };
            if result == Type::Void {
                helper.function.body.push(Stmt::Expression {
                    expr: call,
                    loc: self.loc(node),
                });
                helper.function.body.push(Stmt::Return {
                    value: None,
                    loc: self.loc(node),
                });
            } else {
                helper.function.body.push(Stmt::Return {
                    value: Some(call),
                    loc: self.loc(node),
                });
            }
            let name = self.install_helper(helper.function);
            let value = Expr::Closure {
                fn_name: name,
                captures: vec![],
                r#type: callable,
                loc: self.loc(node),
            };
            let value = self.coerce(value, field.r#type.clone(), node)?;
            values.push(ir::FieldInit {
                name: field.name,
                value,
                absent: false,
                overflow: false,
            });
        }
        let record_type = Type::Record { shape_id };
        let value = Expr::RecordLit {
            fields: values,
            null_prototype: false,
            r#type: record_type,
            loc: self.loc(node),
        };
        self.coerce(value, target.clone(), node).map(Some)
    }

    pub(super) fn namespace_value_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let declaration = self.checker.sym(symbol).value_declaration;
        if declaration.is_nil() || declaration.kind() != SyntaxKind::SourceFile {
            return None;
        }
        let path = source_file_info(declaration).file_name.to_string();
        // In the checked declaration graph, `typeof import("pkg")` is the
        // public identity-bearing namespace contract. The execution graph
        // later aliases the JavaScript implementation path to this path, so
        // both sides share a capsule ABI without snapshotting all exports.
        if (is_declaration(&path) && !self.declaration_abi) || commonjs::is_module(declaration) {
            return None;
        }
        Some(self.namespace_value_path(path))
    }

    fn namespace_value_path(&mut self, path: String) -> Type {
        if let Some(index) = self.namespace_values.paths.get(&path) {
            return self.namespace_values.slots[*index].r#type.clone();
        }
        let index = self.namespace_values.slots.len();
        let class_path = self.namespace_aliases.get(&path).unwrap_or(&path);
        let class_name = namespace_class_name(class_path);
        let ty = Type::Object {
            class_name: class_name.clone(),
        };
        let loc = Loc {
            file: path.clone(),
            start: 0,
            end: 0,
        };
        let slot = ir::Global {
            id: format!("%g.namespace.{index}"),
            name: path.clone(),
            r#type: ty.clone(),
            mutable: false,
            loc: loc.clone(),
        };
        self.globals.push(slot.clone());
        self.namespace_values.slots.push(slot);
        self.namespace_values.paths.insert(path, index);
        self.install_namespace_layout(class_name, loc);
        ty
    }

    fn install_namespace_layout(&mut self, class_name: String, loc: Loc) {
        if self
            .namespace_values
            .layouts
            .iter()
            .any(|layout| layout.name == class_name)
        {
            return;
        }
        self.namespace_values.layouts.push(ir::Class {
            name: class_name.clone(),
            js_name: "ModuleNamespace".into(),
            runtime: false,
            base: None,
            fields: vec![],
            captures: vec![],
            methods: vec![],
            symbol_methods: vec![],
            symbol_brand: None,
            method_names: vec![],
            loc: loc.clone(),
        });
        let ty = Type::Object {
            class_name: class_name.clone(),
        };
        let constructor = helpers::Helper::new(
            &format!("%{class_name}.constructor"),
            vec![ty.clone()],
            Type::Void,
            loc,
        );
        // Constructor names are part of the existing portable class ABI.
        self.lifted.push(constructor.function);
    }

    pub(super) fn link_namespace_layouts(&mut self, functions: &[Function], site: Node) {
        let mut roots = Vec::new();
        for record in &self.records {
            roots.extend(record.fields.iter().map(|field| field.r#type.clone()));
            roots.extend(record.index_value.iter().cloned());
        }
        for union in &self.unions {
            roots.extend(union.arms.iter().cloned());
        }
        roots.extend(self.globals.iter().map(|global| global.r#type.clone()));
        for class in self.classes.layouts.iter().flatten() {
            roots.extend(class.fields.iter().map(|field| field.r#type.clone()));
        }
        for function in functions {
            roots.push(function.return_type.clone());
            roots.extend(
                function
                    .params
                    .iter()
                    .map(|parameter| parameter.r#type.clone()),
            );
            roots.extend(
                function
                    .captures
                    .iter()
                    .flatten()
                    .map(|capture| capture.r#type.clone()),
            );
            roots.extend(function.locals.iter().map(|local| local.r#type.clone()));
            function.visit_expressions(&mut |value| roots.push(value.ty()));
        }
        let mut names = HashSet::new();
        let mut seen = HashSet::new();
        for root in roots {
            collect_namespace_names(&root, &self.records, &self.unions, &mut seen, &mut names);
        }
        let mut names = names.into_iter().collect::<Vec<_>>();
        names.sort();
        let loc = Loc {
            file: source_file_info(site).file_name.to_string(),
            start: 0,
            end: 0,
        };
        for name in names {
            self.install_namespace_layout(name, loc.clone());
        }
    }

    pub(super) fn namespace_value_for_file(&mut self, file: Node, node: Node) -> Expr {
        let path = source_file_info(file).file_name.to_string();
        let ty = self.namespace_value_path(path);
        let slot = self
            .namespace_values
            .slots
            .iter()
            .find(|slot| slot.r#type == ty)
            .expect("interned module namespace");
        Expr::VarRef {
            local_id: slot.id.clone(),
            r#type: ty,
            loc: self.loc(node),
        }
    }

    pub(super) fn namespace_capsule(&self, ty: &Type) -> bool {
        matches!(ty, Type::Object { class_name } if self.namespace_values.layouts.iter().any(|c| c.name == *class_name))
    }

    pub(super) fn contains_namespace(&self, ty: &Type) -> bool {
        self.native_type_contains(ty, |ty| self.namespace_capsule(ty))
    }

    pub(super) fn namespace_reference(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::Identifier
            || !self.module_namespace(node)
            || self.native_namespace(node).is_some()
        {
            return Ok(None);
        }
        let id = self.checker.get_type_at_location(node);
        let Some(ty) = self.namespace_value_type(id) else {
            return Ok(None);
        };
        let slot = self
            .namespace_values
            .slots
            .iter()
            .find(|slot| slot.r#type == ty)
            .unwrap();
        Ok(Some(Expr::VarRef {
            local_id: slot.id.clone(),
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    /// Read one named export from a statically resolved module namespace.
    /// Namespace capsules deliberately do not duplicate every export in an
    /// object property table, so object spread and destructuring materialize
    /// the demanded snapshot from the live module bindings instead.
    pub(super) fn namespace_export_value(
        &mut self,
        source: Node,
        export: &str,
        site: Node,
    ) -> Result<Option<Expr>, String> {
        let source_type = self.checker.get_type_at_location(source);
        if self.namespace_value_type(source_type).is_none() {
            return Ok(None);
        }
        let Some(mut symbol) = self
            .checker
            .get_properties_of_type(source_type)
            .iter()
            .copied()
            .find(|symbol| self.checker.sym(*symbol).name.as_ref() == export)
        else {
            return Ok(None);
        };
        if self
            .checker
            .sym(symbol)
            .flags
            .intersects(SymbolFlags::ALIAS)
        {
            symbol = self.checker.get_aliased_symbol(symbol);
        }
        let declaration = self.checker.sym(symbol).value_declaration;
        if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::ClassDeclaration
            && let Some(value) = self.class_value(declaration.name())?
        {
            return Ok(Some(value));
        }
        if let Some(signature) = self.request_function(symbol.0, site, functions::UseKind::Value)? {
            let ty = Type::Func {
                rest: signature.rest,
                params: signature
                    .params
                    .iter()
                    .map(|parameter| parameter.r#type.clone())
                    .collect(),
                ret: Box::new(signature.return_type.clone()),
            };
            return Ok(Some(Expr::Closure {
                fn_name: signature.name,
                captures: vec![],
                r#type: ty,
                loc: self.loc(site),
            }));
        }
        if !declaration.is_nil() && !declaration.name().is_nil() {
            return self
                .expression(declaration.name())
                .map(Some)
                .map_err(|error| {
                    format!("{error}; while reading module namespace export {export:?}")
                });
        }
        Err(self.refuse(
            site,
            &format!("module namespace export {export:?} has no native value declaration"),
        ))
    }

    pub(super) fn namespace_property(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || self.module_namespace(node.expression())
        {
            return Ok(None);
        }
        let id = self.checker.get_type_at_location(node.expression());
        if self.namespace_value_type(id).is_none() {
            return Ok(None);
        }
        let receiver = self.expression(node.expression())?;
        if matches!(receiver.ty(), Type::Record { .. }) {
            // A dynamic-import reaction can carry an observed export
            // snapshot as a record instead of the full module namespace.
            return Ok(None);
        }
        if !self.namespace_capsule(&receiver.ty()) {
            return Err(self.refuse(
                node,
                "module namespace receiver needs a non-null native identity",
            ));
        }
        self.namespace_property_value(node, receiver).map(Some)
    }

    pub(super) fn namespace_property_value(
        &mut self,
        node: Node,
        receiver: Expr,
    ) -> Result<Expr, String> {
        debug_assert!(self.namespace_capsule(&receiver.ty()));
        // The property symbol resolves to its actual export (including reexports).
        // Evaluate the receiver first; only then read the current global/function binding.
        let value = self.expression(node.name())?;
        let ty = value.ty();
        let symbol = self.symbol(node.name());
        let mut helper = helpers::Helper::new(
            &format!("namespace_read_{symbol}"),
            vec![receiver.ty()],
            ty.clone(),
            self.loc(node),
        );
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(node),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![receiver],
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn namespace_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || self.module_namespace(member.expression())
        {
            return Ok(None);
        }
        let id = self.checker.get_type_at_location(member.expression());
        if self.namespace_value_type(id).is_none() {
            return Ok(None);
        }
        self.call_value(node).map(Some)
    }

    pub(super) fn path_namespace_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver_node = member.expression();
        let receiver_type = self.checker.get_type_at_location(receiver_node);
        if !self.standard_path_namespace_type(receiver_type) {
            return Ok(None);
        }
        let receiver = self.expected_expression(receiver_node, Type::Bool)?;
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let name = member.name().text();
        let (operation, mut args, result) = match name.as_ref() {
            "join" | "resolve" => {
                let operation = if name == "join" {
                    "path.selectedJoin"
                } else {
                    "path.selectedResolve"
                };
                let parts = self.array_spread_elements(
                    node,
                    arguments,
                    Type::Array {
                        elem: Box::new(Type::String),
                    },
                )?;
                (operation, vec![parts], Type::String)
            }
            "normalize" | "dirname" | "extname" | "isAbsolute" => {
                if arguments.len() != 1 {
                    return Err(
                        self.refuse(node, &format!("path strategy {name} expects one argument"))
                    );
                }
                let operation = match name.as_ref() {
                    "normalize" => "path.selectedNormalize",
                    "dirname" => "path.selectedDirname",
                    "extname" => "path.selectedExtname",
                    "isAbsolute" => "path.selectedIsAbsolute",
                    _ => unreachable!(),
                };
                let result = if name == "isAbsolute" {
                    Type::Bool
                } else {
                    Type::String
                };
                (
                    operation,
                    vec![self.expected_expression(arguments[0], Type::String)?],
                    result,
                )
            }
            "basename" => {
                if !(1..=2).contains(&arguments.len()) {
                    return Err(
                        self.refuse(node, "path strategy basename expects one or two arguments")
                    );
                }
                let path = self.expected_expression(arguments[0], Type::String)?;
                let suffix = if arguments.len() == 2 {
                    self.expected_expression(arguments[1], Type::String)?
                } else {
                    Expr::StrLit {
                        value: String::new(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    }
                };
                ("path.selectedBasename", vec![path, suffix], Type::String)
            }
            "relative" => {
                if arguments.len() != 2 {
                    return Err(self.refuse(node, "path strategy relative expects two arguments"));
                }
                let from = self.expected_expression(arguments[0], Type::String)?;
                let to = self.expected_expression(arguments[1], Type::String)?;
                ("path.selectedRelative", vec![from, to], Type::String)
            }
            _ => {
                return Err(self.refuse(
                    node,
                    &format!("selected path strategy method {name:?} is not ported"),
                ));
            }
        };
        args.insert(0, receiver);
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args,
            r#type: result,
            loc: self.loc(node),
        }))
    }

    pub(super) fn path_namespace_property(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let receiver_node = node.expression();
        let receiver_type = self.checker.get_type_at_location(receiver_node);
        if !self.standard_path_namespace_type(receiver_type) {
            return Ok(None);
        }
        let operation = match node.name().text().as_ref() {
            "sep" => "path.selectedSep",
            "delimiter" => "path.selectedDelimiter",
            _ => return Ok(None),
        };
        let receiver = self.expected_expression(receiver_node, Type::Bool)?;
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args: vec![receiver],
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }

    pub(super) fn namespace_prelude(&self) -> Vec<Stmt> {
        self.namespace_values
            .slots
            .iter()
            .map(|slot| {
                let Type::Object { class_name } = &slot.r#type else {
                    unreachable!()
                };
                let loc = self
                    .namespace_values
                    .layouts
                    .iter()
                    .find(|c| c.name == *class_name)
                    .unwrap()
                    .loc
                    .clone();
                Stmt::Assign {
                    local_id: slot.id.clone(),
                    initializes_global: true,
                    value: Expr::New {
                        class_name: class_name.clone(),
                        args: vec![],
                        r#type: slot.r#type.clone(),
                        loc: loc.clone(),
                    },
                    loc,
                }
            })
            .collect()
    }
}
