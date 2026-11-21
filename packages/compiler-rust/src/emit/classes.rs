//! One traced instance identity across ordinary and Error class hierarchies.
use super::*;
use std::fmt::Write;

pub(super) fn lazy_constructor_capture(
    function: &Function,
    id: &str,
    module: &Emission<'_>,
) -> bool {
    let Some(name) = function
        .name
        .strip_prefix('%')
        .and_then(|name| name.strip_suffix(".constructor"))
    else {
        return false;
    };
    let Some(class) = module.classes.iter().find(|class| class.name == name) else {
        return false;
    };
    if class.captures.is_empty() || function.params.len() < class.captures.len() {
        return false;
    }
    let captures = &function.params[function.params.len() - class.captures.len()..];
    if captures.iter().any(|param| {
        function
            .locals
            .iter()
            .any(|local| local.id == param.local_id && local.boxed)
    }) {
        return false;
    }
    captures.iter().any(|param| param.local_id == id)
}

fn undefined(module: &Emission<'_>, ty: &Type) -> String {
    if *ty == Type::Dyn {
        return "NativeValue::Undefined".into();
    }
    let Type::Union { union_id } = ty else {
        unreachable!("validated optional class slot")
    };
    let tag = module.unions[*union_id]
        .arms
        .iter()
        .position(|a| *a == Type::Undefined)
        .unwrap();
    format!("U{union_id}::V{tag}(())")
}

fn has_registry_brand(module: &Emission<'_>, class_name: &str) -> bool {
    let mut class = module.class(class_name);
    while let Some(current) = class {
        if current.symbol_brand.is_some() {
            return true;
        }
        class = current.base.as_deref().and_then(|base| module.class(base));
    }
    false
}

pub(super) fn definitions(module: &Emission<'_>, output: &mut String) {
    if module.classes.is_empty() {
        output.push_str("fn native_value_instanceof(value: NativeValue, constructor: NativeValue) -> bool { if let Some(result) = native_builtin_instanceof(&value, &constructor) { return result; } if !native_value_is_function(&constructor) { runtime::throw_type_error(\"Right-hand side of 'instanceof' is not callable\".into()); } false }\n");
        output.push_str("fn native_dom_event_method(_: &NativeValue, _: &str) -> bool { false }\nfn native_dom_event_invoke(_: &NativeValue, _: &str) -> Option<NativeValue> { None }\n");
        output.push_str("fn native_emitter_method(_: &NativeValue, _: &str) -> bool { false }\nfn native_emitter_invoke(_: &NativeValue, _: &str, _: &[NativeValue]) -> Option<NativeValue> { None }\nfn native_emitter_property(_: &NativeValue, _: &runtime::JsString) -> Option<NativeValue> { None }\nfn native_emitter_method_name(_: u8) -> &'static str { \"emit\" }\n");
        return;
    }
    output.push_str(include_str!("emitter_dynamic_support.rs"));
    output.push_str(include_str!("dom_event_support.rs"));
    output.push_str(include_str!("node_stream_support.rs"));
    // Supported definitions execute once at module scope; aliases retain the
    // same index and therefore the same owning data properties.
    output.push_str("#[derive(Clone, Copy, PartialEq)]\nstruct NativeClass(usize);\nimpl NativeTrace for NativeClass { fn trace_native(&self, _: &mut runtime::Tracer<'_>) {} }\nimpl runtime::ArrayElement for NativeClass {}\n");
    output.push_str("thread_local! { static CLASS_PARENT_OVERRIDES: std::cell::RefCell<Vec<Option<NativeClass>>> = const { std::cell::RefCell::new(Vec::new()) }; }\nfn native_class_set_parent(class: NativeClass, parent: NativeClass) { CLASS_PARENT_OVERRIDES.with(|slots| { let mut slots = slots.borrow_mut(); if slots.len() <= class.0 { slots.resize_with(class.0 + 1, || None); } slots[class.0] = Some(parent); }); }\n");
    let static_count = module.classes.len();
    writeln!(output, "#[derive(Clone)] enum NativeClassCapture {{ Value(NativeValue), Live(std::rc::Rc<dyn Fn() -> NativeValue>), Mutable(std::rc::Rc<dyn Fn() -> NativeValue>, std::rc::Rc<dyn Fn(NativeValue)>) }}\nstruct DynamicClassData {{ layout: usize, parent: Option<NativeClass>, captures: Vec<NativeClassCapture> }}\nthread_local! {{ static CLASS_PROPERTIES: std::cell::RefCell<Vec<Option<runtime::Gc<NativeRecordData>>>> = const {{ std::cell::RefCell::new(Vec::new()) }}; static DYNAMIC_CLASSES: std::cell::RefCell<Vec<DynamicClassData>> = const {{ std::cell::RefCell::new(Vec::new()) }}; }}\nfn native_class_properties(class: NativeClass) -> runtime::Gc<NativeRecordData> {{ CLASS_PROPERTIES.with(|slots| {{ let mut slots = slots.borrow_mut(); if slots.len() <= class.0 {{ slots.resize_with(class.0 + 1, || None); }} slots[class.0].get_or_insert_with(|| runtime::Gc::new(NativeRecordData {{ null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }})).clone() }}) }}\nfn native_class_create(layout: usize, parent: Option<NativeClass>, captures: Vec<NativeClassCapture>) -> NativeClass {{ DYNAMIC_CLASSES.with(|classes| {{ let mut classes = classes.borrow_mut(); let identity = {static_count} + classes.len(); classes.push(DynamicClassData {{ layout, parent, captures }}); NativeClass(identity) }}) }}\nfn native_class_layout(class: NativeClass) -> usize {{ if class.0 < {static_count} {{ class.0 }} else {{ DYNAMIC_CLASSES.with(|classes| classes.borrow()[class.0 - {static_count}].layout) }} }}\nfn native_class_captures(class: NativeClass) -> Vec<NativeValue> {{ if class.0 < {static_count} {{ Vec::new() }} else {{ let captures = DYNAMIC_CLASSES.with(|classes| classes.borrow()[class.0 - {static_count}].captures.clone()); captures.into_iter().map(|capture| match capture {{ NativeClassCapture::Value(value) => value, NativeClassCapture::Live(read) => read(), NativeClassCapture::Mutable(read, _) => read() }}).collect() }} }}\nfn clear_class_storage() {{ CLASS_PROPERTIES.with(|slots| slots.borrow_mut().clear()); CLASS_PARENT_OVERRIDES.with(|slots| slots.borrow_mut().clear()); DYNAMIC_CLASSES.with(|classes| classes.borrow_mut().clear()); }}\nfn native_class_parent(class: NativeClass) -> Option<NativeClass> {{ if class.0 >= {static_count} {{ return DYNAMIC_CLASSES.with(|classes| classes.borrow()[class.0 - {static_count}].parent); }} if let Some(parent) = CLASS_PARENT_OVERRIDES.with(|slots| slots.borrow().get(class.0).copied().flatten()) {{ return Some(parent); }} match class.0 {{").unwrap();
    for (index, class) in module.classes.iter().enumerate() {
        if let Some(base) = &class.base
            && let Some(parent) = module
                .classes
                .iter()
                .position(|candidate| &candidate.name == base)
        {
            writeln!(output, "{index} => Some(NativeClass({parent})),").unwrap();
        }
    }
    output.push_str("_ => None } }\nfn native_class_get(class: NativeClass, key: &runtime::JsString) -> Option<NativeValue> { let mut current = Some(class); while let Some(class) = current { let properties = native_class_properties(class); if let Some(value) = properties.with(|data| data.entries.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone())) { return Some(value); } current = native_class_parent(class); } None }\nfn native_class_symbol_define(class: NativeClass, key: runtime::JsSymbol, value: NativeValue) { let properties = native_class_properties(class); properties.with_mut(|data| { let table = data.symbol_properties.get_or_insert_with(runtime::DataPropertyTable::new); table.define(runtime::PropertyKey::Symbol(key), &runtime::DataDescriptor { value: Some(value), writable: Some(true), enumerable: Some(false), configurable: Some(true) }, true, NativeValue::Undefined, native_value_eq).unwrap_or_else(|_| runtime::throw_type_error(\"Cannot redefine class symbol method\".into())); }); }\nfn native_class_symbol_get(class: NativeClass, key: &runtime::JsSymbol) -> Option<NativeValue> { let mut current = Some(class); while let Some(class) = current { let properties = native_class_properties(class); if let Some(value) = properties.with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&runtime::PropertyKey::Symbol(key.clone()))).map(|property| property.value.clone())) { return Some(value); } current = native_class_parent(class); } None }\n");
    output.push_str("thread_local! { static CLASS_STATIC_SYMBOLS: std::cell::RefCell<Vec<Option<runtime::Gc<NativeRecordData>>>> = const { std::cell::RefCell::new(Vec::new()) }; }\nfn native_class_static_symbols(class: NativeClass) -> runtime::Gc<NativeRecordData> { CLASS_STATIC_SYMBOLS.with(|slots| { let mut slots = slots.borrow_mut(); if slots.len() <= class.0 { slots.resize_with(class.0 + 1, || None); } slots[class.0].get_or_insert_with(|| runtime::Gc::new(NativeRecordData { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() })).clone() }) }\nfn native_class_static_symbol_define(class: NativeClass, key: runtime::JsSymbol, value: NativeValue) { let properties = native_class_static_symbols(class); properties.with_mut(|data| { let table = data.symbol_properties.get_or_insert_with(runtime::DataPropertyTable::new); table.define(runtime::PropertyKey::Symbol(key), &runtime::DataDescriptor { value: Some(value), writable: Some(true), enumerable: Some(false), configurable: Some(true) }, true, NativeValue::Undefined, native_value_eq).unwrap_or_else(|_| runtime::throw_type_error(\"Cannot redefine static class symbol method\".into())); }); }\nfn native_class_static_symbol_get(class: NativeClass, key: &runtime::JsSymbol) -> Option<NativeValue> { let mut current = Some(class); while let Some(class) = current { let properties = native_class_static_symbols(class); if let Some(value) = properties.with(|data| data.symbol_properties.as_ref().and_then(|table| table.get(&runtime::PropertyKey::Symbol(key.clone()))).map(|property| property.value.clone())) { return Some(value); } current = native_class_parent(class); } None }\n");
    output.push_str("fn native_class_is_weak_map(class: NativeClass) -> bool { matches!(native_class_layout(class), usize::MAX");
    for (index, class) in module.classes.iter().enumerate() {
        if class.name == "native_builtin_WeakMap" {
            write!(output, " | {index}").unwrap();
        }
    }
    output.push_str(") }
");
    // `Klass.name` / `instance.constructor.name`: the JavaScript class name.
    output.push_str("fn native_class_js_name(class: NativeClass) -> &'static str { match native_class_layout(class) {
");
    for (index, class) in module.classes.iter().enumerate() {
        writeln!(output, "{index} => {:?},", class.js_name).unwrap();
    }
    output.push_str("_ => \"\" } }
");
    output.push_str("fn native_instance_method_class(mut class: NativeClass, owner: usize) -> usize { loop { if native_class_layout(class) == owner { return class.0; } match native_class_parent(class) { Some(parent) => class = parent, None => return class.0 } } }\n");
    output.push_str("fn native_class_brand_get(class: NativeClass, key: &runtime::JsSymbol) -> bool { let mut current = Some(class); while let Some(class) = current { match native_class_layout(class) {\n");
    for (index, class) in module.classes.iter().enumerate() {
        if let Some(brand) = &class.symbol_brand {
            writeln!(output, "{index} if runtime::symbol_ptr_eq(key, &runtime::symbol_for(&runtime::string({brand:?}))) => return true,").unwrap();
        }
    }
    output.push_str("_ => {} } current = native_class_parent(class); } false }\nfn native_class_instanceof(value: NativeValue, class: NativeClass) -> bool { let mut current = Some(class); while let Some(candidate) = current { match native_class_layout(candidate) {\n");
    for (index, class) in module.classes.iter().enumerate() {
        if let Some(brand) = &class.symbol_brand {
            writeln!(output, "{index} => return match value {{ NativeValue::Instance(_) | NativeValue::Object(_) | NativeValue::Record(..) | NativeValue::Callable(_) => matches!(native_value_symbol_get(value, runtime::symbol_for(&runtime::string({brand:?}))), NativeValue::Boolean(true)), _ => false }},").unwrap();
        }
    }
    output.push_str("_ => {} } current = native_class_parent(candidate); } match value { NativeValue::Instance(object) => { let mut current = Some(object.with(|object| object.class)); while let Some(candidate) = current { if candidate == class { return true; } current = native_class_parent(candidate); } false }, _ => false } }\n");
    let constructors = module
        .classes
        .iter()
        .map(|class| {
            let ty = Type::Classval {
                class_name: class.name.clone(),
            };
            let id = module.value_type_id(&ty);
            format!("NativeValue::V{id}(class) => class,")
        })
        .collect::<String>();
    writeln!(output, "fn native_value_instanceof(value: NativeValue, constructor: NativeValue) -> bool {{ if let Some(result) = native_builtin_instanceof(&value, &constructor) {{ return result; }} let target = match constructor {{ {constructors} _ => runtime::throw_type_error(\"Right-hand side of 'instanceof' is not callable\".into()), }}; native_class_instanceof(value, target) }}").unwrap();
    writeln!(output, "fn native_class_capture(class: NativeClass, index: usize) -> NativeValue {{ let capture = DYNAMIC_CLASSES.with(|classes| classes.borrow()[class.0 - {static_count}].captures[index].clone()); match capture {{ NativeClassCapture::Value(value) => value, NativeClassCapture::Live(read) => read(), NativeClassCapture::Mutable(read, _) => read() }} }}\nfn native_class_capture_set(class: NativeClass, index: usize, value: NativeValue) -> NativeValue {{ let capture = DYNAMIC_CLASSES.with(|classes| classes.borrow()[class.0 - {static_count}].captures[index].clone()); match capture {{ NativeClassCapture::Mutable(_, write) => {{ write(value.clone()); value }}, _ => runtime::throw_type_error(\"Assignment to immutable class capture\".into()) }} }}").unwrap();
    writeln!(output, "fn native_class_capture_bindings(class: NativeClass) -> Vec<NativeClassCapture> {{ if class.0 < {static_count} {{ Vec::new() }} else {{ DYNAMIC_CLASSES.with(|classes| classes.borrow()[class.0 - {static_count}].captures.clone()) }} }}\nfn native_class_capture_value(capture: &NativeClassCapture) -> NativeValue {{ match capture {{ NativeClassCapture::Value(value) => value.clone(), NativeClassCapture::Live(read) => read(), NativeClassCapture::Mutable(read, _) => read() }} }}").unwrap();
    output.push_str("struct NativeErrorData { name: NativeValue, message: NativeValue, own: Vec<(runtime::JsString, NativeValue)> }\nstruct NativeInstance { kind: usize, class: NativeClass, error: Option<NativeErrorData>, emitter: Option<runtime::JsEventEmitter<NativeValue>>, dom_target: Option<runtime::JsDomTarget<NativeValue>>, dom_event: Option<runtime::JsDomEvent<NativeValue>>, stream_destroyed: bool, symbol_properties: Option<runtime::DataPropertyTable<NativeValue>>, own_keys: Vec<runtime::JsString>, fields: NativeInstanceFields }\nenum NativeInstanceFields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        writeln!(output, "C{index} {{").unwrap();
        for field in class.fields.iter().skip(module.class_header_len(class)) {
            writeln!(
                output,
                "{}: Option<{}>,",
                field_name(&field.name),
                rust_type(field.r#type.clone(), module)
            )
            .unwrap();
        }
        output.push_str("},\n");
    }
    output.push_str("}\nimpl runtime::Trace for NativeInstance { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { if let Some(error) = &self.error { for (_, value) in &error.own { value.trace_native(tracer); } } if let Some(emitter) = &self.emitter { tracer.edge(emitter); } if let Some(target) = &self.dom_target { tracer.edge(target); } if let Some(event) = &self.dom_event { tracer.edge(event); } if let Some(properties) = &self.symbol_properties { properties.trace_values(|value| value.trace_native(tracer)); } match &self.fields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        let names = class
            .fields
            .iter()
            .skip(module.class_header_len(class))
            .map(|f| field_name(&f.name))
            .collect::<Vec<_>>();
        writeln!(
            output,
            "NativeInstanceFields::C{index} {{ {} }} => {{",
            names.join(", ")
        )
        .unwrap();
        for name in names {
            writeln!(
                output,
                "if let Some(value) = {name} {{ value.trace_native(tracer); }}"
            )
            .unwrap();
        }
        output.push_str("},\n");
    }
    output.push_str("} } }\nimpl runtime::ClearEdges for NativeInstance { fn clear_edges(&mut self) { if let Some(error) = &mut self.error { error.own.clear(); } self.emitter = None; self.dom_target = None; self.dom_event = None; self.symbol_properties = None; self.own_keys.clear(); match &mut self.fields {\n");
    for (index, class) in module.classes.iter().enumerate() {
        let names = class
            .fields
            .iter()
            .skip(module.class_header_len(class))
            .map(|f| field_name(&f.name))
            .collect::<Vec<_>>();
        writeln!(
            output,
            "NativeInstanceFields::C{index} {{ {} }} => {{",
            names.join(", ")
        )
        .unwrap();
        for name in names {
            writeln!(output, "*{name} = None;").unwrap();
        }
        output.push_str("},\n");
    }
    output.push_str("} } }\n");
    output.push_str("fn native_instance_own_keys(object: &runtime::Gc<NativeInstance>) -> Vec<runtime::JsString> { object.with(|object| { let mut keys: Vec<runtime::JsString> = object.error.as_ref().map(|error| error.own.iter().map(|(key, _)| key.clone()).collect()).unwrap_or_default(); for key in &object.own_keys { if !keys.contains(key) { keys.push(key.clone()); } } keys }) }\n");
    output.push_str("fn error_string(object: runtime::Gc<NativeInstance>) -> runtime::JsString { match object.with(|object| object.kind) {\n");
    for (index, class) in module.classes.iter().enumerate() {
        if !module.subclass(&class.name, "%Error") {
            continue;
        }
        if let Some(method) = module.method(&class.name, "toString") {
            if method.params.len() == 1 {
                let result = format!("{}(object.clone())", function_name(&method.name));
                let boxed = values::box_value(&method.return_type, &result, module);
                writeln!(output, "{index} => native_value_string({boxed}),").unwrap();
            } else {
                writeln!(output, "{index} => runtime::throw_type_error(\"Error.toString override needs zero source parameters and no class captures\".into()),").unwrap();
            }
        }
    }
    output.push_str("_ => object.with(|object| { let e = object.error.as_ref().expect(\"validated Error receiver\"); let name = if matches!(&e.name, NativeValue::Undefined) { runtime::string(\"Error\") } else { native_value_string(e.name.clone()) }; let message = if matches!(&e.message, NativeValue::Undefined) { runtime::JsString::default() } else { native_value_string(e.message.clone()) }; if name.is_empty() { message } else if message.is_empty() { name } else { runtime::string_concat(&runtime::string_concat(&name, &runtime::string(\": \")), &message) } }) } }\n");
    for (index, class) in module.classes.iter().enumerate() {
        let mut builtin = class;
        while let Some(base) = &builtin.base {
            builtin = module.class(base).unwrap();
        }
        let error = if builtin.runtime {
            // Native subclasses inherit the builtin Error name, not their class name.
            let mut native = class;
            while !native.runtime {
                native = module.class(native.base.as_ref().unwrap()).unwrap();
            }
            format!(
                "Some(NativeErrorData {{ name: NativeValue::String(runtime::JsString::from({:?})), message: NativeValue::Undefined, own: Vec::new() }})",
                native.js_name
            )
        } else {
            "None".into()
        };
        let fields = class
            .fields
            .iter()
            .skip(module.class_header_len(class))
            .map(|f| format!("{}: None", field_name(&f.name)))
            .collect::<Vec<_>>()
            .join(", ");
        let emitter = if module.subclass(&class.name, "native_builtin_EventEmitter") {
            "Some(runtime::emitter_new())"
        } else {
            "None"
        };
        let dom_target = if module.subclass(&class.name, "native_builtin_EventTarget") {
            "Some(runtime::dom_target_new())"
        } else {
            "None"
        };
        writeln!(output, "fn instance_allocate_{index}(class: NativeClass) -> runtime::Gc<NativeInstance> {{ debug_assert!(native_class_layout(class) == {index}); runtime::Gc::new(NativeInstance {{ kind: {index}, class, error: {error}, emitter: {emitter}, dom_target: {dom_target}, dom_event: None, stream_destroyed: false, symbol_properties: None, own_keys: Vec::new(), fields: NativeInstanceFields::C{index} {{ {fields} }} }}) }}").unwrap();
        let descendants = module
            .classes
            .iter()
            .enumerate()
            .filter(|(_, c)| module.subclass(&c.name, &class.name))
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        let kinds = descendants
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(" | ");
        writeln!(output, "fn instance_is_{index}(object: runtime::Gc<NativeInstance>) -> bool {{ object.with(|object| matches!(object.kind, {kinds})) }}").unwrap();
        for field in class
            .fields
            .iter()
            .filter(|field| !field.name.starts_with('%'))
        {
            let name = field_name(&field.name);
            let ty = rust_type(field.r#type.clone(), module);
            if module.class_header_len(class) != 0
                && matches!(field.name.as_str(), "name" | "message")
            {
                writeln!(output, "fn instance_get_{index}_{name}(object: runtime::Gc<NativeInstance>) -> {ty} {{ object.with(|object| object.error.as_ref().expect(\"validated Error receiver\").{}.clone()) }}\nfn instance_set_{index}_{name}(object: runtime::Gc<NativeInstance>, value: {ty}) {{ object.with_mut(|object| object.error.as_mut().expect(\"validated Error receiver\").{} = value); }}", field.name, field.name).unwrap();
                continue;
            }
            writeln!(output, "fn instance_get_{index}_{name}(object: runtime::Gc<NativeInstance>) -> {ty} {{ object.with(|object| match &object.fields {{").unwrap();
            for descendant in &descendants {
                writeln!(output, "NativeInstanceFields::C{descendant} {{ {name}, .. }} => {name}.clone().unwrap_or_else(|| {}),", undefined(module, &field.r#type)).unwrap();
            }
            output.push_str("_ => unreachable!(\"scriptc: invalid class receiver\"), }) }\n");
            writeln!(output, "fn instance_set_{index}_{name}(object: runtime::Gc<NativeInstance>, value: {ty}) {{ object.with_mut(|object| {{ let key = runtime::JsString::from({:?}); if !object.own_keys.contains(&key) {{ object.own_keys.push(key); }} match &mut object.fields {{", field.name).unwrap();
            for descendant in &descendants {
                writeln!(
                    output,
                    "NativeInstanceFields::C{descendant} {{ {name}, .. }} => *{name} = Some(value),"
                )
                .unwrap();
            }
            output.push_str("_ => unreachable!(\"scriptc: invalid class receiver\"), } }); }\n");
        }
    }
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let class_index = |name: &str| module.classes.iter().position(|c| c.name == name).unwrap();
    Some(match value {
        Expr::VirtualCall {
            class_name,
            method,
            args,
            r#type,
            ..
        } => {
            let evaluate = args
                .iter()
                .enumerate()
                .map(|(index, arg)| format!("let arg{index} = {};", expr(arg, function, module)))
                .collect::<String>();
            let cases = module
                .classes
                .iter()
                .enumerate()
                .filter(|(_, class)| module.subclass(&class.name, class_name))
                .map(|(index, class)| {
                    let target = module
                        .method(&class.name, method)
                        .expect("validated inherited dispatch");
                    let arguments = target
                        .params
                        .iter()
                        .enumerate()
                        .map(|(argument, parameter)| {
                            if argument < args.len() {
                                let source = args[argument].ty();
                                if parameter.r#type == Type::Dyn && source != Type::Dyn {
                                    values::box_value(&source, &format!("arg{argument}"), module)
                                } else {
                                    format!("arg{argument}")
                                }
                            } else {
                                undefined(module, &parameter.r#type)
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    let call = format!("{}({arguments})", function_name(&target.name));
                    if *r#type == Type::Dyn && target.call_result() == Type::Void {
                        format!("{index} => {{ let _ = {call}; NativeValue::Undefined }},")
                    } else if *r#type == Type::Dyn && target.call_result() != Type::Dyn {
                        let result = values::box_value(&target.call_result(), &call, module);
                        format!("{index} => {result},")
                    } else if *r#type == Type::Void && target.call_result() != Type::Void {
                        format!("{index} => {{ let _ = {call}; () }},")
                    } else {
                        format!("{index} => {call},")
                    }
                })
                .collect::<String>();
            format!(
                "{{ {evaluate} let kind = arg0.with(|object| object.kind); match kind {{ {cases} _ => unreachable!(\"validated native method receiver\"), }} }}"
            )
        }
        Expr::ClassRef { class_name, .. } => format!("NativeClass({})", class_index(class_name)),
        Expr::ClassCreate {
            class_name,
            parent,
            captures,
            ..
        } => {
            let captures = captures
                .iter()
                .map(|capture| {
                    let boxed = values::box_value(&capture.ty(), &expr(capture, function, module), module);
                    // Mutable lexical bindings are cells, and module bindings are
                    // global slots. The class retains the binding, not its value
                    // at definition time, including through a narrowing view.
                    let mut source = capture;
                    while let Expr::UnionNarrow { value, .. } | Expr::DynFrom { value, .. } | Expr::DynCheck { value, .. } | Expr::UnionWrap { value, .. } | Expr::UnionProject { value, .. } = source {
                        source = value;
                    }
                    if let Expr::VarRef { local_id, .. } = source {
                        if let Some(global) = module.global(local_id) {
                            if global.mutable {
                                let assigned = values::checked_value(&capture.ty(), "value", module);
                                let write = storage::set_expression(module, global, &assigned);
                                return format!("NativeClassCapture::Mutable(std::rc::Rc::new(move || {boxed}), std::rc::Rc::new(move |value| {write}))");
                            }
                            return format!("NativeClassCapture::Live(std::rc::Rc::new(move || {boxed}))");
                        }
                        if function.locals.iter().any(|local| local.id == *local_id && local.boxed) {
                            return format!("{{ let {local_id} = {local_id}.clone(); NativeClassCapture::Live(std::rc::Rc::new(move || {boxed})) }}");
                        }
                    }
                    format!("NativeClassCapture::Value({boxed})")
                })
                .collect::<Vec<_>>()
                .join(", ");
            let parent = parent
                .as_ref()
                .map(|parent| format!("Some({})", expr(parent, function, module)))
                .unwrap_or_else(|| "None".into());
            format!(
                "native_class_create({}, {parent}, vec![{captures}])",
                class_index(class_name)
            )
        }
        Expr::NewValue {
            args,
            r#type: Type::Object { class_name },
            ..
        }
        | Expr::New {
            class_name, args, ..
        } => {
            let index = class_index(class_name);
            let class_value = if let Expr::NewValue { callee, .. } = value {
                format!(
                    "let class = {}; debug_assert!(native_class_layout(class) == {index});",
                    expr(callee, function, module)
                )
            } else {
                format!("let class = NativeClass({index});")
            };
            let evaluate = args
                .iter()
                .enumerate()
                .map(|(i, arg)| format!("let arg{i} = {};", expr(arg, function, module)))
                .collect::<String>();
            let args = (0..args.len())
                .map(|i| format!(", arg{i}"))
                .collect::<String>();
            let ctor = function_name(&format!("%{class_name}.constructor"));
            let constructor = module
                .functions
                .iter()
                .find(|function| function.name == format!("%{class_name}.constructor"))
                .expect("validated constructor");
            let lazy = constructor.params.last().is_some_and(|param| {
                lazy_constructor_capture(constructor, &param.local_id, module)
            });
            let captures = module.classes[index]
                .captures
                .iter()
                .enumerate()
                .map(|(capture, ty)| {
                    if lazy {
                        format!(", class_captures[{capture}].clone()")
                    } else {
                        format!(
                            ", {}",
                            values::checked_value(
                                ty,
                                &format!("class_captures[{capture}].clone()"),
                                module
                            )
                        )
                    }
                })
                .collect::<String>();
            let capture_reader = if lazy {
                "native_class_capture_bindings"
            } else {
                "native_class_captures"
            };
            format!(
                "{{ {class_value} {evaluate} let class_captures = {capture_reader}(class); let object = instance_allocate_{index}(class); {ctor}(object.clone(){args}{captures}); object }}"
            )
        }
        Expr::FieldGet {
            obj,
            class_name,
            field,
            ..
        } => format!(
            "instance_get_{}_{}({})",
            class_index(class_name),
            field_name(field),
            expr(obj, function, module)
        ),
        Expr::Upcast { value, .. } => expr(value, function, module),
        Expr::Downcast {
            value,
            r#type: Type::Object { class_name },
            ..
        } => format!(
            "{{ let object = {}; if !instance_is_{}(object.clone()) {{ runtime::throw_type_error(\"invalid class projection\".into()); }} object }}",
            expr(value, function, module),
            class_index(class_name)
        ),
        Expr::InstanceOf {
            value, class_name, ..
        } => {
            if has_registry_brand(module, class_name) {
                format!(
                    "native_class_instanceof(NativeValue::Instance({}), NativeClass({}))",
                    expr(value, function, module),
                    class_index(class_name),
                )
            } else {
                format!(
                    "instance_is_{}({})",
                    class_index(class_name),
                    expr(value, function, module)
                )
            }
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "nodeStream.destroyed" => {
            let object = expr(&args[0], function, module);
            format!("{{ let object = {object}; object.with(|object| object.stream_destroyed) }}")
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "nodeStream.destroy" => {
            let object = expr(&args[0], function, module);
            let error = args
                .get(1)
                .map(|arg| expr(arg, function, module))
                .unwrap_or_else(|| "NativeValue::Undefined".into());
            format!(
                "{{ let object = {object}; let error = {error}; native_node_stream_destroy(object, error) }}"
            )
        }
        Expr::LibCall { r#fn, args, .. }
            if matches!(r#fn.as_str(), "dom.targetAdd" | "dom.targetRemove") =>
        {
            let owner = expr(&args[0], function, module);
            let name = expr(&args[1], function, module);
            let callback = expr(&args[2], function, module);
            let options = expr(&args[3], function, module);
            let adding = r#fn == "dom.targetAdd";
            format!(
                "{{ let owner = {owner}; let name = {name}; let callback = {callback}; let options = {options}; native_dom_target_listener(owner, name, callback, options, {adding}); }}"
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dom.targetDispatch" => {
            let owner = expr(&args[0], function, module);
            let event = expr(&args[1], function, module);
            format!(
                "{{ let owner = {owner}; let event = {event}; native_dom_target_dispatch(owner, event) }}"
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dom.eventNew" => {
            let index = class_index("native_builtin_Event");
            let name = expr(&args[0], function, module);
            let options = expr(&args[1], function, module);
            format!(
                "{{ let name = {name}; let options = {options}; if !matches!(options, NativeValue::Undefined | NativeValue::Null) && !native_value_test(&options, \"objectInstance\") {{ runtime::throw_type_error(\"Event options must be an object\".into()); }} let flag = |key| if matches!(options, NativeValue::Undefined | NativeValue::Null) {{ false }} else {{ native_value_test(&native_value_get(options.clone(), runtime::string(key)), \"truthy\") }}; let bubbles = flag(\"bubbles\"); let cancelable = flag(\"cancelable\"); let composed = flag(\"composed\"); let event = runtime::dom_event_new(name, bubbles, cancelable, composed); let object = instance_allocate_{index}(NativeClass({index})); object.with_mut(|object| object.dom_event = Some(event)); object }}"
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dom.eventGet" => {
            let object = expr(&args[0], function, module);
            let field = expr(&args[1], function, module);
            format!(
                "{{ let object = {object}; let key = {field}; native_dom_event_property(&object, &key).expect(\"validated Event property\") }}"
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dom.eventAction" => {
            let object = expr(&args[0], function, module);
            let Expr::StrLit { value: method, .. } = &args[1] else {
                unreachable!("validated Event method")
            };
            let operation = match method.as_str() {
                "preventDefault" => "dom_event_prevent_default",
                "stopPropagation" => "dom_event_stop_propagation",
                "stopImmediatePropagation" => "dom_event_stop_immediate",
                _ => unreachable!("validated Event method"),
            };
            format!(
                "{{ let object = {object}; let event = object.with(|object| object.dom_event.clone().expect(\"validated Event receiver\")); runtime::{operation}(&event); }}"
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn.starts_with("events.instance") => {
            let owner = expr(&args[0], function, module);
            let event = expr(&args[1], function, module);
            match r#fn.as_str() {
                "events.instanceOn"
                | "events.instancePrepend"
                | "events.instanceOnce"
                | "events.instancePrependOnce" => {
                    let callback = expr(&args[2], function, module);
                    let once = matches!(
                        r#fn.as_str(),
                        "events.instanceOnce" | "events.instancePrependOnce"
                    );
                    let prepend = matches!(
                        r#fn.as_str(),
                        "events.instancePrepend" | "events.instancePrependOnce"
                    );
                    format!(
                        "{{ let owner = {owner}; let event = {event}; let callback = {callback}; if !native_value_is_function(&callback) {{ runtime::throw_type_error(\"The listener argument must be of type function\".into()); }} let emitter = owner.with(|object| object.emitter.clone().expect(\"validated EventEmitter owner\")); runtime::emitter_on(&emitter, event, callback, 0, {once}, {prepend}); owner }}"
                    )
                }
                "events.instanceOff" => {
                    let callback = expr(&args[2], function, module);
                    format!(
                        "{{ let owner = {owner}; let event = {event}; let callback = {callback}; if !native_value_is_function(&callback) {{ runtime::throw_type_error(\"The listener argument must be of type function\".into()); }} let emitter = owner.with(|object| object.emitter.clone().expect(\"validated EventEmitter owner\")); runtime::emitter_off_matching(&emitter, &event, |stored| native_value_eq(stored, &callback)); owner }}"
                    )
                }
                "events.instanceEmit" => {
                    let payloads = args[2..]
                        .iter()
                        .map(|arg| expr(arg, function, module))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(
                        "{{ let owner = {owner}; let event = {event}; let payloads = vec![{payloads}]; let emitter = owner.with(|object| object.emitter.clone().expect(\"validated EventEmitter owner\")); let listeners = runtime::emitter_snapshot(&emitter, &event); let handled = !listeners.is_empty(); if !handled && event == \"error\" {{ if let Some(payload) = payloads.first() {{ if matches!(payload, NativeValue::Instance(object) if object.with(|object| object.error.is_some())) {{ runtime::throw_value(payload.clone()); }} }} runtime::throw_error(\"Unhandled error.\".into()); }} for listener in listeners {{ if !runtime::emitter_listener_should_invoke(&listener) {{ continue; }} if listener.once {{ runtime::emitter_remove_registration(&emitter, &event, listener.registration); }} native_value_call_with_this(listener.callback, NativeValue::Instance(owner.clone()), payloads.clone(), \"EventEmitter listener\"); }} handled }}"
                    )
                }
                _ => unreachable!("validated native EventEmitter operation"),
            }
        }
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "class.capture" => {
            let Expr::NumLit { value: capture, .. } = &args[1] else {
                unreachable!("validated class capture index")
            };
            let Expr::StrLit { value: owner, .. } = &args[2] else {
                unreachable!("validated class capture owner")
            };
            let capture = format!("native_class_capture(class, {})", *capture as usize);
            let checked = values::checked_value(r#type, &capture, module);
            format!(
                "{{ let object = {}; let mut class = object.with(|object| object.class); while native_class_layout(class) != {} {{ class = native_class_parent(class).expect(\"validated class capture ancestor\"); }} {checked} }}",
                expr(&args[0], function, module),
                class_index(owner),
            )
        }
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "class.captureSet" => {
            let Expr::NumLit { value: capture, .. } = &args[1] else {
                unreachable!("validated class capture index")
            };
            let Expr::StrLit { value: owner, .. } = &args[2] else {
                unreachable!("validated class capture owner")
            };
            let value = values::box_value(r#type, &expr(&args[3], function, module), module);
            let stored = format!(
                "native_class_capture_set(class, {}, value)",
                *capture as usize
            );
            let checked = values::checked_value(r#type, &stored, module);
            format!(
                "{{ let object = {}; let value = {value}; let mut class = object.with(|object| object.class); while native_class_layout(class) != {} {{ class = native_class_parent(class).expect(\"validated class capture ancestor\"); }} {checked} }}",
                expr(&args[0], function, module),
                class_index(owner),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "class.instanceConstructor" => {
            format!(
                "{}.with(|object| object.class)",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "class.lexicalConstructor" => {
            let Type::Classval { class_name } = r#type else {
                unreachable!("validated lexical class constructor")
            };
            format!(
                "{{ let mut class = {}.with(|object| object.class); while native_class_layout(class) != {} {{ class = native_class_parent(class).expect(\"validated lexical class ancestor\"); }} class }}",
                expr(&args[0], function, module),
                class_index(class_name)
            )
        }
        Expr::LibCall { r#fn, args, .. }
            if matches!(r#fn.as_str(), "dyn.classInstanceof" | "dyn.errInstanceof") =>
        {
            let Expr::StrLit { value, .. } = &args[1] else {
                unreachable!("validated class identity")
            };
            if has_registry_brand(module, value) {
                format!(
                    "native_class_instanceof({}, NativeClass({}))",
                    expr(&args[0], function, module),
                    class_index(value)
                )
            } else {
                format!(
                    "match {} {{ NativeValue::Instance(object) => instance_is_{}(object), _ => false }}",
                    expr(&args[0], function, module),
                    class_index(value)
                )
            }
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.valueInstanceof" => {
            format!(
                "native_value_instanceof({}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
            )
        }
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "error.new" => {
            let Type::Object { class_name } = r#type else {
                unreachable!("IR validated")
            };
            let index = class_index(class_name);
            let options = args.get(1).map(|options| {
                format!("let options = {}; if native_value_test(&options, \"object\") && native_value_has_own(options.clone(), runtime::string(\"cause\")) {{ let cause = native_value_get(options, runtime::string(\"cause\")); object.with_mut(|object| js_data_set(&mut object.error.as_mut().expect(\"validated Error receiver\").own, runtime::string(\"cause\"), cause)); }}", expr(options, function, module))
            }).unwrap_or_default();
            format!(
                "{{ let message = {}; let object = instance_allocate_{index}(NativeClass({index})); object.with_mut(|object| object.error.as_mut().expect(\"validated Error receiver\").message = NativeValue::String(message)); {options} object }}",
                expr(&args[0], function, module),
            )
        }
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "error.domException" => {
            let Type::Object { class_name } = r#type else {
                unreachable!("IR validated")
            };
            let index = class_index(class_name);
            format!(
                "{{ let message = {}; let name = {}; let code = match name.well_formed_utf8().unwrap_or(\"\") {{ \"IndexSizeError\" => 1.0, \"DOMStringSizeError\" => 2.0, \"HierarchyRequestError\" => 3.0, \"WrongDocumentError\" => 4.0, \"InvalidCharacterError\" => 5.0, \"NoDataAllowedError\" => 6.0, \"NoModificationAllowedError\" => 7.0, \"NotFoundError\" => 8.0, \"NotSupportedError\" => 9.0, \"InUseAttributeError\" => 10.0, \"InvalidStateError\" => 11.0, \"SyntaxError\" => 12.0, \"InvalidModificationError\" => 13.0, \"NamespaceError\" => 14.0, \"InvalidAccessError\" => 15.0, \"ValidationError\" => 16.0, \"TypeMismatchError\" => 17.0, \"SecurityError\" => 18.0, \"NetworkError\" => 19.0, \"AbortError\" => 20.0, \"URLMismatchError\" => 21.0, \"QuotaExceededError\" => 22.0, \"TimeoutError\" => 23.0, \"InvalidNodeTypeError\" => 24.0, \"DataCloneError\" => 25.0, _ => 0.0 }}; let object = instance_allocate_{index}(NativeClass({index})); object.with_mut(|object| {{ let error = object.error.as_mut().expect(\"validated DOMException receiver\"); error.message = NativeValue::String(message); error.name = NativeValue::String(name); js_data_set(&mut error.own, runtime::string(\"code\"), NativeValue::Number(code)); }}); object }}",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "error.domExceptionCtor" => {
            format!(
                "{{ let object = {}; let message = {}; let name = {}; let code = match name.well_formed_utf8().unwrap_or(\"\") {{ \"IndexSizeError\" => 1.0, \"DOMStringSizeError\" => 2.0, \"HierarchyRequestError\" => 3.0, \"WrongDocumentError\" => 4.0, \"InvalidCharacterError\" => 5.0, \"NoDataAllowedError\" => 6.0, \"NoModificationAllowedError\" => 7.0, \"NotFoundError\" => 8.0, \"NotSupportedError\" => 9.0, \"InUseAttributeError\" => 10.0, \"InvalidStateError\" => 11.0, \"SyntaxError\" => 12.0, \"InvalidModificationError\" => 13.0, \"NamespaceError\" => 14.0, \"InvalidAccessError\" => 15.0, \"ValidationError\" => 16.0, \"TypeMismatchError\" => 17.0, \"SecurityError\" => 18.0, \"NetworkError\" => 19.0, \"AbortError\" => 20.0, \"URLMismatchError\" => 21.0, \"QuotaExceededError\" => 22.0, \"TimeoutError\" => 23.0, \"InvalidNodeTypeError\" => 24.0, \"DataCloneError\" => 25.0, _ => 0.0 }}; object.with_mut(|object| {{ let error = object.error.as_mut().expect(\"validated DOMException receiver\"); error.message = NativeValue::String(message); error.name = NativeValue::String(name); js_data_set(&mut error.own, runtime::string(\"code\"), NativeValue::Number(code)); }}); }}",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module),
            )
        }
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn == "error.aggregate" => {
            let Type::Object { class_name } = r#type else {
                unreachable!("IR validated")
            };
            let index = class_index(class_name);
            let options = args.get(2).map(|options| {
                format!("let options = {}; if native_value_test(&options, \"object\") && native_value_has_own(options.clone(), runtime::string(\"cause\")) {{ let cause = native_value_get(options, runtime::string(\"cause\")); js_data_set(&mut error.own, runtime::string(\"cause\"), cause); }}", expr(options, function, module))
            }).unwrap_or_default();
            format!(
                "{{ let source = {}; let message = {}; let values = native_value_apply_arguments(&source); let errors = NativeValue::Array(runtime::array_new(values)); let object = instance_allocate_{index}(NativeClass({index})); object.with_mut(|object| {{ let error = object.error.as_mut().expect(\"validated AggregateError receiver\"); error.message = NativeValue::String(message); js_data_set(&mut error.own, runtime::string(\"errors\"), errors); {options} }}); object }}",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "error.ctor" => {
            let options = args.get(2).map(|options| {
                format!("let options = {}; if native_value_test(&options, \"object\") && native_value_has_own(options.clone(), runtime::string(\"cause\")) {{ let cause = native_value_get(options, runtime::string(\"cause\")); object.with_mut(|object| js_data_set(&mut object.error.as_mut().expect(\"validated Error receiver\").own, runtime::string(\"cause\"), cause)); }}", expr(options, function, module))
            }).unwrap_or_default();
            format!(
                "{{ let object = {}; let message = {}; object.with_mut(|object| object.error.as_mut().expect(\"validated Error receiver\").message = NativeValue::String(message)); {options} }}",
                expr(&args[0], function, module),
                expr(&args[1], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "error.captureStackTrace" => {
            let constructor = args
                .get(1)
                .map(|value| format!("let _constructor = {};", expr(value, function, module)))
                .unwrap_or_default();
            format!(
                "{{ let _target = {}; {constructor} }}",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "error.toString" => {
            format!("error_string({})", expr(&args[0], function, module))
        }
        _ => return None,
    })
}
