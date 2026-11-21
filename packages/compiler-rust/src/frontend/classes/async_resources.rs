//! Node AsyncResource identity and its synchronous callback boundary.
use super::*;

pub(super) const CLASS: &str = "native_builtin_AsyncResource";

impl Lowerer<'_> {
    pub(super) fn standard_async_resource(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let info = self.checker.sym(SymbolId(symbol));
        info.name.as_ref() == "AsyncResource"
            && info.declarations.iter().copied().any(|declaration| {
                if declaration.kind() != SyntaxKind::ClassDeclaration
                    || !source_file_info(get_source_file_of_node(declaration))
                        .file_name
                        .replace('\\', "/")
                        .ends_with("/@types/node/async_hooks.d.ts")
                {
                    return false;
                }
                let mut owner = declaration.parent();
                while !owner.is_nil() {
                    if owner.kind() == SyntaxKind::ModuleDeclaration
                        && owner.name().kind() == SyntaxKind::StringLiteral
                        && matches!(owner.name().text(), "async_hooks" | "node:async_hooks")
                    {
                        return true;
                    }
                    owner = owner.parent();
                }
                false
            })
    }

    pub(super) fn async_resource_class(&mut self, site: Node) -> usize {
        if let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == CLASS)
        {
            return index;
        }
        let index = self.classes.definitions.len();
        self.classes.definitions.push(Definition {
            node: Node::NIL,
            name: CLASS.into(),
            file: "<builtin>".into(),
            base: None,
            resolved: true,
            resolving: false,
            signature: None,
            token: None,
            captures: Vec::new(),
        });
        self.classes.layouts.push(Some(ir::Class {
            name: CLASS.into(),
            js_name: "AsyncResource".into(),
            runtime: false,
            base: None,
            fields: vec![],
            captures: vec![],
            methods: vec![],
            method_names: vec![],
            symbol_methods: vec![],
            symbol_brand: None,
            loc: self.loc(site),
        }));
        index
    }

    pub(in crate::frontend) fn async_resource_call(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "runInAsyncScope"
        {
            return Ok(None);
        }
        let receiver = member.expression();
        let represented = if receiver.kind() == SyntaxKind::ThisKeyword {
            self.instance_this
                .as_ref()
                .map(|local| local.r#type.clone())
                .or_else(|| self.ty(receiver).ok())
        } else {
            self.ty(receiver).ok()
        };
        if !matches!(represented, Some(Type::Object { class_name }) if self.classes.subclass(&class_name, CLASS))
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() < 2
            || args
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "AsyncResource.runInAsyncScope requires fixed callback arguments",
            ));
        }
        let owner = self.expression(receiver)?;
        let callback = self.expected_expression(args[0], Type::Dyn)?;
        let forwarded = args
            .iter()
            .skip(1)
            .map(|argument| self.expected_expression(*argument, Type::Dyn))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: owner,
                loc: self.loc(receiver),
            }],
            result: Box::new(Expr::DynInvoke {
                recv: Box::new(callback),
                method: "call".into(),
                callee_name: "AsyncResource.runInAsyncScope".into(),
                optional: false,
                args: forwarded,
                r#type: Type::Dyn,
                loc: self.loc(node),
            }),
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
}
