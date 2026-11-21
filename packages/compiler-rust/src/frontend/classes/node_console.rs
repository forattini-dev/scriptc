//! `node:console` constructor identity for dependency-owned Console instances.
use super::*;

pub(super) const CLASS: &str = "native_builtin_Console";

impl Lowerer<'_> {
    pub(in crate::frontend) fn node_console_class(&mut self, site: Node) -> usize {
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
            js_name: "Console".into(),
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
