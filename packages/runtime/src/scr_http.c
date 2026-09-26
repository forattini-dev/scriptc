/* node:http — the SERVER and CLIENT slices, layered on scr_net.c's
 * native hooks: a hand-written HTTP/1.1 parser (request OR status line,
 * headers, Content-Length / chunked / read-to-EOF bodies, keep-alive)
 * and Node-shaped serializers (the response's writeHead/setHeader/end
 * with Content-Length or chunked framing, the Date header, keep-alive
 * Connection headers; the client's request head with Node's exact
 * header order and framing decisions).
 *
 * The CLIENT (scr_http_request — http.request/http.get): one dialed
 * connection per request, NO agent pooling (the wire still carries
 * Node's Connection: keep-alive; the socket closes when the response
 * completes — SEMANTICS.md). The response is an ordinary ScrHttpReq
 * (IncomingMessage) parsed in RESPONSE mode: status line instead of
 * request line, and a body that may be EOF-delimited; HEAD/204/304
 * responses have none. Error shapes are Node's: the net layer's
 * 'connect ECONNREFUSED ip:port' via the socket's native error hook, a
 * premature close before any response is 'socket hang up' on the
 * request, and mid-body death is 'aborted' on the RESPONSE (the request
 * just closes) — all pinned by the client differential fixtures.
 * Deferred 'close' emits ride the emit QUEUE drained from scr_net.c's
 * proto sweep, so req/res 'close' fire a pass after the work that
 * flagged them, Node's later-than-the-handler ordering (client order:
 * res 'end', req 'close', res 'close').
 * NO external dependencies — the parser implements exactly what the
 * differential fixtures and portless-shaped handlers exercise, and
 * SEMANTICS.md states its bounds honestly.
 *
 * Object model: http.createServer returns an ORDINARY ScrNetServer (the
 * frontend maps http.Server to the same netServer kind — listen/close/
 * address()/error all reuse the net lowering) whose native-connection
 * hook installs one ScrHttpConn parser per accepted socket. ScrHttpReq /
 * ScrHttpRes are lean refcounted handles (the ScrChild story): the req
 * holds the parsed method/url/headers and the body listener lists
 * (dropped when the body completes or the connection dies); the res
 * holds the socket (+1), the pending header list, and the framing state.
 *
 * Keep-alive: HTTP/1.1 requests keep the connection open (1.0 opts in
 * with Connection: keep-alive) and the parser resets for the next
 * request on the same socket, pipelining included; Connection: close —
 * either side — ends the socket after the response finishes. There is NO
 * idle keep-alive timeout in this slice (Node reaps idle connections
 * after server.keepAliveTimeout, 5s — SEMANTICS.md); real clients close
 * their idle sockets and the fixtures' drivers do too.
 *
 * Event dispatch rides scr_net.c wholesale: the request handler and the
 * req 'data'/'end' listeners fire from the socket read path (macrotasks,
 * snapshot semantics, once-before-run), and errors/teardown follow the
 * socket's own story. */
#include "scr_runtime.h"

#include <ctype.h>
#include <math.h> /* INFINITY — the Agent's maxSockets default */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define SCR_HTTP_DEFAULT_MAX_HEADER_SIZE (16 * 1024)

static void scr_http_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static bool scr_http_timeout_valid(double ms) {
  if (isfinite(ms) && ms >= 0) return true;
  char recv[48], msg[176];
  scr_num_received(ms, recv);
  int len = snprintf(msg, sizeof msg,
                     "The value of \"msecs\" is out of range. It must be a non-negative finite number. Received %s", recv);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

/* Node v24.15.0's STATUS_CODES table, shared by the module export and the
 * default ServerResponse reason phrase. */
static const struct { int code; const char *reason; } scr_http_status_codes_table[] = {
  {100, "Continue"}, {101, "Switching Protocols"}, {102, "Processing"},
  {103, "Early Hints"}, {200, "OK"}, {201, "Created"}, {202, "Accepted"},
  {203, "Non-Authoritative Information"}, {204, "No Content"},
  {205, "Reset Content"}, {206, "Partial Content"}, {207, "Multi-Status"},
  {208, "Already Reported"}, {226, "IM Used"}, {300, "Multiple Choices"},
  {301, "Moved Permanently"}, {302, "Found"}, {303, "See Other"},
  {304, "Not Modified"}, {305, "Use Proxy"}, {307, "Temporary Redirect"},
  {308, "Permanent Redirect"}, {400, "Bad Request"}, {401, "Unauthorized"},
  {402, "Payment Required"}, {403, "Forbidden"}, {404, "Not Found"},
  {405, "Method Not Allowed"}, {406, "Not Acceptable"},
  {407, "Proxy Authentication Required"}, {408, "Request Timeout"},
  {409, "Conflict"}, {410, "Gone"}, {411, "Length Required"},
  {412, "Precondition Failed"}, {413, "Payload Too Large"},
  {414, "URI Too Long"}, {415, "Unsupported Media Type"},
  {416, "Range Not Satisfiable"}, {417, "Expectation Failed"},
  {418, "I'm a Teapot"}, {421, "Misdirected Request"},
  {422, "Unprocessable Entity"}, {423, "Locked"},
  {424, "Failed Dependency"}, {425, "Too Early"},
  {426, "Upgrade Required"}, {428, "Precondition Required"},
  {429, "Too Many Requests"}, {431, "Request Header Fields Too Large"},
  {451, "Unavailable For Legal Reasons"}, {500, "Internal Server Error"},
  {501, "Not Implemented"}, {502, "Bad Gateway"},
  {503, "Service Unavailable"}, {504, "Gateway Timeout"},
  {505, "HTTP Version Not Supported"}, {506, "Variant Also Negotiates"},
  {507, "Insufficient Storage"}, {508, "Loop Detected"},
  {509, "Bandwidth Limit Exceeded"}, {510, "Not Extended"},
  {511, "Network Authentication Required"},
};

static const char *scr_http_reason(int code) {
  for (size_t i = 0; i < sizeof scr_http_status_codes_table / sizeof scr_http_status_codes_table[0]; i++) {
    if (scr_http_status_codes_table[i].code == code) return scr_http_status_codes_table[i].reason;
  }
  return "unknown";
}

static ScrDyn *scr_http_status_codes_value;

static void scr_http_status_codes_cleanup(void) {
  scr_dyn_release(scr_http_status_codes_value);
  scr_http_status_codes_value = NULL;
}

ScrDyn *scr_http_status_codes(void) {
  if (!scr_http_status_codes_value) {
    ScrDyn *codes = scr_dyn_new_obj();
    for (size_t i = 0; i < sizeof scr_http_status_codes_table / sizeof scr_http_status_codes_table[0]; i++) {
      const int code = scr_http_status_codes_table[i].code;
      const char *reason = scr_http_status_codes_table[i].reason;
      char key[4];
      const int key_len = snprintf(key, sizeof key, "%d", code);
      ScrStr *value = scr_str_new(reason, strlen(reason));
      scr_dyn_obj_set(codes, key, (size_t)key_len, scr_dyn_new_str(value));
      scr_str_release(value);
    }
    scr_http_status_codes_value = codes;
    atexit(scr_http_status_codes_cleanup);
  }
  return scr_dyn_retain(scr_http_status_codes_value);
}

static const char *const scr_http_methods_table[] = {
  "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD",
  "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR",
  "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND",
  "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH",
  "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE",
};

static ScrArr *scr_http_methods_value;

static void scr_http_methods_cleanup(void) {
  scr_arr_release(scr_http_methods_value);
  scr_http_methods_value = NULL;
}

ScrArr *scr_http_methods(void) {
  if (!scr_http_methods_value) {
    const size_t n = sizeof scr_http_methods_table / sizeof scr_http_methods_table[0];
    ScrArr *methods = scr_arr_new(SCR_ELEM_STR, n);
    for (size_t i = 0; i < n; i++) {
      const char *name = scr_http_methods_table[i];
      scr_arr_push_ref(methods, scr_str_new(name, strlen(name)));
    }
    scr_http_methods_value = methods;
    atexit(scr_http_methods_cleanup);
  }
  return scr_arr_retain(scr_http_methods_value);
}

/* ── the h2 compat transport seam ────────────────────────────────────────
 *
 * Http2ServerRequest/Http2ServerResponse ARE these req/res handles: the
 * http/1 surface is the API template, the h2 stream machinery is the
 * transport. scr_http2.c (linked exactly when the program uses the real
 * h2 surface — this unit can link WITHOUT it) installs a vtable for the
 * response write paths (HEADERS/DATA frames instead of HTTP/1 bytes) and
 * a request-registration hook so server.on("request", ...) on an
 * h2-tagged server ctx routes to the h2 request list. The vtable's
 * typedef lives in scr_runtime.h (both units name it). */
static const ScrHttpH2Ops *scr_http_h2_ops = NULL;
static void (*scr_http_h2_request_hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                         void *fn, bool once) = NULL;
static void (*scr_http_h2_connect_hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                        void *h1_fn, void *h2_fn, bool once) = NULL;
static void (*scr_http_h2_upgrade_hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                        void *fn, bool once) = NULL;

void scr_http_set_h2_ops(const ScrHttpH2Ops *ops) { scr_http_h2_ops = ops; }

void scr_http_set_h2_request_hook(void (*hook)(void *h2ctx, ScrClosure *cb, void *fn, bool once)) {
  scr_http_h2_request_hook = hook;
}
void scr_http_set_h2_connect_hook(void (*hook)(void *h2ctx, ScrClosure *cb,
                                               void *h1_fn, void *h2_fn, bool once)) {
  scr_http_h2_connect_hook = hook;
}
void scr_http_set_h2_upgrade_hook(void (*hook)(void *h2ctx, ScrClosure *cb, void *fn, bool once)) {
  scr_http_h2_upgrade_hook = hook;
}

/* ── the request handle ──────────────────────────────────────────────── */

struct ScrHttpReq {
  size_t rc;
  int status;      /* -1 on server requests (Node's undefined statusCode) */
  ScrStr *method;
  ScrStr *url;
  ScrNetSocket *sock; /* +1 — req.socket, may be NULL defensively */
  void *h2_stream; /* +1 through scr_http_h2_ops — the h2 compat request's
                    * stream (destroy() RSTs it, never the shared socket) */
  ScrStr **hnames;  /* lowercased */
  ScrStr **hnames_raw; /* arrival case — rawHeaders */
  ScrStr **hvalues;
  size_t nheaders;
  ScrStr *status_msg; /* client responses' reason phrase; NULL on server requests */
  ScrNetLs data_ls, end_ls, err_ls, close_ls, timeout_ls;
  /* pipe destinations (req.pipe(...) — one of each kind, +1; released at
   * finish, so a piped destination never outlives the body) */
  ScrHttpRes *pipe_res;
  struct ScrHttpClientReq *pipe_client;
  ScrNetSocket *pipe_sock;
  bool ended; /* body complete (or connection dead): data/end drop */
  bool enc_utf8; /* setEncoding('utf8'): 'data' delivers strings */
  bool http10;   /* the parsed request/status line's version (httpVersion) */
  bool http2;    /* an h2 compat request (httpVersion "2.0") */
  bool aborted;  /* h2: the stream died with our writable side open */
  bool close_queued;
  bool close_emitted; /* settled: err/close listeners dropped */
  bool join_dup; /* joinDuplicateHeaders: repeated names read joined ", " */
  /* pause(): delivery holds — arrived body bytes buffer in pend (the
   * parser keeps consuming; memory is the buffer, a documented bound)
   * and 'end' defers (end_pending) until resume() drains through the
   * emit queue, never the resuming stack. */
  bool paused;
  bool end_pending;
  bool drain_queued;
  char *pend;
  size_t pend_len, pend_cap;
  bool destroyed; /* req.destroy()/the teardown ran — req.destroyed */
  ScrNetLs aborted_ls; /* req.on('aborted') — the h2 compat event */
};

#ifdef SCR_RC_AUDIT
static long scr_http_live = 0;
long scr_http_live_count(void) { return scr_http_live; }
#endif

ScrHttpReq *scr_http_req_retain(ScrHttpReq *r) {
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

/* req.setEncoding(enc) — IncomingMessage's readable setEncoding (server
 * requests and client responses alike): utf8 flips 'data' delivery to
 * strings (the chunk-encoding window); other REAL Node encodings meet
 * the loud not-supported ladder; unknown names throw Node's
 * ERR_UNKNOWN_ENCODING TypeError. */
void scr_http_req_set_encoding(ScrHttpReq *r, ScrStr *enc /*borrowed*/) {
  if ((enc->len == 4 && memcmp(enc->data, "utf8", 4) == 0) ||
      (enc->len == 5 && memcmp(enc->data, "utf-8", 5) == 0)) {
    r->enc_utf8 = true;
    return;
  }
  static const char *const known[] = { "ascii", "latin1", "binary", "base64",
    "base64url", "hex", "ucs2", "ucs-2", "utf16le", "utf-16le", NULL };
  for (size_t i = 0; known[i]; i++) {
    if (enc->len == strlen(known[i]) && memcmp(enc->data, known[i], enc->len) == 0) {
      char msg[128];
      int n = snprintf(msg, sizeof msg, "setEncoding('%s') is not supported yet (only 'utf8' here)",
                       known[i]);
      scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
      return;
    }
  }
  char msg[128];
  int n = snprintf(msg, sizeof msg, "Unknown encoding: %.*s",
                   (int)(enc->len < 64 ? enc->len : 64), enc->data);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_UNKNOWN_ENCODING");
}

void scr_http_req_release(ScrHttpReq *r) {
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    scr_str_release(r->method);
    scr_str_release(r->url);
    for (size_t i = 0; i < r->nheaders; i++) {
      scr_str_release(r->hnames[i]);
      scr_str_release(r->hnames_raw[i]);
      scr_str_release(r->hvalues[i]);
    }
    free(r->hnames);
    free(r->hnames_raw);
    free(r->hvalues);
    scr_str_release(r->status_msg);
    scr_net_ls_drop(&r->data_ls);
    scr_net_ls_drop(&r->end_ls);
    scr_net_ls_drop(&r->err_ls);
    scr_net_ls_drop(&r->close_ls);
    scr_net_ls_drop(&r->timeout_ls);
    scr_net_ls_drop(&r->aborted_ls);
    scr_http_res_release(r->pipe_res);
    scr_http_client_release(r->pipe_client);
    scr_net_sock_release(r->pipe_sock);
    free(r->pend);
    if (r->sock) scr_net_sock_release(r->sock);
    if (r->h2_stream) scr_http_h2_ops->release(r->h2_stream);
#ifdef SCR_RC_AUDIT
    scr_http_live--;
#endif
    free(r);
  }
}

void *scr_http_req_retain_v(void *p) { return scr_http_req_retain((ScrHttpReq *)p); }
void scr_http_req_release_v(void *p) { scr_http_req_release((ScrHttpReq *)p); }

ScrStr *scr_http_req_url(ScrHttpReq *r) { return scr_str_retain(r->url); }
ScrStr *scr_http_req_method(ScrHttpReq *r) { return scr_str_retain(r->method); }

/* Case-insensitive equality of HTTP field names. Incoming names happen to
 * be lowercased already; outgoing names retain the spelling of the setter. */
static bool scr_http_name_eq(const ScrStr *lower, const ScrStr *name) {
  if (lower->len != name->len) return false;
  for (size_t j = 0; j < name->len; j++) {
    if (tolower((unsigned char)lower->data[j]) != tolower((unsigned char)name->data[j])) return false;
  }
  return true;
}

/* The joined ", " value of every occurrence of hnames[i]'s name — the
 * joinDuplicateHeaders read (createServer option): Node joins repeats
 * where the default keeps the first. Always +1. */
static ScrStr *scr_http_req_joined_value(ScrHttpReq *r, size_t i) {
  size_t total = 0, count = 0;
  for (size_t k = 0; k < r->nheaders; k++) {
    if (scr_http_name_eq(r->hnames[k], r->hnames[i])) {
      total += r->hvalues[k]->len;
      count++;
    }
  }
  if (count == 1) return scr_str_retain(r->hvalues[i]);
  char *buf = malloc(total + (count - 1) * 2 + 1);
  if (!buf) scr_http_oom();
  size_t off = 0;
  for (size_t k = 0; k < r->nheaders; k++) {
    if (!scr_http_name_eq(r->hnames[k], r->hnames[i])) continue;
    if (off > 0) {
      memcpy(buf + off, ", ", 2);
      off += 2;
    }
    memcpy(buf + off, r->hvalues[k]->data, r->hvalues[k]->len);
    off += r->hvalues[k]->len;
  }
  ScrStr *out = scr_str_new(buf, off);
  free(buf);
  return out;
}

/* The snapshot pairs behind `{ ...req.headers }` (the record-building
 * helper's feed): [lowercased name, value, ...] in arrival order — the
 * same keys the per-name reads answer (under joinDuplicateHeaders a
 * repeated name appears once, at its first position, joined). Always a
 * fresh +1 array. */
ScrArr *scr_http_req_header_pairs(ScrHttpReq *r) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, r->nheaders * 2);
  for (size_t i = 0; i < r->nheaders; i++) {
    if (r->join_dup) {
      bool seen = false;
      for (size_t k = 0; k < i && !seen; k++) {
        seen = scr_http_name_eq(r->hnames[k], r->hnames[i]);
      }
      if (seen) continue;
      scr_arr_push_ref(out, scr_str_retain(r->hnames[i]));
      scr_arr_push_ref(out, scr_http_req_joined_value(r, i));
      continue;
    }
    scr_arr_push_ref(out, scr_str_retain(r->hnames[i]));
    scr_arr_push_ref(out, scr_str_retain(r->hvalues[i]));
  }
  return out;
}

/* req.rawHeaders: [name, value, name, value, ...] in arrival order, names
 * in their ORIGINAL case (Node's shape). Always a fresh +1 array. */
ScrArr *scr_http_req_raw_headers(ScrHttpReq *r) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, r->nheaders * 2);
  for (size_t i = 0; i < r->nheaders; i++) {
    scr_arr_push_ref(out, scr_str_retain(r->hnames_raw[i]));
    scr_arr_push_ref(out, scr_str_retain(r->hvalues[i]));
  }
  return out;
}

/* res.statusMessage: the reason phrase on client responses (+1, "" when
 * the status line carried none); NULL on server requests — the
 * compiler's undefined arm, the statusCode split. */
ScrStr *scr_http_req_status_message(ScrHttpReq *r) {
  return r->status_msg ? scr_str_retain(r->status_msg) : NULL;
}

/* Header lookup by (case-insensitively matched) name: +1 value, or NULL —
 * the compiler's undefined arm, exactly process.envGet's contract. */
ScrStr *scr_http_req_header(ScrHttpReq *r, ScrStr *name) {
  for (size_t i = 0; i < r->nheaders; i++) {
    if (scr_http_name_eq(r->hnames[i], name)) {
      /* joinDuplicateHeaders: every occurrence joins ", " (Node's option);
       * the default answers the first, Node's keep-first rule. */
      return r->join_dup ? scr_http_req_joined_value(r, i) : scr_str_retain(r->hvalues[i]);
    }
  }
  return NULL;
}

/* req.pipe(dest) — the proxy legs: an IncomingMessage body streams into
 * a ServerResponse, a ClientRequest, or a raw socket (chunk-for-chunk, no
 * backpressure — divergence 54's stream model); the body's natural end
 * ends the destination, Node's pipe default. A body that already ended
 * ends the destination NOW (nothing more will flow). */
void scr_http_req_pipe_res(ScrHttpReq *r, ScrHttpRes *dst /*borrowed*/) {
  if (r->ended) {
    scr_http_res_end(dst);
    return;
  }
  if (r->pipe_res) scr_http_res_release(r->pipe_res);
  r->pipe_res = scr_http_res_retain(dst);
}

/* socket.pipe(res) — the extended-CONNECT bridge leg: a native reader on
 * the SOURCE socket turns raw chunks into response body writes (the
 * response's own framing applies) and EOF into res.end(), pipe's
 * default. The ctx owns the response (+1, released with the socket's
 * native-reader teardown); errors/closes need no handling here — the
 * caller registers its own socket listeners (the portless cleanup). */
typedef struct {
  ScrHttpRes *res; /* +1 */
} ScrSockResPipe;

static void scr_http_sock_res_data(void *ctx, const char *buf, size_t n) {
  ScrSockResPipe *p = (ScrSockResPipe *)ctx;
  ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
  if (n > 0) memcpy(chunk->data, buf, n);
  scr_http_res_write_bytes(p->res, chunk);
  scr_bytes_release(chunk);
}

static void scr_http_sock_res_eof(void *ctx) {
  ScrSockResPipe *p = (ScrSockResPipe *)ctx;
  scr_http_res_end(p->res);
}

static void scr_http_sock_res_closed(void *ctx) { (void)ctx; }

static void scr_http_sock_res_free(void *ctx) {
  ScrSockResPipe *p = (ScrSockResPipe *)ctx;
  scr_http_res_release(p->res);
  free(p);
}

void scr_http_sock_pipe_res(ScrNetSocket *src, ScrHttpRes *dst /*borrowed*/) {
  ScrSockResPipe *p = calloc(1, sizeof *p);
  if (!p) scr_http_oom();
  p->res = scr_http_res_retain(dst);
  scr_net_sock_set_native_reader(src, &scr_http_sock_res_data, &scr_http_sock_res_eof,
                                  &scr_http_sock_res_closed, p, &scr_http_sock_res_free);
}

void scr_http_req_pipe_client(ScrHttpReq *r, ScrHttpClientReq *dst /*borrowed*/) {
  if (r->ended) {
    scr_http_client_end(dst);
    return;
  }
  if (r->pipe_client) scr_http_client_release(r->pipe_client);
  r->pipe_client = scr_http_client_retain(dst);
}

void scr_http_req_pipe_sock(ScrHttpReq *r, ScrNetSocket *dst /*borrowed*/) {
  if (r->ended) {
    scr_net_sock_end(dst);
    return;
  }
  if (r->pipe_sock) scr_net_sock_release(r->pipe_sock);
  r->pipe_sock = scr_net_sock_retain(dst);
}

void scr_http_req_on_data(ScrHttpReq *r, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once) {
  if (r->ended) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->data_ls, cb, (void *)fn, once);
}

void scr_http_req_on_end(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once) {
  if (r->ended) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->end_ls, cb, NULL, once);
}

double scr_http_req_status(ScrHttpReq *r) { return (double)r->status; }

ScrNetSocket *scr_http_req_socket(ScrHttpReq *r) {
  /* +1; a NULL socket cannot reach the program (every req is built over
   * a live connection), but stay defensive for the emitter's contract */
  return r->sock ? scr_net_sock_retain(r->sock) : NULL;
}

/* the deferred-emit queue lives below (the proto sweep) — resume()'s
 * drain rides it; the parser's deliver and the cork flush live below
 * their callers too */
static void scr_http_emit_push(int kind, void *h /*moves +1*/);
static void scr_http_req_deliver(ScrHttpReq *r, const char *data, size_t n);
static void scr_http_res_cork_flush(ScrHttpRes *r);
#define SCR_HTTP_EMIT_REQ_DRAIN_K 6

/* resume(): a flow-control no-op unless pause() held delivery — then the
 * buffered bytes (and a deferred 'end') drain through the emit queue,
 * never the resuming stack. This parser always consumes body bytes
 * (SEMANTICS.md; Node requires the stream to flow). */
void scr_http_req_resume(ScrHttpReq *r) {
  if (!r->paused) return;
  r->paused = false;
  if ((r->pend_len > 0 || r->end_pending) && !r->drain_queued) {
    r->drain_queued = true;
    scr_http_emit_push(SCR_HTTP_EMIT_REQ_DRAIN_K, scr_http_req_retain(r));
  }
}

/* pause(): delivery holds until resume() (scr_http_req_deliver buffers;
 * a completed body's 'end' waits too). */
void scr_http_req_pause(ScrHttpReq *r) {
  if (!r->ended) r->paused = true;
}

/* req.setTimeout(ms[, cb]): Node registers the callback on the message,
 * then arms the socket's idle timer. An incomplete server request can
 * handle the timeout and keep its connection alive. */
void scr_http_req_set_timeout(ScrHttpReq *r, double ms, ScrClosure *cb /*moves, nullable*/) {
  if (!scr_http_timeout_valid(ms)) {
    if (cb) scr_closure_release(cb);
    return;
  }
  if (r->ended || r->destroyed || r->close_emitted || !r->sock) {
    /* the message is done — Node no-ops there (never arms, never fires) */
    if (cb) scr_closure_release(cb);
    return;
  }
  scr_net_sock_set_timeout(r->sock, ms);
  if (cb) {
    if (r->status < 0 && !r->h2_stream) scr_net_ls_add(&r->timeout_ls, cb, NULL, false);
    else scr_net_sock_on_timeout(r->sock, cb, true);
  }
}

void scr_http_req_set_timeout_plain(ScrHttpReq *r, double ms) {
  scr_http_req_set_timeout(r, ms, NULL);
}

bool scr_http_req_destroyed_flag(ScrHttpReq *r) { return r->destroyed; }
bool scr_http_req_readable(ScrHttpReq *r) { return !r->ended && !r->destroyed; }
static void scr_http_req_finish(ScrHttpReq *r, bool fire);

static void scr_http_req_abort(ScrHttpReq *r) {
  if (r->ended || r->aborted) return;
  /* Reuse finish(false) to drop body listeners and pipe edges, then
   * preserve complete=false for the aborted message. */
  scr_http_req_finish(r, false);
  r->ended = false;
  r->aborted = true;
  scr_net_fire0_this(&r->aborted_ls, r, SCR_DYNH_HTTP_REQ);
  scr_net_ls_drop(&r->aborted_ls);
}

/* destroy(): tears the underlying connection down NOW; the teardown
 * events flow through the socket's native hooks like a peer close. */
void scr_http_req_destroy(ScrHttpReq *r) {
  r->destroyed = true;
  scr_http_req_abort(r);
  if (r->h2_stream != NULL) {
    scr_http_h2_ops->destroy(r->h2_stream);
    return;
  }
  if (r->sock) scr_net_sock_destroy(r->sock);
}

void scr_http_req_on_error(ScrHttpReq *r, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once) {
  if (r->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->err_ls, cb, (void *)fn, once);
}

void scr_http_req_on_close(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once) {
  if (r->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->close_ls, cb, NULL, once);
}

/* req.on('aborted') — the h2 compat event (an http/1 request registers
 * too; the parser lane never fires it, matching its 'error'-only story). */
void scr_http_req_on_aborted(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once) {
  if (r->close_emitted || r->aborted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->aborted_ls, cb, NULL, once);
}

/* Body completion: 'end' fires, then both listener lists drop (the
 * settle-releases-listeners story — a handler closure capturing its own
 * req cannot cycle past the body). */
static void scr_http_req_finish(ScrHttpReq *r, bool fire) {
  if (r->ended) return;
  if (fire && r->paused) {
    /* pause() holds 'end' too — resume()'s drain finishes the body */
    r->end_pending = true;
    return;
  }
  r->ended = true;
  if (fire) scr_net_fire0_this(&r->end_ls, r, SCR_DYNH_HTTP_REQ);
  scr_net_ls_drop(&r->data_ls);
  scr_net_ls_drop(&r->end_ls);
  /* pipes: a NATURAL end ends the destination (Node's pipe end:true
   * default); an aborted body just drops the edge — the destination's
   * own error/close story is already running */
  if (r->pipe_res) {
    if (fire) scr_http_res_end(r->pipe_res);
    scr_http_res_release(r->pipe_res);
    r->pipe_res = NULL;
  }
  if (r->pipe_client) {
    if (fire) scr_http_client_end(r->pipe_client);
    scr_http_client_release(r->pipe_client);
    r->pipe_client = NULL;
  }
  if (r->pipe_sock) {
    if (fire) scr_net_sock_end(r->pipe_sock);
    scr_net_sock_release(r->pipe_sock);
    r->pipe_sock = NULL;
  }
}

  bool removed_host;
  bool removed_connection;
  ScrHttpTrailers trailers;
