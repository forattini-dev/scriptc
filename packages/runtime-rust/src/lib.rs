#![forbid(unsafe_code)]

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

static PROCESS_START: OnceLock<std::time::Instant> = OnceLock::new();

/// Owned JavaScript string handle for the static Rust heap.
///
/// `Rc` keeps aliasing explicit and thread-confined. Later heap object
/// families use the same owning-handle rule and add tracing for cycles.
pub type JsString = Rc<str>;

pub struct RegexData {
    compiled: regress::Regex,
    source: JsString,
    flags: JsString,
    unicode: bool,
    global: bool,
    sticky: bool,
    last_index: Cell<usize>,
}

pub type JsRegex = Rc<RegexData>;

pub fn regex_new(pattern: &str, flags: &str) -> JsRegex {
    let parsed_flags = regress::Flags::from(flags);
    let unicode = flags.contains('u') || flags.contains('v');
    let compiled = if unicode {
        regress::Regex::from_unicode(pattern.chars().map(u32::from), parsed_flags)
    } else {
        regress::Regex::from_unicode(pattern.encode_utf16().map(u32::from), parsed_flags)
    }
    .unwrap_or_else(|error| throw_syntax_error(error.to_string()));
    Rc::new(RegexData {
        compiled,
        source: string(pattern),
        flags: string(flags),
        unicode,
        global: flags.contains('g'),
        sticky: flags.contains('y'),
        last_index: Cell::new(0),
    })
}

fn regex_find(
    regex: &JsRegex,
    units: &[u16],
    start: usize,
    sticky: bool,
) -> Option<regress::Match> {
    if regex.unicode {
        regex.compiled.find_from_utf16(units, start).next()
    } else {
        regex.compiled.find_from_ucs2(units, start).next()
    }
    .filter(|matched| !sticky || matched.start() == start)
}

fn advance_string_index(units: &[u16], index: usize, unicode: bool) -> usize {
    if unicode && index + 1 < units.len() {
        let first = units[index];
        let second = units[index + 1];
        if (0xd800..=0xdbff).contains(&first) && (0xdc00..=0xdfff).contains(&second) {
            return index + 2;
        }
    }
    index.saturating_add(1)
}

fn string_from_utf16(units: &[u16]) -> JsString {
    Rc::from(String::from_utf16_lossy(units))
}

pub fn regex_test(regex: &JsRegex, text: &JsString) -> bool {
    let units: Vec<u16> = text.encode_utf16().collect();
    let stateful = regex.global || regex.sticky;
    let start = if stateful { regex.last_index.get() } else { 0 };
    let found = regex_find(regex, &units, start, regex.sticky);
    if stateful {
        regex
            .last_index
            .set(found.as_ref().map_or(0, regress::Match::end));
    }
    found.is_some()
}

fn regex_match_row(units: &[u16], matched: &regress::Match) -> JsArray<JsString> {
    let mut values = Vec::with_capacity(matched.captures.len() + 1);
    values.push(string_from_utf16(&units[matched.range()]));
    for group in &matched.captures {
        values.push(group.as_ref().map_or_else(empty_string, |range| {
            string_from_utf16(&units[range.clone()])
        }));
    }
    array_new(values)
}

pub fn regex_match(subject: &JsString, regex: &JsRegex) -> Option<JsArray<JsString>> {
    let units: Vec<u16> = subject.encode_utf16().collect();
    if regex.global {
        regex.last_index.set(0);
        let mut values = Vec::new();
        let mut position = 0usize;
        while position <= units.len() {
            let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
                break;
            };
            let start = matched.start();
            let end = matched.end();
            values.push(string_from_utf16(&units[matched.range()]));
            position = if start == end {
                advance_string_index(&units, end, regex.unicode)
            } else {
                end
            };
        }
        regex.last_index.set(0);
        return (!values.is_empty()).then(|| array_new(values));
    }
    let start = if regex.sticky {
        regex.last_index.get()
    } else {
        0
    };
    let matched = regex_find(regex, &units, start, regex.sticky);
    if regex.sticky {
        regex
            .last_index
            .set(matched.as_ref().map_or(0, regress::Match::end));
    }
    matched.map(|matched| regex_match_row(&units, &matched))
}

pub fn regex_search(subject: &JsString, regex: &JsRegex) -> f64 {
    let units: Vec<u16> = subject.encode_utf16().collect();
    regex_find(regex, &units, 0, regex.sticky).map_or(-1.0, |matched| matched.start() as f64)
}

fn regex_match_all_impl(
    subject: &JsString,
    regex: &JsRegex,
    indices: Option<&JsArray<f64>>,
) -> JsArray<JsArray<JsString>> {
    if !regex.global {
        throw_type_error(
            "String.prototype.matchAll called with a non-global RegExp argument".to_owned(),
        );
    }
    let units: Vec<u16> = subject.encode_utf16().collect();
    let mut rows = Vec::new();
    let mut position = regex.last_index.get();
    while position <= units.len() {
        let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
            break;
        };
        let start = matched.start();
        let end = matched.end();
        if let Some(indices) = indices {
            array_push(indices, start as f64);
        }
        rows.push(regex_match_row(&units, &matched));
        position = if start == end {
            advance_string_index(&units, end, regex.unicode)
        } else {
            end
        };
    }
    array_new(rows)
}

pub fn regex_match_all(subject: &JsString, regex: &JsRegex) -> JsArray<JsArray<JsString>> {
    regex_match_all_impl(subject, regex, None)
}

pub fn regex_match_all_into(
    subject: &JsString,
    regex: &JsRegex,
    indices: &JsArray<f64>,
) -> JsArray<JsArray<JsString>> {
    regex_match_all_impl(subject, regex, Some(indices))
}

fn regex_put_substitution(
    output: &mut Vec<u16>,
    subject: &[u16],
    matched: &regress::Match,
    replacement: &[u16],
) {
    let whole = matched.range();
    let has_named_groups = matched.named_groups().next().is_some();
    let mut index = 0usize;
    while index < replacement.len() {
        if replacement[index] != b'$' as u16 || index + 1 >= replacement.len() {
            output.push(replacement[index]);
            index += 1;
            continue;
        }
        let next = replacement[index + 1];
        if next == b'$' as u16 {
            output.push(b'$' as u16);
            index += 2;
        } else if next == b'&' as u16 {
            output.extend_from_slice(&subject[whole.clone()]);
            index += 2;
        } else if next == b'`' as u16 {
            output.extend_from_slice(&subject[..whole.start]);
            index += 2;
        } else if next == b'\'' as u16 {
            output.extend_from_slice(&subject[whole.end..]);
            index += 2;
        } else if (b'0' as u16..=b'9' as u16).contains(&next) {
            let mut group = (next - b'0' as u16) as usize;
            let mut consumed = 2usize;
            if index + 2 < replacement.len() {
                let second = replacement[index + 2];
                if (b'0' as u16..=b'9' as u16).contains(&second) {
                    let two_digit = group * 10 + (second - b'0' as u16) as usize;
                    if (1..=matched.captures.len()).contains(&two_digit) {
                        group = two_digit;
                        consumed = 3;
                    }
                }
            }
            if (1..=matched.captures.len()).contains(&group) {
                if let Some(range) = matched.group(group) {
                    output.extend_from_slice(&subject[range]);
                }
                index += consumed;
            } else {
                output.push(b'$' as u16);
                index += 1;
            }
        } else if next == b'<' as u16 && has_named_groups {
            let mut close = index + 2;
            while close < replacement.len() && replacement[close] != b'>' as u16 {
                close += 1;
            }
            if close == replacement.len() {
                output.push(b'$' as u16);
                index += 1;
                continue;
            }
            let name = String::from_utf16_lossy(&replacement[index + 2..close]);
            if let Some(range) = matched
                .named_groups()
                .find_map(|(candidate, range)| (candidate == name).then_some(range).flatten())
            {
                output.extend_from_slice(&subject[range]);
            }
            index = close + 1;
        } else {
            output.push(b'$' as u16);
            index += 1;
        }
    }
}

fn regex_replace_impl(
    subject: &JsString,
    regex: &JsRegex,
    replacement: &JsString,
    require_global: bool,
) -> JsString {
    if require_global && !regex.global {
        throw_type_error(
            "String.prototype.replaceAll called with a non-global RegExp argument".to_owned(),
        );
    }
    let units: Vec<u16> = subject.encode_utf16().collect();
    let replacement_units: Vec<u16> = replacement.encode_utf16().collect();
    let mut output = Vec::new();
    let mut next = 0usize;
    let mut position = if regex.sticky && !regex.global {
        regex.last_index.get()
    } else {
        0
    };
    if regex.global {
        regex.last_index.set(0);
    }
    while position <= units.len() {
        let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
            if regex.global || regex.sticky {
                regex.last_index.set(0);
            }
            break;
        };
        let range = matched.range();
        if regex.global || regex.sticky {
            regex.last_index.set(range.end);
        }
        output.extend_from_slice(&units[next..range.start]);
        regex_put_substitution(&mut output, &units, &matched, &replacement_units);
        next = range.end;
        if !regex.global {
            break;
        }
        position = if range.start == range.end {
            advance_string_index(&units, range.end, regex.unicode)
        } else {
            range.end
        };
    }
    if regex.global {
        regex.last_index.set(0);
    }
    output.extend_from_slice(&units[next..]);
    string_from_utf16(&output)
}

pub fn regex_replace(subject: &JsString, regex: &JsRegex, replacement: &JsString) -> JsString {
    regex_replace_impl(subject, regex, replacement, false)
}

pub fn regex_replace_all(subject: &JsString, regex: &JsRegex, replacement: &JsString) -> JsString {
    regex_replace_impl(subject, regex, replacement, true)
}

pub fn regex_split(subject: &JsString, regex: &JsRegex, limit: f64) -> JsArray<JsString> {
    let limit = to_uint32(limit) as usize;
    if limit == 0 {
        return array_new(Vec::new());
    }
    let units: Vec<u16> = subject.encode_utf16().collect();
    if units.is_empty() {
        return if regex_find(regex, &units, 0, regex.sticky).is_some() {
            array_new(Vec::new())
        } else {
            array_new(vec![empty_string()])
        };
    }
    let mut pieces = Vec::new();
    let mut previous = 0usize;
    let mut position = 0usize;
    while position < units.len() {
        let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
            if !regex.sticky {
                break;
            }
            position = advance_string_index(&units, position, regex.unicode);
            continue;
        };
        if !matched.captures.is_empty() {
            throw_type_error(
                "split() with capture groups in the pattern is not supported (JS splices the captured values into the result); use a non-capturing group (?:...)".to_owned(),
            );
        }
        let range = matched.range();
        if range.end == previous {
            position = advance_string_index(&units, range.start, regex.unicode);
        } else {
            pieces.push(string_from_utf16(&units[previous..range.start]));
            if pieces.len() == limit {
                return array_new(pieces);
            }
            previous = range.end;
            position = previous;
        }
    }
    pieces.push(string_from_utf16(&units[previous..]));
    array_new(pieces)
}

pub fn regex_source(regex: &JsRegex) -> JsString {
    regex.source.clone()
}

pub fn regex_flags(regex: &JsRegex) -> JsString {
    regex.flags.clone()
}

pub fn regexp_escape(value: &JsString) -> JsString {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(value.len());
    for (index, ch) in value.chars().enumerate() {
        let code = u32::from(ch);
        let leading_alphanumeric = index == 0 && ch.is_ascii_alphanumeric();
        let syntax = matches!(
            ch,
            '^' | '$'
                | '\\'
                | '.'
                | '*'
                | '+'
                | '?'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '|'
                | '/'
        );
        let control = match ch {
            '\t' => Some('t'),
            '\n' => Some('n'),
            '\u{000b}' => Some('v'),
            '\u{000c}' => Some('f'),
            '\r' => Some('r'),
            _ => None,
        };
        let hex_escaped = matches!(
            ch,
            ',' | '-'
                | '='
                | '<'
                | '>'
                | '#'
                | '&'
                | '!'
                | '%'
                | ':'
                | ';'
                | '@'
                | '~'
                | '\''
                | '`'
                | '"'
                | ' '
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        );
        if leading_alphanumeric {
            write!(&mut output, "\\x{code:02x}").expect("writing to String cannot fail");
        } else if syntax {
            output.push('\\');
            output.push(ch);
        } else if let Some(control) = control {
            output.push('\\');
            output.push(control);
        } else if hex_escaped {
            if code < 0x100 {
                write!(&mut output, "\\x{code:02x}").expect("writing to String cannot fail");
            } else {
                write!(&mut output, "\\u{code:04x}").expect("writing to String cannot fail");
            }
        } else {
            output.push(ch);
        }
    }
    Rc::from(output)
}

trait DynNode {
    fn id(&self) -> usize;
    fn trace(&self, tracer: &mut Tracer<'_>);
    fn clear_edges(&self);
}

type DynNodeRc = Rc<dyn DynNode>;
type DynNodeWeak = Weak<dyn DynNode>;

thread_local! {
    static NEXT_NODE_ID: Cell<usize> = const { Cell::new(1) };
    static LIVE_NODES: Cell<usize> = const { Cell::new(0) };
    static CYCLE_CANDIDATES: RefCell<Vec<DynNodeWeak>> = const { RefCell::new(Vec::new()) };
    static EXCEPTION_SLOT: RefCell<Option<Rc<dyn Any>>> = const { RefCell::new(None) };
    static PROCESS_ARGV: RefCell<Option<JsArray<JsString>>> = const { RefCell::new(None) };
    static OPEN_FILES: RefCell<HashMap<i32, std::fs::File>> = RefCell::new(HashMap::new());
    #[cfg(not(unix))]
    static NEXT_FILE_ID: Cell<i32> = const { Cell::new(3) };
    static TIMER_TASKS: RefCell<Vec<TimerTask>> = const { RefCell::new(Vec::new()) };
    static NEXT_TIMER_ID: Cell<u64> = const { Cell::new(1) };
    static IMMEDIATE_TASKS: RefCell<Vec<ImmediateTask>> = const { RefCell::new(Vec::new()) };
    static NEXT_IMMEDIATE_ID: Cell<u64> = const { Cell::new(1) };
    static MICROTASKS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
    static NEXT_TICKS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
    static PROMISE_CHECKS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
    static UNHANDLED_REJECTION: Cell<bool> = const { Cell::new(false) };
    static EVENT_TURN: Cell<u64> = const { Cell::new(0) };
    static EVENT_PHASE: Cell<u8> = const { Cell::new(0) };
    static FIRING_TIMER_ID: Cell<u64> = const { Cell::new(0) };
    static FIRING_TIMER_REFRESHED: Cell<bool> = const { Cell::new(false) };
    static FIRING_TIMER_CLEARED: Cell<bool> = const { Cell::new(false) };
    static FIRING_TIMER_REFERENCED: Cell<bool> = const { Cell::new(true) };
    static FS_RENAME_CALLBACKS: RefCell<HashMap<u64, FsRenameCallback>> = RefCell::new(HashMap::new());
}

/// Visitor used by generated heap payloads to expose owning edges.
///
/// The visitor stores only `Weak` references, so a collection pass never
/// changes the liveness result it is trying to compute.
pub struct Tracer<'a> {
    visit: &'a mut dyn FnMut(DynNodeWeak),
}

pub fn init() {
    let _ = PROCESS_START.get_or_init(std::time::Instant::now);
    PROMISE_CHECKS.with(|checks| checks.borrow_mut().clear());
    UNHANDLED_REJECTION.with(|unhandled| unhandled.set(false));
}

fn process_elapsed() -> std::time::Duration {
    PROCESS_START.get_or_init(std::time::Instant::now).elapsed()
}

pub fn process_uptime() -> f64 {
    process_elapsed().as_secs_f64()
}

pub fn performance_now() -> f64 {
    process_elapsed().as_secs_f64() * 1000.0
}

pub fn date_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("scriptc: system clock precedes the Unix epoch")
        .as_millis() as f64
}

impl Tracer<'_> {
    pub fn edge<T>(&mut self, edge: &Gc<T>)
    where
        T: Trace + ClearEdges + 'static,
    {
        let node: DynNodeRc = edge.rc().clone();
        (self.visit)(Rc::downgrade(&node));
    }
}

/// Enumerates every owning heap edge in a payload.
pub trait Trace {
    fn trace(&self, tracer: &mut Tracer<'_>);
}

/// Removes every owning heap edge from a payload.
///
/// Collection calls this only for a set proven unreachable. Implementations
/// must leave scalar data valid, but may empty containers and `take()` object
/// fields. This explicit operation is what lets safe Rust break `Rc` cycles.
pub trait ClearEdges {
    fn clear_edges(&mut self);
}

struct Node<T> {
    id: usize,
    value: RefCell<T>,
}

impl<T> DynNode for Node<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn id(&self) -> usize {
        self.id
    }

    fn trace(&self, tracer: &mut Tracer<'_>) {
        self.value.borrow().trace(tracer);
    }

    fn clear_edges(&self) {
        self.value.borrow_mut().clear_edges();
    }
}

impl<T> Drop for Node<T> {
    fn drop(&mut self) {
        LIVE_NODES.with(|count| count.set(count.get() - 1));
    }
}

/// Owned, address-stable handle for JavaScript heap objects.
///
/// `Gc<T>` deliberately exposes closure-based borrows instead of Rust
/// references whose lifetime could escape a runtime operation. Cloning a
/// handle preserves JavaScript identity. Dropping a handle records a weak
/// cycle candidate; `collect_cycles` performs safe trial deletion later.
pub struct Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    inner: Option<Rc<Node<T>>>,
}

impl<T> Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    pub fn new(value: T) -> Self {
        let id = NEXT_NODE_ID.with(|next| {
            let id = next.get();
            next.set(id.checked_add(1).expect("scriptc: heap id overflow"));
            id
        });
        LIVE_NODES.with(|count| count.set(count.get() + 1));
        Self {
            inner: Some(Rc::new(Node {
                id,
                value: RefCell::new(value),
            })),
        }
    }

    pub fn with<R>(&self, read: impl FnOnce(&T) -> R) -> R {
        read(&self.rc().value.borrow())
    }

    pub fn with_mut<R>(&self, write: impl FnOnce(&mut T) -> R) -> R {
        write(&mut self.rc().value.borrow_mut())
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(self.rc(), other.rc())
    }

    pub fn identity(&self) -> usize {
        self.rc().id
    }

    fn rc(&self) -> &Rc<Node<T>> {
        self.inner.as_ref().expect("scriptc: moved heap handle")
    }
}

impl<T> Clone for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn clone(&self) -> Self {
        Self {
            inner: Some(self.rc().clone()),
        }
    }
}

impl<T> Drop for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn drop(&mut self) {
        let Some(node) = self.inner.take() else {
            return;
        };
        let erased: DynNodeRc = node.clone();
        let candidate = Rc::downgrade(&erased);
        drop(erased);
        drop(node);
        if candidate.strong_count() > 0 {
            CYCLE_CANDIDATES.with(|candidates| candidates.borrow_mut().push(candidate));
        }
    }
}

/// Collect cycles reachable from handles whose reference count decreased.
///
/// The pass snapshots the candidate subgraph, subtracts its internal edges
/// from each node's strong count, marks nodes with outside owners as live,
/// then clears edges only in the unmarked remainder. Working references are
/// explicitly discounted, so the collector itself never keeps garbage live.
pub fn collect_cycles() -> usize {
    let candidates = CYCLE_CANDIDATES.with(|buffer| std::mem::take(&mut *buffer.borrow_mut()));
    let mut nodes = Vec::<DynNodeRc>::new();
    let mut positions = HashMap::<usize, usize>::new();
    let mut queue = VecDeque::<DynNodeRc>::new();

    for candidate in candidates {
        if let Some(node) = candidate.upgrade()
            && !positions.contains_key(&node.id())
        {
            positions.insert(node.id(), nodes.len());
            nodes.push(node.clone());
            queue.push_back(node);
        }
    }

    while let Some(node) = queue.pop_front() {
        node.trace(&mut Tracer {
            visit: &mut |child| {
                let Some(child) = child.upgrade() else {
                    return;
                };
                if positions.contains_key(&child.id()) {
                    return;
                }
                positions.insert(child.id(), nodes.len());
                nodes.push(child.clone());
                queue.push_back(child);
            },
        });
    }

    if nodes.is_empty() {
        return 0;
    }

    let mut incoming = vec![0usize; nodes.len()];
    for node in &nodes {
        node.trace(&mut Tracer {
            visit: &mut |child| {
                if let Some(child) = child.upgrade()
                    && let Some(index) = positions.get(&child.id())
                {
                    incoming[*index] += 1;
                }
            },
        });
    }

    let mut live = HashSet::<usize>::new();
    let mut live_queue = VecDeque::<usize>::new();
    for (index, node) in nodes.iter().enumerate() {
        // One strong reference per node belongs to `nodes`; every other
        // reference not represented by an incoming edge is an outside root.
        let outside = Rc::strong_count(node).saturating_sub(1 + incoming[index]);
        if outside > 0 && live.insert(node.id()) {
            live_queue.push_back(index);
        }
    }

    while let Some(index) = live_queue.pop_front() {
        nodes[index].trace(&mut Tracer {
            visit: &mut |child| {
                let Some(child) = child.upgrade() else {
                    return;
                };
                let Some(child_index) = positions.get(&child.id()).copied() else {
                    return;
                };
                if live.insert(child.id()) {
                    live_queue.push_back(child_index);
                }
            },
        });
    }

    let garbage: Vec<_> = nodes
        .iter()
        .filter(|node| !live.contains(&node.id()))
        .cloned()
        .collect();
    let collected = garbage.len();
    for node in &garbage {
        node.clear_edges();
    }
    drop(garbage);
    drop(nodes);
    collected
}

/// Final safe point for generated executables.
///
/// The optional audit is test-only instrumentation: production binaries pay
/// only the final cycle pass, while differential tests can prove that every
/// traced array/record object was released.
pub fn finish() {
    fs_renames_finish();
    PROCESS_ARGV.with(|slot| *slot.borrow_mut() = None);
    TIMER_TASKS.with(|tasks| tasks.borrow_mut().clear());
    IMMEDIATE_TASKS.with(|tasks| tasks.borrow_mut().clear());
    MICROTASKS.with(|tasks| tasks.borrow_mut().clear());
    NEXT_TICKS.with(|tasks| tasks.borrow_mut().clear());
    PROMISE_CHECKS.with(|checks| checks.borrow_mut().clear());
    collect_cycles();
    if std::env::var_os("SCRIPTC_RUST_HEAP_AUDIT").is_some() {
        let live = live_heap_objects();
        assert_eq!(live, 0, "scriptc: {live} Rust heap object(s) still live");
    }
}

pub fn had_unhandled_rejection() -> bool {
    UNHANDLED_REJECTION.with(Cell::get)
}

struct TimerTask {
    id: u64,
    turn: u64,
    due: std::time::Instant,
    delay: std::time::Duration,
    repeat: bool,
    referenced: bool,
    callback: Box<dyn FnMut()>,
}

struct ImmediateTask {
    id: u64,
    turn: u64,
    referenced: bool,
    callback: Box<dyn FnOnce()>,
}

fn timer_delay(delay_ms: f64) -> std::time::Duration {
    let delay_ms = if delay_ms.is_finite() && delay_ms > 0.0 {
        delay_ms.trunc().min(f64::from(i32::MAX)) as u64
    } else {
        0
    };
    std::time::Duration::from_millis(delay_ms)
}

fn timer_schedule(callback: Box<dyn FnMut()>, delay_ms: f64, repeat: bool) -> f64 {
    let delay = timer_delay(delay_ms);
    let id = NEXT_TIMER_ID.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).expect("scriptc: exhausted timer ids"));
        id
    });
    TIMER_TASKS.with(|tasks| {
        let turn = EVENT_TURN.with(|turn| turn.get());
        let phase = EVENT_PHASE.with(|phase| phase.get());
        tasks.borrow_mut().push(TimerTask {
            id,
            turn: if phase == 1 || phase == 2 {
                turn + 1
            } else {
                turn
            },
            due: std::time::Instant::now() + delay,
            delay,
            repeat,
            referenced: true,
            callback,
        });
    });
    id as f64
}

pub fn timer_set_timeout(callback: Box<dyn FnMut()>, delay_ms: f64) {
    let _ = timer_schedule(callback, delay_ms, false);
}

pub fn timer_set_timeout_handle(callback: Box<dyn FnMut()>, delay_ms: f64) -> f64 {
    timer_schedule(callback, delay_ms, false)
}

pub fn timer_set_interval(callback: Box<dyn FnMut()>, delay_ms: f64) -> f64 {
    timer_schedule(callback, delay_ms, true)
}

pub fn timer_clear(id: f64) {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return;
    }
    let id = id as u64;
    TIMER_TASKS.with(|tasks| tasks.borrow_mut().retain(|task| task.id != id));
    FIRING_TIMER_ID.with(|firing| {
        if firing.get() == id {
            FIRING_TIMER_CLEARED.with(|cleared| cleared.set(true));
        }
    });
}

pub fn timer_set_ref(id: f64, referenced: bool) -> f64 {
    if id.is_finite() && id.fract() == 0.0 && id >= 1.0 && id <= u64::MAX as f64 {
        let id = id as u64;
        TIMER_TASKS.with(|tasks| {
            if let Some(task) = tasks.borrow_mut().iter_mut().find(|task| task.id == id) {
                task.referenced = referenced;
            }
        });
        FIRING_TIMER_ID.with(|firing| {
            if firing.get() == id {
                FIRING_TIMER_REFERENCED.with(|value| value.set(referenced));
            }
        });
    }
    id
}

pub fn timer_has_ref(id: f64) -> bool {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return false;
    }
    let id = id as u64;
    let pending = TIMER_TASKS.with(|tasks| {
        tasks
            .borrow()
            .iter()
            .find(|task| task.id == id)
            .map(|task| task.referenced)
    });
    pending.unwrap_or_else(|| {
        FIRING_TIMER_ID.with(|firing| firing.get() == id)
            && FIRING_TIMER_REFERENCED.with(|referenced| referenced.get())
    })
}

pub fn timer_refresh(id: f64) -> f64 {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return id;
    }
    let id_int = id as u64;
    let refreshed = TIMER_TASKS.with(|tasks| {
        let mut tasks = tasks.borrow_mut();
        if let Some(task) = tasks.iter_mut().find(|task| task.id == id_int) {
            task.due = std::time::Instant::now() + task.delay;
            true
        } else {
            false
        }
    });
    if !refreshed {
        FIRING_TIMER_ID.with(|firing| {
            if firing.get() == id_int {
                FIRING_TIMER_REFRESHED.with(|refreshed| refreshed.set(true));
            }
        });
    }
    id
}

pub fn timer_set_immediate(callback: Box<dyn FnOnce()>) -> f64 {
    let id = NEXT_IMMEDIATE_ID.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).expect("scriptc: exhausted immediate ids"));
        id
    });
    let turn = EVENT_TURN.with(|turn| turn.get());
    let phase = EVENT_PHASE.with(|phase| phase.get());
    IMMEDIATE_TASKS.with(|tasks| {
        tasks.borrow_mut().push(ImmediateTask {
            id,
            turn: if phase == 2 { turn + 1 } else { turn },
            referenced: true,
            callback,
        });
    });
    id as f64
}

pub fn timer_clear_immediate(id: f64) {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return;
    }
    IMMEDIATE_TASKS.with(|tasks| tasks.borrow_mut().retain(|task| task.id != id as u64));
}

pub fn timer_set_immediate_ref(id: f64, referenced: bool) -> f64 {
    if id.is_finite() && id.fract() == 0.0 && id >= 1.0 && id <= u64::MAX as f64 {
        let id = id as u64;
        IMMEDIATE_TASKS.with(|tasks| {
            if let Some(task) = tasks.borrow_mut().iter_mut().find(|task| task.id == id) {
                task.referenced = referenced;
            }
        });
    }
    id
}

pub fn timer_immediate_has_ref(id: f64) -> bool {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return false;
    }
    let id = id as u64;
    IMMEDIATE_TASKS.with(|tasks| {
        tasks
            .borrow()
            .iter()
            .find(|task| task.id == id)
            .is_some_and(|task| task.referenced)
    })
}

pub fn timer_queue_microtask(callback: Box<dyn FnOnce()>) {
    MICROTASKS.with(|tasks| tasks.borrow_mut().push_back(callback));
}

pub fn process_next_tick(callback: Box<dyn FnOnce()>) {
    NEXT_TICKS.with(|tasks| tasks.borrow_mut().push_back(callback));
}

pub fn process_active_resources() -> JsArray<JsString> {
    let timer_count = TIMER_TASKS.with(|tasks| tasks.borrow().len())
        + usize::from(
            FIRING_TIMER_ID.with(|id| id.get() != 0)
                && FIRING_TIMER_CLEARED.with(|cleared| !cleared.get()),
        );
    let immediate_count = IMMEDIATE_TASKS.with(|tasks| tasks.borrow().len());
    let rename_count = FS_RENAME_CALLBACKS.with(|callbacks| callbacks.borrow().len());
    let mut resources = Vec::with_capacity(timer_count + immediate_count + rename_count);
    resources.extend((0..timer_count).map(|_| string("Timeout")));
    resources.extend((0..immediate_count).map(|_| string("Immediate")));
    resources.extend((0..rename_count).map(|_| string("FSReqCallback")));
    array_new(resources)
}

fn proc_stat_fields() -> Option<Vec<String>> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let command_end = stat.rfind(')')?;
    Some(
        stat.get(command_end + 2..)?
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
    )
}

fn proc_stat_value(index: usize) -> f64 {
    proc_stat_fields()
        .and_then(|fields| fields.get(index)?.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn proc_status_value(name: &str) -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                let rest = line.strip_prefix(name)?.trim_start_matches(':').trim();
                rest.split_whitespace().next()?.parse::<f64>().ok()
            })
        })
        .unwrap_or(0.0)
}

pub fn process_cpu_user() -> f64 {
    proc_stat_value(11) * 10_000.0
}

pub fn process_cpu_system() -> f64 {
    proc_stat_value(12) * 10_000.0
}

pub fn process_thread_cpu_user() -> f64 {
    process_cpu_user()
}

pub fn process_thread_cpu_system() -> f64 {
    process_cpu_system()
}

pub fn process_cpu_prev_validate(user: f64, system: f64) {
    for (name, value) in [("user", user), ("system", system)] {
        if !value.is_finite() || value < 0.0 {
            throw_value(JsError {
                name: "RangeError".to_owned(),
                message: format!(
                    "The property 'prevValue.{name}' is invalid. Received {}",
                    format_number(value)
                ),
                code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
            });
        }
    }
}

pub fn process_rusage(index: f64) -> f64 {
    match index as i32 {
        0 => process_cpu_user(),
        1 => process_cpu_system(),
        2 => {
            let linux_high_water = proc_status_value("VmHWM");
            if linux_high_water > 0.0 {
                linux_high_water
            } else {
                std::process::Command::new("ps")
                    .args(["-o", "rss=", "-p"])
                    .arg(std::process::id().to_string())
                    .output()
                    .ok()
                    .filter(|output| output.status.success())
                    .and_then(|output| String::from_utf8(output.stdout).ok())
                    .and_then(|rss| rss.trim().parse::<f64>().ok())
                    .unwrap_or(0.0)
            }
        }
        6 => proc_stat_value(7),
        7 => proc_stat_value(9),
        14 => proc_status_value("voluntary_ctxt_switches"),
        15 => proc_status_value("nonvoluntary_ctxt_switches"),
        _ => 0.0,
    }
}

fn read_memory_number(path: &str) -> f64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|value| value.split_whitespace().next()?.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0)
}

pub fn process_constrained_memory() -> f64 {
    let v2 = read_memory_number("/sys/fs/cgroup/memory.max");
    if v2 > 0.0 {
        v2
    } else {
        read_memory_number("/sys/fs/cgroup/memory/memory.limit_in_bytes")
    }
}

pub fn process_available_memory() -> f64 {
    let host_available = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|info| {
            info.lines().find_map(|line| {
                let rest = line.strip_prefix("MemAvailable:")?.trim();
                rest.split_whitespace().next()?.parse::<f64>().ok()
            })
        })
        .map_or(0.0, |kilobytes| kilobytes * 1024.0);
    let constrained = process_constrained_memory();
    if constrained > 0.0 {
        let used = read_memory_number("/sys/fs/cgroup/memory.current");
        host_available.min((constrained - used).max(0.0))
    } else {
        host_available
    }
}

pub fn run_event_loop() {
    let mut turn = 0_u64;
    loop {
        EVENT_TURN.with(|current| current.set(turn));
        let next_tick = NEXT_TICKS.with(|tasks| tasks.borrow_mut().pop_front());
        if let Some(next_tick) = next_tick {
            EVENT_PHASE.with(|phase| phase.set(4));
            next_tick();
            continue;
        }
        let mut microtask = MICROTASKS.with(|tasks| tasks.borrow_mut().pop_front());
        if microtask.is_some() {
            while let Some(callback) = microtask {
                EVENT_PHASE.with(|phase| phase.set(3));
                callback();
                microtask = MICROTASKS.with(|tasks| tasks.borrow_mut().pop_front());
            }
            continue;
        }

        let mut promise_check = PROMISE_CHECKS.with(|checks| checks.borrow_mut().pop_front());
        if promise_check.is_some() {
            while let Some(check) = promise_check {
                check();
                promise_check = PROMISE_CHECKS.with(|checks| checks.borrow_mut().pop_front());
            }
            if had_unhandled_rejection() {
                break;
            }
            continue;
        }

        if fs_renames_dispatch_one() {
            continue;
        }

        let has_referenced_work = TIMER_TASKS
            .with(|tasks| tasks.borrow().iter().any(|task| task.referenced))
            || IMMEDIATE_TASKS.with(|tasks| tasks.borrow().iter().any(|task| task.referenced))
            || fs_renames_pending();
        if !has_referenced_work {
            break;
        }

        let now = std::time::Instant::now();
        let timer = TIMER_TASKS.with(|tasks| {
            let mut tasks = tasks.borrow_mut();
            let index = tasks
                .iter()
                .enumerate()
                .filter(|(_, task)| task.turn <= turn)
                .min_by_key(|(_, task)| (task.due, task.id))
                .and_then(|(index, task)| (task.due <= now).then_some(index))?;
            Some(tasks.swap_remove(index))
        });
        if let Some(mut timer) = timer {
            EVENT_PHASE.with(|phase| phase.set(1));
            FIRING_TIMER_ID.with(|id| id.set(timer.id));
            FIRING_TIMER_REFRESHED.with(|refreshed| refreshed.set(false));
            FIRING_TIMER_CLEARED.with(|cleared| cleared.set(false));
            FIRING_TIMER_REFERENCED.with(|referenced| referenced.set(timer.referenced));
            (timer.callback)();
            let refreshed = FIRING_TIMER_REFRESHED.with(|refreshed| refreshed.get());
            let cleared = FIRING_TIMER_CLEARED.with(|cleared| cleared.get());
            timer.referenced = FIRING_TIMER_REFERENCED.with(|referenced| referenced.get());
            FIRING_TIMER_ID.with(|id| id.set(0));
            if !cleared && (timer.repeat || refreshed) {
                timer.turn = turn + 1;
                timer.due = std::time::Instant::now() + timer.delay;
                TIMER_TASKS.with(|tasks| tasks.borrow_mut().push(timer));
            }
            continue;
        }

        let immediate = IMMEDIATE_TASKS.with(|tasks| {
            let mut tasks = tasks.borrow_mut();
            let index = tasks
                .iter()
                .enumerate()
                .filter(|(_, task)| task.turn <= turn)
                .min_by_key(|(_, task)| task.id)
                .map(|(index, _)| index)?;
            Some(tasks.swap_remove(index))
        });
        if let Some(immediate) = immediate {
            EVENT_PHASE.with(|phase| phase.set(2));
            (immediate.callback)();
            continue;
        }

        EVENT_PHASE.with(|phase| phase.set(0));
        let has_future_turn = TIMER_TASKS
            .with(|tasks| tasks.borrow().iter().any(|task| task.turn > turn))
            || IMMEDIATE_TASKS.with(|tasks| tasks.borrow().iter().any(|task| task.turn > turn));
        if has_future_turn {
            turn = turn
                .checked_add(1)
                .expect("scriptc: exhausted event-loop turns");
            continue;
        }
        let next_due = TIMER_TASKS.with(|tasks| {
            tasks
                .borrow()
                .iter()
                .filter(|task| task.turn <= turn)
                .map(|task| task.due)
                .min()
        });
        if fs_renames_pending() {
            let wait =
                next_due.and_then(|due| due.checked_duration_since(std::time::Instant::now()));
            fs_renames_wait(wait);
            continue;
        }
        let Some(next_due) = next_due else { break };
        if let Some(wait) = next_due.checked_duration_since(std::time::Instant::now()) {
            std::thread::sleep(wait);
        }
    }
    EVENT_PHASE.with(|phase| phase.set(0));
    EVENT_TURN.with(|turn| turn.set(0));
}

#[doc(hidden)]
pub fn live_heap_objects() -> usize {
    LIVE_NODES.with(Cell::get)
}

/// A typed value that can live inside a captured JavaScript binding.
///
/// Generated closures store bindings as traced `Gc` cells. Scalar and string
/// values have no outgoing heap edges; owning `Gc` handles expose their edge
/// to the cycle collector. Generated union values implement this trait by
/// delegating to their generated `Trace` implementation.
pub trait HeapValue: Clone + 'static {
    fn trace_value(&self, _tracer: &mut Tracer<'_>) {}
}

impl HeapValue for f64 {}
impl HeapValue for bool {}
impl HeapValue for usize {}
impl HeapValue for () {}
impl HeapValue for JsString {}
impl HeapValue for JsRegex {}
impl HeapValue for JsError {}
impl HeapValue for Caught {}

impl<T> HeapValue for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn trace_value(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(self);
    }
}

type PromiseReaction<T> = Box<dyn FnOnce(Result<T, Caught>)>;

enum PromiseState<T: HeapValue> {
    Pending(Vec<PromiseReaction<T>>),
    Fulfilled(Option<T>),
    Rejected(Option<Caught>),
}

pub struct PromiseData<T: HeapValue> {
    state: PromiseState<T>,
    handled: bool,
    reported: bool,
}

impl<T: HeapValue> Trace for PromiseData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let PromiseState::Fulfilled(Some(value)) = &self.state {
            value.trace_value(tracer);
        }
    }
}

impl<T: HeapValue> ClearEdges for PromiseData<T> {
    fn clear_edges(&mut self) {
        self.state = PromiseState::Pending(Vec::new());
        self.handled = true;
    }
}

pub type JsPromise<T> = Gc<PromiseData<T>>;

pub fn promise_new<T: HeapValue>() -> JsPromise<T> {
    Gc::new(PromiseData {
        state: PromiseState::Pending(Vec::new()),
        handled: false,
        reported: false,
    })
}

pub fn promise_resolved<T: HeapValue>(value: T) -> JsPromise<T> {
    Gc::new(PromiseData {
        state: PromiseState::Fulfilled(Some(value)),
        handled: false,
        reported: false,
    })
}

pub fn promise_rejected<T: HeapValue>(reason: Caught) -> JsPromise<T> {
    let promise = promise_new();
    let _ = promise_reject(&promise, reason);
    promise
}

pub fn promise_from_sync<T, F>(operation: F) -> JsPromise<T>
where
    T: HeapValue,
    F: FnOnce() -> T + 'static,
{
    let result = promise_new();
    let guard = result.clone();
    let target = result.clone();
    promise_run_segment(&guard, move || {
        let value = operation();
        let _ = promise_fulfill(&target, value);
    });
    result
}

pub fn promise_timeout(delay_ms: f64) -> JsPromise<()> {
    let promise = promise_new();
    let result = promise.clone();
    timer_set_timeout(
        Box::new(move || {
            let _ = promise_fulfill(&result, ());
        }),
        delay_ms,
    );
    promise
}

pub fn promise_immediate() -> JsPromise<()> {
    let promise = promise_new();
    let result = promise.clone();
    let _ = timer_set_immediate(Box::new(move || {
        let _ = promise_fulfill(&result, ());
    }));
    promise
}

pub fn promise_race<T: HeapValue>(entries: Vec<JsPromise<T>>) -> JsPromise<T> {
    let result = promise_new();
    for entry in entries {
        let target = result.clone();
        promise_then(
            &entry,
            Box::new(move |outcome| match outcome {
                Ok(value) => {
                    let _ = promise_fulfill(&target, value);
                }
                Err(reason) => {
                    let _ = promise_reject(&target, reason);
                }
            }),
        );
    }
    result
}

pub fn promise_race_add<T, U, F>(result: &JsPromise<U>, entry: &JsPromise<T>, adapt: F)
where
    T: HeapValue,
    U: HeapValue,
    F: FnOnce(T) -> U + 'static,
{
    let target = result.clone();
    promise_then(
        entry,
        Box::new(move |outcome| match outcome {
            Ok(value) => {
                let _ = promise_fulfill(&target, adapt(value));
            }
            Err(reason) => {
                let _ = promise_reject(&target, reason);
            }
        }),
    );
}

pub fn promise_all<T>(entries: &JsArray<JsPromise<T>>) -> JsPromise<JsArray<T>>
where
    T: HeapValue + ArrayElement,
{
    let entries = entries.with(|data| data.elements.clone());
    if entries.is_empty() {
        return promise_resolved(array_new(Vec::new()));
    }

    struct State<T>
    where
        T: HeapValue + ArrayElement,
    {
        result: JsPromise<JsArray<T>>,
        values: Vec<Option<T>>,
        remaining: usize,
        settled: bool,
    }

    let result = promise_new();
    let state = Rc::new(RefCell::new(State {
        result: result.clone(),
        values: vec![None; entries.len()],
        remaining: entries.len(),
        settled: false,
    }));
    for (index, entry) in entries.into_iter().enumerate() {
        let state = state.clone();
        promise_then(
            &entry,
            Box::new(move |outcome| {
                let action = {
                    let mut state = state.borrow_mut();
                    if state.settled {
                        return;
                    }
                    match outcome {
                        Ok(value) => {
                            state.values[index] = Some(value);
                            state.remaining -= 1;
                            if state.remaining != 0 {
                                return;
                            }
                            state.settled = true;
                            let values = std::mem::take(&mut state.values)
                                .into_iter()
                                .map(|value| value.expect("scriptc: missing Promise.all value"))
                                .collect();
                            (state.result.clone(), Ok(array_new(values)))
                        }
                        Err(reason) => {
                            state.settled = true;
                            state.values.clear();
                            (state.result.clone(), Err(reason))
                        }
                    }
                };
                match action {
                    (result, Ok(values)) => {
                        let _ = promise_fulfill(&result, values);
                    }
                    (result, Err(reason)) => {
                        let _ = promise_reject(&result, reason);
                    }
                }
            }),
        );
    }
    result
}

pub fn promise_all_void(entries: &JsArray<JsPromise<()>>) -> JsPromise<()> {
    let entries = entries.with(|data| data.elements.clone());
    if entries.is_empty() {
        return promise_resolved(());
    }

    struct State {
        result: JsPromise<()>,
        remaining: usize,
        settled: bool,
    }

    let result = promise_new();
    let state = Rc::new(RefCell::new(State {
        result: result.clone(),
        remaining: entries.len(),
        settled: false,
    }));
    for entry in entries {
        let state = state.clone();
        promise_then(
            &entry,
            Box::new(move |outcome| {
                let action = {
                    let mut state = state.borrow_mut();
                    if state.settled {
                        return;
                    }
                    match outcome {
                        Ok(()) => {
                            state.remaining -= 1;
                            if state.remaining != 0 {
                                return;
                            }
                            state.settled = true;
                            (state.result.clone(), Ok(()))
                        }
                        Err(reason) => {
                            state.settled = true;
                            (state.result.clone(), Err(reason))
                        }
                    }
                };
                match action {
                    (result, Ok(())) => {
                        let _ = promise_fulfill(&result, ());
                    }
                    (result, Err(reason)) => {
                        let _ = promise_reject(&result, reason);
                    }
                }
            }),
        );
    }
    result
}

fn promise_schedule<T: HeapValue>(reaction: PromiseReaction<T>, outcome: Result<T, Caught>) {
    timer_queue_microtask(Box::new(move || reaction(outcome)));
}

pub fn promise_then<T: HeapValue>(promise: &JsPromise<T>, reaction: PromiseReaction<T>) {
    let mut reaction = Some(reaction);
    let settled = promise.with_mut(|data| {
        data.handled = true;
        match &mut data.state {
            PromiseState::Pending(reactions) => {
                reactions.push(reaction.take().expect("scriptc: missing promise reaction"));
                None
            }
            PromiseState::Fulfilled(value) => Some(Ok(value
                .as_ref()
                .expect("scriptc: cleared fulfilled promise")
                .clone())),
            PromiseState::Rejected(reason) => Some(Err(reason
                .as_ref()
                .expect("scriptc: cleared rejected promise")
                .clone())),
        }
    });
    if let Some(outcome) = settled {
        promise_schedule(
            reaction.expect("scriptc: settled promise consumed its reaction"),
            outcome,
        );
    }
}

pub fn promise_map<T, U, F>(promise: &JsPromise<T>, map: F) -> JsPromise<U>
where
    T: HeapValue,
    U: HeapValue,
    F: FnOnce(T) -> U + 'static,
{
    let result = promise_new();
    let target = result.clone();
    promise_then(
        promise,
        Box::new(move |outcome| match outcome {
            Ok(value) => {
                let guard = target.clone();
                promise_run_segment(&guard, move || {
                    let mapped = map(value);
                    let _ = promise_fulfill(&target, mapped);
                });
            }
            Err(reason) => {
                let _ = promise_reject(&target, reason);
            }
        }),
    );
    result
}

pub fn promise_fulfill<T: HeapValue>(promise: &JsPromise<T>, value: T) -> bool {
    let reactions = promise.with_mut(|data| match &mut data.state {
        PromiseState::Pending(reactions) => Some(std::mem::take(reactions)),
        PromiseState::Fulfilled(_) | PromiseState::Rejected(_) => None,
    });
    let Some(reactions) = reactions else {
        return false;
    };
    promise.with_mut(|data| data.state = PromiseState::Fulfilled(Some(value.clone())));
    for reaction in reactions {
        promise_schedule(reaction, Ok(value.clone()));
    }
    true
}

pub fn promise_reject<T: HeapValue>(promise: &JsPromise<T>, reason: Caught) -> bool {
    let reactions = promise.with_mut(|data| match &mut data.state {
        PromiseState::Pending(reactions) => Some(std::mem::take(reactions)),
        PromiseState::Fulfilled(_) | PromiseState::Rejected(_) => None,
    });
    let Some(reactions) = reactions else {
        return false;
    };
    promise.with_mut(|data| data.state = PromiseState::Rejected(Some(reason.clone())));
    for reaction in reactions {
        promise_schedule(reaction, Err(reason.clone()));
    }
    let candidate = promise.clone();
    PROMISE_CHECKS.with(|checks| {
        checks.borrow_mut().push_back(Box::new(move || {
            let unhandled = candidate.with_mut(|data| {
                if data.handled || data.reported {
                    return None;
                }
                let reason = match &data.state {
                    PromiseState::Rejected(Some(reason)) => reason.clone(),
                    PromiseState::Pending(_)
                    | PromiseState::Fulfilled(_)
                    | PromiseState::Rejected(None) => return None,
                };
                data.reported = true;
                Some(reason)
            });
            if let Some(reason) = unhandled {
                eprintln!("UnhandledPromiseRejection: {}", caught_to_string(&reason));
                UNHANDLED_REJECTION.with(|flag| flag.set(true));
            }
        }));
    });
    true
}

pub fn promise_unwrap<T: HeapValue>(outcome: Result<T, Caught>) -> T {
    match outcome {
        Ok(value) => value,
        Err(reason) => rethrow_caught(reason),
    }
}

pub fn promise_run_segment<T, F>(promise: &JsPromise<T>, segment: F)
where
    T: HeapValue,
    F: FnOnce(),
{
    if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(segment)) {
        let _ = promise_reject(promise, caught_from_panic(payload));
    }
}

pub enum AsyncCompletion<T> {
    Fallthrough,
    Suspended,
    Return(T),
}

pub fn promise_try_segment<T, F>(segment: F) -> Result<AsyncCompletion<T>, Caught>
where
    F: FnOnce() -> AsyncCompletion<T>,
{
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(segment)) {
        Ok(completion) => Ok(completion),
        Err(payload) => Err(caught_from_panic(payload)),
    }
}

/// Payload of a shared lexical binding captured by one or more closures.
pub struct CellData<T: HeapValue> {
    value: Option<T>,
}

impl<T: HeapValue> Trace for CellData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(value) = &self.value {
            value.trace_value(tracer);
        }
    }
}

impl<T: HeapValue> ClearEdges for CellData<T> {
    fn clear_edges(&mut self) {
        self.value = None;
    }
}

pub type JsCell<T> = Gc<CellData<T>>;

pub fn cell_new<T: HeapValue>(value: T) -> JsCell<T> {
    Gc::new(CellData { value: Some(value) })
}

pub fn cell_empty<T: HeapValue>() -> JsCell<T> {
    Gc::new(CellData { value: None })
}

pub fn cell_get<T: HeapValue>(cell: &JsCell<T>) -> T {
    cell.with(|data| {
        data.value
            .as_ref()
            .expect("scriptc: read of an uninitialized captured binding")
            .clone()
    })
}

pub fn cell_get_tdz<T: HeapValue>(cell: &JsCell<T>, binding_name: &str) -> T {
    cell.with(|data| match &data.value {
        Some(value) => value.clone(),
        None => throw_reference_error(format!(
            "Cannot access '{binding_name}' before initialization"
        )),
    })
}

pub fn cell_set<T: HeapValue>(cell: &JsCell<T>, value: T) {
    cell.with_mut(|data| data.value = Some(value));
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsError {
    name: String,
    message: String,
    code: Option<String>,
}

impl Trace for JsError {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

pub fn error_new(name: &str, message: JsString) -> JsError {
    JsError {
        name: name.to_owned(),
        message: message.to_string(),
        code: None,
    }
}

#[derive(Clone)]
pub struct Caught {
    value: Rc<dyn Any>,
}

pub fn caught_value<T: 'static>(value: T) -> Caught {
    Caught {
        value: Rc::new(value),
    }
}

pub enum Completion<T> {
    Normal,
    Return(T),
    Throw(Caught),
    Break(usize),
    Continue(usize),
}

struct ScriptThrow;

pub fn throw_value<T: 'static>(value: T) -> ! {
    EXCEPTION_SLOT.with(|slot| {
        let previous = slot.borrow_mut().replace(Rc::new(value));
        assert!(
            previous.is_none(),
            "scriptc: throw with an occupied exception slot"
        );
    });
    std::panic::resume_unwind(Box::new(ScriptThrow))
}

pub fn throw_reference_error(message: String) -> ! {
    throw_value(JsError {
        name: "ReferenceError".to_owned(),
        message,
        code: None,
    })
}

pub fn throw_error_code(message: String, code: &str) -> ! {
    throw_value(JsError {
        name: "Error".to_owned(),
        message,
        code: Some(code.to_owned()),
    })
}

pub fn throw_type_error(message: String) -> ! {
    throw_value(JsError {
        name: "TypeError".to_owned(),
        message,
        code: None,
    })
}

pub fn throw_syntax_error(message: String) -> ! {
    throw_value(JsError {
        name: "SyntaxError".to_owned(),
        message,
        code: None,
    })
}

pub fn throw_range_error(message: String) -> ! {
    throw_value(JsError {
        name: "RangeError".to_owned(),
        message,
        code: None,
    })
}

pub fn caught_from_panic(payload: Box<dyn Any + Send>) -> Caught {
    match payload.downcast::<ScriptThrow>() {
        Ok(_) => EXCEPTION_SLOT.with(|slot| Caught {
            value: slot
                .borrow_mut()
                .take()
                .expect("scriptc: throw marker without an exception value"),
        }),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

pub fn rethrow_caught(caught: Caught) -> ! {
    EXCEPTION_SLOT.with(|slot| {
        let previous = slot.borrow_mut().replace(caught.value);
        assert!(
            previous.is_none(),
            "scriptc: rethrow with an occupied exception slot"
        );
    });
    std::panic::resume_unwind(Box::new(ScriptThrow))
}

pub fn caught_is_error(caught: &Caught) -> bool {
    caught.value.is::<JsError>()
}

pub fn caught_is<T: 'static>(caught: &Caught) -> bool {
    caught.value.is::<T>()
}

pub fn caught_narrow<T: Clone + 'static>(caught: &Caught) -> T {
    caught
        .value
        .downcast_ref::<T>()
        .expect("scriptc: narrowed caught value has the wrong runtime type")
        .clone()
}

pub fn caught_is_error_class(caught: &Caught, name: &str) -> bool {
    caught
        .value
        .downcast_ref::<JsError>()
        .is_some_and(|error| name == "Error" || error.name == name)
}

pub fn caught_check_error(caught: &Caught, name: &str) -> JsError {
    if !caught_is_error_class(caught, name) {
        throw_type_error(format!("caught value is not a {name}"));
    }
    caught_error_value(caught)
}

pub fn caught_error_value(caught: &Caught) -> JsError {
    caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value")
        .clone()
}

pub fn caught_error_name(caught: &Caught) -> JsString {
    let error = caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value");
    Rc::<str>::from(error.name.as_str())
}

pub fn caught_error_message(caught: &Caught) -> JsString {
    let error = caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value");
    Rc::<str>::from(error.message.as_str())
}

pub fn caught_error_code(caught: &Caught) -> Option<JsString> {
    caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value")
        .code
        .as_deref()
        .map(Rc::<str>::from)
}

pub fn caught_to_string(caught: &Caught) -> JsString {
    if let Some(value) = caught.value.downcast_ref::<f64>() {
        return number_to_string(*value);
    }
    if let Some(value) = caught.value.downcast_ref::<bool>() {
        return bool_to_string(*value);
    }
    if let Some(value) = caught.value.downcast_ref::<JsString>() {
        return value.clone();
    }
    if let Some(error) = caught.value.downcast_ref::<JsError>() {
        return error_to_string(error);
    }
    string("[object Object]")
}

pub fn error_to_string_parts(name: &str, message: &str) -> JsString {
    if name.is_empty() {
        return Rc::from(message);
    }
    if message.is_empty() {
        return Rc::from(name);
    }
    Rc::from(format!("{name}: {message}"))
}

pub fn error_to_string(error: &JsError) -> JsString {
    error_to_string_parts(&error.name, &error.message)
}

pub fn error_is_class(error: &JsError, name: &str) -> bool {
    name == "Error" || error.name == name
}

pub fn error_name(error: &JsError) -> JsString {
    Rc::from(error.name.as_str())
}

pub fn error_message(error: &JsError) -> JsString {
    Rc::from(error.message.as_str())
}

pub fn error_code(error: &JsError) -> Option<JsString> {
    error.code.as_deref().map(Rc::from)
}

/// A value that may be stored in a traced JavaScript array.
pub trait ArrayElement: Clone + 'static {
    fn trace_element(&self, _tracer: &mut Tracer<'_>) {}
}

pub trait JoinElement: ArrayElement {
    fn append_joined(&self, output: &mut String);
}

impl ArrayElement for f64 {}
impl ArrayElement for bool {}
impl ArrayElement for usize {}
impl ArrayElement for JsString {}
impl ArrayElement for JsRegex {}

impl JoinElement for f64 {
    fn append_joined(&self, output: &mut String) {
        output.push_str(&format_number(*self));
    }
}

impl JoinElement for bool {
    fn append_joined(&self, output: &mut String) {
        output.push_str(if *self { "true" } else { "false" });
    }
}

impl JoinElement for JsString {
    fn append_joined(&self, output: &mut String) {
        output.push_str(self);
    }
}

impl<T> ArrayElement for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn trace_element(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(self);
    }
}

pub struct ArrayData<T: ArrayElement> {
    elements: Vec<T>,
}

impl<T: ArrayElement> Trace for ArrayData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for element in &self.elements {
            element.trace_element(tracer);
        }
    }
}

impl<T: ArrayElement> ClearEdges for ArrayData<T> {
    fn clear_edges(&mut self) {
        self.elements.clear();
    }
}

pub type JsArray<T> = Gc<ArrayData<T>>;

pub fn array_new<T: ArrayElement>(elements: Vec<T>) -> JsArray<T> {
    Gc::new(ArrayData { elements })
}

pub fn array_len<T: ArrayElement>(array: &JsArray<T>) -> f64 {
    array.with(|data| data.elements.len() as f64)
}

pub fn array_get<T: ArrayElement>(array: &JsArray<T>, index: f64) -> T {
    let index = array_index(index, false, array_len(array) as usize);
    array.with(|data| data.elements[index].clone())
}

pub fn array_set<T: ArrayElement>(array: &JsArray<T>, index: f64, value: T) {
    let len = array_len(array) as usize;
    let index = array_index(index, true, len);
    array.with_mut(|data| {
        if index == len {
            data.elements.push(value);
        } else {
            data.elements[index] = value;
        }
    });
}

pub fn array_push<T: ArrayElement>(array: &JsArray<T>, value: T) -> f64 {
    array.with_mut(|data| {
        data.elements.push(value);
        data.elements.len() as f64
    })
}

pub fn array_extend<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    let snapshot = source.with(|data| data.elements.clone());
    array.with_mut(|data| {
        data.elements.extend(snapshot);
        data.elements.len() as f64
    })
}

pub fn array_unshift<T: ArrayElement>(array: &JsArray<T>, mut values: Vec<T>) -> f64 {
    array.with_mut(|data| {
        values.append(&mut data.elements);
        data.elements = values;
        data.elements.len() as f64
    })
}

pub fn array_unshift_from<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    let snapshot = source.with(|data| data.elements.clone());
    array_unshift(array, snapshot)
}

pub fn array_reverse<T: ArrayElement>(array: &JsArray<T>) -> JsArray<T> {
    array.with_mut(|data| data.elements.reverse());
    array.clone()
}

fn array_relative_index(index: f64, length: usize) -> usize {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if index == f64::NEG_INFINITY {
        return 0;
    }
    if index == f64::INFINITY {
        return length;
    }
    if index < 0.0 {
        (length as f64 + index).clamp(0.0, length as f64) as usize
    } else {
        index.clamp(0.0, length as f64) as usize
    }
}

fn array_delete_count(delete_count: f64, available: usize) -> usize {
    if delete_count.is_nan() || delete_count <= 0.0 {
        0
    } else if delete_count == f64::INFINITY {
        available
    } else {
        delete_count.trunc().min(available as f64) as usize
    }
}

pub fn array_slice<T: ArrayElement>(array: &JsArray<T>, start: f64, end: f64) -> JsArray<T> {
    let elements = array.with(|data| {
        let start = array_relative_index(start, data.elements.len());
        let end = array_relative_index(end, data.elements.len()).max(start);
        data.elements[start..end].to_vec()
    });
    array_new(elements)
}

pub fn array_splice<T: ArrayElement>(
    array: &JsArray<T>,
    start: f64,
    delete_count: f64,
) -> JsArray<T> {
    let removed = array.with_mut(|data| {
        let start = array_relative_index(start, data.elements.len());
        let available = data.elements.len() - start;
        let delete_count = array_delete_count(delete_count, available);
        data.elements
            .drain(start..start + delete_count)
            .collect::<Vec<_>>()
    });
    array_new(removed)
}

pub fn array_shift<T: ArrayElement>(array: &JsArray<T>) -> T {
    array.with_mut(|data| {
        if data.elements.is_empty() {
            panic!("scriptc: array index out of bounds");
        }
        data.elements.remove(0)
    })
}

pub fn array_to_reversed<T: ArrayElement>(array: &JsArray<T>) -> JsArray<T> {
    let mut elements = array.with(|data| data.elements.clone());
    elements.reverse();
    array_new(elements)
}

pub fn array_to_spliced<T: ArrayElement>(
    array: &JsArray<T>,
    start: f64,
    delete_count: f64,
    items: &JsArray<T>,
) -> JsArray<T> {
    let source = array.with(|data| data.elements.clone());
    let items = items.with(|data| data.elements.clone());
    let start = array_relative_index(start, source.len());
    let delete_count = array_delete_count(delete_count, source.len() - start);
    let capacity = (source.len() - delete_count)
        .checked_add(items.len())
        .expect("scriptc: out of memory");
    let mut elements = Vec::with_capacity(capacity);
    elements.extend_from_slice(&source[..start]);
    elements.extend(items);
    elements.extend_from_slice(&source[start + delete_count..]);
    array_new(elements)
}

pub fn array_with<T: ArrayElement>(array: &JsArray<T>, index: f64, value: T) -> JsArray<T> {
    let length = array.with(|data| data.elements.len());
    let relative = if index.is_nan() { 0.0 } else { index.trunc() };
    let actual = if relative >= 0.0 {
        relative
    } else {
        length as f64 + relative
    };
    if !(actual >= 0.0) || actual >= length as f64 {
        throw_range_error(format!("Invalid index : {}", format_number(index)));
    }
    let mut elements = array.with(|data| data.elements.clone());
    elements[actual as usize] = value;
    array_new(elements)
}

pub fn array_index_of_by<T, F>(array: &JsArray<T>, needle: &T, equal: F) -> f64
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array.with(|data| {
        data.elements
            .iter()
            .position(|element| equal(element, needle))
            .map_or(-1.0, |index| index as f64)
    })
}

pub fn array_includes_by<T, F>(array: &JsArray<T>, needle: &T, equal: F) -> bool
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array.with(|data| data.elements.iter().any(|element| equal(element, needle)))
}

pub fn array_join<T: JoinElement>(array: &JsArray<T>, separator: &JsString) -> JsString {
    array.with(|data| {
        let mut output = String::new();
        for (index, element) in data.elements.iter().enumerate() {
            if index > 0 {
                output.push_str(separator);
            }
            element.append_joined(&mut output);
        }
        Rc::<str>::from(output)
    })
}

pub fn array_join_by<T, F>(array: &JsArray<T>, separator: &JsString, append: F) -> JsString
where
    T: ArrayElement,
    F: Fn(&T, &mut String),
{
    array.with(|data| {
        let mut output = String::new();
        for (index, element) in data.elements.iter().enumerate() {
            if index > 0 {
                output.push_str(separator);
            }
            append(element, &mut output);
        }
        Rc::from(output)
    })
}

pub fn array_pop<T: ArrayElement>(array: &JsArray<T>) -> T {
    array
        .with_mut(|data| data.elements.pop())
        .expect("scriptc: array index out of bounds")
}

pub fn array_ptr_eq<T: ArrayElement>(left: &JsArray<T>, right: &JsArray<T>) -> bool {
    left.ptr_eq(right)
}

pub trait ByteElement: Copy + Default + 'static {
    fn from_number(value: f64) -> Self;
    fn to_number(self) -> f64;
}

impl ByteElement for u8 {
    fn from_number(value: f64) -> Self {
        to_uint32(value) as u8
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
}

impl ByteElement for u32 {
    fn from_number(value: f64) -> Self {
        to_uint32(value)
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
}

impl ByteElement for i32 {
    fn from_number(value: f64) -> Self {
        to_int32(value)
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
}

impl ByteElement for f32 {
    fn from_number(value: f64) -> Self {
        value as f32
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
}

pub struct BytesData<T: ByteElement> {
    storage: Rc<RefCell<Vec<T>>>,
    offset: usize,
    length: usize,
}

impl<T: ByteElement> Trace for BytesData<T> {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl<T: ByteElement> ClearEdges for BytesData<T> {
    fn clear_edges(&mut self) {
        self.storage = Rc::new(RefCell::new(Vec::new()));
        self.offset = 0;
        self.length = 0;
    }
}

pub type JsBytes<T> = Gc<BytesData<T>>;

fn bytes_from_elements<T: ByteElement>(elements: Vec<T>) -> JsBytes<T> {
    Gc::new(BytesData {
        length: elements.len(),
        storage: Rc::new(RefCell::new(elements)),
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
        offset: 0,
        length,
    })
}

pub fn bytes_copy<T: ByteElement>(bytes: &JsBytes<T>) -> JsBytes<T> {
    let copied =
        bytes.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    bytes_from_elements(copied)
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
    bytes.with(|data| data.storage.borrow()[data.offset + index].to_number())
}

pub fn bytes_set<T: ByteElement>(bytes: &JsBytes<T>, index: f64, value: f64) {
    let index = bytes_index(bytes, index);
    bytes.with(|data| data.storage.borrow_mut()[data.offset + index] = T::from_number(value));
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
    bytes.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec())
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

fn bytes_validate_offset(name: &str, value: f64, max: f64) {
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
        name: "RangeError".to_owned(),
        message: format!(
            "The value of \"{name}\" is out of range. It must be {requirement}. Received {received}"
        ),
        code: Some("ERR_OUT_OF_RANGE".to_owned()),
    })
}

pub fn bytes_equals(left: &JsBytes<u8>, right: &JsBytes<u8>) -> bool {
    bytes_u8_values(left) == bytes_u8_values(right)
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
            name: "TypeError".to_owned(),
            message: "The argument 'value' is invalid. Received <Buffer >".to_owned(),
            code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
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
            name: "RangeError".to_owned(),
            message: format!("Buffer size must be a multiple of {}-bits", width * 8),
            code: Some("ERR_INVALID_BUFFER_SIZE".to_owned()),
        });
    }
    bytes.with(|data| {
        for group in data.storage.borrow_mut()[data.offset..data.offset + data.length]
            .chunks_exact_mut(width)
        {
            group.reverse();
        }
    });
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

pub fn atomics_wait(bytes: &JsBytes<i32>, index: f64, expected: f64, timeout_ms: f64) -> JsString {
    if bytes_get(bytes, index) != f64::from(to_int32(expected)) {
        return string("not-equal");
    }
    if timeout_ms.is_finite() && timeout_ms > 0.0 {
        std::thread::sleep(std::time::Duration::from_secs_f64(timeout_ms / 1000.0));
    }
    string("timed-out")
}

fn bytes_relative_index(index: f64, length: usize, default: usize) -> usize {
    if index.is_nan() {
        return 0;
    }
    if index == f64::INFINITY {
        return length;
    }
    if index == f64::NEG_INFINITY {
        return 0;
    }
    let index = index.trunc();
    if index < 0.0 {
        (length as f64 + index).max(0.0) as usize
    } else if index.is_finite() {
        index.min(length as f64) as usize
    } else {
        default
    }
}

pub fn bytes_slice<T: ByteElement>(
    bytes: &JsBytes<T>,
    start: f64,
    end: f64,
    view: bool,
) -> JsBytes<T> {
    bytes.with(|data| {
        let start = bytes_relative_index(start, data.length, 0);
        let end = bytes_relative_index(end, data.length, data.length).max(start);
        if view {
            Gc::new(BytesData {
                storage: data.storage.clone(),
                offset: data.offset + start,
                length: end - start,
            })
        } else {
            let copied = data.storage.borrow()[data.offset + start..data.offset + end].to_vec();
            Gc::new(BytesData {
                length: copied.len(),
                storage: Rc::new(RefCell::new(copied)),
                offset: 0,
            })
        }
    })
}

pub fn bytes_set_from<T: ByteElement>(target: &JsBytes<T>, source: &JsBytes<T>, offset: f64) {
    let offset = if offset.is_nan() { 0.0 } else { offset.trunc() };
    let target_length = target.with(|data| data.length);
    let source_values =
        source.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    if offset < 0.0
        || !offset.is_finite()
        || offset > target_length as f64
        || source_values.len() > target_length - offset as usize
    {
        throw_range_error("offset is out of bounds".to_owned());
    }
    target.with(|data| {
        let start = data.offset + offset as usize;
        data.storage.borrow_mut()[start..start + source_values.len()]
            .copy_from_slice(&source_values);
    });
}

fn decode_bytes(values: &[u8], encoding: &str) -> JsString {
    match encoding {
        "hex" => {
            let mut output = String::with_capacity(values.len() * 2);
            for byte in values {
                use std::fmt::Write;
                let _ = write!(output, "{byte:02x}");
            }
            Rc::from(output)
        }
        "base64" => Rc::from(bytes_base64_encode(values)),
        "base64url" => Rc::from(
            bytes_base64_encode(values)
                .replace('+', "-")
                .replace('/', "_")
                .trim_end_matches('=')
                .to_owned(),
        ),
        "utf8" | "utf-8" => Rc::from(String::from_utf8_lossy(values).as_ref()),
        "utf16le" => {
            let units: Vec<u16> = values
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            Rc::from(String::from_utf16_lossy(&units))
        }
        "latin1" => Rc::from(
            values
                .iter()
                .map(|byte| char::from(*byte))
                .collect::<String>(),
        ),
        "ascii" => Rc::from(
            values
                .iter()
                .map(|byte| char::from(*byte & 0x7f))
                .collect::<String>(),
        ),
        other => throw_type_error(format!("Unknown encoding: {other}")),
    }
}

fn bytes_decode_index(index: f64, length: usize) -> usize {
    if index.is_nan() || index <= 0.0 {
        0
    } else if index >= length as f64 {
        length
    } else {
        index.trunc() as usize
    }
}

fn bytes_decode_bounds(length: usize, start: f64, end: f64) -> (usize, usize) {
    let start = bytes_decode_index(start, length);
    let end = bytes_decode_index(end, length).max(start);
    (start, end)
}

fn normalize_buffer_encoding(encoding: &str) -> Option<&'static str> {
    if encoding.eq_ignore_ascii_case("utf8") || encoding.eq_ignore_ascii_case("utf-8") {
        Some("utf8")
    } else if encoding.eq_ignore_ascii_case("hex") {
        Some("hex")
    } else if encoding.eq_ignore_ascii_case("base64") {
        Some("base64")
    } else if encoding.eq_ignore_ascii_case("base64url") {
        Some("base64url")
    } else if encoding.eq_ignore_ascii_case("latin1") || encoding.eq_ignore_ascii_case("binary") {
        Some("latin1")
    } else if encoding.eq_ignore_ascii_case("ascii") {
        Some("ascii")
    } else if encoding.eq_ignore_ascii_case("utf16le")
        || encoding.eq_ignore_ascii_case("utf-16le")
        || encoding.eq_ignore_ascii_case("ucs2")
        || encoding.eq_ignore_ascii_case("ucs-2")
    {
        Some("utf16le")
    } else {
        None
    }
}

fn checked_buffer_encoding(encoding: &JsString) -> &'static str {
    normalize_buffer_encoding(encoding).unwrap_or_else(|| {
        throw_value(JsError {
            name: "TypeError".to_owned(),
            message: format!("Unknown encoding: {encoding}"),
            code: Some("ERR_UNKNOWN_ENCODING".to_owned()),
        })
    })
}

pub fn bytes_to_string(bytes: &JsBytes<u8>, encoding: &JsString) -> JsString {
    bytes_to_string_range(bytes, encoding, 0.0, f64::INFINITY)
}

pub fn bytes_to_string_range(
    bytes: &JsBytes<u8>,
    encoding: &JsString,
    start: f64,
    end: f64,
) -> JsString {
    bytes.with(|data| {
        let (start, end) = bytes_decode_bounds(data.length, start, end);
        let storage = data.storage.borrow();
        decode_bytes(
            &storage[data.offset + start..data.offset + end],
            encoding.as_ref(),
        )
    })
}

pub fn bytes_to_string_checked(bytes: &JsBytes<u8>, encoding: &JsString) -> JsString {
    if bytes.with(|data| data.length) == 0 {
        return empty_string();
    }
    let encoding = checked_buffer_encoding(encoding);
    bytes_to_string(bytes, &string(encoding))
}

pub fn bytes_to_string_checked_range(
    bytes: &JsBytes<u8>,
    encoding: &JsString,
    start: f64,
    end: f64,
) -> JsString {
    let (start, end) = bytes.with(|data| bytes_decode_bounds(data.length, start, end));
    if start == end {
        return empty_string();
    }
    let encoding = checked_buffer_encoding(encoding);
    bytes_to_string_range(bytes, &string(encoding), start as f64, end as f64)
}

fn string_decoder_unpack(pending: f64) -> Vec<u8> {
    let packed = pending as u32;
    let length = (packed & 0xff).min(3) as usize;
    (0..length)
        .map(|index| (packed >> (8 * (index + 1))) as u8)
        .collect()
}

fn string_decoder_pack(bytes: &[u8]) -> f64 {
    let mut packed = bytes.len().min(3) as u32;
    for (index, byte) in bytes.iter().take(3).enumerate() {
        packed |= u32::from(*byte) << (8 * (index + 1));
    }
    f64::from(packed)
}

fn string_decoder_combined(pending: f64, chunk: &JsBytes<u8>) -> Vec<u8> {
    let mut combined = string_decoder_unpack(pending);
    combined.extend(bytes_u8_values(chunk));
    combined
}

fn string_decoder_utf8_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        let needed = if byte & 0xe0 == 0xc0 {
            2
        } else if byte & 0xf0 == 0xe0 {
            3
        } else if byte & 0xf8 == 0xf0 {
            4
        } else {
            return 0;
        };
        return usize::from(back < needed) * back;
    }
    0
}

fn string_decoder_base64(values: &[u8], url: bool) -> JsString {
    let output = bytes_base64_encode(values);
    if url {
        Rc::from(
            output
                .replace('+', "-")
                .replace('/', "_")
                .trim_end_matches('=')
                .to_owned(),
        )
    } else {
        Rc::from(output)
    }
}

fn string_decoder_utf16_step(pending: f64, chunk: &JsBytes<u8>) -> (JsString, f64) {
    let held = string_decoder_unpack(pending);
    let chunk = bytes_u8_values(chunk);
    let mut complete = Vec::with_capacity(4);
    let mut offset = 0;
    if !held.is_empty() {
        let total = if held.len() == 1 { 2 } else { 4 };
        let needed = total - held.len();
        if chunk.len() < needed {
            let mut next = held;
            next.extend_from_slice(&chunk);
            return (empty_string(), string_decoder_pack(&next));
        }
        complete.extend_from_slice(&held);
        complete.extend_from_slice(&chunk[..needed]);
        offset = needed;
    }
    let rest = &chunk[offset..];
    let keep = if rest.len() % 2 == 1 {
        rest.len() - 1
    } else if rest.len() >= 2 {
        let last = u16::from_le_bytes([rest[rest.len() - 2], rest[rest.len() - 1]]);
        if (0xd800..=0xdbff).contains(&last) {
            rest.len() - 2
        } else {
            rest.len()
        }
    } else {
        0
    };
    let next = string_decoder_pack(&rest[keep..]);
    complete.extend_from_slice(&rest[..keep]);
    (decode_bytes(&complete, "utf16le"), next)
}

fn string_decoder_step(encoding: &JsString, pending: f64, chunk: &JsBytes<u8>) -> (JsString, f64) {
    match encoding.as_ref() {
        "utf16le" => string_decoder_utf16_step(pending, chunk),
        "base64" | "base64url" => {
            let combined = string_decoder_combined(pending, chunk);
            let tail = combined.len() % 3;
            let complete = combined.len() - tail;
            (
                string_decoder_base64(&combined[..complete], encoding.as_ref() == "base64url"),
                string_decoder_pack(&combined[complete..]),
            )
        }
        "latin1" | "ascii" | "hex" => {
            let values = bytes_u8_values(chunk);
            (decode_bytes(&values, encoding), 0.0)
        }
        "utf8" | "utf-8" => {
            let combined = string_decoder_combined(pending, chunk);
            let tail = string_decoder_utf8_tail(&combined);
            let complete = combined.len() - tail;
            (
                decode_bytes(&combined[..complete], "utf8"),
                string_decoder_pack(&combined[complete..]),
            )
        }
        other => panic!("scriptc: invalid canonical StringDecoder encoding '{other}'"),
    }
}

pub fn string_decoder_write(encoding: &JsString, pending: f64, chunk: &JsBytes<u8>) -> JsString {
    string_decoder_step(encoding, pending, chunk).0
}

pub fn string_decoder_next(encoding: &JsString, pending: f64, chunk: &JsBytes<u8>) -> f64 {
    string_decoder_step(encoding, pending, chunk).1
}

pub fn string_decoder_end(encoding: &JsString, pending: f64) -> JsString {
    let pending = string_decoder_unpack(pending);
    match encoding.as_ref() {
        "base64" => string_decoder_base64(&pending, false),
        "base64url" => string_decoder_base64(&pending, true),
        "utf16le" => decode_bytes(&pending, "utf16le"),
        "latin1" | "ascii" | "hex" => empty_string(),
        "utf8" | "utf-8" => decode_bytes(&pending, "utf8"),
        other => panic!("scriptc: invalid canonical StringDecoder encoding '{other}'"),
    }
}

fn bytes_from_vec(values: Vec<u8>) -> JsBytes<u8> {
    Gc::new(BytesData {
        length: values.len(),
        storage: Rc::new(RefCell::new(values)),
        offset: 0,
    })
}

fn bytes_hex_decode(text: &str) -> Vec<u8> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let mut output = Vec::with_capacity(text.len() / 2);
    for pair in text.as_bytes().chunks_exact(2) {
        let (Some(high), Some(low)) = (nibble(pair[0]), nibble(pair[1])) else {
            break;
        };
        output.push((high << 4) | low);
    }
    output
}

fn bytes_base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

fn bytes_base64_decode(text: &str) -> Vec<u8> {
    let values: Vec<u8> = text
        .bytes()
        .take_while(|byte| *byte != b'=')
        .filter_map(bytes_base64_value)
        .collect();
    let mut output = Vec::with_capacity(values.len() * 3 / 4);
    for chunk in values.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        output.push((chunk[0] << 2) | (chunk[1] >> 4));
        if chunk.len() >= 3 {
            output.push((chunk[1] << 4) | (chunk[2] >> 2));
        }
        if chunk.len() == 4 {
            output.push((chunk[2] << 6) | chunk[3]);
        }
    }
    output
}

fn bytes_base64_encode(values: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(values.len().div_ceil(3) * 4);
    for chunk in values.chunks(3) {
        output.push(char::from(ALPHABET[(chunk[0] >> 2) as usize]));
        output.push(char::from(
            ALPHABET[((chunk[0] & 3) << 4 | chunk.get(1).copied().unwrap_or(0) >> 4) as usize],
        ));
        if let Some(second) = chunk.get(1) {
            output.push(char::from(
                ALPHABET[((second & 15) << 2 | chunk.get(2).copied().unwrap_or(0) >> 6) as usize],
            ));
        } else {
            output.push('=');
        }
        if let Some(third) = chunk.get(2) {
            output.push(char::from(ALPHABET[(third & 63) as usize]));
        } else {
            output.push('=');
        }
    }
    output
}

fn buffer_string_bytes(value: &JsString, encoding: &JsString) -> Vec<u8> {
    match encoding.as_ref() {
        "hex" => bytes_hex_decode(value),
        "base64" | "base64url" => bytes_base64_decode(value),
        "utf8" | "utf-8" => value.as_bytes().to_vec(),
        "utf16le" => value.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        "latin1" | "ascii" => value.encode_utf16().map(|unit| unit as u8).collect(),
        other => throw_type_error(format!("Unknown encoding: {other}")),
    }
}

pub fn buffer_from_string(value: &JsString, encoding: &JsString) -> JsBytes<u8> {
    bytes_from_vec(buffer_string_bytes(value, encoding))
}

pub fn buffer_concat(values: &JsArray<JsBytes<u8>>) -> JsBytes<u8> {
    let mut output = Vec::new();
    values.with(|array| {
        for bytes in &array.elements {
            bytes.with(|data| {
                output.extend_from_slice(
                    &data.storage.borrow()[data.offset..data.offset + data.length],
                );
            });
        }
    });
    bytes_from_vec(output)
}

pub fn buffer_concat_len(values: &JsArray<JsBytes<u8>>, total: f64) -> JsBytes<u8> {
    if array_len(values) == 0.0 {
        return bytes_empty();
    }
    bytes_validate_offset("length", total, 9_007_199_254_740_991.0);
    let mut output = vec![0; total as usize];
    let mut offset = 0;
    values.with(|array| {
        for bytes in &array.elements {
            if offset == output.len() {
                break;
            }
            let part = bytes_u8_values(bytes);
            let count = part.len().min(output.len() - offset);
            output[offset..offset + count].copy_from_slice(&part[..count]);
            offset += count;
        }
    });
    bytes_from_vec(output)
}

pub fn buffer_byte_length_string(value: &JsString, encoding: &JsString) -> f64 {
    let units: Vec<u16> = value.encode_utf16().collect();
    match encoding.as_ref() {
        "latin1" | "ascii" => units.len() as f64,
        "utf16le" => (units.len() * 2) as f64,
        "hex" => (units.len() / 2) as f64,
        "base64" | "base64url" => {
            let mut length = units.len();
            if units.get(length.wrapping_sub(1)) == Some(&u16::from(b'=')) {
                length -= 1;
            }
            if units.get(length.wrapping_sub(1)) == Some(&u16::from(b'=')) {
                length -= 1;
            }
            ((length * 3) >> 2) as f64
        }
        "utf8" | "utf-8" => value.len() as f64,
        other => panic!("scriptc: invalid canonical Buffer encoding '{other}'"),
    }
}

pub fn buffer_is_encoding(value: &JsString) -> bool {
    normalize_buffer_encoding(value).is_some()
}

fn bytes_num_width(kind: &str) -> usize {
    match kind {
        "u8" | "i8" => 1,
        "u16be" | "u16le" | "i16be" | "i16le" => 2,
        "u32be" | "u32le" | "i32be" | "i32le" | "f32be" | "f32le" => 4,
        "f64be" | "f64le" => 8,
        _ => panic!("scriptc: invalid bytes numeric kind"),
    }
}

fn bytes_bounds_error(value: f64, length: f64, value_name: Option<&str>) -> ! {
    if value.floor() != value {
        throw_value(JsError {
            name: "RangeError".to_owned(),
            message: format!(
                "The value of \"{}\" is out of range. It must be an integer. Received {}",
                value_name.unwrap_or("offset"),
                bytes_received_number(value)
            ),
            code: Some("ERR_OUT_OF_RANGE".to_owned()),
        });
    }
    if length < 0.0 {
        throw_value(JsError {
            name: "RangeError".to_owned(),
            message: "Attempt to access memory outside buffer bounds".to_owned(),
            code: Some("ERR_BUFFER_OUT_OF_BOUNDS".to_owned()),
        });
    }
    throw_value(JsError {
        name: "RangeError".to_owned(),
        message: format!(
            "The value of \"{}\" is out of range. It must be >= {} and <= {}. Received {}",
            value_name.unwrap_or("offset"),
            usize::from(value_name.is_some()),
            format_number(length),
            bytes_received_number(value)
        ),
        code: Some("ERR_OUT_OF_RANGE".to_owned()),
    })
}

fn bytes_num_offset(bytes: &JsBytes<u8>, offset: f64, width: usize) -> usize {
    let capacity = bytes.with(|data| data.length as f64) - width as f64;
    if offset.floor() != offset || capacity < 0.0 || offset < 0.0 || offset > capacity {
        bytes_bounds_error(offset, capacity, None);
    }
    offset as usize
}

fn bytes_check_int(
    bytes: &JsBytes<u8>,
    value: f64,
    offset: f64,
    width: usize,
    signed: bool,
) -> usize {
    let exponent = width * 8 - usize::from(signed);
    let limit = 2_f64.powi(exponent as i32);
    let (minimum, maximum) = if signed {
        (-limit, limit - 1.0)
    } else {
        (0.0, limit - 1.0)
    };
    if value > maximum || value < minimum {
        let requirement = if width > 4 {
            if signed {
                format!(">= -(2 ** {exponent}) and < 2 ** {exponent}")
            } else {
                format!(">= 0 and < 2 ** {exponent}")
            }
        } else {
            format!(
                ">= {} and <= {}",
                format_number(minimum),
                format_number(maximum)
            )
        };
        throw_value(JsError {
            name: "RangeError".to_owned(),
            message: format!(
                "The value of \"value\" is out of range. It must be {requirement}. Received {}",
                bytes_received_number(value)
            ),
            code: Some("ERR_OUT_OF_RANGE".to_owned()),
        });
    }
    bytes_num_offset(bytes, offset, width)
}

fn bytes_read_unsigned(
    bytes: &JsBytes<u8>,
    offset: usize,
    width: usize,
    little_endian: bool,
) -> u64 {
    bytes.with(|data| {
        let storage = data.storage.borrow();
        let input = &storage[data.offset + offset..data.offset + offset + width];
        let mut value = 0_u64;
        for index in 0..width {
            value |= u64::from(
                input[if little_endian {
                    index
                } else {
                    width - 1 - index
                }],
            ) << (8 * index);
        }
        value
    })
}

fn bytes_write_unsigned(
    bytes: &JsBytes<u8>,
    offset: usize,
    width: usize,
    little_endian: bool,
    value: u64,
) {
    bytes.with(|data| {
        let mut storage = data.storage.borrow_mut();
        let output = &mut storage[data.offset + offset..data.offset + offset + width];
        for index in 0..width {
            output[if little_endian {
                index
            } else {
                width - 1 - index
            }] = (value >> (8 * index)) as u8;
        }
    });
}

pub fn bytes_read_num(bytes: &JsBytes<u8>, kind: &str, offset: f64) -> f64 {
    let width = bytes_num_width(kind);
    let offset = bytes_num_offset(bytes, offset, width);
    bytes.with(|data| {
        let storage = data.storage.borrow();
        let input = &storage[data.offset + offset..data.offset + offset + width];
        match kind {
            "u8" => f64::from(input[0]),
            "i8" => f64::from(input[0] as i8),
            "u16be" => f64::from(u16::from_be_bytes([input[0], input[1]])),
            "u16le" => f64::from(u16::from_le_bytes([input[0], input[1]])),
            "i16be" => f64::from(i16::from_be_bytes([input[0], input[1]])),
            "i16le" => f64::from(i16::from_le_bytes([input[0], input[1]])),
            "u32be" => f64::from(u32::from_be_bytes(input.try_into().expect("four bytes"))),
            "u32le" => f64::from(u32::from_le_bytes(input.try_into().expect("four bytes"))),
            "i32be" => f64::from(i32::from_be_bytes(input.try_into().expect("four bytes"))),
            "i32le" => f64::from(i32::from_le_bytes(input.try_into().expect("four bytes"))),
            "f32be" => f64::from(f32::from_be_bytes(input.try_into().expect("four bytes"))),
            "f32le" => f64::from(f32::from_le_bytes(input.try_into().expect("four bytes"))),
            "f64be" => f64::from_be_bytes(input.try_into().expect("eight bytes")),
            "f64le" => f64::from_le_bytes(input.try_into().expect("eight bytes")),
            _ => unreachable!(),
        }
    })
}

pub fn bytes_write_num(bytes: &JsBytes<u8>, kind: &str, value: f64, offset: f64) -> f64 {
    let width = bytes_num_width(kind);
    let integer = !matches!(kind, "f32be" | "f32le" | "f64be" | "f64le");
    let signed = matches!(kind, "i8" | "i16be" | "i16le" | "i32be" | "i32le");
    let offset = if integer {
        bytes_check_int(bytes, value, offset, width, signed)
    } else {
        bytes_num_offset(bytes, offset, width)
    };
    let bits = match kind {
        "u8" | "u16be" | "u16le" | "u32be" | "u32le" | "i8" | "i16be" | "i16le" | "i32be"
        | "i32le" => (if value.is_nan() {
            0
        } else {
            value.trunc() as i64
        } as u64)
            .to_be_bytes(),
        "f32be" | "f32le" => u64::from((value as f32).to_bits()).to_be_bytes(),
        "f64be" | "f64le" => value.to_bits().to_be_bytes(),
        _ => unreachable!(),
    };
    let source = &bits[8 - width..];
    bytes.with(|data| {
        let mut storage = data.storage.borrow_mut();
        let output = &mut storage[data.offset + offset..data.offset + offset + width];
        if kind.ends_with("le") {
            for (target, source) in output.iter_mut().zip(source.iter().rev()) {
                *target = *source;
            }
        } else {
            output.copy_from_slice(source);
        }
    });
    (offset + width) as f64
}

fn bytes_num_var_kind(kind: &str) -> (bool, bool) {
    match kind {
        "ube" => (false, false),
        "ule" => (false, true),
        "ibe" => (true, false),
        "ile" => (true, true),
        _ => panic!("scriptc: invalid variable-width bytes numeric kind"),
    }
}

fn bytes_num_var_width(byte_length: f64) -> usize {
    if byte_length.floor() != byte_length || !(1.0..=6.0).contains(&byte_length) {
        bytes_bounds_error(byte_length, 6.0, Some("byteLength"));
    }
    byte_length as usize
}

pub fn bytes_read_num_var(bytes: &JsBytes<u8>, kind: &str, offset: f64, byte_length: f64) -> f64 {
    let width = bytes_num_var_width(byte_length);
    let offset = bytes_num_offset(bytes, offset, width);
    let (signed, little_endian) = bytes_num_var_kind(kind);
    let value = bytes_read_unsigned(bytes, offset, width, little_endian);
    if signed && value & (1_u64 << (width * 8 - 1)) != 0 {
        (value as i64 - (1_i64 << (width * 8))) as f64
    } else {
        value as f64
    }
}

pub fn bytes_write_num_var(
    bytes: &JsBytes<u8>,
    kind: &str,
    value: f64,
    offset: f64,
    byte_length: f64,
) -> f64 {
    let width = bytes_num_var_width(byte_length);
    let (signed, little_endian) = bytes_num_var_kind(kind);
    let offset = bytes_check_int(bytes, value, offset, width, signed);
    let value = if value.is_nan() {
        0
    } else {
        value.trunc() as i64
    } as u64;
    bytes_write_unsigned(bytes, offset, width, little_endian, value);
    (offset + width) as f64
}

pub struct MapData<K: Clone + 'static, V: HeapValue> {
    entries: Vec<Option<(K, V)>>,
    live: usize,
    iteration_depth: usize,
}

impl<K: Clone + 'static, V: HeapValue> Trace for MapData<K, V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for entry in &self.entries {
            if let Some((_, value)) = entry {
                value.trace_value(tracer);
            }
        }
    }
}

impl<K: Clone + 'static, V: HeapValue> ClearEdges for MapData<K, V> {
    fn clear_edges(&mut self) {
        self.entries.clear();
    }
}

pub type JsMap<K, V> = Gc<MapData<K, V>>;

pub fn map_new<K: Clone + 'static, V: HeapValue>() -> JsMap<K, V> {
    Gc::new(MapData {
        entries: Vec::new(),
        live: 0,
        iteration_depth: 0,
    })
}

pub fn map_set_by<K, V, F>(map: &JsMap<K, V>, key: K, value: V, equal: F)
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with_mut(|data| {
        if let Some((_, stored)) = data
            .entries
            .iter_mut()
            .flatten()
            .find(|(stored, _)| equal(stored, &key))
        {
            *stored = value;
        } else {
            data.entries.push(Some((key, value)));
            data.live += 1;
        }
    });
}

pub fn map_get_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> Option<V>
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with(|data| {
        data.entries
            .iter()
            .flatten()
            .find(|(stored, _)| equal(stored, key))
            .map(|(_, value)| value.clone())
    })
}

pub fn map_has_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> bool
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with(|data| {
        data.entries
            .iter()
            .flatten()
            .any(|(stored, _)| equal(stored, key))
    })
}

pub fn map_delete_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> bool
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with_mut(|data| {
        let Some(index) = data
            .entries
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|(stored, _)| equal(stored, key)))
        else {
            return false;
        };
        data.entries[index] = None;
        data.live -= 1;
        if data.iteration_depth == 0 {
            data.entries.retain(Option::is_some);
        }
        true
    })
}

pub fn map_size<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> f64 {
    map.with(|data| data.live as f64)
}

pub fn map_clear<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| {
        data.live = 0;
        if data.iteration_depth == 0 {
            data.entries.clear();
        } else {
            for entry in &mut data.entries {
                *entry = None;
            }
        }
    });
}

pub fn map_iter_count<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> f64 {
    map.with(|data| data.entries.len() as f64)
}

pub fn map_iter_live<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> bool {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| data.entries[index].is_some())
}

pub fn map_iter_key<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> K {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| {
        data.entries[index]
            .as_ref()
            .expect("scriptc: map key read from a tombstone")
            .0
            .clone()
    })
}

pub fn map_iter_value<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> V {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| {
        data.entries[index]
            .as_ref()
            .expect("scriptc: map value read from a tombstone")
            .1
            .clone()
    })
}

pub fn map_iter_enter<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| data.iteration_depth += 1);
}

pub fn map_iter_exit<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| {
        data.iteration_depth = data
            .iteration_depth
            .checked_sub(1)
            .expect("scriptc: unbalanced map iteration exit");
        if data.iteration_depth == 0 {
            data.entries.retain(Option::is_some);
        }
    });
}

fn js_property_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

fn map_string_entry_order<V: HeapValue>(data: &MapData<JsString, V>) -> Vec<usize> {
    let mut indexes = Vec::new();
    let mut names = Vec::new();
    for (position, entry) in data.entries.iter().enumerate() {
        let Some((key, _)) = entry else { continue };
        if let Some(index) = js_property_index(key) {
            indexes.push((index, position));
        } else {
            names.push(position);
        }
    }
    indexes.sort_unstable_by_key(|(index, _)| *index);
    indexes
        .into_iter()
        .map(|(_, position)| position)
        .chain(names)
        .collect()
}

pub fn map_string_keys_js_order<V: HeapValue>(map: &JsMap<JsString, V>) -> JsArray<JsString> {
    array_new(map.with(|data| {
        map_string_entry_order(data)
            .into_iter()
            .map(|position| {
                data.entries[position]
                    .as_ref()
                    .expect("scriptc: ordered map key points at a tombstone")
                    .0
                    .clone()
            })
            .collect()
    }))
}

pub type JsSet<T> = JsMap<T, bool>;

pub fn set_new<T: Clone + 'static>() -> JsSet<T> {
    map_new()
}

pub fn set_from_array_by<T, N, F>(source: &JsArray<T>, normalize: N, equal: F) -> JsSet<T>
where
    T: ArrayElement,
    N: Fn(T) -> T,
    F: Fn(&T, &T) -> bool + Copy,
{
    let set = set_new();
    let values = source.with(|data| data.elements.clone());
    for value in values {
        map_set_by(&set, normalize(value), true, equal);
    }
    set
}

pub fn set_add_by<T, F>(set: &JsSet<T>, value: T, equal: F)
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_set_by(set, value, true, equal);
}

pub fn set_has_by<T, F>(set: &JsSet<T>, value: &T, equal: F) -> bool
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_has_by(set, value, equal)
}

pub fn set_delete_by<T, F>(set: &JsSet<T>, value: &T, equal: F) -> bool
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_delete_by(set, value, equal)
}

pub fn set_to_array<T: ArrayElement>(set: &JsSet<T>) -> JsArray<T> {
    let values = set.with(|data| {
        data.entries
            .iter()
            .filter_map(|entry| entry.as_ref().map(|(value, _)| value.clone()))
            .collect()
    });
    array_new(values)
}

fn array_index(index: f64, allow_end: bool, len: usize) -> usize {
    if !index.is_finite() || index < 0.0 || index.fract() != 0.0 || index > usize::MAX as f64 {
        panic!("scriptc: invalid array index");
    }
    let index = index as usize;
    if index > len || (!allow_end && index == len) {
        panic!("scriptc: array index out of bounds");
    }
    index
}

pub fn empty_string() -> JsString {
    Rc::from("")
}

pub fn string(value: &str) -> JsString {
    Rc::from(value)
}

pub fn string_concat(left: &JsString, right: &JsString) -> JsString {
    let mut result = String::with_capacity(left.len() + right.len());
    result.push_str(left);
    result.push_str(right);
    Rc::from(result)
}

pub fn string_len(value: &JsString) -> f64 {
    value.encode_utf16().count() as f64
}

pub fn string_char_at(value: &JsString, index: f64) -> JsString {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return empty_string();
    }
    let target = index as usize;
    let mut position = 0usize;
    for ch in value.chars() {
        let width = ch.len_utf16();
        if target == position {
            return if width == 1 {
                Rc::from(ch.to_string())
            } else {
                // Like the C runtime, safe UTF-8 storage cannot represent
                // the lone surrogate JavaScript returns for an astral half.
                string("\u{fffd}")
            };
        }
        if width == 2 && target == position + 1 {
            return string("\u{fffd}");
        }
        position += width;
    }
    empty_string()
}

pub fn string_char_code_at(value: &JsString, index: f64) -> f64 {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return f64::NAN;
    }
    value
        .encode_utf16()
        .nth(index as usize)
        .map_or(f64::NAN, f64::from)
}

fn relative_string_index(index: f64, len: usize) -> usize {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if index == f64::NEG_INFINITY {
        return 0;
    }
    if index == f64::INFINITY {
        return len;
    }
    if index < 0.0 {
        (len as f64 + index).clamp(0.0, len as f64) as usize
    } else {
        index.clamp(0.0, len as f64) as usize
    }
}

pub fn string_index_of(value: &JsString, search: &JsString, from_index: f64) -> f64 {
    let haystack: Vec<u16> = value.encode_utf16().collect();
    let needle: Vec<u16> = search.encode_utf16().collect();
    let start = if from_index.is_nan() {
        0
    } else if from_index == f64::INFINITY {
        haystack.len()
    } else {
        from_index.trunc().clamp(0.0, haystack.len() as f64) as usize
    };
    if needle.is_empty() {
        return start as f64;
    }
    haystack[start..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map_or(-1.0, |index| (start + index) as f64)
}

pub fn string_last_index_of(value: &JsString, search: &JsString) -> f64 {
    let haystack: Vec<u16> = value.encode_utf16().collect();
    let needle: Vec<u16> = search.encode_utf16().collect();
    if needle.is_empty() {
        return haystack.len() as f64;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
        .map_or(-1.0, |index| index as f64)
}

pub fn string_compare_utf16(left: &JsString, right: &JsString) -> i32 {
    use std::cmp::Ordering;

    match left.encode_utf16().cmp(right.encode_utf16()) {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

pub fn string_substring(value: &JsString, start: f64, end: f64) -> JsString {
    let units: Vec<u16> = value.encode_utf16().collect();
    let clamp = |index: f64| {
        if index.is_nan() || index <= 0.0 {
            0
        } else if index == f64::INFINITY {
            units.len()
        } else {
            index.trunc().min(units.len() as f64) as usize
        }
    };
    let mut start = clamp(start);
    let mut end = clamp(end);
    if start > end {
        std::mem::swap(&mut start, &mut end);
    }
    string_from_utf16(&units[start..end])
}

pub fn string_slice(value: &JsString, start: f64, end: f64) -> JsString {
    let units: Vec<u16> = value.encode_utf16().collect();
    let start = relative_string_index(start, units.len());
    let end = relative_string_index(end, units.len());
    if end <= start {
        return empty_string();
    }
    Rc::from(String::from_utf16_lossy(&units[start..end]))
}

pub fn string_repeat(value: &JsString, count: f64) -> JsString {
    let count = if count.is_nan() { 0.0 } else { count.trunc() };
    if !count.is_finite() || count < 0.0 {
        panic!("RangeError: Invalid count value");
    }
    Rc::<str>::from(value.repeat(count as usize))
}

fn string_pad(value: &JsString, max_length: f64, fill: &JsString, at_start: bool) -> JsString {
    let target = if max_length.is_nan() {
        0.0
    } else {
        max_length.trunc()
    };
    let value_units: Vec<u16> = value.encode_utf16().collect();
    if target <= value_units.len() as f64 || fill.is_empty() {
        return value.clone();
    }
    if !target.is_finite() || target > usize::MAX as f64 {
        throw_range_error("Invalid string length".to_owned());
    }
    let target = target as usize;
    let fill_units: Vec<u16> = fill.encode_utf16().collect();
    let pad_length = target - value_units.len();
    let mut padded = Vec::with_capacity(target);
    let append_padding = |output: &mut Vec<u16>| {
        output.extend(fill_units.iter().copied().cycle().take(pad_length));
    };
    if at_start {
        append_padding(&mut padded);
        padded.extend_from_slice(&value_units);
    } else {
        padded.extend_from_slice(&value_units);
        append_padding(&mut padded);
    }
    Rc::from(String::from_utf16_lossy(&padded))
}

pub fn string_pad_start(value: &JsString, max_length: f64, fill: &JsString) -> JsString {
    string_pad(value, max_length, fill, true)
}

pub fn string_pad_end(value: &JsString, max_length: f64, fill: &JsString) -> JsString {
    string_pad(value, max_length, fill, false)
}

pub fn string_to_lower_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_lowercase())
}

pub fn string_to_upper_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_uppercase())
}

pub fn string_includes(value: &JsString, search: &JsString, from_index: f64) -> bool {
    string_index_of(value, search, from_index) >= 0.0
}

pub fn string_starts_with(value: &JsString, search: &JsString) -> bool {
    value.starts_with(search.as_ref())
}

pub fn string_ends_with(value: &JsString, search: &JsString) -> bool {
    value.ends_with(search.as_ref())
}

fn javascript_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub fn string_trim(value: &JsString) -> JsString {
    Rc::from(value.trim_matches(javascript_whitespace))
}

pub fn string_split(value: &JsString, separator: &JsString, limit: f64) -> JsArray<JsString> {
    let limit = to_uint32(limit) as usize;
    if limit == 0 {
        return array_new(Vec::new());
    }
    let parts = if separator.is_empty() {
        value
            .encode_utf16()
            .take(limit)
            .map(|unit| Rc::from(String::from_utf16_lossy(&[unit])))
            .collect()
    } else {
        value
            .split(separator.as_ref())
            .take(limit)
            .map(Rc::<str>::from)
            .collect()
    };
    array_new(parts)
}

pub fn process_argv() -> JsArray<JsString> {
    PROCESS_ARGV.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(argv) = slot.as_ref() {
            return argv.clone();
        }
        let mut native = std::env::args();
        let executable = native.next().unwrap_or_else(|| "scriptc".to_owned());
        let mut values = vec![Rc::from(executable.as_str()), Rc::from(executable.as_str())];
        values.extend(native.map(Rc::<str>::from));
        let argv = array_new(values);
        *slot = Some(argv.clone());
        argv
    })
}

pub fn process_platform() -> JsString {
    string(if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    })
}

pub fn process_cwd() -> JsString {
    Rc::from(
        std::env::current_dir()
            .expect("scriptc: current directory is unavailable")
            .to_string_lossy()
            .as_ref(),
    )
}

pub fn process_pid() -> f64 {
    f64::from(std::process::id())
}

fn process_status_id(prefix: &str, id_flag: &str) -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix(prefix)?
                    .split_whitespace()
                    .next()?
                    .parse::<f64>()
                    .ok()
            })
        })
        .or_else(|| {
            let output = std::process::Command::new("id")
                .arg(id_flag)
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<f64>()
                .ok()
        })
        .unwrap_or(0.0)
}

pub fn process_getuid() -> f64 {
    process_status_id("Uid:", "-u")
}

pub fn process_getgid() -> f64 {
    process_status_id("Gid:", "-g")
}

pub fn process_exec_path() -> JsString {
    Rc::from(
        std::env::current_exe()
            .expect("scriptc: executable path is unavailable")
            .to_string_lossy()
            .as_ref(),
    )
}

pub fn process_arch() -> JsString {
    string(if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "ia32"
    } else {
        std::env::consts::ARCH
    })
}

pub fn process_env_get(name: &JsString) -> Option<JsString> {
    std::env::var_os(name.as_ref()).map(|value| Rc::from(value.to_string_lossy().as_ref()))
}

pub fn process_versions_node() -> JsString {
    string("24.0.0")
}

pub fn process_versions_openssl() -> JsString {
    string("3.5.5")
}

pub fn number_parse_int(value: &JsString, radix: f64) -> f64 {
    let trimmed = value.trim_start_matches(javascript_whitespace);
    let (negative, mut digits) = if let Some(rest) = trimmed.strip_prefix('-') {
        (true, rest)
    } else if let Some(rest) = trimmed.strip_prefix('+') {
        (false, rest)
    } else {
        (false, trimmed)
    };
    let requested = to_int32(radix);
    if requested != 0 && !(2..=36).contains(&requested) {
        return f64::NAN;
    }
    let mut base = if requested == 0 { 10 } else { requested };
    if (requested == 0 || requested == 16) && (digits.starts_with("0x") || digits.starts_with("0X"))
    {
        digits = &digits[2..];
        base = 16;
    }
    let mut result = 0.0;
    let mut consumed = false;
    let mut consumed_bytes = 0;
    for byte in digits.bytes() {
        let digit = match byte {
            b'0'..=b'9' => i32::from(byte - b'0'),
            b'a'..=b'z' => i32::from(byte - b'a') + 10,
            b'A'..=b'Z' => i32::from(byte - b'A') + 10,
            _ => break,
        };
        if digit >= base {
            break;
        }
        consumed = true;
        consumed_bytes += 1;
        result = result * f64::from(base) + f64::from(digit);
    }
    if !consumed {
        return f64::NAN;
    }
    // Rust's decimal parser performs correctly-rounded conversion over the
    // full digit sequence; repeated f64 multiplication can drift by one ULP
    // for large decimal integers (unlike JavaScript's parseInt result).
    if base == 10 {
        result = digits[..consumed_bytes]
            .parse::<f64>()
            .unwrap_or(f64::INFINITY);
    }
    if negative { -result } else { result }
}

pub fn number_parse_float(value: &JsString) -> f64 {
    let trimmed = value.trim_start_matches(javascript_whitespace);
    let bytes = trimmed.as_bytes();
    let mut index = 0usize;
    let negative = if bytes.get(index) == Some(&b'-') {
        index += 1;
        true
    } else {
        if bytes.get(index) == Some(&b'+') {
            index += 1;
        }
        false
    };
    if bytes[index..].starts_with(b"Infinity") {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }

    let start = 0usize;
    let mut integer_digits = 0usize;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
        integer_digits += 1;
    }
    let mut fraction_digits = 0usize;
    if bytes.get(index) == Some(&b'.') {
        let mut next = index + 1;
        while bytes.get(next).is_some_and(u8::is_ascii_digit) {
            next += 1;
            fraction_digits += 1;
        }
        if integer_digits > 0 || fraction_digits > 0 {
            index = next;
        }
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return f64::NAN;
    }

    let mut end = index;
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        let mut next = index + 1;
        if matches!(bytes.get(next), Some(b'+' | b'-')) {
            next += 1;
        }
        let exponent_start = next;
        while bytes.get(next).is_some_and(u8::is_ascii_digit) {
            next += 1;
        }
        if next > exponent_start {
            end = next;
        }
    }
    trimmed[start..end].parse::<f64>().unwrap_or(f64::NAN)
}

fn fs_error_code(error: &std::io::Error) -> &'static str {
    #[cfg(unix)]
    if error.raw_os_error() == Some(9) {
        return "EBADF";
    }
    #[cfg(windows)]
    if error.raw_os_error() == Some(6) {
        return "EBADF";
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::InvalidInput => "EINVAL",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        std::io::ErrorKind::IsADirectory => "EISDIR",
        std::io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        std::io::ErrorKind::BrokenPipe => "EPIPE",
        _ => "EIO",
    }
}

fn fs_error_text(error: &std::io::Error) -> String {
    if fs_error_code(error) == "EBADF" {
        return "bad file descriptor".to_owned();
    }
    let text = match error.kind() {
        std::io::ErrorKind::NotFound => "no such file or directory",
        std::io::ErrorKind::PermissionDenied => "permission denied",
        std::io::ErrorKind::AlreadyExists => "file already exists",
        std::io::ErrorKind::InvalidInput => "invalid argument",
        std::io::ErrorKind::NotADirectory => "not a directory",
        std::io::ErrorKind::IsADirectory => "illegal operation on a directory",
        std::io::ErrorKind::DirectoryNotEmpty => "directory not empty",
        std::io::ErrorKind::BrokenPipe => "broken pipe",
        _ => return error.to_string(),
    };
    text.to_owned()
}

fn throw_fs_error(operation: &str, path: &JsString, error: std::io::Error) -> ! {
    let code = fs_error_code(&error);
    let text = fs_error_text(&error);
    throw_value(JsError {
        name: "Error".to_owned(),
        message: format!("{code}: {text}, {operation} '{}'", path),
        code: Some(code.to_owned()),
    })
}

fn throw_fs_error2(operation: &str, from: &JsString, to: &JsString, error: std::io::Error) -> ! {
    throw_value(fs_error2(operation, from, to, &error))
}

fn fs_error2(operation: &str, from: &str, to: &str, error: &std::io::Error) -> JsError {
    let code = fs_error_code(error);
    let text = fs_error_text(error);
    JsError {
        name: "Error".to_owned(),
        message: format!("{code}: {text}, {operation} '{from}' -> '{to}'"),
        code: Some(code.to_owned()),
    }
}

fn throw_fs_fd_error(operation: &str, code: &str, description: &str) -> ! {
    throw_value(JsError {
        name: "Error".to_owned(),
        message: format!("{code}: {description}, {operation}"),
        code: Some(code.to_owned()),
    })
}

fn throw_fs_fd_io_error(operation: &str, error: std::io::Error) -> ! {
    let code = fs_error_code(&error);
    let text = fs_error_text(&error);
    throw_fs_fd_error(operation, code, &text)
}

fn throw_out_of_range(message: String) -> ! {
    throw_value(JsError {
        name: "RangeError".to_owned(),
        message,
        code: Some("ERR_OUT_OF_RANGE".to_owned()),
    })
}

fn inspected_argument(value: &str) -> String {
    let quote = if !value.contains('\'') {
        '\''
    } else if !value.contains('"') {
        '"'
    } else if !value.contains('`') && !value.contains("${") {
        '`'
    } else {
        '\''
    };
    let mut inspected = String::new();
    inspected.push(quote);
    for character in value.chars() {
        match character {
            '\\' => inspected.push_str("\\\\"),
            '\'' if quote == '\'' => inspected.push_str("\\'"),
            '\u{0008}' => inspected.push_str("\\b"),
            '\t' => inspected.push_str("\\t"),
            '\n' => inspected.push_str("\\n"),
            '\u{000c}' => inspected.push_str("\\f"),
            '\r' => inspected.push_str("\\r"),
            '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' => {
                use std::fmt::Write;
                let _ = write!(inspected, "\\x{:02X}", character as u32);
            }
            _ => inspected.push(character),
        }
    }
    inspected.push(quote);

    let mut units = 0;
    let mut boundary = inspected.len();
    for (index, character) in inspected.char_indices() {
        let next = units + character.len_utf16();
        if next > 128 {
            boundary = index;
            break;
        }
        units = next;
    }
    if boundary < inspected.len() {
        inspected.truncate(boundary);
        inspected.push_str("...");
    }
    inspected
}

fn throw_invalid_arg_value(prefix: &str, value: &str) -> ! {
    throw_value(JsError {
        name: "TypeError".to_owned(),
        message: format!("{prefix}{}", inspected_argument(value)),
        code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
    })
}

fn fs_creation_mode(mode: f64) -> u32 {
    let received = format_number(mode);
    if !mode.is_finite() || mode.trunc() != mode {
        throw_out_of_range(format!(
            "The value of \"mode\" is out of range. It must be an integer. Received {received}"
        ));
    }
    if !(0.0..=4_294_967_295.0).contains(&mode) {
        throw_out_of_range(format!(
            "The value of \"mode\" is out of range. It must be >= 0 && <= 4294967295. Received {received}"
        ));
    }
    mode as u32
}

pub fn fs_read_file(path: &JsString) -> JsString {
    match std::fs::read(path.as_ref()) {
        Ok(bytes) => Rc::from(String::from_utf8_lossy(&bytes).as_ref()),
        Err(error) => throw_fs_error("open", path, error),
    }
}

pub fn fs_write_file(path: &JsString, data: &JsString) {
    if let Err(error) = std::fs::write(path.as_ref(), data.as_bytes()) {
        throw_fs_error("open", path, error);
    }
}

pub fn fs_read_file_bytes(path: &JsString) -> JsBytes<u8> {
    match std::fs::read(path.as_ref()) {
        Ok(bytes) => bytes_from_vec(bytes),
        Err(error) => throw_fs_error("open", path, error),
    }
}

pub fn fs_write_file_bytes(path: &JsString, data: &JsBytes<u8>) {
    let result = data.with(|data| {
        let storage = data.storage.borrow();
        std::fs::write(
            path.as_ref(),
            &storage[data.offset..data.offset + data.length],
        )
    });
    if let Err(error) = result {
        throw_fs_error("open", path, error);
    }
}

pub fn fs_append_file(path: &JsString, data: &JsString) {
    use std::io::Write;
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.as_ref())
    {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
}

pub fn fs_exists(path: &JsString) -> bool {
    std::fs::exists(path.as_ref()).unwrap_or(false)
}

pub fn fs_mkdir(path: &JsString) {
    if let Err(error) = std::fs::create_dir(path.as_ref()) {
        throw_fs_error("mkdir", path, error);
    }
}

pub fn fs_rm(path: &JsString) {
    if let Err(error) = std::fs::remove_file(path.as_ref()) {
        throw_fs_error("rm", path, error);
    }
}

pub fn fs_rmdir(path: &JsString) {
    if let Err(error) = std::fs::remove_dir(path.as_ref()) {
        throw_fs_error("rmdir", path, error);
    }
}

pub fn fs_readdir(path: &JsString) -> JsArray<JsString> {
    let entries = match std::fs::read_dir(path.as_ref()) {
        Ok(entries) => entries,
        Err(error) => throw_fs_error("scandir", path, error),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => throw_fs_error("scandir", path, error),
        };
        names.push(Rc::from(entry.file_name().to_string_lossy().as_ref()));
    }
    array_new(names)
}

pub fn fs_realpath(path: &JsString) -> JsString {
    match std::fs::canonicalize(path.as_ref()) {
        Ok(resolved) => Rc::from(resolved.to_string_lossy().as_ref()),
        Err(error) => throw_fs_error("lstat", path, error),
    }
}

pub fn os_tmpdir() -> JsString {
    let value = std::env::var_os("TMPDIR")
        .or_else(|| std::env::var_os("TMP"))
        .or_else(|| std::env::var_os("TEMP"))
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "."
            } else {
                "/tmp"
            }
            .to_owned()
        });
    let trimmed = if value.len() > 1 {
        value.trim_end_matches(['/', '\\'])
    } else {
        value.as_str()
    };
    Rc::from(trimmed)
}

pub fn fs_mkdtemp(prefix: &JsString) -> JsString {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..1024 {
        let tick = NEXT.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos() as u64);
        let suffix = format!(
            "{:06x}",
            (nanos ^ tick ^ u64::from(std::process::id())) & 0xff_ffff
        );
        let candidate: JsString = Rc::from(format!("{prefix}{suffix}"));
        match std::fs::create_dir(candidate.as_ref()) {
            Ok(()) => return candidate,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => throw_fs_error("mkdtemp", &candidate, error),
        }
    }
    throw_fs_error(
        "mkdtemp",
        prefix,
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "temporary name collision",
        ),
    )
}

pub fn fs_mkdir_recursive(path: &JsString) {
    if let Err(error) = std::fs::create_dir_all(path.as_ref()) {
        throw_fs_error("mkdir", path, error);
    }
}

pub fn fs_rm_options(path: &JsString, recursive: bool, force: bool) {
    let metadata = match std::fs::symlink_metadata(path.as_ref()) {
        Ok(metadata) => metadata,
        Err(error) if force && error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => throw_fs_error("lstat", path, error),
    };
    let result = if metadata.is_dir() {
        if recursive {
            std::fs::remove_dir_all(path.as_ref())
        } else {
            std::fs::remove_dir(path.as_ref())
        }
    } else {
        std::fs::remove_file(path.as_ref())
    };
    if let Err(error) = result {
        throw_fs_error("rm", path, error);
    }
}

pub fn fs_unlink(path: &JsString) {
    if let Err(error) = std::fs::remove_file(path.as_ref()) {
        throw_fs_error("unlink", path, error);
    }
}

pub fn fs_copy_file(from: &JsString, to: &JsString) {
    if let Err(error) = std::fs::copy(from.as_ref(), to.as_ref()) {
        throw_fs_error2("copyfile", from, to, error);
    }
}

pub fn fs_rename(from: &JsString, to: &JsString) {
    if let Err(error) = std::fs::rename(from.as_ref(), to.as_ref()) {
        throw_fs_error2("rename", from, to, error);
    }
}

struct FsRenameWork {
    id: u64,
    owner: std::thread::ThreadId,
    from: String,
    to: String,
}

struct FsRenameCompletion {
    id: u64,
    owner: std::thread::ThreadId,
    result: std::io::Result<()>,
}

struct FsRenameState {
    work: VecDeque<FsRenameWork>,
    done: VecDeque<FsRenameCompletion>,
}

struct FsRenamePool {
    state: Mutex<FsRenameState>,
    work_ready: Condvar,
    done_ready: Condvar,
    worker_count: AtomicUsize,
}

struct FsRenameCallback {
    from: JsString,
    to: JsString,
    callback: Box<dyn FnOnce(Option<JsError>)>,
}

static FS_RENAME_POOL: OnceLock<Arc<FsRenamePool>> = OnceLock::new();
static NEXT_FS_RENAME_ID: AtomicU64 = AtomicU64::new(1);

fn fs_rename_pool() -> &'static Arc<FsRenamePool> {
    FS_RENAME_POOL.get_or_init(|| {
        let pool = Arc::new(FsRenamePool {
            state: Mutex::new(FsRenameState {
                work: VecDeque::new(),
                done: VecDeque::new(),
            }),
            work_ready: Condvar::new(),
            done_ready: Condvar::new(),
            worker_count: AtomicUsize::new(0),
        });
        for index in 0..4 {
            let worker_pool = pool.clone();
            if std::thread::Builder::new()
                .name(format!("scriptc-fs-{index}"))
                .spawn(move || fs_rename_worker(worker_pool))
                .is_ok()
            {
                pool.worker_count.fetch_add(1, Ordering::Relaxed);
            }
        }
        pool
    })
}

fn fs_rename_worker(pool: Arc<FsRenamePool>) {
    loop {
        let work = {
            let state = pool
                .state
                .lock()
                .expect("scriptc: poisoned fs worker queue");
            let mut state = pool
                .work_ready
                .wait_while(state, |state| state.work.is_empty())
                .expect("scriptc: poisoned fs worker queue");
            state
                .work
                .pop_front()
                .expect("scriptc: awakened fs worker without work")
        };
        let result = std::fs::rename(&work.from, &work.to);
        let mut state = pool
            .state
            .lock()
            .expect("scriptc: poisoned fs completion queue");
        state.done.push_back(FsRenameCompletion {
            id: work.id,
            owner: work.owner,
            result,
        });
        pool.done_ready.notify_all();
    }
}

pub fn fs_rename_async(from: &JsString, to: &JsString, callback: Box<dyn FnOnce(Option<JsError>)>) {
    let id = NEXT_FS_RENAME_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .expect("scriptc: exhausted fs.rename request ids");
    let owner = std::thread::current().id();
    FS_RENAME_CALLBACKS.with(|callbacks| {
        let previous = callbacks.borrow_mut().insert(
            id,
            FsRenameCallback {
                from: from.clone(),
                to: to.clone(),
                callback,
            },
        );
        assert!(
            previous.is_none(),
            "scriptc: duplicate fs.rename request id"
        );
    });
    let pool = fs_rename_pool();
    let mut state = pool
        .state
        .lock()
        .expect("scriptc: poisoned fs worker queue");
    if pool.worker_count.load(Ordering::Relaxed) == 0 {
        state.done.push_back(FsRenameCompletion {
            id,
            owner,
            result: Err(std::io::Error::new(
                std::io::ErrorKind::ResourceBusy,
                "could not create fs worker",
            )),
        });
        pool.done_ready.notify_all();
        return;
    }
    state.work.push_back(FsRenameWork {
        id,
        owner,
        from: from.to_string(),
        to: to.to_string(),
    });
    pool.work_ready.notify_one();
}

fn fs_renames_pending() -> bool {
    FS_RENAME_CALLBACKS.with(|callbacks| !callbacks.borrow().is_empty())
}

fn fs_rename_completion_index(
    state: &FsRenameState,
    owner: std::thread::ThreadId,
) -> Option<usize> {
    state
        .done
        .iter()
        .position(|completion| completion.owner == owner)
}

fn fs_renames_dispatch_one() -> bool {
    if !fs_renames_pending() {
        return false;
    }
    let owner = std::thread::current().id();
    let completion = {
        let pool = fs_rename_pool();
        let mut state = pool
            .state
            .lock()
            .expect("scriptc: poisoned fs completion queue");
        let Some(index) = fs_rename_completion_index(&state, owner) else {
            return false;
        };
        state
            .done
            .remove(index)
            .expect("scriptc: missing fs.rename completion")
    };
    let pending =
        FS_RENAME_CALLBACKS.with(|callbacks| callbacks.borrow_mut().remove(&completion.id));
    let Some(pending) = pending else {
        return false;
    };
    let error = completion
        .result
        .err()
        .map(|error| fs_error2("rename", &pending.from, &pending.to, &error));
    (pending.callback)(error);
    true
}

fn fs_renames_wait(timeout: Option<std::time::Duration>) {
    let owner = std::thread::current().id();
    let pool = fs_rename_pool();
    let state = pool
        .state
        .lock()
        .expect("scriptc: poisoned fs completion queue");
    if fs_rename_completion_index(&state, owner).is_some() {
        return;
    }
    if let Some(timeout) = timeout {
        let _ = pool
            .done_ready
            .wait_timeout_while(state, timeout, |state| {
                fs_rename_completion_index(state, owner).is_none()
            })
            .expect("scriptc: poisoned fs completion queue");
    } else {
        drop(
            pool.done_ready
                .wait_while(state, |state| {
                    fs_rename_completion_index(state, owner).is_none()
                })
                .expect("scriptc: poisoned fs completion queue"),
        );
    }
}

fn fs_renames_finish() {
    while fs_renames_pending() {
        fs_renames_wait(None);
        let owner = std::thread::current().id();
        let removed = {
            let pool = fs_rename_pool();
            let mut state = pool
                .state
                .lock()
                .expect("scriptc: poisoned fs completion queue");
            fs_rename_completion_index(&state, owner).and_then(|index| state.done.remove(index))
        };
        if let Some(completion) = removed {
            FS_RENAME_CALLBACKS.with(|callbacks| {
                callbacks.borrow_mut().remove(&completion.id);
            });
        }
    }
}

#[cfg(unix)]
pub fn fs_chmod(path: &JsString, mode: f64) {
    use std::os::unix::fs::PermissionsExt;
    let permissions = std::fs::Permissions::from_mode(to_uint32(mode));
    if let Err(error) = std::fs::set_permissions(path.as_ref(), permissions) {
        throw_fs_error("chmod", path, error);
    }
}

#[cfg(not(unix))]
pub fn fs_chmod(path: &JsString, _mode: f64) {
    if !fs_exists(path) {
        throw_fs_error(
            "chmod",
            path,
            std::io::Error::new(std::io::ErrorKind::NotFound, "path does not exist"),
        );
    }
}

pub fn fs_chown(path: &JsString, uid: f64, gid: f64) {
    if let Err(error) = std::fs::metadata(path.as_ref()) {
        throw_fs_error("chown", path, error);
    }
    if uid == -1.0 && gid == -1.0 {
        return;
    }
    let owner = format!("{}:{}", uid.trunc() as i64, gid.trunc() as i64);
    let status = std::process::Command::new("chown")
        .arg(owner)
        .arg("--")
        .arg(path.as_ref())
        .status();
    if !status.is_ok_and(|status| status.success()) {
        throw_fs_error(
            "chown",
            path,
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "operation not permitted",
            ),
        );
    }
}

#[cfg(unix)]
pub fn fs_write_file_mode(path: &JsString, data: &JsString, mode: f64) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mode = fs_creation_mode(mode);
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path.as_ref())
    {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
}

#[cfg(not(unix))]
pub fn fs_write_file_mode(path: &JsString, data: &JsString, mode: f64) {
    let _ = fs_creation_mode(mode);
    fs_write_file(path, data);
}

#[cfg(unix)]
pub fn fs_mkdir_mode(path: &JsString, mode: f64, recursive: bool) {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(recursive).mode(to_uint32(mode));
    if let Err(error) = builder.create(path.as_ref()) {
        throw_fs_error("mkdir", path, error);
    }
}

#[cfg(not(unix))]
pub fn fs_mkdir_mode(path: &JsString, _mode: f64, recursive: bool) {
    if recursive {
        fs_mkdir_recursive(path);
    } else {
        fs_mkdir(path);
    }
}

pub fn fs_access(path: &JsString, mode: f64) {
    if let Err(error) = std::fs::metadata(path.as_ref()) {
        throw_fs_error("access", path, error);
    }
    let mode = to_int32(mode);
    for (bit, flag) in [(4, "-r"), (2, "-w"), (1, "-x")] {
        if mode & bit == 0 {
            continue;
        }
        let status = std::process::Command::new("test")
            .arg(flag)
            .arg(path.as_ref())
            .status();
        if !status.is_ok_and(|status| status.success()) {
            throw_fs_error(
                "access",
                path,
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "permission denied"),
            );
        }
    }
}

fn fs_open_options(flags: &str) -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    match flags {
        "r" | "rs" | "sr" => {
            options.read(true);
        }
        "r+" | "rs+" | "sr+" => {
            options.read(true).write(true);
        }
        "w" => {
            options.write(true).create(true).truncate(true);
        }
        "wx" | "xw" => {
            options.write(true).create_new(true).truncate(true);
        }
        "w+" => {
            options.read(true).write(true).create(true).truncate(true);
        }
        "wx+" | "xw+" => {
            options
                .read(true)
                .write(true)
                .create_new(true)
                .truncate(true);
        }
        "a" | "as" | "sa" => {
            options.write(true).create(true).append(true);
        }
        "ax" | "xa" => {
            options.write(true).create_new(true).append(true);
        }
        "a+" | "as+" | "sa+" => {
            options.read(true).create(true).append(true);
        }
        "ax+" | "xa+" => {
            options.read(true).create_new(true).append(true);
        }
        _ => throw_invalid_arg_value("The argument 'flags' is invalid. Received ", flags),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o666);
    }
    options
}

#[cfg(unix)]
fn file_id(file: &std::fs::File) -> i32 {
    use std::os::fd::AsRawFd;
    file.as_raw_fd()
}

#[cfg(not(unix))]
fn file_id(_file: &std::fs::File) -> i32 {
    NEXT_FILE_ID.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).expect("scriptc: exhausted file ids"));
        id
    })
}

pub fn fs_open(path: &JsString, flags: &JsString) -> f64 {
    let options = fs_open_options(flags);
    let file = match options.open(path.as_ref()) {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    let id = file_id(&file);
    OPEN_FILES.with(|files| {
        let previous = files.borrow_mut().insert(id, file);
        assert!(
            previous.is_none(),
            "scriptc: duplicate open file descriptor"
        );
    });
    f64::from(id)
}

pub struct FileHandleData {
    fd: Cell<i32>,
}

impl Trace for FileHandleData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for FileHandleData {
    fn clear_edges(&mut self) {}
}

impl Drop for FileHandleData {
    fn drop(&mut self) {
        let fd = self.fd.replace(-1);
        if fd >= 0 {
            OPEN_FILES.with(|files| {
                files.borrow_mut().remove(&fd);
            });
        }
    }
}

pub type JsFileHandle = Gc<FileHandleData>;

pub fn file_handle_open(path: &JsString, flags: &JsString, mode: f64) -> JsFileHandle {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    let mode = fs_creation_mode(mode);
    let mut options = fs_open_options(flags);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let file = match options.open(path.as_ref()) {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    let fd = file_id(&file);
    OPEN_FILES.with(|files| {
        let previous = files.borrow_mut().insert(fd, file);
        assert!(
            previous.is_none(),
            "scriptc: duplicate FileHandle descriptor"
        );
    });
    Gc::new(FileHandleData { fd: Cell::new(fd) })
}

pub fn file_handle_fd(handle: &JsFileHandle) -> f64 {
    f64::from(handle.with(|handle| handle.fd.get()))
}

fn file_handle_require_open(handle: &JsFileHandle) -> f64 {
    let fd = file_handle_fd(handle);
    if fd >= 0.0 {
        return fd;
    }
    throw_value(JsError {
        name: "Error".to_owned(),
        message: "file closed".to_owned(),
        code: Some("EBADF".to_owned()),
    })
}

pub fn file_handle_close(handle: &JsFileHandle) {
    let fd = handle.with(|handle| handle.fd.replace(-1));
    if fd < 0 {
        return;
    }
    let file = OPEN_FILES.with(|files| files.borrow_mut().remove(&fd));
    if file.is_none() {
        throw_fs_fd_error("close", "EBADF", "bad file descriptor");
    }
}

pub fn file_handle_read(
    handle: &JsFileHandle,
    bytes: &JsBytes<u8>,
    offset: f64,
    mut length: f64,
    position: f64,
    length_default: bool,
) -> f64 {
    let fd = file_handle_require_open(handle);
    let byte_length = bytes.with(|data| data.length);
    if byte_length == 0 {
        let checked = fs_read_sync(fd, bytes, offset, 0.0, position);
        if (!length_default && length >= 0.0 && length < 1.0) || (length_default && offset == 0.0) {
            return checked;
        }
        throw_value(JsError {
            name: "TypeError".to_owned(),
            message: "The argument 'buffer' is empty and cannot be written. Received <Buffer >"
                .to_owned(),
            code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
        });
    }
    if length_default
        && offset.is_finite()
        && offset.fract() == 0.0
        && (0.0..=byte_length as f64).contains(&offset)
    {
        length = byte_length as f64 - offset;
    }
    fs_read_sync(fd, bytes, offset, length, position)
}

pub fn file_handle_write_bytes(
    handle: &JsFileHandle,
    bytes: &JsBytes<u8>,
    offset: f64,
    mut length: f64,
    position: f64,
    length_default: bool,
) -> f64 {
    let fd = file_handle_require_open(handle);
    let byte_length = bytes.with(|data| data.length);
    if byte_length == 0 {
        return 0.0;
    }
    if length_default
        && offset.is_finite()
        && offset.fract() == 0.0
        && (0.0..=byte_length as f64).contains(&offset)
    {
        length = byte_length as f64 - offset;
    }
    fs_write_sync(fd, bytes, offset, length, position)
}

pub fn file_handle_write_str(
    handle: &JsFileHandle,
    data: &JsString,
    position: f64,
    encoding: &JsString,
) -> f64 {
    let fd = file_handle_require_open(handle);
    fs_write_str_sync(fd, data, position, encoding)
}

pub fn file_handle_read_file_bytes(handle: &JsFileHandle, _encoding: &JsString) -> JsBytes<u8> {
    fs_read_fd_bytes(file_handle_require_open(handle))
}

pub fn file_handle_read_file(handle: &JsFileHandle, encoding: &JsString) -> JsString {
    let bytes = file_handle_read_file_bytes(handle, encoding);
    bytes_to_string(&bytes, encoding)
}

pub fn file_handle_write_file(handle: &JsFileHandle, data: &JsString, _encoding: &JsString) {
    let fd = file_handle_require_open(handle);
    use std::io::Write;
    with_open_file(fd, "write", |file| file.write_all(data.as_bytes()));
}

pub fn file_handle_write_file_bytes(
    handle: &JsFileHandle,
    data: &JsBytes<u8>,
    _encoding: &JsString,
) {
    let fd = file_handle_require_open(handle);
    let input =
        data.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    use std::io::Write;
    with_open_file(fd, "write", |file| file.write_all(&input));
}

fn with_open_file<T>(
    fd: f64,
    operation: &str,
    use_file: impl FnOnce(&mut std::fs::File) -> std::io::Result<T>,
) -> T {
    let id =
        if fd.is_finite() && fd.fract() == 0.0 && fd >= i32::MIN as f64 && fd <= i32::MAX as f64 {
            fd as i32
        } else {
            throw_fs_fd_error(operation, "EBADF", "bad file descriptor")
        };
    OPEN_FILES.with(|files| {
        let mut files = files.borrow_mut();
        let Some(file) = files.get_mut(&id) else {
            throw_fs_fd_error(operation, "EBADF", "bad file descriptor")
        };
        use_file(file).unwrap_or_else(|error| throw_fs_fd_io_error(operation, error))
    })
}

fn with_preserved_position<T>(
    file: &mut std::fs::File,
    position: f64,
    operation: impl FnOnce(&mut std::fs::File) -> std::io::Result<T>,
) -> std::io::Result<T> {
    use std::io::{Seek, SeekFrom};
    if position == -1.0 {
        return operation(file);
    }
    let original = file.stream_position()?;
    file.seek(SeekFrom::Start(position as u64))?;
    let result = operation(file);
    let restore = file.seek(SeekFrom::Start(original));
    match (result, restore) {
        (Ok(value), Ok(_)) => Ok(value),
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
    }
}

pub fn fs_close(fd: f64) {
    let id =
        if fd.is_finite() && fd.fract() == 0.0 && fd >= i32::MIN as f64 && fd <= i32::MAX as f64 {
            fd as i32
        } else {
            throw_fs_fd_error("close", "EBADF", "bad file descriptor")
        };
    let file = OPEN_FILES.with(|files| files.borrow_mut().remove(&id));
    if file.is_none() {
        throw_fs_fd_error("close", "EBADF", "bad file descriptor");
    }
}

fn validate_write_fd(fd: f64) {
    if !fd.is_finite() || fd.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"fd\" is out of range. It must be an integer. Received {}",
            format_number(fd)
        ));
    }
    if !(0.0..=f64::from(i32::MAX)).contains(&fd) {
        throw_out_of_range(format!(
            "The value of \"fd\" is out of range. It must be >= 0 && <= 2147483647. Received {}",
            format_number(fd)
        ));
    }
}

fn validate_write_window(length: usize, offset: f64, count: f64) -> (usize, usize) {
    if !offset.is_finite() || offset.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be an integer. Received {}",
            format_number(offset)
        ));
    }
    if !(0.0..=9_007_199_254_740_991.0).contains(&offset) {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
            format_number(offset)
        ));
    }
    if offset > length as f64 {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be <= {length}. Received {}",
            format_number(offset)
        ));
    }
    let offset = offset as usize;
    if count < 0.0 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be >= 0. Received {}",
            format_number(count)
        ));
    }
    let remaining = length - offset;
    if count > remaining as f64 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be <= {remaining}. Received {}",
            format_number(count)
        ));
    }
    if !count.is_finite() || count.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be an integer. Received {}",
            format_number(count)
        ));
    }
    (offset, count as usize)
}

fn normalized_write_position(position: f64) -> f64 {
    if position.is_finite()
        && position.fract() == 0.0
        && (0.0..=9_007_199_254_740_991.0).contains(&position)
    {
        position
    } else {
        -1.0
    }
}

pub fn fs_write_sync(fd: f64, bytes: &JsBytes<u8>, offset: f64, length: f64, position: f64) -> f64 {
    let byte_length = bytes.with(|data| data.length);
    let (offset, length) = validate_write_window(byte_length, offset, length);
    validate_write_fd(fd);
    let input = bytes.with(|data| {
        data.storage.borrow()[data.offset + offset..data.offset + offset + length].to_vec()
    });
    let position = normalized_write_position(position);
    use std::io::Write;
    with_open_file(fd, "write", |file| {
        with_preserved_position(file, position, |file| file.write(&input))
    }) as f64
}

pub fn fs_write_str_sync(fd: f64, text: &JsString, position: f64, _encoding: &JsString) -> f64 {
    validate_write_fd(fd);
    let position = normalized_write_position(position);
    use std::io::Write;
    with_open_file(fd, "write", |file| {
        with_preserved_position(file, position, |file| file.write(text.as_bytes()))
    }) as f64
}

pub fn fs_read_sync(fd: f64, bytes: &JsBytes<u8>, offset: f64, length: f64, position: f64) -> f64 {
    if !offset.is_finite() || offset.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be an integer. Received {}",
            format_number(offset)
        ));
    }
    if !(0.0..=9_007_199_254_740_991.0).contains(&offset) {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
            format_number(offset)
        ));
    }
    if !position.is_finite() || position.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"position\" is out of range. It must be an integer. Received {}",
            format_number(position)
        ));
    }
    if !(-1.0..=9_007_199_254_740_991.0).contains(&position) {
        throw_out_of_range(format!(
            "The value of \"position\" is out of range. It must be >= -1 && <= 9007199254740991. Received {}",
            format_number(position)
        ));
    }
    if (0.0..1.0).contains(&length) {
        return 0.0;
    }
    let byte_length = bytes.with(|data| data.length);
    if offset > byte_length as f64 {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
            format_number(offset)
        ));
    }
    let offset = offset as usize;
    let remaining = byte_length - offset;
    if length < 0.0 || length > remaining as f64 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be <= {remaining}. Received {}",
            format_number(length)
        ));
    }
    let length = length as usize;
    use std::io::Read;
    bytes.with(|data| {
        let mut storage = data.storage.borrow_mut();
        let output = &mut storage[data.offset + offset..data.offset + offset + length];
        with_open_file(fd, "read", |file| {
            with_preserved_position(file, position, |file| file.read(output))
        }) as f64
    })
}

pub fn fs_read_fd_bytes(fd: f64) -> JsBytes<u8> {
    use std::io::Read;
    let mut output = Vec::new();
    with_open_file(fd, "read", |file| file.read_to_end(&mut output));
    bytes_from_vec(output)
}

pub fn fs_read_fd(fd: f64, _encoding: &JsString) -> JsString {
    let bytes = fs_read_fd_bytes(fd);
    bytes_to_string(&bytes, &string("utf8"))
}

struct SyncChildOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

fn run_sync_child(
    mut command: std::process::Command,
    input: Option<&[u8]>,
    timeout_ms: f64,
) -> std::io::Result<SyncChildOutput> {
    use std::io::{Read, Write};

    let mut child = command.spawn()?;
    let stdout_reader = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).map(|_| bytes)
        })
    });
    let stderr_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).map(|_| bytes)
        })
    });
    if let Some(input) = input {
        if let Err(error) = child
            .stdin
            .take()
            .expect("scriptc: piped child stdin missing")
            .write_all(input)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    }
    let timeout = if timeout_ms.is_finite() && timeout_ms > 0.0 {
        Some(std::time::Duration::from_secs_f64(timeout_ms / 1000.0))
    } else {
        None
    };
    let started = std::time::Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if timeout.is_some_and(|timeout| started.elapsed() >= timeout) => {
                timed_out = true;
                let _ = child.kill();
                break child.wait()?;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    };
    let join_reader = |reader: Option<std::thread::JoinHandle<std::io::Result<Vec<u8>>>>| {
        reader.map_or_else(
            || Ok(Vec::new()),
            |reader| match reader.join() {
                Ok(result) => result,
                Err(_) => Err(std::io::Error::other("child output reader panicked")),
            },
        )
    };
    Ok(SyncChildOutput {
        status,
        stdout: join_reader(stdout_reader)?,
        stderr: join_reader(stderr_reader)?,
        timed_out,
    })
}

pub fn child_exec_sync(
    command: &JsString,
    arguments: &JsArray<JsString>,
    shell: bool,
    input: &JsString,
    has_input: bool,
    cwd: &JsString,
    has_env: bool,
    env_pairs: &JsArray<JsString>,
    timeout_ms: f64,
    stdout_mode: f64,
    stderr_mode: f64,
) -> JsString {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child_command = Command::new(command.as_ref());
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    if !cwd.is_empty() {
        child_command.current_dir(cwd.as_ref());
    }
    if has_env {
        child_command.env_clear();
        env_pairs.with(|pairs| {
            for pair in pairs.elements.chunks_exact(2) {
                child_command.env(pair[0].as_ref(), pair[1].as_ref());
            }
        });
    }

    let stdout_mode = to_int32(stdout_mode);
    let stdin_inherit = stdout_mode & 4 != 0;
    let stdout_mode = stdout_mode & 3;
    child_command.stdin(if has_input {
        Stdio::piped()
    } else if stdin_inherit {
        Stdio::inherit()
    } else {
        Stdio::null()
    });
    child_command.stdout(match stdout_mode {
        0 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });
    let stderr_mode = to_int32(stderr_mode);
    child_command.stderr(match stderr_mode {
        2 => Stdio::null(),
        3 => Stdio::inherit(),
        _ => Stdio::piped(),
    });

    let output = match run_sync_child(
        child_command,
        has_input.then_some(input.as_bytes()),
        timeout_ms,
    ) {
        Ok(output) => output,
        Err(error) => {
            let code = fs_error_code(&error);
            throw_value(JsError {
                name: "Error".to_owned(),
                message: format!("spawnSync {command} {code}"),
                code: Some(code.to_owned()),
            })
        }
    };
    if stderr_mode == 0 {
        let _ = std::io::stderr().write_all(&output.stderr);
    }
    if output.timed_out {
        throw_value(JsError {
            name: "Error".to_owned(),
            message: format!("spawnSync {command} ETIMEDOUT"),
            code: Some("ETIMEDOUT".to_owned()),
        });
    }
    if !output.status.success() {
        let display = if shell {
            arguments.with(|arguments| {
                arguments
                    .elements
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| command.clone())
            })
        } else {
            let mut display = command.to_string();
            arguments.with(|arguments| {
                for argument in &arguments.elements {
                    display.push(' ');
                    display.push_str(argument);
                }
            });
            Rc::from(display)
        };
        let stderr = String::from_utf8_lossy(&output.stderr);
        throw_value(JsError {
            name: "Error".to_owned(),
            message: format!("Command failed: {display}\n{stderr}"),
            code: None,
        });
    }
    Rc::from(String::from_utf8_lossy(&output.stdout).as_ref())
}

pub struct SpawnResultData {
    status: Option<f64>,
    signal: Option<JsString>,
    stdout: JsString,
    stderr: JsString,
    error: Option<JsError>,
}

impl Trace for SpawnResultData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for SpawnResultData {
    fn clear_edges(&mut self) {}
}

pub type JsSpawnResult = Gc<SpawnResultData>;

#[cfg(unix)]
fn child_exit_signal(status: &std::process::ExitStatus) -> Option<JsString> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| {
        string(match signal {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            4 => "SIGILL",
            6 => "SIGABRT",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            14 => "SIGALRM",
            15 => "SIGTERM",
            _ => "SIGUNKNOWN",
        })
    })
}

#[cfg(not(unix))]
fn child_exit_signal(_status: &std::process::ExitStatus) -> Option<JsString> {
    None
}

pub fn child_spawn_sync(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
) -> JsSpawnResult {
    use std::process::{Command, Stdio};

    let mut child_command = Command::new(command.as_ref());
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    child_command.stdin(if to_int32(stdin_mode) == 2 {
        Stdio::inherit()
    } else {
        Stdio::null()
    });
    child_command.stdout(match to_int32(stdout_mode) {
        1 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });
    child_command.stderr(match to_int32(stderr_mode) {
        1 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });

    match run_sync_child(child_command, None, timeout_ms) {
        Err(error) => {
            let code = fs_error_code(&error);
            Gc::new(SpawnResultData {
                status: None,
                signal: None,
                stdout: string(""),
                stderr: string(""),
                error: Some(JsError {
                    name: "Error".to_owned(),
                    message: format!("spawnSync {command} {code}"),
                    code: Some(code.to_owned()),
                }),
            })
        }
        Ok(output) => {
            let signal = if output.timed_out {
                Some(if kill_signal.is_empty() {
                    string("SIGTERM")
                } else {
                    kill_signal.clone()
                })
            } else {
                child_exit_signal(&output.status)
            };
            Gc::new(SpawnResultData {
                status: if output.timed_out {
                    None
                } else {
                    output.status.code().map(f64::from)
                },
                signal,
                stdout: Rc::from(String::from_utf8_lossy(&output.stdout).as_ref()),
                stderr: Rc::from(String::from_utf8_lossy(&output.stderr).as_ref()),
                error: output.timed_out.then(|| JsError {
                    name: "Error".to_owned(),
                    message: format!("spawnSync {command} ETIMEDOUT"),
                    code: Some("ETIMEDOUT".to_owned()),
                }),
            })
        }
    }
}

pub fn child_spawn_sync_stdio(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdio: &JsString,
) -> JsSpawnResult {
    let (stdin_mode, stdout_mode, stderr_mode) = match stdio.as_ref() {
        "pipe" => (0.0, 0.0, 0.0),
        "ignore" => (0.0, 1.0, 1.0),
        "inherit" => (2.0, 2.0, 2.0),
        other => throw_type_error(format!(
            "spawnSync stdio \"{other}\" has no static lowering"
        )),
    };
    child_spawn_sync(
        command,
        arguments,
        timeout_ms,
        kill_signal,
        stdin_mode,
        stdout_mode,
        stderr_mode,
    )
}

pub fn spawn_result_status(result: &JsSpawnResult) -> Option<f64> {
    result.with(|result| result.status)
}

pub fn spawn_result_signal(result: &JsSpawnResult) -> Option<JsString> {
    result.with(|result| result.signal.clone())
}

pub fn spawn_result_stdout(result: &JsSpawnResult) -> JsString {
    result.with(|result| result.stdout.clone())
}

pub fn spawn_result_stderr(result: &JsSpawnResult) -> JsString {
    result.with(|result| result.stderr.clone())
}

pub fn spawn_result_error(result: &JsSpawnResult) -> Option<JsError> {
    result.with(|result| result.error.clone())
}

pub struct StatsData {
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    size: f64,
    blocks: f64,
    nlink: f64,
    atime_ms: f64,
    mtime_ms: f64,
}

impl Trace for StatsData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for StatsData {
    fn clear_edges(&mut self) {}
}

pub type JsStats = Gc<StatsData>;

fn system_time_ms(value: std::io::Result<std::time::SystemTime>) -> f64 {
    match value {
        Ok(value) => match value.duration_since(std::time::UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64() * 1000.0,
            Err(error) => -error.duration().as_secs_f64() * 1000.0,
        },
        Err(_) => 0.0,
    }
}

#[cfg(unix)]
fn stats_platform_fields(metadata: &std::fs::Metadata) -> (f64, f64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.blocks() as f64, metadata.nlink() as f64)
}

#[cfg(not(unix))]
fn stats_platform_fields(_metadata: &std::fs::Metadata) -> (f64, f64) {
    (0.0, 1.0)
}

pub fn fs_stat(path: &JsString, follow: bool) -> JsStats {
    let result = if follow {
        std::fs::metadata(path.as_ref())
    } else {
        std::fs::symlink_metadata(path.as_ref())
    };
    let metadata = match result {
        Ok(metadata) => metadata,
        Err(error) => throw_fs_error(if follow { "stat" } else { "lstat" }, path, error),
    };
    stats_from_metadata(metadata, !follow)
}

fn stats_from_metadata(metadata: std::fs::Metadata, is_symlink: bool) -> JsStats {
    let (blocks, nlink) = stats_platform_fields(&metadata);
    Gc::new(StatsData {
        is_file: metadata.is_file(),
        is_directory: metadata.is_dir(),
        is_symlink: is_symlink && metadata.file_type().is_symlink(),
        size: metadata.len() as f64,
        blocks,
        nlink,
        atime_ms: system_time_ms(metadata.accessed()),
        mtime_ms: system_time_ms(metadata.modified()),
    })
}

pub fn file_handle_stat(handle: &JsFileHandle) -> JsStats {
    let fd = file_handle_require_open(handle);
    let metadata = with_open_file(fd, "fstat", |file| file.metadata());
    stats_from_metadata(metadata, false)
}

pub fn stats_is_file(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_file)
}
pub fn stats_is_directory(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_directory)
}
pub fn stats_is_symlink(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_symlink)
}
pub fn stats_size(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.size)
}
pub fn stats_blocks(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.blocks)
}
pub fn stats_nlink(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.nlink)
}
pub fn stats_atime_ms(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.atime_ms)
}
pub fn stats_mtime_ms(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.mtime_ms)
}

fn normalize_posix(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    let mut result = parts.join("/");
    if result.is_empty() && !absolute {
        result.push('.');
    }
    if trailing && !result.is_empty() && result != "/" {
        result.push('/');
    }
    if absolute {
        result.insert(0, '/');
    }
    result
}

pub fn path_normalize(path: &JsString) -> JsString {
    Rc::from(normalize_posix(path))
}

pub fn path_join(parts: &JsArray<JsString>) -> JsString {
    let joined = parts.with(|data| {
        data.elements
            .iter()
            .filter(|part| !part.is_empty())
            .map(|part| part.as_ref())
            .collect::<Vec<_>>()
            .join("/")
    });
    Rc::from(normalize_posix(&joined))
}

pub fn path_resolve(parts: &JsArray<JsString>) -> JsString {
    let mut inputs = parts.with(|data| {
        data.elements
            .iter()
            .map(|part| part.to_string())
            .collect::<Vec<_>>()
    });
    inputs.insert(0, process_cwd().to_string());
    let mut combined = String::new();
    for part in inputs.iter().rev() {
        if part.is_empty() {
            continue;
        }
        combined = if combined.is_empty() {
            part.clone()
        } else {
            format!("{part}/{combined}")
        };
        if part.starts_with('/') {
            break;
        }
    }
    let mut normalized = normalize_posix(&combined);
    if normalized.len() > 1 {
        normalized.truncate(normalized.trim_end_matches('/').len());
    }
    Rc::from(if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    })
}

pub fn path_is_absolute(path: &JsString) -> bool {
    path.starts_with('/')
}

pub fn path_dirname(path: &JsString) -> JsString {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return string(".");
    }
    let root = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for index in (1..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => string(if root { "/" } else { "." }),
        Some(1) if root => string("//"),
        Some(end) => Rc::from(&path[..end]),
    }
}

pub fn path_basename(path: &JsString, suffix: &JsString) -> JsString {
    let trimmed = path.trim_end_matches('/');
    if !suffix.is_empty() && trimmed == suffix.as_ref() {
        return empty_string();
    }
    let mut basename = trimmed.rsplit('/').next().unwrap_or("");
    if !suffix.is_empty() && suffix.len() < basename.len() && basename.ends_with(suffix.as_ref()) {
        basename = &basename[..basename.len() - suffix.len()];
    }
    Rc::from(basename)
}

pub fn path_extname(path: &JsString) -> JsString {
    let basename = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let Some(dot) = basename.rfind('.') else {
        return empty_string();
    };
    if dot == 0 || basename == ".." {
        return empty_string();
    }
    Rc::from(&basename[dot..])
}

pub fn path_relative(from: &JsString, to: &JsString) -> JsString {
    let from_parts = path_resolve(&array_new(vec![from.clone()]));
    let to_parts = path_resolve(&array_new(vec![to.clone()]));
    let from_parts: Vec<_> = from_parts
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let to_parts: Vec<_> = to_parts
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(left, right)| left == right)
        .count();
    let mut result = vec![".."; from_parts.len() - common];
    result.extend(to_parts[common..].iter().copied());
    Rc::from(result.join("/"))
}

pub fn number_to_string(value: f64) -> JsString {
    Rc::from(format_number(value))
}

pub fn number_is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

pub fn number_is_safe_integer(value: f64) -> bool {
    number_is_integer(value) && value.abs() <= 9_007_199_254_740_991.0
}

pub fn bool_to_string(value: bool) -> JsString {
    string(if value { "true" } else { "false" })
}

pub trait JsonValue {
    fn write_json(&self, writer: &mut JsonWriter);

    fn is_json_undefined(&self) -> bool {
        false
    }
}

pub trait JsonObject: Trace + ClearEdges + 'static {
    fn write_json_object(&self, writer: &mut JsonWriter);
}

pub struct JsonWriter {
    output: String,
    stack: HashSet<usize>,
}

impl JsonWriter {
    fn new() -> Self {
        Self {
            output: String::new(),
            stack: HashSet::new(),
        }
    }

    pub fn begin_array(&mut self) {
        self.output.push('[');
    }

    pub fn end_array(&mut self) {
        self.output.push(']');
    }

    pub fn begin_object(&mut self) {
        self.output.push('{');
    }

    pub fn end_object(&mut self) {
        self.output.push('}');
    }

    pub fn element<T: JsonValue>(&mut self, first: &mut bool, value: &T) {
        if !*first {
            self.output.push(',');
        }
        *first = false;
        value.write_json(self);
    }

    pub fn property<T: JsonValue>(&mut self, first: &mut bool, name: &str, value: &T) {
        if value.is_json_undefined() {
            return;
        }
        if !*first {
            self.output.push(',');
        }
        *first = false;
        self.write_string(name);
        self.output.push(':');
        value.write_json(self);
    }

    pub fn write_null(&mut self) {
        self.output.push_str("null");
    }

    fn write_string(&mut self, value: &str) {
        self.output.push('"');
        for ch in value.chars() {
            match ch {
                '"' => self.output.push_str("\\\""),
                '\\' => self.output.push_str("\\\\"),
                '\u{0008}' => self.output.push_str("\\b"),
                '\u{000c}' => self.output.push_str("\\f"),
                '\n' => self.output.push_str("\\n"),
                '\r' => self.output.push_str("\\r"),
                '\t' => self.output.push_str("\\t"),
                '\u{0000}'..='\u{001f}' => {
                    self.output.push_str(&format!("\\u{:04x}", ch as u32));
                }
                _ => self.output.push(ch),
            }
        }
        self.output.push('"');
    }
}

impl JsonValue for f64 {
    fn write_json(&self, writer: &mut JsonWriter) {
        if self.is_finite() {
            writer.output.push_str(&format_number(*self));
        } else {
            writer.write_null();
        }
    }
}

impl JsonValue for bool {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.output.push_str(if *self { "true" } else { "false" });
    }
}

impl JsonValue for JsString {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.write_string(self);
    }
}

impl<T> JsonValue for Gc<T>
where
    T: JsonObject,
{
    fn write_json(&self, writer: &mut JsonWriter) {
        let id = self.identity();
        if !writer.stack.insert(id) {
            throw_type_error("Converting circular structure to JSON".to_owned());
        }
        self.with(|value| value.write_json_object(writer));
        assert!(writer.stack.remove(&id));
    }
}

impl<T> JsonObject for ArrayData<T>
where
    T: ArrayElement + JsonValue,
{
    fn write_json_object(&self, writer: &mut JsonWriter) {
        writer.begin_array();
        let mut first = true;
        for value in &self.elements {
            writer.element(&mut first, value);
        }
        writer.end_array();
    }
}

impl<V> JsonObject for MapData<JsString, V>
where
    V: HeapValue + JsonValue,
{
    fn write_json_object(&self, writer: &mut JsonWriter) {
        writer.begin_object();
        let mut first = true;
        for position in map_string_entry_order(self) {
            let (key, value) = self.entries[position]
                .as_ref()
                .expect("scriptc: ordered JSON property points at a tombstone");
            writer.property(&mut first, key, value);
        }
        writer.end_object();
    }
}

pub fn json_stringify<T: JsonValue>(value: &T) -> JsString {
    let mut writer = JsonWriter::new();
    value.write_json(&mut writer);
    Rc::from(writer.output)
}

pub enum JsonNode {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsonNode>),
    Object(Vec<(String, JsonNode)>),
}

impl JsonNode {
    fn kind(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool(_) => "boolean",
            Self::Number(_) => "number",
            Self::String(_) => "string",
            Self::Array(_) => "array",
            Self::Object(_) => "object",
        }
    }
}

pub trait JsonDecode: Sized {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String>;
}

pub trait JsonObjectDecode: Trace + ClearEdges + Sized + 'static {
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String>;
}

pub fn json_type_error(path: &str, expected: &str, node: &JsonNode) -> String {
    format!("expected {expected} at {path}, got {}", node.kind())
}

pub fn json_property_path(path: &str, property: &str) -> String {
    format!("{path}.{property}")
}

pub fn json_index_path(path: &str, index: usize) -> String {
    format!("{path}[{index}]")
}

pub fn json_expect_object<'a>(
    node: &'a JsonNode,
    path: &str,
) -> Result<&'a [(String, JsonNode)], String> {
    match node {
        JsonNode::Object(fields) => Ok(fields),
        _ => Err(json_type_error(path, "object", node)),
    }
}

pub fn json_expect_array<'a>(node: &'a JsonNode, path: &str) -> Result<&'a [JsonNode], String> {
    match node {
        JsonNode::Array(elements) => Ok(elements),
        _ => Err(json_type_error(path, "array", node)),
    }
}

pub fn json_object_field<'a>(object: &'a [(String, JsonNode)], name: &str) -> Option<&'a JsonNode> {
    object
        .iter()
        .rev()
        .find_map(|(key, value)| (key == name).then_some(value))
}

pub fn json_required_field<'a>(
    object: &'a [(String, JsonNode)],
    name: &str,
    path: &str,
) -> Result<&'a JsonNode, String> {
    json_object_field(object, name).ok_or_else(|| format!("expected property '{}' at {path}", name))
}

impl JsonDecode for f64 {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::Number(value) => Ok(*value),
            _ => Err(json_type_error(path, "number", node)),
        }
    }
}

impl JsonDecode for bool {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::Bool(value) => Ok(*value),
            _ => Err(json_type_error(path, "boolean", node)),
        }
    }
}

impl JsonDecode for JsString {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::String(value) => Ok(value.clone()),
            _ => Err(json_type_error(path, "string", node)),
        }
    }
}

impl<T> JsonDecode for Gc<T>
where
    T: JsonObjectDecode,
{
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        Ok(Gc::new(T::decode_json_object(node, path)?))
    }
}

impl<T> JsonObjectDecode for ArrayData<T>
where
    T: ArrayElement + JsonDecode,
{
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String> {
        let elements = json_expect_array(node, path)?;
        let mut decoded = Vec::with_capacity(elements.len());
        for (index, element) in elements.iter().enumerate() {
            decoded.push(T::decode_json(element, &json_index_path(path, index))?);
        }
        Ok(Self { elements: decoded })
    }
}

impl<V> JsonObjectDecode for MapData<JsString, V>
where
    V: HeapValue + JsonDecode,
{
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String> {
        let fields = json_expect_object(node, path)?;
        let mut entries: Vec<Option<(JsString, V)>> = Vec::with_capacity(fields.len());
        for (key, value) in fields {
            let decoded = V::decode_json(value, &json_property_path(path, key))?;
            if let Some((_, stored)) = entries
                .iter_mut()
                .flatten()
                .find(|(stored, _)| stored.as_ref() == key)
            {
                *stored = decoded;
            } else {
                entries.push(Some((string(key), decoded)));
            }
        }
        Ok(Self {
            live: entries.len(),
            entries,
            iteration_depth: 0,
        })
    }
}

pub fn json_parse_typed<T: JsonDecode>(text: &JsString) -> T {
    let node = JsonParser::new(text)
        .parse()
        .unwrap_or_else(|message| throw_syntax_error(message));
    T::decode_json(&node, "$").unwrap_or_else(|message| throw_type_error(message))
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> JsonParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            position: 0,
        }
    }

    fn parse(mut self) -> Result<JsonNode, String> {
        self.whitespace();
        let value = self.value()?;
        self.whitespace();
        if self.position != self.bytes.len() {
            return self.syntax("unexpected trailing input");
        }
        Ok(value)
    }

    fn value(&mut self) -> Result<JsonNode, String> {
        self.whitespace();
        match self.peek() {
            Some(b'n') => {
                self.keyword(b"null")?;
                Ok(JsonNode::Null)
            }
            Some(b't') => {
                self.keyword(b"true")?;
                Ok(JsonNode::Bool(true))
            }
            Some(b'f') => {
                self.keyword(b"false")?;
                Ok(JsonNode::Bool(false))
            }
            Some(b'"') => Ok(JsonNode::String(Rc::from(self.string()?))),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.syntax("unexpected token"),
        }
    }

    fn array(&mut self) -> Result<JsonNode, String> {
        self.position += 1;
        self.whitespace();
        let mut elements = Vec::new();
        if self.take(b']') {
            return Ok(JsonNode::Array(elements));
        }
        loop {
            elements.push(self.value()?);
            self.whitespace();
            if self.take(b']') {
                return Ok(JsonNode::Array(elements));
            }
            if !self.take(b',') {
                return self.syntax("expected ',' or ']'");
            }
        }
    }

    fn object(&mut self) -> Result<JsonNode, String> {
        self.position += 1;
        self.whitespace();
        let mut fields = Vec::new();
        if self.take(b'}') {
            return Ok(JsonNode::Object(fields));
        }
        loop {
            self.whitespace();
            if self.peek() != Some(b'"') {
                return self.syntax("expected a string property name");
            }
            let name = self.string()?;
            self.whitespace();
            if !self.take(b':') {
                return self.syntax("expected ':'");
            }
            fields.push((name, self.value()?));
            self.whitespace();
            if self.take(b'}') {
                return Ok(JsonNode::Object(fields));
            }
            if !self.take(b',') {
                return self.syntax("expected ',' or '}'");
            }
        }
    }

    fn number(&mut self) -> Result<JsonNode, String> {
        let start = self.position;
        self.take(b'-');
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                self.position += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return self.syntax("invalid number"),
        }
        if self.take(b'.') {
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.syntax("invalid number fraction");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.syntax("invalid number exponent");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        let spelling = std::str::from_utf8(&self.bytes[start..self.position])
            .map_err(|_| "invalid UTF-8 in JSON number".to_owned())?;
        let value = spelling
            .parse::<f64>()
            .map_err(|_| format!("invalid JSON number at byte {start}"))?;
        Ok(JsonNode::Number(value))
    }

    fn string(&mut self) -> Result<String, String> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.position += 1;
        let mut output = String::new();
        loop {
            let Some(byte) = self.peek() else {
                return self.syntax("unterminated string");
            };
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(output);
                }
                b'\\' => {
                    self.position += 1;
                    let escaped = self
                        .peek()
                        .ok_or_else(|| format!("unterminated escape at byte {}", self.position))?;
                    self.position += 1;
                    match escaped {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => {
                            let first = self.hex_quad()?;
                            if (0xd800..=0xdbff).contains(&first)
                                && self.bytes.get(self.position..self.position + 2) == Some(b"\\u")
                            {
                                self.position += 2;
                                let second = self.hex_quad()?;
                                if (0xdc00..=0xdfff).contains(&second) {
                                    let scalar = 0x10000
                                        + (((first as u32 - 0xd800) << 10)
                                            | (second as u32 - 0xdc00));
                                    output.push(
                                        char::from_u32(scalar).expect("valid JSON surrogate pair"),
                                    );
                                } else {
                                    output.push('\u{fffd}');
                                    output
                                        .push(char::from_u32(second as u32).unwrap_or('\u{fffd}'));
                                }
                            } else {
                                output.push(char::from_u32(first as u32).unwrap_or('\u{fffd}'));
                            }
                        }
                        _ => return self.syntax("invalid string escape"),
                    }
                }
                0x00..=0x1f => return self.syntax("unescaped control character in string"),
                _ => {
                    let tail = std::str::from_utf8(&self.bytes[self.position..])
                        .map_err(|_| format!("invalid UTF-8 at byte {}", self.position))?;
                    let ch = tail.chars().next().expect("non-empty JSON input tail");
                    output.push(ch);
                    self.position += ch.len_utf8();
                }
            }
        }
    }

    fn hex_quad(&mut self) -> Result<u16, String> {
        let start = self.position;
        let end = start.saturating_add(4);
        let Some(bytes) = self.bytes.get(start..end) else {
            return self.syntax("incomplete unicode escape");
        };
        let spelling = std::str::from_utf8(bytes).expect("ASCII JSON unicode escape");
        let value = u16::from_str_radix(spelling, 16)
            .map_err(|_| format!("invalid unicode escape at byte {start}"))?;
        self.position = end;
        Ok(value)
    }

    fn keyword(&mut self, keyword: &[u8]) -> Result<(), String> {
        if self.bytes.get(self.position..self.position + keyword.len()) != Some(keyword) {
            return self.syntax("unexpected token");
        }
        self.position += keyword.len();
        Ok(())
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.position += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn take(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn syntax<T>(&self, message: &str) -> Result<T, String> {
        Err(format!("{message} at byte {}", self.position))
    }
}

pub fn format_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == f64::INFINITY {
        return "Infinity".to_owned();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let scientific = format!("{value:e}");
        let (mantissa, exponent) = scientific
            .split_once('e')
            .expect("scriptc: Rust scientific number without an exponent");
        let exponent = exponent
            .parse::<i32>()
            .expect("scriptc: invalid Rust scientific exponent");
        return format!(
            "{mantissa}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        );
    }
    value.to_string()
}

pub fn display_string(value: &JsString) -> String {
    value.to_string()
}

pub fn display_number(value: f64) -> String {
    if value == 0.0 && value.is_sign_negative() {
        "-0".to_owned()
    } else {
        format_number(value)
    }
}

pub fn display_bool(value: bool) -> String {
    if value { "true" } else { "false" }.to_owned()
}

pub fn number_same_value(left: f64, right: f64) -> bool {
    if left.is_nan() && right.is_nan() {
        return true;
    }
    if left == 0.0 && right == 0.0 {
        return left.is_sign_negative() == right.is_sign_negative();
    }
    left == right
}

pub fn math_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_positive() || right.is_sign_positive() {
            0.0
        } else {
            -0.0
        };
    }
    if left > right { left } else { right }
}

pub fn math_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_negative() || right.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if left < right { left } else { right }
}

pub fn math_max_array(values: &JsArray<f64>) -> f64 {
    values.with(|values| {
        values
            .elements
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, math_max)
    })
}

pub fn math_min_array(values: &JsArray<f64>) -> f64 {
    values.with(|values| {
        values
            .elements
            .iter()
            .copied()
            .fold(f64::INFINITY, math_min)
    })
}

pub fn math_round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() || value == 0.0 {
        return value;
    }
    let floor = value.floor();
    let rounded = if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    if rounded == 0.0 && value < 0.0 {
        -0.0
    } else {
        rounded
    }
}

thread_local! {
    static MATH_RANDOM_STATE: Cell<u64> = const { Cell::new(0x9e37_79b9_7f4a_7c15) };
}

pub fn math_random() -> f64 {
    MATH_RANDOM_STATE.with(|state| {
        let mut next = state.get();
        next ^= next >> 12;
        next ^= next << 25;
        next ^= next >> 27;
        state.set(next);
        let bits = next.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11;
        bits as f64 * (1.0 / 9_007_199_254_740_992.0)
    })
}

pub fn console_log(values: &[String]) {
    println!("{}", values.join(" "));
}

pub fn console_error(values: &[String]) {
    eprintln!("{}", values.join(" "));
}

pub fn to_int32(value: f64) -> i32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    let truncated = value.trunc();
    let modulo = truncated.rem_euclid(4_294_967_296.0);
    if modulo >= 2_147_483_648.0 {
        (modulo - 4_294_967_296.0) as i32
    } else {
        modulo as i32
    }
}

pub fn to_uint32(value: f64) -> u32 {
    to_int32(value) as u32
}

pub fn bit_not(value: f64) -> f64 {
    (!to_int32(value)) as f64
}

pub fn bit_and(left: f64, right: f64) -> f64 {
    (to_int32(left) & to_int32(right)) as f64
}

pub fn bit_or(left: f64, right: f64) -> f64 {
    (to_int32(left) | to_int32(right)) as f64
}

pub fn bit_xor(left: f64, right: f64) -> f64 {
    (to_int32(left) ^ to_int32(right)) as f64
}

pub fn shift_left(left: f64, right: f64) -> f64 {
    to_int32(left).wrapping_shl(to_uint32(right) & 31) as f64
}

pub fn shift_right(left: f64, right: f64) -> f64 {
    to_int32(left).wrapping_shr(to_uint32(right) & 31) as f64
}

pub fn shift_right_unsigned(left: f64, right: f64) -> f64 {
    to_uint32(left).wrapping_shr(to_uint32(right) & 31) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Link {
        next: Option<Gc<Link>>,
    }

    impl Trace for Link {
        fn trace(&self, tracer: &mut Tracer<'_>) {
            if let Some(next) = &self.next {
                tracer.edge(next);
            }
        }
    }

    impl ClearEdges for Link {
        fn clear_edges(&mut self) {
            self.next = None;
        }
    }

    #[test]
    fn formats_javascript_special_numbers() {
        assert_eq!(format_number(f64::NAN), "NaN");
        assert_eq!(format_number(f64::INFINITY), "Infinity");
        assert_eq!(format_number(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(format_number(-0.0), "0");
        assert_eq!(format_number(1e21), "1e+21");
        assert_eq!(format_number(1e-7), "1e-7");
        assert_eq!(format_number(1e-6), "0.000001");
        assert_eq!(format_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(display_number(-0.0), "-0");
    }

    #[test]
    fn char_at_uses_javascript_utf16_indexes() {
        let value = string("Aé🎉Z");
        assert_eq!(string_char_at(&value, f64::NAN).as_ref(), "A");
        assert_eq!(string_char_at(&value, 1.9).as_ref(), "é");
        assert_eq!(string_char_at(&value, 2.0).as_ref(), "�");
        assert_eq!(string_char_at(&value, 3.0).as_ref(), "�");
        assert_eq!(string_char_at(&value, 4.0).as_ref(), "Z");
        assert_eq!(string_char_at(&value, -1.0).as_ref(), "");
        assert_eq!(string_char_at(&value, f64::INFINITY).as_ref(), "");
    }

    #[test]
    fn string_case_conversion_handles_ascii() {
        let value = string("ScriptC 42");
        assert_eq!(string_to_lower_case(&value).as_ref(), "scriptc 42");
        assert_eq!(string_to_upper_case(&value).as_ref(), "SCRIPTC 42");
        assert!(string_includes(&value, &string("iptC"), 0.0));
        assert!(!string_includes(&value, &string("iptc"), 0.0));
    }

    #[test]
    fn string_padding_counts_utf16_units() {
        let value = string("😀");
        assert_eq!(string_pad_start(&value, 3.0, &string("ab")).as_ref(), "a😀");
        assert_eq!(string_pad_end(&value, 4.0, &string("🎉")).as_ref(), "😀🎉");
        assert_eq!(string_pad_start(&value, 3.0, &string("🎉")).as_ref(), "�😀");
        assert_eq!(string_pad_start(&value, -1.0, &string("x")).as_ref(), "😀");
        assert_eq!(
            string_pad_start(&value, 10.0, &empty_string()).as_ref(),
            "😀"
        );
    }

    #[test]
    fn regex_test_preserves_ecmascript_flags_and_state() {
        let unicode = regex_new("^.$", "u");
        let legacy = regex_new("^.$", "");
        assert!(regex_test(&unicode, &string("😀")));
        assert!(!regex_test(&legacy, &string("😀")));

        let global = regex_new(r"\d", "g");
        let text = string("1a2");
        assert!(regex_test(&global, &text));
        assert!(regex_test(&global, &text));
        assert!(!regex_test(&global, &text));
        assert!(regex_test(&global, &text));

        let sticky = regex_new("a", "y");
        assert!(regex_test(&sticky, &string("ab")));
        assert!(!regex_test(&sticky, &string("ab")));
        assert_eq!(regex_source(&global).as_ref(), r"\d");
        assert_eq!(regex_flags(&global).as_ref(), "g");
    }

    #[test]
    fn regex_replacement_and_split_use_utf16_ranges() {
        let astral_subject = string("😀z");
        let suffix = regex_new("z", "");
        let prefix_replacement = string("($`)");
        assert_eq!(
            regex_replace(&astral_subject, &suffix, &prefix_replacement).as_ref(),
            "😀(😀)"
        );
        assert_eq!(
            regex_replace(
                &string("14px 9em"),
                &regex_new(r"(?<n>\d+)px|(?<n>\d+)em", "g"),
                &string("[$<n>]"),
            )
            .as_ref(),
            "[14] [9]"
        );
        let pieces = regex_split(&string("a1b2c"), &regex_new(r"\d", ""), u32::MAX as f64);
        assert_eq!(array_len(&pieces), 3.0);
        assert_eq!(array_get(&pieces, 0.0).as_ref(), "a");
        assert_eq!(array_get(&pieces, 1.0).as_ref(), "b");
        assert_eq!(array_get(&pieces, 2.0).as_ref(), "c");
        assert_eq!(regexp_escape(&string("a.b")).as_ref(), r"\x61\.b");
        assert_eq!(regexp_escape(&string("- \n")).as_ref(), r"\x2d\x20\n");
    }

    #[test]
    fn regex_match_search_and_match_all_preserve_utf16_semantics() {
        let subject = string("😀a12 b");
        let matched = regex_match(&subject, &regex_new(r"(a)(\d+)", "")).unwrap();
        assert_eq!(array_len(&matched), 3.0);
        assert_eq!(array_get(&matched, 0.0).as_ref(), "a12");
        assert_eq!(array_get(&matched, 1.0).as_ref(), "a");
        assert_eq!(array_get(&matched, 2.0).as_ref(), "12");
        assert_eq!(regex_search(&subject, &regex_new(r"\d+", "")), 3.0);

        let indices = array_new(Vec::new());
        let rows = regex_match_all_into(&subject, &regex_new(r"\w", "g"), &indices);
        assert_eq!(array_len(&rows), 4.0);
        assert_eq!(array_len(&indices), 4.0);
        assert_eq!(array_get(&indices, 0.0), 2.0);
        assert_eq!(array_get(&indices, 3.0), 6.0);

        let stateful = regex_new(r"\w", "g");
        assert!(regex_test(&stateful, &string("ab")));
        assert_eq!(stateful.last_index.get(), 1);
        let remaining = regex_match_all(&string("ab"), &stateful);
        assert_eq!(array_len(&remaining), 1.0);
        assert_eq!(array_get(&array_get(&remaining, 0.0), 0.0).as_ref(), "b");
        assert_eq!(stateful.last_index.get(), 1);
        let all = regex_match(&string("ab"), &stateful).unwrap();
        assert_eq!(array_len(&all), 2.0);
        assert_eq!(stateful.last_index.get(), 0);
    }

    #[test]
    fn typed_array_copying_methods_coerce_values_and_preserve_the_source() {
        let baseline = live_heap_objects();
        {
            let source = bytes_from_array::<u8>(&array_new(vec![5.0, 1.0, 4.0, 1.0, 3.0]));
            assert_eq!(bytes_join(&source, &string(",")).as_ref(), "5,1,4,1,3");
            let array_copy = bytes_to_array(&source);
            array_set(&array_copy, 0.0, 99.0);
            assert_eq!(array_get(&array_copy, 0.0), 99.0);
            assert_eq!(bytes_get(&source, 0.0), 5.0);
            let reversed = bytes_to_reversed(&source);
            assert_eq!(bytes_join(&reversed, &string(",")).as_ref(), "3,1,4,1,5");
            assert_eq!(bytes_join(&source, &string(",")).as_ref(), "5,1,4,1,3");
            assert_eq!(
                bytes_join(&bytes_with(&source, 1.0, -1.0), &string(",")).as_ref(),
                "5,255,4,1,3"
            );
            assert_eq!(
                bytes_join(&bytes_with(&source, -1.0, 260.0), &string(",")).as_ref(),
                "5,1,4,1,4"
            );
            assert_eq!(
                bytes_join(&bytes_with(&source, f64::NAN, 9.0), &string(",")).as_ref(),
                "9,1,4,1,3"
            );
            for index in [5.0, -6.0, f64::INFINITY] {
                let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    bytes_with(&source, index, 0.0)
                }))
                .err()
                .expect("an out-of-range TypedArray.with index must throw");
                let caught = caught_from_panic(payload);
                assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
                assert_eq!(
                    caught_error_message(&caught).as_ref(),
                    "Invalid typed array index"
                );
            }
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn buffer_comparison_and_search_match_node_ranges_and_offsets() {
        let baseline = live_heap_objects();
        {
            let source = buffer_from_string(&string("abcabcabc"), &string("utf8"));
            let same = buffer_from_string(&string("abcabcabc"), &string("utf8"));
            let greater = buffer_from_string(&string("abd"), &string("utf8"));
            let needle = buffer_from_string(&string("bc"), &string("utf8"));
            assert!(bytes_equals(&source, &same));
            assert!(!bytes_equals(&source, &greater));
            assert_eq!(
                bytes_compare(&source, &greater, 0, 0.0, 0.0, 0.0, 0.0),
                -1.0
            );
            assert_eq!(
                bytes_compare(&source, &greater, 4, 1.0, 3.0, 0.0, 2.0),
                -1.0
            );
            assert_eq!(bytes_compare(&source, &greater, 4, 1.0, 1.0, 1.0, 1.0), 0.0);
            assert_eq!(bytes_index_of(&source, &needle, f64::NAN, 1.0, true), 1.0);
            assert_eq!(bytes_index_of(&source, &needle, 4.0, 1.0, false), 4.0);
            assert_eq!(bytes_index_of(&source, &needle, -99.0, 1.0, false), -1.0);
            assert_eq!(bytes_index_of_num(&source, 354.0, 0.0, true), 1.0);
            let utf16 = buffer_from_string(&string("610062006300"), &string("hex"));
            let utf16_needle = buffer_from_string(&string("6200"), &string("hex"));
            assert_eq!(
                bytes_index_of(&utf16, &utf16_needle, f64::NAN, 2.0, true),
                2.0
            );

            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                bytes_compare(&source, &greater, 1, -1.0, 0.0, 0.0, 0.0)
            }))
            .err()
            .expect("a negative compare offset must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
            assert_eq!(
                caught_error_code(&caught).expect("error code").as_ref(),
                "ERR_OUT_OF_RANGE"
            );
            assert_eq!(
                caught_error_message(&caught).as_ref(),
                "The value of \"targetStart\" is out of range. It must be >= 0 && <= 9007199254740991. Received -1"
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn buffer_mutation_methods_preserve_node_clamping_and_chaining() {
        let baseline = live_heap_objects();
        {
            let filled = bytes_alloc::<u8>(5.0);
            let chained = bytes_fill_str(&filled, &string("ab"), &string("utf8"), 0, 0.0, 0.0);
            assert!(filled.ptr_eq(&chained));
            assert_eq!(bytes_to_string(&filled, &string("utf8")).as_ref(), "ababa");

            let source = buffer_from_string(&string("abcdef"), &string("utf8"));
            let target = bytes_alloc::<u8>(4.0);
            assert_eq!(bytes_copy_into(&source, &target, 3, 1.0, 2.9, 5.9), 3.0);
            assert_eq!(
                bytes_to_string(&target, &string("hex")).as_ref(),
                "00636465"
            );

            let swapped = buffer_from_string(&string("01020304"), &string("hex"));
            assert!(swapped.ptr_eq(&bytes_swap(&swapped, 2)));
            assert_eq!(
                bytes_to_string(&swapped, &string("hex")).as_ref(),
                "02010403"
            );

            let written = bytes_alloc::<u8>(5.0);
            assert_eq!(
                bytes_write_str(&written, &string("h😀x"), &string("utf8"), 0.0, 4.0, true,),
                1.0
            );
            assert_eq!(
                bytes_to_string(&written, &string("hex")).as_ref(),
                "6800000000"
            );

            let parts = array_new(vec![
                buffer_from_string(&string("0102"), &string("hex")),
                buffer_from_string(&string("03"), &string("hex")),
            ]);
            assert_eq!(
                bytes_to_string(&buffer_concat_len(&parts, 5.0), &string("hex")).as_ref(),
                "0102030000"
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn buffer_numeric_methods_follow_node_coercion_and_error_order() {
        let baseline = live_heap_objects();
        {
            let fixed = bytes_alloc::<u8>(8.0);
            assert_eq!(bytes_write_num(&fixed, "u32be", 1.9, 0.0), 4.0);
            assert_eq!(bytes_read_num(&fixed, "u32be", 0.0), 1.0);
            assert_eq!(bytes_write_num(&fixed, "u16le", f64::NAN, 0.0), 2.0);
            assert_eq!(bytes_read_num(&fixed, "u16le", 0.0), 0.0);

            let variable = bytes_alloc::<u8>(6.0);
            assert_eq!(
                bytes_write_num_var(&variable, "ule", 4_328_719_365.0, 0.0, 5.0),
                5.0
            );
            assert_eq!(
                bytes_to_string(&variable, &string("hex")).as_ref(),
                "050403020100"
            );
            assert_eq!(
                bytes_read_num_var(&variable, "ule", 0.0, 5.0),
                4_328_719_365.0
            );
            bytes_write_num_var(&variable, "ibe", -2.0, 0.0, 3.0);
            assert_eq!(bytes_read_num_var(&variable, "ibe", 0.0, 3.0), -2.0);

            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                bytes_read_num(&fixed, "u16be", 4_294_967_297.0)
            }))
            .err()
            .expect("an out-of-range numeric offset must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(
                caught_error_code(&caught).expect("error code").as_ref(),
                "ERR_OUT_OF_RANGE"
            );
            assert_eq!(
                caught_error_message(&caught).as_ref(),
                "The value of \"offset\" is out of range. It must be >= 0 and <= 6. Received 4_294_967_297"
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn buffer_encodings_cover_aliases_dynamic_errors_and_utf16_lengths() {
        let baseline = live_heap_objects();
        {
            let value = string("hé€😀x");
            let latin1 = buffer_from_string(&value, &string("latin1"));
            assert_eq!(
                bytes_to_string(&latin1, &string("hex")).as_ref(),
                "68e9ac3d0078"
            );
            let utf16 = buffer_from_string(&value, &string("utf16le"));
            assert_eq!(
                bytes_to_string(&utf16, &string("utf16le")).as_ref(),
                value.as_ref()
            );
            assert_eq!(buffer_byte_length_string(&value, &string("latin1")), 6.0);
            assert_eq!(buffer_byte_length_string(&value, &string("utf16le")), 12.0);
            assert!(buffer_is_encoding(&string("BASE64URL")));
            assert!(buffer_is_encoding(&string("ucs-2")));
            assert!(!buffer_is_encoding(&string("utf16")));

            let raw = buffer_from_string(&string("68e9807fff"), &string("hex"));
            assert_eq!(
                bytes_to_string_checked(&raw, &string("BINARY")).as_ref(),
                "hé\u{80}\u{7f}ÿ"
            );
            assert_eq!(
                bytes_to_string_checked_range(&raw, &string("wat"), 2.0, 2.0).as_ref(),
                ""
            );
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                bytes_to_string_checked(&raw, &string("wat"))
            }))
            .err()
            .expect("an unknown dynamic encoding must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(
                caught_error_code(&caught).expect("error code").as_ref(),
                "ERR_UNKNOWN_ENCODING"
            );
            assert_eq!(
                caught_error_message(&caught).as_ref(),
                "Unknown encoding: wat"
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn string_decoder_buffers_only_incomplete_encoding_units() {
        let baseline = live_heap_objects();
        {
            let utf8 = string("utf8");
            let first = bytes_from_elements(vec![0xe2, 0x82]);
            assert_eq!(string_decoder_write(&utf8, 0.0, &first).as_ref(), "");
            let pending = string_decoder_next(&utf8, 0.0, &first);
            let second = bytes_from_elements(vec![0xac, 0x61]);
            assert_eq!(string_decoder_write(&utf8, pending, &second).as_ref(), "€a");
            assert_eq!(string_decoder_next(&utf8, pending, &second), 0.0);

            let utf16 = string("utf16le");
            let odd = buffer_from_string(&string("61"), &string("hex"));
            assert_eq!(string_decoder_write(&utf16, 0.0, &odd).as_ref(), "");
            let pending = string_decoder_next(&utf16, 0.0, &odd);
            let rest = buffer_from_string(&string("006200"), &string("hex"));
            assert_eq!(string_decoder_write(&utf16, pending, &rest).as_ref(), "ab");

            let base64 = string("base64");
            let grouped = bytes_from_elements(vec![1, 2, 3, 4]);
            assert_eq!(
                string_decoder_write(&base64, 0.0, &grouped).as_ref(),
                "AQID"
            );
            let pending = string_decoder_next(&base64, 0.0, &grouped);
            assert_eq!(string_decoder_end(&base64, pending).as_ref(), "BA==");
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn scalar_json_stringification_escapes_strings_and_normalizes_non_finite_numbers() {
        assert_eq!(json_stringify(&f64::NAN).as_ref(), "null");
        assert_eq!(json_stringify(&f64::INFINITY).as_ref(), "null");
        assert_eq!(json_stringify(&-0.0).as_ref(), "0");
        assert_eq!(json_stringify(&true).as_ref(), "true");
        assert_eq!(
            json_stringify(&string("quote \" slash \\\n\t\u{0007}")).as_ref(),
            "\"quote \\\" slash \\\\\\n\\t\\u0007\""
        );
        assert_eq!(json_stringify(&string("héllo 😀")).as_ref(), "\"héllo 😀\"");
    }

    #[test]
    fn bitwise_conversions_follow_ecmascript_width() {
        assert_eq!(bit_not(0.0), -1.0);
        assert_eq!(shift_right_unsigned(-1.0, 1.0), 2_147_483_647.0);
    }

    #[test]
    fn filesystem_errors_use_node_style_lowercase_descriptions() {
        assert_eq!(
            fs_error_text(&std::io::Error::from(std::io::ErrorKind::NotFound)),
            "no such file or directory"
        );
        assert_eq!(
            fs_error_text(&std::io::Error::from(std::io::ErrorKind::AlreadyExists)),
            "file already exists"
        );
        assert_eq!(
            fs_error_text(&std::io::Error::from(std::io::ErrorKind::IsADirectory)),
            "illegal operation on a directory"
        );
    }

    #[test]
    fn filesystem_creation_modes_reject_non_integer_and_out_of_range_values() {
        for mode in [-1.0, 1.5, f64::NAN, f64::INFINITY, 4_294_967_296.0] {
            let payload =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fs_creation_mode(mode)))
                    .expect_err("an invalid creation mode must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
            assert_eq!(
                caught_error_code(&caught).as_deref(),
                Some("ERR_OUT_OF_RANGE")
            );
        }
        assert_eq!(fs_creation_mode(0o600 as f64), 0o600);
        assert_eq!(fs_creation_mode(4_294_967_295.0), u32::MAX);
    }

    #[test]
    fn file_handle_aliases_share_close_state_and_last_drop_closes() {
        let baseline = live_heap_objects();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the test clock must follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "scriptc-runtime-file-handle-{}-{suffix}",
            std::process::id()
        ));
        std::fs::write(&path, b"handle").expect("the FileHandle fixture must be writable");
        let path_string: JsString = Rc::from(path.to_string_lossy().as_ref());

        {
            let handle = file_handle_open(&path_string, &string("r"), 0o666 as f64);
            let alias = handle.clone();
            let fd = file_handle_fd(&handle);
            assert!(fd >= 0.0);
            assert_eq!(file_handle_fd(&alias), fd);
            assert_eq!(stats_size(&file_handle_stat(&handle)), 6.0);
            file_handle_close(&alias);
            assert_eq!(file_handle_fd(&handle), -1.0);
            file_handle_close(&handle);
        }

        {
            let handle = file_handle_open(&path_string, &string("r"), 0o666 as f64);
            let fd = file_handle_fd(&handle) as i32;
            assert!(OPEN_FILES.with(|files| files.borrow().contains_key(&fd)));
            drop(handle);
            assert!(!OPEN_FILES.with(|files| files.borrow().contains_key(&fd)));
        }

        std::fs::remove_file(path).expect("the FileHandle fixture must be removable");
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn file_handle_data_operations_preserve_descriptor_position() {
        let baseline = live_heap_objects();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the test clock must follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "scriptc-runtime-file-handle-data-{}-{suffix}",
            std::process::id()
        ));
        std::fs::write(&path, b"abcdef").expect("the FileHandle fixture must be writable");
        let path_string: JsString = Rc::from(path.to_string_lossy().as_ref());

        {
            let handle = file_handle_open(&path_string, &string("r+"), 0o666 as f64);
            let current = bytes_alloc::<u8>(3.0);
            assert_eq!(
                file_handle_read(&handle, &current, 0.0, -1.0, -1.0, true),
                3.0
            );
            assert_eq!(bytes_to_string(&current, &string("utf8")).as_ref(), "abc");

            let positioned = bytes_alloc::<u8>(2.0);
            assert_eq!(
                file_handle_read(&handle, &positioned, 0.0, 2.0, 4.0, false),
                2.0
            );
            assert_eq!(bytes_to_string(&positioned, &string("utf8")).as_ref(), "ef");
            assert_eq!(
                file_handle_write_str(&handle, &string("XY"), -1.0, &string("utf8")),
                2.0
            );
            let source = buffer_from_string(&string("QZ"), &string("utf8"));
            assert_eq!(
                file_handle_write_bytes(&handle, &source, 0.0, 2.0, 1.0, false),
                2.0
            );
            assert_eq!(
                file_handle_read_file(&handle, &string("utf8")).as_ref(),
                "f"
            );
            assert_eq!(
                std::fs::read(&path).expect("fixture must be readable"),
                b"aQZXYf"
            );
            file_handle_close(&handle);
        }

        std::fs::remove_file(path).expect("the FileHandle fixture must be removable");
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn file_handle_invalid_argument_inspection_matches_node() {
        assert_eq!(inspected_argument("bad"), "'bad'");
        assert_eq!(inspected_argument("w'bad"), "\"w'bad\"");
        assert_eq!(inspected_argument("w\"bad"), "'w\"bad'");
        assert_eq!(inspected_argument("w'\"bad"), "`w'\"bad`");
        assert_eq!(inspected_argument("w\\bad"), "'w\\\\bad'");
        assert_eq!(inspected_argument("w\nbad"), "'w\\nbad'");
        assert_eq!(inspected_argument("w\u{0080}bad"), "'w\\x80bad'");
        assert_eq!(inspected_argument("w\0not-a-flag"), "'w\\x00not-a-flag'");
        let long = inspected_argument(&"x".repeat(256));
        assert_eq!(long.encode_utf16().count(), 131);
        assert!(long.starts_with('\''));
        assert!(long.ends_with("..."));
    }

    #[test]
    fn rename_workers_progress_and_checkpoint_each_callback() {
        init();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the test clock must follow the Unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "scriptc-runtime-rename-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).expect("the rename fixture directory must be creatable");
        let source_a = dir.join("a.txt");
        let source_b = dir.join("b.txt");
        let destination_a = dir.join("a-done.txt");
        let destination_b = dir.join("b-done.txt");
        std::fs::write(&source_a, b"a").expect("the first rename fixture must be writable");
        std::fs::write(&source_b, b"b").expect("the second rename fixture must be writable");

        let callbacks = Rc::new(Cell::new(0));
        let ticks = Rc::new(Cell::new(0));
        let microtasks = Rc::new(Cell::new(0));
        let callback =
            |callbacks: Rc<Cell<i32>>, ticks: Rc<Cell<i32>>, microtasks: Rc<Cell<i32>>| {
                Box::new(move |error: Option<JsError>| {
                    assert!(error.is_none());
                    callbacks.set(callbacks.get() + 1);
                    if callbacks.get() == 2 {
                        assert_eq!(ticks.get(), 1);
                        assert_eq!(microtasks.get(), 1);
                    }
                    let next_ticks = ticks.clone();
                    process_next_tick(Box::new(move || next_ticks.set(next_ticks.get() + 1)));
                    let queued_microtasks = microtasks.clone();
                    timer_queue_microtask(Box::new(move || {
                        queued_microtasks.set(queued_microtasks.get() + 1);
                    }));
                }) as Box<dyn FnOnce(Option<JsError>)>
            };

        let source_a_string: JsString = Rc::from(source_a.to_string_lossy().as_ref());
        let source_b_string: JsString = Rc::from(source_b.to_string_lossy().as_ref());
        let destination_a_string: JsString = Rc::from(destination_a.to_string_lossy().as_ref());
        let destination_b_string: JsString = Rc::from(destination_b.to_string_lossy().as_ref());
        fs_rename_async(
            &source_a_string,
            &destination_a_string,
            callback(callbacks.clone(), ticks.clone(), microtasks.clone()),
        );
        fs_rename_async(
            &source_b_string,
            &destination_b_string,
            callback(callbacks.clone(), ticks.clone(), microtasks.clone()),
        );

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while (source_a.exists() || source_b.exists()) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(!source_a.exists() && !source_b.exists());
        assert_eq!(callbacks.get(), 0);
        run_event_loop();
        assert_eq!(callbacks.get(), 2);
        assert_eq!(ticks.get(), 2);
        assert_eq!(microtasks.get(), 2);

        let abandoned_source = dir.join("abandoned.txt");
        let abandoned_destination = dir.join("abandoned-done.txt");
        std::fs::write(&abandoned_source, b"cleanup")
            .expect("the abandoned rename fixture must be writable");
        let abandoned_called = Rc::new(Cell::new(false));
        let abandoned_callback = abandoned_called.clone();
        fs_rename_async(
            &Rc::from(abandoned_source.to_string_lossy().as_ref()),
            &Rc::from(abandoned_destination.to_string_lossy().as_ref()),
            Box::new(move |_| abandoned_callback.set(true)),
        );
        finish();
        assert!(abandoned_destination.exists());
        assert!(!abandoned_called.get());
        std::fs::remove_dir_all(dir).expect("the rename fixture directory must be removable");
    }

    #[test]
    fn same_value_distinguishes_signed_zero_and_matches_nan() {
        assert!(number_same_value(f64::NAN, f64::NAN));
        assert!(!number_same_value(0.0, -0.0));
        assert!(number_same_value(-0.0, -0.0));
    }

    #[test]
    fn math_min_max_match_javascript_nan_and_signed_zero_rules() {
        assert!(math_max(f64::NAN, 1.0).is_nan());
        assert!(math_min(1.0, f64::NAN).is_nan());
        assert!(math_max(-0.0, 0.0).is_sign_positive());
        assert!(math_max(-0.0, -0.0).is_sign_negative());
        assert!(math_min(-0.0, 0.0).is_sign_negative());
        assert!(math_min(0.0, 0.0).is_sign_positive());

        let values = array_new(vec![3.0, -0.0, 0.0, 9.0]);
        assert_eq!(math_max_array(&values), 9.0);
        assert_eq!(math_min_array(&values), -0.0);
        assert_eq!(math_max_array(&array_new(Vec::new())), f64::NEG_INFINITY);
        assert_eq!(math_min_array(&array_new(Vec::new())), f64::INFINITY);
        assert!(math_max_array(&array_new(vec![1.0, f64::NAN])).is_nan());
    }

    #[test]
    fn math_round_matches_javascript_ties_and_signed_zero() {
        assert_eq!(math_round(1.5), 2.0);
        assert_eq!(math_round(-1.5), -1.0);
        assert_eq!(math_round(0.499_999_999_999_999_94), 0.0);
        assert!(math_round(-0.3).is_sign_negative());
        assert!(math_round(-0.0).is_sign_negative());
        assert!(math_round(f64::NAN).is_nan());
        assert_eq!(math_round(f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn parse_float_uses_the_longest_javascript_decimal_prefix() {
        assert_eq!(number_parse_float(&string("  -2.5e-2tail")), -0.025);
        assert_eq!(number_parse_float(&string(".5")), 0.5);
        assert_eq!(number_parse_float(&string("1e")), 1.0);
        assert_eq!(number_parse_float(&string("0x10")), 0.0);
        assert_eq!(number_parse_float(&string("+Infinity!")), f64::INFINITY);
        assert!(number_parse_float(&string("inf")).is_nan());
        assert!(number_parse_float(&string("")).is_nan());
        assert!(number_parse_float(&string("-0")).is_sign_negative());
    }

    #[test]
    fn string_last_index_of_and_substring_use_utf16_indices() {
        let value = string("😀ab😀ab");
        assert_eq!(string_last_index_of(&value, &string("😀")), 4.0);
        assert_eq!(string_last_index_of(&value, &empty_string()), 8.0);
        assert_eq!(string_last_index_of(&value, &string("x")), -1.0);
        assert_eq!(string_substring(&value, 6.0, 2.0).as_ref(), "ab😀");
        assert_eq!(string_substring(&value, -3.0, 2.0).as_ref(), "😀");
        assert!(string_compare_utf16(&string("😀"), &string("\u{e000}")) < 0);
        assert_eq!(string_compare_utf16(&string("same"), &string("same")), 0);
    }

    #[test]
    fn math_random_stays_in_javascript_range_and_varies() {
        let first = math_random();
        let mut varied = false;
        for _ in 0..128 {
            let value = math_random();
            assert!((0.0..1.0).contains(&value));
            varied |= value != first;
        }
        assert!(varied);
    }

    #[test]
    fn indexed_string_records_use_javascript_property_order() {
        let record = map_new();
        for (key, value) in [("name", "n"), ("10", "ten"), ("2", "two"), ("tail", "t")] {
            map_set_by(&record, string(key), string(value), |left, right| {
                left.as_ref() == right.as_ref()
            });
        }
        let keys = map_string_keys_js_order(&record);
        assert_eq!(array_get(&keys, 0.0).as_ref(), "2");
        assert_eq!(array_get(&keys, 1.0).as_ref(), "10");
        assert_eq!(array_get(&keys, 2.0).as_ref(), "name");
        assert_eq!(array_get(&keys, 3.0).as_ref(), "tail");
        assert_eq!(
            json_stringify(&record).as_ref(),
            r#"{"2":"two","10":"ten","name":"n","tail":"t"}"#
        );
    }

    #[test]
    fn arrays_preserve_aliasing_and_release_acyclic_values() {
        let baseline = live_heap_objects();
        {
            let array = array_new(vec![1.0, 2.0]);
            let alias = array.clone();
            array_set(&alias, 1.0, 9.0);
            assert_eq!(array_get(&array, 1.0), 9.0);
            assert!(array_ptr_eq(&array, &alias));
            assert_eq!(array_unshift(&array, vec![-1.0, 0.0]), 4.0);
            assert_eq!(array_unshift_from(&array, &array), 8.0);
            assert_eq!(array_get(&array, 0.0), -1.0);
            assert_eq!(array_get(&array, 4.0), -1.0);
            let reversed = array_reverse(&array);
            assert!(array_ptr_eq(&array, &reversed));
            assert_eq!(array_get(&array, 0.0), 9.0);
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn array_ranges_follow_javascript_indices_and_preserve_reference_identity() {
        let baseline = live_heap_objects();
        {
            let values = array_new(vec![10.0, 20.0, 30.0, 40.0, 50.0]);
            let middle = array_slice(&values, -4.0, -2.0);
            assert_eq!(middle.with(|data| data.elements.clone()), vec![20.0, 30.0]);
            let fractional = array_slice(&values, 1.7, 3.2);
            assert_eq!(
                fractional.with(|data| data.elements.clone()),
                vec![20.0, 30.0]
            );

            let removed = array_splice(&values, -2.0, 1.8);
            assert_eq!(removed.with(|data| data.elements.clone()), vec![40.0]);
            assert_eq!(
                values.with(|data| data.elements.clone()),
                vec![10.0, 20.0, 30.0, 50.0]
            );
            assert_eq!(array_shift(&values), 10.0);
            assert_eq!(
                values.with(|data| data.elements.clone()),
                vec![20.0, 30.0, 50.0]
            );
            assert_eq!(array_len(&array_splice(&values, 0.0, f64::NAN)), 0.0);
            assert_eq!(array_len(&array_splice(&values, 1.0, f64::INFINITY)), 2.0);

            let child = array_new(vec![1.0]);
            let references = array_new(vec![child.clone(), child.clone()]);
            let copied = array_slice(&references, 0.0, 1.0);
            let moved = array_splice(&references, 0.0, 1.0);
            assert!(array_get(&copied, 0.0).ptr_eq(&child));
            assert!(array_get(&moved, 0.0).ptr_eq(&child));
            assert!(array_shift(&references).ptr_eq(&child));
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn array_copying_methods_preserve_sources_identity_and_range_errors() {
        let baseline = live_heap_objects();
        {
            let source = array_new(vec![1.0, 2.0, 3.0, 4.0]);
            let reversed = array_to_reversed(&source);
            assert_eq!(
                reversed.with(|data| data.elements.clone()),
                vec![4.0, 3.0, 2.0, 1.0]
            );
            assert_eq!(
                source.with(|data| data.elements.clone()),
                vec![1.0, 2.0, 3.0, 4.0]
            );

            let items = array_new(vec![8.0, 9.0]);
            let spliced = array_to_spliced(&source, 1.0, 2.0, &items);
            assert_eq!(
                spliced.with(|data| data.elements.clone()),
                vec![1.0, 8.0, 9.0, 4.0]
            );
            assert_eq!(
                array_to_spliced(&source, f64::NAN, 0.0, &array_new(vec![6.0]))
                    .with(|data| data.elements.clone()),
                vec![6.0, 1.0, 2.0, 3.0, 4.0]
            );

            assert_eq!(
                array_with(&source, -1.0, 9.0).with(|data| data.elements.clone()),
                vec![1.0, 2.0, 3.0, 9.0]
            );
            assert_eq!(
                array_with(&source, 1.9, 7.0).with(|data| data.elements.clone()),
                vec![1.0, 7.0, 3.0, 4.0]
            );
            assert_eq!(
                array_with(&source, f64::NAN, 6.0).with(|data| data.elements.clone()),
                vec![6.0, 2.0, 3.0, 4.0]
            );
            for (index, message) in [
                (4.0, "Invalid index : 4"),
                (-5.0, "Invalid index : -5"),
                (f64::INFINITY, "Invalid index : Infinity"),
            ] {
                let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    array_with(&source, index, 0.0)
                }))
                .err()
                .expect("an out-of-range Array.with index must throw");
                let caught = caught_from_panic(payload);
                assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
                assert_eq!(caught_error_message(&caught).as_ref(), message);
            }

            let first = array_new(vec![1.0]);
            let second = array_new(vec![2.0]);
            let references = array_new(vec![first.clone(), second.clone()]);
            let reversed_refs = array_to_reversed(&references);
            assert!(array_get(&reversed_refs, 0.0).ptr_eq(&second));
            let inserted = array_new(vec![3.0]);
            let spliced_refs =
                array_to_spliced(&references, 1.0, 0.0, &array_new(vec![inserted.clone()]));
            assert!(array_get(&spliced_refs, 0.0).ptr_eq(&first));
            assert!(array_get(&spliced_refs, 1.0).ptr_eq(&inserted));
            let replacement = array_new(vec![4.0]);
            let with_ref = array_with(&references, 0.0, replacement.clone());
            assert!(array_get(&with_ref, 0.0).ptr_eq(&replacement));
            assert!(array_get(&with_ref, 1.0).ptr_eq(&second));
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn captured_cells_share_mutations_and_trace_heap_values() {
        let baseline = live_heap_objects();
        {
            let number = cell_new(1.0);
            let alias = number.clone();
            cell_set(&alias, 9.0);
            assert_eq!(cell_get(&number), 9.0);

            let array = array_new(vec![2.0]);
            let captured = cell_new(array.clone());
            drop(array);
            assert_eq!(array_get(&cell_get(&captured), 0.0), 2.0);
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn tdz_reads_unwind_as_typed_catchable_reference_errors() {
        let cell = cell_empty::<JsString>();
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cell_get_tdz(&cell, "answer")
        }))
        .expect_err("an empty TDZ cell must unwind");
        let caught = caught_from_panic(payload);
        assert!(caught_is_error(&caught));
        assert_eq!(caught_error_name(&caught).as_ref(), "ReferenceError");
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "Cannot access 'answer' before initialization"
        );

        cell_set(&cell, string("ready"));
        assert_eq!(cell_get_tdz(&cell, "answer").as_ref(), "ready");
    }

    #[test]
    fn runtime_fences_unwind_as_catchable_coded_errors() {
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            throw_error_code("deferred construct".to_owned(), "SC1031")
        }))
        .expect_err("a runtime fence must unwind");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "Error");
        assert_eq!(caught_error_message(&caught).as_ref(), "deferred construct");
        assert_eq!(
            error_code(&caught_error_value(&caught)).unwrap().as_ref(),
            "SC1031"
        );
    }

    #[test]
    fn catch_conversion_rethrows_non_javascript_panics() {
        let payload = std::panic::catch_unwind(|| {
            std::panic::resume_unwind(Box::new("internal bug".to_owned()))
        })
        .expect_err("the synthetic internal panic must unwind");
        let propagated =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| caught_from_panic(payload)));
        assert!(propagated.is_err());
    }

    #[test]
    fn caught_primitive_values_narrow_and_stringify() {
        let number = caught_value(12.5_f64);
        assert!(caught_is::<f64>(&number));
        assert!(!caught_is::<bool>(&number));
        assert_eq!(caught_narrow::<f64>(&number), 12.5);
        assert_eq!(caught_to_string(&number).as_ref(), "12.5");

        let boolean = caught_value(true);
        assert!(caught_is::<bool>(&boolean));
        assert!(caught_narrow::<bool>(&boolean));
        assert_eq!(caught_to_string(&boolean).as_ref(), "true");

        let text = caught_value(string("reason"));
        assert!(caught_is::<JsString>(&text));
        assert_eq!(caught_narrow::<JsString>(&text).as_ref(), "reason");
        assert_eq!(caught_to_string(&text).as_ref(), "reason");

        let typed_error = error_new("TypeError", string("bad"));
        assert!(error_is_class(&typed_error, "TypeError"));
        assert!(error_is_class(&typed_error, "Error"));
        assert!(!error_is_class(&typed_error, "RangeError"));
        assert_eq!(error_to_string(&typed_error).as_ref(), "TypeError: bad");
        assert_eq!(error_to_string_parts("", "message").as_ref(), "message");
        assert_eq!(error_to_string_parts("Error", "").as_ref(), "Error");

        let error = caught_value(typed_error);
        assert_eq!(caught_to_string(&error).as_ref(), "TypeError: bad");
    }

    #[test]
    fn collector_breaks_self_and_mutual_cycles_without_unsafe() {
        let baseline = live_heap_objects();

        let self_cycle = Gc::new(Link { next: None });
        self_cycle.with_mut(|link| link.next = Some(self_cycle.clone()));
        drop(self_cycle);

        let left = Gc::new(Link { next: None });
        let right = Gc::new(Link { next: None });
        left.with_mut(|link| link.next = Some(right.clone()));
        right.with_mut(|link| link.next = Some(left.clone()));
        drop(left);
        drop(right);

        assert_eq!(live_heap_objects(), baseline + 3);
        assert_eq!(collect_cycles(), 3);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn collector_keeps_a_cycle_with_an_outside_owner() {
        let baseline = live_heap_objects();
        let rooted = Gc::new(Link { next: None });
        rooted.with_mut(|link| link.next = Some(rooted.clone()));

        let released_alias = rooted.clone();
        drop(released_alias);
        assert_eq!(collect_cycles(), 0);
        assert_eq!(live_heap_objects(), baseline + 1);

        drop(rooted);
        assert_eq!(collect_cycles(), 1);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promises_queue_reactions_and_settle_only_once() {
        let baseline = live_heap_objects();
        let promise = promise_new::<f64>();
        let events = Rc::new(RefCell::new(Vec::new()));

        let pending_events = events.clone();
        promise_then(
            &promise,
            Box::new(move |outcome| pending_events.borrow_mut().push(promise_unwrap(outcome))),
        );
        assert!(promise_fulfill(&promise, 7.0));
        assert!(!promise_fulfill(&promise, 9.0));
        assert!(events.borrow().is_empty());

        let settled_events = events.clone();
        promise_then(
            &promise,
            Box::new(move |outcome| settled_events.borrow_mut().push(promise_unwrap(outcome))),
        );
        run_event_loop();
        assert_eq!(events.borrow().as_slice(), &[7.0, 7.0]);

        let rejected = promise_new::<f64>();
        let rejected_events = events.clone();
        promise_then(
            &rejected,
            Box::new(move |outcome| match outcome {
                Ok(_) => panic!("scriptc: rejected promise fulfilled"),
                Err(reason) => rejected_events.borrow_mut().push(
                    if caught_error_name(&reason).as_ref() == "TypeError" {
                        -1.0
                    } else {
                        -2.0
                    },
                ),
            }),
        );
        promise_run_segment(&rejected, || throw_type_error("async failure".to_owned()));
        run_event_loop();
        assert_eq!(events.borrow().as_slice(), &[7.0, 7.0, -1.0]);

        drop(promise);
        drop(rejected);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_rejections_wait_for_handlers_until_the_microtask_checkpoint() {
        init();
        let baseline = live_heap_objects();

        let unhandled = promise_rejected::<f64>(caught_value(string("unhandled")));
        assert!(!had_unhandled_rejection());
        run_event_loop();
        assert!(had_unhandled_rejection());
        drop(unhandled);

        init();
        let handled = promise_rejected::<f64>(caught_value(string("handled")));
        let saw_rejection = Rc::new(Cell::new(false));
        let observed = saw_rejection.clone();
        promise_then(
            &handled,
            Box::new(move |outcome| observed.set(matches!(outcome, Err(_)))),
        );
        run_event_loop();
        assert!(saw_rejection.get());
        assert!(!had_unhandled_rejection());
        drop(handled);

        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_map_transforms_fulfillments_and_forwards_rejections() {
        let baseline = live_heap_objects();
        {
            let fulfilled = promise_resolved(2.0_f64);
            let mapped = promise_map(&fulfilled, |value| number_to_string(value * 3.0));
            let values = Rc::new(RefCell::new(Vec::new()));
            let observed = values.clone();
            promise_then(
                &mapped,
                Box::new(move |outcome| observed.borrow_mut().push(promise_unwrap(outcome))),
            );

            let rejected = promise_rejected::<f64>(caught_value(string("reason")));
            let forwarded = promise_map(&rejected, |value| value + 1.0);
            let saw_rejection = Rc::new(Cell::new(false));
            let observed_rejection = saw_rejection.clone();
            promise_then(
                &forwarded,
                Box::new(move |outcome| {
                    observed_rejection.set(matches!(outcome, Err(reason) if caught_to_string(&reason).as_ref() == "reason"));
                }),
            );

            run_event_loop();
            assert_eq!(values.borrow().as_slice(), &[string("6")]);
            assert!(saw_rejection.get());
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_from_sync_fulfills_values_and_converts_throws_to_rejections() {
        let baseline = live_heap_objects();
        {
            let fulfilled = promise_from_sync(|| 42.0_f64);
            let fulfilled_values = Rc::new(RefCell::new(Vec::new()));
            let observed_values = fulfilled_values.clone();
            promise_then(
                &fulfilled,
                Box::new(move |outcome| observed_values.borrow_mut().push(promise_unwrap(outcome))),
            );

            let rejected = promise_from_sync::<f64, _>(|| {
                throw_type_error("sync operation failed".to_owned())
            });
            let rejection = Rc::new(RefCell::new(None));
            let observed_rejection = rejection.clone();
            promise_then(
                &rejected,
                Box::new(move |outcome| {
                    if let Err(reason) = outcome {
                        *observed_rejection.borrow_mut() = Some(caught_to_string(&reason));
                    }
                }),
            );

            run_event_loop();
            assert_eq!(fulfilled_values.borrow().as_slice(), &[42.0]);
            assert_eq!(
                rejection.borrow().as_deref(),
                Some("TypeError: sync operation failed")
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_race_add_adapts_heterogeneous_fulfillments() {
        let baseline = live_heap_objects();
        {
            let result = promise_new::<JsString>();
            let number = promise_new::<f64>();
            let text = promise_new::<JsString>();
            promise_race_add(&result, &number, number_to_string);
            promise_race_add(&result, &text, |value| value);

            let values = Rc::new(RefCell::new(Vec::new()));
            let observed = values.clone();
            promise_then(
                &result,
                Box::new(move |outcome| observed.borrow_mut().push(promise_unwrap(outcome))),
            );

            assert!(promise_fulfill(&number, 7.0));
            assert!(promise_fulfill(&text, string("late")));
            run_event_loop();
            assert_eq!(values.borrow().as_slice(), &[string("7")]);
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_all_preserves_order_and_rejects_on_the_first_failure() {
        let baseline = live_heap_objects();
        {
            let first = promise_new::<f64>();
            let second = promise_new::<f64>();
            let entries = array_new(vec![first.clone(), second.clone()]);
            let combined = promise_all(&entries);
            let values = Rc::new(RefCell::new(Vec::new()));
            let observed = values.clone();
            promise_then(
                &combined,
                Box::new(move |outcome| {
                    let array = promise_unwrap(outcome);
                    observed
                        .borrow_mut()
                        .extend([array_get(&array, 0.0), array_get(&array, 1.0)]);
                }),
            );

            assert!(promise_fulfill(&second, 2.0));
            assert!(promise_fulfill(&first, 1.0));
            run_event_loop();
            assert_eq!(values.borrow().as_slice(), &[1.0, 2.0]);

            let rejected_entry = promise_new::<f64>();
            let ignored_entry = promise_new::<f64>();
            let rejected_entries = array_new(vec![rejected_entry.clone(), ignored_entry.clone()]);
            let rejected_all = promise_all(&rejected_entries);
            let rejected = Rc::new(Cell::new(false));
            let observed_rejection = rejected.clone();
            promise_then(
                &rejected_all,
                Box::new(move |outcome| {
                    observed_rejection.set(matches!(outcome, Err(reason)
                        if caught_error_name(&reason).as_ref() == "TypeError"));
                }),
            );
            promise_run_segment(&rejected_entry, || {
                throw_type_error("Promise.all failure".to_owned())
            });
            assert!(promise_fulfill(&ignored_entry, 9.0));
            run_event_loop();
            assert!(rejected.get());
        }
        assert_eq!(live_heap_objects(), baseline);
    }
}
