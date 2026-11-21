use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![
        Api::native(
            "bun:sqlite",
            "Database",
            Lowering::Special,
            vec![call!(
                "sqlite.open",
                [String, Type::F64],
                Type::F64,
                "sqlite_open"
            )],
            "Native SQLite database handle; filename plus normalized Bun open flags",
            &["tests/corpus/rust-native-sqlite/main.ts"],
        ),
        Api::native(
            "node:sqlite",
            "DatabaseSync",
            Lowering::Special,
            vec![Builtin {
                ir: "sqlite.open.node",
                args: vec![Type::String, Type::Dyn],
                result: Type::F64,
                implementation: Implementation::Emitter("values"),
            }],
            "Native SQLite database handle; filename plus normalized Node open options",
            &["tests/corpus/rust-native-node-sqlite/main.ts"],
        ),
        Api::native(
            "bun:sqlite",
            "close",
            Lowering::Special,
            vec![call!(
                "sqlite.close",
                [Type::F64],
                Type::Void,
                "sqlite_close"
            )],
            "Close an owned native SQLite database handle",
            &["tests/corpus/rust-native-sqlite/main.ts"],
        ),
        Api::native(
            "node:sqlite",
            "close",
            Lowering::Special,
            vec![call!(
                "sqlite.close",
                [Type::F64],
                Type::Void,
                "sqlite_close"
            )],
            "Close an owned native SQLite DatabaseSync handle",
            &["tests/corpus/rust-native-node-sqlite/main.ts"],
        ),
        Api::native(
            "node:sqlite",
            "exec",
            Lowering::Special,
            vec![call!(
                "sqlite.exec",
                [Type::F64, String],
                Type::Void,
                "sqlite_exec"
            )],
            "Execute one or more SQL statements without bindings",
            &["tests/corpus/rust-native-node-sqlite/main.ts"],
        ),
        Api::native(
            "node:sqlite",
            "prepare",
            Lowering::Special,
            vec![call!(
                "sqlite.prepare",
                [Type::F64, String],
                Type::F64,
                "sqlite_statement_prepare"
            )],
            "Prepare a statement retaining the owning database and SQL text",
            &["tests/corpus/rust-native-node-sqlite/statements.ts"],
        ),
        Api::native(
            "node:sqlite",
            "StatementSync",
            Lowering::Special,
            vec![
                call!(
                    "sqlite.statementSafe",
                    [Type::F64, Bool],
                    Type::Void,
                    "sqlite_statement_set_safe_integers"
                ),
                call!(
                    "sqlite.statementArrays",
                    [Type::F64, Bool],
                    Type::Void,
                    "sqlite_statement_set_return_arrays"
                ),
                Builtin {
                    ir: "sqlite.statementRun",
                    args: vec![
                        Type::F64,
                        Type::Array {
                            elem: Box::new(Type::Dyn),
                        },
                    ],
                    result: Type::Dyn,
                    implementation: Implementation::Emitter("values"),
                },
                Builtin {
                    ir: "sqlite.statementAll",
                    args: vec![
                        Type::F64,
                        Type::Array {
                            elem: Box::new(Type::Dyn),
                        },
                    ],
                    result: Type::Dyn,
                    implementation: Implementation::Emitter("values"),
                },
                Builtin {
                    ir: "sqlite.statementGet",
                    args: vec![
                        Type::F64,
                        Type::Array {
                            elem: Box::new(Type::Dyn),
                        },
                    ],
                    result: Type::Dyn,
                    implementation: Implementation::Emitter("values"),
                },
                Builtin {
                    ir: "sqlite.statementIterate",
                    args: vec![
                        Type::F64,
                        Type::Array {
                            elem: Box::new(Type::Dyn),
                        },
                    ],
                    result: Type::Dyn,
                    implementation: Implementation::Emitter("values"),
                },
            ],
            "Statement bindings and owning row materialization without borrowed SQLite values",
            &["tests/corpus/rust-native-node-sqlite/statements.ts"],
        ),
        Api::native(
            "bun:sqlite",
            "serialize",
            Lowering::Special,
            vec![call!(
                "sqlite.serialize",
                [Type::F64],
                Type::bytes(),
                "sqlite_id_serialize"
            )],
            "Serialize the main database into owned bytes",
            &["tests/corpus/rust-native-sqlite/main.ts"],
        ),
    ]
}
