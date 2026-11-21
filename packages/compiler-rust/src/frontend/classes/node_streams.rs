//! Node stream class identities used by source-defined subclasses.
use super::*;

pub(super) const TRANSFORM: &str = "native_builtin_Transform";
pub(super) const DUPLEX: &str = "native_builtin_Duplex";
pub(super) const READABLE: &str = "native_builtin_Readable";
pub(super) const WRITABLE: &str = "native_builtin_Writable";

impl Lowerer<'_> {
    fn standard_node_stream_class(&self, symbol: u32, name: &str) -> bool {
        if symbol == 0 {
            return false;
        }
        let info = self.checker.sym(SymbolId(symbol));
        info.name.as_ref() == name
            && info.declarations.iter().copied().any(|declaration| {
                if declaration.kind() != SyntaxKind::ClassDeclaration
                    || !source_file_info(get_source_file_of_node(declaration))
                        .file_name
                        .replace('\\', "/")
                        .ends_with("/@types/node/stream.d.ts")
                {
                    return false;
                }
                let mut owner = declaration.parent();
                while !owner.is_nil() {
                    if owner.kind() == SyntaxKind::ModuleDeclaration
                        && owner.name().kind() == SyntaxKind::StringLiteral
                        && matches!(owner.name().text(), "stream" | "node:stream")
                    {
                        return true;
                    }
                    owner = owner.parent();
                }
                false
            })
    }

    pub(super) fn standard_node_transform(&self, symbol: u32) -> bool {
        self.standard_node_stream_class(symbol, "Transform")
            || self.standard_node_stream_class(symbol, "PassThrough")
    }

    pub(super) fn standard_node_readable(&self, symbol: u32) -> bool {
        self.standard_node_stream_class(symbol, "Readable")
    }

    pub(super) fn standard_node_duplex(&self, symbol: u32) -> bool {
        self.standard_node_stream_class(symbol, "Duplex")
    }

    pub(super) fn standard_node_writable(&self, symbol: u32) -> bool {
        self.standard_node_stream_class(symbol, "Writable")
    }

    fn node_stream_class(&mut self, site: Node, name: &str, class_name: &str) -> usize {
        if let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)
        {
            return index;
        }
        let base = self.event_emitter_class(site);
        let index = self.classes.definitions.len();
        self.classes.definitions.push(Definition {
            node: Node::NIL,
            name: class_name.into(),
            file: "<builtin>".into(),
            base: Some(base),
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
            base: Some(event_emitters::CLASS.into()),
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

    pub(in crate::frontend) fn node_transform_class(&mut self, site: Node) -> usize {
        self.node_stream_class(site, "Transform", TRANSFORM)
    }

    pub(in crate::frontend) fn node_duplex_class(&mut self, site: Node) -> usize {
        if let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == DUPLEX)
        {
            return index;
        }
        let base = self.node_readable_class(site);
        let index = self.classes.definitions.len();
        self.classes.definitions.push(Definition {
            node: Node::NIL,
            name: DUPLEX.into(),
            file: "<builtin>".into(),
            base: Some(base),
            resolved: true,
            resolving: false,
            signature: None,
            token: None,
            captures: Vec::new(),
        });
        self.classes.layouts.push(Some(ir::Class {
            name: DUPLEX.into(),
            js_name: "Duplex".into(),
            runtime: false,
            base: Some(READABLE.into()),
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

    pub(in crate::frontend) fn node_readable_class(&mut self, site: Node) -> usize {
        self.node_stream_class(site, "Readable", READABLE)
    }

    pub(in crate::frontend) fn node_writable_class(&mut self, site: Node) -> usize {
        self.node_stream_class(site, "Writable", WRITABLE)
    }
}
