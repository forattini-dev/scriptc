//! The standard DOM Event constructor's nominal identity.
use super::*;

pub(super) const CLASS: &str = "native_builtin_Event";
pub(super) const TARGET_CLASS: &str = "native_builtin_EventTarget";

impl Lowerer<'_> {
    pub(in crate::frontend) fn dom_event_call(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(
                member.name().text(),
                "preventDefault" | "stopPropagation" | "stopImmediatePropagation"
            )
        {
            return Ok(None);
        }
        let receiver = member.expression();
        let ty = if matches!(
            receiver.kind(),
            SyntaxKind::ThisKeyword | SyntaxKind::SuperKeyword
        ) {
            self.instance_this
                .as_ref()
                .map(|local| local.r#type.clone())
        } else {
            self.ty(receiver).ok()
        };
        if !matches!(&ty, Some(Type::Object { class_name }) if self.classes.subclass(class_name, CLASS))
        {
            return Ok(None);
        }
        if !matches!(&ty, Some(Type::Object { class_name }) if class_name == CLASS) {
            return Err(self.refuse(node, "native Event subclass initialization is not ported"));
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "native Event method extra arguments are not ported"));
        }
        let object = self.expression(receiver)?;
        Ok(Some(Expr::LibCall {
            r#fn: "dom.eventAction".into(),
            args: vec![
                object,
                Expr::StrLit {
                    value: member.name().text().into(),
                    r#type: Type::String,
                    loc: self.loc(member),
                },
            ],
            r#type: Type::Void,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn dom_target_call(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(
                member.name().text(),
                "addEventListener" | "removeEventListener" | "dispatchEvent"
            )
        {
            return Ok(None);
        }
        let receiver = member.expression();
        let represented = if receiver.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(receiver);
            self.bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .map(|local| local.r#type.clone())
                .or_else(|| self.ty(receiver).ok())
        } else if receiver.kind() == SyntaxKind::ThisKeyword {
            self.instance_this
                .as_ref()
                .map(|local| local.r#type.clone())
        } else {
            self.ty(receiver).ok()
        };
        let Some(Type::Object { class_name }) = represented else {
            return Ok(None);
        };
        if !self.classes.subclass(&class_name, TARGET_CLASS) {
            return Ok(None);
        }
        if self
            .classes
            .definitions
            .iter()
            .enumerate()
            .any(|(index, definition)| {
                definition.name == class_name
                    && self.classes.method(index, member.name().text()).is_some()
            })
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let dispatch = member.name().text() == "dispatchEvent";
        if (dispatch && arguments.len() != 1)
            || (!dispatch && !(2..=3).contains(&arguments.len()))
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "native EventTarget calls require fixed represented arguments",
            ));
        }
        let owner = self.expression(receiver)?;
        let owner = if owner.ty() == Type::Dyn {
            self.coerce(
                owner,
                Type::Object {
                    class_name: class_name.clone(),
                },
                receiver,
            )?
        } else {
            owner
        };
        let mut args = vec![owner];
        let operation = if dispatch {
            args.push(self.expected_expression(arguments[0], Type::Dyn)?);
            "dom.targetDispatch"
        } else {
            args.push(self.expected_expression(arguments[0], Type::String)?);
            args.push(self.expected_expression(arguments[1], Type::Dyn)?);
            let options = if let Some(argument) = arguments.get(2) {
                self.expected_expression(*argument, Type::Dyn)?
            } else {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?
            };
            args.push(options);
            if member.name().text() == "addEventListener" {
                "dom.targetAdd"
            } else {
                "dom.targetRemove"
            }
        };
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args,
            r#type: if dispatch { Type::Bool } else { Type::Void },
            loc: self.loc(node),
        }))
    }

    pub(super) fn standard_dom_event(&self, symbol: u32) -> bool {
        self.standard_dom_class(symbol, "Event")
    }

    pub(super) fn standard_event_target(&self, symbol: u32) -> bool {
        self.standard_dom_class(symbol, "EventTarget")
    }

    fn standard_dom_class(&self, symbol: u32, name: &str) -> bool {
        if symbol == 0 {
            return false;
        }
        let info = self.checker.sym(SymbolId(symbol));
        info.name.as_ref() == name
            && info.declarations.iter().copied().any(|declaration| {
                let path = source_file_info(get_source_file_of_node(declaration))
                    .file_name
                    .replace('\\', "/");
                (path.ends_with("/lib.dom.d.ts")
                    || path.ends_with("/lib.webworker.d.ts")
                    || (path.contains("/@types/node/")
                        && path.ends_with("/web-globals/events.d.ts")))
                    && matches!(
                        declaration.kind(),
                        SyntaxKind::InterfaceDeclaration | SyntaxKind::VariableDeclaration
                    )
            })
    }

    pub(super) fn dom_event_class(&mut self, site: Node) -> usize {
        self.dom_class(site, "Event", CLASS)
    }

    pub(super) fn event_target_class(&mut self, site: Node) -> usize {
        self.dom_class(site, "EventTarget", TARGET_CLASS)
    }

    fn dom_class(&mut self, site: Node, name: &str, class_name: &str) -> usize {
        if let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)
        {
            return index;
        }
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
            js_name: name.into(),
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
}
