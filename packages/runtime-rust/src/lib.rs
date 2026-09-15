#![forbid(unsafe_code)]

use chrono::{Datelike, Local, TimeZone, Timelike};
use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

mod date_value;
pub use date_value::*;
mod bigint;
pub use bigint::*;

mod symbols;
mod url_values;

pub use symbols::*;
pub use url_values::*;

static PROCESS_START: OnceLock<std::time::Instant> = OnceLock::new();

mod js_string;
pub use js_string::{JsString, JsStringBuilder, JsStringSource, Utf16Units};

include!("regex.rs");
include!("clock_and_date.rs");
include!("date_components.rs");
include!("heap.rs");
include!("live_refs.rs");
include!("diagnostics_channel.rs");
include!("async_local_storage.rs");
include!("process_signals.rs");
include!("event_loop.rs");
include!("promises.rs");
include!("promise_views.rs");
include!("native_module.rs");
include!("stdin.rs");
include!("terminal.rs");
include!("readline.rs");
include!("generators.rs");
include!("errors.rs");
include!("ffi_callbacks.rs");
include!("ffi_foreign.rs");
#[cfg(all(feature = "island-eval", feature = "island-v8"))]
compile_error!("scriptc-runtime: island-eval (boa) and island-v8 are mutually exclusive island engines");
#[cfg(feature = "island-eval")]
include!("island_string.rs");
#[cfg(feature = "island-eval")]
include!("island_boundary.rs");
#[cfg(any(feature = "island-eval", feature = "island-v8"))]
include!("island_tables.rs");
#[cfg(feature = "island-eval")]
include!("island_modules.rs");
#[cfg(feature = "island-eval")]
include!("island_host.rs");
#[cfg(feature = "island-eval")]
include!("island_host_io.rs");
#[cfg(feature = "island-eval")]
include!("island_host_net.rs");
#[cfg(feature = "island-eval")]
include!("island_host_child.rs");
#[cfg(feature = "island-eval")]
include!("island_host_http.rs");
#[cfg(feature = "island-eval")]
include!("island_fetch.rs");
#[cfg(feature = "island-eval")]
include!("island_eval.rs");
#[cfg(feature = "island-eval")]
include!("island_host_functions.rs");
#[cfg(feature = "island-eval")]
include!("island_promise.rs");
#[cfg(feature = "sqlite")]
include!("sqlite.rs");
#[cfg(all(feature = "island-eval", feature = "sqlite"))]
include!("island_host_sqlite.rs");
#[cfg(feature = "island-v8")]
include!("v8_island.rs");
#[cfg(feature = "island-v8")]
include!("v8_host.rs");
#[cfg(feature = "island-v8")]
include!("v8_host_net.rs");
include!("inspect.rs");
include!("assert_messages.rs");
include!("assert_shapes.rs");
include!("arrays.rs");
include!("array_views.rs");
include!("bytes.rs");
include!("bytes_encoding.rs");
include!("zlib.rs");
include!("text_decoder.rs");
include!("md5.rs");
include!("crypto.rs");
include!("collections.rs");
include!("map_views.rs");
include!("event_emitter.rs");
include!("readable.rs");
include!("writable.rs");
include!("duplex.rs");
include!("transform.rs");
include!("strings_and_process.rs");
include!("string_utf16_ops.rs");
include!("number_parse.rs");
include!("target_config.rs");
include!("string_search.rs");
include!("querystring.rs");
include!("os.rs");
include!("filesystem.rs");
include!("filesystem_open_numeric.rs");
include!("filesystem_dirent.rs");
include!("filesystem_whole_file.rs");
include!("fs_watch.rs");
include!("assets.rs");
include!("child_process_and_paths.rs");
include!("child_stream.rs");
include!("child_process_async.rs");
include!("schema.rs");
include!("effect.rs");
include!("effect_payload.rs");
include!("effect_reference.rs");
include!("effect_iteration.rs");
include!("effect_failure.rs");
include!("effect_context.rs");
include!("effect_runners.rs");
include!("effect_latch.rs");
include!("effect_refs.rs");
include!("effect_state.rs");
include!("effect_pubsub.rs");
include!("windows_paths.rs");
include!("json.rs");
include!("number_format.rs");
include!("numeric_ops.rs");
include!("network_listener.rs");
include!("network.rs");
include!("dns.rs");
include!("dgram.rs");
include!("network_wait.rs");
include!("dgram_wait.rs");
include!("http_framing.rs");
include!("http.rs");
include!("http_request.rs");
include!("http_server.rs");
include!("http_client.rs");
include!("abort.rs");
include!("fetch.rs");
include!("fetch_reader.rs");
include!("web_stream.rs");
include!("web_stream_from.rs");
include!("http_agent.rs");
include!("tls_ca.rs");
include!("tls_client.rs");
include!("tls_socket.rs");
include!("tls_server.rs");
include!("util_parse_args.rs");

#[cfg(test)]
mod tests {
    use super::*;

    include!("tests/support.rs");
    include!("tests/target_config.rs");
    include!("tests/generators.rs");
    include!("tests/array_holes.rs");
    include!("tests/web_and_platform.rs");
    include!("numeric_ops.test.rs");
    include!("regex.test.rs");
    include!("tests/event_loop_order.rs");
    include!("tests/crypto.rs");
    include!("tests/language_and_heap.rs");
    include!("promise_views.test.rs");
    include!("promises.test.rs");
    include!("array_views.test.rs");
    include!("readline.test.rs");
    include!("tests/heap_pressure.rs");
    include!("effect_state.test.rs");
    include!("effect_iteration.test.rs");
    include!("effect_pubsub.test.rs");
    include!("effect_failure.test.rs");
    include!("effect_context.test.rs");
    include!("effect_runners.test.rs");
    include!("effect_reference.test.rs");
    include!("effect_payload.test.rs");
    include!("filesystem_open_numeric.test.rs");
    include!("filesystem_append.test.rs");
    include!("tests/text_decoder.rs");
    include!("tests/windows_paths.rs");
    include!("tests/querystring.rs");
    include!("tests/zlib.rs");
    include!("tests/inspect.rs");
    include!("tests/net_and_http.rs");
    include!("network.test.rs");
    include!("tests/http_framing.rs");
    include!("tests/fetch_reader.rs");
    include!("web_stream.test.rs");
    include!("web_stream_from.test.rs");
    include!("native_module.test.rs");
    include!("collections.test.rs");
    include!("map_views.test.rs");
    include!("tests/dgram.rs");
    include!("tests/child_process.rs");
    include!("tests/tls.rs");
    #[cfg(any(feature = "island-eval", feature = "island-v8"))]
    include!("island_import_eval.test.rs");
    #[cfg(feature = "island-eval")]
    include!("tests/island_modules.rs");
    #[cfg(feature = "island-eval")]
    include!("tests/island_boundary.rs");
}
