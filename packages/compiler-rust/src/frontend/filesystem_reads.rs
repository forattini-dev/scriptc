//! Whole-file source reads select their explicit text result before IR emission.
use super::*;

impl Lowerer<'_> {
    pub(super) fn fs_read_stream_origin(&mut self, node: Node) -> bool {
        let source = primitives::primitive_source(node);
        if source.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let callee = primitives::primitive_source(source.expression());
        if callee.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(callee);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| *module == "fs" && member == "createReadStream");
        }
        callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "createReadStream"
            && self.native_namespace(callee.expression()) == Some("fs")
    }

    pub(super) fn read_directory_call(&mut self, node: Node) -> Result<Expr, String> {
        self.read_directory_call_impl(node, false)
    }

    pub(super) fn async_read_directory_call(&mut self, node: Node) -> Result<Expr, String> {
        self.read_directory_call_impl(node, true)
    }

    fn read_directory_call_impl(&mut self, node: Node, promise: bool) -> Result<Expr, String> {
        let operation = if promise {
            "fs/promises.readdir"
        } else {
            "readdirSync"
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=2).contains(&arguments.len())
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                &format!("{operation} requires a path and optional plain options object"),
            ));
        }
        self.ensure_exception_classes(node)?;
        let path = self.expected_expression(arguments[0], Type::String)?;
        let dirents = if let Some(options) = arguments.get(1).copied() {
            let options = receivers::reference_node(options);
            if options.kind() != SyntaxKind::ObjectLiteralExpression
                || options.properties().len() != 1
            {
                return Err(self.refuse(
                    options,
                    &format!("{operation} options require exactly {{ withFileTypes: true }}"),
                ));
            }
            let property = options.properties().get(0);
            if property.kind() != SyntaxKind::PropertyAssignment
                || self.data_property_name(property.name()).as_deref() != Some("withFileTypes")
                || receivers::reference_node(property.initializer()).kind()
                    != SyntaxKind::TrueKeyword
            {
                return Err(self.refuse(
                    property,
                    &format!("{operation} options require exactly {{ withFileTypes: true }}"),
                ));
            }
            true
        } else {
            false
        };
        let result = if dirents {
            Type::Array {
                elem: Box::new(Type::Dirent),
            }
        } else {
            builtins::strings()
        };
        let result = if promise {
            Type::Promise {
                inner: Box::new(result),
            }
        } else {
            result
        };
        Ok(Expr::LibCall {
            r#fn: if (promise, dirents) == (true, true) {
                "fs.readdirDirentsPromise"
            } else if promise {
                "fs.readdirPromise"
            } else if dirents {
                "fs.readdirDirentsSync"
            } else {
                "fs.readdirSync"
            }
            .into(),
            args: vec![path],
            r#type: result,
            loc: self.loc(node),
        })
    }

    pub(super) fn read_file_call(&mut self, node: Node) -> Result<Expr, String> {
        self.read_file_call_impl(node, false)
    }

    pub(super) fn async_read_file_call(&mut self, node: Node) -> Result<Expr, String> {
        self.read_file_call_impl(node, true)
    }

    fn read_file_call_impl(&mut self, node: Node, promise: bool) -> Result<Expr, String> {
        let operation = if promise {
            "fs/promises.readFile"
        } else {
            "readFileSync"
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty()
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                &format!("{operation} needs a path without argument spreads"),
            ));
        }
        self.ensure_exception_classes(node)?;
        let mut stmts = Vec::new();
        let descriptor = !promise && self.ty(arguments[0]).ok() == Some(Type::F64);
        let path = if descriptor {
            self.expected_expression(arguments[0], Type::F64)?
        } else {
            self.filesystem_argument(
                arguments[0],
                Type::String,
                &format!("{operation} requires a represented string path or numeric descriptor"),
                &mut stmts,
            )?
        };
        if arguments.len() == 1 {
            return Ok(Expr::Sequence {
                stmts,
                result: Box::new(Expr::LibCall {
                    r#fn: if promise {
                        "fs.readFileBytesPromise"
                    } else if descriptor {
                        "fs.readFdBytesSync"
                    } else {
                        "fs.readFileBytesSync"
                    }
                    .into(),
                    args: vec![path],
                    r#type: if promise {
                        Type::Promise {
                            inner: Box::new(Type::bytes()),
                        }
                    } else {
                        Type::bytes()
                    },
                    loc: self.loc(node),
                }),
                r#type: if promise {
                    Type::Promise {
                        inner: Box::new(Type::bytes()),
                    }
                } else {
                    Type::bytes()
                },
                loc: self.loc(node),
            });
        }
        let options = receivers::reference_node(arguments[1]);
        let mut encoding = None;
        if options.kind() == SyntaxKind::ObjectLiteralExpression {
            for property in options.properties() {
                if property.kind() != SyntaxKind::PropertyAssignment {
                    return Err(self.refuse(
                        property,
                        &format!(
                            "{operation} options require plain literal encoding/flag properties"
                        ),
                    ));
                }
                let value = receivers::reference_node(property.initializer());
                match self.data_property_name(property.name()).as_deref() {
                    Some("encoding") if Self::filesystem_utf8_literal(value) => encoding = Some(value),
                    Some("flag") if value.kind() == SyntaxKind::StringLiteral && value.text() == "r" => {},
                    _ => return Err(self.refuse(property, &format!("{operation} options require literal utf8/utf-8 encoding and literal r flag"))),
                }
            }
        } else if Self::filesystem_utf8_literal(options) {
            encoding = Some(options);
        }
        let encoding = encoding.ok_or_else(|| self.refuse(options, &format!("{operation} requires literal utf8/utf-8 encoding; dynamic options are not ported")))?;
        let encoding = self.expression(encoding)?;
        for extra in arguments.into_iter().skip(2) {
            stmts.push(Stmt::Expression {
                expr: self.expression(extra)?,
                loc: self.loc(extra),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: if promise {
                    "fs.readFilePromise"
                } else if descriptor {
                    "fs.readFdSync"
                } else {
                    "fs.readFileSync"
                }
                .into(),
                args: vec![path, encoding],
                r#type: if promise {
                    Type::Promise {
                        inner: Box::new(Type::String),
                    }
                } else {
                    Type::String
                },
                loc: self.loc(node),
            }),
            r#type: if promise {
                Type::Promise {
                    inner: Box::new(Type::String),
                }
            } else {
                Type::String
            },
            loc: self.loc(node),
        })
    }
}
