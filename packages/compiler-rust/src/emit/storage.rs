//! One live slot per module binding, independent of function capture frames.
use super::*;

fn name(module: &Emission<'_>, global: &crate::ir::Global) -> String {
    format!(
        "GLOBAL_{}",
        module
            .globals
            .iter()
            .position(|g| g.id == global.id)
            .unwrap()
    )
}

pub(super) fn definitions(module: &Emission<'_>, output: &mut String) {
    for (index, function) in module.functions.iter().enumerate() {
        if function.name.starts_with("%lazy_module_") {
            output.push_str(&format!("thread_local! {{ static MODULE_CACHE_{index}: std::cell::RefCell<Option<runtime::Gc<runtime::NativeModuleCache<()>>>> = const {{ std::cell::RefCell::new(None) }}; }}\n"));
            output.push_str(&format!("thread_local! {{ static MODULE_EVAL_{index}: std::cell::RefCell<Option<runtime::JsPromise<()>>> = const {{ std::cell::RefCell::new(None) }}; }}\n"));
            let initializer = super::function_name(&function.name);
            output.push_str(&format!("fn native_module_eval_{index}() {{ let (evaluation, start) = MODULE_EVAL_{index}.with(|slot| {{ let mut slot = slot.borrow_mut(); if let Some(value) = &*slot {{ (value.clone(), false) }} else {{ let value = runtime::promise_new(); *slot = Some(value.clone()); (value, true) }} }}); if start {{ runtime::module_evaluate_sync(&evaluation, || {initializer}()); }} else {{ runtime::module_cached_sync(&evaluation); }} }}\n"));
        }
    }
    for global in &module.globals {
        output.push_str(&format!("thread_local! {{ static {}: std::cell::RefCell<Option<{}>> = const {{ std::cell::RefCell::new(None) }}; }}\n", name(module, global), rust_type(global.r#type.clone(), module)));
    }
    output.push_str("fn clear_module_storage() {\n");
    for (index, function) in module.functions.iter().enumerate() {
        if function.name.starts_with("%lazy_module_") {
            output.push_str(&format!(
                "MODULE_CACHE_{index}.with(|slot| {{ slot.borrow_mut().take(); }});\n"
            ));
            output.push_str(&format!(
                "MODULE_EVAL_{index}.with(|slot| {{ slot.borrow_mut().take(); }});\n"
            ));
        }
    }
    if !module.classes.is_empty() {
        output.push_str("clear_class_storage();\n");
        output.push_str("CLASS_STATIC_SYMBOLS.with(|slots| slots.borrow_mut().clear());\n");
    }
    for global in module.globals.iter().rev() {
        output.push_str(&format!(
            "{}.with(|slot| {{ slot.borrow_mut().take(); }});\n",
            name(module, global)
        ));
    }
    output.push_str("}\n");
}

pub(super) fn read(module: &Emission<'_>, global: &crate::ir::Global) -> String {
    let message = format!("Cannot access '{}' before initialization", global.name);
    format!(
        "{}.with(|slot| slot.borrow().as_ref().cloned().unwrap_or_else(|| runtime::throw_reference_error({message:?}.into())))",
        name(module, global)
    )
}

pub(super) fn set_expression(
    module: &Emission<'_>,
    global: &crate::ir::Global,
    value: &str,
) -> String {
    let message = format!("Cannot access '{}' before initialization", global.name);
    format!(
        "{{ let value = {value}; {}.with(|cell| {{ let mut slot = cell.borrow_mut(); if slot.is_none() {{ runtime::throw_reference_error({message:?}.into()); }} *slot = Some(value); }}); }}",
        name(module, global)
    )
}

pub(super) fn write(
    module: &Emission<'_>,
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
