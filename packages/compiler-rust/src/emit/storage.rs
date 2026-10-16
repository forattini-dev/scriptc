//! One live slot per module binding, independent of function capture frames.
use super::*;

fn name(module: &Module, global: &crate::ir::Global) -> String {
    format!(
        "GLOBAL_{}",
        module
            .globals
            .iter()
            .position(|g| g.id == global.id)
            .unwrap()
    )
}

pub(super) fn definitions(module: &Module, output: &mut String) {
    for global in &module.globals {
        output.push_str(&format!("thread_local! {{ static {}: std::cell::RefCell<Option<{}>> = const {{ std::cell::RefCell::new(None) }}; }}\n", name(module, global), rust_type(global.r#type.clone())));
    }
    output.push_str("fn clear_module_storage() {\n");
    for global in module.globals.iter().rev() {
        output.push_str(&format!(
            "{}.with(|slot| {{ slot.borrow_mut().take(); }});\n",
            name(module, global)
        ));
    }
    output.push_str("}\n");
}

pub(super) fn read(module: &Module, global: &crate::ir::Global) -> String {
    let message = format!("Cannot access '{}' before initialization", global.name);
    format!(
        "{}.with(|slot| slot.borrow().as_ref().cloned().unwrap_or_else(|| runtime::throw_reference_error({message:?}.into())))",
        name(module, global)
    )
}

pub(super) fn write(
    module: &Module,
    function: &Function,
    stmt: &Stmt,
    global: &crate::ir::Global,
    value: String,
) -> String {
    let message = format!("Cannot access '{}' before initialization", global.name);
    let check = if module.initializes(stmt, function, &global.id) {
        "assert!(slot.is_none(), \"scriptc: repeated module initialization\");".to_string()
    } else {
        format!("if slot.is_none() {{ runtime::throw_reference_error({message:?}.into()); }}")
    };
    format!(
        "{{ let value = {value}; {}.with(|cell| {{ let mut slot = cell.borrow_mut(); {check} *slot = Some(value); }}); }}\n",
        name(module, global)
    )
}
