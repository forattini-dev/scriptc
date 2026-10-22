use crate::{JsString, JsStringBuilder, string};
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
        Some(description) => {
            let mut output = JsStringBuilder::new();
            output.push_str("Symbol(");
            output.push_str(description);
            output.push_str(")");
            output.finish()
        }
        None => string("Symbol()"),
    }
}

pub fn symbol_ptr_eq(left: &JsSymbol, right: &JsSymbol) -> bool {
    Rc::ptr_eq(left, right)
}

/// Standard symbol names select immutable per-agent singleton identities.
/// They are independent of the user-visible Symbol.for registry.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WellKnownSymbol {
    AsyncIterator,
    HasInstance,
    IsConcatSpreadable,
    Iterator,
    Match,
    MatchAll,
    Replace,
    Search,
    Species,
    Split,
    ToPrimitive,
    ToStringTag,
    Unscopables,
    Dispose,
    AsyncDispose,
}

impl WellKnownSymbol {
    fn description(self) -> &'static str {
        match self {
            Self::AsyncIterator => "Symbol.asyncIterator",
            Self::HasInstance => "Symbol.hasInstance",
            Self::IsConcatSpreadable => "Symbol.isConcatSpreadable",
            Self::Iterator => "Symbol.iterator",
            Self::Match => "Symbol.match",
            Self::MatchAll => "Symbol.matchAll",
            Self::Replace => "Symbol.replace",
            Self::Search => "Symbol.search",
            Self::Species => "Symbol.species",
            Self::Split => "Symbol.split",
            Self::ToPrimitive => "Symbol.toPrimitive",
            Self::ToStringTag => "Symbol.toStringTag",
            Self::Unscopables => "Symbol.unscopables",
            Self::Dispose => "Symbol.dispose",
            Self::AsyncDispose => "Symbol.asyncDispose",
        }
    }
}

thread_local! {
    static WELL_KNOWN_SYMBOLS: RefCell<HashMap<WellKnownSymbol, JsSymbol>> = RefCell::new(HashMap::new());
}

pub fn symbol_well_known(kind: WellKnownSymbol) -> JsSymbol {
    WELL_KNOWN_SYMBOLS.with(|symbols| {
        symbols
            .borrow_mut()
            .entry(kind)
            .or_insert_with(|| {
                Rc::new(SymbolData {
                    description: Some(string(kind.description())),
                    registry_key: None,
                })
            })
            .clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptive_strings_preserve_utf16_units() {
        for units in [
            vec![],
            vec![0xd83d],
            vec![0xde00],
            vec![0xd83d, 0xde00],
            vec![0xfffd],
        ] {
            let description = JsString::from_utf16(&units);
            let mut expected = "Symbol(".encode_utf16().collect::<Vec<_>>();
            expected.extend(units);
            expected.push(b')' as u16);
            assert_eq!(
                symbol_to_string(&symbol_new(&description))
                    .encode_utf16()
                    .collect::<Vec<_>>(),
                expected
            );
        }
        assert_eq!(
            symbol_to_string(&symbol_new_anonymous()),
            string("Symbol()")
        );
    }

    #[test]
    fn well_known_symbols_have_distinct_persistent_nonregistry_identities() {
        let names = [
            (WellKnownSymbol::AsyncIterator, "Symbol.asyncIterator"),
            (WellKnownSymbol::HasInstance, "Symbol.hasInstance"),
            (
                WellKnownSymbol::IsConcatSpreadable,
                "Symbol.isConcatSpreadable",
            ),
            (WellKnownSymbol::Iterator, "Symbol.iterator"),
            (WellKnownSymbol::Match, "Symbol.match"),
            (WellKnownSymbol::MatchAll, "Symbol.matchAll"),
            (WellKnownSymbol::Replace, "Symbol.replace"),
            (WellKnownSymbol::Search, "Symbol.search"),
            (WellKnownSymbol::Species, "Symbol.species"),
            (WellKnownSymbol::Split, "Symbol.split"),
            (WellKnownSymbol::ToPrimitive, "Symbol.toPrimitive"),
            (WellKnownSymbol::ToStringTag, "Symbol.toStringTag"),
            (WellKnownSymbol::Unscopables, "Symbol.unscopables"),
            (WellKnownSymbol::Dispose, "Symbol.dispose"),
            (WellKnownSymbol::AsyncDispose, "Symbol.asyncDispose"),
        ];
        let mut previous = Vec::new();
        for (kind, description) in names {
            let first = symbol_well_known(kind);
            assert!(symbol_ptr_eq(&first, &symbol_well_known(kind)));
            assert_eq!(symbol_description(&first).unwrap().as_ref(), description);
            assert_eq!(
                symbol_to_string(&first).as_ref(),
                format!("Symbol({description})")
            );
            assert!(symbol_key_for(&first).is_none());
            assert!(!symbol_ptr_eq(&first, &symbol_for(&string(description))));
            assert!(!symbol_ptr_eq(&first, &symbol_new(&string(description))));
            for other in &previous {
                assert!(!symbol_ptr_eq(&first, other));
            }
            previous.push(first);
        }
        let weak = Rc::downgrade(&symbol_well_known(WellKnownSymbol::AsyncIterator));
        assert!(symbol_ptr_eq(
            &weak.upgrade().unwrap(),
            &symbol_well_known(WellKnownSymbol::AsyncIterator)
        ));
    }
}
