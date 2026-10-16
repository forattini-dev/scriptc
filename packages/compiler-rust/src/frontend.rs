//! Theo's Rust parser/binder/checker, directly linked. No compiler subprocess.
use crate::{
    builtins,
    ir::{self, Expr, Function, Loc, Local, Module, Param, Stmt, Type},
};
use goport_core::{
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

pub fn lower(input: &Path, work: &Path, project: Option<&Path>) -> Result<Module, String> {
    if input.to_str().is_none() {
        return Err("SCN0001: non-Unicode input paths are not ported".into());
    }
    let source = path_for_frontend(input);
    let (options, checked) = crate::project::load(input, work, project)?;
    let _checked_scope = goport_core::core::enter_program(Some(checked));
    program::bind_all();
    let mut diagnostics = program::get_config_file_parsing_diagnostics();
    diagnostics.extend(program::get_program_diagnostics());
    diagnostics.extend(program::get_syntactic_diagnostics(Node::NIL));
    diagnostics.extend(program::get_semantic_diagnostics(Node::NIL));
    diagnostics.extend(program::get_global_diagnostics());
    if !diagnostics.is_empty() {
        return Err(diagnostics
            .iter()
            .map(program::format_diagnostic)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let execution = needs_execution_view().then(|| crate::project::execution_view(options));
    let _execution_scope = execution.map(|program| goport_core::core::enter_program(Some(program)));
    if execution.is_some() {
        program::bind_all();
        let syntax = program::get_syntactic_diagnostics(Node::NIL);
        if !syntax.is_empty() {
            return Err(syntax
                .iter()
                .map(program::format_diagnostic)
                .collect::<Vec<_>>()
                .join("\n"));
        }
    }
    let file = program::source_files()
        .into_iter()
        .find(|node| source_file_info(*node).file_name == source)
        .ok_or_else(|| "SCN0002: frontend did not return the input source file".to_string())?;
    program::with_type_checker_for_file(file, move |checker| {
        let mut lowerer = Lowerer {
            checker,
            file: source.clone(),
            locals: Vec::new(),
            bindings: HashMap::new(),
            functions: HashMap::new(),
            return_type: None,
            native_functions: HashMap::new(),
            native_namespaces: HashMap::new(),
            json_imports: HashMap::new(),
            records: Vec::new(),
            unions: Vec::new(),
            types: HashMap::new(),
        };
        let mut files = Vec::new();
        lowerer.dependencies(file, &mut HashSet::new(), &mut HashSet::new(), &mut files)?;
        for file in &files {
            lowerer.file = source_file_info(*file).file_name.to_string();
            for node in file.statements() {
                if node.kind() == SyntaxKind::FunctionDeclaration {
                    lowerer.register_function(node)?;
                }
            }
        }
        let mut body = Vec::new();
        for file in &files {
            lowerer.file = source_file_info(*file).file_name.to_string();
            body.extend(lowerer.statements(file.statements())?);
        }
        let mut functions = vec![Function {
            name: "__main".into(),
            params: vec![],
            return_type: Type::Void,
            locals: std::mem::take(&mut lowerer.locals),
            body,
            loc: Loc {
                file: source.clone(),
                start: 0,
                end: file.end(),
            },
        }];
        let mut declarations = lowerer.functions.values().cloned().collect::<Vec<_>>();
        declarations.sort_by(|a, b| a.name.cmp(&b.name));
        for declaration in declarations {
            functions.push(lowerer.lower_function(declaration)?);
        }
        Ok(Module {
            ir_version: ir::VERSION,
            source_file: source.clone(),
            entry: "__main".into(),
            functions,
            records: lowerer.records,
            unions: lowerer.unions,
        })
    })
}

fn needs_execution_view() -> bool {
    program::source_files().into_iter().any(|file| {
        if is_declaration(&source_file_info(file).file_name) {
            return false;
        }
        program::with_type_checker_for_file(file, move |checker| {
            file.statements().into_iter().any(|node| {
                if !matches!(
                    node.kind(),
                    SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration
                ) || node.is_type_only()
                    || (!node.import_clause().is_nil() && node.import_clause().is_type_only())
                {
                    return false;
                }
                let specifier = node.module_specifier();
                if specifier.is_nil() || builtins::module(specifier.text()).is_some() {
                    return false;
                }
                let symbol = checker.get_symbol_at_location(specifier, false);
                if symbol.0 == 0 {
                    return false;
                }
                let target = checker.sym(symbol).value_declaration;
                target.kind() == SyntaxKind::SourceFile
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

#[derive(Clone)]
struct Signature {
    node: Node,
    file: String,
    name: String,
    params: Vec<Param>,
    return_type: Type,
}

struct Lowerer<'a> {
    checker: &'a mut Checker,
    file: String,
    locals: Vec<Local>,
    bindings: HashMap<u32, Local>,
    functions: HashMap<u32, Signature>,
    return_type: Option<Type>,
    native_functions: HashMap<u32, (&'static str, String)>,
    native_namespaces: HashMap<u32, &'static str>,
    json_imports: HashMap<u32, serde_json::Value>,
    records: Vec<ir::Record>,
    unions: Vec<ir::Union>,
    // None is also the in-progress sentinel: recursive layouts are refused.
    types: HashMap<TypeId, Option<Type>>,
}

impl Lowerer<'_> {
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
            let symbol = self.symbol(default);
            if symbol != 0 {
                self.native_namespaces.insert(symbol, module);
            }
        }
        for node in nodes {
            if node.is_type_only() {
                continue;
            }
            match node.kind() {
                SyntaxKind::ImportSpecifier | SyntaxKind::ExportSpecifier => {
                    let symbol = self.symbol(node.name());
                    if symbol != 0 {
                        self.native_functions.insert(
                            symbol,
                            (module, node.property_name_or_name().text().to_string()),
                        );
                    }
                }
                SyntaxKind::NamespaceImport => {
                    let symbol = self.symbol(node.name());
                    if symbol != 0 {
                        self.native_namespaces.insert(symbol, module);
                    }
                }
                _ => {}
            }
        }
    }

    fn native_namespace(&mut self, node: Node) -> Option<&'static str> {
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
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
                    let file = goport_core::ast::get_source_file_of_node(declaration);
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

    fn native_call(&mut self, node: Node, module: &str, member: &str) -> Result<Expr, String> {
        let builtin = builtins::get(module, member).ok_or_else(|| {
            self.refuse(
                node,
                &format!("native library call '{module}.{member}' is not ported"),
            )
        })?;
        let mut args = node
            .arguments()
            .into_iter()
            .map(|arg| self.expression(arg))
            .collect::<Result<Vec<_>, _>>()?;
        if member == "join" || member == "resolve" {
            if args.iter().any(|arg| arg.ty() != Type::String) {
                return Err(self.refuse(node, "path arguments must be primitive strings"));
            }
            args = vec![Expr::ArrayLit {
                elems: args,
                r#type: builtins::STRINGS,
                loc: self.loc(node),
            }];
        } else if member == "basename" && args.len() == 1 {
            args.push(Expr::StrLit {
                value: String::new(),
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        if args.len() != builtin.args.len()
            || args
                .iter()
                .zip(builtin.args)
                .any(|(arg, expected)| arg.ty() != *expected)
        {
            return Err(self.refuse(node, "native library overload is not ported"));
        }
        Ok(Expr::LibCall {
            r#fn: builtin.ir.into(),
            args,
            r#type: builtin.result,
            loc: self.loc(node),
        })
    }

    fn symbol(&mut self, node: Node) -> u32 {
        let mut symbol = if node.parent().kind() == SyntaxKind::ShorthandPropertyAssignment {
            self.checker
                .get_shorthand_assignment_value_symbol(node.parent())
        } else {
            self.checker.get_symbol_at_location(node, false)
        };
        if symbol.0 != 0
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

    // Use the frontend's resolved module symbol, never a second path resolver.
    fn dependencies(
        &mut self,
        file: Node,
        active: &mut HashSet<String>,
        visited: &mut HashSet<String>,
        ordered: &mut Vec<Node>,
    ) -> Result<(), String> {
        let path = source_file_info(file).file_name.to_string();
        self.file = path.clone();
        if visited.contains(&path) {
            return Ok(());
        }
        if !active.insert(path.clone()) {
            // Re-entering an evaluating ESM module does not execute its body
            // again. Functions are instantiated in the later prepass; main
            // bindings only become available after their initialization.
            return Ok(());
        }
        for node in file.statements() {
            if node.kind() != SyntaxKind::ImportDeclaration
                && node.kind() != SyntaxKind::ExportDeclaration
            {
                continue;
            }
            if node.is_type_only()
                || (!node.import_clause().is_nil() && node.import_clause().is_type_only())
            {
                continue;
            }
            let specifier = node.module_specifier();
            if specifier.is_nil() {
                continue;
            }
            if let Some(module) = builtins::module(specifier.text()) {
                self.native_import(node, module);
                continue;
            }
            // The project resolver also owns paths/package-import aliases.
            // Only executable source modules proceed to native lowering.
            let symbol = self.checker.get_symbol_at_location(specifier, false);
            if symbol.0 == 0 {
                return Err(self.refuse(
                    node,
                    &format!(
                        "Rust frontend did not resolve runtime module '{}'",
                        specifier.text()
                    ),
                ));
            }
            let target = self.checker.sym(symbol).value_declaration;
            if target.kind() != SyntaxKind::SourceFile {
                return Err(self.refuse(
                    node,
                    &format!(
                        "import '{}' has no executable source module",
                        specifier.text()
                    ),
                ));
            }
            let target_path = &source_file_info(target).file_name;
            if target_path.ends_with(".json") {
                self.json_import(node, target_path)?;
                continue;
            }
            if [".d.ts", ".d.mts", ".d.cts"]
                .iter()
                .any(|suffix| target_path.ends_with(suffix))
                || ![".ts", ".mts", ".js", ".mjs"]
                    .iter()
                    .any(|suffix| target_path.ends_with(suffix))
            {
                return Err(self.refuse(
                    node,
                    &format!(
                        "import '{}' resolves to unsupported runtime source '{target_path}'",
                        specifier.text()
                    ),
                ));
            }
            self.dependencies(target, active, visited, ordered)?;
            self.file = path.clone();
        }
        active.remove(&path);
        visited.insert(path);
        ordered.push(file);
        Ok(())
    }

    fn register_function(&mut self, node: Node) -> Result<(), String> {
        if node.name().is_nil()
            || node.body().is_nil()
            || !node.type_parameters().is_empty()
            || !node.asterisk_token().is_nil()
            || node.modifier_flags().intersects(ModifierFlags::ASYNC)
        {
            return Err(self.refuse(
                node,
                "only named synchronous non-generic function bodies are ported",
            ));
        }
        let mut params = Vec::new();
        for (index, param) in node.parameters().into_iter().enumerate() {
            if param.name().kind() != SyntaxKind::Identifier
                || param.name().text() == "this"
                || !param.initializer().is_nil()
                || !param.question_token().is_nil()
                || !param.dot_dot_dot_token().is_nil()
            {
                return Err(self.refuse(
                    param,
                    "only required native identifier parameters are ported",
                ));
            }
            params.push(Param {
                local_id: format!("p{index}"),
                name: param.name().text().into(),
                r#type: self.storage_type(param.name())?,
            });
        }
        let sig = self.checker.get_signature_from_declaration(node);
        let ret = self.checker.get_return_type_of_signature(sig);
        let flags = self.checker.ty(ret).flags;
        let return_type = self
            .type_id(ret)
            .filter(|ty| !matches!(ty, Type::Null | Type::Undefined))
            .or_else(|| flags.intersects(TypeFlags::VOID).then_some(Type::Void))
            .ok_or_else(|| self.refuse(node, "function return type is not ported"))?;
        let symbol = self.symbol(node.name());
        if symbol == 0 {
            return Err(self.refuse(node, "function declaration has no resolved native symbol"));
        }
        if self.functions.contains_key(&symbol) {
            return Err(self.refuse(node, "function overloads are not ported"));
        }
        let signature = Signature {
            node,
            file: self.file.clone(),
            name: format!("f{}", self.functions.len()),
            params,
            return_type,
        };
        self.functions.insert(symbol, signature);
        Ok(())
    }

    fn lower_function(&mut self, signature: Signature) -> Result<Function, String> {
        self.file = signature.file;
        self.locals.clear();
        self.bindings.clear(); // Captured outer bindings require a later closure/global representation.
        self.return_type = Some(signature.return_type);
        for (node, param) in signature
            .node
            .parameters()
            .into_iter()
            .zip(&signature.params)
        {
            let symbol = self.symbol(node.name());
            let local = Local {
                id: param.local_id.clone(),
                name: param.name.clone(),
                r#type: param.r#type,
                mutable: true,
            };
            // IR v13 parameters reference entries in the function's locals table.
            self.bindings.insert(symbol, local.clone());
            self.locals.push(local);
        }
        let body = self.statements(signature.node.body().statements())?;
        if signature.return_type != Type::Void && !ir::always_returns(&body) {
            return Err(self.refuse(
                signature.node,
                "non-void function fallthrough is not ported",
            ));
        }
        Ok(Function {
            name: signature.name,
            params: signature.params,
            return_type: signature.return_type,
            locals: std::mem::take(&mut self.locals),
            body,
            loc: self.loc(signature.node),
        })
    }

    fn primitive_type(&self, flags: TypeFlags) -> Option<Type> {
        if flags.intersects(TypeFlags::NUMBER_LIKE) {
            Some(Type::F64)
        } else if flags.intersects(TypeFlags::STRING_LIKE) {
            Some(Type::String)
        } else if flags.intersects(TypeFlags::BOOLEAN_LIKE) {
            Some(Type::Bool)
        } else {
            None
        }
    }
    fn type_id(&mut self, id: TypeId) -> Option<Type> {
        if let Some(ty) = self.primitive_type(self.checker.ty(id).flags) {
            return Some(ty);
        }
        if self.checker.is_array_type(id) {
            let element = self.checker.get_element_type_of_array_type(id);
            return match self.primitive_type(self.checker.ty(element).flags)? {
                Type::String => Some(builtins::STRINGS),
                Type::F64 => Some(Type::Array { elem: &Type::F64 }),
                Type::Bool => Some(Type::Array { elem: &Type::Bool }),
                _ => None,
            };
        }
        self.aggregate_type(id)
    }
    fn loc(&self, node: Node) -> Loc {
        Loc {
            file: self.file.clone(),
            start: node.pos().max(0),
            end: node.end(),
        }
    }
    fn refuse(&self, node: Node, detail: &str) -> String {
        format!(
            "SCN1001: {}:{}..{}: {detail} ({:?}); native subset only, no fallback",
            self.file,
            node.pos(),
            node.end(),
            node.kind()
        )
    }
    fn ty(&mut self, node: Node) -> Result<Type, String> {
        let id = self.checker.get_type_at_location(node);
        self.type_id(id).ok_or_else(|| {
            self.refuse(
                node,
                "type has no representation in the first native IR subset",
            )
        })
    }
    fn storage_type(&mut self, node: Node) -> Result<Type, String> {
        let ty = self.ty(node)?;
        if matches!(ty, Type::Null | Type::Undefined) {
            return Err(self.refuse(
                node,
                "standalone unit storage outside a union is not ported",
            ));
        }
        Ok(ty)
    }
    fn binding(&mut self, node: Node) -> Result<Local, String> {
        let symbol = self.symbol(node);
        self.bindings
            .get(&symbol)
            .cloned()
            .ok_or_else(|| self.refuse(node, "unlowered binding"))
    }
    fn statements(&mut self, nodes: goport_core::prelude::NodeSlice) -> Result<Vec<Stmt>, String> {
        let mut out = Vec::new();
        for node in nodes {
            out.extend(self.statement(node)?);
        }
        Ok(out)
    }
    fn statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let loc = self.loc(node);
        let stmt = match node.kind() {
            SyntaxKind::FunctionDeclaration
                if self.return_type.is_none()
                    && self
                        .functions
                        .values()
                        .any(|signature| signature.node == node) =>
            {
                return Ok(vec![]);
            }
            SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration => return Ok(vec![]),
            SyntaxKind::ReturnStatement => {
                let ret = self
                    .return_type
                    .ok_or_else(|| self.refuse(node, "return outside a function"))?;
                let value = if node.expression().is_nil() {
                    None
                } else {
                    Some(self.expected_expression(node.expression(), ret)?)
                };
                if value.as_ref().map_or(Type::Void, Expr::ty) != ret {
                    return Err(self.refuse(node, "return coercion is not ported"));
                }
                Stmt::Return { value, loc }
            }
            SyntaxKind::EmptyStatement
            | SyntaxKind::InterfaceDeclaration
            | SyntaxKind::TypeAliasDeclaration => return Ok(vec![]),
            SyntaxKind::Block => Stmt::Block {
                body: self.statements(node.statements())?,
                loc,
            },
            SyntaxKind::VariableStatement => {
                let list = node.declaration_list();
                let flags = list.flags();
                if !flags.intersects(NodeFlags::LET | NodeFlags::CONST) {
                    return Err(self.refuse(node, "var hoisting is not ported"));
                }
                let mut out = Vec::new();
                for declaration in list.declarations().nodes() {
                    let name = declaration.name();
                    if name.kind() != SyntaxKind::Identifier || declaration.initializer().is_nil() {
                        return Err(self.refuse(
                            declaration,
                            "initialized identifier declarations are required",
                        ));
                    }
                    let ty = self.storage_type(name)?;
                    let init = self.expected_expression(declaration.initializer(), ty)?;
                    if ty != init.ty() {
                        return Err(self.refuse(declaration, "coercion is not ported"));
                    }
                    let local = Local {
                        id: format!("v{}", self.locals.len()),
                        name: name.text().into(),
                        r#type: ty,
                        mutable: !flags.intersects(NodeFlags::CONST),
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
                    if expression.left().kind() == SyntaxKind::PropertyAccessExpression {
                        return Ok(vec![self.record_set(expression)?]);
                    }
                    if expression.left().kind() != SyntaxKind::Identifier {
                        return Err(self.refuse(expression, "only local assignment is ported"));
                    }
                    let local = self.binding(expression.left())?;
                    let value = self.expected_expression(expression.right(), local.r#type)?;
                    Stmt::Assign {
                        local_id: local.id,
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
            SyntaxKind::IfStatement => {
                let cond = self.expression(node.expression())?;
                if cond.ty() != Type::Bool {
                    return Err(self.refuse(node, "truthiness coercions are not ported"));
                }
                Stmt::If {
                    cond,
                    then: self.statement(node.then_statement())?,
                    else_: if node.else_statement().is_nil() {
                        None
                    } else {
                        Some(self.statement(node.else_statement())?)
                    },
                    loc,
                }
            }
            _ => return Err(self.refuse(node, "statement is not ported")),
        };
        Ok(vec![stmt])
    }
    fn expression(&mut self, node: Node) -> Result<Expr, String> {
        if let Some(value) = self.json_value(node) {
            return self.json_expression(node, value);
        }
        let loc = self.loc(node);
        match node.kind() {
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
                let r#type = self.ty(node)?;
                let elems = node
                    .elements()
                    .into_iter()
                    .map(|element| self.expression(element))
                    .collect::<Result<Vec<_>, _>>()?;
                if !matches!(r#type, Type::Array { .. }) {
                    return Err(self.refuse(node, "only primitive array literals are ported"));
                }
                Ok(Expr::ArrayLit { elems, r#type, loc })
            }
            SyntaxKind::PropertyAccessExpression
                if node.name().text() == "platform"
                    && self.native_namespace(node.expression()) == Some("process") =>
            {
                Ok(Expr::LibCall {
                    r#fn: "process.platform".into(),
                    args: vec![],
                    r#type: Type::String,
                    loc,
                })
            }
            SyntaxKind::ParenthesizedExpression => self.expression(node.expression()),
            SyntaxKind::PropertyAccessExpression => self.record_get(node),
            SyntaxKind::NumericLiteral => {
                let text = node.text().replace('_', "");
                let value = goport_core::jsnum::from_string(&text).value();
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
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => {
                let bytes = goport_core::scanner_util::go_string_bytes(node.text());
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
                if node.text() == "undefined"
                    && symbol != 0
                    && !self.bindings.contains_key(&symbol)
                    && self
                        .checker
                        .sym(goport_core::prelude::SymbolId(symbol))
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
                self.narrowed(value, node)
            }
            SyntaxKind::PrefixUnaryExpression => {
                let op = match node.operator() {
                    SyntaxKind::MinusToken => "-",
                    SyntaxKind::ExclamationToken => "!",
                    _ => return Err(self.refuse(node, "unary operator is not ported")),
                };
                let operand = Box::new(self.expression(node.operand())?);
                if !matches!((op, operand.ty()), ("-", Type::F64) | ("!", Type::Bool)) {
                    return Err(self.refuse(node, "unary coercions are not ported"));
                }
                let r#type = self.ty(node)?;
                Ok(Expr::Unary {
                    op: op.into(),
                    operand,
                    r#type,
                    loc,
                })
            }
            SyntaxKind::BinaryExpression => {
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
                    _ => return Err(self.refuse(node, "binary operator is not ported")),
                };
                self.binary(node, op)
            }
            SyntaxKind::CallExpression => {
                let member = node.expression();
                if member.kind() == SyntaxKind::Identifier {
                    let symbol = self.symbol(member);
                    if let Some((module, name)) = self.native_functions.get(&symbol).cloned() {
                        return self.native_call(node, module, &name);
                    }
                } else if member.kind() == SyntaxKind::PropertyAccessExpression
                    && let Some(module) = self.native_namespace(member.expression())
                {
                    return self.native_call(node, module, member.name().text());
                }
                let symbol_node = if member.kind() == SyntaxKind::PropertyAccessExpression {
                    member.name()
                } else {
                    member
                };
                // A namespace identifier has no runtime evaluation. Other
                // receivers can have side effects and cannot be discarded.
                let namespace_call = if member.kind() == SyntaxKind::PropertyAccessExpression
                    && member.expression().kind() == SyntaxKind::Identifier
                {
                    let base = self
                        .checker
                        .get_symbol_at_location(member.expression(), false);
                    if base.0 != 0 && self.checker.sym(base).flags.intersects(SymbolFlags::ALIAS) {
                        let target = self.checker.get_aliased_symbol(base);
                        target.0 != 0
                            && self.checker.sym(target).value_declaration.kind()
                                == SyntaxKind::SourceFile
                    } else {
                        false
                    }
                } else {
                    false
                };
                if member.kind() == SyntaxKind::Identifier || namespace_call {
                    let symbol = self.symbol(symbol_node);
                    if let Some(signature) = self.functions.get(&symbol).cloned() {
                        let args = node
                            .arguments()
                            .into_iter()
                            .zip(&signature.params)
                            .map(|(arg, param)| self.expected_expression(arg, param.r#type))
                            .collect::<Result<Vec<_>, _>>()?;
                        if node.arguments().len() != signature.params.len()
                            || args
                                .iter()
                                .zip(&signature.params)
                                .any(|(arg, param)| arg.ty() != param.r#type)
                        {
                            return Err(self.refuse(node, "call arity/coercions are not ported"));
                        }
                        return Ok(Expr::Call {
                            callee: signature.name,
                            args,
                            r#type: signature.return_type,
                            loc,
                        });
                    }
                }
                if member.kind() != SyntaxKind::PropertyAccessExpression
                    || member.expression().kind() != SyntaxKind::Identifier
                    || member.expression().text() != "console"
                    || !matches!(member.name().text(), "log" | "error")
                {
                    return Err(
                        self.refuse(node, "only ambient console.log/error calls are ported")
                    );
                }
                let symbol = self
                    .checker
                    .get_symbol_at_location(member.expression(), false);
                if self.bindings.contains_key(&symbol.0) || self.functions.contains_key(&symbol.0) {
                    return Err(self.refuse(node, "shadowed console is not ambient"));
                }
                let mut args = Vec::new();
                for arg in node.arguments() {
                    args.push(self.expression(arg)?);
                }
                if args
                    .iter()
                    .any(|arg| !matches!(arg.ty(), Type::F64 | Type::String | Type::Bool))
                {
                    return Err(
                        self.refuse(node, "non-primitive console argument values are not ported")
                    );
                }
                if args.len() > 1
                    && args[0].ty() == Type::String
                    && !matches!(&args[0], Expr::StrLit { value, .. } if !value.contains('%'))
                {
                    return Err(self.refuse(node, "Node console format substitution is not ported"));
                }
                Ok(Expr::Intrinsic {
                    name: format!("console.{}", member.name().text()),
                    args,
                    r#type: Type::Void,
                    loc,
                })
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
