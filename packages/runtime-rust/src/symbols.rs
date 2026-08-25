use crate::{JsString, string};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Immutable ES Symbol payload. `Rc` pointer identity is JavaScript symbol
/// identity; descriptions and registry keys are values, never identities.
pub struct SymbolData {
    description: Option<JsString>,
    registry_key: Option<JsString>,
}

pub type JsSymbol = Rc<SymbolData>;

thread_local! {
    static SYMBOL_REGISTRY: RefCell<HashMap<JsString, JsSymbol>> = RefCell::new(HashMap::new());
}

pub fn symbol_new(description: &JsString) -> JsSymbol {
    Rc::new(SymbolData {
        description: Some(description.clone()),
        registry_key: None,
    })
}

pub fn symbol_new_anonymous() -> JsSymbol {
    Rc::new(SymbolData {
        description: None,
        registry_key: None,
    })
}

pub fn symbol_for(key: &JsString) -> JsSymbol {
    SYMBOL_REGISTRY.with(|registry| {
        if let Some(value) = registry.borrow().get(key) {
            return value.clone();
        }
        let value = Rc::new(SymbolData {
            description: Some(key.clone()),
            registry_key: Some(key.clone()),
        });
        registry.borrow_mut().insert(key.clone(), value.clone());
        value
    })
}

pub fn symbol_description(value: &JsSymbol) -> Option<JsString> {
    value.description.clone()
}

pub fn symbol_key_for(value: &JsSymbol) -> Option<JsString> {
    value.registry_key.clone()
}

pub fn symbol_to_string(value: &JsSymbol) -> JsString {
    match &value.description {
        Some(description) => string(&format!("Symbol({description})")),
        None => string("Symbol()"),
    }
}

pub fn symbol_ptr_eq(left: &JsSymbol, right: &JsSymbol) -> bool {
    Rc::ptr_eq(left, right)
}
