use super::Type;

pub fn signature(name: &str, args: &[Type], result: &Type) -> Option<bool> {
    let (arity, expected) = match name {
        "fs.namespace.existsSync" => (1, Type::Bool),
        "fs.namespace.lstatSync"
        | "fs.namespace.mkdirSync"
        | "fs.namespace.readdirSync"
        | "fs.namespace.readlinkSync" => (2, Type::Dyn),
        "fs.namespace.renameSync" => (2, Type::Void),
        "fs.namespace.rmSync" => (2, Type::Void),
        "fs.namespace.symlinkSync" => (3, Type::Void),
        "fs.namespace.unlinkSync" => (1, Type::Void),
        _ => return None,
    };
    Some(args.len() == arity && args.iter().all(|arg| *arg == Type::Dyn) && *result == expected)
}
