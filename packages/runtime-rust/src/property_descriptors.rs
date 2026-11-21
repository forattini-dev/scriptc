//! Native data-property descriptor rules shared by string and symbol keys.
use crate::{JsString, JsStringSource, JsSymbol, symbol_ptr_eq};

/// A symbol is identified by its identity, never by its description.
#[derive(Clone)]
pub enum PropertyKey {
    String(JsString),
    Symbol(JsSymbol),
}

impl PartialEq for PropertyKey {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::String(a), Self::String(b)) => a == b,
            (Self::Symbol(a), Self::Symbol(b)) => symbol_ptr_eq(a, b),
            _ => false,
        }
    }
}
impl Eq for PropertyKey {}

/// A complete data property. Accessor properties have a different contract.
#[derive(Clone, Debug, PartialEq)]
pub struct DataProperty<T> {
    pub value: T,
    pub writable: bool,
    pub enumerable: bool,
    pub configurable: bool,
}

/// Missing fields are distinct from present fields with false or undefined values.
#[derive(Clone, Debug, Default)]
pub struct DataDescriptor<T> {
    pub value: Option<T>,
    pub writable: Option<bool>,
    pub enumerable: Option<bool>,
    pub configurable: Option<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DefineDataError {
    NotExtensible,
    NonConfigurable,
    NonWritable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WriteOwnDataResult {
    Written,
    Missing,
    NonWritable,
}

/// Own data properties in insertion order, with distinct string/symbol keys.
/// Callers own enumeration ordering and GC tracing for their value type.
#[derive(Clone)]
pub struct DataPropertyTable<T> {
    entries: Vec<(PropertyKey, DataProperty<T>)>,
}

impl<T> Default for DataPropertyTable<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<T> DataPropertyTable<T> {
    /// Iterate without cloning values so a native heap can trace owning edges.
    pub fn trace_values(&self, mut visit: impl FnMut(&T)) {
        for (_, property) in &self.entries {
            visit(&property.value);
        }
    }
}

impl<T: Clone> DataPropertyTable<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &PropertyKey) -> Option<&DataProperty<T>> {
        self.entries
            .iter()
            .find(|(stored, _)| stored == key)
            .map(|(_, property)| property)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&PropertyKey, &DataProperty<T>)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    /// OrdinaryOwnPropertyKeys ordering: array indices, other strings, symbols.
    /// Filtering for enumerable properties does not change that ordering.
    pub fn own_keys(&self, enumerable_only: bool) -> Vec<PropertyKey> {
        let mut indices = Vec::new();
        let mut strings = Vec::new();
        let mut symbols = Vec::new();
        for (key, property) in &self.entries {
            if enumerable_only && !property.enumerable {
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

    /// Copy enumerable own data properties to a new ordinary object. Spread
    /// creates writable, enumerable, configurable properties on its result.
    pub fn copy_enumerable_to_new(&self) -> Self {
        let mut result = Self::new();
        for key in self.own_keys(true) {
            let property = self.get(&key).expect("key came from the table");
            result.entries.push((
                key,
                DataProperty {
                    value: property.value.clone(),
                    writable: true,
                    enumerable: true,
                    configurable: true,
                },
            ));
        }
        result
    }

    /// Only writes existing own data properties; prototype lookup and creation
    /// are the caller's responsibility when the result is Missing.
    pub fn write_own(&mut self, key: &PropertyKey, value: T) -> WriteOwnDataResult {
        let Some((_, property)) = self.entries.iter_mut().find(|(stored, _)| stored == key) else {
            return WriteOwnDataResult::Missing;
        };
        if !property.writable {
            return WriteOwnDataResult::NonWritable;
        }
        property.value = value;
        WriteOwnDataResult::Written
    }

    pub fn define(
        &mut self,
        key: PropertyKey,
        descriptor: &DataDescriptor<T>,
        extensible: bool,
        undefined: T,
        same_value: impl Fn(&T, &T) -> bool,
    ) -> Result<(), DefineDataError> {
        let index = self.entries.iter().position(|(stored, _)| *stored == key);
        let current = index.map(|index| &self.entries[index].1);
        let next = define_data_property(current, descriptor, extensible, undefined, same_value)?;
        if let Some(index) = index {
            self.entries[index].1 = next;
        } else {
            self.entries.push((key, next));
        }
        Ok(())
    }

    /// Returns false for a present non-configurable property.
    pub fn delete(&mut self, key: &PropertyKey) -> bool {
        let Some(index) = self.entries.iter().position(|(stored, _)| stored == key) else {
            return true;
        };
        if !self.entries[index].1.configurable {
            return false;
        }
        self.entries.remove(index);
        true
    }
}

/// Validate without mutating the old property. `same_value` implements JS
/// SameValue for the caller's value representation, including NaN and -0.
pub fn define_data_property<T: Clone>(
    current: Option<&DataProperty<T>>,
    descriptor: &DataDescriptor<T>,
    extensible: bool,
    undefined: T,
    same_value: impl Fn(&T, &T) -> bool,
) -> Result<DataProperty<T>, DefineDataError> {
    let Some(current) = current else {
        if !extensible {
            return Err(DefineDataError::NotExtensible);
        }
        return Ok(DataProperty {
            value: descriptor.value.clone().unwrap_or(undefined),
            writable: descriptor.writable.unwrap_or(false),
            enumerable: descriptor.enumerable.unwrap_or(false),
            configurable: descriptor.configurable.unwrap_or(false),
        });
    };
    if !current.configurable {
        if descriptor.configurable == Some(true)
            || descriptor
                .enumerable
                .is_some_and(|value| value != current.enumerable)
        {
            return Err(DefineDataError::NonConfigurable);
        }
        if !current.writable
            && (descriptor.writable == Some(true)
                || descriptor
                    .value
                    .as_ref()
                    .is_some_and(|value| !same_value(value, &current.value)))
        {
            return Err(DefineDataError::NonWritable);
        }
    }
    Ok(DataProperty {
        value: descriptor
            .value
            .clone()
            .unwrap_or_else(|| current.value.clone()),
        writable: descriptor.writable.unwrap_or(current.writable),
        enumerable: descriptor.enumerable.unwrap_or(current.enumerable),
        configurable: descriptor.configurable.unwrap_or(current.configurable),
    })
}

#[cfg(test)]
#[path = "property_descriptors.test.rs"]
mod tests;
