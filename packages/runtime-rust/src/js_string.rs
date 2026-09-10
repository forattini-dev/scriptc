//! JavaScript strings preserve UTF-16 code units, including lone surrogates.
//! Well-formed strings retain the compact Rc<str> representation. The UTF-8
//! view is a lossy host boundary; language operations use units and equality.
use std::cell::OnceCell;
use std::cmp::Ordering;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use std::rc::Rc;

#[derive(Clone)]
pub struct JsString(Repr);

#[derive(Clone)]
enum Repr {
    Utf8(Rc<str>),
    Utf16(Rc<Utf16String>),
}

struct Utf16String {
    units: Box<[u16]>,
    host_utf8: OnceCell<String>,
}

#[derive(Clone)]
pub enum Utf16Units<'a> {
    Utf8(std::str::EncodeUtf16<'a>),
    Utf16(std::iter::Copied<std::slice::Iter<'a, u16>>),
}

impl Iterator for Utf16Units<'_> {
    type Item = u16;
    fn next(&mut self) -> Option<u16> {
        match self {
            Self::Utf8(iter) => iter.next(),
            Self::Utf16(iter) => iter.next(),
        }
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        match self {
            Self::Utf8(iter) => iter.size_hint(),
            Self::Utf16(iter) => iter.size_hint(),
        }
    }
}

pub trait JsStringSource: fmt::Display {
    fn utf16_units(&self) -> Utf16Units<'_>;
    fn well_formed_utf8(&self) -> Option<&str>;
    fn to_js_string(&self) -> JsString {
        match self.well_formed_utf8() {
            Some(text) => JsString::from(text),
            None => JsString::from_utf16(&self.utf16_units().collect::<Vec<_>>()),
        }
    }
}
impl JsStringSource for str {
    fn utf16_units(&self) -> Utf16Units<'_> {
        Utf16Units::Utf8(self.encode_utf16())
    }
    fn well_formed_utf8(&self) -> Option<&str> {
        Some(self)
    }
}
impl JsStringSource for String {
    fn utf16_units(&self) -> Utf16Units<'_> {
        self.as_str().utf16_units()
    }
    fn well_formed_utf8(&self) -> Option<&str> {
        Some(self)
    }
}
impl JsStringSource for JsString {
    fn utf16_units(&self) -> Utf16Units<'_> {
        self.encode_utf16()
    }
    fn well_formed_utf8(&self) -> Option<&str> {
        match &self.0 {
            Repr::Utf8(text) => Some(text),
            Repr::Utf16(_) => None,
        }
    }
    fn to_js_string(&self) -> JsString {
        self.clone()
    }
}

impl JsString {
    pub fn from_utf16(units: &[u16]) -> Self {
        match String::from_utf16(units) {
            Ok(text) => Self::from(text),
            Err(_) => Self(Repr::Utf16(Rc::new(Utf16String {
                units: units.into(),
                host_utf8: OnceCell::new(),
            }))),
        }
    }
    pub fn encode_utf16(&self) -> Utf16Units<'_> {
        match &self.0 {
            Repr::Utf8(text) => Utf16Units::Utf8(text.encode_utf16()),
            Repr::Utf16(text) => Utf16Units::Utf16(text.units.iter().copied()),
        }
    }
    pub fn ptr_eq(left: &Self, right: &Self) -> bool {
        match (&left.0, &right.0) {
            (Repr::Utf8(a), Repr::Utf8(b)) => Rc::ptr_eq(a, b),
            (Repr::Utf16(a), Repr::Utf16(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
    pub fn is_well_formed(&self) -> bool {
        matches!(self.0, Repr::Utf8(_))
    }
    pub fn to_utf8_lossy(&self) -> &str {
        match &self.0 {
            Repr::Utf8(text) => text,
            Repr::Utf16(text) => text
                .host_utf8
                .get_or_init(|| String::from_utf16_lossy(&text.units)),
        }
    }
}
impl Default for JsString {
    fn default() -> Self {
        Self::from("")
    }
}
impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self(Repr::Utf8(Rc::from(value)))
    }
}
impl From<String> for JsString {
    fn from(value: String) -> Self {
        Self(Repr::Utf8(Rc::from(value)))
    }
}
impl From<&JsString> for JsString {
    fn from(value: &JsString) -> Self {
        value.clone()
    }
}
impl Deref for JsString {
    type Target = str;
    fn deref(&self) -> &str {
        self.to_utf8_lossy()
    }
}
impl fmt::Display for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.to_utf8_lossy().fmt(f)
    }
}
impl fmt::Debug for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(text) = self.well_formed_utf8() { return fmt::Debug::fmt(text, f); }
        f.write_str("\"")?;
        for item in char::decode_utf16(self.encode_utf16()) {
            match item {
                Ok(ch) => for escaped in ch.escape_debug() { write!(f, "{escaped}")?; },
                Err(error) => write!(f, "\\u{:04x}", error.unpaired_surrogate())?,
            }
        }
        f.write_str("\"")
    }
}
impl PartialEq for JsString {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Repr::Utf8(a), Repr::Utf8(b)) => a == b,
            _ => self.encode_utf16().eq(other.encode_utf16()),
        }
    }
}
impl Eq for JsString {}
impl PartialOrd for JsString {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for JsString {
    fn cmp(&self, other: &Self) -> Ordering {
        self.encode_utf16().cmp(other.encode_utf16())
    }
}
impl Hash for JsString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        for unit in self.encode_utf16() {
            unit.hash(state);
        }
        // Distinguish concatenated hash inputs without relying on UTF-8 views.
        0x10000u32.hash(state);
    }
}
impl PartialEq<str> for JsString {
    fn eq(&self, other: &str) -> bool {
        self.encode_utf16().eq(other.encode_utf16())
    }
}
impl PartialEq<&str> for JsString {
    fn eq(&self, other: &&str) -> bool {
        self == *other
    }
}
impl PartialEq<JsString> for str {
    fn eq(&self, other: &JsString) -> bool {
        other == self
    }
}
impl PartialEq<JsString> for &str {
    fn eq(&self, other: &JsString) -> bool {
        other == *self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_units_survive_and_do_not_equal_replacement_text() {
        let high = JsString::from_utf16(&[0xd83d]);
        let low = JsString::from_utf16(&[0xde00]);
        assert_eq!(high.encode_utf16().collect::<Vec<_>>(), [0xd83d]);
        assert_ne!(high, low);
        assert_ne!(high, JsString::from("�"));
        assert!(!high.is_well_formed());
        assert_eq!(high.to_utf8_lossy(), "�");
        assert_eq!(high.encode_utf16().collect::<Vec<_>>(), [0xd83d]);
        let joined = JsString::from_utf16(
            &high
                .encode_utf16()
                .chain(low.encode_utf16())
                .collect::<Vec<_>>(),
        );
        assert_eq!(joined, "😀");
        assert!(joined.is_well_formed());
    }
}

impl PartialEq<String> for JsString {
    fn eq(&self, other: &String) -> bool {
        self == other.as_str()
    }
}
impl PartialEq<String> for &JsString {
    fn eq(&self, other: &String) -> bool {
        *self == other.as_str()
    }
}

/// Append without erasing surrogate boundaries; ordinary text stays UTF-8.
#[derive(Default)]
pub struct JsStringBuilder {
    utf8: String,
    units: Option<Vec<u16>>,
}
impl JsStringBuilder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn push_str<S: JsStringSource + ?Sized>(&mut self, value: &S) {
        if self.units.is_none() {
            if let Some(text) = value.well_formed_utf8() {
                self.utf8.push_str(text);
                return;
            }
            self.units = Some(self.utf8.encode_utf16().collect());
            self.utf8.clear();
        }
        self.units
            .as_mut()
            .expect("UTF-16 builder initialized")
            .extend(value.utf16_units());
    }
    pub fn push(&mut self, value: char) {
        if let Some(units) = &mut self.units {
            units.extend_from_slice(value.encode_utf16(&mut [0; 2]));
        } else {
            self.utf8.push(value);
        }
    }
    pub fn push_unit(&mut self, unit: u16) {
        if let Some(ch) = char::from_u32(u32::from(unit)) {
            self.push(ch);
        } else {
            if self.units.is_none() {
                self.units = Some(self.utf8.encode_utf16().collect());
                self.utf8.clear();
            }
            self.units
                .as_mut()
                .expect("UTF-16 builder initialized")
                .push(unit);
        }
    }
    pub fn finish(self) -> JsString {
        match self.units {
            Some(units) => JsString::from_utf16(&units),
            None => JsString::from(self.utf8),
        }
    }
}
impl<T: JsStringSource + ?Sized> JsStringSource for &T {
    fn utf16_units(&self) -> Utf16Units<'_> {
        (*self).utf16_units()
    }
    fn well_formed_utf8(&self) -> Option<&str> {
        (*self).well_formed_utf8()
    }
    fn to_js_string(&self) -> JsString {
        (*self).to_js_string()
    }
}
impl JsStringSource for std::borrow::Cow<'_, str> {
    fn utf16_units(&self) -> Utf16Units<'_> {
        self.as_ref().utf16_units()
    }
    fn well_formed_utf8(&self) -> Option<&str> {
        Some(self.as_ref())
    }
}
impl AsRef<JsString> for JsString {
    /// Keep language equality on UTF-16 units. Host paths use an explicit
    /// `to_utf8_lossy()` boundary instead of another ambiguous `AsRef` impl.
    fn as_ref(&self) -> &JsString {
        self
    }
}
impl JsStringSource for JsStringBuilder {
    fn utf16_units(&self) -> Utf16Units<'_> {
        match &self.units {
            Some(units) => Utf16Units::Utf16(units.iter().copied()),
            None => self.utf8.utf16_units(),
        }
    }
    fn well_formed_utf8(&self) -> Option<&str> {
        self.units.is_none().then_some(self.utf8.as_str())
    }
}
impl fmt::Display for JsStringBuilder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.to_js_string().fmt(f)
    }
}

#[cfg(test)]
mod language_tests {
    use crate::*;
    #[test]
    fn utf16_roundtrips_through_language_operations() {
        let input = string("😀");
        let high = string_char_at(&input, 0.0);
        let low = string_slice(&input, 1.0, 2.0);
        assert_eq!(string_concat(&high, &low), input);
        assert_eq!(json_stringify(&high), "\"\\ud83d\"");
        assert_eq!(json_parse_typed::<JsString>(&json_stringify(&high)), high);
        assert_eq!(
            json_parse_typed::<JsString>(&string_concat(
                &string_concat(&string("\""), &high),
                &string("\"")
            )),
            high
        );
        assert_eq!(
            array_join(
                &string_split(&input, &empty_string(), 100.0),
                &empty_string()
            ),
            input
        );
        assert_eq!(string_trim(&string_concat(&string(" "), &high)), high);
        assert_eq!(
            string_to_upper_case(&string_concat(&string("a"), &high)),
            string_concat(&string("A"), &high)
        );
    }
}
