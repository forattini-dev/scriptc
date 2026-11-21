//! Ordinary data and accessor descriptors, independent of a value ABI.
use crate::{DataProperty, JsStringSource, PropertyKey};

/// A present `get` or `set` containing the caller's undefined value is
/// distinct from an omitted descriptor field.
#[derive(Clone, Debug)]
pub struct OrdinaryDescriptor<T> {
    pub value: Option<T>,
    pub writable: Option<bool>,
    pub get: Option<T>,
    pub set: Option<T>,
    pub enumerable: Option<bool>,
    pub configurable: Option<bool>,
}

impl<T> Default for OrdinaryDescriptor<T> {
    fn default() -> Self {
        Self {
            value: None,
            writable: None,
            get: None,
            set: None,
            enumerable: None,
            configurable: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AccessorProperty<T> {
    pub get: T,
    pub set: T,
    pub enumerable: bool,
    pub configurable: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OrdinaryProperty<T> {
    Data(DataProperty<T>),
    Accessor(AccessorProperty<T>),
}

impl<T> OrdinaryProperty<T> {
    fn enumerable(&self) -> bool {
        match self {
            Self::Data(p) => p.enumerable,
            Self::Accessor(p) => p.enumerable,
        }
    }
    fn configurable(&self) -> bool {
        match self {
            Self::Data(p) => p.configurable,
            Self::Accessor(p) => p.configurable,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DefineOrdinaryError {
    InvalidDescriptor,
    NotExtensible,
    NonConfigurable,
    NonWritable,
}

/// A caller invokes the returned getter or setter outside the table borrow,
/// with the original receiver. Undefined accessors are represented by `T`.
#[derive(Clone, Debug, PartialEq)]
pub enum OrdinaryWrite<T> {
    Missing,
    Written,
    NonWritable,
    Setter(T),
}

#[derive(Clone)]
pub struct OrdinaryPropertyTable<T> {
    entries: Vec<(PropertyKey, OrdinaryProperty<T>)>,
}

impl<T> Default for OrdinaryPropertyTable<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<T> OrdinaryPropertyTable<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &PropertyKey) -> Option<&OrdinaryProperty<T>> {
        self.entries
            .iter()
            .find(|(stored, _)| stored == key)
            .map(|(_, property)| property)
    }

    pub fn trace_values(&self, mut visit: impl FnMut(&T)) {
        for (_, property) in &self.entries {
            match property {
                OrdinaryProperty::Data(data) => visit(&data.value),
                OrdinaryProperty::Accessor(accessor) => {
                    visit(&accessor.get);
                    visit(&accessor.set);
                }
            }
        }
    }

    pub fn delete(&mut self, key: &PropertyKey) -> bool {
        let Some(index) = self.entries.iter().position(|(stored, _)| stored == key) else {
            return true;
        };
        if !self.entries[index].1.configurable() {
            return false;
        }
        self.entries.remove(index);
        true
    }

    pub fn own_keys(&self, enumerable_only: bool) -> Vec<PropertyKey> {
        let mut indices = Vec::new();
        let mut strings = Vec::new();
        let mut symbols = Vec::new();
        for (key, property) in &self.entries {
            if enumerable_only && !property.enumerable() {
                continue;
            }
            match key {
                PropertyKey::String(value) => {
                    let index = value.well_formed_utf8().and_then(|text| {
                        let number = text.parse::<u32>().ok()?;
                        (number != u32::MAX && text == number.to_string()).then_some(number)
                    });
                    if let Some(index) = index {
                        indices.push((index, key.clone()));
                    } else {
                        strings.push(key.clone());
                    }
                }
                PropertyKey::Symbol(_) => symbols.push(key.clone()),
            }
        }
        indices.sort_by_key(|(index, _)| *index);
        indices
            .into_iter()
            .map(|(_, key)| key)
            .chain(strings)
            .chain(symbols)
            .collect()
    }
}

impl<T: Clone> OrdinaryPropertyTable<T> {
    pub fn write_own(&mut self, key: &PropertyKey, value: T) -> OrdinaryWrite<T> {
        let Some((_, property)) = self.entries.iter_mut().find(|(stored, _)| stored == key) else {
            return OrdinaryWrite::Missing;
        };
        match property {
            OrdinaryProperty::Data(data) if data.writable => {
                data.value = value;
                OrdinaryWrite::Written
            }
            OrdinaryProperty::Data(_) => OrdinaryWrite::NonWritable,
            OrdinaryProperty::Accessor(accessor) => OrdinaryWrite::Setter(accessor.set.clone()),
        }
    }

    /// Callers validate that present accessors are callable or undefined.
    /// Validation is atomic: failed definitions leave the table unchanged.
    pub fn define(
        &mut self,
        key: PropertyKey,
        descriptor: &OrdinaryDescriptor<T>,
        extensible: bool,
        undefined: T,
        same_value: impl Fn(&T, &T) -> bool,
    ) -> Result<(), DefineOrdinaryError> {
        let data = descriptor.value.is_some() || descriptor.writable.is_some();
        let accessor = descriptor.get.is_some() || descriptor.set.is_some();
        if data && accessor {
            return Err(DefineOrdinaryError::InvalidDescriptor);
        }
        let index = self.entries.iter().position(|(stored, _)| *stored == key);
        let current = index.map(|index| &self.entries[index].1);
        if current.is_none() && !extensible {
            return Err(DefineOrdinaryError::NotExtensible);
        }
        if let Some(old) = current.filter(|old| !old.configurable()) {
            if descriptor.configurable == Some(true)
                || descriptor
                    .enumerable
                    .is_some_and(|value| value != old.enumerable())
                || (data && matches!(old, OrdinaryProperty::Accessor(_)))
                || (accessor && matches!(old, OrdinaryProperty::Data(_)))
            {
                return Err(DefineOrdinaryError::NonConfigurable);
            }
            match old {
                OrdinaryProperty::Data(old) if !old.writable => {
                    if descriptor.writable == Some(true)
                        || descriptor
                            .value
                            .as_ref()
                            .is_some_and(|v| !same_value(v, &old.value))
                    {
                        return Err(DefineOrdinaryError::NonWritable);
                    }
                }
                OrdinaryProperty::Accessor(old)
                    if descriptor
                        .get
                        .as_ref()
                        .is_some_and(|v| !same_value(v, &old.get))
                        || descriptor
                            .set
                            .as_ref()
                            .is_some_and(|v| !same_value(v, &old.set)) =>
                {
                    return Err(DefineOrdinaryError::NonConfigurable);
                }
                _ => {}
            }
        }
        let enumerable = descriptor
            .enumerable
            .unwrap_or_else(|| current.is_some_and(OrdinaryProperty::enumerable));
        let configurable = descriptor
            .configurable
            .unwrap_or_else(|| current.is_some_and(OrdinaryProperty::configurable));
        let is_accessor =
            accessor || (!data && matches!(current, Some(OrdinaryProperty::Accessor(_))));
        let next = if is_accessor {
            let old = match current {
                Some(OrdinaryProperty::Accessor(old)) => Some(old),
                _ => None,
            };
            OrdinaryProperty::Accessor(AccessorProperty {
                get: descriptor
                    .get
                    .clone()
                    .or_else(|| old.map(|p| p.get.clone()))
                    .unwrap_or_else(|| undefined.clone()),
                set: descriptor
                    .set
                    .clone()
                    .or_else(|| old.map(|p| p.set.clone()))
                    .unwrap_or(undefined),
                enumerable,
                configurable,
            })
        } else {
            let old = match current {
                Some(OrdinaryProperty::Data(old)) => Some(old),
                _ => None,
            };
            OrdinaryProperty::Data(DataProperty {
                value: descriptor
                    .value
                    .clone()
                    .or_else(|| old.map(|p| p.value.clone()))
                    .unwrap_or(undefined),
                writable: descriptor
                    .writable
                    .unwrap_or_else(|| old.is_some_and(|p| p.writable)),
                enumerable,
                configurable,
            })
        };
        if let Some(index) = index {
            self.entries[index].1 = next;
        } else {
            self.entries.push((key, next));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "ordinary_descriptors.test.rs"]
mod tests;
