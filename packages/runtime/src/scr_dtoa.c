/* Exact ECMAScript number formatting beyond the decimal ToString/ToFixed
 * fast paths in scr_number.c and scr_lib.c. The pinned QuickJS dtoa core
 * supplies precision formatting without linking the embedded engine; radix
 * formatting follows Node's V8 implementation below. */
#include "scr_runtime.h"

#include <math.h>
#include <stdlib.h>

#include "../vendor/quickjs-ng/dtoa.c"

static ScrStr *scr_dtoa_string(double value, int radix, int digits, int flags) {
  int capacity = js_dtoa_max_len(value, radix, digits, flags);
  char *buffer = (char *)malloc((size_t)capacity + 1);
  if (!buffer) abort();
  JSDTOATempMem temporary;
  int length = js_dtoa(buffer, value, radix, digits, flags, &temporary);
  ScrStr *result = scr_str_new(buffer, (size_t)length);
  free(buffer);
  return result;
}

/* V8's non-decimal Number::toString implementation makes an observable
 * implementation choice that differs from QuickJS for some radices. Keep the
 * same binary64 digit loop so C/LLVM binaries remain byte-identical to Node. */
static ScrStr *scr_v8_radix_string(double value, int radix) {
  static const char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  enum { capacity = 2200 };
  char buffer[capacity];
  size_t midpoint = capacity / 2;
  size_t integer_cursor = midpoint;
  size_t fraction_cursor = midpoint;
  bool negative = value < 0;
  double magnitude = negative ? -value : value;
  double integer = floor(magnitude);
  double fraction = magnitude - integer;
  uint64_t next_bits;
  memcpy(&next_bits, &magnitude, sizeof next_bits);
  next_bits++;
  double next;
  memcpy(&next, &next_bits, sizeof next);
  double delta = 0.5 * (next - magnitude);
  if (delta <= 0) {
    uint64_t minimum_bits = 1;
    memcpy(&delta, &minimum_bits, sizeof delta);
  }

  if (fraction >= delta) {
    buffer[fraction_cursor++] = '.';
    do {
      fraction *= radix;
      delta *= radix;
      int digit = (int)fraction;
      buffer[fraction_cursor++] = digits[digit];
      fraction -= digit;
      if ((fraction > 0.5 || (fraction == 0.5 && (digit & 1))) &&
          fraction + delta > 1) {
        for (;;) {
          fraction_cursor--;
          if (fraction_cursor == midpoint) {
            integer += 1;
            break;
          }
          char byte = buffer[fraction_cursor];
          digit = byte > '9' ? byte - 'a' + 10 : byte - '0';
          if (digit + 1 < radix) {
            buffer[fraction_cursor++] = digits[digit + 1];
            break;
          }
        }
        break;
      }
    } while (fraction >= delta);
  }

  /* base::Double::Exponent() is relative to its 53-bit significand. */
  while (integer / radix >= 9007199254740992.0) {
    integer /= radix;
    buffer[--integer_cursor] = '0';
  }
  do {
    double remainder = fmod(integer, radix);
    buffer[--integer_cursor] = digits[(int)remainder];
    integer = (integer - remainder) / radix;
  } while (integer > 0);
  if (negative) buffer[--integer_cursor] = '-';
  return scr_str_new(buffer + integer_cursor,
                     fraction_cursor - integer_cursor);
}

ScrStr *scr_num_to_precision(double value, double precision) {
  double integer_precision = isnan(precision) ? 0 : trunc(precision);
  if (!isfinite(value)) return scr_f64_to_scrstr(value);
  if (!(integer_precision >= 1 && integer_precision <= 100)) {
    static const char message[] =
        "toPrecision() argument must be between 1 and 100";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return NULL;
  }
  return scr_dtoa_string(value, 10, (int)integer_precision,
                         JS_DTOA_FORMAT_FIXED);
}

ScrStr *scr_num_to_radix_string(double value, double radix) {
  double integer_radix = isnan(radix) ? 0 : trunc(radix);
  if (!(integer_radix >= 2 && integer_radix <= 36)) {
    static const char message[] =
        "toString() radix argument must be between 2 and 36";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return NULL;
  }
  int base = (int)integer_radix;
  if (base == 10) return scr_f64_to_scrstr(value);
  if (!isfinite(value) || value == 0) return scr_f64_to_scrstr(value);
  return scr_v8_radix_string(value, base);
}
