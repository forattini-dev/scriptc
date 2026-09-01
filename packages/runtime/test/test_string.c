/* Oracle test for the string methods.
 * Reads case lines ("<op>\t<input-hex>\t<args>\t<expected-hex>\n", "-" for
 * an empty hex field — see gen-string-cases.mjs) from the file given as
 * argv[1] (or stdin), runs each operation, and asserts byte equality.
 * Numeric/boolean results are compared through scr_f64_to_str /
 * "true"/"false", so the expected column is always UTF-8 bytes.
 *
 * Also contains hand-written assertions for the documented divergence
 * (charAt / slice on half an astral pair -> U+FFFD instead of a lone
 * surrogate), even though the oracle covers them too via Buffer.from's
 * identical replacement behavior.
 *
 * Special mode: --crash-repeat / --crash-repeat-inf call
 * scr_str_repeat with an invalid count and must abort() after printing
 * "scriptc: RangeError: Invalid count value" (checked by string.test.ts).
 *
 * Exit 0 = all pass; prints each mismatch (capped) and exits 1 otherwise.
 */
#include "../src/scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void); /* provided by scr_string.c */
#endif

#define MAX_FIELD 8192

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Decode "<hex>" or "-" (empty) into out; returns length or (size_t)-1. */
static size_t hex_decode(const char *hex, char *out) {
  if (strcmp(hex, "-") == 0) return 0;
  size_t n = strlen(hex);
  if (n % 2 != 0 || n / 2 > MAX_FIELD) return (size_t)-1;
  for (size_t i = 0; i < n; i += 2) {
    int hi = hex_val(hex[i]), lo = hex_val(hex[i + 1]);
    if (hi < 0 || lo < 0) return (size_t)-1;
    out[i / 2] = (char)((hi << 4) | lo);
  }
  return n / 2;
}

static void hex_print(FILE *f, const char *bytes, size_t len) {
  if (len == 0) {
    fputc('-', f);
    return;
  }
  for (size_t i = 0; i < len; i++)
    fprintf(f, "%02x", (unsigned char)bytes[i]);
}

static long total = 0, failed = 0;

static void check(const char *op, const char *args, ScrStr *input,
                  const char *got, size_t got_len, const char *expected,
                  size_t expected_len) {
  total++;
  if (got_len == expected_len && memcmp(got, expected, got_len) == 0) return;
  failed++;
  if (failed <= 20) {
    fprintf(stderr, "MISMATCH %s(", op);
    hex_print(stderr, input->data, input->len);
    fprintf(stderr, " ; %s) expected=", args);
    hex_print(stderr, expected, expected_len);
    fprintf(stderr, " got=");
    hex_print(stderr, got, got_len);
    fputc('\n', stderr);
  }
}

static void check_f64(const char *op, const char *args, ScrStr *input,
                      double got, const char *expected, size_t expected_len) {
  char buf[32];
  size_t len = scr_f64_to_str(got, buf);
  check(op, args, input, buf, len, expected, expected_len);
}

static void check_bool(const char *op, const char *args, ScrStr *input,
                       bool got, const char *expected, size_t expected_len) {
  const char *s = got ? "true" : "false";
  check(op, args, input, s, strlen(s), expected, expected_len);
}

/* Consumes (releases) the +1 result. */
static void check_str(const char *op, const char *args, ScrStr *input,
                      ScrStr *got, const char *expected, size_t expected_len) {
  if (got->data[got->len] != '\0') {
    failed++;
    fprintf(stderr, "MISSING NUL TERMINATOR after %s result\n", op);
  }
  check(op, args, input, got->data, got->len, expected, expected_len);
  scr_str_release(got);
}

/* Hand-written assertions for the documented lone-surrogate divergence:
 * boundaries inside the astral pair of "a\u{1F600}b" produce U+FFFD where
 * JS would produce "\uD83D" / "\uDE00". */
static void divergence_asserts(void) {
  static const char FFFD[] = "\xEF\xBF\xBD";
  ScrStr *s = scr_str_new("a\xF0\x9F\x98\x80" "b", 6); /* a 😀 b */

  ScrStr *hi = scr_str_char_at(s, 1); /* JS: "\uD83D" */
  check("charAt-divergence", "1", s, hi->data, hi->len, FFFD, 3);
  scr_str_release(hi);

  ScrStr *lo = scr_str_char_at(s, 2); /* JS: "\uDE00" */
  check("charAt-divergence", "2", s, lo->data, lo->len, FFFD, 3);
  scr_str_release(lo);

  ScrStr *head = scr_str_slice(s, 0, 2); /* JS: "a\uD83D" */
  check("slice-divergence", "0,2", s, head->data, head->len,
        "a\xEF\xBF\xBD", 4);
  scr_str_release(head);

  ScrStr *tail = scr_str_slice(s, 2, 4); /* JS: "\uDE00b" */
  check("slice-divergence", "2,4", s, tail->data, tail->len,
        "\xEF\xBF\xBD" "b", 4);
  scr_str_release(tail);

  ScrStr *mid = scr_str_slice(s, 2, 3); /* JS: "\uDE00" */
  check("slice-divergence", "2,3", s, mid->data, mid->len, FFFD, 3);
  scr_str_release(mid);

  /* both boundaries split different pairs: "😀😀".slice(1,3) */
  ScrStr *two = scr_str_new("\xF0\x9F\x98\x80\xF0\x9F\x98\x80", 8);
  ScrStr *both = scr_str_slice(two, 1, 3); /* JS: "\uDE00\uD83D" */
  check("slice-divergence", "1,3", two, both->data, both->len,
        "\xEF\xBF\xBD\xEF\xBF\xBD", 6);
  scr_str_release(both);

  /* numeric results do NOT diverge: exact surrogate values */
  check_f64("charCodeAt-surrogate", "1", s, scr_str_char_code_at(s, 1),
            "55357", 5); /* 0xD83D */
  check_f64("charCodeAt-surrogate", "2", s, scr_str_char_code_at(s, 2),
            "56832", 5); /* 0xDE00 */

  /* String-pattern replacement uses GetSubstitution with no captures. */
  ScrStr *abc = scr_str_new("abc", 3);
  ScrStr *b = scr_str_new("b", 1);
  static const char template_bytes[] = "[$&]-$`-$'-$$-$1-$<x>";
  ScrStr *template = scr_str_new(template_bytes, sizeof(template_bytes) - 1);
  check_str("replace-substitution", "b", abc,
            scr_str_replace(abc, b, template),
            "a[b]-a-c-$-$1-$<x>c", 19);

  ScrStr *aba = scr_str_new("aba", 3);
  ScrStr *a = scr_str_new("a", 1);
  static const char all_template_bytes[] = "<$`|$&|$'>";
  ScrStr *all_template =
      scr_str_new(all_template_bytes, sizeof(all_template_bytes) - 1);
  check_str("replaceAll-substitution", "a", aba,
            scr_str_replace_all(aba, a, all_template),
            "<|a|ba>b<ab|a|>", 15);

  ScrStr *empty = scr_str_new("", 0);
  ScrStr *dash = scr_str_new("-", 1);
  static const char replaced_two[] =
      "-\xEF\xBF\xBD-\xEF\xBF\xBD-\xEF\xBF\xBD-\xEF\xBF\xBD-";
  check_str("replaceAll-empty-astral", "-", two,
            scr_str_replace_all(two, empty, dash),
            replaced_two, sizeof(replaced_two) - 1);
  check_str("replaceAll-empty-identity", "", s,
            scr_str_replace_all(s, empty, empty), s->data, s->len);
  check_str("at-negative", "-1", s, scr_str_at(s, -1), "b", 1);

  scr_str_release(dash);
  scr_str_release(empty);
  scr_str_release(all_template);
  scr_str_release(a);
  scr_str_release(aba);
  scr_str_release(template);
  scr_str_release(b);
  scr_str_release(abc);

  scr_str_release(two);
  scr_str_release(s);
}

int main(int argc, char **argv) {
  if (argc > 1 && strncmp(argv[1], "--crash-repeat", 14) == 0) {
    ScrStr *s = scr_str_new("ab", 2);
    double count = strcmp(argv[1], "--crash-repeat-inf") == 0
                       ? (double)INFINITY
                       : -1.0;
    scr_str_repeat(s, count); /* must print RangeError and abort() */
    fputs("UNREACHABLE: scr_str_repeat returned\n", stderr);
    return 3;
  }

  FILE *in = stdin;
  if (argc > 1) {
    in = fopen(argv[1], "r");
    if (!in) {
      perror(argv[1]);
      return 2;
    }
  }

  static char linebuf[4 * MAX_FIELD];
  static char in_bytes[MAX_FIELD], needle_bytes[MAX_FIELD],
      expected_bytes[MAX_FIELD];

  while (fgets(linebuf, sizeof linebuf, in)) {
    linebuf[strcspn(linebuf, "\n")] = '\0';
    if (linebuf[0] == '\0') continue;

    /* split: op \t input-hex \t args \t expected-hex */
    char *op = linebuf;
    char *input_hex = strchr(op, '\t');
    if (!input_hex) goto badline;
    *input_hex++ = '\0';
    char *args = strchr(input_hex, '\t');
    if (!args) goto badline;
    *args++ = '\0';
    char *expected_hex = strchr(args, '\t');
    if (!expected_hex) goto badline;
    *expected_hex++ = '\0';

    size_t in_len = hex_decode(input_hex, in_bytes);
    size_t exp_len = hex_decode(expected_hex, expected_bytes);
    if (in_len == (size_t)-1 || exp_len == (size_t)-1) goto badline;

    ScrStr *input = scr_str_new(in_bytes, in_len);

    if (strcmp(op, "len") == 0) {
      check_f64(op, args, input, scr_str_utf16_len(input), expected_bytes,
                exp_len);
    } else if (strcmp(op, "charCodeAt") == 0) {
      check_f64(op, args, input, scr_str_char_code_at(input, strtod(args, NULL)),
                expected_bytes, exp_len);
    } else if (strcmp(op, "charAt") == 0) {
      check_str(op, args, input, scr_str_char_at(input, strtod(args, NULL)),
                expected_bytes, exp_len);
    } else if (strcmp(op, "slice") == 0) {
      char *comma = strchr(args, ',');
      if (!comma) goto badline_release;
      double a = strtod(args, NULL), b = strtod(comma + 1, NULL);
      check_str(op, args, input, scr_str_slice(input, a, b), expected_bytes,
                exp_len);
    } else if (strcmp(op, "repeat") == 0) {
      check_str(op, args, input, scr_str_repeat(input, strtod(args, NULL)),
                expected_bytes, exp_len);
    } else if (strcmp(op, "trim") == 0) {
      check_str(op, args, input, scr_str_trim(input), expected_bytes,
                exp_len);
    } else if (strcmp(op, "trimStart") == 0) {
      check_str(op, args, input, scr_str_trim_start(input), expected_bytes,
                exp_len);
    } else if (strcmp(op, "trimEnd") == 0) {
      check_str(op, args, input, scr_str_trim_end(input), expected_bytes,
                exp_len);
    } else if (strcmp(op, "parseInt") == 0) {
      check_f64(op, args, input, scr_parse_int(input, strtod(args, NULL)),
                expected_bytes, exp_len);
    } else if (strcmp(op, "split") == 0) {
      /* args = separator hex; expected = "<count>:<pieces joined by 0x01>" */
      size_t sep_len = hex_decode(args, needle_bytes);
      if (sep_len == (size_t)-1) goto badline_release;
      ScrStr *sep = scr_str_new(needle_bytes, sep_len);
      ScrArr *pieces = scr_str_split(input, sep);
      size_t count = (size_t)scr_arr_len(pieces);
      size_t cap = 32;
      for (size_t i = 0; i < count; i++) {
        ScrStr *p = (ScrStr *)scr_arr_get_ref(pieces, (double)i);
        cap += p->len + 1;
        scr_str_release(p);
      }
      char *joined = malloc(cap);
      size_t o = (size_t)snprintf(joined, 32, "%zu:", count);
      for (size_t i = 0; i < count; i++) {
        if (i > 0) joined[o++] = '\x01';
        ScrStr *p = (ScrStr *)scr_arr_get_ref(pieces, (double)i);
        memcpy(joined + o, p->data, p->len);
        o += p->len;
        scr_str_release(p);
      }
      check(op, args, input, joined, o, expected_bytes, exp_len);
      free(joined);
      scr_arr_release(pieces);
      scr_str_release(sep);
    } else if (strcmp(op, "padStart") == 0 || strcmp(op, "padEnd") == 0) {
      /* args = "<target>,<fill hex>" */
      char *comma = strchr(args, ',');
      if (!comma) goto badline_release;
      *comma = '\0';
      double target = strtod(args, NULL);
      size_t fill_len = hex_decode(comma + 1, needle_bytes);
      *comma = ','; /* restore for mismatch printing */
      if (fill_len == (size_t)-1) goto badline_release;
      ScrStr *fill = scr_str_new(needle_bytes, fill_len);
      ScrStr *got = strcmp(op, "padStart") == 0
                        ? scr_str_pad_start(input, target, fill)
                        : scr_str_pad_end(input, target, fill);
      check_str(op, args, input, got, expected_bytes, exp_len);
      scr_str_release(fill);
    } else if (strcmp(op, "indexOf") == 0) {
      char *comma = strchr(args, ',');
      if (!comma) goto badline_release;
      *comma = '\0';
      size_t nee_len = hex_decode(args, needle_bytes);
      if (nee_len == (size_t)-1) goto badline_release;
      double from = strtod(comma + 1, NULL);
      *comma = ','; /* restore for mismatch printing */
      ScrStr *needle = scr_str_new(needle_bytes, nee_len);
      check_f64(op, args, input, scr_str_index_of(input, needle, from),
                expected_bytes, exp_len);
      scr_str_release(needle);
    } else if (strcmp(op, "includes") == 0 || strcmp(op, "startsWith") == 0 ||
               strcmp(op, "endsWith") == 0) {
      size_t nee_len = hex_decode(args, needle_bytes);
      if (nee_len == (size_t)-1) goto badline_release;
      ScrStr *needle = scr_str_new(needle_bytes, nee_len);
      /* The boundary predicates take a position (added with the dynamic
       * startsWith/endsWith work); these cases pin the no-position
       * spelling, so pass each one's JS default. */
      bool got = op[0] == 'i'   ? scr_str_includes(input, needle)
                 : op[0] == 's' ? scr_str_starts_with(input, needle, 0)
                                : scr_str_ends_with(input, needle, INFINITY);
      check_bool(op, args, input, got, expected_bytes, exp_len);
      scr_str_release(needle);
    } else {
      goto badline_release;
    }
    scr_str_release(input);
    continue;

  badline_release:
    scr_str_release(input);
  badline:
    failed++;
    fprintf(stderr, "BAD LINE: %s\n", op);
  }
  if (in != stdin) fclose(in);

  divergence_asserts();

#ifdef SCR_RC_AUDIT
  if (scr_str_live_count() != 0) {
    fprintf(stderr, "RC AUDIT: %ld strings leaked\n", scr_str_live_count());
    failed++;
  }
#endif

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed ? 1 : 0;
}
