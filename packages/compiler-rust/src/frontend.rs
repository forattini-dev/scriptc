//! Theo's Rust parser/binder/checker, directly linked. No compiler subprocess.
use crate::ir::{self, Expr, Function, Loc, Local, Module, Stmt, Type};
use goport_core::{
    checker::Checker,
    flags::{NodeFlags, TypeFlags},
    prelude::{Node, SyntaxKind, source_file_info},
    program,
};
use std::{collections::HashMap, path::Path};

pub const REVISION: &str = "780dc512d64f40afebffa6a7028207649fb7ed1c";

fn path_for_frontend(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        text.strip_prefix(r"\\?\")
            .unwrap_or(&text)
            .replace('\\', "/")
    }
}

pub fn lower(input: &Path, work: &Path) -> Result<Module, String> {
    if input.to_str().is_none() {
        return Err("SCN0001: non-Unicode input paths are not ported".into());
    }
    let source = path_for_frontend(input);
    let prelude = work.join("native-console.d.ts");
    std::fs::write(&prelude, "declare const console: { log(...values: unknown[]): void; error(...values: unknown[]): void; };\n").map_err(|e| e.to_string())?;
    let config = work.join("tsconfig.json");
    let json = serde_json::json!({ "compilerOptions": {
        "target": "es2022", "lib": ["es2022"], "strict": true, "types": [],
        "noEmit": true, "allowJs": true, "checkJs": true,
    }, "files": [source, prelude.to_string_lossy().replace('\\', "/")] });
    std::fs::write(
        &config,
        serde_json::to_vec(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    program::try_load_with(&config.to_string_lossy().replace('\\', "/"), |options| {
        options.checkers = Some(1);
    })?;
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
        };
        let body = lowerer.statements(file.statements())?;
        Ok(Module {
            ir_version: ir::VERSION,
            source_file: source.clone(),
            entry: "__main".into(),
            functions: vec![Function {
                name: "__main".into(),
                params: vec![],
                return_type: Type::Void,
                locals: lowerer.locals,
                body,
                loc: Loc {
                    file: source,
                    start: 0,
                    end: file.end(),
                },
            }],
        })
    })
}

struct Lowerer<'a> {
    checker: &'a mut Checker,
    file: String,
    locals: Vec<Local>,
    bindings: HashMap<u32, Local>,
}

impl Lowerer<'_> {
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
        let flags = self.checker.ty(id).flags;
        if flags.intersects(TypeFlags::NUMBER_LIKE) {
            Ok(Type::F64)
        } else if flags.intersects(TypeFlags::STRING_LIKE) {
            Ok(Type::String)
        } else if flags.intersects(TypeFlags::BOOLEAN_LIKE) {
            Ok(Type::Bool)
        } else {
            Err(self.refuse(
                node,
                "type has no representation in the first native IR subset",
            ))
        }
    }
    fn binding(&mut self, node: Node) -> Result<Local, String> {
        let symbol = self.checker.get_symbol_at_location(node, false);
        self.bindings
            .get(&symbol.0)
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
                    let init = self.expression(declaration.initializer())?;
                    let ty = self.ty(name)?;
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
                    if expression.left().kind() != SyntaxKind::Identifier {
                        return Err(self.refuse(expression, "only local assignment is ported"));
                    }
                    let local = self.binding(expression.left())?;
                    let value = self.expression(expression.right())?;
                    Stmt::Assign {
                        local_id: local.id,
                        value,
                        loc,
                    }
                } else {
                    Stmt::Expression {
                        expr: self.expression(expression)?,
                        loc,
                    }
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
        let loc = self.loc(node);
        match node.kind() {
            SyntaxKind::ParenthesizedExpression => self.expression(node.expression()),
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
                let local = self.binding(node)?;
                Ok(Expr::VarRef {
                    local_id: local.id,
                    r#type: local.r#type,
                    loc,
                })
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
                    _ => return Err(self.refuse(node, "binary operator is not ported")),
                };
                let left = Box::new(self.expression(node.left())?);
                let right = Box::new(self.expression(node.right())?);
                if left.ty() != Type::F64 || right.ty() != Type::F64 {
                    return Err(self.refuse(node, "only numeric binary operands are ported"));
                }
                Ok(Expr::Bin {
                    op: op.into(),
                    left,
                    right,
                    r#type: self.ty(node)?,
                    loc,
                })
            }
            SyntaxKind::CallExpression => {
                let member = node.expression();
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
                if self.bindings.contains_key(&symbol.0) {
                    return Err(self.refuse(node, "shadowed console is not ambient"));
                }
                let mut args = Vec::new();
                for arg in node.arguments() {
                    args.push(self.expression(arg)?);
                }
                if args.iter().any(|arg| arg.ty() == Type::Void) {
                    return Err(
                        self.refuse(node, "undefined console argument values are not ported")
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
