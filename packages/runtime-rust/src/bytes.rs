pub trait ByteElement: Copy + Default + 'static {
    fn from_number(value: f64) -> Self;
    fn to_number(self) -> f64;
    fn same_bits(self, other: Self) -> bool;
    fn byte_backing(storage: &Rc<RefCell<Vec<Self>>>) -> ByteBacking;
}

#[derive(Clone)]
pub enum ByteBacking {
    U8(Rc<RefCell<Vec<u8>>>),
    U32(Rc<RefCell<Vec<u32>>>),
    I32(Rc<RefCell<Vec<i32>>>),
    F32(Rc<RefCell<Vec<f32>>>),
    F64(Rc<RefCell<Vec<f64>>>),
}

impl ByteBacking {
    fn byte_len(&self) -> usize {
        match self {
            Self::U8(storage) => storage.borrow().len(),
            Self::U32(storage) => storage.borrow().len() * 4,
            Self::I32(storage) => storage.borrow().len() * 4,
            Self::F32(storage) => storage.borrow().len() * 4,
            Self::F64(storage) => storage.borrow().len() * 8,
        }
    }

    fn get(&self, index: usize) -> u8 {
        let element = index / 4;
        let byte = index % 4;
        match self {
            Self::U8(storage) => storage.borrow()[index],
            Self::U32(storage) => storage.borrow()[element].to_ne_bytes()[byte],
            Self::I32(storage) => storage.borrow()[element].to_ne_bytes()[byte],
            Self::F32(storage) => storage.borrow()[element].to_ne_bytes()[byte],
            Self::F64(storage) => storage.borrow()[index / 8].to_ne_bytes()[index % 8],
        }
    }

    fn set(&self, index: usize, value: u8) {
        let element = index / 4;
        let byte = index % 4;
        match self {
            Self::U8(storage) => storage.borrow_mut()[index] = value,
            Self::U32(storage) => {
                let mut storage = storage.borrow_mut();
                let mut bytes = storage[element].to_ne_bytes();
                bytes[byte] = value;
                storage[element] = u32::from_ne_bytes(bytes);
            }
            Self::I32(storage) => {
                let mut storage = storage.borrow_mut();
                let mut bytes = storage[element].to_ne_bytes();
                bytes[byte] = value;
                storage[element] = i32::from_ne_bytes(bytes);
            }
            Self::F32(storage) => {
                let mut storage = storage.borrow_mut();
                let mut bytes = storage[element].to_ne_bytes();
                bytes[byte] = value;
                storage[element] = f32::from_ne_bytes(bytes);
            }
            Self::F64(storage) => {
                let mut storage = storage.borrow_mut();
                let mut bytes = storage[index / 8].to_ne_bytes();
                bytes[index % 8] = value;
                storage[index / 8] = f64::from_ne_bytes(bytes);
            }
        }
    }
}

impl ByteElement for u8 {
    #[inline]
    fn from_number(value: f64) -> Self {
        // Within i64, truncation then the u8 cast is exactly ToUint8.
        // Outside it, every finite binary64 is a multiple of 256. Negative
        // saturation already has zero low bits; positive saturation needs
        // this correction. No binary64 truncates to i64::MAX itself.
        // Rust's safe saturating cast maps NaN to zero and handles infinities.
        let integer = value as i64;
        if integer == i64::MAX { 0 } else { integer as u8 }
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
    fn same_bits(self, other: Self) -> bool {
        self == other
    }
    fn byte_backing(storage: &Rc<RefCell<Vec<Self>>>) -> ByteBacking {
        ByteBacking::U8(storage.clone())
    }
}

impl ByteElement for u32 {
    fn from_number(value: f64) -> Self {
        to_uint32(value)
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
    fn same_bits(self, other: Self) -> bool {
        self == other
    }
    fn byte_backing(storage: &Rc<RefCell<Vec<Self>>>) -> ByteBacking {
        ByteBacking::U32(storage.clone())
    }
}

impl ByteElement for i32 {
    fn from_number(value: f64) -> Self {
        to_int32(value)
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
    fn same_bits(self, other: Self) -> bool {
        self == other
    }
    fn byte_backing(storage: &Rc<RefCell<Vec<Self>>>) -> ByteBacking {
        ByteBacking::I32(storage.clone())
    }
}

impl ByteElement for f32 {
    fn from_number(value: f64) -> Self {
        value as f32
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
    fn same_bits(self, other: Self) -> bool {
        self.to_bits() == other.to_bits()
    }
    fn byte_backing(storage: &Rc<RefCell<Vec<Self>>>) -> ByteBacking {
        ByteBacking::F32(storage.clone())
    }
}

impl ByteElement for f64 {
    fn from_number(value: f64) -> Self {
        value
    }
    fn to_number(self) -> f64 {
        self
    }
    fn same_bits(self, other: Self) -> bool {
        self.to_bits() == other.to_bits()
    }
    fn byte_backing(storage: &Rc<RefCell<Vec<Self>>>) -> ByteBacking {
        ByteBacking::F64(storage.clone())
    }
}

pub struct BytesData<T: ByteElement> {
    storage: Rc<RefCell<Vec<T>>>,
    backing: Option<ByteBacking>,
    offset: usize,
    length: usize,
}

impl<T: ByteElement> Trace for BytesData<T> {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl<T: ByteElement> ClearEdges for BytesData<T> {
    fn clear_edges(&mut self) {
        self.storage = Rc::new(RefCell::new(Vec::new()));
        self.backing = None;
        self.offset = 0;
        self.length = 0;
    }
}

pub type JsBytes<T> = Gc<BytesData<T>>;

/// A type-erased non-byte typed array kept inside checked-dynamic values.
///
/// Uint8Array stays on the established `JsBytes<u8>` path because Buffer and
/// the Node byte APIs consume that exact representation. The remaining typed
/// arrays retain their element kind here instead of being flattened into a JS
/// Array (which would make Array.isArray and constructor identity incorrect).
#[derive(Clone)]
pub enum JsTypedBytes {
    U32(JsBytes<u32>),
    I32(JsBytes<i32>),
    F32(JsBytes<f32>),
    F64(JsBytes<f64>),
}

macro_rules! with_typed_bytes {
    ($value:expr, |$bytes:ident| $body:expr) => {
        match $value {
            JsTypedBytes::U32($bytes) => $body,
            JsTypedBytes::I32($bytes) => $body,
            JsTypedBytes::F32($bytes) => $body,
            JsTypedBytes::F64($bytes) => $body,
        }
    };
}

pub fn typed_bytes_u32_copy(value: &JsBytes<u32>) -> JsTypedBytes {
    JsTypedBytes::U32(bytes_copy(value))
}

pub fn typed_bytes_i32_copy(value: &JsBytes<i32>) -> JsTypedBytes {
    JsTypedBytes::I32(bytes_copy(value))
}

pub fn typed_bytes_f32_copy(value: &JsBytes<f32>) -> JsTypedBytes {
    JsTypedBytes::F32(bytes_copy(value))
}

pub fn typed_bytes_f64_copy(value: &JsBytes<f64>) -> JsTypedBytes {
    JsTypedBytes::F64(bytes_copy(value))
}

pub fn typed_bytes_trace(value: &JsTypedBytes, tracer: &mut Tracer<'_>) {
    with_typed_bytes!(value, |bytes| tracer.edge(bytes));
}

pub fn typed_bytes_len(value: &JsTypedBytes) -> f64 {
    with_typed_bytes!(value, |bytes| bytes_len(bytes))
}

pub fn typed_bytes_byte_len(value: &JsTypedBytes) -> f64 {
    with_typed_bytes!(value, |bytes| bytes_byte_len(bytes))
}

pub fn typed_bytes_get(value: &JsTypedBytes, index: f64) -> f64 {
    with_typed_bytes!(value, |bytes| bytes_get(bytes, index))
}

pub fn typed_bytes_set(value: &JsTypedBytes, index: f64, field: f64) {
    with_typed_bytes!(value, |bytes| bytes_set(bytes, index, field));
}

pub fn typed_bytes_name(value: &JsTypedBytes) -> &'static str {
    match value {
        JsTypedBytes::U32(_) => "Uint32Array",
        JsTypedBytes::I32(_) => "Int32Array",
        JsTypedBytes::F32(_) => "Float32Array",
        JsTypedBytes::F64(_) => "Float64Array",
    }
}

pub fn typed_bytes_identity(value: &JsTypedBytes) -> usize {
    with_typed_bytes!(value, |bytes| bytes.identity())
}

pub fn typed_bytes_copy(value: &JsTypedBytes) -> JsTypedBytes {
    match value {
        JsTypedBytes::U32(value) => typed_bytes_u32_copy(value),
        JsTypedBytes::I32(value) => typed_bytes_i32_copy(value),
        JsTypedBytes::F32(value) => typed_bytes_f32_copy(value),
        JsTypedBytes::F64(value) => typed_bytes_f64_copy(value),
    }
}

pub fn typed_bytes_slice(value: &JsTypedBytes, start: f64, end: f64) -> JsTypedBytes {
    match value {
        JsTypedBytes::U32(value) => JsTypedBytes::U32(bytes_slice(value, start, end, false)),
        JsTypedBytes::I32(value) => JsTypedBytes::I32(bytes_slice(value, start, end, false)),
        JsTypedBytes::F32(value) => JsTypedBytes::F32(bytes_slice(value, start, end, false)),
        JsTypedBytes::F64(value) => JsTypedBytes::F64(bytes_slice(value, start, end, false)),
    }
}

pub fn typed_bytes_ptr_eq(left: &JsTypedBytes, right: &JsTypedBytes) -> bool {
    match (left, right) {
        (JsTypedBytes::U32(left), JsTypedBytes::U32(right)) => left.ptr_eq(right),
        (JsTypedBytes::I32(left), JsTypedBytes::I32(right)) => left.ptr_eq(right),
        (JsTypedBytes::F32(left), JsTypedBytes::F32(right)) => left.ptr_eq(right),
        (JsTypedBytes::F64(left), JsTypedBytes::F64(right)) => left.ptr_eq(right),
        _ => false,
    }
}

pub fn typed_bytes_deep_equals(left: &JsTypedBytes, right: &JsTypedBytes) -> bool {
    match (left, right) {
        (JsTypedBytes::U32(left), JsTypedBytes::U32(right)) => bytes_deep_equals(left, right),
        (JsTypedBytes::I32(left), JsTypedBytes::I32(right)) => bytes_deep_equals(left, right),
        (JsTypedBytes::F32(left), JsTypedBytes::F32(right)) => bytes_deep_equals(left, right),
        (JsTypedBytes::F64(left), JsTypedBytes::F64(right)) => bytes_deep_equals(left, right),
        _ => false,
    }
}

pub fn typed_bytes_join(value: &JsTypedBytes, separator: &JsString) -> JsString {
    with_typed_bytes!(value, |bytes| bytes_join(bytes, separator))
}

fn bytes_from_elements<T: ByteElement>(elements: Vec<T>) -> JsBytes<T> {
    Gc::new(BytesData {
        length: elements.len(),
        storage: Rc::new(RefCell::new(elements)),
        backing: None,
        offset: 0,
    })
}

pub fn bytes_empty<T: ByteElement>() -> JsBytes<T> {
    bytes_from_elements(Vec::new())
}

pub fn bytes_alloc<T: ByteElement>(length: f64) -> JsBytes<T> {
    let length = if length.is_nan() { 0.0 } else { length.trunc() };
    if length < 0.0 || !length.is_finite() || length > usize::MAX as f64 {
        throw_range_error(format!("Invalid typed array length: {length}"));
    }
    let length = length as usize;
    Gc::new(BytesData {
        storage: Rc::new(RefCell::new(vec![T::default(); length])),
        backing: None,
        offset: 0,
        length,
    })
}

fn bytes_values<T: ByteElement>(bytes: &JsBytes<T>) -> Vec<T> {
    bytes.with(|data| {
        if let Some(backing) = &data.backing {
            return (data.offset..data.offset + data.length)
                .map(|index| T::from_number(f64::from(backing.get(index))))
                .collect();
        }
        data.storage.borrow()[data.offset..data.offset + data.length].to_vec()
    })
}

pub fn bytes_copy<T: ByteElement>(bytes: &JsBytes<T>) -> JsBytes<T> {
    bytes_from_elements(bytes_values(bytes))
}

/// Stable, contiguous input storage for the duration of one outbound FFI call.
pub fn ffi_bytes_snapshot(bytes: &JsBytes<u8>) -> Vec<u8> {
    bytes_values(bytes)
}

pub fn ffi_string_copy_in(values: &[u8]) -> JsString {
    JsString::from(String::from_utf8_lossy(values).as_ref())
}

pub fn ffi_bytes_copy_in(values: &[u8]) -> JsBytes<u8> {
    bytes_from_elements(values.to_vec())
}

// Like the string twins in numeric_ops.rs: process-stream writes swallow
// I/O failure (Node's EPIPE stance), never abort.
pub fn process_stdout_write_bytes(bytes: &JsBytes<u8>, encoding: &JsString) -> bool {
    use std::io::Write;
    let _ = encoding;
    let _ = bytes.with(|data| {
        let storage = data.storage.borrow();
        std::io::stdout()
            .lock()
            .write_all(&storage[data.offset..data.offset + data.length])
    });
    true
}

pub fn process_stderr_write_bytes(bytes: &JsBytes<u8>, encoding: &JsString) -> bool {
    use std::io::Write;
    let _ = encoding;
    let _ = bytes.with(|data| {
        let storage = data.storage.borrow();
        std::io::stderr()
            .lock()
            .write_all(&storage[data.offset..data.offset + data.length])
    });
    true
}

pub fn bytes_from_array<T: ByteElement>(array: &JsArray<f64>) -> JsBytes<T> {
    let elements: Vec<T> =
        array.with(|data| data.elements().iter().copied().map(T::from_number).collect());
    bytes_from_elements(elements)
}

pub fn bytes_len<T: ByteElement>(bytes: &JsBytes<T>) -> f64 {
    bytes.with(|data| data.length as f64)
}

pub fn bytes_byte_len<T: ByteElement>(bytes: &JsBytes<T>) -> f64 {
    bytes.with(|data| (data.length * std::mem::size_of::<T>()) as f64)
}

// A saturating float-to-usize conversion followed by an exact round trip
// rejects fractional, negative and non-finite indices. Check length before
// accepting the round trip: usize::MAX rounds upward when converted to f64.
#[inline]
fn checked_bytes_index(index: f64, length: usize) -> Option<usize> {
    // Allocatable slices fit isize. A signed conversion avoids the expensive
    // unsigned binary64 round trip. Negative results cast above the length;
    // positive saturation fails the strict bound before rounding can match.
    // Keep the general path for hypothetical wider lengths as well.
    if length <= isize::MAX as usize {
        let integer = index as isize;
        return ((integer as usize) < length && integer as f64 == index)
            .then_some(integer as usize);
    }
    let integer = index as usize;
    (integer < length && integer as f64 == index).then_some(integer)
}

pub fn bytes_get<T: ByteElement>(bytes: &JsBytes<T>, index: f64) -> f64 {
    bytes.with(|data| {
        let index = checked_bytes_index(index, data.length)
            .expect("scriptc: bytes index out of bounds");
        match &data.backing {
            Some(backing) => f64::from(backing.get(data.offset + index)),
            None => data.storage.borrow()[data.offset + index].to_number(),
        }
    })
}

pub fn bytes_set<T: ByteElement>(bytes: &JsBytes<T>, index: f64, value: f64) {
    bytes.with(|data| {
        let index = checked_bytes_index(index, data.length)
            .expect("scriptc: bytes index out of bounds");
        match &data.backing {
            Some(backing) => backing.set(
                data.offset + index,
                T::from_number(value).to_number() as u8,
            ),
            None => data.storage.borrow_mut()[data.offset + index] = T::from_number(value),
        }
    });
}

/// Compiler region for a fresh, non-escaping allocation. The emitter proves
/// no use of the original buffer can access storage while this slice is live.
/// Backed DataViews are excluded by that allocation proof and checked here.
pub fn bytes_with_mut_slice<T: ByteElement, R>(bytes: &JsBytes<T>, body: impl FnOnce(&mut [T]) -> R) -> R {
    bytes.with(|data| {
        assert!(data.backing.is_none(), "scriptc: byte region requires direct storage");
        let mut storage = data.storage.borrow_mut();
        body(&mut storage[data.offset..data.offset + data.length])
    })
}

pub fn bytes_region_get<T: ByteElement>(data: &[T], index: f64) -> f64 {
    let index = checked_bytes_index(index, data.len()).expect("scriptc: bytes index out of bounds");
    data[index].to_number()
}

/// Read-only region proven by the compiler, including every direct callee.
/// Multiple inputs may alias: shared borrows are compatible. Backed views
/// retain their original getter rather than copying storage or assuming u8.
pub fn bytes_with_read_slice<R>(bytes: &JsBytes<u8>, body: impl FnOnce(Option<&[u8]>) -> R) -> R {
    bytes.with(|data| match &data.backing {
        Some(_) => body(None),
        None => {
            let storage = data.storage.borrow();
            body(Some(&storage[data.offset..data.offset + data.length]))
        }
    })
}

/// Missing union arms keep the original loop path and its failure timing.
pub fn bytes_with_optional_read_slice<R>(
    bytes: Option<&JsBytes<u8>>,
    body: impl FnOnce(Option<&[u8]>) -> R,
) -> R {
    match bytes {
        Some(bytes) => bytes_with_read_slice(bytes, body),
        None => body(None),
    }
}

#[inline]
pub fn bytes_read_region_get(slice: Option<&[u8]>, bytes: &JsBytes<u8>, index: f64) -> f64 {
    match slice {
        Some(data) => bytes_region_get(data, index),
        None => bytes_get(bytes, index),
    }
}

#[inline]
pub fn bytes_read_region_get_usize(slice: Option<&[u8]>, bytes: &JsBytes<u8>, index: usize) -> f64 {
    match slice {
        Some(data) => bytes_region_get_usize(data, index),
        None => bytes_get_usize(bytes, index),
    }
}

#[inline]
pub fn bytes_read_region_len(slice: Option<&[u8]>, bytes: &JsBytes<u8>) -> f64 {
    slice.map_or_else(|| bytes_len(bytes), |data| data.len() as f64)
}

pub fn bytes_region_set<T: ByteElement>(data: &mut [T], index: f64, value: f64) {
    let index = checked_bytes_index(index, data.len()).expect("scriptc: bytes index out of bounds");
    data[index] = T::from_number(value);
}

pub fn bytes_region_get_usize<T: ByteElement>(data: &[T], index: usize) -> f64 {
    data.get(index).expect("scriptc: bytes index out of bounds").to_number()
}

/// Integer-valued byte observation: avoid a floating conversion between the
/// checked load and integer index arithmetic proved by the compiler.
#[inline]
pub fn bytes_region_get_u8_integer(data: &[u8], index: usize) -> i64 {
    i64::from(*data.get(index).expect("scriptc: bytes index out of bounds"))
}

/// For values proved to be exact JS integers, ToUint8 keeps the low eight
/// bits, including for negative values. The index remains checked.
#[inline]
pub fn bytes_region_set_u8_integer(data: &mut [u8], index: usize, value: i64) {
    *data.get_mut(index).expect("scriptc: bytes index out of bounds") = value as u8;
}

pub fn bytes_region_set_usize<T: ByteElement>(data: &mut [T], index: usize, value: f64) {
    *data.get_mut(index).expect("scriptc: bytes index out of bounds") = T::from_number(value);
}

// Integer induction proves the index representation, not the bounds of an
// arbitrary receiver. Retain the view-length check, including for subarrays.
pub fn bytes_len_usize<T: ByteElement>(bytes: &JsBytes<T>) -> usize {
    bytes.with(|data| data.length)
}

pub fn bytes_get_usize<T: ByteElement>(bytes: &JsBytes<T>, index: usize) -> f64 {
    bytes.with(|data| {
        assert!(index < data.length, "scriptc: bytes index out of bounds");
        match &data.backing {
            Some(backing) => f64::from(backing.get(data.offset + index)),
            None => data.storage.borrow()[data.offset + index].to_number(),
        }
    })
}

pub fn bytes_set_usize<T: ByteElement>(bytes: &JsBytes<T>, index: usize, value: f64) {
    bytes.with(|data| {
        assert!(index < data.length, "scriptc: bytes index out of bounds");
        match &data.backing {
            Some(backing) => backing.set(
                data.offset + index,
                T::from_number(value).to_number() as u8,
            ),
            None => data.storage.borrow_mut()[data.offset + index] = T::from_number(value),
        }
    });
}

pub fn bytes_fill_elem<T: ByteElement>(
    bytes: &JsBytes<T>,
    value: f64,
    start: f64,
    end: f64,
) -> JsBytes<T> {
    let length = bytes.with(|data| data.length);
    let start = bytes_relative_index(start, length, 0);
    let end = bytes_relative_index(end, length, length).max(start);
    bytes.with(|data| {
        data.storage.borrow_mut()[data.offset + start..data.offset + end]
            .fill(T::from_number(value));
    });
    bytes.clone()
}

pub fn bytes_join<T: ByteElement>(bytes: &JsBytes<T>, separator: &JsString) -> JsString {
    fn join_numbers(values: impl Iterator<Item = f64>, separator: &str) -> JsString {
        let mut output = String::new();
        for (index, value) in values.enumerate() {
            if index > 0 {
                output.push_str(separator);
            }
            output.push_str(&format_number(value));
        }
        JsString::from(output)
    }
    bytes.with(|data| match &data.backing {
        Some(backing) => join_numbers(
            (data.offset..data.offset + data.length).map(|index| f64::from(backing.get(index))),
            separator,
        ),
        None => {
            let storage = data.storage.borrow();
            join_numbers(storage[data.offset..data.offset + data.length].iter().map(|value| value.to_number()), separator)
        }
    })
}

pub fn bytes_to_reversed<T: ByteElement>(bytes: &JsBytes<T>) -> JsBytes<T> {
    let mut elements =
        bytes.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    elements.reverse();
    bytes_from_elements(elements)
}

pub fn bytes_with<T: ByteElement>(bytes: &JsBytes<T>, index: f64, value: f64) -> JsBytes<T> {
    let length = bytes.with(|data| data.length);
    let relative = if index.is_nan() { 0.0 } else { index.trunc() };
    let actual = if relative >= 0.0 {
        relative
    } else {
        length as f64 + relative
    };
    if actual.is_nan() || actual < 0.0 || actual >= length as f64 {
        throw_range_error("Invalid typed array index".to_owned());
    }
    let mut elements =
        bytes.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    elements[actual as usize] = T::from_number(value);
    bytes_from_elements(elements)
}

pub fn bytes_to_array<T: ByteElement>(bytes: &JsBytes<T>) -> JsArray<f64> {
    let elements = bytes.with(|data| {
        data.storage.borrow()[data.offset..data.offset + data.length]
            .iter()
            .map(|value| value.to_number())
            .collect()
    });
    array_new(elements)
}

fn bytes_u8_values(bytes: &JsBytes<u8>) -> Vec<u8> {
    bytes_values(bytes)
}

pub fn buffer_is_utf8(bytes: &JsBytes<u8>) -> bool {
    std::str::from_utf8(&bytes_u8_values(bytes)).is_ok()
}

fn bytes_u8_at(bytes: &JsBytes<u8>, index: usize) -> u8 {
    bytes.with(|data| match &data.backing {
        Some(backing) => backing.get(data.offset + index),
        None => data.storage.borrow()[data.offset + index],
    })
}

fn bytes_u8_set_at(bytes: &JsBytes<u8>, index: usize, value: u8) {
    bytes.with(|data| match &data.backing {
        Some(backing) => backing.set(data.offset + index, value),
        None => data.storage.borrow_mut()[data.offset + index] = value,
    });
}

fn bytes_received_number(value: f64) -> String {
    let plain = format_number(value);
    if !(value.is_finite() && value.trunc() == value && value.abs() > 4_294_967_296.0) {
        return plain;
    }
    let start = usize::from(plain.starts_with('-'));
    let mut head = plain.len();
    while head >= start + 4 {
        head -= 3;
    }
    let mut received = String::with_capacity(plain.len() + (plain.len() - head).div_ceil(3));
    received.push_str(&plain[..head]);
    for group in plain.as_bytes()[head..].chunks(3) {
        received.push('_');
        received.push_str(std::str::from_utf8(group).expect("scriptc: number spelling is ASCII"));
    }
    received
}

pub fn bytes_validate_offset(name: &str, value: f64, max: f64) {
    if value.is_finite() && value.fract() == 0.0 && value >= 0.0 && (max < 0.0 || value <= max) {
        return;
    }
    let received = bytes_received_number(value);
    let requirement = if !value.is_finite() || value.fract() != 0.0 {
        "an integer".to_owned()
    } else if max < 0.0 {
        ">= 0".to_owned()
    } else {
        format!(">= 0 && <= {}", format_number(max))
    };
    throw_value(JsError {
        identity: Rc::new(()),
        name: "RangeError".to_owned(),
        message: format!(
            "The value of \"{name}\" is out of range. It must be {requirement}. Received {received}"
        ),
        code: Some("ERR_OUT_OF_RANGE".to_owned()),
        cause: None,
        dom: None,
    })
}

pub fn bytes_equals(left: &JsBytes<u8>, right: &JsBytes<u8>) -> bool {
    bytes_u8_values(left) == bytes_u8_values(right)
}

pub fn bytes_deep_equals<T: ByteElement>(left: &JsBytes<T>, right: &JsBytes<T>) -> bool {
    let left =
        left.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    let right =
        right.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| left.same_bits(right))
}

pub fn bytes_compare(
    source: &JsBytes<u8>,
    target: &JsBytes<u8>,
    nargs: usize,
    target_start: f64,
    target_end: f64,
    source_start: f64,
    source_end: f64,
) -> f64 {
    let source = bytes_u8_values(source);
    let target = bytes_u8_values(target);
    let target_start = if nargs < 1 {
        0.0
    } else {
        bytes_validate_offset("targetStart", target_start, 9_007_199_254_740_991.0);
        target_start
    };
    let target_end = if nargs < 2 {
        target.len() as f64
    } else {
        bytes_validate_offset("targetEnd", target_end, target.len() as f64);
        target_end
    };
    let source_start = if nargs < 3 {
        0.0
    } else {
        bytes_validate_offset("sourceStart", source_start, 9_007_199_254_740_991.0);
        source_start
    };
    let source_end = if nargs < 4 {
        source.len() as f64
    } else {
        bytes_validate_offset("sourceEnd", source_end, source.len() as f64);
        source_end
    };
    if target_start >= target_end {
        return if source_start >= source_end { 0.0 } else { 1.0 };
    }
    if source_start >= source_end {
        return -1.0;
    }
    let target_start = (target_start as usize).min(target.len());
    let source_start = (source_start as usize).min(source.len());
    let target_end = target_end as usize;
    let source_end = source_end as usize;
    match source[source_start..source_end].cmp(&target[target_start..target_end]) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

pub fn bytes_index_of(
    bytes: &JsBytes<u8>,
    needle: &JsBytes<u8>,
    offset: f64,
    alignment: f64,
    forward: bool,
) -> f64 {
    let bytes = bytes_u8_values(bytes);
    let needle = bytes_u8_values(needle);
    let length = bytes.len();
    let step = if alignment == 2.0 { 2 } else { 1 };
    let mut offset = if offset.is_nan() {
        if forward { 0.0 } else { length as f64 }
    } else {
        offset.trunc()
    };
    if offset < 0.0 {
        offset += length as f64;
        if offset < 0.0 {
            if !forward {
                return -1.0;
            }
            offset = 0.0;
        }
    }
    if needle.is_empty() {
        return offset.min(length as f64);
    }
    if needle.len() > length {
        return -1.0;
    }
    if forward {
        let mut start = if offset.is_finite() {
            (offset as usize).min(length)
        } else {
            length
        };
        if step == 2 {
            start += start % 2;
        }
        for index in (start..=length - needle.len()).step_by(step) {
            if bytes[index..index + needle.len()] == needle {
                return index as f64;
            }
        }
        return -1.0;
    }
    let mut start = if offset.is_finite() {
        (offset as usize).min(length - needle.len())
    } else {
        length - needle.len()
    };
    if step == 2 {
        start -= start % 2;
    }
    loop {
        if bytes[start..start + needle.len()] == needle {
            return start as f64;
        }
        if start < step {
            return -1.0;
        }
        start -= step;
    }
}

pub fn bytes_index_of_num(bytes: &JsBytes<u8>, value: f64, offset: f64, forward: bool) -> f64 {
    let needle = bytes_from_elements(vec![u8::from_number(value)]);
    bytes_index_of(bytes, &needle, offset, 1.0, forward)
}

fn bytes_fill_core(
    bytes: &JsBytes<u8>,
    pattern: &[u8],
    empty_pattern_zero_fills: bool,
    nargs: usize,
    offset: f64,
    end: f64,
) -> JsBytes<u8> {
    if pattern.is_empty() && !empty_pattern_zero_fills {
        throw_value(JsError {
            identity: Rc::new(()),
            name: "TypeError".to_owned(),
            message: "The argument 'value' is invalid. Received <Buffer >".to_owned(),
            code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
            cause: None,
            dom: None,
        });
    }
    let length = bytes.with(|data| data.length);
    let offset = if nargs < 1 {
        0.0
    } else {
        bytes_validate_offset("offset", offset, 9_007_199_254_740_991.0);
        offset
    };
    let end = if nargs < 2 {
        length as f64
    } else {
        bytes_validate_offset("end", end, length as f64);
        end
    };
    if offset < end {
        let offset = (offset as usize).min(length);
        let end = end as usize;
        bytes.with(|data| {
            let mut storage = data.storage.borrow_mut();
            let output = &mut storage[data.offset + offset..data.offset + end];
            if pattern.is_empty() {
                output.fill(0);
            } else {
                for (index, byte) in output.iter_mut().enumerate() {
                    *byte = pattern[index % pattern.len()];
                }
            }
        });
    }
    bytes.clone()
}

pub fn bytes_fill(
    bytes: &JsBytes<u8>,
    pattern: &JsBytes<u8>,
    nargs: usize,
    offset: f64,
    end: f64,
) -> JsBytes<u8> {
    bytes_fill_core(bytes, &bytes_u8_values(pattern), false, nargs, offset, end)
}

pub fn bytes_fill_num(
    bytes: &JsBytes<u8>,
    value: f64,
    nargs: usize,
    offset: f64,
    end: f64,
) -> JsBytes<u8> {
    bytes_fill_core(bytes, &[u8::from_number(value)], false, nargs, offset, end)
}

pub fn bytes_fill_str(
    bytes: &JsBytes<u8>,
    value: &JsString,
    encoding: &JsString,
    nargs: usize,
    offset: f64,
    end: f64,
) -> JsBytes<u8> {
    let pattern = buffer_string_bytes(value, encoding);
    bytes_fill_core(bytes, &pattern, true, nargs, offset, end)
}

pub fn bytes_copy_into(
    source: &JsBytes<u8>,
    target: &JsBytes<u8>,
    nargs: usize,
    target_start: f64,
    source_start: f64,
    source_end: f64,
) -> f64 {
    let target_start = if nargs < 1 { 0.0 } else { target_start.trunc() };
    let source_start = if nargs < 2 { 0.0 } else { source_start.trunc() };
    let source_values = bytes_u8_values(source);
    let source_end = if nargs < 3 {
        source_values.len() as f64
    } else {
        source_end.trunc()
    };
    bytes_validate_offset("targetStart", target_start, -1.0);
    bytes_validate_offset("sourceStart", source_start, source_values.len() as f64);
    bytes_validate_offset("sourceEnd", source_end, -1.0);
    let target_length = target.with(|data| data.length);
    if target_start >= target_length as f64 {
        return 0.0;
    }
    let target_start = target_start as usize;
    let source_start = source_start as usize;
    let source_end = (source_end as usize).min(source_values.len());
    if source_start >= source_end {
        return 0.0;
    }
    let count = (source_end - source_start).min(target_length - target_start);
    target.with(|data| {
        data.storage.borrow_mut()[data.offset + target_start..data.offset + target_start + count]
            .copy_from_slice(&source_values[source_start..source_start + count]);
    });
    count as f64
}

pub fn bytes_swap(bytes: &JsBytes<u8>, width: usize) -> JsBytes<u8> {
    let length = bytes.with(|data| data.length);
    if !length.is_multiple_of(width) {
        throw_value(JsError {
            identity: Rc::new(()),
            name: "RangeError".to_owned(),
            message: format!("Buffer size must be a multiple of {}-bits", width * 8),
            code: Some("ERR_INVALID_BUFFER_SIZE".to_owned()),
            cause: None,
            dom: None,
        });
    }
    for start in (0..length).step_by(width) {
        for index in 0..width / 2 {
            let opposite = width - 1 - index;
            let left = bytes_u8_at(bytes, start + index);
            let right = bytes_u8_at(bytes, start + opposite);
            bytes_u8_set_at(bytes, start + index, right);
            bytes_u8_set_at(bytes, start + opposite, left);
        }
    }
    bytes.clone()
}

pub fn bytes_write_str(
    bytes: &JsBytes<u8>,
    value: &JsString,
    encoding: &JsString,
    offset: f64,
    length: f64,
    has_length: bool,
) -> f64 {
    let byte_length = bytes.with(|data| data.length);
    bytes_validate_offset("offset", offset, byte_length as f64);
    let offset = offset as usize;
    let remaining = byte_length - offset;
    let budget = if has_length {
        bytes_validate_offset("length", length, byte_length as f64);
        (length as usize).min(remaining)
    } else {
        remaining
    };
    let encoded = buffer_string_bytes(value, encoding);
    let mut count = encoded.len().min(budget);
    if count < encoded.len() {
        match encoding.to_utf8_lossy() {
            "utf16le" => count -= count % 2,
            "utf8" | "utf-8" => {
                while count > 0 && std::str::from_utf8(&encoded[..count]).is_err() {
                    count -= 1;
                }
            }
            _ => {}
        }
    }
    bytes.with(|data| {
        data.storage.borrow_mut()[data.offset + offset..data.offset + offset + count]
            .copy_from_slice(&encoded[..count]);
    });
    count as f64
}

#[cfg(test)]
mod integer_index_tests {
    use super::*;

    #[test]
    fn integer_indices_preserve_subarray_offsets_and_numeric_conversion() {
        let bytes = bytes_from_elements(vec![10_u32, 20, 30, 40]);
        let view = bytes_slice(&bytes, 1.0, 3.0, true);
        assert_eq!(bytes_len_usize(&view), 2);
        assert_eq!(bytes_get_usize(&view, 0), 20.0);
        bytes_set_usize(&view, 1, -1.0);
        assert_eq!(bytes_get(&bytes, 2.0), f64::from(u32::MAX));
    }

    #[test]
    #[should_panic(expected = "scriptc: bytes index out of bounds")]
    fn integer_read_checks_view_length_even_when_backing_is_larger() {
        let bytes = bytes_from_elements(vec![1_u8, 2, 3]);
        let view = bytes_slice(&bytes, 0.0, 1.0, true);
        bytes_get_usize(&view, 1);
    }

    #[test]
    #[should_panic(expected = "scriptc: bytes index out of bounds")]
    fn integer_write_checks_view_length_even_when_backing_is_larger() {
        let bytes = bytes_from_elements(vec![1_u8, 2, 3]);
        let view = bytes_slice(&bytes, 0.0, 1.0, true);
        bytes_set_usize(&view, 1, 42.0);
    }
}

#[cfg(test)]
mod checked_byte_index_tests {
    use super::*;

    #[test]
    fn index_roundtrip_matches_original_checks_over_binary64_values() {
        fn reference(value: f64, length: usize) -> Option<usize> {
            if !value.is_finite() || value < 0.0 || value.fract() != 0.0 { return None; }
            let index = value as usize;
            (index < length).then_some(index)
        }
        let check = |value| {
            for length in [0, 1, 3, 255, 65_536, usize::MAX / 2,
                usize::MAX / 2 + 1, usize::MAX / 2 + 2, usize::MAX] {
                assert_eq!(checked_bytes_index(value, length), reference(value, length),
                    "index bits={:016x}, length={length}", value.to_bits());
            }
        };
        for exponent in 0_u64..2048 {
            for sign in [0, 1_u64 << 63] {
                for mantissa in [0, 1, 0x0007_ffff_ffff_ffff, 0x000f_ffff_ffff_ffff] {
                    check(f64::from_bits(sign | (exponent << 52) | mantissa));
                }
            }
        }
        let mut seed = 0x4567_89ab_cdef_0123_u64;
        for _ in 0..100_000 {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
            check(f64::from_bits(seed));
        }
        for value in [-0.0, 0.0, 0.5, 1.0, 2.0, 2.5, 3.0, 255.0, 65_535.0,
            9_007_199_254_740_992.0, usize::MAX as f64] { check(value); }
        for boundary in [isize::MIN as f64, isize::MAX as f64] {
            for delta in -4..=4 {
                check(f64::from_bits(boundary.to_bits().wrapping_add_signed(delta)));
            }
        }
    }

    #[test]
    fn float_indices_preserve_view_bounds_and_storage_after_failed_writes() {
        let data = bytes_from_elements(vec![10_u8, 20, 30]);
        let view = bytes_slice(&data, 1.0, 2.0, true);
        assert_eq!(bytes_get(&view, -0.0), 20.0);
        bytes_set(&view, -0.0, 7.0);
        for index in [-1.0, 0.5, 1.0, f64::NAN, f64::INFINITY, f64::MAX] {
            let read = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bytes_get(&view, index)));
            assert!(read.is_err());
            let write = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bytes_set(&view, index, 99.0)));
            assert!(write.is_err());
        }
        assert_eq!(bytes_get(&data, 0.0), 10.0);
        assert_eq!(bytes_get(&data, 1.0), 7.0);
        assert_eq!(bytes_get(&data, 2.0), 30.0);
    }
}

#[cfg(test)]
mod byte_region_tests {
    use super::*;

    #[test]
    fn slices_preserve_view_offsets_conversion_and_same_buffer_reads() {
        let owner = bytes_from_elements(vec![10_u8, 20, 30, 40]);
        let view = bytes_slice(&owner, 1.0, 3.0, true);
        bytes_with_mut_slice(&view, |slice| {
            let first = bytes_region_get(slice, -0.0);
            bytes_region_set(slice, 1.0, first + 250.0);
            let next = bytes_region_get_usize(slice, 1) + 1.0;
            bytes_region_set_usize(slice, 0, next);
        });
        assert_eq!(bytes_get(&owner, 0.0), 10.0);
        assert_eq!(bytes_get(&owner, 1.0), 15.0);
        assert_eq!(bytes_get(&owner, 2.0), 14.0);
        assert_eq!(bytes_get(&owner, 3.0), 40.0);
    }

    #[test]
    fn unwind_releases_the_slice_and_keeps_prior_writes() {
        let owner = bytes_from_elements(vec![1_u8, 2]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            bytes_with_mut_slice(&owner, |slice| {
                bytes_region_set(slice, 0.0, 7.0);
                bytes_region_set(slice, 2.0, 9.0);
            });
        }));
        assert!(result.is_err());
        assert_eq!(bytes_get(&owner, 0.0), 7.0);
        bytes_set(&owner, 1.0, 8.0);
        assert_eq!(bytes_get(&owner, 1.0), 8.0);
    }

    #[test]
    fn backed_views_are_rejected_before_the_region_executes() {
        let words = bytes_from_elements(vec![1_u32, 2]);
        let view = data_view_new(&words, 0.0, false, 0.0);
        let mut entered = false;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            bytes_with_mut_slice(&view, |_| entered = true);
        }));
        assert!(result.is_err());
        assert!(!entered);
        assert_eq!(bytes_get(&words, 0.0), 1.0);
    }
}

#[cfg(test)]
#[path = "byte_read_regions.test.rs"]
mod byte_read_region_tests;

#[cfg(test)]
#[path = "byte_conversion.test.rs"]
mod byte_conversion_tests;
