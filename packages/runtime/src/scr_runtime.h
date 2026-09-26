/* scriptc runtime — public API.
 * Every scriptc binary compiles these sources in; there is no shared library.
 *
 * Prefix conventions: the runtime owns "scr_" and "SCR_" macros/"Scr" type names.
 * Compiler-emitted symbols use "sc_f_" (functions), "sc_l_" (locals),
 * "sc_t" (temps) and never collide.
 */
#ifndef SCR_RUNTIME_H
#define SCR_RUNTIME_H

#include <stdarg.h>  /* va_list in the emitter listener adapters */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>    /* memcpy in the inline slot accessors */
#include <sys/types.h> /* ssize_t in the transport ops table */

/* ── libc shims ─────────────────────────────────────────────────────────
 * Win32's missing POSIX/BSD functions live in scr_win.c. Zig's musl sysroot
 * additionally lacks arc4random_buf; scr_musl.c supplies it from Linux's
 * getrandom syscall. Both files are selected by native-toolchain.ts only for their target. */
#if defined(_WIN32) && defined(_MSC_VER)
/* MSVC's C headers do not define POSIX ssize_t. Keep the runtime's byte-count
 * interfaces pointer-sized on Windows without requiring a Windows SDK header
 * (and leave the Zig/MinGW compatibility route's native typedef intact). */
typedef intptr_t ssize_t;
#endif
#ifdef _WIN32
#include <time.h> /* time_t / struct tm for the gmtime_r shim */
char *stpcpy(char *dst, const char *src);
void arc4random_buf(void *buf, size_t n);
struct tm *gmtime_r(const time_t *t, struct tm *out);
char *strcasestr(const char *hay, const char *needle);
#elif defined(SCR_MUSL)
void arc4random_buf(void *buf, size_t n);
#endif

/* ── thread-instanced library state ─────────────────────────────────────
 * Archives built under the profile's abi.instance_per_thread compile every
 * TU with -DSCR_THREAD_INSTANCES, and SCR_TL moves each unit's mutable
 * state — and the emitted program's globals — into thread-local storage.
 * A thread that calls the profile's init entry then owns a complete,
 * independent instance: its own collector, result arena, panic-sink
 * registration, poison flag, and program state. The instance's lifetime is
 * the thread's; the one-thread-per-instance contract (an instance is never
 * entered from two threads) is unchanged — this mode adds instances, not
 * thread awareness. Expands to nothing everywhere else, so executable
 * builds and classic library builds carry the exact bytes they always
 * carried. Truly immutable tables (static const data) stay shared. */
#if defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)
#define SCR_TL _Thread_local
#else
#define SCR_TL
#endif

/* ── process ──────────────────────────────────────────────────────────── */

/* Called once at the top of main: private stdout formatter buffer,
 * flush-at-exit, RC audit registration (when built with -DSCR_RC_AUDIT).
 * JavaScript-visible writes flush before returning. */
void scr_init(void);
/* Program objects emitted by the bundled LLVM helper reference this symbol.
 * Its versioned spelling makes a mismatched manual runtime link fail before
 * the program can start. */
void scr_runtime_abi_v1(void);

/* ── the trap funnel (scr_console.c; scr_library.c under -DSCR_LIB) ──────
 * Every unrecoverable runtime trap — OOM, semantic range traps, internal-
 * invariant failures — funnels through this pair instead of open-coded
 * fputs/fprintf + abort. Executable builds expand to exactly the historical
 * behavior (the message's bytes on stderr, then abort — the default lane
 * must not change by a byte). Library builds (-DSCR_LIB) route the message to
 * the host-registered panic sink and abort only as the last resort: before
 * registration, or if the sink returns (the ruled host-contract violation —
 * a conforming sink longjmps to a host frame BELOW the entry, never back
 * into library frames). Messages keep their trailing newline in both lanes;
 * the library funnel additionally assembles every DETECTED trap into the
 * structured trap-teaching form before delivery (a message that already
 * begins with the 0x01 marker passes verbatim) — see ScrLibSinkFn below. */
_Noreturn void scr_trap(const char *msg);
_Noreturn void scr_trap_fmt(const char *fmt, ...);

/* ── library mode (scr_library.c, linked only into library artifacts) ─────
 * A library artifact has no main, no event loop, no signal handlers, no
 * atexit registrations, and never touches host stdio modes or buffering:
 * initialization runs inside the profile-named init entry (re-runnable
 * deterministically), traps route to the sink above, and buffer-class
 * results live in a library-owned result arena. Everything here compiles only
 * under -DSCR_LIB; executable builds never contain it. */
#ifdef SCR_LIB
typedef struct ScrStr ScrStr;     /* full definitions below (C11 repeat) */
typedef struct ScrBytes ScrBytes;
/* The host's panic sink: msg is UTF-8, valid only for the duration of the
 * call; address is the trap site's return address (0 when the toolchain
 * cannot supply one); ctx is the registration's opaque pointer. The sink
 * must not call back into any library entry and must not unwind or longjmp
 * back into library frames.
 *
 * Message shape (the ratified structured trap-teaching encoding): a
 * BASELINE message is plain text whose first byte is printable (>= 0x20) —
 * no emitter path ever produces an unstructured message starting below
 * 0x20. A STRUCTURED message begins with the marker byte 0x01 followed by
 * the human teaching text and 0x1F-separated fields:
 *
 *   0x01  text  0x1F code  0x1F symbol  [ 0x1F remediation ]
 *
 * so msg_len > 0 && msg[0] == 0x01 is the one version test. Parse: split
 * the bytes after the marker on 0x1F — field 0 is the human text, 1 the
 * diagnostic code, 2 the trapping symbol as the host linked it, 3 the
 * remediation; a missing or empty field means none; ignore any field past
 * the fourth. Fields are (pointer, length) — never assume NUL termination.
 * A plain-text host may print the whole buffer: the teaching leads it.
 *
 * Every trap the runtime DETECTS arrives structured: the funnel assembles
 * the baseline human line into field 0 unchanged, a stable code for the
 * trap kind (the compiler registry's runtime family — SC4013–SC4019 plus
 * the SC4025 unregistered-callback and SC4026 callback-re-entry traps,
 * classified in scr_library.c), the
 * entry symbol recorded by the trapping
 * entry's prologue, and the profile's remediation for that code when the
 * program TU's overlay table declares one (the whole fourth field is
 * absent otherwise). A message that already begins with the marker — a
 * facade-authored structured throw, or the wrapper's compile-time-
 * assembled SC4012 contract trap — passes through byte-for-byte. */
typedef void (*ScrLibSinkFn)(void *ctx, const uint8_t *msg, size_t msg_len,
                              uint64_t address);
void scr_library_set_sink(ScrLibSinkFn fn, void *ctx); /* latest wins */

/* ── host-callback channels ───────────────────────────────────────────────
 * The panic sink's registration pattern generalized into a synchronous
 * outbound seam: the profile declares named channels (bytes/scalar
 * signatures), the generated registration symbol maps a channel name to a
 * slot index here, and compiled call sites fetch the slot through
 * scr_library_cb_require — which returns the host's pointer or delivers
 * the call site's trap message through the funnel (the SC4025 detected
 * trap) when the host never registered. The typed shape of each stored
 * pointer is the channel's, with the opaque context first:
 *
 *   <ret> (*)(void *ctx, <params...>)
 *
 * Registration is a pure store like the sink's (no entry prologue, no
 * poison guard, legal before init); latest wins, NULL clears, and
 * registrations persist across init/reset. While a host callback is active,
 * its registration entry is rejected before name dispatch or a store, just
 * like every runtime-touching ABI entry. Slots are per-copy of this
 * state, exactly the sink's story: per-archive under abi.localize_runtime,
 * per-thread instance under abi.instance_per_thread (SCR_TL) — a callback
 * registered on thread T fires only for T's instance. The host's callback
 * runs on the calling thread inside the entry's dynamic extent and must
 * NOT call back into any library entry (exports, init, reset, collect, sink
 * registration, or callback registration) or unwind/longjmp across library
 * frames: read the borrowed buffers, copy what outlives the call, return.
 * A re-entry is a detected SC4026 trap: it poisons only this library
 * instance, delivers exactly once to the already-registered sink, names the
 * attempted inner ABI symbol in structured field 2, then aborts if the sink
 * returns. A later host-loop turn may enter normally after the callback has
 * returned. Buffer parameters are borrowed for the duration of the call
 * only. */
#define SCR_LIB_MAX_CALLBACKS 32 /* keep in step with LIB_MAX_CALLBACKS (library/library-profile.ts) */
/* The stored shape: generated call sites cast a slot's pointer to the
 * channel's typed shape before calling. */
typedef void (*ScrLibCbFn)(void);
void scr_library_cb_set(size_t slot, ScrLibCbFn fn, void *ctx);
/* The call-site fetch: the registered pointer, or the funnel trap with
 * trap_msg (never returns NULL). */
ScrLibCbFn scr_library_cb_require(size_t slot, const char *trap_msg);
void *scr_library_cb_ctx(size_t slot);
/* Generated typed call sites bracket only the actual host-function call.
 * End is reached only after a normal return; an illegal unwind deliberately
 * leaves the depth active so the next ABI entry is rejected. */
void scr_library_callback_begin(void);
void scr_library_callback_end(void);
/* Registration wrappers bypass scr_library_entry because their normal path
 * is a pure store. They call this first so callback-time registration is
 * rejected before dispatch, NULL handling, or mutation. */
void scr_library_callback_entry_guard(const char *entry_symbol);

/* Entry prologue: aborts deterministically when the library is poisoned (a
 * trap already fired — no profile entry may run again; recovery is process
 * restart). reset_arena additionally drops the result arena (the
 * auto-reset posture, and the reset/collect entries' shared body).
 * entry_symbol is the generated entry's external symbol exactly as the
 * host linked it (a static string in the program TU): the prologue records
 * it in the funnel's current-entry slot so a detected trap's structured
 * message can name the trapping entry. A host callback's attempted nested
 * entry is rejected first and replaces this slot with that inner symbol.
 * Init and the mode entries (reset, collect) record theirs too. The two
 * profile identity getters are the explicit pure-data exception: they touch
 * no mutable runtime state and remain callable before init and after poison. */
void scr_library_entry(bool reset_arena, const char *entry_symbol);
void scr_library_arena_reset(void);
/* The mode-provided collect entry's body: arena reset + a full cycle
 * collection (snapshot-invariant by construction — collection frees only
 * unreachable cycles). */
void scr_library_collect(void);

/* Full session reset, called by the generated init entry AFTER the program
 * TU released and zeroed its globals: pending-exception clear, arena
 * reset, the reset registry's drains (the units' repointed atexit halves),
 * the library's interned process values, a cycle collection, and — under
 * SCR_RC_AUDIT — the zero-live-heap assertion (a failure is a trap through
 * the sink, never _Exit). */
void scr_library_reset(void);
/* Where a unit would atexit() a lazy teardown, library builds register it
 * here instead (called on every scr_library_reset, registered once). */
void scr_library_register_reset(void (*fn)(void));
/* An escaped exception at an entry boundary: renders the same "Uncaught
 * ..." text the executable epilogue prints, releases the payload, and
 * routes the text through the trap funnel. No-op when nothing is pending.
 * The ratified verbatim rule: a thrown message that ALREADY begins with the
 * structured marker 0x01 (a thrown string, or an Error whose .message
 * starts with it) is delivered byte-for-byte — no "Uncaught " prefix, no
 * added newline — which is how facade-authored structured teachings ride
 * the throw channel to the sink. Defined in scr_exception.c (it owns the
 * cell). */
void scr_library_check_exc(void);

/* The length-taking funnel entry (library lane only): delivers exactly the
 * given bytes to the sink — the verbatim path above needs it because a
 * structured message is length-delimited, never NUL-scanned. */
_Noreturn void scr_trap_len(const char *msg, size_t len);

/* The runtime-trap overlay table, DEFINED by the generated program TU
 * (both emissions emit identical data) and consumed by the funnel when it
 * assembles a detected trap's structured message: flat triples of
 * (code, teaching-or-NULL, remediation-or-NULL), one per runtime trap code
 * (the SC4013–SC4019 family plus SC4025 and SC4026) the profile declares
 * text for;
 * _len counts triples. A declared teaching replaces the baseline human line as field 0;
 * a declared remediation becomes the optional fourth field. */
extern const char *const scr_library_trap_overlays[];
extern const size_t scr_library_trap_overlays_len;

/* Marshalling helpers the generated wrappers call (both emissions share
 * these bodies, which is how the two lanes stay identical by
 * construction). Inbound is borrowed-and-copied; outbound values MOVE into
 * the result arena and stay valid until the next arena reset. String
 * results are NUL-terminated after *out_len bytes (ScrStr's layout). */
ScrStr *scr_library_str_in(const uint8_t *p, size_t len);   /* +1 */
/* trap_msg is the wrapper's compiler-assembled host-contract trap message
 * (structured trap-teaching bytes naming this entry's symbol), delivered
 * through the funnel when len falls outside the marshalling class. */
ScrBytes *scr_library_bytes_in(const uint8_t *p, size_t len, const char *trap_msg); /* +1, u8 */
/* The inbound declared-integer edge (ask 4's i64/u64 parameter classes):
 * exact conversion for |v| <= 2^53-1, the host-contract trap (same
 * assembled SC4012 message shape as the bytes trap) past it — silent
 * rounding is a coercion the author never wrote. */
double scr_library_i64_in(int64_t v, const char *trap_msg);
double scr_library_u64_in(uint64_t v, const char *trap_msg);
void scr_library_str_out(ScrStr *s, const uint8_t **out, size_t *out_len);
void scr_library_bytes_out(ScrBytes *b, const uint8_t **out, size_t *out_len);

#define scr_atexit(fn) scr_library_register_reset(fn)
#else
#define scr_atexit(fn) atexit(fn)
#endif /* SCR_LIB */

/* ── cycle collection (scr_cycle.c) ───────────────────────────────────
 * Reference counting alone cannot free cycles, so every object that can
 * participate in one — capture boxes, heap closures, unions, promises, and
 * compiler-emitted class/record shapes with cycle-capable fields — is
 * allocated with a hidden header directly BEFORE the object: a trace
 * function (enumerates the object's cycle-capable children), a teardown
 * function (frees the object WITHOUT releasing traced children), and the
 * trial-deletion bookkeeping (color + candidate-root buffer state). Types
 * that can never be in a cycle — strings above all, plus arrays of scalar/
 * string/bytes elements, dyn trees, and shapes whose fields are all acyclic
 * — keep the lean 1-word `rc` header and pay nothing. Arrays and maps are
 * cycle-capable exactly when their element/value type is (a record element
 * can point back at the array holding it).
 *
 * The collector is synchronous Bacon–Rajan trial deletion: a release that
 * leaves a candidate's rc above zero buffers it as a possible cycle root;
 * collection walks the buffer (markGray: trial-decrement internal edges;
 * scan: restore externally-referenced subgraphs; collectWhite: free the
 * dead cycle members, releasing only edges that LEAVE the white set).
 * It is GENERATIONAL: each header carries a generation, a pass names the
 * oldest one it will walk, and objects that survive a pass are promoted out
 * of the nursery so later nursery passes never re-walk them. That is what
 * keeps a pass proportional to recent allocation rather than to the whole
 * live heap — see the generation note in scr_cycle.c for the soundness
 * argument and the schedule. Collection points: program exit (before the RC
 * audit), event-loop quiescence, and the per-generation triggers.
 * SCR_CYCLE_THRESHOLD pins the nursery trigger to a fixed candidate count.
 * There is no concurrent or incremental collection.
 *
 * Contract for trace/teardown pairs (the compiler emits them for shapes,
 * the runtime owns its own): trace(obj) visits exactly the strong
 * references to children that themselves carry a cycle header (visit
 * callbacks tolerate NULL and immortal children); the teardown releases
 * exactly the complement (strings, arrays, acyclic shapes), frees internal
 * buffers, and frees the block via scr_cyc_free. Every heap object's
 * FIRST member is `size_t rc`, which is what lets the collector adjust
 * counts generically.
 */
typedef void (*ScrTraceVisit)(void *child, void *ctx);
typedef void (*ScrTraceFn)(void *obj, ScrTraceVisit visit, void *ctx);
typedef void (*ScrCycFreeFn)(void *obj);

/* DOOMED is WHITE that collectWhite has already gathered: it stops the
 * gather recursing twice, and distinguishes "about to be freed" from a
 * survivor for the re-buffering step (see scr_cycle.c). */
enum {
  SCR_CYC_BLACK = 0, SCR_CYC_PURPLE = 1, SCR_CYC_GRAY = 2, SCR_CYC_WHITE = 3,
  SCR_CYC_DOOMED = 4
};

/* Generations. A candidate sits in the buffer named by its own `gen`, and a
 * pass walks only objects at or below the generation it collects. */
enum { SCR_CYC_NURSERY = 0, SCR_CYC_MATURE = 1, SCR_CYC_NGENS = 2 };

typedef struct ScrCycHdr {
  ScrTraceFn trace;
  ScrCycFreeFn free_fn;
  uint32_t color;    /* SCR_CYC_* */
  uint16_t buffered; /* 1 = sitting in its generation's candidate buffer */
  uint16_t gen;      /* SCR_CYC_NURSERY..SCR_CYC_MATURE (the walk filter) */
  size_t buf_index;  /* position there (O(1) removal when rc hits 0) */
} ScrCycHdr;

/* This layout is an ABI, not an implementation detail. The LLVM backend
 * inlines scr_cyc_mark_live as a raw `store i32 0`: color is at obj-16 on
 * 64-bit targets and obj-12 on wasm32. Three sites emit it —
 * llvm/shapes.ts, llvm/classes.ts, and llvm/emitter.ts. Nothing but `color`
 * may share those four bytes: a field placed in them is silently zeroed by
 * every retain, which is invisible to the type system and to the C
 * compiler. Hence the target-width assertions. */
#if UINTPTR_MAX == UINT64_MAX
_Static_assert(sizeof(ScrCycHdr) == 32, "LLVM backend expects a 32-byte cycle header");
_Static_assert(offsetof(ScrCycHdr, color) == 16,
               "LLVM backend's inlined mark-live stores i32 0 at obj-16");
#elif UINTPTR_MAX == UINT32_MAX
_Static_assert(sizeof(ScrCycHdr) == 20, "LLVM backend expects a 20-byte cycle header");
_Static_assert(offsetof(ScrCycHdr, color) == 8,
               "LLVM backend's inlined mark-live stores i32 0 at obj-12");
#endif
_Static_assert(sizeof(((ScrCycHdr *)0)->color) == 4,
               "mark-live is an i32 store: color must own all four bytes");
_Static_assert(SCR_CYC_BLACK == 0,
               "the emitted mark-live stores the LITERAL 0, not the enumerator "
               "— reordering the colors would make every compiled retain write "
               "the wrong one");

static inline ScrCycHdr *scr_cyc_hdr(void *obj) { return (ScrCycHdr *)obj - 1; }

/* Zeroed allocation with a cycle header in front; returns the OBJECT
 * pointer (header at scr_cyc_hdr). Aborts on OOM. */
void *scr_cyc_alloc(size_t size, ScrTraceFn trace, ScrCycFreeFn free_fn);
void scr_cyc_free(void *obj); /* frees the block, header included */

/* RC hooks for cycle-headered types. on_release: rc was decremented and
 * stayed above zero — buffer the object as a possible cycle root (may run
 * a collection when the buffer crosses the threshold; the caller must not
 * touch the object afterwards). on_dead: rc hit zero — drop any buffer
 * entry BEFORE tearing the object down. mark_live: retain hook (a
 * re-retained candidate is certainly not garbage). */
void scr_cyc_on_release(void *obj);
void scr_cyc_on_dead(void *obj);
static inline void scr_cyc_mark_live(void *obj) {
  scr_cyc_hdr(obj)->color = SCR_CYC_BLACK;
}

/* Full sweep: trial-deletion passes over EVERY generation, to a fixpoint.
 * This is the exit / session-reset entry point (the RC audit runs straight
 * after and wants nothing reclaimable left), and it costs a walk of the
 * live heap — do not put it on a per-turn path. */
void scr_collect_cycles(void);

/* One pass on the normal generational schedule, for callers that reach a
 * natural collection point rather than a threshold (the event loop between
 * turns). Cheap: usually a nursery pass; a waiting mature backlog ages into
 * a bounded full pass so sparse roots cannot float forever. */
void scr_cyc_collect_scheduled(void);

/* ── class hierarchies (single inheritance) ───────────────────────────
 * Classes in an `extends` hierarchy share a two-word object prefix: the
 * usual `size_t rc`, then a pointer to the class's static vtable (emitted
 * per class by the compiler; standalone classes carry no vtable word and
 * none of this applies). A derived class embeds its base's fields as a
 * layout PREFIX, so an upcast is a pointer reinterpret and base-field
 * offsets agree through any static type.
 *
 * The vtable begins with this header; the compiler-emitted concrete
 * per-hierarchy struct appends one member per virtual method slot (only
 * methods actually overridden somewhere get slots — never-overridden
 * methods keep direct static calls). `pre`/`post` are the class's preorder
 * interval in the whole-program class forest: `x instanceof C` is the O(1)
 * range check `C.pre <= x->vt->pre && x->vt->pre <= C.post`. `release` is
 * the class's own whole-object release: releasing through a base-typed
 * pointer must tear down the DERIVED object's fields, so the emitted
 * release of every hierarchy class dispatches through the stored vtable
 * (retain needs no dispatch — rc is at offset 0 in every layout). The
 * cycle collector needs no vtable involvement: a cycle-capable hierarchy
 * object's header trace/teardown are stamped with the concrete class's
 * functions at allocation, which already is dynamic dispatch. */
typedef struct ScrVt {
  size_t pre, post;
  void (*release)(void *obj);
} ScrVt;

/* ── strings ──────────────────────────────────────────────────────────
 * UTF-8 bytes, refcounted, immutable. rc == SIZE_MAX marks an immortal
 * interned literal (emitted as a static object; retain/release are no-ops).
 * data is NUL-terminated for C convenience; len excludes the NUL.
 *
 * cap is the usable byte capacity of data[] excluding the NUL (allocation
 * is sizeof(ScrStr) + cap + 1); cap == len for interned literals and plain
 * allocations. Spare capacity (cap > len) exists only on concat results so
 * scr_str_concat can append in place when the left operand is uniquely
 * owned (rc == 1) — observable immutability is preserved: a string with
 * rc > 1 or rc == SIZE_MAX is never mutated.
 */
typedef struct ScrStr {
  size_t rc;
  size_t len;
  size_t cap;
  char data[];
} ScrStr;

ScrStr *scr_str_new(const char *bytes, size_t len); /* returns +1 */
/* Native callback boundary: copy and WHATWG-decode a UTF-8 span, replacing
 * malformed subsequences with U+FFFD. NULL with len == 0 is an empty span. */
ScrStr *scr_str_from_utf8_lossy(const uint8_t *bytes, size_t len); /* +1 */

/* Internal allocators for buffer builders (scr_json.c): a +1 string with
 * UNINITIALIZED data (the builder fills bytes, then len and the NUL), and
 * an rc==1-only realloc that grows capacity in place. Both keep the RC
 * audit's live count exact. */
ScrStr *scr_str_alloc_raw(size_t len, size_t cap);
ScrStr *scr_str_regrow(ScrStr *s, size_t newcap);

static inline ScrStr *scr_str_retain(ScrStr *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_str_release(ScrStr *s); /* NULL-tolerant (uninitialized locals) */

/* Borrow both args, return +1. */
ScrStr *scr_str_concat(ScrStr *a, ScrStr *b);

bool scr_str_eq(ScrStr *a, ScrStr *b);

/* memcmp byte order == code-point order (see SEMANTICS.md: diverges from
 * JS UTF-16 code-unit order only for non-BMP vs U+E000..U+FFFF). Returns
 * <0, 0, >0. */
int scr_str_cmp(ScrStr *a, ScrStr *b);

/* ECMAScript string-list ordering: compare UTF-16 code units even though
 * ScrStr stores well-formed UTF-8. Returns <0, 0, >0. */
int scr_str_cmp_u16(ScrStr *a, ScrStr *b);

/* ── class objects (classes as first-class values) ────────────────────
 * The class STATIC side as a runtime value: one emitted IMMORTAL static
 * per class the program takes as a value (`const X = C`, class
 * expressions, constructor-typed slots). One struct type covers every
 * class — the fields are class-independent — so containers and casts
 * never need per-class knowledge. `pre`/`post` are the SAME preorder
 * numbering the vtables carry (compile-time constants in the emitted
 * initializer), so `x instanceof X` through a value is the usual O(1)
 * interval check with the interval loaded from the class object. `ctor`
 * is the emitted construct thunk — the class's own completed-constructor
 * ABI returning `void *` (the compiler's flow rules guarantee every value
 * in a slot shares one ABI); `name` is the JS-observable `.name` string
 * (an interned immortal literal). rc is always SIZE_MAX: retain/release
 * are no-ops (the regex-literal discipline), the object holds no
 * references, and it can never be part of a cycle (trace = NULL). */
typedef struct ScrClassObj {
  size_t rc; /* SIZE_MAX — every class object is an immortal static */
  size_t pre, post;
  void *ctor;
  const ScrStr *name;
} ScrClassObj;

static inline ScrClassObj *scr_classobj_retain(ScrClassObj *c) {
  if (c->rc != SIZE_MAX) c->rc++;
  return c;
}
static inline void scr_classobj_release(ScrClassObj *c) {
  (void)c; /* immortal (NULL-tolerant like every release) */
}
/* void*-signature RC adapters (container slots) — scr_object.c. */
void *scr_classobj_retain_v(void *c);
void scr_classobj_release_v(void *c);
/* `X.name` (+1 — a no-op retain on the interned immortal). */
ScrStr *scr_classobj_name(ScrClassObj *c);
/* The keyed-write miss on a fixed-shape record: throws the catchable
 * TypeError naming the key (JS would add the property — the documented
 * monomorphic-struct divergence). scr_object.c. */
void scr_record_key_miss(ScrStr *k);

/* ── error objects (scr_error.c) ──────────────────────────────────────
 * `Error` and its lib subclasses (TypeError/RangeError/SyntaxError) are a
 * RUNTIME-PROVIDED hierarchy: ScrError lays out exactly like a compiler-
 * emitted hierarchy class (rc, vt, then the fields), so `class MyError
 * extends Error` compiles as an ordinary derived class whose struct embeds
 * this prefix, and every vtable mechanism (base-typed release, preorder-
 * interval instanceof) applies unchanged.
 *
 * The four builtin classes' vtables live HERE as mutable globals because
 * the runtime itself creates error instances (JSON/dynCheck/regex failures,
 * the island bridge) — but their preorder intervals depend on the whole
 * program's class forest, which only the compiler knows. Every emitted
 * main() stamps pre/post into these vtables before user code runs (the
 * defaults below only cover the moments before that), so runtime-made and
 * compiler-made error objects always agree on instanceof.
 *
 * Cycle capability is hierarchy-uniform and program-dependent (a user
 * subclass may hold closures): when the compiler's fixpoint marks the Error
 * hierarchy cycle-capable, main() also calls scr_error_set_traced() and
 * the runtime allocates its own error objects with collector headers. */
typedef struct ScrError {
  size_t rc;
  const ScrVt *vt;
  ScrStr *name;    /* "TypeError", or whatever the user assigned */
  ScrStr *message; /* "" when constructed without one, like Node */
  ScrStr *code;    /* NULL = absent (Node: no `code` property); fs/exec
                    * throw sites stamp the errno name ("ENOENT"). Part of
                    * the layout prefix: the compiler's %Error class defs
                    * carry a matching third field, so user subclasses
                    * embed the slot and release it NULL-guarded. */
  bool has_cause;  /* ErrorOptions carried an own `cause` property */
  struct ScrDyn *cause; /* owned; NULL when absent on runtime errors */
} ScrError;

enum {
  SCR_ERR_ERROR = 0,
  SCR_ERR_TYPE = 1,
  SCR_ERR_RANGE = 2,
  SCR_ERR_SYNTAX = 3,
  SCR_ERR_DOMEX = 4, /* DOMException — ScrDomException, the wider layout */
};

extern SCR_TL ScrVt scr_error_vts[5]; /* indexed by SCR_ERR_*; main() stamps pre/post */

struct ScrDyn; /* full declaration below (the checked-dynamic tree section) */

/* DOMException: the ScrError prefix (identical member order — an upcast is
 * a pointer reinterpret) plus the WebIDL code slot. The extra slot is HIDDEN
 * from the compiler's IR field list (user `extends DOMException` is fenced
 * so no subclass layout ever overlaps them); reads go through the
 * scr_domex_* accessors. */
typedef struct ScrDomException {
  size_t rc;
  const ScrVt *vt;
  ScrStr *name;    /* "Error" default, or the resolved WebIDL name */
  ScrStr *message; /* "" when constructed without one */
  ScrStr *code;    /* the Node string-code slot (stays NULL here) */
  bool has_cause;  /* inherited ErrorOptions presence bit */
  struct ScrDyn *cause; /* inherited owned ErrorOptions cause */
  double dom_code; /* the WebIDL legacy code (0 when the name is off-table) */
} ScrDomException;

/* new DOMException(message?, nameOrOptions?) — both dyn args borrowed,
 * NULL-tolerant (NULL = absent = the dyn undefined). Returns +1. Never
 * throws (dyn ToString is total). Lives in scr_json.c (the args are dyn
 * values); the dyn-free half below stays in scr_error.c so the error
 * unit links without the checked-dynamic tree. */
ScrError *scr_domex_new(const struct ScrDyn *message, const struct ScrDyn *name_or_options);
/* scr_error.c's dyn-free DOMException half: the blank allocation the
 * constructors fill, the WebIDL name→legacy-code table, and the cause
 * teardown hook scr_json.c installs before any cause can exist. */
ScrError *scr_domex_alloc(void);
double scr_domex_code_of(const ScrStr *name);
void scr_error_install_cause_drop(void (*fn)(void *obj));
double scr_domex_code(ScrError *e);           /* borrowed receiver */
bool scr_domex_has_cause(ScrError *e);        /* borrowed receiver */
struct ScrDyn *scr_domex_cause(ScrError *e);  /* +1 (dyn undefined when absent) */
/* structuredClone of a DOMException: WebIDL serialization — name/message
 * copy, the code re-derives, cause does not serialize. Borrowed receiver
 * and options (validated; throws on bad options / non-empty transfer).
 * +1, NULL after a throw. */
ScrError *scr_domex_clone(ScrError *e, const struct ScrDyn *options);
/* Throw a fresh DOMException through the exception cell (atob/btoa's
 * InvalidCharacterError sites). Copies both C strings; the _str form
 * takes ownership of the message. */
void scr_throw_domex(const char *name, const char *message);
void scr_throw_domex_str(const char *name, ScrStr *message);

/* Switch runtime-side error allocation to collector-headered (called from
 * main() when the compiler's cycle fixpoint marks the hierarchy). */
void scr_error_set_traced(void);

/* Allocate + initialize (name = the kind's builtin name, message retained
 * from the borrowed argument; NULL means ""). Returns +1. */
ScrError *scr_error_new(int kind, ScrStr *message);
ScrError *scr_error_new_cause(int kind, ScrStr *message, const struct ScrDyn *cause);
struct ScrDyn *scr_error_cause(ScrError *e); /* +1; dyn undefined when absent */
/* Initialize the error prefix of an already-allocated (zeroed) object —
 * the super(message) call of a compiled `extends Error` constructor. Both
 * arguments are borrowed. */
void scr_error_init(void *obj, int kind, ScrStr *message);
/* ECMA Error.prototype.toString: "", name, message, or "name: message".
 * Borrows e, returns +1. */
ScrStr *scr_error_to_string(ScrError *e);

ScrError *scr_error_retain(ScrError *e);
void scr_error_release(ScrError *e); /* dispatches through e->vt */
void *scr_error_retain_v(void *e);
void scr_error_release_v(void *e);
void scr_error_trace(void *e, ScrTraceVisit visit, void *ctx); /* no headered children */
ScrTraceFn scr_error_trace_arg(void); /* &scr_error_trace when traced, else NULL */

/* True when a thrown hierarchy object (SCR_EXC_OBJ payload) is an Error —
 * its vtable's preorder lies inside Error's stamped interval. */
bool scr_error_is(const void *obj);

/* Throw a fresh builtin error through the exception cell. scr_throw_error
 * takes ownership of message; the _msg form copies the C string. The _named
 * form (island bridge) takes ownership of both strings and picks the
 * builtin vtable whose class name matches `name` (Error otherwise). */
void scr_throw_error(int kind, ScrStr *message);
void scr_throw_error_msg(int kind, const char *message, size_t len);
void scr_throw_error_named(ScrStr *name, ScrStr *message);
/* A read of a declare-d const nothing defines: throws Node's catchable
 * ReferenceError "<name> is not defined". Borrows name; always throws. */
void scr_undef_global_read(ScrStr *name);
/* The `code` slot (NodeJS.ErrnoException's .code): set stamps a fresh
 * string from the C literal (replacing any previous value); get answers
 * +1 or NULL when absent (the compiler's undefined arm). The _msg_code
 * thrower is scr_throw_error_msg with the code stamped on the payload. */
void scr_error_set_code(ScrError *e, const char *code);
ScrStr *scr_error_code(ScrError *e);
void scr_throw_error_msg_code(int kind, const char *message, size_t len, const char *code);
/* The compiler-resolved Node-parity throw (error.nodeThrow): builtin
 * error of `kind`, `code` stamped when non-empty. Borrows both. */
void scr_throw_node_coded(double kind, const ScrStr *code, const ScrStr *msg);

/* ── string methods ─────────────────────────────────────────────────
 * ECMA-262 observable semantics over UTF-8 storage with UTF-16 code-unit
 * indices. A per-instance side cache keeps length/cursor state and sparse
 * navigation checkpoints for large strings, making warmed
 * non-local indexed operations bounded by one checkpoint interval. All
 * double index/count arguments go through ToIntegerOrInfinity (NaN → 0, trunc
 * toward zero, ±Infinity kept), exactly like JS. Every function borrows its
 * ScrStr arguments; functions returning ScrStr* return a +1 reference.
 *
 * One documented divergence (JS lone surrogates are unrepresentable in
 * well-formed UTF-8): where JS would produce a *lone surrogate* — charAt on
 * half of an astral pair, or a slice boundary that splits a pair — the
 * result contains U+FFFD (EF BF BD) in its place. Numeric results
 * (charCodeAt) are NOT affected: they return the exact surrogate code unit
 * value, computed from the code point.
 */

/* .length — number of UTF-16 code units (astral chars count as 2). */
double scr_str_utf16_len(ScrStr *s);

/* charCodeAt(i): the i-th UTF-16 code unit as a number; for astral chars
 * returns the high (0xD800+) or low (0xDC00+) surrogate value depending on
 * which half i addresses. NaN when ToIntegerOrInfinity(i) is outside
 * [0, length) — note charCodeAt(1.5) is index 1, matching Node. */
double scr_str_char_code_at(ScrStr *s, double i);
double scr_str_code_point_at(ScrStr *s, double i);

/* indexOf(needle, fromIndex): UTF-16 index of the first occurrence at or
 * after fromIndex (clamped to [0, length]), or -1. Empty needle returns the
 * clamped fromIndex per spec. */
double scr_str_index_of(ScrStr *s, ScrStr *needle, double fromIndex);

/* lastIndexOf(needle): the one-argument form returns the last occurrence's
 * UTF-16 index, or -1. Empty needle returns length. */
double scr_str_last_index_of(ScrStr *s, ScrStr *needle, double position);

/* lastIndexOf(needle, position): search at or before the clamped UTF-16
 * position. NaN starts at the end, including for an empty needle. */
double scr_str_last_index_of_from(ScrStr *s, ScrStr *needle, double position);

/* includes(needle) — no position argument. Empty needle → true. */
bool scr_str_includes(ScrStr *s, ScrStr *needle);

void scr_http_client_flush_headers(ScrHttpClientReq *c);
void scr_http_client_set_header(ScrHttpClientReq *c, ScrStr *name /*borrowed*/, ScrStr *value /*borrowed*/);
ScrStr *scr_http_client_get_header(ScrHttpClientReq *c, ScrStr *name /*borrowed*/); /* +1 or NULL */
bool scr_http_client_has_header_named(ScrHttpClientReq *c, ScrStr *name /*borrowed*/);
void scr_http_client_remove_header(ScrHttpClientReq *c, ScrStr *name /*borrowed*/);
ScrArr *scr_http_client_get_header_names(ScrHttpClientReq *c); /* +1 */
ScrArr *scr_http_client_get_raw_header_names(ScrHttpClientReq *c); /* +1 */
ScrDyn *scr_http_client_get_headers(ScrHttpClientReq *c); /* +1 */
ScrStr *scr_http_client_method(ScrHttpClientReq *c); /* +1 */
ScrStr *scr_http_client_path(ScrHttpClientReq *c); /* +1 */
ScrStr *scr_http_client_host(ScrHttpClientReq *c); /* +1 */
ScrStr *scr_http_client_protocol(ScrHttpClientReq *c); /* +1 */
bool scr_http_client_headers_sent(ScrHttpClientReq *c);
bool scr_http_client_writable_ended(ScrHttpClientReq *c);
bool scr_http_client_writable_finished(ScrHttpClientReq *c);
ScrNetSocket *scr_http_client_socket(ScrHttpClientReq *c); /* +1 */
bool scr_http_client_reused_socket(ScrHttpClientReq *c);
void scr_http_client_set_nodelay(ScrHttpClientReq *c, bool enable);
void scr_http_client_set_socket_keepalive(ScrHttpClientReq *c, bool enable, double delay_ms);
void scr_http_client_set_timeout_cb(ScrHttpClientReq *c, double ms, ScrClosure *cb /*moves*/);
void scr_http_client_add_trailers(ScrHttpClientReq *c, ScrArr *pairs /*borrowed*/);
void scr_http_client_cork(ScrHttpClientReq *c);
void scr_http_client_uncork(ScrHttpClientReq *c);
double scr_http_client_writable_corked(ScrHttpClientReq *c);
