/* The island's node:http/node:https CLIENT ↔ the socket units — the one
 * translation unit referencing BOTH scr_http/scr_tls and the engine (the
 * scr_zlib_island.c precedent): cc.ts compiles it exactly when a
 * --dynamic build links the socket units, and the emitted main calls
 * scr_net_island_install before any island entry. Builds without it keep
 * the island's "does not provide the 'node:http' builtin" refusal.
 *
 * The shape is the native fetch bridge's, one level lower: the island's
 * http/https shims (scr_island.c's bootstrap) call host.httpStart with a
 * request description and a callbacks object; this unit runs ONE
 * ScrHttpClientReq per exchange over scr_net (+ the scr_tls client
 * transport for https, SNI/verify against the request hostname while the
 * socket dials the blocking-lookup answer), and minted runtime closures
 * feed status/headers/body/error events back into the engine from the
 * net dispatch station. No redirects, no decompression, no default
 * accept-* headers — node:http's client semantics, not fetch's; the wire
 * head is the static lane's (scr_http_client_send_head: user headers,
 * Host, Connection: keep-alive, the framing header), with the Host
 * header pre-filled here from the HOSTNAME because the dial target may
 * be a resolved IP.
 *
 * Ownership mirrors scr_fetch.c exactly: each exchange is refcounted —
 * the live registry holds +1 and every minted listener closure's box
 * holds +1; settling releases the engine callbacks object and the client
 * handle, and teardown (registered with the island) frees whatever is
 * still live before the engine goes down, so the island audit stays
 * zero. */
#ifdef SCR_DYNAMIC

#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

static void ni_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* ── exchanges ───────────────────────────────────────────────────────── */

typedef struct NiReq {
  size_t rc; /* the live registry's +1 plus one per minted listener box */
  int id;
  JSContext *ctx;
  JSValue cbs; /* { onResponse, onData, onEnd, onError, onResError,
                *   onTimeout, onClose } — owned while live */
  bool cbs_live;
  ScrHttpClientReq *client; /* +1 */
  bool responded;
  bool done; /* settled: no callback ever fires again */
  struct NiReq *next;
} NiReq;

static NiReq *ni_live = NULL; /* registry: +1 each */
static int ni_next_id = 1;

static NiReq *ni_retain(NiReq *t) {
  t->rc++;
  return t;
}

static void ni_release(NiReq *t) {
  if (--t->rc > 0) return;
  if (t->client) scr_http_client_release(t->client);
  if (t->cbs_live) JS_FreeValue(t->ctx, t->cbs);
  free(t);
}

static void *ni_retain_v(void *p) { return ni_retain((NiReq *)p); }
static void ni_release_v(void *p) { ni_release((NiReq *)p); }

/* Settle: drop the client, free the engine callbacks, leave the registry.
 * Idempotent. */
static void ni_settle(NiReq *t) {
  if (t->done) return;
  t->done = true;
  if (t->client) {
    scr_http_client_release(t->client);
    t->client = NULL;
  }
  if (t->cbs_live) {
    JS_FreeValue(t->ctx, t->cbs);
    t->cbs = JS_UNDEFINED;
    t->cbs_live = false;
  }
  for (NiReq **link = &ni_live; *link; link = &(*link)->next) {
    if (*link == t) {
      *link = t->next;
      ni_release(t); /* the registry's +1 */
      return;
    }
  }
}

static NiReq *ni_find(int id) {
  for (NiReq *t = ni_live; t; t = t->next) {
    if (t->id == id) return t;
  }
  return NULL;
}

/* Entered from the net dispatch station: re-anchor, call, swallow (but
 * report) engine exceptions — the callbacks are our own shim glue. */
static void ni_call(NiReq *t, const char *name, int argc, JSValueConst *argv) {
  if (!t->cbs_live) return;
  scr_island_host_enter();
  JSContext *ctx = t->ctx;
  JSValue fn = JS_GetPropertyStr(ctx, t->cbs, name);
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    JSValue e = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, e);
    fprintf(stderr, "scriptc: island http callback '%s' threw: %s\n", name, msg ? msg : "?");
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, e);
    return;
  }
  JS_FreeValue(ctx, r);
}

/* ── minted listener closures (caps[0] boxes the exchange) ───────────── */

static ScrClosure *ni_closure(NiReq *t, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(&ni_retain_v, &ni_release_v, NULL);
  scr_box_set_ref(box, ni_retain(t));
  cb->caps[0] = box;
  return cb;
}

static NiReq *ni_from(ScrClosure *cb) { return (NiReq *)scr_box_get_ref(cb->caps[0]); }

/* ── listener callbacks ──────────────────────────────────────────────── */

static void ni_on_data(ScrClosure *cb, ScrBytes *chunk /*borrowed*/) {
  NiReq *t = ni_from(cb);
  if (t == NULL) return;
  if (!t->done && chunk->len > 0) {
    JSValue u8 = JS_NewUint8ArrayCopy(t->ctx, chunk->data, chunk->len);
    ni_call(t, "onData", 1, (JSValueConst *)&u8);
    JS_FreeValue(t->ctx, u8);
  }
  ni_release(t);
}

static void ni_on_end(ScrClosure *cb) {
  NiReq *t = ni_from(cb);
  if (t == NULL) return;
  if (!t->done) ni_call(t, "onEnd", 0, NULL);
  ni_release(t);
}

/* Mid-body death: 'aborted' on the RESPONSE (Node's shape — the shim
 * emits it on the res). */
static void ni_on_res_error(ScrClosure *cb, ScrStr *msg /*borrowed*/) {
  NiReq *t = ni_from(cb);
  if (t == NULL) return;
  if (!t->done) {
    JSValue m = JS_NewStringLen(t->ctx, msg->data, msg->len);
    ni_call(t, "onResError", 1, (JSValueConst *)&m);
    JS_FreeValue(t->ctx, m);
  }
  ni_release(t);
}

static void ni_on_response(ScrClosure *cb, ScrHttpReq *res /*+1*/) {
  NiReq *t = ni_from(cb);
  if (t == NULL) {
    scr_http_req_release(res);
    return;
  }
  if (t->done) {
    scr_http_req_release(res);
    ni_release(t);
    return;
  }
  t->responded = true;
  JSContext *ctx = t->ctx;
  ScrArr *raw = scr_http_req_raw_headers(res);
  size_t nraw = (size_t)scr_arr_len(raw);
  JSValue hdrs = JS_NewArray(ctx);
  for (size_t i = 0; i < nraw; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(raw, (double)i);
    JS_SetPropertyUint32(ctx, hdrs, (uint32_t)i, JS_NewStringLen(ctx, s->data, s->len));
    scr_str_release(s);
  }
  scr_arr_release(raw);
  ScrStr *stext = scr_http_req_status_message(res);
  JSValue argv[3] = {
      JS_NewInt32(ctx, (int)scr_http_req_status(res)),
      JS_NewStringLen(ctx, stext ? stext->data : "", stext ? stext->len : 0),
      hdrs,
  };
  if (stext) scr_str_release(stext);
  ni_call(t, "onResponse", 3, argv);
  for (int i = 0; i < 3; i++) JS_FreeValue(ctx, argv[i]);
  /* body listeners, registered inside the 'response' emit (the parser
   * delivers body bytes only after this returns) */
  scr_http_req_on_data(res, ni_closure(t, (void *)&ni_on_data), &ni_on_data, false);
  scr_http_req_on_end(res, ni_closure(t, (void *)&ni_on_end), false);
  scr_http_req_on_error(res, ni_closure(t, (void *)&ni_on_res_error), &ni_on_res_error, false);
  scr_http_req_release(res);
  ni_release(t);
}

static void ni_on_client_error(ScrClosure *cb, ScrStr *msg /*borrowed*/) {
  NiReq *t = ni_from(cb);
  if (t == NULL) return;
  if (!t->done && !t->responded) {
    /* the net layer's message IS Node's ('connect ECONNREFUSED ip:port',
     * 'getaddrinfo ENOTFOUND host', 'socket hang up') — the shim shapes
     * the Error and derives the code. The exchange settles at the close
     * that always follows, so 'error' precedes 'close' like Node. */
    JSValue m = JS_NewStringLen(t->ctx, msg->data, msg->len);
    ni_call(t, "onError", 1, (JSValueConst *)&m);
    JS_FreeValue(t->ctx, m);
  }
  ni_release(t);
}

static void ni_on_timeout(ScrClosure *cb) {
  NiReq *t = ni_from(cb);
  if (t == NULL) return;
  if (!t->done) ni_call(t, "onTimeout", 0, NULL);
  ni_release(t);
}

/* The exchange's 'close' (deferred through the http emit queue — Node's
 * later-than-the-handler ordering: res 'end', req 'close', res 'close'). */
static void ni_on_close(ScrClosure *cb) {
  NiReq *t = ni_from(cb);
  if (t == NULL) return;
  ni_call(t, "onClose", 0, NULL); /* no-op once settled */
  ni_settle(t);
  ni_release(t);
}

/* ── host functions (called by the http shim, inside the engine) ─────── */

/* host.httpStart(secure, host, port, path, method, timeoutMs,
 * headersFlat, cbs) → id. The request head buffers until write/end
 * pushes bytes; the shim starts the exchange lazily at first write/end/
 * flushHeaders so setHeader-after-construction keeps working. */
static JSValue ni_host_start(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  if (argc < 8) return JS_ThrowTypeError(ctx, "httpStart: bad arity");
  bool secure = JS_ToBool(ctx, argv[0]) > 0;
  const char *host = JS_ToCString(ctx, argv[1]);
  if (!host) return JS_EXCEPTION;
  int32_t port = 0;
  JS_ToInt32(ctx, &port, argv[2]);
  const char *path = JS_ToCString(ctx, argv[3]);
  const char *method = JS_ToCString(ctx, argv[4]);
  double timeout_ms = 0;
  JS_ToFloat64(ctx, &timeout_ms, argv[5]);
  if (!path || !method) {
    JS_FreeCString(ctx, host);
    if (path) JS_FreeCString(ctx, path);
    if (method) JS_FreeCString(ctx, method);
    return JS_EXCEPTION;
  }

  ScrStr *hostname = scr_str_new(host, strlen(host));
  ScrStr *pathstr = scr_str_new(path, strlen(path));
  ScrStr *methodstr = scr_str_new(method, strlen(method));
  JS_FreeCString(ctx, host);
  JS_FreeCString(ctx, path);
  JS_FreeCString(ctx, method);

  /* user headers, plus Host from the HOSTNAME (the dial target below may
   * be a resolved IP; Node's rule — the default port stays off) */
  JSValue lenv = JS_GetPropertyStr(ctx, argv[6], "length");
  uint32_t hn = 0;
  JS_ToUint32(ctx, &hn, lenv);
  JS_FreeValue(ctx, lenv);
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, hn + 2);
  bool has_host = false;
  for (uint32_t i = 0; i + 1 < hn; i += 2) {
    JSValue nv = JS_GetPropertyUint32(ctx, argv[6], i);
    JSValue vv = JS_GetPropertyUint32(ctx, argv[6], i + 1);
    size_t nlen = 0, vlen = 0;
    const char *hname = JS_ToCStringLen(ctx, &nlen, nv);
    const char *hvalue = JS_ToCStringLen(ctx, &vlen, vv);
    if (hname && hvalue) {
      if (nlen == 4) {
        char l[4];
        for (int k = 0; k < 4; k++) l[k] = (char)(hname[k] | 0x20);
        if (memcmp(l, "host", 4) == 0) has_host = true;
      }
      scr_arr_push_ref(pairs, scr_str_new(hname, nlen));
      scr_arr_push_ref(pairs, scr_str_new(hvalue, vlen));
    }
    if (hname) JS_FreeCString(ctx, hname);
    if (hvalue) JS_FreeCString(ctx, hvalue);
    JS_FreeValue(ctx, nv);
    JS_FreeValue(ctx, vv);
  }
  int default_port = secure ? 443 : 80;
  if (!has_host) {
    char authority[300];
    int alen;
    bool v6 = memchr(hostname->data, ':', hostname->len) != NULL;
    if (port != default_port) {
      alen = snprintf(authority, sizeof authority, v6 ? "[%.*s]:%d" : "%.*s:%d",
                      (int)hostname->len, hostname->data, port);
    } else {
      alen = snprintf(authority, sizeof authority, v6 ? "[%.*s]" : "%.*s",
                      (int)hostname->len, hostname->data);
    }
    scr_arr_push_ref(pairs, scr_str_new("Host", 4));
    scr_arr_push_ref(pairs, scr_str_new(authority, (size_t)alen));
  }

  NiReq *t = calloc(1, sizeof *t);
  if (!t) ni_oom();
  t->rc = 1; /* the registry's */
  t->ctx = ctx;
  t->id = ni_next_id++;
  t->cbs = JS_DupValue(ctx, argv[7]);
  t->cbs_live = true;

  ScrStr *dial = scr_net_blocking_lookup(hostname);
  ScrHttpClientReq *c;
  if (secure) {
    void *cli = scr_tls_fetch_client_ctx(hostname, true);
    c = scr_http_request_ex(dial, (double)port, pathstr, methodstr, timeout_ms, pairs, false,
                             NULL, NULL, 443, &scr_tls_fetch_client_wrap, cli);
  } else {
    c = scr_http_request_ex(dial, (double)port, pathstr, methodstr, timeout_ms, pairs, false,
                             NULL, NULL, 80, NULL, NULL);
  }
  scr_str_release(dial);
  scr_str_release(hostname);
  scr_str_release(pathstr);
  scr_str_release(methodstr);
  scr_arr_release(pairs);

  t->client = c; /* the constructor's +1 */
  scr_http_client_on_response(c, ni_closure(t, (void *)&ni_on_response), &ni_on_response, true);
  scr_http_client_on_error(c, ni_closure(t, (void *)&ni_on_client_error), &ni_on_client_error, false);
  scr_http_client_on_timeout(c, ni_closure(t, (void *)&ni_on_timeout), false);
  scr_http_client_on_close(c, ni_closure(t, (void *)&ni_on_close), true);

  t->next = ni_live;
  ni_live = t;
  return JS_NewInt32(ctx, t->id);
}

/* host.httpWrite(id, u8) / host.httpEnd(id[, u8]) — body bytes. */
static JSValue ni_host_write(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiReq *t = ni_find(id);
  if (t == NULL || t->client == NULL) return JS_UNDEFINED;
  size_t blen = 0;
  uint8_t *bytes = JS_GetUint8Array(ctx, &blen, argv[1]);
  if (bytes != NULL && blen > 0) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)blen);
    memcpy(b->data, bytes, blen);
    scr_http_client_write_bytes(t->client, b);
    scr_bytes_release(b);
  }
  return JS_UNDEFINED;
}

static JSValue ni_host_end(JSContext *ctx, JSValueConst this_val, int argc,
                           JSValueConst *argv) {
  (void)this_val;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiReq *t = ni_find(id);
  if (t == NULL || t->client == NULL) return JS_UNDEFINED;
  if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
    size_t blen = 0;
    uint8_t *bytes = JS_GetUint8Array(ctx, &blen, argv[1]);
    if (bytes != NULL || blen == 0) {
      ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)blen);
      if (blen > 0) memcpy(b->data, bytes, blen);
      scr_http_client_end_bytes(t->client, b);
      scr_bytes_release(b);
      return JS_UNDEFINED;
    }
  }
  scr_http_client_end(t->client);
  return JS_UNDEFINED;
}

/* host.httpDestroy(id): tears the connection down NOW and lets the
 * natural teardown events flow — Node's destroy() mid-flight emits
 * 'socket hang up' then 'close' (oracle-pinned by the island-http
 * fixture), which is exactly the premature-close path scr_http.c
 * classifies; after a completed response the teardown is quiet. The
 * close event settles the exchange. */
static JSValue ni_host_destroy(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiReq *t = ni_find(id);
  if (t != NULL && t->client != NULL) scr_http_client_destroy(t->client);
  return JS_UNDEFINED;
}

/* host.httpSetTimeout(id, ms): the socket idle timer (0 disables). */
static JSValue ni_host_set_timeout(JSContext *ctx, JSValueConst this_val, int argc,
                                   JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  double ms = 0;
  JS_ToFloat64(ctx, &ms, argv[1]);
  NiReq *t = ni_find(id);
  if (t != NULL && t->client != NULL) scr_http_client_set_timeout(t->client, ms);
  return JS_UNDEFINED;
}

/* ══ the SERVER leg ═══════════════════════════════════════════════════
 *
 * The mirror image of the client above, and the reason express can serve
 * real traffic from inside the island: the island never owns a listening
 * socket: the COMPILED runtime does. `http.createServer(handler)` inside
 * the island mints an ordinary ScrNetServer here (scr_http.c's, the same
 * one the static lane serves from, so the wire bytes are the static
 * lane's oracle-pinned bytes), and every accepted request re-enters the
 * engine as one exchange.
 *
 * Two handle families, both on the client leg's ownership plan (a live
 * registry holding +1, one +1 per minted listener box, an idempotent
 * settle, a teardown that frees engine values before the runtime goes
 * down):
 *
 *   NiSrv   — one per createServer. Holds the ScrNetServer and the
 *             engine callbacks object { onRequest, onListening, onError,
 *             onClose }.
 *   NiExch  — one per accepted request. Holds the ScrHttpReq/ScrHttpRes
 *             pair and the per-exchange callbacks object { onData,
 *             onEnd, onAborted, onClose } that onRequest RETURNS.
 *
 * The returned-callbacks handshake is what lets the body listeners be
 * registered inside the 'request' emit (scr_http.c delivers body bytes
 * only after it returns) while still targeting the island objects the
 * handler just built — the client leg's ni_on_response ordering, one
 * direction over. */

typedef struct NiExch {
  size_t rc;
  int id;
  JSContext *ctx;
  JSValue cbs; /* { onData, onEnd, onAborted, onClose } — owned while live */
  bool cbs_live;
  ScrHttpReq *req; /* +1 */
  ScrHttpRes *res; /* +1 */
  bool done;
  struct NiExch *next;
} NiExch;

typedef struct NiSrv {
  size_t rc;
  int id;
  JSContext *ctx;
  JSValue cbs; /* { onRequest, onListening, onError, onClose } */
  bool cbs_live;
  ScrNetServer *srv; /* +1 */
  bool done;
  struct NiSrv *next;
} NiSrv;

static NiExch *nx_live = NULL;
static NiSrv *ns_live = NULL;
static int nx_next_id = 1;
static int ns_next_id = 1;

/* ── exchange lifetime ───────────────────────────────────────────────── */

static NiExch *nx_retain(NiExch *t) {
  t->rc++;
  return t;
}

static void nx_release(NiExch *t) {
  if (--t->rc > 0) return;
  if (t->req) scr_http_req_release(t->req);
  if (t->res) scr_http_res_release(t->res);
  if (t->cbs_live) JS_FreeValue(t->ctx, t->cbs);
  free(t);
}

static void *nx_retain_v(void *p) { return nx_retain((NiExch *)p); }
static void nx_release_v(void *p) { nx_release((NiExch *)p); }

static void nx_settle(NiExch *t) {
  if (t->done) return;
  t->done = true;
  if (t->req) {
    scr_http_req_release(t->req);
    t->req = NULL;
  }
  if (t->res) {
    scr_http_res_release(t->res);
    t->res = NULL;
  }
  if (t->cbs_live) {
    JS_FreeValue(t->ctx, t->cbs);
    t->cbs = JS_UNDEFINED;
    t->cbs_live = false;
  }
  for (NiExch **link = &nx_live; *link; link = &(*link)->next) {
    if (*link == t) {
      *link = t->next;
      nx_release(t); /* the registry's +1 */
      return;
    }
  }
}

static NiExch *nx_find(int id) {
  for (NiExch *t = nx_live; t; t = t->next) {
    if (t->id == id) return t;
  }
  return NULL;
}

static ScrClosure *nx_closure(NiExch *t, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(&nx_retain_v, &nx_release_v, NULL);
  scr_box_set_ref(box, nx_retain(t));
  cb->caps[0] = box;
  return cb;
}

static NiExch *nx_from(ScrClosure *cb) { return (NiExch *)scr_box_get_ref(cb->caps[0]); }

/* ── server lifetime ─────────────────────────────────────────────────── */

static NiSrv *ns_retain(NiSrv *s) {
  s->rc++;
  return s;
}

static void ns_release(NiSrv *s) {
  if (--s->rc > 0) return;
  if (s->srv) scr_net_server_release(s->srv);
  if (s->cbs_live) JS_FreeValue(s->ctx, s->cbs);
  free(s);
}

static void *ns_retain_v(void *p) { return ns_retain((NiSrv *)p); }
static void ns_release_v(void *p) { ns_release((NiSrv *)p); }

static void ns_settle(NiSrv *s) {
  if (s->done) return;
  s->done = true;
  if (s->srv) {
    scr_net_server_release(s->srv);
    s->srv = NULL;
  }
  if (s->cbs_live) {
    JS_FreeValue(s->ctx, s->cbs);
    s->cbs = JS_UNDEFINED;
    s->cbs_live = false;
  }
  for (NiSrv **link = &ns_live; *link; link = &(*link)->next) {
    if (*link == s) {
      *link = s->next;
      ns_release(s);
      return;
    }
  }
}

static NiSrv *ns_find(int id) {
  for (NiSrv *s = ns_live; s; s = s->next) {
    if (s->id == id) return s;
  }
  return NULL;
}

static ScrClosure *ns_closure(NiSrv *s, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(&ns_retain_v, &ns_release_v, NULL);
  scr_box_set_ref(box, ns_retain(s));
  cb->caps[0] = box;
  return cb;
}

static NiSrv *ns_from(ScrClosure *cb) { return (NiSrv *)scr_box_get_ref(cb->caps[0]); }

/* ni_call's twin that KEEPS the result: the 'request' emit needs the
 * per-exchange callbacks object the island builds for this request. */
static JSValue ni_call_r(JSContext *ctx, JSValue cbs, const char *name, int argc,
                         JSValueConst *argv) {
  scr_island_host_enter();
  JSValue fn = JS_GetPropertyStr(ctx, cbs, name);
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    JSValue e = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, e);
    JSValue st = JS_GetPropertyStr(ctx, e, "stack");
    const char *stack = JS_IsUndefined(st) ? NULL : JS_ToCString(ctx, st);
    fprintf(stderr, "scriptc: island http server callback '%s' threw: %s\n%s", name,
            msg ? msg : "?", stack ? stack : "");
    if (stack) JS_FreeCString(ctx, stack);
    JS_FreeValue(ctx, st);
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, e);
    return JS_UNDEFINED;
  }
  return r;
}

static void nx_call(NiExch *t, const char *name, int argc, JSValueConst *argv) {
  if (!t->cbs_live) return;
  JS_FreeValue(t->ctx, ni_call_r(t->ctx, t->cbs, name, argc, argv));
}

static void ns_call(NiSrv *s, const char *name, int argc, JSValueConst *argv) {
  if (!s->cbs_live) return;
  JS_FreeValue(s->ctx, ni_call_r(s->ctx, s->cbs, name, argc, argv));
}

/* ── request-body listeners (registered inside the 'request' emit) ────── */

static void nx_on_data(ScrClosure *cb, ScrBytes *chunk /*borrowed*/) {
  NiExch *t = nx_from(cb);
  if (t == NULL) return;
  if (!t->done && chunk->len > 0) {
    JSValue u8 = JS_NewUint8ArrayCopy(t->ctx, chunk->data, chunk->len);
    nx_call(t, "onData", 1, (JSValueConst *)&u8);
    JS_FreeValue(t->ctx, u8);
  }
  nx_release(t);
}

static void nx_on_end(ScrClosure *cb) {
  NiExch *t = nx_from(cb);
  if (t == NULL) return;
  if (!t->done) nx_call(t, "onEnd", 0, NULL);
  nx_release(t);
}

static void nx_on_aborted(ScrClosure *cb) {
  NiExch *t = nx_from(cb);
  if (t == NULL) return;
  if (!t->done) nx_call(t, "onAborted", 0, NULL);
  nx_release(t);
}

/* The response's 'close' settles the exchange: the island's res/req
 * objects have had every event they will get. */
static void nx_on_res_close(ScrClosure *cb) {
  NiExch *t = nx_from(cb);
  if (t == NULL) return;
  nx_call(t, "onClose", 0, NULL); /* no-op once settled */
  nx_settle(t);
  nx_release(t);
}

/* ── the 'request' emit ──────────────────────────────────────────────── */

static void ns_on_request(ScrClosure *cb, ScrHttpReq *req /*+1*/, ScrHttpRes *res /*+1*/) {
  NiSrv *s = ns_from(cb);
  if (s == NULL) {
    scr_http_req_release(req);
    scr_http_res_release(res);
    return;
  }
  if (s->done || !s->cbs_live) {
    scr_http_req_release(req);
    scr_http_res_release(res);
    ns_release(s);
    return;
  }
  JSContext *ctx = s->ctx;

  NiExch *t = calloc(1, sizeof *t);
  if (!t) ni_oom();
  t->rc = 1; /* the registry's */
  t->ctx = ctx;
  t->id = nx_next_id++;
  t->req = req; /* the emit's +1, moved in */
  t->res = res;
  t->cbs = JS_UNDEFINED;
  t->next = nx_live;
  nx_live = t;

  ScrArr *raw = scr_http_req_raw_headers(req);
  size_t nraw = raw ? (size_t)scr_arr_len(raw) : 0;
  JSValue hdrs = JS_NewArray(ctx);
  for (size_t i = 0; i < nraw; i++) {
    ScrStr *h = (ScrStr *)scr_arr_get_ref(raw, (double)i);
    JS_SetPropertyUint32(ctx, hdrs, (uint32_t)i, JS_NewStringLen(ctx, h->data, h->len));
    scr_str_release(h);
  }
  if (raw) scr_arr_release(raw);

  ScrStr *method = scr_http_req_method(req);
  ScrStr *url = scr_http_req_url(req);
  ScrNetSocket *sock = scr_http_req_socket(req);
  ScrStr *peer = sock ? scr_net_sock_remote_address(sock) : NULL;
  if (sock) scr_net_sock_release(sock);

  JSValue argv[7] = {
      JS_NewInt32(ctx, t->id),
      JS_NewStringLen(ctx, method ? method->data : "", method ? method->len : 0),
      JS_NewStringLen(ctx, url ? url->data : "", url ? url->len : 0),
      hdrs,
      JS_NewInt32(ctx, (int)scr_http_req_http_version_major(req)),
      JS_NewInt32(ctx, (int)scr_http_req_http_version_minor(req)),
      peer ? JS_NewStringLen(ctx, peer->data, peer->len) : JS_UNDEFINED,
  };
  if (method) scr_str_release(method);
  if (url) scr_str_release(url);
  if (peer) scr_str_release(peer);

  JSValue exch_cbs = ni_call_r(ctx, s->cbs, "onRequest", 7, argv);
  for (int i = 0; i < 7; i++) JS_FreeValue(ctx, argv[i]);

  if (JS_IsObject(exch_cbs)) {
    t->cbs = exch_cbs;
    t->cbs_live = true;
    /* Body listeners go in AFTER the handler ran (scr_http.c delivers
     * body bytes only once the emit returns) — the client leg's
     * ni_on_response ordering. */
    scr_http_req_on_data(req, nx_closure(t, (void *)&nx_on_data), &nx_on_data, false);
    scr_http_req_on_end(req, nx_closure(t, (void *)&nx_on_end), false);
    scr_http_req_on_aborted(req, nx_closure(t, (void *)&nx_on_aborted), false);
    scr_http_res_on_close(res, nx_closure(t, (void *)&nx_on_res_close), true);
  } else {
    /* The island refused the request (a throwing shim). Free the
     * exchange rather than leaking a half-built one; the response
     * handle's own teardown answers the client. */
    JS_FreeValue(ctx, exch_cbs);
    nx_settle(t);
  }
  ns_release(s);
}

static void ns_on_listening(ScrClosure *cb) {
  NiSrv *s = ns_from(cb);
  if (s == NULL) return;
  if (!s->done) ns_call(s, "onListening", 0, NULL);
  ns_release(s);
}

static void ns_on_error(ScrClosure *cb, ScrStr *msg /*borrowed*/) {
  NiSrv *s = ns_from(cb);
  if (s == NULL) return;
  if (!s->done) {
    JSValue m = JS_NewStringLen(s->ctx, msg->data, msg->len);
    ns_call(s, "onError", 1, (JSValueConst *)&m);
    JS_FreeValue(s->ctx, m);
  }
  ns_release(s);
}

static void ns_on_close(ScrClosure *cb) {
  NiSrv *s = ns_from(cb);
  if (s == NULL) return;
  ns_call(s, "onClose", 0, NULL);
  ns_settle(s);
  ns_release(s);
}

/* ── server host functions ───────────────────────────────────────────── */

/* host.srvCreate(cbs) → id. The listening socket is the COMPILED
 * runtime's from here on; the island only ever sees this integer. */
static JSValue ns_host_create(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv) {
  (void)this_val;
  if (argc < 1 || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "srvCreate: bad arity");
  NiSrv *s = calloc(1, sizeof *s);
  if (!s) ni_oom();
  s->rc = 1;
  s->ctx = ctx;
  s->id = ns_next_id++;
  s->cbs = JS_DupValue(ctx, argv[0]);
  s->cbs_live = true;
  s->srv = scr_http_create_server(NULL, NULL);
  s->next = ns_live;
  ns_live = s;
  scr_http_server_on_request(s->srv, ns_closure(s, (void *)&ns_on_request), &ns_on_request, false);
  scr_net_server_on_listening(s->srv, ns_closure(s, (void *)&ns_on_listening), false);
  scr_net_server_on_error(s->srv, ns_closure(s, (void *)&ns_on_error), &ns_on_error, false);
  scr_net_server_on_close(s->srv, ns_closure(s, (void *)&ns_on_close), true);
  return JS_NewInt32(ctx, s->id);
}

/* host.srvListen(id, port, host) — port 0 asks the kernel, and the bound
 * port is readable through srvPort once 'listening' has fired. */
static JSValue ns_host_listen(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv) {
  (void)this_val;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  double port = 0;
  JS_ToFloat64(ctx, &port, argv[1]);
  NiSrv *s = ns_find(id);
  if (s == NULL || s->srv == NULL) return JS_UNDEFINED;
  ScrStr *host = NULL;
  if (argc > 2 && JS_IsString(argv[2])) {
    size_t hlen = 0;
    const char *h = JS_ToCStringLen(ctx, &hlen, argv[2]);
    if (h) {
      host = scr_str_new(h, hlen);
      JS_FreeCString(ctx, h);
    }
  }
  if (host == NULL) host = scr_str_new("", 0);
  scr_net_listen_opts(s->srv, port, host, false, NULL);
  scr_str_release(host);
  return JS_UNDEFINED;
}

static JSValue ns_host_port(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiSrv *s = ns_find(id);
  if (s == NULL || s->srv == NULL) return JS_NewInt32(ctx, 0);
  return JS_NewInt32(ctx, (int)scr_net_server_port(s->srv));
}

/* host.srvAddress(id) → [ip, family] (the port rides srvPort). */
static JSValue ns_host_address(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiSrv *s = ns_find(id);
  JSValue out = JS_NewArray(ctx);
  if (s == NULL || s->srv == NULL) return out;
  ScrStr *ip = scr_net_server_addr_ip(s->srv);
  ScrStr *fam = scr_net_server_addr_family(s->srv);
  JS_SetPropertyUint32(ctx, out, 0, JS_NewStringLen(ctx, ip ? ip->data : "", ip ? ip->len : 0));
  JS_SetPropertyUint32(ctx, out, 1, JS_NewStringLen(ctx, fam ? fam->data : "", fam ? fam->len : 0));
  if (ip) scr_str_release(ip);
  if (fam) scr_str_release(fam);
  return out;
}

static JSValue ns_host_close(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiSrv *s = ns_find(id);
  if (s != NULL && s->srv != NULL) scr_net_server_close(s->srv, NULL);
  return JS_UNDEFINED;
}

/* ── response host functions ─────────────────────────────────────────── */

/* host.srvResHead(id, status, statusMessage|null, headersFlat): the
 * island's ServerResponse has finished composing its header store and
 * hands the whole block over at once. Serialization — Date, Connection,
 * the framing header, the status line — is scr_http.c's, which is what
 * makes the wire bytes the static lane's. */
static JSValue ns_host_res_head(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  if (argc < 4) return JS_UNDEFINED;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiExch *t = nx_find(id);
  if (t == NULL || t->res == NULL) return JS_UNDEFINED;
  double status = 200;
  JS_ToFloat64(ctx, &status, argv[1]);
  if (JS_IsString(argv[2])) {
    size_t mlen = 0;
    const char *m = JS_ToCStringLen(ctx, &mlen, argv[2]);
    if (m) {
      ScrStr *msg = scr_str_new(m, mlen);
      JS_FreeCString(ctx, m);
      scr_http_res_status_msg_set(t->res, msg);
      scr_str_release(msg);
    }
  }
  JSValue lenv = JS_GetPropertyStr(ctx, argv[3], "length");
  uint32_t hn = 0;
  JS_ToUint32(ctx, &hn, lenv);
  JS_FreeValue(ctx, lenv);
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, hn);
  for (uint32_t i = 0; i + 1 < hn; i += 2) {
    JSValue nv = JS_GetPropertyUint32(ctx, argv[3], i);
    JSValue vv = JS_GetPropertyUint32(ctx, argv[3], i + 1);
    size_t nlen = 0, vlen = 0;
    const char *hname = JS_ToCStringLen(ctx, &nlen, nv);
    const char *hvalue = JS_ToCStringLen(ctx, &vlen, vv);
    if (hname && hvalue) {
      scr_arr_push_ref(pairs, scr_str_new(hname, nlen));
      scr_arr_push_ref(pairs, scr_str_new(hvalue, vlen));
    }
    if (hname) JS_FreeCString(ctx, hname);
    if (hvalue) JS_FreeCString(ctx, hvalue);
    JS_FreeValue(ctx, nv);
    JS_FreeValue(ctx, vv);
  }
  scr_http_res_write_head_pairs(t->res, status, pairs);
  scr_arr_release(pairs);
  return JS_UNDEFINED;
}

static JSValue ns_host_res_write(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiExch *t = nx_find(id);
  if (t == NULL || t->res == NULL) return JS_UNDEFINED;
  size_t blen = 0;
  uint8_t *bytes = JS_GetUint8Array(ctx, &blen, argv[1]);
  if (bytes != NULL && blen > 0) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)blen);
    memcpy(b->data, bytes, blen);
    scr_http_res_write_bytes(t->res, b);
    scr_bytes_release(b);
  }
  return JS_UNDEFINED;
}

static JSValue ns_host_res_end(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiExch *t = nx_find(id);
  if (t == NULL || t->res == NULL) return JS_UNDEFINED;
  if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
    size_t blen = 0;
    uint8_t *bytes = JS_GetUint8Array(ctx, &blen, argv[1]);
    if (bytes != NULL || blen == 0) {
      ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)blen);
      if (blen > 0) memcpy(b->data, bytes, blen);
      scr_http_res_end_bytes(t->res, b);
      scr_bytes_release(b);
      return JS_UNDEFINED;
    }
  }
  scr_http_res_end(t->res);
  return JS_UNDEFINED;
}

static JSValue ns_host_res_destroy(JSContext *ctx, JSValueConst this_val, int argc,
                                   JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  NiExch *t = nx_find(id);
  if (t != NULL && t->res != NULL) scr_http_res_destroy(t->res);
  return JS_UNDEFINED;
}

/* ── attach / teardown (registered with the island) ──────────────────── */

static void ni_attach(void *jsctx, void *host_obj) {
  JSContext *ctx = (JSContext *)jsctx;
  JSValueConst host = *(JSValueConst *)host_obj;
  JS_SetPropertyStr(ctx, host, "httpStart", JS_NewCFunction(ctx, ni_host_start, "httpStart", 8));
  JS_SetPropertyStr(ctx, host, "httpWrite", JS_NewCFunction(ctx, ni_host_write, "httpWrite", 2));
  JS_SetPropertyStr(ctx, host, "httpEnd", JS_NewCFunction(ctx, ni_host_end, "httpEnd", 2));
  JS_SetPropertyStr(ctx, host, "httpDestroy", JS_NewCFunction(ctx, ni_host_destroy, "httpDestroy", 1));
  JS_SetPropertyStr(ctx, host, "httpSetTimeout", JS_NewCFunction(ctx, ni_host_set_timeout, "httpSetTimeout", 2));
  JS_SetPropertyStr(ctx, host, "srvCreate", JS_NewCFunction(ctx, ns_host_create, "srvCreate", 1));
  JS_SetPropertyStr(ctx, host, "srvListen", JS_NewCFunction(ctx, ns_host_listen, "srvListen", 3));
  JS_SetPropertyStr(ctx, host, "srvPort", JS_NewCFunction(ctx, ns_host_port, "srvPort", 1));
  JS_SetPropertyStr(ctx, host, "srvAddress", JS_NewCFunction(ctx, ns_host_address, "srvAddress", 1));
  JS_SetPropertyStr(ctx, host, "srvClose", JS_NewCFunction(ctx, ns_host_close, "srvClose", 1));
  JS_SetPropertyStr(ctx, host, "srvResHead", JS_NewCFunction(ctx, ns_host_res_head, "srvResHead", 4));
  JS_SetPropertyStr(ctx, host, "srvResWrite", JS_NewCFunction(ctx, ns_host_res_write, "srvResWrite", 2));
  JS_SetPropertyStr(ctx, host, "srvResEnd", JS_NewCFunction(ctx, ns_host_res_end, "srvResEnd", 2));
  JS_SetPropertyStr(ctx, host, "srvResDestroy", JS_NewCFunction(ctx, ns_host_res_destroy, "srvResDestroy", 1));
}

/* Exchanges still live at engine teardown free their engine values FIRST
 * so the island's counting allocator returns to zero (the net/http exit
 * cleanups — atexit LIFO, registered later so run earlier — have already
 * dropped the listener closures). */
static void ni_teardown(void) {
  while (ni_live) ni_settle(ni_live);
  while (nx_live) nx_settle(nx_live);
  while (ns_live) ns_settle(ns_live);
}

void scr_net_island_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  /* the loop hooks, exactly the fetch unit's reasoning: a graph whose
   * only socket user is the island's http client must still pump */
  scr_net_install();
  scr_island_set_netmod(&ni_attach, &ni_teardown);
}

#endif /* SCR_DYNAMIC */
