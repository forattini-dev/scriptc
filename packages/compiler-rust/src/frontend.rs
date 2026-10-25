//! Checked source adaptation and lowering into scriptc-owned types and IR.
use crate::{
    builtins,
    ir::{self, Expr, Function, Loc, Local, Module, Param, Stmt, Type},
};
use source_frontend::{
    checker::Checker,
    flags::{ModifierFlags, NodeFlags, SymbolFlags, TypeFlags},
    prelude::{Node, SyntaxKind, TypeId, source_file_info},
    program,
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
mod aggregates;
mod arrays;
mod async_context;
mod bigint;
mod buffers;
mod callables;
mod callbacks;
mod child_process;
mod classes;
mod codecs;
mod collections;
mod commonjs;
mod comparisons;
mod console;
mod container_abi;
mod data_tables;
mod declarations;
mod directories;
mod enums;
mod exceptions;
mod filesystem;
mod filesystem_reads;
mod filesystem_writes;
mod function_reflection;
mod functions;
mod helpers;
pub mod inspect;
mod json_functions;
mod json_modules;
mod logical;
mod loops;
mod module_metadata;
mod modules;
mod namespace_values;
mod object_methods;
mod optional_access;
mod parameter_abi;
mod parameters;
mod pipeline;
mod primitives;
mod process;
mod promises;
mod property_keys;
mod receivers;
mod record_construction;
mod reflection;
mod regex;
mod sets;
mod spreads;
mod standard_functions;
mod standard_objects;
mod stats;
mod storage;
mod strings;
mod symbols;
mod tuples;
mod type_graph;
mod types;
mod union_literals;
mod union_spreads;
mod updates;
mod values;
mod vars;
mod weak_maps;

pub const REVISION: &str = "780dc512d64f40afebffa6a7028207649fb7ed1c";

pub(crate) fn path_for_frontend(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        text.strip_prefix(r"\\?\")
            .unwrap_or(&text)
            .replace('\\', "/")
    }
}

pub use pipeline::lower;

fn needs_execution_view() -> bool {
    program::source_files().into_iter().any(|file| {
        if is_declaration(&source_file_info(file).file_name) {
            return false;
        }
        program::with_type_checker_for_file(file, move |checker| {
            file.statements().into_iter().any(|node| {
                let Some(specifier) = modules::runtime_specifier(node) else {
                    return false;
                };
                if builtins::module(specifier.text()).is_some() {
                    return false;
                }
                let symbol = checker.get_symbol_at_location(specifier, false);
                if symbol.0 == 0 {
                    return false;
                }
                let target = checker.sym(symbol).value_declaration;
                !target.is_nil()
                    && target.kind() == SyntaxKind::SourceFile
                    && is_declaration(&source_file_info(target).file_name)
            })
        })
    })
}

fn is_declaration(path: &str) -> bool {
    [".d.ts", ".d.mts", ".d.cts"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}

fn refusal(file: &str, node: Node, detail: &str) -> String {
    format!(
        "SCN1001: {file}:{}..{}: {detail} ({:?}); native subset only, no fallback",
        node.pos(),
        node.end(),
        node.kind()
    )
}

#[derive(Clone)]
struct Signature {
    is_async: bool,
    rest: bool,
    node: Node,
    file: String,
    name: String,
    params: Vec<Param>,
    return_type: Type,
}

struct Lowerer<'a> {
    checker: &'a mut Checker,
    console_prelude: Option<String>,
    file: String,
    locals: Vec<Local>,
    bindings: HashMap<u32, Local>,
    module_bindings: HashMap<u32, Local>,
    globals: Vec<ir::Global>,
    functions: functions::FunctionGraph,
    return_type: Option<Type>,
    native_functions: HashMap<u32, (&'static str, String)>,
    native_namespaces: HashMap<u32, &'static str>,
    native_local_symbols: HashSet<u32>,
    ambiguous_native_targets: HashSet<u32>,
    json_imports: HashMap<u32, serde_json::Value>,
    records: Vec<ir::Record>,
    unions: Vec<ir::Union>,
    types: type_graph::TypeCache,
    type_stack: Vec<TypeId>,
    outer: Vec<HashMap<u32, Local>>,
    captures: Vec<(u32, Param)>,
    caught_aliases: HashMap<u32, Local>,
    lifted: Vec<Function>,
    next_closure: usize,
    helpers: HashMap<(String, Vec<Type>, Type), String>,
    declarations: HashMap<declarations::Key, declarations::Hint>,
    projections: HashMap<declarations::Key, Type>,
    literal_choices: HashMap<declarations::Key, Type>,
    classes: classes::ClassGraph,
    instance_this: Option<Local>,
    module_vars: HashMap<u32, Type>,
    // Value contracts for undefined-capable var/parameter/deferred let cells.
    var_types: HashMap<u32, Type>,
    var_defined: HashSet<u32>,
    js_absence_parameters: HashSet<u32>,
    js_absent_fields: HashSet<(TypeId, String)>,
    enums: enums::EnumGraph,
    callables: HashMap<usize, Type>,
    polymorphic_callables: HashMap<u32, usize>,
    data_bindings: HashSet<u32>,
    data_types: HashSet<TypeId>,
    commonjs: commonjs::Graph,
    namespace_values: namespace_values::NamespaceValues,
    receiver_calls: Vec<receivers::PendingCall>,
}

impl<'a> Lowerer<'a> {
    fn new(checker: &'a mut Checker, file: String, console_prelude: Option<String>) -> Self {
        Self {
            checker,
            console_prelude,
            file,
            locals: Vec::new(),
            bindings: HashMap::new(),
            module_bindings: HashMap::new(),
            globals: Vec::new(),
            functions: functions::FunctionGraph::default(),
            return_type: None,
            native_functions: HashMap::new(),
            native_namespaces: HashMap::new(),
            native_local_symbols: HashSet::new(),
            ambiguous_native_targets: HashSet::new(),
            json_imports: HashMap::new(),
            records: Vec::new(),
            unions: Vec::new(),
            types: type_graph::TypeCache::default(),
            type_stack: Vec::new(),
            outer: Vec::new(),
            captures: Vec::new(),
            caught_aliases: HashMap::new(),
            lifted: Vec::new(),
            next_closure: 0,
            helpers: HashMap::new(),
            declarations: HashMap::new(),
            projections: HashMap::new(),
            literal_choices: HashMap::new(),
            classes: classes::ClassGraph::default(),
            instance_this: None,
            module_vars: HashMap::new(),
            var_types: HashMap::new(),
            var_defined: HashSet::new(),
            js_absence_parameters: HashSet::new(),
            js_absent_fields: HashSet::new(),
            enums: enums::EnumGraph::default(),
            callables: HashMap::new(),
            polymorphic_callables: HashMap::new(),
            data_bindings: HashSet::new(),
            data_types: HashSet::new(),
            commonjs: commonjs::Graph::default(),
            namespace_values: namespace_values::NamespaceValues::default(),
            receiver_calls: Vec::new(),
        }
    }
    fn json_import(&mut self, node: Node, file: &str) -> Result<(), String> {
        let clause = node.import_clause();
        if clause.is_nil() {
            return Ok(());
        }
        let mut default_only = true;
        clause.for_each_child(&mut |child: Node| {
            if child.kind() != SyntaxKind::Identifier {
                default_only = false;
            }
            false
        });
        if !default_only || clause.name().is_nil() {
            return Err(self.refuse(node, "only JSON default imports are ported"));
        }
        let bytes = std::fs::read(file).map_err(|e| format!("SCN0001: JSON import {file}: {e}"))?;
        let value = serde_json::from_slice(&bytes)
            .map_err(|e| self.refuse(node, &format!("JSON value is not representable: {e}")))?;
        let symbol = self.symbol(clause.name());
        if symbol == 0 {
            return Err(self.refuse(node, "JSON import has no resolved default symbol"));
        }
        self.json_imports.insert(symbol, value);
        Ok(())
    }

    fn json_value(&mut self, node: Node) -> Option<serde_json::Value> {
        match node.kind() {
            SyntaxKind::Identifier => {
                let symbol = self.symbol(node);
                self.json_imports.get(&symbol).cloned()
            }
            SyntaxKind::PropertyAccessExpression => self
                .json_value(node.expression())?
                .get(node.name().text())
                .cloned(),
            _ => None,
        }
    }

    fn json_expression(&self, node: Node, value: serde_json::Value) -> Result<Expr, String> {
        let loc = self.loc(node);
        match value {
            serde_json::Value::String(value) => Ok(Expr::StrLit { value, r#type: Type::String, loc }),
            serde_json::Value::Bool(value) => Ok(Expr::BoolLit { value, r#type: Type::Bool, loc }),
            serde_json::Value::Number(value) => Ok(Expr::NumLit { value: value.as_f64().ok_or_else(|| self.refuse(node, "JSON number is not representable"))?, spelling: None, r#type: Type::F64, loc }),
            _ => Err(self.refuse(node, "JSON objects/arrays/null need native aggregate lowering; only primitive field reads are ported")),
        }
    }

    fn bind_native_namespace(&mut self, node: Node, module: &'static str) {
        let local = self.checker.get_symbol_at_location(node, false).0;
        let target = self.symbol(node);
        if local == 0 {
            return;
        }
        // Distinct public modules can share declaration targets (path flavors).
        // Direct imports keep their own local provenance. A forwarded target is
        // usable only while every registration agrees on the same source API.
        if !self.ambiguous_native_targets.contains(&target) {
            if self
                .native_namespaces
                .get(&target)
                .is_some_and(|previous| *previous != module)
            {
                self.native_namespaces.remove(&target);
                self.ambiguous_native_targets.insert(target);
            } else {
                self.native_namespaces.insert(target, module);
            }
        }
        self.native_local_symbols.insert(local);
        self.native_namespaces.insert(local, module);
    }

    fn bind_native_function(&mut self, node: Node, module: &'static str, member: &str) {
        let local = self.checker.get_symbol_at_location(node, false).0;
        let target = self.symbol(node);
        if local == 0 {
            return;
        }
        let binding = (module, member.to_owned());
        if !self.ambiguous_native_targets.contains(&target) {
            if self
                .native_functions
                .get(&target)
                .is_some_and(|previous| *previous != binding)
            {
                self.native_functions.remove(&target);
                self.ambiguous_native_targets.insert(target);
            } else {
                self.native_functions.insert(target, binding.clone());
            }
        }
        self.native_local_symbols.insert(local);
        self.native_functions.insert(local, binding);
    }

    fn native_import(&mut self, node: Node, module: &'static str) {
        fn walk(node: Node, nodes: &mut Vec<Node>) {
            nodes.push(node);
            node.for_each_child(&mut |child| {
                walk(child, nodes);
                false
            });
        }
        let mut nodes = Vec::new();
        walk(node, &mut nodes);
        let clause = node.import_clause();
        let default = if clause.is_nil() {
            Node::NIL
        } else {
            clause.name()
        };
        if !default.is_nil() {
            self.bind_native_namespace(default, module);
        }
        for node in nodes {
            if node.is_type_only() {
                continue;
            }
            match node.kind() {
                SyntaxKind::ImportSpecifier | SyntaxKind::ExportSpecifier => {
                    self.bind_native_function(
                        node.name(),
                        module,
                        node.property_name_or_name().text(),
                    );
                }
                SyntaxKind::NamespaceImport => {
                    self.bind_native_namespace(node.name(), module);
                }
                _ => {}
            }
        }
    }

    fn native_namespace(&mut self, node: Node) -> Option<&'static str> {
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            if let Some(module) = self.native_namespaces.get(&symbol) {
                return Some(*module);
            }
            if node.text() == "process" {
                let symbol = self.checker.get_symbol_at_location(node, false);
                if symbol.0 == 0 {
                    return None;
                }
                let declaration = self.checker.sym(symbol).value_declaration;
                if !declaration.is_nil() {
                    let file = source_frontend::ast::get_source_file_of_node(declaration);
                    let path = &source_file_info(file).file_name;
                    if path.contains("/node_modules/@types/node/")
                        || path.contains("/node_modules/bun-types/")
                    {
                        return Some("process");
                    }
                }
            }
        } else if node.kind() == SyntaxKind::PropertyAccessExpression {
            let base = self.native_namespace(node.expression())?;
            if base == "path" || base == "path/win32" {
                return match node.name().text() {
                    "posix" => Some("path"),
                    "win32" => Some("path/win32"),
                    _ => None,
                };
            }
        }
        None
    }

    fn module_namespace(&mut self, node: Node) -> bool {
        if self.commonjs_import(node).is_some() {
            return false;
        }
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.checker.get_symbol_at_location(node, false);
        if symbol.0 == 0
            || !self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
        {
            return false;
        }
        if self.commonjs.local_symbols.contains(&symbol.0) {
            return false;
        }
        let target = self.checker.get_aliased_symbol(symbol);
        if target.0 == 0 {
            return false;
        }
        let declaration = self.checker.sym(target).value_declaration;
        !declaration.is_nil() && declaration.kind() == SyntaxKind::SourceFile
    }

    fn native_call(&mut self, node: Node, module: &str, member: &str) -> Result<Expr, String> {
        let api = builtins::source(module, member).ok_or_else(|| {
            self.refuse(
                node,
                &format!("native library call '{module}.{member}' is not ported"),
            )
        })?;
        if api.lowering == builtins::Lowering::Directory {
            return self.directory_call(node);
        }
        if api.lowering == builtins::Lowering::Descriptor {
            return self.descriptor_call(node, member);
        }
        if api.lowering == builtins::Lowering::AppendFile {
            return self.append_file_call(node);
        }
        if api.lowering == builtins::Lowering::ReadFile {
            return self.read_file_call(node);
        }
        if module == "fs" && matches!(member, "statSync" | "lstatSync") {
            self.ensure_exception_classes(node)?;
        }
        let builtin = api.operations.first().expect("registered callable ABI");
        let mut args = node
            .arguments()
            .into_iter()
            .map(|arg| self.expression(arg))
            .collect::<Result<Vec<_>, _>>()?;
        if api.lowering == builtins::Lowering::PathVariadic {
            if args.iter().any(|arg| arg.ty() != Type::String) {
                return Err(self.refuse(node, "path arguments must be primitive strings"));
            }
            args = vec![Expr::ArrayLit {
                elems: args,
                r#type: builtins::strings(),
                loc: self.loc(node),
            }];
        } else if api.lowering == builtins::Lowering::PathBasename && args.len() == 1 {
            args.push(Expr::StrLit {
                value: String::new(),
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        if args.len() != builtin.args.len()
            || args
                .iter()
                .zip(&builtin.args)
                .any(|(arg, expected)| arg.ty() != *expected)
        {
            return Err(self.refuse(node, "native library overload is not ported"));
        }
        Ok(Expr::LibCall {
            r#fn: builtin.ir.into(),
            args,
            r#type: builtin.result.clone(),
            loc: self.loc(node),
        })
    }

    fn native_symbol(&mut self, node: Node) -> u32 {
        let local = self.checker.get_symbol_at_location(node, false).0;
        if self.native_local_symbols.contains(&local) {
            local
        } else {
            self.symbol(node)
        }
    }

    fn symbol(&mut self, node: Node) -> u32 {
        let mut symbol = if node.parent().kind() == SyntaxKind::ShorthandPropertyAssignment {
            self.checker
                .get_shorthand_assignment_value_symbol(node.parent())
        } else {
            self.checker.get_symbol_at_location(node, false)
        };
        if self.commonjs.local_symbols.contains(&symbol.0)
            && node.kind() == SyntaxKind::Identifier
            && let Some(local) = self.commonjs_lexical_symbol(node)
        {
            symbol = local;
        }
        if symbol.0 != 0
            && !self.commonjs.local_symbols.contains(&symbol.0)
            && self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
        {
            symbol = self.checker.get_aliased_symbol(symbol);
        }
        symbol.0
    }

    fn function_signature(&mut self, node: Node, ordinal: usize) -> Result<Signature, String> {
        if node.name().is_nil() || node.body().is_nil() || !node.asterisk_token().is_nil() {
            return Err(self.refuse(node, "only named non-generator function bodies are ported"));
        }
        let declared = self.declared(node).cloned();
        let parameters = receivers::parameters(node);
        let rest = node
            .parameters()
            .iter()
            .last()
            .is_some_and(|p| !p.dot_dot_dot_token().is_nil());
        let public_type = declared
            .as_ref()
            .and_then(|hint| hint.value_type.clone().or_else(|| hint.function_type()));
        let unpack_rest = parameter_abi::is_javascript(node)
            && !rest
            && public_type.as_ref().is_some_and(parameters::erased_rest);
        if rest && !node.type_parameters().is_empty() {
            return Err(self.refuse(node, "generic source rest parameters are not ported"));
        }
        if rest && node.kind() == SyntaxKind::MethodDeclaration {
            return Err(self.refuse(node, "array-rest instance methods are not ported"));
        }
        if let Some(hint) = &declared {
            if !unpack_rest && hint.rest != rest {
                return Err(self.refuse(
                    node,
                    "public JavaScript contract/implementation rest ABI differs",
                ));
            }
            if let Some(reason) = &hint.reason {
                return Err(self.refuse(node, reason));
            }
            if !unpack_rest && hint.params.len() != parameters.len() {
                return Err(self.refuse(
                    node,
                    "public JavaScript contract/implementation arity differs",
                ));
            }
        }
        let mut params = Vec::new();
        for (index, param) in parameters.iter().copied().enumerate() {
            if param.name().kind() != SyntaxKind::Identifier
                || (!param.dot_dot_dot_token().is_nil() && index + 1 != parameters.len())
            {
                return Err(self.refuse(
                    param,
                    "only native identifier parameters with a terminal rest slot are ported",
                ));
            }
            if unpack_rest {
                continue;
            }
            let ty = if let Some(hint) = &declared {
                hint.params[index].clone().ok_or_else(|| {
                    self.refuse(
                        param,
                        "public JavaScript parameter type has no native representation",
                    )
                })?
            } else {
                self.storage_type(param.name())?
            };
            if !param.dot_dot_dot_token().is_nil() && !matches!(ty, Type::Array { .. }) {
                return Err(self.refuse(param, "rest parameter needs a native array ABI"));
            }
            params.push(Param {
                local_id: format!("p{index}"),
                name: param.name().text().into(),
                r#type: self.parameter_type(param, ty)?,
            });
        }
        if unpack_rest {
            params.push(Param {
                local_id: "p0".into(),
                name: "arguments".into(),
                r#type: Type::Array {
                    elem: Box::new(Type::Dyn),
                },
            });
        }
        let erase_private_result = declared.is_none()
            && (self.file.ends_with(".js")
                || self.file.ends_with(".mjs")
                || self.file.ends_with(".cjs"))
            && params.iter().any(|p| p.r#type == Type::Dyn);
        let method_void = if matches!(
            node.kind(),
            SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
        ) && declared.is_none()
        {
            let signature = self.checker.get_signature_from_declaration(node);
            let result = self.checker.get_return_type_of_signature(signature);
            self.checker
                .ty(result)
                .flags
                .intersects(TypeFlags::VOID | TypeFlags::NEVER)
        } else {
            false
        };
        let return_type = if method_void {
            Type::Void
        } else if erase_private_result {
            Type::Dyn
        } else if unpack_rest {
            let Some(Type::Func { ret, .. }) = public_type else {
                unreachable!("erased rest public contract")
            };
            *ret
        } else if let Some(hint) = declared {
            hint.ret.ok_or_else(|| {
                self.refuse(
                    node,
                    "public JavaScript return type has no native representation",
                )
            })?
        } else {
            let sig = self.checker.get_signature_from_declaration(node);
            let ret = self.checker.get_return_type_of_signature(sig);
            let flags = self.checker.ty(ret).flags;
            self.type_id(ret)
                .filter(|ty| !matches!(ty, Type::Null | Type::Undefined))
                .or_else(|| {
                    flags
                        .intersects(TypeFlags::VOID | TypeFlags::NEVER)
                        .then_some(Type::Void)
                })
                .ok_or_else(|| self.refuse(node, "function return type is not ported"))?
        };
        let symbol = self.symbol(node.name());
        if symbol == 0 {
            return Err(self.refuse(node, "function declaration has no resolved native symbol"));
        }
        Ok(Signature {
            is_async: node.modifier_flags().intersects(ModifierFlags::ASYNC),
            rest: rest || unpack_rest,
            node,
            file: self.file.clone(),
            name: format!("f{ordinal}"),
            params,
            return_type,
        })
    }

    fn lower_function(&mut self, signature: Signature) -> Result<Function, String> {
        self.file = signature.file;
        self.locals.clear();
        self.bindings.clear();
        self.captures.clear();
        self.var_types = self.module_vars.clone();
        self.var_defined.clear();
        let body_return = if signature.is_async {
            let Type::Promise { inner } = &signature.return_type else {
                return Err(self.refuse(
                    signature.node,
                    "async function requires a native Promise result",
                ));
            };
            (**inner).clone()
        } else {
            signature.return_type.clone()
        };
        if signature.is_async {
            self.refuse_thenable(&body_return, signature.node)?;
        }
        self.return_type = Some(body_return.clone());
        self.instance_this = None;
        let mut body = Vec::new();
        let method = matches!(
            signature.node.kind(),
            SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
        );
        if method {
            self.bind_parameter(None, &signature.params[0])?;
            self.instance_this = Some(self.locals[0].clone());
        }
        if !method {
            body.extend(self.initialize_receiver(signature.node)?);
        }
        let source_parameters = receivers::parameters(signature.node);
        let unpack_rest = signature.rest
            && parameter_abi::is_javascript(signature.node)
            && source_parameters
                .last()
                .is_none_or(|param| param.dot_dot_dot_token().is_nil());
        if unpack_rest {
            body.extend(self.bind_parameter(None, &signature.params[0])?);
            body.extend(self.bind_erased_rest_formals(&source_parameters, &signature.params[0])?);
        }
        for (node, param) in source_parameters
            .into_iter()
            .zip(signature.params.iter().skip(usize::from(method)))
            .filter(|_| !unpack_rest)
        {
            body.extend(self.bind_parameter(Some(node), param)?);
        }
        body.extend(self.hoist_local_vars(signature.node.body())?);
        body.extend(self.statements(signature.node.body().statements())?);
        if body_return != Type::Void && !ir::always_returns(&body) {
            return Err(self.refuse(
                signature.node,
                "non-void function fallthrough is not ported",
            ));
        }
        self.instance_this = None;
        Ok(Function {
            is_async: signature.is_async,
            rest: signature.rest,
            name: signature.name,
            params: signature.params,
            captures: None,
            return_type: body_return,
            locals: std::mem::take(&mut self.locals),
            body,
            loc: self.loc(signature.node),
        })
    }

    fn loc(&self, node: Node) -> Loc {
        Loc {
            file: self.file.clone(),
            start: node.pos().max(0),
            end: node.end(),
        }
    }
    fn refuse(&self, node: Node, detail: &str) -> String {
        refusal(&self.file, node, detail)
    }
    fn binding(&mut self, node: Node) -> Result<Local, String> {
        if let Some(binding) = self.commonjs_binding(node) {
            return Ok(binding);
        }
        let symbol = self.symbol(node);
        self.resolve_binding(symbol, node)
    }
    fn statements(
        &mut self,
        nodes: source_frontend::prelude::NodeSlice,
    ) -> Result<Vec<Stmt>, String> {
        let mut out = Vec::new();
        for node in nodes {
            out.extend(self.statement(node)?);
        }
        Ok(out)
    }
    fn statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        if let Some(body) = self.enum_statement(node)? {
            return Ok(body);
        }
        let loc = self.loc(node);
        let stmt = match node.kind() {
            SyntaxKind::ClassDeclaration => return self.class_declaration(node),
            SyntaxKind::FunctionDeclaration
                if self.return_type.is_none() && node.parent().kind() == SyntaxKind::SourceFile =>
            {
                return Ok(vec![]);
            }
            SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration => return Ok(vec![]),
            SyntaxKind::TryStatement => return self.try_statement(node),
            SyntaxKind::WhileStatement => return self.while_statement(node),
            SyntaxKind::BreakStatement | SyntaxKind::ContinueStatement => self.loop_jump(node)?,
            SyntaxKind::ThrowStatement => {
                let value = self.expression(node.expression())?;
                let value = if matches!(value.ty(), Type::Null | Type::Undefined) {
                    self.coerce(value, Type::Dyn, node)?
                } else {
                    value
                };
                if value.ty() == Type::Void {
                    return Err(self.refuse(node, "void throw payload is not ported"));
                }
                Stmt::Throw { value, loc }
            }
            SyntaxKind::ReturnStatement => {
                let ret = self
                    .return_type
                    .clone()
                    .ok_or_else(|| self.refuse(node, "return outside a function"))?;
                let value = if node.expression().is_nil() {
                    None
                } else {
                    Some(self.expected_expression(node.expression(), ret.clone())?)
                };
                if value.as_ref().map_or(Type::Void, Expr::ty) != ret {
                    return Err(self.refuse(node, "return coercion is not ported"));
                }
                Stmt::Return { value, loc }
            }
            SyntaxKind::EmptyStatement
            | SyntaxKind::InterfaceDeclaration
            | SyntaxKind::JsTypeAliasDeclaration
            | SyntaxKind::TypeAliasDeclaration => return Ok(vec![]),
            SyntaxKind::Block => Stmt::Block {
                body: self.statements(node.statements())?,
                loc,
            },
            SyntaxKind::VariableStatement => {
                let list = node.declaration_list();
                let flags = list.flags();
                if !flags.intersects(NodeFlags::LET | NodeFlags::CONST) {
                    return self.var_statement(node);
                }
                if node.modifier_flags().intersects(ModifierFlags::AMBIENT) {
                    return Err(
                        self.refuse(node, "ambient lexical declarations have no native storage")
                    );
                }
                let mut out = Vec::new();
                for declaration in list.declarations().nodes() {
                    let name = declaration.name();
                    let symbol = self.symbol(name);
                    if self.native_namespaces.contains_key(&symbol) {
                        continue;
                    }
                    if name.kind() != SyntaxKind::Identifier {
                        return Err(self
                            .refuse(declaration, "identifier lexical declarations are required"));
                    }
                    let storage = self.storage_type(name);
                    let (ty, init) = if declaration.initializer().is_nil() {
                        let value_type = storage?;
                        let ty = self.undefined_storage_type(value_type.clone(), declaration)?;
                        self.var_types.insert(symbol, value_type);
                        self.var_defined.remove(&symbol);
                        let init = self.coerce(
                            Expr::UnitLit {
                                unit: "undefined",
                                r#type: Type::Undefined,
                                loc: self.loc(declaration),
                            },
                            ty.clone(),
                            declaration,
                        )?;
                        (ty, init)
                    } else if self.declared(declaration).is_none()
                        && declaration.type_().is_nil()
                        && storage.is_err()
                    {
                        let init = self.expression(declaration.initializer())?;
                        if matches!(init.ty(), Type::Void | Type::Null | Type::Undefined) {
                            return Err(
                                self.refuse(declaration, "initializer has no native storage type")
                            );
                        }
                        (init.ty(), init)
                    } else if self.declared(declaration).is_none()
                        && declaration.type_().is_nil()
                        && matches!(
                            declaration.initializer().kind(),
                            SyntaxKind::PropertyAccessExpression
                                | SyntaxKind::ElementAccessExpression
                        )
                    {
                        let init = self.expression(declaration.initializer())?;
                        if matches!(init, Expr::RecordKeyGet { .. })
                            || (declaration.initializer().kind()
                                == SyntaxKind::ElementAccessExpression
                                && self.optional_storage(&init.ty()))
                        {
                            // An inferred slot retains an index lookup's actual
                            // undefined arm, even if the checker omits it.
                            self.var_types.insert(symbol, storage?);
                            self.var_defined.remove(&symbol);
                            (init.ty(), init)
                        } else {
                            let ty = storage?;
                            let init = self.coerce(init, ty.clone(), declaration.initializer())?;
                            (ty, init)
                        }
                    } else {
                        let ty = storage?;
                        let init =
                            self.expected_expression(declaration.initializer(), ty.clone())?;
                        (ty, init)
                    };
                    if ty != init.ty() {
                        return Err(self.refuse(declaration, "coercion is not ported"));
                    }
                    if self.optional_storage(&ty) {
                        self.var_types.entry(symbol).or_insert_with(|| ty.clone());
                    }
                    if self.var_types.contains_key(&symbol) {
                        self.var_assignment_fact(symbol, &init);
                    }
                    if node.parent().kind() == SyntaxKind::SourceFile {
                        let binding =
                            self.module_binding(name, ty, !flags.intersects(NodeFlags::CONST));
                        if binding.r#type != init.ty() {
                            return Err(self.refuse(
                                declaration,
                                "module binding layout differs from its initializer",
                            ));
                        }
                        out.push(Stmt::Assign {
                            local_id: binding.id,
                            initializes_global: true,
                            value: init,
                            loc: self.loc(declaration),
                        });
                        continue;
                    }
                    let local = Local {
                        id: format!("v{}", self.locals.len()),
                        name: name.text().into(),
                        r#type: ty,
                        mutable: !flags.intersects(NodeFlags::CONST),
                        boxed: false,
                    };
                    let symbol = self.checker.get_symbol_at_location(name, false);
                    self.bindings.insert(symbol.0, local.clone());
                    self.locals.push(local.clone());
                    out.push(Stmt::VarDecl {
                        local_id: local.id,
                        init,
                        loc: self.loc(declaration),
                    });
                }
                return Ok(out);
            }
            SyntaxKind::ExpressionStatement => {
                let expression = node.expression();
                if expression.kind() == SyntaxKind::BinaryExpression
                    && expression.operator_token().kind() == SyntaxKind::EqualsToken
                {
                    if expression.left().kind() == SyntaxKind::ElementAccessExpression {
                        return Ok(vec![self.dictionary_set(expression)?]);
                    }
                    if expression.left().kind() == SyntaxKind::PropertyAccessExpression {
                        if let Some(value) = self.regex_set(expression)? {
                            return Ok(vec![value]);
                        }
                        if let Some(stmt) = self.class_set(expression)? {
                            return Ok(vec![stmt]);
                        }
                        return Ok(vec![self.record_set(expression)?]);
                    }
                    if expression.left().kind() != SyntaxKind::Identifier {
                        return Err(self.refuse(expression, "only local assignment is ported"));
                    }
                    if self.enum_type(expression.left()).is_some() {
                        return Err(
                            self.refuse(expression, "enum namespace reassignment is not ported")
                        );
                    }
                    let symbol = self.symbol(expression.left());
                    if self.native_namespaces.contains_key(&symbol) {
                        return Err(self.refuse(
                            expression,
                            "native namespace alias reassignment is not ported",
                        ));
                    }
                    let local = self.binding(expression.left())?;
                    if local.r#type == Type::Caught || self.caught_aliases.contains_key(&symbol) {
                        return Err(
                            self.refuse(expression, "catch binding reassignment is not ported")
                        );
                    }
                    let symbol = self.symbol(expression.left());
                    let target = self
                        .var_types
                        .get(&symbol)
                        .cloned()
                        .unwrap_or_else(|| local.r#type.clone());
                    let value = self.expected_expression(expression.right(), target)?;
                    let value = self.coerce(value, local.r#type.clone(), expression)?;
                    if self.var_types.contains_key(&symbol) {
                        self.var_assignment_fact(symbol, &value);
                    }
                    Stmt::Assign {
                        local_id: local.id,
                        initializes_global: false,
                        value,
                        loc,
                    }
                } else {
                    let expr = self.expression(expression)?;
                    if matches!(expr.ty(), Type::Null | Type::Undefined) {
                        return Err(
                            self.refuse(expression, "standalone unit expressions are not ported")
                        );
                    }
                    Stmt::Expression { expr, loc }
                }
            }
            SyntaxKind::IfStatement => self.var_if(node)?,
            _ => return Err(self.refuse(node, "statement is not ported")),
        };
        Ok(vec![stmt])
    }
    fn expression(&mut self, node: Node) -> Result<Expr, String> {
        let value = self.expression_inner(node).and_then(|value| {
            if value.ty() == Type::Dyn
                && matches!(
                    node.kind(),
                    SyntaxKind::CallExpression
                        | SyntaxKind::PropertyAccessExpression
                        | SyntaxKind::ElementAccessExpression
                )
                && let Ok(target) = self.ty(node)
                && !matches!(
                    target,
                    Type::Dyn | Type::Null | Type::Undefined | Type::Void
                )
                && !(matches!(
                    node.kind(),
                    SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
                ) && matches!(
                    target,
                    Type::Record { .. }
                        | Type::Array { .. }
                        | Type::Map { .. }
                        | Type::Union { .. }
                ))
            {
                return self.coerce(value, target, node);
            }
            Ok(value)
        });
        if matches!(
            node.kind(),
            SyntaxKind::CallExpression | SyntaxKind::NewExpression
        ) && !matches!(&value, Ok(Expr::Intrinsic { .. } | Expr::BytesNew { .. }))
            && !matches!(&value, Ok(Expr::LibCall { r#fn, .. }) if r#fn == "buffer.alloc")
        {
            self.var_call_effects();
        }
        value
    }

    fn expression_inner(&mut self, node: Node) -> Result<Expr, String> {
        if optional_access::is_access(node) {
            return self.optional_access(node);
        }
        if node.kind() == SyntaxKind::CallExpression
            && node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        {
            return Err(self.refuse(
                node,
                "optional calls require a native receiver-call contract",
            ));
        }
        if let Some(value) = self.boxed_get(node)? {
            return Ok(value);
        }
        if let Some(value) = self.standard_function_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.json_function_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.child_builtin_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.child_property(node)? {
            return Ok(value);
        }
        if let Some(value) = self.commonjs_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.process_read(node)? {
            return Ok(value);
        }
        if let Some(value) = self.namespace_reference(node)? {
            return Ok(value);
        }
        if let Some(value) = self.namespace_property(node)? {
            return Ok(value);
        }
        if let Some(value) = self.json_value(node) {
            return self.json_expression(node, value);
        }
        let loc = self.loc(node);
        match node.kind() {
            SyntaxKind::AwaitExpression => {
                Err(self.refuse(node, "native async suspension is not ported"))
            }
            SyntaxKind::ClassExpression => self.class_expression(node),
            SyntaxKind::NewExpression => {
                if let Some(value) = self.bytes_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.codec_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.regex_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_new(node)? {
                    return Ok(value);
                }
                if matches!(self.ty(node), Ok(Type::Set { .. })) {
                    return self.set_new(node, None);
                }
                self.map_new(node)
            }
            SyntaxKind::ThisKeyword => self.this_expression(node),
            SyntaxKind::RegularExpressionLiteral => self.regex_literal(node),
            SyntaxKind::ElementAccessExpression => {
                if let Some(value) = self.enum_get(node)? {
                    return Ok(value);
                }
                let obj = self.expression(node.expression())?;
                let obj = self.live_array_receiver(node.expression(), obj);
                if self.array_view(&obj.ty())
                    && self
                        .literal_property_key(node.argument_expression())
                        .as_deref()
                        == Some("length")
                {
                    return self.array_length(node, obj);
                }
                if matches!(obj.ty(), Type::Object { .. }) {
                    return self.class_index_get(node, obj);
                }
                if obj.ty() == Type::bytes() {
                    return self.bytes_index(node, obj);
                }
                if obj.ty() == Type::Dyn {
                    let key = self.property_key_expression(node.argument_expression())?;
                    return Ok(self.dynamic_get(node, obj, key));
                }
                if let Type::Array { elem } = obj.ty() {
                    let index = self.expected_expression(node.argument_expression(), Type::F64)?;
                    return Ok(Expr::ArrayGet {
                        arr: Box::new(obj),
                        index: Box::new(index),
                        r#type: *elem,
                        loc: self.loc(node),
                    });
                }
                if let Type::Union { union_id } = obj.ty() {
                    let arms = self.unions[union_id].arms.clone();
                    let arrays = arms
                        .iter()
                        .filter_map(|arm| {
                            if let Type::Array { elem } = arm {
                                Some((**elem).clone())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>();
                    if arrays.len() == 1
                        && arms.iter().all(|arm| {
                            matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined)
                        })
                    {
                        // A nullable dictionary payload still needs the source
                        // property read: an absent receiver throws, while a
                        // present array may return undefined for a missing key.
                        let index = self.expression(node.argument_expression())?;
                        if index.ty() != Type::F64 {
                            return Err(self.refuse(
                                node,
                                "nullable array indexing requires a represented numeric key",
                            ));
                        }
                        let key = Expr::ToString {
                            operand: Box::new(index),
                            r#type: Type::String,
                            loc: self.loc(node.argument_expression()),
                        };
                        let object = self.coerce(obj, Type::Dyn, node.expression())?;
                        let value = self.dynamic_get(node, object, key);
                        let result = self
                            .intern_union(vec![arrays[0].clone(), Type::Undefined])
                            .ok_or_else(|| {
                                self.refuse(
                                    node,
                                    "array lookup result has no undefined representation",
                                )
                            })?;
                        return self.coerce(value, result, node);
                    }
                }
                if let Type::Record { shape_id } = obj.ty()
                    && self.records[shape_id].tuple
                {
                    return self.tuple_get(node, obj);
                }
                let key = self.property_key_expression(node.argument_expression())?;
                self.dictionary_get(node, obj, key)
            }
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression => self.closure(node, None),
            SyntaxKind::ObjectLiteralExpression => {
                let ty = self.ty(node)?;
                self.record_literal(node, ty)
            }
            SyntaxKind::ConditionalExpression => {
                let ty = self.ty(node)?;
                self.expected_expression(node, ty)
            }
            SyntaxKind::NullKeyword => Ok(Expr::UnitLit {
                unit: "null",
                r#type: Type::Null,
                loc,
            }),
            SyntaxKind::ArrayLiteralExpression => {
                let ty = self.ty(node)?;
                self.expected_expression(node, ty)
            }
            SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression => {
                let target = self.ty(node)?;
                self.expected_expression(node.expression(), target)
            }
            SyntaxKind::ParenthesizedExpression | SyntaxKind::SatisfiesExpression => {
                self.expression(node.expression())
            }
            SyntaxKind::PropertyAccessExpression if self.module_namespace(node.expression()) => {
                self.expression(node.name())
            }
            SyntaxKind::PropertyAccessExpression => {
                if let Some(value) = self.module_metadata(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.console_value(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.enum_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.codec_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.symbol_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.regex_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.stats_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.primitive_get(node)? {
                    return Ok(value);
                }
                self.record_get(node)
            }
            SyntaxKind::BigIntLiteral => Ok(self.bigint_literal(node)),
            SyntaxKind::NumericLiteral => {
                let text = node.text().replace('_', "");
                let value = source_frontend::jsnum::from_string(&text).value();
                let spelling = (text.bytes().all(|b| b.is_ascii_digit())
                    && value.is_finite()
                    && format!("{value:.0}") != text)
                    .then(|| node.text().to_string());
                Ok(Expr::NumLit {
                    value,
                    spelling,
                    r#type: Type::F64,
                    loc,
                })
            }
            SyntaxKind::TemplateExpression => self.template_expression(node),
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => {
                let bytes = source_frontend::scanner_util::go_string_bytes(node.text());
                let value = std::str::from_utf8(&bytes)
                    .map_err(|_| self.refuse(node, "lone UTF-16 surrogates are not ported"))?
                    .to_string();
                Ok(Expr::StrLit {
                    value,
                    r#type: Type::String,
                    loc,
                })
            }
            SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword => Ok(Expr::BoolLit {
                value: node.kind() == SyntaxKind::TrueKeyword,
                r#type: Type::Bool,
                loc,
            }),
            SyntaxKind::Identifier => {
                let symbol = self.symbol(node);
                if let Some(value) = self.class_value(node)? {
                    return Ok(value);
                }
                if let Some(signature) =
                    self.request_function(symbol, node, functions::UseKind::Value)?
                {
                    return Ok(Expr::Closure {
                        fn_name: signature.name.clone(),
                        captures: vec![],
                        r#type: Type::Func {
                            rest: signature.rest,
                            params: signature.params.iter().map(|p| p.r#type.clone()).collect(),
                            ret: Box::new(signature.return_type.clone()),
                        },
                        loc,
                    });
                }
                if node.text() == "undefined"
                    && symbol != 0
                    && !self.bindings.contains_key(&symbol)
                    && self
                        .checker
                        .sym(source_frontend::prelude::SymbolId(symbol))
                        .value_declaration
                        .is_nil()
                {
                    return Ok(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc,
                    });
                }
                let local = self.binding(node)?;
                let value = Expr::VarRef {
                    local_id: local.id,
                    r#type: local.r#type,
                    loc,
                };
                if self.var_types.contains_key(&symbol) && !self.var_defined.contains(&symbol) {
                    return Ok(value);
                }
                self.narrowed(value, node)
            }
            SyntaxKind::PostfixUnaryExpression => self.update_expression(node),
            SyntaxKind::PrefixUnaryExpression
                if matches!(
                    node.operator(),
                    SyntaxKind::PlusPlusToken | SyntaxKind::MinusMinusToken
                ) =>
            {
                self.update_expression(node)
            }
            SyntaxKind::PrefixUnaryExpression => {
                let op = match node.operator() {
                    SyntaxKind::MinusToken => "-",
                    SyntaxKind::ExclamationToken => "!",
                    _ => return Err(self.refuse(node, "unary operator is not ported")),
                };
                if op == "!" {
                    let raw = self.condition_value(node.operand())?;
                    let operand = self.condition(raw, node.operand())?;
                    return Ok(Expr::Unary {
                        op: "!".into(),
                        operand: Box::new(operand),
                        r#type: Type::Bool,
                        loc,
                    });
                }
                let raw = self.expression(node.operand())?;
                let operand = Box::new(raw);
                if op == "-" && operand.ty() == Type::Bigint {
                    return Ok(self.bigint_operation("bigint.neg", vec![*operand], node));
                }
                if !matches!((op, operand.ty()), ("-", Type::F64) | ("!", Type::Bool)) {
                    return Err(self.refuse(node, "unary coercions are not ported"));
                }
                let r#type = if op == "!" { Type::Bool } else { Type::F64 };
                Ok(Expr::Unary {
                    op: op.into(),
                    operand,
                    r#type,
                    loc,
                })
            }
            SyntaxKind::BinaryExpression => {
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && node.left().kind() == SyntaxKind::PropertyAccessExpression
                    && node.left().name().kind() == SyntaxKind::PrivateIdentifier
                {
                    return self.private_assignment(node);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && node.left().kind() == SyntaxKind::PropertyAccessExpression
                    && let Some(value) = self.class_accessor_assignment(node)?
                {
                    return Ok(value);
                }
                if node.operator_token().kind() == SyntaxKind::InstanceOfKeyword {
                    return self.class_instanceof(node);
                }
                let op = match node.operator_token().kind() {
                    SyntaxKind::PlusToken => "+",
                    SyntaxKind::MinusToken => "-",
                    SyntaxKind::AsteriskToken => "*",
                    SyntaxKind::SlashToken => "/",
                    SyntaxKind::PercentToken => "%",
                    SyntaxKind::AsteriskAsteriskToken => "**",
                    SyntaxKind::LessThanToken => "<",
                    SyntaxKind::LessThanEqualsToken => "<=",
                    SyntaxKind::GreaterThanToken => ">",
                    SyntaxKind::GreaterThanEqualsToken => ">=",
                    SyntaxKind::EqualsEqualsEqualsToken => "===",
                    SyntaxKind::ExclamationEqualsEqualsToken => "!==",
                    SyntaxKind::AmpersandAmpersandToken => "&&",
                    SyntaxKind::BarBarToken => "||",
                    SyntaxKind::QuestionQuestionToken => "??",
                    SyntaxKind::InKeyword => "in",
                    _ => return Err(self.refuse(node, "binary operator is not ported")),
                };
                self.binary(node, op)
            }
            SyntaxKind::TypeOfExpression => {
                let value = self.condition_value(node.expression())?;
                if async_context::instance(&value.ty())
                    || weak_maps::instance(&value.ty())
                    || classes::weak_sets::instance(&value.ty())
                {
                    return Ok(Expr::Sequence {
                        stmts: vec![Stmt::Expression {
                            expr: value,
                            loc: loc.clone(),
                        }],
                        result: Box::new(Expr::StrLit {
                            value: "object".into(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }),
                        r#type: Type::String,
                        loc,
                    });
                }
                let value = self.coerce(value, Type::Dyn, node)?;
                Ok(Expr::LibCall {
                    r#fn: "dyn.typeof".into(),
                    args: vec![value],
                    r#type: Type::String,
                    loc,
                })
            }
            SyntaxKind::CallExpression => {
                if let Some(value) = self.function_source_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.boxed_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.process_write(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.buffer_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.stats_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.standard_function_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.bigint_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.primitive_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.function_receiver_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.json_function_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.promisify_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.weak_map_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.weak_set_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.async_context_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_reflection(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.console_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.codec_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.symbol_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.promise_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.function_bind(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.callable_assign(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.regex_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.namespace_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_symbol_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.error_call(node)? {
                    return Ok(value);
                }
                let member = node.expression();
                if self.commonjs_import(member).is_some() {
                    return self.call_value(node);
                }
                if member.kind() == SyntaxKind::PropertyAccessExpression {
                    let symbol = self.symbol(member.expression());
                    let mut receiver_type = self
                        .bindings
                        .get(&symbol)
                        .or_else(|| self.module_bindings.get(&symbol))
                        .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                        .map(|l| l.r#type.clone())
                        .or_else(|| self.ty(member.expression()).ok());
                    if matches!(receiver_type, Some(Type::Union { .. })) {
                        receiver_type = self.ty(member.expression()).ok();
                    }
                    if matches!(receiver_type, Some(Type::Array { .. })) {
                        return self.array_call(node);
                    }
                    if matches!(receiver_type, Some(Type::Record { shape_id }) if self.records[shape_id].tuple)
                    {
                        return match member.name().text() {
                            "join" => self.array_join(node),
                            "includes" => self.tuple_includes(node),
                            _ => Err(self.refuse(node, "tuple method is not ported")),
                        };
                    }
                    if matches!(receiver_type, Some(Type::Map { .. })) {
                        let receiver = self.expression(member.expression())?;
                        return self.map_intrinsic(
                            node,
                            receiver,
                            member.name().text(),
                            node.arguments().into_iter().collect(),
                        );
                    }
                    if matches!(receiver_type, Some(Type::Set { .. }))
                        || matches!(self.ty(member.expression()), Ok(Type::Set { .. }))
                    {
                        let receiver = self.expression(member.expression())?;
                        return self.set_intrinsic(
                            node,
                            receiver,
                            member.name().text(),
                            node.arguments().into_iter().collect(),
                        );
                    }
                }
                if member.kind() == SyntaxKind::Identifier {
                    let symbol = self.symbol(member);
                    if self.bindings.contains_key(&symbol)
                        || self.module_bindings.contains_key(&symbol)
                        || self.outer.iter().any(|scope| scope.contains_key(&symbol))
                    {
                        return self.call_value(node);
                    }
                } else if matches!(
                    member.kind(),
                    SyntaxKind::ParenthesizedExpression
                        | SyntaxKind::ElementAccessExpression
                        | SyntaxKind::CallExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::FunctionExpression
                ) {
                    return self.call_value(node);
                }
                if member.kind() == SyntaxKind::Identifier {
                    let symbol = self.native_symbol(member);
                    if let Some((module, name)) = self.native_functions.get(&symbol).cloned() {
                        return self.native_call(node, module, &name);
                    }
                } else if member.kind() == SyntaxKind::PropertyAccessExpression
                    && let Some(module) = self.native_namespace(member.expression())
                {
                    return self.native_call(node, module, member.name().text());
                }
                if member.kind() == SyntaxKind::PropertyAccessExpression {
                    let receiver = member.expression();
                    let owned = if receiver.kind() == SyntaxKind::Identifier {
                        let symbol = self.symbol(receiver);
                        self.commonjs_import(receiver).is_some()
                            || self.bindings.contains_key(&symbol)
                            || self.module_bindings.contains_key(&symbol)
                            || self.outer.iter().any(|scope| scope.contains_key(&symbol))
                    } else {
                        !self.module_namespace(receiver)
                    };
                    if owned
                        && matches!(
                            self.ty(receiver),
                            Ok(Type::Dyn | Type::Map { .. } | Type::Promise { .. })
                        )
                    {
                        let recv = self.expression(receiver)?;
                        if matches!(recv.ty(), Type::Map { .. }) {
                            return self.map_intrinsic(
                                node,
                                recv,
                                member.name().text(),
                                node.arguments().into_iter().collect(),
                            );
                        }
                        if recv.ty() == Type::Dyn {
                            let args = node
                                .arguments()
                                .into_iter()
                                .map(|a| self.expected_expression(a, Type::Dyn))
                                .collect::<Result<Vec<_>, _>>()?;
                            return Ok(Expr::DynInvoke {
                                recv: Box::new(recv),
                                method: member.name().text().into(),
                                callee_name: member.name().text().into(),
                                args,
                                r#type: Type::Dyn,
                                loc,
                            });
                        }
                    }
                    if owned {
                        let callable = match self.ty(member) {
                            Ok(Type::Func { .. } | Type::Dyn) => true,
                            Ok(Type::Record { shape_id }) => self.callables.contains_key(&shape_id),
                            _ => false,
                        };
                        if callable {
                            return self.call_value(node);
                        }
                    }
                }
                let symbol_node = if member.kind() == SyntaxKind::PropertyAccessExpression {
                    member.name()
                } else {
                    member
                };
                // A namespace identifier has no runtime evaluation. Other
                // receivers can have side effects and cannot be discarded.
                let namespace_call = member.kind() == SyntaxKind::PropertyAccessExpression
                    && self.module_namespace(member.expression());
                if member.kind() == SyntaxKind::Identifier || namespace_call {
                    let symbol = self.symbol(symbol_node);
                    if namespace_call && self.module_bindings.contains_key(&symbol) {
                        return self.call_value(node);
                    }
                    if let Some(signature) =
                        self.request_function(symbol, node, functions::UseKind::Call)?
                    {
                        if namespace_call && receivers::reads_this(signature.node) {
                            return Err(self.refuse(
                                node,
                                "namespace method this requires a native namespace receiver",
                            ));
                        }
                        let types = signature
                            .params
                            .iter()
                            .map(|p| p.r#type.clone())
                            .collect::<Vec<_>>();
                        let args = self.rest_call_arguments(node, &types, signature.rest)?;
                        return Ok(Expr::Call {
                            callee: signature.name,
                            args,
                            r#type: signature.return_type,
                            loc,
                        });
                    }
                }
                Err(self.refuse(node, "call target has no native representation"))
            }
            _ => Err(self.refuse(node, "expression is not ported")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_windows_paths_reach_the_frontend_as_canonical_paths() {
        assert_eq!(
            path_for_frontend(Path::new(r"\\?\C:\code\entry.ts")),
            "C:/code/entry.ts"
        );
        assert_eq!(
            path_for_frontend(Path::new(r"\\?\UNC\server\share\entry.ts")),
            "//server/share/entry.ts"
        );
    }
}
