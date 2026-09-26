#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Live heap-string count for the RC audit lane (-DSCR_RC_AUDIT): the test
 * harness builds with it to prove the emitted retain/release discipline
 * leaks nothing and frees nothing twice (double-free shows up as ASan
 * use-after-free on the rc field or a negative count here). */
#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_strings = 0;
long scr_str_live_count(void) { return scr_live_strings; }
#endif

static void scr_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* Weak, bounded interning for tiny slices (including non-ASCII characters).
 * Unlike an owning cache, this never keeps a string alive: its last release
 * removes the entry. Collisions simply replace the weak pointer. A unique
 * string can still be appended to or reallocated, so those paths invalidate
 * the entry before touching its bytes/address. No ScrStr ABI change. */
#define SCR_SHORT_N 64
static SCR_TL ScrStr *scr_short_tab[SCR_SHORT_N];

static size_t scr_short_hash(const char *bytes, size_t len) {
  size_t h = len;
  for (size_t i = 0; i < len; i++) h = h * 31 + (unsigned char)bytes[i];
  return h % SCR_SHORT_N;
}

static void scr_short_forget(const ScrStr *s) {
  if (s->len < 2 || s->len > 4) return;
  size_t h = scr_short_hash(s->data, s->len);
  if (scr_short_tab[h] == s) scr_short_tab[h] = NULL;
}

/* ── UTF-16 index cache ───────────────────────────────────────────────
 * JS string semantics are UTF-16 indices over our UTF-8 storage, so
 * .length, charCodeAt, charAt, indexOf and slice all need unit↔byte
 * conversions. A four-entry direct cursor cache keeps the old hot cursor for
 * tiny and allocation-failure traffic. A separate four-entry sparse cache
 * owns `{ UTF-16 unit, UTF-8 byte }` checkpoints, so a warmed non-local
 * lookup decodes at most one checkpoint interval instead of a prefix
 * proportional to its requested index.
 *
 * Checkpoints are owned by the entry, not the ScrStr ABI: the representation
 * remains the three-word UTF-8 ScrStr used by literals, FFI and generated
 * code. Checkpoints cost two size_ts every 4 KiB (about 0.39% of indexed
 * bytes). There are exactly four sparse entries per runtime instance;
 * eviction, release, realloc, executable exit, and every library reset free
 * retained metadata. The cursor and sparse tiers are deliberately separate:
 * fresh short receivers never evict a retained large-string index. This
 * fixed residency is intentional: registry lookup and the release of
 * unrelated strings never scale with the number of live indexed receivers.
 * SCR_TL makes both tables and owned buffers instance-local for
 * SCR_THREAD_INSTANCES. Metadata allocation is strictly an optimization:
 * overflow or malloc failure falls back to the cursor mapper.
 */
#define SCR_SIDX_N 4
#define SCR_U16_UNKNOWN SIZE_MAX
#define SCR_SIDX_MIN_BYTES ((size_t)64 * 1024)
#define SCR_SIDX_STRIDE_BYTES ((size_t)4 * 1024)
typedef struct {
  size_t cu; /* UTF-16 code-unit offset, always a code-point boundary */
  size_t cb; /* matching UTF-8 byte offset, never a continuation byte */
} ScrSidxPoint;
typedef struct ScrSidx {
  const ScrStr *s;       /* NULL = empty slot */
  size_t u16len;         /* SCR_U16_UNKNOWN until the whole current string */
  size_t cu, cb;         /* hot cursor: cb starts the char at unit cu */
  ScrSidxPoint *points;  /* sparse, ordered code-point-boundary anchors */
  size_t npoints, cap;   /* owned points length/capacity */
  size_t indexed_cu;     /* exact contiguous prefix indexed from byte zero */
  size_t indexed_cb;
  bool no_more_points;   /* metadata allocation failed/overflowed: fail open */
  bool points_complete;  /* points cover every stride of indexed prefix */
} ScrSidx;
/* Keep short-string cursor traffic out of the sparse cache. A short-lived
 * one-byte receiver can be far more common than a large indexed one; sharing
 * the round-robin slots would otherwise rebuild a warm index every few calls.
 */
static SCR_TL ScrSidx scr_sidx_sparse_tab[SCR_SIDX_N];
static SCR_TL ScrSidx scr_sidx_cursor_tab[SCR_SIDX_N];
static SCR_TL unsigned scr_sidx_sparse_clock;
static SCR_TL unsigned scr_sidx_cursor_clock;
static SCR_TL bool scr_sidx_cleanup_registered;

static void scr_sidx_clear(ScrSidx *e) {
  free(e->points);
  memset(e, 0, sizeof(*e));
}

static void scr_sidx_reset_all(void) {
  for (int i = 0; i < SCR_SIDX_N; i++) {
    scr_sidx_clear(&scr_sidx_sparse_tab[i]);
    scr_sidx_clear(&scr_sidx_cursor_tab[i]);
  }
  scr_sidx_sparse_clock = 0;
  scr_sidx_cursor_clock = 0;
}

static void scr_sidx_register_cleanup(void) {
  if (!scr_sidx_cleanup_registered) {
    scr_sidx_cleanup_registered = true;
    scr_atexit(scr_sidx_reset_all);
  }
}

#ifdef SCR_SIDX_TEST
static SCR_TL size_t scr_sidx_walk_steps;
void scr_sidx_test_reset_steps(void) { scr_sidx_walk_steps = 0; }
size_t scr_sidx_test_walk_steps(void) { return scr_sidx_walk_steps; }
void scr_sidx_test_reset_cache(void) { scr_sidx_reset_all(); }
size_t scr_sidx_test_entries(void) {
  size_t n = 0;
  for (int i = 0; i < SCR_SIDX_N; i++)
    n += scr_sidx_sparse_tab[i].s != NULL;
  return n;
}
size_t scr_sidx_test_points(void) {
  size_t n = 0;
  for (int i = 0; i < SCR_SIDX_N; i++)
    n += scr_sidx_sparse_tab[i].npoints;
  return n;
}
#define SCR_SIDX_STEP() (scr_sidx_walk_steps++)
#else
#define SCR_SIDX_STEP() ((void)0)
#endif

static void scr_sidx_purge(const ScrStr *s) {
  /* These are deliberately fixed four-entry tables, never an unbounded
   * receiver registry. Releasing an unrelated temporary therefore does at
   * most eight pointer comparisons and cannot grow with live strings. */
  for (int i = 0; i < SCR_SIDX_N; i++) {
    if (scr_sidx_sparse_tab[i].s == s)
      scr_sidx_clear(&scr_sidx_sparse_tab[i]);
    if (scr_sidx_cursor_tab[i].s == s)
      scr_sidx_clear(&scr_sidx_cursor_tab[i]);
  }
}

static void scr_sidx_init(ScrSidx *e, const ScrStr *s) {
  memset(e, 0, sizeof(*e));
  e->s = s;
  e->u16len = SCR_U16_UNKNOWN;
}

/* Short strings retain the historical hot cursor without contending with the
 * sparse residency. Large strings claim only the sparse tier; an in-place
 * append that crosses the threshold moves its exact cursor frontier into
 * that tier rather than scanning the unchanged prefix again. All-ASCII
 * receivers still shed their point buffer after proving identity mapping.
 * Both tiers remain fixed-size and allocation-free until a non-ASCII sparse
 * receiver actually needs checkpoints. */
static ScrSidx *scr_sidx(const ScrStr *s) {
  if (s->len >= SCR_SIDX_MIN_BYTES) {
    for (int i = 0; i < SCR_SIDX_N; i++) {
      if (scr_sidx_sparse_tab[i].s == s) return &scr_sidx_sparse_tab[i];
    }
    /* The only in-place mutation is append. A formerly short receiver can
     * therefore cross the threshold with an exact, useful cursor frontier
     * already in the cursor tier; transfer it before evicting a sparse slot.
     * No checkpoint buffer can exist below the threshold, but moving the
     * whole record also preserves the fail-open allocation state. */
    for (int i = 0; i < SCR_SIDX_N; i++) {
      ScrSidx *old = &scr_sidx_cursor_tab[i];
      if (old->s != s) continue;
      ScrSidx *e = &scr_sidx_sparse_tab[
          scr_sidx_sparse_clock++ % SCR_SIDX_N];
      scr_sidx_clear(e);
      *e = *old;
      memset(old, 0, sizeof(*old)); /* ownership moved to the sparse tier */
      return e;
    }
    ScrSidx *e =
        &scr_sidx_sparse_tab[scr_sidx_sparse_clock++ % SCR_SIDX_N];
    scr_sidx_clear(e);
    scr_sidx_init(e, s);
    return e;
  }
  ScrSidx *tab = scr_sidx_cursor_tab;
  unsigned *clock = &scr_sidx_cursor_clock;
  for (int i = 0; i < SCR_SIDX_N; i++) {
    if (tab[i].s == s) return &tab[i];
  }
  ScrSidx *e = &tab[(*clock)++ % SCR_SIDX_N];
  scr_sidx_clear(e);
  scr_sidx_init(e, s);
  return e;
}

/* In-place concat changes only the suffix. Keep every exact prefix anchor
 * (including the former end, which is now an ordinary boundary), but remove
 * the sole fact that described the old complete string. A threshold-crossing
 * receiver may move from the cursor tier to the sparse tier on its next
 * lookup, so invalidate either possible entry. */
static void scr_sidx_concat_append(const ScrStr *s, size_t oldlen) {
  for (int i = 0; i < SCR_SIDX_N; i++) {
    ScrSidx *entries[] = {&scr_sidx_sparse_tab[i], &scr_sidx_cursor_tab[i]};
    for (size_t j = 0; j < sizeof(entries) / sizeof(entries[0]); j++) {
      ScrSidx *e = entries[j];
      if (e->s != s) continue;
      e->u16len = SCR_U16_UNKNOWN;
      if (e->indexed_cb > oldlen) e->indexed_cb = oldlen;
    }
  }
}

/* ── allocation ─────────────────────────────────────────────────────── */

static ScrStr *scr_str_alloc(size_t len, size_t cap) {
  ScrStr *s = malloc(sizeof(ScrStr) + cap + 1);
  if (!s) scr_oom();
  s->rc = 1;
  s->len = len;
  s->cap = cap;
#ifdef SCR_RC_AUDIT
  scr_live_strings++;
#endif
  return s;
}

ScrStr *scr_str_new(const char *bytes, size_t len) {
  ScrStr *s = scr_str_alloc(len, len);
  memcpy(s->data, bytes, len);
  s->data[len] = '\0';
  return s;
}

/* One-slot free-block cache for concat callers that must copy: observable
 * aliases, `s = s + s`, and non-canonical concat shapes still allocate a
 * replacement result. The compiler's canonical self-assignment handoff
 * leaves its left snapshot uniquely owned, so it instead uses the in-place
 * path below; this cache remains useful for the copy cases. Disabled in the
 * audit lane so ASan sees every logical free as a real free. */
#ifndef SCR_RC_AUDIT
static SCR_TL ScrStr *scr_str_spare;
#endif

/* A spare-block reuse must not waste grossly (cap <= 4x the need) and only
 * sizable blocks are worth stashing (>= 512). */
static ScrStr *scr_str_take_spare(size_t len) {
#ifndef SCR_RC_AUDIT
  ScrStr *s = scr_str_spare;
  if (s && s->cap >= len && s->cap / 4 <= len) {
    scr_str_spare = NULL;
    s->rc = 1;
    s->len = len; /* keeps its larger cap */
    return s;
  }
#else
  (void)len;
#endif
  return NULL;
}

/* Builder entry points (scr_json.c): raw block with undefined bytes, and
 * an rc==1-only grow. The spare block is worth trying first — a stringify
 * loop's previous output is usually the right size for the next one. */
ScrStr *scr_str_alloc_raw(size_t len, size_t cap) {
  ScrStr *s = scr_str_take_spare(cap);
  if (!s) return scr_str_alloc(len, cap);
  s->len = len; /* keeps its (possibly larger) cap */
  return s;
}

ScrStr *scr_str_regrow(ScrStr *s, size_t newcap) {
  scr_short_forget(s);
  scr_sidx_purge(s); /* realloc may move; the old address may be recycled */
  ScrStr *r = realloc(s, sizeof(ScrStr) + newcap + 1);
  if (!r) scr_oom();
  r->cap = newcap;
  return r;
}

void scr_str_release(ScrStr *s) {
  if (!s || s->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--s->rc == 0) {
    scr_short_forget(s);
    scr_sidx_purge(s); /* the address may be recycled by the next malloc */
#ifdef SCR_RC_AUDIT
    scr_live_strings--;
#endif
#ifndef SCR_RC_AUDIT
    if (s->cap >= 512) {
      ScrStr *old = scr_str_spare;
      scr_str_spare = s;
      if (!old) return;
      s = old; /* evict the previous spare */
    }
#endif
    free(s);
  }
}

ScrStr *scr_str_concat(ScrStr *a, ScrStr *b) {
  if (a->len > SIZE_MAX - b->len - sizeof(ScrStr) - 1) scr_oom();
  size_t newlen = a->len + b->len;
  /* In-place append: a is uniquely owned by the caller's borrow (rc == 1 —
   * never an interned literal, those are SIZE_MAX) and has room. Fires on
   * concat chains (`a + b + c`, template literals), where each intermediate
   * result reaches the next concat as a sole-reference temp. Any string
   * with rc > 1 might be aliased and is copied, never mutated. */
  if (a->rc == 1 && a != b && a->cap >= newlen) {
    size_t oldlen = a->len;
    scr_short_forget(a);
    memcpy(a->data + a->len, b->data, b->len);
    a->len = newlen;
    a->data[newlen] = '\0';
    /* A cached UTF-16 length for a is stale now; checkpoints and the exact
     * old prefix remain valid. Its old terminal point is no longer an END
     * fact (u16len is invalidated below), but remains an excellent ordinary
     * checkpoint for accesses around the append boundary. The next mapper
     * lazily continues from oldlen rather than scanning the unchanged prefix
     * again. */
    scr_sidx_concat_append(a, oldlen);
    a->rc = 2; /* +1 for the returned reference, beside the caller's borrow */
    return a;
  }
  /* Copy path. Geometric slack keeps uniquely-owned concat chains and the
   * optimized self-assignment handoff amortized when they outgrow capacity.
   * Aliases and `s = s + s` deliberately arrive with rc > 1 and stay on this
   * path, preserving string immutability; their sizable replacement results
   * can still benefit from the spare-block cache above. */
  size_t newcap = newlen;
  if (a->rc == 1) {
    size_t grown = a->cap + (a->cap >> 1) + 16;
    if (grown > newcap) newcap = grown;
  } else if (newlen >= 512 && newlen <= (SIZE_MAX - sizeof(ScrStr) - 1) / 2) {
    newcap = newlen + (newlen >> 1);
  }
  ScrStr *s = scr_str_take_spare(newlen);
  if (!s) s = scr_str_alloc(newlen, newcap);
  memcpy(s->data, a->data, a->len);
  memcpy(s->data + a->len, b->data, b->len);
  s->data[newlen] = '\0';
  return s;
}

bool scr_str_eq(ScrStr *a, ScrStr *b) {
  return a == b || (a->len == b->len && memcmp(a->data, b->data, a->len) == 0);
}

int scr_str_cmp(ScrStr *a, ScrStr *b) {
  size_t min = a->len < b->len ? a->len : b->len;
  int c = memcmp(a->data, b->data, min);
  if (c != 0) return c;
  return a->len < b->len ? -1 : (a->len > b->len ? 1 : 0);
}

/* UTF-16 code-unit comparison over well-formed UTF-8 (the default
 * Array.sort/toSorted and URLSearchParams.sort order). Byte order ALMOST
 * matches — the exception is U+E000..U+FFFF (3-byte UTF-8, single high code
 * units) vs supplementary code points (4-byte UTF-8, surrogate pairs
 * 0xD800..0xDFFF): bytes put the 4-byte form last, code units put it first.
 * Decode code points and compare their leading UTF-16 units. */
static uint32_t scr_str_lead_u16(const unsigned char *s, size_t len,
                                size_t *adv) {
  unsigned char b = s[0];
  uint32_t cp;
  size_t n;
  if (b < 0x80) {
    cp = b; n = 1;
  } else if ((b & 0xe0) == 0xc0) {
    cp = b & 0x1fu; n = 2;
  } else if ((b & 0xf0) == 0xe0) {
    cp = b & 0x0fu; n = 3;
  } else {
    cp = b & 0x07u; n = 4;
  }
  if (n > len) n = len; /* defensive: strings are well-formed by contract */
  for (size_t i = 1; i < n; i++) cp = (cp << 6) | (s[i] & 0x3fu);
  *adv = n;
  if (cp >= 0x10000) return 0xd800 + ((cp - 0x10000) >> 10);
  return cp;
}

int scr_str_cmp_u16(ScrStr *a, ScrStr *b) {
  size_t ia = 0, ib = 0;
  while (ia < a->len && ib < b->len) {
    size_t na, nb;
    uint32_t ua = scr_str_lead_u16(
        (const unsigned char *)a->data + ia, a->len - ia, &na);
    uint32_t ub = scr_str_lead_u16(
        (const unsigned char *)b->data + ib, b->len - ib, &nb);
    if (ua != ub) return ua < ub ? -1 : 1;
    /* Equal leading units: equal whole code points (both single units or
     * both pairs with equal highs — lows only differ if cps differ). */
    if (na == 4 && nb == 4) {
      uint32_t cpa = 0, cpb = 0;
      for (size_t i = 0; i < 4; i++) {
        cpa = (cpa << 6) |
              (i == 0 ? (unsigned char)a->data[ia] & 0x07u
                      : (unsigned char)a->data[ia + i] & 0x3fu);
        cpb = (cpb << 6) |
              (i == 0 ? (unsigned char)b->data[ib] & 0x07u
                      : (unsigned char)b->data[ib + i] & 0x3fu);
      }
      if (cpa != cpb) return cpa < cpb ? -1 : 1;
    }
    ia += na;
    ib += nb;
  }
  if (ia < a->len) return 1;
  if (ib < b->len) return -1;
  return 0;
}

/* ── interned strings ─────────────────────────────────────────────────
 * The empty string and every single-character ASCII string are immortal
 * statics (same layout the emitter uses for literals): charAt/slice churn
 * in tight loops returns these without allocating.
 */
typedef struct { size_t rc; size_t len; size_t cap; char data[2]; } ScrChar1;
#define SCR_A(c) {SIZE_MAX, 1, 1, {(char)(c), 0}}
#define SCR_A8(c) \
  SCR_A(c), SCR_A(c + 1), SCR_A(c + 2), SCR_A(c + 3), \
  SCR_A(c + 4), SCR_A(c + 5), SCR_A(c + 6), SCR_A(c + 7)
static const ScrChar1 scr_ascii1[128] = {
  SCR_A8(0),   SCR_A8(8),   SCR_A8(16),  SCR_A8(24),
  SCR_A8(32),  SCR_A8(40),  SCR_A8(48),  SCR_A8(56),
  SCR_A8(64),  SCR_A8(72),  SCR_A8(80),  SCR_A8(88),
  SCR_A8(96),  SCR_A8(104), SCR_A8(112), SCR_A8(120),
};
static const struct { size_t rc; size_t len; size_t cap; char data[1]; }
    scr_lit_empty = {SIZE_MAX, 0, 0, ""};

static ScrStr *scr_str_empty(void) { return (ScrStr *)&scr_lit_empty; }

/* Empty/ASCII characters are immortal; tiny spans share live heap strings. */
static ScrStr *scr_str_from_span(const char *bytes, size_t len) {
  if (len == 0) return scr_str_empty();
  if (len == 1 && (unsigned char)bytes[0] < 0x80) {
    return (ScrStr *)&scr_ascii1[(unsigned char)bytes[0]];
  }
  if (len >= 2 && len <= 4) {
    size_t h = scr_short_hash(bytes, len);
    ScrStr *cached = scr_short_tab[h];
    if (cached && cached->len == len && memcmp(cached->data, bytes, len) == 0)
      return scr_str_retain(cached);
    ScrStr *s = scr_str_new(bytes, len);
    scr_short_tab[h] = s;
    return s;
  }
  return scr_str_new(bytes, len);
}

/* A scalar fromCharCode needs neither the variadic argument array nor an
 * encoding buffer. Reuse the same empty/ASCII/tiny-span storage policy as
 * character indexing. A lone surrogate keeps the existing U+FFFD policy. */
ScrStr *scr_str_from_char_code_one(double code) {
  uint32_t cp = scr_to_uint32(code) & 0xFFFFu;
  if (cp < 0x80) return (ScrStr *)&scr_ascii1[cp];
  if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
  char bytes[3];
  if (cp < 0x800) {
    bytes[0] = (char)(0xC0 | (cp >> 6));
    bytes[1] = (char)(0x80 | (cp & 0x3F));
    return scr_str_from_span(bytes, 2);
  }
  bytes[0] = (char)(0xE0 | (cp >> 12));
  bytes[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
  bytes[2] = (char)(0x80 | (cp & 0x3F));
  return scr_str_from_span(bytes, 3);
}

/* ── string methods: UTF-16 semantics over UTF-8 storage ──────────
 * All strings in the system are well-formed UTF-8 (the compiler replaces
 * lone surrogates in literals with U+FFFD), so the decode helpers below
 * may assume valid sequences and never validate.
 */

/* UTF-8 encoding of U+FFFD REPLACEMENT CHARACTER — stands in for the lone
 * surrogate JS would produce when charAt/slice split an astral pair. */
#define SCR_REPLACEMENT "\xEF\xBF\xBD"
#define SCR_REPLACEMENT_LEN ((size_t)3)

/* Byte length of the well-formed UTF-8 sequence starting at lead byte c. */
static size_t scr_utf8_seq_len(unsigned char c) {
  if (c < 0x80) return 1;
  if (c < 0xE0) return 2;
  if (c < 0xF0) return 3;
  return 4;
}

/* Decode the code point at p (well-formed UTF-8); *adv gets the byte
 * length of the sequence. */
static uint32_t scr_utf8_decode(const char *p, size_t *adv) {
  unsigned char c = (unsigned char)p[0];
  if (c < 0x80) {
    *adv = 1;
    return c;
  }
  if (c < 0xE0) {
    *adv = 2;
    return ((uint32_t)(c & 0x1F) << 6) | ((unsigned char)p[1] & 0x3F);
  }
  if (c < 0xF0) {
    *adv = 3;
    return ((uint32_t)(c & 0x0F) << 12) |
           ((uint32_t)((unsigned char)p[1] & 0x3F) << 6) |
           ((unsigned char)p[2] & 0x3F);
  }
  *adv = 4;
  return ((uint32_t)(c & 0x07) << 18) |
         ((uint32_t)((unsigned char)p[1] & 0x3F) << 12) |
         ((uint32_t)((unsigned char)p[2] & 0x3F) << 6) |
         ((unsigned char)p[3] & 0x3F);
}

/* Number of UTF-16 code units in a valid UTF-8 span (BMP char = 1, astral
 * char = 2). Byte classification is position-independent, so sparse-index
 * construction can count one checkpoint interval at a time without giving
 * up the word-at-a-time length fast path. */
static size_t scr_utf16_units_span(const char *data, size_t len,
                                   bool *all_ascii) {
  const unsigned char *d = (const unsigned char *)data;
  const uint64_t hibits = 0x8080808080808080ull;
  size_t units = 0, i = 0;
  bool ascii = true;
  while (i + 8 <= len) {
    uint64_t w;
    memcpy(&w, d + i, 8);
    i += 8;
    if ((w & hibits) == 0) { /* all ASCII */
      units += 8;
      continue;
    }
    ascii = false;
    uint64_t cont = w & ~(w << 1) & hibits;
    uint64_t lead4 = w & (w << 1) & (w << 2) & (w << 3) & hibits;
    units += 8 - (size_t)__builtin_popcountll(cont) +
             (size_t)__builtin_popcountll(lead4);
  }
  while (i < len) {
    unsigned char c = d[i++];
    if ((c & 0xC0) == 0x80) continue;  /* continuation byte */
    if (c >= 0x80) ascii = false;
    units += c >= 0xF0 ? 2 : 1;
  }
  if (all_ascii) *all_ascii = ascii;
  return units;
}

/* Keep a start anchor, every stride crossed, and an exact final/prefix
 * anchor. All calls arrive at character boundaries. Returning false simply
 * means allocation failed and the hot cursor should handle this string. */
static bool scr_sidx_add_point(ScrSidx *e, size_t cu, size_t cb,
                               bool force) {
  if (e->no_more_points) return false;
  if (e->npoints != 0) {
    ScrSidxPoint last = e->points[e->npoints - 1];
    if (last.cb == cb) return true;
    if (!force && cb - last.cb < SCR_SIDX_STRIDE_BYTES) return true;
  }
  if (e->npoints == e->cap) {
    size_t cap = e->cap == 0 ? 16 : e->cap;
    if (e->cap != 0) {
      if (cap > SIZE_MAX / 2) {
        e->no_more_points = true;
        return false;
      }
      cap *= 2;
    }
    if (cap > SIZE_MAX / sizeof(*e->points)) {
      e->no_more_points = true;
      return false;
    }
    ScrSidxPoint *points = realloc(e->points, cap * sizeof(*points));
    if (!points) {
      e->no_more_points = true;
      return false;
    }
    e->points = points;
    e->cap = cap;
    scr_sidx_register_cleanup();
  }
  e->points[e->npoints++] = (ScrSidxPoint){cu, cb};
  return true;
}

/* Enable sparse state only where a 16-byte checkpoint buffer is a much
 * better trade than repeatedly walking a short string. If a completed
 * ASCII scan later proves identity mapping, all of this storage is freed. */
static bool scr_sidx_prepare_points(const ScrStr *s, ScrSidx *e) {
  if (s->len < SCR_SIDX_MIN_BYTES || e->no_more_points) return false;
  if (e->npoints == 0) {
    if (!scr_sidx_add_point(e, 0, 0, true)) return false;
    /* concat may have left an exact old end/frontier without a previous
     * buffer (notably an all-ASCII prefix). Backfill that known identity
     * span arithmetically — never rescan it just to create anchors. Exact
     * identity means every stride is also a UTF-16/code-point boundary. */
    if (e->indexed_cb != 0 && e->indexed_cb == e->indexed_cu) {
      for (size_t at = SCR_SIDX_STRIDE_BYTES; at < e->indexed_cb;) {
        if (!scr_sidx_add_point(e, at, at, true)) return false;
        if (at > e->indexed_cb - SCR_SIDX_STRIDE_BYTES) break;
        at += SCR_SIDX_STRIDE_BYTES;
      }
    }
    if (e->indexed_cb != 0 &&
        !scr_sidx_add_point(e, e->indexed_cu, e->indexed_cb, true)) {
      return false;
    }
    /* A pre-existing mixed prefix can only belong to a receiver that grew
     * across the admission threshold while it was in the cursor tier. Its
     * exact terminal anchor is useful immediately, but it does not promise
     * a stride-bounded route through that old prefix. On completion, rebuild
     * once from zero rather than mistaking this short-history anchor for a
     * fully formed sparse index. */
    e->points_complete = e->indexed_cb == e->indexed_cu;
  }
  return true;
}

/* The first code-point boundary at or after cb + SCR_SIDX_STRIDE_BYTES. */
static size_t scr_sidx_next_boundary(const ScrStr *s, size_t cb) {
  size_t remain = s->len - cb;
  size_t end = cb + (remain < SCR_SIDX_STRIDE_BYTES
                         ? remain : SCR_SIDX_STRIDE_BYTES);
  while (end < s->len && ((unsigned char)s->data[end] & 0xC0) == 0x80) end++;
  return end;
}

/* Extend the exact prefix frontier by one sparse interval. The span helper
 * retains the old length throughput; the resulting point is always a real
 * UTF-8 character boundary. */
static bool scr_sidx_extend_one(const ScrStr *s, ScrSidx *e) {
  if (e->indexed_cb == s->len) return false;
  size_t end = scr_sidx_next_boundary(s, e->indexed_cb);
  bool ascii;
  size_t units = scr_utf16_units_span(s->data + e->indexed_cb,
                                      end - e->indexed_cb, &ascii);
  /* Defer metadata until a large string proves it needs UTF-8 navigation.
   * A long ASCII prefix is already an exact identity map; when this is the
   * first mixed interval, prepare_points backfills that prefix arithmetically
   * before it is ever rescanned. */
  if (ascii && e->npoints == 0 && !e->no_more_points) {
    e->indexed_cu += units;
    e->indexed_cb = end;
    return true;
  }
  if (e->npoints == 0) (void)scr_sidx_prepare_points(s, e);
  e->indexed_cu += units;
  e->indexed_cb = end;
  if (e->npoints != 0) (void)scr_sidx_add_point(e, e->indexed_cu,
                                                  e->indexed_cb, true);
  return true;
}

/* A formerly small mixed string can cross the sparse-index threshold through
 * an ASCII in-place append. Its exact prefix already covers the whole new
 * string, so the ordinary extension path has no non-ASCII interval that
 * would cause prepare_points() to allocate anchors. Rebuild once in that
 * narrow transition instead of leaving a threshold-sized non-ASCII string
 * with only the hot cursor. This is still fail-open: an allocation failure
 * leaves the completed length/cursor cache fully usable. */
static void scr_sidx_rebuild_points(const ScrStr *s, ScrSidx *e) {
  if (s->len < SCR_SIDX_MIN_BYTES || e->points_complete ||
      e->no_more_points)
    return;
  free(e->points);
  e->points = NULL;
  e->npoints = 0;
  e->cap = 0;
  size_t cu = 0, cb = 0;
  if (!scr_sidx_add_point(e, cu, cb, true)) return;
  while (cb < s->len) {
    size_t end = scr_sidx_next_boundary(s, cb);
    cu += scr_utf16_units_span(s->data + cb, end - cb, NULL);
    cb = end;
    if (!scr_sidx_add_point(e, cu, cb, true)) return;
  }
  e->points_complete = true;
}

static void scr_sidx_finish(const ScrStr *s, ScrSidx *e) {
  if (e->indexed_cb != s->len) return;
  e->u16len = e->indexed_cu;
  if (e->u16len == s->len) { /* proven all ASCII: identity needs no index */
    free(e->points);
    e->points = NULL;
    e->npoints = 0;
    e->cap = 0;
    e->points_complete = false;
  } else {
    scr_sidx_rebuild_points(s, e);
  }
}

/* Index complete 4 KiB spans until the requested unit lies inside the
 * indexed prefix. It deliberately completes that interval: a lookup just
 * before an anchor and the next distant lookup both reuse the same work. */
static void scr_sidx_extend_to_u16(const ScrStr *s, ScrSidx *e, size_t u16) {
  if (u16 <= e->indexed_cu) return;
  while (e->indexed_cb < s->len) {
    size_t start_cu = e->indexed_cu;
    scr_sidx_extend_one(s, e);
    if (u16 <= e->indexed_cu || e->indexed_cu == start_cu) break;
  }
  scr_sidx_finish(s, e);
}

/* A large, not-yet-complete string can have a long proven-ASCII prefix
 * before its first non-ASCII byte. That prefix is an exact identity map, but
 * merely advancing indexed_{cu,cb} through it leaves alternating on-demand
 * lookups with only the hot cursor and therefore linear backtracks. Once an
 * indexed conversion reaches such a prefix, retain its arithmetic stride
 * anchors too. A later full scan still drops them if the whole string proves
 * ASCII, so the all-ASCII steady state remains the allocation-free identity
 * fast path. */
static void scr_sidx_materialize_identity_prefix(const ScrStr *s, ScrSidx *e) {
  if (e->npoints == 0 && e->indexed_cb != 0 &&
      e->indexed_cb == e->indexed_cu) {
    (void)scr_sidx_prepare_points(s, e);
  }
}

/* Cached UTF-16 length. Large strings extend from their exact previously
 * indexed prefix, retaining sparse start/end anchors; short strings keep the
 * historical single word-wise scan. `u16len == byte len` proves ASCII and
 * restores identity mapping with zero retained checkpoint memory. */
static size_t scr_sidx_len(const ScrStr *s, ScrSidx *e) {
  if (e->u16len != SCR_U16_UNKNOWN) return e->u16len;
  while (e->indexed_cb < s->len) scr_sidx_extend_one(s, e);
  scr_sidx_finish(s, e);
  return e->u16len;
}

/* Step the cursor back one char (cb must be > 0 and on a boundary). */
static void scr_sidx_back(const ScrStr *s, size_t *cu, size_t *cb) {
  SCR_SIDX_STEP();
  size_t p = *cb - 1;
  while (p > 0 && ((unsigned char)s->data[p] & 0xC0) == 0x80) p--;
  *cu -= scr_utf8_seq_len((unsigned char)s->data[p]) == 4 ? 2 : 1;
  *cb = p;
}

static size_t scr_sidx_abs_diff(size_t a, size_t b) {
  return a < b ? b - a : a - b;
}

/* Pick the nearest known UTF-16 anchor. The sparse list is ordered both by
 * unit and byte, so the predecessor/successor binary-search candidates are
 * sufficient; the hot cursor retains sequential-access locality. */
static ScrSidxPoint scr_sidx_near_u16(const ScrStr *s, const ScrSidx *e,
                                      size_t u16) {
  ScrSidxPoint best = {0, 0};
  size_t best_dist = u16;
  if (e->npoints != 0) {
    size_t lo = 0, hi = e->npoints;
    while (lo < hi) {
      size_t m = lo + (hi - lo) / 2;
      if (e->points[m].cu < u16) lo = m + 1;
      else hi = m;
    }
    if (lo < e->npoints &&
        scr_sidx_abs_diff(e->points[lo].cu, u16) < best_dist) {
      best = e->points[lo];
      best_dist = scr_sidx_abs_diff(best.cu, u16);
    }
    if (lo != 0 &&
        scr_sidx_abs_diff(e->points[lo - 1].cu, u16) < best_dist) {
      best = e->points[lo - 1];
      best_dist = scr_sidx_abs_diff(best.cu, u16);
    }
  }
  if (e->cb <= s->len && scr_sidx_abs_diff(e->cu, u16) < best_dist) {
    best = (ScrSidxPoint){e->cu, e->cb};
    best_dist = scr_sidx_abs_diff(best.cu, u16);
  }
  if (e->u16len != SCR_U16_UNKNOWN &&
      scr_sidx_abs_diff(e->u16len, u16) < best_dist) {
    best = (ScrSidxPoint){e->u16len, s->len};
  }
  return best;
}

static ScrSidxPoint scr_sidx_near_byte(const ScrStr *s, const ScrSidx *e,
                                       size_t byte_off) {
  ScrSidxPoint best = {0, 0};
  size_t best_dist = byte_off;
  if (e->npoints != 0) {
    size_t lo = 0, hi = e->npoints;
    while (lo < hi) {
      size_t m = lo + (hi - lo) / 2;
      if (e->points[m].cb < byte_off) lo = m + 1;
      else hi = m;
    }
    if (lo < e->npoints &&
        scr_sidx_abs_diff(e->points[lo].cb, byte_off) < best_dist) {
      best = e->points[lo];
      best_dist = scr_sidx_abs_diff(best.cb, byte_off);
    }
    if (lo != 0 &&
        scr_sidx_abs_diff(e->points[lo - 1].cb, byte_off) < best_dist) {
      best = e->points[lo - 1];
      best_dist = scr_sidx_abs_diff(best.cb, byte_off);
    }
  }
  if (e->cb <= s->len && scr_sidx_abs_diff(e->cb, byte_off) < best_dist) {
    best = (ScrSidxPoint){e->cu, e->cb};
    best_dist = scr_sidx_abs_diff(best.cb, byte_off);
  }
  if (e->u16len != SCR_U16_UNKNOWN &&
      scr_sidx_abs_diff(s->len, byte_off) < best_dist) {
    best = (ScrSidxPoint){e->u16len, s->len};
  }
  return best;
}

/* Convert a UTF-16 index to a byte offset from the closest sparse anchor or
 * hot cursor. If u16 addresses the second (low-surrogate) unit of
 * an astral char, *mid is set and the returned offset is the START of that
 * 4-byte sequence. u16 at or past the end returns s->len with *mid false.
 * Same contract as a from-scratch scan. */
static size_t scr_u16_to_byte_c(const ScrStr *s, ScrSidx *e, size_t u16,
                                 bool *mid) {
  if (e->u16len == s->len) { /* all ASCII: identity mapping */
    *mid = false;
    return u16 < s->len ? u16 : s->len;
  }
  scr_sidx_extend_to_u16(s, e, u16);
  /* Extending a far-end lookup can just have proved identity. Do not
   * materialize an index that the identity fast path will never consult. */
  if (e->u16len == s->len) {
    *mid = false;
    return u16 < s->len ? u16 : s->len;
  }
  scr_sidx_materialize_identity_prefix(s, e);
  ScrSidxPoint near = scr_sidx_near_u16(s, e, u16);
  size_t cu = near.cu, cb = near.cb;
  while (cu > u16) scr_sidx_back(s, &cu, &cb);
  bool m = false;
  while (cu < u16 && cb < s->len) {
    SCR_SIDX_STEP();
    size_t seq = scr_utf8_seq_len((unsigned char)s->data[cb]);
    size_t w = seq == 4 ? 2 : 1;
    if (cu + w > u16) { /* u16 lands between the halves of an astral char */
      m = true;
      break;
    }
    cu += w;
    cb += seq;
  }
  e->cu = cu;
  e->cb = cb;
  *mid = m;
  return cb;
}

/* Convert a byte offset (must be a char boundary) to a UTF-16 index from
 * the closest sparse anchor or hot cursor. */
static size_t scr_byte_to_u16_c(const ScrStr *s, ScrSidx *e,
                                 size_t byte_off) {
  if (e->u16len == s->len) return byte_off; /* all ASCII */
  /* A byte search result may be far beyond the existing prefix. Build the
   * same sparse intervals first, then choose the closest boundary anchor. */
  if (byte_off > e->indexed_cb) {
    while (e->indexed_cb < byte_off) scr_sidx_extend_one(s, e);
    scr_sidx_finish(s, e);
  }
  /* As above, a completed all-ASCII scan is its own index. In particular,
   * do not rebuild points that scr_sidx_finish() deliberately discarded. */
  if (e->u16len == s->len) return byte_off;
  scr_sidx_materialize_identity_prefix(s, e);
  ScrSidxPoint near = scr_sidx_near_byte(s, e, byte_off);
  size_t cu = near.cu, cb = near.cb;
  while (cb > byte_off) scr_sidx_back(s, &cu, &cb);
  while (cb < byte_off) {
    SCR_SIDX_STEP();
    size_t seq = scr_utf8_seq_len((unsigned char)s->data[cb]);
    cu += seq == 4 ? 2 : 1;
    cb += seq;
  }
  e->cu = cu;
  e->cb = cb;
  return cu;
}

/* ECMA-262 ToIntegerOrInfinity for a double already known to be a Number:
 * NaN → +0, otherwise truncate toward zero, ±Infinity preserved. */
static double scr_to_integer_or_infinity(double x) {
  if (isnan(x)) return 0.0;
  return trunc(x);
}

/* Naive byte substring search (needle and hay are both well-formed UTF-8,
 * so any byte-level match starts on a char boundary — UTF-8 is
 * self-synchronizing). Empty needle matches at hay. */
static const char *scr_byte_find(const char *hay, size_t hay_len,
                                  const char *nee, size_t nee_len) {
  if (nee_len == 0) return hay;
  if (nee_len > hay_len) return NULL;
  for (size_t i = 0; i + nee_len <= hay_len; i++) {
    if (hay[i] == nee[0] && memcmp(hay + i, nee, nee_len) == 0)
      return hay + i;
  }
  return NULL;
}

  size_t len16 = scr_sidx_len(s, e);
  size_t start16 = isnan(position) || position >= (double)len16 ? len16
                   : position <= 0 ? 0 : (size_t)trunc(position);
  if (needle->len == 0) return (double)start16;
