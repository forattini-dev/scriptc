#![forbid(unsafe_code)]

use chrono::{Datelike, Local, TimeZone, Timelike};
use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

mod symbols;
mod url_values;

pub use symbols::*;
pub use url_values::*;

static PROCESS_START: OnceLock<std::time::Instant> = OnceLock::new();

/// Owned JavaScript string handle for the static Rust heap.
///
/// `Rc` keeps aliasing explicit and thread-confined. Later heap object
/// families use the same owning-handle rule and add tracing for cycles.
pub type JsString = Rc<str>;

include!("regex.rs");
include!("clock_and_date.rs");
include!("heap.rs");
include!("live_refs.rs");
include!("diagnostics_channel.rs");
include!("async_local_storage.rs");
include!("process_signals.rs");
include!("event_loop.rs");
include!("promises.rs");
include!("stdin.rs");
include!("readline.rs");
include!("generators.rs");
include!("errors.rs");
include!("inspect.rs");
include!("assert_messages.rs");
include!("assert_shapes.rs");
include!("arrays.rs");
include!("bytes.rs");
include!("bytes_encoding.rs");
include!("zlib.rs");
include!("text_decoder.rs");
include!("crypto.rs");
include!("collections.rs");
include!("event_emitter.rs");
include!("readable.rs");
include!("writable.rs");
include!("duplex.rs");
include!("transform.rs");
include!("strings_and_process.rs");
include!("querystring.rs");
include!("os.rs");
include!("filesystem.rs");
include!("filesystem_dirent.rs");
include!("fs_watch.rs");
include!("child_process_and_paths.rs");
include!("child_stream.rs");
include!("child_process_async.rs");
include!("windows_paths.rs");
include!("json.rs");
include!("number_format.rs");
include!("numeric_ops.rs");
include!("network.rs");
include!("dgram.rs");
include!("http.rs");
include!("http_client.rs");
include!("http_agent.rs");
include!("tls_ca.rs");
include!("tls_client.rs");
include!("tls_socket.rs");
include!("tls_server.rs");
include!("util_parse_args.rs");

#[cfg(test)]
mod tests {
    use super::*;

    include!("tests/generators.rs");
    include!("tests/web_and_platform.rs");
    include!("tests/language_and_heap.rs");
    include!("tests/text_decoder.rs");
    include!("tests/windows_paths.rs");
    include!("tests/querystring.rs");
    include!("tests/zlib.rs");
    include!("tests/inspect.rs");
}
