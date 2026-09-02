/* The dynamic island: an embedded QuickJS-ng engine, compiled and linked
 * ONLY under -DSCR_DYNAMIC (the --dynamic build mode). Static builds see an
 * empty translation unit — nothing here may leak into them.
 *
 * Model:
 * - ONE JSRuntime + JSContext per process, created lazily on the first
 *   island entry and torn down at exit BEFORE the RC audit (atexit is LIFO;
 *   scr_init registered the audit at startup, so a handler registered at
 *   first entry runs earlier). Teardown asserts the engine's live-allocation
 *   count is zero in the audit lane — the counting allocator passed to
 *   JS_NewRuntime2 is the leak oracle (Apple ASan has no LeakSanitizer on
 *   macOS arm64).
 * - NOT reentrant: island entry points must not be called from inside an
 *   engine callback (host function, finalizer). Single-threaded by design;
 *   there is no engine TLS, so migrating between ucontext fibers is safe
 *   BECAUSE every entry re-anchors the engine's stack-overflow check.
 * - Fiber safety: scriptc runs user code on fixed-size ucontext fibers
 *   (scr_async.c; 256KB, 1MB under ASan). The engine checks stack overflow
 *   against a stack top
 *   captured at runtime creation, so isl_entry() calls JS_UpdateStackTop on
 *   EVERY entry (unconditionally — it is cheap) and init budgets the stack
 *   well inside the fiber size (see ISL_STACK_BUDGET below for the ASan
 *   measurement). Skipping the re-anchor does not fail gracefully — it
 *   SIGBUSes.
 * - Ownership rules of the C API, encapsulated here so callers never see
 *   them: JS_SetPropertyStr CONSUMES its value; JS_GetPropertyStr returns
 *   OWNED; after any JS_IsException hit, JS_GetException must be called
 *   (owned; clears the pending state) or the next engine call misbehaves;
 *   JS_ToCStringLen pairs with JS_FreeCString; JS_NewStringLen takes UTF-8
 *   (ScrStr storage is UTF-8 — direct).
 */
#ifdef SCR_DYNAMIC

#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

#if defined(__APPLE__)
#include <malloc/malloc.h>
#define isl_malloc_size malloc_size
#elif defined(_WIN32)
#include <malloc.h>
/* The CRT's usable-size probe (vendored cutils.h makes the same choice);
 * _msize takes a non-const pointer, hence the cast. */
#define isl_malloc_size(p) _msize((void *)(p))
#else
#include <malloc.h>
#define isl_malloc_size malloc_usable_size
#endif

/* Engine stack budget FOR FIBER ENTRIES: HALF the fiber stack size
 * (scr_async.c SCR_FIBER_STACK), leaving the other half as margin for the
 * C excursion past the engine's last overflow check. Under ASan both
 * scale up together (8MB fibers, 4MB budget): measured on the
 * Debug+ASan engine, ONE function call costs 64–96KB of C stack and a
 * host→JS callback chain (Array.prototype.map + arrow) overruns even
 * 128KB — a small ASan budget cannot execute anything real, and a real
 * embedded graph entered from a fiber (a CLI action awaiting
 * generateText — zod parses inside promise chains) nests dozens of
 * engine frames. Entries from
 * the MAIN stack get ISL_MAIN_STACK_BUDGET instead (see isl_entry) —
 * embedded npm package call chains need more than a fiber can offer.
 * Overridable for experiments (-DSCR_ISLAND_STACK_BUDGET=...). */
#ifndef SCR_ISLAND_STACK_BUDGET
#if defined(__SANITIZE_ADDRESS__)
#define SCR_ISLAND_STACK_BUDGET (4 * 1024 * 1024)
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_ISLAND_STACK_BUDGET (4 * 1024 * 1024)
#endif
#endif
#endif
#ifndef SCR_ISLAND_STACK_BUDGET
#define SCR_ISLAND_STACK_BUDGET (128 * 1024)
#endif
#define ISL_STACK_BUDGET SCR_ISLAND_STACK_BUDGET

/* ── counting allocator (the leak oracle) ─────────────────────────────
 * Every engine allocation goes through these; live must return to zero
 * after JS_FreeRuntime or the engine (or our wrapper layer) leaked. */
static long isl_live_allocs = 0;

static void *isl_calloc(void *opaque, size_t count, size_t size) {
  (void)opaque;
  void *p = calloc(count, size);
  if (p) isl_live_allocs++;
  return p;
}
static void *isl_malloc(void *opaque, size_t size) {
  (void)opaque;
  void *p = malloc(size);
  if (p) isl_live_allocs++;
  return p;
}
static void isl_free(void *opaque, void *ptr) {
  (void)opaque;
  if (ptr) isl_live_allocs--;
  free(ptr);
}
static void *isl_realloc_fn(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  void *p = realloc(ptr, size);
  if (!ptr && p) isl_live_allocs++;
  return p;
}
static size_t isl_usable_size(const void *ptr) { return isl_malloc_size((void *)ptr); }

static const JSMallocFunctions isl_mf = {
    isl_calloc, isl_malloc, isl_free, isl_realloc_fn, isl_usable_size,
};

/* ── the one runtime/context ──────────────────────────────────────────── */

static JSRuntime *isl_rt = NULL;
static JSContext *isl_ctx = NULL;

/* ── embedded npm module tables (emitted static data) ─────────────────── */

static const ScrIslandModule *isl_mods = NULL;
static size_t isl_nmods = 0;
static const ScrIslandEdge *isl_edges = NULL;
static size_t isl_nedges = 0;

/* Compressed embedded module text (src_raw/esm_raw > 0: raw DEFLATE, the
 * emitter's size lever) inflates LAZILY at a module's first load and the
 * inflated copy caches for the process lifetime — like the engine's own
 * module cache, so the cost is once per loaded module and a module a run
 * never loads never inflates (its pages never even fault in). The
 * inflater is installed by the emitted main exactly when some module
 * compressed at build time (scr_zlib.c links on the same predicate). */
static bool (*isl_inflate)(const unsigned char *, size_t, unsigned char *, size_t) = NULL;
static char **isl_text_cache = NULL; /* 2 slots per module: src, esm */

void scr_island_set_inflate(bool (*inflate)(const unsigned char *src, size_t src_len,
                                            unsigned char *dst, size_t dst_len)) {
  isl_inflate = inflate;
}

void scr_island_modules(const ScrIslandModule *mods, size_t nmods,
                         const ScrIslandEdge *edges, size_t nedges) {
  isl_mods = mods;
  isl_nmods = nmods;
  isl_edges = edges;
  isl_nedges = nedges;
}

/* The module's SOURCE (esm=false) or ESM-facade (esm=true) text, inflating
 * a compressed embed on first use. NULL only on inflation failure (a
 * build/runtime mismatch — the caller throws). The returned text is
 * NUL-terminated either way (the emitter's plain strings are literals). */
static const char *isl_mod_text(const ScrIslandModule *m, bool esm, size_t *len_out) {
  const char *stored = esm ? m->esm : m->src;
  size_t stored_len = esm ? m->esm_len : m->len;
  size_t raw = esm ? m->esm_raw : m->src_raw;
  if (raw == 0) {
    *len_out = stored_len;
    return stored;
  }
  if (!isl_text_cache) {
    isl_text_cache = calloc(isl_nmods * 2, sizeof(char *));
    if (!isl_text_cache) return NULL;
  }
  char **slot = &isl_text_cache[(size_t)(m - isl_mods) * 2 + (esm ? 1 : 0)];
  if (!*slot) {
    char *text = malloc(raw + 1);
    if (!text) return NULL;
    if (!isl_inflate ||
        !isl_inflate((const unsigned char *)stored, stored_len, (unsigned char *)text, raw)) {
      free(text);
      return NULL;
    }
    text[raw] = '\0';
    *slot = text;
  }
  *len_out = raw;
  return *slot;
}

static const ScrIslandModule *isl_mod_find(const char *key) {
  for (size_t i = 0; i < isl_nmods; i++) {
    if (strcmp(isl_mods[i].key, key) == 0) return &isl_mods[i];
  }
  return NULL;
}

/* `want` is the LOOKUP's edge kind — the module loader asks with 1
 * (import), the require shim with 2 (require). A dual package (an
 * "exports" map whose "import" and "require" conditions name different
 * files) embeds two edges for one (from, spec); the kind picks Node's
 * entry for the call form. An import lookup missing its own kind falls
 * back to a require edge — a build-time-invisible import() of a spec the
 * file only require()s loads the CJS entry through its facade, which is
 * the module Node's require condition serves — but a require lookup
 * NEVER falls back: import-kind edges can target real ES modules or
 * throwing import traps, and the shim's MODULE_NOT_FOUND is the honest
 * answer for a require the build never resolved. */
static const char *isl_edge_find(const char *from, const char *spec, int want) {
  const char *fallback = NULL;
  for (size_t i = 0; i < isl_nedges; i++) {
    if (strcmp(isl_edges[i].from, from) != 0 || strcmp(isl_edges[i].spec, spec) != 0) continue;
    int kind = isl_edges[i].kind;
    if (kind == 0 || kind == want) return isl_edges[i].to;
    if (want == 1 && kind == 2) fallback = isl_edges[i].to;
  }
  return fallback;
}

/* Defined with the module system below; called from isl_init. */
static void isl_install_module_loader(void);
/* Defined with the host-function machinery below; called from isl_init. */
static void isl_register_hostfn_class(void);
/* Defined with the island → static promise bridge below; called from the
 * host-function registration (both classes register together). */
static void isl_register_bridge_class(void);
/* Defined with the loop-io machinery below; registered by isl_init. */
static bool isl_io_pending(void);
static void isl_io_poll(double max_wait_ms);

/* The fetch bridge's hooks (scr_fetch.c; linked only into fetch-using
 * builds). Registered by scr_fetch_install from the emitted main, BEFORE
 * the engine's lazy boot — isl_init consults them. The native bridge
 * registers boot/teardown only (its transfers ride scr_net sockets the
 * loop's poller sleeps on); the curl reference (scr_fetch_curl.c) also
 * registers pending/poll so the loop can sleep on curl's fds. */
static void (*isl_fetch_boot)(void *jsctx) = NULL;
static bool (*isl_fetch_pending)(void) = NULL;
static void (*isl_fetch_poll)(double max_wait_ms) = NULL;
static void (*isl_fetch_teardown)(void) = NULL;

void scr_island_set_fetch(void (*boot)(void *), bool (*pending)(void),
                           void (*poll)(double), void (*teardown)(void)) {
  isl_fetch_boot = boot;
  isl_fetch_pending = pending;
  isl_fetch_poll = poll;
  isl_fetch_teardown = teardown;
}

/* The node:http/https client bridge's hooks (scr_net_island.c; linked
 * only when the socket units are). `attach` adds the bridge's host
 * functions while the module bootstrap builds its host object;
 * `teardown` frees engine values in-flight exchanges still hold. */
static void (*isl_netmod_attach)(void *jsctx, void *host_obj) = NULL;
static void (*isl_netmod_teardown)(void) = NULL;

void scr_island_set_netmod(void (*attach)(void *jsctx, void *host_obj), void (*teardown)(void)) {
  isl_netmod_attach = attach;
  isl_netmod_teardown = teardown;
}

/* ── unhandled island rejections ──────────────────────────────────────
 * JS_SetHostPromiseRejectionTracker signals BOTH directions: is_handled ==
 * false when a promise rejects with no reaction attached (tracked here,
 * promise and reason retained), is_handled == true when a handler is
 * attached to it later (the rescission: unlinked and freed — a
 * handled-later rejection never reports). At the completed microtask
 * checkpoint the ledger joins scr_report_unhandled_rejections through
 * the hook registered at boot: the FIRST never-observed rejection prints
 * in the static runtime's exact voice ("Unhandled promise rejection:
 * <String(reason)>", stderr, exit 1 — an Error reason renders "name:
 * message" through its toString, same as the static ledger). Retaining
 * the promise value keeps its identity stable for the rescission (the
 * engine cannot recycle the object while the ledger holds it). */
typedef struct IslRejection {
  JSValue promise; /* owned; identity for the rescission */
  JSValue reason;  /* owned */
  struct IslRejection *next;
} IslRejection;

static IslRejection *isl_rejections = NULL; /* insertion order (append) */
static IslRejection **isl_rejections_tail = &isl_rejections;

static void isl_rejection_free(IslRejection *r) {
  JS_FreeValue(isl_ctx, r->promise);
  JS_FreeValue(isl_ctx, r->reason);
  free(r);
}

static void isl_rejections_drop_reason(JSValueConst reason);

static void isl_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                  JSValueConst reason, bool is_handled,
                                  void *opaque) {
  (void)ctx;
  (void)opaque;
  (void)promise;
  if (is_handled) {
    /* The rescission drops the handled promise's entry AND its same-reason
     * twins: a failing module loaded by an engine-internal dynamic import()
     * leaves the INTERMEDIATE per-module promises rejected-and-unhandled
     * (only the returned top promise gets the caller's handler, but every
     * promise in the load carries the same reason object) — Node reports a
     * handled import() rejection zero times, and the importDyn boundary
     * already drops by reason for exactly this shape. */
    isl_rejections_drop_reason(reason);
    return;
  }
  /* The WebAssembly stub's rejections never ledger: real wasm SUCCEEDS
   * unobserved, so a never-awaited compile/instantiate chain must stay
   * silent at teardown (es-module-lexer's top-level `init` chain) — the
   * marker rides the reason object through derived promises, and an
   * awaited stub still rejects into its awaiter untouched. */
  if (JS_IsObject(reason)) {
    JSValue marker = JS_GetPropertyStr(ctx, reason, "__scr_wasm_stub");
    bool is_stub = JS_ToBool(ctx, marker) > 0;
    JS_FreeValue(ctx, marker);
    if (is_stub) return;
  }
  IslRejection *r = malloc(sizeof *r);
  if (!r) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  r->promise = JS_DupValue(ctx, promise);
  r->reason = JS_DupValue(ctx, reason);
  r->next = NULL;
  *isl_rejections_tail = r;
  isl_rejections_tail = &r->next;
}

/* The report hook (scr_async.c calls it inside
 * scr_report_unhandled_rejections): print the first survivor when the
 * static ledger was silent, free the whole ledger either way. */
static bool isl_report_rejections(bool print) {
  if (isl_rejections == NULL) return false;
  if (print) {
    fflush(stdout);
    fputs("Unhandled promise rejection: ", stderr);
    const char *msg = JS_ToCString(isl_ctx, isl_rejections->reason);
    if (msg) {
      fputs(msg, stderr);
      JS_FreeCString(isl_ctx, msg);
    } else {
      /* String(reason) itself threw (a symbol): clear it, keep the same
       * fallback the static printer uses for unrenderable payloads. */
      JSValue second = JS_GetException(isl_ctx);
      JS_FreeValue(isl_ctx, second);
      fputs("[object]", stderr);
    }
    fputc('\n', stderr);
  }
  while (isl_rejections) {
    IslRejection *r = isl_rejections;
    isl_rejections = r->next;
    isl_rejection_free(r);
  }
  isl_rejections_tail = &isl_rejections;
  return true;
}

/* Prelude helper closures (one per SCR_JSOP_* plus the unary/indexing
 * helpers and the promise-bridge subscription), pinned at init so
 * operations on `any` values are JS_Call invocations of real JS operators
 * — coercion semantics (ToPrimitive, NaN, string +) come from the engine,
 * never from C reimplementations. ISL_H_THEN subscribes the island →
 * static promise bridge: Promise.resolve first, so thenables and plain
 * values behave exactly like `await` would treat them. */
enum {
  ISL_H_NEG = SCR_JSOP_COUNT,
  ISL_H_PLUS,
  ISL_H_TYPEOF,
  ISL_H_GETIDX,
  ISL_H_SETIDX,
  ISL_H_THEN,
  ISL_H_DESTRCHECK,
  ISL_H_ITERN,
  ISL_H_ITER,
  ISL_H_CALLSPREAD,
  ISL_H_OBJWALK,
  ISL_H_HASOWN,
  ISL_H_ASSIGN,
  ISL_H_ITERDRAIN,
  ISL_H_COUNT,
};

static JSValue isl_helpers[ISL_H_COUNT];

/* ISL_H_DESTRCHECK / ISL_H_ITERN are the destructuring guards: the check
 * throws V8's EXACT RequireObjectCoercible TypeError text ("Cannot
 * destructure 'a' as it is undefined.", the property form when the
 * pattern's first property is passed) and passes the value through;
 * iterN is GetIterator + the pattern's width as an array (V8's exact
 * not-iterable text), spec-shaped: done padding, IteratorClose when the
 * iterator is not exhausted. Both run IN the engine, so iterator
 * protocols, Proxies, and number formatting are the engine's own. */
static const char isl_prelude[] =
    "[(a,b)=>a+b,(a,b)=>a-b,(a,b)=>a*b,(a,b)=>a/b,(a,b)=>a%b,(a,b)=>a**b,"
    "(a,b)=>a<b,(a,b)=>a<=b,(a,b)=>a>b,(a,b)=>a>=b,(a,b)=>a===b,(a,b)=>a!==b,"
    "a=>-a,a=>+a,a=>typeof a,(o,k)=>o[k],(o,k,v)=>{o[k]=v},"
    "(p,f,r)=>{Promise.resolve(p).then(f,r)},"
    "(v,s,p)=>{if(v===undefined||v===null){const k=v===undefined?\"undefined\":\"null\";"
    "throw new TypeError(p===undefined?\"Cannot destructure '\"+s+\"' as it is \"+k+\".\""
    ":\"Cannot destructure property '\"+p+\"' of '\"+s+\"' as it is \"+k+\".\")}return v},"
    "(v,n)=>{if(v===undefined||v===null||typeof v[Symbol.iterator]!==\"function\"){"
    "let d;if(v===undefined)d=\"undefined\";else if(v===null)d=\"object null\";"
    "else if(typeof v===\"number\")d=\"number \"+v;else if(typeof v===\"boolean\")d=\"boolean \"+v;"
    "else if(typeof v===\"function\")d=\"function\";else d=\"object\";"
    "throw new TypeError(d+\" is not iterable (cannot read property Symbol(Symbol.iterator))\")}"
    "const o=[];const it=v[Symbol.iterator]();let dn=false;"
    "for(let i=0;i<n;i++){if(dn){o.push(void 0);continue}const r=it.next();"
    "if(r.done){dn=true;o.push(void 0)}else o.push(r.value)}"
    "if(!dn&&typeof it.return===\"function\")it.return();return o},"
    /* ISL_H_ITER: GetIterator alone (the for-of head over an island
     * value) — the same not-iterable TypeError text as iterN; the static
     * side drives next() through callMethod. */
    "v=>{if(v===undefined||v===null||typeof v[Symbol.iterator]!==\"function\"){"
    "let d;if(v===undefined)d=\"undefined\";else if(v===null)d=\"object null\";"
    "else if(typeof v===\"number\")d=\"number \"+v;else if(typeof v===\"boolean\")d=\"boolean \"+v;"
    "else if(typeof v===\"function\")d=\"function\";else d=\"object\";"
    "throw new TypeError(d+\" is not iterable (cannot read property Symbol(Symbol.iterator))\")}"
    "return v[Symbol.iterator]()},"
    /* ISL_H_CALLSPREAD: spread application (`f(...pre, ...s)` — the
     * rest-forwarding idiom's call): REAL spread syntax, so iterator
     * protocols are the engine's own; the guards front-run V8's exact
     * spread-call TypeError texts (nullish spells the spread expression
     * `w`, everything else the generic Spread-syntax text). */
    "(f,p,s,w)=>{if(s===undefined||s===null)"
    "throw new TypeError(w+\" is not iterable (cannot read property \"+s+\")\");"
    "if(typeof s[Symbol.iterator]!==\"function\")"
    "throw new TypeError(\"Spread syntax requires ...iterable[Symbol.iterator] to be a function\");"
    "return f(...p,...s)},"
    /* ISL_H_OBJWALK / ISL_H_HASOWN / ISL_H_ASSIGN: the Object statics a
     * wrapped (SCR_DYN_JSVAL) receiver routes here — the engine's own
     * semantics (own-key order, getters running, ToObject refusals). */
    "(o,m)=>m===0?Object.keys(o):m===1?Object.values(o):Object.entries(o),"
    "(o,k)=>Object.hasOwn(o,k),"
    "(t,s)=>Object.assign(t,s),"
    /* ISL_H_ITERDRAIN: the ENGINE's own iterator protocol drained into a
     * fresh array (for-of/destructuring/spread over a wrapped value —
     * generators, Maps, Sets, Symbol.iterator implementations all step
     * exactly as Node runs them). The guard front-runs the not-iterable
     * TypeError in the CALLER's wording: m=1 is V8's spread-call text,
     * s (when defined) the compile-time source spelling verbatim, else
     * the kind wording (iterN's). */
    "(v,m,s)=>{if(v===undefined||v===null||typeof v[Symbol.iterator]!==\"function\"){"
    "if(m===1)throw new TypeError(\"Spread syntax requires ...iterable[Symbol.iterator] to be a function\");"
    "if(s!==undefined)throw new TypeError(s);"
    "let d;if(v===undefined)d=\"undefined\";else if(v===null)d=\"object null\";"
    "else if(typeof v===\"number\")d=\"number \"+v;else if(typeof v===\"boolean\")d=\"boolean \"+v;"
    "else if(typeof v===\"function\")d=\"function\";else d=\"object\";"
    "throw new TypeError(d+\" is not iterable (cannot read property Symbol(Symbol.iterator))\")}"
    "const o=[];for(const x of v)o.push(x);return o}]";

static void isl_free_boot(void);
static void isl_prom_wraps_teardown(void);
static void isl_cells_teardown(void);

static void isl_teardown_at_exit(void) {
  if (!isl_rt) return;
  /* Promise-bridge wraps whose scriptc promise never settled still hold
   * the capability's settle functions (their waiter fibers are abandoned
   * — never unwound): freed like the fetch transfers below so the
   * counting allocator returns to zero. */
  isl_prom_wraps_teardown();
  /* Transfers still live at exit hold engine values (callback objects):
   * the fetch bridge frees them first so the counting allocator returns
   * to zero. */
  if (isl_fetch_teardown) isl_fetch_teardown();
  /* In-flight island http exchanges hold engine callback objects too —
   * the net bridge frees them the same way. */
  if (isl_netmod_teardown) isl_netmod_teardown();
  /* Unfired island timers (an AbortSignal.timeout that never mattered)
   * hold engine callbacks: freed like the fetch transfers above. */
  scr_island_timers_teardown();
  /* Armed static-heap timers may hold engine callbacks too (the island's
   * setTimeout/setInterval bridge): the loop only exits with entries
   * still armed on the uncaught/unhandled paths — release them before
   * the engine dies so the audit stays zero. */
  scr_timers_teardown();
  /* A ledger the report never consumed (an exit path that skips it) still
   * holds engine values: free them before the runtime goes down so the
   * counting allocator returns to zero. */
  while (isl_rejections) {
    IslRejection *r = isl_rejections;
    isl_rejections = r->next;
    isl_rejection_free(r);
  }
  isl_rejections_tail = &isl_rejections;
  /* Cells nothing will ever release (abandoned fibers' frames — a fiber
   * parked forever on a bridged package promise holds cells) still own
   * engine values: free the values (cells stay; a later release frees
   * only the block) so the runtime and the counting allocator go down
   * clean. LAST among the value-freeing steps — the ones above may
   * release cells, which unlinks them from this registry. */
  isl_cells_teardown();
  for (int i = 0; i < ISL_H_COUNT; i++) JS_FreeValue(isl_ctx, isl_helpers[i]);
  isl_free_boot();
  JS_FreeContext(isl_ctx);
  JS_FreeRuntime(isl_rt);
  isl_ctx = NULL;
  isl_rt = NULL;
  /* Inflated embedded sources (libc-heap, not engine allocations — the
   * audit never sees them): freed so a torn-down island leaves nothing. */
  if (isl_text_cache) {
    for (size_t i = 0; i < isl_nmods * 2; i++) free(isl_text_cache[i]);
    free(isl_text_cache);
    isl_text_cache = NULL;
  }
#ifdef SCR_RC_AUDIT
  if (isl_live_allocs != 0) {
    fflush(stdout);
    fprintf(stderr,
            "scriptc ISLAND AUDIT FAILED: %ld engine allocation(s) live "
            "after teardown\n",
            isl_live_allocs);
    _Exit(99);
  }
#endif
}

static void isl_init(void) {
  isl_rt = JS_NewRuntime2(&isl_mf, NULL);
  if (!isl_rt) {
    fprintf(stderr, "scriptc: island engine runtime allocation failed\n");
    abort();
  }
  JS_SetMaxStackSize(isl_rt, ISL_STACK_BUDGET);
  isl_ctx = JS_NewContext(isl_rt);
  if (!isl_ctx) {
    fprintf(stderr, "scriptc: island engine context allocation failed\n");
    abort();
  }
  JSValue arr = JS_Eval(isl_ctx, isl_prelude, sizeof isl_prelude - 1,
                        "<scr-prelude>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(arr)) {
    fprintf(stderr, "scriptc: island prelude failed to evaluate\n");
    abort();
  }
  for (uint32_t i = 0; i < ISL_H_COUNT; i++) {
    isl_helpers[i] = JS_GetPropertyUint32(isl_ctx, arr, i); /* owned */
  }
  JS_FreeValue(isl_ctx, arr);
  /* Web-platform globals (scr_web.c): BEFORE the module system boots —
   * embedded module evaluation may subclass TransformStream (eventsource-
   * parser does, at eval time). The fetch glue (installed by main in
   * fetch-using builds) boots right after: it builds on those globals. */
  scr_island_web_boot(isl_ctx);
  if (isl_fetch_boot) isl_fetch_boot(isl_ctx);
  /* The loop's io hook: engine promise jobs (and, in fetch-linked builds,
   * live transfers) drain at loop quiescence — island async chains
   * progress exactly where Node runs its microtasks. */
  scr_loop_set_io(isl_io_pending, isl_io_poll);
  /* Unhandled island rejections: tracked as they happen (and rescinded
   * when handled later), reported at the same completed microtask
   * checkpoint as the static promise ledger — one voice, exit 1, like
   * Node. The report hook drains engine jobs first so a same-checkpoint
   * handler attachment gets its chance to rescind. */
  JS_SetHostPromiseRejectionTracker(isl_rt, isl_rejection_tracker, NULL);
  scr_loop_set_island_rejections(isl_report_rejections,
                                 scr_island_drain_jobs);
  /* Armed island timers (AbortSignal.timeout) cap the loop's idle sleep
   * so they fire on time while the poller waits on socket readiness —
   * without keeping the loop alive by themselves (Node's unref'd timer).
   * The curl fetch bridge capped its own poll instead; the native bridge
   * has no poll of its own, so the loop must know the deadline. */
  scr_loop_set_island_deadline(&scr_island_timers_deadline);
  /* Module system: the loader callbacks are always installed (inert
   * without registered tables); the bootstrap (require shim, builtin
   * shims, the process bridge) evaluates only for npm-importing programs
   * — main registered their tables before any island entry. */
  isl_install_module_loader();
  /* Host-function class (closures entering the island): registered
   * eagerly — the id must exist before any from_closure call. */
  isl_register_hostfn_class();
  /* LIFO: registered after scr_init's handlers, so teardown runs before
   * the cycle collection + RC audit — the audit sees the engine gone. */
  atexit(isl_teardown_at_exit);
}

/* Nesting depth of host-function callbacks (scriptc closures invoked BY
 * the engine): while inside one, island entries from the SAME stack must
 * NOT re-anchor the stack top or resize the budget — moving them
 * mid-execution would misplace the engine's overflow check for the frames
 * still live above the callback. Entries from a DIFFERENT stack (an async
 * callback's eagerly-run fiber, or the promise-bridge waiter fiber) must
 * re-anchor — the engine has no frames on that stack, and checking its
 * stack pointers against the host stack's anchor is meaningless. The
 * host-call wrapper re-anchors to its own stack when the callback
 * returns (isl_hostfn_invoke). */
static int isl_host_depth = 0;

/* The engine's stack budget is sized PER STACK: entries from an async
 * fiber keep the tight fiber budget (ISL_STACK_BUDGET — half the fiber),
 * while entries from the MAIN stack get real headroom — the process main
 * stack is 8MB, and embedded npm package code (a commander parse) chains
 * enough engine frames to blow the fiber-sized budget, especially under
 * ASan's inflated frames. */
/* Under ASan a single engine call costs 64–96KB of C stack, and a real
 * package graph (the AI SDK's generateText: zod parses inside promise
 * chains inside commander actions) chains enough frames to exhaust 4MB —
 * "Maximum call stack size exceeded" mid-workflow. The process main stack
 * is 8MB: budget 6MB under ASan and keep the remaining 2MB (≈ twenty
 * ASan frames) as the excursion margin past the engine's last check. */
#if defined(__SANITIZE_ADDRESS__)
#define ISL_MAIN_STACK_BUDGET (6 * 1024 * 1024)
#elif defined(__has_feature) && __has_feature(address_sanitizer)
#define ISL_MAIN_STACK_BUDGET (6 * 1024 * 1024)
#else
#define ISL_MAIN_STACK_BUDGET (4 * 1024 * 1024)
#endif
static int isl_budget_is_fiber = -1; /* tri-state: unset/main/fiber */

/* Which stack the engine's overflow check is anchored to: the fiber's
 * identity, NULL for the main stack, or the initial sentinel. `strayed`
 * flags an anchor moved by a nested stack while a host call was live —
 * the wrapper restores on its way out. */
static void *isl_anchor_fiber = (void *)&isl_anchor_fiber;
static bool isl_anchor_strayed = false;

/* Anchor the overflow check to the CURRENT stack and size the budget for
 * it (fibers tight, main roomy). */
static void isl_anchor_here(void) {
  JS_UpdateStackTop(isl_rt);
  isl_anchor_fiber = scr_fiber_self();
  int fiber = isl_anchor_fiber != NULL;
  if (fiber != isl_budget_is_fiber) {
    JS_SetMaxStackSize(isl_rt, fiber ? ISL_STACK_BUDGET : ISL_MAIN_STACK_BUDGET);
    isl_budget_is_fiber = fiber;
  }
}

/* EVERY island entry funnels through here: lazy init, then re-anchor the
 * stack-overflow check to the CURRENT stack (main or any fiber) and size
 * the budget for it — except while the engine itself is calling back
 * into static code ON THIS STACK. */
static void isl_entry(void) {
  if (!isl_rt) isl_init();
  if (isl_host_depth > 0) {
    if (scr_fiber_self() == isl_anchor_fiber) return;
    isl_anchor_strayed = true;
  }
  isl_anchor_here();
}

/* The libregexp opaque for scr_regex.c in --dynamic builds. Static regexes
 * and the island share ONE libregexp: the archive's copy, whose host hooks
 * (quickjs.c's lre_realloc & co.) interpret the opaque as a JSContext —
 * scr_regex.c defining its own hooks would be a duplicate symbol. So a
 * regex-using --dynamic program routes regex compilation/execution through
 * the island's context, booting the engine lazily on first regex use. */
void *scr_island_lre_opaque(void) {
  isl_entry();
  return isl_ctx;
}

/* Units entering the engine from loop dispatch stations (the fetch
 * bridge's net callbacks fire from scr_net's dispatch, not through an
 * emitted island op) re-anchor through here — the every-entry rule. */
void scr_island_host_enter(void) { isl_entry(); }

/* ── the loop's io hook (engine jobs at quiescence) ───────────────────
 * Island promise jobs (a .then chain inside embedded package code) have no
 * fiber to park: the loop treats a non-empty engine job queue as pending
 * work and drains it between turns — the island's microtask checkpoint,
 * placed exactly where Node runs its own. Executed on the main stack;
 * isl_entry re-anchors the engine's overflow check first. */

int scr_island_drain_jobs(void) {
  if (!isl_rt) return 0;
  isl_entry();
  int n = 0;
  for (;;) {
    JSContext *jctx;
    int r = JS_ExecutePendingJob(isl_rt, &jctx);
    if (r == 0) break;
    if (r < 0) {
      /* A job the engine itself could not complete (promise reaction
       * throws reject their derived promise instead of landing here).
       * Node dies on an uncaught microtask exception; match it. */
      JSValue exc = JS_GetException(jctx);
      const char *msg = JS_ToCString(jctx, exc);
      fflush(stdout);
      fprintf(stderr, "Uncaught %s\n", msg ? msg : "island job exception");
      if (msg) JS_FreeCString(jctx, msg);
      JS_FreeValue(jctx, exc);
      _Exit(1);
    }
    n++;
  }
  return n;
}

static bool isl_io_pending(void) {
  if (isl_rt != NULL && JS_IsJobPending(isl_rt)) return true;
  /* A DUE island timer is pending work (fire it this turn); a merely
   * ARMED one is not — AbortSignal.timeout is unref'd like Node's and
   * must never keep the loop alive by itself. */
  if (isl_rt != NULL && scr_island_timers_due()) return true;
  return isl_fetch_pending != NULL && isl_fetch_pending();
}

static void isl_io_poll(double max_wait_ms) {
  /* Jobs first (they may start or settle transfers), then due island
   * timers (an AbortSignal.timeout firing aborts transfers and settles
   * promises — drain what it resolved), then the transfer poll — which
   * SLEEPS on curl's fds up to the loop's deadline CAPPED at the earliest
   * armed timer (a fetch timeout must fire on time mid-transfer), unless
   * this turn already made progress — then the jobs the arrived data (or
   * a timeout that elapsed during the sleep) resolved. */
  int ran = scr_island_drain_jobs();
  if (scr_island_timers_fire_due()) {
    ran += 1 + scr_island_drain_jobs();
  }
  if (isl_fetch_pending != NULL && isl_fetch_pending()) {
    double wait = ran > 0 ? 0 : max_wait_ms;
    double until = scr_island_timers_deadline() - scr_now_ms(); /* inf when none */
    if (until < 0) until = 0;
    if (until < wait) wait = until;
    isl_fetch_poll(wait);
    scr_island_drain_jobs();
    if (scr_island_timers_fire_due()) scr_island_drain_jobs();
  }
}

/* ── exception bridging ───────────────────────────────────────────────
 * Engine exception → catchable scriptc value through the pending cell
 * (scr_exception.c), so static try/catch works across the boundary.
 * Engine ERROR instances cross as real ScrError objects (name/message
 * extracted; the builtin vtable is picked by name, so `e instanceof
 * TypeError` narrows engine TypeErrors and custom names ride an
 * Error-rooted instance) — the uncaught line ("Uncaught TypeError: boom")
 * is byte-identical to the old String(e) form because toString rebuilds
 * exactly that shape. Non-Error throws keep the String(v) string payload. */

/* String(obj.prop) with a FALLBACK instead of recursion: a throwing getter
 * or unrepresentable value must not re-enter the bridge. Returns +1. */
static ScrStr *isl_prop_str(JSValueConst obj, const char *prop, const char *fallback) {
  JSValue v = JS_GetPropertyStr(isl_ctx, obj, prop);
  if (JS_IsException(v)) {
    JSValue second = JS_GetException(isl_ctx);
    JS_FreeValue(isl_ctx, second);
    return scr_str_new(fallback, strlen(fallback));
  }
  size_t len;
  const char *cs = JS_ToCStringLen(isl_ctx, &len, v);
  JS_FreeValue(isl_ctx, v);
  if (!cs) {
    JSValue second = JS_GetException(isl_ctx);
    JS_FreeValue(isl_ctx, second);
    return scr_str_new(fallback, strlen(fallback));
  }
  ScrStr *s = scr_str_new(cs, len);
  JS_FreeCString(isl_ctx, cs);
  return s;
}

/* Engine VALUE → pending scriptc exception. Borrows `exc`. The one
 * conversion both bridge directions' reasons ride: thrown engine
 * exceptions (below) and rejected engine promises crossing through the
 * promise bridge (isl_bridge_settle). */
static void isl_throw_reason(JSValueConst exc) {
  if (JS_IsError(exc)) {
    scr_throw_error_named(isl_prop_str(exc, "name", "Error"),
                           isl_prop_str(exc, "message", ""));
    return;
  }
  size_t len;
  const char *msg = JS_ToCStringLen(isl_ctx, &len, exc);
  if (msg) {
    scr_throw_str(scr_str_new(msg, len));
    JS_FreeCString(isl_ctx, msg);
  } else {
    /* ToString itself threw (e.g. a symbol): clear that too, keep a
     * deterministic message. */
    JSValue second = JS_GetException(isl_ctx);
    JS_FreeValue(isl_ctx, second);
    const char msg2[] = "Error: unrepresentable island exception";
    scr_throw_str(scr_str_new(msg2, sizeof msg2 - 1));
  }
}

static void isl_bridge_exception(void) {
  JSValue exc = JS_GetException(isl_ctx); /* owned; clears engine pending */
  isl_throw_reason(exc);
  JS_FreeValue(isl_ctx, exc);
}

/* Exported for the island timer bridge (scr_web.c): a throwing engine
 * timer callback becomes the pending scriptc exception, so the loop's
 * uncaught path reports it exactly like a static timer callback's throw. */
void scr_island_bridge_exception(void) { isl_bridge_exception(); }

/* ── marshal helpers ──────────────────────────────────────────────────
 * The out-of-engine direction of the value boundary, with the engine's
 * ownership rules folded in — shared by scr_island_eval and the jsval
 * operation surface below. */

/* Engine value → f64 (ToNumber). Borrows v. False = the conversion threw;
 * the exception is already bridged into the scriptc pending cell. */
static bool isl_js_to_f64(JSValueConst v, double *out) {
  if (JS_ToFloat64(isl_ctx, out, v)) {
    isl_bridge_exception();
    return false;
  }
  return true;
}

/* Engine value → bool (ToBoolean; never throws). Borrows v. */
static bool isl_js_to_bool(JSValueConst v) { return JS_ToBool(isl_ctx, v) > 0; }

/* Engine value → ScrStr via String(v), UTF-8 out. Borrows v. Returns +1,
 * or NULL after bridging the exception ToString raised (symbols). */
static ScrStr *isl_js_to_str(JSValueConst v) {
  size_t len;
  const char *cs = JS_ToCStringLen(isl_ctx, &len, v);
  if (!cs) {
    isl_bridge_exception();
    return NULL;
  }
  ScrStr *s = scr_str_new(cs, len);
  JS_FreeCString(isl_ctx, cs);
  return s;
}

/* ── eval (the __island_eval intrinsic) ───────────────────────────────
 * Evaluate UTF-8 source in the island's global scope and return
 * String(result) as a scriptc string (+1). Borrows code. On an island
 * exception: bridges it (catchable via the pending cell) and returns NULL —
 * callers are compiler-emitted pending checks, like the fs.* surface. */
ScrStr *scr_island_eval(ScrStr *code) {
  isl_entry();
  JSValue r = JS_Eval(isl_ctx, code->data, code->len, "<island>",
                      JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  ScrStr *s;
  if (JS_IsNumber(r)) {
    /* Through the f64 marshal + the runtime's JS-exact formatter, keeping
     * number rendering identical to the static world's String(). */
    double d;
    if (!isl_js_to_f64(r, &d)) {
      JS_FreeValue(isl_ctx, r);
      return NULL;
    }
    s = scr_f64_to_scrstr(d);
  } else if (JS_IsBool(r)) {
    s = scr_bool_to_scrstr(isl_js_to_bool(r));
  } else {
    s = isl_js_to_str(r); /* NULL = bridged (e.g. a symbol result) */
  }
  JS_FreeValue(isl_ctx, r);
  return s;
}

/* ── ScrJsval: the refcounted cell behind the `any` static type ───────
 * Owns exactly one engine value. Not cycle-collector-traced: its internal
 * references live in the engine's GC world (cross-boundary cycles are the
 * documented uncollectable case). After engine teardown a release frees
 * only the cell — the engine already freed every value it owned, so the
 * counting allocator stays exact and nothing dangles.
 *
 * Live cells thread a registry (isl_cells) so teardown can free the
 * engine value of every cell nothing will ever release — an ABANDONED
 * fiber's frame holds cells (a fiber parked forever on a bridged package
 * promise holds at least the promise's own cell), and its stack is
 * deliberately not unwound. Without the walk those engine values leak
 * past JS_FreeRuntime, which the debug engine asserts on. */

struct ScrJsval {
  size_t rc;
  JSValue v;
  struct ScrJsval *cells_prev, *cells_next;
};

static ScrJsval *isl_cells = NULL;

static void isl_cell_unlink(ScrJsval *c) {
  if (c->cells_prev) c->cells_prev->cells_next = c->cells_next;
  else if (isl_cells == c) isl_cells = c->cells_next;
  if (c->cells_next) c->cells_next->cells_prev = c->cells_prev;
  c->cells_prev = c->cells_next = NULL;
}

/* Teardown half: free the engine value of every still-live cell. Pop from
 * the head each time — freeing a value can cascade (an engine finalizer
 * releasing a closure whose captures hold OTHER cells), and the cascade
 * unlinks from this same list. The popped cell's value is cleared BEFORE
 * the free, so a cascade releasing the cell itself (or a later post-
 * teardown release) frees only the malloc block. */
static void isl_cells_teardown(void) {
  while (isl_cells) {
    ScrJsval *c = isl_cells;
    isl_cell_unlink(c);
    JSValue v = c->v;
    c->v = JS_UNDEFINED;
    JS_FreeValue(isl_ctx, v);
  }
}

#ifdef SCR_RC_AUDIT
static long isl_live_jsvals = 0;
long scr_jsval_live_count(void) { return isl_live_jsvals; }
#endif

/* Fresh cell taking ownership of an engine value (+1 cell out). */
static ScrJsval *isl_cell_new(JSValue v) {
  ScrJsval *c = malloc(sizeof *c);
  if (!c) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  c->rc = 1;
  c->v = v;
  c->cells_prev = NULL;
  c->cells_next = isl_cells;
  if (isl_cells) isl_cells->cells_prev = c;
  isl_cells = c;
#ifdef SCR_RC_AUDIT
  isl_live_jsvals++;
#endif
  return c;
}

ScrJsval *scr_jsval_retain(ScrJsval *v) {
  if (v) v->rc++;
  return v;
}

void scr_jsval_release(ScrJsval *v) {
  if (!v) return;
  if (--v->rc == 0) {
    if (isl_rt) {
      isl_cell_unlink(v);
      JS_FreeValue(isl_ctx, v->v);
    }
    /* Post-teardown: the registry walk already freed the value (and
     * cleared the links) — only the cell block remains. */
#ifdef SCR_RC_AUDIT
    isl_live_jsvals--;
#endif
    free(v);
  }
}

void *scr_jsval_retain_v(void *v) { return scr_jsval_retain(v); }
void scr_jsval_release_v(void *v) { scr_jsval_release(v); }

/* ── marshal in ─────────────────────────────────────────────────────── */

ScrJsval *scr_jsval_from_f64(double v) {
  isl_entry();
  return isl_cell_new(JS_NewFloat64(isl_ctx, v));
}

ScrJsval *scr_jsval_from_bool(bool v) {
  isl_entry();
  return isl_cell_new(JS_NewBool(isl_ctx, v));
}

ScrJsval *scr_jsval_from_str(const ScrStr *s) {
  isl_entry();
  return isl_cell_new(JS_NewStringLen(isl_ctx, s->data, s->len));
}

/* The composite entry path: text from the emitted type-directed JSON
 * serializers, parsed by the engine — a deep copy into the island. The
 * input is machine-produced valid JSON, so a parse failure is an
 * engine-level surprise; bridge it like any exception rather than trust. */
ScrJsval *scr_jsval_from_json(const ScrStr *json) {
  isl_entry();
  JSValue v = JS_ParseJSON(isl_ctx, json->data, json->len, "<scr-marshal>");
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

/* ── marshal in: a CHECKED-DYNAMIC (dyn) value ────────────────────────
 * `unknown` flowing into 'any'-typed code (`const cfg = isJson ?
 * JSON.parse(text) : islandParser(text)`): the dyn tree rebuilds as
 * engine values — a DEEP COPY, the jsMarshal aliasing stance. Data kinds
 * only: a dyn carrying a boxed function, a native handle, or a promise
 * throws the catchable TypeError naming the kind (the box's thunk calls
 * STATIC code the engine cannot re-enter through a data copy). */
static const char *isl_dyn_unmarshalable(const ScrDyn *d) {
  switch (d->kind) {
  /* SCR_DYN_FUNC is NOT here: a boxed function crosses as the generic
   * host-function shim (isl_dynfn_new below) — the routed-call lane's
   * uniform argument conversion. */
  case SCR_DYN_HANDLE:
    return "a runtime handle";
  case SCR_DYN_PROMISE:
    return "a promise";
  case SCR_DYN_ARR:
    for (size_t i = 0; i < d->v.arr.len; i++) {
      const char *r = isl_dyn_unmarshalable(d->v.arr.items[i]);
      if (r != NULL) return r;
    }
    return NULL;
  case SCR_DYN_OBJ:
    for (size_t i = 0; i < d->v.obj.len; i++) {
      const char *r = isl_dyn_unmarshalable(d->v.obj.entries[i].value);
      if (r != NULL) return r;
    }
    return NULL;
  default:
    return NULL;
  }
}

static JSValue isl_dynfn_new(const ScrDyn *d); /* the checked-dynamic tree-function shim, below */

static JSValue isl_from_dyn(const ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_FUNC:
    /* A boxed dyn function enters as ONE generic host-function shim over
     * its uniform call thunk (ScrDynThunk): engine args wrap as dyn
     * values, the thunk runs, the dyn result converts back. Each
     * crossing mints a fresh engine function (documented). */
    return isl_dynfn_new(d);
  case SCR_DYN_UNDEF:
    return JS_UNDEFINED;
  case SCR_DYN_NULL:
    return JS_NULL;
  case SCR_DYN_BOOL:
    return JS_NewBool(isl_ctx, d->v.b);
  case SCR_DYN_NUM:
    return JS_NewFloat64(isl_ctx, d->v.num);
  case SCR_DYN_STR:
    return JS_NewStringLen(isl_ctx, d->v.str->data, d->v.str->len);
  case SCR_DYN_BYTES:
    /* Only u8 payloads reach the checked-dynamic tree today (scr_json.c's stringify note). */
    return JS_NewUint8ArrayCopy(isl_ctx, d->v.bytes->data, d->v.bytes->len);
  case SCR_DYN_ARR: {
    JSValue arr = JS_NewArray(isl_ctx);
    if (JS_IsException(arr)) return arr;
    for (size_t i = 0; i < d->v.arr.len; i++) {
      JSValue item = isl_from_dyn(d->v.arr.items[i]);
      if (JS_IsException(item) ||
          JS_SetPropertyUint32(isl_ctx, arr, (uint32_t)i, item) < 0) {
        JS_FreeValue(isl_ctx, arr);
        return JS_EXCEPTION;
      }
    }
    return arr;
  }
  case SCR_DYN_OBJ: {
    JSValue obj = JS_NewObject(isl_ctx);
    if (JS_IsException(obj)) return obj;
    for (size_t i = 0; i < d->v.obj.len; i++) {
      const ScrDynEntry *ent = &d->v.obj.entries[i];
      JSValue val = isl_from_dyn(ent->value);
      if (JS_IsException(val) ||
          JS_SetPropertyStr(isl_ctx, obj, ent->key, val) < 0) {
        JS_FreeValue(isl_ctx, obj);
        return JS_EXCEPTION;
      }
    }
    return obj;
  }
  case SCR_DYN_JSVAL:
    /* An engine value riding inside dyn data: embed the SAME engine
     * value by reference — the identity round trip, member position. */
    return JS_DupValue(isl_ctx, d->v.jsval.cell->v);
  default:
    /* Pre-scanned away — defensive. */
    return JS_ThrowTypeError(isl_ctx, "unmarshalable dynamic value");
  }
}

ScrJsval *scr_jsval_from_dyn(const ScrDyn *d) {
  /* The identity round trip: an engine value that crossed into the checked-dynamic tree
   * (scr_dyn_from_jsval) and back is the SAME engine value, by reference
   * — the one direction that used to throw (SEMANTICS.md supersedes the
   * "one unbridgeable mix"). */
  if (d->kind == SCR_DYN_JSVAL) return scr_jsval_retain(d->v.jsval.cell);
  isl_entry();
  const char *bad = isl_dyn_unmarshalable(d);
  if (bad != NULL) {
    char msg[128];
    int len = snprintf(msg, sizeof msg,
                       "an 'unknown' value holding %s cannot enter dynamically-executed code", bad);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
    return NULL;
  }
  JSValue v = isl_from_dyn(d);
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

/* ── the jsval→dyn crossing (SCR_DYN_JSVAL's constructor + ops) ───────
 * The reverse direction: an 'any'-typed engine value flowing into an
 * 'unknown'/'object'/JS-residue slot wraps BY REFERENCE as the checked-dynamic tree's
 * island kind. The dyn core (scr_json.c) stays island-free — it routes
 * the armed operations (typeof/truthy/String()/===, the narrowing
 * tests) through these installed ops; everything un-armed there keeps
 * the loud "not supported yet" ladder. */

static void isl_dynjs_release(ScrJsval *cell) { scr_jsval_release(cell); }
static ScrStr *isl_dynjs_typeof(ScrJsval *cell) { return scr_jsval_typeof(cell); }
static bool isl_dynjs_truthy(ScrJsval *cell) { return scr_jsval_truthy(cell) != 0; }
static ScrStr *isl_dynjs_to_str(ScrJsval *cell) { return scr_jsval_to_str(cell); }
static bool isl_dynjs_strict_eq(ScrJsval *a, ScrJsval *b) {
  /* The engine's === through the pinned helper (a bridged surprise
   * answers false — strict equality itself cannot throw in JS). */
  return scr_jsval_cmp(SCR_JSOP_EQ, a, b) == 1;
}
static bool isl_dynjs_is_array(ScrJsval *cell) { return JS_IsArray(cell->v); }
static bool isl_dynjs_is_error(ScrJsval *cell) { return JS_IsError(cell->v); }

static const ScrDynJsvalOps isl_dynjs_ops;

/* The jsval→dyn wrap over a RAW engine value (BORROWED) — the scalar
 * normalization the cell constructor applies, shared by the routed-op
 * result conversions (which hold a JSValue, not a cell). Composites mint
 * a fresh cell over the SAME engine value (identity is the value — the
 * engine's === and the unwrap both go through it). */
static ScrDyn *isl_dyn_from_value(JSValue v) {
  if (JS_IsUndefined(v)) return scr_dyn_retain(scr_dyn_undefined());
  if (JS_IsNull(v)) return scr_dyn_new_null();
  if (JS_IsBool(v)) return scr_dyn_new_bool(JS_ToBool(isl_ctx, v) > 0);
  if (JS_IsNumber(v)) {
    double num = 0;
    JS_ToFloat64(isl_ctx, &num, v); /* cannot fail on a number */
    return scr_dyn_new_num(num);
  }
  if (JS_IsString(v)) {
    ScrStr *s = isl_js_to_str(v); /* cannot bridge on a string */
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  return scr_dyn_alloc_jsval(isl_cell_new(JS_DupValue(isl_ctx, v)), &isl_dynjs_ops);
}

/* ── the routed operation set (the ScrDynJsvalOps rows scr_json.c and
 * scr_dyn_invoke.c dispatch through) ─────────────────────────────────
 * Keys enter as engine strings through the GETIDX/SETIDX helpers (any
 * byte content, canonical-index semantics are the engine's own); dyn
 * arguments cross through scr_jsval_from_dyn (wrapped cells by
 * reference, data as the usual deep copy, FUNC boxes through the shim);
 * results wrap back scalar-normalized. Engine throws bridge catchably
 * with the engine's message. */

static ScrDyn *isl_dynjs_key_get(ScrJsval *cell, const ScrStr *k) {
  isl_entry();
  JSValue key = JS_NewStringLen(isl_ctx, k->data, k->len);
  JSValue argv[2] = {cell->v, key};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_GETIDX], JS_UNDEFINED, 2, argv);
  JS_FreeValue(isl_ctx, key);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  ScrDyn *d = isl_dyn_from_value(r);
  JS_FreeValue(isl_ctx, r);
  return d;
}

static bool isl_dynjs_key_set(ScrJsval *cell, const ScrStr *k, const ScrDyn *v) {
  ScrJsval *vj = scr_jsval_from_dyn(v);
  if (!vj) return false; /* unmarshalable value — the catchable TypeError */
  isl_entry();
  JSValue key = JS_NewStringLen(isl_ctx, k->data, k->len);
  JSValue argv[3] = {cell->v, key, vj->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_SETIDX], JS_UNDEFINED, 3, argv);
  JS_FreeValue(isl_ctx, key);
  scr_jsval_release(vj);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return false;
  }
  JS_FreeValue(isl_ctx, r);
  return true;
}

/* Convert argc dyn arguments for a routed call; frees what it built on
 * failure. Returns false with the exception pending. */
static bool isl_dynjs_args_in(ScrDyn *const *args, size_t argc, ScrJsval **cells) {
  for (size_t i = 0; i < argc; i++) {
    cells[i] = scr_jsval_from_dyn(args[i]);
    if (!cells[i]) {
      for (size_t j = 0; j < i; j++) scr_jsval_release(cells[j]);
      return false;
    }
  }
  return true;
}

static ScrDyn *isl_dynjs_call(ScrJsval *cell, ScrDyn *const *args, size_t argc) {
  ScrJsval *stack_cells[8];
  ScrJsval **cells = argc <= 8 ? stack_cells : malloc(argc * sizeof *cells);
  if (!isl_dynjs_args_in(args, argc, cells)) {
    if (cells != stack_cells) free(cells);
    return NULL;
  }
  ScrJsval *r = scr_jsval_call(cell, (int)argc, cells);
  for (size_t i = 0; i < argc; i++) scr_jsval_release(cells[i]);
  if (cells != stack_cells) free(cells);
  if (!r) return NULL;
  ScrDyn *d = isl_dyn_from_value(r->v);
  scr_jsval_release(r);
  return d;
}

static ScrDyn *isl_dynjs_invoke(ScrJsval *cell, const char *method, ScrDyn *const *args, size_t argc, const char *what) {
  isl_entry();
  JSValue fn = JS_GetPropertyStr(isl_ctx, cell->v, method); /* owned */
  if (JS_IsException(fn)) {
    isl_bridge_exception();
    return NULL;
  }
  if (!JS_IsFunction(isl_ctx, fn)) {
    /* Node's spelled TypeError (V8's text), front-run before the
     * engine's terser "not a function". */
    JS_FreeValue(isl_ctx, fn);
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, what);
    scr_jb_puts(&b, " is not a function");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return NULL;
  }
  ScrJsval *stack_cells[8];
  ScrJsval **cells = argc <= 8 ? stack_cells : malloc(argc * sizeof *cells);
  if (!isl_dynjs_args_in(args, argc, cells)) {
    JS_FreeValue(isl_ctx, fn);
    if (cells != stack_cells) free(cells);
    return NULL;
  }
  JSValue stack_args[8];
  JSValue *argv = argc <= 8 ? stack_args : malloc(argc * sizeof(JSValue));
  for (size_t i = 0; i < argc; i++) argv[i] = cells[i]->v;
  JSValue r = JS_Call(isl_ctx, fn, cell->v, (int)argc, argv); /* this = receiver */
  if (argv != stack_args) free(argv);
  JS_FreeValue(isl_ctx, fn);
  for (size_t i = 0; i < argc; i++) scr_jsval_release(cells[i]);
  if (cells != stack_cells) free(cells);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  ScrDyn *d = isl_dyn_from_value(r);
  JS_FreeValue(isl_ctx, r);
  return d;
}

static bool isl_dynjs_is_nullish(ScrJsval *cell) {
  return JS_IsUndefined(cell->v) || JS_IsNull(cell->v);
}

static ScrDyn *isl_dynjs_obj_walk(ScrJsval *cell, int mode) {
  isl_entry();
  JSValue m = JS_NewInt32(isl_ctx, mode);
  JSValue argv[2] = {cell->v, m};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_OBJWALK], JS_UNDEFINED, 2, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  /* The engine array unpacks into a NATIVE dyn array (keys are dyn
   * strings, values wrap per element, entries become native pairs) so
   * the results iterate/index/measure at native speed. */
  int64_t len = 0;
  JSValue lv = JS_GetPropertyStr(isl_ctx, r, "length");
  JS_ToInt64(isl_ctx, &len, lv);
  JS_FreeValue(isl_ctx, lv);
  ScrDyn *out = scr_dyn_new_arr();
  for (int64_t i = 0; i < len; i++) {
    JSValue e = JS_GetPropertyUint32(isl_ctx, r, (uint32_t)i);
    if (mode == 2) {
      JSValue k = JS_GetPropertyUint32(isl_ctx, e, 0);
      JSValue v = JS_GetPropertyUint32(isl_ctx, e, 1);
      ScrDyn *pair = scr_dyn_new_arr();
      scr_dyn_arr_push(pair, isl_dyn_from_value(k));
      scr_dyn_arr_push(pair, isl_dyn_from_value(v));
      scr_dyn_arr_push(out, pair);
      JS_FreeValue(isl_ctx, k);
      JS_FreeValue(isl_ctx, v);
    } else {
      scr_dyn_arr_push(out, isl_dyn_from_value(e));
    }
    JS_FreeValue(isl_ctx, e);
  }
  JS_FreeValue(isl_ctx, r);
  return out;
}

static int isl_dynjs_has_own(ScrJsval *cell, const ScrStr *k) {
  isl_entry();
  JSValue key = JS_NewStringLen(isl_ctx, k->data, k->len);
  JSValue argv[2] = {cell->v, key};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_HASOWN], JS_UNDEFINED, 2, argv);
  JS_FreeValue(isl_ctx, key);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return -1;
  }
  int b = JS_ToBool(isl_ctx, r);
  JS_FreeValue(isl_ctx, r);
  return b > 0 ? 1 : 0;
}

static bool isl_dynjs_assign(ScrJsval *cell, const ScrDyn *src) {
  ScrJsval *sj = scr_jsval_from_dyn(src);
  if (!sj) return false;
  isl_entry();
  JSValue argv[2] = {cell->v, sj->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_ASSIGN], JS_UNDEFINED, 2, argv);
  scr_jsval_release(sj);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return false;
  }
  JS_FreeValue(isl_ctx, r);
  return true;
}

static ScrStr *isl_dynjs_to_json(ScrJsval *cell) { return scr_jsval_to_json(cell); }

static ScrDyn *isl_dynjs_iter_drain(ScrJsval *cell, bool spread, const ScrStr *spell) {
  isl_entry();
  JSValue m = JS_NewInt32(isl_ctx, spread ? 1 : 0);
  JSValue s = spell && spell->len > 0
    ? JS_NewStringLen(isl_ctx, spell->data, spell->len)
    : JS_UNDEFINED;
  JSValue argv[3] = {cell->v, m, s};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_ITERDRAIN], JS_UNDEFINED, 3, argv);
  JS_FreeValue(isl_ctx, s);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  /* The drained engine array unpacks into a fresh dyn array — elements
   * wrap back scalar-normalized (composites stay engine values by
   * reference), exactly the obj_walk unpack. */
  int64_t len = 0;
  JSValue lv = JS_GetPropertyStr(isl_ctx, r, "length");
  JS_ToInt64(isl_ctx, &len, lv);
  JS_FreeValue(isl_ctx, lv);
  ScrDyn *out = scr_dyn_new_arr();
  for (int64_t i = 0; i < len; i++) {
    JSValue e = JS_GetPropertyUint32(isl_ctx, r, (uint32_t)i);
    scr_dyn_arr_push(out, isl_dyn_from_value(e));
    JS_FreeValue(isl_ctx, e);
  }
  JS_FreeValue(isl_ctx, r);
  return out;
}

static const ScrDynJsvalOps isl_dynjs_ops = {
  isl_dynjs_release,
  isl_dynjs_typeof,
  isl_dynjs_truthy,
  isl_dynjs_to_str,
  isl_dynjs_strict_eq,
  isl_dynjs_is_array,
  isl_dynjs_is_error,
  isl_dynjs_key_get,
  isl_dynjs_key_set,
  isl_dynjs_call,
  isl_dynjs_invoke,
  isl_dynjs_is_nullish,
  isl_dynjs_obj_walk,
  isl_dynjs_has_own,
  isl_dynjs_assign,
  isl_dynjs_to_json,
  isl_dynjs_iter_drain,
};

ScrDyn *scr_dyn_from_jsval(ScrJsval *cell) {
  isl_entry();
  JSValue v = cell->v;
  /* Scalar normalization: engine-reported scalars become the NATIVE dyn
   * kinds at wrap time (the strict exits cannot fail on them), so every
   * scalar path in the dyn core — ===, typeof tests, JSON of leaves —
   * stays untouched and the JSVAL kind never competes with them. */
  if (JS_IsUndefined(v)) return scr_dyn_retain(scr_dyn_undefined());
  if (JS_IsNull(v)) return scr_dyn_new_null();
  if (JS_IsBool(v)) return scr_dyn_new_bool(JS_ToBool(isl_ctx, v) > 0);
  if (JS_IsNumber(v)) {
    double num = 0;
    JS_ToFloat64(isl_ctx, &num, v); /* cannot fail on a number */
    return scr_dyn_new_num(num);
  }
  if (JS_IsString(v)) {
    ScrStr *s = isl_js_to_str(v); /* cannot bridge on a string */
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  return scr_dyn_alloc_jsval(scr_jsval_retain(cell), &isl_dynjs_ops);
}

/* ── operators (through the pinned prelude helpers) ───────────────────── */

ScrJsval *scr_jsval_binop(int op, ScrJsval *a, ScrJsval *b) {
  isl_entry();
  JSValue argv[2] = {a->v, b->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[op], JS_UNDEFINED, 2, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

int scr_jsval_cmp(int op, ScrJsval *a, ScrJsval *b) {
  isl_entry();
  JSValue argv[2] = {a->v, b->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[op], JS_UNDEFINED, 2, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return -1;
  }
  int b1 = JS_ToBool(isl_ctx, r);
  JS_FreeValue(isl_ctx, r);
  return b1 > 0 ? 1 : 0;
}

int scr_jsval_instance_of(ScrJsval *v, ScrJsval *c) {
  isl_entry();
  /* JS_IsInstanceOf IS the spec's InstanceofOperator — Symbol.hasInstance
   * included; a non-callable/non-object RHS throws the engine's own
   * TypeError, bridged catchably like every island op. */
  int r = JS_IsInstanceOf(isl_ctx, v->v, c->v);
  if (r < 0) {
    isl_bridge_exception();
    return -1;
  }
  return r > 0 ? 1 : 0;
}

static ScrJsval *isl_call1(int helper, ScrJsval *a) {
  isl_entry();
  JSValue r = JS_Call(isl_ctx, isl_helpers[helper], JS_UNDEFINED, 1, &a->v);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

ScrJsval *scr_jsval_neg(ScrJsval *a) { return isl_call1(ISL_H_NEG, a); }
/* GetIterator over an island value (the for-of head): the engine's own
 * protocol lookup, V8's not-iterable TypeError text on refusal. */
ScrJsval *scr_jsval_iter_new(ScrJsval *a) { return isl_call1(ISL_H_ITER, a); }
ScrJsval *scr_jsval_plus(ScrJsval *a) { return isl_call1(ISL_H_PLUS, a); }

int scr_jsval_truthy(ScrJsval *a) {
  isl_entry();
  return JS_ToBool(isl_ctx, a->v) > 0; /* ToBoolean never throws */
}

ScrStr *scr_jsval_typeof(ScrJsval *a) {
  isl_entry();
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_TYPEOF], JS_UNDEFINED, 1, &a->v);
  /* typeof cannot throw; the result is always an engine string. */
  ScrStr *s = isl_js_to_str(r);
  JS_FreeValue(isl_ctx, r);
  return s;
}

ScrStr *scr_jsval_to_str(ScrJsval *a) {
  isl_entry();
  return isl_js_to_str(a->v); /* NULL = bridged (e.g. a symbol) */
}

/* ── property/element access and calls ────────────────────────────────── */

ScrJsval *scr_jsval_get_prop(ScrJsval *o, const ScrStr *name) {
  isl_entry();
  JSValue r = JS_GetPropertyStr(isl_ctx, o->v, name->data); /* owned */
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* A member of the engine's global object by name (Math, parseFloat, ...) —
 * the receiver/callee for the island-backed ambient surface. */
ScrJsval *scr_jsval_global_get(const ScrStr *name) {
  isl_entry();
  JSValue g = JS_GetGlobalObject(isl_ctx); /* owned */
  JSValue r = JS_GetPropertyStr(isl_ctx, g, name->data); /* owned */
  JS_FreeValue(isl_ctx, g);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

int scr_jsval_set_prop(ScrJsval *o, const ScrStr *name, ScrJsval *v) {
  isl_entry();
  /* JS_SetPropertyStr CONSUMES its value argument — dup, the cell keeps
   * its own reference. */
  if (JS_SetPropertyStr(isl_ctx, o->v, name->data, JS_DupValue(isl_ctx, v->v)) < 0) {
    isl_bridge_exception();
    return 0;
  }
  return 1;
}

/* Destructuring RequireObjectCoercible (V8's exact TypeError text — see
 * the ISL_H_DESTRCHECK prelude helper): nullish throws catchably, every
 * other value passes through (+1 cell). `first` is the pattern's first
 * property name or NULL for the empty pattern's bare form. */
ScrJsval *scr_jsval_destr_check(ScrJsval *v, const char *spell, const char *first) {
  isl_entry();
  JSValue argv[3];
  argv[0] = v->v;
  argv[1] = JS_NewString(isl_ctx, spell);
  argv[2] = first ? JS_NewString(isl_ctx, first) : JS_UNDEFINED;
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_DESTRCHECK], JS_UNDEFINED, 3, argv);
  JS_FreeValue(isl_ctx, argv[1]);
  JS_FreeValue(isl_ctx, argv[2]);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* Destructuring GetIterator + the pattern's width (see ISL_H_ITERN):
 * a fresh engine array of exactly n elements, undefined-padded, with
 * IteratorClose when the iterator was not exhausted; non-iterables throw
 * V8's exact not-iterable TypeError catchably. */
ScrJsval *scr_jsval_iter_n(ScrJsval *v, double n) {
  isl_entry();
  JSValue argv[2];
  argv[0] = v->v;
  argv[1] = JS_NewFloat64(isl_ctx, n);
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_ITERN], JS_UNDEFINED, 2, argv);
  JS_FreeValue(isl_ctx, argv[1]);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

ScrJsval *scr_jsval_get_idx(ScrJsval *o, ScrJsval *key) {
  isl_entry();
  JSValue argv[2] = {o->v, key->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_GETIDX], JS_UNDEFINED, 2, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

int scr_jsval_set_idx(ScrJsval *o, ScrJsval *key, ScrJsval *v) {
  isl_entry();
  JSValue argv[3] = {o->v, key->v, v->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_SETIDX], JS_UNDEFINED, 3, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return 0;
  }
  JS_FreeValue(isl_ctx, r);
  return 1;
}

ScrJsval *scr_jsval_call_method(ScrJsval *o, const ScrStr *name, int argc, ScrJsval **argv) {
  isl_entry();
  JSValue fn = JS_GetPropertyStr(isl_ctx, o->v, name->data); /* owned */
  if (JS_IsException(fn)) {
    isl_bridge_exception();
    return NULL;
  }
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_Call(isl_ctx, fn, o->v, argc, args); /* this = receiver */
  if (args != stack_args) free(args);
  JS_FreeValue(isl_ctx, fn);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* `o.name?.(...)` — the optional METHOD call: a nullish member answers
 * the engine's undefined (JS: exactly `o.name?.()`); anything else calls
 * with `this = o`, non-callables throwing the engine's own TypeError. */
ScrJsval *scr_jsval_opt_call_method(ScrJsval *o, const ScrStr *name, int argc, ScrJsval **argv) {
  isl_entry();
  JSValue fn = JS_GetPropertyStr(isl_ctx, o->v, name->data); /* owned */
  if (JS_IsException(fn)) {
    isl_bridge_exception();
    return NULL;
  }
  if (JS_IsUndefined(fn) || JS_IsNull(fn)) {
    JS_FreeValue(isl_ctx, fn);
    return isl_cell_new(JS_UNDEFINED);
  }
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_Call(isl_ctx, fn, o->v, argc, args); /* this = receiver */
  if (args != stack_args) free(args);
  JS_FreeValue(isl_ctx, fn);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

ScrJsval *scr_jsval_call(ScrJsval *f, int argc, ScrJsval **argv) {
  isl_entry();
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_Call(isl_ctx, f->v, JS_UNDEFINED, argc, args);
  if (args != stack_args) free(args);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* Call an already-resolved computed member with its original receiver. The
 * frontend performs GetValue before argument evaluation, then arrives here
 * after the arguments are ready; keeping callee and receiver separate avoids
 * a second getter read while preserving method `this`. */
ScrJsval *scr_jsval_call_this(ScrJsval *f, ScrJsval *receiver, int argc,
                              ScrJsval **argv) {
  isl_entry();
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_Call(isl_ctx, f->v, receiver->v, argc, args);
  if (args != stack_args) free(args);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* Spread application on an island callee (jsOp callSpread) — the prelude
 * helper's real `f(...pre, ...spread)`, so iterator protocols are the
 * engine's own and the guards front-run V8's exact spread-call TypeError
 * texts (`what` is the spread expression's source spelling). Borrows
 * everything; +1 out, or NULL with the engine exception bridged. */
ScrJsval *scr_jsval_call_spread(ScrJsval *f, ScrJsval *pre, ScrJsval *spread, const ScrStr *what) {
  isl_entry();
  JSValue argv[4] = {f->v, pre->v, spread->v, JS_NewStringLen(isl_ctx, what->data, what->len)};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_CALLSPREAD], JS_UNDEFINED, 4, argv);
  JS_FreeValue(isl_ctx, argv[3]);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* `new X(...)` on an island callee (jsOp construct). Borrows everything;
 * +1 out, or NULL with the engine exception bridged. */
ScrJsval *scr_jsval_construct(ScrJsval *f, int argc, ScrJsval **argv) {
  isl_entry();
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_CallConstructor(isl_ctx, f->v, argc, args);
  if (args != stack_args) free(args);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* ── closures entering the island (host functions) ────────────────────
 * A scriptc closure wraps as an engine function: arguments arrive as
 * BORROWED cells (padded with undefined / surplus dropped — JS call
 * semantics), the compiled adapter calls the closure through its real
 * ABI, and the +1 result value (or undefined for void) returns to the
 * engine. A scriptc exception thrown by the closure REVERSE-bridges:
 * the pending cell's payload becomes the engine's thrown value (strings
 * stay strings, so a round trip through both bridges is the identity).
 * The wrapper OWNS one reference on the closure; the engine finalizer
 * releases it — at teardown that happens before the RC audit runs. */

#define ISL_HOSTFN_MAX_ARITY 16

typedef struct {
  ScrClosure *c;
  ScrJsval *(*adapt)(ScrClosure *, ScrJsval **);
  int arity;
} IslHostFn;

static JSClassID isl_hostfn_class_id = 0;

static void isl_hostfn_finalizer(JSRuntime *rt, JSValueConst val) {
  (void)rt;
  IslHostFn *b = JS_GetOpaque(val, isl_hostfn_class_id);
  if (b) {
    scr_closure_release(b->c);
    free(b);
  }
}

static const JSClassDef isl_hostfn_class = {
    .class_name = "ScrHostFn",
    .finalizer = isl_hostfn_finalizer,
};

static JSClassID isl_dynfn_class_id;      /* the checked-dynamic tree-function shim, below */
static const JSClassDef isl_dynfn_class;

static void isl_register_hostfn_class(void) {
  JS_NewClassID(isl_rt, &isl_hostfn_class_id);
  JS_NewClass(isl_rt, isl_hostfn_class_id, &isl_hostfn_class);
  JS_NewClassID(isl_rt, &isl_dynfn_class_id);
  JS_NewClass(isl_rt, isl_dynfn_class_id, &isl_dynfn_class);
  isl_register_bridge_class();
}

/* Pending scriptc exception → engine VALUE (reverse bridge); clears the
 * cell. Shared by the host-call throw path and the promise bridge's
 * rejection path. */
static JSValue isl_pending_to_value(JSContext *ctx) {
  ScrExcCell *cell = scr_exc_current_cell();
  JSValue v;
  switch (cell->kind) {
  case SCR_EXC_F64:
    v = JS_NewFloat64(ctx, cell->f64);
    break;
  case SCR_EXC_BOOL:
    v = JS_NewBool(ctx, cell->b);
    break;
  case SCR_EXC_STR: {
    ScrStr *s = (ScrStr *)cell->payload;
    v = JS_NewStringLen(ctx, s->data, s->len);
    break;
  }
  case SCR_EXC_OBJ:
    if (scr_error_is(cell->payload)) {
      /* A scriptc Error crossing in: a real engine Error with the same
       * name/message, so package code can read e.message and String(e).
       * The BUILTIN names construct through the engine's own constructor
       * (mirroring the forward bridge, which picks the builtin vtable by
       * name) so `e instanceof TypeError` narrows in package code —
       * conversion failures at the typed-callback boundary rely on it.
       * Custom names ride an Error-rooted instance with the name set. */
      ScrError *err = (ScrError *)cell->payload;
      static const char *const builtins[] = {"Error", "TypeError", "RangeError", "SyntaxError"};
      v = JS_UNDEFINED;
      for (size_t i = 0; i < sizeof builtins / sizeof builtins[0]; i++) {
        if (strlen(builtins[i]) == err->name->len &&
            memcmp(builtins[i], err->name->data, err->name->len) == 0) {
          JSValue global = JS_GetGlobalObject(ctx);
          JSValue ctor = JS_GetPropertyStr(ctx, global, builtins[i]);
          JS_FreeValue(ctx, global);
          JSValue msg = JS_NewStringLen(ctx, err->message->data, err->message->len);
          v = JS_CallConstructor(ctx, ctor, 1, &msg);
          JS_FreeValue(ctx, msg);
          JS_FreeValue(ctx, ctor);
          if (JS_IsException(v)) v = JS_UNDEFINED; /* fall back below */
          break;
        }
      }
      if (JS_IsUndefined(v)) {
        v = JS_NewError(ctx);
        JS_SetPropertyStr(ctx, v, "name",
                          JS_NewStringLen(ctx, err->name->data, err->name->len));
        JS_SetPropertyStr(ctx, v, "message",
                          JS_NewStringLen(ctx, err->message->data, err->message->len));
      }
      /* The code property crosses too — fs/exec throw sites stamp the
       * errno name, and package code branches on err.code === 'ENOENT'. */
      if (err->code != NULL && !JS_IsUndefined(v)) {
        JS_SetPropertyStr(ctx, v, "code",
                          JS_NewStringLen(ctx, err->code->data, err->code->len));
      }
      break;
    }
    /* fall through: non-Error hierarchy objects render like other refs */
  default:
    /* Ref payloads render "[object]" like the uncaught printer. */
    v = JS_NewString(ctx, "[object]");
    break;
  }
  scr_exc_clear();
  return v;
}

/* Pending scriptc exception → engine thrown value (reverse bridge). */
static JSValue isl_throw_pending(JSContext *ctx) {
  return JS_Throw(ctx, isl_pending_to_value(ctx));
}

static JSValue isl_hostfn_invoke(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv, int magic, JSValueConst *func_data) {
  (void)this_val;
  (void)magic;
  IslHostFn *b = JS_GetOpaque(func_data[0], isl_hostfn_class_id);
  if (!b) return JS_ThrowTypeError(ctx, "detached scriptc host function");
  ScrJsval *cells[ISL_HOSTFN_MAX_ARITY];
  int ncells;
  if (b->arity < 0) {
    /* The ISLAND-REST shape (negative arity = -(leading declared + 1)):
     * leading params pad/drop like any host call; the trailing cell is a
     * fresh ENGINE ARRAY of the surplus arguments — the closure's rest
     * binding IS the engine's own arguments array. */
    int leading = -b->arity - 1;
    for (int i = 0; i < leading; i++) {
      cells[i] = isl_cell_new(i < argc ? JS_DupValue(ctx, argv[i]) : JS_UNDEFINED);
    }
    JSValue rest = JS_NewArray(ctx);
    for (int i = leading; i < argc; i++) {
      JS_SetPropertyUint32(ctx, rest, (uint32_t)(i - leading), JS_DupValue(ctx, argv[i]));
    }
    cells[leading] = isl_cell_new(rest);
    ncells = leading + 1;
  } else {
    for (int i = 0; i < b->arity; i++) {
      cells[i] = isl_cell_new(i < argc ? JS_DupValue(ctx, argv[i]) : JS_UNDEFINED);
    }
    ncells = b->arity;
  }
  bool strayed_before = isl_anchor_strayed;
  isl_host_depth++;
  ScrJsval *r = b->adapt(b->c, cells);
  isl_host_depth--;
  if (isl_anchor_strayed && !strayed_before) {
    /* A fiber the callback spawned (an async callback's eager prefix, the
     * promise-bridge waiter) re-anchored the overflow check to ITS stack;
     * the engine frames above this call live on ours. Re-anchor here —
     * deeper than the original entry by the frames already in use, which
     * loosens the budget by that depth (transient: the next top-level
     * entry re-anchors exactly). */
    isl_anchor_here();
    isl_anchor_strayed = strayed_before;
  }
  for (int i = 0; i < ncells; i++) scr_jsval_release(cells[i]);
  if (scr_exc_pending()) {
    if (r) scr_jsval_release(r);
    return isl_throw_pending(ctx);
  }
  if (!r) return JS_UNDEFINED;
  JSValue out = JS_DupValue(ctx, r->v);
  scr_jsval_release(r);
  return out;
}

/* A compiled closure's dynamic own-property table follows it across the
 * typed host-function bridge. Object.defineProperty/defineProperties attach
 * entries to the closure before it is returned through an `any`-typed
 * overload; the fresh engine function must expose the same data properties.
 * Descriptor flags are intentionally normalized to ordinary enumerable
 * properties, matching scr_dyn_define_props' documented dynamic stance. */
static bool isl_copy_closure_props(ScrClosure *c, JSValue fn) {
  if (!c->props) return true;
  ScrDyn *table = (ScrDyn *)scr_box_get_ref(c->props); /* +1 */
  if (!table || table->kind != SCR_DYN_OBJ) {
    scr_dyn_release(table);
    return true;
  }
  for (size_t i = 0; i < table->v.obj.len; i++) {
    ScrDynEntry *ent = &table->v.obj.entries[i];
    JSValue value = isl_from_dyn(ent->value);
    if (JS_IsException(value)) {
      isl_bridge_exception();
      scr_dyn_release(table);
      return false;
    }
    /* JS_SetPropertyStr consumes value, including on failure. */
    if (JS_SetPropertyStr(isl_ctx, fn, ent->key, value) < 0) {
      isl_bridge_exception();
      scr_dyn_release(table);
      return false;
    }
  }
  scr_dyn_release(table);
  return true;
}

ScrJsval *scr_jsval_from_closure(ScrClosure *c, int arity,
                                  ScrJsval *(*adapt)(ScrClosure *, ScrJsval **)) {
  isl_entry();
  /* Negative arity = the island-rest shape; the CELL count is the leading
   * declared params + the one rest-array slot. */
  if ((arity < 0 ? -arity : arity) > ISL_HOSTFN_MAX_ARITY) {
    fprintf(stderr, "scriptc: island callback arity %d exceeds %d\n", arity,
            ISL_HOSTFN_MAX_ARITY);
    abort(); /* the frontend fences this; reaching here is a compiler bug */
  }
  IslHostFn *b = malloc(sizeof *b);
  if (!b) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  b->c = scr_closure_retain(c);
  b->adapt = adapt;
  b->arity = arity;
  JSValue box = JS_NewObjectClass(isl_ctx, isl_hostfn_class_id);
  JS_SetOpaque(box, b);
  JSValueConst data[1] = {box};
  JSValue fn = JS_NewCFunctionData(isl_ctx, isl_hostfn_invoke, arity < 0 ? -arity - 1 : arity, 0, 1, data);
  JS_FreeValue(isl_ctx, box); /* fn's func_data holds its own reference */
  if (!isl_copy_closure_props(c, fn)) {
    JS_FreeValue(isl_ctx, fn);
    return NULL;
  }
  return isl_cell_new(fn);
}

/* ── the generic dyn-function shim (a boxed SCR_DYN_FUNC entering the
 * island) ─────────────────────────────────────────────────────────────
 * ONE shim serves every boxed function because the box's call thunk is a
 * single uniform C signature (ScrDynThunk): engine arguments wrap as dyn
 * values (scalar-normalizing — the jsval→dyn constructor's stance), the
 * thunk validates them against the closure's declared parameter types
 * and runs it, and the dyn result converts back through the from_dyn
 * rules (wrapped cells by reference, data as a deep copy, nested
 * functions through this same shim). OWNERSHIP: the engine function's
 * opaque box owns ONE reference on the whole ScrDyn FUNC node (closure
 * and descriptor ride inside); the engine finalizer releases it — at
 * teardown that runs before the RC audit, the isl_hostfn story. A
 * scriptc exception thrown inside reverse-bridges to an engine throw;
 * the receiver (`this`) is deliberately not forwarded (the typed
 * host-function stance — dyn thunks read the ambient receiver, which no
 * engine call site binds). Each crossing mints a FRESH engine function:
 * re-crossing identity is not preserved (SEMANTICS.md). */

static JSClassID isl_dynfn_class_id = 0;

static void isl_dynfn_finalizer(JSRuntime *rt, JSValueConst val) {
  (void)rt;
  ScrDyn *box = JS_GetOpaque(val, isl_dynfn_class_id);
  if (box) scr_dyn_release(box);
}

static const JSClassDef isl_dynfn_class = {
    .class_name = "ScrDynFn",
    .finalizer = isl_dynfn_finalizer,
};

static JSValue isl_dynfn_invoke(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv, int magic, JSValueConst *func_data) {
  (void)this_val;
  (void)magic;
  ScrDyn *box = JS_GetOpaque(func_data[0], isl_dynfn_class_id);
  if (!box) return JS_ThrowTypeError(ctx, "detached scriptc function");
  ScrDyn *stack_args[8];
  ScrDyn **dargs = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof *dargs);
  for (int i = 0; i < argc; i++) dargs[i] = isl_dyn_from_value(argv[i]);
  bool strayed_before = isl_anchor_strayed;
  isl_host_depth++;
  ScrDyn *r = box->v.fn.thunk(box->v.fn.clo, dargs, (size_t)argc);
  isl_host_depth--;
  if (isl_anchor_strayed && !strayed_before) {
    /* The isl_hostfn_invoke re-anchor dance: a fiber the callback spawned
     * moved the engine's overflow anchor off this stack. */
    isl_anchor_here();
    isl_anchor_strayed = strayed_before;
  }
  for (int i = 0; i < argc; i++) scr_dyn_release(dargs[i]);
  if (dargs != stack_args) free(dargs);
  if (scr_exc_pending()) {
    if (r) scr_dyn_release(r);
    return isl_throw_pending(ctx);
  }
  if (!r) return JS_UNDEFINED;
  /* The thunk's dyn result converts back per the from_dyn rules; a kind
   * with no crossing (a handle, a promise) throws the same catchable
   * TypeError from_dyn would. */
  const char *bad = isl_dyn_unmarshalable(r);
  if (bad != NULL) {
    scr_dyn_release(r);
    return JS_ThrowTypeError(ctx, "an 'unknown' value holding %s cannot enter dynamically-executed code", bad);
  }
  JSValue out = isl_from_dyn(r);
  scr_dyn_release(r);
  return out; /* JS_EXCEPTION passes through as the engine throw */
}

/* A fresh engine function over a boxed dyn function (borrows d — the
 * opaque box retains it). */
static JSValue isl_dynfn_new(const ScrDyn *d) {
  JSValue boxv = JS_NewObjectClass(isl_ctx, isl_dynfn_class_id);
  JS_SetOpaque(boxv, scr_dyn_retain((ScrDyn *)d));
  JSValueConst data[1] = {boxv};
  JSValue fn = JS_NewCFunctionData(isl_ctx, isl_dynfn_invoke, (int)d->v.fn.arity, 0, 1, data);
  JS_FreeValue(isl_ctx, boxv); /* fn's func_data holds its own reference */
  return fn;
}

/* The typed adapters' absence test for `T | undefined` parameters. */
bool scr_jsval_is_undefined(ScrJsval *v) { return JS_IsUndefined(v->v); }

/* ── the promise bridge (async callbacks' thenable) ───────────────────
 * A typed callback with an async body returns a scriptc promise; the
 * package expects a real thenable. scr_jsval_from_promise mints an
 * engine promise capability and spawns a WAITER fiber that awaits the
 * scriptc promise — the settle notification the promise machinery
 * already has — then settles the capability: fulfillment marshals per the
 * payload tag, rejection reverse-bridges the reason (the same conversion
 * host-call throws use, so Errors arrive as engine Errors). The await
 * marks the rejection OBSERVED for the static ledger; from there the
 * engine's own rejection tracker owns the outcome — an unhandled wrapper
 * rejection reports through the island ledger, a handled one is silent.
 * One report, one voice, either way.
 *
 * Live wraps are registered so teardown can free their engine values if
 * the wrapped promise never settles (the waiter is then an abandoned
 * fiber; its stack is deliberately not unwound — the loop can only end
 * with an UNSETTLED wrap, since a settled one wakes the waiter as a
 * microtask before quiescence). */

typedef struct IslPromWrap {
  struct IslPromWrap *next;
  ScrPromise *p; /* the wrapped scriptc promise, +1 (moved in) */
  JSValue resolve, reject;
  int payload; /* SCR_ISLP_* */
} IslPromWrap;

static IslPromWrap *isl_prom_wraps = NULL;

/* Unlink + free one wrap (releases the promise, frees the capability's
 * settle functions). */
static void isl_prom_wrap_free(IslPromWrap *w) {
  for (IslPromWrap **link = &isl_prom_wraps; *link; link = &(*link)->next) {
    if (*link == w) {
      *link = w->next;
      break;
    }
  }
  JS_FreeValue(isl_ctx, w->resolve);
  JS_FreeValue(isl_ctx, w->reject);
  scr_promise_release(w->p);
  free(w);
}

/* The waiter fiber body: await, convert, settle the capability. Runs
 * eagerly at wrap time (already-settled promises deliver before the host
 * call returns — like a resolved thenable's synchronously-queued job) or
 * as a microtask when the promise settles later. isl_entry() re-anchors
 * the engine's overflow check to this fiber's stack (the stray/restore
 * dance in isl_entry/isl_hostfn_invoke keeps the host stack's anchor
 * intact around it). */
static void isl_prom_wrap_entry(ScrFiber *self, void *arg) {
  (void)self;
  IslPromWrap *w = (IslPromWrap *)arg;
  double f = 0;
  bool b = false;
  ScrStr *s = NULL;
  ScrJsval *j = NULL;
  ScrArr *ja = NULL;
  switch (w->payload) {
  case SCR_ISLP_F64: f = scr_await_f64(w->p); break;
  case SCR_ISLP_BOOL: b = scr_await_bool(w->p); break;
  case SCR_ISLP_STR: s = scr_await_str(w->p); break;
  case SCR_ISLP_JSVAL: j = (ScrJsval *)scr_await_ref(w->p); break;
  case SCR_ISLP_JSVAL_ARR: ja = (ScrArr *)scr_await_ref(w->p); break;
  default: scr_await_void(w->p); break;
  }
  bool rejected = scr_exc_pending();
  isl_entry();
  JSValue v;
  if (rejected) {
    v = isl_pending_to_value(isl_ctx);
  } else {
    switch (w->payload) {
    case SCR_ISLP_F64: v = JS_NewFloat64(isl_ctx, f); break;
    case SCR_ISLP_BOOL: v = JS_NewBool(isl_ctx, b); break;
    case SCR_ISLP_STR: v = s ? JS_NewStringLen(isl_ctx, s->data, s->len) : JS_UNDEFINED; break;
    case SCR_ISLP_JSVAL: v = j ? JS_DupValue(isl_ctx, j->v) : JS_UNDEFINED; break;
    case SCR_ISLP_JSVAL_ARR:
      /* A native array of engine cells fulfills: a fresh engine array
       * over the SAME engine values (identity crosses, spine a copy). */
      if (ja) {
        v = JS_NewArray(isl_ctx);
        for (size_t i = 0; i < ja->len; i++) {
          ScrJsval *cell = (ScrJsval *)scr_arr_get_ref(ja, (double)i); /* +1 */
          JS_SetPropertyUint32(isl_ctx, v, (uint32_t)i, JS_DupValue(isl_ctx, cell->v));
          scr_jsval_release(cell);
        }
      } else {
        v = JS_UNDEFINED;
      }
      break;
    default: v = JS_UNDEFINED; break;
    }
  }
  if (s) scr_str_release(s);
  if (j) scr_jsval_release(j);
  if (ja) scr_arr_release(ja);
  JSValue r = JS_Call(isl_ctx, rejected ? w->reject : w->resolve, JS_UNDEFINED, 1, &v);
  JS_FreeValue(isl_ctx, v);
  if (JS_IsException(r)) {
    /* Capability settle functions do not throw — defensive drop. */
    JSValue exc = JS_GetException(isl_ctx);
    JS_FreeValue(isl_ctx, exc);
  } else {
    JS_FreeValue(isl_ctx, r);
  }
  isl_prom_wrap_free(w);
}

/* Teardown half (registered path in isl_teardown_at_exit): free every
 * still-pending wrap's engine values. Their waiter fibers are abandoned
 * with the loop already over; nothing reads the nodes again. */
static void isl_prom_wraps_teardown(void) {
  while (isl_prom_wraps) isl_prom_wrap_free(isl_prom_wraps);
}

ScrJsval *scr_jsval_from_promise(ScrPromise *p, int payload) {
  isl_entry();
  JSValue funcs[2];
  JSValue prom = JS_NewPromiseCapability(isl_ctx, funcs);
  if (JS_IsException(prom)) {
    isl_bridge_exception();
    scr_promise_release(p);
    return NULL;
  }
  IslPromWrap *w = malloc(sizeof *w);
  if (!w) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  w->p = p;
  w->resolve = funcs[0];
  w->reject = funcs[1];
  w->payload = payload;
  w->next = isl_prom_wraps;
  isl_prom_wraps = w;
  ScrPromise *waiter = scr_async_spawn_after(w->p, isl_prom_wrap_entry, w);
  scr_promise_release(waiter); /* the waiter never rejects; nobody awaits it */
  return isl_cell_new(prom);
}

/* ── the promise bridge, island → static (awaiting package promises) ──
 * The reverse of scr_jsval_from_promise: a PACKAGE call's promise lives
 * in the engine, and static code awaiting (or .catch/.finally-chaining)
 * it needs a real ScrPromise. scr_jsval_bridge_promise mints a pending
 * one and subscribes through the pinned ISL_H_THEN helper —
 * Promise.resolve(p).then(onF, onR), so thenables and plain values behave
 * exactly like `await` treats them — with two engine functions sharing a
 * box that owns the static promise. Fulfillment settles it with the
 * retained value cell (or void); rejection converts the reason exactly
 * like a bridged exception (engine Errors become ScrErrors picked by
 * name) and rejects. The settle callbacks run as engine jobs, which the
 * loop drains at quiescence — parked awaiters wake through the ordinary
 * ready queue.
 *
 * Ledger one-voice: the .then marks the ENGINE promise handled (the
 * island's rejection tracker rescinds or never tracks it), and the
 * rejected static promise enters the STATIC ledger at settle — exactly
 * one world reports a never-observed rejection. The derived promise the
 * helper's .then creates is dropped unobserved, but it can never reject:
 * onR returns normally after rejecting the static side.
 *
 * Lifetime: the box is engine-owned (its finalizer releases the static
 * promise), so a bridge whose engine promise never settles frees cleanly
 * at engine teardown — before the RC audit — with no registry needed. A
 * never-settling engine promise queues no jobs, so a fiber parked on its
 * bridge does not keep the loop alive: exhaustion abandons the fiber and
 * the process exits 0, byte-identical to Node's await-forever. */

typedef struct {
  ScrPromise *p; /* the static promise this bridge settles, +1 */
  int payload;   /* SCR_ISLP_JSVAL or SCR_ISLP_VOID */
} IslBridge;

static JSClassID isl_bridge_class_id = 0;

static void isl_bridge_finalizer(JSRuntime *rt, JSValueConst val) {
  (void)rt;
  IslBridge *b = JS_GetOpaque(val, isl_bridge_class_id);
  if (b) {
    scr_promise_release(b->p);
    free(b);
  }
}

static const JSClassDef isl_bridge_class = {
    .class_name = "ScrPromiseBridge",
    .finalizer = isl_bridge_finalizer,
};

static void isl_register_bridge_class(void) {
  JS_NewClassID(isl_rt, &isl_bridge_class_id);
  JS_NewClass(isl_rt, isl_bridge_class_id, &isl_bridge_class);
}

/* onF (magic 0) / onR (magic 1). Runs as an engine job; argv[0] is the
 * settlement value/reason (borrowed). The static promise settles at most
 * once (.then invokes exactly one callback, once) — its own
 * first-settle-wins check backstops that anyway. */
static JSValue isl_bridge_settle(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv, int magic, JSValueConst *func_data) {
  (void)this_val;
  IslBridge *b = JS_GetOpaque(func_data[0], isl_bridge_class_id);
  if (!b) return JS_UNDEFINED;
  JSValueConst v = argc > 0 ? argv[0] : JS_UNDEFINED;
  if (magic == 0) {
    if (b->payload == SCR_ISLP_JSVAL) {
      /* fulfill_ref takes the +1 cell; awaiters retain their own out. */
      scr_promise_fulfill_ref(b->p, isl_cell_new(JS_DupValue(ctx, v)),
                               scr_jsval_retain_v, scr_jsval_release_v, NULL);
    } else if (b->payload == SCR_ISLP_JSVAL_ARR) {
      /* An `any[]`-declared fulfillment (the inferred loadPlugins return):
       * the engine array exits Array.isArray-gated, elements BY REFERENCE
       * (the jsval-element-array exit). A lying fulfillment (non-array)
       * REJECTS the static promise with the boundary TypeError —
       * trust-but-verify at the settle, like every dyn→static edge. */
      ScrJsval *cell = isl_cell_new(JS_DupValue(ctx, v));
      ScrArr *arr = scr_jsval_exit_jsval_arr(cell);
      scr_jsval_release(cell);
      if (!arr) {
        scr_promise_reject_pending(b->p);
      } else {
        scr_promise_fulfill_ref(b->p, arr, scr_arr_retain_v, scr_arr_release_v, NULL);
      }
    } else {
      scr_promise_fulfill_void(b->p);
    }
  } else {
    /* The reason crosses like a bridged exception, then moves out of the
     * (transiently used) current cell into the promise's rejection. */
    isl_throw_reason(v);
    scr_promise_reject_pending(b->p);
  }
  return JS_UNDEFINED;
}

ScrPromise *scr_jsval_bridge_promise(ScrJsval *v, int payload) {
  isl_entry();
  IslBridge *b = malloc(sizeof *b);
  if (!b) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  ScrPromise *p = scr_promise_new();
  b->p = scr_promise_retain(p);
  b->payload = payload;
  JSValue box = JS_NewObjectClass(isl_ctx, isl_bridge_class_id);
  JS_SetOpaque(box, b);
  JSValueConst data[1] = {box};
  JSValue on_f = JS_NewCFunctionData(isl_ctx, isl_bridge_settle, 1, 0, 1, data);
  JSValue on_r = JS_NewCFunctionData(isl_ctx, isl_bridge_settle, 1, 1, 1, data);
  JS_FreeValue(isl_ctx, box); /* each callback's func_data holds its own ref */
  JSValue args[3] = {v->v, on_f, on_r};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_THEN], JS_UNDEFINED, 3, args);
  JS_FreeValue(isl_ctx, on_f);
  JS_FreeValue(isl_ctx, on_r);
  if (JS_IsException(r)) {
    /* Promise.resolve().then on well-formed callbacks cannot throw; an
     * engine-level surprise (OOM) bridges like any exception. */
    isl_bridge_exception();
    scr_promise_release(p);
    return NULL;
  }
  JS_FreeValue(isl_ctx, r);
  return p;
}

/* Island-native literals. JS_SetProperty/JS_SetPropertyUint32 CONSUME the
 * value — dup, the caller's cells keep their own references. JS_ValueToAtom
 * borrows. */
ScrJsval *scr_jsval_obj_lit(int npairs, ScrJsval **kv) {
  isl_entry();
  JSValue o = JS_NewObject(isl_ctx);
  for (int i = 0; i < npairs; i++) {
    JSAtom k = JS_ValueToAtom(isl_ctx, kv[2 * i]->v);
    JS_SetProperty(isl_ctx, o, k, JS_DupValue(isl_ctx, kv[2 * i + 1]->v));
    JS_FreeAtom(isl_ctx, k);
  }
  return isl_cell_new(o);
}

/* The engine-native TemplateStringsArray for an island tag call: `kv`
 * carries n cooked strings then n raw strings — a fresh array whose
 * `.raw` property holds the raw spellings, exactly the object a tagged
 * template hands its tag (a JSON marshal would drop `.raw`, and tags
 * dispatch on it). */
ScrJsval *scr_jsval_tpl_strings(int n, ScrJsval **kv) {
  isl_entry();
  JSValue cooked = JS_NewArray(isl_ctx);
  JSValue raw = JS_NewArray(isl_ctx);
  for (int i = 0; i < n; i++) {
    JS_SetPropertyUint32(isl_ctx, cooked, (uint32_t)i, JS_DupValue(isl_ctx, kv[i]->v));
    JS_SetPropertyUint32(isl_ctx, raw, (uint32_t)i, JS_DupValue(isl_ctx, kv[n + i]->v));
  }
  JS_SetPropertyStr(isl_ctx, cooked, "raw", raw); /* consumes raw */
  return isl_cell_new(cooked);
}

/* Spread completion for an island-native literal: copies `src`'s own
 * enumerable properties onto `obj` — the engine's own Object.assign (the
 * spec's CopyDataProperties; null/undefined sources spread nothing) — and
 * answers the target retained (+1). NULL with the exception pending when
 * a source getter throws. */
ScrJsval *scr_jsval_obj_spread(ScrJsval *obj, ScrJsval *src) {
  isl_entry();
  if (JS_IsNull(src->v) || JS_IsUndefined(src->v)) return scr_jsval_retain(obj);
  JSValue global = JS_GetGlobalObject(isl_ctx);
  JSValue object_ctor = JS_GetPropertyStr(isl_ctx, global, "Object");
  JS_FreeValue(isl_ctx, global);
  JSValue assign = JS_GetPropertyStr(isl_ctx, object_ctor, "assign");
  JS_FreeValue(isl_ctx, object_ctor);
  JSValueConst args[2] = { obj->v, src->v };
  JSValue r = JS_Call(isl_ctx, assign, JS_UNDEFINED, 2, args);
  JS_FreeValue(isl_ctx, assign);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  JS_FreeValue(isl_ctx, r); /* assign answers the target itself */
  return scr_jsval_retain(obj);
}

/* Getter completion for an island-native literal: defines `key` on `obj`
 * as an engine GETTER invoking `fn` (a marshaled host function), and
 * answers the object retained (+1) so builds chain. Enumerable +
 * configurable, no setter — exactly a JS object-literal `get k() {}`. */
ScrJsval *scr_jsval_define_getter(ScrJsval *obj, ScrJsval *key, ScrJsval *fn) {
  isl_entry();
  JSAtom k = JS_ValueToAtom(isl_ctx, key->v);
  JS_DefinePropertyGetSet(isl_ctx, obj->v, k, JS_DupValue(isl_ctx, fn->v), JS_UNDEFINED,
                          JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE);
  JS_FreeAtom(isl_ctx, k);
  return scr_jsval_retain(obj);
}

ScrJsval *scr_jsval_arr_lit(int n, ScrJsval **elems) {
  isl_entry();
  JSValue a = JS_NewArray(isl_ctx);
  for (int i = 0; i < n; i++) {
    JS_SetPropertyUint32(isl_ctx, a, (uint32_t)i, JS_DupValue(isl_ctx, elems[i]->v));
  }
  return isl_cell_new(a);
}

/* The ISLAND-REST pack a DYN-BOXED closure's call thunk hands its
 * trailing jsval slot: the surplus dyn arguments (index `from` on)
 * marshalled into one fresh ENGINE array, so the closure's `...args`
 * binding is the engine's own array on this path too — the same shape
 * isl_hostfn_invoke builds for the host-call path and the direct call
 * builds inline from an arrLit. NULL with the exception pending when an
 * argument has no crossing (scr_jsval_from_dyn's refusal). */
ScrJsval *scr_jsval_rest_from_dyn(ScrDyn *const *args, size_t from, size_t argc) {
  isl_entry();
  JSValue a = JS_NewArray(isl_ctx);
  for (size_t i = from; i < argc; i++) {
    ScrJsval *cell = scr_jsval_from_dyn(args[i]);
    if (!cell) {
      JS_FreeValue(isl_ctx, a);
      return NULL;
    }
    JS_SetPropertyUint32(isl_ctx, a, (uint32_t)(i - from), JS_DupValue(isl_ctx, cell->v));
    scr_jsval_release(cell);
  }
  return isl_cell_new(a);
}

/* ── the module system (embedded npm code) ────────────────────────────
 * The engine's module loader and a CommonJS require shim, both resolving
 * exclusively from the emitted tables (isl_mods/isl_edges — no filesystem).
 * ESM sources compile natively; CJS modules run through a JS require shim
 * (new Function over the embedded source, module.exports cached) and enter
 * the ESM graph through an ESM facade SYNTHESIZED AT BUILD TIME (the
 * ScrIslandModule's esm field): default is module.exports itself and the
 * named exports are the ones the compiler's port of Node's vendored CJS
 * lexer found in the source, so `import { x } from 'cjs'` inside the
 * embedded graph links exactly like Node — including the REFUSALS: a name
 * the lexer cannot see is absent from the facade and the engine's
 * instantiate fails where Node's would. The import BOUNDARY below additionally
 * takes named exports off module.exports directly, so user-level named
 * imports of CJS-only packages work like Node too.
 * Node builtins are served as wrappers over island shims defined in the
 * bootstrap: events, path, process, os, diagnostics_channel, fs (stubs),
 * child_process (throwing stubs), module (createRequire over the embedded
 * tables), url (fileURLToPath/pathToFileURL). The process shim bridges REAL
 * argv/env/stdout/stderr/exit
 * through host functions, argv in the same ["scriptc", argv[0], ...]
 * shape as the static world's process.argv. */

/* mingw-w64 ships a unistd.h too (getcwd, isatty — scr_lib.c leans on the
 * same one); the process-surface hooks below otherwise delegate to the
 * scr_lib.c helpers, whose win32 arms already exist. winsock2.h is the
 * hostname hook's gethostname on win32. */
#include <unistd.h>
/* the fs bridge's constants hook (O_* open flags, S_IF* type bits), the
 * readlink op's errno, and os.constants' signal table */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#ifdef _WIN32
#include <winsock2.h>
#endif

#define ISL_IMPORT_BASE "<scr-import>"

static bool isl_booted = false;
static JSValue isl_cjs_import; /* (key, name) → export, CJS/JSON entries */

static char *isl_module_normalize(JSContext *ctx, const char *base,
                                  const char *name, void *opaque) {
  (void)opaque;
  const char *target = NULL;
  if (strncmp(name, "node:", 5) == 0) {
    target = name; /* builtins are their own keys */
  } else if (strcmp(base, ISL_IMPORT_BASE) == 0) {
    target = name; /* the import boundary passes resolved keys */
  } else {
    target = isl_edge_find(base, name, 1 /* import */);
  }
  if (!target) {
    JS_ThrowReferenceError(ctx,
                           "cannot resolve module '%s' from '%s' "
                           "(scriptc embeds npm code at build time)",
                           name, base);
    return NULL;
  }
  return js_strdup(ctx, target);
}

/* Named export lists for the builtin ESM wrappers, generated from
 * packages/runtime/src/island-js/builtin-exports.json — the table the
 * Rust island shares (scripts/gen-island-bootstrap.mjs). */
#include "scr_island_builtins.h"

static JSModuleDef *isl_module_load(JSContext *ctx, const char *name, void *opaque) {
  (void)opaque;
  const char *src = NULL;
  size_t len = 0;
  /* Sized for the widest wrapper: node:util/types' export list alone is
   * ~700 bytes. */
  char buf[2048];
  char *heap = NULL;
  if (strncmp(name, "node:", 5) == 0) {
    const char *exports = NULL;
    for (size_t i = 0; i < sizeof isl_builtins / sizeof isl_builtins[0]; i++) {
      if (strcmp(isl_builtins[i].name, name) == 0) {
        exports = isl_builtins[i].exports;
        break;
      }
    }
    if (!exports) {
      JS_ThrowReferenceError(ctx, "the island does not provide the '%s' builtin", name);
      return NULL;
    }
    snprintf(buf, sizeof buf,
             "const m=globalThis.__scr_require(\"%s\");export default m;"
             "export const{%s}=m;",
             name, exports);
    src = buf;
    len = strlen(buf);
  } else {
    const ScrIslandModule *m = isl_mod_find(name);
    if (!m) {
      JS_ThrowReferenceError(ctx, "module '%s' is not embedded", name);
      return NULL;
    }
    if (m->format == 0) {
      src = isl_mod_text(m, false, &len);
      if (!src) {
        JS_ThrowInternalError(ctx, "embedded module '%s' failed to inflate", name);
        return NULL;
      }
    } else if (m->esm) {
      /* CJS entering the ESM graph: the facade synthesized at BUILD time —
       * default plus the lexed named exports (Node's interop exactly). */
      src = isl_mod_text(m, true, &len);
      if (!src) {
        JS_ThrowInternalError(ctx, "embedded module '%s' failed to inflate", name);
        return NULL;
      }
    } else {
      /* JSON (or a facade-less CJS module from an older emitter) entering
       * the ESM graph: Node's default-only interop. */
      size_t n = strlen(name) + 64;
      heap = malloc(n);
      if (!heap) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
      }
      snprintf(heap, n, "const m=globalThis.__scr_require(\"%s\");export default m;", name);
      src = heap;
      len = strlen(heap);
    }
  }
  JSValue v = JS_Eval(ctx, src, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
  free(heap);
  if (JS_IsException(v)) return NULL;
  JSModuleDef *def = JS_VALUE_GET_PTR(v);
  /* import.meta.url — Node sets the module's file:// URL; embedded keys
   * are realpaths, builtins keep their node: name. Emscripten factory
   * modules read it (_scriptName, createRequire(import.meta.url)). */
  JSValue meta = JS_GetImportMeta(ctx, def);
  if (!JS_IsException(meta)) {
    JSValue url;
    if (name[0] == '/') {
      size_t n = strlen(name) + 8;
      char *buf2 = malloc(n);
      if (buf2) {
        snprintf(buf2, n, "file://%s", name);
        url = JS_NewString(ctx, buf2);
        free(buf2);
      } else {
        url = JS_NewString(ctx, name);
      }
    } else {
      url = JS_NewString(ctx, name);
    }
    JS_SetPropertyStr(ctx, meta, "url", url); /* consumed */
    JS_FreeValue(ctx, meta);
  }
  JS_FreeValue(ctx, v);
  return def;
}

/* ── host functions for the bootstrap ─────────────────────────────────
 * The engine's ownership rules: argv values are borrowed, results owned. */

static JSValue isl_host_source(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *key = JS_ToCString(ctx, argv[0]);
  if (!key) return JS_EXCEPTION;
  const ScrIslandModule *m = isl_mod_find(key);
  if (!m) {
    JS_FreeCString(ctx, key);
    return JS_UNDEFINED;
  }
  size_t len = 0;
  const char *src = isl_mod_text(m, false, &len);
  if (!src) {
    JSValue e = JS_ThrowInternalError(ctx, "embedded module '%s' failed to inflate", key);
    JS_FreeCString(ctx, key);
    return e;
  }
  JS_FreeCString(ctx, key);
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewStringLen(ctx, src, len));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, m->format));
  return arr;
}

static JSValue isl_host_resolve(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *from = JS_ToCString(ctx, argv[0]);
  const char *spec = from ? JS_ToCString(ctx, argv[1]) : NULL;
  if (!from || !spec) {
    if (from) JS_FreeCString(ctx, from);
    return JS_EXCEPTION;
  }
  /* host.resolve serves the require shim exclusively — require kind. */
  const char *to = strncmp(spec, "node:", 5) == 0 ? spec : isl_edge_find(from, spec, 2);
  JSValue r = to ? JS_NewString(ctx, to) : JS_UNDEFINED;
  JS_FreeCString(ctx, from);
  JS_FreeCString(ctx, spec);
  return r;
}

static JSValue isl_host_argv(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* The static world's shape exactly: ["scriptc", argv[0], argv[1], ...]. */
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewString(ctx, "scriptc"));
  int n = scr_lib_arg_count();
  for (int i = 0; i < n; i++) {
    JS_SetPropertyUint32(ctx, arr, (uint32_t)(i + 1), JS_NewString(ctx, scr_lib_arg(i)));
  }
  return arr;
}

static JSValue isl_host_env(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* scr_env_pairs (scr_lib.c): the SAME snapshot the static world's
   * process.env builds from — environ order on POSIX, the WIN32
   * environment block (hidden "=C:" per-drive entries skipped, exactly
   * libuv) on Windows. ScrStr data is NUL-terminated, so the key can go
   * straight into JS_SetPropertyStr. */
  JSValue obj = JS_NewObject(ctx);
  ScrArr *pairs = scr_env_pairs();
  size_t n = (size_t)scr_arr_len(pairs);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *k = scr_arr_get_ref(pairs, (double)i);
    ScrStr *v = scr_arr_get_ref(pairs, (double)(i + 1));
    JS_SetPropertyStr(ctx, obj, k->data, JS_NewStringLen(ctx, v->data, v->len));
    scr_str_release(k);
    scr_str_release(v);
  }
  scr_arr_release(pairs);
  return obj;
}

static JSValue isl_host_write(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t fd = 1;
  JS_ToInt32(ctx, &fd, argv[0]);
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, argv[1]);
  if (!s) return JS_EXCEPTION;
  scr_stdio_write(fd, s, len);
  JS_FreeCString(ctx, s);
  return JS_TRUE;
}

/* Whole-input stdin read (fd 0 to EOF), returned as an ArrayBuffer — the
 * island's process.stdin Readable pushes it as one Buffer chunk on first
 * pull. Blocking, like Node's stdin read when a pipe's writer is slow;
 * a TTY caller that never reads (get-stdin's isTTY early-return) never
 * gets here. Bytes, not text: invalid UTF-8 must round-trip. */
static JSValue isl_host_read_stdin(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  size_t cap = 65536;
  size_t len = 0;
  uint8_t *buf = malloc(cap);
  if (!buf) return JS_ThrowOutOfMemory(ctx);
  for (;;) {
    if (len == cap) {
      cap *= 2;
      uint8_t *next = realloc(buf, cap);
      if (!next) {
        free(buf);
        return JS_ThrowOutOfMemory(ctx);
      }
      buf = next;
    }
    ssize_t n = read(0, buf + len, cap - len);
    if (n < 0) {
      if (errno == EINTR) continue;
      free(buf);
      return JS_ThrowTypeError(ctx, "reading stdin failed: %s", strerror(errno));
    }
    if (n == 0) break;
    len += (size_t)n;
  }
  JSValue ab = JS_NewArrayBufferCopy(ctx, buf, len);
  free(buf);
  return ab;
}

static JSValue isl_host_exit(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t code = 0;
  JS_ToInt32(ctx, &code, argv[0]);
  /* Node's process.exit: no unwinding, no destructors — and no atexit
   * teardown here either (tearing the engine down from inside JS_Call
   * would free live frames). The RC/engine audits are documented to not
   * run on this path. */
  fflush(NULL);
  _exit(code);
}

/* The island process shim's implicit exit status (process.exitCode):
 * mirrored here by the shim's setter, read by the emitted main after the
 * loop drains — Node's a-program-that-sets-it-and-returns contract. */
static size_t isl_exit_code_version = 0;

int scr_island_exit_code(void) { return scr_process_exit_code_get(); }
size_t scr_island_exit_code_version(void) { return isl_exit_code_version; }

static JSValue isl_host_set_exit_code(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t code = 0;
  JS_ToInt32(ctx, &code, argv[0]);
  scr_process_exit_code_set((double)code);
  isl_exit_code_version++;
  return JS_UNDEFINED;
}

static JSValue isl_host_isatty(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t fd = 1;
  JS_ToInt32(ctx, &fd, argv[0]);
  return JS_NewBool(ctx, isatty(fd) == 1);
}

static JSValue isl_host_columns(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t fd = 1;
  JS_ToInt32(ctx, &fd, argv[0]);
  /* scr_process_columns (scr_lib.c): ioctl(TIOCGWINSZ) on POSIX,
   * GetConsoleScreenBufferInfo on Windows — the static world's
   * process.stdout.columns source of truth; -1 (non-TTY / refused)
   * stays this hook's historical 0. */
  double cols = scr_process_columns((double)fd);
  return JS_NewInt32(ctx, cols > 0 ? (int32_t)cols : 0);
}

static JSValue isl_host_cwd(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  char buf[4096];
  if (!getcwd(buf, sizeof buf)) buf[0] = '\0';
  return JS_NewString(ctx, buf);
}

static JSValue isl_host_platform(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *p = scr_process_platform(); /* +1 interned; matches the static world */
  JSValue r = JS_NewStringLen(ctx, p->data, p->len);
  scr_str_release(p);
  return r;
}

/* os.homedir()/os.tmpdir() bridge to the SAME runtime functions the static
 * lowerings call (scr_lib.c) — one implementation, one answer. */
static JSValue isl_host_homedir(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *s = scr_os_homedir(); /* +1 */
  JSValue r = JS_NewStringLen(ctx, s->data, s->len);
  scr_str_release(s);
  return r;
}

static JSValue isl_host_tmpdir(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *s = scr_os_tmpdir(); /* +1 */
  JSValue r = JS_NewStringLen(ctx, s->data, s->len);
  scr_str_release(s);
  return r;
}

static JSValue isl_host_arch(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* Node's process.arch/os.arch() names, decided at compile time. */
#if defined(__aarch64__) || defined(__arm64__)
  return JS_NewString(ctx, "arm64");
#elif defined(__x86_64__)
  return JS_NewString(ctx, "x64");
#elif defined(__i386__)
  return JS_NewString(ctx, "ia32");
#else
  return JS_NewString(ctx, "unknown");
#endif
}

/* The fs bridge: one dispatcher over the SAME scr_fs_* implementations
 * the static lowerings call (Node-shaped errors including the errno-name
 * code cross through isl_throw_pending). String args arrive as engine
 * strings, data as Uint8Arrays; stats come back as a compact array the
 * JS shim shapes into Node's Stats. */
static ScrStr *isl_arg_str(JSContext *ctx, JSValueConst v) {
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, v);
  if (!s) return NULL;
  ScrStr *out = scr_str_new(s, len);
  JS_FreeCString(ctx, s);
  return out;
}

static JSValue isl_host_fs(JSContext *ctx, JSValueConst this_val, int argc,
                           JSValueConst *argv) {
  (void)this_val;
  const char *op = JS_ToCString(ctx, argv[0]);
  if (!op) return JS_EXCEPTION;
  JSValue ret = JS_UNDEFINED;
  ScrStr *a = NULL;
  ScrStr *b = NULL;
  if (argc > 1 && JS_IsString(argv[1])) {
    a = isl_arg_str(ctx, argv[1]);
    if (!a) {
      JS_FreeCString(ctx, op);
      return JS_EXCEPTION;
    }
  }
  if (strcmp(op, "readFile") == 0) {
    ScrBytes *data = scr_fs_read_file_bytes(a);
    if (data) {
      ret = JS_NewUint8ArrayCopy(ctx, data->data, (size_t)scr_bytes_len(data));
      scr_bytes_release(data);
    }
  } else if (strcmp(op, "writeFile") == 0 || strcmp(op, "appendFile") == 0) {
    size_t len = 0;
    uint8_t *buf = JS_GetUint8Array(ctx, &len, argv[2]);
    if (buf || len == 0) {
      ScrStr *data = scr_str_new((const char *)buf, len);
      if (strcmp(op, "writeFile") == 0) scr_fs_write_file(a, data);
      else scr_fs_append_file(a, data);
      scr_str_release(data);
    } else {
      ret = JS_EXCEPTION;
    }
  } else if (strcmp(op, "exists") == 0) {
    ret = JS_NewBool(ctx, scr_fs_exists(a));
  } else if (strcmp(op, "realpath") == 0) {
    ScrStr *r = scr_fs_realpath(a);
    if (r) {
      ret = JS_NewStringLen(ctx, r->data, r->len);
      scr_str_release(r);
    }
  } else if (strcmp(op, "mkdir") == 0) {
    int32_t recursive = 0;
    double mode = -1;
    JS_ToInt32(ctx, &recursive, argv[2]);
    JS_ToFloat64(ctx, &mode, argv[3]);
    if (mode < 0) {
      if (recursive) scr_fs_mkdir_recursive(a);
      else scr_fs_mkdir(a);
    } else {
      if (recursive) scr_fs_mkdir_recursive_mode(a, mode);
      else scr_fs_mkdir_mode(a, mode);
    }
  } else if (strcmp(op, "rm") == 0) {
    int32_t recursive = 0;
    int32_t force = 0;
    JS_ToInt32(ctx, &recursive, argv[2]);
    JS_ToInt32(ctx, &force, argv[3]);
    scr_fs_rm_opts(a, recursive != 0, force != 0);
  } else if (strcmp(op, "rmdir") == 0) {
    scr_fs_rmdir(a);
  } else if (strcmp(op, "unlink") == 0) {
    scr_fs_unlink(a);
  } else if (strcmp(op, "readdir") == 0) {
    ScrArr *names = scr_fs_readdir(a);
    if (names) {
      JSValue arr = JS_NewArray(ctx);
      size_t n = (size_t)scr_arr_len(names);
      for (size_t i = 0; i < n; i++) {
        ScrStr *name = scr_arr_get_ref(names, (double)i);
        JS_SetPropertyUint32(ctx, arr, (uint32_t)i, JS_NewStringLen(ctx, name->data, name->len));
        scr_str_release(name);
      }
      scr_arr_release(names);
      ret = arr;
    }
  } else if (strcmp(op, "scandir") == 0) {
    ScrScandir *s = scr_fs_scandir(a);
    if (s) {
      JSValue arr = JS_NewArray(ctx);
      size_t n = scr_fs_scandir_count(s);
      for (size_t i = 0; i < n; i++) {
        ScrStr *name = scr_fs_scandir_name(s, i);
        JS_SetPropertyUint32(ctx, arr, (uint32_t)(i * 2), JS_NewStringLen(ctx, name->data, name->len));
        JS_SetPropertyUint32(ctx, arr, (uint32_t)(i * 2 + 1), JS_NewFloat64(ctx, scr_fs_scandir_type(s, i)));
        scr_str_release(name);
      }
      scr_fs_scandir_free(s);
      ret = arr;
    }
  } else if (strcmp(op, "stat") == 0 || strcmp(op, "lstat") == 0) {
    ScrStats *st = strcmp(op, "stat") == 0 ? scr_fs_stat(a) : scr_fs_lstat(a);
    if (st) {
      JSValue arr = JS_NewArray(ctx);
      JS_SetPropertyUint32(ctx, arr, 0, JS_NewBool(ctx, scr_stats_is_file(st)));
      JS_SetPropertyUint32(ctx, arr, 1, JS_NewBool(ctx, scr_stats_is_dir(st)));
      JS_SetPropertyUint32(ctx, arr, 2, JS_NewBool(ctx, scr_stats_is_symlink(st)));
      JS_SetPropertyUint32(ctx, arr, 3, JS_NewFloat64(ctx, scr_stats_size(st)));
      JS_SetPropertyUint32(ctx, arr, 4, JS_NewFloat64(ctx, scr_stats_mtime_ms(st)));
      JS_SetPropertyUint32(ctx, arr, 5, JS_NewFloat64(ctx, scr_stats_blocks(st)));
      JS_SetPropertyUint32(ctx, arr, 6, JS_NewFloat64(ctx, scr_stats_nlink(st)));
      JS_SetPropertyUint32(ctx, arr, 7, JS_NewFloat64(ctx, scr_stats_atime_ms(st)));
      scr_stats_release(st);
      ret = arr;
    }
  } else if (strcmp(op, "access") == 0) {
    double mode = 0;
    JS_ToFloat64(ctx, &mode, argv[2]);
    scr_fs_access(a, mode);
  } else if (strcmp(op, "mkdtemp") == 0) {
    ScrStr *r = scr_fs_mkdtemp(a);
    if (r) {
      ret = JS_NewStringLen(ctx, r->data, r->len);
      scr_str_release(r);
    }
  } else if (strcmp(op, "chmod") == 0) {
    double mode = 0;
    JS_ToFloat64(ctx, &mode, argv[2]);
    scr_fs_chmod(a, mode);
  } else if (strcmp(op, "readlink") == 0) {
#ifdef _WIN32
    scr_fs_throw(EINVAL, "readlink", a);
#else
    char buf[4096];
    ssize_t n = readlink(a->data, buf, sizeof buf - 1);
    if (n < 0) {
      scr_fs_throw(errno, "readlink", a);
    } else {
      ret = JS_NewStringLen(ctx, buf, (size_t)n);
    }
#endif
  } else if (strcmp(op, "copyFile") == 0 || strcmp(op, "rename") == 0) {
    b = isl_arg_str(ctx, argv[2]);
    if (b) {
      if (strcmp(op, "copyFile") == 0) scr_fs_copyfile(a, b);
      else scr_fs_rename(a, b);
    } else {
      ret = JS_EXCEPTION;
    }
  } else {
    JS_FreeCString(ctx, op);
    if (a) scr_str_release(a);
    return JS_ThrowReferenceError(ctx, "unknown island fs op");
  }
  JS_FreeCString(ctx, op);
  if (a) scr_str_release(a);
  if (b) scr_str_release(b);
  if (JS_IsException(ret)) return ret;
  if (scr_exc_pending()) {
    JS_FreeValue(ctx, ret);
    return isl_throw_pending(ctx);
  }
  return ret;
}

/* The path bridge: both of Node's implementations live in scr_path.c
 * (the posix family and the byte-exact win32 port) — the island's path
 * module rides them instead of re-porting. join/resolve pass the call's
 * strings as an engine array. */
static JSValue isl_host_path(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *op = JS_ToCString(ctx, argv[0]);
  if (!op) return JS_EXCEPTION;
  int win32 = JS_ToBool(ctx, argv[1]);
  JSValue ret = JS_UNDEFINED;
  if (strcmp(op, "join") == 0 || strcmp(op, "resolve") == 0) {
    JSValue lenv = JS_GetPropertyStr(ctx, argv[2], "length");
    uint32_t n = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);
    ScrArr *parts = scr_arr_new(SCR_ELEM_STR, n);
    bool ok = true;
    for (uint32_t i = 0; i < n; i++) {
      JSValue el = JS_GetPropertyUint32(ctx, argv[2], i);
      ScrStr *s = isl_arg_str(ctx, el);
      JS_FreeValue(ctx, el);
      if (!s) {
        ok = false;
        break;
      }
      scr_arr_push_ref(parts, s);
    }
    if (ok) {
      ScrStr *r = strcmp(op, "join") == 0
                      ? (win32 ? scr_path_win32_join(parts) : scr_path_join(parts))
                      : (win32 ? scr_path_win32_resolve(parts) : scr_path_resolve(parts));
      ret = JS_NewStringLen(ctx, r->data, r->len);
      scr_str_release(r);
    } else {
      ret = JS_EXCEPTION;
    }
    scr_arr_release(parts);
  } else {
    ScrStr *a = isl_arg_str(ctx, argv[2]);
    if (!a) {
      JS_FreeCString(ctx, op);
      return JS_EXCEPTION;
    }
    if (strcmp(op, "isAbsolute") == 0) {
      ret = JS_NewBool(ctx, win32 ? scr_path_win32_is_absolute(a) : scr_path_is_absolute(a));
    } else if (strcmp(op, "basename") == 0) {
      ScrStr *suffix = isl_arg_str(ctx, argv[3]);
      if (suffix) {
        ScrStr *r = win32 ? scr_path_win32_basename(a, suffix) : scr_path_basename(a, suffix);
        ret = JS_NewStringLen(ctx, r->data, r->len);
        scr_str_release(r);
        scr_str_release(suffix);
      } else {
        ret = JS_EXCEPTION;
      }
    } else if (strcmp(op, "relative") == 0) {
      ScrStr *to = isl_arg_str(ctx, argv[3]);
      if (to) {
        ScrStr *r = win32 ? scr_path_win32_relative(a, to) : scr_path_relative(a, to);
        ret = JS_NewStringLen(ctx, r->data, r->len);
        scr_str_release(r);
        scr_str_release(to);
      } else {
        ret = JS_EXCEPTION;
      }
    } else {
      ScrStr *r = NULL;
      if (strcmp(op, "normalize") == 0) r = win32 ? scr_path_win32_normalize(a) : scr_path_normalize(a);
      else if (strcmp(op, "dirname") == 0) r = win32 ? scr_path_win32_dirname(a) : scr_path_dirname(a);
      else if (strcmp(op, "extname") == 0) r = win32 ? scr_path_win32_extname(a) : scr_path_extname(a);
      else if (strcmp(op, "toNamespacedPath") == 0) r = win32 ? scr_path_win32_to_namespaced_path(a) : scr_path_to_namespaced_path(a);
      if (r) {
        ret = JS_NewStringLen(ctx, r->data, r->len);
        scr_str_release(r);
      } else {
        ret = JS_ThrowReferenceError(ctx, "unknown island path op");
      }
    }
    scr_str_release(a);
  }
  JS_FreeCString(ctx, op);
  return ret;
}

/* The zlib bridge: function pointers scr_zlib_island.c installs (from
 * the emitted main, exactly when the embedded graph imports node:zlib —
 * the isl_fetch_boot registration precedent). The hooks always exist;
 * unlinked builds get a clear refusal at the call. */
static ScrBytes *(*isl_zlib_deflate)(const ScrBytes *, double, double) = NULL;
static ScrBytes *(*isl_zlib_inflate)(const ScrBytes *, double) = NULL;

void scr_island_set_zlib(ScrBytes *(*deflate)(const ScrBytes *, double, double),
                         ScrBytes *(*inflate)(const ScrBytes *, double)) {
  isl_zlib_deflate = deflate;
  isl_zlib_inflate = inflate;
}

static JSValue isl_host_zlib(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t deflating = 0;
  int32_t mode = 0;
  double level = -1;
  JS_ToInt32(ctx, &deflating, argv[0]);
  JS_ToInt32(ctx, &mode, argv[2]);
  JS_ToFloat64(ctx, &level, argv[3]);
  if ((deflating ? isl_zlib_deflate : isl_zlib_inflate) == NULL) {
    return JS_ThrowReferenceError(ctx, "zlib is not linked into this binary");
  }
  size_t len = 0;
  uint8_t *data = JS_GetUint8Array(ctx, &len, argv[1]);
  if (!data && len) return JS_EXCEPTION;
  ScrBytes *in = scr_bytes_new(SCR_BYTES_U8, (double)len);
  memcpy(in->data, data, len);
  ScrBytes *out = deflating ? isl_zlib_deflate(in, (double)mode, level)
                            : isl_zlib_inflate(in, (double)mode);
  scr_bytes_release(in);
  if (!out) return isl_throw_pending(ctx);
  JSValue r = JS_NewUint8ArrayCopy(ctx, out->data, (size_t)scr_bytes_len(out));
  scr_bytes_release(out);
  return r;
}

/* url.fileURLToPath / url.pathToFileURL over the static converters
 * (scr_url.c) — Node's exact percent-decoding/encoding and host rules,
 * the win32 arms on win32 targets. Failures cross as the converters'
 * catchable TypeErrors. */
static JSValue isl_host_url_to_path(JSContext *ctx, JSValueConst this_val, int argc,
                                    JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  ScrStr *s = isl_arg_str(ctx, argv[0]);
  if (!s) return JS_EXCEPTION;
#ifdef _WIN32
  ScrUrl *u = scr_url_new(s);
  ScrStr *r = u ? scr_url_to_path_w32(u) : NULL;
  if (u) scr_url_release(u);
#else
  ScrStr *r = scr_url_str_to_path(s);
#endif
  scr_str_release(s);
  if (!r) return isl_throw_pending(ctx);
  JSValue out = JS_NewStringLen(ctx, r->data, r->len);
  scr_str_release(r);
  return out;
}

static JSValue isl_host_url_from_path(JSContext *ctx, JSValueConst this_val, int argc,
                                      JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  ScrStr *s = isl_arg_str(ctx, argv[0]);
  if (!s) return JS_EXCEPTION;
#ifdef _WIN32
  ScrUrl *u = scr_url_from_path_w32(s);
#else
  ScrUrl *u = scr_url_from_path(s);
#endif
  scr_str_release(s);
  if (!u) return isl_throw_pending(ctx);
  ScrStr *href = scr_url_href(u);
  scr_url_release(u);
  JSValue out = JS_NewStringLen(ctx, href->data, href->len);
  scr_str_release(href);
  return out;
}

/* fs.constants (and the legacy `constants` module's fs half): the REAL
 * macro values of the target platform — access modes, open flags, and
 * the S_IF* type bits. */
static JSValue isl_host_fs_constants(JSContext *ctx, JSValueConst this_val, int argc,
                                     JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  JSValue o = JS_NewObject(ctx);
#define ISL_CONST(name) JS_SetPropertyStr(ctx, o, #name, JS_NewInt32(ctx, name))
  ISL_CONST(F_OK);
  ISL_CONST(R_OK);
  ISL_CONST(W_OK);
#ifdef X_OK
  ISL_CONST(X_OK);
#else /* mingw CRTs without an execute bit: Node's win32 X_OK is 1 */
  JS_SetPropertyStr(ctx, o, "X_OK", JS_NewInt32(ctx, 1));
#endif
  ISL_CONST(O_RDONLY);
  ISL_CONST(O_WRONLY);
  ISL_CONST(O_RDWR);
  ISL_CONST(O_CREAT);
  ISL_CONST(O_EXCL);
  ISL_CONST(O_TRUNC);
  ISL_CONST(O_APPEND);
#ifdef O_NONBLOCK
  ISL_CONST(O_NONBLOCK);
#endif
#ifdef O_SYMLINK
  ISL_CONST(O_SYMLINK);
#endif
#ifdef S_IFMT
  ISL_CONST(S_IFMT);
  ISL_CONST(S_IFREG);
  ISL_CONST(S_IFDIR);
  ISL_CONST(S_IFCHR);
#endif
#ifdef S_IFLNK
  ISL_CONST(S_IFLNK);
#endif
#ifdef S_IFIFO
  ISL_CONST(S_IFIFO);
#endif
#ifdef S_IFSOCK
  ISL_CONST(S_IFSOCK);
#endif
#ifdef S_IFBLK
  ISL_CONST(S_IFBLK);
#endif
  JS_SetPropertyStr(ctx, o, "COPYFILE_EXCL", JS_NewInt32(ctx, 1));
  JS_SetPropertyStr(ctx, o, "COPYFILE_FICLONE", JS_NewInt32(ctx, 2));
  JS_SetPropertyStr(ctx, o, "COPYFILE_FICLONE_FORCE", JS_NewInt32(ctx, 4));
#undef ISL_CONST
  return o;
}

/* crypto.createHash/createHmac bridge: one-shot digests over the same
 * FIPS implementations the static lowerings use (plus MD5, scr_lib.c) —
 * the shim concatenates update() chunks JS-side and asks once at
 * digest(). undefined for an unknown algorithm (the shim throws Node's
 * shape). */
static JSValue isl_host_digest(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *alg = JS_ToCString(ctx, argv[0]);
  if (!alg) return JS_EXCEPTION;
  size_t len = 0;
  uint8_t *data = JS_GetUint8Array(ctx, &len, argv[1]);
  if (!data && len) {
    JS_FreeCString(ctx, alg);
    return JS_EXCEPTION;
  }
  unsigned char out[64];
  size_t n = scr_crypto_digest_raw(alg, data, len, out);
  JS_FreeCString(ctx, alg);
  return n == 0 ? JS_UNDEFINED : JS_NewUint8ArrayCopy(ctx, out, n);
}

static JSValue isl_host_hmac(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *alg = JS_ToCString(ctx, argv[0]);
  if (!alg) return JS_EXCEPTION;
  size_t keylen = 0;
  size_t len = 0;
  uint8_t *key = JS_GetUint8Array(ctx, &keylen, argv[1]);
  uint8_t *data = JS_GetUint8Array(ctx, &len, argv[2]);
  if ((!key && keylen) || (!data && len)) {
    JS_FreeCString(ctx, alg);
    return JS_EXCEPTION;
  }
  unsigned char out[64];
  size_t n = scr_crypto_hmac_raw(alg, key, keylen, data, len, out);
  JS_FreeCString(ctx, alg);
  return n == 0 ? JS_UNDEFINED : JS_NewUint8ArrayCopy(ctx, out, n);
}

static JSValue isl_host_pid(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* Node's process.pid — util.deprecate/debuglog print it in their
   * stderr prefixes. mingw-w64's process.h declares getpid too. */
  return JS_NewInt32(ctx, (int32_t)getpid());
}

/* process.version(s) — the SAME compat-target answers the static world's
 * process.versions gives (scr_lib.c), as [node, openssl]. */
static JSValue isl_host_versions(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *node = scr_process_versions_node();
  ScrStr *openssl = scr_process_versions_openssl();
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewStringLen(ctx, node->data, node->len));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewStringLen(ctx, openssl->data, openssl->len));
  scr_str_release(node);
  scr_str_release(openssl);
  return arr;
}

/* process.hrtime's monotonic nanosecond clock, as [seconds, nanos]. */
static JSValue isl_host_hrtime(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  double ms = scr_now_ms();
  JSValue arr = JS_NewArray(ctx);
  double sec = ms / 1000.0;
  double whole = (double)(int64_t)sec;
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewFloat64(ctx, whole));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewFloat64(ctx, (double)(int64_t)((sec - whole) * 1e9)));
  return arr;
}

/* os.userInfo's uid/gid halves (-1 on win32, like Node). */
static JSValue isl_host_ids(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  JSValue arr = JS_NewArray(ctx);
#if defined(_WIN32) || defined(__wasi__)
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, -1));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, -1));
#else
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, (int32_t)getuid()));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, (int32_t)getgid()));
#endif
  return arr;
}

/* os.constants' signals table: the REAL signal numbers of the target. */
/* process.umask() — the read form: read-and-restore on POSIX; Node on
 * Windows answers 0 (no umask concept behind CreateFile). */
static JSValue isl_host_umask(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
#if defined(_WIN32) || defined(__wasi__)
  return JS_NewInt32(ctx, 0);
#else
  mode_t m = umask(0);
  umask(m);
  return JS_NewInt32(ctx, (int32_t)m);
#endif
}

static JSValue isl_host_signals(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  JSValue o = JS_NewObject(ctx);
#define ISL_SIG(name) JS_SetPropertyStr(ctx, o, #name, JS_NewInt32(ctx, name))
#ifdef SIGHUP
  ISL_SIG(SIGHUP);
#endif
  ISL_SIG(SIGINT);
#ifdef SIGQUIT
  ISL_SIG(SIGQUIT);
#endif
  ISL_SIG(SIGILL);
#ifdef SIGTRAP
  ISL_SIG(SIGTRAP);
#endif
  ISL_SIG(SIGABRT);
  ISL_SIG(SIGFPE);
#ifdef SIGKILL
  ISL_SIG(SIGKILL);
#endif
#ifdef SIGBUS
  ISL_SIG(SIGBUS);
#endif
  ISL_SIG(SIGSEGV);
#ifdef SIGSYS
  ISL_SIG(SIGSYS);
#endif
#ifdef SIGPIPE
  ISL_SIG(SIGPIPE);
#endif
#ifdef SIGALRM
  ISL_SIG(SIGALRM);
#endif
  ISL_SIG(SIGTERM);
#ifdef SIGURG
  ISL_SIG(SIGURG);
#endif
#ifdef SIGSTOP
  ISL_SIG(SIGSTOP);
#endif
#ifdef SIGTSTP
  ISL_SIG(SIGTSTP);
#endif
#ifdef SIGCONT
  ISL_SIG(SIGCONT);
#endif
#ifdef SIGCHLD
  ISL_SIG(SIGCHLD);
#endif
#ifdef SIGTTIN
  ISL_SIG(SIGTTIN);
#endif
#ifdef SIGTTOU
  ISL_SIG(SIGTTOU);
#endif
#ifdef SIGIO
  ISL_SIG(SIGIO);
#endif
#ifdef SIGXCPU
  ISL_SIG(SIGXCPU);
#endif
#ifdef SIGXFSZ
  ISL_SIG(SIGXFSZ);
#endif
#ifdef SIGVTALRM
  ISL_SIG(SIGVTALRM);
#endif
#ifdef SIGPROF
  ISL_SIG(SIGPROF);
#endif
#ifdef SIGWINCH
  ISL_SIG(SIGWINCH);
#endif
#ifdef SIGUSR1
  ISL_SIG(SIGUSR1);
#endif
#ifdef SIGUSR2
  ISL_SIG(SIGUSR2);
#endif
#undef ISL_SIG
  return o;
}

/* util.inspect's promise peek: [state, result] (0 pending / 1 fulfilled /
 * 2 rejected), undefined for a non-promise. JS has no synchronous view of
 * promise state; the engine does (JS_PromiseState), and Node's inspect
 * prints it — so the shim asks the host. Peeking never marks a rejection
 * handled (the tracker fired at reject time; nothing here rescinds it). */
static JSValue isl_host_promise_state(JSContext *ctx, JSValueConst this_val, int argc,
                                      JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  JSPromiseStateEnum st = JS_PromiseState(ctx, argv[0]);
  if ((int)st < 0) return JS_UNDEFINED;
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, (int32_t)st));
  JS_SetPropertyUint32(ctx, arr, 1,
                       st == JS_PROMISE_PENDING ? JS_UNDEFINED
                                                : JS_PromiseResult(ctx, argv[0]));
  return arr;
}

static JSValue isl_host_hostname(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* Node's os.hostname() is uv_os_gethostname — gethostname(2). On win32
   * that is winsock's gethostname, which answers WSANOTINITIALISED until
   * someone starts winsock (Node does at boot) — start it here, OS-ref-
   * counted like the socket units' own WSAStartup calls (ws2_32 is on
   * every win32 link line). */
  char buf[256];
#if defined(__wasi__)
  buf[0] = '\0';
#else
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return JS_NewString(ctx, "");
#endif
  if (gethostname(buf, sizeof buf) != 0) buf[0] = '\0';
#endif
  buf[sizeof buf - 1] = '\0';
  return JS_NewString(ctx, buf);
}

/* The bootstrap: the CommonJS require shim over the embedded map, the
 * builtin shims, and the real process bridge. Evaluated once (module boot);
 * returns the CJS import helper the boundary below pins. Everything JS
 * about the module system lives in packages/runtime/src/island-js/ — the
 * C side only serves tables and I/O — and this header is the generated
 * embedding of those parts (scripts/gen-island-bootstrap.mjs). The Rust
 * island include_str!s the very same parts. */
#include "scr_island_js.h"

/* Boots the module system: evaluates the bootstrap with the host bridge
 * and pins the CJS import helper. Called from isl_init when embedded
 * tables are registered — before any user code can import. */
/* Defined with the URL machinery below; embedded loaders construct URLs
 * (`new URL("x.wasm", import.meta.url)`) without any URL ever marshaling. */
static void isl_install_url_class(void);

static void isl_modules_boot(void) {
  isl_install_url_class();
  JSValue fn = JS_Eval(isl_ctx, isl_modules_bootstrap, sizeof isl_modules_bootstrap - 1,
                       "<scr-modules>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(fn)) {
    fprintf(stderr, "scriptc: island module bootstrap failed to evaluate\n");
    abort();
  }
  JSValue host = JS_NewObject(isl_ctx);
  /* JS_SetPropertyStr consumes the function values. */
  JS_SetPropertyStr(isl_ctx, host, "source", JS_NewCFunction(isl_ctx, isl_host_source, "source", 1));
  JS_SetPropertyStr(isl_ctx, host, "resolve", JS_NewCFunction(isl_ctx, isl_host_resolve, "resolve", 2));
  JS_SetPropertyStr(isl_ctx, host, "argv", JS_NewCFunction(isl_ctx, isl_host_argv, "argv", 0));
  JS_SetPropertyStr(isl_ctx, host, "env", JS_NewCFunction(isl_ctx, isl_host_env, "env", 0));
  JS_SetPropertyStr(isl_ctx, host, "write", JS_NewCFunction(isl_ctx, isl_host_write, "write", 2));
  JS_SetPropertyStr(isl_ctx, host, "readStdin",
                    JS_NewCFunction(isl_ctx, isl_host_read_stdin, "readStdin", 0));
  JS_SetPropertyStr(isl_ctx, host, "exit", JS_NewCFunction(isl_ctx, isl_host_exit, "exit", 1));
  JS_SetPropertyStr(isl_ctx, host, "setExitCode",
                    JS_NewCFunction(isl_ctx, isl_host_set_exit_code, "setExitCode", 1));
  JS_SetPropertyStr(isl_ctx, host, "isatty", JS_NewCFunction(isl_ctx, isl_host_isatty, "isatty", 1));
  JS_SetPropertyStr(isl_ctx, host, "columns", JS_NewCFunction(isl_ctx, isl_host_columns, "columns", 1));
  JS_SetPropertyStr(isl_ctx, host, "cwd", JS_NewCFunction(isl_ctx, isl_host_cwd, "cwd", 0));
  JS_SetPropertyStr(isl_ctx, host, "platform", JS_NewCFunction(isl_ctx, isl_host_platform, "platform", 0));
  JS_SetPropertyStr(isl_ctx, host, "homedir", JS_NewCFunction(isl_ctx, isl_host_homedir, "homedir", 0));
  JS_SetPropertyStr(isl_ctx, host, "tmpdir", JS_NewCFunction(isl_ctx, isl_host_tmpdir, "tmpdir", 0));
  JS_SetPropertyStr(isl_ctx, host, "arch", JS_NewCFunction(isl_ctx, isl_host_arch, "arch", 0));
  JS_SetPropertyStr(isl_ctx, host, "hostname", JS_NewCFunction(isl_ctx, isl_host_hostname, "hostname", 0));
  JS_SetPropertyStr(isl_ctx, host, "pid", JS_NewCFunction(isl_ctx, isl_host_pid, "pid", 0));
  JS_SetPropertyStr(isl_ctx, host, "promiseState", JS_NewCFunction(isl_ctx, isl_host_promise_state, "promiseState", 1));
  JS_SetPropertyStr(isl_ctx, host, "digest", JS_NewCFunction(isl_ctx, isl_host_digest, "digest", 2));
  JS_SetPropertyStr(isl_ctx, host, "hmac", JS_NewCFunction(isl_ctx, isl_host_hmac, "hmac", 3));
  JS_SetPropertyStr(isl_ctx, host, "fs", JS_NewCFunction(isl_ctx, isl_host_fs, "fs", 4));
  JS_SetPropertyStr(isl_ctx, host, "fsConstants", JS_NewCFunction(isl_ctx, isl_host_fs_constants, "fsConstants", 0));
  JS_SetPropertyStr(isl_ctx, host, "path", JS_NewCFunction(isl_ctx, isl_host_path, "path", 4));
  JS_SetPropertyStr(isl_ctx, host, "urlToPath", JS_NewCFunction(isl_ctx, isl_host_url_to_path, "urlToPath", 1));
  JS_SetPropertyStr(isl_ctx, host, "urlFromPath", JS_NewCFunction(isl_ctx, isl_host_url_from_path, "urlFromPath", 1));
  JS_SetPropertyStr(isl_ctx, host, "hrtime", JS_NewCFunction(isl_ctx, isl_host_hrtime, "hrtime", 0));
  JS_SetPropertyStr(isl_ctx, host, "versions", JS_NewCFunction(isl_ctx, isl_host_versions, "versions", 0));
  JS_SetPropertyStr(isl_ctx, host, "ids", JS_NewCFunction(isl_ctx, isl_host_ids, "ids", 0));
  JS_SetPropertyStr(isl_ctx, host, "signals", JS_NewCFunction(isl_ctx, isl_host_signals, "signals", 0));
  JS_SetPropertyStr(isl_ctx, host, "umask", JS_NewCFunction(isl_ctx, isl_host_umask, "umask", 0));
  JS_SetPropertyStr(isl_ctx, host, "zlib", JS_NewCFunction(isl_ctx, isl_host_zlib, "zlib", 4));
  /* The net bridge's host functions (scr_net_island.c, linked only when
   * the socket units are): httpStart/httpWrite/httpEnd/httpDestroy/
   * httpSetTimeout. The bootstrap's http/https shims register exactly
   * when host.httpStart exists — without the bridge the builtins table
   * keeps the "does not provide" refusal. */
  if (isl_netmod_attach) isl_netmod_attach(isl_ctx, &host);
  isl_cjs_import = JS_Call(isl_ctx, fn, JS_UNDEFINED, 1, &host);
  JS_FreeValue(isl_ctx, host);
  JS_FreeValue(isl_ctx, fn);
  if (JS_IsException(isl_cjs_import)) {
    fprintf(stderr, "scriptc: island module bootstrap failed to run\n");
    abort();
  }
  isl_booted = true;
}

static void isl_install_module_loader(void) {
  JS_SetModuleLoaderFunc(isl_rt, isl_module_normalize, isl_module_load, NULL);
  if (isl_mods) isl_modules_boot();
}

static void isl_free_boot(void) {
  if (!isl_booted) return;
  JS_FreeValue(isl_ctx, isl_cjs_import);
  isl_booted = false;
}

/* The import boundary (libCall island.import). Borrows all args; +1 out. */
ScrJsval *scr_jsval_import(const ScrStr *key, const ScrStr *name, const ScrStr *specifier) {
  isl_entry();
  const ScrIslandModule *m = isl_mod_find(key->data);
  if (!m || !isl_booted) {
    char buf[512];
    int n = snprintf(buf, sizeof buf, "module '%s' is not embedded", key->data);
    scr_throw_error_msg(SCR_ERR_ERROR, buf, (size_t)n);
    return NULL;
  }
  if (m->format != 0) {
    /* CJS/JSON entry: through the require shim — named exports come off
     * module.exports directly (like Node's lexer-driven interop, but by
     * property access), default IS module.exports. */
    JSValue args[2] = {JS_NewStringLen(isl_ctx, key->data, key->len),
                       JS_NewStringLen(isl_ctx, name->data, name->len)};
    JSValue r = JS_Call(isl_ctx, isl_cjs_import, JS_UNDEFINED, 2, args);
    JS_FreeValue(isl_ctx, args[0]);
    JS_FreeValue(isl_ctx, args[1]);
    if (JS_IsException(r)) {
      isl_bridge_exception();
      return NULL;
    }
    return isl_cell_new(r);
  }
  /* ESM entry: the engine loads the graph through the module loader; the
   * promise resolves with the namespace. Commander-class packages have no
   * top-level await, so draining the job queue settles it synchronously. */
  JSValue promise = JS_LoadModule(isl_ctx, ISL_IMPORT_BASE, key->data);
  if (JS_IsException(promise)) {
    isl_bridge_exception();
    return NULL;
  }
  JSContext *jctx;
  while (JS_ExecutePendingJob(isl_rt, &jctx) > 0) {
  }
  JSPromiseStateEnum state = JS_PromiseState(isl_ctx, promise);
  if (state == JS_PROMISE_REJECTED) {
    JSValue err = JS_PromiseResult(isl_ctx, promise);
    JS_FreeValue(isl_ctx, promise);
    JS_Throw(isl_ctx, err); /* consumed */
    isl_bridge_exception();
    return NULL;
  }
  if (state != JS_PROMISE_FULFILLED) {
    JS_FreeValue(isl_ctx, promise);
    char buf[512];
    int n = snprintf(buf, sizeof buf,
                     "module '%s' did not finish evaluating "
                     "(top-level await is not supported in embedded packages)",
                     key->data);
    scr_throw_error_msg(SCR_ERR_ERROR, buf, (size_t)n);
    return NULL;
  }
  JSValue ns = JS_PromiseResult(isl_ctx, promise);
  JS_FreeValue(isl_ctx, promise);
  if (name->len == 1 && name->data[0] == '*') {
    return isl_cell_new(ns);
  }
  /* Node validates named imports at LINK time: a name the module's
   * namespace does not provide is a SyntaxError naming the specifier as
   * written, and nothing runs. The namespace object holds exactly the
   * module's export names (star re-exports included), so a presence
   * check here IS Node's check — thrown after the graph evaluated
   * (Node's link phase precedes evaluation; a package with top-level
   * output would have printed first — the documented approximation),
   * but with the exact message and the same nonzero exit. */
  JSAtom prop = JS_NewAtomLen(isl_ctx, name->data, name->len);
  int has = JS_HasProperty(isl_ctx, ns, prop);
  JS_FreeAtom(isl_ctx, prop);
  if (has < 0) {
    JS_FreeValue(isl_ctx, ns);
    isl_bridge_exception();
    return NULL;
  }
  if (has == 0) {
    JS_FreeValue(isl_ctx, ns);
    char buf[512];
    int n = snprintf(buf, sizeof buf,
                     "The requested module '%s' does not provide an export named '%s'",
                     specifier->data, name->data);
    scr_throw_error_msg(SCR_ERR_SYNTAX, buf, (size_t)(n < 0 ? 0 : (size_t)n < sizeof buf ? (size_t)n : sizeof buf - 1));
    return NULL;
  }
  JSValue v = JS_GetPropertyStr(isl_ctx, ns, name->data);
  JS_FreeValue(isl_ctx, ns);
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

/* Dynamic import() (libCall island.importDyn). Borrows the key; +1 out —
 * ALWAYS an engine promise: JS_LoadModule's own for a loadable key, a
 * REJECTED one for load/normalize/compile failures (Node rejects dynamic
 * imports, it never throws synchronously) — the frontend's
 * jsBridgePromise turns settlement into the static promise's. Boots the
 * module system on demand: a program whose ONLY module use is a dynamic
 * builtin import ("node:fs") registers no embedded tables, but the
 * builtin wrappers require the bootstrap's __scr_require. */
/* Drop ledger entries carrying `reason` — the INTERMEDIATE module
 * promises QuickJS leaves rejected-and-unhandled when a dynamically
 * imported module throws at evaluation (each module in the graph has its
 * own promise; only the returned top one gets a handler). Node reports a
 * handled import() rejection zero times; without this we would report
 * the inner twin once. The RETURNED promise's own entry drops too — the
 * bridge subscribes to it, and an unobserved STATIC promise is the
 * static ledger's report (one voice, like everywhere else). */
static void isl_rejections_drop_reason(JSValueConst reason) {
  for (IslRejection **link = &isl_rejections; *link;) {
    if (JS_IsSameValue(isl_ctx, (*link)->reason, reason)) {
      IslRejection *r = *link;
      *link = r->next;
      isl_rejection_free(r);
    } else {
      link = &(*link)->next;
    }
  }
  isl_rejections_tail = &isl_rejections;
  while (*isl_rejections_tail) isl_rejections_tail = &(*isl_rejections_tail)->next;
}

ScrJsval *scr_jsval_import_dyn(const ScrStr *key) {
  isl_entry();
  if (!isl_booted) isl_modules_boot();
  JSValue promise = JS_LoadModule(isl_ctx, ISL_IMPORT_BASE, key->data);
  if (!JS_IsException(promise)) {
    /* Settlement flows through reaction jobs (each module's own promise
     * feeds the returned one) — drain them so a rejection is visible NOW,
     * then drop the intermediates' ledger twins. Embedded packages have
     * no top-level await (island.import documents the same rule), so the
     * drain either settles the promise or leaves genuinely-async work to
     * the loop. */
    JSContext *jctx;
    while (JS_ExecutePendingJob(isl_rt, &jctx) > 0) {
    }
    if (JS_PromiseState(isl_ctx, promise) == JS_PROMISE_REJECTED) {
      JSValue reason = JS_PromiseResult(isl_ctx, promise);
      isl_rejections_drop_reason(reason);
      JS_FreeValue(isl_ctx, reason);
    }
  }
  if (JS_IsException(promise)) {
    /* Wrap the pending exception into a rejected promise — Node's shape
     * for EVERY dynamic-import failure. */
    JSValue reason = JS_GetException(isl_ctx);
    JSValue global = JS_GetGlobalObject(isl_ctx);
    JSValue ctor = JS_GetPropertyStr(isl_ctx, global, "Promise");
    JSValue reject = JS_GetPropertyStr(isl_ctx, ctor, "reject");
    JSValue rejected = JS_Call(isl_ctx, reject, ctor, 1, &reason);
    JS_FreeValue(isl_ctx, reject);
    JS_FreeValue(isl_ctx, ctor);
    JS_FreeValue(isl_ctx, global);
    JS_FreeValue(isl_ctx, reason);
    if (JS_IsException(rejected)) { /* engine-level surprise only */
      isl_bridge_exception();
      return NULL;
    }
    return isl_cell_new(rejected);
  }
  return isl_cell_new(promise);
}

/* ── marshal out (validated exits) ────────────────────────────────────
 * STRICT extraction, mirroring the dynCheck walkers' no-coercion rule:
 * the failure is a real, catchable TypeError instance naming both types. */

/* The deferred boundary failure (libCall island.castFail): a checked cast
 * of an island value to a type with no validated exit (a Promise of a
 * function-carrying interface — the Node-typed async-API shape). The
 * value was evaluated by the caller; the cast throws a catchable
 * TypeError naming the target, exactly when the impossible conversion is
 * attempted — typed-but-never-executed code (a wasm decode path behind a
 * rejecting import) still compiles. */
void scr_jsval_cast_fail(ScrJsval *v, const ScrStr *target) {
  (void)v;
  char buf[512];
  int n = snprintf(buf, sizeof buf,
                   "island value cannot be validated as '%s' (the type has no "
                   "island exit — functions and promises cannot cross the boundary)",
                   target->data);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)(n < 0 ? 0 : (size_t)n < sizeof buf ? (size_t)n : sizeof buf - 1));
}

static void isl_exit_fail(const char *want, ScrJsval *v) {
  ScrStr *got = scr_jsval_typeof(v);
  char buf[128];
  int n = snprintf(buf, sizeof buf, "expected %s, got %s", want,
                   got ? got->data : "unknown");
  if (got) scr_str_release(got);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
}

int scr_jsval_exit_f64(ScrJsval *v, double *out) {
  isl_entry();
  if (!JS_IsNumber(v->v)) {
    isl_exit_fail("number", v);
    return 0;
  }
  return JS_ToFloat64(isl_ctx, out, v->v) == 0;
}

int scr_jsval_exit_bool(ScrJsval *v, bool *out) {
  isl_entry();
  if (!JS_IsBool(v->v)) {
    isl_exit_fail("boolean", v);
    return 0;
  }
  *out = JS_ToBool(isl_ctx, v->v) > 0;
  return 1;
}

ScrStr *scr_jsval_exit_str(ScrJsval *v) {
  isl_entry();
  if (!JS_IsString(v->v)) {
    isl_exit_fail("string", v);
    return NULL;
  }
  return isl_js_to_str(v->v);
}

/* Validated Uint8Array exit: the engine value must be a Uint8Array
 * (engine Buffers are Uint8Array subclasses and pass — matching the
 * static world, where Buffer IS bytes<u8>); the payload COPIES out as a
 * fresh u8 bytes value, the boundary's aliasing stance. NULL = the
 * boundary TypeError was thrown (lying declaration). */
ScrBytes *scr_jsval_exit_bytes(ScrJsval *v) {
  isl_entry();
  if (JS_GetTypedArrayType(v->v) != JS_TYPED_ARRAY_UINT8) {
    isl_exit_fail("a Uint8Array", v);
    return NULL;
  }
  size_t n = 0;
  uint8_t *data = JS_GetUint8Array(isl_ctx, &n, v->v);
  if (!data) {
    if (JS_HasException(isl_ctx)) { /* detached buffer and friends */
      isl_bridge_exception();
      return NULL;
    }
    n = 0; /* an empty view */
  }
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)n);
  if (n > 0) memcpy(b->data, data, n);
  return b;
}

/* Validated exit of an engine value into an `any[]`-declared slot (the
 * jsval-element-array spelling — withPlugins' `loadPlugins(plugins)`
 * boundary): the engine's Array.isArray gates (a non-array refuses with
 * the catchable boundary TypeError), then elements copy BY REFERENCE
 * into a native array of engine cells — identity preserved, length a
 * snapshot (the exit's aliasing stance: element IDENTITY crosses, the
 * spine is a copy). +1, or NULL with the exception pending. */
ScrArr *scr_jsval_exit_jsval_arr(ScrJsval *v) {
  isl_entry();
  if (JS_IsArray(v->v) <= 0) {
    isl_exit_fail("an array", v);
    return NULL;
  }
  JSValue lv = JS_GetPropertyStr(isl_ctx, v->v, "length");
  int64_t len = 0;
  JS_ToInt64(isl_ctx, &len, lv);
  JS_FreeValue(isl_ctx, lv);
  ScrArr *out = scr_arr_new_ref(&scr_jsval_retain_v, &scr_jsval_release_v, NULL,
                                len > 0 ? (size_t)len : 0);
  for (int64_t i = 0; i < len; i++) {
    JSValue e = JS_GetPropertyUint32(isl_ctx, v->v, (uint32_t)i); /* getters run */
    if (JS_IsException(e)) {
      isl_bridge_exception();
      scr_arr_release(out);
      return NULL;
    }
    scr_arr_push_ref(out, isl_cell_new(e)); /* ownership moves in */
  }
  return out;
}

/* Composite exit: engine JSON.stringify, feeding the existing
 * json.parse + dynCheck walker pipeline on the static side. A value
 * JSON cannot represent (function, undefined, symbol at the top) comes
 * back undefined — refused here so the walker sees real JSON. */
ScrStr *scr_jsval_to_json(ScrJsval *v) {
  isl_entry();
  JSValue j = JS_JSONStringify(isl_ctx, v->v, JS_UNDEFINED, JS_UNDEFINED);
  if (JS_IsException(j)) { /* cyclic value, throwing toJSON, ... */
    isl_bridge_exception();
    return NULL;
  }
  if (JS_IsUndefined(j)) {
    isl_exit_fail("a JSON-representable value", v);
    return NULL;
  }
  ScrStr *s = isl_js_to_str(j);
  JS_FreeValue(isl_ctx, j);
  return s;
}

/* ── optional chains on island values ─────────────────────────────────
 * `x?.y` on an 'any' receiver: the compiler emits the nullish test on the
 * HANDLE and, on the unit path, the engine's own undefined. Both are
 * infallible. */

bool scr_jsval_is_nullish(ScrJsval *v) {
  isl_entry();
  return JS_IsUndefined(v->v) || JS_IsNull(v->v);
}

ScrJsval *scr_jsval_undefined(void) {
  isl_entry();
  return isl_cell_new(JS_UNDEFINED);
}

ScrJsval *scr_jsval_null(void) {
  isl_entry();
  return isl_cell_new(JS_NULL);
}

/* ── typed arrays and URLs marshaling IN ──────────────────────────────
 * The union lift's non-JSON arms (and bare bytes/URL values in 'any'
 * slots): a typed array crosses as an engine typed array of the same
 * element kind — a COPY, the boundary's copy-marshal stance — and a URL
 * crosses as an engine URL instance built from its href. */

ScrJsval *scr_jsval_from_bytes(const ScrBytes *b) {
  isl_entry();
  if (b->elem == SCR_BYTES_U8) {
    JSValue v = JS_NewUint8ArrayCopy(isl_ctx, b->data, b->len);
    if (JS_IsException(v)) {
      isl_bridge_exception();
      return NULL;
    }
    return isl_cell_new(v);
  }
  JSValue buf = JS_NewArrayBufferCopy(isl_ctx, b->data,
                                      b->len * scr_bytes_elem_size(b->elem));
  if (JS_IsException(buf)) {
    isl_bridge_exception();
    return NULL;
  }
  /* The engine's constructor reads the offset/length slots unconditionally
   * — pad them with undefined like a real JS call would. */
  JSValueConst argv[3] = {buf, JS_UNDEFINED, JS_UNDEFINED};
  JSValue v = JS_NewTypedArray(isl_ctx, 3, argv,
                               b->elem == SCR_BYTES_U32   ? JS_TYPED_ARRAY_UINT32
                               : b->elem == SCR_BYTES_I32 ? JS_TYPED_ARRAY_INT32
                                                          : JS_TYPED_ARRAY_FLOAT32);
  JS_FreeValue(isl_ctx, buf);
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

/* The engine has no URL global of its own (QuickJS ships none; scr_web.c
 * defines the streams/fetch subset only), so the first URL marshal
 * installs a minimal class: construction re-parses through the SAME
 * WHATWG parser the static URL uses (scr_url.c, via a host function), so
 * a marshaled URL and `new URL(href)` in embedded code agree exactly.
 * href/protocol/pathname are the components the native accessors expose;
 * the other component reads and ALL component writes throw a clear
 * TypeError instead of silently diverging from the live re-serializing
 * accessors a real URL has (SEMANTICS.md). If a URL global already exists
 * (a future web-prelude one, or embedded code's own), it wins — the
 * marshal constructs through whatever globalThis.URL is. */
static JSValue isl_url_parse_host(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
  (void)this_val;
  if (argc < 1) return JS_ThrowTypeError(ctx, "Invalid URL");
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
  if (!s) return JS_EXCEPTION;
  ScrStr *in = scr_str_new(s, len);
  JS_FreeCString(ctx, s);
  ScrUrl *u = scr_url_new(in);
  scr_str_release(in);
  if (!u) return isl_throw_pending(ctx); /* the parser's catchable TypeError */
  ScrStr *href = scr_url_href(u);
  ScrStr *protocol = scr_url_protocol(u);
  ScrStr *pathname = scr_url_pathname(u);
  ScrStr *host = scr_url_host(u);
  ScrStr *hostname = scr_url_hostname(u);
  ScrStr *search = scr_url_search(u);
  scr_url_release(u);
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewStringLen(ctx, href->data, href->len));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewStringLen(ctx, protocol->data, protocol->len));
  JS_SetPropertyUint32(ctx, arr, 2, JS_NewStringLen(ctx, pathname->data, pathname->len));
  JS_SetPropertyUint32(ctx, arr, 3, JS_NewStringLen(ctx, host->data, host->len));
  JS_SetPropertyUint32(ctx, arr, 4, JS_NewStringLen(ctx, hostname->data, hostname->len));
  JS_SetPropertyUint32(ctx, arr, 5, JS_NewStringLen(ctx, search->data, search->len));
  scr_str_release(href);
  scr_str_release(protocol);
  scr_str_release(pathname);
  scr_str_release(host);
  scr_str_release(hostname);
  scr_str_release(search);
  return arr;
}

static const char isl_url_src[] =
    "(function (parse) {\n"
    "  'use strict';\n"
    "  const def = (o, n, v) => Object.defineProperty(o, n, { value: v, enumerable: true });\n"
    "  class URL {\n"
    /* The (input, base) form supports RELATIVE resolution — the Emscripten
     * loader's `new URL("x.wasm", import.meta.url)` — with RFC 3986
     * dot-segment removal over the base's path. Inputs that carry their
     * own scheme ignore the base (per spec); protocol-relative inputs
     * keep a narrow fence. */
    "    constructor(input, base) {\n"
    "      let s = String(input);\n"
    "      const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;\n"
    "      if (base !== undefined && !hasScheme.test(s)) {\n"
    "        const b = String(base !== null && typeof base === 'object' && 'href' in base ? base.href : base);\n"
    "        const m = hasScheme.test(b) && b.match(/^([A-Za-z][A-Za-z0-9+.-]*:)(\\/\\/[^\\/?#]*)?([^?#]*)/);\n"
    "        if (!m) throw new TypeError('Invalid base URL');\n"
    "        if (s.startsWith('//')) {\n"
    "          throw new TypeError('protocol-relative URLs are not supported in the scriptc island yet');\n"
    "        }\n"
    "        let path = s.startsWith('/') ? s : (m[3] || '/').replace(/[^\\/]*$/, '') + s;\n"
    "        const out = [];\n"
    "        for (const seg of path.split('/')) {\n"
    "          if (seg === '.') continue;\n"
    "          if (seg === '..') { if (out.length > 1) out.pop(); continue; }\n"
    "          out.push(seg);\n"
    "        }\n"
    "        s = m[1] + (m[2] || '') + out.join('/');\n"
    "      }\n"
    "      const c = parse(s);\n"
    /* href and search are LIVE-COUPLED (the one WHATWG mutation loop the
     * a real CLI's API client drives: url.searchParams.set('teamId', …)
     * then fetch(url)): both live in writable slots, the search setter
     * recomposes href around the old query, and the searchParams getter
     * hands out ONE URLSearchParams whose mutators write back through
     * it. The other components stay parse-time snapshots. */
    "      Object.defineProperty(this, '_href', { value: c[0], writable: true });\n"
    "      Object.defineProperty(this, '_search', { value: c[5], writable: true });\n"
    "      const self = this;\n"
    "      Object.defineProperty(this, 'href', { enumerable: true, get: () => self._href });\n"
    "      Object.defineProperty(this, 'search', {\n"
    "        enumerable: true,\n"
    "        get: () => self._search,\n"
    "        set: (v) => {\n"
    "          self._applySearch(String(v));\n"
    "          if (self._sp !== undefined) {\n"
    "            self._sp._pairs.length = 0;\n"
    "            for (const [k, val] of new globalThis.URLSearchParams(self._search)) self._sp._pairs.push([k, val]);\n"
    "          }\n"
    "        },\n"
    "      });\n"
    "      def(this, 'protocol', c[1]);\n"
    "      def(this, 'pathname', c[2]);\n"
    "      def(this, 'host', c[3]);\n"
    "      def(this, 'hostname', c[4]);\n"
    "      def(this, 'port', c[3].length > c[4].length ? c[3].slice(c[4].length + 1) : '');\n"
    "      const hashAt = c[0].indexOf('#');\n"
    "      def(this, 'hash', hashAt < 0 ? '' : c[0].slice(hashAt));\n"
    "      const cred = c[3] !== '' && c[0].startsWith(c[1] + '//')\n"
    "        ? c[0].slice(c[1].length + 2, c[0].indexOf(c[3], c[1].length + 2)) : '';\n"
    "      const at = cred.lastIndexOf('@');\n"
    "      const userinfo = at < 0 ? '' : cred.slice(0, at);\n"
    "      const colon = userinfo.indexOf(':');\n"
    "      def(this, 'username', colon < 0 ? userinfo : userinfo.slice(0, colon));\n"
    "      def(this, 'password', colon < 0 ? '' : userinfo.slice(colon + 1));\n"
    "      def(this, 'origin', (c[1] === 'http:' || c[1] === 'https:' || c[1] === 'ws:' || c[1] === 'wss:' || c[1] === 'ftp:')\n"
    "        ? c[1] + '//' + c[3] : 'null');\n"
    "    }\n"
    /* The search half of the live coupling: normalize the assigned
     * query, splice it into href between the pre-query part and the
     * fragment. */
    "    _applySearch(v) {\n"
    "      let s = String(v);\n"
    "      if (s !== '' && !s.startsWith('?')) s = '?' + s;\n"
    "      if (s === '?') s = '';\n"
    "      const base = this._href.split('#')[0].split('?')[0];\n"
    "      this._search = s;\n"
    "      this._href = base + s + this.hash;\n"
    "    }\n"
    /* searchParams: ONE URLSearchParams per URL (identity stable, like
     * the spec) whose mutators — append/set/delete/sort — write the
     * serialized list back into search/href. Reads AND writes agree with
     * Node for the query component; the other components stay parse-time
     * snapshots. */
    "    get searchParams() {\n"
    "      if (this._sp === undefined) {\n"
    "        const sp = new globalThis.URLSearchParams(this.search);\n"
    "        const sync = () => {\n"
    "          const q = sp.toString();\n"
    "          this._applySearch(q === '' ? '' : '?' + q);\n"
    "        };\n"
    "        for (const m of ['append', 'set', 'delete', 'sort']) {\n"
    "          const orig = sp[m].bind(sp);\n"
    "          Object.defineProperty(sp, m, {\n"
    "            value: (...args) => { const r = orig(...args); sync(); return r; },\n"
    "          });\n"
    "        }\n"
    "        Object.defineProperty(this, '_sp', { value: sp });\n"
    "      }\n"
    "      return this._sp;\n"
    "    }\n"
    "    toString() { return this.href; }\n"
    "    toJSON() { return this.href; }\n"
    "    static canParse(input, base) {\n"
    "      try { new URL(input, base); return true; } catch (e) { return false; }\n"
    "    }\n"
    "    static parse(input, base) {\n"
    "      try { return new URL(input, base); } catch (e) { return null; }\n"
    "    }\n"
    "  }\n"
    "  globalThis.URL = URL;\n"
    "})\n";

/* Install the minimal URL class if the global is still missing. Called on
 * first URL marshal AND at module boot (embedded loaders do
 * `new URL("x.wasm", import.meta.url)` without any URL ever crossing). */
static void isl_install_url_class(void) {
  JSValue g = JS_GetGlobalObject(isl_ctx);
  JSValue ctor = JS_GetPropertyStr(isl_ctx, g, "URL");
  if (JS_IsUndefined(ctor)) {
    JSValue installer = JS_Eval(isl_ctx, isl_url_src, sizeof isl_url_src - 1,
                                "<scr-url>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(installer)) {
      fprintf(stderr, "scriptc: island URL prelude failed to evaluate\n");
      abort(); /* fixed source; failing to parse is a build defect */
    }
    JSValue parse = JS_NewCFunction(isl_ctx, isl_url_parse_host, "__scr_url_parse", 1);
    JSValue r = JS_Call(isl_ctx, installer, JS_UNDEFINED, 1, &parse);
    JS_FreeValue(isl_ctx, parse);
    JS_FreeValue(isl_ctx, installer);
    if (JS_IsException(r)) {
      fprintf(stderr, "scriptc: island URL prelude failed to install\n");
      abort();
    }
    JS_FreeValue(isl_ctx, r);
  }
  JS_FreeValue(isl_ctx, ctor);
  JS_FreeValue(isl_ctx, g);
}

ScrJsval *scr_jsval_from_url(ScrUrl *u) {
  isl_entry();
  isl_install_url_class();
  JSValue g = JS_GetGlobalObject(isl_ctx);
  JSValue ctor = JS_GetPropertyStr(isl_ctx, g, "URL");
  JS_FreeValue(isl_ctx, g);
  ScrStr *href = scr_url_href(u);
  JSValue hrefv = JS_NewStringLen(isl_ctx, href->data, href->len);
  scr_str_release(href);
  JSValue v = JS_CallConstructor(isl_ctx, ctor, 1, &hrefv);
  JS_FreeValue(isl_ctx, hrefv);
  JS_FreeValue(isl_ctx, ctor);
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

#endif /* SCR_DYNAMIC */
