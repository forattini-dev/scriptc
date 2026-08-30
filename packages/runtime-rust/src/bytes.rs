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
}

impl ByteBacking {
    fn byte_len(&self) -> usize {
        match self {
            Self::U8(storage) => storage.borrow().len(),
            Self::U32(storage) => storage.borrow().len() * 4,
            Self::I32(storage) => storage.borrow().len() * 4,
            Self::F32(storage) => storage.borrow().len() * 4,
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
        }
    }
}

impl ByteElement for u8 {
    fn from_number(value: f64) -> Self {
        to_uint32(value) as u8
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
}

macro_rules! with_typed_bytes {
    ($value:expr, |$bytes:ident| $body:expr) => {
        match $value {
            JsTypedBytes::U32($bytes) => $body,
            JsTypedBytes::I32($bytes) => $body,
            JsTypedBytes::F32($bytes) => $body,
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
    }
}

pub fn typed_bytes_slice(value: &JsTypedBytes, start: f64, end: f64) -> JsTypedBytes {
    match value {
        JsTypedBytes::U32(value) => JsTypedBytes::U32(bytes_slice(value, start, end, false)),
        JsTypedBytes::I32(value) => JsTypedBytes::I32(bytes_slice(value, start, end, false)),
        JsTypedBytes::F32(value) => JsTypedBytes::F32(bytes_slice(value, start, end, false)),
    }
}

pub fn typed_bytes_ptr_eq(left: &JsTypedBytes, right: &JsTypedBytes) -> bool {
    match (left, right) {
        (JsTypedBytes::U32(left), JsTypedBytes::U32(right)) => left.ptr_eq(right),
        (JsTypedBytes::I32(left), JsTypedBytes::I32(right)) => left.ptr_eq(right),
        (JsTypedBytes::F32(left), JsTypedBytes::F32(right)) => left.ptr_eq(right),
        _ => false,
    }
}

pub fn typed_bytes_deep_equals(left: &JsTypedBytes, right: &JsTypedBytes) -> bool {
    match (left, right) {
        (JsTypedBytes::U32(left), JsTypedBytes::U32(right)) => bytes_deep_equals(left, right),
        (JsTypedBytes::I32(left), JsTypedBytes::I32(right)) => bytes_deep_equals(left, right),
        (JsTypedBytes::F32(left), JsTypedBytes::F32(right)) => bytes_deep_equals(left, right),
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

pub fn process_stdout_write_bytes(bytes: &JsBytes<u8>, encoding: &JsString) -> bool {
    use std::io::Write;
    let _ = encoding;
    bytes
        .with(|data| {
            let storage = data.storage.borrow();
            std::io::stdout()
                .lock()
                .write_all(&storage[data.offset..data.offset + data.length])
        })
        .expect("scriptc: stdout write failed");
    true
}

pub fn process_stderr_write_bytes(bytes: &JsBytes<u8>, encoding: &JsString) -> bool {
    use std::io::Write;
    let _ = encoding;
    bytes
        .with(|data| {
            let storage = data.storage.borrow();
            std::io::stderr()
                .lock()
                .write_all(&storage[data.offset..data.offset + data.length])
        })
        .expect("scriptc: stderr write failed");
    true
}

pub fn bytes_from_array<T: ByteElement>(array: &JsArray<f64>) -> JsBytes<T> {
    let elements: Vec<T> =
        array.with(|data| data.elements.iter().copied().map(T::from_number).collect());
    bytes_from_elements(elements)
}

pub fn bytes_len<T: ByteElement>(bytes: &JsBytes<T>) -> f64 {
    bytes.with(|data| data.length as f64)
}

pub fn bytes_byte_len<T: ByteElement>(bytes: &JsBytes<T>) -> f64 {
    bytes.with(|data| (data.length * std::mem::size_of::<T>()) as f64)
}

fn bytes_index<T: ByteElement>(bytes: &JsBytes<T>, index: f64) -> usize {
    assert!(
        index.is_finite() && index >= 0.0 && index.fract() == 0.0,
        "scriptc: bytes index out of bounds"
    );
    let index = index as usize;
    assert!(
        index < bytes.with(|data| data.length),
        "scriptc: bytes index out of bounds"
    );
    index
}

pub fn bytes_get<T: ByteElement>(bytes: &JsBytes<T>, index: f64) -> f64 {
    let index = bytes_index(bytes, index);
    bytes.with(|data| match &data.backing {
        Some(backing) => f64::from(backing.get(data.offset + index)),
        None => data.storage.borrow()[data.offset + index].to_number(),
    })
}

pub fn bytes_set<T: ByteElement>(bytes: &JsBytes<T>, index: f64, value: f64) {
    let index = bytes_index(bytes, index);
    bytes.with(|data| match &data.backing {
        Some(backing) => backing.set(
            data.offset + index,
            T::from_number(value).to_number() as u8,
        ),
        None => data.storage.borrow_mut()[data.offset + index] = T::from_number(value),
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
    bytes.with(|data| {
        let storage = data.storage.borrow();
        let mut output = String::new();
        for (index, value) in storage[data.offset..data.offset + data.length]
            .iter()
            .enumerate()
        {
            if index > 0 {
                output.push_str(separator);
            }
            output.push_str(&format_number(value.to_number()));
        }
        Rc::from(output)
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
    if !(actual >= 0.0) || actual >= length as f64 {
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
        match encoding.as_ref() {
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
