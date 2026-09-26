#include "scr_runtime.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>

static int fail(const char *message) {
  fprintf(stderr, "%s\n", message);
  return 1;
}

static int64_t elapsed_ns(const struct timespec *before,
                          const struct timespec *after) {
  return (int64_t)(after->tv_sec - before->tv_sec) * INT64_C(1000000000) +
         (after->tv_nsec - before->tv_nsec);
}

int main(void) {
  struct timespec realtime;
  if (clock_gettime(CLOCK_REALTIME, &realtime) != 0)
    return fail("CLOCK_REALTIME failed");
  if (realtime.tv_sec < 1577836800)
    return fail("CLOCK_REALTIME predates 2020");

  struct timespec before;
  struct timespec after;
  if (clock_gettime(CLOCK_MONOTONIC, &before) != 0)
    return fail("CLOCK_MONOTONIC failed");
  struct timespec request = {0, 2000000};
  struct timespec remain = {-1, -1};
  if (nanosleep(&request, &remain) != 0) return fail("nanosleep failed");
  if (remain.tv_sec != 0 || remain.tv_nsec != 0)
    return fail("nanosleep left a remainder");
  if (clock_gettime(CLOCK_MONOTONIC, &after) != 0)
    return fail("second CLOCK_MONOTONIC failed");
  if (elapsed_ns(&before, &after) < 1000000)
    return fail("nanosleep returned early");

  errno = 0;
  if (clock_gettime((clockid_t)-1, &after) != -1 || errno != EINVAL)
    return fail("invalid clock was accepted");
  struct timespec invalid = {0, 1000000000};
  errno = 0;
  if (nanosleep(&invalid, NULL) != -1 || errno != EINVAL)
    return fail("invalid sleep was accepted");

  puts("win32 time shims ok");
  return 0;
}
