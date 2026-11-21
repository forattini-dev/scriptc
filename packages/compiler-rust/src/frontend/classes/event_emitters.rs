//! Node's EventEmitter has one native class identity across CJS and ESM imports.
use super::*;

pub(super) const CLASS: &str = "native_builtin_EventEmitter";

fn events_specifier(node: Node) -> bool {
    node.kind() == SyntaxKind::StringLiteral && matches!(node.text(), "events" | "node:events")
}

impl Lowerer<'_> {
    pub(in crate::frontend) fn demand_event_emitter_extension_method(
        &mut self,
        node: Node,
    ) -> Result<(), String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || self.ty(member.expression()).ok() != Some(Type::Dyn)
        {
            return Ok(());
        }
        let checked = self.checker.get_type_at_location(member.expression());
        let inherited = self.checker.get_base_types(checked).to_vec().iter().any(|base| {
            matches!(self.type_id(*base), Some(Type::Object { class_name }) if self.classes.subclass(&class_name, CLASS))
        });
        if !inherited {
            return Ok(());
        }
        let name = member.name().text();
        let methods = (0..self.classes.definitions.len())
            .filter(|index| {
                self.classes
                    .subclass(&self.classes.definitions[*index].name, CLASS)
            })
            .filter_map(|index| {
                self.classes
                    .method(index, name)
                    .map(|(owner, method)| (owner, method))
            })
            .collect::<Vec<_>>();
        let mut seen = std::collections::HashSet::new();
        for (owner, method) in methods {
            if seen.insert(owner) {
                self.request_method(owner, name, method)?;
            }
        }
        Ok(())
    }

    pub(in crate::frontend) fn event_emitter_call(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() == SyntaxKind::PropertyAccessExpression
            && member.name().text() == "call"
            && member.expression().kind() == SyntaxKind::PropertyAccessExpression
        {
            let borrowed = member.expression();
            let prototype = borrowed.expression();
            let prototype_is_event_emitter = prototype.kind()
                == SyntaxKind::PropertyAccessExpression
                && prototype.name().text() == "prototype"
                && {
                    let class_node = prototype.expression();
                    let symbol = self.symbol(class_node);
                    self.class_symbol(class_node)
                        .is_some_and(|index| self.classes.definitions[index].name == CLASS)
                        || self.standard_event_emitter(symbol)
                };
            if prototype_is_event_emitter {
                let operation = match borrowed.name().text() {
                    "on" | "addListener" => Some("events.instanceOn"),
                    "prependListener" => Some("events.instancePrepend"),
                    "once" => Some("events.instanceOnce"),
                    "prependOnceListener" => Some("events.instancePrependOnce"),
                    "off" | "removeListener" => Some("events.instanceOff"),
                    _ => None,
                };
                if let Some(operation) = operation {
                    let arguments = node.arguments().into_iter().collect::<Vec<_>>();
                    if arguments.len() != 3
                        || arguments
                            .iter()
                            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                    {
                        return Err(self.refuse(
                            node,
                            "borrowed EventEmitter method requires receiver, event and listener",
                        ));
                    }
                    let owner = self.expression(arguments[0])?;
                    let owner = match owner.ty() {
                        Type::Object { ref class_name }
                            if self.classes.subclass(class_name, CLASS) =>
                        {
                            owner
                        }
                        _ => self.coerce(
                            owner,
                            Type::Object {
                                class_name: CLASS.into(),
                            },
                            arguments[0],
                        )?,
                    };
                    let event = self.expected_expression(arguments[1], Type::String)?;
                    let callback = self.expression(arguments[2])?;
                    let callback = self.coerce(callback, Type::Dyn, arguments[2])?;
                    return Ok(Some(Expr::LibCall {
                        r#fn: operation.into(),
                        args: vec![owner.clone(), event, callback],
                        r#type: owner.ty(),
                        loc: self.loc(node),
                    }));
                }
            }
        }
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = member.expression();
        if self.net_socket_type(receiver) {
            return Ok(None);
        }
        let represented = if matches!(
            receiver.kind(),
            SyntaxKind::ThisKeyword | SyntaxKind::SuperKeyword
        ) {
            self.instance_this
                .as_ref()
                .map(|local| local.r#type.clone())
                .or_else(|| self.ty(receiver).ok())
        } else {
            self.ty(receiver).ok()
        };
        let inherited_interface = if represented == Some(Type::Dyn) {
            let checked = self.checker.get_type_at_location(receiver);
            self.checker.get_base_types(checked).to_vec().iter().any(|base| {
                matches!(self.type_id(*base), Some(Type::Object { class_name }) if self.classes.subclass(&class_name, CLASS))
            })
        } else {
            false
        };
        if !inherited_interface
            && !matches!(represented, Some(Type::Object { class_name }) if self.classes.subclass(&class_name, CLASS))
        {
            return Ok(None);
        }
        let operation = match member.name().text() {
            "on" | "addListener" => "events.instanceOn",
            "prependListener" => "events.instancePrepend",
            "once" => "events.instanceOnce",
            "prependOnceListener" => "events.instancePrependOnce",
            "off" | "removeListener" => "events.instanceOff",
            "emit" => "events.instanceEmit",
            _ => return Ok(None),
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty()
            || (operation != "events.instanceEmit" && arguments.len() != 2)
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "EventEmitter method requires fixed native arguments"));
        }
        let owner = if receiver.kind() == SyntaxKind::SuperKeyword {
            self.this_expression(receiver)?
        } else {
            self.expression(receiver)?
        };
        let owner = if inherited_interface {
            self.coerce(
                owner,
                Type::Object {
                    class_name: CLASS.into(),
                },
                receiver,
            )?
        } else {
            owner
        };
        let event = self.expected_expression(arguments[0], Type::String)?;
        let mut args = vec![owner.clone(), event];
        for argument in arguments.iter().skip(1) {
            let value = self.expression(*argument)?;
            args.push(self.coerce(value, Type::Dyn, *argument)?);
        }
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args,
            r#type: if operation == "events.instanceEmit" {
                Type::Bool
            } else {
                owner.ty()
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn standard_event_emitter(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let info = self.checker.sym(SymbolId(symbol));
        if info.name.as_ref() != "EventEmitter" {
            return false;
        }
        info.declarations
            .iter()
            .copied()
            .any(|declaration| match declaration.kind() {
                SyntaxKind::ClassDeclaration
                    if source_file_info(get_source_file_of_node(declaration))
                        .file_name
                        .replace('\\', "/")
                        .ends_with("/@types/node/events.d.ts") =>
                {
                    let mut owner = declaration.parent();
                    while !owner.is_nil() && owner.kind() != SyntaxKind::ModuleDeclaration {
                        owner = owner.parent();
                    }
                    !owner.is_nil() && events_specifier(owner.name())
                }
                SyntaxKind::VariableDeclaration
                    if declaration.name().kind() == SyntaxKind::Identifier
                        && declaration.name().text() == "EventEmitter"
                        && declaration.parent().parent().parent().kind()
                            == SyntaxKind::SourceFile =>
                {
                    let initializer = declaration.initializer();
                    initializer.kind() == SyntaxKind::CallExpression
                        && initializer.expression().kind() == SyntaxKind::Identifier
                        && initializer.expression().text() == "require"
                        && initializer.arguments().len() == 1
                        && initializer
                            .arguments()
                            .into_iter()
                            .next()
                            .is_some_and(events_specifier)
                }
                SyntaxKind::ImportSpecifier
                    if declaration.property_name_or_name().text() == "EventEmitter" =>
                {
                    let mut owner = declaration;
                    while !owner.is_nil() && owner.kind() != SyntaxKind::ImportDeclaration {
                        owner = owner.parent();
                    }
                    !owner.is_nil() && events_specifier(owner.module_specifier())
                }
                SyntaxKind::ImportClause if !declaration.name().is_nil() => {
                    let owner = declaration.parent();
                    owner.kind() == SyntaxKind::ImportDeclaration
                        && events_specifier(owner.module_specifier())
                }
                _ => false,
            })
    }

    pub(in crate::frontend) fn event_emitter_class(&mut self, site: Node) -> usize {
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
            js_name: "EventEmitter".into(),
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
